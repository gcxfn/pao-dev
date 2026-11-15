/**
 * 部门目录（唯一事实源,只读聚合）:注册表行 + 每部门 配方.md 实读 + 知识库入口 + 标准文件真实位置
 * + 派发面实际可用的技能目录（架构 §6.8、计划 §5.1/§5.2 第 2 条）。
 *
 * 纪律（计划 §5.1 表）:
 * - 部门名单只有一份——`<PAO_HOME>/部门/注册表.md`;本模块从注册表读,不落第二份名单、不缓存,
 *   前端也不得硬编码部门名。
 * - 配方字段的**读取口径与派发一致**:`工具`/`技能`/`skills`/`默认档位` 的行格式复制 worker/dispatch-core
 *   的 `recipeField` 正则,默认档位解析次序复制 `resolveDispatchParameters`（配方→档位.json 部门默认→主力）。
 *   本模块不改派发实现,只保证「详情里说的」与「派发时真做的」同源。
 * - 标准/干法只**定位真实文件**,不生成第二份副本;配方里的「部门标准」列沿用 workflow/recipe 的写法
 *   （`<路径>` 记文件、`<部门名>:<标准>` 记部门配方内的小节）。
 * - 读不出/坏掉的旧值一律**保留原值展示**并给可执行修法,不过滤成空列表（计划 §5.2 第 2 条）。
 * - 技能/标准/工具三者是三种东西,文案只在本模块出一次（见 `工具技能人设区别`）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

import { type TierConfig, loadTierConfig, resolveTierConfigPath, tierNameToModel } from "../routing/config.ts";
import { DEPT_DIR_NAME, deptDirIdentity, type DeptRegistryRow, REGISTRY_FILE_NAME, readRegistry } from "./registry.ts";
import { RECIPE_FILE_NAME } from "./render.ts";

/**
 * 干法段标题（S5 包4 双层配方切分标记,值必须是 `## 干法`）。
 * 正本在 worker/dispatch-core.ts 的 `RECIPE_METHOD_HEADING`（派发切分用它）;此处**只做本地常量**,
 * 不再从 dept 导出同名符号（dept/index 与 worker/index 都在 pao/index 通配导出,同名会冲突）。
 */
const RECIPE_METHOD_HEADING = "## 干法";

/** 知识库门面文件名 */
export const KB_INDEX_FILE_NAME = "索引.md";

/** 技能安装目录（相对 PAO_HOME）:部门配方「技能/skills」按这里的**目录名**引用 */
export const SKILLS_DIR_RELATIVE_PATH = join("pao配置", "skills");

/** 配方缺省默认档位（配方与档位.json 都未指定时的兜底,与派发核心同字面量） */
export const FALLBACK_TIER_NAME = "主力";

/**
 * worker 派发时可用的内置工具名（抄 worker/dispatch-core.ts 的 builtins 集合,一字不改）。
 * 配方「工具」行里出现表外名,派发时会被截到合法子集并告警——校验按同一集合核对。
 */
export const BUILTIN_TOOL_NAMES: readonly string[] = [
	"read",
	"grep",
	"find",
	"ls",
	"bash",
	"powershell",
	"write",
	"edit",
];

/** 角色：三种东西的中文标签，供 UI 与工具说明复用 */
export interface DeptRoleGlossaryRow {
	角色: string;
	含义: string;
	真实性判据: string;
}

/**
 * 工具权限 / 技能引用 / 人设文字的区别（计划 §5.1:189 要求「一句话一句」）。
 * 唯一正本在这里；桌面投影（E2）与工具说明（E5）读本表渲染，不在各处各写一份。
 * 注意:第一行「工具」只对 worker 派发面生效（`--tools`）;部长/主控会话自身的工具面不由此行约束。
 */
