/**
 * worker 活动 → 分层监督快照。
 *
 * 这个模块只读取 WorkerRunner 的运行态，不启动定时器，也不记录“已处理”。
 * MinisterHostOptions.活动 负责把快照送进宿主的 SupervisionState；20 秒扫描、
 * 15/30 分钟到期、提醒合并和确认后重置都仍归宿主状态机所有。
 */

import { resolve } from "node:path";
import { loadCard, projectRootForCards, readCard } from "../cards/cardfile.ts";
import { formatCardNumber } from "../cards/counter.ts";
import type { CardStatus, ParsedCard } from "../cards/types.ts";
import type { HostActivity } from "../host/host.ts";
import { resolvePaoRole } from "../role.ts";
import { logWarn } from "../shared/log.ts";
import { parseWorkflowMarker } from "../shared/marker.ts";
import { pathKey } from "../shared/path-key.ts";
import { readControl } from "../workflow/control.ts";
import { loadFrozenRecipe } from "../workflow/minister.ts";
import type { ProcessEntry } from "./registry.ts";
import type { WorkerRunner } from "./runner.ts";

/** 派发端解析出的直接上级路由；runner 启动时原样写入进程登记表。 */
export interface WorkerSupervisionRoute {
	department: string;
	projectRoot: string;
	/** 直接部长会话的绑定脉络；宿主用它把监督与回执投递给该部长。 */
	context?: string;
	/** 实际受理工人的部长会话标识；与投递脉络可相同，也可由宿主另行区分。 */
	sessionId?: string;
	key: string;
	/** 部门仍活跃时，由主控部门活动聚合使用的稳定键；缺省按部门＋任务根＋脉络生成。 */
	departmentKey?: string;
	/** 派工发起方会话（通常是主控），只用于来源合并，不决定回执投递目标。 */
	ownerSessionId?: string;
	/** 派发时的目标，供监督摘要直接展示，不依赖从提示词反推。 */
	goal?: string;
	/** 派发端已知的证据入口；runner 会在可用时补 live 和最终证据路径。 */
	evidence?: string[];
	/** 工作流实例/节点等业务对象名；用于同一部长下合并提醒。 */
	label?: string;
	/**
	 * 回执投递位置。普通部长自派工用 local，走当前部长通知面；
	 * 工作流卡用 minister，由主控宿主投递给冻结点绑定部长。
	 */
	target?: "local" | "minister";
	binding?: {
		source: "runtime" | "workflow";
		role: "main" | "minister" | "worker" | "unknown";
		target: "local" | "minister" | "department";
	};
}

export interface WorkerSupervisionRouteInput {
	cardNo: string;
	cardsDir: string;
	operator: string;
	ownerSession?: string;
	goal: string;
	/** 当前工具会话角色；缺省读 PAO_ROLE。 */
	role?: "main" | "minister" | "主控" | "部长";
	/** 普通部长当前部门；缺省读 PAO_DEPT。 */
	department?: string;
}

export interface WorkerSupervisionRouteResolverOptions {
	/** 正式现场缺省读 PAO_ROLE / PAO_DEPT；测试或宿主可显式给实际会话角色。 */
	role?: WorkerSupervisionRouteInput["role"];
	department?: string;
}

export interface BuildWorkerSupervisionActivityOptions {
	/**
	 * 主控（main）或部长（minister）。普通工人始终只提醒其直接部长；
	 * 账号级部门对象只在主控快照里生成，避免主控和部长各扫一遍并改变并发。
	 */
	role?: "main" | "minister";
	/** 当前 PAO 会话身份；部门对象用它在主控处合并同源检查。 */
	context?: string;
	/**
	 * 当前卡/控制正本核对失败时是否连同部门对象一起排除。正式主控/部长缺省 true：
	 * 无法确认对象仍是当前执行时，不继续报成“运行中”；测试可注 false 只验证纯投影。
	 */
	failClosed?: boolean;
}

const nonBlank = (value: string | undefined): value is string => Boolean(value?.trim());

const activeKey = (entry: Pick<ProcessEntry, "run_id" | "pid">): string =>
	entry.run_id ? `run:${entry.run_id}` : `pid:${entry.pid}`;

