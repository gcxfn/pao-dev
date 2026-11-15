/**
 * /pao 面板（裸 `/pao` 的入口,命令统一批·B 线）。
 *
 * 形态（omp settings 同款骨架,文案全中文,不整块照搬）:圆角边框 overlay 面板——顶部标题
 * ＋Tab 分区条（「命令」「设置」两页）＋设置列表（每行 光标＋label＋右侧当前值,列表下方
 * 固定显示选中项 description）＋最底一行 dim 键位提示。
 *
 * - 「命令」页:列本会话可用子命令（listPaoSubcommands）,回车＝先收面板再执行该子命令
 *   的 run(pi, "", ctx)（ctx 透传）。行渲染自绘——SettingsList 的回车语义是循环值,
 *   不适配动作执行。
 * - 「设置」页:嵌 pi-tui SettingsList（↑↓/回车/空格 翻转循环/Esc 交互现成;外层拦截
 *   Esc/Tab/←→,其余输入委托）。4 个设置项读写见 panel/settings.ts;改动即时写盘＋
 *   notify 如实回执,写失败回滚列表值（SettingsList 回车已自行翻值,失败须还原本地态）。
 * - 键位:↑↓ 移动、回车/空格 确认或翻转、Tab/←→ 切页、Esc 退出（tui.select.cancel,
 *   panorama worker-live 同款）。
 * - 非 TUI 运行态（ctx.mode !== "tui"）或 ctx.ui.custom 不可用/运行期抛错 → 降级发
 *   文本总览页（buildPanelText,原占位逻辑保留为非 TUI 降级路径）。
 */

