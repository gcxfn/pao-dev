/**
 * 桌面「部门」只读投影:部门目录(总览/选择器)＋单部门详情(职责/边界·可用技能·默认档位·标准·
 * 知识入口·配置问题·负载),供桌面渲染;计划 §5.1 表与 §5.2 第 1、2、3 条。
 *
 * 纪律:
 * - **部门名单与校验只有一份**:全部来自 dept 模块的 `readDeptCatalog`(问题集已由其内部
 *   `validateDeptCatalog` 算好并随条目同批返回)。本模块不解析配方、不重跑校验,只做四件事:
 *   ① 会话与越界防护;② 默认档位落到 档位.json 解析出的模型/思考强度;③ 负载数字;
 *   ④ 按需正文只给「路径 + 是否可读 + 大小/行数」,不复制正文。
 * - **只读**:不写盘、不建目录、不取锁、不触发模型、不起进程;每次调用现读,不缓存。
 * - **越界抛错**:要返回的路径必须落在 PAO_HOME 或项目根之内(先 realpath 再判),越界直接抛错、
 *   不静默返回空——界面上的「没有」与「不让读」是两回事。
 * - **旧无效值原样保留**:档位查无此档、技能目录不存在、标准定位不到,都如实标记并给修法,
 *   不过滤成空列表(计划 §5.2 第 2 条)。
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { redactContext } from "../context/index.ts";
import {
	type DeptCatalog,
	type DeptCatalogEntry,
	type DeptCatalogIssue,
	type DeptRoleGlossaryRow,
	type DeptSkillRef,
	type DeptStandardRef,
	readDeptCatalog,
	工具技能人设区别,
} from "../dept/catalog.ts";
import { DEPT_DIR_NAME, REGISTRY_FILE_NAME } from "../dept/registry.ts";
import type { MinisterHandle } from "../host/handle.ts";
import {
	loadTierConfig,
	resolvePaoHome,
	resolveTierConfigPath,
	type TierConfig,
	type TierDefinition,
} from "../routing/config.ts";
import { desktopOwner } from "./owners.ts";
import { type DesktopReadIssue, readDesktopProjectFresh } from "./read-model.ts";
import type { DesktopFlow } from "./workflow.ts";

/** 投影选项:PAO_HOME 缺省取环境变量(与其它读桥一致,不猜路径) */
export interface DesktopDeptViewOptions {
	paoHome?: string;
}

/** 职责摘要保留的最大字符数:只够总览与选择器,全文仍在配方文件里 */
export const DEPT_SUMMARY_LIMIT = 80;

/** 负载:卡数与热部长、挂起节点都与既有投影同源,不新算一套 */
export interface DesktopDeptLoad {
	/** 本部门在役卡数(status 非 delivered/canceled) */
	活卡数: number;
	/** 本部门卡片总数(不含归档) */
	卡片总数: number;
	/** 本部门在本进程内的热部长数(按部门名＋项目根匹配;本进程外会话不在内,不造心跳) */
	热部长数: number;
	/** 本部门所涉工作流实例里挂起的节点数(controlView 的挂起文案非空即挂起) */
	挂起节点数: number;
	/** 已归档的历史卡数(<项目根>/.pao/归档 下按部门名命名的卡) */
	归档卡数: number;
	/** 卡片与挂起节点的读取问题(不拖其他段) */
	读取问题: DesktopReadIssue[];
}

/** 默认档位落到真实模型:查无此档不猜,provider/model/thinkingLevel 一律 null 并给原因 */
export interface DesktopDeptTier {
	/** 派发时的生效档名(配方→档位.json 部门默认→主力,见 dept/catalog) */
	生效: string;
	/** 档名来源 */
	来源: "配方" | "档位.json 部门默认" | "缺省兜底";
	/** 档位.json 的虚拟 provider 原值;配置不可读时为 null */
	provider: string | null;
	/** 该档的物理模型名(不含 provider);未配置/查无此档为 null */
	model: string | null;
	/** 该档推荐的思考强度;未配置/查无此档为 null */
	thinkingLevel: string | null;
	/** 为什么没解析出模型;解析成功时 undefined */
	未配置原因?: string;
}

/** 一处标准引用:只定位真实文件,不复制正文 */
export interface DesktopDeptStandard {
	/** 配方里的原始写法 */
	原始: string;
	/** 解析出的真实文件;部门内小节引用为 null */
	文件: string | null;
	/** 文件存在且可读(部门内小节引用为:配方可读且该小节标题存在) */
	可读: boolean;
}

