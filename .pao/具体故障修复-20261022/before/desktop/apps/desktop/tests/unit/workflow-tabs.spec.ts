import { expect, test } from "@playwright/test";
import {
  controllerConflictProblem,
  reconcileWorkflowTabs,
  workflowTabsProblem,
  workflowTabsSessionIndex,
} from "../../electron/application/workflow-tabs";
import { workflowTabForSession } from "../../contracts/desktop-state";
import type {
  SessionRecord,
  WorkflowTabRecord,
  WorkspaceRecord,
} from "../../contracts/desktop-state";

function session(id: string, archivedAt?: string): SessionRecord {
  return {
    id,
    title: id,
    updatedAt: "2026-10-05T00:00:00.000Z",
    preview: "",
    status: "idle",
    hasUnseenUpdate: false,
    ...(archivedAt ? { archivedAt } : {}),
  };
}

function workspace(id: string, sessions: readonly SessionRecord[]): WorkspaceRecord {
  return {
    id,
    name: id,
    path: `D:/repo/${id}`,
    lastOpenedAt: "2026-10-05T00:00:00.000Z",
    kind: "primary",
    sessions,
  };
}

const tab = (overrides: Partial<WorkflowTabRecord> = {}): WorkflowTabRecord => ({
  id: "tab-1",
  workspaceId: "ws-a",
  title: "运行",
  mode: "runtime",
  ...overrides,
});

test("页签成员校验：未知 workspace、跨 workspace、确认后失联或归档 controller 都拒绝", () => {
  const workspaces = [
    workspace("ws-a", [session("s-1"), session("s-archived", "2026-10-01T00:00:00.000Z")]),
    workspace("ws-b", [session("s-b")]),
    workspace("ws-c", []),
  ];
  const index = workflowTabsSessionIndex(workspaces, new Set(["ws-a", "ws-b"]));

  expect(
    workflowTabsProblem([tab({ controller: { workspaceId: "ws-a", sessionId: "s-1" } })], index),
  ).toBeUndefined();
  expect(workflowTabsProblem([tab({ workspaceId: "ws-missing" })], index)).toContain(
    "workspace not found",
  );
  expect(
    workflowTabsProblem(
      [tab({ controller: { workspaceId: "ws-b", sessionId: "s-b" } })],
      index,
    ),
  ).toContain("another workspace");
  expect(
    workflowTabsProblem(
      [tab({ controller: { workspaceId: "ws-a", sessionId: "s-gone" } })],
      index,
    ),
  ).toContain("session not found");
  expect(
    workflowTabsProblem(
      [tab({ controller: { workspaceId: "ws-a", sessionId: "s-archived" } })],
      index,
    ),
  ).toContain("archived");
});

test("页签成员校验：会话列表暂未确认时保留 controller，不挡整表保存", () => {
  const workspaces = [workspace("ws-a", [])];
  const index = workflowTabsSessionIndex(workspaces, new Set());

  expect(
    workflowTabsProblem(
      [tab({ controller: { workspaceId: "ws-a", sessionId: "s-offline" } })],
      index,
    ),
  ).toBeUndefined();
});

test("恢复对账：只丢真的移除 workspace 的页签、解绑确认失效的 controller、回落激活项", () => {
  const workspaces = [workspace("ws-a", [session("s-1")])];
  const index = workflowTabsSessionIndex(workspaces, new Set(["ws-a"]));
  const live = tab({ id: "tab-live", controller: { workspaceId: "ws-a", sessionId: "s-1" } });
  const deadController = tab({
    id: "tab-dead",
    controller: { workspaceId: "ws-a", sessionId: "s-gone" },
    instanceName: "实例一",
    instancePath: "/p/.pao/工作流-安装-1/工作流实例-实例一.md",
  });
  const removedWorkspace = tab({ id: "tab-gone", workspaceId: "ws-z" });
  const editTab = tab({ id: "tab-edit", mode: "edit", recipeName: "安装" });

  const kept = reconcileWorkflowTabs(
    [live, deadController, removedWorkspace, editTab],
    "tab-gone",
    index,
  );
  expect(kept.workflowTabs.map((entry) => entry.id)).toEqual(["tab-live", "tab-dead", "tab-edit"]);
  expect(kept.workflowTabs[0]!.controller).toEqual({ workspaceId: "ws-a", sessionId: "s-1" });
  expect(kept.workflowTabs[1]!.controller).toBeUndefined();
  expect(kept.workflowTabs[1]!.instanceName).toBe("实例一");
  expect(kept.workflowTabs[1]!.instancePath).toBe("/p/.pao/工作流-安装-1/工作流实例-实例一.md");
  expect(kept.workflowTabs[2]!.recipeName).toBe("安装");
  expect(kept.activeWorkflowTabId).toBe("");

  // 只解绑 controller 不解绑页签：激活项本身还在时保持不动。
  expect(
    reconcileWorkflowTabs([live, deadController], "tab-dead", index).activeWorkflowTabId,
  ).toBe("tab-dead");

  const untouched = reconcileWorkflowTabs([live, editTab], "tab-edit", index);
  expect(untouched.workflowTabs.map((entry) => entry.id)).toEqual(["tab-live", "tab-edit"]);
  expect(untouched.workflowTabs[0]!.controller).toEqual({ workspaceId: "ws-a", sessionId: "s-1" });
  expect(untouched.activeWorkflowTabId).toBe("tab-edit");
});

