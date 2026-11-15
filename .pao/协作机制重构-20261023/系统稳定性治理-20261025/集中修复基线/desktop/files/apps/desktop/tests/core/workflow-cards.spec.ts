/**
 * 步骤卡工作台的真实 Electron 验收（通用工作台计划阶段 5）。
 *
 * 夹具全部由内核自己的构建产物生成：临时计划定义、启动关联、控制正本、卡与回执，
 * 都是 `dist/pao` 里那套真实 API 写出来的，不是手抄的形状。界面读到的状态、产物路径、
 * 文件正文因此都来自磁盘，而不是测试替身。
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import {
  clickSession,
  createSessionViaIpc,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

const execFileAsync = promisify(execFile);

const ARTIFACT_MARKER = "CARD-ARTIFACT-ON-DISK";

// 「同一路径跨轮次」夹具用的三个标记与那条路径：两轮正文内容不同，盘上最终只剩第 2 轮内容。
const ROUND_ONE_MARKER = "ROUND-ONE-BODY";
const ROUND_TWO_MARKER = "ROUND-TWO-BODY";
const ROUND_ONE_OPINION = "第 1 轮的开场太慢，请重写开场。";
const ROUNDS_ARTIFACT_PATH = "创作成果/初稿.md";

/**
 * 夹具脚本：跑在 Node 里，只 import 内核构建产物（argv: kernelDist, project）。
 * 造出「第 1 步已交付且有人工门、第 2 步进行中、3–5 步等待前序」的真实现场。
 */
const FIXTURE_SCRIPT = `
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
  来源会话: "sess-cards-1",
  请求ID: "req-cards-1",
  已注册部门: ["策划部", "写作部", "审稿部"],
  步骤: [
    { 标题: "讨论计划", 部门: "策划部", 要求: "把方向与章节计划讨论清楚", 人工门: true },
    // 第 2 步不依赖第 1 步：人工门未确认时第 1 步停在「等你确认」，第 2 步照样能独立开工——
    // 这是真实状态机的行为（未确认的人工门不会让无关分支停摆）。
    { 标题: "写初稿", 部门: "写作部", 要求: "按计划写初稿" },
    { 标题: "润色", 部门: "写作部", 要求: "把初稿的语言打磨一遍", 依赖: ["s2"] },
    { 标题: "审稿", 部门: "审稿部", 要求: "核对人物与情节一致性", 依赖: ["s3"] },
    { 标题: "定稿", 部门: "策划部", 要求: "定稿并归档", 依赖: ["s4"] },
  ],
  当刻: "2026-10-14 10:00",
});

const execution = plan.resolvePlanExecution({
  项目根: project,
  计划ID: created.计划ID,
  启动请求ID: "start-1",
  定义版本: 1,
  来源会话: "sess-cards-1",
});
await driver.startWorkflow(execution.配方, {}, {
  cardsDir: execution.卡目录,
  workspaceDir: execution.工作区,
  ownerSessionId: "sess-cards-1",
});
const identity = plan.readPlanInstanceIdentity(execution.工作区, execution.配方名);
if (!identity) throw new Error("实例身份读不出来");
plan.recordPlanStart(execution.关联路径, {
  计划ID: created.计划ID,
  定义版本: 1,
  启动请求ID: "start-1",
  实例: identity.实例,
  配方名: execution.配方名,
  工作区: execution.工作区,
  卡目录: execution.卡目录,
  控制清单: execution.控制清单,
  owner会话: "sess-cards-1",
  受理时刻: "2026-10-14 10:01",
});

const options = {
  cardsDir: execution.卡目录,
  workspaceDir: execution.工作区,
  ownerSessionId: "sess-cards-1",
  // 建卡时钟注入：卡面 created 必须是确定的，界面耗时（created→completed）才有可断言的期望值。
  // 不注入就取真实当前时间，会比夹具写死的 completed 还晚 ⇒ 耗时被钳成 0，测不出东西。
  now: () => "2026-10-14 10:00",
};
const identityOf = (节点) => ({ 实例: identity.实例, 节点, 轮次: 1, 部长会话: "sess-cards-1" });
const status = (卡号, to, 时间) =>
  cards.changeCardStatus(cards.loadCard(execution.卡目录, cards.parseCardRef(卡号)), {
    操作者: "sess-cards-1",
    to,
    时间,
  });

// 第 1 步：盘上先有真实产物，再走真实绑定 → 派卡 → 认领 → 回执 → 交付 → 拆解结束。
// 回执里的产物路径按「相对项目根」记（派卡提示的口径），所以文件写在项目根下。
mkdirSync(join(project, "创作成果"), { recursive: true });
writeFileSync(join(project, "创作成果", "初稿.md"), "# 初稿\\n\\n${ARTIFACT_MARKER}\\n", "utf8");
await control.bindMinister(execution.配方, options, "s1", "sess-cards-1");
const [first] = await control.addNodeCards(execution.配方, options, identityOf("s1"), [
  { goal: "写初稿", acceptance: "初稿可读" },
]);
status(first, "in_progress", "2026-10-14 10:05");
cards.appendReceipt(cards.loadCard(execution.卡目录, cards.parseCardRef(first)), {
  尝试号: 1,
  时间: "2026-10-14 10:30",
  结果: "success",
  摘要: "初稿完成",
  产物路径: ["创作成果/初稿.md"],
});
status(first, "delivered", "2026-10-14 10:31");
await control.endDecomposition(execution.配方, options, identityOf("s1"));

// 第 2 步：前置完成才绑得上部长；进行中，没有回执也没有产物。
await control.bindMinister(execution.配方, options, "s2", "sess-cards-1");
const [second] = await control.addNodeCards(execution.配方, options, identityOf("s2"), [
  { goal: "写初稿", acceptance: "初稿可读" },
]);
status(second, "in_progress", "2026-10-14 10:40");

console.log(JSON.stringify({
  计划ID: created.计划ID,
  项目根: project,
  工作区: execution.工作区,
  卡目录: execution.卡目录,
  控制清单: execution.控制清单,
  配方名: execution.配方名,
  实例: identity.实例,
}));
`;

/**
 * 「同一前置的只读并行分支」夹具脚本（argv: kernelDist, project）。
 *
 * 为什么用只读 + 同前置 + 异部门这三个条件：内核按部门串行，只有「都只读、部门互不相同、
 * 前置相同、且都没有人工门」的步骤才真的能同时开工，界面才该把它们画成一个并行组
 * （模型 parallelStepGroups 的判据）。同部门的只读步骤仍然要串行，所以另加一对同部门只读
 * 步骤，用来验证界面**不**乱编并行组。
 */
