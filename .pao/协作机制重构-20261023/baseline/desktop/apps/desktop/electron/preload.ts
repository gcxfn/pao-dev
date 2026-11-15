import type {
  ExtensionViewOpenFile,
  DesktopExtensionViewInfo,
  OpenExtensionViewInput,
  ExtensionViewConnection,
  ExtensionViewMessage,
  ExtensionViewCatalogChange,
} from "../contracts/extension-views";
import { contextBridge, ipcRenderer, webUtils } from "electron";
import { PRELOAD_DEV_RELOAD_MARKER } from "./dev-reload-preload-probe";
import {
  createDesktopCommandSubscription,
  desktopIpc,
  type PiDesktopApi,
  type CustomProviderConfig,
  type CustomProviderProbeInput,
  type CustomProviderProbeResult,
  type McpServerScope,
  type McpServersSnapshot,
  type NewMcpServerInput,
  type SendSideChatMessageRequest,
  type SessionControlRequest,
  type SessionControlResponse,
  type SideChatRequest,
  type ChangedFilesResult,
  type DesktopNotificationPermissionStatus,
  type WorkspaceFilePreview,
  type PiDesktopCommand,
  type TerminalDataEvent,
  type TerminalErrorEvent,
  type TerminalExitEvent,
  type TerminalPanelSnapshot,
  type TerminalSize,
} from "../contracts/ipc";
import type { SideChatSnapshot } from "../contracts/side-chat";
import type { ExtensionActionEffect, ExtensionActionRequest } from "../contracts/extension-actions";
import type { AppLanguage, CloseWindowBehavior } from "../contracts/desktop-state";
import type { ClipboardImageRead } from "../contracts/composer-attachments";
import type { SaveTaskWorkbenchTemplateInput, TaskWorkbenchTemplate } from "../contracts/workbench";
import type {
  TurnChangesInput,
  TurnChangesResult,
  GetReviewInput,
  ReviewResult,
  ReviewFileInput,
  ReviewFileResult,
  SetReviewFileReviewedInput,
  SetReviewFileReviewedResult,
  ChangeReviewFileStageInput,
  ChangeReviewFileStageResult,
} from "../contracts/review";
import type { WorkboardResult } from "../contracts/workboard";
import type {
  CanvasMutationResult,
  CanvasNodeDetailInput,
  CanvasNodeDetailResult,
  CanvasResult,
} from "../contracts/canvas";
import type { KanbanCardOpInput, KanbanCardOpResult, KanbanResult } from "../contracts/kanban";
import type {
  WorkflowControlCommandInput,
  WorkflowControlCommandResult,
  WorkflowControlQueryInput,
  WorkflowControlResult,
} from "../contracts/workflow-control";
import type { TemporaryPlansQueryInput, TemporaryPlansResult } from "../contracts/temporary-plans";
import type {
  WorkflowCatalogResult,
  WorkflowMutationResult,
  WorkflowPreflightInput,
  WorkflowPreflightResult,
  WorkflowRecipeDeleteInput,
  WorkflowRecipeSaveInput,
  WorkflowStartInput,
  WorkflowTemplateInstallInput,
  WorkflowTierSaveInput,
} from "../contracts/workflow-wizard";
import type { SessionRef } from "@pi-gui/session-driver/types";
import type {
  NavigateSessionTreeOptions,
  NavigateSessionTreeResult,
  SessionTreeSnapshot,
} from "@pi-gui/session-driver/types";
import type { HostUiResponse } from "@pi-gui/session-driver";
import type { RuntimeSettingsSnapshot } from "@pi-gui/session-driver/runtime-types";
import type {
  AppView,
  ComposerAttachment,
  CreateSessionInput,
  CreateWorkflowControllerInput,
  CreateWorktreeInput,
  DesktopAppState,
  ForkThreadInput,
  NotificationPreferences,
  RemoveWorktreeInput,
  SendChildThreadFollowUpInput,
  SetChildSupervisionLoopInput,
  SelectedTranscriptRecord,
  SelectedTranscriptUpdate,
  SetWorkflowTabsInput,
  StartThreadInput,
  ThemePresetId,
  ThreadGrouping,
  WorkspaceSessionTarget,
  CreateScheduledTaskInput,
  UpdateScheduledTaskInput,
} from "../contracts/desktop-state";

const devReloadMarkersEnabled = process.env.PI_APP_DEV_RELOAD_MARKERS === "1";

function resolveDevReloadMarkers() {
  if (!devReloadMarkersEnabled) {
    return undefined;
  }

  return {
    preload: PRELOAD_DEV_RELOAD_MARKER,
  };
}

const devReloadMarkers = resolveDevReloadMarkers();

if (devReloadMarkers) {
  contextBridge.exposeInMainWorld("__piDevReloadHost", devReloadMarkers);
}

