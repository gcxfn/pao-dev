import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

/**
 * F 批 · T22：键盘与焦点返回（界面层取证）。
 *
 * 与 `d5-workflow-layout.spec.ts:509` 的分工：那条用例已经验过 workflow-cards 内部
 * 「中文控件名可见 / Tab 落点有序 / Enter·Space 真的生效 / Escape 归还焦点给产物入口 /
 * 刷新后焦点不抢到输入框」。**这里不重复它**，只补它明确没覆盖、而 T22 要求的三件：
 *
 * 1. **侧栏入口**：本批 D 批把侧栏导航从「一行文字」改成「卡片（标题 + 副标题）」，
 *    testid 没变，但可访问名变了。读屏按可访问名找人，所以入口必须**真的能用名字找到**，
 *    且 `Tab` 能落到它上面（不是只能鼠标点）。
 * 2. **焦点返回的**另一半**：Escape 归还焦点，只在「打开预览」这条路径验过；
 *    这里验「右栏 `步骤详情 ⇄ 文件预览` 切换 + Escape」时焦点仍然有着落，
 *    且切回步骤详情后 Escape **不会**满栏抢走步骤详情里 textarea 的按键
 *    （`workflow-cards-view.tsx:1145-1147` 的守卫：`inspector !== "file"` 时直接 return）。
 * 3. **侧栏 Tab 顺序**：D 批把导航包进 `data-testid="sidebar-work-surfaces"`，
 *    如果卡片被做成不可聚焦的容器，键盘用户就够不到「工作流/工作看板/临时计划/会话」。
 *
 * **中文名断言的正确姿势**：`t()` 走 `contracts/i18n.ts` 的 `dictionaries[language][key] ?? key`，
 * 漏键时**静默回退英文源串**，DOM 不会报错。所以不能只断 `/[\u4e00-\u9fa5]/`（英文副标题也可能
 * 碰巧没有中文），要断**具体的产品文案**；同时反过来断界面里不再出现英文源串，
 * 这样「漏翻译」这一层才是真的被抓到，而不是被「碰巧有个中文字符」掩盖。
 *
 * 本文件不改产品源码；只读界面。
 */

const ARTIFACT_DIRECTORY = "设计资产/样式";

/** 中文界面下的期望文案（正本：`contracts/i18n-zh.ts`）。 */
const ZH = {
  navWorkflow: "工作流",
  navWorkflowHint: "在跑计划的步骤",
  navThreads: "会话",
  navScheduled: "定时任务",
  newHint: "当前对话就是你干活的地方。",
  stepCards: "步骤卡",
  outputFiles: "成果文件",
  panelStep: "步骤详情",
  panelFile: "文件预览",
  discussThisFile: "就此文件提意见",
} as const;

