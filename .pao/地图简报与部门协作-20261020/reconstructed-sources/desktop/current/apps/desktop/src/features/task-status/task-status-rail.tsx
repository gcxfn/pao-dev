import { useCallback, useEffect, useMemo, useRef, useState, type Ref } from "react";
import type { PiDesktopApi } from "../../../contracts/ipc";
import type { DesktopAppState } from "../../../contracts/desktop-state";
import type { TranscriptMessage } from "../../../contracts/timeline-types";
import type { TemporaryPlanRow, TemporaryPlansResult } from "../../../contracts/temporary-plans";
import type {
  WorkflowControlIdentity,
  WorkflowControlResult,
} from "../../../contracts/workflow-control";
import type { KanbanResult } from "../../../contracts/kanban";
import { useViewAutoRefresh } from "../../ui/view-auto-refresh";
import { ChevronRightIcon } from "../../ui/icons";
import { useI18n } from "../../i18n/react";
import {
  STEP_CARD_STATE_LABELS,
  isActionableState,
  isInFlightState,
  isSettledState,
  needsAttentionState,
  stepCardViews,
  type StepCardView,
} from "../workflow-cards/workflow-cards-model";
import {
  acceptsTaskStatusControl,
  beginTaskStatusControl,
  currentDepartmentGroups,
  latestPlanStart,
  latestSessionTodos,
  loadTaskStatusControl,
  taskStatusControlForPlan,
  type TaskStatusControlSnapshot,
} from "./task-status-model";
import { useTaskStatusFiles, type TaskStatusFilesSummary } from "./use-task-status-files";

export interface TaskPlanTarget {
  readonly workspaceId: string;
  readonly planId?: string;
  readonly stepId?: string;
}

interface PlanStatus {
  readonly plan: TemporaryPlanRow;
  readonly control: TaskStatusControlSnapshot;
  readonly steps: readonly StepCardView[];
  readonly running: readonly StepCardView[];
  readonly attention: readonly StepCardView[];
  readonly reviews: readonly StepCardView[];
  readonly completed: readonly StepCardView[];
}

