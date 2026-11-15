import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import {
	type CardCreateInput,
	changeCardStatus,
	createCard,
	type ParsedCard,
	readCard,
} from "../../src/pao/cards/index.ts";
import { executeFanout } from "../../src/pao/fanout/execute.ts";
import { registerFanout } from "../../src/pao/fanout/index.ts";
import { planFanout } from "../../src/pao/fanout/plan.ts";
import {
	appendDispatchReceipt,
	executeDispatch,
	locateDispatchCard,
	readDispatchTimeoutMs,
	remainingDispatchBudget,
	resolveDispatchParameters,
} from "../../src/pao/worker/dispatch-core.ts";
import { PaoWorkerError } from "../../src/pao/worker/errors.ts";
import { registerWorkerTools } from "../../src/pao/worker/index.ts";
import {
	acquireProjectLock,
	isExecutionLocked,
	isProjectLocked,
	releaseProjectLock,
} from "../../src/pao/worker/lock.ts";
import type { WorkerReceipt } from "../../src/pao/worker/receipt.ts";
import { buildArgs, type StopProof, WorkerRunner, type WorkerRunOptions } from "../../src/pao/worker/runner.ts";
import { killTree } from "../../src/utils/kill-tree.ts";
import { fireSessionShutdownHandlers } from "./fixtures/session-shutdown.ts";

const dirs: string[] = [];
const runners: WorkerRunner[] = [];
const shutdowns: (() => unknown)[] = [];
afterEach(async () => {
	for (const runner of runners.splice(0)) await runner.stopAll();
	await fireSessionShutdownHandlers(shutdowns.splice(0));
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-runtime-guards-"));
	dirs.push(dir);
	return dir;
}
async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("等待真实子进程超时");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}
async function card(cardsDir: string, extra: Partial<CardCreateInput> = {}): Promise<ParsedCard> {
	mkdirSync(cardsDir, { recursive: true });
	return createCard(
		cardsDir,
		{ 目标: "离线任务", 部门: "测试", 验收: "完成", 创建: "2026-10-03 10:00", ...extra },
		{ counterPath: join(cardsDir, "..", "卡号.txt") },
	);
}
function receipt(options: WorkerRunOptions): WorkerReceipt {
	return {
		card_no: options.卡号,
		card_path: options.卡路径,
		attempt: options.尝试号 ?? 1,
		status: "success",
		artifact_path: [],
		summary: "离线假回执",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
		工具调用次数: 0,
		evidence_path: "",
		exitCode: 0,
		command: "mock",
		pid: -1,
		duration_ms: 1,
	};
}
class MockRunner extends WorkerRunner {
	runs: WorkerRunOptions[] = [];
	active = 0;
	peak = 0;
	slots = 0;
	override async reserveDispatchSlot(input: Parameters<WorkerRunner["reserveDispatchSlot"]>[0]): Promise<() => void> {
		const release = await super.reserveDispatchSlot(input);
		this.slots++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.slots--;
			release();
		};
	}
	override async run(options: WorkerRunOptions): Promise<WorkerReceipt> {
		this.runs.push(options);
		this.peak = Math.max(this.peak, ++this.active);
		try {
			await new Promise((done) => setTimeout(done, 30));
			return receipt(options);
		} finally {
			this.active--;
		}
	}
}
function toolFor(runner: WorkerRunner, cardsDir: string, toolName = "pao_dispatch_card") {
	let dispatch:
		| {
				execute: (
					...args: unknown[]
				) => Promise<{ isError?: boolean; content: { text?: string }[]; details: unknown }>;
		  }
		| undefined;
	const pi = {
		registerTool: (tool: {
			name: string;
			execute: (
				...args: unknown[]
			) => Promise<{ isError?: boolean; content: { text?: string }[]; details: unknown }>;
		}) => {
			if (tool.name === toolName) dispatch = tool;
		},
		on: (event: string, handler: () => unknown) => {
			if (event === "session_shutdown") shutdowns.push(handler);
			return () => {};
		},
	} as unknown as ExtensionAPI;
	registerWorkerTools(pi, { runner, signals: false, resolveCardsDir: () => cardsDir });
	if (toolName === "pao_fanout")
		registerFanout(pi, { runner, resolveCardsDir: () => cardsDir, 公共参数: { 工具白名单: ["read"] } });
	if (!dispatch) throw new Error(`没有工具 ${toolName}`);
	return dispatch;
}

/**
 * B 档非阻塞观测夹具:toolFor 之外还要 backgroundCount/waitForBackground 观测面与 before_agent_start 注入读取。
 * 读取注入() 触发全部已注册 before_agent_start 处理器(共享 sections 累积),返回各段文本——
 * 通知缓冲是消费式(注入即清空),每次调用读到的都是「自上次以来」的新通知。
 */