/**
 * 夹具：一份真实临时计划，s1 真交付并落盘产物，s2 只建卡。
 * 复用 `f-desktop-t18-files.spec.ts` 的同一套内核公开 API，但它不能 import 那个文件的
 * 私有常量，所以脚本在这里自成一份（和该文件顶部注释里解释的理由相同）。
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

const ARTIFACT = ${JSON.stringify(ARTIFACT_DIRECTORY)} + "/变量表.md";

const created = await plan.createTemporaryPlan({
  项目根: project,
  显示名: "F22 键盘与焦点",
  来源会话: ownerSessionId,
  请求ID: "req-f22-1",
  已注册部门: ["视觉部"],
  步骤: [
    { 标题: "整理变量", 部门: "视觉部", 要求: "产出 " + ARTIFACT },
    { 标题: "复查样式", 部门: "视觉部", 要求: "产出 复查.md" },
  ],
  当刻: "2026-10-17 12:00",
});
const execution = plan.resolvePlanExecution({
  项目根: project,
  计划ID: created.计划ID,
  启动请求ID: "start-f22-1",
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
  启动请求ID: "start-f22-1",
  实例: identity.实例,
  配方名: execution.配方名,
  工作区: execution.工作区,
  卡目录: execution.卡目录,
  控制清单: execution.控制清单,
  owner会话: ownerSessionId,
  受理时刻: "2026-10-17 12:01",
});

const options = { cardsDir: execution.卡目录, workspaceDir: execution.工作区, ownerSessionId };
const nodeOf = (node) => ({ 实例: identity.实例, 节点: node, 轮次: 1, 部长会话: ownerSessionId });

await control.bindMinister(execution.配方, options, "s1", ownerSessionId);
const [ref] = await control.addNodeCards(execution.配方, options, nodeOf("s1"), [
  { goal: "产出 " + ARTIFACT, acceptance: "存在" },
]);
const no = cards.parseCardRef(ref);
cards.changeCardStatus(cards.loadCard(execution.卡目录, no), {
  操作者: ownerSessionId,
  to: "in_progress",
  时间: "2026-10-17 12:02",
});
const artifactFile = join(project, ARTIFACT);
mkdirSync(dirname(artifactFile), { recursive: true });
writeFileSync(artifactFile, "# 变量表\\n--text-sm: 12px;\\n", "utf8");
cards.appendReceipt(cards.loadCard(execution.卡目录, no), {
  尝试号: 1,
  时间: "2026-10-17 12:03",
  结果: "完成",
  摘要: "已产出 " + ARTIFACT,
  产物路径: [ARTIFACT],
});
cards.changeCardStatus(cards.loadCard(execution.卡目录, no), {
  操作者: ownerSessionId,
  to: "delivered",
  时间: "2026-10-17 12:05",
});
await control.endDecomposition(execution.配方, options, nodeOf("s1"));

await control.bindMinister(execution.配方, options, "s2", ownerSessionId);
await control.addNodeCards(execution.配方, options, nodeOf("s2"), [
  { goal: "产出 复查.md", acceptance: "存在" },
]);
await control.endDecomposition(execution.配方, options, nodeOf("s2"));

console.log(JSON.stringify({ 产物路径: ARTIFACT }));
`;

/** 证据目录：F 批统一放在这里，用绝对路径写死（Playwright 的 cwd 是 `apps/desktop`）。 */
const PROOF_DIR = "D:\\AI\\workspace\\pao-dev\\.pao\\harness完善-20261017\\F批-全链离线验证\\T22";

async function saveProof(page: Page, name: string): Promise<void> {
  await mkdir(PROOF_DIR, { recursive: true });
  await page.screenshot({ path: join(PROOF_DIR, name), fullPage: false });
}

interface A11yFixture {
  readonly 产物路径: string;
}

async function launchA11yFixture() {
  const home = await makeWorkspace("f22-home");
  const project = await makeWorkspace("f22-project");
  const userDataDir = await makeUserDataDir();
  // 中文界面：T22 要验的就是「读屏念出来的中文控件名」。
  await writeFile(join(userDataDir, "ui-state.json"), JSON.stringify({ language: "zh" }), "utf8");

  const app = await launchDesktop(userDataDir, {
    initialWorkspaces: [project],
    testMode: "foreground",
    scrubProviderEnv: true,
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: "0" },
  });
  const page: Page = await app.firstWindow();
  await createNamedThread(page, "f22 键盘会话");

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
  const scriptPath = join(home, "make-f22-fixture.mjs");
  await writeFile(scriptPath, FIXTURE_SCRIPT, "utf8");
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [scriptPath, kernelDist, project, sessionId],
    { windowsHide: true },
  );
  const fixture = JSON.parse(stdout.trim().split("\n").at(-1)!) as A11yFixture;

  await page.setViewportSize({ width: 1280, height: 960 });
  return { app, page, project, fixture };
}

/** 当前焦点元素的描述，用于「焦点有没有着落」这类断言的自证。 */
async function describeFocus(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = globalThis.document.activeElement;
    if (!(active instanceof HTMLElement)) {
      return "(无)";
    }
    return `${active.tagName.toLowerCase()}#${active.id || "-"}[${active.getAttribute("data-testid") ?? "-"}].${
      typeof active.className === "string" ? active.className : "-"
    }`;
  });
}

