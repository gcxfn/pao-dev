/**
 * S2d 终端待处理最小版（定案 2026-10-02 M3 桌面壳 / 收编入 2026-10-04 后续执行总册 P2）:
 * 把散在各会话的待确认（人工门/裁定）、缺输入、审核打回、超限放行、恢复请求聚成一个待处理列表,
 * 每项固定四行——为什么停在这里／需要用户决定什么／推荐怎么处理／证据点开哪里看。
 *
 * 数据源全部来自既有正本（工作流实例清单＋v2 控制正本、卡与回执、实例异常扫描）,
 * 零新真相源、零新状态字段、零落盘;本模块只读,不做自动处置（定案「不做」）。
 * 终端最小版＝首跑清单扩展（firstrun 调 collectPending/renderPendingSection）;
 * 跨对话聚合的桌面版不在本模块范围。
 *
 * 判据取自正本的结构化字段,不对文案做关键词猜测:
 * - 人工门＝报告节点 挂起 === 人工门挂起原因（与 driver 同一判据）;
 * - 裁定＝控制正本 flow.裁定（通道 主控/人工 由 control 写）;
 * - 超限放行＝控制正本 flow.暂停 含「超限」（control 超限动作=停滞 时的挂起文案）;
 * - 缺输入/审核打回＝卡状态失败时最后一条回执的失败分型（缺输入＝补卡;能力不足/结果未知＝须裁定）;
 * - 恢复请求＝旧版实例清单挂起（清单无停因字段）与实例异常（坏字段/目录不可达,不得当空闲清理）。
 *
 * 实例信号取 scanInstanceSignals 而非挂起清单:人工门未确认的 v2 实例在 controlReport 里仍报
 * 「运行中」（complete 要求 node.确认 已写）,只扫挂起行会漏掉「为什么停在这里」的头号来源。
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { listCards } from "../cards/cardfile.ts";
import { formatCardNumber } from "../cards/counter.ts";
import type { ParsedCard } from "../cards/types.ts";
import { listProjects } from "../dept/projects.ts";
import { humanGateSuspendReason } from "../workflow/driver.ts";
import { type InstanceAnomalyRow, type InstanceSignalRow, scanInstanceSignals } from "./workflow-instances.ts";

/** 待处理项:固定四行口径（为什么停/要决定什么/建议/证据）＋一行主体标识。 */
export interface PendingItem {
	/** 类型标签（人工门待确认／待裁定／超限放行／缺输入补卡／失败待处置／实例恢复请求／实例异常） */
	类型: string;
	/** 主体:哪张卡、哪个工作流节点、哪个项目 */
	主体: string;
	为什么停: string;
	要决定什么: string;
	建议: string;
	/** 证据路径（可点开看的原件;同类合并计数的项没有单一证据） */
	证据: string[];
	/** 卡侧项的归属部门（卡面 frontmatter 原值）;实例/异常项无此字段（桌面看板按部门定位卡条目用） */
	部门?: string;
}

/** collectPending 限额覆盖（全部可选;缺省行为与不传完全一致,TUI 等现有调用零影响）。 */
export interface CollectPendingOptions {
	/** 列表总条数上限;缺省不截断（终端渲染层 renderPendingSection 另按 PENDING_ITEM_LIMIT 截）。 */
	itemLimit?: number;
	/** 同一实例的门类项上限;缺省 INSTANCE_GATE_LIMIT。 */
	instanceGateLimit?: number;
	/** 卡侧同类项上限;缺省 CARD_ITEM_LIMIT。 */
	cardItemLimit?: number;
}

/** 单次列出上限:首跑清单是提醒面,不是全量台账;超出的用 /状态 与 /队列 看全。 */
export const PENDING_ITEM_LIMIT = 6;

/** 同一实例的门类项上限:一个实例可能同时有多个门,避免一个实例挤满整段。 */
const INSTANCE_GATE_LIMIT = 2;

/** 卡侧同类项上限:失败卡可能成批,按分型各留前 N 条,其余并入尾行计数。 */
const CARD_ITEM_LIMIT = 3;

