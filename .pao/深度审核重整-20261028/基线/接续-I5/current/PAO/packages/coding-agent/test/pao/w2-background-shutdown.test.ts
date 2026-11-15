import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { getBackgroundWorkPort } from "../../src/core/background-work.ts";
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
import { MinisterHost, type TeardownRecord } from "../../src/pao/host/host.ts";
import paoExtension from "../../src/pao/index.ts";
import { DISPATCH_NOTIFY_SECTION } from "../../src/pao/worker/notify.ts";
import { WorkerRunner } from "../../src/pao/worker/runner.ts";
import { createInMemoryModelRegistry } from "../model-runtime-test-utils.ts";

const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) {
		await cleanup().catch(() => {
			// 收尾失败不能掩盖测试正文已给出的断言；这里只保证所有存活对象都再次尝试停止。
		});
	}
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

function extensionActions(sendMessage: ExtensionActions["sendMessage"] = () => {}): ExtensionActions {
	return {
		sendMessage,
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

function contextActions(): ExtensionContextActions {
	return {
		getModel: () => undefined,
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

function tempRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), `pao-w2-${prefix}-`));
	roots.push(root);
	return root;
}

describe("W2 后台关闭确认", () => {
	it("关闭处理器失败时不提前关闭后台端口，通知恢复等待，重试成功后才执行确认清理", async () => {
		const root = tempRoot("shutdown");
		let workerStopCalls = 0;
		let retry = false;
		let closeProbe: Promise<void> | undefined;
		let backgroundClosed = false;
		let childSpawned = false;
		const wakeups: string[] = [];
		const workerFailure = new Error("worker 停止失败");
		class TestWorkerRunner extends WorkerRunner {
			override async stopAll(): ReturnType<WorkerRunner["stopAll"]> {
				workerStopCalls++;
				if (!retry) throw workerFailure;
				return { 已确认: [], 已失败: [] } as unknown as Awaited<ReturnType<WorkerRunner["stopAll"]>>;
			}
		}
		class TestHost extends MinisterHost {
			override async stopAll(reason?: string): Promise<TeardownRecord[]> {
				if (!retry) throw new Error("部长宿主停止失败");
				return childSpawned ? super.stopAll(reason) : [];
			}
		}
		const host = new TestHost();
		const runtime: ExtensionRuntime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			(pi) => {
				paoExtension(pi, {
					resolvePaoHome: () => root,
					resolveProjectRoot: () => root,
					resolveCardsDir: () => join(root, ".pao", "卡"),
					host,
					runner: new TestWorkerRunner({ 证据目录: join(root, "证据") }),
				});
				pi.on("session_shutdown", async (_event, ctx) => {
					if (retry) return;
					const port = getBackgroundWorkPort(ctx.sessionManager);
					expect(port).toBeDefined();
					closeProbe = port!.waitForChange();
					void closeProbe.catch(() => {
						backgroundClosed = true;
					});
					throw workerFailure;
				});
			},
			root,
			createEventBus(),
			runtime,
		);
		const sessionManager = SessionManager.inMemory(root, { id: "shutdown-owner" });
		const runner = new ExtensionRunner(
			[extension],
			runtime,
			root,
			sessionManager,
			await createInMemoryModelRegistry(AuthStorage.inMemory()),
		);
		runner.bindCore(
			extensionActions((message) => {
				const first = message.content[0];
				if (first && typeof first !== "string" && first.type === "text") wakeups.push(first.text);
			}),
			contextActions(),
		);
		runner.setUIContext({ notify: () => {} } as unknown as ExtensionUIContext, "rpc");
		await runner.emit({ type: "session_start", reason: "startup" });
		expect(getBackgroundWorkPort(sessionManager)).toBeDefined();
		cleanups.push(async () => {
			retry = true;
			await runner.emit({ type: "session_shutdown", reason: "quit" });
			await host.stopAll("测试清理");
		});

		await expect(runner.emit({ type: "session_shutdown", reason: "quit" })).rejects.toMatchObject({
			name: "AggregateError",
		});
		expect(workerStopCalls).toBe(1);
		expect(getBackgroundWorkPort(sessionManager)).toBeDefined();
		expect(backgroundClosed).toBe(false);

		host.trackSupervision({
			key: "department:测试",
			kind: "department",
			department: "测试",
			projectRoot: root,
		});
		await host.finishSupervision({
			key: "department:测试",
			outcome: "completed",
			detail: "失败后后台仍可产生通知",
		});
		await expect(closeProbe).resolves.toBeUndefined();
		expect(backgroundClosed).toBe(false);

		const ackChild = `
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
	const command = JSON.parse(line);
	if (command.type === "get_state") {
		console.log(JSON.stringify({ type: "response", id: command.id, command: "get_state", success: true, data: { sessionId: "ack-retry-session" } }));
	}
	if (command.type === "prompt") {
		console.log(JSON.stringify({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "queued" } }));
		setTimeout(() => {
			console.log(JSON.stringify({ type: "agent_start" }));
			setTimeout(() => console.log(JSON.stringify({
				type: "tool_execution_end",
				toolName: "pao_ack_supervision",
				result: {
					content: [{ type: "text", text: "已确认" }],
					details: { type: "pao_supervision_ack", key: "worker:after-failed-stop", sessionId: "ack-retry-session" }
				},
				isError: false
			})), 20);
			setTimeout(() => console.log(JSON.stringify({ type: "agent_settled" })), 60);
		}, 20);
	}
});
setInterval(() => {}, 1000);
`;
		const spawned = await host.spawn({
			部门: "前端",
			项目根: root,
			脉络: "workflow-owner",
			命令: process.execPath,
			参数: ["-e", ackChild],
		});
		expect(spawned.ok).toBe(true);
		childSpawned = true;
		const ackSessionId = spawned.ok ? spawned.handle.会话标识 : "";
		host.trackSupervision({
			key: "worker:after-failed-stop",
			kind: "worker",
			department: "前端",
			projectRoot: root,
			context: "workflow-owner",
			sessionId: ackSessionId,
		});
		host.trackSupervision({
			key: "department:after-failed-stop",
			kind: "department",
			department: "后端",
			projectRoot: root,
			context: "workflow-owner",
		});
		await host.finishSupervision({
			key: "department:after-failed-stop",
			outcome: "completed",
			detail: "停止失败后仍应主动唤醒",
		});
		expect(wakeups).toContain("有新的后台结果，请读取本轮注入的通知摘要。");
		const injected = await runner.emitBeforeAgentStart("读取停止失败后的通知", undefined, { cwd: root });
		expect(injected.systemPromptOptions.sections[DISPATCH_NOTIFY_SECTION]).toContain("停止失败后仍应主动唤醒");

		expect((await host.inject("前端", root, "提交监督确认", "workflow-owner", "followUp")).ok).toBe(true);
		expect(await waitUntil(() => host.backgroundCount().inFlight === 0)).toBe(true);
		const ackInjected = await runner.emitBeforeAgentStart("读取监督确认", undefined, { cwd: root });
		expect(ackInjected.systemPromptOptions.sections[DISPATCH_NOTIFY_SECTION]).toContain(
			"部长监督确认已核验:worker:after-failed-stop",
		);

		retry = true;
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		expect(workerStopCalls).toBe(2);
		expect(getBackgroundWorkPort(sessionManager)).toBeUndefined();
	});
});

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return predicate();
}
