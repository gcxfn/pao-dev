import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { normalizeBuildSystemPromptOptions } from "../../src/core/system-prompt.ts";
import paoExtension from "../../src/pao/index.ts";
import { WorkerRunner } from "../../src/pao/worker/runner.ts";

const roots: string[] = [];
const runners: WorkerRunner[] = [];
afterEach(async () => {
	for (const runner of runners.splice(0)) await runner.stopAll();
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function assemble(workflow: boolean) {
	const parent = process.env.PAO_HOME;
	if (!parent || !isAbsolute(parent)) throw new Error("测试须显式设置隔离 PAO_HOME");
	mkdirSync(parent, { recursive: true });
	const root = mkdtempSync(join(parent, "minister-tools-"));
	roots.push(root);
	mkdirSync(join(root, "pao配置"));
	writeFileSync(
		join(root, "pao配置", "档位.json"),
		JSON.stringify({ 档位: [{ 名: "fixture", provider: "fixture", model: "offline", thinkingLevel: "low" }] }),
	);
	vi.stubEnv("PAO_HOME", root);
	vi.stubEnv("PAO_ROLE", "minister");
	vi.stubEnv(
		"PAO_WORKFLOW_MINISTER",
		workflow
			? JSON.stringify({ 名字: "fixture", 实例: "instance", 节点: "规划", 轮次: 1, owner: "owner", cardsDir: root })
			: "",
	);
	const tools = new Map<string, { name: string }>(
		["read", "grep", "find", "ls", "bash", "edit", "write", "tool_search"].map((name) => [name, { name }]),
	);
	const handlers = new Map<string, Array<(...args: any[]) => any>>();
	let active = [...tools.keys()];
	const pi = {
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
		on: (event: string, handler: (...args: any[]) => any) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		getAllTools: () => [...tools.values()],
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active = names.filter((name) => tools.has(name));
		},
		registerCommand() {},
		registerVirtualModel() {},
		registerMessageRenderer() {},
		registerEntryRenderer() {},
		registerToolRenderer() {},
		registerShortcut() {},
		registerFlag() {},
		registerProvider() {},
		registerMcpServer() {},
		unregisterProvider() {},
		unregisterVirtualModel() {},
		sendMessage() {},
		appendEntry() {},
	} as unknown as ExtensionAPI;
	const runner = new WorkerRunner();
	runners.push(runner);
	paoExtension(pi, { runner, resolvePaoHome: () => root });
	return { pi, root, handlers };
}

test("工作流部长在请求前只能看到只读与节点工具，后装扩展不能让禁止工具重新进入声明", async () => {
	const { pi, root, handlers } = assemble(true);
	// 模拟基准激活器在 session_start 把原生及管理工具全部重新加入。
	pi.setActiveTools(pi.getAllTools().map((tool) => tool.name));
	const event = {
		systemPromptOptions: normalizeBuildSystemPromptOptions({ cwd: root, selectedTools: pi.getActiveTools() }),
	};
	const context = { cwd: root, hasUI: false, sessionManager: { getSessionId: () => "minister", getBranch: () => [] } };
	for (const handler of handlers.get("before_agent_start") ?? []) await handler(event, context);
	const active = pi.getActiveTools();
	expect(active).toEqual(expect.arrayContaining(["read", "grep", "find", "ls", "pao_minister_submit_cards"]));
	for (const prohibited of ["bash", "edit", "write", "tool_search", "pao_query_kb", "pao_worktree_create"])
		expect(active).not.toContain(prohibited);
	expect(event.systemPromptOptions.selectedTools).toEqual(active);
	for (const name of active) {
		for (const guard of handlers.get("tool_call") ?? []) {
			const result = await guard({ toolName: name, input: {} }, context);
			expect(result?.block, name).not.toBe(true);
		}
	}
	const blocked = await Promise.all(
		(handlers.get("tool_call") ?? []).map((handler) => handler({ toolName: "bash", input: {} }, context)),
	);
	expect(blocked.some((result) => result?.block)).toBe(true);
});

test("普通部长仍使用宿主选择的执行工具", () => {
	const { pi } = assemble(false);
	expect(pi.getActiveTools()).toContain("bash");
	expect(pi.getActiveTools()).toContain("edit");
});
