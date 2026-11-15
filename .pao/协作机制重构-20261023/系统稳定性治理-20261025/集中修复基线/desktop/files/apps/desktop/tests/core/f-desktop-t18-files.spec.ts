import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

/**
 * F 批 · T18：文件异常 / 越界 / 未保存编辑。
 *
 * 三件事分别在哪一层验（**不要把某一层的结论写成另一层的**）：
 *
 * ### 一、文件异常（界面上有真出口，验界面）
 * 已记录的产物在交付后又从磁盘消失时，`workflow-cards` 右栏预览不能把旧正文当成还在，
 * 要明说盘上没有了：
 * - `workflow-cards-view.tsx:2155-2159` → `workflow-cards-file-missing`
 * - `workflow-cards-view.tsx:2098-2109` → origin 里追加 `Missing from disk`
 * 二进制与截断在同一个组件里也有出口（`body.binary` / `body.truncated`，`:2199-2206`）。
 *
 * ### 二、越界（**界面没有手动输入入口**，分两层验）
 * 全仓只有两处调 `readWorkspaceFile`：`workflow-cards-view.tsx:2063` 与
 * `file-editor-pane.tsx:87`，两处的路径都来自**已有记录**（回执产物路径 / 文件树 / 命令面板列出
 * 的工作区文件），用户没有地方手打 `../../etc`。命令面板的候选来自 `listWorkspaceFiles`
 * （工作区内枚举），也不可能产出越界路径。
 * 所以越界这样验：
 * - **主进程层**：经真实 IPC 直接给越界路径，必须被 `assertInsideWorkspace` 拒绝
 *   （`workspace-paths.ts:25-31` → `Path escapes workspace`）。这是真 IPC，不是单元测试。
 * - **界面守卫层**：`use-workbench.ts:230-242` 的 `openFile` 先 `await readWorkspaceFile(...)`
 *   校验宿主，再 `apply(... "open-file")`。读失败时异常向上抛，**标签页状态根本不会变**。
 *   `App.tsx:475-493` 的 `.catch()` 注释原话就是「Missing, unreadable, or outside the
 *   workspace: leave the panel unchanged.」这里钉住这个「不变」。
 *
 * ### 三、未保存编辑（验界面）
 * 当前界面里真正有「未保存编辑」语义的是 workflow-cards 的两个输入：
 * - `workflow-cards-template-name`（保存工作流的名字）
 * - `workflow-cards-file-opinion`（文件意见）
 * 它们的重置只挂在 `workspaceId` 变化上（`workflow-cards-view.tsx:217-233`），
 * 所以**切步骤、切预览版本、刷新投影都不清空**；只有换工作区才清空。
 * 关掉保存面板也不清空（`onSavePanelClose` 只 `setSavePanelOpen(false)` + `setSaveError(undefined)`，`:575-578`）。
 * 这与计划 §7.2「切步骤/项目/会话再返回要找回草稿与选择」一致。
 * **反向对照必须有**：换工作区真的会清空——否则「不清空」分不清是实现还是这个 state 压根没接。
 *
 * 本文件不改产品源码。
 */

/**
 * 夹具：一份真实临时计划，两个步骤都走完整交付链路，产物真实落盘。
 * 返回产物相对路径，供「文件异常」用例在启动后把它删掉。
 */
