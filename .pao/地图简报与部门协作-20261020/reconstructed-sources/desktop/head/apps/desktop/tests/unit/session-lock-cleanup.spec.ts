import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  cleanupDeadSessionLocks,
  planSessionLockCleanup,
  type SessionLockEntry,
} from "../../electron/platform/pao/session-lock-cleanup";

/** 桌面启动期死会话锁回收：决策纯函数＋目录执行（用户反馈的强杀残留锁卡启动场景）。 */

function ownerJson(pid: number): string {
  return JSON.stringify({
    token: "tok",
    sessionId: "sess",
    pid,
    surface: "desktop",
    acquiredAt: "2026-10-09T00:00:00.000Z",
  });
}

test("死锁组清、活锁组不动、损坏清、孤儿残渣不动", () => {
  const entries: SessionLockEntry[] = [
    { name: "dead.json", isDirectory: false, content: ownerJson(111) },
    { name: "dead.lock", isDirectory: true },
    { name: "dead.transaction.lock", isDirectory: true },
    { name: "live.json", isDirectory: false, content: ownerJson(222) },
    { name: "live.lock", isDirectory: true },
    { name: "corrupt.json", isDirectory: false, content: "{not json" },
    { name: "corrupt.lock", isDirectory: true },
    { name: "orphan.lock", isDirectory: true },
    { name: "notes.txt", isDirectory: false, content: "unrelated" },
  ];
  expect(planSessionLockCleanup(entries, new Set([222]))).toEqual([
    "dead.json",
    "dead.lock",
    "dead.transaction.lock",
    "corrupt.json",
    "corrupt.lock",
  ]);
  expect(planSessionLockCleanup([], new Set())).toEqual([]);
  // pid 复用为活进程：不清（宁可漏清不可误杀）。
  expect(planSessionLockCleanup(entries, new Set([111, 222]))).toEqual([
    "corrupt.json",
    "corrupt.lock",
  ]);
});

async function spawnExitedProcess(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  return child.pid as number;
}

test("cleanupDeadSessionLocks：死锁被删、活锁保留、PAO_HOME 缺失静默跳过", async () => {
  const home = await mkdtemp(join(tmpdir(), "pao-lock-cleanup-"));
  const dir = join(home, ".pao", "运行时锁");
  await mkdir(dir, { recursive: true });
  const deadPid = await spawnExitedProcess();
  await writeFile(join(dir, "dead.json"), ownerJson(deadPid), "utf8");
  await mkdir(join(dir, "dead.lock"));
  await mkdir(join(dir, "dead.transaction.lock"));
  await writeFile(join(dir, "live.json"), ownerJson(process.pid), "utf8");
  await mkdir(join(dir, "live.lock"));
  await writeFile(join(dir, "broken.json"), "{oops", "utf8");

  expect(await cleanupDeadSessionLocks(home)).toBe(4);
  expect(await readdir(dir)).toEqual(["live.json", "live.lock"]);

  // 再跑一遍幂等；缺失目录返回 0。
  expect(await cleanupDeadSessionLocks(home)).toBe(0);
  expect(await cleanupDeadSessionLocks(join(home, "no-such-home"))).toBe(0);
  expect(await cleanupDeadSessionLocks(undefined)).toBe(0);
});
