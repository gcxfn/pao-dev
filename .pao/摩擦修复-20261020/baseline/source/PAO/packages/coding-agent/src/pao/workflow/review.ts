/**
 * 工作流复盘机械报告（§11.6 跑后复盘闭环,2026-10-03 用户拍板「每次跑完要检查本次实施,给我改进意见」）。
 *
 * 复盘是流程不是新状态:全部数据从既有账面（卡/回执/实例清单）现读,不建第二套真相（R10）。
 * 本模块只做机械汇总——每节点 派发次数/重试/打回/失败类型/末次摘要/产物/人工门/预算 vs 实耗;
 * 语义改进意见由主控基于报告给,用户拍板后经 pao_write_recipe 回写配方。本模块不调模型、不给建议。
 */

import { listCards } from "../cards/index.ts";
import type { CardStatus, ParsedCard } from "../cards/types.ts";
import {
	type CrystallizeCandidate,
	collectCrystallizeCandidates,
	renderCrystallizeSection,
} from "../knowledge/crystallize.ts";
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
}

/** 单卡回执用量聚合:跳过「汇总」行（母卡汇总=子卡之和,重复计）;缺项标未知不填零（R07）。 */
function sumUsage(cards: ParsedCard[]): { turns: number; toolCalls: number; cost: number; 未知: boolean } {
	const total = { turns: 0, toolCalls: 0, cost: 0, 未知: false };
	for (const card of cards) {
		for (const receipt of card.receipts) {
			const usage = receipt.usage;
			if (!usage || usage.来源 === "汇总") continue;
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
 * 从卡与实例清单现读构建复盘报告。节点行序＝配方拓扑序（没跑的节点也列出,尝试 0 如实）;
 * 卡面标记不在配方节点表里的进孤儿卡（配方改版后的旧卡,点名不静默）。
 */
export function buildReviewReport(recipe: WorkflowRecipe, cardsDir: string, manifest?: WorkflowManifest): ReviewReport {
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
			实耗: sumUsage([card]),
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
		const parts = [
			`━ ${row.节点}`,
			row.卡号 !== undefined ? `卡${String(row.卡号).padStart(4, "0")}` : "未落卡",
			row.卡状态 ?? "",
			`尝试${row.尝试}${row.尝试 > 1 ? `（重试${row.尝试 - 1}）` : ""}`,
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
	lines.push(
		"",
		`总账:节点 ${report.节点.length}、尝试 ${totalAttempts}、派发 ${totalDispatch}、打回 ${totalRejected}。`,
	);
	if (report.孤儿卡.length > 0)
		lines.push(
			`孤儿卡（标记的节点不在配方里,配方改版遗留）:${report.孤儿卡.map((card) => `卡${card.卡号}→${card.节点}(${card.卡状态})`).join("、")}`,
		);
	// 结晶判定显式化（借鉴①）：复盘环节必须出声,判定为是才进「做法」区（三道锁）
	lines.push("", renderCrystallizeSection(report.结晶候选));
	lines.push(
		"",
		"下一步:基于此报告给改进意见（哪步预算虚设/哪步常打回/哪步可并跑/人工门放对没有）,用户逐条拍板后用 pao_write_recipe 回写配方。",
	);
	return lines.join("\n");
}