/** 一个技能引用:目录与 SKILL.md 的真实位置与可用性 */
export interface DesktopDeptSkillView {
	/** 配方里写的引用名(原样;坏值也保留) */
	引用: string;
	/** 真实目录(<PAO_HOME>/pao配置/skills/<引用>) */
	目录: string;
	/** SKILL.md 真实路径 */
	skillFile: string;
	目录存在: boolean;
	/** SKILL.md 存在且非空＝派发真能装载 */
	可用: boolean;
	/** 来自建部模板的占位文字(不是真引用) */
	占位符: boolean;
}

/** 按需正文的可读性:只回「能不能读、多大、多少行」,不回正文 */
export interface DesktopDeptSourceRef {
	/** 真实路径(已判定在 PAO_HOME 或项目根之内) */
	路径: string;
	/** 相对 PAO_HOME 的写法(便于界面显示短路径;不在 PAO_HOME 内时为 null) */
	相对路径: string | null;
	可读: boolean;
	/** 字节数;不可读时为 null */
	字节: number | null;
	/** 行数;不可读时为 null */
	行数: number | null;
}

/** 单部门详情(计划 §5.2 第 1 条七段:职责/技能/档位/标准/知识入口/配置问题/负载) */
export interface DesktopDeptDetail {
	版本: 1;
	session: string;
	project: string;
	paoHome: string;
	读取时间: string;
	/** 注册表里的真实名字(＝部门目录名) */
	名字: string;
	/** 注册表能力标签 */
	标签: string[];
	/** 知识库路径(相对 PAO_HOME) */
	库路径: string;
	建部日期?: string;
	/** 部门目录、配方、知识库门面的真实路径 */
	路径: { 部门目录: string; 配方: string; 知识库: string };
	/** 职责/边界/口吻:人设原文＋出处(真实文件路径);未写时原文为空串 */
	职责: {
		/** 配方「人设」行的原文;未写时为空串 */
		原文: string;
		/** 原文所在真实文件;配方不可读时为 null */
		出处: string | null;
		/** 原文是否还是建部模板的「<待填…>」占位 */
		待填: boolean;
	};
	/** 工具白名单:派发时的内置工具名(表外名原样保留并标非内置) */
	工具: {
		/** 「工具」行原值;未写时为 null */
		原值: string | null;
		白名单: { 名字: string; 内置: boolean }[];
		/** 旧配方把技能名混写在「工具」行时的疑似技能名(供提示拆分) */
		混写技能名: string[];
	};
	/** 技能列表:每个技能的真实目录＋SKILL.md 是否存在 */
	技能: DesktopDeptSkillView[];
	/** 默认档位(落到 档位.json 的 provider/model/thinkingLevel) */
	默认档位: DesktopDeptTier;
	/** 配方声明的标准(只给真实文件位置) */
	标准: DesktopDeptStandard[];
	/** 知识入口(门面索引)＋干法段(详细步骤按需读原文件) */
	知识入口: { 索引: DesktopDeptSourceRef; 干法: DesktopDeptSourceRef | null };
	/** 本部门的配置问题:每项带级别/类别/问题/修法/证据路径(集中校验结果) */
	配置问题: DeptCatalogIssue[];
	/** 负载:与本进程热部长、卡快照、控制清单同源 */
	负载: DesktopDeptLoad;
	/** 读到但这部分没读到时的如实说明(不拖其他段) */
	读取问题: DesktopReadIssue[];
}

/** 目录里一个部门的摘要行(总览与选择器用;不塞配方全文) */
export interface DesktopDeptCatalogRow {
	名字: string;
	标签: string[];
	/** 生效档名(卡面未指定档位时) */
	默认档位: string;
	/** 该档解析出的 provider/model;未配置/查无此档为 null */
	模型: string | null;
	/** 职责摘要(人设首句,至多 DEPT_SUMMARY_LIMIT 字;未写时为空串) */
	职责摘要: string;
	技能数: number;
	工具数: number;
	/** 问题总数(集中校验结果里属于本部门的项) */
	问题数: number;
	/** 阻止启动问题数(>0 表示该部门派发必失败) */
	阻止启动数: number;
	/** 知识入口路径(门面索引) */
	知识入口: string;
	配方路径: string;
	/** 能不能选来派发;不能时原因见「不可用原因」 */
	可用: boolean;
	不可用原因?: string;
}

