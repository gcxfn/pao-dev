/** 隔离配方夹具上的真实 Electron 编辑操作；不调用模型，不代表真实启动验收。 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { launchDesktop, makeUserDataDir, makeWorkspace } from "../helpers/electron-app";

async function launchWorkflowFixture(enableKernel = false) {
  const home = await makeWorkspace("workflow-home");
  const project = await makeWorkspace("workflow-project");
  await mkdir(join(home, "工作流"), { recursive: true });
  const recipe = {
    版本: 2,
    名字: "编辑验证",
    自动执行: false,
    参数: [],
    节点: [
      { 名字: "开发", 部门: "工程", 目标: "实现", 验收: "检查", depends_on: [] },
      { 名字: "审查", 部门: "评审", 目标: "复核", 验收: "检查", depends_on: ["开发"] },
    ],
    ui: { positions: { 开发: { x: 40, y: 90 }, 审查: { x: 380, y: 90 } } },
  };
  await writeFile(
    join(home, "工作流", "编辑验证.md"),
    `---\n${JSON.stringify(recipe)}\n---\n隔离测试配方\n`,
  );
  const app = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [project],
    testMode: "background",
    scrubProviderEnv: true,
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: enableKernel ? "0" : "1" },
  });
  return { app, home };
}

test("配方点击加载、拖动产生修改、放弃还原", async () => {
  const { app } = await launchWorkflowFixture();
  try {
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-canvas").click();
    await page.getByTestId("canvas-recipe-row").filter({ hasText: "编辑验证" }).click();
    const editor = page.getByTestId("recipe-canvas-editor");
    await expect(editor.getByTestId("workflow-node")).toHaveCount(2);
    const node = editor.getByTestId("workflow-node").filter({ hasText: "开发" });
    await node.click();
    await expect(editor).toContainText("已选择 开发");
    const before = await node.boundingBox();
    if (!before) throw new Error("画布节点没有可见坐标");
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width / 2 + 100, before.y + before.height / 2 + 70, {
      steps: 8,
    });
    await page.mouse.up();
    await expect(editor).toContainText("未保存");
    await expect(editor.getByRole("button", { name: "保存", exact: true })).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath("画布拖动.png") });
    await editor.getByRole("button", { name: "放弃修改" }).click();
    await expect(editor).toContainText("已保存");
    await expect(editor.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
    await node.click();
    const inspector = page.getByTestId("workflow-inspector");
    await expect(inspector.getByLabel("任务目标")).toHaveValue("实现");
    await inspector.getByLabel("任务目标").fill("修改后的任务");
    await inspector.getByLabel("交付后等待人工确认").check();
    await expect(node).toContainText("需要人工确认");
    await editor.getByRole("button", { name: "放弃修改" }).click();
    await expect(inspector.getByLabel("任务目标")).toHaveValue("实现");
    await expect(inspector.getByLabel("交付后等待人工确认")).not.toBeChecked();
    await editor.getByRole("button", { name: "添加部门任务" }).click();
    await expect(editor.getByTestId("workflow-node")).toHaveCount(3);
    await expect(inspector).toContainText("任务1");
    await inspector.getByRole("button", { name: "删除节点" }).click();
    await expect(editor.getByTestId("workflow-node")).toHaveCount(2);
    await node.click();
    await inspector.getByRole("button", { name: "删除节点" }).click();
    await expect(editor.getByTestId("workflow-node")).toHaveCount(1);
    await expect(editor.locator(".react-flow__edge")).toHaveCount(0);
    await editor.getByRole("button", { name: "放弃修改" }).click();
    await expect(editor.getByTestId("workflow-node")).toHaveCount(2);
    await expect(editor.locator(".react-flow__edge")).toHaveCount(1);
    await page.screenshot({ path: test.info().outputPath("属性与节点操作.png") });
    await node.click();
    await inspector.getByLabel("任务目标").fill("尚未保存");
    await page.getByTestId("canvas-start-workflow").click();
    const dialog = page.getByRole("dialog", { name: "未保存修改", exact: true });
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(inspector.getByLabel("任务目标")).toHaveValue("尚未保存");
    await expect(page.getByTestId("workflow-wizard")).toHaveCount(0);
    await page.getByTestId("canvas-start-workflow").click();
    await dialog.getByRole("button", { name: "保存并继续" }).click();
    await expect(editor).toContainText("请先在项目中建立主控会话");
    await expect(editor).toContainText("未保存");
    await expect(page.getByTestId("workflow-wizard")).toHaveCount(0);
    await page.getByTestId("canvas-start-workflow").click();
    await dialog.getByRole("button", { name: "放弃并继续" }).click();
    await expect(page.getByTestId("workflow-wizard")).toBeVisible();
  } finally {
    await app.close();
  }
});

test("导航、关闭窗口和退出程序均保留取消后的画布", async () => {
  const { app } = await launchWorkflowFixture();
  try {
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-canvas").click();
    await page.getByTestId("canvas-recipe-row").filter({ hasText: "编辑验证" }).click();
    await page.getByTestId("workflow-node").filter({ hasText: "开发" }).click();
    const goal = page.getByTestId("workflow-inspector").getByLabel("任务目标");
    await goal.fill("需要保留的草稿");
    const dialog = page.getByRole("dialog", { name: "未保存修改", exact: true });
    await page.getByTestId("sidebar-workboard").click();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(goal).toHaveValue("需要保留的草稿");
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(goal).toHaveValue("需要保留的草稿");
    await app.electronApp.evaluate(({ app: electronApp }) => {
      electronApp.quit();
    });
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(goal).toHaveValue("需要保留的草稿");
    await page.getByTestId("sidebar-workboard").click();
    await dialog.getByRole("button", { name: "保存并继续" }).click();
    await expect(page.getByTestId("recipe-canvas-editor")).toContainText(
      "请先在项目中建立主控会话",
    );
    await expect(goal).toHaveValue("需要保留的草稿");
    await page.getByTestId("sidebar-workboard").click();
    await dialog.getByRole("button", { name: "放弃并继续" }).click();
    await expect(page.getByTestId("kanban-view")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("放弃后导航.png") });
  } finally {
    await app.close();
  }
});

test("节点改名：Esc 放弃、回车与失焦提交，重名保留原名", async () => {
  const { app } = await launchWorkflowFixture();
  try {
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-canvas").click();
    await page.getByTestId("canvas-recipe-row").filter({ hasText: "编辑验证" }).click();
    const graph = page.getByTestId("workflow-editor");
    const inspector = page.getByTestId("workflow-inspector");
    const editor = page.getByTestId("recipe-canvas-editor");
    const oldNode = graph.locator('.react-flow__node[data-id="开发"]');
    await oldNode.click();
    const position = await oldNode.evaluate((node) => (node as HTMLElement).style.transform);
    const nameInput = inspector.getByLabel("节点名称");
    // Esc 放弃：输入恢复原名，草稿不变（编辑器仍是已保存）。
    await nameInput.fill("临时名字");
    await nameInput.press("Escape");
    await expect(nameInput).toHaveValue("开发");
    await expect(editor).toContainText("已保存");
    // 回车提交：一次同步名字、坐标与依赖引用。
    await nameInput.fill("实现新版");
    await nameInput.press("Enter");
    await expect
      .poll(() =>
        graph
          .locator('.react-flow__node[data-id="实现新版"]')
          .evaluate((node) => (node as HTMLElement).style.transform),
      )
      .toBe(position);
    await graph.locator(".react-flow__edge-textbg").click();
    await expect(inspector).toContainText("实现新版 → 审查");
    // 失焦提交：改名后点击其他节点即生效。
    await graph.locator('.react-flow__node[data-id="审查"]').click();
    await inspector.getByLabel("节点名称").fill("复核");
    await graph.locator('.react-flow__node[data-id="实现新版"]').click();
    await expect(graph.locator('.react-flow__node[data-id="复核"]')).toBeVisible();
    // 重名保留原名：改成已有节点名，报错且草稿不落。
    await inspector.getByLabel("节点名称").fill("复核");
    await graph.locator('.react-flow__node[data-id="复核"]').click();
    await expect(editor.getByRole("alert")).toContainText("节点名称已存在");
    await expect(graph.locator('.react-flow__node[data-id="实现新版"]')).toBeVisible();
    await editor.getByRole("button", { name: "放弃修改" }).click();
    await expect(oldNode).toBeVisible();
    await expect(graph.locator('.react-flow__node[data-id="实现新版"]')).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("改名交互.png") });
  } finally {
    const page = app.electronApp.windows().find((window) => !window.isClosed());
    const discard = page
      ?.getByTestId("recipe-canvas-editor")
      .getByRole("button", { name: "放弃修改" });
    if (discard && (await discard.isVisible()) && (await discard.isEnabled()))
      await discard.click();
    if (page) await app.close();
  }
});

test("右键复制节点：重名派生、依赖不复制，保存后读回文件", async () => {
  const { app, home } = await launchWorkflowFixture(true);
  try {
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-canvas").click();
    await page.getByTestId("canvas-recipe-row").filter({ hasText: "编辑验证" }).click();
    await page.getByTestId("canvas-open-master-session").click();
    await expect(page.getByTestId("canvas-open-master-session")).toContainText("主控会话已建立");
    const editor = page.getByTestId("recipe-canvas-editor");
    const graph = page.getByTestId("workflow-editor");
    await expect(graph.getByTestId("workflow-node")).toHaveCount(2);
    // 右键节点弹菜单（编辑态）；复制后重名自动派生、副本选中。
    await graph.locator('.react-flow__node[data-id="审查"]').click({ button: "right" });
    const menu = page.getByTestId("canvas-context-menu");
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: "复制节点" }).click();
    await expect(menu).toHaveCount(0);
    await expect(graph.getByTestId("workflow-node")).toHaveCount(3);
    const copyNode = graph.locator('.react-flow__node[data-id="审查副本"]');
    await expect(copyNode).toBeVisible();
    // 菜单改名入口：直达 Inspector 的节点名称输入框。
    await copyNode.click({ button: "right" });
    await menu.getByRole("menuitem", { name: "重命名节点" }).click();
    await expect(page.getByTestId("workflow-inspector").getByLabel("节点名称")).toBeFocused();
    // 保存读回：副本保留部门等字段，依赖不复制（无新增边）。
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    await page
      .getByRole("dialog")
      .filter({ hasText: "保存工作流配方" })
      .getByRole("button", { name: /Confirm|确认/ })
      .click();
    await expect(editor).toContainText("已保存");
    const disk = await readFile(join(home, "工作流", "编辑验证.md"), "utf8");
    expect(disk).toContain('名字: "审查副本"');
    const copyBlock = disk.split('名字: "审查副本"')[1] ?? "";
    expect(copyBlock).toContain("评审"); // 部门等字段保留
    expect(copyBlock).toContain("depends_on: []"); // 依赖不复制
    await page.screenshot({ path: test.info().outputPath("右键复制节点.png") });
  } finally {
    const page = app.electronApp.windows().find((window) => !window.isClosed());
    const discard = page
      ?.getByTestId("recipe-canvas-editor")
      .getByRole("button", { name: "放弃修改" });
    if (discard && (await discard.isVisible()) && (await discard.isEnabled()))
      await discard.click();
    if (page) await app.close();
  }
});

test("连线模式建连与拖拽同判定：非法浮层、Esc 取消、审核回边右键直达 Inspector", async () => {
  // 用例链路长（建任务→拖开→依赖→回环拒绝→审核回边→保存读回），默认 60 秒不够。
  test.setTimeout(150_000);
  const { app, home } = await launchWorkflowFixture(true);
  try {
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-canvas").click();
    await page.getByTestId("canvas-recipe-row").filter({ hasText: "编辑验证" }).click();
    await page.getByTestId("canvas-open-master-session").click();
    await expect(page.getByTestId("canvas-open-master-session")).toContainText("主控会话已建立");
    const editor = page.getByTestId("recipe-canvas-editor");
    const graph = page.getByTestId("workflow-editor");
    const developer = graph.locator('.react-flow__node[data-id="开发"]');
    const reviewer = graph.locator('.react-flow__node[data-id="审查"]');
    const linkToggle = editor.getByTestId("canvas-link-toggle");
    const float = page.getByTestId("canvas-connect-float");
    // 已存在依赖：连线模式下重复连同一依赖，浮层明示而非无响应。
    await linkToggle.click();
    await developer.click();
    await reviewer.click();
    await expect(float).toContainText("已存在依赖");
    // Esc 取消连线模式：按钮回到「连线」，点击节点恢复普通选中。
    await page.keyboard.press("Escape");
    await expect(linkToggle).toHaveText("连线");
    await developer.click();
    await expect(editor).toContainText("已选择 开发");
    // 新节点走右键菜单「连线到…」入口建依赖（与拖拽/工具栏同一判定函数）。
    await editor.getByRole("button", { name: "添加部门任务" }).click();
    await graph.locator(".react-flow__controls-fitview").click();
    await page.getByTestId("workflow-inspector").getByLabel("部门", { exact: true }).fill("工程");
    await page.getByTestId("workflow-inspector").getByLabel("任务目标").fill("新任务目标");
    await page.getByTestId("workflow-inspector").getByLabel("验收要求").fill("新任务验收");
    const task = graph.locator('.react-flow__node[data-id="任务1"]');
    // 新节点默认落点与保存过坐标的「开发」重叠（布局行距按常量推算，节点实际更高），
    // 先把任务1拖开，避免后续点击被遮（既有拖拽交互，非本包新逻辑）。
    const taskBox = await task.boundingBox();
    if (!taskBox) throw new Error("任务1没有可见坐标");
    await page.mouse.move(taskBox.x + taskBox.width / 2, taskBox.y + taskBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(taskBox.x + taskBox.width / 2, taskBox.y + taskBox.height / 2 + 130, {
      steps: 8,
    });
    await page.mouse.up();
    await developer.click({ button: "right" });
    // 临时探针（诊断右键菜单未出现，跑完即删）。
    await page.getByTestId("canvas-context-menu").getByRole("menuitem", { name: "连线到…" }).click();
    await task.click();
    await expect(graph.locator(".react-flow__edge")).toHaveCount(2);
    // 成环拒绝：反向连线在浮层给出原因。
    await linkToggle.click();
    await task.click();
    await developer.click();
    await expect(float).toContainText("该依赖会形成循环");
    await page.keyboard.press("Escape");
    // 审核节点：右键设为审核节点，连线模式建回边，右键回边直达 Inspector。
    await reviewer.click({ button: "right" });
    await page.getByTestId("canvas-context-menu").getByRole("menuitem", { name: "设为审核节点" }).click();
    await reviewer.click();
    await page.getByTestId("workflow-inspector").getByLabel("部门标准", { exact: true }).fill("复核正确性");
    await linkToggle.click();
    await reviewer.click();
    await developer.click();
    await expect(graph.locator(".react-flow__edge")).toHaveCount(3);
    // 建回边后 inspector 停在审核节点面板（与拖拽入口同口径，含回边快捷按钮）；
    // 回边直达 Inspector 由下方右键边「编辑回退设置」验证。
    await graph.locator(".react-flow__edge").last().click({ button: "right" });
    await page.getByTestId("canvas-context-menu").getByRole("menuitem", { name: "编辑回退设置" }).click();
    await expect(page.getByTestId("workflow-inspector").getByLabel("回退上限", { exact: true })).toHaveValue("3");
    // 保存读回：连线模式建的依赖与回边都落盘。
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    await page
      .getByRole("dialog")
      .filter({ hasText: "保存工作流配方" })
      .getByRole("button", { name: /Confirm|确认/ })
      .click();
    await expect(editor).toContainText("已保存");
    const disk = await readFile(join(home, "工作流", "编辑验证.md"), "utf8");
    expect(disk).toContain('depends_on: ["开发"]');
    expect(disk).toContain('"目标":"开发"');
    expect(disk).toContain('"上限":3');
    await page.screenshot({ path: test.info().outputPath("连线模式建连.png") });
  } finally {
    const page = app.electronApp.windows().find((window) => !window.isClosed());
    const discard = page
      ?.getByTestId("recipe-canvas-editor")
      .getByRole("button", { name: "放弃修改" });
    if (discard && (await discard.isVisible()) && (await discard.isEnabled()))
      await discard.click();
    if (page) await app.close();
  }
});

test("拖动和连线保存后刷新保持相同图", async () => {
  const { app, home } = await launchWorkflowFixture(true);
  try {
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-canvas").click();
    await page.getByTestId("canvas-recipe-row").filter({ hasText: "编辑验证" }).click();
    await page.getByTestId("recipe-library-filter-mine").click();
    await expect(page.getByTestId("canvas-recipe-row")).toHaveCount(1);
    await page.getByTestId("recipe-library-filter-templates").click();
    await expect(page.getByTestId("recipe-library-template-hint")).toBeVisible();
    await expect(page.getByTestId("canvas-recipe-row")).toHaveCount(0);
    await page.getByTestId("recipe-library-filter-recent").click();
    await expect(page.getByTestId("canvas-list")).toContainText("编辑验证");
    await page.getByTestId("recipe-library-filter-all").click();
    await page.getByTestId("canvas-open-master-session").click();
    await expect(page.getByTestId("canvas-open-master-session")).toContainText("主控会话已建立");
    const graph = page.getByTestId("workflow-editor");
    const developer = graph.locator('.react-flow__node[data-id="开发"]');
    const reviewer = graph.locator('.react-flow__node[data-id="审查"]');
    const before = await developer.boundingBox();
    if (!before) throw new Error("开发节点没有可见坐标");
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width / 2 + 40, before.y + before.height / 2 + 60, {
      steps: 8,
    });
    await page.mouse.up();
    const movedTransform = await developer.evaluate(
      (element) => (element as HTMLElement).style.transform,
    );
    await graph.locator(".react-flow__edge-textbg").click();
    await page.getByTestId("workflow-inspector").getByRole("button", { name: "删除连线" }).click();
    await expect(graph.locator(".react-flow__edge")).toHaveCount(0);
    // 主控面板占用高度后，拖动的节点可能离开当前视口；通过真实 Fit 操作重新取景。
    await graph.locator(".react-flow__controls-fitview").click();
    // 删线后右栏切回工作流信息，等待分栏与节点完成布局后再取连接点。
    await graph.evaluate(async (element) => {
      let previous = "";
      let stable = 0;
      for (let frame = 0; frame < 120; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const current = JSON.stringify(
          [...element.querySelectorAll(".react-flow__handle")].map((handle) => {
            const box = handle.getBoundingClientRect();
            return [box.x, box.y, box.width, box.height];
          }),
        );
        stable = current === previous ? stable + 1 : 0;
        if (stable >= 3) return;
        previous = current;
      }
      throw new Error("连线前画布布局未稳定");
    });
    const source = await developer.locator(".react-flow__handle-right").boundingBox();
    const target = await reviewer.locator(".react-flow__handle-left").boundingBox();
    if (!source || !target) throw new Error("依赖连接点不可见");
    expect(
      await page.evaluate(
        ({ x, y }) => ({
          hit: document.elementFromPoint(x, y)?.outerHTML,
          x,
          y,
          source: document.elementFromPoint(x, y)?.classList.contains("source"),
        }),
        { x: source.x + source.width / 2, y: source.y + source.height / 2 },
      ),
    ).toMatchObject({ source: true });
    expect(
      await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.classList.contains("target"),
        { x: target.x + target.width / 2, y: target.y + target.height / 2 },
      ),
    ).toBe(true);
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(graph.locator(".react-flow__edge")).toHaveCount(1);
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
    await expect
      .poll(() => developer.evaluate((element) => (element as HTMLElement).style.transform))
      .toBe(movedTransform);
    const disk = await readFile(join(home, "工作流", "编辑验证.md"), "utf8");
    const uiLine = disk.split("\n").find((line) => line.startsWith("ui: "));
    if (!uiLine) throw new Error("保存文件缺少画布坐标");
    const savedUi = JSON.parse(uiLine.slice(4)) as {
      positions: Record<string, { x: number; y: number }>;
    };
    expect(savedUi.positions.开发).not.toEqual({ x: 40, y: 90 });
    expect(savedUi.positions.审查).toEqual({ x: 380, y: 90 });
    await page.getByTestId("canvas-refresh").click();
    await expect
      .poll(() => developer.evaluate((element) => (element as HTMLElement).style.transform))
      .toBe(movedTransform);
    await expect(graph.locator(".react-flow__edge")).toHaveCount(1);
    await page.screenshot({ path: test.info().outputPath("保存刷新后的坐标和依赖.png") });
  } finally {
    const page = app.electronApp.windows().find((window) => !window.isClosed());
    const discard = page
      ?.getByTestId("recipe-canvas-editor")
      .getByRole("button", { name: "放弃修改" });
    if (discard && (await discard.isVisible()) && (await discard.isEnabled()))
      await discard.click();
    if (page) await app.close();
  }
});

test("审核节点回边可以添加、编辑并真实保存", async () => {
  const { app, home } = await launchWorkflowFixture(true);
  try {
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-canvas").click();
    await page.getByTestId("canvas-recipe-row").filter({ hasText: "编辑验证" }).click();
    await page.getByTestId("canvas-open-master-session").click();
    await expect(page.getByTestId("canvas-open-master-session")).toContainText("已建立");
    const graph = page.getByTestId("workflow-editor");
    await graph.locator(".react-flow__controls-fitview").click();
    await graph.getByTestId("workflow-node").filter({ hasText: "审查" }).click();
    await page.getByTestId("workflow-inspector").getByLabel("审核节点", { exact: true }).check();
    await page
      .getByTestId("workflow-inspector")
      .getByLabel("部门标准", { exact: true })
      .fill("复核正确性与运行证据");
    const source = graph.locator('.react-flow__node[data-id="审查"] .source');
    const target = graph.locator('.react-flow__node[data-id="开发"] .target');
    await source.dragTo(target);
    await expect(graph.locator(".react-flow__edge")).toHaveCount(2);
    await page
      .getByTestId("workflow-inspector")
      .getByRole("button", { name: /开发.*3/ })
      .click();
    await page.getByLabel("回退上限", { exact: true }).fill("2");
    await page.getByLabel("超限动作", { exact: true }).selectOption("修完这轮放行");
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
    const disk = await readFile(join(home, "工作流", "编辑验证.md"), "utf8");
    expect(disk).toContain('"上限":2');
    expect(disk).toContain('"超限动作":"修完这轮放行"');
    expect(disk).toContain("复核正确性与运行证据");
    await page.getByRole("button", { name: "折叠工作流库", exact: true }).click();
    await expect(page.getByTestId("canvas-list")).toHaveCount(0);
    await page.getByRole("button", { name: "展开工作流库", exact: true }).click();
    await expect(page.getByTestId("canvas-list")).toBeVisible();
  } finally {
    const page = app.electronApp.windows().find((window) => !window.isClosed());
    const discard = page
      ?.getByTestId("recipe-canvas-editor")
      .getByRole("button", { name: "放弃修改" });
    if (discard && (await discard.isVisible()) && (await discard.isEnabled()))
      await discard.click();
    await app.close();
  }
});

test("配方建立独立主控后真实保存并读回文件", async () => {
  const { app, home } = await launchWorkflowFixture(true);
  try {
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-canvas").click();
    await page.getByTestId("canvas-recipe-row").filter({ hasText: "编辑验证" }).click();
    await page.getByTestId("canvas-open-master-session").click();
    await expect(page.getByTestId("canvas-open-master-session")).toContainText("主控会话已建立");
    await page.getByTestId("workflow-node").filter({ hasText: "开发" }).click();
    await page.getByTestId("workflow-inspector").getByLabel("任务目标").fill("真实保存验证");
    await page
      .getByTestId("recipe-canvas-editor")
      .getByRole("button", { name: "保存", exact: true })
      .click();
    await expect(page.getByRole("dialog").filter({ hasText: "保存工作流配方" })).toBeVisible();
    await page
      .getByRole("dialog")
      .filter({ hasText: "保存工作流配方" })
      .getByRole("button", { name: /Confirm|确认/ })
      .click();
    await expect(page.getByTestId("recipe-canvas-editor")).toContainText("已保存");
    expect(await readFile(join(home, "工作流", "编辑验证.md"), "utf8")).toContain("真实保存验证");
    await page.getByTestId("recipe-canvas-editor").getByLabel("另存为名称").fill("另存验证");
    await page
      .getByTestId("recipe-canvas-editor")
      .getByRole("button", { name: "另存为", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .filter({ hasText: "保存工作流配方" })
      .getByRole("button", { name: /Confirm|确认/ })
      .click();
    await expect(page.getByTestId("recipe-canvas-editor")).toContainText("另存验证 · 已保存");
    expect(await readFile(join(home, "工作流", "另存验证.md"), "utf8")).toContain("真实保存验证");
    await page.getByRole("button", { name: "新建工作流", exact: true }).click();
    await page.getByTestId("workflow-inspector").getByLabel("工作流名称").fill("新建验证");
    // 主控会话按标签页绑定（S4-1 唯一性契约）：新配方落新标签不继承旧标签主控
    // （同一会话不得绑两个标签），新标签需要时各自「建立主控会话」。
    await page.getByTestId("canvas-open-master-session").click();
    await expect(page.getByTestId("canvas-open-master-session")).toContainText("主控会话已建立");
    await expect(page.getByTestId("canvas-open-master-session")).toBeDisabled();
    await page
      .getByTestId("recipe-canvas-editor")
      .getByRole("button", { name: "添加部门任务" })
      .click();
    // 隔离现场没有部门目录，先保存时应显示真实校验错误，不能伪造成功。
    await page
      .getByTestId("recipe-canvas-editor")
      .getByRole("button", { name: "保存", exact: true })
      .click();
    await expect(page.getByTestId("recipe-canvas-editor").getByRole("alert")).toContainText("部门");
    // 保存校验失败＝零落盘：同名配方文件不得被写出。
    await expect(readFile(join(home, "工作流", "新建验证.md"), "utf8")).rejects.toThrow();
    // 失败路径也不得留下写入残留（.bak-时间戳 备份只在 flow save 实际写盘时产生）。
    const leftOver = (await readdir(join(home, "工作流"))).filter((file) =>
      file.startsWith("新建验证.md"),
    );
    expect(leftOver).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("新建校验错误.png") });
    await expect(
      page.getByTestId("workflow-inspector").getByLabel("部门", { exact: true }),
    ).toBeEnabled();
    await page.getByTestId("workflow-inspector").getByLabel("部门", { exact: true }).fill("工程");
    await page.getByTestId("workflow-inspector").getByLabel("任务目标").fill("新建目标");
    await page.getByTestId("workflow-inspector").getByLabel("验收要求").fill("新建验收");
    await page
      .getByTestId("recipe-canvas-editor")
      .getByRole("button", { name: "保存", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .filter({ hasText: "保存工作流配方" })
      .getByRole("button", { name: /Confirm|确认/ })
      .click();
    await expect(page.getByTestId("recipe-canvas-editor")).toContainText("新建验证 · 已保存");
    expect(await readFile(join(home, "工作流", "新建验证.md"), "utf8")).toContain("新建目标");
    await page.screenshot({ path: test.info().outputPath("另存与新建校验.png") });
  } finally {
    const page = app.electronApp.windows().find((window) => !window.isClosed());
    const discard = page
      ?.getByTestId("recipe-canvas-editor")
      .getByRole("button", { name: "放弃修改" });
    if (discard && (await discard.isVisible()) && (await discard.isEnabled()))
      await discard.click();
    if (page) await app.close();
  }
});

test("两标签交替修改不串：A 修改保存、B 新建保存互不串写", async () => {
  const { app, home } = await launchWorkflowFixture(true);
  try {
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-canvas").click();
    await page.getByTestId("canvas-recipe-row").filter({ hasText: "编辑验证" }).click();
    await page.getByTestId("canvas-open-master-session").click();
    await expect(page.getByTestId("canvas-open-master-session")).toContainText("主控会话已建立");
    // A：改节点字段留下未保存修改。
    await page.getByTestId("workflow-node").filter({ hasText: "开发" }).click();
    await page.getByTestId("workflow-inspector").getByLabel("任务目标").fill("A的目标");
    await expect(page.getByTestId("recipe-canvas-editor")).toContainText("未保存");
    // 带 A 未保存修改新建 B：必须先过三选，选「保存并继续」把 A 落盘。
    await page.getByRole("button", { name: "新建工作流", exact: true }).click();
    const guard = page.getByRole("dialog", { name: "未保存修改", exact: true });
    await guard.getByRole("button", { name: "保存并继续" }).click();
    const saveA = page.getByRole("dialog").filter({ hasText: "保存工作流配方" });
    await expect(saveA).toBeVisible();
    await saveA.getByRole("button", { name: /Confirm|确认/ }).click();
    expect(await readFile(join(home, "工作流", "编辑验证.md"), "utf8")).toContain("A的目标");
    // B：未落盘骨架立即出现配方名称输入框（T09 症状点）。
    await expect(page.getByTestId("workflow-inspector").getByLabel("工作流名称")).toBeVisible();
    // B 骨架未动过也算未保存：切走必须三选；放弃后骨架仍归 B 标签持有（切回仍在）。
    await page
      .getByTestId("workflow-tabs")
      .getByRole("button", { name: "编辑验证", exact: true })
      .click();
    const guardB = page.getByRole("dialog", { name: "未保存修改", exact: true });
    await guardB.getByRole("button", { name: "放弃并继续" }).click();
    await expect(page.getByTestId("recipe-canvas-editor")).toContainText("编辑验证 · 已保存");
    await page
      .getByTestId("workflow-tabs")
      .getByRole("button", { name: "新工作流1", exact: true })
      .click();
    await expect(
      page.getByTestId("workflow-inspector").getByLabel("工作流名称"),
    ).toBeVisible();
    await page.getByTestId("workflow-inspector").getByLabel("工作流名称").fill("B独立配方");
    // S4-1 唯一性：新标签各自建立主控（同一会话不得绑两个标签），B 保存链需要本标签身份。
    await page.getByTestId("canvas-open-master-session").click();
    await expect(page.getByTestId("canvas-open-master-session")).toContainText("主控会话已建立");
    await expect(page.getByTestId("canvas-open-master-session")).toBeDisabled();
    await page
      .getByTestId("recipe-canvas-editor")
      .getByRole("button", { name: "添加部门任务" })
      .click();
    await page.getByTestId("workflow-inspector").getByLabel("部门", { exact: true }).fill("工程");
    await page.getByTestId("workflow-inspector").getByLabel("任务目标").fill("B的目标");
    await page.getByTestId("workflow-inspector").getByLabel("验收要求").fill("B的验收");
    await page
      .getByTestId("recipe-canvas-editor")
      .getByRole("button", { name: "保存", exact: true })
      .click();
    const saveB = page.getByRole("dialog").filter({ hasText: "保存工作流配方" });
    await expect(saveB).toBeVisible();
    await saveB.getByRole("button", { name: /Confirm|确认/ }).click();
    await expect(page.getByTestId("recipe-canvas-editor")).toContainText("B独立配方 · 已保存");
    // B 保存落 B 文件，不落 A 文件。
    expect(await readFile(join(home, "工作流", "B独立配方.md"), "utf8")).toContain("B的目标");
    expect(await readFile(join(home, "工作流", "编辑验证.md"), "utf8")).not.toContain("B的目标");
    // 切回 A：A 的已保存内容仍在（不被 B 覆盖或丢失）。
    await page
      .getByTestId("workflow-tabs")
      .getByRole("button", { name: "编辑验证", exact: true })
      .click();
    await expect(page.getByTestId("recipe-canvas-editor")).toContainText("编辑验证 · 已保存");
    await page.getByTestId("workflow-node").filter({ hasText: "开发" }).click();
    await expect(page.getByTestId("workflow-inspector").getByLabel("任务目标")).toHaveValue(
      "A的目标",
    );
    // 再切回 B：B 的已保存内容仍在（两标签交替第二轮）。
    await page
      .getByTestId("workflow-tabs")
      .getByRole("button", { name: "B独立配方", exact: true })
      .click();
    await expect(page.getByTestId("recipe-canvas-editor")).toContainText("B独立配方 · 已保存");
    await page.screenshot({ path: test.info().outputPath("两标签交替.png") });
  } finally {
    await app.close();
  }
});

test("守卫保存并继续×骨架改名：标签保留新名，无死标签与误导横幅", async () => {
  // S3 对抗审核 P3-1：骨架改名后经守卫「保存并继续」，pendingAction 若用旧闭包标签表
  // 整表覆写（后到者胜），改名丢失→标签指旧名成死标签＋「尚未保存或已被移除」横幅。
  const { app, home } = await launchWorkflowFixture(true);
  try {
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-canvas").click();
    await page.getByTestId("canvas-recipe-row").filter({ hasText: "编辑验证" }).click();
    await page.getByTestId("canvas-open-master-session").click();
    await expect(page.getByTestId("canvas-open-master-session")).toContainText("主控会话已建立");
    // 骨架标签：名称输入框改名＋可保存的任务节点（部门/目标/验收，同 :508 新建链口径）。
    await page.getByRole("button", { name: "新建工作流", exact: true }).click();
    await expect(page.getByTestId("workflow-tabs")).toContainText("新工作流1");
    await page.getByTestId("workflow-inspector").getByLabel("工作流名称").fill("改名验证");
    await page
      .getByTestId("recipe-canvas-editor")
      .getByRole("button", { name: "添加部门任务" })
      .click();
    await page.getByTestId("workflow-inspector").getByLabel("部门", { exact: true }).fill("工程");
    await page.getByTestId("workflow-inspector").getByLabel("任务目标").fill("改名目标");
    await page.getByTestId("workflow-inspector").getByLabel("验收要求").fill("改名验收");
    // S4-1 唯一性：骨架新标签无主控；「保存并继续」的保存链需要本标签身份，先建立。
    await page.getByTestId("canvas-open-master-session").click();
    await expect(page.getByTestId("canvas-open-master-session")).toContainText("主控会话已建立");
    // 切换型 pendingAction（点另一标签）触发未保存守卫，选「保存并继续」。
    await page
      .getByTestId("workflow-tabs")
      .getByRole("button", { name: "编辑验证", exact: true })
      .click();
    const guard = page.getByRole("dialog", { name: "未保存修改", exact: true });
    await guard.getByRole("button", { name: "保存并继续" }).click();
    const saveConfirm = page.getByRole("dialog").filter({ hasText: "保存工作流配方" });
    await expect(saveConfirm).toBeVisible();
    await saveConfirm.getByRole("button", { name: /Confirm|确认/ }).click();
    // 配方以新名真实落盘（保存链本身成功）。
    expect(await readFile(join(home, "工作流", "改名验证.md"), "utf8")).toContain("改名目标");
    // 标签表一致：改名保留、旧名死标签不出现、无错误横幅。
    const tabs = page.getByTestId("workflow-tabs");
    await expect(tabs).toContainText("改名验证");
    await expect(tabs).not.toContainText("新工作流1");
    await expect(page.getByTestId("canvas-load-error")).toHaveCount(0);
    // 切回改名标签：读回已保存配方，不出现「尚未保存或已被移除」误导横幅。
    await tabs.getByRole("button", { name: "改名验证", exact: true }).click();
    await expect(page.getByTestId("recipe-canvas-editor")).toContainText("改名验证 · 已保存");
    await expect(
      page.getByRole("alert").filter({ hasText: "尚未保存或已被移除" }),
    ).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("守卫保存并继续改名.png") });
  } finally {
    const page = app.electronApp.windows().find((window) => !window.isClosed());
    if (page) await app.close();
  }
});

test("保存后退出程序重开：坐标与连线一致，配方内容一致", async () => {
  // 同一隔离 PAO_HOME 与 userDataDir 跨两次真实启动（workflow-tabs 重启恢复同模式）。
  const home = await makeWorkspace("workflow-reopen-home");
  const project = await makeWorkspace("workflow-reopen-project");
  const profile = await makeUserDataDir();
  await mkdir(join(home, "工作流"), { recursive: true });
  const options = {
    initialWorkspaces: [project],
    testMode: "background" as const,
    scrubProviderEnv: true,
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: "0" },
  };
  const recipePath = join(home, "工作流", "编辑验证.md");
  await writeFile(
    recipePath,
    `---\n${JSON.stringify({
      版本: 2,
      名字: "编辑验证",
      自动执行: false,
      参数: [],
      节点: [
        { 名字: "开发", 部门: "工程", 目标: "实现", 验收: "检查", depends_on: [] },
        { 名字: "审查", 部门: "评审", 目标: "复核", 验收: "检查", depends_on: ["开发"] },
      ],
      ui: { positions: { 开发: { x: 40, y: 90 }, 审查: { x: 380, y: 90 } } },
    })}\n---\n隔离测试配方\n`,
  );
  let app = await launchDesktop(profile, options);
  try {
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-canvas").click();
    await page.getByTestId("canvas-recipe-row").filter({ hasText: "编辑验证" }).click();
    await page.getByTestId("canvas-open-master-session").click();
    await expect(page.getByTestId("canvas-open-master-session")).toContainText("主控会话已建立");
    const graph = page.getByTestId("workflow-editor");
    const developer = graph.locator('.react-flow__node[data-id="开发"]');
    const before = await developer.boundingBox();
    if (!before) throw new Error("开发节点没有可见坐标");
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width / 2 + 60, before.y + before.height / 2 + 50, {
      steps: 8,
    });
    await page.mouse.up();
    const movedTransform = await developer.evaluate(
      (element) => (element as HTMLElement).style.transform,
    );
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
    await app.close();

    app = await launchDesktop(profile, options);
    const reopened = await app.firstWindow();
    // S4-2 入口契约：重启恢复绑定标签后，点 sidebar 工作流进入单工作流嵌入视图，
    // 配方随标签自动读回；嵌入视图不渲染工作流库，直接断言画布坐标与连线。
    await reopened.getByTestId("sidebar-canvas").click();
    const reopenedGraph = reopened.getByTestId("workflow-editor");
    const reopenedNode = reopenedGraph.locator('.react-flow__node[data-id="开发"]');
    await expect
      .poll(() => reopenedNode.evaluate((element) => (element as HTMLElement).style.transform))
      .toBe(movedTransform);
    // 连线：夹具既有依赖边（开发 → 审查）在重开后仍在画布上。
    await expect(reopenedGraph.locator(".react-flow__edge")).toHaveCount(1);
    // 节点名字集合与保存前一致（重开后两个节点仍在，名字未变）。
    await expect(reopenedGraph.locator(".react-flow__node")).toHaveCount(2);
    await expect(reopenedGraph.locator('.react-flow__node[data-id="开发"]')).toHaveCount(1);
    await expect(reopenedGraph.locator('.react-flow__node[data-id="审查"]')).toHaveCount(1);
    // 配方内容一致：磁盘上坐标已更新、依赖边仍在。
    const disk = await readFile(recipePath, "utf8");
    const uiLine = disk.split("\n").find((line) => line.startsWith("ui: "));
    if (!uiLine) throw new Error("重开后的配方文件缺少画布坐标");
    const savedUi = JSON.parse(uiLine.slice(4)) as {
      positions: Record<string, { x: number; y: number }>;
    };
    expect(savedUi.positions.开发).not.toEqual({ x: 40, y: 90 });
    expect(savedUi.positions.审查).toEqual({ x: 380, y: 90 });
    expect(disk).toContain('depends_on: ["开发"]');
    await reopened.screenshot({ path: test.info().outputPath("退出重开后坐标与连线.png") });
  } finally {
    const page = app.electronApp.windows().find((window) => !window.isClosed());
    const discard = page
      ?.getByTestId("recipe-canvas-editor")
      .getByRole("button", { name: "放弃修改" });
    if (discard && (await discard.isVisible()) && (await discard.isEnabled()))
      await discard.click();
    if (page) await app.close();
  }
});

/** S3-3 删除链夹具：内核构建产物写冻结实例（startControl，改「已完成」避开运行中守卫）
 * ＋同名 .bak 备份；不连 provider、不派发 worker、不调用模型。 */
