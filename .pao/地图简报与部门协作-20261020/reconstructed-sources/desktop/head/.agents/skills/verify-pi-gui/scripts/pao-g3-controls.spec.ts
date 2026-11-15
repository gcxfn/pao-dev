import { test, expect, type Page } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  launchDesktop,
  type DesktopHarness,
} from "../../../../apps/desktop/tests/helpers/electron-app";
import { expectExtensionViewReady } from "../../../../apps/desktop/tests/helpers/desktop-extension-fixture";

// 只驱动真实窗口和本地扩展命令，不发送聊天。原Alpha/Bravo及卡片是既有验收fixture。
async function openView(page: Page, name: string) {
  if (!(await page.getByTestId("workbench").isVisible()))
    await page.getByTestId("toggle-side-panel").click();
  await page.getByTestId("workbench-add-tab").click();
  await page.getByTestId("workbench-chooser").getByRole("button", { name, exact: true }).click();
  await expectExtensionViewReady(page);
  return page.frameLocator('[data-testid="extension-view-frame"]');
}

test("G3 read: two windows same session and real card source opens", async () => {
  test.setTimeout(90_000);
  const root = process.env.PAO_BOARD_PRIVATE_ROOT!;
  const evidence = process.env.PI_GUI_PROOF_DIR!;
  if (!root || !evidence) throw new Error("需要已验profile及独立证据目录");
  await mkdir(evidence, { recursive: true });
  const state = JSON.parse(await readFile(join(root, "profile", "ui-state.json"), "utf8"));
  let harness: DesktopHarness | undefined;
  try {
    harness = await launchDesktop(join(root, "profile"), {
      agentDir: join(root, "agent"),
      initialWorkspaces: [state.selectedWorkspaceId],
      scrubProviderEnv: true,
      envOverrides: {
        PI_APP_TEST_MODE: undefined,
        PAO_CODING_AGENT_DIR: join(root, "agent"),
        PAO_SESSION_BUDGET: '{"turns":0}',
      },
    });
    await harness.focusWindow();
    const first = await harness.firstWindow();
    const doctor = await harness.electronApp.evaluate(({ app, BrowserWindow }) => ({
      pid: process.pid,
      userData: app.getPath("userData"),
      visible: BrowserWindow.getAllWindows()[0]?.isVisible(),
      testMode: process.env.PI_APP_TEST_MODE ?? null,
      testHooks: "__PI_APP_TEST_HOOKS" in globalThis,
    }));
    expect(doctor).toMatchObject({ visible: true, testMode: null, testHooks: false });
    await writeFile(join(evidence, "doctor.json"), JSON.stringify(doctor, null, 2));
    const original = await first.locator(".session-row--active").getAttribute("data-session-id");
    const frame = await openView(first, "PAO 工作看板");
    await frame.getByRole("button", { name: "任务", exact: true }).click();
    await expect(frame.locator("main")).toContainText("隔离展示样本，不代表真实工作流");
    await frame.getByRole("button", { name: "打开卡正本", exact: true }).first().click();
    await expect(first.getByTestId("file-workbench-preview")).toContainText("此为UI展示fixture");
    await first.screenshot({ path: join(evidence, "真实卡原文可达.png") });
    const opened = harness.electronApp.waitForEvent("window");
    // 复用上游multi-window测试的真实快捷键路径，不调用创建窗口IPC或测试hook。
    await harness.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getFocusedWindow()?.webContents.sendInputEvent({
        type: "keyDown",
        keyCode: "n",
        modifiers: [process.platform === "darwin" ? "meta" : "control", "shift"],
      }),
    );
    const second = await opened;
    await expect(second.getByTestId("composer")).toBeVisible();
    await expect(second.locator(".session-row--active")).toHaveAttribute(
      "data-session-id",
      original!,
    );
    const secondFrame = await openView(second, "PAO 工作看板");
    await expect(secondFrame.locator("main")).toContainText(original!);
    await second.screenshot({ path: join(evidence, "第二窗口同会话.png") });
    await writeFile(
      join(evidence, "result.json"),
      JSON.stringify(
        {
          passed: [
            "实际卡正本在文件面板可读",
            "真实快捷键第二窗口打开同一会话",
            "第二窗口看板会话身份正确",
          ],
          boundary: "仅读取和打开，不证明并发写控制或活任务退出",
        },
        null,
        2,
      ),
    );
  } finally {
    await harness?.close();
  }
});