function backgroundHarness(runner: WorkerRunner, cardsDir: string, toolName = "pao_dispatch_card") {
	let dispatch:
		| {
				execute: (
					...args: unknown[]
				) => Promise<{ isError?: boolean; content: { text?: string }[]; details: unknown }>;
		  }
		| undefined;
	const injectionHandler: ((event: unknown) => unknown)[] = [];
	const pi = {
		registerTool: (tool: {
			name: string;
			execute: (
				...args: unknown[]
			) => Promise<{ isError?: boolean; content: { text?: string }[]; details: unknown }>;
		}) => {
			if (tool.name === toolName) dispatch = tool;
		},
		on: (event: string, handler: () => unknown) => {
			if (event === "session_shutdown") shutdowns.push(handler);
			if (event === "before_agent_start") injectionHandler.push(handler);
			return () => {};
		},
	} as unknown as ExtensionAPI;
	const face = registerWorkerTools(pi, { runner, signals: false, resolveCardsDir: () => cardsDir });
	if (!dispatch) throw new Error(`没有工具 ${toolName}`);
	return {
		tool: dispatch!,
		face,
		readInjection: (): string[] => {
			const sections: Record<string, string> = {};
			for (const handler of injectionHandler)
				(handler as (event: { systemPromptOptions: { sections: Record<string, string> } }) => void)({
					systemPromptOptions: { sections },
				});
			return Object.values(sections);
		},
	};
}

