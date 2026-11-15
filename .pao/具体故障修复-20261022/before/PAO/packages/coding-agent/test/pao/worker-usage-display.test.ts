import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { absorbEvent, createEventState, type WorkerReceipt } from "../../src/pao/worker/receipt.ts";
import { WorkerRunner } from "../../src/pao/worker/runner.ts";
import {
	absorbTurnUsage,
	aggregateLineToUsageLine,
	batchUsageLine,
	createUsageFooterState,
	deptUsageLine,
	formatCost,
	formatFooterStatus,
	formatTokens,
	formatTurnUsage,
	formatUsageLine,
	receiptUsageLine,
	registerUsageFooter,
	type UsageLine,
	usageStatusKey,
} from "../../src/pao/worker/usage-display.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-usage-display-"));
	tempDirs.push(dir);
	return dir;
}

/** 伪 pi:只实现 on,捕获事件处理器(不碰真实扩展系统/模型) */
function mockPi(): { pi: ExtensionAPI; handler(event: string): ((...args: unknown[]) => unknown) | undefined } {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const pi = {
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
	} as unknown as ExtensionAPI;
	return { pi, handler: (event: string) => handlers.get(event) };
}

function mockCtx(): { ctx: ExtensionContext; calls: [string, string | undefined][] } {
	const calls: [string, string | undefined][] = [];
	const ctx = {
		sessionManager: SessionManager.inMemory(),
		ui: { setStatus: (key: string, text: string | undefined) => calls.push([key, text]) },
	} as unknown as ExtensionContext;
	return { ctx, calls };
}

function turnEndEvent(message: unknown): TurnEndEvent {
	return {
		type: "turn_end",
		turnIndex: 0,
		message,
		toolResults: [],
		messageEntryId: "e1",
		toolResultEntryIds: [],
	} as unknown as TurnEndEvent;
}

function usageLine(cardNo: string, usage: Partial<UsageLine["用量"]>, source: UsageLine["来源"] = "事件流"): UsageLine {
	return {
		卡号: cardNo,
		用量: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, ...usage },
		来源: source,
	};
}

describe("格式化:令牌/成本缩写与本轮状态行(R07 缺项不显示不填零)", () => {
	it("formatTokens:不足千原样,过千 k,过百万 M", () => {
		expect(formatTokens(999)).toBe("999");
		expect(formatTokens(1234)).toBe("1.2k");
		expect(formatTokens(1234567)).toBe("1.2M");
	});

	it("formatCost:一般两位小数;极小非零成本加精度,不虚报为零", () => {
		expect(formatCost(0.03)).toBe("$0.03");
		expect(formatCost(0.0001)).toBe("$0.0001");
		expect(formatCost(0)).toBe("$0.00");
	});

	it("formatTurnUsage:定案样式「本轮 ↑12.3k ↓2.1k 缓存读 98k · $0.03」", () => {
		expect(formatTurnUsage({ input: 12300, output: 2100, cacheRead: 98000, cost: { total: 0.03 } })).toBe(
			"本轮 ↑12.3k ↓2.1k 缓存读 98.0k · $0.03",
		);
	});

	it("formatTurnUsage:某项缺失就不显示该项;全部缺失返回空串(调用方退回未知标注)", () => {
		expect(formatTurnUsage({ input: 500 })).toBe("本轮 ↑500");
		expect(formatTurnUsage({ cost: { total: 0.5 } })).toBe("本轮 $0.50");
		expect(formatTurnUsage({ input: 100, output: 20 })).toBe("本轮 ↑100 ↓20");
		expect(formatTurnUsage({})).toBe("");
	});
});

