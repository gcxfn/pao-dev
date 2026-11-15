import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  Notification,
  nativeImage,
  nativeTheme,
  net,
  protocol,
  shell,
  Tray,
  type MenuItemConstructorOptions,
  type MessageBoxOptions,
} from "electron";
import { isValidHttpBaseUrl, startPaoMaintenance } from "@pi-gui/pi-sdk-driver";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type {
  AgentToolResult,
  ExtensionContext,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { augmentPosixPath } from "../scripts/augment-path.cjs";
import { DesktopAppStore } from "./application/app-store";
import { WindowOwner } from "./windows/window-owner";
import { PendingComposerDraftFlusher } from "./windows/pending-draft-flush";
import { WorkflowLeaveGuard } from "./windows/workflow-leave-guard";
import { TurnCheckpointStore } from "./workbench/checkpoint-store";
import {
  DesktopExtensionViewOwner,
  DESKTOP_EXTENSION_SCHEME,
} from "./extensions/extension-view-owner";
import { performExtensionViewHostAction } from "./extensions/extension-view-actions";
import { extensionFrameDocument } from "./extensions/extension-frame-document";
import { ReviewOwner } from "./workbench/review-owner";
import { createWorkboardQuery } from "./platform/pao/workboard-query";
import { createCanvasQuery } from "./platform/pao/canvas-query";
import { createWorkflowWizardBridge } from "./platform/pao/workflow-wizard-bridge";
import { createFlowControlQuery } from "./platform/pao/flow-control-query";
import { applyPaoHomeSetting, applyPortablePaoHome } from "./platform/pao/pao-home";
import { cleanupDeadSessionLocks } from "./platform/pao/session-lock-cleanup";
import { sweepEphemeralWorkflowSessions } from "./platform/pao/ephemeral-sweep";
import { registerDesktopIpc } from "./ipc/register-desktop-ipc";
import {
  createOrchestrationRuntimeExtension,
  createOrchestrationRuntimeTools,
  type OrchestrationRuntimeBridge,
} from "./orchestration/orchestration-runtime";
import {
  createScheduledTaskRuntimeExtension,
  createScheduledTaskRuntimeTools,
  type ScheduledTaskRuntimeBridge,
} from "./scheduled-tasks/scheduled-task-runtime";
import { getChangedFiles, getFileDiff, stageFile } from "./platform/files/app-store-diff";
import { listWorkspaceFiles, readWorkspaceFile } from "./platform/files/app-store-files";
import { resolveExistingWorkspacePath } from "./platform/files/workspace-paths";
import { MAIN_DEV_RELOAD_MARKER } from "./dev-reload-main-probe";
import { NotificationManager } from "./platform/notification-manager";
import { installDeadPipeBoundary } from "./platform/dead-pipe";
import { NotificationPermissionService } from "./platform/notification-permission";
import { checkForUpdate, initUpdateChecker, openReleasesPage } from "./platform/update-checker";
import { ThemeManager } from "./platform/theme-manager";
import { windowBackgroundFor } from "../contracts/theme";
import { setI18nLanguage, tMain } from "../contracts/i18n";
import type { AppLanguage, CloseWindowBehavior } from "../contracts/desktop-state";
import { TerminalService } from "./platform/terminal-service";
import type { DesktopAppState, DesktopAppViewState } from "../contracts/desktop-state";
import {
  desktopCommands,
  desktopIpc,
  getDesktopCommandFromShortcut,
  isSinglePressCommand,
  isCloseFocusedSurfaceShortcut,
  getSidePanelTabCommand,
  platformShortcutModifier,
  type CustomProviderProbeInput,
  type CustomProviderProbeResult,
} from "../contracts/ipc";
import {
  assertComposerImageBytes,
  assertComposerImageFileSizes,
  assertComposerImagePixels,
  SUPPORTED_COMPOSER_IMAGE_TYPES,
  type ClipboardImageRead,
} from "../contracts/composer-attachments";
import type {
  ComposerAttachment,
  ComposerFileAttachment,
  ComposerImageAttachment,
} from "../contracts/desktop-state";
import type { SessionDriverEvent } from "@pi-gui/session-driver";
import type { GenerateThreadTitleOptions } from "@pi-gui/pi-sdk-driver";
import type { SessionRef, WorkspaceRef } from "@pi-gui/session-driver";

protocol.registerSchemesAsPrivileged([
  {
    scheme: DESKTOP_EXTENSION_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

// W-bug7：主进程 stdout/stderr 管道对端消失后，任何 console 写都会 EPIPE。
// 流级腿只在此 stdout/stderr 边界吸收预期断管（EIO/EPIPE/ENOTCONN，口径同内核
// interactive-mode）；uncaughtException 腿为全局吸收（有意放宽，两腿分工见
// dead-pipe.ts 头注释）。注册监听会关闭 Electron 默认的未捕获异常弹窗（Electron
// 37 实测），非断管错误在这里重新以错误框呈现，维持「弹窗＋继续运行」不改崩溃语义。
installDeadPipeBoundary({
  streams: [process.stdout, process.stderr],
  onUnexpected: (error) => {
    const detail = error?.stack ?? String(error);
    try {
      console.error("[main] Uncaught exception:", error);
    } catch {}
    dialog.showErrorBox(tMain("Uncaught exception"), detail);
  },
});

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);
const appTestMode = resolveAppTestMode(process.env.PI_APP_TEST_MODE);
const windowTestMode = appTestMode ?? "foreground";
const devReloadMarkersEnabled = process.env.PI_APP_DEV_RELOAD_MARKERS === "1";
const TURN_CAPTURE_BACKSTOP_MS = 10_000;
let store: DesktopAppStore;
let extensionViewOwner: DesktopExtensionViewOwner | undefined;
let windowOwner: WindowOwner;
const themeManager = new ThemeManager();
let mainWindow: BrowserWindow | null = null;
let notificationManager: NotificationManager | undefined;
let notificationPermissionService: NotificationPermissionService | undefined;
let terminalService: TerminalService | undefined;
let integratedTerminalShell = "";
let applicationRelaunchRequested = false;

function requestApplicationRelaunch(): void {
  if (applicationRelaunchRequested) {
    return;
  }
  applicationRelaunchRequested = true;
  app.quit();
}

interface OrchestrationRuntimeToolTestInput {
  readonly toolName: string;
  readonly toolCallId?: string;
  readonly sessionRef: SessionRef;
  readonly params: unknown;
}

interface ScheduledTaskRuntimeToolTestInput {
  readonly toolName: string;
  readonly toolCallId?: string;
  readonly sessionRef: SessionRef;
  readonly params: unknown;
}

function createStoreBackedScheduledTaskRuntimeBridge(): ScheduledTaskRuntimeBridge {
  return {
    createScheduledTask: async (ctx, input) => {
      await store.initialize();
      return store.createScheduledTaskToolResult(sessionRefFromExtensionContext(ctx), input);
    },
    listScheduledTasks: async () => {
      await store.initialize();
      return store.listScheduledTasksToolResult();
    },
    updateScheduledTask: async (_ctx, input) => {
      await store.initialize();
      return store.updateScheduledTaskToolResult(input);
    },
  };
}

async function runScheduledTaskRuntimeToolForTest(
  bridge: ScheduledTaskRuntimeBridge,
  input: ScheduledTaskRuntimeToolTestInput,
): Promise<AgentToolResult<unknown>> {
  await store.initialize();
  const tool = createScheduledTaskRuntimeTools(bridge, () => input.sessionRef.workspaceId).find(
    (entry) => entry.name === input.toolName,
  );
  if (!tool) {
    throw new Error(`Unknown scheduled-task runtime tool: ${input.toolName}`);
  }
  return tool.execute(
    input.toolCallId ?? `test-${input.toolName}`,
    input.params,
    undefined,
    undefined,
    createTestExtensionContext(input.sessionRef),
  );
}

let stopNotifications: (() => void) | undefined;
let paoMaintenance: ReturnType<typeof startPaoMaintenance> | undefined;
function startMechanicalMaintenance(): void {
  if (paoMaintenance) return;
  paoMaintenance = startPaoMaintenance({
    ...(process.env.PAO_HOME ? { home: process.env.PAO_HOME } : {}),
    notify(message) {
      console.error(message);
      if (Notification.isSupported())
        new Notification({ title: "PAO 机械维护失败", body: message }).show();
    },
  });
}
function stopMechanicalMaintenance(): void {
  paoMaintenance?.stop();
  paoMaintenance = undefined;
}
let stopUpdateChecker: (() => void) | undefined;
let stopPruningTerminals: (() => void) | undefined;
let retainedTerminalWorkspacePathSignature = "";
let installedMenuLanguage: AppLanguage | undefined;
const terminalFocusedWebContentsIds = new Set<number>();
const sidePanelFocusedWebContentsIds = new Set<number>();
const surfaceCloseShortcutIds = new Set<number>();
// "flushing" while quit saves drafts and the store; "done" once quit may proceed.
let quitFlush: "idle" | "flushing" | "done" = "idle";

const SUPPORTED_IMAGE_TYPES = SUPPORTED_COMPOSER_IMAGE_TYPES;
const SUPPORTED_IMAGE_MIME_TYPES = new Set<string>(
  SUPPORTED_IMAGE_TYPES.map((type) => type.mimeType),
);
const NEW_WINDOW_MENU_ITEM_ID = "file.new-window";

function createStoreBackedOrchestrationRuntimeBridge(): OrchestrationRuntimeBridge {
  return {
    createChildThread: async (ctx, input) => {
      await store.initialize();
      return store.createChildThreadToolResult(sessionRefFromExtensionContext(ctx), input);
    },
    listThreads: async (ctx) => {
      await store.initialize();
      return store.listThreadsToolResult(sessionRefFromExtensionContext(ctx));
    },
    readThread: async (ctx, threadId) => {
      await store.initialize();
      return store.readThreadToolResult(sessionRefFromExtensionContext(ctx), threadId);
    },
    sendMessageToThread: async (ctx, input) => {
      await store.initialize();
      return store.sendMessageToThreadToolResult(sessionRefFromExtensionContext(ctx), input);
    },
  };
}

function sessionRefFromExtensionContext(ctx: ExtensionContext): SessionRef {
  const sessionId = ctx.sessionManager.getSessionId();
  const cwd = path.resolve(ctx.sessionManager.getCwd?.() ?? ctx.cwd);
  const sessionRef = store.findSessionRefByCwdAndSessionId(cwd, sessionId);
  if (!sessionRef) {
    throw new Error(`Unable to resolve orchestration session for ${cwd}:${sessionId}`);
  }
  return sessionRef;
}

async function runOrchestrationRuntimeToolForTest(
  bridge: OrchestrationRuntimeBridge,
  input: OrchestrationRuntimeToolTestInput,
): Promise<AgentToolResult<unknown>> {
  await store.initialize();
  const tool = createOrchestrationRuntimeTools(bridge).find(
    (entry) => entry.name === input.toolName,
  );
  if (!tool) {
    throw new Error(`Unknown orchestration runtime tool: ${input.toolName}`);
  }
  return tool.execute(
    input.toolCallId ?? `test-${input.toolName}`,
    input.params,
    undefined,
    undefined,
    createTestExtensionContext(input.sessionRef),
  );
}

function createTestExtensionContext(sessionRef: SessionRef): ExtensionToolContext {
  const workspace = store
    .snapshot()
    .workspaces.find(
      (entry) =>
        entry.id === sessionRef.workspaceId &&
        entry.sessions.some((session) => session.id === sessionRef.sessionId),
    );
  if (!workspace) {
    throw new Error(`Unknown test session: ${sessionRef.workspaceId}:${sessionRef.sessionId}`);
  }

  return {
    hasUI: false,
    mode: "json",
    cwd: workspace.path,
    sessionManager: {
      getSessionId: () => sessionRef.sessionId,
      getCwd: () => workspace.path,
    } as ExtensionContext["sessionManager"],
    ui: {} as ExtensionContext["ui"],
    modelRegistry: {} as ExtensionContext["modelRegistry"],
    scopedModels: [],
    model: undefined,
    signal: undefined,
    isIdle: () => true,
    isProjectTrusted: () => true,
    abort: () => undefined,
    hasPendingMessages: () => false,
    shutdown: () => undefined,
    getContextUsage: () => undefined,
    compact: () => undefined,
    getSystemPrompt: () => "",
    tools: [],
    executeTool: () => Promise.reject(new Error("Nested tool calls are not available in tests")),
  };
}
const OPEN_FOLDER_MENU_ITEM_ID = "file.open-folder";
const CHECK_FOR_UPDATES_MENU_ITEM_ID = "app.check-for-updates";
const QUIT_FLUSH_TIMEOUT_MS = 5_000;
// Part of the quit budget above: renderers get this long to send their debounced drafts.
const DRAFT_FLUSH_TIMEOUT_MS = 2_000;
const composerDraftFlusher = new PendingComposerDraftFlusher(DRAFT_FLUSH_TIMEOUT_MS);
const workflowLeaveGuard = new WorkflowLeaveGuard(async (window) => {
  // 测试模式没有真人应答原生兜底框（渲染层已崩时页内对话框也不存在）：
  // 代答「放弃并离开」让 quit 链走完，与 harness 页内对话框代答同语义。
  if (appTestMode !== undefined) return true;
  const result = await dialog.showMessageBox(window, {
    type: "warning",
    title: "工作流页面无法响应",
    message: "页面无法处理保存选择。是否放弃未保存内容并继续离开？",
    detail: "未保存的画布修改可能丢失。选择继续等待会保留当前窗口。",
    buttons: ["继续等待", "放弃并离开"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return result.response === 1;
});
let quitLeaveApproved = false;
let quitLeaveChecking = false;
// Once any quit attempt started, window close events must close for real, not
// divert into the tray behavior below.
let appQuitting = false;
let tray: Tray | undefined;
// Windows whose draft was flushed and whose close is now allowed through.
const windowsClosingAfterDraftFlush = new WeakSet<BrowserWindow>();

function getTerminalService(): TerminalService {
  if (!terminalService) {
    terminalService = new TerminalService({
      getWorkspacePath: (workspaceId) => store.getWorkspacePath(workspaceId),
      getIntegratedTerminalShell: () => integratedTerminalShell,
      isPackaged: app.isPackaged,
    });
  }
  return terminalService;
}

// Resolve the bundled application icon. In dev the repo's `resources/icon.png`
// sits two levels up from the compiled `out/main/main.js`; in a packaged build
// it is copied to `process.resourcesPath` via `extraResources` in
// electron-builder.yml. On macOS packaged builds the window/dock icon already
// comes from `icon.icns` in the app bundle, so we only need the PNG for dev
// and for Linux/Windows window chrome.
const appIconPath = app.isPackaged
  ? path.join(process.resourcesPath, "icon.png")
  : path.join(__dirname, "..", "..", "resources", "icon.png");
const appIcon = nativeImage.createFromPath(appIconPath);

function showAllWindowsFromTray(): void {
  for (const window of windowOwner.allWindows()) {
    if (window.isDestroyed()) continue;
    window.show();
    window.focus();
  }
}

function quitFromTray(): void {
  // 隐藏窗口里的未保存画布确认没人看得见，先显示窗口再走退出链。
  showAllWindowsFromTray();
  app.quit();
}

/** 关窗行为设置驱动的托盘：tray 模式常驻，quit 模式（默认）无托盘。 */
function syncTray(closeWindowBehavior: CloseWindowBehavior): void {
  if (closeWindowBehavior === "tray") {
    if (tray) return;
    const icon = appIcon.resize({ width: 16, height: 16 });
    const created = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
    created.setToolTip(app.name);
    created.on("click", () => showAllWindowsFromTray());
    created.setContextMenu(
      Menu.buildFromTemplate([
        { label: tMain("Show window"), click: () => showAllWindowsFromTray() },
        { type: "separator" },
        { label: tMain("Quit"), click: () => quitFromTray() },
      ]),
    );
    tray = created;
    return;
  }
  tray?.destroy();
  tray = undefined;
}

function parseExternalWebUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

function appRendererUrl(): string {
  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    return process.env.ELECTRON_RENDERER_URL;
  }
  const indexPath = path.join(__dirname, "..", "renderer", "index.html");
  return pathToFileURL(indexPath).toString();
}

function isInAppNavigationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const appUrl = new URL(appRendererUrl());
    return parsed.href === appUrl.href || (isDev && parsed.origin === appUrl.origin);
  } catch {
    return false;
  }
}

/**
 * 是不是「重载当前页面」：同源同路径（hash/search 差异也算重载，如 dev 的 #/route）。
 * 用于在重载前先让渲染层交出还在防抖窗口里的草稿——重载会丢掉整个渲染进程。
 */
function isPageReload(contentsUrl: string, targetUrl: string): boolean {
  try {
    if (!isInAppNavigationUrl(targetUrl)) return false;
    const current = new URL(contentsUrl);
    const target = new URL(targetUrl);
    return current.origin === target.origin && current.pathname === target.pathname;
  } catch {
    return false;
  }
}

function openExternalWebUrl(url: string): boolean {
  const parsed = parseExternalWebUrl(url);
  if (!parsed) {
    return false;
  }
  void shell.openExternal(parsed.toString()).catch((error) => {
    console.error(`Failed to open external URL: ${parsed.toString()}`, error);
  });
  return true;
}

/** MCP sign-in pages: any https URL, or http only on this machine (a local OAuth server). */
function openMcpSignInUrl(url: string): void {
  const parsed = parseExternalWebUrl(url);
  const loopback =
    parsed?.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase());
  if (!parsed || (parsed.protocol !== "https:" && !loopback)) {
    // Sign-in URLs carry state and codes in their query, so logs name the origin at most.
    console.error(
      `Refusing to open an MCP sign-in URL${parsed ? ` on ${parsed.origin}` : " that is not http or https"}`,
    );
    showMcpSignInUrl(url, tMain("pi-gui opens only https links, or http links on this computer."));
    return;
  }
  shell.openExternal(parsed.toString()).catch((error: unknown) => {
    console.error(`Failed to open an MCP sign-in URL on ${parsed.origin}`, error);
    showMcpSignInUrl(parsed.toString(), tMain("pi-gui could not open your browser."));
  });
}

/** When the browser cannot be opened, the link is shown so the person can copy it. */
function showMcpSignInUrl(url: string, reason: string): void {
  const window = mainWindow && canPublishToWindow(mainWindow) ? mainWindow : undefined;
  const options: MessageBoxOptions = {
    type: "warning",
    title: "pi-gui",
    message: "Open this MCP sign-in link yourself",
    detail: `${reason} Check the link before you open it:\n\n${url}`,
    buttons: ["Copy link", "Close"],
    defaultId: 0,
    cancelId: 1,
  };
  (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options))
    .then(({ response }) => {
      if (response === 0) clipboard.writeText(url);
    })
    .catch((error: unknown) => {
      console.error("Failed to show the MCP sign-in link", error);
    });
}

async function openExternalLink(url: string): Promise<void> {
  const parsed = parseExternalWebUrl(url);
  if (!parsed) {
    throw new Error(`Refusing to open unsupported URL: ${url}`);
  }
  await shell.openExternal(parsed.toString());
}

function readClipboardImageAttachment(): ClipboardImageRead {
  const image = clipboard.readImage();
  if (image.isEmpty()) {
    return { ok: false };
  }

  const size = image.getSize();
  try {
    assertComposerImagePixels(size.width, size.height);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const png = image.toPNG();
  if (png.length === 0) {
    return { ok: false };
  }
  try {
    assertComposerImageBytes(png.length);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    ok: true,
    attachment: {
      id: randomUUID(),
      kind: "image",
      name: "pasted-image.png",
      mimeType: "image/png",
      data: png.toString("base64"),
    },
  };
}

function dispatchCloseFocusedSurface(window: BrowserWindow, event: Electron.Event): void {
  event.preventDefault();
  const webContentsId = window.webContents.id;
  surfaceCloseShortcutIds.add(webContentsId);
  setImmediate(() => {
    surfaceCloseShortcutIds.delete(webContentsId);
  });
  window.webContents.send(desktopIpc.appCommand, desktopCommands.closeFocusedSurface);
}

// The native window colour matches the renderer's theme, so load, reload and
// resize never flash another theme's colour.
function currentWindowBackground(): string {
  return windowBackgroundFor(
    store?.snapshot().themePresetId ?? "default",
    themeManager.getResolvedTheme(),
  );
}

// Windows created transparent keep their glass until the next launch.
const opaqueAppWindows = new Set<BrowserWindow>();

function refreshWindowBackgrounds(): void {
  if (!store) return;
  const color = currentWindowBackground();
  for (const window of opaqueAppWindows) {
    if (!window.isDestroyed()) window.setBackgroundColor(color);
  }
}

function createWindow(): BrowserWindow {
  const backgroundTestMode = windowTestMode === "background";
  const enableTransparency = store ? store.snapshot().enableTransparency : false;
  const window = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 560,
    minHeight: 600,
    transparent: enableTransparency,
    vibrancy: process.platform === "darwin" && enableTransparency ? "under-window" : undefined,
    titleBarStyle: "hiddenInset",
    autoHideMenuBar: process.platform !== "darwin",
    backgroundColor: enableTransparency ? "#00000000" : currentWindowBackground(),
    trafficLightPosition: { x: 18, y: 18 },
    show: false,
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep hidden test windows responsive so Playwright exercises the same UI flows.
      backgroundThrottling: !backgroundTestMode,
    },
  });

  workflowLeaveGuard.watch(window);
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!isInAppNavigationUrl(url)) {
      openExternalWebUrl(url);
    }
    return { action: "deny" };
  });
  window.webContents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame) return;
    try {
      const url = new URL(event.url);
      if (
        url.protocol !== `${DESKTOP_EXTENSION_SCHEME}:` ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        throw new Error("Unexpected frame navigation");
      if (!extensionViewOwner) throw new Error("Extension host unavailable");
      extensionViewOwner.getConnectionContext(url.hostname, window.webContents.id);
    } catch {
      event.preventDefault();
    }
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isInAppNavigationUrl(url)) {
      return;
    }
    event.preventDefault();
    openExternalWebUrl(url);
  });
  // Reload discards the renderer, and with it any draft still inside its debounce window
  // (typing schedules the save ~350ms out). Hold the reload until the renderer has handed
  // over its pending drafts, the same way window close does, then reload for real.
  let reloadAfterDraftFlush = false;
  window.webContents.on("did-start-navigation", (event) => {
    if (!event.isMainFrame || reloadAfterDraftFlush) return;
    // A same-document navigation keeps the renderer, so there is nothing to save.
    if (event.isSameDocument) return;
    if (!isPageReload(window.webContents.getURL(), event.url)) return;
    event.preventDefault();
    void composerDraftFlusher
      .flush([window])
      .then(() => {
        if (window.isDestroyed() || window.webContents.isDestroyed()) return;
        reloadAfterDraftFlush = true;
        window.webContents.reload();
      })
      .catch((error: unknown) => {
        console.error("[main] Draft flush before reload failed", error);
      });
  });

  window.on("close", (event) => {
    if (surfaceCloseShortcutIds.has(window.webContents.id)) {
      event.preventDefault();
      surfaceCloseShortcutIds.delete(window.webContents.id);
      return;
    }
    // Quit flushes every window's draft and then the store before it closes any window. A
    // close during that flush would drop this window's draft, and closing the last window
    // would re-enter quit and skip the store flush, so quit closes it once the flush ends.
    if (quitFlush === "flushing") {
      event.preventDefault();
      return;
    }
    if (quitFlush === "done" || windowsClosingAfterDraftFlush.delete(window)) return;
    // 托盘模式：关窗＝隐藏窗口，进程留在托盘等托盘菜单/再次启动唤回；退出仍可从托盘菜单发起。
    if (store?.snapshot().closeWindowBehavior === "tray" && !appQuitting) {
      event.preventDefault();
      window.hide();
      return;
    }
    // Otherwise hold this close until the renderer sends its debounced draft, since closing
    // the window would discard it.
    event.preventDefault();
    void workflowLeaveGuard
      .request(window)
      .then(async (allowed) => {
        if (!allowed) return;
        await composerDraftFlusher.flush([window]);
        if (window.isDestroyed()) return;
        windowsClosingAfterDraftFlush.add(window);
        window.close();
      })
      .catch((error: unknown) => {
        console.error("[main] Closing the window after its draft flush failed", error);
      });
  });
  window.once("ready-to-show", () => {
    if (!backgroundTestMode) {
      window.show();
    }
  });
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") {
      return;
    }

    // Side panel tab chords act from the terminal and extension views too. The
    // key is not consumed: that would also swallow the modifier's keyup, leaving
    // the tab hints up, and on Windows and Linux it would let the Alt release
    // open the hidden menu bar. The page takes no default action for these keys,
    // and the renderer's own handling of the same keydown is idempotent.
    const sidePanelTabCommand = getSidePanelTabCommand(process.platform, input);
    if (sidePanelTabCommand) {
      if (!input.isAutoRepeat) window.webContents.send(desktopIpc.appCommand, sidePanelTabCommand);
      return;
    }

    const lowerKey = input.key.toLowerCase();
    const platformModifier = platformShortcutModifier(process.platform, input);
    const command = getDesktopCommandFromShortcut({
      modifier: platformModifier,
      alt: input.alt,
      shift: input.shift,
      key: input.key,
      code: input.code,
    });
    const webContentsId = window.webContents.id;
    const terminalFocused = terminalFocusedWebContentsIds.has(webContentsId);
    const closeFocusedSurface =
      isCloseFocusedSurfaceShortcut({
        meta: input.meta,
        control: input.control,
        alt: input.alt,
        shift: input.shift,
        key: input.key,
        code: input.code,
        platform: process.platform,
      }) &&
      (terminalFocused || sidePanelFocusedWebContentsIds.has(webContentsId));
    if (terminalFocused) {
      // Control chords belong to the shell, so only macOS Command chords open
      // a palette or act on the thread from the terminal.
      if (process.platform === "darwin" && isSinglePressCommand(command)) {
        event.preventDefault();
        if (!input.isAutoRepeat) window.webContents.send(desktopIpc.appCommand, command);
      } else if (command === desktopCommands.toggleSidePanel) {
        event.preventDefault();
        window.webContents.send(desktopIpc.appCommand, command);
      } else if (closeFocusedSurface) {
        dispatchCloseFocusedSurface(window, event);
      }
      return;
    }
    if (closeFocusedSurface) {
      dispatchCloseFocusedSurface(window, event);
      return;
    }
    if (platformModifier && input.shift && lowerKey === "n") {
      event.preventDefault();
      createAppWindow(windowOwner.viewForWindow(window));
      return;
    }

    if (platformModifier && !input.shift && lowerKey === "o") {
      event.preventDefault();
      void pickWorkspaceViaDialog(window).catch((error: unknown) => {
        console.error("[main] pickWorkspaceViaDialog failed", error);
      });
      return;
    }

    if (platformModifier && !input.shift && lowerKey === "v") {
      const clipboardImage = readClipboardImageAttachment();
      if (clipboardImage.ok || clipboardImage.message) {
        event.preventDefault();
        window.webContents.send(desktopIpc.clipboardImagePasted, clipboardImage);
        return;
      }
    }

    if (command) {
      event.preventDefault();
      // Holding a palette chord would open and close it at the repeat rate.
      if (isSinglePressCommand(command) && input.isAutoRepeat) {
        return;
      }
      window.webContents.send(desktopIpc.appCommand, command);
    }
  });

  if (isDev) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL as string).catch((error: unknown) => {
      console.error("[main] loadURL failed", error);
    });
    if (process.env.PI_APP_OPEN_DEVTOOLS !== "0") {
      window.webContents.openDevTools({ mode: "detach" });
    }
  } else {
    void window.loadURL(appRendererUrl()).catch((error: unknown) => {
      console.error("[main] loadURL failed", error);
    });
  }

  if (!enableTransparency) {
    opaqueAppWindows.add(window);
    window.once("closed", () => opaqueAppWindows.delete(window));
  }

  return window;
}

