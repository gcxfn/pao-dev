// S8-桌面常驻摘要包 driver 测试：桌面输入区会话待办折叠摘要（rpc 皮肤）。
// S9 起扫描与口径格式化取自内核公开面「@earendil-works/pi-coding-agent/pao/todo」
// （scanTodoState＋formatTodoStatusLine/formatTodoWidgetLines，扩展运行时同一导入，契约不放宽）；
// 零新增 IPC：经 ctx.ui.setStatus/setWidget → hostUiRequest 既有通道（supervisor 重放即订阅恢复）。
// 纯内存夹具：零文件、零网络、零环境依赖。
import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  formatTodoStatusLine,
  formatTodoWidgetLines,
  scanTodoState,
  type TodoItem,
} from "@earendil-works/pi-coding-agent/pao/todo";
import {
  TODO_STATUS_KEY,
  TODO_WIDGET_KEY,
  registerDesktopTodoSummary,
} from "../extensions/pao/todo-summary.ts";

const todo = (content: string, status: TodoItem["status"], activeForm?: string): TodoItem =>
  activeForm === undefined ? { content, status } : { content, status, activeForm };

const envelope = (todos: TodoItem[]) => ({ version: 1, todos });

/** 会话条目（内核 SessionEntry 全形；扫描只读 type/customType/data/message 字段）。 */
const toolResultEntry = (toolName: string, isError: boolean, details?: unknown): SessionEntry => ({
  type: "message",
  id: `m-${toolName}-${Math.random().toString(36).slice(2, 8)}`,
  parentId: null,
  timestamp: new Date().toISOString(),
  message: {
    role: "toolResult",
    toolCallId: "t1",
    toolName,
    isError,
    details,
    content: [{ type: "text", text: "ok" }],
  },
});
const snapshotEntry = (todos: TodoItem[]): SessionEntry => ({
  type: "custom",
  id: `c-${Math.random().toString(36).slice(2, 8)}`,
  parentId: null,
  timestamp: new Date().toISOString(),
  customType: "pao-todo-snapshot",
  data: envelope(todos),
});

/** 内核 scanTodoState 只取清单（桌面皮不用 staleCount/快照字段）。 */
const scanTodos = (entries: readonly SessionEntry[]): TodoItem[] => scanTodoState(entries).todos;

interface UiCalls {
  status: Map<string, string | undefined>;
  widgets: Map<string, string[] | undefined>;
}

function fakePi() {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const api = {
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
      const list = handlers.get(name);
      if (list) list.push(handler);
      else handlers.set(name, [handler]);
      return () => {};
    },
  };
  return {
    api: api as unknown as ExtensionAPI,
    handlers,
    async fire(name: string, event: unknown, ctx: unknown): Promise<void> {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    },
  };
}

function fakeCtx(mode: string, entries: unknown[] = []): { ctx: ExtensionContext; ui: UiCalls } {
  const ui: UiCalls = { status: new Map(), widgets: new Map() };
  const ctx = {
    mode,
    sessionManager: { getBranch: () => entries },
    ui: {
      setStatus: (key: string, text: string | undefined) => void ui.status.set(key, text),
      setWidget: (key: string, lines: string[] | undefined) => void ui.widgets.set(key, lines),
    },
  };
  return { ctx: ctx as unknown as ExtensionContext, ui };
}

const toolResultEvent = (toolName: string, isError: boolean, details?: unknown) => ({
  toolName,
  isError,
  details,
});

await test("折叠行与 TUI 同口径：完成 n/m 分母扣 cancelled，当前任务 activeForm 优先，空清单隐藏", () => {
  const mixed = [
    todo("收集素材", "completed"),
    todo("写代码", "in_progress", "正在写代码"),
    todo("验证渲染", "pending"),
    todo("放弃的支线", "cancelled"),
  ];
  assert.equal(formatTodoStatusLine(mixed), "待办 1/3 · 正在写代码");
  assert.equal(formatTodoStatusLine([todo("收集素材", "completed")]), "待办 1/1");
  assert.equal(formatTodoStatusLine([]), undefined);
  // 条目内换行折成空格：单行结构不破
  assert.equal(
    formatTodoStatusLine([todo("多\n行\t任务", "in_progress")]),
    "待办 0/1 · 多 行 任务",
  );
});

await test("展开列表与 TUI 同口径：四态符号、8 行上限＋剩余计数，空清单隐藏", () => {
  const three = [
    todo("收集素材", "completed"),
    todo("写代码", "in_progress"),
    todo("验证渲染", "pending"),
  ];
  assert.deepEqual(formatTodoWidgetLines(three), ["✓ 收集素材", "◐ 写代码", "○ 验证渲染"]);
  const ten = Array.from({ length: 10 }, (_, i) => todo(`任务${i + 1}`, "pending"));
  const lines = formatTodoWidgetLines(ten);
  assert.equal(lines?.length, 9);
  assert.equal(lines?.[8], "… 还有 2 项");
  assert.equal(lines?.[0], "○ 任务1");
  assert.equal(formatTodoWidgetLines([]), undefined);
});

