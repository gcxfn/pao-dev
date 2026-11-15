/**
 * G1 上下文与待办恢复：主控重开/压缩后查回「目标·要求·约束·确认版本·待办·未决意见·必要文件引用」的只读查询面。
 *
 * 设计边界（计划 §8.1）：
 * - **不立新真相源**：目标/要求/约束/确认版本来自临时计划正本（`workflow/plan.ts`），
 *   未决意见与投递状态来自 `<计划目录>/意见.md`（`workflow/plan-feedback.ts`），
 *   现场信号来自 `status/pending.ts`（`collectPending`）与 `status/workflow-instances.ts`（`scanInstanceSignals`），
 *   会话待办来自 `todo/core.ts`（`scanTodoState`，压压缩快照条目）。本模块只做组合与投影，零落盘、零新状态字段。
 * - **不常驻全历史**：列表面只给一行摘要＋稳定身份键；详情面按需取（`recallPlan` 才读步骤正文与意见正文）。
 * - **不触发派发**：本文件只 import 读函数，绝不 import 派发链；`assertSnapshotIsReadOnly` 旁边的注释
 *   与测试共同钉住这一点（开查询入口不得让任何卡进入 in_progress）。
 * - **提醒可丢、事实不能只存内存**：每条待办都带 `证据`（正本文件路径或条目 id）；任何提醒/通知通道
 *   失败都不改变这里的事实——`buildRecallReminder` 只做字符串拼接，不依赖通知面是否可用。
 *
 * 身份键口径与桌面 `workflow-cards-model.ts` 的 `todoKey` 同源（六段 + 可选意见ID，`\u0000` 连接），
 * 这样桌面视图与内核视图对「同一条待办」给出同一个键，多视图下天然只生效一次（`dedupeTodos`）。
 *
 * 旧提醒不推进新轮次：每条待办绑定 `实例/步骤/轮次/版本` 四要素；提醒文本生成时把绑定四要素一并带出，
 * 消费方用 `isRecallTodoStale` 比较当前现场——旧轮次的提醒不会把当前轮次推进（本模块零写入，
 * 「推进」只能由消费方按 stale 判定拒绝）。取不到的字段一律 undefined，不编 0、不编空串。
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { projectRootForCards, scanCards } from "../cards/cardfile.ts";
import { formatCardNumber, parseCardRef } from "../cards/counter.ts";
import type { ParsedCard, Receipt } from "../cards/types.ts";
import { listProjects } from "../dept/projects.ts";
import type { TodoItem } from "../todo/core.ts";
import { STALE_REMINDER_THRESHOLD, TODO_REMINDER_MARKER } from "../todo/core.ts";
import { controlView, readControl } from "../workflow/control.ts";
import {
	listPlanHistory,
	listTemporaryPlans,
	type PlanHistoryEntry,
	type PlanStartRecord,
	planFilePath,
	planStartRecordPath,
	queryTemporaryPlan,
	readPlanStart,
	readPlanStartIntent,
	readTemporaryPlan,
	type TemporaryPlanDefinition,
	type TemporaryPlanStep,
} from "../workflow/plan.ts";
import {
	listPlanFeedback,
	type PlanFeedbackEntry,
	type PlanFeedbackStatus,
	type PlanFeedbackTarget,
	planFeedbackPath,
} from "../workflow/plan-feedback.ts";
import { type InstanceSignalRow, scanInstanceSignals } from "./workflow-instances.ts";

/** 待办五类（与桌面 `TodoKind` 同序列：恢复→确认→缺输入→失败→未送达）。 */
export const RECALL_TODO_KINDS = ["recovery", "confirm", "missing_input", "failed", "undelivered"] as const;

export type RecallTodoKind = (typeof RECALL_TODO_KINDS)[number];

/** 身份键分隔符：与桌面 `todoKey` 逐字同源（此处重复一次而不是 import，桌面包不在内核依赖方向内）。 */
const TODO_KEY_SEPARATOR = "\u0000";

