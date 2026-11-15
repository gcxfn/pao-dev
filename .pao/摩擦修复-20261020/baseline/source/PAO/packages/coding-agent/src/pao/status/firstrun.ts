/**
 * §16.1 首跑清单（2026-10-03 v1 惰性）：session_start 机械扫一圈渲染「今日待办」
 * 显示一次,不进每轮提示（不烧上下文）;命令可重看＝/状态（归并定案,同一出口纪律）。
 *
 * 四类待办,数据源全部复用既有件、不建第二份口径：
 * - 未完卡（进行中/失败,失败点名,坏卡列路径）＝listProjects＋scanCards（/队列 同源）;
 * - 就绪未派（§19 通道③兜底）＝wakeup.ts 就绪扫描（/队列 [就绪] 同源）;
 * - 待认领巡库卡＝patrol/draft isPatrolGoal 口径（巡卡判定同源）;
 * - 挂起工作流＝工作流实例清单状态行（status/workflow-instances 共享扫描,平布局＋任务工作区两层都扫,
 *   坏必要控制字段/读失败/目录不可达显式列「实例异常」,不伪装空闲）;
 * - 部门积压（待验证＋⚠️）＝dept/panels deptBacklogSnapshot（面板同源）。
 *
 * 待处理段（S2d 终端最小版,2026-10-04 P2）＝status/pending 聚合件同源:
 * 人工门待确认／待裁定／超限放行／缺输入补卡／失败待处置／实例恢复请求／实例异常,
 * 每项固定四行（为什么停／要决定什么／建议／证据）;无待处理项不出行。本清单只提醒,不做自动处置。
 *
 * 机械维护带（§16.1 同刻顺带）v1 如实口径：待验证积压检查已并入本清单;
 * 巡检阈值扫描随巡检件挂入;留档修剪待定时任务有留档后启用（v1 无定时任务,无可修剪）。
 * 数据量小,不分片轮转——到分片线再上（砍机制偏好）。
 * 注册随 status 模块（worker 跳过清单一并不装）;渲染失败 logWarn 不炸会话启动。
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { type CardScanProblem, scanCards } from "../cards/cardfile.ts";
import { formatCardNumber } from "../cards/counter.ts";
import type { ParsedCard } from "../cards/types.ts";
import { findUnlockedCards, wakeupViews } from "../cards/wakeup.ts";
import { deptBacklogSnapshot } from "../dept/panels.ts";
import { listProjects } from "../dept/projects.ts";
import { isPatrolGoal } from "../patrol/draft.ts";
import { logWarn } from "../shared/log.ts";
import { collectPending, renderPendingSection } from "./pending.ts";
import { scanWorkflowInstances } from "./workflow-instances.ts";

/** §16.1 首跑清单（纯读,不落盘）：四类待办各有料才出行,全空＝如实空闲一句。 */
export function buildFirstRunList(paoHome: string): string {
	const lines: string[] = [];
	for (const row of listProjects(paoHome)) {
		const cardsDir = join(row.项目根, ".pao", "卡");
		let cards: ParsedCard[];
		let problems: CardScanProblem[];
		try {
			// 可达性同 renderAllQueues 自探一次:scanCards 判 ENOENT 为空,读错要另判
			readdirSync(cardsDir);
			const scan = scanCards(cardsDir);
			cards = scan.cards;
			problems = scan.problems;
		} catch {
			continue; // 不可达项目跳过——/状态 任务区有显式标注,待办清单只列待办
		}
		const parts: string[] = [];
		const active = cards.filter((c) => c.frontmatter.status === "in_progress");
		if (active.length > 0) parts.push(`进行中 ${active.length}`);
		// 坏卡计入待办：读不出来的卡也是要做的事，不能因为出不来就不提（审查第 5 项）
		if (problems.length > 0) parts.push(`坏卡 ${problems.length}（${problems.map((p) => p.path).join("、")}）`);
		const failed = cards.filter((c) => c.frontmatter.status === "failed");
		if (failed.length > 0) {
			parts.push(
				`失败 ${failed.length}（${failed.map((c) => `${formatCardNumber(c.card_no)} ${c.frontmatter.goal}`).join("、")}）`,
			);
		}
		const patrol = cards.filter((c) => c.frontmatter.status === "unclaimed" && isPatrolGoal(c.frontmatter.goal));
		if (patrol.length > 0) parts.push(`巡库待认领 ${patrol.length}`);
		const unlocked = findUnlockedCards(wakeupViews(cards));
		if (unlocked.length > 0) {
			parts.push(`就绪未派 ${unlocked.length}（${unlocked.map((c) => formatCardNumber(c.card_no)).join("、")}）`);
		}
		// 二批图形化:项目行首符号按待办优先级——失败点名 ✗ > 就绪未派 ○ > 巡库 ◇;纯进行中不加符。
		if (parts.length > 0) {
			const prefix =
				failed.length > 0 || problems.length > 0
					? "✗ "
					: unlocked.length > 0
						? "○ "
						: patrol.length > 0
							? "◇ "
							: "";
			lines.push(`${prefix}- ${row.项目名}:${parts.join("、")}`);
		}
	}
	// 挂起实例与实例异常同源扫描（status/workflow-instances）;异常显式出行,不与空闲混同。
	const scan = scanWorkflowInstances(paoHome);
	if (scan.挂起.length > 0) {
		lines.push(`⏸ - 挂起工作流 ${scan.挂起.length}:${scan.挂起.map((s) => `${s.工作流}（${s.项目}）`).join("、")}`);
	}
	if (scan.异常.length > 0) {
		lines.push(
			`⚠ - 工作流实例异常 ${scan.异常.length}:${scan.异常.map((a) => `${a.文件}（${a.原因}）`).join("、")}`, // 保留原件人工核对，不得当空闲清理或自动续跑
		);
	}
	try {
		const backlog = deptBacklogSnapshot(paoHome);
		const pendingDepts = backlog.filter((b) => b.待验证 > 0);
		const flagged = backlog.flatMap((b) => b.警示);
		if (pendingDepts.length > 0) {
			lines.push(
				`⚠ - 部门待验证 ${pendingDepts.reduce((sum, b) => sum + b.待验证, 0)} 条（${pendingDepts.map((b) => `${b.部门} ${b.待验证}`).join("、")}）`,
			);
		}
		if (flagged.length > 0) {
			lines.push(
				`⚠ - 知识库 ⚠️ ${flagged.reduce((sum, f) => sum + f.count, 0)} 行（${flagged.map((f) => `${f.area} ${f.count}`).join("、")}）`,
			);
		}
	} catch (error) {
		lines.push(`⚠ - ${error instanceof Error ? error.message : String(error)}`);
	}
	// 待处理段（S2d）:与待办行分开计数——待办行说的是「队列里有什么」,待处理说「卡在哪等你拍板」。
	const pendingLines = renderPendingSection(collectPending(paoHome));
	const header =
		lines.length === 0
			? "今日待办:无——各项目队列干净、无挂起工作流、部门库无积压。"
			: `今日待办（${lines.length} 项）:`;
	return [
		`── 首跑清单（§16.1）──`,
		header,
		...lines,
		...pendingLines,
		"开跑自动显示一次,不进每轮提示;重看详情:/状态（同一出口）与 /队列。",
	].join("\n");
}

