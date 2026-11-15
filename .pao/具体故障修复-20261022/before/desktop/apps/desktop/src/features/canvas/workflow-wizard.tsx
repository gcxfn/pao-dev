import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  WorkflowCatalogResult,
  WorkflowCatalogSnapshot,
  WorkflowMutationResult,
  WorkflowPreflightResult,
  WorkflowTierSaveInput,
  WizardRecipe,
  WizardTier,
} from "../../../contracts/workflow-wizard";
import type { PiDesktopApi } from "../../../contracts/ipc";
import { useI18n } from "../../i18n/react";
import {
  formForNode,
  materializeRecipe,
  recipeDirty,
  redItems,
  requiredParams,
  substitutePreview,
  type WizardOverrideForms,
} from "./workflow-wizard-model";

/**
 * 启流向导（P4-3，设计包 §2 四步流）：选配方（含出厂模板三卡，安装走会话内确认）
 * → 参数代入（必填校验＋代入预览）→ 节点级覆盖（模型档位/思考强度/预算，缺省＝配方值）
 * → 预检（fork 同源闸门，红项禁启）→ 启动（保存覆盖后经会话内 owner＋显式确认启流）。
 * 预检权威判定在主进程桥；本组件只做展示与禁用。
 */

export interface WorkflowWizardIdentity {
  readonly sessionId: string;
  readonly project: string;
}

type WizardStep = "select" | "params" | "nodes" | "preflight";

export interface WizardSelection {
  readonly name: string;
  readonly revision: string;
  readonly recipe: WizardRecipe;
}

export interface WorkflowWizardProps {
  readonly api: PiDesktopApi;
  /** 当前主控会话身份（active thread）；缺省时模板安装与启动禁用并提示。 */
  readonly identity?: WorkflowWizardIdentity;
  readonly onClose: () => void;
  readonly onStarted: (recipeName: string) => void;
  readonly initialRecipeName?: string;
}

