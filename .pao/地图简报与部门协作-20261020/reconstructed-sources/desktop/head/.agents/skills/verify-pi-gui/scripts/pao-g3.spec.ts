import { test, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  launchDesktop,
  type DesktopHarness,
} from "../../../../apps/desktop/tests/helpers/electron-app";
import { expectExtensionViewReady } from "../../../../apps/desktop/tests/helpers/desktop-extension-fixture";

// 真实 Electron/SDK/确认框；既有模型对话仅作为可打开会话，不发送任何模型请求。
// 工作流状态和卡片属于明确fixture，绝不计为G3-09/10真实模型工作流。
test("G3 visible UI: duplicate confirmation cancel, workflow preview and restart", async () => {
  test.setTimeout(120_000);
  const evidence = process.env.PI_GUI_PROOF_DIR!;
  const privateRoot = process.env.PAO_BOARD_PRIVATE_ROOT!;
  if (!evidence || !privateRoot) throw new Error("需要独立证据目录和已验桌面profile");
  const profile = join(privateRoot, "profile");
  const previous = JSON.parse(await readFile(join(profile, "ui-state.json"), "utf8"));
  const workspace = previous.selectedWorkspaceId;
  const checkpoints: string[] = [];
  let harness: DesktopHarness | undefined;
  await mkdir(evidence, { recursive: true });
  const launch = async () => {
    harness = await launchDesktop(profile, {
      agentDir: join(privateRoot, "agent"),
      initialWorkspaces: [workspace],
      scrubProviderEnv: true,
      envOverrides: {
        PI_APP_TEST_MODE: undefined,
        PAO_CODING_AGENT_DIR: join(privateRoot, "agent"),
        PAO_RUNTIME_SURFACE: "desktop",
        PAO_SESSION_BUDGET: '{"turns":0}',
      },
    });
    await harness.focusWindow();
    const page = await harness.firstWindow();
    const doctor = await harness.electronApp.evaluate(({ app, BrowserWindow }) => ({
      pid: process.pid,
      appPath: app.getAppPath(),
      userData: app.getPath("userData"),
      visible: BrowserWindow.getAllWindows()[0]?.isVisible(),
      testMode: process.env.PI_APP_TEST_MODE ?? null,
      testHooks: "__PI_APP_TEST_HOOKS" in globalThis,
    }));
    expect(doctor).toMatchObject({ visible: true, testMode: null, testHooks: false });
    expect(resolve(doctor.appPath)).toBe(resolve("apps/desktop"));
    expect(resolve(doctor.userData)).toBe(resolve(profile));
    await writeFile(
      join(evidence, `doctor-${checkpoints.length}.json`),
      JSON.stringify(doctor, null, 2),
    );
    return page;
  };
  try {
    let page = await launch();
    await harness!.electronApp
      .context()
      .tracing.start({ screenshots: true, snapshots: true, sources: true });
    await expect(page.getByTestId("composer")).toBeVisible();
    if (!(await page.getByTestId("workbench").isVisible()))
      await page.getByTestId("toggle-side-panel").click();
    if (!(await page.getByTestId("workbench-chooser").isVisible()))
      await page.getByTestId("workbench-add-tab").click();
    await page
      .getByTestId("workbench-chooser")
      .getByRole("button", { name: "PAO 工作流", exact: true })
      .click();
    await expectExtensionViewReady(page);
    const frame = page.frameLocator('[data-testid="extension-view-frame"]');
    await expect(frame.getByRole("heading", { name: "PAO 工作流", exact: true })).toBeVisible();
    await frame.getByRole("button", { name: "查看差异并安装", exact: true }).first().dblclick();
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
      checkpoints.push("残锁阻断写入且原标识显式接管");
      await frame.getByRole("button", { name: "刷新状态", exact: true }).click();
      await expect(frame.getByRole("button", { name: "刷新状态", exact: true })).toBeEnabled();
      await frame.getByRole("button", { name: "查看差异并安装", exact: true }).first().dblclick();
    }
    await expect(page.getByTestId("extension-dialog")).toHaveCount(1);
    await expect(page.getByTestId("extension-dialog")).toContainText("安装工作流模板");
    await expect(
      frame.getByRole("button", { name: "查看差异并安装", exact: true }).first(),
    ).toBeDisabled();
    await page.screenshot({ path: join(evidence, "重复点击只有一次确认.png") });
    await page.getByTestId("extension-dialog-cancel").click();
    await expect(page.getByTestId("extension-dialog")).toHaveCount(0);
    await expect(frame.locator("main")).toContainText("未确认安装模板");
    checkpoints.push("真实确认框重复点击只一份且取消明确失败");
    await frame.getByRole("button", { name: "刷新状态", exact: true }).click();
    await expect(frame.getByRole("button", { name: "刷新状态", exact: true })).toBeEnabled();
    await page.screenshot({ path: join(evidence, "四区画布.png") });
    await writeFile(join(evidence, "画布.aria.txt"), await frame.locator("main").ariaSnapshot());
    checkpoints.push("取消后显式刷新状态可恢复读取");
    await frame.getByRole("button", { name: "只读预检／诚实预览", exact: true }).click();
    await expect(frame.locator("main")).toContainText("待部长拆解，尚无法估算");
    await expect(frame.locator("main")).toContainText('"canStart": false');
    await page.screenshot({ path: join(evidence, "参数缺失只读预检.png") });
    checkpoints.push("真实参数预检缺输入拒绝且卡数未知不编造");
    await page.getByRole("button", { name: "Reload view", exact: true }).click();
    await expectExtensionViewReady(page);
    await expect(frame.getByRole("heading", { name: "PAO 工作流", exact: true })).toBeVisible();
    await expect(frame.getByRole("button", { name: "刷新状态", exact: true })).toBeEnabled();
    checkpoints.push("重载视图重新连接现实状态");
    const currentId = await page.locator(".session-row--active").getAttribute("data-session-id");
    const otherIds = await page
      .locator(".session-row[data-session-id]")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-session-id")));
    const otherId = otherIds.find((id) => id && id !== currentId);
    if (!otherId) throw new Error("既有双会话fixture缺第二会话，不能声称切换验收");
    await page.locator(`.session-row[data-session-id="${otherId}"] .session-row__select`).click();
    await expect(page.locator(".session-row--active")).toHaveAttribute("data-session-id", otherId);
    await expect(page.getByTestId("composer")).toHaveValue("Unsent draft for Alpha");
    await page.locator(`.session-row[data-session-id="${currentId}"] .session-row__select`).click();
    await expect(page.locator(".session-row--active")).toHaveAttribute(
      "data-session-id",
      currentId!,
    );
    await expect(page.getByTestId("composer")).toHaveValue("Unsent draft for Bravo");
    checkpoints.push("真实双会话切换草稿保持隔离");
    await harness!.electronApp.context().tracing.stop({ path: join(evidence, "g3.zip") });
    const oldPid = harness!.electronApp.process().pid;
    await harness!.close();
    harness = undefined;
    expect(() => process.kill(oldPid!, 0)).toThrow();
    checkpoints.push("正常关窗退出主进程");
    page = await launch();
    await expect(page.getByTestId("composer")).toBeVisible();
    await page.screenshot({ path: join(evidence, "重启恢复.png") });
    checkpoints.push("同profile重启composer可见（未断言历史内容）");
    await writeFile(
      join(evidence, "result.json"),
      JSON.stringify(
        {
          checkpoints,
          boundary: "真实无test hooks桌面；未发送聊天或调用模型；不代表完整G3或真实工作流通过",
        },
        null,
        2,
      ),
    );
  } finally {
    await harness?.close();
  }
});