describe("footer 会话累计:只累加原生 usage,缺账轮标已知下界(R07)", () => {
	it("absorbTurnUsage:assistant 逐项累加;非 assistant 跳过;缺 usage 记缺账轮", () => {
		const state = createUsageFooterState();
		expect(
			absorbTurnUsage(state, { role: "assistant", usage: { input: 1000, output: 200, cost: { total: 0.01 } } }),
		).toBe("计数");
		expect(absorbTurnUsage(state, { role: "user" })).toBe("跳过");
		expect(absorbTurnUsage(state, { role: "assistant" })).toBe("未知轮");
		expect(
			absorbTurnUsage(state, { role: "assistant", usage: { input: 500, output: 100, cost: { total: 0.02 } } }),
		).toBe("计数");
		expect(state.累计).toEqual({ input: 1500, output: 300, cacheRead: 0, cost: 0.03, turns: 3 });
		expect(state.缺用量轮次).toBe(1);
	});

	it("formatFooterStatus:本轮 + 累计一段式;未知轮如实标注;空账不虚构", () => {
		const state = createUsageFooterState();
		absorbTurnUsage(state, {
			role: "assistant",
			usage: { input: 12300, output: 2100, cacheRead: 98000, cost: { total: 0.03 } },
		});
		absorbTurnUsage(state, { role: "assistant" });
		expect(formatFooterStatus(state, { input: 12300, output: 2100, cacheRead: 98000, cost: { total: 0.03 } })).toBe(
			"本轮 ↑12.3k ↓2.1k 缓存读 98.0k · $0.03 ｜ 累计 ↑12.3k ↓2.1k · $0.03 · 2 轮（1项用量不完整，已知下界）",
		);
		// 本轮缺 usage:显示未知标注,不沿用上一轮旧值
		expect(formatFooterStatus(state)).toContain("本轮 usage 未回");
		expect(formatFooterStatus(state)).toContain("1项用量不完整，已知下界");
		// 空账 + 无缺账:不显示累计段
		expect(formatFooterStatus(createUsageFooterState(), { input: 5 })).toBe("本轮 ↑5");
	});
});

describe("registerUsageFooter:turn_end → setStatus,session_start 重置,解绑成对", () => {
	it("assistant 轮写状态行(键=用量),非 assistant 不写,session_start 清账,解绑后不再收事件", () => {
		const { pi, handler } = mockPi();
		const unbind = registerUsageFooter(pi);
		const { ctx, calls } = mockCtx();

		handler("session_start")!({}, ctx);
		calls.length = 0;
		const onTurnEnd = (event: TurnEndEvent, context: ExtensionContext) => {
			if (event.message.role === "assistant") {
				const usage = event.message.usage;
				(context.sessionManager as SessionManager).appendMessage({
					...event.message,
					...(usage
						? {
								usage: {
									...usage,
									input: usage.input ?? 0,
									output: usage.output ?? 0,
									cacheRead: usage.cacheRead ?? 0,
									cacheWrite: usage.cacheWrite ?? 0,
									totalTokens: usage.totalTokens ?? 0,
									cost: Object.assign(
										{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
										usage.cost,
									),
								},
							}
						: {}),
				});
			}
			handler("turn_end")!(event, context);
		};
		onTurnEnd(turnEndEvent({ role: "user" }), ctx);
		expect(calls).toHaveLength(0);

		onTurnEnd(
			turnEndEvent({ role: "assistant", usage: { input: 1000, output: 100, cacheRead: 0, cost: { total: 0.01 } } }),
			ctx,
		);
		expect(calls).toHaveLength(1);
		expect(calls[0][0]).toBe(usageStatusKey);
		expect(calls[0][1]).toBe("本轮 ↑1.0k ↓100 · $0.01 ｜ 累计 ↑1.0k ↓100 · $0.01 · 1 轮");

		// 缺 usage 轮:写未知标注,不虚构
		onTurnEnd(turnEndEvent({ role: "assistant" }), ctx);
		expect(calls[1][1]).toContain("本轮 usage 未回");
		expect(calls[1][1]).toContain("1项用量不完整，已知下界");

		// 新会话:累计清零重开
		(ctx.sessionManager as SessionManager).newSession();
		handler("session_start")!({ type: "session_start" }, ctx);
		expect(calls).toHaveLength(3);
		onTurnEnd(
			turnEndEvent({ role: "assistant", usage: { input: 10, output: 2, cacheRead: 0, cost: { total: 0.001 } } }),
			ctx,
		);
		expect(calls[3][1]).toBe("本轮 ↑10 ↓2 · $0.0010 ｜ 累计 ↑10 ↓2 · $0.0010 · 1 轮");

		unbind();
		expect(handler("turn_end")).toBeUndefined();
		expect(handler("session_start")).toBeUndefined();
	});
});

describe("用量数据供给:回执/批次/部门行,双计结构性拒绝", () => {
	it("回执用量行:回执带缺用量轮次 → 来源未知;缺省 → 来源事件流;同一入口 usageLineFromEventState", () => {
		const base = {
			card_no: "0007",
			attempt: 1,
			usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, cost: 0.5, turns: 2 },
		};
		expect(receiptUsageLine({ ...base }).来源).toBe("事件流");
		const unknown = receiptUsageLine({ ...base, missing_usage_rounds: 1 });
		expect(unknown.来源).toBe("未知");
		expect(unknown.说明).toContain("1项用量不完整");
	});

	it("部门/批次累计行:叶子汇总;子项含未知 → 含未知=true 标已知下界;标签带前缀", () => {
		const lines = [
			usageLine("0001", { input: 100, output: 10, cost: 0.1, turns: 1 }),
			usageLine("0002", { input: 200, output: 20, cost: 0.2, turns: 2 }, "未知"),
		];
		const dept = deptUsageLine("前端部", lines);
		expect(dept.卡号).toBe("部门:前端部");
		expect(dept.用量.input).toBe(300);
		expect(dept.用量.output).toBe(30);
		expect(dept.用量.turns).toBe(3);
		expect(dept.用量.cost).toBeCloseTo(0.3);
		expect(dept.来源).toBe("汇总");
		expect(dept.含未知).toBe(true);
		expect(dept.说明).toContain("1 个子项来源未知");

		const batch = batchUsageLine("B1", [usageLine("0001", { input: 1, turns: 1 })]);
		expect(batch.卡号).toBe("批次:B1");
		expect(batch.含未知).toBe(false);
	});

	it("双计结构性拒绝:汇总行再进部门行、同一(卡号,尝试)重复入账,都直接抛错", () => {
		const totalsLine: UsageLine = { 卡号: "批次:B1", 用量: usageLine("x", { input: 1 }).用量, 来源: "汇总" };
		expect(() => deptUsageLine("前端部", [totalsLine])).toThrow(/汇总行不得再进汇总/);

		const sameReceiptTwice = usageLine("0003", { input: 1, turns: 1 });
		expect(() => deptUsageLine("前端部", [sameReceiptTwice, { ...sameReceiptTwice }])).toThrow(
			/同一\(卡号,尝试\)出现多次/,
		);
		// 同卡不同尝试 = 真实重试花费,不拒
		const attempt1 = { ...usageLine("0003", { input: 1, turns: 1 }), 尝试: 1 };
		const attempt2 = { ...usageLine("0003", { input: 2, turns: 1 }), 尝试: 2 };
		expect(() => batchUsageLine("B1", [attempt1, attempt2])).not.toThrow();
	});

	it("聚合行ToUsageLine:聚合结果转 formatUsageLine 可用的行,含未知说明透传", () => {
		const agg = deptUsageLine("前端部", [usageLine("0001", { input: 100, cost: 0.1, turns: 1 }, "未知")]);
		const row = aggregateLineToUsageLine(agg);
		expect(row.来源).toBe("汇总");
		expect(formatUsageLine(row)).toContain("来源:汇总");
		expect(formatUsageLine(row)).toContain("已知下界");
	});
});

