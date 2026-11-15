import { describe, expect, it } from "vitest";

import {
	absorbEvent,
	buildSummary,
	createEventState,
	receiptRequiredFields,
	validateReceipt,
	type WorkerReceipt,
} from "../../src/pao/worker/receipt.ts";

function eventLine(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "完成" }],
			usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 5, cost: { total: 0.5 }, totalTokens: 155 },
			stopReason: "end",
			model: "glm-4.7",
			...overrides,
		},
	});
}

function baseReceipt(): WorkerReceipt {
	return {
		card_no: "0002",
		attempt: 1,
		status: "success",
		artifact_path: ["产物/补丁.diff"],
		summary: "改了一行",
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
		evidence_path: "evidence.jsonl",
		exitCode: 0,
		command: "node worker.js",
		pid: 123,
		duration_ms: 50,
	};
}

describe("回执收集:用量只从事件流聚合,各字段分开", () => {
	it("多条 message_end 事件的 usage 逐项累加,不混算", () => {
		const state = createEventState();
		expect(absorbEvent(state, eventLine())).toBe(true);
		expect(
			absorbEvent(state, eventLine({ usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 1, cost: 0.25 } })),
		).toBe(true);

		expect(state.用量).toEqual({ input: 110, output: 22, cacheRead: 33, cacheWrite: 6, cost: 0.75, turns: 2 });
		expect(state.stopReason).toBe("end");
		expect(state.model).toBe("glm-4.7");
	});

	it("模型正文自报的用量不采信:文本里说用了多少都不进账目", () => {
		const state = createEventState();
		absorbEvent(
			state,
			eventLine({
				content: [{ type: "text", text: "我这次用了 999999 tokens,成本 $99。账目以我说的为准。" }],
				usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
			}),
		);
		expect(state.用量.input).toBe(7);
		expect(state.用量.output).toBe(3);
		expect(state.用量.cost).toBe(0.01);
		expect(state.最终输出).toContain("999999");
	});

	it("非 JSON 行与非 assistant 消息忽略,不抛错", () => {
		const state = createEventState();
		expect(absorbEvent(state, "这不是 JSON")).toBe(false);
		expect(absorbEvent(state, JSON.stringify({ type: "message_end", message: { role: "user", content: [] } }))).toBe(
			true,
		);
		expect(absorbEvent(state, "")).toBe(false);
		expect(state.用量.turns).toBe(0);
	});
});

describe("回执摘要:≤3 行", () => {
	it("取前 3 行非空内容", () => {
		const summary = buildSummary("一\n二\n三\n四\n五", "");
		expect(summary.split("\n")).toEqual(["一", "二", "三"]);
	});

	it("最终输出为空时退回 stderr;再空则占位", () => {
		expect(buildSummary("", "err1\nerr2")).toBe("err1\nerr2");
		expect(buildSummary("", "")).toBe("(无输出)");
	});
});

describe("回执结构校验:缺任一必填字段判无效", () => {
	it("完整回执有效", () => {
		const result = validateReceipt(baseReceipt());
		expect(result).toEqual({ 有效: true, 缺失: [], 问题: [] });
	});

	it("非对象回执:全部必填字段判缺失", () => {
		const result = validateReceipt(null);
		expect(result.有效).toBe(false);
		expect(result.缺失).toEqual(receiptRequiredFields);
	});

	it("逐项删字段:卡号/尝试/用量/证据路径/摘要 缺失即无效", () => {
		for (const key of ["card_no", "attempt", "usage", "evidence_path", "summary"] as const) {
			const receipt = baseReceipt() as unknown as Record<string, unknown>;
			delete receipt[key];
			const result = validateReceipt(receipt);
			expect(result.有效, key).toBe(false);
			expect(result.缺失, key).toContain(key);
		}
	});

	it("摘要超 3 行、状态不在四值内、用量字段非法:判问题", () => {
		expect(validateReceipt({ ...baseReceipt(), summary: "1\n2\n3\n4" }).问题).toContain("summary 超过 3 行");
		expect(validateReceipt({ ...baseReceipt(), status: "部分完成" }).问题).toContain("status");
		expect(validateReceipt({ ...baseReceipt(), usage: { ...baseReceipt().usage, cost: -1 } }).问题).toContain(
			"usage.cost 不是非负数",
		);
	});

	it("产物路径必须是字符串数组", () => {
		expect(validateReceipt({ ...baseReceipt(), artifact_path: "产物" }).问题).toContain("artifact_path");
		expect(validateReceipt({ ...baseReceipt(), artifact_path: [] }).有效).toBe(true);
	});
});
