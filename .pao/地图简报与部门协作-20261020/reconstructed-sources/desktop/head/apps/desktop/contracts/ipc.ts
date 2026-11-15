import type {
  ExtensionViewOpenFile,
  DesktopExtensionViewInfo,
  OpenExtensionViewInput,
  ExtensionViewConnection,
  ExtensionViewMessage,
  ExtensionViewCatalogChange,
} from "./extension-views";
import type { RuntimeSettingsSnapshot } from "@pi-gui/session-driver/runtime-types";
import type { ExtensionActionEffect, ExtensionActionRequest } from "./extension-actions";
import type {
  NavigateSessionTreeOptions,
  NavigateSessionTreeResult,
  SessionTreeSnapshot,
} from "@pi-gui/session-driver/types";
import type { ClipboardImageRead } from "./composer-attachments";
import type { SessionRef } from "@pi-gui/session-driver/types";
import type { SaveTaskWorkbenchTemplateInput, TaskWorkbenchTemplate } from "./workbench";
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
} from "./review";
import type {
  CanvasMutationResult,
  CanvasNodeDetailInput,
  CanvasNodeDetailResult,
  CanvasResult,
} from "./canvas";
import type { KanbanCardOpInput, KanbanCardOpResult, KanbanResult } from "./kanban";
import type {
  WorkflowControlCommandInput,
  WorkflowControlCommandResult,
  WorkflowControlQueryInput,
  WorkflowControlResult,
} from "./workflow-control";
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
} from "./workflow-wizard";
import type { WorkboardResult } from "./workboard";
import type {
  AppLanguage,
  AppView,
  ComposerAttachment,
  CreateSessionInput,
  CreateWorkflowControllerInput,
  CreateWorktreeInput,
  DesktopAppState,
  CloseWindowBehavior,
  ForkThreadInput,
  ModelSettingsScopeMode,
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
} from "./desktop-state";

export type DesktopNotificationPermissionStatus =
  "granted" | "denied" | "default" | "unsupported" | "unknown";

export interface CustomProviderModelConfig {
  readonly id: string;
  readonly contextWindow?: number;
}

export interface CustomProviderConfig {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly models: readonly CustomProviderModelConfig[];
}

export interface CustomProviderProbeInput {
  readonly baseUrl: string;
  readonly apiKey?: string;
}

export type CustomProviderProbeResult =
  | { readonly ok: true; readonly models: readonly string[] }
  | { readonly ok: false; readonly error: string };

export type McpServerScope = "global" | "project";

/** An `mcp.json` server as Settings shows it; `env`, `headers` and `oauth` never leave main. */
export interface McpServerRecord {
  readonly name: string;
  readonly scope: McpServerScope;
  readonly transport: "stdio" | "http";
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  /** What the server offers, in a sentence; pi shows it to the model with the server. */
  readonly description?: string;
  readonly enabled: boolean;
  /** Environment variables, headers or sign-in config are set; their values never leave main. */
  readonly hasHiddenSettings: boolean;
}

export interface McpServersSnapshot {
  /** The global mcp.json new servers are saved to, with the home directory shown as `~`. */
  readonly globalConfigPath: string;
  readonly servers: readonly McpServerRecord[];
  /** mcp.json files that could not be read, and servers pi skips, with why. */
  readonly errors: readonly string[];
  /** Whether pi's global `defaultTools` switches code mode on. */
  readonly codemodeAlwaysOn: boolean;
}

export type NewMcpServerInput = { readonly name: string; readonly description?: string } & (
  { readonly command: string; readonly args: readonly string[] } | { readonly url: string }
);

/**
 * 会话控制面五态（设计包-控制入口五态-2026-10-04 §2.2）：receiving｜executing｜stopping｜stopped｜accepted。
 * 推导见 contracts/thread-control-state.ts 的表驱动纯函数；"未知" 只出现在回执里，表示账丢失或无态可判。
 */
export type ThreadControlState = "receiving" | "executing" | "stopping" | "stopped" | "accepted";
export type SessionControlState = ThreadControlState | "未知";

/** 单一控制入口 `pi-gui:session-control` 承载的五个动作（§3 契约）。 */
export type SessionControlAction =
  | {
      readonly kind: "send";
      readonly text: string;
      readonly attachments?: readonly ComposerAttachment[];
      readonly deliverAs?: "steer" | "followUp";
    }
  | { readonly kind: "cancel" }
  /** 派卡转 owner 会话文本（拍板 §6.2，P3 最小），桌面零写卡。 */
  | { readonly kind: "dispatch"; readonly cardGoal: string; readonly dispatchReason?: string }
  /** 验收确认转 owner 会话文本（拍板 §6.1），桌面零写卡。 */
  | { readonly kind: "confirm"; readonly cardRef: string; readonly basis?: string }
  /** 只读查账：按 requestId 查主进程控制账，不走写路径（§2.3）。 */
  | { readonly kind: "query"; readonly requestId?: string };

export interface SessionControlRequest {
  readonly target: WorkspaceSessionTarget;
  /** 渲染层生成的幂等键；主进程按 (target, requestId) 记账，重复投递返回首账不重发。 */
  readonly requestId: string;
  readonly action: SessionControlAction;
}

export interface SessionControlResponse {
  readonly requestId: string;
  readonly accepted: boolean;
  readonly reason?: string;
  readonly controlState: SessionControlState;
  readonly state: DesktopAppState;
}

