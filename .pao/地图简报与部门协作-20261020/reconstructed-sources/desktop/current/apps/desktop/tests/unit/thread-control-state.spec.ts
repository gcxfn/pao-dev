import { expect, test } from "@playwright/test";
import type { SessionStatus } from "../../contracts/desktop-state";
import {
  deriveThreadControlState,
  toSessionControlState,
  type ThreadControlInput,
} from "../../contracts/thread-control-state";

/** 表驱动全组合（设计包-控制入口五态-2026-10-04 §2.2）：状态机规则矩阵的每个单元格。 */

const STATUSES: SessionStatus[] = ["idle", "running", "failed", "stopping"];
const FLAGS: (boolean | undefined)[] = [undefined, false, true];
const PAO_VARIANTS: (ThreadControlInput["pao"])[] = [
  undefined,
  { cardStatus: "delivered", mappingLastLine: "success" },
  { cardStatus: "delivered", mappingLastLine: undefined },
  { cardStatus: "in_progress", mappingLastLine: undefined },
  { cardStatus: "delivered", mappingLastLine: "failed" },
];

/** 与实现互相独立的期望函数：按设计包 §2.2 的优先级直接写出。 */
function expectedState(input: ThreadControlInput): string | null {
  if (input.status === "stopping") return "stopping";
  if (input.status === "running") {
    return input.cancellationRequested ? "stopping" : "executing";
  }
  if (input.status === "idle" && input.sendAcceptedPendingRun) return "receiving";
  const stopped = input.status === "idle" || input.status === "failed";
  if (stopped && input.pao?.cardStatus === "delivered" && input.pao?.mappingLastLine === "success") {
    return "accepted";
  }
  if (stopped && input.cancelRequestIdMatched) return "stopped";
  return null;
}

test("五态映射：全组合表驱动（4 状态 × 取消/匹配/受理旗标 × 卡路径）", () => {
  let combinations = 0;
  for (const status of STATUSES) {
    for (const cancellationRequested of FLAGS) {
      for (const cancelRequestIdMatched of FLAGS) {
        for (const sendAcceptedPendingRun of FLAGS) {
          for (const pao of PAO_VARIANTS) {
            const input: ThreadControlInput = {
              status,
              cancellationRequested,
              cancelRequestIdMatched,
              sendAcceptedPendingRun,
              pao,
            };
            expect(deriveThreadControlState(input)).toBe(expectedState(input));
            combinations += 1;
          }
        }
      }
    }
  }
  expect(combinations).toBe(4 * 3 * 3 * 3 * 5);
});

test("五态映射：设计包 §2.2 的关键字面用例", () => {
  // 接收：send 回执已受理而 run 未启动。
  expect(
    deriveThreadControlState({ status: "idle", sendAcceptedPendingRun: true }),
  ).toBe("receiving");
  // 执行：running 且无未决取消。
  expect(deriveThreadControlState({ status: "running" })).toBe("executing");
  // 停止中：stopping，或 running 期收到取消回执。
  expect(deriveThreadControlState({ status: "stopping" })).toBe("stopping");
  expect(
    deriveThreadControlState({ status: "running", cancellationRequested: true }),
  ).toBe("stopping");
  // 已停止：idle/failed 且最近一次取消请求匹配完成。
  expect(
    deriveThreadControlState({ status: "idle", cancelRequestIdMatched: true }),
  ).toBe("stopped");
  expect(
    deriveThreadControlState({ status: "failed", cancelRequestIdMatched: true }),
  ).toBe("stopped");
  // 普通会话 idle 无取消匹配：无态可判。
  expect(deriveThreadControlState({ status: "idle" })).toBeNull();
  // 验收通过：仅 PAO 卡路径（映射末行 success＋卡面 delivered）；普通会话不出现。
  expect(
    deriveThreadControlState({
      status: "idle",
      pao: { cardStatus: "delivered", mappingLastLine: "success" },
    }),
  ).toBe("accepted");
  expect(
    deriveThreadControlState({
      status: "idle",
      pao: { cardStatus: "delivered", mappingLastLine: "unknown" },
    }),
  ).toBeNull();
  // 停止中优先于卡路径与取消匹配。
  expect(
    deriveThreadControlState({
      status: "stopping",
      cancelRequestIdMatched: true,
      pao: { cardStatus: "delivered", mappingLastLine: "success" },
    }),
  ).toBe("stopping");
  // 执行中的卡路径仍显示执行（新一轮执行会重写映射，末行不再是成功）。
  expect(
    deriveThreadControlState({
      status: "running",
      pao: { cardStatus: "delivered", mappingLastLine: "success" },
    }),
  ).toBe("executing");
});

test("六值回执：无态可判呈「未知」", () => {
  expect(toSessionControlState(null)).toBe("未知");
  expect(toSessionControlState("stopping")).toBe("stopping");
  expect(toSessionControlState("accepted")).toBe("accepted");
});
