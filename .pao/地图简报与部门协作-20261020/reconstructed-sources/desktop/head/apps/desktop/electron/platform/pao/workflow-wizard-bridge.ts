/**
 * PAO 工作流向导桥（P4-3）：目录只读＋预检同源闸门＋三个会话内变更。与 canvas-query
 * 同一口径——所有失败都落成可展示的错误/不可用结果，绝不把异常抛到主进程顶层，
 * 也绝不把失败伪装成空目录。变更面（安装模板/保存配方/启动）经 fork desktop 桥的
 * owner 校验＋ui.confirm 显式确认，桌面层不绕不仿；错误原样透出中文说明。
 * S9-2 档位管理（saveTier）：非会话内变更，直写 pao配置/档位.json，复用内核
 * load/saveTierConfig（重名校验＋时间戳备份＋原子写），不经 owner/ui.confirm——
 * 保存按钮即显式动作，与设置表单同口径。
 */
import type {
  WizardRecipe,
  WizardTier,
  WorkflowCatalogResult,
  WorkflowCatalogSnapshot,
  WorkflowMutationResult,
  WorkflowPreflightInput,
  WorkflowPreflightResult,
  WorkflowPreflightReport,
  WorkflowRecipeDeleteInput,
  WorkflowRecipeSaveInput,
  WorkflowStartInput,
  WorkflowTemplateInstallInput,
  WorkflowTierSaveInput,
  WorkflowWizardUnavailable,
} from "../../../contracts/workflow-wizard";
import type { CanvasUnavailableCode } from "../../../contracts/canvas";
import { asText, checkPaoHome, loadDriver, reasonOf } from "./bridge-common";
import type {
  PaoDesktopWorkflowModule,
  PaoRecipeCatalog,
  PaoTierAdmin,
  PaoWorkflowPreview,
  PaoWorkflowRecipe,
} from "@pi-gui/pi-sdk-driver";

function issue(code: CanvasUnavailableCode, message: string): WorkflowWizardUnavailable {
  return { state: "unavailable", code, message };
}

function failure(message: unknown): WorkflowMutationResult {
  return { state: "error", message: reasonOf(message) };
}

/** Load the fork workflow bridge re-export; overridable so unit tests stay hermetic. */
async function loadDefaultModule(): Promise<PaoDesktopWorkflowModule> {
  return (await loadDriver("loadPaoDesktopWorkflow"))();
}

/** Load the tier admin loader (kernel load/save via driver); overridable so unit tests stay hermetic. */
async function loadDefaultTierAdmin(): Promise<PaoTierAdmin> {
  return (await loadDriver("loadPaoTierAdmin"))();
}

export interface WorkflowWizardBridgeOptions {
  /** Overrides process.env.PAO_HOME (tests). */
  readonly paoHome?: string;
  /** Overrides the lazy driver import (tests). */
  readonly loadModule?: () => Promise<PaoDesktopWorkflowModule>;
  /** Overrides the lazy tier admin import (tests). */
  readonly loadTierAdmin?: () => Promise<PaoTierAdmin>;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 档位行整形：缺名的坏行剔除（fork 侧 loadTierConfig 已校验，这里只防传输损伤）。 */
function normalizeTier(value: unknown): WizardTier | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const name = asText(record["名"]).trim();
  if (!name) return undefined;
  return {
    name,
    provider: asText(record["provider"]),
    model: asText(record["model"]),
    thinkingLevel: asText(record["thinkingLevel"]),
  };
}

/** 目录整形：坏配方行剔除进 errors，不静默当有效条目。
 *  剔除口径（S2 选项一）：配方行须为对象、节点须为对象数组，形状坏/缺名字缺节点的行进
 *  errors（与内核 readDesktopRecipeCatalog 把坏文件记进 errors 的语义对齐：坏行显式上报，
 *  不伪装空目录，也不让裸断言类型进目录快照）；深度契约单源＝内核 parseRecipe。 */
export function normalizeCatalog(value: PaoRecipeCatalog): WorkflowCatalogSnapshot {
  const errors = [...value.errors.map((row) => asText(row))].filter((row) => row.trim() !== "");
  const recipes = [];
  for (const entry of value.recipes) {
    const recipe = entry?.recipe;
    if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)) {
      errors.push("工作流目录返回了非对象的工作流行");
      continue;
    }
    const name = asText(recipe["名字"]).trim();
    const nodes = recipe["节点"];
    if (!name || !Array.isArray(nodes)) {
      errors.push(`${asText(recipe["名字"]) || "工作流"}: 名字或节点缺失`);
      continue;
    }
    if (!nodes.every((node) => isRecipeRowObject(node))) {
      errors.push(`${name}: 节点行形状损坏`);
      continue;
    }
    recipes.push({
      name,
      revision: asText(entry?.revision),
      recipe: recipe as WizardRecipe,
    });
  }
  return {
    state: "available",
    recipes,
    departments: value.departments.map((row) => asText(row)).filter((row) => row.trim() !== ""),
    skills: value.skills.map((row) => asText(row)).filter((row) => row.trim() !== ""),
    tiers: value.tiers.flatMap((row) => {
      const tier = normalizeTier(row);
      return tier ? [tier] : [];
    }),
    thinkingLevels: value.thinkingLevels
      .map((row) => asText(row))
      .filter((row) => row.trim() !== ""),
    templates: value.templates.flatMap((row) => {
      if (!row || typeof row !== "object") return [];
      const record = row as Record<string, unknown>;
      const id = asText(record["id"]).trim();
      if (!id) return [];
      return [
        {
          id,
          name: asText(record["name"]).trim() || id,
          description: asText(record["description"]),
        },
      ];
    }),
    errors,
  };
}

