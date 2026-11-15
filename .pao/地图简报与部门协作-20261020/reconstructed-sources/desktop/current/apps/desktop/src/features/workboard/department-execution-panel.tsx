import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesktopAppState } from "../../../contracts/desktop-state";
import type { PiDesktopApi } from "../../../contracts/ipc";
import type { KanbanResult, WorkboardSessionInput } from "../../../contracts/kanban";
import { useViewAutoRefresh } from "../../ui/view-auto-refresh";
import { currentDepartmentGroups } from "../task-status/task-status-model";
import type { DepartmentGroup, DepartmentState, DepartmentWorker } from "./department-board-model";
import { ministerSessionInput } from "./department-board-model";
import { ExecutionSessionView } from "./execution-session-view";

const STATE_LABELS: Record<DepartmentState, string> = {
  ready: "准备中",
  running: "进行中",
  blocked: "需要处理",
  done: "已完成",
  canceled: "已取消",
};

const CARD_STATUS_LABELS: Record<string, string> = {
  unclaimed: "待认领",
  in_progress: "执行中",
  delivered: "已交付",
  failed: "失败",
  canceled: "已取消",
};

type ActiveSession = {
  readonly input: WorkboardSessionInput;
  readonly title: string;
};

type PanelIdentity = {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly groupId: string;
};

type BoundActiveSession = ActiveSession & {
  readonly panelIdentity: PanelIdentity;
};

type PanelState =
  | { readonly phase: "loading" }
  | {
      readonly phase: "ready";
      readonly result: Extract<KanbanResult, { state: "available" }>;
      readonly readAt: string;
    }
  | { readonly phase: "failed"; readonly message: string };

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * 从一次完整看板快照中定位当前主控的执行组。
 * groupId 只负责精确选中；项目与 owner 仍分别复核，避免另一主控的回调串入。
 */
export function selectCurrentDepartmentGroup(
  result: KanbanResult,
  workspacePath: string,
  ownerSessionId: string,
  groupId: string,
): DepartmentGroup | undefined {
  if (result.state !== "available") return undefined;
  return currentDepartmentGroups(result, workspacePath, ownerSessionId).find(
    (group) => group.id === groupId,
  );
}

/** 同一执行组可能含多张卡；回执必须按原卡路径取，不能拿组内第一张替代。 */
function cardForWorker(group: DepartmentGroup, worker: DepartmentWorker) {
  return group.cards.find((card) => card.path === worker.card.path) ?? worker.card;
}

const textField = (record: Readonly<Record<string, unknown>>, keys: readonly string[]) => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return undefined;
};

const listField = (record: Readonly<Record<string, unknown>>, keys: readonly string[]) => {
  for (const key of keys) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    return value
      .filter(
        (item): item is string | number | boolean =>
          typeof item === "string" || typeof item === "number" || typeof item === "boolean",
      )
      .map(String)
      .filter((item) => item.trim());
  }
  return [];
};

type DeliveryRecord = {
  readonly cardNumber?: string;
  readonly attempt?: string;
  readonly time?: string;
  readonly result?: string;
  readonly failureType?: string;
  readonly summary?: string;
  readonly status?: string;
  readonly worthDistilling?: string;
  readonly archiveFlag?: string;
  readonly artifacts: readonly string[];
  readonly evidence: readonly string[];
  readonly raw: Readonly<Record<string, unknown>>;
};

const RECEIPT_VALUE_LABELS: Readonly<Record<string, string>> = {
  delivered: "已交付",
  complete: "已完成",
  completed: "已完成",
  success: "成功",
  failed: "失败",
  failure: "失败",
  blocked: "受阻",
  pending: "待处理",
  in_progress: "进行中",
  canceled: "已取消",
  cancelled: "已取消",
  partial: "部分完成",
};

const receiptValue = (value: string | undefined) =>
  value ? (RECEIPT_VALUE_LABELS[value.toLowerCase()] ?? value) : undefined;

