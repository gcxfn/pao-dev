/**
 * 卡看板（真实 Electron，隔离夹具，无模型请求）。
 *
 * 夹具用内核构建产物的真实建卡 API（createCard / changeCardStatus / appendReceipt）在临时
 * PAO_HOME + 两个临时项目里写合法卡：五列各一张、另一项目一张、一张他项目卡、一张坏卡，
 * 并写项目清单、部门注册表与一条执行映射。断言 getKanban 真实渲染五列、搜索与 project/dept
 * 筛选、卡详情（正文/验收/输入/依赖/回执/执行记录）、改卡文件后刷新换列、坏卡显式进 issues，
 * 以及 KanbanPage 的「任务卡 / 部门与待处理」两个入口同源（失败卡的部门可定位待处理项）。
 * 并断言活性桥在无真实 worker 登记时显式提示「无活性信号」，进行中/失败卡只在详情生成主控指令
 * （取消/终止，textarea 可复制、不改卡状态），已交付不提供入口。
 *
 * 边界：不连 provider、不派发 worker、不调用模型；夹具的状态变化只证明看板按卡面现读刷新，
 * 不证明执行、验收或交付成立。
 *
 * S9 键名随迁（2026-10-08）：卡状态值/失败分型按定名表迁英文——data-status＝英文现读值、
 * 列标题保持中文标签；夹具建卡/改状态用新值域，addNodeCards 卡规格改 goal/acceptance 键。
 * 本文件真实加载内核 dist（收口门面）：期望已按新契约改写，内核包构建产物落位后重跑——收口门跑。
 */
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test, type Locator } from "@playwright/test";
import { launchDesktop, makeUserDataDir, makeWorkspace } from "../helpers/electron-app";

const execFileAsync = promisify(execFile);

/** 桌面 app 直接依赖的内核构建产物；与运行时看板桥加载的是同一份 dist。 */
const KERNEL_PAO_DIST = resolve(
  __dirname,
  "../../node_modules/@earendil-works/pi-coding-agent/dist/pao",
);

/**
 * 夹具脚本（写进临时 PAO_HOME 后由 node 直接跑）：只 import 内核已构建 JS，
 * 不 import 源码、不装依赖、不请求模型；seed 造现场，advance 改一张卡的状态文件。
 */
