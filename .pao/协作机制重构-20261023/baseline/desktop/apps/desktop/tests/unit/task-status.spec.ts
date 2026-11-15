import { expect, test } from "@playwright/test";
import type { TimelineToolCall } from "../../contracts/timeline-types";
import type { KanbanWorkflow } from "../../contracts/kanban";
import type { WorkflowControlResult } from "../../contracts/workflow-control";
import {
  acceptsTaskStatusControl,
  beginTaskStatusControl,
  currentDepartmentGroups,
  latestSessionTodos,
  loadTaskStatusControl,
  taskStatusControlForPlan,
  type TaskStatusControlSnapshot,
} from "../../src/features/task-status/task-status-model";
import {
  sidePanelBudget,
  taskStatusCollapseState,
} from "../../src/features/task-status/use-task-status-collapsed";
import { summarizeReview } from "../../src/features/task-status/use-task-status-files";

const todo = (
  input: unknown,
  status: TimelineToolCall["status"] = "success",
  toolName = "TodoWrite",
): TimelineToolCall => ({
  kind: "tool",
  id: "todo",
  callId: "call",
  createdAt: "2026-10-18T10:00:00Z",
  label: toolName,
  toolName,
  status,
  input,
});

test("清单只取最新成功写入，读取、运行中和失败不能顶掉它", () => {
  const previous = todo({ todos: [{ content: "旧任务", status: "pending" }] });
  const latest = todo({ todos: [{ content: "新任务", status: "done" }] });
  expect(latestSessionTodos([previous, latest]).items).toEqual([
    { content: "新任务", status: "completed" },
  ]);
  const result = latestSessionTodos([
    latest,
    todo({}, "success", "TodoRead"),
    todo({}, "error"),
    todo({}, "running"),
  ]);
  expect(result.items).toEqual([{ content: "新任务", status: "completed" }]);
  expect(result.notice).toContain("正在更新");
  expect(latestSessionTodos([latest, todo({ todos: [] })]).items).toEqual([]);
  const invalid = latestSessionTodos([latest, todo({ todos: [{ broken: true }] })]);
  expect(invalid.items).toBeUndefined();
  expect(invalid.notice).toContain("无法读取");
});

test("当前部门严格按项目和主控筛选，不混入同名部门或无归属记录", () => {
  const flow = (project: string, ownerSessionId?: string): KanbanWorkflow => ({
    project,
    path: `${project}/.pao/工作流.md`,
    instance: "instance",
    workflow: "任务",
    status: "运行中",
    ownerSessionId,
    nodes: [
      {
        name: "s1",
        round: 1,
        cardsDir: `${project}/.pao/卡`,
        cardRefs: [],
        department: "研发部",
        status: "no_card",
      },
    ],
  });
  const result = {
    state: "available" as const,
    cards: [],
    issues: [],
    workflows: [flow("D:/项目", "a"), flow("D:/项目", "b"), flow("D:/其他", "a"), flow("D:/项目")],
  };
  const current = currentDepartmentGroups(result, "d:\\项目", "a");
  expect(current).toHaveLength(1);
  expect(current[0]?.ownerSessionId).toBe("a");
  expect(currentDepartmentGroups(result, "D:/项目", undefined)).toEqual([]);
  expect(
    currentDepartmentGroups({ state: "unavailable", message: "读取失败" }, "D:/项目", "a"),
  ).toEqual([]);
});

test("概况偏好区分未设置、显式收起和显式展开，并在临时约束内允许手动展开", () => {
  const state = (
    preference: boolean | undefined,
    overrides: Partial<Parameters<typeof taskStatusCollapseState>[0]> = {},
  ) =>
    taskStatusCollapseState({
      narrow: false,
      availableWidth: 1440,
      toolsOpen: false,
      toolsWidth: 360,
      preference,
      expandedDuringConstraint: false,
      ...overrides,
    });

  expect(state(undefined).collapsed).toBe(false);
  expect(state(true).collapsed).toBe(true);
  expect(state(false).collapsed).toBe(false);
  expect(state(undefined, { narrow: true }).collapsed).toBe(true);
  expect(state(false, { narrow: true, expandedDuringConstraint: true }).collapsed).toBe(false);

  const requiredTogether = sidePanelBudget.overview + sidePanelBudget.minimumMain;
  expect(requiredTogether).toBe(664);
  expect(
    state(undefined, { availableWidth: requiredTogether - 1, toolsOpen: true, toolsWidth: 0 })
      .collapsed,
  ).toBe(true);
  expect(
    state(undefined, {
      availableWidth: requiredTogether + 360,
      toolsOpen: true,
      toolsWidth: 360,
    }).constrained,
  ).toBe(false);
  expect(
    state(false, {
      availableWidth: 1700,
      toolsOpen: true,
      toolsWidth: 935,
    }).collapsed,
  ).toBe(false);
  expect(
    state(false, {
      availableWidth: 1598,
      toolsOpen: true,
      toolsWidth: 935,
    }).collapsed,
  ).toBe(true);
});

