/**
 * 画布工作流页签的引用校验与对账（纯函数）。
 *
 * 页签的 workspaceId 与 controller 的 {workspaceId, sessionId} 都是持久化引用，
 * 写入前要确认它们指向真实存在、且未归档的会话；恢复与每次刷新用同一套规则对账，
 * 免得 ui-state.json 里留下打不开的死引用。
 *
 * 但「暂时联系不上」不等于「已经删除」：workspace 路径在启动时不可达（例如移动盘没挂上）
 * 时，它仍留在 catalog 里，只是会话列表读不出来。对账必须能区分这两种情况，
 * 否则会把用户的历史页签和 controller 绑定误删。判断依据是：
 * - registeredWorkspaceIds：catalog 里全部已登记 workspace，只有不在这里才是真的被移除；
 * - confirmedWorkspaceIds：本轮确认成功读到过会话列表的 workspace，没确认过就不能
 *   拿「列表里找不到」当作会话已删除。
 */
import type {
  SetWorkflowTabsInput,
  WorkflowTabRecord,
  WorkspaceRecord,
} from "../../contracts/desktop-state";

/** 对账只需要会话的两个事实：还在不在、是否已归档。 */
export interface WorkflowTabSessionRef {
  readonly id: string;
  readonly archivedAt?: string;
}

/** 对账依据。三份数据一起决定页签与 controller 的去留。 */
export interface WorkflowTabsSessionIndex {
  /** catalog 全量登记的 workspace；不含即视为已被明确移除。 */
  readonly registeredWorkspaceIds: ReadonlySet<string>;
  /** 本轮已确认成功读取过会话列表的 workspace。 */
  readonly confirmedWorkspaceIds: ReadonlySet<string>;
  /** 每个 workspace 当前记录的会话。 */
  readonly sessionsByWorkspace: ReadonlyMap<string, readonly WorkflowTabSessionRef[]>;
}

/** 从投影后的 workspace 记录建索引；confirmedWorkspaceIds 由调用方提供。 */
export function workflowTabsSessionIndex(
  workspaces: readonly WorkspaceRecord[],
  confirmedWorkspaceIds: ReadonlySet<string>,
): WorkflowTabsSessionIndex {
  return {
    registeredWorkspaceIds: new Set(workspaces.map((workspace) => workspace.id)),
    confirmedWorkspaceIds: new Set(confirmedWorkspaceIds),
    sessionsByWorkspace: new Map(
      workspaces.map((workspace) => [
        workspace.id,
        workspace.sessions.map(
          (session): WorkflowTabSessionRef => ({
            id: session.id,
            ...(session.archivedAt !== undefined ? { archivedAt: session.archivedAt } : {}),
          }),
        ),
      ]),
    ),
  };
}

/**
 * controller 失效的说明；未确认会话列表的 workspace 一律返回 undefined，
 * 保留原绑定等下次能确认时再判断。
 */
function controllerProblem(
  tab: WorkflowTabRecord,
  index: WorkflowTabsSessionIndex,
): string | undefined {
  const controller = tab.controller;
  if (!controller) {
    return undefined;
  }
  if (controller.workspaceId !== tab.workspaceId) {
    return `controller belongs to another workspace (${controller.workspaceId})`;
  }
  if (!index.confirmedWorkspaceIds.has(controller.workspaceId)) {
    return undefined;
  }
  const session = index.sessionsByWorkspace
    .get(controller.workspaceId)
    ?.find((entry) => entry.id === controller.sessionId);
  if (!session) {
    return `controller session not found (${controller.sessionId})`;
  }
  if (session.archivedAt) {
    return `controller session is archived (${controller.sessionId})`;
  }
  return undefined;
}

/**
 * bind/写入前查重（S4-1）：同一会话不得同时是两个标签的 controller。
 * 返回冲突说明（含已占用的标签 id）；自身重绑、跨 workspace 同 sessionId 不算冲突。
 */
export function controllerConflictProblem(
  tabs: readonly WorkflowTabRecord[],
  tabId: string,
  target: { readonly workspaceId: string; readonly sessionId: string },
): string | undefined {
  const conflict = tabs.find(
    (tab) =>
      tab.id !== tabId &&
      tab.controller?.workspaceId === target.workspaceId &&
      tab.controller.sessionId === target.sessionId,
  );
  return conflict
    ? `controller session is already bound to tab ${conflict.id} (${target.sessionId})`
    : undefined;
}

/**
 * 整表写入前的成员校验：返回第一条不满足的说明，全部通过时 undefined。
 * 只查真实成员，不查 JSON 形状——形状由 IPC 校验层负责。
 * 会话列表未确认的 workspace 跳过会话存在性检查，避免暂失联时把整表保存挡掉。
 * 同一 controller 会话出现在多个标签（同 workspace）时拒绝（S4-1 唯一性）。
 */
export function workflowTabsProblem(
  tabs: readonly WorkflowTabRecord[],
  index: WorkflowTabsSessionIndex,
): string | undefined {
  for (const tab of tabs) {
    if (!index.registeredWorkspaceIds.has(tab.workspaceId)) {
      return `workflow tab ${tab.id} workspace not found (${tab.workspaceId})`;
    }
    const problem = controllerProblem(tab, index);
    if (problem) {
      return `workflow tab ${tab.id} ${problem}`;
    }
    if (tab.controller) {
      const conflict = controllerConflictProblem(tabs, tab.id, tab.controller);
      if (conflict) return `workflow tab ${tab.id} ${conflict}`;
    }
  }
  return undefined;
}

/** 去掉 controller 绑定（可选字段，只能显式重建，不能靠 spread 删掉）。 */
function withoutController(tab: WorkflowTabRecord): WorkflowTabRecord {
  const { recipeName, instanceName, instancePath, selectedElementId } = tab;
  return {
    id: tab.id,
    workspaceId: tab.workspaceId,
    title: tab.title,
    mode: tab.mode,
    ...(recipeName !== undefined ? { recipeName } : {}),
    ...(instanceName !== undefined ? { instanceName } : {}),
    ...(instancePath !== undefined ? { instancePath } : {}),
    ...(selectedElementId !== undefined ? { selectedElementId } : {}),
  };
}

/**
 * 恢复与刷新时的对账：workspace 已被明确移除的页签整条丢掉；controller 失效
 * （跨 workspace、会话确认不存在或已归档）时只解绑 controller、页签本身保留；
 * workspace 仍登记但会话列表没确认时原样保留，激活项指向已丢掉的页签时回落空串。
 * 遗留的重复绑定（同 controller 会话在多个标签）只保留首个，后来者解绑可重建（S4-1）。
 */
export function reconcileWorkflowTabs(
  tabs: readonly WorkflowTabRecord[],
  activeWorkflowTabId: string,
  index: WorkflowTabsSessionIndex,
): Pick<SetWorkflowTabsInput, "workflowTabs" | "activeWorkflowTabId"> {
  const kept: WorkflowTabRecord[] = [];
  for (const tab of tabs) {
    if (!index.registeredWorkspaceIds.has(tab.workspaceId)) continue;
    const problem = controllerProblem(tab, index);
    const conflict =
      !problem && tab.controller
        ? controllerConflictProblem(kept, tab.id, tab.controller)
        : undefined;
    kept.push(problem || conflict ? withoutController(tab) : tab);
  }
  const workflowTabs = kept;
  return {
    workflowTabs,
    activeWorkflowTabId: workflowTabs.some((tab) => tab.id === activeWorkflowTabId)
      ? activeWorkflowTabId
      : "",
  };
}
