/** 模拟部长协议回调；真控制文件与卡状态流转，不调用模型。 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "../../src/core/extensions/types.ts";
import { bindExecutionContext, executionContextPath } from "../../src/pao/cards/execution-context.ts";
import { loadCard, parseCardRef, projectRootForCards, serializeCard } from "../../src/pao/cards/index.ts";
import { loadDispatchMapArtifact } from "../../src/pao/dispatch-brief/artifacts.ts";
import { saveDispatchReconResult } from "../../src/pao/dispatch-brief/recon-artifact.ts";
import { saveDispatchReconHandoff } from "../../src/pao/dispatch-brief/recon-handoff.ts";
import { type HostToolEndEvent, MinisterHost } from "../../src/pao/host/host.ts";
import paoExtension from "../../src/pao/index.ts";
import { WorkerRunner } from "../../src/pao/worker/runner.ts";
import type { AutoChainReceiptEvent } from "../../src/pao/workflow/auto.ts";
import * as auto from "../../src/pao/workflow/auto.ts";
import * as controlModule from "../../src/pao/workflow/control.ts";
import {
	addNodeCards,
	bindMinister,
	controlPath,
	controlReport,
	decideNode,
	endDecomposition,
	pauseControl,
	readControl,
	readControlReport,
	startControl,
} from "../../src/pao/workflow/control.ts";
import { WorkflowHostBridge } from "../../src/pao/workflow/host-bridge.ts";
import {
	registerWorkflowMinisterTools,
	WORKFLOW_MINISTER_ENV,
	type WorkflowMinisterContext,
} from "../../src/pao/workflow/minister.ts";
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
    只读: true
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
	writeFileSync(join(root, "source.txt"), "baseline\n");
	execFileSync("git", ["init", "--quiet"], { cwd: root });
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync("git", ["-c", "user.name=test", "-c", "user.email=t@t", "commit", "-qm", "baseline"], { cwd: root });
	const options = { cardsDir: join(root, ".pao", "卡"), ownerSessionId: "owner", 运行器: new WorkerRunner(), paoHome };
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

describe("过期地图复核（模拟停链事件，真实地图与控制正本）", () => {
	it.each([true, false])(
		"只通知地图所属部长复核，不能确认时停下，不覆盖旧地图：更新=%s",
		async (update) => {
			const s = fixture(
				`  - 名字: 规划\n    部门: 规划\n    目标: 侦察\n    验收: 保存地图\n    只读: true\n  - 名字: 实现\n    部门: 审阅\n    目标: 实现\n    验收: 完成\n    depends_on: [规划]\n`,
			);
			const root = projectRootForCards(s.options.cardsDir);
			await startControl(s.recipe, {}, s.options);
			await bindMinister(s.recipe, s.options, "规划", "session-规划");
			const initial = readControl(s.recipe, s.options);
			const assigned: WorkflowMinisterContext = {
				名字: s.recipe.名字,
				实例: initial.实例,
				节点: "规划",
				轮次: 1,
				owner: "owner",
				cardsDir: s.options.cardsDir,
			};
			const tools = new Map<string, ToolDefinition>();
			const pi = { registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as unknown as ExtensionAPI;
			registerWorkflowMinisterTools(pi, assigned);
			const ctx = { sessionManager: { getSessionId: () => "session-规划" } } as unknown as ExtensionToolContext;
			const mapTool = tools.get("pao_minister_save_node_map")!;
			await mapTool.execute(
				"map",
				{ coverage: ["source.txt"], facts: ["旧事实"], scope_confirmed: true, scope_basis: ["真实文件"] },
				undefined,
				undefined,
				ctx,
			);
			await endDecomposition(
				s.recipe,
				s.options,
				{ 实例: initial.实例, 节点: "规划", 轮次: 1, 部长会话: "session-规划" },
				"已保存地图",
			);
			const oldRef = readControl(s.recipe, s.options).记录.findLast((record) => record.事件 === "节点交接地图")!
				.理由!;
			writeFileSync(join(root, "source.txt"), "new source\n");
			let first = true,
				refreshes = 0;
			const chain = vi.spyOn(auto, "runAutoChain").mockImplementation(async () => {
				if (first) {
					first = false;
					return {
						report: controlReport(readControl(s.recipe, s.options)),
						steps: [
							{
								node: "实现",
								cardRef: "卡0001",
								stage: "停审",
								note: "模拟准备阶段发现旧地图",
								staleMapRef: oldRef,
							},
						],
						stopReason: "地图过期",
					};
				}
				return { report: controlReport(readControl(s.recipe, s.options)), steps: [] };
			});
			vi.spyOn(s.host, "executeTask").mockImplementation(async (input) => {
				const context = s.contexts.get(input.会话标识)!;
				if (context.节点 === "规划") {
					refreshes++;
					expect(input.文本).toContain(`previous_ref=${oldRef}`);
					if (update)
						await mapTool.execute(
							"refresh",
							{
								coverage: ["source.txt"],
								facts: ["已读取新代码"],
								scope_confirmed: true,
								scope_basis: ["真实文件"],
								previous_ref: oldRef,
								supersession_reason: "代码已变化，复核事实",
							},
							undefined,
							undefined,
							ctx,
						);
				} else
					await endDecomposition(
						s.recipe,
						s.options,
						{ 实例: context.实例, 节点: context.节点, 轮次: context.轮次, 部长会话: input.会话标识 },
						"本测试模拟实现节点结束，不运行工人",
					);
				return "模拟部长回答";
			});
			try {
				const result = await s.bridge.drive(s.recipe, s.options);
				expect(refreshes).toBe(1);
				const flow = readControl(s.recipe, s.options);
				expect(flow.实例).toBe(initial.实例);
				expect(flow.节点[0].轮次).toBe(1);
				const latest = flow.记录.findLast((record) => record.事件 === "节点交接地图")!.理由!;
				if (update) {
					expect(result.report.status).toBe("completed");
					expect(loadDispatchMapArtifact(latest, { cardsDir: s.options.cardsDir }).previousRef).toBe(oldRef);
				} else {
					expect(result.report.status).not.toBe("completed");
					expect(latest).toBe(oldRef);
				}
				expect(loadDispatchMapArtifact(oldRef, { cardsDir: s.options.cardsDir }).facts).toEqual(["旧事实"]);
			} finally {
				chain.mockRestore();
				await s.options.运行器.stopAll();
				rmSync(root, { recursive: true, force: true });
			}
		},
		30_000,
	);
});

describe("实例部长收场（模拟宿主，真实控制正本）", () => {
	it("完成实例仅释放本项目本脉络的闲置部长", async () => {
		const s = fixture("  - 名字: 规划\n    部门: 规划\n    目标: 检查\n    验收: 理由\n");
		await startControl(s.recipe, {}, s.options);
		await bindMinister(s.recipe, s.options, "规划", "session-规划");
		const flow = readControl(s.recipe, s.options);
		await endDecomposition(
			s.recipe,
			s.options,
			{ 实例: flow.实例, 节点: "规划", 轮次: 1, 部长会话: "session-规划" },
			"模拟零卡检查已完成",
		);
		const root = projectRootForCards(s.options.cardsDir);
		vi.spyOn(s.host, "list").mockReturnValue([
			{ 部门: "规划", 项目根: root, 脉络: flow.脉络, 会话标识: "session-规划" },
			{ 部门: "规划", 项目根: root, 脉络: "independent", 会话标识: "other" },
		] as ReturnType<MinisterHost["list"]>);
		const teardown = vi.spyOn(s.host, "teardown").mockResolvedValue({
			pid: 1,
			部门: "规划",
			项目根: root,
			原因: "模拟释放部长",
			方式: "terminate",
		});
		expect((await s.bridge.drive(s.recipe, s.options)).report.status).toBe("completed");
		expect(teardown).toHaveBeenCalledTimes(1);
		expect(teardown.mock.calls[0]).toEqual(["规划", root, expect.any(String), flow.脉络]);
	});
	it("暂停实例保留有后台任务的部长，完成投递不会失去接收者", async () => {
		const s = fixture();
		await startControl(s.recipe, {}, s.options);
		await pauseControl(s.recipe, s.options, "用户暂停推进");
		const flow = readControl(s.recipe, s.options),
			root = projectRootForCards(s.options.cardsDir);
		vi.spyOn(s.host, "list").mockReturnValue([
			{ 部门: "规划", 项目根: root, 脉络: flow.脉络, 会话标识: "session-规划" },
		] as ReturnType<MinisterHost["list"]>);
		vi.spyOn(s.host, "backgroundCountFor").mockReturnValue({ inFlight: 1 });
		const teardown = vi.spyOn(s.host, "teardown");
		await s.bridge.drive(s.recipe, s.options);
		expect(teardown).not.toHaveBeenCalled();
	});
	it("多个部长逐个尝试收场，单个停止失败不阻断后续且不覆盖完成报告", async () => {
		const s = fixture("  - 名字: 规划\n    部门: 规划\n    目标: 检查\n    验收: 理由\n");
		await startControl(s.recipe, {}, s.options);
		await bindMinister(s.recipe, s.options, "规划", "session-规划");
		const flow = readControl(s.recipe, s.options);
		await endDecomposition(
			s.recipe,
			s.options,
			{ 实例: flow.实例, 节点: "规划", 轮次: 1, 部长会话: "session-规划" },
			"模拟零卡检查已完成",
		);
		const root = projectRootForCards(s.options.cardsDir);
		vi.spyOn(s.host, "list").mockReturnValue([
			{ 部门: "规划", 项目根: root, 脉络: flow.脉络, 会话标识: "session-1" },
			{ 部门: "规划", 项目根: root, 脉络: flow.脉络, 会话标识: "session-2" },
		] as ReturnType<MinisterHost["list"]>);
		let attempts = 0;
		const teardown = vi.spyOn(s.host, "teardown").mockImplementation(async () => {
			if (++attempts === 1) throw new Error("模拟第一个部长停止失败");
			return undefined;
		});
		const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect((await s.bridge.drive(s.recipe, s.options)).report.status).toBe("completed");
			expect(teardown).toHaveBeenCalledTimes(2);
			const warning = warnings.mock.calls.flat().join("\n");
			expect(warning).toContain(flow.实例);
			expect(warning).toContain("session-1");
			expect(warning).toContain(root);
			expect(warning).toContain("模拟第一个部长停止失败");
		} finally {
			warnings.mockRestore();
		}
	});
	it("收场读取控制正本失败时保留完成报告且不按旧归属停止部长", async () => {
		const s = fixture("  - 名字: 规划\n    部门: 规划\n    目标: 检查\n    验收: 理由\n");
		await startControl(s.recipe, {}, s.options);
		await bindMinister(s.recipe, s.options, "规划", "session-规划");
		const flow = readControl(s.recipe, s.options);
		await endDecomposition(
			s.recipe,
			s.options,
			{ 实例: flow.实例, 节点: "规划", 轮次: 1, 部长会话: "session-规划" },
			"模拟零卡检查已完成",
		);
		const control = controlPath(s.recipe, s.options);
		vi.spyOn(s.host, "list").mockImplementation(() => {
			rmSync(control, { force: true });
			return [];
		});
		const teardown = vi.spyOn(s.host, "teardown");
		const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect((await s.bridge.drive(s.recipe, s.options)).report.status).toBe("completed");
			expect(teardown).not.toHaveBeenCalled();
			const warning = warnings.mock.calls.flat().join("\n");
			expect(warning).toContain(flow.实例);
			expect(warning).toContain("控制正本读取失败，不按旧归属停止部长");
		} finally {
			warnings.mockRestore();
		}
	});
	it("原业务异常不被收场停止失败覆盖", async () => {
		const s = fixture();
		await startControl(s.recipe, {}, s.options);
		const root = projectRootForCards(s.options.cardsDir);
		const flow = readControl(s.recipe, s.options);
		vi.spyOn(s.host, "list").mockReturnValue([
			{ 部门: "规划", 项目根: root, 脉络: flow.脉络, 会话标识: "session-1" },
			{ 部门: "规划", 项目根: root, 脉络: flow.脉络, 会话标识: "session-2" },
		] as ReturnType<MinisterHost["list"]>);
		const original = new Error("模拟原始 RPC 中断");
		vi.spyOn(s.host, "executeTask").mockRejectedValue(original);
		let cleanupAttempts = 0;
		vi.spyOn(s.host, "teardown").mockImplementation(async (_department, _root, reason) => {
			if (reason === "工作流异常停止，释放本实例部长并保留会话历史" && ++cleanupAttempts === 1)
				throw new Error("模拟异常收场停止失败");
			return undefined;
		});
		const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await expect(s.bridge.drive(s.recipe, s.options)).rejects.toBe(original);
			expect(cleanupAttempts).toBe(2);
			const warning = warnings.mock.calls.flat().join("\n");
			expect(warning).toContain(flow.实例);
			expect(warning).toContain("session-1");
			expect(warning).toContain(root);
			expect(warning).toContain("模拟异常收场停止失败");
		} finally {
			warnings.mockRestore();
		}
	});
});
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
		const branchSignals: AbortSignal[] = [];
		let started = 0;
		let active = 0;
		vi.spyOn(s.host, "executeTask").mockImplementation(async (input) => {
			expect(input.signal).toBeInstanceOf(AbortSignal);
			branchSignals.push(input.signal!);
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
		expect(branchSignals.every((signal) => signal.aborted && signal.reason === controller.signal.reason)).toBe(true);
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
	it("真实 worker 回执只 followUp 回绑定部长，错卡和错热会话均拒绝投递", async () => {
		const s = fixture();
		vi.spyOn(s.host, "hotSession").mockImplementation(
			(dept) => ({ 会话标识: `session-${dept}` }) as ReturnType<MinisterHost["hotSession"]>,
		);
		await startControl(s.recipe, {}, s.options);
		await bindMinister(s.recipe, s.options, "规划", "session-规划");
		const planNode = readControl(s.recipe, s.options).节点.find((node) => node.名字 === "规划")!;
		const cards = await addNodeCards(
			s.recipe,
			s.options,
			{
				实例: readControl(s.recipe, s.options).实例,
				节点: "规划",
				轮次: planNode.轮次,
				部长会话: planNode.部长会话!,
			},
			[{ goal: "实现", acceptance: "存在: 产物/报告.md" }],
		);
		const injected: Array<{ dept: string; text: string }> = [];
		const receiptEvent: AutoChainReceiptEvent = {
			workflow: s.recipe.名字,
			node: "规划",
			round: 1,
			cardRef: cards[0],
			attempt: 1,
			result: "success",
			recorded: true,
			receipt: {
				card_no: cards[0],
				attempt: 1,
				status: "success",
				artifact_path: ["产物/报告.md"],
				summary: "实现完成",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
				evidence_path: "证据.jsonl",
				exitCode: 0,
				command: "fixture",
				pid: 1,
				duration_ms: 1,
				verification: [{ 条件: "存在: 产物/报告.md", 结论: "pass", 证据: "真实文件" }],
			},
		};
		vi.spyOn(s.host, "inject").mockImplementation(async (dept, _root, text, _context, mode) => {
			expect(mode).toBe("followUp");
			injected.push({ dept, text });
			return { ok: true, 模式: "followUp", 处置: "queued" };
		});
		let receiptCallback: ((event: AutoChainReceiptEvent) => void | Promise<void>) | undefined;
		let receiptEmitted = false;
		const chainSpy = vi.spyOn(auto, "runAutoChain").mockImplementation(async (_recipe, options) => {
			receiptCallback = options.onReceipt;
			if (!receiptEmitted) {
				receiptEmitted = true;
				const mismatched = {
					...receiptEvent,
					cardRef: "9999",
					receipt: { ...receiptEvent.receipt, card_no: "9999" },
				};
				vi.mocked(s.host.inject).mockClear();
				await expect(options.onReceipt?.(mismatched)).rejects.toThrow("找不到绑定部长");
				expect(s.host.inject).not.toHaveBeenCalled();
				vi.mocked(s.host.hotSession).mockReturnValueOnce({ 会话标识: "session-另一个部长" } as ReturnType<
					MinisterHost["hotSession"]
				>);
				await expect(options.onReceipt?.(receiptEvent)).rejects.toThrow("拒绝投递到其他部长上下文");
				expect(s.host.inject).not.toHaveBeenCalled();
				await options.onReceipt?.(receiptEvent);
			}
			return { report: controlReport(readControl(_recipe, options)), steps: [] };
		});
		vi.spyOn(s.host, "executeTask").mockImplementation(async (input) => {
			const a = s.assigned();
			await endDecomposition(
				s.recipe,
				s.options,
				{
					实例: a.实例,
					节点: a.节点,
					轮次: a.轮次,
					部长会话: input.会话标识,
				},
				"只读检查完成",
			);
			return "模拟回答";
		});
		try {
			await s.bridge.drive(s.recipe, s.options);
			expect(receiptCallback).toBeTypeOf("function");
			expect(injected).toHaveLength(1);
			expect(injected[0].dept).toBe("规划");
			expect(injected[0].text).toContain("实现完成");
			expect(injected[0].text).toContain("回执与自报不等于独立验收");
			vi.mocked(s.host.inject).mockResolvedValueOnce({ ok: false, 模式: "followUp", 原因: "模拟会话关闭" });
			await expect(receiptCallback!(receiptEvent)).rejects.toThrow("模拟会话关闭");
		} finally {
			chainSpy.mockRestore();
		}
	});
	it("侦察回执展示当前 attempt 的交接收据与产物摘要，普通卡无交接时不虚构", async () => {
		const s = fixture();
		vi.spyOn(s.host, "hotSession").mockImplementation(
			(dept) => ({ 会话标识: `session-${dept}` }) as ReturnType<MinisterHost["hotSession"]>,
		);
		await startControl(s.recipe, {}, s.options);
		await bindMinister(s.recipe, s.options, "规划", "session-规划");
		const planning = readControl(s.recipe, s.options).节点.find((node) => node.名字 === "规划")!;
		const [cardRef] = await addNodeCards(
			s.recipe,
			s.options,
			{
				实例: readControl(s.recipe, s.options).实例,
				节点: "规划",
				轮次: planning.轮次,
				部长会话: planning.部长会话!,
			},
			[{ goal: "侦察", acceptance: "存在: 产物/报告.md" }],
		);
		const card = loadCard(s.options.cardsDir, parseCardRef(cardRef));
		card.frontmatter.status = "in_progress";
		card.frontmatter.attempt = 1;
		card.frontmatter.owner = "fixture";
		writeFileSync(card.path, serializeCard(card.frontmatter, card.body));
		const execution = await bindExecutionContext(
			{
				key: { cardsDir: s.options.cardsDir, cardNo: card.card_no, attempt: 1 },
				projectRoot: projectRootForCards(s.options.cardsDir),
				repositoryRoot: projectRootForCards(s.options.cardsDir),
				executionRoot: projectRootForCards(s.options.cardsDir),
				worktree: {
					kind: "primary",
					taskRoot: projectRootForCards(s.options.cardsDir),
					executionRoot: projectRootForCards(s.options.cardsDir),
					commonGitDir: "",
					inputVersion: "single-root",
					bindingDigest: `sha256:${"1".repeat(64)}`,
				},
				snapshotRef: join(s.options.cardsDir, "..", "输入快照", "fixture.json"),
				snapshotDigest: `sha256:${"2".repeat(64)}`,
			},
			{ expectedCurrentAttempt: 1 },
		);
		const recon = await saveDispatchReconResult({
			cardsDir: s.options.cardsDir,
			cardPath: card.path,
			cardNo: card.card_no,
			attempt: 1,
			owner: "fixture",
			id: "callers",
			markdown: "调用方在入口文件。",
			requirements: {
				kind: "scout",
				sections: [{ category: "facts", title: "调用方", markdown: "调用方在入口文件。" }],
			},
		});
		await saveDispatchReconHandoff({
			cardsDir: s.options.cardsDir,
			cardPath: card.path,
			cardNo: card.card_no,
			attempt: 1,
			owner: "fixture",
			bindingRef: executionContextPath({ cardsDir: s.options.cardsDir, cardNo: card.card_no, attempt: 1 }),
			bindingDigest: execution.bindingDigest,
			recon,
		});
		const receipt: AutoChainReceiptEvent = {
			workflow: s.recipe.名字,
			node: "规划",
			round: 1,
			cardRef,
			attempt: 1,
			result: "success",
			recorded: true,
			receipt: {
				card_no: cardRef,
				attempt: 1,
				status: "success",
				artifact_path: ["产物/报告.md"],
				summary: "侦察完成",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
				evidence_path: "证据.jsonl",
				exitCode: 0,
				command: "fixture",
				pid: 1,
				duration_ms: 1,
			},
		};
		const injected: string[] = [];
		vi.spyOn(s.host, "inject").mockImplementation(async (_dept, _root, text) => {
			injected.push(text);
			return { ok: true, 模式: "followUp", 处置: "queued" };
		});
		let receiptCallback: ((event: AutoChainReceiptEvent) => void | Promise<void>) | undefined;
		let receiptEmitted = false;
		const chainSpy = vi.spyOn(auto, "runAutoChain").mockImplementation(async (_recipe, options) => {
			receiptCallback = options.onReceipt;
			if (!receiptEmitted) {
				receiptEmitted = true;
				await options.onReceipt?.(receipt);
			}
			return { report: controlReport(readControl(_recipe, options)), steps: [] };
		});
		vi.spyOn(s.host, "executeTask").mockImplementation(async (input) => {
			const a = s.contexts.get(input.会话标识)!;
			await endDecomposition(
				s.recipe,
				s.options,
				{ 实例: a.实例, 节点: a.节点, 轮次: a.轮次, 部长会话: input.会话标识 },
				"模拟完成",
			);
			return "模拟回答";
		});
		try {
			await s.bridge.drive(s.recipe, { ...s.options, maxCards: 0 });
			expect(injected).toHaveLength(1);
			expect(injected[0]).toContain("侦察交接记录");
			expect(injected[0]).toContain(recon.ref);
			expect(injected[0]).toContain(recon.digest);
			expect(receiptCallback).toBeTypeOf("function");
		} finally {
			chainSpy.mockRestore();
		}
	});
	it.each(["pass", "shutdown", "stop_all", "inject_failure", "minister_exit", "missing_review"] as const)(
		"总线审核先入请求，忙时只用 followUp 排队；审核/关闭/投递失败正确收尾：%s",
		async (ending) => {
			const s = fixture();
			await startControl(s.recipe, {}, s.options);
			await bindMinister(s.recipe, s.options, "规划", "session-规划");
			const root = projectRootForCards(s.options.cardsDir);
			const recipe = { ...s.recipe, 自动执行: true };
			const [cardRef] = await addNodeCards(
				recipe,
				s.options,
				{
					实例: readControl(recipe, s.options).实例,
					节点: "规划",
					轮次: 1,
					部长会话: "session-规划",
				},
				[{ goal: "人工审阅", acceptance: "人工检查材料" }],
			);
			const card = loadCard(s.options.cardsDir, parseCardRef(cardRef));
			card.frontmatter.status = "in_progress";
			card.frontmatter.attempt = 1;
			card.body = `${card.body.trimEnd()}

## 回执 尝试1 2026-10-22 12:00
- result: success
- summary: 工人结果待人工复核
- evidence: ["证据.jsonl"]
- verification: [{"条件":"人工检查材料","结论":"pass","证据":"材料已核对"}]

## 机械验收 2026-10-22 12:01
- 结论: 全过停人工审
- 尝试: 1
- 执行根: ${root}
- [存在] 产物.md → 过（文件存在）
- 人话句 1 条待主控审
- [人话句] "人工检查材料"
`;
			writeFileSync(card.path, serializeCard(card.frontmatter, card.body));
			const flow = readControl(recipe, s.options);
			await endDecomposition(recipe, s.options, {
				实例: flow.实例,
				节点: "规划",
				轮次: 1,
				部长会话: "session-规划",
			});
			let ministerAlive = true;
			let ministerInFlight = 1;
			vi.spyOn(s.host, "hotSession").mockImplementation(() =>
				ministerAlive ? ({ 会话标识: "session-规划" } as ReturnType<MinisterHost["hotSession"]>) : undefined,
			);
			vi.spyOn(s.host, "backgroundCountFor").mockImplementation(() => ({ inFlight: ministerInFlight }));
			let backgroundListener: (() => void) | undefined;
			vi.spyOn(s.host, "subscribeBackground").mockImplementation((handler) => {
				backgroundListener = handler;
				return () => {
					backgroundListener = undefined;
				};
			});
			let requestId = "";
			let requestRecordedBeforeInject = false;
			let injectMode: "steer" | "followUp" | undefined;
			vi.spyOn(s.host, "inject").mockImplementation(async (_dept, _root, text, _context, mode) => {
				if (!text.includes("工作流工人审核请求")) return { ok: true, 模式: "followUp", 处置: "queued" };
				requestId = /request_id：([^\n]+)/.exec(text)?.[1]?.trim() ?? "";
				injectMode = mode;
				expect(text).toContain("[存在] 产物.md → 过");
				requestRecordedBeforeInject = readControl(recipe, s.options).记录.some(
					(record) => record.事件 === "工人审核请求" && record.理由.includes(requestId),
				);
				if (ending === "inject_failure") throw new Error("本次审核投递失败");
				return { ok: true, 模式: "followUp", 处置: "queued" };
			});
			vi.spyOn(s.host, "executeTask").mockImplementation(async (input) => {
				throw new Error(`审核等待期间不得重入部长任务：${input.文本}`);
			});
			let listener: ((event: HostToolEndEvent) => void) | undefined;
			vi.spyOn(s.host, "subscribeToolEnd").mockImplementation((handler) => {
				listener = handler;
				return () => {
					listener = undefined;
				};
			});
			const tools = new Map<string, ToolDefinition>();
			const pi = { registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as unknown as ExtensionAPI;
			registerWorkflowMinisterTools(pi, {
				名字: recipe.名字,
				实例: flow.实例,
				节点: "规划",
				轮次: 1,
				owner: "owner",
				cardsDir: s.options.cardsDir,
			});
			const reviewTool = tools.get("pao_minister_review_worker")!;
			const toolContext = {
				sessionManager: { getSessionId: () => "session-规划" },
			} as unknown as ExtensionToolContext;
			let settled = false;
			const chainSpy = vi.spyOn(auto, "runAutoChain").mockImplementation(async (_recipe, options) => {
				const review = await options.onReviewRequired!({
					workflow: recipe.名字,
					instance: flow.实例,
					node: "规划",
					round: 1,
					cardRef,
					attempt: 1,
					executionRoot: root,
					mechanicalResults: [{ 序号: 1, 类型: "存在", 摘要: "产物.md", 结果: "过", 说明: "文件存在" }],
					requirements: ["人工检查材料"],
					unmetReports: [],
					artifactPaths: ["产物.md"],
					evidencePath: "证据.jsonl",
				});
				if (ending === "missing_review")
					expect(review).toEqual({ result: "hold", basis: expect.stringContaining("未提交受控审核判定") });
				else expect(review).toEqual({ result: "pass", basis: "已核对证据材料和产物" });
				settled = true;
				const report = controlReport(readControl(_recipe, options));
				report.status = "hold";
				return { report, steps: [] };
			});
			try {
				const running = s.bridge.drive(recipe, s.options);
				void running.catch(() => {});
				while (!requestId) await new Promise((resolve) => setTimeout(resolve, 1));
				expect(injectMode).toBe("followUp");
				expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
				expect(requestRecordedBeforeInject).toBe(true);
				if (ending === "inject_failure") {
					await expect(running).rejects.toThrow("本次审核投递失败");
					expect(listener).toBeUndefined();
					expect(settled).toBe(false);
					return;
				}
				expect(listener).toBeTypeOf("function");
				if (ending === "minister_exit" || ending === "missing_review") {
					ministerAlive = ending !== "minister_exit";
					ministerInFlight = 0;
					backgroundListener!();
					if (ending === "minister_exit") await expect(running).rejects.toThrow("部长会话已退出或被替换");
					else expect((await running).report.status).toBe("hold");
					expect(listener).toBeUndefined();
					expect(backgroundListener).toBeUndefined();
					return;
				}
				if (ending === "shutdown" || ending === "stop_all") {
					if (ending === "shutdown") await s.bridge.shutdown();
					else await s.options.运行器.stopAll();
					await expect(running).rejects.toThrow(ending === "shutdown" ? "主会话正在关闭" : /abort/i);
					expect(listener).toBeUndefined();
					expect(settled).toBe(false);
					expect(readControl(recipe, s.options).暂停).toBeTruthy();
					return;
				}

				listener!({
					type: "tool_execution_end",
					department: "规划",
					projectRoot: join(root, "其他项目"),
					context: flow.脉络,
					sessionId: "session-规划",
					toolName: "pao_minister_review_worker",
					result: { details: { type: "pao_worker_review", requestId, result: "pass", basis: "来自其他项目" } },
					isError: false,
				});
				await Promise.resolve();
				// 即使会话名相同，其他项目也不能结算或破坏本次审核。
				expect(listener).toBeTypeOf("function");
				expect(settled).toBe(false);

				listener!({
					type: "tool_execution_end",
					department: "规划",
					projectRoot: root,
					context: flow.脉络,
					sessionId: "session-规划",
					toolName: "pao_minister_review_worker",
					result: {
						details: {
							type: "pao_worker_review",
							requestId: "上一轮审核",
							result: "pass",
							basis: "旧事件",
						},
					},
					isError: false,
				});
				await Promise.resolve();
				expect(settled).toBe(false);

				const decision = await reviewTool.execute(
					"review",
					{
						request_id: requestId,
						card_ref: cardRef,
						attempt: 1,
						result: "pass",
						basis: "已核对证据材料和产物",
					},
					undefined,
					undefined,
					toolContext,
				);
				listener!({
					type: "tool_execution_end",
					department: "规划",
					projectRoot: root,
					context: flow.脉络,
					sessionId: "session-规划",
					toolName: "pao_minister_review_worker",
					result: decision,
					isError: false,
				});
				await running;
				expect(settled).toBe(true);
			} finally {
				chainSpy.mockRestore();
			}
		},
	);
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
			for (const toolName of [
				"read",
				"grep",
				"find",
				"ls",
				"pao_minister_submit_cards",
				"pao_minister_save_node_map",
				"pao_submit_decision",
			])
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
			const a = s.contexts.get(input.会话标识)!;
			const node = readControl(s.recipe, s.options).节点.find((n) => n.名字 === a.节点)!;
			const id = { 实例: a.实例, 节点: a.节点, 轮次: a.轮次, 部长会话: input.会话标识 };
			const flow = readControl(s.recipe, s.options);
			const def = flow.冻结配方.节点.find((n) => n.名字 === a.节点)!;
			const judging = node.拆解结束 && def.审核 && !node.判定;
			phases.push(`${a.节点}:${judging ? "判定" : "拆解"}`);
			if (!judging) await endDecomposition(s.recipe, s.options, id, "模拟只读检查无需编码");
			else
				await decideNode(
					s.recipe,
					s.options,
					id,
					{
						结果: "pass",
						理由: "检查完成，未验证运行",
						引用: ["报告.md:1"],
					},
					def.允许请求主控裁定 && flow.裁定?.通道 === "主控" ? "主控" : false,
				);
			return "模拟回答";
		});
		const result = await s.bridge.drive(s.recipe, s.options);
		expect(result.report.status).toBe("completed");
		expect(phases).toEqual(["规划:拆解", "审阅:拆解", "审阅:判定"]);
	});
	it("回边超限放行后审核不再进入判定，宿主直接按配置完成", async () => {
		const s = fixture(
			`  - 名字: 开发
    部门: 开发
    目标: 修复问题
    验收: 提交修复
  - 名字: 审查
    部门: 审阅
    目标: 审核修复
    验收: 给出判定
    审核: true
    只读: true
    部门标准: 有证据
    depends_on: [开发]
    回边:
      - 目标: 开发
        上限: 1
        超限动作: 修完这轮放行
`,
		);
		await startControl(s.recipe, {}, s.options);
		const phases: string[] = [];
		const noBypass = vi.spyOn(controlModule, "decideNode");
		vi.spyOn(s.host, "executeTask").mockImplementation(async (input) => {
			const context = s.contexts.get(input.会话标识)!;
			const flow = readControl(s.recipe, s.options);
			const node = flow.节点.find((candidate) => candidate.名字 === context.节点)!;
			const def = flow.冻结配方.节点.find((candidate) => candidate.名字 === context.节点)!;
			const identity = {
				实例: context.实例,
				节点: context.节点,
				轮次: context.轮次,
				部长会话: input.会话标识,
			};
			const judging = node.拆解结束 && def.审核 && !node.放行修复;
			phases.push(`${context.节点}:${judging ? "判定" : "拆解"}`);
			if (node.拆解结束 && def.审核 && !judging) return "按配置放行，不再重新判定";
			if (!node.拆解结束) await endDecomposition(s.recipe, s.options, identity, "本测试模拟部长协议，不运行工人");
			if (judging) {
				const current = readControl(s.recipe, s.options);
				const round = current.节点.find((candidate) => candidate.名字 === "审查")!.轮次;
				await decideNode(s.recipe, s.options, identity, {
					结果: "change",
					目标: "开发",
					理由: round === 1 ? "第一次打回修复" : "修完仍超过回边上限",
					失败轴: "dept_standard",
					引用: ["source.txt:1"],
				});
			}
			return "模拟部长回答";
		});
		const result = await s.bridge.drive(s.recipe, s.options);
		const flow = readControl(s.recipe, s.options);
		const review = flow.节点.find((node) => node.名字 === "审查")!;
		expect(result.report.status).toBe("completed");
		expect(review.放行修复).toBe(true);
		expect(review.判定).toBeUndefined();
		expect(phases).toEqual([
			"开发:拆解",
			"审查:拆解",
			"审查:判定",
			"开发:拆解",
			"审查:拆解",
			"审查:判定",
			"开发:拆解",
			"审查:拆解",
		]);
		expect(noBypass).toHaveBeenCalledTimes(2);
		expect((await readControlReport(readControl(s.recipe, s.options), s.options)).status).toBe("completed");
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
    只读: true
    部门标准: 有证据
  - 名字: 乙
    部门: 审阅
    目标: 循环判定
    验收: 证据
    审核: true
    只读: true
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
		// 本例只模拟推进次数；版本真实性另由真实 Git 行为测试覆盖。
		const tree = "a".repeat(40);
		const reportSpy = vi
			.spyOn(controlModule, "readControlReport")
			.mockImplementation(async (flow, _options, dead) => controlReport(flow, dead, tree));
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
				node.判定 = {
					结果: "pass",
					理由: "模拟判定，未验证运行",
					引用: ["x:1"],
					时间: "fixture",
					projectRoot: projectRootForCards(s.options.cardsDir),
					contentTree: tree,
				};
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
			reportSpy.mockRestore();
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
