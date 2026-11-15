import {
  getSelectedWorkspace,
  type DesktopAppState,
  type WorkspaceSessionTarget,
} from "../../../contracts/desktop-state";
import type { PiDesktopApi } from "../../../contracts/ipc";
import type { ReactNode } from "react";
import { CanvasPage } from "./canvas-page";

/** 工作流与桌面会话的接线；创建自己的主控，保持画布页面。 */
export function CanvasSurface({
  api,
  snapshot,
  onSnapshot,
  onSelectSession,
  embeddedChat,
  chatTarget,
  workflowEntryNonce,
}: {
  readonly api: PiDesktopApi;
  readonly snapshot: DesktopAppState;
  readonly onSnapshot: (snapshot: DesktopAppState) => void;
  readonly onSelectSession: (target: WorkspaceSessionTarget) => void;
  readonly embeddedChat?: ReactNode;
  readonly chatTarget?: WorkspaceSessionTarget;
  /** sidebar 工作流入口信号（S4-2），透传给画布页做绑定分流。 */
  readonly workflowEntryNonce?: number;
}) {
  const workspace = getSelectedWorkspace(snapshot);
  return (
    <CanvasPage
      api={api}
      project={workspace?.path}
      workspaceId={workspace?.id}
      workflowTabs={snapshot.workflowTabs}
      activeWorkflowTabId={snapshot.activeWorkflowTabId}
      embeddedChat={embeddedChat}
      chatTarget={
        chatTarget ??
        (snapshot.selectedWorkspaceId && snapshot.selectedSessionId
          ? { workspaceId: snapshot.selectedWorkspaceId, sessionId: snapshot.selectedSessionId }
          : undefined)
      }
      workflowEntryNonce={workflowEntryNonce}
      onUpdateTabs={async (workflowTabs, activeWorkflowTabId) => {
        const state = await api.setWorkflowTabs({ workflowTabs, activeWorkflowTabId });
        if (state.lastError) throw new Error(state.lastError);
        onSnapshot(state);
      }}
      onActivateController={async (target) => {
        const state = await api.activateWorkflowController(target);
        if (state.lastError) throw new Error(state.lastError);
        if (
          state.selectedWorkspaceId !== target.workspaceId ||
          state.selectedSessionId !== target.sessionId ||
          state.activeView !== "canvas"
        )
          throw new Error("主控身份激活后不一致。");
        onSnapshot(state);
      }}
      onCreateController={
        workspace
          ? async (title, tabId) => {
              const created = await api.createWorkflowController({
                workspaceId: workspace.id,
                title,
                tabId,
              });
              if (created.lastError) throw new Error(created.lastError);
              if (created.selectedWorkspaceId !== workspace.id || !created.selectedSessionId)
                throw new Error("主控会话创建后未能核对项目身份。");
              onSnapshot(created);
              return { sessionId: created.selectedSessionId, project: workspace.path };
            }
          : undefined
      }
      onOpenSessionThread={(sessionId) => {
        for (const row of snapshot.workspaces) {
          if (row.sessions.some((session) => session.id === sessionId && !session.archivedAt)) {
            onSelectSession({ workspaceId: row.id, sessionId });
            return true;
          }
        }
        return false;
      }}
    />
  );
}