const PARALLEL_FIXTURE_SCRIPT = `
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
  显示名: "并行分支",
  来源会话: "sess-par-1",
  请求ID: "req-par-1",
  已注册部门: ["策划部", "写作部", "资料部", "审稿部"],
  步骤: [
    { 步骤ID: "a1", 标题: "定方向", 部门: "策划部", 要求: "把方向定下来" },
    // 两个只读分支：同前置 a1、部门不同、无人工门 → 真并行。
    { 步骤ID: "b1", 标题: "查资料", 部门: "资料部", 要求: "查资料", 依赖: ["a1"], 只读: true },
    { 步骤ID: "b2", 标题: "查竞品", 部门: "审稿部", 要求: "查竞品", 依赖: ["a1"], 只读: true },
    // 同部门 + 同前置 + 都只读：内核按部门串行，界面不许把它们算成并行组。
    { 步骤ID: "c1", 标题: "写作子项甲", 部门: "写作部", 要求: "甲", 依赖: ["a1"], 只读: true },
    { 步骤ID: "c2", 标题: "写作子项乙", 部门: "写作部", 要求: "乙", 依赖: ["a1"], 只读: true },
    // 单前置链尾：依赖 b2，等 b2 完成后才轮得到。
    { 步骤ID: "d1", 标题: "汇总", 部门: "策划部", 要求: "汇总", 依赖: ["b2"] },
    // 多前置链尾：同时依赖 c1、c2 两条同部门分支，界面的等待原因必须把两条都写出来。
    { 步骤ID: "e1", 标题: "归档", 部门: "策划部", 要求: "归档", 依赖: ["c1", "c2"] },
  ],
  当刻: "2026-10-16 09:00",
});

const execution = plan.resolvePlanExecution({
  项目根: project,
  计划ID: created.计划ID,
  启动请求ID: "start-par-1",
  定义版本: 1,
  来源会话: "sess-par-1",
});
await driver.startWorkflow(execution.配方, {}, {
  cardsDir: execution.卡目录,
  workspaceDir: execution.工作区,
  ownerSessionId: "sess-par-1",
});
const identity = plan.readPlanInstanceIdentity(execution.工作区, execution.配方名);
if (!identity) throw new Error("实例身份读不出来");
plan.recordPlanStart(execution.关联路径, {
  计划ID: created.计划ID,
  定义版本: 1,
  启动请求ID: "start-par-1",
  实例: identity.实例,
  配方名: execution.配方名,
  工作区: execution.工作区,
  卡目录: execution.卡目录,
  控制清单: execution.控制清单,
  owner会话: "sess-par-1",
  受理时刻: "2026-10-16 09:01",
});

// 只让第 1 步交付并把拆解收尾，其余分支停在「等待前序」，界面上就应该看到并行组成立、
// 且同一 d1 同时等 b1/b2 两条前置（多前置的等待原因）。
const options = {
  cardsDir: execution.卡目录,
  workspaceDir: execution.工作区,
  ownerSessionId: "sess-par-1",
};
const identityOf = (节点) => ({ 实例: identity.实例, 节点, 轮次: 1, 部长会话: "sess-par-1" });
const status = (卡号, to, 时间) =>
  cards.changeCardStatus(cards.loadCard(execution.卡目录, cards.parseCardRef(卡号)), {
    操作者: "sess-par-1",
    to,
    时间,
  });

await control.bindMinister(execution.配方, options, "a1", "sess-par-1");
const [a1card] = await control.addNodeCards(execution.配方, options, identityOf("a1"), [
  { goal: "定方向", acceptance: "方向可执行" },
]);
status(a1card, "in_progress", "2026-10-16 09:05");
status(a1card, "delivered", "2026-10-16 09:20");
await control.endDecomposition(execution.配方, options, identityOf("a1"));

console.log(JSON.stringify({
  计划ID: created.计划ID,
  项目根: project,
  工作区: execution.工作区,
  控制清单: execution.控制清单,
}));
`;

async function launchParallelFixture() {
  const home = await makeWorkspace("par-home");
  const project = await makeWorkspace("par-project");
  await mkdir(join(home, "部门"), { recursive: true });
  await writeFile(join(home, "部门", "注册表.md"), REGISTRY, "utf8");

  const kernelDist = join(__dirname, "../../node_modules/@earendil-works/pi-coding-agent/dist/pao");
  const fixtureScript = join(home, "make-par-fixture.mjs");
  await writeFile(fixtureScript, PARALLEL_FIXTURE_SCRIPT, "utf8");
  const { stdout } = await execFileAsync(process.execPath, [fixtureScript, kernelDist, project], {
    windowsHide: true,
  });
  const fixture = JSON.parse(stdout.trim().split("\n").at(-1)!) as {
    计划ID: string;
    项目根: string;
    工作区: string;
    控制清单: string;
  };

  const userDataDir = await makeUserDataDir();
  await writeFile(join(userDataDir, "ui-state.json"), JSON.stringify({ language: "zh" }), "utf8");

  const app = await launchDesktop(userDataDir, {
    initialWorkspaces: [project],
    testMode: "background",
    scrubProviderEnv: true,
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: "1" },
  });
  return { app, project, home, fixture };
}

const REGISTRY = `# 部门注册表

<!-- 唯一真相:名字/能力标签/库路径/建部日期 -->

| 名字 | 能力标签 | 库路径 | 建部日期 |
| --- | --- | --- | --- |
| 策划部 | 策划 | 部门/策划部/知识库 | 2026-10-14 |
| 写作部 | 写作 | 部门/写作部/知识库 | 2026-10-14 |
| 审稿部 | 审稿 | 部门/审稿部/知识库 | 2026-10-14 |
`;

async function launchWorkflowCardsFixture() {
  const home = await makeWorkspace("cards-home");
  const project = await makeWorkspace("cards-project");
  await mkdir(join(home, "部门"), { recursive: true });
  await writeFile(join(home, "部门", "注册表.md"), REGISTRY, "utf8");

  const kernelDist = join(__dirname, "../../node_modules/@earendil-works/pi-coding-agent/dist/pao");
  const fixtureScript = join(home, "make-cards-fixture.mjs");
  await writeFile(fixtureScript, FIXTURE_SCRIPT, "utf8");
  const { stdout } = await execFileAsync(process.execPath, [fixtureScript, kernelDist, project], {
    windowsHide: true,
  });
  const fixture = JSON.parse(stdout.trim().split("\n").at(-1)!) as {
    计划ID: string;
    项目根: string;
    工作区: string;
    卡目录: string;
    控制清单: string;
    配方名: string;
    实例: string;
  };

  // 坏计划：目录在、定义读不出来。界面必须点名路径与原因（§8.2 错误出口），
  // 不能静默当成「这个项目还没有计划」。
  await mkdir(join(project, ".pao", "临时工作流", "p-20261014-broken"), { recursive: true });
  await writeFile(
    join(project, ".pao", "临时工作流", "p-20261014-broken", "计划.md"),
    "这不是合法的计划定义：没有 frontmatter\n",
    "utf8",
  );

  // 中文界面：预置语言，断言的是产品要交付的中文文案（默认 en 会渲染英文源串）。
  const userDataDir = await makeUserDataDir();
  await writeFile(join(userDataDir, "ui-state.json"), JSON.stringify({ language: "zh" }), "utf8");

  const app = await launchDesktop(userDataDir, {
    initialWorkspaces: [project],
    testMode: "background",
    scrubProviderEnv: true,
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: "1" },
  });
  return { app, project, home, fixture };
}

