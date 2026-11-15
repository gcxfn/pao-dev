import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  desktopShortcut,
  getDesktopState,
  getSelectedTranscript,
  getTimelineScrollMetrics,
  jumpTimelineToBottom,
  launchPackagedDesktop,
  makeGitWorkspace,
  makeUserDataDir,
  reloadDesktopRenderer,
  resolvePackagedAppExecutable,
  selectSession,
  settledTimelineScrollMetrics,
  waitForSelectedSessionReady,
  waitForTimelineLayout,
  waitForWorkspaceByPath,
  writeTextFile,
  type DesktopHarness,
} from "../helpers/electron-app";
import { appendMessagesToSessionFile, sessionFilePathFromCatalog } from "../helpers/session-file";
import { echoCommand } from "../helpers/terminal-shell";

const DEFAULT_RELEASE_DIR = "D:/AI/workspace/临时文件夹/悬浮框验收-20261019/packaged";
const DEVELOPMENT_ROOT = resolve(__dirname, "../../../../..");
const DEFAULT_EVIDENCE_ROOT = join(
  DEVELOPMENT_ROOT,
  ".pao/harness完善-20261017/悬浮框与独立侧栏-20261019/发行布局截图",
);
const SESSION_TITLE = "发行布局验收";
const NARROW_SESSION_TITLE = "发行窄窗布局验收";

interface Geometry {
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly documentClientWidth: number;
  readonly documentScrollWidth: number;
  readonly main: Box | null;
  readonly mainColumnCount: number | null;
  readonly mainGridColumnGap: number | null;
  readonly space6: number | null;
  readonly topbar: Box | null;
  readonly status: Box | null;
  readonly shortbar: Box | null;
  readonly toolsHost: Box | null;
  readonly workbench: Box | null;
  readonly composer: Box | null;
  readonly composerPaddingInline: {
    readonly start: number;
    readonly end: number;
  } | null;
  readonly composerSurface: Box | null;
  readonly transcript: Box | null;
  readonly transcriptScrollTop: number | null;
  readonly transcriptScrollHeight: number | null;
  readonly transcriptClientHeight: number | null;
  readonly messageActions: Box[];
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly right: number;
  readonly bottom: number;
}

interface EvidenceRun {
  readonly dir: string;
  writeGeometry(label: string, geometry: Geometry): Promise<void>;
  shoot(window: Page, fileName: string): Promise<void>;
}

function configuredReleaseDir(): string {
  return resolve(process.env.PI_APP_TEST_RELEASE_DIR?.trim() || DEFAULT_RELEASE_DIR);
}

function configuredEvidenceDir(): string {
  return resolve(process.env.PI_APP_FLOATING_STATUS_EVIDENCE_DIR?.trim() || DEFAULT_EVIDENCE_ROOT);
}

async function createEvidenceRun(): Promise<EvidenceRun> {
  const runDir = join(
    configuredEvidenceDir(),
    `run-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${process.pid}-${randomUUID().slice(0, 8)}`,
  );
  await mkdir(runDir, { recursive: true });
  return {
    dir: runDir,
    async writeGeometry(label, geometry) {
      await writeFile(
        join(runDir, "geometry.jsonl"),
        `${JSON.stringify({ label, at: new Date().toISOString(), ...geometry })}\n`,
        { encoding: "utf8", flag: "a" },
      );
    },
    async shoot(window, fileName) {
      await window.screenshot({
        path: join(runDir, fileName),
        animations: "disabled",
      });
    },
  };
}

async function readGeometry(window: Page): Promise<Geometry> {
  return window.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        right: rect.right,
        bottom: rect.bottom,
      };
    };
    return {
      innerWidth: globalThis.innerWidth,
      innerHeight: globalThis.innerHeight,
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      main: box(".main"),
      mainColumnCount: getComputedStyle(document.querySelector(".main")!).gridTemplateColumns.split(
        " ",
      ).length,
      mainGridColumnGap:
        getComputedStyle(document.querySelector(".main")!).columnGap === "normal"
          ? 0
          : Number.parseFloat(getComputedStyle(document.querySelector(".main")!).columnGap),
      space6: Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--space-6"),
      ),
      topbar: box('[data-testid="topbar"]'),
      status: box('[data-testid="task-status"]'),
      shortbar: box('[data-testid="task-status-expand"]'),
      toolsHost: box(".task-status-workbench-host"),
      workbench: box('[data-testid="workbench"]'),
      composer: box(".composer"),
      composerPaddingInline: (() => {
        const composer = document.querySelector<HTMLElement>(".composer");
        if (!composer) return null;
        const style = getComputedStyle(composer);
        return {
          start: Number.parseFloat(style.paddingLeft),
          end: Number.parseFloat(style.paddingRight),
        };
      })(),
      composerSurface: box('[data-testid="composer-surface"]'),
      transcript: box('[data-testid="timeline-pane"]'),
      transcriptScrollTop:
        document.querySelector<HTMLElement>('[data-testid="timeline-pane"]')?.scrollTop ?? null,
      transcriptScrollHeight:
        document.querySelector<HTMLElement>('[data-testid="timeline-pane"]')?.scrollHeight ?? null,
      transcriptClientHeight:
        document.querySelector<HTMLElement>('[data-testid="timeline-pane"]')?.clientHeight ?? null,
      messageActions: [...document.querySelectorAll('[data-testid="fork-from-message"]')]
        .filter((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          const transcript = document.querySelector<HTMLElement>('[data-testid="timeline-pane"]');
          const transcriptRect = transcript?.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0 &&
            Boolean(
              transcriptRect &&
              rect.bottom > transcriptRect.top &&
              rect.top < transcriptRect.bottom &&
              rect.right > transcriptRect.left &&
              rect.left < transcriptRect.right,
            )
          );
        })
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            right: rect.right,
            bottom: rect.bottom,
          };
        }),
    };
  });
}

