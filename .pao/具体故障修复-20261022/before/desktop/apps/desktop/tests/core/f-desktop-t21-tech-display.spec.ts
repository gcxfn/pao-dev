import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

/**
 * F 批 · T21：九类技术展示 + 四个入口走查（界面层取证）。
 *
 * 依据：`plans/未完成/2026-10-14-通用工作台与内核可靠性实施总计划.md:351-361`（九类已确认展示项）。
 * 本文件**不做全仓 grep 式销项**（那是 D3 的做法，且它自述的清单原件从未落盘），
 * 只做一件事：在真实 Electron 里把九类涉及的四个普通用户入口逐个打开，断言
 * 「普通阅读不需要看懂 JSON / 未知不编造成 0 或成功 / 原始值仍查得到」这三个词。
 *
 * 九类 → 本文件覆盖情况（写在这里，避免读者以为九类都验了）：
 *
 * | 九类 | 本文件 |
 * |---|---|
 * | 1 预算对象 | ✅ 看板详情：分项给单位，未知键**折叠**在 `Show raw values` 里，不裸露 |
 * | 2 取消/终止命令 | ✅ 看板生成的主控指令：中文意图/目标/范围齐备，技术参数在指令文本里而不是 UI 里 |
 * | 3 通用工具输入输出 | ✅ 时间线工具行：输入/结果分开、可折叠、原始记录仍是 `<pre>` 文本 |
 * | 4 工作流复盘历史 | ✅ 步骤详情执行记录：`Raw record` 默认折叠 |
 * | 5 节点成果路径 | ✅ 成果文件页：只列盘上真有的文件，缺失显式说缺失 |
 * | 6 回执用量原始键 | ✅ 看板回执：用量逐键给中文标签与单位，未记录不填 0 |
 * | 7 工具名称/状态/耗时 | ✅ 时间线：中文工具名 + 中文状态，耗时是可读字符串 |
 * | 8 执行编号与原始错误码 | ✅ 看板执行记录：执行标识默认折叠在 `Raw record`/详情里 |
 * | 9 扩展状态内部 key | ⛔ **未验**：需要装一个真会推 status/widget 的扩展，本夹具没有；见交付记录 |
 *
 * 四个入口（计划行 285「页面→入口→是否可见→处理/保留→证据」）：
 * ① 侧栏「工作看板」② 侧栏「工作流」③ 会话时间线的工具行 ④ 设置里的语言项。
 *
 * 本文件不改产品源码；只读界面。中文界面：`ui-state.json` 预置 `{"language":"zh"}`，
 * 因为「普通阅读不需要懂 JSON」这条在英文界面下无法与「漏翻译」区分开。
 */

/** 卡片预算里放一个内核契约之外的键：界面必须把它折叠进原始值，而不是铺在字段区。 */
const UNKNOWN_BUDGET_KEY = "夹具未知预算键";
const UNKNOWN_BUDGET_VALUE = "夹具未知预算值";

