/**
 * 落巡库卡（卡0006）：草稿 → cards 的 createCard（发号＋原子写），状态 待认领，落本部队列。
 * 幂等：同部门已存在未终态（待认领/进行中）巡库卡时不重复落，返回已存在的卡。
 * 巡库卡识别约定见 draft.ts 的 PATROL_GOAL_PREFIX 注释。
 */
import { type CardCreateInput, createCard, listCards } from "../cards/index.ts";
import type { ParsedCard } from "../cards/types.ts";
import { isPatrolGoal, PATROL_ACTIVE_STATUSES, type PatrolCardDraft } from "./draft.ts";

export interface PatrolDropOptions {
	/** 卡号计数器文件路径；缺省 createCard 默认推导（<卡目录>/../../卡号.txt） */
	counterPath?: string;
}

export interface PatrolDropResult {
	/** 新落的卡；幂等命中时为已存在的未终态巡库卡 */
	card: ParsedCard;
	/** true = 同部门已有未终态巡库卡，本次未新建 */
	exists: boolean;
}

function isActivePatrolCard(card: ParsedCard, dept: string): boolean {
	return (
		isPatrolGoal(card.frontmatter.goal) &&
		card.frontmatter.dept === dept &&
		(PATROL_ACTIVE_STATUSES as readonly string[]).includes(card.frontmatter.status)
	);
}

/**
 * 落巡库卡：先幂等检查（同部门未终态巡库卡已存在 → 不重复落），再走 createCard（发号＋原子写，状态 待认领）。
 * §6.7：不经主控（不设 parent）、不占协作配额（不设 预算.协作配额）。
 * 创建时间由调用方传入（YYYY-MM-DD HH:mm），本模块不取当前时钟（保持可测，与 cards 同约定）。
 */
export async function dropPatrolCard(
	cardsDir: string,
	draft: PatrolCardDraft,
	created: string,
	options?: PatrolDropOptions,
): Promise<PatrolDropResult> {
	const existing = listCards(cardsDir).find((card) => isActivePatrolCard(card, draft.部门));
	if (existing) {
		return { card: existing, exists: true };
	}
	const input: CardCreateInput = {
		目标: draft.目标,
		部门: draft.部门,
		输入: draft.输入,
		约束: draft.约束,
		验收: draft.验收,
		档位: draft.档位,
		创建: created,
	};
	const card = await createCard(cardsDir, input, { counterPath: options?.counterPath });
	return { card, exists: false };
}
