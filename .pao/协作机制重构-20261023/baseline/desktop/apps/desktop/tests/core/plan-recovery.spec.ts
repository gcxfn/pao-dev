/**
 * 重开与强杀后的现场一致性（通用工作台计划阶段 7 第 2 项）。
 *
 * 场景：临时计划已经启动，第 1 步有一张「进行中」的卡，盘上有两条意见关联。
 * 关掉应用、再强杀一次应用，然后用同一份用户数据目录重开，检查：
 *   计划定义、启动关联、实例身份、卡与意见都读得回；
 *   在途卡没有被静默重派（卡文件数量、状态、尝试次数都不变）。
 *
 * 夹具由内核构建产物生成（`dist/pao`），不是手抄的形状。
 */
import { execFileSync, execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { launchDesktop, makeUserDataDir, makeWorkspace } from "../helpers/electron-app";

const execFileAsync = promisify(execFile);

const FIXTURE_SCRIPT = `
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [kernelDist, project] = process.argv.slice(2);
const load = (relative) => import(pathToFileURL(join(kernelDist, relative)).href);

const plan = await load("workflow/plan.js");
const driver = await load("workflow/driver.js");
const control = await load("workflow/control.js");
const cards = await load("cards/index.js");
const feedback = await load("workflow/plan-feedback.js");

const created = await plan.createTemporaryPlan({
  项目根: project,
  显示名: "恢复现场样例",
  来源会话: "sess-recovery-1",
  请求ID: "req-recovery-1",
  已注册部门: ["策划部", "写作部"],
  步骤: [
    { 标题: "创作设定", 部门: "策划部", 要求: "把世界观与人物写清楚", 人工门: true },
    { 标题: "写初稿", 部门: "写作部", 要求: "按设定写初稿" },
    { 标题: "定稿", 部门: "写作部", 要求: "定稿并归档", 依赖: ["s2"] },
  ],
  当刻: "2026-10-15 09:00",
});

const execution = plan.resolvePlanExecution({
  项目根: project,
  计划ID: created.计划ID,
  启动请求ID: "start-recovery-1",
  定义版本: 1,
  来源会话: "sess-recovery-1",
});
await driver.startWorkflow(execution.配方, {}, {
  cardsDir: execution.卡目录,
  workspaceDir: execution.工作区,
  ownerSessionId: "sess-recovery-1",
});
const identity = plan.readPlanInstanceIdentity(execution.工作区, execution.配方名);
if (!identity) throw new Error("实例身份读不出来");
plan.recordPlanStart(execution.关联路径, {
  计划ID: created.计划ID,
  定义版本: 1,
  启动请求ID: "start-recovery-1",
  实例: identity.实例,
  配方名: execution.配方名,
  工作区: execution.工作区,
  卡目录: execution.卡目录,
  控制清单: execution.控制清单,
  owner会话: "sess-recovery-1",
  受理时刻: "2026-10-15 09:01",
});

const options = {
  cardsDir: execution.卡目录,
  workspaceDir: execution.工作区,
  ownerSessionId: "sess-recovery-1",
};
const id = { 实例: identity.实例, 节点: "s1", 轮次: 1, 部长会话: "sess-recovery-1" };
await control.bindMinister(execution.配方, options, "s1", "sess-recovery-1");
const [first] = await control.addNodeCards(execution.配方, options, id, [
  { goal: "写设定", acceptance: "设定可读" },
]);
cards.changeCardStatus(cards.loadCard(execution.卡目录, cards.parseCardRef(first)), {
  操作者: "sess-recovery-1",
  to: "in_progress",
  时间: "2026-10-15 09:05",
});

// 两条意见关联：一条步骤意见（带投递请求 ID，因此是「待送达」），一条文件意见（「已记录」）。
await feedback.recordPlanFeedback({
  项目根: project,
  计划ID: created.计划ID,
  期望定义版本: 1,
  目标: { 类型: "步骤", 步骤ID: "s1" },
  正文: "设定里要把时间线写清楚",
  投递请求ID: "fb-step-1",
  来源会话: "sess-recovery-1",
  当刻: "2026-10-15 09:06",
});
await feedback.recordPlanFeedback({
  项目根: project,
  计划ID: created.计划ID,
  期望定义版本: 1,
  目标: { 类型: "文件", 步骤ID: "s1", 轮次: 1, 路径: "创作成果/设定.md", 版本依据: "第 1 轮" },
  正文: "设定文件名要带版本号",
  来源会话: "sess-recovery-1",
  当刻: "2026-10-15 09:07",
});

console.log(JSON.stringify({
  计划ID: created.计划ID,
  项目根: project,
  工作区: execution.工作区,
  卡目录: execution.卡目录,
  控制清单: execution.控制清单,
  配方名: execution.配方名,
  实例: identity.实例,
  第一张卡: first,
}));
`;

const REGISTRY = `# 部门注册表

<!-- 唯一真相:名字/能力标签/库路径/建部日期 -->

| 名字 | 能力标签 | 库路径 | 建部日期 |
| --- | --- | --- | --- |
| 策划部 | 策划 | 部门/策划部/知识库 | 2026-10-15 |
| 写作部 | 写作 | 部门/写作部/知识库 | 2026-10-15 |
`;

interface RecoveryFixture {
  计划ID: string;
  项目根: string;
  工作区: string;
  卡目录: string;
  控制清单: string;
  配方名: string;
  实例: string;
  第一张卡: string;
}

/** 盘上现场快照：卡文件清单＋在途卡的全文（用来证明重开没有静默重派）。 */
function snapshotCards(cardDir: string): { files: string[]; inFlight: string } {
  const files = readdirSync(cardDir)
    .filter((name) => name.endsWith(".md"))
    .sort();
  const inFlight = files.map((name) => readFileSync(join(cardDir, name), "utf8")).join("\n=====\n");
  return { files, inFlight };
}

async function makeFixture() {
  const home = await makeWorkspace("recovery-home");
  const project = await makeWorkspace("recovery-project");
  await mkdir(join(home, "部门"), { recursive: true });
  await writeFile(join(home, "部门", "注册表.md"), REGISTRY, "utf8");

  const kernelDist = join(__dirname, "../../node_modules/@earendil-works/pi-coding-agent/dist/pao");
  const fixtureScript = join(home, "make-recovery-fixture.mjs");
  await writeFile(fixtureScript, FIXTURE_SCRIPT, "utf8");
  const { stdout } = await execFileAsync(process.execPath, [fixtureScript, kernelDist, project], {
    windowsHide: true,
  });
  const fixture = JSON.parse(stdout.trim().split("\n").at(-1)!) as RecoveryFixture;

  const userDataDir = await makeUserDataDir();
  await writeFile(join(userDataDir, "ui-state.json"), JSON.stringify({ language: "zh" }), "utf8");
  return { home, project, userDataDir, fixture };
}

function launch(home: string, project: string, userDataDir: string) {
  return launchDesktop(userDataDir, {
    initialWorkspaces: [project],
    testMode: "background",
    scrubProviderEnv: true,
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: "1" },
  });
}

