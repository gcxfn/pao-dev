/** 工作流待决的纯迁移函数；不读写文件，控制层负责持锁和落盘。 */

import {
	type ControlResult,
	type PendingKind,
	pendingKey,
	type WorkflowPending,
	type WorkflowPendingItem,
} from "./policy.ts";

export interface DeviationSourceItem {
	verification_index: number;
	条件: string;
	自报结论: "fail" | "not_run";
	证据?: string;
}

export interface PendingDecisionInput {
	item_ref: string;
	basis: string;
}

export interface BoundDeviationDecision {
	item_ref: string;
	attempt: number;
	verification_index: number;
	condition: string;
	basis: string;
}

export function deviationItemRef(cardNo: number, attempt: number, verificationIndex: number): string {
	return `card-${String(cardNo).padStart(4, "0")}:attempt-${attempt}:verification-${verificationIndex}`;
}

export function createDeviationPending(input: {
	instance: string;
	node: string;
	round: number;
	cardRef: string;
	cardNo: number;
	attempt: number;
	kind?: Extract<PendingKind, "普通偏差" | "部长hold">;
	reason: string;
	items: readonly DeviationSourceItem[];
	createdAt: string;
	deadline: string;
}): WorkflowPending {
	const kind = input.kind ?? "普通偏差";
	const seen = new Set<number>();
	const items: WorkflowPendingItem[] = input.items.map((item) => {
		if (!Number.isSafeInteger(item.verification_index) || item.verification_index < 0)
			throw new Error(`verification_index 须为非负整数：${String(item.verification_index)}`);
		if (seen.has(item.verification_index)) throw new Error(`verification_index 重复：${item.verification_index}`);
		seen.add(item.verification_index);
		if (!item.条件.trim()) throw new Error(`verification_index ${item.verification_index} 的条件不能为空`);
		if (item.自报结论 !== "fail" && item.自报结论 !== "not_run")
			throw new Error(`verification_index ${item.verification_index} 只有 fail/not_run 可进入普通偏差待决`);
		return {
			item_ref: deviationItemRef(input.cardNo, input.attempt, item.verification_index),
			card_ref: input.cardRef,
			card_no: input.cardNo,
			attempt: input.attempt,
			verification_index: item.verification_index,
			condition: item.条件,
			report: item.自报结论,
			...(item.证据 ? { evidence: item.证据 } : {}),
		};
	});
	if (!input.reason.trim()) throw new Error("待决理由不能为空");
	return {
		key: pendingKey({
			kind,
			instance: input.instance,
			node: input.node,
			round: input.round,
			cardRef: input.cardRef,
			attempt: input.attempt,
		}),
		kind,
		channel: "主控",
		instance: input.instance,
		node: input.node,
		round: input.round,
		card_ref: input.cardRef,
		attempt: input.attempt,
		reason: input.reason,
		created_at: input.createdAt,
		deadline: input.deadline,
		default_action: "failed",
		phase: "待处理",
		items,
	};
}

export function createRulingPending(input: {
	instance: string;
	node: string;
	round: number;
	reason: string;
	channel: "主控" | "人工";
	createdAt: string;
	deadline: string;
}): WorkflowPending {
	const kind: PendingKind = input.channel === "人工" ? "人工确认" : "普通裁定";
	return {
		key: pendingKey({
			kind,
			instance: input.instance,
			node: input.node,
			round: input.round,
		}),
		kind,
		channel: input.channel,
		instance: input.instance,
		node: input.node,
		round: input.round,
		reason: input.reason,
		created_at: input.createdAt,
		deadline: input.deadline,
		default_action: input.channel === "人工" ? "stop_unconfirmed" : "failed",
		phase: "待处理",
		items: [],
	};
}

