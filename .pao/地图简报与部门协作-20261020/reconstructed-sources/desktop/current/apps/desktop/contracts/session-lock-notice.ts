/**
 * 会话残留锁报错的共享契约（W-bug9）。内核 runtime/session-lock.ts 的残留锁
 * 报错只把原控制标识（token uuid）带给用户；本模块从报错文本解析 token、把
 * 旧 owner 详情（pid/宿主面/持有时间，字段即内核锁文件 SessionOwner 已有字段）
 * 追加进报错，并给出复用内核 /pao runtime takeover 同链路的接管命令。
 * 纯函数，主进程与渲染层共用；渲染层不读内核文件。
 */

const RESIDUAL_LOCK_MARK = "残留会话锁须显式接管";
const TOKEN_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const OWNER_MARK = "原控制方：";

/** 活锁与损坏锁文案不含可接管 token，返回 undefined（不提供接管入口）。 */
export function parseResidualSessionLockToken(message: string): string | undefined {
  if (!message.includes(RESIDUAL_LOCK_MARK)) {
    return undefined;
  }
  return TOKEN_PATTERN.exec(message)?.[0];
}

export interface SessionOwnerView {
  readonly pid: number;
  readonly surface: string;
  readonly acquiredAt: string;
}

export function formatSessionOwnerDetails(owner: SessionOwnerView): string {
  return `pid ${owner.pid}，宿主面 ${owner.surface}，持有自 ${formatAcquiredAt(owner.acquiredAt)}`;
}

function formatAcquiredAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** 追加旧 owner 详情；已含详情时原样返回（事件重放幂等）。 */
export function appendSessionOwnerDetails(message: string, owner: SessionOwnerView): string {
  if (message.includes(OWNER_MARK)) {
    return message;
  }
  return `${message}（${OWNER_MARK}${formatSessionOwnerDetails(owner)}）`;
}

/** 与内核 slash 命令同字同链路：/pao runtime takeover <原控制标识>。 */
export function sessionLockTakeoverCommand(token: string): string {
  return `/pao runtime takeover ${token}`;
}