/** 注册首跑清单:session_start 显示一次（sendMessage display）;渲染失败 warn 不炸会话启动。 */
export function registerFirstRun(pi: ExtensionAPI, options: { resolvePaoHome: () => string }): void {
	// display 仅决定渲染，不代表禁止模型读取。三条发送路径都排除首跑清单，历史原件保留。
	pi.on("context", (event) => ({
		messages: event.messages.filter((message) => message.role !== "custom" || message.customType !== "pao-firstrun"),
	}));
	pi.on("session_before_compact", (event) => {
		event.preparation.messagesToSummarize = event.preparation.messagesToSummarize.filter(
			(message) => message.role !== "custom" || message.customType !== "pao-firstrun",
		);
		event.preparation.turnPrefixMessages = event.preparation.turnPrefixMessages.filter(
			(message) => message.role !== "custom" || message.customType !== "pao-firstrun",
		);
	});
	pi.on("session_before_tree", (event) => {
		event.preparation.entriesToSummarize = event.preparation.entriesToSummarize.filter(
			(entry) =>
				!(entry.type === "custom_message" && entry.customType === "pao-firstrun") &&
				!(
					entry.type === "message" &&
					entry.message.role === "custom" &&
					entry.message.customType === "pao-firstrun"
				),
		);
	});
	pi.on("session_start", () => {
		try {
			const text = buildFirstRunList(options.resolvePaoHome());
			pi.sendMessage({ customType: "pao-firstrun", content: [{ type: "text", text }], display: true });
		} catch (error) {
			logWarn(`[pao] 首跑清单渲染失败(跳过,不影响会话):${error instanceof Error ? error.message : String(error)}`);
		}
	});
}
