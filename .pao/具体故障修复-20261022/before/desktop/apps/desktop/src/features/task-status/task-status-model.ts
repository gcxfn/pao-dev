import type { TranscriptMessage } from "../../../contracts/timeline-types";
import type { KanbanResult } from "../../../contracts/kanban";
import type { TemporaryPlanRow, TemporaryPlanStartRow } from "../../../contracts/temporary-plans";
import type { WorkflowControlIdentity } from "../../../contracts/workflow-control";
import { desktopPathKey } from "../../../contracts/path-identity";
import { isTodoToolCall, parseTodoList, type TodoItem } from "../conversation/todo-table";
import { buildDepartmentGroups } from "../workboard/department-board-model";

export interface SessionTodoSnapshot {
  readonly items?: readonly TodoItem[];
  readonly notice?: string;
}

/** 只取当前会话最近一次成功写入的清单；明确清空不会复活上一份。 */
export function latestSessionTodos(transcript: readonly TranscriptMessage[]): SessionTodoSnapshot {
  let notice: string | undefined;
  for (let index = transcript.length - 1; index >= 0; index--) {
    const row = transcript[index]!;
    if (row.kind !== "tool" || !isTodoToolCall(row.toolName)) continue;
    // 读取清单的工具不产生新清单；写入失败仍保留最近一次成功结果。
    if (/read|list|get/i.test(row.toolName)) continue;
    if (row.status !== "success") {
      notice ??=
        row.status === "running"
          ? "待办正在更新，暂时显示上次记录。"
          : "最近一次待办更新失败，保留上次记录。";
      continue;
    }
    const input = row.input;
    if (
      input &&
      typeof input === "object" &&
      "todos" in input &&
      Array.isArray(input.todos) &&
      input.todos.length === 0
    )
      return { items: [], notice };
    const items = parseTodoList(input);
    return items ? { items, notice } : { notice: "最近一份待办清单无法读取，请查看原会话记录。" };
  }
  return { notice };
}

export interface TaskStatusControlSnapshot {
  readonly planId: string;
  readonly start: TemporaryPlanStartRow | undefined;
  readonly generation: number;
  readonly state: "idle" | "loading" | "ready" | "failed";
  readonly control?: WorkflowControlIdentity;
  readonly message?: string;
}

export function latestPlanStart(plan: TemporaryPlanRow): TemporaryPlanStartRow | undefined {
  return plan.starts.at(-1);
}

export function taskStatusControlIdentity(planId: string, start: TemporaryPlanStartRow) {
  return {
    planId,
    startRequestId: start.startRequestId,
    instanceId: start.instanceId,
    controlPath: start.controlPath,
    ownerSessionId: start.ownerSessionId,
  } as const;
}

export type TaskStatusControlIdentity = ReturnType<typeof taskStatusControlIdentity>;

export function sameTaskStatusControlIdentity(
  left: TaskStatusControlIdentity,
  right: TaskStatusControlIdentity,
): boolean {
  return (
    left.planId === right.planId &&
    left.startRequestId === right.startRequestId &&
    left.instanceId === right.instanceId &&
    left.controlPath === right.controlPath &&
    left.ownerSessionId === right.ownerSessionId
  );
}

/** 只在最新 start 上核对一次 control 的实例、清单路径和 owner；不匹配的快照不得进入步骤合并。 */
export function controlMatchesLatestStart(
  planId: string,
  start: TemporaryPlanStartRow,
  control: WorkflowControlIdentity,
): boolean {
  return (
    control.instanceId === start.instanceId &&
    control.path === start.controlPath &&
    control.ownerSessionId === start.ownerSessionId
  );
}

export function mismatchedTaskStatusControl(
  planId: string,
  start: TemporaryPlanStartRow,
  generation: number,
  control: WorkflowControlIdentity,
): TaskStatusControlSnapshot {
  return {
    planId,
    start,
    generation,
    state: "failed",
    message: `运行状态与最新启动身份不一致：启动 ${start.instanceId}，控制 ${control.instanceId}。`,
  };
}

