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
	Input,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	type SettingsListTheme,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { listPaoSubcommands, type PaoSubcommand } from "../command-router.ts";
import { loadMemoryVendorConfig, type MemoryVendorConfig } from "../memory/memory-vendor.ts";
import { readJsonRaw } from "../shared/json.ts";
import { type InstanceSignalRow, scanInstanceSignals } from "../status/workflow-instances.ts";
import type { WorkflowRecipe } from "../workflow/recipe.ts";
import { listRecipes, loadRecipe } from "../workflow/recipe.ts";
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
		select?: (title: string, options: string[], opts?: unknown) => Promise<string | undefined>;
		input?: (title: string, placeholder?: string, opts?: unknown) => Promise<string | undefined>;
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

/** 终端行数从当前 stdout 读取；测试或非终端宿主没有 rows 时按常见 24 行处理。 */
function terminalRows(): number {
	const rows = Number((process.stdout as NodeJS.WriteStream).rows);
	return Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 24;
}

/** 读取当前 TUI 终端行数。overlay 可能运行在非 stdout 的终端上，优先使用 TUI 自己的尺寸。 */
function tuiRows(tui: TUI): number {
	const rows = Number((tui as TUI & { terminal?: { rows?: number } }).terminal?.rows);
	if (Number.isFinite(rows) && rows > 0) return Math.floor(rows);
	return terminalRows();
}

type ConfigState = {
	status: "missing" | "valid" | "invalid" | "unreadable";
	reason?: string;
};

type InspectedConfig = { state: ConfigState; value?: Record<string, unknown> };

/** 只读取配置形状和开关字段，不把参数对象（可能含凭证）显示到界面。 */
function inspectConfig(
	path: string,
	name: string,
	fields: Record<string, (value: unknown) => boolean>,
	required: string[] = [],
): InspectedConfig {
	if (!existsSync(path)) return { state: { status: "missing" } };
	let raw: unknown;
	try {
		raw = readJsonRaw(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: { status: "missing" } };
		const code = (error as NodeJS.ErrnoException).code;
		return {
			state: {
				status: code === "EACCES" || code === "EPERM" ? "unreadable" : "invalid",
				reason: safeConfigReason(name, error),
			},
		};
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { state: { status: "invalid", reason: `${name} 配置顶层应为 JSON 对象` } };
	}
	const value = raw as Record<string, unknown>;
	for (const [field, valid] of Object.entries(fields)) {
		if (
			(required.includes(field) && value[field] === undefined) ||
			(value[field] !== undefined && !valid(value[field]))
		) {
			return { state: { status: "invalid", reason: `${name} 配置字段「${field}」格式错误` } };
		}
	}
	return { state: { status: "valid" }, value };
}

/** 配置解析失败只展示固定类别，不把 JSON 解析器可能带出的原文片段回显到 TUI。 */
function safeConfigReason(name: string, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const missing = message.match(/缺少字段「([^」]+)」/);
	if (missing) return `${name} 配置缺少字段「${missing[1]}」`;
	if (/权限|permission|access|EACCES|EPERM|EISDIR|拒绝访问|无法读取/i.test(message))
		return `${name} 配置无法读取（权限或路径不可读）`;
	if (/字段|应为|布尔|字符串|对象/.test(message)) return `${name} 配置字段格式错误`;
	if (/JSON|json|解析|parse|token|position/i.test(message)) return `${name} 配置不是合法 JSON`;
	return `${name} 配置无法读取`;
}

function warmConfigState(path: string): InspectedConfig {
	return inspectConfig(path, "保温", {
		"toast 通知": (value) => typeof value === "boolean",
		上游并发上限: (value) => typeof value === "number" && Number.isFinite(value) && value >= 1,
	});
}

function memoryConfigState(path: string): { state: ConfigState; value?: MemoryVendorConfig } {
	try {
		const value = loadMemoryVendorConfig(path);
		return value ? { state: { status: "valid" }, value } : { state: { status: "missing" } };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const unreadable = /无法读取|权限|permission|access|EACCES|EPERM|EISDIR|拒绝访问/i.test(message);
		return {
			state: {
				status: unreadable ? "unreadable" : "invalid",
				reason: safeConfigReason("记忆供应商", error),
			},
		};
	}
}

