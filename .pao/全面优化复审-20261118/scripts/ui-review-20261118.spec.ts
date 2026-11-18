/**
 * 一次性界面复审截图（2026-11-18）。不是回归测试：只截屏，不断言。
 * 夹具与 2026-11-15 评审相同：看板建卡 + 工作流实例 + 精简记忆。
 * 会话消息用 emitTestSessionEvent 注入（seedTranscriptMessages），不是真实模型回复。
 * 跑法：pnpm --dir <desktopRoot> exec playwright test -c <本目录>/ui-review.config.cjs
 * 输出落到 ../screenshots（UI_REVIEW_OUT 可覆盖）。
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test, type Page } from "../../../desktop/node_modules/@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedTranscriptMessages,
} from "../../../desktop/apps/desktop/tests/helpers/electron-app";

const execFileAsync = promisify(execFile);
const OUT = process.env.UI_REVIEW_OUT ?? resolve(__dirname, "..", "screenshots");
const KERNEL_PAO_DIST = resolve(
  __dirname,
  "../../../desktop/apps/desktop/node_modules/@pao/coding-agent/dist/pao",
);

async function shot(page: Page, name: string): Promise<void> {
  await mkdir(OUT, { recursive: true });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`[shot] ${name}`);
}

async function shotSoft(page: Page, name: string, mark: (msg: string) => void): Promise<void> {
  try {
    await shot(page, name);
  } catch (error) {
    mark(`${name}: ${String(error).slice(0, 160)}`);
  }
}

async function setWindowSize(
  app: Awaited<ReturnType<typeof launchDesktop>>,
  page: Page,
  width: number,
  height: number,
): Promise<void> {
  await app.electronApp.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.setSize(size.width, size.height);
  }, { width, height });
  await page.waitForTimeout(400);
}

async function setView(page: Page, view: string): Promise<void> {
  await page.evaluate(async (v) => {
    await globalThis.window.piApp!.setActiveView(v as never);
  }, view);
  await page.waitForTimeout(500);
}

/** kanban spec 的建卡夹具（同 2026-11-15 版本：五列各一张 + 坏卡 + 项目清单 + 部门注册表）。 */
const KANBAN_FIXTURE = `
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const LF = String.fromCharCode(10);
const [kernelDist, paoHome, projectA] = process.argv.slice(2);
const load = (relative) => import(pathToFileURL(join(kernelDist, relative)).href);
const cards = await load("cards/index.js");
const { formatProjectList } = await load("dept/projects.js");
const { formatRegistry } = await load("dept/registry.js");
const 项目根甲 = realpathSync(projectA);
const 卡目录甲 = join(项目根甲, ".pao", "卡");
const 主控 = "夹具主控";
async function 建卡(目标, 部门, 验收, 正文, 输入, 约束, dependsOn) {
  return cards.createCard(卡目录甲, {
    目标, 部门, 验收, 输入, 约束, depends_on: dependsOn,
    创建: "2026-10-05 09:00", 状态: "unclaimed",
  }, { 模板正文: 正文 });
}
function 找卡(目标) {
  const found = cards.listCards(卡目录甲).find((card) => card.frontmatter.goal === 目标);
  if (!found) throw new Error("夹具找不到卡：" + 目标);
  return found;
}
function 认领(card) {
  return cards.changeCardStatus(card, { 操作者: 主控, to: "in_progress", 时间: "2026-10-05 09:30" });
}
mkdirSync(join(paoHome, "部门", "工程", "待验证"), { recursive: true });
mkdirSync(join(paoHome, "部门", "工程", "教训"), { recursive: true });
mkdirSync(join(paoHome, "部门", "评审"), { recursive: true });
mkdirSync(卡目录甲, { recursive: true });
writeFileSync(join(paoHome, "项目清单.md"), formatProjectList([
  { 项目名: "隔离项目甲", 项目根: 项目根甲, 首次服务: "2026-10-05 09:00", 最近服务: "2026-10-05 09:00" },
]));
writeFileSync(join(paoHome, "部门", "注册表.md"), formatRegistry([
  { 名字: "工程", 标签: ["实现"], 库路径: join("部门", "工程"), 建部日期: "2026-10-05" },
  { 名字: "评审", 标签: ["复核"], 库路径: join("部门", "评审"), 建部日期: "2026-10-05" },
]));
writeFileSync(join(paoHome, "部门", "工程", "待验证", "夹具候选.md"), "# 夹具候选" + LF);
writeFileSync(join(paoHome, "部门", "工程", "教训", "子索引.md"), "- ⚠️ 夹具警示行" + LF);
await 建卡("甲卡待认领", "工程", "验收：夹具检查点甲", "甲卡正文：等待认领。");
const 乙 = 认领(await 建卡("乙卡进行中：给输入框做一个长度校验", "工程", "验收：夹具检查点乙", "乙卡正文：正在执行。"));
const 丙 = 认领(await 建卡("丙卡已交付：整理看板详情分组", "评审", "验收：夹具检查点丙", "丙卡正文：已交付说明。", ["输入：夹具设计稿"], "约束：只读夹具", ["卡0001"]));
const 产物目录 = join(项目根甲, "产物");
mkdirSync(产物目录, { recursive: true });
const 产物文件 = join(产物目录, "夹具产物.txt");
writeFileSync(产物文件, "夹具产物内容" + LF);
cards.appendReceipt(丙, {
  尝试号: 1, 时间: "2026-10-05 10:00", 结果: "完成",
  摘要: "丙卡回执摘要：夹具产物已就绪",
  证据: ["证据：夹具产物"], 产物路径: [产物文件],
  用量: { input: 1000, output: 200, turns: 3 },
});
cards.changeCardStatus(丙, { 操作者: 主控, to: "delivered", 时间: "2026-10-05 10:10" });
const 丁 = 认领(await 建卡("丁卡失败：接入真实供应商失败", "工程", "验收：夹具检查点丁", "丁卡正文：失败说明。"));
cards.appendReceipt(丁, {
  尝试号: 1, 时间: "2026-10-05 10:20", 结果: "未完成",
  摘要: "丁卡回执摘要：缺夹具输入",
  证据: ["证据：夹具缺少输入 X"], 失败类型: "missing_input",
});
cards.changeCardStatus(丁, { 操作者: 主控, to: "failed", 失败类型: "missing_input", 时间: "2026-10-05 10:25", 依据: "夹具缺输入" });
const 戊 = await 建卡("戊卡取消：重复任务取消", "评审", "验收：夹具检查点戊", "戊卡正文：已取消。");
cards.changeCardStatus(戊, { 操作者: "用户", to: "canceled", 时间: "2026-10-05 10:30" });
writeFileSync(join(卡目录甲, "卡9001-坏卡.md"), ["---", "goal: 坏卡", "---", "坏卡正文", ""].join(LF));
const 执行标识 = "exec-kanban-丙";
const 映射目录 = join(项目根甲, ".pao", "执行映射");
mkdirSync(映射目录, { recursive: true });
writeFileSync(join(映射目录, 执行标识 + ".jsonl"), JSON.stringify({
  执行标识, 项目根: 项目根甲, 卡路径: realpathSync(找卡("丙卡已交付：整理看板详情分组").path),
  尝试: 1, 状态: "已结束", 时间: "2026-10-05 10:05",
}) + LF);
const 会话目录 = join(项目根甲, ".pao", "worker会话");
mkdirSync(会话目录, { recursive: true });
writeFileSync(join(会话目录, "worker_" + 执行标识 + ".jsonl"), "");
process.stdout.write("ok\\n");
`;

