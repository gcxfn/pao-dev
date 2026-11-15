import { expect, test } from "@playwright/test";
import type { KanbanCard, KanbanWorkflow } from "../../contracts/kanban";
import {
  buildDepartmentGroups,
  departmentState,
  ministerSessionInput,
  sessionContentText,
} from "../../src/features/workboard/department-board-model";
import { expectWorkboardSessionInput } from "../../electron/ipc/request-validation";
import { createWorkboardSessionQuery } from "../../electron/platform/pao/workboard-session-query";

const card = (number: number, status: KanbanCard["status"] = "in_progress"): KanbanCard => ({
  path: `D:/项目/.pao/卡/卡${String(number).padStart(4, "0")}-任务.md`,
  project: "D:/项目",
  number,
  goal: "执行任务",
  department: "研发部",
  owner: "owner",
  status,
  acceptance: "通过检查",
  inputs: [],
  dependencies: [],
  priority: "medium",
  attempts: 1,
  created: "2026-10-18 10:00",
  body: "",
  receipts: [],
  executions: [],
});
const flow: KanbanWorkflow = {
  path: "D:/项目/.pao/工作流实例-a.md",
  project: "D:/项目",
  instance: "instance",
  workflow: "任务",
  ownerSessionId: "owner",
  status: "运行中",
  nodes: [
    {
      name: "review",
      round: 1,
      cardsDir: "D:/项目/.pao/卡",
      cardRefs: ["卡0001"],
      historicalCardRefs: ["卡0002"],
      department: "研发部",
      ministerSessionId: "minister",
      status: "in_progress",
      hold: "等待人工确认",
    },
    {
      name: "next",
      round: 1,
      cardsDir: "D:/项目/.pao/卡",
      cardRefs: [],
      department: "研发部",
      status: "no_card",
      hold: "等待前置节点",
    },
  ],
};

test("同部门不同步骤分开，人工门不因工人已交付而冒充部门完成", () => {
  const groups = buildDepartmentGroups([card(1, "delivered")], [flow]);
  expect(groups).toHaveLength(2);
  expect(groups.map((group) => group.state)).toEqual(["blocked", "ready"]);
  expect(groups[0]?.workers[0]?.status).toBe("delivered");
  expect(groups[0]?.workers[0]?.executionId).toBeUndefined();
  expect(ministerSessionInput(groups[0]!, "workspace")).toMatchObject({
    kind: "minister",
    instanceId: "instance",
    nodeName: "review",
    round: 1,
  });
});

test("失败、未知、缺卡不伪装完成；取消有独立终态；历史轮次不混入当前工人", () => {
  expect(departmentState([card(1, "failed")])).toBe("blocked");
  expect(departmentState([card(1, "canceled")])).toBe("canceled");
  expect(departmentState([card(1, "delivered")])).toBe("done");
  expect(departmentState([], { ...flow.nodes[0]!, status: "future-state", hold: undefined })).toBe(
    "blocked",
  );
  expect(buildDepartmentGroups([], [flow])[0]?.reason).toContain("缺失");
  const worker = {
    ...card(1),
    executions: [
      { 执行标识: "old", 尝试: 0, 当前尝试: false },
      { 执行标识: "current", 尝试: 1, 当前尝试: true },
    ],
  };
  const groups = buildDepartmentGroups([worker, card(2, "delivered")], [flow]);
  expect(groups).toHaveLength(2);
  expect(groups[0]?.workers.map((row) => row.executionId)).toEqual(["current"]);
});

test("共享卡目录中的独立任务不能被吞，同实例标识在不同项目分别定位", () => {
  const groups = buildDepartmentGroups([card(1), card(3)], [flow]);
  expect(groups).toHaveLength(3);
  const other = { ...flow, path: "D:/另一个项目/.pao/工作流实例-a.md", project: "D:/另一个项目" };
  const combined = buildDepartmentGroups([], [flow, other]);
  expect(new Set(combined.map((group) => group.id)).size).toBe(4);
  expect(
    departmentState([card(1, "canceled"), card(2)], { ...flow.nodes[0]!, status: "canceled" }),
  ).toBe("blocked");
});

test("会话输入只收执行身份，拒绝坏偏移和旧轮次形状，不允许任意路径", () => {
  expect(
    expectWorkboardSessionInput({
      workspaceId: "w",
      kind: "worker",
      executionId: "exec",
      path: "C:/secret",
    }),
  ).toEqual({ workspaceId: "w", kind: "worker", executionId: "exec", offset: undefined });
  expect(() =>
    expectWorkboardSessionInput({
      workspaceId: "w",
      kind: "minister",
      instanceId: "i",
      nodeName: "s",
      round: 0,
    }),
  ).toThrow();
  expect(() =>
    expectWorkboardSessionInput({
      workspaceId: "w",
      kind: "worker",
      executionId: "exec",
      offset: -1,
    }),
  ).toThrow();
});

test("会话桥保留增量与错误，内容不编造缺失消息", async () => {
  const query = createWorkboardSessionQuery({
    loadReader: async () => ({
      readDesktopExecution: () => ({
        会话路径: "private",
        下次偏移: 20,
        末行未完: true,
        还有更多: true,
        行: [{ 类型: "message", 角色: "assistant", 内容: [{ type: "text", text: "真实记录" }] }],
        本段统计: {},
      }),
      readDesktopWorkflowMinister: () => {
        throw new Error("轮次已变");
      },
    }),
  });
  expect(
    await query.read("project", { kind: "worker", workspaceId: "w", executionId: "e" }),
  ).toMatchObject({ state: "ok", nextOffset: 20, more: true, incomplete: true });
  expect(
    await query.read("project", {
      kind: "minister",
      workspaceId: "w",
      instanceId: "i",
      nodeName: "s",
      round: 1,
    }),
  ).toEqual({ state: "failed", message: "轮次已变" });
  expect(sessionContentText([{ type: "text", text: "第一行\n第二行" }])).toBe("第一行\n第二行");
});
