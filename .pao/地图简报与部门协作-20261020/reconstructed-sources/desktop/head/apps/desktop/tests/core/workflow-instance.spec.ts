/**
 * 实例只读运行图（真实 Electron，隔离夹具，无模型请求）。
 *
 * 夹具用内核构建产物的真控制启动 API（startControl → bindMinister → addNodeCards）写冻结实例：
 * 冻结节点为「冻结甲/冻结乙」，冻结甲带一张「进行中」卡；随后把最新配方改成「最新甲/最新乙」。
 * 断言 UI 只显示冻结节点与冻结坐标、节点不可拖不可连线、点节点打开 D8d 详情。
 * 不连 provider、不派发 worker、不调用模型；不是真实运行验收。
 */
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { launchDesktop, makeUserDataDir, makeWorkspace } from "../helpers/electron-app";

const execFileAsync = promisify(execFile);

/** 桌面 app 直接依赖的内核构建产物；与运行时画布桥加载的是同一份 dist。 */
const KERNEL_PAO_DIST = resolve(
  __dirname,
  "../../node_modules/@earendil-works/pi-coding-agent/dist/pao",
);

/**
 * 夹具脚本（写进临时 PAO_HOME 后由 node 直接跑）：
 * 只 import 内核已构建 JS，不 import 源码、不装依赖、不请求模型。
 */
const FIXTURE_SCRIPT = `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [kernelDist, paoHome, project, workspaceDir, cardsDir] = process.argv.slice(2);
const load = (relative) => import(pathToFileURL(join(kernelDist, relative)).href);
const { parseRecipe } = await load("workflow/recipe.js");
const { startControl, bindMinister, readControl, addNodeCards } = await load("workflow/control.js");
const { changeCardStatus, loadCard, parseCardRef } = await load("cards/index.js");
const { formatProjectList } = await load("dept/projects.js");

mkdirSync(join(paoHome, "工作流"), { recursive: true });
mkdirSync(cardsDir, { recursive: true });
writeFileSync(
  join(paoHome, "项目清单.md"),
  formatProjectList([
    {
      项目名: "实例验证项目",
      项目根: project,
      首次服务: "2026-10-05 09:00",
      最近服务: "2026-10-05 09:00",
    },
  ]),
);
const recipePath = join(paoHome, "工作流", "实例验证.md");
writeFileSync(
  recipePath,
  "---\\n" +
    JSON.stringify({
      版本: 2,
      名字: "实例验证",
      参数: [],
      节点: [
        { 名字: "冻结甲", 部门: "工程", 目标: "实现冻结甲", 验收: "文件存在", depends_on: [] },
        { 名字: "冻结乙", 部门: "评审", 目标: "复核冻结甲", 验收: "意见归档", depends_on: ["冻结甲"] },
      ],
      ui: { positions: { 冻结甲: { x: 40, y: 120 }, 冻结乙: { x: 420, y: 120 } } },
    }) +
    "\\n---\\n实例验证配方。\\n",
);
const recipe = parseRecipe(readFileSync(recipePath, "utf8"), recipePath);
const options = { cardsDir, workspaceDir, ownerSessionId: "fixture-owner" };
await startControl(recipe, {}, options);
await bindMinister(recipe, options, "冻结甲", "fixture-minister");
const flow = readControl(recipe, options);
const node = flow.节点.find((item) => item.名字 === "冻结甲");
const refs = await addNodeCards(
  recipe,
  options,
  { 实例: flow.实例, 节点: "冻结甲", 轮次: node.轮次, 部长会话: "fixture-minister" },
  [{ goal: "实现冻结甲", acceptance: "文件存在" }],
);
const card = loadCard(cardsDir, parseCardRef(refs[0]));
changeCardStatus(card, { 操作者: "主控", to: "in_progress", 时间: "2026-10-05 10:01" });
process.stdout.write("fixture-ok\\n");
`;

/** 最新配方（故意与冻结图不同：节点名、部门、坐标都换掉）。 */
function latestRecipeMarkdown(): string {
  return `---\n${JSON.stringify({
    版本: 2,
    名字: "实例验证",
    参数: [],
    节点: [
      { 名字: "最新甲", 部门: "市场", 目标: "最新目标甲", 验收: "最新验收甲", depends_on: [] },
      {
        名字: "最新乙",
        部门: "销售",
        目标: "最新目标乙",
        验收: "最新验收乙",
        depends_on: ["最新甲"],
      },
    ],
    ui: { positions: { 最新甲: { x: 60, y: 300 }, 最新乙: { x: 500, y: 300 } } },
  })}\n---\n最新配方（故意与冻结图不同）。\n`;
}