const FIXTURE_SCRIPT = `
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const LF = String.fromCharCode(10);
const [kernelDist, paoHome, projectA, projectB, command] = process.argv.slice(2);
const load = (relative) => import(pathToFileURL(join(kernelDist, relative)).href);
const cards = await load("cards/index.js");
const { formatProjectList } = await load("dept/projects.js");
const { formatRegistry } = await load("dept/registry.js");

const 项目根甲 = realpathSync(projectA);
const 项目根乙 = realpathSync(projectB);
const 卡目录甲 = join(项目根甲, ".pao", "卡");
const 卡目录乙 = join(项目根乙, ".pao", "卡");
const 主控 = "夹具主控";

async function 建卡(卡目录, 目标, 部门, 验收, 正文, 输入, 约束, dependsOn) {
  return cards.createCard(
    卡目录,
    {
      目标,
      部门,
      验收,
      输入,
      约束,
      depends_on: dependsOn,
      创建: "2026-10-05 09:00",
      状态: "unclaimed",
    },
    { 模板正文: 正文 },
  );
}

function 找卡(卡目录, 目标) {
  const found = cards.listCards(卡目录).find((card) => card.frontmatter.goal === 目标);
  if (!found) throw new Error("夹具找不到卡：" + 目标);
  return found;
}

function 认领(card) {
  return cards.changeCardStatus(card, { 操作者: 主控, to: "in_progress", 时间: "2026-10-05 09:30" });
}

function seed() {
  mkdirSync(join(paoHome, "部门", "工程", "待验证"), { recursive: true });
  mkdirSync(join(paoHome, "部门", "工程", "教训"), { recursive: true });
  mkdirSync(join(paoHome, "部门", "评审"), { recursive: true });
  mkdirSync(卡目录甲, { recursive: true });
  mkdirSync(卡目录乙, { recursive: true });

  writeFileSync(
    join(paoHome, "项目清单.md"),
    formatProjectList([
      { 项目名: "隔离项目甲", 项目根: 项目根甲, 首次服务: "2026-10-05 09:00", 最近服务: "2026-10-05 09:00" },
      { 项目名: "隔离项目乙", 项目根: 项目根乙, 首次服务: "2026-10-05 09:00", 最近服务: "2026-10-05 09:00" },
    ]),
  );
  writeFileSync(
    join(paoHome, "部门", "注册表.md"),
    formatRegistry([
      { 名字: "工程", 标签: ["实现"], 库路径: join("部门", "工程"), 建部日期: "2026-10-05" },
      { 名字: "评审", 标签: ["复核"], 库路径: join("部门", "评审"), 建部日期: "2026-10-05" },
    ]),
  );
  writeFileSync(join(paoHome, "部门", "工程", "待验证", "夹具候选.md"), "# 夹具候选" + LF);
  writeFileSync(join(paoHome, "部门", "工程", "教训", "子索引.md"), "- ⚠️ 夹具警示行" + LF);

  return (async () => {
    // 五列各一张卡（卡号 1-5）＋ 另一个项目一张卡；正文走 createCard 的真实模板正文参数。
    await 建卡(卡目录甲, "甲卡待认领", "工程", "验收：夹具检查点甲", "甲卡正文：等待认领。");
    const 乙 = 认领(await 建卡(卡目录甲, "乙卡进行中", "工程", "验收：夹具检查点乙", "乙卡正文：正在执行。"));
    const 丙 = 认领(
      await 建卡(
        卡目录甲,
        "丙卡已交付",
        "评审",
        "验收：夹具检查点丙",
        "丙卡正文：已交付说明。",
        ["输入：夹具设计稿"],
        "约束：只读夹具",
        ["卡0001"],
      ),
    );
    // 产物先落盘再交回执：appendReceipt 会核产物路径真实存在（M2-09 三格校验）。
    const 产物目录 = join(项目根甲, "产物");
    mkdirSync(产物目录, { recursive: true });
    const 产物文件 = join(产物目录, "夹具产物.txt");
    writeFileSync(产物文件, "夹具产物内容" + LF);
    cards.appendReceipt(丙, {
      尝试号: 1,
      时间: "2026-10-05 10:00",
      结果: "完成",
      摘要: "丙卡回执摘要：夹具产物已就绪",
      证据: ["证据：夹具产物"],
      产物路径: [产物文件],
      用量: { input: 1000, output: 200, turns: 3 },
    });
    cards.changeCardStatus(丙, { 操作者: 主控, to: "delivered", 时间: "2026-10-05 10:10" });

    const 丁 = 认领(await 建卡(卡目录甲, "丁卡失败", "工程", "验收：夹具检查点丁", "丁卡正文：失败说明。"));
    cards.appendReceipt(丁, {
      尝试号: 1,
      时间: "2026-10-05 10:20",
      结果: "未完成",
      摘要: "丁卡回执摘要：缺夹具输入",
      证据: ["证据：夹具缺少输入 X"],
      失败类型: "missing_input",
    });
    cards.changeCardStatus(丁, {
      操作者: 主控,
      to: "failed",
      失败类型: "missing_input",
      时间: "2026-10-05 10:25",
      依据: "夹具缺输入",
    });

    const 戊 = await 建卡(卡目录甲, "戊卡取消", "评审", "验收：夹具检查点戊", "戊卡正文：已取消。");
    cards.changeCardStatus(戊, { 操作者: "用户", to: "canceled", 时间: "2026-10-05 10:30" });

    await 建卡(卡目录乙, "己卡他项目", "市场", "验收：夹具检查点己", "己卡正文：另一个项目。");

    // 坏卡：frontmatter 缺必需字段，读取时必须显式进 issues，不当空列表。
    writeFileSync(
      join(卡目录甲, "卡9001-坏卡.md"),
      ["---", "goal: 坏卡", "---", "坏卡正文", ""].join(LF),
    );

    // 执行映射：丙卡的真实执行锚点（路径按 realpath 写，读取端才认得出）。
    const 执行标识 = "exec-kanban-丙";
    const 映射目录 = join(项目根甲, ".pao", "执行映射");
    mkdirSync(映射目录, { recursive: true });
    writeFileSync(
      join(映射目录, 执行标识 + ".jsonl"),
      JSON.stringify({
        执行标识,
        项目根: 项目根甲,
        卡路径: realpathSync(找卡(卡目录甲, "丙卡已交付").path),
        尝试: 1,
        状态: "已结束",
        时间: "2026-10-05 10:05",
      }) + LF,
    );
    const 会话目录 = join(项目根甲, ".pao", "worker会话");
    mkdirSync(会话目录, { recursive: true });
    writeFileSync(join(会话目录, "worker_" + 执行标识 + ".jsonl"), "");
  })();
}

async function advance() {
  const card = 找卡(卡目录甲, "甲卡待认领");
  cards.changeCardStatus(card, { 操作者: 主控, to: "in_progress", 时间: "2026-10-05 11:00" });
}

if (command === "seed") {
  await seed();
} else if (command === "advance") {
  await advance();
} else {
  throw new Error("未知夹具命令：" + command);
}
process.stdout.write("ok:" + command + LF);
`;

async function runFixture(
  scriptPath: string,
  home: string,
  projectA: string,
  projectB: string,
  command: "advance" | "seed",
): Promise<void> {
  const { stdout } = await execFileAsync(process.execPath, [
    scriptPath,
    KERNEL_PAO_DIST,
    home,
    projectA,
    projectB,
    command,
  ]);
  expect(stdout).toContain(`ok:${command}`);
}

/** 隔离现场：临时 PAO_HOME＋两个临时项目；app 只登记项目甲，项目乙仅出现在项目清单里。 */
async function launchKanbanFixture() {
  const home = await makeWorkspace("kanban-home");
  const projectA = await makeWorkspace("kanban-project-a");
  const projectB = await makeWorkspace("kanban-project-b");
  const fixtureScript = join(home, "make-kanban-fixture.mjs");
  await writeFile(fixtureScript, FIXTURE_SCRIPT, "utf8");
  await runFixture(fixtureScript, home, projectA, projectB, "seed");

  // 中文界面：预置语言，断言详情「当前」与工作看板的中文词条（默认 en 会渲染英文）。
  const userDataDir = await makeUserDataDir();
  await writeFile(join(userDataDir, "ui-state.json"), JSON.stringify({ language: "zh" }), "utf8");

  const app = await launchDesktop(userDataDir, {
    initialWorkspaces: [projectA],
    testMode: "background",
    scrubProviderEnv: true,
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: "1" },
  });
  return { app, fixtureScript, home, projectA, projectB };
}

