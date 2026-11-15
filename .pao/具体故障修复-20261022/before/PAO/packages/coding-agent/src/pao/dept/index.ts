/**
 * PAO 建部与注册表:建部工具是部门创建唯一正门,注册表是部门清单唯一真相(架构 §4/§6.2/§6.8)。
 * 只读的部门目录/校验归 catalog.ts（UI 与主控共用的唯一名单与集中校验,不落第二份名单）。
 */

import { Type } from "typebox";
import type { ExtensionAPI, ToolDefinition } from "../../core/extensions/types.ts";
import { resolvePaoHome } from "../routing/config.ts";
import { renderRegistryFromHome, today } from "./render.ts";
import { type CreateDeptReport, createDept } from "./scaffold.ts";

export * from "./catalog.ts";
export * from "./panels.ts";
export * from "./registry.ts";
export * from "./render.ts";
export * from "./scaffold.ts";

/** 系统提示里注册表快照的 section 名(须匹配 ^[a-z][a-z0-9_-]*$) */
export const REGISTRY_SECTION_NAME = "pao_dept_registry";

const DeptToolParams = Type.Object({
	name: Type.String({ description: "部门名字,同时也是 部门/<名字>/ 目录名" }),
	tags: Type.Optional(
		Type.Array(Type.String(), { description: "能力标签(如 api、数据库),主控派卡与协作路由的匹配依据" }),
	),
	default_tier: Type.Optional(
		Type.String({ description: "写进配方的默认档位名(档位定义见 pao配置/档位.json),缺省「主力」" }),
	),
	preset: Type.Optional(
		Type.Literal("operations", {
			description: "显式选用运维/清理配方与默认能力标签；不填沿用普通骨架，已有配方不覆盖。",
		}),
	),
});

function formatReport(report: CreateDeptReport): string {
	const lines = [
		`已建部门「${report.名字}」(幂等:缺啥补啥,已有内容原样保留):`,
		`- 配方:部门/${report.名字}/配方.md(名字/人设/工具/技能/默认档位/记忆目录)`,
		`- 知识库:部门/${report.名字}/知识库(索引.md 门面 + 待验证/归档/教训/导览/做法/评测 六目录,四类型区各带子索引)`,
		`- 注册表行:部门/注册表.md(${report.注册表 === "created" ? "本次追加" : "已存在同名行,未改动"})`,
	];
	if (report.既有名字) {
		// 审查第 14 项：Windows 上 AuditDemo 与 auditdemo 是同一个目录，这里要说清没新建第二个部门
		lines.push(
			`注意:这次的名字与已有部门「${report.既有名字}」在文件系统上是同一个目录(大小写不同的写法),没有新建第二个部门,注册表与目录都未改动`,
		);
	}
	if (report.新建.length > 0) lines.push(`本次新建 ${report.新建.length} 项:${report.新建.join("、")}`);
	if (report.已有.length > 0) lines.push(`已有保留 ${report.已有.length} 项:${report.已有.join("、")}`);
	return lines.join("\n");
}

function buildDeptTool(paoHome: () => string): ToolDefinition<typeof DeptToolParams, CreateDeptReport> {
	return {
		name: "pao_create_dept",
		label: "建部",
		description:
			"创建部门(部门创建唯一正门):一次落齐 ①配方(部门/<名字>/配方.md:名字/人设/工具/技能/默认档位/记忆目录;工具=派发 worker 的内置工具白名单,技能=pao配置/skills 下真实目录名,人设只是文字) ②知识库骨架(索引.md 门面 + 待验证/归档/教训/导览/做法/评测 六目录,四类型区各带子索引) ③注册表行(部门/注册表.md:名字/能力标签/库路径/建部日期,建部日期由代码取当天写入)。幂等:对同名部门重跑只补缺,不覆盖已有文件与自定义内容。",
		parameters: DeptToolParams,
		execute: async (_toolCallId, params) => {
			const report = await createDept({
				paoHome: paoHome(),
				名字: params.name,
				标签: params.tags,
				默认档位: params.default_tier,
				preset: params.preset,
			});
			return {
				content: [{ type: "text", text: formatReport(report) }],
				details: report,
			};
		},
	};
}

export interface RegisterDeptToolsOptions {
	/** PAO_HOME;缺省在工具执行/渲染时读环境变量 PAO_HOME */
	paoHome?: string;
}

/**
 * 注册建部工具(pao_create_dept)与注册表渲染。
 *
 * 渲染:每次 run 前(before_agent_start)读 部门/注册表.md,把一行一部门的快照
 * (带「截至」日期)追加为系统提示 section;改注册表,下一次请求天然生效。
 * PAO_HOME 缺失或注册表读不了时不渲染该 section(无部门环境的会话不该因此失败);
 * 注册表存在但为空时渲染空态说明。
 */
export function registerDeptTools(pi: ExtensionAPI, options: RegisterDeptToolsOptions = {}): void {
	const paoHome = (): string => options.paoHome ?? resolvePaoHome();
	pi.registerTool(buildDeptTool(paoHome));
	pi.on("before_agent_start", (event) => {
		try {
			event.systemPromptOptions.sections[REGISTRY_SECTION_NAME] = renderRegistryFromHome(paoHome(), today());
		} catch {
			// PAO_HOME 缺失/读失败:跳过本 section,不阻断会话
		}
		return undefined;
	});
}