/**
 * 「同一成果路径跨轮次」夹具脚本（argv: kernelDist, project）。
 *
 * 为什么必须走真实回边把节点推进到第 2 轮，而不是手写两轮状态：
 * 产物版本依据（「第 N 轮（卡XXXX）」）是内核 `stepProgress` 从控制正本的
 * 「当前轮次卡 + 历史轮次卡」推出来的。只有让审核节点真跑一次 `decideNode(change)`，
 * 状态机才会做那件关键的事——把上游写作节点的旧卡挪进 `历史[]` 并把 `轮次` 加一，
 * 再让第 2 轮的卡以同一路径写回执。手改控制正本既绕过了状态机，也就测不到
 * 「同一路径真的会有两条版本记录、且当前轮只有一条」这件事。
 *
 * 盘上只有一份文件：第 2 轮把同一路径重写了一遍，所以这一版没有按轮次留存的副本，
 * 界面的「覆盖后正文」提示才成立（这也正是要验的用户处境）。
 */
const ROUNDS_FIXTURE_SCRIPT = `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [kernelDist, project] = process.argv.slice(2);
const load = (relative) => import(pathToFileURL(join(kernelDist, relative)).href);

const plan = await load("workflow/plan.js");
const driver = await load("workflow/driver.js");
const control = await load("workflow/control.js");
const cards = await load("cards/index.js");
const feedback = await load("workflow/plan-feedback.js");

const PATH = "${ROUNDS_ARTIFACT_PATH}";

const created = await plan.createTemporaryPlan({
  项目根: project,
  显示名: "跨轮次版本",
  来源会话: "sess-rounds-1",
  请求ID: "req-rounds-1",
  已注册部门: ["写作部", "审稿部"],
  // 审核步骤声明一条指向上游写作步骤的回边：上限 0 表示不限次（永不因超限停滞），
  // 这是状态机认可的「打回重做」通道；写作步骤不给人工门，否则它的完成条件永远差一个确认，
  // 审核步骤也永远就绪不了。
  步骤: [
    { 步骤ID: "w1", 标题: "写初稿", 部门: "写作部", 要求: "写出初稿" },
    {
      步骤ID: "r1",
      标题: "审稿",
      部门: "审稿部",
      要求: "核对初稿是否达标",
      依赖: ["w1"],
      审核: true,
      部门标准: "开场必须抓住读者",
      回边: [{ 目标: "w1", 上限: 0, 超限动作: "停滞" }],
    },
  ],
  当刻: "2026-10-15 09:00",
});

const execution = plan.resolvePlanExecution({
  项目根: project,
  计划ID: created.计划ID,
  启动请求ID: "start-rounds-1",
  定义版本: 1,
  来源会话: "sess-rounds-1",
});
await driver.startWorkflow(execution.配方, {}, {
  cardsDir: execution.卡目录,
  workspaceDir: execution.工作区,
  ownerSessionId: "sess-rounds-1",
});
const identity = plan.readPlanInstanceIdentity(execution.工作区, execution.配方名);
if (!identity) throw new Error("实例身份读不出来");
plan.recordPlanStart(execution.关联路径, {
  计划ID: created.计划ID,
  定义版本: 1,
  启动请求ID: "start-rounds-1",
  实例: identity.实例,
  配方名: execution.配方名,
  工作区: execution.工作区,
  卡目录: execution.卡目录,
  控制清单: execution.控制清单,
  owner会话: "sess-rounds-1",
  受理时刻: "2026-10-15 09:01",
});

const options = {
  cardsDir: execution.卡目录,
  workspaceDir: execution.工作区,
  ownerSessionId: "sess-rounds-1",
};
// 轮次必须显式给：identify 会核对轮次，第 2 轮再用轮次 1 会被状态机拒掉。
const identityOf = (节点, 轮次) => ({ 实例: identity.实例, 节点, 轮次, 部长会话: "sess-rounds-1" });
const status = (卡号, to, 时间) =>
  cards.changeCardStatus(cards.loadCard(execution.卡目录, cards.parseCardRef(卡号)), {
    操作者: "sess-rounds-1",
    to,
    时间,
  });
const receipt = (卡号, 时间, 摘要) =>
  cards.appendReceipt(cards.loadCard(execution.卡目录, cards.parseCardRef(卡号)), {
    尝试号: 1,
    时间,
    结果: "success",
    摘要,
    产物路径: [PATH],
  });

mkdirSync(join(project, "创作成果"), { recursive: true });
const writeBody = (marker) =>
  writeFileSync(join(project, "创作成果", "初稿.md"), "# 初稿\\n\\n" + marker + "\\n", "utf8");

// ── 第 1 轮：写作步骤交付同一路径，审核步骤走完并给出 change 判定 ────────────────
writeBody("${ROUND_ONE_MARKER}");
await control.bindMinister(execution.配方, options, "w1", "sess-rounds-1");
const [w1r1] = await control.addNodeCards(execution.配方, options, identityOf("w1", 1), [
  { goal: "写初稿", acceptance: "初稿可读" },
]);
status(w1r1, "in_progress", "2026-10-15 09:05");
receipt(w1r1, "2026-10-15 09:30", "第 1 轮初稿完成");
status(w1r1, "delivered", "2026-10-15 09:31");
await control.endDecomposition(execution.配方, options, identityOf("w1", 1));

await control.bindMinister(execution.配方, options, "r1", "sess-rounds-1");
const [r1r1] = await control.addNodeCards(execution.配方, options, identityOf("r1", 1), [
  { goal: "审初稿", acceptance: "判定初稿是否达标" },
]);
status(r1r1, "in_progress", "2026-10-15 09:40");
status(r1r1, "delivered", "2026-10-15 09:50");
await control.endDecomposition(execution.配方, options, identityOf("r1", 1));

// 真实打回：只影响「目标 + 依赖链下游」，两个节点一起进第 2 轮，旧卡进历史、当前卡清空。
await control.decideNode(execution.配方, options, identityOf("r1", 1), {
  结果: "change",
  目标: "w1",
  理由: "开场太慢，退回重写初稿",
  失败轴: "card",
  引用: [PATH + ":1"],
});

// ── 第 2 轮：同一路径用新内容重写（盘上只剩这一版），回执仍记同一路径 ────────────
writeBody("${ROUND_TWO_MARKER}");
await control.bindMinister(execution.配方, options, "w1", "sess-rounds-1");
const [w1r2] = await control.addNodeCards(execution.配方, options, identityOf("w1", 2), [
  { goal: "重写初稿", acceptance: "开场达标" },
]);
status(w1r2, "in_progress", "2026-10-15 10:05");
receipt(w1r2, "2026-10-15 10:30", "第 2 轮初稿完成");
status(w1r2, "delivered", "2026-10-15 10:31");
await control.endDecomposition(execution.配方, options, identityOf("w1", 2));

// 针对第 1 轮记一条文件意见：来源会话须与计划的来源主控一致，版本依据要记清「读的是哪一版」。
await feedback.recordPlanFeedback({
  项目根: project,
  计划ID: created.计划ID,
  来源会话: "sess-rounds-1",
  目标: { 类型: "文件", 步骤ID: "w1", 轮次: 1, 路径: PATH, 版本依据: \`第 1 轮（\${w1r1}）\` },
  正文: "${ROUND_ONE_OPINION}",
  当刻: "2026-10-15 11:00",
});

console.log(JSON.stringify({
  计划ID: created.计划ID,
  项目根: project,
  工作区: execution.工作区,
  卡目录: execution.卡目录,
  控制清单: execution.控制清单,
  配方名: execution.配方名,
  实例: identity.实例,
  第1轮卡: w1r1,
  第2轮卡: w1r2,
}));
`;

