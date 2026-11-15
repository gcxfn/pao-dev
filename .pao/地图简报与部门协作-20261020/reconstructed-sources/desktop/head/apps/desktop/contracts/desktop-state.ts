import type {
  ExtensionFlagValues,
  HostUiRequest,
  SessionConfig,
  SessionUsageSnapshot,
} from "@pi-gui/session-driver";
import type {
  ModelSettingsSnapshot,
  RuntimeCommandRecord,
  RuntimeSnapshot,
} from "@pi-gui/session-driver/runtime-types";
import type { SessionSchemaInfo } from "@pi-gui/session-driver";
export type { SessionSchemaInfo } from "@pi-gui/session-driver";
/** Mirrors @pi-gui/session-driver's SessionStatus; "stopping" spans a requested, unconfirmed cancel. */
export type SessionStatus = "idle" | "running" | "failed" | "stopping";
export type { SessionRole, TimelineToolCall, TranscriptMessage } from "./timeline-types";
import type { TranscriptMessage } from "./timeline-types";
import type { ScheduledTaskRecord } from "./scheduled-tasks";
export type {
  CreateScheduledTaskInput,
  ScheduledTaskFilter,
  ScheduledTaskRecord,
  ScheduledTaskSchedule,
  ScheduledTaskStatus,
  ScheduledTaskTarget,
  UpdateScheduledTaskInput,
} from "./scheduled-tasks";

export type AppView =
  | "threads"
  | "new-thread"
  | "scheduled"
  | "workboard"
  | "canvas"
  | "skills"
  | "extensions"
  | "settings";
export type AppLanguage = "en" | "zh";
export type WorkspaceKind = "primary" | "worktree";
export type WorktreeStatus = "ready" | "missing" | "error";
export type NewThreadEnvironment = "local" | "worktree";
export type ThemeMode = "system" | "light" | "dark";
export const themePresetIds = [
  "default",
  "catppuccin",
  "tokyo-night",
  "nord",
  "dracula",
  "gruvbox",
  "github",
  "vscode",
] as const;
export type ThemePresetId = (typeof themePresetIds)[number];
export type ModelSettingsScopeMode = "app-global" | "per-repo";
export type ThreadGrouping = "time" | "workspace";
/** 关闭最后一个窗口时的行为：直接退出（默认）或最小化到系统托盘。 */
export type CloseWindowBehavior = "quit" | "tray";
export const appLanguages = ["en", "zh"] as const;

export function isAppLanguage(value: unknown): value is AppLanguage {
  return value === "en" || value === "zh";
}

export function isCloseWindowBehavior(value: unknown): value is CloseWindowBehavior {
  return value === "quit" || value === "tray";
}

