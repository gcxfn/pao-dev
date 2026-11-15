/**
 * 协作卡机械校验器（架构 §8.2 批准版，纯函数）。
 *
 * 分层定案：机械校验交给程序，语义裁决留给主控模型——字段合法≠任务合理，
 * 机械放行只限规则已覆盖的情况；带裁决标记的卡不落队列，交主控裁决。
 */
import { formatCardNumber, parseCardRef } from "../cards/counter.ts";
import type { DependencyStatus } from "../cards/deps.ts";
import { checkDependencies, findReachableCycles } from "../cards/deps.ts";
import type { CardBudget, CardPriority, CardTier, ParsedCard } from "../cards/types.ts";
import { CARD_PRIORITIES, CARD_TIERS } from "../cards/types.ts";
import type { DeptRegistryRow } from "../dept/index.ts";

/** 校验三路：放行（落队列）/ 拒绝（程序可判）/ 待主控裁决（机械全过但带裁决标记） */
export const COLLAB_VERDICTS = ["放行", "拒绝", "待主控裁决"] as const;
export type CollabVerdict = (typeof COLLAB_VERDICTS)[number];

/** 裁决标记四类（§8.2：要插队、新权限、超预算、验收存疑才唤醒主控）；值为声明说明，留空/缺省＝无声明 */
export const RULING_FLAGS = ["插队", "新权限", "超预算覆写", "验收存疑"] as const;
export type RulingFlag = (typeof RULING_FLAGS)[number];

/** 协作配额默认值（§8.5）；父卡 预算.协作配额 可按卡覆写 */
export const DEFAULT_COLLAB_QUOTA = 2;

/** 活卡（幂等判定口径）：待认领/进行中 */
const ACTIVE_STATUSES: readonly string[] = ["unclaimed", "in_progress"];

/**
 * 协作卡草稿信封：协议字段（架构 §2）＋ 四类裁决标记声明字段。
 * 落盘时只映射协议字段，声明字段不写入卡文件（协议零新增，§8.3）。
 */
export interface CollabCardDraft {
	目标: string;
	部门: string;
	验收: string;
	/** 归属父卡（卡#N）：协作卡必填，只表归属与预算，不参与依赖判断 */
	parent: string;
	输入?: string[];
	约束?: string;
	depends_on?: string[];
	/**
	 * 已批准模板名（§8.2 机械条件「用已批准模板」）：只收已批准模板库内的名字（M2-02：
	 * 模板绑定既有授权范围，不收任意绝对路径——不让字段填齐成为任意操作的通行证）。
	 * 路由字段不落 frontmatter（协议零新增，§8.3），模板正文骨架由落卡时带入卡正文。
	 */
	模板?: string;
	档位?: CardTier;
	预算?: CardBudget;
	优先级?: CardPriority;
	// ── 裁决标记声明字段（不落盘）──
	插队?: string;
	新权限?: string;
	超预算覆写?: string;
	验收存疑?: string;
}

export type CollabRejectionType =
	| "字段缺失"
	| "字段非法"
	| "parent 不存在"
	| "深度封顶"
	| "部门不存在"
	| "重复落卡"
	| "配额超"
	| "依赖未满足"
	| "依赖环"
	| "模板未批准";

export interface CollabRejectionReason {
	类型: CollabRejectionType;
	说明: string;
	/** 字段缺失/非法时给出字段名 */
	字段?: string;
	/** 涉及具体卡时给出卡号（parent 不存在/深度封顶/重复落卡） */
	卡号?: number;
	/** 依赖未满足时的阻塞明细 */
	阻塞?: DependencyStatus[];
}

export interface CollabReviewResult {
	裁决: CollabVerdict;
	/** 拒绝原因（逐项结构化）；放行/待裁决＝空数组 */
	原因: CollabRejectionReason[];
	/** 卡上声明的裁决标记（待主控裁决的判断依据；无声明为空对象） */
	裁决声明: Partial<Record<RulingFlag, string>>;
	/** 待主控裁决时的裁决摘要（供主控模型判断）；其余为 undefined */
	裁决摘要?: string;
	/** 幂等命中：已有同目标活卡的卡号 */
	已有卡号?: number;
}

function isBlank(value: string | undefined): boolean {
	return value === undefined || value.trim().length === 0;
}

function collectRulingFlags(card: CollabCardDraft): Partial<Record<RulingFlag, string>> {
	const declaration: Partial<Record<RulingFlag, string>> = {};
	for (const flag of RULING_FLAGS) {
		const value = card[flag];
		if (typeof value === "string" && value.trim()) declaration[flag] = value.trim();
	}
	return declaration;
}

