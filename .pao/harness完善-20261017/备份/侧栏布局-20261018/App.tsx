import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import {
  getSelectedSession,
  getSelectedWorkspace,
  type AppView,
  type CreateScheduledTaskInput,
} from "../../contracts/desktop-state";
import {
  nonCompletedBindingForSession,
  scheduledOriginsByMessageId,
} from "../../contracts/scheduled-tasks";
import { updateSnapshot, useDesktopAppState, type DesktopAppSession } from "./desktop-app-state";
import { DesktopStartupSurface, toStartupSurfaceState } from "./desktop-recovery";
import { buildFileWorkbenchContexts } from "./file-workbench-contexts";
import { canTogglePrimarySidebar } from "./app-shell-utils";
import { useDesktopCommands } from "./use-desktop-commands";
import { useRunningLabel } from "../features/conversation/hooks/use-running-label";
import { useTimelineViewport } from "../features/conversation/hooks/use-timeline-viewport";
import {
  buildDisplayTimelineItems,
  refreshFirstRunChecklist,
} from "../features/conversation/timeline-turns";
import { useTurnChanges } from "../features/conversation/hooks/use-turn-changes";
import { formatRelativeTime } from "../lib/string-utils";
import { restoreTopmostDialogFocus } from "../ui/dialog-focus";
import { ComposerPanel } from "../features/conversation/composer-panel";
import { DiffPanel } from "../features/workbench/diff-panel";
import type { DiffPanelFileRequest } from "../features/workbench/diff-panel-types";
import { FileWorkbench } from "../features/workbench/file-workbench";
import { useWorkbench } from "../features/workbench/use-workbench";
import {
  ExtensionViewPanel,
  type ExtensionViewTheme,
} from "../features/extensions/extension-view-panel";
import { useExtensionViews } from "../features/extensions/use-extension-views";
import { useExtensionCardActions } from "../features/extensions/use-extension-card-actions";
import { useExtensionHostActions } from "../features/extensions/use-extension-host-actions";
import { useExtensionToolLabels } from "../features/extensions/extension-tool-labels";
import { useSidePanelTabHintsVisible } from "../features/workbench/side-panel-tab-hints";
import { Workbench } from "../features/workbench/workbench";
import { renderBuiltinToolPanel } from "../features/workbench/builtin-tools";
import { useWorkbenchWidth } from "../features/workbench/use-workbench-width";
import type { WorkspaceFileLine } from "../features/conversation/workspace-file-line";
import { buildModelOptions } from "../features/conversation/composer-commands";
import { getDesktopShortcutLabel } from "../../contracts/ipc";
import { CommandPaletteSurface } from "../features/command-palette/command-palette-surface";
import { deriveModelOnboardingState } from "../features/settings/model-onboarding";
import type { SettingsSection } from "../features/settings/settings-view";
import { SecondarySurfaces } from "./secondary-surfaces";
import { NewThreadView } from "../features/threads/new-thread-view";
import {
  buildThreadSidebarModel,
  sessionThreadKey,
  type ThreadListEntry,
} from "../features/threads/thread-groups";
import { Sidebar, type ExtensionSurfaceId } from "../features/threads/sidebar";
import { ThreadSwitcher } from "../features/threads/thread-switcher";
import {
  loadThreadSwitcherOrder,
  orderThreadSwitcherEntries,
  saveThreadSwitcherOrder,
  touchThreadSwitcherOrder,
} from "../features/threads/thread-switcher-order";
import { useThreadSwitcher } from "../features/threads/hooks/use-thread-switcher";
import { SidebarToggleButton } from "../features/threads/sidebar-toggle-button";
import { Topbar } from "./topbar";
import { TerminalPanel } from "../features/workbench/terminal-panel";
import { ConversationTimeline } from "../features/conversation/conversation-timeline";
import { ScheduledTasksView } from "../features/scheduled-tasks/scheduled-tasks-view";
import { KanbanPage } from "../features/workboard/kanban-page";
import { WorkflowSurface } from "../features/workflow-cards/workflow-surface";
import { WorkspaceEmptyPanel } from "../features/threads/workspace-empty-panel";
import {
  ScheduledTaskEditor,
  type ScheduledEditorState,
} from "../features/scheduled-tasks/scheduled-task-editor";
import { ScheduledTaskChip } from "../features/scheduled-tasks/scheduled-task-chip";
import { useSlashMenu } from "../features/conversation/hooks/use-slash-menu";
import { useMentionMenu } from "../features/conversation/hooks/use-mention-menu";
import { useThreadSearch } from "../features/conversation/hooks/use-thread-search";
import { useWorkspaceMenu } from "../features/threads/hooks/use-workspace-menu";
import { useThreadActions } from "../features/threads/hooks/use-thread-actions";
import { ThreadActionsMenu } from "../features/threads/thread-actions";
import { useNewThreadController } from "../features/threads/hooks/use-new-thread-controller";
import {
  buildExtensionDockModel,
  ExtensionDialog,
  hasExtensionDockContent,
  useDismissibleExtensionDock,
} from "../features/extensions/extension-session-ui";
import { PinnedCards, usePinnedCards } from "../features/extensions/pinned-cards";
import { TreeModal } from "../features/conversation/tree-modal";
import { ForkModal } from "../features/conversation/fork-modal";
import { getEffectiveModelRuntime } from "../features/settings/model-settings";
import { applyTheme, getActiveTheme, useActiveTheme } from "../ui/active-theme";
import { I18nProvider, useI18n } from "../i18n/react";
import { deriveWorkspaceContext } from "./workspace-context";
import { useTreeForkModals } from "../features/conversation/hooks/use-tree-fork-modals";
import { useComposerDraftSync } from "../features/conversation/hooks/use-composer-draft-sync";
import { useMasterControlHandover } from "../features/workflow-cards/use-master-control-handover";
import { useSessionComposer } from "../features/conversation/hooks/use-session-composer";
import { useTranscriptAnnotations } from "../features/conversation/annotations/use-transcript-annotations";

/**
 * 侧栏「部门详情 / 流程面板」入口 -> driver 注册的扩展视图 id。
 * 这两个 id 是正式注册标识（计划 §12.2 保留 view ID），界面只按 id 到会话的扩展目录里找，
 * extensionId 从目录反查，不把 driver 的注册细节硬编进界面。
 */
const EXTENSION_SURFACE_VIEW_IDS = {
  "department-detail": "pao",
  "flow-panel": "pao-flow",
} as const;

export default function App() {
  const desktop = useDesktopAppState();
  // Before the first snapshot the UI shows the English startup surface.
  const language = desktop.snapshot?.language ?? "en";
  return (
    <I18nProvider language={language}>
      <AppShell desktop={desktop} />
    </I18nProvider>
  );
}