/** 全量部门目录(唯一名单来自 <PAO_HOME>/部门/注册表.md,前端不得硬编码) */
export interface DesktopDeptCatalog {
	版本: 1;
	session: string;
	project: string;
	paoHome: string;
	读取时间: string;
	/** 部门注册表真实路径 */
	注册表路径: string;
	/** 按注册表顺序 */
	部门: DesktopDeptCatalogRow[];
	/** 全部配置问题(含注册表级、档位级;部门级问题按「部门」字段过滤) */
	问题: DeptCatalogIssue[];
	/** 「工具/技能/人设」三种东西的区别:正本在 dept/catalog,桌面只透传渲染 */
	工具技能人设区别: DeptRoleGlossaryRow[];
}

// ── 越界与可读性 ───────────────────────────────────────────────────────────

/** 路径是否落在 root 之内(同 read-model 口径) */
function inside(root: string, path: string): boolean {
	const delta = relative(root, path);
	return delta === "" || (!delta.startsWith(`..${sep}`) && delta !== ".." && !isAbsolute(delta));
}

/** 真实路径优先(存在即 realpath),不存在退回 resolve 归一——两种形态都要能判越界 */
function canonical(path: string): string {
	const resolved = resolve(path);
	try {
		return realpathSync(resolved);
	} catch {
		return resolved;
	}
}

/**
 * 越界防护:路径必须落在 root 之内,否则抛错。
 * 不静默返回空——界面上的「没有」与「不让读」是两回事。
 */
function guardPath(root: string, path: string, what: string): string {
	const target = canonical(path);
	if (inside(canonical(root), target)) return target;
	throw new Error(`${what}越出 PAO_HOME 或项目根(${root}):${target};拒绝读取,不返回空值掩盖`);
}

/** 按需正文的元信息:只告诉界面「能不能读、多大、多少行」,正文按需另读 */
function sourceRef(root: string, path: string, what: string): DesktopDeptSourceRef {
	const real = guardPath(root, path, what);
	const base = canonical(root);
	const 相对路径 = inside(base, real) ? relative(base, real) : null;
	try {
		if (!statSync(real).isFile()) return { 路径: real, 相对路径, 可读: false, 字节: null, 行数: null };
		const text = readFileSync(real, "utf8");
		return {
			路径: real,
			相对路径,
			可读: true,
			字节: statSync(real).size,
			行数: text === "" ? 0 : text.split(/\r?\n/).length,
		};
	} catch {
		return { 路径: real, 相对路径, 可读: false, 字节: null, 行数: null };
	}
}

// ── 档位 ───────────────────────────────────────────────────────────────────

/** 档名别名归一(与 routing/config 的 TIER_ALIASES 同表:存量中文档名与新英文写法两侧都认) */
const TIER_ALIASES: Record<string, string> = { fast: "快", primary: "主力" };

type TierRead = { ok: true; config: TierConfig } | { ok: false; 原因: string };

/** 读 档位.json:缺失或非法都标成「未配置」并说清原因,不猜主控档位 */
function readTiers(paoHome: string): TierRead {
	const configPath = resolveTierConfigPath(paoHome);
	if (!existsSync(configPath)) return { ok: false, 原因: `档位配置不存在:${configPath}` };
	try {
		return { ok: true, config: loadTierConfig(configPath) };
	} catch (error) {
		return { ok: false, 原因: error instanceof Error ? error.message : String(error) };
	}
}

function tierByName(config: TierConfig, name: string): TierDefinition | undefined {
	const wanted = TIER_ALIASES[name] ?? name;
	return config.档位.find((tier) => (TIER_ALIASES[tier.名] ?? tier.名) === wanted);
}

/**
 * 默认档位 → 真实模型。生效档名来自 dept/catalog 的解析(配方→档位.json 部门默认→主力),
 * 本函数只负责「这个档名对应哪个模型」;查无此档时如实标未配置并列出可用档名。
 */
function resolveDeptTier(entry: DeptCatalogEntry, tiers: TierRead): DesktopDeptTier {
	const resolution = entry.默认档位 ?? { 生效: "主力", 来源: "缺省兜底" as const };
	const base = { 生效: resolution.生效, 来源: resolution.来源 };
	if (!tiers.ok) return { ...base, provider: null, model: null, thinkingLevel: null, 未配置原因: tiers.原因 };
	const tier = tierByName(tiers.config, resolution.生效);
	if (!tier) {
		return {
			...base,
			provider: null,
			model: null,
			thinkingLevel: null,
			未配置原因: `档位「${resolution.生效}」(来源:${resolution.来源})在档位.json 中不存在;现有档名:${
				tiers.config.档位.map((item) => item.名).join("、") || "(空)"
			}`,
		};
	}
	return { ...base, provider: tiers.config.provider, model: tier.model, thinkingLevel: tier.thinkingLevel };
}

