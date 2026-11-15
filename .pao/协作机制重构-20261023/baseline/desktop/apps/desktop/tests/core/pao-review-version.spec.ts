import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import {
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  reloadDesktopRenderer,
} from "../helpers/electron-app";

// 模拟旧式静态审核卡；真实 Git、内核状态机、Electron IPC 与页面读取。
// 独立工人的执行证据另由内核 workflow-independent-review 测试覆盖。
const FIXTURE_SCRIPT = `
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [kernel, project] = process.argv.slice(2);
const load = (file) => import(pathToFileURL(join(kernel, file)).href);
const plan = await load("workflow/plan.js");
const control = await load("workflow/control.js");
const cards = await load("cards/index.js");
const git = (...args) => execFileSync("git", args, { cwd: project, windowsHide: true });
writeFileSync(join(project, "source.txt"), "verified source\\n");
git("init", "--quiet");
git("add", "source.txt");
git("-c", "user.name=test", "-c", "user.email=t@t", "commit", "-qm", "baseline");
const created = await plan.createTemporaryPlan({
  项目根: project, 显示名: "审核版本验收", 来源会话: "version-owner",
  请求ID: "review-version", 已注册部门: ["审核部"],
  步骤: [{ 标题: "审核成果", 部门: "审核部", 要求: "核对源码", 只读: true,
    审核: true, 部门标准: "源码一致" }],
});
const execution = plan.resolvePlanExecution({
  项目根: project, 计划ID: created.计划ID, 启动请求ID: "review-version-start",
  定义版本: 1, 来源会话: "version-owner",
});
const options = { cardsDir: execution.卡目录, workspaceDir: execution.工作区,
  ownerSessionId: "version-owner" };
await control.startControl(execution.配方, {}, options);
plan.recordPlanStart(execution.关联路径, {
  计划ID: created.计划ID, 定义版本: 1, 启动请求ID: "review-version-start",
  实例: control.readControl(execution.配方, options).实例, 配方名: execution.配方名,
  工作区: execution.工作区, 卡目录: execution.卡目录, 控制清单: execution.控制清单,
  owner会话: "version-owner", 受理时刻: "2026-10-23 12:00",
});
await control.bindMinister(execution.配方, options, "s1", "version-reviewer");
const identity = { 实例: control.readControl(execution.配方, options).实例,
  节点: "s1", 轮次: 1, 部长会话: "version-reviewer" };
const [ref] = await control.addNodeCards(execution.配方, options, identity,
  [{ goal: "静态审核", acceptance: "核对源码" }]);
const card = () => cards.loadCard(execution.卡目录, cards.parseCardRef(ref));
cards.changeCardStatus(card(), { 操作者: "version-reviewer", to: "in_progress" });
cards.changeCardStatus(card(), { 操作者: "version-reviewer", to: "delivered" });
await control.endDecomposition(execution.配方, options, identity);
await control.decideNode(execution.配方, options, identity,
  { 结果: "pass", 理由: "旧式静态审核夹具，未验证运行", 引用: ["source.txt:1"] });
console.log(JSON.stringify({ name: execution.配方名, path: execution.控制清单 }));
`;

test("真实桌面读取审核版本：完成状态一致，源码变化后不再显示完成", async () => {
  const home = await makeWorkspace("review-version-home");
  const project = await makeWorkspace("review-version-project");
  await mkdir(join(home, "部门"), { recursive: true });
  await writeFile(
    join(home, "部门", "注册表.md"),
    "# 部门注册表\n\n| 名字 | 能力标签 | 库路径 | 建部日期 |\n| --- | --- | --- | --- |\n| 审核部 | 审核 | 部门/审核部/知识库 | 2026-10-23 |\n",
  );
  const script = join(home, "review-version-fixture.mjs");
  await writeFile(script, FIXTURE_SCRIPT);
  const kernel = join(__dirname, "../../node_modules/@earendil-works/pi-coding-agent/dist/pao");
  const { stdout } = await promisify(execFile)(process.execPath, [script, kernel, project], {
    windowsHide: true,
  });
  const fixture = JSON.parse(stdout.trim().split("\n").at(-1)!) as { name: string; path: string };
  const userDataDir = await makeUserDataDir();
  await writeFile(join(userDataDir, "ui-state.json"), JSON.stringify({ language: "zh" }));
  const app = await launchDesktop(userDataDir, {
    initialWorkspaces: [project],
    testMode: "background",
    scrubProviderEnv: true,
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: "1" },
  });
  try {
    const page = await app.firstWindow();
    const state = await getDesktopState(page);
    const workspaceId = state.workspaces.find((entry) => entry.path === project)?.id;
    expect(workspaceId).toBeTruthy();
    const query = () =>
      page.evaluate(
        async ({ workspaceId, fixture }) => {
          return window.piApp!.getWorkflowControl({
            workspaceId: workspaceId!,
            instanceName: fixture.name,
            instancePath: fixture.path,
          });
        },
        { workspaceId, fixture },
      );
    await expect.poll(query).toMatchObject({ state: "ok", control: { status: "已完成" } });
    await page.getByTestId("task-status-open-workflow").click();
    await expect(page.getByTestId("workflow-cards-title")).toContainText("审核版本验收");
    await expect(page.getByTestId("workflow-cards-flow-status")).toContainText("已完成");
    await writeFile(join(project, "source.txt"), "unverified new source\n");
    await expect.poll(query).toMatchObject({
      state: "ok",
      control: { status: "运行中", nodes: [{ hold: expect.stringContaining("审核判定失效") }] },
    });
    await reloadDesktopRenderer(page);
    if (!(await page.getByTestId("workflow-cards-title").isVisible())) {
      await page.getByTestId("task-status-open-workflow").click();
    }
    await expect(page.getByTestId("workflow-cards-title")).toContainText("审核版本验收");
    await expect(page.getByTestId("workflow-cards-flow-status")).not.toContainText("已完成");
  } finally {
    await app.close();
  }
});
