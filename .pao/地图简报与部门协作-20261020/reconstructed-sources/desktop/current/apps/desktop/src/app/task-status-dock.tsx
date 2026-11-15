import { useMemo } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { SessionRef } from "@pi-gui/session-driver/types";
import type { PiDesktopApi } from "../../contracts/ipc";
import type {
  DesktopAppState,
  SessionRecord,
  WorkspaceRecord,
} from "../../contracts/desktop-state";
import type { TranscriptMessage } from "../../contracts/timeline-types";
import type { DiffPanelFileRequest } from "../features/workbench/diff-panel-types";
import { buildFileWorkbenchContexts } from "./file-workbench-contexts";
import { deriveWorkspaceContext } from "./workspace-context";
import { DiffPanel } from "../features/workbench/diff-panel";
import { FileWorkbench } from "../features/workbench/file-workbench";
import type { useWorkbench } from "../features/workbench/use-workbench";
import { Workbench } from "../features/workbench/workbench";
import {
  isComposedBuiltinToolKind,
  renderBuiltinToolPanel,
} from "../features/workbench/builtin-tools";
import { useSidePanelTabHintsVisible } from "../features/workbench/side-panel-tab-hints";
import { TerminalPanel } from "../features/workbench/terminal-panel";
import { SideChatPanel } from "../features/side-chat/side-chat-panel";
import { DepartmentExecutionPanel } from "../features/workboard/department-execution-panel";
import {
  ExtensionViewPanel,
  type ExtensionViewTheme,
} from "../features/extensions/extension-view-panel";
import type { useExtensionViews } from "../features/extensions/use-extension-views";
import type { useExtensionHostActions } from "../features/extensions/use-extension-host-actions";
import { useActiveTheme } from "../ui/active-theme";
import { useI18n } from "../i18n/react";
import { TaskStatusRail, type TaskPlanTarget } from "../features/task-status/task-status-rail";
import { useTaskStatusDockCollapse } from "../features/task-status/use-task-status-collapsed";

/** 右侧状态栏「计划详情」要聚焦的步骤卡；不持久化。 */
export interface WorkflowFocusTarget {
  readonly instanceId?: string;
  readonly planId?: string;
  readonly nodeName?: string;
}

/**
 * 右侧常驻坞：概况与工具各自占用自己的布局位置。状态内容与工具内容分开取数，
 * 互不读取对方内部状态。
 */
