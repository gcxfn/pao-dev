/**
 * 工作流运行策略与审核字段约束的单一来源。
 *
 * 这里只放跨调用点共享的事实：运行方式解析、判定字段规则、待决与结果的基础形状。
 * 持久状态迁移放在 transition.ts；控制文件读写仍由 control.ts 负责。
 */

import type { SubmissionSkip } from "../cards/delivery.ts";

export const CONTROL_RUN_MODES = ["有人值守", "无人值守"] as const;
export type ControlRunMode = (typeof CONTROL_RUN_MODES)[number];
export type WorkflowRunMode = "attended" | "unattended";

export const DECISION_REASON_MAX_CHARS = 1600;
export const DECISION_REASON_MAX_WORDS = 400;
/** 本批无人值守待决的可执行默认截止；后续真实离线上限治理可替换为配方预算。 */
export const PENDING_DEFAULT_TTL_MS = 30 * 60 * 1000;

export const DECISION_REASON_DESCRIPTION =
	"审核理由，保留全文，不截断；须非空、最多 400 个词（中文逐字计）且最多 1600 个字符";
export const DECISION_REFERENCES_DESCRIPTION =
	"证据引用列表，至少 1 项；每项须以非空路径开头并以“:<行号>”结尾，行号从 1 起，例如 src/file.ts:12";
export const DECISION_POLICY_DESCRIPTION = `${DECISION_REASON_DESCRIPTION}；${DECISION_REFERENCES_DESCRIPTION}。字段错误会指出 reason 或 references[索引]。`;

export type PendingChannel = "主控" | "人工";
export type PendingKind = "普通偏差" | "部长hold" | "普通裁定" | "人工确认";
export type PendingPhase = "待处理" | "已过期" | "已完成";
export type PendingDefaultAction = "failed" | "stop_unconfirmed";
export type ControlResultState = "failed" | "canceled" | "stop_unconfirmed";

export interface WorkflowPendingItem {
	item_ref: string;
	card_ref: string;
	card_no: number;
	attempt: number;
	verification_index: number;
	condition: string;
	report: "fail" | "not_run";
	evidence?: string;
}

export interface WorkflowPending {
	key: string;
	kind: PendingKind;
	channel: PendingChannel;
	instance: string;
	node: string;
	round: number;
	card_ref?: string;
	attempt?: number;
	reason: string;
	created_at: string;
	deadline: string;
	default_action: PendingDefaultAction;
	phase: PendingPhase;
	/** 只对不依赖逐条偏差的事项使用；普通偏差必须恰好覆盖 items。 */
	items: WorkflowPendingItem[];
}

export interface ControlResult {
	state: ControlResultState;
	reason: string;
	time: string;
	/** 结构化待决身份；旧结果可缺省。 */
	pending_key?: string;
	/** 业务结果已经确定，但不得据此宣称执行写者已停止。 */
	writer_stop_confirmed?: boolean;
}

export type PendingResolutionStage =
	| "validated"
	| "reviewed"
	| "delivered"
	| "submitted"
	| "pending_cleared"
	| "completed"
	| "validation_failed"
	| "review_failed"
	| "delivery_failed"
	| "submission_failed";

export interface PendingResolutionDecision {
	item_ref: string;
	attempt: number;
	verification_index: number;
	condition: string;
	basis: string;
}

/** 独立审核只交证据，副本里的验证脚本不能合并进业务根。 */
export interface IndependentReviewSubmissionSkip {
	reason: "independent_review_evidence";
	attempt: number;
	binding_digest: string;
	source_tree: string;
	copy_tree: string;
}

/**
 * 单次待决办理的阶段正本。放在 FlowControl 内，使“验收已过但 commit 未成”
 * 这类控制阶段与卡五态分开保存；记录不含调用方提交的实例、节点或 attempt。
 */
