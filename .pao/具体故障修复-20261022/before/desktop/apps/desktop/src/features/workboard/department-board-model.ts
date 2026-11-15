import type {
  KanbanCard,
  KanbanWorkflow,
  KanbanWorkflowNode,
  WorkboardSessionInput,
} from "../../../contracts/kanban";
import { desktopPathKey } from "../../../contracts/path-identity";

export type DepartmentState = "ready" | "running" | "blocked" | "done" | "canceled";
export interface DepartmentWorker {
  readonly id: string;
  readonly card: KanbanCard;
  readonly executionId?: string;
  readonly status: string;
}
export interface DepartmentGroup {
  readonly id: string;
  readonly project: string;
  readonly department: string;
  readonly title: string;
  readonly ownerSessionId?: string;
  readonly state: DepartmentState;
  readonly reason?: string;
  readonly cards: readonly KanbanCard[];
  readonly workers: readonly DepartmentWorker[];
  readonly flow?: KanbanWorkflow;
  readonly node?: KanbanWorkflowNode;
}

export function departmentState(
  cards: readonly KanbanCard[],
  node?: KanbanWorkflowNode,
): DepartmentState {
  if (node?.status === "delivered") return "done";
  if (
    (node?.status === "canceled" &&
      !cards.some((card) => card.status === "in_progress" || card.status === "unclaimed")) ||
    (cards.length > 0 && cards.every((card) => card.status === "canceled"))
  )
    return "canceled";
  if (node?.status === "canceled") return "blocked";
  if (!node && cards.some((card) => card.status === "canceled"))
    return cards.every((card) => card.status === "canceled" || card.status === "delivered")
      ? "canceled"
      : "blocked";
  if (
    node?.status === "failed" ||
    node?.status === "读取异常" ||
    cards.some((card) => card.status === "failed")
  )
    return "blocked";
  if (node?.hold && !/等待前置|等待部长.*拆解|等待部长会话绑定/.test(node.hold)) return "blocked";
  if (
    node?.status &&
    !["in_progress", "no_card", "delivered", "failed", "canceled"].includes(node.status)
  )
    return "blocked";
  if (node?.status === "in_progress" || cards.some((card) => card.status === "in_progress"))
    return "running";
  if (!node && cards.length > 0 && cards.every((card) => card.status === "delivered"))
    return "done";
  if (node?.ministerSessionId && !node.hold?.includes("等待前置")) return "running";
  return "ready";
}

const cardDir = (path: string) => desktopPathKey(path.replace(/[\\/][^\\/]+$/, ""));
const refNumber = (ref: string) => (/^卡(\d+)$/.test(ref) ? Number(ref.slice(1)) : undefined);

function workersOf(cards: readonly KanbanCard[]): DepartmentWorker[] {
  return cards.flatMap((card) => {
    const current = card.executions.filter(
      (execution) =>
        execution.当前尝试 === true ||
        (execution.当前尝试 === undefined && execution.尝试 === card.attempts),
    );
    const executions = [
      ...new Map(
        current
          .filter((row) => typeof row.执行标识 === "string")
          .map((row) => [row.执行标识 as string, row]),
      ).values(),
    ];
    return executions.length > 0
      ? executions.map((row) => ({
          id: `${card.path}:${String(row.执行标识)}`,
          executionId: String(row.执行标识),
          card,
          status: card.status,
        }))
      : [{ id: card.path, card, status: card.status }];
  });
}

/** 只组织现读快照：同部门不同任务、实例和轮次分别成组，不保存第二份执行状态。 */
export function buildDepartmentGroups(
  cards: readonly KanbanCard[],
  flows: readonly KanbanWorkflow[],
): DepartmentGroup[] {
  const groups: DepartmentGroup[] = [];
  const claimed = new Set<string>();
  for (const flow of flows) {
    for (const node of flow.nodes) {
      const nodeCards = cards.filter(
        (card) =>
          cardDir(card.path) === desktopPathKey(node.cardsDir) &&
          node.cardRefs.some((ref) => refNumber(ref) === card.number),
      );
      nodeCards.forEach((card) => claimed.add(desktopPathKey(card.path)));
      const state = departmentState(nodeCards, node);
      const missing = node.cardRefs.length > nodeCards.length;
      groups.push({
        id: `${desktopPathKey(flow.path)}:${flow.instance}:${node.name}:${node.round}`,
        project: flow.project,
        department: node.department ?? nodeCards[0]?.department ?? "部门未记录",
        title: node.title || node.name,
        ownerSessionId: flow.ownerSessionId,
        state: missing ? "blocked" : state,
        reason: missing
          ? "本轮任务卡缺失或不可读取，请查看读取问题。"
          : (node.hold ??
            (state === "blocked" ? "任务失败或状态无法确认，请查看任务详情。" : undefined)),
        cards: nodeCards,
        workers: workersOf(nodeCards),
        flow,
        node,
      });
    }
  }
  const standalone = new Map<string, KanbanCard[]>();
  for (const card of cards) {
    if (claimed.has(desktopPathKey(card.path))) continue;
    // 工作流旧轮的卡仍可在原始任务卡页查阅，不混进当前轮次。
    if (
      flows.some((flow) =>
        flow.nodes.some(
          (node) =>
            desktopPathKey(node.cardsDir) === cardDir(card.path) &&
            node.historicalCardRefs?.some((ref) => refNumber(ref) === card.number),
        ),
      )
    )
      continue;
    const key = `${desktopPathKey(card.project)}:${card.owner ?? ""}:${card.department}:${card.parent ?? card.path}`;
    const group = standalone.get(key) ?? [];
    group.push(card);
    standalone.set(key, group);
  }
  for (const [id, rows] of standalone) {
    const card = rows[0]!;
    const state = departmentState(rows);
    groups.push({
      id,
      project: card.project,
      department: card.department,
      title: card.goal,
      ownerSessionId: card.owner,
      state,
      reason: state === "blocked" ? "任务失败，请查看执行会话和任务详情。" : undefined,
      cards: rows,
      workers: workersOf(rows),
    });
  }
  return groups;
}

export function ministerSessionInput(
  group: DepartmentGroup,
  workspaceId: string,
): WorkboardSessionInput | undefined {
  return group.flow && group.node?.ministerSessionId
    ? {
        kind: "minister",
        workspaceId,
        instanceId: group.flow.instance,
        nodeName: group.node.name,
        round: group.node.round,
      }
    : undefined;
}

export function sessionContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part: unknown) => {
      if (!part || typeof part !== "object") return [];
      const row = part as Record<string, unknown>;
      if (row.type === "text" && typeof row.text === "string") return [row.text];
      if (row.type === "toolCall" && typeof row.name === "string")
        return [`工具：${row.name}\n${JSON.stringify(row.arguments ?? {}, null, 2)}`];
      if (row.type === "image") return ["[图片附件]"];
      return [];
    })
    .join("\n\n");
}
