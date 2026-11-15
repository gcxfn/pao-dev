/**
 * 落协作卡：校验放行后经 cards 的 createCard 落到目标卡目录（星型中转正门，§8.2）。
 * 裁决标记声明字段不落盘（协议零新增，§8.3）；路径全参数传入，不硬编码。
 */
import { type CardCreateInput, createCard, type ParsedCard } from "../cards/index.ts";
import type { CollabCardDraft } from "./review.ts";

export interface CollabFallthroughOptions {
	/** 卡号计数器文件路径；缺省 createCard 默认推导（<卡目录>/../../卡号.txt） */
	counterPath?: string;
	/**
	 * 已批准模板的正文骨架（§8.2「用已批准模板」）：由调用方先经模板库解析＋loadCardBodyTemplate
	 * 取出再传入（本模块不碰文件系统）；只贡献卡正文，frontmatter 仍由草稿协议字段生成。
	 */
	模板正文?: string;
}

/**
 * 落协作卡（须先经 校验协作卡 放行）：草稿 → 协议字段映射 → createCard（发号＋原子写，状态 待认领）。
 * 创建时间由调用方传入（YYYY-MM-DD HH:mm），本模块不取当前时钟（保持可测，与 cards 同约定）。
 */
export async function writeCollabCard(
	cardsDir: string,
	card: CollabCardDraft,
	created: string,
	options?: CollabFallthroughOptions,
): Promise<ParsedCard> {
	const input: CardCreateInput = {
		目标: card.目标,
		部门: card.部门,
		验收: card.验收,
		输入: card.输入,
		约束: card.约束,
		depends_on: card.depends_on,
		parent: card.parent,
		档位: card.档位,
		预算: card.预算,
		优先级: card.优先级,
		创建: created,
	};
	return createCard(cardsDir, input, { counterPath: options?.counterPath, 模板正文: options?.模板正文 });
}
