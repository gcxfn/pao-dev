import type { Agent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompactionPreparation } from "../../src/core/compaction/index.ts";
import * as precompactionRegistry from "../../src/core/compaction/precompaction.ts";
import type { ModelRuntime } from "../../src/core/model-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { SettingsManager } from "../../src/core/settings-manager.ts";
import { setupPrecompaction } from "../../src/pao/context/precompaction-adapter.ts";

const model = {
	provider: "offline",
	id: "fake",
	api: "openai-completions",
	reasoning: false,
	contextWindow: 10000,
	maxTokens: 1000,
} as Model<string>;
const preparation = (): CompactionPreparation => ({
	firstKeptEntryId: "keep",
	messagesToSummarize: [{ role: "user", content: "只能改指定目录", timestamp: 0 }],
	turnPrefixMessages: [],
	isSplitTurn: false,
	tokensBefore: 9000,
	previousSummary: undefined,
	fileOps: { read: new Set(), written: new Set(), edited: new Set() },
	settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1000 },
});
const response = (): AssistantMessage => ({
	role: "assistant",
	provider: "offline",
	model: "fake",
	api: "openai-completions",
	content: [{ type: "text", text: "摘要：保留原始约束。" }],
	stopReason: "stop",
	timestamp: 0,
	usage: {
		input: 20,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 30,
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
	},
});

// enabled 无默认值:显式 undefined＝「SDK 未传选项」,要走 pao 侧 env 缺省;true/false＝SDK 显式表态
function fixture(enabled: boolean | undefined, persisted = true) {
	const usage = vi.fn();
	const metadata = vi.fn();
	let sessionId = "original";
	const manager = {
		getSessionId: () => sessionId,
		getSessionFile: () => (persisted ? "original.jsonl" : undefined),
		getCwd: () => "project",
		appendUsage: usage,
		appendCustomEntry: metadata,
	} as unknown as SessionManager;
	const stream = vi.fn(async () => ({ result: async () => response() }));
	const auth = vi.fn(async () => ({ auth: { apiKey: "offline-test-key" } }));
	const install = vi.spyOn(precompactionRegistry, "installPrecompactionAdapter");
	setupPrecompaction({
		enabled,
		agent: { state: { thinkingLevel: "off" }, streamFunction: stream } as unknown as Agent,
		sessionManager: manager,
		modelRuntime: { getAuth: auth, getPhysicalModel: () => model } as unknown as ModelRuntime,
		settingsManager: {
			getRetrySettings: () => ({ enabled: false, maxRetries: 0 }),
			getCompactionSettings: () => preparation().settings,
		} as unknown as SettingsManager,
	});
	const adapter = install.mock.calls.at(-1)![1];
	return {
		adapter,
		stream,
		usage,
		metadata,
		auth,
		switchSession: () => {
			sessionId = "new";
		},
	};
}

afterEach(() => vi.restoreAllMocks());
describe("预压缩原生摘要与费用接线（离线假供应商）", () => {
	it("默认关闭和无持久账本会话均不启动后台请求", () => {
		expect(fixture(false).adapter.enabled).toBe(false);
		const test = fixture(true, false);
		expect(test.adapter.enabled).toBe(false);
		expect(test.stream).not.toHaveBeenCalled();
	});
	it("启用缺省在 pao 侧读 PAO_PRECOMPACTION（SDK 未传 enabled 时 env=1 即启用,显式选项优先）", () => {
		const prev = process.env.PAO_PRECOMPACTION;
		process.env.PAO_PRECOMPACTION = "1";
		try {
			// SDK 未表态(undefined)且 env=1 → 启用;SDK 显式关(false)优先于 env
			expect(fixture(undefined).adapter.enabled).toBe(true);
			expect(fixture(false).adapter.enabled).toBe(false);
		} finally {
			if (prev === undefined) delete process.env.PAO_PRECOMPACTION;
			else process.env.PAO_PRECOMPACTION = prev;
		}
		expect(fixture(undefined).adapter.enabled).toBe(false); // env 未设＝缺省关
	});
	it("真实 compact 函数通过同一 stream 生成，供应商用量只记一次，摘要仍可回原生路径应用", async () => {
		const test = fixture(true);
		const result = await test.adapter.generate(preparation(), model, new AbortController().signal);
		expect(result.summary).toContain("保留原始约束");
		expect(test.stream).toHaveBeenCalledTimes(1);
		expect(test.usage).toHaveBeenCalledTimes(1);
		expect(test.usage.mock.calls[0].slice(0, 4)).toEqual(["precompaction", "offline", "fake", response().usage]);
	});
	it("供应商返回失败但有费用仍记账；无响应则写费用未知证据", async () => {
		const test = fixture(true);
		test.stream.mockImplementationOnce(async () => ({
			result: async () => ({ ...response(), stopReason: "error", errorMessage: "offline failure" }),
		}));
		await expect(test.adapter.generate(preparation(), model, new AbortController().signal)).rejects.toThrow();
		expect(test.usage).toHaveBeenCalledTimes(1);
		test.stream.mockRejectedValueOnce(new Error("offline stream failure"));
		await expect(test.adapter.generate(preparation(), model, new AbortController().signal)).rejects.toThrow();
		expect(test.usage).toHaveBeenCalledTimes(1);
		expect(test.metadata.mock.calls.some((call) => call[1].status === "请求未返回用量")).toBe(true);
	});
	it("切会话后的迟到响应费用写原会话，状态不污染新会话", async () => {
		const test = fixture(true);
		const originalUsage = vi.fn();
		const open = vi
			.spyOn(SessionManager, "open")
			.mockReturnValue({ appendUsage: originalUsage, getSessionId: () => "original" } as unknown as SessionManager);
		test.stream.mockImplementationOnce(async () => {
			test.switchSession();
			return { result: async () => response() };
		});
		await test.adapter.generate(preparation(), model, new AbortController().signal);
		expect(open).toHaveBeenCalledWith("original.jsonl", undefined, "project");
		expect(originalUsage).toHaveBeenCalledTimes(1);
		expect(test.usage).not.toHaveBeenCalled();
		test.adapter.recordStatus("original", "已丢弃");
		expect(test.metadata).not.toHaveBeenCalled();
	});
	it("生成前取消不访问认证或供应商", async () => {
		const test = fixture(true);
		const controller = new AbortController();
		controller.abort();
		await expect(test.adapter.generate(preparation(), model, controller.signal)).rejects.toThrow("取消");
		expect(test.auth).not.toHaveBeenCalled();
		expect(test.stream).not.toHaveBeenCalled();
	});
});
