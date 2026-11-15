import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  clickSession,
  createNamedThread,
  emitTestSessionEvent,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  pasteTinyPng,
  seedAgentDir,
  selectSession,
  type DesktopHarness,
} from "../helpers/electron-app";
import { expectExtensionViewReady } from "../helpers/desktop-extension-fixture";
import { desktopIpc } from "../../contracts/ipc";

/**
 * 保稿族（S11-B2 三 spec 合一）：composer 草稿在打字、切换、归档、扩展导航、关停、换模型下都不丢。
 * 布局＝三段：
 *  1. 共享启动段（describe.serial，一次冷启跑 10 例）：不打崩进程的草稿行为面。工作区预装
 *     thread-links 扩展（原 card/view 两例各自冷启夹具，现并入共享工作区，冷启前装好）。
 *  2. 关停段（5 例自管冷启）：用例本身就是 quit/关窗/重启，无法共享存活实例。
 *  3. model-change（1 例自管冷启）：需要 seedAgentDir 的模型档位夹具，与共享段的默认 agent 环境不同。
 *  4. 快捷键切换段（1 例自管冷启）：Ctrl+number 按线程新旧序编号，共享段积累的线程会漂移编号，
 *     自管冷启保证编号确定性（原 sync spec 用例，三合一时遗漏，S11-B2 第三世补回）。
 */

const draft = "Unsent draft typed just before shutdown";

/** Freezes renderer timers, so a debounced draft save waits until something flushes it. */
async function pauseRendererTimers(window: Page): Promise<void> {
  await window.clock.install();
  await window.clock.pauseAt(Date.now() + 1_000);
}

async function expectDraftNotSaved(window: Page): Promise<void> {
  expect((await getDesktopState(window)).composerDraft).toBe("");
}

async function typeUnsavedDraft(window: Page, text = draft): Promise<void> {
  const composer = window.getByTestId("composer");
  await composer.click();
  await composer.pressSequentially(text, { delay: 5 });
  await expect(composer).toHaveValue(text);
  // Longer than the debounce in real time: the save stays pending however slow the runner is.
  await window.waitForTimeout(500);
  await expectDraftNotSaved(window);
}

async function expectDraftAfterRelaunch(
  launch: () => Promise<DesktopHarness>,
  title: string,
): Promise<void> {
  const harness = await launch();
  try {
    const window = await harness.firstWindow();
    await selectSession(window, title);
    await expect(window.getByTestId("composer")).toHaveValue(draft);
  } finally {
    await harness.close();
  }
}

/** Keeps a real-time clock usable after the page clock is paused. Call before pausing. */
async function keepRealClock(window: Page): Promise<void> {
  await window.evaluate(() => {
    (globalThis as { realNow?: () => number }).realNow = Date.now.bind(Date);
  });
}

const rendererBusy = "pi-gui test: renderer busy";

/**
 * Blocks the renderer for a second and returns once that task has started, so main's flush
 * request queues behind it. (Waiting only for the task to be posted is not enough: Chromium
 * may run the flush request first.) With `draftAtEnd`, the task ends by calling the
 * composer's change handler outside any DOM event, which React commits in a later task: the
 * text is in the composer but not yet in a pending write when the flush request runs.
 */
async function holdRendererBusy(window: Page, draftAtEnd?: string): Promise<void> {
  const started = window.waitForEvent("console", (message) => message.text() === rendererBusy);
  await window.evaluate(
    ({ nextDraft, busyMessage }) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        // DevTools delivers this while the loop below still holds the renderer.
        console.log(busyMessage);
        const realNow = (globalThis as { realNow?: () => number }).realNow;
        if (!realNow) throw new Error("real clock unavailable");
        const until = realNow() + 1_000;
        while (realNow() < until) {
          // Busy on purpose.
        }
        if (nextDraft === null) return;
        const composer = document.querySelector("[data-testid='composer']");
        const propsKey =
          composer && Object.keys(composer).find((key) => key.startsWith("__reactProps$"));
        if (!composer || !propsKey) throw new Error("composer change handler unavailable");
        const props = (composer as unknown as Record<string, { onChange(event: unknown): void }>)[
          propsKey
        ];
        props.onChange({ target: { value: nextDraft } });
      };
      channel.port2.postMessage(null);
    },
    { nextDraft: draftAtEnd ?? null, busyMessage: rendererBusy },
  );
  await started;
}