export const desktopIpc = {
  extensionViewOpenFile: "pi-gui:extension-view-open-file",
  listExtensionViews: "pi-gui:list-extension-views",
  openExtensionView: "pi-gui:open-extension-view",
  sendExtensionViewMessage: "pi-gui:send-extension-view-message",
  closeExtensionView: "pi-gui:close-extension-view",
  runExtensionAction: "pi-gui:run-extension-action",
  extensionViewMessage: "pi-gui:extension-view-message",
  extensionViewCatalogChanged: "pi-gui:extension-view-catalog-changed",
  stateRequest: "pi-gui:state-request",
  stateChanged: "pi-gui:state-changed",
  getTaskWorkbenchTemplate: "pi-gui:get-task-workbench-template",
  saveTaskWorkbenchTemplate: "pi-gui:save-task-workbench-template",
  selectedTranscriptRequest: "pi-gui:selected-transcript-request",
  selectedTranscriptChanged: "pi-gui:selected-transcript-changed",
  appCommand: "pi-gui:app-command",
  workspacePicked: "pi-gui:workspace-picked",
  clipboardImagePasted: "pi-gui:clipboard-image-pasted",
  pickWorkspace: "pi-gui:pick-workspace",
  selectWorkspace: "pi-gui:select-workspace",
  renameWorkspace: "pi-gui:rename-workspace",
  removeWorkspace: "pi-gui:remove-workspace",
  reorderWorkspaces: "pi-gui:reorder-workspaces",
  reorderPinnedSessions: "pi-gui:reorder-pinned-sessions",
  openWorkspaceInFinder: "pi-gui:open-workspace-in-finder",
  createWorktree: "pi-gui:create-worktree",
  removeWorktree: "pi-gui:remove-worktree",
  openSkillInFinder: "pi-gui:open-skill-in-finder",
  openExtensionInFinder: "pi-gui:open-extension-in-finder",
  syncCurrentWorkspace: "pi-gui:sync-current-workspace",
  selectSession: "pi-gui:select-session",
  renameSession: "pi-gui:rename-session",
  archiveSession: "pi-gui:archive-session",
  unarchiveSession: "pi-gui:unarchive-session",
  markSessionRead: "pi-gui:mark-session-read",
  setSessionPinned: "pi-gui:set-session-pinned",
  createSession: "pi-gui:create-session",
  startThread: "pi-gui:start-thread",
  forkThread: "pi-gui:fork-thread",
  sendChildThreadFollowUp: "pi-gui:send-child-thread-follow-up",
  setChildSupervisionLoop: "pi-gui:set-child-supervision-loop",
  createScheduledTask: "pi-gui:create-scheduled-task",
  updateScheduledTask: "pi-gui:update-scheduled-task",
  deleteScheduledTask: "pi-gui:delete-scheduled-task",
  beginScheduledTaskInterview: "pi-gui:begin-scheduled-task-interview",
  cancelCurrentRun: "pi-gui:cancel-current-run",
  sessionControl: "pi-gui:session-control",
  setActiveView: "pi-gui:set-active-view",
  setSidebarCollapsed: "pi-gui:set-sidebar-collapsed",
  setThreadGrouping: "pi-gui:set-thread-grouping",
  setWorkspaceCollapsed: "pi-gui:set-workspace-collapsed",
  refreshRuntime: "pi-gui:refresh-runtime",
  setModelSettingsScopeMode: "pi-gui:set-model-settings-scope-mode",
  setDefaultModel: "pi-gui:set-default-model",
  setDefaultThinkingLevel: "pi-gui:set-default-thinking-level",
  setSessionModel: "pi-gui:set-session-model",
  setSessionThinkingLevel: "pi-gui:set-session-thinking-level",
  loginProvider: "pi-gui:login-provider",
  logoutProvider: "pi-gui:logout-provider",
  setProviderApiKey: "pi-gui:set-provider-api-key",
  listCustomProviders: "pi-gui:list-custom-providers",
  setCustomProvider: "pi-gui:set-custom-provider",
  deleteCustomProvider: "pi-gui:delete-custom-provider",
  probeCustomProviderModels: "pi-gui:probe-custom-provider-models",
  setEnableSkillCommands: "pi-gui:set-enable-skill-commands",
  setScopedModelPatterns: "pi-gui:set-scoped-model-patterns",
  setSkillEnabled: "pi-gui:set-skill-enabled",
  setExtensionEnabled: "pi-gui:set-extension-enabled",
  listMcpServers: "pi-gui:list-mcp-servers",
  addMcpServer: "pi-gui:add-mcp-server",
  removeMcpServer: "pi-gui:remove-mcp-server",
  setMcpServerEnabled: "pi-gui:set-mcp-server-enabled",
  setCodemodeAlwaysOn: "pi-gui:set-codemode-always-on",
  respondToHostUiRequest: "pi-gui:respond-to-host-ui-request",
  setNotificationPreferences: "pi-gui:set-notification-preferences",
  setIntegratedTerminalShell: "pi-gui:set-integrated-terminal-shell",
  setPaoHome: "pi-gui:set-pao-home",
  setCloseWindowBehavior: "pi-gui:set-close-window-behavior",
  setEnableTransparency: "pi-gui:set-enable-transparency",
  terminalEnsurePanel: "pi-gui:terminal-ensure-panel",
  terminalCreateSession: "pi-gui:terminal-create-session",
  terminalSetActiveSession: "pi-gui:terminal-set-active-session",
  terminalWrite: "pi-gui:terminal-write",
  terminalResize: "pi-gui:terminal-resize",
  terminalRestartSession: "pi-gui:terminal-restart-session",
  terminalCloseSession: "pi-gui:terminal-close-session",
  terminalSetTitle: "pi-gui:terminal-set-title",
  terminalSetFocused: "pi-gui:terminal-set-focused",
  sidePanelSetFocused: "pi-gui:side-panel-set-focused",
  terminalData: "pi-gui:terminal-data",
  terminalExit: "pi-gui:terminal-exit",
  terminalError: "pi-gui:terminal-error",
  getNotificationPermissionStatus: "pi-gui:get-notification-permission-status",
  requestNotificationPermission: "pi-gui:request-notification-permission",
  openSystemNotificationSettings: "pi-gui:open-system-notification-settings",
  notificationPermissionStatusChanged: "pi-gui:notification-permission-status-changed",
  pickComposerAttachments: "pi-gui:pick-composer-attachments",
  readClipboardImage: "pi-gui:read-clipboard-image",
  addComposerAttachments: "pi-gui:add-composer-attachments",
  removeComposerAttachment: "pi-gui:remove-composer-attachment",
  editQueuedComposerMessage: "pi-gui:edit-queued-composer-message",
  cancelQueuedComposerEdit: "pi-gui:cancel-queued-composer-edit",
  removeQueuedComposerMessage: "pi-gui:remove-queued-composer-message",
  steerQueuedComposerMessage: "pi-gui:steer-queued-composer-message",
  persistComposerDraft: "pi-gui:persist-composer-draft",
  updateComposerDraft: "pi-gui:update-composer-draft",
  flushPendingComposerDraft: "pi-gui:flush-pending-composer-draft",
  pendingComposerDraftFlushed: "pi-gui:pending-composer-draft-flushed",
  workflowLeaveRequested: "pi-gui:workflow-leave-requested",
  workflowLeaveResolved: "pi-gui:workflow-leave-resolved",
  createWorkflowController: "pi-gui:create-workflow-controller",
  setWorkflowTabs: "pi-gui:set-workflow-tabs",
  activateWorkflowController: "pi-gui:activate-workflow-controller",
  submitComposer: "pi-gui:submit-composer",
  getSessionTree: "pi-gui:get-session-tree",
  navigateSessionTree: "pi-gui:navigate-session-tree",
  toggleWindowMaximize: "pi-gui:toggle-window-maximize",
  listWorkspaceFiles: "pi-gui:list-workspace-files",
  readWorkspaceFile: "pi-gui:read-workspace-file",
  revealWorkspaceFile: "pi-gui:reveal-workspace-file",
  getChangedFiles: "pi-gui:get-changed-files",
  getFileDiff: "pi-gui:get-file-diff",
  stageFile: "pi-gui:stage-file",
  getTurnChanges: "pi-gui:get-turn-changes",
  getReview: "pi-gui:get-review",
  getReviewFile: "pi-gui:get-review-file",
  setReviewFileReviewed: "pi-gui:set-review-file-reviewed",
  changeReviewFileStage: "pi-gui:change-review-file-stage",
  getWorkboard: "pi-gui:get-workboard",
  getCanvas: "pi-gui:get-canvas",
  getCanvasNodeDetail: "pi-gui:get-canvas-node-detail",
  openCanvasCard: "pi-gui:open-canvas-card",
  getKanban: "pi-gui:get-kanban",
  kanbanCardOp: "pi-gui:kanban-card-op",
  getWorkflowCatalog: "pi-gui:get-workflow-catalog",
  runWorkflowPreflight: "pi-gui:run-workflow-preflight",
  installWorkflowTemplate: "pi-gui:install-workflow-template",
  saveWorkflowRecipe: "pi-gui:save-workflow-recipe",
  deleteWorkflowRecipe: "pi-gui:delete-workflow-recipe",
  startWorkflow: "pi-gui:start-workflow",
  saveWorkflowTier: "pi-gui:save-workflow-tier",
  getWorkflowControl: "pi-gui:get-workflow-control",
  controlWorkflow: "pi-gui:control-workflow",
  getThemeMode: "pi-gui:get-theme-mode",
  getResolvedTheme: "pi-gui:get-resolved-theme",
  setThemeMode: "pi-gui:set-theme-mode",
  setThemePresetId: "pi-gui:set-theme-preset-id",
  setLanguage: "pi-gui:set-language",
  themeChanged: "pi-gui:theme-changed",
  windowFocused: "pi-gui:window-focused",
  ping: "app:ping",
  openExternal: "app:open-external",
  relaunchApplication: "pi-gui:relaunch-application",
} as const;

