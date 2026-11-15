/**
 * 真实 AgentSession + faux provider 的离线 print 宿主子进程。
 *
 * 输入：argv[2] 为临时目录。会话创建后用一个真实受控子进程承载后台工作；
 * 父测试收到 ready 后向这个子进程发送 SIGTERM，验证 print 宿主会先中止后台等待、
 * 释放端口、执行 session_shutdown 全停，再按信号码退出。全程不联网、不调用真实模型。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, InMemoryModelsStore } from "@earendil-works/pi-ai";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import {
	type BackgroundWorkPort,
	BackgroundWorkSignal,
	bindBackgroundWorkPort,
	getBackgroundWorkPort,
} from "../../src/core/background-work.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { runPrintMode } from "../../src/modes/print-mode.ts";

const root = process.argv[2];
if (!root) throw new Error("缺少临时目录参数");
const heartbeatPath = join(root, "worker.heartbeat");
const workerPidPath = join(root, "worker.pid");
const stoppedPath = join(root, "print.stopped");
mkdirSync(root, { recursive: true });

const worker = spawn(
	process.execPath,
	[
		"-e",
		`const { appendFileSync } = require("node:fs");
setInterval(() => appendFileSync(${JSON.stringify(heartbeatPath)}, "tick\\n"), 25);`,
	],
	{ stdio: "ignore", windowsHide: true },
);
writeFileSync(workerPidPath, `${worker.pid}\n`);
let workerExited = false;
worker.once("exit", () => {
	workerExited = true;
});
worker.once("error", (error) => {
	throw error;
});

const runtime = await ModelRuntime.create({
	credentials: AuthStorage.inMemory(),
	modelsStore: new InMemoryModelsStore(),
	modelsPath: null,
	allowModelNetwork: false,
});
const faux = fauxProvider({ tokensPerSecond: 1_000_000 });
runtime.registerNativeProvider(faux.provider);
await runtime.refresh({ allowNetwork: false });
faux.setResponses([fauxAssistantMessage("后台任务已受理")]);

const signal = new BackgroundWorkSignal();
let shutdownCount = 0;
const port: BackgroundWorkPort = {
	snapshot: () => ({ running: 1, unread: 0 }),
	waitForChange: async (abortSignal) => {
		while (!existsSync(heartbeatPath)) {
			abortSignal?.throwIfAborted();
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const observed = signal.currentVersion;
		process.send?.("ready");
		await signal.waitForChange(abortSignal, observed);
	},
	shutdown: () => {
		shutdownCount++;
		signal.shutdown();
	},
};

let observedIdentity = false;
const extensionFactory = (pi: ExtensionAPI) => {
	pi.on("session_start", (_event, ctx) => {
		observedIdentity = ctx.sessionManager === host.session.sessionManager;
		bindBackgroundWorkPort(ctx.sessionManager, port);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		const current = getBackgroundWorkPort(ctx.sessionManager);
		const workerAlive = !workerExited;
		writeFileSync(
			stoppedPath,
			`${JSON.stringify({
				identity: observedIdentity,
				portBound: current === port,
				workerAlive,
			})}\n`,
		);
		worker.kill();
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

const host = await createAgentSessionRuntime(createRuntime, {
	cwd: root,
	agentDir: root,
	sessionManager: SessionManager.inMemory(root),
});

process.once("message", (message) => {
	if (message === "sigterm") process.emit("SIGTERM");
});
process.once("exit", () => {
	writeFileSync(join(root, "print.port-shutdown"), `${shutdownCount}\n`);
});
const exitCode = await runPrintMode(host, { mode: "text", initialMessage: "派发后台任务" });
if (exitCode !== 0) process.exitCode = exitCode;
