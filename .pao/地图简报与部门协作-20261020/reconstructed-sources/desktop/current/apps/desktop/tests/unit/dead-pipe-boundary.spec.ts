import { EventEmitter, type EventEmitter as NodeEventEmitter } from "node:events";
import { expect, test } from "@playwright/test";
import {
  DEAD_PIPE_ERROR_CODES,
  installDeadPipeBoundary,
  isDeadPipeError,
} from "../../electron/platform/dead-pipe";

/**
 * 主进程断管边界（W-bug7）：语义对齐内核 interactive-mode DEAD_TERMINAL_ERROR_CODES。
 * 口径正本：PAO/packages/coding-agent/src/modes/interactive/interactive-mode.ts
 * （本地复刻钉定——内核改集合措辞不会使本用例变红，改内核时须两处同步）。
 */

function makeFakeStream(): NodeEventEmitter & { write(): boolean } {
  return Object.assign(new EventEmitter(), { write: () => true });
}

function errWithCode(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`synthetic ${code}`), { code });
}

test("死终端错误码集合与内核口径一致（EIO/EPIPE/ENOTCONN）", () => {
  expect([...DEAD_PIPE_ERROR_CODES].sort()).toEqual(["EIO", "ENOTCONN", "EPIPE"]);
  expect(isDeadPipeError(errWithCode("EPIPE"))).toBe(true);
  expect(isDeadPipeError(errWithCode("EIO"))).toBe(true);
  expect(isDeadPipeError(errWithCode("ENOTCONN"))).toBe(true);
  expect(isDeadPipeError(errWithCode("EACCES"))).toBe(false);
  expect(isDeadPipeError(new Error("no code"))).toBe(false);
  expect(isDeadPipeError(undefined)).toBe(false);
  expect(isDeadPipeError("EPIPE")).toBe(false);
});

test("预期断管（EPIPE/EIO/ENOTCONN）被边界吸收，不进入未处理异常", async () => {
  const stdout = makeFakeStream();
  const stderr = makeFakeStream();
  const unexpected: Error[] = [];
  const boundary = installDeadPipeBoundary({
    streams: [stdout, stderr],
    onUnexpected: (error) => unexpected.push(error),
  });
  try {
    for (const code of ["EPIPE", "EIO", "ENOTCONN"]) {
      expect(() => stdout.emit("error", errWithCode(code))).not.toThrow();
      expect(() => stderr.emit("error", errWithCode(code))).not.toThrow();
    }
    // 生产语义：写失败在 nextTick 里异步 emit error；处理器若抛出会成为 uncaughtException。
    await new Promise<void>((resolve) => {
      queueMicrotask(() => {
        stdout.emit("error", errWithCode("EPIPE"));
        resolve();
      });
    });
    expect(unexpected).toEqual([]);
  } finally {
    boundary.dispose();
  }
});

test("流上的非断管错误仍冒出：处理器 rethrow，经顶层 uncaughtException 交给 onUnexpected", () => {
  const stdout = makeFakeStream();
  const unexpected: Error[] = [];
  const boundary = installDeadPipeBoundary({
    streams: [stdout],
    onUnexpected: (error) => unexpected.push(error),
  });
  try {
    const boom = errWithCode("EACCES");
    // 注册的流错误处理器对非断管 rethrow（真实运行里落在事件循环顶层，不吞）。
    const handler = stdout.listeners("error").at(-1) as (error: Error) => void;
    expect(() => handler(boom)).toThrow(/synthetic EACCES/);
    // 顶层 uncaughtException 由边界转交 onUnexpected 呈现。
    boundary.handleUncaughtException(boom);
    expect(unexpected).toEqual([boom]);
  } finally {
    boundary.dispose();
  }
});

test("uncaughtException 形态的 EPIPE（Electron 内部通道路径）被吸收，不交给 onUnexpected", () => {
  const unexpected: Error[] = [];
  const before = process.listenerCount("uncaughtException");
  const boundary = installDeadPipeBoundary({
    streams: [makeFakeStream()],
    onUnexpected: (error) => unexpected.push(error),
  });
  try {
    expect(process.listenerCount("uncaughtException")).toBe(before + 1);
    expect(() => boundary.handleUncaughtException(errWithCode("EPIPE"))).not.toThrow();
    expect(unexpected).toEqual([]);
  } finally {
    boundary.dispose();
  }
});

test("uncaughtException 形态的非断管错误仍可见（交给 onUnexpected）", () => {
  const unexpected: Error[] = [];
  const boundary = installDeadPipeBoundary({
    streams: [makeFakeStream()],
    onUnexpected: (error) => unexpected.push(error),
  });
  try {
    const boom = Object.assign(new Error("boom"), { code: "ERR_ASSERTION" });
    boundary.handleUncaughtException(boom);
    expect(unexpected).toEqual([boom]);
  } finally {
    boundary.dispose();
  }
});

test("dispose 移除监听，流错误回到无人处理的默认可见行为", () => {
  const stream = makeFakeStream();
  const unexpected: Error[] = [];
  const before = process.listenerCount("uncaughtException");
  const boundary = installDeadPipeBoundary({
    streams: [stream],
    onUnexpected: (error) => unexpected.push(error),
  });
  expect(process.listenerCount("uncaughtException")).toBe(before + 1);
  boundary.dispose();
  expect(stream.listenerCount("error")).toBe(0);
  expect(process.listenerCount("uncaughtException")).toBe(before);
  // dispose 后流错误不再被处理：无人监听时 emit error 会抛出（Node 默认）。
  expect(() => stream.emit("error", errWithCode("EPIPE"))).toThrow(/EPIPE/);
});
