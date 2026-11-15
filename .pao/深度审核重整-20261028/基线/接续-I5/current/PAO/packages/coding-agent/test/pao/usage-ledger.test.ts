/**
 * §15/M2-04 尾：跨会话用量账本（用量账.jsonl）单测。
 * 纯函数族（行构造/解析容错/聚合/渲染空态与下界标注）＋薄 IO 往返（临时目录）＋
 * registerUsageFooter 落账钩子集成（session_start→turn_end→session_shutdown 恰落一行；
 * 无钩子零文件零行为）＋/状态 用量区渲染（有账/空态）。
 * 不起子进程;每轮 footer 会话内行为由既有 usage-footer 测试覆盖,不在此重复。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { renderStatusPage } from "../../src/pao/status/index.ts";
import {
	aggregateLedger,
	appendLedgerRow,
	buildLedgerRow,
	formatLedgerSummary,
	parseLedger,
	readLedgerText,
	renderLedgerRow,
	USAGE_LEDGER_FILENAME,
	type UsageLedgerRow,
	usageLedgerPath,
} from "../../src/pao/usage/ledger.ts";
import { absorbTurnUsage, createUsageFooterState, registerUsageFooter } from "../../src/pao/worker/usage-display.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-usage-ledger-"));
	tempDirs.push(dir);
	return dir;
}

function row(partial: Partial<UsageLedgerRow> = {}): UsageLedgerRow {
	return {
		会话开始: "2026-10-03T10:00:00.000Z",
		会话结束: "2026-10-03T10:30:00.000Z",
		角色: "主控",
		input: 1000,
		output: 500,
		cacheRead: 2000,
		cost: 0.05,
		turns: 10,
		缺用量轮次: 0,
		...partial,
	};
}

// ============================================================================
// 纯函数族
// ============================================================================

describe("跨会话用量账·纯函数", () => {
	it("buildLedgerRow 从会话累计快照构造一行（字段对齐,会话结束取 now）", () => {
		const state = createUsageFooterState();
		state.累计.input = 1200;
		state.累计.output = 300;
		state.累计.cacheRead = 98000;
		state.累计.cost = 0.031;
		state.累计.turns = 4;
		state.缺用量轮次 = 1;
		const now = new Date("2026-10-03T12:00:00.000Z");
		const built = buildLedgerRow(state, "部长", "2026-10-03T11:00:00.000Z", now);
		expect(built).toEqual({
			会话开始: "2026-10-03T11:00:00.000Z",
			会话结束: "2026-10-03T12:00:00.000Z",
			角色: "部长",
			input: 1200,
			output: 300,
			cacheRead: 98000,
			cost: 0.031,
			turns: 4,
			缺用量轮次: 1,
		});
	});

	it("renderLedgerRow→parseLedger 往返无损（空行跳过）", () => {
		const a = row();
		const b = row({ 角色: "worker", turns: 3 });
		const text = [renderLedgerRow(a), "", renderLedgerRow(b), ""].join("\n");
		const parsed = parseLedger(text);
		expect(parsed.坏行数).toBe(0);
		expect(parsed.rows).toEqual([a, b]);
	});

	it("坏行如实计数:非 JSON 行与字段形状不对的行都跳过", () => {
		const good = renderLedgerRow(row());
		const text = [good, "不是json", JSON.stringify({ turns: "x" }), JSON.stringify({ input: 1 })].join("\n");
		const parsed = parseLedger(text);
		expect(parsed.rows).toEqual([row()]);
		expect(parsed.坏行数).toBe(3);
	});

	it("aggregateLedger 多会话求和＋按角色分组＋缺账会话计数", () => {
		const agg = aggregateLedger([
			row({ 角色: "主控", turns: 10, input: 1000, cost: 0.05 }),
			row({ 角色: "主控", turns: 5, input: 500, cost: 0.02, 缺用量轮次: 2 }),
			row({ 角色: "worker", turns: 3, input: 300, cost: 0.01 }),
		]);
		expect(agg.会话数).toBe(3);
		expect(agg.按角色).toEqual({ 主控: 2, worker: 1 });
		expect(agg.turns).toBe(18);
		expect(agg.input).toBe(1800);
		expect(agg.cost).toBeCloseTo(0.08);
		expect(agg.缺账会话数).toBe(1);
	});

	it("formatLedgerSummary 正常态:角色固定序(主控→部长→worker)＋轮次＋成本", () => {
		const text = formatLedgerSummary(
			aggregateLedger([
				row({ 角色: "worker", turns: 3 }),
				row({ 角色: "部长", turns: 2 }),
				row({ 角色: "主控", turns: 10 }),
			]),
		);
		expect(text).toContain("会话 3（主控 1 · 部长 1 · worker 1）");
		expect(text).toContain("轮次 15");
		expect(text).toContain("$0.15");
		expect(text).toContain(`跨会话累计 · ${USAGE_LEDGER_FILENAME}`);
	});

	it("formatLedgerSummary 缺账会话明示已知下界;坏行如实报数", () => {
		const text = formatLedgerSummary(aggregateLedger([row({ 缺用量轮次: 1 }), row({ 缺用量轮次: 3 })]), 2);
		expect(text).toContain("2 会话未回 usage——累计为已知下界");
		expect(text).toContain("2 行坏行已跳过");
	});

	it("formatLedgerSummary 零会话＝如实空态不冒充零用量", () => {
		const text = formatLedgerSummary(aggregateLedger([]));
		expect(text).toContain("尚无跨会话账");
		expect(text).toContain("如实缺账不补记");
		expect(text).not.toContain("$0");
	});
});

// ============================================================================
// 薄 IO 往返（临时目录）
// ============================================================================

describe("跨会话用量账·IO", () => {
	it("appendLedgerRow 追加一行＋readLedgerText 读回;路径在 PAO_HOME 根", () => {
		const home = tempDir();
		expect(usageLedgerPath(home)).toBe(join(home, USAGE_LEDGER_FILENAME));
		const a = row();
		const b = row({ 角色: "worker" });
		appendLedgerRow(home, a);
		appendLedgerRow(home, b);
		expect(readLedgerText(home)).toBe(`${renderLedgerRow(a)}\n${renderLedgerRow(b)}\n`);
	});

	it("readLedgerText 文件不存在＝空串（尚未开账,不是错误）", () => {
		expect(readLedgerText(tempDir())).toBe("");
	});
});

// ============================================================================
// registerUsageFooter 落账钩子集成
// ============================================================================

type AnyHandler = (event: never, ctx: never) => unknown;

function capturePi() {
	const manager = SessionManager.inMemory();
	const handlers = new Map<string, AnyHandler[]>();
	const pi = {
		on: (event: string, handler: AnyHandler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	};
	return { handlers, manager, pi: pi as unknown as ExtensionAPI };
}

async function fire(captured: ReturnType<typeof capturePi>, event: string, payload: unknown): Promise<void> {
	if (event === "session_start") captured.manager.newSession();
	if (event === "turn_end") {
		const message = (payload as { message: { role: string; usage?: Record<string, unknown> } }).message;
		captured.manager.appendMessage({
			...message,
			...(message.usage
				? {
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							...message.usage,
							cost: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								total: 0,
								...(message.usage.cost as object),
							},
						},
					}
				: {}),
		} as never);
	}
	const ctx = { sessionManager: captured.manager, ui: { setStatus: () => {} } };
	for (const handler of captured.handlers.get(event) ?? []) {
		await handler(payload as never, ctx as never);
	}
}

describe("registerUsageFooter 落账钩子", () => {
	it("session_start→两轮 turn_end(一有一无 usage)→session_shutdown 恰落一行,字段如实", async () => {
		const home = tempDir();
		const captured = capturePi();
		registerUsageFooter(captured.pi, {
			onShutdown: (state, sessionStartIso) => {
				appendLedgerRow(home, buildLedgerRow(state, "主控", sessionStartIso));
			},
		});
		await fire(captured, "session_start", {});
		await fire(captured, "turn_end", {
			message: { role: "assistant", usage: { input: 100, output: 50, cost: { total: 0.01 } } },
		});
		await fire(captured, "turn_end", { message: { role: "assistant" } });
		await fire(captured, "session_shutdown", {});
		const parsed = parseLedger(readLedgerText(home));
		expect(parsed.rows).toHaveLength(1);
		const r = parsed.rows[0];
		expect(r.角色).toBe("主控");
		expect(r.turns).toBe(2);
		expect(r.input).toBe(100);
		expect(r.output).toBe(50);
		expect(r.cost).toBeCloseTo(0.01);
		expect(r.缺用量轮次).toBe(1);
		expect(r.会话开始).toBeTruthy();
		expect(r.会话结束).toBeTruthy();
	});

	it("session_start 重置后落新账（新会话新账本）", async () => {
		const home = tempDir();
		const captured = capturePi();
		registerUsageFooter(captured.pi, {
			onShutdown: (state, sessionStartIso) => appendLedgerRow(home, buildLedgerRow(state, "主控", sessionStartIso)),
		});
		await fire(captured, "session_start", {});
		await fire(captured, "turn_end", { message: { role: "assistant", usage: { input: 999 } } });
		await fire(captured, "session_shutdown", {});
		await fire(captured, "session_start", {});
		await fire(captured, "turn_end", { message: { role: "assistant", usage: { input: 1 } } });
		await fire(captured, "session_shutdown", {});
		const rows = parseLedger(readLedgerText(home)).rows;
		expect(rows).toHaveLength(2);
		expect(rows[0].input).toBe(999);
		expect(rows[1].input).toBe(1);
	});

	it("不传钩子＝零行为回归:shutdown 不产生文件", async () => {
		const home = tempDir();
		const captured = capturePi();
		registerUsageFooter(captured.pi);
		await fire(captured, "session_start", {});
		await fire(captured, "turn_end", { message: { role: "assistant", usage: { input: 1 } } });
		await fire(captured, "session_shutdown", {});
		expect(existsSync(usageLedgerPath(home))).toBe(false);
	});

	it("absorbTurnUsage 口径回归:非 assistant 轮不进账", () => {
		const state = createUsageFooterState();
		expect(absorbTurnUsage(state, { role: "user" })).toBe("跳过");
		expect(absorbTurnUsage(state, undefined)).toBe("跳过");
		expect(state.累计.turns).toBe(0);
	});
});

// ============================================================================
// /状态 用量区渲染
// ============================================================================

describe("/状态 用量区", () => {
	it("有账:渲染跨会话聚合正文", async () => {
		const home = tempDir();
		appendLedgerRow(home, row({ turns: 10, cost: 0.05 }));
		appendLedgerRow(home, row({ 角色: "worker", turns: 3, cost: 0.01, 缺用量轮次: 1 }));
		const page = await renderStatusPage(home);
		expect(page).toContain("用量区");
		expect(page).toContain("会话 2（主控 1 · worker 1）");
		expect(page).toContain("1 会话未回 usage");
	});

	it("空态:尚无跨会话账如实标注,不冒充零用量", async () => {
		const page = await renderStatusPage(tempDir());
		expect(page).toContain("尚无跨会话账");
		// 未做区不再列用量
		expect(page).toContain("后台/值守区");
		expect(page).not.toContain("用量=§15");
	});

	it("账本读失败＝该区错误行,不拖垮任务/部门区", async () => {
		// 把 用量账.jsonl 路径本身占用成目录 → readFileSync EISDIR(两平台一致;Windows 上
		// 文件\\子路径 是 ENOENT,会被 readLedgerText 的不存在分支吞成空态,造不出失败)
		const home = tempDir();
		mkdirSync(usageLedgerPath(home));
		const page = await renderStatusPage(home);
		expect(page).toContain("用量区读取失败");
		expect(page).toContain("任务区");
	});
});