const currentCard = (entry: ProcessEntry): ParsedCard => {
	if (!entry.card_path) throw new Error("运行中工人缺少完整卡路径，无法核对当前监督状态");
	return readCard(entry.card_path);
};

const cardIsActivelyRunning = (status: CardStatus): boolean => status === "in_progress";

/**
 * v2 派发后重读当前控制正本。这里区分“仍在跑”与“已有明确等待位”：
 * - 流程暂停或已登记裁定请求：等待人工/裁决，退出周期监督；
 * - 当前节点已进入人工确认等待：退出；
 * - 完整卡已有回执但节点尚未完成：worker 已交回结果，等待部长审核与下一步，
 *   也退出周期“跑动中”检查。
 *
 * 读取异常按 fail-closed 处理：不能把无法确认仍是当前执行的工人继续报成活跃。
 * 普通非工作流卡没有对应 v2 控制正本，不凭无输出或 in_progress 猜等待用户。
 */
const hasV2WaitingPosition = (entry: ProcessEntry, card: ParsedCard): boolean => {
	const marker = parseWorkflowMarker(card.body);
	const versioned = card.body.match(/<!-- pao-workflow-v2:实例=([^/\s]+)\/轮次=(\d+) -->/);
	if (!entry.card_path || (!marker && !card.body.includes("pao-workflow-v2:"))) return false;
	if (!marker) throw new Error("工人卡的工作流 v2 身份标记损坏");
	if (!versioned) return false;
	const cardsDir = resolve(entry.card_path, "..");
	const recipe = loadFrozenRecipe(marker.流, { cardsDir });
	const flow = readControl(recipe, { cardsDir });
	const node = flow.节点.find((candidate) => candidate.名字 === marker.节点);
	if (
		flow.实例 !== versioned[1] ||
		!node ||
		node.轮次 !== Number(versioned[2]) ||
		!node.卡.includes(formatCardNumber(card.card_no))
	)
		throw new Error("工人当前卡已不属于控制正本的实例/节点/轮次");
	if (flow.暂停 || flow.裁定) return true;
	// 只看本工人的当前卡；同节点其他工人交回执不能让尚在运行的兄弟卡退出监督。
	return card.receipts.some((receipt) => receipt.attempt === (entry.attempt ?? card.frontmatter.attempt));
};

/** 部门活动对象的对象键：部门 + 项目根 + 部长脉络 + 来源，不拿 owner 合并键冒充。 */
export function workerDepartmentKey(input: {
	department: string;
	projectRoot: string;
	context?: string;
	ownerSessionId?: string;
}): string {
	return [
		"department",
		input.department.trim(),
		pathKey(input.projectRoot),
		input.context?.trim() ?? "",
		input.ownerSessionId?.trim() ?? "",
	].join("\u0000");
}

/**
 * SupervisionState 的 work.key 会原样进提醒正文,并要求上级复制给确认工具。
 * 因此对外只暴露可打印、稳定且能区分部门的标识;内部碰撞隔离仍用 NUL 组成的 Map key。
 */
export function printableWorkerDepartmentKey(key: string): string {
	const encoded = Buffer.from(key, "utf8").toString("base64url");
	return `department:${encoded}`;
}

function normalizeRole(role: WorkerSupervisionRouteInput["role"] | undefined): "main" | "minister" {
	if (role === "minister" || role === "部长") return "minister";
	if (role === "main" || role === "主控") return "main";
	return resolvePaoRole() === "部长" ? "minister" : "main";
}

function runtimeBinding(role: "main" | "minister"): WorkerSupervisionRoute["binding"] {
	return {
		source: "runtime",
		role,
		target: role === "minister" ? "local" : "department",
	};
}

/**
 * 从卡面工作流标记和冻结控制正本解析真实部长路由。
 *
 * 普通部长派本部门卡走本地通知；主控派普通部门卡不带伪造部长身份，交给部门活动
 * 承担 30 分钟监督。v2 卡必须能从冻结控制正本唯一定位实例、轮次和节点部长会话，
 * 损坏、错轮次、错卡、暂停或缺少部长会话时不造监督对象。
 */
