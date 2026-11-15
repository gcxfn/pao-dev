import type { Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/core/agent-session.ts";
import { type CompactionPreparation, prepareCompaction } from "../../src/core/compaction/index.ts";
import { abortPrecompaction, installPrecompactionAdapter } from "../../src/core/compaction/precompaction.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { registerPrecompaction } from "../../src/pao/context/precompaction.ts";

function fixture(enabled = true) {
	const handlers = new Map<string, (event: any, context: any) => any>();
	registerPrecompaction({
		on: (name: string, handler: (event: any, context: any) => any) => handlers.set(name, handler),
	} as unknown as ExtensionAPI);
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "旧约束".repeat(1000), timestamp: 0 });
	manager.appendCustomMessageEntry("pao-firstrun", "其他项目内部信息", true);
	manager.appendMessage({ role: "user", content: "保留最新约束".repeat(100), timestamp: 1 });
	const model = { provider: "fake", id: "test", contextWindow: 1000 } as Model<string>;
	const settings = { enabled: true, reserveTokens: 100, keepRecentTokens: 100 };
	const generate = vi.fn(async (preparation: CompactionPreparation, _model: Model<string>, _signal: AbortSignal) => ({
		summary: "离线摘要",
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
	}));
	const status = vi.fn();
	const controller = new AbortController();
	installPrecompactionAdapter(manager, {
		enabled,
		settings: () => settings,
		physicalModel: () => model,
		generate,
		recordStatus: status,
	});
	const context = { model, thinkingLevel: "off", sessionManager: manager, signal: controller.signal };
	const turn = {
		message: { role: "assistant", provider: "fake", model: "test", stopReason: "stop", usage: { totalTokens: 800 } },
	};
	const emit = (name: string, event: any = {}) => handlers.get(name)?.(event, context);
	const compact = (reason = "threshold") =>
		emit("session_before_compact", {
			reason,
			preparation: prepareCompaction(manager.getBranch(), settings),
			branchEntries: manager.getBranch(),
			signal: controller.signal,
		});
	return { emit, compact, manager, turn, generate, status, controller, context };
}

