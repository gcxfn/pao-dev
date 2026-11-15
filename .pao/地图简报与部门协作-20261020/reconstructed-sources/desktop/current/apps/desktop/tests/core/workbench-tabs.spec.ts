import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  commitAllInGitRepo,
  desktopShortcut,
  getDesktopState,
  initGitRepo,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  seedNamedTextSessionFixture,
  selectSession,
  selectSidePanel,
  waitForTimelineLayout,
  type DesktopHarness,
} from "../helpers/electron-app";
import {
  echoCommand,
  echoEnvCommand,
  printCwdCommand,
  setEnvCommand,
  shellCommands,
} from "../helpers/terminal-shell";

const TASK_A = "Workbench task A";
const TASK_B = "Workbench task B";
type ToolName = "Files" | "Review" | "Terminal";
const toggleWorkbench = (window: Page) => window.keyboard.press(desktopShortcut("Alt+B"));

// Real Pi history is fixture setup. All workspace, task, tab, and draft changes
// below use the visible app, with no provider requests or injected runtime events.
async function prepareWorkspace() {
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("workbench-tabs");
  await writeFile(join(workspacePath, "alpha.txt"), "Alpha document\nAlpha target line\n");
  await writeFile(join(workspacePath, "beta.txt"), "Beta document\nBeta target line\n");
  await initGitRepo(workspacePath);
  await commitAllInGitRepo(workspacePath, "Workbench fixture");
  await writeFile(
    join(workspacePath, "alpha.txt"),
    "Alpha document\nAlpha target line\nUncommitted workspace edit\n",
  );
  await seedAgentDir(agentDir, { withOpenAiAuth: false });
  for (const [title, file] of [
    [TASK_A, "alpha.txt"],
    [TASK_B, "beta.txt"],
  ] as const) {
    await seedNamedTextSessionFixture(agentDir, workspacePath, {
      title,
      userText: `Inspect ${file}`,
      assistantText: `Open ${file}:2 for the result.`,
    });
  }
  return { userDataDir, agentDir, workspacePath };
}

async function expectActiveTool(window: Page, name: ToolName): Promise<void> {
  await expect(window.getByTestId("workbench")).toBeVisible();
  await expect(
    window.getByRole("tablist", { name: "Workspace tools" }).getByRole("tab", {
      name,
      exact: true,
    }),
  ).toHaveAttribute("aria-selected", "true");
}

/** Tasks without a saved layout start with the workbench hidden. */
async function openWorkbench(window: Page): Promise<void> {
  const workbench = window.getByTestId("workbench");
  if (!(await workbench.isVisible())) await toggleWorkbench(window);
  await expect(workbench).toBeVisible();
}

async function addTool(window: Page, name: ToolName): Promise<void> {
  await openWorkbench(window);
  await window.getByTestId("workbench-add-tab").click();
  const chooser = window.getByTestId("workbench-chooser");
  await expect(chooser).toBeVisible();
  await chooser.getByRole("button", { name, exact: true }).click();
  await expectActiveTool(window, name);
}

async function openSecondWindow(harness: DesktopHarness): Promise<Page> {
  const existing = new Set(harness.electronApp.windows());
  // The app's native New Window shortcut is handled in before-input-event.
  await harness.electronApp.evaluate(
    ({ BrowserWindow }, modifier) => {
      BrowserWindow.getAllWindows()[0]?.webContents.sendInputEvent({
        type: "keyDown",
        keyCode: "n",
        modifiers: [modifier, "shift"],
      });
    },
    process.platform === "darwin" ? "meta" : "control",
  );
  await expect.poll(() => harness.electronApp.windows().length).toBe(existing.size + 1);
  const opened = harness.electronApp.windows().find((candidate) => !existing.has(candidate));
  if (!opened) throw new Error("Expected New Window to create a second desktop window");
  await opened.waitForLoadState("domcontentloaded");
  return opened;
}

