import { sessionKey } from "@pi-gui/session-driver";
import type {
  ComposerAttachment,
  DesktopAppState,
  SessionRecord,
  WorkspaceSessionTarget,
} from "../../contracts/desktop-state";
import type { SessionControlRequest, SessionControlResponse } from "../../contracts/ipc";
import {
  deriveThreadControlState,
  toSessionControlState,
  type ThreadControlInput,
} from "../../contracts/thread-control-state";
import { assertComposerAttachmentPixels } from "./composer-attachment-pixels";

/**
 * 单一控制入口协调器（设计包-控制入口五态-2026-10-04 §2.1-§2.3）。
 *
 * 一个入口受理 send/cancel/dispatch/confirm/query：
 * - send/dispatch/confirm 走窗口串行动作队列；cancel 保留 immediate 捷径绕队列；
 *   query 只读，不走写路径。
 * - 内存账本按 (target, requestId) 记录 accepted/rejected/done＋摘要；重复 requestId
 *   直接返回首账，绝不重发写请求。账不跨重启持久化：重启即「未知」，以文件/驱动
 *   真相重建（拍板 §6.4）。
 * - dispatch/confirm 转成对 owner 会话（target 本身）的 send 文本，走既有消息链，
 *   桌面零写卡、零 PAO 文件写入（拍板 §6.1/§6.2）。
 * - 回执带 controlState（五态＋「未知」）与全量 state；状态判定复用
 *   contracts/thread-control-state.ts 的表驱动纯函数。
 */

/** 既有消息链的最小切面；实现即 DesktopAppStore 的同名方法。 */
export interface SessionControlOwners {
  readonly submitComposer: (
    target: WorkspaceSessionTarget,
    text: string,
    options?: { readonly deliverAs?: "steer" | "followUp" },
  ) => Promise<DesktopAppState>;
  readonly addComposerAttachments: (
    target: WorkspaceSessionTarget,
    attachments: readonly ComposerAttachment[],
  ) => Promise<DesktopAppState>;
  readonly cancelCurrentRun: (target: WorkspaceSessionTarget) => Promise<DesktopAppState>;
}

/** 每个请求的一次受理环境；由 register-desktop-ipc 用窗口/队列设施组装。 */
export interface SessionControlTurn {
  /**
   * send/dispatch/confirm 的写路径。注册侧按旧 submitComposer 通道的规则分流：
   * 只有可能改选中会话的 "/" 本地或扩展命令文本才进窗口串行动作队列；普通 prompt
   * 在驱动层 await 整个 turn，必须走 immediate 不占队列（占队列＝整个 run 期间所有
   * 走队列的按钮无响应，真机 P0-2026-10-05）。协调器内部按序 await，两档语义等价串行。
   */
  readonly runQueued: (action: () => Promise<DesktopAppState>) => Promise<DesktopAppState>;
  /** cancel：绕队列的 immediate 捷径（旧通道同语义）。 */
  readonly runNow: (action: () => Promise<DesktopAppState>) => Promise<DesktopAppState>;
  /** query 与回执投影：只读当前全量 state。 */
  readonly readState: () => Promise<DesktopAppState>;
}

interface ControlLedgerEntry {
  readonly kind: SessionControlRequest["action"]["kind"];
  readonly at: number;
  /** accepted（受理，含在途）｜rejected（执行抛错）｜done（执行完成）。 */
  status: "accepted" | "rejected" | "done";
  accepted: boolean;
  reason?: string;
  summary?: string;
}

/** 账本上限：只做幂等查证用，旧账被挤出即等同「未知」。 */
const MAX_LEDGER_ENTRIES = 512;

function ledgerKey(target: WorkspaceSessionTarget, requestId: string): string {
  // NUL 分隔：sessionKey（路径式 id）不会含 NUL，且前缀匹配不会错切。
  return `${sessionKey(target)}\u0000${requestId}`;
}

function findSessionRecord(
  state: DesktopAppState,
  target: WorkspaceSessionTarget,
): SessionRecord | undefined {
  return state.workspaces
    .find((workspace) => workspace.id === target.workspaceId)
    ?.sessions.find((session) => session.id === target.sessionId);
}

