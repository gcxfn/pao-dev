import { dirname } from "node:path";

import { recordFrictionDraft } from "../friction/drafts.ts";
import { writeFileAtomic } from "../shared/atomic.ts";
import { logWarn } from "../shared/log.ts";
import { readCard, serializeCard } from "./cardfile.ts";
import { formatCardNumber } from "./counter.ts";
import { PaoCardError } from "./errors.ts";
import { appendMetricsLine, buildMetricsLine, countGateConfirms, metricsLedgerPath } from "./metrics.ts";
import type { CardFrontmatter, CardStatus, FailureType, ParsedCard } from "./types.ts";

/**
 * 五状态机允许的迁移（开工接口模板 §2）：
 * 待认领→进行中（启动）；进行中→已交付/失败/取消；失败→待认领（重试）；待认领/进行中/失败→取消。
 * 已交付/取消为终态：迟到回执与重复通知只留档，不再变状态。
 */
const ALLOWED_TRANSITIONS: Record<CardStatus, readonly CardStatus[]> = {
	unclaimed: ["in_progress", "canceled"],
	in_progress: ["delivered", "failed", "canceled"],
	delivered: [],
	failed: ["unclaimed", "canceled"],
	canceled: [],
};

/** 同轮授权尝试上限默认 2（架构 §2.1）；提高上限须由 owner 显式传参，worker 无此入口。 */
export const DEFAULT_ATTEMPT_LIMIT = 2;

export interface TransitionCheckInput {
	from: CardStatus;
	to: CardStatus;
	尝试: number;
	尝试上限?: number;
	/** 卡号（可选；提供时重试到顶会记摩擦草稿，M0-08） */
	卡号?: number;
	卡目录?: string;
}

/** 纯校验：非法迁移/超上限抛结构化错误；通过即返回（含重试上限门：失败→待认领须 尝试 < 上限）。 */
export function checkTransition(input: TransitionCheckInput): void {
	const { from, to } = input;
	const allowed = ALLOWED_TRANSITIONS[from];
	if (!allowed.includes(to)) {
		throw new PaoCardError("INVALID_TRANSITION", `不允许的状态迁移：${from} → ${to}`, { from, to });
	}
	if (from === "failed" && to === "unclaimed") {
		const limit = input.尝试上限 ?? DEFAULT_ATTEMPT_LIMIT;
		if (input.尝试 >= limit) {
			// 重试到顶（M0-08）：尝试达上限的判定点即事件落定点，尾随记摩擦草稿（失败不抛，不影响主流程）
			if (input.卡号 !== undefined) {
				void recordFrictionDraft(
					"重试到顶",
					formatCardNumber(input.卡号),
					`尝试数 ${input.尝试} 已达上限 ${limit}，失败→待认领被拒，自动重试通道关闭`,
					input.卡目录,
				);
			}
			throw new PaoCardError("ATTEMPT_EXCEEDED", `尝试数 ${input.尝试} 已达上限 ${limit}，须升级人处理`, {
				尝试: input.尝试,
				上限: limit,
			});
		}
	}
}

export interface StatusChangeInput {
	/** 调用者身份（部门/会话/“用户”）。单写者校验依据。 */
	操作者: string;
	to: CardStatus;
	/** 失败时必填：失败分型四类之一。 */
	失败类型?: FailureType;
	/** 失败/取消时的依据说明，落回执区（owner 写入）。 */
	依据?: string;
	时间: string;
	尝试上限?: number;
}

export function isTerminal(status: CardStatus): boolean {
	return status === "delivered" || status === "canceled";
}

/**
 * 单写者校验（纯函数）：状态与信封字段只有 owner 改。
 * - 认领（待认领→进行中）：卡未设 owner 时调用者成为 owner；已设则必须匹配。
 * - 其余迁移：操作者必须等于 owner；取消额外允许操作者“用户”（模板 §2：用户/owner 合法取消）。
 * - 已终态卡（含迟到回执场景）：不改状态，仅允许走回执留档通道（见 receipts.ts）。
 */
export function checkWriterAuthority(frontmatter: CardFrontmatter, operator: string, to: CardStatus): void {
	const currentOwner = frontmatter.owner;
	if (frontmatter.status === "unclaimed" && to === "in_progress") {
		if (currentOwner !== undefined && currentOwner !== operator) {
			throw new PaoCardError("FORBIDDEN_WRITER", `卡已被 ${currentOwner} 认领，${operator} 无权写入`, {
				owner: currentOwner,
				操作者: operator,
			});
		}
		return;
	}
	// 用户取消不要求 owner 匹配（模板 §2：用户/owner 合法取消；含无主卡的取消）
	if (to === "canceled" && operator === "用户") return;
	if (currentOwner === undefined) {
		throw new PaoCardError("FORBIDDEN_WRITER", `卡未设 owner，只有认领（待认领→进行中）或用户取消可写入`, {
			操作者: operator,
		});
	}
	if (operator === currentOwner) return;
	throw new PaoCardError("FORBIDDEN_WRITER", `只有 owner（${currentOwner}）可改状态，调用者是 ${operator}`, {
		owner: currentOwner,
		操作者: operator,
		to,
	});
}

/** 认领时补写 owner 的字段变更（仅当卡未设 owner）。 */
export function applyOwnerOnClaim(frontmatter: CardFrontmatter, operator: string): void {
	if (frontmatter.status === "unclaimed" && frontmatter.owner === undefined) {
		frontmatter.owner = operator;
	}
}

/**
 * 结卡四指标的落账状态集（M2-09 定案）：已交付/失败/取消。注意「失败」在状态机里可重试
 * （失败→待认领），不是 isTerminal 意义的终态，但每次落入都结一行账——账是流水不是状态。
 */