async function captureToolWidths(
  harness: DesktopHarness,
  window: Page,
  testInfo: TestInfo,
  tool: ToolName,
): Promise<void> {
  for (const width of [1280, 1040]) {
    await harness.electronApp.evaluate(({ BrowserWindow }, nextWidth) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(nextWidth, 900);
    }, width);
    // Windows 下 setContentSize 落到内容区会有 ±1 的取整误差（同类差异见 sidebar-toggle.spec.ts
    // 的窗口尺寸注释），这里只关心窗口确实切换到了该宽度档，不比对到 1px。
    await expect
      .poll(async () => {
        const innerWidth = await window.evaluate(() => globalThis.window.innerWidth);
        return Math.abs(innerWidth - width);
      })
      .toBeLessThanOrEqual(1);
    await expectActiveTool(window, tool);
    await expect(window.getByTestId("composer")).toBeVisible();
    const expand = window.getByTestId("task-status-expand");
    if (await expand.isVisible().catch(() => false)) {
      await expand.click();
    }
    await expect(window.getByTestId("task-status")).toBeVisible();
    const statusBox = (await window.getByTestId("task-status").boundingBox())!;
    const toolBox = (await window.getByTestId("workbench").boundingBox())!;
    expect(statusBox.x + statusBox.width).toBeLessThanOrEqual(toolBox.x + 1);
    const path = testInfo.outputPath(`${tool.toLowerCase()}-${width}.png`);
    await window.screenshot({ path, animations: "disabled" });
    await testInfo.attach(`${tool} at ${width}px`, { path, contentType: "image/png" });
  }
}

test("adds singleton tool tabs, closes to a neighbor, and keeps an empty chooser", async ({}, testInfo) => {
  test.setTimeout(60_000);
  const fixture = await prepareWorkspace();
  const harness = await launchDesktop(fixture.userDataDir, {
    agentDir: fixture.agentDir,
    initialWorkspaces: [fixture.workspacePath],
    testMode: "background",
    envOverrides: { SHELL: process.env.ComSpec },
  });
  try {
    const window = await harness.firstWindow();
    await selectSession(window, TASK_A);
    await expect(window.getByTestId("workbench")).toBeHidden();
    await openWorkbench(window);
    await expectActiveTool(window, "Review");
    await addTool(window, "Files");
    await expect(window.getByTestId("file-workbench")).toBeVisible();
    await window.locator('.file-workbench__tree-row--file[data-file-path="alpha.txt"]').click();
    await expect(window.getByTestId("file-workbench-preview")).toContainText("Alpha target line");
    await captureToolWidths(harness, window, testInfo, "Files");
    await addTool(window, "Terminal");
    const terminal = window.getByTestId("integrated-terminal");
    await expect(terminal).toBeVisible();
    await terminal.locator(".xterm").click();
    // shellCommands 生成 cmd 语法；显式选择 ComSpec，避免 Windows 默认 PowerShell 拒绝 `&`。
    await window.keyboard.type(shellCommands([echoCommand("WORKBENCH_READY"), printCwdCommand()]));
    await window.keyboard.press("Enter");
    await expect(terminal.locator(".xterm-rows")).toContainText("WORKBENCH_READY");
    await captureToolWidths(harness, window, testInfo, "Terminal");
    await addTool(window, "Review");
    await expect(window.locator(".diff-panel")).toBeVisible();
    await window
      .locator('.diff-panel__file[data-file-path="alpha.txt"] .diff-panel__file-name')
      .click();
    await expect(
      window.getByRole("region", { name: "Diff", exact: true }).locator(".diff-inline"),
    ).toContainText("Uncommitted workspace edit");
    await captureToolWidths(harness, window, testInfo, "Review");
    await expect(
      window.getByRole("tablist", { name: "Workspace tools" }).getByRole("tab"),
    ).toHaveText(["Review", "Files", "Terminal"]);
    await addTool(window, "Terminal");
    await expect(
      window.getByRole("tablist", { name: "Workspace tools" }).getByRole("tab"),
    ).toHaveCount(3);

    await window.getByRole("button", { name: "Close Terminal tab", exact: true }).click();
    await expectActiveTool(window, "Files");
    await window.getByRole("button", { name: "Close Files tab", exact: true }).click();
    await expectActiveTool(window, "Review");
    await window.getByRole("button", { name: "Close Review tab", exact: true }).click();
    await expect(window.getByTestId("workbench-chooser")).toBeVisible();
    await expect(
      window.getByRole("tablist", { name: "Workspace tools" }).getByRole("tab"),
    ).toHaveCount(0);
    await window
      .getByTestId("workbench-chooser")
      .getByRole("button", {
        name: "Files",
        exact: true,
      })
      .click();
    await toggleWorkbench(window);
    await expect(window.getByTestId("workbench")).toBeHidden();
    await toggleWorkbench(window);
    await expectActiveTool(window, "Files");
    await expect(window.getByTestId("file-workbench")).toBeVisible();
  } finally {
    await harness.close();
  }
});