export function deliveryRecords(card: DepartmentWorker["card"]): DeliveryRecord[] {
  return card.receipts.map((receipt) => ({
    cardNumber: textField(receipt, ["card_no", "卡号"]),
    attempt: textField(receipt, ["attempt", "尝试号", "尝试"]),
    time: textField(receipt, ["time", "时间"]),
    result: receiptValue(textField(receipt, ["result", "结果"])),
    failureType: textField(receipt, ["failure_type", "失败类型"]),
    summary: textField(receipt, ["summary", "摘要"]),
    status: receiptValue(textField(receipt, ["status", "状态"])),
    worthDistilling: textField(receipt, ["worth_distilling", "值得沉淀"]),
    archiveFlag: textField(receipt, ["archive_flag", "归档标记"]),
    artifacts: listField(receipt, ["artifact_path", "artifacts", "产物路径", "产物"]),
    evidence: listField(receipt, ["evidence", "证据"]),
    raw: receipt,
  }));
}

export function DeliveryContent({ card }: { readonly card: DepartmentWorker["card"] }) {
  const receipts = deliveryRecords(card);
  if (receipts.length === 0)
    return <p className="department-execution__notice">尚未看到交付回执。</p>;
  return (
    <ol className="department-execution__delivery-list">
      {receipts.map((receipt, index) => {
        const heading = [
          receipt.cardNumber ? `卡 ${receipt.cardNumber}` : undefined,
          receipt.attempt ? `第 ${receipt.attempt} 次` : "轮次未记录",
          receipt.status ? `状态：${receipt.status}` : undefined,
          receipt.result ? `结果：${receipt.result}` : undefined,
          receipt.time,
        ].filter(Boolean);
        const hasReadableDetail = Boolean(
          receipt.status ||
          receipt.result ||
          receipt.failureType ||
          receipt.summary ||
          receipt.worthDistilling ||
          receipt.archiveFlag ||
          receipt.artifacts.length ||
          receipt.evidence.length,
        );
        return (
          <li key={`${receipt.attempt ?? "unknown"}:${index}`}>
            <strong>{heading.join(" · ")}</strong>
            {receipt.summary ? <p>摘要：{receipt.summary}</p> : null}
            {receipt.failureType ? <p>失败类型：{receipt.failureType}</p> : null}
            {receipt.worthDistilling ? <p>值得沉淀：{receipt.worthDistilling}</p> : null}
            {receipt.archiveFlag ? <p>归档标记：{receipt.archiveFlag}</p> : null}
            {receipt.artifacts.length > 0 ? (
              <details>
                <summary>交付产物（{receipt.artifacts.length}）</summary>
                <ul>
                  {receipt.artifacts.map((artifact) => (
                    <li key={artifact}>{artifact}</li>
                  ))}
                </ul>
              </details>
            ) : null}
            {receipt.evidence.length > 0 ? (
              <details>
                <summary>交付证据（{receipt.evidence.length}）</summary>
                <ul>
                  {receipt.evidence.map((evidence) => (
                    <li key={evidence}>{evidence}</li>
                  ))}
                </ul>
              </details>
            ) : null}
            {!hasReadableDetail ? (
              <p className="department-execution__notice">
                回执里有记录，但没有可提取的摘要、状态、产物或证据；请展开原始回执核对。
              </p>
            ) : null}
            <details>
              <summary>原始回执</summary>
              <pre>{JSON.stringify(receipt.raw, null, 2)}</pre>
            </details>
          </li>
        );
      })}
    </ol>
  );
}

