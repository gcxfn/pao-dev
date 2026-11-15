/** 工作流编辑器的只读目录、版本与启动预检；写入由原 owner 命令完成。 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRegistry } from "../dept/registry.ts";
import { checkPreflight } from "../preflight/index.ts";
import { loadTierConfig, THINKING_LEVELS, TIER_CONFIG_RELATIVE_PATH } from "../routing/config.ts";
import { emitRecipeMarkdown } from "../workflow/distill.ts";
import {
	parseRecipe,
	recipePath,
	substituteParams,
	validateRecipeName,
	type WorkflowRecipe,
} from "../workflow/recipe.ts";
import { listStarterTemplates } from "../workflow/templates.ts";
import { readDesktopPendingFresh } from "./read-model.ts";

export function recipeRevision(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

export function readDesktopRecipeCatalog(paoHome: string) {
	const errors: string[] = [];
	const recipes: { recipe: WorkflowRecipe; revision: string; content: string }[] = [];
	const dir = join(paoHome, "工作流");
	if (existsSync(dir))
		for (const entry of readdirSync(dir, { withFileTypes: true }).filter(
			(entry) => entry.isFile() && entry.name.endsWith(".md"),
		)) {
			const path = join(dir, entry.name);
			try {
				const content = readFileSync(path, "utf8");
				recipes.push({ recipe: parseRecipe(content, path), revision: recipeRevision(content), content });
			} catch (error) {
				errors.push(`${path}: ${String(error)}`);
			}
		}
	let departments: string[] = [];
	try {
		departments = parseRegistry(readFileSync(join(paoHome, "部门", "注册表.md"), "utf8")).map((row) => row.名字);
	} catch (error) {
		errors.push(`部门目录: ${String(error)}`);
	}
	let skills: string[] = [];
	try {
		skills = readdirSync(join(paoHome, "pao配置", "skills"), { withFileTypes: true })
			.filter(
				(entry) => entry.isDirectory() && existsSync(join(paoHome, "pao配置", "skills", entry.name, "SKILL.md")),
			)
			.map((entry) => entry.name);
	} catch (error) {
		errors.push(`技能目录: ${String(error)}`);
	}
	let tiers: { 名: string; provider: string; model: string; thinkingLevel: string }[] = [];
	try {
		tiers = loadTierConfig(join(paoHome, TIER_CONFIG_RELATIVE_PATH)).档位;
	} catch (error) {
		errors.push(`档位配置: ${String(error)}`);
	}
	return {
		recipes,
		departments,
		skills,
		tiers,
		thinkingLevels: THINKING_LEVELS,
		templates: listStarterTemplates(),
		errors,
	};
}

export function renderDesktopRecipe(paoHome: string, recipe: WorkflowRecipe): string {
	validateRecipeName(recipe.名字);
	const text = emitRecipeMarkdown(recipe);
	parseRecipe(text, recipePath(paoHome, recipe.名字));
	return text;
}

export async function checkDesktopRecipeEdit(
	paoHome: string,
	project: string,
	recipe: WorkflowRecipe,
	revision: string | null,
): Promise<string> {
	const text = renderDesktopRecipe(paoHome, recipe);
	const path = recipePath(paoHome, recipe.名字);
	const currentRevision = existsSync(path) ? recipeRevision(readFileSync(path, "utf8")) : null;
	if (currentRevision !== revision) throw new Error("配方已被其他入口修改；请重新读取或另存，不能覆盖新版本。");
	const pending = await readDesktopPendingFresh(paoHome, project);
	if (
		pending.issues.length ||
		pending.projects.some((item) => item.issues.some((issue) => issue.路径.includes("工作流实例-")))
	)
		throw new Error("存在不可读项目/控制清单，无法核实运行图冻结；请先处理读取问题。");
	if (
		pending.projects.some((item) =>
			item.workflow.some((entry) => entry.控制.工作流 === recipe.名字 && entry.进度.状态 === "运行中"),
		)
	)
		throw new Error("该配方有运行中的冻结实例；先暂停，再编辑配方并显式创建新实例。");
	return text;
}

/**
 * 删除前守卫：与 checkDesktopRecipeEdit 同一拒绝模式（版本漂移/清单不可读/运行中实例），
 * 只做核对不删文件。删除本体复用 workflow/recipe.ts 的 deleteRecipe（只删 <名字>.md，
 * 同名 .bak 备份与实例冻结图不受影响）。
 */