/** 重开之后，界面必须还认得这份现场。 */
async function assertWorkbenchStillKnows(
  page: Awaited<ReturnType<Awaited<ReturnType<typeof launch>>["firstWindow"]>>,
) {
  await page.getByTestId("task-status-open-workflow").click();
  await expect(page.getByTestId("workflow-cards-title")).toContainText("恢复现场样例");
  await expect(page.getByTestId("workflow-cards-progress")).toContainText("0 / 3");
  // s1 的卡还在 in_progress，但内核控制正本同时写着挂起原因「等待部长本轮拆解结束」
  // （夹具绑了部长会话却没调 endDecomposition，所以拆解没结束）。挂起说明在场的步骤就是停着的，
  // 报成「执行中」会把卡住的活说成还在跑 → 界面的真实状态是「等部长」（计划 §7.1 第 3 条）。
  await expect(page.getByTestId("workflow-cards-step-s1")).toHaveAttribute(
    "data-state",
    "waitLead",
  );
  // 意见关联也要读得回：步骤意见与文件意见都在。
  await page.getByTestId("workflow-cards-step-s1").click();
  await expect(page.getByTestId("workflow-cards-inspector")).toContainText(
    "设定里要把时间线写清楚",
  );
}

test("只读计划页在真实 Electron 里显示计划、步骤、启动与意见关联（阶段 4 桌面桥）", async () => {
  test.setTimeout(120_000);
  const { home, project, userDataDir, fixture } = await makeFixture();

  const app = await launch(home, project, userDataDir);
  try {
    const page = await app.firstWindow();
    await page.getByTestId("task-status-open-workflow").click();
    await page.getByRole("button", { name: "计划历史", exact: true }).click();
    await expect(page.getByTestId("plans-list")).toBeVisible();
    await page.getByTestId(`plan-item-${fixture.计划ID}`).click();
    await expect(page.getByTestId("plan-detail-name")).toContainText("恢复现场样例");
    // 三个步骤、一次启动关联、两条意见关联都来自磁盘。
    await expect(page.getByTestId("plan-steps")).toContainText("创作设定");
    await expect(page.getByTestId("plan-steps")).toContainText("写初稿");
    await expect(page.getByTestId("plan-steps")).toContainText("定稿");
    await expect(page.getByTestId("plan-starts")).toContainText(fixture.实例);
    await expect(page.getByTestId("plan-feedback")).toContainText("设定里要把时间线写清楚");
    await expect(page.getByTestId("plan-feedback")).toContainText("设定文件名要带版本号");
  } finally {
    await app.close();
  }
});

test("重开应用后计划、实例、卡与意见都还在，在途卡没有被静默重派", async () => {
  test.setTimeout(180_000);
  const { home, project, userDataDir, fixture } = await makeFixture();
  const before = snapshotCards(fixture.卡目录);

  const first = await launch(home, project, userDataDir);
  try {
    const page = await first.firstWindow();
    await assertWorkbenchStillKnows(page);
  } finally {
    await first.close();
  }

  const second = await launch(home, project, userDataDir);
  try {
    const page = await second.firstWindow();
    await assertWorkbenchStillKnows(page);
    // 控制正本还在原处，实例身份没变。
    expect(readFileSync(fixture.控制清单, "utf8")).toContain(fixture.实例);
  } finally {
    await second.close();
  }

  const after = snapshotCards(fixture.卡目录);
  expect(after.files).toEqual(before.files);
  expect(after.inFlight).toEqual(before.inFlight);
});

test("强杀应用后重开，现场仍一致，在途卡没有被静默重派", async () => {
  test.setTimeout(180_000);
  const { home, project, userDataDir, fixture } = await makeFixture();
  const before = snapshotCards(fixture.卡目录);

  const first = await launch(home, project, userDataDir);
  const pid = first.electronApp.process().pid;
  const page = await first.firstWindow();
  await assertWorkbenchStillKnows(page);
  // 真强杀：连同子进程一起结束，不给它优雅收尾的机会。
  execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });

  const second = await launch(home, project, userDataDir);
  try {
    const reopened = await second.firstWindow();
    await assertWorkbenchStillKnows(reopened);
    expect(readFileSync(fixture.控制清单, "utf8")).toContain(fixture.实例);
  } finally {
    await second.close();
  }

  const after = snapshotCards(fixture.卡目录);
  expect(after.files).toEqual(before.files);
  expect(after.inFlight).toEqual(before.inFlight);
});
