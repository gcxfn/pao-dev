import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Model, Usage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { createEventBus } from "../../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../../src/core/extensions/runner.ts";
import type {
	ExtensionActions,
	ExtensionContextActions,
	ExtensionRuntime,
	ExtensionUIContext,
} from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { armContextCapture, getContextCapture, registerContextInspection } from "../../src/pao/context/index.ts";
import { desktopOwnerEntry, readDesktopWorkerActivity, registerDesktopOwner } from "../../src/pao/desktop/owners.ts";
import { registerTodo, TODO_WRITE_TOOL_NAME } from "../../src/pao/todo/index.ts";
import { registerUsageFooter, type UsageFooterState } from "../../src/pao/worker/usage-display.ts";
import { createInMemoryModelRegistry } from "../model-runtime-test-utils.ts";

/**
 * 本组验证真实 ExtensionRunner 的确认关闭顺序：
 * SessionManager、Runner、ExtensionAPI 事件分发和模块注册均为真实实现；
 * 用量消息与模型对象是模拟事件，不发起真实模型请求。
 */

const roots: string[] = [];
const closeWithoutConfirmedCleanup: Array<() => Promise<void>> = [];
const teardownFailures: unknown[] = [];

afterEach(async () => {
	for (const cleanup of closeWithoutConfirmedCleanup.splice(0)) {
		await cleanup().catch((error: unknown) => {
			teardownFailures.push(error);
		});
	}
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
	const failures = teardownFailures.splice(0);
	if (failures.length > 0) throw new AggregateError(failures, "Runner 关闭测试收尾失败");
});

function tempRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), `pao-w2-runner-${prefix}-`));
	roots.push(root);
	return root;
}

function actions(): ExtensionActions {
	return {
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		getActiveTools: () => [],
		getAllTools: () => [],
		getSettings: () => ({}),
		setActiveTools: () => {},
		refreshTools: () => {},
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => "off",
		setThinkingLevel: () => {},
	};
}

function contextActions(model: Model<string>): ExtensionContextActions {
	return {
		getModel: () => model,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getSignal: () => undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
		getScopedModels: () => [],
	};
}