test("restores each task's tabs and draft through Settings, switching, and restart", async () => {
  test.setTimeout(90_000);
  const fixture = await prepareWorkspace();
  const options = {
    agentDir: fixture.agentDir,
    initialWorkspaces: [fixture.workspacePath],
    testMode: "background" as const,
  };
  let harness = await launchDesktop(fixture.userDataDir, options);
  try {
    let window = await harness.firstWindow();
    await selectSession(window, TASK_A);
    await addTool(window, "Files");
    await window.locator('.file-workbench__tree-row--file[data-file-path="alpha.txt"]').click();
    await expect(window.getByTestId("file-workbench-preview")).toContainText("Alpha target line");
    await window.getByTestId("composer").fill("Draft for task A");

    await selectSession(window, TASK_B);
    await expect(window.getByTestId("workbench")).toBeHidden();
    await openWorkbench(window);
    await expectActiveTool(window, "Review");
    await expect(window.getByRole("tab", { name: "Files", exact: true })).toHaveCount(0);
    await addTool(window, "Terminal");
    await window.getByTestId("composer").fill("Draft for task B");
    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "Back to app", exact: true }).click();
    await expectActiveTool(window, "Terminal");
    await expect(window.getByTestId("composer")).toHaveValue("Draft for task B");
    await window.getByTestId("composer").click();
    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("settings-surface")).toHaveCount(0);
    await expectActiveTool(window, "Terminal");

    await selectSession(window, TASK_A);
    await expectActiveTool(window, "Files");
    await expect(window.getByTestId("composer")).toHaveValue("Draft for task A");
    await expect(window.getByTestId("file-workbench-preview")).toContainText("Alpha target line");
    await toggleWorkbench(window);
    await selectSession(window, TASK_B);
    await expectActiveTool(window, "Terminal");
    await selectSession(window, TASK_A);
    await expect(window.getByTestId("workbench")).toBeHidden();

    await harness.close();
    harness = await launchDesktop(fixture.userDataDir, options);
    window = await harness.firstWindow();
    await selectSession(window, TASK_A);
    await expect(window.getByTestId("workbench")).toBeHidden();
    await expect(window.getByTestId("composer")).toHaveValue("Draft for task A");
    await toggleWorkbench(window);
    await expectActiveTool(window, "Files");
    await expect(window.getByTestId("file-workbench-preview")).toContainText("Alpha target line");
    await selectSession(window, TASK_B);
    await expectActiveTool(window, "Terminal");
    await expect(window.getByTestId("composer")).toHaveValue("Draft for task B");
  } finally {
    await harness.close();
  }
});

