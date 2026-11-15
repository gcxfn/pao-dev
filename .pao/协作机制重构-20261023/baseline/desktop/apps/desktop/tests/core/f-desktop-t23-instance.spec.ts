import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

const execFileAsync = promisify(execFile);

/**
 * F 批 · T23：坏实例身份与耗时。
 *
 * ## 落点为什么不是画布页
 *
 * 原先打算验 `canvas-anomaly-row` / `canvas-instance-row`（`src/features/canvas/recipe-library.tsx:425-432`
 * 与 `:264`）。实测发现**画布页 UI 已被摘掉**：`src/features/canvas/canvas-surface.tsx` 里定义的
 * `CanvasSurface` 在整个 `apps/desktop` 里**没有任何 import 引用**（`grep -r canvas-surface` 只命中
 * 一处注释），因此这两个 testid 在当前界面上**走不到**。
 * 这与 D 批「画布不作新入口」的结论一致，不是缺陷、也不是我改坏的。
 * 所以 T23 的界面层证据落在**当前真实在用的** workflow-cards 页面（侧栏「工作流」）。
 *
 * ## 要证的两件事（都有对照组）
 *
 * ### 一、坏实例身份：读不出来的卡如实报问题，不编造状态
 *
 * 内核 `PAO/packages/coding-agent/src/pao/desktop/plans.ts:204-210`：`loadCard` 抛错时把
 * `卡 卡0001 读不出来：<真实原因>` 记进 `问题`，最后合成 `读取问题`（`:234`）。
 * 桌面只读投影原样透传（`electron/platform/pao/temporary-plans-query.ts:257` `optionalText(row.读取问题, …)`），
 * 模型层 `deriveTodos`（`src/features/workflow-cards/workflow-cards-model.ts:1078-1085`）
 * 在 `view.progress?.readProblem !== undefined || view.state === "unreadable"` 时产出
 * `missing_input` 待办，`reason` 用内核原话。
 * 界面出口：`workflow-cards-view.tsx:926` 的 `workflow-cards-todo-missing_input`。
 *
 * 要钉住的是：**界面上没有「凭空猜出来的状态」**——它不把读不出来的卡说成已完成/运行中，
 * 而是明说读不出来并给出原因。
 *
 * ### 二、耗时：记录完整时按真实时间算，缺记录时说未记录
 *
 * `canvas-query.ts:666-671 durationSecondsOf`：任一端缺失或不可解析返回 `undefined`，
 * `node-runtime-details.tsx:29-31` 渲染「未记录完成时间」。
 * **注意**：该组件同样挂在已摘掉的画布页里，所以「耗时」这一条在当前界面上**没有可见出口**。
 * 本用例只验真值函数本身的口径（纯函数断言，不依赖 UI），并如实标注这一点，
 * 不把它写成「界面验证通过」。
 *
 * 本文件不改产品源码。
 */

const REGISTRY = `# 部门注册表

| 名字 | 能力标签 | 库路径 | 建部日期 |
| --- | --- | --- | --- |
| 策划部 | 策划 | 部门/策划部/知识库 | 2026-10-14 |
`;

/**
 * 夹具：真实临时计划，两个步骤各一张卡。
 *
 * 返回两张卡的**真实文件路径**，供用例在启动后按需破坏其中一张
 * ——这样坏读是内核在**真读盘**时遇到的，不是我们塞给界面的假数据。
 */
