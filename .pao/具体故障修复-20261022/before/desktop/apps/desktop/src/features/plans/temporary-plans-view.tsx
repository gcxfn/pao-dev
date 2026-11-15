import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PiDesktopApi } from "../../../contracts/ipc";
import type {
  TemporaryPlanRow,
  TemporaryPlansResult,
  TemporaryPlanStepRow,
} from "../../../contracts/temporary-plans";
import { useI18n } from "../../i18n/react";
import { useViewAutoRefresh } from "../../ui/view-auto-refresh";

/**
 * 临时计划整页视图（只读，阶段 4）：
 * 打开拉一次＋手动刷新＋打开期间静默轮询，不缓存、不重造解析——真值全部来自
 * PAO fork 的只读投影（定义读项目内计划.md、启动关联读启动记录并向控制正本核一次）。
 *
 * 这里没有「创建临时工作流」按钮，也不给任何写入口：计划由主控对话经内核工具创建，
 * 页面只按稳定计划 ID 展示定义、启动关联与意见状态。
 */

/** 意见状态是内核真值；顺序固定，未知状态归入最后一组而不是丢掉。 */
const FEEDBACK_STATUS_ORDER = ["已记录", "待送达", "已送达", "投递失败", "已应用"] as const;

export function TemporaryPlansView({
  api,
  workspaceId,
}: {
  readonly api: PiDesktopApi;
  readonly workspaceId: string;
}) {
  const { t } = useI18n();
  const [result, setResult] = useState<TemporaryPlansResult | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [selectedPlanId, setSelectedPlanId] = useState<string | undefined>();
  // 刷新竞速守卫：requestId 递增＋响应比对，旧响应不得覆盖新上下文。
  const requestId = useRef(0);

  const runRefresh = useCallback(
    (silent: boolean) => {
      const currentRequest = ++requestId.current;
      if (!silent) setLoading(true);
      api
        .getTemporaryPlans({ workspaceId })
        .then((value) => {
          if (requestId.current !== currentRequest) return;
          setResult(value);
          setLoadError(undefined);
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

  // 切工作区时不要留着上一个项目的选中项。
  useEffect(() => {
    setSelectedPlanId(undefined);
  }, [workspaceId]);

  const plans = result?.state === "ok" ? result.plans : [];
  const issues = result?.state === "ok" ? result.issues : [];
  const selected = useMemo(
    () => plans.find((plan) => plan.planId === selectedPlanId),
    [plans, selectedPlanId],
  );

  return (
    <section className="canvas plans-view" data-testid="plans-view">
      <header className="view-header">
        <div>
          <h1 className="view-header__title">{t("Temporary plans")}</h1>
          <p className="view-header__body">
            {t(
              "Read-only view of the temporary plans in this project. Plans are created by the main conversation through the PAO tools; this page cannot create or start one.",
            )}
          </p>
        </div>
        <div className="view-header__actions">
          <button
            className="button"
            data-testid="plans-refresh"
            type="button"
            disabled={loading}
            onClick={refresh}
          >
            {t("Refresh")}
          </button>
        </div>
      </header>

      {loading ? (
        <p className="workboard-status" role="status">
          {t("Loading…")}
        </p>
      ) : null}

      {loadError ? (
        <p className="error-banner" role="alert" data-testid="plans-load-error">
          {t("The temporary plans could not be loaded.")} {loadError}
        </p>
      ) : null}

      {!loading && result?.state === "failed" ? (
        <p className="error-banner" role="alert" data-testid="plans-query-failed">
          {result.message}
        </p>
      ) : null}

      {!loading && result?.state === "ok" && issues.length > 0 ? (
        <div className="plans-issues" role="alert" data-testid="plans-issues">
          <h2 className="plans-section__title">{t("Unreadable plan files")}</h2>
          <ul>
            {issues.map((issue) => (
              <li key={`${issue.path}:${issue.message}`}>
                <code>{issue.path}</code> — {issue.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {!loading && result?.state === "ok" && plans.length === 0 && issues.length === 0 ? (
        <p className="plans-empty" data-testid="plans-empty">
          {t(
            "No temporary plans in this project yet. Ask the main conversation to create one; this page stays read-only on purpose.",
          )}
        </p>
      ) : null}

      {!loading && result?.state === "ok" && plans.length > 0 ? (
        <div className="plans-layout">
          <ul className="plans-list" data-testid="plans-list">
            {plans.map((plan) => (
              <li key={plan.planId}>
                <button
                  className={`plans-list__item ${selected?.planId === plan.planId ? "plans-list__item--active" : ""}`}
                  type="button"
                  data-testid={`plan-item-${plan.planId}`}
                  onClick={() => setSelectedPlanId(plan.planId)}
                >
                  <span className="plans-list__name">{plan.displayName}</span>
                  <span className="plans-list__meta">
                    {t("Version {version}", { version: plan.definitionVersion })} ·{" "}
                    {t("{count} steps", { count: plan.steps.length })} ·{" "}
                    {plan.starts.length > 0
                      ? t("{count} starts", { count: plan.starts.length })
                      : t("Not started")}
                  </span>
                  <span className="plans-list__id">{plan.planId}</span>
                  {plan.undone ? (
                    <span className="plans-badge plans-badge--undone">{t("Undone")}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>

          {selected ? (
            <PlanDetail plan={selected} />
          ) : (
            <p className="plans-hint" data-testid="plans-select-hint">
              {t("Pick a plan on the left to read its steps, starts, and feedback.")}
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}

function PlanDetail({ plan }: { readonly plan: TemporaryPlanRow }) {
  const { t } = useI18n();
  const feedbackByStatus = useMemo(() => {
    const known = FEEDBACK_STATUS_ORDER.map((status) => ({
      status,
      rows: plan.feedback.filter((row) => row.status === status),
    }));
    const other = plan.feedback.filter(
      (row) => !FEEDBACK_STATUS_ORDER.includes(row.status as (typeof FEEDBACK_STATUS_ORDER)[number]),
    );
    return { known, other };
  }, [plan.feedback]);

  return (
    <article className="plans-detail" data-testid="plan-detail">
      <h2 className="plans-detail__title" data-testid="plan-detail-name">
        {plan.displayName}
      </h2>
      <dl className="plans-detail__facts">
        <dt>{t("Plan ID")}</dt>
        <dd data-testid="plan-detail-id">{plan.planId}</dd>
        <dt>{t("Definition version")}</dt>
        <dd data-testid="plan-detail-version">{plan.definitionVersion}</dd>
        <dt>{t("Created")}</dt>
        <dd>{plan.createdAt}</dd>
        <dt>{t("Updated")}</dt>
        <dd>{plan.updatedAt}</dd>
        <dt>{t("Source conversation")}</dt>
        <dd>{plan.sourceSessionId ?? t("Unknown")}</dd>
      </dl>
      {plan.undone ? (
        <p className="plans-detail__undone" role="status">
          {t("This plan was undone; its definition stays readable on purpose.")}
        </p>
      ) : null}

      <h3 className="plans-section__title">{t("Steps")}</h3>
      <table className="plans-table" data-testid="plan-steps">
        <thead>
          <tr>
            <th>{t("Step")}</th>
            <th>{t("Title")}</th>
            <th>{t("Department")}</th>
            <th>{t("Depends on")}</th>
            <th>{t("Flags")}</th>
          </tr>
        </thead>
        <tbody>
          {plan.steps.map((step) => (
            <tr key={step.stepId} data-testid={`plan-step-${step.stepId}`}>
              <td>
                <code>{step.stepId}</code>
              </td>
              <td>
                <div>{step.title}</div>
                <div className="plans-table__note">{step.requirement}</div>
                {step.expectedArtifacts ? (
                  <div className="plans-table__note">
                    {t("Expected artifacts")}: {step.expectedArtifacts}
                  </div>
                ) : null}
              </td>
              <td>{step.dept}</td>
              <td>{step.dependsOn.length > 0 ? step.dependsOn.join(", ") : t("None")}</td>
              <td>{stepFlags(step, t)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 className="plans-section__title">{t("Starts")}</h3>
      {plan.starts.length === 0 ? (
        <p className="plans-hint" data-testid="plan-no-starts">
          {t("Not started yet. Starting needs an explicit confirmation in the conversation.")}
        </p>
      ) : (
        <ul className="plans-starts" data-testid="plan-starts">
          {plan.starts.map((start) => (
            <li key={start.startRequestId} data-testid={`plan-start-${start.startRequestId}`}>
              <div className="plans-starts__head">
                <code>{start.instanceId}</code>
                <span className="plans-badge">{start.status}</span>
              </div>
              <dl className="plans-detail__facts">
                <dt>{t("Start request")}</dt>
                <dd>{start.startRequestId}</dd>
                <dt>{t("Recipe")}</dt>
                <dd>{start.recipeName}</dd>
                <dt>{t("Workspace")}</dt>
                <dd>{start.workspace}</dd>
                <dt>{t("Card directory")}</dt>
                <dd>{start.cardDir}</dd>
                <dt>{t("Control file")}</dt>
                <dd>{start.controlPath}</dd>
                <dt>{t("Owner conversation")}</dt>
                <dd>{start.ownerSessionId}</dd>
                <dt>{t("Accepted at")}</dt>
                <dd>{start.acceptedAt}</dd>
              </dl>
            </li>
          ))}
        </ul>
      )}

      <h3 className="plans-section__title">{t("Feedback")}</h3>
      {plan.feedback.length === 0 ? (
        <p className="plans-hint" data-testid="plan-no-feedback">
          {t("No feedback recorded on this plan yet.")}
        </p>
      ) : (
        <div className="plans-feedback" data-testid="plan-feedback">
          {feedbackByStatus.known.map((group) => (
            <div key={group.status} className="plans-feedback__group">
              <h4 className="plans-feedback__status">
                {group.status} ({group.rows.length})
              </h4>
              <FeedbackRows rows={group.rows} />
            </div>
          ))}
          {feedbackByStatus.other.length > 0 ? (
            <div className="plans-feedback__group">
              <h4 className="plans-feedback__status">
                {t("Unknown status")} ({feedbackByStatus.other.length})
              </h4>
              <FeedbackRows rows={feedbackByStatus.other} />
            </div>
          ) : null}
        </div>
      )}
    </article>
  );
}

function FeedbackRows({
  rows,
}: {
  readonly rows: TemporaryPlanRow["feedback"];
}) {
  return (
    <ul>
      {rows.map((row) => (
        <li key={row.feedbackId}>
          <code>{row.target}</code> ({row.targetKind}) — {row.status}
          {row.detail ? <div className="plans-table__note">{row.detail}</div> : null}
        </li>
      ))}
    </ul>
  );
}

function stepFlags(step: TemporaryPlanStepRow, t: (key: string) => string): string {
  const flags: string[] = [];
  if (step.humanGate) flags.push(t("Human gate"));
  if (step.readOnly) flags.push(t("Read only"));
  if (step.audit) flags.push(t("Audit"));
  return flags.length > 0 ? flags.join(" · ") : t("None");
}