export const desktopCommands = {
  openSettings: "open-settings",
  openNewThread: "open-new-thread",
  toggleTerminal: "toggle-terminal",
  toggleSidePanel: "toggle-side-panel",
  toggleReview: "toggle-review",
  closeFocusedSurface: "close-focused-surface",
  toggleSidebar: "toggle-sidebar",
  openCommandPalette: "open-command-palette",
  openFilePalette: "open-file-palette",
  renameThread: "rename-thread",
  archiveThread: "archive-thread",
  selectRecentThread1: "select-recent-thread-1",
  selectRecentThread2: "select-recent-thread-2",
  selectRecentThread3: "select-recent-thread-3",
  selectRecentThread4: "select-recent-thread-4",
  selectRecentThread5: "select-recent-thread-5",
  selectRecentThread6: "select-recent-thread-6",
  selectRecentThread7: "select-recent-thread-7",
  selectRecentThread8: "select-recent-thread-8",
  selectRecentThread9: "select-recent-thread-9",
  selectSidePanelTab1: "select-side-panel-tab-1",
  selectSidePanelTab2: "select-side-panel-tab-2",
  selectSidePanelTab3: "select-side-panel-tab-3",
  selectSidePanelTab4: "select-side-panel-tab-4",
  selectSidePanelTab5: "select-side-panel-tab-5",
  selectSidePanelTab6: "select-side-panel-tab-6",
  selectSidePanelTab7: "select-side-panel-tab-7",
  selectSidePanelTab8: "select-side-panel-tab-8",
  selectSidePanelTab9: "select-side-panel-tab-9",
} as const;

const RECENT_THREAD_COMMANDS = [
  desktopCommands.selectRecentThread1,
  desktopCommands.selectRecentThread2,
  desktopCommands.selectRecentThread3,
  desktopCommands.selectRecentThread4,
  desktopCommands.selectRecentThread5,
  desktopCommands.selectRecentThread6,
  desktopCommands.selectRecentThread7,
  desktopCommands.selectRecentThread8,
  desktopCommands.selectRecentThread9,
] as const;

export const THREAD_SHORTCUT_SLOT_COUNT = RECENT_THREAD_COMMANDS.length;

export function isRecentThreadCommand(command: PiDesktopCommand | undefined): boolean {
  return (RECENT_THREAD_COMMANDS as readonly (PiDesktopCommand | undefined)[]).includes(command);
}

