import { absorbAuxiliaryUsage, bindUsageSession, normalizeUsage } from "../worker/native-usage.ts";
import type { WorkerUsage } from "../worker/receipt.ts";

/**
 * 部长会话子进程(RPC 模式)stdout 事件流解析(M2-01 §2:usage 事件边界计数,零新增探针)。
 *
 * RPC stdout 走 JsonAgentSessionEvent 形状(modes/json-event.ts):message_update 事件带
 * 顶层 usage(本条 assistant 消息的累计用量)与 assistantMessageEvent(流式子事件:
 * text 系/toolcall 系);一轮的权威终点是顶层 message_end 事件(自带最终 assistant 消息与
 * 其 usage,pi-agent-core agent-loop 对流终态不发子事件)。
 * 这里只做机械聚合:轮次＝完成的 assistant 消息数、工具调用＝toolcall_start
 * 次数、用量逐轮累加;接口未回 usage 的轮记缺账(R07 未知不当零,不填零)。
 * 保温纪律:解析纯内存,零定时器零轮询零文件监听——计数只挂事件边界。
 */

export interface MinisterEventState {
	用量: WorkerUsage;
	轮次: number;
	工具调用次数: number;
	/** assistant message_end 未带 usage 的轮数(缺账轮,不填零) */
	缺用量轮次: number;
	/** 最后一条助手文本首选用途:监督快照的「最近输出」 */
	最终输出: string;
	/** 最近工具调用名(活性判据②循环窗口的源;按发生序,截尾保留) */
	最近工具签名: string[];
	/** 会话是否在跑(agent_start/agent_settled) */
	运行中: boolean;
	/** RPC get_state 响应带回的 pi 会话标识 */
	会话标识?: string;
}

export function createMinisterEventState(): MinisterEventState {
	return {
		用量: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		轮次: 0,
		工具调用次数: 0,
		缺用量轮次: 0,
		最终输出: "",
		最近工具签名: [],
		运行中: false,
	};
}

/** 工具签名窗口截尾长度(活性判据②只用最近 K 次,多存无益) */
const toolSignatureWindow = 16;

/** 一行事件的处理结果 */
export interface EventDelta {
	/** 是否为可解析 JSON(非 JSON 行忽略) */
	可解析: boolean;
	/** 是否为事件边界行(轮完成/工具调用/生命周期/响应)——宿主在此做计数与保险丝核对 */
	边界: boolean;
	/** 一轮 assistant 消息完成时的该轮用量快照(含用量=false 表示该轮接口未回 usage) */
	轮完成?: { 用量: WorkerUsage; 含用量: boolean };
	辅助成本?: number;
}

function emptyDelta(parseable: boolean, boundary = false): EventDelta {
	return { 可解析: parseable, 边界: boundary };
}

function extractText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
			parts.push(String((part as { text?: unknown }).text ?? ""));
		}
	}
	return parts.join("");
}

/** 解析一行 stdout JSON 事件并聚合(与 worker/receipt.ts absorbEvent 同纪律,RPC 线型) */
export function absorbMinisterEvent(state: MinisterEventState, line: string): EventDelta {
	if (!line.trim()) return emptyDelta(false);
	let event: {
		type?: string;
		assistantMessageEvent?: {
			type?: string;
			toolName?: string;
		};
		message?: {
			role?: string;
			stopReason?: string;
			errorMessage?: string;
			content?: unknown;
			usage?: LinearRoundUsage;
		};
		data?: { sessionId?: unknown };
	};
	try {
		event = JSON.parse(line);
	} catch {
		return emptyDelta(false);
	}
	if (!event || typeof event !== "object") return emptyDelta(false);
	const auxiliary = absorbAuxiliaryUsage(state, event);
	if (auxiliary.handled) return { 可解析: true, 边界: true, 辅助成本: auxiliary.cost };
	if (event.type === "response") {
		const sessionId = event.data?.sessionId;
		if (typeof sessionId === "string" && sessionId) {
			state.会话标识 = sessionId;
			bindUsageSession(state, sessionId);
		}
		return emptyDelta(true, true);
	}
	if (event.type === "agent_start") {
		state.运行中 = true;
		return emptyDelta(true, true);
	}
	if (event.type === "agent_settled") {
		state.运行中 = false;
		return emptyDelta(true, true);
	}
	// 一轮的权威终点＝顶层 message_end(pi-agent-core agent-loop 对流终态只发本事件,
	// assistantMessageEvent 里只有流式子事件,无终态子事件)——与 worker/receipt.ts 同口径。
	if (event.type === "message_end") {
		const msg = event.message;
		if (!msg || msg.role !== "assistant") return emptyDelta(true, false);
		if (msg.stopReason === "aborted" && msg.errorMessage === "Operation aborted before provider request")
			return emptyDelta(true, true);
		const uncertainFailure =
			(msg.stopReason === "error" || msg.stopReason === "aborted") &&
			!(msg.usage?.totalTokens && msg.usage.totalTokens > 0);
		return recordRound(state, msg.content, msg.usage, uncertainFailure);
	}
	if (event.type !== "message_update" || !event.assistantMessageEvent) return emptyDelta(true, false);
	const sub = event.assistantMessageEvent;
	if (sub.type === "toolcall_start" && sub.toolName) {
		state.工具调用次数++;
		state.最近工具签名.push(sub.toolName);
		if (state.最近工具签名.length > toolSignatureWindow)
			state.最近工具签名.splice(0, state.最近工具签名.length - toolSignatureWindow);
		return emptyDelta(true, true);
	}
	return emptyDelta(true, false);
}

/** RPC 线型的一轮 usage(pi-ai Usage 的所需切片;cost 线上是 {total} 对象,容错认数) */
interface LinearRoundUsage {
	totalTokens?: number;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: number | { total?: number };
}

/** 一轮 assistant 顶点入账:轮次＋1,usage 逐项累加(cost 认数或 {total}),缺 usage 记缺账轮不填零(R07) */
function recordRound(
	state: MinisterEventState,
	content: unknown,
	usage: LinearRoundUsage | undefined,
	uncertainFailure = false,
): EventDelta {
	state.轮次++;
	const parsed = normalizeUsage(usage);
	const roundUsage: WorkerUsage = { ...parsed.usage, turns: 1 };
	if (usage) {
		state.用量.input += roundUsage.input;
		state.用量.output += roundUsage.output;
		state.用量.cacheRead += roundUsage.cacheRead;
		state.用量.cacheWrite += roundUsage.cacheWrite;
		state.用量.cost += roundUsage.cost;
		state.用量.turns++;
	}
	if (parsed.unknown || uncertainFailure) {
		// 接口未回 usage:该轮记缺账,不填零(R07);落账跳过该轮(无法记账,不造数)
		state.缺用量轮次++;
	}
	const text = extractText(content);
	if (text) state.最终输出 = text;
	return { 可解析: true, 边界: true, 轮完成: { 用量: roundUsage, 含用量: Boolean(usage) } };
}
