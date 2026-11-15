/**
 * 结构化回执:card_no+attempt+status+artifact_path+≤3行summary+usage+evidence_path(架构 §2 回执格式)。
 * 用量只从子进程 stdout JSON 事件流(message_end)取,不采信模型正文自报。
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { FailureType, ReceiptChange, ReceiptVerification, TaskState } from "../cards/types.ts";
import type { WorkerUsage } from "../shared/usage.ts";
import { absorbAuxiliaryUsage, bindUsageSession, normalizeUsage } from "./native-usage.ts";

export type { WorkerUsage };

/** 交回执工具名（回执通道）：预算提醒轮里唯一放行的工具，也不计入工具次数预算。 */
export const RECEIPT_TOOL_NAME = "pao_submit_receipt";

/** 一行 stdout 事件是否为交回执工具调用——父运行器预算兜底与子会话门禁必须同口径计数。 */
export function isReceiptToolCall(line: string): boolean {
	if (!line.includes(RECEIPT_TOOL_NAME)) return false;
	let event: { type?: string; toolName?: string };
	try {
		event = JSON.parse(line);
	} catch {
		return false;
	}
	return event?.type === "tool_execution_start" && event.toolName === RECEIPT_TOOL_NAME;
}

export type WorkerStatus = "success" | "failed" | "canceled" | "unknown";

export interface WorkerReceipt {
	card_no: string;
	attempt: number;
	status: WorkerStatus;
	artifact_path: string[];
	/** ≤3 行 */
	summary: string;
	usage: WorkerUsage;
	/**
	 * assistant message_end 未带 usage 的轮数（R07：有缺即按「unknown」记，不填零）。
	 * 显示层据此把用量行标为来源「unknown」；缺省 = 全部轮次都有 usage（来源「事件流」）。
	 */
	missing_usage_rounds?: number;
	/** 完整事件流证据文件（JSONL 或无损 gzip）；以实际返回路径为准。 */
	evidence_path: string;
	/**
	 * 中途实时证据(live JSONL,边跑边追加落盘):B 档中途查看/静默期读取用。
	 * 结算后可能指向无损 gzip；旧的运行中路径可经 PAO read 读取同名归档。live 打开失败时缺省。
	 */
	live_evidence_path?: string;
	/** 中途实时 stderr(live 追加);live 打开失败时缺省 */
	live_stderr_path?: string;
	exitCode: number;
	stopReason?: string;
	stderrTail?: string;
	/** 完整命令行(审计) */
	command: string;
	pid: number;
	duration_ms: number;
	card_path?: string;
	run_id?: string;
	会话路径?: string;
	映射路径?: string;
	工具调用次数?: number;
	failure_type?: FailureType;
	实际模型?: string;
	/** F-A7 自报任务态四态（S5 包1）；旧链路/兜底回执缺省。 */
	任务态?: TaskState;
	/** 自报逐条核对（条件/pass|fail|not_run/证据）；消费侧只拦不放行。 */
	verification?: ReceiptVerification[];
	/** 自报改动声明（机械验收与 git 真值比对）。 */
	changes?: ReceiptChange[];
	/** 派发链对外部声明的收窄告警（技能忽略/工具截严，S5 包2）；随回执送达 owner。 */
	派发告警?: string[];
}

/** 必填字段(缺任一判无效):card_no/attempt/status/artifact_path/summary/usage/evidence_path */
export const receiptRequiredFields = [
	"card_no",
	"attempt",
	"status",
	"artifact_path",
	"summary",
	"usage",
	"evidence_path",
] as const;

const statusSet = new Set<WorkerStatus>(["success", "failed", "canceled", "unknown"]);

export interface ReceiptValidation {
	有效: boolean;
	/** 必填字段缺失/为空 */
	缺失: string[];
	/** 字段存在但不合法 */
	问题: string[];
}

