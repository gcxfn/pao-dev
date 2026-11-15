/**
 * 临时计划的主控工具面（通用工作台 · 阶段 3 第 ③④项）。
 *
 * 分工：本文件只做「参数解析 + 身份解析（项目根/来源会话）+ 调共享内核」，
 * 校验、版本、落盘与启动关联全在 `plan.ts`；启动执行复用既有 v2 启流核心
 * （`startWorkflowCore`：预检 → owner → 冻结 → 控制正本 → 自动链），不另写一套调度。
 *
 * 三条硬规则写在这里，改行为不许绕开：
 * 1. 创建工具成功只表示**定义已落盘**，不说「已启动」；启动必须另有宿主确认事实。
 * 2. 确认事实只来自宿主确认回调（`requestConfirmation`）。模型传 `confirmed: true`、
 *    在普通回复里转述「用户已同意」都构造不出该对象，也读不到这里。
 * 3. 确认等待期间不持文件锁；等的过程中计划被改，复核时按定义版本直接拒（旧确认失效）。
 */

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { CARD_PRIORITIES, CARD_TIERS, type CardBudget } from "../cards/types.ts";
import { DEPT_DIR_NAME, REGISTRY_FILE_NAME, readRegistry } from "../dept/registry.ts";
import { paoHome as defaultPaoHome } from "../knowledge/paths.ts";
import { withFileLock } from "../shared/lock.ts";
import { defaultWorkerRunner } from "../worker/index.ts";
import type { WorkerRunner } from "../worker/runner.ts";
import type { AutoChainOptions } from "./auto.ts";
import {
	assertPlanConfirmation,
	createTemporaryPlan,
	listPlanHistory,
	modifyTemporaryPlan,
	type PlanConfirmation,
	planDir,
	type PlanExecution,
	queryTemporaryPlan,
	readPlanInstanceIdentity,
	readTemporaryPlan,
	recordPlanStart,
	recordStartIntent,
	resolvePlanExecution,
	revertTemporaryPlan,
	savePlanAsTemplate,
	TemporaryPlanError,
	type TemporaryPlanStep,
	throwIfPlanAborted,
	undoTemporaryPlan,
} from "./plan.ts";
import {
	listPlanFeedback,
	markPlanFeedbackApplied,
	type PlanFeedbackTarget,
	recordPlanFeedback,
	recordPlanFeedbackDelivery,
} from "./plan-feedback.ts";
import { startWorkflowCore, type WorkflowCommon } from "./tools.ts";

/** 系统提示 section 名：讨论转计划的纪律与已登记部门（每次 run 前按当前项目/PAO_HOME 重渲染）。 */
export const PLAN_WORKBENCH_SECTION_NAME = "pao_temporary_plan";

/** 宿主确认请求：只描述「要确认哪一版计划的哪一次启动」，不带任何可伪造的通过位。 */
export interface PlanConfirmationRequest {
	项目根: string;
	计划ID: string;
	显示名: string;
	定义版本: number;
	启动请求ID: string;
	步骤摘要: string;
}

export interface PlanToolsOptions {
	resolvePaoHome?: () => string;
	/**
	 * 项目根解析：临时计划定义落在 `<项目根>/.pao/临时工作流/`。
	 * 主控会话的 cwd 就是项目根时可直接用缺省；宿主另有布局时注入。
	 */
	resolveProjectRoot?: () => string | undefined;
	resolveOwnerSessionId?: () => string | undefined;
	driveDepartments?: AutoChainOptions["driveDepartments"];
	runner?: WorkerRunner;
	沙箱根?: string;
	/**
	 * 宿主确认回调：桌面/CLI 宿主把用户的真实确认交回来（无桌面集成时用明确模拟的宿主回调，
	 * 并如实标注，不得当作真实用户确认）。不注入时启动工具一律拒——缺确认就不许启。
	 */
	requestConfirmation?: (
		request: PlanConfirmationRequest,
	) => PlanConfirmation | undefined | Promise<PlanConfirmation | undefined>;
}

/** 回边参数：目标用 1 起序号或步骤 ID；上限与超限动作按配方定义。 */
interface BackEdgeParam {
	target: number | string;
	max_rounds: number;
	over_limit_action?: "停滞" | "修完这轮放行";
}
/** 工具面步骤参数（英文键，与卡/配方工具一致）：依赖用 1 起的步骤序号。 */
interface StepParam {
	/** 已有步骤的稳定 ID（改/重排时带上它，标题与顺序随便改，ID 不动）；新增步骤不要传 */
	step_id?: string;
	title: string;
	dept: string;
	requirement: string;
	expected_artifacts?: string;
	inputs?: string[];
	depends_on?: (number | string)[];
	human_gate?: boolean;
	read_only?: boolean;
	audit?: boolean;
	dept_standard?: string;
	constraints?: string;
	tier?: string;
	priority?: string;
	budget_turns?: number;
	budget_tool_calls?: number;
	budget_cost?: number;
	skills?: string[];
	back_edges?: BackEdgeParam[];
}

function domainError(error: unknown): never {
	if (error instanceof Error && "code" in error) {
		const coded = error as Error & { code?: unknown };
		throw new Error(`[${String(coded.code)}] ${coded.message}`);
	}
	throw error;
}

async function toolText(
	fn: () => Promise<string> | string,
): Promise<{ content: { type: "text"; text: string }[]; details: undefined }> {
	try {
		return { content: [{ type: "text", text: await fn() }], details: undefined };
	} catch (error) {
		domainError(error);
	}
}

function stepIdForIndex(index: number): string {
	return `s${index + 1}`;
}

/** 1 起序号 → 步骤 ID；已按字符串给出的 ID 原样保留（修改场景要能引用既有步骤）。 */
function toStepId(value: number | string, total: number): string {
	if (typeof value === "number") {
		if (!Number.isInteger(value) || value < 1 || value > total) {
			throw new Error(`依赖序号超出范围：${value}（本计划共 ${total} 步，序号从 1 起）`);
		}
		return stepIdForIndex(value - 1);
	}
	const trimmed = value.trim();
	if (trimmed === "") throw new Error("依赖步骤 ID 不能为空");
	return trimmed;
}

/**
 * 步骤参数 → 计划步骤定义（创建与修改共用一份）。
 * 依赖序号按本次提交的列表下标换算（第 1 步＝s1）；改标题不动步骤 ID，
 * 所以「未执行改标题」不会让已投递的意见/文件关联丢对象。
 */
