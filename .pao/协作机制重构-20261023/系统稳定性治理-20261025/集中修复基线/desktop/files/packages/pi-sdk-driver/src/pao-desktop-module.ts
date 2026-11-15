import type * as PaoDesktopExports from "@earendil-works/pi-coding-agent/pao/desktop";

export type PaoDesktopModule = typeof PaoDesktopExports;

/**
 * 桌面桥统一从 PAO 的公开入口加载。Node 的原生 ESM 模块缓存会复用同一模块实例，
 * 因而继续与桌面会话内置扩展共享 owner 表；这里不再维护第二层 Promise 缓存。
 */
export function loadPaoDesktopModule(): Promise<PaoDesktopModule> {
  return import("@earendil-works/pi-coding-agent/pao/desktop");
}