test("an invalid or orphaned task layout does not block other saved UI state", async () => {
  test.setTimeout(90_000);
  const fixture = await prepareWorkspace();
  const options = {
    agentDir: fixture.agentDir,
    initialWorkspaces: [fixture.workspacePath],
    testMode: "background" as const,
  };
  const uiStatePath = join(fixture.userDataDir, "ui-state.json");
  const savedLayouts = async () =>
    (
      JSON.parse(await readFile(uiStatePath, "utf8")) as {
        taskWorkbenchTemplatesBySession?: Record<string, unknown>;
      }
    ).taskWorkbenchTemplatesBySession ?? {};
  let harness = await launchDesktop(fixture.userDataDir, options);
  let layoutA = "";
  let layoutB = "";
  try {
    const window = await harness.firstWindow();
    await selectSession(window, TASK_A);
    await addTool(window, "Files");
    await selectSession(window, TASK_B);
    await addTool(window, "Terminal");
    await window.getByTestId("composer").fill("Draft for task B");
    await expect.poll(async () => Object.keys(await savedLayouts()).length).toBe(2);
    await expect.poll(() => readFile(uiStatePath, "utf8")).toContain("Draft for task B");
    const state = await getDesktopState(window);
    layoutB = `${state.selectedWorkspaceId}:${state.selectedSessionId}`;
    layoutA = Object.keys(await savedLayouts()).find((key) => key !== layoutB) ?? "";
  } finally {
    await harness.close();
  }

  const saved = JSON.parse(await readFile(uiStatePath, "utf8")) as Record<string, unknown> & {
    taskWorkbenchTemplatesBySession: Record<string, Record<string, unknown>>;
  };
  const layouts = saved.taskWorkbenchTemplatesBySession;
  layouts["missing-workspace:deleted-task"] = layouts[layoutB]!;
  layouts[layoutA] = { ...layouts[layoutA], visibility: "expanded" };
  // A layout saved while the removed Worktrees tool was open still restores its other tabs.
  const toolsB = layouts[layoutB]!.tools as unknown[];
  layouts[layoutB] = { ...layouts[layoutB], tools: [...toolsB, { kind: "worktrees" }] };
  await writeFile(uiStatePath, JSON.stringify(saved));

  harness = await launchDesktop(fixture.userDataDir, options);
  try {
    const window = await harness.firstWindow();
    await selectSession(window, TASK_B);
    await expectActiveTool(window, "Terminal");
    await expect(
      window.getByRole("tablist", { name: "Workspace tools" }).getByRole("tab"),
    ).toHaveText(["Review", "Terminal"]);
    await expect(window.getByTestId("composer")).toHaveValue("Draft for task B");
    await expect.poll(async () => Object.keys(await savedLayouts())).toEqual([layoutB]);
    await selectSession(window, TASK_A);
    await addTool(window, "Terminal");
    await expect
      .poll(async () => Object.keys(await savedLayouts()).sort())
      .toEqual([layoutA, layoutB].sort());
  } finally {
    await harness.close();
  }
});

