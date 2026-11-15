import { expect, test } from "@playwright/test";
import type { KanbanCard, KanbanCardActivity } from "../../contracts/kanban";
import {
  kanbanActivitySignal,
  kanbanLeaseChip,
  kanbanSilenceMinutes,
} from "../../src/features/workboard/kanban-activity";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const MINUTE = 60_000;

function card(activity?: KanbanCardActivity): KanbanCard {
  return {
    path: "D:/p/卡1.md",
    project: "D:/p",
    number: 1,
    goal: "做事",
    department: "工程",
    status: "in_progress",
    acceptance: "检查",
    inputs: [],
    dependencies: [],
    priority: "medium",
    attempts: 3,
    created: "2026-10-05 10:00",
    body: "正文",
    receipts: [],
    executions: [],
    activity,
  };
}

function activity(over: Partial<KanbanCardActivity> = {}): KanbanCardActivity {
  return {
    owner: "owner-1",
    executionId: "exec-3",
    attempt: 3,
    registeredAt: new Date(NOW - 5 * MINUTE).toISOString(),
    lastOutputAt: new Date(NOW - 5 * MINUTE).toISOString(),
    running: true,
    silenceMinutes: 30,
    current: true,
    ...over,
  };
}

test("无当前信号、预警关闭、已停止都显式区分，不冒充正常", () => {
  expect(kanbanActivitySignal(card(), NOW)).toBe("unknown");
  expect(kanbanActivitySignal(card(activity({ current: false })), NOW)).toBe("unknown");
  expect(kanbanActivitySignal(card(activity({ silenceMinutes: 0 })), NOW)).toBe("off");
  expect(kanbanActivitySignal(card(activity({ running: false })), NOW)).toBe("unknown");
  expect(kanbanActivitySignal(card(activity({ lastOutputAt: "坏时间" })), NOW)).toBe("unknown");
});

test("amber 只在静默达到现读阈值时出现；最近输出缺失按登记时间算", () => {
  expect(
    kanbanActivitySignal(
      card(activity({ lastOutputAt: new Date(NOW - 29 * MINUTE).toISOString() })),
      NOW,
    ),
  ).toBe("active");
  expect(
    kanbanActivitySignal(
      card(activity({ lastOutputAt: new Date(NOW - 30 * MINUTE).toISOString() })),
      NOW,
    ),
  ).toBe("stale");
  expect(
    kanbanActivitySignal(
      card(
        activity({
          lastOutputAt: undefined,
          registeredAt: new Date(NOW - 31 * MINUTE).toISOString(),
        }),
      ),
      NOW,
    ),
  ).toBe("stale");
  expect(
    kanbanSilenceMinutes(
      card(activity({ lastOutputAt: new Date(NOW - 31.9 * MINUTE).toISOString() })),
      NOW,
    ),
  ).toBe(31);
});

test("租约占位：无字段不出芯片，有到期/接管如实亮 amber，到期只报事实不改状态", () => {
  // 没有活性、或旧登记没有租约字段：不出租约芯片（unknown 兜底，不冒充）。
  expect(kanbanLeaseChip(card(), NOW)).toBeUndefined();
  expect(kanbanLeaseChip(card(activity()), NOW)).toBeUndefined();
  // 有租约到期：未到期＝事实展示；已到期＝报「已到期」事实，不触发任何状态变更。
  expect(
    kanbanLeaseChip(
      card(activity({ leaseExpiresAt: new Date(NOW + 10 * MINUTE).toISOString() })),
      NOW,
    ),
  ).toEqual({ takenOver: false, expired: false, leaseExpiresAt: new Date(NOW + 10 * MINUTE).toISOString() });
  expect(
    kanbanLeaseChip(
      card(activity({ leaseExpiresAt: new Date(NOW - 1 * MINUTE).toISOString() })),
      NOW,
    ),
  ).toEqual({ takenOver: false, expired: true, leaseExpiresAt: new Date(NOW - 1 * MINUTE).toISOString() });
  // 接管标记优先于到期展示。
  expect(
    kanbanLeaseChip(card(activity({ leaseExpiresAt: "坏时间", takenOver: true })), NOW),
  ).toEqual({ takenOver: true, expired: false, leaseExpiresAt: "坏时间" });
  // 到期时间不可解析：只展示原值，不推断已到期。
  expect(
    kanbanLeaseChip(card(activity({ leaseExpiresAt: "坏时间" })), NOW),
  ).toEqual({ takenOver: false, expired: false, leaseExpiresAt: "坏时间" });
});