/**
 * 待办的绑定身份：实例/步骤/轮次/版本四要素。
 * 取不到的字段一律 undefined（例如散卡没有实例、卡侧没有轮次），**不补 0、不补空串**。
 */
export interface RecallTodoIdentity {
	/** 工作流实例 UUID（v2）；散卡与 v1 旧实例没有，leave undefined */
	实例?: string;
	/** 步骤/节点名字；散卡没有，leave undefined */
	步骤?: string;
	/** 轮次（1 起）；卡侧信号取不到轮次，leave undefined */
	轮次?: number;
	/** 绑定时的临时计划定义版本；非临时计划或没读到定义，leave undefined */
	定义版本?: number;
}

/** 一条重建出来的待办（只读投影，不是状态）。 */
export interface RecallTodo {
	/** 五类之一 */
	种类: RecallTodoKind;
	/** 稳定身份键：同一条待办在任何视图里都得到同一个键（见 `recallTodoKey`） */
	身份键: string;
	/** 一句话：要干什么 */
	文案: string;
	/** 为什么停在这里（正本原文或机械判据说明） */
	原因: string;
	/** 绑定身份四要素；取不到即 undefined */
	绑定: RecallTodoIdentity;
	/** 证据：正本文件路径或条目 id（提醒丢了也能按它查回事实） */
	证据: string[];
	/** 可选的关联意见 ID（未决意见类待办才有） */
	意见ID?: string;
	/** 可选的部门（卡侧信号才有） */
	部门?: string;
	/** 可选的卡号（卡侧信号才有） */
	卡号?: number;
}

/** 未决意见（计划意见.md 里还没走完的意见）。 */
export interface RecallOpenFeedback {
	意见ID: string;
	状态: PlanFeedbackStatus;
	目标: string;
	正文: string;
	定义版本: number;
	记录时刻: string;
	更新时刻: string;
	/** 投递结果原文（有待送达/投递失败时才有；投递成功为送达回执） */
	投递结果?: string;
	/** 正本文件路径，按需读原文 */
	路径: string;
	/** 意见指向的步骤 ID（流程级意见没有，leave undefined） */
	步骤ID?: string;
	/** 文件级意见的轮次（步骤/流程级没有，leave undefined） */
	轮次?: number;
}

/** 计划面：列表里的一行（简短）。 */
export interface RecallPlanSummary {
	计划ID: string;
	显示名: string;
	定义版本: number;
	已撤销: boolean;
	步骤数: number;
	/** 已启动实例（启动关联里读到的，可能多份） */
	实例: string[];
	/** 未决意见条数（不含已应用） */
	未决意见数: number;
	/** 定义文件路径（必要文件引用） */
	定义文件: string;
}

/** 计划面：按需取的详情。 */
export interface RecallPlanDetail extends RecallPlanSummary {
	项目根: string;
	来源会话?: string;
	创建时刻: string;
	更新时刻: string;
	/** 步骤原文（要求/约束/验收等）；不传 focusStep 就全给，传了只给那一步 */
	步骤: TemporaryPlanStep[];
	/** 历史版本（升序）；坏存档只点名，不当没有 */
	历史: PlanHistoryEntry[];
	启动: PlanStartRecord[];
	未决意见: RecallOpenFeedback[];
	/** 已应用的意件（单独列出，不算未决） */
	已应用意见: RecallOpenFeedback[];
	/** 必要文件引用：定义/意见/启动关联/历史目录 */
	必要文件: string[];
	/** 读不出或需要注意的问题（逐条点名，不静默当没有） */
	问题: string[];
}

/** 会话待办快照（`scanTodoState` 的投影；压缩前后查回同一份事实）。 */
export interface RecallSessionTodo {
	清单: TodoItem[];
	/** 自上次 todo_write 起的实质调用次数（陈旧度） */
	陈旧计数: number;
	/** 本次是否已经提醒过（提醒可丢；事实在上面） */
	已提醒: boolean;
	/** 压缩留存快照是否存在（存在＝走过压缩边界） */
	有压缩快照: boolean;
}