function stateHint(state: ConfigState, path: string, name: string): string {
	if (state.status === "missing") return `${name}配置未配置；位置：${path}`;
	if (state.status === "valid") return "";
	return `${state.reason ?? `${name}配置异常`}；位置：${path}；面板不会覆盖原文件`;
}

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

/** 4 个设置项的当前值快照（一次整读各文件,字段口径见 settings.ts 头注释） */
function readSettingsState(paoHome: string): {
	toast: boolean;
	上游并发上限: number | undefined;
	自动召回: boolean;
	自动交接: boolean;
	warm: ConfigState;
	memory: ConfigState;
} {
	const warmRead = warmConfigState(resolveWarmConfigPath(paoHome));
	const memoryRead = memoryConfigState(resolveMemoryHomeConfigPath(paoHome));
	const warm = warmRead.value;
	const memory = memoryRead.value;
	const concurrency = warm?.上游并发上限;
	return {
		toast: warm?.["toast 通知"] !== false,
		上游并发上限:
			typeof concurrency === "number" && Number.isFinite(concurrency) && concurrency >= 1
				? Math.floor(concurrency)
				: undefined,
		自动召回: memory?.自动召回 === true,
		自动交接: memory?.自动交接 === true,
		warm: warmRead.state,
		memory: memoryRead.state,
	};
}

/** 设置页 4 个 SettingItem（description 如实标注生效时机与已知副作用） */
function buildSettingItems(paoHome: string): {
	items: SettingItem[];
	values: Record<string, string>;
	states: Record<string, ConfigState>;
} {
	const state = readSettingsState(paoHome);
	const warmPath = resolveWarmConfigPath(paoHome);
	const memoryPath = resolveMemoryHomeConfigPath(paoHome);
	const warmExists = state.warm.status !== "missing";
	const memoryExists = state.memory.status !== "missing";
	const warmError =
		state.warm.status === "invalid" || state.warm.status === "unreadable"
			? stateHint(state.warm, warmPath, "保温")
			: "";
	const memoryError = stateHint(state.memory, memoryPath, "记忆供应商");
	const toastValue =
		state.warm.status === "invalid" || state.warm.status === "unreadable" ? "异常" : state.toast ? "开" : "关";
	const capValue =
		state.warm.status === "invalid" || state.warm.status === "unreadable"
			? "异常"
			: state.上游并发上限 === undefined
				? "默认"
				: String(state.上游并发上限);
	const recallValue =
		state.memory.status === "missing"
			? "未配置"
			: state.memory.status === "invalid" || state.memory.status === "unreadable"
				? "异常"
				: state.自动召回
					? "开"
					: "关";
	const handoffValue =
		state.memory.status === "missing"
			? "未配置"
			: state.memory.status === "invalid" || state.memory.status === "unreadable"
				? "异常"
				: state.自动交接
					? "开"
					: "关";
	const memoryToggleValues =
		state.memory.status === "missing"
			? ["未配置"]
			: state.memory.status === "invalid" || state.memory.status === "unreadable"
				? ["异常"]
				: ["开", "关"];
	const items: SettingItem[] = [
		{
			id: "toast 通知",
			label: "toast 通知",
			currentValue: toastValue,
			values: ["开", "关"],
			description:
				"后台批/人工门的系统 toast 提醒（缺省开,显式关才静默）。每次发送时读盘,改动即时生效。" +
				(warmError ||
					(warmExists
						? "保温.json 已存在,写入只改本键。"
						: "注意:保温.json 尚不存在,首次写入会创建它——该文件存在即视为保温功能启用,其余保温键按机械缺省（如空闲 30 分钟）。")),
		},
		{
			id: "上游并发上限",
			label: "上游并发上限",
			currentValue: capValue,
			values: [...CONCURRENCY_VALUES],
			description:
				"全部活进程＋在途名额的账号级硬顶（跨部门合并计）。「默认」＝不启用配置层（派单缺省 2 照旧）。" +
				"每次派发时读盘,改动即时生效。" +
				(warmError ||
					(warmExists
						? "保温.json 已存在,写入只改本键。"
						: "保温.json 尚不存在时,首次写入会创建它（同上,文件存在即视为保温功能启用）。")),
		},
		{
			id: "自动召回",
			label: "自动召回",
			currentValue: recallValue,
			values: memoryToggleValues,
			description:
				"每轮对话前按用户输入自动召回 top3 相关记忆（缺省关）。开关在会话启动时一次定型,重启会话后生效；需有效配置" +
				(memoryError
					? `：${memoryError}`
					: memoryExists
						? "。"
						: "——记忆供应商.json 尚不存在,面板拒绝代建（先在文件里配置「供应商」等字段）。"),
		},
		{
			id: "自动交接",
			label: "自动交接",
			currentValue: handoffValue,
			values: memoryToggleValues,
			description:
				"上下文压缩时把交接摘要写进记忆供应商（缺省关）。同「自动召回」：重启会话后生效；需有效配置" +
				(memoryError ? `：${memoryError}` : memoryExists ? "。" : "——记忆供应商.json 尚不存在,面板拒绝代建。"),
		},
	];
	const values: Record<string, string> = {};
	for (const item of items) values[item.id] = item.currentValue;
	return {
		items,
		values,
		states: {
			"toast 通知": state.warm,
			上游并发上限: state.warm,
			自动召回: state.memory,
			自动交接: state.memory,
		},
	};
}

