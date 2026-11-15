import type { SessionRef } from "@pi-gui/session-driver";
import type { DesktopAppViewState, WorkspaceRecord } from "../../contracts/desktop-state";

/** 辅助对话来源必须是该窗口选中的会话，并仍存在于已登记 workspace。 */
export function requireSideChatSource(
  source: SessionRef,
  view: DesktopAppViewState,
  workspaces: readonly WorkspaceRecord[],
): void {
  if (
    view.selectedWorkspaceId !== source.workspaceId ||
    view.selectedSessionId !== source.sessionId
  ) {
    throw new Error("Side chat source must be the selected session in this window.");
  }
  if (
    !workspaces.some(
      (workspace) =>
        workspace.id === source.workspaceId &&
        workspace.sessions.some((session) => session.id === source.sessionId),
    )
  ) {
    throw new Error(`Unknown side chat source: ${source.workspaceId}:${source.sessionId}`);
  }
}
