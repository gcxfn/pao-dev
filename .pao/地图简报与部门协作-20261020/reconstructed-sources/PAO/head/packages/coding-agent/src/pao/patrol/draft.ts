/**
 * 巡库卡草稿（卡0006，架构 §6.7）：机械巡检数 ⚠️，过阈值 → 产出巡库卡草稿。
 * 纯函数、零语义判断：阈值判定只数 ⚠️ 条目数，不过阈值返回 null，绝不落卡。
 */
import type { CardTier } from "../cards/types.ts";
import type { InspectionReport } from "../knowledge/index.ts";

/** 巡库触发阈值：⚠️ 条目数 ≥ 阈值才落巡库卡（§6.7 默认 5，可参数覆写）。 */
export const DEFAULT_PATROL_THRESHOLD = 5;

/**
 * 巡库卡识别约定（幂等判定依据，交付说明同款）：
 * 巡库卡的 目标 字段一律以固定前缀「巡库：」开头；幂等检查按
 * 「目标带前缀 ＋ 部门相同 ＋ 状态 ∈ PATROL_ACTIVE_STATUSES」识别未终态巡库卡。
 */
export const PATROL_GOAL_PREFIX = "巡库：";

/** 视为「未终态」的巡库卡状态：处于这两态时不重复落卡（失败/终态不阻止重派，§6.7 部门内部分派）。 */
export const PATROL_ACTIVE_STATUSES = ["unclaimed", "in_progress"] as const;

/** 巡库 worker 的写权限边界（§6.7 红线）：只准写 ⚠️ 标记与初判，不准动条目正文。 */
export const PATROL_CONSTRAINT = "只准写 ⚠️ 标记与初判，不准动条目正文";

/** 巡库卡草稿：字段与卡协议（黑板第 5 条）一致，落卡时逐字段映射进 frontmatter。 */
export interface PatrolCardDraft {
	目标: string;
	部门: string;
	/** ⚠️ 条目相对路径指针列表（指针铁律：只装路径不装正文） */
	输入: string[];
	约束: string;
	验收: string;
	档位: CardTier;
}

export interface PatrolDraftOptions {
	/** 发起巡检的部门（巡库卡落本部队列，不经主控、不占协作配额） */
	部门: string;
	/** ⚠️ 数阈值；缺省 DEFAULT_PATROL_THRESHOLD（5） */
	阈值?: number;
	/** 知识库根路径；提供时作为 输入 第一条指针，worker 才能据此定位条目 */
	知识库路径?: string;
}

/** 目标是否巡库卡（识别约定：固定前缀，见 PATROL_GOAL_PREFIX 注释）。 */
export function isPatrolGoal(goal: string): boolean {
	return goal.startsWith(PATROL_GOAL_PREFIX);
}

/**
 * 阈值判定纯函数：报告 ⚠️ 条目数 ≥ 阈值 → 巡库卡草稿；否则返回 null（绝不落卡）。
 * 零语义判断：只数数、拼指针，不做任何「该不该消化」的判断（消化是部长终审的事）。
 */
export function buildPatrolCardDraft(report: InspectionReport, options: PatrolDraftOptions): PatrolCardDraft | null {
	const threshold = options.阈值 ?? DEFAULT_PATROL_THRESHOLD;
	if (report.flaggedCount < threshold) return null;
	// 指针列表与 flaggedCount 同源（findings），天然一致；条目相对路径如 教训/xx.md
	const flaggedPaths = report.findings.filter((f) => f.flagged).map((f) => f.relPath);
	const inputLines = options.知识库路径 ? [`知识库根:${options.知识库路径}`, ...flaggedPaths] : flaggedPaths;
	return {
		目标: `${PATROL_GOAL_PREFIX}消化 ${report.flaggedCount} 条 ⚠️ 标记（初判后待部长终审）`,
		部门: options.部门,
		输入: inputLines,
		约束: PATROL_CONSTRAINT,
		验收: `每条 ⚠️ 条目附一行初判；复跑 pao_inspect_kb，⚠️ 数下降或回执说明保留原因；条目正文与落卡时零差异`,
		档位: "fast",
	};
}