const DELETE_FIXTURE_SCRIPT = `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [kernelDist, paoHome, project, workspaceDir, cardsDir] = process.argv.slice(2);
const load = (relative) => import(pathToFileURL(join(kernelDist, relative)).href);
const { parseRecipe } = await load("workflow/recipe.js");
const { startControl } = await load("workflow/control.js");
const { formatProjectList } = await load("dept/projects.js");
mkdirSync(join(paoHome, "工作流"), { recursive: true });
mkdirSync(cardsDir, { recursive: true });
writeFileSync(
  join(paoHome, "项目清单.md"),
  formatProjectList([
    { 项目名: "删除验证项目", 项目根: project, 首次服务: "2026-10-07 09:00", 最近服务: "2026-10-07 09:00" },
  ]),
);
const recipePath = join(paoHome, "工作流", "删除验证.md");
writeFileSync(
  recipePath,
  "---\\n" +
    JSON.stringify({
      版本: 2,
      名字: "删除验证",
      自动执行: false,
      参数: [],
      节点: [
        { 名字: "冻结甲", 部门: "工程", 目标: "实现冻结甲", 验收: "文件存在", depends_on: [] },
        { 名字: "冻结乙", 部门: "评审", 目标: "复核冻结甲", 验收: "意见归档", depends_on: ["冻结甲"] },
      ],
      ui: { positions: { 冻结甲: { x: 40, y: 120 }, 冻结乙: { x: 420, y: 120 } } },
    }) +
    "\\n---\\n删除验证配方。\\n",
);
const recipe = parseRecipe(readFileSync(recipePath, "utf8"), recipePath);
await startControl(recipe, {}, { cardsDir, workspaceDir, ownerSessionId: "fixture-owner" });
const manifest = join(workspaceDir, "工作流实例-删除验证.md");
writeFileSync(manifest, readFileSync(manifest, "utf8").replace("状态: 运行中", "状态: 已完成"));
process.stdout.write("fixture-ok\\n");
`;

