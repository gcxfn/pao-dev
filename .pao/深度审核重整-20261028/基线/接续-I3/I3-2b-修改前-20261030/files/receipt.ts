/**
 * 结构化回执:card_no+attempt+status+artifact_path+≤3行summary+usage+evidence_path(架构 §2 回执格式)。
 * 用量只从子进程 stdout JSON 事件流(message_end)取,不采信模型正文自报。
 */

import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { FailureType, ReceiptChange, ReceiptVerification, TaskState } from "../cards/types.ts";
import { extractTextContent } from "../shared/text-content.ts";
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

export interface WorkerReceiptToolEvent {
	toolCallId: string;
	args: unknown;
	/** undefined=已开始但尚未收到结束事件；true=成功结束；false=失败结束。 */
	succeeded?: boolean;
}

export type WorkerToolExecutionEvent =
	| {
			type: "tool_execution_start";
			toolCallId: string;
			toolName: string;
			args: unknown;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: unknown;
			isError: boolean;
	  };

/** 回执收取与只读证据事实共用的工具事件边界，坏的调用标识/结束标记不进入调用方。 */
export function parseWorkerToolExecutionEvent(value: unknown): WorkerToolExecutionEvent | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const event = value as Record<string, unknown>;
	if (
		typeof event.toolCallId !== "string" ||
		!event.toolCallId ||
		typeof event.toolName !== "string" ||
		!event.toolName
	) {
		return undefined;
	}
	if (event.type === "tool_execution_start") {
		return {
			type: event.type,
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
		};
	}
	if (event.type === "tool_execution_end" && typeof event.isError === "boolean") {
		return {
			type: event.type,
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			result: event.result,
			isError: event.isError,
		};
	}
	return undefined;
}

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
	/** 严格入口拒收后，仅凭唯一完整 json 围栏或唯一裸 JSON 对象与严格 schema 恢复的审计标记；不表示直接成功。 */
	receipt_format_recovery?: {
		/** 原始严格解析错误，原样留痕。 */
		strict_error: string;
		/** 实际命中的恢复外壳；缺省只为兼容旧调用方。 */
		recognized_by?: "fenced" | "bare";
		/**
		 * 格式恢复审计文件；写方须在同一原始证据目录留档唯一候选规则、严格错误和原证据引用。
		 * 缺省表示调用方尚未落审计文件，不能把它当成已验证恢复。
		 */
		evidence_path?: string;
	};
	/** 结构化结果实际取自工具、严格文本或受控文本恢复。 */
	result_source?: WorkerResultSource;
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
	/** 本子进程事件流收到的回执工具调用；结束事件按 toolCallId 回填。 */
	receipt_tool_calls: WorkerReceiptToolEvent[];
}

export function createEventState(): WorkerEventState {
	return {
		用量: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		最终输出: "",
		缺用量轮次: 0,
		工具调用次数: 0,
		开始轮次: 0,
		receipt_tool_calls: [],
	};
}

