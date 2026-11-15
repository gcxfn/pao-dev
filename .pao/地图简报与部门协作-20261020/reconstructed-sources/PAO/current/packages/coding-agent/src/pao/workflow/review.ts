/**
 * 工作流复盘机械报告（§11.6 跑后复盘闭环,2026-10-03 用户拍板「每次跑完要检查本次实施,给我改进意见」）。
 *
 * 复盘是流程不是新状态:全部数据从既有账面（卡/回执/实例清单）现读,不建第二套真相（R10）。
 * 本模块只做机械汇总——每节点 派发次数/重试/打回/失败类型/末次摘要/产物/人工门/预算 vs 实耗;
 * 语义改进意见由主控基于报告给,用户拍板后经 pao_write_recipe 回写配方。本模块不调模型、不给建议。
 */

import { formatCardNumber, listCards, loadCard, parseCardRef } from "../cards/index.ts";
import type { CardStatus, ParsedCard } from "../cards/types.ts";
import {
	type CrystallizeCandidate,
	collectCrystallizeCandidates,
	renderCrystallizeSection,
} from "../knowledge/crystallize.ts";
import type { FlowControl } from "./control.ts";
import { parseWorkflowMarker, type WorkflowManifest } from "./driver.ts";
import type { WorkflowRecipe } from "./recipe.ts";

export const WORKFLOW_REVIEW_SECTION = "pao-workflow-review";

export interface ReviewNodeRow {
	节点: string;
	卡号?: number;
	/** 卡现读状态（未落卡节点无卡） */
	卡状态?: CardStatus;
	/** 卡面尝试数 */
	尝试: number;
	/**
	 * v2 显式按卡计算的重试数：Σ max(attempt - 1, 0)。
	 * 多工人节点不能拿「所有卡尝试之和 - 1」，否则两张首试卡会被误报一次重试；v1 保持旧口径。
	 */
	重试?: number;
	/** 有效回执数（留档不算） */
	派发次数: number;
	/** result=failed 的回执数（含失败类型末次值） */
	打回: number;
	末次失败类型?: string;
	/** 逐次打回记录（第几次尝试、失败类型、摘要首行）：复盘默认按轮次列原因，不让人翻原始回执。 */
	打回记录: { 尝试: number; 失败类型?: string; 摘要?: string }[];
	/** 配方人工门标记与实例清单点头时间 */
	人工确认: boolean;
	已确认?: string;
	末次成功摘要?: string;
	产物: string[];
	预算?: { turns?: number; toolCalls?: number; cost?: number };
	实耗: { turns: number; toolCalls: number; cost: number; 未知: boolean };
	/** v2 当前轮与历史轮里实际归到本节点的去重卡号。 */
	卡号列表?: number[];
	/** 控制正本引用了、但盘上读不到的卡号；汇总行据此明确标不完整。 */
	缺失卡号列表?: number[];
}

export interface ReviewReport {
	工作流: string;
	/** 实例清单状态（清单缺时 undefined,如实呈现） */
	实例状态?: WorkflowManifest["状态"];
	启动?: string;
	节点: ReviewNodeRow[];
	/** 标记指向配方已删节点的卡（孤儿,报告点名不丢弃） */
	孤儿卡: { 卡号: number; 节点: string; 卡状态: CardStatus }[];
	/** 结晶候选（借鉴①：回执「值得沉淀」字段,复盘环节显式判定;零新真相源） */
	结晶候选: CrystallizeCandidate[];
	/** v2 控制正本只读副本：原始回边、判定和恢复记录必须保留。 */
	v2控制?: {
		实例: string;
		owner: string;
		回边次数: Record<string, number>;
		记录: FlowControl["记录"];
		判定: {
			节点: string;
			轮次: number;
			当前?: FlowControl["节点"][number]["判定"];
			历史: { 轮次: number; 判定?: FlowControl["节点"][number]["判定"]; 原因: string }[];
		}[];
		/** 控制正本引用但当前无法读取的卡，不静默冒充零卡。 */
		缺失卡: { 节点: string; 轮次: number; 卡号: number }[];
	};
}

interface ReviewCard {
	card: ParsedCard;
	round?: number;
}

/** 回执协议时间「YYYY-MM-DD HH:mm」的本地时间值；同分钟保持原顺序。 */
function receiptTime(receipt: ParsedCard["receipts"][number]): number {
	const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(receipt.time.trim());
	if (!match) return Number.NEGATIVE_INFINITY;
	return new Date(
		Number(match[1]),
		Number(match[2]) - 1,
		Number(match[3]),
		Number(match[4]),
		Number(match[5]),
	).getTime();
}