test("T22 侧栏入口可按中文名找到，Tab 能落到导航卡片上", async () => {
  const { app, page } = await launchA11yFixture();
  try {
    const surfaces = page.getByTestId("sidebar-work-surfaces");
    await expect(surfaces).toBeVisible();

    // 一、按**可访问名**找入口：这是读屏用户唯一能用的导航方式。
    // 断具体中文文案而不是「有个中文字符」，因为漏键会静默回退英文源串。
    await expect(surfaces.getByRole("button", { name: ZH.navWorkflow, exact: false })).toBeVisible();
    await expect(surfaces.getByRole("button", { name: ZH.navThreads, exact: false })).toBeVisible();
    await expect(surfaces.getByRole("button", { name: ZH.navScheduled, exact: false })).toBeVisible();
    // 副标题也必须是中文——它是本批新增的提示，最容易漏键。
    await expect(surfaces).toContainText(ZH.navWorkflowHint);
    await expect(page.getByText(ZH.newHint)).toBeVisible();

    // 二、Tab 能落到导航上：用真实键盘从会话输入框往回走/往前走都可以，
    // 这里从侧栏第一个入口出发，连按 Tab，确认焦点**走过**了每个导航卡片，
    // 且落点不是隐藏元素（隐藏元素拿不到焦点，说明有东西抢走了 tabindex）。
    const focusOrder: string[] = [];
    await surfaces.getByRole("button", { name: ZH.navWorkflow, exact: false }).focus();
    for (let step = 0; step < 6; step += 1) {
      focusOrder.push(await describeFocus(page));
      await page.keyboard.press("Tab");
    }
    const navHits = focusOrder.filter((entry) => /\[sidebar-(canvas|workboard|plans|threads|scheduled)\]/.test(entry));
    expect(
      navHits.length,
      `Tab 走过侧栏导航时没落到导航卡片上，实际顺序：${focusOrder.join(" → ")}`,
    ).toBeGreaterThanOrEqual(4);
    const focusVisible = await page.evaluate(() => {
      const active = globalThis.document.activeElement;
      if (!(active instanceof HTMLElement)) {
        return false;
      }
      const style = globalThis.getComputedStyle(active);
      return style.visibility !== "hidden" && style.display !== "none" && !active.hidden;
    });
    expect(focusVisible, "最后一个 Tab 落点是不可见元素").toBe(true);

    // 三、Enter 真的能进页面（不是只有鼠标能点）：焦点在「工作流」卡片上直接回车。
    await surfaces.getByRole("button", { name: ZH.navWorkflow, exact: false }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("workflow-cards-title")).toContainText("F22 键盘与焦点", {
      timeout: 20_000,
    });

    await saveProof(page, "T22-侧栏入口键盘可达.png");
  } finally {
    await app.close();
  }
});

test("T22 右栏模式切换与 Escape：焦点始终有着落，且不越权抢步骤详情里的按键", async () => {
  const { app, page, fixture } = await launchA11yFixture();
  try {
    await page.getByTestId("task-status-open-workflow").click();
    await expect(page.getByTestId("workflow-cards-title")).toContainText("F22 键盘与焦点", {
      timeout: 20_000,
    });

    // 一、双态按钮的可访问名是中文（「步骤卡 / 成果文件」在 `:1013-1032`，是 role=group 不是 tab）。
    const stepsTab = page.getByTestId("workflow-cards-tab-steps");
    const outputTab = page.getByTestId("workflow-cards-tab-output");
    await expect(stepsTab).toHaveAccessibleName(ZH.stepCards);
    await expect(outputTab).toHaveAccessibleName(ZH.outputFiles);
    // 右栏两个面板名同样是中文（`:1154-1170`）。
    await expect(page.getByTestId("workflow-cards-panel-step")).toHaveAccessibleName(ZH.panelStep);
    await expect(page.getByTestId("workflow-cards-panel-file")).toHaveAccessibleName(ZH.panelFile);

    // 二、打开产物预览 → 焦点必须进右栏（否则 Escape 的「归还」无从谈起）。
    const inspector = page.getByTestId("workflow-cards-inspector");
    await outputTab.click();
    await expect(outputTab).toHaveAttribute("aria-pressed", "true");
    const artifact = page.getByTestId(`workflow-cards-artifact-${fixture.产物路径}`).first();
    await expect(artifact).toBeVisible({ timeout: 20_000 });
    await artifact.click();
    await expect(page.getByTestId("workflow-cards-file-preview")).toBeVisible();
    expect(
      await inspector.evaluate((node) => node.contains(globalThis.document.activeElement)),
      `打开预览后焦点没进右栏，实际焦点：${await describeFocus(page)}`,
    ).toBe(true);

    // 三、Escape 归还焦点给打开它的产物入口（与 d5 同一条机制，这里换成中文界面复验）。
    await page.keyboard.press("Escape");
    expect(
      await artifact.evaluate((node) => globalThis.document.activeElement === node),
      `Escape 后焦点没回到产物入口，实际焦点：${await describeFocus(page)}`,
    ).toBe(true);
    // 归还后右栏回到步骤详情（Escape 的语义是「收起预览」，不是「清空选择」）。
    await expect(inspector.getByTestId("workflow-cards-detail-state")).toBeVisible();
    await expect(page.getByTestId("workflow-cards-file-preview")).toHaveCount(0);

    // 四、**不越权**：已经在步骤详情态时，Escape 不该满栏插手。
    // 守卫在 `workflow-cards-view.tsx:1145-1147`：`inspector !== "file"` 时直接 return，
    // 注释原话是「步骤详情里的 textarea 也在右栏，不该被满栏 Escape 抢走」。
    //
    // 这里验的是「不越权」的三个可观察面：右栏留在步骤详情、焦点不被抢走、页面不发生跳转。
    // 操作对象取**搜索框** `workflow-cards-search`（`:1039-1047`，常驻可编辑）：
    // 步骤详情里的输入框在运行中是 `disabled`（`locked`，`:1853`/`:1880`），无法打字。
    const search = page.getByTestId("workflow-cards-search");
    await expect(search).toBeVisible();
    await search.fill("写初稿");
    await page.keyboard.press("Escape");
    await expect(inspector.getByTestId("workflow-cards-detail-state")).toBeVisible();
    expect(
      await search.evaluate((node) => globalThis.document.activeElement === node),
      `步骤详情态按 Escape 把焦点从输入框抢走了，实际焦点：${await describeFocus(page)}`,
    ).toBe(true);
    // 清干净，别让搜索条件影响后面截图里看到的内容。
    await search.fill("");

    await saveProof(page, "T22-右栏Escape与焦点归还.png");
  } finally {
    await app.close();
  }
});