function subscribeIpc<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const pendingDraftFlushHandlers = new Set<() => Promise<void>>();
const workflowLeaveHandlers = new Set<() => Promise<boolean>>();
ipcRenderer.on(desktopIpc.workflowLeaveRequested, (_event, requestId: number) => {
  void (async () => {
    let allowed = true;
    for (const handler of [...workflowLeaveHandlers]) {
      if (!(await handler())) {
        allowed = false;
        break;
      }
    }
    await ipcRenderer.invoke(desktopIpc.workflowLeaveResolved, { requestId, allowed });
  })().catch((error: unknown) => {
    console.error("[preload] 工作流离开检查失败", error);
    void ipcRenderer
      .invoke(desktopIpc.workflowLeaveResolved, { requestId, allowed: false })
      .catch((ackError: unknown) => console.error("[preload] 工作流取消回执失败", ackError));
  });
});
ipcRenderer.on(desktopIpc.flushPendingComposerDraft, (_event, requestId: number) => {
  // Always acknowledge, even with no handler, so main never waits out its bound needlessly.
  void Promise.allSettled([...pendingDraftFlushHandlers].map((handler) => handler()))
    .then(() => ipcRenderer.invoke(desktopIpc.pendingComposerDraftFlushed, requestId))
    .catch((error: unknown) => {
      console.error("[preload] pending draft flush acknowledgement failed", error);
    });
});

const appCommands = createDesktopCommandSubscription();
ipcRenderer.on(desktopIpc.appCommand, (_event, command: PiDesktopCommand) => {
  appCommands.deliver(command);
});

