import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  rejectIpcInvokes,
  reloadDesktopRenderer,
  selectSession,
} from "../helpers/electron-app";

const execFileAsync = promisify(execFile);

const compactStatusFixture = `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [dist, project, owner] = process.argv.slice(2);
const load = (name) => import(pathToFileURL(join(dist, name)).href);
const plan = await load("workflow/plan.js");
const driver = await load("workflow/driver.js");
const control = await load("workflow/control.js");
const cards = await load("cards/index.js");
const feedback = await load("workflow/plan-feedback.js");

const steps = [
  {
    标题: "核对空态与长内容布局",
    部门: "研发部",
    要求: "检查卡片自然高度、分区滚动和矮窗可达性。" + "长内容检查。".repeat(80),
    预期成果: Array.from({ length: 12 }, (_, index) => "成果" + (index + 1) + ".md").join("、"),
  },
  ...Array.from({ length: 14 }, (_, index) => ({
    标题: "长计划步骤 " + (index + 2),
    部门: index % 2 ? "研发部" : "审查部",
    要求: "真实计划长内容 " + (index + 2),
  })),
];

const created = await plan.createTemporaryPlan({
  项目根: project,
  显示名: "概况长内容与矮窗验证",
  来源会话: owner,
  请求ID: "compact-status-layout",
  已注册部门: ["研发部", "审查部"],
  步骤: steps,
  当刻: "2026-10-19 09:00",
});

const execution = plan.resolvePlanExecution({
  项目根: project,
  计划ID: created.计划ID,
  启动请求ID: "compact-status-start",
  定义版本: 1,
  来源会话: owner,
});
await driver.startWorkflow(execution.配方, {}, {
  cardsDir: execution.卡目录,
  workspaceDir: execution.工作区,
  ownerSessionId: owner,
});
const identity = plan.readPlanInstanceIdentity(execution.工作区, execution.配方名);
if (!identity) throw new Error("实例身份读不出来");
plan.recordPlanStart(execution.关联路径, {
  计划ID: created.计划ID,
  定义版本: 1,
  启动请求ID: "compact-status-start",
  实例: identity.实例,
  配方名: execution.配方名,
  工作区: execution.工作区,
  卡目录: execution.卡目录,
  控制清单: execution.控制清单,
  owner会话: owner,
  受理时刻: "2026-10-19 09:01",
});

const options = {
  cardsDir: execution.卡目录,
  workspaceDir: execution.工作区,
  ownerSessionId: owner,
};
await control.bindMinister(execution.配方, options, "s1", owner);
const [cardRef] = await control.addNodeCards(
  execution.配方,
  options,
  { 实例: identity.实例, 节点: "s1", 轮次: 1, 部长会话: owner },
  [{ goal: "验证概况长内容与工人状态", acceptance: "真实卡状态与回执可读" }],
);
const cardNo = cards.parseCardRef(cardRef);
let card = cards.loadCard(execution.卡目录, cardNo);
card = cards.changeCardStatus(card, {
  操作者: card.frontmatter.owner ?? owner,
  to: "in_progress",
  时间: "2026-10-19 09:02",
});

for (let index = 1; index <= 10; index++) {
  const recorded = await feedback.recordPlanFeedback({
    项目根: project,
    计划ID: created.计划ID,
    目标: { 类型: "步骤", 步骤ID: "s1" },
    正文: "真实长内容反馈 " + index + "：" + "检查概况滚动与矮窗可达性。".repeat(6),
    投递请求ID: "compact-feedback-" + index,
    来源会话: owner,
    当刻: "2026-10-19 09:" + String(10 + index).padStart(2, "0"),
  });
  await feedback.recordPlanFeedbackDelivery({
    项目根: project,
    计划ID: created.计划ID,
    意见ID: recorded.entry.意见ID,
    送达: index % 2 === 0,
    结果: index % 2 === 0 ? "已送达来源主对话" : "主对话暂时不可达：" + index,
    投递请求ID: "compact-feedback-" + index,
    来源会话: owner,
    当刻: "2026-10-19 09:" + String(20 + index).padStart(2, "0"),
  });
}

console.log(JSON.stringify({ planId: created.计划ID, instanceId: identity.实例 }));
`;

