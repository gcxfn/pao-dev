import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { HostUiRequest } from "@pi-gui/session-driver";
import {
  formatSessionOwnerDetails,
  parseResidualSessionLockToken,
  sessionLockTakeoverCommand,
  appendSessionOwnerDetails,
} from "../../contracts/session-lock-notice";
import {
  enrichSessionLockOwnerEvent,
  enrichSessionLockOwnerMessage,
  readSessionLockOwnerByToken,
} from "../../electron/platform/pao/session-lock-owner";

/** 会话锁报错扩展（W-bug9）：旧 owner 详情展示＋显式接管入口共用契约。 */

const TOKEN = "39c64f0e-1c1b-4a8f-9d0a-6fb4c2a6f001";
/**
 * 内核通知的本地复刻钉定：notify 包装在 PAO/packages/coding-agent/src/pao/runtime/index.ts
 * （ctx.ui.notify），文案正本在同目录 runtime/session-lock.ts（残留锁三段文案）。
 * 内核措辞/错误码集合变更不会使本用例变红——改内核时须两处同步（有意不建跨仓校验）。
 */
function kernelResidualNotice(token: string): string {
  return (
    `会话只读：Error: 残留会话锁须显式接管，原控制标识：${token}` +
    `；残锁可用 /pao runtime takeover <原控制标识> 显式接管。`
  );
}

test("从内核残留锁报错中解析原控制标识", () => {
  expect(parseResidualSessionLockToken(kernelResidualNotice(TOKEN))).toBe(TOKEN);
  // 活锁与损坏锁文案不含可接管 token：不提供接管入口（活锁仍拒绝）。
  expect(
    parseResidualSessionLockToken(
      "会话只读：Error: 同会话已有控制方，拒绝同时驱动；残锁可用 /pao runtime takeover <原控制标识> 显式接管。",
    ),
  ).toBeUndefined();
  expect(
    parseResidualSessionLockToken("会话只读：Error: 会话锁身份损坏，拒绝自动接管。"),
  ).toBeUndefined();
  expect(parseResidualSessionLockToken("无关报错")).toBeUndefined();
});

test("接管命令复用内核 /pao runtime takeover 同链路", () => {
  expect(sessionLockTakeoverCommand(TOKEN)).toBe(`/pao runtime takeover ${TOKEN}`);
});

test("旧 owner 详情中文化：pid、宿主面、持有时间", () => {
  const details = formatSessionOwnerDetails({
    pid: 4242,
    surface: "desktop",
    acquiredAt: "2026-10-07T03:04:05.000Z",
  });
  expect(details).toContain("4242");
  expect(details).toContain("宿主面 desktop");
  expect(details).toContain("2026-10-07");
});

test("报错信息追加旧 owner 详情且幂等", () => {
  const owner = { pid: 4242, surface: "desktop", acquiredAt: "2026-10-07T03:04:05.000Z" };
  const once = appendSessionOwnerDetails(kernelResidualNotice(TOKEN), owner);
  expect(once).toContain("原控制方：");
  expect(once).toContain("4242");
  expect(appendSessionOwnerDetails(once, owner)).toBe(once);
});

test("按 token 从运行时锁目录读取旧 owner 记录", async () => {
  const home = await mkdtemp(join(tmpdir(), "session-lock-owner-"));
  const sessionId = "sess-lock-1";
  const lockDir = join(home, ".pao", "运行时锁");
  await mkdir(lockDir, { recursive: true });
  const owner = {
    token: TOKEN,
    sessionId,
    pid: 4242,
    surface: "desktop",
    acquiredAt: "2026-10-07T03:04:05.000Z",
  };
  const lockName = createHash("sha256").update(sessionId).digest("hex");
  await writeFile(join(lockDir, `${lockName}.json`), JSON.stringify(owner), "utf8");

  await expect(readSessionLockOwnerByToken(home, TOKEN)).resolves.toEqual(owner);
  await expect(readSessionLockOwnerByToken(home, randomUUID())).resolves.toBeUndefined();
});