describe("正式派发入口的约束（离线假 worker）", () => {
	it("旧 SDK 工具入口直接调用：非 Git primary 卡仍可派发并显式记录 Git 基线不可用", async () => {
		const root = temp();
		const cardsDir = join(root, ".pao", "卡");
		await card(cardsDir);
		const runner = new MockRunner();
		const { tool, face, readInjection } = backgroundHarness(runner, cardsDir);

		const result = await tool.execute(
			"t",
			{ card_ref: "1", reason: "V17 单根兼容" },
			undefined,
			undefined,
			{} as never,
		);
		expect(result.isError).toBeUndefined();
		expect(result.content[0]?.text).toContain("已派出");
		await face.waitForBackground();

		expect(runner.runs).toHaveLength(1);
		const notification = readInjection().join("\n");
		expect(notification).toContain("认领基线:不可用");
		expect(notification).toContain("not a git repository");
		expect(runner.runs[0]).toMatchObject({
			taskRoot: root,
			executionRoot: root,
			cwd: root,
		});
		expect(runner.runs[0]?.worktreeBindingDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(runner.runs[0]?.executionBindingDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(runner.runs[0]?.环境变量).toMatchObject({
			PAO_CARDS_DIR: cardsDir,
			PAO_WORKER_CARD: "卡0001",
			PAO_WORKER_ATTEMPT: "1",
			PAO_WORKER_OWNER: "主控",
		});
	});

	it("真实本地非 Git primary 子进程沿权威执行根启动，并收到冻结身份与显式无 Git 基线", async () => {
		const root = temp();
		const cardsDir = join(root, ".pao", "卡");
		await card(cardsDir);
		const script = join(root, "probe.cjs");
		const output = join(root, "probe.json");
		writeFileSync(
			script,
			[
				'const fs = require("node:fs");',
				`fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({`,
				"cwd: process.cwd(),",
				"cardsDir: process.env.PAO_CARDS_DIR,",
				"card: process.env.PAO_WORKER_CARD,",
				"attempt: process.env.PAO_WORKER_ATTEMPT,",
				"owner: process.env.PAO_WORKER_OWNER,",
				"}));",
				'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "{\\"result\\":\\"success\\",\\"artifact_path\\":[],\\"summary\\":\\"本地探针成功\\"}" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 } } }));',
			].join("\n"),
		);
		const runner = new WorkerRunner({
			证据目录: join(root, "证据"),
		});
		runners.push(runner);
		let dispatch:
			| {
					execute: (
						...args: unknown[]
					) => Promise<{ isError?: boolean; content: { text?: string }[]; details: unknown }>;
			  }
			| undefined;
		const injectionHandlers: ((event: unknown) => unknown)[] = [];
		const pi = {
			registerTool: (tool: {
				name: string;
				execute: (
					...args: unknown[]
				) => Promise<{ isError?: boolean; content: { text?: string }[]; details: unknown }>;
			}) => {
				if (tool.name === "pao_dispatch_card") dispatch = tool;
			},
			on: (event: string, handler: () => unknown) => {
				if (event === "session_shutdown") shutdowns.push(handler);
				if (event === "before_agent_start") injectionHandlers.push(handler);
				return () => {};
			},
		} as unknown as ExtensionAPI;
		const face = registerWorkerTools(pi, {
			runner,
			signals: false,
			resolveCardsDir: () => cardsDir,
			worktreeHost: (await import("../../src/pao/worktrees/index.ts")).createSingleRootWorktreeHost(root),
			dispatchParameters: { 命令: process.execPath, 参数: [script] },
		});
		const readInjection = () => {
			const sections: Record<string, string> = {};
			for (const handler of injectionHandlers)
				(handler as (event: { systemPromptOptions: { sections: Record<string, string> } }) => void)({
					systemPromptOptions: { sections },
				});
			return Object.values(sections);
		};
		if (!dispatch) throw new Error("没有工具 pao_dispatch_card");
		const result = await dispatch.execute("t", { card_ref: "1", reason: "真实非 Git 子进程" }, undefined, undefined, {
			tool: {
				run_in_background: false,
			},
		});
		expect(result.isError).toBeUndefined();
		await face.waitForBackground();

		const probe = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(output, "utf8")));
		expect(probe).toEqual({
			cwd: root,
			cardsDir,
			card: "卡0001",
			attempt: "1",
			owner: "主控",
		});
		const notification = readInjection().join("\n");
		expect(notification).toContain("派卡完成");
		expect(notification).toContain("认领基线:不可用");
		expect(readCard(join(cardsDir, "卡0001-离线任务.md")).receipts[0]).toMatchObject({
			attempt: 1,
			result: "success",
		});
	});

	it("派单和扇出都在认领前挡依赖，卡引用三种正式写法走同一解析器", async () => {
		const cardsDir = join(temp(), ".pao", "任务", "卡");
		const parent = await card(cardsDir);
		const child = await card(cardsDir, { depends_on: ["卡#1"] });
		for (const ref of ["卡0002", "卡#2", "2"]) expect(locateDispatchCard(cardsDir, ref).path).toBe(child.path);
		expect(() => locateDispatchCard(cardsDir, "2oops")).toThrow();
		const runner = new MockRunner();
		// B 档非阻塞:受理即返回「已派出」,认领阶段的 fail-closed 拒绝(依赖未放行)后台送达通知面
		const { tool, face, readInjection } = backgroundHarness(runner, cardsDir);
		const result = await tool.execute("t", { card_ref: "卡#2", reason: "离线依赖校验" }, undefined, undefined, {});
		expect(result.isError).toBeUndefined();
		expect(result.content[0].text).toContain("已派出");
		await face.waitForBackground();
		expect(runner.runs).toHaveLength(0);
		expect(readCard(child.path).frontmatter.attempt).toBe(0);
		expect(face.backgroundCount()).toEqual({ inFlight: 0, unread: 1 });
		expect(readInjection()[0]).toContain("依赖未放行");
		const summary = await executeFanout({ cardsDir, 卡号列表: ["卡0002"] }, { 运行器: runner });
		expect(summary.count.未拉起).toBe(1);
		expect(runner.runs).toHaveLength(0);
		expect(readCard(child.path).frontmatter.attempt).toBe(0);
		changeCardStatus(changeCardStatus(parent, { 操作者: "主控", to: "in_progress", 时间: "2026-10-03 10:01" }), {
			操作者: "主控",
			to: "delivered",
			时间: "2026-10-03 10:02",
		});
		const allowed = await executeFanout({ cardsDir, 卡号列表: ["2"] }, { 运行器: runner });
		expect(allowed.count).toMatchObject({ 成功: 0, 未拉起: 1 });
		expect(runner.runs).toHaveLength(0);
		expect(readCard(child.path).frontmatter.attempt).toBe(0);
		expect(allowed.结果[0]).toMatchObject({
			终态: "未拉起",
			未拉起原因: expect.stringContaining("execution-context"),
		});
	});
	it("任务根共享锁占用时等待且不认领；同项目写任务串行且自然退出后放锁", async () => {
		const root = temp();
		const cardsDir = join(root, ".pao", "卡");
		await card(cardsDir);
		await card(cardsDir);
		const runner = new MockRunner();
		const lock = await acquireProjectLock({ 项目根: root, 持有者: "离线占位" });
		const pending = executeFanout({ cardsDir, 卡号列表: ["1", "2"], 并发上限: 2 }, { 运行器: runner });
		let result: Awaited<typeof pending>;
		try {
			// 扇出会等待共享短事务，不能握着锁又 await 整批结束。用真实锁日志
			// 确认已到等待点，再检查两张卡仍未认领、没有启动 worker，最后交还锁。
			await expect
				.poll(() =>
					readFileSync(join(root, ".pao", "派发日志.jsonl"), "utf8")
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line))
						.some((event) => event.action === "wait" && event.kind === "shared" && event.holder !== "离线占位"),
				)
				.toBe(true);
			expect(runner.runs).toHaveLength(0);
			for (const ref of ["1", "2"]) expect(locateDispatchCard(cardsDir, ref).frontmatter.attempt).toBe(0);
		} finally {
			await releaseProjectLock(lock, runner.confirmStopped("占位"));
			result = await pending;
		}
		expect(result.count.成功).toBe(2);
		expect(runner.runs).toHaveLength(2);
		expect(runner.peak).toBe(1);
		expect(await isProjectLocked(root)).toBe(false);
	});
	it("单卡与扇出共用名额，不同部门和项目也不会绕过共享上限", async () => {
		class GatedRunner extends WorkerRunner {
			runs: WorkerRunOptions[] = [];
			active = 0;
			peak = 0;
			open = false;
			releases: (() => void)[] = [];
			override async run(options: WorkerRunOptions): Promise<WorkerReceipt> {
				this.runs.push(options);
				this.peak = Math.max(this.peak, ++this.active);
				try {
					await new Promise<void>((resolve) => {
						if (this.open) resolve();
						else this.releases.push(resolve);
					});
					return receipt(options);
				} finally {
					this.active--;
				}
			}
			releaseOne(): void {
				const release = this.releases.shift();
				if (!release) throw new Error("没有已启动的假 worker 可释放");
				release();
			}
			releaseAll(): void {
				this.open = true;
				for (const release of this.releases.splice(0)) release();
			}
		}
		const runner = new GatedRunner();
		const cardDirs = [join(temp(), ".pao", "卡"), join(temp(), ".pao", "卡"), join(temp(), ".pao", "卡")];
		for (const [i, cardsDir] of cardDirs.entries()) await card(cardsDir, { 部门: `部门${i}` });
		const run = (cardsDir: string) =>
			executeDispatch(
				{ cardsDir, card_no: "1", operator: "主控", time: "2026-10-03 10:00" },
				{ 运行器: runner, workflowCheck: () => undefined, 公共参数: { 工具白名单: ["read"] }, 等待名额: true },
				async () => "done",
			);
		const executions = cardDirs.map(run);
		try {
			// 已进入的 worker 显式等待释放，不用固定延时假定认领/git 足够快。
			await expect.poll(() => runner.runs.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
			expect(runner.runs).toHaveLength(2);
			expect(runner.active).toBe(2);
			expect(locateDispatchCard(cardDirs[2], "1").frontmatter.attempt).toBe(0);
			runner.releaseOne();
			await expect.poll(() => runner.runs.length, { timeout: 10_000 }).toBe(3);
			expect(runner.active).toBe(2);
			expect(runner.peak).toBe(2);
		} finally {
			runner.releaseAll();
			await Promise.all(executions);
		}
		expect(planFanout(["1"], 999).并发上限).toBe(8);
		for (const limit of [Number.NaN, Number.POSITIVE_INFINITY]) expect(() => planFanout(["1"], limit)).toThrow();
	}, 30_000);
	it("同父卡有限预算的并发子卡串行争用，后者看到已落回执后按预算耗尽拒派", async () => {
		const cardsDir = join(temp(), ".pao", "卡");
		await card(cardsDir, { 预算: { turns: 1 } });
		const child1 = await card(cardsDir, { parent: "卡#1" });
		const child2 = await card(cardsDir, { parent: "卡#1" });
		const runner = new MockRunner();
		const concurrent = await executeFanout(
			{ cardsDir, 卡号列表: ["2", "3"], 并发上限: 2 },
			{ 运行器: runner, 公共参数: { 工具白名单: ["read"] } },
		);
		expect(runner.runs).toHaveLength(1);
		expect(readCard(child1.path).frontmatter.attempt).toBe(1);
		expect(readCard(child1.path).receipts).toHaveLength(1);
		expect(readCard(child1.path).receipts[0]?.usage).toMatchObject({ turns: 1 });
		expect(concurrent.count).toMatchObject({ 成功: 1, 未拉起: 1 });
		const child1No = String(child1.card_no).padStart(4, "0");
		const child2No = String(child2.card_no).padStart(4, "0");
		const succeeded = concurrent.结果.find((item) => item.卡号 === child1No);
		const rejected = concurrent.结果.find((item) => item.卡号 === child2No);
		expect(succeeded, JSON.stringify(concurrent)).toMatchObject({ 卡号: child1No, 终态: "成功", attempt: 1 });
		expect(rejected, JSON.stringify(concurrent)).toMatchObject({
			卡号: child2No,
			终态: "未拉起",
			未拉起原因: expect.stringContaining("预算耗尽"),
		});
		expect(rejected?.attempt).toBeUndefined();
		expect(readCard(child1.path).frontmatter.attempt).toBe(1);
		expect(readCard(child2.path).frontmatter.attempt).toBe(0);
	});
	it("费用缺账只拒绝费用预算，已知轮次和工具次数仍有效", async () => {
		const parsed = await card(join(temp(), "卡"), { 预算: { turns: 3, toolCalls: 4 } });
		parsed.receipts = [
			{
				card_no: parsed.card_no,
				attempt: 1,
				time: "2026-10-03 10:00",
				usage: { turns: 1, toolCalls: 2, cost: 0, missing_usage_rounds: 1 },
			},
		];
		expect(remainingDispatchBudget(parsed, [parsed])).toMatchObject({ turns: 2, toolCalls: 2 });
		parsed.frontmatter.budget = { turns: 3, cost: 10 };
		expect(() => remainingDispatchBudget(parsed, [parsed])).toThrow(/cost.*未知/);
	});
	it("两入口回执都相对项目根落卡；进行中的协作母卡尚无最终回执也允许首个子卡", async () => {
		const root = temp();
		const cardsDir = join(root, ".pao", "任务", "卡");
		const parent = await card(cardsDir, { 预算: { turns: 2 } });
		changeCardStatus(parent, { 操作者: "主控", to: "in_progress", 时间: "2026-10-03 10:01" });
		const child1 = await card(cardsDir, { parent: "卡#1" });
		const child2 = await card(cardsDir, { parent: "卡#1" });
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src", "x.ts"), "// 离线测试产物\n");
		class ArtifactRunner extends MockRunner {
			override async run(options: WorkerRunOptions): Promise<WorkerReceipt> {
				return { ...(await super.run(options)), artifact_path: ["src/x.ts"] };
			}
		}
		const runner = new ArtifactRunner();
		// B 档非阻塞:派单受理即返回;终态/回执落卡结果经通知面送达,回执落卡照旧相对项目根
		const { tool, face, readInjection } = backgroundHarness(runner, cardsDir);
		const single = await tool.execute("t", { card_ref: "2", reason: "离线落卡校验" });
		expect(single.isError).toBeUndefined();
		expect(single.details).toMatchObject({ dispatched: true, card_no: "0002" });
		await face.waitForBackground();
		expect(face.backgroundCount().unread).toBe(1);
		expect(readInjection()[0]).toContain("(success)");
		const batch = await toolFor(runner, cardsDir, "pao_fanout").execute("t", {
			card_refs: ["3"],
			reason: "离线落卡校验",
		});
		expect(batch.isError).toBeUndefined();
		expect(batch.details).toMatchObject({ count: { 成功: 1 } });
		expect(readCard(parent.path).receipts).toHaveLength(0);
		for (const child of [child1, child2])
			expect(readCard(child.path).receipts[0]).toMatchObject({ artifact_path: ["src/x.ts"], usage: { turns: 1 } });
	});
	for (const toolName of ["pao_dispatch_card", "pao_fanout"]) {
		it(`${toolName} 落卡失败明确报错，同母卡其他子卡不借缺账继续执行`, async () => {
			const root = temp();
			const cardsDir = join(root, ".pao", "任务", "卡");
			const parent = await card(cardsDir, { 预算: { turns: 4 } });
			changeCardStatus(parent, { 操作者: "主控", to: "in_progress", 时间: "2026-10-03 10:01" });
			const child1 = await card(cardsDir, { parent: "卡#1" });
			const child2 = await card(cardsDir, { parent: "卡#1" });
			const artifact = join(root, "src", "x.ts");
			mkdirSync(join(root, "src"));
			writeFileSync(artifact, "// 离线测试产物\n");
			class DisappearingArtifactRunner extends MockRunner {
				override async run(options: WorkerRunOptions): Promise<WorkerReceipt> {
					const result = await super.run(options);
					// 模拟 worker 返回后、落卡前文件被移走；实际工具入口及落卡校验不 mock。
					rmSync(artifact);
					return { ...result, artifact_path: ["src/x.ts"] };
				}
			}
			const runner = new DisappearingArtifactRunner();
			if (toolName === "pao_dispatch_card") {
				// B 档非阻塞:两段都受理即返回;落卡失败与「已用量未知」拒派均后台送达通知面
				const { tool, face, readInjection } = backgroundHarness(runner, cardsDir);
				const first = await tool.execute("t", { card_ref: "2", reason: "离线落卡失败校验" });
				expect(first.isError).toBeUndefined();
				await face.waitForBackground();
				const section1 = readInjection().join("\n");
				expect(section1).toContain("回执落卡失败");
				const next = await tool.execute("t", { card_ref: "3", reason: "不得借缺账再派" });
				expect(next.isError).toBeUndefined();
				await face.waitForBackground();
				expect(readInjection()[0]).toContain("已用量未知");
			} else {
				const tool = toolFor(runner, cardsDir, toolName);
				const result = await tool.execute("t", {
					card_refs: ["2", "3"],
					max_concurrency: 2,
					reason: "离线落卡失败校验",
				});
				expect(result.isError).toBe(true);
				expect(result.details).toMatchObject({
					count: { 成功: 0, 失败: 1, 未拉起: 1 },
				});
				const details = result.details as {
					结果: { 卡号: string; 终态: string; 未拉起原因?: string }[];
				};
				expect(details.结果.find((item) => item.卡号 === "0002")).toMatchObject({
					终态: "失败",
					回执落卡: "未落卡",
					失败类型: "unknown_outcome",
				});
				const blocked = details.结果.find((item) => item.卡号 === "0003");
				expect(blocked?.终态).toBe("未拉起");
				expect(blocked?.未拉起原因).toMatch(/已用量未知|持久占位/);
			}
			expect(runner.runs).toHaveLength(1);
			expect(readCard(child1.path).receipts).toHaveLength(0);
			expect(readCard(child2.path).frontmatter.attempt).toBe(0);
		});
	}
	it("真实配方的档位括号解释可解析，卡指定档位优先，prose 不猜成工具权限", async () => {
		const root = temp();
		const home = temp();
		const cardsDir = join(root, ".pao", "任务", "卡");
		const parsed = await card(cardsDir, { 部门: "审查" });
		mkdirSync(join(home, "部门", "审查"), { recursive: true });
		mkdirSync(join(home, "pao配置"));
		const recipePath = join(home, "部门", "审查", "配方.md");
		writeFileSync(
			recipePath,
			"# 配方:审查\n- 默认档位:主力(判断贵:判断性审查钉主力+高思考)\n- 工具:代码审查与 pao_知识工具\n",
		);
		writeFileSync(
			join(home, "pao配置", "档位.json"),
			JSON.stringify({
				档位: [
					{ 名: "主力", provider: "faux", model: "main", thinkingLevel: "high" },
					{ 名: "快", provider: "faux", model: "fast", thinkingLevel: "low" },
				],
			}),
		);
		expect(resolveDispatchParameters(parsed, cardsDir, home)).toMatchObject({
			cwd: root,
			模型: "faux/main",
			思考档: "high",
			附加系统提示词: [recipePath],
		});
		expect(resolveDispatchParameters(parsed, cardsDir, home).工具白名单).toBeUndefined();
		parsed.frontmatter.tier = "fast";
		expect(resolveDispatchParameters(parsed, cardsDir, home).模型).toBe("faux/fast");
		const parameters = ["fake.js"];
		buildArgs({ 卡号: "0001", 提示词: "task", 参数: parameters, 附加系统提示词: [recipePath] });
		expect(parameters).toEqual(["fake.js"]);
	});
	it("旧执行的回执保留原尝试，不能冒充新尝试", async () => {
		let parsed = await card(join(temp(), "卡"));
		const launched = changeCardStatus(parsed, { 操作者: "主控", to: "in_progress", 时间: "2026-10-03 10:00" });
		parsed = changeCardStatus(readCard(parsed.path), {
			操作者: "主控",
			to: "failed",
			失败类型: "transient",
			时间: "2026-10-03 10:01",
		});
		parsed = changeCardStatus(parsed, { 操作者: "主控", to: "unclaimed", 时间: "2026-10-03 10:02" });
		changeCardStatus(parsed, { 操作者: "主控", to: "in_progress", 时间: "2026-10-03 10:03" });
		await appendDispatchReceipt(launched, receipt({ 卡号: "0001", 提示词: "", 尝试号: 1 }));
		const current = readCard(parsed.path);
		expect(current.frontmatter.attempt).toBe(2);
		expect(current.receipts[0]).toMatchObject({ attempt: 1, archive_flag: "old_attempt" });
	});
});