async function launchRoundVersionsFixture() {
  const home = await makeWorkspace("rounds-home");
  const project = await makeWorkspace("rounds-project");
  await mkdir(join(home, "部门"), { recursive: true });
  await writeFile(join(home, "部门", "注册表.md"), REGISTRY, "utf8");

  const kernelDist = join(__dirname, "../../node_modules/@earendil-works/pi-coding-agent/dist/pao");
  const fixtureScript = join(home, "make-rounds-fixture.mjs");
  await writeFile(fixtureScript, ROUNDS_FIXTURE_SCRIPT, "utf8");
  const { stdout } = await execFileAsync(process.execPath, [fixtureScript, kernelDist, project], {
    windowsHide: true,
  });
  const fixture = JSON.parse(stdout.trim().split("\n").at(-1)!) as {
    计划ID: string;
    项目根: string;
    工作区: string;
    卡目录: string;
    控制清单: string;
    配方名: string;
    实例: string;
    第1轮卡: string;
    第2轮卡: string;
  };

  const userDataDir = await makeUserDataDir();
  await writeFile(join(userDataDir, "ui-state.json"), JSON.stringify({ language: "zh" }), "utf8");

  const app = await launchDesktop(userDataDir, {
    initialWorkspaces: [project],
    testMode: "background",
    scrubProviderEnv: true,
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: "1" },
  });
  return { app, project, home, fixture };
}

