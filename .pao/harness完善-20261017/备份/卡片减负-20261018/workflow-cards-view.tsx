/**
 * 步骤卡工作台（通用工作台阶段 5 / 计划 §7.1）。
 *
 * 页面只做三件事：把内核投影读出来、按状态如实分组展示、把用户的动作变成一句
 * 交给主控的现成指令。页面自己不写盘，也不自己造状态。
 *
 * 真值来源（一个事实一个家，计划 §6.1）：
 * - 步骤定义、意见、成果路径：临时计划投影（`getTemporaryPlans`）；
 * - 步骤现读状态、人工确认门、挂起原因、轮次：控制正本投影（`getWorkflowControl`）；
 * - 文件正文：`readWorkspaceFile`（只读预览，正文以磁盘当前版为准并如实提示版本漂移）。
 *
 * 界面纪律：
 * - 未知状态不译成成功（`unknown`/`unreadable` 各有自己的文案与不依赖颜色的标识）；
 * - 预期成果是「要求」，真实成果是「盘上核实过的文件」，两者分开说；
 * - 完成与审核通过分开显示；取消不伪装成失败；
 * - 动作失败时如实说是失败，且控制正本未被改动。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PiDesktopApi, WorkspaceFilePreview } from "../../../contracts/ipc";
import { getSelectedWorkspace } from "../../../contracts/desktop-state";
import type {
  TemporaryPlanArtifactRow,
  TemporaryPlanFeedbackRow,
  TemporaryPlanRow,
  TemporaryPlanStepProgressRow,
  TemporaryPlanStepRow,
} from "../../../contracts/temporary-plans";
import type {
  WorkflowControlIdentity,
  WorkflowControlNodeRow,
} from "../../../contracts/workflow-control";
import { useI18n } from "../../i18n/react";
import { useViewAutoRefresh } from "../../ui/view-auto-refresh";
import type { PendingHandover } from "./use-master-control-handover";
import {
  FEEDBACK_STATUS_ORDER,
  STEP_CARD_STATE_ICONS,
  STEP_CARD_STATE_LABELS,
  artifactVersions,
  completedStepCount,
  deriveTodos,
  discussionScopeKey,
  fileOpinionGroups,
  fileScopeLabel,
  filterStepCards,
  flowStatusText,
  groupFeedbackByStatus,
  isInFlightState,
  modifyStepInstruction,
  nextPendingStepId,
  opinionInstruction,
  parallelStepGroups,
  pickArtifactVersion,
  saveTemplateInstruction,
  scopeLabel,
  stepCardCounts,
  stepCardRefs,
  stepCardViews,
  stepDuration,
  stepDurationText,
  stepHoldText,
  stepOpinions,
  stepOutputEntries,
  stepParallelGroup,
  stepRoundExecutions,
  stopCardInstruction,
  undoInstruction,
  type DiscussionScope,
  type StepCardDurationCard,
  type StepCardState,
  type StepCardView,
  type StepChanges,
} from "./workflow-cards-model";

/** 顶部摘要与筛选按这组状态固定顺序展示；未列出的细分状态仍在摘要里单独一行。 */
const SUMMARY_STATES: readonly StepCardState[] = [
  "done",
  "running",
  "review",
  "waiting",
  "waitLead",
  "waitReview",
  "pending",
  "paused",
  "budget",
  "failed",
  "canceled",
  "unreadable",
  "unknown",
];

/** 改字段的文案（英文源串，经 t() 取中文），与 `StepChanges` 的键一一对应。 */
const CHANGE_FIELD_LABELS: Record<keyof StepChanges, string> = {
  title: "Step title",
  dept: "Department",
  requirement: "Requirement",
  expectedArtifacts: "Expected artifacts",
};

/** 动作失败时的固定补充说明：说清「没生效」与「下一步怎么做」，不制造成功假象。 */
const ACTION_FAILED_HINT =
  "The action did not take effect and the control file is unchanged. Check the reason above, then retry or hand the change to the main conversation.";

/** 待改动记录：改了哪一步的哪些字段（只用于「已交给主控」的回执提示）。 */
interface PendingChange {
  readonly stepId: string;
  readonly fields: readonly string[];
}

export interface WorkflowCardsViewProps {
  readonly api: PiDesktopApi;
  readonly snapshot: Parameters<typeof getSelectedWorkspace>[0];
  readonly embeddedChat?: React.ReactNode;
  readonly refreshToken?: number;
  readonly focus?: { readonly instanceId: string; readonly nodeName: string };
  readonly onOpenMainSession?: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onActivateMainSession?: (target: { workspaceId: string; sessionId: string }) => void;
  /**
   * 把一句现成指令交给主控会话。宿主按输入框真实内容决定放进去还是暂存，并回报结果：
   * `'placed'`＝已放进空输入框，`'held'`＝输入框非空，已暂存等用户决定（不覆盖用户打的字）。
   * 页面照实转述结果，不能一律报「已交给主控」。
   */
  readonly onRequestMainControl?: (text: string, label?: string) => "placed" | "held";
  /** 主控输入框里已有未发送的接管草稿（由宿主持有，本页只读它的存在）。 */
  readonly handoverPending?: PendingHandover | undefined;
  /** 把暂存的接管请求追加进主控输入框（保留用户已打的字）。 */
  readonly onAppendHandover?: () => void;
  /** 用暂存的接管请求替换主控输入框里的待发草稿。 */
  readonly onReplaceWithHandover?: () => void;
  /** 丢弃暂存的接管请求。 */
  readonly onDiscardHandover?: () => void;
}

