import { nowString } from "../shared/time.ts";
import { baselineSnapshotPath, diffAgainstBaseline } from "./baseline.ts";
import { scanCards } from "./cardfile.ts";
import { formatCardNumber } from "./counter.ts";
import { isPendingReview } from "./receipts.ts";
import { renderQueue } from "./render.ts";
import { isTerminal } from "./statemachine.ts";
import type { ParsedCard, QueueCardView } from "./types.ts";
import { readLatestVerdict } from "./verifier.ts";

/**
 * 交接页机械生成（pao_handoff，M2-09 件4；架构 §6.1：项目切换时留一页短交接，
 * 「已验证的」与「还在猜的」分明标注，不让压缩把猜测变事实）。
 *
 * 四段 markdown：当前目标／已发生改动／验证结果／未决事项。全部内容来自机械数据源：
 * - 当前目标：队列里非终态卡的目标列表（scanCards + renderQueue 纯读渲染；读不到的卡另行列账）；
 * - 已发生改动：逐活卡用认领基线比对（baselineSnapshotPath + diffAgainstBaseline，
 *   纯读：只读快照文件与 git status，不落盘不快照；无基线的卡如实标「不可核验」）；
 * - 验证结果：卡正文 `## 机械验收` 段最近结论（readLatestVerdict）；无记录标「未验收」；
 * - 未决事项：待审卡（isPendingReview）＋终态非已交付的卡（失败/取消，仍需 owner 裁决重派或作废）
 *   ＋卡目录扫描问题（坏卡/目录不可读）。
 *
 * 整页只读不落盘：不写卡、不写基线、不改状态；文本交调用方处置（贴会话还是落交接文件由人决定）。
 */

/** 改动清单在交接页的单卡展示上限（交接页是主控可见面，不是全量日志；全清单在基线比对工具里）。 */
const editDisplayLimit = 10;

export interface HandoffOptions {
	/** 页头时间戳；缺省取当前时间（测试可注入固定钟）。 */
	时间?: string;
}

/** 卡 → /pao queue 渲染视图（与 tools.ts 同口径：待审派生自 isPendingReview）。 */
function toQueueView(card: ParsedCard): QueueCardView {
	const fm = card.frontmatter;
	return {
		card_no: card.card_no,
		goal: fm.goal,
		status: fm.status,
		priority: fm.priority ?? "medium",
		created: fm.created,
		completed: fm.completed,
		owner: fm.owner,
		depends_on: fm.depends_on ?? [],
		parent: fm.parent,
		pending_review: isPendingReview(card),
	};
}

/** 改动行：清单超上限截断展示（如实注明总数），不把交接页涨成日志。 */
function formatChangedLine(
	card: ParsedCard,
	edit: { 状态: string; 文件: string }[],
	snapshotPath: string,
	existingEntryCount: number,
): string {
	const display = edit
		.slice(0, editDisplayLimit)
		.map((e) => `${e.状态} ${e.文件}`)
		.join("、");
	const footerNote = edit.length > editDisplayLimit ? `…等共 ${edit.length} 个文件` : "";
	return `- ${formatCardNumber(card.card_no)} ${card.frontmatter.goal}：基线外改动 ${edit.length} 个文件（${display}${footerNote}）｜比对基线 ${snapshotPath}（既有 ${existingEntryCount} 条不计 worker 的账）`;
}

/**
 * 生成交接页文本（只读）。卡目录不可读照常出页——交接页是盘点不是校验，但读不到的卡与坏卡
 * 必须逐条列进「未决事项」，不能让坏卡静默消失后显示「无未决事项」（审查第 5 项）。
 */
