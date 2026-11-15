import { ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { stat } from "node:fs/promises";
import path from "node:path";
import { tMain } from "../../contracts/i18n";
import type { SessionRef } from "@pi-gui/session-driver";
import type {
  ComposerAttachment,
  DesktopAppState,
  WorkspaceSessionTarget,
} from "../../contracts/desktop-state";
import {
  ComposerAttachmentLimitError,
  type ClipboardImageRead,
} from "../../contracts/composer-attachments";
import {
  desktopIpc,
  type ChangedFilesResult,
  type CustomProviderProbeInput,
  type CustomProviderProbeResult,
} from "../../contracts/ipc";
import type { DesktopAppStore } from "../application/app-store";
import type { NotificationPermissionService } from "../platform/notification-permission";
import type { TerminalService } from "../platform/terminal-service";
import type { ThemeManager } from "../platform/theme-manager";
import type { WindowOwner } from "../windows/window-owner";
import type { PendingComposerDraftFlusher } from "../windows/pending-draft-flush";
import type { WorkflowLeaveGuard } from "../windows/workflow-leave-guard";
import { WorkbenchRequests, type WorkbenchOwner } from "./workbench-requests";
import type { DesktopExtensionViewOwner } from "../extensions/extension-view-owner";
import { registerExtensionViewRequests } from "./extension-view-requests";
import { registerReviewRequests, type ReviewRequestsOwner } from "./review-requests";
import { registerWorkboardRequests, type WorkboardRequestsOwner } from "./workboard-requests";
import type { CanvasQuery } from "../platform/pao/canvas-query";
import type { WorkflowWizardBridge } from "../platform/pao/workflow-wizard-bridge";
import type { FlowControlQuery } from "../platform/pao/flow-control-query";
import { createKanbanQuery } from "../platform/pao/kanban-query";
import { createKanbanCardOps } from "../platform/pao/kanban-ops";
import { createFlowControlQuery } from "../platform/pao/flow-control-query";
import { createSessionControlCoordinator, sessionControlQueueLane } from "./session-control";
import { mainFrameHandler } from "./main-frame-ipc";
import { assertComposerAttachmentPixels } from "./composer-attachment-pixels";
import { isPathInsideAnyRoot } from "../platform/files/workspace-paths";
import {
  expectAppView,
  expectBoolean,
  expectCanvasNodeDetailInput,
  expectComposerAttachments,
  expectCreateSessionInput,
  expectCreateWorkflowControllerInput,
  expectCreateWorktreeInput,
  expectCustomProviderConfig,
  expectCustomProviderProbeInput,
  expectForkThreadInput,
  expectHostUiResponse,
  expectMcpServerScope,
  expectModelSettingsScopeMode,
  expectNewMcpServerInput,
  expectNavigateSessionTreeOptions,
  expectNoInput,
  expectNonEmptyString,
  expectKanbanCardOpInput,
  expectNotificationPreferences,
  expectOptionalDeliverOptions,
  expectOptionalString,
  expectOptionalThinkingLevel,
  expectRemoveWorktreeInput,
  expectSendChildThreadFollowUpInput,
  expectSaveTaskWorkbenchTemplateInput,
  expectSetWorkflowTabsInput,
  expectSessionTarget,
  expectRecord,
  expectSetChildSupervisionLoopInput,
  expectSessionControlRequest,
  expectStartThreadInput,
  expectCreateScheduledTaskInput,
  expectUpdateScheduledTaskInput,
  expectString,
  expectStringArray,
  expectTerminalSize,
  expectThemeMode,
  expectThemePresetId,
  expectAppLanguage,
  expectCloseWindowBehavior,
  expectWorkflowControlCommandInput,
  expectWorkflowControlQueryInput,
  expectWorkflowPreflightInput,
  expectWorkflowRecipeDeleteInput,
  expectWorkflowRecipeSaveInput,
  expectWorkflowStartInput,
  expectWorkflowTemplateInstallInput,
  expectWorkflowTierSaveInput,
  expectThreadGrouping,
  expectThinkingLevel,
  expectWorkspaceFileListOptions,
  expectExtensionActionRequest,
} from "./request-validation";
import { runExtensionAction, type AppOperationHost } from "../extensions/app-operations";

type StateOwner = Pick<
  DesktopAppStore,
  | "getStateForView"
  | "getSelectedTranscriptForView"
  | "setActiveView"
  | "setSidebarCollapsed"
  | "setThreadGrouping"
  | "setWorkspaceCollapsed"
  | "setThemeMode"
  | "setThemePresetId"
>;

type WorkspaceOwner = Pick<
  DesktopAppStore,
  | "selectWorkspace"
  | "renameWorkspace"
  | "removeWorkspace"
  | "reorderWorkspaces"
  | "createWorktree"
  | "removeWorktree"
  | "syncCurrentWorkspace"
  | "getWorkspacePath"
  | "getWorkspaceRecords"
>;

type ConversationOwner = Pick<
  DesktopAppStore,
  | "reorderPinnedSessions"
  | "selectSession"
  | "renameSession"
  | "archiveSession"
  | "unarchiveSession"
  | "markSessionRead"
  | "setSessionPinned"
  | "createSession"
  | "createWorkflowController"
  | "setWorkflowTabs"
  | "activateWorkflowController"
  | "startThread"
  | "forkThread"
  | "cancelCurrentRun"
  | "addComposerAttachments"
  | "removeComposerAttachment"
  | "editQueuedComposerMessage"
  | "cancelQueuedComposerEdit"
  | "removeQueuedComposerMessage"
  | "steerQueuedComposerMessage"
  | "updateComposerDraft"
  | "submitComposer"
  | "composerSubmitNeedsSenderView"
  | "runExtensionCommand"
  | "reportExtensionActionFailure"
  | "getSessionTree"
  | "navigateSessionTree"
  | "respondToHostUiRequest"
  | "setSessionModel"
  | "setSessionThinkingLevel"
  | "withError"
>;

type OrchestrationOwner = Pick<
  DesktopAppStore,
  "sendChildThreadFollowUp" | "setChildSupervisionLoop"
>;

type ScheduledTaskOwner = Pick<
  DesktopAppStore,
  | "createScheduledTask"
  | "updateScheduledTask"
  | "deleteScheduledTask"
  | "beginScheduledTaskInterview"
>;

type SettingsOwner = Pick<
  DesktopAppStore,
  | "refreshRuntime"
  | "setModelSettingsScopeMode"
  | "setDefaultModel"
  | "setDefaultThinkingLevel"
  | "loginProvider"
  | "logoutProvider"
  | "setProviderApiKey"
  | "setEnableSkillCommands"
  | "listCustomProviders"
  | "setCustomProvider"
  | "deleteCustomProvider"
  | "setScopedModelPatterns"
  | "setSkillEnabled"
  | "setExtensionEnabled"
  | "listMcpServers"
  | "addMcpServer"
  | "removeMcpServer"
  | "setMcpServerEnabled"
  | "setCodemodeAlwaysOn"
  | "setNotificationPreferences"
  | "setIntegratedTerminalShell"
  | "setPaoHome"
  | "setCloseWindowBehavior"
  | "setEnableTransparency"
  | "setLanguage"
  | "getSkillFilePath"
  | "getExtensionFilePath"
>;

export interface DesktopIpcOwners {
  readonly state: StateOwner;
  readonly workbench: WorkbenchOwner;
  readonly review: ReviewRequestsOwner;
  readonly workboard: WorkboardRequestsOwner;
  readonly canvas: Pick<CanvasQuery, "collect" | "readNodeDetail">;
  readonly flowControl: Pick<FlowControlQuery, "collect" | "run">;
  readonly workflowWizard: Pick<
    WorkflowWizardBridge,
    | "collectCatalog"
    | "runPreflight"
    | "installTemplate"
    | "saveRecipe"
    | "deleteRecipe"
    | "startWorkflow"
    | "saveTier"
  >;
  readonly extensionViews: DesktopExtensionViewOwner;
  readonly workspace: WorkspaceOwner;
  readonly conversation: ConversationOwner;
  readonly orchestration: OrchestrationOwner;
  readonly scheduledTasks: ScheduledTaskOwner;
  readonly settings: SettingsOwner;
  readonly composerDraftFlush: Pick<PendingComposerDraftFlusher, "acknowledge" | "flush">;
  readonly workflowLeaveGuard: Pick<WorkflowLeaveGuard, "request" | "acknowledge">;
}

export interface DesktopIpcCapabilities {
  readonly ping: () => string;
  readonly theme: ThemeManager;
  readonly openExternal: (url: string) => Promise<void>;
  readonly pickWorkspace: (window: BrowserWindow) => Promise<DesktopAppState>;
  readonly createLoginCallbacks: (
    window: BrowserWindow,
  ) => Parameters<DesktopAppStore["loginProvider"]>[2];
  readonly probeCustomProviderModels: (
    input: CustomProviderProbeInput,
  ) => Promise<CustomProviderProbeResult>;
  readonly notificationPermission: () => NotificationPermissionService | undefined;
  readonly terminal: () => TerminalService;
  readonly optionalTerminal: () => TerminalService | undefined;
  readonly setTerminalFocused: (webContentsId: number, focused: boolean) => void;
  readonly setSidePanelFocused: (webContentsId: number, focused: boolean) => void;
  readonly setTransparency: (enabled: boolean) => void;
  readonly pickComposerAttachments: (
    window: BrowserWindow,
    existing?: readonly ComposerAttachment[],
  ) => Promise<readonly ComposerAttachment[] | undefined>;
  readonly readClipboardImage: () => ClipboardImageRead;
  readonly validateComposerAttachments: (
    attachments: readonly ComposerAttachment[],
  ) => readonly ComposerAttachment[];
  readonly listWorkspaceFiles: (
    workspacePath: string,
    options?: { readonly force?: boolean },
  ) => Promise<readonly unknown[]>;
  readonly readWorkspaceFile: (workspacePath: string, filePath: string) => Promise<unknown>;
  readonly revealWorkspaceFile: (workspacePath: string, filePath: string) => Promise<void>;
  readonly getChangedFiles: (workspacePath: string) => Promise<ChangedFilesResult>;
  readonly getFileDiff: (workspacePath: string, filePath: string) => Promise<string>;
  readonly stageFile: (
    workspacePath: string,
    filePath: string,
    options: { readonly sourcePath?: string },
  ) => Promise<void>;
  readonly relaunchApplication: () => void;
}

export interface RegisterDesktopIpcOptions {
  readonly windows: WindowOwner;
  readonly owners: DesktopIpcOwners;
  readonly capabilities: DesktopIpcCapabilities;
}

function senderWindow(windows: WindowOwner, event: IpcMainInvokeEvent): BrowserWindow {
  return windows.windowForSender(event.sender);
}

export function registerDesktopIpc({
  windows,
  owners,
  capabilities,
}: RegisterDesktopIpcOptions): void {
  const handleMainFrame = mainFrameHandler(windows);
  registerReviewRequests(handleMainFrame, owners.review);
  registerWorkboardRequests(handleMainFrame, owners.workboard);
  // 画布整页只读查询（P4-2）：与 workboard 同款零输入通道，unavailable 降级由结果自带。
  handleMainFrame(desktopIpc.getCanvas, expectNoInput, () => owners.canvas.collect());
  // D8d 节点详情（P4-4）：模板值 vs 卡面实际值深读；选择子由主进程重解析。
  handleMainFrame(desktopIpc.getCanvasNodeDetail, expectCanvasNodeDetailInput, (input) =>
    owners.canvas.readNodeDetail(input.instancePath, input.nodeName),
  );
  // 「查看卡」：主进程侧重读详情拿卡路径，复核是文件后交系统编辑器（不裸信渲染层路径）。
  handleMainFrame(desktopIpc.openCanvasCard, expectCanvasNodeDetailInput, async (input) => {
    const result = await owners.canvas.readNodeDetail(input.instancePath, input.nodeName);
    if (result.state === "failed") {
      return { ok: false as const, message: result.message };
    }
    if (!result.detail.card) {
      return { ok: false as const, message: tMain("This node has no card file yet.") };
    }
    const cardPath = result.detail.card.path;
    try {
      const info = await stat(cardPath);
      if (!info.isFile()) throw new Error(tMain("The card path is not a file."));
      await shell.openPath(cardPath);
      return { ok: true as const };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        ok: false as const,
        message: `${tMain("The card file could not be opened.")} ${reason}`,
      };
    }
  });
  // 看板（只读）：只收 workspaceId，project 由主进程从已登记 workspace 解析，不收渲染层路径；
  // home 取主进程当前生效的 PAO_HOME（设置页同步进该环境变量），未知 workspaceId 直接拒绝。
  const kanban = createKanbanQuery();
  handleMainFrame(
    desktopIpc.getKanban,
    (raw) => expectNonEmptyString(raw, "workspaceId"),
    async (workspaceId) => {
      const project = owners.workspace.getWorkspacePath(workspaceId);
      if (!project) {
        throw new Error(`Unknown workspace: ${workspaceId}`);
      }
      return kanban.collect(process.env.PAO_HOME ?? "", project);
    },
  );
  // 看板卡操作（S7-B）：只代「用户」执行取消。project 按已登记 workspace 解析，未知直接拒；
  // 卡路径复核（工作区内＋卡号一致）与内核状态机判权都在桥内，渲染层只提交意图。
  const kanbanCardOps = createKanbanCardOps();
  handleMainFrame(desktopIpc.kanbanCardOp, expectKanbanCardOpInput, async (input) => {
    const project = owners.workspace.getWorkspacePath(input.workspaceId);
    if (!project) {
      return { ok: false as const, message: `Unknown workspace: ${input.workspaceId}` };
    }
    return kanbanCardOps.run(project, input);
  });
  // 运行控制（P5，只读）：只收 workspaceId＋实例名，project 由主进程按登记表解析；
  // 控制身份读的是磁盘控制清单（readDesktopFlows），不收渲染层路径，也不缓存。
  const flowControl = createFlowControlQuery();
  handleMainFrame(desktopIpc.getWorkflowControl, expectWorkflowControlQueryInput, async (input) => {
    const project = owners.workspace.getWorkspacePath(input.workspaceId);
    if (!project) {
      return { state: "failed" as const, message: `Unknown workspace: ${input.workspaceId}` };
    }
    return flowControl.collect(project, input.instanceName, input.instancePath);
  });
  // 运行控制（确认/暂停推进/恢复）：先按磁盘真值复核实例/节点/轮次/owner，再直调内核
  // runDesktopFlowCommand；配方名、卡目录、原 owner 全部由主进程填充。
  // 「暂停」只暂停推进，不停在途进程；桌面桥没有停止入口，本模块不提供停止语义。
  handleMainFrame(desktopIpc.controlWorkflow, expectWorkflowControlCommandInput, async (input) => {
    const project = owners.workspace.getWorkspacePath(input.workspaceId);
    if (!project) {
      return { state: "error" as const, message: `Unknown workspace: ${input.workspaceId}` };
    }
    return flowControl.run(project, input);
  });
  // 启流向导（P4-3）：目录只读＋预检同源闸门＋三个会话内变更（owner 校验与 ui.confirm 在 fork 桥内）。
  // 信任边界（修复波2 P1）：渲染层传入的绝对路径不裸信——project 的合法来源就是主进程
  // 状态快照里的已登记 workspace 路径（渲染层 canvas-surface 取 workspace.path 回传），
  // 不落在任一已登记 workspace 根内即拒绝；内核侧 owner/revision 校验不因此放宽。
  const workspaceRoots = () => owners.workspace.getWorkspaceRecords().map((record) => record.path);
  const guardWizardProject = <T extends { readonly project: string }>(input: T): T => {
    if (!isPathInsideAnyRoot(input.project, workspaceRoots())) {
      throw new Error(`Unknown project: ${input.project}`);
    }
    return input;
  };
  // composer 附件的 file 类 fsPath 同一信任边界：渲染层合法来源＝workspace 文件列表（@提及）
  // 与原生文件选择器（主进程内直调）；拖拽落点经 webUtils 桥可以携带根外路径，此处
  // 拒绝并给出「用回形针选择发送」的用户指引（越界路径不进会话，否则被攻陷的渲染层
  // 可借附件前奏块让代理读取任意文件）。
  const guardComposerAttachments = (
    attachments: readonly ComposerAttachment[] | undefined,
  ): void => {
    if (!attachments?.length) return;
    const roots = workspaceRoots();
    for (const attachment of attachments)
      if (attachment.kind === "file" && !isPathInsideAnyRoot(attachment.fsPath, roots)) {
        // 用户可见文案（波2b P2）：拖根外文件是既有合法操作被守卫拦下，错误必须指路
        // （回形针＝原生选择器，路径不经渲染层），不能只吐内部路径。
        throw new Error(
          `${tMain(
            "Files outside the workspace cannot be dropped in. Use the paperclip to pick and send them.",
          )} (${attachment.fsPath})`,
        );
      }
  };
  handleMainFrame(desktopIpc.getWorkflowCatalog, expectNoInput, () =>
    owners.workflowWizard.collectCatalog(),
  );
  handleMainFrame(desktopIpc.runWorkflowPreflight, expectWorkflowPreflightInput, (input) =>
    owners.workflowWizard.runPreflight(guardWizardProject(input)),
  );
  handleMainFrame(desktopIpc.installWorkflowTemplate, expectWorkflowTemplateInstallInput, (input) =>
    owners.workflowWizard.installTemplate(guardWizardProject(input)),
  );
  handleMainFrame(desktopIpc.saveWorkflowRecipe, expectWorkflowRecipeSaveInput, (input) =>
    owners.workflowWizard.saveRecipe(guardWizardProject(input)),
  );
  handleMainFrame(desktopIpc.deleteWorkflowRecipe, expectWorkflowRecipeDeleteInput, (input) =>
    owners.workflowWizard.deleteRecipe(guardWizardProject(input)),
  );
  handleMainFrame(desktopIpc.startWorkflow, expectWorkflowStartInput, (input) =>
    owners.workflowWizard.startWorkflow(guardWizardProject(input)),
  );
  // S9-2 档位管理：增改一档直写 pao配置/档位.json（内核备份＋原子写；深度校验在内核）。
  handleMainFrame(desktopIpc.saveWorkflowTier, expectWorkflowTierSaveInput, (input) =>
    owners.workflowWizard.saveTier(input),
  );
  registerExtensionViewRequests(handleMainFrame, windows, owners.extensionViews);
  const workbench = new WorkbenchRequests(owners.workbench);
  const workbenchSenders = new WeakSet<Electron.WebContents>();
  const trackWorkbenchSender = (sender: Electron.WebContents) => {
    if (!workbenchSenders.has(sender)) {
      workbenchSenders.add(sender);
      sender.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) workbench.resetRenderer(sender);
      });
      sender.once("destroyed", () => workbench.resetRenderer(sender));
    }
    return sender;
  };
  handleMainFrame(desktopIpc.getTaskWorkbenchTemplate, expectSessionTarget, (target, request) => {
    trackWorkbenchSender(request.contents);
    return workbench.get(target);
  });
  handleMainFrame(
    desktopIpc.saveTaskWorkbenchTemplate,
    expectSaveTaskWorkbenchTemplateInput,
    (input, request) => workbench.save(trackWorkbenchSender(request.contents), input),
  );
  const run = (event: IpcMainInvokeEvent, action: () => Promise<DesktopAppState>) =>
    windows.runStateAction(senderWindow(windows, event), action);
  const runLeavingWorkflow = async (
    event: IpcMainInvokeEvent,
    action: () => Promise<DesktopAppState>,
  ) => {
    // 在队列外等保存，避免保存自身也进队列而相互等待。
    if (
      windows.viewForSender(event.sender).activeView === "canvas" &&
      !(await owners.workflowLeaveGuard.request(senderWindow(windows, event)))
    ) {
      return owners.state.getStateForView(windows.viewForSender(event.sender));
    }
    return run(event, action);
  };
  handleMainFrame(
    desktopIpc.createWorkflowController,
    expectCreateWorkflowControllerInput,
    (input, { event }) => run(event, () => owners.conversation.createWorkflowController(input)),
  );
  ipcMain.handle(desktopIpc.setWorkflowTabs, (event, rawInput: unknown) =>
    run(event, () => owners.conversation.setWorkflowTabs(expectSetWorkflowTabsInput(rawInput))),
  );
  // 画布内切 controller 不走 runLeavingWorkflow：没有离开画布，不该弹未保存确认。
  ipcMain.handle(desktopIpc.activateWorkflowController, (event, rawTarget: unknown) =>
    run(event, () =>
      owners.conversation.activateWorkflowController(expectSessionTarget(rawTarget)),
    ),
  );
  const immediate = (event: IpcMainInvokeEvent, action: () => Promise<DesktopAppState>) =>
    windows.runImmediateStateAction(senderWindow(windows, event), action);
  const reportLimit = (event: IpcMainInvokeEvent, error: ComposerAttachmentLimitError) =>
    run(event, () => owners.conversation.withError(error));
  const runCatchingLimits = async (
    event: IpcMainInvokeEvent,
    action: () => Promise<DesktopAppState>,
  ): Promise<DesktopAppState> => {
    try {
      return await action();
    } catch (error) {
      if (error instanceof ComposerAttachmentLimitError) {
        return reportLimit(event, error);
      }
      throw error;
    }
  };

  ipcMain.handle(desktopIpc.ping, (event) => {
    windows.windowForSender(event.sender);
    return capabilities.ping();
  });
  ipcMain.handle(desktopIpc.getThemeMode, (event) => {
    windows.windowForSender(event.sender);
    return capabilities.theme.getMode();
  });
  ipcMain.handle(desktopIpc.getResolvedTheme, (event) => {
    windows.windowForSender(event.sender);
    return capabilities.theme.getResolvedTheme();
  });
  ipcMain.handle(desktopIpc.setThemeMode, (event, rawMode: unknown) => {
    windows.windowForSender(event.sender);
    const mode = expectThemeMode(rawMode);
    capabilities.theme.setMode(mode);
    return run(event, () => owners.state.setThemeMode(mode));
  });
  ipcMain.handle(desktopIpc.setThemePresetId, (event, rawPresetId: unknown) => {
    const presetId = expectThemePresetId(rawPresetId);
    return run(event, () => owners.state.setThemePresetId(presetId));
  });
  ipcMain.handle(desktopIpc.openExternal, (event, rawUrl: unknown) => {
    windows.windowForSender(event.sender);
    return capabilities.openExternal(expectString(rawUrl, "url"));
  });
  ipcMain.handle(desktopIpc.relaunchApplication, (event) => {
    windows.windowForSender(event.sender);
    capabilities.relaunchApplication();
  });
  ipcMain.handle(desktopIpc.stateRequest, (event) =>
    owners.state.getStateForView(windows.viewForSender(event.sender)),
  );
  ipcMain.handle(desktopIpc.selectedTranscriptRequest, (event) =>
    owners.state.getSelectedTranscriptForView(windows.viewForSender(event.sender)),
  );

  // 工作区登记只有主进程入口（pickWorkspace 对话框 / 启动 initial workspaces）：
  // 渲染层直传任意路径的 addWorkspacePath 通道已删（波2b P1，攻陷渲染层可先登记 C:\ 放行
  // 全部路径守卫），测试走 __PI_APP_TEST_HOOKS.addWorkspace 注入。
  ipcMain.handle(desktopIpc.pickWorkspace, (event) =>
    capabilities.pickWorkspace(senderWindow(windows, event)),
  );
  ipcMain.handle(desktopIpc.selectWorkspace, (event, rawWorkspaceId: unknown) =>
    runLeavingWorkflow(event, () =>
      owners.workspace.selectWorkspace(expectNonEmptyString(rawWorkspaceId, "workspaceId")),
    ),
  );
  ipcMain.handle(
    desktopIpc.renameWorkspace,
    (event, rawWorkspaceId: unknown, rawDisplayName: unknown) =>
      run(event, () =>
        owners.workspace.renameWorkspace(
          expectNonEmptyString(rawWorkspaceId, "workspaceId"),
          expectString(rawDisplayName, "displayName"),
        ),
      ),
  );
  ipcMain.handle(desktopIpc.removeWorkspace, (event, rawWorkspaceId: unknown) => {
    const workspaceId = expectNonEmptyString(rawWorkspaceId, "workspaceId");
    const action = () => owners.workspace.removeWorkspace(workspaceId);
    return windows.viewForSender(event.sender).selectedWorkspaceId === workspaceId
      ? runLeavingWorkflow(event, action)
      : run(event, action);
  });
  ipcMain.handle(desktopIpc.reorderWorkspaces, (event, rawOrder: unknown) =>
    run(event, () => owners.workspace.reorderWorkspaces(expectStringArray(rawOrder, "order"))),
  );
  ipcMain.handle(desktopIpc.reorderPinnedSessions, (event, rawOrder: unknown) =>
    run(event, () =>
      owners.conversation.reorderPinnedSessions(expectStringArray(rawOrder, "order")),
    ),
  );
  ipcMain.handle(desktopIpc.openWorkspaceInFinder, async (event, rawWorkspaceId: unknown) => {
    windows.windowForSender(event.sender);
    const workspaceId = expectNonEmptyString(rawWorkspaceId, "workspaceId");
    const workspacePath = owners.workspace.getWorkspacePath(workspaceId);
    if (!workspacePath) {
      throw new Error(`Unknown workspace: ${workspaceId}`);
    }
    await shell.openPath(workspacePath);
  });
  ipcMain.handle(desktopIpc.createWorktree, (event, rawInput: unknown) =>
    run(event, () => owners.workspace.createWorktree(expectCreateWorktreeInput(rawInput))),
  );
  ipcMain.handle(desktopIpc.removeWorktree, (event, rawInput: unknown) =>
    run(event, () => owners.workspace.removeWorktree(expectRemoveWorktreeInput(rawInput))),
  );
  ipcMain.handle(desktopIpc.syncCurrentWorkspace, (event) =>
    run(event, () => owners.workspace.syncCurrentWorkspace()),
  );

  ipcMain.handle(desktopIpc.selectSession, (event, rawTarget: unknown) => {
    const target = expectSessionTarget(rawTarget);
    return runLeavingWorkflow(event, () => owners.conversation.selectSession(target));
  });
  ipcMain.handle(desktopIpc.renameSession, (event, rawTarget: unknown, rawTitle: unknown) => {
    const target = expectSessionTarget(rawTarget);
    const title = expectString(rawTitle, "title");
    return run(event, () => owners.conversation.renameSession(target, title));
  });
  ipcMain.handle(desktopIpc.archiveSession, (event, rawTarget: unknown) => {
    const target = expectSessionTarget(rawTarget);
    const view = windows.viewForSender(event.sender);
    const action = () => owners.conversation.archiveSession(target);
    return view.selectedWorkspaceId === target.workspaceId &&
      view.selectedSessionId === target.sessionId
      ? runLeavingWorkflow(event, action)
      : run(event, action);
  });
  ipcMain.handle(desktopIpc.unarchiveSession, (event, rawTarget: unknown) => {
    const target = expectSessionTarget(rawTarget);
    return run(event, () => owners.conversation.unarchiveSession(target));
  });
  ipcMain.handle(desktopIpc.markSessionRead, (event, rawTarget: unknown) => {
    const target = expectSessionTarget(rawTarget);
    return run(event, () => owners.conversation.markSessionRead(target));
  });
  ipcMain.handle(desktopIpc.setSessionPinned, (event, rawTarget: unknown, rawPinned: unknown) => {
    const target = expectSessionTarget(rawTarget);
    const pinned = expectBoolean(rawPinned, "pinned");
    // Pin metadata has an explicit target and must not wait for an active prompt to finish.
    return immediate(event, () => owners.conversation.setSessionPinned(target, pinned));
  });
  ipcMain.handle(desktopIpc.setActiveView, (event, rawView: unknown) => {
    const view = expectAppView(rawView);
    return view === "canvas"
      ? run(event, () => owners.state.setActiveView(view))
      : runLeavingWorkflow(event, () => owners.state.setActiveView(view));
  });
  ipcMain.handle(desktopIpc.setSidebarCollapsed, (event, rawCollapsed: unknown) =>
    run(event, () => owners.state.setSidebarCollapsed(expectBoolean(rawCollapsed, "collapsed"))),
  );
  ipcMain.handle(desktopIpc.setThreadGrouping, (event, rawGrouping: unknown) =>
    run(event, () => owners.state.setThreadGrouping(expectThreadGrouping(rawGrouping))),
  );
  ipcMain.handle(
    desktopIpc.setWorkspaceCollapsed,
    (event, rawWorkspaceId: unknown, rawCollapsed: unknown) => {
      const workspaceId = expectNonEmptyString(rawWorkspaceId, "workspaceId");
      const collapsed = expectBoolean(rawCollapsed, "collapsed");
      return run(event, () => owners.state.setWorkspaceCollapsed(workspaceId, collapsed));
    },
  );

  ipcMain.handle(desktopIpc.refreshRuntime, (event, rawWorkspaceId: unknown) =>
    run(event, () =>
      owners.settings.refreshRuntime(expectOptionalString(rawWorkspaceId, "workspaceId")),
    ),
  );
  ipcMain.handle(desktopIpc.setModelSettingsScopeMode, (event, rawMode: unknown) => {
    const mode = expectModelSettingsScopeMode(rawMode);
    return run(event, () => owners.settings.setModelSettingsScopeMode(mode));
  });
  ipcMain.handle(
    desktopIpc.setSessionModel,
    (
      event,
      rawWorkspaceId: unknown,
      rawSessionId: unknown,
      rawProvider: unknown,
      rawModel: unknown,
    ) =>
      run(event, () =>
        owners.conversation.setSessionModel(
          {
            workspaceId: expectNonEmptyString(rawWorkspaceId, "workspaceId"),
            sessionId: expectNonEmptyString(rawSessionId, "sessionId"),
          },
          expectNonEmptyString(rawProvider, "provider"),
          expectNonEmptyString(rawModel, "modelId"),
        ),
      ),
  );
  ipcMain.handle(
    desktopIpc.setDefaultModel,
    (event, rawWorkspaceId: unknown, rawProvider: unknown, rawModel: unknown) =>
      run(event, () =>
        owners.settings.setDefaultModel(
          expectNonEmptyString(rawWorkspaceId, "workspaceId"),
          expectNonEmptyString(rawProvider, "provider"),
          expectNonEmptyString(rawModel, "modelId"),
        ),
      ),
  );
  ipcMain.handle(
    desktopIpc.setDefaultThinkingLevel,
    (event, rawWorkspaceId: unknown, thinkingLevel: unknown) =>
      run(event, () =>
        owners.settings.setDefaultThinkingLevel(
          expectNonEmptyString(rawWorkspaceId, "workspaceId"),
          expectOptionalThinkingLevel(thinkingLevel),
        ),
      ),
  );
  ipcMain.handle(
    desktopIpc.setSessionThinkingLevel,
    (event, rawWorkspaceId: unknown, rawSessionId: unknown, thinkingLevel: unknown) =>
      run(event, () =>
        owners.conversation.setSessionThinkingLevel(
          {
            workspaceId: expectNonEmptyString(rawWorkspaceId, "workspaceId"),
            sessionId: expectNonEmptyString(rawSessionId, "sessionId"),
          },
          expectThinkingLevel(thinkingLevel),
        ),
      ),
  );
  ipcMain.handle(
    desktopIpc.loginProvider,
    (event, rawWorkspaceId: unknown, rawProviderId: unknown) => {
      const window = senderWindow(windows, event);
      return windows.runUnscopedStateAction(window, () =>
        owners.settings.loginProvider(
          expectNonEmptyString(rawWorkspaceId, "workspaceId"),
          expectNonEmptyString(rawProviderId, "providerId"),
          capabilities.createLoginCallbacks(window),
        ),
      );
    },
  );
  ipcMain.handle(
    desktopIpc.logoutProvider,
    (event, rawWorkspaceId: unknown, rawProviderId: unknown) =>
      run(event, () =>
        owners.settings.logoutProvider(
          expectNonEmptyString(rawWorkspaceId, "workspaceId"),
          expectNonEmptyString(rawProviderId, "providerId"),
        ),
      ),
  );
  ipcMain.handle(
    desktopIpc.setProviderApiKey,
    (event, rawWorkspaceId: unknown, rawProviderId: unknown, rawApiKey: unknown) =>
      run(event, () =>
        owners.settings.setProviderApiKey(
          expectNonEmptyString(rawWorkspaceId, "workspaceId"),
          expectNonEmptyString(rawProviderId, "providerId"),
          expectString(rawApiKey, "apiKey"),
        ),
      ),
  );
  ipcMain.handle(
    desktopIpc.setEnableSkillCommands,
    (event, rawWorkspaceId: unknown, rawEnabled: unknown) =>
      run(event, () =>
        owners.settings.setEnableSkillCommands(
          expectNonEmptyString(rawWorkspaceId, "workspaceId"),
          expectBoolean(rawEnabled, "enabled"),
        ),
      ),
  );
  ipcMain.handle(desktopIpc.listCustomProviders, (event) => {
    windows.windowForSender(event.sender);
    return owners.settings.listCustomProviders();
  });
  ipcMain.handle(
    desktopIpc.setCustomProvider,
    (event, rawWorkspaceId: unknown, rawConfig: unknown) =>
      run(event, () =>
        owners.settings.setCustomProvider(
          expectNonEmptyString(rawWorkspaceId, "workspaceId"),
          expectCustomProviderConfig(rawConfig),
        ),
      ),
  );
  ipcMain.handle(
    desktopIpc.deleteCustomProvider,
    (event, rawWorkspaceId: unknown, rawProviderId: unknown) =>
      run(event, () =>
        owners.settings.deleteCustomProvider(
          expectNonEmptyString(rawWorkspaceId, "workspaceId"),
          expectNonEmptyString(rawProviderId, "providerId"),
        ),
      ),
  );
  ipcMain.handle(desktopIpc.probeCustomProviderModels, (event, rawInput: unknown) => {
    windows.windowForSender(event.sender);
    return capabilities.probeCustomProviderModels(expectCustomProviderProbeInput(rawInput));
  });
  ipcMain.handle(
    desktopIpc.setScopedModelPatterns,
    (event, rawWorkspaceId: unknown, rawPatterns: unknown) =>
      run(event, () =>
        owners.settings.setScopedModelPatterns(
          expectNonEmptyString(rawWorkspaceId, "workspaceId"),
          expectStringArray(rawPatterns, "patterns"),
        ),
      ),
  );
  ipcMain.handle(
    desktopIpc.setSkillEnabled,
    (event, rawWorkspaceId: unknown, rawFilePath: unknown, rawEnabled: unknown) =>
      run(event, () =>
        owners.settings.setSkillEnabled(
          expectNonEmptyString(rawWorkspaceId, "workspaceId"),
          expectNonEmptyString(rawFilePath, "filePath"),
          expectBoolean(rawEnabled, "enabled"),
        ),
      ),
  );
  ipcMain.handle(
    desktopIpc.setExtensionEnabled,
    (event, rawWorkspaceId: unknown, rawFilePath: unknown, rawEnabled: unknown) =>
      run(event, () =>
        owners.settings.setExtensionEnabled(
          expectNonEmptyString(rawWorkspaceId, "workspaceId"),
          expectNonEmptyString(rawFilePath, "filePath"),
          expectBoolean(rawEnabled, "enabled"),
        ),
      ),
  );
  ipcMain.handle(desktopIpc.listMcpServers, (event, rawWorkspaceId: unknown) => {
    windows.windowForSender(event.sender);
    return owners.settings.listMcpServers(expectNonEmptyString(rawWorkspaceId, "workspaceId"));
  });
  ipcMain.handle(desktopIpc.addMcpServer, (event, rawWorkspaceId: unknown, rawServer: unknown) =>
    run(event, () =>
      owners.settings.addMcpServer(
        expectNonEmptyString(rawWorkspaceId, "workspaceId"),
        expectNewMcpServerInput(rawServer),
      ),
    ),
  );
  ipcMain.handle(desktopIpc.removeMcpServer, (event, rawWorkspaceId: unknown, rawName: unknown) =>
    run(event, () =>
      owners.settings.removeMcpServer(
        expectNonEmptyString(rawWorkspaceId, "workspaceId"),
        expectNonEmptyString(rawName, "name"),
      ),
    ),
  );
  ipcMain.handle(
    desktopIpc.setMcpServerEnabled,
    (event, rawWorkspaceId: unknown, rawScope: unknown, rawName: unknown, rawEnabled: unknown) =>
      run(event, () =>
        owners.settings.setMcpServerEnabled(
          expectNonEmptyString(rawWorkspaceId, "workspaceId"),
          expectMcpServerScope(rawScope),
          expectNonEmptyString(rawName, "name"),
          expectBoolean(rawEnabled, "enabled"),
        ),
      ),
  );
  ipcMain.handle(
    desktopIpc.setCodemodeAlwaysOn,
    (event, rawWorkspaceId: unknown, rawAlwaysOn: unknown) =>
      run(event, () =>
        owners.settings.setCodemodeAlwaysOn(
          expectNonEmptyString(rawWorkspaceId, "workspaceId"),
          expectBoolean(rawAlwaysOn, "alwaysOn"),
        ),
      ),
  );
  ipcMain.handle(
    desktopIpc.respondToHostUiRequest,
    (event, rawWorkspaceId: unknown, rawSessionId: unknown, rawResponse: unknown) =>
      immediate(event, () =>
        owners.conversation.respondToHostUiRequest(
          {
            workspaceId: expectNonEmptyString(rawWorkspaceId, "workspaceId"),
            sessionId: expectNonEmptyString(rawSessionId, "sessionId"),
          },
          expectHostUiResponse(rawResponse),
        ),
      ),
  );
  ipcMain.handle(desktopIpc.setNotificationPreferences, (event, rawPreferences: unknown) =>
    run(event, () =>
      owners.settings.setNotificationPreferences(expectNotificationPreferences(rawPreferences)),
    ),
  );
  ipcMain.handle(desktopIpc.setIntegratedTerminalShell, (event, rawShellPath: unknown) =>
    run(event, () =>
      owners.settings.setIntegratedTerminalShell(expectString(rawShellPath, "shellPath")),
    ),
  );
  ipcMain.handle(desktopIpc.setPaoHome, (event, rawPaoHome: unknown) =>
    run(event, () => owners.settings.setPaoHome(expectString(rawPaoHome, "paoHome"))),
  );
  ipcMain.handle(desktopIpc.setCloseWindowBehavior, (event, rawBehavior: unknown) =>
    run(event, () =>
      owners.settings.setCloseWindowBehavior(expectCloseWindowBehavior(rawBehavior)),
    ),
  );
  ipcMain.handle(desktopIpc.setEnableTransparency, async (event, rawEnabled: unknown) => {
    const window = senderWindow(windows, event);
    const enabled = expectBoolean(rawEnabled, "enabled");
    return windows.runUnscopedStateAction(window, async () => {
      const state = await owners.settings.setEnableTransparency(enabled);
      capabilities.setTransparency(enabled);
      return state;
    });
  });
  ipcMain.handle(desktopIpc.setLanguage, (event, rawLanguage: unknown) =>
    run(event, () => owners.settings.setLanguage(expectAppLanguage(rawLanguage))),
  );

  registerTerminalIpc(windows, capabilities);

  ipcMain.handle(desktopIpc.getNotificationPermissionStatus, (event) => {
    windows.windowForSender(event.sender);
    return capabilities.notificationPermission()?.getCurrentStatus() ?? Promise.resolve("unknown");
  });
  ipcMain.handle(desktopIpc.requestNotificationPermission, (event) => {
    windows.windowForSender(event.sender);
    return capabilities.notificationPermission()?.requestPermission() ?? Promise.resolve("unknown");
  });
  ipcMain.handle(desktopIpc.openSystemNotificationSettings, (event) => {
    windows.windowForSender(event.sender);
    return capabilities.notificationPermission()?.openSystemSettings() ?? Promise.resolve();
  });

  ipcMain.handle(desktopIpc.createSession, (event, rawInput: unknown) =>
    runLeavingWorkflow(event, () =>
      owners.conversation.createSession(expectCreateSessionInput(rawInput)),
    ),
  );
  ipcMain.handle(desktopIpc.startThread, (event, rawInput: unknown) => {
    const input = expectStartThreadInput(rawInput);
    if (input.attachments?.length) {
      assertComposerAttachmentPixels(input.attachments);
      guardComposerAttachments(input.attachments);
    }
    return runLeavingWorkflow(event, () => owners.conversation.startThread(input));
  });
  ipcMain.handle(desktopIpc.forkThread, (event, rawInput: unknown) =>
    run(event, () => owners.conversation.forkThread(expectForkThreadInput(rawInput))),
  );
  ipcMain.handle(desktopIpc.sendChildThreadFollowUp, (event, rawInput: unknown) =>
    run(event, () =>
      owners.orchestration.sendChildThreadFollowUp(expectSendChildThreadFollowUpInput(rawInput)),
    ),
  );
  ipcMain.handle(desktopIpc.setChildSupervisionLoop, (event, rawInput: unknown) =>
    run(event, () =>
      owners.orchestration.setChildSupervisionLoop(expectSetChildSupervisionLoopInput(rawInput)),
    ),
  );
  ipcMain.handle(desktopIpc.createScheduledTask, (event, rawInput: unknown) =>
    run(event, () =>
      owners.scheduledTasks.createScheduledTask(expectCreateScheduledTaskInput(rawInput)),
    ),
  );
  ipcMain.handle(desktopIpc.updateScheduledTask, (event, rawId: unknown, rawPatch: unknown) =>
    run(event, () =>
      owners.scheduledTasks.updateScheduledTask(
        expectNonEmptyString(rawId, "id"),
        expectUpdateScheduledTaskInput(rawPatch),
      ),
    ),
  );
  ipcMain.handle(desktopIpc.deleteScheduledTask, (event, rawId: unknown) =>
    run(event, () => owners.scheduledTasks.deleteScheduledTask(expectNonEmptyString(rawId, "id"))),
  );
  ipcMain.handle(desktopIpc.beginScheduledTaskInterview, (event) =>
    run(event, () => owners.scheduledTasks.beginScheduledTaskInterview()),
  );
  ipcMain.handle(
    desktopIpc.openSkillInFinder,
    (event, rawWorkspaceId: unknown, rawFilePath: unknown) => {
      windows.windowForSender(event.sender);
      return openOwnedFileInFinder(
        owners.settings.getSkillFilePath(
          expectNonEmptyString(rawWorkspaceId, "workspaceId"),
          expectNonEmptyString(rawFilePath, "filePath"),
        ),
        expectString(rawFilePath, "filePath"),
        "skill",
      );
    },
  );
  ipcMain.handle(
    desktopIpc.openExtensionInFinder,
    (event, rawWorkspaceId: unknown, rawFilePath: unknown) => {
      windows.windowForSender(event.sender);
      return openOwnedFileInFinder(
        owners.settings.getExtensionFilePath(
          expectNonEmptyString(rawWorkspaceId, "workspaceId"),
          expectNonEmptyString(rawFilePath, "filePath"),
        ),
        expectString(rawFilePath, "filePath"),
        "extension",
      );
    },
  );

  ipcMain.handle(desktopIpc.cancelCurrentRun, (event) => {
    const target = windows.targetForSender(event.sender);
    // A long slash command can still own the serialized action queue.
    // Stop must bypass that queue and cancel the captured target immediately.
    return immediate(event, () => owners.conversation.cancelCurrentRun(target));
  });
  // The one control entry (设计包-控制入口五态)：send/dispatch/confirm 复用旧
  // submitComposer 通道的「可能改选中的命令文本才进串行队列」规则（普通 prompt 在
  // 驱动层 await 整个 turn，占住队列会让所有走队列的按钮在整个 run 期间无响应），
  // cancel 保留 immediate 捷径语义，query 只读；主进程按 (target, requestId)
  // 记账，重复请求返回首账不重发。旧通道保留为内部实现，本期不拆。
  const sessionControl = createSessionControlCoordinator({
    submitComposer: (target, text, options) =>
      owners.conversation.submitComposer(target, text, options),
    addComposerAttachments: (target, attachments) =>
      owners.conversation.addComposerAttachments(target, attachments),
    cancelCurrentRun: (target) => owners.conversation.cancelCurrentRun(target),
  });
  ipcMain.handle(desktopIpc.sessionControl, (event, rawRequest: unknown) => {
    const window = senderWindow(windows, event);
    const request = expectSessionControlRequest(rawRequest);
    if (request.action.kind === "send") {
      guardComposerAttachments(request.action.attachments);
    }
    // 队列分流（sessionControlQueueLane）：普通 prompt 在驱动层 await 整个 turn，
    // 绝不能占住窗口串行动作队列——否则一次发送就把队列占死整个 run 时长，期间所有
    // 走队列的按钮全部无响应（真机 P0：对话进行中点任何按钮都没反应）。规则与注释
    // 见 session-control.ts 与 desktopIpc.submitComposer 处。
    const lane = sessionControlQueueLane(request, (target, text) =>
      owners.conversation.composerSubmitNeedsSenderView(target, text),
    );
    const runQueued = (action: () => Promise<DesktopAppState>) =>
      lane === "queued"
        ? windows.runStateAction(window, action)
        : windows.runImmediateStateAction(window, action);
    return sessionControl.handle(request, {
      runQueued,
      runNow: (action) => windows.runImmediateStateAction(window, action),
      readState: () => windows.stateForWindow(window),
    });
  });
  ipcMain.handle(desktopIpc.pickComposerAttachments, (event) =>
    runCatchingLimits(event, async () => {
      const window = senderWindow(windows, event);
      const target = windows.targetForSender(event.sender);
      const existing = (await windows.stateForWindow(window)).composerAttachments ?? [];
      const attachments = await capabilities.pickComposerAttachments(window, existing);
      if (!attachments?.length) {
        return windows.stateForWindow(window);
      }
      assertComposerAttachmentPixels(attachments);
      return windows.runStateAction(window, () =>
        owners.conversation.addComposerAttachments(target, attachments),
      );
    }),
  );
  ipcMain.on(desktopIpc.readClipboardImage, (event) => {
    windows.windowForSender(event.sender);
    event.returnValue = capabilities.readClipboardImage();
  });
  ipcMain.handle(desktopIpc.addComposerAttachments, (event, rawAttachments: unknown) =>
    runCatchingLimits(event, () => {
      const target = windows.targetForSender(event.sender);
      const attachments = capabilities.validateComposerAttachments(
        expectComposerAttachments(rawAttachments),
      );
      guardComposerAttachments(attachments);
      assertComposerAttachmentPixels(attachments);
      return run(event, () => owners.conversation.addComposerAttachments(target, attachments));
    }),
  );
  ipcMain.handle(desktopIpc.removeComposerAttachment, (event, rawAttachmentId: unknown) => {
    const target = windows.targetForSender(event.sender);
    return run(event, () =>
      owners.conversation.removeComposerAttachment(
        target,
        expectNonEmptyString(rawAttachmentId, "attachmentId"),
      ),
    );
  });
  ipcMain.handle(
    desktopIpc.editQueuedComposerMessage,
    (event, rawMessageId: unknown, rawCurrentDraft: unknown) => {
      const target = windows.targetForSender(event.sender);
      return run(event, () =>
        owners.conversation.editQueuedComposerMessage(
          target,
          expectNonEmptyString(rawMessageId, "messageId"),
          expectOptionalString(rawCurrentDraft, "currentDraft"),
        ),
      );
    },
  );
  ipcMain.handle(desktopIpc.cancelQueuedComposerEdit, (event) => {
    const target = windows.targetForSender(event.sender);
    return run(event, () => owners.conversation.cancelQueuedComposerEdit(target));
  });
  ipcMain.handle(desktopIpc.removeQueuedComposerMessage, (event, rawMessageId: unknown) => {
    const target = windows.targetForSender(event.sender);
    return run(event, () =>
      owners.conversation.removeQueuedComposerMessage(
        target,
        expectNonEmptyString(rawMessageId, "messageId"),
      ),
    );
  });
  ipcMain.handle(desktopIpc.steerQueuedComposerMessage, (event, rawMessageId: unknown) => {
    const target = windows.targetForSender(event.sender);
    return run(event, () =>
      owners.conversation.steerQueuedComposerMessage(
        target,
        expectNonEmptyString(rawMessageId, "messageId"),
      ),
    );
  });
  handleMainFrame(
    desktopIpc.persistComposerDraft,
    (raw) => {
      const input = expectRecord(raw, "composer draft");
      return {
        target: expectSessionTarget(input.target),
        draft: expectString(input.draft, "draft"),
      };
    },
    async ({ target, draft }, { event, window }) => {
      const state = await owners.state.getStateForView(windows.viewForWindow(window));
      if (
        !state.workspaces.some(
          (workspace) =>
            workspace.id === target.workspaceId &&
            workspace.sessions.some((session) => session.id === target.sessionId),
        )
      ) {
        throw new Error("The draft's task is unavailable");
      }
      await windows.withComposerDraftPersistOrigin(event.sender, () =>
        owners.conversation.updateComposerDraft(target, draft),
      );
    },
  );
  handleMainFrame(
    desktopIpc.pendingComposerDraftFlushed,
    (raw) => {
      if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1)
        throw new TypeError("requestId must be a positive integer");
      return raw;
    },
    (requestId, { contents }) => owners.composerDraftFlush.acknowledge(contents, requestId),
  );
  handleMainFrame(
    desktopIpc.workflowLeaveResolved,
    (raw) => {
      const input = expectRecord(raw, "workflowLeaveResolved");
      if (
        typeof input.requestId !== "number" ||
        !Number.isSafeInteger(input.requestId) ||
        input.requestId < 1
      )
        throw new TypeError("requestId must be a positive integer");
      return { requestId: input.requestId, allowed: expectBoolean(input.allowed, "allowed") };
    },
    (input, { contents }) =>
      owners.workflowLeaveGuard.acknowledge(contents, input.requestId, input.allowed),
  );
  ipcMain.handle(desktopIpc.updateComposerDraft, (event, rawDraft: unknown, rawTarget: unknown) => {
    // A debounced write can arrive after the window selected another task, so it names its own.
    const target = expectSessionTarget(rawTarget);
    return run(event, () =>
      windows.withComposerDraftPersistOrigin(event.sender, () =>
        owners.conversation.updateComposerDraft(target, expectString(rawDraft, "composerDraft")),
      ),
    );
  });
  ipcMain.handle(desktopIpc.submitComposer, (event, rawText: unknown, rawOptions: unknown) => {
    const target = windows.targetForSender(event.sender);
    const text = expectString(rawText, "text");
    const options = expectOptionalDeliverOptions(rawOptions);
    // Ordinary prompts, skills and prompt templates target a captured session and may await
    // the entire turn. Keep that wait outside the window queue so selection and other windows
    // stay usable. Local and extension commands can change selection (for example an
    // extension creating a child session), so retain their serialized sender-view context.
    const dispatch = owners.conversation.composerSubmitNeedsSenderView(target, text)
      ? run
      : immediate;
    return dispatch(event, () => owners.conversation.submitComposer(target, text, options));
  });
  // Card buttons carry extension-authored data, so only the app's own frame may send them.
  handleMainFrame(
    desktopIpc.runExtensionAction,
    expectExtensionActionRequest,
    async ({ target, action }, { event }) => {
      // Main may have switched threads before the renderer redrew; never act on another one.
      const requireCardThread = () => {
        const selected = windows.targetForSender(event.sender);
        if (
          selected?.workspaceId !== target.workspaceId ||
          selected.sessionId !== target.sessionId
        ) {
          throw new Error("Return to the card's thread to use its buttons");
        }
      };
      requireCardThread();
      // A switch drops the composer's debounced draft, so save it first. Outside the queue:
      // the save itself goes through it.
      const saveDraftBeforeSwitch = () =>
        owners.composerDraftFlush.flush([senderWindow(windows, event)]);
      const host: AppOperationHost = {
        workspacePath: (workspaceId) => owners.workspace.getWorkspacePath(workspaceId),
        openExternal: capabilities.openExternal,
        // Like a typed extension command, it may change selection, so it keeps the window's queue,
        // and checks the thread again once its turn in that queue comes.
        runExtensionCommand: async (sessionRef, command) => {
          await saveDraftBeforeSwitch();
          await run(event, async () => {
            requireCardThread();
            return owners.conversation.runExtensionCommand(sessionRef, command);
          });
        },
        workspaces: () => owners.workspace.getWorkspaceRecords(),
        selectThread: async (resolve) => {
          await saveDraftBeforeSwitch();
          const state = await runLeavingWorkflow(event, async () => {
            requireCardThread();
            return owners.conversation.selectSession(resolve());
          });
          if (state.lastError) throw new Error(state.lastError);
        },
      };
      try {
        return (await runExtensionAction(host, target, action)) ?? null;
      } catch (error) {
        await run(event, async () =>
          owners.conversation.reportExtensionActionFailure(target, error),
        );
        return null;
      }
    },
  );

  ipcMain.handle(desktopIpc.getSessionTree, (event, rawTarget: unknown) => {
    windows.windowForSender(event.sender);
    return owners.conversation.getSessionTree(expectSessionTarget(rawTarget));
  });
  ipcMain.handle(
    desktopIpc.navigateSessionTree,
    (event, rawTarget: unknown, rawTargetId: unknown, rawOptions: unknown) => {
      const window = senderWindow(windows, event);
      const target = expectSessionTarget(rawTarget);
      const targetId = expectNonEmptyString(rawTargetId, "targetId");
      const options = expectNavigateSessionTreeOptions(rawOptions);
      return windows.runStateResultAction(window, () =>
        owners.conversation.navigateSessionTree(target, targetId, options),
      );
    },
  );

  registerWorkspaceFileIpc(windows, owners.workspace, capabilities);
  ipcMain.handle(desktopIpc.toggleWindowMaximize, (event) => {
    const window = senderWindow(windows, event);
    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
  });
}

