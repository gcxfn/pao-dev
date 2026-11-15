import { expect, test, type Page } from "@playwright/test";
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

/**
 * 冻住渲染进程的定时器，让 350ms 防抖保存一直停在「还没写」的状态。
 * 只有冻住时钟，才能稳定地断言「reload 发生时草稿确实还在防抖窗口内」——
 * 否则跑得慢一点防抖就自己过去了，用例会退化成「已落盘后 reload 不丢」。
 */
async function pauseRendererTimers(window: Page): Promise<void> {
  await window.clock.install();
  await window.clock.pauseAt(Date.now() + 1_000);
}

/**
 * D4：侧栏首屏摘要 + 草稿与真实反馈（计划 §7.2 / §7.3）。
 *
 * 这些用例只证明「界面在真实 Electron 里表现出的行为」，不注入快照、不写 IPC 捷径：
 * - 刷新后未提交的草稿还在，且不串到别的会话；
 * - 切换会话再切回来，草稿与选择都找得回；
 * - 发送失败时如实报失败、把文字还给输入框，不报成功；
 * - 侧栏首屏摘要只报快照里真有的事。
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
    await expect
      .poll(async () => (await getDesktopState(window)).composerDraft)
      .toBe(DRAFT_A);

    // 刷新渲染进程：已落盘的未提交草稿不能被投影出的新状态冲掉。
    await reloadDesktopRenderer(window);
    await expect(window.getByTestId("composer")).toHaveValue(DRAFT_A);

    // 建第二个会话，打上乙的草稿；再切回甲，两边的草稿各自还在，不串。
    await createNamedThread(window, "Draft session B");
    await expect(window.getByTestId("composer")).toBeVisible();
    await window.getByTestId("composer").fill(DRAFT_B);
    await expect(window.getByTestId("composer")).toHaveValue(DRAFT_B);
    await expect
      .poll(async () => (await getDesktopState(window)).composerDraft)
      .toBe(DRAFT_B);

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

test("sidebar summary reports only what the snapshot actually holds", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("d4-summary-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Summary session");
    await expect(window.getByTestId("composer")).toBeVisible();

    // 有会话就有摘要：进度、最新成果都要出来。
    await expect(window.getByTestId("sidebar-summary")).toBeVisible();
    await expect(window.getByTestId("sidebar-summary-running")).toBeVisible();
    await expect(window.getByTestId("sidebar-summary-latest")).toContainText("Summary session");

    // 明细日志默认收起（按需展开），点开才出现。
    await expect(window.getByTestId("sidebar-summary-log")).toHaveCount(0);
    await window.getByTestId("sidebar-summary-log-toggle").click();
    await expect(window.getByTestId("sidebar-summary-log")).toBeVisible();
    await window.getByTestId("sidebar-summary-log-toggle").click();
    await expect(window.getByTestId("sidebar-summary-log")).toHaveCount(0);
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

    // 工作入口仍是一组紧凑卡片，原来的测试标识一个都不能少（其他 batch 的用例依赖它们）。
    await expect(window.getByTestId("sidebar-work-surfaces")).toBeVisible();
    for (const id of ["sidebar-canvas", "sidebar-workboard", "sidebar-plans", "sidebar-threads"]) {
      await expect(window.getByTestId(id)).toBeVisible();
    }
    // 「当前对话就是你干活的地方」这句定位在首屏可见（测试环境默认英文界面）。
    await expect(window.getByText("The open conversation is where you work.")).toBeVisible();
    // 这些入口不嵌完整主页面：侧栏里没有画布、配方编辑器和第二套输入框。
    await expect(window.getByTestId("sidebar-work-surfaces").locator("textarea")).toHaveCount(0);
    await expect(window.getByTestId("sidebar-work-surfaces").getByTestId("composer")).toHaveCount(0);
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
    await expect
      .poll(async () => (await getDesktopState(window)).composerDraft)
      .toBe(DRAFT);
    await selectSession(window, "Debounce reload session");
    await expect(window.getByTestId("composer")).toHaveValue(DRAFT);
  } finally {
    await harness.close();
  }
});
