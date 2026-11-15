/**
 * 工作流配方解析与校验（架构 §11.2）。
 * 定义文件：`<PAO_HOME>/工作流/<名字>.md`（YAML frontmatter + 正文说明），类 skill 可复制可改可分享。
 * 工作流是配方不是任务状态：本模块只做加载/校验/参数代入，运行时真相仍在卡上（§11 定位）。
 * 校验照架构定案：有向无环（自依赖/成环/引用不存在节点一律拒绝加载）；参数占位符启动时必须全部有值。
 */
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { validateCardBudget } from "../cards/cardfile.ts";
import type { CardBudget, CardPriority, CardTier } from "../cards/types.ts";
import { CARD_PRIORITIES, CARD_TIERS } from "../cards/types.ts";

/** 工作流配方结构化错误：code 稳定可判，details 带机器可读上下文（与 PaoCardError 同口径）。 */
export type WorkflowRecipeErrorCode =
	| "RECIPE_NOT_FOUND" // 配方文件不存在
	| "RECIPE_PARSE" // frontmatter 不是合法 YAML 映射
	| "RECIPE_FIELD" // 缺必需字段 / 字段非法
	| "RECIPE_DEP_UNKNOWN" // depends_on 引用了节点表里不存在的节点（未知卡）
	| "RECIPE_DEP_SELF" // 节点依赖自身
	| "RECIPE_CYCLE" // 依赖图成环
	| "RECIPE_PARAM_PLACEHOLDER" // 模板里出现未声明的参数占位符
	| "RECIPE_PARAM_MISSING"; // 启动时声明的参数占位符没有拿到值

export class WorkflowRecipeError extends Error {
	readonly code: WorkflowRecipeErrorCode;
	readonly details: Record<string, unknown>;

	constructor(code: WorkflowRecipeErrorCode, message: string, details: Record<string, unknown> = {}) {
		super(message);
		this.name = "WorkflowRecipeError";
		this.code = code;
		this.details = details;
	}
}

export function isWorkflowRecipeError(error: unknown): error is WorkflowRecipeError {
	return error instanceof WorkflowRecipeError;
}

/** 节点＝卡模板字段 + depends_on + 人工确认标记（§11.1：格子给方向，部门配方给干法）。 */
export interface RecipeNode {
	只读?: boolean;
	工人数量?: number;
	审核?: boolean;
	部门标准?: string;
	允许请求主控裁定?: boolean;
	模型?: string;
	思考强度?: string;
	回边?: { 目标: string; 上限: number; 超限动作: "停滞" | "修完这轮放行" }[];
	名字: string;
	/** 卡模板字段（原样带占位符，启动时代入参数） */
	目标: string;
	部门: string;
	验收: string;
	输入?: string[];
	约束?: string;
	档位?: CardTier;
	预算?: CardBudget;
	优先级?: CardPriority;
	/**
	 * 按需技能（§11.6）：名字对应 <PAO_HOME>/pao配置/skills/ 下条目——平常不挂载,
	 * 派到本节点卡时由派发收口层（resolveDispatchParameters）自动挂载;缺文件拒派（fail-closed）。
	 */
	技能?: string[];
	depends_on: string[];
	/** 人工确认标记：交付后停流等用户点头才放行下游（§11.1 决定 2） */
	人工确认: boolean;
}

export interface WorkflowRecipe {
	/** 画布坐标只影响展示，随配方一起冻结。 */
	ui?: { positions: Record<string, { x: number; y: number }> };
	版本?: 1 | 2;
	名字: string;
	适用?: string;
	/**
	 * 自动执行链（M2-06）：true 时 启流/推流/确认流 走 workflow/auto.ts——
	 * 落卡后自动 派发→回执→越界核查→机械验收→交卷→解锁下游；缺省 false＝手动链不变。
	 */
	自动执行: boolean;
	/** 声明的参数名列表 */
	参数: string[];
	节点: RecipeNode[];
	/** 正文说明（给人读的使用说明，不参与机械执行） */
	说明: string;
	/** 配方文件绝对路径 */
	文件路径: string;
	/** 模板字段里实际出现的占位符（去重保序） */
	占位符: string[];
	/** 拓扑序的节点名字（加载时算好，驱动器直接用） */
	拓扑序: string[];
}