function launcher(name: string): () => Promise<DesktopHarness> {
  const setup = Promise.all([makeUserDataDir(), makeWorkspace(name)]);
  return async () => {
    const [userDataDir, workspace] = await setup;
    return launchDesktop(userDataDir, { initialWorkspaces: [workspace], testMode: "background" });
  };
}

function processExit(harness: DesktopHarness): Promise<void> {
  return new Promise((resolve) => harness.electronApp.process().once("exit", () => resolve()));
}

async function closeFirstWindow(harness: DesktopHarness): Promise<void> {
  await harness.electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close();
  });
}

/** A card command and a side-panel view, each with a button that opens a thread by its id. */
async function installThreadLinks(workspacePath: string): Promise<void> {
  const extension = join(workspacePath, ".pi", "extensions", "thread-links");
  await mkdir(join(extension, "dist"), { recursive: true });
  await writeFile(
    join(extension, "index.ts"),
    `import { registerDesktopView } from ${JSON.stringify(require.resolve("@pi-gui/extension-ui"))};
export default function extension(pi) {
  registerDesktopView(pi, {
    id: "thread-links", title: "Thread links", source: import.meta.url,
    frontend: new URL("./dist/desktop.js", import.meta.url),
    backend: () => ({ id: "thread-links.backend", setup() {} }),
  });
  pi.registerCommand("jump", {
    description: "Card that opens a thread",
    handler: async (args) => pi.appendEntry("pi-gui.card", {
      title: "Related thread",
      actions: [{ type: "openThread", label: "Open related thread", sessionId: args.trim() }],
    }),
  });
}`,
  );
  await writeFile(
    join(extension, "dist", "desktop.js"),
    `export function mount(root, host) {
  const thread = document.createElement("input");
  thread.setAttribute("aria-label", "Thread id");
  const button = document.createElement("button");
  button.textContent = "Open thread";
  button.onclick = () => void host.actions.openThread(thread.value);
  root.append(thread, button);
  return () => {};
}`,
  );
}

interface TestDraftWriteControl {
  readonly drafts: string[];
  releaseFirstWrite(): void;
}

