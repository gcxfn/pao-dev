import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { writeRawStdout } from "../../core/output-guard.ts";
import type { ReadonlySessionManager, SessionEntry } from "../../core/session-manager.ts";
import { PaoWorkerError } from "./errors.ts";
import { nativeEntryUsage, nativeUsageTotals } from "./native-usage.ts";
import type { WorkerReceipt } from "./receipt.ts";
import { totalsUsage, type UsageAggregate, type UsageLine, usageLineFromEventState } from "./usage.ts";

export type { UsageLine } from "./usage.ts";

/**
 * 用量显示（架构 §15，2026-10-02 定案）：
 * - 计量全部建在 pi 原生 usage 机制上：每轮显示订阅原生 turn_end 事件（自带本轮助手消息），
 *   取 message.usage 精确值，经 ctx.ui.setStatus() 写 TUI 底部状态行（footer 状态行是 pi
 *   为扩展留的原生显示面，零上下文开销，RPC 模式下免费带给桌面壳）；
 * - 本轮来自 turn_end；累计复用原生会话账本五类 usage，事件变化时刷新、不每帧扫描。
 *   部门/批次累计来自事件流聚合；未知不填零（R07），如实标已知下界。
 * - 注册接线（src/pao/index.ts 调 registerUsageFooter）由主控统一写，本模块只导出。
 */

/** 令牌数缩写：1234 → 1.2k，1234567 → 1.2M；不足千原样。 */
export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

/** 成本缩写：一般两位小数；极小非零成本两位会显示 $0.00，加精度保真不虚报为零。 */
export function formatCost(cost: number): string {
	const text = `$${cost.toFixed(2)}`;
	return text === "$0.00" && cost > 0 ? `$${cost.toFixed(4)}` : text;
}

/** turn_end 助手消息里原生 usage 的显示所需切片（结构化最小面；原生 Usage 结构兼容，缺项不显示不填零） */
export interface TurnUsageSnapshot {
	input?: number;
	output?: number;
	cacheRead?: number;
	cost?: { total?: number };
}

/**
 * 本轮状态行片段：形如「本轮 ↑12.3k ↓2.1k 缓存读 98k · $0.03」（架构 §15 定案样式）。
 * 某项缺失就不显示该项（R07 未知不填零）；全部缺失返回空串（调用方据此退回未知标注）。
 */
export function formatTurnUsage(usage: TurnUsageSnapshot): string {
	const parts: string[] = [];
	if (usage.input != null) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output != null) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead != null && usage.cacheRead > 0) parts.push(`缓存读 ${formatTokens(usage.cacheRead)}`);
	const cost = usage.cost?.total;
	if (parts.length === 0) return cost != null ? `本轮 ${formatCost(cost)}` : "";
	return cost != null ? `本轮 ${parts.join(" ")} · ${formatCost(cost)}` : `本轮 ${parts.join(" ")}`;
}

// ── 每轮 footer 状态行（本轮 + 本会话累计） ─────────────────────────────

/** footer 状态行的用量键（setStatus(key, text)；用户/桌面壳按此键识别用量行） */
export const usageStatusKey = "用量";

/** 用量显示快照：原生会话累计与本次运行新增消费共用同一结构。 */
export interface UsageFooterState {
	/** 原生用量合计；turns 仅是助手轮数，摘要／工具费用不增加轮数。 */
	累计: { input: number; output: number; cacheRead: number; cost: number; turns: number };
	/** 原生未回 usage 的轮数（R07：累计如实标「已知下界」，不填零） */
	缺用量轮次: number;
}

export function createUsageFooterState(): UsageFooterState {
	return { 累计: { input: 0, output: 0, cacheRead: 0, cost: 0, turns: 0 }, 缺用量轮次: 0 };
}

export type TurnAbsorbResult = "计数" | "未知轮" | "跳过";

/**
 * 把一条 turn_end 消息记入会话累计：assistant 消息逐项累加原生 usage；
 * 未回 usage 记缺账轮（累计为已知下界，R07）；非 assistant 消息跳过。
 * 与 receipt.ts absorbEvent 的口径一致（有 usage 才加数，轮次都计）。
 */
export function absorbTurnUsage(
	state: UsageFooterState,
	message: { role?: string; usage?: TurnUsageSnapshot } | undefined,
): TurnAbsorbResult {
	if (!message || message.role !== "assistant") return "跳过";
	const u = message.usage;
	state.累计.turns++;
	if (!u) {
		state.缺用量轮次++;
		return "未知轮";
	}
	if (u.input != null) state.累计.input += u.input;
	if (u.output != null) state.累计.output += u.output;
	if (u.cacheRead != null) state.累计.cacheRead += u.cacheRead;
	if (u.cost?.total != null) state.累计.cost += u.cost.total;
	return "计数";
}

/**
 * footer 状态行全文：形如「本轮 ↑12.3k ↓2.1k 缓存读 98k · $0.03 ｜ 累计 ↑15k ↓3.1k · $0.05 · 2 轮」。
 * 本轮缺省 = 该轮未回 usage，如实标「本轮 usage 未回」（不沿用上一轮旧值误导）；
 * 累计有缺账轮时附下界标注（R07 未知不填零）。无可显示内容（零轮次且本轮未知）返回空串。
 */
