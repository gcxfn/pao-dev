/**
 * 工作流派发解释与派前校验（T02;架构 §11.6/§3.3）。
 * 从 worker/dispatch-core 抽回的工作流解释职责：卡面标记解析、冻结配方读取、
 * 实例/轮次/owner/暂停检查与节点技能解析归 workflow；worker 通用派发不再导入
 * workflow/{control,driver,minister,recipe}，只经装配处注入的解析回调消费最小上下文。
 *
 * 同一回调在派发链里调两次：派发准备期解析（早失败＋解出按需技能）＋取得项目写锁后
 * 认领拉起前重读控制正本做最终重核（§3.3「不能把检查结果当永久许可」）——本函数纯读盘
 * 无副作用，重跑无害；两次之间控制正本若有漂移即拒绝启动（fail-closed）。
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { formatCardNumber } from "../cards/counter.ts";
import type { ParsedCard } from "../cards/types.ts";
import { PaoWorkerError } from "../worker/errors.ts";
import { readControl } from "./control.ts";
import { parseWorkflowMarker } from "./driver.ts";
import { currentDependencyMaps, loadFrozenRecipe } from "./minister.ts";
import { loadRecipe, type RecipeNode } from "./recipe.ts";

/** 工作流卡解析出的最小派发上下文（§3.3）：实例/轮次等身份校验在本模块内完成，执行层只消费技能挂载。 */
export interface WorkflowDispatchContext {
	/** 节点「技能」声明解析出的绝对路径。 */
	skills: string[];
	/** 当前节点合法依赖在当前轮保存的零卡地图；由派发入口转成 upstream 证据。 */
	upstreamMapRefs: string[];
}

export interface WorkflowDispatchInput {
	/** 任务工作区卡目录（冻结配方与控制正本寻址） */
	cardsDir: string;
	/** PAO_HOME（v1 活配方与技能目录寻址） */
	paoHome?: string;
	/**
	 * 期望的流程 owner（T03 三入口收口后统一核对）:自动链传装配层 ownerSessionId,
	 * 单卡/扇出传工具调用会话 id（pi 工具上下文 sessionManager.getSessionId,与自动链同源）。
	 * undefined＝调用方无会话上下文（直调/既有测试）,不核 owner 维持既有行为。
	 */
	owner?: string;
}

/** 节点「技能」声明 → 绝对路径;缺 PAO_HOME 或技能文件缺失一律拒派（fail-closed,§11.6）。 */
function resolveNodeSkills(node: RecipeNode, flow: string, nodeName: string, paoHome?: string): string[] {
	return (node.技能 ?? []).map((name) => {
		if (!paoHome)
			throw new PaoWorkerError(
				"无效参数",
				`节点「${nodeName}」声明技能「${name}」，但缺少 PAO_HOME 无法解析技能目录；拒派（fail-closed）`,
			);
		const skill = resolve(paoHome, "pao配置", "skills", name);
		if (!existsSync(skill))
			throw new PaoWorkerError("无效参数", `节点技能不存在：${skill}（工作流「${flow}」节点「${nodeName}」声明）`);
		return skill;
	});
}

const NODE_MISSING_SUFFIX = "——配方已改?先对齐再派";

/**
 * 派前工作流解释（fail-closed,非法即抛 PaoWorkerError 拒派）：
 * - 普通卡（无标记）返回 undefined,零行为;
 * - v2 卡只信冻结快照：重读控制正本核对 实例/轮次/卡归属/暂停（owner 可选核对）,
 *   冻结配方与控制正本只依赖卡目录,缺 PAO_HOME 也不放过实例校验;
 * - v1 卡按 PAO_HOME 现读活配方,仅核对节点仍在并解析技能（缺 home 维持既有行为整体跳过）。
 */
export function resolveWorkflowDispatch(
	card: ParsedCard,
	input: WorkflowDispatchInput,
): WorkflowDispatchContext | undefined {
	const marker = parseWorkflowMarker(card.body);
	if (!marker) return undefined;
	const versioned = card.body.match(/<!-- pao-workflow-v2:实例=([^/\s]+)\/轮次=(\d+) -->/);
	if (card.body.includes("pao-workflow-v2:") && !versioned)
		throw new PaoWorkerError("无效参数", "工作流 v2 卡身份标记损坏");
	if (versioned) {
		const flow = readControl(loadFrozenRecipe(marker.流, { cardsDir: input.cardsDir }), {
			cardsDir: input.cardsDir,
		});
		if (input.owner !== undefined && flow.owner !== input.owner)
			throw new PaoWorkerError("无效参数", `工作流实例 ${flow.实例} 的 owner 与当前会话不符；拒绝派发`);
		const current = flow.节点.find((node) => node.名字 === marker.节点);
		if (
			flow.实例 !== versioned[1] ||
			current?.轮次 !== Number(versioned[2]) ||
			!current?.卡.includes(formatCardNumber(card.card_no)) ||
			flow.暂停
		)
			throw new PaoWorkerError("无效参数", "工作流 v2 卡不属于当前实例/轮次，或流程已暂停；拒绝按可变配方派发");
		const node = flow.冻结配方.节点.find((candidate) => candidate.名字 === marker.节点);
		if (!node)
			throw new PaoWorkerError(
				"无效参数",
				`工作流「${marker.流}」没有节点「${marker.节点}」（卡 ${card.filename} 标记）${NODE_MISSING_SUFFIX}`,
			);
		return {
			skills: resolveNodeSkills(node, marker.流, marker.节点, input.paoHome),
			upstreamMapRefs: currentDependencyMaps(flow, current.名字, input.cardsDir),
		};
	}
	// v1 卡缺 PAO_HOME 整体跳过节点校验按普通卡放行——T05 定案保留现状（fail-open）。
	// 依据：v1 契约是「卡面自足」（指针铁律,任务定义全在卡上,配方只是模板来源）,而 v1 没有
	// 冻结快照,活配方与技能目录都只存在 <PAO_HOME> 下——缺 PAO_HOME 时既无从核对节点存在性,
	// 也无从解析节点技能,收窄无 可收之物;改 fail-closed 拒派则会让存量 v1 卡在无 PAO_HOME
	// 的派发上下文（自建宿主/直调）里整体不可派,超出整理边界且无安全收益（v1 无实例/轮次/
	// owner 可保护,放行不跳过任何实例校验）。v2 不受此限：冻结配方只依赖卡目录,实例校验
	// 恒 fail-closed,仅技能解析缺 PAO_HOME 时拒绝（见 resolveNodeSkills）。
	if (!input.paoHome) return undefined;
	const recipe = loadRecipe(input.paoHome, marker.流);
	const node = recipe.节点.find((candidate) => candidate.名字 === marker.节点);
	if (!node)
		throw new PaoWorkerError(
			"无效参数",
			`工作流「${marker.流}」没有节点「${marker.节点}」（卡 ${card.filename} 标记）${NODE_MISSING_SUFFIX}`,
		);
	return { skills: resolveNodeSkills(node, marker.流, marker.节点, input.paoHome), upstreamMapRefs: [] };
}