/** 实例信号 → 待处理项（人工门→裁定→超限放行→恢复请求,与实际卡点顺序一致）。 */
function signalPending(row: InstanceSignalRow, gateLimit: number): PendingItem[] {
	const evidence = [row.路径];
	const items: PendingItem[] = [];
	for (const gate of row.人工门.slice(0, gateLimit)) {
		items.push({
			类型: "人工门待确认",
			主体: `工作流「${row.工作流}」节点「${gate.节点}」（${row.项目}）`,
			为什么停: `${humanGateSuspendReason}：节点本轮已交付而门未点头（实例报告状态仍是「${row.状态}」）`,
			要决定什么: "是否放行该门；点头后立即续跑下游节点",
			建议: `pao_control_node action=confirm name=${row.工作流} instance=${row.实例 ?? "见证据"} node=${gate.节点} round=${gate.轮次}（须你在界面确认）`,
			证据: evidence,
		});
	}
	if (row.人工门.length > gateLimit)
		items.push({
			类型: "人工门待确认",
			主体: `工作流「${row.工作流}」另有 ${row.人工门.length - gateLimit} 个门未点头`,
			为什么停: "同实例门类项超出单次列出上限",
			要决定什么: "逐门确认或整例暂停",
			建议: `用 /pao flow see ${row.工作流} 看全部门`,
			证据: evidence,
		});
	if (row.裁定) {
		const channel = row.裁定.通道;
		items.push({
			类型: "待裁定",
			主体: `工作流「${row.工作流}」节点「${row.裁定.节点}」（${row.项目}）第 ${row.裁定.轮次} 轮`,
			为什么停: `${row.暂停 ?? `等待${channel}裁定`}；请求理由:${row.裁定.理由}`,
			要决定什么:
				channel === "人工"
					? "由你给出三态结果（pass/change/reject）与理由，主控不得代替"
					: "给出裁定结果（pass/change/reject）与理由",
			建议: `pao_control_node action=rule name=${row.工作流} instance=${row.实例 ?? "见证据"} node=${row.裁定.节点} round=${row.裁定.轮次} result=<pass|change|reject> reason=<…>`,
			证据: evidence,
		});
	} else if (row.暂停?.includes("超限")) {
		items.push({
			类型: "超限放行",
			主体: `工作流「${row.工作流}」（${row.项目}）`,
			为什么停: row.暂停,
			要决定什么: "停滞等放行，还是收手改配方；放行即继续修这一轮",
			建议: `拍板后用 pao_control_node action=confirm 放行，或停流改配方后建新实例（不改进已冻结实例）`,
			证据: evidence,
		});
	}
	if (items.length === 0 && (row.待恢复 || row.状态 === "挂起")) {
		items.push({
			类型: "实例恢复请求",
			主体: `工作流「${row.工作流}」（${row.项目}）`,
			为什么停: row.待恢复
				? "旧版实例清单标记挂起；清单不含停因字段，停因无法从清单读出"
				: (row.暂停 ?? "控制正本标记挂起，但无停因记录"),
			要决定什么: row.待恢复 ? "是否核对卡状态后人工重建为新版实例继续" : "是否恢复该实例；恢复前须确认没有在途卡",
			建议: row.待恢复
				? "保留原件，先看卡与回执确认没有在途卡，再人工重建清单（旧实例不可自动续跑）"
				: `pao_control_node action=resume name=${row.工作流} instance=${row.实例 ?? "见证据"} prev_owner=${row.owner ?? "见证据"} reason=<现场核查>（须你在界面确认）`,
			证据: evidence,
		});
	}
	return items;
}

function errorItems(subject: string, reason: string, evidence: string[]): PendingItem {
	return {
		类型: "实例异常",
		主体: subject,
		为什么停: reason,
		要决定什么: "人工核对原件；坏字段/不可达不等于空闲，不得当空闲清理或自动续跑",
		建议: "保留原件，修复或重建后再续跑",
		证据: evidence,
	};
}

/** 实例异常行 → 待处理项（目录不可达与坏实例文件同口径）。 */
function anomalyPending(row: InstanceAnomalyRow): PendingItem {
	return errorItems(`实例「${row.文件}」`, row.原因, [row.路径]);
}

