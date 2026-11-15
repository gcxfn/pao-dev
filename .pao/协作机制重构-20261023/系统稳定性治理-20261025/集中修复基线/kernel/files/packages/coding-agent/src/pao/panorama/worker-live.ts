/**
 * worker 实时页（全景三批·任务 3）:ctx.ui.custom overlay 组件,在途 worker 的 stdout 实时尾巴。
 *
 * 打通形态（选型报告）:
 * - 键盘:组件实现 pi-tui Component + Focusable（focused 由 TUI overlay 置位）,handleInput
 *   收原始键——`q` 直配字面量,Esc 走 keybindings.matches("tui.select.cancel")（/mcp 管理页同款）。
 * - 自动刷新:setInterval(2s) 里重读快照 → invalidate()（重算行文本）→ tui.requestRender()
 *   （组件树重绘调度口,extensions/llama/ui.ts 同款）。退出（q/Esc/done/dispose）全部清 interval。
 * - settle 末态:打开期间 worker 结束（快照消失）→ 渲染一帧末态提示（回执按派单链路交卡）,
 *   停表后自动 done() 收页。
 */

import { type Component, type Focusable, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { logWarn } from "../shared/log.ts";

/** 在途 worker 快照（WorkerRunner.listActive 条目的结构面,测试/注入用） */
export interface WorkerLiveSnapshot {
	pid: number;
	卡号: string;
	命令: string;
	stdoutTail: (lineCount?: number) => string;
}

export interface WorkerLiveOptions {
	/** 每次刷新取最新快照;返回 undefined = worker 已 settle */
	快照: () => WorkerLiveSnapshot | undefined;
	/** 关页回调（q/Esc/settle 自动退出都经它） */
	done: () => void;
	/** 自动刷新间隔毫秒;缺省 2000 */
	刷新毫秒?: number;
	/** settle 后展示末态提示的停留毫秒;缺省 1200（测试可注入 0） */
	末态停留毫秒?: number;
}

const TAIL_LINES = 15;
const COMMAND_MAX = 120;

export class WorkerLiveView implements Component, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly options: WorkerLiveOptions;
	private lines: string[] = [];
	private refreshTimer: ReturnType<typeof setInterval> | undefined;
	private settleTimer: ReturnType<typeof setTimeout> | undefined;
	private exited = false;
	private settled = false;
	#focused = false;

	constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager, options: WorkerLiveOptions) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.options = options;
		this.#rebuild();
		this.refreshTimer = setInterval(() => this.#tick(), options.刷新毫秒 ?? 2000);
	}

	get focused(): boolean {
		return this.#focused;
	}

	set focused(value: boolean) {
		this.#focused = value;
	}

	/** 键盘收口:q 字面量或 Esc（tui.select.cancel）退出;其余键忽略。 */
	handleInput(data: string): void {
		if (this.exited) return;
		if (data === "q" || this.keybindings.matches(data, "tui.select.cancel")) this.#finish();
	}

	/** 重算行文本并请求重绘（刷新 tick 与主题失效共用同一口） */
	invalidate(): void {
		if (this.exited) return;
		this.#rebuild();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		return this.lines.map((line) => truncateToWidth(line, width));
	}

	/** 生命周期兜底:overlay 卸载时若 done 未走过,清表（幂等,不二次 done） */
	dispose(): void {
		this.#clearTimers();
		this.exited = true;
	}

	#tick(): void {
		if (this.exited) return;
		try {
			const snap = this.options.快照();
			if (snap === undefined && !this.settled) {
				this.settled = true;
				this.invalidate(); // 先出一帧末态提示,再自动收页
				this.#clearRefreshTimer();
				this.settleTimer = setTimeout(() => this.#finish(), this.options.末态停留毫秒 ?? 1200);
				return;
			}
			this.invalidate();
		} catch (error) {
			logWarn(
				`[pao] worker 实时页刷新失败(下个 tick 继续):${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	#finish(): void {
		if (this.exited) return;
		this.exited = true;
		this.#clearTimers();
		this.options.done();
	}

	#clearRefreshTimer(): void {
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = undefined;
		}
	}

	#clearTimers(): void {
		this.#clearRefreshTimer();
		if (this.settleTimer) {
			clearTimeout(this.settleTimer);
			this.settleTimer = undefined;
		}
	}

	#rebuild(): void {
		const snap = this.options.快照();
		const refreshSeconds = Math.round((this.options.刷新毫秒 ?? 2000) / 1000);
		const title = snap ? `worker pid ${snap.pid} · 卡${snap.卡号 || "（无卡号）"}` : "worker 实时页（已退出）";
		const lines: string[] = [this.theme.fg("accent", title)];
		if (snap) {
			lines.push(this.theme.fg("text", `命令:${snap.命令.slice(0, COMMAND_MAX)}`));
			lines.push("");
			lines.push(this.theme.fg("muted", `── stdout 末 ${TAIL_LINES} 行 ──`));
			const tail = snap.stdoutTail(TAIL_LINES);
			if (tail) for (const line of tail.split("\n")) lines.push(this.theme.fg("text", line));
			else lines.push(this.theme.fg("muted", "（尚无输出）"));
		}
		lines.push("");
		const footer = this.settled
			? "worker 已 settle——回执按派单链路交卡（pao_submit_receipt 落卡,此处只读不写）"
			: `q/Esc 退出 · ${refreshSeconds}s 自动刷新`;
		lines.push(this.theme.fg("dim", footer));
		this.lines = lines;
	}
}

/** 打开 worker 实时页（overlay）;ui 为 ctx.ui 的结构面,测试可注入。 */
export function showWorkerLivePage(
	ui: {
		custom: <T>(
			factory: (
				tui: TUI,
				theme: Theme,
				keybindings: KeybindingsManager,
				done: (result: T) => void,
			) => Component & { dispose?(): void },
			options?: { overlay?: boolean },
		) => Promise<T>;
	},
	worker: () => WorkerLiveSnapshot | undefined,
): Promise<void> {
	return ui.custom<void>(
		(tui, theme, keybindings, done) => {
			return new WorkerLiveView(tui, theme, keybindings, { 快照: worker, done });
		},
		{ overlay: true },
	);
}
