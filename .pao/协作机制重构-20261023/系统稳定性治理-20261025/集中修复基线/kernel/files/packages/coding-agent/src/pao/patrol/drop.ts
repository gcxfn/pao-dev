/**
 * 落巡库卡（卡0006）：草稿 → cards 的 createCard（发号＋原子写），状态 待认领，落本部队列。
 * 幂等：同部门已存在未终态（待认领/进行中）巡库卡时不重复落，返回已存在的卡。
 * 查重与创建同处一个跨进程临界区：同刻两次巡检只有先到者落卡（审查第 9 项）。
 * 巡库卡识别约定见 draft.ts 的 PATROL_GOAL_PREFIX 注释。
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type CardCreateInput, type CardScanProblem, createCard, scanCards } from "../cards/index.ts";
import type { ParsedCard } from "../cards/types.ts";
import { withFileLock } from "../shared/lock.ts";
import { isPatrolGoal, PATROL_ACTIVE_STATUSES, type PatrolCardDraft } from "./draft.ts";

export interface PatrolDropOptions {
	/** 卡号计数器文件路径；缺省 createCard 默认推导（<卡目录>/../../卡号.txt） */
	counterPath?: string;
	/** 查重临界区锁目标；缺省 <卡目录>/巡库卡.txt。与卡号锁分开，避免同进程嵌套自锁。 */
	lockPath?: string;
}

export interface PatrolDropResult {
	/** 新落的卡；幂等命中时为已存在的未终态巡库卡 */
	card: ParsedCard;
	/** true = 同部门已有未终态巡库卡，本次未新建 */
	exists: boolean;
	/** 读不出来的卡（坏卡/目录 IO 失败）；本次查重不含它们，调用方须如实披露（审查第 5 项） */
	读取问题?: CardScanProblem[];
}

function isActivePatrolCard(card: ParsedCard, dept: string): boolean {
	return (
		isPatrolGoal(card.frontmatter.goal) &&
		card.frontmatter.dept === dept &&
		(PATROL_ACTIVE_STATUSES as readonly string[]).includes(card.frontmatter.status)
	);
}

/**
 * 落巡库卡：锁内先幂等检查（同部门未终态巡库卡已存在 → 不重复落），再走 createCard（发号＋原子写，状态 待认领）。
 * §6.7：不经主控（不设 parent）、不占协作配额（不设 预算.协作配额）。
 * 创建时间由调用方传入（YYYY-MM-DD HH:mm），本模块不取当前时钟（保持可测，与 cards 同约定）。
 */
export async function dropPatrolCard(
	cardsDir: string,
	draft: PatrolCardDraft,
	created: string,
	options?: PatrolDropOptions,
): Promise<PatrolDropResult> {
	// 查重与创建必须在同一临界区：并发巡检各自先查后建会各落一张（审查第 9 项）。
	// 锁目标与卡号锁分开：createCard 内部还要取卡号锁，同一把锁会自锁。
	const lockPath = options?.lockPath ?? join(cardsDir, "巡库卡.txt");
	// 锁目录要先存在（首发卡时卡目录可能还没建；createCard 本来也会建同名层级）
	mkdirSync(cardsDir, { recursive: true });
	return withFileLock(lockPath, async () => {
		const { cards, problems } = scanCards(cardsDir);
		const existing = cards.find((card) => isActivePatrolCard(card, draft.部门));
		if (existing) {
			return { card: existing, exists: true, ...(problems.length > 0 ? { 读取问题: problems } : {}) };
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
		return { card, exists: false, ...(problems.length > 0 ? { 读取问题: problems } : {}) };
	});
}