/** 一条现场信号（从 pending/实例扫描投影而来，保留原字段供详情面使用）。 */
export interface RecallSignal {
	类型: string;
	主体: string;
	为什么停: string;
	要决定什么: string;
	证据: string[];
	部门?: string;
	/** 对应的实例信号行（有实例时才有） */
	实例行?: InstanceSignalRow;
}

export interface RecallSnapshotInput {
	paoHome: string;
	/** 项目根：临时计划与卡目录都挂在 `<项目根>/.pao` 下；不给就读项目清单里的全部项目 */
	项目根?: string;
	/** 只看某一份计划（不给＝项目内全部计划） */
	计划ID?: string;
}

export interface RecallSnapshot {
	paoHome: string;
	/** 本次扫描的项目根（去重保序） */
	项目根: string[];
	计划: RecallPlanSummary[];
	待办: RecallTodo[];
	未决意见: RecallOpenFeedback[];
	会话待办?: RecallSessionTodo;
	信号: RecallSignal[];
	/** 读不出的问题（逐条点名，不静默变成「没有待办」） */
	问题: string[];
}

/**
 * 待办身份键：与桌面 `todoKey` 六段＋可选意见ID 逐字同源（`\u0000` 连接）。
 * 缺轮次时该段为空串（同桌面口径），不是 "0"——这样「没有轮次」与「第 0 轮」不会撞键。
 */
export function recallTodoKey(kind: RecallTodoKind, identity: RecallTodoIdentity, feedbackId?: string): string {
	const parts = [
		kind,
		identity.实例 ?? "",
		identity.步骤 ?? "",
		identity.轮次 === undefined ? "" : String(identity.轮次),
		identity.定义版本 === undefined ? "" : String(identity.定义版本),
	];
	if (feedbackId !== undefined) parts.push(feedbackId);
	return parts.join(TODO_KEY_SEPARATOR);
}

/**
 * 多视图只生效一次：按身份键去重，保留首条（调用方按稳定顺序传给本函数）。
 * 同一条待办从两条视图路径（如 pending 的人工门 + 实例扫描的待裁定）过来时只留一条。
 */
export function dedupeTodos(todos: readonly RecallTodo[]): RecallTodo[] {
	const seen = new Set<string>();
	const out: RecallTodo[] = [];
	for (const todo of todos) {
		if (seen.has(todo.身份键)) continue;
		seen.add(todo.身份键);
		out.push(todo);
	}
	return out;
}

/**
 * 旧提醒是否过期（不得推进新轮次）：判据与桌面 `isTodoStale` 同口径。
 * - 实例不同 → true（不是同一个实例的提醒）；
 * - 定义版本两边都有且不等 → true（照旧版定义提的）；
 * - 轮次两边都有且不等 → true（照旧轮次提的）；
 * - 缺轮次不判过期（避免误杀；同桌面注释）。
 */
export function isRecallTodoStale(
	todo: Pick<RecallTodo, "绑定">,
	current: { 实例?: string; 轮次?: number; 定义版本?: number },
): boolean {
	const bound = todo.绑定;
	if (bound.实例 !== undefined && current.实例 !== undefined && bound.实例 !== current.实例) return true;
	if (bound.定义版本 !== undefined && current.定义版本 !== undefined && bound.定义版本 !== current.定义版本)
		return true;
	if (bound.轮次 !== undefined && current.轮次 !== undefined && bound.轮次 !== current.轮次) return true;
	return false;
}

