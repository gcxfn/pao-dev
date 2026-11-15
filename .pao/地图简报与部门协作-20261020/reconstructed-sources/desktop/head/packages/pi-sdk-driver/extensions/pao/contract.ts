import { defineService, type Context } from "@earendil-works/chord";
import type {
  DesktopProjectSnapshot,
  DesktopSessionIncrement,
} from "@earendil-works/pi-coding-agent/pao/desktop";

export interface PaoView {
  项目: DesktopProjectSnapshot;
  部长错误?: string;
  待处理: { projects: DesktopProjectSnapshot[]; issues: { 路径: string; 说明: string }[] };
  部长: { 会话标识: string; 部门: string; 项目根: string; pid: number; 脉络?: string }[];
}
export interface Identity {
  sessionId: string;
  project: string;
}
export interface PaoService {
  refresh(context: Context): Promise<PaoView>;
  execution(
    request: Identity & { id: string; offset: number },
    context: Context,
  ): Promise<DesktopSessionIncrement>;
  memory(request: Identity & { args: string; revision: string }, context: Context): Promise<void>;
  minister(
    request: Identity & { id: string; offset: number },
    context: Context,
  ): Promise<DesktopSessionIncrement>;
  diff(
    request: Identity & { instance?: string; node?: string },
    context: Context,
  ): Promise<unknown>;
  /** D8c 结果页聚合（按实例四样＋恢复摘要四态＋异常行）；载荷结构见 pao/status/results.ts。 */
  results(request: Identity, context: Context): Promise<unknown>;
  flow(
    request: Identity & {
      instance: string;
      node: string;
      round: number;
      action: "confirm" | "pause" | "resume" | "rule";
      reason: string;
      result?: "pass" | "change" | "reject";
      references?: string[];
      target?: string;
      /** 与内核 schema 同名（§10 收口批统一，消掉后端 index.ts 的 axis→failure_axis 映射）。 */
      failure_axis?: "card" | "dept_standard" | "both";
    },
    context: Context,
  ): Promise<void>;
}
export const Pao = defineService<PaoService>("pao.desktop.v1");

/** 键控脉冲服务：会话 turn/agent 事件时后端补一个实例，前端 observe 到即节流刷新一次。载荷无意义。 */
export interface PaoPulseService {
  ping(): Promise<number>;
}
export const PaoPulse = defineService<PaoPulseService>("pao.desktop.pulse.v1");
