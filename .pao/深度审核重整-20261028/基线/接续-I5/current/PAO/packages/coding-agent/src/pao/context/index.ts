/** 按需记录完整装配；常规请求只保留有界的工具规模元数据。 */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
import { observeProviderRequests } from "../../core/provider-request-hooks.ts";
import { addPaoSubcommand } from "../command-router.ts";

// 模块加载即接线：SDK 在所有 onPayload 变换完成后回调观察者。
// 未 arm 时只记录工具规模元数据；arm 时另完整捕获下一次请求。
observeProviderRequests({
	onFinalPayload: recordFinalProviderPayload,
	onResponse: recordProviderResponse,
});

export interface ContextCapture {
	会话: string;
	请求序号: number;
	请求标识: string;
	状态: "待发预览" | "已发送且收到响应";
	时间: string;
	装配?: unknown;
	供应商请求?: unknown;
	最终装配已核: boolean;
	响应状态?: number;
	说明: string[];
}

export interface ProviderToolMetric {
	工具名: string | null;
	JSON码点: number | null;
	UTF8字节: number | null;
}

/** 每次真实供应商请求的有界元数据；不保工具说明全文，也不把字符数冒充 token。 */
export interface ProviderRequestMetrics {
	会话: string;
	请求序号: number;
	请求标识: string;
	时间: string;
	模型: string | null;
	工具字段存在: boolean;
	工具数: number | null;
	工具JSON码点: number | null;
	工具UTF8字节: number | null;
	token: null;
	响应状态?: number;
	工具: ProviderToolMetric[];
}

interface CaptureState {
	armed: boolean;
	sequence: number;
	current?: ContextCapture;
	metrics: ProviderRequestMetrics[];
}
const states = new Map<string, CaptureState>();
const METRICS_LIMIT = 100;

function stateFor(sessionId: string): CaptureState {
	let state = states.get(sessionId);
	if (!state) {
		state = { armed: false, sequence: 0, metrics: [] };
		states.set(sessionId, state);
	}
	return state;
}

function jsonSize(value: unknown): { 码点: number | null; 字节: number | null } {
	try {
		const json = JSON.stringify(value);
		if (json === undefined) return { 码点: null, 字节: null };
		return { 码点: Array.from(json).length, 字节: Buffer.byteLength(json, "utf8") };
	} catch {
		return { 码点: null, 字节: null };
	}
}

function toolName(value: unknown): string | null {
	if (!value || typeof value !== "object") return null;
	const tool = value as { name?: unknown; function?: { name?: unknown } };
	if (typeof tool.name === "string") return tool.name;
	return typeof tool.function?.name === "string" ? tool.function.name : null;
}

function toolMetrics(
	payload: unknown,
): Pick<ProviderRequestMetrics, "工具字段存在" | "工具数" | "工具JSON码点" | "工具UTF8字节" | "工具"> {
	if (!payload || typeof payload !== "object" || !Object.hasOwn(payload, "tools")) {
		return {
			工具字段存在: false,
			工具数: null,
			工具JSON码点: null,
			工具UTF8字节: null,
			工具: [],
		};
	}
	const tools = (payload as { tools?: unknown }).tools;
	if (!Array.isArray(tools)) {
		return {
			工具字段存在: true,
			工具数: null,
			工具JSON码点: null,
			工具UTF8字节: null,
			工具: [],
		};
	}
	const total = jsonSize(tools);
	return {
		工具字段存在: true,
		工具数: tools.length,
		工具JSON码点: total.码点,
		工具UTF8字节: total.字节,
		工具: tools.map((tool) => {
			const size = jsonSize(tool);
			return { 工具名: toolName(tool), JSON码点: size.码点, UTF8字节: size.字节 };
		}),
	};
}