/** 卡回执用量聚合:跳过「汇总」行（母卡汇总=子卡之和,重复计）;整条回执缺 usage 也标未知（R07）。 */
function sumUsage(cards: ReviewCard[]): { turns: number; toolCalls: number; cost: number; 未知: boolean } {
	const total = { turns: 0, toolCalls: 0, cost: 0, 未知: false };
	for (const { card } of cards) {
		for (const receipt of card.receipts) {
			if (receipt.archive_flag) continue;
			const usage = receipt.usage;
			if (!usage) {
				total.未知 = true;
				continue;
			}
			if (usage.来源 === "汇总") continue;
			if (
				usage.来源 === "未知" ||
				usage.来源 === "unknown" ||
				usage.unknown === true ||
				(typeof usage.missing_usage_rounds === "number" && usage.missing_usage_rounds > 0)
			)
				total.未知 = true;
			for (const key of ["turns", "toolCalls", "cost"] as const) {
				const value = usage[key];
				if (typeof value === "number" && Number.isFinite(value) && value >= 0) total[key] += value;
				else total.未知 = true;
			}
		}
	}
	return total;
}

/**
 * v2 复盘：只读控制正本明确列出的当前与历史卡，按卡号去重后现读卡面与回执。
 * 卡文件已缺失时在报告里点名，不从配方名扫描其它实例的卡来补位。
 */
export function buildV2ReviewReport(recipe: WorkflowRecipe, cardsDir: string, flow: FlowControl): ReviewReport {
	if (flow.工作流 !== recipe.名字) throw new Error(`控制正本工作流「${flow.工作流}」与配方「${recipe.名字}」不一致`);
	const byNode = new Map<string, ReviewCard[]>();
	const missing: NonNullable<ReviewReport["v2控制"]>["缺失卡"] = [];
	// 控制正本中的同一卡号在同一节点内可重复出现（如历史引用补录），按卡号去重；
	// 若同一卡号跨节点或跨轮次出现，归属本身有歧义，不能静默选一张来拼报告。
	const trackedRefs = new Map<number, { 节点: string; 轮次: number }>();
	for (const node of flow.节点) {
		const rounds = [
			...node.历史.map((history) => ({ refs: history.卡, round: history.轮次 })),
			{ refs: node.卡, round: node.轮次 },
		];
		const unique = new Map<number, number>();
		for (const round of rounds)
			for (const ref of round.refs) {
				const number = parseCardRef(ref);
				const priorRound = unique.get(number);
				if (priorRound !== undefined && priorRound !== round.round)
					throw new Error(
						`卡${formatCardNumber(number)} 同时出现在节点「${node.名字}」第${priorRound}轮与第${round.round}轮，控制引用有歧义`,
					);
				unique.set(number, round.round);
				const prior = trackedRefs.get(number);
				if (prior && (prior.节点 !== node.名字 || prior.轮次 !== round.round))
					throw new Error(
						`卡${formatCardNumber(number)} 同时映射到「${prior.节点}」第${prior.轮次}轮与「${node.名字}」第${round.round}轮，控制引用有歧义`,
					);
				trackedRefs.set(number, { 节点: node.名字, 轮次: round.round });
			}
		const cards: ReviewCard[] = [];
		for (const [number, round] of unique) {
			try {
				const card = loadCard(cardsDir, number);
				const versioned = card.body.match(/<!-- pao-workflow-v2:实例=([^/\s]+)\/轮次=(\d+) -->/);
				const marker = parseWorkflowMarker(card.body);
				if (!versioned || versioned[1] !== flow.实例)
					throw new Error(`卡${formatCardNumber(number)} 的 v2 实例标记与控制正本不符，拒绝混入复盘`);
				if (marker?.流 !== recipe.名字 || marker.节点 !== node.名字 || Number(versioned[2]) !== round)
					throw new Error(
						`卡${formatCardNumber(number)} 的 v2 流/轮次/节点标记与控制正本不符（标记:${marker?.流 ?? "缺流"}/第${versioned[2]}轮/${marker?.节点 ?? "缺节点"}，正本:${recipe.名字}/第${round}轮/${node.名字}），拒绝混入复盘`,
					);
				cards.push({ card, round });
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "CARD_NOT_FOUND" || code === "ENOENT")
					missing.push({ 节点: node.名字, 轮次: round, 卡号: number });
				else throw error;
			}
		}
		byNode.set(node.名字, cards);
	}
	return buildReviewReport(recipe, cardsDir, undefined, {
		cardGroups: byNode,
		flow,
		missing,
	});
}

