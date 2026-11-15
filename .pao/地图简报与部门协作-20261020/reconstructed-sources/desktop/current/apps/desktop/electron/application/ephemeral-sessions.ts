/**
 * 一次性主控会话（ephemeral）的纯函数层（波3 §1）。
 *
 * 背景：扩展视图「新建专属主控对话」每击一次就建一个持久会话，堆积在会话列表。
 * 语义：带 ephemeralFor 键的会话草稿 → 复用守卫（同键会话还在就切过去，不新建）
 * ＋关闭即删（归档手势升级为真删除）＋启动清扫（名下工作流全部终态的才删）。
 *
 * 登记表是 sessionKey → ephemeralFor 键（来源会话 id），随 ui-state 持久化；
 * 复用/清扫判据都在这里做成纯函数，app-store 与启动清扫共用同一套口径。
 * 注意 sessionKey 的 workspaceId 就是工作区路径（Windows 下含冒号），绝不反解键串，
 * 一律从工作区会话清单正向查登记。
 */
import { sessionKey, type SessionRef } from "@pi-gui/session-driver";

/** 复用守卫的最小会话面：登记与归档判定只需要这两个字段。 */
export interface EphemeralSessionRow {
  readonly id: string;
  readonly archivedAt?: string;
}

export interface EphemeralWorkspaceRow {
  readonly id: string;
  readonly sessions: readonly EphemeralSessionRow[];
}

/** 复用守卫：同 workspace 内登记过同 ephemeralFor 键、会话仍在且未归档 → 复用它。 */
export function findReusableEphemeralSession(
  workspaces: readonly EphemeralWorkspaceRow[],
  registry: ReadonlyMap<string, string>,
  workspaceId: string,
  ephemeralFor: string,
): SessionRef | undefined {
  const sessions = workspaces.find((workspace) => workspace.id === workspaceId)?.sessions ?? [];
  for (const session of sessions) {
    if (session.archivedAt) continue;
    if (registry.get(sessionKey({ workspaceId, sessionId: session.id })) === ephemeralFor) {
      return { workspaceId, sessionId: session.id };
    }
  }
  return undefined;
}

/** 控制正本一行的最小投影：owner 会话 id ＋ 实例状态（中文值域：运行中/挂起/已完成）。 */
export interface EphemeralOwnerFlow {
  readonly owner: string;
  readonly status: string;
}

/** 终态口径：内核 v2 控制正本只有 运行中/挂起/已完成，终态＝已完成（挂起不算终态）。 */
const TERMINAL_FLOW_STATUS = "已完成";

/**
 * 启动清扫计划：登记在册、名下存在实例且全部终态的会话才删。
 * 工作流数据读不到的 workspace（失联/清单损坏）整个跳过＝不删，宁漏勿误；
 * 名下没有任何实例（从未启动工作流）＝不删，可能还有对齐中的对话内容。
 */
export function ephemeralSweepPlan(
  workspaces: readonly EphemeralWorkspaceRow[],
  registry: ReadonlyMap<string, string>,
  flowsByWorkspace: ReadonlyMap<string, readonly EphemeralOwnerFlow[] | undefined>,
): SessionRef[] {
  const doomed: SessionRef[] = [];
  for (const workspace of workspaces) {
    const flows = flowsByWorkspace.get(workspace.id);
    if (!flows) continue; // 数据不可读：保留，等下次启动再判。
    for (const session of workspace.sessions) {
      if (!registry.has(sessionKey({ workspaceId: workspace.id, sessionId: session.id }))) continue;
      const owned = flows.filter((flow) => flow.owner === session.id);
      if (owned.length === 0) continue; // 从未启动工作流：保留。
      if (owned.every((flow) => flow.status === TERMINAL_FLOW_STATUS)) {
        doomed.push({ workspaceId: workspace.id, sessionId: session.id });
      }
    }
  }
  return doomed;
}