export function isThreadGrouping(value: unknown): value is ThreadGrouping {
  return value === "time" || value === "workspace";
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

export function isThemePresetId(value: unknown): value is ThemePresetId {
  return typeof value === "string" && themePresetIds.includes(value as ThemePresetId);
}
export type ComposerDraftSyncSource =
  | "state"
  | "selection"
  | "persist"
  | "remote-persist"
  | "command"
  | "extension-editor-text"
  | "queued-message-edit";

export interface NotificationPreferences {
  readonly backgroundCompletion: boolean;
  readonly backgroundFailure: boolean;
  readonly attentionNeeded: boolean;
}

export interface ComposerImageAttachment {
  readonly id: string;
  readonly kind: "image";
  readonly name: string;
  readonly mimeType: string;
  readonly data: string;
}

export interface ComposerFileAttachment {
  readonly id: string;
  readonly kind: "file";
  readonly name: string;
  readonly mimeType: string;
  readonly fsPath: string;
  readonly sizeBytes?: number;
}

export type ComposerAttachment = ComposerImageAttachment | ComposerFileAttachment;

export type QueuedComposerMessageMode = "steer" | "followUp";

export interface QueuedComposerMessage {
  readonly id: string;
  readonly mode: QueuedComposerMessageMode;
  readonly text: string;
  readonly attachments: readonly ComposerAttachment[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SessionRecord {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly pinnedAt?: string;
  readonly lastViewedAt?: string;
  readonly lastInteractedAt?: string;
  readonly archivedAt?: string;
  readonly preview: string;
  readonly status: SessionStatus;
  readonly runningSince?: string;
  /** Mirrors the driver snapshot: a cancel was requested and is not confirmed settled. */
  readonly cancellationRequested?: boolean;
  readonly hasUnseenUpdate: boolean;
  readonly config?: SessionConfig;
}

export type OrchestrationChildThreadStatus =
  "queued" | "running" | "waiting" | "complete" | "failed";
export type OrchestrationSupervisionGate = "continue" | "stop" | "wake";
export type OrchestrationSupervisionStatus = "monitoring" | "attention" | "stopped";
export type OrchestrationEvidenceKind =
  | "worker_report"
  | "orchestrator_acceptance"
  | "orchestrator_observation"
  | "orchestrator_action"
  | "command"
  | "review_finding"
  | "blocker";
export type OrchestrationEvidenceSource =
  | "worker-reported"
  | "orchestrator-accepted"
  | "orchestrator-observed"
  | "orchestrator-action"
  | "command"
  | "review"
  | "blocker";
export type OrchestrationEvidenceStatus =
  "reported" | "accepted" | "running" | "passed" | "failed" | "blocked";

export interface OrchestrationEvidenceGitRef {
  readonly workspaceId: string;
  readonly branchName?: string;
  readonly headSha?: string;
}

export interface OrchestrationEvidenceRecord {
  readonly id: string;
  readonly childThreadId: string;
  readonly kind: OrchestrationEvidenceKind;
  readonly source: OrchestrationEvidenceSource;
  readonly status: OrchestrationEvidenceStatus;
  readonly title: string;
  readonly detail?: string;
  readonly command?: string;
  readonly toolName?: string;
  readonly severity?: "P0" | "P1" | "P2" | "P3";
  readonly parentSessionId?: string;
  readonly childSessionId?: string;
  readonly git?: OrchestrationEvidenceGitRef;
  readonly createdAt: string;
  readonly updatedAt?: string;
}

export interface OrchestrationSupervisionLoop {
  readonly id: string;
  readonly status: OrchestrationSupervisionStatus;
  readonly gate: OrchestrationSupervisionGate;
  readonly intervalMs: number;
  readonly iterationCount: number;
  readonly lastCheckedAt: string;
  readonly nextRunAt?: string;
  readonly reason: string;
  readonly lastChildStatus: OrchestrationChildThreadStatus;
  readonly stoppedAt?: string;
}

export interface OrchestrationChildTranscriptMessage {
  readonly id: string;
  readonly role: "parent" | "child" | "system";
  readonly text: string;
  readonly createdAt: string;
}

export interface OrchestrationChildThread {
  readonly id: string;
  readonly sourceToolCallId?: string;
  readonly parentWorkspaceId: string;
  readonly parentSessionId: string;
  readonly childWorkspaceId: string;
  readonly childSessionId: string;
  readonly title: string;
  readonly goal: string;
  readonly status: OrchestrationChildThreadStatus;
  readonly latestTranscript: string;
  readonly transcript: readonly OrchestrationChildTranscriptMessage[];
  readonly evidence: readonly OrchestrationEvidenceRecord[];
  readonly supervisionLoop?: OrchestrationSupervisionLoop;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SendChildThreadFollowUpInput {
  readonly childThreadId: string;
  readonly text: string;
}

export interface SetChildSupervisionLoopInput {
  readonly childThreadId: string;
  readonly gate: Extract<OrchestrationSupervisionGate, "continue" | "stop">;
}

export interface SelectedTranscriptRecord {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly transcript: readonly TranscriptMessage[];
  // Session-file schema-version skew, when known. `writtenByNewerRuntime` drives the version-skew
  // notice; undefined until the (async, static-per-session) header read resolves.
  readonly schemaInfo?: SessionSchemaInfo;
}

/**
 * 流式期间全量 transcript 重发的增量替代：只携带变化的末条（同 id 替换或末尾追加），
 * 前缀仍以上次已发布的记录为准。主进程判定可增量时发它，否则回落全量记录。
 */
export interface SelectedTranscriptTailUpdate {
  readonly kind: "transcript-tail-update";
  readonly workspaceId: string;
  readonly sessionId: string;
  /** replace-last＝末条同 id 整条替换；append＝在已发布末尾之后追加此条 */
  readonly mode: "replace-last" | "append";
  readonly item: TranscriptMessage;
}

/** selectedTranscriptChanged 通道载荷：全量记录或尾部增量。 */
export type SelectedTranscriptUpdate = SelectedTranscriptRecord | SelectedTranscriptTailUpdate;

/** 载荷分派守卫：全量记录没有 kind 字段，尾部增量以 kind 判别。 */
export function isTranscriptTailUpdate(value: unknown): value is SelectedTranscriptTailUpdate {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly kind?: unknown }).kind === "transcript-tail-update"
  );
}

export interface WorktreeRecord {
  readonly id: string;
  readonly rootWorkspaceId: string;
  readonly linkedWorkspaceId?: string;
  readonly name: string;
  readonly path: string;
  readonly status: WorktreeStatus;
  readonly branchName?: string;
  readonly updatedAt: string;
}

export interface SessionExtensionStatusRecord {
  readonly key: string;
  readonly text: string;
}

export interface SessionExtensionWidgetRecord {
  readonly key: string;
  readonly lines: readonly string[];
  readonly placement: "aboveComposer" | "belowComposer";
}

export type SessionExtensionDialogRecord = Extract<
  HostUiRequest,
  { readonly kind: "confirm" | "select" | "input" | "editor" }
>;

export interface SessionExtensionNoticeRecord {
  readonly id: string;
  readonly level: "info" | "warning" | "error";
  readonly message: string;
  readonly createdAt: string;
}

export interface SessionExtensionUiStateRecord {
  readonly instanceId: string;
  readonly statuses: readonly SessionExtensionStatusRecord[];
  readonly widgets: readonly SessionExtensionWidgetRecord[];
  readonly pendingDialogs: readonly SessionExtensionDialogRecord[];
  /** `ctx.ui.notify` toasts, newest last. Main caps and expires them; the renderer only draws them. */
  readonly notices: readonly SessionExtensionNoticeRecord[];
  readonly title?: string;
  readonly editorText?: string;
}

export type ExtensionCommandCompatibilityStatus = "supported" | "terminal-only";

export interface ExtensionCommandCompatibilityRecord {
  readonly commandName: string;
  readonly extensionPath: string;
  readonly status: ExtensionCommandCompatibilityStatus;
  readonly message: string;
  readonly capability: string;
  readonly updatedAt: string;
}

export interface WorkspaceRecord {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly lastOpenedAt: string;
  readonly kind: WorkspaceKind;
  readonly rootWorkspaceId?: string;
  readonly branchName?: string;
  readonly sessions: readonly SessionRecord[];
}

export interface CreateWorktreeInput {
  readonly workspaceId: string;
  readonly fromSessionWorkspaceId?: string;
  readonly fromSessionId?: string;
}

export type StartThreadInput = {
  readonly rootWorkspaceId: string;
  readonly environment: NewThreadEnvironment;
  readonly prompt?: string;
  readonly attachments?: readonly ComposerAttachment[];
  readonly provider?: string;
  readonly modelId?: string;
  readonly thinkingLevel?: string;
  /**
   * The flag values chosen for this thread, `false` and empty strings included so
   * they are remembered as the workspace's next defaults. Main checks them against
   * the flags the workspace's extensions registered before pi sees them.
   */
  readonly extensionFlags?: ExtensionFlagValues;
};

export type ForkThreadPosition = "before" | "at" | "after";

export type ForkThreadInput = {
  readonly sourceWorkspaceId: string;
  readonly sourceSessionId: string;
  /** Root workspace used as the base when forking into a new worktree. */
  readonly rootWorkspaceId: string;
  /** "local" forks into the source workspace; "worktree" creates a new worktree. */
  readonly environment: NewThreadEnvironment;
  /** ID of the rendered transcript message selected as the fork point, when it maps to a session entry. */
  readonly sourceMessageId?: string;
  /** 0-based index of the rendered transcript message selected as the fork point. */
  readonly sourceMessageIndex?: number;
  /** 0-based rendered user-message index kept as a fallback for older callers. */
  readonly userMessageIndex?: number;
  readonly position?: ForkThreadPosition;
};

export interface RemoveWorktreeInput {
  readonly workspaceId: string;
  readonly worktreeId: string;
}

export interface StartupDiagnostic {
  readonly scope: "application" | "workspace";
  readonly message: string;
  readonly workspacePath?: string;
}

export interface DesktopAppState {
  readonly workspaces: readonly WorkspaceRecord[];
  readonly worktreesByWorkspace: Readonly<Record<string, readonly WorktreeRecord[]>>;
  readonly selectedWorkspaceId: string;
  readonly selectedSessionId: string;
  readonly activeView: AppView;
  readonly composerDraft: string;
  readonly composerDraftSyncSource: ComposerDraftSyncSource;
  readonly composerDraftSyncNonce: number;
  readonly composerAttachments: readonly ComposerAttachment[];
  readonly queuedComposerMessages: readonly QueuedComposerMessage[];
  readonly editingQueuedMessageId?: string;
  readonly runtimeByWorkspace: Readonly<Record<string, RuntimeSnapshot>>;
  readonly sessionCommandsBySession: Readonly<Record<string, readonly RuntimeCommandRecord[]>>;
  /** Context, cache and usage for open sessions; absent until pi reports it. */
  readonly sessionUsageBySession: Readonly<Record<string, SessionUsageSnapshot>>;
  readonly sessionExtensionUiBySession: Readonly<Record<string, SessionExtensionUiStateRecord>>;
  readonly extensionCommandCompatibilityByWorkspace: Readonly<
    Record<string, readonly ExtensionCommandCompatibilityRecord[]>
  >;
  /** Flag values last chosen for a new thread in each root workspace: the next thread's defaults. */
  readonly extensionFlagsByWorkspace: Readonly<Record<string, ExtensionFlagValues>>;
  /** Flag values each thread's pi session started with (only the ones pi receives). */
  readonly extensionFlagsBySession: Readonly<Record<string, ExtensionFlagValues>>;
  readonly orchestrationChildren: readonly OrchestrationChildThread[];
  readonly scheduledTasks: readonly ScheduledTaskRecord[];
  /** 画布工作流页签的正式元数据；草稿与未保存内容不进这里。 */
  readonly workflowTabs: readonly WorkflowTabRecord[];
  readonly activeWorkflowTabId: string;
  readonly notificationPreferences: NotificationPreferences;
  readonly integratedTerminalShell: string;
  readonly lastViewedAtBySession: Readonly<Record<string, string>>;
  readonly lastInteractedAtBySession: Readonly<Record<string, string>>;
  readonly pinnedAtBySession: Readonly<Record<string, string>>;
  readonly pinnedSessionOrder: readonly string[];
  readonly workspaceOrder: readonly string[];
  readonly modelSettingsScopeMode: ModelSettingsScopeMode;
  readonly globalModelSettings: ModelSettingsSnapshot;
  readonly themeMode: ThemeMode;
  readonly themePresetId: ThemePresetId;
  /** UI language for renderer chrome and main-process menus/dialogs. */
  readonly language: AppLanguage;
  readonly sidebarCollapsed: boolean;
  readonly threadGrouping: ThreadGrouping;
  /** Folder groups the user collapsed in the sidebar, by workspace id. */
  readonly collapsedWorkspaceIds: readonly string[];
  readonly enableTransparency: boolean;
  /** PAO 主目录设置值；空串表示未配置（回落到 PAO_HOME 环境变量）。 */
  readonly paoHome: string;
  /** 关闭最后一个窗口时的行为；默认直接退出。 */
  readonly closeWindowBehavior: CloseWindowBehavior;
  readonly startupDiagnostics: readonly StartupDiagnostic[];
  readonly revision: number;
  readonly lastError?: string;
}

export interface CreateSessionInput {
  readonly workspaceId: string;
  readonly title?: string;
}

export interface WorkspaceSessionTarget {
  readonly workspaceId: string;
  readonly sessionId: string;
}

/** 画布工作流页签的形态：edit 是配方编辑，runtime 是运行中的实例。 */
export type WorkflowTabMode = "edit" | "runtime";

/**
 * 画布工作流页签的正式元数据。草稿、dirty 标记和未保存的画布内容只留在渲染层内存，
 * 不进这里，也不参与持久化。
 */
export interface WorkflowTabRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly recipeName?: string;
  readonly instanceName?: string;
  /**
   * 运行页签绑定的实例清单绝对路径；同名多实例时用它精确定位运行控制查询。
   * 路径只与磁盘发现行比较，不按它读盘。
   */
  readonly instancePath?: string;
  /** 运行页签绑定的会话；主进程按它决定激活哪个会话。 */
  readonly controller?: WorkspaceSessionTarget;
  /**
   * 画布上当前选中的元素，供切标签/重启后恢复：节点用名字原文；连线用 `edge:` 前缀加
   * JSON `[from,to,review]` 编码（review 为布尔）。仅渲染层解释，不属于草稿内容。
   */
  readonly selectedElementId?: string;
  readonly mode: WorkflowTabMode;
}