test("G3 new-build gate: closing real window cancels pending template confirmation", async () => {
  if (process.env.PAO_G3_NEW_BUILD_CONFIRMED !== "1")
    throw new Error(
      "待主代理统一构建后显式设置PAO_G3_NEW_BUILD_CONFIRMED=1；不以旧dist验证新控制边界",
    );
  test.setTimeout(90_000);
  const root = process.env.PAO_BOARD_PRIVATE_ROOT!;
  const evidence = process.env.PI_GUI_PROOF_DIR!;
  await mkdir(evidence, { recursive: true });
  const state = JSON.parse(await readFile(join(root, "profile", "ui-state.json"), "utf8"));
  const name = `G3确认取消-${Date.now()}`;
  const destination = join(process.env.PAO_HOME!, "工作流", `${name}.md`);
  let harness: DesktopHarness | undefined;
  try {
    harness = await launchDesktop(join(root, "profile"), {
      agentDir: join(root, "agent"),
      initialWorkspaces: [state.selectedWorkspaceId],
      scrubProviderEnv: true,
      envOverrides: {
        PI_APP_TEST_MODE: undefined,
        PAO_CODING_AGENT_DIR: join(root, "agent"),
        PAO_SESSION_BUDGET: '{"turns":0}',
      },
    });
    const page = await harness.firstWindow();
    await harness.focusWindow();
    const doctor = await harness.electronApp.evaluate(({ BrowserWindow }) => ({
      pid: process.pid,
      visible: BrowserWindow.getAllWindows()[0]?.isVisible(),
      testMode: process.env.PI_APP_TEST_MODE ?? null,
      testHooks: "__PI_APP_TEST_HOOKS" in globalThis,
    }));
    expect(doctor).toMatchObject({ visible: true, testMode: null, testHooks: false });
    await writeFile(join(evidence, "doctor.json"), JSON.stringify(doctor, null, 2));
    const original = await page.locator(".session-row--active").getAttribute("data-session-id");
    const frame = await openView(page, "PAO 工作流");
    await frame.getByPlaceholder("可选另存名称").first().fill(name);
    await frame.getByRole("button", { name: "查看差异并安装", exact: true }).first().click();
    await expect
      .poll(
        async () =>
          (await page.getByTestId("extension-dialog").count()) > 0 ||
          (await frame.locator("main").innerText()).includes("残留会话锁"),
      )
      .toBe(true);
    if ((await frame.locator("main").innerText()).includes("残留会话锁")) {
      const token = (await frame.locator("main").innerText()).match(
        /原控制标识[：:]\s*([a-f0-9-]+)/,
      )?.[1];
      if (!token) throw new Error("没有可核对的残锁身份，拒绝猜测接管");
      const composer = page.getByTestId("composer");
      const draft = await composer.inputValue();
      await composer.fill(`/pao runtime takeover ${token}`);
      await composer.press("Enter");
      await expect(page.getByText("本会话控制权有效", { exact: false })).toBeVisible();
      await composer.fill(draft);
      await frame.getByRole("button", { name: "刷新状态", exact: true }).click();
      await frame.getByPlaceholder("可选另存名称").first().fill(name);
      await frame.getByRole("button", { name: "查看差异并安装", exact: true }).first().click();
    }
    await expect(page.getByTestId("extension-dialog")).toBeVisible();
    await expect(page.getByTestId("extension-dialog")).toContainText(name);
    await page.screenshot({ path: join(evidence, "真实模板确认等待中.png") });
    // 模态遮罩禁止底层切会话。使用真实可达的窗口关闭，不force绕过遮罩。
    await page.close();
    await expect
      .poll(
        () => {
          try {
            process.kill(doctor.pid, 0);
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 10_000 },
      )
      .toBe(false);
    await expect
      .poll(async () => {
        try {
          await readFile(destination);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      })
      .toBe(false);
    await writeFile(
      join(evidence, "确认中断结果.json"),
      JSON.stringify(
        {
          name,
          original,
          mainPid: doctor.pid,
          mainExited: true,
          created: false,
          boundary:
            "真实确认期间关闭窗口，进程退出后核模板未写；模态遮罩阻止底层切会话，不冒称已验证后端切会话竞态",
        },
        null,
        2,
      ),
    );
  } finally {
    await harness?.close();
  }
});

test("G3 reopen: cancelled unique template stays absent after restart", async () => {
  const root = process.env.PAO_BOARD_PRIVATE_ROOT!;
  const evidence = process.env.PI_GUI_PROOF_DIR!;
  const previous = process.env.PAO_G3_CONFIRM_RESULT!;
  if (!previous) throw new Error("需要唯一目标关窗成功的确认中断结果.json");
  const result = JSON.parse(await readFile(previous, "utf8"));
  expect(result).toMatchObject({ mainExited: true, created: false });
  await mkdir(evidence, { recursive: true });
  const state = JSON.parse(await readFile(join(root, "profile", "ui-state.json"), "utf8"));
  const harness = await launchDesktop(join(root, "profile"), {
    agentDir: join(root, "agent"),
    initialWorkspaces: [state.selectedWorkspaceId],
    scrubProviderEnv: true,
    envOverrides: {
      PI_APP_TEST_MODE: undefined,
      PAO_CODING_AGENT_DIR: join(root, "agent"),
      PAO_SESSION_BUDGET: '{"turns":0}',
    },
  });
  const pid = await harness.electronApp.evaluate(() => process.pid);
  try {
    const page = await harness.firstWindow();
    await expect(page.getByTestId("composer")).toBeVisible();
    await expect(
      readFile(join(process.env.PAO_HOME!, "工作流", `${result.name}.md`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await page.screenshot({ path: join(evidence, "重开后原会话可见.png") });
  } finally {
    await harness.close();
  }
  await expect
    .poll(
      () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 10000 },
    )
    .toBe(false);
  await writeFile(
    join(evidence, "重开结果.json"),
    JSON.stringify(
      {
        name: result.name,
        oldMain: result.mainPid,
        newMain: pid,
        exited: true,
        absentAfterRestart: true,
      },
      null,
      2,
    ),
  );
});
