import { expect, test } from "@playwright/test";
import { createEmptyDesktopAppState, type DesktopAppState } from "../../contracts/desktop-state";
import type { SessionControlTurn, SessionControlOwners } from "../../electron/ipc/session-control";
import { createSessionControlCoordinator } from "../../electron/ipc/session-control";

/** 控制协调器：幂等首账、查询恢复、dispatch/confirm 转 owner 会话文本（设计包 §2.3/§3）。 */

const target = { workspaceId: "ws-a", sessionId: "session-a" };

function stateWithSession(
  overrides: Partial<{ status: string; cancellationRequested: boolean }> = {},
): DesktopAppState {
  const state = createEmptyDesktopAppState();
  return {
    ...state,
    workspaces: [
      {
        id: "ws-a",
        name: "ws-a",
        path: "/tmp/ws-a",
        lastOpenedAt: new Date().toISOString(),
        kind: "primary" as const,
        sessions: [
          {
            id: "session-a",
            title: "Session A",
            updatedAt: new Date().toISOString(),
            preview: "",
            status: (overrides.status ?? "idle") as never,
            cancellationRequested: overrides.cancellationRequested,
            hasUnseenUpdate: false,
          },
        ],
      },
    ],
  };
}

interface Harness {
  submitCalls: string[];
  cancelCalls: number;
  owners: SessionControlOwners;
  turn: SessionControlTurn;
  state: DesktopAppState;
}

function harness(initialState: DesktopAppState): Harness {
  const harness: Harness = {
    submitCalls: [],
    cancelCalls: 0,
    state: initialState,
    owners: undefined as never,
    turn: undefined as never,
  };
  harness.owners = {
    submitComposer: async (_target, text) => {
      harness.submitCalls.push(text);
      // 既有消息链受理即起跑：状态进入 running，供回执 controlState 推导。
      harness.state = stateWithSession({ status: "running" });
      return harness.state;
    },
    addComposerAttachments: async () => harness.state,
    cancelCurrentRun: async () => {
      harness.cancelCalls += 1;
      return harness.state;
    },
  };
  harness.turn = {
    runQueued: (action) => action(),
    runNow: (action) => action(),
    readState: async () => harness.state,
  };
  return harness;
}

test("幂等：同 requestId 两次 send，底层恰调一次，第二次返回首账", async () => {
  const h = harness(stateWithSession());
  const coordinator = createSessionControlCoordinator(h.owners);
  const first = await coordinator.handle(
    { target, requestId: "req-1", action: { kind: "send", text: "hello" } },
    h.turn,
  );
  const second = await coordinator.handle(
    { target, requestId: "req-1", action: { kind: "send", text: "hello" } },
    h.turn,
  );

  expect(h.submitCalls).toEqual(["hello"]);
  expect(first.accepted).toBe(true);
  expect(second.accepted).toBe(true);
  expect(second.requestId).toBe("req-1");
  expect(second.controlState).toBe("executing");
  expect(second.state).toBe(h.state);
});

test("幂等与状态面：cancel 受理后回执呈停止中/已停止，重复 cancel 不重发", async () => {
  const h = harness(stateWithSession({ status: "running", cancellationRequested: true }));
  const coordinator = createSessionControlCoordinator(h.owners);
  const response = await coordinator.handle(
    { target, requestId: "stop-1", action: { kind: "cancel" } },
    h.turn,
  );
  expect(h.cancelCalls).toBe(1);
  // cancel 走 immediate；回执按当前真相推导（未决取消 → 停止中）。
  expect(response.controlState).toBe("stopping");

  const repeat = await coordinator.handle(
    { target, requestId: "stop-1", action: { kind: "cancel" } },
    h.turn,
  );
  expect(h.cancelCalls).toBe(1);
  expect(repeat.accepted).toBe(true);

  // 落定后：idle＋最近一次取消匹配完成 → 已停止。
  h.state = stateWithSession({ status: "idle", cancellationRequested: false });
  const settled = await coordinator.handle(
    { target, requestId: "stop-1", action: { kind: "cancel" } },
    h.turn,
  );
  expect(settled.controlState).toBe("stopped");
});