export function beginTaskStatusControl(
  planId: string,
  generation: number,
  start: TemporaryPlanStartRow | undefined,
): TaskStatusControlSnapshot {
  return {
    planId,
    start,
    generation,
    state: "loading",
  };
}

export function acceptsTaskStatusControl(
  snapshot: TaskStatusControlSnapshot,
  current: TaskStatusControlSnapshot | undefined,
): boolean {
  const sameStart =
    snapshot.start === undefined
      ? current?.start === undefined
      : current?.start !== undefined &&
        sameTaskStatusControlIdentity(
          taskStatusControlIdentity(snapshot.planId, snapshot.start),
          taskStatusControlIdentity(current.planId, current.start),
        );
  return (
    snapshot.generation > 0 &&
    current?.planId === snapshot.planId &&
    current.generation === snapshot.generation &&
    sameStart
  );
}

export function taskStatusControlForPlan(
  plan: TemporaryPlanRow,
  snapshot: TaskStatusControlSnapshot | undefined,
  activeGeneration?: number,
): TaskStatusControlSnapshot {
  const start = latestPlanStart(plan);
  if (!start) {
    return {
      planId: plan.planId,
      start: undefined,
      generation: snapshot?.generation ?? 0,
      state: "idle",
    };
  }
  const matches =
    snapshot?.planId === plan.planId &&
    snapshot.start !== undefined &&
    sameTaskStatusControlIdentity(
      taskStatusControlIdentity(plan.planId, start),
      taskStatusControlIdentity(snapshot.planId, snapshot.start),
    );
  return matches &&
    snapshot &&
    (activeGeneration === undefined || snapshot.generation === activeGeneration)
    ? snapshot
    : beginTaskStatusControl(plan.planId, activeGeneration ?? 0, start);
}

/**
 * 新启动出来时立即丢弃旧 control，并只为当前 start 发起一次读取。
 * 迟到旧结果只有在加载代次、plan 与完整 start 身份都对得上时才落盘。
 */
export function loadTaskStatusControl(
  planId: string,
  start: TemporaryPlanStartRow,
  options: {
    readonly read: (
      start: TemporaryPlanStartRow,
    ) => Promise<
      | { readonly state: "ok"; readonly control: WorkflowControlIdentity }
      | { readonly state: "failed"; readonly message: string }
    >;
    readonly begin: (snapshot: TaskStatusControlSnapshot) => void;
    readonly apply: (snapshot: TaskStatusControlSnapshot) => void;
    readonly isCurrent: () => boolean;
    readonly generation: number;
  },
): Promise<void> {
  const loading = beginTaskStatusControl(planId, options.generation, start);
  options.begin(loading);
  return options
    .read(start)
    .then((result) => {
      const snapshot: TaskStatusControlSnapshot =
        result.state === "ok"
          ? controlMatchesLatestStart(planId, start, result.control)
            ? {
                planId,
                start,
                generation: loading.generation,
                state: "ready",
                control: result.control,
              }
            : mismatchedTaskStatusControl(planId, start, loading.generation, result.control)
          : {
              planId,
              start,
              generation: loading.generation,
              state: "failed",
              message: result.message,
            };
      if (options.isCurrent()) options.apply(snapshot);
    })
    .catch((error: unknown) => {
      if (options.isCurrent())
        options.apply({
          planId,
          start,
          generation: loading.generation,
          state: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
    });
}

/** 不将同项目其他主控或无归属的部门任务混进当前工作。 */
export function currentDepartmentGroups(
  result: KanbanResult | undefined,
  project: string | undefined,
  owner: string | undefined,
) {
  if (result?.state !== "available" || !project || !owner) return [];
  return buildDepartmentGroups(result.cards, result.workflows).filter(
    (group) =>
      desktopPathKey(group.project) === desktopPathKey(project) && group.ownerSessionId === owner,
  );
}