function createAppWindow(sourceView?: DesktopAppViewState): BrowserWindow {
  const window = createWindow();
  const webContentsId = window.webContents.id;
  windowOwner.add(window, sourceView);
  themeManager.trackWindow(window);

  window.once("closed", () => {
    windowOwner.remove(window);
    terminalFocusedWebContentsIds.delete(webContentsId);
    sidePanelFocusedWebContentsIds.delete(webContentsId);
    surfaceCloseShortcutIds.delete(webContentsId);
    terminalService?.disposeWebContents(webContentsId);
    void store
      .cancelPendingDialogsWithoutVisibleWindow((sessionRef) =>
        windowOwner.isSessionVisibleInAnotherWindow(sessionRef),
      )
      .catch((error: unknown) => {
        console.error("[main] cancelPendingDialogsWithoutVisibleWindow failed", error);
      });
    if (windowOwner.size() === 0) {
      terminalService?.dispose();
      terminalService = undefined;
    }
  });

  return window;
}

function canPublishToWindow(window: BrowserWindow): boolean {
  return (
    !window.isDestroyed() && !window.webContents.isDestroyed() && !window.webContents.isCrashed()
  );
}

function resolveAppTestMode(value: string | undefined): "foreground" | "background" | undefined {
  return value === "foreground" || value === "background" ? value : undefined;
}