describe("真实本地子进程的停止与身份（不调用模型）", () => {
	it("输入升版只停精确路径和 attempt，不封锁同卡复核后的新 attempt", async () => {
		const root = temp();
		const cardPath = join(root, "项目", ".pao", "任务", "卡", "卡0001-输入升版.md");
		const script = join(root, "hang.js");
		mkdirSync(join(root, "项目", ".pao", "任务", "卡"), { recursive: true });
		writeFileSync(script, "setInterval(() => {}, 1000);\n");
		const runner = new WorkerRunner({ 证据目录: join(root, "证据") });
		runners.push(runner);
		const first = runner.run({
			卡号: "0001",
			卡路径: cardPath,
			尝试号: 1,
			提示词: "",
			命令: process.execPath,
			参数: [script],
		});
		await waitFor(() => runner.isRunning(cardPath));
		await expect(runner.stopCurrentAttempt("0001", 1)).rejects.toThrow("完整卡路径");
		await expect(runner.stopCurrentAttempt(cardPath, 2)).rejects.toThrow("当前活动尝试 1 不一致");
		expect(runner.isRunning(cardPath)).toBe(true);
		await runner.stopCurrentAttempt(cardPath, 1);
		expect((await first).status).toBe("canceled");
		expect(runner.isRunning(cardPath)).toBe(false);
		const second = runner.run({
			卡号: "0001",
			卡路径: cardPath,
			尝试号: 2,
			提示词: "",
			命令: process.execPath,
			参数: [script],
		});
		await waitFor(() => runner.isRunning(cardPath));
		expect(runner.registry.list().filter((entry) => entry.running)).toHaveLength(1);
		await runner.stopCurrentAttempt(cardPath, 2);
		expect((await second).status).toBe("canceled");
	}, 30_000);

	it("树杀失败不会签发成功凭据或删除活进程登记", async () => {
		const root = temp();
		const script = join(root, "hang.js");
		writeFileSync(script, "setInterval(() => {}, 1000);\n");
		let failOnce = true;
		const runner = new WorkerRunner({
			证据目录: join(root, "证据"),
			树杀: async (pid) => {
				if (failOnce) {
					failOnce = false;
					throw new PaoWorkerError("停止失败", "离线注入的树杀失败");
				}
				return killTree(pid);
			},
		});
		runners.push(runner);
		const run = runner.run({ 卡号: "0001", 提示词: "", 命令: process.execPath, 参数: [script] });
		await expect(runner.cancel("0001")).rejects.toThrow("树杀失败");
		expect(runner.isRunning("0001")).toBe(true);
		expect(runner.registry.list()[0].running).toBe(true);
		expect(() => runner.confirmStopped("0001")).toThrow("仍有执行中的进程");
		await runner.stopAll();
		expect((await run).status).toBe("canceled");
		expect(runner.registry.list()[0].running).toBe(false);
	}, 30_000);
	it("不同项目同卡号可共存，裸号取消拒歧义，证据不会互相覆盖", async () => {
		const root = temp();
		const script = join(root, "hang.js");
		writeFileSync(script, "setInterval(() => {}, 1000);\n");
		const runner = new WorkerRunner({ 证据目录: join(root, "证据") });
		runners.push(runner);
		const path1 = join(root, "项目一", "卡0001.md");
		const path2 = join(root, "项目二", "卡0001.md");
		const first = runner.run({
			卡号: "0001",
			卡路径: path1,
			尝试号: 2,
			提示词: "",
			命令: process.execPath,
			参数: [script],
		});
		const second = runner.run({
			卡号: "0001",
			卡路径: path2,
			尝试号: 2,
			提示词: "",
			命令: process.execPath,
			参数: [script],
		});
		await expect(runner.cancel("0001")).rejects.toThrow("多个项目");
		await runner.cancel(path1);
		expect(runner.isRunning(path2)).toBe(true);
		await runner.cancel(path2);
		const [a, b] = await Promise.all([first, second]);
		expect(a.evidence_path).not.toBe(b.evidence_path);
		expect(a.attempt).toBe(2);
		expect(b.attempt).toBe(2);
		expect(runner.registry.list().map((entry) => entry.card_path)).toEqual([path1, path2]);
	}, 30_000);
});