/**
 * 从卡与实例清单现读构建复盘报告。节点行序＝配方拓扑序（没跑的节点也列出,尝试 0 如实）;
 * 卡面标记不在配方节点表里的进孤儿卡（配方改版后的旧卡,点名不静默）。
 */
export function buildReviewReport(
	recipe: WorkflowRecipe,
	cardsDir: string,
	manifest?: WorkflowManifest,
	v2?: {
		cardGroups: Map<string, ReviewCard[]>;
		flow: FlowControl;
		missing: NonNullable<ReviewReport["v2控制"]>["缺失卡"];
	},
): ReviewReport {
	if (v2) {
		const node: ReviewNodeRow[] = recipe.拓扑序.map((name) => {
			const definition = recipe.节点.find((candidate) => candidate.名字 === name)!;
			const cards = v2.cardGroups.get(name) ?? [];
			// 「来源=汇总」是母卡对子卡账目的复述，不是一次真实派发；同 attempt 号也不能覆盖这个事实。
			// 派发、打回、摘要与产物都只看真实执行回执，用量也由 sumUsage 统一跳过汇总行。
			const allValid = cards.flatMap(({ card }) =>
				card.receipts.filter((receipt) => !receipt.archive_flag && receipt.usage?.来源 !== "汇总"),
			);
			// 卡数组顺序是创建顺序，不代表多工人完成顺序；只按协议回执时间稳定排序。
			const historyOrdered = allValid
				.map((receipt, index) => ({ receipt, index, time: receiptTime(receipt) }))
				.sort((a, b) => a.time - b.time || a.index - b.index)
				.map(({ receipt }) => receipt);
			const failed = historyOrdered.filter((receipt) => receipt.result === "failed");
			const success = historyOrdered.filter((receipt) => receipt.result === "success");
			const current = v2.flow.节点.find((candidate) => candidate.名字 === name);
			const currentCards = cards.filter(({ round }) => round === current?.轮次).map(({ card }) => card);
			const missingCards = v2.missing.filter((card) => card.节点 === name).map((card) => card.卡号);
			const usage = sumUsage(cards);
			const statusPriority: CardStatus[] = ["canceled", "failed", "in_progress", "unclaimed", "delivered"];
			return {
				节点: name,
				卡号: current?.卡.length ? parseCardRef(current.卡[0]) : undefined,
				卡号列表: cards.map(({ card }) => card.card_no),
				...(missingCards.length > 0 ? { 缺失卡号列表: [...new Set(missingCards)] } : {}),
				// 多张当前轮卡取最需要处理的汇总态，避免用最后一张覆盖失败/在途卡。
				卡状态: statusPriority.find((status) => currentCards.some((card) => card.frontmatter.status === status)),
				尝试: cards.reduce((sum, { card }) => sum + card.frontmatter.attempt, 0),
				重试: cards.reduce((sum, { card }) => sum + Math.max(card.frontmatter.attempt - 1, 0), 0),
				派发次数: allValid.length,
				打回: failed.length,
				末次失败类型: failed.at(-1)?.failure_type,
				打回记录: failed.map((receipt) => ({
					尝试: receipt.attempt,
					...(receipt.failure_type === undefined ? {} : { 失败类型: receipt.failure_type }),
					...(receipt.summary === undefined ? {} : { 摘要: receipt.summary.split("\n")[0] }),
				})),
				人工确认: definition.人工确认,
				已确认: current?.确认,
				末次成功摘要: success.at(-1)?.summary,
				产物: [...new Set(success.flatMap((receipt) => receipt.artifact_path ?? []))],
				预算: definition.预算,
				实耗: missingCards.length > 0 ? { ...usage, 未知: true } : usage,
			};
		});
		const known = new Set(recipe.节点.map((node) => node.名字));
		const orphanCard: ReviewReport["孤儿卡"] = [];
		const orphan: ReviewReport["v2控制"] = {
			实例: v2.flow.实例,
			owner: v2.flow.owner,
			回边次数: v2.flow.回边次数,
			记录: v2.flow.记录,
			判定: v2.flow.节点.map((node) => ({
				节点: node.名字,
				轮次: node.轮次,
				当前: node.判定,
				历史: node.历史.map((round) => ({
					轮次: round.轮次,
					...(round.判定 === undefined ? {} : { 判定: round.判定 }),
					原因: round.原因,
				})),
			})),
			缺失卡: v2.missing,
		};
		for (const name of v2.cardGroups.keys())
			if (!known.has(name))
				for (const { card } of v2.cardGroups.get(name) ?? [])
					orphanCard.push({ 卡号: card.card_no, 节点: name, 卡状态: card.frontmatter.status });
		return {
			工作流: recipe.名字,
			实例状态: v2.flow.状态,
			启动: v2.flow.启动,
			节点: node,
			孤儿卡: orphanCard,
			结晶候选: [...v2.cardGroups.entries()].flatMap(([node, cards]) =>
				collectCrystallizeCandidates(cards.map(({ card }) => card)).map((item) => ({ ...item, 节点: node })),
			),
			v2控制: orphan,
		};
	}
	const cards = listCards(cardsDir);
	const cardByNode = new Map<string, ParsedCard>();
	const orphanCard: ReviewReport["孤儿卡"] = [];
	for (const card of cards) {
		const marker = parseWorkflowMarker(card.body);
		if (!marker || marker.流 !== recipe.名字) continue;
		if (recipe.节点.some((node) => node.名字 === marker.节点)) cardByNode.set(marker.节点, card);
		else orphanCard.push({ 卡号: card.card_no, 节点: marker.节点, 卡状态: card.frontmatter.status });
	}

	// 结晶候选（借鉴①）：只算本配方节点的卡（孤儿卡只在报告点名,不入结晶判定）
	const crystallizeCandidate: CrystallizeCandidate[] = [...cardByNode.entries()].flatMap(([node, card]) =>
		collectCrystallizeCandidates([card]).map((item) => ({ ...item, 节点: node })),
	);

	const manifestByNode = new Map((manifest?.节点 ?? []).map((entry) => [entry.名字, entry]));
	const node: ReviewNodeRow[] = recipe.拓扑序.map((name) => {
		const node = recipe.节点.find((candidate) => candidate.名字 === name)!;
		const card = cardByNode.get(name);
		const entry = manifestByNode.get(name);
		if (!card) {
			return {
				节点: name,
				尝试: 0,
				派发次数: 0,
				打回: 0,
				打回记录: [],
				人工确认: node.人工确认,
				已确认: entry?.确认,
				产物: [],
				实耗: { turns: 0, toolCalls: 0, cost: 0, 未知: false },
			};
		}
		const validReceipt = card.receipts.filter((receipt) => !receipt.archive_flag);
		const failedReceipt = validReceipt.filter((receipt) => receipt.result === "failed");
		const lastSuccess = [...validReceipt].reverse().find((receipt) => receipt.result === "success");
		const artifact = [
			...new Set(
				card.receipts
					.filter((receipt) => receipt.result === "success")
					.flatMap((receipt) => receipt.artifact_path ?? []),
			),
		];
		return {
			节点: name,
			卡号: card.card_no,
			卡状态: card.frontmatter.status,
			尝试: card.frontmatter.attempt,
			派发次数: validReceipt.length,
			打回: failedReceipt.length,
			末次失败类型: failedReceipt.at(-1)?.failure_type,
			打回记录: failedReceipt.map((receipt) => ({
				尝试: receipt.attempt,
				...(receipt.failure_type === undefined ? {} : { 失败类型: receipt.failure_type }),
				...(receipt.summary === undefined ? {} : { 摘要: receipt.summary.split("\n")[0] }),
			})),
			人工确认: node.人工确认,
			已确认: entry?.确认,
			末次成功摘要: lastSuccess?.summary,
			产物: artifact,
			预算: node.预算,
			实耗: sumUsage([{ card }]),
		};
	});

	return {
		工作流: recipe.名字,
		实例状态: manifest?.状态,
		启动: manifest?.启动,
		节点: node,
		孤儿卡: orphanCard,
		结晶候选: crystallizeCandidate,
	};
}

