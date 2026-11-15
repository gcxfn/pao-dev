import type {
  WizardPreflightItem,
  WizardRecipe,
  WizardRecipeNode,
} from "../../../contracts/workflow-wizard";

/**
 * 启流向导纯函数（P4-3）：必填参数口径、占位符代入预览、节点级覆盖物化、
 * 红项过滤。覆盖写回语义与 fork 编辑器一致——模型档位/思考强度写对应键、
 * 清空只删该键（档位回落）、预算逐键数字、空输入删键；其余字段整体透传不重造。
 */

/** 必填参数＝配方声明参数表（fork requireParams 同口径），空名剔除。 */
export function requiredParams(recipe: WizardRecipe): readonly string[] {
  return recipe.参数.filter((name) => name.trim() !== "");
}

/** 占位符代入预览：{键} 已填显示代入值，未填保持原样（权威判定在预检，不在预览）。 */
export function substitutePreview(text: string, parameters: Readonly<Record<string, string>>): string {
  return text.replace(/\{([^{}]+)\}/g, (whole, key: string) => parameters[key] ?? whole);
}

/** 节点覆盖表单值（字符串态；空串＝清空该字段）。 */
export interface WizardNodeOverrideForm {
  readonly model?: string;
  readonly thinkingLevel?: string;
  readonly budgetTurns?: string;
  readonly budgetToolCalls?: string;
  readonly budgetCost?: string;
}

export type WizardOverrideForms = Readonly<Record<string, WizardNodeOverrideForm>>;

function parseBudgetNumber(value: string | undefined): number | undefined {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** 单节点覆盖物化：表单值落到节点副本（模型/思考强度/预算），其余键原样保留。 */
function materializeNode(node: WizardRecipeNode, form: WizardNodeOverrideForm): WizardRecipeNode {
  const next: Record<string, unknown> = { ...node };
  if (form.model !== undefined) {
    if (form.model.trim()) next["模型"] = form.model.trim();
    else delete next["模型"];
  }
  if (form.thinkingLevel !== undefined) {
    if (form.thinkingLevel.trim()) next["思考强度"] = form.thinkingLevel.trim();
    else delete next["思考强度"];
  }
  const budgetSource = (node["预算"] ?? {}) as Record<string, unknown>;
  const budget: Record<string, unknown> = { ...budgetSource };
  const budgetKeys: readonly [keyof WizardNodeOverrideForm, string][] = [
    ["budgetTurns", "turns"],
    ["budgetToolCalls", "toolCalls"],
    ["budgetCost", "cost"],
  ];
  let budgetTouched = false;
  for (const [formKey, budgetKey] of budgetKeys) {
    if (form[formKey] === undefined) continue;
    budgetTouched = true;
    const parsed = parseBudgetNumber(form[formKey]);
    if (parsed === undefined) delete budget[budgetKey];
    else budget[budgetKey] = parsed;
  }
  if (budgetTouched) {
    if (Object.keys(budget).length > 0) next["预算"] = budget;
    else delete next["预算"];
  }
  return next as WizardRecipeNode;
}

/** 全配方物化：按覆盖表单重建节点数组；未覆盖节点原样引用（整体透传不重造）。 */
export function materializeRecipe(
  recipe: WizardRecipe,
  forms: WizardOverrideForms,
): WizardRecipe {
  const nodes = recipe.节点.map((node) => {
    const form = forms[node.名字];
    return form ? materializeNode(node, form) : node;
  });
  return { ...recipe, 节点: nodes };
}

/** 节点可编辑字段的投影（脏检查口径，与覆盖面严格一致）。 */
function editableProjection(recipe: WizardRecipe): string {
  return JSON.stringify(
    recipe.节点.map((node) => [
      node.名字,
      node["模型"] ?? null,
      node["思考强度"] ?? null,
      node["预算"] ?? null,
    ]),
  );
}

/** 是否存在未保存的节点覆盖（物化结果与目录原配方在可编辑面上有差异）。 */
export function recipeDirty(base: WizardRecipe, forms: WizardOverrideForms): boolean {
  return editableProjection(materializeRecipe(base, forms)) !== editableProjection(base);
}

/** 红项＝「阻止启动」级条目（与 fork PreflightLevel 同源；canStart 即无红项）。 */
export function redItems(items: readonly WizardPreflightItem[]): readonly WizardPreflightItem[] {
  return items.filter((item) => item.level === "阻止启动");
}

/** 表单初值＝配方节点现值（字符串态，供受控输入）。 */
export function formForNode(node: WizardRecipeNode): Required<WizardNodeOverrideForm> {
  const budget = (node["预算"] ?? {}) as Record<string, unknown>;
  return {
    model: typeof node["模型"] === "string" ? node["模型"] : "",
    thinkingLevel: typeof node["思考强度"] === "string" ? node["思考强度"] : "",
    budgetTurns: budget["turns"] === undefined ? "" : String(budget["turns"]),
    budgetToolCalls: budget["toolCalls"] === undefined ? "" : String(budget["toolCalls"]),
    budgetCost: budget["cost"] === undefined ? "" : String(budget["cost"]),
  };
}
