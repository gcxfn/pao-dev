import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";
import { parseRequestBudget, registerRuntimeControls } from "../../src/pao/runtime/index.ts";

const dirs: string[] = [];
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(home: string, id: string, env: NodeJS.ProcessEnv = {}) {
	const handlers = new Map<string, ((event: never, ctx: ExtensionContext) => unknown)[]>();
	const pi = {
		on(event: string, handler: (event: never, ctx: ExtensionContext) => unknown) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		sessionManager: { getSessionId: () => id },
		abort: vi.fn(),
		ui: { notify: vi.fn() },
	} as unknown as ExtensionContext;
	registerRuntimeControls(pi, { resolvePaoHome: () => home, env });
	const emit = async (event: string) => {
		const results: unknown[] = [];
		for (const fn of handlers.get(event) ?? []) results.push(await fn({} as never, ctx));
		return results;
	};
	cleanups.push(() => emit("session_shutdown"));
	return { emit, ctx };
}
it("双控制在正式注册钩子中同时阻断模型信号和工具，独立会话不受影响", async () => {
	const home = mkdtempSync(join(tmpdir(), "pao-runtime-wire-"));
	dirs.push(home);
	const first = setup(home, "甲");
	const second = setup(home, "甲");
	const other = setup(home, "乙");
	await first.emit("session_start");
	await second.emit("session_start");
	await other.emit("session_start");
	await first.emit("before_provider_request");
	await other.emit("before_provider_request");
	await expect(second.emit("before_provider_request")).rejects.toThrow("已有控制方");
	expect(second.ctx.abort).toHaveBeenCalledOnce();
	expect(await second.emit("tool_call")).toMatchObject([{ block: true }]);
	expect(first.ctx.abort).not.toHaveBeenCalled();
	await first.emit("session_shutdown");
	await second.emit("session_start");
	await second.emit("before_provider_request");
});
it("坏额度配置不能因为注册错误降级为无上限", async () => {
	const runtime = setup("unused", "worker", { PAO_ROLE: "worker", PAO_REQUEST_BUDGET: "{" });
	await expect(runtime.emit("before_provider_request")).rejects.toThrow();
	expect(runtime.ctx.abort).toHaveBeenCalledOnce();
	expect(await runtime.emit("tool_call")).toMatchObject([{ block: true }]);
	expect(() => parseRequestBudget(JSON.stringify({ path: "relative.json", requests: 600, concurrency: 2 }))).toThrow(
		"绝对",
	);
});
