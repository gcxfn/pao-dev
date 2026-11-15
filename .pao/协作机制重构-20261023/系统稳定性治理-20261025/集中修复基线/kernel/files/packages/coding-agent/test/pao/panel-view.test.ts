/**
 * /pao 可视化面板单测（命令统一批·B 线）:overlay 渲染结构（圆角边框/标题/Tab 分区条/
 * 命令列表/底部键位提示）、键位行为（↑↓/回车执行/Tab·←→ 切页/Esc 退出）、设置页
 * 翻转与数字循环的即时写盘＋notify 回执、写失败回滚、非 TUI 降级发文本页。
 * 经 openPaoPanel 的真实接线口捕获 overlay factory,再注入 fake tui/theme/keybindings
 * （panorama-worker-live.test.ts 同款手法,不做真键盘仿真;配置文件用临时目录 fixture）。
 */
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Component, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import type { KeybindingsManager } from "../../src/core/keybindings.ts";
import type { Theme } from "../../src/modes/interactive/theme/theme.ts";
import { addPaoSubcommand, listPaoSubcommands, resetPaoSubcommandsForTest } from "../../src/pao/command-router.ts";
import { openPaoPanel, type PanelOptions } from "../../src/pao/panel/index.ts";
import { resolveWarmConfigPath } from "../../src/pao/panel/settings.ts";
import { startControl } from "../../src/pao/workflow/control.ts";
import { parseRecipe } from "../../src/pao/workflow/recipe.ts";
import { parseFrontmatter } from "../../src/utils/frontmatter.ts";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const workflowFreshHarness = vi.hoisted(() => ({
	gate: null as Promise<void> | null,
	calls: 0,
	async wait() {
		this.calls++;
		if (this.gate) await this.gate;
	},
}));

vi.mock("../../src/pao/status/workflow-instances.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/pao/status/workflow-instances.ts")>();
	return {
		...actual,
		scanInstanceSignalsFresh: async (paoHome: string) => {
			await workflowFreshHarness.wait();
			return actual.scanInstanceSignalsFresh(paoHome);
		},
	};
});

const tempDirs: string[] = [];
let testPi: ExtensionAPI;
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	resetPaoSubcommandsForTest();
	workflowFreshHarness.gate = null;
	workflowFreshHarness.calls = 0;
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

function registerProject(home: string, projectRoot: string): void {
	writeFileSync(
		join(home, "项目清单.md"),
		`| 项目名 | 项目根 | 首次服务 | 最近服务 |\n| --- | --- | --- | --- |\n| 面板项目 | ${projectRoot} | 2026-10-10 10:00 | 2026-10-10 10:00 |\n`,
		"utf8",
	);
}

function writePanelRecipe(home: string, version: 1 | 2, name: string): void {
	const recipe = {
		...(version === 2 ? { 版本: 2 } : {}),
		名字: name,
		参数: [],
		节点: [
			{ 名字: "把关", 部门: "规划部", 目标: "确认目标", 验收: "完成", ...(version === 2 ? { 人工确认: true } : {}) },
		],
	};
	mkdirSync(join(home, "工作流"), { recursive: true });
	writeFileSync(join(home, "工作流", `${name}.md`), `---\n${stringify(recipe)}---\n`, "utf8");
}

function fakeTui(rows = 24) {
	return {
		terminal: { rows },
		requestRender: vi.fn(),
	} as unknown as TUI & { terminal: { rows: number }; requestRender: ReturnType<typeof vi.fn> };
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
		select?: ReturnType<typeof vi.fn>;
		input?: ReturnType<typeof vi.fn>;
	};
}