function registerTerminalIpc(windows: WindowOwner, capabilities: DesktopIpcCapabilities): void {
  ipcMain.handle(
    desktopIpc.terminalEnsurePanel,
    (event, rawWorkspaceId: unknown, rawScopeId: unknown, rawSize: unknown) =>
      capabilities
        .terminal()
        .ensurePanel(
          windows.windowForSender(event.sender).webContents,
          expectNonEmptyString(rawWorkspaceId, "workspaceId"),
          expectNonEmptyString(rawScopeId, "terminalScopeId"),
          expectTerminalSize(rawSize),
        ),
  );
  ipcMain.handle(
    desktopIpc.terminalCreateSession,
    (event, rawWorkspaceId: unknown, rawScopeId: unknown, rawSize: unknown) =>
      capabilities
        .terminal()
        .createSession(
          windows.windowForSender(event.sender).webContents,
          expectNonEmptyString(rawWorkspaceId, "workspaceId"),
          expectNonEmptyString(rawScopeId, "terminalScopeId"),
          expectTerminalSize(rawSize),
        ),
  );
  ipcMain.handle(
    desktopIpc.terminalSetActiveSession,
    (event, rawWorkspaceId: unknown, rawScopeId: unknown, rawTerminalId: unknown) =>
      capabilities
        .terminal()
        .setActiveSession(
          windows.windowForSender(event.sender).webContents,
          expectNonEmptyString(rawWorkspaceId, "workspaceId"),
          expectNonEmptyString(rawScopeId, "terminalScopeId"),
          expectNonEmptyString(rawTerminalId, "terminalId"),
        ),
  );
  ipcMain.handle(desktopIpc.terminalWrite, (event, rawTerminalId: unknown, rawData: unknown) => {
    capabilities
      .optionalTerminal()
      ?.write(
        windows.windowForSender(event.sender).webContents,
        expectNonEmptyString(rawTerminalId, "terminalId"),
        expectString(rawData, "data"),
      );
  });
  ipcMain.handle(desktopIpc.terminalResize, (event, rawTerminalId: unknown, rawSize: unknown) => {
    capabilities
      .optionalTerminal()
      ?.resize(
        windows.windowForSender(event.sender).webContents,
        expectNonEmptyString(rawTerminalId, "terminalId"),
        expectTerminalSize(rawSize),
      );
  });
  ipcMain.handle(
    desktopIpc.terminalRestartSession,
    (event, rawTerminalId: unknown, rawSize: unknown) =>
      capabilities
        .terminal()
        .restart(
          windows.windowForSender(event.sender).webContents,
          expectNonEmptyString(rawTerminalId, "terminalId"),
          expectTerminalSize(rawSize),
        ),
  );
  ipcMain.handle(desktopIpc.terminalCloseSession, (event, rawTerminalId: unknown) =>
    capabilities
      .terminal()
      .close(
        windows.windowForSender(event.sender).webContents,
        expectNonEmptyString(rawTerminalId, "terminalId"),
      ),
  );
  ipcMain.handle(
    desktopIpc.terminalSetTitle,
    (event, rawTerminalId: unknown, rawTitle: unknown) => {
      capabilities
        .optionalTerminal()
        ?.setTitle(
          windows.windowForSender(event.sender).webContents,
          expectNonEmptyString(rawTerminalId, "terminalId"),
          expectString(rawTitle, "title"),
        );
    },
  );
  ipcMain.on(desktopIpc.terminalSetFocused, (event, rawFocused: unknown) => {
    const window = windows.windowForSender(event.sender);
    capabilities.setTerminalFocused(window.webContents.id, expectBoolean(rawFocused, "focused"));
  });
  ipcMain.on(desktopIpc.sidePanelSetFocused, (event, rawFocused: unknown) => {
    const window = windows.windowForSender(event.sender);
    capabilities.setSidePanelFocused(window.webContents.id, expectBoolean(rawFocused, "focused"));
  });
}