export interface PendingResolutionRecord {
	pending_key: string;
	instance: string;
	node: string;
	round: number;
	card_ref: string;
	card_no: number;
	attempt: number;
	input_digest: string;
	decisions: PendingResolutionDecision[];
	stage: PendingResolutionStage;
	created_at: string;
	updated_at: string;
	failure?: { stage: "validation" | "review" | "delivery" | "submission"; message: string; time: string };
	/** 待决办理完成后的自动链受理阶段；缺省表示尚未受理，可安全恢复推进。 */
	advance?: {
		status: "accepted";
		accepted_at: string;
	};
	submission?: {
		交卷: boolean;
		提交哈希?: string;
		原因?: string;
		消息: string;
		暂存文件: string[];
		skip?: SubmissionSkip | IndependentReviewSubmissionSkip;
	};
}

export interface DecisionFieldInput {
	reason: unknown;
	references: unknown;
}

export interface DecisionFieldProblem {
	field: string;
	message: string;
}

/**
 * 模型只能提出不超过宿主可信级别的运行方式；可信值默认有人值守。
 * 例如宿主授权 unattended 时，模型可显式降为 attended；反向提权一律在落盘前拒绝。
 */
export function resolveControlRunMode(requested: unknown, trusted: unknown = "attended"): ControlRunMode {
	if (requested !== undefined && requested !== "attended" && requested !== "unattended")
		throw new Error(`启动参数 run_mode 须为 attended 或 unattended；收到 ${JSON.stringify(requested)}`);
	if (trusted !== "attended" && trusted !== "unattended")
		throw new Error(`可信宿主运行方式配置无效：须为 attended 或 unattended；收到 ${JSON.stringify(trusted)}`);
	if (requested === "unattended" && trusted !== "unattended")
		throw new Error(
			"启动参数 run_mode 冲突：请求 unattended，但可信宿主仅授权 attended；模型参数不能自行开启无人值守",
		);
	const selected = requested ?? trusted;
	return selected === "unattended" ? "无人值守" : "有人值守";
}

/** 人工确认门必须由真实交互完成；无人值守实例在创建前直接拒绝。 */
export function assertRunModeAllowsRecipeGates(
	nodes: readonly { 人工确认?: boolean }[],
	runMode: ControlRunMode,
): void {
	if (runMode === "无人值守" && nodes.some((node) => node.人工确认)) {
		throw new Error("配方含人工确认门，无人值守实例不能越过人工门；请在启动前改用有人值守或移除该门");
	}
}

/** run_mode 是启动策略，不是配方占位符；解析后必须从持久参数中移除。 */
export function splitControlRunModeParams(params: Readonly<Record<string, string>>): {
	params: Record<string, string>;
	requested?: WorkflowRunMode;
} {
	const { run_mode: requested, ...rest } = params;
	if (requested !== undefined && requested !== "attended" && requested !== "unattended")
		throw new Error(`启动参数 run_mode 须为 attended 或 unattended；收到 ${JSON.stringify(requested)}`);
	return {
		params: rest,
		...(requested !== undefined ? { requested } : {}),
	};
}

export function displayRunMode(mode: ControlRunMode): WorkflowRunMode {
	return mode === "无人值守" ? "unattended" : "attended";
}

/** 旧实例没有该字段；缺省必须是有人值守，不能默认为自动放行。 */
export function storedControlRunMode(value: unknown): ControlRunMode {
	if (value === undefined) return "有人值守";
	if (value === "有人值守" || value === "无人值守") return value;
	throw new Error("控制清单运行方式损坏：只允许 有人值守 或 无人值守");
}

export function isUnattended(flow: { 运行方式?: ControlRunMode }): boolean {
	return flow.运行方式 === "无人值守";
}

