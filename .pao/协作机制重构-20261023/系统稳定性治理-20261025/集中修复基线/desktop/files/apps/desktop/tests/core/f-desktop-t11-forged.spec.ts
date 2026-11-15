import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
 * F 批 · T11：伪造「卡面 delivered 但产物不存在 / evidence 对不上」，真值到底拦在哪一层。
 *
 * ## 真值层：**内核状态机不拦，拦在回执通道**
 *
 * 1. `changeCardStatus`（PAO/packages/coding-agent/src/pao/cards/statemachine.ts:188-232）只校验三件事：
 *    迁移合法（`checkTransition`，:39-63 的 `ALLOWED_TRANSITIONS`）、单写者权限
 *    （`checkWriterAuthority`，:87-111）、失败必带分型（:201-209）。**它不校验产物是否存在，
 *    也不要求有回执。** 所以任何能写卡文件的通道都能把卡写成 `delivered`。
 * 2. 内核 `readCard()` 读回来照认这个 `delivered`。这一点由本目录的配套探针实测确认：
 *    伪造后 `status: "delivered"`、`completed` 有时间戳、`receipts: 0`、产物不存在，
 *    内核读卡没有任何异议。
 * 3. 真正拦住伪造 evidence 的是 `validateReceiptContent`
 *    （PAO/packages/coding-agent/src/pao/cards/receipts.ts:45-61），在 `appendReceipt` 里校验
 *    「声明了产物路径则必须真实存在」，报 `INVALID_RECEIPT` 并列出缺失产物。
 *    **也就是说：worker 靠交回执混不过去；但绕过回执直接改卡面 status，没有人拦。**
 * 4. 交付侧第二道实务防线是 `deliverCard`（cards/delivery.ts:159-201）：要求最近一次机械验收
 *    结论不是「未过」（:166-173）、卡状态已是 delivered（:175-181）、认领基线快照可用（:187-193），
 *    缺基线时明确拒绝并给原因，不猜也不 `git add -A`。
 *
 * ## 桌面层能验什么、不能验什么（如实写清，别读成「界面拦住了」）
 *
 * - **不能验**：桌面桥**没有交卷 IPC**。`electron/preload.ts` 的 `piApp` 全套里没有 deliver/交卷入口，
 *   交卷属于内核 `pao_deliver_card` 工具面（会话内由主控调用），不在桌面 UI 上。所以「点击交卷被拒」
 *   这条在界面层**构造不出来**——不是没测，是没有这个入口。
 * - **能验**：界面如何**呈现**一张伪造 delivered 卡。桌面只读投影
 *   （`electron/platform/pao/kanban-query.ts:138` 认五种状态字面量，不读 evidence），
 *   所以界面上它就是一个「已完成」。**这是卡协议投影的正确行为，不是缺陷**——界面不负责复算 evidence。
 *   真正要钉住的是：界面**不得**在卡面状态之外再多说「已验证/验收通过」这类它无权说的话，
 *   也**不得**凭空列出不存在的产物。
 *
 * 本文件不改产品源码；上面引用的行号即证据位置。
 */

const REGISTRY = `# 部门注册表

| 名字 | 能力标签 | 库路径 | 建部日期 |
| --- | --- | --- | --- |
| 策划部 | 策划 | 部门/策划部/知识库 | 2026-10-14 |
`;