function ExecutionContent({ card }: { readonly card: DepartmentWorker["card"] }) {
  if (card.executions.length === 0)
    return <p className="department-execution__notice">任务卡没有执行明细。</p>;
  return (
    <ol className="department-execution__delivery-list">
      {card.executions.map((execution, index) => {
        const status = textField(execution, ["状态", "status"]);
        const current = execution["当前尝试"] ?? execution["current"];
        return (
          <li key={`${textField(execution, ["执行标识", "executionId"]) ?? index}:${index}`}>
            <strong>
              {textField(execution, ["执行标识", "executionId"]) ?? "执行标识未记录"}
              {current === true ? " · 当前尝试" : current === false ? " · 历史尝试" : ""}
            </strong>
            <p>状态：{status ?? "未记录"}</p>
            <details>
              <summary>原始执行记录</summary>
              <pre>{JSON.stringify(execution, null, 2)}</pre>
            </details>
          </li>
        );
      })}
    </ol>
  );
}

function workerLabel(worker: DepartmentWorker): string {
  return worker.executionId ? "工人执行会话" : "尚无工人执行会话";
}

function groupExpression(group: DepartmentGroup): string {
  if (!group.flow) return "独立部门任务 · 无工作流实例";
  return `${group.flow.workflow} · 实例 ${group.flow.instance} · ${
    group.node ? `第 ${group.node.round} 轮` : "轮次未记录"
  }`;
}

function panelFacts(snapshot: DesktopAppState, workspaceId: string, sessionId: string) {
  const workspace = snapshot.workspaces.find((row) => row.id === workspaceId);
  const session = workspace?.sessions.find((row) => row.id === sessionId);
  return { workspace, session };
}

const samePanelIdentity = (left: PanelIdentity, right: PanelIdentity) =>
  left.workspaceId === right.workspaceId &&
  left.sessionId === right.sessionId &&
  left.groupId === right.groupId;

/** 渲染前拒绝过期会话，避免身份切换后的第一帧仍显示旧执行记录。 */
export function activeSessionForPanel(
  activeSession: BoundActiveSession | undefined,
  panelIdentity: PanelIdentity,
): ActiveSession | undefined {
  return activeSession && samePanelIdentity(activeSession.panelIdentity, panelIdentity)
    ? activeSession
    : undefined;
}

type IdentityState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly snapshot: DesktopAppState }
  | { readonly phase: "failed"; readonly message: string };

/** 会话身份必须随工作区和来源会话一起切换，旧身份不能借同一工作区串到下一次选中。 */
export function identityForDepartment(
  state: IdentityState,
  workspaceId: string,
  sessionId: string,
) {
  if (state.phase !== "ready") return { state, workspace: undefined, session: undefined };
  const facts = panelFacts(state.snapshot, workspaceId, sessionId);
  return { state, ...facts };
}

