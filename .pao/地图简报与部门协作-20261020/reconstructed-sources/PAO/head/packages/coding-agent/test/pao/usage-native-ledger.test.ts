import type { AssistantMessage, Usage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import * as output from "../../src/core/output-guard.ts";
import { type SessionEntry, SessionManager } from "../../src/core/session-manager.ts";
import { absorbMinisterEvent, createMinisterEventState } from "../../src/pao/host/events.ts";
import { usageStreamComplete } from "../../src/pao/worker/native-usage.ts";
import { absorbEvent, createEventState } from "../../src/pao/worker/receipt.ts";
import {
	notifySessionUsageChanged,
	registerUsageFooter,
	sessionUsageState,
} from "../../src/pao/worker/usage-display.ts";

const usage = (cost: number): Usage => ({
	input: 10,
	output: 2,
	cacheRead: 3,
	cacheWrite: 4,
	totalTokens: 19,
	cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});
const assistant = (cost: number): AssistantMessage => ({
	role: "assistant",
	provider: "fake",
	model: "offline",
	api: "openai-completions",
	content: [],
	usage: usage(cost),
	stopReason: "stop",
	timestamp: 0,
});
function fixture(manager = SessionManager.inMemory(), mode = "interactive") {
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const status = vi.fn();
	const shutdown = vi.fn();
	const unbind = registerUsageFooter(
		{
			appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data),
			on: (name: string, handler: (event: any, ctx: any) => unknown) => {
				handlers.set(name, handler);
				return () => handlers.delete(name);
			},
		} as unknown as ExtensionAPI,
		{ onShutdown: shutdown },
	);
	const ctx = { sessionManager: manager, mode, ui: { setStatus: status } };
	const fire = (name: string, event = {}) => handlers.get(name)?.(event, ctx);
	fire("session_start");
	return { manager, status, shutdown, fire, unbind, ctx };
}

