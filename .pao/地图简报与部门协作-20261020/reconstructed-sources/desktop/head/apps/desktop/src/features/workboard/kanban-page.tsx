import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KanbanCard, KanbanResult } from "../../../contracts/kanban";
import type { PiDesktopApi } from "../../../contracts/ipc";
import { KanbanBoard } from "./kanban-board";
import { WorkboardPage } from "./workboard-page";

/** 工作区身份由 App 传入，服务端现读卡，不保存第二份卡状态。 */
export function KanbanPage({
  api,
  workspaceId,
}: {
  readonly api: PiDesktopApi;
  readonly workspaceId?: string;
}) {
  const [result, setResult] = useState<KanbanResult>({
    state: "unavailable",
    message: "正在读取卡片…",
  });
  // 首帧就是加载中：loading 独立承载「正在读取」，不再让 role=alert 横幅兼演首帧态。
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"cards" | "overview">("cards");
  // 选中卡提升到本页：部门与待处理入口的「打开卡详情」与列区点卡共用同一份详情。
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const requestId = useRef(0);
  const refresh = useCallback(() => {
    const currentRequest = ++requestId.current;
    if (!workspaceId) {
      setResult({ state: "unavailable", message: "请先选择项目。" });
      setLoading(false);
      return;
    }
    setLoading(true);
    void api
      .getKanban(workspaceId)
      .then((value) => {
        if (requestId.current === currentRequest) setResult(value);
      })
      .catch(
        (error: unknown) =>
          requestId.current === currentRequest &&
          setResult({
            state: "unavailable",
            message: error instanceof Error ? error.message : String(error),
          }),
      )
      .finally(() => {
        if (requestId.current === currentRequest) setLoading(false);
      });
  }, [api, workspaceId]);
  useEffect(() => {
    setResult({ state: "unavailable", message: "正在读取卡片…" });
    setSelectedPath(null);
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
          aria-pressed={view === "cards"}
          onClick={() => setView("cards")}
        >
          任务卡
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
      ) : (
        <WorkboardPage
          api={api}
          cardPathByKey={cardPathByKey}
          onOpenCard={(path) => {
            setSelectedPath(path);
            setView("cards");
          }}
        />
      )}
    </div>
  );
}

/**
 * 路径匹配键：分隔符归一＋大小写不敏感（Windows 下两源路径格式不保证一致）。
 * 内核 pathKey（./pao 已导出，require 面已补）只折叠大小写，语义不同（此处多折分隔符）；
 * 且渲染层无 node:path、不能引内核包进渲染 bundle——双卡维持纯字符串实现
 * （S11-导出面微批复核；electron 侧同因单测车道撞内核兄弟包缺 require 出口，组合收编
 * 实测红已回退，两处本地实现维持）。
 */
function pathKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}
