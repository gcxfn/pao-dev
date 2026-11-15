/** pao 内置 view（部门详情）保稿：S12 故障④——前端连接清单漏 PaoPulse，
 *  observe 在渲染层抛 not allowlisted、整个视图挂掉。清单回填后此例守住
 *  「view 能真打开（mount 不炸）」，覆盖前端 dist 与连接声明的契约。
 *  部门总览断言（A3）：真实内核读侧从项目 .pao/卡/ 解析多部门卡后渲染出部门卡，
 *  空项目也能过标题断言，部门卡文本才是「数据真到位」的证据。 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";
import { expectExtensionViewReady } from "../helpers/desktop-extension-fixture";

async function openPaoView(window: Page, title: string): Promise<FrameLocator> {
  const workbench = window.getByTestId("workbench");
  if (!(await workbench.isVisible())) await window.getByTestId("toggle-side-panel").click();
  const tab = workbench.getByRole("tab", { name: title, exact: true });
  if (await tab.count()) await tab.click();
  else {
    const chooser = window.getByTestId("workbench-chooser");
    if (!(await chooser.isVisible())) await window.getByTestId("workbench-add-tab").click();
    await chooser.getByRole("button", { name: title, exact: true }).click();
  }
  return window.frameLocator('[data-testid="extension-view-frame"]');
}

test("pao 内置 view（部门详情）可打开，pulse 服务在连接 allowlist", async () => {
  const home = await makeWorkspace("pao-view-home");
  const project = await makeWorkspace("pao-view-project");
  await mkdir(join(home, "工作流"), { recursive: true });
  // 项目里放两张不同部门的卡（内核 readDesktopProject 从 .pao/卡/ 真解析），
  // 部门总览据此渲染出部门卡——空项目也能过标题断言，这里断言数据面真到位。
  const cardsDir = join(project, ".pao", "卡");
  await mkdir(cardsDir, { recursive: true });
  const card = (no: number, dept: string) =>
    `---\ngoal: 部门卡渲染断言${no}\ndept: ${dept}\nacceptance: 只看渲染\nattempt: 0\ncreated: "2026-10-10 10:00"\nstatus: unclaimed\n---\n`;
  await writeFile(join(cardsDir, "卡0001-assert.md"), card(1, "审查部"));
  await writeFile(join(cardsDir, "卡0002-assert.md"), card(2, "开发部"));
  const app = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [project],
    testMode: "background",
    scrubProviderEnv: true,
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: "0" },
  });
  try {
    const window = await app.firstWindow();
    // workbench 挂在会话上：先建一个线程（core 车道 fake 模型）。
    await createNamedThread(window, "部门详情保稿");
    const frame = await openPaoView(window, "部门详情");
    // mount 抛错（含 not allowlisted）会渲染「无法打开此视图」；成功则出标题。
    await expect(frame.getByRole("heading", { name: "部门详情" })).toBeVisible({
      timeout: 15_000,
    });
    // 部门总览真渲染：两个部门的部门卡（卡部门来源）实际出现在页面上。
    await expect(frame.getByRole("heading", { name: "部门总览", exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(frame.getByRole("heading", { name: "审查部", exact: true })).toBeVisible();
    await expect(frame.getByRole("heading", { name: "开发部", exact: true })).toBeVisible();
    await expectExtensionViewReady(window);
  } finally {
    const page = app.electronApp.windows().find((window) => !window.isClosed());
    if (page) await app.close();
  }
});