/**
 * 冻住渲染进程的定时器，让 350ms 防抖保存一直停在「还没写」的状态。
 * 只有冻住时钟，才能稳定地断言「reload 发生时草稿确实还在防抖窗口内」——
 * 否则跑得慢一点防抖就自己过去了，用例会退化成「已落盘后 reload 不丢」。
 */
async function pauseRendererTimers(window: Page): Promise<void> {
  await window.clock.install();
  await window.clock.pauseAt(Date.now() + 1_000);
}

async function saveProof(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const proofDir = process.env.PI_APP_UI_PROOF_DIR?.trim();
  if (!proofDir) return;
  await mkdir(proofDir, { recursive: true });
  const path = join(proofDir, name);
  await page.screenshot({ path, animations: "disabled" });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

/**
 * D4：侧栏导航与滚动 + 草稿与真实反馈（计划 §7.2 / §7.3）。
 *
 * 这些用例只证明「界面在真实 Electron 里表现出的行为」，不注入快照、不写 IPC 捷径：
 * - 刷新后未提交的草稿还在，且不串到别的会话；
 * - 切换会话再切回来，草稿与选择都找得回；
 * - 发送失败时如实报失败、把文字还给输入框，不报成功；
 * - 左栏保留会话与定时任务，右栏工作状态常驻，会话列表在矮窗口里仍能滚动。
 */
test("keeps an unsent draft across reload and session switches", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("d4-draft-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  const DRAFT_A = "草稿甲：还没发出去的话";
  const DRAFT_B = "草稿乙：另一条会话的话";

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Draft session A");
    await expect(window.getByTestId("composer")).toBeVisible();

    // 甲会话打一句话，不发送。
    await window.getByTestId("composer").fill(DRAFT_A);
    await expect(window.getByTestId("composer")).toHaveValue(DRAFT_A);
    // 等草稿真正落盘（350ms 防抖之后），再刷新。刷新本身不抢焦点、不重置未提交字段。
    await expect.poll(async () => (await getDesktopState(window)).composerDraft).toBe(DRAFT_A);

    // 刷新渲染进程：已落盘的未提交草稿不能被投影出的新状态冲掉。
    await reloadDesktopRenderer(window);
    await expect(window.getByTestId("composer")).toHaveValue(DRAFT_A);

    // 建第二个会话，打上乙的草稿；再切回甲，两边的草稿各自还在，不串。
    await createNamedThread(window, "Draft session B");
    await expect(window.getByTestId("composer")).toBeVisible();
    await window.getByTestId("composer").fill(DRAFT_B);
    await expect(window.getByTestId("composer")).toHaveValue(DRAFT_B);
    await expect.poll(async () => (await getDesktopState(window)).composerDraft).toBe(DRAFT_B);

    await selectSession(window, "Draft session A");
    await expect(window.getByTestId("composer")).toHaveValue(DRAFT_A);

    await selectSession(window, "Draft session B");
    await expect(window.getByTestId("composer")).toHaveValue(DRAFT_B);
  } finally {
    await harness.close();
  }
});

test("reports an unsent message as unsent and hands the text back", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("d4-unsent-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  const TEXT = "这条消息应当发不出去";

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Unsent session");
    await expect(window.getByTestId("composer")).toBeVisible();

    // 让控制入口真的失败：界面必须如实报「没发出去」，不能悄悄报成功。
    await rejectIpcInvokes(harness, "pi-gui:session-control");

    await window.getByTestId("composer").fill(TEXT);
    await window.getByTestId("composer").press("Enter");

    // 文字被交还：输入框重新拿回这句话，而不是被清空当成已发送。
    await expect(window.getByTestId("composer")).toHaveValue(TEXT);
    // 并且界面上有可见的错误，不能静默。
    await expect(window.getByTestId("composer-error-banner")).toBeVisible();
  } finally {
    await harness.close();
  }
});