async function fileExists(path: string): Promise<boolean> {
  const { stat } = await import("node:fs/promises");
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

test("删除工作流：确认弹窗含 .bak 说明，取消无副作用、标签不变", async () => {
  const { app, home } = await launchWorkflowFixture(true);
  try {
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-canvas").click();
    const row = page.getByTestId("canvas-recipe-row").filter({ hasText: "编辑验证" });
    await row.click();
    await expect(page.getByTestId("workflow-tabs")).toContainText("编辑验证");
    await page.getByTestId("canvas-open-master-session").click();
    await expect(page.getByTestId("canvas-open-master-session")).toContainText("已建立");
    await row.click({ button: "right" });
    await page
      .getByTestId("recipe-row-context-menu")
      .getByRole("menuitem", { name: "删除工作流" })
      .click();
    const dialog = page.getByRole("dialog").filter({ hasText: "删除工作流配方" });
    // 计划要求：确认说明必须包含「.bak 备份与冻结运行记录不受影响」。
    await expect(dialog).toContainText(".bak 备份与冻结运行记录不受影响");
    await dialog.getByTestId("extension-dialog-cancel").click();
    // 取消＝内核如实回错，无任何磁盘与标签副作用。
    await expect(page.getByTestId("canvas-load-error")).toContainText("未确认删除");
    await expect(row).toBeVisible();
    await expect(page.getByTestId("workflow-tabs")).toContainText("编辑验证");
    await expect(page.getByTestId("recipe-canvas-editor")).toBeVisible();
    const recipePath = join(home, "工作流", "编辑验证.md");
    const disk = await readFile(recipePath, "utf8");
    expect(disk).toContain("编辑验证");
    await page.screenshot({ path: test.info().outputPath("删除取消后无副作用.png") });
  } finally {
    const page = app.electronApp.windows().find((window) => !window.isClosed());
    const discard = page
      ?.getByTestId("recipe-canvas-editor")
      .getByRole("button", { name: "放弃修改" });
    if (discard && (await discard.isVisible()) && (await discard.isEnabled()))
      await discard.click();
    if (page) await app.close();
  }
});

test("删除工作流：确认后 .bak 保留、冻结实例可读、对应标签关闭", async () => {
  const home = await makeWorkspace("workflow-delete-home");
  const project = await makeWorkspace("workflow-delete-project");
  const workspaceDir = join(project, ".pao", "删除任务");
  const cardsDir = join(workspaceDir, "卡");
  const kernelDist = join(
    __dirname,
    "../../node_modules/@earendil-works/pi-coding-agent/dist/pao",
  );
  const fixtureScript = join(home, "make-delete-fixture.mjs");
  await writeFile(fixtureScript, DELETE_FIXTURE_SCRIPT, "utf8");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)(process.execPath, [
    fixtureScript,
    kernelDist,
    home,
    project,
    workspaceDir,
    cardsDir,
  ], { windowsHide: true });
  const recipePath = join(home, "工作流", "删除验证.md");
  const bakPath = `${recipePath}.bak-20261007-000000`;
  await writeFile(bakPath, await readFile(recipePath, "utf8"), "utf8");
  const app = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [project],
    testMode: "background",
    scrubProviderEnv: true,
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: "0" },
  });
  try {
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-canvas").click();
    const row = page.getByTestId("canvas-recipe-row").filter({ hasText: "删除验证" });
    await row.click();
    await expect(page.getByTestId("workflow-tabs")).toContainText("删除验证");
    await page.getByTestId("canvas-open-master-session").click();
    await expect(page.getByTestId("canvas-open-master-session")).toContainText("已建立");
    await row.click({ button: "right" });
    await page
      .getByTestId("recipe-row-context-menu")
      .getByRole("menuitem", { name: "删除工作流" })
      .click();
    await page
      .getByRole("dialog")
      .filter({ hasText: "删除工作流配方" })
      .getByRole("button", { name: /Confirm|确认/ })
      .click();
    // 成功：对应标签关闭、配方行消失、目录刷新。
    await expect(page.getByTestId("workflow-tabs")).not.toContainText("删除验证");
    await expect(
      page.getByTestId("canvas-recipe-row").filter({ hasText: "删除验证" }),
    ).toHaveCount(0);
    await expect.poll(async () => !(await fileExists(recipePath))).toBe(true);
    // 语义钉住：.bak 备份与冻结运行记录不受影响。
    expect(await fileExists(bakPath)).toBe(true);
    const instanceRow = page.getByTestId("canvas-instance-row").filter({ hasText: "删除验证" });
    await expect(instanceRow).toBeVisible();
    await instanceRow.click();
    const graph = page.getByTestId("workflow-editor");
    await expect(graph.locator(".react-flow__node")).toHaveCount(2);
    await expect(graph.locator(".react-flow__node").filter({ hasText: "冻结甲" })).toHaveCount(1);
    await page.screenshot({ path: test.info().outputPath("删除后冻结实例可读.png") });
  } finally {
    const page = app.electronApp.windows().find((window) => !window.isClosed());
    if (page) await app.close();
  }
});

