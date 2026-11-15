import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import type {
	ExtensionAPI,
	ExtensionToolContext,
	SessionShutdownEvent,
	ToolDefinition,
} from "../../src/core/extensions/types.ts";
import { deliverCard } from "../../src/pao/cards/delivery.ts";
import { appendReceipt, changeCardStatus, parseCardRef } from "../../src/pao/cards/index.ts";
import { registerCardTools } from "../../src/pao/cards/tools.ts";
import { listPaoSubcommands, resetPaoSubcommandsForTest } from "../../src/pao/command-router.ts";
import { DispatchBriefError } from "../../src/pao/dispatch-brief/errors.ts";
import * as toastModule from "../../src/pao/notify/toast.ts";
import * as atomic from "../../src/pao/shared/atomic.ts";
import { withFileLock } from "../../src/pao/shared/lock.ts";
import * as dispatchCore from "../../src/pao/worker/dispatch-core.ts";
import { locateDispatchCard } from "../../src/pao/worker/dispatch-core.ts";
import {
	createDispatchNotifySurface,
	DISPATCH_NOTIFY_SECTION,
	DISPATCH_NOTIFY_WAKEUP_TEXT,
} from "../../src/pao/worker/notify.ts";
import * as postDispatch from "../../src/pao/worker/post-dispatch.ts";
import type { WorkerReceipt, WorkerStatus } from "../../src/pao/worker/receipt.ts";
import { WorkerRunner, type WorkerRunOptions } from "../../src/pao/worker/runner.ts";
import {
	type AutoChainPostDispatchResultEvent,
	type AutoChainReviewEvent,
	runAutoChain,
} from "../../src/pao/workflow/auto.ts";
import {
	addNodeCards,
	bindMinister,
	confirmControl,
	controlPath,
	controlReport,
	endDecomposition,
	pauseControl,
	readControl,
	readControlReport,
	reworkOriginalCards,
	startControl,
} from "../../src/pao/workflow/control.ts";
import type { DriveReport, NodeReport } from "../../src/pao/workflow/driver.ts";
import { parseManifest, startWorkflow, suspendCallHumanKey } from "../../src/pao/workflow/driver.ts";
import { loadRecipe } from "../../src/pao/workflow/recipe.ts";
import { registerWorkflowTools, tickWorkflowCore } from "../../src/pao/workflow/tools.ts";
import type { PaoWorktreeHost } from "../../src/pao/worktrees/types.ts";
import { createTestExtensionToolContext } from "../extension-tool-context.ts";

/**
 * M2-06 自动执行链第一段（单卡全链＋串行）：配方 自动执行: true 时
 * 启流/推流/确认流 走 auto.ts——派发→回执→越界核查→机械验收→交卷→解锁下游。
 * 派发子进程不真实拉起：FakeRunner 覆写 run()（与 worker-dispatch.test.ts 同款口径），
 * 链语义（状态机/基线/git 交卷）全部真跑：真 git 仓库、真基线快照、真 commit。
 */

const tempDirs: string[] = [];
const shutdowns: ((event: SessionShutdownEvent) => unknown)[] = [];
const backgroundDrains: (() => Promise<void>)[] = [];
const envKeys = ["PAO_ROLE", "PAO_DEPT", "PAO_HOME"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of envKeys) savedEnv[key] = process.env[key];
	delete process.env.PAO_ROLE;
	delete process.env.PAO_DEPT;
});

afterEach(async () => {
	// 超时不会取消测试启动的后台链；等本夹具收敛后再撤环境和删目录，避免污染下一场景。
	for (const drain of backgroundDrains.splice(0)) await drain();
	const cleanups: (() => void | Promise<void>)[] = [];
	for (const shutdown of shutdowns.splice(0))
		await shutdown({
			type: "session_shutdown",
			reason: "quit",
			onConfirmedShutdown: (cleanup) => cleanups.push(cleanup),
		});
	for (const cleanup of cleanups) await cleanup();
	vi.restoreAllMocks();
	for (const key of envKeys) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pao-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-c", "core.quotepath=off", "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
		cwd,
		encoding: "utf8",
	});
}

/** git 仓库 fixture：仓库根即项目根，干净开工基线；卡目录在 .pao/任务A/卡（排除区不污染差分） */
function makeRepo(prefix: string): { repo: string; cardsDir: string; workspaceDir: string } {
	const repo = tempDir(prefix);
	writeFileSync(join(repo, "已跟踪.txt"), "v1\n");
	git(repo, ["init"]);
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "--no-gpg-sign", "-m", "开工基线"]);
	const cardsDir = join(repo, ".pao", "任务A", "卡");
	const workspaceDir = join(repo, ".pao", "任务A");
	mkdirSync(cardsDir, { recursive: true });
	return { repo, cardsDir, workspaceDir };
}

