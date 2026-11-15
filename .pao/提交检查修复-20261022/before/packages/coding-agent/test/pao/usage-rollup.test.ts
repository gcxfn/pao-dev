import { describe, expect, it } from "vitest";

import { absorbEvent, createEventState } from "../../src/pao/worker/receipt.ts";
import type { UsageLine } from "../../src/pao/worker/usage.ts";
import { budgetGate, totalsUsage, usageLineFromEventState } from "../../src/pao/worker/usage.ts";

/**
 * 用量对账夹具（M1-06 交付 / G1-11 / R07 计量口径）：
 * - worker 用量只从运行事件与接口返回取（message_end usage），不让 worker 凭空自报；
 * - 接口未回 usage 的轮次记「未知」，不当零；
 * - 父卡总额 = 子项汇总，不把已含子卡的总额再相加（不双计）；
 * - 预算耗尽不开新请求。
 */

function event(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "干活中" }],
			stopReason: "end",
			...overrides,
		},
	});
}

function line(cardNo: string, usage: Partial<UsageLine["用量"]>, source: UsageLine["来源"] = "事件流"): UsageLine {
	return {
		卡号: cardNo,
		用量: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, ...usage },
		来源: source,
	};
}

describe("来源可复算:worker 用量从事件流取,不采信自报", () => {
	it("子卡用量从 message_end usage 逐轮复算,与接口返回一致", () => {
		const state = createEventState();
		absorbEvent(state, event({ usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 2, cost: 0.5 } }));
		absorbEvent(state, event({ usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.2 } }));
		const line1 = usageLineFromEventState("0001", 1, state);
		expect(line1.来源).toBe("事件流");
		// 可复算:逐轮相加,不靠 worker 自报
		expect(line1.用量).toEqual({ input: 150, output: 30, cacheRead: 5, cacheWrite: 2, cost: 0.7, turns: 2 });
	});

	it("模型正文自报的账目不进对账:只有 usage 字段算数", () => {
		const state = createEventState();
		absorbEvent(
			state,
			event({
				content: [{ type: "text", text: "我只用了 1 个 token,成本 0 元,信我。" }],
				usage: { input: 88, output: 6, cost: 0.09 },
			}),
		);
		expect(usageLineFromEventState("0002", 1, state).用量).toMatchObject({ input: 88, output: 6, cost: 0.09 });
	});

	it("接口未回 usage 的轮次记「未知」,不当零(R07)", () => {
		const state = createEventState();
		absorbEvent(state, event({ usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.05 } }));
		absorbEvent(state, event()); // 这轮接口没回 usage
		const line1 = usageLineFromEventState("0003", 1, state);
		expect(line1.来源).toBe("未知");
		expect(line1.说明).toContain("1项用量不完整");
		// 已知部分仍是下界,但来源标未知——下游对账/预算不得把 cost=0.05 当全量
		expect(line1.用量.cost).toBe(0.05);
	});

	it("整轮都没回 usage:来源未知,零值不冒充真实零", () => {
		const state = createEventState();
		absorbEvent(state, event());
		absorbEvent(state, event());
		const line1 = usageLineFromEventState("0004", 1, state);
		expect(line1.来源).toBe("未知");
		expect(line1.用量).toMatchObject({ cost: 0, turns: 2 }); // 结构上是零,来源上标未知
	});
});

describe("父子汇总:不双计,未知上浮", () => {
	it("父卡总额 = 子项逐行相加(含父卡自有轮次),不重复计入已含子卡的总额", () => {
		const child1 = line("0001", { input: 100, output: 20, cost: 0.5, turns: 3 });
		const child2 = line("0002", { input: 60, output: 10, cost: 0.3, turns: 2 });
		const parentOwn = line("0003", { input: 30, output: 5, cost: 0.1, turns: 1 });
		const parent = totalsUsage("0003", [parentOwn, child1, child2]);
		expect(parent.来源).toBe("汇总");
		expect(parent.用量.input).toBe(190);
		expect(parent.用量.output).toBe(35);
		expect(parent.用量.cacheRead).toBe(0);
		expect(parent.用量.cacheWrite).toBe(0);
		expect(parent.用量.cost).toBeCloseTo(0.9, 10);
		expect(parent.用量.turns).toBe(6);
	});

	it("汇总行再进汇总通道被结构化拒绝:不把已含子卡的总额再相加", () => {
		const child = line("0001", { input: 100, cost: 0.5, turns: 1 });
		const parent = totalsUsage("父", [child]);
		expect(() => totalsUsage("爷", [parent as unknown as UsageLine])).toThrow(/汇总行不得再进汇总/);
		expect(() => totalsUsage("爷", [parent as unknown as UsageLine])).toThrow(/不把已含子卡的总额再相加/);
	});

	it("子项未知上浮:父总额标含未知,对账时如实说明", () => {
		const known = line("0001", { input: 10, cost: 0.02, turns: 1 });
		const unknownChild = usageLineFromEventState(
			"0002",
			1,
			(() => {
				const s = createEventState();
				absorbEvent(s, event()); // 未回 usage
				return s;
			})(),
		);
		expect(unknownChild.来源).toBe("未知");
		const parent = totalsUsage("父", [known, unknownChild]);
		expect(parent.含未知).toBe(true);
		expect(parent.说明).toContain("1 个子项来源未知");
	});

	it("全已知子项:父总额不含未知标记", () => {
		const parent = totalsUsage("父", [line("0001", { cost: 0.1, turns: 1 }), line("0002", { cost: 0.2, turns: 2 })]);
		expect(parent.含未知).toBe(false);
	});
});

describe("预算门禁:耗尽不开新请求", () => {
	it("cost/turns 任一达到限额即耗尽,不开新请求", () => {
		const used = totalsUsage("父", [line("0001", { cost: 0.5, turns: 4 }), line("0002", { cost: 0.5, turns: 1 })]);
		expect(budgetGate(used, { cost: 1.0 })).toMatchObject({ 允许新请求: false, 超限: ["cost"] });
		expect(budgetGate(used, { turns: 5 })).toMatchObject({ 允许新请求: false, 超限: ["turns"] });
		expect(budgetGate(used, { cost: 1.01, turns: 6 })).toMatchObject({
			允许新请求: true,
			超限: [],
		});
	});

	it("用量未知时无法证明未超限:按超限处理,不当零放行(R07)", () => {
		const unknown = line("0001", { cost: 0, turns: 2 }, "未知");
		// 有限额且用量未知 → 挡(不把未知当零,也不当无穷)
		expect(budgetGate(unknown, { cost: 10 })).toMatchObject({ 允许新请求: false, 超限: ["cost"] });
		expect(budgetGate(unknown, { turns: 100 })).toMatchObject({ 允许新请求: true, 超限: [] }); // 轮次数来自事件，费用缺账不会抹掉计数
		// 无任何限额:无从超限,放行
		expect(budgetGate(unknown, {})).toMatchObject({ 允许新请求: true, 超限: [] });
	});

	it("父汇总含未知子项:预算门禁同样按未知处理", () => {
		const parent = totalsUsage("父", [
			line("0001", { cost: 0.1, turns: 1 }),
			line("0002", { cost: 0, turns: 1 }, "未知"),
		]);
		expect(parent.含未知).toBe(true);
		expect(budgetGate(parent, { cost: 100 }).允许新请求).toBe(false);
	});

	it("未设预算:放行(门禁只在有承诺处设卡)", () => {
		expect(budgetGate(line("0001", { cost: 999, turns: 999 }), {})).toMatchObject({ 允许新请求: true });
	});
});