function buildStep(step: StepParam, total: number, 步骤ID: string): TemporaryPlanStep {
	const 依赖 = (step.depends_on ?? []).map((value) => toStepId(value, total));
	const 回边 = (step.back_edges ?? []).map((edge) => ({
		目标: toStepId(edge.target, total),
		上限: edge.max_rounds,
		超限动作: edge.over_limit_action ?? ("停滞" as const),
	}));
	const 预算: CardBudget | undefined =
		step.budget_turns !== undefined || step.budget_tool_calls !== undefined || step.budget_cost !== undefined
			? {
					...(step.budget_turns !== undefined ? { turns: step.budget_turns } : {}),
					...(step.budget_tool_calls !== undefined ? { toolCalls: step.budget_tool_calls } : {}),
					...(step.budget_cost !== undefined ? { cost: step.budget_cost } : {}),
				}
			: undefined;
	return {
		步骤ID,
		标题: step.title,
		部门: step.dept,
		要求: step.requirement,
		...(step.expected_artifacts ? { 预期成果: step.expected_artifacts } : {}),
		...(step.inputs && step.inputs.length > 0 ? { 输入: step.inputs } : {}),
		...(依赖.length > 0 ? { 依赖 } : {}),
		...(step.human_gate ? { 人工门: true } : {}),
		...(step.read_only ? { 只读: true } : {}),
		...(step.audit ? { 审核: true } : {}),
		...(step.dept_standard ? { 部门标准: step.dept_standard } : {}),
		...(step.constraints ? { 约束: step.constraints } : {}),
		...(step.tier ? { 档位: step.tier as TemporaryPlanStep["档位"] } : {}),
		...(step.priority ? { 优先级: step.priority as TemporaryPlanStep["优先级"] } : {}),
		...(预算 ? { 预算 } : {}),
		...(step.skills && step.skills.length > 0 ? { 技能: step.skills } : {}),
		...(回边.length > 0 ? { 回边 } : {}),
	};
}

function toSteps(params: readonly StepParam[]): TemporaryPlanStep[] {
	return params.map((step, index) => buildStep(step, params.length, stepIdForIndex(index)));
}

function describeSteps(steps: readonly TemporaryPlanStep[]): string {
	return steps.map((step) => `${step.步骤ID} ${step.标题}（${step.部门}）`).join("；");
}

/** 详情里点名某一步：给的是步骤 ID 就精确找，给的是序号（1 起）就按位置找。 */
function selectStep(steps: readonly TemporaryPlanStep[], 指定: string | undefined): TemporaryPlanStep {
	const needle = 指定?.trim();
	if (!needle) {
		throw new Error("[PLAN_INVALID] 读某一步详情要给 around_step（步骤 ID 如 s2，或 1 起序号）");
	}
	const byId = steps.find((step) => step.步骤ID === needle);
	if (byId) return byId;
	const index = Number(needle);
	if (Number.isInteger(index) && index >= 1 && index <= steps.length) return steps[index - 1]!;
	throw new Error(
		`[PLAN_INVALID] 这份计划里没有步骤 ${needle}（现有步骤：${steps.map((step) => step.步骤ID).join("、")}）`,
	);
}

/** 预算/档位一类结构化字段的读法：没给就是「未设」，不编默认值。 */
function renderStepFull(step: TemporaryPlanStep, 全部: readonly TemporaryPlanStep[]): string {
	const 行 = [`- ${step.步骤ID} ${step.标题}（${step.部门}）`];
	行.push(`  要求：${step.要求}`);
	if (step.输入 && step.输入.length > 0) 行.push(`  输入：${step.输入.join("；")}`);
	if (step.预期成果) 行.push(`  预期成果（验收）：${step.预期成果}`);
	if (step.依赖 && step.依赖.length > 0) {
		const 名字 = step.依赖.map((id) => 全部.find((item) => item.步骤ID === id)?.标题 ?? id);
		行.push(`  依赖：${step.依赖.map((id, index) => `${id} ${名字[index]}`).join("；")}`);
	}
	if (step.人工门) 行.push("  人工门：是（交付后停流等用户点头）");
	if (step.只读) 行.push("  只读：是");
	if (step.审核) 行.push(`  审核：是｜部门标准：${step.部门标准 ?? "（缺！审核步骤必须有部门标准）"}`);
	else if (step.部门标准) 行.push(`  部门标准：${step.部门标准}`);
	if (step.约束) 行.push(`  约束：${step.约束}`);
	if (step.档位) 行.push(`  档位：${step.档位}`);
	if (step.优先级) 行.push(`  优先级：${step.优先级}`);
	if (step.预算) {
		const 项 = [
			step.预算.turns !== undefined ? `轮次 ${step.预算.turns}` : "",
			step.预算.toolCalls !== undefined ? `工具调用 ${step.预算.toolCalls}` : "",
			step.预算.cost !== undefined ? `费用 ${step.预算.cost}` : "",
		].filter(Boolean);
		行.push(`  预算：${项.join("｜")}`);
	}
	if (step.技能 && step.技能.length > 0) 行.push(`  技能：${step.技能.join("、")}`);
	if (step.回边 && step.回边.length > 0) {
		行.push(`  回边：${step.回边.map((edge) => `${edge.目标}（上限 ${edge.上限}，超限${edge.超限动作}）`).join("；")}`);
	}
	return 行.join("\n");
}

/** 按对象读取：一次只给一项，长正文不会一次灌满上下文。 */
function renderStepDetail(step: TemporaryPlanStep, 项: string): string {
	const 头 = `步骤 ${step.步骤ID} ${step.标题} 的「${项}」：`;
	switch (项) {
		case "要求":
			return `${头}${step.要求}`;
		case "输入":
			return `${头}${step.输入 && step.输入.length > 0 ? step.输入.join("；") : "（未登记输入）"}`;
		case "预期成果":
			return `${头}${step.预期成果 ?? "（未登记预期成果；验收暂用要求）"}`;
		case "依赖":
			return `${头}${step.依赖 && step.依赖.length > 0 ? step.依赖.join("、") : "（没有依赖）"}`;
		case "审核":
			return `${头}${step.审核 ? `是；部门标准：${step.部门标准 ?? "（缺！审核步骤必须有部门标准）"}` : "不是审核步骤"}`;
		case "预算": {
			if (!step.预算) return `${头}（未设预算）`;
			return `${头}轮次 ${step.预算.turns ?? "—"}｜工具调用 ${step.预算.toolCalls ?? "—"}｜费用 ${step.预算.cost ?? "—"}`;
		}
		case "技能":
			return `${头}${step.技能 && step.技能.length > 0 ? step.技能.join("、") : "（未登记技能）"}`;
		case "人工门":
			return `${头}${step.人工门 ? "是（交付后停流等用户点头）" : "不是人工门"}`;
		case "身份":
			return `${头}步骤ID ${step.步骤ID}｜部门 ${step.部门}｜标题 ${step.标题}`;
		default:
			throw new Error(`[PLAN_INVALID] 读不出这一项：${项}`);
	}
}

/**
 * 项目归属：宿主注入的项目根是权威。工具参数**只能确认**它，不能改写它——
 * 传一个别的项目路径会被拒，也不会在那个项目里落任何文件。
 * 宿主没注入时（CLI 单跑、无项目会话）才允许参数当唯一来源。
 */
function resolveProjectRoot(param: string | undefined, options: PlanToolsOptions | undefined): string {
	const host = options?.resolveProjectRoot?.()?.trim();
	const explicit = param?.trim();
	if (explicit && host && resolve(explicit) !== resolve(host)) {
		throw new Error(
			`[PLAN_FORBIDDEN] project_root 与当前会话所属项目不一致：参数是 ${explicit}，宿主注入的是 ${host}。临时计划只能落在当前项目里；要改别的项目请在那个项目里开会话（本批不做跨主控接管）。`,
		);
	}
	const resolved = explicit || host;
	if (!resolved) {
		throw new Error(
			"未提供项目根：请传 project_root 参数，或由宿主注入 resolveProjectRoot（临时计划定义落在 <项目根>/.pao/临时工作流/）。",
		);
	}
	return resolved;
}