export function formatFooterStatus(state: UsageFooterState, currentRound?: TurnUsageSnapshot): string {
	const turnText = currentRound ? formatTurnUsage(currentRound) || "本轮 usage 未回" : "本轮 usage 未回";
	const c = state.累计;
	let totalText = "";
	if (c.turns > 0 || c.input > 0 || c.output > 0 || c.cost > 0) {
		const segs = [`↑${formatTokens(c.input)} ↓${formatTokens(c.output)}`, formatCost(c.cost)];
		if (c.turns > 0) segs.push(`${c.turns} 轮`);
		totalText = `累计 ${segs.join(" · ")}`;
	}
	if (state.缺用量轮次 > 0) {
		const note = `（${state.缺用量轮次}项用量不完整，已知下界）`;
		totalText = totalText ? `${totalText}${note}` : `累计${note}`;
	}
	return [turnText, totalText].filter(Boolean).join(" ｜ ");
}

/** 跨会话落账钩子（§15/M2-04）：接线由根 index.ts 统一写（本模块零反向依赖） */
export interface UsageFooterHook {
	/** 退出时只交本次运行新增消费；恢复历史用于展示，不再次计入跨会话账。 */
	onShutdown: (state: UsageFooterState, sessionStartIso: string) => void;
}

/** 原生 getSessionStats 的五类 usage 来源，复用上游加总函数。 */
export function sessionUsageState(entries: readonly SessionEntry[]): UsageFooterState {
	const { usage: totals, unknown } = nativeUsageTotals(entries);
	return {
		累计: {
			input: totals.input,
			output: totals.output,
			cacheRead: totals.cacheRead,
			cost: totals.cost,
			turns: totals.turns,
		},
		缺用量轮次: unknown,
	};
}

const usageListeners = new Map<string, Set<(manager: ReadonlySessionManager) => void>>();
/** 后台 usage 落账后主动刷新；不轮询、不在每帧扫描会话。 */
export function notifySessionUsageChanged(manager: ReadonlySessionManager): void {
	for (const listener of usageListeners.get(manager.getSessionId()) ?? []) listener(manager);
}

/**
 * 累计从原生账本读取（包括恢复历史），只在生命周期／费用变化事件刷新。
 * 退出落账排除进入会话时已有的条目，防止恢复历史重复累计；解绑同时移除后台订阅。
 */
export function registerUsageFooter(pi: ExtensionAPI, hook?: UsageFooterHook): () => void {
	type Record = {
		baseline: Set<string>;
		sent: Set<string>;
		wire: boolean;
		delta: UsageFooterState;
		started: string;
		listener: (manager: ReadonlySessionManager) => void;
	};
	const records = new Map<string, Record>();
	let current: ExtensionContext | undefined;
	let currentSessionId: string | undefined;
	let latest: TurnUsageSnapshot | undefined;
	const refresh = (manager: ReadonlySessionManager, show = true) => {
		const id = manager.getSessionId();
		const record = records.get(id);
		if (!record) return;
		const entries = manager.getEntries();
		if (record.wire)
			for (const entry of entries) {
				if (record.sent.has(entry.id)) continue;
				record.sent.add(entry.id);
				const value = nativeEntryUsage(entry);
				if (value && value.kind !== "assistant")
					writeRawStdout(
						`${JSON.stringify({ type: "pao_usage_entry", sessionId: id, entryId: entry.id, ...value })}\n`,
					);
			}
		record.delta = sessionUsageState(entries.filter((entry) => !record.baseline.has(entry.id)));
		if (show && current && currentSessionId === id)
			current.ui.setStatus(usageStatusKey, formatFooterStatus(sessionUsageState(entries), latest));
	};
	const start = (ctx: ExtensionContext) => {
		current = ctx;
		currentSessionId = ctx.sessionManager.getSessionId();
		latest = undefined;
		if (!records.has(currentSessionId)) {
			const listener = (manager: ReadonlySessionManager) => refresh(manager);
			records.set(currentSessionId, {
				baseline: new Set(ctx.sessionManager.getEntries().map((entry) => entry.id)),
				sent: new Set(ctx.sessionManager.getEntries().map((entry) => entry.id)),
				wire: ctx.mode === "json" || ctx.mode === "rpc",
				delta: createUsageFooterState(),
				started: new Date().toISOString(),
				listener,
			});
			const listeners = usageListeners.get(currentSessionId) ?? new Set();
			listeners.add(listener);
			usageListeners.set(currentSessionId, listeners);
		}
		refresh(ctx.sessionManager);
	};
	const detach = () => {
		for (const [id, record] of records) {
			const listeners = usageListeners.get(id);
			listeners?.delete(record.listener);
			if (listeners?.size === 0) usageListeners.delete(id);
		}
		records.clear();
		current = undefined;
		currentSessionId = undefined;
	};
	const unbind = [
		pi.on("session_start", (_event, ctx) => start(ctx)),
		pi.on("session_before_switch", (_event, ctx) => refresh(ctx.sessionManager, false)),
		pi.on("turn_end", (event, ctx) => {
			if (event.message.role !== "assistant") return;
			current = ctx;
			currentSessionId = ctx.sessionManager.getSessionId();
			latest = event.message.usage;
			refresh(ctx.sessionManager);
		}),
		pi.on("session_compact", (_event, ctx) => refresh(ctx.sessionManager)),
		pi.on("session_compact_failed", (event, ctx) => {
			if (!event.fromExtension) {
				// 原生失败路径不保证保存已完成的分段摘要费用，不能据缺条目推断零费用。
				pi.appendEntry("pao-native-usage-status", { usageReported: false, status: "压缩失败，无法确认完整费用" });
				refresh(ctx.sessionManager);
			}
		}),
		pi.on("session_tree", (_event, ctx) => refresh(ctx.sessionManager)),
		pi.on("agent_end", (_event, ctx) => refresh(ctx.sessionManager)),
		pi.on("session_shutdown", (_event, ctx) => {
			refresh(ctx.sessionManager, false);
			for (const [id, record] of records) {
				hook?.onShutdown(record.delta, record.started);
				if (record.wire) writeRawStdout(`${JSON.stringify({ type: "pao_usage_complete", sessionId: id })}\n`);
			}
			detach();
		}),
	];
	return () => {
		for (const off of unbind) off();
		detach();
	};
}