import { existsSync } from "node:fs";
import {
	type Component,
	type Focusable,
	type SettingItem,
	SettingsList,
	type SettingsListTheme,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { listPaoSubcommands, type PaoSubcommand } from "../command-router.ts";
import { readWarmConfig, toastEnabled } from "../host/config.ts";
import { loadMemoryVendorConfig } from "../memory/memory-vendor.ts";
import {
	resolveMemoryHomeConfigPath,
	resolveWarmConfigPath,
	writeMemorySetting,
	writeWarmSetting,
} from "./settings.ts";

/** 接线层注入面（可视化面板用配置解析定位设置文件）。 */
export interface PanelOptions {
	resolvePaoHome: () => string;
}

/** 面板的 ctx 结构面（TUI 运行态＋ui 面;接线层传来的 unknown cast 后按需取用） */
interface PanelCtx {
	mode?: string;
	ui?: {
		notify?: (message: string, type?: "info" | "warning" | "error") => void;
		custom?: <T>(
			factory: (
				tui: TUI,
				theme: Theme,
				keybindings: KeybindingsManager,
				done: () => void,
			) => Component & { dispose?(): void },
			options?: { overlay?: boolean },
		) => Promise<T>;
	};
}

/** 上游并发上限的循环档位:「默认」＝键缺失＝不启用配置层;其余为账号级硬顶值 */
const CONCURRENCY_VALUES = ["默认", "2", "3", "4", "6", "8"] as const;

/** 面板最大宽度（宽终端下不横铺;窄终端让位给实际宽度） */
const PANEL_MAX_WIDTH = 80;

/** 面板文本页（非 TUI 降级形态;纯函数便于测试）。 */
export function buildPanelText(pi: ExtensionAPI): string {
	const subs = listPaoSubcommands(pi);
	const rows = subs.map((sub) => `- ${sub.name}  ${sub.label}——${sub.description}`);
	return [
		"── pao 总入口 ──",
		...(rows.length > 0 ? rows : ["（本会话未注册任何子命令）"]),
		"",
		"裸敲 /pao 打开本面板；/pao <子命令> 直达功能。",
	].join("\n");
}

/** 4 个设置项的当前值快照（读盘口径与各功能读取函数同源,见 settings.ts 头注释） */
function readSettingsState(paoHome: string): {
	toast: boolean;
	上游并发上限: number | undefined;
	自动召回: boolean;
	自动交接: boolean;
} {
	let memory: { 自动召回?: boolean; 自动交接?: boolean } | undefined;
	try {
		memory = loadMemoryVendorConfig(resolveMemoryHomeConfigPath(paoHome));
	} catch {
		// 配置坏:列表按全关展示（现有读取函数同款降级,不炸面板）
	}
	return {
		toast: toastEnabled(paoHome),
		上游并发上限: readWarmConfig(paoHome).上游并发上限,
		自动召回: memory?.自动召回 === true,
		自动交接: memory?.自动交接 === true,
	};
}

/** 设置页 4 个 SettingItem（description 如实标注生效时机与已知副作用） */
function buildSettingItems(paoHome: string): { items: SettingItem[]; values: Record<string, string> } {
	const state = readSettingsState(paoHome);
	const warmExists = existsWarmConfig(paoHome);
	const memoryExists = existsMemoryConfig(paoHome);
	const items: SettingItem[] = [
		{
			id: "toast 通知",
			label: "toast 通知",
			currentValue: state.toast ? "开" : "关",
			values: ["开", "关"],
			description:
				"后台批/人工门的系统 toast 提醒（缺省开,显式关才静默）。每次发送时读盘,改动即时生效。" +
				(warmExists
					? "保温.json 已存在,写入只改本键。"
					: "注意:保温.json 尚不存在,首次写入会创建它——该文件存在即视为保温功能启用,其余保温键按机械缺省（如空闲 30 分钟）。"),
		},
		{
			id: "上游并发上限",
			label: "上游并发上限",
			currentValue: state.上游并发上限 === undefined ? "默认" : String(state.上游并发上限),
			values: [...CONCURRENCY_VALUES],
			description:
				"全部活进程＋在途名额的账号级硬顶（跨部门合并计）。「默认」＝不启用配置层（派单缺省 2 照旧）。" +
				"每次派发时读盘,改动即时生效。" +
				(warmExists
					? "保温.json 已存在,写入只改本键。"
					: "保温.json 尚不存在时,首次写入会创建它（同上,文件存在即视为保温功能启用）。"),
		},
		{
			id: "自动召回",
			label: "自动召回",
			currentValue: state.自动召回 ? "开" : "关",
			values: ["开", "关"],
			description:
				"每轮对话前按用户输入自动召回 top3 相关记忆（缺省关）。开关在会话启动时一次定型,重启会话后生效;" +
				"且需已配置记忆供应商" +
				(memoryExists ? "。" : "——记忆供应商.json 尚不存在,面板拒绝代建（先在文件里配置「供应商」等字段）。"),
		},
		{
			id: "自动交接",
			label: "自动交接",
			currentValue: state.自动交接 ? "开" : "关",
			values: ["开", "关"],
			description:
				"上下文压缩时把交接摘要写进记忆供应商（缺省关）。同「自动召回」:重启会话后生效" +
				(memoryExists ? "。" : ";记忆供应商.json 尚不存在,面板拒绝代建。"),
		},
	];
	const values: Record<string, string> = {};
	for (const item of items) values[item.id] = item.currentValue;
	return { items, values };
}

function existsWarmConfig(paoHome: string): boolean {
	// 仅探测存在性;不读内容——坏 JSON 的如实报错交给写入口径
	return existsSync(resolveWarmConfigPath(paoHome));
}

function existsMemoryConfig(paoHome: string): boolean {
	return existsSync(resolveMemoryHomeConfigPath(paoHome));
}

/**
 * 可视化面板本体（overlay 组件）。渲染无缓存,每帧全量重算;
 * 输入先过外层（Esc/Tab/←→/命令页键位）,设置页其余输入委托给内嵌 SettingsList。
 */
class PaoPanelView implements Component, Focusable {
	private readonly pi: ExtensionAPI;
	private readonly ctx: PanelCtx;
	private readonly paoHome: string;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: () => void;
	private readonly settingsList: SettingsList;
	private readonly settingsValues: Record<string, string>;
	private activeTab: "命令" | "设置" = "命令";
	private commandIndex = 0;
	private exited = false;
	#focused = false;

	constructor(
		pi: ExtensionAPI,
		ctx: PanelCtx,
		options: PanelOptions,
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: () => void,
	) {
		this.pi = pi;
		this.ctx = ctx;
		this.paoHome = options.resolvePaoHome();
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		const { items, values } = buildSettingItems(this.paoHome);
		this.settingsValues = values;
		this.settingsList = new SettingsList(
			items,
			8,
			this.#settingsTheme(),
			(id, newValue) => this.#onSettingChange(id, newValue),
			() => this.#finish(), // 防御兜底:Esc 理论上已被外层拦截,漏到内嵌也按退出语义收口
		);
	}

	get focused(): boolean {
		return this.#focused;
	}

	set focused(value: boolean) {
		this.#focused = value;
	}

	/** 键盘收口:Esc 退出;Tab/←→ 切页;命令页 ↑↓/回车/空格 自理;设置页其余键委托 SettingsList。 */
	handleInput(data: string): void {
		if (this.exited) return;
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.#finish();
			return;
		}
		if (data === "\t" || data === "\x1b[C" || data === "\x1b[D") {
			this.activeTab = this.activeTab === "命令" ? "设置" : "命令";
			this.tui.requestRender();
			return;
		}
		if (this.activeTab === "命令") {
			this.#handleCommandInput(data);
			return;
		}
		this.settingsList.handleInput(data);
	}

	/** overlay 主题/配置失效时重绘（本组件渲染无缓存,只需请求重绘） */
	invalidate(): void {
		if (this.exited) return;
		this.tui.requestRender();
	}

	dispose(): void {
		// 无定时器资源;仅防 dispose 后再吃键
		this.exited = true;
	}

	render(width: number): string[] {
		const panelWidth = Math.max(24, Math.min(width, PANEL_MAX_WIDTH));
		const inner = panelWidth - 4; // "│ " 与 " │" 各占 2
		const border = (text: string) => this.theme.fg("border", text);
		const title = "─ pao 面板 ";
		const top = border(`╭${title}${"─".repeat(panelWidth - 2 - visibleWidth(title))}╮`);
		const bottom = border(`╰${"─".repeat(panelWidth - 2)}╯`);
		const frame = (line: string) => `${border("│")} ${truncateToWidth(line, inner, "", true)} ${border("│")}`;
		const lines = [top, ...this.#renderBody(inner).map(frame), bottom];
		return lines.map((line) => truncateToWidth(line, width));
	}

	#renderBody(inner: number): string[] {
		const lines: string[] = [];
		lines.push(this.#renderTabBar());
		lines.push(this.theme.fg("dim", "─".repeat(Math.max(1, inner))));
		lines.push("");
		if (this.activeTab === "命令") lines.push(...this.#renderCommands(inner));
		else lines.push(...this.settingsList.render(inner));
		lines.push("");
		lines.push(this.theme.fg("dim", "↑↓ 移动 · 回车/空格 确认 · Tab/←→ 切页 · Esc 退出"));
		return lines;
	}

	#renderTabBar(): string {
		const tab = (name: string, active: boolean) =>
			active ? this.theme.fg("accent", `[${name}]`) : this.theme.fg("muted", ` ${name} `);
		return ` ${tab("命令", this.activeTab === "命令")}   ${tab("设置", this.activeTab === "设置")}`;
	}

	#renderCommands(inner: number): string[] {
		const subs = listPaoSubcommands(this.pi);
		if (subs.length === 0) return [this.theme.fg("dim", "（本会话未注册任何子命令）")];
		const maxLabel = Math.max(...subs.map((sub) => visibleWidth(`${sub.name}  ${sub.label}`)));
		return subs.map((sub, i) => {
			const selected = i === this.commandIndex;
			const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
			const labelPlain = `${sub.name}  ${sub.label}`;
			const label = selected ? this.theme.fg("accent", labelPlain) : labelPlain;
			const padded = label + " ".repeat(Math.max(0, maxLabel - visibleWidth(labelPlain)));
			const valueWidth = Math.max(0, inner - 2 - maxLabel - 2);
			const value = this.theme.fg(selected ? "accent" : "dim", truncateToWidth(sub.description, valueWidth, "…"));
			return truncateToWidth(`${prefix}${padded}  ${value}`, inner);
		});
	}

	#handleCommandInput(data: string): void {
		const subs = listPaoSubcommands(this.pi);
		if (subs.length === 0) return;
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.commandIndex = (this.commandIndex - 1 + subs.length) % subs.length;
			this.tui.requestRender();
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.commandIndex = (this.commandIndex + 1) % subs.length;
			this.tui.requestRender();
		} else if (this.keybindings.matches(data, "tui.select.confirm") || data === " ") {
			void this.#runSubcommand(subs[this.commandIndex]);
		}
	}

	/** 回车执行子命令:先收面板（输出不进 overlay）,再透传 ctx 执行;失败 notify 不炸会话 */
	async #runSubcommand(sub: PaoSubcommand): Promise<void> {
		this.#finish();
		try {
			await sub.run(this.pi, "", this.ctx);
		} catch (error) {
			this.ctx.ui?.notify?.(
				`pao ${sub.name} 执行失败:${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	}

	/** SettingsList 的主题映射（按传入 theme 显式配色,不依赖全局 theme——jiti 双模块缓存坑） */
	#settingsTheme(): SettingsListTheme {
		return {
			label: (text: string, selected: boolean) => (selected ? this.theme.fg("accent", text) : text),
			value: (text: string, selected: boolean) =>
				selected ? this.theme.fg("accent", text) : this.theme.fg("muted", text),
			description: (text: string) => this.theme.fg("dim", text),
			cursor: this.theme.fg("accent", "→ "),
			hint: () => "", // SettingsList 内置英文提示行压成空行,底部键位提示由面板自绘中文版
		};
	}

	/** 设置项翻转/循环后的落盘口:写盘→notify 如实回执;失败回滚列表值＋error notify */
	#onSettingChange(id: string, newValue: string): void {
		const previous = this.settingsValues[id] ?? newValue;
		try {
			if (id === "toast 通知" || id === "上游并发上限") {
				const value: boolean | number | undefined =
					id === "toast 通知" ? newValue === "开" : newValue === "默认" ? undefined : Number(newValue);
				writeWarmSetting(this.paoHome, id, value);
				const shown = id === "上游并发上限" && value === undefined ? "默认,已删除该键" : String(value);
				this.#notify(`已写入 保温.json（${id}=${shown}）`);
			} else {
				writeMemorySetting(this.paoHome, id as "自动召回" | "自动交接", newValue === "开");
				this.#notify(`已写入 记忆供应商.json（${id}=${newValue === "开" ? "true" : "false"};重启会话后生效）`);
			}
			this.settingsValues[id] = newValue;
		} catch (error) {
			this.settingsList.updateValue(id, previous); // SettingsList 回车已自行翻值,失败还原本地态
			this.settingsValues[id] = previous;
			this.#notify(`${id} 写入失败:${error instanceof Error ? error.message : String(error)}`, "error");
		}
		this.tui.requestRender();
	}

	#notify(message: string, type: "info" | "warning" | "error" = "info"): void {
		this.ctx.ui?.notify?.(message, type);
	}

	#finish(): void {
		if (this.exited) return;
		this.exited = true;
		this.done();
	}
}

/**
 * 裸 /pao handler:TUI 运行态且 ctx.ui.custom 可用 → overlay 可视化面板;
 * 否则（json 模式/无 ui 面/overlay 运行期抛错）降级发文本总览页。
 */
export async function openPaoPanel(pi: ExtensionAPI, ctxRaw: unknown, options: PanelOptions): Promise<void> {
	const ctx = (ctxRaw ?? {}) as PanelCtx;
	const sendTextPage = (): void => {
		pi.sendMessage({
			customType: "pao-panel",
			content: [{ type: "text", text: buildPanelText(pi) }],
			display: true,
		});
	};
	if (ctx.mode !== "tui" || typeof ctx.ui?.custom !== "function") {
		sendTextPage();
		return;
	}
	try {
		await ctx.ui.custom(
			(tui, theme, keybindings, done) => new PaoPanelView(pi, ctx, options, tui, theme, keybindings, done),
			{ overlay: true },
		);
	} catch {
		// overlay 环境不可用（运行期抛错）:落回文本页,不炸会话
		sendTextPage();
	}
}