/** 走 openPaoPanel 真实口,捕获 overlay factory;返回 ctx 供回执断言 */
async function openPanel(options?: {
	resolvePaoHome?: PanelOptions["resolvePaoHome"];
	rows?: number;
	ctx?: { mode?: string; ui?: Partial<PanelTestCtx["ui"]> };
}) {
	const pi = Object.assign(testPi, { sendMessage: vi.fn() });
	const ctx: PanelTestCtx = {
		mode: options?.ctx?.mode ?? "tui",
		ui: {
			notify: options?.ctx?.ui?.notify ?? vi.fn(),
			custom: options?.ctx?.ui?.custom ?? vi.fn(async (factory: CustomFactory) => void factory),
			select: options?.ctx?.ui?.select,
			input: options?.ctx?.ui?.input,
		},
	};
	const resolvePaoHome = options?.resolvePaoHome ?? (() => makeHome());
	await openPaoPanel(pi, ctx, { resolvePaoHome });
	const custom = ctx.ui.custom as ReturnType<typeof vi.fn> | undefined;
	const factory = custom?.mock.calls[0]?.[0] as CustomFactory | undefined;
	const done = vi.fn();
	const tui = fakeTui(options?.rows ?? 24);
	const view = factory?.(tui, fakeTheme(), fakeKeybindings(), done);
	return { pi, ctx, done, view, factory, tui };
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
	it("面板已打开后新注册或替换命令会更新列表，搜索、resize 和 invalidate 后仍可执行", async () => {
		const { view, tui, ctx } = await openPanel({ rows: 12 });
		view!.render(80);
		const replacement = vi.fn(async () => {});
		addPaoSubcommand(testPi, { name: "status", label: "新状态", description: "替换描述", run: replacement });
		addPaoSubcommand(testPi, {
			name: "extra",
			label: "额外命令",
			description: "新增描述",
			run: vi.fn(async () => {}),
		});
		expect(view!.render(80).join("\n")).toContain("命令 1/3");
		tui.terminal.rows = 24;
		expect(view!.render(80).join("\n")).toContain("新状态");
		expect(view!.render(80).join("\n")).toContain("额外命令");
		view!.handleInput("新");
		tui.terminal.rows = 24;
		view!.invalidate();
		expect(view!.render(100).join("\n")).toContain("替换描述");
		view!.handleInput("\r");
		await Promise.resolve();
		expect(replacement).toHaveBeenCalledWith(expect.anything(), "", ctx);
	});
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

	it("命令搜索支持中文标签;无结果后退格可恢复列表", async () => {
		const { view } = await openPanel();
		view!.handleInput("队");
		let rendered = view!.render(80).join("\n");
		expect(rendered).toContain("queue  队列");
		expect(rendered).not.toContain("status  状态");
		view!.handleInput("无");
		rendered = view!.render(80).join("\n");
		expect(rendered).toContain("无匹配命令");
		view!.handleInput("\x7f");
		rendered = view!.render(80).join("\n");
		expect(rendered).toContain("queue  队列");
	});

	it("终端为 12/16/24 行时列表按高度收缩,resize 后仍不越界且保留底部提示", async () => {
		for (let index = 0; index < 12; index++) {
			addPaoSubcommand(testPi, {
				name: `cmd-${index}`,
				label: `命令${index}`,
				description: `用于短终端视口测试的第 ${index} 条命令`,
				run: vi.fn(async () => {}),
			});
		}
		const { view, tui } = await openPanel({ rows: 12 });
		for (const rows of [12, 16, 24]) {
			tui.terminal.rows = rows;
			const lines = view!.render(80);
			expect(lines.length).toBeLessThanOrEqual(rows);
			expect(lines.join("\n")).toContain("Esc 退出");
		}
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

	it("设置页发现非法 JSON 时显示原因且拒绝覆盖原文件", async () => {
		const home = makeHome();
		mkdirSync(join(home, "pao配置"), { recursive: true });
		const bad = "{ 不是合法 json";
		writeFileSync(resolveWarmConfigPath(home), bad, "utf8");
		const { view, ctx } = await openPanel({ resolvePaoHome: () => home });
		view!.handleInput("\t");
		const rendered = view!.render(80).join("\n");
		expect(rendered).toContain("异常");
		expect(rendered).toContain("面板不会覆盖原文件");
		view!.handleInput(" ");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("保留原文件"), "error");
		expect(readFileSync(resolveWarmConfigPath(home), "utf8")).toBe(bad);
	});

	it("记忆供应商配置缺少必需字段时显示字段错误并禁止翻转", async () => {
		const home = makeHome();
		mkdirSync(join(home, "pao配置"), { recursive: true });
		const path = join(home, "pao配置", "记忆供应商.json");
		writeFileSync(path, "{}\n", "utf8");
		const { view, ctx } = await openPanel({ resolvePaoHome: () => home });
		view!.handleInput("\t");
		view!.handleInput("\x1b[B");
		view!.handleInput("\x1b[B");
		const rendered = view!.render(80).join("\n");
		expect(rendered).toMatch(/配置缺少字段「供应\s*商」/);
		view!.handleInput(" ");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("保留原文件"), "error");
		expect(readFileSync(path, "utf8")).toBe("{}\n");
	});

	it("记忆供应商配置非法 JSON 时显示安全原因且不回显原文", async () => {
		const home = makeHome();
		mkdirSync(join(home, "pao配置"), { recursive: true });
		const path = join(home, "pao配置", "记忆供应商.json");
		const bad = '{"供应商":';
		writeFileSync(path, bad, "utf8");
		const { view, ctx } = await openPanel({ resolvePaoHome: () => home });
		view!.handleInput("\t");
		view!.handleInput("\x1b[B");
		view!.handleInput("\x1b[B");
		const rendered = view!.render(80).join("\n");
		expect(rendered).toContain("异常");
		expect(rendered).toContain("配置不是合法 JSON");
		expect(rendered).not.toContain(bad);
		view!.handleInput(" ");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("保留原文件"), "error");
		expect(readFileSync(path, "utf8")).toBe(bad);
	});

	it("记忆供应商配置合法但开关关闭时显示关,缺失时显示未配置", async () => {
		const home = makeHome();
		mkdirSync(join(home, "pao配置"), { recursive: true });
		const path = join(home, "pao配置", "记忆供应商.json");
		writeFileSync(path, '{"供应商":"fixture-vendor","自动召回":false,"自动交接":false}\n', "utf8");
		const { view } = await openPanel({ resolvePaoHome: () => home });
		view!.handleInput("\t");
		let rendered = view!.render(80).join("\n");
		expect(rendered).toContain("自动召回      关");
		expect(rendered).toContain("自动交接      关");

		const missing = makeHome();
		const missingPanel = await openPanel({ resolvePaoHome: () => missing });
		missingPanel.view!.handleInput("\t");
		rendered = missingPanel.view!.render(80).join("\n");
		expect(rendered).toContain("自动召回      未配置");
		expect(rendered).toContain("自动交接      未配置");
	});

	it("一次刷新投影出保温与记忆的合法字段", async () => {
		const home = makeHome();
		mkdirSync(join(home, "pao配置"), { recursive: true });
		writeFileSync(
			resolveWarmConfigPath(home),
			'{ "toast 通知": false, "上游并发上限": 3.9, "空闲分钟": 45 }\n',
			"utf8",
		);
		writeFileSync(
			join(home, "pao配置", "记忆供应商.json"),
			'{"供应商":"fixture-vendor","自动召回":true,"自动交接":false}\n',
			"utf8",
		);
		const { view } = await openPanel({ resolvePaoHome: () => home });
		view!.handleInput("\t");
		const rendered = view!.render(80).join("\n");
		expect(rendered).toMatch(/toast 通知\s+关/);
		expect(rendered).toMatch(/上游并发上限\s+3/);
		expect(rendered).toMatch(/自动召回\s+开/);
		expect(rendered).toMatch(/自动交接\s+关/);
	});

	it("一次设置快照对保温与记忆配置文件各只读取一次", async () => {
		const home = makeHome();
		mkdirSync(join(home, "pao配置"), { recursive: true });
		writeFileSync(resolveWarmConfigPath(home), '{"上游并发上限":3}\n', "utf8");
		const memoryPath = join(home, "pao配置", "记忆供应商.json");
		writeFileSync(memoryPath, '{"供应商":"fixture-vendor","自动召回":true}\n', "utf8");
		const readMock = vi.mocked(fs.readFileSync);
		readMock.mockClear();
		await openPanel({ resolvePaoHome: () => home });
		const warmReads = readMock.mock.calls.filter(([path]) => path === resolveWarmConfigPath(home));
		const memoryReads = readMock.mock.calls.filter(([path]) => path === memoryPath);
		expect(warmReads).toHaveLength(1);
		expect(memoryReads).toHaveLength(1);
	});

	it("保温上游并发上限小于 1 时仍按原字段校验拒绝", async () => {
		const home = makeHome();
		mkdirSync(join(home, "pao配置"), { recursive: true });
		writeFileSync(resolveWarmConfigPath(home), '{"上游并发上限":0}\n', "utf8");
		const { view, ctx } = await openPanel({ resolvePaoHome: () => home });
		view!.handleInput("\t");
		const rendered = view!.render(80).join("\n");
		expect(rendered).toMatch(/上游并发上限\s+异常/);
		expect(rendered).toContain("配置字段「上游并发上限」格式错误");
		view!.handleInput("\x1b[B");
		view!.handleInput(" ");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("保留原文件"), "error");
		expect(JSON.parse(readFileSync(resolveWarmConfigPath(home), "utf8"))).toEqual({ 上游并发上限: 0 });
	});

	it("记忆供应商路径不可读时显示异常,不暴露系统错误原文", async () => {
		const home = makeHome();
		mkdirSync(join(home, "pao配置", "记忆供应商.json"), { recursive: true });
		const { view } = await openPanel({ resolvePaoHome: () => home });
		view!.handleInput("\t");
		view!.handleInput("\x1b[B");
		view!.handleInput("\x1b[B");
		const rendered = view!.render(80).join("\n");
		expect(rendered).toContain("自动召回      异常");
		expect(rendered).toContain("配置无法读取");
		expect(rendered).not.toContain("EISDIR");
	});

	it("写失败回滚:记忆供应商.json 缺失时翻转自动召回 → error notify＋列表值还原", async () => {
		const home = makeHome(); // 无 记忆供应商.json
		const { view, ctx } = await openPanel({ resolvePaoHome: () => home });
		view!.handleInput("\t");
		view!.handleInput("\x1b[B");
		view!.handleInput("\x1b[B"); // 移到 自动召回
		expect(view!.render(80).join("\n")).toContain("自动召回      未配置");
		view!.handleInput(" ");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("写入失败"), "error");
		expect(existsSync(join(home, "pao配置", "记忆供应商.json"))).toBe(false);
		// 列表值还原（SettingsList 回车已自行翻值,失败须还原本地态）
		expect(view!.render(80).join("\n")).not.toContain("自动召回  开");
	});
});

