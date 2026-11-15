import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai/compat";
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
import { DISPATCH_NOTIFY_SECTION, DISPATCH_NOTIFY_WAKEUP_TEXT } from "../../src/pao/worker/notify.ts";
import { WorkerRunner } from "../../src/pao/worker/runner.ts";
import { createInMemoryModelRegistry } from "../model-runtime-test-utils.ts";

/**
 * 两个独立终态宿主的装配隔离。
 *
 * SessionManager、ExtensionRunner、PAO 扩展实例、文件和关闭生命周期均为真实对象；
 * 模型只提供固定对象与 id，不调用供应商，也不验证模型推理。
 */

const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) {
		await cleanup().catch(() => {
			// 正文断言失败时仍尝试停止两个实例；收尾错误不覆盖首要失败。
		});
	}
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

function tempRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), `pao-w2-dual-${prefix}-`));
	roots.push(root);
	return root;
}

function extensionActions(wakeups: string[]): ExtensionActions {
	return {
		sendMessage: (message) => {
			const first = message.content[0];
			if (first && typeof first !== "string" && first.type === "text") wakeups.push(first.text);
		},
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

class CountingRunner extends WorkerRunner {
	stopCalls = 0;

	override async stopAll(): ReturnType<WorkerRunner["stopAll"]> {
		this.stopCalls++;
		return super.stopAll();
	}
}

class CountingHost extends MinisterHost {
	stopCalls = 0;

	override async stopAll(reason?: string): Promise<TeardownRecord[]> {
		this.stopCalls++;
		return super.stopAll(reason);
	}
}

async function createHarness(input: { id: string; modelId: string; root: string }): Promise<{
	runner: ExtensionRunner;
	sessionManager: SessionManager;
	host: CountingHost;
	workerRunner: CountingRunner;
	wakeups: string[];
	models: string[];
}> {
	const wakeups: string[] = [];
	const models: string[] = [];
	const host = new CountingHost();
	const workerRunner = new CountingRunner({ 证据目录: join(input.root, "证据") });
	const runtime: ExtensionRuntime = createExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		(pi) => {
			paoExtension(pi, {
				resolvePaoHome: () => input.root,
				resolveProjectRoot: () => input.root,
				resolveCardsDir: () => join(input.root, ".pao", "卡"),
				host,
				runner: workerRunner,
			});
			pi.on("before_agent_start", (_event, ctx) => {
				models.push(ctx.model?.id ?? "");
			});
		},
		input.root,
		createEventBus(),
		runtime,
	);
	const sessionManager = SessionManager.inMemory(input.root, { id: input.id });
	const model = {
		provider: "fixed-fake",
		id: input.modelId,
		contextWindow: 4_096,
	} as Model<string>;
	const runner = new ExtensionRunner(
		[extension],
		runtime,
		input.root,
		sessionManager,
		await createInMemoryModelRegistry(AuthStorage.inMemory()),
	);
	runner.bindCore(extensionActions(wakeups), contextActions(model));
	runner.setUIContext({ notify: () => {} } as unknown as ExtensionUIContext, "rpc");
	await runner.emit({ type: "session_start", reason: "startup" });

	const harness = { runner, sessionManager, host, workerRunner, wakeups, models };
	cleanups.push(async () => {
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		await host.stopAll("测试清理");
	});
	return harness;
}

async function notifyDepartment(host: CountingHost, root: string, department: string): Promise<void> {
	const key = `department:${department}`;
	host.trackSupervision({
		key,
		kind: "department",
		department,
		projectRoot: root,
	});
	await host.finishSupervision({
		key,
		outcome: "completed",
		detail: `${department}结果只属于本会话`,
	});
}

describe("W2 双会话隔离", () => {
	it("不同 SessionManager 的模型、后台端口、通知、监督和全停互不串用", async () => {
		const rootA = tempRoot("a");
		const rootB = tempRoot("b");
		const previousRole = process.env.PAO_ROLE;
		process.env.PAO_ROLE = "主控";
		let a: Awaited<ReturnType<typeof createHarness>>;
		let b: Awaited<ReturnType<typeof createHarness>>;
		try {
			a = await createHarness({ id: "session-a", modelId: "model-a", root: rootA });
			b = await createHarness({ id: "session-b", modelId: "model-b", root: rootB });
		} finally {
			if (previousRole === undefined) delete process.env.PAO_ROLE;
			else process.env.PAO_ROLE = previousRole;
		}

		const aPort = getBackgroundWorkPort(a.sessionManager);
		const bPort = getBackgroundWorkPort(b.sessionManager);
		expect(aPort).toBeDefined();
		expect(bPort).toBeDefined();
		expect(aPort).not.toBe(bPort);

		await notifyDepartment(a.host, rootA, "A部门");
		expect(a.wakeups.filter((message) => message === DISPATCH_NOTIFY_WAKEUP_TEXT)).toHaveLength(1);
		expect(b.wakeups.filter((message) => message === DISPATCH_NOTIFY_WAKEUP_TEXT)).toHaveLength(0);
		const aNotice = await a.runner.emitBeforeAgentStart("读取 A 通知", undefined, { cwd: rootA });
		const bWithoutANotice = await b.runner.emitBeforeAgentStart("B 不应收到 A 通知", undefined, { cwd: rootB });
		expect(aNotice.systemPromptOptions.sections[DISPATCH_NOTIFY_SECTION]).toContain("A部门结果只属于本会话");
		expect(bWithoutANotice.systemPromptOptions.sections[DISPATCH_NOTIFY_SECTION]).toBeUndefined();

		await notifyDepartment(b.host, rootB, "B部门");
		expect(b.wakeups.filter((message) => message === DISPATCH_NOTIFY_WAKEUP_TEXT)).toHaveLength(1);
		const bNotice = await b.runner.emitBeforeAgentStart("读取 B 通知", undefined, { cwd: rootB });
		const aWithoutBNotice = await a.runner.emitBeforeAgentStart("A 不应收到 B 通知", undefined, { cwd: rootA });
		expect(bNotice.systemPromptOptions.sections[DISPATCH_NOTIFY_SECTION]).toContain("B部门结果只属于本会话");
		expect(aWithoutBNotice.systemPromptOptions.sections[DISPATCH_NOTIFY_SECTION]).toBeUndefined();

		a.host.trackSupervision({
			key: "department:A待关闭",
			kind: "department",
			department: "A待关闭",
			projectRoot: rootA,
		});
		b.host.trackSupervision({
			key: "department:B仍运行",
			kind: "department",
			department: "B仍运行",
			projectRoot: rootB,
		});
		await a.runner.emit({ type: "session_shutdown", reason: "quit" });

		expect(a.workerRunner.stopCalls).toBe(1);
		expect(b.workerRunner.stopCalls).toBe(0);
		expect(a.host.stopCalls).toBeGreaterThan(0);
		expect(b.host.stopCalls).toBe(0);
		expect(getBackgroundWorkPort(a.sessionManager)).toBeUndefined();
		expect(getBackgroundWorkPort(b.sessionManager)).toBeDefined();
		expect(a.host.markSupervisionHandled("department:A待关闭")).toBe(false);
		expect(b.host.markSupervisionHandled("department:B仍运行")).toBe(true);

		const bChanged = bPort!.waitForChange();
		await notifyDepartment(b.host, rootB, "A关闭后B部门");
		await expect(bChanged).resolves.toBeUndefined();
		const bAfterAClose = await b.runner.emitBeforeAgentStart("A 关闭后读取 B", undefined, { cwd: rootB });
		expect(bAfterAClose.systemPromptOptions.sections[DISPATCH_NOTIFY_SECTION]).toContain(
			"A关闭后B部门结果只属于本会话",
		);
		expect(b.wakeups.filter((message) => message === DISPATCH_NOTIFY_WAKEUP_TEXT)).toHaveLength(2);
		expect(a.models.length).toBeGreaterThan(0);
		expect(b.models.length).toBeGreaterThan(0);
		expect(a.models.every((id) => id === "model-a")).toBe(true);
		expect(b.models.every((id) => id === "model-b")).toBe(true);

		await b.runner.emit({ type: "session_shutdown", reason: "quit" });
		expect(b.workerRunner.stopCalls).toBe(1);
		expect(getBackgroundWorkPort(b.sessionManager)).toBeUndefined();
	});
});