describe("预压缩正式扩展事件接线（离线）", () => {
	it("从未触发后台摘要时可关闭并重复关闭，不访问不存在的绑定", async () => {
		const test = fixture(false);
		await expect(test.emit("session_shutdown")).resolves.toBeUndefined();
		await expect(test.emit("session_shutdown")).resolves.toBeUndefined();
		expect(test.generate).not.toHaveBeenCalled();
		expect(test.status).not.toHaveBeenCalled();
	});
	it("reload超时后解绑旧取消函数，失效ctx不再被访问，费用未知保留", async () => {
		vi.useFakeTimers();
		try {
			const test = fixture();
			test.generate.mockImplementationOnce(() => new Promise(() => {}));
			test.emit("turn_end", test.turn);
			await Promise.resolve();
			const shutdown = test.emit("session_shutdown");
			await vi.advanceTimersByTimeAsync(5000);
			await shutdown;
			expect(test.status).toHaveBeenCalledWith(test.manager.getSessionId(), "取消等待超时，费用未知");
			Object.defineProperty(test.context, "sessionManager", {
				get() {
					throw new Error("ctx stale after reload");
				},
			});
			await expect(abortPrecompaction(test.manager)).resolves.toBeUndefined();
			expect(vi.getTimerCount()).toBe(0);
			expect(test.status).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
	it("前台已空闲时正式 session.abort 仍取消后台且等结算，不影响其他会话", async () => {
		const test = fixture();
		const other = fixture();
		let release!: () => void;
		let signal: AbortSignal | undefined;
		test.generate.mockImplementationOnce(async (preparation, _model, value) => {
			signal = value;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { summary: "取消后的迟到摘要", firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: 1 };
		});
		test.emit("turn_end", test.turn);
		other.emit("turn_end", other.turn);
		await Promise.resolve();
		let settled = false;
		// 无活动run的agent.abort是空操作，复现真实失败入口；调用实际AgentSession方法。
		const abort = AgentSession.prototype.abort
			.call({
				sessionManager: test.manager,
				agent: { abort: () => {} },
				abortRetry: () => {},
				abortCompaction: () => {},
				abortBranchSummary: () => {},
				waitForIdle: async () => {},
			} as unknown as AgentSession)
			.then(() => {
				settled = true;
			});
		expect(signal?.aborted).toBe(true);
		await Promise.resolve();
		expect(settled).toBe(false);
		release();
		await abort;
		expect(test.compact()).toBeUndefined();
		expect(test.status.mock.calls.some((call) => call[1] === "就绪")).toBe(false);
		await vi.waitFor(() => expect(other.status).toHaveBeenCalled());
		expect(other.compact()?.compaction.summary).toBe("离线摘要");
	});
	it("一次摘要只能留下一条已应用；随后无候选压缩不重复写历史状态", async () => {
		const test = fixture();
		expect(test.compact()).toBeUndefined();
		expect(test.status).not.toHaveBeenCalled();
		test.emit("turn_end", test.turn);
		await vi.waitFor(() => expect(test.status).toHaveBeenCalledWith(test.manager.getSessionId(), "就绪", undefined));
		expect(test.compact()?.compaction.summary).toBe("离线摘要");
		expect(test.status.mock.calls.map((call) => call[1])).toEqual(["就绪", "已应用"]);
		expect(test.compact()).toBeUndefined();
		expect(test.compact()).toBeUndefined();
		expect(test.status.mock.calls.map((call) => call[1])).toEqual(["就绪", "已应用"]);
	});
	it("不兼容候选仍记录本次丢弃，后续无候选不重复登记", async () => {
		const test = fixture();
		test.emit("turn_end", test.turn);
		await vi.waitFor(() => expect(test.status).toHaveBeenCalled());
		test.manager.appendModelChange("fake", "other");
		expect(test.compact()).toBeUndefined();
		expect(test.status.mock.calls.map((call) => call[1])).toEqual(["就绪", "已丢弃"]);
		expect(test.compact()).toBeUndefined();
		expect(test.status.mock.calls.map((call) => call[1])).toEqual(["就绪", "已丢弃"]);
	});
	it("供应商忽略取消时最多等待五秒，明确记录费用未知后放行退出", async () => {
		vi.useFakeTimers();
		try {
			const test = fixture();
			test.generate.mockImplementationOnce(() => new Promise(() => {}));
			test.emit("turn_end", test.turn);
			await Promise.resolve();
			const shutdown = test.emit("session_shutdown");
			await vi.advanceTimersByTimeAsync(5000);
			await shutdown;
			expect(test.status).toHaveBeenCalledWith(test.manager.getSessionId(), "取消等待超时，费用未知");
		} finally {
			vi.useRealTimers();
		}
	});
	it("退出先取消并等待在途费用返回，再允许后续结账钩子运行", async () => {
		const test = fixture();
		let release!: () => void;
		let signal: AbortSignal | undefined;
		test.generate.mockImplementationOnce(async (preparation, _model, value) => {
			signal = value;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return {
				summary: "迟到摘要",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
			};
		});
		test.emit("turn_end", test.turn);
		await Promise.resolve();
		let settled = false;
		const shutdown = Promise.resolve(test.emit("session_shutdown")).then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(signal?.aborted).toBe(true);
		expect(settled).toBe(false);
		release();
		await shutdown;
		expect(settled).toBe(true);
		expect(test.compact()).toBeUndefined();
	});
	it("默认禁用不生成；启用后摘要源过滤首跑面板，并保留新消息到实际压缩", async () => {
		const disabled = fixture(false);
		disabled.emit("turn_end", disabled.turn);
		await Promise.resolve();
		expect(disabled.generate).not.toHaveBeenCalled();
		const test = fixture();
		test.emit("turn_end", test.turn);
		await vi.waitFor(() => expect(test.status).toHaveBeenCalled());
		expect(JSON.stringify(test.generate.mock.calls[0])).not.toContain("其他项目内部信息");
		const newId = test.manager.appendMessage({ role: "user", content: "期间新纠正", timestamp: 2 });
		const result = test.compact();
		expect(result.compaction.summary).toBe("离线摘要");
		expect(test.manager.getBranch().at(-1)?.id).toBe(newId);
	});
	it.each([
		"session_before_switch",
		"session_before_tree",
		"session_tree",
		"session_shutdown",
		"model_select",
		"thinking_level_select",
	])("%s 使就绪摘要失效", async (event) => {
		const test = fixture();
		test.emit("turn_end", test.turn);
		await vi.waitFor(() => expect(test.status).toHaveBeenCalled());
		test.emit(event);
		expect(test.compact()).toBeUndefined();
	});
	it("手动压缩保持原路径；取消信号使后台结果失效", async () => {
		const test = fixture();
		test.emit("turn_end", test.turn);
		await vi.waitFor(() => expect(test.status).toHaveBeenCalled());
		expect(test.compact("manual")).toBeUndefined();
		const aborted = fixture();
		aborted.emit("turn_end", aborted.turn);
		aborted.controller.abort();
		await Promise.resolve();
		expect(aborted.compact()).toBeUndefined();
	});
});