export function decisionFieldProblems(input: DecisionFieldInput): DecisionFieldProblem[] {
	const problems: DecisionFieldProblem[] = [];
	if (typeof input.reason !== "string") {
		problems.push({ field: "reason", message: "须为字符串且不能省略" });
	} else if (!input.reason.trim()) {
		problems.push({ field: "reason", message: "不能为空" });
	} else {
		const chars = input.reason.length;
		const words = input.reason.match(/[\p{Script=Han}]|[\p{L}\p{N}_]+/gu)?.length ?? 0;
		if (chars > DECISION_REASON_MAX_CHARS)
			problems.push({
				field: "reason",
				message: `超过 ${DECISION_REASON_MAX_CHARS} 个字符（实为 ${chars}），请精简后重交；原文未截断`,
			});
		if (words > DECISION_REASON_MAX_WORDS)
			problems.push({
				field: "reason",
				message: `超过 ${DECISION_REASON_MAX_WORDS} 个词（中文逐字计，实为 ${words}），请精简后重交；原文未截断`,
			});
	}
	if (!Array.isArray(input.references)) {
		problems.push({ field: "references", message: "须为非空字符串数组" });
		return problems;
	}
	if (input.references.length === 0) problems.push({ field: "references", message: "至少需要 1 项" });
	input.references.forEach((reference, index) => {
		if (typeof reference !== "string" || !reference.trim()) {
			problems.push({ field: `references[${index}]`, message: "须为非空字符串" });
			return;
		}
		if (!/^.+:0*[1-9]\d*$/.test(reference))
			problems.push({
				field: `references[${index}]`,
				message: `须以“路径:行号”结尾，行号从 1 起；收到 ${JSON.stringify(reference)}`,
			});
	});
	return problems;
}

export function formatDecisionFieldProblems(problems: readonly DecisionFieldProblem[]): string {
	return problems.map((problem) => `${problem.field}: ${problem.message}`).join("；");
}

export function pendingKey(input: {
	kind: PendingKind;
	instance: string;
	node: string;
	round: number;
	cardRef?: string;
	attempt?: number;
}): string {
	return [
		input.kind,
		input.instance,
		input.node,
		String(input.round),
		input.cardRef ?? "-",
		input.attempt === undefined ? "-" : String(input.attempt),
	].join(":");
}

export function pendingDeadline(createdAt: string, ttlMs = PENDING_DEFAULT_TTL_MS): string {
	const created = Date.parse(createdAt);
	if (!Number.isFinite(created)) throw new Error(`待决 created_at 不是可解析时间：${JSON.stringify(createdAt)}`);
	if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("待决截止时长须为正整数毫秒");
	return new Date(created + ttlMs).toISOString();
}