test.describe.serial("composer drafts survive typing and navigation on a shared app", () => {
  let harness: DesktopHarness;
  let window: Page;

  test.beforeAll(async () => {
    const workspacePath = await makeWorkspace("composer-draft-keeps");
    await installThreadLinks(workspacePath);
    harness = await launchDesktop(await makeUserDataDir(), {
      initialWorkspaces: [workspacePath],
      testMode: "background",
    });
    window = await harness.firstWindow();
  });

  test.afterAll(async () => {
    await harness?.close();
  });

  test("ignores stale persisted draft acknowledgements while typing", async () => {
    test.setTimeout(60_000);
    await createNamedThread(window, "Composer draft sync");

    const composer = window.getByTestId("composer");
    const expectedDraft = "forced-race-abcdef";
    const staleDraft = `${expectedDraft}x`;

    await composer.fill(staleDraft);
    await composer.press("Backspace");
    await expect(composer).toHaveValue(expectedDraft);

    const [, sampledValues] = await Promise.all([
      window.evaluate(
        async ({ stale }) => {
          await new Promise<void>((resolve) => globalThis.window.setTimeout(resolve, 50));
          const app = globalThis.window.piApp;
          if (!app) throw new Error("piApp IPC bridge is unavailable");
          const { selectedWorkspaceId, selectedSessionId } = await app.getState();
          if (!selectedWorkspaceId || !selectedSessionId) throw new Error("No selected session");
          await app.updateComposerDraft(stale, {
            workspaceId: selectedWorkspaceId,
            sessionId: selectedSessionId,
          });
        },
        { stale: staleDraft },
      ),
      window.evaluate(async () => {
        const composer = document.querySelector<HTMLTextAreaElement>("[data-testid='composer']");
        if (!composer) {
          throw new Error("Composer textarea was unavailable");
        }

        const values: string[] = [];
        const started = performance.now();
        while (performance.now() - started < 900) {
          values.push(composer.value);
          await new Promise((resolve) => globalThis.window.setTimeout(resolve, 20));
        }
        return values;
      }),
    ]);

    expect(sampledValues).not.toContain(staleDraft);
    await expect(composer).toHaveValue(expectedDraft);
    await expect
      .poll(async () => (await getDesktopState(window)).composerDraft)
      .toBe(expectedDraft);
  });

  test("adopts a persisted draft when no local edit is pending", async () => {
    test.setTimeout(60_000);
    await createNamedThread(window, "Clean composer draft sync");

    const persistedDraft = "persisted outside the local debounce";
    await window.evaluate(async (draft) => {
      const app = globalThis.window.piApp;
      if (!app) {
        throw new Error("piApp IPC bridge is unavailable");
      }
      const { selectedWorkspaceId, selectedSessionId } = await app.getState();
      if (!selectedWorkspaceId || !selectedSessionId) throw new Error("No selected session");
      await app.updateComposerDraft(draft, {
        workspaceId: selectedWorkspaceId,
        sessionId: selectedSessionId,
      });
    }, persistedDraft);

    const composer = window.getByTestId("composer");
    await expect(composer).toHaveValue(persistedDraft);
    await window.waitForTimeout(600);
    await expect(composer).toHaveValue(persistedDraft);
    await expect
      .poll(async () => (await getDesktopState(window)).composerDraft)
      .toBe(persistedDraft);
  });

  test("does not resurrect a cleared draft while an older write is in flight", async () => {
    test.setTimeout(60_000);
    await createNamedThread(window, "In-flight composer clear");
    await harness.electronApp.evaluate(({ ipcMain }, channel) => {
      type InvokeHandler = (...args: unknown[]) => unknown;
      const invokeHandlers = (
        ipcMain as typeof ipcMain & { readonly _invokeHandlers?: Map<string, InvokeHandler> }
      )._invokeHandlers;
      const originalHandler = invokeHandlers?.get(channel);
      if (!originalHandler) {
        throw new Error(`No IPC handler registered for ${channel}`);
      }

      let releaseFirstWrite = () => {};
      const firstWriteGate = new Promise<void>((resolve) => {
        releaseFirstWrite = resolve;
      });
      const control: TestDraftWriteControl = {
        drafts: [],
        releaseFirstWrite,
      };
      (
        globalThis as typeof globalThis & {
          __PI_TEST_COMPOSER_DRAFT_WRITE_CONTROL?: TestDraftWriteControl;
        }
      ).__PI_TEST_COMPOSER_DRAFT_WRITE_CONTROL = control;

      ipcMain.removeHandler(channel);
      (
        globalThis as typeof globalThis & {
          __PI_TEST_DRAFT_ORIGINAL_HANDLER?: InvokeHandler;
        }
      ).__PI_TEST_DRAFT_ORIGINAL_HANDLER = originalHandler;
      ipcMain.handle(channel, async (...args) => {
        const draft: unknown = args[1];
        if (typeof draft !== "string") {
          throw new Error("Composer draft IPC argument was not a string");
        }
        control.drafts.push(draft);
        if (control.drafts.length === 1) {
          await firstWriteGate;
        }
        return originalHandler(...args);
      });
    }, desktopIpc.updateComposerDraft);
    const readDraftWrites = () =>
      harness.electronApp.evaluate(() => {
        const control = (
          globalThis as typeof globalThis & {
            __PI_TEST_COMPOSER_DRAFT_WRITE_CONTROL?: TestDraftWriteControl;
          }
        ).__PI_TEST_COMPOSER_DRAFT_WRITE_CONTROL;
        return control?.drafts ?? [];
      });

    try {
      const composer = window.getByTestId("composer");
      await composer.fill("obsolete in-flight draft");
      await expect.poll(readDraftWrites).toEqual(["obsolete in-flight draft"]);

      await composer.fill("");
      await expect.poll(readDraftWrites).toEqual(["obsolete in-flight draft", ""]);

      await harness.electronApp.evaluate(() => {
        const control = (
          globalThis as typeof globalThis & {
            __PI_TEST_COMPOSER_DRAFT_WRITE_CONTROL?: TestDraftWriteControl;
          }
        ).__PI_TEST_COMPOSER_DRAFT_WRITE_CONTROL;
        if (!control) {
          throw new Error("Delayed composer draft write was not pending");
        }
        control.releaseFirstWrite();
      });

      await expect.poll(readDraftWrites).toEqual(["obsolete in-flight draft", "", ""]);
      await expect(composer).toHaveValue("");
      await expect.poll(async () => (await getDesktopState(window)).composerDraft).toBe("");
    } finally {
      // 共享启动段：用毕摘掉包装、装回原 handler 并放行残门，不泄漏给后续用例。
      await harness.electronApp.evaluate(({ ipcMain }, channel) => {
        type InvokeHandler = (...args: unknown[]) => unknown;
        const store = globalThis as typeof globalThis & {
          __PI_TEST_COMPOSER_DRAFT_WRITE_CONTROL?: TestDraftWriteControl;
          __PI_TEST_DRAFT_ORIGINAL_HANDLER?: InvokeHandler;
        };
        store.__PI_TEST_COMPOSER_DRAFT_WRITE_CONTROL?.releaseFirstWrite();
        const original = store.__PI_TEST_DRAFT_ORIGINAL_HANDLER;
        if (original) {
          ipcMain.removeHandler(channel);
          ipcMain.handle(channel, original);
          delete store.__PI_TEST_DRAFT_ORIGINAL_HANDLER;
        }
      }, desktopIpc.updateComposerDraft);
    }
  });

  test("preserves a composer draft across a fast session switch", async () => {
    test.setTimeout(60_000);
    await createNamedThread(window, "Draft Thread A");
    await createNamedThread(window, "Draft Thread B");

    await selectSession(window, "Draft Thread A");
    const composer = window.getByTestId("composer");
    const draft = "fast-switch-draft-xyz";
    await composer.fill(draft);
    await expect(composer).toHaveValue(draft);

    // Switch away immediately, before the 350ms persist debounce fires: the pending write must be
    // flushed onto Thread A rather than cancelled.
    await clickSession(window, "Draft Thread B");
    await expect(window.locator(".chat-header__title")).toHaveText("Draft Thread B");

    await selectSession(window, "Draft Thread A");
    await expect(composer).toHaveValue(draft);
    await expect.poll(async () => (await getDesktopState(window)).composerDraft).toBe(draft);
  });

  test("applies explicit editor text replacements from the session host", async () => {
    test.setTimeout(60_000);
    await createNamedThread(window, "Editor text sync");

    const composer = window.getByTestId("composer");
    await composer.fill("local draft");
    await expect(composer).toHaveValue("local draft");

    const state = await getDesktopState(window);
    await emitTestSessionEvent(harness, {
      type: "hostUiRequest",
      sessionRef: {
        workspaceId: state.selectedWorkspaceId,
        sessionId: state.selectedSessionId,
      },
      timestamp: new Date().toISOString(),
      request: {
        kind: "editorText",
        requestId: "editor-text-sync",
        text: "remote replacement",
      },
    });

    await expect(composer).toHaveValue("remote replacement");
  });

  for (const operation of ["draft", "command"] as const) {
    test(`keeps a queued ${operation} targeted at the session displayed at dispatch`, async () => {
      test.setTimeout(60_000);
      // 共享启动段：两例同名线程会互相撞车（原各自冷启天然隔离），名字带 operation 区分。
      const alphaTitle = `Target Alpha (${operation})`;
      const bravoTitle = `Target Bravo (${operation})`;
      await createNamedThread(window, alphaTitle);
      await createNamedThread(window, bravoTitle);
      await window.getByTestId("composer").fill("Bravo stays intact");
      await expect
        .poll(async () => (await getDesktopState(window)).composerDraft)
        .toBe("Bravo stays intact");
      await selectSession(window, alphaTitle);
      const state = await getDesktopState(window);
      const workspace = state.workspaces.find((entry) => entry.id === state.selectedWorkspaceId);
      const bravo = workspace?.sessions.find((entry) => entry.title === bravoTitle);
      if (!workspace || !bravo) throw new Error("Expected both target sessions");

      // Deliver both handlers in one main-process turn so navigation queues ahead
      // of the command while Alpha is still displayed. UI input cannot reliably
      // force this ordering; all outcomes are then checked through the real UI.
      await harness.electronApp.evaluate(
        async ({ ipcMain, BrowserWindow }, payload) => {
          type InvokeHandler = (...args: unknown[]) => unknown;
          const handlers = (
            ipcMain as typeof ipcMain & { readonly _invokeHandlers?: Map<string, InvokeHandler> }
          )._invokeHandlers;
          const select = handlers?.get(payload.selectChannel);
          const act = handlers?.get(payload.actionChannel);
          const sender = BrowserWindow.getAllWindows()[0]?.webContents;
          if (!select || !act || !sender) throw new Error("Expected desktop IPC handlers");
          const event = { sender };
          const selection = select(event, payload.target);
          // A draft write names the task it was typed in; a command uses the window's view.
          const action =
            payload.draftTarget === undefined
              ? act(event, payload.text)
              : act(event, payload.text, payload.draftTarget);
          await Promise.all([selection, action]);
        },
        {
          selectChannel: desktopIpc.selectSession,
          actionChannel:
            operation === "draft" ? desktopIpc.updateComposerDraft : desktopIpc.submitComposer,
          target: { workspaceId: workspace.id, sessionId: bravo.id },
          draftTarget:
            operation === "draft"
              ? { workspaceId: workspace.id, sessionId: state.selectedSessionId }
              : undefined,
          text: operation === "draft" ? "Alpha owns this queued draft" : "/status",
        },
      );

      await expect(window.locator(".chat-header__title")).toHaveText(bravoTitle);
      await expect(window.getByTestId("composer")).toHaveValue("Bravo stays intact");
      await expect(window.getByTestId("transcript")).not.toContainText(
        /Model |No session overrides set/,
      );
      await selectSession(window, alphaTitle);
      if (operation === "draft") {
        await expect(window.getByTestId("composer")).toHaveValue("Alpha owns this queued draft");
      } else {
        await expect(window.getByTestId("transcript")).toContainText(
          /Model |No session overrides set/,
        );
        await expect(window.getByTestId("composer")).toHaveValue("");
      }
    });
  }

  test("keeps a draft when the thread is archived by shortcut straight after typing", async () => {
    test.setTimeout(90_000);
    const modifier = process.platform === "darwin" ? "Meta" : "Control";

    await createNamedThread(window, "Kept");
    await createNamedThread(window, "Archived");
    await pauseRendererTimers(window);
    await typeUnsavedDraft(window);
    await window.keyboard.press(`${modifier}+Shift+A`);
    await expect(window.locator(".chat-header__title")).toHaveText("Kept");
    await window.clock.resume();

    await window.locator(".archived-thread-group__toggle").click();
    const archivedRow = window.locator(".session-list--archived .session-row", {
      hasText: "Archived",
    });
    await archivedRow.hover();
    await archivedRow.getByLabel(/^Restore Archived/).click();
    await expect(window.locator(".archived-thread-group")).toHaveCount(0);
    await selectSession(window, "Archived");
    await expect(window.getByTestId("composer")).toHaveValue(draft);
  });

  test("keeps a draft when an extension card button opens another thread straight after typing", async () => {
    test.setTimeout(90_000);
    await createNamedThread(window, "Card target");
    const targetId = (await getDesktopState(window)).selectedSessionId!;
    await createNamedThread(window, "Card drafting");

    const composer = window.getByTestId("composer");
    await composer.fill(`/jump ${targetId}`);
    await composer.press("Enter");
    const openThread = window
      .getByTestId("extension-card")
      .getByRole("button", { name: /Open related thread/ });
    await expect(openThread).toBeVisible();

    await pauseRendererTimers(window);
    await typeUnsavedDraft(window);
    await openThread.click();
    await expect(window.locator(".chat-header__title")).toHaveText("Card target");
    await window.clock.resume();
    await selectSession(window, "Card drafting");
    await expect(window.getByTestId("composer")).toHaveValue(draft);
  });

  test("keeps a draft when an extension view opens another thread straight after typing", async () => {
    test.setTimeout(90_000);
    await createNamedThread(window, "View target");
    const targetId = (await getDesktopState(window)).selectedSessionId!;
    await createNamedThread(window, "View drafting");

    if (!(await window.getByTestId("workbench").isVisible()))
      await window.getByTestId("toggle-side-panel").click();
    await window.getByTestId("workbench-add-tab").click();
    await window
      .getByTestId("workbench-chooser")
      .getByRole("button", { name: "Thread links", exact: true })
      .click();
    await expectExtensionViewReady(window);
    const frame = window.frameLocator('[data-testid="extension-view-frame"]');
    await frame.getByLabel("Thread id").fill(targetId);

    await pauseRendererTimers(window);
    await typeUnsavedDraft(window);
    await frame.getByRole("button", { name: "Open thread" }).click();
    await expect(window.locator(".chat-header__title")).toHaveText("View target");
    await window.clock.resume();
    await selectSession(window, "View drafting");
    await expect(window.getByTestId("composer")).toHaveValue(draft);
  });
});

