import type { KanbanCard } from "../../../contracts/kanban";

/**
 * 卡活性状态：
 * - stale：当前尝试在跑，但静默时间达到阈值；
 * - active：当前尝试在跑，阈值内还有输出（或刚登记）；
 * - off：静默阈值配成 0，预警关闭；
 * - unknown：没有当前尝试的活性信号（未派出/登记属于旧尝试/进程已停/时间不可解析）。
 */
export type KanbanActivitySignal = "stale" | "active" | "off" | "unknown";

function lastSignalAt(card: KanbanCard): number | undefined {
  const activity = card.activity;
  if (!activity) return undefined;
  const parsed = Date.parse(activity.lastOutputAt ?? activity.registeredAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * 预警只用同进程现读活性判断，不用卡时间兜底。
 * now 由调用方注入（毫秒）便于测试；阈值 0＝关，非当前尝试或已停止＝无信号。
 */
export function kanbanActivitySignal(card: KanbanCard, now: number): KanbanActivitySignal {
  const activity = card.activity;
  if (!activity || !activity.current) return "unknown";
  if (activity.silenceMinutes <= 0) return "off";
  if (!activity.running) return "unknown";
  const last = lastSignalAt(card);
  if (last === undefined) return "unknown";
  return now - last >= activity.silenceMinutes * 60_000 ? "stale" : "active";
}

/** 静默分钟数（向下取整，最小 0）；没有可解析的活性时间时返回 undefined。 */
export function kanbanSilenceMinutes(card: KanbanCard, now: number): number | undefined {
  const last = lastSignalAt(card);
  if (last === undefined) return undefined;
  return Math.max(0, Math.floor((now - last) / 60_000));
}

/**
 * 租约芯片占位事实（S5 包3 字段透传；amber/red 完整呈现与「旧代不覆盖」验收归 S7-B）。
 * 只报事实：到期不自动放权、不改任何状态；到期时间不可解析时按原值展示不推断已到期。
 */
export interface KanbanLeaseChip {
  /** 已被显式接管（原 worker 输出仅留档）。 */
  readonly takenOver: boolean;
  /** 租约已过到期时刻（不可解析时间恒为 false）。 */
  readonly expired: boolean;
  /** 到期时间原值（可能是不可解析字符串，原样展示）。 */
  readonly leaseExpiresAt: string;
}

/** 有租约事实（接管标记或到期时间）才出芯片；旧登记没有字段＝undefined，不冒充。 */
export function kanbanLeaseChip(card: KanbanCard, now: number): KanbanLeaseChip | undefined {
  const activity = card.activity;
  if (!activity) return undefined;
  if (activity.takenOver === undefined && activity.leaseExpiresAt === undefined) return undefined;
  const expiresAt = Date.parse(activity.leaseExpiresAt ?? "");
  return {
    takenOver: activity.takenOver === true,
    expired: Number.isFinite(expiresAt) && expiresAt <= now,
    leaseExpiresAt: activity.leaseExpiresAt ?? "",
  };
}

