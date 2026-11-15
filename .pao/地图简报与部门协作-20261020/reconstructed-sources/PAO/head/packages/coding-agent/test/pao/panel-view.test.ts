/**
 * /pao 可视化面板单测（命令统一批·B 线）:overlay 渲染结构（圆角边框/标题/Tab 分区条/
 * 命令列表/底部键位提示）、键位行为（↑↓/回车执行/Tab·←→ 切页/Esc 退出）、设置页
 * 翻转与数字循环的即时写盘＋notify 回执、写失败回滚、非 TUI 降级发文本页。
 * 经 openPaoPanel 的真实接线口捕获 overlay factory,再注入 fake tui/theme/keybindings
 * （panorama-worker-live.test.ts 同款手法,不做真键盘仿真;配置文件用临时目录 fixture）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Component, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import type { KeybindingsManager } from "../../src/core/keybindings.ts";
import type { Theme } from "../../src/modes/interactive/theme/theme.ts";
import { addPaoSubcommand, listPaoSubcommands, resetPaoSubcommandsForTest } from "../../src/pao/command-router.ts";
import { openPaoPanel, type PanelOptions } from "../../src/pao/panel/index.ts";
import { resolveWarmConfigPath } from "../../src/pao/panel/settings.ts";

const tempDirs: string[] = [];
let testPi: ExtensionAPI;
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	resetPaoSubcommandsForTest();
});
beforeEach(() => {
	resetPaoSubcommandsForTest();
	testPi = {} as ExtensionAPI;
	addPaoSubcommand(testPi, {
		name: "queue",
		label: "队列",
		description: "队列明细与在途任务",
		run: vi.fn(async () => {}),
	});
	addPaoSubcommand(testPi, {
		name: "status",
		label: "状态",
		description: "任务与部门聚合状态",
		run: vi.fn(async () => {}),
	});
});

function makeHome(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-panel-view-"));
	tempDirs.push(dir);
	return dir;
}

function fakeTui() {
	return { requestRender: vi.fn() } as unknown as TUI & { requestRender: ReturnType<typeof vi.fn> };
}

function fakeTheme() {
	return { fg: (_color: string, text: string) => text } as unknown as Theme;
}

function fakeKeybindings() {
	return {
		matches: (data: string, id: string) => {
			if (id === "tui.select.cancel") return data === "\x1b";
			if (id === "tui.select.up") return data === "\x1b[A";
			if (id === "tui.select.down") return data === "\x1b[B";
			if (id === "tui.select.confirm") return data === "\r";
			return false;
		},
	} as unknown as KeybindingsManager;
}

type PanelView = Component & { handleInput(data: string): void; render(width: number): string[] };

type CustomFactory = (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: () => void) => PanelView;

interface PanelTestCtx {
	mode: string;
	ui: {
		notify: ReturnType<typeof vi.fn>;
		custom: ReturnType<typeof vi.fn>;
	};
}

/** 走 openPaoPanel 真实口,捕获 overlay factory;返回 ctx 供回执断言 */
async function openPanel(options?: { resolvePaoHome?: PanelOptions["resolvePaoHome"]; ctx?: Partial<PanelTestCtx> }) {
	const pi = Object.assign(testPi, { sendMessage: vi.fn() });
	const ctx: PanelTestCtx = {
		mode: options?.ctx?.mode ?? "tui",
		ui: {
			notify: options?.ctx?.ui?.notify ?? vi.fn(),
			custom: options?.ctx?.ui?.custom ?? vi.fn(async (factory: CustomFactory) => void factory),
		},
	};
	const resolvePaoHome = options?.resolvePaoHome ?? (() => makeHome());
	await openPaoPanel(pi, ctx, { resolvePaoHome });
	const custom = ctx.ui.custom as ReturnType<typeof vi.fn> | undefined;
	const factory = custom?.mock.calls[0]?.[0] as CustomFactory | undefined;
	const done = vi.fn();
	const view = factory?.(fakeTui(), fakeTheme(), fakeKeybindings(), done);
	return { pi, ctx, done, view, factory };
}

describe("非 TUI 降级", () => {
	it("mode 非 tui → 发文本总览页,不开 overlay", async () => {
		const home = makeHome();
		const { pi, ctx } = await openPanel({ resolvePaoHome: () => home, ctx: { mode: "json" } });
		expect(ctx.ui.custom).not.toHaveBeenCalled();
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const arg = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(JSON.stringify(arg)).toContain("── pao 总入口 ──");
		expect(JSON.stringify(arg)).toContain("queue  队列");
	});

	it("tui 但 ui.custom 不可用 → 同样降级文本页", async () => {
		const pi = { sendMessage: vi.fn() } as unknown as ExtensionAPI & { sendMessage: ReturnType<typeof vi.fn> };
		const ctx = { mode: "tui", ui: { notify: vi.fn() } }; // ui 面上没有 custom
		await openPaoPanel(pi, ctx, { resolvePaoHome: () => makeHome() });
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});
});

