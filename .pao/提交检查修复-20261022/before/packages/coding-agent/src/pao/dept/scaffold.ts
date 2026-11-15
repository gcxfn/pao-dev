import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../shared/atomic.ts";
import { BUILTIN_TOOL_NAMES } from "./catalog.ts";
import {
	appendRegistryRow,
	DEPT_DIR_NAME,
	type DeptRegistryRow,
	deptDirIdentity,
	REGISTRY_FILE_NAME,
	readRegistry,
} from "./registry.ts";
import { today } from "./render.ts";

/** 两个不设子索引的区(候选池/退役区) */
const PLAIN_AREAS = ["待验证", "归档"] as const;
/** 四个带子索引的类型区(架构 §6.2) */
const INDEXED_AREAS = ["教训", "导览", "做法", "评测"] as const;

/** 配方「默认档位」字段的缺省值(架构 §4.1 初始默认:部长→主力) */
export const DEFAULT_RECIPE_TIER = "主力";

export interface CreateDeptOptions {
	/** PAO_HOME:pao 仓库根 */
	paoHome: string;
	/** 部门名字,同时是目录名 */
	名字: string;
	/** 能力标签,写进注册表行 */
	标签?: string[];
	/** 写进配方的默认档位名;缺省「主力」 */
	默认档位?: string;
	/** 可选运维配方；只有显式建部时应用，不自动安装或覆盖既有配方。 */
	preset?: "operations";
}

export interface CreateDeptReport {
	名字: string;
	/** 知识库路径(相对 PAO_HOME) */
	库路径: string;
	/** 本次新建的文件/目录(相对部门目录) */
	新建: string[];
	/** 已存在原样保留的文件(相对部门目录) */
	已有: string[];
	/** 注册表行:created=本次追加;exists=已有同名行,未动 */
	注册表: "created" | "exists";
	/**
	 * 已有部门在注册表里的显示名（审查第 14 项）：仅当本次请求的名字与文件系统身份相同但写法不同时出现，
	 * 如先建 `AuditDemo` 再建 `auditdemo`（Windows 上同一个目录）。此时 名字/库路径 已改写为既有显示名。
	 */
	既有名字?: string;
}

function ensureDir(dir: string, relative: string, report: { 新建: string[]; 已有: string[] }): void {
	if (existsSync(dir)) {
		report.已有.push(relative);
		return;
	}
	mkdirSync(dir, { recursive: true });
	report.新建.push(relative);
}

/** 幂等写文件:已存在绝不覆盖,缺了才按模板补 */
function ensureFile(
	path: string,
	relative: string,
	template: string,
	report: { 新建: string[]; 已有: string[] },
): void {
	if (existsSync(path)) {
		report.已有.push(relative);
		return;
	}
	// 原子写:模板首建只此一次,半截写入会被「已存在绝不覆盖」当成正本永久留下
	writeFileAtomic(path, template);
	report.新建.push(relative);
}

/** 建部模板的「工具」行占位（工具权限＝派发 worker 时的内置工具白名单,只认八个内置名） */
export const RECIPE_TOOL_PLACEHOLDER = `<待填:内置工具名（${BUILTIN_TOOL_NAMES.join("/")}）,逗号分隔>`;
/** 建部模板的「技能」行占位（技能引用＝pao配置/skills 下的真实目录名,不是人设文字;配方里统一写 / 分隔） */
export const RECIPE_SKILL_PLACEHOLDER = "<待填:pao配置/skills 下的技能目录名,逗号分隔>";

function recipeTemplate(name: string, defaultTier: string, preset?: "operations"): string {
	if (preset === "operations") {
		return [
			`# 配方:${name}`,
			"",
			`- 名字:${name}`,
			"- 人设:负责运行环境诊断、维护与清理；先核对授权和目标，保留证据，按实际结果报告。",
			"- 工具:read,grep,find,ls,powershell,bash,write,edit",
			"- 技能:",
			`- 默认档位:${defaultTier}`,
			`- 记忆目录:部门/${name}/知识库`,
			"",
			"dept 用于配方、权限和归属，不代表部长已经参与或完成复核。直通卡由 owner 复核；需要部门审查时，显式启动部长或另派审查卡。",
			"删除前必须明确目标、只读预演并由 owner 确认；不得自行提权、停止占用进程或未经授权删除 Git 跟踪文件。",
			"",
			"## 干法",
			"",
			"1. 核对输入路径、权限和运行中的占用；无权或正在使用的目标安全跳过，逐项说明原因。",
			"2. 删除任务先声明精确目标并走共享删除预演入口；检查实际待删文件、Git 跟踪情况、证据目录和 owner 确认。目标变化后重新预演。",
			"3. 证据放任务工作区的 worker-evidence，报告逐项记录已执行、跳过、失败与未验证，不能把跳过写成完成。",
			"4. Windows PowerShell 5.1 执行的中文 .ps1 脚本使用 UTF-8 BOM；日志路径用绝对路径或明确工作目录。",
			"5. 最后输出规定 JSON 回执；偏差逐项自报并交 owner 裁决，不改验收条件来冒充通过。",
			"",
		].join("\n");
	}
	return [
		`# 配方:${name}`,
		"",
		"<!-- 部门唯一配方正本。占位符「<待填>」由部长/主控会话启动渲染与日常维护补齐;已有内容不覆盖 -->",
		"<!-- 稳定规则与任务态分离:配方只写人设/职责边界/默认档位/工具/技能清单;任务结论写回执与库,不写进配方 -->",
		"<!-- 部长人设纪律:交接页不得据此自行启动任何卡——启动卡是主控专属动作 -->",
		"<!-- 工具/技能/人设是三样东西:工具=派发 worker 的内置工具白名单;技能=pao配置/skills 下真实目录名(派发装载);人设=只给人看的描述,不装载能力 -->",
		"",
		`- 名字:${name}`,
		"- 人设:<待填:本部答什么问题、职责边界、口吻>",
		`- 工具:${RECIPE_TOOL_PLACEHOLDER}`,
		`- 技能:${RECIPE_SKILL_PLACEHOLDER}`,
		`- 默认档位:${defaultTier}`,
		`- 记忆目录:部门/${name}/知识库`,
		"",
		"## 干法",
		"",
		"<!-- 配方双层（S5 包4）：worker 派发只常驻注入本标题之前的概要；此处写详细步骤/清单/模板,worker 按需读取,配方加厚不增加常驻 token -->",
		"<待填:详细干法>",
		"",
	].join("\n");
}