test("侧栏四个入口与右侧常驻状态，矮窗口中的会话列表可以用滚轮滚动", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("d4-summary-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    for (let index = 0; index < 7; index++)
      await createNamedThread(window, `Scroll session ${index}`);
    await window.setViewportSize({ width: 1100, height: 520 });
    for (const id of [
      "sidebar-canvas",
      "sidebar-workboard",
      "sidebar-threads",
      "sidebar-scheduled",
    ]) {
      await expect(window.getByTestId(id)).toBeVisible();
    }
    await expect(window.locator(".sidebar__nav-item")).toHaveCount(4);
    await expect(window.getByTestId("task-status")).toBeVisible();
    await expect(window.getByTestId("sidebar-summary")).toHaveCount(0);
    await expect(window.locator(".sidebar__advanced")).toHaveCount(0);
    const sessions = window.locator(".sidebar__section");
    const space = await sessions.evaluate((element) => ({
      height: element.clientHeight,
      content: element.scrollHeight,
    }));
    expect(space.height).toBeGreaterThan(100);
    expect(space.content).toBeGreaterThan(space.height);
    await sessions.evaluate((element) => {
      element.scrollTop = 0;
    });
    await sessions.hover();
    await window.mouse.wheel(0, 600);
    await expect.poll(() => sessions.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await window.mouse.wheel(0, -1200);
    await expect.poll(() => sessions.evaluate((element) => element.scrollTop)).toBe(0);
    const footer = await window.locator(".sidebar__footer").boundingBox();
    expect(footer!.y + footer!.height).toBeLessThanOrEqual(520);
  } finally {
    await harness.close();
  }
});

test("keeps the open conversation as the default work surface in the sidebar", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("d4-sidebar-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Sidebar session");
    await expect(window.getByTestId("composer")).toBeVisible();

    // 工作入口移到右侧，侧栏只保留会话和定时任务。
    await expect(window.getByTestId("sidebar-work-surfaces")).toBeVisible();
    for (const id of ["sidebar-threads", "sidebar-scheduled"]) {
      await expect(window.getByTestId(id)).toBeVisible();
    }
    await expect(window.getByTestId("sidebar-plans")).toHaveCount(0);
    // 「当前对话就是你干活的地方」这句定位在首屏可见（测试环境默认英文界面）。
    await expect(window.getByText("The open conversation is where you work.")).toBeVisible();
    // 这些入口不嵌完整主页面：侧栏里没有画布、配方编辑器和第二套输入框。
    await expect(window.getByTestId("sidebar-work-surfaces").locator("textarea")).toHaveCount(0);
    await expect(window.getByTestId("sidebar-work-surfaces").getByTestId("composer")).toHaveCount(
      0,
    );
  } finally {
    await harness.close();
  }
});

test("窄窗口里右侧状态栏默认收起，展开能看、收起能记住", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("d4-narrow-rail-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Narrow rail session");
    await expect(window.getByTestId("composer")).toBeVisible();

    // 宽窗保持常驻：默认 320px，其它入口都靠它进详情。
    const rail = window.getByTestId("task-status");
    await expect(rail).toBeVisible();
    expect(Math.round((await rail.boundingBox())!.width)).toBe(320);

    // 窄窗让位：状态栏默认收起，只留展开按钮。
    await window.setViewportSize({ width: 900, height: 700 });
    await expect(rail).toHaveCount(0);
    const expand = window.getByTestId("task-status-expand");
    await expect(expand).toBeVisible();

    // 展开是临时动作：宽度受 320px 上限约束，且不把「窄窗收起」这条默认写坏。
    await expand.click();
    await expect(rail).toBeVisible();
    expect(Math.round((await rail.boundingBox())!.width)).toBeLessThanOrEqual(320);
    await expect(window.getByTestId("task-status-files")).toBeVisible();
    const composerExpanded = (await window.getByTestId("composer").boundingBox())!;
    await expect
      .poll(() => window.evaluate(() => localStorage.getItem("pi-gui.task-status-collapsed")))
      .toBe("false");

    // 收起后状态栏整个让开，主区实际变宽（同视口下对比，避免窗口宽度本身影响结论）。
    await window.getByTestId("task-status-collapse").click();
    await expect(rail).toHaveCount(0);
    await expect
      .poll(async () => (await window.getByTestId("composer").boundingBox())!.width)
      .toBeGreaterThan(composerExpanded.width + 200);
    await expect
      .poll(() => window.evaluate(() => localStorage.getItem("pi-gui.task-status-collapsed")))
      .toBe("true");
    await reloadDesktopRenderer(window);
    await expect(window.getByTestId("task-status")).toHaveCount(0);

    // 再展开并记成偏好，宽窗也照这个选择走。
    await window.getByTestId("task-status-expand").click();
    await expect(window.getByTestId("task-status")).toBeVisible();
    await expect
      .poll(() => window.evaluate(() => localStorage.getItem("pi-gui.task-status-collapsed")))
      .toBe("false");
    await window.setViewportSize({ width: 1440, height: 900 });
    await expect(window.getByTestId("task-status")).toBeVisible();
    expect(Math.round((await window.getByTestId("task-status").boundingBox())!.width)).toBe(320);
    await reloadDesktopRenderer(window);
    await expect(window.getByTestId("task-status")).toBeVisible();
  } finally {
    await harness.close();
  }
});

