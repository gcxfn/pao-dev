/**
 * B 档(派卡非阻塞＋静默提醒,2026-10-03 拍板)的行为钉:
 * - 保温「worker 静默分钟」缺省开型:缺文件/缺键/坏值回落 30,显式 0=关,合法值生效;
 * - scanSilence 纯函数:阈值边界(恰好等于不提)、同一静默期去重、新输出重置后再静默才重提、
 *   缺最近输出时间以登记时间为基线、活性表与登记表对不上不提、静默分钟≤0 整体关;
 * - formatSilenceReminder:卡号/分钟/live 路径/裁决指引齐,无输出尾有占位,分钟下限 1;
 * - createSilenceReminder:扫描()可手驱(伪时钟),间隔 interval 不托测试;
 * - pao_dispatch_card 受理即返回→完成以「pao 后台通知」注入送达(消费式),后台计数归零;
 * - pao_terminate_card:真子进程正路径(树杀→登记表清→owner 侧「取消/被上级终止」回执落卡),
 *   无运行中条目时报错不误伤。
 * 真进程用 node -e 脚本文件(模式同 worker-run/worker-stream);一律 tmpdir,不碰运行目录。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import * as cards from "../../src/pao/cards/index.ts";
import {
	type CardCreateInput,
	changeCardStatus,
	createCard,
	type ParsedCard,
	readCard,
} from "../../src/pao/cards/index.ts";
import { DEFAULT_WORKER_SILENCE_MINUTES, readWorkerSilenceMinutes } from "../../src/pao/host/config.ts";
import { MinisterHost } from "../../src/pao/host/host.ts";
import { projectRootForCards } from "../../src/pao/cards/cardfile.ts";
import * as dispatchCore from "../../src/pao/worker/dispatch-core.ts";
import { appendDispatchReceipt } from "../../src/pao/worker/dispatch-core.ts";
import {
	buildWorkerSupervisionActivity,
	createSilenceReminder,
	DEFAULT_SILENCE_SCAN_INTERVAL_MS,
	DISPATCH_NOTIFY_SECTION,
	formatSilenceReminder,
	registerWorkerTools,
	type RegisterWorkerToolsOptions,
	scanSilence,
} from "../../src/pao/worker/index.ts";
import type { ProcessEntry } from "../../src/pao/worker/registry.ts";
import { WorkerRunner, type WorkerRunOptions } from "../../src/pao/worker/runner.ts";
import { createSingleRootWorktreeHost } from "../../src/pao/worktrees/types.ts";

const dirs: string[] = [];
const runners: WorkerRunner[] = [];
const shutdowns: (() => unknown)[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const shutdown of shutdowns.splice(0)) await shutdown();
	for (const runner of runners.splice(0)) await runner.stopAll();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-dispatch-bg-"));
	dirs.push(dir);
	return dir;
}
async function card(cardsDir: string, extra: Partial<CardCreateInput> = {}): Promise<ParsedCard> {
	mkdirSync(cardsDir, { recursive: true });
	return createCard(
		cardsDir,
		{ 目标: "离线任务", 部门: "测试", 验收: "完成", 创建: "2026-10-03 10:00", ...extra },
		{ counterPath: join(cardsDir, "..", "卡号.txt") },
	);
}
function writeScript(body: string): string {
	const file = join(temp(), "fake-worker.js");
	writeFileSync(file, body, "utf8");
	return file;
}
const ASSISTANT_LINE = (text: string): string =>
	JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
			stopReason: "end",
		},
	});
async function until(check: () => boolean, timeoutMs = 8000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/** 离线假 worker(30ms 假跑),形状同 worker-dispatch-guards 的 MockRunner */
class MockRunner extends WorkerRunner {
	runs: WorkerRunOptions[] = [];
	holdNextRun = false;
	readonly hold = new Promise<void>((resolve) => {
		this.release = resolve;
	});
	release: () => void = () => {};
	override async run(options: WorkerRunOptions): Promise<import("../../src/pao/worker/receipt.ts").WorkerReceipt> {
		this.runs.push(options);
		// 受控替身仍走真实的工具→执行链；只在测试显式要求时登记一条活动并等待释放，
		// 让 registry 订阅和宿主定时器由派工自身触发，而不是测试手动推进监督。
		if (this.holdNextRun) {
			this.holdNextRun = false;
			const route = options.supervisionRoute;
			const pid = 991_001;
			const runId = "controlled-supervision-run";
			this.registry.register({
				pid,
				card_no: options.卡号,
				card_path: options.卡路径,
				attempt: options.尝试号 ?? 1,
				run_id: runId,
				task_root: options.taskRoot,
				command: "受控监督替身",
				dept: options.部门 ?? null,
				dispatch_reason: options.派单理由,
				...(route
					? {
							supervisor_dept: route.department,
							supervisor_context: route.context,
							supervisor_session: route.sessionId,
							supervision_key: route.key,
							supervision_department_key: route.departmentKey,
							supervision_label: route.label,
							supervision_owner: route.ownerSessionId,
							supervision_goal: route.goal,
							supervision_evidence: route.evidence,
							supervision_target: route.target,
							supervision_binding: route.binding,
						}
					: {}),
			});
			try {
				await this.hold;
			} finally {
				this.registry.markExited(pid, runId);
				// 监督结束前把对象移出活动快照；正常 runner 由真实进程退出完成同一边界。
				this.registry.clear();
			}
		}
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
	releaseRun(): void {
		this.release();
	}
}

type ToolReply = { isError?: boolean; content: { text?: string }[]; details: unknown };
type Tool = { execute: (...args: unknown[]) => Promise<ToolReply> };
type Sent = {
	message: { customType: string; content: { type: "text"; text: string }[]; display: boolean };
	options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" };
};

function supervisedHarness(
	runner: WorkerRunner,
	cardsDir: string,
	host: MinisterHost,
	options: Pick<
		RegisterWorkerToolsOptions,
		| "worktreeHost"
		| "worktreeTarget"
		| "dispatchParameters"
		| "onBackgroundChange"
		| "resolveSupervisionRoute"
	> = {},
) {
	const tools = new Map<string, Tool>();
	const handlers = new Map<string, (event: unknown) => unknown>();
	const pi = {
		registerTool: (tool: { name: string } & Tool) => tools.set(tool.name, tool),
		on: (event: string, handler: (event: unknown) => unknown) => {
			handlers.set(event, handler);
			return () => {};
		},
		sendMessage: () => {},
	} as unknown as ExtensionAPI;
	const face = registerWorkerTools(pi, {
		...options,
		runner,
		host,
		signals: false,
		resolveCardsDir: () => cardsDir,
	});
	const shutdown = handlers.get("session_shutdown");
	if (!shutdown) throw new Error("派卡生命周期钩子未注册");
	shutdowns.push(() => shutdown({}));
	return {
		tool: (name: string) => tools.get(name) as Tool,
		face,
		shutdown: async () => shutdown({}),
	};
}

/** 会话级 harness:捕工具＋事件,读取注入() 模拟一轮 before_agent_start(消费式 splice) */
function harness(
	runner: WorkerRunner,
	cardsDir: string,
	options: Pick<RegisterWorkerToolsOptions, "worktreeHost" | "worktreeTarget"> = {},
) {
	const tools = new Map<string, Tool>();
	const handlers = new Map<string, (event: unknown) => unknown>();
	const sent: Sent[] = [];
	const pi = {
		registerTool: (tool: { name: string } & Tool) => tools.set(tool.name, tool),
		on: (event: string, handler: (event: unknown) => unknown) => {
			handlers.set(event, handler);
			return () => {};
		},
		sendMessage: (message: Sent["message"], options?: Sent["options"]) => sent.push({ message, options }),
	} as unknown as ExtensionAPI;
	const face = registerWorkerTools(pi, { ...options, runner, signals: false, resolveCardsDir: () => cardsDir });
	const shutdown = handlers.get("session_shutdown");
	const beforeStart = handlers.get("before_agent_start");
	if (!shutdown || !beforeStart) throw new Error("派卡生命周期钩子未注册");
	shutdowns.push(() => shutdown({}));
	const readInjection = (): string => {
		const sections: Record<string, string> = {};
		beforeStart({ systemPromptOptions: { sections } });
		return sections[DISPATCH_NOTIFY_SECTION] ?? "";
	};
	return { tool: (name: string) => tools.get(name) as Tool, face, readInjection, sent };
}

// ── 保温配置键(缺省开型) ─────────────────────────────────────────────
function homeWith(warmth?: unknown): string {
	const home = temp();
	mkdirSync(join(home, "pao配置"), { recursive: true });
	if (warmth !== undefined) writeFileSync(join(home, "pao配置", "保温.json"), JSON.stringify(warmth), "utf8");
	return home;
}

describe("readWorkerSilenceMinutes(缺省开型:缺文件=30,显式 0=关,坏值回落 30)", () => {
	it("无 home/无文件/无键 → 30;合法值生效;2.5 取整 2;0 显式关", () => {
		expect(readWorkerSilenceMinutes(undefined)).toBe(DEFAULT_WORKER_SILENCE_MINUTES);
		expect(readWorkerSilenceMinutes(homeWith())).toBe(30);
		expect(readWorkerSilenceMinutes(homeWith({ 部门并发上限: 3 }))).toBe(30);
		expect(readWorkerSilenceMinutes(homeWith({ "worker 静默分钟": 5 }))).toBe(5);
		expect(readWorkerSilenceMinutes(homeWith({ "worker 静默分钟": 2.5 }))).toBe(2);
		expect(readWorkerSilenceMinutes(homeWith({ "worker 静默分钟": 0 }))).toBe(0);
	});
	it("负数/字符串/坏 JSON 回落 30(监督不因配置坏而失效)", () => {
		expect(readWorkerSilenceMinutes(homeWith({ "worker 静默分钟": -3 }))).toBe(30);
		expect(readWorkerSilenceMinutes(homeWith({ "worker 静默分钟": "30" }))).toBe(30);
		const bad = temp();
		mkdirSync(join(bad, "pao配置"), { recursive: true });
		writeFileSync(join(bad, "pao配置", "保温.json"), "{oops", "utf8");
		expect(readWorkerSilenceMinutes(bad)).toBe(30);
	});
});

// ── scanSilence(纯函数) ────────────────────────────────────────────────
const T0 = Date.parse("2026-10-03T15:00:00.000Z");
function fakeEntry(overrides: Partial<ProcessEntry> & { card_no: string }): ProcessEntry {
	return {
		pid: 4321,
		command: "fake",
		登记时间: new Date(T0).toISOString(),
		running: true,
		dept: null,
		dispatch_reason: null,
		run_id: `exec-${overrides.card_no}`,
		...overrides,
	};
}
function fakeLiveness(
	entry: ProcessEntry,
	lastLine: string[],
): {
	pid: number;
	卡号: string;
	命令: string;
	执行标识: string;
	中途输出路径?: string;
	中途stderr路径?: string;
	stdoutTail: (lineCount?: number) => string;
} {
	return {
		pid: entry.pid,
		卡号: entry.card_no,
		命令: entry.command,
		执行标识: entry.run_id ?? `pid:${entry.pid}`,
		中途输出路径: `D:\\live\\卡${entry.card_no}.live.jsonl`,
		中途stderr路径: `D:\\live\\卡${entry.card_no}.live.stderr.log`,
		stdoutTail: (lineCount = 50) => lastLine.slice(-lineCount).join("\n"),
	};
}

describe("scanSilence(阈值边界/去重/重臂/关/基线回退)", () => {
	it("恰好等于阈值不提;超 1ms 提;同一静默期不重弹;有新输出重置,再静默超阈值才重提", () => {
		const entry = fakeEntry({ card_no: "0002", 最近输出时间: new Date(T0).toISOString() });
		const baseline = new Map<string, number>();
		const scan = (now: number, silenceMinutes = 30) =>
			scanSilence({
				entries: [entry],
				active: [fakeLiveness(entry, ["尾行A", "尾行B"])],
				now,
				silenceMinutes,
				remindedBaselines: baseline,
			});
		expect(scan(T0 + 30 * 60_000)).toHaveLength(0);
		const first = scan(T0 + 30 * 60_000 + 1);
		expect(first).toHaveLength(1);
		expect(first[0]).toMatchObject({
			cardNo: "0002",
			silentMs: 30 * 60_000 + 1,
			outputPath: "D:\\live\\卡0002.live.jsonl",
			stderrPath: "D:\\live\\卡0002.live.stderr.log",
			outputTail: "尾行A\n尾行B",
		});
		expect(scan(T0 + 40 * 60_000)).toHaveLength(0);
		entry.最近输出时间 = new Date(T0 + 35 * 60_000).toISOString();
		expect(scan(T0 + 40 * 60_000)).toHaveLength(0);
		expect(scan(T0 + 35 * 60_000 + 30 * 60_000 + 1)).toHaveLength(1);
	});
	it("silenceMinutes≤0=整体关;缺最近输出时间以登记时间为基线;活性表与登记表对不上不提", () => {
		const entry = fakeEntry({ card_no: "0004", 最近输出时间: new Date(T0).toISOString() });
		const baseline = new Map<string, number>();
		expect(
			scanSilence({
				entries: [entry],
				active: [fakeLiveness(entry, [])],
				now: T0 + 99 * 60_000,
				silenceMinutes: 0,
				remindedBaselines: baseline,
			}),
		).toHaveLength(0);
		const noOutputEntry = fakeEntry({ card_no: "0005" });
		expect(
			scanSilence({
				entries: [noOutputEntry],
				active: [fakeLiveness(noOutputEntry, [])],
				now: T0 + 30 * 60_000 + 1,
				silenceMinutes: 30,
				remindedBaselines: new Map(),
			}),
		).toHaveLength(1);
		const othersLiveness = { ...fakeLiveness(entry, []), 执行标识: "exec-别的" };
		expect(
			scanSilence({
				entries: [entry],
				active: [othersLiveness],
				now: T0 + 99 * 60_000,
				silenceMinutes: 30,
				remindedBaselines: new Map(),
			}),
		).toHaveLength(0);
	});
});

describe("formatSilenceReminder(上级裁决所需的要素一样不缺)", () => {
	it("卡号/分钟/live 路径/输出尾/裁决指引齐;无输出尾有占位;分钟下限 1", () => {
		const text = formatSilenceReminder({
			cardNo: "0007",
			silentMs: 31 * 60_000,
			outputPath: "D:\\live\\卡0007.live.jsonl",
			stderrPath: "D:\\live\\卡0007.live.stderr.log",
			outputTail: "a\nb",
		});
		expect(text).toContain("[静默提醒] 卡0007 已静默 31 分钟");
		expect(text).toContain("阈值＝保温.json「worker 静默分钟」,缺省 30,显式 0=关");
		expect(text).toContain("live 输出(可直接读取):D:\\live\\卡0007.live.jsonl");
		expect(text).toContain("live stderr:D:\\live\\卡0007.live.stderr.log");
		expect(text).toContain("  a\n  b");
		expect(text).toContain("继续等＝不用做任何事");
		expect(text).toContain("pao_terminate_card");
		expect(formatSilenceReminder({ cardNo: "0008", silentMs: 0, outputTail: "" })).toContain("输出末几行:(无)");
		expect(formatSilenceReminder({ cardNo: "0009", silentMs: 30_000, outputTail: "" })).toContain("已静默 1 分钟");
	});
});

describe("createSilenceReminder(扫描可手驱,伪时钟;间隔 interval 不托测试)", () => {
	it("静默即提醒→同静默期去重→新输出重臂→显式关停提;停止() 清 timer", () => {
		const entry = fakeEntry({ card_no: "0003", 最近输出时间: new Date(T0).toISOString() });
		let silenceMinutes = 30;
		let now = T0 + 1;
		const record: { 正文: string; toast: string }[] = [];
		const reminder = createSilenceReminder({
			runner: {
				registry: { list: () => [entry] },
				listActive: () => [fakeLiveness(entry, ["活着但哑"])],
			} as unknown as WorkerRunner,
			readSilenceMinutes: () => silenceMinutes,
			notify: (body, toastBody) => record.push({ 正文: body, toast: toastBody }),
			intervalMs: 3_600_000,
			now: () => now,
		});
		try {
			reminder.scan();
			expect(record).toHaveLength(0);
			now = T0 + 30 * 60_000 + 1;
			reminder.scan();
			expect(record).toHaveLength(1);
			expect(record[0].toast).toContain("卡0003 已静默 30 分钟");
			expect(record[0].正文).toContain("活着但哑");
			reminder.scan();
			expect(record).toHaveLength(1);
			entry.最近输出时间 = new Date(now - 60_000).toISOString();
			now += 31 * 60_000;
			reminder.scan();
			expect(record).toHaveLength(2);
			silenceMinutes = 0;
			now += 60 * 60_000;
			reminder.scan();
			expect(record).toHaveLength(2);
		} finally {
			reminder.stop();
		}
	});

	it("单轮扫描异常不外传:readSilenceMinutes抛错跳过本轮,恢复后同静默期照常提醒(缺 PAO_HOME 崩宿主回归)", () => {
		const entry = fakeEntry({ card_no: "0031", 最近输出时间: new Date(T0).toISOString() });
		const now = T0 + 31 * 60_000 + 1;
		let thrower = true;
		const record: { 正文: string; toast: string }[] = [];
		const reminder = createSilenceReminder({
			runner: {
				registry: { list: () => [entry] },
				listActive: () => [fakeLiveness(entry, ["活着但哑"])] as ReturnType<WorkerRunner["listActive"]>,
			} as unknown as WorkerRunner,
			readSilenceMinutes: () => {
				if (thrower) throw new Error("缺少环境变量 PAO_HOME");
				return 30;
			},
			notify: (body, toastBody) => record.push({ 正文: body, toast: toastBody }),
			intervalMs: 3_600_000,
			now: () => now,
		});
		try {
			expect(() => reminder.scan()).not.toThrow();
			expect(record).toHaveLength(0);
			thrower = false;
			reminder.scan();
			expect(record).toHaveLength(1);
			expect(record[0].toast).toContain("卡0031 已静默 31 分钟");
		} finally {
			reminder.stop();
		}
	});

	it("resolvePaoHome 抛错(桌面主进程无 PAO_HOME)整链不崩:扫描 tick 回落缺省静默阈值照常跑", () => {
		vi.useFakeTimers();
		try {
			const runner = new MockRunner();
			runners.push(runner);
			const tools = new Map<string, Tool>();
			const handlers = new Map<string, (event: unknown) => unknown>();
			const pi = {
				registerTool: (tool: { name: string } & Tool) => tools.set(tool.name, tool),
				on: (event: string, handler: (event: unknown) => unknown) => {
					handlers.set(event, handler);
					return () => {};
				},
			} as unknown as ExtensionAPI;
			const face = registerWorkerTools(pi, {
				runner,
				signals: false,
				resolveCardsDir: () => join(temp(), "卡"),
				resolvePaoHome: () => {
					throw new Error("缺少环境变量 PAO_HOME(使用现场根目录,应含「部门/」与「pao配置/」)");
				},
			});
			expect(face.backgroundCount()).toEqual({ inFlight: 0, unread: 0 });
			expect(() => vi.advanceTimersByTime(DEFAULT_SILENCE_SCAN_INTERVAL_MS + 1)).not.toThrow();
			expect(face.backgroundCount()).toEqual({ inFlight: 0, unread: 0 });
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("pao_dispatch_card 非阻塞受理(B 档:派卡通知注入送达)", () => {
	it("注册时活动为空，后派工经 runner registry 刷新启动时钟，到期无需手动 flush", async () => {
		let now = Date.parse("2026-10-22T00:00:00.000Z");
		const cardsDir = join(temp(), "卡");
		await card(cardsDir);
		const local: string[] = [];
		const runner = new MockRunner();
		runners.push(runner);
		const host = new MinisterHost({
			时钟: () => new Date(now),
			监督检查毫秒: 10,
			监督分钟: () => ({ 工人: 15, 部门: 30 }),
			活动: () =>
				buildWorkerSupervisionActivity(runner, {
					role: "minister",
					context: "minister-live",
				}),
			本地上级: {
				department: "测试",
				projectRoot: projectRootForCards(cardsDir),
				context: "minister-live",
				sessionId: "minister-live",
			},
			本地通知: (body) => local.push(body),
		});
		expect(buildWorkerSupervisionActivity(runner, { role: "minister" })).toEqual([]);
		let refreshes = 0;
		const originalRefresh = host.refreshActivity.bind(host);
		vi.spyOn(host, "refreshActivity").mockImplementation(() => {
			refreshes++;
			originalRefresh();
		});
		runner.holdNextRun = true;
		const harnessed = supervisedHarness(runner, cardsDir, host, {
			dispatchParameters: { 证据目录: temp() },
			resolveSupervisionRoute: (input) => ({
				department: "测试",
				projectRoot: projectRootForCards(input.cardsDir),
				context: "minister-live",
				sessionId: "minister-live",
				key: `${input.cardsDir}#卡${input.cardNo}`,
				goal: input.goal,
				target: "local",
				binding: { source: "runtime", role: "minister", target: "local" },
			}),
		});
		const reply = await harnessed.tool("pao_dispatch_card").execute("t", {
			card_ref: "1",
			reason: "验证监督时钟由派工登记变化启动",
		});
		expect(reply.isError).toBeUndefined();
		await until(() => runner.registry.list().some((entry) => entry.running));
		expect(local).toEqual([]);
		expect(refreshes, `runner.run 调用数=${runner.runs.length}`).toBeGreaterThan(0);

		now += 15 * 60_000;
		await until(() => local.length === 1);
		const supervisionNotice = local[0];
		if (supervisionNotice === undefined) throw new Error("监督扫描未在 15 分钟自动投递");
		expect(supervisionNotice).toContain("工人检查间隔 15 分钟");
		expect(supervisionNotice).toContain("离线任务");
		expect(harnessed.face.backgroundCount().inFlight).toBe(1);

		runner.releaseRun();
		await new Promise((resolve) => setTimeout(resolve, 100));
		await harnessed.shutdown();
		const refreshesAfterShutdown = refreshes;
		runner.registry.register({
			pid: 991_003,
			card_no: "after-shutdown",
			command: "退订验证",
		});
		expect(refreshes).toBe(refreshesAfterShutdown);
	});

	it("部长派工立即返回；onBackgroundChange 覆盖在途登记与收敛，本地工人回执只投当前部长", async () => {
		const cardsDir = join(temp(), "卡");
		await card(cardsDir);
		const runner = new MockRunner();
		runners.push(runner);
		const local: string[] = [];
		const host = new MinisterHost({
			paoHome: temp(),
			监督分钟: () => ({ 工人: 15, 部门: 30 }),
			本地上级: { department: "测试", projectRoot: projectRootForCards(cardsDir), context: "minister-local" },
			本地通知: (body) => local.push(body),
		});
		const changes: (number | undefined)[] = [];
		let face!: ReturnType<typeof registerWorkerTools>;
		const injected: string[] = [];
		vi.spyOn(host, "inject").mockImplementation(async (...args) => {
			injected.push(String(args[2]));
			return { ok: true };
		});
		const harnessed = supervisedHarness(runner, cardsDir, host, {
			onBackgroundChange: () => changes.push(face.backgroundCount().inFlight),
			resolveSupervisionRoute: (input) => ({
				department: "测试",
				projectRoot: projectRootForCards(input.cardsDir),
				context: "minister-local",
				sessionId: "minister-local",
				key: `${input.cardsDir}#卡${input.cardNo}`,
				goal: input.goal,
				target: "local",
				binding: { source: "runtime", role: "minister", target: "local" },
			}),
		});
		face = harnessed.face;
		const { tool } = harnessed;
		const started = Date.now();
		const reply = await tool("pao_dispatch_card").execute("t", { card_ref: "1", reason: "部长本地派工" });
		expect(Date.now() - started).toBeLessThan(500);
		expect(reply.isError).toBeUndefined();
		expect(reply.details).toMatchObject({ dispatched: true, card_no: "0001" });
		expect(face.backgroundCount().inFlight).toBe(1);
		await face.waitForBackground();
		expect(changes).toEqual([1, 0]);
		expect(face.backgroundCount().inFlight).toBe(0);
		expect(local).toHaveLength(1);
		expect(local[0]).toContain("[完成] 工人");
		expect(local[0]).toContain("离线假回执");
		expect(injected).toHaveLength(0);
	});

	it("主控空闲时完成派卡只发一次最小 followUp;正文下一轮消费注入;计数归零;回执真落卡", async () => {
		const cardsDir = join(temp(), "卡");
		const card1 = await card(cardsDir);
		const runner = new MockRunner();
		runners.push(runner);
		const { tool, face, readInjection, sent } = harness(runner, cardsDir);
		const result = await tool("pao_dispatch_card").execute("t", { card_ref: "1", reason: "非阻塞冒烟" });
		expect(result.isError).toBeUndefined();
		expect(result.content[0]?.text).toContain("已派出:卡0001");
		expect(result.details).toMatchObject({ dispatched: true, card_no: "0001" });
		expect(face.backgroundCount()).toEqual({ inFlight: 1, unread: 0 });
		await face.waitForBackground();
		expect(face.backgroundCount()).toEqual({ inFlight: 0, unread: 1 });
		expect(sent).toHaveLength(1);
		expect(sent[0]?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
		expect(sent[0]?.message.content[0]?.text).not.toContain("[派卡完成]");
		const inject = readInjection();
		expect(inject).toContain("pao 后台通知");
		expect(inject).toContain("[派卡完成] 卡0001");
		expect(inject).toContain("非阻塞冒烟");
		expect(face.backgroundCount()).toEqual({ inFlight: 0, unread: 0 });
		expect(readInjection()).toBe("");
		await until(() => readCard(card1.path).receipts.length === 1);
		expect(readCard(card1.path).receipts[0]).toMatchObject({ attempt: 1, result: "success" });
		expect(readCard(card1.path).frontmatter.attempt).toBe(1);
	});

	it("后台拒派和失败同样主动唤醒;三份真实正文都留在缓冲,不靠模型轮询", async () => {
		const root = temp();
		const cardsDir = join(root, ".pao", "任务", "卡");
		mkdirSync(root, { recursive: true });
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "init"], { cwd: root, stdio: "ignore" });
		writeFileSync(join(root, "已跟踪.txt"), "v1\n");
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: root, stdio: "ignore" });
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--no-gpg-sign", "-m", "基线"], {
			cwd: root,
			stdio: "ignore",
		});
		await card(cardsDir, { depends_on: ["卡#9"] });
		await card(cardsDir);
		const calls: WorkerRunOptions[] = [];
		class OutcomesRunner extends WorkerRunner {
			override async run(
				options: WorkerRunOptions,
			): Promise<import("../../src/pao/worker/receipt.ts").WorkerReceipt> {
				calls.push(options);
				if (options.卡号 === "0002") throw new Error("离线假 runner 失败");
				return {
					card_no: options.卡号,
					card_path: options.卡路径,
					attempt: options.尝试号 ?? 1,
					status: "success",
					artifact_path: [],
					summary: "离线完成",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
					evidence_path: "",
					exitCode: 0,
					command: "mock",
					pid: -1,
					duration_ms: 1,
				};
			}
		}
		const runner = new OutcomesRunner();
		runners.push(runner);
		const { tool, face, readInjection, sent } = harness(runner, cardsDir);
		await tool("pao_dispatch_card").execute("t1", { card_ref: "1", reason: "依赖拒派" });
		await face.waitForBackground();
		const rejected = readInjection();
		expect(rejected).toContain("[派卡被拒]");
		await tool("pao_dispatch_card").execute("t2", { card_ref: "2", reason: "执行失败" });
		await face.waitForBackground();
		const injection = readInjection();
		expect(calls, `${rejected}\n${injection}`).toHaveLength(1);
		expect(sent.length).toBeGreaterThanOrEqual(1);
		for (const item of sent) {
			expect(item.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
			expect(item.message.content[0]?.text).not.toContain("[派卡");
		}
		expect(injection).toContain("[派卡失败]");
		expect(injection).toContain("离线假 runner 失败");
	});

	it("真实受控子进程全停：取消回执/证据照常落卡，监督清退且不再 sendMessage 唤醒", async () => {
		const cardsDir = join(temp(), "卡");
		const card1 = await card(cardsDir);
		const runner = new WorkerRunner();
		runners.push(runner);
		const local: string[] = [];
		const host = new MinisterHost({
			paoHome: temp(),
			监督分钟: () => ({ 工人: 15, 部门: 30 }),
			本地上级: {
				department: "测试",
				projectRoot: projectRootForCards(cardsDir),
				context: "minister-local",
			},
			本地通知: (body) => local.push(body),
		});
		const sendMessage = vi.fn();
		const tools = new Map<string, Tool>();
		const handlers = new Map<string, (event: unknown) => unknown>();
		const pi = {
			registerTool: (tool: { name: string } & Tool) => tools.set(tool.name, tool),
			on: (event: string, handler: (event: unknown) => unknown) => {
				handlers.set(event, handler);
				return () => {};
			},
			sendMessage,
		} as unknown as ExtensionAPI;
		const script = writeScript(
			[
				`console.log(${JSON.stringify(ASSISTANT_LINE("全停前已输出"))});`,
				"setInterval(() => {}, 1000);",
			].join("\n"),
		);
		const face = registerWorkerTools(pi, {
			runner,
			host,
			signals: false,
			resolveCardsDir: () => cardsDir,
			onBackgroundChange: () => changes.push(face.backgroundCount().inFlight),
			dispatchParameters: {
				命令: process.execPath,
				参数: [script],
				证据目录: temp(),
			},
			resolveSupervisionRoute: (input) => ({
				department: "测试",
				projectRoot: projectRootForCards(input.cardsDir),
				context: "minister-local",
				sessionId: "minister-local",
				key: `${input.cardsDir}#卡${input.cardNo}`,
				goal: input.goal,
				target: "local",
				binding: { source: "runtime", role: "minister", target: "local" },
			}),
		});
		const changes: number[] = [];
		const stopAll = vi.spyOn(host, "stopAll");
		const stopTracking = vi.spyOn(host, "stopTracking");
		const shutdown = handlers.get("session_shutdown");
		if (!shutdown) throw new Error("派卡生命周期钩子未注册");
		shutdowns.push(() => shutdown({}));
		await tools.get("pao_dispatch_card")!.execute("t", {
			card_ref: "1",
			reason: "全停不唤醒",
		});
		await until(() => runner.registry.list().some((entry) => entry.running));
		const stop = await tools.get("pao_stop_background")!.execute("stop");
		expect(stop.content[0]?.text).toContain("已停 1 个进程");
		await face.waitForBackground();
		await until(() => readCard(card1.path).receipts.length === 1);
		expect(readCard(card1.path).receipts[0]).toMatchObject({ attempt: 1, result: "canceled" });
		expect(runner.isStopped()).toBe(true);
		expect(runner.registry.list().filter((entry) => entry.running)).toHaveLength(0);
		expect(runner.registry.list()[0]?.supervision_evidence?.length).toBeGreaterThan(0);
		expect(stopAll).toHaveBeenCalledTimes(1);
		expect(stopTracking).toHaveBeenCalledTimes(1);
		expect(changes).toEqual([1, 0]);
		expect(local).toHaveLength(0);
		expect(sendMessage).not.toHaveBeenCalled();
	});
});

describe("pao_dispatch_card 单次工作树目标（离线工具接线）", () => {
	it("两卡并发分别传递 managed 目标，反序完成后未指定 ID 的派发仍为 primary", async () => {
		const root = temp();
		const cardsDir = join(root, ".pao", "卡");
		await card(cardsDir);
		await card(cardsDir);
		await card(cardsDir);
		const runner = new MockRunner();
		runners.push(runner);
		const worktreeHost = createSingleRootWorktreeHost(root);
		// 这里只替换执行边界并控制完成顺序，验证工具到 executeDispatch 的参数隔离；
		// 不把替身结果当作真实 Git 工作树执行成功。
		const finish: (() => void)[] = [];
		const dispatch = vi.spyOn(dispatchCore, "executeDispatch").mockImplementation(async () => {
			await new Promise<void>((resolve) => finish.push(resolve));
			return { 可派: false, 原因: "离线执行替身" };
		});
		const { tool, face } = harness(runner, cardsDir, { worktreeHost });
		const replies = await Promise.all([
			tool("pao_dispatch_card").execute("a", { card_ref: "1", reason: "甲任务", worktree_id: "managed-a" }),
			tool("pao_dispatch_card").execute("b", { card_ref: "2", reason: "乙任务", worktree_id: "managed-b" }),
		]);
		expect(replies.every((reply) => !reply.isError)).toBe(true);
		expect(face.backgroundCount().inFlight).toBe(2);
		expect(dispatch.mock.calls.map(([input, options]) => [input.card_no, options.worktreeTarget])).toEqual([
			["1", { kind: "managed", worktreeId: "managed-a" }],
			["2", { kind: "managed", worktreeId: "managed-b" }],
		]);
		for (const [input, options] of dispatch.mock.calls) {
			expect(input.cardsDir).toBe(cardsDir);
			expect(options.worktreeHost).toBe(worktreeHost);
			expect(options.workflowCheck).toBeTypeOf("function");
		}
		finish[1]!();
		finish[0]!();
		await face.waitForBackground();
		await tool("pao_dispatch_card").execute("c", { card_ref: "3", reason: "默认目标" });
		expect(dispatch.mock.calls[2]?.[1].worktreeTarget).toEqual({ kind: "primary" });
		// 后续派发不能改掉前两次保存的目标。
		expect(dispatch.mock.calls[0]?.[1].worktreeTarget).toEqual({ kind: "managed", worktreeId: "managed-a" });
		finish[2]!();
		await face.waitForBackground();
		expect(face.backgroundCount().inFlight).toBe(0);
	});

	it("未指定 ID 时，真实 executeDispatch 仍经宿主解析 primary 并完成回执", async () => {
		const root = temp();
		const cardsDir = join(root, ".pao", "卡");
		const created = await card(cardsDir);
		const runner = new MockRunner();
		runners.push(runner);
		const worktreeHost = createSingleRootWorktreeHost(root);
		const resolve = vi.spyOn(worktreeHost, "resolveForDispatch");
		const { tool, face } = harness(runner, cardsDir, { worktreeHost });
		await tool("pao_dispatch_card").execute("primary", { card_ref: "1", reason: "默认主目录" });
		await face.waitForBackground();
		expect(resolve).toHaveBeenCalledTimes(2);
		for (const [request] of resolve.mock.calls) {
			expect(request.projectRoot).toBe(root);
			expect(request.target).toEqual({ kind: "primary" });
		}
		expect(runner.runs).toHaveLength(1);
		expect(readCard(created.path).receipts[0]).toMatchObject({ result: "success" });
	});

	it("真实 executeDispatch 将两卡不同 ID 交给宿主核验；未登记目标失败不降级", async () => {
		const root = temp();
		const cardsDir = join(root, ".pao", "卡");
		const first = await card(cardsDir);
		const second = await card(cardsDir);
		const runner = new MockRunner();
		runners.push(runner);
		const worktreeHost = createSingleRootWorktreeHost(root);
		const resolve = vi.spyOn(worktreeHost, "resolveForDispatch").mockRejectedValue(new Error("工作树 ID 未登记"));
		const { tool, face, readInjection } = harness(runner, cardsDir, { worktreeHost });
		await Promise.all([
			tool("pao_dispatch_card").execute("a", { card_ref: "1", reason: "甲任务", worktree_id: "unknown-a" }),
			tool("pao_dispatch_card").execute("b", { card_ref: "2", reason: "乙任务", worktree_id: "unknown-b" }),
		]);
		await face.waitForBackground();
		expect(resolve.mock.calls.map(([request]) => [request.requestId.split(":")[0], request.target])).toEqual([
			["0001", { kind: "managed", worktreeId: "unknown-a" }],
			["0002", { kind: "managed", worktreeId: "unknown-b" }],
		]);
		expect(readInjection()).toContain("工作树 ID 未登记");
		expect(runner.runs).toHaveLength(0);
		for (const created of [first, second]) {
			expect(readCard(created.path).frontmatter.attempt).toBe(0);
		}
		expect(face.backgroundCount().inFlight).toBe(0);
	});

	it("没有工作树宿主时 managed 明确拒派并清除后台计数，不启动 primary", async () => {
		const cardsDir = join(temp(), "卡");
		const created = await card(cardsDir);
		const runner = new MockRunner();
		runners.push(runner);
		const { tool, face, readInjection } = harness(runner, cardsDir);
		await tool("pao_dispatch_card").execute("managed", { card_ref: "1", reason: "缺宿主", worktree_id: "managed-a" });
		await face.waitForBackground();
		expect(readInjection()).toContain("managed 派发必须由宿主安装工作树服务");
		expect(runner.runs).toHaveLength(0);
		expect(readCard(created.path).frontmatter.attempt).toBe(0);
		expect(face.backgroundCount().inFlight).toBe(0);
	});

	it.each(["", "   "])("空白 ID %j 同步拒派，不按缺省目标执行", async (worktree_id) => {
		const cardsDir = join(temp(), "卡");
		await card(cardsDir);
		const runner = new MockRunner();
		runners.push(runner);
		const { tool, face } = harness(runner, cardsDir);
		const reply = await tool("pao_dispatch_card").execute("blank", { card_ref: "1", reason: "空白 ID", worktree_id });
		expect(reply.isError).toBe(true);
		expect(reply.content[0]?.text).toContain("worktree_id 不得为空");
		expect(runner.runs).toHaveLength(0);
		expect(face.backgroundCount().inFlight).toBe(0);
	});
});

describe("pao_terminate_card(B 档上级裁决)", () => {
	it("无运行中条目报错不误伤", async () => {
		const cardsDir = join(temp(), "卡");
		await card(cardsDir);
		const runner = new WorkerRunner();
		runners.push(runner);
		const { tool } = harness(runner, cardsDir);
		const result = await tool("pao_terminate_card").execute("t", { card_ref: "1" });
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("无运行中的卡0001");
	});

	it("真子进程:树杀→登记表清→owner 侧「取消」回执落卡,回复带已终止", async () => {
		const cardsDir = join(temp(), "卡");
		const card1 = await card(cardsDir);
		// 派发链真实形状:派单先认领(尝试 0→1、进行中)再拉起 worker——终止落在「进行中的卡」上
		changeCardStatus(card1, { 操作者: "主控", to: "in_progress", 时间: "2026-10-03 10:00" });
		const runner = new WorkerRunner();
		runners.push(runner);
		const script = writeScript(
			[`console.log(${JSON.stringify(ASSISTANT_LINE("被杀前输出"))});`, "setInterval(() => {}, 1000);"].join("\n"),
		);
		const evidenceDir = temp();
		const runPromise = runner.run({
			卡号: "0001",
			尝试号: 1,
			提示词: "终止用例",
			命令: process.execPath,
			参数: [script],
			证据目录: evidenceDir,
			cwd: evidenceDir,
			卡路径: card1.path,
		});
		await until(() => runner.registry.list().some((entry) => entry.running && entry.card_no === "0001"));
		const { tool } = harness(runner, cardsDir);
		const result = await tool("pao_terminate_card").execute("t", { card_ref: "1" });
		expect(result.isError).toBeUndefined();
		expect(result.content[0]?.text).toContain("已终止");
		const settled = await runPromise;
		expect(["canceled", "unknown"]).toContain(settled.status);
		expect(runner.registry.list().filter((entry) => entry.running)).toHaveLength(0);
		await until(() => readCard(card1.path).receipts.length === 1);
		// 卡面回执存储形状是 Receipt:结果(非 WorkerReceipt.状态)、stopReason 不入卡面
		expect(readCard(card1.path).receipts[0]).toMatchObject({ attempt: 1, result: "canceled" });
	});

	it("跨项目同号:终止只杀本卡目录的 worker,他项目同号条目不受扰（K3 红:现行裸卡号匹配连他项目一起终止）", async () => {
		const projectA = join(temp(), "卡");
		const projectB = join(temp(), "卡");
		const cardA = await card(projectA);
		await card(projectB); // 两项目各自计数器,同号 0001
		// 预落同尝试回执:终止后等派发链落「取消」回执的 2s 轮询窗口即 landed,不必空等
		changeCardStatus(cardA, { 操作者: "主控", to: "in_progress", 时间: "2026-10-03 10:00" });
		await appendDispatchReceipt(cardA, {
			card_no: "0001",
			attempt: 1,
			status: "success",
			artifact_path: [],
			summary: "预落回执",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			evidence_path: "",
			exitCode: 0,
			command: "fake",
			pid: -1,
			duration_ms: 1,
		});
		const runner = new WorkerRunner();
		runners.push(runner);
		// 同会话两项目各派一张同号卡在跑（登记表两条活条目,卡路径各异——派发链恒带卡路径）
		runner.registry.register({
			pid: 111,
			card_no: "0001",
			card_path: cardA.path,
			attempt: 1,
			run_id: "exec-A",
			command: "fake",
		});
		runner.registry.register({
			pid: 222,
			card_no: "0001",
			card_path: join(projectB, "卡0001.md"),
			attempt: 1,
			run_id: "exec-B",
			command: "fake",
		});
		const { tool } = harness(runner, projectA);
		const result = await tool("pao_terminate_card").execute("t", { card_ref: "1" });
		expect(result.isError).toBeUndefined();
		const stillRunning = runner.registry.list().filter((entry) => entry.running);
		expect(stillRunning).toHaveLength(1); // 红:现行按裸卡号匹配→A/B 两条都被摘成 0 条
		expect(stillRunning[0]?.run_id).toBe("exec-B"); // 他项目同号不受扰
	});

	it("等回执轮询:读卡瞬时失败不提前退场——已有回执不双落（Windows 原子写并发可 EPERM）", async () => {
		const cardsDir = join(temp(), "卡");
		const cardA = await card(cardsDir);
		changeCardStatus(cardA, { 操作者: "主控", to: "in_progress", 时间: "2026-10-03 10:00" });
		// 预落该尝试回执（派发链已落卡的形状）:轮询应穿透瞬时读失败看到它,不走补写兜底
		await appendDispatchReceipt(cardA, {
			card_no: "0001",
			attempt: 1,
			status: "success",
			artifact_path: [],
			summary: "预落回执",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			evidence_path: "",
			exitCode: 0,
			command: "fake",
			pid: -1,
			duration_ms: 1,
		});
		const runner = new WorkerRunner();
		runners.push(runner);
		runner.registry.register({
			pid: 111,
			card_no: "0001",
			card_path: cardA.path,
			attempt: 1,
			run_id: "exec-A",
			command: "fake",
		});
		const { tool } = harness(runner, cardsDir);
		const readSpy = vi.spyOn(cards, "readCard").mockImplementationOnce(() => {
			throw new Error("EPERM: operation not permitted, rename");
		});
		const result = await tool("pao_terminate_card").execute("t", { card_ref: "1" });
		readSpy.mockRestore();
		expect(result.isError).toBeUndefined();
		// 瞬时失败被轮询穿透:预落回执仍在且只有一份,没有补写出第二份
		expect(readCard(cardA.path).receipts).toHaveLength(1);
		expect(readCard(cardA.path).receipts[0]).toMatchObject({ attempt: 1, result: "success" });
	});

	it("等回执兜底幂等:轮询期读卡连续失败、兜底时刻读恢复且卡面已有该尝试回执 → 不补写第二份", async () => {
		const cardsDir = join(temp(), "卡");
		const cardA = await card(cardsDir);
		changeCardStatus(cardA, { 操作者: "主控", to: "in_progress", 时间: "2026-10-03 10:00" });
		// 预落该尝试回执（派发链恰在轮询窗口内落卡的形状）:轮询读全失败看不到它,兜底读恢复才看到
		await appendDispatchReceipt(cardA, {
			card_no: "0001",
			attempt: 1,
			status: "success",
			artifact_path: [],
			summary: "预落回执",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			evidence_path: "",
			exitCode: 0,
			command: "fake",
			pid: -1,
			duration_ms: 1,
		});
		const runner = new WorkerRunner();
		runners.push(runner);
		runner.registry.register({
			pid: 111,
			card_no: "0001",
			card_path: cardA.path,
			attempt: 1,
			run_id: "exec-A",
			command: "fake",
		});
		const { tool } = harness(runner, cardsDir);
		// 读失败锚定在轮询自己的 2s deadline 上:首读即轮询入口,此后 2s 内全失败、deadline 后恢复真读
		const realRead = cards.readCard;
		let failUntil = 0;
		const readSpy = vi.spyOn(cards, "readCard").mockImplementation(((path: string) => {
			if (failUntil === 0) failUntil = Date.now() + 2_000;
			if (Date.now() < failUntil) throw new Error("EPERM: operation not permitted, rename");
			return realRead(path);
		}) as typeof cards.readCard);
		const result = await tool("pao_terminate_card").execute("t", { card_ref: "1" });
		readSpy.mockRestore();
		expect(result.isError).toBeUndefined();
		// 兜底补写前再核同尝试回执:卡面已有则跳过,不双落污染用量聚合
		expect(readCard(cardA.path).receipts).toHaveLength(1);
		expect(readCard(cardA.path).receipts[0]).toMatchObject({ attempt: 1, result: "success" });
	});
});

// ── 已终态/进行中卡同步拒派（2026-10-05 修：即时回执直接带拒派原因，不等派卡通知） ──
describe("pao_dispatch_card 已终态/进行中卡同步拒派", () => {
	it("已交付卡重复派单:即时回执直接给拒派原因,不后台拉起、不进在途", async () => {
		const cardsDir = join(temp(), "卡");
		const card1 = await card(cardsDir);
		// 状态机不允许跳迁：待认领 → 进行中 → 已交付
		changeCardStatus(card1, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-03 10:02" });
		changeCardStatus(card1, { 操作者: "部长A", to: "delivered", 时间: "2026-10-03 10:05" });
		const runner = new MockRunner();
		runners.push(runner);
		const { tool, face } = harness(runner, cardsDir);
		const result = await tool("pao_dispatch_card").execute("t", { card_ref: "1", reason: "重复派单" });
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("派单未执行");
		expect(result.content[0]?.text).toContain("卡已终态(delivered)");
		expect(result.content[0]?.text).toContain("另立新卡");
		expect(runner.runs).toHaveLength(0);
		expect(face.backgroundCount().inFlight).toBe(0);
	});

	it("进行中卡同样即时拒派(不双跑文案与后台链一致)", async () => {
		const cardsDir = join(temp(), "卡");
		const card1 = await card(cardsDir);
		changeCardStatus(card1, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-03 10:05" });
		const runner = new MockRunner();
		runners.push(runner);
		const { tool } = harness(runner, cardsDir);
		const result = await tool("pao_dispatch_card").execute("t", { card_ref: "1", reason: "再派一次" });
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("派单未执行");
		expect(result.content[0]?.text).toContain("不双跑");
		expect(runner.runs).toHaveLength(0);
	});
});
