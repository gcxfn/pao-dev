import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type DeptCatalog, type DeptCatalogEntry, RECIPE_FILE_NAME, readDeptCatalog } from "./catalog.ts";
import { DEPT_DIR_NAME, type DeptRegistryRow, formatRegistryRow, parseRegistry } from "./registry.ts";

/** 配方「详细干法」段标题:标题前是常驻概要,标题起是 worker 按需读取的正文。 */
export const DEPT_RECIPE_METHOD_HEADING = "## 干法";

export interface RecipeMethodSplit {
	hasMethod: boolean;
	overview: string;
}

/**
 * 按干法标记切分配方纯文本。
 * 有标记时概要只保留标记前内容;无标记时 overview 保留全文,供部长快照兼容旧配方。
 */
export function splitRecipeMethod(recipe: string): RecipeMethodSplit {
	const marker = recipe.indexOf(DEPT_RECIPE_METHOD_HEADING);
	return marker === -1
		? { hasMethod: false, overview: recipe.trimEnd() }
		: { hasMethod: true, overview: recipe.slice(0, marker).trimEnd() };
}

/** 本地时区时间戳,YYYY-MM-DD HH:MM(与 cards/handoff.ts 等同款口径) */
function formatTimestamp(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 配方文件路径:<paoHome>/部门/<名>/配方.md */
function recipePath(deptName: string, paoHome: string): string {
	return join(paoHome, DEPT_DIR_NAME, deptName, RECIPE_FILE_NAME);
}

/** 今天的「截至」日期(本地时区),YYYY-MM-DD */
export function today(): string {
	const now = new Date();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * 注册表行 → 系统提示片段(纯函数,可单测)。
 * 一行一部门(名字/标签/库路径/建部日期),不塞整库;快照带「截至」日期(架构 §6.8)。
 * 注册表为空时渲染空态说明,不报错。
 * 注意:不自包 XML 标签——pi 的 sections 机制会自动把本片段包进 <pao_dept_registry> 同名标签。
 */
export function renderRegistrySnapshot(rows: readonly DeptRegistryRow[], asOf: string): string {
	if (rows.length === 0) {
		return `截至 ${asOf}:部门注册表为空,尚无任何部门。建部用 pao_create_dept 工具;本片段随注册表更新在下次请求自动刷新。`;
	}
	return [
		`截至 ${asOf},部门注册表如下(一行一部门;跨部门协作只走卡;详情经库路径进门面,勿全库扫描):`,
		"",
		"| 名字 | 能力标签 | 库路径 | 建部日期 |",
		"| --- | --- | --- | --- |",
		...rows.map(formatRegistryRow),
	].join("\n");
}

/** 注册表文本 → 提示片段(纯函数) */
export function renderRegistryText(registryText: string, asOf: string): string {
	return renderRegistrySnapshot(parseRegistry(registryText), asOf);
}

/** 一个部门在系统提示里的简介;配方缺失只说明简介读不到,不据此判定派发资格。 */
function renderDeptCatalogEntry(entry: DeptCatalogEntry): string {
	const persona = entry.人设?.trim();
	const description = !entry.配方存在
		? "不可读取（配方缺失或不可读）"
		: persona && !/^<待填(?:[:：>]|$)/.test(persona)
			? persona
			: "未填写";
	const parts = [`${entry.名字}｜职责简介：${description}`];
	if (entry.标签.length > 0) parts.push(`标签：${entry.标签.join("、")}`);
	return `- ${parts.join("｜")}`;
}

/**
 * 部门目录 → 主控系统提示片段(纯函数)。
 *
 * 只从 catalog 取名称、人设和注册表标签;完整配方、工具、技能、知识库都不进常驻提示。
 * 静态目录不能证明任务、预算或权限允许派发,所以这里只陈述简介可读性,不推断派发资格。
 */
export function renderDeptCatalogSnapshot(catalog: DeptCatalog, asOf: string): string {
	const registryFailure = catalog.问题.find(
		(issue) => issue.级别 === "阻止启动" && issue.类别 === "注册表" && issue.部门 === "（注册表）",
	);
	if (registryFailure) {
		return [
			`截至 ${asOf}:部门名单读取失败,不能视为没有已登记部门。`,
			`原因:${registryFailure.问题}`,
			`证据:${registryFailure.证据}`,
		].join("\n");
	}
	if (catalog.部门.length === 0) {
		return `截至 ${asOf}:当前没有已登记部门。`;
	}

	return [`截至 ${asOf},已登记部门如下(按具体任务选择):`, "", ...catalog.部门.map(renderDeptCatalogEntry)].join("\n");
}

/** 读 <paoHome>/部门 并渲染职责简介;注册表不存在是明确空名单,读取失败则明确报错。 */
export function renderRegistryFromHome(paoHome: string, asOf: string = today()): string {
	return renderDeptCatalogSnapshot(readDeptCatalog(paoHome), asOf);
}

/**
 * 部门配方 → 人设快照片段(纯读,不写盘):带「截至 <配方 mtime>」行。
 * 有「## 干法」标记时只常驻概要,并给出配方路径供按需读取;无标记旧配方仍保留全文。
 * M2-01 §1:部长会话启动时渲染进人设,这是 dept 唯一新增渲染面;派卡/中转机械校验永远读最新
 * 配方,快照旧不导致派错。配方文件不存在返回 null——调用方跳过,不报错也不静默假装有。
 * 注意:不自包 XML 标签,与注册表快照同口径。
 */
export function renderRecipeSnapshot(deptName: string, paoHome: string): string | null {
	const path = recipePath(deptName, paoHome);
	if (!existsSync(path)) return null;
	const text = readFileSync(path, "utf8");
	const asOf = formatTimestamp(statSync(path).mtime);
	const split = splitRecipeMethod(text);
	const header = [`截至 ${asOf},部门「${deptName}」配方如下(会话启动时快照;档位合法性等校验永远以最新配方为准):`, ""];
	if (!split.hasMethod) return [...header, split.overview].join("\n");
	return [
		...header,
		split.overview || "没有常驻概要;详细内容均在干法段,需要时按下方路径读取。",
		"",
		`配方文件:${path}`,
		`需要专业细节时，按需读取该文件的「${DEPT_RECIPE_METHOD_HEADING}」段；常驻概要不替代最新配方。`,
	].join("\n");
}

/**
 * 配方指纹:配方文件内容的 sha1(十六进制),配方文件不存在返回 null。
 * 用途(M2-01 §1 热会话感知配方变更):宿主在部长会话启动时登记本指纹;主控派卡命中热会话时
 * 机械比对,不一致仅在工具输出提示「配方已变更,建议重开」——是否重开由主控裁决,
 * 不自动杀会话。本函数只提供指纹;比对逻辑属 S2 宿主。
 */
export function recipeFingerprint(deptName: string, paoHome: string): string | null {
	const path = recipePath(deptName, paoHome);
	if (!existsSync(path)) return null;
	return createHash("sha1").update(readFileSync(path, "utf8"), "utf8").digest("hex");
}