test("文件统计透传不可统计文件数和 partial coverage 说明", () => {
  const summary = summarizeReview({
    state: "available",
    reviewId: "review",
    scope: { kind: "uncommitted" },
    checkoutId: "checkout",
    baseLabel: "HEAD",
    headOid: "head",
    baseOid: "base",
    files: [
      {
        id: "a",
        path: "a.ts",
        status: "modified",
        hasStagedChanges: true,
        hasUnstagedChanges: true,
        conflicted: false,
        reviewed: false,
        lines: { added: 3, removed: 2 },
      },
      {
        id: "b",
        path: "image.png",
        status: "untracked",
        hasStagedChanges: false,
        hasUnstagedChanges: true,
        conflicted: false,
        reviewed: false,
        lines: null,
      },
    ],
    coverage: { state: "partial", notes: ["Git 输出已截断"] },
  });
  expect(summary).toMatchObject({
    state: "available",
    files: 2,
    added: 3,
    removed: 2,
    unknownLines: 1,
    coverageNotes: ["Git 输出已截断"],
  });
});

test("同 plan 新启动读取控制期间不沿用旧启动状态，迟到旧结果不能回填", async () => {
  const start = (request: string, instance: string, controlPath: string) => ({
    startRequestId: request,
    instanceId: instance,
    recipeName: instance,
    workspace: "D:/项目",
    cardDir: "D:/项目/.pao/卡",
    controlPath,
    ownerSessionId: "session-a",
    acceptedAt: "2026-10-19T10:00:00Z",
    status: "运行中",
    progress: [],
  });
  const plan = (starts: ReturnType<typeof start>[]) => ({
    planId: "plan-a",
    displayName: "计划",
    definitionVersion: 1,
    undone: false,
    sourceSessionId: "session-a",
    createdAt: "2026-10-19T09:00:00Z",
    updatedAt: "2026-10-19T10:00:00Z",
    steps: [],
    starts,
    feedback: [],
    readProblems: [],
  });
  const control = (
    instanceId: string,
    path: string,
    status: string,
    nodes: { name: string; round: number; requiresConfirmation: boolean; status: string }[],
  ) => ({
    instanceId,
    ownerSessionId: "session-a",
    recipeName: instanceId,
    cardDir: "D:/项目/.pao/卡",
    path,
    status,
    nodes,
  });
  const old = start("request-old", "instance-old", "D:/项目/.pao/old");
  const next = start("request-new", "instance-new", "D:/项目/.pao/new");
  const mismatched = start("request-new-wrong", "instance-new", "D:/项目/.pao/wrong");
  const current = {
    planId: "plan-a",
    start: old,
    generation: 1,
    state: "ready" as const,
    control: control("instance-old", old.controlPath, "已完成", [
      { name: "s1", round: 1, requiresConfirmation: false, status: "delivered" },
    ]),
  };
  const changed = plan([old, next]);
  expect(taskStatusControlForPlan(changed, current)).toMatchObject({
    planId: "plan-a",
    start: next,
    generation: 0,
    state: "loading",
  });

  type ReadResult = WorkflowControlResult;
  let resolveOld!: (value: ReadResult) => void;
  let resolveNext!: (value: ReadResult) => void;
  const oldRead = new Promise<ReadResult>((resolve) => {
    resolveOld = resolve;
  });
  const nextRead = new Promise<ReadResult>((resolve) => {
    resolveNext = resolve;
  });
  let cached: TaskStatusControlSnapshot | undefined;
  const apply = (snapshot: TaskStatusControlSnapshot) => {
    if (acceptsTaskStatusControl(snapshot, cached)) cached = snapshot;
  };
  const begin = (snapshot: TaskStatusControlSnapshot) => {
    cached = snapshot;
  };

  const oldLoad = loadTaskStatusControl(changed.planId, old, {
    read: () => oldRead,
    begin,
    apply,
    isCurrent: () => false,
    generation: 1,
  });
  const nextLoad = loadTaskStatusControl(changed.planId, next, {
    read: () => nextRead,
    begin,
    apply,
    isCurrent: () => true,
    generation: 2,
  });
  expect(cached).toMatchObject({ start: next, generation: 2, state: "loading" });
  expect(cached?.control).toBeUndefined();

  resolveOld({
    state: "ok",
    control: control("instance-old", old.controlPath, "已完成", [
      { name: "s1", round: 1, requiresConfirmation: false, status: "delivered" },
    ]),
  });
  await oldLoad;
  expect(cached).toMatchObject({ start: next, generation: 2, state: "loading" });
  expect(cached?.control).toBeUndefined();

  for (const mismatch of [
    { ...next, instanceId: "instance-other" },
    { ...next, controlPath: "D:/项目/.pao/other" },
    { ...next, ownerSessionId: "session-other" },
  ]) {
    let rejected: TaskStatusControlSnapshot | undefined;
    await loadTaskStatusControl(changed.planId, mismatch, {
      read: async () => ({
        state: "ok",
        control: control("instance-new", next.controlPath, "运行中", []),
      }),
      begin: (snapshot) => {
        rejected = snapshot;
      },
      apply: (snapshot) => {
        rejected = snapshot;
      },
      isCurrent: () => true,
      generation: 4,
    });
    expect(rejected).toMatchObject({ start: mismatch, state: "failed" });
    expect(rejected?.control).toBeUndefined();
    expect(rejected?.message).toContain("身份不一致");
  }
  expect(mismatched.instanceId).toBe(next.instanceId);

  resolveNext({
    state: "ok",
    control: control("instance-new", next.controlPath, "运行中", [
      { name: "s1", round: 2, requiresConfirmation: false, status: "in_progress" },
    ]),
  });
  await nextLoad;
  expect(cached).toMatchObject({
    start: next,
    generation: 2,
    state: "ready",
    control: { instanceId: "instance-new", status: "运行中" },
  });
  expect(beginTaskStatusControl(changed.planId, 3, next)).toMatchObject({
    start: next,
    generation: 3,
    state: "loading",
  });
});