test("keeps a draft typed just before quitting", async () => {
  test.setTimeout(90_000);
  const launch = launcher("draft-shutdown-quit");
  const harness = await launch();
  const window = await harness.firstWindow();
  await createNamedThread(window, "Quit draft");
  await pauseRendererTimers(window);
  await typeUnsavedDraft(window);
  // Playwright quits through app.quit(), the same path as Cmd-Q and the Quit menu item.
  await harness.close();

  await expectDraftAfterRelaunch(launch, "Quit draft");
});

test("keeps a draft typed just before closing the last window", async () => {
  test.setTimeout(90_000);
  const launch = launcher("draft-shutdown-close");
  const harness = await launch();
  const window = await harness.firstWindow();
  await createNamedThread(window, "Close draft");
  await pauseRendererTimers(window);
  await typeUnsavedDraft(window);
  // Title-bar close; on Linux and Windows closing the last window quits the app.
  const exited = processExit(harness);
  await closeFirstWindow(harness);
  await exited;

  await expectDraftAfterRelaunch(launch, "Close draft");
});

test("keeps a draft when the window is closed while quit is saving drafts", async () => {
  test.setTimeout(90_000);
  const launch = launcher("draft-shutdown-close-during-quit");
  const harness = await launch();
  const window = await harness.firstWindow();
  await createNamedThread(window, "Close during quit");
  await keepRealClock(window);
  await pauseRendererTimers(window);
  await typeUnsavedDraft(window);
  // Quit is still waiting for this renderer's draft when the window is closed.
  await holdRendererBusy(window);
  const exited = processExit(harness);
  await harness.electronApp.evaluate(({ app }) => app.quit());
  await closeFirstWindow(harness);
  await exited;

  await expectDraftAfterRelaunch(launch, "Close during quit");
});