function AppShell({ desktop }: { readonly desktop: DesktopAppSession }) {
  const { t } = useI18n();
  const workbenchWidth = useWorkbenchWidth();
  const snapshot = desktop.snapshot;
  const setSnapshot = desktop.setSnapshot;
  const selectedTranscript = desktop.selectedTranscript;
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [settingsWorkspaceId, setSettingsWorkspaceId] = useState("");
  const [skillsWorkspaceId, setSkillsWorkspaceId] = useState("");
  const [extensionsWorkspaceId, setExtensionsWorkspaceId] = useState("");
  // Unknown until main answers; until then the theme from the last launch stays.
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark" | null>(null);
  const [dockExpandedBySession, setDockExpandedBySession] = useState<Record<string, string>>({});
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const timelinePaneRef = useRef<HTMLDivElement | null>(null);
  const [dismissedSchemaSkewSessionKeys, setDismissedSchemaSkewSessionKeys] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [diffFileRequest, setDiffFileRequest] = useState<{
    readonly sessionKey: string;
    readonly request: DiffPanelFileRequest;
  } | null>(null);
  const [scheduledEditor, setScheduledEditor] = useState<ScheduledEditorState | null>(null);
  /** sidebar 工作流入口信号（S4-2）：每次点击自增；步骤卡工作台据此重新取数。不持久化。 */
  const [workflowEntryNonce, setWorkflowEntryNonce] = useState(0);
  const [workflowFocus, setWorkflowFocus] = useState<{ instanceId: string; nodeName: string }>();
  const api = window.piApp;

  useEffect(() => {
    const piApi = window.piApp;
    if (!piApi) return;

    void piApi
      .getResolvedTheme()
      .then((theme) => {
        setResolvedTheme(theme);
      })
      .catch((error: unknown) => {
        console.error("[renderer] getResolvedTheme failed", error);
        // Keep the variant painted at startup so preset changes still apply.
        setResolvedTheme((current) => current ?? getActiveTheme().variant);
      });

    const unsub = piApi.onThemeChanged((theme) => {
      setResolvedTheme(theme);
    });

    return unsub;
  }, []);

  useEffect(() => {
    const themePresetId = snapshot?.themePresetId;
    if (!resolvedTheme || !themePresetId) return;
    applyTheme(themePresetId, resolvedTheme);
  }, [resolvedTheme, snapshot?.themePresetId]);

  useEffect(() => {
    document.documentElement.classList.toggle(
      "enable-transparency",
      snapshot?.enableTransparency ?? false,
    );
  }, [snapshot?.enableTransparency]);

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

  const {
    activeWorktrees,
    linkedWorktreeByWorkspaceId,
    rootWorkspace,
    rootWorkspaceOptions,
    selectedWorkspace,
    visibleWorkspaces,
  } = useMemo(() => deriveWorkspaceContext(snapshot), [snapshot]);
  const selectedSession = snapshot
    ? (getSelectedSession(snapshot) ?? selectedWorkspace?.sessions[0])
    : undefined;
  const selectedRuntime = selectedWorkspace
    ? snapshot?.runtimeByWorkspace[selectedWorkspace.id]
    : undefined;
  const extensionToolLabels = useExtensionToolLabels(selectedRuntime);
  const selectedModelRuntime = snapshot
    ? getEffectiveModelRuntime(snapshot, selectedWorkspace)
    : undefined;
  const selectedWorktree = selectedWorkspace
    ? linkedWorktreeByWorkspaceId.get(selectedWorkspace.id)
    : undefined;
  const selectedModelOptions = buildModelOptions(selectedModelRuntime);
  const selectedDefaultEnabled = selectedModelOptions.some(
    (m) =>
      m.providerId === selectedModelRuntime?.settings.defaultProvider &&
      m.modelId === selectedModelRuntime?.settings.defaultModelId,
  );
  const resolvedSessionProvider =
    selectedSession?.config?.provider ??
    (selectedDefaultEnabled ? selectedModelRuntime?.settings.defaultProvider : undefined);
  const resolvedSessionModelId =
    selectedSession?.config?.modelId ??
    (selectedDefaultEnabled ? selectedModelRuntime?.settings.defaultModelId : undefined);
  const resolvedSessionThinkingLevel =
    selectedSession?.config?.thinkingLevel ?? selectedModelRuntime?.settings.defaultThinkingLevel;
  const selectedSessionModelOnboarding = deriveModelOnboardingState(selectedModelRuntime, {
    provider: resolvedSessionProvider,
    modelId: resolvedSessionModelId,
  });
  const queuedComposerMessages = snapshot?.queuedComposerMessages ?? [];
  const editingQueuedMessageId = snapshot?.editingQueuedMessageId;
  const runningLabel = useRunningLabel(
    selectedSession?.status === "running" ? selectedSession.runningSince : undefined,
  );
  const selectedSessionKey =
    selectedWorkspace && selectedSession ? `${selectedWorkspace.id}:${selectedSession.id}` : "";
  const workbenchTarget = useMemo(
    () =>
      selectedWorkspace && selectedSession
        ? { workspaceId: selectedWorkspace.id, sessionId: selectedSession.id }
        : null,
    [selectedWorkspace?.id, selectedSession?.id],
  );
  const {
    composerDraft,
    setComposerDraft,
    composerDraftRef,
    flushComposerDraft,
    flushComposerDraftAsync,
  } = useComposerDraftSync({ api, snapshot, selectedSession: workbenchTarget });
  // 页面交给主控的那句话：输入框空着就直接放进去，非空则暂存等用户决定，绝不覆盖他打的字（计划 §7.2）。
  // focusComposer 定义在后面，这里用 ref 间接引用，避免把它的声明顺序变成依赖。
  const focusComposerRef = useRef<(() => void) | undefined>(undefined);
  const mainControlHandover = useMasterControlHandover({
    readDraft: () => composerDraftRef.current,
    writeDraft: useCallback(
      (text: string) => {
        setComposerDraft(text);
        focusComposerRef.current?.();
      },
      [setComposerDraft],
    ),
  });
  const extensionViews = useExtensionViews({ api, target: workbenchTarget });
  const workbench = useWorkbench({ api, target: workbenchTarget });
  // Tracked while the panel is closed too, so a chord that opens it shows the hints.
  const sidePanelTabHintsVisible = useSidePanelTabHintsVisible(api?.platform ?? "linux");
  const workbenchTargetRef = useRef(workbenchTarget);
  workbenchTargetRef.current = workbenchTarget;
  const extensionHostActions = useExtensionHostActions({
    api,
    target: workbenchTarget,
    workbench,
    flushComposerDraftAsync,
  });
  const activeTool = workbench.activeTool;
  const activeExtensionView =
    activeTool?.kind === "extension"
      ? extensionViews.views.find(
          (view) => view.extensionId === activeTool.extensionId && view.id === activeTool.viewId,
        )
      : undefined;
  const workbenchRef = useRef(workbench);
  workbenchRef.current = workbench;
  const selectedToolId =
    workbench.view.selection.kind === "tool" ? workbench.view.selection.toolId : null;
  const sidePanelAvailable = snapshot?.activeView === "threads" && Boolean(workbenchTarget);
  const sidePanelVisible = sidePanelAvailable && workbench.view.visibility === "visible";
  const selectedTranscriptForSession =
    selectedTranscript &&
    selectedWorkspace &&
    selectedSession &&
    selectedTranscript.workspaceId === selectedWorkspace.id &&
    selectedTranscript.sessionId === selectedSession.id
      ? selectedTranscript
      : null;
  const sourceTranscript = selectedTranscriptForSession?.transcript;
  const activeTranscript = useMemo(
    () => refreshFirstRunChecklist(sourceTranscript ?? []),
    [sourceTranscript],
  );
  const pins = usePinnedCards(selectedSessionKey, activeTranscript);
  const scheduledOrigins = useMemo(() => {
    if (!snapshot || !selectedWorkspace || !selectedSession) {
      return new Map();
    }
    return scheduledOriginsByMessageId(
      snapshot.scheduledTasks,
      selectedWorkspace.id,
      selectedSession.id,
      pins.timeline,
    );
  }, [pins.timeline, selectedSession, selectedWorkspace, snapshot]);
  const scheduledBinding = selectedSession
    ? nonCompletedBindingForSession(snapshot?.scheduledTasks ?? [], selectedSession.id)
    : undefined;
  const transcriptHydration = desktop.view.kind === "ready" ? desktop.view.transcript : undefined;
  const transcriptFailed = transcriptHydration?.kind === "failed" ? transcriptHydration : null;
  const isTranscriptLoading =
    Boolean(selectedSession) && !selectedTranscriptForSession && !transcriptFailed;
  const selectedSessionRunning = selectedSession?.status === "running";
  const turnChanges = useTurnChanges({
    api,
    target: workbenchTarget,
    running: selectedSessionRunning,
    workbench,
  });
  const timelineRows = useMemo(
    () =>
      buildDisplayTimelineItems(pins.timeline, {
        lastTurnRunning: selectedSessionRunning,
        turnChanges: turnChanges.turns,
      }),
    [pins.timeline, selectedSessionRunning, turnChanges.turns],
  );
  const viewport = useTimelineViewport({
    sessionKey: selectedSessionKey,
    rows: timelineRows,
    // 画布内嵌主控面板与 threads 共用同一视口实例：active 一并纳入 canvas（S4-1⑥，
    // W bug6）——否则画布内新消息不跟随、上翻历史被抢滚动。
    active:
      (snapshot?.activeView === "threads" || snapshot?.activeView === "canvas") &&
      Boolean(selectedSession),
    transcriptReady: !isTranscriptLoading && !transcriptFailed,
    paneRef: timelinePaneRef,
  });
  const threadSearch = useThreadSearch(
    timelinePaneRef,
    viewport.navigateToElement,
    viewport.setSearchMode,
  );
  const showSchemaSkewNotice =
    selectedTranscriptForSession?.schemaInfo?.writtenByNewerRuntime === true &&
    Boolean(selectedSessionKey) &&
    !dismissedSchemaSkewSessionKeys.has(selectedSessionKey);
  const selectedSessionCommands = selectedSession
    ? (snapshot?.sessionCommandsBySession[selectedSessionKey] ?? [])
    : [];
  const selectedExtensionUi = selectedSession
    ? snapshot?.sessionExtensionUiBySession[selectedSessionKey]
    : undefined;
  const selectedWorkspaceCommandCompatibility = selectedWorkspace
    ? (snapshot?.extensionCommandCompatibilityByWorkspace[selectedWorkspace.id] ?? [])
    : [];
  const fileWorkbenchContexts = useMemo(
    () =>
      buildFileWorkbenchContexts({
        workspaces: snapshot?.workspaces ?? [],
        selectedWorkspace,
        selectedSessionTitle: selectedExtensionUi?.title || selectedSession?.title,
        rootWorkspace,
        activeWorktrees,
      }),
    [
      activeWorktrees,
      rootWorkspace,
      selectedExtensionUi?.title,
      selectedSession?.title,
      selectedWorkspace,
      snapshot?.workspaces,
    ],
  );
  const selectedExtensionDock = useMemo(
    // PAO 自己注册的扩展块给中文标题；没有条目的扩展键原样显示（阶段 6 §8.1 第 9 项）。
    () => buildExtensionDockModel(selectedExtensionUi, (key) => t(key)),
    [selectedExtensionUi, t],
  );
  const shownExtensionDock = useDismissibleExtensionDock(
    selectedSessionKey,
    selectedExtensionUi,
    selectedExtensionDock,
  );
  const displayedSessionTitle = selectedExtensionUi?.title ?? selectedSession?.title ?? "";
  const activeExtensionDialog = selectedExtensionUi?.pendingDialogs[0];
  const selectedExtensionUiInstance =
    snapshot?.sessionExtensionUiBySession[selectedSessionKey]?.instanceId;
  const isSelectedExtensionDockExpanded =
    selectedExtensionUiInstance !== undefined &&
    dockExpandedBySession[selectedSessionKey] === selectedExtensionUiInstance;
  const threadSidebarModel = useMemo(
    () => (snapshot ? buildThreadSidebarModel(snapshot) : undefined),
    [snapshot],
  );
  const threadSidebarModelRef = useRef(threadSidebarModel);
  threadSidebarModelRef.current = threadSidebarModel;
  const threadOnScreenKey = snapshot?.activeView === "threads" ? selectedSessionKey : "";
  const threadOnScreenKeyRef = useRef(threadOnScreenKey);
  threadOnScreenKeyRef.current = threadOnScreenKey;
  const selectThreadRef = useRef<(target: { workspaceId: string; sessionId: string }) => void>(
    () => {},
  );
  useEffect(() => {
    // Opening a thread is use; sending always happens in the thread on screen.
    if (!threadOnScreenKey) return;
    saveThreadSwitcherOrder(touchThreadSwitcherOrder(loadThreadSwitcherOrder(), threadOnScreenKey));
  }, [threadOnScreenKey]);
  const threadSwitcher = useThreadSwitcher({
    readSource: () => {
      const currentKey = threadOnScreenKeyRef.current;
      const stored = loadThreadSwitcherOrder();
      // Another window may have used a thread since this one did.
      const order = currentKey ? touchThreadSwitcherOrder(stored, currentKey) : stored;
      const recencyOrder = threadSidebarModelRef.current?.recencyOrder ?? [];
      const entries = orderThreadSwitcherEntries(recencyOrder, order);
      const first = entries[0];
      return {
        entries,
        firstIsCurrent: first !== undefined && sessionThreadKey(first) === currentKey,
      };
    },
    onSelect: (entry) =>
      selectThreadRef.current({ workspaceId: entry.workspaceId, sessionId: entry.session.id }),
  });
  const threadShortcutOrderRef = useRef<readonly ThreadListEntry[] | null>(null);
  const focusComposer = () => {
    window.requestAnimationFrame(() => {
      if (restoreTopmostDialogFocus()) {
        return;
      }
      composerRef.current?.focus();
    });
  };
  focusComposerRef.current = focusComposer;
  /**
   * 页面请求主控办事：交给 handover 决定「直接放进空输入框」还是「暂存等用户决定」。
   * 返回值让页面照实说结果（放进去了 / 暂存了），不能一律报「已交给主控」。
   */
  const handoverToMainControl = useCallback(
    (text: string, label?: string) => mainControlHandover.handover(text, { label }),
    [mainControlHandover],
  );
  const handleViewFileInDiff = useCallback((path: string) => {
    const workspace = selectedWorkspaceRef.current;
    if (!workspace) return;
    const current = workbenchRef.current;
    current.setChanges({
      workspaceId: workspace.id,
      selectedPath: path,
      scope: { kind: "uncommitted" },
    });
    current.openTool({ kind: "changes" });
    setDiffFileRequest({
      sessionKey: selectedSessionKeyRef.current,
      request: { workspaceId: workspace.id, path, nonce: Date.now() },
    });
  }, []);
  const selectedSessionKeyRef = useRef(selectedSessionKey);
  selectedSessionKeyRef.current = selectedSessionKey;
  const selectedWorkspaceRef = useRef(selectedWorkspace);
  selectedWorkspaceRef.current = selectedWorkspace;
  // Snapshot ticks replace selectedWorkspace. A new callback identity reparses every
  // visible assistant message and drops stick-to-bottom while a reply is streaming.
  const handleOpenWorkspaceFileLine = useCallback(
    (target: WorkspaceFileLine) => {
      const workspace = selectedWorkspaceRef.current;
      if (!api || !workspace) {
        return;
      }
      void workbenchRef.current
        .openFile({
          workspaceId: workspace.id,
          path: target.path,
          line: target.line,
          endLine: target.endLine,
        })
        .catch(() => {
          // Missing, unreadable, or outside the workspace: leave the panel unchanged.
        });
    },
    [api],
  );
  const runExtensionCardAction = useExtensionCardActions({
    api,
    target: workbenchTarget,
    openWorkspaceFileLine: handleOpenWorkspaceFileLine,
    composerDraftRef,
    setComposerDraft,
    focusComposer,
  });

  const dismissSchemaSkewNotice = useCallback((sessionKey: string) => {
    setDismissedSchemaSkewSessionKeys((current) => {
      if (current.has(sessionKey)) {
        return current;
      }
      const next = new Set(current);
      next.add(sessionKey);
      return next;
    });
  }, []);

  const openSettings = (workspaceId?: string, section?: SettingsSection) => {
    if (!api) {
      return;
    }
    const nextWorkspaceId =
      workspaceId && rootWorkspaceOptions.some((workspace) => workspace.id === workspaceId)
        ? workspaceId
        : settingsWorkspaceId || rootWorkspaceOptions[0]?.id || "";
    if (nextWorkspaceId) {
      setSettingsWorkspaceId(nextWorkspaceId);
    }
    if (section) {
      setSettingsSection(section);
    }
    void updateSnapshot(setSnapshot, () => api.setActiveView("settings")).catch(
      (error: unknown) => {
        console.error("[renderer] setActiveView failed", error);
      },
    );
  };

  const {
    treeModalState,
    forkModalState,
    closeTreeModal,
    openTreeModal,
    navigateTreeSelection,
    closeForkModal,
    openForkModal,
    handleForkSubmit,
    canUseWorktree,
  } = useTreeForkModals({
    api,
    snapshot,
    setSnapshot,
    selectedWorkspace,
    selectedSession,
    selectedSessionKey,
    rootWorkspace,
    activeView: snapshot?.activeView,
    setComposerDraft,
    focusComposer,
  });

  const slashMenu = useSlashMenu({
    composerDraft,
    setComposerDraft,
    selectedRuntime,
    selectedModelRuntime,
    sessionCommands: selectedSessionCommands,
    commandCompatibility: selectedWorkspaceCommandCompatibility,
    selectedSessionKey,
    selectedSession,
    selectedWorkspace,
    isRunning: selectedSession?.status === "running",
    api,
    setSnapshot,
    focusComposer,
    openSettings,
    updateSnapshot,
    allowTreeCommand: true,
    onRunTreeCommand: openTreeModal,
  });

  const enableSelectedMentionExtension = useCallback(
    (filePath: string) => {
      if (!api || !selectedWorkspace) {
        return Promise.resolve();
      }
      return updateSnapshot(setSnapshot, () =>
        api.setExtensionEnabled(selectedWorkspace.id, filePath, true),
      ).then(() => undefined);
    },
    [api, selectedWorkspace],
  );

  const mentionMenu = useMentionMenu({
    composerDraft,
    setComposerDraft,
    composerRef,
    workspaceId: selectedWorkspace?.id,
    runtime: selectedRuntime,
    api,
    onEnableExtension: enableSelectedMentionExtension,
  });

  const wsMenu = useWorkspaceMenu({
    api,
    setSnapshot,
    updateSnapshot,
  });
  const threadMenu = useThreadActions({
    api,
    setSnapshot,
    updateSnapshot,
    scheduledTasks: snapshot?.scheduledTasks ?? [],
    sidebarCollapsed: snapshot?.sidebarCollapsed ?? false,
    openScheduledEditor: setScheduledEditor,
    flushComposerDraft,
  });

  const newThread = useNewThreadController({
    api,
    snapshot,
    setSnapshot,
    rootWorkspace,
    rootWorkspaceOptions,
    visibleWorkspaces,
    selectedWorkspace,
    openSettings,
    flushComposerDraft,
  });

  const transcriptAnnotations = useTranscriptAnnotations(selectedSessionKey);
  const {
    composerAttachments,
    submitComposerDraft,
    stopCurrentRun,
    handlePickAttachments,
    handleRemoveAttachment,
    handleEditQueuedMessage,
    handleCancelQueuedEdit,
    handleRemoveQueuedMessage,
    handleSteerQueuedMessage,
    handleComposerPaste,
    handleComposerDrop,
    handlePastedClipboardImage,
    handleComposerKeyDown,
  } = useSessionComposer({
    api,
    snapshot,
    setSnapshot,
    selectedSession,
    composerDraft,
    setComposerDraft,
    composerDraftRef,
    flushComposerDraft,
    composerRef,
    requiresModelSelection: selectedSessionModelOnboarding.requiresModelSelection,
    openTreeModal,
    handleMentionKeyDown: mentionMenu.handleMentionKeyDown,
    handleSlashKeyDown: slashMenu.handleSlashKeyDown,
    newThreadComposerRef: newThread.composerRef,
    appendNewThreadAttachment: newThread.appendAttachment,
    onNewThreadComposerError: newThread.setComposerError,
    annotations: transcriptAnnotations,
  });

  useEffect(() => {
    const sessionExtensionUiBySession = snapshot?.sessionExtensionUiBySession;
    if (!sessionExtensionUiBySession) {
      setDockExpandedBySession((current) => (Object.keys(current).length > 0 ? {} : current));
      return;
    }

    setDockExpandedBySession((current) => {
      let next: Record<string, string> | undefined;
      for (const [sessionKey, instanceId] of Object.entries(current)) {
        if (
          sessionExtensionUiBySession[sessionKey]?.instanceId === instanceId &&
          hasExtensionDockContent(sessionExtensionUiBySession[sessionKey])
        ) {
          continue;
        }
        if (!next) {
          next = { ...current };
        }
        delete next[sessionKey];
      }
      return next ?? current;
    });
  }, [snapshot?.sessionExtensionUiBySession]);

  useEffect(() => {
    if (rootWorkspaceOptions.length === 0) {
      setSettingsWorkspaceId("");
      setSkillsWorkspaceId("");
      setExtensionsWorkspaceId("");
      return;
    }
    setSettingsWorkspaceId((current) =>
      rootWorkspaceOptions.some((workspace) => workspace.id === current)
        ? current
        : current || rootWorkspaceOptions[0]?.id || "",
    );
    setSkillsWorkspaceId((current) =>
      rootWorkspaceOptions.some((workspace) => workspace.id === current)
        ? current
        : current || rootWorkspaceOptions[0]?.id || "",
    );
    setExtensionsWorkspaceId((current) =>
      rootWorkspaceOptions.some((workspace) => workspace.id === current)
        ? current
        : current || rootWorkspaceOptions[0]?.id || "",
    );
  }, [rootWorkspaceOptions]);

  const primarySidebarToggleVisible = canTogglePrimarySidebar(snapshot?.activeView);
  const sidebarToggleShortcutLabel = api ? getDesktopShortcutLabel(api.platform, "B") : "";

  const setActiveView = (view: AppView) => {
    if (!api) return;
    void updateSnapshot(setSnapshot, () => api.setActiveView(view)).catch((error: unknown) => {
      console.error("[renderer] setActiveView failed", error);
    });
  };

  const openSkills = (workspaceId?: string) => {
    const nextWorkspaceId =
      workspaceId && rootWorkspaceOptions.some((workspace) => workspace.id === workspaceId)
        ? workspaceId
        : skillsWorkspaceId || rootWorkspaceOptions[0]?.id || "";
    if (nextWorkspaceId) {
      setSkillsWorkspaceId(nextWorkspaceId);
    }
    setActiveView("skills");
  };

  const openExtensions = (workspaceId?: string) => {
    const nextWorkspaceId =
      workspaceId && rootWorkspaceOptions.some((workspace) => workspace.id === workspaceId)
        ? workspaceId
        : extensionsWorkspaceId || rootWorkspaceOptions[0]?.id || "";
    if (nextWorkspaceId) {
      setExtensionsWorkspaceId(nextWorkspaceId);
    }
    setActiveView("extensions");
  };

  /**
   * 侧栏直达 PAO 扩展面板（部门详情 / 流程面板）。
   * 扩展视图由 driver 注册、由 workbench 按会话取目录并承载，所以这里只做窄事：
   * 需要时先切回会话页，再按 view id 打开对应扩展面板。不新增 activeView 分派，
   * 也不 import 扩展前端（计划 §12.2 保留 view id；desktop\AGENTS.md 的 driver 薄封装边界）。
   */
  const openExtensionSurface = (surface: ExtensionSurfaceId) => {
    const viewId = EXTENSION_SURFACE_VIEW_IDS[surface];
    const view = extensionViews.views.find((item) => item.id === viewId);
    if (!view) return;
    if (snapshot?.activeView !== "threads") setActiveView("threads");
    workbench.openTool({ kind: "extension", extensionId: view.extensionId, viewId: view.id });
  };

  /**
   * 这两个面板当前能不能打开。判据只有两条真实条件：有选中的会话（workbench 按会话取扩展目录），
   * 以及驱动确实注册了这个视图。缺哪条就说哪条，不静默空转、不假装已打开。
   */
  const extensionSurfaceAvailability = (surface: ExtensionSurfaceId) => {
    if (!workbenchTarget) {
      return { available: false, reason: t("Open a conversation first to use this panel") };
    }
    const viewId = EXTENSION_SURFACE_VIEW_IDS[surface];
    if (!extensionViews.views.some((item) => item.id === viewId)) {
      return { available: false, reason: t("This panel is not available in this conversation") };
    }
    return { available: true };
  };

  const selectedThreadTarget =
    snapshot?.activeView === "threads" && selectedWorkspace && selectedSession
      ? { workspaceId: selectedWorkspace.id, sessionId: selectedSession.id }
      : undefined;
  const selectedThreadActions =
    selectedThreadTarget && selectedSession
      ? threadMenu.actionsFor({
          workspaceId: selectedThreadTarget.workspaceId,
          session: selectedSession,
        })
      : undefined;
  const selectedRootWorkspaceId = selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id;
  const commands = useDesktopCommands({
    api,
    snapshot,
    setSnapshot,
    hasWorkspace: rootWorkspaceOptions.length > 0,
    selectedRootWorkspaceId,
    selectedThread: selectedThreadActions
      ? { actions: selectedThreadActions, canSwitchModel: selectedModelOptions.length > 0 }
      : undefined,
    threadSidebarModel,
    threadShortcutOrderRef,
    selectThread: (target) => selectThreadRef.current(target),
    threadSearch,
    workbench,
    sidePanelAvailable,
    sidePanelVisible,
    selectedToolId,
    extensionViews: extensionViews.views,
    openNewThread: newThread.openSurface,
    openSettings,
    openSkills,
    openExtensions,
    setActiveView,
  });

  useEffect(() => {
    const removeWorkspacePickedListener = window.piApp?.onWorkspacePicked?.((workspaceId) => {
      newThread.setPendingWorkspaceId(workspaceId);
      newThread.resetSurface();
    });
    const removeClipboardImageListener = window.piApp?.onClipboardImagePasted?.(
      handlePastedClipboardImage,
    );
    return () => {
      removeWorkspacePickedListener?.();
      removeClipboardImageListener?.();
    };
  }, [handlePastedClipboardImage, newThread]);

  useEffect(() => {
    // The composer is keyed by session: focus only after its new node commits.
    // An IPC completion can precede that commit and focus the outgoing node.
    if (snapshot?.activeView !== "threads" || !selectedSessionKey) return;
    if (!restoreTopmostDialogFocus()) composerRef.current?.focus();
  }, [selectedSessionKey, snapshot?.activeView]);

  if (!api || desktop.view.kind !== "ready" || !snapshot) {
    return (
      <DesktopStartupSurface
        state={toStartupSurfaceState(desktop.view)}
        onRetry={desktop.retry}
        onRelaunch={desktop.canRelaunch ? desktop.relaunch : undefined}
      />
    );
  }
  const secondarySurfaceView =
    snapshot.activeView === "settings" ||
    snapshot.activeView === "skills" ||
    snapshot.activeView === "extensions"
      ? snapshot.activeView
      : null;
  const filesWorkspace = snapshot.workspaces.find(
    (workspace) => workspace.id === workbench.view.files.workspaceId,
  );
  const filesWorktree = filesWorkspace
    ? linkedWorktreeByWorkspaceId.get(filesWorkspace.id)
    : undefined;
  const mainClassName = [
    "main",
    sidePanelVisible ? "main--with-side-panel" : "",
    snapshot.startupDiagnostics.length > 0 ? "main--with-startup-diagnostics" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const handleSetSessionModel = (provider: string, modelId: string) => {
    if (!selectedWorkspace || !selectedSession) {
      return;
    }
    void updateSnapshot(setSnapshot, () =>
      api.setSessionModel(selectedWorkspace.id, selectedSession.id, provider, modelId),
    ).catch((error: unknown) => {
      console.error("[renderer] updateSnapshot failed", error);
    });
  };

  const handleSetSessionThinking = (level: string) => {
    if (!selectedWorkspace || !selectedSession) {
      return;
    }
    void updateSnapshot(setSnapshot, () =>
      api.setSessionThinkingLevel(
        selectedWorkspace.id,
        selectedSession.id,
        level as NonNullable<RuntimeSnapshot["settings"]["defaultThinkingLevel"]>,
      ),
    ).catch((error: unknown) => {
      console.error("[renderer] updateSnapshot failed", error);
    });
  };

  const handleTrySkill = (command: string) => {
    void updateSnapshot(setSnapshot, () => api.setActiveView("threads")).catch((error: unknown) => {
      console.error("[renderer] setActiveView failed", error);
    });
    slashMenu.fillComposerFromSlash(command);
  };

  const handleSelectSession = (target: { workspaceId: string; sessionId: string }) => {
    // Flush any debounced draft write before the active session changes, otherwise the pending
    // write for the current session is lost (and would land on the wrong session if deferred).
    flushComposerDraft();
    viewport.savePosition();
    if (target.workspaceId === selectedWorkspace?.id && target.sessionId === selectedSession?.id)
      focusComposer();
    void updateSnapshot(setSnapshot, () => api.selectSession(target)).catch((error: unknown) => {
      console.error("[renderer] selectSession failed", error);
    });
  };
  selectThreadRef.current = handleSelectSession;

  const handleRespondToExtensionDialog = (
    response:
      | { readonly requestId: string; readonly value: string }
      | { readonly requestId: string; readonly confirmed: boolean }
      | { readonly requestId: string; readonly cancelled: true },
  ) => {
    if (!selectedWorkspace || !selectedSession) {
      return;
    }

    void updateSnapshot(setSnapshot, () =>
      api.respondToHostUiRequest(selectedWorkspace.id, selectedSession.id, response),
    )
      .then(() => {
        focusComposer();
      })
      .catch((error: unknown) => {
        console.error("[renderer] updateSnapshot failed", error);
      });
  };

  const handleToggleExtensionDock = () => {
    if (!selectedExtensionDock || !selectedExtensionUiInstance) {
      return;
    }

    setDockExpandedBySession((current) => {
      const next = { ...current };
      if (current[selectedSessionKey] === selectedExtensionUiInstance)
        delete next[selectedSessionKey];
      else next[selectedSessionKey] = selectedExtensionUiInstance;
      return next;
    });
  };

  const handleCreateScheduledTaskWithPi = () => {
    void updateSnapshot(setSnapshot, () => api.beginScheduledTaskInterview()).catch(
      (error: unknown) => {
        console.error("[renderer] beginScheduledTaskInterview failed", error);
      },
    );
  };

  const handleSubmitScheduledTask = (input: CreateScheduledTaskInput) => {
    const action =
      scheduledEditor?.mode === "edit"
        ? () => api.updateScheduledTask(scheduledEditor.taskId, input)
        : () => api.createScheduledTask(input);
    void updateSnapshot(setSnapshot, action)
      .then((state) => {
        if (!state.lastError) {
          setScheduledEditor(null);
        }
      })
      .catch((error: unknown) => {
        console.error("[renderer] save scheduled task failed", error);
      });
  };

  const handleOpenScheduledChat = (target: { workspaceId: string; sessionId: string }) => {
    setScheduledEditor(null);
    handleSelectSession(target);
  };

  const commandPalette =
    commands.paletteMode && threadSidebarModel ? (
      <CommandPaletteSurface
        key={commands.paletteMode}
        api={api}
        mode={commands.paletteMode}
        onModeChange={commands.setPaletteMode}
        onClose={() => commands.setPaletteMode(null)}
        threads={threadSidebarModel.recencyOrder}
        workspaces={threadSidebarModel.folders}
        currentThread={selectedThreadTarget}
        actions={commands.paletteActions}
        fileScope={
          selectedThreadTarget && selectedWorkspace
            ? {
                workspaceId: selectedWorkspace.id,
                label: selectedWorktree?.name ?? selectedWorkspace.name,
                openTabs:
                  workbench.view.files.workspaceId === selectedWorkspace.id
                    ? workbench.view.files.tabs.tabs
                    : [],
              }
            : undefined
        }
        modelScope={
          selectedThreadTarget
            ? {
                options: selectedModelOptions,
                currentProvider: resolvedSessionProvider,
                currentModelId: resolvedSessionModelId,
              }
            : undefined
        }
        onOpenThread={handleSelectSession}
        onOpenWorkspace={wsMenu.selectWorkspace}
        onOpenFile={(path) => {
          if (!selectedWorkspace) return;
          void workbench
            .openFile({ workspaceId: selectedWorkspace.id, path })
            .catch((error: unknown) => {
              console.error("[renderer] open file from palette failed", error);
            });
        }}
        onSelectModel={handleSetSessionModel}
      />
    ) : null;

  if (secondarySurfaceView) {
    return (
      <>
        <SecondarySurfaces
          api={api}
          snapshot={snapshot}
          setSnapshot={setSnapshot}
          activeView={secondarySurfaceView}
          rootWorkspaceOptions={rootWorkspaceOptions}
          settingsSection={settingsSection}
          onSelectSettingsSection={setSettingsSection}
          settingsWorkspaceId={settingsWorkspaceId}
          onSelectSettingsWorkspace={setSettingsWorkspaceId}
          skillsWorkspaceId={skillsWorkspaceId}
          onSelectSkillsWorkspace={setSkillsWorkspaceId}
          extensionsWorkspaceId={extensionsWorkspaceId}
          onSelectExtensionsWorkspace={setExtensionsWorkspaceId}
          onBack={() => setActiveView("threads")}
          onSelectView={setActiveView}
          onTrySkill={handleTrySkill}
        />
        {commandPalette}
      </>
    );
  }

  const shellClassName = `shell${snapshot.sidebarCollapsed ? " shell--sidebar-collapsed" : ""}`;

  const sessionConversation =
    selectedWorkspace && selectedSession ? (
      <>
        <section className="canvas canvas--thread">
          <div className="conversation conversation--thread">
            {showSchemaSkewNotice ? (
              <div className="schema-skew-notice" role="status" data-testid="schema-skew-notice">
                <span className="schema-skew-notice__text">
                  {t(
                    "This session was written by a newer version of pi — some content may not display. Update pi-gui (or open it with the pi CLI) to see everything.",
                  )}
                </span>
                <button
                  type="button"
                  className="schema-skew-notice__dismiss"
                  aria-label={t("Dismiss notice")}
                  onClick={() => dismissSchemaSkewNotice(selectedSessionKey)}
                >
                  {t("Dismiss")}
                </button>
              </div>
            ) : null}

            <ConversationTimeline
              key={selectedSessionKey}
              transcript={pins.timeline}
              isTranscriptLoading={isTranscriptLoading}
              transcriptFailed={transcriptFailed}
              onRetryTranscript={desktop.retry}
              viewport={viewport}
              threadSearch={threadSearch}
              onViewFileInDiff={handleViewFileInDiff}
              onOpenTurnChange={turnChanges.openTurnChange}
              onOpenWorkspaceFileLine={handleOpenWorkspaceFileLine}
              onExtensionAction={runExtensionCardAction}
              extensionToolLabels={extensionToolLabels}
              workspacePath={selectedWorkspace.path}
              onForkFromMessage={selectedSession.status === "running" ? undefined : openForkModal}
              scheduledOrigins={scheduledOrigins}
              annotations={transcriptAnnotations}
              platform={api?.platform ?? "linux"}
            />
          </div>
        </section>
        {scheduledBinding ? (
          <ScheduledTaskChip
            task={scheduledBinding}
            onOpen={() => setScheduledEditor({ mode: "edit", taskId: scheduledBinding.id })}
          />
        ) : null}
        <ComposerPanel
          key={selectedSessionKey}
          preparingTaskDraft={extensionHostActions.preparingTaskDraft}
          activeSlashCommand={slashMenu.activeSlashFlow?.command}
          activeSlashCommandMeta={slashMenu.activeSlashFlow?.command?.description}
          attachments={composerAttachments}
          queuedMessages={queuedComposerMessages}
          editingQueuedMessageId={editingQueuedMessageId}
          composerDraft={composerDraft}
          composerRef={composerRef}
          runtime={selectedModelRuntime}
          usage={
            selectedSessionKey ? snapshot?.sessionUsageBySession[selectedSessionKey] : undefined
          }
          extensionFlags={snapshot.extensionFlagsBySession[selectedSessionKey]}
          provider={resolvedSessionProvider}
          modelId={resolvedSessionModelId}
          thinkingLevel={resolvedSessionThinkingLevel}
          onClearSlashCommand={slashMenu.resetSlashUi}
          onComposerKeyDown={handleComposerKeyDown}
          onComposerPaste={handleComposerPaste}
          onComposerDrop={handleComposerDrop}
          onPickAttachments={handlePickAttachments}
          onRemoveAttachment={handleRemoveAttachment}
          onEditQueuedMessage={handleEditQueuedMessage}
          onCancelQueuedEdit={handleCancelQueuedEdit}
          onRemoveQueuedMessage={handleRemoveQueuedMessage}
          onSteerQueuedMessage={handleSteerQueuedMessage}
          onSelectSlashCommand={(command) => {
            slashMenu.applySlashCommandSelection(command, "click");
          }}
          onSelectSlashOption={(option) => {
            slashMenu.applySlashOptionSelection(option);
          }}
          onSetModel={handleSetSessionModel}
          onSetThinking={handleSetSessionThinking}
          modelOnboarding={selectedSessionModelOnboarding}
          onOpenModelSettings={(section) =>
            openSettings(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id, section)
          }
          onSubmit={submitComposerDraft}
          onStop={stopCurrentRun}
          selectedSession={selectedSession}
          lastError={snapshot.lastError}
          selectedSlashCommand={
            slashMenu.activeSlashOptionCommand ?? slashMenu.selectedSlashCommand
          }
          selectedSlashOption={slashMenu.selectedSlashOption}
          slashOptionEmptyState={slashMenu.slashOptionEmptyState}
          setComposerDraft={setComposerDraft}
          showSlashOptionMenu={slashMenu.showSlashOptionMenu}
          showSlashMenu={slashMenu.showSlashMenu}
          slashOptions={slashMenu.slashOptions}
          slashSections={slashMenu.slashSections}
          showMentionMenu={mentionMenu.showMentionMenu}
          mentionOptions={mentionMenu.mentionOptions}
          selectedMentionIndex={mentionMenu.selectedIndex}
          onSelectMention={mentionMenu.insertMention}
          onEnableMentionExtension={mentionMenu.enableMentionExtension}
          pinnedCards={
            <PinnedCards
              pins={pins.visiblePins}
              collapsedPinIds={pins.collapsedPinIds}
              onToggle={pins.togglePin}
              onDismiss={pins.dismissPin}
              onAction={runExtensionCardAction}
            />
          }
          extensionDock={shownExtensionDock.dock}
          extensionDockExpanded={isSelectedExtensionDockExpanded}
          onToggleExtensionDock={handleToggleExtensionDock}
          onDismissExtensionDock={shownExtensionDock.dismiss}
          extensionNotices={selectedExtensionUi?.notices}
          annotations={transcriptAnnotations}
        />
      </>
    ) : null;

  return (
    <div className={shellClassName}>
      {primarySidebarToggleVisible ? (
        <SidebarToggleButton
          collapsed={snapshot.sidebarCollapsed}
          shortcutLabel={sidebarToggleShortcutLabel}
          onToggle={commands.togglePrimarySidebar}
        />
      ) : null}
      {!snapshot.sidebarCollapsed ? (
        <Sidebar
          activeView={snapshot.activeView}
          state={snapshot}
          selectedWorkspace={selectedWorkspace}
          selectedSession={selectedSession}
          visibleWorkspaces={visibleWorkspaces}
          threadSidebarModel={threadSidebarModel ?? buildThreadSidebarModel(snapshot)}
          threadShortcutOrderRef={threadShortcutOrderRef}
          threadGrouping={snapshot.threadGrouping}
          collapsedWorkspaceIds={snapshot.collapsedWorkspaceIds}
          linkedWorktreeByWorkspaceId={linkedWorktreeByWorkspaceId}
          wsMenu={wsMenu}
          threadMenu={threadMenu}
          api={api}
          setSnapshot={setSnapshot}
          updateSnapshot={updateSnapshot}
          onNewThread={(workspaceId) =>
            newThread.openSurface(
              workspaceId ?? selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id,
            )
          }
          onSetActiveView={(view) => {
            if (view === "canvas") setWorkflowEntryNonce((value) => value + 1);
            setActiveView(view);
          }}
          onOpenSettings={openSettings}
          onArchiveSession={threadMenu.archive}
          onSelectSession={handleSelectSession}
          onSetSessionPinned={threadMenu.setPinned}
          onUnarchiveSession={threadMenu.restore}
          onOpenExtensionSurface={openExtensionSurface}
          extensionSurfaceStatus={extensionSurfaceAvailability}
        />
      ) : null}

      <main className={mainClassName} style={workbenchWidth.style}>
        <Topbar
          activeView={snapshot.activeView}
          rootWorkspace={
            snapshot.activeView === "new-thread"
              ? (newThread.workspace ?? rootWorkspace)
              : rootWorkspace
          }
          selectedWorkspace={selectedWorkspace}
          selectedWorktree={selectedWorktree}
          api={api}
          panelAvailable={sidePanelAvailable}
          panelVisible={sidePanelVisible}
          onTogglePanel={commands.toggleSidePanel}
          sessionTitle={
            snapshot.activeView === "threads" && selectedSession ? displayedSessionTitle : undefined
          }
        >
          {snapshot.activeView === "threads" && selectedWorkspace && selectedSession ? (
            <>
              <div className="chat-header__status">
                {selectedSession.status === "running"
                  ? runningLabel
                  : formatRelativeTime(selectedSession.updatedAt)}
              </div>
              <div
                className="chat-header__menu-wrap"
                ref={threadMenu.openMenu?.surface === "header" ? threadMenu.menuWrapRef : undefined}
              >
                <button
                  aria-haspopup="menu"
                  aria-expanded={threadMenu.openMenu?.surface === "header"}
                  aria-label={t("Thread actions")}
                  className="icon-button"
                  data-testid="thread-header-menu"
                  type="button"
                  onClick={threadMenu.toggleHeaderMenu}
                >
                  …
                </button>
                {threadMenu.openMenu?.surface === "header" && selectedThreadActions ? (
                  <ThreadActionsMenu
                    actions={selectedThreadActions}
                    className="chat-header__menu"
                  />
                ) : null}
              </div>
            </>
          ) : null}
        </Topbar>

        {snapshot.startupDiagnostics.length > 0 ? (
          <div className="startup-diagnostics" role="status" data-testid="startup-diagnostics">
            <strong>{t("Some saved workspaces could not be refreshed.")}</strong>
            <span>
              {snapshot.startupDiagnostics
                .map((diagnostic) => {
                  const workspaceName = diagnostic.workspacePath
                    ?.split(/[\\/]/)
                    .filter(Boolean)
                    .at(-1);
                  return workspaceName
                    ? t("{name} is unavailable.", { name: workspaceName })
                    : diagnostic.message;
                })
                .join(" ")}
            </span>
          </div>
        ) : null}

        <>
          {snapshot.activeView === "scheduled" ? (
            <ScheduledTasksView
              tasks={snapshot.scheduledTasks}
              lastError={snapshot.lastError}
              api={api}
              setSnapshot={setSnapshot}
              updateSnapshot={updateSnapshot}
              onCreateWithPi={handleCreateScheduledTaskWithPi}
              onOpenEditor={setScheduledEditor}
            />
          ) : snapshot.activeView === "workboard" ? (
            <KanbanPage
              api={api}
              workspaceId={snapshot.selectedWorkspaceId}
              snapshot={snapshot}
              onOpenMain={handleSelectSession}
              onOpenWorkflow={(target) => {
                return updateSnapshot(setSnapshot, async () => {
                  if (target.workspaceId !== snapshot.selectedWorkspaceId) {
                    const state = await api.selectWorkspace(target.workspaceId);
                    if (state.lastError) throw new Error(state.lastError);
                  }
                  return api.setActiveView("canvas");
                }).then((state) => {
                  if (state.lastError) throw new Error(state.lastError);
                  setWorkflowFocus({ instanceId: target.instanceId, nodeName: target.nodeName });
                });
              }}
            />
          ) : snapshot.activeView === "canvas" || snapshot.activeView === "plans" ? (
            <WorkflowSurface
              api={api}
              snapshot={snapshot}
              onSnapshot={setSnapshot}
              onSelectSession={handleSelectSession}
              onOpenMainSession={handleSelectSession}
              onActivateMainSession={(target) => {
                void updateSnapshot(setSnapshot, () =>
                  api.activateWorkflowController(target),
                ).catch((error: unknown) =>
                  console.error("[renderer] activate workflow controller failed", error),
                );
              }}
              embeddedChat={sessionConversation}
              refreshToken={workflowEntryNonce}
              focus={workflowFocus}
              onRequestMainControl={handoverToMainControl}
              handoverPending={mainControlHandover.pending}
              onAppendHandover={() => {
                mainControlHandover.appendPending(composerDraftRef.current);
              }}
              onReplaceWithHandover={() => {
                mainControlHandover.replaceWithPending();
              }}
              onDiscardHandover={mainControlHandover.discardPending}
            />
          ) : snapshot.activeView === "new-thread" ? (
            rootWorkspaceOptions.length > 0 ? (
              <NewThreadView
                workspaces={rootWorkspaceOptions}
                selectedWorkspaceId={newThread.rootWorkspaceId || rootWorkspaceOptions[0]?.id || ""}
                runtime={newThread.runtime}
                environment={newThread.environment}
                prompt={newThread.prompt}
                attachments={newThread.attachments}
                lastError={newThread.composerError}
                provider={newThread.resolvedProvider}
                modelId={newThread.resolvedModelId}
                thinkingLevel={newThread.resolvedThinkingLevel}
                modelOnboarding={newThread.modelOnboarding}
                composerRef={newThread.composerRef}
                activeSlashCommand={newThread.slashMenu.activeSlashFlow?.command}
                activeSlashCommandMeta={newThread.slashMenu.activeSlashFlow?.command?.description}
                slashSections={newThread.slashMenu.slashSections}
                slashOptions={newThread.slashMenu.slashOptions}
                selectedSlashCommand={
                  newThread.slashMenu.activeSlashOptionCommand ??
                  newThread.slashMenu.selectedSlashCommand
                }
                selectedSlashOption={newThread.slashMenu.selectedSlashOption}
                showSlashMenu={newThread.slashMenu.showSlashMenu}
                showSlashOptionMenu={newThread.slashMenu.showSlashOptionMenu}
                slashOptionEmptyState={newThread.slashMenu.slashOptionEmptyState}
                showMentionMenu={newThread.mentionMenu.showMentionMenu}
                mentionOptions={newThread.mentionMenu.mentionOptions}
                selectedMentionIndex={newThread.mentionMenu.selectedIndex}
                onChangePrompt={newThread.setPrompt}
                onSelectEnvironment={newThread.setEnvironment}
                onSelectWorkspace={newThread.selectWorkspace}
                onSetModel={(provider, modelId) => {
                  newThread.setProvider(provider);
                  newThread.setModelId(modelId);
                }}
                onSetThinking={newThread.setThinkingLevel}
                extensionFlags={newThread.extensionFlags}
                onSetExtensionFlag={newThread.setExtensionFlag}
                onOpenModelSettings={(section) => openSettings(newThread.workspace?.id, section)}
                onComposerKeyDown={newThread.handleComposerKeyDown}
                onComposerPaste={newThread.handleComposerPaste}
                onComposerDrop={newThread.handleComposerDrop}
                onClearSlashCommand={newThread.slashMenu.resetSlashUi}
                onSelectSlashCommand={(command) => {
                  newThread.slashMenu.applySlashCommandSelection(command, "click");
                }}
                onSelectSlashOption={(option) => {
                  newThread.slashMenu.applySlashOptionSelection(option);
                }}
                onSelectMention={newThread.mentionMenu.insertMention}
                onEnableMentionExtension={newThread.mentionMenu.enableMentionExtension}
                onAddAttachments={newThread.addAttachments}
                onRemoveAttachment={newThread.removeAttachment}
                onSubmit={newThread.startThread}
              />
            ) : (
              <WorkspaceEmptyPanel body="Add a project folder before creating a new thread." />
            )
          ) : selectedWorkspace && selectedSession ? (
            sessionConversation
          ) : selectedWorkspace ? (
            <WorkspaceEmptyPanel
              workspaceName={selectedWorkspace.name}
              body="Create a thread for this folder, then jump between sessions from the sidebar."
              onNewThread={() =>
                newThread.openSurface(selectedWorkspace.rootWorkspaceId ?? selectedWorkspace.id)
              }
            />
          ) : (
            <WorkspaceEmptyPanel body="Add project folders, group sessions under them, and jump between threads from the sidebar." />
          )}
        </>
        {activeExtensionDialog ? (
          <ExtensionDialog
            dialog={activeExtensionDialog}
            onRespond={handleRespondToExtensionDialog}
          />
        ) : null}
        {treeModalState.open ? (
          <TreeModal
            error={treeModalState.error}
            loading={treeModalState.loading}
            submitting={treeModalState.submitting}
            tree={treeModalState.tree}
            onClose={closeTreeModal}
            onNavigate={navigateTreeSelection}
          />
        ) : null}
        {forkModalState.open ? (
          <ForkModal
            error={forkModalState.error}
            submitting={forkModalState.submitting}
            messagePreview={forkModalState.messagePreview}
            canUseWorktree={canUseWorktree}
            onClose={closeForkModal}
            onSubmit={handleForkSubmit}
          />
        ) : null}
        {sidePanelVisible && selectedWorkspace && selectedSession ? (
          <Workbench
            view={workbench.view}
            platform={api?.platform ?? "linux"}
            tabHintsVisible={sidePanelTabHintsVisible}
            onResize={workbenchWidth.setWidth}
            onTogglePanel={commands.toggleSidePanel}
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
            {activeExtensionView?.state === "ready" && workbenchTarget && api ? (
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
            ) : activeTool && activeTool.kind !== "extension" ? (
              renderBuiltinToolPanel(activeTool.kind, {
                changes: () => (
                  <DiffPanel
                    key={selectedSessionKey}
                    workspaceId={selectedWorkspace.id}
                    sessionId={selectedSession.id}
                    api={api}
                    sessionStatus={selectedSession.status}
                    selection={workbench.view.changes}
                    onSelectionChange={workbench.setChanges}
                    onOpenFile={workbench.openFile}
                    fileRequest={
                      diffFileRequest?.sessionKey === selectedSessionKey
                        ? diffFileRequest.request
                        : null
                    }
                    contexts={fileWorkbenchContexts}
                  />
                ),
                files: () =>
                  filesWorkspace ? (
                    <FileWorkbench
                      key={selectedSessionKey}
                      api={api}
                      onTabsChange={workbench.setFiles}
                      sessionStatus={selectedSession.status}
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
                    key={selectedSessionKey}
                    workspace={selectedWorkspace}
                    sessionId={selectedSession.id}
                    onHide={() => workbench.closeTool("terminal")}
                  />
                ),
              })
            ) : null}
          </Workbench>
        ) : null}
      </main>
      {scheduledEditor ? (
        <ScheduledTaskEditor
          editor={scheduledEditor}
          task={
            scheduledEditor.mode === "edit"
              ? snapshot.scheduledTasks.find((task) => task.id === scheduledEditor.taskId)
              : undefined
          }
          workspaces={snapshot.workspaces}
          selectedWorkspaceId={snapshot.selectedWorkspaceId}
          busy={false}
          error={snapshot.lastError}
          onClose={() => setScheduledEditor(null)}
          onSubmit={handleSubmitScheduledTask}
          onOpenChat={handleOpenScheduledChat}
        />
      ) : null}
      {threadSwitcher.state?.overlayVisible ? (
        <ThreadSwitcher state={threadSwitcher.state} onChoose={threadSwitcher.choose} />
      ) : null}
      {commandPalette}
    </div>
  );
}
