/**
 * 巡库卡编排接口（卡0006）：把 落巡库卡 包装成 registerKnowledgeTools 的 afterInspect 回调
 * （仿 cards/tools.ts 的 appendQueueSections 可选回调先例；接线由主控统一写）。
 * 真实后台 worker 拉起为「待真实端点验收」——本轮只做 触发＋落卡＋提示文本。
 */
import { join } from "node:path";

import { DEPT_DIR_NAME, REGISTRY_FILE_NAME, readRegistry } from "../dept/index.ts";
import type { InspectionReport } from "../knowledge/index.ts";
import { nowString } from "../shared/time.ts";
import { buildPatrolCardDraft, DEFAULT_PATROL_THRESHOLD } from "./draft.ts";
import { dropPatrolCard } from "./drop.ts";

export interface PatrolHookOptions {
	/** 发起巡检的部门（巡库卡落本部队列） */
	部门: string;
	/** 发起部门的卡目录（本部队列，任务工作区的 卡/ 目录） */
	resolveCardsDir: () => string;
	/** 卡号计数器文件路径；缺省 createCard 默认推导 */
	counterPath?: string;
	/** ⚠️ 数阈值；缺省 DEFAULT_PATROL_THRESHOLD（5） */
	阈值?: number;
	/** 知识库根路径；提供时进卡 输入 首条指针，worker 才能据此定位条目 */
	知识库路径?: string;
	/** 创建时间时钟；缺省取当前时间（测试可注入） */
	now?: () => Date;
}

/**
 * 产出 afterInspect 回调：收巡检报告 → 阈值判定 → 落巡库卡 → 返回提示文本（并进 pao_inspect_kb 输出）。
 * 不过阈值返回 undefined（工具输出与未接线完全一致）；落卡异常原样抛出，由接线层在回调内兜底。
 */
export function createPatrolHook(
	options: PatrolHookOptions,
): (report: InspectionReport) => Promise<string | undefined> {
	return async (report) => {
		const draft = buildPatrolCardDraft(report, options);
		if (!draft) return undefined;
		const { card, exists, 读取问题 } = await dropPatrolCard(
			options.resolveCardsDir(),
			draft,
			nowString((options.now ?? (() => new Date()))()),
			{ counterPath: options.counterPath },
		);
		// 卡目录里有读不出来的卡时查重是不完整的：如实附在提示里，不假装已经确认过全部卡（审查第 5 项）
		const scanNote =
			读取问题 && 读取问题.length > 0
				? `\n⚠️ 另有 ${读取问题.length} 张卡读不出来，本次查重未包含：${读取问题.map((p) => `${p.path}（${p.reason}）`).join("；")}`
				: "";
		const threshold = options.阈值 ?? DEFAULT_PATROL_THRESHOLD;
		if (exists) {
			return (
				`⚠️ ${report.flaggedCount} 条已过巡库阈值（${threshold}）：本部已有未终态巡库卡 ${card.filename}` +
				`（卡#${card.card_no}），不重复落卡。${scanNote}`
			);
		}
		return (
			`⚠️ ${report.flaggedCount} 条已过巡库阈值（${threshold}）：已落巡库卡 ${card.filename}` +
			`（卡#${card.card_no}）到本部队列，状态 unclaimed；巡库 worker 只准写 ⚠️ 标记与初判，不准动条目正文。${scanNote}`
		);
	};
}

/** 路径归一比较用:统一正斜杠并去尾部斜杠 */
function normalizePath(p: string): string {
	const slashed = p.replaceAll("\\", "/");
	return slashed.endsWith("/") ? slashed.slice(0, -1) : slashed;
}

/** 由知识库根路径反查部门名(注册表 库路径 匹配;读不到/查不到返回 undefined) */
function findDeptByLibRoot(home: string, libRoot: string): string | undefined {
	try {
		const rows = readRegistry(join(home, DEPT_DIR_NAME, REGISTRY_FILE_NAME));
		const target = normalizePath(libRoot);
		const hit = rows.find(
			(row) => target === normalizePath(join(home, row.库路径)) || target.endsWith(`/${normalizePath(row.库路径)}`),
		);
		return hit?.名字;
	} catch {
		return undefined;
	}
}

/**
 * 巡库卡接线(卡0006,架构 §6.7):pao_inspect_kb 报告 ⚠️ 过阈值 → 自动落巡库卡到本部队列。
 * 部门由所巡库根路径反查注册表;库不在注册表 → 只提示不落卡;
 * 落卡异常降级为提示文本,绝不影响巡检结果本身。home/卡目录延迟到调用时解析。
 */
export function patrolAfterInspect(
	getHome: () => string,
	getCardsDir: () => string,
): (report: InspectionReport, libRoot: string) => Promise<string | undefined> {
	return async (report, libRoot) => {
		const home = getHome();
		const dept = findDeptByLibRoot(home, libRoot);
		if (!dept) {
			return `巡检 ⚠️ ${report.flaggedCount} 条,但知识库 ${libRoot} 不在部门注册表(${join(home, DEPT_DIR_NAME, REGISTRY_FILE_NAME)}),未落巡库卡。`;
		}
		try {
			return await createPatrolHook({
				部门: dept,
				resolveCardsDir: getCardsDir,
				知识库路径: libRoot,
			})(report);
		} catch (error) {
			return `巡库卡落卡失败(巡检结果不受影响):${error instanceof Error ? error.message : String(error)}`;
		}
	};
}
