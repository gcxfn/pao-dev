import { expect, test } from "@playwright/test";
import type { WorkspaceSessionTarget } from "../../contracts/desktop-state";
import { composerSubmitNeedsSenderView } from "../../contracts/composer-commands";
import type { SessionControlRequest } from "../../contracts/ipc";
import { sessionControlQueueLane } from "../../electron/ipc/session-control";
import { SerializedActionQueue } from "../../electron/windows/action-queue";

/**
 * 单一控制入口写路径的队列分流回归（真机 P0-2026-10-05）：
 * sessionControl 曾把 send 无条件压进窗口串行动作队列，而普通 prompt 在驱动层
 * await 整个 turn（pi 的 agent_settled 在 prompt() 内部才到达），一次发送就把队列
 * 占死整个 run 时长——期间所有走队列的按钮全部无响应（对话进行中点任何按钮没反应）。
 * 修后规则与旧 submitComposer 通道一致：普通 prompt 走 immediate 不占队列，
 * 只有可能改选中会话的 "/" 本地或扩展命令文本才允许占队列。
 */

const target = { workspaceId: "ws-a", sessionId: "session-a" };

function request(action: SessionControlRequest["action"]): SessionControlRequest {
  return { target, requestId: "req-1", action };
}

/** 复用旧通道的同一判定（会话命令未知态：任何 "/" 文本都视为可能改选中）。 */
const legacyPredicate = (_target: WorkspaceSessionTarget, text: string) =>
  composerSubmitNeedsSenderView(text, undefined, undefined);

test("普通 prompt 的 send 不占队列（P0 回归钉：修复前无条件 queued 占死队列整个 run）", () => {
  expect(
    sessionControlQueueLane(request({ kind: "send", text: "fix the build" }), legacyPredicate),
  ).toBe("immediate");
  expect(
    sessionControlQueueLane(
      request({ kind: "send", text: "继续", deliverAs: "followUp" }),
      legacyPredicate,
    ),
  ).toBe("immediate");
});

test("「/」文本在会话命令未知时保持占队列（可能改选中，与旧通道一致）", () => {
  expect(
    sessionControlQueueLane(request({ kind: "send", text: "/compact" }), legacyPredicate),
  ).toBe("queued");
});

test("dispatch/confirm/cancel/query 一律不占队列", () => {
  expect(
    sessionControlQueueLane(request({ kind: "dispatch", 卡目标: "登录页重构" }), legacyPredicate),
  ).toBe("immediate");
  expect(
    sessionControlQueueLane(request({ kind: "confirm", 卡引用: "CARD-1" }), legacyPredicate),
  ).toBe("immediate");
  expect(sessionControlQueueLane(request({ kind: "cancel" }), legacyPredicate)).toBe("immediate");
  expect(sessionControlQueueLane(request({ kind: "query" }), legacyPredicate)).toBe("immediate");
});

test("机制钉：一个永不落定的排队动作卡死串行队列，immediate 路径不受影响", async () => {
  const queue = new SerializedActionQueue();
  let releaseHeld!: () => void;
  const held = new Promise<string>((resolve) => {
    releaseHeld = () => resolve("held-settled");
  });
  const holder = queue.run(() => held);

  // 占住队列后，后续排队动作在占位动作落定前不会开始。
  let queuedRan = false;
  const queuedSecond = queue.run(async () => {
    queuedRan = true;
    return "queued-settled";
  });
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(queuedRan).toBe(false);

  // immediate（不经队列）路径不受占位动作影响，仍能立即执行——这正是普通 prompt
  // 必须走 immediate 的原因：运行进行中其他按钮（都走队列）才有响应。
  let immediateRan = false;
  const immediate = (async () => {
    immediateRan = true;
    return "immediate-settled";
  })();
  expect(await immediate).toBe("immediate-settled");

  releaseHeld();
  expect(await holder).toBe("held-settled");
  expect(await queuedSecond).toBe("queued-settled");
  expect(queuedRan).toBe(true);
});
