import { expect, test } from "@playwright/test";
import { QuitSessionStopCoordinator } from "../../electron/lifecycle/quit-session-stop";

test("并发退出复用尚未结束的受管停止", async () => {
  const coordinator = new QuitSessionStopCoordinator();
  let starts = 0;
  let finish!: () => void;
  const stop = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const start = () => {
    starts += 1;
    return stop;
  };

  const first = coordinator.run(start);
  const concurrent = coordinator.run(start);
  expect(concurrent).toBe(first);
  finish();
  await first;

  expect(starts).toBe(1);
});

test("真实停止成功或失败后都清空缓存，下一次选择当前会话", async () => {
  const coordinator = new QuitSessionStopCoordinator();
  let starts = 0;
  const successful = coordinator.run(async () => {
    starts += 1;
  });
  await successful;
  await coordinator.run(async () => {
    starts += 1;
  });
  expect(starts).toBe(2);

  let reject!: (error: Error) => void;
  const failing = new Promise<void>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  const failed = coordinator.run(() => {
    starts += 1;
    return failing;
  });
  reject(new Error("stop failed"));
  await expect(failed).rejects.toThrow("stop failed");
  await coordinator.run(async () => {
    starts += 1;
  });
  expect(starts).toBe(4);
});

test("退出期限先失败时仍复用真实停止，结束后才允许下一次重查", async () => {
  const coordinator = new QuitSessionStopCoordinator();
  let starts = 0;
  let finish!: () => void;
  const stop = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const first = coordinator.run(() => {
    starts += 1;
    return stop;
  });
  await expect(
    Promise.race([first, Promise.reject(new Error("quit deadline expired"))]),
  ).rejects.toThrow("quit deadline expired");

  const retriedWhilePending = coordinator.run(() => {
    starts += 1;
    return Promise.resolve();
  });
  expect(retriedWhilePending).toBe(first);
  finish();
  await first;

  await coordinator.run(async () => {
    starts += 1;
  });
  expect(starts).toBe(2);
});