const METRICS_SETTLE_STATUSES: readonly CardStatus[] = ["delivered", "failed", "canceled"];

/**
 * 结卡四指标机械摘要（M2-09）：卡落入 已交付/失败/取消 时，往编排区四指标账
 * （卡目录上一级的 四指标账.txt，标准布局即 .pao/ 下）机械追加一行（纯函数拼行在
 * metrics.ts，此处只取数与落盘）。人工门确认次数经 countGateConfirms 从工作流实例清单
 * 数出（卡不在任何工作流为 0）。账是派生数据：落账失败不推翻已生效的终态变更，与认领
 * 基线快照同款边界——警示后放行，不静默吞掉。
 */
function recordSettleMetrics(card: ParsedCard, input: StatusChangeInput): void {
	if (!METRICS_SETTLE_STATUSES.includes(input.to)) return;
	try {
		const line = buildMetricsLine({
			card,
			receipts: card.receipts,
			终态: input.to,
			终态时刻: input.时间,
			人工门确认次数: countGateConfirms(card),
		});
		appendMetricsLine(metricsLedgerPath(dirname(card.path)), line);
	} catch (error) {
		logWarn(
			`[四指标账] ${formatCardNumber(card.card_no)} 落账失败（终态变更不受影响）:${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * 状态迁移的字段效果（纯函数，原地改 frontmatter）：
 * - 实际启动（待认领→进行中）才递增 尝试（模板 §2：失败→待认领不递增）；
 * - 重新进入活状态（待认领/进行中）清除完成时间，历史留在回执区；
 * - 已交付写完成时间；失败记失败类型。
 */
export function applyTransitionEffects(frontmatter: CardFrontmatter, input: StatusChangeInput): void {
	const from = frontmatter.status;
	const { to } = input;
	if (from === "unclaimed" && to === "in_progress") {
		frontmatter.attempt += 1;
	}
	if (to === "delivered") {
		frontmatter.completed = input.时间;
	} else if (to === "unclaimed" || to === "in_progress") {
		delete frontmatter.completed;
	}
	frontmatter.status = to;
}

/** owner 状态变更的审计段（正文追加，区分于 worker 回执）。 */
export function ownerTransitionNote(input: StatusChangeInput): string {
	const lines = [`## owner记录 ${input.时间}`];
	lines.push(`- 事件: 状态改为 ${input.to}`);
	if (input.失败类型) lines.push(`- 失败类型: ${input.失败类型}`);
	if (input.依据) lines.push(`- 依据: ${input.依据}`);
	return lines.join("\n");
}

/**
 * 改状态总入口（文件操作层）：读卡 → 迁移校验 → 单写者校验 → 读-合并-写落盘。
 * 落盘前重读盘上最新卡内容：验收跑命令期间 worker 可能已按单写者协议追加回执，
 * 以最新内容为底只合并状态相关字段（owner/尝试/完成/状态）与审计段，不拿载入时的
 * 旧快照整篇覆盖；盘上状态与读入时不一致（并发变更）或重读失败时结构化报错中止，
 * 不写盘。依赖放行由调用方先行校验（deps.ts），此处不管依赖。
 * 落入 已交付/失败/取消 后尾随结卡四指标落账（M2-09，recordSettleMetrics；失败不抛不影响迁移）。
 */
export function changeCardStatus(card: ParsedCard, input: StatusChangeInput): ParsedCard {
	const fm = card.frontmatter;
	checkTransition({
		from: fm.status,
		to: input.to,
		尝试: fm.attempt,
		尝试上限: input.尝试上限,
		卡号: card.card_no,
		卡目录: dirname(card.path),
	});
	if (!isTerminal(fm.status)) {
		checkWriterAuthority(fm, input.操作者, input.to);
	}
	if (input.to === "failed" && !input.失败类型) {
		throw new PaoCardError(
			"INVALID_TRANSITION",
			`转入失败必须带失败类型（transient/missing_input/insufficient_capability/unknown_outcome）`,
			{
				卡号: card.card_no,
			},
		);
	}
	let latest: ParsedCard;
	try {
		latest = readCard(card.path);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		if (error instanceof PaoCardError) {
			throw new PaoCardError(error.code, `重读卡失败，已中止状态变更（不覆盖盘上内容）：${error.message}`, {
				...error.details,
				卡号: card.card_no,
			});
		}
		throw new PaoCardError(
			"CARD_NOT_FOUND",
			`重读卡失败，已中止状态变更（不覆盖盘上内容）：${card.path}（${reason}）`,
			{ 路径: card.path, 卡号: card.card_no },
		);
	}
	if (latest.frontmatter.status !== fm.status) {
		throw new PaoCardError(
			"INVALID_TRANSITION",
			`盘上卡状态已是 ${latest.frontmatter.status}，与读入时的 ${fm.status} 不一致，已中止本次状态变更`,
			{ 卡号: card.card_no, 读入时: fm.status, 盘上: latest.frontmatter.status, 路径: card.path },
		);
	}
	if (!isTerminal(fm.status)) {
		applyOwnerOnClaim(fm, input.操作者);
		applyOwnerOnClaim(latest.frontmatter, input.操作者);
	}
	applyTransitionEffects(fm, input);
	applyTransitionEffects(latest.frontmatter, input);
	const note = ownerTransitionNote(input);
	const body = latest.body.trim().length > 0 ? `${latest.body.trimEnd()}\n\n${note}\n` : `${note}\n`;
	writeFileAtomic(latest.path, serializeCard(latest.frontmatter, body));
	const updated = { ...latest, frontmatter: latest.frontmatter, body: body };
	recordSettleMetrics(updated, input);
	return updated;
}