test("看板五列、搜索筛选、详情回执、刷新读盘、坏卡显异常", async () => {
  const { app, fixtureScript, home, projectA, projectB } = await launchKanbanFixture();
  try {
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-workboard").click();
    await expect(page.getByTestId("kanban-view")).toBeVisible();
    await expect(page.getByTestId("kanban-columns")).toBeVisible();

    const columnOf = (status: string) =>
      page.locator('[data-testid="kanban-column"][data-status="' + status + '"]');

    // 五列固定顺序：data-status＝卡状态英文现读值，列标题保持中文标签。
    const statuses: [string, string][] = [
      ["unclaimed", "待认领"],
      ["in_progress", "进行中"],
      ["delivered", "已交付"],
      ["failed", "失败"],
      ["canceled", "取消"],
    ];
    await expect(page.getByTestId("kanban-column")).toHaveCount(statuses.length);
    for (const [index, [status, label]] of statuses.entries()) {
      const column = columnOf(status);
      await expect(column).toHaveCount(1);
      await expect(page.getByTestId("kanban-column").nth(index)).toHaveAttribute(
        "data-status",
        status,
      );
      await expect(column.getByRole("heading", { level: 2 })).toHaveText(label);
    }

    // 六张合法卡按状态落列（坏卡不算卡）。
    await expect(columnOf("unclaimed").getByTestId("kanban-card")).toHaveCount(2);
    await expect(columnOf("in_progress").getByTestId("kanban-card")).toHaveCount(1);
    await expect(columnOf("delivered").getByTestId("kanban-card")).toHaveCount(1);
    await expect(columnOf("failed").getByTestId("kanban-card")).toHaveCount(1);
    await expect(columnOf("canceled").getByTestId("kanban-card")).toHaveCount(1);
    await expect(page.getByTestId("kanban-card")).toHaveCount(6);

    // 坏卡进 issues 横幅，不静默丢。
    await expect(page.getByTestId("kanban-unavailable")).toHaveCount(0);
    const issues = page.getByTestId("kanban-issues");
    await expect(issues).toBeVisible();
    await expect(issues).toContainText("卡9001-坏卡.md");
    await expect(issues).toContainText("缺必需字段");

    // 搜索只作用本地副本：命中一张，其余列空。
    await page.getByTestId("kanban-search").fill("丙卡");
    await expect(page.getByTestId("kanban-card")).toHaveCount(1);
    await expect(page.getByTestId("kanban-card")).toContainText("丙卡已交付");
    await expect(columnOf("unclaimed").getByTestId("kanban-card")).toHaveCount(0);
    await page.getByTestId("kanban-search").fill("");
    await expect(page.getByTestId("kanban-card")).toHaveCount(6);

    // dept 筛选：工程 3 张（甲/乙/丁）。
    await page.getByTestId("kanban-department").selectOption("工程");
    await expect(page.getByTestId("kanban-card")).toHaveCount(3);
    await page.getByTestId("kanban-department").selectOption("");
    await expect(page.getByTestId("kanban-card")).toHaveCount(6);

    // project 筛选：项目甲 5 张，项目乙 1 张（清单里登记的项目都会被读到）。
    await page.getByTestId("kanban-project").selectOption(projectA);
    await expect(page.getByTestId("kanban-card")).toHaveCount(5);
    await page.getByTestId("kanban-project").selectOption(projectB);
    await expect(page.getByTestId("kanban-card")).toHaveCount(1);
    await expect(page.getByTestId("kanban-card")).toContainText("己卡他项目");
    await page.getByTestId("kanban-project").selectOption("");
    await expect(page.getByTestId("kanban-card")).toHaveCount(6);

    // 详情：正文/验收/输入/依赖/约束/回执/执行记录全部来自卡与执行映射现读。
    await columnOf("delivered").getByTestId("kanban-card").filter({ hasText: "丙卡已交付" }).click();
    const detail = page.getByTestId("kanban-detail");
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("丙卡正文：已交付说明。");
    await expect(detail).toContainText("验收：夹具检查点丙");
    await expect(detail).toContainText("输入：夹具设计稿");
    await expect(detail).toContainText("约束：只读夹具");
    await expect(detail).toContainText("卡0001");
    await expect(detail.getByTestId("kanban-detail-receipts")).toContainText(
      "丙卡回执摘要：夹具产物已就绪",
    );
    await expect(detail.getByTestId("kanban-detail-receipts")).toContainText("证据：夹具产物");
    await expect(detail.getByTestId("kanban-detail-executions")).toContainText("exec-kanban-丙");
    await expect(detail.getByTestId("kanban-detail-executions")).toContainText("当前");
    await page.screenshot({ path: test.info().outputPath("看板详情.png") });

    // 已交付是终态：详情不提供取消/终止入口（指令也只生成不含执行）。
    await expect(detail.getByTestId("kanban-prepare-cancel")).toHaveCount(0);
    await expect(detail.getByTestId("kanban-prepare-terminate")).toHaveCount(0);

    // 关详情后改卡文件再刷新：甲卡从待认领换到进行中，不是本地改状态。
    await detail.getByTestId("kanban-detail-close").click();
    await expect(page.getByTestId("kanban-detail")).toHaveCount(0);

    // 进行中卡：夹具里没有任何真实 worker 登记，活性桥必须显式说「无活性信号」，
    // 不拿卡的创建/更新时间冒充正常；这里不注入模拟活性。
    const liveCard = () =>
      columnOf("in_progress").getByTestId("kanban-card").filter({ hasText: "乙卡进行中" });
    await expect(liveCard().getByTestId("kanban-activity-unknown")).toContainText("无活性信号");
    await liveCard().click();
    const liveDetail = page.getByTestId("kanban-detail");
    await expect(liveDetail).toBeVisible();
    await expect(liveDetail.getByTestId("kanban-detail-activity-none")).toContainText("无活性信号");

    // 进行中：详情只生成可复制的主控指令，点按钮不改卡、不发请求。
    await liveDetail.getByTestId("kanban-prepare-cancel").click();
    const command = liveDetail.getByTestId("kanban-command");
    await expect(command).toBeVisible();
    const cancelCommand = await command.inputValue();
    expect(cancelCommand).toContain("pao_change_status");
    expect(cancelCommand).toContain('"new_status":"canceled"');
    expect(cancelCommand).toContain("卡0002");
    expect(cancelCommand).toContain(projectA);
    await liveDetail.getByTestId("kanban-prepare-terminate").click();
    const terminateCommand = await command.inputValue();
    expect(terminateCommand).toContain("pao_terminate_card");
    expect(terminateCommand).toContain("pao_inventory");
    expect(terminateCommand).toContain("卡0002");
    await liveDetail.getByTestId("kanban-detail-close").click();
    await expect(page.getByTestId("kanban-detail")).toHaveCount(0);

    // 失败不是终态（可重试/取消）：详情有取消，没有终止。
    const failedCard = () =>
      columnOf("failed").getByTestId("kanban-card").filter({ hasText: "丁卡失败" });
    await failedCard().click();
    const failedDetail = page.getByTestId("kanban-detail");
    await expect(failedDetail.getByTestId("kanban-prepare-cancel")).toBeVisible();
    await expect(failedDetail.getByTestId("kanban-prepare-terminate")).toHaveCount(0);
    await failedDetail.getByTestId("kanban-prepare-cancel").click();
    const failedCommand = await failedDetail.getByTestId("kanban-command").inputValue();
    expect(failedCommand).toContain("pao_change_status");
    expect(failedCommand).toContain('"new_status":"canceled"');
    expect(failedCommand).toContain("卡0004");
    await failedDetail.getByTestId("kanban-detail-close").click();
    await expect(page.getByTestId("kanban-detail")).toHaveCount(0);

    // 生成指令不改状态：刷新重读盘上卡面，乙/丁仍在原列原状态。
    await page.getByTestId("kanban-refresh").click();
    await expect(liveCard()).toHaveAttribute("data-status", "in_progress");
    await expect(failedCard()).toHaveAttribute("data-status", "failed");
    await expect(columnOf("unclaimed").getByTestId("kanban-card")).toHaveCount(2);
    await expect(page.getByTestId("kanban-card")).toHaveCount(6);
    await runFixture(fixtureScript, home, projectA, projectB, "advance");
    await page.getByTestId("kanban-refresh").click();
    await expect(columnOf("unclaimed").getByTestId("kanban-card")).toHaveCount(1);
    await expect(columnOf("in_progress").getByTestId("kanban-card")).toHaveCount(2);
    await expect(
      columnOf("in_progress").getByTestId("kanban-card").filter({ hasText: "甲卡待认领" }),
    ).toBeVisible();
    await expect(columnOf("unclaimed").getByTestId("kanban-card")).toContainText("己卡他项目");
    await page.screenshot({ path: test.info().outputPath("刷新换列.png") });
  } finally {
    await app.close();
  }
});