const SIDE_PANEL_TAB_COMMANDS = [
  desktopCommands.selectSidePanelTab1,
  desktopCommands.selectSidePanelTab2,
  desktopCommands.selectSidePanelTab3,
  desktopCommands.selectSidePanelTab4,
  desktopCommands.selectSidePanelTab5,
  desktopCommands.selectSidePanelTab6,
  desktopCommands.selectSidePanelTab7,
  desktopCommands.selectSidePanelTab8,
  desktopCommands.selectSidePanelTab9,
] as const;

export const SIDE_PANEL_TAB_SHORTCUT_SLOT_COUNT = SIDE_PANEL_TAB_COMMANDS.length;

/** The zero-based side panel tab a command selects, or undefined for other commands. */
export function sidePanelTabIndex(command: PiDesktopCommand | undefined): number | undefined {
  const index = (SIDE_PANEL_TAB_COMMANDS as readonly (PiDesktopCommand | undefined)[]).indexOf(
    command,
  );
  return index < 0 ? undefined : index;
}

/**
 * The side panel tab modifier: Control on macOS, where Command switches threads,
 * and Alt elsewhere, where Control does. It must be the only modifier held.
 */
export function sidePanelTabModifierHeld(
  platform: NodeJS.Platform,
  input: {
    readonly meta: boolean;
    readonly control: boolean;
    readonly alt: boolean;
    readonly shift: boolean;
  },
): boolean {
  if (input.shift || input.meta) return false;
  return platform === "darwin" ? input.control && !input.alt : input.alt && !input.control;
}

/**
 * Control+1-9 on macOS and Alt+1-9 elsewhere select side panel tab N. Keypad
 * digits are left alone so Windows Alt codes keep typing characters.
 */
export function getSidePanelTabCommand(
  platform: NodeJS.Platform,
  input: {
    readonly meta: boolean;
    readonly control: boolean;
    readonly alt: boolean;
    readonly shift: boolean;
    readonly key: string;
    readonly code?: string;
  },
): PiDesktopCommand | undefined {
  if (!sidePanelTabModifierHeld(platform, input) || input.code?.startsWith("Numpad")) {
    return undefined;
  }
  const digit = input.code?.match(/^Digit([1-9])$/)?.[1] ?? input.key.match(/^[1-9]$/)?.[0];
  return digit ? SIDE_PANEL_TAB_COMMANDS[Number(digit) - 1] : undefined;
}

export function getSidePanelTabShortcutLabel(platform: NodeJS.Platform, slot: number): string {
  return `${platform === "darwin" ? "⌃" : "Alt+"}${slot}`;
}

export function getDesktopShortcutLabel(platform: NodeJS.Platform, key: string): string {
  return `${platform === "darwin" ? "⌘" : "Ctrl+"}${key.toUpperCase()}`;
}

export function formatShortcut(
  platform: NodeJS.Platform,
  key: string,
  modifiers: { readonly shift?: boolean; readonly alt?: boolean } = {},
): string {
  if (platform === "darwin") {
    return `${modifiers.alt ? "⌥" : ""}${modifiers.shift ? "⇧" : ""}⌘${key.toUpperCase()}`;
  }
  return `Ctrl+${modifiers.alt ? "Alt+" : ""}${modifiers.shift ? "Shift+" : ""}${key.toUpperCase()}`;
}

export function getSidePanelToggleShortcutLabel(platform: NodeJS.Platform): string {
  return platform === "darwin" ? "⌘⌥B" : "Ctrl+Alt+B";
}

export type PiDesktopStateListener = (state: DesktopAppState) => void;
/** selectedTranscriptChanged 推送载荷：全量记录或流式尾部增量；null 表示无选中会话。 */
export type PiDesktopSelectedTranscriptListener = (
  payload: SelectedTranscriptUpdate | null,
) => void;
export type PiDesktopCommand = (typeof desktopCommands)[keyof typeof desktopCommands];

export type ChangedFileStatus =
  "added" | "copied" | "deleted" | "modified" | "renamed" | "untracked";

export interface ChangedFileEntry {
  readonly path: string;
  readonly previousPath?: string;
  readonly stagingSourcePath?: string;
  readonly status: ChangedFileStatus;
  readonly staged: boolean;
}

export type ChangedFilesErrorCode =
  "git-status-failed" | "git-status-invalid" | "workspace-unavailable";

export interface ChangedFilesError {
  readonly code: ChangedFilesErrorCode;
  readonly message: string;
}

export type ChangedFilesResult =
  | {
      readonly state: "available";
      readonly files: readonly ChangedFileEntry[];
    }
  | {
      readonly state: "unavailable";
      readonly error: ChangedFilesError;
    };

export interface WorkspaceFilePreview {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly binary: boolean;
  readonly sizeBytes: number;
}

export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

export type TerminalSessionStatus = "running" | "exited" | "error";

export interface TerminalSessionSnapshot {
  readonly id: string;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly shell: string;
  readonly title: string;
  readonly status: TerminalSessionStatus;
  readonly replay: string;
  readonly truncated: boolean;
  readonly exitCode?: number;
  readonly signal?: number;
}

export interface TerminalPanelSnapshot {
  readonly workspaceId: string;
  readonly rootKey: string;
  readonly activeSessionId: string;
  readonly sessions: readonly TerminalSessionSnapshot[];
}

export interface TerminalDataEvent {
  readonly terminalId: string;
  readonly data: string;
}

export interface TerminalExitEvent {
  readonly terminalId: string;
  readonly exitCode?: number;
  readonly signal?: number;
}

export interface TerminalErrorEvent {
  readonly terminalId: string;
  readonly message: string;
}

export interface DesktopShortcutInput {
  readonly modifier: boolean;
  readonly alt?: boolean;
  readonly shift: boolean;
  readonly key: string;
  readonly code?: string;
}

/** Command on macOS, Control on Windows and Linux. */
export function platformShortcutModifier(
  platform: NodeJS.Platform,
  input: { readonly meta: boolean; readonly control: boolean },
): boolean {
  return platform === "darwin" ? input.meta : input.control;
}

const MAX_QUEUED_DESKTOP_COMMANDS = 16;