/** 过期提醒的如实说明（同桌面 `staleTodoText` 口径）；不过期返回 undefined。 */
export function staleRecallTodoText(
	todo: Pick<RecallTodo, "绑定">,
	current: { 实例?: string; 轮次?: number; 定义版本?: number },
): string | undefined {
	if (!isRecallTodoStale(todo, current)) return undefined;
	const bound = todo.绑定;
	if (bound.定义版本 !== undefined && current.定义版本 !== undefined && bound.定义版本 !== current.定义版本) {
		return `这条待办是照着第 ${bound.定义版本} 版定义提的，现在是第 ${current.定义版本} 版，请刷新后再处理`;
	}
	if (bound.轮次 !== undefined && current.轮次 !== undefined && bound.轮次 !== current.轮次) {
		return `这条待办说的是第 ${bound.轮次} 轮，现在是第 ${current.轮次} 轮，请刷新后再处理`;
	}
	return "这条待办属于另一个实例，请刷新后再处理";
}

/**
 * 提醒文本（纯字符串拼接，不依赖任何通知通道）。
 * 通道失败时调用方仍然拿得到 `RecallSnapshot`——事实不在提醒里。
 * 每条待办带上绑定四要素，消费方据此判过期，旧轮次提醒自然推不动新轮次。
 */
export function buildRecallReminder(snapshot: RecallSnapshot, limit = 5): string {
	const rows = snapshot.待办.slice(0, limit).map((todo) => {
		const 绑定 = [
			todo.绑定.实例 ? `实例 ${todo.绑定.实例}` : undefined,
			todo.绑定.步骤 ? `步骤 ${todo.绑定.步骤}` : undefined,
			todo.绑定.轮次 === undefined ? undefined : `第 ${todo.绑定.轮次} 轮`,
			todo.绑定.定义版本 === undefined ? undefined : `定义版本 ${todo.绑定.定义版本}`,
		].filter((item): item is string => item !== undefined);
		return `- [${todo.种类}] ${todo.文案}${绑定.length > 0 ? `（${绑定.join("｜")}）` : ""}`;
	});
	const more = snapshot.待办.length > limit ? [`… 还有 ${snapshot.待办.length - limit} 条，用查询入口取详情。`] : [];
	return [
		`${TODO_REMINDER_MARKER} 待办 ${snapshot.待办.length} 条（未决意见 ${snapshot.未决意见.length} 条）：`,
		...(rows.length > 0 ? rows : ["- （没有待办）"]),
		...more,
		"这些是从盘上正本重建的事实，不是新指令；旧轮次提醒不会推进新轮次。",
	].join("\n");
}

/**
 * 只读快照：主控重开/压缩后调它查回事实。同步、零落盘、不派发。
 *
 * 与 `scanTodoState` 的关系：会话待办由调用方传入（本函数不持有 SessionManager），
 * 传进来的是同一条分支算出来的结果，所以压缩前后得到的是同一份事实。
 */
export function readRecallSnapshot(input: RecallSnapshotInput, 会话待办?: RecallSessionTodo): RecallSnapshot {
	const 问题: string[] = [];
	const 项目根 = resolveProjectRoots(input, 问题);
	const 计划: RecallPlanSummary[] = [];
	const 未决意见: RecallOpenFeedback[] = [];
	const 信号 = collectSignals(input.paoHome, 问题);
	const 待办: RecallTodo[] = [];

	for (const root of 项目根) {
		let definitions: TemporaryPlanDefinition[];
		try {
			definitions = listTemporaryPlans(root);
		} catch (error) {
			问题.push(`临时计划列不出（${root}）：${errorText(error)}`);
			continue;
		}
		for (const definition of definitions) {
			if (input.计划ID !== undefined && definition.计划ID !== input.计划ID) continue;
			const 启动 = readStarts(root, definition.计划ID);
			const feedback = readFeedback(root, definition.计划ID, 问题);
			const open = feedback.filter((entry) => entry.状态 !== "已应用");
			计划.push({
				计划ID: definition.计划ID,
				显示名: definition.显示名,
				定义版本: definition.定义版本,
				已撤销: definition.已撤销 === true,
				步骤数: definition.步骤.length,
				实例: 启动.map((record) => record.实例),
				未决意见数: open.length,
				定义文件: planFilePath(root, definition.计划ID),
			});
			未决意见.push(...open);
			待办.push(...feedbackTodos(open));
		}
	}

	待办.push(...signalTodos(信号));
	const snapshot: RecallSnapshot = {
		paoHome: input.paoHome,
		项目根,
		计划,
		待办: dedupeTodos(待办),
		未决意见,
		会话待办,
		信号,
		问题,
	};
	return snapshot;
}