test("步骤卡工作台按真实计划渲染，步骤状态、人工门与真实产物都来自磁盘", async () => {
  const { app, fixture } = await launchWorkflowCardsFixture();
  try {
    const page = await app.firstWindow();
    await page.getByTestId("task-status-open-workflow").click();

    // 坏计划文件要点名路径与原因，不静默当「没有计划」（§8.2 错误出口）。
    await expect(page.getByTestId("workflow-cards-issues")).toContainText("p-20261014-broken");

    // 计划本身来自 <项目>/.pao/临时工作流/<计划ID>/计划.md。
    await expect(page.getByTestId("workflow-cards-title")).toContainText("小说首章");
    await expect(page.getByTestId("workflow-cards-summary-total")).toContainText("5");
    // 第 1 步的卡已交付，但它有人工门且没确认过 → 是「等你确认」，不是「已完成」。
    await expect(page.getByTestId("workflow-cards-summary-review")).toContainText("1");
    await expect(page.getByTestId("workflow-cards-progress")).toContainText("0 / 5");
    await expect(page.getByTestId("workflow-cards-step-s1")).toHaveAttribute(
      "data-state",
      "review",
    );
    // 第 2 步的卡还在 in_progress，但内核控制正本同时写着挂起原因「等待部长本轮拆解结束」
    // （夹具绑了部长会话却没调 endDecomposition，所以拆解没结束）。挂起说明在场的步骤就是停着的，
    // 报成「执行中」会把卡住的活说成还在跑 → 界面的真实状态是「等部长」（计划 §7.1 第 3 条）。
    await expect(page.getByTestId("workflow-cards-step-s2")).toHaveAttribute(
      "data-state",
      "waitLead",
    );
    for (const stepId of ["s3", "s4", "s5"]) {
      await expect(page.getByTestId(`workflow-cards-step-${stepId}`)).toHaveAttribute(
        "data-state",
        "waiting",
      );
    }
    // 等待原因要指名道姓，不是只说「等待」。
    await expect(page.getByTestId("workflow-cards-hold-s3")).toContainText("第 2 步");

    // 成果文件：只有第 1 步有真实产物；第 2 步必须明确写「尚未产出」。
    await page.getByTestId("workflow-cards-tab-output").click();
    await expect(page.getByTestId("workflow-cards-no-artifact-s2")).toBeVisible();
    const artifact = page.getByTestId("workflow-cards-artifact-创作成果/初稿.md");
    await expect(artifact).toContainText("盘上存在");
    await artifact.click();

    // 右栏正文是磁盘上那个文件的真内容，不是示例。
    await expect(page.getByTestId("workflow-cards-file-preview")).toBeVisible();
    await expect(page.getByTestId("workflow-cards-file-body")).toContainText(ARTIFACT_MARKER);
    await expect(page.getByTestId("workflow-cards-file-origin")).toContainText("第 1 步");
    // 版本依据要跟着产物一起显示：用户能看出这条正文是哪一轮哪张卡产出的。
    await expect(page.getByTestId("workflow-cards-file-origin")).toContainText("第 1 轮");
    // 只有一轮时不显示版本切换行，也不编「有新版本」的提示。
    await expect(page.getByTestId("workflow-cards-file-versions")).toHaveCount(0);
    await expect(page.getByTestId("workflow-cards-file-newer")).toHaveCount(0);
    expect(existsSync(join(fixture.项目根, "创作成果", "初稿.md"))).toBe(true);

    // 定位所属步骤：切回步骤视图并选中第 1 步，文件预览页签仍然打开。
    await page.getByTestId("workflow-cards-locate-step").click();
    await expect(page.getByTestId("workflow-cards-step-s1")).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expect(page.getByTestId("workflow-cards-panel-file")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  } finally {
    await app.close();
  }
});

test("耗时只报卡面 created→completed；没卡就说「暂无卡」，不拿轮次或会话时长顶替", async () => {
  const { app } = await launchWorkflowCardsFixture();
  try {
    const page = await app.firstWindow();
    await page.getByTestId("task-status-open-workflow").click();

    // 第 1 步的卡：created 10:00、delivered 10:31（夹具注入了建卡时钟）⇒ 31 分钟。
    await page.getByTestId("workflow-cards-step-s1").click();
    await expect(page.getByTestId("workflow-cards-detail-duration")).toContainText("耗时");
    await expect(page.getByTestId("workflow-cards-detail-duration")).toContainText("31 分钟");

    // 第 2 步的卡在跑、没有 completed ⇒ 如实说「未记录」，不是 0 秒。
    await page.getByTestId("workflow-cards-step-s2").click();
    await expect(page.getByTestId("workflow-cards-detail-duration")).toContainText("未记录");

    // 第 3 步还没落卡 ⇒ 明确说「暂无卡」，不能拿别的数顶上。
    await page.getByTestId("workflow-cards-step-s3").click();
    await expect(page.getByTestId("workflow-cards-detail-duration")).toContainText("暂无卡");
  } finally {
    await app.close();
  }
});

test("搜索与筛选只在界面上收窄，不改写计划；人工门确认在无 owner 会话时如实报失败", async () => {
  const { app, fixture } = await launchWorkflowCardsFixture();
  try {
    const page = await app.firstWindow();
    await page.getByTestId("task-status-open-workflow").click();
    await expect(page.getByTestId("workflow-cards-title")).toContainText("小说首章");

    // 搜索：总数仍显示全量，另给「显示 N / 5」。
    await page.locator(".workflow-cards__filter-panel > summary").click();
    await page.getByTestId("workflow-cards-search").fill("审稿");
    await expect(page.getByTestId("workflow-cards-filtered-count")).toContainText("1 / 5");
    await expect(page.getByTestId("workflow-cards-step-s1")).toHaveCount(0);
    await expect(page.getByTestId("workflow-cards-step-s4")).toBeVisible();
    await page.getByTestId("workflow-cards-search").fill("");

    // 状态筛选：只看等待前序的步骤。
    await page.getByTestId("workflow-cards-filter-waiting").click();
    await expect(page.getByTestId("workflow-cards-step-s1")).toHaveCount(0);
    await expect(page.getByTestId("workflow-cards-step-s3")).toBeVisible();
    await page.getByTestId("workflow-cards-filter-waiting").click();

    // 下个待处理：人工门那一步算「待处理」，跳到 s1。
    await page.getByTestId("workflow-cards-next-pending").click();
    await expect(page.getByTestId("workflow-cards-step-s1")).toHaveAttribute(
      "aria-current",
      "true",
    );

    // 界面没有写通道：确认动作发给主控会话，这个夹具里没有活着的 owner 会话，必须如实失败。
    const before = await readFile(fixture.控制清单, "utf8");
    await expect(page.getByTestId("workflow-cards-control-note")).toHaveCount(0);
    await page.getByTestId("workflow-cards-expand-s1").click();
    await page.getByTestId("workflow-cards-confirm-s1").click();
    await expect(page.getByTestId("workflow-cards-action-error")).toBeVisible();
    await expect(page.getByTestId("workflow-cards-action-note")).toHaveCount(0);
    expect(await readFile(fixture.控制清单, "utf8")).toBe(before);

    // 暂停必须先写理由：空理由当场拦下，不发请求。
    await page.getByTestId("workflow-cards-pause").click();
    await expect(page.getByTestId("workflow-cards-action-error")).toContainText("暂停");
    expect(await readFile(fixture.控制清单, "utf8")).toBe(before);

    // 理由齐全时发真请求；仍无 owner 会话 → 仍如实失败，控制正本一个字没动。
    await page.getByTestId("workflow-cards-reason").fill("夹具里没有活着的 owner 会话");
    await page.getByTestId("workflow-cards-pause").click();
    await expect(page.getByTestId("workflow-cards-action-error")).toBeVisible();
    expect(await readFile(fixture.控制清单, "utf8")).toBe(before);
  } finally {
    await app.close();
  }
});

test("单卡停止入口只出现在执行中的步骤，点了只把指令交给主控，不动计划", async () => {
  const { app, fixture } = await launchWorkflowCardsFixture();
  try {
    const page = await app.firstWindow();
    // 底部「主控对话」复用当前会话：没有打开的会话就没有输入框，所以先开一个再切到工作台。
    await createSessionViaIpc(page, fixture.项目根, "停卡验证会话");
    await clickSession(page, "停卡验证会话");
    await page.getByTestId("task-status-open-workflow").click();
    await expect(page.getByTestId("workflow-cards-title")).toContainText("小说首章");

    // 只有第 2 步真的有一张执行中的卡；其余步骤没有可停的卡，就不该有这个入口。
    await expect(page.getByTestId("workflow-cards-stop-s2")).toBeVisible();
    await expect(page.getByTestId("workflow-cards-stop-s1")).toHaveCount(0);
    await expect(page.getByTestId("workflow-cards-stop-s3")).toHaveCount(0);

    const before = await readFile(fixture.控制清单, "utf8");
    await page.getByTestId("workflow-cards-stop-s2").click();

    // 页面没有写通道：指令进主控输入框，卡号取自控制正本，控制正本一个字没动。
    const composer = page.getByTestId("composer");
    await expect(composer).toHaveValue(/步骤 s2/);
    await expect(composer).toHaveValue(/卡\d{4} 停掉/);
    await expect(composer).toHaveValue(/pao_change_status/);
    expect(await readFile(fixture.控制清单, "utf8")).toBe(before);
  } finally {
    await app.close();
  }
});

test("三种窗口宽度与 125% 缩放下不横向溢出，键盘与读屏语义可用", async () => {
  const { app } = await launchWorkflowCardsFixture();
  try {
    const page = await app.firstWindow();
    await page.getByTestId("task-status-open-workflow").click();
    await expect(page.getByTestId("workflow-cards-title")).toContainText("小说首章");

    const fitsViewport = () =>
      page.evaluate(() => {
        const root = document.documentElement;
        return root.scrollWidth <= root.clientWidth + 1;
      });

    for (const width of [700, 900, 1280]) {
      await app.electronApp.evaluate(({ BrowserWindow }, nextWidth) => {
        BrowserWindow.getAllWindows()[0]?.setSize(nextWidth, 800);
      }, width);
      await expect(page.getByTestId("workflow-cards-title")).toBeVisible();
      expect(await fitsViewport()).toBe(true);
      // 窄到 700px 时右栏折到中栏下方，但仍然在，不是被裁掉。
      await expect(page.getByTestId("workflow-cards-steps")).toBeVisible();
      await expect(page.getByTestId("workflow-cards-inspector")).toBeVisible();
      await page.screenshot({ path: test.info().outputPath(`workflow-cards-${width}.png`) });
    }

    await page.locator(".workflow-cards__filter-panel > summary").click();
    // 系统缩放 125%：按系统缩放放大后仍不许横向溢出，控件仍可见（§5.2 的缩放检查）。
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1.25);
    });
    await expect(page.getByTestId("workflow-cards-title")).toBeVisible();
    expect(await fitsViewport()).toBe(true);
    await expect(page.getByTestId("workflow-cards-search")).toBeVisible();
    await expect(page.getByTestId("workflow-cards-next-pending")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("workflow-cards-zoom-125.png") });
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1);
    });

    // 键盘可达：搜索框能聚焦，状态筛选能被 Space 切换（按钮原生语义）。
    await page.getByTestId("workflow-cards-search").focus();
    await expect(page.getByTestId("workflow-cards-search")).toBeFocused();
    const doneFilter = page.getByTestId("workflow-cards-filter-done");
    await doneFilter.focus();
    await expect(doneFilter).toBeFocused();
    await page.keyboard.press("Space");
    await expect(doneFilter).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Space");
    await expect(doneFilter).toHaveAttribute("aria-pressed", "false");

    // 读屏语义：搜索框有可读名字、筛选是一组、步骤卡在列表里且当前步骤标了 aria-current。
    await expect(page.getByTestId("workflow-cards-search")).toHaveAttribute("aria-label", /.+/);
    await expect(page.getByRole("group", { name: "按状态筛选" })).toBeVisible();
    await expect(page.getByTestId("workflow-cards-steps")).toHaveRole("list");
    await expect(page.getByTestId("workflow-cards-step-s1")).toHaveRole("listitem");
    await expect(page.getByTestId("workflow-cards-step-s1")).toHaveAttribute(
      "aria-current",
      "true",
    );
  } finally {
    await app.close();
  }
});