test("删除不被未保存骨架挡：任一标签主控即可，直达删除确认框（S12 故障②）", async () => {
  const { app } = await launchWorkflowFixture(true);
  try {
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-canvas").click();
    const row = page.getByTestId("canvas-recipe-row").filter({ hasText: "编辑验证" });
    await row.click();
    await expect(page.getByTestId("workflow-tabs")).toContainText("编辑验证");
    await page.getByTestId("canvas-open-master-session").click();
    await expect(page.getByTestId("canvas-open-master-session")).toContainText("已建立");
    // 新建工作流：活动标签切到未保存骨架（故障②现场：活动标签无主控＋骨架存不了盘）。
    await page.getByRole("button", { name: "新建工作流", exact: true }).click();
    await expect(page.getByTestId("workflow-inspector").getByLabel("工作流名称")).toBeVisible();
    // 右键删除：不出现离开守卫，直达内核删除确认（会话取任一标签绑定的主控）。
    await row.click({ button: "right" });
    await page
      .getByTestId("recipe-row-context-menu")
      .getByRole("menuitem", { name: "删除工作流" })
      .click();
    const dialog = page.getByRole("dialog").filter({ hasText: "删除工作流配方" });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await dialog.getByTestId("extension-dialog-cancel").click();
    await expect(page.getByTestId("canvas-load-error")).toContainText("未确认删除");
    // 取消删除：配方标签还在，骨架标签与骨架内容不受影响。
    await expect(page.getByTestId("workflow-tabs")).toContainText("编辑验证");
    await expect(page.getByTestId("workflow-inspector").getByLabel("工作流名称")).toBeVisible();
  } finally {
    const page = app.electronApp.windows().find((window) => !window.isClosed());
    if (page) await app.close();
  }
});