/**
 * 计划详情（按需取）：正文/步骤/历史/意见原文都读在这一层，列表面保持简短。
 * `focusStep` 给了就只返回那一步的 `步骤`（其余仍在 `历史`/`问题` 里如实保留）。
 */
export function recallPlan(input: {
	paoHome: string;
	项目根: string;
	计划ID: string;
	focusStep?: string;
}): RecallPlanDetail {
	const 问题: string[] = [];
	const definition = readTemporaryPlan(input.项目根, input.计划ID);
	const 启动 = readStarts(input.项目根, input.计划ID);
	const feedback = readFeedback(input.项目根, input.计划ID, 问题);
	const open = feedback.filter((entry) => entry.状态 !== "已应用");
	const 历史 = listPlanHistory(input.项目根, input.计划ID);
	for (const entry of 历史) if (entry.问题) 问题.push(`历史版本 ${entry.定义版本} 读不出：${entry.问题}`);
	const 步骤 =
		input.focusStep === undefined
			? definition.步骤
			: definition.步骤.filter((step) => step.步骤ID === input.focusStep);
	if (input.focusStep !== undefined && 步骤.length === 0) 问题.push(`计划里没有步骤 ${input.focusStep}`);
	return {
		计划ID: definition.计划ID,
		显示名: definition.显示名,
		定义版本: definition.定义版本,
		已撤销: definition.已撤销 === true,
		步骤数: definition.步骤.length,
		实例: 启动.map((record) => record.实例),
		未决意见数: open.length,
		定义文件: planFilePath(input.项目根, input.计划ID),
		项目根: input.项目根,
		...(definition.来源会话 ? { 来源会话: definition.来源会话 } : {}),
		创建时刻: definition.创建时刻,
		更新时刻: definition.更新时刻,
		步骤,
		历史,
		启动,
		未决意见: open,
		已应用意见: feedback.filter((entry) => entry.状态 === "已应用"),
		必要文件: [
			planFilePath(input.项目根, input.计划ID),
			planFeedbackPath(input.项目根, input.计划ID),
			...启动.map((record) => planStartRecordPath(input.项目根, input.计划ID, record.启动请求ID)),
			...历史.map((entry) => entry.路径),
		],
		问题,
	};
}

/**
 * 查回「确认版本」事实：盘上当前定义版本 vs 某次启动锁定的版本。
 * 两边不一致＝旧确认已失效（同 `resolvePlanExecution` 的 PLAN_VERSION_CONFLICT 判据），如实返回。
 */
export function readConfirmedVersion(input: { 项目根: string; 计划ID: string; 启动请求ID: string }): {
	确认版本?: number;
	当前版本: number;
	一致: boolean;
	关联路径: string;
} {
	const definition = readTemporaryPlan(input.项目根, input.计划ID);
	const 关联路径 = planStartRecordPath(input.项目根, input.计划ID, input.启动请求ID);
	const record = readPlanStart(关联路径);
	const intent = record ? undefined : readPlanStartIntent(关联路径);
	const 确认版本 = record?.定义版本 ?? intent?.定义版本;
	return {
		...(确认版本 === undefined ? {} : { 确认版本 }),
		当前版本: definition.定义版本,
		一致: 确认版本 === undefined ? false : 确认版本 === definition.定义版本,
		关联路径,
	};
}