async function launchInstanceFixture() {
  const home = await makeWorkspace("workflow-instance-home");
  const project = await makeWorkspace("workflow-instance-project");
  const workspaceDir = join(project, ".pao", "任务甲");
  const cardsDir = join(workspaceDir, "卡");

  const fixtureScript = join(home, "make-frozen-instance.mjs");
  await writeFile(fixtureScript, FIXTURE_SCRIPT, "utf8");
  await execFileAsync(
    process.execPath,
    [fixtureScript, KERNEL_PAO_DIST, home, project, workspaceDir, cardsDir],
    { windowsHide: true },
  );
  const manifest = await readFile(join(workspaceDir, "工作流实例-实例验证.md"), "utf8");
  expect(manifest).toContain("冻结配方");
  expect(manifest).toContain("冻结甲");

  await writeFile(join(home, "工作流", "实例验证.md"), latestRecipeMarkdown(), "utf8");

  const app = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [project],
    testMode: "background",
    scrubProviderEnv: true,
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: "1" },
  });
  return { app, home, project };
}

test("实例运行图只读：冻结节点不同最新配方、不可拖不可连、点节点开详情", async () => {
  const { app } = await launchInstanceFixture();
  try {
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-canvas").click();
    await expect(page.getByTestId("canvas-view")).toBeVisible();

    // 最新配方确实已换图：配方视图显示「最新甲」。
    const recipeRow = page.getByTestId("canvas-recipe-row").filter({ hasText: "实例验证" });
    await expect(recipeRow).toBeVisible();
    await recipeRow.click();
    await expect(
      page
        .getByTestId("recipe-canvas-editor")
        .getByTestId("workflow-node")
        .filter({ hasText: "最新甲" }),
    ).toBeVisible();

    // 切到实例：显示冻结图，不显示最新配方的节点。
    const instanceRow = page.getByTestId("canvas-instance-row").filter({ hasText: "实例验证" });
    await expect(instanceRow).toBeVisible();
    await instanceRow.click();
    const graph = page.getByTestId("canvas-dag");
    await expect(graph).toBeVisible();
    await expect(graph).toHaveAttribute("data-instance", "实例验证");
    await expect(graph.getByTestId("workflow-editor")).toHaveAttribute("data-mode", "runtime");
    const controls = page.getByTestId("workflow-runtime-controls");
    await expect(controls).toContainText("fixture-owner");
    await expect(controls).toContainText("在途任务会继续");
    await expect(controls.getByRole("button", { name: "暂停推进", exact: true })).toBeDisabled();
    await expect(controls.getByRole("button", { name: "确认放行", exact: true })).toBeDisabled();
    // 夹具 owner 并非桌面真实会话，打开时必须明确报错，不能借用任意会话。
    await controls.getByRole("button", { name: "打开原主控", exact: true }).click();
    await expect(controls.getByRole("status")).not.toBeEmpty();

    const frozenA = graph.locator(".react-flow__node").filter({ hasText: "冻结甲" });
    const frozenB = graph.locator(".react-flow__node").filter({ hasText: "冻结乙" });
    await expect(frozenA).toBeVisible();
    await expect(frozenB).toBeVisible();
    await expect(graph.locator(".react-flow__node")).toHaveCount(2);
    await expect(graph.getByText("最新甲")).toHaveCount(0);

    // 冻结坐标贯通到 ReactFlow 节点 transform。
    await expect(frozenA).toHaveAttribute("style", /translate\(40px,\s*120px\)/);
    await expect(frozenB).toHaveAttribute("style", /translate\(420px,\s*120px\)/);

    // 夹具未结束部长拆解，甲等待拆解、乙等待前置：真实控制报告标挂起，沿用橙色。
    await expect(frozenA.locator(".canvas-node--orange")).toHaveCount(1);
    await expect(frozenB.locator(".canvas-node--orange")).toHaveCount(1);
    await expect(frozenA).toContainText("进行中");

    // 只读锁定：拖动节点后位置 transform 不变。
    const beforeTransform = await frozenA.getAttribute("style");
    const nodeBox = await frozenA.boundingBox();
    if (!nodeBox) throw new Error("冻结甲节点没有可见坐标");
    await page.mouse.move(nodeBox.x + nodeBox.width / 2, nodeBox.y + nodeBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      nodeBox.x + nodeBox.width / 2 + 140,
      nodeBox.y + nodeBox.height / 2 + 90,
      {
        steps: 10,
      },
    );
    await page.mouse.up();
    expect(await frozenA.getAttribute("style")).toBe(beforeTransform);

    // 只读锁定：从 source 手柄拖到 target 手柄，依赖边数不变。
    const edges = graph.locator(".react-flow__edge");
    await expect(edges).toHaveCount(1);
    const edgeCount = await edges.count();
    const sourceBox = await frozenA.locator(".react-flow__handle.source").boundingBox();
    const targetBox = await frozenB.locator(".react-flow__handle.target").boundingBox();
    if (!sourceBox || !targetBox) throw new Error("连线手柄不可见");
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
      steps: 12,
    });
    await page.mouse.up();
    await expect(edges).toHaveCount(edgeCount);

    // 点节点打开详情：模板值来自冻结配方（工程），卡状态来自卡现读（进行中）。
    await frozenA.getByTestId("workflow-node").click();
    const detail = page.getByTestId("canvas-node-detail");
    await expect(detail.getByTestId("canvas-node-detail-fields")).toContainText("冻结甲");
    await expect(detail.getByTestId("canvas-node-detail-fields")).toContainText("工程");
    await expect(detail.getByTestId("canvas-node-detail-fields")).toContainText("进行中");
    await expect(detail.getByTestId("canvas-node-detail-d8d")).toBeVisible();
    await expect(detail.getByTestId("canvas-detail-view-card")).toBeEnabled();
  } finally {
    await app.close();
  }
});

