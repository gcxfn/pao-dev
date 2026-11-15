import { readdirSync } from "node:fs";
import { join } from "node:path";
import { listProjects } from "../dept/projects.ts";
import { listCards } from "./cardfile.ts";
import { formatCardNumber, parseCardRef } from "./counter.ts";
import type { CardPriority, CardStatus, QueueCardView } from "./types.ts";
import { findUnlockedCards } from "./wakeup.ts";

const STATUS_GROUP_ORDER: CardStatus[] = ["unclaimed", "in_progress", "failed", "delivered", "canceled"];

const PRIORITY_RANK: Record<CardPriority, number> = { high: 3, medium: 2, low: 1 };

function parseCreateTime(text: string): number {
	// "YYYY-MM-DD HH:mm" 按字典序即时间序，转成可比较数值
	const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(text.trim());
	if (!match) return 0;
	return Number(`${match[1]}${match[2]}${match[3]}${match[4]}${match[5]}`);
}

function parseFinishTime(text: string | undefined): number {
	return text ? parseCreateTime(text) : 0;
}

/**
 * /pao queue 渲染（纯函数，架构 §2.2 渲染契约）：
 * - 分组按状态，组序固定：待认领/进行中/失败/已交付/取消；
 * - 活卡组（待认领/进行中/失败）排序 = 优先级降序 + 创建升序（顶卡即下一个要派的）；
 * - 已交付组 = 完成时间倒序；取消组同法；
 * - 必显依赖边（带前置卡当前状态）与 parent 边；
 * - 进行中且当前尝试已有回执 = 待审（worker 交回执只是待审）。
 */
export function renderQueue(cards: readonly QueueCardView[]): string {
	if (cards.length === 0) {
		return "队列为空。";
	}
	const statusByNumber = new Map<number, CardStatus>();
	for (const card of cards) statusByNumber.set(card.card_no, card.status);
	// §19 通道②：待认领且依赖全满足 → 高亮「就绪」（无依赖卡不标，只报有信息量的信号）
	const unlockedNumbers = new Set(findUnlockedCards(cards).map((c) => c.card_no));

	const formatDependency = (ref: string): string => {
		const number = parseCardRef(ref);
		const status = statusByNumber.get(number);
		return `${formatCardNumber(number)}(${status ?? "不存在"})`;
	};

	const lines: string[] = [];
	for (const status of STATUS_GROUP_ORDER) {
		const group = cards.filter((card) => card.status === status);
		if (group.length === 0) continue;
		const sorted = [...group].sort((a, b) => {
			if (status === "delivered" || status === "canceled") {
				return parseFinishTime(b.completed) - parseFinishTime(a.completed);
			}
			const byPriority = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
			if (byPriority !== 0) return byPriority;
			return parseCreateTime(a.created) - parseCreateTime(b.created);
		});
		lines.push(`## ${status}（${sorted.length}）`);
		for (const card of sorted) {
			const flags: string[] = [];
			if (card.pending_review) flags.push("待审");
			if (unlockedNumbers.has(card.card_no)) flags.push("就绪");
			const flagText = flags.length > 0 ? ` [${flags.join("/")}]` : "";
			lines.push(
				`- ${formatCardNumber(card.card_no)} ${card.goal}${flagText}｜优先级:${card.priority}｜创建:${card.created}｜owner:${card.owner ?? "未认领"}`,
			);
			if (card.depends_on.length > 0) {
				lines.push(`  依赖: ${card.depends_on.map(formatDependency).join("、")}`);
			}
			if (card.parent) {
				const parentNumber = parseCardRef(card.parent);
				lines.push(`  父卡: ${formatCardNumber(parentNumber)}(${statusByNumber.get(parentNumber) ?? "不存在"})`);
			}
		}
	}
	return lines.join("\n");
}

/**
 * /队列 --全部 渲染（纯函数，只读聚合，M2-01 §5）：读 PAO_HOME/项目清单.md 逐行，
 * 查 <项目根>/.pao/卡 汇总各状态条数（只要计数，不整页渲染）。
 * - 卡目录不存在或读失败：该行显式标「不可达」，不当零任务——零任务与不可达是两种事实；
 * - 目录可达但无卡：各状态计 0，明示为零任务；
 * - 项目清单文件不存在或为空：渲染「尚无服务过的项目记录」空态。
 * 任何分支都不写盘；M3 壳复用同一出口，不建第二份项目目录。
 */
export function renderAllQueues(paoHome: string): string {
	const rows = listProjects(paoHome);
	if (rows.length === 0) return "尚无服务过的项目记录。";
	const lines: string[] = [`全部项目队列（${rows.length} 个项目）：`];
	for (const row of rows) {
		const cardsDir = join(row.项目根, ".pao", "卡");
		const counts: Record<CardStatus, number> = { unclaimed: 0, in_progress: 0, failed: 0, delivered: 0, canceled: 0 };
		let reachable = true;
		try {
			// 可达性判定须自探一次：listCards 吞读错返回空数组，直接用它分不清「零任务」和「不可达」
			readdirSync(cardsDir);
		} catch {
			reachable = false;
		}
		if (reachable) {
			for (const card of listCards(cardsDir)) counts[card.frontmatter.status] += 1;
		}
		lines.push(
			reachable
				? `- ${row.项目名}（${row.项目根}）：${STATUS_GROUP_ORDER.map((status) => `${status} ${counts[status]}`).join("、")}`
				: `- ${row.项目名}（${row.项目根}）：不可达（.pao/卡 目录不存在或读失败）`,
		);
	}
	return lines.join("\n");
}