test("assistant file links keep the opened document with their originating task", async () => {
  const fixture = await prepareWorkspace();
  const harness = await launchDesktop(fixture.userDataDir, {
    agentDir: fixture.agentDir,
    initialWorkspaces: [fixture.workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await selectSession(window, TASK_A);
    await toggleWorkbench(window);
    await waitForTimelineLayout(window);
    await window.getByTestId("workspace-file-link").filter({ hasText: "alpha.txt:2" }).click();
    await expectActiveTool(window, "Files");
    await expect(window.getByTestId("file-line-mark")).toContainText("Alpha target line");
    await selectSession(window, TASK_B);
    await waitForTimelineLayout(window);
    await window.getByTestId("workspace-file-link").filter({ hasText: "beta.txt:2" }).click();
    await expectActiveTool(window, "Files");
    await expect(window.getByTestId("file-line-mark")).toContainText("Beta target line");
    await expect(window.getByTestId("file-workbench-tab")).toHaveCount(1);
    await expect(window.getByTestId("file-workbench-tab")).toContainText("beta.txt");
    await selectSession(window, TASK_A);
    await expectActiveTool(window, "Files");
    await expect(window.getByTestId("file-workbench-tab")).toHaveCount(1);
    await expect(window.getByTestId("file-workbench-tab")).toContainText("alpha.txt");
    await expect(window.getByTestId("file-line-mark")).toContainText("Alpha target line");
  } finally {
    await harness.close();
  }
});

test("closing the Terminal view preserves its live shell", async () => {
  test.setTimeout(60_000);
  const fixture = await prepareWorkspace();
  const harness = await launchDesktop(fixture.userDataDir, {
    agentDir: fixture.agentDir,
    initialWorkspaces: [fixture.workspacePath],
    testMode: "background",
    // 此用例生成 cmd 语法；显式选择 ComSpec，避免 Windows 默认 PowerShell 把 `&` 当非法管道。
    envOverrides: { SHELL: process.env.ComSpec },
  });
  try {
    const window = await harness.firstWindow();
    await selectSession(window, TASK_A);
    await addTool(window, "Terminal");
    const terminal = window.getByTestId("integrated-terminal");
    await terminal.locator(".xterm").click();
    await window.keyboard.type(
      shellCommands([
        setEnvCommand("PI_GUI_WORKBENCH_CANARY", "retained"),
        echoCommand("SHELL_READY"),
      ]),
    );
    await window.keyboard.press("Enter");
    await expect(terminal.locator(".xterm-rows")).toContainText("SHELL_READY");
    await window.getByRole("button", { name: "Close Terminal tab", exact: true }).click();
    await expect(terminal).toHaveCount(0);
    await expectActiveTool(window, "Review");
    await addTool(window, "Terminal");
    await terminal.locator(".xterm").click();
    // 读回变量要单独一行：cmd 在同一行里解析时就展开了 %VAR%，那时还没执行 set。
    await window.keyboard.type(echoEnvCommand("SHELL_", "PI_GUI_WORKBENCH_CANARY"));
    await window.keyboard.press("Enter");
    await expect(terminal.locator(".xterm-rows")).toContainText("SHELL_retained");
    await expect(window.getByTestId("terminal-tab")).toHaveCount(1);
  } finally {
    await harness.close();
  }
});

test("hiding the workbench keeps the mounted terminal and its output until reopened", async () => {
  test.setTimeout(60_000);
  const fixture = await prepareWorkspace();
  const harness = await launchDesktop(fixture.userDataDir, {
    agentDir: fixture.agentDir,
    initialWorkspaces: [fixture.workspacePath],
    testMode: "background",
    // PowerShell 的 PSReadLine 会把快速键入的大写序列转成编辑命令，
    // 使用系统 cmd.exe 才能直接验证“键入、隐藏、恢复后输出仍在”。
    envOverrides: { SHELL: process.env.ComSpec },
  });
  try {
    const window = await harness.firstWindow();
    await selectSession(window, TASK_A);
    await addTool(window, "Terminal");
    const terminal = window.getByTestId("integrated-terminal");
    await terminal.locator(".xterm").click();
    await window.keyboard.type(shellCommands([setEnvCommand("PI_GUI_MOUNTED_CANARY", "retained")]));
    await window.keyboard.press("Enter");
    await window.keyboard.type(echoEnvCommand("MOUNTED_", "PI_GUI_MOUNTED_CANARY"));
    await window.keyboard.press("Enter");
    await expect(terminal.locator(".xterm-rows")).toContainText("MOUNTED_retained");
    const host = window.locator(".task-status-workbench-host");
    await expect(host).toBeVisible();
    await toggleWorkbench(window);
    await expect(host).toBeHidden();
    await expect(terminal).toHaveCount(1);
    await expect(terminal.locator(".xterm-rows")).toContainText("MOUNTED_retained");
    await toggleWorkbench(window);
    await expect(host).toBeVisible();
    await expect(terminal).toHaveCount(1);
    await expect(terminal.locator(".xterm-rows")).toContainText("MOUNTED_retained");
  } finally {
    await harness.close();
  }
});

test("two windows keep independent live tool selections for the same task", async () => {
  test.setTimeout(60_000);
  const fixture = await prepareWorkspace();
  const harness = await launchDesktop(fixture.userDataDir, {
    agentDir: fixture.agentDir,
    initialWorkspaces: [fixture.workspacePath],
    testMode: "background",
  });
  try {
    const first = await harness.firstWindow();
    await selectSession(first, TASK_A);
    await addTool(first, "Files");
    const second = await openSecondWindow(harness);
    await selectSession(second, TASK_A);
    await expectActiveTool(second, "Files");
    await addTool(second, "Terminal");
    await expectActiveTool(first, "Files");
    await expect(first.getByRole("tab", { name: "Terminal", exact: true })).toHaveCount(0);
    await selectSidePanel(first, "Review");
    await expectActiveTool(second, "Terminal");
    await first.keyboard.press(desktopShortcut("Alt+B"));
    await expect(first.getByTestId("workbench")).toBeHidden();
    await expectActiveTool(second, "Terminal");
  } finally {
    await harness.close();
  }
});

test("wide workbench width controls announce and apply the CSS maximum", async () => {
  test.setTimeout(60_000);
  const fixture = await prepareWorkspace();
  const harness = await launchDesktop(fixture.userDataDir, {
    agentDir: fixture.agentDir,
    initialWorkspaces: [fixture.workspacePath],
    testMode: "background",
  });
  try {
    await harness.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
    });
    const window = await harness.firstWindow();
    await selectSession(window, TASK_A);
    await openWorkbench(window);
    const panelWidth = async () =>
      Math.round((await window.getByTestId("workbench").boundingBox())!.width);
    await expect.poll(panelWidth).toBe(360);
    const mainWidth = await window.locator(".main").evaluate((element) => element.clientWidth);
    const expectedMax = Math.floor(mainWidth * 0.55);
    expect(expectedMax).toBeLessThan(Math.floor(mainWidth * 0.65));
    const handle = window.getByRole("separator", { name: "Side panel width" });
    await expect(handle).toHaveAttribute("aria-valuemax", String(expectedMax));

    await handle.focus();
    await handle.press("End");
    await expect.poll(panelWidth).toBe(expectedMax);
    await expect(handle).toHaveAttribute("aria-valuenow", String(expectedMax));

    await handle.press("Home");
    await expect.poll(panelWidth).toBe(320);
    const start = (await handle.boundingBox())!;
    await window.mouse.move(start.x + 3, start.y + 160);
    await window.mouse.down();
    await window.mouse.move(start.x - mainWidth, start.y + 160, { steps: 10 });
    await window.mouse.up();
    await expect.poll(panelWidth).toBe(expectedMax);
    await expect(handle).toHaveAttribute("aria-valuenow", String(expectedMax));
  } finally {
    await harness.close();
  }
});