describe("唯一用量行使用原生完整账本（离线）", () => {
	it("原生压缩失败时不把账目缺失当零费用", () => {
		const test = fixture();
		test.fire("session_compact_failed", { fromExtension: false });
		expect(sessionUsageState(test.manager.getEntries()).缺用量轮次).toBe(1);
		test.unbind();
	});
	it.each(["json", "rpc"])("%s 原生辅助账目输出到worker与host：全项计费、重复及旧会话不双计", (mode) => {
		const lines: string[] = [];
		const write = vi.spyOn(output, "writeRawStdout").mockImplementation((line) => {
			lines.push(line);
		});
		try {
			const test = fixture(SessionManager.inMemory(), mode);
			const manager = test.manager;
			manager.appendMessage(assistant(0.5));
			manager.appendMessage({
				role: "toolResult",
				toolCallId: "tool1",
				toolName: "fake",
				content: [],
				isError: false,
				timestamp: 0,
				usage: usage(0.375),
			});
			manager.appendCompaction("不能进入费用事件的摘要", null, 100, undefined, false, usage(0.125));
			manager.branchWithSummary(null, "分支内容不能外发给上级账目", undefined, false, usage(0.25));
			manager.appendUsage("precompaction", "fake", "offline", usage(0.4));
			test.fire("turn_end", { message: assistant(0.5) });
			test.fire("agent_end");
			test.fire("session_shutdown");
			expect(lines).toHaveLength(5);
			expect(lines.join("")).not.toContain("不能");
			const worker = createEventState();
			const host = createMinisterEventState();
			const assistantLine = JSON.stringify({ type: "message_end", message: assistant(0.5) });
			absorbEvent(worker, assistantLine);
			absorbMinisterEvent(host, assistantLine);
			for (const line of [...lines, ...lines]) {
				absorbEvent(worker, line);
				absorbMinisterEvent(host, line);
			}
			const stale = JSON.stringify({ ...JSON.parse(lines[0]), sessionId: "other", entryId: "fresh" });
			absorbEvent(worker, stale);
			absorbMinisterEvent(host, stale);
			expect(worker.用量.cost).toBeCloseTo(1.65);
			expect(host.用量.cost).toBeCloseTo(1.65);
			expect(worker.用量.turns).toBe(1);
			expect(host.轮次).toBe(1);
			expect(worker.缺用量轮次).toBe(0);
			expect(host.缺用量轮次).toBe(0);
			expect(usageStreamComplete(worker)).toBe(true);
		} finally {
			write.mockRestore();
		}
	});
	it("部分用量或硬杀缺账保留已知费用，但不能伪装完整", () => {
		const state = createEventState();
		absorbEvent(
			state,
			JSON.stringify({
				type: "pao_usage_entry",
				sessionId: "s",
				entryId: "e",
				usage: { input: 1, cost: 0.3 },
				unknown: true,
			}),
		);
		expect(state.用量.cost).toBe(0.3);
		expect(state.缺用量轮次).toBe(1);
		absorbEvent(state, JSON.stringify({ type: "pao_usage_incomplete" }));
		expect(state.缺用量轮次).toBe(2);
		expect(usageStreamComplete(state)).toBe(false);
	});
	it("上游五类来源全部相加，包含丢弃预压缩费用，工具与摘要不冒充助手轮数", () => {
		const entries = [
			{ type: "message", message: assistant(0.5) },
			{ type: "message", message: { role: "toolResult", usage: usage(0.375) } },
			{ type: "branch_summary", usage: usage(0.25) },
			{ type: "compaction", usage: usage(0.125) },
			{ type: "usage", kind: "precompaction", usage: usage(0.4) },
		] as SessionEntry[];
		const state = sessionUsageState(entries);
		expect(state.累计.cost).toBeCloseTo(1.65);
		expect(state.累计.input).toBe(50);
		expect(state.累计.turns).toBe(1);
	});
	it("恢复历史显示全部，但退出只落新增消费；重复事件不双计", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(assistant(10));
		const test = fixture(manager);
		expect(test.status.mock.calls.at(-1)?.[1]).toContain("$10.00");
		manager.appendMessage(assistant(0.5));
		test.fire("turn_end", { message: assistant(0.5) });
		manager.appendCompaction("摘要", null, 100, undefined, false, usage(0.125));
		test.fire("session_compact");
		manager.appendUsage("precompaction", "fake", "offline", usage(0.375), "已丢弃摘要");
		notifySessionUsageChanged(manager);
		test.fire("agent_end");
		test.fire("agent_end");
		expect(test.status.mock.calls.at(-1)?.[1]).toContain("累计 ↑40 ↓8 · $11.00 · 2 轮");
		test.fire("session_shutdown");
		test.fire("session_shutdown");
		expect(test.shutdown).toHaveBeenCalledTimes(1);
		expect(test.shutdown.mock.calls[0][0].累计.cost).toBe(1);
		expect(test.shutdown.mock.calls[0][0].累计.turns).toBe(1);
	});
	it("恢复但没有新增消费的退出不把历史重新记账", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(assistant(12));
		const test = fixture(manager);
		test.fire("session_shutdown");
		expect(test.shutdown.mock.calls[0][0].累计.cost).toBe(0);
	});
	it("后台未知费用明确标为下界，切会话不串显示，旧会话新增仍入本次退出账", () => {
		const test = fixture();
		const old = test.manager;
		old.appendMessage(assistant(1));
		test.fire("turn_end", { message: assistant(1) });
		test.fire("session_before_switch");
		const next = SessionManager.inMemory();
		test.ctx.sessionManager = next;
		test.fire("session_start");
		const count = test.status.mock.calls.length;
		old.appendUsage("precompaction", "fake", "offline", usage(2));
		notifySessionUsageChanged(old);
		expect(test.status).toHaveBeenCalledTimes(count);
		next.appendCustomEntry("pao-precompaction-usage-status", { status: "请求未返回用量" });
		notifySessionUsageChanged(next);
		expect(test.status.mock.calls.at(-1)?.[1]).toContain("已知下界");
		test.fire("session_shutdown");
		expect(test.shutdown.mock.calls.map((call) => call[0].累计.cost)).toEqual([3, 0]);
		expect(test.shutdown.mock.calls[1][0].缺用量轮次).toBe(1);
	});
	it("没有事件时不扫描账本，解绑后后台通知不再刷新", () => {
		const test = fixture();
		const read = vi.spyOn(test.manager, "getEntries");
		expect(read).not.toHaveBeenCalled();
		test.unbind();
		notifySessionUsageChanged(test.manager);
		expect(read).not.toHaveBeenCalled();
	});
});
