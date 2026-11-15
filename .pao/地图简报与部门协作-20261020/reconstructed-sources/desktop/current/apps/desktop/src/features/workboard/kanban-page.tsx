import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { desktopPathKey as pathKey } from "../../../contracts/path-identity";
import type { KanbanCard, KanbanResult } from "../../../contracts/kanban";
import type { PiDesktopApi } from "../../../contracts/ipc";
import { KanbanBoard } from "./kanban-board";
import { WorkboardPage } from "./workboard-page";
import { useViewAutoRefresh } from "../../ui/view-auto-refresh";
import type { DesktopAppState, WorkspaceSessionTarget } from "../../../contracts/desktop-state";
import { DepartmentBoard } from "./department-board";

/** 工作区身份由 App 传入，服务端现读卡，不保存第二份卡状态。 */
export function KanbanPage({
  api,
  workspaceId,
  snapshot,
  onOpenMain,
  onOpenWorkflow,
  focusGroupId,
}: {
  readonly api: PiDesktopApi;
  readonly focusGroupId?: string;
  readonly workspaceId?: string;
  readonly snapshot: DesktopAppState;
  readonly onOpenMain: (target: WorkspaceSessionTarget) => void;
  readonly onOpenWorkflow: (target: {
    workspaceId: string;
    instanceId: string;
    nodeName: string;
  }) => Promise<void>;
}) {
  const [result, setResult] = useState<KanbanResult>({
    state: "unavailable",
    message: "正在读取卡片…",
  });
  // 首帧就是加载中：loading 独立承载「正在读取」，不再让 role=alert 横幅兼演首帧态。
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [readAt, setReadAt] = useState<string>();
  const [view, setView] = useState<"departments" | "cards" | "overview">("departments");
  useEffect(() => {
    if (focusGroupId) setView("departments");
  }, [focusGroupId]);
  // 选中卡提升到本页：部门与待处理入口的「打开卡详情」与列区点卡共用同一份详情。
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const requestId = useRef(0);
  const runRefresh = useCallback(
    (silent: boolean) => {
      const currentRequest = ++requestId.current;
      if (!workspaceId) {
        setResult({ state: "unavailable", message: "请先选择项目。" });
        setLoading(false);
        return;
      }
      if (!silent) setLoading(true);
      void api
        .getKanban(workspaceId)
        .then((value) => {
          if (requestId.current !== currentRequest) return;
          if (value.state === "unavailable") {
            setLoadError(value.message);
            setResult((previous) => (previous.state === "available" ? previous : value));
          } else {
            setResult(value);
            setLoadError(undefined);
            setReadAt(new Date().toLocaleTimeString());
          }
        })
        .catch(
          (error: unknown) =>
            requestId.current === currentRequest &&
            setLoadError(error instanceof Error ? error.message : String(error)),
        )
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
    setResult({ state: "unavailable", message: "正在读取卡片…" });
    setSelectedPath(null);
    setLoadError(undefined);
    setReadAt(undefined);
    refresh();
    return () => {
      requestId.current++;
    };
  }, [refresh]);

  /** 路径导航：复用既有 revealWorkspaceFile 通道，主进程做存在性＋越界复核，不加新 IPC。 */
  const revealPath = useCallback(
    (path: string): Promise<void> => {
      if (!workspaceId) return Promise.reject(new Error("请先选择项目。"));
      return api.revealWorkspaceFile(workspaceId, path);
    },
    [api, workspaceId],
  );

  /** 部门与待处理入口 → 真实卡详情：只在卡已读到时提供入口，切回任务卡视图并选中。
   *  归一键 → 卡原路径反查（P2-1）：证据路径与卡路径分隔符/大小写可能不一致，
   *  选中必须映射回看板手里的原路径，否则点击后详情静默不开。 */
  const cardPathByKey = useMemo(() => {
    const keys = new Map<string, string>();
    if (result.state === "available") {
      for (const card of result.cards) keys.set(pathKey(card.path), card.path);
    }
    return keys;
  }, [result]);

  /** 卡操作桥（S7-B）：只提交 workspace＋意图；卡路径复核与内核判权都在主进程。 */
  const runCardOp = useCallback(
    (card: KanbanCard) => {
      if (!workspaceId) {
        return Promise.resolve({ ok: false as const, message: "请先选择项目。" });
      }
      return api.kanbanCardOp({
        workspaceId,
        cardPath: card.path,
        cardNumber: card.number,
        action: "取消",
      });
    },
    [api, workspaceId],
  );

  return (
    <div className="workboard-shell">
      <nav className="workboard-view-switch" aria-label="看板视图">
        <button
          type="button"
          className="button"
          aria-pressed={view === "departments"}
          onClick={() => setView("departments")}
        >
          部门与工人
        </button>
        <button
          type="button"
          className="button"
          aria-pressed={view === "cards"}
          onClick={() => setView("cards")}
        >
          原始任务卡
        </button>
        <button
          type="button"
          className="button"
          aria-pressed={view === "overview"}
          onClick={() => setView("overview")}
        >
          部门与待处理
        </button>
      </nav>
      <div className="view-read-status">
        {readAt ? <span>任务卡最近读取：{readAt} · 打开期间每 30 秒刷新</span> : null}
        {loadError ? (
          <p role="alert">
            读取失败：{loadError}。已有内容可能过期。
            <button type="button" className="button" onClick={refresh}>
              重试
            </button>
          </p>
        ) : null}
      </div>
      <div hidden={view !== "departments"} className="department-board-host">
        <DepartmentBoard
          key={workspaceId}
          api={api}
          snapshot={snapshot}
          result={result}
          loading={loading}
          onRefresh={refresh}
          onOpenCard={(path) => {
            setSelectedPath(path);
            setView("cards");
          }}
          onOpenMain={onOpenMain}
          onOpenWorkflow={onOpenWorkflow}
          focusGroupId={focusGroupId}
        />
      </div>
      {view === "cards" ? (
        <KanbanBoard
          key={workspaceId}
          result={result}
          loading={loading}
          onRefresh={refresh}
          selectedPath={selectedPath}
          onSelectPath={setSelectedPath}
          onOpenPath={revealPath}
          onCardOp={runCardOp}
        />
      ) : view === "overview" ? (
        <WorkboardPage
          api={api}
          cardPathByKey={cardPathByKey}
          onOpenCard={(path) => {
            setSelectedPath(path);
            setView("cards");
          }}
        />
      ) : null}
    </div>
  );
}