export function TaskStatusDock({
  api,
  snapshot,
  workspace,
  session,
  transcript,
  transcriptLoading,
  transcriptFailed,
  diffRequest,
  workbench,
  extensionViews,
  extensionHostActions,
  workbenchTarget,
  toolsOpen,
  toolsWidth,
  onResizeTools,
  onToggleTools,
  openTaskView,
  setWorkflowFocus,
  setWorkflowEntryNonce,
  setDepartmentFocus,
  prepareSideChatDraft,
}: {
  readonly api: PiDesktopApi;
  readonly snapshot: DesktopAppState;
  readonly workspace?: WorkspaceRecord;
  readonly session?: SessionRecord;
  readonly transcript: readonly TranscriptMessage[];
  readonly transcriptLoading: boolean;
  readonly transcriptFailed: boolean;
  readonly diffRequest: DiffPanelFileRequest | null;
  readonly workbench: ReturnType<typeof useWorkbench>;
  readonly extensionViews: ReturnType<typeof useExtensionViews>;
  readonly extensionHostActions: ReturnType<typeof useExtensionHostActions>;
  readonly workbenchTarget: SessionRef | null;
  readonly toolsOpen: boolean;
  readonly toolsWidth: number;
  /** 拖拽工具区宽度与开合由 App 持有的窗口级偏好决定，坞只负责传递。 */
  readonly onResizeTools: (width: number) => void;
  readonly onToggleTools: () => void;
  readonly openTaskView: (view: "canvas" | "workboard", workspaceId?: string) => Promise<void>;
  readonly setWorkflowFocus: Dispatch<SetStateAction<WorkflowFocusTarget | undefined>>;
  readonly setWorkflowEntryNonce: Dispatch<SetStateAction<number>>;
  readonly setDepartmentFocus: Dispatch<SetStateAction<string | undefined>>;
  readonly prepareSideChatDraft: (
    source: SessionRef,
    text: string,
  ) => Promise<{ ok: boolean; message: string }>;
}) {
  const { t } = useI18n();
  // 窄窗默认收起把宽度让给主区；自动收起不写偏好，工具面板与概况各自开关。
  const { collapsed, collapse, expand, dockRef } = useTaskStatusDockCollapse({
    toolsOpen,
    toolsWidth,
  });
  const activeTheme = useActiveTheme();
  const extensionViewTheme = useMemo<ExtensionViewTheme>(
    () => ({
      mode: activeTheme.variant,
      background: activeTheme.tokens["--main"] ?? "",
      foreground: activeTheme.tokens["--text"] ?? "",
      accent: activeTheme.tokens["--accent"] ?? "",
    }),
    [activeTheme],
  );
  // 面板关闭时也保持跟踪，这样唤出它的快捷键会显示数字提示。
  const tabHintsVisible = useSidePanelTabHintsVisible(api.platform ?? "linux");
  const { activeWorktrees, linkedWorktreeByWorkspaceId, rootWorkspace } = useMemo(
    () => deriveWorkspaceContext(snapshot),
    [snapshot],
  );
  const sessionKey = workspace && session ? `${workspace.id}:${session.id}` : "";
  const extensionUi = sessionKey ? snapshot.sessionExtensionUiBySession[sessionKey] : undefined;
  const fileWorkbenchContexts = useMemo(
    () =>
      buildFileWorkbenchContexts({
        workspaces: snapshot.workspaces,
        selectedWorkspace: workspace,
        selectedSessionTitle: extensionUi?.title || session?.title,
        rootWorkspace,
        activeWorktrees,
      }),
    [
      activeWorktrees,
      extensionUi?.title,
      rootWorkspace,
      session?.title,
      snapshot.workspaces,
      workspace,
    ],
  );
  const filesWorkspace = snapshot.workspaces.find(
    (row) => row.id === workbench.view.files.workspaceId,
  );
  const filesWorktree = filesWorkspace
    ? linkedWorktreeByWorkspaceId.get(filesWorkspace.id)
    : undefined;
  const activeTool = workbench.activeTool;
  const activeExtensionView =
    activeTool?.kind === "extension"
      ? extensionViews.views.find(
          (view) => view.extensionId === activeTool.extensionId && view.id === activeTool.viewId,
        )
      : undefined;
  const rail = (
    <TaskStatusRail
      key={sessionKey}
      api={api}
      snapshot={snapshot}
      workspaceId={workspace?.id}
      sessionId={session?.id}
      transcript={transcript}
      transcriptLoading={transcriptLoading}
      transcriptFailed={transcriptFailed}
      compact={collapsed}
      rootRef={dockRef}
      onOpenPlan={async (target: TaskPlanTarget) => {
        await openTaskView("canvas", target.workspaceId);
        setWorkflowFocus(
          target.planId ? { planId: target.planId, nodeName: target.stepId } : undefined,
        );
        setWorkflowEntryNonce((value) => value + 1);
      }}
      onOpenDepartment={async (groupId) => {
        workbench.openTool({ kind: "department", groupId });
        setDepartmentFocus(groupId);
      }}
      onOpenBoard={async () => {
        setDepartmentFocus(undefined);
        await openTaskView("workboard", workspace?.id);
      }}
      onOpenChanges={() => {
        workbench.setChanges({
          workspaceId: workspace?.id ?? workbench.view.changes.workspaceId,
          selectedPath: workbench.view.changes.selectedPath,
          scope: { kind: "uncommitted" },
        });
        workbench.openTool({ kind: "changes" });
      }}
      onCollapse={collapse}
      onExpand={expand}
    />
  );
  return (
    <>
      {rail}
      <div
        className={`task-status-workbench-host${toolsOpen ? "" : " task-status-workbench-host--hidden"}`}
        aria-hidden={!toolsOpen}
      >
        <Workbench
          view={workbench.view}
          platform={api.platform}
          tabHintsVisible={tabHintsVisible}
          onResize={onResizeTools}
          onTogglePanel={onToggleTools}
          panelVisible={toolsOpen}
          extensionViews={extensionViews.views}
          extensionViewsLoading={extensionViews.loading}
          extensionViewsError={extensionViews.error}
          onReloadExtensionViews={extensionViews.reload}
          onOpenTool={workbench.openTool}
          onActivateTool={workbench.activateTool}
          onCloseTool={workbench.closeTool}
          onShowChooser={workbench.showChooser}
          error={workbench.error || extensionHostActions.fileError}
          loading={!workbench.ready}
          onRetryRestore={workbench.retryRestore}
        >
          {activeTool?.kind === "side-chat" && workbenchTarget ? (
            <SideChatPanel
              api={api}
              source={workbenchTarget}
              onPrepareSourceDraft={prepareSideChatDraft}
            />
          ) : activeTool?.kind === "department" && workspace ? (
            <DepartmentExecutionPanel
              api={api}
              workspaceId={workspace.id}
              sessionId={session?.id ?? workbenchTarget?.sessionId ?? ""}
              groupId={activeTool.groupId}
            />
          ) : activeExtensionView?.state === "ready" && workbenchTarget ? (
            <ExtensionViewPanel
              api={api}
              target={workbenchTarget}
              view={activeExtensionView}
              theme={extensionViewTheme}
              onBeforePrepareTaskDraft={extensionHostActions.beforePrepareTaskDraft}
              onPrepareTaskDraftPendingChange={
                extensionHostActions.handlePrepareTaskDraftPendingChange
              }
            />
          ) : activeTool && isComposedBuiltinToolKind(activeTool) && workspace && session ? (
            renderBuiltinToolPanel(activeTool.kind, {
              changes: () => (
                <DiffPanel
                  key={sessionKey}
                  workspaceId={workspace.id}
                  sessionId={session.id}
                  api={api}
                  sessionStatus={session.status}
                  selection={workbench.view.changes}
                  onSelectionChange={workbench.setChanges}
                  onOpenFile={workbench.openFile}
                  fileRequest={diffRequest}
                  contexts={fileWorkbenchContexts}
                />
              ),
              files: () =>
                filesWorkspace ? (
                  <FileWorkbench
                    key={sessionKey}
                    api={api}
                    onTabsChange={workbench.setFiles}
                    sessionStatus={session.status}
                    tabs={workbench.view.files.tabs}
                    worktree={filesWorktree}
                    workspace={filesWorkspace}
                  />
                ) : (
                  <p className="workbench__unavailable" role="status">
                    {t("This file checkout is unavailable.")}
                  </p>
                ),
              terminal: () => (
                <TerminalPanel
                  key={sessionKey}
                  workspace={workspace}
                  sessionId={session.id}
                  onHide={() => workbench.closeTool("terminal")}
                />
              ),
            })
          ) : null}
        </Workbench>
      </div>
    </>
  );
}