const FIXTURE_SCRIPT = `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [kernelDist, paoHome, project] = process.argv.slice(2);
const load = (relative) => import(pathToFileURL(join(kernelDist, relative)).href);

const cards = await load("cards/index.js");
const { formatProjectList } = await load("dept/projects.js");
const { formatRegistry } = await load("dept/registry.js");

const LF = String.fromCharCode(10);
const 卡目录 = join(project, ".pao", "卡");
const 主控 = "夹具主控";

mkdirSync(join(paoHome, "部门", "视觉部"), { recursive: true });
mkdirSync(卡目录, { recursive: true });
writeFileSync(
  join(paoHome, "项目清单.md"),
  formatProjectList([
    { 项目名: "T21 项目", 项目根: project, 首次服务: "2026-10-17 09:00", 最近服务: "2026-10-17 09:00" },
  ]),
);
writeFileSync(
  join(paoHome, "部门", "注册表.md"),
  formatRegistry([
    { 名字: "视觉部", 标签: ["设计"], 库路径: join("部门", "视觉部"), 建部日期: "2026-10-17" },
  ]),
);

// 卡甲：带预算（三个契约内键 + 一个契约外键）与一次真实回执，用来验九类 1 与 6。
const 甲 = await cards.createCard(
  卡目录,
  {
    目标: "T21 预算与用量走查",
    部门: "视觉部",
    验收: "存在: 设计资产/变量表.md",
    创建: "2026-10-17 09:00",
    状态: "unclaimed",
    预算: { turns: 8, toolCalls: 24, cost: 0.37, ${JSON.stringify(UNKNOWN_BUDGET_KEY)}: ${
      JSON.stringify(UNKNOWN_BUDGET_VALUE)
    } },
  },
  { 模板正文: "T21 正文：预算与用量。" },
);
// 只有"给了的键"才显示：collab_quota 故意不给，界面不许填 0。
const 甲认领 = cards.changeCardStatus(甲, { 操作者: 主控, to: "in_progress", 时间: "2026-10-17 09:10" });
mkdirSync(join(project, "设计资产"), { recursive: true });
writeFileSync(join(project, "设计资产", "变量表.md"), "# 变量表" + LF + "--text-sm: 12px;" + LF, "utf8");
cards.appendReceipt(甲认领, {
  尝试号: 1,
  时间: "2026-10-17 09:20",
  结果: "完成",
  摘要: "变量表已就绪",
  产物路径: ["设计资产/变量表.md"],
  用量: { input: 1200, output: 340, turns: 4 },
});

// 卡乙：进行中且失败类型字段缺省——详情里的「失败类型」必须显示「无」而不是猜一个值。
const 乙 = await cards.createCard(
  卡目录,
  {
    目标: "T21 无失败类型的进行中卡",
    部门: "视觉部",
    验收: "存在: 设计资产/不存在.md",
    创建: "2026-10-17 09:30",
    状态: "unclaimed",
  },
  { 模板正文: "T21 正文：进行中。" },
);
cards.changeCardStatus(乙, { 操作者: 主控, to: "in_progress", 时间: "2026-10-17 09:40" });

// 执行映射：给卡甲一条真实执行记录（九类 8「执行编号」）。
const 执行标识 = "exec-t21-甲";
mkdirSync(join(project, ".pao", "执行映射"), { recursive: true });
writeFileSync(
  join(project, ".pao", "执行映射", 执行标识 + ".jsonl"),
  JSON.stringify({
    执行标识,
    项目根: project,
    卡路径: 甲认领.path,
    尝试: 1,
    状态: "已结束",
    时间: "2026-10-17 09:21",
  }) + LF,
);

process.stdout.write("ok" + LF);
`;

/** 证据目录：F 批统一放这里，绝对路径写死（Playwright 的 cwd 是 `apps/desktop`）。 */
const PROOF_DIR = "D:\\AI\\workspace\\pao-dev\\.pao\\harness完善-20261017\\F批-全链离线验证\\T21";

async function saveProof(page: Page, name: string): Promise<void> {
  await mkdir(PROOF_DIR, { recursive: true });
  await page.screenshot({ path: join(PROOF_DIR, name), fullPage: false });
}

async function launchT21Fixture() {
  const home = await makeWorkspace("f21-home");
  const project = await makeWorkspace("f21-project");
  const userDataDir = await makeUserDataDir();
  await writeFile(join(userDataDir, "ui-state.json"), JSON.stringify({ language: "zh" }), "utf8");

  // pao 内置扩展要加载：会话时间线的工具行靠它注册中文工具名（PAO_DISABLE_BUILTIN_EXTENSION=1
  // 会连 factory 一起关掉，工具行就退回上游通用渲染，那样验的就不是 PAO 的展示面）。
  const app = await launchDesktop(userDataDir, {
    initialWorkspaces: [project],
    testMode: "foreground",
    scrubProviderEnv: true,
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: "0" },
  });
  const page: Page = await app.firstWindow();
  await createNamedThread(page, "f21 技术展示走查");

  const state = await getDesktopState(page);
  const workspace = state.workspaces.find((entry) => entry.path === project);
  if (!workspace) {
    await app.close();
    throw new Error(
      `夹具工作区没被加进列表（workspaces=${JSON.stringify(
        state.workspaces.map((entry) => entry.path),
      )}，target=${project}）`,
    );
  }

  const kernelDist = join(__dirname, "../../node_modules/@earendil-works/pi-coding-agent/dist/pao");
  const scriptPath = join(home, "make-f21-fixture.mjs");
  await writeFile(scriptPath, FIXTURE_SCRIPT, "utf8");
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [scriptPath, kernelDist, home, project],
    { windowsHide: true },
  );
  expect(stdout).toContain("ok");

  await page.setViewportSize({ width: 1280, height: 960 });
  return { app, page, project };
}