function usage(cost: number): Usage {
	return {
		input: 10,
		output: 2,
		cacheRead: 3,
		cacheWrite: 4,
		totalTokens: 19,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function assistant(cost: number, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		provider: "fake",
		model: "offline",
		api: "openai-completions",
		content: [],
		usage: usage(cost),
		stopReason: "stop",
		timestamp,
	};
}

async function harness(input: { id: string; root: string; failFirstClose: boolean; shutdowns: UsageFooterState[] }) {
	const model = { provider: "fixed-fake", id: "model-offline", contextWindow: 4_096 } as Model<string>;
	const runtime: ExtensionRuntime = createExtensionRuntime();
	let failShutdown = input.failFirstClose;
	let currentTodos: (() => readonly { content: string; status: string }[]) | undefined;
	const extension = await loadExtensionFromFactory(
		(pi) => {
			currentTodos = registerTodo(pi).currentTodos;
			registerContextInspection(pi);
			registerDesktopOwner(pi, {
				getWorkerActivity: () => [],
				getSilenceMinutes: () => 0,
			});
			registerUsageFooter(pi, {
				onShutdown: (state) => input.shutdowns.push(state),
			});
			pi.on("session_shutdown", () => {
				if (!failShutdown) return;
				failShutdown = false;
				throw new Error("模拟 ExtensionRunner 关闭失败");
			});
		},
		input.root,
		createEventBus(),
		runtime,
	);
	const sessionManager = SessionManager.inMemory(input.root, { id: input.id });
	const runner = new ExtensionRunner(
		[extension],
		runtime,
		input.root,
		sessionManager,
		await createInMemoryModelRegistry(AuthStorage.inMemory()),
	);
	runner.bindCore(actions(), contextActions(model));
	runner.setUIContext({ notify: () => {} } as unknown as ExtensionUIContext, "rpc");
	await runner.emit({ type: "session_start", reason: "startup" });
	closeWithoutConfirmedCleanup.push(async () => {
		failShutdown = false;
		await runner.emit({ type: "session_shutdown", reason: "quit" });
	});
	if (!currentTodos) throw new Error("未取得 todo 当前清单读取口");
	return { runner, sessionManager, currentTodos };
}

describe("W2 真实 Runner 关闭失败后的会话状态", () => {
	it("首次关闭失败保留 owner/todo/context/usage,失败期间新增用量进入最终确认清理;另一会话不串", async () => {
		const rootA = tempRoot("a");
		const rootB = tempRoot("b");
		const shutdownsA: UsageFooterState[] = [];
		const shutdownsB: UsageFooterState[] = [];
		const a = await harness({ id: "session-a", root: rootA, failFirstClose: true, shutdowns: shutdownsA });
		const b = await harness({ id: "session-b", root: rootB, failFirstClose: true, shutdowns: shutdownsB });

		const todoA = a.runner.getToolDefinition(TODO_WRITE_TOOL_NAME);
		const todoB = b.runner.getToolDefinition(TODO_WRITE_TOOL_NAME);
		if (!todoA || !todoB) throw new Error("未注册 todo_write");
		await todoA.execute(
			"a-todo",
			{ todos: [{ content: "A 保留项", status: "in_progress" }] },
			undefined,
			undefined,
			a.runner.createToolContext("a-todo", undefined),
		);
		await todoB.execute(
			"b-todo",
			{ todos: [{ content: "B 保留项", status: "pending" }] },
			undefined,
			undefined,
			b.runner.createToolContext("b-todo", undefined),
		);
		expect(a.currentTodos()).toEqual([{ content: "A 保留项", status: "in_progress" }]);
		expect(b.currentTodos()).toEqual([{ content: "B 保留项", status: "pending" }]);

		armContextCapture("session-a");
		await a.runner.emitBeforeProviderRequest({ model: "model-a", tools: [], phase: "before-failed-close" });
		expect(getContextCapture("session-a")?.供应商请求).toEqual(
			expect.objectContaining({ model: "model-a", phase: "before-failed-close" }),
		);
		expect(getContextCapture("session-b")).toBeUndefined();

		const aInitial = assistant(0.25, 1);
		a.sessionManager.appendMessage(aInitial);
		await a.runner.emit({ type: "agent_end", messages: [aInitial] });
		expect(desktopOwnerEntry("session-a")).toBeDefined();
		expect(desktopOwnerEntry("session-b")).toBeDefined();
		expect(readDesktopWorkerActivity(rootA)).toEqual([]);

		await expect(a.runner.emit({ type: "session_shutdown", reason: "quit" })).rejects.toMatchObject({
			name: "AggregateError",
		});
		expect(shutdownsA).toEqual([]);
		expect(desktopOwnerEntry("session-a")).toBeDefined();
		expect(getContextCapture("session-a")).toBeDefined();
		expect(a.currentTodos()).toEqual([{ content: "A 保留项", status: "in_progress" }]);
		expect(b.currentTodos()).toEqual([{ content: "B 保留项", status: "pending" }]);

		const aAfterFailure = assistant(0.75, 2);
		a.sessionManager.appendMessage(aAfterFailure);
		await a.runner.emit({ type: "agent_end", messages: [aAfterFailure] });
		expect(b.sessionManager.getEntries().some((entry) => entry.type === "message")).toBe(false);
		expect(getContextCapture("session-b")).toBeUndefined();

		await expect(a.runner.emit({ type: "session_shutdown", reason: "quit" })).resolves.toBeUndefined();
		expect(shutdownsA).toHaveLength(1);
		expect(shutdownsA[0]!.累计.cost).toBeCloseTo(1);
		expect(shutdownsA[0]!.累计.turns).toBe(2);
		expect(desktopOwnerEntry("session-a")).toBeUndefined();
		expect(getContextCapture("session-a")).toBeUndefined();
		expect(a.currentTodos()).toEqual([]);
		expect(b.currentTodos()).toEqual([{ content: "B 保留项", status: "pending" }]);
		expect(desktopOwnerEntry("session-b")).toBeDefined();
		expect(b.sessionManager.getEntries().some((entry) => entry.type === "message")).toBe(false);
		expect(shutdownsB).toEqual([]);

		await expect(b.runner.emit({ type: "session_shutdown", reason: "quit" })).rejects.toMatchObject({
			name: "AggregateError",
		});
		expect(desktopOwnerEntry("session-b")).toBeDefined();
		expect(shutdownsB).toEqual([]);
		await expect(b.runner.emit({ type: "session_shutdown", reason: "quit" })).resolves.toBeUndefined();
		expect(desktopOwnerEntry("session-b")).toBeUndefined();
		expect(b.currentTodos()).toEqual([]);
	});
});