describe("派发默认超时(护栏:worker 挂死不无限期占写锁与名额)", () => {
	function homeWith(warmth?: unknown): string {
		const home = temp();
		mkdirSync(join(home, "pao配置"), { recursive: true });
		if (warmth !== undefined) writeFileSync(join(home, "pao配置", "保温.json"), JSON.stringify(warmth), "utf8");
		return home;
	}

	it("readDispatchTimeoutMs:缺省 24 小时(B 档:静默提醒是主判决,机械超时只兜无人应答);「派发超时分钟」合法值生效,缺失/非法/坏 JSON 回落缺省", () => {
		expect(readDispatchTimeoutMs(undefined)).toBe(86_400_000);
		expect(readDispatchTimeoutMs(homeWith())).toBe(86_400_000);
		expect(readDispatchTimeoutMs(homeWith({ 部门并发上限: 3 }))).toBe(86_400_000);
		expect(readDispatchTimeoutMs(homeWith({ 派发超时分钟: 30 }))).toBe(1_800_000);
		expect(readDispatchTimeoutMs(homeWith({ 派发超时分钟: 2.5 }))).toBe(120_000);
		expect(readDispatchTimeoutMs(homeWith({ 派发超时分钟: 0 }))).toBe(86_400_000);
		expect(readDispatchTimeoutMs(homeWith({ 派发超时分钟: -3 }))).toBe(86_400_000);
		expect(readDispatchTimeoutMs(homeWith({ 派发超时分钟: "30" }))).toBe(86_400_000);
		const bad = temp();
		mkdirSync(join(bad, "pao配置"), { recursive: true });
		writeFileSync(join(bad, "pao配置", "保温.json"), "{oops", "utf8");
		expect(readDispatchTimeoutMs(bad)).toBe(86_400_000);
	});

	it("executeDispatch 注入缺省超时:无配置=86400000;保温配置生效;显式 超时毫秒 优先", async () => {
		const cardsDir = join(temp(), "卡");
		await card(cardsDir);
		await card(cardsDir);
		await card(cardsDir);
		const runner = new MockRunner();
		const dispatch = (paoHome?: string, commonParams?: Record<string, unknown>) =>
			executeDispatch(
				{ cardsDir, card_no: String(runner.runs.length + 1), operator: "主控", time: "2026-10-03 10:00" },
				{
					运行器: runner,
					workflowCheck: () => undefined,
					...(paoHome ? { paoHome } : {}),
					...(commonParams ? { 公共参数: commonParams } : {}),
				} as never,
				async () => "ok",
			);
		await dispatch();
		expect(runner.runs[0]?.超时毫秒).toBe(86_400_000);
		const home = homeWith({ 派发超时分钟: 1 });
		await dispatch(home);
		expect(runner.runs[1]?.超时毫秒).toBe(60_000);
		await dispatch(home, { 超时毫秒: 5000 });
		expect(runner.runs[2]?.超时毫秒).toBe(5000);
	});
});

