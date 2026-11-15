/**
 * 结晶判定显式化（genericagent 借鉴①,定案 2026-10-04「三点全采纳」）：知识沉淀不隐式发生——
 * 跑完/验收环节由 owner 显式判定「本次是否结晶出做法」,判定为是才进知识库「做法」区,
 * 走既有三道锁（时机锁＝回执必审；纪律锁＝入库/挂待验证/拒绝并写理由三选一,静默丢弃＝违规；
 * 可见锁＝待验证积压上部门面板）。
 *
 * 本模块只做机械部分：从既有账面（卡回执「值得沉淀」字段）抽候选、渲染显式判定提示、
 * 把写入决策树（No Execution No Memory）落成可测判定。不调模型、不落盘、不自动入库——
 * 「判定为是」是 owner 的动作,不是程序的动作。
 */
import type { ParsedCard } from "../cards/types.ts";
import { EVIDENCE_BLOCK_END, EVIDENCE_BLOCK_START } from "./entry.ts";

/** 写入决策树三问（借鉴护栏,顺序即优先级）：任一不过不写。 */
export const WRITE_DECISION_TREE = [
	"是否真实执行过（有回执与证据）",
	"是否与存量重复",
	"是否可定位（有最短可定位标识）",
] as const;

/** 一条结晶候选：来自某张卡某条回执的「值得沉淀」字段。 */
export interface CrystallizeCandidate {
	卡号: number;
	/** 工作流节点名（普通卡无节点标记时为 undefined） */
	节点?: string;
	值得沉淀: string;
	/** 验证出处（借鉴③口径）：卡号＋回执时间,写进条目「验证出处:」行 */
	出处: string;
}

export interface WriteVerdict {
	允许: boolean;
	原因: string;
	/** 允许时仍须满足的要求（验证出处等）；拒绝时为空 */
	要求: string[];
}

/**
 * 写入决策树判定（No Execution No Memory）：依次过「是否执行过 → 是否重复 → 是否可定位」,
 * 任一不过即拒绝并说明；全过也要求带验证出处——没有出处的「做法」只能挂「待验证」。
 */
export function judgeCrystallizeWrite(input: {
	执行过: boolean;
	/** 与哪条存量重复（钩子或路径）；无重复不传 */
	重复于?: string;
	可定位: boolean;
	/** 本次真实跑过的出处（哪张卡、哪次） */
	验证出处?: string;
}): WriteVerdict {
	if (!input.执行过) {
		return { 允许: false, 原因: "未真实执行过（只推理/只计划）:No Execution No Memory,不写记忆", 要求: [] };
	}
	const duplicatedAt = input.重复于?.trim();
	if (duplicatedAt) {
		return { 允许: false, 原因: `与存量重复（${duplicatedAt}）:先去重,存量条目可订正,不新增`, 要求: [] };
	}
	if (!input.可定位) {
		return { 允许: false, 原因: "缺最短可定位标识（部门/模块/工具/报错码）:检索不到等于没写", 要求: [] };
	}
	const provenance = input.验证出处?.trim();
	return {
		允许: true,
		原因: "决策树三问全过,可写",
		要求: provenance
			? [`落「验证出处: ${provenance}」标记行`]
			: ["写「做法」条目必须带「验证出处:」标记行（哪张卡、哪次真实验证过）；拿不出处只能挂「待验证」"],
	};
}

/** 从既有账面抽候选：卡回执里填了「值得沉淀」的条目（零新真相源,只读卡与回执）。 */
export function collectCrystallizeCandidates(cards: readonly ParsedCard[]): CrystallizeCandidate[] {
	const candidate: CrystallizeCandidate[] = [];
	for (const card of cards) {
		for (const receipt of card.receipts) {
			const worthDistilling = receipt.worth_distilling?.trim();
			if (!worthDistilling) continue;
			candidate.push({
				卡号: card.card_no,
				值得沉淀: worthDistilling,
				出处: `卡${String(card.card_no).padStart(4, "0")} 回执 ${receipt.time}`,
			});
		}
	}
	return candidate;
}

/**
 * 结晶草稿绑定（S5 包2，K14）：入库正文与引用证据分字段——正文必须是 owner 提炼的结论，
 * 引文原样进「引用证据」区块（只挂不索引不注入），程序永不自动用证据填正文。
 * 纯函数钉死数据流：正文为空（想留空后拿证据填）或与证据逐字相同（照抄不算提炼）都拒绝。
 */
export function bindCrystallizeEvidence(
	提炼正文: string,
	引用证据: string,
): {
	正文: string;
	引用证据: string;
} {
	const body = 提炼正文.trim();
	const evidence = 引用证据.trim();
	if (body.length === 0) throw new Error("提炼正文为空：正文必须是 owner 提炼的结论，不得留空后用引用证据填充");
	if (evidence.length > 0 && body === evidence)
		throw new Error("正文与引用证据逐字相同：照抄原文不算提炼，正文须用自己的话写结论");
	return { 正文: body, 引用证据: evidence };
}

/**
 * 渲染复盘/验收环节的结晶判定提示：候选逐条列出＋显式三选一＋决策树护栏。
 * 无候选也出声——「未结晶出做法」是显式判定,不是漏看（防流水账,也防默默跳过）。
 */
export function renderCrystallizeSection(candidate: readonly CrystallizeCandidate[]): string {
	const lines = [
		`结晶判定（显式,借鉴①:防流水账自动入库;静默丢弃＝违规）:本次结晶候选 ${candidate.length} 条（来自卡回执「值得沉淀」字段）`,
	];
	if (candidate.length === 0) {
		lines.push("（无候选:本次判定为「未结晶出做法」——显式结论,不是漏看）");
	} else {
		for (const item of candidate)
			lines.push(
				`- 卡${String(item.卡号).padStart(4, "0")}${item.节点 ? `·${item.节点}` : ""}：${item.值得沉淀}（出处:${item.出处}）`,
			);
	}
	lines.push(
		"逐条三选一:① 入库「做法」区（须带「验证出处:」,走三道锁）② 挂「待验证」（写清为什么还没验证）③ 拒绝并写理由。静默丢弃＝违规。",
		`写入决策树（任一问不过不写）:${WRITE_DECISION_TREE.join(" → ")};L1 只放指针与触发词,正文在 L2。`,
		`分字段纪律（K14）:正文只放提炼结论,引文原样放「${EVIDENCE_BLOCK_START}」到「${EVIDENCE_BLOCK_END}」证据区块（只挂,不进检索与嵌入）,不自动用引文填正文。`,
	);
	return lines.join("\n");
}
