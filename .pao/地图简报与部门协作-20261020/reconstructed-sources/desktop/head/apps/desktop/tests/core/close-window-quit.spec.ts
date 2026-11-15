/** 关窗退出行为：关掉最后一个窗口后应用进程必须退出（用户反馈的驻留回归）。 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { launchDesktop, makeUserDataDir, makeWorkspace } from "../helpers/electron-app";

const execFileAsync = promisify(execFile);
// quit 预算 5s + 草稿 flush 2s + 启动余量；超过即视为驻留，不是慢。
const QUIT_WITHIN_MS = 20_000;

async function launchCloseFixture() {
  const home = await makeWorkspace("close-home");
  const project = await makeWorkspace("close-project");
  await mkdir(join(home, "工作流"), { recursive: true });
  const recipe = {
    版本: 2,
    名字: "关窗验证",
    自动执行: false,
    参数: [],
    节点: [{ 名字: "开发", 部门: "工程", 目标: "实现", 验收: "检查", depends_on: [] }],
    ui: { positions: { 开发: { x: 40, y: 90 } } },
  };
  await writeFile(
    join(home, "工作流", "关窗验证.md"),
    `---\n${JSON.stringify(recipe)}\n---\n隔离测试配方\n`,
  );
  const app = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [project],
    testMode: "background",
    scrubProviderEnv: true,
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: "1" },
  });
  return { app, home };
}

async function expectAppExitedWithin(
  harness: Awaited<ReturnType<typeof launchCloseFixture>>["app"],
) {
  const exited = await Promise.race([
    harness.electronApp.waitForEvent("close").then(() => true),
    new Promise<false>((resolve) => {
      setTimeout(() => resolve(false), QUIT_WITHIN_MS);
    }),
  ]);
  if (!exited) {
    // 进程驻留时 playwright teardown 会挂死，先杀进程树再让断言报出事实。
    const pid = harness.electronApp.process().pid;
    if (pid && process.platform === "win32") {
      await execFileAsync("taskkill", ["/pid", String(pid), "/T", "/F"]).catch(() => undefined);
    } else if (pid) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  expect(exited, `应用应在关窗后 ${QUIT_WITHIN_MS / 1000}s 内退出`).toBe(true);
}

test("关闭最后一个窗口（脏画布，放弃修改）后应用退出", async () => {
  test.setTimeout(120_000);
  const { app } = await launchCloseFixture();
  try {
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-canvas").click();
    await page.getByTestId("canvas-recipe-row").filter({ hasText: "关窗验证" }).click();
    await page.getByTestId("workflow-node").filter({ hasText: "开发" }).click();
    await page.getByTestId("workflow-inspector").getByLabel("任务目标").fill("未保存草稿");
    await expect(page.getByTestId("recipe-canvas-editor")).toContainText("未保存");
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    const dialog = page.getByRole("dialog", { name: "未保存修改", exact: true });
    await dialog.getByRole("button", { name: "放弃并继续" }).click();
    await expectAppExitedWithin(app);
  } finally {
    await app.close();
  }
});

test("关闭最后一个窗口（无未保存内容）后应用退出", async () => {
  test.setTimeout(120_000);
  const { app } = await launchCloseFixture();
  try {
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-canvas").click();
    await page.getByTestId("canvas-recipe-row").filter({ hasText: "关窗验证" }).click();
    await expect(page.getByTestId("workflow-node")).toHaveCount(1);
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await expectAppExitedWithin(app);
  } finally {
    await app.close();
  }
});

test("托盘模式：关窗隐藏到托盘，托盘可唤回与退出", async () => {
  test.setTimeout(120_000);
  const { app } = await launchCloseFixture();
  try {
    const page = await app.firstWindow();
    await page.evaluate(async () => {
      const piApp = globalThis.window.piApp;
      if (!piApp) throw new Error("piApp IPC bridge is unavailable");
      await piApp.setCloseWindowBehavior("tray");
    });
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    // 进程驻留（有意）、窗口隐藏而非销毁。
    await expect
      .poll(() =>
        app.electronApp.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0];
          return window ? !window.isVisible() : "destroyed";
        }),
      )
      .toBe(true);
    expect(app.electronApp.process().exitCode).toBeNull();
    // 托盘「显示窗口」唤回。
    await app.electronApp.evaluate(() => {
      (
        globalThis as { __PI_APP_TEST_HOOKS?: { triggerTrayAction?: (a: "show") => void } }
      ).__PI_APP_TEST_HOOKS?.triggerTrayAction?.("show");
    });
    await expect
      .poll(() =>
        app.electronApp.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0];
          return window?.isVisible() ?? false;
        }),
      )
      .toBe(true);
    // 再次关窗仍隐藏，托盘「退出」结束进程。
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await expect
      .poll(() =>
        app.electronApp.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0];
          return window ? !window.isVisible() : "destroyed";
        }),
      )
      .toBe(true);
    await app.electronApp.evaluate(() => {
      (
        globalThis as { __PI_APP_TEST_HOOKS?: { triggerTrayAction?: (a: "quit") => void } }
      ).__PI_APP_TEST_HOOKS?.triggerTrayAction?.("quit");
    });
    await expectAppExitedWithin(app);
  } finally {
    await app.close();
  }
});