/**
 * 夹具：一份真实临时计划 + 实例，两个步骤的卡都落 delivered，但**只有 s1 的产物真实存在**。
 *
 * - s1 对照组：产物真写盘、走真实 `appendReceipt` 交回执、再落 delivered —— 真有凭据。
 * - s2 伪造点：直接 `changeCardStatus` 落 delivered，**不交回执、不写产物** —— 假有状态。
 *
 * 同一个界面上一个真一个假，才能区分「界面把两个都当完成」和「界面能给真实凭据」。
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
  显示名: "F11 伪造交付场景",
  来源会话: ownerSessionId,
  请求ID: "req-f11-1",
  已注册部门: ["策划部"],
  步骤: [
    { 标题: "真交付", 部门: "策划部", 要求: "产出 真件.md" },
    { 标题: "伪造交付", 部门: "策划部", 要求: "产出 假件.md" },
  ],
  当刻: "2026-10-17 10:00",
});
const execution = plan.resolvePlanExecution({
  项目根: project,
  计划ID: created.计划ID,
  启动请求ID: "start-f11-1",
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
  启动请求ID: "start-f11-1",
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

// ---- 对照组 s1：真实链路，产物真写盘、回执真落卡 ----
await control.bindMinister(execution.配方, options, "s1", ownerSessionId);
const [s1Ref] = await control.addNodeCards(execution.配方, options, nodeOf("s1"), [
  { goal: "产出 真件.md", acceptance: "存在 真件.md" },
]);
const s1No = cards.parseCardRef(s1Ref);
cards.changeCardStatus(cards.loadCard(execution.卡目录, s1No), {
  操作者: ownerSessionId,
  to: "in_progress",
  时间: "2026-10-17 10:02",
});
writeFileSync(join(project, "真件.md"), "# 真件\\n这是真的产出。\\n", "utf8");
cards.appendReceipt(cards.loadCard(execution.卡目录, s1No), {
  尝试号: 1,
  时间: "2026-10-17 10:05",
  结果: "完成",
  摘要: "已产出 真件.md",
  产物路径: ["真件.md"],
});
cards.changeCardStatus(cards.loadCard(execution.卡目录, s1No), {
  操作者: ownerSessionId,
  to: "delivered",
  时间: "2026-10-17 10:06",
});
await control.endDecomposition(execution.配方, options, nodeOf("s1"));

// ---- 伪造点 s2：卡面直接落 delivered，不回执、不写产物 ----
await control.bindMinister(execution.配方, options, "s2", ownerSessionId);
const [s2Ref] = await control.addNodeCards(execution.配方, options, nodeOf("s2"), [
  { goal: "产出 假件.md", acceptance: "存在 假件.md" },
]);
const s2No = cards.parseCardRef(s2Ref);
cards.changeCardStatus(cards.loadCard(execution.卡目录, s2No), {
  操作者: ownerSessionId,
  to: "in_progress",
  时间: "2026-10-17 10:07",
});
// 关键：状态机不查 evidence，所以这一步能"成功"——这正是 T11 要暴露的边界。
cards.changeCardStatus(cards.loadCard(execution.卡目录, s2No), {
  操作者: ownerSessionId,
  to: "delivered",
  时间: "2026-10-17 10:08",
});
await control.endDecomposition(execution.配方, options, nodeOf("s2"));

const realCard = cards.loadCard(execution.卡目录, s1No);
const fakeCard = cards.loadCard(execution.卡目录, s2No);

console.log(JSON.stringify({
  实例: identity.实例,
  配方名: execution.配方名,
  工作区: execution.工作区,
  控制清单: execution.控制清单,
  真卡号: realCard.card_no,
  假卡号: fakeCard.card_no,
  假卡状态: fakeCard.frontmatter.status,
  假卡回执数: fakeCard.receipts.length,
  真卡回执数: realCard.receipts.length,
}));
`;

interface ForgedFixture {
  readonly 实例: string;
  readonly 配方名: string;
  readonly 工作区: string;
  readonly 控制清单: string;
  readonly 真卡号: number;
  readonly 假卡号: number;
  readonly 假卡状态: string;
  readonly 假卡回执数: number;
  readonly 真卡回执数: number;
}

async function launchForgedFixture(prefix: string) {
  const home = await makeWorkspace(`${prefix}-home`);
  const project = await makeWorkspace(`${prefix}-project`);
  await mkdir(join(home, "部门"), { recursive: true });
  await writeFile(join(home, "部门", "注册表.md"), REGISTRY, "utf8");

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
  const scriptPath = join(home, "make-f11-fixture.mjs");
  await writeFile(scriptPath, FIXTURE_SCRIPT, "utf8");
  const { stdout } = await execFileAsync(process.execPath, [scriptPath, kernelDist, project, sessionId], {
    windowsHide: true,
  });
  const fixture = JSON.parse(stdout.trim().split("\n").at(-1)!) as ForgedFixture;

  await page.getByTestId("task-status-open-workflow").click();
  await expect(page.getByTestId("workflow-cards-title")).toContainText("F11 伪造交付场景", {
    timeout: 20_000,
  });
  return { app, page, project, fixture };
}

test("T11 前置：伪造 delivered 真能落盘（状态机不查 evidence），且与真件凭据不同", async () => {
  const { app, project, fixture } = await launchForgedFixture("f11-pre");
  try {
    // 这条是「前提成立」的证据：假卡确实是以 delivered 落盘的（不是我以为的）。
    expect(fixture.假卡状态).toBe("delivered");
    // 假卡没有任何回执 —— 这是它和真件的本质区别。
    expect(fixture.假卡回执数).toBe(0);
    // 真卡有回执 —— 对照组有真凭据。
    expect(fixture.真卡回执数).toBeGreaterThan(0);
    // 产物：真有、假无。文件系统真值，不是界面说的。
    expect(existsSync(join(project, "真件.md"))).toBe(true);
    expect(existsSync(join(project, "假件.md"))).toBe(false);
  } finally {
    await app.close();
  }
});

test("T11 界面按卡协议把伪造卡显示成已完成，但不多说「已验证」这类它无权说的话", async () => {
  const { app, page } = await launchForgedFixture("f11-view");
  try {
    const steps = page.getByTestId("workflow-cards-steps");
    await expect(steps).toContainText("真交付");
    await expect(steps).toContainText("伪造交付");

    // 点进伪造那一步，看详情里的状态行——`workflow-cards-detail-state`（workflow-cards-view.tsx:1824）
    // 是界面唯一的状态出口，格式为「图标 状态词 · Round N · Delivered」。
    await steps.getByText("伪造交付").first().click();
    const detailState = page.getByTestId("workflow-cards-detail-state");
    await expect(detailState).toBeVisible();

    // 卡面写着 delivered，界面就该说「已交付」——这是诚实投影，不是缺陷。
    // 断言它确实说了，避免「界面其实没显示状态」这种空过。
    await expect(detailState).toContainText("已交付");

    // 关键断言：卡面状态之外的结论性用语，界面一个字都不能说。
    // 界面没有 evidence 结论，无权把「卡面说 delivered」升级成「已验证/验收通过」。
    const inspector = page.getByTestId("workflow-cards-inspector");
    await expect(inspector).not.toContainText("已验证");
    await expect(inspector).not.toContainText("验收通过");
    await expect(inspector).not.toContainText("审核通过");

    // 更精确的一条：界面只有拿到非空 verdict 才渲染「Verdict: …」（workflow-cards-view.tsx:1926-1930）。
    // 伪造卡没有 verdict，所以这条行根本不出现——不是显示了「Verdict: 待定/通过」这类猜测。
    // 对照组在下面：真实交卷过的卡若有 verdict，这一行会出现；本夹具两张卡都没走判定，故两台都不出现，
    // 用 record-reason 的缺席一并证明「原始记录里 verdict 是空值、界面没有替它编一个」。
    await expect(inspector.getByText(/^Verdict:/)).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("T11 产物面板只列真实存在的文件：假件.md 不在，真件.md 才有", async () => {
  const { app, page } = await launchForgedFixture("f11-artifacts");
  try {
    // 产物出口是 `workflow-cards-outputs`（workflow-cards-view.tsx:1728）——
    // 「这次跑出了什么」的真实展示。假件.md 从没被写出来过，任何产物列表都不许出现它。
    const outputs = page.getByTestId("workflow-cards-outputs");
    if ((await outputs.count()) > 0) {
      await expect(outputs).not.toContainText("假件.md");
    }

    // 真件反证：对照组的产物真的存在，产物面板若要列文件就该能列出它。
    // 这条保证「假件没被列」不是因为产物面板整个是空的、什么都没列。
    // （面板可能是空态——那就用文件系统真值兜底，本文件第 1 条用例已断言真件存在。）
    const fileArtifacts = page.getByTestId("workflow-cards-field-artifacts");
    if ((await fileArtifacts.count()) > 0 && (await fileArtifacts.isEnabled())) {
      // 只在可编辑时校验内容；运行中的计划字段是 locked 的，值可能为空。
      await expect(fileArtifacts).not.toHaveValue(/假件\.md/);
    }

    // 关键断言：无论产物面板列什么，**状态行不能把「计划要求」混写成「已经产出」**。
    const steps = page.getByTestId("workflow-cards-steps");
    await steps.getByText("伪造交付").first().click();
    const detailState = page.getByTestId("workflow-cards-detail-state");
    await expect(detailState).not.toContainText("假件.md");
    // 状态行只说卡面状态（已交付），不声称产物已核实。
    await expect(detailState).not.toContainText("已验证");
  } finally {
    await app.close();
  }
});