/** 解析一行 stdout JSON 事件并聚合;非 JSON 行忽略。返回是否为可解析 JSON。 */
export function absorbEvent(state: WorkerEventState, line: string): boolean {
	if (!line.trim()) return false;
	let event: {
		type?: string;
		id?: string;
		field?: string;
		toolCallId?: string;
		toolName?: string;
		args?: unknown;
		isError?: boolean;
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
	const toolEvent = parseWorkerToolExecutionEvent(event);
	if (toolEvent?.type === "tool_execution_start") {
		state.工具调用次数++;
		if (toolEvent.toolName === RECEIPT_TOOL_NAME) {
			state.receipt_tool_calls.push({
				toolCallId: toolEvent.toolCallId,
				args: toolEvent.args,
			});
		}
	}
	if (toolEvent?.type === "tool_execution_end") {
		if (toolEvent.toolName !== RECEIPT_TOOL_NAME) return true;
		const call = state.receipt_tool_calls.find((candidate) => candidate.toolCallId === toolEvent.toolCallId);
		if (call) {
			// 同一调用只能结束一次；重复结束即使内容互相矛盾也整份拒绝，不能由最后一条覆盖。
			call.succeeded = call.succeeded === undefined ? toolEvent.isError === false : false;
		}
	}
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
	const text = extractTextContent(msg.content);
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

export type WorkerResultSource = "tool" | "text" | "text_recovery";

export interface WorkerResultEvaluation {
	result: WorkerFinalResult;
	source: WorkerResultSource;
	receiptText?: string;
	strictError?: string;
	recognizedBy?: "fenced" | "bare";
}

export type WorkerFinalReceiptDiagnostic =
	| {
			kind: "strict";
			parsed: WorkerFinalResult;
			rawText: string;
			receiptText: string;
	  }
	| {
			kind: "fenced" | "bare";
			parsed: WorkerFinalResult;
			rawText: string;
			receiptText: string;
			strictError: string;
	  };

/**
 * runner 的受控格式恢复：先确认正式解析失败，再且仅再接受唯一完整 json 围栏，
 * 或普通说明文字中唯一完整裸 JSON 对象。错误 schema 仍返回 undefined；
 * 原错误与原文由诊断对象原样带回。
 */
export function recoverWorkerFinalReceiptFormat(
	text: string,
	cwd: string,
): Extract<WorkerFinalReceiptDiagnostic, { kind: "fenced" | "bare" }> | undefined {
	let diagnosis: WorkerFinalReceiptDiagnostic;
	try {
		diagnosis = diagnoseWorkerFinalReceipt(text, cwd);
	} catch {
		return undefined;
	}
	return diagnosis.kind === "strict" ? undefined : diagnosis;
}

const TASK_STATE_SET = new Set<string>(["completed", "completed_with_deviations", "blocked", "checkpoint"]);
const VERIFY_RESULTS = new Set<string>(["pass", "fail", "not_run"]);
const CHANGE_TYPES = new Set<string>(["created", "modified", "deleted", "moved", "untouched"]);
const WORKER_RESULT_FIELDS = new Set([
	"result",
	"artifact_path",
	"summary",
	"failure_type",
	"任务态",
	"verification",
	"changes",
]);

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
			if (item === null || typeof item !== "object" || Array.isArray(item)) {
				throw new Error("verification 条目须为对象");
			}
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
			if (item === null || typeof item !== "object" || Array.isArray(item)) {
				throw new Error("changes 条目须为对象");
			}
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

function pathIsOutside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function validateArtifactPaths(artifacts: string[], executionRoot: string): void {
	if (artifacts.length === 0) return;
	let canonicalRoot: string;
	try {
		canonicalRoot = realpathSync.native(resolve(executionRoot));
	} catch {
		throw new Error(`当前执行根不可用，拒绝解析产物：${resolve(executionRoot)}`);
	}
	const missing: string[] = [];
	for (const artifact of artifacts) {
		if (isAbsolute(artifact)) {
			throw new Error(`回执声明的产物须使用相对当前执行根的路径：${artifact}`);
		}
		const candidate = resolve(canonicalRoot, artifact);
		if (pathIsOutside(canonicalRoot, candidate)) {
			throw new Error(`回执声明的产物越出当前执行根：${artifact}`);
		}
		if (!existsSync(candidate)) {
			missing.push(artifact);
			continue;
		}
		let realCandidate: string;
		try {
			realCandidate = realpathSync.native(candidate);
		} catch {
			missing.push(artifact);
			continue;
		}
		if (pathIsOutside(canonicalRoot, realCandidate)) {
			throw new Error(`回执声明的产物经链接越出当前执行根：${artifact}`);
		}
	}
	if (missing.length) throw new Error(`回执声明的产物不存在：${missing.join("、")}`);
}

/**
 * 旧文本回执只保留 worker 可声明的字段，并把执行根内绝对产物路径规范为相对路径。
 * 这是入口兼容层；字段、内容与最终 realpath 边界仍由下方共用验证器统一核验。
 */
function normalizeLegacyWorkerResultInput(input: unknown, executionRoot: string): unknown {
	if (!input || typeof input !== "object" || Array.isArray(input)) return input;
	const source = input as Record<string, unknown>;
	const normalized: Record<string, unknown> = {};
	for (const field of WORKER_RESULT_FIELDS) {
		if (Object.prototype.hasOwnProperty.call(source, field)) normalized[field] = source[field];
	}
	if (!Array.isArray(normalized.artifact_path)) return normalized;
	const lexicalRoot = resolve(executionRoot);
	normalized.artifact_path = normalized.artifact_path.map((artifact) => {
		if (typeof artifact !== "string" || !isAbsolute(artifact)) return artifact;
		const absoluteArtifact = resolve(artifact);
		if (pathIsOutside(lexicalRoot, absoluteArtifact)) {
			throw new Error(`旧文本回执声明的绝对产物越出当前执行根：${artifact}`);
		}
		return relative(lexicalRoot, absoluteArtifact);
	});
	return normalized;
}

/**
 * 工具参数与规范化后的旧文本回执共用的唯一字段验证器。
 * 工具参数直接验证，夹带程序事实即拒绝；旧文本入口先忽略这些字段，不把它们传入验证器。
 */
export function validateWorkerResultInput(input: unknown, executionRoot: string): WorkerFinalResult {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("最终回执必须为对象");
	const result = input as Record<string, unknown>;
	const unknownFields = Object.keys(result).filter((key) => !WORKER_RESULT_FIELDS.has(key));
	if (unknownFields.length) {
		throw new Error(`最终回执含不允许由 worker 提交的字段：${unknownFields.join("、")}`);
	}
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
	if (result.failure_type !== undefined && !failureTypes.includes(String(result.failure_type))) {
		throw new Error("最终回执 failure_type 须为 transient/missing_input/insufficient_capability/unknown_outcome");
	}
	const artifacts = result.artifact_path as string[];
	validateArtifactPaths(artifacts, executionRoot);
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

function parseJsonReceiptBody(body: string, executionRoot: string): WorkerFinalResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new Error("最终输出缺少有效 JSON 回执（result、artifact_path、summary）");
	}
	return validateWorkerResultInput(normalizeLegacyWorkerResultInput(parsed, executionRoot), executionRoot);
}

function legacyStrictReceiptBody(text: string): string {
	return text
		.trim()
		.replace(/^```(?:json)?\s*\n?/, "")
		.replace(/\n?```$/, "");
}

interface ReceiptEnvelopeCandidate {
	kind: "fenced" | "bare";
	receiptText: string;
}

interface MarkdownFenceBlock {
	language: string;
	body: string;
}

interface OpenedMarkdownFence {
	markerChar: "`" | "~";
	markerLength: number;
	language: string;
	bodyStart: number;
}

/** 以 Markdown 行语义配对代码围栏；围栏内容不参与裸 JSON 候选扫描。 */
function scanMarkdownFences(text: string): { blocks: MarkdownFenceBlock[]; outsideSegments: string[] } {
	const blocks: MarkdownFenceBlock[] = [];
	const outsideSegments: string[] = [];
	let opened: OpenedMarkdownFence | undefined;
	let lineStart = 0;
	let outsideStart = 0;
	while (lineStart < text.length) {
		const newline = text.indexOf("\n", lineStart);
		const contentEnd = newline < 0 ? text.length : newline;
		const lineEnd = newline < 0 ? text.length : newline + 1;
		const line = text.slice(lineStart, contentEnd).replace(/\r$/, "");
		const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (opened) {
			if (
				marker &&
				marker[1]![0] === opened.markerChar &&
				marker[1]!.length >= opened.markerLength &&
				/^[ \t]*$/.test(marker[2]!)
			) {
				const body = text.slice(opened.bodyStart, lineStart);
				if (/^ {0,3}(?:`{3,}|~{3,})/m.test(body)) {
					throw new Error("最终回执不接受嵌套代码围栏");
				}
				blocks.push({ language: opened.language, body });
				opened = undefined;
				outsideStart = lineEnd;
			}
		} else if (marker) {
			const markerText = marker[1]!;
			if (markerText[0] === "`" && marker[2]!.includes("`")) {
				throw new Error("最终回执代码围栏信息串无效");
			}
			outsideSegments.push(text.slice(outsideStart, lineStart));
			opened = {
				markerChar: markerText[0] as "`" | "~",
				markerLength: markerText.length,
				language: marker[2]!.trim(),
				bodyStart: lineEnd,
			};
		}
		lineStart = lineEnd;
	}
	if (opened) throw new Error("最终回执代码围栏未闭合");
	outsideSegments.push(text.slice(outsideStart));
	if (outsideSegments.some((segment) => /```|~~~/.test(segment))) {
		throw new Error("最终回执不接受伪代码围栏");
	}
	return { blocks, outsideSegments };
}

/**
 * 判断一段文本是否像在尝试写 JSON 值。这里只决定“是否计入候选”，不解析 JSON；
 * 围栏外默认不把空对象当候选，围栏内保留原语义，真正合法性仍由后置
 * JSON.parse 与严格 schema 判断。
 */
function quotedStringEnd(text: string, start: number): number {
	const quote = text[start];
	let escaped = false;
	for (let index = start + 1; index < text.length; index++) {
		const char = text[index];
		if (escaped) escaped = false;
		else if (char === "\\") escaped = true;
		else if (char === quote) return index;
	}
	return -1;
}

function followsArrayElement(text: string, start: number): boolean {
	const next = text.slice(start).trimStart()[0];
	return next === "," || next === "]";
}

function looksLikeJsonArrayElement(text: string): boolean {
	const body = text.trimStart();
	const first = body[0];
	if (first === undefined || first === "]") return true;
	if (first === "{" || first === "[") return true;
	if (first === '"' || first === "'") {
		const end = quotedStringEnd(body, 0);
		return end < 0 || followsArrayElement(body, end + 1);
	}
	return first === "-" || first === "," || /[0-9tfn]/.test(first);
}

function looksLikeAttemptedJson(text: string, allowEmptyObject = false): boolean {
	const trimmed = text.trimStart();
	if (trimmed.startsWith("{")) {
		const body = trimmed.slice(1).trimStart();
		if (body.startsWith("}")) return allowEmptyObject;
		if (!body.startsWith('"') && !body.startsWith("'")) return false;
		const keyEnd = quotedStringEnd(body, 0);
		return keyEnd < 0 || /^\s*:/.test(body.slice(keyEnd + 1));
	}
	if (trimmed.startsWith("[")) return looksLikeJsonArrayElement(trimmed.slice(1));
	return false;
}

function balancedJsonEnd(text: string, start: number): { end?: number; error?: string } {
	const expectedClosers: string[] = [];
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index++) {
		const char = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "{") expectedClosers.push("}");
		else if (char === "[") expectedClosers.push("]");
		else if (char === "}" || char === "]") {
			if (expectedClosers.at(-1) !== char) return { error: "JSON 候选结构符不配对" };
			expectedClosers.pop();
			if (expectedClosers.length === 0) return { end: index };
		}
	}
	return { error: "JSON 候选结构未闭合" };
}

function bareReceiptCandidates(segment: string): ReceiptEnvelopeCandidate[] {
	const candidates: ReceiptEnvelopeCandidate[] = [];
	let index = 0;
	while (index < segment.length) {
		if (segment[index] !== "{" && segment[index] !== "[") {
			index++;
			continue;
		}
		if (!looksLikeAttemptedJson(segment.slice(index))) {
			index++;
			continue;
		}
		const balanced = balancedJsonEnd(segment, index);
		if (balanced.end === undefined) {
			throw new Error(`最终回执 ${balanced.error}，拒绝猜测回执边界`);
		}
		const receiptText = segment.slice(index, balanced.end + 1);
		candidates.push({ kind: "bare", receiptText });
		index = balanced.end + 1;
	}
	return candidates;
}

function receiptEnvelopeCandidates(text: string): ReceiptEnvelopeCandidate[] {
	const { blocks, outsideSegments } = scanMarkdownFences(text);
	const candidates: ReceiptEnvelopeCandidate[] = [];
	for (const block of blocks) {
		const language = block.language.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
		const body = block.body.trim();
		if (language.startsWith("json") || (language === "" && looksLikeAttemptedJson(body, true))) {
			candidates.push({ kind: "fenced", receiptText: body });
		}
	}
	for (const segment of outsideSegments) candidates.push(...bareReceiptCandidates(segment));
	return candidates;
}

/**
 * 正式派发只采信最后一条助手消息中的 JSON 回执；退出码 0 本身不代表完成。
 * 为避免放宽正式契约，保留“说明包着 JSON”仍拒收；恢复走 diagnoseWorkerFinalReceipt。
 */
export function parseWorkerFinalResult(text: string, cwd: string): WorkerFinalResult {
	return parseJsonReceiptBody(legacyStrictReceiptBody(text), cwd);
}

/**
 * 回执格式诊断：正式解析失败时，只接受普通说明中的唯一完整 JSON 回执候选。
 * 非 JSON 代码块不参与候选计数；候选正文仍交现有严格 schema 与产物检查。
 * runner 仅在同一 dispatch、首次落回执前使用该结果；它本身不改卡状态，也不代替机械验收。
 */
export function diagnoseWorkerFinalReceipt(text: string, cwd: string): WorkerFinalReceiptDiagnostic {
	let strictError: string;
	try {
		return {
			kind: "strict",
			parsed: parseWorkerFinalResult(text, cwd),
			rawText: text,
			receiptText: legacyStrictReceiptBody(text),
		};
	} catch (error) {
		strictError = error instanceof Error ? error.message : String(error);
	}
	const candidates = receiptEnvelopeCandidates(text);
	if (candidates.length !== 1) {
		throw new Error(
			`最终回执格式不唯一：严格解析失败（${strictError}），找到 ${candidates.length} 个完整 JSON 回执候选`,
		);
	}
	const candidate = candidates[0]!;
	let parsed: WorkerFinalResult;
	try {
		parsed = parseJsonReceiptBody(candidate.receiptText, cwd);
	} catch (error) {
		throw new Error(
			`最终回执${candidate.kind === "fenced" ? "围栏内容" : "裸 JSON 对象"}未通过严格 schema（${error instanceof Error ? error.message : String(error)}；严格解析原错误：${strictError}）`,
		);
	}
	return { kind: candidate.kind, parsed, rawText: text, receiptText: candidate.receiptText, strictError };
}

/**
 * 收取一次 worker 结果。有回执工具调用时只采信唯一次成功工具参数；工具开始、
 * 失败或重复均拒绝，成功后最后消息可写普通文本。没有工具回执时才走旧文本兼容链。
 */
export function evaluateWorkerResult(input: {
	toolReceipts?: readonly WorkerReceiptToolEvent[];
	finalText: string;
	executionRoot: string;
}): WorkerResultEvaluation {
	const toolReceipts = input.toolReceipts ?? [];
	if (toolReceipts.length > 0) {
		const unresolved = toolReceipts.filter((receipt) => receipt.succeeded === undefined);
		if (unresolved.length > 0) {
			throw new Error("回执工具已开始但未收到成功结束事件，拒绝改用文本回执");
		}
		const successful = toolReceipts.filter((receipt) => receipt.succeeded === true);
		if (successful.length === 0) {
			throw new Error("回执工具执行失败，拒绝采信参数或改用文本回执");
		}
		if (successful.length !== 1) {
			throw new Error(`收到 ${successful.length} 次成功回执工具调用，结构化结果必须唯一`);
		}
		const toolReceipt = successful[0]!;
		const result = validateWorkerResultInput(toolReceipt.args, input.executionRoot);
		return {
			result,
			source: "tool",
			receiptText: JSON.stringify(toolReceipt.args),
		};
	}
	const diagnosis = diagnoseWorkerFinalReceipt(input.finalText, input.executionRoot);
	return diagnosis.kind === "strict"
		? {
				result: diagnosis.parsed,
				source: "text",
				receiptText: diagnosis.receiptText,
			}
		: {
				result: diagnosis.parsed,
				source: "text_recovery",
				receiptText: diagnosis.receiptText,
				strictError: diagnosis.strictError,
				recognizedBy: diagnosis.kind,
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