export function mergePending(existing: WorkflowPending, incoming: WorkflowPending): WorkflowPending {
	if (existing.key !== incoming.key) throw new Error(`已有不同待决 ${existing.key}，不能与 ${incoming.key} 叠加`);
	if (
		existing.kind !== incoming.kind ||
		existing.channel !== incoming.channel ||
		existing.default_action !== incoming.default_action ||
		existing.instance !== incoming.instance ||
		existing.node !== incoming.node ||
		existing.round !== incoming.round ||
		existing.card_ref !== incoming.card_ref ||
		existing.attempt !== incoming.attempt
	)
		throw new Error("同一待决键的身份字段不一致，拒绝合并");
	const sameItems =
		existing.items.length === incoming.items.length &&
		existing.items.every((item) =>
			incoming.items.some(
				(candidate) =>
					candidate.item_ref === item.item_ref &&
					candidate.attempt === item.attempt &&
					candidate.verification_index === item.verification_index &&
					candidate.condition === item.condition &&
					candidate.report === item.report &&
					candidate.evidence === item.evidence,
			),
		);
	if (!sameItems) throw new Error("同一待决的当前 attempt 偏差项已变化，拒绝混用旧索引");
	const sameReason = existing.reason === incoming.reason;
	if (sameReason) return existing;
	const existingDeadline = Date.parse(existing.deadline);
	const incomingDeadline = Date.parse(incoming.deadline);
	return {
		...existing,
		deadline:
			Number.isFinite(existingDeadline) && Number.isFinite(incomingDeadline) && incomingDeadline < existingDeadline
				? incoming.deadline
				: existing.deadline,
		reason: `${existing.reason}\n${incoming.reason}`,
	};
}

export function planPendingResolution(
	pending: WorkflowPending,
	input: readonly PendingDecisionInput[],
): BoundDeviationDecision[] {
	if (pending.channel !== "主控") throw new Error(`当前待决通道为 ${pending.channel}，须走人工确认`);
	if (pending.phase !== "待处理") throw new Error(`当前待决阶段为 ${pending.phase}，不能再次办理`);
	const expected = new Map(pending.items.map((item) => [item.item_ref, item]));
	const seen = new Set<string>();
	const decisions: BoundDeviationDecision[] = [];
	for (const [index, decision] of input.entries()) {
		if (!decision || typeof decision.item_ref !== "string" || !decision.item_ref.trim())
			throw new Error(`decisions[${index}].item_ref: 须为非空字符串`);
		if (typeof decision.basis !== "string") throw new Error(`decisions[${index}].basis: 须为非空字符串`);
		if (!decision.basis.trim()) throw new Error(`decisions[${index}].basis: 不能为空`);
		if (seen.has(decision.item_ref))
			throw new Error(`decisions[${index}].item_ref: 重复 ${JSON.stringify(decision.item_ref)}`);
		seen.add(decision.item_ref);
		const item = expected.get(decision.item_ref);
		if (!item) throw new Error(`decisions[${index}].item_ref: 不属于当前待决 ${JSON.stringify(decision.item_ref)}`);
		decisions.push({
			item_ref: item.item_ref,
			attempt: item.attempt,
			verification_index: item.verification_index,
			condition: item.condition,
			basis: decision.basis.trim(),
		});
	}
	if (pending.items.length !== input.length) {
		const missing = pending.items.filter((item) => !seen.has(item.item_ref)).map((item) => item.item_ref);
		const extra = [...seen].filter((ref) => !expected.has(ref));
		throw new Error(
			`decisions 必须恰好覆盖当前待决全部 ${pending.items.length} 项（实为 ${input.length}）；` +
				`缺项=${missing.length ? missing.join("、") : "无"}；多项=${extra.length ? extra.join("、") : "无"}`,
		);
	}
	return decisions;
}

export function expirePending(pending: WorkflowPending, now: string): ControlResult | undefined {
	if (pending.phase !== "待处理" || Date.parse(now) < Date.parse(pending.deadline)) return undefined;
	pending.phase = "已过期";
	return {
		state: pending.default_action,
		reason: `待决 ${pending.key} 已到截止时间 ${pending.deadline}，业务结果记为 ${pending.default_action}；未证明写者已停止，执行占位保留`,
		time: now,
		pending_key: pending.key,
		writer_stop_confirmed: false,
	};
}

export function pendingSummary(pending: WorkflowPending): string {
	if (pending.phase === "已过期")
		return `待决已过期（${pending.kind}，默认 ${pending.default_action}）：${pending.reason}`;
	if (pending.kind === "普通偏差" || pending.kind === "部长hold") {
		const labels = pending.items.map((item) => `#${item.verification_index} ${item.condition}（${item.report}）`);
		const itemText = labels.length > 0 ? `；${labels.join("；")}` : "";
		return `等待主控逐项裁决 ${pending.key}${itemText}；截止 ${pending.deadline}`;
	}
	return `等待${pending.channel}裁定 ${pending.key}：${pending.reason}；截止 ${pending.deadline}`;
}
