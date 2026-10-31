/** I1-4a：可信无人值守待决由真实宿主生命周期安排一次性到期处理。 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { changeCardStatus, loadCard, parseCardRef } from "../../src/pao/cards/index.ts";
import type { TaskState } from "../../src/pao/cards/types.ts";
import { MinisterHost } from "../../src/pao/host/host.ts";
import type { DispatchNotifyCategory } from "../../src/pao/worker/notify.ts";
import type { WorkerReceipt } from "../../src/pao/worker/receipt.ts";
import { WorkerRunner, type WorkerRunOptions } from "../../src/pao/worker/runner.ts";
import type { AutoChainOptions, AutoChainReport } from "../../src/pao/workflow/auto.ts";
import {
	addNodeCards,
	bindMinister,
	controlPath,
	endDecomposition,
	expirePending,
	type PendingExpirationExpectation,
	pauseControlIfUnpaused,
	readControl,
	resolvePendingOnce,
	startControl,
} from "../../src/pao/workflow/control.ts";
import { WorkflowHostBridge } from "../../src/pao/workflow/host-bridge.ts";
import { parseRecipe, type WorkflowRecipe } from "../../src/pao/workflow/recipe.ts";
import { queryWorkflowCore } from "../../src/pao/workflow/tools.ts";
import { parseFrontmatter } from "../../src/utils/frontmatter.ts";

const ENV_KEYS = ["PAO_HOME", "PI_OFFLINE", "PI_NO_LOCAL_LLM", "PAO_RUN_MODE"] as const;
const explicitPaoHome = process.env.PAO_HOME?.trim() || undefined;
const environmentBackup: Record<string, string | undefined> = Object.fromEntries(
	ENV_KEYS.map((key) => [key, process.env[key]]),
);
const roots: string[] = [];
const bridges: WorkflowHostBridge[] = [];
const runners: WorkerRunner[] = [];
let isolatedParent = "";
let ownsIsolatedParent = false;

beforeEach(() => {
	isolatedParent = explicitPaoHome ? resolve(explicitPaoHome) : mkdtempSync(join(tmpdir(), "pao-I1-4a-"));
	ownsIsolatedParent = explicitPaoHome === undefined;
	mkdirSync(isolatedParent, { recursive: true });
	process.env.PAO_HOME = isolatedParent;
	process.env.PI_OFFLINE = "1";
	process.env.PI_NO_LOCAL_LLM = "1";
	delete process.env.PAO_RUN_MODE;
});

afterEach(async () => {
	const failures: unknown[] = [];
	vi.useRealTimers();
	for (const bridge of bridges.splice(0).reverse()) {
		try {
			await bridge.shutdown();
		} catch (error) {
			failures.push(error);
		}
	}
	for (const runner of runners.splice(0).reverse()) {
		try {
			await runner.stopAll();
		} catch (error) {
			failures.push(error);
		}
	}
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) {
		const previous = environmentBackup[key];
		if (previous === undefined) delete process.env[key];
		else process.env[key] = previous;
	}
	for (const root of roots.splice(0)) {
		const normalized = resolve(root);
		if (!normalized.startsWith(`${isolatedParent}\\`) && !normalized.startsWith(`${isolatedParent}/`))
			throw new Error(`拒绝清理隔离 PAO_HOME 外路径：${root}`);
		rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
	if (ownsIsolatedParent) {
		rmSync(isolatedParent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		ownsIsolatedParent = false;
	}
	if (failures.length) throw new AggregateError(failures, "I1-4a 测试收尾失败");
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
	taskState: TaskState = "completed_with_deviations";

	override async run(options: WorkerRunOptions): Promise<WorkerReceipt> {
		this.runs.push(options);
		const pid = 920000 + this.runs.length;
		this.registry.register({
			pid,
			card_no: options.卡号,
			card_path: options.卡路径,
			attempt: options.尝试号,
			command: "fake-worker",
			dept: options.部门 ?? null,
			dispatch_reason: options.派单理由 ?? null,
		});
		const executionRoot = options.executionRoot ?? process.cwd();
		const artifact = join(executionRoot, "产物.txt");
		const evidenceDir = join(this.projectRootForEvidence(), ".pao", "证据");
		const evidence = join(evidenceDir, `${options.卡号}-${options.尝试号 ?? 1}.jsonl`);
		mkdirSync(evidenceDir, { recursive: true });
		writeFileSync(artifact, `真实产物 card ${options.卡号} attempt ${options.尝试号 ?? 1}\n`);
		writeFileSync(evidence, '{"event":"worker-finished"}\n');
		const receipt = this.receipt(options, artifact, evidence);
		this.registry.markExited(pid);
		return receipt;
	}

	projectRootForEvidence(): string {
		return this.runs[0]?.taskRoot ?? process.cwd();
	}

	receipt(options: WorkerRunOptions, _artifact: string, evidence: string): WorkerReceipt {
		const taskState = this.taskState;
		return {
			card_no: options.卡号,
			attempt: options.尝试号 ?? 1,
			status: "success",
			artifact_path: ["产物.txt"],
			summary: "真实产物已写，两项自报未达待逐项裁决",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			evidence_path: evidence,
			exitCode: 0,
			command: "fake-worker",
			pid: -1,
			duration_ms: 1,
			任务态: taskState,
			verification: [
				{ 条件: "条件甲", 结论: "fail", 证据: "甲命令失败证据" },
				{ 条件: "条件乙", 结论: "not_run", 证据: "乙未运行证据" },
			],
			changes: [
				{
					路径: "产物.txt",
					类型: this.runs.length === 1 ? "created" : "modified",
					说明: "真实写入",
				},
			],
		};
	}
}

interface Clock {
	value: string;
}

interface Fixture {
	root: string;
	cardsDir: string;
	recipe: WorkflowRecipe;
	options: AutoChainOptions;
	runner: FakeRunner;
	host: MinisterHost;
	bridge: WorkflowHostBridge;
	deadlineNotify: ReturnType<typeof vi.fn>;
	clock: Clock;
	cardRef: string;
	cardAttempt: number;
	drive: () => Promise<AutoChainReport>;
}

async function fixture(
	input: { runMode?: "attended" | "unattended"; clock?: Clock; taskState?: TaskState } = {},
): Promise<Fixture> {
	const root = mkdtempSync(join(isolatedParent, "deadline-"));
	roots.push(root);
	writeFileSync(join(root, "已跟踪.txt"), "baseline\n");
	git(root, ["init", "--quiet"]);
	git(root, ["add", "--", "已跟踪.txt"]);
	git(root, ["commit", "--no-gpg-sign", "-qm", "baseline"]);
	const cardsDir = join(root, ".pao", "卡");
	mkdirSync(cardsDir, { recursive: true });
	const clock = input.clock ?? { value: "2026-10-30 10:00" };
	const recipeName = `截止生命周期-${root.split(/[\\/]/).at(-1)}`;
	const recipe = parseRecipe(
		`---\n${stringify({
			版本: 2,
			名字: recipeName,
			自动执行: true,
			参数: [],
			节点: [{ 名字: "开发", 部门: "开发", 目标: "产出真实文件", 验收: "存在: 产物.txt" }],
		})}---\n`,
		join(root, `${recipeName}.md`),
	);
	const runMode = input.runMode ?? "unattended";
	const driver = {
		cardsDir,
		workspaceDir: join(root, ".pao"),
		ownerSessionId: "owner",
		runMode,
		now: () => clock.value,
	};
	await startControl(recipe, {}, driver);
	await bindMinister(recipe, driver, "开发", "minister-开发");
	const flow = readControl(recipe, driver);
	const [cardRef] = await addNodeCards(
		recipe,
		driver,
		{ 实例: flow.实例, 节点: "开发", 轮次: 1, 部长会话: "minister-开发" },
		[{ goal: "产出", acceptance: "存在: 产物.txt" }],
	);
	await endDecomposition(recipe, driver, {
		实例: flow.实例,
		节点: "开发",
		轮次: 1,
		部长会话: "minister-开发",
	});
	const cardAttempt = loadCard(cardsDir, parseCardRef(cardRef)).frontmatter.attempt;
	const runner = new FakeRunner();
	runner.taskState = input.taskState ?? "completed_with_deviations";
	runners.push(runner);
	const host = new MinisterHost();
	vi.spyOn(host, "hotSession").mockImplementation(
		() => ({ 会话标识: "minister-开发" }) as ReturnType<MinisterHost["hotSession"]>,
	);
	vi.spyOn(host, "inject").mockResolvedValue({ ok: true, 模式: "followUp", 处置: "queued" });
	const bridge = new WorkflowHostBridge(host);
	bridges.push(bridge);
	const deadlineNotify = vi.fn((_body: string, _category: DispatchNotifyCategory) => undefined);
	bridge.setDeadlineNotifier(deadlineNotify);
	const options: AutoChainOptions = {
		...driver,
		运行器: runner,
		paoHome: isolatedParent,
		hostHasUI: false,
	};
	return {
		root,
		cardsDir,
		recipe,
		options,
		runner,
		host,
		bridge,
		deadlineNotify,
		clock,
		cardRef,
		cardAttempt,
		drive: () => bridge.drive(recipe, options),
	};
}

function enableTimerControl(): void {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

async function settleRuntime(): Promise<void> {
	for (let index = 0; index < 12; index++) {
		await Promise.resolve();
		await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
	}
}

function cardClockTime(value: string): string {
	const date = new Date(value);
	const pad = (part: number) => String(part).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function advanceLifecycle(milliseconds: number, clock: Clock, to: string): Promise<void> {
	clock.value = cardClockTime(to);
	await vi.advanceTimersByTimeAsync(milliseconds);
	await settleRuntime();
}

async function waitForCondition(condition: () => boolean, description: string): Promise<void> {
	const timeoutAt = Date.now() + 5_000;
	while (Date.now() < timeoutAt) {
		if (condition()) return;
		await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
	}
	throw new Error(`等待超时：${description}`);
}

function decisionsFor(f: Fixture) {
	const pending = readControl(f.recipe, f.options).待决;
	if (!pending) throw new Error("测试夹具没有待决");
	return pending.items.map((item) => ({
		item_ref: item.item_ref,
		basis: `复核 ${item.condition} 的当前回执与证据后作出明确裁决`,
	}));
}

function expectationOf(f: Fixture): PendingExpirationExpectation {
	const pending = readControl(f.recipe, f.options).待决;
	if (!pending) throw new Error("测试夹具没有待决");
	return {
		instance: pending.instance,
		key: pending.key,
		node: pending.node,
		round: pending.round,
		...(pending.card_ref !== undefined ? { card_ref: pending.card_ref } : {}),
		...(pending.attempt !== undefined ? { attempt: pending.attempt } : {}),
		deadline: pending.deadline,
	};
}

describe("I1-4a 待决截止宿主生命周期", { timeout: 120_000 }, () => {
	it.each(["completed_with_deviations", "completed"] as const)(
		"真实 bridge 自动触发到期，保留现场并拒绝迟到裁决（%s）",
		async (taskState) => {
			const f = await fixture({ taskState });
			enableTimerControl();
			const beforeRunCommits = commitCount(f.root);
			await f.drive();
			const flow = readControl(f.recipe, f.options);
			const pending = flow.待决;
			expect(pending?.phase).toBe("待处理");
			expect(f.runner.runs).toHaveLength(1);
			expect(vi.getTimerCount()).toBeGreaterThan(0);
			const timerCount = vi.getTimerCount();
			const pauseBefore = flow.暂停;
			const queryBefore = await queryWorkflowCore(f.recipe, f.options);
			expect(queryBefore).toContain(`待决：${pending!.key}`);
			for (const item of pending!.items) expect(queryBefore).toContain(item.item_ref);

			await f.drive();
			expect(vi.getTimerCount()).toBe(timerCount);
			const controlBeforeMismatch = readFileSync(controlPath(f.recipe, f.options), "utf8");
			const resultCountBeforeMismatch = readControl(f.recipe, f.options).结果?.length ?? 0;
			const wrongExpectation = { ...expectationOf(f), key: "普通偏差:old-instance:开发:1:card-0001:attempt-1" };
			await expect(expirePending(f.recipe, f.options, wrongExpectation)).resolves.toBeUndefined();
			expect(readFileSync(controlPath(f.recipe, f.options), "utf8")).toBe(controlBeforeMismatch);
			expect(readControl(f.recipe, f.options).结果?.length ?? 0).toBe(resultCountBeforeMismatch);

			const deadline = Date.parse(pending!.deadline);
			const created = Date.parse(pending!.created_at);
			await advanceLifecycle(deadline - created - 1, f.clock, new Date(deadline - 1).toISOString());
			expect(readControl(f.recipe, f.options).待决?.phase).toBe("待处理");
			expect(f.deadlineNotify).not.toHaveBeenCalled();

			await advanceLifecycle(1, f.clock, new Date(deadline).toISOString());
			await waitForCondition(
				() => readControl(f.recipe, f.options).待决?.phase === "已过期" && f.deadlineNotify.mock.calls.length === 1,
				"真实 bridge 到点自动过期",
			);
			const expiredFlow = readControl(f.recipe, f.options);
			expect(expiredFlow.待决).toMatchObject({ key: pending!.key, phase: "已过期" });
			expect(expiredFlow.暂停).toBe(pauseBefore);
			expect(expiredFlow.结果).toEqual([
				expect.objectContaining({
					state: "failed",
					pending_key: pending!.key,
					writer_stop_confirmed: false,
				}),
			]);
			expect(loadCard(f.cardsDir, parseCardRef(f.cardRef)).frontmatter).toMatchObject({
				status: "in_progress",
				attempt: pending!.attempt,
			});
			expect(f.runner.runs).toHaveLength(1);
			expect(commitCount(f.root)).toBe(beforeRunCommits);
			expect(f.deadlineNotify).toHaveBeenCalledTimes(1);
			const [notice, category] = f.deadlineNotify.mock.calls[0]!;
			expect(category).toBe("ruling");
			expect(notice).toContain(`pending_key：${pending!.key}`);
			expect(notice).toContain("未将到期视为接受或已完成");
			expect(notice).toContain("卡、暂停、人工门和执行占位均保留");
			expect(notice).toContain("请主控立即核对现场并显式人工恢复");

			await expect(
				resolvePendingOnce(f.recipe, f.options, {
					pending_key: pending!.key,
					decisions: decisionsFor(f),
				}),
			).rejects.toThrow(/已到截止时间|待决阶段为 已过期/);
			const afterLate = readControl(f.recipe, f.options);
			expect(afterLate.结果).toHaveLength(1);
			await f.drive();
			expect(f.deadlineNotify).toHaveBeenCalledTimes(1);
			expect(readControl(f.recipe, f.options).结果).toHaveLength(1);
		},
	);

	it("正常办理后的 drive 入口取消计时器，不追加到期结果或通知", async () => {
		const f = await fixture();
		enableTimerControl();
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		await f.drive();
		const pending = readControl(f.recipe, f.options).待决;
		expect(pending?.phase).toBe("待处理");
		const deadlineTimerIndex = setTimeoutSpy.mock.calls.findIndex(
			([, milliseconds]) => milliseconds === Date.parse(pending!.deadline) - Date.parse(pending!.created_at),
		);
		expect(deadlineTimerIndex).toBeGreaterThanOrEqual(0);
		const deadlineTimer = setTimeoutSpy.mock.results[deadlineTimerIndex]?.value;
		const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
		const resolved = await resolvePendingOnce(f.recipe, f.options, {
			pending_key: pending!.key,
			decisions: decisionsFor(f),
		});
		expect(resolved.stage).toBe("completed");
		expect(readControl(f.recipe, f.options).待决).toBeUndefined();
		await f.drive();
		expect(clearTimeoutSpy).toHaveBeenCalledWith(deadlineTimer);
		const commitsAfterResolve = commitCount(f.root);
		const deadline = Date.parse(pending!.deadline);
		const created = Date.parse(pending!.created_at);
		await advanceLifecycle(deadline - created, f.clock, new Date(deadline).toISOString());
		const afterDeadline = readControl(f.recipe, f.options);
		expect(afterDeadline.待决).toBeUndefined();
		expect(afterDeadline.结果?.some((result) => result.pending_key === pending!.key) ?? false).toBe(false);
		expect(afterDeadline.暂停).toBeUndefined();
		expect(loadCard(f.cardsDir, parseCardRef(f.cardRef)).frontmatter.status).toBe("delivered");
		expect(commitCount(f.root)).toBe(commitsAfterResolve);
		expect(f.deadlineNotify).not.toHaveBeenCalled();
	});

	it("shutdown 清除计时器，新 bridge 重启不扫描或恢复旧待决", async () => {
		const f = await fixture();
		enableTimerControl();
		await f.drive();
		const pending = readControl(f.recipe, f.options).待决!;
		await f.bridge.shutdown();
		expect(vi.getTimerCount()).toBe(0);
		const restartedNotify = vi.fn((_body: string, _category: DispatchNotifyCategory) => undefined);
		const restarted = new WorkflowHostBridge(f.host);
		bridges.push(restarted);
		restarted.setDeadlineNotifier(restartedNotify);

		const deadline = Date.parse(pending.deadline);
		const created = Date.parse(pending.created_at);
		await advanceLifecycle(deadline - created, f.clock, new Date(deadline).toISOString());
		const afterRestart = readControl(f.recipe, f.options);
		expect(afterRestart.待决).toMatchObject({ key: pending.key, phase: "待处理" });
		expect(afterRestart.结果).toBeUndefined();
		expect(f.deadlineNotify).not.toHaveBeenCalled();
		expect(restartedNotify).not.toHaveBeenCalled();
	});

	it("实例变化后 drive 入口取消旧计时器，不触碰历史现场", async () => {
		const f = await fixture();
		enableTimerControl();
		await f.drive();
		const oldPending = readControl(f.recipe, f.options).待决!;
		const currentPath = controlPath(f.recipe, f.options);
		const historyPath = join(f.root, ".pao", "历史-工作流实例.md");
		renameSync(currentPath, historyPath);
		f.clock.value = cardClockTime(new Date(Date.parse(f.clock.value) + 60_000).toISOString());
		await startControl(f.recipe, {}, f.options);
		await pauseControlIfUnpaused(f.recipe, f.options, "实例变化测试保留现场");
		const newInstance = readControl(f.recipe, f.options).实例;
		expect(newInstance).not.toBe(oldPending.instance);

		await f.drive();
		expect(vi.getTimerCount()).toBe(0);
		const deadline = Date.parse(oldPending.deadline);
		const now = Date.parse(f.clock.value);
		await advanceLifecycle(deadline - now, f.clock, new Date(deadline).toISOString());
		const historical = parseFrontmatter<{ 待决?: { phase?: string } }>(readFileSync(historyPath, "utf8"));
		expect(historical.frontmatter.待决?.phase).toBe("待处理");
		expect(readControl(f.recipe, f.options).待决).toBeUndefined();
		expect(f.deadlineNotify).not.toHaveBeenCalled();
	});

	it("旧实例计时器晚到时不伤新实例的新 pending key", async () => {
		const f = await fixture();
		enableTimerControl();
		await f.drive();
		const oldPending = readControl(f.recipe, f.options).待决!;
		const twentyMinutes = 20 * 60 * 1000;
		await advanceLifecycle(twentyMinutes, f.clock, new Date(Date.parse(f.clock.value) + twentyMinutes).toISOString());

		const currentPath = controlPath(f.recipe, f.options);
		const historyPath = join(f.root, ".pao", "旧实例-工作流实例.md");
		const previousCard = loadCard(f.cardsDir, parseCardRef(f.cardRef));
		if (!previousCard.frontmatter.owner) throw new Error("旧卡缺少明确 owner");
		changeCardStatus(previousCard, {
			操作者: previousCard.frontmatter.owner,
			to: "canceled",
			时间: f.clock.value,
			依据: "测试模拟人工明确终止旧任务后建立新实例，不自动恢复旧卡",
		});
		renameSync(currentPath, historyPath);
		await startControl(f.recipe, {}, f.options);
		await bindMinister(f.recipe, f.options, "开发", "minister-开发");
		const newFlow = readControl(f.recipe, f.options);
		const [newCardRef] = await addNodeCards(
			f.recipe,
			f.options,
			{ 实例: newFlow.实例, 节点: "开发", 轮次: 1, 部长会话: "minister-开发" },
			[{ goal: "新现场", acceptance: "存在: 产物.txt" }],
		);
		await endDecomposition(f.recipe, f.options, {
			实例: newFlow.实例,
			节点: "开发",
			轮次: 1,
			部长会话: "minister-开发",
		});

		const newNotify = vi.fn((_body: string, _category: DispatchNotifyCategory) => undefined);
		const newBridge = new WorkflowHostBridge(f.host);
		bridges.push(newBridge);
		newBridge.setDeadlineNotifier(newNotify);
		await newBridge.drive(f.recipe, f.options);
		const drivenFlow = readControl(f.recipe, f.options);
		const livePending = drivenFlow.待决!;
		expect(livePending?.phase).toBe("待处理");
		expect(drivenFlow.暂停).toContain(livePending.key);
		expect(drivenFlow.实例).not.toBe(oldPending.instance);
		expect(livePending.key).not.toBe(oldPending.key);
		expect(livePending.card_ref).toBe(newCardRef);

		const oldDeadline = Date.parse(oldPending.deadline);
		const now = Date.parse(f.clock.value);
		const liveFileBefore = readFileSync(currentPath, "utf8");
		await advanceLifecycle(oldDeadline - now, f.clock, new Date(oldDeadline).toISOString());
		expect(readFileSync(currentPath, "utf8")).toBe(liveFileBefore);
		expect(readControl(f.recipe, f.options).待决).toEqual(livePending);
		expect(f.deadlineNotify).not.toHaveBeenCalled();
		expect(newNotify).not.toHaveBeenCalled();
		const historical = parseFrontmatter<{ 待决?: { phase?: string } }>(readFileSync(historyPath, "utf8"));
		expect(historical.frontmatter.待决?.phase).toBe("待处理");
	});

	it("到期回调异常保留原始定位并发送失败通知", async () => {
		const f = await fixture();
		enableTimerControl();
		await f.drive();
		const pending = readControl(f.recipe, f.options).待决!;
		const path = controlPath(f.recipe, f.options);
		const original = readFileSync(path, "utf8");
		try {
			writeFileSync(path, "---\n版本: 3\n---\n", "utf8");
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
			const deadline = Date.parse(pending.deadline);
			const created = Date.parse(pending.created_at);
			await advanceLifecycle(deadline - created, f.clock, new Date(deadline).toISOString());
			await waitForCondition(() => errorSpy.mock.calls.length === 1, "到期异常日志");
			expect(errorSpy).toHaveBeenCalledTimes(1);
			expect(String(errorSpy.mock.calls[0]?.[0])).toContain("工作流待决截止自动处理失败");
			expect(String(errorSpy.mock.calls[0]?.[0])).toContain("FLOW_CONTROL");
			expect(f.deadlineNotify).toHaveBeenCalledTimes(1);
			expect(f.deadlineNotify.mock.calls[0]?.[1]).toBe("failure");
			expect(f.deadlineNotify.mock.calls[0]?.[0]).toContain("现场未自动恢复");
		} finally {
			writeFileSync(path, original, "utf8");
		}
	});

	it("attended 保持旧 owner 路径，不登记待决或安排截止计时器", async () => {
		const f = await fixture({ runMode: "attended" });
		enableTimerControl();
		await f.drive();
		const flow = readControl(f.recipe, f.options);
		expect(flow.待决).toBeUndefined();
		expect(flow.结果).toBeUndefined();
		expect(f.runner.runs).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
		const deadline = "2026-10-30T02:30:00.000Z";
		await advanceLifecycle(30 * 60 * 1000, f.clock, deadline);
		expect(readControl(f.recipe, f.options).待决).toBeUndefined();
		expect(f.deadlineNotify).not.toHaveBeenCalled();
	});
});