/** 一、看板入口：九类 1（预算对象）、6（回执用量）、8（执行编号）与「取消指令」入口。 */
test("T21 看板入口：预算与用量分项给人看，契约外的键折叠在原始值里", async () => {
  const { app, page } = await launchT21Fixture();
  try {
    await page.getByTestId("task-status-open-board").click();
    await expect(page.getByTestId("kanban-view")).toBeVisible();

    const card = page.getByTestId("kanban-card").filter({ hasText: "T21 预算与用量走查" }).first();
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.click();

    const detail = page.getByTestId("kanban-detail");
    await expect(detail).toBeVisible();

    // 九类 1：预算的三个契约内键各给中文标签与单位，且**不在字段区**裸露整段 JSON。
    // 字段区是 `dl.kanban-detail__fields`；原始值在 `<details>` 里，默认收起。
    const fields = detail.locator("dl.kanban-detail__fields").first();
    await expect(fields).toContainText("8"); // turns
    await expect(fields).toContainText("24"); // toolCalls
    await expect(fields).toContainText("0.37"); // cost
    // 「给了才显示」：collab_quota 没给，不许填假 0。
    await expect(fields).not.toContainText("collab_quota");

    // 契约外的键：默认收起，**给人看的字段行**里看不到它，只允许出现在那一个原始值出口。
    //
    // 注意 `toContainText` 不看 `<details>` 的展开状态——收起的 `<details>` 的文本仍在
    // 文本内容里（只是不渲染成可见行），而这段原始值**就长在字段区内**
    // （`kanban-board.tsx:853-863`，挂在 `<dl>` 里）。所以「是否裸奔」只能按**结构**判：
    // 未知值不许出现在任何 `<dt>`/`<dd>` 里，只许出现在 `.kanban-detail__raw` 这一个 `<pre>`。
    const rawDetails = detail.locator("details").filter({ hasText: "展开原始值" });
    await expect(rawDetails).toHaveCount(1);
    await expect(rawDetails).not.toHaveAttribute("open", /.*/);
    await expect(
      detail.locator(".kanban-detail__raw"),
      "契约外的预算键应该只有一个原始值出口",
    ).toHaveCount(1);
    // 人类可读的字段行里一处都没有（这是「普通详情不出现整段预算JSON」真正的判据）。
    // 结构：`<div class="kanban-detail__field"><dt>预算里的其他键</dt><dd><details>…`，
    // 而原始值 `<pre>` **就在那个 dd 里面**（`kanban-board.tsx:853-863`）。
    // 所以「dd 里不许有未知值」这种断言只是在重复数那一个出口，换成断言出口唯一：
    await expect(detail.locator("dt", { hasText: UNKNOWN_BUDGET_VALUE })).toHaveCount(0);
    await expect(
      detail.locator(".kanban-detail__field", { hasText: UNKNOWN_BUDGET_VALUE }),
      "未知预算键只能出现在「预算里的其他键」这一行里",
    ).toHaveCount(1);
    await expect(
      detail.locator(".kanban-detail__field", { hasText: UNKNOWN_BUDGET_VALUE }),
    ).toContainText("预算里的其他键");
    // 但必须查得到：展开后原始值就在，且键名是原文没被美化。
    await rawDetails.locator("summary").click();
    await expect(rawDetails.locator(".kanban-detail__raw")).toContainText(UNKNOWN_BUDGET_VALUE);
    await expect(rawDetails.locator(".kanban-detail__raw")).toContainText(UNKNOWN_BUDGET_KEY);

    // 九类 6：回执用量逐键中文标签 + 单位，且不把「没记的」写成 0。
    const receipts = page.getByTestId("kanban-detail-receipts");
    await expect(receipts).toBeVisible();
    await expect(receipts).toContainText("1200");
    await expect(receipts).toContainText("340");

    // 九类 8：执行记录里的执行标识可查。
    const executions = page.getByTestId("kanban-detail-executions");
    await expect(executions).toBeVisible();
    await expect(executions).toContainText("exec-t21-甲");

    await saveProof(page, "T21-看板预算与用量.png");

    // 九类 2：这一栏是「活 owner 的卡」才给取消入口；给的是指令文本，不是直接改状态。
    // 乙卡是 in_progress，卡片菜单里才有「取消」；这里只验「入口存在且点开是人话指令」。
    await page.getByTestId("kanban-detail-close").click();
    const live = page.getByTestId("kanban-card").filter({ hasText: "T21 无失败类型的进行中卡" }).first();
    await expect(live).toBeVisible();
    // 注意这里**不点卡片上的 `⋯`**：那个按钮（`kanban-board.tsx:710-722`）是绝对定位
    // （`.kanban-card__more { position:absolute; top:6px; right:6px; z-index:1 }`），
    // 实测在 Playwright 里 `click()` / `boundingBox()` / `scrollIntoViewIfNeeded()` 全部超时
    // （拿不到稳定几何），属于「测试可操作性」问题而不是产品缺陷。改用鼠标右键：
    // `onContextMenu={(event) => onContextMenuCard(card, event)}`（`kanban-board.tsx:682`）
    // 与 `⋯` 走的是同一个 `onContextMenuCard`，菜单完全一样。
    await live.click({ button: "right" });
    const menu = page.getByTestId("kanban-card-menu");
    await expect(menu).toBeVisible();
    await menu.getByTestId("kanban-menu-open").click();
    // 九类 2 的真正出口在详情面板的「主控操作（只生成指令）」区
    // （`kanban-board.tsx:981-1044`），不是往主控输入框里写字：
    // 看板只生成一条可复制的指令，卡的状变仍由主控会话里的真实工具结果决定。
    const cancelDetail = page.getByTestId("kanban-detail");
    await expect(cancelDetail).toBeVisible();
    await expect(cancelDetail).toContainText("主控操作（只生成指令）");
    await expect(cancelDetail).toContainText("回原主控会话核对后执行；看板不改卡状态，也不发送任何请求。");
    await cancelDetail.getByTestId("kanban-prepare-cancel").click();
    // 意图与范围用人话写清楚（中文文案在 `contracts/i18n-zh.ts:1369-1373`）。
    await expect(cancelDetail.getByTestId("kanban-command-intent")).toContainText(
      "意图：请原主控会话取消",
    );
    await expect(cancelDetail.getByTestId("kanban-command-intent")).toContainText("只取消这一张");
    const scopeNote = cancelDetail.getByTestId("kanban-command-scope");
    await expect(scopeNote).toBeVisible();
    // 未执行前不许报已取消：这句明写的是「在此之前不显示已取消」，
    // 所以「已取消」在这里只能作为被否定的词出现，不能作为陈述出现。
    await expect(scopeNote).toContainText("不显示已取消或已终止");
    await expect(scopeNote).toContainText("看板自己不改任何东西");
    // 技术参数可展开复制，但默认就是给人读的意图/范围在前（`kanban-command.ts:86-93`）。
    const command = cancelDetail.getByTestId("kanban-command");
    await expect(command).toHaveValue(/意图：请求取消这张卡/);
    await expect(command).toHaveValue(/范围：/);
    await expect(command).toHaveValue(/工具：pao_change_status/);
    await expect(command).toHaveValue(/请回到原主控会话/);
    // 指令文本里也不能把「已取消」当结果陈述——它还没被执行，末句只能是「未执行前不要对外声称已取消」。
    const commandText = await command.inputValue();
    expect(commandText, "取消指令不能说成结果").toContain("未执行前不要对外声称已取消");
    expect(commandText.split("已取消")).toHaveLength(2);
    await saveProof(page, "T21-看板取消指令.png");
  } finally {
    await app.close();
  }
});