contextBridge.exposeInMainWorld("piApp", {
  platform: process.platform,
  versions: process.versions,
  ping: () => ipcRenderer.invoke(desktopIpc.ping) as Promise<string>,
  getState: () => ipcRenderer.invoke(desktopIpc.stateRequest) as Promise<DesktopAppState>,
  getTaskWorkbenchTemplate: (target: SessionRef) =>
    ipcRenderer.invoke(
      desktopIpc.getTaskWorkbenchTemplate,
      target,
    ) as Promise<TaskWorkbenchTemplate | null>,
  saveTaskWorkbenchTemplate: (input: SaveTaskWorkbenchTemplateInput) =>
    ipcRenderer.invoke(desktopIpc.saveTaskWorkbenchTemplate, input) as Promise<void>,
  listExtensionViews: (target: SessionRef) =>
    ipcRenderer.invoke(desktopIpc.listExtensionViews, target) as Promise<
      readonly DesktopExtensionViewInfo[]
    >,
  openExtensionView: (input: OpenExtensionViewInput) =>
    ipcRenderer.invoke(desktopIpc.openExtensionView, input) as Promise<ExtensionViewConnection>,
  sendExtensionViewMessage: (input: ExtensionViewMessage) =>
    ipcRenderer.invoke(desktopIpc.sendExtensionViewMessage, input) as Promise<void>,
  closeExtensionView: (connectionId: string) =>
    ipcRenderer.invoke(desktopIpc.closeExtensionView, connectionId) as Promise<void>,
  onExtensionViewMessage: (listener: (event: ExtensionViewMessage) => void) =>
    subscribeIpc(desktopIpc.extensionViewMessage, listener),
  onExtensionViewCatalogChanged: (listener: (event: ExtensionViewCatalogChange) => void) =>
    subscribeIpc(desktopIpc.extensionViewCatalogChanged, listener),
  onExtensionViewOpenFile: (listener: (event: ExtensionViewOpenFile) => void) =>
    subscribeIpc(desktopIpc.extensionViewOpenFile, listener),
  runExtensionAction: (request: ExtensionActionRequest) =>
    ipcRenderer.invoke(
      desktopIpc.runExtensionAction,
      request,
    ) as Promise<ExtensionActionEffect | null>,
  getTurnChanges: (input: TurnChangesInput) =>
    ipcRenderer.invoke(desktopIpc.getTurnChanges, input) as Promise<TurnChangesResult>,
  getReview: (input: GetReviewInput) =>
    ipcRenderer.invoke(desktopIpc.getReview, input) as Promise<ReviewResult>,
  getReviewFile: (input: ReviewFileInput) =>
    ipcRenderer.invoke(desktopIpc.getReviewFile, input) as Promise<ReviewFileResult>,
  setReviewFileReviewed: (input: SetReviewFileReviewedInput) =>
    ipcRenderer.invoke(
      desktopIpc.setReviewFileReviewed,
      input,
    ) as Promise<SetReviewFileReviewedResult>,
  changeReviewFileStage: (input: ChangeReviewFileStageInput) =>
    ipcRenderer.invoke(
      desktopIpc.changeReviewFileStage,
      input,
    ) as Promise<ChangeReviewFileStageResult>,
  getWorkboard: () => ipcRenderer.invoke(desktopIpc.getWorkboard) as Promise<WorkboardResult>,
  getCanvas: () => ipcRenderer.invoke(desktopIpc.getCanvas) as Promise<CanvasResult>,
  getCanvasNodeDetail: (input: CanvasNodeDetailInput) =>
    ipcRenderer.invoke(desktopIpc.getCanvasNodeDetail, input) as Promise<CanvasNodeDetailResult>,
  openCanvasCard: (input: CanvasNodeDetailInput) =>
    ipcRenderer.invoke(desktopIpc.openCanvasCard, input) as Promise<CanvasMutationResult>,
  getKanban: (workspaceId: string) =>
    ipcRenderer.invoke(desktopIpc.getKanban, workspaceId) as Promise<KanbanResult>,
  getWorkboardSession: (input) => ipcRenderer.invoke(desktopIpc.getWorkboardSession, input),
  kanbanCardOp: (input: KanbanCardOpInput) =>
    ipcRenderer.invoke(desktopIpc.kanbanCardOp, input) as Promise<KanbanCardOpResult>,
  getWorkflowCatalog: () =>
    ipcRenderer.invoke(desktopIpc.getWorkflowCatalog) as Promise<WorkflowCatalogResult>,
  runWorkflowPreflight: (input: WorkflowPreflightInput) =>
    ipcRenderer.invoke(desktopIpc.runWorkflowPreflight, input) as Promise<WorkflowPreflightResult>,
  installWorkflowTemplate: (input: WorkflowTemplateInstallInput) =>
    ipcRenderer.invoke(
      desktopIpc.installWorkflowTemplate,
      input,
    ) as Promise<WorkflowMutationResult>,
  saveWorkflowRecipe: (input: WorkflowRecipeSaveInput) =>
    ipcRenderer.invoke(desktopIpc.saveWorkflowRecipe, input) as Promise<WorkflowMutationResult>,
  deleteWorkflowRecipe: (input: WorkflowRecipeDeleteInput) =>
    ipcRenderer.invoke(desktopIpc.deleteWorkflowRecipe, input) as Promise<WorkflowMutationResult>,
  startWorkflow: (input: WorkflowStartInput) =>
    ipcRenderer.invoke(desktopIpc.startWorkflow, input) as Promise<WorkflowMutationResult>,
  saveWorkflowTier: (input: WorkflowTierSaveInput) =>
    ipcRenderer.invoke(desktopIpc.saveWorkflowTier, input) as Promise<WorkflowMutationResult>,
  getWorkflowControl: (input: WorkflowControlQueryInput) =>
    ipcRenderer.invoke(desktopIpc.getWorkflowControl, input) as Promise<WorkflowControlResult>,
  controlWorkflow: (input: WorkflowControlCommandInput) =>
    ipcRenderer.invoke(desktopIpc.controlWorkflow, input) as Promise<WorkflowControlCommandResult>,
  getTemporaryPlans: (input: TemporaryPlansQueryInput) =>
    ipcRenderer.invoke(desktopIpc.getTemporaryPlans, input) as Promise<TemporaryPlansResult>,
  onStateChanged: (listener: (state: DesktopAppState) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, state: DesktopAppState) => {
      listener(state);
    };
    ipcRenderer.on(desktopIpc.stateChanged, handle);
    return () => {
      ipcRenderer.removeListener(desktopIpc.stateChanged, handle);
    };
  },
  getSelectedTranscript: () =>
    ipcRenderer.invoke(
      desktopIpc.selectedTranscriptRequest,
    ) as Promise<SelectedTranscriptRecord | null>,
  onSelectedTranscriptChanged: (listener: (payload: SelectedTranscriptUpdate | null) => void) => {
    const handle = (
      _event: Electron.IpcRendererEvent,
      payload: SelectedTranscriptUpdate | null,
    ) => {
      listener(payload);
    };
    ipcRenderer.on(desktopIpc.selectedTranscriptChanged, handle);
    return () => {
      ipcRenderer.removeListener(desktopIpc.selectedTranscriptChanged, handle);
    };
  },
  onCommand: (listener: (command: PiDesktopCommand) => void) => appCommands.subscribe(listener),
  onWorkspacePicked: (listener: (workspaceId: string) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, workspaceId: string) => {
      listener(workspaceId);
    };
    ipcRenderer.on(desktopIpc.workspacePicked, handle);
    return () => {
      ipcRenderer.removeListener(desktopIpc.workspacePicked, handle);
    };
  },
  onClipboardImagePasted: (listener: (result: ClipboardImageRead) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, result: ClipboardImageRead) => {
      listener(result);
    };
    ipcRenderer.on(desktopIpc.clipboardImagePasted, handle);
    return () => {
      ipcRenderer.removeListener(desktopIpc.clipboardImagePasted, handle);
    };
  },
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  pickWorkspace: () => ipcRenderer.invoke(desktopIpc.pickWorkspace) as Promise<DesktopAppState>,
  selectWorkspace: (workspaceId: string) =>
    ipcRenderer.invoke(desktopIpc.selectWorkspace, workspaceId) as Promise<DesktopAppState>,
  renameWorkspace: (workspaceId: string, displayName: string) =>
    ipcRenderer.invoke(
      desktopIpc.renameWorkspace,
      workspaceId,
      displayName,
    ) as Promise<DesktopAppState>,
  removeWorkspace: (workspaceId: string) =>
    ipcRenderer.invoke(desktopIpc.removeWorkspace, workspaceId) as Promise<DesktopAppState>,
  reorderWorkspaces: (workspaceOrder: readonly string[]) =>
    ipcRenderer.invoke(desktopIpc.reorderWorkspaces, workspaceOrder) as Promise<DesktopAppState>,
  reorderPinnedSessions: (pinnedSessionOrder: readonly string[]) =>
    ipcRenderer.invoke(
      desktopIpc.reorderPinnedSessions,
      pinnedSessionOrder,
    ) as Promise<DesktopAppState>,
  openWorkspaceInFinder: (workspaceId: string) =>
    ipcRenderer.invoke(desktopIpc.openWorkspaceInFinder, workspaceId) as Promise<void>,
  createWorktree: (input: CreateWorktreeInput) =>
    ipcRenderer.invoke(desktopIpc.createWorktree, input) as Promise<DesktopAppState>,
  removeWorktree: (input: RemoveWorktreeInput) =>
    ipcRenderer.invoke(desktopIpc.removeWorktree, input) as Promise<DesktopAppState>,
  openSkillInFinder: (workspaceId: string, filePath: string) =>
    ipcRenderer.invoke(desktopIpc.openSkillInFinder, workspaceId, filePath) as Promise<void>,
  openExtensionInFinder: (workspaceId: string, filePath: string) =>
    ipcRenderer.invoke(desktopIpc.openExtensionInFinder, workspaceId, filePath) as Promise<void>,
  syncCurrentWorkspace: () =>
    ipcRenderer.invoke(desktopIpc.syncCurrentWorkspace) as Promise<DesktopAppState>,
  selectSession: (target: WorkspaceSessionTarget) =>
    ipcRenderer.invoke(desktopIpc.selectSession, target) as Promise<DesktopAppState>,
  renameSession: (target: WorkspaceSessionTarget, title: string) =>
    ipcRenderer.invoke(desktopIpc.renameSession, target, title) as Promise<DesktopAppState>,
  archiveSession: (target: WorkspaceSessionTarget) =>
    ipcRenderer.invoke(desktopIpc.archiveSession, target) as Promise<DesktopAppState>,
  deleteSession: (target: WorkspaceSessionTarget) =>
    ipcRenderer.invoke(desktopIpc.deleteSession, target) as Promise<DesktopAppState>,
  unarchiveSession: (target: WorkspaceSessionTarget) =>
    ipcRenderer.invoke(desktopIpc.unarchiveSession, target) as Promise<DesktopAppState>,
  markSessionRead: (target: WorkspaceSessionTarget) =>
    ipcRenderer.invoke(desktopIpc.markSessionRead, target) as Promise<DesktopAppState>,
  setSessionPinned: (target: WorkspaceSessionTarget, pinned: boolean) =>
    ipcRenderer.invoke(desktopIpc.setSessionPinned, target, pinned) as Promise<DesktopAppState>,
  createSession: (input: CreateSessionInput) =>
    ipcRenderer.invoke(desktopIpc.createSession, input) as Promise<DesktopAppState>,
  startThread: (input: StartThreadInput) =>
    ipcRenderer.invoke(desktopIpc.startThread, input) as Promise<DesktopAppState>,
  forkThread: (input: ForkThreadInput) =>
    ipcRenderer.invoke(desktopIpc.forkThread, input) as Promise<DesktopAppState>,
  sendChildThreadFollowUp: (input: SendChildThreadFollowUpInput) =>
    ipcRenderer.invoke(desktopIpc.sendChildThreadFollowUp, input) as Promise<DesktopAppState>,
  setChildSupervisionLoop: (input: SetChildSupervisionLoopInput) =>
    ipcRenderer.invoke(desktopIpc.setChildSupervisionLoop, input) as Promise<DesktopAppState>,
  createScheduledTask: (input: CreateScheduledTaskInput) =>
    ipcRenderer.invoke(desktopIpc.createScheduledTask, input) as Promise<DesktopAppState>,
  updateScheduledTask: (id: string, patch: UpdateScheduledTaskInput) =>
    ipcRenderer.invoke(desktopIpc.updateScheduledTask, id, patch) as Promise<DesktopAppState>,
  deleteScheduledTask: (id: string) =>
    ipcRenderer.invoke(desktopIpc.deleteScheduledTask, id) as Promise<DesktopAppState>,
  beginScheduledTaskInterview: () =>
    ipcRenderer.invoke(desktopIpc.beginScheduledTaskInterview) as Promise<DesktopAppState>,
  cancelCurrentRun: () =>
    ipcRenderer.invoke(desktopIpc.cancelCurrentRun) as Promise<DesktopAppState>,
  sessionControl: (request: SessionControlRequest) =>
    ipcRenderer.invoke(desktopIpc.sessionControl, request) as Promise<SessionControlResponse>,
  getSideChat: (input: SideChatRequest) =>
    ipcRenderer.invoke(desktopIpc.getSideChat, input) as Promise<SideChatSnapshot>,
  sendSideChatMessage: (input: SendSideChatMessageRequest) =>
    ipcRenderer.invoke(desktopIpc.sendSideChatMessage, input) as Promise<SideChatSnapshot>,
  setActiveView: (view: AppView) =>
    ipcRenderer.invoke(desktopIpc.setActiveView, view) as Promise<DesktopAppState>,
  setSidebarCollapsed: (collapsed: boolean) =>
    ipcRenderer.invoke(desktopIpc.setSidebarCollapsed, collapsed) as Promise<DesktopAppState>,
  setThreadGrouping: (grouping: ThreadGrouping) =>
    ipcRenderer.invoke(desktopIpc.setThreadGrouping, grouping) as Promise<DesktopAppState>,
  setWorkspaceCollapsed: (workspaceId: string, collapsed: boolean) =>
    ipcRenderer.invoke(
      desktopIpc.setWorkspaceCollapsed,
      workspaceId,
      collapsed,
    ) as Promise<DesktopAppState>,
  refreshRuntime: (workspaceId?: string) =>
    ipcRenderer.invoke(desktopIpc.refreshRuntime, workspaceId) as Promise<DesktopAppState>,
  setModelSettingsScopeMode: (mode: "app-global" | "per-repo") =>
    ipcRenderer.invoke(desktopIpc.setModelSettingsScopeMode, mode) as Promise<DesktopAppState>,
  setDefaultModel: (workspaceId: string, provider: string, modelId: string) =>
    ipcRenderer.invoke(
      desktopIpc.setDefaultModel,
      workspaceId,
      provider,
      modelId,
    ) as Promise<DesktopAppState>,
  setDefaultThinkingLevel: (
    workspaceId: string,
    thinkingLevel: RuntimeSettingsSnapshot["defaultThinkingLevel"],
  ) =>
    ipcRenderer.invoke(
      desktopIpc.setDefaultThinkingLevel,
      workspaceId,
      thinkingLevel,
    ) as Promise<DesktopAppState>,
  setSessionModel: (workspaceId: string, sessionId: string, provider: string, modelId: string) =>
    ipcRenderer.invoke(
      desktopIpc.setSessionModel,
      workspaceId,
      sessionId,
      provider,
      modelId,
    ) as Promise<DesktopAppState>,
  setSessionThinkingLevel: (
    workspaceId: string,
    sessionId: string,
    thinkingLevel: RuntimeSettingsSnapshot["defaultThinkingLevel"],
  ) =>
    ipcRenderer.invoke(
      desktopIpc.setSessionThinkingLevel,
      workspaceId,
      sessionId,
      thinkingLevel,
    ) as Promise<DesktopAppState>,
  loginProvider: (workspaceId: string, providerId: string) =>
    ipcRenderer.invoke(
      desktopIpc.loginProvider,
      workspaceId,
      providerId,
    ) as Promise<DesktopAppState>,
  logoutProvider: (workspaceId: string, providerId: string) =>
    ipcRenderer.invoke(
      desktopIpc.logoutProvider,
      workspaceId,
      providerId,
    ) as Promise<DesktopAppState>,
  setProviderApiKey: (workspaceId: string, providerId: string, apiKey: string) =>
    ipcRenderer.invoke(
      desktopIpc.setProviderApiKey,
      workspaceId,
      providerId,
      apiKey,
    ) as Promise<DesktopAppState>,
  listCustomProviders: () =>
    ipcRenderer.invoke(desktopIpc.listCustomProviders) as Promise<readonly CustomProviderConfig[]>,
  setCustomProvider: (workspaceId: string, config: CustomProviderConfig) =>
    ipcRenderer.invoke(
      desktopIpc.setCustomProvider,
      workspaceId,
      config,
    ) as Promise<DesktopAppState>,
  deleteCustomProvider: (workspaceId: string, providerId: string) =>
    ipcRenderer.invoke(
      desktopIpc.deleteCustomProvider,
      workspaceId,
      providerId,
    ) as Promise<DesktopAppState>,
  probeCustomProviderModels: (input: CustomProviderProbeInput) =>
    ipcRenderer.invoke(
      desktopIpc.probeCustomProviderModels,
      input,
    ) as Promise<CustomProviderProbeResult>,
  setEnableSkillCommands: (workspaceId: string, enabled: boolean) =>
    ipcRenderer.invoke(
      desktopIpc.setEnableSkillCommands,
      workspaceId,
      enabled,
    ) as Promise<DesktopAppState>,
  setScopedModelPatterns: (workspaceId: string, patterns: readonly string[]) =>
    ipcRenderer.invoke(
      desktopIpc.setScopedModelPatterns,
      workspaceId,
      patterns,
    ) as Promise<DesktopAppState>,
  setSkillEnabled: (workspaceId: string, filePath: string, enabled: boolean) =>
    ipcRenderer.invoke(
      desktopIpc.setSkillEnabled,
      workspaceId,
      filePath,
      enabled,
    ) as Promise<DesktopAppState>,
  setExtensionEnabled: (workspaceId: string, filePath: string, enabled: boolean) =>
    ipcRenderer.invoke(
      desktopIpc.setExtensionEnabled,
      workspaceId,
      filePath,
      enabled,
    ) as Promise<DesktopAppState>,
  listMcpServers: (workspaceId: string) =>
    ipcRenderer.invoke(desktopIpc.listMcpServers, workspaceId) as Promise<McpServersSnapshot>,
  addMcpServer: (workspaceId: string, server: NewMcpServerInput) =>
    ipcRenderer.invoke(desktopIpc.addMcpServer, workspaceId, server) as Promise<DesktopAppState>,
  removeMcpServer: (workspaceId: string, name: string) =>
    ipcRenderer.invoke(desktopIpc.removeMcpServer, workspaceId, name) as Promise<DesktopAppState>,
  setMcpServerEnabled: (
    workspaceId: string,
    scope: McpServerScope,
    name: string,
    enabled: boolean,
  ) =>
    ipcRenderer.invoke(
      desktopIpc.setMcpServerEnabled,
      workspaceId,
      scope,
      name,
      enabled,
    ) as Promise<DesktopAppState>,
  setCodemodeAlwaysOn: (workspaceId: string, alwaysOn: boolean) =>
    ipcRenderer.invoke(
      desktopIpc.setCodemodeAlwaysOn,
      workspaceId,
      alwaysOn,
    ) as Promise<DesktopAppState>,
  respondToHostUiRequest: (workspaceId: string, sessionId: string, response: HostUiResponse) =>
    ipcRenderer.invoke(
      desktopIpc.respondToHostUiRequest,
      workspaceId,
      sessionId,
      response,
    ) as Promise<DesktopAppState>,
  setNotificationPreferences: (preferences: Partial<NotificationPreferences>) =>
    ipcRenderer.invoke(
      desktopIpc.setNotificationPreferences,
      preferences,
    ) as Promise<DesktopAppState>,
  setIntegratedTerminalShell: (shellPath: string) =>
    ipcRenderer.invoke(
      desktopIpc.setIntegratedTerminalShell,
      shellPath,
    ) as Promise<DesktopAppState>,
  setPaoHome: (paoHome: string) =>
    ipcRenderer.invoke(desktopIpc.setPaoHome, paoHome) as Promise<DesktopAppState>,
  setCloseWindowBehavior: (behavior: CloseWindowBehavior) =>
    ipcRenderer.invoke(desktopIpc.setCloseWindowBehavior, behavior) as Promise<DesktopAppState>,
  setEnableTransparency: (enabled: boolean) =>
    ipcRenderer.invoke(desktopIpc.setEnableTransparency, enabled) as Promise<DesktopAppState>,
  setThemePresetId: (presetId: ThemePresetId) =>
    ipcRenderer.invoke(desktopIpc.setThemePresetId, presetId) as Promise<DesktopAppState>,
  setLanguage: (language: AppLanguage) =>
    ipcRenderer.invoke(desktopIpc.setLanguage, language) as Promise<DesktopAppState>,
  ensureTerminalPanel: (
    workspaceId: string,
    terminalScopeId: string,
    size?: Partial<TerminalSize>,
  ) =>
    ipcRenderer.invoke(
      desktopIpc.terminalEnsurePanel,
      workspaceId,
      terminalScopeId,
      size,
    ) as Promise<TerminalPanelSnapshot>,
  createTerminalSession: (
    workspaceId: string,
    terminalScopeId: string,
    size?: Partial<TerminalSize>,
  ) =>
    ipcRenderer.invoke(
      desktopIpc.terminalCreateSession,
      workspaceId,
      terminalScopeId,
      size,
    ) as Promise<TerminalPanelSnapshot>,
  setActiveTerminalSession: (workspaceId: string, terminalScopeId: string, terminalId: string) =>
    ipcRenderer.invoke(
      desktopIpc.terminalSetActiveSession,
      workspaceId,
      terminalScopeId,
      terminalId,
    ) as Promise<TerminalPanelSnapshot>,
  writeTerminal: (terminalId: string, data: string) =>
    ipcRenderer.invoke(desktopIpc.terminalWrite, terminalId, data) as Promise<void>,
  resizeTerminal: (terminalId: string, size: TerminalSize) =>
    ipcRenderer.invoke(desktopIpc.terminalResize, terminalId, size) as Promise<void>,
  restartTerminalSession: (terminalId: string, size?: Partial<TerminalSize>) =>
    ipcRenderer.invoke(
      desktopIpc.terminalRestartSession,
      terminalId,
      size,
    ) as Promise<TerminalPanelSnapshot>,
  closeTerminalSession: (terminalId: string) =>
    ipcRenderer.invoke(
      desktopIpc.terminalCloseSession,
      terminalId,
    ) as Promise<TerminalPanelSnapshot | null>,
  setTerminalTitle: (terminalId: string, title: string) =>
    ipcRenderer.invoke(desktopIpc.terminalSetTitle, terminalId, title) as Promise<void>,
  setTerminalFocused: (focused: boolean) => {
    ipcRenderer.send(desktopIpc.terminalSetFocused, focused);
    return Promise.resolve();
  },
  setSidePanelFocused: (focused: boolean) => {
    ipcRenderer.send(desktopIpc.sidePanelSetFocused, focused);
    return Promise.resolve();
  },
  onTerminalData: (listener: (event: TerminalDataEvent) => void) =>
    subscribeIpc(desktopIpc.terminalData, listener),
  onTerminalExit: (listener: (event: TerminalExitEvent) => void) =>
    subscribeIpc(desktopIpc.terminalExit, listener),
  onTerminalError: (listener: (event: TerminalErrorEvent) => void) =>
    subscribeIpc(desktopIpc.terminalError, listener),
  getNotificationPermissionStatus: () =>
    ipcRenderer.invoke(
      desktopIpc.getNotificationPermissionStatus,
    ) as Promise<DesktopNotificationPermissionStatus>,
  requestNotificationPermission: () =>
    ipcRenderer.invoke(
      desktopIpc.requestNotificationPermission,
    ) as Promise<DesktopNotificationPermissionStatus>,
  openSystemNotificationSettings: () =>
    ipcRenderer.invoke(desktopIpc.openSystemNotificationSettings) as Promise<void>,
  onNotificationPermissionStatusChanged: (
    callback: (status: DesktopNotificationPermissionStatus) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      status: DesktopNotificationPermissionStatus,
    ) => callback(status);
    ipcRenderer.on(desktopIpc.notificationPermissionStatusChanged, handler);
    return () => {
      ipcRenderer.removeListener(desktopIpc.notificationPermissionStatusChanged, handler);
    };
  },
  pickComposerAttachments: () =>
    ipcRenderer.invoke(desktopIpc.pickComposerAttachments) as Promise<DesktopAppState>,
  readClipboardImage: () =>
    ipcRenderer.sendSync(desktopIpc.readClipboardImage) as ClipboardImageRead,
  addComposerAttachments: (attachments: readonly ComposerAttachment[]) =>
    ipcRenderer.invoke(desktopIpc.addComposerAttachments, attachments) as Promise<DesktopAppState>,
  removeComposerAttachment: (attachmentId: string) =>
    ipcRenderer.invoke(
      desktopIpc.removeComposerAttachment,
      attachmentId,
    ) as Promise<DesktopAppState>,
  editQueuedComposerMessage: (messageId: string, currentDraft?: string) =>
    ipcRenderer.invoke(
      desktopIpc.editQueuedComposerMessage,
      messageId,
      currentDraft,
    ) as Promise<DesktopAppState>,
  cancelQueuedComposerEdit: () =>
    ipcRenderer.invoke(desktopIpc.cancelQueuedComposerEdit) as Promise<DesktopAppState>,
  removeQueuedComposerMessage: (messageId: string) =>
    ipcRenderer.invoke(
      desktopIpc.removeQueuedComposerMessage,
      messageId,
    ) as Promise<DesktopAppState>,
  steerQueuedComposerMessage: (messageId: string) =>
    ipcRenderer.invoke(
      desktopIpc.steerQueuedComposerMessage,
      messageId,
    ) as Promise<DesktopAppState>,
  persistComposerDraft: (input: { readonly target: SessionRef; readonly draft: string }) =>
    ipcRenderer.invoke(desktopIpc.persistComposerDraft, input) as Promise<void>,
  updateComposerDraft: (composerDraft: string, target: SessionRef) =>
    ipcRenderer.invoke(
      desktopIpc.updateComposerDraft,
      composerDraft,
      target,
    ) as Promise<DesktopAppState>,
  onPendingComposerDraftFlush: (handler: () => Promise<void>) => {
    pendingDraftFlushHandlers.add(handler);
    return () => {
      pendingDraftFlushHandlers.delete(handler);
    };
  },
  onWorkflowLeaveRequest: (handler: () => Promise<boolean>) => {
    workflowLeaveHandlers.add(handler);
    return () => {
      workflowLeaveHandlers.delete(handler);
    };
  },
  createWorkflowController: (input: CreateWorkflowControllerInput) =>
    ipcRenderer.invoke(desktopIpc.createWorkflowController, input) as Promise<DesktopAppState>,
  setWorkflowTabs: (input: SetWorkflowTabsInput) =>
    ipcRenderer.invoke(desktopIpc.setWorkflowTabs, input) as Promise<DesktopAppState>,
  activateWorkflowController: (target: WorkspaceSessionTarget) =>
    ipcRenderer.invoke(desktopIpc.activateWorkflowController, target) as Promise<DesktopAppState>,
  submitComposer: (text: string, options?: { readonly deliverAs?: "steer" | "followUp" }) =>
    ipcRenderer.invoke(desktopIpc.submitComposer, text, options) as Promise<DesktopAppState>,
  getSessionTree: (target: WorkspaceSessionTarget) =>
    ipcRenderer.invoke(desktopIpc.getSessionTree, target) as Promise<SessionTreeSnapshot>,
  navigateSessionTree: (
    target: WorkspaceSessionTarget,
    targetId: string,
    options?: NavigateSessionTreeOptions,
  ) =>
    ipcRenderer.invoke(desktopIpc.navigateSessionTree, target, targetId, options) as Promise<{
      readonly state: DesktopAppState;
      readonly result: NavigateSessionTreeResult;
    }>,
  listWorkspaceFiles: (workspaceId: string, options?: { readonly force?: boolean }) =>
    ipcRenderer.invoke(desktopIpc.listWorkspaceFiles, workspaceId, options) as Promise<string[]>,
  readWorkspaceFile: (workspaceId: string, filePath: string) =>
    ipcRenderer.invoke(
      desktopIpc.readWorkspaceFile,
      workspaceId,
      filePath,
    ) as Promise<WorkspaceFilePreview>,
  revealWorkspaceFile: (workspaceId: string, filePath: string) =>
    ipcRenderer.invoke(desktopIpc.revealWorkspaceFile, workspaceId, filePath) as Promise<void>,
  getChangedFiles: (workspaceId: string) =>
    ipcRenderer.invoke(desktopIpc.getChangedFiles, workspaceId) as Promise<ChangedFilesResult>,
  getFileDiff: (workspaceId: string, filePath: string) =>
    ipcRenderer.invoke(desktopIpc.getFileDiff, workspaceId, filePath) as Promise<string>,
  stageFile: (workspaceId: string, filePath: string, stagingSourcePath?: string) =>
    ipcRenderer.invoke(
      desktopIpc.stageFile,
      workspaceId,
      filePath,
      stagingSourcePath,
    ) as Promise<void>,
  toggleWindowMaximize: () => ipcRenderer.invoke(desktopIpc.toggleWindowMaximize) as Promise<void>,
  openExternal: (url: string) => ipcRenderer.invoke(desktopIpc.openExternal, url) as Promise<void>,
  getThemeMode: () =>
    ipcRenderer.invoke(desktopIpc.getThemeMode) as Promise<"system" | "light" | "dark">,
  getResolvedTheme: () =>
    ipcRenderer.invoke(desktopIpc.getResolvedTheme) as Promise<"light" | "dark">,
  setThemeMode: (mode: "system" | "light" | "dark") =>
    ipcRenderer.invoke(desktopIpc.setThemeMode, mode) as Promise<DesktopAppState>,
  onWindowFocused: (listener: () => void) => subscribeIpc(desktopIpc.windowFocused, listener),
  onThemeChanged: (callback: (theme: "light" | "dark") => void) => {
    const handler = (_event: Electron.IpcRendererEvent, theme: "light" | "dark") => callback(theme);
    ipcRenderer.on(desktopIpc.themeChanged, handler);
    return () => {
      ipcRenderer.removeListener(desktopIpc.themeChanged, handler);
    };
  },
  relaunchApplication: () => ipcRenderer.invoke(desktopIpc.relaunchApplication) as Promise<void>,
} satisfies PiDesktopApi);
