import { useEffect } from "react";

/**
 * PAO 只读视图的自动刷新间隔（波3 §2a）：画布/工作板打开期间 30s 轮询，
 * 卸载即停。拉模式＋轮询够用；事件推送是升级路径（见 flow-desktop.ts 的 ponytail 注释）。
 */
export const VIEW_AUTO_REFRESH_MS = 30_000;

/** 定时器注入面（window 结构满足；单测注入假定时器）。 */
export interface AutoRefreshTimers {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(timer: unknown): void;
}

/**
 * 启动 30s 轮询，返回停止函数。useViewAutoRefresh 把它接进 useEffect，
 * 卸载（切视图/切会话）即停（波3 §2a）。回调须自持竞速守卫（requestId 语义），
 * 静默刷新不闪 Loading。
 */
export function startViewAutoRefresh(
  refresh: () => void,
  timers: AutoRefreshTimers,
): () => void {
  const timer = timers.setInterval(refresh, VIEW_AUTO_REFRESH_MS);
  return () => timers.clearInterval(timer);
}

export function useViewAutoRefresh(refresh: () => void): void {
  useEffect(() => startViewAutoRefresh(refresh, window), [refresh]);
}
