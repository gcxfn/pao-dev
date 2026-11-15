import type { ExtensionAPI } from "../../core/extensions/types.ts";
import type { UsageLine, WorkerUsage } from "./usage.ts";

/**
 * 用量显示（架构 §15，2026-10-02 定案）：
 * - 计量全部建在 pi 原生 usage 机制上：每轮显示订阅原生 turn_end 事件取 message.usage，
 *   经 ctx.ui.setStatus() 写 TUI 底部状态行（footer 状态行是 pi 为扩展留的原生显示面）；
 * - 本文件是纯显示层：不做第二套计数，数据只来自原生 usage / 事件流聚合（usage.ts），
 *   未知不填零（R07）——某项原生没给就不显示该项，不虚构 0。
 * - 注册接线（src/pao/index.ts 调 registerUsageDisplay）由主控统一写，本模块只导出。
 */

/** 令牌数缩写：1234 → 1.2k，1234567 → 1.2M；不足千原样。 */
export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

/** turn_end 助手消息里原生 usage 的显示所需切片（结构化最小面，缺项不显示不填零） */
export interface TurnUsageSnapshot {
	input?: number;
	output?: number;
	cacheRead?: number;
	cost?: { total?: number };
}

/**
 * 每轮状态行文本：形如「本轮 ↑12.3k ↓2.1k 缓存读 98k · $0.03」（架构 §15 定案样式）。
 * 某项缺失就不显示该项（R07 未知不填零）；全部缺失返回空串（调用方据此不写状态行）。
 */
export function formatTurnUsage(usage: TurnUsageSnapshot): string {
	const parts: string[] = [];
	if (usage.input != null) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output != null) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead != null) parts.push(`缓存读 ${formatTokens(usage.cacheRead)}`);
	if (parts.length === 0 && usage.cost?.total == null) return "";
	const tokenText = parts.length > 0 ? `本轮 ${parts.join(" ")}` : "本轮";
	const cost = usage.cost?.total;
	return cost != null ? `${tokenText} · $${cost.toFixed(2)}` : tokenText;
}

/** footer 状态行的用量键（setStatus(key, text)；用户/桌面壳按此键识别用量行） */
export const 用量状态键 = "用量";

/**
 * 注册每轮用量显示：订阅原生 turn_end（自带本轮助手消息），取 message.usage 经
 * ctx.ui.setStatus 写底部状态行。非助手消息或未回 usage 的轮不写（不虚构、不留误导旧值责任在调用序）。
 * 返回解绑函数透传自 pi.on。
 */
export function registerUsageDisplay(pi: ExtensionAPI): () => void {
	return pi.on("turn_end", (event, ctx) => {
		const message = event.message as { role?: string; usage?: TurnUsageSnapshot } | undefined;
		if (!message || message.role !== "assistant" || !message.usage) return;
		const text = formatTurnUsage(message.usage);
		if (!text) return;
		ctx.ui.setStatus(用量状态键, text);
	});
}

/**
 * 用量行 → 用户可见文本（回执/扇出摘要等命令输出用）：
 * 形如「↑1.2k ↓500 · $0.02 · 3 轮」；来源未知时附说明（R07：已知合计只当下界，不填零）。
 */
export function formatUsageLine(line: UsageLine): string {
	const u = line.用量;
	const base = `↑${formatTokens(u.input)} ↓${formatTokens(u.output)} · $${u.cost.toFixed(2)} · ${u.turns} 轮`;
	if (line.来源 === "事件流") return base;
	return `${base}（来源:${line.来源}——${line.说明 ?? "部分轮次未回 usage，不填零按未知记"}）`;
}

/** WorkerUsage → 每轮样式文本的回执侧同款（不含「本轮」前缀），供状态行以外的汇总面复用 */
export function formatUsageTotals(用量: WorkerUsage): string {
	return `↑${formatTokens(用量.input)} ↓${formatTokens(用量.output)} · $${用量.cost.toFixed(2)} · ${用量.turns} 轮`;
}
