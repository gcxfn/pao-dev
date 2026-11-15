/**
 * 隔离真实 Electron：bug5（主控面板切走切回消失）修复机制真机复验（S4-1④，W-41/W-101 销账）。
 * 既有行为钉子——canvas-page.tsx 的重激活 effect（挂载即比对 activeTab.controller 与全局
 * chatTarget，不符则重激活）在位；本 spec 用真实往返钉住「切普通会话/跨项目后切回，面板恢复」。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchDesktop, makeUserDataDir, makeWorkspace } from "../helpers/electron-app";

async function writeRecipe(home: string, name: string): Promise<void> {
  await mkdir(join(home, "工作流"), { recursive: true });
  await writeFile(
    join(home, "工作流", `${name}.md`),
    `---\n${JSON.stringify({ 版本: 2, 名字: name, 参数: [], 节点: [{ 名字: "任务", 部门: "工程", 目标: `${name}目标`, 验收: "检查", 人工确认: false, depends_on: [] }] })}\n---\n`,
  );
}

test("bug5 复验：切普通会话再切回画布，主控面板恢复且会话回到标签主控", async () => {
  const home = await makeWorkspace("workflow-bug5-home");
  const project = await makeWorkspace("workflow-bug5-project");
  const profile = await makeUserDataDir();
  await writeRecipe(home, "甲流程");
  const app = await launchDesktop(profile, {
    initialWorkspaces: [project],
    testMode: "background",
    scrubProviderEnv: true,
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: "1" },
  });
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

    // 切到 threads 建一个普通会话（全局选择离开主控），再从 sidebar 回画布。
    await page.getByRole("button", { name: "Threads", exact: true }).click();
    await expect(page.getByTestId("embedded-chat")).toHaveCount(0);
    const workspaceId = await page.evaluate(() =>
      window.piApp!.getState().then((state) => state.selectedWorkspaceId),
    );
    await page.evaluate(async (wsId) => {
      await window.piApp!.createSession({ workspaceId: wsId, title: "普通会话" });
    }, workspaceId);
    await expect
      .poll(async () => (await page.evaluate(() => window.piApp!.getState())).selectedSessionId)
      .not.toBe(master);

    await page.getByTestId("sidebar-canvas").click();
    // bug5 机制：重激活 effect 把全局选择拉回标签主控，面板恢复。
    await expect(page.getByTestId("embedded-chat")).toBeVisible();
    await expect
      .poll(async () => (await page.evaluate(() => window.piApp!.getState())).selectedSessionId)
      .toBe(master);
    await page.screenshot({ path: test.info().outputPath("普通会话往返-面板恢复.png") });
  } finally {
    await app.close();
  }
});

test("bug5 复验：跨项目往返后，标签主控面板恢复且两会话不串", async () => {
  const home = await makeWorkspace("workflow-bug5-x-home");
  const projectA = await makeWorkspace("workflow-bug5-a");
  const projectB = await makeWorkspace("workflow-bug5-b");
  const profile = await makeUserDataDir();
  await writeRecipe(home, "甲流程");
  const app = await launchDesktop(profile, {
    initialWorkspaces: [projectA, projectB],
    testMode: "background",
    scrubProviderEnv: true,
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: "1" },
  });
  try {
    const page = await app.firstWindow();
    const workspaces = await page.evaluate(() =>
      window.piApp!.getState().then((state) =>
        state.workspaces.map((workspace) => ({ id: workspace.id, path: workspace.path })),
      ),
    );
    const wsA = workspaces.find((workspace) => workspace.path === projectA)!;
    const wsB = workspaces.find((workspace) => workspace.path === projectB)!;

    // 两个初始工作区谁先选中不确定：显式选中 A，保证甲流程标签建在 A。
    await page.evaluate(async (workspaceId) => {
      await window.piApp!.selectWorkspace(workspaceId);
    }, wsA.id);
    // 项目 A：开标签建主控。
    await page.getByTestId("sidebar-canvas").click();
    await page.getByTestId("canvas-recipe-row").filter({ hasText: "甲流程" }).click();
    await page.getByTestId("canvas-open-master-session").click();
    await expect(page.getByTestId("embedded-chat")).toBeVisible();
    const masterA = await page.evaluate(() =>
      window.piApp!.getState().then((state) => state.selectedSessionId),
    );

    // 切到项目 B：建普通会话＋B 自己的标签主控。
    await page.getByRole("button", { name: "Threads", exact: true }).click();
    await page.evaluate(async (wsId) => {
      await window.piApp!.createSession({ workspaceId: wsId, title: "B 会话" });
    }, wsB.id);
    await page.getByTestId("sidebar-canvas").click();
    await expect
      .poll(async () => (await page.evaluate(() => window.piApp!.getState())).selectedWorkspaceId)
      .toBe(wsB.id);
    // B 的画布不含 A 的标签（跨项目不串）。
    await expect(
      page.getByTestId("workflow-tabs").getByRole("button", { name: /^甲流程( ●)?$/ }),
    ).toHaveCount(0);
    await page.getByTestId("canvas-recipe-row").filter({ hasText: "甲流程" }).click();
    await page.getByTestId("canvas-open-master-session").click();
    await expect(page.getByTestId("embedded-chat")).toBeVisible();
    const masterB = await page.evaluate(() =>
      window.piApp!.getState().then((state) => state.selectedSessionId),
    );
    expect(masterB).not.toBe(masterA);

    // 回项目 A 的主控：切回画布——S4-2 入口已绑定时自动切回绑定标签并进单工作流视图，
    // 面板恢复为 A 主控（重激活机制仍在：切换标签即激活它的 controller）。
    await page.getByRole("button", { name: "Threads", exact: true }).click();
    await page.evaluate(async (target) => {
      await window.piApp!.selectSession(target);
    }, { workspaceId: wsA.id, sessionId: masterA });
    await page.getByTestId("sidebar-canvas").click();
    await expect
      .poll(async () => (await page.evaluate(() => window.piApp!.getState())).selectedWorkspaceId)
      .toBe(wsA.id);
    await expect(page.getByTestId("embedded-chat")).toBeVisible();
    await expect(page.getByTestId("workflow-tabs")).toBeHidden();
    await expect(page.getByTestId("recipe-canvas-editor")).toContainText("甲流程");
    await expect
      .poll(async () => (await page.evaluate(() => window.piApp!.getState())).selectedSessionId)
      .toBe(masterA);
    await page.screenshot({ path: test.info().outputPath("跨项目往返-面板恢复.png") });
  } finally {
    await app.close();
  }
});
