import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { type BackgroundWorkPort, BackgroundWorkSignal, bindBackgroundWorkPort } from "../src/core/background-work.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { JsonAgentSessionEvent } from "../src/modes/json-event.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
	stdinEndHandlers: [] as Array<() => void>,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

function outputEvents(): JsonAgentSessionEvent[] {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as JsonAgentSessionEvent);
}

function backgroundEvents(): Array<Extract<JsonAgentSessionEvent, { type: "background_work" }>> {
	return outputEvents().filter(
		(event): event is Extract<JsonAgentSessionEvent, { type: "background_work" }> => event.type === "background_work",
	);
}

describe("RPC 后台工作生命周期顺序", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	it("初始零值、在途、清零、重绑和关闭顺序正确", async () => {
		const root = mkdtempSync(join(tmpdir(), "pao-rpc-background-lifecycle-"));
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const faux = fauxProvider({ tokensPerSecond: 1_000_000 });
		runtime.registerNativeProvider(faux.provider);
		await runtime.refresh({ allowNetwork: false });

		const firstState = { running: 0, unread: 0 };
		const secondState = { running: 0, unread: 0 };
		const firstSignal = new BackgroundWorkSignal();
		const secondSignal = new BackgroundWorkSignal();
		let latestSignal: BackgroundWorkSignal | undefined;
		let latestPort: BackgroundWorkPort | undefined;
		let starts = 0;
		const extensionFactory = (pi: ExtensionAPI) => {
			pi.on("session_start", (_event, ctx) => {
				starts++;
				const state = starts === 1 ? firstState : secondState;
				const signal = starts === 1 ? firstSignal : secondSignal;
				const port: BackgroundWorkPort = {
					snapshot: () => ({ ...state }),
					waitForChange: (abortSignal) => {
						const observed = signal.currentVersion;
						return signal.waitForChange(abortSignal, observed);
					},
					shutdown: () => signal.shutdown(),
				};
				latestSignal = signal;
				latestPort = port;
				bindBackgroundWorkPort(ctx.sessionManager, port);
			});
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
		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: root,
			agentDir: root,
			sessionManager: SessionManager.inMemory(root),
		});
		cleanups.push(async () => {
			firstSignal.shutdown();
			secondSignal.shutdown();
			await runtimeHost.dispose();
			runtime.unregisterProvider(faux.provider.id);
			rmSync(root, { recursive: true, force: true });
		});
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
		void runRpcMode(runtimeHost);
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
		await vi.waitFor(() => expect(backgroundEvents()).toEqual([{ type: "background_work", running: 0, unread: 0 }]));
		rpcIo.lineHandler!(JSON.stringify({ id: "new", type: "new_session" }));
		await vi.waitFor(() => {
			expect(backgroundEvents().length).toBeGreaterThanOrEqual(2);
		});
		expect(
			rpcIo.outputLines.some((line) => {
				const event = JSON.parse(line) as { type?: string; id?: string; command?: string };
				return event.type === "response" && event.id === "new" && event.command === "new_session";
			}),
		).toBe(true);
		expect(latestSignal).toBe(secondSignal);
		expect(latestPort).toBeDefined();
		secondState.running = 1;
		expect(latestPort?.snapshot()).toEqual({ running: 1, unread: 0 });
		secondState.running = 1;
		await new Promise((resolve) => setTimeout(resolve, 50));
		latestSignal?.changed();
		await new Promise((resolve) => setTimeout(resolve, 50));
	});

	it("关闭后端口变化和端口关闭都不再发事件", async () => {
		const root = mkdtempSync(join(tmpdir(), "pao-rpc-background-close-"));
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const faux = fauxProvider({ tokensPerSecond: 1_000_000 });
		runtime.registerNativeProvider(faux.provider);
		await runtime.refresh({ allowNetwork: false });
		const state = { running: 1, unread: 0 };
		const signal = new BackgroundWorkSignal();
		const extensionFactory = (pi: ExtensionAPI) => {
			pi.on("session_start", (_event, ctx) => {
				bindBackgroundWorkPort(ctx.sessionManager, {
					snapshot: () => ({ ...state }),
					waitForChange: (abortSignal) => {
						const observed = signal.currentVersion;
						return signal.waitForChange(abortSignal, observed);
					},
					shutdown: () => signal.shutdown(),
				});
			});
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
		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: root,
			agentDir: root,
			sessionManager: SessionManager.inMemory(root),
		});
		cleanups.push(async () => {
			signal.shutdown();
			runtime.unregisterProvider(faux.provider.id);
			rmSync(root, { recursive: true, force: true });
		});

		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
		void runRpcMode(runtimeHost);
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
		await vi.waitFor(() => expect(backgroundEvents()).toEqual([{ type: "background_work", running: 1, unread: 0 }]));

		const beforeClose = backgroundEvents().length;
		await runtimeHost.dispose();
		state.running = 0;
		signal.shutdown();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(backgroundEvents()).toHaveLength(beforeClose);
	});
});
