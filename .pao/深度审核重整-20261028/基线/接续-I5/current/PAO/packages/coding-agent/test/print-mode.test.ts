import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, fauxAssistantMessage, fauxProvider, type ImageContent } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	type BackgroundWorkPort,
	BackgroundWorkSignal,
	bindBackgroundWorkPort,
	getBackgroundWorkPort,
	releaseBackgroundWorkPort,
} from "../src/core/background-work.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../src/core/models-store.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { SessionShutdownEvent } from "../src/index.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";

type EmitEvent = SessionShutdownEvent;

type FakeExtensionRunner = {
	hasHandlers: (eventType: string) => boolean;
	emit: ReturnType<typeof vi.fn<(event: EmitEvent) => Promise<void>>>;
};

type FakeSession = {
	sessionManager: object & { getHeader: () => object | undefined };
	agent: { subscribe: ReturnType<typeof vi.fn> };
	state: { messages: AssistantMessage[] };
	extensionRunner: FakeExtensionRunner;
	isIdle: boolean;
	bindExtensions: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	reload: ReturnType<typeof vi.fn>;
	waitForIdle: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
};

type FakeRuntimeHost = {
	session: FakeSession;
	newSession: ReturnType<typeof vi.fn>;
	fork: ReturnType<typeof vi.fn>;
	switchSession: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	setRebindSession: ReturnType<typeof vi.fn>;
};

type BoundPrintPort = {
	port: BackgroundWorkPort;
	manager: object;
};