test("窄窗手动展开概况并打开工具时，概况、工具和正文各占位置且无横向溢出", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("d4-narrow-expanded-tools");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Narrow expanded tools");
    await window.setViewportSize({ width: 900, height: 700 });
    const compact = window.getByTestId("task-status-expand");
    // 首次点击顶栏按钮时概况还是短条；第二次点击同一按钮会把刚打开的工具关掉。
    // 因此必须先等概况真正进入短条，不能只用隐藏节点的 count() 判断。
    await expect(compact).toBeVisible();
    await compact.click();
    await expect(window.getByTestId("task-status")).toBeVisible();
    await window.getByTestId("toggle-side-panel").click();
    const status = window.getByTestId("task-status");
    const tools = window.getByTestId("workbench");
    const composer = window.getByTestId("composer");
    await expect(status).toBeVisible();
    await expect(tools).toBeVisible();
    await expect(composer).toBeVisible();
    const statusBox = (await status.boundingBox())!;
    const toolsBox = (await tools.boundingBox())!;
    const composerBox = (await composer.boundingBox())!;
    expect(composerBox.x + composerBox.width).toBeLessThanOrEqual(statusBox.x + 1);
    expect(statusBox.x + statusBox.width).toBeLessThanOrEqual(toolsBox.x + 1);
    const handle = window.getByRole("separator", { name: "Side panel width" });
    const toolWidth = Math.round(toolsBox.width);
    await expect(handle).toHaveAttribute("aria-valuemin", String(toolWidth));
    await expect(handle).toHaveAttribute("aria-valuemax", String(toolWidth));
    await expect(handle).toHaveAttribute("aria-valuenow", String(toolWidth));
    const horizontalOverflow = await window.evaluate(
      () => document.documentElement.scrollWidth - globalThis.innerWidth,
    );
    expect(horizontalOverflow).toBeLessThanOrEqual(0);
    expect(await window.evaluate(() => localStorage.getItem("pi-gui.task-status-collapsed"))).toBe(
      "false",
    );
    await window.getByTestId("task-status-collapse").click();
    const compactShortBar = window.getByTestId("task-status-expand");
    for (const width of [900, 760]) {
      await window.setViewportSize({ width, height: 700 });
      await expect(compactShortBar).toBeVisible();
      await expect(tools).toBeVisible();
      const main = window.locator(".main");
      await expect
        .poll(async () => {
          const compactBox = await compactShortBar.boundingBox();
          const toolsBox = await tools.boundingBox();
          const mainBox = await main.boundingBox();
          return compactBox && toolsBox && mainBox
            ? Math.max(
                compactBox.x + compactBox.width - toolsBox.x,
                Math.max(0, mainBox.x - compactBox.x),
              )
            : Number.POSITIVE_INFINITY;
        })
        .toBeLessThanOrEqual(1);
      await expect
        .poll(() =>
          window.evaluate(() => document.documentElement.scrollWidth - globalThis.innerWidth),
        )
        .toBeLessThanOrEqual(0);
    }
  } finally {
    await harness.close();
  }
});