test("任务卡与部门／待处理入口同源：失败卡的部门可定位", async () => {
  const { app } = await launchKanbanFixture();
  try {
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-workboard").click();
    await expect(page.getByTestId("kanban-view")).toBeVisible();

    // 任务卡入口：失败卡在失败列，部门取自卡面。
    const failedColumn = page.locator('[data-testid="kanban-column"][data-status="failed"]');
    await expect(failedColumn.getByTestId("kanban-card")).toContainText("丁卡失败");
    await expect(failedColumn.getByTestId("kanban-card")).toHaveAttribute("data-status", "failed");

    // 切到部门与待处理入口：部门积压＋待处理项同源于同一 PAO_HOME。
    await page.getByRole("button", { name: "部门与待处理", exact: true }).click();
    await expect(page.getByTestId("workboard-view")).toBeVisible();
    const deptRow = page.getByTestId("workboard-dept-row").filter({ hasText: "工程" });
    await expect(deptRow).toBeVisible();
    // 口径对齐：计数源是部门知识库「待验证/」的条目数（.md 文件），不是待验证的卡数。
    await expect(deptRow).toContainText("1 条待验证（部门知识）");
    await expect(deptRow).toContainText("教训：1 条警示");

    const pendingRow = page.getByTestId("workboard-pending-row").filter({ hasText: "丁卡失败" });
    await expect(pendingRow).toBeVisible();
    // 行内渲染的是内核待处理文案（UI 中文文案判留），不出现裸键；新值域 missing_input 只决定分支选择。
    await expect(pendingRow).toContainText("缺输入");

    // 点部门行定位：同部门的待处理条目被高亮。
    await deptRow.getByRole("button").click();
    await expect(page.getByTestId("workboard-locate-status")).toContainText(
      "已定位下方 1 条该部门的待处理条目。",
    );
    await expect(pendingRow).toHaveClass(/workboard-row--located/);
    await page.screenshot({ path: test.info().outputPath("部门与待处理.png") });

    // 切回任务卡：两个入口可来回切换，看板仍是五列。
    await page.getByRole("button", { name: "任务卡", exact: true }).click();
    await expect(page.getByTestId("kanban-view")).toBeVisible();
    await expect(page.getByTestId("kanban-column")).toHaveCount(5);
  } finally {
    await app.close();
  }
});