export function resolveWorkerSupervisionRoute(
	card: ParsedCard,
	input: WorkerSupervisionRouteInput,
): WorkerSupervisionRoute | undefined {
	const role = normalizeRole(input.role);
	const department = card.frontmatter.dept?.trim();
	if (!department) return undefined;
	const projectRoot = projectRootForCards(input.cardsDir);
	const cardKey = `${resolve(input.cardsDir)}#卡${formatCardNumber(card.card_no)}`;
	const marker = parseWorkflowMarker(card.body);
	const hasV2Marker = card.body.includes("pao-workflow-v2:");
	if (hasV2Marker && !marker) {
		throw new Error("工作流 v2 卡缺少有效的 pao-workflow 归属标记");
	}
	if (marker === undefined && role === "minister") {
		const currentDepartment = (input.department ?? process.env.PAO_DEPT)?.trim();
		if (!currentDepartment || currentDepartment !== department) return undefined;
		const context = input.ownerSession?.trim();
		// 本地路由必须能核对到当前部长会话；没有会话身份时不制造一个无人可投递的对象。
		if (!context) return undefined;
		return {
			department,
			projectRoot,
			context,
			sessionId: context,
			key: cardKey,
			departmentKey: workerDepartmentKey({ department, projectRoot, context }),
			goal: card.frontmatter.goal ?? input.goal,
			target: "local",
			binding: runtimeBinding(role),
		};
	}
	if (marker) {
		const versioned = card.body.match(/<!-- pao-workflow-v2:实例=([^/\s]+)\/轮次=(\d+) -->/);
		// v1 卡只有 pao-workflow 标记，没有 v2 实例/轮次身份；保持旧卡的自足派发语义，
		// 不读取不存在的控制正本，也不制造无法验证的部长绑定。
		if (!versioned) {
			if (hasV2Marker) throw new Error("工作流 v2 卡身份标记损坏");
			return undefined;
		}
		const flow = readControl(loadFrozenRecipe(marker.流, { cardsDir: input.cardsDir }), {
			cardsDir: input.cardsDir,
		});
		const node = flow.节点.find((candidate) => candidate.名字 === marker.节点);
		if (
			flow.实例 !== versioned[1] ||
			node?.轮次 !== Number(versioned[2]) ||
			!node.卡.includes(formatCardNumber(card.card_no)) ||
			flow.暂停 ||
			!node.部长会话
		)
			throw new Error("工作流 v2 卡不属于当前实例/轮次、流程已暂停或部长会话尚未绑定");
		return {
			department,
			projectRoot,
			context: flow.脉络,
			sessionId: node.部长会话,
			ownerSessionId: flow.owner,
			key: cardKey,
			departmentKey: workerDepartmentKey({
				department,
				projectRoot,
				context: flow.脉络,
				ownerSessionId: flow.owner,
			}),
			label: `${flow.工作流}/${marker.节点}/第${node.轮次}轮`,
			goal: card.frontmatter.goal ?? input.goal,
			target: "minister",
			binding: { source: "workflow", role, target: "minister" },
		};
	}
	if (role !== "minister") return undefined;
	return undefined;
}

/** 供工具装配使用的 resolver 工厂；传入会话事实后不依赖测试注入。 */
export function createWorkerSupervisionRouteResolver(
	options: WorkerSupervisionRouteResolverOptions = {},
): (input: WorkerSupervisionRouteInput) => WorkerSupervisionRoute | undefined {
	return (input) => {
		const { cardNo, cardsDir } = input;
		const card = loadCard(cardsDir, Number.parseInt(cardNo, 10));
		return resolveWorkerSupervisionRoute(card, {
			...input,
			...(options.role !== undefined ? { role: options.role } : {}),
			...(options.department !== undefined ? { department: options.department } : {}),
		});
	};
}

const progressFrom = (entry: ProcessEntry): NonNullable<HostActivity["progress"]> => ({
	...(nonBlank(entry.supervision_goal) ? { goal: entry.supervision_goal.trim() } : {}),
	...(nonBlank(entry.supervision_progress) ? { recentProgress: entry.supervision_progress.trim() } : {}),
	...(nonBlank(entry.supervision_blocker) ? { blocker: entry.supervision_blocker.trim() } : {}),
	...(entry.supervision_evidence?.length
		? {
				evidence: entry.supervision_evidence.filter((value) => nonBlank(value)).map((value) => value.trim()),
			}
		: {}),
});