// ── 负载 ───────────────────────────────────────────────────────────────────

/** 归档卡文件名约定:<卡号>-<部门>-<说明>.md;解析不出部门时不计入任何部门(不猜) */
function archivedDeptOf(fileName: string): string | undefined {
	const match = fileName.replace(/\.md$/i, "").match(/^卡\d+-(.+)$/);
	return match?.[1]?.split("-")[0]?.trim() || undefined;
}

/** 归档目录候选(<项目根>/.pao 及其下一层目录下的「归档」),只在项目根内 */
function archiveDirectories(project: string): string[] {
	const base = join(project, ".pao");
	const candidates = [join(base, "归档")];
	try {
		for (const entry of readdirSync(base, { withFileTypes: true })) {
			if (entry.isDirectory()) candidates.push(join(base, entry.name, "归档"));
		}
	} catch {
		// 没有 .pao＝这个项目还没跑过,不算读失败
	}
	return candidates;
}

function countArchived(project: string, name: string, issues: DesktopReadIssue[]): number {
	let count = 0;
	for (const directory of archiveDirectories(project)) {
		if (!existsSync(directory)) continue;
		try {
			for (const file of readdirSync(guardPath(project, directory, "归档目录"))) {
				if (file.endsWith(".md") && archivedDeptOf(file) === name) count += 1;
			}
		} catch (error) {
			issues.push({ 路径: directory, 说明: String(error) });
		}
	}
	return count;
}

/**
 * 挂起节点数:控制清单(工作流实例)的节点状态直接取当前内容树核对后的进度视图,
 * 不重读实例文件、不另算一套。归属按冻结配方的 节点.部门(历史实例不被当前配方改写)。
 */
function hungNodesOf(flow: DesktopFlow, name: string): number {
	const owned = new Set(flow.控制.冻结配方.节点.filter((node) => node.部门 === name).map((node) => node.名字));
	return flow.进度.节点.filter((node) => owned.has(node.名字) && node.挂起 !== undefined).length;
}

/** 负载:卡片与挂起节点全部来自 readDesktopProjectFresh 的同一次快照,数字与卡目录逐一对得上 */
async function readLoad(
	scope: { project: string; sessionId: string; hotMinistersOf: (name: string) => number },
	name: string,
): Promise<DesktopDeptLoad> {
	const snapshot = await readDesktopProjectFresh(scope.project, scope.sessionId);
	const cards = snapshot.cards.filter((card) => card.frontmatter.dept === name);
	const issues: DesktopReadIssue[] = [...snapshot.issues];
	return {
		活卡数: cards.filter((card) => card.frontmatter.status !== "delivered" && card.frontmatter.status !== "canceled")
			.length,
		卡片总数: cards.length,
		热部长数: scope.hotMinistersOf(name),
		挂起节点数: snapshot.workflow.reduce((sum, flow) => sum + hungNodesOf(flow, name), 0),
		归档卡数: countArchived(snapshot.projectRoot, name, issues),
		读取问题: issues,
	};
}

// ── 会话与上下文 ───────────────────────────────────────────────────────────

interface DeptScope {
	sessionId: string;
	/** 校验通过的会话项目(原样透传给 owner 判定,之后才 realpath 归一) */
	project: string;
	paoHome: string;
	catalog: DeptCatalog;
	issuesOf: (name: string) => DeptCatalogIssue[];
	hotMinistersOf: (name: string) => number;
}

/** 热部长按部门名＋项目根匹配:项目根两边都 realpath 归一,符号链接写法不同也算同一个项目 */
function rootMatcher(root: string): (path: string) => boolean {
	return (path: string) => {
		try {
			return canonical(path) === root;
		} catch {
			return false;
		}
	};
}

/**
 * 登记条目的全部真实路径都要落在 PAO_HOME 内——目录面与详情面共用这一处，
 * 避免「目录里给出一个点得动却越界的路径」这种自相矛盾(计划 §5.1:路径必须真实可定位)。
 * 注册表的「库路径」是唯一能从外部写进 PAO_HOME 之外的入口(部门目录/配方都由 join(paoHome, …) 得来)，
 * 技能目录与标准文件也可能被配方写坏成 ../../;缺失不算错，越界直接抛。
 */