/** 配方 fixture：落 <paoHome>/工作流/<名字>.md */
function writeRecipe(paoHome: string, name: string, body: string): void {
	const dir = join(paoHome, "工作流");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${name}.md`), body);
}

function recipeYaml(name: string, autoExecute: boolean, nodes: string[]): string {
	const lines = ["---", `名字: ${name}`];
	if (autoExecute) lines.push("自动执行: true");
	lines.push("参数: []", "节点:");
	lines.push(...nodes);
	lines.push("---", "说明: 测试配方");
	return lines.join("\n");
}

function nodeYaml(name2: string, acceptance: string, extra: string[] = []): string[] {
	return [
		`  - 名字: ${name2}`,
		`    目标: ${name2}任务`,
		"    部门: 测试",
		`    验收: "${acceptance}"`,
		...(extra.length > 0 ? extra : []),
	];
}

interface Captured {
	context: Promise<ExtensionToolContext>;
	tools: {
		name: string;
		execute: (
			id: string,
			params: Record<string, unknown>,
			signal?: AbortSignal,
		) => Promise<{ content: { text?: string }[]; details: unknown; isError?: boolean } | never>;
	}[];
	messages: string[];
	pi: ExtensionAPI;
	/** S6 后台链通知注入面：消费式读一轮 before_agent_start 段 */
	fireBeforeAgentStart(): Record<string, string>;
	/** 模拟本扩展实例收到 session_shutdown；不触发其他夹具实例。 */
	fireSessionShutdown(): Promise<void>;
}

function capturePi(hasUI = true): Captured {
	const captured: Captured = {
		// 保留真实上下文的惰性 getter；展开整个对象会读取尚未装配的运行时动作。
		context: createTestExtensionToolContext(process.cwd()).then((ctx) =>
			Object.defineProperties(Object.create(ctx), {
				hasUI: { value: hasUI },
				ui: { value: { ...ctx.ui, confirm: async () => true } },
			}),
		),
		tools: [],
		messages: [],
		pi: undefined as unknown as ExtensionAPI,
		fireBeforeAgentStart: () => {
			throw new Error("未初始化");
		},
		fireSessionShutdown: async (_event?: unknown) => {
			throw new Error("未初始化");
		},
	};
	const handlers = new Map<string, ((event: unknown) => void)[]>();
	captured.fireBeforeAgentStart = () => {
		const sections: Record<string, string> = {};
		for (const handler of handlers.get("before_agent_start") ?? []) handler({ systemPromptOptions: { sections } });
		return sections;
	};
	captured.fireSessionShutdown = async () => {
		const cleanups: (() => void | Promise<void>)[] = [];
		for (const handler of handlers.get("session_shutdown") ?? [])
			await handler({
				type: "session_shutdown",
				reason: "quit",
				onConfirmedShutdown: (cleanup: () => void | Promise<void>) => cleanups.push(cleanup),
			});
		for (const cleanup of cleanups) await cleanup();
	};
	captured.pi = {
		registerTool: (tool: ToolDefinition) =>
			captured.tools.push({
				name: tool.name,
				execute: async (id, params, signal) => {
					const result = await tool.execute(id, params, signal, undefined, await captured.context);
					return {
						...result,
						content: result.content.map((item) => ({ text: item.type === "text" ? item.text : undefined })),
					};
				},
			}),
		on: (event: string, handler: (event: unknown) => void) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			if (event === "session_shutdown") shutdowns.push(handler as (event: SessionShutdownEvent) => unknown);
			return () => {};
		},
		registerCommand: () => {},
		sendMessage: (message: { content: { text?: string }[] }) => {
			captured.messages.push(message.content.map((c) => c.text ?? "").join("\n"));
		},
	} as unknown as ExtensionAPI;
	return captured;
}

function toolOf(captured: Captured, name: string): Captured["tools"][number] {
	const tool = captured.tools.find((t) => t.name === name);
	if (!tool) throw new Error(`未注册 ${name}，实际:${captured.tools.map((t) => t.name).join("、")}`);
	return tool;
}

function textOf(result: { content: { text?: string }[] }): string {
	return result.content.map((c) => c.text ?? "").join("\n");
}

function fakeReceipt(cardNo: string, status: WorkerStatus, artifactPath: string[], repo: string): WorkerReceipt {
	return {
		card_no: cardNo,
		attempt: 1,
		status: status,
		artifact_path: artifactPath,
		summary: "假回执:做完了",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
		evidence_path: join(repo, ".pao", "任务A", `证据${cardNo}.jsonl`),
		exitCode: 0,
		command: "fake-runner",
		pid: -1,
		duration_ms: 1,
	};
}

/**
 * 假运行器：不 spawn，登记进真实注册表后跑注入的脚本（写真产物文件）并返回回执。
 * 脚本按卡号路由，让多节点串行测试能对各卡设不同行为。
 */
class FakeRunner extends WorkerRunner {
	runs: WorkerRunOptions[] = [];
	scripts = new Map<string, () => Promise<WorkerReceipt> | WorkerReceipt>();

	override async run(options: WorkerRunOptions): Promise<WorkerReceipt> {
		this.runs.push(options);
		this.registry.register({
			pid: 900000 + this.runs.length,
			card_no: options.卡号,
			card_path: options.卡路径,
			attempt: options.尝试号,
			command: "fake-runner",
			dept: options.部门 ?? null,
			dispatch_reason: options.派单理由 ?? null,
			...(options.supervisionRoute
				? {
						supervisor_dept: options.supervisionRoute.department,
						supervisor_context: options.supervisionRoute.context,
						supervisor_session: options.supervisionRoute.sessionId,
						supervision_key: options.supervisionRoute.key,
						supervision_department_key: options.supervisionRoute.departmentKey,
						supervision_label: options.supervisionRoute.label,
						supervision_owner: options.supervisionRoute.ownerSessionId,
						supervision_goal: options.supervisionRoute.goal,
						supervision_target: options.supervisionRoute.target ?? "minister",
						supervision_binding: options.supervisionRoute.binding,
						supervision_role: options.supervisionRoute.binding?.role,
					}
				: {}),
		});
		const script = this.scripts.get(options.卡号);
		if (!script) throw new Error(`FakeRunner 未配置卡 ${options.卡号} 的脚本`);
		const receipt = await script();
		this.registry.markExited(900000 + this.runs.length);
		return receipt;
	}
}

/** FakeRunner 覆写 run()，不进入 WorkerRunner 私有活跃表；登记表才是这个替身的真实在途探针。 */
function scriptRunning(runner: FakeRunner, cardPath: string): boolean {
	return runner.registry.list().some((entry) => entry.running && entry.card_path === cardPath);
}

interface Fixture {
	repo: string;
	cardsDir: string;
	runner: FakeRunner;
	captured: Captured;
	paoHome: string;
	/** S6 后台链收敛口（registerWorkflowTools 返回的受理面；直调核心无受理面时为 undefined） */
	face?: ReturnType<typeof registerWorkflowTools>;
	/** 按卡号配置 worker 行为（默认：写 产物.txt＋成功回执声明它） */
	scriptDefault(artifactPath: string[]): void;
}

/** S6 后台链收敛口：等本注册实例的全部在途自动链 settle（waitForBackground 同款）。 */
async function settleChains(f: Fixture): Promise<void> {
	await f.face?.waitForAutoChain();
}

/** 读一轮自动链通知（后台链 settle 后 before_agent_start 注入的内容;S6-K3 起与派卡通知共用 pao-dispatch-notify 段）。 */
function chainNotice(f: Fixture): string {
	return f.captured.fireBeforeAgentStart()[DISPATCH_NOTIFY_SECTION] ?? "";
}

function setup(
	name: string,
	recipeBody: string,
	extraOptions: Parameters<typeof registerWorkflowTools>[1] = {},
): Fixture {
	const { repo, cardsDir } = makeRepo("autochain");
	const paoHome = tempDir("paohome");
	writeRecipe(paoHome, name, recipeBody);
	const runner = new FakeRunner();
	const captured = capturePi();
	const face = registerWorkflowTools(captured.pi, {
		...extraOptions,
		resolvePaoHome: () => paoHome,
		resolveCardsDir: () => cardsDir,
		resolveOwnerSessionId: () => "owner",
		runner,
	});
	const fixture: Fixture = {
		face,
		repo,
		cardsDir,
		runner,
		captured,
		paoHome,
		scriptDefault(artifactPath: string[]) {
			runner.scripts.set("0001", () => {
				writeFileSync(join(repo, "产物.txt"), "产物\n");
				return fakeReceipt("0001", "success", artifactPath, repo);
			});
			runner.scripts.set("0002", () => {
				writeFileSync(join(repo, "产物2.txt"), "产物2\n");
				return fakeReceipt("0002", "success", artifactPath, repo);
			});
		},
	};
	backgroundDrains.push(() => face.waitForAutoChain());
	return fixture;
}

function cardAt(cardsDir: string, cardNo: string) {
	return locateDispatchCard(cardsDir, cardNo);
}

function commits(repo: string): string[] {
	return git(repo, ["log", "--format=%s"])
		.trim()
		.split("\n")
		.filter((line) => line.length > 0);
}

// ── 硬约束：无 自动执行 字段＝手动链逐字节不变 ─────────────────────────────

describe("M2-06 自动执行链", () => {
	it("无人值守宿主在启流前拒绝人工门，不落卡或启动工人", async () => {
		const f = setup(
			"缺人工界面",
			recipeYaml("缺人工界面", true, nodeYaml("A", "存在: 产物.txt", ["    人工确认: true"])),
		);
		const captured = capturePi(false);
		registerWorkflowTools(captured.pi, {
			resolvePaoHome: () => f.paoHome,
			resolveCardsDir: () => f.cardsDir,
			runner: f.runner,
		});
		await expect(toolOf(captured, "pao_start_flow").execute("headless", { name: "缺人工界面" })).rejects.toThrow(
			"没有可核验的交互界面",
		);
		expect(f.runner.runs).toHaveLength(0);
		expect(existsSync(join(f.cardsDir, "..", "工作流实例-缺人工界面.md"))).toBe(false);
	});
	it("独立审核预检成功后仍在自动派发现查能力；宿主变化即停派，不创建副本或启动工人", async () => {
		const capability = vi.fn<PaoWorktreeHost["capability"]>();
		capability
			.mockResolvedValueOnce({ ok: true, create: true, cleanup: true, baseline: "recoverable-complete" })
			.mockResolvedValueOnce({ ok: false, reason: "宿主连接在派发时断开" });
		const create = vi.fn<PaoWorktreeHost["create"]>();
		const host: PaoWorktreeHost = {
			capability,
			create,
			async inspect() {
				return [];
			},
			async resolveForDispatch() {
				throw new Error("能力失败时不应解析工作树");
			},
			async requestCleanup() {
				return { ok: false, retained: true, reason: "本测试不管理工作树" };
			},
		};
		const f = setup(
			"派发复核",
			recipeYaml(
				"派发复核",
				false,
				nodeYaml("A", "存在: 产物.txt", ["    只读: true", "    审核: true", "    部门标准: 有证据"]),
			).replace("---\n", "---\n版本: 2\n"),
			{ worktreeHost: host, resolveOwnerSessionId: () => "owner" },
		);
		mkdirSync(join(f.paoHome, "pao配置"), { recursive: true });
		writeFileSync(
			join(f.paoHome, "pao配置", "档位.json"),
			JSON.stringify({ 档位: [{ 名: "primary", provider: "offline", model: "fake", thinkingLevel: "off" }] }),
		);
		mkdirSync(join(f.paoHome, "部门", "测试"), { recursive: true });
		writeFileSync(
			join(f.paoHome, "部门", "注册表.md"),
			"| 名字 | 能力标签 | 库路径 | 建部日期 |\n| --- | --- | --- | --- |\n| 测试 | 测试 | 部门/测试/知识库 | 2026-10-23 |\n",
		);
		writeFileSync(
			join(f.paoHome, "部门", "测试", "配方.md"),
			"# 测试部门配方\n名字:测试\n人设:执行测试任务\n工具:read、write\n默认档位:primary\n",
		);
		const recipe = loadRecipe(f.paoHome, "派发复核");
		const options = {
			cardsDir: f.cardsDir,
			paoHome: f.paoHome,
			ownerSessionId: "owner",
			运行器: f.runner,
			worktreeHost: host,
		};
		await expect(toolOf(f.captured, "pao_start_flow").execute("start", { name: "派发复核" })).resolves.toBeDefined();
		await bindMinister(recipe, options, "A", "minister-A");
		const flow = readControl(recipe, options);
		const identity = { 实例: flow.实例, 节点: "A", 轮次: 1, 部长会话: "minister-A" };
		await addNodeCards(recipe, options, identity, [{ goal: "独立验证", acceptance: "存在: 产物.txt" }]);
		await endDecomposition(recipe, options, identity);
		const chain = await runAutoChain(recipe, options);

		expect(capability).toHaveBeenCalledTimes(2);
		expect(chain.stopReason).toContain("宿主连接在派发时断开");
		expect(chain.stopReason).toContain("不能退回主目录冒充只读验证");
		expect(chain.steps).toContainEqual({
			node: "A",
			cardRef: "卡0001",
			stage: "停审",
			note: "验证卡隔离能力不足:工作树宿主报告不可用：宿主连接在派发时断开",
		});
		expect(create).not.toHaveBeenCalled();
		expect(f.runner.runs).toHaveLength(0);
		expect(cardAt(f.cardsDir, "0001").frontmatter.status).toBe("unclaimed");
		expect(readControl(recipe, options).已派卡 ?? 0).toBe(0);
	});
	it("v2 整批验收预检遇第二条非法时不发号、不留下半批卡", async () => {
		const f = setup(
			"整批预检",
			recipeYaml("整批预检", true, nodeYaml("A", "存在: 产物.txt")).replace("---\n", "---\n版本: 2\n"),
		);
		const recipe = loadRecipe(f.paoHome, "整批预检");
		const options = { cardsDir: f.cardsDir, paoHome: f.paoHome, ownerSessionId: "owner", 运行器: f.runner };
		await startControl(recipe, {}, options);
		await bindMinister(recipe, options, "A", "minister-A");
		const flow = readControl(recipe, options);
		const identity = { 实例: flow.实例, 节点: "A", 轮次: 1, 部长会话: "minister-A" };

		await expect(
			addNodeCards(recipe, options, identity, [
				{ goal: "甲活", acceptance: "存在: 未来产物.txt" },
				{ goal: "乙活", acceptance: "包含: README.md" },
			]),
		).rejects.toMatchObject({ code: "INVALID_CARD" });

		expect(readdirSync(f.cardsDir)).toEqual([]);
		expect(readControl(recipe, options).节点.find((node) => node.名字 === "A")?.卡).toEqual([]);
	});

	it.each(["prepare", "dispatch"])("v2 地图过期保留原引用供宿主复核：%s（模拟派发异常）", async (stage) => {
		const f = setup(
			"地图恢复",
			recipeYaml("地图恢复", true, nodeYaml("A", "存在: 产物.txt")).replace("---\n", "---\n版本: 2\n"),
		);
		const recipe = loadRecipe(f.paoHome, "地图恢复");
		const options = { cardsDir: f.cardsDir, paoHome: f.paoHome, ownerSessionId: "owner", 运行器: f.runner };
		await startControl(recipe, {}, options);
		await bindMinister(recipe, options, "A", "minister-A");
		const flow = readControl(recipe, options);
		const identity = { 实例: flow.实例, 节点: "A", 轮次: 1, 部长会话: "minister-A" };
		await addNodeCards(recipe, options, identity, [{ goal: "实现", acceptance: "存在: 产物.txt" }]);
		await endDecomposition(recipe, options, identity);
		const ref = "pao-map://original-planning-map";
		vi.spyOn(dispatchCore, "executeDispatch").mockRejectedValue(
			new DispatchBriefError("stale_map", "地图覆盖内容已变化", {
				stage,
				kind: "workflow-map-handoff",
				ref,
			}),
		);
		const result = await runAutoChain(recipe, options);
		expect(result.steps.find((step) => step.staleMapRef)?.staleMapRef).toBe(ref);
		expect(result.stopReason).toContain("地图覆盖内容已变化");
		expect(f.runner.runs).toHaveLength(0);
		expect(cardAt(f.cardsDir, "0001").frontmatter.status).toBe("unclaimed");
		expect(readControl(recipe, options).暂停).toBeUndefined();
	});

	it("v2 worker失败：命令核心返回前持久状态已挂起，真实卡原因与报告一致且旁支不被全局暂停", async () => {
		const f = setup(
			"v2失败",
			recipeYaml("v2失败", true, [
				...nodeYaml("A", "存在: 产物.txt"),
				...nodeYaml("旁支", "存在: 旁支.txt"),
			]).replace("---\n", "---\n版本: 2\n"),
		);
		const recipe = loadRecipe(f.paoHome, "v2失败");
		const options = { cardsDir: f.cardsDir, paoHome: f.paoHome, ownerSessionId: "owner", 运行器: f.runner };
		await startControl(recipe, {}, options);
		await bindMinister(recipe, options, "A", "minister-A");
		const flow = readControl(recipe, options);
		const identity = { 实例: flow.实例, 节点: "A", 轮次: 1, 部长会话: "minister-A" };
		await addNodeCards(recipe, options, identity, [{ goal: "失败夹具", acceptance: "存在: 产物.txt" }]);
		await endDecomposition(recipe, options, identity);
		const before = readControl(recipe, options);
		expect(before.状态).toBe("运行中");
		f.runner.scripts.set("0001", () => ({
			...fakeReceipt("0001", "failed", [], f.repo),
			摘要: "明确模拟轮次耗尽",
			失败类型: "瞬时故障",
		}));
		const text = await tickWorkflowCore(recipe, options, {
			queueReview: (_report, _cardsDir) => {},
			paoHome: f.paoHome,
		});
		const saved = readControl(recipe, options);
		expect(text).toContain("状态：hold");
		expect(saved.状态).toBe("挂起");
		expect((await runAutoChain(recipe, options)).waitingForEvent).toBeUndefined();
		expect(controlReport(saved).status).toBe("hold");
		expect(controlReport(saved).nodes.find((node) => node.name === "A")?.hold).toContain("failed");
		expect(saved.暂停).toBeUndefined();
		expect(saved.节点.find((node) => node.名字 === "旁支")).toEqual(before.节点.find((node) => node.名字 === "旁支"));
		expect(f.runner.runs).toHaveLength(1);
	});

	it(
		"v2 节点内并行（工人数量:2）:同批两卡都走受保护派发,一败一成交互不牵连,停因如实",
		{ timeout: 60_000 },
		async () => {
			const f = setup(
				"v2并行",
				recipeYaml("v2并行", true, nodeYaml("A", "存在: 产物.txt", ["    工人数量: 2"])).replace(
					"---\n",
					"---\n版本: 2\n",
				),
			);
			const recipe = loadRecipe(f.paoHome, "v2并行");
			const options = { cardsDir: f.cardsDir, paoHome: f.paoHome, ownerSessionId: "owner", 运行器: f.runner };
			await startControl(recipe, {}, options);
			await bindMinister(recipe, options, "A", "minister-A");
			const flow = readControl(recipe, options);
			const identity = { 实例: flow.实例, 节点: "A", 轮次: 1, 部长会话: "minister-A" };
			await addNodeCards(recipe, options, identity, [
				{ goal: "甲活", acceptance: "存在: 产物.txt" },
				{ goal: "乙活", acceptance: "存在: 产物.txt" },
			]);
			await endDecomposition(recipe, options, identity);
			f.runner.scripts.set("0001", () => {
				writeFileSync(join(f.repo, "产物.txt"), "产物\n");
				return fakeReceipt("0001", "success", ["产物.txt"], f.repo);
			});
			f.runner.scripts.set("0002", () => fakeReceipt("0002", "failed", [], f.repo));
			const chain = await runAutoChain(recipe, options);
			// 工人数量:2 → 一批两卡都派;失败卡分型落失败,成功卡照常验收交卷
			expect(f.runner.runs).toHaveLength(2);
			const supervisor = f.runner.runs[0]?.supervisionRoute;
			expect(supervisor).toMatchObject({
				department: "测试",
				context: flow.脉络,
				sessionId: "minister-A",
				ownerSessionId: "owner",
				label: "v2并行/A/第1轮",
				target: "minister",
				binding: { source: "workflow", role: "main", target: "minister" },
			});
			expect(supervisor?.key).toContain(`${f.cardsDir}#卡卡0001`);
			expect(f.runner.registry.list().find((entry) => entry.card_no === "0001")).toMatchObject({
				supervisor_dept: "测试",
				supervisor_context: flow.脉络,
				supervisor_session: "minister-A",
				supervision_label: "v2并行/A/第1轮",
				supervision_owner: "owner",
				supervision_target: "minister",
			});
			expect(cardAt(f.cardsDir, "0001").frontmatter.status).toBe("delivered");
			expect(cardAt(f.cardsDir, "0002").frontmatter.status).toBe("failed");
			expect(chain.stopReason).toContain("0002");
			const firstSecondCard = chain.steps.findIndex((step) => step.cardRef === "卡0002" || step.cardRef === "0002");
			expect(firstSecondCard).toBeGreaterThan(0);
			expect(chain.steps.slice(firstSecondCard).every((step) => step.cardRef.endsWith("0002"))).toBe(true);
			expect(readControl(recipe, options).暂停).toBeUndefined();
		},
	);

	it("v2 单次推进卡数上限:只派满上限,余卡保留排队,续推恢复到完成", { timeout: 60_000 }, async () => {
		const f = setup(
			"v2上限",
			recipeYaml("v2上限", true, nodeYaml("A", "存在: 产物.txt", ["    工人数量: 2"])).replace(
				"---\n",
				"---\n版本: 2\n",
			),
		);
		const recipe = loadRecipe(f.paoHome, "v2上限");
		const options = { cardsDir: f.cardsDir, paoHome: f.paoHome, ownerSessionId: "owner", 运行器: f.runner };
		await startControl(recipe, {}, options);
		await bindMinister(recipe, options, "A", "minister-A");
		const flow = readControl(recipe, options);
		const identity = { 实例: flow.实例, 节点: "A", 轮次: 1, 部长会话: "minister-A" };
		await addNodeCards(recipe, options, identity, [
			{ goal: "甲活", acceptance: "存在: 产物.txt" },
			{ goal: "乙活", acceptance: "存在: 产物.txt" },
		]);
		await endDecomposition(recipe, options, identity);
		f.runner.scripts.set("0001", () => {
			writeFileSync(join(f.repo, "产物.txt"), "产物\n");
			return fakeReceipt("0001", "success", ["产物.txt"], f.repo);
		});
		f.runner.scripts.set("0002", () => {
			writeFileSync(join(f.repo, "产物2.txt"), "产物2\n");
			return fakeReceipt("0002", "success", ["产物2.txt"], f.repo);
		});
		const first = await runAutoChain(recipe, { ...options, maxCards: 1 });
		expect(f.runner.runs).toHaveLength(1);
		expect(first.stopReason).toContain("卡数上限");
		expect(cardAt(f.cardsDir, "0002").frontmatter.status).toBe("unclaimed");
		const second = await runAutoChain(recipe, options);
		expect(f.runner.runs).toHaveLength(2);
		expect(second.report.status).toBe("completed");
		expect(second.stopReason).toBeUndefined();
	});

	it("v2 人工门:节点交付后自动链停等确认且不偷跑,confirmControl 点头后续跑到完成", async () => {
		const f = setup(
			"v2门",
			recipeYaml("v2门", true, nodeYaml("A", "存在: 产物.txt", ["    人工确认: true"])).replace(
				"---\n",
				"---\n版本: 2\n",
			),
		);
		const recipe = loadRecipe(f.paoHome, "v2门");
		const options = { cardsDir: f.cardsDir, paoHome: f.paoHome, ownerSessionId: "owner", 运行器: f.runner };
		await startControl(recipe, {}, options);
		await bindMinister(recipe, options, "A", "minister-A");
		const flow = readControl(recipe, options);
		const identity = { 实例: flow.实例, 节点: "A", 轮次: 1, 部长会话: "minister-A" };
		await addNodeCards(recipe, options, identity, [{ goal: "甲活", acceptance: "存在: 产物.txt" }]);
		await endDecomposition(recipe, options, identity);
		f.runner.scripts.set("0001", () => {
			writeFileSync(join(f.repo, "产物.txt"), "产物\n");
			return fakeReceipt("0001", "success", ["产物.txt"], f.repo);
		});
		const held = await runAutoChain(recipe, options);
		expect(cardAt(f.cardsDir, "0001").frontmatter.status).toBe("delivered");
		expect(held.report.nodes[0].hold).toBe("等待人工确认");
		expect(held.waitingForEvent).toBeUndefined();
		// 未点头重复推仍停在门上,不重复派卡
		const again = await runAutoChain(recipe, options);
		expect(again.report.nodes[0].hold).toBe("等待人工确认");
		expect(f.runner.runs).toHaveLength(1);
		await confirmControl(recipe, options, "A", 1);
		const done = await runAutoChain(recipe, options);
		expect(done.report.status).toBe("completed");
		expect(done.stopReason).toBeUndefined();
		expect(done.waitingForEvent).toBeUndefined();
	});

	it("v2 正常等待部长拆卡时只标等待下级事件，不把 running 当主控裁定", async () => {
		const f = setup(
			"v2等待",
			recipeYaml("v2等待", true, nodeYaml("A", "存在: 产物.txt")).replace("---\n", "---\n版本: 2\n"),
		);
		const recipe = loadRecipe(f.paoHome, "v2等待");
		const options = { cardsDir: f.cardsDir, paoHome: f.paoHome, ownerSessionId: "owner", 运行器: f.runner };
		await startControl(recipe, {}, options);
		await bindMinister(recipe, options, "A", "minister-A");

		const chain = await runAutoChain(recipe, options);

		expect(chain.report.status).toBe("running");
		expect(chain.waitingForEvent).toBe(true);
		expect(chain.report.nodes[0].hold).toBe("等待部长本轮拆解结束");
		expect(chain.report.stop_reason).toBeUndefined();
		expect(chain.stopReason).toContain("等待部长拆卡、结束信号或节点判定");
	});

	it("owner 未裁决连续推流不乱派，pao_change_status 真实恢复并交卷后主链继续", { timeout: 60_000 }, async () => {
		// 模型和 worker 回执模拟；卡状态机、机械验收、owner 人工裁决与 Git 交卷真实运行。
		const f = setup(
			"owner恢复",
			recipeYaml("owner恢复", true, [
				...nodeYaml("A", "存在: 产物.txt"),
				...nodeYaml("B", "存在: 产物2.txt", ["    depends_on: [A]"]),
			]).replace("---\n", "---\n版本: 2\n"),
		);
		const recipe = loadRecipe(f.paoHome, "owner恢复");
		const options = { cardsDir: f.cardsDir, paoHome: f.paoHome, ownerSessionId: "owner", 运行器: f.runner };
		await startControl(recipe, {}, options);
		await bindMinister(recipe, options, "A", "minister-A");
		const flow = readControl(recipe, options);
		const identity = { 实例: flow.实例, 节点: "A", 轮次: 1, 部长会话: "minister-A" };
		const [aRef] = await addNodeCards(recipe, options, identity, [{ goal: "A任务", acceptance: "存在: 产物.txt" }]);
		await endDecomposition(recipe, options, identity);
		f.runner.scripts.set("0001", () => {
			writeFileSync(join(f.repo, "产物.txt"), "产物\n");
			return {
				...fakeReceipt("0001", "success", ["产物.txt"], f.repo),
				verification: [
					{ 条件: "人工核对甲", 结论: "not_run" as const },
					{ 条件: "人工核对乙", 结论: "not_run" as const },
					{ 条件: "人工核对丙", 结论: "not_run" as const },
				],
			};
		});

		const first = await runAutoChain(recipe, options);
		const repeated = await runAutoChain(recipe, options);
		expect(f.runner.runs).toHaveLength(1);
		expect(repeated.stopReason).toBe(first.stopReason);
		expect(repeated.stopReason).toContain("not_run 3");
		expect(repeated.stopReason).toContain("pao_change_status");
		expect(repeated.stopReason).toContain("accepted_deviations");
		expect(cardAt(f.cardsDir, "0001").frontmatter).toMatchObject({ status: "in_progress", attempt: 1 });
		expect(readControl(recipe, options).记录.filter((record) => record.事件 === "自动链停因")).toHaveLength(1);

		registerCardTools(f.captured.pi, { resolveCardsDir: () => f.cardsDir });
		const owner = cardAt(f.cardsDir, "0001").frontmatter.owner!;
		const receipt = cardAt(f.cardsDir, "0001").receipts.find(
			(item) => item.attempt === 1 && item.archive_flag === undefined,
		)!;
		await toolOf(f.captured, "pao_change_status").execute("owner-delivered", {
			card_ref: aRef,
			operator: owner,
			new_status: "delivered",
			basis: "owner 已逐项核对并接受三项未运行记录",
			accepted_deviations: receipt
				.verification!.map((item, verification_index) => ({ item, verification_index }))
				.filter(({ item }) => item.结论 === "fail" || item.结论 === "not_run")
				.map(({ item, verification_index }) => ({
					attempt: 1,
					verification_index,
					condition: item.条件,
					basis: `owner 已核对：${item.条件}`,
				})),
		});
		expect(cardAt(f.cardsDir, "0001").frontmatter).toMatchObject({ status: "delivered", attempt: 1 });
		expect((await readControlReport(readControl(recipe, options), options)).stop_reason).toBeUndefined();
		const delivered = await deliverCard(f.cardsDir, 1);
		expect(delivered.交卷).toBe(true);

		await bindMinister(recipe, options, "B", "minister-B");
		const next = readControl(recipe, options);
		const bIdentity = { 实例: next.实例, 节点: "B", 轮次: 1, 部长会话: "minister-B" };
		await addNodeCards(recipe, options, bIdentity, [{ goal: "B任务", acceptance: "存在: 产物2.txt" }]);
		await endDecomposition(recipe, options, bIdentity);
		f.runner.scripts.set("0002", () => {
			writeFileSync(join(f.repo, "产物2.txt"), "下游产物\n");
			return fakeReceipt("0002", "success", ["产物2.txt"], f.repo);
		});
		const resumed = await runAutoChain(recipe, options);
		expect(f.runner.runs).toHaveLength(2);
		expect(resumed.report.status).toBe("completed");
		expect(cardAt(f.cardsDir, "0002").frontmatter.status).toBe("delivered");
		expect(readControl(recipe, options).记录.some((record) => record.理由 === first.stopReason)).toBe(true);
	});

	it("旧实例未知版本:自动链明确拒绝恢复且控制正本原件逐字节保留", async () => {
		const f = setup(
			"v2旧版",
			recipeYaml("v2旧版", true, nodeYaml("A", "存在: 产物.txt")).replace("---\n", "---\n版本: 2\n"),
		);
		const recipe = loadRecipe(f.paoHome, "v2旧版");
		const options = { cardsDir: f.cardsDir, paoHome: f.paoHome, ownerSessionId: "owner", 运行器: f.runner };
		await startControl(recipe, {}, options);
		const controlFile = join(f.repo, ".pao", "任务A", "工作流实例-v2旧版.md");
		const corrupted = readFileSync(controlFile, "utf8").replace(/^版本: 2$/m, "版本: 3");
		writeFileSync(controlFile, corrupted);
		await expect(runAutoChain(recipe, options)).rejects.toThrow("旧实例或未知版本");
		// 链未修复、未覆盖、未删除：原件（含坏掉的版本号）原样保留给人工核对
		expect(readFileSync(controlFile, "utf8")).toBe(corrupted);
	});

	it("配方从 v1 升级为 v2 而旧 v1 清单仍在:拒绝按 v2 续跑,旧清单原件保留", async () => {
		const f = setup("升级流", recipeYaml("升级流", false, nodeYaml("A", "存在: 产物.txt")));
		const startFlow = toolOf(f.captured, "pao_start_flow");
		await startFlow.execute("t1", { name: "升级流" });
		// 配方文件升级为 v2；盘上仍是 v1 旧清单（同名文件,版本判断是唯一甄别手段）
		writeRecipe(
			f.paoHome,
			"升级流",
			recipeYaml("升级流", true, nodeYaml("A", "存在: 产物.txt")).replace("---\n", "---\n版本: 2\n"),
		);
		const recipe = loadRecipe(f.paoHome, "升级流");
		expect(recipe.版本).toBe(2);
		const manifestFile = join(f.repo, ".pao", "任务A", "工作流实例-升级流.md");
		const before = readFileSync(manifestFile, "utf8");
		await expect(
			runAutoChain(recipe, { cardsDir: f.cardsDir, paoHome: f.paoHome, ownerSessionId: "owner", 运行器: f.runner }),
		).rejects.toThrow("旧实例或未知版本");
		expect(readFileSync(manifestFile, "utf8")).toBe(before);
	});

	it("硬约束:配方无 自动执行 字段时启流/推流只落卡不派发(与旧手动链一致)", async () => {
		const f = setup("手动", recipeYaml("手动", false, nodeYaml("A", "存在: 产物.txt")));
		const startFlow = toolOf(f.captured, "pao_start_flow");
		const result = await startFlow.execute("t1", { name: "手动" });
		expect(textOf(result)).toContain("工作流「手动」状态");
		expect(f.runner.runs.length).toBe(0);
		const pushStream = toolOf(f.captured, "pao_push_flow");
		await pushStream.execute("t2", { name: "手动" });
		expect(f.runner.runs.length).toBe(0);
		const card = cardAt(f.cardsDir, "0001");
		expect(card.frontmatter.status).toBe("unclaimed");
	});

	it("单卡全链:启流即自动 派发→回执→越界干净→验收过→交卷 commit→流已完成", async () => {
		const f = setup("单卡", recipeYaml("单卡", true, nodeYaml("A", "存在: 产物.txt")));
		f.scriptDefault(["产物.txt"]);
		const accepted = textOf(await toolOf(f.captured, "pao_start_flow").execute("t1", { name: "单卡" }));
		expect(accepted).toContain("后台推进");
		await settleChains(f);
		const notice = chainNotice(f); // S6:终局全文经链通知注入（原同步返回文本的承载面）
		expect(notice).toContain("状态：completed");
		expect(f.runner.runs.length).toBe(1);
		expect(f.runner.runs[0]!.派单理由).toContain("工作流自动链:单卡/A");
		const card = cardAt(f.cardsDir, "0001");
		expect(card.frontmatter.status).toBe("delivered");
		expect(card.body).toContain("## 机械验收");
		const log = commits(f.repo);
		expect(log.length).toBe(2);
		expect(log[0]).toContain("卡0001");
		expect(log[0]).toContain("delivered · 机械验收通过");
		expect(git(f.repo, ["show", "--name-only", "--format=", "HEAD"]).trim()).toContain("产物.txt");
		const manifest = readFileSync(join(f.repo, ".pao", "任务A", "工作流实例-单卡.md"), "utf8");
		expect(manifest).toContain("状态: 已完成");
	});

	// 两卡包含真实 Git 快照、验收及提交，使用独立集成预算，保留全部状态和提交断言。
	it("串行两节点:A 交付解锁 B,两卡都自动跑完并各自 commit", { timeout: 60_000 }, async () => {
		const f = setup(
			"串行",
			recipeYaml("串行", true, [
				...nodeYaml("A", "存在: 产物.txt"),
				...nodeYaml("B", "存在: 产物2.txt", ["    depends_on: [A]"]),
			]),
		);
		f.scriptDefault(["产物.txt"]);
		f.runner.scripts.set("0002", () => {
			writeFileSync(join(f.repo, "产物2.txt"), "产物2\n");
			return fakeReceipt("0002", "success", ["产物2.txt"], f.repo);
		});
		await toolOf(f.captured, "pao_start_flow").execute("t1", { name: "串行" });
		await settleChains(f);
		expect(chainNotice(f)).toContain("状态：completed");
		expect(f.runner.runs.length).toBe(2);
		expect(cardAt(f.cardsDir, "0001").frontmatter.status).toBe("delivered");
		expect(cardAt(f.cardsDir, "0002").frontmatter.status).toBe("delivered");
		const log = commits(f.repo);
		expect(log.length).toBe(3);
		expect(log[1]).toContain("卡0001");
		expect(log[0]).toContain("卡0002");
	});

	it("分叉(同层两节点):一次启流两卡都被自动跑完,各自交付 commit,流已完成", { timeout: 60_000 }, async () => {
		const f = setup(
			"分叉",
			recipeYaml("分叉", true, [
				...nodeYaml("A", "存在: 产物.txt"),
				...nodeYaml("B", "存在: 产物2.txt"), // 同层无依赖——分叉两支
			]),
		);
		f.runner.scripts.set("0001", () => {
			writeFileSync(join(f.repo, "产物.txt"), "产物\n");
			return fakeReceipt("0001", "success", ["产物.txt"], f.repo);
		});
		f.runner.scripts.set("0002", () => {
			writeFileSync(join(f.repo, "产物2.txt"), "产物2\n");
			return fakeReceipt("0002", "success", ["产物2.txt"], f.repo);
		});
		await toolOf(f.captured, "pao_start_flow").execute("t1", { name: "分叉" });
		await settleChains(f);
		expect(chainNotice(f)).toContain("状态：completed");
		expect(f.runner.runs.length).toBe(2); // 两支都跑,不只跑一条
		expect(cardAt(f.cardsDir, "0001").frontmatter.status).toBe("delivered");
		expect(cardAt(f.cardsDir, "0002").frontmatter.status).toBe("delivered");
		const log = commits(f.repo);
		expect(log.length).toBe(3); // 基线＋两卡各一笔
		expect(log.join("\n")).toContain("卡0001");
		expect(log.join("\n")).toContain("卡0002");
	});

	it("汇合(双上游):C 等 A、B 都交付才解锁跑;此前不被提前派发", { timeout: 90_000 }, async () => {
		const f = setup(
			"汇合",
			recipeYaml("汇合", true, [
				...nodeYaml("A", "存在: 产物.txt"),
				...nodeYaml("B", "存在: 产物2.txt"),
				...nodeYaml("C", "存在: 产物3.txt", ["    depends_on: [A, B]"]),
			]),
		);
		f.runner.scripts.set("0001", () => {
			writeFileSync(join(f.repo, "产物.txt"), "产物\n");
			return fakeReceipt("0001", "success", ["产物.txt"], f.repo);
		});
		f.runner.scripts.set("0002", () => {
			writeFileSync(join(f.repo, "产物2.txt"), "产物2\n");
			return fakeReceipt("0002", "success", ["产物2.txt"], f.repo);
		});
		f.runner.scripts.set("0003", () => {
			writeFileSync(join(f.repo, "产物3.txt"), "产物3\n");
			return fakeReceipt("0003", "success", ["产物3.txt"], f.repo);
		});
		await toolOf(f.captured, "pao_start_flow").execute("t1", { name: "汇合" });
		await settleChains(f);
		expect(chainNotice(f)).toContain("状态：completed");
		expect(f.runner.runs.length).toBe(3);
		// 汇合证明:C(卡0003)最后跑——若被提前派发,依赖闸会拒（此时 A/B 未交付）
		expect(f.runner.runs[2]!.卡号).toBe("0003");
		expect(cardAt(f.cardsDir, "0003").frontmatter.status).toBe("delivered");
		const log = commits(f.repo);
		expect(log.length).toBe(4); // 基线＋三卡各一笔
		expect(log[0]).toContain("卡0003");
	});

	it("汇合失败分支:A 成功 B 失败→C 挂起不跑(失败即停),链停因如实", { timeout: 60_000 }, async () => {
		const f = setup(
			"汇合失败",
			recipeYaml("汇合失败", true, [
				...nodeYaml("A", "存在: 产物.txt"),
				...nodeYaml("B", "存在: 产物2.txt"),
				...nodeYaml("C", "存在: 产物3.txt", ["    depends_on: [A, B]"]),
			]),
		);
		f.runner.scripts.set("0001", () => {
			writeFileSync(join(f.repo, "产物.txt"), "产物\n");
			return fakeReceipt("0001", "success", ["产物.txt"], f.repo);
		});
		f.runner.scripts.set("0002", () => fakeReceipt("0002", "failed", [], f.repo));
		f.runner.scripts.set("0003", () => {
			throw new Error("C 不应被派发——B 失败后 C 必须挂起");
		});
		await toolOf(f.captured, "pao_start_flow").execute("t1", { name: "汇合失败" });
		await settleChains(f);
		const notice = chainNotice(f);
		expect(notice).toContain("自动链停因");
		expect(f.runner.runs.length).toBe(2); // 只有 A、B 跑了
		expect(cardAt(f.cardsDir, "0002").frontmatter.status).toBe("failed");
		// C 挂起＝卡根本不落盘（R36「失败/取消叶节点立即挂起」口径），不是落了卡等认领
		expect(existsSync(join(f.cardsDir, "卡0003-C.md"))).toBe(false);
		expect(notice).toContain("C"); // 实例清单如实报告挂起节点
		expect(notice).not.toContain("C 不应被派发");
	});

	it("回执失败:卡如实落失败(带分型依据),下游按失败即停挂起,零 commit", async () => {
		const f = setup(
			"失败停",
			recipeYaml("失败停", true, [
				...nodeYaml("A", "存在: 产物.txt"),
				...nodeYaml("B", "存在: 产物2.txt", ["    depends_on: [A]"]),
			]),
		);
		f.runner.scripts.set("0001", () => fakeReceipt("0001", "failed", [], f.repo));
		await toolOf(f.captured, "pao_start_flow").execute("t1", { name: "失败停" });
		await settleChains(f);
		expect(chainNotice(f)).toContain("回执失败");
		const card = cardAt(f.cardsDir, "0001");
		expect(card.frontmatter.status).toBe("failed");
		expect(card.body).toContain("失败类型: transient");
		expect(card.body).toContain("自动链如实落失败");
		expect(existsSync(join(f.cardsDir, "卡0002"))).toBe(false);
		expect(commits(f.repo).length).toBe(1);
		const manifest = readFileSync(join(f.repo, ".pao", "任务A", "工作流实例-失败停.md"), "utf8");
		expect(manifest).toContain("挂起");
	});

	it("回执落卡失败(声明产物不存在):按结果未知落失败,不伪造", async () => {
		const f = setup("落卡败", recipeYaml("落卡败", true, nodeYaml("A", "存在: 产物.txt")));
		f.runner.scripts.set("0001", () => fakeReceipt("0001", "success", ["根本没写.txt"], f.repo));
		await toolOf(f.captured, "pao_start_flow").execute("t1", { name: "落卡败" });
		await settleChains(f);
		expect(chainNotice(f)).toContain("回执无效");
		const card = cardAt(f.cardsDir, "0001");
		expect(card.frontmatter.status).toBe("failed");
		expect(card.body).toContain("失败类型: unknown_outcome");
		expect(card.body).toContain("回执落卡失败");
		expect(commits(f.repo).length).toBe(1);
	});

	it("越界(做了没说):git 真值有而回执没声明,卡落失败,改动不 commit", async () => {
		const f = setup("越界", recipeYaml("越界", true, nodeYaml("A", "存在: 产物.txt")));
		f.runner.scripts.set("0001", () => {
			writeFileSync(join(f.repo, "产物.txt"), "产物\n");
			writeFileSync(join(f.repo, "偷写.txt"), "偷写\n");
			return fakeReceipt("0001", "success", ["产物.txt"], f.repo);
		});
		await toolOf(f.captured, "pao_start_flow").execute("t1", { name: "越界" });
		await settleChains(f);
		expect(chainNotice(f)).toContain("越界核查 越界");
		const card = cardAt(f.cardsDir, "0001");
		expect(card.frontmatter.status).toBe("failed");
		expect(card.body).toContain("失败类型: unknown_outcome");
		expect(commits(f.repo).length).toBe(1);
	});

	it("虚报(说了没做):声明已存在但非本卡改动的文件,卡落失败", async () => {
		const f = setup("虚报", recipeYaml("虚报", true, nodeYaml("A", "存在: 已跟踪.txt")));
		f.runner.scripts.set("0001", () => fakeReceipt("0001", "success", ["已跟踪.txt"], f.repo));
		await toolOf(f.captured, "pao_start_flow").execute("t1", { name: "虚报" });
		await settleChains(f);
		expect(chainNotice(f)).toContain("越界核查 虚报");
		const card = cardAt(f.cardsDir, "0001");
		expect(card.frontmatter.status).toBe("failed");
		expect(commits(f.repo).length).toBe(1);
	});

	it("机械验收未过:当前尝试显式落失败并保留验收证据,不交卷", async () => {
		const f = setup("验未过", recipeYaml("验未过", true, nodeYaml("A", "存在: 没有.txt")));
		f.runner.scripts.set("0001", () => fakeReceipt("0001", "success", [], f.repo));
		await toolOf(f.captured, "pao_start_flow").execute("t1", { name: "验未过" });
		await settleChains(f);
		const notice = chainNotice(f);
		expect(notice).toContain("未过");
		expect(notice).toContain("已落失败态");
		const card = cardAt(f.cardsDir, "0001");
		expect(card.frontmatter.status).toBe("failed");
		expect(card.frontmatter.attempt).toBe(1);
		expect(card.body).toContain("失败类型: unknown_outcome");
		expect(card.body).toContain("机械验收未过");
		expect(card.body).toContain("[存在] 没有.txt → 未过");
		expect(card.receipts).toHaveLength(1);
		expect(commits(f.repo).length).toBe(1);
	});

	it("混人话句:验收全过停人工审,不自动交付不交卷", async () => {
		const f = setup("人话句", recipeYaml("人话句", true, nodeYaml("A", "存在: 产物.txt\\n人工看质量")));
		f.scriptDefault(["产物.txt"]);
		await toolOf(f.captured, "pao_start_flow").execute("t1", { name: "人话句" });
		await settleChains(f);
		expect(chainNotice(f)).toContain("全过停人工审");
		const card = cardAt(f.cardsDir, "0001");
		expect(card.frontmatter.status).toBe("in_progress");
		expect(commits(f.repo).length).toBe(1);
	});

	it("仅机械全过停人工审时请求负责部长；pass 仍走原交付与交卷路径", async () => {
		const f = setup("部长审", recipeYaml("部长审", true, nodeYaml("A", "存在: 产物.txt\\n人工看质量")));
		f.scriptDefault(["产物.txt"]);
		const recipe = loadRecipe(f.paoHome, "部长审");
		let observed: unknown;
		const options = {
			cardsDir: f.cardsDir,
			paoHome: f.paoHome,
			运行器: f.runner,
			onReviewRequired: (event: AutoChainReviewEvent) => {
				observed = event;
				return { result: "pass" as const, basis: "部长已核对真实产物与质量句" };
			},
		};
		await startWorkflow(recipe, {}, options);
		const chain = await runAutoChain(recipe, options);
		expect(chain.stopReason).toBeUndefined();
		expect(observed).toMatchObject({
			node: "A",
			cardRef: "卡0001",
			attempt: 1,
			requirements: ["人工看质量"],
			unmetReports: [],
			artifactPaths: ["产物.txt"],
		});
		expect(chain.steps.map((step) => step.note).join("\n")).toContain(
			"部长审核 pass:部长已核对真实产物与质量句；进入原交卷路径",
		);
		const card = cardAt(f.cardsDir, "0001");
		expect(card.frontmatter.status).toBe("delivered");
		expect(card.body).toContain("依据: 部长审核通过：部长已核对真实产物与质量句");
		expect(commits(f.repo).length).toBe(2);
	});

	it.each([
		["fail", "pass"],
		["fail", "hold"],
		["not_run", "pass"],
		["not_run", "hold"],
	] as const)("工人自检 %s 时交主控裁决，不创建部长请求或消费其 %s", async (selfResult, ministerResult) => {
		const name = `自检${selfResult}${ministerResult}`;
		const f = setup(name, recipeYaml(name, true, nodeYaml("A", "存在: 产物.txt\\n人工看质量")));
		f.runner.scripts.set("0001", () => {
			writeFileSync(join(f.repo, "产物.txt"), "产物\n");
			return {
				...fakeReceipt("0001", "success", ["产物.txt"], f.repo),
				verification: [{ 条件: "工人负责的自检", 结论: selfResult, 证据: "模拟未达回执" }],
			};
		});
		const recipe = loadRecipe(f.paoHome, name);
		const review = vi.fn(() => ({ result: ministerResult, basis: "不应请求部长代放行" }));
		const options = { cardsDir: f.cardsDir, paoHome: f.paoHome, 运行器: f.runner, onReviewRequired: review };
		await startWorkflow(recipe, {}, options);
		const chain = await runAutoChain(recipe, options);
		expect(review).not.toHaveBeenCalled();
		expect(chain.stopReason).toContain("未创建部长审核请求");
		expect(chain.stopReason).toContain("accepted_deviations");
		expect(chain.stopReason).not.toContain("部长审核 hold");
		expect(cardAt(f.cardsDir, "0001").frontmatter).toMatchObject({ status: "in_progress", attempt: 1 });
		expect(cardAt(f.cardsDir, "0001").receipts[0].verification?.[0]).toMatchObject({
			条件: "工人负责的自检",
			结论: selfResult,
		});
		expect(commits(f.repo).length).toBe(1);
	});

	it("部长 pass 后重读卡并重跑原机械审核；机械条件失效时不交付", async () => {
		const f = setup("部长复验", recipeYaml("部长复验", true, nodeYaml("A", "存在: 产物.txt\\n人工看质量")));
		f.scriptDefault(["产物.txt"]);
		const recipe = loadRecipe(f.paoHome, "部长复验");
		const options = {
			cardsDir: f.cardsDir,
			paoHome: f.paoHome,
			运行器: f.runner,
			onReviewRequired: () => {
				rmSync(join(f.repo, "产物.txt"));
				return { result: "pass" as const, basis: "部长只给出质量判断" };
			},
		};
		await startWorkflow(recipe, {}, options);
		const chain = await runAutoChain(recipe, options);
		expect(chain.stopReason).toContain("部长审核 pass 未通过原机械审核");
		expect(cardAt(f.cardsDir, "0001").frontmatter.status).toBe("in_progress");
		expect(commits(f.repo).length).toBe(1);
	});

	it("全停期间部长返回 pass 也不会越过尝试或推进交付", async () => {
		const f = setup(
			"审核全停",
			recipeYaml("审核全停", true, nodeYaml("A", "存在: 产物.txt\\n人工看质量")).replace("---\n", "---\n版本: 2\n"),
		);
		f.scriptDefault(["产物.txt"]);
		const recipe = loadRecipe(f.paoHome, "审核全停");
		const options = {
			cardsDir: f.cardsDir,
			paoHome: f.paoHome,
			ownerSessionId: "owner",
			运行器: f.runner,
			onReviewRequired: async () => {
				await f.runner.stopAll();
				return { result: "pass" as const, basis: "全停后迟到的部长判定" };
			},
		};
		await startControl(recipe, {}, options);
		await bindMinister(recipe, options, "A", "minister-A");
		const flow = readControl(recipe, options);
		const identity = { 实例: flow.实例, 节点: "A", 轮次: 1, 部长会话: "minister-A" };
		await addNodeCards(recipe, options, identity, [{ goal: "A任务", acceptance: "存在: 产物.txt\n人工看质量" }]);
		await endDecomposition(recipe, options, identity);
		const chain = await runAutoChain(recipe, options);
		expect(chain.stopReason).toContain("执行器已全停");
		expect(chain.steps.at(-1)?.note).toContain("全过停人工审");
		expect(cardAt(f.cardsDir, "0001").frontmatter.status).toBe("in_progress");
		expect(commits(f.repo).length).toBe(1);
		const saved = readControl(recipe, options);
		expect(saved.记录.at(-1)).toMatchObject({
			事件: "自动链停因",
			理由: expect.stringContaining("执行器已全停"),
		});
	});

	it("后台部长审核等待期间全停：signal 中止、保留卡与停因、在途计数归零且不再通知", async () => {
		const f = setup(
			"审核等待全停",
			recipeYaml("审核等待全停", true, [
				"  - 名字: A",
				"    目标: A任务",
				"    部门: 测试",
				"    验收: |-",
				"      存在: 产物.txt",
				"      人工看质量",
			]).replace("---\n", "---\n版本: 2\n"),
		);
		const toast = vi.spyOn(toastModule, "sendToast").mockResolvedValue(undefined);
		const eventSignal = f.runner.stopSignal;
		try {
			const recipe = loadRecipe(f.paoHome, "审核等待全停");
			const options = { cardsDir: f.cardsDir, paoHome: f.paoHome, ownerSessionId: "owner", 运行器: f.runner };
			await startControl(recipe, {}, options);
			await bindMinister(recipe, options, "A", "minister-A");
			const flow = readControl(recipe, options);
			const identity = { 实例: flow.实例, 节点: "A", 轮次: 1, 部长会话: "minister-A" };
			await addNodeCards(recipe, options, identity, [{ goal: "A任务", acceptance: "存在: 产物.txt\n人工看质量" }]);
			await endDecomposition(recipe, options, identity);
			f.scriptDefault(["产物.txt"]);
			let reviewEntered!: () => void;
			const waiting = new Promise<void>((resolveReviewEntered) => {
				reviewEntered = resolveReviewEntered;
				f.face!.accept(
					recipe,
					{
						...options,
						onReviewRequired: async () => {
							reviewEntered();
							// 故意忽略 signal，证明自动链自己会中止等待，不依赖桥接实现永久 pending。
							await new Promise<void>(() => {});
							return { result: "pass", basis: "迟到的判定" };
						},
					},
					undefined,
					false,
				);
			});
			await waiting;
			expect(eventSignal.aborted).toBe(false);
			expect(f.face!.backgroundCount()).toEqual({ inFlight: 1 });
			const stopped = f.runner.stopAll();
			expect(eventSignal.aborted).toBe(true);
			await stopped;
		} finally {
			await f.face!.waitForAutoChain();
			toast.mockRestore();
		}
		expect(f.face!.backgroundCount()).toEqual({ inFlight: 0 });
		expect(cardAt(f.cardsDir, "0001").frontmatter.status).toBe("in_progress");
		const persistedOptions = { cardsDir: f.cardsDir, ownerSessionId: "owner" };
		const control = readControl(loadRecipe(f.paoHome, "审核等待全停"), persistedOptions);
		expect(control.状态).toBe("运行中");
		expect(control.记录.at(-1)).toMatchObject({
			事件: "自动链停因",
			理由: expect.stringContaining("执行器已全停"),
		});
		expect(f.captured.messages).toEqual([]);
		expect(toast).not.toHaveBeenCalled();
	});

	it.each([
		["部长停", { result: "hold", basis: "质量证据不足" }],
		["部长坏", { result: "pass", basis: "" }],
	] as const)("负责人要求 %s 时保持进行中且不交卷", async (name, decision) => {
		const f = setup(name, recipeYaml(name, true, nodeYaml("A", "存在: 产物.txt\\n人工看质量")));
		f.scriptDefault(["产物.txt"]);
		const recipe = loadRecipe(f.paoHome, name);
		const options = {
			cardsDir: f.cardsDir,
			paoHome: f.paoHome,
			运行器: f.runner,
			onReviewRequired: () => decision,
		};
		await startWorkflow(recipe, {}, options);
		const chain = await runAutoChain(recipe, options);
		expect(chain.stopReason).toContain(decision.basis ? "部长审核 hold" : "部长审核结果无效");
		expect(cardAt(f.cardsDir, "0001").frontmatter.status).toBe("in_progress");
		expect(commits(f.repo).length).toBe(1);
	});

	it("验收未过时卡已被并发改为交付，自动链只停审，不回退终态或覆盖回执", async () => {
		const f = setup("终态保护", recipeYaml("终态保护", true, nodeYaml("A", "存在: 不存在.txt")));
		let originalReceipt: WorkerReceipt | undefined;
		f.runner.scripts.set("0001", () => {
			originalReceipt = fakeReceipt("0001", "success", [], f.repo);
			const claimed = cardAt(f.cardsDir, "0001");
			changeCardStatus(claimed, {
				操作者: claimed.frontmatter.owner ?? "主控",
				to: "delivered",
				依据: "模拟验收前并发人工交付",
				时间: "2026-10-22 15:00",
			});
			return originalReceipt;
		});
		const recipe = loadRecipe(f.paoHome, "终态保护");
		const options = { cardsDir: f.cardsDir, paoHome: f.paoHome, 运行器: f.runner };
		await startWorkflow(recipe, {}, options);
		const chain = await runAutoChain(recipe, options);
		const card = cardAt(f.cardsDir, "0001");
		expect(chain.stopReason).toContain("保留现状");
		expect(card.frontmatter.status).toBe("delivered");
		expect(card.frontmatter.attempt).toBe(1);
		expect(card.receipts).toHaveLength(1);
		expect(card.receipts[0]).toMatchObject({ result: "success", attempt: 1 });
		expect(card.body).not.toContain("失败类型: unknown_outcome");
		expect(originalReceipt).toBeDefined();
	});

	it.each([
		["机械失败", "存在: 不存在.txt", false],
		["安检拦截", "跑: powershell -Command 'exit 0'", false],
		["无法核对", "存在: 产物.txt", true],
	] as const)("%s：按实际核查状态停止，不请求部长判断", async (name, acceptance, destroyBaseline) => {
		const f = setup(name, recipeYaml(name, true, nodeYaml("A", acceptance)));
		f.runner.scripts.set("0001", () => {
			writeFileSync(join(f.repo, "产物.txt"), "产物\n");
			if (destroyBaseline) rmSync(join(f.repo, ".pao", "任务A", "基线", "卡0001-基线.txt"));
			return fakeReceipt("0001", "success", ["产物.txt"], f.repo);
		});
		const recipe = loadRecipe(f.paoHome, name);
		let calls = 0;
		const options = {
			cardsDir: f.cardsDir,
			paoHome: f.paoHome,
			运行器: f.runner,
			onReviewRequired: () => {
				calls++;
				return { result: "pass" as const, basis: "不应被调用" };
			},
		};
		await startWorkflow(recipe, {}, options);
		await runAutoChain(recipe, options);
		expect(calls, name).toBe(0);
		expect(cardAt(f.cardsDir, "0001").frontmatter.status, name).toBe(name === "无法核对" ? "in_progress" : "failed");
	});

	it("人工门节点:交付交卷照常,下游等确认;确认流点头后自动续跑至完成", { timeout: 60_000 }, async () => {
		const f = setup(
			"人工门",
			recipeYaml("人工门", true, [
				...nodeYaml("A", "存在: 产物.txt", ["    人工确认: true"]),
				...nodeYaml("B", "存在: 产物2.txt", ["    depends_on: [A]"]),
			]),
		);
		f.scriptDefault(["产物.txt"]);
		f.runner.scripts.set("0002", () => {
			writeFileSync(join(f.repo, "产物2.txt"), "产物2\n");
			return fakeReceipt("0002", "success", ["产物2.txt"], f.repo);
		});
		await toolOf(f.captured, "pao_start_flow").execute("t1", { name: "人工门" });
		await settleChains(f);
		expect(chainNotice(f)).toContain("等待人工确认");
		expect(f.runner.runs.length).toBe(1);
		expect(cardAt(f.cardsDir, "0001").frontmatter.status).toBe("delivered");
		expect(existsSync(join(f.cardsDir, "卡0002"))).toBe(false);
		const confirm = textOf(await toolOf(f.captured, "pao_confirm_flow").execute("t2", { name: "人工门", node: "A" }));
		expect(confirm).toContain("后台推进");
		await settleChains(f);
		expect(chainNotice(f)).toContain("状态：completed");
		expect(f.runner.runs.length).toBe(2);
		expect(cardAt(f.cardsDir, "0002").frontmatter.status).toBe("delivered");
		expect(commits(f.repo).length).toBe(3);
	});

	it("越界无法核对(基线快照被毁):不落失败,链停留 owner 裁决", async () => {
		const f = setup("无基线", recipeYaml("无基线", true, nodeYaml("A", "存在: 产物.txt")));
		f.runner.scripts.set("0001", () => {
			writeFileSync(join(f.repo, "产物.txt"), "产物\n");
			// worker 脚本毁掉认领基线快照,制造「无法核对」(环境问题≠worker 罪证)
			rmSync(join(f.repo, ".pao", "任务A", "基线", "卡0001-尝试1-基线.json"));
			return fakeReceipt("0001", "success", ["产物.txt"], f.repo);
		});
		await toolOf(f.captured, "pao_start_flow").execute("t1", { name: "无基线" });
		await settleChains(f);
		const notice = chainNotice(f);
		expect(notice).toContain("无法核对");
		expect(notice).toContain("留 owner");
		const card = cardAt(f.cardsDir, "0001");
		expect(card.frontmatter.status).toBe("in_progress"); // 不自动定罪
		expect(commits(f.repo).length).toBe(1);
	});

	it("部门并发上限满:派发被拒链停,卡留待认领零 commit,清名额后续跑可恢复", async () => {
		const f = setup("并发满", recipeYaml("并发满", true, nodeYaml("A", "存在: 产物.txt")));
		f.scriptDefault(["产物.txt"]);
		// 预占满同部门 3 个活名额(缺省部门并发上限 3,无保温文件照样生效)
		for (let i = 1; i <= 3; i++) {
			f.runner.registry.register({
				pid: 800000 + i,
				card_no: `占位${i}`,
				command: "占位",
				dept: "测试",
			});
		}
		await toolOf(f.captured, "pao_start_flow").execute("t1", { name: "并发满" });
		await settleChains(f);
		const notice = chainNotice(f);
		expect(notice).toContain("派发异常");
		expect(notice).toContain("部门并发上限");
		expect(f.runner.runs.length).toBe(0);
		const card = cardAt(f.cardsDir, "0001");
		expect(card.frontmatter.status).toBe("unclaimed");
		expect(commits(f.repo).length).toBe(1);
	});

	// S6 语义变更（§S6 第 3 条）:工具 signal 不接后台链（pao_dispatch_card 先例）——工具受理即返,
	// worker 期间触发的取消信号不再中断链,取消在途走停止链（pao_terminate_card/pao_stop_background）。
	// 「信号中止链」的原断言保留在直调 runAutoChain 面（下一测试）,不放松。
	it("S6 工具 signal 不接后台链:worker 期间取消信号不拦链,受理后照常验收交付", async () => {
		const f = setup("回执取消", recipeYaml("回执取消", true, nodeYaml("A", "存在: 产物.txt")));
		const controller = new AbortController();
		f.runner.scripts.set("0001", () => {
			writeFileSync(join(f.repo, "产物.txt"), "真实工作产物保留");
			controller.abort();
			return fakeReceipt("0001", "success", ["产物.txt"], f.repo);
		});
		const result = await toolOf(f.captured, "pao_start_flow").execute(
			"cancel",
			{ name: "回执取消" },
			controller.signal,
		);
		expect(textOf(result)).toContain("后台推进");
		await settleChains(f);
		expect(cardAt(f.cardsDir, "0001").frontmatter.status).toBe("delivered");
		expect(cardAt(f.cardsDir, "0001").body).toContain("## 机械验收");
		expect(commits(f.repo).length).toBe(2);
	});

	it("直调 runAutoChain 的 signal 语义保持:worker 期间中止→不验收不交付(同步链仍接信号)", async () => {
		const f = setup("直取消", recipeYaml("直取消", true, nodeYaml("A", "存在: 产物.txt")));
		await startWorkflow(loadRecipe(f.paoHome, "直取消"), {}, { cardsDir: f.cardsDir });
		const controller = new AbortController();
		f.runner.scripts.set("0001", () => {
			writeFileSync(join(f.repo, "产物.txt"), "真实工作产物保留");
			controller.abort();
			return fakeReceipt("0001", "success", ["产物.txt"], f.repo);
		});
		await expect(
			runAutoChain(loadRecipe(f.paoHome, "直取消"), {
				cardsDir: f.cardsDir,
				运行器: f.runner,
				paoHome: f.paoHome,
				signal: controller.signal,
			}),
		).rejects.toThrow();
		expect(cardAt(f.cardsDir, "0001").frontmatter.status).toBe("in_progress");
		expect(cardAt(f.cardsDir, "0001").body).not.toContain("## 机械验收");
		expect(commits(f.repo).length).toBe(1);
	});

	it("取消:预中止信号直接抛 AbortError,卡不动零派发", async () => {
		const f = setup("取消", recipeYaml("取消", true, nodeYaml("A", "存在: 产物.txt")));
		f.scriptDefault(["产物.txt"]);
		await toolOf(f.captured, "pao_start_flow").execute("t1", { name: "取消" });
		await settleChains(f); // 后台链收敛后再验,避免与直调并发
		// 启流已启动流(首卡已落);模拟一次被中止的续跑
		const recipe = loadRecipe(f.paoHome, "取消");
		const controller = new AbortController();
		controller.abort();
		await expect(
			runAutoChain(recipe, {
				cardsDir: f.cardsDir,
				运行器: f.runner,
				paoHome: f.paoHome,
				signal: controller.signal,
			}),
		).rejects.toThrow();
		expect(f.runner.runs.length).toBe(1); // 启流那次,取消的续跑零派发
		expect(cardAt(f.cardsDir, "0001").frontmatter.status).toBe("delivered");
	});

	it("人工门停流触发 toast 叫人；失败停流也叫（S6 修正:后台化后在场假设失效）", async () => {
		const f = setup(
			"门提醒",
			recipeYaml("门提醒", true, [
				...nodeYaml("A", "存在: 产物.txt", ["    人工确认: true"]),
				...nodeYaml("B", "存在: 产物2.txt", ["    depends_on: [A]"]),
			]),
		);
		f.scriptDefault(["产物.txt"]);
		const toast = vi.spyOn(toastModule, "sendToast").mockResolvedValue(undefined);
		await toolOf(f.captured, "pao_start_flow").execute("t1", { name: "门提醒" });
		await settleChains(f);
		expect(chainNotice(f)).toContain("等待人工确认");
		expect(toast).toHaveBeenCalledTimes(1);
		expect(toast.mock.calls[0]![0]).toContain("停下等人");
		expect(toast.mock.calls[0]![1]).toContain("等待人工确认");
		toast.mockRestore();

		// 失败即停也叫（S6:终局在后台,不在场者经 toast 得知失败,不能只等下一轮注入）
		const g = setup("败提醒", recipeYaml("败提醒", true, nodeYaml("A", "存在: 产物.txt")));
		g.runner.scripts.set("0001", () => fakeReceipt("0001", "failed", [], g.repo));
		const failureToast = vi.spyOn(toastModule, "sendToast").mockResolvedValue(undefined);
		await toolOf(g.captured, "pao_start_flow").execute("t1", { name: "败提醒" });
		await settleChains(g);
		expect(chainNotice(g)).toContain("回执失败");
		expect(failureToast).toHaveBeenCalledTimes(1);
		expect(failureToast.mock.calls[0]![0]).toContain("失败停链");
		expect(failureToast.mock.calls[0]![1]).toContain("失败");
		failureToast.mockRestore();
	});

	it("机械验收落失败停流也触发 toast 叫人", async () => {
		const f = setup("审提醒", recipeYaml("审提醒", true, nodeYaml("A", "存在: 没有.txt")));
		f.runner.scripts.set("0001", () => fakeReceipt("0001", "success", [], f.repo));
		const toast = vi.spyOn(toastModule, "sendToast").mockResolvedValue(undefined);
		await toolOf(f.captured, "pao_start_flow").execute("t1", { name: "审提醒" });
		await settleChains(f);
		expect(chainNotice(f)).toContain("已落失败态");
		expect(toast).toHaveBeenCalledTimes(1);
		expect(toast.mock.calls[0]![1]).toContain("已落失败态");
		toast.mockRestore();
	});

	it("命令面 confirm 与工具面同口径:自动执行配方点头后自动链续跑", async () => {
		resetPaoSubcommandsForTest();
		const f = setup(
			"门命令",
			recipeYaml("门命令", true, [
				...nodeYaml("A", "存在: 产物.txt", ["    人工确认: true"]),
				...nodeYaml("B", "存在: 产物2.txt", ["    depends_on: [A]"]),
			]),
		);
		f.scriptDefault(["产物.txt"]);
		f.runner.scripts.set("0002", () => {
			writeFileSync(join(f.repo, "产物2.txt"), "产物2\n");
			return fakeReceipt("0002", "success", ["产物2.txt"], f.repo);
		});
		await toolOf(f.captured, "pao_start_flow").execute("t1", { name: "门命令" });
		await settleChains(f);
		expect(chainNotice(f)).toContain("等待人工确认");
		expect(f.runner.runs.length).toBe(1); // 门停住，B 未派
		const sub = listPaoSubcommands(f.captured.pi).find((entry) => entry.name === "flow");
		expect(sub).toBeDefined();
		await sub!.run(f.captured.pi, "confirm 门命令 A", await f.captured.context);
		const reply = f.captured.messages.at(-1)!;
		expect(reply).toContain("自动链"); // 命令面回显＝受理文本,与工具面同口径
		await settleChains(f);
		expect(chainNotice(f)).toContain("状态：completed");
		expect(f.runner.runs.length).toBe(2);
		expect(cardAt(f.cardsDir, "0002").frontmatter.status).toBe("delivered");
	});

	it("命令面启动停在人工门同样触发 toast（与工具面同口径）", async () => {
		resetPaoSubcommandsForTest();
		const f = setup(
			"门命令提醒",
			recipeYaml("门命令提醒", true, [
				...nodeYaml("A", "存在: 产物.txt", ["    人工确认: true"]),
				...nodeYaml("B", "存在: 产物2.txt", ["    depends_on: [A]"]),
			]),
		);
		f.scriptDefault(["产物.txt"]);
		const toast = vi.spyOn(toastModule, "sendToast").mockResolvedValue(undefined);
		await listPaoSubcommands(f.captured.pi)
			.find((entry) => entry.name === "flow")!
			.run(f.captured.pi, "门命令提醒", await f.captured.context);
		await settleChains(f);
		expect(f.captured.messages.some((message) => message.includes("后台推进"))).toBe(true);
		expect(f.captured.messages.at(-1)).toBe(DISPATCH_NOTIFY_WAKEUP_TEXT);
		expect(toast).toHaveBeenCalledTimes(1);
		expect(toast.mock.calls[0]![1]).toContain("等待人工确认");
		toast.mockRestore();
	});

	// ── 叫人去重（2026-10-03 线上事故:同一门反复弹 toast）────────────────────────
	// 去重状态落实例清单「叫人」字段（盘上）——纯内存去重进程一重启就重弹,不合格。

	it("同一人工门重复评估只弹一次:去重键落清单,重启（重建模块状态）后仍不重弹", async () => {
		const f = setup(
			"门去重",
			recipeYaml("门去重", true, [
				...nodeYaml("A", "存在: 产物.txt", ["    人工确认: true"]),
				...nodeYaml("B", "存在: 产物2.txt", ["    depends_on: [A]"]),
			]),
		);
		f.scriptDefault(["产物.txt"]);
		const toast = vi.spyOn(toastModule, "sendToast").mockResolvedValue(undefined);
		// 首次启流停门：弹 1 次
		await toolOf(f.captured, "pao_start_flow").execute("t1", { name: "门去重" });
		await settleChains(f);
		// 同一门再评估两次（推流重复撞同一挂起链）——线上事故形态,不重弹
		await toolOf(f.captured, "pao_push_flow").execute("t2", { name: "门去重" });
		await settleChains(f);
		await toolOf(f.captured, "pao_push_flow").execute("t3", { name: "门去重" });
		await settleChains(f);
		expect(toast).toHaveBeenCalledTimes(1);
		// 盘上状态：清单「叫人」字段记下门实例（键=工作流名内蕴,挂起节点为键）
		const manifestPath = join(f.repo, ".pao", "任务A", "工作流实例-门去重.md");
		expect(parseManifest(readFileSync(manifestPath, "utf8")).叫人).toBe("门:A");
		// 模拟进程重启：全新注册一套工具（全新模块内存态）,同门评估仍不重弹——状态在盘上
		const restart = capturePi();
		const restartFace = registerWorkflowTools(restart.pi, {
			resolvePaoHome: () => f.paoHome,
			resolveCardsDir: () => f.cardsDir,
			runner: f.runner,
		});
		await toolOf(restart, "pao_push_flow").execute("t4", { name: "门去重" });
		await restartFace.waitForAutoChain();
		expect(toast).toHaveBeenCalledTimes(1);
		toast.mockRestore();
	});

	it("换门/确认后再挂会再弹:门 A 确认后停到门 B 再叫一次,同一门 B 不重弹", { timeout: 90_000 }, async () => {
		const f = setup(
			"门轮换",
			recipeYaml("门轮换", true, [
				...nodeYaml("A", "存在: 产物.txt", ["    人工确认: true"]),
				...nodeYaml("B", "存在: 产物2.txt", ["    人工确认: true", "    depends_on: [A]"]),
				...nodeYaml("C", "存在: 产物3.txt", ["    depends_on: [B]"]),
			]),
		);
		f.scriptDefault(["产物.txt"]);
		f.runner.scripts.set("0002", () => {
			writeFileSync(join(f.repo, "产物2.txt"), "产物2\n");
			return fakeReceipt("0002", "success", ["产物2.txt"], f.repo);
		});
		f.runner.scripts.set("0003", () => {
			writeFileSync(join(f.repo, "产物3.txt"), "产物3\n");
			return fakeReceipt("0003", "success", ["产物3.txt"], f.repo);
		});
		const toast = vi.spyOn(toastModule, "sendToast").mockResolvedValue(undefined);
		// 启流停门 A：弹一次
		await toolOf(f.captured, "pao_start_flow").execute("t1", { name: "门轮换" });
		await settleChains(f);
		expect(chainNotice(f)).toContain("等待人工确认");
		expect(toast).toHaveBeenCalledTimes(1);
		// 确认 A → B 交付又停门 B：换门实例 → 再弹
		await toolOf(f.captured, "pao_confirm_flow").execute("t2", { name: "门轮换", node: "A" });
		await settleChains(f);
		expect(chainNotice(f)).toContain("等待人工确认");
		expect(toast).toHaveBeenCalledTimes(2);
		expect(toast.mock.calls[1]![1]).toContain("等待人工确认");
		// 同一门 B 再评估——不重弹;清单记录跟着换到 门:B
		await toolOf(f.captured, "pao_push_flow").execute("t3", { name: "门轮换" });
		await settleChains(f);
		expect(toast).toHaveBeenCalledTimes(2);
		const manifestPath = join(f.repo, ".pao", "任务A", "工作流实例-门轮换.md");
		expect(parseManifest(readFileSync(manifestPath, "utf8")).叫人).toBe("门:B");
		// 确认 B → C 跑完到已完成：无停因不叫
		await toolOf(f.captured, "pao_confirm_flow").execute("t4", { name: "门轮换", node: "B" });
		await settleChains(f);
		expect(chainNotice(f)).toContain("状态：completed");
		expect(toast).toHaveBeenCalledTimes(2);
		toast.mockRestore();
	});

	it("机械失败停流同样去重:同一张卡重复评估不重弹,记录键败:<节点>", async () => {
		const f = setup("审去重", recipeYaml("审去重", true, nodeYaml("A", "存在: 没有.txt")));
		f.runner.scripts.set("0001", () => fakeReceipt("0001", "success", [], f.repo));
		const toast = vi.spyOn(toastModule, "sendToast").mockResolvedValue(undefined);
		await toolOf(f.captured, "pao_start_flow").execute("t1", { name: "审去重" });
		await settleChains(f);
		expect(toast).toHaveBeenCalledTimes(1);
		// 机械失败卡落 failed 后,推流重复评估同一实例不重弹
		await toolOf(f.captured, "pao_push_flow").execute("t2", { name: "审去重" });
		await settleChains(f);
		expect(toast).toHaveBeenCalledTimes(1);
		const manifestPath = join(f.repo, ".pao", "任务A", "工作流实例-审去重.md");
		expect(parseManifest(readFileSync(manifestPath, "utf8")).叫人).toBe("败:A");
		toast.mockRestore();
	});

	// ── S6 推流即返与后台推进链（受理即返＋fire-and-forget＋收敛口）──────────────

	/** 挂起 worker：脚本返回手动 deferred——pending 期间 FakeRunner 已登记注册表(模拟在跑),证明「工具已返回而 worker 未 resolve」不用毫秒阈值。 */
	function hangWorker(f: Fixture, cardNo: string): (receipt?: WorkerReceipt) => void {
		let release: (receipt: WorkerReceipt) => void = () => {};
		const gate = new Promise<WorkerReceipt>((resolve) => {
			release = resolve;
		});
		f.runner.scripts.set(cardNo, () =>
			gate.then(() => {
				writeFileSync(join(f.repo, "产物.txt"), "产物\n");
				return fakeReceipt(cardNo, "success", ["产物.txt"], f.repo);
			}),
		);
		return (receipt) => release(receipt ?? fakeReceipt(cardNo, "success", ["产物.txt"], f.repo));
	}

	/** 等到实际受理或派发事件；真实 Git 子进程不保证在500次定时器回合内结束。 */
	async function pumpUntil(settled: () => boolean): Promise<void> {
		await vi.waitFor(() => expect(settled()).toBe(true), { timeout: 10_000, interval: 20 });
	}

	it("S6 推流即返:挂起 worker 下工具先返回,worker 终局后台收敛至完成", async () => {
		const f = setup("即返", recipeYaml("即返", true, nodeYaml("A", "存在: 产物.txt")));
		const release = hangWorker(f, "0001");
		try {
			let returned = false;
			const pending = toolOf(f.captured, "pao_start_flow")
				.execute("t1", { name: "即返" })
				.then((result) => {
					returned = true;
					return result;
				});
			await pumpUntil(() => returned);
			expect(returned).toBe(true); // 红:现行实现同步 await runAutoChain,卡在挂起 worker 上
			const text = textOf(await pending);
			expect(text).toContain("后台");
			// 工具已返回后,后台链把卡派到挂起 worker(deferred 未 resolve＝worker 未终局)
			await pumpUntil(() => f.runner.runs.length > 0);
			expect(f.runner.runs).toHaveLength(1);
		} finally {
			release();
		}
		await settleChains(f);
		expect(cardAt(f.cardsDir, "0001").frontmatter.status).toBe("delivered");
		expect(commits(f.repo).length).toBe(2);
		expect(chainNotice(f)).toContain("状态：completed");
	});

	it("S6 重复推流不双跑:链在途时再次推流即返且不重复派发", async () => {
		const f = setup("不双跑", recipeYaml("不双跑", true, nodeYaml("A", "存在: 产物.txt")));
		const release = hangWorker(f, "0001");
		try {
			let firstReturned = false;
			const first = toolOf(f.captured, "pao_start_flow")
				.execute("t1", { name: "不双跑" })
				.then((result) => {
					firstReturned = true;
					return result;
				});
			await pumpUntil(() => firstReturned);
			expect(firstReturned).toBe(true);
			await first;
			await pumpUntil(() => f.runner.runs.length > 0); // 在途链已把卡派到挂起 worker
			let secondReturned = false;
			const second = toolOf(f.captured, "pao_push_flow")
				.execute("t2", { name: "不双跑" })
				.then((result) => {
					secondReturned = true;
					return result;
				});
			await pumpUntil(() => secondReturned);
			expect(secondReturned).toBe(true);
			expect(textOf(await second)).toContain("不重复受理");
			expect(f.runner.runs).toHaveLength(1); // 在途链未收敛,第二次推流不重复派发
		} finally {
			release();
		}
		await settleChains(f);
		expect(f.runner.runs).toHaveLength(1);
		expect(cardAt(f.cardsDir, "0001").frontmatter.status).toBe("delivered");
	});
	it("S6 v2 同一人工门重复推流仍核验但不重发通知，真实确认后通知新结果", async () => {
		const f = setup(
			"门去重",
			recipeYaml("门去重", true, [
				...nodeYaml("A", "存在: 产物.txt", ["    人工确认: true"]),
				...nodeYaml("B", "存在: 产物2.txt", ["    depends_on: [A]"]),
			]).replace("---\n", "---\n版本: 2\n"),
		);
		const recipe = loadRecipe(f.paoHome, "门去重");
		const options = { cardsDir: f.cardsDir, paoHome: f.paoHome, ownerSessionId: "owner", 运行器: f.runner };
		await startControl(recipe, {}, options);
		await bindMinister(recipe, options, "A", "minister-A");
		const flow = readControl(recipe, options);
		const identity = { 实例: flow.实例, 节点: "A", 轮次: 1, 部长会话: "minister-A" };
		await addNodeCards(recipe, options, identity, [{ goal: "甲活", acceptance: "存在: 产物.txt" }]);
		await endDecomposition(recipe, options, identity);
		f.runner.scripts.set("0001", () => {
			writeFileSync(join(f.repo, "产物.txt"), "产物\n");
			return fakeReceipt("0001", "success", ["产物.txt"], f.repo);
		});
		f.runner.scripts.set("0002", () => {
			writeFileSync(join(f.repo, "产物2.txt"), "产物2\n");
			return fakeReceipt("0002", "success", ["产物2.txt"], f.repo);
		});
		await toolOf(f.captured, "pao_push_flow").execute("t1", { name: "门去重" });
		await settleChains(f);
		expect(chainNotice(f)).toContain("等待人工确认");
		expect(f.runner.runs).toHaveLength(1);
		expect(f.captured.messages).toEqual([DISPATCH_NOTIFY_WAKEUP_TEXT]);

		const repeated = textOf(await toolOf(f.captured, "pao_push_flow").execute("t2", { name: "门去重" }));
		await settleChains(f);
		expect(repeated).toContain("后台推进");
		expect(f.runner.runs).toHaveLength(1);
		expect(chainNotice(f)).toBe("");
		expect(f.captured.messages).toEqual([DISPATCH_NOTIFY_WAKEUP_TEXT]);

		await toolOf(f.captured, "pao_control_node").execute("t3", {
			name: "门去重",
			action: "confirm",
			node: "A",
			instance: flow.实例,
			round: 1,
		});
		await bindMinister(recipe, options, "B", "minister-B");
		await addNodeCards(recipe, options, { 实例: flow.实例, 节点: "B", 轮次: 1, 部长会话: "minister-B" }, [
			{ goal: "乙活", acceptance: "存在: 产物2.txt" },
		]);
		await endDecomposition(recipe, options, { 实例: flow.实例, 节点: "B", 轮次: 1, 部长会话: "minister-B" });
		const confirmed = textOf(await toolOf(f.captured, "pao_push_flow").execute("t4", { name: "门去重" }));
		expect(confirmed).toContain("后台推进");
		await settleChains(f);
		expect(chainNotice(f)).toContain("状态：completed");
		expect(f.runner.runs).toHaveLength(2);
		expect(f.captured.messages).toEqual([DISPATCH_NOTIFY_WAKEUP_TEXT, DISPATCH_NOTIFY_WAKEUP_TEXT]);
	});

	it("同一人工门重新核验，纯后台派卡计数变化不重发通知", async () => {
		const f = setup(
			"后台记账",
			recipeYaml("后台记账", true, nodeYaml("A", "存在: 产物.txt", ["    人工确认: true"])).replace(
				"---\n",
				"---\n版本: 2\n",
			),
		);
		const recipe = loadRecipe(f.paoHome, "后台记账");
		const options = { cardsDir: f.cardsDir, paoHome: f.paoHome, ownerSessionId: "owner", 运行器: f.runner };
		await startControl(recipe, {}, options);
		await bindMinister(recipe, options, "A", "minister-A");
		const flow = readControl(recipe, options);
		await addNodeCards(recipe, options, { 实例: flow.实例, 节点: "A", 轮次: 1, 部长会话: "minister-A" }, [
			{ goal: "甲活", acceptance: "存在: 产物.txt" },
		]);
		await endDecomposition(recipe, options, { 实例: flow.实例, 节点: "A", 轮次: 1, 部长会话: "minister-A" });
		f.runner.scripts.set("0001", () => {
			writeFileSync(join(f.repo, "产物.txt"), "产物\n");
			return fakeReceipt("0001", "success", ["产物.txt"], f.repo);
		});
		const controlFile = join(f.cardsDir, "..", "工作流实例-后台记账.md");
		const first = textOf(await toolOf(f.captured, "pao_push_flow").execute("t1", { name: "后台记账" }));
		expect(first).toContain("后台推进");
		await settleChains(f);
		expect(f.captured.messages).toEqual([DISPATCH_NOTIFY_WAKEUP_TEXT]);
		expect(chainNotice(f)).toContain("等待人工确认");
		writeFileSync(
			controlFile,
			readFileSync(controlFile, "utf8").replace(/^已派卡:.*$/m, (line) => `${line.split(":")[0]}: 2`),
		);

		const repeated = textOf(await toolOf(f.captured, "pao_push_flow").execute("t2", { name: "后台记账" }));
		await settleChains(f);
		expect(repeated).toContain("后台推进");
		expect(chainNotice(f)).toBe("");
		expect(f.captured.messages).toEqual([DISPATCH_NOTIFY_WAKEUP_TEXT]);
		await f.captured.fireSessionShutdown();
		const afterShutdown = textOf(await toolOf(f.captured, "pao_push_flow").execute("t3", { name: "后台记账" }));
		expect(afterShutdown).toContain("后台推进");
	});

	it("owner 修改实际成果后显式推流仍重新驱动复验", async () => {
		const f = setup(
			"成果复验",
			recipeYaml("成果复验", true, nodeYaml("A", "存在: 产物.txt", ["    人工确认: true"])).replace(
				"---\n",
				"---\n版本: 2\n",
			),
		);
		const recipe = loadRecipe(f.paoHome, "成果复验");
		const options = { cardsDir: f.cardsDir, paoHome: f.paoHome, ownerSessionId: "owner", 运行器: f.runner };
		await startControl(recipe, {}, options);
		await bindMinister(recipe, options, "A", "minister-A");
		const flow = readControl(recipe, options);
		await addNodeCards(recipe, options, { 实例: flow.实例, 节点: "A", 轮次: 1, 部长会话: "minister-A" }, [
			{ goal: "甲活", acceptance: "存在: 产物.txt" },
		]);
		await endDecomposition(recipe, options, { 实例: flow.实例, 节点: "A", 轮次: 1, 部长会话: "minister-A" });
		f.runner.scripts.set("0001", () => {
			writeFileSync(join(f.repo, "产物.txt"), "产物\n");
			return fakeReceipt("0001", "success", ["产物.txt"], f.repo);
		});
		await toolOf(f.captured, "pao_push_flow").execute("t1", { name: "成果复验" });
		await settleChains(f);
		expect(chainNotice(f)).toContain("等待人工确认");

		writeFileSync(join(f.repo, "产物.txt"), "owner 修改后的成果\n");
		const text = textOf(await toolOf(f.captured, "pao_push_flow").execute("t2", { name: "成果复验" }));
		await settleChains(f);
		expect(text).toContain("后台推进");
		expect(f.runner.runs).toHaveLength(1);
		// 文件修改可重新核验，但原人工门仍在；没有新的停因不重复主动通知。
		expect(controlReport(readControl(recipe, options)).nodes[0].hold).toBe("等待人工确认");
		expect(chainNotice(f)).toBe("");
	});

	it("同一实例、节点、轮次和停因下出现新的有效回执时重新受理", async () => {
		const f = setup(
			"新回执",
			recipeYaml("新回执", true, nodeYaml("A", "存在: 产物.txt\\n人工看质量", ["    人工确认: true"])).replace(
				"---\n",
				"---\n版本: 2\n",
			),
		);
		const recipe = loadRecipe(f.paoHome, "新回执");
		const options = { cardsDir: f.cardsDir, 运行器: f.runner, paoHome: f.paoHome, ownerSessionId: "owner" };
		await startControl(recipe, {}, options);
		await bindMinister(recipe, options, "A", "minister-A");
		const flow = readControl(recipe, options);
		const identity = { 实例: flow.实例, 节点: "A", 轮次: 1, 部长会话: "minister-A" };
		await addNodeCards(recipe, options, identity, [{ goal: "甲活", acceptance: "存在: 产物.txt" }]);
		await endDecomposition(recipe, options, identity);
		f.runner.scripts.set("0001", () => {
			writeFileSync(join(f.repo, "产物.txt"), "产物\n");
			return {
				...fakeReceipt("0001", "success", ["产物.txt"], f.repo),
				verification: [{ 条件: "人工看质量", 结论: "not_run" as const }],
			};
		});
		await toolOf(f.captured, "pao_push_flow").execute("t1", { name: "新回执" });
		await settleChains(f);
		expect(chainNotice(f)).toContain("not_run");
		const card = cardAt(f.cardsDir, "0001");
		expect(card.frontmatter.status).toBe("in_progress");
		appendReceipt(card, {
			尝试号: card.frontmatter.attempt,
			时间: "2026-10-24 23:59",
			结果: "success",
			摘要: "同一尝试的新有效回执",
		});

		const text = textOf(await toolOf(f.captured, "pao_push_flow").execute("t2", { name: "新回执" }));
		await settleChains(f);
		expect(text).toContain("后台推进");
		expect(f.runner.runs).toHaveLength(1);
		expect(chainNotice(f)).toContain("自动链停下");
		expect(cardAt(f.cardsDir, "0001").receipts).toHaveLength(2);
	});

	it("回执回调只在卡面事实落定后触发；回调抛错仍完成验收与交付", async () => {
		const f = setup("回调顺序", recipeYaml("回调顺序", true, nodeYaml("A", "存在: 产物.txt")));
		f.scriptDefault(["产物.txt"]);
		const observed: {
			receipt?: {
				status: string;
				attempt: number;
				receipts: number;
				currentAttempt: number;
			};
			receiptEvents: number;
		} = { receiptEvents: 0 };
		const recipe = loadRecipe(f.paoHome, "回调顺序");
		const options = {
			cardsDir: f.cardsDir,
			paoHome: f.paoHome,
			运行器: f.runner,
			onReceipt: (event: { cardRef: string; receipt: WorkerReceipt }) => {
				observed.receiptEvents++;
				const card = cardAt(f.cardsDir, event.cardRef);
				observed.receipt = {
					status: card.frontmatter.status,
					attempt: event.receipt.attempt,
					receipts: card.receipts.length,
					currentAttempt: card.frontmatter.attempt,
				};
				throw new Error("回执投递故障");
			},
		};
		await startWorkflow(recipe, {}, options);
		const chain = await runAutoChain(recipe, options);
		expect(observed.receipt).toEqual({
			status: "in_progress",
			attempt: 1,
			receipts: 1,
			currentAttempt: 1,
		});
		expect(observed.receiptEvents).toBe(1);
		expect(chain.steps.map((step) => step.stage)).toEqual(["派发", "回执", "越界", "验收", "完成"]);
		expect(chain.stopReason).toBeUndefined();
		expect(cardAt(f.cardsDir, "0001").frontmatter.status).toBe("delivered");
	});
	it("成功回执后的机械失败必须以真实失败状态通知部门", async () => {
		const f = setup("回执后机械失败", recipeYaml("回执后机械失败", true, nodeYaml("A", "存在: 没有.txt")));
		f.runner.scripts.set("0001", () => fakeReceipt("0001", "success", [], f.repo));
		const recipe = loadRecipe(f.paoHome, "回执后机械失败");
		const options = {
			cardsDir: f.cardsDir,
			paoHome: f.paoHome,
			运行器: f.runner,
			onPostDispatchResult: (event: AutoChainPostDispatchResultEvent) => {
				observed = {
					status: cardAt(f.cardsDir, event.cardRef).frontmatter.status,
					stopReason: event.stopReason,
				};
			},
		};
		let observed: { status: string; stopReason?: string } | undefined;
		await startWorkflow(recipe, {}, options);
		const chain = await runAutoChain(recipe, options);
		expect(observed).toMatchObject({ status: "failed" });
		expect(observed?.stopReason).toContain("机械验收未过");
		expect(chain.stopReason).toContain("机械验收未过");
	});
	it("后处理通知抛错只告警，保留已交付卡和原始回执", async () => {
		const f = setup("后处理投递失败", recipeYaml("后处理投递失败", true, nodeYaml("A", "存在: 产物.txt")));
		f.scriptDefault(["产物.txt"]);
		const recipe = loadRecipe(f.paoHome, "后处理投递失败");
		const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
		const options = {
			cardsDir: f.cardsDir,
			paoHome: f.paoHome,
			运行器: f.runner,
			onPostDispatchResult: (event: AutoChainPostDispatchResultEvent) => {
				expect(cardAt(f.cardsDir, event.cardRef).frontmatter.status).toBe("delivered");
				throw new Error("固定后处理通知故障");
			},
		};
		try {
			await startWorkflow(recipe, {}, options);
			const chain = await runAutoChain(recipe, options);
			expect(chain.stopReason).toBeUndefined();
			const card = cardAt(f.cardsDir, "0001");
			expect(card.frontmatter.status).toBe("delivered");
			expect(card.receipts).toHaveLength(1);
			expect(card.receipts[0]).toMatchObject({ attempt: 1, result: "success" });
			expect(warnings).toHaveBeenCalledWith(expect.stringContaining("自动链后处理结果回调失败"));
			expect(warnings).toHaveBeenCalledWith(expect.stringContaining("固定后处理通知故障"));
		} finally {
			warnings.mockRestore();
		}
	});
	it.each(["success", "failed"] as const)("旧尝试的 %s 回执只留档，不改变新尝试", async (status) => {
		const f = setup("旧尝试", recipeYaml("旧尝试", true, nodeYaml("A", "存在: 产物.txt")));
		f.runner.scripts.set("0001", () => {
			let card = cardAt(f.cardsDir, "0001");
			for (const to of ["failed", "unclaimed", "in_progress"] as const) {
				card = changeCardStatus(card, {
					操作者: card.frontmatter.owner ?? "主控",
					to,
					失败类型: "transient",
					依据: "模拟旧工人返回前已重开新尝试",
					时间: "2026-10-23 20:00",
				});
			}
			return fakeReceipt("0001", status, [], f.repo);
		});
		const recipe = loadRecipe(f.paoHome, "旧尝试");
		const options = { cardsDir: f.cardsDir, paoHome: f.paoHome, 运行器: f.runner };
		await startWorkflow(recipe, {}, options);
		const chain = await runAutoChain(recipe, options);
		const card = cardAt(f.cardsDir, "0001");
		expect(chain.stopReason).toContain("保留现状");
		expect(card.frontmatter.status).toBe("in_progress");
		expect(card.frontmatter.attempt).toBe(2);
		expect(card.receipts).toHaveLength(1);
		expect(card.receipts[0]).toMatchObject({ attempt: 1, result: status, archive_flag: "old_attempt" });
		expect(commits(f.repo)).toHaveLength(1);
	});
	it("成功回执回调中全停后保留进行中与产物，不再验收或交卷", async () => {
		const f = setup("成功后全停", recipeYaml("成功后全停", true, nodeYaml("A", "存在: 产物.txt")));
		f.scriptDefault(["产物.txt"]);
		const recipe = loadRecipe(f.paoHome, "成功后全停");
		const options = {
			cardsDir: f.cardsDir,
			paoHome: f.paoHome,
			运行器: f.runner,
			onReceipt: async () => {
				await f.runner.stopAll();
			},
		};
		await startWorkflow(recipe, {}, options);
		const chain = await runAutoChain(recipe, options);
		expect(chain.stopReason).toContain("全停");
		expect(chain.steps.map((step) => step.stage)).toEqual(["派发", "回执"]);
		expect(cardAt(f.cardsDir, "0001").frontmatter.status).toBe("in_progress");
		expect(cardAt(f.cardsDir, "0001").receipts).toHaveLength(1);
		expect(existsSync(join(f.repo, "产物.txt"))).toBe(true);
		expect(git(f.repo, ["log", "--format=%s"]).trim().split("\n")).toHaveLength(1);
	});
	it("执行器全停后不触发后处理结果通知", async () => {
		const f = setup("后处理全停", recipeYaml("后处理全停", true, nodeYaml("A", "存在: 产物.txt")));
		f.scriptDefault(["产物.txt"]);
		let notifications = 0;
		const recipe = loadRecipe(f.paoHome, "后处理全停");
		const options = {
			cardsDir: f.cardsDir,
			paoHome: f.paoHome,
			运行器: f.runner,
			onReceipt: async () => {
				await f.runner.stopAll();
			},
			onPostDispatchResult: () => {
				notifications++;
			},
		};
		await startWorkflow(recipe, {}, options);
		const chain = await runAutoChain(recipe, options);
		expect(chain.stopReason).toContain("全停");
		expect(cardAt(f.cardsDir, "0001").frontmatter.status).toBe("in_progress");
		expect(notifications).toBe(0);
	});
	it("外部 abort 保留原异常且不触发后处理结果通知", async () => {
		const f = setup("后处理中止", recipeYaml("后处理中止", true, nodeYaml("A", "存在: 产物.txt")));
		let releaseCompletion: (() => void) | undefined;
		const completionGate = new Promise<void>((resolve) => {
			releaseCompletion = resolve;
		});
		let completionStarted = false;
		f.runner.scripts.set("0001", async () => {
			writeFileSync(join(f.repo, "产物.txt"), "产物\n");
			return fakeReceipt("0001", "success", ["产物.txt"], f.repo);
		});
		const complete = postDispatch.completeDispatchedTask;
		vi.spyOn(postDispatch, "completeDispatchedTask").mockImplementation(async (input) => {
			completionStarted = true;
			await completionGate;
			return complete(input);
		});
		const controller = new AbortController();
		let notifications = 0;
		const recipe = loadRecipe(f.paoHome, "后处理中止");
		const options = {
			cardsDir: f.cardsDir,
			paoHome: f.paoHome,
			运行器: f.runner,
			signal: controller.signal,
			onPostDispatchResult: () => {
				notifications++;
			},
		};
		await startWorkflow(recipe, {}, options);
		const abortError = new Error("测试外部中止");
		const pending = expect(runAutoChain(recipe, options)).rejects.toBe(abortError);
		await vi.waitFor(() => expect(completionStarted).toBe(true), { timeout: 10_000, interval: 10 });
		controller.abort(abortError);
		releaseCompletion?.();
		await pending;
		expect(notifications).toBe(0);
		expect(f.runner.isStopped()).toBe(false);
	});
	it("失败回执先落 failed 再触发回执；回执回调抛错不跳过失败停链", async () => {
		const f = setup("回调失败", recipeYaml("回调失败", true, nodeYaml("A", "存在: 产物.txt")));
		f.runner.scripts.set("0001", () => ({
			...fakeReceipt("0001", "failed", [], f.repo),
			摘要: "模拟失败",
			失败类型: "transient",
		}));
		let observed: { status: string; recorded: boolean; result: string; receipts: number } | undefined;
		const recipe = loadRecipe(f.paoHome, "回调失败");
		const options = {
			cardsDir: f.cardsDir,
			paoHome: f.paoHome,
			运行器: f.runner,
			onReceipt: (event: { cardRef: string; result: string; recorded: boolean; receipt: WorkerReceipt }) => {
				const card = cardAt(f.cardsDir, event.cardRef);
				observed = {
					status: card.frontmatter.status,
					recorded: event.recorded,
					result: event.result,
					receipts: card.receipts.length,
				};
				throw new Error("失败投递故障");
			},
		};
		await startWorkflow(recipe, {}, options);
		const chain = await runAutoChain(recipe, options);
		expect(observed).toEqual({ status: "failed", recorded: true, result: "failed", receipts: 1 });
		expect(chain.stopReason).toContain("回执失败");
		expect(cardAt(f.cardsDir, "0001").frontmatter.status).toBe("failed");
	});

	it("显式全停后的取消回执仍落卡与停因，但不再触发回执回调或链通知", async () => {
		const f = setup("全停回调", recipeYaml("全停回调", true, nodeYaml("A", "存在: 产物.txt")));
		let receiptEvents = 0;
		const toast = vi.spyOn(toastModule, "sendToast").mockResolvedValue(undefined);
		try {
			f.runner.scripts.set("0001", async () => {
				await f.runner.stopAll();
				return {
					...fakeReceipt("0001", "canceled", [], f.repo),
					summary: "用户显式全停，保留原始取消回执",
				};
			});
			const recipe = loadRecipe(f.paoHome, "全停回调");
			const options = {
				cardsDir: f.cardsDir,
				paoHome: f.paoHome,
				运行器: f.runner,
				onReceipt: () => {
					receiptEvents++;
				},
			};
			await startWorkflow(recipe, {}, options);
			const chain = await runAutoChain(recipe, options);
			const card = cardAt(f.cardsDir, "0001");
			expect(card.frontmatter.status).toBe("failed");
			expect(card.receipts.at(-1)).toMatchObject({
				attempt: 1,
				result: "canceled",
				summary: "用户显式全停，保留原始取消回执",
			});
			expect(chain.steps.map((step) => step.stage)).toEqual(["派发", "回执", "失败"]);
			expect(receiptEvents).toBe(0);
			expect(toast).not.toHaveBeenCalled();
			expect(f.captured.messages).toEqual([]);
		} finally {
			toast.mockRestore();
		}
	});

	it("普通单卡取消只按失败语义通知，不冒充运行器全停", async () => {
		const f = setup("单卡取消", recipeYaml("单卡取消", true, nodeYaml("A", "存在: 产物.txt")));
		let receiptEvents = 0;
		f.runner.scripts.set("0001", () => ({
			...fakeReceipt("0001", "canceled", [], f.repo),
			summary: "普通单卡取消",
		}));
		const recipe = loadRecipe(f.paoHome, "单卡取消");
		const options = {
			cardsDir: f.cardsDir,
			paoHome: f.paoHome,
			运行器: f.runner,
			onReceipt: () => {
				receiptEvents++;
			},
		};
		await startWorkflow(recipe, {}, options);
		const chain = await runAutoChain(recipe, options);
		expect(f.runner.isStopped()).toBe(false);
		expect(cardAt(f.cardsDir, "0001").frontmatter.status).toBe("failed");
		expect(chain.steps.map((step) => step.stage)).toEqual(["派发", "回执", "失败"]);
		expect(receiptEvents).toBe(1);
	});

	it("普通失败仍即时进入后台通知缓冲", async () => {
		const f = setup("普通失败通知", recipeYaml("普通失败通知", true, nodeYaml("A", "存在: 产物.txt")));
		f.runner.scripts.set("0001", () => ({
			...fakeReceipt("0001", "failed", [], f.repo),
			summary: "普通失败必须通知",
		}));
		await toolOf(f.captured, "pao_start_flow").execute("t1", { name: "普通失败通知" });
		await settleChains(f);
		expect(f.runner.isStopped()).toBe(false);
		const notice = chainNotice(f);
		expect(notice).toContain("自动链停下");
		expect(notice).toContain("回执失败");
	});

	it("后台全停取消时保留原始回执并清在途计数，但不发唤醒、toast、复盘或链终局通知", async () => {
		const f = setup("后台全停", recipeYaml("后台全停", true, nodeYaml("A", "存在: 产物.txt")));
		const toast = vi.spyOn(toastModule, "sendToast").mockResolvedValue(undefined);
		try {
			f.runner.scripts.set("0001", async () => {
				await f.runner.stopAll();
				return {
					...fakeReceipt("0001", "canceled", [], f.repo),
					summary: "后台全停原始回执",
				};
			});
			await toolOf(f.captured, "pao_start_flow").execute("t1", { name: "后台全停" });
			await settleChains(f);
			expect(f.face!.backgroundCount()).toEqual({ inFlight: 0 });
			expect(cardAt(f.cardsDir, "0001").receipts.at(-1)).toMatchObject({
				attempt: 1,
				result: "canceled",
				summary: "后台全停原始回执",
			});
			expect(f.captured.messages).toEqual([]);
			expect(f.captured.fireBeforeAgentStart()).toEqual({});
			expect(toast).not.toHaveBeenCalled();
		} finally {
			toast.mockRestore();
		}
	});
	it("后台计数与变化通知覆盖受理、重复推流和结算；回调异常不破坏链", async () => {
		const f = setup("后台计数", recipeYaml("后台计数", true, nodeYaml("A", "存在: 产物.txt")));
		const recipe = loadRecipe(f.paoHome, "后台计数");
		const options = { cardsDir: f.cardsDir, paoHome: f.paoHome, 运行器: f.runner };
		await startWorkflow(recipe, {}, options);
		const changes: { count: number; notice?: string }[] = [];
		const counting = registerWorkflowTools(f.captured.pi, {
			resolvePaoHome: () => f.paoHome,
			resolveCardsDir: () => f.cardsDir,
			runner: f.runner,
			onBackgroundChange: () => {
				changes.push({ count: counting.backgroundCount().inFlight });
				throw new Error("模拟宿主生命周期通知失败");
			},
		});
		const release = hangWorker(f, "0001");
		try {
			const accepted = counting.accept(recipe, options, undefined, false);
			expect(counting.backgroundCount()).toEqual({ inFlight: 1 });
			expect(changes.some((change) => change.count === 1)).toBe(true);
			expect(await accepted).toContain("后台推进");
			await pumpUntil(() => f.runner.runs.length > 0);
			expect(await counting.accept(recipe, options, undefined, false)).toContain("不重复受理");
			expect(counting.backgroundCount()).toEqual({ inFlight: 1 });
		} finally {
			release();
		}
		await counting.waitForAutoChain();
		expect(counting.backgroundCount()).toEqual({ inFlight: 0 });
		expect(changes.at(-1)?.count).toBe(0);
		expect(changes.length).toBeGreaterThanOrEqual(2);
		expect(cardAt(f.cardsDir, "0001").frontmatter.status).toBe("delivered");
	});
	it("首次快照仍在读取时也拒绝第二次受理；受理失败释放占位", async () => {
		const f = setup("受理锁", recipeYaml("受理锁", true, nodeYaml("A", "存在: 产物.txt")));
		const recipe = loadRecipe(f.paoHome, "受理锁");
		const options = { cardsDir: f.cardsDir, paoHome: f.paoHome, 运行器: f.runner };
		let changes = 0;
		const observed = registerWorkflowTools(f.captured.pi, {
			resolvePaoHome: () => f.paoHome,
			resolveCardsDir: () => f.cardsDir,
			runner: f.runner,
			onBackgroundChange: () => {
				changes++;
			},
		});
		await expect(f.face!.accept(recipe, options, undefined, false)).rejects.toThrow("尚未启动");
		expect(changes).toBe(0);
		await startWorkflow(recipe, {}, options);
		const release = hangWorker(f, "0001");
		try {
			const first = observed.accept(recipe, options, undefined, false);
			const second = observed.accept(recipe, options, undefined, false);
			expect(await second).toContain("不重复受理");
			expect(await first).toContain("已受理");
			await pumpUntil(() => f.runner.runs.length > 0);
			expect(f.runner.runs).toHaveLength(1);
			expect(observed.backgroundCount().inFlight).toBe(1);
		} finally {
			release();
		}
		await observed.waitForAutoChain();
		expect(observed.backgroundCount().inFlight).toBe(0);
	});

	// ── S6-K2 实例级限额累计：限额总量按实例计（启动到终局），不按调用计 ──────────
	// K1 后台续链后每卡回执自动续链，per-call 各得一份新 50＝防失控语义失效；
	// 累计落实例正本「已派卡」（v1 manifest / v2 FlowControl，均非卡协议字段）。
	// 合并规则定案：本次生效上限＝min(本次 options.maxCards ?? 50, 实例余量)，
	// 实例余量＝max(0, max(50, 本次 options) − 实例已派累计)——单次 options 只能收紧，
	// 显式更大值可临时抬基数（超过缺省 50 须每次显式授权）。

	it("K2 红·v1 实例已派满 50:推流零派发,停因带实例累计（现行各调用各得新 50 必红）", async () => {
		const f = setup("累计红", recipeYaml("累计红", true, nodeYaml("A", "存在: 产物.txt")));
		f.scriptDefault(["产物.txt"]);
		const recipe = loadRecipe(f.paoHome, "累计红");
		const options = { cardsDir: f.cardsDir, 运行器: f.runner, paoHome: f.paoHome };
		await startWorkflow(recipe, {}, options);
		// 预置实例累计 50＝「此前调用已把实例额度用满」的等价可观察；老代码不认该字段→照派必红
		const manifestFile = join(f.repo, ".pao", "任务A", "工作流实例-累计红.md");
		writeFileSync(
			manifestFile,
			readFileSync(manifestFile, "utf8").replace("状态: 运行中", "状态: 运行中\n已派卡: 50"),
		);
		const chain = await runAutoChain(recipe, options);
		expect(f.runner.runs).toHaveLength(0);
		expect(chain.stopReason).toContain("实例累计");
		expect(chain.stopReason).toContain("卡数上限");
		expect(cardAt(f.cardsDir, "0001").frontmatter.status).toBe("unclaimed");
	});

	it("K2 红·v2 实例已派满 50:推流零派发,停因带实例累计（现行各调用各得新 50 必红）", async () => {
		const f = setup(
			"累计红2",
			recipeYaml("累计红2", true, nodeYaml("A", "存在: 产物.txt")).replace("---\n", "---\n版本: 2\n"),
		);
		const recipe = loadRecipe(f.paoHome, "累计红2");
		const options = { cardsDir: f.cardsDir, paoHome: f.paoHome, ownerSessionId: "owner", 运行器: f.runner };
		await startControl(recipe, {}, options);
		await bindMinister(recipe, options, "A", "minister-A");
		const flow = readControl(recipe, options);
		const identity = { 实例: flow.实例, 节点: "A", 轮次: 1, 部长会话: "minister-A" };
		await addNodeCards(recipe, options, identity, [{ goal: "甲活", acceptance: "存在: 产物.txt" }]);
		await endDecomposition(recipe, options, identity);
		f.scriptDefault(["产物.txt"]);
		const controlFile = join(f.repo, ".pao", "任务A", "工作流实例-累计红2.md");
		writeFileSync(controlFile, readFileSync(controlFile, "utf8").replace(/^版本: 2$/m, "版本: 2\n已派卡: 50"));
		const chain = await runAutoChain(recipe, options);
		expect(f.runner.runs).toHaveLength(0);
		expect(chain.stopReason).toContain("实例累计");
		expect(chain.stopReason).toContain("卡数上限");
		expect(cardAt(f.cardsDir, "0001").frontmatter.status).toBe("unclaimed");
	});

	it("K2 绿·v1 跨调用累计:每派一卡清单已派卡+1,两轮推流累计到 2", { timeout: 60_000 }, async () => {
		const f = setup(
			"累计绿",
			recipeYaml("累计绿", true, [
				...nodeYaml("A", "存在: 产物.txt"),
				...nodeYaml("B", "存在: 产物2.txt", ["    depends_on: [A]"]),
			]),
		);
		f.scriptDefault(["产物.txt"]);
		f.runner.scripts.set("0002", () => {
			writeFileSync(join(f.repo, "产物2.txt"), "产物2\n");
			return fakeReceipt("0002", "success", ["产物2.txt"], f.repo);
		});
		const recipe = loadRecipe(f.paoHome, "累计绿");
		const options = { cardsDir: f.cardsDir, 运行器: f.runner, paoHome: f.paoHome };
		await startWorkflow(recipe, {}, options);
		const manifestFile = join(f.repo, ".pao", "任务A", "工作流实例-累计绿.md");
		const readCount = () => parseManifest(readFileSync(manifestFile, "utf8")).已派卡;
		const first = await runAutoChain(recipe, { ...options, maxCards: 1 });
		expect(f.runner.runs).toHaveLength(1);
		expect(first.stopReason).toContain("单次自动推进"); // 本次 options(1) 比实例余量(49)严→按调用上限停
		expect(readCount()).toBe(1);
		const second = await runAutoChain(recipe, options); // 缺省调用：实例余量 49 续派 B
		expect(f.runner.runs).toHaveLength(2);
		expect(second.report.status).toBe("completed");
		expect(readCount()).toBe(2);
	});

	it("第6项·v1 实例计数保存失败时中止在派发前,worker 实际零运行且卡保持未认领", async () => {
		const f = setup("计数保存败", recipeYaml("计数保存败", true, nodeYaml("A", "存在: 产物.txt")));
		f.scriptDefault(["产物.txt"]);
		const recipe = loadRecipe(f.paoHome, "计数保存败");
		const options = { cardsDir: f.cardsDir, 运行器: f.runner, paoHome: f.paoHome };
		await startWorkflow(recipe, {}, options);
		const manifestFile = join(f.repo, ".pao", "任务A", "工作流实例-计数保存败.md");
		const original = atomic.writeFileAtomic;
		const writes = vi.spyOn(atomic, "writeFileAtomic").mockImplementation((path, text) => {
			if (path === manifestFile && text.includes("已派卡: 1")) throw new Error("注入清单保存失败");
			original(path, text);
		});
		try {
			await expect(runAutoChain(recipe, options)).rejects.toThrow("注入清单保存失败");
		} finally {
			writes.mockRestore();
		}
		expect(f.runner.runs).toHaveLength(0);
		expect(cardAt(f.cardsDir, "0001").frontmatter.status).toBe("unclaimed");
		expect(cardAt(f.cardsDir, "0001").frontmatter.attempt).toBe(0);
		expect(parseManifest(readFileSync(manifestFile, "utf8")).已派卡).toBeUndefined();
		// 模拟文件写入恢复后，同一实例仍可从 0 计数正常续跑。
		await expect(runAutoChain(recipe, options)).resolves.toMatchObject({
			report: { status: "completed" },
		});
		expect(f.runner.runs).toHaveLength(1);
		expect(parseManifest(readFileSync(manifestFile, "utf8")).已派卡).toBe(1);
	});

	it(
		"K2 绿·v1 合并规则=本次 options 与实例余量较严者:余量耗尽停实例上限,显式更大值可续",
		{ timeout: 90_000 },
		async () => {
			const f = setup(
				"合并",
				recipeYaml("合并", true, [
					...nodeYaml("A", "存在: 产物.txt"),
					...nodeYaml("B", "存在: 产物2.txt", ["    depends_on: [A]"]),
					...nodeYaml("C", "存在: 产物3.txt", ["    depends_on: [B]"]),
				]),
			);
			f.scriptDefault(["产物.txt"]);
			f.runner.scripts.set("0002", () => {
				writeFileSync(join(f.repo, "产物2.txt"), "产物2\n");
				return fakeReceipt("0002", "success", ["产物2.txt"], f.repo);
			});
			f.runner.scripts.set("0003", () => {
				writeFileSync(join(f.repo, "产物3.txt"), "产物3\n");
				return fakeReceipt("0003", "success", ["产物3.txt"], f.repo);
			});
			const recipe = loadRecipe(f.paoHome, "合并");
			const options = { cardsDir: f.cardsDir, 运行器: f.runner, paoHome: f.paoHome };
			await startWorkflow(recipe, {}, options);
			const manifestFile = join(f.repo, ".pao", "任务A", "工作流实例-合并.md");
			writeFileSync(
				manifestFile,
				readFileSync(manifestFile, "utf8").replace("状态: 运行中", "状态: 运行中\n已派卡: 48"),
			);
			const readCount = () => parseManifest(readFileSync(manifestFile, "utf8")).已派卡;
			// ① options(1) 比实例余量(2) 严：按调用上限停
			const tight = await runAutoChain(recipe, { ...options, maxCards: 1 });
			expect(tight.stopReason).toContain("单次自动推进");
			expect(readCount()).toBe(49);
			// ② 缺省调用：实例余量(1) 比 50 严：按实例累计停,不偷派 C
			const exhausted = await runAutoChain(recipe, options);
			expect(f.runner.runs).toHaveLength(2);
			expect(exhausted.stopReason).toContain("实例累计");
			expect(readCount()).toBe(50);
			expect(cardAt(f.cardsDir, "0003").frontmatter.status).toBe("unclaimed");
			// ③ 显式更大上限(51)抬实例基数：余量 1,续派 C 到完成
			const raised = await runAutoChain(recipe, { ...options, maxCards: 51 });
			expect(f.runner.runs).toHaveLength(3);
			expect(raised.report.status).toBe("completed");
			expect(readCount()).toBe(51);
		},
	);

	it("K2 绿·v2 跨调用累计:控制正本已派卡随派随记,两轮推流累计到 2", async () => {
		const f = setup(
			"累计绿2",
			recipeYaml("累计绿2", true, nodeYaml("A", "存在: 产物.txt", ["    工人数量: 2"])).replace(
				"---\n",
				"---\n版本: 2\n",
			),
		);
		const recipe = loadRecipe(f.paoHome, "累计绿2");
		const options = { cardsDir: f.cardsDir, paoHome: f.paoHome, ownerSessionId: "owner", 运行器: f.runner };
		await startControl(recipe, {}, options);
		await bindMinister(recipe, options, "A", "minister-A");
		const flow = readControl(recipe, options);
		const identity = { 实例: flow.实例, 节点: "A", 轮次: 1, 部长会话: "minister-A" };
		await addNodeCards(recipe, options, identity, [
			{ goal: "甲活", acceptance: "存在: 产物.txt" },
			{ goal: "乙活", acceptance: "存在: 产物.txt" },
		]);
		await endDecomposition(recipe, options, identity);
		f.runner.scripts.set("0001", () => {
			writeFileSync(join(f.repo, "产物.txt"), "产物\n");
			return fakeReceipt("0001", "success", ["产物.txt"], f.repo);
		});
		f.runner.scripts.set("0002", () => {
			writeFileSync(join(f.repo, "产物2.txt"), "产物2\n");
			return fakeReceipt("0002", "success", ["产物2.txt"], f.repo);
		});
		const first = await runAutoChain(recipe, { ...options, maxCards: 1 });
		expect(f.runner.runs).toHaveLength(1);
		expect(first.stopReason).toContain("卡数上限");
		expect(readControl(recipe, options).已派卡).toBe(1);
		const second = await runAutoChain(recipe, options);
		expect(f.runner.runs).toHaveLength(2);
		expect(second.report.status).toBe("completed");
		expect(readControl(recipe, options).已派卡).toBe(2);
	}, 60_000);

	it.each(["refused", "throw", "refused-refund-fails", "throw-refund-fails"])(
		"v2 认领事务退款一次并保留异常：%s（模拟认领，真实控制文件）",
		async (mode) => {
			const f = setup(
				"认领退款",
				recipeYaml("认领退款", false, nodeYaml("A", "存在: 产物.txt")).replace("---\n", "---\n版本: 2\n"),
			);
			const recipe = loadRecipe(f.paoHome, "认领退款");
			const options = { cardsDir: f.cardsDir, paoHome: f.paoHome, ownerSessionId: "owner", 运行器: f.runner };
			await startControl(recipe, {}, options);
			await bindMinister(recipe, options, "A", "minister-A");
			const identity = { 实例: readControl(recipe, options).实例, 节点: "A", 轮次: 1, 部长会话: "minister-A" };
			await addNodeCards(recipe, options, identity, [{ goal: "退款边界", acceptance: "存在: 产物.txt" }]);
			await endDecomposition(recipe, options, identity);
			let insideHook = false;
			let refunds = 0;
			const write = atomic.writeFileAtomic;
			vi.spyOn(atomic, "writeFileAtomic").mockImplementation((path, content) => {
				if (insideHook && path === controlPath(recipe, options) && content.includes("已派卡: 0")) {
					refunds++;
					if (mode.endsWith("refund-fails")) throw new Error("refund-write-failed");
				}
				return write(path, content);
			});
			vi.spyOn(dispatchCore, "executeDispatch").mockImplementation(async (_input, dispatchOptions) => {
				if (!dispatchOptions.claimTransaction) throw new Error("缺认领事务");
				insideHook = true;
				try {
					const result = await dispatchOptions.claimTransaction(async () => {
						if (mode.startsWith("throw")) throw new Error("claim-original-failed");
						return { 可派: false, 原因: "模拟认领拒绝" };
					});
					if (result.可派) throw new Error("本用例不得真实认领");
					return result;
				} finally {
					insideHook = false;
				}
			});
			const report = await runAutoChain(recipe, options);
			expect(refunds).toBe(1);
			expect(readControl(recipe, options).已派卡).toBe(mode.endsWith("refund-fails") ? 1 : 0);
			expect(f.runner.runs).toHaveLength(0);
			expect(cardAt(f.cardsDir, "0001").frontmatter.status).toBe("unclaimed");
			if (mode.startsWith("throw")) expect(report.stopReason).toContain("claim-original-failed");
			else expect(report.stopReason).toContain("模拟认领拒绝");
			if (mode.endsWith("refund-fails")) expect(report.stopReason).toContain("refund-write-failed");
		},
	);

	it("v2 worker 运行时已释放 .dispatch 真实文件锁", async () => {
		const f = setup(
			"派发短锁",
			recipeYaml("派发短锁", false, nodeYaml("A", "存在: 产物.txt")).replace("---\n", "---\n版本: 2\n"),
		);
		const recipe = loadRecipe(f.paoHome, "派发短锁");
		const options = { cardsDir: f.cardsDir, paoHome: f.paoHome, ownerSessionId: "owner", 运行器: f.runner };
		await startControl(recipe, {}, options);
		await bindMinister(recipe, options, "A", "minister-A");
		const flow = readControl(recipe, options);
		await addNodeCards(recipe, options, { 实例: flow.实例, 节点: "A", 轮次: 1, 部长会话: "minister-A" }, [
			{ goal: "短锁", acceptance: "存在: 产物.txt" },
		]);
		await endDecomposition(recipe, options, {
			实例: flow.实例,
			节点: "A",
			轮次: 1,
			部长会话: "minister-A",
		});
		let lockWasFree = false;
		f.runner.scripts.set("0001", async () => {
			await withFileLock(
				`${controlPath(recipe, options)}.dispatch`,
				async () => {
					lockWasFree = true;
				},
				{ retries: 0 },
			);
			writeFileSync(join(f.repo, "产物.txt"), "产物\n");
			return fakeReceipt("0001", "success", ["产物.txt"], f.repo);
		});

		const chain = await runAutoChain(recipe, options);

		expect(lockWasFree).toBe(true);
		expect(chain.report.status).toBe("completed");
		expect(f.runner.runs).toHaveLength(1);
	}, 60_000);

	it("v2 另一卡运行时，原卡返修不受 .dispatch 短锁阻塞而由执行根占用明确拒绝", async () => {
		const f = setup(
			"跨卡返修",
			recipeYaml("跨卡返修", false, nodeYaml("A", "存在: 产物.txt", ["    工人数量: 2"])).replace(
				"---\n",
				"---\n版本: 2\n",
			),
		);
		const recipe = loadRecipe(f.paoHome, "跨卡返修");
		const options = { cardsDir: f.cardsDir, paoHome: f.paoHome, ownerSessionId: "owner", 运行器: f.runner };
		await startControl(recipe, {}, options);
		await bindMinister(recipe, options, "A", "minister-A");
		const initial = readControl(recipe, options);
		const identity = { 实例: initial.实例, 节点: "A", 轮次: 1, 部长会话: "minister-A" };
		const refs = await addNodeCards(recipe, options, identity, [
			{ goal: "先成功后返修", acceptance: "存在: 产物.txt" },
			{ goal: "同批保持运行", acceptance: "存在: 产物2.txt" },
		]);
		const cardNos = refs.map((ref) => String(parseCardRef(ref)).padStart(4, "0"));
		await endDecomposition(recipe, options, identity);
		f.runner.scripts.set(cardNos[0]!, () => {
			writeFileSync(join(f.repo, "产物.txt"), "第一卡\n");
			return fakeReceipt(cardNos[0]!, "success", ["产物.txt"], f.repo);
		});
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reworkError: unknown;
		f.runner.scripts.set(cardNos[1]!, async () => {
			try {
				await reworkOriginalCards(
					recipe,
					options,
					identity,
					{ 卡: [refs[0]!], 理由: "共享执行根仍有活卡" },
					() => [],
				);
			} catch (error) {
				reworkError = error;
			}
			await gate;
			writeFileSync(join(f.repo, "产物2.txt"), "第二卡\n");
			return fakeReceipt(cardNos[1]!, "success", ["产物2.txt"], f.repo);
		});
		const chainPromise = runAutoChain(recipe, { ...options, maxCards: 2 });
		try {
			const secondPath = locateDispatchCard(f.cardsDir, refs[1]!).path;
			await vi.waitFor(() => expect(scriptRunning(f.runner, secondPath)).toBe(true), {
				timeout: 30_000,
				interval: 25,
			});
			await vi.waitFor(() => expect(reworkError).toBeInstanceOf(Error), { timeout: 10_000, interval: 25 });
			expect(reworkError).toBeInstanceOf(Error);
			expect((reworkError as Error).message).toContain("执行根");
			expect((reworkError as Error).message).toContain("占用状态为 active");
			expect((reworkError as Error).message).not.toContain("LOCK_TIMEOUT");
			expect(locateDispatchCard(f.cardsDir, refs[0]!).frontmatter.status).toBe("delivered");
		} finally {
			release?.();
		}
		await expect(chainPromise).resolves.toMatchObject({ report: { status: "completed" } });
	}, 60_000);

	it("v2 同卡仍有登记活工人时拒绝原卡返修", async () => {
		const f = setup(
			"活工人返修",
			recipeYaml("活工人返修", false, nodeYaml("A", "存在: 产物.txt")).replace("---\n", "---\n版本: 2\n"),
		);
		const recipe = loadRecipe(f.paoHome, "活工人返修");
		const options = { cardsDir: f.cardsDir, paoHome: f.paoHome, ownerSessionId: "owner", 运行器: f.runner };
		await startControl(recipe, {}, options);
		await bindMinister(recipe, options, "A", "minister-A");
		const initial = readControl(recipe, options);
		const identity = { 实例: initial.实例, 节点: "A", 轮次: 1, 部长会话: "minister-A" };
		const [ref] = await addNodeCards(recipe, options, identity, [{ goal: "仍在运行", acceptance: "存在: 产物.txt" }]);
		await endDecomposition(recipe, options, identity);
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const cardNo = String(parseCardRef(ref)).padStart(4, "0");
		f.runner.scripts.set(cardNo, async () => {
			await gate;
			writeFileSync(join(f.repo, "产物.txt"), "产物\n");
			return fakeReceipt(cardNo, "success", ["产物.txt"], f.repo);
		});
		const chainPromise = runAutoChain(recipe, options);
		try {
			const cardPath = locateDispatchCard(f.cardsDir, ref).path;
			await vi.waitFor(() => expect(scriptRunning(f.runner, cardPath)).toBe(true), {
				timeout: 30_000,
				interval: 25,
			});
			changeCardStatus(locateDispatchCard(f.cardsDir, ref), {
				操作者: "主控",
				to: "failed",
				失败类型: "unknown_outcome",
				时间: "2026-10-26 14:20",
			});

			await expect(
				reworkOriginalCards(recipe, options, identity, { 卡: [ref], 理由: "活工人仍在" }, () => []),
			).rejects.toThrow(/占用状态为 active|活工人/);
		} finally {
			release?.();
		}
		await chainPromise;
	}, 60_000);

	it("v2 同实例并发推进不会重复派发同一卡", async () => {
		const f = setup(
			"并发推进",
			recipeYaml("并发推进", false, nodeYaml("A", "存在: 产物.txt")).replace("---\n", "---\n版本: 2\n"),
		);
		const recipe = loadRecipe(f.paoHome, "并发推进");
		const options = { cardsDir: f.cardsDir, paoHome: f.paoHome, ownerSessionId: "owner", 运行器: f.runner };
		await startControl(recipe, {}, options);
		await bindMinister(recipe, options, "A", "minister-A");
		const initial = readControl(recipe, options);
		const identity = { 实例: initial.实例, 节点: "A", 轮次: 1, 部长会话: "minister-A" };
		const [ref] = await addNodeCards(recipe, options, identity, [{ goal: "只派一次", acceptance: "存在: 产物.txt" }]);
		await endDecomposition(recipe, options, identity);
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const cardNo = String(parseCardRef(ref)).padStart(4, "0");
		f.runner.scripts.set(cardNo, async () => {
			await gate;
			writeFileSync(join(f.repo, "产物.txt"), "产物\n");
			return fakeReceipt(cardNo, "success", ["产物.txt"], f.repo);
		});
		const first = runAutoChain(recipe, options);
		let second: ReturnType<typeof runAutoChain> | undefined;
		try {
			const cardPath = locateDispatchCard(f.cardsDir, ref).path;
			await vi.waitFor(() => expect(scriptRunning(f.runner, cardPath)).toBe(true), {
				timeout: 30_000,
				interval: 25,
			});
			second = runAutoChain(recipe, options);
			// 首个 worker 保持挂起；续推能读到在途状态并返回，不占整条链等待其结束。
			expect((await second).report.status).toBe("running");
			expect(f.runner.runs).toHaveLength(1);
		} finally {
			release?.();
		}
		await Promise.all([first, second!]);
		expect(f.runner.runs).toHaveLength(1);
	}, 60_000);

	it.each(["暂停", "轮次变化"] as const)(
		"v2 worker 运行中%s会阻止后续派发",
		async (change) => {
			const f = setup(
				`停止后续-${change}`,
				recipeYaml(`停止后续-${change}`, false, nodeYaml("A", "存在: 产物.txt", ["    工人数量: 1"])).replace(
					"---\n",
					"---\n版本: 2\n",
				),
			);
			const recipe = loadRecipe(f.paoHome, `停止后续-${change}`);
			const options = { cardsDir: f.cardsDir, paoHome: f.paoHome, ownerSessionId: "owner", 运行器: f.runner };
			await startControl(recipe, {}, options);
			await bindMinister(recipe, options, "A", "minister-A");
			const initial = readControl(recipe, options);
			const identity = { 实例: initial.实例, 节点: "A", 轮次: 1, 部长会话: "minister-A" };
			const refs = await addNodeCards(recipe, options, identity, [
				{ goal: "先运行", acceptance: "存在: 产物.txt" },
				{ goal: "不得续派", acceptance: "存在: 产物.txt" },
			]);
			await endDecomposition(recipe, options, identity);
			let release: (() => void) | undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const firstNo = String(parseCardRef(refs[0]!)).padStart(4, "0");
			f.runner.scripts.set(firstNo, async () => {
				await gate;
				writeFileSync(join(f.repo, "产物.txt"), "产物\n");
				return fakeReceipt(firstNo, "success", ["产物.txt"], f.repo);
			});
			const chainPromise = runAutoChain(recipe, options);
			try {
				const firstPath = locateDispatchCard(f.cardsDir, refs[0]!).path;
				await vi.waitFor(() => expect(scriptRunning(f.runner, firstPath)).toBe(true), {
					timeout: 30_000,
					interval: 25,
				});
				if (change === "暂停") {
					await pauseControl(recipe, options, "测试暂停后续派发");
				} else {
					const changed = readControl(recipe, options);
					changed.节点.find((node) => node.名字 === "A")!.轮次++;
					atomic.writeFileAtomic(controlPath(recipe, options), `---\n${stringify(changed)}---\n`);
				}
			} finally {
				release?.();
			}
			const chain = await chainPromise;
			expect(chain.stopReason).toContain("暂停或轮次已改变");
			expect(f.runner.runs).toHaveLength(1);
			expect(locateDispatchCard(f.cardsDir, refs[1]!).frontmatter.status).toBe("unclaimed");
		},
		60_000,
	);

	// ── S6-K3 v2 失败叫人去重落盘（K1 留白：控制正本加「叫人」字段，盘上去重跨重启）──

	it("K3 红·v2 失败叫人去重落控制正本:同失败现场重复推流/重启后不重弹,键带轮次（现行 v2 恒未叫过必重弹）", async () => {
		const f = setup(
			"v2失败去重",
			recipeYaml("v2失败去重", true, nodeYaml("A", "存在: 产物.txt")).replace("---\n", "---\n版本: 2\n"),
		);
		const recipe = loadRecipe(f.paoHome, "v2失败去重");
		const options = { cardsDir: f.cardsDir, paoHome: f.paoHome, ownerSessionId: "owner", 运行器: f.runner };
		await startControl(recipe, {}, options);
		await bindMinister(recipe, options, "A", "minister-A");
		const flow = readControl(recipe, options);
		const identity = { 实例: flow.实例, 节点: "A", 轮次: 1, 部长会话: "minister-A" };
		await addNodeCards(recipe, options, identity, [{ goal: "失败夹具", acceptance: "存在: 产物.txt" }]);
		await endDecomposition(recipe, options, identity);
		f.runner.scripts.set("0001", () => ({
			...fakeReceipt("0001", "failed", [], f.repo),
			摘要: "失败夹具",
			失败类型: "瞬时故障",
		}));
		const toast = vi.spyOn(toastModule, "sendToast").mockResolvedValue(undefined);
		/** 工具面注册（带 owner 解析——v2 链入口核 owner）;返回注册面与其收敛口 */
		const register = (): { cap: Captured; face: { waitForAutoChain(): Promise<void> } } => {
			const cap = capturePi();
			const face = registerWorkflowTools(cap.pi, {
				resolvePaoHome: () => f.paoHome,
				resolveCardsDir: () => f.cardsDir,
				runner: f.runner,
				resolveOwnerSessionId: () => "owner",
			}) as unknown as { waitForAutoChain: () => Promise<void> };
			return { cap, face };
		};
		try {
			// 首次推流:失败停链叫人一次,去重键落控制正本（键=败:<节点>:<轮次>）
			const first = register();
			await toolOf(first.cap, "pao_push_flow").execute("t1", { name: "v2失败去重" });
			await first.face.waitForAutoChain();
			expect(toast).toHaveBeenCalledTimes(1);
			expect(toast.mock.calls[0]![0]).toContain("失败停链");
			expect(readControl(recipe, options).叫人).toBe("败:A:1"); // 红:现行 v2 不落盘,叫人 undefined
			// 同一失败现场再推流:不重弹
			await toolOf(first.cap, "pao_push_flow").execute("t2", { name: "v2失败去重" });
			await first.face.waitForAutoChain();
			expect(toast).toHaveBeenCalledTimes(1); // 红:现行 v2 恒判未叫过→重弹成 2 次
			// 模拟重启:全新注册一套工具,同失败现场仍不重弹——去重状态在盘上
			const restart = register();
			await toolOf(restart.cap, "pao_push_flow").execute("t3", { name: "v2失败去重" });
			await restart.face.waitForAutoChain();
			expect(toast).toHaveBeenCalledTimes(1);
		} finally {
			toast.mockRestore();
		}
	});

	it("K3 叫人键粒度:失败/人工门键带轮次(有轮次时)——同节点新轮次再失败换键允许再叫;无轮次(v1)键不变", () => {
		const failedNode = (名字: string, 轮次?: number): NodeReport => ({
			name: 名字,
			round: 轮次,
			status: "failed",
			manual_confirm: false,
		});
		const report = (节点: NodeReport[]): DriveReport => ({
			workflow: "w",
			status: "hold",
			created_cards: [],
			nodes: 节点,
		});
		expect(suspendCallHumanKey(report([failedNode("A", 1)]))).toBe("败:A:1");
		expect(suspendCallHumanKey(report([failedNode("A", 2)]))).toBe("败:A:2"); // 新轮次＝新失败现场
		expect(suspendCallHumanKey(report([failedNode("A")]))).toBe("败:A"); // v1 报告无轮次,键与既有一致
	});

	it("K3 通知面并入 T04 共用缓冲:共享实例时链终局与派卡通知一轮同段注入(不另起段)", async () => {
		const f = setup("通知合并", recipeYaml("通知合并", true, nodeYaml("A", "存在: 产物.txt")));
		f.scriptDefault(["产物.txt"]);
		// 宿主接线形状(src/pao/index.ts):worker 派卡通知与 workflow 链通知共用同一 surface 实例
		const shared = createDispatchNotifySurface({ resolvePaoHome: () => f.paoHome });
		const cap = capturePi();
		const face = registerWorkflowTools(cap.pi, {
			resolvePaoHome: () => f.paoHome,
			resolveCardsDir: () => f.cardsDir,
			runner: f.runner,
			notifySurface: shared,
		}) as unknown as { waitForAutoChain: () => Promise<void> };
		await toolOf(cap, "pao_start_flow").execute("t1", { name: "通知合并" });
		await face.waitForAutoChain();
		shared.notify("[派卡完成] 卡0001(成功)\n假派卡通知(模拟 worker 侧同一缓冲)");
		const sections = cap.fireBeforeAgentStart();
		const notice = sections[DISPATCH_NOTIFY_SECTION] ?? "";
		expect(notice).toContain("自动链完成");
		expect(notice).toContain("工作流「通知合并」");
		expect(notice).toContain("[派卡完成] 卡0001"); // 链终局与派卡通知同一段
		expect(Object.keys(sections).some((name) => name.includes("auto-chain"))).toBe(false); // 无独立链段
	});

	it("S6 链失败通知:后台链抛错(owner 不匹配)进通知缓冲＋toast,不只等下一次工具调用", async () => {
		const f = setup(
			"链失败",
			recipeYaml("链失败", true, nodeYaml("A", "存在: 产物.txt")).replace("---\n", "---\n版本: 2\n"),
		);
		// v2 无 drive:控制正本手起且 owner 与工具面不一致 → 受理快照(只读控制正本)通过,后台链抛错
		await startControl(
			loadRecipe(f.paoHome, "链失败"),
			{},
			{
				cardsDir: f.cardsDir,
				ownerSessionId: "real-owner",
			},
		);
		const toast = vi.spyOn(toastModule, "sendToast").mockResolvedValue(undefined);
		const accepted = textOf(await toolOf(f.captured, "pao_push_flow").execute("t1", { name: "链失败" }));
		expect(accepted).toContain("后台推进");
		await settleChains(f);
		const notice = chainNotice(f);
		expect(notice).toContain("自动链失败");
		expect(notice).toContain("owner");
		expect(toast).toHaveBeenCalledTimes(1);
		expect(toast.mock.calls[0]![0]).toContain("链失败");
		toast.mockRestore();
	});

	// ── 审查第 10 项：卡数上限逐卡核对（批内不再越限） ─────────────────────────

	it("第10项·v1 逐卡核上限:maxCards=1 时同批两就绪节点只受理一张,余卡保持可续跑", { timeout: 60_000 }, async () => {
		const f = setup(
			"逐卡上限",
			recipeYaml("逐卡上限", true, [
				...nodeYaml("A", "存在: 产物.txt"),
				...nodeYaml("B", "存在: 产物2.txt"), // 同层无依赖：一批里两个就绪节点
			]),
		);
		f.runner.scripts.set("0001", () => {
			writeFileSync(join(f.repo, "产物.txt"), "产物\n");
			return fakeReceipt("0001", "success", ["产物.txt"], f.repo);
		});
		f.runner.scripts.set("0002", () => {
			writeFileSync(join(f.repo, "产物2.txt"), "产物2\n");
			return fakeReceipt("0002", "success", ["产物2.txt"], f.repo);
		});
		const recipe = loadRecipe(f.paoHome, "逐卡上限");
		const options = { cardsDir: f.cardsDir, 运行器: f.runner, paoHome: f.paoHome };
		await startWorkflow(recipe, {}, options);
		const readCount = () =>
			parseManifest(readFileSync(join(f.repo, ".pao", "任务A", "工作流实例-逐卡上限.md"), "utf8")).已派卡;
		const first = await runAutoChain(recipe, { ...options, maxCards: 1 });
		// 旧实现只在批前看一次上限：批内两个就绪节点会一起派出去（实际跑 2 张）
		expect(f.runner.runs).toHaveLength(1);
		expect(readCount()).toBe(1);
		expect(first.stopReason).toContain("单次自动推进已达卡数上限 1");
		const unclaimed = ["0001", "0002"].filter((no) => cardAt(f.cardsDir, no).frontmatter.status === "unclaimed");
		expect(unclaimed).toHaveLength(1);
		const second = await runAutoChain(recipe, options);
		expect(f.runner.runs).toHaveLength(2);
		expect(second.report.status).toBe("completed");
		expect(readCount()).toBe(2);
	});

	it("第10项·v1 实例余量只剩一张时同批两就绪节点只再受理一张（累计不越过 50）", async () => {
		const f = setup(
			"逐卡实例",
			recipeYaml("逐卡实例", true, [...nodeYaml("A", "存在: 产物.txt"), ...nodeYaml("B", "存在: 产物2.txt")]),
		);
		f.runner.scripts.set("0001", () => {
			writeFileSync(join(f.repo, "产物.txt"), "产物\n");
			return fakeReceipt("0001", "success", ["产物.txt"], f.repo);
		});
		f.runner.scripts.set("0002", () => {
			writeFileSync(join(f.repo, "产物2.txt"), "产物2\n");
			return fakeReceipt("0002", "success", ["产物2.txt"], f.repo);
		});
		const recipe = loadRecipe(f.paoHome, "逐卡实例");
		const options = { cardsDir: f.cardsDir, 运行器: f.runner, paoHome: f.paoHome };
		await startWorkflow(recipe, {}, options);
		const manifestFile = join(f.repo, ".pao", "任务A", "工作流实例-逐卡实例.md");
		writeFileSync(
			manifestFile,
			readFileSync(manifestFile, "utf8").replace("状态: 运行中", "状态: 运行中\n已派卡: 49"),
		);
		const chain = await runAutoChain(recipe, options);
		// 旧实现会把这批两张都派出去：累计变 51，越过实例上限 50
		expect(f.runner.runs).toHaveLength(1);
		expect(parseManifest(readFileSync(manifestFile, "utf8")).已派卡).toBe(50);
		expect(chain.stopReason).toContain("实例累计");
		expect(chain.stopReason).toContain("卡数上限");
	});

	// ── 审查第 11 项：未获受理的预留额度要归还 ────────────────────────────────

	it("第11项·v1 权限拒派不永久扣账:连续三次推进额度仍为 0,卡保持未认领可续跑", async () => {
		const f = setup("额度归还", recipeYaml("额度归还", true, nodeYaml("A", "存在: 产物.txt")));
		f.scriptDefault(["产物.txt"]);
		const recipe = loadRecipe(f.paoHome, "额度归还");
		const options = { cardsDir: f.cardsDir, 运行器: f.runner, paoHome: f.paoHome };
		await startWorkflow(recipe, {}, options);
		const readCount = () =>
			parseManifest(readFileSync(join(f.repo, ".pao", "任务A", "工作流实例-额度归还.md"), "utf8")).已派卡;
		process.env.PAO_ROLE = "部长";
		process.env.PAO_DEPT = "别的部门";
		for (let i = 0; i < 3; i += 1) {
			const chain = await runAutoChain(recipe, options);
			expect(chain.stopReason).toContain("派发被拒");
		}
		expect(f.runner.runs).toHaveLength(0);
		expect(readCount()).toBe(0); // 旧实现每次先记后拒：这里会累计 3
		const card = cardAt(f.cardsDir, "0001");
		expect(card.frontmatter.status).toBe("unclaimed");
		expect(card.frontmatter.attempt).toBe(0);
		delete process.env.PAO_ROLE;
		delete process.env.PAO_DEPT;
		const resumed = await runAutoChain(recipe, { ...options, maxCards: 2 });
		expect(f.runner.runs).toHaveLength(1); // 额度没被吃掉：改回主控即照常派卡
		expect(resumed.report.status).toBe("completed");
	});

	it("第11项·v1 已受理后失败仍算已运行:计数器不回退", async () => {
		const f = setup("已派失败", recipeYaml("已派失败", true, nodeYaml("A", "存在: 产物.txt")));
		f.runner.scripts.set("0001", () => fakeReceipt("0001", "failed", [], f.repo));
		const recipe = loadRecipe(f.paoHome, "已派失败");
		const options = { cardsDir: f.cardsDir, 运行器: f.runner, paoHome: f.paoHome };
		await startWorkflow(recipe, {}, options);
		const chain = await runAutoChain(recipe, options);
		expect(chain.stopReason).toContain("失败");
		expect(cardAt(f.cardsDir, "0001").frontmatter.status).toBe("failed");
		// 已受理＝已运行：失败不退账（退账只针对「确定没派出去」）
		expect(parseManifest(readFileSync(join(f.repo, ".pao", "任务A", "工作流实例-已派失败.md"), "utf8")).已派卡).toBe(
			1,
		);
	});

	it("第11项·v2 权限拒派不永久扣账:三次推进控制正本已派卡为 0", async () => {
		const f = setup(
			"额度归还2",
			recipeYaml("额度归还2", true, nodeYaml("A", "存在: 产物.txt")).replace("---\n", "---\n版本: 2\n"),
		);
		const recipe = loadRecipe(f.paoHome, "额度归还2");
		const options = { cardsDir: f.cardsDir, paoHome: f.paoHome, ownerSessionId: "owner", 运行器: f.runner };
		await startControl(recipe, {}, options);
		await bindMinister(recipe, options, "A", "minister-A");
		const flow = readControl(recipe, options);
		const identity = { 实例: flow.实例, 节点: "A", 轮次: 1, 部长会话: "minister-A" };
		await addNodeCards(recipe, options, identity, [{ goal: "甲活", acceptance: "存在: 产物.txt" }]);
		await endDecomposition(recipe, options, identity);
		f.scriptDefault(["产物.txt"]);
		process.env.PAO_ROLE = "部长";
		process.env.PAO_DEPT = "别的部门";
		for (let i = 0; i < 3; i += 1) {
			const chain = await runAutoChain(recipe, options);
			expect(chain.stopReason).toContain("派发被拒");
		}
		expect(f.runner.runs).toHaveLength(0);
		expect(readControl(recipe, options).已派卡 ?? 0).toBe(0); // 旧实现这里会是 3
		expect(cardAt(f.cardsDir, "0001").frontmatter.status).toBe("unclaimed");
	});
});