test("compact status keeps the work surface full width beside open tools", async () => {
  test.setTimeout(60_000);
  const fixture = await prepareWorkspace();
  const harness = await launchDesktop(fixture.userDataDir, {
    agentDir: fixture.agentDir,
    initialWorkspaces: [fixture.workspacePath],
    testMode: "background",
  });
  try {
    await harness.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
    });
    const window = await harness.firstWindow();
    await selectSession(window, TASK_A);
    await openWorkbench(window);
    await expect(window.getByTestId("task-status")).toBeVisible();
    await window.getByTestId("task-status-collapse").click();

    const shortbar = window.getByTestId("task-status-expand");
    const tools = window.locator(".task-status-workbench-host");
    const main = window.locator(".main");
    await expect(shortbar).toBeVisible();
    await expect(tools).toBeVisible();
    await expect
      .poll(() =>
        main.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length),
      )
      .toBe(2);
    const shortbarBox = (await shortbar.boundingBox())!;
    const toolsBox = (await tools.boundingBox())!;
    expect(shortbarBox.x + shortbarBox.width).toBeLessThanOrEqual(toolsBox.x + 1);
    expect(shortbarBox.x).toBeGreaterThanOrEqual((await main.boundingBox())!.x + 8);
    const transcriptBox = (await window.getByTestId("timeline-pane").boundingBox())!;
    expect(transcriptBox.y).toBeGreaterThanOrEqual(shortbarBox.y + shortbarBox.height);

    const composer = (await window.locator(".composer").boundingBox())!;
    const laneGap = await main.evaluate((element) =>
      getComputedStyle(element).columnGap === "normal"
        ? 0
        : Number.parseFloat(getComputedStyle(element).columnGap),
    );
    expect(composer.x + composer.width).toBeCloseTo(toolsBox.x - laneGap, 0);

    await toggleWorkbench(window);
    await expect(tools).toBeHidden();
    await expect(shortbar).toBeVisible();
    const closedShortbar = (await shortbar.boundingBox())!;
    const closedTranscript = (await window.getByTestId("timeline-pane").boundingBox())!;
    expect(closedTranscript.y).toBeGreaterThanOrEqual(closedShortbar.y + closedShortbar.height);
  } finally {
    await harness.close();
  }
});