export function validatePending(value: unknown): string[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return ["待决须为映射"];
	const pending = value as Partial<WorkflowPending>;
	const problems: string[] = [];
	for (const field of ["key", "instance", "node", "reason", "created_at", "deadline"] as const)
		if (typeof pending[field] !== "string" || !pending[field].trim())
			problems.push(`待决字段 ${field} 须为非空字符串`);
	if (!["普通偏差", "部长hold", "普通裁定", "人工确认"].includes(String(pending.kind)))
		problems.push("待决 kind 无效");
	if (!["主控", "人工"].includes(String(pending.channel))) problems.push("待决 channel 无效");
	if (!Number.isSafeInteger(pending.round) || (pending.round ?? 0) < 1) problems.push("待决 round 须为正整数");
	if (pending.card_ref !== undefined && (typeof pending.card_ref !== "string" || !pending.card_ref.trim()))
		problems.push("待决 card_ref 损坏");
	if (pending.attempt !== undefined && (!Number.isSafeInteger(pending.attempt) || pending.attempt < 1))
		problems.push("待决 attempt 须为正整数");
	if (!["failed", "stop_unconfirmed"].includes(String(pending.default_action)))
		problems.push("待决 default_action 无效");
	if (!["待处理", "已过期", "已完成"].includes(String(pending.phase))) problems.push("待决 phase 无效");
	const createdAt = typeof pending.created_at === "string" ? Date.parse(pending.created_at) : Number.NaN;
	const deadline = typeof pending.deadline === "string" ? Date.parse(pending.deadline) : Number.NaN;
	if (!Number.isFinite(createdAt)) problems.push("待决 created_at 须为可解析时间");
	if (!Number.isFinite(deadline)) problems.push("待决 deadline 须为可解析时间");
	if (Number.isFinite(createdAt) && Number.isFinite(deadline) && deadline < createdAt)
		problems.push("待决 deadline 不能早于 created_at");
	if (
		typeof pending.key === "string" &&
		typeof pending.node === "string" &&
		typeof pending.instance === "string" &&
		Number.isSafeInteger(pending.round) &&
		["普通偏差", "部长hold", "普通裁定", "人工确认"].includes(String(pending.kind))
	) {
		const expected = pendingKey({
			kind: pending.kind as PendingKind,
			instance: pending.instance,
			node: pending.node,
			round: pending.round!,
			...(pending.card_ref !== undefined ? { cardRef: pending.card_ref } : {}),
			...(pending.attempt !== undefined ? { attempt: pending.attempt } : {}),
		});
		if (pending.key !== expected) problems.push(`待决 key 与身份字段不一致；期望 ${expected}`);
	}
	const expectedChannel = pending.kind === "人工确认" ? "人工" : pending.kind === undefined ? undefined : "主控";
	if (expectedChannel !== undefined && pending.channel !== expectedChannel)
		problems.push(`待决 ${pending.kind} 的 channel 须为 ${expectedChannel}`);
	const expectedAction = pending.kind === "人工确认" ? "stop_unconfirmed" : "failed";
	if (pending.kind !== undefined && pending.default_action !== expectedAction)
		problems.push(`待决 ${pending.kind} 的 default_action 须为 ${expectedAction}`);
	if (!Array.isArray(pending.items)) {
		problems.push("待决 items 须为数组");
	} else {
		const refs = new Set<string>();
		for (const [index, item] of pending.items.entries()) {
			if (!item || typeof item !== "object") {
				problems.push(`待决 items[${index}] 损坏`);
				continue;
			}
			for (const field of ["item_ref", "card_ref", "condition"] as const)
				if (typeof item[field] !== "string" || !item[field].trim())
					problems.push(`待决 items[${index}].${field} 损坏`);
			for (const field of ["card_no", "attempt", "verification_index"] as const)
				if (!Number.isSafeInteger(item[field]) || item[field] < (field === "verification_index" ? 0 : 1))
					problems.push(`待决 items[${index}].${field} 损坏`);
			if (!["fail", "not_run"].includes(String(item.report))) problems.push(`待决 items[${index}].report 无效`);
			if (refs.has(item.item_ref)) problems.push(`待决 item_ref 重复：${item.item_ref}`);
			refs.add(item.item_ref);
			if (pending.card_ref !== undefined && item.card_ref !== pending.card_ref)
				problems.push(`待决 items[${index}].card_ref 与待决身份不一致`);
			if (pending.attempt !== undefined && item.attempt !== pending.attempt)
				problems.push(`待决 items[${index}].attempt 与待决身份不一致`);
		}
	}
	return problems;
}

const PENDING_RESOLUTION_STAGES: readonly PendingResolutionStage[] = [
	"validated",
	"reviewed",
	"delivered",
	"submitted",
	"pending_cleared",
	"completed",
	"validation_failed",
	"review_failed",
	"delivery_failed",
	"submission_failed",
];

function validPendingSubmissionSkip(value: unknown, attempt: number): boolean {
	if (!value || typeof value !== "object") return false;
	const skip = value as Record<string, unknown>;
	if (skip.attempt !== attempt || typeof skip.binding_digest !== "string" || !skip.binding_digest.trim()) return false;
	if (skip.reason === "no_worker_changes")
		return (
			typeof skip.baseline_tree === "string" &&
			!!skip.baseline_tree.trim() &&
			skip.baseline_tree === skip.current_tree
		);
	return (
		skip.reason === "independent_review_evidence" &&
		typeof skip.source_tree === "string" &&
		/^[a-f0-9]{40,64}$/i.test(skip.source_tree) &&
		typeof skip.copy_tree === "string" &&
		/^[a-f0-9]{40,64}$/i.test(skip.copy_tree)
	);
}

