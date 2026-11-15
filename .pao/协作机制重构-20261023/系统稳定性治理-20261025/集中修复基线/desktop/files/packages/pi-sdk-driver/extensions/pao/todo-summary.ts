/**
 * S8-桌面常驻摘要：输入区附近的会话待办折叠呈现（rpc 皮肤）。与内核 TUI1（pao/ui/todo-summary）
 * 同一权威源不同皮：TUI1 走 setStatus/setWidget 渲染 footer 与挂件（仅 tui 模式）；桌面会话的
 * mode 是 rpc（session-supervisor bindExtensions 定死），内核皮肤零输出，本模块补桌面皮。
 * S9 起扫描与口径格式化取自内核公开面「@earendil-works/pi-coding-agent/pao/todo」
 * （scanTodoState 同款扫描＋formatTodoStatusLine/formatTodoWidgetLines 同 renderTodoList 口径），
 * 本模块只留桌面特有的 rpc 投影。
 *
 * - 通道零新增：ctx.ui.setStatus/setWidget 由桌面 supervisor 桥为既有 hostUiRequest
 *   status/widget 事件（extension-ui-state 维护每会话状态、订阅时重放＝查询＋订阅恢复），
 *   renderer 输入区上方既有 ExtensionDock 消费（composer-surface 挂点，空载荷即隐藏）。
 * - 取数与 TUI 同源：成功 todo_write 的 toolResult details 权威信封（CustomToolResultEvent
 *   自带 details，事件先于 toolResult 落会话，故刷新用事件载荷）；session_start/session_tree
 *   按分支重扫恢复（内核 scanTodoState，含 pao-todo-snapshot 压缩快照条目），不重放时间线。
 * - 展开上限 8 行＋剩余计数、四态符号、分母扣 cancelled 全在内核格式化函数里（renderTodoList
 *   口径）；工具名 todo_write 与内核 TODO_WRITE_TOOL_NAME 同名（卡协议级工具名，取内核常量）。
 */
import {
  formatTodoStatusLine,
  formatTodoWidgetLines,
  isTodoState,
  scanTodoState,
  TODO_WRITE_TOOL_NAME,
  type TodoItem,
} from "@earendil-works/pi-coding-agent/pao/todo";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** 状态行键与挂件键与内核 TUI1 同名（模式门互斥，不双写） */
export const TODO_STATUS_KEY = "待办";
export const TODO_WIDGET_KEY = "todo-summary";

/**
 * 桌面皮接线（rpc 模式；tui 归内核 TUI1）。刷新＝整表重推：状态行驱动 dock 折叠摘要，
 * 挂件行是 dock 展开正文；空清单双撤（renderer dock 随之隐藏）。展开/收起交互由 dock 自持，
 * 内核侧不镜像（与 TUI1 的 /todo 切换不同皮不同责）。
 */
export function registerDesktopTodoSummary(pi: ExtensionAPI): void {
  const push = (ctx: ExtensionContext, todos: readonly TodoItem[]): void => {
    ctx.ui.setStatus(TODO_STATUS_KEY, formatTodoStatusLine(todos));
    ctx.ui.setWidget(TODO_WIDGET_KEY, formatTodoWidgetLines(todos));
  };
  const refresh = (ctx: ExtensionContext): void => {
    if (ctx.mode !== "rpc") return;
    push(ctx, scanTodoState(ctx.sessionManager.getBranch()).todos);
  };
  pi.on("session_start", (_event, ctx) => refresh(ctx));
  pi.on("session_tree", (_event, ctx) => refresh(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode !== "rpc") return;
    push(ctx, []);
  });
  // tool_result 事件先于 toolResult 落会话（agent-loop finalizeExecutedToolCall 次序），
  // 扫分支会拿到旧表——成功结果直接用事件自带 details（即内核刚写入的权威信封）。
  pi.on("tool_result", (event, ctx) => {
    if (ctx.mode !== "rpc") return;
    const custom = event as { toolName?: unknown; isError?: unknown; details?: unknown };
    if (custom.toolName !== TODO_WRITE_TOOL_NAME || custom.isError) return;
    if (!isTodoState(custom.details)) return;
    push(ctx, custom.details.todos);
  });
}
