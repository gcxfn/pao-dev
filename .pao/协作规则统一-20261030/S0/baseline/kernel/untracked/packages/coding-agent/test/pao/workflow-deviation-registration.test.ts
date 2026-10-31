/** I1-3b-2：真实 worker 当前 attempt 自报未达进入无人值守结构化待决。 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "../../src/core/extensions/types.ts";
import { changeCardStatus, formatCardNumber, loadCard, parseCardRef } from "../../src/pao/cards/index.ts";
import type { TaskState } from "../../src/pao/cards/types.ts";
import { MinisterHost } from "../../src/pao/host/host.ts";
import type { DispatchNotifyEvent, DispatchNotifySurface } from "../../src/pao/worker/notify.ts";
import { completeDispatchedTask } from "../../src/pao/worker/post-dispatch.ts";
import type { WorkerReceipt } from "../../src/pao/worker/receipt.ts";
import { WorkerRunner, type WorkerRunOptions } from "../../src/pao/worker/runner.ts";
import { runAutoChain } from "../../src/pao/workflow/auto.ts";
import {
	addNodeCards,
	bindMinister,
	endDecomposition,
	readControl,
	recordPending,
	startControl,
} from "../../src/pao/workflow/control.ts";
import { type DriverOptions, startWorkflow } from "../../src/pao/workflow/driver.ts";
import { WorkflowHostBridge } from "../../src/pao/workflow/host-bridge.ts";
import { parseRecipe, type WorkflowRecipe } from "../../src/pao/workflow/recipe.ts";
import { registerWorkflowTools } from "../../src/pao/workflow/tools.ts";

const envKeys = ["PAO_HOME", "PI_OFFLINE", "PI_NO_LOCAL_LLM", "PAO_RUN_MODE"] as const;
const explicitPaoHome = process.env.PAO_HOME?.trim() || undefined;
const environmentBackup: Record<string, string | undefined> = Object.fromEntries(
	envKeys.map((key) => [key, process.env[key]]),
);
let isolatedParent = "";
let ownsIsolatedParent = false;
const roots: string[] = [];
const drains: (() => Promise<void>)[] = [];
const shutdowns: (() => Promise<void>)[] = [];

beforeEach(() => {
	isolatedParent = explicitPaoHome ? resolve(explicitPaoHome) : mkdtempSync(join(tmpdir(), "pao-I1-3b-2-"));
	ownsIsolatedParent = explicitPaoHome === undefined;
	mkdirSync(isolatedParent, { recursive: true });
	process.env.PAO_HOME = isolatedParent;
	process.env.PI_OFFLINE = "1";
	process.env.PI_NO_LOCAL_LLM = "1";
	delete process.env.PAO_RUN_MODE;
});

afterEach(async () => {
	for (const drain of drains.splice(0)) await drain();
	for (const shutdown of shutdowns.splice(0)) await shutdown();
	vi.restoreAllMocks();
	for (const key of envKeys) {
		const previous = environmentBackup[key];
		if (previous === undefined) delete process.env[key];
		else process.env[key] = previous;
	}
	for (const root of roots.splice(0)) {
		const normalized = resolve(root);
		if (!normalized.startsWith(`${isolatedParent}\\`) && !normalized.startsWith(`${isolatedParent}/`))
			throw new Error(`拒绝清理隔离 PAO_HOME 外路径：${root}`);
		// Windows 上刚结束的 git 子进程可能短暂占用 index/对象文件；限定在显式
		// 隔离 PAO_HOME 内的本轮目录，并让 Node 自带的有限重试处理短暂 EPERM/EBUSY。
		rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
	if (ownsIsolatedParent) {
		rmSync(isolatedParent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		ownsIsolatedParent = false;
	}
});

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-c", "core.quotepath=off", "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
		cwd,
		encoding: "utf8",
	});
}

function commitCount(root: string): number {
	return Number.parseInt(git(root, ["rev-list", "--all", "--count"]).trim(), 10);
}

class FakeRunner extends WorkerRunner {
	runs: WorkerRunOptions[] = [];
	script?: (options: WorkerRunOptions) => WorkerReceipt | Promise<WorkerReceipt>;

	override async run(options: WorkerRunOptions): Promise<WorkerReceipt> {
		this.runs.push(options);
		this.registry.register({
			pid: 910000 + this.runs.length,
			card_no: options.卡号,
			card_path: options.卡路径,
			attempt: options.尝试号,
			command: "fake-worker",
			dept: options.部门 ?? null,
			dispatch_reason: options.派单理由 ?? null,
		});
		if (!this.script) throw new Error("FakeRunner 未配置 worker 脚本");
		const receipt = await this.script(options);
		this.registry.markExited(910000 + this.runs.length);
		return receipt;
	}
}

function receiptFor(
	options: WorkerRunOptions,
	input: { taskState?: TaskState; artifact: string; evidence: string },
): WorkerReceipt {
	return {
		card_no: options.卡号,
		attempt: options.尝试号 ?? 1,
		status: "success",
		artifact_path: [input.artifact],
		summary: "真实产物已写，两项自报未达待逐项裁决",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
		evidence_path: input.evidence,
		exitCode: 0,
		command: "fake-worker",
		pid: -1,
		duration_ms: 1,
		...(input.taskState ? { 任务态: input.taskState } : {}),
		verification: [
			{ 条件: "条件甲", 结论: "fail", 证据: "甲命令失败证据" },
			{ 条件: "条件乙", 结论: "not_run", 证据: "乙未运行证据" },
		],
		changes: [{ 路径: input.artifact, 类型: "created", 说明: "真实写入" }],
	};
}

function notifySurfaceSpy(): { surface: DispatchNotifySurface; notify: ReturnType<typeof vi.fn> } {
	const notify = vi.fn();
	return {
		notify,
		surface: {
			notify,
			inject: vi.fn((_event: DispatchNotifyEvent) => undefined),
			markHandled: vi.fn(() => true),
			subscribe: vi.fn(() => () => undefined),
			shutdown: vi.fn(),
			unreadCount: vi.fn(() => 0),
			retainedCount: vi.fn(() => 0),
		},
	};
}

interface ToolFace {
	run(name: string, params: Record<string, unknown>): Promise<string>;
	background: ReturnType<typeof registerWorkflowTools>;
	shutdown: () => Promise<void>;
}

function setupTools(options: Parameters<typeof registerWorkflowTools>[1]): ToolFace {
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, ((event: unknown) => void | Promise<void>)[]>();
	const pi = {
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		registerCommand: vi.fn(),
		sendMessage: vi.fn(),
		on: (event: string, handler: (payload: unknown) => void | Promise<void>) =>
			handlers.set(event, [...(handlers.get(event) ?? []), handler]),
	} as unknown as ExtensionAPI;
	const background = registerWorkflowTools(pi, options);
	return {
		background,
		async run(name, params) {
			const tool = tools.get(name);
			if (!tool) throw new Error(`工具未注册：${name}`);
			const result = await tool.execute("worker-unmet-test", params, undefined, undefined, {
				hasUI: false,
				ui: { confirm: async () => false },
			} as unknown as ExtensionToolContext);
			return result.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("\n");
		},
		async shutdown() {
			const cleanups: (() => void | Promise<void>)[] = [];
			for (const handler of handlers.get("session_shutdown") ?? [])
				await handler({
					type: "session_shutdown",
					reason: "quit",
					onConfirmedShutdown: (cleanup: () => void | Promise<void>) => cleanups.push(cleanup),
				});
			for (const cleanup of cleanups) await cleanup();
		},
	};
}

interface Fixture {
	root: string;
	cardsDir: string;
	recipe: WorkflowRecipe;
	driver: DriverOptions;
	runner: FakeRunner;
	face: ToolFace;
	notify: ReturnType<typeof vi.fn>;
	cardRef: string;
}

async function fixture(input: {
	runMode?: "attended" | "unattended";
	acceptance?: string;
	taskState?: TaskState | null;
}): Promise<Fixture> {
	const root = mkdtempSync(join(isolatedParent, "worker-unmet-"));
	roots.push(root);
	writeFileSync(join(root, "已跟踪.txt"), "baseline\n");
	git(root, ["init", "--quiet"]);
	git(root, ["add", "--", "已跟踪.txt"]);
	git(root, ["commit", "--no-gpg-sign", "-qm", "baseline"]);
	const cardsDir = join(root, ".pao", "卡");
	mkdirSync(cardsDir, { recursive: true });
	const recipeName = `未达待决-${root.split(/[\\/]/).at(-1)}`;
	const recipe = parseRecipe(
		`---\n${stringify({
			版本: 2,
			名字: recipeName,
			自动执行: true,
			参数: [],
			节点: [{ 名字: "开发", 部门: "开发", 目标: "产出真实文件", 验收: input.acceptance ?? "存在: 产物.txt" }],
		})}---\n`,
		join(root, `${recipeName}.md`),
	);
	const runMode = input.runMode ?? "unattended";
	const driver: DriverOptions = {
		cardsDir,
		workspaceDir: join(root, ".pao"),
		ownerSessionId: "owner",
		runMode,
		now: () => "2026-10-30 10:10",
	};
	await startControl(recipe, {}, driver);
	await bindMinister(recipe, driver, "开发", "minister-开发");
	const flow = readControl(recipe, driver);
	const [cardRef] = await addNodeCards(
		recipe,
		driver,
		{ 实例: flow.实例, 节点: "开发", 轮次: 1, 部长会话: "minister-开发" },
		[{ goal: "产出", acceptance: input.acceptance ?? "存在: 产物.txt" }],
	);
	await endDecomposition(recipe, driver, {
		实例: flow.实例,
		节点: "开发",
		轮次: 1,
		部长会话: "minister-开发",
	});
	const runner = new FakeRunner();
	runner.script = (run) => {
		const executionRoot = run.executionRoot ?? root;
		const artifact = join(executionRoot, "产物.txt");
		const evidence = join(root, ".pao", "证据", `${run.卡号}-${run.尝试号 ?? 1}.jsonl`);
		mkdirSync(join(root, ".pao", "证据"), { recursive: true });
		writeFileSync(artifact, "真实产物\n");
		writeFileSync(evidence, '{"event":"worker-finished"}\n');
		return receiptFor(run, {
			taskState: input.taskState === null ? undefined : (input.taskState ?? "completed_with_deviations"),
			artifact: "产物.txt",
			evidence,
		});
	};
	const host = new MinisterHost();
	vi.spyOn(host, "hotSession").mockImplementation(
		() =>
			({
				会话标识: "minister-开发",
			}) as ReturnType<MinisterHost["hotSession"]>,
	);
	vi.spyOn(host, "inject").mockResolvedValue({ ok: true, 模式: "followUp", 处置: "queued" });
	const bridge = new WorkflowHostBridge(host);
	const { notify, surface } = notifySurfaceSpy();
	const face = setupTools({
		resolvePaoHome: () => isolatedParent,
		resolveCardsDir: () => cardsDir,
		resolveWorkspaceDir: () => join(root, ".pao"),
		resolveOwnerSessionId: () => "owner",
		resolveRunMode: () => runMode,
		runner,
		notifySurface: surface,
		driveDepartments: (loaded, options) => bridge.drive(loaded, options),
	});
	drains.push(() => face.background.waitForAutoChain());
	shutdowns.push(() => face.shutdown());
	return { root, cardsDir, recipe, driver, runner, face, notify, cardRef };
}

async function push(f: Fixture): Promise<string> {
	const text = await f.face.run("pao_push_flow", { name: f.recipe.名字 });
	await f.face.background.waitForAutoChain();
	return text;
}

async function v1Fixture(): Promise<{
	root: string;
	cardsDir: string;
	recipe: WorkflowRecipe;
	driver: DriverOptions & { paoHome: string };
	runner: FakeRunner;
	cardRef: string;
}> {
	const root = mkdtempSync(join(isolatedParent, "worker-unmet-v1-"));
	roots.push(root);
	writeFileSync(join(root, "已跟踪.txt"), "baseline\n");
	git(root, ["init", "--quiet"]);
	git(root, ["add", "--", "已跟踪.txt"]);
	git(root, ["commit", "--no-gpg-sign", "-qm", "baseline"]);
	const cardsDir = join(root, ".pao", "卡");
	const recipeName = `未达待决v1-${root.split(/[\\/]/).at(-1)}`;
	const recipeBody = `---\n${stringify({
		名字: recipeName,
		自动执行: true,
		参数: [],
		节点: [{ 名字: "开发", 部门: "开发", 目标: "产出真实文件", 验收: "存在: 产物.txt" }],
	})}---\n`;
	const paoHome = join(root, "pao-home");
	const recipePath = join(paoHome, "工作流", `${recipeName}.md`);
	mkdirSync(join(paoHome, "工作流"), { recursive: true });
	writeFileSync(recipePath, recipeBody);
	const recipe = parseRecipe(recipeBody, recipePath);
	const driver: DriverOptions & { paoHome: string } = {
		cardsDir,
		workspaceDir: join(root, ".pao"),
		paoHome,
		ownerSessionId: "owner",
		runMode: "unattended",
		now: () => "2026-10-30 10:10",
	};
	const started = await startWorkflow(recipe, {}, driver);
	const cardRef = started.nodes[0]?.card_no;
	if (!cardRef) throw new Error("v1 启动未落卡");
	const runner = new FakeRunner();
	runner.script = (run) => {
		const executionRoot = run.executionRoot ?? root;
		const artifact = join(executionRoot, "产物.txt");
		const evidence = join(root, ".pao", "证据", `${run.卡号}-${run.尝试号 ?? 1}.jsonl`);
		mkdirSync(join(root, ".pao", "证据"), { recursive: true });
		writeFileSync(artifact, "真实产物\n");
		writeFileSync(evidence, '{"event":"worker-finished"}\n');
		return receiptFor(run, {
			taskState: "completed_with_deviations",
			artifact: "产物.txt",
			evidence,
		});
	};
	return { root, cardsDir, recipe, driver, runner, cardRef };
}

describe("I1-3b-2 worker 自报未达进入无人值守待决", { timeout: 120_000 }, () => {
	it("真实第四轮参数混用指出 resolve_pending，拒绝 confirm 代办且允许主控改正后办理", async () => {
		const f = await fixture({ taskState: "completed" });
		await push(f);
		const before = readControl(f.recipe, f.driver);
		const pending = before.待决!;
		const decisions = pending.items.map((item) => ({
			item_ref: item.item_ref,
			basis: `已核对证据：${item.condition}`,
		}));
		const headBefore = git(f.root, ["rev-parse", "HEAD"]);
		await expect(
			f.face.run("pao_control_node", {
				name: f.recipe.名字,
				action: "confirm",
				instance: before.实例,
				node: pending.node,
				pending_key: pending.items[0]!.item_ref,
				decisions,
			}),
		).rejects.toThrow(/action=resolve_pending.*待决项编号/);
		expect(readControl(f.recipe, f.driver)).toEqual(before);
		expect(git(f.root, ["rev-parse", "HEAD"])).toBe(headBefore);
		expect(loadCard(f.cardsDir, parseCardRef(f.cardRef)).frontmatter.status).toBe("in_progress");
		const query = await f.face.run("pao_query_flow", { name: f.recipe.名字 });
		expect(query).toContain("action=resolve_pending");
		expect(query).toContain(`pending_key=${pending.key}`);
		const resolved = await f.face.run("pao_control_node", {
			name: f.recipe.名字,
			action: "resolve_pending",
			pending_key: pending.key,
			decisions,
		});
		await f.face.background.waitForAutoChain();
		expect(resolved).toContain("本次办理完成");
		expect(loadCard(f.cardsDir, parseCardRef(f.cardRef)).frontmatter.status).toBe("delivered");
	});

	it.each(["completed_with_deviations", "completed"] as const)(
		"真实 worker 两项 fail/not_run 自动登记，query 给出完整引用，一次办理后重放不重复提交或唤醒（任务态 %s）",
		async (taskState) => {
			const f = await fixture({ taskState });
			await push(f);
			const flow = readControl(f.recipe, f.driver);
			expect(flow.待决?.kind).toBe("普通偏差");
			expect(flow.待决?.channel).toBe("主控");
			expect(flow.待决?.items.map((item) => [item.condition, item.report, item.evidence])).toEqual([
				["条件甲", "fail", "甲命令失败证据"],
				["条件乙", "not_run", "乙未运行证据"],
			]);
			expect(flow.待决?.reason).toContain("证据文件：");
			expect(flow.待决?.reason).toContain("执行根：");
			expect(Date.parse(flow.待决!.deadline) - Date.parse(flow.待决!.created_at)).toBe(30 * 60 * 1000);
			expect(loadCard(f.cardsDir, parseCardRef(f.cardRef)).frontmatter.status).toBe("in_progress");

			const query = await f.face.run("pao_query_flow", { name: f.recipe.名字 });
			expect(query).toContain(`待决：${flow.待决!.key}`);
			const itemLine = query.split("\n").find((line) => line.startsWith("待决项："));
			expect(itemLine).toBeDefined();
			const itemRefs = itemLine!.slice("待决项：".length).split("、");
			expect(itemRefs).toEqual(flow.待决!.items.map((item) => item.item_ref));

			const beforeRepeat = readControl(f.recipe, f.driver);
			const noticeCount = f.notify.mock.calls.length;
			await recordPending(f.recipe, f.driver, structuredClone(beforeRepeat.待决!));
			const afterDuplicateEvent = readControl(f.recipe, f.driver);
			expect(afterDuplicateEvent.待决).toEqual(beforeRepeat.待决);
			expect(afterDuplicateEvent.暂停).toBe(beforeRepeat.暂停);
			expect(afterDuplicateEvent.记录.filter((record) => record.事件 === "登记普通偏差待决")).toHaveLength(1);
			expect(f.runner.runs).toHaveLength(1);
			const changedEvidence = structuredClone(beforeRepeat.待决!);
			changedEvidence.items[0]!.evidence = "与当前回执不一致的新证据";
			await expect(recordPending(f.recipe, f.driver, changedEvidence)).rejects.toThrow(
				"同一待决的当前 attempt 偏差项已变化",
			);

			await push(f);
			const afterRepeat = readControl(f.recipe, f.driver);
			expect(afterRepeat.待决).toEqual(beforeRepeat.待决);
			expect(afterRepeat.暂停).toBe(beforeRepeat.暂停);
			expect(afterRepeat.记录.filter((record) => record.事件 === "登记普通偏差待决")).toHaveLength(1);
			expect(f.runner.runs).toHaveLength(1);
			expect(f.notify).toHaveBeenCalledTimes(noticeCount);

			const resolveParams = {
				name: f.recipe.名字,
				action: "resolve_pending",
				pending_key: flow.待决!.key,
				decisions: itemRefs.map((item_ref, index) => ({
					item_ref,
					basis: index === 0 ? "复核失败命令及影响范围后接受当前成果" : "复核未运行原因及补偿证据后接受当前成果",
				})),
			};
			const beforeResolve = commitCount(f.root);
			const resolved = await f.face.run("pao_control_node", resolveParams);
			await f.face.background.waitForAutoChain();
			expect(resolved).toContain("本次办理完成");
			expect(resolved).toContain("交卷：已提交");
			expect(readControl(f.recipe, f.driver).待决).toBeUndefined();
			expect(loadCard(f.cardsDir, parseCardRef(f.cardRef)).frontmatter.status).toBe("delivered");
			const committed = commitCount(f.root);
			// 受控交付会另建不可变的边界提交与交付提交，故只断言首次办理产生了新提交，
			// 不把普通分支提交数量误当成公开交付契约。
			expect(committed).toBeGreaterThan(beforeResolve);
			const afterResolveNotices = f.notify.mock.calls.length;

			const replay = await f.face.run("pao_control_node", resolveParams);
			await f.face.background.waitForAutoChain();
			expect(replay).toContain("相同输入重放");
			expect(commitCount(f.root)).toBe(committed);
			expect(f.notify).toHaveBeenCalledTimes(afterResolveNotices);
		},
	);

	it("有人值守保持旧 owner 路径，不登记无人值守待决", async () => {
		const f = await fixture({ runMode: "attended" });
		await push(f);
		const flow = readControl(f.recipe, f.driver);
		expect(flow.待决).toBeUndefined();
		expect(flow.暂停).toBeUndefined();
		expect(loadCard(f.cardsDir, parseCardRef(f.cardRef)).frontmatter.status).toBe("in_progress");
		const query = await f.face.run("pao_query_flow", { name: f.recipe.名字 });
		expect(query).not.toContain("待决：");
	});

	it("v1 自动链保留原路径，即使宿主授权无人值守也不转发偏差登记", async () => {
		const f = await v1Fixture();
		const onUnmetReports = vi.fn();
		const chain = await runAutoChain(f.recipe, {
			...f.driver,
			运行器: f.runner,
			onUnmetReports,
		});
		expect(onUnmetReports).not.toHaveBeenCalled();
		expect(f.runner.runs).toHaveLength(1);
		expect(chain.stopReason).toContain("留 owner 逐项裁决");
		expect(loadCard(f.cardsDir, parseCardRef(f.cardRef)).frontmatter.status).toBe("in_progress");
	});

	it("机械失败落 failed 且不登记待决", async () => {
		const f = await fixture({ acceptance: "存在: 没有.txt" });
		await push(f);
		const flow = readControl(f.recipe, f.driver);
		expect(flow.待决).toBeUndefined();
		expect(loadCard(f.cardsDir, parseCardRef(f.cardRef)).frontmatter.status).toBe("failed");
	});

	it.each([null, "blocked", "checkpoint"] as const)("未知或未完成任务态 %s 不登记可放行待决", async (taskState) => {
		const f = await fixture({ taskState });
		await push(f);
		const flow = readControl(f.recipe, f.driver);
		expect(flow.待决).toBeUndefined();
		expect(loadCard(f.cardsDir, parseCardRef(f.cardRef)).frontmatter.status).toBe("in_progress");
	});

	it("旧 attempt 和执行器停止均在登记前拒绝", async () => {
		const wrong = await fixture({});
		const wrongCard = loadCard(wrong.cardsDir, parseCardRef(wrong.cardRef));
		changeCardStatus(wrongCard, {
			操作者: "owner",
			to: "in_progress",
			依据: "测试真实当前 attempt",
			时间: "2026-10-30 10:00",
		});
		const wrongCallback = vi.fn();
		const wrongReceipt = receiptFor(
			{ 卡号: formatCardNumber(wrongCard.card_no), 尝试号: 2, 提示词: "" },
			{ taskState: "completed_with_deviations", artifact: "产物.txt", evidence: join(wrong.root, "wrong.jsonl") },
		);
		const wrongReason = await completeDispatchedTask({
			cardsDir: wrong.cardsDir,
			cardRef: wrong.cardRef,
			operator: "owner",
			runner: wrong.runner,
			receipt: wrongReceipt,
			onUnmetReports: wrongCallback,
		});
		expect(wrongReason).toContain("尝试已变化");
		expect(wrongCallback).not.toHaveBeenCalled();
		expect(readControl(wrong.recipe, wrong.driver).待决).toBeUndefined();

		const stopped = await fixture({});
		const stoppedCard = loadCard(stopped.cardsDir, parseCardRef(stopped.cardRef));
		changeCardStatus(stoppedCard, {
			操作者: "owner",
			to: "in_progress",
			依据: "测试执行器停止",
			时间: "2026-10-30 10:00",
		});
		await stopped.runner.stopAll();
		const stoppedCallback = vi.fn();
		const stoppedReceipt = receiptFor(
			{ 卡号: formatCardNumber(stoppedCard.card_no), 尝试号: stoppedCard.frontmatter.attempt, 提示词: "" },
			{
				taskState: "completed_with_deviations",
				artifact: "产物.txt",
				evidence: join(stopped.root, "stopped.jsonl"),
			},
		);
		const stoppedReason = await completeDispatchedTask({
			cardsDir: stopped.cardsDir,
			cardRef: stopped.cardRef,
			operator: "owner",
			runner: stopped.runner,
			receipt: stoppedReceipt,
			onUnmetReports: stoppedCallback,
		});
		expect(stoppedReason).toContain("执行器已全停");
		expect(stoppedCallback).not.toHaveBeenCalled();
		expect(readControl(stopped.recipe, stopped.driver).待决).toBeUndefined();
	});
});
