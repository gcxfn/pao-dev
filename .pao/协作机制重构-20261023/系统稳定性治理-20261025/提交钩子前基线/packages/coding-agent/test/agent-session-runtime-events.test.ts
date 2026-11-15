import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type {
	ExtensionFactory,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../src/index.ts";

type RecordedSessionEvent =
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionShutdownEvent
	| SessionStartEvent;

describe("AgentSessionRuntime session lifecycle events", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeHost(
		extensionFactory: ExtensionFactory,
		options: { additionalSkillPaths?: string[] } = {},
	) {
		const tempDir = join(tmpdir(), `pi-runtime-events-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(tempDir, "models.json"),
		});
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});

		const runtimeOptions = {
			agentDir: tempDir,
			modelRuntime,
			model: faux.getModel(),
			resourceLoaderOptions: {
				extensionFactories: [extensionFactory],
				additionalSkillPaths: options.additionalSkillPaths,
				noSkills: options.additionalSkillPaths === undefined,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir),
		});
		await runtimeHost.session.bindExtensions({});

		cleanups.push(async () => {
			await runtimeHost.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtimeHost, faux };
	}

	it("emits session_before_switch and session_start for new and resume flows", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const originalSessionFile = runtimeHost.session.sessionFile;
		expect(originalSessionFile).toBeTruthy();

		const newSessionResult = await runtimeHost.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		await runtimeHost.session.bindExtensions({});
		const secondSessionFile = runtimeHost.session.sessionFile;
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "new", targetSessionFile: undefined },
			{ type: "session_shutdown", reason: "new", targetSessionFile: secondSessionFile },
			{ type: "session_start", reason: "new", previousSessionFile: originalSessionFile },
		]);

		events.length = 0;
		expect(secondSessionFile).toBeTruthy();

		const switchResult = await runtimeHost.switchSession(originalSessionFile!);
		expect(switchResult.cancelled).toBe(false);
		await runtimeHost.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_shutdown", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_start", reason: "resume", previousSessionFile: secondSessionFile },
		]);
	});

	it("honors session_before_switch cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
				return { cancel: true };
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const originalSessionFile = runtimeHost.session.sessionFile;

		const result = await runtimeHost.newSession();
		expect(result.cancelled).toBe(true);
		expect(runtimeHost.session.sessionFile).toBe(originalSessionFile);
		expect(events).toEqual([{ type: "session_before_switch", reason: "new", targetSessionFile: undefined }]);
	});

	it("runs beforeSessionInvalidate after session_shutdown and before rebindSession", async () => {
		const phases: string[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_shutdown", () => {
				phases.push("session_shutdown");
			});
		});
		const oldSession = runtimeHost.session;
		runtimeHost.setBeforeSessionInvalidate(() => {
			phases.push("beforeSessionInvalidate");
			expect(oldSession.extensionRunner.createContext().cwd).toBe(oldSession.sessionManager.getCwd());
		});
		runtimeHost.setRebindSession(async () => {
			phases.push("rebindSession");
		});

		await runtimeHost.newSession();

		expect(phases).toEqual(["session_shutdown", "beforeSessionInvalidate", "rebindSession"]);
		expect(() => oldSession.extensionRunner.createContext().cwd).toThrow(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		runtimeHost.setBeforeSessionInvalidate(undefined);
		runtimeHost.setRebindSession(undefined);
	});

	it("emits session_before_fork and session_start and honors cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelNextFork = false;
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_fork", (event) => {
				events.push(event);
				if (cancelNextFork) {
					cancelNextFork = false;
					return { cancel: true };
				}
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const userMessage = runtimeHost.session.getUserMessagesForForking()[0];
		const previousSessionFile = runtimeHost.session.sessionFile;

		const successResult = await runtimeHost.fork(userMessage.entryId);
		expect(successResult.cancelled).toBe(false);
		expect(successResult.selectedText).toBe("hello");
		await runtimeHost.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" },
			{ type: "session_shutdown", reason: "fork", targetSessionFile: runtimeHost.session.sessionFile },
			{ type: "session_start", reason: "fork", previousSessionFile },
		]);

		events.length = 0;
		cancelNextFork = true;
		const cancelResult = await runtimeHost.fork(userMessage.entryId);
		expect(cancelResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" }]);

		events.length = 0;
		cancelNextFork = true;
		const cancelAtResult = await runtimeHost.fork("missing-entry", { position: "at" });
		expect(cancelAtResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: "missing-entry", position: "at" }]);
	});

	it("closes after an accepted prompt preflight and rejects turns submitted after the close gate", async () => {
		const events: RecordedSessionEvent[] = [];
		let releaseInput!: () => void;
		const inputGate = new Promise<void>((resolve) => {
			releaseInput = resolve;
		});
		let markInputStarted!: () => void;
		const inputStarted = new Promise<void>((resolve) => {
			markInputStarted = resolve;
		});
		const { runtimeHost, faux } = await createRuntimeHost((pi) => {
			pi.on("input", async () => {
				markInputStarted();
				await inputGate;
				return { action: "continue" };
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
		});
		const session = runtimeHost.session;

		const acceptedPrompt = session.prompt("accepted before close");
		await inputStarted;
		const closing = session.close();

		await expect(session.prompt("late prompt")).rejects.toThrow("no longer accepts new turns");
		await expect(
			session.sendCustomMessage(
				{ customType: "late-trigger", content: [{ type: "text", text: "late trigger" }], display: false },
				{ triggerTurn: true },
			),
		).rejects.toThrow("no longer accepts new turns");
		await expect(session.steer("late steer")).rejects.toThrow("no longer accepts new turns");
		await expect(session.followUp("late follow-up")).rejects.toThrow("no longer accepts new turns");
		expect(faux.state.callCount).toBe(0);
		expect(events).toEqual([]);

		releaseInput();
		await Promise.all([acceptedPrompt, closing]);
		expect(faux.state.callCount).toBe(1);
		expect(events).toEqual([]);

		await runtimeHost.dispose();
		expect(events).toEqual([{ type: "session_shutdown", reason: "quit" }]);
	});

	it("closes after accepting an unknown slash prompt", async () => {
		let releaseInput!: () => void;
		const inputGate = new Promise<void>((resolve) => {
			releaseInput = resolve;
		});
		let markInputStarted!: () => void;
		const inputStarted = new Promise<void>((resolve) => {
			markInputStarted = resolve;
		});
		const { runtimeHost, faux } = await createRuntimeHost((pi) => {
			pi.on("input", async () => {
				markInputStarted();
				await inputGate;
				return { action: "continue" };
			});
		});
		const session = runtimeHost.session;

		const acceptedPrompt = session.prompt("/unknown-command");
		const closing = session.close();
		await inputStarted;
		expect(faux.state.callCount).toBe(0);

		releaseInput();
		await Promise.all([acceptedPrompt, closing]);
		expect(faux.state.callCount).toBe(1);
	});

	it("closes after accepting an existing skill command", async () => {
		const tempDir = join(tmpdir(), `pi-runtime-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const skillFile = join(tempDir, "SKILL.md");
		writeFileSync(skillFile, "---\nname: close-test\ndescription: Close ordering test.\n---\n\nSkill body.");
		let releaseInput!: () => void;
		const inputGate = new Promise<void>((resolve) => {
			releaseInput = resolve;
		});
		let markInputStarted!: () => void;
		const inputStarted = new Promise<void>((resolve) => {
			markInputStarted = resolve;
		});
		const { runtimeHost, faux } = await createRuntimeHost(
			(pi) => {
				pi.on("input", async () => {
					markInputStarted();
					await inputGate;
					return { action: "continue" };
				});
			},
			{ additionalSkillPaths: [skillFile] },
		);
		const session = runtimeHost.session;

		const acceptedPrompt = session.prompt("/skill:close-test");
		const closing = session.close();
		await inputStarted;
		expect(faux.state.callCount).toBe(0);

		releaseInput();
		await Promise.all([acceptedPrompt, closing]);
		expect(faux.state.callCount).toBe(1);
	});

	it("drains a turn accepted by an agent_settled handler before closing", async () => {
		const phases: string[] = [];
		let releaseSettled!: () => void;
		const settledGate = new Promise<void>((resolve) => {
			releaseSettled = resolve;
		});
		let markSettledStarted!: () => void;
		const settledStarted = new Promise<void>((resolve) => {
			markSettledStarted = resolve;
		});
		let queuedFollowUp = false;
		const { runtimeHost, faux } = await createRuntimeHost((pi) => {
			let triggerQueued = false;
			pi.on("agent_settled", async () => {
				if (triggerQueued) return;
				triggerQueued = true;
				phases.push("settled-before");
				queuedFollowUp = true;
				pi.sendMessage(
					{ customType: "settled-trigger", content: [{ type: "text", text: "follow-up" }], display: false },
					{ triggerTurn: true },
				);
				markSettledStarted();
				await settledGate;
				phases.push("settled-after");
			});
			pi.on("agent_start", () => {
				if (queuedFollowUp) phases.push("trigger-start");
			});
			pi.on("session_shutdown", () => {
				phases.push("shutdown");
			});
		});
		const session = runtimeHost.session;

		const firstPrompt = session.prompt("first");
		await settledStarted;
		let closeResolved = false;
		const closing = session.close().then(() => {
			closeResolved = true;
		});
		expect(faux.state.callCount).toBe(1);
		expect(closeResolved).toBe(false);

		releaseSettled();
		await Promise.all([firstPrompt, closing]);
		expect(faux.state.callCount).toBe(2);
		expect(closeResolved).toBe(true);
		expect(phases).toEqual(["settled-before", "settled-after", "trigger-start"]);

		await runtimeHost.dispose();
		expect(phases).toEqual(["settled-before", "settled-after", "trigger-start", "shutdown"]);
	});

	it("makes runtime disposal idempotent", async () => {
		let shutdownCount = 0;
		let abortObserved = false;
		let markResponseReached!: () => void;
		const responseReached = new Promise<void>((resolve) => {
			markResponseReached = resolve;
		});
		const { runtimeHost, faux } = await createRuntimeHost((pi) => {
			pi.on("session_shutdown", () => {
				shutdownCount++;
			});
		});
		faux.setResponses([
			(_context, options) =>
				new Promise((_resolve, reject) => {
					markResponseReached();
					options!.signal!.addEventListener(
						"abort",
						() => {
							abortObserved = true;
							reject(options!.signal!.reason);
						},
						{ once: true },
					);
				}),
		]);
		const runningPrompt = runtimeHost.session.prompt("active");
		await responseReached;

		await Promise.all([runtimeHost.dispose(), runtimeHost.dispose(), runningPrompt]);
		await runtimeHost.dispose();
		expect(abortObserved).toBe(true);
		expect(shutdownCount).toBe(1);
	});

	it("keeps reload closed after shutdown failure and permits a successful retry", async () => {
		let failShutdown = true;
		let cleanupCalls = 0;
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_shutdown", (event) => {
				event.onConfirmedShutdown?.(() => {
					cleanupCalls += 1;
				});
				if (failShutdown) throw new Error("worker stop failed");
			});
		});
		const session = runtimeHost.session;

		await expect(session.reload()).rejects.toMatchObject({ name: "AggregateError" });
		expect(cleanupCalls).toBe(0);
		await expect(session.prompt("must stay closed")).rejects.toThrow("no longer accepts new turns");

		failShutdown = false;
		await session.reload();
		expect(cleanupCalls).toBe(1);
		await expect(session.prompt("accepted after retry")).resolves.toBeUndefined();
	});

	it("accepts work enqueued by reload session_start after the replacement is ready", async () => {
		const errors: string[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_start", (event) => {
				if (event.reason === "reload") {
					pi.sendUserMessage("from reload session_start");
				}
			});
		});
		await runtimeHost.session.bindExtensions({
			onError: (error) => {
				if (error.event === "send_user_message") errors.push(error.error);
			},
		});

		await runtimeHost.session.reload();
		await runtimeHost.session.agent.waitForIdle();
		expect(errors).toEqual([]);
		expect(
			runtimeHost.session.getUserMessagesForForking().some((message) =>
				message.text.includes("from reload session_start"),
			),
		).toBe(true);
	});
});
