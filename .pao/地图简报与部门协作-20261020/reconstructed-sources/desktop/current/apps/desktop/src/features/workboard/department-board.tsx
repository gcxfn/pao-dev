import { useEffect, useMemo, useState } from "react";
import type { DesktopAppState, WorkspaceSessionTarget } from "../../../contracts/desktop-state";
import type { PiDesktopApi } from "../../../contracts/ipc";
import type { KanbanResult, WorkboardSessionInput } from "../../../contracts/kanban";
import { desktopPathKey } from "../../../contracts/path-identity";
import {
  buildDepartmentGroups,
  ministerSessionInput,
  type DepartmentGroup,
  type DepartmentState,
  type DepartmentWorker,
} from "./department-board-model";
import { ExecutionSessionView } from "./execution-session-view";

const STATE_LABELS: Record<DepartmentState, string> = {
  ready: "准备",
  running: "进行",
  blocked: "阻塞",
  done: "已完成",
  canceled: "已取消",
};
const COLUMNS: readonly DepartmentState[] = ["ready", "running", "blocked", "done"];
const CARD_LABELS: Record<string, string> = {
  unclaimed: "待派发",
  in_progress: "执行中",
  delivered: "已交付",
  failed: "失败",
  canceled: "已取消",
};
const shortPath = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
const taskSummary = (text: string, limit = 64) => {
  const firstLine =
    text
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.trim() ?? "";
  return firstLine.length > limit ? `${firstLine.slice(0, limit)}…` : firstLine;
};

