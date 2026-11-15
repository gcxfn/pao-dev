/** 隔离真实 Electron：标签与主控元数据持久化，不请求模型。 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchDesktop, makeUserDataDir, makeWorkspace } from "../helpers/electron-app";

test("工作流标签重开后保留独立主控，切换和关闭保护修改", async () => {
  const home = await makeWorkspace("workflow-tabs-home");
  const project = await makeWorkspace("workflow-tabs-project");
  const profile = await makeUserDataDir();
  await mkdir(join(home, "工作流"), { recursive: true });
  for (const name of ["甲流程", "乙流程"])
    await writeFile(
      join(home, "工作流", `${name}.md`),
      `---\n${JSON.stringify({ 版本: 2, 名字: name, 参数: [], 节点: [{ 名字: "任务", 部门: "工程", 目标: `${name}目标`, 验收: "检查", 人工确认: false, depends_on: [] }] })}\n---\n`,
    );
  const options = {
    initialWorkspaces: [project],
    testMode: "background" as const,
    scrubProviderEnv: true,
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: "1" },
  };
  let app = await launchDesktop(profile, options);
  try {
    let page = await app.firstWindow();
    await page.getByTestId("sidebar-canvas").click();
    await page.getByTestId("canvas-recipe-row").filter({ hasText: "甲流程" }).click();
    await page.getByTestId("canvas-open-master-session").click();
    await expect(page.getByTestId("canvas-open-master-session")).toContainText("已建立");
    await expect(page.getByTestId("embedded-chat")).toBeVisible();
    await page.getByTestId("embedded-chat").getByTestId("composer").fill("甲主控草稿");
    await page.getByTestId("canvas-recipe-row").filter({ hasText: "乙流程" }).click();
    await page.getByTestId("canvas-open-master-session").click();
    await expect(page.getByTestId("canvas-open-master-session")).toContainText("已建立");
    await expect(page.getByTestId("embedded-chat").getByTestId("composer")).toHaveValue("");
    await page.getByTestId("embedded-chat").getByTestId("composer").fill("乙主控草稿");
    const before = await page.evaluate(() => window.piApp!.getState());
    expect(before.workflowTabs).toHaveLength(2);
    expect(new Set(before.workflowTabs.map((tab) => tab.controller?.sessionId)).size).toBe(2);
    await page
      .getByTestId("workflow-tabs")
      .getByRole("button", { name: "甲流程", exact: true })
      .click();
    await expect(page.getByTestId("embedded-chat").getByTestId("composer")).toHaveValue(
      "甲主控草稿",
    );
    await page.getByTestId("embedded-chat-toggle").click();
    await expect(page.getByTestId("embedded-chat-body")).toHaveCount(0);
    await page.getByTestId("embedded-chat-toggle").click();
    await expect(page.getByTestId("embedded-chat").getByTestId("composer")).toHaveValue(
      "甲主控草稿",
    );
    await page.getByTestId("workflow-node").click();
    await page.getByLabel("任务目标").fill("未保存草稿");
    await page
      .getByTestId("workflow-tabs")
      .getByRole("button", { name: "乙流程", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "未保存修改", exact: true })
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await expect(page.getByLabel("任务目标")).toHaveValue("未保存草稿");
    await page
      .getByTestId("workflow-tabs")
      .getByRole("button", { name: "关闭 甲流程", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "未保存修改", exact: true })
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await page
      .getByTestId("recipe-canvas-editor")
      .getByRole("button", { name: "放弃修改" })
      .click();
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.piApp!.getState())).workflowTabs.find(
            (tab) => tab.title === "甲流程",
          )?.selectedElementId,
      )
      .toBe("任务");
    const beforeClose = await page.evaluate(() => window.piApp!.getState());
    await app.close();
    app = await launchDesktop(profile, options);
    page = await app.firstWindow();
    await expect(page.getByTestId("workflow-tabs")).toBeVisible();
    const restored = await page.evaluate(() => window.piApp!.getState());
    expect(restored.workflowTabs).toEqual(beforeClose.workflowTabs);
    await expect(page.getByLabel("任务目标")).toHaveValue("甲流程目标");
    expect(restored.activeView).toBe("canvas");
    await page
      .getByTestId("workflow-tabs")
      .getByRole("button", { name: "乙流程", exact: true })
      .click();
    await expect
      .poll(async () => (await page.evaluate(() => window.piApp!.getState())).selectedSessionId)
      .toBe(before.workflowTabs.find((tab) => tab.title === "乙流程")!.controller!.sessionId);
    await expect(page.getByTestId("recipe-canvas-editor")).toContainText("乙流程");
    await expect(page.getByTestId("embedded-chat").getByTestId("composer")).toHaveValue(
      "乙主控草稿",
    );
    await page.screenshot({ path: test.info().outputPath("重开后的独立标签.png") });
  } finally {
    const page = app.electronApp.windows().find((window) => !window.isClosed());
    const discard = page
      ?.getByTestId("recipe-canvas-editor")
      .getByRole("button", { name: "放弃修改" });
    if (discard && (await discard.isVisible()) && (await discard.isEnabled()))
      await discard.click();
    if (page) await app.close();
  }
});

test("主控失效降级可重建，同一会话绑两个标签被拒（S4-1①③）", async () => {
  const home = await makeWorkspace("workflow-degrade-home");
  const project = await makeWorkspace("workflow-degrade-project");
  const profile = await makeUserDataDir();
  await mkdir(join(home, "工作流"), { recursive: true });
  await writeFile(
    join(home, "工作流", "丙流程.md"),
    `---\n${JSON.stringify({ 版本: 2, 名字: "丙流程", 参数: [], 节点: [{ 名字: "任务", 部门: "工程", 目标: "丙流程目标", 验收: "检查", 人工确认: false, depends_on: [] }] })}\n---\n`,
  );
  const app = await launchDesktop(profile, {
    initialWorkspaces: [project],
    testMode: "background",
    scrubProviderEnv: true,
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: "1" },
  });
  try {
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-canvas").click();
    await page.getByTestId("canvas-recipe-row").filter({ hasText: "丙流程" }).click();
    await page.getByTestId("canvas-open-master-session").click();
    await expect(page.getByTestId("canvas-open-master-session")).toContainText("已建立");
    const bound = await page.evaluate(
      () =>
        window.piApp!.getState().then((state) => {
          const controller = state.workflowTabs.find((tab) => tab.recipeName === "丙流程")
            ?.controller;
          if (!controller) throw new Error("主控未绑定");
          return controller;
        }),
    );

    // ① 唯一性：把同一 controller 会话再绑给第二个标签的整表写入被拒，表保持原样。
    const dupWrite = await page.evaluate(async (controller) => {
      const state = await window.piApp!.getState();
      const second = {
        ...state.workflowTabs[0]!,
        id: "tab-dup",
        title: "重复绑定",
        controller,
      };
      const next = await window.piApp!.setWorkflowTabs({
        workflowTabs: [...state.workflowTabs, second],
        activeWorkflowTabId: state.activeWorkflowTabId,
      });
      return { lastError: next.lastError ?? "", tabCount: next.workflowTabs.length };
    }, bound);
    expect(dupWrite.lastError).toContain("already bound");
    expect(dupWrite.tabCount).toBe(1);

    // ③ 失效降级（确定性）：整表写入无 controller 的标签，模拟对账剥离后的表；
    // setWorkflowTabs 不改视图，画布仍挂载，此时「建立主控会话」必须立即恢复可用并可重建。
    // （写入成功与否直接查状态：回执的 lastError 会带上一步拒绝留下的会话级粘性错误，属既有口径。）
    const rebuildButton = page.getByTestId("canvas-open-master-session");
    await page.evaluate(async () => {
      const state = await window.piApp!.getState();
      const next = state.workflowTabs.map((tab) => ({ ...tab, controller: undefined }));
      await window.piApp!.setWorkflowTabs({
        workflowTabs: next,
        activeWorkflowTabId: state.activeWorkflowTabId,
      });
    });
    await expect
      .poll(async () =>
        (await page.evaluate(() => window.piApp!.getState())).workflowTabs.find(
          (tab) => tab.recipeName === "丙流程",
        )?.controller,
      )
      .toBeUndefined();
    await expect(rebuildButton).toBeEnabled();
    await expect(rebuildButton).toContainText("建立主控会话");
    await rebuildButton.click();
    await expect(rebuildButton).toContainText("已建立");
    await expect(page.getByTestId("embedded-chat")).toBeVisible();
    const reboundEarly = await page.evaluate(
      () =>
        window.piApp!.getState().then(
          (state) =>
            state.workflowTabs.find((tab) => tab.recipeName === "丙流程")?.controller?.sessionId,
        ),
    );
    expect(reboundEarly).toBeTruthy();
    expect(reboundEarly).not.toBe(bound.sessionId);

    // ③ 归档旅程：archiveSession 归档主控（既有全局行为：归档后切到 threads 视图），
    // 回画布后对账已解绑 controller，按钮同样恢复可用。
    const reboundController = await page.evaluate(async () => {
      const state = await window.piApp!.getState();
      const controller = state.workflowTabs.find((tab) => tab.recipeName === "丙流程")
        ?.controller;
      if (!controller) throw new Error("重建后主控未绑定");
      await window.piApp!.archiveSession(controller);
      return controller;
    });
    await expect
      .poll(async () =>
        (await page.evaluate(() => window.piApp!.getState())).workflowTabs.find(
          (tab) => tab.recipeName === "丙流程",
        )?.controller,
      )
      .toBeUndefined();
    await page.getByTestId("sidebar-canvas").click();
    await expect(rebuildButton).toBeEnabled();
    await expect(rebuildButton).toContainText("建立主控会话");
    await page.screenshot({ path: test.info().outputPath("失效后重建主控.png") });
  } finally {
    await app.close();
  }
});