test("同名配方的两个历史实例按路径分别打开冻结图", async () => {
  const { app, home, project } = await launchInstanceFixture();
  try {
    const task = join(project, ".pao", "任务乙");
    const script = join(home, "make-second-instance.mjs");
    await writeFile(
      script,
      `import {mkdirSync,readFileSync} from 'node:fs'; import {join} from 'node:path'; import {pathToFileURL} from 'node:url';
const [dist,home,task]=process.argv.slice(2);
const {parseRecipe}=await import(pathToFileURL(join(dist,'workflow/recipe.js')).href);
const {startControl}=await import(pathToFileURL(join(dist,'workflow/control.js')).href);
mkdirSync(join(task,'卡'),{recursive:true});const path=join(home,'工作流','实例验证.md');
await startControl(parseRecipe(readFileSync(path,'utf8'),path),{},{workspaceDir:task,cardsDir:join(task,'卡'),ownerSessionId:'second-owner'});`,
    );
    await execFileAsync(process.execPath, [script, KERNEL_PAO_DIST, home, task], {
      windowsHide: true,
    });
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-canvas").click();
    await expect(
      page.getByTestId("canvas-instance-row").filter({ hasText: "实例验证" }),
    ).toHaveCount(2);
    const firstPath = join(project, ".pao", "任务甲", "工作流实例-实例验证.md");
    const secondPath = join(task, "工作流实例-实例验证.md");
    await page
      .locator(
        `[data-testid="canvas-instance-row"][data-instance-path=${JSON.stringify(firstPath)}]`,
      )
      .click();
    await expect(
      page.getByTestId("canvas-dag").getByTestId("workflow-node").filter({ hasText: "冻结甲" }),
    ).toBeVisible();
    await expect(page.getByTestId("workflow-runtime-controls")).toContainText("fixture-owner");
    await page
      .locator(
        `[data-testid="canvas-instance-row"][data-instance-path=${JSON.stringify(secondPath)}]`,
      )
      .click();
    await expect(
      page.getByTestId("canvas-dag").getByTestId("workflow-node").filter({ hasText: "最新甲" }),
    ).toBeVisible();
    await expect(page.getByTestId("workflow-runtime-controls")).toContainText("second-owner");
    expect(
      (await page.evaluate(() => window.piApp!.getState())).workflowTabs.map(
        (tab) => tab.instancePath,
      ),
    ).toEqual(expect.arrayContaining([firstPath, secondPath]));
  } finally {
    await app.close();
  }
});

// ── S6-D1 桌面运行视图与动画（写好后等桌面 e2e 道空闲再跑，本包不执行） ──────────

/**
 * 三节点动效夹具：执行甲（已交付＋拆解结束＝完成）→ 执行乙（依赖甲，卡进行中且无挂起＝
 * 六态蓝＝执行中动画）＋ 执行丙（独立，卡失败＝红色＋实例失败横幅）。
 * 乙的进行中真实来自卡现读，丙的失败真实来自卡面状态；不连 provider、不派发 worker。
 */