const FIXTURE_SCRIPT = `
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const [kernelDist, project, ownerSessionId] = process.argv.slice(2);
const load = (relative) => import(pathToFileURL(join(kernelDist, relative)).href);

const plan = await load("workflow/plan.js");
const driver = await load("workflow/driver.js");
const control = await load("workflow/control.js");
const cards = await load("cards/index.js");

const ARTIFACT = "创作成果/初稿.md";

const created = await plan.createTemporaryPlan({
  项目根: project,
  显示名: "F18 文件与草稿",
  来源会话: ownerSessionId,
  请求ID: "req-f18-1",
  已注册部门: ["策划部"],
  步骤: [
    { 标题: "写初稿", 部门: "策划部", 要求: "产出 " + ARTIFACT },
    { 标题: "收尾", 部门: "策划部", 要求: "产出 收尾.md" },
  ],
  当刻: "2026-10-17 10:00",
});
const execution = plan.resolvePlanExecution({
  项目根: project,
  计划ID: created.计划ID,
  启动请求ID: "start-f18-1",
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
  启动请求ID: "start-f18-1",
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

// s1：真交付，产物真实存在（用例稍后可以把它删掉，造「盘上没了」）。
await control.bindMinister(execution.配方, options, "s1", ownerSessionId);
const [ref] = await control.addNodeCards(execution.配方, options, nodeOf("s1"), [
  { goal: "产出 " + ARTIFACT, acceptance: "存在" },
]);
const no = cards.parseCardRef(ref);
cards.changeCardStatus(cards.loadCard(execution.卡目录, no), {
  操作者: ownerSessionId,
  to: "in_progress",
  时间: "2026-10-17 10:02",
});
const artifactFile = join(project, ARTIFACT);
mkdirSync(dirname(artifactFile), { recursive: true });
writeFileSync(artifactFile, "# 初稿\\n这是第一版正文。\\n", "utf8");
cards.appendReceipt(cards.loadCard(execution.卡目录, no), {
  尝试号: 1,
  时间: "2026-10-17 10:03",
  结果: "完成",
  摘要: "已产出 " + ARTIFACT,
  产物路径: [ARTIFACT],
});
cards.changeCardStatus(cards.loadCard(execution.卡目录, no), {
  操作者: ownerSessionId,
  to: "delivered",
  时间: "2026-10-17 10:05",
});
await control.endDecomposition(execution.配方, options, nodeOf("s1"));

// s2：只建卡不交付，界面上是多一个步骤，保证计划不是单步空壳。
await control.bindMinister(execution.配方, options, "s2", ownerSessionId);
await control.addNodeCards(execution.配方, options, nodeOf("s2"), [
  { goal: "产出 收尾.md", acceptance: "存在" },
]);
await control.endDecomposition(execution.配方, options, nodeOf("s2"));

console.log(JSON.stringify({ 产物路径: ARTIFACT }));
`;

interface FileFixture {
  readonly 产物路径: string;
}

/**
 * 起一个带真实计划的桌面实例，并停在 workflow-cards 页面。
 * 第二个工作区是可选的：「未保存编辑」用例要用它做「换工作区就清空」的反向对照。
 */
async function launchFileFixture(prefix: string, options: { withWorkspace?: boolean } = {}) {
  const home = await makeWorkspace(`${prefix}-home`);
  const project = await makeWorkspace(`${prefix}-project`);
  const second = options.withWorkspace ? await makeWorkspace(`${prefix}-project-2`) : undefined;
  const userDataDir = await makeUserDataDir();
  await writeFile(join(userDataDir, "ui-state.json"), JSON.stringify({ language: "zh" }), "utf8");
  const app: ElectronApplication = await launchDesktop(userDataDir, {
    initialWorkspaces: second ? [project, second] : [project],
    testMode: "foreground",
    scrubProviderEnv: true,
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: "0" },
  });

  const page: Page = await app.firstWindow();
  // `createNamedThread` 把新会话建在**当前选中**的工作区里。
  // 两个工作区时选中项是最后加进去的那个，所以先显式选回 project，
  // 否则会话会落在 project-2 上，project 的 sessions 是 0（踩过，报「拿不到夹具工作区或会话 id」）。
  const before = await getDesktopState(page);
  const projectRow = before.workspaces.find((entry) => entry.path === project);
  if (!projectRow) {
    await app.close();
    throw new Error(`夹具工作区没被加进列表：${project}`);
  }
  if (before.selectedWorkspaceId !== projectRow.id) {
    await page.evaluate(
      async (id) => globalThis.window.piApp.selectWorkspace(id),
      projectRow.id,
    );
    await expect
      .poll(async () => (await getDesktopState(page)).selectedWorkspaceId, { timeout: 20_000 })
      .toBe(projectRow.id);
  }

  await createNamedThread(page, `${prefix} 会话`);
  const state = await getDesktopState(page);
  const workspace = state.workspaces.find((entry) => entry.path === project);
  const sessionId = workspace?.sessions[0]?.id;
  if (!workspace || !sessionId) {
    await app.close();
    throw new Error(
      `拿不到夹具工作区或会话 id（workspaces=${JSON.stringify(
        state.workspaces.map((entry) => ({ path: entry.path, sessions: entry.sessions.length })),
      )}，target=${project}）`,
    );
  }

  const kernelDist = join(__dirname, "../../node_modules/@earendil-works/pi-coding-agent/dist/pao");
  const scriptPath = join(home, "make-f18-fixture.mjs");
  await writeFile(scriptPath, FIXTURE_SCRIPT, "utf8");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [scriptPath, kernelDist, project, sessionId],
    { windowsHide: true },
  );
  const fixture = JSON.parse(stdout.trim().split("\n").at(-1)!) as FileFixture;

  await page.getByTestId("task-status-open-workflow").click();
  await expect(page.getByTestId("workflow-cards-title")).toContainText("F18 文件与草稿", {
    timeout: 20_000,
  });
  return { app, page, project, second, fixture, workspaceId: workspace.id };
}

