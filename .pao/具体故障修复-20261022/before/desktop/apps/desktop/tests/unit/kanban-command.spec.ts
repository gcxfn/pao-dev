import { expect, test } from "@playwright/test";
import type { KanbanCard, KanbanCardStatus } from "../../contracts/kanban";
import {
  buildCancelCommand,
  buildTerminateCommand,
  canPrepareCancel,
  canPrepareTerminate,
  cardRefNumber,
  formatCardNumber,
  kanbanDropAction,
} from "../../src/features/workboard/kanban-command";

function card(status: KanbanCardStatus): KanbanCard {
  return {
    path: "D:/项目/.pao/卡/卡0017-修复退出.md",
    project: "D:/项目",
    number: 17,
    goal: "修退出",
    department: "工程",
    status,
    acceptance: "检查",
    inputs: [],
    dependencies: [],
    priority: "medium",
    attempts: 2,
    created: "2026-10-05 10:00",
    body: "正文",
    receipts: [],
    executions: [],
  };
}

test("终态不给取消，只有进行中给终止", () => {
  expect(canPrepareCancel(card("unclaimed"))).toBe(true);
  expect(canPrepareCancel(card("in_progress"))).toBe(true);
  expect(canPrepareCancel(card("delivered"))).toBe(false);
  expect(canPrepareCancel(card("failed"))).toBe(true);
  expect(canPrepareCancel(card("canceled"))).toBe(false);
  expect(canPrepareTerminate(card("in_progress"))).toBe(true);
  expect(canPrepareTerminate(card("unclaimed"))).toBe(false);
});

test("卡号规则单源：格式化与解析互逆，不认的引用按缺卡处理", () => {
  expect(formatCardNumber(17)).toBe("卡0017");
  expect(cardRefNumber("卡0017")).toBe(17);
  expect(cardRefNumber("卡0000")).toBe(0);
  expect(cardRefNumber(" 卡0017 ")).toBe(17);
  expect(cardRefNumber(formatCardNumber(42))).toBe(42);
  expect(cardRefNumber("卡#17")).toBeUndefined();
  expect(cardRefNumber("17")).toBeUndefined();
  expect(cardRefNumber("junk")).toBeUndefined();
});

test("生成的指令带齐卡路径/卡号/项目/状态与尝试，且只指向合法主控工具", () => {
  const target = card("in_progress");
  const cancel = buildCancelCommand(target);
  for (const text of [
    "pao_change_status",
    '"new_status":"canceled"',
    "D:/项目/.pao/卡/卡0017-修复退出.md",
    "D:/项目",
    "in_progress / 2",
    '"cards_dir":"D:/项目/.pao/卡",',
    '"card_ref":"卡0017"',
    '"operator":"用户"',
    '"basis":"看板发起取消请求',
    formatCardNumber(17),
  ])
    expect(cancel).toContain(text);
  expect(cancel).not.toContain("pao_terminate_card");

  const terminate = buildTerminateCommand(target);
  expect(terminate).toContain("pao_terminate_card");
  expect(terminate).toContain("pao_inventory");
  expect(terminate).toContain("卡号在本会话的运行中条目唯一");
  expect(terminate).toContain('"card_ref":"卡0017"');
  expect(terminate).toContain('"cards_dir":"D:/项目/.pao/卡"');
  expect(terminate).toContain("D:/项目/.pao/卡/卡0017-修复退出.md");
  expect(terminate).toContain("不按项目/卡目录过滤");
  expect(terminate).not.toContain("pao_change_status");
});

test("拖放目标裁决：只有「取消」可执行，拖到已交付点名验收链，同列不动", () => {
  const waiting = card("unclaimed");
  const running = card("in_progress");
  const done = card("delivered");
  // 非终态卡拖进取消列＝用户取消（内核白名单允许的操作者动作）。
  expect(kanbanDropAction("canceled", waiting)).toEqual({ kind: "cancel" });
  expect(kanbanDropAction("canceled", running)).toEqual({ kind: "cancel" });
  expect(kanbanDropAction("canceled", card("failed"))).toEqual({ kind: "cancel" });
  // 拖到已交付＝绕过验收：显式拒绝，理由点名验收链（不静默不动）。
  const toDone = kanbanDropAction("delivered", running);
  expect(toDone.kind).toBe("rejected");
  if (toDone.kind === "rejected") expect(toDone.reason).toContain("验收");
  // 拖到其他列／原列：无合法迁移，拒绝并说明只支持取消。
  for (const target of ["unclaimed", "in_progress", "failed"] as const) {
    const verdict = kanbanDropAction(target, waiting);
    expect(verdict.kind).toBe("rejected");
    if (verdict.kind === "rejected") expect(verdict.reason.length).toBeGreaterThan(0);
  }
  // 终态卡拖进取消列：内核状态机会拒（终态无出边），拖放层同样不发起。
  expect(kanbanDropAction("canceled", done).kind).toBe("rejected");
  expect(kanbanDropAction("canceled", card("canceled")).kind).toBe("rejected");
});
