/** 模拟部长协议回调；真控制文件与卡状态流转，不调用模型。 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { MinisterHost } from "../../src/pao/host/host.ts";
import paoExtension from "../../src/pao/index.ts";
import { WorkerRunner } from "../../src/pao/worker/runner.ts";
import * as auto from "../../src/pao/workflow/auto.ts";
import * as controlModule from "../../src/pao/workflow/control.ts";
import {
	bindMinister,
	controlReport,
	decideNode,
	endDecomposition,
	pauseControl,
	readControl,
	startControl,
} from "../../src/pao/workflow/control.ts";
import { WorkflowHostBridge } from "../../src/pao/workflow/host-bridge.ts";
import { WORKFLOW_MINISTER_ENV, type WorkflowMinisterContext } from "../../src/pao/workflow/minister.ts";
import { parseRecipe } from "../../src/pao/workflow/recipe.ts";

const defaultNodes = `  - 名字: 规划
    部门: 规划
    目标: 检查无需修改
    验收: 明确理由
  - 名字: 审阅
    部门: 审阅
    目标: 审阅理由
    验收: 明确判定
    审核: true
    部门标准: 有证据
    depends_on: [规划]
`;

function fixture(nodes = defaultNodes, metadata = "") {
	const root = mkdtempSync(join(tmpdir(), "pao-bridge-fixture-"));
	// 档位配置 fixture：主力(别名 primary)/快 两档＋规划部门默认快——部长 --model 须解析成 provider/model
	const paoHome = join(root, "pao-home");
	mkdirSync(join(paoHome, "pao配置"), { recursive: true });
	writeFileSync(
		join(paoHome, "pao配置", "档位.json"),
		JSON.stringify({
			provider: "pao",
			档位: [
				{ 名: "主力", provider: "prov", model: "main-model", thinkingLevel: "medium" },
				{ 名: "快", provider: "prov", model: "fast-model", thinkingLevel: "low" },
			],
			部门默认: { 规划: "快" },
		}),
		"utf8",
	);
	const recipe = parseRecipe(`---\n版本: 2\n名字: 桥测试\n${metadata}节点:\n${nodes}---`, join(root, "桥测试.md"));
	const options = { cardsDir: join(root, "卡"), ownerSessionId: "owner", 运行器: new WorkerRunner(), paoHome };
	const host = new MinisterHost();
	const bridge = new WorkflowHostBridge(host);
	let assigned: WorkflowMinisterContext;
	const contexts = new Map<string, WorkflowMinisterContext>();
	const spawn参数: string[][] = [];
	vi.spyOn(host, "spawn").mockImplementation(async (input) => {
		spawn参数.push([...(input.参数 ?? [])]);
		assigned = JSON.parse(input.环境变量![WORKFLOW_MINISTER_ENV]) as WorkflowMinisterContext;
		contexts.set(`session-${assigned.节点}`, assigned);
		return {
			ok: true,
			已有热会话: false,
			handle: {
				pid: 123,
				部门: input.部门,
				项目根: input.项目根,
				脉络: input.脉络,
				会话标识: `session-${assigned.节点}`,
				配方指纹: null,
				启动时间: "",
				最近事件时间: "",
				累计: { 轮次: 0, 工具调用: 0, 成本: 0 },
				轮次提示已发: false,
				调用提示已发: false,
				上次监督轮次: 0,
				待办标记: [],
			},
		};
	});
	return { recipe, options, host, bridge, assigned: () => assigned, contexts, spawn参数 };
}

const parallelMetadata =
	"parallelGroups:\n  - id: reviews\n    maxConcurrency: 2\n    failurePolicy: fail_fast\n    cancelPolicy: drain_started\n";
function parallelNodes(count = 3) {
	return `${Array.from(
		{ length: count },
		(_, index) => `  - 名字: 检查${index}
    部门: 部门${index}
    目标: 检查证据
    验收: 明确理由
    只读: true
    parallelGroupId: reviews
    branchId: branch${index}
`,
	).join("")}  - 名字: 汇聚
    部门: 汇总
    目标: 整理证据
    验收: 明确理由
    depends_on: [${Array.from({ length: count }, (_, index) => `检查${index}`).join(", ")}]
`;
}

describe("显式只读并行组（模拟部长，真实控制文件）", () => {
	it("不同部门最多两路；两路都启动才释放，汇聚等全部完成", async () => {
		const s = fixture(parallelNodes(), parallelMetadata);
		await startControl(s.recipe, {}, s.options);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let active = 0;
		let peak = 0;
		const completed: string[] = [];
		vi.spyOn(s.host, "executeTask").mockImplementation(async (input) => {
			const a = s.contexts.get(input.会话标识)!;
			active++;
			peak = Math.max(peak, active);
			if (a.节点 === "检查0" || a.节点 === "检查1") {
				if (active === 2) release();
				await gate;
			}
			if (a.节点 === "汇聚") expect(completed).toEqual(expect.arrayContaining(["检查0", "检查1", "检查2"]));
			await endDecomposition(
				s.recipe,
				s.options,
				{ 实例: a.实例, 节点: a.节点, 轮次: a.轮次, 部长会话: input.会话标识 },
				"模拟只读证据",
			);
			completed.push(a.节点);
			active--;
			return "模拟回答";
		});
		expect((await s.bridge.drive(s.recipe, s.options)).report.status).toBe("completed");
		expect(peak).toBe(2);
	});

	it.each(["same-dept", "write-node", "undeclared", "single-slot", "partial-policy"])(
		"%s 保持串行",
		async (variant) => {
			let nodes = parallelNodes(2);
			let metadata = parallelMetadata;
			if (variant === "same-dept") nodes = nodes.replace("部门: 部门1", "部门: 部门0");
			if (variant === "write-node") nodes = nodes.replace("只读: true", "只读: false");
			if (variant === "undeclared") {
				nodes = nodes.replaceAll("    parallelGroupId: reviews\n", "").replace(/ {4}branchId: branch\d\n/g, "");
				metadata = "";
			}
			if (variant === "single-slot") metadata = metadata.replace("maxConcurrency: 2", "maxConcurrency: 1");
			if (variant === "partial-policy") metadata = metadata.replace("fail_fast", "allow_partial");
			const s = fixture(nodes, metadata);
			await startControl(s.recipe, {}, s.options);
			let active = 0;
			let peak = 0;
			vi.spyOn(s.host, "executeTask").mockImplementation(async (input) => {
				const a = s.contexts.get(input.会话标识)!;
				peak = Math.max(peak, ++active);
				await endDecomposition(
					s.recipe,
					s.options,
					{ 实例: a.实例, 节点: a.节点, 轮次: a.轮次, 部长会话: input.会话标识 },
					"模拟无需编码",
				);
				active--;
				return "模拟回答";
			});
			expect((await s.bridge.drive(s.recipe, s.options)).report.status).toBe("completed");
			expect(peak).toBe(1);
		},
	);

	it("旁支提交不能掩盖本分支漏结束信号，汇聚不启动", async () => {
		const s = fixture(parallelNodes(2), parallelMetadata);
		await startControl(s.recipe, {}, s.options);
		const started: string[] = [];
		vi.spyOn(s.host, "executeTask").mockImplementation(async (input) => {
			const a = s.contexts.get(input.会话标识)!;
			started.push(a.节点);
			if (a.节点 !== "检查0")
				await endDecomposition(
					s.recipe,
					s.options,
					{ 实例: a.实例, 节点: a.节点, 轮次: a.轮次, 部长会话: input.会话标识 },
					"模拟完成",
				);
			return "模拟回答";
		});
		const result = await s.bridge.drive(s.recipe, s.options);
		expect(result.stopReason).toContain("未提交");
		expect(started.sort()).toEqual(["检查0", "检查1"]);
		expect(readControl(s.recipe, s.options).节点.find((node) => node.名字 === "检查0")?.拆解结束).toBe(false);
	});

	it("分支异常先结算已启动分支，再暂停并拒绝启动汇聚", async () => {
		const s = fixture(parallelNodes(2), parallelMetadata);
		await startControl(s.recipe, {}, s.options);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let drained = false;
		const started: string[] = [];
		vi.spyOn(s.host, "executeTask").mockImplementation(async (input) => {
			const a = s.contexts.get(input.会话标识)!;
			started.push(a.节点);
			if (a.节点 === "检查0") {
				await gate;
				throw new Error("模拟分支 RPC 失败");
			}
			release();
			await endDecomposition(
				s.recipe,
				s.options,
				{ 实例: a.实例, 节点: a.节点, 轮次: a.轮次, 部长会话: input.会话标识 },
				"模拟完成",
			);
			drained = true;
			return "模拟回答";
		});
		await expect(s.bridge.drive(s.recipe, s.options)).rejects.toThrow("模拟分支 RPC 失败");
		expect(drained).toBe(true);
		expect(started.sort()).toEqual(["检查0", "检查1"]);
		expect(readControl(s.recipe, s.options).暂停).toContain("模拟分支 RPC 失败");
	});

	it("取消传给全部已启动分支，结算后暂停，汇聚不启动", async () => {
		const s = fixture(parallelNodes(2), parallelMetadata);
		await startControl(s.recipe, {}, s.options);
		const controller = new AbortController();
		let started = 0;
		let active = 0;
		vi.spyOn(s.host, "executeTask").mockImplementation(async (input) => {
			expect(input.signal).toBe(controller.signal);
			active++;
			try {
				await new Promise<void>((_resolve, reject) => {
					input.signal!.addEventListener("abort", () => reject(input.signal!.reason), { once: true });
					if (++started === 2) controller.abort(new Error("模拟用户取消"));
				});
			} finally {
				active--;
			}
			return "模拟回答";
		});
		await expect(s.bridge.drive(s.recipe, { ...s.options, signal: controller.signal })).rejects.toThrow(
			"模拟用户取消",
		);
		expect(started).toBe(2);
		expect(active).toBe(0);
		expect(readControl(s.recipe, s.options).暂停).toContain("模拟用户取消");
	});

	it("只读分支完成仍等人工确认，不启动汇聚", async () => {
		const s = fixture(parallelNodes(2).replace("名字: 检查0", "名字: 检查0\n    人工确认: true"), parallelMetadata);
		await startControl(s.recipe, {}, s.options);
		const started: string[] = [];
		vi.spyOn(s.host, "executeTask").mockImplementation(async (input) => {
			const a = s.contexts.get(input.会话标识)!;
			started.push(a.节点);
			await endDecomposition(
				s.recipe,
				s.options,
				{ 实例: a.实例, 节点: a.节点, 轮次: a.轮次, 部长会话: input.会话标识 },
				"模拟只读完成",
			);
			return "模拟回答";
		});
		const result = await s.bridge.drive(s.recipe, s.options);
		expect(started.sort()).toEqual(["检查0", "检查1"]);
		expect(result.report.nodes.find((node) => node.name === "检查0")?.hold).toContain("人工确认");
		expect(readControl(s.recipe, s.options).节点.find((node) => node.名字 === "汇聚")?.部长会话).toBeUndefined();
	});
});
describe("宿主与流程桥（模拟回调）", () => {
	it("真实扩展接线白名单拦截 PowerShell、任意写工具和委派工具", () => {
		const handlers: ((event: { toolName: string }) => unknown)[] = [];
		const pi = {
			registerTool: () => {},
			registerCommand: () => {},
			registerVirtualModel: () => {},
			registerMessageRenderer: () => {},
			sendMessage: () => {},
			on: (name: string, handler: (event: { toolName: string }) => unknown) => {
				if (name === "tool_call") handlers.push(handler);
			},
		} as unknown as ExtensionAPI;
		vi.stubEnv("PAO_ROLE", "部长");
		vi.stubEnv(
			WORKFLOW_MINISTER_ENV,
			JSON.stringify({
				名字: "测试",
				实例: "instance",
				节点: "node",
				轮次: 1,
				owner: "owner",
				cardsDir: join(tmpdir(), "isolated-card-fixture"),
			}),
		);
		const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			paoExtension(pi, { resolvePaoHome: () => join(tmpdir(), "missing-pao-fixture") });
			for (const toolName of [
				"powershell",
				"bash",
				"write",
				"edit",
				"pao_dispatch_card",
				"pao_ingest_kb",
				"custom_writer",
			])
				expect(handlers.some((handler) => (handler({ toolName }) as { block?: boolean } | undefined)?.block)).toBe(
					true,
				);
			for (const toolName of ["read", "grep", "find", "ls", "pao_minister_submit_cards", "pao_submit_decision"])
				expect(handlers.some((handler) => (handler({ toolName }) as { block?: boolean } | undefined)?.block)).toBe(
					false,
				);
		} finally {
			warnings.mockRestore();
			vi.unstubAllEnvs();
		}
	});
	it("结束信号与独立审核判定分轮提交，全部真实控制正本完成才返回完成", async () => {
		const s = fixture();
		await startControl(s.recipe, {}, s.options);
		const phases: string[] = [];
		vi.spyOn(s.host, "executeTask").mockImplementation(async (input) => {
			const a = s.assigned();
			const node = readControl(s.recipe, s.options).节点.find((n) => n.名字 === a.节点)!;
			const id = { 实例: a.实例, 节点: a.节点, 轮次: a.轮次, 部长会话: input.会话标识 };
			phases.push(`${a.节点}:${node.拆解结束 ? "判定" : "拆解"}`);
			if (!node.拆解结束) await endDecomposition(s.recipe, s.options, id, "模拟只读检查无需编码");
			else
				await decideNode(s.recipe, s.options, id, {
					结果: "pass",
					理由: "检查完成，未验证运行",
					引用: ["报告.md:1"],
				});
			return "模拟回答";
		});
		const result = await s.bridge.drive(s.recipe, s.options);
		expect(result.report.status).toBe("completed");
		expect(phases).toEqual(["规划:拆解", "审阅:拆解", "审阅:判定"]);
	});
	it("没有结束信号不伪造推进，异常会暂停并保留控制正本", async () => {
		const s = fixture();
		await startControl(s.recipe, {}, s.options);
		const task = vi.spyOn(s.host, "executeTask").mockResolvedValue("没有调用工具");
		const waiting = await s.bridge.drive(s.recipe, s.options);
		expect(waiting.stopReason).toContain("未提交");
		expect(task).toHaveBeenCalledTimes(1);
		task.mockRejectedValueOnce(new Error("模拟 RPC 中断"));
		await expect(s.bridge.drive(s.recipe, s.options)).rejects.toThrow("模拟 RPC 中断");
		expect(readControl(s.recipe, s.options).暂停).toContain("模拟 RPC 中断");
	});
	it("部长模型经档位.json 解析成 provider/model；死绑定节点在停因与挂起文案中明示", async () => {
		const s = fixture();
		await startControl(s.recipe, {}, s.options);
		vi.spyOn(s.host, "executeTask").mockResolvedValue("没有调用工具");
		const waiting = await s.bridge.drive(s.recipe, s.options);
		expect(waiting.stopReason).toContain("未提交");
		const args = s.spawn参数.find((list) => list.includes("--model"));
		expect(args).toBeDefined();
		// 规划部门默认档=快 → 解析成 prov/fast-model，不是档位名
		expect(args![args!.indexOf("--model") + 1]).toBe("prov/fast-model");
		// 模拟 spawn 是假进程：host.list() 无热会话 → 绑定未拆解节点判死并在停因带出
		expect(waiting.stopReason).toContain("1 个节点的绑定部长会话已无热进程(节点:规划)");
		expect(waiting.report.nodes.find((node) => node.name === "规划")?.hold).toContain("部长会话已断开");
	});
	it("def.模型 显式给定时原样传 --model（不需档位配置）", async () => {
		// 在默认节点模板上给规划节点加显式模型（provider/model 格式，非档位名）
		const s = fixture(defaultNodes.replace("    验收: 明确理由", "    验收: 明确理由\n    模型: explicit/model-x"));
		const options = { ...s.options, paoHome: undefined };
		await startControl(s.recipe, {}, options);
		vi.spyOn(s.host, "executeTask").mockResolvedValue("没有调用工具");
		await s.bridge.drive(s.recipe, options);
		const args = s.spawn参数.find((list) => list.includes("--model"));
		expect(args![args!.indexOf("--model") + 1]).toBe("explicit/model-x");
	});
	it("def.模型 填的是档位名（桌面编辑器口径）→ 解析成 provider/model 并回填该档推荐思考档", async () => {
		// 档位名不是模型名：直传子进程会 Model not found 启动即死
		const s = fixture(defaultNodes.replace("    验收: 明确理由", "    验收: 明确理由\n    模型: 主力"));
		await startControl(s.recipe, {}, s.options);
		vi.spyOn(s.host, "executeTask").mockResolvedValue("没有调用工具");
		await s.bridge.drive(s.recipe, s.options);
		const args = s.spawn参数.find((list) => list.includes("--model"));
		expect(args![args!.indexOf("--model") + 1]).toBe("prov/main-model");
		// 档位推荐思考档对齐 dispatch-core 思考档 口径回填，部长档不丢
		expect(args![args!.indexOf("--thinking") + 1]).toBe("medium");
	});
	it("暂停停因的恢复指引带必填 name：照抄即可直跑 pao_control_node", async () => {
		const s = fixture();
		await startControl(s.recipe, {}, s.options);
		await pauseControl(s.recipe, s.options, "测试暂停");
		const paused = await s.bridge.drive(s.recipe, s.options);
		expect(paused.stopReason).toContain("测试暂停");
		expect(paused.stopReason).toContain("恢复：pao_control_node action=resume name=桥测试 instance=");
		expect(paused.stopReason).toContain("prev_owner=owner reason=现场核查");
	});
	it("停审/hold 早退停因带死绑定句：链停也不隐部长状态", async () => {
		const s = fixture();
		await startControl(s.recipe, {}, s.options);
		await bindMinister(s.recipe, s.options, "规划", "minister-规划");
		const report = controlReport(readControl(s.recipe, s.options));
		report.status = "hold";
		const chainSpy = vi.spyOn(auto, "runAutoChain").mockResolvedValue({
			report,
			steps: [{ node: "规划", cardRef: "1", stage: "停审", note: "权限拒绝：fixture" }],
			stopReason: "自动链停因：权限拒绝",
		});
		try {
			const stopped = await s.bridge.drive(s.recipe, s.options);
			expect(stopped.stopReason).toContain("自动链停因：权限拒绝");
			expect(stopped.stopReason).toContain("1 个节点的绑定部长会话已无热进程(节点:规划)");
		} finally {
			chainSpy.mockRestore(); // 模块级 spy 不随 fixture 回收，必须显式还原
		}
	});
	it("本次推进上限早退停因带死绑定句：打满轮次如实停且不隐状态", async () => {
		// 模拟控制端反复回退，专门验证桥仍在 50 轮停止；真实回边/落盘由 workflow-control.test.ts 覆盖。
		const s = fixture(`  - 名字: 甲
    部门: 规划
    目标: 循环判定
    验收: 证据
    审核: true
    部门标准: 有证据
  - 名字: 乙
    部门: 审阅
    目标: 循环判定
    验收: 证据
    审核: true
    部门标准: 有证据
    回边:
      - 目标: 甲
        上限: 0
        超限动作: 停滞
    depends_on: [甲]
`);
		await startControl(s.recipe, {}, s.options);
		const state = readControl(s.recipe, s.options);
		const readSpy = vi.spyOn(controlModule, "readControl").mockImplementation(() => structuredClone(state));
		const bindSpy = vi
			.spyOn(controlModule, "bindMinister")
			.mockImplementation(async (_recipe, _options, name, session) => {
				state.节点.find((node) => node.名字 === name)!.部长会话 = session;
				return "模拟任务书";
			});
		const chainSpy = vi
			.spyOn(auto, "runAutoChain")
			.mockImplementation(async () => ({ report: controlReport(state), steps: [] }));
		const taskSpy = vi.spyOn(s.host, "executeTask").mockImplementation(async (input) => {
			const a = s.contexts.get(input.会话标识)!;
			const node = state.节点.find((n) => n.名字 === a.节点)!;
			if (a.节点 === "甲") {
				node.拆解结束 = true;
				node.零卡理由 = "模拟零卡检查";
				node.判定 = { 结果: "pass", 理由: "模拟判定，未验证运行", 引用: ["x:1"], 时间: "fixture" };
			} else {
				state.回边次数["乙→甲"] = (state.回边次数["乙→甲"] ?? 0) + 1;
				for (const n of state.节点) {
					n.轮次++;
					n.拆解结束 = false;
					n.判定 = undefined;
					n.零卡理由 = undefined;
				}
			}
			return "模拟回答";
		});
		try {
			const result = await s.bridge.drive(s.recipe, s.options);
			expect(result.stopReason).toContain("本次推进上限");
			expect(result.stopReason).toContain("2 个节点的绑定部长会话已无热进程(节点:甲、乙)");
			expect(taskSpy).toHaveBeenCalledTimes(100);
			expect(state.回边次数["乙→甲"]).toBe(50);
		} finally {
			readSpy.mockRestore();
			bindSpy.mockRestore();
			chainSpy.mockRestore();
		}
	}, 30000);
	it("缺 PAO_HOME 或档位配置且节点无显式模型：drive 拒启并报「部长模型解析失败」", async () => {
		const withoutHome = fixture();
		const options = { ...withoutHome.options, paoHome: undefined };
		await startControl(withoutHome.recipe, {}, options);
		await expect(withoutHome.bridge.drive(withoutHome.recipe, options)).rejects.toThrow("部长模型解析失败");
		expect(readControl(withoutHome.recipe, withoutHome.options).暂停).toContain("部长模型解析失败");
		const emptyHome = fixture();
		await startControl(emptyHome.recipe, {}, emptyHome.options);
		const noConfig = { ...emptyHome.options, paoHome: join(emptyHome.options.cardsDir, "..") };
		await expect(emptyHome.bridge.drive(emptyHome.recipe, noConfig)).rejects.toThrow("部长模型解析失败");
	});
});