test("删除不被画布未保存修改挡：直达删除确认框（S12 故障②）", async () => {
  const { app } = await launchWorkflowFixture(true);
  try {
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-canvas").click();
    const row = page.getByTestId("canvas-recipe-row").filter({ hasText: "编辑验证" });
    await row.click();
    await page.getByTestId("canvas-open-master-session").click();
    await expect(page.getByTestId("canvas-open-master-session")).toContainText("已建立");
    await page.getByTestId("workflow-node").filter({ hasText: "开发" }).click();
    await page.getByTestId("workflow-inspector").getByLabel("任务目标").fill("未保存修改");
    await expect(page.getByTestId("recipe-canvas-editor")).toContainText("未保存");
    await row.click({ button: "right" });
    await page
      .getByTestId("recipe-row-context-menu")
      .getByRole("menuitem", { name: "删除工作流" })
      .click();
    const dialog = page.getByRole("dialog").filter({ hasText: "删除工作流配方" });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await dialog.getByTestId("extension-dialog-cancel").click();
    await expect(page.getByTestId("canvas-load-error")).toContainText("未确认删除");
  } finally {
    const page = app.electronApp.windows().find((window) => !window.isClosed());
    if (page) await app.close();
  }
});

test("无主控时删除自动建主控：右键即删，无需手动前置（S12 故障③续）", async () => {
  const { app, home } = await launchWorkflowFixture(true);
  try {
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-canvas").click();
    const row = page.getByTestId("canvas-recipe-row").filter({ hasText: "编辑验证" });
    await row.click();
    // 不建主控（刚开应用的现场：标签绑定是内存态，重启即失）。
    await expect(page.getByTestId("canvas-open-master-session")).toContainText("建立主控会话");
    // 新建工作流把活动标签切到骨架，制造「一个主控都没有＋骨架在前面」的双重现场。
    await page.getByRole("button", { name: "新建工作流", exact: true }).click();
    await expect(page.getByTestId("workflow-inspector").getByLabel("工作流名称")).toBeVisible();
    await row.click({ button: "right" });
    await page
      .getByTestId("recipe-row-context-menu")
      .getByRole("menuitem", { name: "删除工作流" })
      .click();
    // 自动建主控后直达删除确认框。
    const dialog = page.getByRole("dialog").filter({ hasText: "删除工作流配方" });
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole("button", { name: /Confirm|确认/ }).click();
    // 确认后真删除：配方行消失、磁盘文件移除、骨架标签不受影响。
    await expect(row).toHaveCount(0, { timeout: 15_000 });
    await expect(async () => {
      const names = await readdir(join(home, "工作流"));
      expect(names).not.toContain("编辑验证.md");
    }).toPass();
    await expect(page.getByTestId("workflow-inspector").getByLabel("工作流名称")).toBeVisible();
  } finally {
    const page = app.electronApp.windows().find((window) => !window.isClosed());
    if (page) await app.close();
  }
});
