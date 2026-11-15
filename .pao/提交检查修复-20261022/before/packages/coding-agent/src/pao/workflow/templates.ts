/** 出厂模板单向安装到 PAO_HOME；同名修改只展示差异，不覆盖。 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createTwoFilesPatch } from "diff";
import { validateCardBudget } from "../cards/cardfile.ts";
import type { CardBudget } from "../cards/types.ts";
import { withFileLock } from "../shared/lock.ts";
import { emitRecipeMarkdown } from "./distill.ts";
import { parseRecipe, type RecipeNode, validateRecipeName } from "./recipe.ts";

export interface StarterTemplate {
	id: string;
	name: string;
	description: string;
	content: string;
}
export interface TemplateInstallOptions {
	name?: string;
	budget?: CardBudget;
}
const defaults: CardBudget = { turns: 12, toolCalls: 80 };

export function listStarterTemplates(options: TemplateInstallOptions = {}): StarterTemplate[] {
	const budget = validateCardBudget(options.budget ?? defaults)!;
	return [
		{ id: "bugfix", name: "小bug修复", description: "复现、最小修复、验证、独立审查；失败有理由打回。" },
		{ id: "feature", name: "明确功能开发", description: "按明确目标开发、测试、独立审查；范围外需求交还用户。" },
		{ id: "review", name: "独立代码审查", description: "只读代码与已有证据，给出有 file:line 的判定，不写项目。" },
	].map((item) => {
		const base = (name: string, dept: string, goal: string, depends_on: string[] = []): RecipeNode => ({
			名字: name,
			部门: dept,
			目标: goal,
			验收: "{验收}",
			输入: ["项目：{项目}", "目标：{目标}", "授权范围：{范围}"],
			约束: "只在 {范围} 内工作；保留已有修改。不编造运行与验收成功，缺证据明确报告。",
			工人数量: 1,
			预算: { ...budget },
			档位: "primary",
			depends_on,
			人工确认: false,
		});
		const review: RecipeNode = {
			...base(
				"审查",
				"{审查部门}",
				"独立审查 {目标} 是否满足 {验收}，逐条引用代码或已有证据。",
				item.id === "review" ? [] : ["测试"],
			),
			只读: true,
			审核: true,
			部门标准: "忠于目标与范围；检查正确性、可维护性与已有运行证据。缺运行证据必须写明未验证运行。",
			允许请求主控裁定: true,
			回边: item.id === "review" ? [] : [{ 目标: "开发", 上限: 3, 超限动作: "停滞" }],
		};
		const nodes =
			item.id === "review"
				? [review]
				: [
						base(
							"开发",
							"{执行部门}",
							item.id === "bugfix"
								? "复现 {目标}，定位原因并在 {范围} 内最小修复。"
								: "实现已明确的 {目标}，严格控制 {范围}。",
						),
						base("测试", "{测试部门}", "针对 {目标} 执行 {验收}，记录可复现命令与实际结果。", ["开发"]),
						review,
					];
		const content = emitRecipeMarkdown({
			版本: 2,
			名字: options.name ?? item.name,
			自动执行: true,
			参数: ["项目", "目标", "范围", "验收", ...(item.id === "review" ? [] : ["执行部门", "测试部门"]), "审查部门"],
			节点: nodes,
			说明: `${item.description}\n\n安装后可在使用现场编辑；不会自动同步回出厂模板。启动前填写项目、目标、范围、验收和已登记部门，核对每节点预算对象、模型、思考档及所需技能。默认每卡 12 轮/80 次工具调用，不是费用授权；卡数在拆解前未知，整体请求仍受宿主可信额度约束。缺部门或技能须先处理预检，不自动创建。审查节点只读且不能交工人卡；零卡结束须说明理由。`,
		});
		parseRecipe(content, `${options.name ?? item.name}.md`);
		return { ...item, name: options.name ?? item.name, content };
	});
}

export function inspectTemplateInstall(home: string, id: string, options: TemplateInstallOptions = {}) {
	const template = listStarterTemplates(options).find((item) => item.id === id);
	if (!template) throw new Error(`未知模板：${id}`);
	validateRecipeName(template.name);
	const path = join(home, "工作流", `${template.name}.md`);
	const existing = existsSync(path) ? readFileSync(path, "utf8") : undefined;
	const status = existing === undefined ? "可安装" : existing === template.content ? "已安装" : "保留用户版本";
	return {
		...template,
		path,
		status,
		diff:
			existing !== undefined && existing !== template.content
				? createTwoFilesPatch("当前已安装", "出厂模板", existing, template.content)
				: "",
	};
}

export async function installStarterTemplate(home: string, id: string, options: TemplateInstallOptions = {}) {
	const initial = inspectTemplateInstall(home, id, options);
	mkdirSync(dirname(initial.path), { recursive: true });
	return withFileLock(initial.path, async () => {
		const current = inspectTemplateInstall(home, id, options);
		if (current.status !== "可安装") return current;
		writeFileSync(current.path, current.content, { encoding: "utf8", flag: "wx" });
		return { ...current, status: "已安装" };
	});
}