test("积压待处理行打开真实卡详情：回执用量如实、产物路径经主进程复核导航", async () => {
  const { app } = await launchKanbanFixture();
  try {
    // 拦截 shell.showItemInFolder：导航必须经主进程复核通道（revealWorkspaceFile），
    // 断言被打开的路径；不开真实资源管理器。
    await app.electronApp.evaluate(({ shell }) => {
      const globals = globalThis as typeof globalThis & { __paoKanbanRevealed?: string[] };
      globals.__paoKanbanRevealed = [];
      shell.showItemInFolder = (revealedPath: string) => {
        globals.__paoKanbanRevealed?.push(revealedPath);
        return Promise.resolve("");
      };
    });
    const revealed = () =>
      app.electronApp.evaluate(
        () => (globalThis as typeof globalThis & { __paoKanbanRevealed?: string[] }).__paoKanbanRevealed ?? [],
      );

    const page = await app.firstWindow();
    await page.getByTestId("sidebar-workboard").click();
    await page.getByRole("button", { name: "部门与待处理", exact: true }).click();
    await expect(page.getByTestId("workboard-view")).toBeVisible();

    // 待处理行主体是失败卡：打开真实卡详情（切回任务卡视图并选中该卡），
    // 不再只做滚动定位；全部尝试回执照常展示。
    const pendingRow = page.getByTestId("workboard-pending-row").filter({ hasText: "丁卡失败" });
    await expect(pendingRow).toBeVisible();
    await pendingRow.getByTestId("workboard-open-card").click();
    await expect(page.getByTestId("kanban-view")).toBeVisible();
    const detail = page.getByTestId("kanban-detail");
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("丁卡正文：失败说明。");
    await expect(detail.getByTestId("kanban-detail-receipts")).toContainText(
      "丁卡回执摘要：缺夹具输入",
    );
    await expect(detail.getByTestId("kanban-detail-receipts")).toContainText("missing_input");
    // 回执没有自报用量：如实「未知」，不填 0 冒充。
    await expect(detail.getByTestId("kanban-receipt-usage")).toContainText("用量未知");
    await page.screenshot({ path: test.info().outputPath("积压行打开卡详情.png") });

    // 有自报用量的回执：键值原样展示，不筛字段不换算。
    await detail.getByTestId("kanban-detail-close").click();
    await page
      .locator('[data-testid="kanban-column"][data-status="delivered"]')
      .getByTestId("kanban-card")
      .filter({ hasText: "丙卡已交付" })
      .click();
    const doneDetail = page.getByTestId("kanban-detail");
    const usage = doneDetail.getByTestId("kanban-receipt-usage");
    await expect(usage).toContainText("input 1000");
    await expect(usage).toContainText("output 200");
    await expect(usage).toContainText("turns 3");

    // 产物路径导航：真实产物 → 主进程复核（存在性＋越界检查）后交系统文件管理器。
    const receipts = doneDetail.getByTestId("kanban-detail-receipts");
    await receipts
      .locator('[data-testid="kanban-evidence-line"]')
      .filter({ hasText: "夹具产物.txt" })
      .getByTestId("kanban-reveal-path")
      .click();
    await expect
      .poll(async () => (await revealed()).join("\n"))
      .toContain("夹具产物.txt");
    await expect(receipts.getByTestId("kanban-reveal-error")).toHaveCount(0);

    // 自由文本证据不是路径：点击显式报错，不静默成功、不猜路径。
    await receipts
      .locator('[data-testid="kanban-evidence-line"]')
      .filter({ hasText: "证据：夹具产物" })
      .getByTestId("kanban-reveal-path")
      .click();
    await expect(receipts.getByTestId("kanban-reveal-error")).toBeVisible();
  } finally {
    await app.close();
  }
});