const PLACEHOLDER_PATTERN = /\{([^{}\s]+)\}/g;

/** 收集字符串（或字符串数组）里的参数占位符，去重保序。 */
function collectPlaceholders(value: string | string[] | undefined): string[] {
	const out: string[] = [];
	const scan = (text: string) => {
		for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
			if (!out.includes(match[1])) out.push(match[1]);
		}
	};
	if (typeof value === "string") scan(value);
	if (Array.isArray(value)) for (const item of value) scan(item);
	return out;
}

/** 参数代入：只替换已声明且有值的占位符，其余原样保留（加载时已校验不存在未声明占位符）。 */
export function substituteParams(template: string, params: Record<string, string>): string {
	return template.replace(PLACEHOLDER_PATTERN, (whole, name: string) => params[name] ?? whole);
}

/** $PAO_HOME/工作流/<名字>.md 的落点。paoHome 由调用方解析传入（测试注入 fixture 目录），不硬编码。 */
export function recipePath(paoHome: string, name: string): string {
	return join(paoHome, "工作流", `${name}.md`);
}

/** 列出可用配方名字（文件名去 .md，按名字排序）。目录不存在视为空。 */
export function listRecipes(paoHome: string): string[] {
	const dir = join(paoHome, "工作流");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".md"))
		.map((name) => name.slice(0, -3))
		.sort();
}

/**
 * 配方名口径（与 saveRecipe 落盘校验同款、与卡标记解析兼容）：非空、≤64、无空白、
 * 无路径分隔符/Windows 非法字符、不是点名字。带空格的流名写得出、读不回（标记正则拒空白），
 * 路径分隔符可穿越到工作流目录之外，一律在加载/保存/启动前拒绝。
 */
export function validateRecipeName(name: string): void {
	if (typeof name !== "string" || name === "") {
		throw new WorkflowRecipeError("RECIPE_FIELD", "配方名不能为空", { 名字: name });
	}
	if (name.trim() !== name) {
		throw new WorkflowRecipeError("RECIPE_FIELD", `配方名不能带首尾空白：${JSON.stringify(name)}`, { 名字: name });
	}
	if (/\s/.test(name)) {
		throw new WorkflowRecipeError(
			"RECIPE_FIELD",
			`配方名不能含空白（带空格的流名写得出、读不回）：${JSON.stringify(name)}`,
			{
				名字: name,
			},
		);
	}
	if (name.length > 64) {
		throw new WorkflowRecipeError("RECIPE_FIELD", `配方名过长（≤64）：${name}`, { 名字: name });
	}
	if (/[\\/:*?"<>|]/.test(name) || name === "." || name === "..") {
		throw new WorkflowRecipeError("RECIPE_FIELD", `配方名含非法字符（路径分隔符/:*?"<>|\\）或为点名字：${name}`, {
			名字: name,
		});
	}
}

function requireString(
	raw: Record<string, unknown>,
	key: string,
	where: string,
	problems: string[],
): string | undefined {
	const value = raw[key];
	if (typeof value !== "string" || value.trim() === "") {
		problems.push(`${where} 缺必需字段「${key}」（须为非空字符串）`);
		return undefined;
	}
	return value;
}

function optionalStringArray(
	raw: Record<string, unknown>,
	key: string,
	where: string,
	problems: string[],
): string[] | undefined {
	const value = raw[key];
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		problems.push(`${where} 字段「${key}」须为字符串数组`);
		return undefined;
	}
	return value as string[];
}

/**
 * 解析配方文件内容（字符串）为 WorkflowRecipe，做全量加载校验。
 * 校验失败抛 WorkflowRecipeError；字段类问题尽量一次列全（details.problems）。
 */