test("keeps an edit React has not committed yet when quitting", async () => {
  test.setTimeout(90_000);
  const launch = launcher("draft-shutdown-uncommitted-edit");
  const harness = await launch();
  const window = await harness.firstWindow();
  await createNamedThread(window, "Uncommitted edit");
  await keepRealClock(window);
  await pauseRendererTimers(window);
  await holdRendererBusy(window, draft);
  const exited = processExit(harness);
  await harness.electronApp.evaluate(({ app }) => app.quit());
  await exited;

  await expectDraftAfterRelaunch(launch, "Uncommitted edit");
});

test("keeps the drafts of every window when quitting straight after typing", async () => {
  test.setTimeout(90_000);
  const launch = launcher("draft-shutdown-multi-window");
  const nativeModifier = process.platform === "darwin" ? "meta" : "control";
  const drafts = { First: "Draft in the first window", Second: "Draft in the second window" };

  const harness = await launch();
  const firstWindow = await harness.firstWindow();
  await createNamedThread(firstWindow, "Second");
  await createNamedThread(firstWindow, "First");
  const opened = harness.electronApp.waitForEvent("window");
  // Same route as the multi-window spec: a native key event reaches main's shortcut handler.
  await harness.electronApp.evaluate(({ BrowserWindow }, modifier) => {
    BrowserWindow.getAllWindows()[0]?.webContents.sendInputEvent({
      type: "keyDown",
      keyCode: "n",
      modifiers: [modifier, "shift"],
    });
  }, nativeModifier);
  const secondWindow = await opened;
  await secondWindow.waitForFunction(() => Boolean(globalThis.window.piApp));
  await selectSession(secondWindow, "Second");

  await pauseRendererTimers(secondWindow);
  await typeUnsavedDraft(secondWindow, drafts.Second);
  await pauseRendererTimers(firstWindow);
  await typeUnsavedDraft(firstWindow, drafts.First);
  await harness.close();

  const relaunched = await launch();
  try {
    const window = await relaunched.firstWindow();
    for (const [title, text] of Object.entries(drafts)) {
      await selectSession(window, title);
      await expect(window.getByTestId("composer")).toHaveValue(text);
    }
  } finally {
    await relaunched.close();
  }
});