/** 多卡节点夹具：一个工作流节点上落两张卡（S7 验收「多卡节点可查看所有卡，不只首卡」）。 */
const WORKFLOW_FIXTURE_SCRIPT = `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [kernelDist, paoHome, project, workspaceDir, cardsDir] = process.argv.slice(2);
const load = (relative) => import(pathToFileURL(join(kernelDist, relative)).href);
const { parseRecipe } = await load("workflow/recipe.js");
const { startControl, bindMinister, readControl, addNodeCards } = await load("workflow/control.js");
const { formatProjectList } = await load("dept/projects.js");

mkdirSync(join(paoHome, "部门", "工程"), { recursive: true });
mkdirSync(join(paoHome, "工作流"), { recursive: true });
mkdirSync(cardsDir, { recursive: true });
writeFileSync(
  join(paoHome, "项目清单.md"),
  formatProjectList([
    { 项目名: "多卡节点项目", 项目根: project, 首次服务: "2026-10-05 09:00", 最近服务: "2026-10-05 09:00" },
  ]),
);
const recipePath = join(paoHome, "工作流", "多卡节点.md");
writeFileSync(
  recipePath,
  "---\\n" +
    JSON.stringify({
      版本: 2,
      名字: "多卡节点",
      参数: [],
      节点: [{ 名字: "拆解甲", 部门: "工程", 目标: "多卡节点拆解", 验收: "两卡都在", depends_on: [] }],
    }) +
    "\\n---\\n多卡节点配方。\\n",
);
const recipe = parseRecipe(readFileSync(recipePath, "utf8"), recipePath);
const options = { cardsDir, workspaceDir, ownerSessionId: "fixture-owner" };
await startControl(recipe, {}, options);
await bindMinister(recipe, options, "拆解甲", "fixture-minister");
const flow = readControl(recipe, options);
const node = flow.节点.find((item) => item.名字 === "拆解甲");
await addNodeCards(
  recipe,
  options,
  { 实例: flow.实例, 节点: "拆解甲", 轮次: node.轮次, 部长会话: "fixture-minister" },
  [
    { goal: "多卡第一张", acceptance: "第一张就位" },
    { goal: "多卡第二张", acceptance: "第二张就位" },
  ],
);
process.stdout.write("workflow-fixture-ok\\n");
`;

test("工作流节点多卡全量查看：节点卡映射全列出，点任一张开真实详情", async () => {
  const home = await makeWorkspace("kanban-flow-home");
  const project = await makeWorkspace("kanban-flow-project");
  const workspaceDir = join(project, ".pao", "任务甲");
  const cardsDir = join(workspaceDir, "卡");
  const fixtureScript = join(home, "make-kanban-flow-fixture.mjs");
  await writeFile(fixtureScript, WORKFLOW_FIXTURE_SCRIPT, "utf8");
  const { stdout } = await execFileAsync(process.execPath, [
    fixtureScript,
    KERNEL_PAO_DIST,
    home,
    project,
    workspaceDir,
    cardsDir,
  ]);
  expect(stdout).toContain("workflow-fixture-ok");

  const userDataDir = await makeUserDataDir();
  await writeFile(join(userDataDir, "ui-state.json"), JSON.stringify({ language: "zh" }), "utf8");
  const app = await launchDesktop(userDataDir, {
    initialWorkspaces: [project],
    testMode: "background",
    scrubProviderEnv: true,
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: "1" },
  });
  try {
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-workboard").click();
    await expect(page.getByTestId("kanban-view")).toBeVisible();

    // 节点→卡号映射全量列出：两张卡都在，不是只显示首卡。
    const flows = page.getByTestId("kanban-workflows");
    await expect(flows).toBeVisible();
    await expect(flows.getByTestId("kanban-workflow")).toHaveCount(1);
    await expect(flows).toContainText("多卡节点");
    await expect(flows).toContainText("拆解甲");
    const chips = flows.getByTestId("kanban-workflow-card");
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(0)).toContainText("卡0001");
    await expect(chips.nth(1)).toContainText("卡0002");

    // 点第二张卡：打开真实卡详情（含全部尝试回执区，空态如实展示）。
    await chips.nth(1).click();
    const detail = page.getByTestId("kanban-detail");
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("多卡第二张");
    await expect(detail).toContainText("第二张就位");
    await page.screenshot({ path: test.info().outputPath("多卡节点.png") });
  } finally {
    await app.close();
  }
});

// ---- S7-B 操作侧：卡写操作桥（只代用户取消）＋拖放/多选/批量条/右键＋租约真实值 ----