async function expectNoHorizontalOverflow(window: Page, label: string): Promise<void> {
  await expect
    .poll(async () => {
      const geometry = await readGeometry(window);
      return geometry.documentScrollWidth - geometry.documentClientWidth;
    })
    .toBeLessThanOrEqual(0);
  const geometry = await readGeometry(window);
  expect(
    geometry.documentScrollWidth - geometry.innerWidth,
    `${label}: 页面 scrollWidth 不应超过窗口宽度`,
  ).toBeLessThanOrEqual(1);
}

async function expectShortbarClearOfChatControls(window: Page, label: string): Promise<void> {
  const transcript = window.getByTestId("timeline-pane");
  await transcript.evaluate((element) => {
    const pane = element as HTMLElement;
    pane.scrollTop = 0;
    pane.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBe(0);
  await waitForTimelineLayout(window);
  const atTop = await readGeometry(window);
  expect(atTop.transcriptScrollTop, `${label}: hover 前已滚到会话顶部`).toBe(0);
  expect(atTop.transcriptScrollHeight).toBeGreaterThan(atTop.transcriptClientHeight!);

  const firstAssistant = window
    .getByTestId("timeline-pane")
    .locator(".timeline-item--assistant")
    .first();
  await expect(firstAssistant).toBeVisible();
  await firstAssistant.hover();
  const action = firstAssistant.getByTestId("fork-from-message");
  await expect(action).toBeVisible();
  await action.focus();
  await expect(action).toBeFocused();
  await expect
    .poll(() =>
      firstAssistant
        .locator(".timeline-item__actions")
        .evaluate((element) => Number.parseFloat(getComputedStyle(element).opacity)),
    )
    .toBeGreaterThan(0.9);

  const geometry = await readGeometry(window);
  expect(geometry.transcript, `${label}: 会话滚动区应存在`).not.toBeNull();
  expect(geometry.topbar, `${label}: 顶栏应存在`).not.toBeNull();
  expect(geometry.composerSurface, `${label}: 输入区域应存在`).not.toBeNull();
  expect(geometry.shortbar, `${label}: 短条应存在`).not.toBeNull();
  expect(geometry.messageActions.length, `${label}: 消息操作按钮应可见`).toBeGreaterThan(0);
  expect(geometry.shortbar!.y, `${label}: 短条应在顶栏下方`).toBeGreaterThanOrEqual(
    geometry.topbar!.bottom - 1,
  );
  expect(geometry.main, `${label}: 主区应存在`).not.toBeNull();
  expect(geometry.shortbar!.x, `${label}: 短条不应盖住左侧导航`).toBeGreaterThanOrEqual(
    geometry.main!.x - 1,
  );
  expect(geometry.shortbar!.right, `${label}: 短条不应越过工具左界或主区右界`).toBeLessThanOrEqual(
    (geometry.toolsHost?.width ?? 0) > 0 ? geometry.toolsHost!.x + 1 : geometry.main!.right + 1,
  );
  expect(geometry.shortbar!.bottom, `${label}: 短条不应盖住输入区`).toBeLessThanOrEqual(
    geometry.composerSurface!.y + 1,
  );
  for (const actionBox of geometry.messageActions) {
    expect(
      boxesIntersect(geometry.shortbar!, actionBox),
      `${label}: 短条遮挡消息操作按钮 ${JSON.stringify(actionBox)}`,
    ).toBe(false);
  }
  await expectNoHorizontalOverflow(window, label);
  await evidenceShootCurrent(window, `${label}-短条与消息操作.png`);
  if (!currentEvidence) throw new Error("Evidence run was not initialized");
  await currentEvidence.writeGeometry(`${label}-shortbar-vs-chat-actions`, geometry);
}

let currentEvidence: EvidenceRun | undefined;

async function evidenceShootCurrent(window: Page, fileName: string): Promise<void> {
  if (!currentEvidence) throw new Error("Evidence run was not initialized");
  await currentEvidence.shoot(window, fileName);
}

async function expectPackagedIdentity(
  harness: DesktopHarness,
  releaseDir: string,
  executable: string,
  window: Page,
): Promise<void> {
  const artifact = await harness.electronApp.evaluate(({ app }) => ({
    appPath: app.getAppPath(),
    execPath: process.execPath,
    isPackaged: app.isPackaged,
    defaultApp: Boolean(process.defaultApp),
    resourcesPath: process.resourcesPath,
  }));
  expect(artifact.execPath).toBe(executable);
  expect(artifact.isPackaged).toBe(true);
  expect(artifact.defaultApp).toBe(false);
  expect(relative(releaseDir, artifact.appPath)).not.toMatch(/^\.\.(?:[/\\]|$)/);
  expect(artifact.appPath).toMatch(/[/\\]app\.asar$/);
  expect(relative(releaseDir, artifact.resourcesPath)).not.toMatch(/^\.\.(?:[/\\]|$)/);

  const url = new URL(window.url());
  expect(url.protocol).toBe("file:");
  expect(url.host).toBe("");
  const pagePath = fileURLToPath(url);
  const resourcesPath = resolve(releaseDir, "win-unpacked", "resources");
  expect(relative(resourcesPath, pagePath)).not.toMatch(/^\.\.(?:[/\\]|$)/);
}

async function openWorkbench(window: Page): Promise<void> {
  const workbench = window.getByTestId("workbench");
  if (!(await workbench.isVisible().catch(() => false))) {
    await window.getByTestId("toggle-side-panel").click();
  }
  await expect(workbench).toBeVisible();
}

async function expectToolZeroPlaceholder(window: Page): Promise<void> {
  const host = window.locator(".task-status-workbench-host");
  await expect(host).toHaveCount(1);
  await expect(host).toHaveCSS("display", "none");
  expect((await host.boundingBox())?.width ?? 0).toBe(0);
  await expect(window.locator(".main")).not.toHaveClass(/\bmain--with-side-panel\b/);
}

function boxesIntersect(first: Box, second: Box): boolean {
  return !(
    first.right <= second.x ||
    second.right <= first.x ||
    first.bottom <= second.y ||
    second.bottom <= first.y
  );
}

async function seedOfflineTranscript(
  harness: DesktopHarness,
  window: Page,
  userDataDir: string,
): Promise<DesktopHarness> {
  const state = await getDesktopState(window);
  const workspacePath = state.workspaces.find(
    (workspace) => workspace.id === state.selectedWorkspaceId,
  )?.path;
  if (!workspacePath) throw new Error("Selected workspace path was unavailable");
  const target = {
    workspaceId: state.selectedWorkspaceId,
    sessionId: state.selectedSessionId,
  };
  await waitForSelectedSessionReady(window, target);
  const siblingSessionFilePath = await sessionFilePathFromCatalog(userDataDir, target);
  const messages: Array<{
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly timestampMs: number;
  }> = [];
  const base = Date.now() - 20 * 60_000;
  for (let index = 0; index < 9; index += 1) {
    messages.push({
      role: "user",
      text: `离线布局夹具：用户消息 ${index + 1}。${"这是用于滚动布局验证的正文。".repeat(8)}`,
      timestampMs: base + index * 120_000,
    });
    messages.push({
      role: "assistant",
      text: `离线布局夹具：助手消息 ${index + 1}。${"这是用于消息操作按钮几何验证的正文。".repeat(12)}`,
      timestampMs: base + index * 120_000 + 30_000,
    });
  }
  await harness.close();

  await appendMessagesToSessionFile(siblingSessionFilePath, messages);

  const relaunched = await launchPackagedDesktop(userDataDir, {
    agentDir: join(userDataDir, "agent"),
    initialWorkspaces: [],
    testMode: "foreground",
    scrubProviderEnv: true,
    envOverrides: {
      PAO_HOME: join(userDataDir, "pao-home"),
      SHELL: process.env.ComSpec,
    },
  });
  window = await relaunched.firstWindow();
  await waitForWorkspaceByPath(window, workspacePath);
  await expect
    .poll(async () =>
      (await getDesktopState(window)).workspaces.some((workspace) =>
        workspace.sessions.some((session) => session.id === target.sessionId),
      ),
    )
    .toBe(true);
  await waitForSelectedSessionReady(window, target);
  await expect(window.getByTestId("transcript")).toContainText("离线布局夹具");
  const selected = await getSelectedTranscript(window);
  expect(selected?.transcript.some((item) => item.kind === "message")).toBe(true);
  await expect(window.getByTestId("transcript")).toContainText("助手消息 9");
  return relaunched;
}

async function closeWorkbench(window: Page): Promise<void> {
  const workbench = window.getByTestId("workbench");
  if (await workbench.isVisible().catch(() => false)) {
    await window.getByTestId("toggle-side-panel").click();
  }
  await expect(workbench).toBeHidden();
  await expectToolZeroPlaceholder(window);
}

async function addTool(window: Page, name: "Files" | "Review" | "Terminal"): Promise<void> {
  await openWorkbench(window);
  const existing = window
    .getByRole("tablist", { name: "Workspace tools" })
    .getByRole("tab", { name, exact: true });
  if (!(await existing.count())) {
    await window.getByTestId("workbench-add-tab").click();
    const chooser = window.getByTestId("workbench-chooser");
    await expect(chooser).toBeVisible();
    await chooser.getByRole("button", { name, exact: true }).click();
  } else {
    await existing.click();
  }
  await expect(existing).toHaveAttribute("aria-selected", "true");
}

async function expandIfCompact(window: Page): Promise<void> {
  const expand = window.getByTestId("task-status-expand");
  if (await expand.isVisible().catch(() => false)) {
    await expand.click();
  }
  await expect(window.getByTestId("task-status")).toBeVisible();
}

async function collapseStatus(window: Page): Promise<void> {
  const status = window.getByTestId("task-status");
  if (await status.isVisible().catch(() => false)) {
    await window.getByTestId("task-status-collapse").click();
  }
  await expect(window.getByTestId("task-status-expand")).toBeVisible();
}

async function setViewport(window: Page, width: number, height: number): Promise<void> {
  await window.setViewportSize({ width, height });
  await expect
    .poll(() => window.evaluate(() => globalThis.innerWidth))
    .toBeGreaterThanOrEqual(width - 1);
  await waitForTimelineLayout(window);
}

function assertExpandedStatusFillsOverviewColumn(geometry: Geometry, label: string): void {
  const { status, toolsHost, composer, main, space6 } = geometry;
  expect(status, `${label}: 展开概况应存在`).not.toBeNull();
  expect(toolsHost, `${label}: 工具宿主应存在`).not.toBeNull();
  expect(composer, `${label}: 输入外层应存在`).not.toBeNull();
  expect(main, `${label}: 主区应存在`).not.toBeNull();
  expect(space6, `${label}: 概况列设计间距应可读取`).toBe(24);

  const overviewColumnRight =
    toolsHost!.width > 0 ? toolsHost!.x : (main?.right ?? geometry.innerWidth);
  expect(
    status!.x - composer!.right,
    `${label}: 输入列与概况列之间应只保留现有设计间距`,
  ).toBeGreaterThanOrEqual(0);
  expect(
    status!.x - composer!.right,
    `${label}: 输入列与概况列之间不得留下大块空白`,
  ).toBeLessThanOrEqual(space6! + 1);
  expect(
    overviewColumnRight - status!.right,
    `${label}: 概况列右侧应只保留现有设计间距`,
  ).toBeGreaterThanOrEqual(0);
  expect(
    overviewColumnRight - status!.right,
    `${label}: 概况卡片应填满已预留概况列`,
  ).toBeLessThanOrEqual(space6! + 1);
}

function assertThreeColumns(geometry: Geometry, label: string): void {
  const { status, shortbar, toolsHost, composerSurface } = geometry;
  expect(status || shortbar, `${label}: 概况或短条应存在`).not.toBeNull();
  expect(toolsHost, `${label}: 工具宿主应存在`).not.toBeNull();
  expect(composerSurface, `${label}: 输入区应存在`).not.toBeNull();
  const rightOverview = status ?? shortbar!;
  expect(composerSurface!.right, `${label}: 输入区不应盖住概况`).toBeLessThanOrEqual(
    rightOverview.x + 1,
  );
  expect(rightOverview.right, `${label}: 概况不应盖住工具`).toBeLessThanOrEqual(toolsHost!.x + 1);
  if (status) assertExpandedStatusFillsOverviewColumn(geometry, label);
}

function assertCompactContentReclaimsColumn(geometry: Geometry, label: string): void {
  expect(geometry.mainColumnCount, `${label}: 工具开且短条收起时主区应为两列`).toBe(2);
  expect(geometry.composer, `${label}: 输入外层应存在`).not.toBeNull();
  expect(geometry.transcript, `${label}: 会话滚动区应存在`).not.toBeNull();
  expect(geometry.shortbar, `${label}: 短条应存在`).not.toBeNull();
  expect(geometry.toolsHost, `${label}: 工具宿主应存在`).not.toBeNull();
  expect(geometry.topbar, `${label}: 顶栏应存在`).not.toBeNull();
  expect(geometry.composerSurface, `${label}: 输入框应存在`).not.toBeNull();

  const laneGap = geometry.mainGridColumnGap ?? 0;
  const maxVisualGap = geometry.space6;
  const composerPadding = geometry.composerPaddingInline;
  expect(laneGap, `${label}: 主区网格列间距应为有限值`).toBeGreaterThanOrEqual(0);
  expect(maxVisualGap, `${label}: 24px 设计间距应可读取`).toBeGreaterThan(0);
  expect(composerPadding, `${label}: 输入区内边距应可读取`).not.toBeNull();
  expect(geometry.transcript!.right, `${label}: 会话滚动区应贴近工具左界`).toBeGreaterThanOrEqual(
    geometry.toolsHost!.x - laneGap - 1,
  );
  expect(geometry.composerSurface!.right, `${label}: 输入框应位于输入可用列内`).toBeLessThanOrEqual(
    geometry.composer!.right + 1,
  );
  expect(geometry.composer!.x, `${label}: 输入可用列应从主区左界开始`).toBeCloseTo(
    geometry.main!.x,
    0,
  );
  expect(geometry.composer!.width, `${label}: 输入外层应占据完整正文列`).toBeCloseTo(
    geometry.toolsHost!.x - laneGap - geometry.main!.x,
    0,
  );
  expect(
    geometry.composer!.right - composerPadding!.end,
    `${label}: 输入内容应贴近工具左界`,
  ).toBeGreaterThanOrEqual(geometry.toolsHost!.x - laneGap - composerPadding!.end - 1);
  expect(geometry.shortbar!.right, `${label}: 短条仍应在工具左侧`).toBeLessThanOrEqual(
    geometry.toolsHost!.x + 1,
  );
  expect(geometry.shortbar!.x, `${label}: 短条不应盖住左侧导航`).toBeGreaterThanOrEqual(
    geometry.main!.x - 1,
  );
  expect(
    geometry.toolsHost!.x - geometry.shortbar!.right,
    `${label}: 短条与工具的视觉间距应在现有 24px 设计间距内`,
  ).toBeGreaterThanOrEqual(-1);
  expect(
    geometry.toolsHost!.x - geometry.shortbar!.right,
    `${label}: 短条与工具的视觉间距应在现有 24px 设计间距内`,
  ).toBeLessThanOrEqual(maxVisualGap! + 1);
  expect(geometry.topbar!.right, `${label}: 正文顶栏应贴近工具左界`).toBeGreaterThanOrEqual(
    geometry.toolsHost!.x - laneGap - 1,
  );
}

test("发行布局：真实发行物、四开关、四宽度、矮窗与固定概况", async () => {
  test.setTimeout(180_000);
  const releaseDir = configuredReleaseDir();
  process.env.PI_APP_TEST_RELEASE_DIR = releaseDir;
  const executable = await resolvePackagedAppExecutable(releaseDir);
  const userDataDir = await makeUserDataDir("pao-floating-status-");
  const workspacePath = await makeGitWorkspace("floating-status-release");
  const agentDir = join(userDataDir, "agent");
  const paoHome = join(userDataDir, "pao-home");
  const evidence = await createEvidenceRun();
  currentEvidence = evidence;

  await mkdir(paoHome, { recursive: true });
  await writeTextFile(join(workspacePath, "README.md"), "# 发行布局验收\n\n已修改内容\n");
  await writeTextFile(join(workspacePath, "untracked.txt"), "发行验收 untracked fixture\n");

  let harness = await launchPackagedDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "foreground",
    scrubProviderEnv: true,
    envOverrides: {
      PAO_HOME: paoHome,
      SHELL: process.env.ComSpec,
    },
  });

  try {
    let window = await harness.firstWindow();
    await harness.focusWindow();
    await expectPackagedIdentity(harness, releaseDir, executable, window);
    await createNamedThread(window, SESSION_TITLE);
    harness = await seedOfflineTranscript(harness, window, userDataDir);
    window = await harness.firstWindow();
    await expectPackagedIdentity(harness, releaseDir, executable, window);
    await selectSession(window, SESSION_TITLE);
    await waitForTimelineLayout(window);
    await jumpTimelineToBottom(window);
    await settledTimelineScrollMetrics(window);
    await expect(window.getByTestId("task-status")).toBeVisible();

    await setViewport(window, 1440, 900);
    const initial = await readGeometry(window);
    await evidence.writeGeometry("1440-status-open-tools-closed", initial);
    await expect(window.getByTestId("topbar")).toBeVisible();
    expect(initial.topbar).not.toBeNull();
    expect(initial.status).not.toBeNull();
    expect(initial.composerSurface).not.toBeNull();
    expect(initial.shortbar).toBeNull();
    expect(initial.status!.width, "1440px 工具关闭时概况卡片应保持既有 360px 宽度").toBeCloseTo(
      360,
      0,
    );
    assertExpandedStatusFillsOverviewColumn(initial, "1440px 工具关闭");
    expect(initial.status!.right).toBeLessThanOrEqual(initial.documentClientWidth);
    expect(initial.status!.x).toBeGreaterThanOrEqual(initial.topbar!.right - 1);
    expect(boxesIntersect(initial.status!, initial.topbar!)).toBe(false);
    expect(boxesIntersect(initial.status!, initial.composerSurface!)).toBe(false);
    await evidence.shoot(window, "1440-卡片.png");

    await openWorkbench(window);
    await expandIfCompact(window);
    const wideOpen = await readGeometry(window);
    await evidence.writeGeometry("1440-status-open-tools-open", wideOpen);
    expect(wideOpen.status).not.toBeNull();
    expect(wideOpen.toolsHost).not.toBeNull();
    expect(wideOpen.status!.width, "1440px 工具打开时概况卡片应保持既有 360px 宽度").toBeCloseTo(
      360,
      0,
    );
    assertExpandedStatusFillsOverviewColumn(wideOpen, "1440px 工具打开");
    expect(wideOpen.status!.right).toBeLessThanOrEqual(wideOpen.toolsHost!.x + 1);
    expect(wideOpen.status!.right).toBeLessThanOrEqual(wideOpen.workbench!.x + 1);
    await expectNoHorizontalOverflow(window, "1440 卡片加工具");
    await evidence.shoot(window, "1440-卡片-工具.png");

    await collapseStatus(window);
    const wideShortbar = await readGeometry(window);
    await evidence.writeGeometry("1440-status-closed-tools-open", wideShortbar);
    expect(wideShortbar.shortbar).not.toBeNull();
    expect(wideShortbar.shortbar!.right).toBeLessThanOrEqual(wideShortbar.toolsHost!.x + 1);
    await expectShortbarClearOfChatControls(window, "1440");
    assertCompactContentReclaimsColumn(await readGeometry(window), "1440 工具开且短条收起");
    await evidence.shoot(window, "1440-短条-工具.png");

    await closeWorkbench(window);
    const wideToolsClosed = await readGeometry(window);
    await evidence.writeGeometry("1440-status-closed-tools-closed", wideToolsClosed);
    expect(wideToolsClosed.shortbar).not.toBeNull();
    expect(wideToolsClosed.toolsHost?.width ?? 0).toBe(0);
    await expectToolZeroPlaceholder(window);
    await expect(window.getByTestId("task-status-expand")).toBeVisible();
    await expectShortbarClearOfChatControls(window, "1440-工具关闭");
    expect(
      wideToolsClosed.documentScrollWidth - wideToolsClosed.documentClientWidth,
    ).toBeLessThanOrEqual(0);

    for (const width of [1440, 1100, 900, 760]) {
      await setViewport(window, width, width <= 900 ? 700 : 900);
      await openWorkbench(window);
      await expandIfCompact(window);
      const geometry = await readGeometry(window);
      await evidence.writeGeometry(`${width}-status-open-tools-open`, geometry);
      assertThreeColumns(geometry, `${width}px 卡片加工具`);
      await expectNoHorizontalOverflow(window, `${width}px 卡片加工具`);
      if (width === 760) {
        await evidence.shoot(window, "760-手动展开三列.png");
      }

      await collapseStatus(window);
      const compact = await readGeometry(window);
      await evidence.writeGeometry(`${width}-status-closed-tools-open`, compact);
      expect(compact.shortbar).not.toBeNull();
      expect(compact.shortbar!.right).toBeLessThanOrEqual(compact.toolsHost!.x + 1);
      await expectNoHorizontalOverflow(window, `${width}px 短条加工具`);
      await expectShortbarClearOfChatControls(window, `${width}`);
      assertCompactContentReclaimsColumn(await readGeometry(window), `${width}px 工具开且短条收起`);
      if (width === 900) {
        await evidence.shoot(window, "900-短条-工具.png");
      }

      await closeWorkbench(window);
      const compactToolsClosed = await readGeometry(window);
      await evidence.writeGeometry(`${width}-status-closed-tools-closed`, compactToolsClosed);
      expect(compactToolsClosed.shortbar).not.toBeNull();
      expect(compactToolsClosed.toolsHost?.width ?? 0).toBe(0);
      await expectShortbarClearOfChatControls(window, `${width}-短条且工具关闭`);

      await expandIfCompact(window);
      const expandedToolsClosed = await readGeometry(window);
      await evidence.writeGeometry(`${width}-status-open-tools-closed`, expandedToolsClosed);
      expect(expandedToolsClosed.status).not.toBeNull();
      expect(expandedToolsClosed.shortbar).toBeNull();
      expect(expandedToolsClosed.toolsHost?.width ?? 0).toBe(0);
      assertExpandedStatusFillsOverviewColumn(expandedToolsClosed, `${width}px 卡片且工具关闭`);
      expect(boxesIntersect(expandedToolsClosed.status!, expandedToolsClosed.topbar!)).toBe(false);
      expect(
        boxesIntersect(expandedToolsClosed.status!, expandedToolsClosed.composerSurface!),
      ).toBe(false);
      await expectNoHorizontalOverflow(window, `${width}px 卡片且工具关闭`);
    }

    await setViewport(window, 900, 520);
    await openWorkbench(window);
    await expandIfCompact(window);
    const short = await readGeometry(window);
    await evidence.writeGeometry("900x520-status-open-tools-open", short);
    assertThreeColumns(short, "900x520 矮窗");
    await expect(window.getByTestId("topbar")).toBeVisible();
    expect(short.topbar).not.toBeNull();
    expect(short.status).not.toBeNull();
    expect(short.status!.right).toBeLessThanOrEqual(short.documentClientWidth);
    expect(short.status!.x).toBeGreaterThanOrEqual(short.topbar!.right - 1);
    expect(boxesIntersect(short.status!, short.topbar!)).toBe(false);
    expect(boxesIntersect(short.status!, short.composerSurface!)).toBe(false);
    expect(short.composerSurface!.bottom).toBeLessThanOrEqual(short.innerHeight + 1);
    expect(short.composerSurface!.y).toBeGreaterThanOrEqual(short.topbar!.bottom);
    await expectNoHorizontalOverflow(window, "900x520 矮窗");
    await evidence.shoot(window, "矮窗-卡片三列.png");

    await setViewport(window, 1440, 900);
    await expandIfCompact(window);
    const beforeScroll = await readGeometry(window);
    const statusScroll = window.getByTestId("task-status-files");
    await expect(statusScroll).toBeVisible();
    const contentScroll = window.getByTestId("task-status").locator(".task-status__scroll");
    const overflowStates = await contentScroll.evaluateAll((elements) =>
      elements.map((element) => {
        const computed = getComputedStyle(element);
        return {
          overflowX: computed.overflowX,
          overflowY: computed.overflowY,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
        };
      }),
    );
    expect(overflowStates).toHaveLength(3);
    expect(
      overflowStates.every(
        (state) =>
          ["auto", "scroll"].includes(state.overflowY) &&
          state.scrollWidth <= state.clientWidth + 1,
      ),
    ).toBe(true);
    const afterScroll = await readGeometry(window);
    expect(afterScroll.status!.x).toBeCloseTo(beforeScroll.status!.x, 0);
    expect(afterScroll.status!.y).toBeCloseTo(beforeScroll.status!.y, 0);

    await harness.close();
    harness = await launchPackagedDesktop(userDataDir, {
      agentDir,
      initialWorkspaces: [workspacePath],
      testMode: "foreground",
      scrubProviderEnv: true,
      envOverrides: {
        PAO_HOME: paoHome,
        SHELL: process.env.ComSpec,
      },
    });
    window = await harness.firstWindow();
    await harness.focusWindow();
    await expectPackagedIdentity(harness, releaseDir, executable, window);
    await selectSession(window, SESSION_TITLE);
    await setViewport(window, 1100, 900);
    await expect
      .poll(() => window.evaluate(() => localStorage.getItem("pi-gui.task-status-collapsed")))
      .toBe("false");

    await setViewport(window, 1440, 900);
    await closeWorkbench(window);
    await expect(window.getByTestId("task-status")).toBeVisible();
    const relaunched = await readGeometry(window);
    await evidence.writeGeometry("relaunch-wide-tools-closed-status-preference", relaunched);
    expect(relaunched.status).not.toBeNull();
    expect(relaunched.shortbar).toBeNull();
    await expect
      .poll(() => window.evaluate(() => localStorage.getItem("pi-gui.task-status-collapsed")))
      .toBe("false");
    await expect
      .poll(() => window.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(relaunched.documentClientWidth);
  } finally {
    await harness.close();
  }
});

test("发行侧栏：宽度偏好、终端保留、焦点、主题、文件状态与复跑证据", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const releaseDir = configuredReleaseDir();
  process.env.PI_APP_TEST_RELEASE_DIR = releaseDir;
  const executable = await resolvePackagedAppExecutable(releaseDir);
  const userDataDir = await makeUserDataDir("pao-floating-status-interaction-");
  const workspacePath = await makeGitWorkspace("floating-status-interaction");
  const agentDir = join(userDataDir, "agent");
  const paoHome = join(userDataDir, "pao-home");
  const evidence = await createEvidenceRun();
  currentEvidence = evidence;
  const terminalMarker = `FLOATING_STATUS_${testInfo.workerIndex}_${Date.now()}`;

  await mkdir(paoHome, { recursive: true });
  await writeTextFile(join(workspacePath, "README.md"), "# 交互验收\n\n修改 fixture\n");
  await writeTextFile(join(workspacePath, "evidence-untracked.txt"), "untracked fixture\n");

  let harness = await launchPackagedDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "foreground",
    scrubProviderEnv: true,
    envOverrides: {
      PAO_HOME: paoHome,
      SHELL: process.env.ComSpec,
    },
  });

  try {
    let window = await harness.firstWindow();
    await harness.focusWindow();
    await expectPackagedIdentity(harness, releaseDir, executable, window);
    await createNamedThread(window, NARROW_SESSION_TITLE);
    harness = await seedOfflineTranscript(harness, window, userDataDir);
    window = await harness.firstWindow();
    await expectPackagedIdentity(harness, releaseDir, executable, window);
    await selectSession(window, NARROW_SESSION_TITLE);
    await waitForTimelineLayout(window);
    await setViewport(window, 1440, 900);
    await openWorkbench(window);
    await expandIfCompact(window);

    const statusFiles = window.getByTestId("task-status-files");
    await expect(statusFiles).toContainText("2 个未提交文件");
    await expect(statusFiles).toContainText("包含 untracked 文件");
    await writeTextFile(
      join(workspacePath, "runtime-untracked.txt"),
      "刷新后出现的第三个未提交文件\n",
    );
    await window
      .getByTestId("task-status")
      .getByRole("button", { name: "刷新", exact: true })
      .click();
    await expect(statusFiles).toContainText("3 个未提交文件");
    await evidence.shoot(window, "文件变更-手动修改与untracked.png");

    const panel = window.getByTestId("workbench");
    const panelWidth = async () => (await panel.boundingBox())!.width;
    await expect.poll(panelWidth).toBeGreaterThan(300);
    const handle = window.getByRole("separator", { name: "Side panel width" });
    await handle.focus();
    await expect(handle).toBeFocused();
    await handle.press("ArrowLeft");
    await expect.poll(panelWidth).toBeGreaterThan(350);
    await expect(handle).toBeFocused();
    const resizedWidth = await panelWidth();
    await expect
      .poll(() => window.evaluate(() => localStorage.getItem("pi-gui.workbench-width")))
      .toBe(String(Math.round(resizedWidth)));
    const preferenceBeforeNarrow = await window.evaluate(() =>
      localStorage.getItem("pi-gui.workbench-width"),
    );
    const resizedGeometry = await readGeometry(window);
    await evidence.writeGeometry("1440-keyboard-resized-panel", resizedGeometry);
    await expectNoHorizontalOverflow(window, "键盘调宽工具");

    await setViewport(window, 900, 700);
    await expandIfCompact(window);
    await expect
      .poll(() => window.evaluate(() => localStorage.getItem("pi-gui.task-status-collapsed")))
      .toBe("false");
    const statusPreferenceBeforeAutoCompact = await window.evaluate(() =>
      localStorage.getItem("pi-gui.task-status-collapsed"),
    );
    const collapsedBeforeToolsToggle = await window.evaluate(() =>
      localStorage.getItem("pi-gui.task-status-collapsed"),
    );
    await window.getByTestId("toggle-side-panel").click();
    await expect(panel).toBeHidden();
    await expect
      .poll(() => window.evaluate(() => localStorage.getItem("pi-gui.task-status-collapsed")))
      .toBe(collapsedBeforeToolsToggle);
    const noTools = await readGeometry(window);
    await evidence.writeGeometry("900-tools-closed-status-open", noTools);
    expect(noTools.toolsHost?.width ?? 0).toBe(0);
    await expectToolZeroPlaceholder(window);
    await expectNoHorizontalOverflow(window, "900 工具关闭");

    await openWorkbench(window);
    await addTool(window, "Terminal");
    const terminal = window.getByTestId("integrated-terminal");
    await expect(terminal).toBeVisible();
    await terminal.locator(".xterm").click();
    await window.keyboard.type(echoCommand(terminalMarker));
    await window.keyboard.press("Enter");
    await expect(terminal.locator(".xterm-rows")).toContainText(terminalMarker, {
      timeout: 15_000,
    });
    const terminalElement = await terminal.elementHandle();
    expect(
      await window.evaluate((element) => {
        if (!element) return false;
        element.dataset.floatingStatusProbe = "same-node";
        return element.isConnected;
      }, terminalElement),
    ).toBe(true);
    await closeWorkbench(window);
    await expect(window.getByTestId("integrated-terminal")).toHaveCount(1);
    await expect(window.getByTestId("integrated-terminal").locator(".xterm-rows")).toContainText(
      terminalMarker,
    );
    expect(
      await window.evaluate(
        () => document.querySelector('[data-floating-status-probe="same-node"]')?.isConnected,
      ),
    ).toBe(true);
    await openWorkbench(window);
    await expect(window.getByTestId("terminal-tab")).toHaveCount(1);
    await expect(window.getByTestId("integrated-terminal")).toHaveCount(1);
    await expect(window.getByTestId("integrated-terminal").locator(".xterm-rows")).toContainText(
      terminalMarker,
    );
    expect(
      await window.evaluate(
        () => document.querySelector('[data-floating-status-probe="same-node"]')?.isConnected,
      ),
    ).toBe(true);
    await expect(panel).toBeVisible();

    await setViewport(window, 1440, 900);
    await expect.poll(panelWidth).toBeCloseTo(resizedWidth, 0);
    expect(await window.evaluate(() => localStorage.getItem("pi-gui.workbench-width"))).toBe(
      preferenceBeforeNarrow,
    );
    await expect
      .poll(() => window.evaluate(() => localStorage.getItem("pi-gui.task-status-collapsed")))
      .toBe(statusPreferenceBeforeAutoCompact);

    await setViewport(window, 760, 700);
    await expect.poll(() => window.evaluate(() => globalThis.innerWidth)).toBe(760);
    const narrowPreference = await window.evaluate(() =>
      localStorage.getItem("pi-gui.task-status-collapsed"),
    );
    expect(narrowPreference).toBe(statusPreferenceBeforeAutoCompact);
    expect(await window.evaluate(() => localStorage.getItem("pi-gui.workbench-width"))).toBe(
      preferenceBeforeNarrow,
    );
    await expect.poll(panelWidth).toBeLessThanOrEqual(320);
    await expect(window.getByTestId("task-status-expand")).toBeVisible();
    const narrow = await readGeometry(window);
    await evidence.writeGeometry("760-auto-compact-tools-open", narrow);
    expect(narrow.toolsHost).not.toBeNull();
    expect(narrow.toolsHost!.width).toBeLessThanOrEqual(320);
    expect(narrow.shortbar).not.toBeNull();
    expect(narrow.shortbar!.right).toBeLessThanOrEqual(narrow.toolsHost!.x + 1);
    await expectNoHorizontalOverflow(window, "760 自动短条");
    await expectShortbarClearOfChatControls(window, "760");
    assertCompactContentReclaimsColumn(await readGeometry(window), "760 自动短条");

    await setViewport(window, 1440, 900);
    await expect.poll(panelWidth).toBeCloseTo(resizedWidth, 0);
    expect(await window.evaluate(() => localStorage.getItem("pi-gui.workbench-width"))).toBe(
      preferenceBeforeNarrow,
    );

    await setViewport(window, 760, 700);
    await window.getByTestId("task-status-expand").click();
    await expect(window.getByTestId("task-status")).toBeVisible();
    const narrowExpanded = await readGeometry(window);
    assertThreeColumns(narrowExpanded, "760 手动展开");
    const narrowScroll = await window.getByTestId("task-status").evaluate((element) => {
      const sections = [...element.querySelectorAll<HTMLElement>(".task-status__scroll")];
      return sections.map((section) => ({
        clientHeight: section.clientHeight,
        overflowY: getComputedStyle(section).overflowY,
        scrollHeight: section.scrollHeight,
      }));
    });
    expect(narrowScroll.length).toBe(3);
    expect(narrowScroll.every((section) => ["auto", "scroll"].includes(section.overflowY))).toBe(
      true,
    );
    expect(narrowScroll.every((section) => section.scrollHeight >= section.clientHeight)).toBe(
      true,
    );
    await expectNoHorizontalOverflow(window, "760 手动展开");
    await evidence.writeGeometry("760-manual-expanded-three-columns", narrowExpanded);

    await setViewport(window, 1440, 900);
    await expect(window.getByTestId("task-status")).toBeVisible();
    await expect.poll(panelWidth).toBeCloseTo(resizedWidth, 0);
    expect(await window.evaluate(() => localStorage.getItem("pi-gui.workbench-width"))).toBe(
      preferenceBeforeNarrow,
    );
    await expect
      .poll(() => window.evaluate(() => localStorage.getItem("pi-gui.task-status-collapsed")))
      .toBe("false");

    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await expect(window.locator(".view-header__title")).toHaveText("General");
    await window
      .getByTestId("settings-surface")
      .getByRole("button", { name: "Appearance", exact: true })
      .click();
    await window
      .getByTestId("settings-surface")
      .getByRole("radio", { name: "Light", exact: true })
      .click();
    await expect
      .poll(() => window.evaluate(() => document.documentElement.classList.contains("dark")))
      .toBe(false);
    await window
      .getByTestId("settings-surface")
      .getByRole("button", { name: "Back to app" })
      .click();
    await selectSession(window, NARROW_SESSION_TITLE);
    await setViewport(window, 1440, 900);
    await expandIfCompact(window);
    await evidence.shoot(window, "浅色代表态.png");
    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window
      .getByTestId("settings-surface")
      .getByRole("button", { name: "Appearance", exact: true })
      .click();
    await window
      .getByTestId("settings-surface")
      .getByRole("radio", { name: "Dark", exact: true })
      .click();
    await expect
      .poll(() => window.evaluate(() => document.documentElement.classList.contains("dark")))
      .toBe(true);
    await window
      .getByTestId("settings-surface")
      .getByRole("button", { name: "Back to app" })
      .click();
    await selectSession(window, NARROW_SESSION_TITLE);
    await setViewport(window, 1440, 900);
    await openWorkbench(window);
    await expandIfCompact(window);
    await evidence.shoot(window, "深色代表态.png");

    await reloadDesktopRenderer(window);
    await expect(window.getByTestId("workbench")).toBeVisible();
    await expect
      .poll(() => window.evaluate(() => localStorage.getItem("pi-gui.workbench-width")))
      .toBe(String(Math.round(resizedWidth)));
    await expect
      .poll(() => window.evaluate(() => localStorage.getItem("pi-gui.task-status-collapsed")))
      .toBe("false");
  } finally {
    await harness.close();
  }
});