function isNumeric(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

export function validateReceipt(receipt: unknown): ReceiptValidation {
	const missing: string[] = [];
	const problem: string[] = [];
	if (typeof receipt !== "object" || receipt === null) {
		return { 有效: false, 缺失: [...receiptRequiredFields], 问题: ["回执不是对象"] };
	}
	const r = receipt as Record<string, unknown>;
	if (typeof r.card_no !== "string" || r.card_no.length === 0) missing.push("card_no");
	if (typeof r.attempt !== "number" || !Number.isInteger(r.attempt) || r.attempt < 1) missing.push("attempt");
	if (typeof r.status !== "string" || !statusSet.has(r.status as WorkerStatus)) {
		(typeof r.status === "undefined" || r.status === "" ? missing : problem).push("status");
	}
	if (r.artifact_path === undefined || r.artifact_path === null || r.artifact_path === "") {
		missing.push("artifact_path");
	} else if (!Array.isArray(r.artifact_path) || r.artifact_path.some((p) => typeof p !== "string")) {
		problem.push("artifact_path");
	}
	if (typeof r.summary !== "string" || r.summary.length === 0) {
		missing.push("summary");
	} else if (r.summary.split("\n").length > 3) {
		problem.push("summary 超过 3 行");
	}
	const usage = r.usage as WorkerUsage | undefined;
	if (typeof usage !== "object" || usage === null) {
		missing.push("usage");
	} else {
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost", "turns"] as const) {
			if (!isNumeric(usage[key])) problem.push(`usage.${key} 不是非负数`);
		}
	}
	if (typeof r.evidence_path !== "string" || r.evidence_path.length === 0) missing.push("evidence_path");
	if (typeof r.exitCode !== "number") problem.push("exitCode 不是数字");
	return { 有效: missing.length === 0 && problem.length === 0, 缺失: missing, 问题: problem };
}

// ── 事件流解析与用量聚合 ────────────────────────────────────────────────

export interface WorkerEventState {
	用量: WorkerUsage;
	stopReason?: string;
	errorMessage?: string;
	model?: string;
	/** 最后一条助手文本(message_end 事件流里的,不是模型自报的账目) */
	最终输出: string;
	/** assistant message_end 未带 usage 的轮数(用量对账:有缺即按「未知」记,不填零,R07) */
	缺用量轮次: number;
	工具调用次数: number;
	开始轮次: number;
}