/** 派卡转 owner 会话文本（拍板 §6.2：P3 最小，结构化派卡表单留后续批次）。 */
export function dispatchControlText(cardGoal: string, dispatchReason?: string): string {
  return [
    `【桌面派卡】请按既有 pao_dispatch_card 流程，为「${cardGoal}」创建并派发任务卡。`,
    dispatchReason ? `dispatchReason：${dispatchReason}\n` : "",
    "完成后请回报卡号与承接者。",
  ]
    .filter(Boolean)
    .join("");
}

/** 验收确认转 owner 会话文本（拍板 §6.1：桌面零写卡，owner 走卡状态机单写者流程）。 */
export function confirmControlText(cardRef: string, basis?: string): string {
  return [
    `【桌面验收确认】卡「${cardRef}」验收通过，请按既有卡状态机单写者流程把该卡置为「delivered」。`,
    basis ? `basis：${basis}\n` : "",
  ]
    .filter(Boolean)
    .join("");
}

/** 控制入口写路径的队列档位：queued＝进窗口串行动作队列，immediate＝不占队列。 */
export type SessionControlQueueLane = "queued" | "immediate";

/**
 * 写路径队列分流，与旧 submitComposer 通道同规则（contracts/composer-commands.ts
 * `composerSubmitNeedsSenderView` 的注释）：普通 prompt 在驱动层 await 整个 turn
 * （pi 的 agent_settled 在 prompt() 内部才到达），一旦进窗口串行队列就会把队列占死
 * 整个 run 时长，期间所有走队列的按钮全部无响应（真机 P0-2026-10-05）。只有可能改
 * 选中会话的 "/" 本地或扩展命令文本才允许占队列；dispatch/confirm/cancel/query
 * 一律 immediate（前两者的引导文本由主进程生成，永不会以 "/" 开头）。
 */
export function sessionControlQueueLane(
  request: SessionControlRequest,
  submitNeedsSenderView: (target: WorkspaceSessionTarget, text: string) => boolean,
): SessionControlQueueLane {
  return request.action.kind === "send" &&
    submitNeedsSenderView(request.target, request.action.text)
    ? "queued"
    : "immediate";
}

export interface SessionControlCoordinator {
  handle(request: SessionControlRequest, turn: SessionControlTurn): Promise<SessionControlResponse>;
}

