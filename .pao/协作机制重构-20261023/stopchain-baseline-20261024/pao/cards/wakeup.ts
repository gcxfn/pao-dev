/**
 * §19 交付唤醒——通道①②共用的就绪扫描（纯函数）。
 *
 * 定位：「部门 A 的卡落已交付后下游就绪」在被看见的时刻必然被看见——
 * ①落已交付的工具调用（pao_change_status / pao_verify_card 自动交付）返回时扫卡目录，
 *   附「已解锁」内联提示；②/队列 待认领组高亮「就绪」（同一判定，§21 任务区复用）。
 *
 * 口径（砍机制，只报有信息量的信号）：
 * - 「就绪」＝状态待认领 且 depends_on 非空 且全部已交付——无依赖卡建卡即可派，
 *   标它只会稀释信号；判定复用 checkDependencies（失败/取消/不存在一律算阻塞，
 *   §2 放行只认已交付）；跨队列依赖在本次视图查不到＝阻塞（保守，不虚报就绪）。
 * - 工作流模式下驱动器自己 tick 下游（§11.3 既有语义），本扫描是提示面不是执行面。
 */

import { formatCardNumber } from "./counter.ts";
import { checkDependencies } from "./deps.ts";
import type { CardStatus, ParsedCard } from "./types.ts";

/** 扫描输入的最小卡视图（QueueCardView/ParsedCard.frontmatter 均可适配）。 */
export interface WakeupCardView {
	card_no: number;
	goal?: string;
	status: CardStatus;
	owner?: string;
	depends_on: readonly string[];
}

/** 就绪卡（已解锁待派）。 */
export interface UnlockedCard {
	card_no: number;
	goal: string;
}

/**
 * 扫出「已解锁」卡：待认领 且 有依赖 且 依赖全部已交付。
 * statusOf 缺失（依赖卡不在本次视图）按阻塞处理——见 deps.ts checkDependencies。
 */
export function findUnlockedCards(cards: readonly WakeupCardView[]): UnlockedCard[] {
	const statusByNumber = new Map<number, CardStatus>();
	for (const card of cards) statusByNumber.set(card.card_no, card.status);
	const unlocked: UnlockedCard[] = [];
	for (const card of cards) {
		if (card.status !== "unclaimed") continue;
		if (card.depends_on.length === 0) continue;
		const gate = checkDependencies(card.depends_on, (cardNo) => statusByNumber.get(cardNo));
		if (!gate.放行) continue;
		unlocked.push({ card_no: card.card_no, goal: card.goal ?? "" });
	}
	return unlocked.sort((a, b) => a.card_no - b.card_no);
}

/** listCards(ParsedCard[]) → 扫描视图适配（工具层落已交付后直用）。 */
export function wakeupViews(cards: readonly ParsedCard[]): WakeupCardView[] {
	return cards.map((c) => ({
		card_no: c.card_no,
		goal: c.frontmatter.goal,
		status: c.frontmatter.status,
		owner: c.frontmatter.owner,
		depends_on: c.frontmatter.depends_on ?? [],
	}));
}

/**
 * 通道①内联提示文本：无就绪卡返回 undefined（零噪音）；有则一行——
 * 「已解锁：卡XXXX 目标…、…（依赖全满足,待认领可派）」。
 */
export function renderUnlockNotice(unlocked: readonly UnlockedCard[]): string | undefined {
	if (unlocked.length === 0) return undefined;
	const items = unlocked.map((c) => `${formatCardNumber(c.card_no)}${c.goal ? ` ${c.goal}` : ""}`).join("、");
	return `[交付唤醒 §19] 已解锁 ${unlocked.length} 张可派：${items}（依赖全满足，待认领）`;
}
