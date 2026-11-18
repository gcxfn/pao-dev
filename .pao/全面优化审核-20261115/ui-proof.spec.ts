/** 界面专项取证：使用隔离 Electron 夹具，输出到 ui-screenshots/after。 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "../../desktop/node_modules/@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../../desktop/apps/desktop/tests/helpers/electron-app";

test("界面专项截图", async () => {
  const task = process.env.UI_PROOF_TASK ?? "U02";
  const home = await mkdtemp(join(tmpdir(), `pao-${task}-proof-`));
  const project = await makeWorkspace(`${task.toLowerCase()}-project`);
  const userData = await makeUserDataDir();
  await writeFile(join(userData, "ui-state.json"), JSON.stringify({ language: "zh" }));
  const app = await launchDesktop(userData, {
    initialWorkspaces: [project],
    testMode: "background",
    scrubProviderEnv: true,
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: "1" },
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 800 });
    await createNamedThread(page, "界面验收会话");
    if (task === "U02") {
      await expect(page.locator(".session-row__time")).toContainText("刚刚");
    }
    if (task === "U03") {
      await expect(page.getByTestId("composer")).toHaveAttribute(
        "placeholder",
        "描述要做的事，或继续当前对话…",
      );
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await page.getByRole("button", { name: "通知", exact: true }).click();
      await expect(page.getByTestId("settings-surface")).toContainText("通知由 Windows");
      await expect(page.getByTestId("settings-surface")).not.toContainText("macOS");
    }
    if (task === "U06") {
      await page.getByTestId("toggle-side-panel").click();
      const workbench = page.getByTestId("workbench");
      const review = workbench.getByRole("tab", { name: "审查", exact: true });
      if (await review.count()) await review.click();
      else {
        if (!(await page.getByTestId("workbench-chooser").isVisible())) {
          await page.getByTestId("workbench-add-tab").click();
        }
        await page
          .getByTestId("workbench-chooser")
          .getByRole("button", { name: "审查", exact: true })
          .click();
      }
      await expect(page.getByTestId("changed-files-unavailable")).toBeVisible();
    }
    const out = join(__dirname, "ui-screenshots", "after");
    await mkdir(out, { recursive: true });
    for (const [width, height, theme, suffix] of [
      [1280, 800, "light", "1280"],
      [900, 700, "light", "900"],
      [1280, 800, "dark", "1280-dark"],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.evaluate((mode) => window.piApp!.setThemeMode(mode), theme);
      if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
      else await expect(page.locator("html")).not.toHaveClass(/dark/);
      if (width === 900 && task !== "U03") await expect(page.locator(".sidebar")).toHaveCount(0);
      if (task === "U06") {
        const retry = page
          .getByTestId("changed-files-unavailable")
          .getByRole("button", { name: "重试", exact: true });
        await expect(retry).toHaveCSS("white-space", "nowrap");
        const box = await retry.boundingBox();
        expect(box!.width).toBeGreaterThan(box!.height);
      }
      await page.screenshot({ path: join(out, `${task}-${suffix}.png`) });
    }
  } finally {
    await app.close();
  }
});