export function TaskStatusRail({
  api,
  snapshot,
  workspaceId,
  sessionId,
  transcript,
  transcriptLoading,
  transcriptFailed,
  compact,
  rootRef,
  onOpenPlan,
  onOpenDepartment,
  onOpenBoard,
  onOpenChanges,
  onCollapse,
  onExpand,
}: {
  readonly api: PiDesktopApi;
  readonly snapshot: DesktopAppState;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly transcript: readonly TranscriptMessage[];
  readonly transcriptLoading: boolean;
  readonly transcriptFailed: boolean;
  readonly compact: boolean;
  readonly rootRef?: Ref<HTMLElement>;
  readonly onOpenPlan: (target: TaskPlanTarget) => Promise<void>;
  readonly onOpenDepartment: (groupId: string) => Promise<void>;
  readonly onOpenBoard: () => Promise<void>;
  readonly onOpenChanges: () => void;
  readonly onCollapse: () => void;
  readonly onExpand: () => void;
}) {
  const { t } = useI18n();
  const workspace = snapshot.workspaces.find((row) => row.id === workspaceId);
  const session = workspace?.sessions.find((row) => row.id === sessionId);
  const target = workspaceId && sessionId ? { workspaceId, sessionId } : null;
  const filesState = useTaskStatusFiles(api, target);
  const files = filesState.summary;
  const [plansResult, setPlans] = useState<TemporaryPlansResult>();
  const [kanban, setKanban] = useState<KanbanResult>();
  const [controls, setControls] = useState<Record<string, TaskStatusControlSnapshot>>({});
  const [loading, setLoading] = useState(false);
  const [selectedPlanId, setSelectedPlanId] = useState<string>();
  const [navigationError, setNavigationError] = useState<string>();
  const requestId = useRef(0);
  const controlGeneration = useRef(0);
  const plansRef = useRef<readonly TemporaryPlanRow[]>([]);
  const navigate = (action: () => Promise<void>) => {
    setNavigationError(undefined);
    void action().catch((error: unknown) => setNavigationError(String(error)));
  };
  const refreshRail = useCallback(() => {
    const id = ++requestId.current;
    if (!workspaceId) return;
    setLoading(true);
    void Promise.allSettled([api.getTemporaryPlans({ workspaceId }), api.getKanban(workspaceId)])
      .then(([plans, cards]) => {
        if (requestId.current !== id) return;
        setPlans(
          plans.status === "fulfilled"
            ? plans.value
            : { state: "failed", message: String(plans.reason) },
        );
        setKanban(
          cards.status === "fulfilled"
            ? cards.value
            : { state: "unavailable", message: String(cards.reason) },
        );
      })
      .catch(() => {
        // allSettled 不会拒绝；这里只兜住后续 setState 之外的意外，避免刷新中断。
      })
      .finally(() => {
        if (requestId.current === id) setLoading(false);
      });
  }, [api, workspaceId]);
  const refresh = useCallback(() => {
    refreshRail();
    filesState.refresh();
  }, [filesState.refresh, refreshRail]);
  useEffect(() => {
    refresh();
    return () => {
      requestId.current++;
    };
  }, [refresh]);
  useViewAutoRefresh(refresh);

  const plans = useMemo(
    () =>
      plansResult?.state === "ok" && sessionId
        ? plansResult.plans.filter((row) => row.sourceSessionId === sessionId && !row.undone)
        : [],
    [plansResult, sessionId],
  );
  plansRef.current = plans;

  useEffect(() => {
    if (!workspaceId || plans.length === 0) {
      setControls({});
      return;
    }
    let canceled = false;
    const generation = ++controlGeneration.current;
    for (const plan of plans) {
      const start = latestPlanStart(plan);
      if (!start) {
        setControls((current) => ({
          ...current,
          [plan.planId]: {
            planId: plan.planId,
            start: undefined,
            generation,
            state: "idle",
          },
        }));
        continue;
      }
      void loadTaskStatusControl(plan.planId, start, {
        begin: (snapshot) => setControls((current) => ({ ...current, [plan.planId]: snapshot })),
        isCurrent: () => !canceled,
        generation,
        apply: (snapshot) => {
          if (canceled) return;
          setControls((current) => {
            const latest = plansRef.current.find((row) => row.planId === snapshot.planId);
            const latestStart = latest ? latestPlanStart(latest) : undefined;
            return latestStart &&
              acceptsTaskStatusControl(snapshot, current[snapshot.planId]) &&
              latestStart.startRequestId === snapshot.start?.startRequestId &&
              latestStart.instanceId === snapshot.start.instanceId &&
              latestStart.controlPath === snapshot.start.controlPath &&
              latestStart.ownerSessionId === snapshot.start.ownerSessionId
              ? { ...current, [snapshot.planId]: snapshot }
              : current;
          });
        },
        read: (currentStart) =>
          api
            .getWorkflowControl({
              workspaceId,
              instanceName: currentStart.recipeName,
              instancePath: currentStart.controlPath,
            })
            .then((result): WorkflowControlResult => result),
      }).catch((error: unknown) => {
        if (!canceled) console.error("[renderer] workflow control state failed", error);
      });
    }
    return () => {
      canceled = true;
    };
  }, [api, plans, workspaceId]);

  const planStatuses = useMemo<readonly PlanStatus[]>(
    () =>
      plans.map((plan) => {
        const start = latestPlanStart(plan);
        const control = taskStatusControlForPlan(
          plan,
          controls[plan.planId],
          controlGeneration.current,
        );
        const steps =
          control.state === "failed" ? [] : stepCardViews(plan, control.control, start?.progress);
        return {
          plan,
          control,
          steps,
          running: steps.filter((step) => isInFlightState(step.state)),
          attention: steps.filter((step) => needsAttentionState(step.state)),
          reviews: steps.filter((step) => isActionableState(step.state)),
          completed: steps.filter((step) => isSettledState(step.state)),
        };
      }),
    [controls, plans],
  );

  const selectedPlan =
    planStatuses.find((row) => row.plan.planId === selectedPlanId) ?? planStatuses[0];
  const sessionTodos = useMemo(() => latestSessionTodos(transcript), [transcript]);
  const groups = useMemo(
    () => currentDepartmentGroups(kanban, workspace?.path, sessionId),
    [kanban, workspace?.path, sessionId],
  );
  const activeGroups = groups.filter((row) => row.state !== "done" && row.state !== "canceled");
  const finishedGroups = groups.filter((row) => row.state === "done" || row.state === "canceled");
  const shortSummary = taskStatusShortSummary({
    plans: planStatuses,
    groups: activeGroups,
    files,
    sessionTitle: session?.title,
  });
  const openPlan = (targetPlan = selectedPlan, stepId?: string) => {
    if (workspaceId) {
      navigate(() =>
        onOpenPlan({
          workspaceId,
          planId: targetPlan?.plan.planId,
          stepId,
        }),
      );
    }
  };

  if (compact) {
    return (
      <aside
        ref={rootRef}
        className={`task-status-compact task-status-compact--${shortSummary.tone}`}
        aria-label="当前工作概况"
      >
        <button
          type="button"
          className="task-status-compact__button"
          data-testid="task-status-expand"
          aria-label={`展开当前工作概况：${shortSummary.text}`}
          title={shortSummary.text}
          onClick={onExpand}
        >
          <span className="task-status-compact__dot" aria-hidden="true" />
          <span className="task-status-compact__text">{shortSummary.text}</span>
        </button>
      </aside>
    );
  }

  const departmentRow = (group: (typeof groups)[number]) => (
    <button
      key={group.id}
      type="button"
      className="task-status__department"
      data-testid="task-status-department"
      onClick={() => navigate(() => onOpenDepartment(group.id))}
    >
      <span className="task-status__department-head">
        <strong>{group.department}</strong>
        <span data-state={group.state}>
          {
            {
              ready: "准备",
              running: "进行中",
              blocked: "阻塞",
              done: "已完成",
              canceled: "已取消",
            }[group.state]
          }
        </span>
      </span>
      <span className="task-status__line" title={group.title}>
        {group.title}
      </span>
      <small>
        {
          group.cards.filter((card) => card.status === "delivered" || card.status === "canceled")
            .length
        }{" "}
        / {group.cards.length} 张卡完成
        {group.node ? ` · 第 ${group.node.round} 轮` : ""}
        {group.flow ? ` · ${group.flow.instance}` : ""}
      </small>
      <small
        title={group.workers
          .map((row) => row.executionId)
          .filter(Boolean)
          .join("\n")}
      >
        {(() => {
          const executions = group.workers.filter((row) => row.executionId);
          return executions.length > 0
            ? `${executions.length} 个实际执行 · ${executions[0]?.executionId}${executions.length > 1 ? "…" : ""}`
            : "尚无实际执行标识";
        })()}
      </small>
      {group.state === "blocked" && group.reason ? (
        <details className="task-status__long">
          <summary className="task-status__warning">
            {group.reason.length > 80 ? `${group.reason.slice(0, 80)}…` : group.reason}
          </summary>
          <p>{group.reason}</p>
        </details>
      ) : null}
    </button>
  );
  return (
    <aside
      ref={rootRef}
      className="task-status task-status-dock"
      data-testid="task-status"
      aria-label="当前工作概况"
    >
      <header className="task-status__header">
        <div>
          <strong>当前工作概况</strong>
          <span title={session?.title}>{session?.title ?? "尚未选择会话"}</span>
          {navigationError ? <p role="alert">打开失败：{navigationError}</p> : null}
        </div>
        <div className="task-status__header-actions">
          <button
            type="button"
            className="task-status__link"
            disabled={loading || !workspaceId}
            onClick={refresh}
          >
            刷新
          </button>
          <button
            type="button"
            className="icon-button task-status__icon-button"
            data-testid="task-status-collapse"
            aria-label="收起当前工作概况"
            title="收起当前工作概况"
            onClick={onCollapse}
          >
            <ChevronRightIcon />
          </button>
        </div>
      </header>
      <section className="task-status__section" aria-label="文件变更">
        <div className="task-status__section-head">
          <h2>文件变更</h2>
          <button
            type="button"
            className="task-status__link"
            data-testid="task-status-open-changes"
            disabled={!target}
            onClick={onOpenChanges}
          >
            查看差异 ↗
          </button>
        </div>
        <div className="task-status__scroll" data-testid="task-status-files">
          <FileSummary summary={files} />
        </div>
      </section>
      <section className="task-status__section" aria-label="目标与待办">
        <div className="task-status__section-head">
          <h2>目标与待办</h2>
          <button
            type="button"
            className="task-status__link"
            data-testid="task-status-open-workflow"
            disabled={!workspaceId}
            onClick={() => openPlan()}
          >
            计划详情 ↗
          </button>
        </div>
        <div className="task-status__scroll" data-testid="task-status-todos">
          {transcriptFailed ? (
            <p role="alert">会话读取失败，会话待办暂不可用。</p>
          ) : transcriptLoading ? (
            <p role="status">正在读取会话待办…</p>
          ) : null}
          {sessionTodos.notice ? (
            <p role="status" className="task-status__warning">
              {sessionTodos.notice}
            </p>
          ) : null}
          {sessionTodos.items !== undefined ? (
            <div className="task-status__todo-group">
              <h3>会话待办</h3>
              {sessionTodos.items.length === 0 ? (
                <p className="task-status__empty">清单已清空</p>
              ) : (
                <ul>
                  {sessionTodos.items.map((todo, index) => (
                    <li key={index} className="task-status__todo" data-state={todo.status}>
                      <span
                        aria-label={t(
                          {
                            pending: "Pending",
                            in_progress: "In progress",
                            completed: "Done",
                            cancelled: "Cancelled",
                          }[todo.status],
                        )}
                      >
                        {
                          {
                            pending: "○",
                            in_progress: "◐",
                            completed: "✓",
                            cancelled: "⊘",
                          }[todo.status]
                        }
                      </span>
                      <span>{todo.content}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
          {plansResult?.state === "failed" ? (
            <p role="alert">计划读取失败：{plansResult.message}</p>
          ) : null}
          {plansResult?.state === "ok" && plansResult.issues.length > 0 ? (
            <p role="alert" className="task-status__warning">
              有 {plansResult.issues.length} 份计划读取异常，请打开计划详情核对。
            </p>
          ) : null}
          {planStatuses.length > 1 ? (
            <select
              aria-label="当前工作计划"
              value={selectedPlan?.plan.planId}
              onChange={(event) => setSelectedPlanId(event.target.value)}
            >
              {planStatuses.map((row) => (
                <option value={row.plan.planId} key={row.plan.planId}>
                  {row.plan.displayName}
                </option>
              ))}
            </select>
          ) : null}
          {planStatuses.map((status) => (
            <PlanDetails
              key={status.plan.planId}
              status={status}
              selected={status.plan.planId === selectedPlan?.plan.planId}
              onSelect={() => setSelectedPlanId(status.plan.planId)}
              onOpenPlan={(stepId) => openPlan(status, stepId)}
              onOpenPlanDetail={() => openPlan(status)}
              translateState={(state) => t(STEP_CARD_STATE_LABELS[state])}
            />
          ))}
          {!loading && plansResult?.state === "ok" && planStatuses.length === 0 ? (
            <p className="task-status__empty">
              {sessionId ? "当前会话尚无 PAO 计划" : "选择会话后显示其目标"}
            </p>
          ) : null}
        </div>
      </section>
      <section className="task-status__section" aria-label="部门概况">
        <div className="task-status__section-head">
          <h2>部门概况</h2>
          <button
            type="button"
            className="task-status__link"
            data-testid="task-status-open-board"
            disabled={!workspaceId}
            onClick={() => navigate(onOpenBoard)}
          >
            全部任务 ↗
          </button>
        </div>
        <div className="task-status__scroll" data-testid="task-status-departments">
          {kanban?.state === "unavailable" ? (
            <p role="alert">部门状态读取失败：{kanban.message}</p>
          ) : null}
          {activeGroups.map(departmentRow)}
          {!loading && kanban?.state === "available" && activeGroups.length === 0 ? (
            <p className="task-status__empty">
              {sessionId ? "当前会话没有进行中的部门任务" : "选择会话后显示其部门"}
            </p>
          ) : null}
          {finishedGroups.length > 0 ? (
            <details className="task-status__finished">
              <summary>已结束（{finishedGroups.length}）</summary>
              {finishedGroups.map(departmentRow)}
            </details>
          ) : null}
          {kanban?.state === "available" && kanban.issues.length > 0 ? (
            <p role="alert" className="task-status__warning">
              有 {kanban.issues.length} 项读取问题，请查看全部任务。
            </p>
          ) : null}
        </div>
      </section>
    </aside>
  );
}

function PlanDetails({
  status,
  selected,
  onSelect,
  onOpenPlan,
  onOpenPlanDetail,
  translateState,
}: {
  readonly status: PlanStatus;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onOpenPlan: (stepId: string) => void;
  readonly onOpenPlanDetail: () => void;
  readonly translateState: (state: StepCardView["state"]) => string;
}) {
  const { plan, control, steps, attention, reviews, running, completed } = status;
  const activeSteps = steps.filter((step) => !isSettledState(step.state));
  const planLabel =
    attention.length > 0
      ? "需处理"
      : reviews.length > 0
        ? "待确认"
        : running.length > 0
          ? "正在执行"
          : completed.length === steps.length && steps.length > 0
            ? "已完成"
            : steps.length > 0
              ? "未开始"
              : "无步骤";
  const labelTone =
    attention.length > 0
      ? "failed"
      : reviews.length > 0
        ? "review"
        : running.length > 0
          ? "running"
          : "idle";
  return (
    <details
      className="task-status__plan"
      data-active={running.some((step) => step.state === "running")}
      {...(selected ? { open: true } : {})}
      onClick={onSelect}
    >
      <summary>
        <span className="task-status__plan-title" title={plan.displayName}>
          {plan.displayName}
        </span>
        <span data-state={labelTone}>{planLabel}</span>
      </summary>
      <div className="task-status__plan-body">
        <button type="button" className="task-status__link" onClick={onOpenPlanDetail}>
          查看完整要求 ↗
        </button>
        {control.state === "loading" ? (
          <p role="status">正在核对运行状态…</p>
        ) : control.state === "failed" ? (
          <p role="alert">运行状态读取失败：{control.message}</p>
        ) : (
          <>
            <div className="task-status__progress">
              <span>
                {steps.filter((row) => row.state === "done").length} / {steps.length} 步完成
              </span>
              <span>{latestPlanStart(plan)?.status ?? "尚未启动"}</span>
            </div>
            {activeSteps.length > 0 ? (
              <ol>
                {activeSteps.map((view) => (
                  <StepRow
                    key={view.step.stepId}
                    view={view}
                    label={translateState(view.state)}
                    onOpen={() => onOpenPlan(view.step.stepId)}
                  />
                ))}
              </ol>
            ) : null}
            {completed.length > 0 ? (
              <details className="task-status__finished">
                <summary>已完成步骤（{completed.length}）</summary>
                <ol>
                  {completed.map((view) => (
                    <StepRow
                      key={view.step.stepId}
                      view={view}
                      label={translateState(view.state)}
                      onOpen={() => onOpenPlan(view.step.stepId)}
                    />
                  ))}
                </ol>
              </details>
            ) : null}
          </>
        )}
      </div>
    </details>
  );
}

function StepRow({
  view,
  label,
  onOpen,
}: {
  readonly view: StepCardView;
  readonly label: string;
  readonly onOpen: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="task-status__step"
        data-testid={`task-status-step-${view.step.stepId}`}
        data-state={view.state}
        onClick={onOpen}
      >
        <span aria-hidden="true">
          {view.state === "done"
            ? "✓"
            : view.state === "canceled"
              ? "⊘"
              : view.state === "failed"
                ? "!"
                : "·"}
        </span>
        <span>
          <strong title={view.step.title}>{view.step.title}</strong>
          <small>
            {label}
            {view.round ? ` · 第 ${view.round} 轮` : ""}
            {view.holdReason ? ` · ${view.holdReason}` : ""}
          </small>
        </span>
      </button>
    </li>
  );
}

function FileSummary({ summary }: { readonly summary: TaskStatusFilesSummary }) {
  if (summary.state === "loading") return <p role="status">正在统计未提交变更…</p>;
  if (summary.state === "unavailable") {
    return (
      <p role="alert" className="task-status__warning">
        文件变更不可用：{summary.message}
      </p>
    );
  }
  return (
    <div className="task-status__files">
      <strong>
        {summary.files === 0 ? "工作目录没有未提交变更" : `${summary.files} 个未提交文件`}
      </strong>
      {summary.files ? (
        <span>
          <span className="task-status__stat-add">+{summary.added}</span>{" "}
          <span className="task-status__stat-del">−{summary.removed}</span>
          {summary.unknownLines ? ` · ${summary.unknownLines} 个文件行数未知` : ""}
        </span>
      ) : null}
      <small>范围：当前工作目录的全部未提交变更，包含 untracked 文件。</small>
      {summary.coverageNotes?.length ? (
        <details className="task-status__long">
          <summary className="task-status__warning">统计不完整</summary>
          {summary.coverageNotes.map((note, index) => (
            <p key={index}>{note}</p>
          ))}
        </details>
      ) : null}
    </div>
  );
}

export function taskStatusShortSummary(input: {
  readonly plans: readonly PlanStatus[];
  readonly groups: ReturnType<typeof currentDepartmentGroups>;
  readonly files: TaskStatusFilesSummary;
  readonly sessionTitle?: string;
}): { readonly text: string; readonly tone: "failed" | "review" | "running" | "idle" } {
  for (const row of input.plans) {
    const failed = row.attention[0];
    if (failed) return { text: `需处理：${failed.step.title}`, tone: "failed" };
    if (row.control.state === "failed") {
      return { text: `运行状态不可用：${row.plan.displayName}`, tone: "failed" };
    }
  }
  const blocked = input.groups.find((group) => group.state === "blocked");
  if (blocked) {
    return { text: `失败或阻塞：${blocked.department} · ${blocked.title}`, tone: "failed" };
  }
  for (const row of input.plans) {
    const review = row.reviews[0];
    if (review) return { text: `待确认：${review.step.title}`, tone: "review" };
  }
  const department = input.groups.find((group) => group.state === "running");
  if (department) {
    return {
      text: `进行中：${department.department} · ${department.title}`,
      tone: "running",
    };
  }
  for (const row of input.plans) {
    const step = row.running[0];
    if (step) return { text: `进行中：${step.step.title}`, tone: "running" };
  }
  const fileSuffix =
    input.files.state === "available" && input.files.files
      ? ` · ${input.files.files} 个文件已变更`
      : "";
  return {
    text: `当前工作${input.sessionTitle ? `：${input.sessionTitle}` : ""}${fileSuffix}`,
    tone: "idle",
  };
}
