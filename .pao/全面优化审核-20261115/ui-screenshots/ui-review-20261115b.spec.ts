/**
 * 一次性界面评审截图（2026-11-15）补拍：15-18 设置分页 + 700 宽剩余屏。
 * 不是回归测试：只截屏，不断言。
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

const execFileAsync = promisify(execFile);
const OUT = process.env.UI_REVIEW_OUT ?? resolve(__dirname, "screenshots");
const KERNEL_PAO_DIST = resolve(
  __dirname,
  "../../node_modules/@pao/coding-agent/dist/pao",
);

async function shot(page: Page, name: string): Promise<void> {
  await mkdir(OUT, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`[shot] ${name}`);
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
  await page.waitForTimeout(300);
}

/** 与 ui-review-20261115.spec.ts 相同的看板夹具（最小版：列各一卡 + 项目清单 + 部门注册表）。 */
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
async function 建卡(目标, 部门, 验收, 正文) {
  return cards.createCard(卡目录甲, {
    目标, 部门, 验收,
    创建: "2026-10-05 09:00", 状态: "unclaimed",
  }, { 模板正文: 正文 });
}
function 认领(card) {
  return cards.changeCardStatus(card, { 操作者: 主控, to: "in_progress", 时间: "2026-10-05 09:30" });
}
mkdirSync(join(paoHome, "部门", "工程"), { recursive: true });
mkdirSync(卡目录甲, { recursive: true });
writeFileSync(join(paoHome, "项目清单.md"), formatProjectList([
  { 项目名: "隔离项目甲", 项目根: 项目根甲, 首次服务: "2026-10-05 09:00", 最近服务: "2026-10-05 09:00" },
]));
writeFileSync(join(paoHome, "部门", "注册表.md"), formatRegistry([
  { 名字: "工程", 标签: ["实现"], 库路径: join("部门", "工程"), 建部日期: "2026-10-05" },
]));
await 建卡("甲卡待认领", "工程", "验收甲", "甲卡正文。");
const 乙 = 认领(await 建卡("乙卡进行中", "工程", "验收乙", "乙卡正文。"));
const 丙 = 认领(await 建卡("丙卡已交付", "工程", "验收丙", "丙卡正文。"));
cards.changeCardStatus(丙, { 操作者: 主控, to: "delivered", 时间: "2026-10-05 10:10" });
console.log("ok");
`;

test("UI 评审截图补拍", async () => {
  test.setTimeout(600_000);

  const home = await makeWorkspace("uireview-home-b");
  const project = await makeWorkspace("uireview-project-b");
  await mkdir(join(home, "部门"), { recursive: true });

  const kanbanScript = join(home, "seed-kanban.mjs");
  await writeFile(kanbanScript, KANBAN_FIXTURE, "utf8");
  await execFileAsync(process.execPath, [kanbanScript, KERNEL_PAO_DIST, home, project]);

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
    await setWindowSize(app, page, 1280, 860);
    await createNamedThread(page, "补拍会话");

    // ---- 设置各分页 ----
    await page.evaluate(async () => {
      await window.piApp.setActiveView("settings");
    });
    await page.waitForTimeout(600);
    // 打印所有可点的按钮/链接，便于定位分页名
    const navItems = await page.locator("button, [role=tab], [role=link]").allTextContents();
    console.log("[nav items]", JSON.stringify(navItems.slice(0, 40)));
    // 依次尝试常用分页
    for (const [re, name] of [
      [/模型|Models|模型设置/i, "15-设置-模型-1280"],
      [/供应商|Providers|提供方|接入/i, "16-设置-供应商-1280"],
      [/外观|Appearance|主题/i, "17-设置-外观-1280"],
      [/通知|Notifications/i, "18-设置-通知-1280"],
    ] as const) {
      const item = page.getByRole("button", { name: re }).first();
      if (await item.count()) {
        try {
          await item.click({ timeout: 3_000 });
          await page.waitForTimeout(400);
          await shot(page, name);
        } catch (err) {
          console.log("[skip]", name, String(err).slice(0, 120));
        }
      }
    }

    // ---- 700 宽 ----
    await setWindowSize(app, page, 700, 800);
    await page.evaluate(async () => {
      await window.piApp.setActiveView("threads");
    });
    await page.waitForTimeout(400);
    await shot(page, "28-会话视图-700");

    // 700px 时侧栏仍占位，把工作看板按钮通过 JS 打开
    await page.evaluate(async () => {
      await window.piApp.setActiveView("workboard");
    });
    await page.waitForTimeout(600);
    // 切到「原始任务卡」tab —— 通过 JS click 绕过侧栏遮挡
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const tab = buttons.find((b) => (b.textContent || "").trim() === "原始任务卡");
      tab?.click();
    });
    await page.waitForTimeout(500);
    await shot(page, "29-看板-700");

    await page.evaluate(async () => {
      await window.piApp.setActiveView("plans");
    });
    await page.waitForTimeout(600);
    await shot(page, "30-工作流-画布-700");

    await page.evaluate(async () => {
      await window.piApp.setActiveView("memory");
    });
    await page.waitForTimeout(500);
    await shot(page, "31-记忆页-700");

    // ---- 900 宽补漏 ----
    await setWindowSize(app, page, 900, 800);
    await page.evaluate(async () => {
      await window.piApp.setActiveView("workboard");
    });
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const tab = buttons.find((b) => (b.textContent || "").trim() === "原始任务卡");
      tab?.click();
    });
    await page.waitForTimeout(500);
    await shot(page, "24-看板-900");

    console.log("[done] remaining shots saved to", OUT);
  } finally {
    await app.close();
  }
});