test("从画布打开概况文件变更时保持画布并显示工具", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("d4-canvas-changes");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Canvas changes source");
    await window.getByTestId("sidebar-canvas").click();
    const canvasContent = window.getByTestId("workflow-cards");
    await expect(canvasContent).toBeVisible();
    await expect.poll(async () => (await getDesktopState(window)).activeView).toBe("canvas");

    const source = await getDesktopState(window);
    await window.getByTestId("task-status-open-changes").click();

    await expect(canvasContent).toBeVisible();
    await expect(window.getByTestId("workbench")).toBeVisible();
    await expect(window.getByRole("region", { name: "Review" })).toBeVisible();
    expect((await getDesktopState(window)).selectedWorkspaceId).toBe(source.selectedWorkspaceId);
    expect((await getDesktopState(window)).selectedSessionId).toBe(source.selectedSessionId);
  } finally {
    await harness.close();
  }
});

test("概况按内容收紧、长分区内部滚动，辅助对话说明使用中文", async ({}, testInfo) => {
  test.setTimeout(150_000);
  const userDataDir = await makeUserDataDir();
  const project = await makeWorkspace("compact-status-project");
  const home = await makeWorkspace("compact-status-home");
  await mkdir(join(home, "部门"), { recursive: true });
  await writeFile(join(userDataDir, "ui-state.json"), JSON.stringify({ language: "zh" }), "utf8");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [project],
    testMode: "background",
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: "1" },
    scrubProviderEnv: true,
  });
  try {
    const window = await harness.firstWindow();
    await window.setViewportSize({ width: 1440, height: 900 });
    await createNamedThread(window, "概况空态");

    // 空态仍完整显示说明与文件错误，卡片高度由内容决定，不再撑满可用高度。
    const emptyRail = window.getByTestId("task-status");
    await expect(emptyRail).toBeVisible();
    await expect(window.getByTestId("task-status-files")).toContainText("文件变更不可用");
    await expect(window.getByTestId("task-status-todos")).toContainText("当前会话尚无 PAO 计划");
    await expect(window.getByTestId("task-status-departments")).toContainText(
      "当前会话没有进行中的部门任务",
    );
    const emptyHeight = (await emptyRail.boundingBox())!.height;
    expect(emptyHeight).toBeLessThan(500);
    await saveProof(window, testInfo, "01-概况空态自然高度.png");

    // 工具选择菜单直接走现有 t(description)，中文界面不能再回退英文源串。
    await window.getByTestId("toggle-side-panel").click();
    await window.getByTestId("workbench-add-tab").click();
    const choice = window
      .getByTestId("workbench-chooser")
      .getByRole("button", { name: "辅助对话", exact: true });
    await expect(choice).toContainText("针对当前任务进行只读问答");
    await expect(choice).not.toContainText("Ask read-only questions about this task");
    await saveProof(window, testInfo, "02-辅助对话中文说明.png");
    await window.getByTestId("toggle-side-panel").click();

    const script = join(home, "make-compact-status-fixture.mjs");
    await writeFile(script, compactStatusFixture, "utf8");
    await execFileAsync(
      process.execPath,
      [
        script,
        join(__dirname, "../../node_modules/@earendil-works/pi-coding-agent/dist/pao"),
        project,
        (await getDesktopState(window)).selectedSessionId!,
      ],
      { windowsHide: true, env: { ...process.env, PAO_HOME: home } },
    );
    await window
      .getByTestId("task-status")
      .getByRole("button", { name: "刷新", exact: true })
      .click();
    await expect(window.getByTestId("task-status-todos")).toContainText("概况长内容与矮窗验证");
    await expect(window.getByTestId("task-status-departments")).toContainText(
      "核对空态与长内容布局",
    );

    const longRail = window.getByTestId("task-status");
    const longGeometry = await longRail.evaluate((element) => {
      const todos = element.querySelector<HTMLElement>('[data-testid="task-status-todos"]')!;
      const departments = element.querySelector<HTMLElement>(
        '[data-testid="task-status-departments"]',
      )!;
      return {
        height: element.getBoundingClientRect().height,
        todosClient: todos.clientHeight,
        todosScroll: todos.scrollHeight,
        departmentsClient: departments.clientHeight,
        departmentsScroll: departments.scrollHeight,
      };
    });
    expect(longGeometry.height).toBeLessThanOrEqual(480);
    expect(Math.max(longGeometry.todosScroll, longGeometry.departmentsScroll)).toBeGreaterThan(
      Math.max(longGeometry.todosClient, longGeometry.departmentsClient),
    );
    await saveProof(window, testInfo, "03-概况长内容内滚动.png");

    // 矮窗仍保留展开概况：实际滚动到末项，并保持顶部收起和底部部门入口可用。
    await window.setViewportSize({ width: 1100, height: 520 });
    await expect(longRail).toBeVisible();
    const todosScroll = window.getByTestId("task-status-todos");
    const lastStep = window.getByTestId("task-status-step-s15");
    await todosScroll.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(lastStep).toBeVisible();
    const lastStepBox = await lastStep.boundingBox();
    const todosBox = await todosScroll.boundingBox();
    expect(lastStepBox!.y + lastStepBox!.height).toBeLessThanOrEqual(
      todosBox!.y + todosBox!.height + 1,
    );
    const collapse = window.getByTestId("task-status-collapse");
    const departmentEntry = window.getByTestId("task-status-open-board");
    await expect(collapse).toBeVisible();
    await expect(departmentEntry).toBeVisible();
    const viewport = await window.evaluate(() => ({
      height: globalThis.innerHeight,
      scrollHeight: globalThis.document.documentElement.scrollHeight,
    }));
    expect(viewport.scrollHeight).toBeLessThanOrEqual(viewport.height);
    await saveProof(window, testInfo, "04-矮窗顶部按钮与部门可达.png");
    await departmentEntry.click();
    await expect(window.locator(".department-board__column")).toHaveCount(4);
    await window.getByTestId("task-status-collapse").click();
    await expect(window.getByTestId("task-status-expand")).toBeVisible();
  } finally {
    await harness.close();
  }
});