export function createEventState(): WorkerEventState {
	return {
		用量: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		最终输出: "",
		缺用量轮次: 0,
		工具调用次数: 0,
		开始轮次: 0,
	};
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

/** 解析一行 stdout JSON 事件并聚合;非 JSON 行忽略。返回是否为可解析 JSON。 */
export function absorbEvent(state: WorkerEventState, line: string): boolean {
	if (!line.trim()) return false;
	let event: {
		type?: string;
		id?: string;
		field?: string;
		message?: {
			role?: string;
			model?: string;
			stopReason?: string;
			errorMessage?: string;
			content?: unknown;
			usage?: {
				input?: number;
				output?: number;
				cacheRead?: number;
				cacheWrite?: number;
				totalTokens?: number;
				cost?: number | { total?: number };
			};
		};
	};
	try {
		event = JSON.parse(line);
	} catch {
		return false;
	}
	if (!event || typeof event !== "object") return true;
	if (event.type === "pao_usage_incomplete") {
		state.缺用量轮次++;
		return true;
	}
	if (event.type === "session" && typeof event.id === "string") bindUsageSession(state, event.id);
	if (absorbAuxiliaryUsage(state, event).handled) return true;
	if (event.type === "turn_start") state.开始轮次++;
	if (event.type === "pao_worker_budget_exhausted") state.stopReason = `budget:${event.field ?? "未知"}`;
	if (event.type === "tool_execution_start") state.工具调用次数++;
	if (event.type !== "message_end" || !event.message) return true;
	const msg = event.message;
	if (msg.role !== "assistant") return true;
	if (msg.stopReason === "aborted" && msg.errorMessage === "Operation aborted before provider request") {
		state.stopReason = msg.stopReason;
		state.errorMessage = msg.errorMessage;
		return true;
	}
	const usage = state.用量;
	usage.turns++;
	const u = msg.usage;
	const parsed = normalizeUsage(u);
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost"] as const) usage[key] += parsed.usage[key];
	if (
		parsed.unknown ||
		((msg.stopReason === "error" || msg.stopReason === "aborted") &&
			!(u?.totalTokens || (u?.input ?? 0) + (u?.output ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0)))
	)
		state.缺用量轮次++;
	if (msg.stopReason) state.stopReason = msg.stopReason;
	if (msg.errorMessage) state.errorMessage = msg.errorMessage;
	if (msg.model) state.model = msg.model;
	const text = extractText(msg.content);
	if (text) state.最终输出 = text;
	return true;
}

export interface WorkerFinalResult {
	result: WorkerStatus;
	artifact_path: string[];
	summary: string;
	failure_type?: FailureType;
	/** F-A7 自报任务态（S5 包1）：填了必须是四态之一；缺省＝旧链路未自报。 */
	任务态?: TaskState;
	/** 自报逐条核对（只拦不放行）。 */
	verification?: ReceiptVerification[];
	/** 自报改动声明。 */
	changes?: ReceiptChange[];
}

const TASK_STATE_SET = new Set<string>(["completed", "completed_with_deviations", "blocked", "checkpoint"]);
const VERIFY_RESULTS = new Set<string>(["pass", "fail", "not_run"]);
const CHANGE_TYPES = new Set<string>(["created", "modified", "deleted", "moved", "untouched"]);

/** F-A7 自报三件套形状校验（S5 包1）：任务态四态、verification 结论三值、changes 类型五值。 */
function parseSelfReport(result: Record<string, unknown>): {
	任务态?: TaskState;
	verification?: ReceiptVerification[];
	changes?: ReceiptChange[];
} {
	if (result.任务态 !== undefined && !TASK_STATE_SET.has(String(result.任务态))) {
		throw new Error(`最终回执任务态须为 ${[...TASK_STATE_SET].join("/")}`);
	}
	let verification: ReceiptVerification[] | undefined;
	if (result.verification !== undefined) {
		if (!Array.isArray(result.verification)) throw new Error("最终回执 verification 须为数组");
		verification = result.verification.map((item) => {
			const v = item as Record<string, unknown>;
			if (typeof v.条件 !== "string" || !v.条件.trim()) throw new Error("verification 条目须带非空 条件");
			if (!VERIFY_RESULTS.has(String(v.结论))) throw new Error("verification 条目结论须为 pass/fail/not_run");
			return {
				条件: v.条件,
				结论: v.结论 as ReceiptVerification["结论"],
				...(v.证据 !== undefined ? { 证据: String(v.证据) } : {}),
			};
		});
	}
	let changes: ReceiptChange[] | undefined;
	if (result.changes !== undefined) {
		if (!Array.isArray(result.changes)) throw new Error("最终回执 changes 须为数组");
		changes = result.changes.map((item) => {
			const c = item as Record<string, unknown>;
			if (typeof c.路径 !== "string" || !c.路径.trim()) throw new Error("changes 条目须带非空 路径");
			if (!CHANGE_TYPES.has(String(c.类型)))
				throw new Error("changes 条目类型须为 created/modified/deleted/moved/untouched");
			return {
				路径: c.路径,
				类型: c.类型 as ReceiptChange["类型"],
				...(c.说明 !== undefined ? { 说明: String(c.说明) } : {}),
			};
		});
	}
	return {
		...(result.任务态 !== undefined ? { 任务态: result.任务态 as TaskState } : {}),
		...(verification !== undefined ? { verification } : {}),
		...(changes !== undefined ? { changes } : {}),
	};
}

/** 正式派发只采信最后一条助手消息中的 JSON 回执；退出码 0 本身不代表完成。 */
export function parseWorkerFinalResult(text: string, cwd: string): WorkerFinalResult {
	const body = text
		.trim()
		.replace(/^```(?:json)?\s*\n?/, "")
		.replace(/\n?```$/, "");
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new Error("最终输出缺少有效 JSON 回执（result、artifact_path、summary）");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("最终回执必须为对象");
	const result = parsed as Record<string, unknown>;
	if (typeof result.result !== "string" || !statusSet.has(result.result as WorkerStatus)) {
		throw new Error("最终回执 result 须为 success/failed/canceled/unknown");
	}
	if (!Array.isArray(result.artifact_path) || result.artifact_path.some((p) => typeof p !== "string" || !p.trim())) {
		throw new Error("最终回执 artifact_path 须为路径数组，无文件产物时明确写 []");
	}
	if (typeof result.summary !== "string" || !result.summary.trim() || result.summary.split("\n").length > 3) {
		throw new Error("最终回执 summary 须为非空且不超过 3 行");
	}
	const failureTypes = ["transient", "missing_input", "insufficient_capability", "unknown_outcome"];
	if (
		(result.result === "failed" || result.result === "unknown") &&
		!failureTypes.includes(String(result.failure_type))
	) {
		throw new Error("失败或未知回执须给出 failure_type");
	}
	const artifacts = result.artifact_path as string[];
	const missing = artifacts.filter((p) => !existsSync(isAbsolute(p) ? p : resolve(cwd, p)));
	if (missing.length) throw new Error(`回执声明的产物不存在：${missing.join("、")}`);
	const selfReport = parseSelfReport(result);
	return {
		result: result.result as WorkerStatus,
		artifact_path: artifacts,
		summary: result.summary,
		failure_type: failureTypes.includes(String(result.failure_type))
			? (result.failure_type as FailureType)
			: undefined,
		...selfReport,
	};
}

/** 回执摘要:最终输出前 ≤3 行;空则退回 stderr 前 3 行;再空则占位 */
export function buildSummary(finalOutput: string, stderr: string): string {
	const source = finalOutput.trim() ? finalOutput : stderr;
	const lines = source
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.trim().length > 0)
		.slice(0, 3)
		.map((line) => (line.length > 200 ? `${line.slice(0, 200)}…` : line));
	return lines.length > 0 ? lines.join("\n") : "(无输出)";
}