/**
 * 会话待办 → 待办（`scanTodoState` 的投影）。
 * 会话清单只有内容与状态、没有实例/步骤/轮次/版本，所以绑定字段**全部如实留空**（不算出 0）。
 */
export function sessionTodosToRecall(todos: readonly TodoItem[]): RecallTodo[] {
	return todos.map((todo) => ({
		种类: todo.status === "in_progress" ? "recovery" : "confirm",
		身份键: `session${TODO_KEY_SEPARATOR}${todo.content}`,
		文案: todo.content,
		原因: todo.status === "in_progress" ? "会话清单里标为进行中，重开后需要接着做" : "会话清单里还没做完",
		绑定: {},
		证据: [`todo_write 条目：${todo.content}`],
	}));
}

// ── 内部实现（全部只读） ──────────────────────────────────────────────────

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 项目根解析：显式传入优先；否则读项目清单（脏根逐条点名，不静默丢）。 */
function resolveProjectRoots(input: RecallSnapshotInput, 问题: string[]): string[] {
	if (input.项目根 !== undefined) return [input.项目根];
	let roots: string[];
	try {
		roots = listProjects(input.paoHome).map((row) => row.项目根);
	} catch (error) {
		问题.push(`项目清单读不出（${input.paoHome}）：${errorText(error)}`);
		return [];
	}
	if (roots.length === 0) 问题.push(`项目清单里没有服务过的项目（${input.paoHome}）：请传项目根`);
	return [...new Set(roots)];
}

function readStarts(项目根: string, 计划ID: string): PlanStartRecord[] {
	// 复用 queryTemporaryPlan 的启动面（同一个读法，不另写一遍扫描）
	try {
		return queryTemporaryPlan(项目根, 计划ID).启动;
	} catch (error) {
		// 定义坏时不阻断调用方拿问题清单
		return [];
	}
}

function readFeedback(项目根: string, 计划ID: string, 问题: string[]): RecallOpenFeedback[] {
	const 路径 = planFeedbackPath(项目根, 计划ID);
	let entries: PlanFeedbackEntry[];
	try {
		entries = listPlanFeedback(项目根, 计划ID);
	} catch (error) {
		问题.push(`意见读不出（${路径}）：${errorText(error)}`);
		return [];
	}
	return entries.map((entry) => ({
		意见ID: entry.意见ID,
		状态: entry.状态,
		目标: describeFeedbackTarget(entry),
		正文: entry.正文,
		定义版本: entry.定义版本,
		记录时刻: entry.记录时刻,
		更新时刻: entry.更新时刻,
		...(entry.投递?.结果 ? { 投递结果: entry.投递.结果 } : {}),
		路径,
		...(feedbackStepId(entry) === undefined ? {} : { 步骤ID: feedbackStepId(entry) }),
		...(feedbackRound(entry) === undefined ? {} : { 轮次: feedbackRound(entry) }),
	}));
}

/** 意见指向的步骤 ID：流程级意见没有步骤。 */
function feedbackStepId(entry: { 目标: PlanFeedbackTarget }): string | undefined {
	const target = entry.目标;
	return target.类型 === "流程" ? undefined : target.步骤ID;
}

/** 文件级意见的轮次；步骤/流程级没有轮次。 */
function feedbackRound(entry: { 目标: PlanFeedbackTarget }): number | undefined {
	return entry.目标.类型 === "文件" ? entry.目标.轮次 : undefined;
}

function describeFeedbackTarget(entry: PlanFeedbackEntry): string {
	const target = entry.目标;
	if (target.类型 === "流程") return "流程";
	if (target.类型 === "步骤") return `步骤 ${target.步骤ID}`;
	return `步骤 ${target.步骤ID} 第 ${target.轮次} 轮文件 ${target.路径}`;
}