test("keeps one resizable width across tools, chooser, tasks, and restart", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const fixture = await prepareWorkspace();
  const options = {
    agentDir: fixture.agentDir,
    initialWorkspaces: [fixture.workspacePath],
    testMode: "background" as const,
  };
  let harness = await launchDesktop(fixture.userDataDir, options);
  const setWindowWidth = async (width: number) => {
    await harness.electronApp.evaluate(({ BrowserWindow }, nextWidth) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(nextWidth, 900);
    }, width);
  };
  try {
    await setWindowWidth(1440);
    let window = await harness.firstWindow();
    await selectSession(window, TASK_A);
    await openWorkbench(window);
    const panelWidth = async () =>
      Math.round((await window.getByTestId("workbench").boundingBox())!.width);
    await expect.poll(panelWidth).toBe(360);
    const handle = window.getByRole("separator", { name: "Side panel width" });
    const start = (await handle.boundingBox())!;
    await window.mouse.move(start.x + 3, start.y + 160);
    await window.mouse.down();
    await window.mouse.move(start.x - 97, start.y + 160, { steps: 10 });
    await window.mouse.up();
    await expect.poll(panelWidth).toBe(460);
    for (const tool of ["Files", "Review", "Terminal"] as const) {
      await window.getByTestId("workbench-add-tab").click();
      await expect.poll(panelWidth).toBe(460);
      await window
        .getByTestId("workbench-chooser")
        .getByRole("button", { name: tool, exact: true })
        .click();
      await expectActiveTool(window, tool);
      await expect.poll(panelWidth).toBe(460);
    }
    const add = (await window.getByTestId("workbench-add-tab").boundingBox())!;
    const title = (await window.locator(".chat-header__title").boundingBox())!;
    const topbar = (await window.getByTestId("topbar").boundingBox())!;
    // R01/R03：概况与工具已分区，工具加号应在顶栏右侧且不与标题相交，不再要求纵向排到标题下方。
    expect(title.y).toBeLessThan(48);
    expect(add.x).toBeGreaterThan(title.x + title.width);
    expect(add.y).toBeGreaterThanOrEqual(topbar.y);
    expect(add.y + add.height).toBeLessThanOrEqual(topbar.y + topbar.height + 1);
    expect(add.x).toBeGreaterThanOrEqual(topbar.x + topbar.width / 2);
    await expect(window.getByTestId("topbar").getByRole("heading", { name: TASK_A })).toBeVisible();
    await window.getByTestId("thread-header-menu").click();
    await expect(window.locator('[data-thread-action="scheduled-task"]')).toBeVisible();
    await window.getByTestId("thread-header-menu").click();
    await toggleWorkbench(window);
    await expect(window.getByTestId("workbench")).toBeHidden();
    await toggleWorkbench(window);
    await expect.poll(panelWidth).toBe(460);
    await selectSession(window, TASK_B);
    await openWorkbench(window);
    await expect.poll(panelWidth).toBe(460);
    await handle.focus();
    await handle.press("ArrowRight");
    await expect.poll(panelWidth).toBe(440);
    await window.screenshot({ path: testInfo.outputPath("compact-resizable-workspace.png") });
    await setWindowWidth(1040);
    await expect.poll(panelWidth).toBeLessThanOrEqual(440);
    await expect(window.getByTestId("composer")).toBeVisible();
    await setWindowWidth(900);
    await expect.poll(panelWidth).toBeLessThanOrEqual(440);
    await handle.focus();
    await handle.press("Home");
    await expect.poll(panelWidth).toBe(320);
    await selectSession(window, TASK_A);
    await addTool(window, "Terminal");
    const activeTab = (await window
      .getByRole("tab", { name: "Terminal", exact: true })
      .boundingBox())!;
    const strip = (await window.getByRole("tablist", { name: "Workspace tools" }).boundingBox())!;
    expect(activeTab.x).toBeGreaterThanOrEqual(strip.x);
    expect(activeTab.x + activeTab.width).toBeLessThanOrEqual(strip.x + strip.width + 1);
    await window.getByTestId("workbench-add-tab").click();
    await expect.poll(panelWidth).toBeLessThanOrEqual(320);
    await window.screenshot({ path: testInfo.outputPath("narrow-workspace-chooser.png") });
    // 窄窗把坞的上限压在 320px，键盘微调在这种窗口里会被上限吃掉；宽度偏好回到宽窗再验。
    await setWindowWidth(1440);
    await expect.poll(panelWidth).toBe(320);
    await handle.focus();
    await handle.press("ArrowLeft");
    await expect.poll(panelWidth).toBe(340);
    await window.getByTestId("workbench-add-tab").click();
    await expect.poll(panelWidth).toBe(340);
    // Wait for the debounced preference write before exercising a fresh process.
    await expect
      .poll(() => window.evaluate(() => localStorage.getItem("pi-gui.workbench-width")))
      .toBe("340");
    await harness.close();
    harness = await launchDesktop(fixture.userDataDir, options);
    window = await harness.firstWindow();
    await selectSession(window, TASK_A);
    await expect.poll(panelWidth).toBe(340);
  } finally {
    await harness.close();
  }
});