describe("停止确认失败:fail-closed 落回执,不遮蔽原始错误", () => {
	it("run 正常返回但确认停止失败:回执已落卡(卡不再无回执悬挂),锁不放,错误如实上抛", async () => {
		const root = temp();
		const cardsDir = join(root, "卡");
		const parsed = await card(cardsDir);
		class ConfirmFailRunner extends MockRunner {
			override confirmStopped(): StopProof {
				throw new PaoWorkerError("停止失败", "仍有执行中的进程(注入)");
			}
		}
		const runner = new ConfirmFailRunner();
		await expect(
			executeDispatch(
				{ cardsDir, card_no: "1", operator: "主控", time: "2026-10-03 10:00" },
				{ 运行器: runner, workflowCheck: () => undefined },
				async (claimed, receipt) => {
					await appendDispatchReceipt(claimed.card, receipt);
					return "ok";
				},
			),
		).rejects.toThrow("仍有执行中的进程");
		expect(readCard(parsed.path).receipts).toHaveLength(1);
		expect(await isExecutionLocked(root)).toBe(true);
	});

	it("获得执行锁后、runner 启动前失败:正常释放执行锁与共享名额", async () => {
		const root = temp();
		const cardsDir = join(root, "卡");
		await card(cardsDir);
		const runner = new MockRunner();
		let checks = 0;
		await expect(
			executeDispatch(
				{ cardsDir, card_no: "1", operator: "主控", time: "2026-10-03 10:00" },
				{
					运行器: runner,
					workflowCheck: () => {
						checks++;
						if (checks === 2) throw new PaoWorkerError("无效参数", "锁后复核失败");
						return undefined;
					},
				},
				async () => "ok",
			),
		).rejects.toThrow("锁后复核失败");
		expect(checks).toBe(2);
		expect(runner.runs).toHaveLength(0);
		expect(await isExecutionLocked(root)).toBe(false);
		expect(runner.slots).toBe(0);
	});

	it("runner 已进入启动边界后停止未知:执行锁和共享名额都保留", async () => {
		const root = temp();
		const cardsDir = join(root, "卡");
		await card(cardsDir);
		class StartThenUnknownRunner extends MockRunner {
			override async run(): Promise<WorkerReceipt> {
				throw new PaoWorkerError("已取消", "启动后失败");
			}
			override confirmStopped(): StopProof {
				throw new PaoWorkerError("停止失败", "停止未确认");
			}
		}
		const runner = new StartThenUnknownRunner();
		await expect(
			executeDispatch(
				{ cardsDir, card_no: "1", operator: "主控", time: "2026-10-03 10:00" },
				{ 运行器: runner, workflowCheck: () => undefined },
				async () => "ok",
			),
		).rejects.toThrow("启动后失败");
		expect(await isExecutionLocked(root)).toBe(true);
		expect(runner.slots).toBe(1);
	});

	it("原始错误优先:停止确认失败只记录,不遮蔽原始错误", async () => {
		const cardsDir = join(temp(), "卡");
		await card(cardsDir);
		class FailRunner extends MockRunner {
			override async run(): Promise<WorkerReceipt> {
				throw new PaoWorkerError("已取消", "注入的原始错误");
			}
			override confirmStopped(): StopProof {
				throw new PaoWorkerError("停止失败", "注入的停止确认失败");
			}
		}
		const runner = new FailRunner();
		await expect(
			executeDispatch(
				{ cardsDir, card_no: "1", operator: "主控", time: "2026-10-03 10:00" },
				{ 运行器: runner, workflowCheck: () => undefined },
				async () => "ok",
			),
		).rejects.toThrow("注入的原始错误");
	});
});