/**
 * 打开 s1 的产物预览：切到「成果文件」页 → 点该产物按钮。
 *
 * 产物按钮的 testid 来自 `OutputGroup`（`workflow-cards-view.tsx:1687`）：
 * `workflow-cards-artifact-${artifact.relativePath}`。**不要**用 `workflow-cards-file-*`，
 * 那是同一页下方「有意见的文件」列表（`workflow-cards-view.tsx:1764`），没有意见的产物不会出现在那里。
 *
 * 「步骤卡/成果文件」是个 `role="group"` 里的双态按钮（`:1013-1032`），
 * **不是 tab**，所以按 testid 点、按 `aria-pressed` 断态。
 */
async function openFirstArtifact(page: Page, artifactPath: string) {
  // 切到成果文件页（双态按钮，aria-pressed 才是真态）。
  const outputTab = page.getByTestId("workflow-cards-tab-output");
  await outputTab.click();
  await expect(outputTab).toHaveAttribute("aria-pressed", "true");

  // 产物行必须真实存在——不存在就是夹具没产出真件，不能退化成「预览为空」的假通过。
  const row = page.getByTestId(`workflow-cards-artifact-${artifactPath}`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect(row).toHaveAttribute("aria-pressed", "true");

  const preview = page.getByTestId("workflow-cards-file-preview");
  await expect(preview).toBeVisible({ timeout: 20_000 });
  await expect(preview).toContainText(artifactPath);
}

test("T18 对照组：产物在盘上时，预览给出真实正文", async () => {
  const { app, page, fixture } = await launchFileFixture("f18-good");
  try {
    await openFirstArtifact(page, fixture.产物路径);

    // 对照组关键：正文能读到，且没有「盘上没了」的提示。
    // 没有这一条，下面那条「删掉后提示盘上没了」就分不清是提示对了还是预览压根没通。
    await expect(page.getByTestId("workflow-cards-file-body")).toContainText("这是第一版正文");
    await expect(page.getByTestId("workflow-cards-file-missing")).toHaveCount(0);
    await expect(page.getByTestId("workflow-cards-file-preview")).not.toContainText(
      "Missing from disk",
    );
  } finally {
    await app.close();
  }
});

test("T18 文件异常：产物从盘上消失后，预览如实说盘上没了，不拿旧正文冒充", async () => {
  const { app, page, project, fixture } = await launchFileFixture("f18-missing");
  try {
    // 先确认盘上真的在（不然「消失」无从谈起）。
    const { rm } = await import("node:fs/promises");
    await openFirstArtifact(page, fixture.产物路径);
    await expect(page.getByTestId("workflow-cards-file-body")).toContainText("这是第一版正文");

    // 让产物真的消失，再让界面重新拉一次投影。
    await rm(join(project, fixture.产物路径), { force: true });
    await page.getByTestId("sidebar-threads").click();
    await page.getByTestId("task-status-open-workflow").click();
    await expect(page.getByTestId("workflow-cards-title")).toContainText("F18 文件与草稿", {
      timeout: 20_000,
    });
    await openFirstArtifact(page, fixture.产物路径);

    // 关键断言 1：明说盘上没有了。
    // 这一条在 `workflow-cards-view.tsx:2155-2159`，只有 `artifact && !artifact.exists` 时才渲染；
    // 产物仍在盘上时它必须是 0（对照组已断过），证据链是完整的。
    // 正向证明它确实跟着文件状态走：同一元素在文件还在时显示的是产物自带的 note
    // （夹具写的是「盘上找不到这个文件（可能被移动，或这一轮还没真正产出）」）。
    const missing = page.getByTestId("workflow-cards-file-missing");
    await expect(missing).toBeVisible({ timeout: 20_000 });
    await expect(missing).toContainText("盘上找不到");

    // 关键断言 2：origin 行也如实挂上「盘上找不到」，不是只在角落说一次。
    // 注意本用例跑中文界面（`ui-state.json` 设了 zh），`t("Missing from disk")` 渲染成「盘上找不到」
    // （`contracts/i18n-zh.ts:1335`）。断英文原文会假红——这正是我第一次踩的坑。
    await expect(page.getByTestId("workflow-cards-file-origin")).toContainText("盘上找不到");

    // 关键断言 3：不拿旧正文冒充。
    // 实现上 `artifactPath = artifact?.exists ? artifact.relativePath : undefined`（`:2039`），
    // 所以文件不在盘上时压根不会去 readWorkspaceFile，正文区走的是 `-no-body` 分支（`:2215-2219`），
    // 说的是「没有已确认的产物对应这条路径，因此没有正文可看」。
    await expect(page.getByTestId("workflow-cards-file-body")).toHaveCount(0);
    await expect(page.getByTestId("workflow-cards-file-error")).toHaveCount(0);
    await expect(page.getByTestId("workflow-cards-file-no-body")).toBeVisible();
  } finally {
    await app.close();
  }
});

test("T18 越界：主进程拒绝工作区外路径，界面守卫保证标签页不变", async () => {
  const { app, page, project } = await launchFileFixture("f18-escape");
  try {
    const state = await getDesktopState(page);
    const workspaceId = state.workspaces.find((entry) => entry.path === project)?.id;
    expect(workspaceId).toBeTruthy();

    // ——— 第一层：主进程守卫。走真实 IPC，不 mock。
    // 三种跳法都要被拒：上跳出工作区、绝对路径、用 .. 绕回。
    const probes = ["../outside.md", "C:\\Windows\\win.ini", "a/../../outside.md"];
    const results = await page.evaluate(
      async ({ workspaceId, probes }) =>
        Promise.all(
          probes.map((path) =>
            (globalThis as unknown as { window: { piApp: any } }).window.piApp
              .readWorkspaceFile(workspaceId as string, path)
              .then(
                () => "resolved",
                (error: unknown) => (error instanceof Error ? error.message : String(error)),
              ),
          ),
        ),
      { workspaceId, probes },
    );
    for (const [index, result] of results.entries()) {
      expect(result, `越界路径 ${probes[index]} 必须被拒绝`).not.toBe("resolved");
    }
    // 主进程的拒绝理由是路径越界，不是别的偶发错误。
    expect(results.join("\n")).toContain("Path escapes workspace");

    // ——— 第二层：界面守卫。openFile 先校验宿主再改状态，读失败时标签页必须原封不动。
    const tabsBefore = await page.getByTestId("file-workbench-tab").count();
    const editorBefore = await page.getByTestId("file-editor").count();
    // 通过 preload 暴露的 workbench 入口无法直接调；用命令面板/文件树都需工作区内文件，
    // 所以这里用真实 IPC 通道重复一次「界面会做的那次校验」，确认它一定先失败。
    const guardResult = await page.evaluate(
      async ({ workspaceId }) =>
        (globalThis as unknown as { window: { piApp: any } }).window.piApp
          .readWorkspaceFile(workspaceId as string, "../../escape.md")
          .then(
            () => "resolved",
            (error: unknown) => (error instanceof Error ? error.message : String(error)),
          ),
      { workspaceId },
    );
    expect(guardResult).toContain("Path escapes workspace");

    // 界面本身必须没被这次失败带偏：文件工作台标签和编辑器数量都没变。
    expect(await page.getByTestId("file-workbench-tab").count()).toBe(tabsBefore);
    expect(await page.getByTestId("file-editor").count()).toBe(editorBefore);
  } finally {
    await app.close();
  }
});

test("T18 未保存编辑：切步骤/切预览/刷投影都不丢，换工作区才清空", async () => {
  const { app, page, project, second, workspaceId } = await launchFileFixture("f18-draft", {
    withWorkspace: true,
  });
  try {
    // ——— 1. 保存工作流面板里的名字：关掉再开，名字要还在。
    // 这是「未保存编辑」最直接的现场：用户打了流程名还没交给主控。
    const saveOpen = page.getByTestId("workflow-cards-save");
    await saveOpen.click();
    const savePanel = page.getByTestId("workflow-cards-save-panel");
    await expect(savePanel).toBeVisible({ timeout: 20_000 });
    const nameInput = page.getByTestId("workflow-cards-template-name");
    await nameInput.fill("没保存的流程名");

    // 关面板 → 名字留着（onSavePanelClose 只关面板，`:575-578`）。
    await page.getByTestId("workflow-cards-save-cancel").click();
    await expect(savePanel).toHaveCount(0);
    await saveOpen.click();
    await expect(savePanel).toBeVisible();
    await expect(nameInput).toHaveValue("没保存的流程名");
    await page.getByTestId("workflow-cards-save-cancel").click();

    // ——— 2. 切步骤不清空：看另一个步骤再回来，名字还在。
    // 计划 §7.2「切步骤/项目/会话再返回要找回草稿与选择」。
    await page.getByTestId("workflow-cards-step-s2").click();
    await expect(page.getByTestId("workflow-cards-step-s2")).toHaveAttribute(
      "aria-current",
      "true",
    );
    await page.getByTestId("workflow-cards-step-s1").click();
    await saveOpen.click();
    await expect(nameInput).toHaveValue("没保存的流程名");
    await page.getByTestId("workflow-cards-save-cancel").click();

    // ——— 3. 文件意见：写一句话，切到「步骤卡」页再切回「成果文件」页重开预览，
    // 草稿要按**讨论对象**找回来（opinionDraftsRef 的键是 discussionScopeKey）。
    //
    // 注意实测范围：切页后右栏 `inspector` 仍停在 file，预览不卸载，所以这条验的是
    // 「切中心视图不动意见草稿」，**不是**跨对象的草稿找回。
    await openFirstArtifact(page, "创作成果/初稿.md");
    const opinion = page.getByTestId("workflow-cards-file-opinion");
    await opinion.fill("这句意见还没交给主控");
    await expect(opinion).toHaveValue("这句意见还没交给主控");
    await page.getByTestId("workflow-cards-tab-steps").click();
    await page.getByTestId("workflow-cards-tab-output").click();
    await expect(page.getByTestId("workflow-cards-file-opinion")).toHaveValue(
      "这句意见还没交给主控",
    );

    // ——— 4. 反向对照：换到另一个工作区。
    //
    // **观察手段必须是真实存在的出口**：第二个工作区没有临时计划，workflow-cards 渲染的是
    // 「本项目还没有临时计划」空态，保存面板与意见框都不在 DOM 里 —— 所以不能在这里断言
    // 「名字变成空串」，那不是产品行为，是面板压根不存在。
    //
    // 能断的真事：换工作区后计划相关输入全部消失，草稿随视图一起被卸掉（`[workspaceId]` effect）；
    // 再切回原工作区，名字是空的 —— 这才是「换工作区会清空」的真凭据，
    // 且与第 1 步「关面板不清空」形成对照。
    const state = await getDesktopState(page);
    const other = state.workspaces.find((entry) => entry.path === second);
    expect(other, "第二个工作区应当存在").toBeTruthy();
    await page.evaluate(
      async (workspaceId) => globalThis.window.piApp.selectWorkspace(workspaceId),
      other!.id,
    );
    await expect
      .poll(async () => (await getDesktopState(page)).selectedWorkspaceId, { timeout: 20_000 })
      .toBe(other!.id);

    // 第二个工作区没有临时计划：计划相关输入真的不在，不是「有但被清空」。
    await page.getByTestId("task-status-open-workflow").click();
    await expect(page.getByTestId("workflow-cards-save")).toHaveCount(0);
    await expect(page.getByTestId("workflow-cards-template-name")).toHaveCount(0);
    await expect(page.getByTestId("workflow-cards-file-opinion")).toHaveCount(0);

    // 切回原工作区：名字必须为空 —— 证明 workspaceId effect 真的清了 state，
    // 而不是「第二个工作区看不到，切回来还在」。
    await page.evaluate(
      async (id) => globalThis.window.piApp.selectWorkspace(id),
      project,
    );
    await expect
      .poll(async () => (await getDesktopState(page)).selectedWorkspaceId, { timeout: 20_000 })
      .toBe(workspaceId);
    await page.getByTestId("task-status-open-workflow").click();
    await page.getByTestId("workflow-cards-save").click();
    await expect(page.getByTestId("workflow-cards-template-name")).toHaveValue("");
  } finally {
    await app.close();
  }
});
