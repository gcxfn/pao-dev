/**
 * todo 纯函数公开面（package.json exports「./pao/todo」，S9 抽取）：跨皮共用口径——分支扫描
 * （scanTodoState，含 pao-todo-snapshot 快照续读）与摘要格式化（formatTodoStatusLine/
 * formatTodoWidgetLines，TUI1 与桌面 rpc 皮肤同源，桌面不再各自复写）。接线不在此导出：
 * todo_write 工具注册（registerTodo）与 TUI 挂件接线（registerTodoSummary）分别留在
 * 本模块与 ui/todo-summary.ts。
 */
export { formatTodoStatusLine, formatTodoWidgetLines } from "../ui/todo-summary.ts";
export { isTodoState, scanTodoState, TODO_WRITE_TOOL_NAME, type TodoItem } from "./core.ts";