function budgetLine(row: ReviewNodeRow): string {
	if (!row.预算 && !row.实耗.未知 && row.实耗.turns === 0 && row.实耗.toolCalls === 0) return "";
	const budget = row.预算
		? `${row.预算.turns ?? "?"}轮/${row.预算.toolCalls ?? "?"}次${row.预算.cost !== undefined ? `/$${row.预算.cost}` : ""}`
		: "未设";
	const actualElapsed = `${row.实耗.turns}轮/${row.实耗.toolCalls}次/$${row.实耗.cost.toFixed(2)}${row.实耗.未知 ? "（有缺账,已知下界）" : ""}`;
	return `\n  预算 vs 实耗:${budget} | ${actualElapsed}`;
}

/** 报告渲染:一行一节点＋用量行,末尾总账与下一步指引（主控意见→用户拍板→pao_write_recipe）。 */
export function renderReviewReport(report: ReviewReport): string {
	const lines: string[] = [
		`工作流「${report.工作流}」复盘（机械报告）`,
		`实例状态:${report.实例状态 ?? "（清单缺失）"}${report.启动 ? `（启动 ${report.启动}）` : ""}`,
		"",
	];
	for (const row of report.节点) {
		const foundCards =
			row.卡号列表 && row.卡号列表.length > 0
				? row.卡号列表.map((cardNo) => formatCardNumber(cardNo)).join("、")
				: row.卡号 !== undefined
					? formatCardNumber(row.卡号)
					: "";
		const missingCards = row.缺失卡号列表?.map((cardNo) => formatCardNumber(cardNo)) ?? [];
		const cardText =
			[foundCards, missingCards.length > 0 ? `缺卡${missingCards.join("、")}（CARD_NOT_FOUND）` : ""]
				.filter(Boolean)
				.join("；") || "未落卡";
		const retryText =
			row.重试 !== undefined
				? `尝试${row.尝试}（重试${row.重试}）`
				: `尝试${row.尝试}${row.尝试 > 1 ? `（重试${row.尝试 - 1}）` : ""}`;
		const parts = [
			`━ ${row.节点}`,
			cardText,
			row.卡状态 ?? "",
			retryText,
			`派发${row.派发次数}`,
			row.打回 > 0 ? `打回${row.打回}${row.末次失败类型 ? `(${row.末次失败类型})` : ""}` : "",
			row.人工确认 ? `人工门${row.已确认 ? `已确认 ${row.已确认}` : "未确认"}` : "",
		].filter(Boolean);
		lines.push(parts.join(" | "));
		// 打回逐轮列原因：普通阅读不翻原始回执，也不面对整段内部历史 JSON。
		for (const rejection of row.打回记录)
			lines.push(
				`  第 ${rejection.尝试} 次尝试被打回${rejection.失败类型 ? `（${rejection.失败类型}）` : ""}${
					rejection.摘要 ? `：${rejection.摘要}` : ""
				}`,
			);
		if (row.末次成功摘要) lines.push(`  末次成功摘要:${row.末次成功摘要.split("\n")[0]}`);
		if (row.产物.length > 0) lines.push(`  产物:${row.产物.join("、")}`);
		const budget = budgetLine(row);
		if (budget) lines.push(budget.trimStart());
	}
	const totalAttempts = report.节点.reduce((sum, row) => sum + row.尝试, 0);
	const totalDispatch = report.节点.reduce((sum, row) => sum + row.派发次数, 0);
	const totalRejected = report.节点.reduce((sum, row) => sum + row.打回, 0);
	const totalRetries = report.节点.reduce((sum, row) => sum + (row.重试 ?? 0), 0);
	const incomplete =
		report.v2控制 && report.v2控制.缺失卡.length > 0
			? `；汇总不完整（CARD_NOT_FOUND）：缺失卡 ${report.v2控制.缺失卡.length} 张，控制引用未全部计入`
			: "";
	lines.push(
		"",
		`总账:节点 ${report.节点.length}、尝试 ${totalAttempts}、派发 ${totalDispatch}、打回 ${totalRejected}${report.v2控制 ? `、重试 ${totalRetries}${incomplete}` : ""}。`,
	);
	if (report.孤儿卡.length > 0)
		lines.push(
			`孤儿卡（标记的节点不在配方里,配方改版遗留）:${report.孤儿卡.map((card) => `卡${card.卡号}→${card.节点}(${card.卡状态})`).join("、")}`,
		);
	if (report.v2控制) {
		lines.push(
			"",
			`v2 实例:${report.v2控制.实例}；owner:${report.v2控制.owner}`,
			`回边次数:${JSON.stringify(report.v2控制.回边次数)}`,
			`判定记录:${JSON.stringify(report.v2控制.判定)}`,
			`控制记录:${JSON.stringify(report.v2控制.记录)}`,
		);
		if (report.v2控制.缺失卡.length > 0)
			lines.push(
				`缺失卡（控制正本有引用，盘上读不到）:${report.v2控制.缺失卡
					.map((card) => `卡${formatCardNumber(card.卡号)}→${card.节点}/第${card.轮次}轮`)
					.join("、")}`,
			);
	}
	// 结晶判定显式化（借鉴①）：复盘环节必须出声,判定为是才进「做法」区（三道锁）
	lines.push("", renderCrystallizeSection(report.结晶候选));
	lines.push(
		"",
		"下一步:基于此报告给改进意见（哪步预算虚设/哪步常打回/哪步可并跑/人工门放对没有）,用户逐条拍板后用 pao_write_recipe 回写配方。",
	);
	return lines.join("\n");
}