/** 脱敏发生在存储前。隐藏推理块、二进制附件、凭证字段完全排除。 */
export function redactContext(value: unknown, depth = 0): unknown {
	if (depth > 40) return "[结构过深，未展示]";
	if (typeof value === "string")
		return value
			.replace(/\bBearer\s+[^\s"']+/gi, "Bearer [已脱敏]")
			.replace(/\b(?:sk-|sk_)[A-Za-z0-9_-]{8,}/g, "[已脱敏]")
			.replace(
				/((?:api[_-]?key|[a-z0-9_]*token|[a-z0-9_]*secret|password|密钥|密码)["']?\s*[=:]\s*["']?)[^\s,;"']+/gi,
				"$1[已脱敏]",
			)
			.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[私钥已脱敏]");
	if (Array.isArray(value)) return value.map((item) => redactContext(item, depth + 1));
	if (!value || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	if (typeof record.type === "string" && /thinking|reasoning|image|audio/i.test(record.type))
		return { type: record.type, omitted: "隐藏推理或二进制内容不展示" };
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(record)) {
		if (/authorization|cookie|api.?key|token$|password|secret|credential|thinking|reasoning|signature/i.test(key))
			out[key] = "[不展示]";
		else out[key] = redactContext(item, depth + 1);
	}
	return out;
}

export function armContextCapture(sessionId: string): void {
	const previous = states.get(sessionId);
	states.set(sessionId, {
		armed: true,
		sequence: previous?.sequence ?? 0,
		metrics: previous?.metrics ?? [],
	});
}

function begin(sessionId: string): ContextCapture | undefined {
	const state = states.get(sessionId);
	if (!state?.armed) return;
	if (!state.current)
		state.current = {
			会话: sessionId,
			请求序号: state.sequence + 1,
			请求标识: randomUUID(),
			状态: "待发预览",
			时间: new Date().toISOString(),
			最终装配已核: false,
			说明: [
				"只记录本次请求；供应商内部内容不可见。",
				"隐藏推理、凭证、图片与音频原文不展示。",
				"尚未收到响应前不宣称已发送成功。",
				"未提供 token 数；原文长度不冒充供应商计量。",
			],
		};
	return state.current;
}

/** core/sdk 的所有 before_provider_request hooks 完成后调用。 */
export function recordFinalProviderPayload(sessionId: string, payload: unknown): string | undefined {
	const state = stateFor(sessionId);
	const capture = begin(sessionId);
	const requestId = randomUUID();
	const sequence = ++state.sequence;
	const model =
		payload && typeof payload === "object" && typeof (payload as { model?: unknown }).model === "string"
			? (payload as { model: string }).model
			: null;
	const metrics: ProviderRequestMetrics = {
		会话: sessionId,
		请求序号: sequence,
		请求标识: requestId,
		时间: new Date().toISOString(),
		模型: model,
		...toolMetrics(payload),
		token: null,
	};
	state.metrics.push(metrics);
	if (state.metrics.length > METRICS_LIMIT) state.metrics.splice(0, state.metrics.length - METRICS_LIMIT);
	if (!capture) return;
	capture.请求序号 = metrics.请求序号;
	capture.请求标识 = requestId;
	capture.供应商请求 = redactContext(payload);
	capture.最终装配已核 = true;
	state.armed = false;
	return capture.请求标识;
}

export function recordProviderResponse(sessionId: string, requestId: string | undefined, status: number): void {
	const state = states.get(sessionId);
	if (!state || !requestId) return;
	const metrics = state.metrics.find((item) => item.请求标识 === requestId);
	if (metrics) metrics.响应状态 = status;
	if (state.current?.请求标识 === requestId) {
		state.current.状态 = "已发送且收到响应";
		state.current.响应状态 = status;
		state.armed = false;
	}
}

export function getContextCapture(sessionId: string): ContextCapture | undefined {
	const capture = states.get(sessionId)?.current;
	return capture ? structuredClone(capture) : undefined;
}

export function getProviderRequestMetrics(sessionId: string): ProviderRequestMetrics[] {
	return structuredClone(states.get(sessionId)?.metrics ?? []);
}

export function clearContextCapture(sessionId: string): void {
	states.delete(sessionId);
}

export function registerContextInspection(pi: ExtensionAPI): void {
	pi.on("context_with_system", (event, ctx) => {
		const capture = begin(ctx.sessionManager.getSessionId());
		if (capture) capture.装配 = redactContext(event.messages);
	});
	pi.on("before_provider_request", (event, ctx) => {
		const capture = begin(ctx.sessionManager.getSessionId());
		if (capture) capture.供应商请求 = redactContext(event.payload);
	});
	pi.on("session_shutdown", (event, ctx) => {
		const cleanup = () => clearContextCapture(ctx.sessionManager.getSessionId());
		if (event.onConfirmedShutdown) event.onConfirmedShutdown(cleanup);
		else cleanup();
	});
	addPaoSubcommand(pi, {
		name: "context",
		label: "上下文查看",
		description: "arm 仅捕获下一次实际请求；show 查看；clear 清除。查看不调用模型。",
		run: async (_pi, args, rawCtx) => {
			const ctx = rawCtx as ExtensionCommandContext;
			const id = ctx.sessionManager.getSessionId();
			if (args.trim() === "arm") {
				armContextCapture(id);
				ctx.ui.notify("已准备捕获下一次请求。此操作不调用模型。", "info");
				return;
			}
			if (args.trim() === "clear") {
				clearContextCapture(id);
				ctx.ui.notify("本地上下文视图已清除；已经发送的请求不能撤回。", "info");
				return;
			}
			const capture = getContextCapture(id);
			const metrics = getProviderRequestMetrics(id);
			ctx.ui.notify(
				capture
					? JSON.stringify({ 捕获: capture, 最近请求工具规模: metrics }, null, 2)
					: metrics.length
						? JSON.stringify({ 捕获: null, 最近请求工具规模: metrics }, null, 2)
						: "尚无捕获。/pao context arm 后正常发送下一条消息，再用 /pao context 查看。",
				"info",
			);
		},
	});
}
