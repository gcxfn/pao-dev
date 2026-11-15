/**
 * PAO 工作流向导桥（桌面 P4-3）：把 fork 的 desktop 桥五函数（目录只读／预检同源闸门／
 * 模板安装／配方保存／启流）收拢成一个加载点，桌面壳经 IPC 直调，不在桌面层重造解析。
 *
 * 公开桌面入口与桌面会话内置 pao 扩展（builtin factory paoExtension 的
 * registerDesktopOwner）在主进程内是同一模块实例——owners 表共享，启流/存配方的
 * 会话校验与 ui.confirm 二次确认全部沿用 fork 原语义，桌面层不绕不仿。
 *
 * 配方对象（中文键）整体透传：渲染等值性（renderDesktopRecipe）靠不重造字段，
 * 桌面只改向导明确暴露的节点字段（模型/档位/思考强度/预算）。
 */
import { loadPaoDesktopModule } from "./pao-desktop-module.js";

/** fork 节点预算（CardBudget 数值字段）。 */
export interface PaoNodeBudget {
  readonly turns?: number;
  readonly toolCalls?: number;
  readonly cost?: number;
  readonly [extra: string]: unknown;
}

/** fork 配方节点：向导可编辑字段显式声明，其余键原样保留（整体透传不重造）。 */
export interface PaoWorkflowRecipeNode {
  readonly 名字: string;
  readonly 部门: string;
  readonly depends_on?: readonly string[];
  readonly 人工确认?: boolean;
  readonly 技能?: readonly string[];
  readonly 模型?: string;
  readonly 档位?: string;
  readonly 思考强度?: string;
  readonly 预算?: PaoNodeBudget;
  readonly [extra: string]: unknown;
}

/** fork 配方（中文键）：名字/参数/节点为向导所依赖的字段，其余整体透传。 */
export interface PaoWorkflowRecipe {
  readonly 名字: string;
  readonly 参数: readonly string[];
  readonly 节点: readonly PaoWorkflowRecipeNode[];
  readonly [extra: string]: unknown;
}

/** fork preflight 的报告项（level 取值与 fork PreflightLevel 同源）。 */
export interface PaoPreflightItem {
  readonly level: string;
  readonly subject: string;
  readonly reason: string;
  readonly suggestion: string;
  readonly evidence?: string;
}

/** fork checkPreflight 报告：canStart=false 即存在「阻止启动」红项。 */
export interface PaoPreflightReport {
  readonly project: string;
  readonly checkedAt: string;
  readonly canStart: boolean;
  readonly items: readonly PaoPreflightItem[];
}

/** fork previewDesktopWorkflow 的返回（报告＋节点代入预览＋预算合计）。 */
export interface PaoWorkflowPreview {
  readonly report: PaoPreflightReport;
  readonly 节点数: number;
  readonly 节点: readonly {
    readonly 名字: string;
    readonly 部门: string;
    readonly 工人上限: number;
    readonly 模型: string;
    readonly 思考强度: string;
    readonly 技能: readonly string[];
  }[];
  readonly 预算: {
    readonly cost: number | null;
    readonly turns: number | null;
    readonly toolCalls: number | null;
    readonly 说明: string;
  };
  readonly 将落卡数: string;
}

/** fork 档位（pao配置/档位.json 一行）。 */
export interface PaoTierEntry {
  readonly 名: string;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: string;
}

/** fork 出厂起步模板（三张卡的数据源）。 */
export interface PaoStarterTemplate {
  readonly id: string;
  readonly [extra: string]: unknown;
}

/** fork readDesktopRecipeCatalog 的返回（结构声明，errors 为字符串数组）。 */
export interface PaoRecipeCatalog {
  readonly recipes: readonly {
    readonly recipe: PaoWorkflowRecipe;
    readonly revision: string;
    readonly content: string;
  }[];
  readonly departments: readonly string[];
  readonly skills: readonly string[];
  readonly tiers: readonly PaoTierEntry[];
  readonly thinkingLevels: readonly string[];
  readonly templates: readonly PaoStarterTemplate[];
  readonly errors: readonly string[];
}

/** fork desktop 桥五函数的纯签名（启动/保存/安装均带会话校验＋ui.confirm）。 */
export interface PaoDesktopWorkflowModule {
  readonly readDesktopRecipeCatalog: (paoHome: string) => PaoRecipeCatalog;
  readonly previewDesktopWorkflow: (
    paoHome: string,
    project: string,
    recipe: PaoWorkflowRecipe,
    parameters: Record<string, string>,
  ) => PaoWorkflowPreview;
  readonly installDesktopTemplate: (
    sessionId: string,
    project: string,
    templateId: string,
    name?: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly saveDesktopRecipe: (
    sessionId: string,
    project: string,
    recipe: PaoWorkflowRecipe,
    revision: string | null,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly deleteDesktopRecipe: (
    sessionId: string,
    project: string,
    name: string,
    revision: string | null,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly startDesktopWorkflow: (
    sessionId: string,
    project: string,
    recipe: PaoWorkflowRecipe,
    revision: string,
    parameters: Record<string, string>,
    masterTier: string,
    thinking: string,
    signal?: AbortSignal,
  ) => Promise<void>;
}

/** 动态加载 fork 构建产物里的 desktop 桥；加载失败抛错，由调用方降级为不可用。 */
export async function loadPaoDesktopWorkflow(): Promise<PaoDesktopWorkflowModule> {
  const module = await loadPaoDesktopModule();
  const {
    readDesktopRecipeCatalog,
    previewDesktopWorkflow,
    installDesktopTemplate,
    saveDesktopRecipe,
    deleteDesktopRecipe,
    startDesktopWorkflow,
  } = module;
  if (typeof readDesktopRecipeCatalog !== "function")
    throw new Error("PAO 构建产物缺少工作流入口 readDesktopRecipeCatalog。");
  if (typeof previewDesktopWorkflow !== "function")
    throw new Error("PAO 构建产物缺少工作流入口 previewDesktopWorkflow。");
  if (typeof installDesktopTemplate !== "function")
    throw new Error("PAO 构建产物缺少工作流入口 installDesktopTemplate。");
  if (typeof saveDesktopRecipe !== "function")
    throw new Error("PAO 构建产物缺少工作流入口 saveDesktopRecipe。");
  if (typeof deleteDesktopRecipe !== "function")
    throw new Error("PAO 构建产物缺少工作流入口 deleteDesktopRecipe。");
  if (typeof startDesktopWorkflow !== "function")
    throw new Error("PAO 构建产物缺少工作流入口 startDesktopWorkflow。");
  // 内核实现接受完整 WorkflowRecipe 并返回完整 catalog/preview；公开层保留历史最小
  // 契约。真实配方读写、预览和启动流程已覆盖字段传递与返回值，断言只在此加载边界。
  return {
    readDesktopRecipeCatalog,
    previewDesktopWorkflow,
    installDesktopTemplate,
    saveDesktopRecipe,
    deleteDesktopRecipe,
    startDesktopWorkflow,
  } as unknown as PaoDesktopWorkflowModule;
}
