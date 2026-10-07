import { readFileSync, writeFileSync } from "node:fs";
const src = "D:/AI/workspace/pao-dev/桌面端/apps/desktop/tests/core/kanban-board.spec.ts";
let t = readFileSync(src, "utf8");
const must = (needle, label) => {
  if (!t.includes(needle)) throw new Error("锚点不匹配: " + label);
};

// 顶部说明补一句覆盖范围（同一文件内）。
const docAnchor = ` * 以及 KanbanPage 的「任务卡 / 部门与待处理」两个入口同源（失败卡的部门可定位待处理项）。`;
must(docAnchor, "文档说明");
t = t.replace(
  docAnchor,
  docAnchor +
    `
 * 并断言活性桥在无真实 worker 登记时显式提示「无活性信号」，进行中/失败卡只在详情生成主控指令
 * （取消/终止，textarea 可复制、不改卡状态），已交付不提供入口。`,
);

// A：已交付详情仍打开时，断言两个入口都不出现。
const shotAnchor = `    await page.screenshot({ path: test.info().outputPath("看板详情.png") });`;
must(shotAnchor, "详情截图");
t = t.replace(
  shotAnchor,
  shotAnchor +
    `

    // 已交付是终态：详情不提供取消/终止入口（指令也只生成不含执行）。
    await expect(detail.getByTestId("kanban-prepare-cancel")).toHaveCount(0);
    await expect(detail.getByTestId("kanban-prepare-terminate")).toHaveCount(0);`,
);

// C：丙卡详情已关，插入进行中/失败指令与无信号断言。
const closeAnchor = `    // 关详情后改卡文件再刷新：甲卡从待认领换到进行中，不是本地改状态。
    await detail.getByTestId("kanban-detail-close").click();
    await expect(page.getByTestId("kanban-detail")).toHaveCount(0);`;
must(closeAnchor, "关详情块");
t = t.replace(
  closeAnchor,
  closeAnchor +
    `

    // 进行中卡：夹具里没有任何真实 worker 登记，活性桥必须显式说「无活性信号」，
    // 不拿卡的创建/更新时间冒充正常；这里不注入模拟活性。
    const liveCard = () =>
      columnOf("进行中").getByTestId("kanban-card").filter({ hasText: "乙卡进行中" });
    await expect(liveCard().getByTestId("kanban-activity-unknown")).toContainText("无活性信号");
    await liveCard().click();
    const liveDetail = page.getByTestId("kanban-detail");
    await expect(liveDetail).toBeVisible();
    await expect(liveDetail.getByTestId("kanban-detail-activity-none")).toContainText("无活性信号");

    // 进行中：详情只生成可复制的主控指令，点按钮不改卡、不发请求。
    await liveDetail.getByTestId("kanban-prepare-cancel").click();
    const command = liveDetail.getByTestId("kanban-command");
    await expect(command).toBeVisible();
    const cancelCommand = await command.inputValue();
    expect(cancelCommand).toContain("pao_改状态");
    expect(cancelCommand).toContain('"新状态":"取消"');
    expect(cancelCommand).toContain("卡0002");
    expect(cancelCommand).toContain(projectA);
    await liveDetail.getByTestId("kanban-prepare-terminate").click();
    const terminateCommand = await command.inputValue();
    expect(terminateCommand).toContain("pao_终止卡");
    expect(terminateCommand).toContain("pao_盘点");
    expect(terminateCommand).toContain("卡0002");
    await liveDetail.getByTestId("kanban-detail-close").click();
    await expect(page.getByTestId("kanban-detail")).toHaveCount(0);

    // 失败不是终态（可重试/取消）：详情有取消，没有终止。
    const failedCard = () =>
      columnOf("失败").getByTestId("kanban-card").filter({ hasText: "丁卡失败" });
    await failedCard().click();
    const failedDetail = page.getByTestId("kanban-detail");
    await expect(failedDetail.getByTestId("kanban-prepare-cancel")).toBeVisible();
    await expect(failedDetail.getByTestId("kanban-prepare-terminate")).toHaveCount(0);
    await failedDetail.getByTestId("kanban-prepare-cancel").click();
    const failedCommand = await failedDetail.getByTestId("kanban-command").inputValue();
    expect(failedCommand).toContain("pao_改状态");
    expect(failedCommand).toContain('"新状态":"取消"');
    expect(failedCommand).toContain("卡0004");
    await failedDetail.getByTestId("kanban-detail-close").click();
    await expect(page.getByTestId("kanban-detail")).toHaveCount(0);

    // 生成指令不改状态：刷新重读盘上卡面，乙/丁仍在原列原状态。
    await page.getByTestId("kanban-refresh").click();
    await expect(liveCard()).toHaveAttribute("data-status", "进行中");
    await expect(failedCard()).toHaveAttribute("data-status", "失败");
    await expect(columnOf("待认领").getByTestId("kanban-card")).toHaveCount(2);
    await expect(page.getByTestId("kanban-card")).toHaveCount(6);`,
);
writeFileSync(src, t);
console.log("ok: core spec 断言已加");