export function WorkflowWizard({
  api,
  identity,
  onClose,
  onStarted,
  initialRecipeName,
}: WorkflowWizardProps) {
  const { t } = useI18n();
  const [catalog, setCatalog] = useState<WorkflowCatalogSnapshot | undefined>();
  const [unavailable, setUnavailable] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState<WizardStep>("select");
  const [selected, setSelected] = useState<WizardSelection | undefined>();
  const [parameters, setParameters] = useState<Record<string, string>>({});
  const [forms, setForms] = useState<WizardOverrideForms>({});
  const [masterTier, setMasterTier] = useState("");
  const [thinking, setThinking] = useState("");
  const [preflight, setPreflight] = useState<WorkflowPreflightResult | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [started, setStarted] = useState(false);

  const loadCatalog = useCallback(
    async (options: { readonly quiet?: boolean } = {}): Promise<WorkflowCatalogSnapshot | undefined> => {
      // quiet＝已展示过目录后的刷新（档位保存/模板安装后）：不翻转 loading，
      // 避免向导体卸载重挂清空预检步与档位管理面板的本地状态。
      if (!options.quiet) setLoading(true);
      try {
        const result: WorkflowCatalogResult = await api.getWorkflowCatalog();
        if (result.state === "available") {
          setCatalog(result);
          setUnavailable(undefined);
          return result;
        }
        setUnavailable(result.message);
        return undefined;
      } catch (cause) {
        setUnavailable(cause instanceof Error ? cause.message : String(cause));
        return undefined;
      } finally {
        if (!options.quiet) setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    let cancelled = false;
    void loadCatalog()
      .then((value) => {
        if (cancelled || !initialRecipeName || !value) return;
        const entry = value.recipes.find((row) => row.name === initialRecipeName);
        if (!entry) {
          setError("当前工作流未能读回，请关闭后重新加载。");
          return;
        }
        setSelected({ name: entry.name, revision: entry.revision, recipe: entry.recipe });
        setStep("params");
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
    return () => {
      cancelled = true;
    };
  }, [loadCatalog, initialRecipeName]);

  const effectiveRecipe = useMemo(
    () => (selected ? materializeRecipe(selected.recipe, forms) : undefined),
    [selected, forms],
  );
  const dirty = useMemo(
    () => (selected ? recipeDirty(selected.recipe, forms) : false),
    [selected, forms],
  );
  const params = useMemo(() => (selected ? requiredParams(selected.recipe) : []), [selected]);
  const paramsComplete = params.every((name) => (parameters[name] ?? "").trim() !== "");

  const resetDownstream = () => {
    setPreflight(undefined);
    setError("");
  };
  const chooseRecipe = (selection: WizardSelection) => {
    setSelected(selection);
    setParameters({});
    setForms({});
    resetDownstream();
    setStep("params");
  };

  const installTemplate = async (templateId: string, templateName: string) => {
    if (!identity || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.installWorkflowTemplate({
        sessionId: identity.sessionId,
        project: identity.project,
        templateId,
      });
      if (result.state === "error") {
        setError(result.message);
        return;
      }
      const next = await loadCatalog();
      const installed = next?.recipes.find((entry) => entry.name === templateName);
      if (installed) {
        chooseRecipe({
          name: installed.name,
          revision: installed.revision,
          recipe: installed.recipe,
        });
      } else {
        setError(t("The template was installed but its recipe was not found; pick it manually."));
      }
    } finally {
      setBusy(false);
    }
  };

  const runPreflight = async () => {
    if (!identity || !effectiveRecipe || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.runWorkflowPreflight({
        project: identity.project,
        recipe: effectiveRecipe,
        parameters,
      });
      setPreflight(result);
      if (result.state === "failed") setError(result.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (step === "preflight" && preflight === undefined && !busy && effectiveRecipe) {
      void runPreflight().catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
    }
  }, [step]);

  const start = async () => {
    if (!identity || !selected || !effectiveRecipe || busy) return;
    setBusy(true);
    setError("");
    try {
      let revision = selected.revision;
      let recipeToStart = effectiveRecipe;
      if (dirty) {
        const saved = await api.saveWorkflowRecipe({
          sessionId: identity.sessionId,
          project: identity.project,
          recipe: effectiveRecipe,
          revision,
        });
        if (saved.state === "error") {
          setError(saved.message);
          return;
        }
        const next = await loadCatalog();
        const fresh = next?.recipes.find((entry) => entry.name === selected.name);
        if (!fresh) {
          setError(t("The saved recipe disappeared from the catalog; reopen the wizard."));
          return;
        }
        revision = fresh.revision;
        recipeToStart = effectiveRecipe;
        setSelected({ name: selected.name, revision, recipe: selected.recipe });
      }
      const result = await api.startWorkflow({
        sessionId: identity.sessionId,
        project: identity.project,
        recipe: recipeToStart,
        revision,
        parameters,
        masterTier,
        thinking,
      });
      if (result.state === "error") {
        setError(result.message);
        return;
      }
      setStarted(true);
      onStarted(recipeToStart.名字);
    } finally {
      setBusy(false);
    }
  };

  /** S9-2 档位管理：保存成功即静默刷新目录（不卸载向导体，新档位立刻进主控档位下拉）。 */
  const saveTier = useCallback(
    async (input: WorkflowTierSaveInput): Promise<WorkflowMutationResult> => {
      setBusy(true);
      try {
        const result = await api.saveWorkflowTier(input);
        if (result.state === "ok") await loadCatalog({ quiet: true });
        return result;
      } finally {
        setBusy(false);
      }
    },
    [api, loadCatalog],
  );

  const tiers = catalog?.tiers ?? [];
  const thinkingLevels = catalog?.thinkingLevels ?? [];

  return (
    <section className="wizard wizard-overlay" data-testid="workflow-wizard" role="dialog">
      <header className="wizard__header">
        <h2>{t("Start a workflow")}</h2>
        <button className="button" type="button" onClick={onClose}>
          {t("Close")}
        </button>
      </header>

      {loading ? (
        <p className="wizard-status" role="status">
          {t("Loading…")}
        </p>
      ) : null}
      {unavailable ? (
        <p className="error-banner" role="alert" data-testid="wizard-unavailable">
          {unavailable}
        </p>
      ) : null}
      {error ? (
        <p className="error-banner" role="alert" data-testid="wizard-error">
          {error}
        </p>
      ) : null}

      {started ? (
        <div className="wizard__body" data-testid="wizard-started">
          <p>
            {t(
              "The workflow has been started in the master session. The canvas will show it after a refresh.",
            )}
          </p>
          <button className="button" type="button" onClick={onClose}>
            {t("Done")}
          </button>
        </div>
      ) : catalog && !loading ? (
        <div className="wizard__body">
          <ol className="wizard__steps" data-testid="wizard-steps">
            <StepBadge active={step === "select"} done={step !== "select"} label={t("Recipe")} />
            <StepBadge
              active={step === "params"}
              done={step === "nodes" || step === "preflight"}
              label={t("Parameters")}
            />
            <StepBadge
              active={step === "nodes"}
              done={step === "preflight"}
              label={t("Node overrides")}
            />
            <StepBadge
              active={step === "preflight"}
              done={false}
              label={t("Preflight and start")}
            />
          </ol>

          {step === "select" ? (
            <WizardSelectStep
              catalog={catalog}
              busy={busy}
              hasIdentity={identity !== undefined}
              onSelect={chooseRecipe}
              onInstallTemplate={(id, name) => {
                void installTemplate(id, name).catch((cause: unknown) =>
                  setError(cause instanceof Error ? cause.message : String(cause)),
                );
              }}
            />
          ) : null}

          {step === "params" && selected ? (
            <WizardParamsStep
              recipe={selected.recipe}
              parameters={parameters}
              onParameterChange={(name, value) => {
                setParameters((prev) => ({ ...prev, [name]: value }));
                resetDownstream();
              }}
              complete={paramsComplete}
              onBack={() => setStep("select")}
              onNext={() => setStep("nodes")}
            />
          ) : null}

          {step === "nodes" && selected && effectiveRecipe ? (
            <WizardNodesStep
              recipe={effectiveRecipe}
              forms={forms}
              tiers={tiers.map((tier) => tier.name)}
              thinkingLevels={thinkingLevels}
              parameters={parameters}
              onFormChange={(node, patch) => {
                setForms((prev) => {
                  const baseNode = findNode(selected.recipe, node);
                  const initial = baseNode ? formForNode(baseNode) : undefined;
                  return { ...prev, [node]: { ...initial, ...prev[node], ...patch } };
                });
                resetDownstream();
              }}
              onBack={() => setStep("params")}
              onNext={() => setStep("preflight")}
            />
          ) : null}

          {step === "preflight" && selected && effectiveRecipe ? (
            <WizardPreflightStep
              preflight={preflight}
              busy={busy}
              dirty={dirty}
              tiers={tiers}
              thinkingLevels={thinkingLevels}
              masterTier={masterTier}
              thinking={thinking}
              hasIdentity={identity !== undefined}
              onMasterTierChange={(value) => {
                setMasterTier(value);
                const tier = tiers.find((entry) => entry.name === value);
                if (tier) setThinking(tier.thinkingLevel);
              }}
              onThinkingChange={setThinking}
              onRerun={() => {
                void runPreflight().catch((cause: unknown) =>
                  setError(cause instanceof Error ? cause.message : String(cause)),
                );
              }}
              onBack={() => setStep("nodes")}
              onStart={() => {
                void start().catch((cause: unknown) =>
                  setError(cause instanceof Error ? cause.message : String(cause)),
                );
              }}
              onSaveTier={saveTier}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function findNode(recipe: WizardRecipe, name: string): WizardRecipe["节点"][number] | undefined {
  return recipe.节点.find((node) => node.名字 === name);
}

function StepBadge({
  active,
  done,
  label,
}: {
  readonly active: boolean;
  readonly done: boolean;
  readonly label: string;
}) {
  return (
    <li
      className={`wizard-step${active ? " wizard-step--active" : ""}${done ? " wizard-step--done" : ""}`}
    >
      {done ? `✓ ${label}` : label}
    </li>
  );
}

export function WizardSelectStep({
  catalog,
  busy,
  hasIdentity,
  onSelect,
  onInstallTemplate,
}: {
  readonly catalog: WorkflowCatalogSnapshot;
  readonly busy: boolean;
  readonly hasIdentity: boolean;
  readonly onSelect: (selection: WizardSelection) => void;
  readonly onInstallTemplate: (templateId: string, templateName: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="wizard-pane" data-testid="wizard-select">
      <h3>{t("Start from a template")}</h3>
      {!hasIdentity ? (
        <p className="wizard-hint" data-testid="wizard-template-no-session">
          {t("Installing a template needs an active master session; open one first.")}
        </p>
      ) : null}
      <div className="wizard-templates">
        {catalog.templates.map((template) => (
          <button
            className="wizard-template"
            data-testid="wizard-template-card"
            disabled={busy || !hasIdentity}
            key={template.id}
            type="button"
            onClick={() => onInstallTemplate(template.id, template.name)}
          >
            <strong>{template.name}</strong>
            <span className="wizard-template__desc">{template.description}</span>
          </button>
        ))}
      </div>

      <h3>{t("Recipes")}</h3>
      {catalog.recipes.length === 0 ? (
        <p className="wizard-hint">{t("None")}</p>
      ) : (
        <ul className="wizard-rows">
          {catalog.recipes.map((entry) => (
            <li key={entry.name}>
              <button
                className="wizard-row"
                data-testid="wizard-recipe-row"
                disabled={busy}
                type="button"
                onClick={() =>
                  onSelect({ name: entry.name, revision: entry.revision, recipe: entry.recipe })
                }
              >
                <strong>{entry.name}</strong>
                <span className="wizard-row__meta">
                  {t("{count} nodes", { count: entry.recipe.节点.length })} ·{" "}
                  {t("{count} params", { count: entry.recipe.参数.length })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {catalog.errors.length > 0 ? (
        <ul className="wizard-errors" data-testid="wizard-catalog-errors">
          {catalog.errors.map((row) => (
            <li key={row}>{row}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function WizardParamsStep({
  recipe,
  parameters,
  onParameterChange,
  complete,
  onBack,
  onNext,
}: {
  readonly recipe: WizardRecipe;
  readonly parameters: Record<string, string>;
  readonly onParameterChange: (name: string, value: string) => void;
  readonly complete: boolean;
  readonly onBack: () => void;
  readonly onNext: () => void;
}) {
  const { t } = useI18n();
  const params = requiredParams(recipe);
  return (
    <div className="wizard-pane" data-testid="wizard-params">
      <h3>{t("Parameters")}</h3>
      {params.length === 0 ? (
        <p className="wizard-hint">{t("This recipe takes no parameters.")}</p>
      ) : (
        params.map((name) => (
          <label className="wizard-field" key={name}>
            <span>
              {name}
              {(parameters[name] ?? "").trim() === "" ? (
                <em className="wizard-required"> {t("(required)")}</em>
              ) : null}
            </span>
            <input
              data-param={name}
              data-testid="wizard-param-input"
              onChange={(event) => onParameterChange(name, event.target.value)}
              type="text"
              value={parameters[name] ?? ""}
            />
          </label>
        ))
      )}
      <h3>{t("Substitution preview")}</h3>
      <ul className="wizard-preview" data-testid="wizard-param-preview">
        {recipe.节点.map((node) => (
          <li key={node.名字}>
            <strong>{node.名字}</strong>
            <span>
              {substitutePreview(String(node.部门 ?? ""), parameters)}
              {typeof node.模型 === "string" && node.模型
                ? ` · ${substitutePreview(node.模型, parameters)}`
                : typeof node.档位 === "string" && node.档位
                  ? ` · ${substitutePreview(node.档位, parameters)}`
                  : ""}
            </span>
          </li>
        ))}
      </ul>
      <div className="wizard-actions">
        <button className="button" type="button" onClick={onBack}>
          {t("Back")}
        </button>
        <button className="button" disabled={!complete} type="button" onClick={onNext}>
          {t("Next")}
        </button>
      </div>
    </div>
  );
}

export function WizardNodesStep({
  recipe,
  forms,
  tiers,
  thinkingLevels,
  parameters,
  onFormChange,
  onBack,
  onNext,
}: {
  readonly recipe: WizardRecipe;
  readonly forms: WizardOverrideForms;
  readonly tiers: readonly string[];
  readonly thinkingLevels: readonly string[];
  readonly parameters: Record<string, string>;
  readonly onFormChange: (
    node: string,
    patch: Partial<
      Record<"model" | "thinkingLevel" | "budgetTurns" | "budgetToolCalls" | "budgetCost", string>
    >,
  ) => void;
  readonly onBack: () => void;
  readonly onNext: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="wizard-pane" data-testid="wizard-nodes">
      <h3>{t("Node overrides")}</h3>
      <p className="wizard-hint">
        {t("Empty fields keep the recipe value; overrides are saved before starting.")}
      </p>
      {recipe.节点.map((node) => {
        const initial = formForNode(node);
        const form = { ...initial, ...forms[node.名字] };
        const modelValue =
          typeof node.模型 === "string"
            ? node.模型
            : typeof node.档位 === "string"
              ? node.档位
              : "";
        const modelOptions = [...new Set(["", ...tiers, modelValue])];
        return (
          <fieldset className="wizard-node" data-testid="wizard-node-form" key={node.名字}>
            <legend>
              {node.名字} · {substitutePreview(String(node.部门 ?? ""), parameters)}
            </legend>
            <label className="wizard-field">
              <span>{t("Model / tier")}</span>
              <select
                data-node={node.名字}
                data-testid="wizard-node-model"
                onChange={(event) => onFormChange(node.名字, { model: event.target.value })}
                value={form.model}
              >
                {modelOptions.map((value) => (
                  <option key={value} value={value}>
                    {value === "" ? t("Recipe value") : value}
                  </option>
                ))}
              </select>
            </label>
            {(() => {
              const rawModel = typeof node.模型 === "string" ? node.模型 : undefined;
              const rawTier = typeof node.档位 === "string" ? node.档位 : undefined;
              const effective = form.model !== "" ? form.model : (rawModel ?? rawTier ?? "");
              return effective === "" ? null : (
                <p className="wizard-hint">
                  {t("Effective")}: {effective}
                </p>
              );
            })()}
            <label className="wizard-field">
              <span>{t("Thinking level")}</span>
              <select
                data-node={node.名字}
                data-testid="wizard-node-thinking"
                onChange={(event) => onFormChange(node.名字, { thinkingLevel: event.target.value })}
                value={form.thinkingLevel}
              >
                <option value="">{t("Recipe value")}</option>
                {thinkingLevels.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <div className="wizard-budget">
              <label className="wizard-field">
                <span>{t("Budget turns")}</span>
                <input
                  data-testid="wizard-node-budget-turns"
                  inputMode="numeric"
                  onChange={(event) => onFormChange(node.名字, { budgetTurns: event.target.value })}
                  type="text"
                  value={form.budgetTurns}
                />
              </label>
              <label className="wizard-field">
                <span>{t("Budget tool calls")}</span>
                <input
                  data-testid="wizard-node-budget-toolcalls"
                  inputMode="numeric"
                  onChange={(event) =>
                    onFormChange(node.名字, { budgetToolCalls: event.target.value })
                  }
                  type="text"
                  value={form.budgetToolCalls}
                />
              </label>
              <label className="wizard-field">
                <span>{t("Budget cost")}</span>
                <input
                  data-testid="wizard-node-budget-cost"
                  inputMode="decimal"
                  onChange={(event) => onFormChange(node.名字, { budgetCost: event.target.value })}
                  type="text"
                  value={form.budgetCost}
                />
              </label>
            </div>
            {node.人工确认 === true ? (
              <p className="wizard-hint">✋ {t("Human confirmation")}</p>
            ) : null}
          </fieldset>
        );
      })}
      <div className="wizard-actions">
        <button className="button" type="button" onClick={onBack}>
          {t("Back")}
        </button>
        <button className="button" type="button" onClick={onNext}>
          {t("Next")}
        </button>
      </div>
    </div>
  );
}

export function WizardPreflightStep({
  preflight,
  busy,
  dirty,
  tiers,
  thinkingLevels,
  masterTier,
  thinking,
  hasIdentity,
  onMasterTierChange,
  onThinkingChange,
  onRerun,
  onBack,
  onStart,
  onSaveTier,
}: {
  readonly preflight: WorkflowPreflightResult | undefined;
  readonly busy: boolean;
  readonly dirty: boolean;
  readonly tiers: readonly WizardTier[];
  readonly thinkingLevels: readonly string[];
  readonly masterTier: string;
  readonly thinking: string;
  readonly hasIdentity: boolean;
  readonly onMasterTierChange: (value: string) => void;
  readonly onThinkingChange: (value: string) => void;
  readonly onRerun: () => void;
  readonly onBack: () => void;
  readonly onStart: () => void;
  readonly onSaveTier: (input: WorkflowTierSaveInput) => Promise<WorkflowMutationResult>;
}) {
  const { t } = useI18n();
  const report = preflight?.state === "ok" ? preflight.report : undefined;
  const blocked = report ? !report.canStart : false;
  const red = report ? redItems(report.items) : [];
  return (
    <div className="wizard-pane" data-testid="wizard-preflight">
      <h3>{t("Preflight and start")}</h3>
      {dirty ? (
        <p className="wizard-hint" data-testid="wizard-dirty-hint">
          {t("Node overrides will be saved before starting.")}
        </p>
      ) : null}
      <div className="wizard-actions">
        <button className="button" disabled={busy} type="button" onClick={onRerun}>
          {t("Run preflight")}
        </button>
      </div>

      {preflight?.state === "failed" ? (
        <p className="error-banner" role="alert" data-testid="wizard-preflight-failed">
          {preflight.message}
        </p>
      ) : null}

      {report ? (
        <>
          <ul className="wizard-checks" data-testid="wizard-checks">
            {report.items.map((item, index) => (
              <li
                className={`wizard-check wizard-check--${item.level === "阻止启动" ? "red" : "warn"}`}
                key={index}
              >
                <strong>
                  [{item.level}] {item.subject}
                </strong>
                <span>{item.reason}</span>
                <span className="wizard-hint">{item.suggestion}</span>
              </li>
            ))}
          </ul>
          {report.nodes.length > 0 ? (
            <details>
              <summary>{t("Node preview after substitution")}</summary>
              <ul className="wizard-preview">
                {report.nodes.map((node) => (
                  <li key={node.name}>
                    <strong>{node.name}</strong>
                    <span>
                      {node.dept} · {node.model} · {node.thinkingLevel}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="wizard-hint">
                {t("Budget")}:{report.budget.turns === null ? " ?" : ` ${report.budget.turns}`}{" "}
                turns /{report.budget.toolCalls === null ? " ?" : ` ${report.budget.toolCalls}`}{" "}
                calls /{report.budget.cost === null ? " ?" : ` ${report.budget.cost}`} cost
              </p>
            </details>
          ) : null}
          {blocked ? (
            <p className="error-banner" role="alert" data-testid="wizard-blocked">
              {t("Blocking issues must be resolved before this workflow can start.")} ({red.length})
            </p>
          ) : (
            <p className="wizard-ok" data-testid="wizard-can-start">
              {t("No blocking issues found.")}
            </p>
          )}
        </>
      ) : busy ? (
        <p className="wizard-status" role="status">
          {t("Checking…")}
        </p>
      ) : null}

      <h3>{t("Master session")}</h3>
      {!hasIdentity ? (
        <p className="wizard-hint" data-testid="wizard-no-session">
          {t("Starting needs an active master session; open one first.")}
        </p>
      ) : null}
      <label className="wizard-field">
        <span>{t("Master tier")}</span>
        <select
          data-testid="wizard-master-tier"
          onChange={(event) => onMasterTierChange(event.target.value)}
          value={masterTier}
        >
          <option value="">{t("Select a tier")}</option>
          {tiers.map((tier) => (
            <option key={tier.name} value={tier.name}>
              {tier.name} ({tier.provider}/{tier.model})
            </option>
          ))}
        </select>
      </label>
      <label className="wizard-field">
        <span>{t("Thinking level")}</span>
        <select
          data-testid="wizard-thinking"
          onChange={(event) => onThinkingChange(event.target.value)}
          value={thinking}
        >
          <option value="">{t("Select a level")}</option>
          {thinkingLevels.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <TierManagerPanel
        tiers={tiers}
        thinkingLevels={thinkingLevels}
        disabled={busy}
        onSave={onSaveTier}
      />
      <p className="wizard-hint">
        {t("Starting sends the plan to the master session for an explicit confirmation.")}
      </p>

      <div className="wizard-actions">
        <button className="button" type="button" onClick={onBack}>
          {t("Back")}
        </button>
        <button
          className="button button--primary"
          data-testid="wizard-start"
          disabled={busy || blocked || !report || !masterTier || !thinking || !hasIdentity}
          type="button"
          onClick={onStart}
        >
          {t("Start workflow")}
        </button>
      </div>
    </div>
  );
}

/**
 * S9-2 档位管理面板：向导预检步内增改档位，直写 pao配置/档位.json。
 * 编辑对象下拉选现有档＝改（原名进 editing）；「新建档位」＝追加（重名由内核拒绝）。
 * provider/model 手输斜杠合写（与 fork /pao model 手输后门同口径）；
 * 保存成功后由父层刷新目录，新档位立刻进主控档位下拉（对已运行会话需重开会话生效）。
 */
export function TierManagerPanel({
  tiers,
  thinkingLevels,
  disabled,
  onSave,
}: {
  readonly tiers: readonly WizardTier[];
  readonly thinkingLevels: readonly string[];
  readonly disabled: boolean;
  readonly onSave: (input: WorkflowTierSaveInput) => Promise<WorkflowMutationResult>;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState("");
  const [name, setName] = useState("");
  const [providerModel, setProviderModel] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState("");
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);

  const pickTier = (value: string) => {
    setEditing(value);
    const tier = tiers.find((entry) => entry.name === value);
    setName(tier?.name ?? "");
    setProviderModel(tier ? `${tier.provider}/${tier.model}` : "");
    setThinkingLevel(tier?.thinkingLevel ?? "");
    setStatus("");
  };

  const save = async () => {
    const [provider, model] = providerModel.trim().split("/");
    if (!name.trim() || !provider?.trim() || !model?.trim() || !thinkingLevel) {
      setStatus(t("Fill in the tier name, provider/model and thinking level."));
      return;
    }
    setSaving(true);
    setStatus("");
    try {
      const result = await onSave({
        tier: { name: name.trim(), provider: provider.trim(), model: model.trim(), thinkingLevel },
        ...(editing ? { editing } : {}),
      });
      if (result.state === "error") {
        setStatus(result.message);
        return;
      }
      // 先清表单再设状态：pickTier 会 setStatus("")，顺序反了会把成功提示清掉。
      pickTier("");
      setStatus(t("Tier saved."));
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <fieldset className="wizard-node" data-testid="wizard-tier-manager">
      <legend>{t("Manage tiers")}</legend>
      <label className="wizard-field">
        <span>{t("Edit tier")}</span>
        <select
          data-testid="wizard-tier-picker"
          onChange={(event) => pickTier(event.target.value)}
          value={editing}
        >
          <option value="">{t("New tier")}</option>
          {tiers.map((tier) => (
            <option key={tier.name} value={tier.name}>
              {tier.name} ({tier.provider}/{tier.model})
            </option>
          ))}
        </select>
      </label>
      <label className="wizard-field">
        <span>{t("Tier name")}</span>
        <input
          data-testid="wizard-tier-name"
          onChange={(event) => setName(event.target.value)}
          type="text"
          value={name}
        />
      </label>
      <label className="wizard-field">
        <span>{t("Physical model (provider/model)")}</span>
        <input
          data-testid="wizard-tier-model"
          placeholder="zai-coding-cn/glm-5.3"
          onChange={(event) => setProviderModel(event.target.value)}
          type="text"
          value={providerModel}
        />
      </label>
      <label className="wizard-field">
        <span>{t("Recommended thinking level")}</span>
        <select
          data-testid="wizard-tier-thinking"
          onChange={(event) => setThinkingLevel(event.target.value)}
          value={thinkingLevel}
        >
          <option value="">{t("Select a level")}</option>
          {thinkingLevels.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <div className="wizard-actions">
        <button
          className="button"
          data-testid="wizard-tier-save"
          disabled={disabled || saving}
          type="button"
          onClick={() => {
            void save();
          }}
        >
          {t("Save tier")}
        </button>
      </div>
      {status ? (
        <p className="wizard-hint" data-testid="wizard-tier-status">
          {status}
        </p>
      ) : null}
      <p className="wizard-hint">
        {t(
          "Writes pao配置/档位.json with an automatic backup; new tiers apply to new sessions.",
        )}
      </p>
    </fieldset>
  );
}