function resolveDialogWindow(parentWindow?: BrowserWindow | null): BrowserWindow | undefined {
  return windowOwner.resolveDialogWindow(parentWindow);
}

async function stateForWindow(window?: BrowserWindow | null): Promise<DesktopAppState> {
  return windowOwner.stateForWindow(window);
}

function runWindowScopedForWindow(
  window: BrowserWindow | null | undefined,
  action: () => Promise<DesktopAppState>,
  options: { readonly forceActiveWindow?: boolean } = {},
): Promise<DesktopAppState> {
  return windowOwner.runStateAction(window, action, options);
}

async function pickWorkspacePathViaDialog(
  parentWindow?: BrowserWindow | null,
): Promise<string | undefined> {
  const window = resolveDialogWindow(parentWindow);
  const result = window
    ? await dialog.showOpenDialog(window, {
        properties: ["openDirectory"],
        title: tMain("Open workspace folder"),
      })
    : await dialog.showOpenDialog({
        properties: ["openDirectory"],
        title: tMain("Open workspace folder"),
      });
  if (result.canceled || result.filePaths.length === 0) {
    return undefined;
  }
  return result.filePaths[0] as string;
}

async function addPickedWorkspace(
  window: BrowserWindow | null | undefined,
  workspacePath: string,
): Promise<DesktopAppState> {
  const nextState = await store.addWorkspace(workspacePath);
  if (!nextState.selectedWorkspaceId) {
    return nextState;
  }
  const newThreadState =
    nextState.activeView === "new-thread" ? nextState : await store.setActiveView("new-thread");
  if (window) {
    window.webContents.send(desktopIpc.workspacePicked, nextState.selectedWorkspaceId);
  }
  return newThreadState;
}