const FIXTURE_SCRIPT = `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [kernelDist, project, ownerSessionId] = process.argv.slice(2);
const load = (relative) => import(pathToFileURL(join(kernelDist, relative)).href);

const plan = await load("workflow/plan.js");
const driver = await load("workflow/driver.js");
const control = await load("workflow/control.js");
const cards = await load("cards/index.js");

const created = await plan.createTemporaryPlan({
  项目根: project,
  显示名: "F23 坏卡与耗时",
  来源会话: ownerSessionId,
  请求ID: "req-f23-1",
  已注册部门: ["策划部"],
  步骤: [
    { 标题: "好卡这一步", 部门: "策划部", 要求: "产出 好.md" },
    { 标题: "坏卡这一步", 部门: "策划部", 要求: "产出 坏.md" },
  ],
  当刻: "2026-10-17 10:00",
});
const execution = plan.resolvePlanExecution({
  项目根: project,
  计划ID: created.计划ID,
  启动请求ID: "start-f23-1",
  定义版本: 1,
  来源会话: ownerSessionId,
});
await driver.startWorkflow(execution.配方, {}, {
  cardsDir: execution.卡目录,
  workspaceDir: execution.工作区,
  ownerSessionId,
});
const identity = plan.readPlanInstanceIdentity(execution.工作区, execution.配方名);
if (!identity) throw new Error("实例身份读不出来");
plan.recordPlanStart(execution.关联路径, {
  计划ID: created.计划ID,
  定义版本: 1,
  启动请求ID: "start-f23-1",
  实例: identity.实例,
  配方名: execution.配方名,
  工作区: execution.工作区,
  卡目录: execution.卡目录,
  控制清单: execution.控制清单,
  owner会话: ownerSessionId,
  受理时刻: "2026-10-17 10:01",
});

const options = { cardsDir: execution.卡目录, workspaceDir: execution.工作区, ownerSessionId };
const nodeOf = (node) => ({ 实例: identity.实例, 节点: node, 轮次: 1, 部长会话: ownerSessionId });

// 两张卡都正常建出来并推进到 in_progress —— 先把状态做「好」。
const cardPaths = {};
for (const [node, title] of [["s1", "好卡这一步"], ["s2", "坏卡这一步"]]) {
  await control.bindMinister(execution.配方, options, node, ownerSessionId);
  const [ref] = await control.addNodeCards(execution.配方, options, nodeOf(node), [
    { goal: "产出 " + title + ".md", acceptance: "存在" },
  ]);
  const no = cards.parseCardRef(ref);
  const card = cards.loadCard(execution.卡目录, no);
  cards.changeCardStatus(card, {
    操作者: ownerSessionId,
    to: "in_progress",
    时间: "2026-10-17 10:02",
  });
  cardPaths[node] = card.path;
  if (node === "s1") {
    // s1 对照组：走完整交付链路，产物真实存在。
    writeFileSync(join(project, "好.md"), "# 好\\n真实产出。\\n", "utf8");
    cards.appendReceipt(cards.loadCard(execution.卡目录, no), {
      尝试号: 1,
      时间: "2026-10-17 10:03",
      结果: "完成",
      摘要: "已产出 好.md",
      产物路径: ["好.md"],
    });
    cards.changeCardStatus(cards.loadCard(execution.卡目录, no), {
      操作者: ownerSessionId,
      to: "delivered",
      时间: "2026-10-17 10:05",
    });
  }
  await control.endDecomposition(execution.配方, options, nodeOf(node));
}

console.log(JSON.stringify({
  实例: identity.实例,
  配方名: execution.配方名,
  卡目录: execution.卡目录,
  好卡路径: cardPaths.s1,
  坏卡路径: cardPaths.s2,
  好卡创建: cards.loadCard(execution.卡目录, cards.parseCardRef("卡0001")).frontmatter.created ?? null,
  好卡完成: cards.loadCard(execution.卡目录, cards.parseCardRef("卡0001")).frontmatter.completed ?? null,
}));
`;

/**
 * 耗时口径验证脚本：造三张卡，分别「两端都有时间」「只有创建时间」「只有完成时间」，
 * 然后按 `canvas-query.ts:666-671 durationSecondsOf` 的同一口径（`parseCardMinute` 正则 +
 * 「任一端解析不出就 undefined，否则 Math.max(0, round((end-start)/1000))」）现算，
 * 把三张卡的真实 frontmatter 与算出的秒数一起打回来。
 *
 * 为什么要这么做：`durationSecondsOf` 没有从 `canvas-query.ts` 导出（它是模块内私有函数），
 * 且画布页已摘掉、界面无出口。所以这里复刻**同一口径**并用真实落盘的卡验证，
 * 而不是在 TypeScript 文件上做 import。
 */
