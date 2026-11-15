/** 按需记录一次实际装配；不常驻复制所有请求，不记录隐藏推理或凭证。 */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
import { observeProviderRequests } from "../../core/provider-request-hooks.ts";
import { addPaoSubcommand } from "../command-router.ts";

// 模块加载即接线：SDK 在所有 onPayload 变换完成后回调观察者，arm 后下一次请求即被捕获。
// 放模块加载期与原 core 静态引入同语义（装载即生效，与扩展注册时机/角色门控无关；
// 未 arm 时观察者零行为，worker 会话无 arm 入口，等同关闭）。
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

interface CaptureState {
	armed: boolean;
	sequence: number;
	current?: ContextCapture;
}
const states = new Map<string, CaptureState>();

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
	states.set(sessionId, { armed: true, sequence: previous?.sequence ?? 0 });
}

function begin(sessionId: string): ContextCapture | undefined {
	const state = states.get(sessionId);
	if (!state?.armed) return;
	if (!state.current)
		state.current = {
			会话: sessionId,
			请求序号: ++state.sequence,
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
	const capture = begin(sessionId);
	if (!capture) return;
	capture.供应商请求 = redactContext(payload);
	capture.最终装配已核 = true;
	const state = states.get(sessionId);
	if (state) state.armed = false;
	return capture.请求标识;
}

export function recordProviderResponse(sessionId: string, requestId: string | undefined, status: number): void {
	const state = states.get(sessionId);
	if (!state?.current || !requestId || state.current.请求标识 !== requestId) return;
	state.current.状态 = "已发送且收到响应";
	state.current.响应状态 = status;
	state.armed = false;
}

export function getContextCapture(sessionId: string): ContextCapture | undefined {
	const capture = states.get(sessionId)?.current;
	return capture ? structuredClone(capture) : undefined;
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
	pi.on("session_shutdown", (_event, ctx) => clearContextCapture(ctx.sessionManager.getSessionId()));
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
			ctx.ui.notify(
				capture
					? JSON.stringify(capture, null, 2)
					: "尚无捕获。/pao context arm 后正常发送下一条消息，再用 /pao context 查看。",
				"info",
			);
		},
	});
}