export const 工具技能人设区别: readonly DeptRoleGlossaryRow[] = [
	{
		角色: "工具权限",
		含义: "配方「工具」行:派发 worker 时允许使用的内置工具名白名单（八个内置名之一才认）。",
		真实性判据: "名字在内置集合里才生效;表外名会被截到合法子集并告警,不等于没写。",
	},
	{
		角色: "技能引用",
		含义: "配方「技能」或「skills」行:指向 pao配置/skills 下真实目录的引用名,派发时挂给 worker。",
		真实性判据: "目录与 SKILL.md 真实存在才装载;写「擅长写作」不是技能,只算人设文字。",
	},
	{
		角色: "人设文字",
		含义: "配方「人设」行写的职责、边界与口吻:给模型看的描述,不装载任何能力。",
		真实性判据: "永远只是文字;它说的能力是否真可用,要看技能与标准文件是否真实存在。",
	},
];

/**
 * 配方里的一个技能引用（解析结果,坏值保留原样）。
 *
 * 「未信任」这一态本轮**故意没有字段**:截至 2026-10-17 内核里不存在信任清单/白名单这个
 * 事实源（派发面只判「pao配置/skills/<名> 目录与 SKILL.md 真实可读」），硬造一个「未信任」
 * 状态就是发明事实。所以计划 §5.2 第 2 条列的「缺失/**未信任**技能」,本模块只如实报「缺失」,
 * 不报未信任;将来若真的引入信任清单,应在此处加字段并在 validateDeptCatalog 的技能分支接入,
 * 不要顺手在 UI 侧补一个假状态。
 */
export interface DeptSkillRef {
	/** 配方里写的引用名（原样;派发核心切出来的一整项,空格分隔的整串也会作为一项出现） */
	引用: string;
	/** 真实目录（<PAO_HOME>/pao配置/skills/<引用>） */
	路径: string;
	/** SKILL.md 真实路径 */
	skillFile: string;
	/** 目录存在 */
	目录存在: boolean;
	/** SKILL.md 存在且非空 */
	可用: boolean;
	/** 来自建部模板的占位文字（不是真引用,不参与「缺失技能」判错） */
	占位符?: boolean;
}

/** 配方里的一处标准引用（只定位真实文件/小节,不复制正文） */
export interface DeptStandardRef {
	/** 原始写法（配方「部门标准」列表里的一项） */
	原始: string;
	/** 解析出的真实文件路径;部门内小节引用为 undefined */
	文件?: string;
	/** 文件存在且可读 */
	可读: boolean;
}

/** 配方里的一个工具名（保留表外名供修复） */
export interface DeptToolRef {
	名字: string;
	/** 是否在派发核心的内置白名单里 */
	内置: boolean;
}

/** 配方「默认档位」的解析结果（三处来源都保留,供 UI 说明「为什么是这个档」） */
export interface DeptTierResolution {
	/** 卡面未指定时实际生效的档名 */
	生效: string;
	/** 来源:配方 / 档位.json 部门默认 / 缺省兜底 */
	来源: "配方" | "档位.json 部门默认" | "缺省兜底";
	/** 派发核心解析出的档名（原样保留,查无此档时就是这里露馅） */
	派发解析: string;
	/** provider/model 全串（与 worker 派发 --model 同口径）;档位.json 查无此档时为 undefined */
	模型?: string;
	/** 该档推荐思考强度;档位.json 查无此档时为 undefined */
	思考强度?: string;
}

/** 一个部门在目录里的全部只读事实 */
export interface DeptCatalogEntry {
	/** 注册表显示名（即 部门/<名字>/ 目录名） */
	名字: string;
	/** 注册表能力标签 */
	标签: string[];
	/** 注册表库路径（相对 PAO_HOME） */
	库路径: string;
	建部日期?: string;
	部门目录: string;
	配方路径: string;
	/** 配方文件存在 */
	配方存在: boolean;
	/** 配方原文（存在时）;旧内容原样保留,不改写 */
	配方原文?: string;
	/** 人设文字（配方「人设」行） */
	人设?: string;
	/** 工具行原值（表外名也保留） */
	工具原值?: string;
	工具: DeptToolRef[];
	/** 技能行原值（「技能」与「skills」两写法各自保留,派发优先认 skills） */
	技能行: { 字段: "技能" | "skills"; 原值: string }[];
	技能: DeptSkillRef[];
	/** 旧配方把技能名混写在「工具」行时,这里列出疑似技能名（供提示拆分） */
	混写技能名: string[];
	默认档位?: DeptTierResolution;
	记忆目录?: string;
	干法?: { 标题: string; 文件: string; 起始行: number };
	/** 配方里声明的标准（位置字段原始写法保留） */
	标准: DeptStandardRef[];
	/** 知识库门面真实路径与是否存在 */
	知识库索引: { 路径: string; 存在: boolean };
}