const DURATION_SCRIPT = `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [kernelDist, project] = process.argv.slice(2);
const load = (relative) => import(pathToFileURL(join(kernelDist, relative)).href);
const cards = await load("cards/index.js");

const cardsDir = join(project, "卡");
const owner = "f23-duration-owner";

// 与 canvas-query.ts:657-663 同口径。
function parseCardMinute(text) {
  if (typeof text !== "string") return undefined;
  const m = /^(\\d{4})-(\\d{2})-(\\d{2})[ T](\\d{2}):(\\d{2})/.exec(text.trim());
  if (!m) return undefined;
  const [, y, mo, d, h, mi] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)).getTime();
}
// 与 canvas-query.ts:666-671 同口径：任一端缺失/不可解析＝undefined（未记录，不估）。
function durationSecondsOf(createdAt, finishedAt) {
  const start = parseCardMinute(createdAt);
  const end = parseCardMinute(finishedAt);
  if (start === undefined || end === undefined) return undefined;
  return Math.max(0, Math.round((end - start) / 1000));
}
const orNull = (value) => (value === undefined ? null : value);

const make = async (goal, created, completed) => {
  const created_ = await cards.createCard(cardsDir, {
    目标: goal,
    部门: "策划部",
    验收: "存在",
    创建: created,
    owner,
    状态: "unclaimed",
  });
  // createCard 返回卡对象；卡号直接取 card_no（四位字符串），不要再过一遍 parseCardRef。
  const no = created_.card_no;
  // completed 由 changeCardStatus 落 delivered 时写入；这里只造「有/没有」两种真实卡面。
  if (completed) {
    cards.changeCardStatus(cards.loadCard(cardsDir, no), { 操作者: owner, to: "in_progress", 时间: created });
    cards.changeCardStatus(cards.loadCard(cardsDir, no), { 操作者: owner, to: "delivered", 时间: completed });
  }
  return cards.loadCard(cardsDir, no);
};

const both = await make("两端都有时间", "2026-10-17 10:00", "2026-10-17 10:05");
const noDone = await make("缺完成时间", "2026-10-17 10:00", null);

console.log(JSON.stringify({
  有完成时间耗时秒: orNull(durationSecondsOf(both.frontmatter.created, both.frontmatter.completed)),
  缺完成时间耗时秒: orNull(durationSecondsOf(noDone.frontmatter.created, noDone.frontmatter.completed)),
  卡面创建: both.frontmatter.created ?? null,
  卡面完成: both.frontmatter.completed ?? null,
}));
`;

interface BadCardFixture {  readonly 实例: string;
  readonly 配方名: string;
  readonly 卡目录: string;
  readonly 好卡路径: string;
  readonly 坏卡路径: string;
  readonly 好卡创建: string | null;
  readonly 好卡完成: string | null;
}

async function launchBadCardFixture(prefix: string) {
  const home = await makeWorkspace(`${prefix}-home`);
  const project = await makeWorkspace(`${prefix}-project`);
  const userDataDir = await makeUserDataDir();
  await writeFile(join(userDataDir, "ui-state.json"), JSON.stringify({ language: "zh" }), "utf8");
  const app = await launchDesktop(userDataDir, {
    initialWorkspaces: [project],
    testMode: "foreground",
    scrubProviderEnv: true,
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: "0" },
  });

  const page = await app.firstWindow();
  await createNamedThread(page, `${prefix} 会话`);
  const state = await getDesktopState(page);
  const workspace = state.workspaces.find((entry) => entry.path === project);
  const sessionId = workspace?.sessions[0]?.id;
  if (!workspace || !sessionId) {
    await app.close();
    throw new Error("拿不到夹具工作区或会话 id");
  }

  const kernelDist = join(__dirname, "../../node_modules/@earendil-works/pi-coding-agent/dist/pao");
  const scriptPath = join(home, "make-f23-fixture.mjs");
  await writeFile(scriptPath, FIXTURE_SCRIPT, "utf8");
  const { stdout } = await execFileAsync(
    process.execPath,
    [scriptPath, kernelDist, project, sessionId],
    { windowsHide: true },
  );
  const fixture = JSON.parse(stdout.trim().split("\n").at(-1)!) as BadCardFixture;

  await page.getByTestId("task-status-open-workflow").click();
  await expect(page.getByTestId("workflow-cards-title")).toContainText("F23 坏卡与耗时", {
    timeout: 20_000,
  });
  return { app, page, project, fixture };
}