/** 已注册部门来自 PAO_HOME 注册表（唯一真相），不在工具参数里另收一份。 */
function readDepartments(options: PlanToolsOptions | undefined): string[] {
	const paoHome = options?.resolvePaoHome?.() ?? defaultPaoHome();
	return readRegistry(join(paoHome, DEPT_DIR_NAME, REGISTRY_FILE_NAME)).map((row) => row.名字);
}

/**
 * 等确认期间把取消信号接进来：用户一取消就**立刻**拒绝，不等宿主姗姗来迟的确认回执。
 * 取消之后到达的「同意」不会产生任何受理动作——这里已经不听了（副作用全在竞速之后的代码里）。
 */
function raceConfirmation<T>(pending: Promise<T> | T, signal: AbortSignal | undefined, 动作: string): Promise<T> {
	if (!signal) return Promise.resolve(pending);
	if (signal.aborted) throwIfPlanAborted(signal, 动作);
	const waiting = Promise.resolve(pending);
	return new Promise<T>((resolvePromise, rejectPromise) => {
		const 取消 = () => {
			signal.removeEventListener("abort", 取消);
			try {
				throwIfPlanAborted(signal, 动作);
			} catch (error) {
				rejectPromise(error);
			}
		};
		signal.addEventListener("abort", 取消, { once: true });
		waiting.then(
			(value) => {
				signal.removeEventListener("abort", 取消);
				resolvePromise(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", 取消);
				rejectPromise(error);
			},
		);
	});
}

/**
 * 修改时的步骤 ID 分配：**步骤 ID 与显示顺序分离**。
 * - 带 `step_id` 的步骤：必须能在原计划里找到同 ID（否则拒，防手滑写错 ID 悄悄新建一步）；
 *   顺序照提交顺序走——重排只改顺序，ID 不动，所以意见与文件关联不会断。
 * - 不带 `step_id` 的步骤：整份等长替换时按位置沿用原 ID（旧调用方式仍可用）；
 *   步骤数变了就按顺序发新 ID（新增步骤拿新 ID，被删掉的旧 ID 不再被顶替）。
 * - 依赖/回边里的字符串 ID 原样保留，其有效性由 `normalizeSteps` 统一校验。
 */
function mergeStepsForModify(已有: readonly TemporaryPlanStep[], submitted: readonly StepParam[]): TemporaryPlanStep[] {
	const 已有ID = new Set(已有.map((step) => step.步骤ID));
	const 已占用 = new Set<string>();
	const 按位置沿用 = submitted.length === 已有.length;
	const 结果: TemporaryPlanStep[] = [];
	for (const [index, step] of submitted.entries()) {
		const 声明ID = step.step_id?.trim();
		let 步骤ID: string;
		if (声明ID) {
			if (!已有ID.has(声明ID)) {
				throw new Error(
					`[PLAN_INVALID] 步骤 ID ${声明ID} 不在原计划里，不能凭空指定；新增步骤不要传 step_id，内核会发新 ID。`,
				);
			}
			if (已占用.has(声明ID)) throw new Error(`[PLAN_INVALID] 步骤 ID 重复：${声明ID}`);
			步骤ID = 声明ID;
		} else if (按位置沿用) {
			步骤ID = 已有[index]!.步骤ID;
		} else {
			// 形状变了：用一份「既有＋已发」的合成列表续号，避免新 ID 撞上还没提交的旧 ID
			步骤ID = nextFreeStepId([...已有, ...结果]);
		}
		if (已占用.has(步骤ID)) throw new Error(`[PLAN_INVALID] 步骤 ID 重复：${步骤ID}`);
		已占用.add(步骤ID);
		结果.push(buildStep(step, submitted.length, 步骤ID));
	}
	return 结果;
}

/** 发下一个没被占用的 `sN`（形状变化时新增步骤用）。 */
function nextFreeStepId(existing: readonly TemporaryPlanStep[]): string {
	const 已用 = new Set(existing.map((step) => step.步骤ID));
	let max = 0;
	for (const id of 已用) {
		const match = /^s(\d+)$/.exec(id);
		if (match) max = Math.max(max, Number(match[1]));
	}
	let candidate = `s${max + 1}`;
	while (已用.has(candidate)) {
		max += 1;
		candidate = `s${max + 1}`;
	}
	return candidate;
}

/**
 * 删除步骤前先看有没有绑在它上面的意见：意见绑定的是稳定步骤 ID，
 * 把有意见的步骤删掉会让意见变孤儿——所以拒绝并要求先处理意见（或换一份计划）。
 */
function assertNoFeedbackOnRemovedSteps(
	项目根: string,
	计划ID: string,
	已有: readonly TemporaryPlanStep[],
	保留ID: ReadonlySet<string>,
): void {
	const 被删 = 已有.filter((step) => !保留ID.has(step.步骤ID));
	if (被删.length === 0) return;
	let entries: { 意见ID: string; 目标: PlanFeedbackTarget }[];
	try {
		entries = listPlanFeedback(项目根, 计划ID);
	} catch {
		return; // 意见文件读不出属另一条线的问题，不在这里顺手改判
	}
	// 流程级意见（类型 "流程"）没有步骤 ID，不参与「删步骤会不会让意见成孤儿」的判定。
	const 孤儿 = entries.filter((entry) => {
		const 目标 = entry.目标;
		if (目标.类型 === "流程") return false;
		return 被删.some((step) => step.步骤ID === 目标.步骤ID);
	});
	if (孤儿.length === 0) return;
	throw new Error(
		`[PLAN_INVALID] 要删的步骤上还挂着意见（${孤儿
			.map((entry) => `${entry.意见ID}→${entry.目标.类型 === "流程" ? "流程目标" : entry.目标.步骤ID}`)
			.join("、")}）：步骤 ID 一删意见就成孤儿。请先把这些意见处理掉，或另建一份新计划。`,
	);
}

/**
 * 讨论转计划的纪律段（阶段 4 第 2 项）：把规则、已登记部门与当前项目已有的临时计划
 * 摆到主控眼前，缺关键信息时**定向提问**，而不是去扫描自然语言自动执行
 * （普通回复里的编号清单、Todo、原型关键字都不触发真实创建）。
 *
 * 部门唯一真相＝PAO_HOME 部门注册表；这里只读快照。项目根或注册表读不到时，
 * 该部分降级成一句说明，不阻断会话。
 */
function renderPlanWorkbenchSection(项目根: string, options: PlanToolsOptions | undefined): string {
	const lines = [
		"临时工作台纪律（讨论 → 计划 → 用户确认启动）：",
		"1. 讨论出步骤后，由你显式调 pao_plan_create 落计划；普通回复里的编号清单/Todo/原型关键字都不会触发真实创建。",
		"2. 创建成功只表示定义已落盘，不等于已启动；启动要用户确认（pao_plan_start 只认宿主交回的用户确认事实，你自己写 confirmed 不算）。",
		"3. 部门只能从下面这份已登记部门里选；缺关键信息（要解决什么问题、几步、每步哪个部门、哪步设人工门）时定向问用户，一次只问当轮挡路的，别替他决定。",
		"4. 改/撤销用 pao_plan_update（带 definition_version，防覆盖别人的改动）；已启动的计划定义冻结，只能另建新计划。",
		"5. 用户对某一步或某个文件说的话用 pao_plan_feedback 记下来，绑定当时那一版；「已送达」只能由真实投递回执写入。",
	];
	try {
		const departments = readDepartments(options);
		lines.push(
			departments.length > 0
				? `已登记部门：${departments.join("、")}`
				: "已登记部门：（注册表为空，先和用户确认建哪些部门，别自己造部门名）",
		);
	} catch {
		lines.push("已登记部门：（读不到部门注册表，先按 pao_create_dept 或已有配置确认部门，别自己造部门名）");
	}
	try {
		lines.push(queryTemporaryPlan(项目根).摘要);
	} catch {
		lines.push("本项目临时计划：（读不出，用 pao_plan_query 查具体原因）");
	}
	return lines.join("\n");
}

/**
 * 注册临时计划主控工具：创建 / 修改或撤销 / 查询 / 确认并启动 / 保存模板 / 步骤文件意见。
 * 与 `registerWorkflowTools` 同一注册面（工作流工具注册时一并装上）。
 */
export function registerPlanTools(pi: ExtensionAPI, options: PlanToolsOptions, common: WorkflowCommon): void {
	pi.on("before_agent_start", (event) => {
		try {
			event.systemPromptOptions.sections[PLAN_WORKBENCH_SECTION_NAME] = renderPlanWorkbenchSection(
				resolveProjectRoot(undefined, options),
				options,
			);
		} catch {
			// 解析不到项目根（例如不在项目会话里）：跳过这段，不阻断会话。
		}
		return undefined;
	});
	const baseParams = {
		project_root: Type.Optional(
			Type.String({
				description: "项目根绝对路径（临时计划定义落点 <项目根>/.pao/临时工作流/）；留空用宿主注入的项目根",
			}),
		),
	};

	pi.registerTool({
		name: "pao_plan_create",
		label: "建临时工作流计划",
		description:
			"主控创建临时工作流计划（只落定义，不启动、不落卡）：步骤＝要做什么/哪个部门/什么要求，依赖用步骤序号（第 1 步＝1）。落 <项目根>/.pao/临时工作流/<计划ID>/计划.md，返回计划 ID 与定义版本。同一 request_id 重试是回放，不会落第二份；同 request_id 换参数会被拒。创建成功只代表定义已落盘——要开工还须用户确认后用 pao_plan_start 启动。",
		parameters: Type.Object({
			...baseParams,
			request_id: Type.String({ description: "本次创建逻辑请求 ID（同一操作重试沿用原 ID）" }),
			display_name: Type.String({ description: "显示名（可重名、可含空格；不用于拼磁盘路径）" }),
			steps: Type.Array(
				Type.Object({
					title: Type.String({ description: "步骤标题（人看的显示名；改标题不影响步骤 ID）" }),
					dept: Type.String({ description: "执行部门（必须已在 PAO_HOME 注册表里）" }),
					requirement: Type.String({ description: "要求：这一步要做什么、交付到什么程度" }),
					expected_artifacts: Type.Optional(
						Type.String({ description: "预期成果（验收要求）：期望产出的文件或结果；缺省用要求" }),
					),
					inputs: Type.Optional(
						Type.Array(Type.String(), { description: "上游成果或资料（进卡面「输入」：这一步拿什么干）" }),
					),
					depends_on: Type.Optional(
						Type.Array(Type.Integer({ minimum: 1 }), { description: "依赖的步骤序号（第 1 步＝1）" }),
					),
					human_gate: Type.Optional(Type.Boolean({ description: "人工门：交付后停流等用户点头" })),
					read_only: Type.Optional(Type.Boolean({ description: "只读步骤（不产出文件的审阅节点）" })),
					audit: Type.Optional(Type.Boolean({ description: "审核步骤（须同时给 dept_standard）" })),
					dept_standard: Type.Optional(Type.String({ description: "部门标准路径（审核步骤必填）" })),
					constraints: Type.Optional(Type.String({ description: "约束（不许做什么）" })),
					tier: Type.Optional(
						Type.Union(
							CARD_TIERS.map((value) => Type.Literal(value)),
							{ description: "档位" },
						),
					),
					priority: Type.Optional(
						Type.Union(
							CARD_PRIORITIES.map((value) => Type.Literal(value)),
							{ description: "优先级" },
						),
					),
					budget_turns: Type.Optional(Type.Integer({ minimum: 1, description: "这一步的轮次预算" })),
					budget_tool_calls: Type.Optional(Type.Integer({ minimum: 0, description: "这一步的工具调用次数预算" })),
					budget_cost: Type.Optional(Type.Number({ description: "这一步的费用预算" })),
					skills: Type.Optional(Type.Array(Type.String(), { description: "需要的技能名" })),
					back_edges: Type.Optional(
						Type.Array(
							Type.Object({
								target: Type.Union([Type.Integer({ minimum: 1 }), Type.String()], {
									description: "回边目标（1 起序号或步骤 ID）",
								}),
								max_rounds: Type.Integer({ minimum: 1, description: "回边次数上限" }),
								over_limit_action: Type.Optional(
									Type.Union([Type.Literal("停滞"), Type.Literal("修完这轮放行")], {
										description: "超限动作；缺省停滞",
									}),
								),
							}),
							{ description: "审核回边（仅审核步骤可声明）" },
						),
					),
				}),
				{ description: "步骤表（按顺序；第 1 步序号为 1）" },
			),
		}),
		execute: async (
			_toolCallId: string,
			params: { project_root?: string; request_id: string; display_name: string; steps: StepParam[] },
		) =>
			toolText(() => {
				const 项目根 = resolveProjectRoot(params.project_root, options);
				const 已注册部门 = readDepartments(options);
				return createTemporaryPlan({
					项目根,
					显示名: params.display_name,
					来源会话: options?.resolveOwnerSessionId?.(),
					步骤: toSteps(params.steps),
					请求ID: params.request_id,
					已注册部门,
				}).then((result) => {
					const definition = readTemporaryPlan(项目根, result.计划ID);
					return [
						result.摘要,
						`计划ID：${result.计划ID}｜定义版本：${result.定义版本}｜步骤：${describeSteps(definition.步骤)}`,
						`${result.回放 ? "（这次是同一 request_id 的回放，没有新建定义）" : "定义已落盘。"}要开工先给用户看这一步的计划，得到确认后再调 pao_plan_start（须带同一定义版本与一个启动请求 ID）。`,
					].join("\n");
				});
			}),
	});

	pi.registerTool({
		name: "pao_plan_update",
		label: "改或撤临时计划",
		description:
			"修改、撤销最近一次修改，或撤回整份临时计划（都是带版本检查的写操作）：action=modify 传新的 steps（整份替换）。步骤有稳定 ID（s1/s2…）与显示顺序两件事：改标题/要求时带上原来那一步的 step_id，ID 就不动，已投递的意见与文件关联不会断；重排只是改提交顺序，step_id 照旧；新增步骤不要传 step_id（内核发新 ID）；删掉的步骤若还挂着意见会被拒。不传 step_id 时，只有「步骤数不变」才按位置沿用原 ID。action=revert 是「撤销最近一次修改」：把内容回到上一版、整份计划仍有效可执行，回到的那版会成为**新的定义版本**（版本号继续往前走，不改历史）；可用 target_version 指定回到哪一版，缺省＝最近一版。action=undo 是「撤回整份计划」：把计划标为已撤销、不再启动，与 revert 是两件事，不混同。三者都须带 expected_version（当前定义版本）与 request_id；盘上版本与之不一致即拒（说明有人在中间改过，请重读）。已启动（含已受理未落实例）的定义被冻结，不能改、不能撤、不能恢复。",
		parameters: Type.Object({
			...baseParams,
			plan_id: Type.String(),
			request_id: Type.String({ description: "本次修改逻辑请求 ID（同一操作重试沿用原 ID）" }),
			expected_version: Type.Integer({ minimum: 1, description: "请求基于的定义版本；与盘上不一致就拒" }),
			action: Type.Union([Type.Literal("modify"), Type.Literal("revert"), Type.Literal("undo")]),
			target_version: Type.Optional(
				Type.Integer({
					minimum: 1,
					description: "action=revert 用：要回到的历史版本号；不传＝最近一个历史版本",
				}),
			),
			display_name: Type.Optional(Type.String({ description: "新显示名（不改就不传）" })),
			steps: Type.Optional(
				Type.Array(
					Type.Object({
						step_id: Type.Optional(
							Type.String({
								description:
									"已有步骤的稳定 ID（如 s1）；改这一步或重排时带上它，标题可随意改。新增步骤留空",
							}),
						),
						title: Type.String(),
						dept: Type.String(),
						requirement: Type.String(),
						expected_artifacts: Type.Optional(Type.String()),
						inputs: Type.Optional(Type.Array(Type.String())),
						depends_on: Type.Optional(Type.Array(Type.Union([Type.Integer({ minimum: 1 }), Type.String()]))),
						human_gate: Type.Optional(Type.Boolean()),
						read_only: Type.Optional(Type.Boolean()),
						audit: Type.Optional(Type.Boolean()),
						dept_standard: Type.Optional(Type.String()),
						constraints: Type.Optional(Type.String()),
						tier: Type.Optional(Type.Union(CARD_TIERS.map((value) => Type.Literal(value)))),
						priority: Type.Optional(Type.Union(CARD_PRIORITIES.map((value) => Type.Literal(value)))),
						budget_turns: Type.Optional(Type.Integer({ minimum: 1 })),
						budget_tool_calls: Type.Optional(Type.Integer({ minimum: 0 })),
						budget_cost: Type.Optional(Type.Number()),
						skills: Type.Optional(Type.Array(Type.String())),
						back_edges: Type.Optional(
							Type.Array(
								Type.Object({
									target: Type.Union([Type.Integer({ minimum: 1 }), Type.String()]),
									max_rounds: Type.Integer({ minimum: 1 }),
									over_limit_action: Type.Optional(
										Type.Union([Type.Literal("停滞"), Type.Literal("修完这轮放行")]),
									),
								}),
							),
						),
					}),
					{ description: "action=modify 时的新步骤表（整份替换；省略则只改显示名）" },
				),
			),
		}),
		execute: async (
			_toolCallId: string,
			params: {
				project_root?: string;
				plan_id: string;
				request_id: string;
				expected_version: number;
				action: "modify" | "revert" | "undo";
				target_version?: number;
				display_name?: string;
				steps?: StepParam[];
			},
			signal?: AbortSignal,
		) =>
			toolText(async () => {
				const 项目根 = resolveProjectRoot(params.project_root, options);
				const 来源会话 = options?.resolveOwnerSessionId?.();
				if (params.action === "undo") {
					if (params.steps || params.display_name || params.target_version !== undefined) {
						throw new Error("撤回整份计划不接受 steps/display_name/target_version：它只改状态");
					}
					const undone = await undoTemporaryPlan({
						项目根,
						计划ID: params.plan_id,
						请求ID: params.request_id,
						预期定义版本: params.expected_version,
						来源会话,
						信号: signal,
					});
					return `${undone.摘要}\n定义文件保留（未删用户内容）；要重新开工请另建计划。`;
				}
				if (params.action === "revert") {
					if (params.steps || params.display_name) {
						throw new Error("撤销最近一次修改不接受 steps/display_name：它是把内容回到旧版，不是又一次编辑");
					}
					const reverted = await revertTemporaryPlan({
						项目根,
						计划ID: params.plan_id,
						请求ID: params.request_id,
						预期定义版本: params.expected_version,
						目标定义版本: params.target_version,
						来源会话,
						信号: signal,
					});
					const after = readTemporaryPlan(项目根, params.plan_id);
					return [
						reverted.摘要,
						`计划ID：${reverted.计划ID}｜定义版本：${reverted.定义版本}｜恢复自：定义版本 ${reverted.恢复自}｜步骤：${describeSteps(after.步骤)}`,
						"内容回到旧版是新的一版：旧确认在定义版本变化后失效，启动请带新的 definition_version。",
					].join("\n");
				}
				const 已有 = readTemporaryPlan(项目根, params.plan_id);
				const 步骤 = params.steps ? mergeStepsForModify(已有.步骤, params.steps) : undefined;
				if (步骤) {
					assertNoFeedbackOnRemovedSteps(
						项目根,
						params.plan_id,
						已有.步骤,
						new Set(步骤.map((step) => step.步骤ID)),
					);
				}
				const modified = await modifyTemporaryPlan({
					项目根,
					计划ID: params.plan_id,
					请求ID: params.request_id,
					预期定义版本: params.expected_version,
					显示名: params.display_name,
					步骤,
					已注册部门: readDepartments(options),
					来源会话,
					信号: signal,
				});
				const definition = readTemporaryPlan(项目根, params.plan_id);
				return [
					modified.摘要,
					`计划ID：${modified.计划ID}｜定义版本：${modified.定义版本}｜步骤：${describeSteps(definition.步骤)}`,
					"改了哪一版要重新确认：旧确认在定义版本变化后失效，启动请带新的 definition_version。",
				].join("\n");
			}),
	});

	pi.registerTool({
		name: "pao_plan_query",
		label: "查临时计划",
		description:
			"查临时计划（只读、不要求先加入模板库）：列全部或指定 plan_id 的一份。plan_id 留空＝简短列表（显示名、定义版本、步数、是否已启动）；给了 plan_id＝完整详情（逐步给出要求/输入/预期成果/依赖/人工门/审核/部门标准/约束/档位/预算/优先级/技能/回边，以及来源主控、创建与更新时刻、运行关联、历史版本与读不出的定义或坏关联，逐条点名不当没有）。详情里长正文按 around_step 只取某一步，用 step_detail 一项一项读。空对话里要找回「当初要求、约束、验收、预算、技能、身份」就用这个详情面。",
		parameters: Type.Object({
			...baseParams,
			plan_id: Type.Optional(Type.String({ description: "留空列该项目全部临时计划；给了它返回这份计划的完整详情" })),
			around_step: Type.Optional(
				Type.String({ description: "只要某一步的详情（步骤 ID 如 s2）；不传＝列全部步骤" }),
			),
			step_detail: Type.Optional(
				Type.Union(
					[
						Type.Literal("要求"),
						Type.Literal("输入"),
						Type.Literal("预期成果"),
						Type.Literal("依赖"),
						Type.Literal("审核"),
						Type.Literal("预算"),
						Type.Literal("技能"),
						Type.Literal("人工门"),
						Type.Literal("身份"),
					],
					{ description: "只读某一项（长内容按对象读取，避免一次灌满上下文）" },
				),
			),
		}),
		execute: async (
			_toolCallId: string,
			params: { project_root?: string; plan_id?: string; around_step?: string; step_detail?: string },
		) =>
			toolText(() => {
				const 项目根 = resolveProjectRoot(params.project_root, options);
				const view = queryTemporaryPlan(项目根, params.plan_id);
				const lines = [view.摘要];
				if (view.定义) {
					const 定义 = view.定义;
					lines.push(
						`身份：计划ID ${定义.计划ID}｜定义版本 ${定义.定义版本}｜来源主控 ${定义.来源会话 ?? "（未登记：CLI 一次性会话或早期版本的计划）"}`,
					);
					lines.push(`时刻：创建 ${定义.创建时刻 || "（未记）"}｜更新 ${定义.更新时刻 || "（未记）"}`);
					lines.push(
						`运行关联：${
							view.启动.length > 0
								? view.启动
										.map((start) => `实例 ${start.实例}｜配方 ${start.配方名}｜工作区 ${start.工作区}｜受理时刻 ${start.受理时刻}`)
										.join("\n  ")
								: "未启动（还没有执行实例）"
						}`,
					);
					const 历史 = listPlanHistory(项目根, 定义.计划ID);
					lines.push(
						`历史版本：${
							历史.length > 0
								? 历史
										.map(
											(entry) =>
												`版本 ${entry.定义版本}${entry.问题 ? "（读不出）" : ""}`,
										)
										.join("、")
								: "（还没有版本历史：这份计划没被改过）"
						}`,
					);
					for (const entry of 历史) {
						if (entry.问题) lines.push(`- 历史版本 ${entry.定义版本} 读不出：${entry.问题}`);
					}
					if (params.step_detail) {
						const 目标步骤 = selectStep(定义.步骤, params.around_step);
						lines.push(renderStepDetail(目标步骤, params.step_detail));
					} else {
						const 步骤 = params.around_step
							? [selectStep(定义.步骤, params.around_step)]
							: 定义.步骤;
						lines.push(`步骤（${步骤.length}）：`);
						for (const step of 步骤) lines.push(renderStepFull(step, 定义.步骤));
					}
					lines.push(
						`恢复查看：要接着看这份计划的执行现场，用它的实例工作区 ${view.启动[0]?.工作区 ?? "（未启动，所以还没有执行现场）"}。`,
					);
				}
				if (view.问题.length > 0) lines.push(`读取问题（${view.问题.length} 项）：${view.问题.join("；")}`);
				return lines.join("\n");
			}),
	});

	pi.registerTool({
		name: "pao_plan_start",
		label: "确认并启动临时计划",
		description:
			"用户确认后启动临时计划：走既有 v2 启流核心（预检→owner→冻结配方→控制正本→自动链），执行目录按启动请求 ID 先定死，返回真实实例号与执行目录。必须带 plan_id、definition_version（确认的是哪一版）与 start_request_id；确认事实只认宿主确认回调，模型自己写 confirmed 或转述「用户已同意」都不算。同一 start_request_id 重试是找回原实例，不会起第二份；只有控制正本已形成而关联丢失时报出可恢复原因，不下「未受理」结论。",
		parameters: Type.Object({
			...baseParams,
			plan_id: Type.String(),
			definition_version: Type.Integer({ minimum: 1, description: "要启动的定义版本（确认时给用户看的那一版）" }),
			start_request_id: Type.String({ description: "本次启动逻辑请求 ID（重试沿用原 ID，落在同一执行目录）" }),
		}),
		execute: async (
			_toolCallId: string,
			params: { project_root?: string; plan_id: string; definition_version: number; start_request_id: string },
			signal: AbortSignal | undefined,
			_update: unknown,
			ctx?: ExtensionContext,
		) =>
			toolText(async () => {
				const 项目根 = resolveProjectRoot(params.project_root, options);
				const 计划ID = params.plan_id;
				const 启动请求ID = params.start_request_id;
				const 定义版本 = params.definition_version;
				const 来源会话 = options?.resolveOwnerSessionId?.();
				const 首查 = resolvePlanExecution({ 项目根, 计划ID, 启动请求ID, 定义版本, 来源会话, 信号: signal });
				if (首查.找回) {
					return [
						`已受理（找回原实例，没有第二次启动）：实例 ${首查.找回.实例}`,
						`执行目录：${首查.找回.工作区}｜卡目录：${首查.找回.卡目录}`,
						`控制清单：${首查.找回.控制清单}`,
					].join("\n");
				}
				const request = options?.requestConfirmation;
				const definition = readTemporaryPlan(项目根, 计划ID);
				// 等待确认期间不持任何文件锁（可能很久），回来后再复核版本与撤销状态。
				const 确认文本 = `启动临时计划 ${definition.显示名}（${计划ID}）定义版本 ${定义版本}？\n步骤：${describeSteps(definition.步骤)}\n启动请求：${启动请求ID}`;
				let confirmation: PlanConfirmation | undefined;
				if (request) {
					confirmation = await raceConfirmation(
						request({
							项目根,
							计划ID,
							显示名: definition.显示名,
							定义版本,
							启动请求ID,
							步骤摘要: describeSteps(definition.步骤),
						}),
						signal,
						"启动临时计划",
					);
				} else if (ctx?.hasUI) {
					// 复用既有显式确认能力（ctx.ui.confirm）：用户点头才算，模型自述不算。
					const 同意 = await raceConfirmation(
						ctx.ui.confirm("启动临时工作流", 确认文本),
						signal,
						"启动临时计划",
					);
					confirmation = 同意
						? { 计划ID, 定义版本, 启动请求ID, 来源: "用户交互事件", 时刻: new Date().toISOString() }
						: undefined;
				} else {
					throw new Error(
						"[PLAN_CONFIRM_REQUIRED] 没有可用的宿主确认回调，也没有交互界面：启动必须有宿主确认事实。请在宿主注入 requestConfirmation（桌面/CLI 的真实用户确认），无桌面集成时用明确模拟的宿主回调并如实标注——模型自述不算确认。",
					);
				}
				// 取消穿透第 ① 点：确认等待期间用户取消 → 直接终止，不落任何东西。
				throwIfPlanAborted(signal, "启动临时计划");
				assertPlanConfirmation(confirmation, { 计划ID, 定义版本, 启动请求ID });
				// 确认等待期间原主控可能已切换：切换后这个会话不再是来源主控，不能再受理。
				// 重新解析一次而不是沿用等待前那份，否则「A 等确认、B 接管」会拿 A 的身份放行。
				const owner = options?.resolveOwnerSessionId?.();
				if (来源会话 !== owner) {
					throw new TemporaryPlanError(
						"PLAN_FORBIDDEN",
						`确认期间来源主控已切换（等待前 ${来源会话 ?? "（未提供）"}，现在 ${owner ?? "（未提供）"}）：这次启动不再代表原主控，已终止。请回到原主控会话重新发起（本批不做跨主控接管）。`,
						{ 等待前来源会话: 来源会话, 当前来源会话: owner },
					);
				}
				// 受理在计划锁内完成：复核状态 → 落「这一版正在启动」的意图 → 才释放锁去真正启流。
				// 这样并发编辑与并发启动都只有一个先受理，另一半看到冻结证据被拒。
				const 锁 = join(planDir(项目根, 计划ID), "计划.lock");
				mkdirSync(planDir(项目根, 计划ID), { recursive: true });
				type 受理结果 = { 找回: NonNullable<PlanExecution["找回"]> } | { 复核: PlanExecution };
				const 受理 = await withFileLock<受理结果>(锁, () => {
					throwIfPlanAborted(signal, "启动临时计划");
					const 复核 = resolvePlanExecution({ 项目根, 计划ID, 启动请求ID, 定义版本, 来源会话, 信号: signal });
					if (复核.找回) return { 找回: 复核.找回 };
					recordStartIntent(复核.关联路径, {
						计划ID,
						定义版本,
						启动请求ID,
						owner会话: owner ?? "",
					});
					return { 复核 };
				});
				if ("找回" in 受理) {
					return [
						`已受理（确认期间已由另一次请求受理，本次是找回）：实例 ${受理.找回.实例}`,
						`执行目录：${受理.找回.工作区}｜控制清单：${受理.找回.控制清单}`,
					].join("\n");
				}
				const 复核 = 受理.复核;
				const chainOptions: AutoChainOptions = {
					cardsDir: 复核.卡目录,
					workspaceDir: 复核.工作区,
					ownerSessionId: owner,
					paoHome: options?.resolvePaoHome?.() ?? defaultPaoHome(),
					driveDepartments: options?.driveDepartments,
					运行器: options?.runner ?? defaultWorkerRunner,
					沙箱根: options?.沙箱根,
					signal,
				};
				// 取消穿透第 ② 点：受理留痕后、真正启流前再查一次；此时盘上只有意图，没有控制正本。
				throwIfPlanAborted(signal, "启动临时计划");
				const text = await startWorkflowCore(复核.配方, {}, chainOptions, common);
				// 真实身份只从盘上读：不拿请求参数当结果。
				const identity = readPlanInstanceIdentity(复核.工作区, 复核.配方名);
				if (!identity) {
					throw new Error(
						`[PLAN_START_PARTIAL] 启动受理后读不到实例身份：${复核.控制清单}；属不完整启动，请人工核对后处理，不会自动再启一份`,
					);
				}
				recordPlanStart(复核.关联路径, {
					计划ID,
					定义版本,
					启动请求ID,
					实例: identity.实例,
					配方名: 复核.配方名,
					工作区: 复核.工作区,
					卡目录: 复核.卡目录,
					控制清单: identity.控制清单,
					owner会话: identity.owner,
					受理时刻: new Date().toISOString(),
				});
				return [
					text,
					`已受理：实例 ${identity.实例}（计划 ${计划ID} 定义版本 ${定义版本}，启动请求 ${启动请求ID}）`,
					`执行目录：${复核.工作区}｜卡目录：${复核.卡目录}`,
				].join("\n");
			}),
	});

	pi.registerTool({
		name: "pao_plan_save_template",
		label: "存临时计划为模板",
		description:
			"把临时计划里可复用的部分（步骤/部门/依赖/约束/技能/预算/验收/人工门/审核，按字段白名单）存成 <PAO_HOME>/工作流/<模板名>.md：不含会话、卡号、实例状态与本次成果路径。定义版本要一致；同名模板不覆盖（要覆盖请在模板库里改名或删旧版）。参数化：用 params 把本次特有的字面量（绝对路径、项目名等）点名换成 {占位符}，模板 frontmatter 的「参数」表会声明它们，于是换一个项目填了参数就能再跑一份新计划；params 的键是参数名、值是**本次的字面量**，内核只替换你点名的文本，不猜哪段该参数化。计划里还有本次特有路径且没被 params 换掉时默认拒存并列出路径（或显式 allow_project_specific_paths 原样保存并在结果里点名）。保存模板不改变当前执行，也不影响已冻结的实例。",
		parameters: Type.Object({
			...baseParams,
			plan_id: Type.String(),
			definition_version: Type.Integer({ minimum: 1 }),
			template_name: Type.String({ description: "模板名（＝模板库文件名）" }),
			params: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description: "要参数化的本次字面量：{参数名: 本次的文本}；模板里替换成 {参数名} 并在参数表声明",
				}),
			),
			allow_project_specific_paths: Type.Optional(
				Type.Boolean({ description: "为 true 时允许本次特有路径原样进模板（结果里会点名）" }),
			),
		}),
		execute: async (
			_toolCallId: string,
			params: {
				project_root?: string;
				plan_id: string;
				definition_version: number;
				template_name: string;
				params?: Record<string, string>;
				allow_project_specific_paths?: boolean;
			},
			signal?: AbortSignal,
		) =>
			toolText(() => {
				const 项目根 = resolveProjectRoot(params.project_root, options);
				const saved = savePlanAsTemplate({
					项目根,
					计划ID: params.plan_id,
					定义版本: params.definition_version,
					模板名: params.template_name,
					参数: params.params,
					paoHome: options?.resolvePaoHome?.() ?? defaultPaoHome(),
					允许未泛化路径: params.allow_project_specific_paths,
					来源会话: options?.resolveOwnerSessionId?.(),
					信号: signal,
				});
				const 参数名 = Object.keys(params.params ?? {});
				return [
					`模板已保存：${saved.路径}（${saved.节点数} 个节点）${saved.备份 ? `｜旧版备份：${saved.备份}` : ""}`,
					参数名.length > 0
						? `已参数化：${参数名.map((名字) => `{${名字}}`).join("、")}（模板参数的取值在启动时用 pao_start_flow 的 params 给）`
						: "模板没有声明参数（整份是可复用的固定要求）。",
					saved.未泛化路径.length > 0
						? `注意：以下本次特有路径被原样保留，换项目用时必须逐条改：${saved.未泛化路径.join("、")}`
						: "模板里没有本次特有路径。",
					"保存模板不改变当前执行。",
				].join("\n");
			}),
	});

	pi.registerTool({
		name: "pao_plan_feedback",
		label: "步骤/文件意见",
		description:
			"把用户对整份计划的目标、某一步或某个文件说的话记到临时计划上，并如实报投递状态。绑定提交时正在看的定义版本与阅读版本，之后计划被改或出现新稿都不改绑（只提示有新版本）。target_kind：流程＝针对整份计划目标的整体意见（不要给 step_id）；步骤＝针对某一步（缺省，给 step_id）；文件＝针对某一轮次的某个文件（还要给 round/file_path/version_basis）。action：record＝新建（给 deliver_request_id 才算「待送达」，同一 ID 重试是回放）；delivery＝写真实投递回执（delivered=true 才算「已送达」，false 记「投递失败」并给失败原因，没回执不许说送到了；请求 ID 与实例对不上不结算）；apply＝按业务依据标「已应用」（依据必须是哪张卡/哪次修订真的照它改了，空白不算）；list＝按提交顺序列出。",
		parameters: Type.Object({
			...baseParams,
			plan_id: Type.String(),
			action: Type.Union([
				Type.Literal("record"),
				Type.Literal("delivery"),
				Type.Literal("apply"),
				Type.Literal("list"),
			]),
			feedback_id: Type.Optional(Type.String({ description: "delivery/apply 必填：要结算的那条意见" })),
			definition_version: Type.Optional(
				Type.Integer({ minimum: 1, description: "record 用：提交时用户正在看的那一版定义" }),
			),
			target_kind: Type.Optional(
				Type.Union([Type.Literal("流程"), Type.Literal("步骤"), Type.Literal("文件")], {
					description: "缺省＝步骤；「流程」＝针对整份计划的目标/整体评价（此时不要给 step_id）",
				}),
			),
			step_id: Type.Optional(Type.String({ description: "讨论对象所在的步骤 ID（如 s1）" })),
			round: Type.Optional(Type.Integer({ minimum: 1, description: "文件意见：第几轮次的稿子" })),
			file_path: Type.Optional(Type.String({ description: "文件意见：已确认的成果路径" })),
			version_basis: Type.Optional(
				Type.String({ description: "文件意见：版本依据（用户读的是哪一版，如轮次＋文件时间戳）" }),
			),
			text: Type.Optional(Type.String({ description: "record 用：用户的原话/意见正文" })),
			deliver_request_id: Type.Optional(
				Type.String({ description: "投递逻辑请求 ID（重试沿用原 ID；给了才是「待送达」）" }),
			),
			delivered: Type.Optional(Type.Boolean({ description: "delivery 用：部长那边是否真的受理了" })),
			result: Type.Optional(Type.String({ description: "delivery 用：真实结果原文（送达回执或失败原因）" })),
			instance_id: Type.Optional(
				Type.String({ description: "delivery 用：回执来自哪个执行实例；与已登记实例对不上就不结算这条意见" }),
			),
			evidence: Type.Optional(Type.String({ description: "apply 用：业务处理依据" })),
		}),
		execute: async (
			_toolCallId: string,
			params: {
				project_root?: string;
				plan_id: string;
				action: "record" | "delivery" | "apply" | "list";
				feedback_id?: string;
				definition_version?: number;
				target_kind?: "流程" | "步骤" | "文件";
				step_id?: string;
				round?: number;
				file_path?: string;
				version_basis?: string;
				text?: string;
				deliver_request_id?: string;
				delivered?: boolean;
				result?: string;
				instance_id?: string;
				evidence?: string;
			},
			signal?: AbortSignal,
		) =>
			toolText(async () => {
				const 项目根 = resolveProjectRoot(params.project_root, options);
				if (params.action === "list") {
					const entries = listPlanFeedback(项目根, params.plan_id);
					if (entries.length === 0) return `临时计划 ${params.plan_id} 还没有记过意见。`;
					return [
						`意见 ${entries.length} 条（按提交顺序）`,
						...entries.map((entry) => renderFeedbackLine(entry)),
					].join("\n");
				}
				if (params.action === "record") {
					if (!params.text?.trim()) throw new Error("[PLAN_INVALID] record 要给 text（用户的原话/意见）");
					const 结果 = await recordPlanFeedback({
						项目根,
						计划ID: params.plan_id,
						期望定义版本: params.definition_version,
						目标: toFeedbackTarget(params),
						正文: params.text,
						投递请求ID: params.deliver_request_id,
						来源会话: options?.resolveOwnerSessionId?.(),
						信号: signal,
					});
					const 状态说明 = 结果.回放
						? "同一投递请求 ID 已记过这条，本次是回放（没有重复落记录）"
						: `已记下这条意见，状态「${结果.entry.状态}」`;
					return `${状态说明}：${renderFeedbackLine(结果.entry)}`;
				}
				const 意见ID = params.feedback_id?.trim();
				if (!意见ID) throw new Error(`[PLAN_INVALID] action=${params.action} 要给 feedback_id`);
				if (params.action === "delivery") {
					if (params.delivered === undefined) {
						throw new Error("[PLAN_INVALID] delivery 要给 delivered（true＝已送达，false＝投递失败）");
					}
					const updated = await recordPlanFeedbackDelivery({
						项目根,
						计划ID: params.plan_id,
						意见ID,
						送达: params.delivered,
						结果: params.result ?? "",
						投递请求ID: params.deliver_request_id,
						实例: params.instance_id,
						来源会话: options?.resolveOwnerSessionId?.(),
						信号: signal,
					});
					return `意见 ${意见ID} 状态：${updated.状态}｜投递：${updated.投递?.结果 ?? "（没记到结果）"}`;
				}
				const updated = await markPlanFeedbackApplied({
					项目根,
					计划ID: params.plan_id,
					意见ID,
					依据: params.evidence ?? "",
					来源会话: options?.resolveOwnerSessionId?.(),
					信号: signal,
				});
				return `意见 ${意见ID} 已按业务依据标为「${updated.状态}」：${updated.应用?.依据}`;
			}),
	});
}