test("查证恢复：query 命中在途账与已落定账；账丢失呈未知", async () => {
  // 在途：runQueued 挂起，send 已记账未完成。
  const h = harness(stateWithSession({ status: "idle" }));
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inFlightTurn: SessionControlTurn = {
    runQueued: async (action) => {
      await gate;
      return action();
    },
    runNow: (action) => action(),
    readState: async () => h.state,
  };
  const coordinator = createSessionControlCoordinator(h.owners);
  const pending = coordinator.handle(
    { target, requestId: "req-9", action: { kind: "send", text: "later" } },
    inFlightTurn,
  );

  // invoke「尚未返回」时查账：已受理。
  const probed = await coordinator.handle(
    { target, requestId: "probe-1", action: { kind: "query", requestId: "req-9" } },
    h.turn,
  );
  expect(probed.accepted).toBe(true);
  expect(probed.controlState).toBe("receiving");

  release();
  const done = await pending;
  expect(done.accepted).toBe(true);

  // 落定后查账：已完成。
  const settledProbe = await coordinator.handle(
    { target, requestId: "probe-2", action: { kind: "query", requestId: "req-9" } },
    h.turn,
  );
  expect(settledProbe.accepted).toBe(true);

  // 账丢失（重启）：accepted:false；以文件/驱动真相重建（此处会话已空闲），控制态呈「未知」。
  h.state = stateWithSession({ status: "idle", cancellationRequested: false });
  const unknown = await coordinator.handle(
    { target, requestId: "probe-3", action: { kind: "query", requestId: "missing" } },
    h.turn,
  );
  expect(unknown.accepted).toBe(false);
  expect(unknown.reason).toContain("No control request is recorded");
  expect(unknown.controlState).toBe("未知");
});

test("查证恢复：执行抛错记账 rejected，query 返回失败账且不重发", async () => {
  const h = harness(stateWithSession());
  h.owners = {
    ...h.owners,
    cancelCurrentRun: async () => {
      throw new Error("driver gone");
    },
  };
  const coordinator = createSessionControlCoordinator(h.owners);
  const failed = await coordinator.handle(
    { target, requestId: "stop-2", action: { kind: "cancel" } },
    h.turn,
  );
  expect(failed.accepted).toBe(false);
  expect(failed.reason).toBe("driver gone");

  const probe = await coordinator.handle(
    { target, requestId: "probe-4", action: { kind: "query", requestId: "stop-2" } },
    h.turn,
  );
  expect(probe.accepted).toBe(false);
  expect(probe.reason).toBe("driver gone");

  // 重投同一 requestId：仍返回首账（拒绝账），底层不再被调。
  const repeat = await coordinator.handle(
    { target, requestId: "stop-2", action: { kind: "cancel" } },
    h.turn,
  );
  expect(repeat.accepted).toBe(false);
  expect(repeat.reason).toBe("driver gone");
});

test("dispatch/confirm 转成 owner 会话 send 文本，桌面零写卡", async () => {
  const h = harness(stateWithSession());
  const coordinator = createSessionControlCoordinator(h.owners);

  const dispatched = await coordinator.handle(
    {
      target,
      requestId: "d-1",
      action: { kind: "dispatch", cardGoal: "登录页重构", dispatchReason: "P0 缺陷" },
    },
    h.turn,
  );
  expect(dispatched.accepted).toBe(true);
  expect(h.submitCalls).toHaveLength(1);
  expect(h.submitCalls[0]).toContain("登录页重构");
  expect(h.submitCalls[0]).toContain("P0 缺陷");
  expect(h.submitCalls[0]).toContain("pao_dispatch_card");

  const confirmed = await coordinator.handle(
    { target, requestId: "c-1", action: { kind: "confirm", cardRef: "card-9", basis: "全绿" } },
    h.turn,
  );
  expect(confirmed.accepted).toBe(true);
  expect(h.submitCalls).toHaveLength(2);
  expect(h.submitCalls[1]).toContain("card-9");
  expect(h.submitCalls[1]).toContain("全绿");
});

test("无会话记录时的控制态按「未知」处理", async () => {
  const h = harness(createEmptyDesktopAppState());
  const coordinator = createSessionControlCoordinator(h.owners);
  const response = await coordinator.handle(
    { target, requestId: "q-1", action: { kind: "query" } },
    h.turn,
  );
  expect(response.controlState).toBe("未知");
  expect(response.accepted).toBe(true);
});