export function DepartmentBoard({
  api,
  snapshot,
  result,
  loading,
  onRefresh,
  onOpenCard,
  onOpenMain,
  onOpenWorkflow,
  focusGroupId,
}: {
  readonly api: PiDesktopApi;
  readonly snapshot: DesktopAppState;
  readonly result: KanbanResult;
  readonly loading: boolean;
  readonly onRefresh: () => void;
  readonly focusGroupId?: string;
  readonly onOpenCard: (path: string) => void;
  readonly onOpenMain: (target: WorkspaceSessionTarget) => void;
  readonly onOpenWorkflow: (target: {
    workspaceId: string;
    instanceId: string;
    nodeName: string;
  }) => Promise<void>;
}) {
  const groups = useMemo(
    () =>
      result.state === "available" ? buildDepartmentGroups(result.cards, result.workflows) : [],
    [result],
  );
  const [selectedId, setSelectedId] = useState<string>();
  const [session, setSession] = useState<{ input: WorkboardSessionInput; title: string }>();
  const [project, setProject] = useState("");
  const [query, setQuery] = useState("");
  const [navigationError, setNavigationError] = useState<string>();
  // 右侧「部门」入口指定看哪个部门；右侧「全部任务」传空，应当退回四列总览，
  // 所以这里跟随 focusGroupId 的每次变化（含清空）同步选中项，不改其他本地交互状态。
  useEffect(() => {
    setSelectedId(focusGroupId);
    setSession(undefined);
  }, [focusGroupId]);
  const selected = groups.find((group) => group.id === selectedId);
  const workspaceOf = (group: DepartmentGroup) =>
    snapshot.workspaces.find(
      (workspace) => desktopPathKey(workspace.path) === desktopPathKey(group.project),
    );
  const titleOf = (group: DepartmentGroup) =>
    workspaceOf(group)?.sessions.find((row) => row.id === group.ownerSessionId)?.title ??
    group.flow?.workflow ??
    "来源主控未载入";
  const openWorker = (group: DepartmentGroup, worker: DepartmentWorker) => {
    const workspace = workspaceOf(group);
    if (!workspace || !worker.executionId) return;
    setSelectedId(group.id);
    setSession({
      input: { kind: "worker", workspaceId: workspace.id, executionId: worker.executionId },
      title: `${group.department} · 工人会话`,
    });
  };
  if (session)
    return (
      <ExecutionSessionView
        api={api}
        input={session.input}
        title={session.title}
        onBack={() => setSession(undefined)}
      />
    );
  if (selectedId && !selected)
    return (
      <section className="department-board">
        <button
          className="department-board__back"
          type="button"
          onClick={() => setSelectedId(undefined)}
        >
          ← 返回看板
        </button>
        <p role="alert">原部门任务已变化或当前读取不可用，请返回看板核对。</p>
      </section>
    );
  const workerButton = (
    group: DepartmentGroup,
    worker: DepartmentWorker,
    index: number,
    full = false,
  ) => (
    <button
      type="button"
      key={worker.id}
      className={full ? "department-board__person" : "department-board__worker"}
      data-testid="department-worker"
      aria-label={`${worker.executionId ? `查看工人 ${index + 1} 会话` : "待派发任务"}：${taskSummary(worker.card.goal)}`}
      disabled={!worker.executionId || !workspaceOf(group)}
      onClick={() => openWorker(group, worker)}
    >
      <span className="department-board__avatar">工</span>
      <span className="department-board__worker-content">
        <span className="department-board__worker-heading">
          <strong>{worker.executionId ? `工人 ${index + 1}` : "待派发任务"}</strong>
          {!full ? <small>{CARD_LABELS[worker.status] ?? "状态未知"}</small> : null}
        </span>
        <span className="department-board__worker-goal" title={worker.card.goal}>
          {full ? worker.card.goal : taskSummary(worker.card.goal, 48)}
        </span>
        {full ? (
          <small>
            {CARD_LABELS[worker.status] ?? "状态未知"}
            {worker.executionId ? " · 查看会话 ↗" : " · 尚无执行会话"}
          </small>
        ) : null}
      </span>
    </button>
  );
  if (selected) {
    const workspace = workspaceOf(selected);
    const minister = workspace ? ministerSessionInput(selected, workspace.id) : undefined;
    const master = workspace?.sessions.find((row) => row.id === selected.ownerSessionId);
    return (
      <section
        className="department-board department-board--detail"
        data-testid="department-detail"
      >
        {navigationError ? (
          <p role="alert" className="error-banner">
            {navigationError}
          </p>
        ) : null}
        <button
          type="button"
          className="department-board__back"
          onClick={() => setSelectedId(undefined)}
        >
          ← 工作看板
        </button>
        <header className="department-board__header">
          <div className="department-board__identity">
            <span className="department-board__avatar department-board__avatar--large">
              {selected.department.slice(0, 1)}
            </span>
            <div>
              <h1>{selected.department}</h1>
              <p>{selected.title}</p>
            </div>
          </div>
          <span className="department-board__state" data-state={selected.state}>
            {STATE_LABELS[selected.state]}
          </span>
        </header>
        <div className="department-board__meta">
          <span>来源主控</span>
          <button
            className="department-board__link"
            type="button"
            disabled={!master || !workspace}
            onClick={() => {
              if (workspace && master)
                onOpenMain({ workspaceId: workspace.id, sessionId: master.id });
            }}
          >
            {shortPath(selected.project)} / {titleOf(selected)}
            {master ? " ↗" : " · 会话不可用"}
          </button>
        </div>
        <div className="department-board__meta">
          <span>当前步骤</span>
          <span>
            {selected.title}
            {selected.node ? ` · 第 ${selected.node.round} 轮` : ""}
          </span>
        </div>
        {selected.reason ? (
          <div className="department-board__alert" data-testid="department-hold">
            {selected.reason}
            {master && workspace ? (
              <button
                type="button"
                className="department-board__link"
                onClick={() => onOpenMain({ workspaceId: workspace.id, sessionId: master.id })}
              >
                到主控处理 ↗
              </button>
            ) : null}
          </div>
        ) : null}
        <section className="department-board__organization">
          <div className="department-board__section-head">
            <h2>部门执行关系</h2>
            <span>{selected.workers.length} 项执行任务</span>
          </div>
          <div className="department-board__minister">
            <button
              type="button"
              className="department-board__person"
              data-testid="department-minister"
              disabled={!minister}
              onClick={() => {
                if (minister)
                  setSession({ input: minister, title: `${selected.department} · 部长会话` });
              }}
            >
              <span className="department-board__avatar">部</span>
              <span className="department-board__worker-content">
                <strong>{selected.department}部长</strong>
                <span>分工、进度协调与交付检查</span>
                <small>{minister ? "查看部长会话 ↗" : "尚无可定位的部长会话"}</small>
              </span>
            </button>
          </div>
          <div className="department-board__stem" />
          <div className="department-board__people">
            {selected.workers.map((worker, index) => (
              <div className="department-board__branch" key={worker.id}>
                {workerButton(selected, worker, index, true)}
              </div>
            ))}
          </div>
          {selected.workers.length === 0 ? (
            <p className="department-board__muted">当前步骤尚未派出工人。</p>
          ) : null}
        </section>
        <section className="department-board__tasks">
          <div className="department-board__section-head">
            <h2>任务与交付记录</h2>
            {selected.flow && selected.node ? (
              <button
                type="button"
                className="department-board__link"
                disabled={!workspace}
                onClick={() => {
                  if (workspace) {
                    setNavigationError(undefined);
                    onOpenWorkflow({
                      workspaceId: workspace.id,
                      instanceId: selected.flow!.instance,
                      nodeName: selected.node!.name,
                    }).catch((cause: unknown) =>
                      setNavigationError(cause instanceof Error ? cause.message : String(cause)),
                    );
                  }
                }}
              >
                查看所属工作流 ↗
              </button>
            ) : null}
          </div>
          {selected.cards.map((card) => (
            <button
              key={card.path}
              type="button"
              className="department-board__task"
              onClick={() => onOpenCard(card.path)}
            >
              <span>
                卡{String(card.number).padStart(4, "0")} · {card.goal}
              </span>
              <small>{CARD_LABELS[card.status]} · 查看要求、回执与成果 ↗</small>
            </button>
          ))}
        </section>
      </section>
    );
  }
  const visible = groups.filter(
    (group) =>
      (!project || desktopPathKey(group.project) === project) &&
      (!query ||
        `${group.department} ${group.title} ${titleOf(group)}`
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase())),
  );
  return (
    <section className="department-board" data-testid="department-board">
      <header className="department-board__header">
        <div>
          <h1>工作看板</h1>
          <p>部门在做什么，工人推进到哪里</p>
        </div>
        <button type="button" className="button" disabled={loading} onClick={onRefresh}>
          刷新
        </button>
      </header>
      <div className="department-board__filters">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索部门或任务"
          aria-label="搜索部门或任务"
        />
        <label>
          项目{" "}
          <select
            aria-label="看板项目"
            value={project}
            onChange={(event) => setProject(event.target.value)}
          >
            <option value="">全部项目</option>
            {[...new Set(groups.map((group) => desktopPathKey(group.project)))].map((path) => (
              <option key={path} value={path}>
                {shortPath(groups.find((group) => desktopPathKey(group.project) === path)!.project)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {loading ? (
        <p role="status" className="department-board__muted">
          正在读取执行状态…
        </p>
      ) : null}
      {result.state === "unavailable" ? (
        <p role="alert" className="error-banner">
          {result.message}
        </p>
      ) : null}
      <div className="department-board__columns">
        {COLUMNS.map((column) => (
          <section
            className="department-board__column"
            data-state={column}
            key={column}
            aria-label={`${STATE_LABELS[column]}列`}
          >
            <h2>
              <span className="department-board__dot" data-state={column} />
              {STATE_LABELS[column]}
              <small>{visible.filter((group) => group.state === column).length}</small>
            </h2>
            {visible
              .filter((group) => group.state === column)
              .map((group) => (
                <div className="department-board__group" key={group.id}>
                  <button
                    type="button"
                    className="department-board__department"
                    data-testid="department-card"
                    data-department={group.department}
                    onClick={() => setSelectedId(group.id)}
                  >
                    <span className="department-board__department-head">
                      <span className="department-board__avatar">
                        {group.department.slice(0, 1)}
                      </span>
                      <strong>{group.department}</strong>
                      <span aria-hidden="true">↗</span>
                    </span>
                    <span
                      className="department-board__context"
                      title={`${shortPath(group.project)} · ${titleOf(group)}`}
                    >
                      {shortPath(group.project)} · {titleOf(group)}
                    </span>
                    <span className="department-board__goal" title={group.title}>
                      {taskSummary(group.title)}
                    </span>
                    <span className="department-board__department-meta">
                      {group.workers.length} 项执行
                      {group.node ? ` · 第 ${group.node.round} 轮` : ""}
                    </span>
                    {group.reason && group.state === "blocked" ? (
                      <span className="department-board__reason" title={group.reason}>
                        {taskSummary(group.reason, 36)}
                      </span>
                    ) : null}
                  </button>
                  {group.workers.length > 0 ? (
                    <div className="department-board__workers">
                      {group.workers
                        .slice(0, 3)
                        .map((worker, index) => workerButton(group, worker, index))}
                      {group.workers.length > 3 ? (
                        <button
                          type="button"
                          className="department-board__more"
                          onClick={() => setSelectedId(group.id)}
                        >
                          查看其余 {group.workers.length - 3} 项执行 →
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ))}
            {!visible.some((group) => group.state === column) ? (
              <p className="department-board__empty">暂无任务</p>
            ) : null}
          </section>
        ))}
      </div>
      {visible.some((group) => group.state === "canceled") ? (
        <details className="department-board__issues">
          <summary>
            已取消的任务（{visible.filter((group) => group.state === "canceled").length}）
          </summary>
          {visible
            .filter((group) => group.state === "canceled")
            .map((group) => (
              <button
                type="button"
                className="department-board__task"
                key={group.id}
                onClick={() => setSelectedId(group.id)}
              >
                {group.department} · {group.title} · 已取消
              </button>
            ))}
        </details>
      ) : null}
      {result.state === "available" && result.issues.length > 0 ? (
        <details open className="department-board__issues">
          <summary>读取问题（{result.issues.length}）</summary>
          {result.issues.map((issue, index) => (
            <p role="alert" key={index}>
              {issue.path}：{issue.message}
            </p>
          ))}
        </details>
      ) : null}
    </section>
  );
}