export function WorkflowCardsView({
  api,
  snapshot,
  embeddedChat,
  refreshToken,
  onRequestMainControl,
  handoverPending,
  onAppendHandover,
  onReplaceWithHandover,
  onDiscardHandover,
  onOpenMainSession,
  onActivateMainSession,
  focus,
}: WorkflowCardsViewProps) {
  const { t } = useI18n();
  const workspace = getSelectedWorkspace(snapshot);
  const workspaceId = snapshot.selectedWorkspaceId;
  const [plansResult, setPlansResult] = useState<
    | {
        readonly state: "ok";
        readonly plans: readonly TemporaryPlanRow[];
        readonly issues: readonly { path: string; message: string }[];
      }
    | undefined
  >();
  const [catalog, setCatalog] = useState<
    { recipes: readonly { name: string }[]; departments: readonly string[] } | undefined
  >();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [selectedPlanId, setSelectedPlanId] = useState<string | undefined>();
  const [selectedOwner, setSelectedOwner] = useState<string | undefined>();
  const [selectedStepId, setSelectedStepId] = useState<string | undefined>();
  const [centerView, setCenterView] = useState<"steps" | "output">("steps");
  const [inspector, setInspector] = useState<"step" | "file">("step");
  const [previewPath, setPreviewPath] = useState<string | undefined>();
  const [previewRound, setPreviewRound] = useState<number | undefined>();
  const [reading, setReading] = useState(false);
  const [control, setControl] = useState<WorkflowControlIdentity | undefined>();
  const [controlNote, setControlNote] = useState<string | undefined>();
  const [scope, setScope] = useState<DiscussionScope>({ kind: "flow" });
  const [changes, setChanges] = useState<StepChanges>({});
  const [opinionText, setOpinionText] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [actionNote, setActionNote] = useState<string | undefined>();
  const [cardQuery, setCardQuery] = useState("");
  const [cardStates, setCardStates] = useState<readonly StepCardState[]>([]);
  const [expandedSteps, setExpandedSteps] = useState<readonly string[]>([]);
  const [actionError, setActionError] = useState<string | undefined>();
  const [reason, setReason] = useState("");
  const [pendingChange, setPendingChange] = useState<PendingChange | undefined>();
  const [savePanelOpen, setSavePanelOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const requestId = useRef(0);
  /** 各讨论对象的意见草稿：刷新/切轮次不丢，回来还能续写。 */
  const opinionDraftsRef = useRef(new Map<string, string>());
  const readingPositionsRef = useRef(new Map<string, number>());
  /**
   * 打开预览的那个入口（按钮元素）。Escape 关闭右栏时焦点要还给「触发它的那个按钮」，
   * 而不是 body 或右栏内部元素——不然键盘用户丢位置（计划 §7.1 第 7 条、T22）。
   */
  const previewTriggerRef = useRef<HTMLElement | undefined>(undefined);
  const inspectorRef = useRef<HTMLElement | undefined>(undefined);

  const runRefresh = useCallback(
    (silent: boolean) => {
      const currentRequest = ++requestId.current;
      if (!silent) setLoading(true);
      Promise.all([api.getTemporaryPlans({ workspaceId }), api.getWorkflowCatalog()])
        .then(([plans, catalogResult]) => {
          if (requestId.current !== currentRequest) return;
          setPlansResult(plans.state === "ok" ? plans : { state: "ok", plans: [], issues: [] });
          if (plans.state === "failed") setLoadError(plans.message);
          else setLoadError(undefined);
          setCatalog(catalogResult.state === "available" ? catalogResult : undefined);
        })
        .catch((error: unknown) => {
          if (requestId.current !== currentRequest) return;
          setLoadError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          if (requestId.current === currentRequest) setLoading(false);
        });
    },
    [api, workspaceId],
  );
  const refresh = useCallback(() => runRefresh(false), [runRefresh]);
  const refreshSilently = useCallback(() => runRefresh(true), [runRefresh]);
  useViewAutoRefresh(refreshSilently);
  useEffect(() => {
    refresh();
    return () => {
      requestId.current++;
    };
  }, [refresh]);
  const lastRefreshToken = useRef(refreshToken);
  useEffect(() => {
    if (lastRefreshToken.current === refreshToken) return;
    lastRefreshToken.current = refreshToken;
    refreshSilently();
  }, [refreshToken, refreshSilently]);
  useEffect(() => {
    setSelectedPlanId(undefined);
    setSelectedOwner(undefined);
    setSelectedStepId(undefined);
    setPreviewPath(undefined);
    setPreviewRound(undefined);
    setScope({ kind: "flow" });
    setControl(undefined);
    setControlNote(undefined);
    setChanges({});
    setOpinionText("");
    setTemplateName("");
    setActionNote(undefined);
    setActionError(undefined);
    setPendingChange(undefined);
    setSavePanelOpen(false);
    setSaveError(undefined);
  }, [workspaceId]);

  const plans = plansResult?.state === "ok" ? plansResult.plans : [];
  const appliedFocus = useRef<typeof focus>(undefined);
  useEffect(() => {
    if (!focus || !plansResult || appliedFocus.current === focus) return;
    appliedFocus.current = focus;
    const match = plansResult.plans.find((plan) =>
      plan.starts.some((start) => start.instanceId === focus.instanceId),
    );
    if (!match) {
      setActionError("该历史运行尚无关联的临时计划，请从原主控或原始任务卡查看执行记录。");
      return;
    }
    setSelectedOwner(match.sourceSessionId ?? "");
    setSelectedPlanId(match.planId);
    setSelectedStepId(focus.nodeName);
    setCenterView("steps");
    setInspector("step");
  }, [focus, plansResult]);
  const owners = [...new Set(plans.map((plan) => plan.sourceSessionId ?? ""))];
  const ownerId =
    selectedOwner !== undefined && owners.includes(selectedOwner)
      ? selectedOwner
      : owners.includes(snapshot.selectedSessionId)
        ? snapshot.selectedSessionId
        : owners[0];
  const ownerPlans = plans.filter((plan) => (plan.sourceSessionId ?? "") === ownerId);
  const ownerSession = workspace?.sessions.find((session) => session.id === ownerId);
  const ownerTitle =
    ownerSession?.title ??
    (ownerId ? (ownerPlans[0]?.displayName ?? ownerId) : t("Source conversation unknown"));
  const issues = plansResult?.state === "ok" ? plansResult.issues : [];
  const selectedPlan = useMemo(
    () => ownerPlans.find((plan) => plan.planId === selectedPlanId) ?? ownerPlans[0],
    [ownerPlans, selectedPlanId],
  );
  const start = selectedPlan?.starts[selectedPlan.starts.length - 1];

  useEffect(() => {
    if (!start) {
      setControl(undefined);
      setControlNote(undefined);
      return;
    }
    let cancelled = false;
    api
      .getWorkflowControl({
        workspaceId,
        instanceName: start.recipeName,
        instancePath: start.controlPath,
      })
      .then((result) => {
        if (cancelled) return;
        if (result.state === "ok") {
          setControl(result.control);
          setControlNote(undefined);
        } else {
          setControl(undefined);
          setControlNote(result.message);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setControl(undefined);
        setControlNote(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [api, workspaceId, start?.controlPath, start?.recipeName, start]);

  const progress = useMemo(() => {
    const map = new Map<string, TemporaryPlanStepProgressRow>();
    for (const row of start?.progress ?? []) map.set(row.stepId, row);
    return map;
  }, [start]);
  /**
   * 步骤耗时（T23「不编时间」）：卡面时间只能从主进程的节点详情里读
   * （`getCanvasNodeDetail` → `detail.card.created/completed`），渲染层不许自己按路径读文件。
   * 每个节点读一次、按实例路径缓存；读不到就记原因，界面显示「未记录」而不是 0。
   */
  const instancePath = start?.controlPath;
  const [cardFacts, setCardFacts] = useState<
    ReadonlyMap<
      string,
      { readonly ok: boolean; readonly card?: StepCardDurationCard; readonly problem?: string }
    >
  >(new Map());
  const requestedCardFacts = useRef(new Set<string>());
  const fetchCardFact = useCallback(
    (nodeName: string) => {
      if (instancePath === undefined) return;
      const key = `${instancePath}\u0000${nodeName}`;
      if (requestedCardFacts.current.has(key)) return;
      requestedCardFacts.current.add(key);
      const remember = (entry: {
        readonly ok: boolean;
        readonly card?: StepCardDurationCard;
        readonly problem?: string;
      }) => setCardFacts((previous) => new Map(previous).set(key, entry));
      api
        .getCanvasNodeDetail({ instancePath, nodeName })
        .then((result) => {
          if (result.state !== "ok") {
            remember({ ok: false, problem: result.message });
            return;
          }
          const card = result.detail.card;
          remember(
            card
              ? { ok: true, card: { created: card.created, completed: card.completed } }
              : { ok: false },
          );
        })
        .catch((error: unknown) => {
          remember({ ok: false, problem: error instanceof Error ? error.message : String(error) });
        });
    },
    [api, instancePath],
  );
  const cardFactOf = useCallback(
    (nodeName: string): StepCardDurationCard | undefined => {
      if (instancePath === undefined) return undefined;
      return cardFacts.get(`${instancePath}\u0000${nodeName}`)?.card;
    },
    [cardFacts, instancePath],
  );
  const views = useMemo(
    () => (selectedPlan ? stepCardViews(selectedPlan, control, start?.progress ?? []) : []),
    [selectedPlan, control, start],
  );
  const counts = useMemo(() => stepCardCounts(views), [views]);
  const filteredViews = useMemo(
    () => filterStepCards(views, { query: cardQuery, states: cardStates }),
    [views, cardQuery, cardStates],
  );
  const selectedStep = useMemo(
    () => views.find((view) => view.step.stepId === selectedStepId) ?? views[0],
    [views, selectedStepId],
  );
  const done = completedStepCount(views);
  // 选中步的卡面时间（创建/完成）——耗时只在右栏展示，按需读一次，不批量扫全图。
  useEffect(() => {
    if (selectedStep) fetchCardFact(selectedStep.step.stepId);
  }, [fetchCardFact, selectedStep]);
  const selectedDurationText = stepDurationText(
    stepDuration(selectedStep ? cardFactOf(selectedStep.step.stepId) : undefined),
  );
  const reviewStep = views.find((view) => view.state === "review");
  const reviewNode =
    reviewStep && control
      ? control.nodes.find((node) => node.name === reviewStep.step.stepId)
      : undefined;
  const outputs = useMemo(
    () => (selectedPlan ? stepOutputEntries(selectedPlan, views) : []),
    [selectedPlan, views],
  );
  const fileGroups = useMemo(
    () => (selectedPlan ? fileOpinionGroups(selectedPlan) : []),
    [selectedPlan],
  );
  const todos = useMemo(
    () => (selectedPlan ? deriveTodos({ plan: selectedPlan, control, views }) : []),
    [selectedPlan, control, views],
  );
  const groups = useMemo(
    () => (selectedPlan ? parallelStepGroups(selectedPlan) : []),
    [selectedPlan],
  );
  const runnableNode = control?.nodes.find((node) => node.status === "in_progress");

  useEffect(() => {
    setPendingChange(undefined);
    if (!selectedStep) {
      setChanges({});
      return;
    }
    setChanges({
      title: selectedStep.step.title,
      dept: selectedStep.step.dept,
      requirement: selectedStep.step.requirement,
      expectedArtifacts: selectedStep.step.expectedArtifacts ?? "",
    });
  }, [selectedStep]);

  const depts = catalog?.departments ?? [];
  const deptUnavailable =
    selectedStep !== undefined && depts.length > 0 && !depts.includes(selectedStep.step.dept);
  const locked =
    selectedStep !== undefined &&
    selectedStep.state !== "pending" &&
    selectedStep.state !== "waiting";

  /**
   * 交给主控的请求：由宿主按输入框真实内容决定「放进去」还是「暂存」，
   * 页面只照实转述结果，绝不覆盖用户正在打的字（计划 §7.2）。
   */
  const sendInstruction = useCallback(
    (text: string, label?: string) => {
      if (!onRequestMainControl) {
        setActionError(
          t("No main conversation is selected, so this request cannot be handed over."),
        );
        return;
      }
      setActionError(undefined);
      const outcome = onRequestMainControl(text, label);
      if (outcome === "held") {
        // 输入框非空：宿主已把请求暂存，等用户选「拼在后面 / 替换 / 不用了」。
        setActionNote(
          t(
            "The main conversation input box already has text. Your request was held, not overwritten.",
          ),
        );
        return;
      }
      setActionNote(
        t("The request was placed in the main conversation's input box; send it there."),
      );
    },
    [onRequestMainControl, t],
  );

  const selectPlan = useCallback((planId: string) => {
    setSelectedPlanId(planId);
    setSelectedStepId(undefined);
    setPreviewPath(undefined);
    setPreviewRound(undefined);
    setInspector("step");
    setScope({ kind: "flow" });
    setActionNote(undefined);
    setActionError(undefined);
    setPendingChange(undefined);
    setSavePanelOpen(false);
    setSaveError(undefined);
  }, []);

  /** 打开一份文件：钉住这一版（有新版本只提示、不抢换正文）。 */
  const openPreview = useCallback((path: string, round?: number) => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) {
      previewTriggerRef.current = active;
    }
    setPreviewPath(path);
    setPreviewRound(round);
    setInspector("file");
    setScope(round === undefined ? { kind: "file", path } : { kind: "file", path, round });
  }, []);

  /**
   * 查看某一步：只改「在看哪一步」，不改发言对象（计划 §7.1 第 8 条）。
   * 讨论对象要用户明确点「讨论这一步/就此文件提意见」才换。
   */
  const viewStep = useCallback((stepId: string) => {
    setSelectedStepId(stepId);
    setInspector("step");
  }, []);
  const discussStep = useCallback((stepId: string) => {
    setSelectedStepId(stepId);
    setInspector("step");
    setScope({ kind: "step", stepId });
  }, []);

  const runControlAction = useCallback(
    (node: WorkflowControlNodeRow, action: "confirm" | "pause" | "resume") => {
      if (!control) return;
      if (action !== "confirm" && reason.trim().length === 0) {
        setActionError(t("Pause and resume both need a written reason."));
        return;
      }
      setActionError(undefined);
      setActionNote(undefined);
      api
        .controlWorkflow({
          workspaceId,
          sessionId: control.ownerSessionId,
          instanceId: control.instanceId,
          nodeName: node.name,
          round: node.round,
          action,
          ...(action === "confirm" ? {} : { reason: reason.trim() }),
        })
        .then((result) => {
          if (result.state === "ok") {
            setActionNote(t("The action was accepted; the control file is the source of truth."));
            setReason("");
            refreshSilently();
          } else {
            setActionError(`${result.message} ${t(ACTION_FAILED_HINT)}`);
          }
        })
        .catch((error: unknown) => {
          setActionError(
            `${error instanceof Error ? error.message : String(error)} ${t(ACTION_FAILED_HINT)}`,
          );
        });
    },
    [api, control, reason, refreshSilently, t, workspaceId],
  );

  if (!workspace) {
    return (
      <section className="workflow-cards" data-testid="workflow-cards">
        <p className="workflow-cards__empty">{t("Select a project to see its temporary plans.")}</p>
      </section>
    );
  }

  return (
    <section className="workflow-cards" data-testid="workflow-cards">
      <aside className="workflow-cards__rail">
        <div className="workflow-cards__rail-group">
          <h2 className="workflow-cards__rail-title">主控会话</h2>
          <div className="workflow-cards__owners">
            {owners.map((id) => {
              const rows = plans.filter((plan) => (plan.sourceSessionId ?? "") === id);
              const session = workspace?.sessions.find((entry) => entry.id === id);
              return (
                <button
                  type="button"
                  className={`workflow-cards__owner ${ownerId === id ? "is-active" : ""}`}
                  key={id}
                  aria-pressed={ownerId === id}
                  data-testid={`workflow-owner-${id || "unknown"}`}
                  onClick={() => {
                    setSelectedOwner(id);
                    setSelectedPlanId(undefined);
                    setSelectedStepId(undefined);
                    setPreviewPath(undefined);
                    setInspector("step");
                    if (session) onActivateMainSession?.({ workspaceId, sessionId: id });
                  }}
                >
                  <span>
                    {session?.title ?? rows[0]?.displayName ?? t("Source conversation unknown")}
                  </span>
                  <small>
                    {rows.length} 份计划{!session ? " · 来源主控不可用" : ""}
                  </small>
                </button>
              );
            })}
          </div>
          <h2 className="workflow-cards__rail-title">当前主控的计划</h2>
          {plans.length === 0 ? (
            <p className="workflow-cards__rail-hint">
              {t("No temporary plan yet. Ask the main conversation to make one.")}
            </p>
          ) : (
            <ul className="workflow-cards__rail-list">
              {ownerPlans.map((plan) => (
                <li key={plan.planId}>
                  <button
                    type="button"
                    className={`workflow-cards__rail-item ${plan.planId === selectedPlan?.planId ? "is-active" : ""}`}
                    data-testid={`plan-rail-${plan.planId}`}
                    aria-pressed={plan.planId === selectedPlan?.planId}
                    onClick={() => selectPlan(plan.planId)}
                  >
                    <span>{plan.displayName}</span>
                    <span className="workflow-cards__rail-meta">
                      {plan.undone
                        ? t("Undone")
                        : t("{count} steps", { count: String(plan.steps.length) })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="workflow-cards__rail-group">
          <h2 className="workflow-cards__rail-title">{t("Workflow library")}</h2>
          {catalog && catalog.recipes.length > 0 ? (
            <ul className="workflow-cards__rail-list">
              {catalog.recipes.map((recipe) => (
                <li className="workflow-cards__rail-static" key={recipe.name}>
                  {recipe.name}
                </li>
              ))}
            </ul>
          ) : (
            <p className="workflow-cards__rail-hint">{t("No recipe yet.")}</p>
          )}
        </div>
      </aside>
      <div className="workflow-cards__main">
        {loading ? (
          <p className="workflow-cards__status" role="status">
            {t("Loading…")}
          </p>
        ) : null}
        {loadError ? (
          <p className="workflow-cards__error" role="alert" data-testid="workflow-cards-load-error">
            {t("The temporary plans could not be loaded.")} {loadError}{" "}
            {t(
              "Check that the project still has a readable .pao/临时工作流 folder, then refresh this page.",
            )}
          </p>
        ) : null}
        {issues.length > 0 ? (
          <ul
            className="workflow-cards__issues"
            aria-label={t("Unreadable rows")}
            data-testid="workflow-cards-issues"
          >
            {issues.map((issue) => (
              <li key={`${issue.path}:${issue.message}`}>
                <code>{issue.path}</code> — {issue.message}
              </li>
            ))}
          </ul>
        ) : null}
        {!selectedPlan && actionError ? (
          <p className="workflow-cards__error" role="alert">
            {actionError}
          </p>
        ) : null}
        {!selectedPlan ? (
          <p className="workflow-cards__empty" data-testid="workflow-cards-empty">
            {t(
              "No temporary plan in this project. The main conversation creates plans with the PAO tools; this workbench cannot create one.",
            )}
          </p>
        ) : (
          <PlanWorkspace
            api={api}
            workspaceId={workspaceId}
            workspaceName={workspace.name}
            plans={ownerPlans}
            ownerTitle={ownerTitle}
            onOpenMain={
              ownerSession
                ? () => onOpenMainSession?.({ workspaceId, sessionId: ownerSession.id })
                : undefined
            }
            plan={selectedPlan}
            control={control}
            counts={counts}
            views={views}
            filteredViews={filteredViews}
            selectedStep={selectedStep}
            done={done}
            reviewStep={reviewStep}
            reviewNode={reviewNode}
            todos={todos}
            groups={groups}
            outputs={outputs}
            fileGroups={fileGroups}
            progress={progress}
            durationText={selectedDurationText}
            centerView={centerView}
            onCenterView={setCenterView}
            inspector={inspector}
            onInspector={setInspector}
            previewPath={previewPath}
            previewRound={previewRound}
            reading={reading}
            onToggleReading={() => setReading((value) => !value)}
            readingPositionsRef={readingPositionsRef}
            previewTriggerRef={previewTriggerRef}
            inspectorRef={inspectorRef}
            cardQuery={cardQuery}
            onCardQuery={setCardQuery}
            cardStates={cardStates}
            onCardStates={setCardStates}
            expandedSteps={expandedSteps}
            onToggleExpand={(stepId) =>
              setExpandedSteps((current) =>
                current.includes(stepId)
                  ? current.filter((item) => item !== stepId)
                  : [...current, stepId],
              )
            }
            changes={changes}
            onChange={(patch) => setChanges((current) => ({ ...current, ...patch }))}
            depts={depts}
            deptUnavailable={deptUnavailable}
            locked={locked}
            reason={reason}
            onReason={setReason}
            controlNote={controlNote}
            actionNote={actionNote}
            actionError={actionError}
            runnableNode={runnableNode}
            onControlAction={runControlAction}
            savePanelOpen={savePanelOpen}
            onSavePanelOpen={() => {
              setActionNote(undefined);
              setActionError(undefined);
              setSaveError(undefined);
              setSavePanelOpen(true);
            }}
            onSavePanelClose={() => {
              setSavePanelOpen(false);
              setSaveError(undefined);
            }}
            templateName={templateName}
            onTemplateName={setTemplateName}
            saveError={saveError}
            onSaveError={setSaveError}
            pendingChange={pendingChange}
            onPendingChange={setPendingChange}
            handoverPending={handoverPending}
            onHandoverAppend={onAppendHandover}
            onHandoverReplace={onReplaceWithHandover}
            onHandoverDiscard={onDiscardHandover}
            onSelectPlan={selectPlan}
            onViewStep={viewStep}
            onDiscussStep={discussStep}
            onOpenPreview={openPreview}
            onLocateStep={(stepId) => {
              // 「定位所属步骤」只切看哪一步：右栏仍留在文件预览页签，读着的正文不被打断
              // （计划 §7.1 第 8 条「开文件不改已选步骤，定位所属步骤才切」）。
              // 回步骤详情是另一个入口，只有它该把右栏切回步骤面板。
              setCenterView("steps");
              setSelectedStepId(stepId);
            }}
            onBackToStep={() => setInspector("step")}
            onScopeReset={() => setScope({ kind: "flow" })}
            scope={scope}
            opinionText={opinionText}
            opinionDraftsRef={opinionDraftsRef}
            onOpinionText={setOpinionText}
            sendInstruction={sendInstruction}
            embeddedChat={embeddedChat}
            onNoMatchNext={() => {
              const next = nextPendingStepId(
                filteredViews.length > 0 ? filteredViews : views,
                selectedStep?.step.stepId,
              );
              if (next) discussStep(next);
            }}
          />
        )}
      </div>
    </section>
  );
}

interface PlanWorkspaceProps {
  readonly ownerTitle: string | undefined;
  readonly onOpenMain?: () => void;
  readonly api: PiDesktopApi;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly plans: readonly TemporaryPlanRow[];
  readonly plan: TemporaryPlanRow;
  readonly control: WorkflowControlIdentity | undefined;
  readonly counts: ReturnType<typeof stepCardCounts>;
  readonly views: readonly StepCardView[];
  readonly filteredViews: readonly StepCardView[];
  readonly selectedStep: StepCardView | undefined;
  readonly done: number;
  readonly reviewStep: StepCardView | undefined;
  readonly reviewNode: WorkflowControlNodeRow | undefined;
  readonly todos: ReturnType<typeof deriveTodos>;
  readonly groups: ReturnType<typeof parallelStepGroups>;
  readonly outputs: ReturnType<typeof stepOutputEntries>;
  readonly fileGroups: ReturnType<typeof fileOpinionGroups>;
  readonly progress: ReadonlyMap<string, TemporaryPlanStepProgressRow>;
  /** 选中步的耗时文案（已按「未记录/暂无卡」如实取词，右栏直接显示）。 */
  readonly durationText: string;
  readonly centerView: "steps" | "output";
  readonly onCenterView: (value: "steps" | "output") => void;
  readonly inspector: "step" | "file";
  readonly onInspector: (value: "step" | "file") => void;
  readonly previewPath: string | undefined;
  readonly previewRound: number | undefined;
  readonly reading: boolean;
  readonly onToggleReading: () => void;
  readonly readingPositionsRef: React.RefObject<Map<string, number>>;
  readonly previewTriggerRef: React.RefObject<HTMLElement | undefined>;
  readonly inspectorRef: React.RefObject<HTMLElement | undefined>;
  readonly cardQuery: string;
  readonly onCardQuery: (value: string) => void;
  readonly cardStates: readonly StepCardState[];
  readonly onCardStates: (value: readonly StepCardState[]) => void;
  readonly expandedSteps: readonly string[];
  readonly onToggleExpand: (stepId: string) => void;
  readonly changes: StepChanges;
  readonly onChange: (patch: StepChanges) => void;
  readonly depts: readonly string[];
  readonly deptUnavailable: boolean;
  readonly locked: boolean;
  readonly reason: string;
  readonly onReason: (value: string) => void;
  readonly controlNote: string | undefined;
  readonly actionNote: string | undefined;
  readonly actionError: string | undefined;
  readonly runnableNode: WorkflowControlNodeRow | undefined;
  readonly onControlAction: (
    node: WorkflowControlNodeRow,
    action: "confirm" | "pause" | "resume",
  ) => void;
  readonly savePanelOpen: boolean;
  readonly onSavePanelOpen: () => void;
  readonly onSavePanelClose: () => void;
  readonly templateName: string;
  readonly onTemplateName: (value: string) => void;
  readonly saveError: string | undefined;
  readonly onSaveError: (value: string | undefined) => void;
  readonly pendingChange: PendingChange | undefined;
  readonly onPendingChange: (value: PendingChange | undefined) => void;
  readonly handoverPending: PendingHandover | undefined;
  readonly onHandoverAppend?: () => void;
  readonly onHandoverReplace?: () => void;
  readonly onHandoverDiscard?: () => void;
  readonly onSelectPlan: (planId: string) => void;
  readonly onViewStep: (stepId: string) => void;
  readonly onDiscussStep: (stepId: string) => void;
  readonly onOpenPreview: (path: string, round?: number) => void;
  readonly onLocateStep: (stepId: string) => void;
  readonly onBackToStep: () => void;
  readonly onScopeReset: () => void;
  readonly scope: DiscussionScope;
  readonly opinionText: string;
  readonly opinionDraftsRef: React.RefObject<Map<string, string>>;
  readonly onOpinionText: (value: string) => void;
  readonly sendInstruction: (text: string, label?: string) => void;
  readonly embeddedChat?: React.ReactNode;
  readonly onNoMatchNext: () => void;
}

function PlanWorkspace(props: PlanWorkspaceProps) {
  const { t } = useI18n();
  const {
    plan,
    control,
    counts,
    views,
    filteredViews,
    selectedStep,
    done,
    reviewStep,
    reviewNode,
    todos,
    groups,
    centerView,
    onCenterView,
    inspector,
    onInspector,
    previewPath,
    previewRound,
    previewTriggerRef,
    inspectorRef,
    cardQuery,
    onCardQuery,
    cardStates,
    onCardStates,
    expandedSteps,
    onToggleExpand,
    locked,
    scope,
    opinionText,
    opinionDraftsRef,
    onOpinionText,
    sendInstruction,
  } = props;
  const todoCount = todos.length;

  return (
    <>
      <p className="workflow-cards__breadcrumb" data-testid="workflow-cards-breadcrumb">
        <span>{props.workspaceName}</span>
        <span className="workflow-cards__breadcrumb-sep">/</span>
        <span>{props.ownerTitle ?? t("Source conversation unknown")}</span>
      </p>
      {props.plans.length > 1 ? (
        <nav
          className="workflow-cards__tabs"
          aria-label={t("Workflow tabs")}
          data-testid="workflow-cards-plan-tabs"
        >
          {props.plans.map((row) => (
            <button
              type="button"
              className={row.planId === plan.planId ? "is-active" : ""}
              data-testid={`workflow-cards-plan-tab-${row.planId}`}
              aria-pressed={row.planId === plan.planId}
              key={row.planId}
              onClick={() => props.onSelectPlan(row.planId)}
            >
              {row.displayName} · {row.starts.length > 0 ? t("Running") : t("Temporary")}
            </button>
          ))}
        </nav>
      ) : null}
      <header className="workflow-cards__header">
        <div className="workflow-cards__heading">
          <h1 className="workflow-cards__title" data-testid="workflow-cards-title">
            {plan.displayName}
          </h1>
          <p className="workflow-cards__badges">
            <span className="workflow-cards__badge">
              {plan.starts.length > 0 ? t("Workflow") : t("Temporary")}
            </span>
            <span className="workflow-cards__badge">
              {t("Definition version {version}", { version: String(plan.definitionVersion) })}
            </span>
            {plan.undone ? (
              <span className="workflow-cards__badge workflow-cards__badge--warn">
                {t("Undone")}
              </span>
            ) : null}
            {flowStatusText(control) ? (
              <span className="workflow-cards__badge" data-testid="workflow-cards-flow-status">
                {flowStatusText(control)}
              </span>
            ) : null}
            <span className="workflow-cards__badge workflow-cards__badge--muted">
              {plan.sourceSessionId
                ? t("From the main conversation")
                : t("Source conversation unknown")}
            </span>
          </p>
        </div>
        <div className="workflow-cards__actions">
          <button
            type="button"
            className="button button--ghost"
            disabled={!props.onOpenMain}
            onClick={props.onOpenMain}
            data-testid="workflow-open-main"
          >
            打开主控会话
          </button>
          <button
            type="button"
            className="button"
            data-testid="workflow-cards-pause"
            disabled={!props.runnableNode}
            title={
              props.runnableNode
                ? t("Pause advancement of the running step")
                : t("Only a running step can be paused")
            }
            onClick={() => {
              if (props.runnableNode) props.onControlAction(props.runnableNode, "pause");
            }}
          >
            {t("Pause advancement")}
          </button>
          <button
            type="button"
            className="button"
            data-testid="workflow-cards-resume"
            disabled={!control?.pauseReason}
            title={t("Resume needs a written on-site check")}
            onClick={() => {
              const node = props.runnableNode ?? control?.nodes[0];
              if (node) props.onControlAction(node, "resume");
            }}
          >
            {t("Resume manually")}
          </button>
          <button
            type="button"
            className="button"
            data-testid="workflow-cards-save"
            onClick={props.onSavePanelOpen}
          >
            {t("Save workflow")}
          </button>
        </div>
      </header>

      {reviewStep ? (
        <section
          className="workflow-cards__confirm workflow-cards__confirm--overview"
          data-testid="workflow-cards-confirm-area"
          aria-label={t("Waiting for your confirmation")}
        >
          <div>
            <h2 className="workflow-cards__confirm-title">
              {t("This step is delivered; it needs your confirmation.")}
            </h2>
            <p className="workflow-cards__hint">
              {t("Step {step}: {title}", {
                step: String(
                  plan.steps.findIndex((step) => step.stepId === reviewStep.step.stepId) + 1,
                ),
                title: reviewStep.step.title,
              })}
            </p>
          </div>
          <div className="workflow-cards__row">
            <button
              type="button"
              className="button button--ghost"
              data-testid="workflow-cards-confirm-view-outputs"
              onClick={() => onCenterView("output")}
            >
              {t("View output files")}
            </button>
            <button
              type="button"
              className="button button--ghost"
              data-testid="workflow-cards-confirm-opinion"
              onClick={() => props.onDiscussStep(reviewStep.step.stepId)}
            >
              {t("Raise a change instead")}
            </button>
            <button
              type="button"
              className="button button--primary"
              data-testid="workflow-cards-confirm-accept"
              disabled={reviewNode === undefined}
              onClick={() => {
                if (reviewNode) props.onControlAction(reviewNode, "confirm");
              }}
            >
              {t("Confirm and let it through")}
            </button>
          </div>
        </section>
      ) : null}

      <section
        className="workflow-cards__summary"
        data-testid="workflow-cards-summary"
        aria-label={t("Summary")}
      >
        <div className="workflow-cards__summary-item">
          <span className="workflow-cards__summary-label">{t("Steps")}</span>
          <span
            className="workflow-cards__summary-value"
            data-testid="workflow-cards-summary-total"
          >
            {counts.total}
          </span>
        </div>
        {SUMMARY_STATES.filter((state) => counts[state] > 0).map((state) => (
          <div className="workflow-cards__summary-item" key={state}>
            <span className="workflow-cards__summary-label">
              {t(STEP_CARD_STATE_LABELS[state])}
            </span>
            <span
              className="workflow-cards__summary-value"
              data-testid={`workflow-cards-summary-${state}`}
              data-state={state}
            >
              {counts[state]}
            </span>
          </div>
        ))}
        <div className="workflow-cards__summary-item">
          <span className="workflow-cards__summary-label">{t("Open items")}</span>
          <span className="workflow-cards__summary-value" data-testid="workflow-cards-summary-open">
            {counts.open}
          </span>
        </div>
        <div className="workflow-cards__summary-item">
          <span className="workflow-cards__summary-label">{t("To-dos")}</span>
          <span
            className="workflow-cards__summary-value"
            data-testid="workflow-cards-summary-todos"
          >
            {todoCount}
          </span>
        </div>
        <div className="workflow-cards__summary-item">
          <span className="workflow-cards__summary-label">{t("Source conversation")}</span>
          <span className="workflow-cards__summary-value">{props.ownerTitle ?? t("Unknown")}</span>
        </div>
      </section>

      {todos.length > 0 ? (
        <section
          className="workflow-cards__todos"
          aria-label={t("To-dos")}
          data-testid="workflow-cards-todos"
        >
          <h2 className="workflow-cards__subtitle">{t("To-dos")}</h2>
          <ul className="workflow-cards__todo-list">
            {todos.map((todo) => (
              <li
                key={todo.key}
                data-testid={`workflow-cards-todo-${todo.kind}`}
                data-todo-kind={todo.kind}
              >
                <span>{todo.label}</span>
                {todo.stepTitle ? <span>{todo.stepTitle}</span> : null}
                {todo.reason ? <span className="workflow-cards__hint">{todo.reason}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {props.controlNote ? (
        <p className="workflow-cards__note" data-testid="workflow-cards-control-note">
          {t("The control file could not be read")}: {props.controlNote}
        </p>
      ) : null}
      {props.actionNote ? (
        <p
          className="workflow-cards__note workflow-cards__note--ok"
          role="status"
          data-testid="workflow-cards-action-note"
        >
          {props.actionNote}
        </p>
      ) : null}
      {props.actionError ? (
        <p className="workflow-cards__error" role="alert" data-testid="workflow-cards-action-error">
          {props.actionError}
        </p>
      ) : null}

      {props.handoverPending !== undefined ? (
        <section
          className="workflow-cards__note"
          role="status"
          aria-label={t("The main conversation input already has an unsent draft.")}
          data-testid="workflow-cards-handover-conflict"
        >
          <p className="workflow-cards__hint">
            {t("The main conversation input already has an unsent draft.")}
          </p>
          {props.handoverPending.label ? (
            <p className="workflow-cards__hint" data-testid="workflow-cards-handover-pending-label">
              {props.handoverPending.label}
            </p>
          ) : null}
          <div className="workflow-cards__row">
            <button
              type="button"
              className="button"
              data-testid="workflow-cards-handover-append"
              onClick={props.onHandoverAppend}
            >
              {t("Add to the draft")}
            </button>
            <button
              type="button"
              className="button button--ghost"
              data-testid="workflow-cards-handover-replace"
              onClick={props.onHandoverReplace}
            >
              {t("Replace the draft")}
            </button>
            <button
              type="button"
              className="button button--ghost"
              data-testid="workflow-cards-handover-cancel"
              onClick={props.onHandoverDiscard}
            >
              {t("Cancel")}
            </button>
          </div>
        </section>
      ) : null}

      <div className="workflow-cards__toolbar">
        <div className="workflow-cards__switch" role="group" aria-label={t("Center view")}>
          <button
            type="button"
            className={centerView === "steps" ? "is-active" : ""}
            data-testid="workflow-cards-tab-steps"
            aria-pressed={centerView === "steps"}
            onClick={() => onCenterView("steps")}
          >
            {t("Step cards")}
          </button>
          <button
            type="button"
            className={centerView === "output" ? "is-active" : ""}
            data-testid="workflow-cards-tab-output"
            aria-pressed={centerView === "output"}
            onClick={() => onCenterView("output")}
          >
            {t("Output files")}
          </button>
        </div>
        <span className="workflow-cards__progress" data-testid="workflow-cards-progress">
          {t("{done} / {total} steps done", { done: String(done), total: String(views.length) })}
        </span>
      </div>

      <details className="workflow-cards__filter-panel">
        <summary>筛选步骤与查找待办</summary>
        <div className="workflow-cards__filters">
          <input
            type="search"
            className="workflow-cards__search"
            data-testid="workflow-cards-search"
            placeholder={t("Search steps")}
            aria-label={t("Search steps")}
            value={cardQuery}
            onChange={(event) => onCardQuery(event.target.value)}
          />
          <div className="workflow-cards__switch" role="group" aria-label={t("Filter by status")}>
            {SUMMARY_STATES.map((state) => {
              const active = cardStates.includes(state);
              return (
                <button
                  type="button"
                  className={active ? "is-active" : ""}
                  data-testid={`workflow-cards-filter-${state}`}
                  aria-pressed={active}
                  key={state}
                  onClick={() =>
                    onCardStates(
                      active ? cardStates.filter((item) => item !== state) : [...cardStates, state],
                    )
                  }
                >
                  {STEP_CARD_STATE_ICONS[state]} {t(STEP_CARD_STATE_LABELS[state])}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="button"
            data-testid="workflow-cards-next-pending"
            disabled={views.length === 0}
            onClick={props.onNoMatchNext}
          >
            {t("Next pending step")}
          </button>
          {filteredViews.length !== views.length ? (
            <span
              className="workflow-cards__filtered"
              data-testid="workflow-cards-filtered-count"
              role="status"
            >
              {t("{shown} of {total} shown", {
                shown: String(filteredViews.length),
                total: String(views.length),
              })}
            </span>
          ) : null}
        </div>
      </details>

      <div className="workflow-cards__body">
        <div className={`workflow-cards__center ${props.reading ? "is-reading" : ""}`}>
          {centerView === "steps" ? (
            filteredViews.length === 0 ? (
              <p className="workflow-cards__note" data-testid="workflow-cards-no-match">
                {t("No step matches the current filter.")}
              </p>
            ) : (
              <StepCardList
                plan={plan}
                views={views}
                filteredViews={filteredViews}
                groups={groups}
                progress={props.progress}
                selectedStepId={selectedStep?.step.stepId}
                expandedSteps={expandedSteps}
                onToggleExpand={onToggleExpand}
                onViewStep={props.onViewStep}
                onDiscussStep={props.onDiscussStep}
                onConfirm={(view) => {
                  if (view.node) props.onControlAction(view.node, "confirm");
                }}
                onStop={(view) => {
                  const cards = stepCardRefs(view).cards;
                  if (cards.length === 0) return;
                  sendInstruction(
                    stopCardInstruction(plan, view.step, cards),
                    t("Stop the cards of step {id}", { id: view.step.stepId }),
                  );
                }}
                onPreviewExpected={(path) => props.onOpenPreview(path)}
                t={t}
              />
            )
          ) : (
            <OutputList
              outputs={props.outputs}
              fileGroups={props.fileGroups}
              progress={props.progress}
              previewPath={previewPath}
              previewRound={previewRound}
              onPreview={props.onOpenPreview}
              t={t}
            />
          )}
        </div>
        <aside
          className="workflow-cards__inspector"
          data-testid="workflow-cards-inspector"
          ref={(node) => {
            inspectorRef.current = node ?? undefined;
          }}
          onKeyDown={(event) => {
            // Escape 收起文件预览并把焦点还给打开它的那个入口（计划 §7.1 第 7 条）。
            // 只在文件预览态生效：步骤详情里的 textarea 也在右栏，不该被满栏 Escape 抢走。
            if (event.key !== "Escape" || inspector !== "file") return;
            event.stopPropagation();
            onInspector("step");
            const trigger = previewTriggerRef.current;
            if (trigger && trigger.isConnected) trigger.focus();
          }}
        >
          <div className="workflow-cards__switch" role="group" aria-label={t("Inspector view")}>
            <button
              type="button"
              className={inspector === "step" ? "is-active" : ""}
              data-testid="workflow-cards-panel-step"
              aria-pressed={inspector === "step"}
              onClick={() => onInspector("step")}
            >
              {t("Step details")}
            </button>
            <button
              type="button"
              className={inspector === "file" ? "is-active" : ""}
              data-testid="workflow-cards-panel-file"
              aria-pressed={inspector === "file"}
              onClick={() => onInspector("file")}
            >
              {t("File preview")}
            </button>
          </div>
          {inspector === "step" && selectedStep ? (
            <StepDetail
              plan={plan}
              view={selectedStep}
              progressRow={props.progress.get(selectedStep.step.stepId)}
              durationText={props.durationText}
              depts={props.depts}
              deptUnavailable={props.deptUnavailable}
              locked={locked}
              changes={props.changes}
              onChange={props.onChange}
              onRequestModify={() => {
                const step = selectedStep.step;
                const original = {
                  title: step.title,
                  dept: step.dept,
                  requirement: step.requirement,
                  expectedArtifacts: step.expectedArtifacts ?? "",
                };
                const fields = (Object.keys(CHANGE_FIELD_LABELS) as (keyof StepChanges)[])
                  .filter((key) => props.changes[key] !== original[key])
                  .map((key) => CHANGE_FIELD_LABELS[key]);
                sendInstruction(
                  modifyStepInstruction(plan, step, props.changes),
                  t("Change step {id}", { id: step.stepId }),
                );
                props.onPendingChange({ stepId: step.stepId, fields });
              }}
              onRequestUndo={() =>
                sendInstruction(undoInstruction(plan), t("Undo the last change"))
              }
              opinionText={opinionText}
              onOpinionText={(text) => {
                onOpinionText(text);
                opinionDraftsRef.current.set(
                  discussionScopeKey({ kind: "step", stepId: selectedStep.step.stepId }),
                  text,
                );
              }}
              onSubmitOpinion={() => {
                const target: DiscussionScope = { kind: "step", stepId: selectedStep.step.stepId };
                sendInstruction(
                  opinionInstruction(plan, target, opinionText),
                  t("Opinion on step {id}", { id: selectedStep.step.stepId }),
                );
                opinionDraftsRef.current.delete(discussionScopeKey(target));
                onOpinionText("");
              }}
              onDiscuss={() => props.onDiscussStep(selectedStep.step.stepId)}
              t={t}
            />
          ) : null}
          {inspector === "file" ? (
            <FilePreview
              api={props.api}
              workspaceId={props.workspaceId}
              plan={plan}
              path={previewPath}
              round={previewRound}
              onSwitchRound={props.onOpenPreview}
              progress={props.progress}
              reading={props.reading}
              onToggleReading={props.onToggleReading}
              readingPositionsRef={props.readingPositionsRef}
              onLocate={props.onLocateStep}
              onBackToStep={props.onBackToStep}
              opinionText={opinionText}
              onOpinionText={(text) => {
                onOpinionText(text);
                opinionDraftsRef.current.set(discussionScopeKey(scope), text);
              }}
              onSubmitOpinion={() => {
                if (!previewPath) return;
                const target: DiscussionScope = {
                  kind: "file",
                  path: previewPath,
                  ...(previewRound === undefined ? {} : { round: previewRound }),
                };
                sendInstruction(
                  opinionInstruction(plan, target, opinionText),
                  t("Opinion on a file"),
                );
                opinionDraftsRef.current.delete(discussionScopeKey(target));
                onOpinionText("");
              }}
              onDiscussThisFile={() => {
                if (!previewPath) return;
                props.onOpenPreview(previewPath, previewRound);
              }}
              t={t}
            />
          ) : null}
        </aside>
      </div>

      {props.pendingChange ? (
        <div
          className="workflow-cards__feedback"
          data-testid="workflow-cards-feedback"
          aria-live="polite"
        >
          <span>
            {t("Changed {fields} of step {step}", {
              fields: props.pendingChange.fields.map((field) => t(field)).join("、"),
              step: String(
                plan.steps.findIndex((step) => step.stepId === props.pendingChange?.stepId) + 1,
              ),
            })}
          </span>
          <button
            type="button"
            className="button button--ghost"
            data-testid="workflow-cards-feedback-undo"
            onClick={() => {
              sendInstruction(undoInstruction(plan), t("Undo the last change"));
              props.onPendingChange(undefined);
            }}
          >
            {t("Undo the last change")}
          </button>
        </div>
      ) : null}

      {props.savePanelOpen ? (
        <section
          className="workflow-cards__save"
          data-testid="workflow-cards-save-panel"
          aria-label={t("Save workflow")}
        >
          <h2 className="workflow-cards__save-title">{t("Save workflow")}</h2>
          <p className="workflow-cards__hint">
            {t("The main conversation saves it with pao_plan_save_template.")}
          </p>
          <label className="workflow-cards__field">
            <span>{t("Workflow name")}</span>
            <input
              className="workflow-cards__input"
              data-testid="workflow-cards-template-name"
              value={props.templateName}
              onChange={(event) => props.onTemplateName(event.target.value)}
            />
          </label>
          {props.saveError ? (
            <p className="workflow-cards__error" data-testid="workflow-cards-save-error">
              {props.saveError}
            </p>
          ) : null}
          <div className="workflow-cards__row">
            <button
              type="button"
              className="button button--primary"
              data-testid="workflow-cards-save-confirm"
              onClick={() => {
                const name = props.templateName.trim();
                if (name.length === 0) {
                  props.onSaveError(t("Give the workflow a name first."));
                  return;
                }
                props.onSaveError(undefined);
                props.onSavePanelClose();
                sendInstruction(
                  saveTemplateInstruction(plan, name),
                  t("Save as a workflow template"),
                );
              }}
            >
              {t("Save it")}
            </button>
            <button
              type="button"
              className="button button--ghost"
              data-testid="workflow-cards-save-cancel"
              onClick={props.onSavePanelClose}
            >
              {t("Cancel")}
            </button>
          </div>
        </section>
      ) : null}

      <section className="workflow-cards__chat" aria-label={t("Main conversation")}>
        <div className="workflow-cards__chat-head">
          <h2>{t("Main conversation")}</h2>
          <span className="workflow-cards__hint">
            {t("Reuses the open thread · discussion stays linked to steps")}
          </span>
        </div>
        <div className="workflow-cards__scope">
          <span data-testid="workflow-cards-scope">
            {t("Discussion target")}: {scopeLabel(scope, plan)}
          </span>
          <button
            type="button"
            className="button button--ghost"
            data-testid="workflow-cards-scope-reset"
            onClick={props.onScopeReset}
          >
            {t("Back to the whole flow")}
          </button>
          <input
            className="workflow-cards__input"
            data-testid="workflow-cards-reason"
            value={props.reason}
            placeholder={t("Reason for pause or resume")}
            aria-label={t("Reason for pause or resume")}
            onChange={(event) => props.onReason(event.target.value)}
          />
        </div>
        <div className="workflow-cards__chat-body">
          {props.embeddedChat ?? (
            <p className="workflow-cards__empty">
              {t("No main conversation is open. Open the thread that owns this plan.")}
            </p>
          )}
        </div>
        <p className="workflow-cards__chat-foot">
          {t("Main control · current thread")}
          {props.control ? ` · ${props.control.recipeName}` : ""}
        </p>
      </section>
    </>
  );
}

interface StepCardListProps {
  readonly plan: TemporaryPlanRow;
  readonly views: readonly StepCardView[];
  readonly filteredViews: readonly StepCardView[];
  readonly groups: ReturnType<typeof parallelStepGroups>;
  readonly progress: ReadonlyMap<string, TemporaryPlanStepProgressRow>;
  readonly selectedStepId: string | undefined;
  readonly expandedSteps: readonly string[];
  readonly onToggleExpand: (stepId: string) => void;
  readonly onViewStep: (stepId: string) => void;
  readonly onDiscussStep: (stepId: string) => void;
  readonly onConfirm: (view: StepCardView) => void;
  readonly onStop: (view: StepCardView) => void;
  readonly onPreviewExpected: (path: string) => void;
  readonly t: (key: string, params?: Record<string, string | number>) => string;
}

/**
 * 卡片列表：显式并行组渲染成一组（组头写明「并行」与共享前置），
 * 单卡按定义顺序纵排（窄屏同样是纵排，见样式里的列布局）。
 */
function StepCardList(props: StepCardListProps) {
  const { t, groups, filteredViews, views, plan } = props;
  return (
    <ol className="workflow-cards__steps" data-testid="workflow-cards-steps">
      {filteredViews.map((view) => {
        const group = stepParallelGroup(groups, view.step.stepId);
        const first = group === undefined || group.stepIds[0] === view.step.stepId;
        const groupMates =
          group?.parallel === true && first
            ? group.stepIds
                .map((stepId) => views.find((item) => item.step.stepId === stepId))
                .filter((item): item is StepCardView => item !== undefined)
            : [];
        return (
          <StepCard
            key={view.step.stepId}
            view={view}
            index={views.findIndex((item) => item.step.stepId === view.step.stepId)}
            selected={view.step.stepId === props.selectedStepId}
            hold={stepHoldText(plan, view)}
            expanded={props.expandedSteps.includes(view.step.stepId)}
            group={group}
            groupFirst={first}
            groupMates={groupMates}
            onToggleExpand={() => props.onToggleExpand(view.step.stepId)}
            onSelect={() => props.onViewStep(view.step.stepId)}
            onDiscuss={() => props.onDiscussStep(view.step.stepId)}
            onConfirm={() => props.onConfirm(view)}
            onStop={() => props.onStop(view)}
            onPreviewExpected={props.onPreviewExpected}
            cards={stepCardRefs(view).cards}
            t={t}
          />
        );
      })}
    </ol>
  );
}

interface StepCardProps {
  readonly view: StepCardView;
  readonly index: number;
  readonly selected: boolean;
  readonly hold: string | undefined;
  readonly expanded: boolean;
  readonly group: ReturnType<typeof stepParallelGroup>;
  readonly groupFirst: boolean;
  readonly groupMates: readonly StepCardView[];
  readonly onToggleExpand: () => void;
  readonly onSelect: () => void;
  readonly onDiscuss: () => void;
  readonly onConfirm: () => void;
  readonly onStop: () => void;
  readonly onPreviewExpected: (path: string) => void;
  readonly cards: readonly string[];
  readonly t: (key: string, params?: Record<string, string | number>) => string;
}

function StepCard({
  view,
  index,
  selected,
  hold,
  expanded,
  group,
  groupFirst,
  groupMates,
  onToggleExpand,
  onSelect,
  onDiscuss,
  onConfirm,
  onStop,
  onPreviewExpected,
  cards,
  t,
}: StepCardProps) {
  const expected = (view.step.expectedArtifacts ?? "")
    .split(/[、,，\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const rounds = stepRoundExecutions(view.progress);
  return (
    <li
      className={`workflow-cards__step ${selected ? "is-selected" : ""}`}
      data-testid={`workflow-cards-step-${view.step.stepId}`}
      data-state={view.state}
      data-selected={selected}
      data-parallel={group?.parallel === true ? "true" : undefined}
      aria-current={selected ? "true" : undefined}
    >
      {group?.parallel === true && groupFirst ? (
        <p
          className="workflow-cards__group-head"
          data-testid={`workflow-cards-parallel-${view.step.stepId}`}
        >
          {t("Parallel group")}
          {group.sharedDependency
            ? ` · ${t("Shared earlier step")}: ${group.sharedDependency}`
            : ""}
          {` · ${groupMates.map((mate) => mate.step.title).join("、")}`}
        </p>
      ) : null}
      <button type="button" className="workflow-cards__step-main" onClick={onSelect}>
        <span className="workflow-cards__step-top">
          <span className="workflow-cards__step-index">{index + 1}</span>
          <span className="workflow-cards__step-name">{view.step.title}</span>
          <span
            className="workflow-cards__step-state"
            data-state={view.state}
            data-testid={`workflow-cards-state-${view.step.stepId}`}
          >
            <span className="workflow-cards__state-dot" aria-hidden="true" />{" "}
            {t(STEP_CARD_STATE_LABELS[view.state])}
          </span>
        </span>
        <span className="workflow-cards__step-sub">
          {view.step.dept} · {t("Depends on")}:{" "}
          {view.step.dependsOn.length > 0 ? view.step.dependsOn.join("、") : t("None")}
          {view.step.humanGate ? ` · ${t("Human gate")}` : ""}
          {view.step.readOnly ? ` · ${t("Read only")}` : ""}
          {view.step.audit ? ` · ${t("Audit")}` : ""}
          {view.round !== undefined
            ? ` · ${t("Round {round}", { round: String(view.round) })}`
            : ""}
          {view.delivered
            ? ` · ${t("Delivered")}${view.confirmedAt ? ` (${t("confirmed")})` : ""}`
            : ""}
        </span>
        {hold ? (
          <span
            className="workflow-cards__step-hold"
            data-testid={`workflow-cards-hold-${view.step.stepId}`}
          >
            {hold}
          </span>
        ) : null}
        {view.state === "unreadable" ? (
          <span
            className="workflow-cards__hint"
            data-testid={`workflow-cards-read-problem-${view.step.stepId}`}
          >
            {view.progress?.readProblem ?? t("Card status unreadable")}
          </span>
        ) : null}
        {cards.length > 0 ? (
          <span
            className="workflow-cards__hint"
            data-testid={`workflow-cards-cards-${view.step.stepId}`}
          >
            {t("Cards")}: {cards.join("、")}
          </span>
        ) : (
          <span
            className="workflow-cards__hint"
            data-testid={`workflow-cards-no-card-${view.step.stepId}`}
          >
            {t("No card right now")}
          </span>
        )}
        {expanded ? (
          <span className="workflow-cards__step-extra">
            <span>
              {t("Requirement")}: {view.step.requirement}
            </span>
            {view.step.expectedArtifacts ? (
              <span>
                {t("Expected artifacts")}: {view.step.expectedArtifacts}
              </span>
            ) : null}
          </span>
        ) : null}
      </button>
      {expected.length > 0 ? (
        <div className="workflow-cards__file-links">
          <span className="workflow-cards__hint">{t("Expected artifacts")}:</span>
          {expected.map((path) => (
            <button
              type="button"
              data-testid={`workflow-cards-expected-${path}`}
              key={path}
              onClick={() => onPreviewExpected(path)}
            >
              {path}
            </button>
          ))}
        </div>
      ) : null}
      <div className="workflow-cards__step-tools">
        <button
          type="button"
          className="workflow-cards__link"
          data-testid={`workflow-cards-expand-${view.step.stepId}`}
          aria-expanded={expanded}
          onClick={onToggleExpand}
        >
          {expanded ? t("Collapse this card") : t("Expand this card")}
        </button>
        <button
          type="button"
          className="workflow-cards__link"
          data-testid={`workflow-cards-discuss-${view.step.stepId}`}
          onClick={onDiscuss}
        >
          {t("Discuss this step")}
        </button>
        {/* 停止入口按「还在路上」而不是只用「执行中」判：等部长拆解、等审核判定的步骤卡还活着，
            照样要能停（计划 §7.1 第 259 条「停止在途走终止入口」）。用 isInFlightState 而不是
            isSettledState：未开始/等前序的步骤没有在途的卡，不该给这个入口。 */}
        {isInFlightState(view.state) && cards.length > 0 ? (
          <button
            type="button"
            className="workflow-cards__link"
            data-testid={`workflow-cards-stop-${view.step.stepId}`}
            onClick={onStop}
          >
            {t("Stop this card")}
          </button>
        ) : null}
      </div>
      {rounds.length > 0 ? (
        <ol
          className="workflow-cards__records"
          data-testid={`workflow-cards-rounds-${view.step.stepId}`}
        >
          {rounds.map((execution) => (
            <li key={execution.round} data-round={execution.round}>
              {t("Run {round}", { round: String(execution.round) })}
              {execution.cards.length > 0 ? ` · ${execution.cards.join("、")}` : ""}
              {execution.verdict
                ? ` · ${t("Verdict: {verdict}", { verdict: execution.verdict })}`
                : ""}
            </li>
          ))}
        </ol>
      ) : null}
      {view.state === "review" ? (
        <div className="workflow-cards__confirm">
          <span>{t("This step delivered; it waits for your confirmation.")}</span>
          <button
            type="button"
            className="button"
            data-testid={`workflow-cards-confirm-${view.step.stepId}`}
            disabled={view.node === undefined || view.node.statusKnown === false}
            onClick={onConfirm}
          >
            {t("Confirm and release")}
          </button>
        </div>
      ) : null}
    </li>
  );
}

interface OutputGroupProps {
  readonly entry: ReturnType<typeof stepOutputEntries>[number];
  readonly index: number;
  readonly row: TemporaryPlanStepProgressRow | undefined;
  readonly previewPath: string | undefined;
  readonly previewRound: number | undefined;
  readonly onPreview: (path: string, round?: number) => void;
  readonly t: (key: string, params?: Record<string, string | number>) => string;
}

function OutputGroup({
  entry,
  index,
  row,
  previewPath,
  previewRound,
  onPreview,
  t,
}: OutputGroupProps) {
  const artifacts = row?.artifacts ?? [];
  return (
    <li className="workflow-cards__output-group">
      <h3>
        {index + 1}. {entry.title} · {entry.dept}
      </h3>
      <h4 className="workflow-cards__subtitle">{t("Real products found on disk")}</h4>
      {artifacts.length === 0 ? (
        <p
          className="workflow-cards__rail-hint"
          data-testid={`workflow-cards-no-artifact-${entry.stepId}`}
        >
          {row === undefined
            ? t("This step has no running instance yet, so nothing was produced.")
            : t("Nothing has been produced for this step yet.")}
        </p>
      ) : (
        <ul className="workflow-cards__file-list">
          {artifacts.map((artifact) => {
            const active =
              artifact.relativePath === previewPath &&
              (previewRound === undefined || previewRound === artifact.round);
            return (
              <li key={`${artifact.relativePath}\u0000${artifact.round}\u0000${artifact.card}`}>
                <button
                  type="button"
                  className={`workflow-cards__file-row ${active ? "is-active" : ""}`}
                  aria-pressed={active}
                  data-testid={`workflow-cards-artifact-${artifact.relativePath}`}
                  data-round={artifact.round}
                  onClick={() => onPreview(artifact.relativePath, artifact.round)}
                >
                  <span>{artifact.relativePath}</span>
                  <span className="workflow-cards__rail-meta">
                    {artifact.exists ? t("On disk") : t("Missing from disk")} ·{" "}
                    {artifact.versionBasis}
                    {artifact.currentRound ? "" : ` · ${t("Earlier version")}`}
                  </span>
                </button>
                {artifact.exists ? null : (
                  <p className="workflow-cards__rail-hint">{artifact.note}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {row?.readProblem ? <p className="workflow-cards__note">{row.readProblem}</p> : null}
      <p className="workflow-cards__output-file">
        {entry.expected ?? t("No expected artifact was written.")}
        <span className="workflow-cards__badge workflow-cards__badge--muted">
          {t("Expected artifact (requirement, not a product)")}
        </span>
      </p>
    </li>
  );
}

interface OutputListProps {
  readonly outputs: ReturnType<typeof stepOutputEntries>;
  readonly fileGroups: ReturnType<typeof fileOpinionGroups>;
  readonly progress: ReadonlyMap<string, TemporaryPlanStepProgressRow>;
  readonly previewPath: string | undefined;
  readonly previewRound: number | undefined;
  readonly onPreview: (path: string, round?: number) => void;
  readonly t: (key: string, params?: Record<string, string | number>) => string;
}

function OutputList({
  outputs,
  fileGroups,
  progress,
  previewPath,
  previewRound,
  onPreview,
  t,
}: OutputListProps) {
  return (
    <div className="workflow-cards__outputs" data-testid="workflow-cards-outputs">
      <p className="workflow-cards__note">
        {t(
          "Real products come from delivered cards' receipts and are checked on disk; expected artifacts come from the plan definition and are requirements, not products.",
        )}
      </p>
      <ol className="workflow-cards__output-groups">
        {outputs.map((entry, index) => (
          <OutputGroup
            key={entry.stepId}
            entry={entry}
            index={index}
            row={progress.get(entry.stepId)}
            previewPath={previewPath}
            previewRound={previewRound}
            onPreview={onPreview}
            t={t}
          />
        ))}
      </ol>
      <h3 className="workflow-cards__subtitle">{t("Opinions recorded against files")}</h3>
      {fileGroups.length === 0 ? (
        <p className="workflow-cards__rail-hint">{t("No file opinion yet.")}</p>
      ) : (
        <ul className="workflow-cards__file-list">
          {fileGroups.map((group) => {
            const groupKey =
              group.round === undefined ? group.path : `${group.path}@${group.round}`;
            const active =
              group.path === previewPath &&
              (previewRound === undefined || previewRound === group.round);
            return (
              <li key={groupKey}>
                <button
                  type="button"
                  className={`workflow-cards__file-row ${active ? "is-active" : ""}`}
                  aria-pressed={active}
                  data-testid={`workflow-cards-file-${groupKey}`}
                  onClick={() => onPreview(group.path, group.round)}
                >
                  <span>{fileScopeLabel(group)}</span>
                  <span className="workflow-cards__rail-meta">
                    {t("{count} opinions", { count: String(group.opinions.length) })}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

interface StepDetailProps {
  readonly plan: TemporaryPlanRow;
  readonly view: StepCardView;
  readonly progressRow: TemporaryPlanStepProgressRow | undefined;
  /** 耗时文案（卡面 created→completed 的真值；算不出时说清为什么，不写 0）。 */
  readonly durationText: string;
  readonly depts: readonly string[];
  readonly deptUnavailable: boolean;
  readonly locked: boolean;
  readonly changes: StepChanges;
  readonly onChange: (patch: StepChanges) => void;
  readonly onRequestModify: () => void;
  readonly onRequestUndo: () => void;
  readonly opinionText: string;
  readonly onOpinionText: (value: string) => void;
  readonly onSubmitOpinion: () => void;
  readonly onDiscuss: () => void;
  readonly t: (key: string, params?: Record<string, string | number>) => string;
}

function StepDetail({
  plan,
  view,
  progressRow,
  durationText,
  depts,
  deptUnavailable,
  locked,
  changes,
  onChange,
  onRequestModify,
  onRequestUndo,
  opinionText,
  onOpinionText,
  onSubmitOpinion,
  onDiscuss,
  t,
}: StepDetailProps) {
  const opinions = stepOpinions(plan, view.step.stepId);
  const records = progressRow?.records ?? [];
  const step = view.step;
  return (
    <div className="workflow-cards__detail">
      <h2 className="workflow-cards__detail-title">
        {t("Step details")} · {step.title}
      </h2>
      <p className="workflow-cards__rail-meta" data-testid="workflow-cards-detail-state">
        {t(STEP_CARD_STATE_LABELS[view.state])}
        {view.round !== undefined ? ` · ${t("Round {round}", { round: String(view.round) })}` : ""}
        {view.delivered ? ` · ${t("Delivered")}` : ""}
        {view.confirmedAt ? ` · ${t("Confirmed at {at}", { at: view.confirmedAt })}` : ""}
      </p>
      {view.waitingOn.length > 0 ? (
        <p className="workflow-cards__hint" data-testid="workflow-cards-detail-waiting">
          {t("Waiting for these steps")}: {view.waitingOn.join("、")}
        </p>
      ) : null}
      <p className="workflow-cards__rail-meta" data-testid="workflow-cards-detail-duration">
        {t("Step duration")}: {durationText}
      </p>
      {view.gateWaitingOn.length > 0 ? (
        <p className="workflow-cards__hint" data-testid="workflow-cards-detail-gate">
          {t("Waiting for a human gate on")}: {view.gateWaitingOn.join("、")}
        </p>
      ) : null}
      <button
        type="button"
        className="workflow-cards__link"
        data-testid="workflow-cards-detail-discuss"
        onClick={onDiscuss}
      >
        {t("Discuss this step")}
      </button>
      <label className="workflow-cards__field">
        <span>{t("Step title")}</span>
        <input
          data-testid="workflow-cards-field-title"
          value={changes.title ?? step.title}
          disabled={locked}
          onChange={(event) => onChange({ title: event.target.value })}
        />
      </label>
      <label className="workflow-cards__field">
        <span>{t("Department")}</span>
        <select
          data-testid="workflow-cards-field-dept"
          value={changes.dept ?? step.dept}
          disabled={locked}
          onChange={(event) => onChange({ dept: event.target.value })}
        >
          {deptUnavailable ? (
            <option value={step.dept}>{`${step.dept} (${t("no longer available")})`}</option>
          ) : null}
          {depts.map((dept) => (
            <option value={dept} key={dept}>
              {dept}
            </option>
          ))}
        </select>
      </label>
      <label className="workflow-cards__field">
        <span>{t("Requirement")}</span>
        <textarea
          data-testid="workflow-cards-field-requirement"
          value={changes.requirement ?? step.requirement}
          disabled={locked}
          rows={3}
          onChange={(event) => onChange({ requirement: event.target.value })}
        />
      </label>
      <label className="workflow-cards__field">
        <span>{t("Expected artifacts")}</span>
        <textarea
          data-testid="workflow-cards-field-artifacts"
          value={changes.expectedArtifacts ?? step.expectedArtifacts ?? ""}
          disabled={locked}
          rows={2}
          onChange={(event) => onChange({ expectedArtifacts: event.target.value })}
        />
      </label>
      <p className="workflow-cards__hint">
        {locked
          ? t("A running plan stays unchanged; hand changes to the main conversation instead.")
          : t("Changes apply to this temporary plan only, through the main conversation.")}
      </p>
      <div className="workflow-cards__row">
        <button
          type="button"
          className="button"
          data-testid="workflow-cards-apply-changes"
          disabled={locked}
          onClick={onRequestModify}
        >
          {t("Hand this change to the main conversation")}
        </button>
        <button type="button" className="button button--ghost" onClick={onRequestUndo}>
          {t("Undo the last change")}
        </button>
      </div>
      <h3 className="workflow-cards__subtitle">{t("Runs of this step")}</h3>
      {records.length === 0 ? (
        <p className="workflow-cards__hint" data-testid="workflow-cards-records-empty">
          {t("This step has not run yet.")}
        </p>
      ) : (
        <ul className="workflow-cards__records" data-testid="workflow-cards-records">
          {records.map((record) => (
            <li
              className="workflow-cards__record"
              key={`${record.round}:${record.cards.join(",")}`}
            >
              <span className="workflow-cards__record-round">
                {t("Run {round}", { round: String(record.round) })}
              </span>
              {record.verdict ? (
                <span className="workflow-cards__record-verdict">
                  {t("Verdict: {verdict}", { verdict: record.verdict })}
                </span>
              ) : null}
              {record.reason ? (
                <span className="workflow-cards__record-reason">{record.reason}</span>
              ) : null}
              <details className="workflow-cards__record-raw">
                <summary>{t("Raw record")}</summary>
                <pre>{`round=${record.round}
cards=${record.cards.join(",")}
verdict=${record.verdict ?? ""}
reason=${record.reason ?? ""}`}</pre>
              </details>
            </li>
          ))}
        </ul>
      )}
      <h3 className="workflow-cards__subtitle">{t("Opinion on this step")}</h3>
      <textarea
        data-testid="workflow-cards-step-opinion"
        value={opinionText}
        rows={3}
        aria-label={t("Opinion on this step")}
        placeholder={t("Write what should change, then hand it over")}
        onChange={(event) => onOpinionText(event.target.value)}
      />
      <div className="workflow-cards__row">
        <button type="button" className="button" onClick={onSubmitOpinion}>
          {t("Hand this opinion over")}
        </button>
      </div>
      <h3 className="workflow-cards__subtitle">{t("Recorded opinions")}</h3>
      {opinions.length === 0 ? (
        <p className="workflow-cards__rail-hint">{t("No opinion recorded on this step yet.")}</p>
      ) : (
        <ul className="workflow-cards__opinions">
          {opinions.map((row) => (
            <li key={row.feedbackId}>
              <span className="workflow-cards__badge workflow-cards__badge--muted">
                {row.status}
              </span>
              {row.detail ? <div>{row.detail}</div> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface FilePreviewProps {
  readonly api: PiDesktopApi;
  readonly workspaceId: string;
  readonly plan: TemporaryPlanRow;
  readonly path: string | undefined;
  readonly round: number | undefined;
  readonly onSwitchRound: (path: string, round?: number) => void;
  readonly progress: ReadonlyMap<string, TemporaryPlanStepProgressRow>;
  readonly reading: boolean;
  readonly onToggleReading: () => void;
  readonly readingPositionsRef: React.RefObject<Map<string, number>>;
  readonly onLocate: (stepId: string) => void;
  readonly onBackToStep: () => void;
  readonly opinionText: string;
  readonly onOpinionText: (value: string) => void;
  readonly onSubmitOpinion: () => void;
  readonly onDiscussThisFile: () => void;
  readonly t: (key: string, params?: Record<string, string | number>) => string;
}

function FilePreview({
  api,
  workspaceId,
  plan,
  path,
  round,
  onSwitchRound,
  progress,
  reading,
  onToggleReading,
  readingPositionsRef,
  onLocate,
  onBackToStep,
  opinionText,
  onOpinionText,
  onSubmitOpinion,
  onDiscussThisFile,
  t,
}: FilePreviewProps) {
  const progressRows = [...progress.values()];
  const versions = useMemo(() => artifactVersions(progress, path), [progress, path]);
  const artifact = pickArtifactVersion(versions, round);
  const latest = versions.length > 0 ? versions[versions.length - 1] : undefined;
  const pinned = round !== undefined ? versions.find((row) => row.round === round) : undefined;
  /** 我正看的这一版之外又出了新版：只提示，不抢换正文（计划 §6.4）。 */
  const newerExists = pinned !== undefined && latest !== undefined && latest.round > pinned.round;
  /** 钉住的轮次已不在记录里：退回最新版并如实说清「这正文不是当初那一版」。 */
  const versionDrifted = round !== undefined && pinned === undefined && artifact !== undefined;
  const opinions = path
    ? plan.feedback.filter(
        (row) =>
          row.targetKind === "文件" &&
          row.target === path &&
          (artifact === undefined || row.round === undefined || row.round === artifact.round),
      )
    : [];
  const grouped = groupFeedbackByStatus(opinions);
  const artifactStepId = artifact
    ? progressRows.find((row) => row.artifacts.includes(artifact))?.stepId
    : undefined;
  const locatedStepId =
    artifactStepId ?? plan.steps.find((step) => step.expectedArtifacts === path)?.stepId;
  const locatedIndex = plan.steps.findIndex((step) => step.stepId === locatedStepId);
  const locatedStep = locatedIndex >= 0 ? plan.steps[locatedIndex] : undefined;
  const artifactPath = artifact?.exists ? artifact.relativePath : undefined;
  /** 同一路径被后一轮重写过、且没有分轮副本：正文可能是新版。 */
  const bodyMayBeOverwritten = newerExists || versionDrifted;
  const [body, setBody] = useState<WorkspaceFilePreview | undefined>();
  const [bodyError, setBodyError] = useState<string | undefined>();
  const positionKey = path === undefined ? undefined : `${path}\u0000${round ?? ""}`;
  const containerRef = useRef<HTMLDivElement | undefined>(undefined);

  /**
   * 打开预览时把焦点送进右栏（计划 §7.1 第 7 条「右栏是完整成果正文、可专注阅读」）。
   * 焦点落在预览容器本身而不是内部 textarea：键盘用户下一步是 Tab 到「专注阅读/定位所属步骤」，
   * 程序化聚焦到输入控件会让人以为可以直接打字。
   */
  useEffect(() => {
    if (path === undefined) return;
    containerRef.current?.focus();
  }, [path, round]);

  useEffect(() => {
    setBody(undefined);
    setBodyError(undefined);
    if (!artifactPath) return;
    let cancelled = false;
    api
      .readWorkspaceFile(workspaceId, artifactPath)
      .then((result) => {
        if (!cancelled) setBody(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) setBodyError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [api, workspaceId, artifactPath]);

  if (!path) {
    return (
      <div className="workflow-cards__detail">
        <p className="workflow-cards__rail-hint" data-testid="workflow-cards-file-empty">
          {t("Pick a real product or a file with a recorded opinion to preview it here.")}
        </p>
      </div>
    );
  }
  return (
    <div
      className={`workflow-cards__detail ${reading ? "is-reading" : ""}`}
      data-testid="workflow-cards-file-preview"
      ref={(node) => {
        containerRef.current = node ?? undefined;
      }}
      tabIndex={-1}
      role="region"
      aria-label={t("File preview")}
    >
      <h2 className="workflow-cards__detail-title">
        {path}{" "}
        <span className="workflow-cards__badge workflow-cards__badge--muted">{t("Read only")}</span>
      </h2>
      {artifact ? (
        <p className="workflow-cards__rail-meta" data-testid="workflow-cards-file-origin">
          {locatedStep
            ? `${t("From step {index} · {title}", {
                index: String(locatedIndex + 1),
                title: locatedStep.title,
              })} · `
            : ""}
          {artifact.versionBasis}
          {artifact.currentRound ? ` · ${t("Current round")}` : ` · ${t("Earlier version")}`}
          {artifact.exists ? "" : ` · ${t("Missing from disk")}`}
        </p>
      ) : (
        <p className="workflow-cards__rail-meta" data-testid="workflow-cards-file-unrecorded">
          {t("No card receipt recorded this path as a product.")}
        </p>
      )}
      {versions.length > 1 ? (
        <div className="workflow-cards__row" data-testid="workflow-cards-file-versions">
          <span className="workflow-cards__rail-meta">{t("Versions of this path:")}</span>
          {versions.map((row) => (
            <button
              type="button"
              className={`button button--ghost ${row === artifact ? "is-active" : ""}`}
              aria-pressed={row === artifact}
              data-testid={`workflow-cards-file-version-${row.round}`}
              key={`${row.round}\u0000${row.card}`}
              onClick={() => onSwitchRound(path, row.round)}
            >
              {row.versionBasis}
              {row.currentRound ? ` · ${t("Current round")}` : ""}
            </button>
          ))}
        </div>
      ) : null}
      {newerExists ? (
        <p className="workflow-cards__note" data-testid="workflow-cards-file-newer">
          {t(
            "A newer version of this path exists ({basis}). The preview stays on the version you opened; switch when you are ready.",
            { basis: latest?.versionBasis ?? "" },
          )}
        </p>
      ) : null}
      {versionDrifted ? (
        <p className="workflow-cards__note" data-testid="workflow-cards-file-version-missing">
          {t(
            "The round you pinned is no longer recorded; showing the latest version instead. Do not read this body as the version the opinions below were written against.",
          )}
        </p>
      ) : null}
      {bodyMayBeOverwritten ? (
        <p className="workflow-cards__note" data-testid="workflow-cards-file-overwritten">
          {t(
            "This path was written again in a later round and no per-round copy exists, so the body on disk may already be the newer one.",
          )}
        </p>
      ) : null}
      {artifact && !artifact.exists ? (
        <p className="workflow-cards__note" data-testid="workflow-cards-file-missing">
          {artifact.note ?? t("The recorded product is not on disk now.")}
        </p>
      ) : null}
      <div className="workflow-cards__row">
        <button type="button" className="button button--ghost" onClick={onToggleReading}>
          {reading ? t("Stop focused reading") : t("Focused reading")}
        </button>
        <button
          type="button"
          className="button button--ghost"
          data-testid="workflow-cards-locate-step"
          disabled={locatedStepId === undefined}
          onClick={() => {
            if (locatedStepId) onLocate(locatedStepId);
          }}
        >
          {t("Locate its step")}
        </button>
        <button
          type="button"
          className="button button--ghost"
          data-testid="workflow-cards-back-to-step"
          onClick={onBackToStep}
        >
          {t("Back to step details")}
        </button>
        <button
          type="button"
          className="button button--ghost"
          data-testid="workflow-cards-file-discuss"
          onClick={onDiscussThisFile}
        >
          {t("Discuss this file")}
        </button>
      </div>
      {body ? (
        <div
          data-testid="workflow-cards-file-body"
          onScroll={(event) => {
            if (positionKey)
              readingPositionsRef.current.set(positionKey, event.currentTarget.scrollTop);
          }}
        >
          {body.binary ? (
            <p className="workflow-cards__note">
              {t("This file looks binary; its body is not shown.")}
            </p>
          ) : (
            <pre className="workflow-cards__file-body">{body.content}</pre>
          )}
          {body.truncated ? (
            <p className="workflow-cards__note">{t("The preview is truncated.")}</p>
          ) : null}
        </div>
      ) : bodyError ? (
        <p className="workflow-cards__note" data-testid="workflow-cards-file-error">
          {t("Cannot read the file body: {message}", { message: bodyError })}
        </p>
      ) : artifactPath ? (
        <p className="workflow-cards__note">{t("Loading the file body…")}</p>
      ) : (
        <p className="workflow-cards__note" data-testid="workflow-cards-file-no-body">
          {t(
            "No confirmed product matches this path, so there is no body to show; only opinions recorded against it are listed.",
          )}
        </p>
      )}
      {[...grouped.entries()].map(([status, rows]) => (
        <div key={status}>
          <h3 className="workflow-cards__subtitle">{status}</h3>
          <ul className="workflow-cards__opinions">
            {rows.map((row) => (
              <li key={row.feedbackId}>{row.detail ?? row.target}</li>
            ))}
          </ul>
        </div>
      ))}
      <h3 className="workflow-cards__subtitle">{t("Opinion on this file")}</h3>
      <textarea
        data-testid="workflow-cards-file-opinion"
        value={opinionText}
        rows={3}
        aria-label={t("Opinion on this file")}
        onChange={(event) => onOpinionText(event.target.value)}
      />
      <div className="workflow-cards__row">
        <button type="button" className="button" onClick={onSubmitOpinion}>
          {t("Hand this opinion over")}
        </button>
      </div>
    </div>
  );
}