/** d5 工作流实例夹具：10 步计划，含人工门、并行组、回边、已交付步骤。 */
const WORKFLOW_FIXTURE = `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [kernelDist, project] = process.argv.slice(2);
const load = (relative) => import(pathToFileURL(join(kernelDist, relative)).href);
const plan = await load("workflow/plan.js");
const driver = await load("workflow/driver.js");
const control = await load("workflow/control.js");
const cards = await load("cards/index.js");
const created = await plan.createTemporaryPlan({
  项目根: project,
  显示名: "小说首章",
  来源会话: "sess-d5-1",
  请求ID: "req-d5-1",
  已注册部门: ["策划部", "写作部", "审稿部", "资料部"],
  步骤: [
    { 标题: "讨论计划", 部门: "策划部", 要求: "把方向与章节计划讨论清楚", 人工门: true, 审核: true, 只读: true, 部门标准: "方向可执行、与章节计划一致" },
    { 标题: "写初稿", 部门: "写作部", 要求: "按计划写初稿" },
    { 标题: "润色", 部门: "写作部", 要求: "把初稿的语言打磨一遍", 依赖: ["s2"] },
    { 标题: "审稿", 部门: "审稿部", 要求: "核对人物与情节一致性", 依赖: ["s3"] },
    { 标题: "定稿", 部门: "策划部", 要求: "定稿并归档", 依赖: ["s4"] },
    { 标题: "拟定方向", 部门: "策划部", 要求: "定下资料检索方向", 审核: true, 只读: true, 部门标准: "方向可执行、与章节计划一致", 依赖: ["s2"], 回边: [{ 目标: "s2", 上限: 3, 超限动作: "停滞" }] },
    { 标题: "查资料", 部门: "资料部", 要求: "查背景资料", 依赖: ["s6"], 只读: true },
    { 标题: "查竞品", 部门: "审稿部", 要求: "查同类作品", 依赖: ["s6"], 只读: true },
    { 标题: "写作子项甲", 部门: "写作部", 要求: "甲", 依赖: ["s6"], 只读: true },
    { 标题: "写作子项乙", 部门: "写作部", 要求: "乙", 依赖: ["s6"], 只读: true },
  ],
  当刻: "2026-10-17 10:00",
});
const execution = plan.resolvePlanExecution({
  项目根: project, 计划ID: created.计划ID, 启动请求ID: "start-d5-1", 定义版本: 1, 来源会话: "sess-d5-1",
});
await driver.startWorkflow(execution.配方, {}, {
  cardsDir: execution.卡目录, workspaceDir: execution.工作区, ownerSessionId: "sess-d5-1",
});
const identity = plan.readPlanInstanceIdentity(execution.工作区, execution.配方名);
if (!identity) throw new Error("实例身份读不出来");
plan.recordPlanStart(execution.关联路径, {
  计划ID: created.计划ID, 定义版本: 1, 启动请求ID: "start-d5-1",
  实例: identity.实例, 配方名: execution.配方名, 工作区: execution.工作区,
  卡目录: execution.卡目录, 控制清单: execution.控制清单,
  owner会话: "sess-d5-1", 受理时刻: "2026-10-17 10:01",
});
const options = { cardsDir: execution.卡目录, workspaceDir: execution.工作区, ownerSessionId: "sess-d5-1" };
const identityOf = (节点) => ({ 实例: identity.实例, 节点, 轮次: 1, 部长会话: "sess-d5-1" });
const status = (卡号, to, 时间) =>
  cards.changeCardStatus(cards.loadCard(execution.卡目录, cards.parseCardRef(卡号)), { 操作者: "sess-d5-1", to, 时间 });
await control.bindMinister(execution.配方, options, "s1", "sess-d5-1");
const [first] = await control.addNodeCards(execution.配方, options, identityOf("s1"), [
  { goal: "讨论计划", acceptance: "计划可执行" },
]);
status(first, "in_progress", "2026-10-17 10:05");
status(first, "delivered", "2026-10-17 10:31");
await control.endDecomposition(execution.配方, options, identityOf("s1"));
await control.bindMinister(execution.配方, options, "s2", "sess-d5-1");
const [second] = await control.addNodeCards(execution.配方, options, identityOf("s2"), [
  { goal: "写初稿", acceptance: "初稿可读" },
]);
status(second, "in_progress", "2026-10-17 10:40");
status(second, "delivered", "2026-10-17 10:42");
await control.endDecomposition(execution.配方, options, identityOf("s2"));
await control.bindMinister(execution.配方, options, "s6", "sess-d5-1");
const [sixth] = await control.addNodeCards(execution.配方, options, identityOf("s6"), [
  { goal: "定方向", acceptance: "方向可执行" },
]);
status(sixth, "in_progress", "2026-10-17 10:45");
status(sixth, "delivered", "2026-10-17 10:50");
await control.endDecomposition(execution.配方, options, identityOf("s6"));
await control.decideNode(execution.配方, options, identityOf("s6"), {
  结果: "change", 理由: "方向偏了，先按章节计划重定", 引用: ["创作成果/初稿.md:1"], 失败轴: "card", 目标: "s2",
});
console.log(JSON.stringify({ 计划ID: created.计划ID }));
`;