/**
 * Delivers main-process shortcuts to the renderer.
 * A chord can arrive before React subscribes, or in the gap while a listener
 * is swapped. Those commands are kept until the next subscriber.
 */
export function createDesktopCommandSubscription() {
  let listener: ((command: PiDesktopCommand) => void) | null = null;
  const queued: PiDesktopCommand[] = [];
  return {
    subscribe(next: (command: PiDesktopCommand) => void): () => void {
      listener = next;
      const pending = queued.splice(0, queued.length);
      for (const command of pending) next(command);
      return () => {
        if (listener === next) listener = null;
      };
    },
    deliver(command: PiDesktopCommand): void {
      if (listener) {
        listener(command);
        return;
      }
      queued.push(command);
      if (queued.length > MAX_QUEUED_DESKTOP_COMMANDS) queued.shift();
    },
  };
}

/** Collapses a repeated keydown from one physical chord so a toggle stays open. */
export const SEARCH_CHORD_TOGGLE_MS = 200;
export const REVIEW_TOGGLE_DEDUPE_MS = 8;

export type ChordSource = "main" | "renderer";

/**
 * Collapses one chord that reaches the renderer twice, once forwarded by the main
 * process and once as a keydown. Repeats from the same source are separate presses.
 */
export function createChordPairGate(windowMs = REVIEW_TOGGLE_DEDUPE_MS) {
  let last: { readonly source: ChordSource; readonly at: number } | undefined;
  return (source: ChordSource, now: number): boolean => {
    if (last && last.source !== source && now - last.at < windowMs) {
      last = undefined;
      return false;
    }
    last = { source, at: now };
    return true;
  };
}

export function createChordToggleGate(windowMs = SEARCH_CHORD_TOGGLE_MS) {
  let last = Number.NEGATIVE_INFINITY;
  return (now: number): boolean => {
    if (now - last < windowMs) return false;
    last = now;
    return true;
  };
}

export interface EarlyModifierChord {
  readonly key: string;
  readonly code: string;
}

function isBufferedModifierChord(key: string, code?: string): boolean {
  const lower = key.toLowerCase();
  if (lower === "f" || code === "KeyF") return true;
  if (lower === "," || code === "Comma") return true;
  if (lower === "r" || code === "KeyR") return true;
  return /^[1-9]$/.test(key) || /^Digit[1-9]$/.test(code ?? "");
}

/**
 * Keeps Command/Ctrl chords that arrive before the React shortcut listener
 * exists. Search, settings, Review, and thread digits are replayed.
 */
export function createEarlyModifierChordBuffer() {
  const pending: EarlyModifierChord[] = [];
  let ready = false;
  return {
    note(
      input: EarlyModifierChord & { readonly modifier: boolean; readonly shift: boolean },
    ): void {
      if (ready || !input.modifier || input.shift) return;
      if (!isBufferedModifierChord(input.key, input.code)) return;
      pending.push({ key: input.key, code: input.code });
      if (pending.length > 8) pending.shift();
    },
    arm(): readonly EarlyModifierChord[] {
      ready = true;
      return pending.splice(0, pending.length);
    },
  };
}

export const earlyModifierChords = createEarlyModifierChordBuffer();

export function getDesktopCommandFromShortcut(
  input: DesktopShortcutInput,
): PiDesktopCommand | undefined {
  if (!input.modifier) {
    return undefined;
  }

  const lowerKey = input.key.toLowerCase();
  const isComma = input.key === "," || input.code === "Comma";
  const isB = lowerKey === "b" || input.code === "KeyB";
  const isJ = lowerKey === "j" || input.code === "KeyJ";
  const isR = lowerKey === "r" || input.code === "KeyR";
  const isK = lowerKey === "k" || input.code === "KeyK";
  const isP = lowerKey === "p" || input.code === "KeyP";
  const isN = lowerKey === "n" || input.code === "KeyN";
  const isShiftO = input.shift && (lowerKey === "o" || input.code === "KeyO");
  const isShiftR = input.shift && isR;
  const isShiftA = input.shift && (lowerKey === "a" || input.code === "KeyA");

  if (input.alt) {
    if (!input.shift && isB) {
      return desktopCommands.toggleSidePanel;
    }
    return undefined;
  }

  if (!input.shift && isComma) {
    return desktopCommands.openSettings;
  }

  if (!input.shift && isJ) {
    return desktopCommands.toggleTerminal;
  }

  if (!input.shift && isR) {
    return desktopCommands.toggleReview;
  }

  if (!input.shift && isB) {
    return desktopCommands.toggleSidebar;
  }

  if (!input.shift && isK) {
    return desktopCommands.openCommandPalette;
  }

  if (!input.shift && isP) {
    return desktopCommands.openFilePalette;
  }

  if ((!input.shift && isN) || isShiftO) {
    return desktopCommands.openNewThread;
  }

  if (isShiftR) {
    return desktopCommands.renameThread;
  }

  if (isShiftA) {
    return desktopCommands.archiveThread;
  }

  if (!input.shift) {
    const digitFromKey = /^[1-9]$/.test(input.key) ? input.key : undefined;
    const digitFromCode = input.code?.match(/^Digit([1-9])$/)?.[1];
    const digit = digitFromKey ?? digitFromCode;
    if (digit) {
      return RECENT_THREAD_COMMANDS[Number(digit) - 1];
    }
  }

  return undefined;
}

/**
 * Callers accept palette commands only from the platform modifier, so macOS
 * Control+K and Control+P stay with text fields, and only from a first press.
 */
export function isPaletteCommand(command: PiDesktopCommand | undefined): boolean {
  return (
    command === desktopCommands.openCommandPalette || command === desktopCommands.openFilePalette
  );
}

/**
 * Commands that act once per press and only from the platform modifier. macOS
 * Control chords stay with text fields, and off macOS the terminal keeps Control
 * chords. Holding Archive would otherwise archive each next thread in turn, and
 * holding Review would flicker the panel.
 */