test("损坏或缺失的锁记录按未找到处理，不抛错", async () => {
  const home = await mkdtemp(join(tmpdir(), "session-lock-owner-bad-"));
  const lockDir = join(home, ".pao", "运行时锁");
  await mkdir(lockDir, { recursive: true });
  await writeFile(join(lockDir, "broken.json"), "{not json", "utf8");
  // 固定 token 命中记录但字段无效：按未找到（不把无效记录富化上屏），不抛错。
  await writeFile(
    join(lockDir, "partial.json"),
    JSON.stringify({ token: TOKEN, pid: "not-a-pid" }),
    "utf8",
  );

  await expect(readSessionLockOwnerByToken(home, TOKEN)).resolves.toBeUndefined();
  await expect(readSessionLockOwnerByToken(home, randomUUID())).resolves.toBeUndefined();
  await expect(
    readSessionLockOwnerByToken(join(home, "missing"), randomUUID()),
  ).resolves.toBeUndefined();
});

test("enrich：残留锁通知追加旧 owner 详情；活锁与读不到记录时原文返回", async () => {
  const home = await mkdtemp(join(tmpdir(), "session-lock-enrich-"));
  const sessionId = "sess-lock-2";
  const lockDir = join(home, ".pao", "运行时锁");
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    join(lockDir, `${createHash("sha256").update(sessionId).digest("hex")}.json`),
    JSON.stringify({
      token: TOKEN,
      sessionId,
      pid: 4242,
      surface: "desktop",
      acquiredAt: "2026-10-07T03:04:05.000Z",
    }),
    "utf8",
  );

  const enriched = await enrichSessionLockOwnerMessage(kernelResidualNotice(TOKEN), home);
  expect(enriched).toContain("原控制方：");
  expect(enriched).toContain("4242");
  expect(enriched).toContain("宿主面 desktop");

  // 活锁：不追加（无 token 可读）。
  const live =
    "会话只读：Error: 同会话已有控制方，拒绝同时驱动；残锁可用 /pao runtime takeover <原控制标识> 显式接管。";
  expect(await enrichSessionLockOwnerMessage(live, home)).toBe(live);
  // 有 token 但锁文件里查无此 token（已被释放）：原文返回。
  const unknownToken = randomUUID();
  expect(await enrichSessionLockOwnerMessage(kernelResidualNotice(unknownToken), home)).toBe(
    kernelResidualNotice(unknownToken),
  );
  // 未配置 PAO_HOME：原文返回。
  expect(await enrichSessionLockOwnerMessage(kernelResidualNotice(TOKEN), undefined)).toBe(
    kernelResidualNotice(TOKEN),
  );
});

test("锁记录字段以内核 session-lock.ts 已有字段为准", async () => {
  // 内核 SessionOwner: { token, sessionId, pid, surface, acquiredAt }——本模块不引入新字段。
  const home = await mkdtemp(join(tmpdir(), "session-lock-fields-"));
  const lockDir = join(home, ".pao", "运行时锁");
  await mkdir(lockDir, { recursive: true });
  const owner = {
    token: TOKEN,
    sessionId: "s",
    pid: 7,
    surface: "terminal",
    acquiredAt: "2026-10-07T03:04:05.000Z",
  };
  await writeFile(
    join(lockDir, `${createHash("sha256").update("s").digest("hex")}.json`),
    JSON.stringify(owner),
    "utf8",
  );
  const record = await readSessionLockOwnerByToken(home, TOKEN);
  expect(Object.keys(record ?? {}).sort()).toEqual(Object.keys(owner).sort());
});

test("无效持有时间原样回显，不做日期渲染（M7 钉回退分支）", () => {
  expect(
    formatSessionOwnerDetails({ pid: 1, surface: "desktop", acquiredAt: "不是ISO时间" }),
  ).toContain("持有自 不是ISO时间");
});

const ref = { workspaceId: "workspace", sessionId: "session" };
const ts = "2026-10-07T00:00:00.000Z";

type HostUiRequestEvent = Extract<
  import("@pi-gui/session-driver").SessionDriverEvent,
  { type: "hostUiRequest" }
