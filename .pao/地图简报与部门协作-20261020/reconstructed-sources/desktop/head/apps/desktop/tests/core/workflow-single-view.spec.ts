/** 隔离真实 Electron：S4-1⑤ 同配方另开标签＋S4-1⑥ 画布内时间线 active＋S4-2 单工作流嵌入视图。 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchDesktop, makeUserDataDir, makeWorkspace } from "../helpers/electron-app";

async function writeRecipe(home: string, name: string, goal: string): Promise<void> {
  await mkdir(join(home, "工作流"), { recursive: true });
  await writeFile(
    join(home, "工作流", `${name}.md`),
    `---\n${JSON.stringify({ 版本: 2, 名字: name, 参数: [], 节点: [{ 名字: "任务", 部门: "工程", 目标: goal, 验收: "检查", 人工确认: false, depends_on: [] }] })}\n---\n`,
  );
}

function launchOptions(home: string, project: string) {
  return {
    initialWorkspaces: [project],
    testMode: "background" as const,
    scrubProviderEnv: true,
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: "1" },
  };
}

test("同配方另开标签：右键入口开出第二标签，两标签各自独立主控（S4-1⑤）", async () => {
  const home = await makeWorkspace("workflow-newtab-home");
  const project = await makeWorkspace("workflow-newtab-project");
  const profile = await makeUserDataDir();
  await writeRecipe(home, "甲流程", "甲流程目标");
  const app = await launchDesktop(profile, launchOptions(home, project));
  try {
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-canvas").click();
    await page.getByTestId("canvas-recipe-row").filter({ hasText: "甲流程" }).click();
    await expect(page.getByTestId("recipe-canvas-editor")).toContainText("甲流程");

    // 显式入口：配方库行右键「在新标签中打开」，不去重重用既有标签。
    await page
      .getByTestId("canvas-recipe-row")
      .filter({ hasText: "甲流程" })
      .click({ button: "right" });
    await page
      .getByTestId("recipe-row-context-menu")
      .getByRole("menuitem", { name: "在新标签中打开" })
      .click();
    await expect
      .poll(async () => (await page.evaluate(() => window.piApp!.getState())).workflowTabs.length)
      .toBe(2);
    const sameRecipeTabs = await page.evaluate(
      () =>
        window.piApp!.getState().then((state) =>
          state.workflowTabs.filter((tab) => tab.recipeName === "甲流程"),
        ),
    );
    expect(new Set(sameRecipeTabs.map((tab) => tab.id)).size).toBe(2);

    // 第二标签建立自己的主控：与第一标签互不共享（各自独立）。
    await page.getByTestId("canvas-open-master-session").click();
    await expect(page.getByTestId("canvas-open-master-session")).toContainText("已建立");
    const controllers = await page.evaluate(
      () =>
        window.piApp!.getState().then((state) =>
          state.workflowTabs
            .filter((tab) => tab.recipeName === "甲流程")
            .map((tab) => tab.controller?.sessionId),
        ),
    );
    expect(controllers.filter(Boolean)).toHaveLength(1); // 只有当前标签建了主控
    // 回第一个标签另建主控，两会话不同。
    await page
      .getByTestId("workflow-tabs")
      .getByRole("button", { name: /^甲流程( ●)?$/ })
      .first()
      .click();
    await page.getByTestId("canvas-open-master-session").click();
    await expect(page.getByTestId("canvas-open-master-session")).toContainText("已建立");
    const after = await page.evaluate(
      () =>
        window.piApp!.getState().then((state) =>
          state.workflowTabs
            .filter((tab) => tab.recipeName === "甲流程")
            .map((tab) => tab.controller?.sessionId),
        ),
    );
    expect(new Set(after.filter(Boolean)).size).toBe(2);
    await page.screenshot({ path: test.info().outputPath("同配方两标签各自主控.png") });
  } finally {
    await app.close();
  }
});

test("画布内时间线处于 active：布局落定并接管滚动（S4-1⑥）", async () => {
  const home = await makeWorkspace("workflow-active-home");
  const project = await makeWorkspace("workflow-active-project");
  const profile = await makeUserDataDir();
  await writeRecipe(home, "乙流程", "乙流程目标");
  const app = await launchDesktop(profile, launchOptions(home, project));
  try {
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-canvas").click();
    await page.getByTestId("canvas-recipe-row").filter({ hasText: "乙流程" }).click();
    await page.getByTestId("canvas-open-master-session").click();
    await expect(page.getByTestId("embedded-chat")).toBeVisible();
    // active=false 时视口 hook 只标记 settling，永不落定；并入画布后布局提交为 settled。
    await expect(page.getByTestId("timeline-pane")).toHaveAttribute("data-layout", "settled");
    await page.screenshot({ path: test.info().outputPath("画布内时间线active.png") });
  } finally {
    await app.close();
  }
});

test("sidebar 分流：已绑定进单工作流嵌入视图，未绑定进完整中心，可回中心（S4-2）", async () => {
  // 旅程测试：两次建会话＋多次视图往返；60s 在真机 Electron 上不够（尾段步骤全正常也会被预算掐断）。
  test.setTimeout(120_000);
  const home = await makeWorkspace("workflow-single-home");
  const project = await makeWorkspace("workflow-single-project");
  const profile = await makeUserDataDir();
  await writeRecipe(home, "甲流程", "甲流程目标");
  const app = await launchDesktop(profile, launchOptions(home, project));
  try {
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-canvas").click();
    await page.getByTestId("canvas-recipe-row").filter({ hasText: "甲流程" }).click();
    await page.getByTestId("canvas-open-master-session").click();
    await expect(page.getByTestId("embedded-chat")).toBeVisible();
    const master = await page.evaluate(() =>
      window.piApp!.getState().then((state) => state.selectedSessionId),
    );
    expect(master).toBeTruthy();

    // 当前会话已绑定：sidebar 工作流入口进单工作流嵌入视图（无标签栏、无工作流库、保持当前会话）。
    // 先断可见（等挂载），再断隐藏——toBeHidden 对未挂载元素会空真。
    await page.getByRole("button", { name: "Threads", exact: true }).click();
    await expect(page.getByTestId("embedded-chat")).toHaveCount(0);
    await page.getByTestId("sidebar-canvas").click();
    await expect(page.getByTestId("embedded-chat")).toBeVisible();
    await expect(page.getByTestId("workflow-tabs")).toBeHidden();
    await expect(page.getByTestId("canvas-list")).toBeHidden();
    await expect
      .poll(async () => (await page.evaluate(() => window.piApp!.getState())).selectedSessionId)
      .toBe(master);

    // 折叠不丢草稿；回中心入口互通：标签栏与库回来，会话与草稿不动。
    const composer = page.getByTestId("embedded-chat").getByTestId("composer");
    await composer.fill("单工作流草稿");
    await page.getByTestId("embedded-chat-toggle").click();
    await expect(page.getByTestId("embedded-chat-body")).toHaveCount(0);
    await page.getByTestId("embedded-chat-toggle").click();
    await expect(page.getByTestId("embedded-chat").getByTestId("composer")).toHaveValue(
      "单工作流草稿",
    );
    await page.getByTestId("canvas-exit-single-view").click();
    await expect(page.getByTestId("workflow-tabs")).toBeVisible();
    await expect(page.getByTestId("canvas-list")).toBeVisible();
    await expect(page.getByTestId("embedded-chat").getByTestId("composer")).toHaveValue(
      "单工作流草稿",
    );

    // 未绑定（普通会话）：sidebar 工作流入口进完整中心。
    await page.getByRole("button", { name: "Threads", exact: true }).click();
    const workspaceId = await page.evaluate(() =>
      window.piApp!.getState().then((state) => state.selectedWorkspaceId),
    );
    await page.evaluate(async (wsId) => {
      await window.piApp!.createSession({ workspaceId: wsId, title: "普通会话" });
    }, workspaceId);
    await page.getByTestId("sidebar-canvas").click();
    await expect(page.getByTestId("workflow-tabs")).toBeVisible();
    await expect(page.getByTestId("canvas-list")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("未绑定进完整中心.png") });

    // 绑定标签不是活动标签时（新建了别的标签）：入口仍进单工作流视图并自动回到绑定标签。
    await page
      .getByTestId("workflow-tabs")
      .getByRole("button", { name: /^甲流程( ●)?$/ })
      .click();
    await page.getByTestId("canvas-new-workflow").click();
    await expect(
      page.getByTestId("workflow-tabs").getByRole("button", { name: /^新工作流1( ●)?$/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Threads", exact: true }).click();
    // 新建骨架若算未保存内容，离开画布的守卫可能出现：短等后可见才处理（视图切换本身不触发守卫）。
    const leaveGuard = page.getByRole("dialog", { name: "未保存修改", exact: true });
    await leaveGuard.waitFor({ state: "visible", timeout: 2000 }).catch(() => null);
    if (await leaveGuard.isVisible().catch(() => false)) {
      await leaveGuard.getByRole("button", { name: "放弃并继续" }).click();
    }
    await page.evaluate(async (target) => {
      await window.piApp!.selectSession(target);
    }, { workspaceId, sessionId: master });
    await page.getByTestId("sidebar-canvas").click();
    // 入口自动切回绑定标签；若骨架守卫出现，放弃并继续。先断可见再断隐藏（防 toBeHidden 空真）。
    const entryGuard = page.getByRole("dialog", { name: "未保存修改", exact: true });
    await entryGuard.waitFor({ state: "visible", timeout: 2000 }).catch(() => null);
    if (await entryGuard.isVisible().catch(() => false)) {
      await entryGuard.getByRole("button", { name: "放弃并继续" }).click();
    }
    await expect(page.getByTestId("embedded-chat")).toBeVisible();
    await expect(page.getByTestId("workflow-tabs")).toBeHidden();
    await expect(page.getByTestId("canvas-list")).toBeHidden();
    await expect(page.getByTestId("recipe-canvas-editor")).toContainText("甲流程");
    await expect(page.getByTestId("embedded-chat").getByTestId("composer")).toHaveValue(
      "单工作流草稿",
    );
    await page.screenshot({ path: test.info().outputPath("绑定标签非活动-自动回绑定标签.png") });

    // 收尾清理：骨架标签的未保存状态会触发 before-quit 的离开守卫
    // （main.ts before-quit → workflowLeaveGuard.requestAll → 未保存修改对话框），
    // 测试里无人应答会卡住退出（30s 强杀＋worker teardown 超时）。显式关掉骨架标签再结束。
    await page.getByTestId("canvas-exit-single-view").click();
    await expect(page.getByTestId("workflow-tabs")).toBeVisible();
    await page
      .getByTestId("workflow-tabs")
      .getByRole("button", { name: "关闭 新工作流1" })
      .click();
    // 关闭未落盘骨架可能弹离开守卫（骨架保留在 newEntries，关闭即随标签丢弃）。
    const closeGuard = page.getByRole("dialog", { name: "未保存修改", exact: true });
    await closeGuard.waitFor({ state: "visible", timeout: 5000 }).catch(() => null);
    if (await closeGuard.isVisible().catch(() => false)) {
      await closeGuard.getByRole("button", { name: "放弃并继续" }).click();
    }
    await expect(
      page.getByTestId("workflow-tabs").getByRole("button", { name: /^新工作流1( ●)?$/ }),
    ).toHaveCount(0);

    // 关窗（与 app.quit 同一条守卫链）：骨架 discard 后 dirty 可能仍挂真
    // （见 canvas-page「放弃并继续」按钮注释），关窗守卫会弹「未保存修改」；
    // 像用户一样应答「放弃并继续」，窗口关闭后应用退出，teardown 不再被挂。
    await page.evaluate(() => window.close());
    const quitGuard = page.getByRole("dialog", { name: "未保存修改", exact: true });
    await quitGuard.waitFor({ state: "visible", timeout: 3000 }).catch(() => null);
    if (await quitGuard.isVisible().catch(() => false)) {
      await quitGuard.getByRole("button", { name: "放弃并继续" }).click();
    }
  } finally {
    await app.close();
  }
});
