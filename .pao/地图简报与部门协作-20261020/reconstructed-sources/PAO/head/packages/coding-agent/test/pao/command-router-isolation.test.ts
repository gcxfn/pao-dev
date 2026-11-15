import { expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { addPaoSubcommand, listPaoSubcommands, paoHelpText, registerPaoCommand } from "../../src/pao/command-router.ts";
import { registerMemoryCommand, sessionMemory } from "../../src/pao/memory/session.ts";
import { buildPanelText } from "../../src/pao/panel/index.ts";

function api() {
	let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	const pi = {
		registerCommand: (_name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			handler = command.handler;
		},
		appendEntry: vi.fn(),
		sendMessage: vi.fn(),
	} as unknown as ExtensionAPI;
	registerPaoCommand(pi, () => {});
	return { pi, run: (args: string, ctx: unknown) => handler!(args, ctx) };
}

it("同进程两会话命令、帮助和面板独立，后注册不接走先注册者命令", async () => {
	const a = api();
	const b = api();
	const runA = vi.fn();
	const runB = vi.fn();
	addPaoSubcommand(a.pi, { name: "action", label: "甲", description: "甲命令", run: runA });
	addPaoSubcommand(b.pi, { name: "action", label: "乙", description: "乙命令", run: runB });
	await a.run("action", {});
	await b.run("action", {});
	expect(runA).toHaveBeenCalledWith(a.pi, "", {});
	expect(runB).toHaveBeenCalledWith(b.pi, "", {});
	expect(paoHelpText(a.pi, "missing")).toContain("甲命令");
	expect(paoHelpText(a.pi, "missing")).not.toContain("乙命令");
	expect(buildPanelText(b.pi)).toContain("乙命令");
	expect(buildPanelText(b.pi)).not.toContain("甲命令");
	expect(listPaoSubcommands(api().pi)).toEqual([]);
});

it("memory exclude 只修改发起会话，另一会话同号记忆不受影响", async () => {
	const a = api();
	const b = api();
	registerMemoryCommand(
		a.pi,
		() => undefined,
		() => "unused",
	);
	registerMemoryCommand(
		b.pi,
		() => undefined,
		() => "unused",
	);
	sessionMemory(a.pi).record([{ 内容: "甲事实", 记忆ID: "a" }], "测试");
	sessionMemory(b.pi).record([{ 内容: "乙事实", 记忆ID: "b" }], "测试");
	await a.run("memory exclude 1", { ui: { notify: vi.fn() } });
	expect(sessionMemory(a.pi).injected[0].排除).toBe(true);
	expect(sessionMemory(b.pi).injected[0].排除).toBe(false);
	expect(a.pi.appendEntry).toHaveBeenCalledTimes(1);
	expect(b.pi.appendEntry).not.toHaveBeenCalled();
});