const REGISTRY = `# 部门注册表

<!-- 唯一真相:名字/能力标签/库路径/建部日期 -->

| 名字 | 能力标签 | 库路径 | 建部日期 |
| --- | --- | --- | --- |
| 策划部 | 策划 | 部门/策划部/知识库 | 2026-10-17 |
| 写作部 | 写作 | 部门/写作部/知识库 | 2026-10-17 |
| 审稿部 | 审稿 | 部门/审稿部/知识库 | 2026-10-17 |
| 资料部 | 资料 | 部门/资料部/知识库 | 2026-10-17 |
| 工程 | 实现 | 部门/工程 | 2026-10-05 |
| 评审 | 复核 | 部门/评审 | 2026-10-05 |
`;

/** memory.spec 精简版：一条 decision（两修订）+ 若干分页条目 + 一条停用教训。 */
const MEMORY_FIXTURE = `
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const [dist, project, home, sessionId] = process.argv.slice(2);
const load = (name) => import(pathToFileURL(join(dist, name)).href);
const { openMemoryStore } = await load("memory/store.js");
const { appendToOpenSegment } = await load("memory/archive.js");
const { registerSource } = await load("memory/sources.js");
const { openMemoryService } = await load("memory/service.js");
const projectId = resolve(project);
const scopeProjectId = process.platform === "win32" ? projectId.toLowerCase() : projectId;
const store = openMemoryStore(home, "readwrite");
function addSource(sourceSessionId, entryId, text, timestamp, eventType = "user") {
  const segment = appendToOpenSegment(store.db, home, sourceSessionId, {
    v: 1, sessionId: sourceSessionId, entryId, entryType: "message", eventType,
    timestamp, capturedAt: timestamp,
    content: [{ type: "text", text }],
  }, timestamp);
  return registerSource(store.db, {
    sessionId: sourceSessionId, entryId, eventType, capturedAt: timestamp,
    segmentId: segment.segmentId, location: segment.segmentId + ":" + segment.lineNo,
  });
}
const src1 = addSource(sessionId, "entry-1", "用户：看板详情字段太多，按基本/预算/记录分组。", "2026-11-10T01:00:00.000Z");
const src2 = addSource(sessionId, "entry-2", "用户：工作流画布节点多时看不清，做了语义缩放。", "2026-11-10T02:00:00.000Z");
const src3 = addSource("desktop-page-operations", "entry-3", "页面操作：保存了项目目标。", "2026-11-11T01:00:00.000Z", "page_operation");
store.close();
const service = openMemoryService({ paoHome: home, mode: "readwrite" });
try {
  const kinds = ["decision", "experience", "lesson"];
  for (let index = 0; index < 12; index += 1) {
    await service.createMemory({
      kind: kinds[index % 3],
      scope: { projectId: scopeProjectId },
      conclusion: "界面优化决定 " + String(index + 1).padStart(2, "0") + "：" + ["看板详情按基本/预算/记录分组展示", "画布节点按缩放级别换渲染密度", "空态统一成图标加说明加动作", "中文行高放宽到一点六倍"][index % 4] + "。",
      rationale: "来自 2026-11-03 界面优化批次。",
      evidenceKind: index % 2 ? "execution" : "user_statement",
      confirmation: index % 3 === 0 ? "confirmed" : "tentative",
      sourceIds: [src1],
      createdBy: index % 2 ? "model" : "user",
      createdAt: "2026-11-1" + (index % 9) + "T0" + (index % 9) + ":00:00.000Z",
    });
  }
  const stopped = await service.createMemory({
    kind: "lesson",
    scope: { projectId: scopeProjectId },
    conclusion: "已停用教训：画布节点不要一次渲染全量详情。",
    evidenceKind: "execution",
    confirmation: "confirmed",
    sourceIds: [src2],
    createdBy: "system",
    createdAt: "2026-11-08T00:00:00.000Z",
  });
  await service.setMemoryUsage({ id: stopped.id, expectedRevision: 1, target: "stopped", source: { sessionId }, createdAt: "2026-11-08T01:00:00.000Z" });
  console.log("ok");
} finally {
  await service.close();
}
`;

