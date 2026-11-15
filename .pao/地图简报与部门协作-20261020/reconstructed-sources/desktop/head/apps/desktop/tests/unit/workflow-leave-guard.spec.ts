/** 测试握手身份和取消语义；模拟窗口不是原生关闭证据。 */
import { EventEmitter } from "node:events";
import type { BrowserWindow, WebContents } from "electron";
import { expect, test } from "@playwright/test";
import { WorkflowLeaveGuard } from "../../electron/windows/workflow-leave-guard";

function fixture() {
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isCrashed: () => false,
    sent: [] as number[],
    send(_channel: string, id: number) {
      this.sent.push(id);
    },
  });
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents: contents,
  }) as unknown as BrowserWindow;
  return { contents, window };
}

test("重复请求共用选择，其他窗口和过期回执不能批准", async () => {
  const guard = new WorkflowLeaveGuard();
  const first = fixture();
  const other = fixture();
  const pending = guard.request(first.window);
  expect(guard.request(first.window)).toBe(pending);
  expect(first.contents.sent).toEqual([1]);
  guard.acknowledge(other.contents as unknown as WebContents, 1, true);
  guard.acknowledge(first.contents as unknown as WebContents, 2, true);
  expect(guard.request(first.window)).toBe(pending);
  guard.acknowledge(first.contents as unknown as WebContents, 1, false);
  expect(await pending).toBe(false);
  const next = guard.request(first.window);
  guard.acknowledge(first.contents as unknown as WebContents, 1, true);
  expect(guard.request(first.window)).toBe(next);
  guard.acknowledge(first.contents as unknown as WebContents, 2, true);
  expect(await next).toBe(true);
  expect(first.contents.listenerCount("destroyed")).toBe(0);
});

test("页面无响应时必须明确选择放弃才批准离开", async () => {
  const first = fixture();
  let answer!: (allowed: boolean) => void;
  let prompts = 0;
  const guard = new WorkflowLeaveGuard(() => {
    prompts++;
    return new Promise((resolve) => {
      answer = resolve;
    });
  });
  const pending = guard.request(first.window);
  first.window.emit("unresponsive");
  first.window.emit("unresponsive");
  expect(prompts).toBe(1);
  answer(false);
  expect(await pending).toBe(false);
  const next = guard.request(first.window);
  first.contents.emit("render-process-gone");
  answer(true);
  expect(await next).toBe(true);
});

test("渲染进程崩溃不批准；多窗口退出遇取消立即停止", async () => {
  const guard = new WorkflowLeaveGuard();
  const first = fixture();
  const second = fixture();
  const pending = guard.requestAll([first.window, second.window]);
  first.contents.emit("render-process-gone");
  expect(await pending).toBe(false);
  expect(second.contents.sent).toEqual([]);
  expect(first.contents.listenerCount("destroyed")).toBe(0);
});

test("窗口已无响应时并发请求共用一个原生选择", async () => {
  let prompts = 0;
  let answer!: (allowed: boolean) => void;
  const guard = new WorkflowLeaveGuard(() => {
    prompts++;
    return new Promise((resolve) => {
      answer = resolve;
    });
  });
  const first = fixture();
  guard.watch(first.window);
  first.window.emit("unresponsive");
  const a = guard.request(first.window);
  const b = guard.request(first.window);
  expect(a).toBe(b);
  expect(prompts).toBe(1);
  expect(first.contents.sent).toEqual([]);
  answer(false);
  expect(await a).toBe(false);
  expect(first.contents.listenerCount("destroyed")).toBe(0);
});

test("窗口已崩溃时并发请求共用一个原生选择", async () => {
  let prompts = 0;
  let answer!: (allowed: boolean) => void;
  const guard = new WorkflowLeaveGuard(() => {
    prompts++;
    return new Promise((resolve) => {
      answer = resolve;
    });
  });
  const first = fixture();
  first.contents.isCrashed = () => true;
  const a = guard.request(first.window);
  const b = guard.request(first.window);
  expect(a).toBe(b);
  expect(prompts).toBe(1);
  answer(true);
  expect(await a).toBe(true);
});

test("原生选择失败时显式按不批准处理，不抛出", async () => {
  const rejected = new WorkflowLeaveGuard(() => Promise.reject(new Error("no dialog")));
  const crashed = fixture();
  crashed.contents.isCrashed = () => true;
  expect(await rejected.request(crashed.window)).toBe(false);
  const thrown = new WorkflowLeaveGuard(() => {
    throw new Error("no dialog");
  });
  const other = fixture();
  other.contents.isCrashed = () => true;
  expect(await thrown.request(other.window)).toBe(false);
});
