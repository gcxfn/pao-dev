/**
 * 一次性主控会话（波3 §1）纯函数单测：复用守卫＋启动清扫计划。
 * 防线核心是「只删自己登记的会话」与「数据不可读不删」——宁漏勿误。
 */
import { expect, test } from "@playwright/test";
import { sessionKey } from "@pi-gui/session-driver";
import {
  ephemeralSweepPlan,
  findReusableEphemeralSession,
  type EphemeralWorkspaceRow,
} from "../../electron/application/ephemeral-sessions";

/** workspaceId 就是工作区路径（Windows 下含冒号）：锁住「绝不反解 sessionKey」的口径。 */
const WS_A = "D:\\projects\\主项目";
const WS_B = "D:\\projects\\副项目";

function registryOf(entries: readonly { workspaceId: string; sessionId: string; key: string }[]) {
  return new Map(entries.map((row) => [sessionKey(row), row.key]));
}

function workspacesOf(
  rows: Readonly<Record<string, readonly { id: string; archivedAt?: string }[]>>,
): EphemeralWorkspaceRow[] {
  return Object.entries(rows).map(([id, sessions]) => ({ id, sessions }));
}

test("复用守卫：同键在册未归档才复用；归档/他工作区/未登记都不复用", () => {
  const workspaces = workspacesOf({
    [WS_A]: [
      { id: "s-live" },
      { id: "s-archived", archivedAt: "2026-10-01T00:00:00.000Z" },
      { id: "s-other-key" },
    ],
    [WS_B]: [{ id: "s-wrong-ws" }],
  });
  const registry = registryOf([
    { workspaceId: WS_A, sessionId: "s-live", key: "source-1" },
    { workspaceId: WS_A, sessionId: "s-archived", key: "source-archived" },
    { workspaceId: WS_A, sessionId: "s-other-key", key: "source-2" },
    { workspaceId: WS_B, sessionId: "s-wrong-ws", key: "source-1" },
  ]);

  // 登记同键且未归档 → 复用。
  expect(findReusableEphemeralSession(workspaces, registry, WS_A, "source-1")).toEqual({
    workspaceId: WS_A,
    sessionId: "s-live",
  });
  // 已归档（关闭即删路径刚跑完/中断残留）→ 不复用，走新建。
  expect(findReusableEphemeralSession(workspaces, registry, WS_A, "source-archived")).toBe(
    undefined,
  );
  // 同键在别的工作区登记的是另一个会话：sessionKey 含 workspaceId，各查各的。
  expect(findReusableEphemeralSession(workspaces, registry, WS_B, "source-1")).toEqual({
    workspaceId: WS_B,
    sessionId: "s-wrong-ws",
  });
  // 未登记任何键 → 新建。
  expect(findReusableEphemeralSession(workspaces, registry, WS_A, "source-unknown")).toBe(
    undefined,
  );
});

test("清扫计划：名下实例全部已完成才删；运行中/挂起/无实例/未登记/数据不可读一律保留", () => {
  const workspaces = workspacesOf({
    [WS_A]: [
      { id: "s-done" }, // 名下两个实例都已完成 → 删
      { id: "s-running" }, // 名下一个运行中 → 保留
      { id: "s-suspended" }, // 挂起不是终态 → 保留
      { id: "s-no-flows" }, // 从未启动工作流 → 保留
      { id: "s-normal" }, // 普通会话（未登记）→ 保留（防误删核心）
    ],
    [WS_B]: [{ id: "s-unreadable" }], // 工作流数据读不到 → 整工作区保留
  });
  const registry = registryOf([
    { workspaceId: WS_A, sessionId: "s-done", key: "k1" },
    { workspaceId: WS_A, sessionId: "s-running", key: "k2" },
    { workspaceId: WS_A, sessionId: "s-suspended", key: "k3" },
    { workspaceId: WS_A, sessionId: "s-no-flows", key: "k4" },
    { workspaceId: WS_B, sessionId: "s-unreadable", key: "k5" },
  ]);
  const flows = new Map([
    [
      WS_A,
      [
        { owner: "s-done", status: "已完成" },
        { owner: "s-done", status: "已完成" },
        { owner: "s-running", status: "已完成" },
        { owner: "s-running", status: "运行中" },
        { owner: "s-suspended", status: "挂起" },
        { owner: "s-normal", status: "已完成" }, // 普通会话的实例即使全终态，无登记也不删
      ],
    ],
  ]);

  expect(ephemeralSweepPlan(workspaces, registry, flows)).toEqual([
    { workspaceId: WS_A, sessionId: "s-done" },
  ]);
  // 数据不可读（flows 缺失）→ 空计划。
  expect(ephemeralSweepPlan(workspaces, registry, new Map())).toEqual([]);
});