export function parseRecipe(content: string, filePath: string): WorkflowRecipe {
	let frontmatter: Record<string, unknown>;
	let description: string;
	try {
		const parsed = parseFrontmatter<Record<string, unknown>>(content);
		frontmatter = parsed.frontmatter;
		description = parsed.body;
	} catch (error) {
		throw new WorkflowRecipeError("RECIPE_PARSE", `配方 frontmatter 不是合法 YAML：${filePath}（${String(error)}）`, {
			filePath,
			cause: String(error),
		});
	}
	if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) {
		throw new WorkflowRecipeError("RECIPE_PARSE", `配方 frontmatter 缺失或不是映射：${filePath}`, { filePath });
	}

	const problems: string[] = [];
	const version = frontmatter.版本 ?? 1;
	if (version !== 1 && version !== 2) problems.push("配方版本仅支持 1 或 2");
	const name = requireString(frontmatter, "名字", "配方", problems);
	if (name !== undefined) {
		try {
			validateRecipeName(name);
		} catch (error) {
			problems.push(error instanceof Error ? error.message : String(error));
		}
		const stem = filePath.split(/[\\/]/).pop()?.replace(/\.md$/, "");
		if (stem !== name) {
			problems.push(`配方「名字」（${name}）与文件名（${stem}.md）不一致，改名须同步改文件名`);
		}
	}
	const applicable = typeof frontmatter.适用 === "string" ? frontmatter.适用 : undefined;
	const autoExecute = frontmatter.自动执行;
	if (autoExecute !== undefined && typeof autoExecute !== "boolean") {
		problems.push("配方字段「自动执行」须为布尔值（true=派发→验收→交卷全自动链；缺省 false 手动）");
	}
	const params = optionalStringArray(frontmatter, "参数", "配方", problems) ?? [];

	const rawNodes = frontmatter.节点;
	if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
		problems.push("配方缺「节点」表（须为非空数组）");
	}
	const nodes: RecipeNode[] = [];
	const seen = new Set<string>();
	for (const [index, rawNode] of Array.isArray(rawNodes) ? rawNodes.entries() : []) {
		// 报错定位带节点名：索引按 frontmatter 顺序 0 基，名字可读时并排给出方便对号；缺/非法名退回纯索引
		const peekName = (rawNode as Record<string, unknown> | null | undefined)?.名字;
		const where =
			typeof peekName === "string" && peekName.trim() ? `节点[${index}]「${peekName.trim()}」` : `节点[${index}]`;
		if (typeof rawNode !== "object" || rawNode === null) {
			problems.push(`${where} 须为映射`);
			continue;
		}
		const node = rawNode as Record<string, unknown>;
		if (
			version === 1 &&
			["工人数量", "审核", "回边", "允许请求主控裁定", "模型", "思考强度", "只读"].some(
				(key) => node[key] !== undefined,
			)
		) {
			problems.push(`${where} 部门节点字段必须显式声明配方版本: 2`);
		}
		const workerCount = node.工人数量 ?? 1;
		if (!Number.isSafeInteger(workerCount) || Number(workerCount) < 1) problems.push(`${where} 工人数量须为正整数`);
		for (const key of ["审核", "允许请求主控裁定", "只读"])
			if (node[key] !== undefined && typeof node[key] !== "boolean") problems.push(`${where} ${key}须为布尔值`);
		for (const key of ["部门标准", "模型", "思考强度"])
			if (node[key] !== undefined && (typeof node[key] !== "string" || !(node[key] as string).trim()))
				problems.push(`${where} ${key}须为非空字符串`);
		if (node.审核 === true && !node.部门标准) problems.push(`${where} 审核节点须给出部门标准`);
		const backEdge: NonNullable<RecipeNode["回边"]> = [];
		if (node.回边 !== undefined && !Array.isArray(node.回边)) problems.push(`${where} 回边须为数组`);
		for (const raw of Array.isArray(node.回边) ? node.回边 : []) {
			if (
				!raw ||
				typeof raw !== "object" ||
				typeof raw.目标 !== "string" ||
				!raw.目标.trim() ||
				!Number.isSafeInteger(raw.上限 ?? 3) ||
				(raw.上限 ?? 3) < 0 ||
				!["停滞", "修完这轮放行"].includes(raw.超限动作 ?? "停滞")
			) {
				problems.push(`${where} 回边须含目标、非负整数上限、有效超限动作`);
				continue;
			}
			backEdge.push({ 目标: raw.目标, 上限: raw.上限 ?? 3, 超限动作: raw.超限动作 ?? "停滞" });
		}
		if (backEdge.length && node.审核 !== true) problems.push(`${where} 仅审核节点可声明回边`);
		if (new Set(backEdge.map((edge) => edge.目标)).size !== backEdge.length) problems.push(`${where} 回边目标重复`);
		const nodeLabel = requireString(node, "名字", where, problems);
		const goal = requireString(node, "目标", where, problems);
		const dept = requireString(node, "部门", where, problems);
		const acceptance = requireString(node, "验收", where, problems);
		if (nodeLabel !== undefined) {
			if (seen.has(nodeLabel)) problems.push(`${where} 名字「${nodeLabel}」重复`);
			seen.add(nodeLabel);
		}
		const input = optionalStringArray(node, "输入", where, problems);
		const skill = optionalStringArray(node, "技能", where, problems);
		const depends_on = optionalStringArray(node, "depends_on", where, problems) ?? [];
		const humanConfirm = node.人工确认;
		if (humanConfirm !== undefined && typeof humanConfirm !== "boolean") {
			problems.push(`${where} 字段「人工确认」须为布尔值`);
		}
		const tier = node.档位;
		if (tier !== undefined && !CARD_TIERS.includes(tier as CardTier)) {
			problems.push(`${where} 档位非法：${String(tier)}（可选 ${CARD_TIERS.join("/")}）`);
		}
		const priority = node.优先级;
		let budget: CardBudget | undefined;
		try {
			budget = validateCardBudget(node.预算);
		} catch (error) {
			problems.push(`${where} ${error instanceof Error ? error.message : String(error)}`);
		}
		if (priority !== undefined && !CARD_PRIORITIES.includes(priority as CardPriority)) {
			problems.push(`${where} 优先级非法：${String(priority)}（可选 ${CARD_PRIORITIES.join("/")}）`);
		}
		if (nodeLabel === undefined || goal === undefined || dept === undefined || acceptance === undefined) continue;
		nodes.push({
			...(version === 2
				? {
						只读: node.只读 === true,
						工人数量: Number(workerCount),
						审核: node.审核 === true,
						部门标准: node.部门标准 as string | undefined,
						允许请求主控裁定: node.允许请求主控裁定 === true,
						模型: node.模型 as string | undefined,
						思考强度: node.思考强度 as string | undefined,
						回边: backEdge,
					}
				: {}),
			名字: nodeLabel,
			目标: goal,
			部门: dept,
			验收: acceptance,
			输入: input,
			约束: typeof node.约束 === "string" ? node.约束 : undefined,
			档位: tier as CardTier | undefined,
			预算: budget,
			优先级: priority as CardPriority | undefined,
			技能: skill,
			depends_on,
			人工确认: humanConfirm === true,
		});
	}
	let ui: WorkflowRecipe["ui"];
	if (frontmatter.ui !== undefined) {
		const rawUi = frontmatter.ui;
		if (!rawUi || typeof rawUi !== "object" || Array.isArray(rawUi)) {
			problems.push("配方 ui 须为映射");
		} else {
			const positions = (rawUi as Record<string, unknown>).positions;
			if (!positions || typeof positions !== "object" || Array.isArray(positions)) {
				problems.push("配方 ui.positions 须为节点坐标映射");
			} else {
				ui = { positions: {} };
				for (const [name, value] of Object.entries(positions)) {
					if (!seen.has(name)) problems.push(`坐标引用未知节点「${name}」`);
					if (!value || typeof value !== "object" || Array.isArray(value)) {
						problems.push(`节点「${name}」坐标须为映射`);
						continue;
					}
					const point = value as Record<string, unknown>;
					if (
						typeof point.x !== "number" ||
						!Number.isFinite(point.x) ||
						typeof point.y !== "number" ||
						!Number.isFinite(point.y)
					) {
						problems.push(`节点「${name}」坐标 x/y 须为有限数`);
						continue;
					}
					Object.defineProperty(ui.positions, name, {
						value: { x: point.x, y: point.y },
						enumerable: true,
						writable: true,
						configurable: true,
					});
				}
			}
		}
	}
	if (problems.length > 0) {
		throw new WorkflowRecipeError(
			"RECIPE_FIELD",
			`配方字段校验失败（${problems.length} 处）：${filePath}；${problems.join("；")}`,
			{
				filePath,
				problems,
			},
		);
	}

	// 依赖引用校验：未知节点（未知卡）与自依赖
	for (const node of nodes) {
		for (const dep of node.depends_on) {
			if (dep === node.名字) {
				throw new WorkflowRecipeError("RECIPE_DEP_SELF", `节点「${node.名字}」依赖自身`, {
					filePath,
					节点: node.名字,
				});
			}
			if (!seen.has(dep)) {
				throw new WorkflowRecipeError(
					"RECIPE_DEP_UNKNOWN",
					`节点「${node.名字}」depends_on 引用了节点表里不存在的「${dep}」`,
					{
						filePath,
						节点: node.名字,
						引用: dep,
					},
				);
			}
		}
	}

	// 环检查（Kahn 拓扑）：删不完 = 成环，拒绝加载（§11.2 只认有向无环）
	const inDegree = new Map<string, number>(nodes.map((node) => [node.名字, 0]));
	const downstream = new Map<string, string[]>(nodes.map((node) => [node.名字, []]));
	for (const node of nodes) {
		for (const dep of node.depends_on) {
			inDegree.set(node.名字, (inDegree.get(node.名字) ?? 0) + 1);
			downstream.get(dep)!.push(node.名字);
		}
	}
	const topoOrder: string[] = [];
	const queue = nodes.filter((node) => inDegree.get(node.名字) === 0).map((node) => node.名字);
	while (queue.length > 0) {
		const current = queue.shift()!;
		topoOrder.push(current);
		for (const next of downstream.get(current)!) {
			const remaining = (inDegree.get(next) ?? 0) - 1;
			inDegree.set(next, remaining);
			if (remaining === 0) queue.push(next);
		}
	}
	if (topoOrder.length !== nodes.length) {
		const cycleNode = nodes.filter((node) => inDegree.get(node.名字)! > 0).map((node) => node.名字);
		throw new WorkflowRecipeError("RECIPE_CYCLE", `工作流依赖成环，拒绝加载：${cycleNode.join(" → ")}`, {
			filePath,
			成环节点: cycleNode,
		});
	}

	// 占位符必须全部已声明：启动时代入才有依据
	for (const node of nodes) {
		const ancestors = new Set<string>();
		const visit = (name: string) => {
			for (const dep of nodes.find((n) => n.名字 === name)!.depends_on) {
				if (!ancestors.has(dep)) {
					ancestors.add(dep);
					visit(dep);
				}
			}
		};
		visit(node.名字);
		for (const edge of node.回边 ?? [])
			if (!ancestors.has(edge.目标))
				throw new WorkflowRecipeError("RECIPE_DEP_UNKNOWN", `回边 ${node.名字}→${edge.目标} 必须指向依赖链上游`);
	}
	const foundPlaceholders: string[] = [];
	const scanNode = (node: RecipeNode) => {
		for (const field of [node.部门, node.模型, node.思考强度, node.部门标准, ...(node.技能 ?? [])])
			for (const found of collectPlaceholders(field))
				if (!foundPlaceholders.includes(found)) foundPlaceholders.push(found);
		for (const found of collectPlaceholders(node.目标))
			if (!foundPlaceholders.includes(found)) foundPlaceholders.push(found);
		for (const found of collectPlaceholders(node.验收))
			if (!foundPlaceholders.includes(found)) foundPlaceholders.push(found);
		if (node.约束)
			for (const found of collectPlaceholders(node.约束))
				if (!foundPlaceholders.includes(found)) foundPlaceholders.push(found);
		if (node.输入)
			for (const item of node.输入)
				for (const found of collectPlaceholders(item))
					if (!foundPlaceholders.includes(found)) foundPlaceholders.push(found);
	};
	for (const node of nodes) scanNode(node);
	const undeclared = foundPlaceholders.filter((name) => !params.includes(name));
	if (undeclared.length > 0) {
		throw new WorkflowRecipeError(
			"RECIPE_PARAM_PLACEHOLDER",
			`配方模板出现未声明的参数占位符：${undeclared.join("、")}（请在 frontmatter「参数」里声明）`,
			{ filePath, 未声明: undeclared, 已声明: params },
		);
	}

	return {
		...(ui ? { ui } : {}),
		版本: version as 1 | 2,
		名字: name!,
		适用: applicable,
		自动执行: autoExecute === true,
		参数: params,
		节点: nodes,
		说明: description,
		文件路径: filePath,
		占位符: foundPlaceholders,
		拓扑序: topoOrder,
	};
}