describe("工作流引导", () => {
	it("查看进度会等待延迟的当前实例读取，读取完成前不提前执行", async () => {
		const home = makeHome();
		const projectRoot = makeHome();
		const cardsDir = join(projectRoot, ".pao", "延迟读取", "卡");
		mkdirSync(cardsDir, { recursive: true });
		registerProject(home, projectRoot);
		writePanelRecipe(home, 1, "延迟流");
		writeFileSync(
			join(projectRoot, ".pao", "延迟读取", "工作流实例-延迟流.md"),
			[
				"---",
				"工作流: 延迟流",
				`卡目录: ${JSON.stringify(cardsDir)}`,
				"启动: 2026-10-23 10:00",
				"状态: 运行中",
				"参数: {}",
				"节点: []",
				"---",
				"",
			].join("\n"),
			"utf8",
		);
		let releaseRead: (() => void) | undefined;
		workflowFreshHarness.gate = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});
		const run = vi.fn(async () => {});
		addPaoSubcommand(testPi, { name: "flow", label: "工作流", description: "启动、查看和确认工作流", run });
		const select = vi
			.fn()
			.mockResolvedValueOnce("查看进度")
			.mockResolvedValueOnce("延迟流")
			.mockImplementationOnce(async (_title: string, options: string[]) => options[0]);
		const { view } = await openPanel({
			resolvePaoHome: () => home,
			ctx: { ui: { select, input: vi.fn() } },
		});
		view!.handleInput("工");
		view!.handleInput("\r");
		await vi.waitFor(() => expect(workflowFreshHarness.calls).toBe(1));
		expect(run).not.toHaveBeenCalled();
		workflowFreshHarness.gate = null;
		releaseRead!();
		await vi.waitFor(() => expect(run).toHaveBeenCalled());
		expect(workflowFreshHarness.calls).toBe(2);
		expect(run).toHaveBeenCalledWith(
			expect.anything(),
			`see 延迟流 cards_dir=${encodeURIComponent(cardsDir)}`,
			expect.anything(),
		);
	});

	it("查看进度先选择实际实例,并把含空格的卡目录编码传给命令", async () => {
		const home = makeHome();
		const projectRoot = makeHome();
		const cardsDir = join(projectRoot, ".pao", "任务 带空格", "卡");
		mkdirSync(cardsDir, { recursive: true });
		registerProject(home, projectRoot);
		writePanelRecipe(home, 1, "流A");
		const manifestDir = join(projectRoot, ".pao", "任务 带空格");
		writeFileSync(
			join(manifestDir, "工作流实例-流A.md"),
			[
				"---",
				"工作流: 流A",
				`卡目录: ${JSON.stringify(cardsDir)}`,
				"启动: 2026-10-10 10:00",
				"状态: 运行中",
				"参数: {}",
				"节点: []",
				"---",
				"",
			].join("\n"),
			"utf8",
		);
		const run = vi.fn(async () => {});
		addPaoSubcommand(testPi, { name: "flow", label: "工作流", description: "启动、查看和确认工作流", run });
		const select = vi
			.fn()
			.mockResolvedValueOnce("查看进度")
			.mockResolvedValueOnce("流A")
			.mockImplementationOnce(async (_title: string, options: string[]) => options[0]);
		const input = vi.fn();
		const { view } = await openPanel({
			resolvePaoHome: () => home,
			ctx: { ui: { select, input } },
		});
		view!.handleInput("工");
		view!.handleInput("\r");
		await vi.waitFor(() => expect(run).toHaveBeenCalled());
		expect(run).toHaveBeenCalledWith(
			expect.anything(),
			`see 流A cards_dir=${encodeURIComponent(cardsDir)}`,
			expect.anything(),
		);
	});

	it("人工确认选择 v2 实例并传递实例号、轮次和卡目录", async () => {
		const home = makeHome();
		const projectRoot = makeHome();
		const cardsDir = join(projectRoot, ".pao", "任务 带空格", "卡");
		mkdirSync(cardsDir, { recursive: true });
		registerProject(home, projectRoot);
		writePanelRecipe(home, 2, "流B");
		const recipePath = join(home, "工作流", "流B.md");
		const recipe = parseRecipe(readFileSync(recipePath, "utf8"), recipePath);
		await startControl(recipe, {}, { cardsDir, ownerSessionId: "owner" });
		const controlPath = join(dirname(cardsDir), "工作流实例-流B.md");
		const parsed = parseFrontmatter<Record<string, unknown>>(readFileSync(controlPath, "utf8"));
		const control = parsed.frontmatter as Record<string, any>;
		control.节点[0].部长会话 = "minister";
		control.节点[0].拆解结束 = true;
		control.节点[0].零卡理由 = "测试零卡";
		writeFileSync(controlPath, `---\n${stringify(control)}---\n`, "utf8");
		const instance = String(control.实例);
		const run = vi.fn(async () => {});
		addPaoSubcommand(testPi, { name: "flow", label: "工作流", description: "启动、查看和确认工作流", run });
		const select = vi
			.fn()
			.mockResolvedValueOnce("人工确认")
			.mockResolvedValueOnce("流B")
			.mockImplementationOnce(async (_title: string, options: string[]) => options[0])
			.mockResolvedValueOnce("把关");
		const input = vi.fn();
		const { view } = await openPanel({
			resolvePaoHome: () => home,
			ctx: { ui: { select, input } },
		});
		view!.handleInput("工");
		view!.handleInput("\r");
		await vi.waitFor(() => expect(run).toHaveBeenCalled());
		expect(run).toHaveBeenCalledWith(
			expect.anything(),
			`confirm 流B 把关 ${instance} 1 cards_dir=${encodeURIComponent(cardsDir)}`,
			expect.anything(),
		);
	});
});