async function pickWorkspaceViaDialog(
  parentWindow?: BrowserWindow | null,
): Promise<DesktopAppState> {
  const window = resolveDialogWindow(parentWindow);
  const workspacePath = await pickWorkspacePathViaDialog(window);
  if (!workspacePath) {
    return stateForWindow(window);
  }
  return runWindowScopedForWindow(window, () => addPickedWorkspace(window, workspacePath));
}

async function runManualUpdateCheck(): Promise<void> {
  const window = mainWindow && canPublishToWindow(mainWindow) ? mainWindow : undefined;
  const showDialog = (options: MessageBoxOptions) =>
    window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);

  try {
    const result = await checkForUpdate();

    if (result.status === "update-available") {
      // The manual menu path always confirms with a dialog — a notification may
      // be silently suppressed if the OS permission is denied.
      const choice = await showDialog({
        type: "info",
        title: "pi-gui",
        message: tMain("Version {version} is available.", { version: result.latestVersion }),
        detail: tMain("You have {version}.", { version: result.currentVersion }),
        buttons: [tMain("Download"), tMain("Later")],
        defaultId: 0,
        cancelId: 1,
      });
      if (choice.response === 0) {
        await openReleasesPage(result.releaseUrl);
      }
      return;
    }

    if (result.status === "up-to-date") {
      await showDialog({
        type: "info",
        title: "pi-gui",
        message: tMain("You're up to date on version {version}.", {
          version: result.currentVersion,
        }),
        buttons: [tMain("OK")],
      });
      return;
    }

    await showDialog({
      type: "warning",
      title: "pi-gui",
      message: tMain("Could not check for updates right now."),
      detail: result.message,
      buttons: [tMain("OK")],
    });
  } catch (error) {
    console.error("pi-gui: manual update check failed:", error);
    await showDialog({
      type: "warning",
      title: "pi-gui",
      message: tMain("Could not check for updates right now."),
      detail: error instanceof Error ? error.message : String(error),
      buttons: [tMain("OK")],
    }).catch(() => undefined);
  }
}

