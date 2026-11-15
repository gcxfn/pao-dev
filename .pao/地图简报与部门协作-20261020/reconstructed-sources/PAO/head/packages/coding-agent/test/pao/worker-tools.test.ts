import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { installExitHooks, registerWorkerTools } from "../../src/pao/worker/index.ts";
import { type StopProof, WorkerRunner } from "../../src/pao/worker/runner.ts";

const tempDirs: string[] = [];
const scripts: string[] = [];
const shutdowns: (() => unknown)[] = [];
const disposers: (() => void)[] = [];

afterEach(async () => {
	for (const shutdown of shutdowns.splice(0)) await shutdown();
	for (const dispose of disposers.splice(0)) dispose();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	scripts.length = 0;
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-worker-tools-"));
	tempDirs.push(dir);
	return dir;
}

/** 常驻假 worker:发一条事件后挂住不退 */
const LONG_SCRIPT = `
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "工作中" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, stopReason: "end" } }));
setInterval(() => {}, 1000);
`;

function writeScript(): string {
	const file = join(tempDir(), `fake-${scripts.length}.js`);
	scripts.push(file);
	writeFileSync(file, LONG_SCRIPT, "utf8");
	return file;
}

/** 可观察 stopAll 调用的运行器(签发逻辑不伪造,走真实路径) */
class SpyRunner extends WorkerRunner {
	stopAllCalls = 0;

	override async stopAll(): Promise<StopProof> {
		this.stopAllCalls++;
		return super.stopAll();
	}
}

interface Captured {
	tools: { name: string; execute: (...args: unknown[]) => Promise<{ content: { text?: string }[] }> }[];
	handlers: Map<string, (...args: unknown[]) => unknown>;
	pi: ExtensionAPI;
}

function capturePi(): Captured {
	const captured: Captured = { tools: [], handlers: new Map(), pi: undefined as unknown as ExtensionAPI };
	captured.pi = {
		registerTool: (tool: { name: string }) => captured.tools.push(tool as never),
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			captured.handlers.set(event, handler);
			if (event === "session_shutdown") shutdowns.push(() => handler());
			return () => {};
		},
	} as unknown as ExtensionAPI;
	return captured;
}

function waitUntil(fn: () => boolean, timeoutMs = 5000): Promise<boolean> {
	return new Promise((resolve) => {
		const start = Date.now();
		const tick = (): void => {
			if (fn() || Date.now() - start > timeoutMs) resolve(fn());
			else setTimeout(tick, 50);
		};
		tick();
	});
}

function makeWorkspaceWithCard(): string {
	const workspace = tempDir();
	mkdirSync(join(workspace, "卡"), { recursive: true });
	writeFileSync(
		join(workspace, "卡", "卡0007-任务.md"),
		"---\ngoal: 做事\nattempt: 1\nstatus: in_progress\n---\n\n## 回执(尝试1)\n进行到一半\n",
		"utf8",
	);
	return workspace;
}

describe("registerWorkerTools:工具 + 主会话退出钩子", () => {
	it("shutdown 返回停止 Promise，真完成后移除旧运行器钩子，新运行器可派发", async () => {
		let finish: () => void = () => {};
		const delayed = new Promise<void>((resolve) => {
			finish = resolve;
		});
		class DelayedRunner extends WorkerRunner {
			override async stopAll(): Promise<StopProof> {
				await delayed;
				return super.stopAll();
			}
		}
		const captured = capturePi();
		const before = process.listenerCount("beforeExit");
		registerWorkerTools(captured.pi, { runner: new DelayedRunner(), signals: false });
		let completed = false;
		const shutdown = Promise.resolve(captured.handlers.get("session_shutdown")!()).then(() => {
			completed = true;
		});
		await Promise.resolve();
		expect(completed).toBe(false);
		expect(process.listenerCount("beforeExit")).toBe(before + 1);
		finish();
		await shutdown;
		expect(process.listenerCount("beforeExit")).toBe(before);
		const next = new WorkerRunner();
		const script = join(tempDir(), "once.js");
		writeFileSync(script, "process.exit(0);\n");
		expect(
			(await next.run({ 卡号: "0001", 提示词: "新会话", 命令: process.execPath, 参数: [script] })).exitCode,
		).toBe(0);
	});
	it("注册 pao_inventory/pao_stop_background/pao_dispatch_card/pao_terminate_card;session_shutdown 钩子调 stopAll", async () => {
		const captured = capturePi();
		const runner = new SpyRunner();
		registerWorkerTools(captured.pi, { runner, signals: false });

		expect(captured.tools.map((t) => t.name)).toEqual([
			"pao_inventory",
			"pao_stop_background",
			"pao_dispatch_card",
			"pao_terminate_card",
		]);
		expect(captured.handlers.has("session_shutdown")).toBe(true);
		expect(runner.stopAllCalls).toBe(0);

		// 主会话退出(quit/reload/new/resume/fork)→ 停本轮进程树
		await captured.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, {} as never);
		expect(runner.stopAllCalls).toBe(1);
	});

	it("pao_stop_background:真停运行中的 worker 并返回已停清单;无进程时如实说", async () => {
		const captured = capturePi();
		const runner = new SpyRunner();
		registerWorkerTools(captured.pi, { runner, signals: false });
		const stopTool = captured.tools.find((t) => t.name === "pao_stop_background")!;

		// 拉起一个真实常驻 worker 再走工具停止(签发走真实路径,不伪造凭据)
		void runner.run({ 卡号: "0001", 提示词: "长任务", 命令: process.execPath, 参数: [writeScript()] });
		await waitUntil(() => runner.isRunning("0001"));

		const result = (await stopTool.execute("id", {}, undefined, undefined, {} as never)) as {
			content: { text: string }[];
		};
		expect(runner.stopAllCalls).toBe(1);
		expect(result.content[0].text).toContain("已停 1 个进程");
		expect(result.content[0].text).toContain("pid=");
		expect(result.content[0].text).toContain("卡0001");
		if (process.platform === "win32") expect(result.content[0].text).toContain("taskkill");
		// 停完再停:不谎报
		const result2 = (await stopTool.execute("id", {}, undefined, undefined, {} as never)) as {
			content: { text: string }[];
		};
		expect(result2.content[0].text).toContain("无运行中的后台 worker");
	});

	it("pao_inventory:只读盘点结果进工具回执", async () => {
		const captured = capturePi();
		registerWorkerTools(captured.pi, { runner: new WorkerRunner(), signals: false });
		const tool = captured.tools.find((t) => t.name === "pao_inventory")!;
		const workspace = makeWorkspaceWithCard();

		const result = (await tool.execute("id", { workspace: workspace }, undefined, undefined, {} as never)) as {
			content: { text: string }[];
		};
		expect(result.content[0].text).toContain("卡0007");
		expect(result.content[0].text).toContain("in_progress");
	});
});

describe("installExitHooks", () => {
	it("幂等:同一 runner 重复注册,beforeExit 只挂一次", () => {
		const runner = new WorkerRunner();
		const before = process.listenerCount("beforeExit");
		disposers.push(installExitHooks(runner));
		installExitHooks(runner);
		expect(process.listenerCount("beforeExit")).toBe(before + 1);
	});
});