export async function checkDesktopRecipeDelete(
	paoHome: string,
	project: string,
	name: string,
	revision: string | null,
): Promise<void> {
	validateRecipeName(name);
	const path = recipePath(paoHome, name);
	if (revision !== null && existsSync(path) && recipeRevision(readFileSync(path, "utf8")) !== revision)
		throw new Error("配方已被其他入口修改；请刷新目录后重试，不能删除新版本。");
	const pending = await readDesktopPendingFresh(paoHome, project);
	if (
		pending.issues.length ||
		pending.projects.some((item) => item.issues.some((issue) => issue.路径.includes("工作流实例-")))
	)
		throw new Error("存在不可读项目/控制清单，无法核实运行图冻结；请先处理读取问题。");
	if (
		pending.projects.some((item) =>
			item.workflow.some((entry) => entry.控制.工作流 === name && entry.进度.状态 === "运行中"),
		)
	)
		throw new Error("该配方有运行中的冻结实例；先暂停，再删除配方。");
}

export function previewDesktopWorkflow(
	paoHome: string,
	project: string,
	recipe: WorkflowRecipe,
	parameters: Record<string, string>,
) {
	const parsed = parseRecipe(renderDesktopRecipe(paoHome, recipe), recipePath(paoHome, recipe.名字));
	const nodes = parsed.节点.map((node) => ({
		...node,
		部门: substituteParams(node.部门, parameters),
		技能: node.技能?.map((skill) => substituteParams(skill, parameters)),
		模型: node.模型 === undefined ? undefined : substituteParams(node.模型, parameters),
		档位: node.档位 === undefined ? undefined : substituteParams(node.档位, parameters),
		思考强度: node.思考强度 === undefined ? undefined : substituteParams(node.思考强度, parameters),
	}));
	const report = checkPreflight({
		project,
		paoHome,
		parameters,
		requiredParameters: parsed.参数,
		departments: nodes.map((node) => node.部门),
		skills: [...new Set(nodes.flatMap((node) => node.技能 ?? []))],
	});
	const nodeChecks = nodes.map((node) =>
		checkPreflight({ project, paoHome, tier: node.模型 ?? node.档位, budget: node.预算 }),
	);
	for (const check of nodeChecks) report.items.push(...check.items.filter((item) => /档位|预算/.test(item.subject)));
	for (const node of nodes)
		if (node.思考强度 && !THINKING_LEVELS.includes(node.思考强度 as (typeof THINKING_LEVELS)[number]))
			report.items.push({
				level: "阻止启动",
				subject: "思考强度",
				reason: `${node.名字}: ${node.思考强度}`,
				suggestion: "选择有效思考强度",
			});
	report.canStart =
		report.items.every((item) => item.level !== "阻止启动") && nodeChecks.every((check) => check.canStart);
	const budgets = parsed.节点.map((node) => node.预算);
	return {
		report,
		节点数: parsed.节点.length,
		节点: nodes.map((node) => ({
			名字: node.名字,
			部门: node.部门,
			工人上限: node.工人数量 ?? 1,
			模型: node.模型 ?? node.档位 ?? "部门默认",
			思考强度: node.思考强度 ?? "档位默认",
			技能: node.技能 ?? [],
		})),
		预算: {
			cost: budgets.every((budget) => budget?.cost !== undefined)
				? budgets.reduce((sum, budget) => sum + budget!.cost!, 0)
				: null,
			turns: budgets.every((budget) => budget?.turns !== undefined)
				? budgets.reduce((sum, budget) => sum + budget!.turns!, 0)
				: null,
			说明: "仅显式节点预算合计；主控、拆卡结果和缺省额度可能另计，未知不填零。",
		},
		将落卡数: "待部长拆解，尚无法估算",
	};
}