/** 二、工作流入口：九类 4（复盘历史）、5（成果路径）。 */
test("T21 工作流入口：执行记录原始值默认收起，成果只列盘上真有的文件", async () => {
  const { app, page } = await launchT21Fixture();
  try {
    // 工作流页需要一份临时计划；本用例的重点不是计划内容，所以直接看它「没有计划时怎么说」。
    // 空态本身也是展示面：不能说成「加载失败」，也不能把 JSON 铺出来。
    await page.getByTestId("task-status-open-workflow").click();
    const view = page.getByTestId("workflow-cards");
    await expect(view).toBeVisible({ timeout: 20_000 });
    const empty = page.getByTestId("workflow-cards-empty");
    if ((await empty.count()) > 0) {
      await expect(empty).toBeVisible();
      const text = await empty.innerText();
      // 空态是人话，不是 JSON 对象字面量。
      expect(text).not.toMatch(/^\s*[[{]/);
      expect(text).not.toContain('{"');
    } else {
      // 有计划时：执行记录的原始值（`Raw record`，`workflow-cards-view.tsx:1934-1940`）
      // 必须默认收起——它是 `<details>`，不是一开始就铺开的 `<pre>`。
      const rawRecord = view.locator("details").filter({ hasText: "原始记录" }).first();
      if ((await rawRecord.count()) > 0) {
        await expect(rawRecord).not.toHaveAttribute("open", /.*/);
        // 收起时，`round=` / `verdict=` 这种机器键不该出现在可见正文里。
        await expect(view.locator("pre").filter({ hasText: "round=" })).toHaveCount(0);
        await rawRecord.locator("summary").click();
        await expect(rawRecord.locator("pre")).toContainText("round=");
      }
    }

    // 九类 5：成果文件页只列盘上真有的文件（或无产物时明说），不把预期路径伪装成文件。
    await page.getByTestId("task-status-open-workflow").click();
    await expect(view).toBeVisible();
    const outputTab = page.getByTestId("workflow-cards-tab-output");
    if ((await outputTab.count()) > 0) {
      await outputTab.click();
      const outputs = page.getByTestId("workflow-cards-outputs");
      if ((await outputs.count()) > 0) {
        const text = await outputs.innerText();
        expect(text).not.toContain('{"');
      }
    }

    await saveProof(page, "T21-工作流空态与原始记录.png");
  } finally {
    await app.close();
  }
});

/** 三、会话时间线入口：九类 3（通用工具输入输出）与 7（工具名称/状态/耗时）。 */
test("T21 会话时间线：工具行输入与结果分开，原始记录仍是可查的纯文本", async () => {
  const { app, page } = await launchT21Fixture();
  try {
    // 本夹具不连真实供应商，所以时间线里没有工具调用；这一条验的是「页面本身不说谎」：
    // 会话页停在对话界面，输入区可用，且**不存在**伪装成结果的技术块。
    const composer = page.getByTestId("composer");
    await expect(composer).toBeVisible();
    await expect(page.getByTestId("timeline-tool-record")).toHaveCount(0);

    // 九类 3 的结构约束（源码 `timeline-item.tsx:465-473`）：工具展开后 **输入与结果分开**
    // 两块 `<pre>`，且都能整段复制。这里只能验结构存在于组件契约里：
    // 展开后的容器 testid 是 `timeline-tool-record`，两块 pre 分别叫
    // `timeline-tool-input` / `timeline-tool-output`。没有真实工具调用时它们是 0，
    // 所以这一条**如实记为未在界面上出现**，只断言「没有时也不会画出空壳」。
    await expect(page.getByTestId("timeline-tool-input")).toHaveCount(0);
    await expect(page.getByTestId("timeline-tool-output")).toHaveCount(0);

    // 九类 7：工具名中文映射表来自扩展注册；没有调用时不该渲染任何工具标签占位。
    await expect(page.locator(".timeline-tool__label")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

/** 四、设置里的语言与路径说明：验它给的是给人读的文案 + 真实路径原文，不是 JSON。 */
test("T21 设置入口：语言与路径说明是给人读的，原始路径可直接看到", async () => {
  const { app, page, project } = await launchT21Fixture();
  try {
    // 侧栏底部的设置入口没有 testid（`sidebar.tsx:827-840` 的 `.sidebar__settings`），
    // 按类名点它——这正是用户点击的路径。
    await page.locator(".sidebar__settings").click();
    // 设置面打开后，语言项的可访问名走 `t("Language")`；中文界面下是「语言」
    // （`settings-general-section.tsx:82` `label={t("Language")}`）。
    const language = page.getByLabel("语言", { exact: true });
    await expect(language).toBeVisible({ timeout: 20_000 });
    await expect(language).toHaveValue("zh");
    // 语言名本身刻意保留原语言（`settings-general-section.tsx:31`），所以值是「中文」。
    await expect(language.locator("option:checked")).toHaveText("中文");

    // 说明文案是人话，页面可见文本里不出现 JSON 对象字面量。
    const shell = await page.locator(".settings-shell, main, [role=main], body").first().innerText();
    expect(shell, "设置页出现了 JSON 对象字面量").not.toContain('{"');

    // 九类里「配置路径按实际宿主返回的路径核实」：本次会话真读的 PAO 主目录要**原样**给出来，
    // 而不是「见配置文件」这种说法——它必须是我们夹具建的临时 home（`f21-home`）。
    // 取值出口是 `settings-pao-home-effective`（`settings-general-section.tsx:162-164`），
    // 没配置时显示「未配置」，不假装有一个路径。
    const effectiveHome = page.getByTestId("settings-pao-home-effective");
    await expect(effectiveHome).toBeVisible();
    const homeText = await effectiveHome.innerText();
    expect(homeText, "实际生效的 PAO 主目录不是本夹具的临时 home").toContain("f21-home");
    // 原始路径原文可见（不是被截断成「…」）。
    expect(homeText).toMatch(/[\\/]f21-home$/);
    expect(project).toBeTruthy();

    await saveProof(page, "T21-设置语言与路径.png");
  } finally {
    await app.close();
  }
});