test("Cmd/Ctrl+number keeps a draft typed just before switching on its own thread", async () => {
  test.setTimeout(60_000);
  const harness = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [await makeWorkspace("composer-draft-number-switch")],
    testMode: "background",
  });
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  try {
    const window = await harness.firstWindow();
    const title = window.locator(".chat-header__title");
    const composer = window.getByTestId("composer");
    await createNamedThread(window, "Number Alpha");
    await createNamedThread(window, "Number Bravo");
    // Newest first: 1 opens Bravo, 2 opens Alpha.
    await composer.click();
    await composer.pressSequentially("typed right before switching");
    await window.keyboard.press(`${modifier}+2`);
    await expect(title).toHaveText("Number Alpha");
    await expect(composer).toHaveValue("");
    await window.keyboard.press(`${modifier}+1`);
    await expect(title).toHaveText("Number Bravo");
    await expect(composer).toHaveValue("typed right before switching");
  } finally {
    await harness.close();
  }
});

// Issue #228: picking a model or thinking level from the composer footer must keep the prompt
// and its attachments. Own launch: needs the seeded agent dir's model presets.
test("changing model or thinking from the composer footer keeps the typed prompt and attachments", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("model-change-draft");
  await seedAgentDir(agentDir);
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Keep my prompt");
    const composer = window.getByTestId("composer");
    const footer = window.locator(".composer__bar");
    const prompt = "Refactor the parser\nand keep the tests green";
    await pasteTinyPng(window);
    const attachment = window.locator(".composer-attachment--image");
    await expect(attachment).toHaveCount(1);
    await composer.fill(prompt);
    // Wait until the draft is saved, so the picker's state update is not masked by a pending edit.
    await expect.poll(async () => (await getDesktopState(window)).composerDraft).toBe(prompt);

    await footer.getByRole("button", { name: "openai:gpt-5" }).click();
    await footer.getByRole("button", { name: "GPT-4o" }).click();
    await expect(footer.getByRole("button", { name: "openai:gpt-4o" })).toBeVisible();
    await expect(window.getByTestId("transcript")).toContainText("Model set to openai:gpt-4o");
    await expect(composer).toHaveValue(prompt);
    await expect(attachment).toHaveCount(1);

    const thinkingBadge = footer.locator(".model-selector__badge").nth(1);
    // 70166ce 起 thinking 档位经词典显示为首字母大写（High/Low），spec 原写死 toLowerCase 未跟上。
    const initialThinking = (await thinkingBadge.textContent())?.trim();
    const nextThinking = initialThinking?.toLowerCase() === "high" ? "Low" : "High";
    await thinkingBadge.click();
    await footer.getByRole("button", { name: new RegExp(`^${nextThinking}`) }).click();
    await expect(thinkingBadge).toHaveText(nextThinking);
    await expect(composer).toHaveValue(prompt);
    await expect(attachment).toHaveCount(1);
    await expect.poll(async () => (await getDesktopState(window)).composerDraft).toBe(prompt);

    // Picking from the /model menu consumes only the command text; the saved "/model" must not
    // return, and the attachment stays.
    await composer.fill("/model");
    await expect.poll(async () => (await getDesktopState(window)).composerDraft).toBe("/model");
    const optionsMenu = window.getByTestId("slash-options-menu");
    await optionsMenu.getByRole("button", { name: /GPT-5/ }).first().click();
    await expect(window.getByTestId("transcript")).toContainText("Model set to openai:gpt-5");
    // The cleared draft is saved before the model changes, not after the typing debounce.
    expect((await getDesktopState(window)).composerDraft).toBe("");
    await expect(footer.getByRole("button", { name: "openai:gpt-5" })).toBeVisible();
    await expect(composer).toHaveValue("");
    await expect.poll(async () => (await getDesktopState(window)).composerDraft).toBe("");
    await expect(composer).toHaveValue("");
    await expect(attachment).toHaveCount(1);
  } finally {
    await harness.close();
  }
});