function sameParent(card: ParsedCard, parentCardNo: number): boolean {
	const parent = card.frontmatter.parent;
	if (parent === undefined || parent.trim() === "") return false;
	try {
		return parseCardRef(parent) === parentCardNo;
	} catch {
		return false;
	}
}

function renderRulingSummary(
	card: CollabCardDraft,
	parentCardNo: number,
	declaration: Partial<Record<RulingFlag, string>>,
): string {
	const lines = [
		`协作卡机械校验全部通过，但带裁决标记，待主控裁决（未落队列）：`,
		...Object.entries(declaration).map(([flag, description]) => `- ${flag}：${description}`),
		`卡摘要：目标「${card.目标}」→ 部门「${card.部门}」，parent=${formatCardNumber(parentCardNo)}，验收：${card.验收}`,
		`裁决通过后请去掉声明字段（或按裁决调整预算/优先级）重新递交。`,
	];
	return lines.join("\n");
}

/**
 * 机械校验协作卡（纯函数）。
 *
 * 校验顺序（全部收集、一次给全，便于起草方一次改对）：
 * 必需字段 → 枚举字段 → parent 可解析/存在 → 深度封顶（协作卡不得再生协作卡）
 * → 部门在注册表 → 幂等（同 parent 同目标部门活卡）→ 协作配额 → 依赖放行门
 * → 依赖环（可达互等环拒绝死等）→ 裁决标记。任一拒绝命中即拒绝；机械全过且无声明才放行。
 * （「用已批准模板」由工具层在落卡前校验——模板要读文件系统，本纯函数只管信封。）
 */
