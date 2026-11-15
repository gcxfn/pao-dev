import { describe, expect, it } from "vitest";

import { absorbMinisterEvent, createMinisterEventState } from "../../src/pao/host/events.ts";

it.each(["error", "aborted"])("%s 零用量终态明确未知，HTTP前取消不计请求", (stopReason) => {
	const state = createMinisterEventState();
	const message = {
		role: "assistant",
		stopReason,
		content: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
	};
	absorbMinisterEvent(state, JSON.stringify({ type: "message_end", message }));
	expect(state.缺用量轮次).toBe(1);
	expect(state.轮次).toBe(1);
	absorbMinisterEvent(
		state,
		JSON.stringify({
			type: "message_end",
			message: { ...message, stopReason: "aborted", errorMessage: "Operation aborted before provider request" },
		}),
	);
	expect(state.轮次).toBe(1);
	expect(state.缺用量轮次).toBe(1);
});

/**
 * 部长会话事件流解析·真实 RPC 线型钉子(审查教训:测试线型与生产线型漂移):
 * 线型形状以 pi-agent-core agent-loop(流式子事件 text 系/toolcall 系)与
 * pi-ai AssistantMessageEvent/Usage 为准——一轮的权威终点是顶层 message_end 事件
 * (自带最终 assistant 消息与其 usage,cost 线上是 {total} 对象),
 * assistantMessageEvent 里不存在 "message_end"/"done" 终态子事件。
 */

/** 一轮真实线型:流式子事件(可含 toolcall_start)＋顶层 message_end 终点 */
function realRound(overrides: {
	文本?: string;
	toolName?: string;
	usage?: Record<string, unknown>;
	无usage?: boolean;
}): string[] {
	const streamingUsage = {
		input: 10,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 12,
		cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.02 },
	};
	const lines: string[] = [
		JSON.stringify({
			type: "message_update",
			usage: streamingUsage,
			assistantMessageEvent: { type: "text_start", contentIndex: 0 },
		}),
	];
	if (overrides.toolName) {
		lines.push(
			JSON.stringify({
				type: "message_update",
				usage: streamingUsage,
				assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: "t1", toolName: overrides.toolName },
			}),
		);
	}
	lines.push(
		JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: overrides.文本 ?? "第一轮输出" }],
				stopReason: overrides.toolName ? "toolUse" : "stop",
				...(overrides.无usage ? {} : { usage: overrides.usage ?? streamingUsage }),
			},
		}),
	);
	return lines;
}

describe("absorbMinisterEvent 真实 RPC 线型", () => {
	it("顶层 message_end 计轮:轮次/用量(cost {total} 归一)/最终输出/轮完成含用量", () => {
		const state = createMinisterEventState();
		let lastRoundBoundary = false;
		let lastRoundHasUsage: boolean | undefined;
		for (const line of realRound({ toolName: "read" })) {
			const r = absorbMinisterEvent(state, line);
			if (r.轮完成) {
				lastRoundBoundary = r.边界;
				lastRoundHasUsage = r.轮完成.含用量;
			}
		}
		expect(state.轮次).toBe(1);
		expect(state.工具调用次数).toBe(1);
		expect(state.用量.turns).toBe(1);
		expect(state.用量.cost).toBeCloseTo(0.02, 6);
		expect(state.用量.input).toBe(10);
		expect(state.最终输出).toBe("第一轮输出");
		expect(state.缺用量轮次).toBe(0);
		expect(lastRoundBoundary).toBe(true);
		expect(lastRoundHasUsage).toBe(true);
	});

	it("接口未回 usage 的轮:记缺账不填零(R07),轮完成标含用量=false", () => {
		const state = createMinisterEventState();
		let lastTime = absorbMinisterEvent(state, "x");
		for (const line of realRound({ 无usage: true, 文本: "缺账轮" })) lastTime = absorbMinisterEvent(state, line);
		expect(state.轮次).toBe(1);
		expect(state.缺用量轮次).toBe(1);
		expect(state.用量.turns).toBe(0);
		expect(state.用量.cost).toBe(0);
		expect(state.最终输出).toBe("缺账轮");
		expect(lastTime.轮完成?.含用量).toBe(false);
	});

	it("非 assistant 的顶层 message_end(user/toolResult)不计轮不计数", () => {
		const state = createMinisterEventState();
		expect(
			absorbMinisterEvent(state, JSON.stringify({ type: "message_end", message: { role: "user", content: [] } }))
				.边界,
		).toBe(false);
		expect(
			absorbMinisterEvent(
				state,
				JSON.stringify({ type: "message_end", message: { role: "toolResult", content: [] } }),
			).边界,
		).toBe(false);
		expect(absorbMinisterEvent(state, JSON.stringify({ type: "message_end" })).边界).toBe(false);
		expect(state.轮次).toBe(0);
		expect(state.工具调用次数).toBe(0);
	});

	it("反漂移钉:assistantMessageEvent 子事件无终态(message_end/done 子事件形状不计轮)——真实线型终点只在顶层", () => {
		const state = createMinisterEventState();
		absorbMinisterEvent(
			state,
			JSON.stringify({
				type: "message_update",
				usage: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0, cost: { total: 9 } },
				assistantMessageEvent: { type: "message_end", message: { role: "assistant" } },
			}),
		);
		absorbMinisterEvent(
			state,
			JSON.stringify({
				type: "message_update",
				usage: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0, cost: { total: 9 } },
				assistantMessageEvent: { type: "done", reason: "stop", message: { role: "assistant" } },
			}),
		);
		expect(state.轮次).toBe(0);
		expect(state.用量.cost).toBe(0);
	});

	it("生命周期线型:agent_start/agent_settled 维护运行中,response 握手取会话标识;坏行忽略不炸", () => {
		const state = createMinisterEventState();
		expect(absorbMinisterEvent(state, "不是 JSON").可解析).toBe(false);
		expect(absorbMinisterEvent(state, "").可解析).toBe(false);
		absorbMinisterEvent(state, JSON.stringify({ type: "agent_start" }));
		expect(state.运行中).toBe(true);
		absorbMinisterEvent(state, JSON.stringify({ type: "agent_settled" }));
		expect(state.运行中).toBe(false);
		absorbMinisterEvent(state, JSON.stringify({ type: "response", data: { sessionId: "sess-1" } }));
		expect(state.会话标识).toBe("sess-1");
	});
});
