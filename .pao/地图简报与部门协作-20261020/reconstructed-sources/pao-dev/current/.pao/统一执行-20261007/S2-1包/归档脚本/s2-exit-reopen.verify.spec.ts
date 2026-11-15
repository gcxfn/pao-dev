import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchDesktop, makeUserDataDir } from "../helpers/electron-app";

/**
 * S2-1包 一次性真实验证（S2 验收「真实隔离 Electron 保存/退出重开坐标不丢」，零模型）：
 * 拖动坐标＋依赖边真实保存 → 退出 app → 重开 → 坐标/连线/配方内容一致。
 * 隔离 PAO_HOME 与 userDataDir；不发任何模型请求。
 * 截图直接落 S2-1包/证据/退出重开-<时间戳>/。
 */

test("退出重开后坐标与连线一致（真机收证）", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const evidenceDir = join(
    "D:/AI/workspace/pao-dev/.pao/统一执行-20261007/S2-1包/证据",
    `退出重开-${Date.now()}`,
  );
  await mkdir(evidenceDir, { recursive: true });
  const log: string[] = [];
  const say = (line: string) => {
    log.push(`[${new Date().toISOString()}] ${line}`);
    console.log(line);
  };

  const paoHome = await mkdtemp(join(tmpdir(), "s2-reopen-home-"));
  const workspaceDir = await mkdtemp(join(tmpdir(), "s2-reopen-workspace-"));
  const profile = await makeUserDataDir("s2-reopen-profile-");
  await mkdir(join(paoHome, "工作流"), { recursive: true });
  const recipePath = join(paoHome, "工作流", "退出重开验证.md");
  await writeFile(
    recipePath,
    `---\n${JSON.stringify({
      版本: 2,
      名字: "退出重开验证",
      自动执行: false,
      参数: [],
      节点: [
        { 名字: "开发", 部门: "工程", 目标: "实现", 验收: "检查", depends_on: [] },
        { 名字: "审查", 部门: "评审", 目标: "复核", 验收: "检查", depends_on: ["开发"] },
      ],
      ui: { positions: { 开发: { x: 40, y: 90 }, 审查: { x: 380, y: 90 } } },
    })}\n---\n隔离收证配方\n`,
  );
  const options = {
    testMode: "background" as const,
    scrubProviderEnv: true,
    initialWorkspaces: [workspaceDir],
    envOverrides: { PAO_DISABLE_BUILTIN_EXTENSION: "0", PAO_HOME: paoHome },
  };

  say(`隔离 PAO_HOME=${paoHome}`);
  say(`隔离 userDataDir=${profile}`);

  let harness = await launchDesktop(profile, options);
  let movedTransform = "";
  try {
    const page = await harness.firstWindow();
    await page.getByTestId("sidebar-canvas").click();
    await page.getByTestId("canvas-recipe-row").filter({ hasText: "退出重开验证" }).click();
    await page.getByTestId("canvas-open-master-session").click();
    await expect(page.getByTestId("canvas-open-master-session")).toContainText("主控会话已建立");
    say("配方已加载，主控会话已建立（本地，零模型请求）");

    const graph = page.getByTestId("workflow-editor");
    const developer = graph.locator('.react-flow__node[data-id="开发"]');
    const before = await developer.boundingBox();
    if (!before) throw new Error("开发节点没有可见坐标");
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width / 2 + 70, before.y + before.height / 2 + 60, {
      steps: 10,
    });
    await page.mouse.up();
    const movedTransformNow = await developer.evaluate(
      (element) => (element as HTMLElement).style.transform,
    );
    movedTransform = movedTransformNow;
    say(`拖动后 transform=${movedTransform}`);
    await page.screenshot({ path: join(evidenceDir, "1-拖动后未保存.png") });

    await page
      .getByTestId("recipe-canvas-editor")
      .getByRole("button", { name: "保存", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .filter({ hasText: "保存工作流配方" })
      .getByRole("button", { name: /Confirm|确认/ })
      .click();
    await expect(page.getByTestId("recipe-canvas-editor")).toContainText("已保存");
    say("保存完成（内核 confirm 弹窗确认）");
    await page.screenshot({ path: join(evidenceDir, "2-保存确认后.png") });

    const diskAfterSave = await readFile(recipePath, "utf8");
    say(`保存后磁盘含 ui 坐标行=${diskAfterSave.includes("ui: ")}；含依赖边=${diskAfterSave.includes('depends_on: ["开发"]')}`);
  } finally {
    await harness.close();
  }
  say("应用已退出（真实进程结束）");

  harness = await launchDesktop(profile, options);
  try {
    const reopened = await harness.firstWindow();
    await reopened.getByTestId("sidebar-canvas").click();
    await reopened.getByTestId("canvas-recipe-row").filter({ hasText: "退出重开验证" }).click();
    const reopenedGraph = reopened.getByTestId("workflow-editor");
    const reopenedNode = reopenedGraph.locator('.react-flow__node[data-id="开发"]');
    await expect
      .poll(() => reopenedNode.evaluate((element) => (element as HTMLElement).style.transform))
      .toBe(movedTransform);
    say("重开后坐标与保存前一致");
    await expect(reopenedGraph.locator(".react-flow__edge")).toHaveCount(1);
    say("重开后依赖边（开发 → 审查）仍在");
    const disk = await readFile(recipePath, "utf8");
    const uiLine = disk.split("\n").find((line) => line.startsWith("ui: "));
    if (!uiLine) throw new Error("重开后的配方文件缺少画布坐标");
    const savedUi = JSON.parse(uiLine.slice(4)) as {
      positions: Record<string, { x: number; y: number }>;
    };
    expect(savedUi.positions.开发).not.toEqual({ x: 40, y: 90 });
    expect(savedUi.positions.审查).toEqual({ x: 380, y: 90 });
    expect(disk).toContain('depends_on: ["开发"]');
    say("磁盘配方内容一致：拖动坐标已持久化、依赖边完整");
    await reopened.screenshot({ path: join(evidenceDir, "3-重开后坐标与连线.png") });
  } finally {
    const page = harness.electronApp.windows().find((window) => !window.isClosed());
    const discard = page
      ?.getByTestId("recipe-canvas-editor")
      .getByRole("button", { name: "放弃修改" });
    if (discard && (await discard.isVisible()) && (await discard.isEnabled()))
      await discard.click();
    await harness.close();
  }
  say("收证完成：保存 → 退出 → 重开 → 坐标/连线/配方内容一致");

  await writeFile(join(evidenceDir, "验证日志.txt"), log.join("\n") + "\n", "utf8");
  expect(testInfo.status).toBe("passed");
});