>;

function hostEvent(request: HostUiRequest): HostUiRequestEvent {
  return { type: "hostUiRequest", sessionRef: ref, timestamp: ts, request };
}

test("事件级富化：非 error 级 notify 与非 notify kind 一律原事件返回（对象同一，M1 钉守卫）", async () => {
  const info = hostEvent({
    kind: "notify",
    requestId: "i",
    message: kernelResidualNotice(TOKEN),
    level: "info",
  });
  const warning = hostEvent({
    kind: "notify",
    requestId: "w",
    message: kernelResidualNotice(TOKEN),
    level: "warning",
  });
  const confirm = hostEvent({
    kind: "confirm",
    requestId: "c",
    title: "t",
    message: kernelResidualNotice(TOKEN),
  });
  const select = hostEvent({
    kind: "select",
    requestId: "s",
    title: "t",
    options: ["a"],
  });
  expect(await enrichSessionLockOwnerEvent(info, undefined)).toBe(info);
  expect(await enrichSessionLockOwnerEvent(warning, undefined)).toBe(warning);
  expect(await enrichSessionLockOwnerEvent(confirm, undefined)).toBe(confirm);
  expect(await enrichSessionLockOwnerEvent(select, undefined)).toBe(select);
});

test("事件级守卫区分力：paoHome 存在且锁记录匹配时非 error 级 notify 仍原事件返回（TDD-R2 P3-1 补腿）", async () => {
  // 既有 M1 守卫四腿均传 paoHome=undefined，守卫被删时仍绿；本测以真实 home＋匹配锁记录
  // 钉「守卫真实生效」：守卫在→info 原事件返回；守卫被删→info 也会被富化（返回新对象）→红。
  const home = await mkdtemp(join(tmpdir(), "session-lock-guard-"));
  const lockDir = join(home, ".pao", "运行时锁");
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    join(lockDir, `${createHash("sha256").update(ref.sessionId).digest("hex")}.json`),
    JSON.stringify({
      token: TOKEN,
      sessionId: ref.sessionId,
      pid: 4242,
      surface: "desktop",
      acquiredAt: "2026-10-07T03:04:05.000Z",
    }),
    "utf8",
  );
  const info = hostEvent({
    kind: "notify",
    requestId: "guard",
    message: kernelResidualNotice(TOKEN),
    level: "info",
  });
  expect(await enrichSessionLockOwnerEvent(info, home)).toBe(info);
});

test("事件级富化：消息未变时返回同一事件对象；命中时返回新对象且原事件不被原地改动", async () => {
  const home = await mkdtemp(join(tmpdir(), "session-lock-event-"));
  const lockDir = join(home, ".pao", "运行时锁");
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    join(lockDir, `${createHash("sha256").update(ref.sessionId).digest("hex")}.json`),
    JSON.stringify({
      token: TOKEN,
      sessionId: ref.sessionId,
      pid: 4242,
      surface: "desktop",
      acquiredAt: "2026-10-07T03:04:05.000Z",
    }),
    "utf8",
  );
  const original = hostEvent({
    kind: "notify",
    requestId: "e",
    message: kernelResidualNotice(TOKEN),
    level: "error",
  });

  // 锁目录里查无此 token：消息未变 → 同一事件对象（身份保持，下游 coalesced emit 不受扰动）。
  const miss = hostEvent({
    kind: "notify",
    requestId: "miss",
    message: kernelResidualNotice(randomUUID()),
    level: "error",
  });
  expect(await enrichSessionLockOwnerEvent(miss, home)).toBe(miss);

  // 命中：返回新事件对象；原事件对象内容不变。
  const enriched = await enrichSessionLockOwnerEvent(original, home);
  expect(enriched).not.toBe(original);
  expect((enriched as HostUiRequestEvent).request).toMatchObject({
    kind: "notify",
    message: expect.stringContaining("原控制方："),
  });
  expect(original.request).toMatchObject({ message: kernelResidualNotice(TOKEN) });
});