test("混合权限批量取消逐卡准确：一张成功一张失败带原因，操作后重读磁盘换列", async () => {
  const { app } = await launchKanbanFixture();
  try {
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-workboard").click();
    await expect(page.getByTestId("kanban-view")).toBeVisible();
    const columnOf = (status: string) =>
      page.locator('[data-testid="kanban-column"][data-status="' + status + '"]');

    // Ctrl+点击多选：进行中的乙卡（用户可取消）＋已交付的丙卡（终态，内核会拒）。
    const live = columnOf("in_progress").getByTestId("kanban-card").filter({ hasText: "乙卡进行中" });
    const done = columnOf("delivered").getByTestId("kanban-card").filter({ hasText: "丙卡已交付" });
    await live.click({ modifiers: ["Control"] });
    await done.click({ modifiers: ["Control"] });
    await expect(page.getByTestId("kanban-batch-bar")).toBeVisible();
    await expect(page.getByTestId("kanban-batch-count")).toContainText("2 张卡");

    // 批量取消：逐卡由内核状态机判权，结果逐项显示——一张成功不整批报成功。
    await page.getByTestId("kanban-batch-cancel").click();
    const results = page.getByTestId("kanban-op-results");
    await expect(results).toBeVisible();
    const okRow = results.locator('[data-testid="kanban-op-result"][data-ok="true"]');
    const failRow = results.locator('[data-testid="kanban-op-result"][data-ok="false"]');
    await expect(okRow).toHaveCount(1);
    await expect(okRow).toContainText("乙卡进行中");
    await expect(okRow).toContainText("成功");
    await expect(failRow).toHaveCount(1);
    await expect(failRow).toContainText("丙卡已交付");
    await expect(failRow).toContainText("失败");
    await expect(failRow).toContainText("不允许的状态迁移");

    // 操作后重读权威数据：乙卡换到取消列，丙卡仍在已交付列（批量条清空）。
    await expect(page.getByTestId("kanban-batch-bar")).toHaveCount(0);
    await expect(
      columnOf("canceled").getByTestId("kanban-card").filter({ hasText: "乙卡进行中" }),
    ).toBeVisible();
    await expect(
      columnOf("delivered").getByTestId("kanban-card").filter({ hasText: "丙卡已交付" }),
    ).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("混合权限批量取消.png") });
  } finally {
    await app.close();
  }
});

test("拖放反馈：拖到已交付列被拒点名验收链，拖到取消列真实执行", async () => {
  const { app } = await launchKanbanFixture();
  try {
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-workboard").click();
    await expect(page.getByTestId("kanban-view")).toBeVisible();
    const columnOf = (status: string) =>
      page.locator('[data-testid="kanban-column"][data-status="' + status + '"]');

    // 源卡按列内文本定位：data-path 值是 Windows 反斜杠路径，getAttribute 读得到，但
    // 同一字符串进 CSS 属性选择器会被按转义序列处理（反斜杠被吞），30 秒永不匹配——
    // 不在选择器里拼路径（drop 裁决只认 dragstart 写入 dataTransfer 的卡路径，与定位无关）。
    const cardOf = (status: string, goal: string) =>
      columnOf(status).getByTestId("kanban-card").filter({ hasText: goal });
    const dragCard = async (source: Locator, targetStatus: string) => {
      const target = columnOf(targetStatus);
      const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
      await source.dispatchEvent("dragstart", { dataTransfer });
      await target.dispatchEvent("dragenter", { dataTransfer });
      await target.dispatchEvent("drop", { dataTransfer });
      await source.dispatchEvent("dragend", { dataTransfer });
    };

    // 乙卡（进行中）拖到已交付列：完成必须走验收链——拒绝是可见回执，卡不换列。
    await dragCard(cardOf("in_progress", "乙卡进行中"), "delivered");
    const results = page.getByTestId("kanban-op-results");
    const failRow = results.locator('[data-testid="kanban-op-result"][data-ok="false"]');
    await expect(failRow).toContainText("完成必须走验收链");
    await page.getByTestId("kanban-refresh").click();
    await expect(
      columnOf("in_progress").getByTestId("kanban-card").filter({ hasText: "乙卡进行中" }),
    ).toBeVisible();

    // 甲卡（待认领）拖到取消列：用户取消是内核合法动作，真实写盘并重读换列。
    await dragCard(cardOf("unclaimed", "甲卡待认领"), "canceled");
    await expect(
      results.locator('[data-testid="kanban-op-result"][data-ok="true"]'),
    ).toContainText("甲卡待认领");
    await expect(
      columnOf("canceled").getByTestId("kanban-card").filter({ hasText: "甲卡待认领" }),
    ).toBeVisible();
    await expect(columnOf("unclaimed").getByTestId("kanban-card")).toHaveCount(1);
    await page.screenshot({ path: test.info().outputPath("拖放反馈.png") });
  } finally {
    await app.close();
  }
});

/** 读卡元素 data-path（夹具卡的路径随临时目录变化，不能写死）。 */
async function liveCardPath(page: import("@playwright/test").Page, goal: string): Promise<string> {
  const card = page.getByTestId("kanban-card").filter({ hasText: goal }).first();
  const path = await card.getAttribute("data-path");
  if (!path) throw new Error(`夹具卡没有 data-path：${goal}`);
  return path;
}

test("右键菜单：入口动作同受合法操作约束，取消直接执行并重读换列", async () => {
  const { app } = await launchKanbanFixture();
  try {
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-workboard").click();
    await expect(page.getByTestId("kanban-view")).toBeVisible();
    const columnOf = (status: string) =>
      page.locator('[data-testid="kanban-column"][data-status="' + status + '"]');

    // 右键待认领的甲卡：菜单含打开详情／取消（执行）／复制取消指令，不含终止（非进行中）。
    const waiting = columnOf("unclaimed").getByTestId("kanban-card").filter({ hasText: "甲卡待认领" });
    await waiting.click({ button: "right" });
    const menu = page.getByTestId("kanban-card-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId("kanban-menu-cancel")).toBeVisible();
    await expect(menu.getByTestId("kanban-menu-copy-cancel")).toBeVisible();
    await expect(menu.getByTestId("kanban-menu-copy-terminate")).toHaveCount(0);

    // 取消直接执行：逐卡过桥，真实写盘并重读换列（不是本地乐观态）。
    await menu.getByTestId("kanban-menu-cancel").click();
    await expect(
      columnOf("canceled").getByTestId("kanban-card").filter({ hasText: "甲卡待认领" }),
    ).toBeVisible();
    await expect(
      columnOf("unclaimed").getByTestId("kanban-card").filter({ hasText: "甲卡待认领" }),
    ).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("右键菜单取消.png") });
  } finally {
    await app.close();
  }
});

