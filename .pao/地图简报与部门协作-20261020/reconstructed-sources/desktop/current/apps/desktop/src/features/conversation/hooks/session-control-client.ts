import { useMemo, useSyncExternalStore } from "react";
import type {
  SessionRecord,
  SessionStatus,
  WorkspaceSessionTarget,
} from "../../../../contracts/desktop-state";
import type {
  PiDesktopApi,
  SessionControlAction,
  SessionControlResponse,
} from "../../../../contracts/ipc";
import {
  deriveThreadControlState,
  type ThreadControlState,
} from "../../../../contracts/thread-control-state";

/**
 * 渲染层控制入口客户端（设计包-控制入口五态-2026-10-04 §2.3）。
 *
 * - 每个请求带渲染层生成的 requestId（uuid）；本地留一份回执账，供五态推导与查证恢复。
 * - invoke 超时/异常后先 `query(requestId)` 查主进程账，再决定；查到已受理/已完成就
 *   采用该账（不盲重发），查不到（账丢失）按失败上报，由调用方以 state 重建视图。
 * - 回执账只存内存（与主进程账同命）：重启即「未知」，以文件/驱动真相重建（拍板 §6.4）。
 */

export interface SessionControlReceipt {
  readonly requestId: string;
  readonly kind: SessionControlAction["kind"];
  readonly accepted: boolean;
  /** 主进程账已定（done/rejected，或查证后落定）。 */
  readonly done: boolean;
  readonly reason?: string;
  readonly at: number;
}

const MAX_RECEIPTS_PER_SESSION = 32;

const receiptsBySession = new Map<string, SessionControlReceipt[]>();
const listeners = new Set<() => void>();
let version = 0;

function emitChange(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

function noteReceipt(sessionId: string, receipt: SessionControlReceipt): void {
  const receipts = receiptsBySession.get(sessionId) ?? [];
  receipts.push(receipt);
  if (receipts.length > MAX_RECEIPTS_PER_SESSION) receipts.shift();
  receiptsBySession.set(sessionId, receipts);
  emitChange();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getVersion(): number {
  return version;
}

function latestReceipt(
  sessionId: string,
  kind: SessionControlAction["kind"],
): SessionControlReceipt | undefined {
  const receipts = receiptsBySession.get(sessionId);
  if (!receipts) return undefined;
  for (let index = receipts.length - 1; index >= 0; index--) {
    if (receipts[index]?.kind === kind) return receipts[index];
  }
  return undefined;
}

/**
 * 单一控制入口调用：带 requestId、留回执账；失败先查账再落定，不盲重发。
 * 返回主进程回执（含 controlState 与全量 state）。
 */
export async function sendSessionControl(
  api: PiDesktopApi,
  sessionId: string,
  target: WorkspaceSessionTarget,
  action: SessionControlAction,
): Promise<SessionControlResponse> {
  const requestId = crypto.randomUUID();
  noteReceipt(sessionId, {
    requestId,
    kind: action.kind,
    accepted: true,
    done: false,
    at: Date.now(),
  });
  try {
    const response = await api.sessionControl({ target, requestId, action });
    noteReceipt(sessionId, {
      requestId,
      kind: action.kind,
      accepted: response.accepted,
      done: true,
      ...(response.reason ? { reason: response.reason } : {}),
      at: Date.now(),
    });
    return response;
  } catch (error) {
    // invoke 超时/异常（§2.3）：先 query 查账，不盲重发。查到已受理/已完成 → 采用该账；
    // 账丢失/查询也失败 → 按原始失败落定，由调用方用文件/驱动真相重建视图。
    try {
      const probe = await api.sessionControl({
        target,
        requestId,
        action: { kind: "query", requestId },
      });
      noteReceipt(sessionId, {
        requestId,
        kind: action.kind,
        accepted: probe.accepted,
        done: true,
        ...(probe.reason ? { reason: probe.reason } : {}),
        at: Date.now(),
      });
      return probe;
    } catch {
      noteReceipt(sessionId, {
        requestId,
        kind: action.kind,
        accepted: false,
        done: true,
        reason: error instanceof Error ? error.message : String(error),
        at: Date.now(),
      });
      throw error;
    }
  }
}

export interface ThreadControlView {
  readonly state: ThreadControlState | null;
  /** 最近一次取消回执的发起时刻（epoch ms）；「停止中时间较长」提示用。 */
  readonly cancelRequestedAt: number | undefined;
}

/**
 * 五态视图：把 (SessionStatus, 未决取消, cancelRequestId 匹配, send 受理) 与本地回执账
 * 合成后交给 contracts/thread-control-state.ts 的表驱动纯函数。PAO 卡路径投影本批不接
 * （桌面零写卡，卡面真相由看板批次展示），普通会话不出现「验收通过」。
 */
export function deriveThreadControlView(
  sessionId: string | undefined,
  session:
    | { readonly status: SessionStatus; readonly cancellationRequested?: boolean }
    | undefined,
): ThreadControlView {
  const lastCancel = sessionId ? latestReceipt(sessionId, "cancel") : undefined;
  const lastSend = sessionId ? latestReceipt(sessionId, "send") : undefined;
  const state = deriveThreadControlState({
    status: session?.status ?? "idle",
    // 在途回执（驱动尚未广播 stopping 前）也算未决取消。
    cancellationRequested:
      session?.cancellationRequested === true || (lastCancel !== undefined && !lastCancel.done),
    cancelRequestIdMatched: lastCancel?.done === true && lastCancel.accepted === true,
    sendAcceptedPendingRun:
      lastSend !== undefined && lastSend.accepted && !lastSend.done,
  });
  return { state, cancelRequestedAt: lastCancel?.at };
}

/** React 绑定：回执账变化时重算五态视图。 */
export function useThreadControlView(
  sessionId: string | undefined,
  session:
    | Pick<SessionRecord, "status" | "cancellationRequested">
    | undefined,
): ThreadControlView {
  const currentVersion = useSyncExternalStore(subscribe, getVersion);
  return useMemo(
    () => deriveThreadControlView(sessionId, session),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version 门槛：回执账变化即重算
    [currentVersion, sessionId, session?.status, session?.cancellationRequested],
  );
}