describe("面板渲染结构", () => {
	it("圆角边框/标题/Tab 分区条/命令列表/键位提示齐全;各行可见宽度对齐", async () => {
		const { view } = await openPanel();
		const lines = view!.render(80);
		expect(lines[0]).toContain("╭");
		expect(lines[0]).toContain("pao 面板");
		expect(lines.at(-1)).toContain("╰");
		expect(lines.join("\n")).toContain("[命令]");
		expect(lines.join("\n")).toContain(" 设置 ");
		expect(lines.join("\n")).toContain("queue  队列");
		expect(lines.join("\n")).toContain("↑↓ 移动 · 回车/空格 确认 · Tab/←→ 切页 · Esc 退出");
		// 边框对齐:每行可见宽度一致（truncateToWidth 按 ANSI 无关的可见宽截断）
		const widths = new Set(lines.map((line) => visibleWidth(line)));
		expect(widths.size).toBe(1);
	});

	it("命令 description 截进右侧值列;无子命令时显示空态", async () => {
		const { view } = await openPanel();
		expect(view!.render(80).join("\n")).toContain("队列明细与在途任务");
		resetPaoSubcommandsForTest();
		expect(view!.render(80).join("\n")).toContain("（本会话未注册任何子命令）");
	});

	it("设置页:Tab 切入后 4 项设置与选中项 description 在场;←→ 也能切回", async () => {
		const { view } = await openPanel();
		view!.handleInput("\t");
		const rendered = view!.render(80).join("\n");
		expect(rendered).toContain("[设置]");
		expect(rendered).toContain("toast 通知");
		expect(rendered).toContain("上游并发上限");
		expect(rendered).toContain("自动召回");
		expect(rendered).toContain("自动交接");
		expect(rendered).toContain("即时生效"); // 布尔/数字项 description 如实标注生效时机
		view!.handleInput("\x1b[D");
		expect(view!.render(80).join("\n")).toContain("[命令]");
	});
});

describe("键位行为", () => {
	it("Esc 退出:done 一次;退出后按键忽略（不二次 done）", async () => {
		const { view, done } = await openPanel();
		view!.handleInput("\x1b");
		expect(done).toHaveBeenCalledTimes(1);
		view!.handleInput("q");
		expect(done).toHaveBeenCalledTimes(1);
	});

	it('命令页 ↑↓ 移动光标;回车＝先收面板再执行子命令 run(pi, "", ctx)', async () => {
		const { view, done, ctx } = await openPanel();
		view!.handleInput("\x1b[B"); // 移到 status
		const rendered = view!.render(80).join("\n");
		const queuePos = rendered.indexOf("queue  队列");
		const cursorOnStatus = rendered.indexOf("→ status");
		expect(cursorOnStatus).toBeGreaterThan(-1);
		expect(cursorOnStatus).toBeGreaterThan(queuePos);
		view!.handleInput("\r");
		expect(done).toHaveBeenCalledTimes(1);
		const subs = listPaoSubcommands(testPi);
		const runMock = subs[1].run as ReturnType<typeof vi.fn>;
		expect(runMock).toHaveBeenCalledWith(expect.anything(), "", ctx);
		// 先收面板再执行（子命令输出不进 overlay）
		expect(done.mock.invocationCallOrder[0]).toBeLessThan(runMock.mock.invocationCallOrder[0]);
	});

	it("设置页布尔翻转:空格把 toast 开→关,即时写盘＋notify 回执,其余键保留", async () => {
		const home = makeHome();
		mkdirSync(join(home, "pao配置"), { recursive: true });
		writeFileSync(resolveWarmConfigPath(home), `${JSON.stringify({ 空闲分钟: 45 }, null, "  ")}\n`);
		const { view, ctx } = await openPanel({ resolvePaoHome: () => home });
		view!.handleInput("\t"); // → 设置页
		view!.handleInput(" "); // 翻转第一项 toast 通知:开→关
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("已写入 保温.json"), "info");
		expect(JSON.parse(readFileSync(resolveWarmConfigPath(home), "utf8"))).toEqual({
			空闲分钟: 45,
			"toast 通知": false,
		});
	});

	it("设置页数字循环:默认→2→…→8→默认（删键）,逐档即时写盘", async () => {
		const home = makeHome();
		const { view } = await openPanel({ resolvePaoHome: () => home });
		view!.handleInput("\t");
		view!.handleInput("\x1b[B"); // 移到 上游并发上限
		for (const expected of [2, 3, 4, 6, 8]) {
			view!.handleInput(" ");
			const obj = JSON.parse(readFileSync(resolveWarmConfigPath(home), "utf8"));
			expect(obj.上游并发上限).toBe(expected);
		}
		view!.handleInput(" "); // 8→默认:删键
		const obj = JSON.parse(readFileSync(resolveWarmConfigPath(home), "utf8"));
		expect(obj).not.toHaveProperty("上游并发上限");
	});

	it("写失败回滚:记忆供应商.json 缺失时翻转自动召回 → error notify＋列表值还原", async () => {
		const home = makeHome(); // 无 记忆供应商.json
		const { view, ctx } = await openPanel({ resolvePaoHome: () => home });
		view!.handleInput("\t");
		view!.handleInput("\x1b[B");
		view!.handleInput("\x1b[B"); // 移到 自动召回
		view!.handleInput(" ");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("写入失败"), "error");
		expect(existsSync(join(home, "pao配置", "记忆供应商.json"))).toBe(false);
		// 列表值还原（SettingsList 回车已自行翻值,失败须还原本地态）
		expect(view!.render(80).join("\n")).not.toContain("自动召回  开");
	});
});