function useDepartmentPanelData(api: PiDesktopApi, workspaceId: string, sessionId: string) {
  const [state, setState] = useState<PanelState>({ phase: "loading" });
  const requestId = useRef(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string>();

  const refresh = useCallback(
    (silent = false) => {
      const id = ++requestId.current;
      setRefreshing(true);
      setRefreshError(undefined);
      if (!silent) setState({ phase: "loading" });
      api
        .getKanban(workspaceId)
        .then((result) => {
          if (requestId.current !== id) return;
          if (result.state === "unavailable" && silent) {
            setState((previous) => {
              if (previous.phase === "ready") setRefreshError(result.message);
              return previous.phase === "ready"
                ? previous
                : { phase: "failed", message: result.message };
            });
            return;
          }
          setState((previous) => {
            if (result.state === "unavailable") {
              return { phase: "failed", message: result.message };
            }
            return {
              phase: "ready",
              result,
              readAt: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
            };
          });
        })
        .catch((cause: unknown) => {
          if (requestId.current !== id) return;
          setState((previous) => {
            if (previous.phase === "ready" && silent) {
              setRefreshError(errorText(cause));
              return previous;
            }
            return { phase: "failed", message: errorText(cause) };
          });
        })
        .finally(() => {
          if (requestId.current === id) setRefreshing(false);
        });
    },
    [api, workspaceId],
  );

  useEffect(() => {
    setState({ phase: "loading" });
    refresh(false);
    return () => {
      requestId.current++;
    };
  }, [refresh, sessionId]);
  useViewAutoRefresh(useCallback(() => refresh(true), [refresh]));

  return { state, refreshing, refresh, refreshError };
}

function SessionStateMessage({
  group,
  workspaceId,
  onOpenSession,
}: {
  readonly group: DepartmentGroup;
  readonly workspaceId: string;
  readonly onOpenSession: (session: ActiveSession) => void;
}) {
  const hasWorker = group.workers.some((worker) => worker.executionId);
  const minister = ministerSessionInput(group, workspaceId);
  return (
    <section className="department-execution__section" aria-labelledby="department-session-title">
      <div className="department-execution__section-head">
        <div>
          <h2 id="department-session-title">执行会话</h2>
          <p>只读记录；需要调整、重试或审批时请回来源主对话。</p>
        </div>
        <span>{hasWorker ? "可查看工人记录" : "未发现工人记录"}</span>
      </div>
      <div className="department-execution__sessions">
        <button
          type="button"
          className="department-execution__session-link"
          disabled={!minister}
          onClick={() => {
            if (minister)
              onOpenSession({ input: minister, title: `${group.department} · 部长会话` });
          }}
        >
          <span>
            <strong>部长会话</strong>
            <small>{minister ? "分工、进度与交付核对记录" : "没有可定位的部长会话"}</small>
          </span>
          <span>{minister ? "查看会话 ↗" : "没有会话"}</span>
        </button>
      </div>
      {!hasWorker ? (
        <p className="department-execution__notice" role="status">
          当前轮次没有可定位的工人执行会话，可能是尚未派发、记录已清理或旧数据缺少执行标识。
          请回来源主对话核对派发与读取情况。
        </p>
      ) : null}
      <div className="department-execution__sessions">
        {group.workers.map((worker, index) => (
          <button
            type="button"
            key={worker.id}
            className="department-execution__session-link"
            disabled={!worker.executionId}
            onClick={() => {
              if (!worker.executionId) return;
              onOpenSession({
                input: {
                  kind: "worker",
                  workspaceId,
                  executionId: worker.executionId,
                },
                title: `工人 ${index + 1} · ${worker.card.goal}`,
              });
            }}
          >
            <span>
              <strong>工人 {index + 1}</strong>
              <small>{workerLabel(worker)}</small>
            </span>
            <span>{worker.executionId ? "查看会话 ↗" : "没有会话"}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function DepartmentExecutionPanel({
  api,
  workspaceId,
  sessionId,
  groupId,
}: {
  readonly api: PiDesktopApi;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly groupId: string;
}) {
  const [identity, setIdentity] = useState<IdentityState>({ phase: "loading" });
  const [activeSession, setActiveSession] = useState<BoundActiveSession>();
  const panelIdentity: PanelIdentity = { workspaceId, sessionId, groupId };
  const { state, refreshing, refresh, refreshError } = useDepartmentPanelData(
    api,
    workspaceId,
    sessionId,
  );
  const requestId = useRef(0);

  const readIdentity = useCallback(() => {
    const id = ++requestId.current;
    setIdentity({ phase: "loading" });
    api
      .getState()
      .then((value) => {
        if (requestId.current === id) setIdentity({ phase: "ready", snapshot: value });
      })
      .catch((cause: unknown) => {
        if (requestId.current === id) setIdentity({ phase: "failed", message: errorText(cause) });
      });
  }, [api]);

  useEffect(() => {
    readIdentity();
    return () => {
      requestId.current++;
    };
  }, [readIdentity, sessionId, workspaceId]);

  useEffect(() => {
    setActiveSession((current) =>
      current &&
      current.panelIdentity.workspaceId === workspaceId &&
      current.panelIdentity.sessionId === sessionId &&
      current.panelIdentity.groupId === groupId
        ? current
        : undefined,
    );
  }, [groupId, sessionId, workspaceId]);

  const { workspace, session } = identityForDepartment(identity, workspaceId, sessionId);
  const group = useMemo(() => {
    if (!workspace || state.phase !== "ready") return undefined;
    return selectCurrentDepartmentGroup(state.result, workspace.path, sessionId, groupId);
  }, [groupId, sessionId, state, workspace]);

  const visibleActiveSession = activeSessionForPanel(activeSession, panelIdentity);
  if (visibleActiveSession) {
    return (
      <div className="department-execution">
        <ExecutionSessionView
          api={api}
          input={visibleActiveSession.input}
          title={visibleActiveSession.title}
          onBack={() => setActiveSession(undefined)}
        />
      </div>
    );
  }

  return (
    <section
      className="department-execution"
      data-testid="department-execution-panel"
      aria-label="部门执行详情"
    >
      <header className="department-execution__header">
        <div>
          <p className="department-execution__eyebrow">工作流部门 · 只读详情</p>
          <h1>{group?.department ?? "部门执行详情"}</h1>
          <p title={session?.title}>
            来源主对话：
            {session?.title ??
              (identity.phase === "loading"
                ? "正在读取…"
                : identity.phase === "failed"
                  ? "无法读取"
                  : "来源会话不存在")}
          </p>
        </div>
        <button
          type="button"
          className="button department-execution__refresh"
          disabled={refreshing}
          onClick={() => {
            refresh();
            readIdentity();
          }}
        >
          {refreshing ? "正在刷新…" : "刷新"}
        </button>
      </header>

      {identity.phase === "failed" ? (
        <p className="department-execution__error" role="alert">
          无法读取会话身份：{identity.message}
        </p>
      ) : null}
      {refreshError ? (
        <p className="department-execution__notice" data-state="blocked" role="status">
          自动刷新失败，仍显示上一份读取记录：{refreshError}
        </p>
      ) : null}
      {state.phase === "loading" ? (
        <p className="department-execution__loading" role="status">
          正在读取项目、主控与部门执行记录…
        </p>
      ) : null}
      {state.phase === "failed" ? (
        <div className="department-execution__error" role="alert">
          <strong>部门执行记录读取失败。</strong>
          <p>{state.message}</p>
          <button type="button" className="button" onClick={() => refresh()}>
            重新读取
          </button>
        </div>
      ) : null}
      {state.phase === "ready" && identity.phase === "loading" ? (
        <p className="department-execution__loading" role="status">
          正在确认来源项目与主控身份…
        </p>
      ) : null}
      {state.phase === "ready" && identity.phase === "ready" && !workspace ? (
        <p className="department-execution__error" role="alert">
          当前工作区已经关闭或不在应用状态中，无法确认部门归属。请回来源主对话确认工作目录。
        </p>
      ) : null}
      {state.phase === "ready" && workspace && identity.phase === "ready" && !session ? (
        <p className="department-execution__error" role="alert">
          来源主控会话不在当前应用状态中，无法确认这张部门卡属于它。请从来源主对话重新打开。
        </p>
      ) : null}
      {state.phase === "ready" && workspace && session && !group ? (
        <div className="department-execution__notice" role="status">
          <p>
            未找到与当前项目、来源主控、工作流实例和轮次同时匹配的部门。
            快照可能已经更新，或原部门任务已被移除。
          </p>
          <button type="button" className="button" onClick={() => refresh()}>
            重新匹配
          </button>
        </div>
      ) : null}

      {workspace && group && state.phase === "ready" ? (
        <>
          <div className="department-execution__identity">
            <div>
              <span>项目</span>
              <strong title={group.project}>{group.project}</strong>
            </div>
            <div>
              <span>当前步骤</span>
              <strong>{group.title}</strong>
            </div>
            <div>
              <span>执行关系</span>
              <strong>{groupExpression(group)}</strong>
            </div>
            <div>
              <span>部门状态</span>
              <strong data-state={group.state}>{STATE_LABELS[group.state]}</strong>
            </div>
          </div>

          <p className="department-execution__read-at">
            任务卡最近读取：{state.readAt} · 只展示当前来源主控关联的执行组
          </p>

          {group.reason ? (
            <div className="department-execution__notice" data-state={group.state}>
              <strong>当前状态说明</strong>
              <p>{group.reason}</p>
            </div>
          ) : null}

          <section
            className="department-execution__section"
            aria-labelledby="department-task-title"
          >
            <div className="department-execution__section-head">
              <div>
                <h2 id="department-task-title">任务与真实工人状态</h2>
                <p>状态来自当前看板快照，不根据时间推断是否仍在运行。</p>
              </div>
              <span>{group.workers.length} 项执行任务</span>
            </div>
            <div className="department-execution__workers">
              {group.workers.map((worker, index) => (
                <article className="department-execution__worker" key={worker.id}>
                  <header>
                    <div>
                      <strong>工人 {index + 1}</strong>
                      <span data-status={worker.status}>
                        {CARD_STATUS_LABELS[worker.status] ?? `状态未知：${worker.status}`}
                      </span>
                    </div>
                    <small>{worker.executionId ?? "没有执行标识"}</small>
                  </header>
                  <p>{worker.card.goal}</p>
                  <div className="department-execution__meta">
                    <span>验收：{worker.card.acceptance.trim() || "任务卡未记录验收标准"}</span>
                    <span>尝试：{worker.card.attempts > 0 ? worker.card.attempts : "未记录"}</span>
                  </div>
                  <details>
                    <summary>查看交付回执</summary>
                    <DeliveryContent card={cardForWorker(group, worker)} />
                  </details>
                  <details>
                    <summary>查看真实执行记录</summary>
                    <ExecutionContent card={worker.card} />
                  </details>
                </article>
              ))}
              {group.workers.length === 0 ? (
                <p className="department-execution__notice">
                  当前轮次尚未派出工人；任务卡或执行身份缺失时不会推测为“运行中”。
                </p>
              ) : null}
            </div>
          </section>

          <section
            className="department-execution__section"
            aria-labelledby="department-cards-title"
          >
            <div className="department-execution__section-head">
              <div>
                <h2 id="department-cards-title">部门任务卡</h2>
                <p>只读展示任务与回执；所有调整意图请回来源主对话处理。</p>
              </div>
            </div>
            {group.cards.length > 0 ? (
              <div className="department-execution__cards">
                {group.cards.map((card) => (
                  <details key={card.path} className="department-execution__card">
                    <summary>
                      <span>
                        <strong>
                          卡{String(card.number).padStart(4, "0")} · {card.goal}
                        </strong>
                        <small>{CARD_STATUS_LABELS[card.status] ?? card.status}</small>
                      </span>
                    </summary>
                    <div className="department-execution__card-body">
                      <h3>任务要求</h3>
                      <p>{card.body.trim() || card.goal}</p>
                      <h3>验收标准</h3>
                      <p>{card.acceptance.trim() || "任务卡未记录验收标准。"}</p>
                      {card.constraints?.trim() ? (
                        <>
                          <h3>约束</h3>
                          <p>{card.constraints}</p>
                        </>
                      ) : null}
                      <h3>交付回执</h3>
                      <DeliveryContent card={card} />
                      <h3>执行记录</h3>
                      <ExecutionContent card={card} />
                    </div>
                  </details>
                ))}
              </div>
            ) : (
              <p className="department-execution__notice">
                当前轮次没有可读取的任务卡。请回来源主对话确认卡片目录或读取问题。
              </p>
            )}
          </section>

          <SessionStateMessage
            group={group}
            workspaceId={workspaceId}
            onOpenSession={(session) => setActiveSession({ ...session, panelIdentity })}
          />

          <footer className="department-execution__footer">
            <p>
              {group.flow
                ? `所属工作流：${group.flow.workflow} · ${group.flow.instance}`
                : "该部门来自独立任务卡，没有工作流实例记录。"}
            </p>
            <p>需要调整、重试、取消或审批时，请回来源主对话说明意图。</p>
          </footer>
        </>
      ) : null}
    </section>
  );
}