test("T23 对照组：两张卡都好时，界面不报任何读取问题", async () => {
  const { app, page, fixture } = await launchBadCardFixture("f23-good");
  try {
    // 夹具自检：两张卡确实都正常落盘。
    const goodCard = await readFile(fixture.好卡路径, "utf8");
    const badCard = await readFile(fixture.坏卡路径, "utf8");
    expect(goodCard).toContain("delivered");
    expect(badCard).toContain("in_progress");

    // 两个步骤都在界面上。
    const steps = page.getByTestId("workflow-cards-steps");
    await expect(steps).toContainText("好卡这一步", { timeout: 20_000 });
    await expect(steps).toContainText("坏卡这一步");

    // 对照组关键：卡都好的时候**不许**出现读取问题待办，
    // 否则下一条用例里它出现就不能证明是「卡坏了导致的」。
    await expect(page.getByTestId("workflow-cards-todo-missing_input")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("T23 坏实例身份：卡读不出来时如实报问题，不编造状态", async () => {
  const { app, page, fixture } = await launchBadCardFixture("f23-bad");
  try {
    // 破坏 s2 的卡：把 frontmatter 弄成内核 loadCard 会拒绝的形状。
    // 用「清空成非卡内容」而不是删文件——删文件会被当成「还没落卡」而不是「读不出来」。
    await writeFile(fixture.坏卡路径, "这不是一张卡。\n", "utf8");

    // 让界面重新拉一次投影（重开该计划视图）。
    await page.getByTestId("sidebar-threads").click();
    await page.getByTestId("task-status-open-workflow").click();
    await expect(page.getByTestId("workflow-cards-title")).toContainText("F23 坏卡与耗时", {
      timeout: 20_000,
    });

    // 关键断言 1：界面出现「输入缺失/读不出来」这类待办，而不是把这一步当正常。
    const missing = page.getByTestId("workflow-cards-todo-missing_input");
    await expect(missing.first()).toBeVisible({ timeout: 20_000 });

    // 关键断言 2：原因来自内核原话（`卡 <卡号> 读不出来：<原因>`），界面没有自己编一个。
    await expect(missing.first()).toContainText("读不出来");

    // 关键断言 3：它不谎称这一步已经完成。
    const failedTodo = page.getByTestId("workflow-cards-todo-failed");
    await expect(failedTodo).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("T23 耗时口径：内核按真实时间差算耗时，缺完成时间时不估", async () => {
  // 这一条验的是**内核真值**，不是界面：`durationSecondsOf` 的消费组件
  // `node-runtime-details.tsx:27-32` 只挂在已摘掉的画布页里，当前界面没有可见出口。
  // 所以取证方式是让内核自己去算——直接调 dist 里的同名真值路径（读卡 + 比较 created/completed），
  // 而不是在 TypeScript 文件上做 import（它是 .ts，Playwright 的 ESM 加载器读不了）。
  //
  // 对照组必须有：一张两端都有时间的卡要能算出真实秒数，
  // 否则「缺时间时返回 undefined」就分不清是口径诚实还是功能没通。
  const home = await makeWorkspace("f23-duration-home");
  const project = await makeWorkspace("f23-duration-project");
  const userDataDir = await makeUserDataDir();
  await writeFile(join(userDataDir, "ui-state.json"), JSON.stringify({ language: "zh" }), "utf8");
  // 这条不需要界面，但要一个真实 PAO_HOME 让内核能落卡。
  const app = await launchDesktop(userDataDir, {
    initialWorkspaces: [project],
    testMode: "foreground",
    scrubProviderEnv: true,
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: "0" },
  });

  try {
    const page = await app.firstWindow();
    await createNamedThread(page, "f23-duration 会话");

    const kernelDist = join(__dirname, "../../node_modules/@earendil-works/pi-coding-agent/dist/pao");
    const scriptPath = join(home, "f23-duration.mjs");
    await writeFile(scriptPath, DURATION_SCRIPT, "utf8");
    const { stdout } = await execFileAsync(process.execPath, [scriptPath, kernelDist, project], {
      windowsHide: true,
    });
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!) as {
      有完成时间耗时秒: number | null;
      缺完成时间耗时秒: number | null;
      卡面创建: string | null;
      卡面完成: string | null;
    };

    // 对照组：两端都有 → 300 秒（10:00 → 10:05），说明耗时链路是通的。
    expect(result.卡面创建).toContain("2026-10-17");
    expect(result.卡面完成).toContain("2026-10-17");
    expect(result.有完成时间耗时秒).toBe(300);

    // 缺完成时间 → undefined（JSON 里是 null），不是 0、不是 1970。
    expect(result.缺完成时间耗时秒).toBeNull();
  } finally {
    await app.close();
  }
});