export function isSinglePressCommand(command: PiDesktopCommand | undefined): boolean {
  return (
    isPaletteCommand(command) ||
    command === desktopCommands.toggleReview ||
    command === desktopCommands.renameThread ||
    command === desktopCommands.archiveThread
  );
}

export function isCloseFocusedSurfaceShortcut(input: {
  readonly meta: boolean;
  readonly control: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly key: string;
  readonly code?: string;
  readonly platform: NodeJS.Platform;
}): boolean {
  if (input.alt || input.shift) {
    return false;
  }
  const platformModifier = input.platform === "darwin" ? input.meta : input.control;
  const otherModifier = input.platform === "darwin" ? input.control : input.meta;
  if (!platformModifier || otherModifier) {
    return false;
  }
  return input.key.toLowerCase() === "w" || input.code === "KeyW";
}

export interface PiDesktopApi {
  platform: NodeJS.Platform;
  versions: NodeJS.ProcessVersions;
  ping(): Promise<string>;
  getState(): Promise<DesktopAppState>;
  getTaskWorkbenchTemplate(target: SessionRef): Promise<TaskWorkbenchTemplate | null>;
  saveTaskWorkbenchTemplate(input: SaveTaskWorkbenchTemplateInput): Promise<void>;
  onStateChanged(listener: PiDesktopStateListener): () => void;
  getSelectedTranscript(): Promise<SelectedTranscriptRecord | null>;
  onSelectedTranscriptChanged(listener: PiDesktopSelectedTranscriptListener): () => void;
  onCommand(listener: (command: PiDesktopCommand) => void): () => void;
  onWorkspacePicked(listener: (workspaceId: string) => void): () => void;
  onClipboardImagePasted(listener: (result: ClipboardImageRead) => void): () => void;
  getPathForFile(file: File): string;
  pickWorkspace(): Promise<DesktopAppState>;
  selectWorkspace(workspaceId: string): Promise<DesktopAppState>;
  renameWorkspace(workspaceId: string, displayName: string): Promise<DesktopAppState>;
  removeWorkspace(workspaceId: string): Promise<DesktopAppState>;
  reorderWorkspaces(workspaceOrder: readonly string[]): Promise<DesktopAppState>;
  reorderPinnedSessions(pinnedSessionOrder: readonly string[]): Promise<DesktopAppState>;
  openWorkspaceInFinder(workspaceId: string): Promise<void>;
  createWorktree(input: CreateWorktreeInput): Promise<DesktopAppState>;
  removeWorktree(input: RemoveWorktreeInput): Promise<DesktopAppState>;
  openSkillInFinder(workspaceId: string, filePath: string): Promise<void>;
  openExtensionInFinder(workspaceId: string, filePath: string): Promise<void>;
  syncCurrentWorkspace(): Promise<DesktopAppState>;
  selectSession(target: WorkspaceSessionTarget): Promise<DesktopAppState>;
  renameSession(target: WorkspaceSessionTarget, title: string): Promise<DesktopAppState>;
  archiveSession(target: WorkspaceSessionTarget): Promise<DesktopAppState>;
  unarchiveSession(target: WorkspaceSessionTarget): Promise<DesktopAppState>;
  markSessionRead(target: WorkspaceSessionTarget): Promise<DesktopAppState>;
  setSessionPinned(target: WorkspaceSessionTarget, pinned: boolean): Promise<DesktopAppState>;
  createSession(input: CreateSessionInput): Promise<DesktopAppState>;
  startThread(input: StartThreadInput): Promise<DesktopAppState>;
  forkThread(input: ForkThreadInput): Promise<DesktopAppState>;
  sendChildThreadFollowUp(input: SendChildThreadFollowUpInput): Promise<DesktopAppState>;
  setChildSupervisionLoop(input: SetChildSupervisionLoopInput): Promise<DesktopAppState>;
  createScheduledTask(input: CreateScheduledTaskInput): Promise<DesktopAppState>;
  updateScheduledTask(id: string, patch: UpdateScheduledTaskInput): Promise<DesktopAppState>;
  deleteScheduledTask(id: string): Promise<DesktopAppState>;
  beginScheduledTaskInterview(): Promise<DesktopAppState>;
  cancelCurrentRun(): Promise<DesktopAppState>;
  /**
   * The one control entry: send/cancel/dispatch/confirm/query with a renderer-generated
   * requestId. Main keeps the first account per (target, requestId) and never re-runs a
   * repeated write; after a timeout or error, query the account instead of resending.
   */
  sessionControl(request: SessionControlRequest): Promise<SessionControlResponse>;
  setActiveView(view: AppView): Promise<DesktopAppState>;
  setSidebarCollapsed(collapsed: boolean): Promise<DesktopAppState>;
  setThreadGrouping(grouping: ThreadGrouping): Promise<DesktopAppState>;
  setWorkspaceCollapsed(workspaceId: string, collapsed: boolean): Promise<DesktopAppState>;
  refreshRuntime(workspaceId?: string): Promise<DesktopAppState>;
  setModelSettingsScopeMode(mode: ModelSettingsScopeMode): Promise<DesktopAppState>;
  setDefaultModel(workspaceId: string, provider: string, modelId: string): Promise<DesktopAppState>;
  setDefaultThinkingLevel(
    workspaceId: string,
    thinkingLevel: RuntimeSettingsSnapshot["defaultThinkingLevel"],
  ): Promise<DesktopAppState>;
  setSessionModel(
    workspaceId: string,
    sessionId: string,
    provider: string,
    modelId: string,
  ): Promise<DesktopAppState>;
  setSessionThinkingLevel(
    workspaceId: string,
    sessionId: string,
    thinkingLevel: NonNullable<RuntimeSettingsSnapshot["defaultThinkingLevel"]>,
  ): Promise<DesktopAppState>;
  loginProvider(workspaceId: string, providerId: string): Promise<DesktopAppState>;
  logoutProvider(workspaceId: string, providerId: string): Promise<DesktopAppState>;
  setProviderApiKey(
    workspaceId: string,
    providerId: string,
    apiKey: string,
  ): Promise<DesktopAppState>;
  listCustomProviders(): Promise<readonly CustomProviderConfig[]>;
  setCustomProvider(workspaceId: string, config: CustomProviderConfig): Promise<DesktopAppState>;
  deleteCustomProvider(workspaceId: string, providerId: string): Promise<DesktopAppState>;
  probeCustomProviderModels(input: CustomProviderProbeInput): Promise<CustomProviderProbeResult>;
  setEnableSkillCommands(workspaceId: string, enabled: boolean): Promise<DesktopAppState>;
  setScopedModelPatterns(
    workspaceId: string,
    patterns: readonly string[],
  ): Promise<DesktopAppState>;
  setSkillEnabled(
    workspaceId: string,
    filePath: string,
    enabled: boolean,
  ): Promise<DesktopAppState>;
  setExtensionEnabled(
    workspaceId: string,
    filePath: string,
    enabled: boolean,
  ): Promise<DesktopAppState>;
  listMcpServers(workspaceId: string): Promise<McpServersSnapshot>;
  addMcpServer(workspaceId: string, server: NewMcpServerInput): Promise<DesktopAppState>;
  removeMcpServer(workspaceId: string, name: string): Promise<DesktopAppState>;
  setMcpServerEnabled(
    workspaceId: string,
    scope: McpServerScope,
    name: string,
    enabled: boolean,
  ): Promise<DesktopAppState>;
  setCodemodeAlwaysOn(workspaceId: string, alwaysOn: boolean): Promise<DesktopAppState>;
  respondToHostUiRequest(
    workspaceId: string,
    sessionId: string,
    response:
      | { readonly requestId: string; readonly value: string }
      | { readonly requestId: string; readonly confirmed: boolean }
      | { readonly requestId: string; readonly cancelled: true },
  ): Promise<DesktopAppState>;
  setNotificationPreferences(
    preferences: Partial<NotificationPreferences>,
  ): Promise<DesktopAppState>;
  setIntegratedTerminalShell(shell: string): Promise<DesktopAppState>;
  /** Saves the PAO home setting; empty falls back to the PAO_HOME environment variable. */
  setPaoHome(paoHome: string): Promise<DesktopAppState>;
  setCloseWindowBehavior(behavior: CloseWindowBehavior): Promise<DesktopAppState>;
  setEnableTransparency(enabled: boolean): Promise<DesktopAppState>;
  setThemePresetId(presetId: ThemePresetId): Promise<DesktopAppState>;
  ensureTerminalPanel(
    workspaceId: string,
    terminalScopeId: string,
    size?: Partial<TerminalSize>,
  ): Promise<TerminalPanelSnapshot>;
  createTerminalSession(
    workspaceId: string,
    terminalScopeId: string,
    size?: Partial<TerminalSize>,
  ): Promise<TerminalPanelSnapshot>;
  setActiveTerminalSession(
    workspaceId: string,
    terminalScopeId: string,
    terminalId: string,
  ): Promise<TerminalPanelSnapshot>;
  writeTerminal(terminalId: string, data: string): Promise<void>;
  resizeTerminal(terminalId: string, size: TerminalSize): Promise<void>;
  restartTerminalSession(
    terminalId: string,
    size?: Partial<TerminalSize>,
  ): Promise<TerminalPanelSnapshot>;
  closeTerminalSession(terminalId: string): Promise<TerminalPanelSnapshot | null>;
  setTerminalTitle(terminalId: string, title: string): Promise<void>;
  setTerminalFocused(focused: boolean): Promise<void>;
  setSidePanelFocused(focused: boolean): Promise<void>;
  onTerminalData(listener: (event: TerminalDataEvent) => void): () => void;
  onTerminalExit(listener: (event: TerminalExitEvent) => void): () => void;
  onTerminalError(listener: (event: TerminalErrorEvent) => void): () => void;
  getNotificationPermissionStatus(): Promise<DesktopNotificationPermissionStatus>;
  requestNotificationPermission(): Promise<DesktopNotificationPermissionStatus>;
  openSystemNotificationSettings(): Promise<void>;
  onNotificationPermissionStatusChanged(
    callback: (status: DesktopNotificationPermissionStatus) => void,
  ): () => void;
  pickComposerAttachments(): Promise<DesktopAppState>;
  readClipboardImage(): ClipboardImageRead;
  addComposerAttachments(attachments: readonly ComposerAttachment[]): Promise<DesktopAppState>;
  removeComposerAttachment(attachmentId: string): Promise<DesktopAppState>;
  editQueuedComposerMessage(messageId: string, currentDraft?: string): Promise<DesktopAppState>;
  cancelQueuedComposerEdit(): Promise<DesktopAppState>;
  removeQueuedComposerMessage(messageId: string): Promise<DesktopAppState>;
  steerQueuedComposerMessage(messageId: string): Promise<DesktopAppState>;
  persistComposerDraft(input: {
    readonly target: SessionRef;
    readonly draft: string;
  }): Promise<void>;
  /** Saves the draft typed in `target`, even if another task is selected by the time it lands. */
  updateComposerDraft(composerDraft: string, target: SessionRef): Promise<DesktopAppState>;
  /**
   * Runs `handler` when the window is about to close or the app to quit; it should resolve
   * once the debounced draft has been saved. Main waits a bounded time for it.
   */
  onPendingComposerDraftFlush(handler: () => Promise<void>): () => void;
  onWorkflowLeaveRequest(handler: () => Promise<boolean>): () => void;
  createWorkflowController(input: CreateWorkflowControllerInput): Promise<DesktopAppState>;
  /** 覆写画布工作流页签的正式元数据；草稿、dirty 与未保存内容不在此列。 */
  setWorkflowTabs(input: SetWorkflowTabsInput): Promise<DesktopAppState>;
  /** 画布内切换运行页签的 controller：选中目标会话并发布转录，但不离开画布。 */
  activateWorkflowController(target: WorkspaceSessionTarget): Promise<DesktopAppState>;
  submitComposer(
    text: string,
    options?: { readonly deliverAs?: "steer" | "followUp" },
  ): Promise<DesktopAppState>;
  getSessionTree(target: WorkspaceSessionTarget): Promise<SessionTreeSnapshot>;
  navigateSessionTree(
    target: WorkspaceSessionTarget,
    targetId: string,
    options?: NavigateSessionTreeOptions,
  ): Promise<{ readonly state: DesktopAppState; readonly result: NavigateSessionTreeResult }>;
  listWorkspaceFiles(
    workspaceId: string,
    options?: { readonly force?: boolean },
  ): Promise<string[]>;
  readWorkspaceFile(workspaceId: string, filePath: string): Promise<WorkspaceFilePreview>;
  revealWorkspaceFile(workspaceId: string, filePath: string): Promise<void>;
  getChangedFiles(workspaceId: string): Promise<ChangedFilesResult>;
  getFileDiff(workspaceId: string, filePath: string): Promise<string>;
  stageFile(workspaceId: string, filePath: string, stagingSourcePath?: string): Promise<void>;
  onExtensionViewOpenFile(listener: (event: ExtensionViewOpenFile) => void): () => void;
  /** Runs a card button's action for its thread, which must be the window's selected one. */
  runExtensionAction(request: ExtensionActionRequest): Promise<ExtensionActionEffect | null>;
  listExtensionViews(target: SessionRef): Promise<readonly DesktopExtensionViewInfo[]>;
  openExtensionView(input: OpenExtensionViewInput): Promise<ExtensionViewConnection>;
  sendExtensionViewMessage(input: ExtensionViewMessage): Promise<void>;
  closeExtensionView(connectionId: string): Promise<void>;
  onExtensionViewMessage(listener: (event: ExtensionViewMessage) => void): () => void;
  onExtensionViewCatalogChanged(listener: (event: ExtensionViewCatalogChange) => void): () => void;
  getTurnChanges(input: TurnChangesInput): Promise<TurnChangesResult>;
  getReview(input: GetReviewInput): Promise<ReviewResult>;
  getReviewFile(input: ReviewFileInput): Promise<ReviewFileResult>;
  setReviewFileReviewed(input: SetReviewFileReviewedInput): Promise<SetReviewFileReviewedResult>;
  changeReviewFileStage(input: ChangeReviewFileStageInput): Promise<ChangeReviewFileStageResult>;
  /** One read-only pull of the work board aggregates; the result carries its own unavailability. */
  getWorkboard(): Promise<WorkboardResult>;
  /** One read-only pull of the workflow canvas view; the result carries its own unavailability. */
  getCanvas(): Promise<CanvasResult>;
  /** D8d node detail (P4-4): template vs card values, receipt rounds, execution anchors. */
  getCanvasNodeDetail(input: CanvasNodeDetailInput): Promise<CanvasNodeDetailResult>;
  /** Opens the node's card file in the system editor; main re-resolves the path itself. */
  openCanvasCard(input: CanvasNodeDetailInput): Promise<CanvasMutationResult>;
  /** 看板（只读）：主进程按已登记 workspaceId 解析项目路径，不收渲染层路径。 */
  getKanban(workspaceId: string): Promise<KanbanResult>;
  /**
   * 看板卡操作（S7-B）：只代「用户」执行取消；主进程复核卡路径在工作区内、
   * 文件名卡号一致后才经内核 changeCardStatus 写盘，内核状态机拒绝＝逐卡失败原因。
   */
  kanbanCardOp(input: KanbanCardOpInput): Promise<KanbanCardOpResult>;
  /** Wizard (P4-3): read-only catalog pull (recipes, tiers, thinking levels, starter templates). */
  getWorkflowCatalog(): Promise<WorkflowCatalogResult>;
  /** Wizard: same-source preflight gate (fork previewDesktopWorkflow); red items block start. */
  runWorkflowPreflight(input: WorkflowPreflightInput): Promise<WorkflowPreflightResult>;
  /** Wizard: install a starter template via the in-session owner path (ui.confirm inside). */
  installWorkflowTemplate(input: WorkflowTemplateInstallInput): Promise<WorkflowMutationResult>;
  /** Wizard: save node-level overrides via the in-session owner path. */
  saveWorkflowRecipe(input: WorkflowRecipeSaveInput): Promise<WorkflowMutationResult>;
  /** Wizard: delete a recipe via the in-session owner path (.bak backups and frozen instances kept). */
  deleteWorkflowRecipe(input: WorkflowRecipeDeleteInput): Promise<WorkflowMutationResult>;
  /** Wizard: start the workflow (owner checks + explicit ui.confirm inside the session). */
  startWorkflow(input: WorkflowStartInput): Promise<WorkflowMutationResult>;
  /** Wizard (S9-2): add or edit one tier in pao配置/档位.json (kernel backup + atomic write). */
  saveWorkflowTier(input: WorkflowTierSaveInput): Promise<WorkflowMutationResult>;
  /** 运行控制（只读）：主进程按已登记 workspaceId 解析项目，返回磁盘真值控制身份。 */
  getWorkflowControl(input: WorkflowControlQueryInput): Promise<WorkflowControlResult>;
  /** 运行控制（确认/暂停推进/恢复）：主进程复核 owner 与当前轮后直调内核，不收渲染层任意参数。 */
  controlWorkflow(input: WorkflowControlCommandInput): Promise<WorkflowControlCommandResult>;
  toggleWindowMaximize(): Promise<void>;
  openExternal(url: string): Promise<void>;
  getThemeMode(): Promise<"system" | "light" | "dark">;
  getResolvedTheme(): Promise<"light" | "dark">;
  setThemeMode(mode: "system" | "light" | "dark"): Promise<DesktopAppState>;
  /** Switches the UI language everywhere, including main-process menus and dialogs. */
  setLanguage(language: AppLanguage): Promise<DesktopAppState>;
  onThemeChanged(callback: (theme: "light" | "dark") => void): () => void;
  /** The window came back to the foreground, so outside changes (edits, git) may need rereading. */
  onWindowFocused(listener: () => void): () => void;
  relaunchApplication(): Promise<void>;
}
