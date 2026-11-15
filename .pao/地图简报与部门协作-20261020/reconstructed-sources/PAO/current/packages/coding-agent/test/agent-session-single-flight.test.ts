/**
 * Tests for AgentSession single-flight flag pre-check (S4-3 内核伴随窄修).
 *
 * 重叠窗：两条并发 prompt() 在第一条置位 _isAgentRunActive 前都通过了 prompt() 的
 * isStreaming 检查，随后先后进入 _runAgentPrompt。输家必须在置位前被旗前检查干净拒绝
 * （try 之前抛），否则其 finally 会提前发 agent_settled 并清旗，污染赢家的运行状态。
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("AgentSession single-flight flag pre-check", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-single-flight-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	it("重叠窗：输家被旗前检查干净拒绝，赢家运行期间零次 agent_settled", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		// 赢家的流挂起直到测试放行，保证断言发生时 run 仍在进行。
		let releaseWinner: (() => void) | undefined;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					releaseWinner = () => {
						stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
					};
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));

		// 重叠窗构造：第一条 prompt 在 before_agent_start（isStreaming 检查之后、置位之前）慢 50ms；
		// 第二条在该窗口内通过 isStreaming 检查并先进入 _runAgentPrompt 占住 activeRun。
		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				pi.on("before_agent_start", async (event) => {
					if (event.prompt === "First") {
						await new Promise((resolve) => setTimeout(resolve, 50));
					}
				});
			},
		]);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});

		let settledCount = 0;
		session.subscribe((event) => {
			if (event.type === "agent_settled") settledCount++;
		});

		const loser = session.prompt("First");
		const winner = session.prompt("Second");

		// 输家必须以会话层旗前检查的错误干净拒绝（try 之前抛，不触发 finally 落定）。
		await expect(loser).rejects.toThrow(
			"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
		);
		// 赢家仍在跑：不得有提前落定、旗不得被清。
		expect(settledCount).toBe(0);
		expect(session.isStreaming).toBe(true);

		expect(typeof releaseWinner).toBe("function");
		releaseWinner!();
		await winner;

		// 全程恰一次 agent_settled（赢家落定），无双发。
		expect(settledCount).toBe(1);
		expect(session.isStreaming).toBe(false);
	});
});