export interface SetWorkflowTabsInput {
  readonly workflowTabs: readonly WorkflowTabRecord[];
  readonly activeWorkflowTabId: string;
}

export interface CreateWorkflowControllerInput extends CreateSessionInput {
  /** 非空时把新建的会话绑定成该工作流页签的 controller。 */
  readonly tabId?: string;
}

export function createEmptyDesktopAppState(): DesktopAppState {
  return {
    workspaces: [],
    worktreesByWorkspace: {},
    selectedWorkspaceId: "",
    selectedSessionId: "",
    activeView: "threads",
    composerDraft: "",
    composerDraftSyncSource: "state",
    composerDraftSyncNonce: 0,
    composerAttachments: [],
    queuedComposerMessages: [],
    runtimeByWorkspace: {},
    sessionCommandsBySession: {},
    sessionUsageBySession: {},
    sessionExtensionUiBySession: {},
    extensionCommandCompatibilityByWorkspace: {},
    extensionFlagsByWorkspace: {},
    extensionFlagsBySession: {},
    orchestrationChildren: [],
    scheduledTasks: [],
    workflowTabs: [],
    activeWorkflowTabId: "",
    notificationPreferences: {
      backgroundCompletion: true,
      backgroundFailure: true,
      attentionNeeded: true,
    },
    integratedTerminalShell: "",
    lastViewedAtBySession: {},
    lastInteractedAtBySession: {},
    pinnedAtBySession: {},
    pinnedSessionOrder: [],
    workspaceOrder: [],
    modelSettingsScopeMode: "app-global",
    globalModelSettings: {
      enabledModelPatterns: [],
    },
    themeMode: "system",
    themePresetId: "default",
    language: "en",
    sidebarCollapsed: false,
    threadGrouping: "time",
    collapsedWorkspaceIds: [],
    enableTransparency: false,
    paoHome: "",
    closeWindowBehavior: "quit",
    startupDiagnostics: [],
    revision: 0,
  };
}

export function getSelectedWorkspace(state: DesktopAppState): WorkspaceRecord | undefined {
  return state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId);
}

export interface DesktopAppViewState {
  readonly selectedWorkspaceId?: string;
  readonly selectedSessionId?: string;
  readonly activeView?: AppView;
  readonly sidebarCollapsed?: boolean;
}

export function getSelectedSession(state: DesktopAppState): SessionRecord | undefined {
  return getSelectedWorkspace(state)?.sessions.find(
    (session) => session.id === state.selectedSessionId,
  );
}

/**
 * 反查索引（S4-1②）：会话 → 绑定它为 controller 的工作流标签。
 * 纯派生——每次从标签表现算，不另建存储；workspace 与 sessionId 都匹配才命中。
 */
export function workflowTabForSession(
  tabs: readonly WorkflowTabRecord[],
  target: { readonly workspaceId: string; readonly sessionId: string },
): WorkflowTabRecord | undefined {
  return tabs.find(
    (tab) =>
      tab.controller?.workspaceId === target.workspaceId &&
      tab.controller.sessionId === target.sessionId,
  );
}