function createAssistantMessage(options?: {
	text?: string;
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content: options?.text ? [{ type: "text", text: options.text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options?.stopReason ?? "stop",
		errorMessage: options?.errorMessage,
		timestamp: Date.now(),
	};
}

function createRuntimeHost(assistantMessage: AssistantMessage, boundPort?: BoundPrintPort): FakeRuntimeHost {
	const extensionRunner: FakeExtensionRunner = {
		hasHandlers: (eventType: string) => eventType === "session_shutdown",
		emit: vi.fn(async () => {}),
	};

	const state = { messages: [assistantMessage] };

	const sessionManager = { getHeader: () => undefined };
	if (boundPort) boundPort.manager = sessionManager;
	const session: FakeSession = {
		sessionManager,
		agent: { subscribe: vi.fn(() => () => {}) },
		state,
		extensionRunner,
		isIdle: true,
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
		prompt: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
		waitForIdle: vi.fn(async () => {}),
		close: vi.fn(async () => {}),
	};

	return {
		session,
		newSession: vi.fn(async () => undefined),
		fork: vi.fn(async () => ({ selectedText: "" })),
		switchSession: vi.fn(async () => undefined),
		dispose: vi.fn(async () => {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			if (boundPort) releaseBackgroundWorkPort(boundPort.manager, boundPort.port);
		}),
		setRebindSession: vi.fn(),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

async function createFauxRuntime(options: {
	onSessionStart: (sessionManager: object, notify: () => void) => void;
	onSessionShutdown?: (sessionManager: object) => void;
	initialSessionManager?: SessionManager;
	extensionFactory?: (pi: ExtensionAPI) => void;
}) {
	const root = mkdtempSync(join(tmpdir(), "pao-print-background-"));
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsStore: new InMemoryCodingAgentModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({ tokensPerSecond: 1_000_000 });
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false });
	const signal = new BackgroundWorkSignal();
	let state = { running: 0, unread: 0 };
	const extensionFactory = (pi: ExtensionAPI) => {
		pi.on("session_start", (_event, ctx) => {
			options.onSessionStart(ctx.sessionManager, signal.changed);
		});
		pi.on("session_shutdown", (_event, ctx) => {
			options.onSessionShutdown?.(ctx.sessionManager);
		});
		options.extensionFactory?.(pi);
	};
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: root,
			modelRuntime: runtime,
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
			resourceLoaderOptions: {
				extensionFactories: [extensionFactory],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: faux.getModel(),
				noTools: "all",
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const host = await createAgentSessionRuntime(createRuntime, {
		cwd: root,
		agentDir: root,
		sessionManager: options.initialSessionManager ?? SessionManager.inMemory(root),
	});
	const port: BackgroundWorkPort = {
		snapshot: () => ({ ...state }),
		waitForChange: (abortSignal) => {
			const observed = signal.currentVersion;
			return signal.waitForChange(abortSignal, observed);
		},
		shutdown: () => signal.shutdown(),
	};
	let disposed = false;
	return {
		host,
		faux,
		root,
		port,
		runtime,
		signal,
		getState: () => ({ ...state }),
		async dispose() {
			if (disposed) return;
			disposed = true;
			await host.dispose();
		},
		setState(next: { running: number; unread: number }) {
			state = next;
			signal.changed();
		},
		isDisposed: () => disposed,
		cleanup() {
			signal.shutdown();
			runtime.unregisterProvider(faux.provider.id);
			rmSync(root, { recursive: true, force: true });
		},
	};
}

describe("runPrintMode", () => {
	it("emits session_shutdown in text mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc" }];

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "Say done",
			initialImages: images,
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("Say done", { images });
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown in json mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["hello"],
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("hello");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown and returns non-zero on assistant error", async () => {
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "provider failure" }),
		);
		const { session } = runtimeHost;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("provider failure");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("keeps the runtime alive through background work and its follow-up turn", async () => {
		const state = { running: 1, unread: 0 };
		const changes: Array<() => void> = [];
		const port: BackgroundWorkPort = {
			snapshot: () => ({ ...state }),
			waitForChange: vi.fn(
				() =>
					new Promise<void>((resolve) => {
						changes.push(resolve);
					}),
			),
			shutdown: vi.fn(),
		};
		const boundPort: BoundPrintPort = { port, manager: {} };
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }), boundPort);
		const { session } = runtimeHost;
		bindBackgroundWorkPort(session.sessionManager, port);
		try {
			let settled = false;
			const running = runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
				mode: "text",
				initialMessage: "delegate",
			}).then((code) => {
				settled = true;
				return code;
			});

			await vi.waitFor(() => expect(port.waitForChange).toHaveBeenCalledOnce(), { interval: 5, timeout: 500 });
			expect(runtimeHost.dispose).not.toHaveBeenCalled();

			state.running = 0;
			state.unread = 1;
			changes.shift()?.();
			// 第一次唤醒会继续进入 follow-up 轮次；等它结束，再断言下一段未读结果等待。
			await vi.waitFor(
				() => {
					expect(port.waitForChange).toHaveBeenCalledTimes(2);
				},
				{ interval: 5, timeout: 500 },
			);
			expect(runtimeHost.dispose).not.toHaveBeenCalled();

			state.unread = 0;
			changes.shift()?.();
			await expect(running).resolves.toBe(0);
			expect(settled).toBe(true);
			expect(runtimeHost.dispose).toHaveBeenCalledOnce();
			expect(session.prompt).toHaveBeenCalledOnce();
		} finally {
			releaseBackgroundWorkPort(session.sessionManager);
		}
	});

	it("exits immediately without background work", async () => {
		const port: BackgroundWorkPort = {
			snapshot: () => ({ running: 0, unread: 0 }),
			waitForChange: vi.fn(async () => {}),
			shutdown: vi.fn(),
		};
		const boundPort: BoundPrintPort = { port, manager: {} };
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }), boundPort);
		const { session } = runtimeHost;
		bindBackgroundWorkPort(session.sessionManager, port);
		try {
			await expect(
				runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
					mode: "text",
					initialMessage: "normal",
				}),
			).resolves.toBe(0);
			expect(port.waitForChange).not.toHaveBeenCalled();
			expect(runtimeHost.dispose).toHaveBeenCalledOnce();
		} finally {
			releaseBackgroundWorkPort(session.sessionManager);
		}
	});

	it("cancels a background wait and disposes without waiting for convergence", async () => {
		const waiting: { reject?: (reason: unknown) => void } = {};
		const port: BackgroundWorkPort = {
			snapshot: () => ({ running: 1, unread: 0 }),
			waitForChange: vi.fn((signal?: AbortSignal) => {
				return new Promise<void>((_resolve, reject) => {
					waiting.reject = reject;
					signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			}),
			shutdown: vi.fn(() => waiting.reject?.(new Error("port shut down"))),
		};
		const boundPort: BoundPrintPort = { port, manager: {} };
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }), boundPort);
		const { session } = runtimeHost;
		bindBackgroundWorkPort(session.sessionManager, port);
		const signalHandlers = new Map<string, () => void>();
		const onSpy = vi.spyOn(process, "on").mockImplementation((event, handler) => {
			signalHandlers.set(String(event), handler as () => void);
			return process;
		});
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		try {
			const running = runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
				mode: "text",
				initialMessage: "delegate",
			});
			await vi.waitFor(() => expect(port.waitForChange).toHaveBeenCalledOnce());
			signalHandlers.get("SIGTERM")?.();
			await vi.waitFor(() => expect(port.shutdown).toHaveBeenCalledOnce());
			await expect(running).resolves.toBe(0);
			expect(exitSpy).toHaveBeenCalledWith(143);
		} finally {
			releaseBackgroundWorkPort(session.sessionManager);
			onSpy.mockRestore();
			exitSpy.mockRestore();
		}
	});

	it("uses a real faux AgentSession, runs the follow-up turn, and disposes only after convergence", async () => {
		let fixture!: Awaited<ReturnType<typeof createFauxRuntime>>;
		let shutdownCount = 0;
		fixture = await createFauxRuntime({
			onSessionStart(sessionManager, _notify) {
				bindBackgroundWorkPort(sessionManager, fixture.port);
			},
			onSessionShutdown() {
				shutdownCount++;
			},
		});
		const runtimeSession = fixture.host.session;
		let disposeCalled = false;
		const originalDispose = fixture.host.dispose.bind(fixture.host);
		fixture.host.dispose = async () => {
			disposeCalled = true;
			await originalDispose();
		};
		const started: number[] = [];
		let resolveFirstStarted!: () => void;
		const firstStarted = new Promise<void>((resolve) => {
			resolveFirstStarted = resolve;
		});
		fixture.faux.setResponses([
			() => {
				started.push(1);
				fixture.setState({ running: 1, unread: 0 });
				resolveFirstStarted();
				return fauxAssistantMessage("已受理后台任务");
			},
			() => {
				started.push(2);
				fixture.setState({ running: 0, unread: 0 });
				return fauxAssistantMessage("后台结果已处理");
			},
		]);
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((
			_chunk: string | Uint8Array,
			encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
			callback?: (error?: Error | null) => void,
		) => {
			const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
			done?.();
			return true;
		}) as typeof process.stdout.write);

		try {
			const running = runPrintMode(fixture.host, { mode: "text", initialMessage: "派发任务" });
			await Promise.race([
				firstStarted,
				running.then((code) => {
					throw new Error(`print exited early with ${code}`);
				}),
			]);

			// 完成通知会触发真实 followUp 轮次；未读结果由
			// before_agent_start 消费，随后在途数和未读数都收敛。
			fixture.setState({ running: 0, unread: 1 });
			await runtimeSession.sendCustomMessage(
				{
					customType: "test-background-result",
					content: [{ type: "text", text: "后台任务已完成" }],
					display: false,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			expect(disposeCalled).toBe(false);
			await vi.waitFor(() => expect(started).toEqual([1, 2]), { interval: 5, timeout: 10_000 });

			await expect(running).resolves.toBe(0);
			expect(started).toEqual([1, 2]);
			expect(disposeCalled).toBe(true);
			expect(shutdownCount).toBe(1);
			expect(getBackgroundWorkPort(runtimeSession.sessionManager)).toBeUndefined();
			await expect(
				runtimeSession.sendCustomMessage(
					{
						customType: "late-background-result",
						content: [{ type: "text", text: "关闭后晚到的通知" }],
						display: false,
					},
					{ triggerTurn: true },
				),
			).rejects.toThrow("no longer accepts new turns");
			expect(started).toEqual([1, 2]);
		} catch (error) {
			throw new Error(
				`real faux print test state ${JSON.stringify({
					started,
					state: fixture.getState(),
					isIdle: runtimeSession.isIdle,
					messages: runtimeSession.state.messages
						.slice(-2)
						.map((message) =>
							message.role === "assistant"
								? { role: message.role, stopReason: message.stopReason, content: message.content }
								: { role: message.role },
						),
				})}: ${error instanceof Error ? error.stack : String(error)}`,
			);
		} finally {
			await fixture.dispose();
			fixture.cleanup();
			stdout.mockRestore();
		}
	}, 15_000);

	it("closes print after an accepted settled follow-up instead of leaving an idle shutdown window", async () => {
		let fixture!: Awaited<ReturnType<typeof createFauxRuntime>>;
		let releaseSettled!: () => void;
		const settledGate = new Promise<void>((resolve) => {
			releaseSettled = resolve;
		});
		let markSettledStarted!: () => void;
		const settledStarted = new Promise<void>((resolve) => {
			markSettledStarted = resolve;
		});
		let followUpAccepted = false;
		let shutdowns = 0;
		const phases: string[] = [];
		fixture = await createFauxRuntime({
			onSessionStart(sessionManager) {
				bindBackgroundWorkPort(sessionManager, fixture.port);
			},
			onSessionShutdown() {
				shutdowns++;
				phases.push("shutdown");
			},
			extensionFactory(pi) {
				pi.on("agent_settled", async () => {
					if (followUpAccepted) return;
					followUpAccepted = true;
					phases.push("settled-before");
					pi.sendMessage(
						{
							customType: "print-settled-follow-up",
							content: [{ type: "text", text: "已受理的关闭后续" }],
							display: false,
						},
						{ triggerTurn: true, deliverAs: "followUp" },
					);
					markSettledStarted();
					await settledGate;
					phases.push("settled-after");
				});
			},
		});
		fixture.faux.setResponses([
			fauxAssistantMessage("首轮完成"),
			() => {
				phases.push("follow-up-start");
				return fauxAssistantMessage("后续完成");
			},
		]);
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((_chunk, encodingOrCallback, callback) => {
			const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
			done?.();
			return true;
		}) as typeof process.stdout.write);

		try {
			const running = runPrintMode(fixture.host, { mode: "text", initialMessage: "开始" });
			await settledStarted;
			expect(fixture.faux.state.callCount).toBe(1);
			expect(shutdowns).toBe(0);

			fixture.setState({ running: 0, unread: 0 });
			releaseSettled();
			await expect(running).resolves.toBe(0);

			expect(fixture.faux.state.callCount).toBe(2);
			expect(phases).toEqual(["settled-before", "settled-after", "follow-up-start", "shutdown"]);
			await expect(
				fixture.host.session.sendCustomMessage(
					{
						customType: "late-print-result",
						content: [{ type: "text", text: "关闭后晚到" }],
						display: false,
					},
					{ triggerTurn: true },
				),
			).rejects.toThrow("no longer accepts new turns");
			expect(fixture.faux.state.callCount).toBe(2);
			expect(shutdowns).toBe(1);
		} finally {
			await fixture.dispose();
			fixture.cleanup();
			stdout.mockRestore();
		}
	}, 15_000);

	it("binds the port to the exact SessionManager exposed by session_start", async () => {
		let startedManager: object | undefined;
		let fixture!: Awaited<ReturnType<typeof createFauxRuntime>>;
		fixture = await createFauxRuntime({
			onSessionStart(sessionManager) {
				startedManager = sessionManager;
				bindBackgroundWorkPort(sessionManager, fixture.port);
			},
		});
		try {
			await fixture.host.session.bindExtensions({});
			expect(startedManager).toBe(fixture.host.session.sessionManager);
			expect(getBackgroundWorkPort(fixture.host.session.sessionManager)).toBe(fixture.port);
		} finally {
			await fixture.dispose();
			fixture.cleanup();
		}
	});

	it("keeps lifecycle ports isolated across a real session replacement", async () => {
		const firstManager = SessionManager.inMemory(tmpdir());
		let fixture!: Awaited<ReturnType<typeof createFauxRuntime>>;
		const managers: object[] = [];
		const ports: BackgroundWorkPort[] = [];
		fixture = await createFauxRuntime({
			initialSessionManager: firstManager,
			onSessionStart(sessionManager) {
				const port: BackgroundWorkPort = {
					snapshot: () => ({ running: 0, unread: 0 }),
					waitForChange: (signal) => {
						const observed = fixture.signal.currentVersion;
						return fixture.signal.waitForChange(signal, observed);
					},
					shutdown: vi.fn(),
				};
				ports.push(port);
				managers.push(sessionManager);
				bindBackgroundWorkPort(sessionManager, port);
			},
			onSessionShutdown(sessionManager) {
				const current = getBackgroundWorkPort(sessionManager);
				if (current) releaseBackgroundWorkPort(sessionManager, current);
			},
		});
		try {
			await fixture.host.session.bindExtensions({});
			expect(managers[0]).toBe(firstManager);
			fixture.host.setRebindSession(async () => {
				await fixture.host.session.bindExtensions({});
			});
			await fixture.host.newSession();
			const replacementManager = fixture.host.session.sessionManager;
			expect(managers).toHaveLength(2);
			expect(managers[1]).toBe(replacementManager);
			expect(replacementManager).not.toBe(firstManager);
			expect(getBackgroundWorkPort(firstManager)).toBeUndefined();
			expect(ports[0]?.shutdown).toHaveBeenCalledOnce();
			expect(getBackgroundWorkPort(replacementManager)).toBe(ports[1]);
			fixture.signal.changed();
			expect(ports[0]?.shutdown).toHaveBeenCalledOnce();
		} finally {
			await fixture.dispose();
			fixture.cleanup();
		}
	});
});