/** 目录里的一项配置问题:级别 + 可执行修法 + 真实证据路径 */
export interface DeptCatalogIssue {
	/** 阻止启动:派发/启动必失败;警告:能跑但结果与配方意图不符;提示:旧写法待整理,不影响运行 */
	级别: "阻止启动" | "警告" | "提示";
	部门: string;
	/** 问题类别（注册表/配方/档位/工具/技能/标准） */
	类别: string;
	问题: string;
	修法: string;
	证据: string;
}

/** 整份部门目录（唯一读取入口的返回值;问题集与条目同批返回,不丢旧值） */
export interface DeptCatalog {
	paoHome: string;
	注册表路径: string;
	/** 全部条目,按注册表顺序;读不出的部门也保留（配方原样留在条目上） */
	部门: DeptCatalogEntry[];
	问题: DeptCatalogIssue[];
}

// ── 解析（口径抄 worker/dispatch-core.ts 的 recipeField / 默认档位解析）────────────

/** 配方行字段:与 worker dispatch-core `recipeField` 同正则同语义（首个命中行,去首尾空白） */
function recipeField(recipe: string, name: string): string | undefined {
	return recipe.match(new RegExp(`^\\s*-\\s*${name}\\s*[:：]\\s*(.+)$`, "m"))?.[1].trim();
}

/** 配方「工具」行 → 工具名（与派发核心同一切分口径） */
function splitToolNames(raw: string): string[] {
	return raw
		.split(/[,，、\s]+/)
		.map((name) => name.trim())
		.filter(Boolean);
}

/**
 * 配方「技能」行 → 技能名引用。
 * 派发核心（dispatch-core `skillField.split(/[,，、]+/)`）只按逗号类切分,写成空格分隔会被当成
 * 一个不存在的技能名而拒派;这里**同样切成一项原样保留**（不猜用户想拆几个）,由校验点名。
 * 例外:写明是占位符的行（含「待填」）按词切开判断,占位文字不算真技能引用。
 */
function splitSkillTokens(raw: string): string[] {
	const names = raw
		.split(/[,，、]+/)
		.map((name) => name.trim())
		.filter(Boolean);
	return names;
}

/** 是否是「<…>」尖括号占位符（整行就是占位符时,派发核心也会把它当一个不存在的技能名拒掉——那是建部模板的锅,不是配置错） */
function isPlaceholderLine(raw: string): boolean {
	return /^\s*<.*>\s*$/.test(raw) || raw.includes("待填");
}

/** 占位符里面的「像目录名的词」:去尖括号、去中英文冒号后的说明、丢纯标点与路径写法（占位说明不是配置项） */
function placeholderCandidateWords(raw: string): string[] {
	const inner = raw.replace(/^<\s*/, "").replace(/\s*>$/, "");
	return inner
		.split(/[,，、;；\s]+/)
		.map((word) => word.replace(/^.*[:：]/, "").trim())
		.filter((word) => word.length > 0)
		.filter((word) => !/^[<>\-—_·…./\\()（）]+$/.test(word))
		.filter((word) => !/[/\\]/.test(word) && !word.includes("待填"));
}