describe("全链路(mock 事件流,不碰真实密钥/模型):事件流 → 回执 → 部门行 → 文本", () => {
	it("事件流聚合与回执口径一致,部门行文本可渲染", () => {
		const state = createEventState();
		absorbEvent(
			state,
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [],
					usage: { input: 100, output: 20, cost: 0.1 },
					stopReason: "end",
				},
			}),
		);
		const line = usageLine("0001", { ...state.用量, turns: state.用量.turns });
		const agg = deptUsageLine("前端部", [line]);
		const text = formatUsageLine(aggregateLineToUsageLine(agg));
		expect(text).toBe("↑100 ↓20 · $0.10 · 1 轮（来源:汇总）");
	});

	it("runner 透传缺用量轮次:未回 usage 的轮按未知记,回执行如实标注(R07 不填零)", async () => {
		const dir = tempDir();
		const script = join(dir, "fake-worker.js");
		writeFileSync(
			script,
			[
				`console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "有账" }], usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.01 }, stopReason: "end" } }));`,
				`console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "缺账" }], stopReason: "end" } }));`,
			].join("\n"),
			"utf8",
		);
		const runner = new WorkerRunner();
		const receipt: WorkerReceipt = await runner.run({
			卡号: "0042",
			提示词: "测试任务",
			命令: process.execPath,
			参数: [script],
			cwd: dir,
		});
		expect(receipt.missing_usage_rounds).toBe(1);
		expect(receipt.usage.turns).toBe(2);
		const row = receiptUsageLine(receipt);
		expect(row.来源).toBe("未知");
		expect(formatUsageLine(row)).toContain("1项用量不完整");
	});
});