/** 失败卡 → 待处理项:缺输入＝退回补卡;能力不足/结果未知＝须裁定;瞬时故障自动重派不列。 */
function cardPending(paoHome: string, cardLimit: number): PendingItem[] {
	const items: PendingItem[] = [];
	let missingInput = 0;
	let pendingHandle = 0;
	for (const row of listProjects(paoHome)) {
		const cardsDir = join(row.项目根, ".pao", "卡");
		let cards: ParsedCard[];
		try {
			readdirSync(cardsDir);
			cards = listCards(cardsDir);
		} catch {
			continue; // 不可达项目跳过——/状态 任务区有显式标注,待处理只列能定位证据的项
		}
		for (const card of cards) {
			if (card.frontmatter.status !== "failed") continue;
			const last = card.receipts[card.receipts.length - 1];
			const typing = last?.failure_type;
			const cardName = `${formatCardNumber(card.card_no)} ${card.frontmatter.goal}（${row.项目名}）`;
			if (typing === "missing_input") {
				missingInput++;
				if (missingInput > cardLimit) continue;
				items.push({
					类型: "缺输入补卡",
					主体: cardName,
					为什么停: "失败分型为缺输入，按分型不自动重派（重派也是白跑）",
					要决定什么: "由谁补上输入指针（派卡方或你）",
					建议: "补上输入后走 失败→待认领 重试",
					证据: [card.path],
					部门: card.frontmatter.dept,
				});
			} else if (typing === "insufficient_capability" || typing === "unknown_outcome") {
				pendingHandle++;
				if (pendingHandle > cardLimit) continue;
				items.push({
					类型: "失败待处置",
					主体: cardName,
					为什么停: `失败分型为${typing}（末次回执已留档，卡不再自动重派）`,
					要决定什么: "换部门重派、拆卡，还是放弃这张卡",
					建议: last?.summary ? `看末次回执摘要后拍板：${last.summary}` : "看卡上末次回执后拍板",
					证据: [card.path],
					部门: card.frontmatter.dept,
				});
			}
		}
	}
	if (missingInput > cardLimit)
		items.push({
			类型: "缺输入补卡",
			主体: `另有 ${missingInput - cardLimit} 张缺输入失败卡未列出`,
			为什么停: "同类超出单次列出上限",
			要决定什么: "是否批量补输入",
			建议: "用 /队列 看全量失败卡",
			证据: [],
		});
	if (pendingHandle > cardLimit)
		items.push({
			类型: "失败待处置",
			主体: `另有 ${pendingHandle - cardLimit} 张待处置失败卡未列出`,
			为什么停: "同类超出单次列出上限",
			要决定什么: "是否逐张处置",
			建议: "用 /队列 看全量失败卡",
			证据: [],
		});
	return items;
}

/** 聚合待处理列表（只读,零落盘;各源失败降级为异常项,不抛错炸首跑）。
 * 限额可用 options 覆盖（桌面看板取全量传大值）;不传时行为与旧签名完全一致。 */
export function collectPending(paoHome: string, options?: CollectPendingOptions): PendingItem[] {
	const gateLimit = options?.instanceGateLimit ?? INSTANCE_GATE_LIMIT;
	const cardLimit = options?.cardItemLimit ?? CARD_ITEM_LIMIT;
	const items: PendingItem[] = [];
	let scan: ReturnType<typeof scanInstanceSignals>;
	try {
		scan = scanInstanceSignals(paoHome);
	} catch (error) {
		return [errorItems("实例扫描", error instanceof Error ? error.message : String(error), [paoHome])];
	}
	for (const row of scan.实例) items.push(...signalPending(row, gateLimit));
	for (const row of scan.异常) items.push(anomalyPending(row));
	try {
		items.push(...cardPending(paoHome, cardLimit));
	} catch (error) {
		items.push(errorItems("卡扫描", error instanceof Error ? error.message : String(error), [paoHome]));
	}
	return options?.itemLimit === undefined ? items : items.slice(0, Math.max(0, options.itemLimit));
}

/**
 * 渲染待处理段（每项固定四行:为什么停/要决定什么/建议/证据）。
 * 无待处理项返回空数组——首跑清单据此不出行,不冒充待办。
 */
export function renderPendingSection(items: readonly PendingItem[]): string[] {
	if (items.length === 0) return [];
	const shown = items.slice(0, PENDING_ITEM_LIMIT);
	const lines = [`待处理（${items.length} 项,需你拍板;每项四行:为什么停／要决定什么／建议／证据）:`];
	shown.forEach((item, index) => {
		lines.push(`▸ ${index + 1}. ${item.类型} · ${item.主体}`);
		lines.push(`   为什么停：${item.为什么停}`);
		lines.push(`   要决定什么：${item.要决定什么}`);
		lines.push(`   建议：${item.建议}`);
		lines.push(`   证据：${item.证据.length > 0 ? item.证据.join("；") : "（无——同类项已合并计数）"}`);
	});
	if (items.length > shown.length)
		lines.push(`…另有 ${items.length - shown.length} 项未列出，用 /状态 与 /队列 看全。`);
	return lines;
}