function installApplicationMenu(): void {
  if (process.platform !== "darwin") {
    return;
  }

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          id: CHECK_FOR_UPDATES_MENU_ITEM_ID,
          label: tMain("Check for Updates…"),
          click: () => {
            void runManualUpdateCheck().catch((error: unknown) => {
              console.error("[main] runManualUpdateCheck failed", error);
            });
          },
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: tMain("File"),
      submenu: [
        {
          label: tMain("New Thread"),
          accelerator: "CommandOrControl+N",
          click: () => {
            const window = BrowserWindow.getFocusedWindow() ?? mainWindow;
            window?.webContents.send(desktopIpc.appCommand, desktopCommands.openNewThread);
          },
        },
        {
          id: NEW_WINDOW_MENU_ITEM_ID,
          label: tMain("New Window"),
          accelerator: "CommandOrControl+Shift+N",
          click: () => {
            createAppWindow(windowOwner.foregroundView());
          },
        },
        { type: "separator" },
        {
          id: OPEN_FOLDER_MENU_ITEM_ID,
          label: tMain("Open Folder…"),
          accelerator: "Command+O",
          click: () => {
            void pickWorkspaceViaDialog(mainWindow).catch((error: unknown) => {
              console.error("[main] pickWorkspaceViaDialog failed", error);
            });
          },
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    {
      label: tMain("View"),
      submenu: [
        // Cmd+R toggles Review and Shift+Cmd+R renames the thread, so neither
        // reload has a shortcut.
        {
          label: tMain("Reload"),
          click: () => BrowserWindow.getFocusedWindow()?.webContents.reload(),
        },
        {
          label: tMain("Force Reload"),
          click: () => BrowserWindow.getFocusedWindow()?.webContents.reloadIgnoringCache(),
        },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Ensure npm (and other Homebrew/npm-global binaries) are available even when
// pi-gui is launched via Finder/Dock (which hands the process a minimal PATH).
// POSIX-only; on Windows the PATH is left untouched (see augmentPosixPath).
// Tests that need an exact PATH (no gh, say, on a Mac runner whose Homebrew has one) opt out.
const augmentedPath = augmentPosixPath();
if (augmentedPath.changed && !(appTestMode && process.env.PI_APP_TEST_EXACT_PATH === "1")) {
  process.env.PATH = augmentedPath.path;
}

app.setName("pi");

// D6 便携现场兜底提前到模块顶层：首个会话/扩展初始化也必须吃到 PAO_HOME
// （pao 各模块按会话注册时读环境变量，晚于会话启动的注入会让首会话丢 pao 能力）。
// 设置未配置期间便携注入持续生效（resolvePaoHomeInjection 按 portable 来源 keep），
// 显式配置一旦保存即覆盖。开发态不触发。
applyPortablePaoHome({ packaged: app.isPackaged, exePath: process.execPath });

const configuredUserDataDir = process.env.PI_APP_USER_DATA_DIR?.trim() || app.getPath("userData");
app.setPath("userData", configuredUserDataDir);

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  // app.quit() before ready can leave a windowless macOS process alive.
  // Duplicate instances have no store or windows, so exit immediately.
  app.exit(0);
}

app.on("second-instance", () => {
  const window = windowOwner.foreground();
  if (!window) {
    return;
  }
  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
});

app
  .whenReady()
  .then(async () => {
    if (!hasSingleInstanceLock) {
      return;
    }

    // On macOS, packaged builds already render the dock icon from `icon.icns`
    // in the app bundle. In dev we override the generic Electron dock icon with
    // the real PNG so the running app looks right end-to-end.
    if (process.platform === "darwin" && !app.isPackaged) {
      app.dock?.setIcon(appIcon);
    }

    let generateThreadTitleOverride:
      | ((
          workspace: WorkspaceRef,
          options: GenerateThreadTitleOptions,
        ) => Promise<string | null | undefined>)
      | undefined;
    let deferredThreadTitle:
      | {
          resolve: (title: string | null) => void;
          reject: (error: Error) => void;
        }
      | undefined;
    const orchestrationRuntimeBridge = createStoreBackedOrchestrationRuntimeBridge();
    const scheduledTaskRuntimeBridge = createStoreBackedScheduledTaskRuntimeBridge();
    const checkpoints = new TurnCheckpointStore(configuredUserDataDir);
    const extensionViews: DesktopExtensionViewOwner = new DesktopExtensionViewOwner({
      frameDocument: extensionFrameDocument,
      hostAssets: {
        "frame-bridge.js": {
          body: await readFile(
            createRequire(__filename).resolve("@pi-gui/extension-ui/frame-bridge"),
            "utf8",
          ),
          contentType: "text/javascript; charset=utf-8",
        },
      },
      onHostAction: (context) =>
        performExtensionViewHostAction(
          {
            store,
            windows: windowOwner,
            views: extensionViews,
            openExternal: openExternalLink,
            saveComposerDraft: (window) => composerDraftFlusher.flush([window]),
          },
          context,
        ),
      onDiagnostic: (target, source, message) =>
        console.error("[extension-view]", target.sessionId, source, message),
    });
    extensionViewOwner = extensionViews;
    protocol.handle(DESKTOP_EXTENSION_SCHEME, (request) =>
      extensionViews.assetResponse(request.url),
    );
    const driverOptions: NonNullable<
      ConstructorParameters<typeof DesktopAppStore>[0]["driverOptions"]
    > = {
      onTurnCaptureBoundary: (boundary, signal) => checkpoints.recordBoundary(boundary, signal),
      // The store bounds each capture from when it starts; this only stops a stuck boundary,
      // including one waiting behind another run's capture in the same checkout.
      turnCaptureTimeoutMs: TURN_CAPTURE_BACKSTOP_MS,
      desktopExtensions: {
        onChanged: (runtime) => extensionViews.replaceRuntime(runtime),
        onInvalidated: ({ target, generation }) =>
          extensionViews.invalidateRuntime(target, generation),
      },
      openUrl: openMcpSignInUrl,
      builtinExtensions: [
        {
          name: "pi-gui-thread-orchestration",
          displayName: "Thread orchestration",
          description: "Lets pi start, read and message other pi-gui threads",
          factory: createOrchestrationRuntimeExtension(orchestrationRuntimeBridge),
        },
        {
          name: "pi-gui-scheduled-tasks",
          displayName: "Scheduled tasks",
          description: "Lets pi create and update local pi-gui scheduled tasks",
          factory: createScheduledTaskRuntimeExtension(scheduledTaskRuntimeBridge, (ctx) => {
            try {
              return sessionRefFromExtensionContext(ctx).workspaceId;
            } catch {
              return undefined;
            }
          }),
        },
      ],
    };
    store = new DesktopAppStore({
      userDataDir: configuredUserDataDir,
      initialWorkspacePaths: resolveInitialWorkspacePaths(),
      getWindow: () => mainWindow,
      shouldKeepSessionDialogs: (sessionRef) =>
        windowOwner?.isSessionVisibleInAnotherWindow(sessionRef) ?? false,
      driverOptions,
      generateThreadTitleOverride: async (workspace, options) =>
        generateThreadTitleOverride?.(workspace, options),
    });
    windowOwner = new WindowOwner(store, {
      onActiveWindowChanged: (window) => {
        mainWindow = window;
        notificationManager?.trackWindow(window);
        notificationPermissionService?.trackWindow(window);
      },
    });
    await store.initialize();
    themeManager.setMode(store.snapshot().themeMode);
    integratedTerminalShell = (await store.getState()).integratedTerminalShell;
    // 必须早于 createWorkboardQuery/startMechanicalMaintenance：看板与机械维护
    // 只读 process.env.PAO_HOME；设置只补缺，已存在的环境变量优先。
    applyPaoHomeSetting((await store.getState()).paoHome);
    // 发行态便携现场兜底（D6）：环境变量与设置都未配置时，exe 同目录若存在
    // 现场标志目录则注入该目录；开发态不触发。
    applyPortablePaoHome({ packaged: app.isPackaged, exePath: process.execPath });
    // 启动期死会话锁回收：须在任何画布/会话驱动 acquire 之前完成（用户反馈的
    // 强杀残留锁卡启动场景）。失败不拦启动——最坏回到手动接管。
    await cleanupDeadSessionLocks(process.env.PAO_HOME).catch((error: unknown) => {
      console.error("[main] 会话锁启动清理失败", error);
    });
    // 一次性主控会话启动清扫（波3 §1d）：登记在册且名下工作流全部终态的会话真删除，
    // 防历史堆积。现有堆积的普通会话不清理（无登记不动，防误删）；失败不拦启动。
    await sweepEphemeralWorkflowSessions(store).catch((error: unknown) => {
      console.error("[main] 一次性会话启动清扫失败", error);
    });
    nativeTheme.on("updated", refreshWindowBackgrounds);
    let windowBackgroundPresetId = store.snapshot().themePresetId;
    stopPruningTerminals = store.subscribe((state) => {
      integratedTerminalShell = state.integratedTerminalShell;
      // 设置保存后免重启生效：同步更新注入的 PAO_HOME（外部环境变量不被覆盖）。
      applyPaoHomeSetting(state.paoHome);
      // The language lives in the shared app state, so the renderer's setting
      // reaches main here; rebuild the menus so they switch at the same moment.
      if (state.language !== installedMenuLanguage) {
        installedMenuLanguage = state.language;
        setI18nLanguage(state.language);
        installApplicationMenu();
        // 托盘菜单文案跟语言一起重建。
        tray?.destroy();
        tray = undefined;
      }
      syncTray(state.closeWindowBehavior);
      if (state.themePresetId !== windowBackgroundPresetId) {
        windowBackgroundPresetId = state.themePresetId;
        refreshWindowBackgrounds();
      }
      const workspacePaths = state.workspaces.map((workspace) => workspace.path);
      const workspacePathSignature = workspacePaths.join("\0");
      if (workspacePathSignature !== retainedTerminalWorkspacePathSignature) {
        retainedTerminalWorkspacePathSignature = workspacePathSignature;
        terminalService?.retainWorkspacePaths(workspacePaths);
      }
    });
    installedMenuLanguage = store.snapshot().language;
    setI18nLanguage(installedMenuLanguage);
    installApplicationMenu();
    syncTray(store.snapshot().closeWindowBehavior);
    if (appTestMode) {
      Object.assign(globalThis, {
        __PI_APP_TEST_HOOKS: {
          // 渲染层 addWorkspacePath 通道已删（波2b P1）：e2e 需要登记工作区时走本主进程钩子。
          addWorkspace: (workspacePath: string) => store.addWorkspace(workspacePath),
          emitSessionEvent: (event: SessionDriverEvent) => store.emitTestSessionEvent(event),
          handleWindowActivation: () => {
            if (mainWindow) {
              windowOwner.activate(mainWindow);
            }
          },
          triggerTrayAction: (action: "show" | "quit") => {
            if (action === "quit") quitFromTray();
            else showAllWindowsFromTray();
          },
          promptForText: (message: string, placeholder?: string, allowEmpty?: boolean) =>
            promptForText(mainWindow, message, placeholder ?? "", allowEmpty ?? false),
          runOrchestrationRuntimeTool: (input: OrchestrationRuntimeToolTestInput) =>
            runOrchestrationRuntimeToolForTest(orchestrationRuntimeBridge, input),
          runScheduledTaskRuntimeTool: (input: ScheduledTaskRuntimeToolTestInput) =>
            runScheduledTaskRuntimeToolForTest(scheduledTaskRuntimeBridge, input),
          fireDueScheduledTasks: (nowIso?: string) =>
            store.fireDueScheduledTasks(nowIso ? new Date(nowIso) : undefined),
          setDeferredThreadTitleMode: () => {
            generateThreadTitleOverride = () =>
              new Promise<string | null>((resolve, reject) => {
                deferredThreadTitle = { resolve, reject };
              });
          },
          hasDeferredThreadTitle: () => Boolean(deferredThreadTitle),
          resolveDeferredThreadTitle: (title: string) => {
            if (!deferredThreadTitle) {
              throw new Error("Deferred thread-title request is unavailable");
            }
            const pending = deferredThreadTitle;
            deferredThreadTitle = undefined;
            pending.resolve(title);
          },
          rejectDeferredThreadTitle: () => {
            if (!deferredThreadTitle) {
              throw new Error("Deferred thread-title request is unavailable");
            }
            const pending = deferredThreadTitle;
            deferredThreadTitle = undefined;
            pending.reject(new Error("Deferred thread-title rejected by test"));
          },
        },
      });
    }
    notificationPermissionService = new NotificationPermissionService(() => mainWindow);
    notificationPermissionService.subscribe((status) => {
      for (const window of windowOwner.allWindows()) {
        if (canPublishToWindow(window)) {
          window.webContents.send(desktopIpc.notificationPermissionStatusChanged, status);
        }
      }
    });
    notificationManager = new NotificationManager(
      store,
      () => mainWindow,
      notificationPermissionService,
      async (sessionRef) => {
        const window = windowOwner.foreground();
        await runWindowScopedForWindow(window, () => store.selectSession(sessionRef), {
          forceActiveWindow: true,
        });
      },
    );
    stopNotifications = notificationManager.start();
    if (!isDev) {
      stopUpdateChecker = initUpdateChecker();
    }

    registerDesktopIpc({
      windows: windowOwner,
      owners: {
        state: store,
        workbench: store,
        extensionViews,
        review: new ReviewOwner({
          checkpoints,
          userDataDir: app.getPath("userData"),
          resolveCheckoutPath: (checkoutId) => store.getWorkspacePath(checkoutId),
          validateTask: (target) =>
            store
              .snapshot()
              .workspaces.some(
                (workspace) =>
                  workspace.id === target.workspaceId &&
                  workspace.sessions.some((session) => session.id === target.sessionId),
              ),
        }),
        workboard: createWorkboardQuery(),
        canvas: createCanvasQuery(),
        workflowWizard: createWorkflowWizardBridge(),
        flowControl: createFlowControlQuery(),
        workspace: store,
        conversation: store,
        orchestration: store,
        scheduledTasks: store,
        settings: store,
        composerDraftFlush: composerDraftFlusher,
        workflowLeaveGuard,
      },
      capabilities: {
        ping: () =>
          devReloadMarkersEnabled
            ? `pi desktop ready:${MAIN_DEV_RELOAD_MARKER}`
            : "pi desktop ready",
        theme: themeManager,
        openExternal: openExternalLink,
        pickWorkspace: (window) => pickWorkspaceViaDialog(window),
        createLoginCallbacks: (window) => createRuntimeLoginCallbacks(window),
        probeCustomProviderModels,
        notificationPermission: () => notificationPermissionService,
        terminal: getTerminalService,
        optionalTerminal: () => terminalService,
        setTerminalFocused: (webContentsId, focused) => {
          if (focused) {
            terminalFocusedWebContentsIds.add(webContentsId);
          } else {
            terminalFocusedWebContentsIds.delete(webContentsId);
          }
        },
        setSidePanelFocused: (webContentsId, focused) => {
          if (focused) {
            sidePanelFocusedWebContentsIds.add(webContentsId);
          } else {
            sidePanelFocusedWebContentsIds.delete(webContentsId);
          }
        },
        setTransparency: (enabled) => {
          if (process.platform !== "darwin") {
            return;
          }
          for (const window of windowOwner.allWindows()) {
            if (!window.isDestroyed()) {
              window.setVibrancy(enabled ? "under-window" : null);
            }
          }
        },
        pickComposerAttachments: async (window, existing = []) => {
          const parent = resolveDialogWindow(window);
          const result = parent
            ? await dialog.showOpenDialog(parent, {
                properties: ["openFile", "multiSelections"],
                title: tMain("Attach files"),
              })
            : await dialog.showOpenDialog({
                properties: ["openFile", "multiSelections"],
                title: tMain("Attach files"),
              });
          if (result.canceled || result.filePaths.length === 0) {
            return undefined;
          }
          return readComposerAttachmentsFromPaths(result.filePaths, existing);
        },
        readClipboardImage: readClipboardImageAttachment,
        validateComposerAttachments: (attachments) =>
          attachments.flatMap(validateComposerAttachmentPayload),
        listWorkspaceFiles,
        readWorkspaceFile,
        revealWorkspaceFile: async (workspacePath, filePath) => {
          const resolved = await resolveExistingWorkspacePath(workspacePath, filePath);
          shell.showItemInFolder(resolved);
        },
        getChangedFiles,
        getFileDiff,
        stageFile,
        relaunchApplication: requestApplicationRelaunch,
      },
    });

    createAppWindow();
    startMechanicalMaintenance();
    void notificationPermissionService.getCurrentStatus().catch((error: unknown) => {
      console.error("[main] getCurrentStatus failed", error);
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createAppWindow();
        startMechanicalMaintenance();
        if (notificationPermissionService) {
          void notificationPermissionService.getCurrentStatus().catch((error: unknown) => {
            console.error("[main] getCurrentStatus failed", error);
          });
        }
      }
    });
  })
  .catch((error: unknown) => {
    console.error("[main] Application startup failed", error);
    app.exit(1);
  });

function stopAppServices(): void {
  stopMechanicalMaintenance();
  stopNotifications?.();
  stopNotifications = undefined;
  notificationManager = undefined;
  notificationPermissionService?.dispose();
  notificationPermissionService = undefined;
  stopUpdateChecker?.();
  stopUpdateChecker = undefined;
  stopPruningTerminals?.();
  stopPruningTerminals = undefined;
  terminalService?.dispose();
  terminalService = undefined;
}

app.on("window-all-closed", () => {
  // macOS normally keeps the app alive after its final window closes. The
  // Electron harness closes windows to end each isolated run, so let explicit
  // test-mode launches quit instead of leaving their process behind forever.
  if (process.platform !== "darwin" || appTestMode !== undefined) {
    // 清理链任何一步抛错都不能拦下 quit：无窗口的活进程正是关窗驻留的形状
    // （异常会被 dead-pipe 边界吸收成弹窗＋继续运行），必须兜到 app.quit()。
    try {
      stopAppServices();
    } catch (error) {
      console.error("[main] Stopping app services during window-all-closed failed", error);
    }
    app.quit();
  } else {
    try {
      stopMechanicalMaintenance();
    } catch (error) {
      console.error("[main] Stopping mechanical maintenance failed", error);
    }
  }
});

app.on("before-quit", (event) => {
  appQuitting = true;
  if (!quitLeaveApproved && store) {
    event.preventDefault();
    if (quitLeaveChecking) return;
    quitLeaveChecking = true;
    void workflowLeaveGuard
      .requestAll(windowOwner.allWindows())
      .then((allowed) => {
        if (allowed) {
          quitLeaveApproved = true;
          app.quit();
        } else {
          applicationRelaunchRequested = false;
          appQuitting = false;
        }
      })
      .catch((error: unknown) => console.error("[main] 工作流退出检查失败", error))
      .finally(() => {
        quitLeaveChecking = false;
      });
    return;
  }
  if (applicationRelaunchRequested) {
    applicationRelaunchRequested = false;
    app.relaunch();
  }
  // 同 window-all-closed：清理抛错不得中断 quit 链（后面的 flush/超时兜底照走）。
  try {
    stopAppServices();
  } catch (error) {
    console.error("[main] Stopping app services during quit failed", error);
  }
  if (quitFlush === "done" || !store) {
    return;
  }

  event.preventDefault();
  // A second quit request during the flush waits for the one already running.
  if (quitFlush === "flushing") return;
  quitFlush = "flushing";
  const quittingStore = store;
  // Stop every managed session runtime so the coding-agent stop chain tears
  // down worker/tool process trees before we exit. Electron's app.quit() sends
  // no signal and Node's beforeExit never fires here, so this is the only
  // trigger those trees get. Runs beside the flush; the quit deadline below
  // keeps a hung stop from blocking exit forever.
  const stopSessions = quittingStore.disposeSessions().catch((error: unknown) => {
    console.error("pi-gui: session dispose failed during quit:", error);
  });
  // Renderers send their debounced drafts first so the store flush below includes them.
  const flush = Promise.all([
    composerDraftFlusher
      .flush(windowOwner.allWindows())
      .then(() => Promise.all([quittingStore.flushPersistence(), extensionViewOwner?.dispose()])),
    stopSessions,
  ]).catch((error: unknown) => {
    console.error("pi-gui: persistence flush failed during quit:", error);
  });
  // Never let a hung flush block quit forever — quit after a bounded wait.
  const flushDeadline = new Promise<void>((resolve) => {
    setTimeout(() => {
      console.warn("pi-gui: persistence flush timed out during quit; quitting anyway.");
      resolve();
    }, QUIT_FLUSH_TIMEOUT_MS);
  });
  void Promise.race([flush, flushDeadline])
    .finally(() => {
      quitFlush = "done";
      app.quit();
    })
    .catch((error: unknown) => {
      console.error("[main] Quit after persistence flush failed", error);
    });
});

function resolveInitialWorkspacePaths(): readonly string[] {
  const raw = process.env.PI_APP_INITIAL_WORKSPACES;
  if (raw !== undefined) {
    return raw
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return [];
}

async function readComposerAttachmentsFromPaths(
  filePaths: readonly string[],
  existing: readonly ComposerAttachment[] = [],
): Promise<ComposerAttachment[]> {
  const planned = filePaths.map((filePath) => ({
    filePath,
    mimeType: mimeTypeForPath(filePath),
  }));
  const imageSizes = await Promise.all(
    planned
      .filter((entry) => entry.mimeType.startsWith("image/"))
      .map(async (entry) => (await stat(entry.filePath)).size),
  );
  assertComposerImageFileSizes(imageSizes, existing);
  return Promise.all(planned.map((entry) => readComposerAttachment(entry.filePath)));
}

async function readComposerAttachment(filePath: string): Promise<ComposerAttachment> {
  const mimeType = mimeTypeForPath(filePath);
  if (mimeType.startsWith("image/")) {
    return readComposerImageAttachment(filePath, mimeType);
  }

  const stats = await stat(filePath);
  return {
    id: randomUUID(),
    kind: "file",
    name: path.basename(filePath),
    mimeType,
    fsPath: filePath,
    ...(typeof stats.size === "number" ? { sizeBytes: stats.size } : {}),
  };
}

async function readComposerImageAttachment(
  filePath: string,
  mimeType: string,
): Promise<ComposerImageAttachment> {
  const stats = await stat(filePath);
  assertComposerImageBytes(stats.size);
  const buffer = await readFile(filePath);
  assertComposerImageBytes(buffer.length);
  const image = nativeImage.createFromBuffer(buffer);
  if (!image.isEmpty()) {
    const size = image.getSize();
    assertComposerImagePixels(size.width, size.height);
  }
  return {
    id: randomUUID(),
    kind: "image",
    name: path.basename(filePath),
    mimeType,
    data: buffer.toString("base64"),
  };
}

function mimeTypeForPath(filePath: string): string {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  const supported = SUPPORTED_IMAGE_TYPES.find((type) => type.extension === extension);
  if (supported) {
    return supported.mimeType;
  }
  return "application/octet-stream";
}

function validateComposerAttachmentPayload(attachment: ComposerAttachment): ComposerAttachment[] {
  if (attachment.kind === "image") {
    if (
      typeof attachment.data !== "string" ||
      typeof attachment.mimeType !== "string" ||
      !SUPPORTED_IMAGE_MIME_TYPES.has(attachment.mimeType)
    ) {
      return [];
    }
    return [
      {
        ...attachment,
        kind: "image",
      },
    ];
  }

  if (
    attachment.kind !== "file" ||
    typeof attachment.fsPath !== "string" ||
    typeof attachment.mimeType !== "string" ||
    typeof attachment.name !== "string"
  ) {
    return [];
  }

  const normalized: ComposerFileAttachment = {
    ...attachment,
    kind: "file",
    fsPath: attachment.fsPath.trim(),
    name: attachment.name.trim() || path.basename(attachment.fsPath),
  };
  if (!normalized.fsPath) {
    return [];
  }
  return [normalized];
}

function createRuntimeLoginCallbacks(window?: BrowserWindow | null) {
  return {
    onAuth: async ({
      url,
      instructions,
    }: {
      readonly url: string;
      readonly instructions?: string;
    }) => {
      await shell.openExternal(url);
      if (instructions?.trim()) {
        await showLoginInstructions(window, instructions.trim());
      }
    },
    onPrompt: async ({
      message,
      placeholder,
      allowEmpty,
    }: {
      readonly message: string;
      readonly placeholder?: string;
      readonly allowEmpty?: boolean;
    }) => promptForText(window, message, placeholder, allowEmpty ?? false),
  };
}

async function showLoginInstructions(
  parentWindow: BrowserWindow | null | undefined,
  message: string,
): Promise<void> {
  const window = resolveDialogWindow(parentWindow);
  if (!window) {
    throw new Error("Main window is not available for login instructions.");
  }
  window.show();
  window.focus();
  await window.webContents.executeJavaScript(`window.alert(${JSON.stringify(message)})`, true);
}

// Electron does not implement window.prompt(), so provider-login text prompts
// are served by a small dedicated modal window instead.
async function promptForText(
  parentWindow: BrowserWindow | null | undefined,
  message: string,
  placeholder = "",
  allowEmpty = false,
): Promise<string> {
  const parent = resolveDialogWindow(parentWindow);
  if (!parent) {
    throw new Error("Main window is not available for login.");
  }
  parent.show();
  parent.focus();

  const modal = new BrowserWindow({
    parent,
    modal: true,
    show: false,
    width: 460,
    height: 220,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: process.platform !== "darwin",
    title: "pi-gui",
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });

  try {
    await modal.loadURL(promptDataUrl(message, placeholder));
    modal.show();
    modal.focus();

    const result = await new Promise<string | null>((resolve) => {
      let settled = false;
      const finish = (value: string | null) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      // Closing the window (title-bar close) counts as a cancel.
      modal.once("closed", () => finish(null));
      // The page wires its own buttons on load and exposes the outcome as a
      // promise; awaiting it here avoids any handler-attachment race.
      modal.webContents
        .executeJavaScript("window.__piPromptResult", true)
        .then((value) => finish(typeof value === "string" ? value : null))
        .catch(() => finish(null));
    });

    if (result === null) {
      throw new Error("Login cancelled.");
    }
    const trimmedResult = result.trim();
    if (!allowEmpty && trimmedResult.length === 0) {
      throw new Error("Login cancelled.");
    }
    return trimmedResult;
  } finally {
    if (!modal.isDestroyed()) {
      modal.destroy();
    }
  }
}

function promptDataUrl(message: string, placeholder: string): string {
  const html = `<!doctype html><html><head><meta charset="utf-8" />
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 18px 20px; font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #f4f5f7; color: #1b1d22; display: flex; flex-direction: column; gap: 14px; height: 100vh; }
  @media (prefers-color-scheme: dark) { body { background: #23262d; color: #e7e9ee; } input { background: #171a1f; color: #e7e9ee; border-color: #3a3f4a; } }
  .msg { line-height: 1.4; white-space: pre-wrap; }
  input { width: 100%; padding: 8px 10px; font-size: 13px; border: 1px solid #c3c8d0; border-radius: 6px;
    background: #fff; color: inherit; }
  input:focus { outline: 2px solid #4a8cff; outline-offset: 0; border-color: #4a8cff; }
  .row { margin-top: auto; display: flex; justify-content: flex-end; gap: 8px; }
  button { padding: 6px 16px; font-size: 13px; border-radius: 6px; border: 1px solid transparent; cursor: pointer; }
  #pi-prompt-cancel { background: transparent; border-color: #b7bdc7; color: inherit; }
  #pi-prompt-ok { background: #2f6ae0; color: #fff; }
</style></head>
<body>
  <div class="msg">${escapeHtml(message)}</div>
  <input id="pi-prompt-input" type="text" placeholder="${escapeHtml(placeholder)}" autofocus />
  <div class="row">
    <button id="pi-prompt-cancel" type="button">${escapeHtml(tMain("Cancel"))}</button>
    <button id="pi-prompt-ok" type="button">${escapeHtml(tMain("OK"))}</button>
  </div>
  <script>
    (function () {
      var resolveResult;
      window.__piPromptResult = new Promise(function (resolve) { resolveResult = resolve; });
      function wire() {
        var input = document.getElementById('pi-prompt-input');
        var ok = document.getElementById('pi-prompt-ok');
        var cancel = document.getElementById('pi-prompt-cancel');
        if (!input || !ok || !cancel) { resolveResult(null); return; }
        ok.addEventListener('click', function () { resolveResult(input.value); });
        cancel.addEventListener('click', function () { resolveResult(null); });
        input.addEventListener('keydown', function (event) {
          if (event.key === 'Enter') { event.preventDefault(); resolveResult(input.value); }
          else if (event.key === 'Escape') { event.preventDefault(); resolveResult(null); }
        });
        input.focus();
        document.body.dataset.piReady = '1';
      }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wire);
      } else {
        wire();
      }
    })();
  </script>
</body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function probeCustomProviderModels(
  input: CustomProviderProbeInput,
): Promise<CustomProviderProbeResult> {
  const baseUrl = input.baseUrl?.trim();
  if (!baseUrl || !isValidHttpBaseUrl(baseUrl)) {
    return { ok: false, error: "Base URL must start with http:// or https://" };
  }
  const target = `${baseUrl.replace(/\/+$/, "")}/models`;
  const apiKey = input.apiKey?.trim();
  try {
    const response = await net.fetch(target, {
      method: "GET",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return { ok: false, error: `${response.status} ${response.statusText} from ${target}` };
    }
    const payload = (await response.json()) as unknown;
    const data = (payload as { data?: unknown }).data;
    if (!Array.isArray(data)) {
      return { ok: false, error: `Response from ${target} is missing a "data" array` };
    }
    const models = data
      .map((entry) => {
        if (
          entry &&
          typeof entry === "object" &&
          typeof (entry as { id?: unknown }).id === "string"
        ) {
          return (entry as { id: string }).id;
        }
        return undefined;
      })
      .filter((id): id is string => Boolean(id && id.length > 0));
    return { ok: true, models };
  } catch (error) {
    return { ok: false, error: describeProbeError(error, target) };
  }
}

function describeProbeError(error: unknown, target: string): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return `Timed out after 5s contacting ${target}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