/** 预检报告整形：items/nodes/预算逐行透传（level 中文原样，红项判定＝!canStart）。 */
export function normalizePreview(value: PaoWorkflowPreview): WorkflowPreflightReport {
  return {
    canStart: value.report?.canStart === true,
    checkedAt: asText(value.report?.checkedAt),
    items: (Array.isArray(value.report?.items) ? value.report.items : []).map((row) => {
      const record = (row ?? {}) as Record<string, unknown>;
      const evidence = asText(record["evidence"]).trim();
      return {
        level: asText(record["level"]).trim() || "未验证",
        subject: asText(record["subject"]),
        reason: asText(record["reason"]),
        suggestion: asText(record["suggestion"]),
        ...(evidence ? { evidence } : {}),
      };
    }),
    nodes: (Array.isArray(value["节点"]) ? value["节点"] : []).map((row) => {
      const record = (row ?? {}) as Record<string, unknown>;
      return {
        name: asText(record["名字"]),
        dept: asText(record["部门"]),
        model: asText(record["模型"]),
        thinkingLevel: asText(record["思考强度"]),
        skills: Array.isArray(record["技能"])
          ? record["技能"].map((item) => asText(item)).filter((item) => item.trim() !== "")
          : [],
        workerLimit: typeof record["工人上限"] === "number" ? record["工人上限"] : 1,
      };
    }),
    budget: {
      cost: asNumberOrNull(value["预算"]?.cost),
      turns: asNumberOrNull(value["预算"]?.turns),
      toolCalls: asNumberOrNull(value["预算"]?.toolCalls),
      note: asText(value["预算"]?.["说明"]),
    },
  };
}

/** 配方行最小形状（与 ipc/request-validation 同一口径：非对象行不进断言类型；深度契约单源＝内核 parseRecipe，
 *  桥层只做骨架预检快速失败，不在桌面层重造字段校验）。 */
function isRecipeRowObject(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 校验变更输入的配方骨架（对象＋节点数组＋节点行为对象；结构错＝可展示错误，不抛顶层）。 */
function validRecipeShape(input: { readonly recipe?: unknown }): PaoWorkflowRecipe | undefined {
  const recipe = input.recipe;
  if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)) return undefined;
  const nodes = (recipe as { 节点?: unknown })["节点"];
  if (!Array.isArray(nodes) || !nodes.every(isRecipeRowObject)) return undefined;
  return recipe as PaoWorkflowRecipe;
}

/** 校验会话内变更输入的公共骨架：会话身份＋配方形状。 */
function validMutationInput(input: {
  readonly sessionId?: unknown;
  readonly project?: unknown;
  readonly recipe?: unknown;
}): { sessionId: string; project: string; recipe: PaoWorkflowRecipe } | undefined {
  const sessionId = asText(input.sessionId).trim();
  const project = asText(input.project).trim();
  const recipe = validRecipeShape(input);
  if (!sessionId || !project || !recipe) return undefined;
  return { sessionId, project, recipe };
}

function normalizeParameters(value: unknown): Record<string, string> {
  const parameters: Record<string, string> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      parameters[key] = asText(entry);
    }
  }
  return parameters;
}

export interface WorkflowWizardBridge {
  /** Never throws; every failure is part of the returned result. */
  readonly collectCatalog: () => Promise<WorkflowCatalogResult>;
  readonly runPreflight: (input: WorkflowPreflightInput) => Promise<WorkflowPreflightResult>;
  readonly installTemplate: (
    input: WorkflowTemplateInstallInput,
  ) => Promise<WorkflowMutationResult>;
  readonly saveRecipe: (input: WorkflowRecipeSaveInput) => Promise<WorkflowMutationResult>;
  readonly deleteRecipe: (input: WorkflowRecipeDeleteInput) => Promise<WorkflowMutationResult>;
  readonly startWorkflow: (input: WorkflowStartInput) => Promise<WorkflowMutationResult>;
  /** S9-2 档位管理：增改一档直写 pao配置/档位.json（内核重名校验＋备份＋原子写）。 */
  readonly saveTier: (input: WorkflowTierSaveInput) => Promise<WorkflowMutationResult>;
}

