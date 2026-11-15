/**
 * 旧会话锁 owner 的桌面只读读取（W-bug9）。数据源是内核
 * runtime/session-lock.ts 落盘的 owner json（<PAO_HOME>/.pao/运行时锁/
 * <sha256(sessionId)>.json），字段不增不减；只在主进程读，渲染层经报错文案
 * 与确认弹窗看到详情，不直接碰内核文件。
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionDriverEvent } from "@pi-gui/session-driver";
import {
  appendSessionOwnerDetails,
  parseResidualSessionLockToken,
} from "../../../contracts/session-lock-notice";

/** 与内核 SessionOwner 同构；不新增字段。 */
export interface SessionLockOwnerRecord {
  readonly token: string;
  readonly sessionId: string;
  readonly pid: number;
  readonly surface: string;
  readonly acquiredAt: string;
}

function isOwnerRecord(value: unknown): value is SessionLockOwnerRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<SessionLockOwnerRecord>;
  return (
    typeof record.token === "string" &&
    typeof record.sessionId === "string" &&
    Number.isSafeInteger(record.pid) &&
    typeof record.surface === "string" &&
    typeof record.acquiredAt === "string"
  );
}

/** 在运行时锁目录里找 token 匹配的 owner；目录缺失、文件损坏、字段不完整都按未找到。 */
export async function readSessionLockOwnerByToken(
  paoHome: string,
  token: string,
): Promise<SessionLockOwnerRecord | undefined> {
  const dir = join(paoHome, ".pao", "运行时锁");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return undefined;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(dir, name), "utf8")) as unknown;
    } catch {
      continue;
    }
    const record = parsed as Partial<SessionLockOwnerRecord> | undefined;
    if (record?.token !== token) {
      continue;
    }
    return isOwnerRecord(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * 残留锁通知补旧 owner 详情；活锁/损坏锁文案没有可接管的 token、或锁目录里查
 * 不到对应记录时，原文返回。尽力而为，不抛错——报错呈现不能因增强而失败。
 */
export async function enrichSessionLockOwnerMessage(
  message: string,
  paoHome: string | undefined,
): Promise<string> {
  if (!paoHome) {
    return message;
  }
  const token = parseResidualSessionLockToken(message);
  if (!token) {
    return message;
  }
  const owner = await readSessionLockOwnerByToken(paoHome, token);
  return owner ? appendSessionOwnerDetails(message, owner) : message;
}

/**
 * 残留锁通知的事件级富化：其余事件原样返回。在主进程事件入口调用一次，
 * 时间线、应用内通知与系统通知共用同一富化结果。
 */
export async function enrichSessionLockOwnerEvent(
  event: Extract<SessionDriverEvent, { type: "hostUiRequest" }>,
  paoHome: string | undefined,
): Promise<SessionDriverEvent> {
  if (event.request.kind !== "notify" || event.request.level !== "error") {
    return event;
  }
  const message = await enrichSessionLockOwnerMessage(event.request.message, paoHome);
  if (message === event.request.message) {
    return event;
  }
  return { ...event, request: { ...event.request, message } };
}