function kbIndexTemplate(name: string): string {
	const lines = [
		`# ${name} 部门知识库`,
		"",
		"<!-- 顶层门面:一页地图,只在结构变化时动;清单在各区子索引,读者路径 门面→子索引→条目 三步封顶 -->",
		"",
		"## 本部答什么问题",
		"",
		"<待填:一句话职责边界>",
		"",
		"## 各区导引",
		"",
	];
	for (const zone of PLAIN_AREAS) {
		const description = zone === "待验证" ? "候选池,部长工作队列,不设索引" : "退役区,不进检索索引,查旧账人工翻";
		lines.push(`- [${zone}/](${zone}/) — ${description}(0 条)`);
	}
	for (const zone of INDEXED_AREAS) {
		const description: Record<string, string> = {
			教训: "正文五段:触发条件/正确做法/验证方法/来源/状态",
			导览: "路径与结构,必带「截至」",
			做法: "步骤、清单、模板",
			评测: "按任务类型的实测记录(端点/配置、完成情况、总用量、返工原因),必带「截至」",
		};
		lines.push(`- [${zone}/](${zone}/子索引.md) — ${description[zone]}(0 条)`);
	}
	lines.push("");
	return lines.join("\n");
}

function subIndexTemplate(zone: string): string {
	return [
		`# ${zone} 子索引`,
		"",
		"<!-- 类型清单:一行一条「链接 — 钩子(日期)」;动条目同批动本子索引;钩子写「这条能回答什么问题」,含可检索具体名词 -->",
		"",
	].join("\n");
}

/**
 * 建部(部门创建唯一正门):一次落齐 ①配方 ②库骨架(索引门面 + 六目录 + 四子索引) ③注册表行。
 * 幂等:对同一部门名重跑 = 检查已有内容,缺啥补啥,已有文件与自定义内容绝不覆盖。
 */
export async function createDept(options: CreateDeptOptions): Promise<CreateDeptReport> {
	const name = options.名字.trim();
	if (!name) throw new Error("部门名字不能为空");
	if (/[/\\:*?"<>|]|\.\./.test(name)) {
		throw new Error(`部门名字含非法字符(不能含路径分隔符与 ${'/\\:*?"<>|'} 等):${name}`);
	}

	const report: CreateDeptReport = {
		名字: name,
		库路径: `${DEPT_DIR_NAME}/${name}/知识库`,
		新建: [],
		已有: [],
		注册表: "exists",
	};

	const deptDir = join(options.paoHome, DEPT_DIR_NAME, name);
	const kbDir = join(deptDir, "知识库");
	ensureDir(deptDir, name, report);
	ensureDir(kbDir, `${name}/知识库`, report);
	for (const zone of PLAIN_AREAS) {
		ensureDir(join(kbDir, zone), `${name}/知识库/${zone}`, report);
	}
	for (const zone of INDEXED_AREAS) {
		ensureDir(join(kbDir, zone), `${name}/知识库/${zone}`, report);
		ensureFile(join(kbDir, zone, "子索引.md"), `${name}/知识库/${zone}/子索引.md`, subIndexTemplate(zone), report);
	}
	ensureFile(join(kbDir, "索引.md"), `${name}/知识库/索引.md`, kbIndexTemplate(name), report);
	ensureFile(
		join(deptDir, "配方.md"),
		`${name}/配方.md`,
		recipeTemplate(name, options.默认档位?.trim() || DEFAULT_RECIPE_TIER, options.preset),
		report,
	);

	const row: DeptRegistryRow = {
		名字: name,
		标签: options.标签 ?? (options.preset === "operations" ? ["运维", "清理", "环境诊断"] : []),
		库路径: report.库路径,
		// 摩擦日志 2026-10-02「建部日期列为空」:建部日期由代码取当天填入,不是模型参数
		建部日期: today(),
	};
	const registryPath = join(options.paoHome, DEPT_DIR_NAME, REGISTRY_FILE_NAME);
	report.注册表 = await appendRegistryRow(registryPath, row);
	if (report.注册表 === "exists") {
		// 审查第 14 项：可能是「同一个目录的不同写法」（Windows 上 AuditDemo/auditdemo）。
		// 回显既有显示名，别让调用方以为新建了一个部门；注册表与目录都不动。
		const identity = deptDirIdentity(options.paoHome, name);
		const existing = readRegistry(registryPath).find(
			(candidate) => deptDirIdentity(options.paoHome, candidate.名字) === identity,
		);
		if (existing && existing.名字 !== name) {
			report.既有名字 = existing.名字;
			report.名字 = existing.名字;
			report.库路径 = existing.库路径;
		}
	}
	return report;
}
