import type { SessionStatus } from "./desktop-state";
import type { SessionControlState, ThreadControlState } from "./ipc";

export type { SessionControlState, ThreadControlState };

/**
 * 五态控制面判定（设计包-控制入口五态-2026-10-04 §2.2，表驱动纯函数）。
 *
 * 输入全部来自既有真相：
 * - `status`：会话快照 SessionStatus（driver 侧 "stopping" 表示取消已受理未确认）。
 * - `cancellationRequested`：未决取消（快照 cancellationRequested 镜像）。
 * - `cancelRequestIdMatched`：最近一次取消请求的回执已完成（账 done / invoke 已回）。
 * - `sendAcceptedPendingRun`：send 回执已受理而 run 未启动（driver 排队消息存在等）。
 * - `pao`：仅 PAO 卡路径——卡面状态＋执行映射末行投影；普通会话缺省，无「验收通过」。
 *
 * 规则自上而下首条命中即返回；全部不命中返回 null（无控制态可显示，回执侧呈 "未知"）。
 */
export interface PaoCardControlInput {
  /** 卡面状态（delivered/in_progress/failed/canceled…，取卡现读英文值）。 */
  readonly cardStatus?: string | undefined;
  /** 执行映射末行（success/failed/canceled/unknown…）；半行（执行中）缺省。 */
  readonly mappingLastLine?: string | undefined;
}

export interface ThreadControlInput {
  readonly status: SessionStatus;
  readonly cancellationRequested?: boolean | undefined;
  readonly cancelRequestIdMatched?: boolean | undefined;
  readonly sendAcceptedPendingRun?: boolean | undefined;
  readonly pao?: PaoCardControlInput | undefined;
}

interface ThreadControlRule {
  readonly state: ThreadControlState;
  readonly match: (input: ThreadControlInput) => boolean;
}

/** 卡面 delivered ＋执行映射末行 success ＝验收通过（§2.2，仅 PAO 卡路径）。 */
export function paoCardAccepted(pao: PaoCardControlInput | undefined): boolean {
  return pao?.cardStatus === "delivered" && pao?.mappingLastLine === "success";
}

export const threadControlRules: readonly ThreadControlRule[] = [
  {
    // 停止中：取消已受理、停止未确认（含 running 期收到取消回执的窗口）。
    state: "stopping",
    match: (input) =>
      input.status === "stopping" ||
      (input.status === "running" && input.cancellationRequested === true),
  },
  {
    // 执行：run 进行中且无未决取消。
    state: "executing",
    match: (input) => input.status === "running",
  },
  {
    // 接收：控制回执 accepted 但 run 未启动（排队消息存在等）。
    state: "receiving",
    match: (input) => input.status === "idle" && input.sendAcceptedPendingRun === true,
  },
  {
    // 验收通过：仅 PAO 卡路径（映射末行＋卡面已交付）；普通会话无此态。
    state: "accepted",
    match: (input) =>
      (input.status === "idle" || input.status === "failed") && paoCardAccepted(input.pao),
  },
  {
    // 已停止：idle/failed 且最近一次取消请求匹配完成（abort 拒绝等已收敛情形同此）。
    state: "stopped",
    match: (input) =>
      (input.status === "idle" || input.status === "failed") && input.cancelRequestIdMatched === true,
  },
];

/** 五态判定；无态可判返回 null（调用方决定展示空或 "未知"）。 */
export function deriveThreadControlState(input: ThreadControlInput): ThreadControlState | null {
  for (const rule of threadControlRules) {
    if (rule.match(input)) {
      return rule.state;
    }
  }
  return null;
}

/** 回执用六值：推导不出具体控制态时呈 "未知"。 */
export function toSessionControlState(
  state: ThreadControlState | null,
): SessionControlState {
  return state ?? "未知";
}
