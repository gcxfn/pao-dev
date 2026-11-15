// S8-桌面常驻摘要包 renderer 兼容测试：todo_write 走原 TodoTable/parseTodoList 链路实际触发，
// 桌面皮（内核扩展发 status/widget 载荷）被输入区上方 ExtensionDock 消费。零网络纯内存。
import { expect, test } from "@playwright/test";
import {
  applyTimelineEvent,
  timelineFromDriverTranscript,
} from "../../electron/conversation/app-store-timeline";
import { isTodoToolCall, parseTodoList } from "../../src/features/conversation/todo-table";
import { buildExtensionDockModel } from "../../src/features/extensions/extension-session-ui";
import type { TranscriptMessage } from "../../contracts/timeline-types";

const sessionRef = { workspaceId: "workspace", sessionId: "session" };
const key = "workspace:session";
const timestamp = "2026-10-08T00:00:00.000Z";

const CHECKLIST = [
  { content: "收集素材", status: "completed" },
  { content: "写代码", status: "in_progress", activeForm: "正在写代码" },
  { content: "验证渲染", status: "pending" },
];

function timelineState(): Parameters<typeof applyTimelineEvent>[2] {
  return {
    activeAssistantMessageBySession: new Map(),
    pendingAssistantMessageBySession: new Map(),
    activeWorkingActivityBySession: new Map(),
    extensionToolLabels: () => new Map(),
    runningSinceBySession: new Map(),
    runMetricsBySession: new Map(),
  };
}

test("名字含 todo 自动识别命中内核工具名 todo_write", () => {
  expect(isTodoToolCall("todo_write")).toBe(true);
  expect(isTodoToolCall("TodoWrite")).toBe(true);
  expect(isTodoToolCall("bash")).toBe(false);
});

test("parseTodoList 解析 todo_write 入参形状：activeForm 多字段容错，坏输入不渲染", () => {
  const todos = parseTodoList({ todos: CHECKLIST });
  expect(todos).toEqual([
    { content: "收集素材", status: "completed" },
    { content: "写代码", status: "in_progress" },
    { content: "验证渲染", status: "pending" },
  ]);
  expect(parseTodoList({ todos: [] })).toBeUndefined();
  expect(parseTodoList({ todos: [{ status: "pending" }] })).toBeUndefined();
  expect(parseTodoList({})).toBeUndefined();
  expect(parseTodoList("nope")).toBeUndefined();
});

test("时间线链实测：todo_write 的 toolStarted/toolFinished 生成可解析条目，错误结果被链门挡下", () => {
  const transcript = new Map<string, readonly TranscriptMessage[]>();
  const state = timelineState();
  applyTimelineEvent(
    transcript,
    {
      type: "toolStarted",
      sessionRef,
      timestamp,
      toolName: "todo_write",
      callId: "call-1",
      input: { todos: CHECKLIST },
    },
    state,
  );
  applyTimelineEvent(
    transcript,
    { type: "toolFinished", sessionRef, timestamp, callId: "call-1", success: true },
    state,
  );
  const row = transcript
    .get(key)!
    .find((item): item is Extract<TranscriptMessage, { kind: "tool" }> => item.kind === "tool")!;
  // timeline-item.tsx 的取数门与解析，同代码路径断言：
  expect(isTodoToolCall(row.toolName) && row.status !== "error").toBe(true);
  expect(parseTodoList(row.input)).toHaveLength(3);

  const errorTranscript = new Map<string, readonly TranscriptMessage[]>();
  applyTimelineEvent(
    errorTranscript,
    {
      type: "toolStarted",
      sessionRef,
      timestamp,
      toolName: "todo_write",
      callId: "call-2",
      input: { todos: CHECKLIST },
    },
    state,
  );
  applyTimelineEvent(
    errorTranscript,
    { type: "toolFinished", sessionRef, timestamp, callId: "call-2", success: false },
    state,
  );
  const errorRow = errorTranscript
    .get(key)!
    .find((item): item is Extract<TranscriptMessage, { kind: "tool" }> => item.kind === "tool")!;
  expect(isTodoToolCall(errorRow.toolName) && errorRow.status !== "error").toBe(false);
});

test("重载路径：持久化的 todo_write 调用同样出表（切会话/重启恢复）", () => {
  const [row] = timelineFromDriverTranscript(
    [
      {
        kind: "tool",
        id: "call-1",
        callId: "call-1",
        toolName: "todo_write",
        status: "success",
        input: { todos: CHECKLIST },
        createdAt: timestamp,
      },
    ],
    new Map(),
  );
  expect(row).toMatchObject({ kind: "tool", toolName: "todo_write" });
  const tool = row as Extract<TranscriptMessage, { kind: "tool" }>;
  expect(parseTodoList(tool.input)).toHaveLength(3);
});

test("桌面皮消费：内核摘要载荷进 dock 摘要与正文；空清单无载荷即隐藏", () => {
  const dock = buildExtensionDockModel({
    instanceId: "instance-1",
    statuses: [{ key: "待办", text: "待办 1/3 · 正在写代码" }],
    widgets: [
      {
        key: "todo-summary",
        lines: ["✓ 收集素材", "◐ 写代码", "○ 验证渲染"],
        placement: "aboveComposer",
      },
    ],
    pendingDialogs: [],
    notices: [],
  });
  expect(dock?.summaryText).toBe("待办 1/3 · 正在写代码");
  expect(dock?.bodyText).toContain("✓ 收集素材");
  expect(dock?.bodyText).toContain("◐ 写代码");

  expect(buildExtensionDockModel(undefined)).toBeUndefined();
  expect(
    buildExtensionDockModel({
      instanceId: "instance-1",
      statuses: [],
      widgets: [],
      pendingDialogs: [],
      notices: [],
    }),
  ).toBeUndefined();
});