/**
 * 把同一个 runner 的运行态投影为 MinisterHost 可消费的活动快照。
 *
 * worker 对象通过派发时写入的 supervisor_* 字段绑定部长；没有路由的裸 runner
 * 不冒充可投递目标。主控快照另行汇总仍有活工人的部门对象，保证部门本身仍按
 * 30 分钟检查，而 worker 收敛后对应部门对象会在下一次 getter 读取时消失。
 */
export function buildWorkerSupervisionActivity(
	runner: Pick<WorkerRunner, "registry">,
	options: BuildWorkerSupervisionActivityOptions = {},
): HostActivity[] {
	const role = options.role ?? "main";
	const candidates = runner.registry.list().filter(
		(
			entry,
		): entry is ProcessEntry & {
			supervisor_dept: string;
			task_root: string;
		} => entry.running && entry.tags !== "部长" && nonBlank(entry.supervisor_dept) && nonBlank(entry.task_root),
	);
	const entries: typeof candidates = [];
	for (const entry of candidates) {
		try {
			const card = currentCard(entry);
			if (!cardIsActivelyRunning(card.frontmatter.status) || hasV2WaitingPosition(entry, card)) continue;
			entries.push(entry);
		} catch (error) {
			logWarn(
				`[pao] 工人监督状态核对失败，按非活跃对象退出周期监督（卡${entry.card_no}，运行 ${activeKey(entry)}）:${error instanceof Error ? error.message : String(error)}`,
			);
			if (options.failClosed === false) entries.push(entry);
		}
	}
	const activities: HostActivity[] = entries.map((entry) => {
		const progress = progressFrom(entry);
		return {
			key: entry.supervision_key ?? entry.card_path ?? `worker:${activeKey(entry)}`,
			kind: "worker",
			department: entry.supervisor_dept,
			projectRoot: entry.task_root,
			...(nonBlank(entry.supervisor_context) ? { context: entry.supervisor_context } : {}),
			...(nonBlank(entry.supervisor_session) ? { sessionId: entry.supervisor_session } : {}),
			...(nonBlank(entry.supervision_owner) ? { ownerSessionId: entry.supervision_owner } : {}),
			...(Object.keys(progress).length > 0 ? { progress } : {}),
			running: true,
		};
	});
	if (role !== "main") return activities;

	const departments = new Map<
		string,
		{
			department: string;
			projectRoot: string;
			context?: string;
			keys: string[];
			key?: string;
			progress: string[];
		}
	>();
	for (const entry of entries) {
		const context = entry.supervisor_context ?? options.context;
		const departmentKey =
			entry.supervision_department_key ??
			workerDepartmentKey({
				department: entry.supervisor_dept,
				projectRoot: entry.task_root,
				context: entry.supervisor_context ?? options.context,
				ownerSessionId: entry.supervision_owner,
			});
		const current = departments.get(departmentKey);
		const progress = [entry.supervision_goal, entry.supervision_progress]
			.filter(nonBlank)
			.map((value) => value.trim());
		if (current) {
			current.keys.push(entry.card_path ?? entry.card_no);
			if (entry.supervision_label) current.progress.push(entry.supervision_label);
			if (progress.length > 0) current.progress.push(progress.join("；"));
		} else {
			departments.set(departmentKey, {
				department: entry.supervisor_dept,
				projectRoot: entry.task_root,
				...(context ? { context } : {}),
				keys: [entry.card_path ?? entry.card_no],
				progress: [...(entry.supervision_label ? [entry.supervision_label] : []), ...progress],
			});
		}
	}
	for (const [key, department] of departments) {
		activities.push({
			key: department.key ?? printableWorkerDepartmentKey(key),
			kind: "department",
			department: department.department,
			projectRoot: department.projectRoot,
			...(department.context ? { context: department.context } : {}),
			...(options.context ? { ownerSessionId: options.context } : {}),
			progress: {
				...(department.progress.length > 0 ? { recentProgress: department.progress.join("；") } : {}),
				evidence: department.keys,
			},
			running: true,
		});
	}
	return activities;
}