/**
 * 旧代接管不覆盖（S7 条5）：向主进程 owners 登记表注入同卡两代活性行（旧代后到），
 * 看板必须按认领代数取最大——旧代行（已接管、已到期）后到也不得覆盖新代呈现；
 * 只剩被接管行时如实亮「已被接管；原 worker 输出仅留档」。注入只进本测试主进程内存。
 */
test("租约真实值：旧代行不覆盖新代呈现，被接管如实亮出", async () => {
  const { app, projectA } = await launchKanbanFixture();
  try {
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-workboard").click();
    await expect(page.getByTestId("kanban-view")).toBeVisible();
    const live = () =>
      page
        .locator('[data-testid="kanban-column"][data-status="in_progress"]')
        .getByTestId("kanban-card")
        .filter({ hasText: "乙卡进行中" });
    const cardPath = await liveCardPath(page, "乙卡进行中");

    const registerOwner = (rows: unknown[]) =>
      app.electronApp.evaluate(
        async (_electron, payload) => {
          // electronApp.evaluate 把函数体在主进程按 CDP 经典脚本 eval，动态 import 没有
          // importModuleDynamically 回调（必抛「A dynamic import callback was not
          // specified」）；改走 require(esm)：Electron 37＝Node 22，内核产物无顶层 await，
          // 同步加载且与 app 模块图命中同一实例。夹具 PAO_DISABLE_BUILTIN_EXTENSION=1，
          // 内置 pao 扩展未注册过 owner，登记表只含本测试注入的行。
          const { join } = process.getBuiltinModule("node:path");
          const { createRequire } = process.getBuiltinModule("node:module");
          const mod = createRequire(join(payload.kernelDist, "index.js"))("./desktop/index.js") as {
            registerDesktopOwner: (
              pi: unknown,
              options: {
                getWorkerActivity: () => unknown[];
                getSilenceMinutes: () => number;
              },
            ) => void;
          };
          const handlers: Record<string, (event: unknown, ctx: unknown) => void> = {};
          mod.registerDesktopOwner(
            { on: (event: string, handler: (event: unknown, ctx: unknown) => void) => { handlers[event] = handler; } },
            { getWorkerActivity: () => payload.rows, getSilenceMinutes: () => 30 },
          );
          handlers["session_start"](undefined, {
            sessionManager: { getSessionId: () => payload.sessionId },
            cwd: payload.project,
          });
        },
        {
          kernelDist: KERNEL_PAO_DIST,
          project: projectA,
          sessionId: "e2e-lease-owner",
          rows,
        },
      );

    // 租约时刻相对 now 取值：写死日期会随时间流逝从「未到期」腐成「已到期」，断言必红。
    const iso = (hoursFromNow: number) =>
      new Date(Date.now() + hoursFromNow * 3_600_000).toISOString();
    const leaseExpiry = iso(24);
    const row = (over: Record<string, unknown>) => ({
      // 机器键按 S9 新协议（worker 登记形 card_path/run_id/attempt/running）；
      // 行级中文键（登记时间/最近输出时间/租约四字段）冻结不变，owners.ts 原样带出。
      run_id: "exec-lease",
      card_path: cardPath,
      attempt: 1,
      登记时间: iso(-30),
      最近输出时间: iso(0),
      running: true,
      静默分钟: 30,
      ...over,
    });
    // 新代（代数 2，租约未到期）在前，旧代（代数 1，已接管、已到期）在后＝最坏到达序。
    await registerOwner([
      row({
        run_id: "exec-gen2",
        认领时间: iso(-26),
        租约到期: leaseExpiry,
        认领代数: 2,
        被接管: false,
      }),
      row({
        run_id: "exec-gen1",
        认领时间: iso(-30),
        租约到期: iso(-29),
        认领代数: 1,
        被接管: true,
      }),
    ]);
    await page.getByTestId("kanban-refresh").click();
    const lease = live().getByTestId("kanban-lease");
    await expect(lease).toHaveAttribute("data-lease-state", "active");
    await expect(lease).toContainText(`租约至 ${leaseExpiry.slice(0, 10)}`);

    // 只剩被接管行（接管发生过、新 worker 未登记）：如实亮「已被接管」，不冒充正常。
    await registerOwner([
      row({
        run_id: "exec-gen1-only",
        认领时间: iso(-30),
        租约到期: iso(-29),
        认领代数: 1,
        被接管: true,
      }),
    ]);
    await page.getByTestId("kanban-refresh").click();
    await expect(live().getByTestId("kanban-lease")).toHaveAttribute("data-lease-state", "taken-over");
    await expect(live().getByTestId("kanban-lease")).toContainText("已被接管");
    await page.screenshot({ path: test.info().outputPath("租约真实值.png") });
  } finally {
    await app.close();
  }
});