function guardEntry(paoHome: string, entry: DeptCatalogEntry): void {
	guardPath(paoHome, entry.部门目录, `部门「${entry.名字}」目录`);
	guardPath(paoHome, entry.配方路径, `部门「${entry.名字}」配方`);
	guardPath(paoHome, join(paoHome, entry.库路径), `部门「${entry.名字}」知识库`);
	guardPath(paoHome, entry.知识库索引.路径, `部门「${entry.名字}」知识入口`);
	for (const skill of entry.技能) {
		if (skill.目录存在) guardPath(paoHome, skill.路径, `技能「${skill.引用}」目录`);
	}
	for (const standard of entry.标准) {
		if (standard.文件 && standard.可读) guardPath(paoHome, standard.文件, `标准「${standard.原始}」文件`);
	}
}

/**
 * 会话校验＋PAO_HOME 解析＋部门目录取一次。
 * 会话与项目任一不符即由 desktopOwner 抛错(既有口径:不返回别人的数据);
 * 注意 project 原样交给 desktopOwner(它对字符串严格比较),之后才 realpath 归一。
 */
function openScope(sessionId: string, project: string, options: DesktopDeptViewOptions): DeptScope {
	const current = desktopOwner(sessionId, project);
	const paoHome = canonical(options.paoHome ?? resolvePaoHome());
	const catalog = readDeptCatalog(paoHome);
	// 注册表与每个部门的全部真实路径都必须落在 PAO_HOME 内(防注册表/配方被写成 ../ 逃逸)
	guardPath(paoHome, catalog.注册表路径, "部门注册表");
	for (const entry of catalog.部门) guardEntry(paoHome, entry);
	const sameRoot = rootMatcher(canonical(project));
	const ministers: MinisterHandle[] = current.getMinisters();
	return {
		sessionId,
		project,
		paoHome,
		catalog,
		// 问题集是 readDeptCatalog 内部集中校验的结果(唯一来源),这里只按部门过滤
		issuesOf: (name) => catalog.问题.filter((issue) => issue.部门 === name),
		hotMinistersOf: (name) =>
			ministers.filter((minister) => minister.部门 === name && sameRoot(minister.项目根)).length,
	};
}

/** 职责摘要:人设首句,去占位标记后截断;没写人设就是空串(界面显示「未配置」) */
function summaryOf(人设: string | undefined): string {
	const text = (人设 ?? "").trim();
	if (!text || text.includes("待填")) return "";
	const first = text.split(/[。;；!！?？\n]/)[0]?.trim() || text;
	return first.length > DEPT_SUMMARY_LIMIT ? `${first.slice(0, DEPT_SUMMARY_LIMIT)}…` : first;
}

/** 部门能否被选来派发:配方缺失、档位查无此档、有阻止启动问题都算不可用(原因直说) */
function availability(
	entry: DeptCatalogEntry,
	tier: DesktopDeptTier,
	issues: DeptCatalogIssue[],
): { 可用: boolean; 不可用原因?: string } {
	if (!entry.配方存在) return { 可用: false, 不可用原因: `配方不可读:${entry.配方路径}` };
	if (tier.model === null) return { 可用: false, 不可用原因: tier.未配置原因 ?? "默认档位未解析出模型" };
	const blocking = issues.find((issue) => issue.级别 === "阻止启动");
	if (blocking) return { 可用: false, 不可用原因: `${blocking.类别}:${blocking.问题}` };
	return { 可用: true };
}

function skillView(skill: DeptSkillRef): DesktopDeptSkillView {
	return {
		引用: skill.引用,
		目录: skill.路径,
		skillFile: skill.skillFile,
		目录存在: skill.目录存在,
		可用: skill.可用,
		占位符: skill.占位符 === true,
	};
}

function standardView(standard: DeptStandardRef): DesktopDeptStandard {
	return { 原始: standard.原始, 文件: standard.文件 ?? null, 可读: standard.可读 };
}

// ── 对外投影 ───────────────────────────────────────────────────────────────

/**
 * 全量部门目录(总览与选择器)。唯一名单与校验来自 dept/catalog;
 * 这里只补「档位落到真实模型」「职责摘要」「能不能选」,并做会话与越界防护。
 *
 * 问题归属规则(与 dept/catalog 的集中校验一致,勿「修正」):
 * `DeptCatalogIssue.部门` 可能是「（注册表）」「（档位）」这类非部门名的占位——
 * 注册表本身与 档位.json 的问题本来就不属于某个部门,这类条目**只出现在
 * `DesktopDeptCatalog.问题` 总表里,不摊到任何部门行**;部门行的 问题数/阻止启动数
 * 只统计 部门 字段等于该部门名的条目(见 openScope 的 issuesOf)。
 */
