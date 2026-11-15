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

function fixture(nodes = defaultNodes) {
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
	const recipe = parseRecipe(`---\n版本: 2\n名字: 桥测试\n节点:\n${nodes}---`, join(root, "桥测试.md"));
	const options = { cardsDir: join(root, "卡"), ownerSessionId: "owner", 运行器: new WorkerRunner(), paoHome };
	const host = new MinisterHost();
	const bridge = new WorkflowHostBridge(host);
	let assigned: WorkflowMinisterContext;
	const spawn参数: string[][] = [];
	vi.spyOn(host, "spawn").mockImplementation(async (input) => {
		spawn参数.push([...(input.参数 ?? [])]);
		assigned = JSON.parse(input.环境变量![WORKFLOW_MINISTER_ENV]) as WorkflowMinisterContext;
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
	return { recipe, options, host, bridge, assigned: () => assigned, spawn参数 };
}
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
		// 回边 ping-pong（甲 pass 放行 → 乙 change 打回甲 → 无上限循环）打满 50 轮驱动
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
		vi.spyOn(s.host, "executeTask").mockImplementation(async (input) => {
			const a = s.assigned();
			const id = { 实例: a.实例, 节点: a.节点, 轮次: a.轮次, 部长会话: input.会话标识 };
			await endDecomposition(s.recipe, s.options, id, "零卡轮转");
			if (a.节点 === "甲")
				await decideNode(s.recipe, s.options, id, { 结果: "pass", 理由: "循环放行，未验证运行", 引用: ["x:1"] });
			else
				await decideNode(s.recipe, s.options, id, {
					结果: "change",
					理由: "循环打回",
					引用: ["x:1"],
					失败轴: "card",
					目标: "甲",
				});
			return "模拟回答";
		});
		const result = await s.bridge.drive(s.recipe, s.options);
		expect(result.stopReason).toContain("本次推进上限");
		// spawn 是假进程：每轮打回后两节点都处于「已绑定未拆解完」，推进上限停因不隐状态
		expect(result.stopReason).toContain("2 个节点的绑定部长会话已无热进程(节点:甲、乙)");
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
