/**
 * 30s 视图自动刷新（波3 §2a）单测：间隔常量单点＋启动/停止接线。
 * 假定时器注入验证「启动注册 30s 间隔、停止清掉同一个句柄」——卸载不清就会留下
 * 悬空轮询（变异自证点：去掉 clearInterval 后 fail）。
 */
import { expect, test } from "@playwright/test";
import {
  startViewAutoRefresh,
  type AutoRefreshTimers,
  VIEW_AUTO_REFRESH_MS,
} from "../../src/ui/view-auto-refresh";

function fakeTimers() {
  const cleared: unknown[] = [];
  const started: { handler: () => void; ms: number }[] = [];
  let nextHandle = 1;
  const timers: AutoRefreshTimers & { readonly started: typeof started; readonly cleared: typeof cleared } = {
    setInterval(handler, ms) {
      started.push({ handler, ms });
      return nextHandle++;
    },
    clearInterval(timer) {
      cleared.push(timer);
    },
    started,
    cleared,
  };
  return timers;
}

test("间隔常量＝30s；启动注册间隔，停止清掉同一句柄", () => {
  expect(VIEW_AUTO_REFRESH_MS).toBe(30_000);
  const timers = fakeTimers();
  const refresh = () => {};
  const stop = startViewAutoRefresh(refresh, timers);
  expect(timers.started).toEqual([{ handler: refresh, ms: VIEW_AUTO_REFRESH_MS }]);
  expect(timers.cleared).toEqual([]);
  stop();
  expect(timers.cleared).toEqual([1]);
});