/**
 * 防抖窗口内刷新不丢（计划 §7.2「刷新/投影新对象不重置未提交字段」的最硬一条）。
 *
 * 与文件第一条用例的区别：那条先 `expect.poll` 等草稿真正落盘**再**刷新，覆盖的是
 * 「已落盘后刷新不丢」；这条**不等落盘**，把渲染层时钟冻住让 350ms 防抖一直挂着，
 * 在草稿只存在于输入框和防抖队列里时触发刷新。此时主进程必须先把草稿交给宿主再真正重载
 * （`electron/main.ts` 的 did-start-navigation 拦截），否则这句话就没了。
 *
 * `reloadDesktopRenderer` 已收口拦截带来的 `ERR_ABORTED`（首个 reload 被取消是正常表现），
 * 这里直接用公共辅助，不自己写重试。
 */
test("keeps a draft typed inside the save debounce across a reload", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("d4-debounce-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  const DRAFT = "防抖里打的字：还没到落盘时间就刷新";

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Debounce reload session");
    await expect(window.getByTestId("composer")).toBeVisible();

    // 先冻时钟再打字：从那以后防抖定时器不会自己到期，草稿一直挂在「待写」状态。
    await pauseRendererTimers(window);
    await window.getByTestId("composer").fill(DRAFT);
    await expect(window.getByTestId("composer")).toHaveValue(DRAFT);

    // 断言前提成立：此刻草稿**还没**落盘。没有这一步，这条用例会和第一条重复。
    expect((await getDesktopState(window)).composerDraft).toBe("");

    // 防抖窗口内刷新。
    await reloadDesktopRenderer(window);

    // ① 刷新之后输入框里的字还在（不是被投影出的空状态冲掉）。
    await expect(window.getByTestId("composer")).toHaveValue(DRAFT);
    // ② 而且最终真的落库了，不只是在 textarea 里活着——刷新完再切回同一个会话也要能拿回。
    await expect.poll(async () => (await getDesktopState(window)).composerDraft).toBe(DRAFT);
    await selectSession(window, "Debounce reload session");
    await expect(window.getByTestId("composer")).toHaveValue(DRAFT);
  } finally {
    await harness.close();
  }
});