test("T22 中文界面不漏英文源串：侧栏与本页可见文案都走词典", async () => {
  const { app, page } = await launchA11yFixture();
  try {
    await page.getByTestId("task-status-open-workflow").click();
    await expect(page.getByTestId("workflow-cards-title")).toContainText("F22 键盘与焦点", {
      timeout: 20_000,
    });

    // 漏键会静默回退英文源串（`contracts/i18n.ts:21` `dictionaries[language][key] ?? key`），
    // DOM 里不报错、测试也不红——所以这里直接扫一遍**真可见文本**里还有没有英文源串。
    //
    // 只扫 T22 责任区：侧栏 + workflow-cards 的工具栏与右栏模式条。
    // 原因是产物正文、文件名、部门名是用户数据，本来就可能是英文，扫它们等于误报。
    const scanned = await page.evaluate(() => {
      const surfaces = globalThis.document.querySelector(
        '[data-testid="sidebar-work-surfaces"]',
      ) as HTMLElement | null;
      const toolbar = globalThis.document.querySelector(
        ".workflow-cards__toolbar",
      ) as HTMLElement | null;
      const inspectorSwitch = globalThis.document.querySelector(
        '[aria-label="右栏视图"],[aria-label="Inspector view"]',
      ) as HTMLElement | null;
      const collect = (scope: HTMLElement | null): string[] =>
        scope === null
          ? []
          : Array.from(scope.querySelectorAll<HTMLElement>("button, span, p, li"))
              .filter((node) => node.childElementCount === 0 && node.offsetParent !== null)
              .map((node) => node.textContent?.trim() ?? "")
              .filter((text) => text.length > 0);
      return {
        surfaces: collect(surfaces),
        toolbar: collect(toolbar),
        inspector: collect(inspectorSwitch),
      };
    });

    expect(scanned.surfaces.length, "侧栏导航区没扫到文本，断言会是空过").toBeGreaterThan(3);

    // 判据：**产品文案**不该是纯 ASCII 英文。用户数据（会话标题、工作区名）不在这里扫，
    // 侧栏导航区是纯产品文案，可以整段要求「不含 ASCII 英文单词」。
    const ENGLISH_WORD = /[A-Za-z]{3,}/;
    const englishLeft = scanned.surfaces.filter((text) => ENGLISH_WORD.test(text));
    expect(
      englishLeft,
      `侧栏导航区仍有英文源串（说明 i18n 漏键）：${englishLeft.join(" | ")}`,
    ).toEqual([]);

    // 工具栏同理：它的每一项都是产品文案（「步骤卡 / 成果文件 / N/M 步完成」）。
    expect(scanned.toolbar.length, "工具栏没扫到文本").toBeGreaterThan(2);
    const toolbarEnglish = scanned.toolbar.filter((text) => ENGLISH_WORD.test(text));
    expect(
      toolbarEnglish,
      `workflow-cards 工具栏仍有英文源串：${toolbarEnglish.join(" | ")}`,
    ).toEqual([]);

    await saveProof(page, "T22-中文界面无英文源串.png");
  } finally {
    await app.close();
  }
});
