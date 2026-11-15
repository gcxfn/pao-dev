import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, InMemoryModelsStore } from "@earendil-works/pi-ai";
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

describe("RPC 后台工作机械事件", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	it("真实 faux AgentSession 在模型轮次结束后继续发布后台在途与清零事件", async () => {
		const root = mkdtempSync(join(tmpdir(), "pao-rpc-background-"));
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const faux = fauxProvider({ tokensPerSecond: 1_000_000 });
		runtime.registerNativeProvider(faux.provider);
		await runtime.refresh({ allowNetwork: false });

		let state = { running: 0, unread: 0 };
		let signal!: BackgroundWorkSignal;
		let boundPort!: BackgroundWorkPort;
		let stateVisible!: () => void;
		const stateReady = new Promise<void>((resolve) => {
			stateVisible = resolve;
		});
		const extensionFactory = (pi: ExtensionAPI) => {
			pi.on("session_start", (_event, ctx) => {
				signal = new BackgroundWorkSignal();
				boundPort = {
					snapshot: () => ({ ...state }),
					waitForChange: (abortSignal) => {
						const observed = signal.currentVersion;
						return signal.waitForChange(abortSignal, observed);
					},
					shutdown: () => signal.shutdown(),
				};
				bindBackgroundWorkPort(ctx.sessionManager, boundPort);
				stateVisible();
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
			signal?.shutdown();
			await runtimeHost.dispose();
			runtime.unregisterProvider(faux.provider.id);
			rmSync(root, { recursive: true, force: true });
		});

		faux.setResponses([
			() => {
				queueMicrotask(() => {
					state = { running: 1, unread: 0 };
					signal.changed();
				});
				return fauxAssistantMessage("后台任务已受理");
			},
		]);

		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
		void runRpcMode(runtimeHost);
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
		await stateReady;
		await vi.waitFor(() => expect(backgroundEvents()).toEqual([{ type: "background_work", running: 0, unread: 0 }]));

		rpcIo.lineHandler!(JSON.stringify({ id: "dispatch", type: "prompt", message: "派发后台任务" }));
		await vi.waitFor(() => {
			expect(backgroundEvents()).toEqual([
				{ type: "background_work", running: 0, unread: 0 },
				{ type: "background_work", running: 1, unread: 0 },
			]);
		});
		await vi.waitFor(() => expect(outputEvents().some((event) => event.type === "agent_settled")).toBe(true));
		expect(backgroundEvents().at(-1)).toEqual({ type: "background_work", running: 1, unread: 0 });

		state = { running: 0, unread: 0 };
		signal.changed();
		await vi.waitFor(() => {
			expect(backgroundEvents().at(-1)).toEqual({ type: "background_work", running: 0, unread: 0 });
		});
	}, 15_000);
});