/** 意见 → 待办：只有「待送达/已记录/投递失败」算待办；「已送达」等对方处理，也算未推进。 */
function feedbackTodos(feedback: readonly RecallOpenFeedback[]): RecallTodo[] {
	const todos: RecallTodo[] = [];
	for (const entry of feedback) {
		if (entry.状态 === "已应用") continue;
		const 绑定: RecallTodoIdentity = {
			定义版本: entry.定义版本,
			...(entry.步骤ID === undefined ? {} : { 步骤: entry.步骤ID }),
			...(entry.轮次 === undefined ? {} : { 轮次: entry.轮次 }),
		};
		const 种类: RecallTodoKind = entry.状态 === "投递失败" || entry.状态 === "待送达" ? "undelivered" : "confirm";
		todos.push({
			种类,
			身份键: recallTodoKey(种类, 绑定, entry.意见ID),
			文案: `意见「${entry.意见ID}」还没落地（${entry.状态}）：${firstLine(entry.正文)}`,
			原因: entry.投递结果 ?? `意见状态是「${entry.状态}」，正本：${entry.路径}`,
			绑定,
			证据: [entry.路径, `意见ID：${entry.意见ID}`],
			意见ID: entry.意见ID,
		});
	}
	return todos;
}

function firstLine(text: string): string {
	const line = text.split(/\r?\n/).find((item) => item.trim().length > 0);
	return line === undefined ? "" : line.trim();
}

/**
 * 现场信号：`collectPending` 已把「实例人工门/异常 + 卡侧坏卡/缺输入/失败」聚好了；
 * 这里只再取实例信号行做身份绑定（轮次只在实例信号里有，卡侧没有就是 undefined）。
 */
function collectSignals(paoHome: string, 问题: string[]): RecallSignal[] {
	let scan: ReturnType<typeof scanInstanceSignals>;
	try {
		scan = scanInstanceSignals(paoHome);
	} catch (error) {
		问题.push(`实例信号读不出（${paoHome}）：${errorText(error)}`);
		scan = { 实例: [], 异常: [] };
	}
	const rows = new Map<string, InstanceSignalRow>();
	for (const row of scan.实例) if (row.实例) rows.set(row.实例, row);
	const signals: RecallSignal[] = [];
	for (const row of scan.异常)
		signals.push({
			类型: "实例异常",
			主体: row.文件,
			为什么停: row.原因,
			要决定什么: "核对现场后决定修复或作废",
			证据: [row.路径],
		});
	for (const row of scan.实例) {
		if (row.人工门.length === 0 && !row.待恢复) continue;
		const 实例 = row.实例;
		const 证据 = [join(row.路径, "..")];
		if (row.人工门.length > 0) {
			for (const gate of row.人工门)
				signals.push({
					类型: "人工门待确认",
					主体: `${row.项目}/${row.工作流}${实例 ? `（实例 ${实例}）` : ""}`,
					为什么停: `节点「${gate.节点}」停在第 ${gate.轮次} 轮等人工确认`,
					要决定什么: "确认放行还是打回",
					证据: [...证据, `节点：${gate.节点}`, `轮次：${gate.轮次}`],
					实例行: row,
				});
		}
		if (row.待恢复)
			signals.push({
				类型: "实例恢复请求",
				主体: `${row.项目}/${row.工作流}${实例 ? `（实例 ${实例}）` : ""}`,
				为什么停: "实例标记待恢复",
				要决定什么: "核对现场后决定是否显式恢复",
				证据,
				实例行: row,
			});
	}
	return signals;
}

