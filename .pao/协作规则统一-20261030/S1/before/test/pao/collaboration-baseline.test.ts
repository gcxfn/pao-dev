/** S0 现状刻画：断言当前缺口和已有保护，不表示目标行为已实现；后续阶段改为目标断言。 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { changeCardStatus, loadCard, parseCardRef } from "../../src/pao/cards/index.ts";
import { MinisterHost } from "../../src/pao/host/host.ts";
import paoExtension from "../../src/pao/index.ts";
import { WorkerRunner } from "../../src/pao/worker/runner.ts";
import {
	addNodeCards,
	bindMinister,
	controlPath,
	decideNode,
	endDecomposition,
	readControl,
	recordPending,
	requestRuling,
	startControl,
} from "../../src/pao/workflow/control.ts";
import { WorkflowHostBridge } from "../../src/pao/workflow/host-bridge.ts";
import { parseRecipe } from "../../src/pao/workflow/recipe.ts";
import { registerWorkflowTools } from "../../src/pao/workflow/tools.ts";
import { createDeviationPending } from "../../src/pao/workflow/transition.ts";

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(direct = false) {
	const root = mkdtempSync(join(tmpdir(), "pao-s0-baseline-"));
	roots.push(root);
	writeFileSync(join(root, "source.txt"), "baseline\n");
	for (const args of [
		["init", "--quiet"],
		["add", "source.txt"],
		["commit", "-qm", "baseline"],
	])
		execFileSync("git", ["-c", "user.name=S0", "-c", "user.email=s0@local", "-c", "commit.gpgsign=false", ...args], {
			cwd: root,
		});
	const paoHome = join(root, "home");
	mkdirSync(join(paoHome, "工作流"), { recursive: true });
	const text = `---\n${stringify({
		版本: 2,
		名字: "S0现状",
		参数: [],
		节点: [
			{
				名字: "开发",
				部门: "开发",
				目标: "产出",
				验收: direct ? "存在: source.txt\n人工判断" : "人工判断",
				允许请求主控裁定: true,
				...(direct ? { 执行方式: "直接" } : {}),
			},
			{ 名字: "下游", 部门: "审核", 目标: "核对", 验收: "人工判断", depends_on: ["开发"] },
		],
	})}---\n`;
	const recipe = parseRecipe(text, join(paoHome, "工作流", "S0现状.md"));
	writeFileSync(recipe.文件路径, text);
	const options = {
		cardsDir: join(root, ".pao", "卡"),
		workspaceDir: join(root, ".pao"),
		ownerSessionId: "owner",
		runMode: "unattended" as const,
		now: () => "2026-10-30 10:00",
	};
	await startControl(recipe, {}, options);
	if (!direct) await bindMinister(recipe, options, "开发", "minister");
	const identity = { 实例: readControl(recipe, options).实例, 节点: "开发", 轮次: 1, 部长会话: "minister" };
	return { root, paoHome, recipe, options, identity };
}

describe("S0 协作规则当前基线（模拟专业判断，真实控制文件和Git）", () => {
	it("直接任务需要语义验收时当前只hold，没有结构化待决或部长", async () => {
		const f = await fixture(true);
		const runner = new WorkerRunner();
		const host = new MinisterHost();
		const bridge = new WorkflowHostBridge(host);
		const spawn = vi.spyOn(host, "spawn");
		vi.spyOn(runner, "run").mockImplementation(async (options) => ({
			card_no: options.卡号,
			card_path: options.卡路径,
			attempt: options.尝试号 ?? 1,
			status: "success",
			artifact_path: [],
			summary: "S0固定模拟工人成功回执，未运行真实模型",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			evidence_path: join(f.root, "mock-evidence.jsonl"),
			exitCode: 0,
			command: "S0模拟",
			pid: 1,
			duration_ms: 1,
		}));
		try {
			const result = await bridge.drive(f.recipe, { ...f.options, 运行器: runner, paoHome: f.paoHome });
			expect(result.stopReason, JSON.stringify(result)).toContain("直接任务需要人工判断");
			const flow = readControl(f.recipe, f.options);
			expect(flow.待决).toBeUndefined();
			expect(flow.节点[0].部长会话).toBeUndefined();
			expect(spawn).not.toHaveBeenCalled();
		} finally {
			await bridge.shutdown();
		}
	});
	it("部长hold没有fail/not_run时当前登记入口拒绝，原控制文件不变", async () => {
		const f = await fixture();
		const [ref] = await addNodeCards(f.recipe, f.options, f.identity, [{ goal: "任务", acceptance: "人工判断" }]);
		changeCardStatus(loadCard(f.options.cardsDir, parseCardRef(ref)), {
			操作者: "owner",
			to: "in_progress",
			时间: "2026-10-30 10:00",
		});
		const card = loadCard(f.options.cardsDir, parseCardRef(ref));
		const pending = createDeviationPending({
			instance: f.identity.实例,
			node: "开发",
			round: 1,
			cardRef: ref,
			cardNo: card.card_no,
			attempt: card.frontmatter.attempt,
			kind: "部长hold",
			reason: "总体证据不足，没有工人自报未达项",
			items: [],
			createdAt: "2026-10-30T02:00:00Z",
			deadline: "2026-10-30T02:30:00Z",
		});
		const before = readFileSync(controlPath(f.recipe, f.options), "utf8");
		await expect(recordPending(f.recipe, f.options, pending)).rejects.toThrow("至少一项 fail/not_run");
		expect(readFileSync(controlPath(f.recipe, f.options), "utf8")).toBe(before);
	});

	it("当前只修改暂停展示文字就会阻止相同结构化裁定", async () => {
		const f = await fixture();
		const refs = await addNodeCards(f.recipe, f.options, f.identity, [{ goal: "任务", acceptance: "人工判断" }]);
		for (const ref of refs) {
			changeCardStatus(loadCard(f.options.cardsDir, parseCardRef(ref)), {
				操作者: "owner",
				to: "in_progress",
				时间: "2026-10-30 10:00",
			});
			// 模拟已完成机械交付；此用例只核控制层，不声明运行过工人和验收命令。
			changeCardStatus(loadCard(f.options.cardsDir, parseCardRef(ref)), {
				操作者: "owner",
				to: "delivered",
				时间: "2026-10-30 10:00",
			});
		}
		await endDecomposition(f.recipe, f.options, f.identity);
		await requestRuling(f.recipe, f.options, f.identity, "核对成果", true);
		const path = controlPath(f.recipe, f.options);
		const original = readFileSync(path, "utf8");
		const flow = readControl(f.recipe, f.options);
		const pending = structuredClone(flow.待决);
		flow.暂停 = "同一待决，仅换展示文字";
		writeFileSync(path, `---\n${stringify(flow)}---\n`);
		expect(readControl(f.recipe, f.options).待决).toEqual(pending);
		const decision = { 结果: "reject" as const, 理由: "成果不足", 引用: ["source.txt:1"], 失败轴: "card" as const };
		await expect(decideNode(f.recipe, f.options, f.identity, decision, "主控")).rejects.toThrow(
			"当前暂停不是等待主控裁定",
		);
		writeFileSync(path, original);
		await expect(decideNode(f.recipe, f.options, f.identity, decision, "主控")).resolves.toBeUndefined();
	});

	it("confirm混用decisions已经拒绝，且不调用界面确认或写控制文件", async () => {
		const f = await fixture();
		const tools = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>();
		const shutdown: Array<(event: object) => void> = [];
		const pi = {
			registerTool: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => tools.set(tool.name, tool),
			registerCommand: vi.fn(),
			on: (event: string, callback: (event: object) => void) => {
				if (event === "session_shutdown") shutdown.push(callback);
			},
			sendMessage: vi.fn(),
		} as unknown as ExtensionAPI;
		registerWorkflowTools(pi, {
			resolvePaoHome: () => f.paoHome,
			resolveOwnerSessionId: () => "owner",
			runner: new WorkerRunner(),
		});
		const before = readFileSync(controlPath(f.recipe, f.options), "utf8");
		const confirm = vi.fn(async () => true);
		try {
			await expect(
				tools
					.get("pao_control_node")!
					.execute(
						"S0",
						{ name: "S0现状", cards_dir: f.options.cardsDir, action: "confirm", decisions: [] },
						undefined,
						undefined,
						{ hasUI: true, ui: { confirm } } as never,
					),
			).rejects.toThrow("只能配合 action=resolve_pending");
			expect(confirm).not.toHaveBeenCalled();
			expect(readFileSync(controlPath(f.recipe, f.options), "utf8")).toBe(before);
		} finally {
			for (const callback of shutdown) callback({});
		}
	});

	it("关键cards注册中途失败当前只警告，仍继续注册派发工具", async () => {
		const f = await fixture();
		vi.stubEnv("PAO_HOME", f.paoHome);
		vi.stubEnv("PAO_ROLE", "主控");
		vi.stubEnv("PAO_WORKFLOW_MINISTER", "");
		const tools: string[] = [];
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		let injected = false;
		const pi = {
			registerTool: (tool: { name: string }) => {
				if (!injected && tool.name === "pao_change_status") {
					injected = true;
					throw new Error("S0注入cards中途失败");
				}
				tools.push(tool.name);
			},
			registerCommand: vi.fn(),
			registerMessageRenderer: vi.fn(),
			registerVirtualModel: vi.fn(),
			on: vi.fn(),
			sendMessage: vi.fn(),
		} as unknown as ExtensionAPI;
		expect(() =>
			paoExtension(pi, { resolvePaoHome: () => f.paoHome, resolveProjectRoot: () => f.root }),
		).not.toThrow();
		expect(injected).toBe(true);
		expect(warn.mock.calls.flat().join("\n")).toContain("S0注入cards中途失败");
		expect(tools).toContain("pao_dispatch_card");
		expect(tools).not.toContain("pao_change_status");
	});
});