test("同路径多轮次：新版只提示不抢换，用户主动切换后正文与意见跟到同一版本", async () => {
  // 夹具要把审核节点跑到「判定 → 回边 → 第 2 轮重做」全程，比其它用例重，给足时间。
  test.setTimeout(180_000);
  const { app, fixture } = await launchRoundVersionsFixture();
  try {
    const page = await app.firstWindow();
    await page.getByTestId("task-status-open-workflow").click();
    await expect(page.getByTestId("workflow-cards-title")).toContainText("跨轮次版本");
    await page.getByTestId("workflow-cards-tab-output").click();

    // ① 同一相对路径两条产物记录：这是内核 stepProgress 把「历史轮次卡 + 当前轮次卡」都摊开的结果，
    //    不许按路径去重吞掉历史（否则用户再也看不到自己读过的那一版）。
    const rows = page.getByTestId(`workflow-cards-artifact-${ROUNDS_ARTIFACT_PATH}`);
    await expect(rows).toHaveCount(2);
    const roundOneRow = page.locator(
      `[data-testid="workflow-cards-artifact-${ROUNDS_ARTIFACT_PATH}"][data-round="1"]`,
    );
    const roundTwoRow = page.locator(
      `[data-testid="workflow-cards-artifact-${ROUNDS_ARTIFACT_PATH}"][data-round="2"]`,
    );
    await expect(roundOneRow).toHaveCount(1);
    await expect(roundTwoRow).toHaveCount(1);

    // ② 轮次归属写在每条记录的版本依据里：第 2 轮是当前轮次（不追加任何字样），
    //    第 1 轮必须被明确标成「更早的版本」，用户一眼能分出哪条是旧的。
    await expect(roundOneRow.locator(".workflow-cards__rail-meta")).toContainText("第 1 轮");
    await expect(roundOneRow.locator(".workflow-cards__rail-meta")).toContainText("更早的版本");
    await expect(roundTwoRow.locator(".workflow-cards__rail-meta")).toContainText("第 2 轮");
    await expect(roundTwoRow.locator(".workflow-cards__rail-meta")).not.toContainText("更早的版本");
    // 「当前轮次」这四个字产品只在预览头与版本切换按钮上写，产物行靠「没有更早的字样」表达，
    // 所以这里按产品真实口径断言，不伪造界面没有的文案。

    // ③④ 点第 1 轮进预览：钉住第 1 轮，不因为盘上有第 2 轮就自己跳过去。
    await roundOneRow.click();
    const origin = page.getByTestId("workflow-cards-file-origin");
    await expect(page.getByTestId("workflow-cards-file-preview")).toBeVisible();
    await expect(origin).toContainText("第 1 轮");
    await expect(origin).toContainText("更早的版本");
    await expect(roundOneRow).toHaveAttribute("aria-pressed", "true");

    // 提示与切换行都到位：只提示「有更新版」，把选择权留给用户。
    const newer = page.getByTestId("workflow-cards-file-newer");
    await expect(newer).toBeVisible();
    await expect(newer).toContainText("第 2 轮");
    const versions = page.getByTestId("workflow-cards-file-versions");
    await expect(versions).toBeVisible();
    await expect(page.getByTestId("workflow-cards-file-version-1")).toHaveCount(1);
    await expect(page.getByTestId("workflow-cards-file-version-2")).toHaveCount(1);
    // 钉住的这一轮确实在记录里，不该报「这一轮已不在记录里」。
    await expect(page.getByTestId("workflow-cards-file-version-missing")).toHaveCount(0);
    await expect(page.getByTestId("workflow-cards-file-version-1")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // 提示到位之后再查一次：预览仍钉在第 1 轮（不抢换）。
    await expect(origin).toContainText("第 1 轮");

    // ⑤ 盘上同一路径已被第 2 轮覆盖、没有按轮次副本——如实说明，而不是假装能读出旧稿。
    await expect(page.getByTestId("workflow-cards-file-overwritten")).toBeVisible();
    await expect(page.getByTestId("workflow-cards-file-body")).toContainText(ROUND_TWO_MARKER);
    // 第 1 轮的正文标记不该出现：盘上那份就是新版，这里如实承认口径。
    await expect(page.getByTestId("workflow-cards-file-body")).not.toContainText(ROUND_ONE_MARKER);

    // ⑦ 针对第 1 轮记的文件意见跟着钉住的版本走：停在第 1 轮时看得见。
    await expect(page.getByTestId("workflow-cards-file-preview")).toContainText(ROUND_ONE_OPINION);

    // ⑥ 用户主动切到第 2 轮：预览头改成第 2 轮（当前轮次），「有更新版」提示随之消失，
    //    第 1 轮的那条意见也不再混在当前正文旁边。
    await page.getByTestId("workflow-cards-file-version-2").click();
    await expect(origin).toContainText("第 2 轮");
    await expect(origin).toContainText("当前轮次");
    await expect(origin).not.toContainText("更早的版本");
    await expect(newer).toHaveCount(0);
    await expect(page.getByTestId("workflow-cards-file-version-2")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByTestId("workflow-cards-file-preview")).not.toContainText(
      ROUND_ONE_OPINION,
    );

    // 回到第 1 轮：正文与意见又一起切回那一版（同一版本，不是各说各话）。
    await page.getByTestId("workflow-cards-file-version-1").click();
    await expect(origin).toContainText("第 1 轮");
    await expect(newer).toBeVisible();
    await expect(page.getByTestId("workflow-cards-file-preview")).toContainText(ROUND_ONE_OPINION);
  } finally {
    await app.close();
  }
});

test("并行分组只认真并行：同前置异部门只读成组，同部门只读不成组，多前置写全「等待第 N、M 步」", async () => {
  const { app } = await launchParallelFixture();
  try {
    const page = await app.firstWindow();
    await page.getByTestId("task-status-open-workflow").click();
    await expect(page.getByTestId("workflow-cards-title")).toContainText("并行分支");

    // 组头落在组的第一个成员上，并写清「为什么算一组」：共享前置 + 组内成员名。
    // 文案是英文 key → 中文词典，界面本身不写中文字面量，所以这里断言稳定 id（a1）与成员标题。
    const groupHead = page.getByTestId("workflow-cards-parallel-b1");
    await expect(groupHead).toBeVisible();
    await expect(groupHead).toContainText("a1");
    await expect(groupHead).toContainText("查竞品");
    // 组只写一次：成员 b2 不重复画组头。
    await expect(page.getByTestId("workflow-cards-parallel-b2")).toHaveCount(0);
    await expect(page.getByTestId("workflow-cards-step-b1")).toHaveAttribute(
      "data-parallel",
      "true",
    );
    await expect(page.getByTestId("workflow-cards-step-b2")).toHaveAttribute(
      "data-parallel",
      "true",
    );

    // 同部门 + 同前置 + 都只读：内核按部门串行，所以同一部门在一个并行组里只留一个成员——
    // c1（写作部）先到先得进组，c2（同为写作部）被挤出去自成一组、按串行排队。
    // 组头只画在组首（b1）上，所以 c1/c2 都不该有组头；c1 仍是并行组员，c2 不是。
    await expect(page.getByTestId("workflow-cards-parallel-c1")).toHaveCount(0);
    await expect(page.getByTestId("workflow-cards-parallel-c2")).toHaveCount(0);
    await expect(page.getByTestId("workflow-cards-step-c1")).toHaveAttribute(
      "data-parallel",
      "true",
    );
    await expect(page.getByTestId("workflow-cards-step-c2")).not.toHaveAttribute(
      "data-parallel",
      "true",
    );

    // 等待原因说真话：这个夹具里只有 a1 被绑定并交付，b1/b2/c1/c2 都是「没派部长会话的只读分支」，
    // 所以它们的等待原因是内核原文「等待部长会话绑定」，不能编成「等第 1 步」（第 1 步其实已完成）。
    await expect(page.getByTestId("workflow-cards-hold-b1")).toContainText("等待部长会话绑定");
    await expect(page.getByTestId("workflow-cards-hold-b2")).toContainText("等待部长会话绑定");
    await expect(page.getByTestId("workflow-cards-hold-b1")).not.toContainText("第 1 步");
    // 第 1 步已完成，所以它的卡片是「已完成」而不是「等你确认」（它没有人工门）。
    await expect(page.getByTestId("workflow-cards-step-a1")).toHaveAttribute("data-state", "done");
    // 汇总步只依赖 b2（定义顺序第 3 步）一条前置：等待原因指名那一条，且只有一个「第 N 步」。
    await expect(page.getByTestId("workflow-cards-hold-d1")).toContainText("第 3 步");
    await expect(page.getByTestId("workflow-cards-hold-d1")).not.toContainText("、");
    // 多前置写全：归档同时等 c1、c2（定义顺序第 4、5 步），两条都列，不挑一条代表。
    await expect(page.getByTestId("workflow-cards-hold-e1")).toContainText("第 4 步");
    await expect(page.getByTestId("workflow-cards-hold-e1")).toContainText("第 5 步");
    await expect(page.getByTestId("workflow-cards-hold-e1")).toContainText("、");
  } finally {
    await app.close();
  }
});

test("状态不只靠颜色：13 个细分状态各自成键，未知不译成成功，取消与失败分开", async () => {
  const { app, fixture } = await launchWorkflowCardsFixture();
  try {
    const page = await app.firstWindow();
    await page.getByTestId("task-status-open-workflow").click();
    await expect(page.getByTestId("workflow-cards-title")).toContainText("小说首章");

    // 摘要按固定顺序给每种状态一个独立数值键（模型 13 值，界面逐个摊开，不合并成「其它」）。
    for (const state of [
      "done",
      "running",
      "review",
      "waitLead",
      "waitReview",
      "waiting",
      "pending",
      "paused",
      "budget",
      "failed",
      "canceled",
      "unreadable",
      "unknown",
    ]) {
      // 首屏摘要只展示实际出现的状态，筛选仍覆盖全部状态。
      if (["review", "waitLead", "waiting"].includes(state)) {
        await expect(page.getByTestId(`workflow-cards-summary-${state}`)).toHaveAttribute(
          "data-state",
          state,
        );
      }
      // 每种状态也能单独筛，按钮带原生按下语义（键盘可用，不依赖颜色）。
      await expect(page.getByTestId(`workflow-cards-filter-${state}`)).toHaveCount(1);
    }

    // 真实状态写在卡片自己的 data-state 上，并且带上与颜色无关的可读标识：
    // 词典有译文的用中文（review 与 waitLead 均已收录），两种都不留空、不伪装。
    await expect(page.getByTestId("workflow-cards-state-s1")).toContainText("等待你的确认");
    await expect(page.getByTestId("workflow-cards-state-s2")).not.toContainText("[lead]");
    await expect(page.getByTestId("workflow-cards-state-s2")).toContainText("等待部长");
    await expect(page.getByTestId("workflow-cards-step-s2")).toHaveAttribute(
      "data-state",
      "waitLead",
    );
    // 关键区分：第 2 步的卡其实是 in_progress，但控制正本写着挂起原因，界面报「等部长」，
    // 不报「执行中」，也绝不报「已完成」。
    await expect(page.getByTestId("workflow-cards-state-s2")).not.toContainText("Done");
    await expect(page.getByTestId("workflow-cards-state-s2")).not.toContainText("Running");
    // 待处理步骤的等待原因指名单条前置，不写成笼统的「等待」。
    await expect(page.getByTestId("workflow-cards-hold-s3")).toContainText("第 2 步");
    // 展开/收起按钮的中文名（aria/焦点核对用得到）。
    await expect(page.getByTestId("workflow-cards-expand-s3")).toHaveText("展开这张卡");
    // 默认摘要不堆卡号；主动展开后仍如实说明无卡，再收起回到紧凑视图。
    await expect(page.getByTestId("workflow-cards-no-card-s3")).toHaveCount(0);
    await page.getByTestId("workflow-cards-expand-s3").click();
    await expect(page.getByTestId("workflow-cards-no-card-s3")).toHaveText("当前没有卡");
    await page.getByTestId("workflow-cards-expand-s3").click();

    // 没有取消／失败时不占摘要位置，不能拿其他状态凑数。
    await expect(page.getByTestId("workflow-cards-summary-canceled")).toHaveCount(0);
    await expect(page.getByTestId("workflow-cards-summary-failed")).toHaveCount(0);
    // 待办区只列真待办：第 1 步的人工门没确认 → 有一条 confirm 待办。
    await page.getByTestId("workflow-cards-overview").locator(":scope > summary").click();
    await expect(page.getByTestId("workflow-cards-todos")).toBeVisible();
    await expect(page.getByTestId("workflow-cards-todo-confirm")).toHaveCount(1);
    // 中文界面不留英文残字：待办区标题与摘要标签都要走词典，不许回退英文原键。
    // 断言的是真实渲染文本（D5 截图曾发现这里显示 `To-dos`／`Open items`）。
    await expect(page.getByTestId("workflow-cards-todos").locator("h2")).toHaveText("待办");
    await expect(page.getByTestId("workflow-cards-summary-todos")).toBeVisible();
    await expect(page.locator(".workflow-cards__summary-label", { hasText: "待办" })).toHaveCount(
      1,
    );
    await expect(page.locator(".workflow-cards__summary-label", { hasText: "待处理" })).toHaveCount(
      1,
    );
    await expect(
      page.locator(".workflow-cards__summary-label", { hasText: "来源主控会话" }),
    ).toHaveCount(1);
    // 控制正本读得出来，就不该出现「控制文件读不出来」的提示。
    await expect(page.getByTestId("workflow-cards-control-note")).toHaveCount(0);
    expect(fixture.控制清单.length).toBeGreaterThan(0);
  } finally {
    await app.close();
  }
});

test("看板与步骤卡切换：选卡片同步右栏且不丢上下文，查看步骤与改发言对象分开", async () => {
  const { app } = await launchWorkflowCardsFixture();
  try {
    const page = await app.firstWindow();
    await page.getByTestId("task-status-open-workflow").click();
    await expect(page.getByTestId("workflow-cards-title")).toContainText("小说首章");

    // 默认落在步骤卡视图；切到看板（成果页）再切回来，右栏选的步骤不被清掉。
    await expect(page.getByTestId("workflow-cards-tab-steps")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByTestId("workflow-cards-step-s1")).toHaveAttribute(
      "aria-current",
      "true",
    );
    await page.getByTestId("workflow-cards-tab-output").click();
    await expect(page.getByTestId("workflow-cards-outputs")).toBeVisible();
    await page.getByTestId("workflow-cards-tab-steps").click();
    await expect(page.getByTestId("workflow-cards-step-s1")).toHaveAttribute(
      "aria-current",
      "true",
    );

    // 默认发言对象是整条流程；「讨论这一步」必须换。
    // scopeLabel 给的是模型口径的中文真值「整个流程」。
    await expect(page.getByTestId("workflow-cards-scope")).toContainText("整个流程");
    // 「讨论这一步」的可见文案必须走词典，不留英文原键。
    await expect(page.getByTestId("workflow-cards-discuss-s3")).toHaveText("讨论这一步");
    await page.getByTestId("workflow-cards-discuss-s3").click();
    await expect(page.getByTestId("workflow-cards-scope")).toContainText("第 3 步");
    await expect(page.getByTestId("workflow-cards-step-s3")).toHaveAttribute(
      "aria-current",
      "true",
    );

    // 查看另一步（点卡片主体）只改「在看哪一步」，发言对象不动。
    await page.getByTestId("workflow-cards-step-s4").getByRole("button").first().click();
    await expect(page.getByTestId("workflow-cards-step-s4")).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expect(page.getByTestId("workflow-cards-scope")).toContainText("第 3 步");

    // 「返回整条流程」把发言对象收回流程级。
    await page.getByTestId("workflow-cards-scope-reset").click();
    await expect(page.getByTestId("workflow-cards-scope")).toContainText("整个流程");
    // 收回发言对象不动「在看哪一步」。
    await expect(page.getByTestId("workflow-cards-step-s4")).toHaveAttribute(
      "aria-current",
      "true",
    );
  } finally {
    await app.close();
  }
});

test("右栏两态分工：步骤详情可改字段、文件预览只读且返回步骤详情不丢文件版本", async () => {
  const { app } = await launchWorkflowCardsFixture();
  try {
    const page = await app.firstWindow();
    await page.getByTestId("task-status-open-workflow").click();
    await expect(page.getByTestId("workflow-cards-title")).toContainText("小说首章");

    // 步骤详情面板：可编辑字段与「交给主控」入口都在。
    await expect(page.getByTestId("workflow-cards-panel-step")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByTestId("workflow-cards-field-title")).toBeVisible();
    await expect(page.getByTestId("workflow-cards-detail-state")).toContainText("等待你的确认");
    // 该夹具的部门注册表里没有第 1 步的部门，但第 1 步的部门确实在注册表里（策划部）→ 可编辑。
    await page.getByTestId("workflow-cards-tab-output").click();
    await page.getByTestId("workflow-cards-artifact-创作成果/初稿.md").click();
    await expect(page.getByTestId("workflow-cards-file-preview")).toBeVisible();
    await expect(page.getByTestId("workflow-cards-panel-file")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // 预览是只读的：整块明细里没有可编辑的步骤字段。
    await expect(page.getByTestId("workflow-cards-field-title")).toHaveCount(0);
    await expect(page.getByTestId("workflow-cards-file-body")).toContainText(ARTIFACT_MARKER);

    // 专注阅读只改版式，不改内容、不改页签。
    await page.getByRole("button", { name: "专注阅读" }).click();
    await expect(page.getByTestId("workflow-cards-file-body")).toBeVisible();
    await expect(page.getByTestId("workflow-cards-panel-file")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // 返回步骤详情：右栏切回步骤面板，但预览选中的文件版本仍留着（再切回文件页签还在同一份）。
    await page.getByTestId("workflow-cards-back-to-step").click();
    await expect(page.getByTestId("workflow-cards-field-title")).toBeVisible();
    await expect(page.getByTestId("workflow-cards-panel-file")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await page.getByTestId("workflow-cards-panel-file").click();
    await expect(page.getByTestId("workflow-cards-file-preview")).toBeVisible();
    await expect(page.getByTestId("workflow-cards-file-body")).toContainText(ARTIFACT_MARKER);
  } finally {
    await app.close();
  }
});