// ── 用量数据供给：回执/批次/部门用量行（/队列 等渲染面的数据来源） ────────

/** 回执摘要 → 用户可见文本：形如「↑1.2k ↓500 · $0.02 · 3 轮」；非事件流来源附说明（R07）。 */
export function formatUsageLine(line: UsageLine): string {
	const u = line.用量;
	const base = `↑${formatTokens(u.input)} ↓${formatTokens(u.output)} · ${formatCost(u.cost)} · ${u.turns} 轮`;
	if (line.来源 === "事件流") return base;
	if (line.来源 === "未知") {
		return `${base}（来源:未知——${line.说明 ?? "部分项用量不完整，已知下界"}）`;
	}
	// 汇总:干净汇总无需解释,含未知时说明已带「已知下界」口径
	return line.说明 ? `${base}（来源:汇总——${line.说明}）` : `${base}（来源:汇总）`;
}

/**
 * 单条回执 → 叶子用量行（§15：显示层数据只从事件流来）。
 * 回执.用量本就是 runner 从 stdout 事件流聚合的，缺用量轮次随回执带来——
 * 经 usageLineFromEventState 同一入口判「事件流/未知」，显示层不另立计数路径。
 */
export function receiptUsageLine(
	receipt: Pick<WorkerReceipt, "card_no" | "attempt" | "usage" | "missing_usage_rounds">,
): UsageLine {
	return usageLineFromEventState(receipt.card_no, receipt.attempt, {
		用量: receipt.usage,
		缺用量轮次: receipt.missing_usage_rounds ?? 0,
	});
}

/** 批次/部门聚合共用核：叶子行汇总（汇总用量 结构性拒绝汇总行再进汇总），同批叶子不得重复。 */
function aggregateUsageLine(label: string, lines: readonly UsageLine[]): UsageAggregate {
	const seen = new Set<string>();
	const duplicate: string[] = [];
	for (const line of lines) {
		const key = `${line.卡号}#${line.尝试 ?? 0}`;
		if (seen.has(key)) duplicate.push(line.卡号);
		seen.add(key);
	}
	if (duplicate.length > 0) {
		throw new PaoWorkerError(
			"用量双计",
			`${[...new Set(duplicate)].join("、")} 同一(卡号,尝试)出现多次——同一回执只计一次，去重后再聚合`,
		);
	}
	return totalsUsage(label, lines);
}

/**
 * 部门累计用量行（/队列 部门累计行的数据供给）：入参 = 该部门各回执经 回执用量行
 * 转出的叶子行（每个(卡号,尝试)一行；要算全部尝试就全给，只算最新回执就只给最新）。
 * 来源恒为「汇总」，子项含未知时 含未知=true 且总额如实标已知下界（R07）；
 * 汇总行再进本函数、同一(卡号,尝试)重复入账，均在结构上拒绝（双计不可表达）。
 */
export function deptUsageLine(dept: string, lines: readonly UsageLine[]): UsageAggregate {
	return aggregateUsageLine(`部门:${dept}`, lines);
}

/** 批次累计用量行：与部门同款口径，标签为 批次:<批次>。 */
export function batchUsageLine(batch: string, lines: readonly UsageLine[]): UsageAggregate {
	return aggregateUsageLine(`批次:${batch}`, lines);
}

/** 聚合结果 → 渲染面可直接 formatUsageLine 的行（UsageAggregate 是 UsageLine 的超集形态）。 */
export function aggregateLineToUsageLine(agg: UsageAggregate): UsageLine {
	return {
		卡号: agg.卡号,
		用量: agg.用量,
		来源: "汇总",
		...(agg.说明 ? { 说明: agg.说明 } : {}),
	};
}
