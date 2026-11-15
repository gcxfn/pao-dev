/**
 * todo 纯原语（S10-P1 修复自 index.ts 整体迁出）：四态模型、校验规范化、分支扫描（含
 * pao-todo-snapshot 快照续读）与纯文本渲染。本模块零运行时外部依赖（import type 除外）——
 * summary.ts 公开面与 cards/delivery（桌面消费图）经此取数，不得触 pi-tui/typebox 等
 * TUI 专属依赖（P1-1：vendor 物化树里兄弟包不可达，桌面 dist 图任一顶层裸导入即断链）。
 * 接线（todo_write 注册、TUI 挂件）分别留在 index.ts 与 ui/todo-summary.ts。
 */
import type { SessionEntry } from "../../core/session-manager.ts";

export const TODO_WRITE_TOOL_NAME = "todo_write";

export const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface TodoItem {
	/** 祈使句任务描述（trim 后非空、互不重复） */
	content: string;
	status: TodoStatus;
	/** 进行时表述（可选，缺省回退 content；首版收下不渲染） */
	activeForm?: string;
}

/** toolResult details 与快照条目共用的整表信封 */
export interface TodoState {
	version: 1;
	todos: TodoItem[];
}

/** 提醒文本行首标记；重建扫描据 content 中的该标记判定「本陈旧期已提醒过」 */
export const TODO_REMINDER_MARKER = "【待办对账】";

/** 陈旧提醒阈值：自上次成功 todo_write 起累计的成功实质调用数（计划定案 5，不建配置） */
export const STALE_REMINDER_THRESHOLD = 5;
/** 快照条目类型（压缩边界持久化） */
export const SNAPSHOT_CUSTOM_TYPE = "pao-todo-snapshot";
/** 实质调用集合：写/执行类才计入陈旧计数；读取类与 todo_write 自身不计 */
export const SUBSTANTIVE_TOOLS = new Set(["bash", "powershell", "write", "edit", "multiedit"]);

/** 条数硬上限（对齐 Claude Code「不超过 20 项」口径） */
const MAX_TODOS = 20;

export const STATUS_GLYPH: Record<TodoStatus, string> = {
	pending: "○",
	in_progress: "◐",
	completed: "✓",
	cancelled: "⊘",
};

function isTodoStatus(value: unknown): value is TodoStatus {
	return typeof value === "string" && (TODO_STATUSES as readonly string[]).includes(value);
}

function isTodoItem(value: unknown): value is TodoItem {
	if (!value || typeof value !== "object") return false;
	const item = value as Partial<TodoItem>;
	return (
		typeof item.content === "string" &&
		item.content.trim() !== "" &&
		isTodoStatus(item.status) &&
		(item.activeForm === undefined || typeof item.activeForm === "string")
	);
}

export function isTodoState(value: unknown): value is TodoState {
	if (!value || typeof value !== "object") return false;
	const state = value as Partial<TodoState>;
	return state.version === 1 && Array.isArray(state.todos) && state.todos.every(isTodoItem);
}

/**
 * 校验并规范化整表。合法返回规范化清单（content 去首尾空白；空白 activeForm 丢弃）；
 * 非法返回 error（调用方须保留旧清单不覆写）。空数组合法（清空）。
 */
export function normalizeTodoList(input: unknown): { todos: TodoItem[]; error?: string } {
	const raw = (input as { todos?: unknown } | null | undefined)?.todos;
	if (!Array.isArray(raw)) return { todos: [], error: "todos 必须是数组" };
	if (raw.length > MAX_TODOS) return { todos: [], error: `清单超过上限：收到 ${raw.length} 项，最多 ${MAX_TODOS} 项` };
	const todos: TodoItem[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < raw.length; i++) {
		const item = raw[i];
		if (!item || typeof item !== "object") return { todos: [], error: `第 ${i + 1} 项必须是对象` };
		const { content, status, activeForm } = item as Record<string, unknown>;
		const text = typeof content === "string" ? content.trim() : "";
		if (!text) return { todos: [], error: `第 ${i + 1} 项 content 不能为空` };
		if (!isTodoStatus(status))
			return { todos: [], error: `第 ${i + 1} 项 status 非法：${JSON.stringify(status) ?? String(status)}` };
		if (seen.has(text)) return { todos: [], error: `第 ${i + 1} 项与前面条目重复：「${text}」` };
		seen.add(text);
		const todo: TodoItem = { content: text, status };
		const form = typeof activeForm === "string" ? activeForm.trim() : "";
		if (form) todo.activeForm = form;
		todos.push(todo);
	}
	return { todos };
}

/** 纯文本渲染：四态符号＋完成度（分母不含 cancelled）。工具结果、提醒、context 注入共用。 */
export function renderTodoList(todos: readonly TodoItem[]): string {
	if (todos.length === 0) return "清单为空";
	const done = todos.filter((t) => t.status === "completed").length;
	const active = todos.filter((t) => t.status !== "cancelled").length;
	const lines = todos.map((t) => `${STATUS_GLYPH[t.status]} ${t.content}`);
	return `待办 完成 ${done}/${active}：\n${lines.join("\n")}`;
}

function hasReminderMarker(message: { content: unknown }): boolean {
	const content = message.content;
	return (
		Array.isArray(content) &&
		content.some(
			(block) =>
				block &&
				typeof block === "object" &&
				block.type === "text" &&
				typeof block.text === "string" &&
				block.text.includes(TODO_REMINDER_MARKER),
		)
	);
}

/** getBranch 逆扫结果：清单、自上次成功 todo_write 起的实质计数、是否已提醒、最近快照 */
export interface TodoScanResult {
	todos: TodoItem[];
	staleCount: number;
	reminded: boolean;
	/** 分支上最近一次 pao-todo-snapshot 快照（压缩边界载体；未压缩过为 undefined） */
	snapshot: TodoState | undefined;
}

/**
 * 从会话分支重建（纯函数）。状态载体：成功 todo_write 的 toolResult details（后者胜）与
 * pao-todo-snapshot 快照条目；错误结果不改状态。getBranch 含被压缩条目——文件级恢复安全。
 * S8-内核2（回执对账）与 S8-TUI1（常驻摘要）从这里取权威清单，不读模块内部状态。
 */
export function scanTodoState(entries: readonly SessionEntry[]): TodoScanResult {
	let todos: TodoItem[] = [];
	let staleCount = 0;
	let reminded = false;
	let snapshot: TodoState | undefined;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === SNAPSHOT_CUSTOM_TYPE && isTodoState(entry.data)) {
			todos = entry.data.todos;
			snapshot = entry.data;
			staleCount = 0;
			reminded = false;
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "toolResult") continue;
		if (message.toolName === TODO_WRITE_TOOL_NAME) {
			if (!message.isError && isTodoState(message.details)) {
				todos = message.details.todos;
				staleCount = 0;
				reminded = false;
			}
			continue;
		}
		if (typeof message.toolName !== "string") continue;
		if (!message.isError && SUBSTANTIVE_TOOLS.has(message.toolName)) {
			staleCount++;
			if (hasReminderMarker(message)) reminded = true;
		}
	}
	return { todos, staleCount, reminded, snapshot };
}
