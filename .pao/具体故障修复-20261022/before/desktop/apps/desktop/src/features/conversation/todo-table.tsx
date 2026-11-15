import { useI18n } from "../../i18n/react";

/**
 * The checklist states todo plugins write. pi's TodoWrite tool uses these four;
 * other todo tools may spell "completed" as "done", so both normalize here.
 */
export type TodoItemStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
  readonly content: string;
  readonly status: TodoItemStatus;
}

/**
 * Reads the checklist a todo tool writes (pi's TodoWrite payload shape:
 * `{ todos: [{ content, status }] }`). Returns undefined when the input is not
 * a todo list, so every other tool keeps its normal row rendering. An empty
 * list also returns undefined: there is nothing worth a table.
 */
export function parseTodoList(input: unknown): TodoItem[] | undefined {
  if (typeof input !== "object" || input === null) {
    return undefined;
  }
  const todos = (input as { todos?: unknown }).todos;
  if (!Array.isArray(todos) || todos.length === 0) {
    return undefined;
  }
  const items: TodoItem[] = [];
  for (const entry of todos) {
    if (typeof entry !== "object" || entry === null) {
      return undefined;
    }
    const { content, status } = entry as { content?: unknown; status?: unknown };
    if (typeof content !== "string" || !content.trim()) {
      return undefined;
    }
    items.push({ content, status: normalizeTodoStatus(status) });
  }
  return items;
}

function normalizeTodoStatus(status: unknown): TodoItemStatus {
  if (typeof status !== "string") {
    return "pending";
  }
  switch (status.toLowerCase()) {
    case "in_progress":
    case "in-progress":
    case "inprogress":
    case "active":
      return "in_progress";
    case "completed":
    case "done":
      return "completed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return "pending";
  }
}

/** A todo tool is recognized by name; the payload check in parseTodoList keeps it honest. */
export function isTodoToolCall(toolName: string): boolean {
  return /todo/i.test(toolName);
}

const TODO_STATUS_SYMBOL: Record<TodoItemStatus, string> = {
  pending: "○",
  in_progress: "◐",
  completed: "✓",
  cancelled: "⊘",
};

function statusLabelKey(status: TodoItemStatus): string {
  switch (status) {
    case "in_progress":
      return "In progress";
    case "completed":
      return "Done";
    case "cancelled":
      return "Cancelled";
    default:
      return "Pending";
  }
}

/**
 * The task checklist one TodoWrite call carries, drawn as a status table under
 * that call's tool row. Each call renders its own snapshot: a later TodoWrite
 * adds a new table rather than editing an earlier one.
 */
export function TodoTable({ todos }: { readonly todos: readonly TodoItem[] }) {
  const { t } = useI18n();
  return (
    <div className="todo-table" data-testid="todo-table" role="list" aria-label={t("Task list")}>
      <div className="todo-table__header">{t("Task list")}</div>
      <div className="todo-table__body">
        {todos.map((todo, index) => (
          <div
            className={`todo-table__row todo-table__row--${todo.status}`}
            key={`${index}:${todo.content}`}
            role="listitem"
          >
            <span
              className="todo-table__symbol"
              role="img"
              aria-label={t(statusLabelKey(todo.status))}
            >
              {TODO_STATUS_SYMBOL[todo.status]}
            </span>
            <span className="todo-table__content" title={todo.content}>
              {todo.content}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
