import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  launchPackagedDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSession,
} from "../helpers/electron-app";

const execFileAsync = promisify(execFile);
// 隔离文件夹具：用真实内核建立计划、控制、卡与执行映射；会话内容明确为模拟记录，不运行模型或工人进程。
const fixtureScript = `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [dist, project, owner, otherOwner] = process.argv.slice(2);
const load = (name) => import(pathToFileURL(join(dist, name)).href);
const plan = await load("workflow/plan.js");
const driver = await load("workflow/driver.js");
const control = await load("workflow/control.js");
const cards = await load("cards/index.js");
const created = await plan.createTemporaryPlan({ 项目根: project, 显示名: "工作台定稿", 来源会话: owner, 请求ID: "workspace-ui", 已注册部门: ["审查部", "研发部"], 步骤: [
 { 标题: "评审方案", 部门: "审查部", 要求: "核对界面", 人工门: true },
 { 标题: "实现页面", 部门: "研发部", 要求: "实现约定的布局" },
 { 标题: "等待确认后交付", 部门: "研发部", 要求: "整理交付", 依赖: ["s1"] },
 { 标题: "整理已有资料", 部门: "研发部", 要求: "整理资料" }
], 当刻: "2026-10-18 10:00" });
const execution = plan.resolvePlanExecution({ 项目根: project, 计划ID: created.计划ID, 启动请求ID: "run", 定义版本: 1, 来源会话: owner });
await driver.startWorkflow(execution.配方, {}, { cardsDir: execution.卡目录, workspaceDir: execution.工作区, ownerSessionId: owner });
const identity = plan.readPlanInstanceIdentity(execution.工作区, execution.配方名);
plan.recordPlanStart(execution.关联路径, { 计划ID: created.计划ID, 定义版本: 1, 启动请求ID: "run", 实例: identity.实例, 配方名: execution.配方名, 工作区: execution.工作区, 卡目录: execution.卡目录, 控制清单: execution.控制清单, owner会话: owner, 受理时刻: "2026-10-18 10:01" });
const options = { cardsDir: execution.卡目录, workspaceDir: execution.工作区, ownerSessionId: owner };
for (const step of [1, 2, 4]) {
 const minister = "minister-" + step;
 await control.bindMinister(execution.配方, options, "s" + step, minister);
 const goal = step === 2 ? "实现工作流和部门看板的页面布局，保留会话入口与任务详情。\\n" + "完整要求：检查卡片、来源、工人连接、确认流程和多种窗口宽度。".repeat(24) + "长任务末尾标记" : "任务" + step;
 const [ref] = await control.addNodeCards(execution.配方, options, { 实例: identity.实例, 节点: "s" + step, 轮次: 1, 部长会话: minister }, [{ goal, acceptance: "核对结果" }]);
 const no = cards.parseCardRef(ref);
 let card = cards.loadCard(execution.卡目录, no);
 card = cards.changeCardStatus(card, { 操作者: card.frontmatter.owner ?? minister, to: "in_progress", 时间: "2026-10-18 10:02" });
 if (step !== 2) { card = cards.changeCardStatus(card, { 操作者: card.frontmatter.owner ?? minister, to: "delivered", 时间: "2026-10-18 10:03" }); await control.endDecomposition(execution.配方, options, { 实例: identity.实例, 节点: "s" + step, 轮次: 1, 部长会话: minister }); }
 const ministersDir = join(execution.工作区, "部长会话", identity.实例);
 mkdirSync(ministersDir, { recursive: true });
 writeFileSync(join(ministersDir, "20261018_" + minister + ".jsonl"), JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "模拟部长记录：" + step + "，已核对任务分工。" }] } }) + "\\n");
 const execId = "worker-" + step;
 const mappingDir = join(project, ".pao", "执行映射");
 const sessionDir = join(project, ".pao", "worker会话");
 mkdirSync(mappingDir, { recursive: true }); mkdirSync(sessionDir, { recursive: true });
 writeFileSync(join(mappingDir, execId + ".jsonl"), JSON.stringify({ 执行标识: execId, 项目根: project, 卡路径: card.path, 尝试: card.frontmatter.attempt, 状态: step === 2 ? "运行中" : "成功", 时间: "2026-10-18T02:04:00Z" }) + "\\n");
 writeFileSync(join(sessionDir, "20261018_" + execId + ".jsonl"), JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "模拟工人记录：" + step + "，保留真实会话文件读取路径。" }] } }) + "\\n");
}
await plan.createTemporaryPlan({ 项目根: project, 显示名: "另一主控的独立计划", 来源会话: otherOwner, 请求ID: "other-plan", 已注册部门: ["研发部"], 步骤: [{ 标题: "独立任务", 部门: "研发部", 要求: "不混入第一主控" }] });
console.log(JSON.stringify({ instance: identity.实例, planId: created.计划ID }));
`;

