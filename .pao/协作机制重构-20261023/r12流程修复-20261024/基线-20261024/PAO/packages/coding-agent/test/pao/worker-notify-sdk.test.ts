import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, getCurrentSystemPrompt, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { registerWorkerTools } from "../../src/pao/worker/index.ts";
import {
	createDispatchNotifySurface,
	type DispatchNotifySurface,
	sendDispatchNotifyWakeup,
} from "../../src/pao/worker/notify.ts";
import { WorkerRunner } from "../../src/pao/worker/runner.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";

it("真实 AgentSession 运行中 followUp 唤醒能看到通知正文，后续请求不重复注入", async () => {
	const root = mkdtempSync(join(tmpdir(), "pao-notify-sdk-"));
	const runner = new WorkerRunner();
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({ tokensPerSecond: 1_000_000 });
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false });
	let surface!: DispatchNotifySurface;
	let starts = 0;
	const prompts: string[] = [];
	const extensionsResult = await createTestExtensionsResult(
		[
			(pi) => {
				surface = createDispatchNotifySurface({
					resolvePaoHome: () => undefined,
					wakeUp: () => sendDispatchNotifyWakeup(pi),
				});
				registerWorkerTools(pi, {
					runner,
					notifySurface: surface,
					signals: false,
					resolveCardsDir: () => join(root, ".pao", "卡"),
					resolvePaoHome: () => root,
				});
				pi.on("before_agent_start", () => {
					starts++;
				});
			},
		],
		root,
	);
	const { session } = await createAgentSession({
		cwd: root,
		agentDir: root,
		modelRuntime: runtime,
		model: faux.getModel(),
		sessionManager: SessionManager.inMemory(root),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
		resourceLoader: createTestResourceLoader({ extensionsResult }),
	});
	await session.bindExtensions({});
	faux.setResponses([
		(context) => {
			prompts.push(getCurrentSystemPrompt(context.messages));
			surface.notify("[派卡被拒] 卡0002:真实离线通知原因");
			return fauxAssistantMessage("第一轮结束");
		},
		(context) => {
			prompts.push(getCurrentSystemPrompt(context.messages));
			return fauxAssistantMessage("收到通知");
		},
		(context) => {
			prompts.push(getCurrentSystemPrompt(context.messages));
			return fauxAssistantMessage("后续正常请求");
		},
	]);
	try {
		await session.prompt("开始离线验证");
		expect(faux.state.callCount).toBe(2);
		expect(starts).toBe(1); // followUp 没有再次触发 before_agent_start。
		expect(prompts[0]).not.toContain("真实离线通知原因");
		expect(prompts[1].split("真实离线通知原因")).toHaveLength(2);
		expect(surface.unreadCount()).toBe(0);
		await session.prompt("新的普通请求");
		expect(prompts[2]).not.toContain("真实离线通知原因");
	} finally {
		session.dispose();
		await runner.stopAll();
		rmSync(root, { recursive: true, force: true });
	}
});