function registerWorkspaceFileIpc(
  windows: WindowOwner,
  workspace: WorkspaceOwner,
  capabilities: DesktopIpcCapabilities,
): void {
  ipcMain.handle(
    desktopIpc.listWorkspaceFiles,
    async (event, rawWorkspaceId: unknown, rawOptions: unknown) => {
      windows.windowForSender(event.sender);
      const workspacePath = workspace.getWorkspacePath(
        expectNonEmptyString(rawWorkspaceId, "workspaceId"),
      );
      if (!workspacePath) {
        return [];
      }
      const options = expectWorkspaceFileListOptions(rawOptions);
      return capabilities.listWorkspaceFiles(workspacePath, options);
    },
  );
  ipcMain.handle(
    desktopIpc.readWorkspaceFile,
    async (event, rawWorkspaceId: unknown, rawFilePath: unknown) => {
      windows.windowForSender(event.sender);
      const workspaceId = expectNonEmptyString(rawWorkspaceId, "workspaceId");
      const workspacePath = workspace.getWorkspacePath(workspaceId);
      if (!workspacePath) {
        throw new Error(`Unknown workspace: ${workspaceId}`);
      }
      return capabilities.readWorkspaceFile(workspacePath, expectString(rawFilePath, "filePath"));
    },
  );
  ipcMain.handle(
    desktopIpc.revealWorkspaceFile,
    async (event, rawWorkspaceId: unknown, rawFilePath: unknown) => {
      windows.windowForSender(event.sender);
      const workspaceId = expectNonEmptyString(rawWorkspaceId, "workspaceId");
      const workspacePath = workspace.getWorkspacePath(workspaceId);
      if (!workspacePath) {
        throw new Error(`Unknown workspace: ${workspaceId}`);
      }
      await capabilities.revealWorkspaceFile(workspacePath, expectString(rawFilePath, "filePath"));
    },
  );
  ipcMain.handle(desktopIpc.getChangedFiles, async (event, rawWorkspaceId: unknown) => {
    windows.windowForSender(event.sender);
    const workspacePath = workspace.getWorkspacePath(
      expectNonEmptyString(rawWorkspaceId, "workspaceId"),
    );
    if (!workspacePath) {
      return {
        state: "unavailable",
        error: {
          code: "workspace-unavailable",
          message: "Changed files are unavailable because this workspace could not be found.",
        },
      } satisfies ChangedFilesResult;
    }
    return capabilities.getChangedFiles(workspacePath);
  });
  ipcMain.handle(
    desktopIpc.getFileDiff,
    async (event, rawWorkspaceId: unknown, rawFilePath: unknown) => {
      windows.windowForSender(event.sender);
      const workspacePath = workspace.getWorkspacePath(
        expectNonEmptyString(rawWorkspaceId, "workspaceId"),
      );
      return workspacePath
        ? capabilities.getFileDiff(workspacePath, expectString(rawFilePath, "filePath"))
        : "";
    },
  );
  ipcMain.handle(
    desktopIpc.stageFile,
    async (event, rawWorkspaceId: unknown, rawFilePath: unknown, rawStagingSourcePath: unknown) => {
      windows.windowForSender(event.sender);
      const workspaceId = expectNonEmptyString(rawWorkspaceId, "workspaceId");
      const workspacePath = workspace.getWorkspacePath(workspaceId);
      if (!workspacePath) {
        throw new Error(`Unknown workspace: ${workspaceId}`);
      }
      await capabilities.stageFile(workspacePath, expectString(rawFilePath, "filePath"), {
        sourcePath: expectOptionalString(rawStagingSourcePath, "stagingSourcePath"),
      });
    },
  );
}

async function openOwnedFileInFinder(
  resolvedPath: string | undefined,
  requestedPath: string,
  kind: "skill" | "extension",
): Promise<void> {
  if (!resolvedPath) {
    throw new Error(`Unknown ${kind}: ${requestedPath}`);
  }
  await shell.openPath(path.dirname(resolvedPath));
}