function signalTodos(signals: readonly RecallSignal[]): RecallTodo[] {
	const todos: RecallTodo[] = [];
	for (const signal of signals) {
		const row = signal.实例行;
		const 轮次 = row?.人工门[0]?.轮次 ?? row?.裁定?.轮次;
		const 步骤 = row?.人工门[0]?.节点 ?? row?.裁定?.节点;
		const 绑定: RecallTodoIdentity = {
			...(row?.实例 ? { 实例: row.实例 } : {}),
			...(步骤 === undefined ? {} : { 步骤 }),
			...(轮次 === undefined ? {} : { 轮次 }),
		};
		const 种类: RecallTodoKind =
			signal.类型 === "实例异常" || signal.类型 === "实例恢复请求"
				? "recovery"
				: signal.类型 === "失败待处置"
					? "failed"
					: signal.类型 === "缺输入补卡"
						? "missing_input"
						: "confirm";
		todos.push({
			种类,
			身份键: recallTodoKey(种类, 绑定),
			文案: `${signal.类型}：${signal.主体}`,
			原因: signal.为什么停,
			绑定,
			证据: signal.证据,
			...(signal.部门 === undefined ? {} : { 部门: signal.部门 }),
		});
	}
	return todos;
}

/**
 * 卡面投影：把卡目录扫成「失败待处置/缺输入补卡」待办。
 * 复用 `scanCards`（同一份卡解析），不另写扫描；卡侧没有实例/轮次，绑定如实留空。
 */
export function cardRecallTodos(项目根: string): RecallTodo[] {
	const cardsDir = join(项目根, ".pao", "卡");
	const { cards } = scanCards(cardsDir);
	const todos: RecallTodo[] = [];
	for (const card of cards) {
		if (card.frontmatter.status !== "failed") continue;
		const last: Receipt | undefined = card.receipts[card.receipts.length - 1];
		const failure = last?.failure_type;
		const 种类: RecallTodoKind = failure === "missing_input" ? "missing_input" : "failed";
		const 卡号 = card.card_no;
		const 绑定: RecallTodoIdentity = {};
		todos.push({
			种类,
			身份键: recallTodoKey(种类, 绑定, `卡号:${卡号}`),
			文案: `${formatCardNumber(卡号)} 失败待处置：${card.frontmatter.goal}`,
			原因: failure === undefined ? "卡状态 failed，回执未记失败类型" : `失败类型：${failure}`,
			绑定,
			证据: [card.path],
			部门: card.frontmatter.dept,
			卡号,
		});
	}
	return todos;
}

/**
 * 合并待办：现场信号与卡面投影都给，按身份键去重（同一张卡既在 pending 又在卡扫描里时只留一条）。
 * 顺序稳定：按 `RECALL_TODO_KINDS` 排序，同类内保持输入顺序。
 */
export function mergeRecallTodos(groups: readonly (readonly RecallTodo[])[]): RecallTodo[] {
	const merged: RecallTodo[] = [];
	for (const group of groups) merged.push(...group);
	const order = new Map<RecallTodoKind, number>(RECALL_TODO_KINDS.map((kind, index) => [kind, index]));
	return dedupeTodos([...merged].sort((a, b) => (order.get(a.种类) ?? 99) - (order.get(b.种类) ?? 99)));
}

/** 卡目录是否在项目内（`projectRootForCards` 是唯一反推实现，这里只用来做一致性自检）。 */
export function cardsDirOf(项目根: string): string {
	return join(项目根, ".pao", "卡");
}

/** 反推卡目录所属项目根（与 `projectRootForCards` 同源，供调用方核对传入的项目根是否一致）。 */
export function projectRootOfCards(cardsDir: string): string {
	return projectRootForCards(cardsDir);
}

/** 卡号引用解析（复用 cards/counter 的窄口，避免各处手写正则）。 */
export function cardNumberFromRef(ref: string): number {
	return parseCardRef(ref);
}

/** 文件是否可读（供详情面逐条核对必要文件是否真实存在，不静默当有）。 */
export function isReadableFile(path: string): boolean {
	if (!existsSync(path)) return false;
	try {
		realpathSync.native(path);
		readFileSync(path, { encoding: "utf8", flag: "r" });
		return true;
	} catch {
		return false;
	}
}

/** 陈 threshold 暴露给调用方（提醒节流由消费方决定；本模块不节流、不落盘） */
export const RECALL_STALE_REMINDER_THRESHOLD = STALE_REMINDER_THRESHOLD;