export function validatePendingResolutionRecords(value: unknown): string[] {
	if (!Array.isArray(value)) return ["待决办理记录须为数组"];
	const problems: string[] = [];
	const keys = new Set<string>();
	for (const [index, raw] of value.entries()) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			problems.push(`待决办理记录第 ${index + 1} 项损坏`);
			continue;
		}
		const record = raw as Partial<PendingResolutionRecord>;
		for (const field of ["pending_key", "instance", "node", "card_ref", "input_digest"] as const)
			if (typeof record[field] !== "string" || !record[field]!.trim())
				problems.push(`待决办理记录第 ${index + 1} 项 ${field} 损坏`);
		for (const field of ["round", "card_no", "attempt"] as const)
			if (!Number.isSafeInteger(record[field]) || (record[field] ?? 0) < 1)
				problems.push(`待决办理记录第 ${index + 1} 项 ${field} 损坏`);
		if (typeof record.input_digest === "string" && !/^sha256:[a-f0-9]{64}$/.test(record.input_digest))
			problems.push(`待决办理记录第 ${index + 1} 项 input_digest 损坏`);
		if (typeof record.pending_key === "string") {
			if (keys.has(record.pending_key)) problems.push(`待决办理记录重复：${record.pending_key}`);
			keys.add(record.pending_key);
		}
		if (!PENDING_RESOLUTION_STAGES.includes(record.stage as PendingResolutionStage))
			problems.push(`待决办理记录第 ${index + 1} 项 stage 无效`);
		if (!Array.isArray(record.decisions)) {
			problems.push(`待决办理记录第 ${index + 1} 项 decisions 须为数组`);
		} else {
			const refs = new Set<string>();
			for (const [decisionIndex, decision] of record.decisions.entries()) {
				if (
					!decision ||
					typeof decision !== "object" ||
					typeof decision.item_ref !== "string" ||
					!decision.item_ref.trim() ||
					!Number.isSafeInteger(decision.attempt) ||
					decision.attempt < 1 ||
					!Number.isSafeInteger(decision.verification_index) ||
					decision.verification_index < 0 ||
					typeof decision.condition !== "string" ||
					!decision.condition.trim() ||
					typeof decision.basis !== "string" ||
					!decision.basis.trim()
				)
					problems.push(`待决办理记录第 ${index + 1} 项 decisions[${decisionIndex}] 损坏`);
				else {
					if (refs.has(decision.item_ref))
						problems.push(`待决办理记录第 ${index + 1} 项 item_ref 重复：${decision.item_ref}`);
					refs.add(decision.item_ref);
				}
			}
		}
		for (const field of ["created_at", "updated_at"] as const)
			if (typeof record[field] !== "string" || !Number.isFinite(Date.parse(record[field]!)))
				problems.push(`待决办理记录第 ${index + 1} 项 ${field} 损坏`);
		if (
			record.failure !== undefined &&
			(!["validation", "review", "delivery", "submission"].includes(String(record.failure.stage)) ||
				typeof record.failure.message !== "string" ||
				!record.failure.message.trim() ||
				typeof record.failure.time !== "string" ||
				!Number.isFinite(Date.parse(record.failure.time)))
		)
			problems.push(`待决办理记录第 ${index + 1} 项 failure 损坏`);
		if (
			record.advance !== undefined &&
			(!record.advance ||
				typeof record.advance !== "object" ||
				record.advance.status !== "accepted" ||
				typeof record.advance.accepted_at !== "string" ||
				!Number.isFinite(Date.parse(record.advance.accepted_at)))
		)
			problems.push(`待决办理记录第 ${index + 1} 项 advance 损坏`);
		if (
			record.submission !== undefined &&
			(typeof record.submission.交卷 !== "boolean" ||
				typeof record.submission.消息 !== "string" ||
				!Array.isArray(record.submission.暂存文件) ||
				record.submission.暂存文件.some((path) => typeof path !== "string") ||
				(record.submission.提交哈希 !== undefined && typeof record.submission.提交哈希 !== "string") ||
				(record.submission.原因 !== undefined && typeof record.submission.原因 !== "string") ||
				(record.submission.skip !== undefined &&
					!validPendingSubmissionSkip(record.submission.skip, record.attempt!)))
		)
			problems.push(`待决办理记录第 ${index + 1} 项 submission 损坏`);
	}
	return problems;
}