test("定稿工作台：主控分组、四列部门与真实会话读取、返回和旧计划入口", async ({}, testInfo) => {
  test.setTimeout(150_000);
  const userDataDir = await makeUserDataDir();
  const project = await makeWorkspace("department-workspace");
  const home = await makeWorkspace("department-home");
  await mkdir(join(home, "部门"), { recursive: true });
  await writeFile(join(userDataDir, "ui-state.json"), JSON.stringify({ language: "zh" }));
  const launch = process.env.PI_APP_TEST_RELEASE_DIR ? launchPackagedDesktop : launchDesktop;
  const app = await launch(userDataDir, {
    initialWorkspaces: [project],
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: "1" },
    scrubProviderEnv: true,
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 900 });
    await createNamedThread(page, "第一主控");
    const first = (await getDesktopState(page)).selectedSessionId;
    await createNamedThread(page, "第二主控");
    const second = (await getDesktopState(page)).selectedSessionId;
    const script = join(home, "make-workspace-fixture.mjs");
    await writeFile(script, fixtureScript);
    await execFileAsync(
      process.execPath,
      [
        script,
        join(__dirname, "../../node_modules/@earendil-works/pi-coding-agent/dist/pao"),
        project,
        first,
        second,
      ],
      { windowsHide: true, env: { ...process.env, PAO_HOME: home } },
    );
    await page
      .getByTestId("task-status")
      .getByRole("button", { name: "刷新", exact: true })
      .click();
    await expect(page.getByTestId("task-status-todos")).toContainText("独立任务");
    await expect(page.getByTestId("task-status-todos")).not.toContainText("评审方案");
    await selectSession(page, "第一主控");
    await expect(page.getByTestId("task-status-todos")).toContainText("评审方案");
    await expect(page.getByTestId("task-status-todos")).not.toContainText("独立任务");
    await expect(page.getByTestId("task-status-department").filter({ visible: true })).toHaveCount(
      3,
    );
    await page.screenshot({ path: testInfo.outputPath("右侧常驻.png"), animations: "disabled" });
    await selectSession(page, "第二主控");
    await expect(page.getByTestId("task-status-todos")).toContainText("独立任务");
    await expect(page.getByTestId("task-status-department")).toHaveCount(0);
    await page.getByTestId("task-status-open-workflow").click();
    await expect(page.getByTestId("sidebar-plans")).toHaveCount(0);
    await expect(page.getByTestId("workflow-cards-title")).toContainText("另一主控的独立计划");
    await page.getByTestId(`workflow-owner-${first}`).click();
    await expect(page.getByTestId("workflow-cards-title")).toContainText("工作台定稿");
    await expect(page.getByTestId("workflow-cards-steps").locator(":scope > li")).toHaveCount(4);
    await expect(page.getByTestId("workflow-cards-steps")).not.toContainText("独立任务");
    await page.getByTestId("workflow-cards-step-s2").locator(".workflow-cards__step-main").click();
    await expect(page.getByTestId("workflow-cards-inspector")).toContainText("实现页面");
    // 点主控分组会激活该主控会话（画布既有行为），状态区随之切到第一主控。
    await expect(page.getByTestId("task-status-todos")).toContainText("评审方案");
    await expect(page.getByTestId("task-status-todos")).not.toContainText("独立任务");
    await page.getByTestId("sidebar-threads").click();
    await page.getByTestId("task-status-step-s2").click();
    await expect(page.getByTestId("workflow-cards-step-s2")).toHaveAttribute(
      "data-selected",
      "true",
    );
    await page.getByTestId("task-status-department").filter({ hasText: "审查部" }).click();
    const departmentExecution = page.getByTestId("department-execution-panel");
    await expect(departmentExecution).toBeVisible();
    await expect(departmentExecution).toContainText("工作流部门 · 只读详情");
    await expect(departmentExecution.getByRole("heading", { level: 1 })).toHaveText("审查部");
    await expect(departmentExecution).toContainText("当前步骤评审方案");
    await expect(departmentExecution).toContainText("来源主对话：第一主控");
    await expect(departmentExecution).toContainText("所属工作流");
    await expect(departmentExecution).toContainText(
      "需要调整、重试、取消或审批时，请回来源主对话说明意图。",
    );
    await page.getByTestId("toggle-side-panel").click();
    await expect(page.getByTestId("workbench")).toBeHidden();
    await page.getByTestId("task-status-open-board").click();
    await expect(page.locator(".department-board__column")).toHaveCount(4);
    for (const state of ["ready", "running", "blocked", "done"])
      await expect(
        page
          .locator(`.department-board__column[data-state="${state}"]`)
          .getByTestId("department-card"),
      ).toHaveCount(1);
    const compactWorker = page
      .locator('.department-board__column[data-state="running"]')
      .getByTestId("department-worker");
    await expect(compactWorker).not.toContainText("长任务末尾标记");
    expect(
      await compactWorker.locator(".department-board__worker-goal").getAttribute("title"),
    ).toContain("长任务末尾标记");
    expect((await compactWorker.boundingBox())!.height).toBeLessThan(85);
    const review = page
      .locator('.department-board__column[data-state="blocked"]')
      .getByTestId("department-card");
    await expect(review).toContainText("审查部");
    await expect(review).toContainText("评审方案");
    await review.click();
    await expect(page.getByTestId("department-detail")).toContainText("等待人工确认");
    await page.getByTestId("department-minister").click();
    await expect(page.getByTestId("workboard-session")).toContainText("模拟部长记录：1");
    await page.getByRole("button", { name: "返回部门卡", exact: true }).click();
    await page.getByTestId("department-worker").click();
    await expect(page.getByTestId("workboard-session")).toContainText("模拟工人记录：1");
    await page.getByRole("button", { name: "返回部门卡", exact: true }).click();
    await page.getByRole("button", { name: "查看所属工作流 ↗", exact: true }).click();
    await expect(page.getByTestId("workflow-cards-title")).toContainText("工作台定稿");
    await expect(page.getByTestId("workflow-cards-step-s1")).toHaveAttribute(
      "data-selected",
      "true",
    );
    await page.getByRole("button", { name: "计划历史", exact: true }).click();
    await expect(page.getByTestId("plans-list")).toBeVisible();
    await page.getByRole("button", { name: "步骤工作台", exact: true }).click();
    await expect(page.getByTestId("workflow-cards-title")).toContainText("工作台定稿");
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      if (win.isMinimized()) win.restore();
      win.showInactive();
    });
    await page.screenshot({ path: testInfo.outputPath("工作流.png"), animations: "disabled" });
    await page.getByTestId("task-status-open-board").click();
    await expect(page.locator(".department-board__column")).toHaveCount(4);
    await expect(page.getByTestId("department-card").first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("部门看板.png"), animations: "disabled" });
    await page
      .locator('.department-board__column[data-state="running"]')
      .getByTestId("department-card")
      .click();
    await expect(page.getByTestId("department-detail")).toBeVisible();
    const fullGoal = await page
      .getByTestId("department-worker")
      .locator(".department-board__worker-goal")
      .getAttribute("title");
    expect(fullGoal).toContain("长任务末尾标记");
    await expect(page.getByTestId("department-worker")).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath("部门详情.png"), animations: "disabled" });
    await page.evaluate(() => window.piApp.setActiveView("plans"));
    await expect(page.getByTestId("workflow-cards-title")).toBeVisible();
    await expect.poll(async () => (await getDesktopState(page)).activeView).toBe("canvas");
    await page.setViewportSize({ width: 1100, height: 600 });
    const workflowScroller = page.locator(".workflow-cards__main");
    await workflowScroller.evaluate((element) => {
      element.scrollTop = 0;
    });
    await workflowScroller.hover();
    await page.mouse.wheel(0, 650);
    await expect
      .poll(() => workflowScroller.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
  } finally {
    await app.close();
  }
});