export function createSessionControlCoordinator(owners: SessionControlOwners): SessionControlCoordinator {
  const ledger = new Map<string, ControlLedgerEntry>();

  function remember(key: string, entry: ControlLedgerEntry): void {
    ledger.set(key, entry);
    while (ledger.size > MAX_LEDGER_ENTRIES) {
      const oldest = ledger.keys().next().value;
      if (oldest === undefined) break;
      ledger.delete(oldest);
    }
  }

  function entryFor(
    target: WorkspaceSessionTarget,
    requestId: string,
  ): ControlLedgerEntry | undefined {
    return ledger.get(ledgerKey(target, requestId));
  }

  function latestEntryFor(target: WorkspaceSessionTarget, kind: "send" | "cancel"): {
    entry: ControlLedgerEntry;
    requestId: string;
  } | undefined {
    const prefix = `${sessionKey(target)}\u0000`;
    let latest: { entry: ControlLedgerEntry; requestId: string } | undefined;
    for (const [key, entry] of ledger) {
      if (!key.startsWith(prefix) || entry.kind !== kind) continue;
      // Ledger iteration is insertion-ordered, so the last match is the most recent.
      latest = { entry, requestId: key.slice(prefix.length) };
    }
    return latest;
  }

  function controlInput(
    state: DesktopAppState,
    target: WorkspaceSessionTarget,
    matchedCancelRequestId: string | undefined,
  ): ThreadControlInput {
    const record = findSessionRecord(state, target);
    const lastCancel = matchedCancelRequestId
      ? entryFor(target, matchedCancelRequestId)
      : latestEntryFor(target, "cancel")?.entry;
    return {
      status: record?.status ?? "idle",
      cancellationRequested: record?.cancellationRequested,
      cancelRequestIdMatched:
        lastCancel !== undefined && lastCancel.kind === "cancel" && lastCancel.status === "done",
      sendAcceptedPendingRun: latestEntryFor(target, "send")?.entry.status === "accepted",
    };
  }

  async function respond(
    request: SessionControlRequest,
    account: { readonly accepted: boolean; readonly reason?: string },
    turn: SessionControlTurn,
    matchedCancelRequestId?: string,
  ): Promise<SessionControlResponse> {
    const state = await turn.readState();
    return {
      requestId: request.requestId,
      accepted: account.accepted,
      ...(account.reason ? { reason: account.reason } : {}),
      controlState: toSessionControlState(
        deriveThreadControlState(controlInput(state, request.target, matchedCancelRequestId)),
      ),
      state,
    };
  }

  return {
    async handle(request, turn): Promise<SessionControlResponse> {
      const { target, requestId, action } = request;

      // 查账只读：不走写路径、不记账。
      if (action.kind === "query") {
        const entry = action.requestId ? entryFor(target, action.requestId) : undefined;
        const matchedCancel =
          entry?.kind === "cancel" && entry.status === "done" ? action.requestId : undefined;
        return respond(
          request,
          entry
            ? { accepted: entry.accepted, ...(entry.reason ? { reason: entry.reason } : {}) }
            : action.requestId
              ? { accepted: false, reason: "No control request is recorded for this requestId." }
              : { accepted: true },
          turn,
          matchedCancel,
        );
      }

      // 幂等：同 (target, requestId) 直接返回首账，不重发写请求（§2.3）。
      const existing = entryFor(target, requestId);
      if (existing) {
        const matchedCancel =
          existing.kind === "cancel" && existing.status === "done" ? requestId : undefined;
        return respond(
          request,
          { accepted: existing.accepted, ...(existing.reason ? { reason: existing.reason } : {}) },
          turn,
          matchedCancel,
        );
      }

      const entry: ControlLedgerEntry = {
        kind: action.kind,
        at: Date.now(),
        status: "accepted",
        accepted: true,
      };
      remember(ledgerKey(target, requestId), entry);
      try {
        const summary = await execute(target, action, turn);
        entry.status = "done";
        entry.summary = summary;
        return respond(
          request,
          { accepted: true, ...(summary ? { reason: summary } : {}) },
          turn,
          action.kind === "cancel" ? requestId : undefined,
        );
      } catch (error) {
        entry.status = "rejected";
        entry.accepted = false;
        entry.reason = error instanceof Error ? error.message : String(error);
        return respond(
          request,
          { accepted: false, reason: entry.reason },
          turn,
        );
      }
    },
  };

  async function execute(
    target: WorkspaceSessionTarget,
    action: SessionControlRequest["action"],
    turn: SessionControlTurn,
  ): Promise<string | undefined> {
    switch (action.kind) {
      case "send": {
        if (action.attachments?.length) {
          assertComposerAttachmentPixels(action.attachments);
          await turn.runQueued(() =>
            owners.addComposerAttachments(target, action.attachments ?? []),
          );
        }
        const state = await turn.runQueued(() =>
          owners.submitComposer(
            target,
            action.text,
            action.deliverAs ? { deliverAs: action.deliverAs } : undefined,
          ),
        );
        return state.lastError ? `completed with error: ${state.lastError}` : undefined;
      }
      case "cancel": {
        const state = await turn.runNow(() => owners.cancelCurrentRun(target));
        return state.lastError ? `completed with error: ${state.lastError}` : undefined;
      }
      case "dispatch": {
        await turn.runQueued(() =>
          owners.submitComposer(target, dispatchControlText(action.cardGoal, action.dispatchReason)),
        );
        return `dispatched to owner session ${sessionKey(target)}`;
      }
      case "confirm": {
        await turn.runQueued(() =>
          owners.submitComposer(target, confirmControlText(action.cardRef, action.basis)),
        );
        return `confirmation sent to owner session ${sessionKey(target)}`;
      }
      case "query":
        // Handled before execute; unreachable.
        return undefined;
    }
  }
}