const RUNTIME_FEEDBACK_SCRIPT = `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [kernelDist, paoHome, project, workspaceDir, cardsDir] = process.argv.slice(2);
const load = (relative) => import(pathToFileURL(join(kernelDist, relative)).href);
const { parseRecipe } = await load("workflow/recipe.js");
const { startControl, bindMinister, readControl, addNodeCards, endDecomposition } = await load("workflow/control.js");
const { changeCardStatus, loadCard, parseCardRef } = await load("cards/index.js");
const { formatProjectList } = await load("dept/projects.js");

mkdirSync(join(paoHome, "工作流"), { recursive: true });
mkdirSync(cardsDir, { recursive: true });
writeFileSync(
  join(paoHome, "项目清单.md"),
  formatProjectList([
    { 项目名: "动效验证项目", 项目根: project, 首次服务: "2026-10-07 09:00", 最近服务: "2026-10-07 09:00" },
  ]),
);
const recipePath = join(paoHome, "工作流", "动效验证.md");
writeFileSync(
  recipePath,
  "---\\n" +
    JSON.stringify({
      版本: 2,
      名字: "动效验证",
      参数: [],
      节点: [
        { 名字: "执行甲", 部门: "工程", 目标: "交付前置", 验收: "文件存在", depends_on: [] },
        { 名字: "执行乙", 部门: "工程", 目标: "在跑节点", 验收: "文件存在", depends_on: ["执行甲"] },
        { 名字: "执行丙", 部门: "工程", 目标: "失败节点", 验收: "文件存在", depends_on: [] },
      ],
      ui: { positions: { 执行甲: { x: 40, y: 120 }, 执行乙: { x: 420, y: 120 }, 执行丙: { x: 40, y: 320 } } },
    }) +
    "\\n---\\n动效验证配方。\\n",
);
const recipe = parseRecipe(readFileSync(recipePath, "utf8"), recipePath);
const options = { cardsDir, workspaceDir, ownerSessionId: "fixture-owner" };
await startControl(recipe, {}, options);

const driveNode = async (nodeName, minister, cardStatus, endDecompose) => {
  await bindMinister(recipe, options, nodeName, minister);
  const flow = readControl(recipe, options);
  const node = flow.节点.find((item) => item.名字 === nodeName);
  const identity = { 实例: flow.实例, 节点: nodeName, 轮次: node.轮次, 部长会话: minister };
  const refs = await addNodeCards(recipe, options, identity, [
    { goal: "执行 " + nodeName, acceptance: "文件存在" },
  ]);
  if (endDecompose) await endDecomposition(recipe, options, identity);
  const card = loadCard(cardsDir, parseCardRef(refs[0]));
  // 合法迁移路径（内核状态机）：unclaimed 只能→in_progress/canceled，in_progress 才能→delivered/failed；
  // 转入 failed 必须带失败类型。卡先认领成 in_progress，再按目标态走第二步。
  let current = changeCardStatus(card, { 操作者: "主控", to: "in_progress", 时间: "2026-10-07 10:01" });
  if (cardStatus !== "in_progress") {
    current = changeCardStatus(current, {
      操作者: "主控",
      to: cardStatus,
      时间: "2026-10-07 10:01",
      ...(cardStatus === "failed" ? { 失败类型: "transient" } : {}),
    });
  }
};

await driveNode("执行甲", "minister-a", "delivered", true); // 拆解结束＋卡交付＝节点完成，解锁乙
await driveNode("执行乙", "minister-b", "in_progress", true); // 无挂起的进行中＝六态蓝＝执行中动画
await driveNode("执行丙", "minister-c", "failed", false); // 卡失败＝红色＋实例失败横幅
process.stdout.write("fixture-ok\\n");
`;

async function launchRuntimeFeedbackFixture() {
  const home = await makeWorkspace("s6d1-runtime-feedback-home");
  const project = await makeWorkspace("s6d1-runtime-feedback-project");
  const workspaceDir = join(project, ".pao", "任务甲");
  const cardsDir = join(workspaceDir, "卡");
  const fixtureScript = join(home, "make-runtime-feedback.mjs");
  await writeFile(fixtureScript, RUNTIME_FEEDBACK_SCRIPT, "utf8");
  await execFileAsync(
    process.execPath,
    [fixtureScript, KERNEL_PAO_DIST, home, project, workspaceDir, cardsDir],
    { windowsHide: true },
  );
  const app = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [project],
    testMode: "background",
    scrubProviderEnv: true,
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: "1" },
  });
  return { app, home, project };
}