/** 配方「部门标准」行:支持 `a、b` 与 `[a, b]` 两种写法（后者为 workflow/recipe 的 YAML 写法） */
function splitStandardNames(raw: string): string[] {
	const text = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
	return text
		.split(/[,，、]+/)
		.map((name) => name.trim().replace(/^["']|["']$/g, ""))
		.filter(Boolean);
}

/** 技能引用名是否可安全拼进目录（与 preflight 同款拒法:路径分隔符与 .. 一律非法） */
function isLegalSkillName(name: string): boolean {
	return Boolean(name) && !name.includes("..") && !/[\\/]/.test(name);
}

/** 路径是否落在 allowedRoot 之内（防止配方里写 ../ 逃出 PAO_HOME） */
function isInside(root: string, path: string): boolean {
	const target = resolve(path);
	const base = resolve(root);
	return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

/** 文件存在且至少有中文注释以外的一点内容（README 口径:真读一次,不信存在性） */
function isReadableFile(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		readFileSync(path, "utf8");
		return true;
	} catch {
		return false;
	}
}

/** 干法段定位:标题行存在则给出文件与行号（只定位,不摘正文——正文按需读原文件） */
function locateMethod(recipe: string, recipePath: string): DeptCatalogEntry["干法"] {
	const lines = recipe.split(/\r?\n/);
	const index = lines.findIndex((line) => line.trim() === RECIPE_METHOD_HEADING);
	if (index === -1) return undefined;
	return { 标题: RECIPE_METHOD_HEADING, 文件: recipePath, 起始行: index + 1 };
}

/** 部门标准 → 真实文件位置。`<路径>` 写文件;`<部门名>:<标准>` 指该部门配方「## 标准:<标准>」小节 */
function resolveStandard(paoHome: string, raw: string): DeptStandardRef {
	const inline = raw.match(/^<([^>]+)>$/)?.[1]?.trim();
	if (!inline) return { 原始: raw, 可读: false };
	const scoped = inline.match(/^(.+?)[:：](.+)$/);
	if (scoped && !/[\\/]/.test(scoped[1] ?? "")) {
		const recipePath = join(paoHome, DEPT_DIR_NAME, (scoped[1] ?? "").trim(), RECIPE_FILE_NAME);
		if (!isReadableFile(recipePath)) return { 原始: raw, 文件: recipePath, 可读: false };
		const heading = `## 标准:${(scoped[2] ?? "").trim()}`;
		const text = readFileSync(recipePath, "utf8");
		return { 原始: raw, 文件: recipePath, 可读: text.split(/\r?\n/).some((line) => line.trim() === heading) };
	}
	// 配方里的相对路径按 PAO_HOME 解析(配方是 PAO_HOME 的配置,不是命令行 cwd 的)
	const trimmed = inline.trim();
	const file = isAbsolute(trimmed) ? resolve(trimmed) : resolve(paoHome, trimmed);
	return { 原始: raw, 文件: file, 可读: isInside(paoHome, file) && isReadableFile(file) };
}

/** 档位名→物理模型与思考强度（复用 routing 的 tierNameToModel,不重写别名与查档逻辑） */
function tierModelOf(config: unknown, tierName: string): { 模型?: string; 思考强度?: string } {
	if (!config) return {};
	try {
		const resolved = tierNameToModel(config as TierConfig, tierName);
		return { 模型: resolved.model, 思考强度: resolved.thinkingLevel };
	} catch {
		// 查无此档/配置损坏:交给 validateDeptCatalog 报阻止项,这里不编默认值
		return {};
	}
}

/** 按派发核心的次序解析默认档位（卡面缺省时:配方→档位.json 部门默认→主力） */
function resolveDefaultTier(
	paoHome: string,
	deptName: string,
	recipeTier: string | undefined,
	deptDefaults: Record<string, string> | undefined,
	config?: TierConfig,
): DeptTierResolution | undefined {
	const deptTier = deptDefaults?.[deptName];
	if (recipeTier) return { 生效: recipeTier, 来源: "配方", 派发解析: recipeTier, ...tierModelOf(config, recipeTier) };
	if (deptTier)
		return { 生效: deptTier, 来源: "档位.json 部门默认", 派发解析: deptTier, ...tierModelOf(config, deptTier) };
	return {
		生效: FALLBACK_TIER_NAME,
		来源: "缺省兜底",
		派发解析: FALLBACK_TIER_NAME,
		...tierModelOf(config, FALLBACK_TIER_NAME),
	};
}

// ── 读取 ──────────────────────────────────────────────────────────────────────

/** 读一个部门的配方事实（纯读;配方缺失时只回最小条目,不当空列表吞掉注册表行） */
function readDeptEntry(
	paoHome: string,
	row: DeptRegistryRow,
	deptDefaults?: Record<string, string>,
	config?: TierConfig,
): DeptCatalogEntry {
	const deptDir = join(paoHome, DEPT_DIR_NAME, row.名字);
	const recipePath = join(deptDir, RECIPE_FILE_NAME);
	const kbIndex = join(paoHome, row.库路径, KB_INDEX_FILE_NAME);
	const entry: DeptCatalogEntry = {
		名字: row.名字,
		标签: row.标签,
		库路径: row.库路径,
		建部日期: row.建部日期,
		部门目录: deptDir,
		配方路径: recipePath,
		配方存在: isReadableFile(recipePath),
		工具: [],
		技能行: [],
		技能: [],
		混写技能名: [],
		标准: [],
		知识库索引: { 路径: kbIndex, 存在: isReadableFile(kbIndex) },
	};
	if (!entry.配方存在) return entry;

	const recipe = readFileSync(recipePath, "utf8");
	entry.配方原文 = recipe;
	entry.人设 = recipeField(recipe, "人设");
	entry.记忆目录 = recipeField(recipe, "记忆目录");
	entry.干法 = locateMethod(recipe, recipePath);

	const toolRaw = recipeField(recipe, "工具");
	const toolNames = toolRaw && !toolRaw.includes("待填") ? splitToolNames(toolRaw) : [];
	if (toolRaw) entry.工具原值 = toolRaw;
	entry.工具 = toolNames.map((name) => ({ 名字: name, 内置: BUILTIN_TOOL_NAMES.includes(name) }));
	// 旧模板一行「工具:<待填:本部装载的工具与 skills>」把两种东西混写在一起:表外名里若有
	// pao配置/skills 下真实存在的目录,就点名它是技能引用而非工具（提示拆分,不改旧文件）。
	entry.混写技能名 = entry.工具
		.filter((tool) => !tool.内置 && existsSync(join(paoHome, SKILLS_DIR_RELATIVE_PATH, tool.名字)))
		.map((tool) => tool.名字);

	const skillsRaw = recipeField(recipe, "skills");
	const 技能Raw = recipeField(recipe, "技能");
	// 派发只认 skills（dispatch-core `recipeField("skills") ?? recipeField("技能")`）;两写法都在时原样都留着
	const skillLines: { 字段: "技能" | "skills"; 原值: string }[] = [];
	if (skillsRaw) skillLines.push({ 字段: "skills", 原值: skillsRaw });
	if (技能Raw) skillLines.push({ 字段: "技能", 原值: 技能Raw });
	entry.技能行 = skillLines;
	const tokens: { 引用: string; 占位符: boolean }[] = [];
	for (const line of entry.技能行) {
		if (isPlaceholderLine(line.原值)) {
			// 整行是建部模板占位符:不当作技能引用,只把里面像目录名的词挑出来核对
			for (const word of placeholderCandidateWords(line.原值)) tokens.push({ 引用: word, 占位符: true });
			continue;
		}
		for (const raw of splitSkillTokens(line.原值)) tokens.push({ 引用: raw, 占位符: false });
	}
	for (const token of tokens) {
		if (entry.技能.some((item) => item.引用 === token.引用)) continue;
		const dir = join(paoHome, SKILLS_DIR_RELATIVE_PATH, token.引用);
		const skillFile = join(dir, "SKILL.md");
		const 目录存在 = isLegalSkillName(token.引用) && existsSync(dir);
		entry.技能.push({
			引用: token.引用,
			路径: dir,
			skillFile,
			目录存在,
			可用: 目录存在 && isReadableFile(skillFile),
			占位符: token.占位符,
		});
	}

	const tierRaw = recipeField(recipe, "默认档位")?.split(/[（(]/)[0].trim();
	entry.默认档位 = resolveDefaultTier(paoHome, row.名字, tierRaw, deptDefaults, config);

	const standards = recipeField(recipe, "部门标准");
	if (standards) entry.标准 = splitStandardNames(standards).map((raw) => resolveStandard(paoHome, raw));
	return entry;
}

/** 档位.json 的「部门默认」;配置缺失/损坏时返回错误文本（不伪装成没有配置） */
function readDeptDefaults(paoHome: string): {
	部门默认?: Record<string, string>;
	档名: string[];
	配置?: TierConfig;
	错误?: string;
} {
	const configPath = resolveTierConfigPath(paoHome);
	if (!existsSync(configPath)) return { 档名: [], 错误: `档位配置不存在：${configPath}` };
	try {
		const config = loadTierConfig(configPath);
		return { 部门默认: config.部门默认, 档名: config.档位.map((tier) => tier.名), 配置: config };
	} catch (error) {
		return { 档名: [], 错误: error instanceof Error ? error.message : String(error) };
	}
}

/** 注册表文件里出现的名字（按行解析原样保留;注册表坏掉时用它把「谁登记过」讲清楚） */
function registryNames(paoHome: string): string[] {
	const registryPath = join(paoHome, DEPT_DIR_NAME, REGISTRY_FILE_NAME);
	return readRegistry(registryPath).map((row) => row.名字);
}

// ── 校验（集中返回,逐项给路径与修法）────────────────────────────────────────────

/** 部门名合法性（与 pao_create_dept 同款拒法:路径分隔符、..、Windows 保留字符一律非法） */
function deptNameProblem(name: string): string | undefined {
	if (!name.trim()) return "部门名称为空";
	if (/[/\\:*?"<>|]|\.\./.test(name)) return "部门名称含路径分隔符/.. /Windows 保留字符";
	return undefined;
}

/** 目录下与注册表名不同写法、但文件系统上是同一个目录的兄弟目录（Windows 大小写重名） */
function caseVariantDirs(paoHome: string, name: string): string[] {
	const root = join(paoHome, DEPT_DIR_NAME);
	try {
		return readdirSync(root, { withFileTypes: true })
			.filter((item) => item.isDirectory() && item.name !== name && item.name.toLowerCase() === name.toLowerCase())
			.map((item) => item.name);
	} catch {
		return [];
	}
}

/**
 * 集中校验:注册表行、缺配方、Windows 大小写重名、无效档位、缺失/未信任技能、标准不可读、工具表外名。
 * 返回逐项问题（不改任何文件、不修数据）;旧无效值留在 `DeptCatalog.部门` 的条目上供修复。
 */
export function validateDeptCatalog(catalog: DeptCatalog): DeptCatalogIssue[] {
	const issues: DeptCatalogIssue[] = [...catalog.问题];
	const { paoHome } = catalog;
	const registryPath = catalog.注册表路径;

	// 注册表本身读不出:条目为空但「登记过」的痕迹可能还在,如实点名
	if (!existsSync(registryPath)) {
		issues.push({
			级别: "警告",
			部门: "（注册表）",
			类别: "注册表",
			问题: "部门注册表不存在:当前没有已登记部门",
			修法: "用 pao_create_dept 建部（唯一正门）,或重建 部门/注册表.md",
			证据: registryPath,
		});
	}

	const seen = new Map<string, string[]>();
	for (const entry of catalog.部门) {
		const nameProblem = deptNameProblem(entry.名字);
		if (nameProblem) {
			issues.push({
				级别: "阻止启动",
				部门: entry.名字,
				类别: "注册表",
				问题: `注册表里的部门名非法:${nameProblem}`,
				修法: "改注册表行与目录名为不带分隔符的普通名字,再重新校验",
				证据: registryPath,
			});
		}
		const variants = caseVariantDirs(paoHome, entry.名字);
		if (variants.length > 0) {
			issues.push({
				级别: "警告",
				部门: entry.名字,
				类别: "注册表",
				问题: `部门目录存在大小写不同的第二写法（${variants.join("、")}）,Windows 上是同一个目录:重复登记会指向同一份配方`,
				修法: "删除重复的注册表行/目录写法,只留一条（先备份）,不自动合并",
				证据: join(paoHome, DEPT_DIR_NAME, entry.名字),
			});
		}
		const key = deptDirIdentity(paoHome, entry.名字);
		seen.set(key, [...(seen.get(key) ?? []), entry.名字]);
		if (!entry.配方存在) {
			issues.push({
				级别: "阻止启动",
				部门: entry.名字,
				类别: "配方",
				问题: "配方文件缺失或不可读:该部门无法派发（worker 拿不到人设/工具/技能）",
				修法: `补写 部门/${entry.名字}/配方.md（pao_create_dept 幂等建部可补缺,已有内容不覆盖）`,
				证据: entry.配方路径,
			});
			continue;
		}
		if (!(entry.配方原文 ?? "").trim()) {
			issues.push({
				级别: "阻止启动",
				部门: entry.名字,
				类别: "配方",
				问题: "配方文件为空",
				修法: "补写名字/人设/工具/默认档位/记忆目录各行（可用 pao_create_dept 幂等补缺）",
				证据: entry.配方路径,
			});
		}
		for (const tool of entry.工具.filter((item) => !item.内置)) {
			const 是技能 = entry.混写技能名.includes(tool.名字);
			issues.push({
				级别: "警告",
				部门: entry.名字,
				类别: "工具",
				问题: `配方「工具」含派发核心不认识的表外名「${tool.名字}」:派发时会被截到合法子集并告警,不会按字面装载`,
				修法: `从「工具」行删掉它;内置工具名只有 ${BUILTIN_TOOL_NAMES.join("、")}` +
					(是技能 ? `;「${tool.名字}」是技能（pao配置/skills 下有同名目录）,应挪到「技能」行` : ""),
				证据: entry.配方路径,
			});
		}
		for (const name of entry.混写技能名) {
			issues.push({
				级别: "提示",
				部门: entry.名字,
				类别: "技能",
				问题: `旧配方把技能名「${name}」混写在「工具」行:派发不会装载它`,
				修法: "把该名字挪到独立的「技能」行（派发核心只从「技能/skills」行装载技能）",
				证据: entry.配方路径,
			});
		}
		for (const skill of entry.技能) {
			if (skill.占位符 || skill.可用) continue;
			const 空格分隔 = /\s/.test(skill.引用);
			issues.push({
				级别: "阻止启动",
				部门: entry.名字,
				类别: "技能",
				问题:
					`配方声明的技能「${skill.引用}」${skill.目录存在 ? "目录存在但 SKILL.md 缺失/不可读" : "目录不存在"}` +
					(空格分隔
						? ":派发核心只按逗号类分隔技能名,空格分隔的整串会被当成一个技能名而拒派"
						: ":派发会被拒（配方技能路径不存在）"),
				修法: 空格分隔
					? `用逗号分隔每个技能目录名（${SKILLS_DIR_RELATIVE_PATH} 下的真实目录）;确实需要这个名字就安装同名技能`
					: `安装技能到 ${SKILLS_DIR_RELATIVE_PATH}/${skill.引用}/SKILL.md,或从配方「技能」行删掉该名`,
				证据: skill.路径,
			});
		}
		for (const standard of entry.标准.filter((item) => !item.可读)) {
			issues.push({
				级别: "警告",
				部门: entry.名字,
				类别: "标准",
				问题: `配方声明的标准「${standard.原始}」定位不到真实文件/小节`,
				修法: "修正「部门标准」里的引用写法,或先补出该标准文件/小节;标准只引用不复制",
				证据: standard.文件 ?? entry.配方路径,
			});
		}
		if (!entry.知识库索引.存在) {
			issues.push({
				级别: "警告",
				部门: entry.名字,
				类别: "知识库",
				问题: "知识库门面 索引.md 缺失或不可读:知识入口打不开",
				修法: "补 部门/<名>/知识库/索引.md（pao_create_dept 幂等建部可补缺）",
				证据: entry.知识库索引.路径,
			});
		}
		if (entry.干法 === undefined) {
			issues.push({
				级别: "提示",
				部门: entry.名字,
				类别: "干法",
				问题: `配方没有「${RECIPE_METHOD_HEADING}」段:旧配方整文件常驻注入（行为不变,但更耗上下文）`,
				修法: `把详细步骤挪到「${RECIPE_METHOD_HEADING}」段之后,概要与边界留在段前`,
				证据: entry.配方路径,
			});
		}
	}
	for (const [key, names] of seen) {
		if (names.length < 2) continue;
		issues.push({
			级别: "阻止启动",
			部门: names.join("、"),
			类别: "注册表",
			问题: `注册表里 ${names.join("、")} 指向同一个部门目录（文件系统身份 ${key} 相同,典型是 Windows 大小写重名）:重复登记会让派发与显示打架`,
			修法: "删重复行只留一条（先备份注册表）,目录不动",
			证据: registryPath,
		});
	}

	// 档位:复用 routing/config 的加载与校验;查无此档的解析结果保留在条目上
	const tierConfig = readDeptDefaults(paoHome);
	if (tierConfig.错误) {
		issues.push({
			级别: "阻止启动",
			部门: "（档位）",
			类别: "档位",
			问题: `档位配置不可用:${tierConfig.错误}`,
			修法: "修复 pao配置/档位.json（按报错点名处改）,或重新安装档位配置",
			证据: resolveTierConfigPath(paoHome),
		});
	}
	for (const [dept, tierName] of Object.entries(tierConfig.部门默认 ?? {})) {
		if (!catalog.部门.some((entry) => entry.名字 === dept)) {
			issues.push({
				级别: "提示",
				部门: dept,
				类别: "档位",
				问题: `档位.json「部门默认」引用了未登记的部门「${dept}」（值 ${tierName}）:该配置不会生效`,
				修法: "删除该键,或先按唯一正门建部",
				证据: resolveTierConfigPath(paoHome),
			});
		}
	}
	if (!tierConfig.错误) {
		for (const entry of catalog.部门) {
			const resolution = entry.默认档位;
			if (!resolution) continue;
			const known = tierConfig.档名.map((name) => name.trim());
			// 别名归一与 routing/config tierAliasKey 同表（fast→快、primary→主力）
			const alias: Record<string, string> = { fast: "快", primary: "主力" };
			const normalized = alias[resolution.生效] ?? resolution.生效;
			if (!known.some((name) => (alias[name] ?? name) === normalized)) {
				issues.push({
					级别: "阻止启动",
					部门: entry.名字,
					类别: "档位",
					问题: `默认档位「${resolution.生效}」（来源:${resolution.来源}）在 档位.json 中不存在:派发时解析档位会报错`,
					修法: `改配方「默认档位」或档位.json「部门默认」为现有档名（${known.join("、")}）`,
					证据: entry.配方路径,
				});
			}
		}
	}
	return issues;
}

/**
 * 读整份部门目录（纯读,不写盘、不建目录、不取锁）:注册表 → 每部门配方 → 校验。
 * 注册表读失败不抛给调用方时由 `problems` 承接:界面能显示「读不出来」而不是空列表。
 */
export function readDeptCatalog(paoHome: string): DeptCatalog {
	const registryPath = join(paoHome, DEPT_DIR_NAME, REGISTRY_FILE_NAME);
	const catalog: DeptCatalog = { paoHome, 注册表路径: registryPath, 部门: [], 问题: [] };
	const tierConfig = readDeptDefaults(paoHome);
	try {
		const rows = readRegistry(registryPath);
		catalog.部门 = rows.map((row) => readDeptEntry(paoHome, row, tierConfig.部门默认, tierConfig.配置));
	} catch (error) {
		catalog.问题.push({
			级别: "阻止启动",
			部门: "（注册表）",
			类别: "注册表",
			问题: `部门注册表不可读:${error instanceof Error ? error.message : String(error)}`,
			修法: "修复或恢复 部门/注册表.md（先备份）,不要清空重建",
			证据: registryPath,
		});
	}
	// 注册表读失败的原因必须先留住:validateDeptCatalog 只认「文件不存在」,认不出
	// 「路径在但读不了」（目录占位、权限拒绝）,直接覆盖会把「读不出来」降级成「没有登记部门」。
	const readFailures = [...catalog.问题];
	catalog.问题 = [...readFailures, ...validateDeptCatalog({ ...catalog, 问题: [] })];
	return catalog;
}
/** 目录里登记过的全部部门名（唯一名单,给下拉与主控复用;不缓存、不落第二份） */
export function listDeptNames(paoHome: string): string[] {
	return registryNames(paoHome);
}

/**
 * 某个部门名的注册表行不存在时,给出「有这个名字的目录/没有」的实话:
 * 未注册就不出现在选项里（计划 §5.2 第 3 条:未注册返回已有选项,不自动建部）。
 */
export function deptUnregisteredHint(paoHome: string, name: string): string | undefined {
	const dir = join(paoHome, DEPT_DIR_NAME, name);
	if (!existsSync(dir)) return undefined;
	return `目录 ${dir} 存在,但注册表里没有该部门:未注册部门不参与派发,先按唯一正门补登记（不自动建部）`;
}
