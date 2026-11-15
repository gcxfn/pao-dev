import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { createEventBus } from "../../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../../src/core/extensions/runner.ts";
import type {
	ExtensionActions,
	ExtensionContextActions,
	ExtensionError,
	ExtensionRuntime,
	ExtensionUIContext,
} from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { MinisterHost, type TeardownRecord } from "../../src/pao/host/host.ts";
import paoExtension from "../../src/pao/index.ts";
import { WorkerRunner } from "../../src/pao/worker/runner.ts";
import { createInMemoryModelRegistry } from "../model-runtime-test-utils.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const extensionActions: ExtensionActions = {
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

function contextActions(abort: () => void): ExtensionContextActions {
	return {
		getModel: () => undefined,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getSignal: () => undefined,
		abort,
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
		getScopedModels: () => [],
	};
}

async function realRunner(root: string, host: MinisterHost) {
	const runtime: ExtensionRuntime = createExtensionRuntime();
	const previousRole = process.env.PAO_ROLE;
	process.env.PAO_ROLE = "主控";
	let extension: Awaited<ReturnType<typeof loadExtensionFromFactory>>;
	try {
		extension = await loadExtensionFromFactory(
			(pi) =>
				paoExtension(pi, {
					resolvePaoHome: () => root,
					resolveProjectRoot: () => root,
					resolveCardsDir: () => join(root, ".pao", "卡"),
					host,
					runner: new WorkerRunner({ 证据目录: join(root, "证据") }),
				}),
			root,
			createEventBus(),
			runtime,
		);
	} finally {
		if (previousRole === undefined) delete process.env.PAO_ROLE;
		else process.env.PAO_ROLE = previousRole;
	}
	const sessionManager = SessionManager.inMemory(root, { id: "shutdown-window" });
	const runner = new ExtensionRunner(
		[extension],
		runtime,
		root,
		sessionManager,
		await createInMemoryModelRegistry(AuthStorage.inMemory()),
	);
	const abort = vi.fn();
	runner.bindCore(extensionActions, contextActions(abort));
	runner.setUIContext({ notify: vi.fn() } as unknown as ExtensionUIContext, "rpc");
	const errors: ExtensionError[] = [];
	runner.onError((error) => errors.push(error));
	return { runner, errors, abort };
}

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "pao-runtime-shutdown-"));
	roots.push(value);
	return value;
}

describe("会话控制关闭窗口", () => {
	it("真实主控业务关闭活动仍持有控制权，关闭完成后迟到请求继续拒绝", async () => {
		const home = root();
		let runner: ExtensionRunner | undefined;
		let requestDuringStop: Promise<unknown> | undefined;
		let resolveStopping!: () => void;
		const stopped = new Promise<void>((resolve) => {
			resolveStopping = resolve;
		});
		class ShutdownHost extends MinisterHost {
			override async stopAll(_reason?: string): Promise<TeardownRecord[]> {
				// 这是关闭生命周期边界模拟：宿主停在真实 worker 业务关闭处理器内，
				// 不声称对应 r10 的三个通知唤醒。
				resolveStopping();
				requestDuringStop = runner!.emitBeforeProviderRequest({ phase: "business-shutdown" });
				return [];
			}
		}
		const wired = await realRunner(home, new ShutdownHost());
		runner = wired.runner;
		await wired.runner.emit({ type: "session_start", reason: "startup" });
		await wired.runner.emitBeforeProviderRequest({ phase: "running" });
		await wired.runner.emit({ type: "session_shutdown", reason: "quit" });
		await stopped;
		await requestDuringStop;

		expect(wired.errors).not.toContainEqual(expect.objectContaining({ error: "会话控制权不匹配" }));
		expect(wired.abort).not.toHaveBeenCalled();

		await wired.runner.emitBeforeProviderRequest({ phase: "late" });
		expect(wired.errors).toContainEqual(
			expect.objectContaining({ event: "before_provider_request", error: "会话控制权不匹配" }),
		);
		expect(wired.abort).toHaveBeenCalledOnce();
	});

	it("重复关闭保持业务清理，关闭后工具调用和模型请求仍拒绝", async () => {
		const home = root();
		let stopCalls = 0;
		class ShutdownHost extends MinisterHost {
			override async stopAll(_reason?: string): Promise<TeardownRecord[]> {
				stopCalls++;
				return [];
			}
		}
		const wired = await realRunner(home, new ShutdownHost());
		await wired.runner.emit({ type: "session_start", reason: "startup" });
		await wired.runner.emit({ type: "session_shutdown", reason: "quit" });
		await wired.runner.emit({ type: "session_shutdown", reason: "quit" });

		expect(stopCalls).toBeGreaterThanOrEqual(2);
		expect(
			await wired.runner.emitToolCall({
				type: "tool_call",
				toolCallId: "late",
				toolName: "read",
				input: { path: "late.txt" },
			}),
		).toMatchObject({ block: true, reason: expect.stringContaining("会话控制权不匹配") });
		await wired.runner.emitBeforeProviderRequest({ phase: "late" });
		expect(wired.errors).toContainEqual(
			expect.objectContaining({ event: "before_provider_request", error: "会话控制权不匹配" }),
		);
		expect(wired.abort).toHaveBeenCalledOnce();
	});
});