test("S6-D1 执行中节点与入边动画＋实例失败可见＋未记录显示未知", async () => {
  const { app } = await launchRuntimeFeedbackFixture();
  try {
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-canvas").click();
    await expect(page.getByTestId("canvas-view")).toBeVisible();

    // 运行记录列表行有失败标记（不静默）。
    const instanceRow = page.getByTestId("canvas-instance-row").filter({ hasText: "动效验证" });
    await expect(instanceRow).toHaveAttribute("data-failed", "true");
    await expect(instanceRow).toContainText("失败节点 1 个");
    await instanceRow.click();

    const graph = page.getByTestId("canvas-dag");
    await expect(graph).toHaveAttribute("data-instance", "动效验证");

    // 实例失败横幅点名失败节点。
    const failureBanner = page.getByTestId("canvas-instance-failure");
    await expect(failureBanner).toBeVisible();
    await expect(failureBanner).toContainText("执行丙");

    // 执行乙＝六态蓝（进行中且无挂起）：带运行弧线类；进入乙的依赖边 animated 流动。
    const nodeB = graph.locator(".react-flow__node").filter({ hasText: "执行乙" });
    await expect(nodeB.locator(".canvas-flow-node--running")).toHaveCount(1);
    await expect(graph.locator(".react-flow__edge.animated")).toHaveCount(1);
    const animatedEdge = graph.locator(".react-flow__edge.animated");
    await expect(animatedEdge).toHaveAttribute("data-id", JSON.stringify(["dependency", "执行甲", "执行乙"]));

    // 执行甲已完成＝绿、无动画类；执行丙失败＝红、无动画类（挂起/排队不冒充执行中）。
    const nodeA = graph.locator(".react-flow__node").filter({ hasText: "执行甲" });
    const nodeC = graph.locator(".react-flow__node").filter({ hasText: "执行丙" });
    await expect(nodeA.locator(".canvas-node--green")).toHaveCount(1);
    await expect(nodeC.locator(".canvas-node--red")).toHaveCount(1);
    await expect(graph.locator(".canvas-flow-node--running")).toHaveCount(1);

    // 未记录耗时/Token 显示未知而非 0：乙未完成、无回执用量。
    await nodeB.getByTestId("workflow-node").click();
    const d8d = page.getByTestId("canvas-node-detail-d8d");
    await expect(d8d).toBeVisible();
    await expect(d8d).toContainText("未记录完成时间");
    await expect(d8d).toContainText("尚无回执用量记录");
    await expect(d8d).not.toContainText("0 秒");
  } finally {
    await app.close();
  }
});

test("S6-D1 运行图刷新不重置视口（坐标保持）", async () => {
  const { app } = await launchInstanceFixture();
  try {
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-canvas").click();
    await page.getByTestId("canvas-instance-row").filter({ hasText: "实例验证" }).click();
    const graph = page.getByTestId("canvas-dag");
    const frozenA = graph.locator(".react-flow__node").filter({ hasText: "冻结甲" });
    await expect(frozenA).toBeVisible();

    // 缩放改变视口后手动刷新：画布不整块卸载重挂，视口与冻结坐标都保持。
    const viewport = graph.locator(".react-flow__viewport");
    await expect(viewport).toBeVisible();
    const boardBox = await graph.boundingBox();
    if (!boardBox) throw new Error("画布不可见");
    await page.mouse.move(boardBox.x + boardBox.width / 2, boardBox.y + boardBox.height / 2);
    await page.mouse.wheel(0, -400); // 放大＝视口 transform 变化
    const zoomedTransform = await viewport.getAttribute("style");
    await expect(frozenA).toHaveAttribute("style", /translate\(40px,\s*120px\)/);
    expect(zoomedTransform).toBeTruthy();

    const refresh = page.getByTestId("canvas-refresh");
    await refresh.click();
    await expect(refresh).toBeEnabled(); // 刷新完成
    await expect(frozenA).toBeVisible();
    expect(await viewport.getAttribute("style")).toBe(zoomedTransform); // 视口不跳
    await expect(frozenA).toHaveAttribute("style", /translate\(40px,\s*120px\)/); // 坐标保持
  } finally {
    await app.close();
  }
});