export function readDesktopDeptCatalog(
	sessionId: string,
	project: string,
	options: DesktopDeptViewOptions = {},
): DesktopDeptCatalog {
	const scope = openScope(sessionId, project, options);
	const tiers = readTiers(scope.paoHome);
	const 部门 = scope.catalog.部门.map((entry): DesktopDeptCatalogRow => {
		const issues = scope.issuesOf(entry.名字);
		const tier = resolveDeptTier(entry, tiers);
		const { 可用, 不可用原因 } = availability(entry, tier, issues);
		return {
			名字: entry.名字,
			标签: [...entry.标签],
			默认档位: tier.生效,
			模型: tier.provider && tier.model ? `${tier.provider}/${tier.model}` : null,
			职责摘要: summaryOf(entry.人设),
			技能数: entry.技能.length,
			工具数: entry.工具.length,
			问题数: issues.length,
			阻止启动数: issues.filter((issue) => issue.级别 === "阻止启动").length,
			知识入口: entry.知识库索引.路径,
			配方路径: entry.配方路径,
			可用,
			...(不可用原因 !== undefined ? { 不可用原因 } : {}),
		};
	});
	return redactContext({
		版本: 1 as const,
		session: sessionId,
		project: scope.project,
		paoHome: scope.paoHome,
		读取时间: new Date().toISOString(),
		注册表路径: scope.catalog.注册表路径,
		部门,
		问题: scope.catalog.问题,
		工具技能人设区别: [...工具技能人设区别],
	}) as DesktopDeptCatalog;
}

/**
 * 单部门详情。`deptName` 必须是注册表里的名字(唯一名单);未登记就报错并给出「目录在不在」的实话,
 * 不自动建部、不静默返回空对象。
 */
export async function readDesktopDeptDetail(
	sessionId: string,
	project: string,
	deptName: string,
	options: DesktopDeptViewOptions = {},
): Promise<DesktopDeptDetail> {
	const scope = openScope(sessionId, project, options);
	const name = deptName.trim();
	if (!name) throw new Error("部门名为空;请从部门目录里选择已登记部门");
	const entry = scope.catalog.部门.find((item) => item.名字 === name);
	if (!entry) {
		const 部门目录 = join(scope.paoHome, DEPT_DIR_NAME, name);
		throw new Error(
			existsSync(部门目录)
				? `目录 ${部门目录} 存在,但 ${REGISTRY_FILE_NAME} 里没有该部门:未注册部门不参与派发,先按唯一正门补登记(不自动建部)`
				: `部门「${name}」未登记:${scope.catalog.注册表路径} 里没有这一行`,
		);
	}
	// 越界防护已在 openScope 里对全部登记条目统一做过(目录面与详情面同一口径)
	const 负载 = await readLoad(scope, name);
	return redactContext({
		版本: 1 as const,
		session: sessionId,
		project: scope.project,
		paoHome: scope.paoHome,
		读取时间: new Date().toISOString(),
		名字: entry.名字,
		标签: [...entry.标签],
		库路径: entry.库路径,
		建部日期: entry.建部日期,
		路径: {
			部门目录: entry.部门目录,
			配方: entry.配方路径,
			// 知识库门面归属注册表的库路径(记忆目录可被配方改成 PAO_HOME 内别处,但门面只此一处)
			知识库: join(scope.paoHome, entry.库路径),
		},
		职责: {
			原文: entry.人设 ?? "",
			出处: entry.配方存在 ? entry.配方路径 : null,
			待填: (entry.人设 ?? "").includes("待填"),
		},
		工具: {
			原值: entry.工具原值 ?? null,
			白名单: entry.工具.map((tool) => ({ 名字: tool.名字, 内置: tool.内置 })),
			混写技能名: [...entry.混写技能名],
		},
		技能: entry.技能.map(skillView),
		默认档位: resolveDeptTier(entry, readTiers(scope.paoHome)),
		标准: entry.标准.map(standardView),
		知识入口: {
			索引: sourceRef(scope.paoHome, entry.知识库索引.路径, "知识库入口"),
			干法: entry.干法 ? sourceRef(scope.paoHome, entry.干法.文件, "干法段") : null,
		},
		配置问题: scope.issuesOf(entry.名字),
		负载,
		读取问题: 负载.读取问题,
	}) as DesktopDeptDetail;
}