test("恢复对账：workspace 仍登记但会话列表暂未确认时页签与 controller 原样保留", () => {
  const workspaces = [workspace("ws-offline", [])];
  const index = workflowTabsSessionIndex(workspaces, new Set());
  const offline = tab({
    id: "tab-offline",
    workspaceId: "ws-offline",
    controller: { workspaceId: "ws-offline", sessionId: "s-offline" },
    instanceName: "离线实例",
  });

  const kept = reconcileWorkflowTabs([offline], "tab-offline", index);
  expect(kept.workflowTabs.map((entry) => entry.id)).toEqual(["tab-offline"]);
  expect(kept.workflowTabs[0]!.controller).toEqual({
    workspaceId: "ws-offline",
    sessionId: "s-offline",
  });
  expect(kept.workflowTabs[0]!.instanceName).toBe("离线实例");
  expect(kept.activeWorkflowTabId).toBe("tab-offline");
});

test("恢复对账：确认过会话列表后，明确不存在或已归档才解绑 controller", () => {
  const workspaces = [
    workspace("ws-a", [session("s-archived", "2026-10-01T00:00:00.000Z")]),
  ];
  const index = workflowTabsSessionIndex(workspaces, new Set(["ws-a"]));
  const gone = tab({ id: "tab-gone", controller: { workspaceId: "ws-a", sessionId: "s-gone" } });
  const archived = tab({
    id: "tab-archived",
    controller: { workspaceId: "ws-a", sessionId: "s-archived" },
  });

  const kept = reconcileWorkflowTabs([gone, archived], "tab-archived", index);
  expect(kept.workflowTabs.map((entry) => entry.id)).toEqual(["tab-gone", "tab-archived"]);
  expect(kept.workflowTabs[0]!.controller).toBeUndefined();
  expect(kept.workflowTabs[1]!.controller).toBeUndefined();
  expect(kept.activeWorkflowTabId).toBe("tab-archived");
});

test("主控唯一性（S4-1）：同一会话被两个标签绑定（同 workspace）整表拒绝，跨 workspace 同 id 不算冲突", () => {
  const workspaces = [workspace("ws-a", [session("s-1")]), workspace("ws-b", [session("s-1")])];
  const index = workflowTabsSessionIndex(workspaces, new Set(["ws-a", "ws-b"]));
  const tabA = tab({ id: "tab-a", controller: { workspaceId: "ws-a", sessionId: "s-1" } });
  const tabADup = tab({ id: "tab-a-dup", controller: { workspaceId: "ws-a", sessionId: "s-1" } });
  const tabB = tab({
    id: "tab-b",
    workspaceId: "ws-b",
    controller: { workspaceId: "ws-b", sessionId: "s-1" },
  });

  // 跨项目同 sessionId 指向不同 workspace 的不同会话，不是重复绑定。
  expect(workflowTabsProblem([tabA, tabB], index)).toBeUndefined();
  expect(workflowTabsProblem([tabA, tabADup], index)).toContain("already bound");
});

test("恢复对账（S4-1）：遗留的重复绑定只保留首个，后来者解绑可重建", () => {
  const workspaces = [workspace("ws-a", [session("s-1")])];
  const index = workflowTabsSessionIndex(workspaces, new Set(["ws-a"]));
  const first = tab({ id: "tab-first", controller: { workspaceId: "ws-a", sessionId: "s-1" } });
  const second = tab({ id: "tab-second", controller: { workspaceId: "ws-a", sessionId: "s-1" } });

  const kept = reconcileWorkflowTabs([first, second], "tab-second", index);
  expect(kept.workflowTabs[0]!.controller).toEqual({ workspaceId: "ws-a", sessionId: "s-1" });
  expect(kept.workflowTabs[1]!.controller).toBeUndefined();
  expect(kept.activeWorkflowTabId).toBe("tab-second");
});

test("反查索引（S4-1②）：会话→标签从标签表派生，workspace 或 sessionId 不匹配都不命中", () => {
  const bound = tab({ id: "tab-a", controller: { workspaceId: "ws-a", sessionId: "s-1" } });
  const edit = tab({ id: "tab-b", mode: "edit", recipeName: "安装" });

  expect(
    workflowTabForSession([bound, edit], { workspaceId: "ws-a", sessionId: "s-1" })?.id,
  ).toBe("tab-a");
  expect(
    workflowTabForSession([bound, edit], { workspaceId: "ws-b", sessionId: "s-1" }),
  ).toBeUndefined();
  expect(
    workflowTabForSession([bound, edit], { workspaceId: "ws-a", sessionId: "s-2" }),
  ).toBeUndefined();
  expect(
    workflowTabForSession([edit], { workspaceId: "ws-a", sessionId: "s-1" }),
  ).toBeUndefined();
});

test("bind 前查重（S4-1①）：其他标签已绑定同一 controller 报冲突；重绑自身与不同会话不算", () => {
  const bound = tab({ id: "tab-a", controller: { workspaceId: "ws-a", sessionId: "s-1" } });

  expect(
    controllerConflictProblem([bound], "tab-b", { workspaceId: "ws-a", sessionId: "s-1" }),
  ).toContain("tab-a");
  expect(
    controllerConflictProblem([bound], "tab-a", { workspaceId: "ws-a", sessionId: "s-1" }),
  ).toBeUndefined();
  expect(
    controllerConflictProblem([bound], "tab-b", { workspaceId: "ws-b", sessionId: "s-1" }),
  ).toBeUndefined();
  expect(
    controllerConflictProblem([bound], "tab-b", { workspaceId: "ws-a", sessionId: "s-2" }),
  ).toBeUndefined();
});