test("shows and selects GPT-6 Sol from the upgraded Pi model catalog", async ({}, testInfo) => {
  const fixture = await prepareWorkspace();
  // Synthetic credentials enable the provider catalog; this test never sends a request.
  await seedAgentDir(fixture.agentDir, {
    enabledModels: ["openai/gpt-6-sol", "openai/gpt-6-luna"],
  });
  const harness = await launchDesktop(fixture.userDataDir, {
    agentDir: fixture.agentDir,
    initialWorkspaces: [fixture.workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await selectSession(window, TASK_A);
    const badge = window.locator(".composer__bar .model-selector__badge").first();
    await badge.click();
    const dropdown = window.locator(".composer__bar .model-selector__dropdown").first();
    await expect(dropdown).toContainText("GPT-6 Sol");
    await expect(dropdown).toContainText("GPT-6 Luna");
    await dropdown.getByRole("button", { name: /GPT-6 Sol/ }).click();
    await expect(badge).toHaveText("openai:gpt-6-sol");
    await expect(
      window.locator(".composer").getByRole("button", { name: "Medium", exact: true }),
    ).toBeVisible();
    await window.screenshot({ path: testInfo.outputPath("gpt-6-sol-selected.png") });
  } finally {
    await harness.close();
  }
});

test("saved wide tool width uses its real CSS width when deciding overview space", async () => {
  test.setTimeout(90_000);
  const fixture = await prepareWorkspace();
  const options = {
    agentDir: fixture.agentDir,
    initialWorkspaces: [fixture.workspacePath],
    testMode: "background" as const,
  };
  let harness = await launchDesktop(fixture.userDataDir, options);
  const setWindowWidth = async (width: number) => {
    const window = await harness.firstWindow();
    await window.setViewportSize({ width, height: 900 });
    await expect.poll(() => window.evaluate(() => globalThis.innerWidth)).toBe(width);
  };
  try {
    let window = await harness.firstWindow();
    await window.setViewportSize({ width: 2600, height: 900 });
    await expect.poll(() => window.evaluate(() => globalThis.innerWidth)).toBe(2600);
    await selectSession(window, TASK_A);
    await openWorkbench(window);
    const handle = window.getByRole("separator", { name: "Side panel width" });
    const enoughSpace = await window.locator(".main").evaluate((main) => ({
      mainWidth: main.clientWidth,
      handleMax: Math.min(1200, Math.floor(main.clientWidth * 0.55)),
    }));
    expect(enoughSpace.handleMax).toBeGreaterThanOrEqual(1200);
    await expect(handle).toHaveAttribute("aria-valuemax", String(enoughSpace.handleMax));
    await handle.focus();
    await handle.press("End");
    await expect
      .poll(() => window.evaluate(() => localStorage.getItem("pi-gui.workbench-width")))
      .toBe("1200");

    await harness.close();
    harness = await launchDesktop(fixture.userDataDir, options);
    window = await harness.firstWindow();
    await selectSession(window, TASK_A);
    await openWorkbench(window);
    await setWindowWidth(1900);
    await expect(window.getByTestId("task-status")).toBeVisible();
    await expect.poll(() => window.getByTestId("task-status").isVisible()).toBe(true);
    await expect(window.getByTestId("task-status-expand")).toHaveCount(0);
    const remaining = await window.evaluate(() => {
      const main = document.querySelector<HTMLElement>(".main")!;
      const tools = document.querySelector<HTMLElement>(".task-status-workbench-host")!;
      return main.clientWidth - tools.clientWidth;
    });
    expect(remaining).toBeGreaterThanOrEqual(704);

    await setWindowWidth(1400);
    await expect.poll(() => window.getByTestId("task-status-expand").isVisible()).toBe(true);
    await setWindowWidth(1900);
    await expect(window.getByTestId("task-status")).toBeVisible();
    expect(await window.evaluate(() => localStorage.getItem("pi-gui.workbench-width"))).toBe(
      "1200",
    );
  } finally {
    await harness.close();
  }
});
