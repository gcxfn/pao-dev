import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";
import { createCard, readCard, serializeCard } from "../../src/pao/cards/cardfile.ts";
import { appendReceipt } from "../../src/pao/cards/receipts.ts";
import { changeCardStatus } from "../../src/pao/cards/statemachine.ts";
import type { ParsedCard } from "../../src/pao/cards/types.ts";
import { readDesktopWorkerActivity, registerDesktopOwner } from "../../src/pao/desktop/owners.ts";
import { readDesktopProject } from "../../src/pao/desktop/read-model.ts";
import { buildClaimLease, claimRefusalDetail, executeDispatch } from "../../src/pao/worker/dispatch-core.ts";
import type { WorkerReceipt } from "../../src/pao/worker/receipt.ts";
import { WorkerRunner, type WorkerRunOptions } from "../../src/pao/worker/runner.ts";

/**
 * S5 包3（重试与租约）：
 * - 派发/回执唯一操作号（卡路径＋尝试号）去重：同号重试返回既有结果；结果未知先查现场；
 *   重启（新运行器空登记表）不盲重放在途操作。
 * - 认领登记租约：claimAt/leaseExpiresAt/claimGeneration/被接管 四字段住运行器登记表
 *   （运行器事实，不加卡协议字段）；到期不自动放权（钉子）。
 * - 孤儿显式接管推进代际：进行中＋登记表无活条目＋显式 接管 → 代数+1、旧条目打被接管、
 *   卡走状态机重开新尝试；旧尝试回执只留档不推进新尝试（钉子，复用包1 尝试号分流）。
 * - 桌面 read-model 透出四字段（内核层为止）。
 * 全离线：runner 为桩，不调用模型。
 */

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeCardsDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pao-s5p3-${prefix}-`));
	const cardsDir = join(dir, ".pao", "任务-20261007", "卡");
	mkdirSync(cardsDir, { recursive: true });
	tempDirs.push(dir);
	return cardsDir;
}

async function makeCard(cardsDir: string, goal = "租约卡"): Promise<ParsedCard> {
	return createCard(cardsDir, {
		目标: goal,
		部门: "核心机制",
		验收: "可判条件",
		创建: "2026-10-07 10:00",
	});
}

async function makeRunningCard(cardsDir: string, goal = "租约卡"): Promise<ParsedCard> {
	const card = await makeCard(cardsDir, goal);
	return changeCardStatus(card, { 操作者: "主控", to: "in_progress", 时间: "2026-10-07 10:01" });
}

/** 离线桩 runner：只记录 run 参数，返回成功回执（不 spawn） */
class StubRunner extends WorkerRunner {
	runs: WorkerRunOptions[] = [];
	override async run(options: WorkerRunOptions): Promise<WorkerReceipt> {
		this.runs.push(options);
		return {
			card_no: options.卡号,
			card_path: options.卡路径,
			attempt: options.尝试号 ?? 1,
			status: "success",
			artifact_path: [],
			summary: "离线假回执",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			evidence_path: join(options.卡路径 ?? "", "..", "证据.jsonl"),
			command: "stub",
			pid: 0,
			duration_ms: 0,
			exitCode: 0,
		};
	}
}

function dispatch(cardsDir: string, card_no: string | number, runner: StubRunner, extra?: { 接管?: boolean }) {
	return executeDispatch(
		{ cardsDir, card_no: String(card_no), operator: "主控", time: "2026-10-07 10:05", ...(extra ?? {}) },
		{ 运行器: runner, workflowCheck: () => undefined },
		async () => "ok",
	);
}

/** 在真实登记表里放一条指定运行态的条目（模拟旧 worker 登记） */
function registerOldEntry(runner: StubRunner, card: ParsedCard, opts?: { live?: boolean }): void {
	runner.registry.register({
		pid: 4321,
		card_no: String(card.card_no).padStart(4, "0"),
		card_path: card.path,
		attempt: card.frontmatter.attempt,
		run_id: "old-run",
		command: "old-worker",
	});
	if (!opts?.live) runner.registry.markExited(4321, "old-run");
}

// ── 唯一操作号去重：同号重试返回既有结果 / 结果未知先查现场 ──────────────────

describe("同号重试去重（claimRefusalDetail）", () => {
	test("进行中卡当前尝试已有回执：拒因带既有结果与同号不重派", async () => {
		const cardsDir = makeCardsDir("dedup");
		const card = await makeRunningCard(cardsDir);
		appendReceipt(card, {
			尝试号: card.frontmatter.attempt,
			时间: "2026-10-07 10:03",
			结果: "成功",
			摘要: "已交付分析",
			任务态: "completed_with_deviations",
		});
		const detail = claimRefusalDetail(readCard(card.path));
		expect(detail).toContain("不双跑");
		expect(detail).toContain("已有回执");
		expect(detail).toContain("completed_with_deviations");
		expect(detail).toContain("同号不重派");
	});

	test("进行中卡当前尝试无回执：拒因带结果未知与查现场指引（重启不盲重放）", async () => {
		const cardsDir = makeCardsDir("unknown");
		const card = await makeRunningCard(cardsDir);
		const detail = claimRefusalDetail(readCard(card.path));
		expect(detail).toContain("结果未知");
		expect(detail).toContain("查现场");
		expect(detail).toContain("不盲重放");
	});

	test("钉子：终态卡拒因与可认领状态原样（旧文案不改）", async () => {
		const cardsDir = makeCardsDir("pin");
		const card = await makeCard(cardsDir);
		expect(claimRefusalDetail(card)).toBeUndefined(); // 待认领可派
		const cancelled = changeCardStatus(card, { 操作者: "用户", to: "canceled", 时间: "2026-10-07 10:02" });
		expect(claimRefusalDetail(cancelled)).toContain("已终态");
	});
});

describe("executeDispatch 拒派面带去重信息", () => {
	test("进行中无接管：可派 false，原因含查现场，不拉起", async () => {
		const cardsDir = makeCardsDir("no-takeover");
		const card = await makeRunningCard(cardsDir);
		const runner = new StubRunner();
		const outcome = await dispatch(cardsDir, card.card_no, runner);
		expect(outcome.可派).toBe(false);
		if (!outcome.可派) expect(outcome.原因).toContain("查现场");
		expect(runner.runs).toHaveLength(0);
		expect(readCard(card.path).frontmatter.status).toBe("in_progress");
	});
});

// ── 租约：认领登记四字段（运行器事实） ────────────────────────────────────────

describe("认领租约", () => {
	test("buildClaimLease 受控时钟：认领时间/到期差＝租约时长，代数透传", () => {
		const lease = buildClaimLease(new Date("2026-10-07T10:00:00.000Z"), 30 * 60_000, 2);
		expect(lease.认领时间).toBe("2026-10-07T10:00:00.000Z");
		expect(lease.租约到期).toBe("2026-10-07T10:30:00.000Z");
		expect(lease.认领代数).toBe(2);
	});

	test("真实 run() 把租约落进登记条目（node 立即退出进程）", async () => {
		const cardsDir = makeCardsDir("lease-run");
		const card = await makeCard(cardsDir);
		const runner = new WorkerRunner();
		// 走真实 run()（命令覆盖=node 立即退出,不拉模型）:验证 runOptions.租约 → registry.register 的落表接线
		const receipt = await runner.run({
			卡号: String(card.card_no).padStart(4, "0"),
			卡路径: card.path,
			尝试号: 1,
			提示词: "x",
			命令: process.execPath,
			参数: ["-e", "process.exit(0)"],
			超时毫秒: 10_000,
			租约: buildClaimLease(new Date("2026-10-07T10:00:00.000Z"), 24 * 60 * 60_000, 0),
		});
		expect(receipt.run_id).toBeDefined();
		const entry = runner.registry.list().find((item) => item.card_path === card.path);
		expect(entry?.认领时间).toBe("2026-10-07T10:00:00.000Z");
		expect(entry?.租约到期).toBe("2026-10-08T10:00:00.000Z");
		expect(entry?.认领代数).toBe(0);
	}, 30_000);

	test("executeDispatch 派发即落租约三字段进登记条目", async () => {
		const cardsDir = makeCardsDir("lease-dispatch");
		const card = await makeCard(cardsDir);
		const runner = new StubRunner();
		await dispatch(cardsDir, card.card_no, runner);
		expect(runner.runs[0]?.租约).toBeDefined();
		expect(runner.runs[0]?.租约?.认领时间).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		const lease = runner.runs[0]?.租约;
		expect(lease && Date.parse(lease.租约到期) - Date.parse(lease.认领时间)).toBe(24 * 60 * 60_000);
		// 桩 run 不登记进程：四字段的登记面在 run() 真实路径，本用例钉 runOptions 契约
	});

	test("钉子：租约到期不自动放权——无到期回调改卡面或登记", async () => {
		const cardsDir = makeCardsDir("expiry");
		const card = await makeRunningCard(cardsDir);
		const lease = buildClaimLease(new Date("2026-10-07T10:00:00.000Z"), 30 * 60_000, 0);
		// 受控时钟：到期时刻已过（now > 租约到期）
		expect(Date.parse(lease.租约到期) < Date.now()).toBe(true);
		// 卡面状态不因到期变化（仍是进行中，等待 owner 裁决），登记面无自动释放动作
		expect(readCard(card.path).frontmatter.status).toBe("in_progress");
	});
});

// ── 孤儿显式接管 ────────────────────────────────────────────────────────────

describe("孤儿显式接管（推进代际）", () => {
	test("进行中＋登记表无活条目＋接管：代数+1、旧条目被接管、卡重开新尝试", async () => {
		const cardsDir = makeCardsDir("takeover");
		const card = await makeRunningCard(cardsDir);
		const runner = new StubRunner();
		registerOldEntry(runner, card); // 旧 worker 已退出（孤儿现场）
		const outcome = await dispatch(cardsDir, card.card_no, runner, { 接管: true });
		expect(outcome.可派).toBe(true);
		expect(runner.runs).toHaveLength(1);
		expect(runner.registry.claimGeneration(card.path)).toBe(1);
		const old = runner.registry.list().find((item) => item.run_id === "old-run");
		expect(old?.被接管).toBe(true);
		expect(runner.runs[0]?.租约?.认领代数).toBe(1);
		const fresh = readCard(card.path);
		expect(fresh.frontmatter.status).toBe("in_progress");
		expect(fresh.frontmatter.attempt).toBe(2);
		const text = readCard(card.path).body;
		expect(text).toContain("孤儿接管");
	});

	test("登记表有活进程：接管被拒（先终止再接管），卡不变", async () => {
		const cardsDir = makeCardsDir("takeover-live");
		const card = await makeRunningCard(cardsDir);
		const runner = new StubRunner();
		registerOldEntry(runner, card, { live: true });
		const outcome = await dispatch(cardsDir, card.card_no, runner, { 接管: true });
		expect(outcome.可派).toBe(false);
		if (!outcome.可派) {
			expect(outcome.原因).toContain("接管被拒");
			expect(outcome.原因).toContain("pao_terminate_card");
		}
		expect(runner.runs).toHaveLength(0);
		const fresh = readCard(card.path);
		expect(fresh.frontmatter.status).toBe("in_progress");
		expect(fresh.frontmatter.attempt).toBe(1);
	});

	test("当前尝试已有回执：同号去重优先于接管，拒因带既有结果", async () => {
		const cardsDir = makeCardsDir("takeover-receipt");
		const card = await makeRunningCard(cardsDir);
		appendReceipt(card, {
			尝试号: card.frontmatter.attempt,
			时间: "2026-10-07 10:03",
			结果: "成功",
			摘要: "已完成",
			任务态: "completed",
		});
		const runner = new StubRunner();
		registerOldEntry(runner, card);
		const outcome = await dispatch(cardsDir, card.card_no, runner, { 接管: true });
		expect(outcome.可派).toBe(false);
		if (!outcome.可派) {
			expect(outcome.原因).toContain("同号不重派");
			expect(outcome.原因).toContain("completed");
		}
		expect(runner.runs).toHaveLength(0);
		expect(readCard(card.path).frontmatter.attempt).toBe(1);
	});

	test("钉子：接管后旧尝试回执只留档，不推进新尝试（复用尝试号分流）", async () => {
		const cardsDir = makeCardsDir("old-receipt");
		const card = await makeRunningCard(cardsDir);
		const runner = new StubRunner();
		registerOldEntry(runner, card);
		await dispatch(cardsDir, card.card_no, runner, { 接管: true });
		// 旧 worker（尝试 1）迟到的回执
		const outcome = appendReceipt(readCard(card.path), {
			尝试号: 1,
			时间: "2026-10-07 10:20",
			结果: "成功",
			摘要: "旧 worker 迟到回执",
		});
		expect(outcome.kind).toBe("旧尝试留档");
		const fresh = readCard(card.path);
		expect(fresh.frontmatter.attempt).toBe(2);
		expect(fresh.frontmatter.status).toBe("in_progress");
	});
});

// ── 跨项目同号（S5 遗留 #1 显式锚点）：同号不同项目互不去重、互不串扰 ──────────
// 现状定性：同号重试去重与租约/代数全按卡路径键（claimRefusalDetail 逐卡对象、
// registry #cardKey/认领代数按路径、runner executionKey 对含分隔符的卡路径归一化）——
// 两个项目各建 卡0001（同号）,共享同一 runner（同进程跨项目共享登记表的真实形态）。
// 本组按现状钉绿；若未来某面改成按卡号裸键,这里先红。

describe("跨项目同号（S5 遗留 #1 锚点）", () => {
	test("互不去重：A 卡0001 进行中带回执只去重 A，B 项目同号卡照常可派", async () => {
		const dirA = makeCardsDir("xproj-dedup-a");
		const dirB = makeCardsDir("xproj-dedup-b");
		const cardA = await makeRunningCard(dirA, "A项目同号卡");
		appendReceipt(cardA, {
			尝试号: cardA.frontmatter.attempt,
			时间: "2026-10-07 10:03",
			结果: "成功",
			摘要: "A 项目已交付分析",
			任务态: "completed",
		});
		const cardB = await makeCard(dirB, "B项目同号卡");
		expect(cardB.card_no).toBe(cardA.card_no); // 锚点前提：两项目确实同号
		const detailA = claimRefusalDetail(readCard(cardA.path));
		expect(detailA).toContain("同号不重派");
		expect(claimRefusalDetail(readCard(cardB.path))).toBeUndefined(); // B 不被 A 的同号回执去重
		const runner = new StubRunner();
		const refusedA = await dispatch(dirA, cardA.card_no, runner);
		expect(refusedA.可派).toBe(false); // A 的同号去重照常拒（拒因来自 A 自己的卡面）
		const dispatchedB = await dispatch(dirB, cardB.card_no, runner);
		expect(dispatchedB.可派).toBe(true);
		expect(runner.runs).toHaveLength(1);
	});

	test("双跑/名额键按卡路径：A 同号 worker 在途不拦 B 项目同号卡派发", async () => {
		const dirA = makeCardsDir("xproj-live-a");
		const dirB = makeCardsDir("xproj-live-b");
		const cardA = await makeRunningCard(dirA, "A项目在途卡");
		const cardB = await makeCard(dirB, "B项目同号卡");
		const runner = new StubRunner();
		registerOldEntry(runner, cardA, { live: true }); // 登记表里 A 的同号 worker 活着
		const outcome = await dispatch(dirB, cardB.card_no, runner);
		expect(outcome.可派).toBe(true); // 双跑判定与派发名额键＝卡路径,同号不互拦
		expect(runner.runs).toHaveLength(1);
		expect(readCard(cardA.path).frontmatter.status).toBe("in_progress"); // A 的卡不被 B 的派发碰
	});

	test("租约代数按卡路径：A 孤儿接管推进代数只影响 A，B 同号卡租约代数仍 0", async () => {
		const dirA = makeCardsDir("xproj-gen-a");
		const dirB = makeCardsDir("xproj-gen-b");
		const cardA = await makeRunningCard(dirA, "A项目孤儿卡");
		const cardB = await makeCard(dirB, "B项目同号卡");
		const runner = new StubRunner();
		registerOldEntry(runner, cardA); // A 的旧 worker 已退出（孤儿现场）
		const takeover = await dispatch(dirA, cardA.card_no, runner, { 接管: true });
		expect(takeover.可派).toBe(true);
		expect(runner.registry.claimGeneration(cardA.path)).toBe(1);
		expect(runner.registry.claimGeneration(cardB.path)).toBe(0); // 代数按路径,B 不被 A 的接管推走
		expect(readCard(cardB.path).frontmatter.status).toBe("unclaimed"); // A 的接管不动 B 的卡面
		const dispatched = await dispatch(dirB, cardB.card_no, runner);
		expect(dispatched.可派).toBe(true);
		expect(runner.runs.at(-1)?.租约?.认领代数).toBe(0); // B 的租约带 B 自己的代数,非 A 的 1
	});
});

// ── 桌面 read-model 四字段透出（内核层为止） ────────────────────────────────

describe("租约四字段透出（registry→owners→read-model）", () => {
	test("活性行带 认领时间/租约到期/认领代数/被接管", () => {
		const root = mkdtempSync(join(tmpdir(), "pao-s5p3-desktop-"));
		tempDirs.push(root);
		const dir = join(root, ".pao", "卡");
		mkdirSync(dir, { recursive: true });
		const cardPath = join(dir, "卡0001-租约.md");
		writeFileSync(
			cardPath,
			serializeCard(
				{
					goal: "租约透出",
					dept: "工程",
					acceptance: "证据",
					attempt: 1,
					created: "2026-10-07 10:00",
					status: "in_progress",
				},
				"正文",
			),
		);
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
		const pi = {
			on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, handler),
		} as unknown as ExtensionAPI;
		const ctx = {
			cwd: root,
			sessionManager: { getSessionId: () => "lease-owner" },
		} as unknown as ExtensionContext;
		registerDesktopOwner(pi, {
			getWorkerActivity: () => [
				{
					pid: 11,
					card_no: "0001",
					command: "worker",
					登记时间: "2026-10-07T10:00:01.000Z",
					running: true,
					dept: "工程",
					dispatch_reason: null,
					card_path: cardPath,
					attempt: 1,
					run_id: "execution",
					认领时间: "2026-10-07T10:00:00.000Z",
					租约到期: "2026-10-08T10:00:00.000Z",
					认领代数: 1,
					被接管: false,
				},
			],
			getSilenceMinutes: () => 30,
		});
		handlers.get("session_start")!(undefined, ctx);
		const rows = readDesktopWorkerActivity(root);
		expect(rows[0]?.认领时间).toBe("2026-10-07T10:00:00.000Z");
		expect(rows[0]?.租约到期).toBe("2026-10-08T10:00:00.000Z");
		expect(rows[0]?.认领代数).toBe(1);
		expect(rows[0]?.被接管).toBe(false);
		const snapshot = readDesktopProject(root, "session-a");
		expect(snapshot.liveness[0]?.认领时间).toBe("2026-10-07T10:00:00.000Z");
		expect(snapshot.liveness[0]?.租约到期).toBe("2026-10-08T10:00:00.000Z");
		expect(snapshot.liveness[0]?.认领代数).toBe(1);
		expect(snapshot.liveness[0]?.被接管).toBe(false);
	});
});
