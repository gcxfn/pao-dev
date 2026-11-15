/**
 * S8-TUI1 常驻摘要：输入区附近的会话待办折叠呈现（照 TUI 原生呈现面，样式先例＝上游
 * plan-mode 示例的 setStatus＋setWidget 组合；omp 实测零 todo 渲染，S8 派前盘点 §4.4 已核）。
 *
 * - 折叠：footer 状态行（setStatus，「待办 n/m · 当前任务」，分母同 renderTodoList 扣 cancelled）；
 *   截断/净化由 footer 原生 truncateToWidth/sanitizeStatusText 负责，这里保证单行不破结构。
 * - 展开：/todo 切换编辑区上方挂件（setWidget，四态行复用 renderTodoList，上限 8 行＋剩余计数；
 *   超宽行由 pi-tui Text 原生按宽换行；挂件总量低于原生 MAX_WIDGET_LINES=10）。
 * - 取数：currentTodos 权威源（查询＋订阅，不重放时间线）；todo_write 成功结果经 tool_result
 *   事件驱动刷新；session_start/session_tree（切会话/恢复/分支）自动收起并按重建清单刷新。
 * - 模式门：仅 TUI 渲染；rpc/json 零输出（桌面壳的常驻摘要归 S8-桌面1，不在此越界）。
 * - 空清单隐藏（footer 行与挂件都 undefined）。
 */
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { renderTodoList, type TodoItem } from "../todo/core.ts";

/** footer 状态行键（与「用量」同面的扩展状态行，footer 按键名字母序拼一行） */
export const TODO_STATUS_KEY = "待办";

const WIDGET_KEY = "todo-summary";
/** 展开列表可见上限（桌面 TodoDock 同款 8；超出走「… 还有 n 项」剩余计数） */
const VISIBLE_LIMIT = 8;

/** 单行化：条目 content 里的换行/制表折成空格（footer sanitize 兜底，挂件行结构不破） */
function oneLine(text: string): string {
	return text.replace(/[\r\n\t]+/g, " ").trim();
}

/** 展示用整表：content/activeForm 先单行化再进 renderTodoList（内部换行会拆散行结构） */
function displayTodos(todos: readonly TodoItem[]): TodoItem[] {
	return todos.map((t) => ({
		...t,
		content: oneLine(t.content),
		...(t.activeForm ? { activeForm: oneLine(t.activeForm) } : {}),
	}));
}

/** 折叠行：「待办 n/m」或「待办 n/m · 当前任务」。空清单返回 undefined（隐藏）。 */
export function formatTodoStatusLine(todos: readonly TodoItem[]): string | undefined {
	if (todos.length === 0) return undefined;
	// 分母扣 cancelled 的规则唯一家在 renderTodoList，这里从其表头取数（「待办 完成 n/m：」）
	const header = renderTodoList(displayTodos(todos)).split("\n")[0];
	const counts = header.slice("待办 完成 ".length, -1);
	const current = todos.find((t) => t.status === "in_progress");
	return oneLine(`待办 ${counts}${current ? ` · ${current.activeForm ?? current.content}` : ""}`);
}

/** 展开列表行：四态行与 renderTodoList 完全同源；超 8 项截断＋剩余计数。空清单返回 undefined。 */
export function formatTodoWidgetLines(todos: readonly TodoItem[]): string[] | undefined {
	if (todos.length === 0) return undefined;
	const lines = renderTodoList(displayTodos(todos)).split("\n").slice(1);
	const visible = lines.slice(0, VISIBLE_LIMIT);
	if (lines.length > VISIBLE_LIMIT) visible.push(`… 还有 ${lines.length - VISIBLE_LIMIT} 项`);
	return visible;
}

/**
 * 常驻摘要接线（全角色；非 TUI 模式零输出）。deps.currentTodos 由 pao/index.ts 从
 * registerTodo(pi).currentTodos 接来（闭包态权威源，todo 模块重建后本面自动跟新）。
 */
export function registerTodoSummary(pi: ExtensionAPI, deps: { currentTodos: () => readonly TodoItem[] }): void {
	let expanded = false;
	const refresh = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;
		const todos = deps.currentTodos();
		ctx.ui.setStatus(TODO_STATUS_KEY, formatTodoStatusLine(todos));
		ctx.ui.setWidget(WIDGET_KEY, expanded ? formatTodoWidgetLines(todos) : undefined);
	};
	const collapseAndRefresh = (_event: unknown, ctx: ExtensionContext): void => {
		expanded = false;
		refresh(ctx);
	};
	pi.on("tool_result", (_event, ctx) => refresh(ctx));
	pi.on("session_start", collapseAndRefresh);
	pi.on("session_tree", collapseAndRefresh);
	pi.registerCommand("todo", {
		description: "展开/收起会话待办清单（输入区上方挂件；空清单无操作）",
		handler: async (_args, ctx) => {
			if (deps.currentTodos().length === 0) {
				ctx.ui.notify("会话待办清单为空");
				return;
			}
			expanded = !expanded;
			refresh(ctx);
		},
	});
}