/** 读配方文件并解析校验。名字非法抛 RECIPE_FIELD（先于拼路径，杜绝穿越），不存在抛 RECIPE_NOT_FOUND，内容坏抛对应结构化错误。 */
export function loadRecipe(paoHome: string, name: string): WorkflowRecipe {
	validateRecipeName(name);
	const path = recipePath(paoHome, name);
	if (!existsSync(path)) {
		const available = listRecipes(paoHome);
		throw new WorkflowRecipeError(
			"RECIPE_NOT_FOUND",
			`找不到工作流配方：${path}${available.length > 0 ? `（可用：${available.join("、")}）` : "（工作流目录为空或不存在）"}`,
			{ paoHome, 名字: name, path, 可用: available },
		);
	}
	return parseRecipe(readFileSync(path, "utf8"), path);
}

/**
 * 删除配方：`<PAO_HOME>/工作流/<名字>.md`。fail-closed：名字先过 校验配方名（与
 * loadRecipe/saveRecipe 同一闸，杜绝路径穿越），不存在抛 RECIPE_NOT_FOUND（不猜、不静默）。
 * 只删 <名字>.md 本体，同名 `.bak-时间戳` 备份一律保留（删错有备份与 git 兜底）。
 */
export function deleteRecipe(paoHome: string, name: string): { 名字: string; 路径: string } {
	validateRecipeName(name);
	const path = recipePath(paoHome, name);
	if (!existsSync(path)) {
		const available = listRecipes(paoHome);
		throw new WorkflowRecipeError(
			"RECIPE_NOT_FOUND",
			`找不到工作流配方，未删除：${path}${available.length > 0 ? `（可用：${available.join("、")}）` : "（工作流目录为空或不存在）"}`,
			{ paoHome, 名字: name, path, 可用: available },
		);
	}
	unlinkSync(path);
	return { 名字: name, 路径: path };
}

/** 启动前参数校验：声明的占位符必须全部有值（§11.2），多给的参数忽略。缺值抛 RECIPE_PARAM_MISSING。 */
export function requireParams(recipe: WorkflowRecipe, params: Record<string, string>): void {
	const missing = recipe.占位符.filter((name) => params[name] === undefined || params[name] === "");
	if (missing.length > 0) {
		throw new WorkflowRecipeError(
			"RECIPE_PARAM_MISSING",
			`工作流「${recipe.名字}」的参数占位符缺值：${missing.join("、")}`,
			{ 工作流: recipe.名字, 缺: missing, 已提供: Object.keys(params) },
		);
	}
}
