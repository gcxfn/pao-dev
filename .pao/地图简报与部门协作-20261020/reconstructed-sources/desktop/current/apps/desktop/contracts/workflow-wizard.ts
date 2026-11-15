/**
 * 工作流启流向导（P4-3）契约：目录只读（配方全量＋档位＋思考强度＋出厂模板）、
 * 预检同源闸门（fork previewDesktopWorkflow＝启流前同一次检查，红项禁启）、
 * 三个会话内变更（模板安装／配方保存／启流，全部沿用 fork 的 owner 校验＋ui.confirm
 * 显式确认，桌面层不绕不仿）。
 *
 * 配方对象（中文键，卡协议冻结口径）整体透传：向导只改节点级覆盖字段
 * （模型/档位/思考强度/预算），保存与启动的渲染等值性由 fork 校验兜底。
 */

import type { CanvasUnavailableCode } from "./canvas";

/** 节点预算（CardBudget 数值字段；空输入＝删键，与 fork 编辑器同语义）。 */
export interface WizardNodeBudget {
  readonly turns?: number;
  readonly toolCalls?: number;
  readonly cost?: number;
  readonly [extra: string]: unknown;
}

/** 配方节点（向导可编辑字段显式声明；其余键原样保留整体透传）。 */
export interface WizardRecipeNode {
  readonly 名字: string;
  readonly 部门: string;
  readonly depends_on?: readonly string[];
  readonly 人工确认?: boolean;
  readonly 技能?: readonly string[];
  readonly 模型?: string;
  readonly 档位?: string;
  readonly 思考强度?: string;
  readonly 预算?: WizardNodeBudget;
  readonly [extra: string]: unknown;
}

/** 配方全量（名字/参数/节点为向导依赖字段；其余整体透传不重造）。 */
export interface WizardRecipe {
  readonly 名字: string;
  readonly 参数: readonly string[];
  readonly 节点: readonly WizardRecipeNode[];
  readonly [extra: string]: unknown;
}

/** 目录条目：配方全量＋版本指纹（保存/启动的乐观锁）。 */
export interface WizardRecipeEntry {
  readonly name: string;
  readonly revision: string;
  readonly recipe: WizardRecipe;
}

/** 主控虚拟档位（pao配置/档位.json 一行）。 */
export interface WizardTier {
  readonly name: string;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: string;
}

/** 出厂起步模板（三卡数据源）。 */
export interface WizardTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export interface WorkflowCatalogSnapshot {
  readonly state: "available";
  readonly recipes: readonly WizardRecipeEntry[];
  readonly departments: readonly string[];
  readonly skills: readonly string[];
  readonly tiers: readonly WizardTier[];
  readonly thinkingLevels: readonly string[];
  readonly templates: readonly WizardTemplate[];
  /** 目录整段不可读等顶层错误（显式上报，不伪装空目录）。 */
  readonly errors: readonly string[];
}

export interface WorkflowWizardUnavailable {
  readonly state: "unavailable";
  readonly code: CanvasUnavailableCode;
  readonly message: string;
}

export type WorkflowCatalogResult = WorkflowCatalogSnapshot | WorkflowWizardUnavailable;

/** 预检报告项（level 取值与 fork PreflightLevel 同源：「阻止启动」为红项）。 */
export interface WizardPreflightItem {
  readonly level: string;
  readonly subject: string;
  readonly reason: string;
  readonly suggestion: string;
  readonly evidence?: string;
}

/** 参数代入后的节点预览行（显示值，权威判定以 items/canStart 为准）。 */
export interface WizardNodePreviewRow {
  readonly name: string;
  readonly dept: string;
  readonly model: string;
  readonly thinkingLevel: string;
  readonly skills: readonly string[];
  readonly workerLimit: number;
}

export interface WorkflowPreflightReport {
  readonly canStart: boolean;
  readonly items: readonly WizardPreflightItem[];
  readonly nodes: readonly WizardNodePreviewRow[];
  readonly budget: {
    readonly cost: number | null;
    readonly turns: number | null;
    readonly toolCalls: number | null;
    readonly note: string;
  };
  readonly checkedAt: string;
}

/** 预检结果：ok＝拿到同源报告；failed＝桥加载/调用失败（可展示原因）。 */
export type WorkflowPreflightResult =
  | { readonly state: "ok"; readonly report: WorkflowPreflightReport }
  | { readonly state: "failed"; readonly message: string };

/** 会话内变更（安装/保存/启动）结果：错误原样透出 fork 的中文说明。 */
export type WorkflowMutationResult =
  { readonly state: "ok" } | { readonly state: "error"; readonly message: string };

/** 预检输入：project＝目标项目路径（主控会话 cwd 口径）。 */
export interface WorkflowPreflightInput {
  readonly project: string;
  readonly recipe: WizardRecipe;
  readonly parameters: Readonly<Record<string, string>>;
}

export interface WorkflowTemplateInstallInput {
  readonly sessionId: string;
  readonly project: string;
  readonly templateId: string;
  readonly name?: string;
}

export interface WorkflowRecipeSaveInput {
  readonly sessionId: string;
  readonly project: string;
  readonly recipe: WizardRecipe;
  /** null＝新配方，内核拒绝覆盖同名文件；已有配方必须提供原版本指纹。 */
  readonly revision: string | null;
}

/** 删除配方输入：名字＋版本指纹（null＝不比对指纹；内核守卫负责版本漂移/运行中实例拒绝）。 */
export interface WorkflowRecipeDeleteInput {
  readonly sessionId: string;
  readonly project: string;
  readonly name: string;
  readonly revision: string | null;
}

export interface WorkflowStartInput {
  readonly sessionId: string;
  readonly project: string;
  readonly recipe: WizardRecipe;
  readonly revision: string;
  readonly parameters: Readonly<Record<string, string>>;
  readonly masterTier: string;
  readonly thinking: string;
}

/** 档位保存输入（S9-2 向导「管理档位」直写 pao配置/档位.json）：editing＝被编辑档原名，缺省＝新建。 */
export interface WorkflowTierSaveInput {
  readonly tier: {
    readonly name: string;
    readonly provider: string;
    readonly model: string;
    readonly thinkingLevel: string;
  };
  readonly editing?: string;
}