export function createWorkflowWizardBridge(
  options: WorkflowWizardBridgeOptions = {},
): WorkflowWizardBridge {
  const home = (): Promise<string | WorkflowWizardUnavailable> => checkPaoHome(options.paoHome);
  const module = () =>
    (options.loadModule ?? loadDefaultModule)().catch((error: unknown) => {
      throw new Error(
        error instanceof Error ? error.message : `workflow bridge unavailable: ${String(error)}`,
      );
    });
  const tierAdmin = () =>
    (options.loadTierAdmin ?? loadDefaultTierAdmin)().catch((error: unknown) => {
      throw new Error(
        error instanceof Error ? error.message : `tier admin unavailable: ${String(error)}`,
      );
    });
  return {
    async collectCatalog(): Promise<WorkflowCatalogResult> {
      const paoHome = await home();
      if (typeof paoHome !== "string") return paoHome;
      try {
        return normalizeCatalog((await module()).readDesktopRecipeCatalog(paoHome));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return issue("aggregates-unavailable", reason);
      }
    },
    async runPreflight(input): Promise<WorkflowPreflightResult> {
      const paoHome = await home();
      if (typeof paoHome !== "string") return { state: "failed", message: paoHome.message };
      const recipe = validRecipeShape(input);
      const project = asText(input.project).trim();
      if (!recipe || !project) {
        return { state: "failed", message: "预检输入不完整：需要项目路径与有效工作流。" };
      }
      try {
        const preview = (await module()).previewDesktopWorkflow(
          paoHome,
          project,
          recipe,
          normalizeParameters(input.parameters),
        );
        return { state: "ok", report: normalizePreview(preview) };
      } catch (error) {
        return { state: "failed", message: error instanceof Error ? error.message : String(error) };
      }
    },
    async installTemplate(input): Promise<WorkflowMutationResult> {
      const paoHome = await home();
      if (typeof paoHome !== "string") return { state: "error", message: paoHome.message };
      const sessionId = asText(input.sessionId).trim();
      const project = asText(input.project).trim();
      const templateId = asText(input.templateId).trim();
      const name = asText(input.name).trim();
      if (!sessionId || !project || !templateId) {
        return { state: "error", message: "安装模板需要有效的当前会话与模板。" };
      }
      try {
        await (
          await module()
        ).installDesktopTemplate(sessionId, project, templateId, name || undefined);
        return { state: "ok" };
      } catch (error) {
        return failure(error);
      }
    },
    async saveRecipe(input): Promise<WorkflowMutationResult> {
      const skeleton = validMutationInput(input);
      const revision = input.revision === null ? null : asText(input.revision);
      if (!skeleton || revision === "") {
        return { state: "error", message: "保存工作流需要有效的当前会话、工作流与版本指纹。" };
      }
      try {
        await (
          await module()
        ).saveDesktopRecipe(skeleton.sessionId, skeleton.project, skeleton.recipe, revision);
        return { state: "ok" };
      } catch (error) {
        return failure(error);
      }
    },
    async startWorkflow(input): Promise<WorkflowMutationResult> {
      const skeleton = validMutationInput(input);
      const revision = asText(input.revision);
      const masterTier = asText(input.masterTier).trim();
      const thinking = asText(input.thinking).trim();
      if (!skeleton || !revision || !masterTier || !thinking) {
        return { state: "error", message: "启动需要当前会话、工作流、主控档位与思考强度。" };
      }
      try {
        await (
          await module()
        ).startDesktopWorkflow(
          skeleton.sessionId,
          skeleton.project,
          skeleton.recipe,
          revision,
          normalizeParameters(input.parameters),
          masterTier,
          thinking,
        );
        return { state: "ok" };
      } catch (error) {
        return failure(error);
      }
    },
    async deleteRecipe(input): Promise<WorkflowMutationResult> {
      const paoHome = await home();
      if (typeof paoHome !== "string") return { state: "error", message: paoHome.message };
      const sessionId = asText(input.sessionId).trim();
      const project = asText(input.project).trim();
      const name = asText(input.name).trim();
      const revision = input.revision === null ? null : asText(input.revision);
      if (!sessionId || !project || !name || revision === "") {
        return { state: "error", message: "删除工作流需要有效的当前会话、工作流名与版本指纹。" };
      }
      try {
        await (await module()).deleteDesktopRecipe(sessionId, project, name, revision);
        return { state: "ok" };
      } catch (error) {
        return failure(error);
      }
    },
    async saveTier(input): Promise<WorkflowMutationResult> {
      const paoHome = await home();
      if (typeof paoHome !== "string") return { state: "error", message: paoHome.message };
      const tier = input?.tier;
      const name = asText(tier?.name).trim();
      const provider = asText(tier?.provider).trim();
      const model = asText(tier?.model).trim();
      const thinkingLevel = asText(tier?.thinkingLevel).trim();
      const editing = input.editing === undefined || input.editing === null ? undefined : asText(input.editing).trim() || undefined;
      if (!name || !provider || !model || !thinkingLevel) {
        return { state: "error", message: "保存档位需要档名、provider、model 与推荐思考档。" };
      }
      try {
        await (await tierAdmin()).upsert(paoHome, { 名: name, provider, model, thinkingLevel }, editing);
        return { state: "ok" };
      } catch (error) {
        return failure(error);
      }
    },
  };
}