await test("扫描取内核 scanTodoState 同口径：成功 details 后者胜、错误不改、快照条目续读", () => {
  const a = [todo("任务A", "in_progress")];
  const b = [todo("任务B", "pending")];
  assert.deepEqual(
    scanTodos([
      toolResultEntry("bash", false, {}),
      toolResultEntry("todo_write", false, envelope(a)),
      toolResultEntry("todo_write", true, envelope(b)), // 错误结果不改状态
    ]),
    a,
  );
  assert.deepEqual(
    scanTodos([
      toolResultEntry("todo_write", false, envelope(a)),
      toolResultEntry("todo_write", false, envelope(b)),
    ]),
    b,
    "后者胜",
  );
  assert.deepEqual(
    scanTodos([
      toolResultEntry("todo_write", false, envelope(a)),
      snapshotEntry(b),
      toolResultEntry("todo_write", false, envelope(a)),
    ]),
    a,
    "快照条目是压缩边界载体，之后的成功 toolResult 仍后者胜",
  );
  assert.deepEqual(scanTodos([snapshotEntry(b)]), b);
  assert.deepEqual(scanTodos([]), []);
  assert.deepEqual(
    scanTodos([toolResultEntry("todo_write", true, envelope(a))]),
    [],
    "只有错误结果时清单为空",
  );
});

await test("rpc 接线：todo_write 成功结果驱动状态行＋挂件；错误与其他工具不刷新", async () => {
  const { api, fire } = fakePi();
  registerDesktopTodoSummary(api);
  const { ctx, ui } = fakeCtx("rpc");
  await fire(
    "tool_result",
    toolResultEvent("todo_write", false, envelope([todo("写代码", "in_progress", "正在写代码")])),
    ctx,
  );
  assert.equal(ui.status.get(TODO_STATUS_KEY), "待办 0/1 · 正在写代码");
  assert.deepEqual(ui.widgets.get(TODO_WIDGET_KEY), ["◐ 写代码"]);

  const beforeStatus = ui.status.get(TODO_STATUS_KEY);
  const beforeWidget = ui.widgets.get(TODO_WIDGET_KEY);
  await fire(
    "tool_result",
    toolResultEvent("todo_write", true, envelope([todo("非法", "pending")])),
    ctx,
  );
  assert.equal(ui.status.get(TODO_STATUS_KEY), beforeStatus, "错误结果不改状态（同内核口径）");
  assert.equal(ui.widgets.get(TODO_WIDGET_KEY), beforeWidget);
  await fire("tool_result", toolResultEvent("bash", false, { ok: 1 }), ctx);
  assert.equal(ui.status.get(TODO_STATUS_KEY), beforeStatus, "非 todo 工具不触发刷新");

  await fire("tool_result", toolResultEvent("todo_write", false, envelope([])), ctx);
  assert.equal(ui.status.get(TODO_STATUS_KEY), undefined, "清空后隐藏");
  assert.equal(ui.widgets.get(TODO_WIDGET_KEY), undefined);
});

await test("rpc 接线：session_start/session_tree 按分支重扫恢复（切会话正确），shutdown 清空", async () => {
  const { api, fire } = fakePi();
  registerDesktopTodoSummary(api);
  const first = fakeCtx("rpc", [
    toolResultEntry("todo_write", false, envelope([todo("任务A", "in_progress")])),
  ]);
  await fire("session_start", {}, first.ctx);
  assert.equal(first.ui.status.get(TODO_STATUS_KEY), "待办 0/1 · 任务A");

  // 切会话：新分支为空 → 隐藏（不残留上一会话清单）
  const second = fakeCtx("rpc", []);
  await fire("session_tree", {}, second.ctx);
  assert.equal(second.ui.status.get(TODO_STATUS_KEY), undefined);
  assert.equal(second.ui.widgets.get(TODO_WIDGET_KEY), undefined);

  // 恢复：重启后分支含快照条目也能续读
  const third = fakeCtx("rpc", [snapshotEntry([todo("任务C", "in_progress")])]);
  await fire("session_start", {}, third.ctx);
  assert.equal(third.ui.status.get(TODO_STATUS_KEY), "待办 0/1 · 任务C");

  await fire("session_shutdown", {}, third.ctx);
  assert.equal(third.ui.status.get(TODO_STATUS_KEY), undefined, "关闭清理：状态行撤除");
  assert.equal(third.ui.widgets.get(TODO_WIDGET_KEY), undefined, "关闭清理：挂件撤除");
});

await test("模式门：tui 模式零输出（TUI 皮肤归内核 todo-summary，不双写）", async () => {
  const { api, fire } = fakePi();
  registerDesktopTodoSummary(api);
  const { ctx, ui } = fakeCtx("tui", [
    toolResultEntry("todo_write", false, envelope([todo("任务A", "pending")])),
  ]);
  await fire("session_start", {}, ctx);
  await fire(
    "tool_result",
    toolResultEvent("todo_write", false, envelope([todo("任务A", "pending")])),
    ctx,
  );
  assert.equal(ui.status.size, 0);
  assert.equal(ui.widgets.size, 0);
});

await test("与 TUI 同键：状态行键「待办」、挂件键 todo-summary（同权威源不同皮）", () => {
  assert.equal(TODO_STATUS_KEY, "待办");
  assert.equal(TODO_WIDGET_KEY, "todo-summary");
});