/**
 * 意见目标参数 → 讨论对象。整体意见针对「这份计划的目标」，用 `target_kind: "流程"` 表达，
 * 不带步骤 ID（空 step_id 会让意见在盘上变成找不到对象的孤儿）；步骤意见只认步骤 ID；
 * 文件意见必须给齐轮次、已确认路径与「用户读的是哪一版」（版本依据），否则绑定不到具体版本。
 */
function toFeedbackTarget(params: {
	target_kind?: "流程" | "步骤" | "文件";
	step_id?: string;
	round?: number;
	file_path?: string;
	version_basis?: string;
}): PlanFeedbackTarget {
	// 整体意见没有「哪一步」：这是独立形态，不是「步骤 ID 为空」。
	if (params.target_kind === "流程") {
		if (params.step_id?.trim()) {
			throw new Error("[PLAN_INVALID] 整体意见针对计划目标，不要给 step_id；要针对某一步请用 target_kind=步骤");
		}
		return { 类型: "流程" };
	}
	const 步骤ID = params.step_id?.trim();
	if (!步骤ID) {
		throw new Error(
			"[PLAN_INVALID] 意见要说清针对哪一步：给 step_id；如果你要评的是整份计划的目标，用 target_kind=流程（不要走空 step_id）",
		);
	}
	if (params.target_kind !== "文件") return { 类型: "步骤", 步骤ID };
	if (!params.file_path?.trim()) throw new Error("[PLAN_INVALID] 文件意见要给 file_path（已确认的成果路径）");
	if (params.round === undefined) throw new Error("[PLAN_INVALID] 文件意见要给 round（第几轮次的稿子）");
	if (!params.version_basis?.trim()) {
		throw new Error("[PLAN_INVALID] 文件意见要给 version_basis（用户读的是哪一版），否则意见会绑错稿");
	}
	return {
		类型: "文件",
		步骤ID,
		轮次: params.round,
		路径: params.file_path.trim(),
		版本依据: params.version_basis.trim(),
	};
}

/** 意见状态 → 中文一行（「待送达」与「投递失败」分开说，不混成「已处理」）。 */
function renderFeedbackLine(entry: {
	意见ID: string;
	状态: string;
	定义版本: number;
	正文: string;
	目标: PlanFeedbackTarget;
	投递?: { 结果: string };
	应用?: { 依据: string };
}): string {
	const 对象 =
		entry.目标.类型 === "流程"
			? "流程目标（整份计划）"
			: entry.目标.类型 === "步骤"
				? `步骤 ${entry.目标.步骤ID}`
				: `文件 ${entry.目标.路径}（步骤 ${entry.目标.步骤ID} 第 ${entry.目标.轮次} 轮，${entry.目标.版本依据}）`;
	const 尾 = entry.应用 ? `｜已应用依据：${entry.应用.依据}` : entry.投递 ? `｜投递：${entry.投递.结果}` : "";
	return `${entry.意见ID}［${entry.状态}］定义版本 ${entry.定义版本}｜${对象}｜${entry.正文}${尾}`;
}
