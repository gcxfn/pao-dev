/** 原生账本的用量归一化及辅助费用事件；不读取消息正文，不另建费用来源。 */
import type { Usage } from "@earendil-works/pi-ai/compat";
import type { SessionEntry } from "../../core/session-manager.ts";
import { addUsageToTotals, createUsageTotals } from "../../core/usage-totals.ts";
import type { WorkerUsage } from "./receipt.ts";

export function normalizeUsage(value: unknown): { usage: WorkerUsage; unknown: boolean } {
	const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	const rawCost =
		typeof source.cost === "number" ? source.cost : (source.cost as { total?: unknown } | undefined)?.total;
	let unknown = !value;
	const number = (raw: unknown) => {
		if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
		unknown = true;
		return 0;
	};
	return {
		usage: {
			input: number(source.input),
			output: number(source.output),
			cacheRead: number(source.cacheRead),
			cacheWrite: number(source.cacheWrite),
			cost: number(rawCost),
			turns: 0,
		},
		get unknown() {
			return unknown;
		},
	};
}

export function nativeEntryUsage(
	entry: SessionEntry,
): { usage: WorkerUsage; unknown: boolean; kind: string; raw?: Usage } | undefined {
	let raw: Usage | undefined;
	let kind: string = entry.type;
	let turns = 0;
	let uncertainFailure = false;
	if (entry.type === "message" && entry.message.role === "assistant") {
		const message = entry.message;
		if (message.stopReason === "aborted" && message.errorMessage === "Operation aborted before provider request")
			return;
		raw = message.usage;
		kind = "assistant";
		turns = 1;
		uncertainFailure =
			(message.stopReason === "error" || message.stopReason === "aborted") && !(raw?.totalTokens > 0);
	} else if (entry.type === "message" && entry.message.role === "toolResult") {
		raw = entry.message.usage;
		kind = "toolResult";
		if (!raw) return;
	} else if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
		raw = entry.usage;
		if (!raw) return;
	} else if (
		entry.type === "custom" &&
		(entry.customType === "pao-precompaction-usage-status" || entry.customType === "pao-native-usage-status")
	) {
		const data = entry.data as { status?: string; usageReported?: boolean } | undefined;
		if (data?.status !== "请求未返回用量" && data?.usageReported !== false) return;
	} else return;
	const result = normalizeUsage(raw);
	result.usage.turns = turns;
	// raw 一并交出：调用方若按自己的口径判完整性（例如桌面只关心有没有 token 数），
	// 不必再按条目类型重新分类一遍用量来源。
	return { usage: result.usage, unknown: result.unknown || uncertainFailure, kind, ...(raw ? { raw } : {}) };
}

export function nativeUsageTotals(entries: readonly SessionEntry[]): { usage: WorkerUsage; unknown: number } {
	const totals = createUsageTotals();
	let turns = 0;
	let unknown = 0;
	for (const entry of entries) {
		const value = nativeEntryUsage(entry);
		if (!value) continue;
		const usage = value.usage;
		addUsageToTotals(totals, {
			...usage,
			totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost },
		});
		turns += usage.turns;
		if (value.unknown) unknown++;
	}
	return { usage: { ...totals, turns }, unknown };
}

interface Receiver {
	sessionId?: string;
	seen: Set<string>;
	complete: boolean;
}
const receivers = new WeakMap<object, Receiver>();
function receiver(state: object): Receiver {
	let value = receivers.get(state);
	if (!value) {
		value = { seen: new Set(), complete: false };
		receivers.set(state, value);
	}
	return value;
}
export function bindUsageSession(state: object, id: string): void {
	const value = receiver(state);
	value.sessionId ??= id;
}
export function usageStreamComplete(state: object): boolean {
	return receiver(state).complete;
}

/** 辅助费用只按 session+entry 身份计一次；主助手 usage 仍由 message_end 计。 */
export function absorbAuxiliaryUsage(
	state: { 用量: WorkerUsage; 缺用量轮次: number },
	event: unknown,
): { handled: boolean; cost?: number } {
	if (!event || typeof event !== "object") return { handled: false };
	const wire = event as Record<string, unknown>;
	if (wire.type !== "pao_usage_entry" && wire.type !== "pao_usage_complete") return { handled: false };
	const value = receiver(state);
	if (typeof wire.sessionId !== "string" || !wire.sessionId) {
		state.缺用量轮次++;
		return { handled: true };
	}
	value.sessionId ??= wire.sessionId;
	if (value.sessionId !== wire.sessionId) return { handled: true };
	if (wire.type === "pao_usage_complete") {
		value.complete = true;
		return { handled: true };
	}
	if (typeof wire.entryId !== "string" || !wire.entryId) {
		state.缺用量轮次++;
		return { handled: true };
	}
	if (value.seen.has(wire.entryId)) return { handled: true };
	value.seen.add(wire.entryId);
	value.complete = false;
	const parsed = normalizeUsage(wire.usage);
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost"] as const)
		state.用量[key] += parsed.usage[key];
	if (parsed.unknown || wire.unknown === true) state.缺用量轮次++;
	return { handled: true, cost: parsed.usage.cost };
}