/**
 * 可视化面板本体（overlay 组件）。查询、注册命令和可用行数不变时复用命令列表；
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
	private settingsList: SettingsList;
	private readonly settingItems: SettingItem[];
	private readonly settingsValues: Record<string, string>;
	private readonly settingStates: Record<string, ConfigState>;
	private readonly commandInput: Input;
	private commandList: SelectList;
	private commandMatches: PaoSubcommand[] = [];
	private commandCache?: { query: string; viewport: number; commands: readonly PaoSubcommand[] };
	private commandViewport = 1;
	private settingsViewport = 1;
	private settingsIndex = 0;
	private layoutRows = 24;
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
		const { items, values, states } = buildSettingItems(this.paoHome);
		this.settingItems = items;
		this.settingsValues = values;
		this.settingStates = states;
		this.commandInput = new Input({ prompt: "搜索: ", placeholder: "输入命令、中文标签或说明" });
		this.commandList = new SelectList([], 1, this.#commandTheme());
		this.settingsList = this.#makeSettingsList(1);
		this.#ensureLayout();
		this.commandInput.focused = true;
	}

	#makeSettingsList(maxVisible: number): SettingsList {
		const list = new SettingsList(
			this.settingItems,
			Math.max(1, maxVisible),
			this.#settingsTheme(),
			(id, newValue) => this.#onSettingChange(id, newValue),
			() => this.#finish(),
		);
		list.selectItem(this.settingItems[this.settingsIndex]?.id ?? "");
		return list;
	}

	/** 每帧按真实终端高度重算列表视口，适配 ConPTY resize，不把底部键位提示裁掉。 */
	#ensureLayout(): void {
		const rows = tuiRows(this.tui);
		const bodyRows = Math.max(1, rows - 2); // 顶部/底部边框各占一行
		const contentRows = Math.max(1, bodyRows - 5); // Tab、分隔、空行、底部空行、键位提示
		const commandViewport = Math.max(1, contentRows - 2);
		const settingsViewport = Math.max(1, contentRows - 1);
		this.layoutRows = rows;
		if (this.commandViewport !== commandViewport) {
			this.commandViewport = commandViewport;
			this.#syncCommandList();
		}
		if (this.settingsViewport !== settingsViewport) {
			this.settingsViewport = settingsViewport;
			this.settingsList = this.#makeSettingsList(settingsViewport);
		}
	}

	get focused(): boolean {
		return this.#focused;
	}

	set focused(value: boolean) {
		this.#focused = value;
		this.commandInput.focused = value && this.activeTab === "命令";
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
			this.commandInput.focused = this.#focused && this.activeTab === "命令";
			this.tui.requestRender();
			return;
		}
		if (this.activeTab === "命令") {
			this.#handleCommandInput(data);
			return;
		}
		this.#ensureLayout();
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.settingsIndex = (this.settingsIndex - 1 + this.settingItems.length) % this.settingItems.length;
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.settingsIndex = (this.settingsIndex + 1) % this.settingItems.length;
		}
		this.settingsList.handleInput(data);
	}

	/** 主题失效时重建列表的主题映射，其余重绘复用命令匹配结果。 */
	invalidate(): void {
		if (this.exited) return;
		this.commandCache = undefined;
		this.tui.requestRender();
	}

	dispose(): void {
		// 无定时器资源;仅防 dispose 后再吃键
		this.exited = true;
	}

	render(width: number): string[] {
		this.#ensureLayout();
		const panelWidth = Math.max(16, Math.min(Math.max(16, width), PANEL_MAX_WIDTH));
		const inner = Math.max(8, panelWidth - 4); // "│ " 与 " │" 各占 2
		const border = (text: string) => this.theme.fg("border", text);
		const title = "─ pao 面板 ";
		const top = border(
			`╭${truncateToWidth(title, Math.max(1, panelWidth - 2), "")}${"─".repeat(Math.max(0, panelWidth - 2 - visibleWidth(title)))}╮`,
		);
		const bottom = border(`╰${"─".repeat(panelWidth - 2)}╯`);
		const frame = (line: string) => `${border("│")} ${truncateToWidth(line, inner, "", true)} ${border("│")}`;
		const lines = [top, ...this.#renderBody(inner, Math.max(1, this.layoutRows - 2)).map(frame), bottom];
		return lines.map((line) => truncateToWidth(line, width));
	}

	#renderBody(inner: number, bodyRows: number): string[] {
		const lines: string[] = [];
		lines.push(this.#renderTabBar());
		lines.push(this.theme.fg("dim", "─".repeat(Math.max(1, inner))));
		lines.push("");
		const contentRows = Math.max(0, bodyRows - 5);
		if (this.activeTab === "命令") lines.push(...this.#renderCommands(inner, contentRows));
		else lines.push(...this.settingsList.render(inner).slice(0, contentRows));
		const hint = this.theme.fg("dim", "↑↓ 移动 · 回车/空格 确认 · Tab/←→ 切页 · Esc 退出");
		lines.push("");
		lines.push(hint);
		if (lines.length <= bodyRows) return lines;
		// 极窄终端也必须保留最后一行操作提示；12/16/24 行会走完整预算。
		return [...lines.slice(0, Math.max(0, bodyRows - 1)), hint];
	}

	#renderTabBar(): string {
		const tab = (name: string, active: boolean) =>
			active ? this.theme.fg("accent", `[${name}]`) : this.theme.fg("muted", ` ${name} `);
		return ` ${tab("命令", this.activeTab === "命令")}   ${tab("设置", this.activeTab === "设置")}`;
	}

	#renderCommands(inner: number, contentRows: number): string[] {
		// 注册表可能在面板打开后由扩展加载/卸载；渲染时同步一次，避免陈旧列表。
		this.#syncCommandList();
		const selected = this.commandMatches[this.commandIndex];
		const hasCommands = (this.commandCache?.commands.length ?? 0) > 0;
		const lines: string[] = [];
		lines.push(...this.commandInput.render(inner).slice(0, 1));
		lines.push(
			this.theme.fg(
				"dim",
				truncateToWidth(
					!hasCommands
						? "（本会话未注册任何子命令）"
						: this.commandMatches.length === 0
							? "无匹配命令（可继续输入或退格清空筛选）"
							: `命令 ${this.commandIndex + 1}/${this.commandMatches.length} · ↑↓ 移动 · 回车执行`,
					inner,
				),
			),
		);
		const remaining = Math.max(0, contentRows - lines.length);
		const detailRows = Math.min(2, Math.max(0, remaining - (this.commandMatches.length > 0 ? 1 : 0)));
		const listRows = Math.max(0, remaining - detailRows);
		if (hasCommands && listRows > 0)
			lines.push(
				...this.commandList
					.render(inner)
					.map((line) => line.replace("No matching commands", "无匹配命令"))
					.slice(0, listRows),
			);
		if (detailRows > 0) {
			lines.push(this.theme.fg("accent", "详情"));
			if (detailRows > 1) {
				if (selected) {
					const detail = wrapTextWithAnsi(selected.description, Math.max(10, inner - 4));
					lines.push(this.theme.fg("dim", `  ${detail[0] ?? ""}`));
				} else lines.push(this.theme.fg("dim", "  没有符合筛选条件的命令"));
			}
		}
		return lines;
	}

	#handleCommandInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.#moveCommand(-1);
			this.tui.requestRender();
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.#moveCommand(1);
			this.tui.requestRender();
		} else if (this.keybindings.matches(data, "tui.select.confirm") || data === " ") {
			const sub = this.commandMatches[this.commandIndex];
			if (sub) void this.#runSubcommand(sub);
		} else {
			const before = this.commandInput.getValue();
			// Input 负责中文、组合字符、粘贴和退格；即使没有匹配项也必须继续委托。
			this.commandInput.handleInput(data);
			if (before !== this.commandInput.getValue()) this.#syncCommandList();
			this.tui.requestRender();
		}
	}

	#syncCommandList(): void {
		const query = this.commandInput.getValue().trim().toLocaleLowerCase();
		const commands = listPaoSubcommands(this.pi);
		const cache = this.commandCache;
		if (
			cache?.query === query &&
			cache.viewport === this.commandViewport &&
			cache.commands.length === commands.length &&
			commands.every((command, index) => command === cache.commands[index])
		)
			return;
		this.commandCache = { query, viewport: this.commandViewport, commands };
		const previous = this.commandMatches[this.commandIndex]?.name;
		this.commandMatches = commands.filter(
			(sub) => !query || `${sub.name} ${sub.label} ${sub.description}`.toLocaleLowerCase().includes(query),
		);
		this.commandIndex = previous
			? Math.max(
					0,
					this.commandMatches.findIndex((sub) => sub.name === previous),
				)
			: Math.min(this.commandIndex, Math.max(0, this.commandMatches.length - 1));
		if (this.commandIndex < 0) this.commandIndex = 0;
		const items: SelectItem[] = this.commandMatches.map((sub) => ({
			value: sub.name,
			label: `${sub.name}  ${sub.label}`,
		}));
		this.commandList = new SelectList(items, this.commandViewport, this.#commandTheme());
		this.commandList.setSelectedIndex(this.commandIndex);
	}

	#moveCommand(delta: number): void {
		if (this.commandMatches.length === 0) return;
		this.commandIndex = (this.commandIndex + delta + this.commandMatches.length) % this.commandMatches.length;
		this.commandList.setSelectedIndex(this.commandIndex);
	}

	#commandTheme() {
		return {
			selectedPrefix: (text: string) => this.theme.fg("accent", text),
			selectedText: (text: string) => this.theme.fg("accent", text),
			description: (text: string) => this.theme.fg("dim", text),
			scrollInfo: (text: string) => this.theme.fg("dim", text),
			noMatch: (text: string) => this.theme.fg("dim", `  ${text}`),
		};
	}

	/** 回车执行子命令:先收面板（输出不进 overlay）,再透传 ctx 执行;失败 notify 不炸会话 */
	async #runSubcommand(sub: PaoSubcommand): Promise<void> {
		this.#finish();
		try {
			if (sub.name === "flow" && this.ctx.ui?.select && this.ctx.ui?.input) {
				await this.#runGuidedFlow(sub);
			} else {
				await sub.run(this.pi, "", this.ctx);
			}
		} catch (error) {
			this.ctx.ui?.notify?.(
				`pao ${sub.name} 执行失败:${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	}

	/**
	 * 工作流入口的小范围引导：选择已有配方，再按配方声明的参数提问；查看与人工门复用
	 * `/pao flow` 原命令，不在面板复制任何状态机或权限判断。
	 */
	async #runGuidedFlow(sub: PaoSubcommand): Promise<void> {
		const select = this.ctx.ui?.select;
		const input = this.ctx.ui?.input;
		if (!select || !input) return sub.run(this.pi, "", this.ctx);
		const action = await select("工作流操作", ["启动工作流", "查看进度", "人工确认", "取消"]);
		if (!action || action === "取消") return;
		const instanceSignals = action === "启动工作流" ? [] : scanInstanceSignals(this.paoHome).实例;
		const names = [...new Set([...listRecipes(this.paoHome), ...instanceSignals.map((row) => row.工作流)])];
		if (names.length === 0) {
			this.#notify(
				action === "启动工作流"
					? `没有可用工作流配方（位置：${this.paoHome}\\工作流）`
					: "没有可查看的工作流实例；请先启动工作流或从全景页核对实例",
				"warning",
			);
			return;
		}
		const name = await select("选择工作流配方", [...names, "取消"]);
		if (!name || name === "取消") return;
		if (action === "查看进度") {
			const instance = await this.#pickWorkflowInstance(select, name, "查看");
			if (!instance?.卡目录) return;
			await sub.run(this.pi, `see ${name} cards_dir=${encodeURIComponent(instance.卡目录)}`, this.ctx);
			return;
		}
		if (action === "人工确认") {
			// 先选实例，再从 v2 冻结配方读取真实节点；配方文件被删除/修改不影响已启动实例。
			const pickedRow = await this.#pickWorkflowInstance(select, name, "确认");
			if (!pickedRow?.卡目录) return;
			let recipe: WorkflowRecipe;
			try {
				recipe = pickedRow.配方 ?? loadRecipe(this.paoHome, name);
			} catch (error) {
				this.#notify(
					`实例配方读取失败：${error instanceof Error ? error.message : String(error)}；请从全景页核对实例`,
					"error",
				);
				return;
			}
			const gates = recipe.节点.filter((node) => node.人工确认).map((node) => node.名字);
			if (gates.length === 0) {
				this.#notify(`工作流「${name}」没有待人工确认节点`, "info");
				return;
			}
			const node = await select("选择人工确认节点", [...gates, "取消"]);
			if (!node || node === "取消") return;
			if (pickedRow.实例) {
				const gate = pickedRow.人工门.find((entry) => entry.节点 === node);
				if (!gate) {
					this.#notify(`实例「${pickedRow.实例}」当前没有节点「${node}」的待确认轮次`, "warning");
					return;
				}
				await sub.run(
					this.pi,
					`confirm ${name} ${node} ${pickedRow.实例} ${gate.轮次} cards_dir=${encodeURIComponent(pickedRow.卡目录)}`,
					this.ctx,
				);
				return;
			}
			await sub.run(this.pi, `confirm ${name} ${node} cards_dir=${encodeURIComponent(pickedRow.卡目录)}`, this.ctx);
			return;
		}
		let recipe: WorkflowRecipe;
		try {
			recipe = loadRecipe(this.paoHome, name);
		} catch (error) {
			this.#notify(`配方读取失败：${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		if (action === "启动工作流") {
			const params: Record<string, string> = {};
			for (const param of recipe.占位符) {
				const value = (await input(`参数「${param}」`, `请输入 ${param}`))?.trim();
				if (!value) {
					this.#notify(`已取消：参数「${param}」不能为空`, "warning");
					return;
				}
				if (/\s/.test(value)) {
					this.#notify(
						`参数「${param}」含空白；可复制工具示例：pao_start_flow({ name: "${name}", params: { "${param}": "你的值" } })`,
						"warning",
					);
					return;
				}
				params[param] = value;
			}
			const args = [name, ...Object.entries(params).map(([key, value]) => `${key}=${value}`)].join(" ");
			await sub.run(this.pi, args, this.ctx);
			return;
		}
	}

	/** 从实例扫描结果中选择真实卡目录，避免同名配方/实例总是落到默认工作区。 */
	async #pickWorkflowInstance(
		select: NonNullable<NonNullable<PanelCtx["ui"]>["select"]>,
		name: string,
		action: "查看" | "确认",
	): Promise<InstanceSignalRow | undefined> {
		const signals = scanInstanceSignals(this.paoHome).实例.filter(
			(row) => row.工作流 === name && typeof row.卡目录 === "string" && row.卡目录.length > 0,
		);
		if (signals.length === 0) {
			this.#notify(`找不到可${action}的工作流实例；请先启动或从全景页核对实例`, "warning");
			return undefined;
		}
		const labels = signals.map((row, index) => {
			const identity = row.实例 ?? "旧版实例";
			return `${identity} · ${row.项目} · ${row.状态} · ${row.卡目录} · ${index + 1}`;
		});
		const picked = await select(`选择${action}工作流实例`, [...labels, "取消"]);
		if (!picked || picked === "取消") return undefined;
		const index = labels.indexOf(picked);
		return index >= 0 ? signals[index] : undefined;
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
			const configState = this.settingStates[id];
			if (
				configState &&
				(configState.status === "invalid" ||
					configState.status === "unreadable" ||
					((id === "自动召回" || id === "自动交接") && configState.status === "missing"))
			) {
				throw new Error(`${configState.reason ?? "配置未配置"}；保留原文件，未覆盖`);
			}
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