export async function renderHandoff(cardsDir: string, options?: HandoffOptions): Promise<string> {
	const time = options?.时间 ?? nowString();
	const { cards, problems } = scanCards(cardsDir);
	const liveCard = cards.filter((card) => !isTerminal(card.frontmatter.status));

	const sections: string[] = [];
	sections.push(
		[
			`# 交接页（机械生成 ${time}）`,
			"数据源＝队列纯读＋认领基线比对＋卡上「## 机械验收」记录；无数据源处如实标注（不可核验/未验收），不含推测。",
		].join("\n"),
	);

	// 一、当前目标：队列里非终态卡的目标列表（renderQueue 纯读渲染，含依赖边/待审标记）
	const goalText = liveCard.length > 0 ? renderQueue(liveCard.map(toQueueView)) : "无活卡（队列为空或全部终态）。";
	sections.push(
		[
			"## 当前目标",
			problems.length > 0
				? `${goalText}\n（另有 ${problems.length} 项卡目录问题未参与本段盘点，见「未决事项」。）`
				: goalText,
		].join("\n"),
	);

	// 二、已发生改动：逐活卡认领基线比对（纯读；无基线的卡标不可核验，不猜）
	const changedLine: string[] = [];
	for (const card of liveCard) {
		const snapshotPath = baselineSnapshotPath(cardsDir, card.card_no);
		const diff = await diffAgainstBaseline(snapshotPath);
		if (!diff.基线可用) {
			changedLine.push(
				`- ${formatCardNumber(card.card_no)} ${card.frontmatter.goal}：不可核验（认领基线不可用：${diff.原因 ?? diff.汇总}）`,
			);
		} else if (diff.worker改动.length === 0) {
			changedLine.push(
				`- ${formatCardNumber(card.card_no)} ${card.frontmatter.goal}：无基线外改动（既有 ${diff.既有条目数} 条不计 worker 的账）`,
			);
		} else {
			changedLine.push(formatChangedLine(card, diff.worker改动, snapshotPath, diff.既有条目数));
		}
	}
	sections.push(
		["## 已发生改动", ...(changedLine.length > 0 ? changedLine : ["（无活卡，无改动可盘点）"])].join("\n"),
	);

	// 三、验证结果：卡正文 `## 机械验收` 最近结论；无记录标未验收（「已验证的」与「还在猜的」分界线）
	const verifyLine = liveCard.map((card) => {
		const verdict = readLatestVerdict(card.body);
		return verdict
			? `- ${formatCardNumber(card.card_no)} ${card.frontmatter.goal}：机械验收 ${verdict.时间} → ${verdict.结论.length > 0 ? verdict.结论 : "记录缺结论行"}`
			: `- ${formatCardNumber(card.card_no)} ${card.frontmatter.goal}：未验收（卡上无机械验收记录）`;
	});
	sections.push(["## 验证结果", ...(verifyLine.length > 0 ? verifyLine : ["（无活卡）"])].join("\n"));

	// 四、未决事项：待审卡（回执已交待 owner 审）＋终态非已交付的卡（失败/取消，须 owner 裁决重派或作废）
	// ＋卡目录扫描问题（读不到或解析失败的卡同样是未决事项，不能因为读不出来就说「无未决事项」）
	const pendingLine: string[] = [];
	for (const problem of problems) {
		pendingLine.push(`- 卡目录问题：${problem.path}：${problem.reason}（未被计入上面的目标与改动盘点）`);
	}
	for (const card of cards.filter((candidate) => isPendingReview(candidate))) {
		pendingLine.push(
			`- ${formatCardNumber(card.card_no)} ${card.frontmatter.goal}：待审（回执已交，待 owner 审核落终态）`,
		);
	}
	for (const card of cards.filter(
		(candidate) => candidate.frontmatter.status === "failed" || candidate.frontmatter.status === "canceled",
	)) {
		pendingLine.push(
			`- ${formatCardNumber(card.card_no)} ${card.frontmatter.goal}：${card.frontmatter.status}（终态非已交付，待 owner 裁决重派/作废）`,
		);
	}
	sections.push(["## 未决事项", ...(pendingLine.length > 0 ? pendingLine : ["无未决事项。"])].join("\n"));

	return sections.join("\n\n");
}