export function validateCollabCard(
	card: CollabCardDraft,
	registry: readonly DeptRegistryRow[],
	existingCardStatus: readonly ParsedCard[],
): CollabReviewResult {
	const reason: CollabRejectionReason[] = [];
	const declaration = collectRulingFlags(card);
	let existingCardNo: number | undefined;

	// 1. 必需字段（落卡时由 createCard 补齐的字段不在此列）
	const requiredFields = ["目标", "部门", "验收", "parent"] as const;
	for (const field of requiredFields) {
		if (isBlank(card[field])) {
			reason.push({ 类型: "字段缺失", 字段: field, 说明: `缺必需字段「${field}」` });
		}
	}
	// 2. 枚举字段
	if (card.档位 !== undefined && !CARD_TIERS.includes(card.档位)) {
		reason.push({
			类型: "字段非法",
			字段: "档位",
			说明: `档位非法：${String(card.档位)}（应为 ${CARD_TIERS.join("/")}）`,
		});
	}
	if (card.优先级 !== undefined && !CARD_PRIORITIES.includes(card.优先级)) {
		reason.push({
			类型: "字段非法",
			字段: "优先级",
			说明: `优先级非法：${String(card.优先级)}（应为 ${CARD_PRIORITIES.join("/")}）`,
		});
	}

	// 3. parent：可解析且存在；由此派生的检查（深度/幂等/配额）只在父卡已知时做
	let parentCardNo: number | undefined;
	if (!isBlank(card.parent)) {
		try {
			parentCardNo = parseCardRef(card.parent);
		} catch {
			reason.push({ 类型: "字段非法", 字段: "parent", 说明: `parent 引用无法解析：${card.parent}` });
		}
	}
	const parentCard =
		parentCardNo === undefined ? undefined : existingCardStatus.find((c) => c.card_no === parentCardNo);
	if (parentCardNo !== undefined && !parentCard) {
		reason.push({
			类型: "parent 不存在",
			卡号: parentCardNo,
			说明: `parent ${formatCardNumber(parentCardNo)} 在既有卡中找不到（须先有父卡，再提协作卡）`,
		});
	}
	if (parentCard?.frontmatter.parent) {
		// 深度封顶（§8.5）：协作卡不得再生协作卡，B 还需 C 由主控重拆
		reason.push({
			类型: "深度封顶",
			卡号: parentCard.card_no,
			说明: `父卡 ${formatCardNumber(parentCard.card_no)} 自身已是协作卡（parent=${parentCard.frontmatter.parent}），协作卡不得再生协作卡`,
		});
	}

	// 4. 部门必须在注册表（星型中转正门只认注册表部门）
	if (!isBlank(card.部门) && !registry.some((row) => row.名字 === card.部门)) {
		const known = registry.map((row) => row.名字).join("、") || "（注册表为空）";
		reason.push({ 类型: "部门不存在", 字段: "部门", 说明: `部门「${card.部门}」不在注册表中（现有：${known}）` });
	}

	// 5. 幂等：同 parent ＋ 同目标部门 ＋ 活卡（待认领/进行中）→ 不重复落卡
	if (parentCardNo !== undefined && !isBlank(card.部门)) {
		const alreadyExists = existingCardStatus.find(
			(c) =>
				c.frontmatter.dept === card.部门 &&
				ACTIVE_STATUSES.includes(c.frontmatter.status) &&
				sameParent(c, parentCardNo),
		);
		if (alreadyExists) {
			existingCardNo = alreadyExists.card_no;
			reason.push({
				类型: "重复落卡",
				卡号: alreadyExists.card_no,
				说明: `已有同 parent 同目标部门的活卡 ${formatCardNumber(alreadyExists.card_no)}（状态 ${alreadyExists.frontmatter.status}），不重复落卡`,
			});
		}
	}

	// 6. 协作配额（§8.5）：默认 2，父卡 预算.协作配额 可覆写；统计既有同 parent 协作卡数（含终态，封顶从严）
	if (parentCardNo !== undefined && parentCard) {
		const quota = parentCard.frontmatter.budget?.collab_quota ?? DEFAULT_COLLAB_QUOTA;
		const sameParentCount = existingCardStatus.filter((c) => sameParent(c, parentCardNo)).length;
		if (sameParentCount >= quota) {
			reason.push({
				类型: "配额超",
				卡号: parentCardNo,
				说明: `父卡 ${formatCardNumber(parentCardNo)} 已有 ${sameParentCount} 张协作卡，协作配额 ${quota}（默认 2，按卡覆写）已用满`,
			});
		}
	}

	// 7. 依赖放行门（复用 cards 的 checkDependencies：全部已交付才放行；取消/失败虽终态也不算已交付）
	if ((card.depends_on?.length ?? 0) > 0) {
		const statusOf = new Map(existingCardStatus.map((c) => [c.card_no, c.frontmatter.status] as const));
		const gate = checkDependencies(card.depends_on ?? [], (cardNo) => statusOf.get(cardNo));
		if (!gate.放行) {
			const detail = gate.阻塞.map((b) => `${formatCardNumber(b.卡号)}=${b.状态}`).join("、");
			reason.push({ 类型: "依赖未满足", 阻塞: gate.阻塞, 说明: `依赖未全部已交付：${detail}` });
		}
		// 8. 依赖环（M2-02 有限汇合的机械检查）：本卡依赖可达的既有卡里若有互等环，
		// 环上只要有一张未交付就永远交付不了——死等一张等不来的卡，程序可判拒绝。
		// （本卡尚无卡号无法自引用；引用不存在的卡号已被上面的「不存在→阻塞→拒绝」拦截，
		// 故自依赖在协作递交入口是结构性不可能，环检测只针对既有卡依赖图。）
		const depsOf = new Map<number, number[]>();
		for (const c of existingCardStatus) {
			depsOf.set(
				c.card_no,
				(c.frontmatter.depends_on ?? [])
					.map((ref) => {
						try {
							return parseCardRef(ref);
						} catch {
							return Number.NaN;
						}
					})
					.filter((n) => Number.isInteger(n)),
			);
		}
		const roots = (card.depends_on ?? [])
			.map((ref) => {
				try {
					return parseCardRef(ref);
				} catch {
					return Number.NaN;
				}
			})
			.filter((n) => Number.isInteger(n));
		const cycle = findReachableCycles(roots, (cardNo) => depsOf.get(cardNo));
		const deadCycle = cycle.filter((cardNo) => statusOf.get(cardNo) !== "delivered");
		if (deadCycle.length > 0) {
			reason.push({
				类型: "依赖环",
				说明: `依赖链上有互等环（${deadCycle.map(formatCardNumber).join("、")}），环上卡互等前置永远无法全部已交付，拒绝死等：请回主控重拆`,
			});
		}
	}

	if (reason.length > 0) {
		return { 裁决: "拒绝", 原因: reason, 裁决声明: declaration, 已有卡号: existingCardNo };
	}
	// 机械全过：带裁决标记 → 待主控裁决；无声明 → 放行
	if (Object.keys(declaration).length > 0 && parentCardNo !== undefined) {
		return {
			裁决: "待主控裁决",
			原因: [],
			裁决声明: declaration,
			裁决摘要: renderRulingSummary(card, parentCardNo, declaration),
		};
	}
	return { 裁决: "放行", 原因: [], 裁决声明: declaration };
}