test("UI 复审截图全套 2026-11-18", async () => {
  test.setTimeout(900_000);
  const anomalies: string[] = [];
  const mark = (msg: string) => {
    anomalies.push(msg);
    console.log("[anomaly]", msg);
  };

  // ---- 现场：临时 PAO_HOME + 项目（有卡、有工作流实例、有记忆） ----
  const home = await mkdtemp(join(tmpdir(), "pao-uireview-home-"));
  const project = await makeWorkspace("uireview-project");
  await mkdir(join(home, "部门"), { recursive: true });
  await writeFile(join(home, "部门", "注册表.md"), REGISTRY, "utf8");

  const kanbanScript = join(home, "seed-kanban.mjs");
  await writeFile(kanbanScript, KANBAN_FIXTURE, "utf8");
  await execFileAsync(process.execPath, [kanbanScript, KERNEL_PAO_DIST, home, project]);

  const workflowScript = join(home, "seed-workflow.mjs");
  await writeFile(workflowScript, WORKFLOW_FIXTURE, "utf8");
  await execFileAsync(process.execPath, [workflowScript, KERNEL_PAO_DIST, project]);

  const userDataDir = await makeUserDataDir();
  await writeFile(join(userDataDir, "ui-state.json"), JSON.stringify({ language: "zh" }), "utf8");

  const app = await launchDesktop(userDataDir, {
    initialWorkspaces: [project],
    testMode: "background",
    scrubProviderEnv: true,
    envOverrides: {
      PAO_HOME: home,
      PAO_DISABLE_BUILTIN_EXTENSION: "1",
      PI_OFFLINE: "1",
      PI_NO_LOCAL_LLM: "1",
    },
  });

  try {
    const page = await app.firstWindow();
    await setWindowSize(app, page, 1280, 800);

    // ---- 首屏/空态 ----
    await shotSoft(page, "01-首屏空态-1280", mark);

    // ---- 会话视图：建一个会话并注入两条助手消息（事件注入夹具，非真实模型） ----
    await createNamedThread(page, "整理看板详情分组");
    await seedTranscriptMessages(app, page, { count: 2, textFactory: (i) => `夹具回复 ${i + 1}：已按基本/预算/记录分组整理。` });
    await page.waitForTimeout(600);
    await shotSoft(page, "02-会话视图-有消息-1280", mark);

    // ---- 侧栏与顶栏 ----
    await shotSoft(page, "03-侧栏与顶栏-1280", mark);

    // ---- 右侧工作台 ----
    const toggle = page.getByTestId("toggle-side-panel").first();
    if (await toggle.count()) {
      await toggle.click().catch(() => undefined);
      await page.waitForTimeout(500);
      await shotSoft(page, "04-右侧工作台-1280", mark);
      // 收回去继续后续截图
      const workbench = page.getByTestId("workbench");
      if (await workbench.isVisible().catch(() => false)) {
        await toggle.click().catch(() => undefined);
        await page.waitForTimeout(400);
      }
    } else {
      mark("04-右侧工作台: toggle-side-panel 不存在");
    }

    // ---- 看板（工作板页：部门与工人默认 tab） ----
    await page.getByTestId("sidebar-workboard").click();
    await page.waitForTimeout(800);
    await shotSoft(page, "05-看板-部门与工人-1280", mark);
    // 原始任务卡
    const cardsTab = page.getByRole("button", { name: "原始任务卡", exact: true });
    if (await cardsTab.count()) {
      await cardsTab.click();
      await page.waitForTimeout(600);
      await shotSoft(page, "06-看板-任务卡列表-1280", mark);
      // 卡详情：点 kanban-workflow-card（已交付工作流卡可见无遮挡），等详情面板出现再截图
      const card = page.getByTestId("kanban-workflow-card").first();
      if (await card.count()) {
        await card.scrollIntoViewIfNeeded().catch(() => undefined);
        await card.click().catch((e) => mark(`卡详情点击失败: ${String(e).slice(0, 120)}`));
        await page.getByTestId("kanban-detail").waitFor({ state: "visible", timeout: 5000 }).catch(() => undefined);
        await page.waitForTimeout(400);
        await shotSoft(page, "07-看板-卡详情-1280", mark);
        await page.getByTestId("kanban-detail-close").click().catch(() => undefined);
      } else {
        mark("07-看板-卡详情: kanban-workflow-card 不存在");
      }
      // 部门与待处理
      const overviewTab = page.getByRole("button", { name: "部门与待处理", exact: true });
      if (await overviewTab.count()) {
        await overviewTab.click();
        await page.waitForTimeout(600);
        await shotSoft(page, "08-看板-部门与待处理-1280", mark);
      } else {
        mark("08-看板-部门与待处理: tab 不存在");
      }
    } else {
      mark("06-看板-任务卡列表: 原始任务卡 tab 不存在");
    }

    // ---- 工作流：图视图 ----
    await page.getByTestId("sidebar-canvas").click();
    await page.waitForTimeout(1000);
    await shotSoft(page, "09-工作流-图视图-1280", mark);
    // 补截：工作流页打开右侧工具面板的全屏（「当前工作」短条与侧栏开关同一行关系）
    const canvasToggle = page.getByTestId("toggle-side-panel").first();
    if (await canvasToggle.count()) {
      await canvasToggle.click().catch(() => undefined);
      await page.waitForTimeout(500);
      await shotSoft(page, "09b-工作流-工具面板打开-1280", mark);
      await canvasToggle.click().catch(() => undefined);
      await page.waitForTimeout(400);
    } else {
      mark("09b-工作流-工具面板: toggle-side-panel 不存在");
    }
    // 选中实例：库中点一个实例行，让图显示节点
    const instanceRow = page.getByTestId("canvas-instance-row").first();
    if (await instanceRow.count()) {
      await instanceRow.click();
      await page.waitForTimeout(800);
      // 选中一个节点 → 详情面板
      const node = page.getByTestId("workflow-node").first();
      if (await node.count()) {
        await node.click().catch((e) => mark(`工作流节点点击失败: ${String(e).slice(0, 120)}`));
        await page.waitForTimeout(600);
      } else {
        mark("工作流节点: workflow-node 不存在");
      }
      await shotSoft(page, "10-工作流-节点详情-1280", mark);
    } else {
      mark("10-工作流-节点详情: canvas-instance-row 不存在");
    }
    // 列表视图
    const listBtn = page.getByTestId("workflow-view-list");
    if (await listBtn.count()) {
      await listBtn.click();
      await page.waitForTimeout(700);
      await shotSoft(page, "11-工作流-列表视图-1280", mark);
    } else {
      mark("11-工作流-列表视图: workflow-view-list 不存在");
    }
    // 计划历史页签
    const historyTab = page.getByRole("button", { name: "计划历史", exact: true });
    if (await historyTab.count()) {
      await historyTab.click();
      await page.waitForTimeout(700);
      await shotSoft(page, "12-工作流-计划历史-1280", mark);
      // 补截：聚焦计划历史内容区（若有可滚动内容滚到底部看分组）
      const historyContent = page.locator(".canvas-plan-history, [data-testid='plan-history']").first();
      if (await historyContent.count()) {
        await historyContent.evaluate((el) => { el.scrollTop = el.scrollHeight; }).catch(() => undefined);
        await page.waitForTimeout(300);
      }
      await shotSoft(page, "12b-工作流-计划历史-滚动底部-1280", mark);
      // 回到工作流页签（限定在 workflow-surface 的 nav 内，避免点中侧栏同名导航）
      const workflowNavTab = page.locator('.workflow-surface__nav button', { hasText: "工作流" }).first();
      if (await workflowNavTab.count()) await workflowNavTab.click().catch(() => undefined);
      await page.waitForTimeout(400);
    } else {
      mark("12-工作流-计划历史: 页签不存在");
    }
    // 更多菜单展开（先切回图视图确保 canvas-more 可见）
    const graphBtn = page.getByTestId("workflow-view-graph");
    if (await graphBtn.count()) await graphBtn.click().catch(() => undefined);
    await page.waitForTimeout(400);
    const moreBtn = page.getByTestId("canvas-more");
    if (await moreBtn.count()) {
      await moreBtn.waitFor({ state: "visible", timeout: 5000 }).catch(() => undefined);
      await moreBtn.click().catch((e) => mark(`更多菜单点击失败: ${String(e).slice(0, 120)}`));
      await page.waitForTimeout(400);
      await shotSoft(page, "13-工作流-更多菜单-1280", mark);
      // 关闭菜单（点页面空白）
      await page.mouse.click(400, 400).catch(() => undefined);
      await page.waitForTimeout(300);
    } else {
      mark("13-工作流-更多菜单: canvas-more 不存在");
    }

    // ---- 记忆页：六个页签 ----
    const memoryScript = join(home, "seed-memory.mjs");
    await writeFile(memoryScript, MEMORY_FIXTURE, "utf8");
    const sessionId = (await page.evaluate(async () => (await window.piApp!.getState()).selectedSessionId)) ?? "uireview-session";
    await execFileAsync(process.execPath, [memoryScript, KERNEL_PAO_DIST, project, home, sessionId]);
    await page.getByTestId("sidebar-memory").click();
    await page.waitForTimeout(900);
    await shotSoft(page, "14-记忆-记忆列表-1280", mark);
    // 选中一条记忆 → 详情
    const firstMemory = page.getByTestId("memory-list-item").first();
    if (await firstMemory.count()) {
      await firstMemory.click();
      await page.waitForTimeout(600);
      await shotSoft(page, "15-记忆-详情-1280", mark);
      // 补截：滚动到「修订」区（.memory-revisions 所在 section）
      const revisions = page.locator(".memory-revisions").first();
      if (await revisions.count()) {
        await revisions.scrollIntoViewIfNeeded().catch(() => undefined);
        await page.waitForTimeout(400);
      } else {
        mark("15b-记忆-详情-修订区: .memory-revisions 不存在");
      }
      await shotSoft(page, "15b-记忆-详情-修订区-1280", mark);
    } else {
      mark("15-记忆-详情: memory-list-item 不存在");
    }
    for (const [testId, name] of [
      ["memory-project-context-toggle", "16-记忆-项目背景-1280"],
      ["memory-task-continuations-toggle", "17-记忆-任务接续-1280"],
      ["memory-artifacts-toggle", "18-记忆-成果-1280"],
      ["memory-tab-evolution", "19-记忆-自进化-1280"],
      ["memory-tab-usage", "20-记忆-用量-1280"],
    ] as const) {
      const tab = page.getByTestId(testId);
      if (await tab.count()) {
        await tab.click().catch((e) => mark(`${name} 点击失败: ${String(e).slice(0, 120)}`));
        await page.waitForTimeout(600);
        await shotSoft(page, name, mark);
      } else {
        mark(`${name}: ${testId} 不存在`);
      }
    }
    // 补截：自进化页签 + 打开筛选栏（该视图筛选应只剩「类型」一项）
    const evolutionTab = page.getByTestId("memory-tab-evolution");
    if (await evolutionTab.count()) {
      await evolutionTab.click().catch(() => undefined);
      await page.waitForTimeout(600);
      const filtersToggle = page.locator(".memory-filters-toggle").first();
      if (await filtersToggle.count()) {
        await filtersToggle.click().catch(() => undefined);
        await page.waitForTimeout(500);
        await shotSoft(page, "19b-记忆-自进化-筛选栏-1280", mark);
        const filtersClose = page.locator(".memory-filters__close").first();
        if (await filtersClose.count()) await filtersClose.click().catch(() => undefined);
        await page.waitForTimeout(300);
      } else {
        mark("19b-记忆-自进化-筛选栏: .memory-filters-toggle 不存在");
      }
    }

    // ---- 定时任务 ----
    await page.getByTestId("sidebar-scheduled").click();
    await page.waitForTimeout(700);
    await shotSoft(page, "21-定时任务-1280", mark);

    // ---- 设置各页 ----
    await setView(page, "settings");
    await page.waitForTimeout(600);
    await shotSoft(page, "22-设置-常规-1280", mark);
    const settingsSections: [RegExp, string][] = [
      [/外观|Appearance/i, "23-设置-外观-1280"],
      [/通知|Notifications/i, "24-设置-通知-1280"],
      [/快捷键|Keyboard shortcuts/i, "25-设置-快捷键-1280"],
      [/供应商|Providers|提供商/i, "26-设置-供应商-1280"],
      [/模型|Models/i, "27-设置-模型-1280"],
      [/MCP/i, "28-设置-MCP-1280"],
    ];
    for (const [re, name] of settingsSections) {
      const item = page.getByRole("button", { name: re }).first();
      if (await item.count()) {
        await item.click().catch((e) => mark(`${name} 点击失败: ${String(e).slice(0, 120)}`));
        await page.waitForTimeout(500);
        await shotSoft(page, name, mark);
      } else {
        mark(`${name}: 设置项按钮不存在`);
      }
    }

    // ---- 深色主题 ----
    await page.evaluate(async () => { await window.piApp!.setThemeMode("dark"); });
    await page.waitForTimeout(500);
    // 深色会话
    await setView(page, "threads");
    await page.waitForTimeout(500);
    await shotSoft(page, "29-会话视图-深色-1280", mark);
    // 深色工作流图视图
    await page.getByTestId("sidebar-canvas").click();
    await page.waitForTimeout(900);
    await shotSoft(page, "30-工作流-图视图-深色-1280", mark);
    // 深色记忆列表
    await page.getByTestId("sidebar-memory").click();
    await page.waitForTimeout(700);
    await shotSoft(page, "31-记忆列表-深色-1280", mark);
    // 深色看板
    await page.getByTestId("sidebar-workboard").click();
    await page.waitForTimeout(800);
    await shotSoft(page, "32-看板-深色-1280", mark);
    // 深色设置外观
    await setView(page, "settings");
    await page.waitForTimeout(500);
    const appearanceItem = page.getByRole("button", { name: /外观|Appearance/i }).first();
    if (await appearanceItem.count()) {
      await appearanceItem.click().catch(() => undefined);
      await page.waitForTimeout(500);
    }
    await shotSoft(page, "33-设置-外观-深色-1280", mark);
    // 回浅色
    await page.evaluate(async () => { await window.piApp!.setThemeMode("light"); });
    await page.waitForTimeout(400);

    // ---- 900×700 ----
    await setWindowSize(app, page, 900, 700);
    await setView(page, "threads");
    await page.waitForTimeout(500);
    await shotSoft(page, "34-会话视图-900", mark);
    await page.getByTestId("sidebar-canvas").click().catch(async () => {
      // 窄窗口侧栏可能收起，用 setActiveView 兜底
      await setView(page, "canvas");
    });
    await page.waitForTimeout(900);
    await shotSoft(page, "35-工作流-图视图-900", mark);
    const listBtn900 = page.getByTestId("workflow-view-list");
    if (await listBtn900.count()) {
      await listBtn900.click().catch(() => undefined);
      await page.waitForTimeout(600);
      await shotSoft(page, "36-工作流-列表视图-900", mark);
      await page.getByTestId("workflow-view-graph").click().catch(() => undefined);
    } else {
      mark("36-工作流-列表视图-900: workflow-view-list 不存在");
    }
    await page.getByTestId("sidebar-memory").click().catch(() => setView(page, "memory"));
    await page.waitForTimeout(700);
    await shotSoft(page, "37-记忆列表-900", mark);
    await page.getByTestId("sidebar-workboard").click().catch(() => setView(page, "workboard"));
    await page.waitForTimeout(800);
    await shotSoft(page, "38-看板-900", mark);

    // ---- 700×700 ----
    await setWindowSize(app, page, 700, 700);
    await setView(page, "threads");
    await page.waitForTimeout(500);
    await shotSoft(page, "39-会话视图-700", mark);
    await setView(page, "canvas");
    await page.waitForTimeout(900);
    await shotSoft(page, "40-工作流-图视图-700", mark);
    await setView(page, "memory");
    await page.waitForTimeout(700);
    await shotSoft(page, "41-记忆列表-700", mark);

    if (anomalies.length) {
      console.log("[anomalies]", JSON.stringify(anomalies, null, 2));
      await writeFile(join(OUT, "_anomalies.json"), JSON.stringify(anomalies, null, 2), "utf8");
    }
    console.log("[done] all screenshots saved to", OUT);
  } finally {
    await app.close();
  }
});
