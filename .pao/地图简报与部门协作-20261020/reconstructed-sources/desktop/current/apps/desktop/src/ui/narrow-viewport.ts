import { useSyncExternalStore } from "react";

/**
 * 窄窗断点。三处以它为准，必须是同一个数字：
 * `styles/task-status.css` 的 `@media (max-width: 980px)`（右侧坞 320px 上限）、
 * 工作台手柄的宽度上限、以及「窄窗默认收起右侧坞」。
 */
export const NARROW_VIEWPORT_WIDTH = 980;

function subscribe(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

/**
 * 直接读 `innerWidth`：真窗口拖动和测试里的视口变更都会触发 `resize`，
 * 不依赖媒体查询在模拟视口下是否跟着变。
 */
function getSnapshot(): boolean {
  return window.innerWidth <= NARROW_VIEWPORT_WIDTH;
}

/** 视口是否窄到需要把宽度让给主区；跨过断点时立刻反映。 */
export function useNarrowViewport(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
