/**
 * 一次性主控会话启动清扫的数据面（波3 §1d）：按工作区读控制正本
 * （readDesktopFlows，项目根 .pao/ 下的 工作流实例-*.md），投影成
 * app-store 清扫判定需要的最小行（owner 会话 id＋实例状态）。
 *
 * 失败语义（宁漏勿误）：桥加载失败或某工作区读取抛错 → 该工作区置
 * undefined，清扫整体跳过它；清单带坏行（问题非空）说明有实例状态
 * 判不了，同样置 undefined——只删「全部实例可读且全部终态」的会话。
 */
import type { PaoDesktopFlowControlModule } from "@pi-gui/pi-sdk-driver";
import type { EphemeralOwnerFlow } from "../../application/ephemeral-sessions";
import { loadDriver } from "./bridge-common";

export type EphemeralFlowStatuses = ReadonlyMap<string, readonly EphemeralOwnerFlow[] | undefined>;

/** 最小 store 面：清扫只需要工作区清单与清扫入口（main 启动接线用）。 */
export interface EphemeralSweepStore {
  readonly snapshot: () => { readonly workspaces: readonly { id: string; path: string }[] };
  readonly sweepEphemeralSessions: (flowsByWorkspace: EphemeralFlowStatuses) => Promise<number>;
}

export interface EphemeralSweepOptions {
  /** Overrides the lazy driver import (tests). */
  readonly loadModule?: () => Promise<PaoDesktopFlowControlModule>;
}

/** 启动接线：读各工作区控制正本 → 判定 → 删除；返回删除条数。 */
export async function sweepEphemeralWorkflowSessions(
  store: EphemeralSweepStore,
  options: EphemeralSweepOptions = {},
): Promise<number> {
  const flowsByWorkspace = await readEphemeralFlowStatuses(store.snapshot().workspaces, options);
  return store.sweepEphemeralSessions(flowsByWorkspace);
}

/** 每桥只加载一次；主进程启动期调用，失败＝全部工作区不可判。 */
export async function readEphemeralFlowStatuses(
  workspaces: readonly { readonly id: string; readonly path: string }[],
  options: EphemeralSweepOptions = {},
): Promise<EphemeralFlowStatuses> {
  const flowsByWorkspace = new Map<string, readonly EphemeralOwnerFlow[] | undefined>();
  if (workspaces.length === 0) return flowsByWorkspace;
  let bridge: PaoDesktopFlowControlModule;
  try {
    const loadModule = options.loadModule ?? (await loadDriver("loadPaoDesktopFlowControl"));
    bridge = await loadModule();
  } catch {
    for (const workspace of workspaces) flowsByWorkspace.set(workspace.id, undefined);
    return flowsByWorkspace;
  }
  for (const workspace of workspaces) {
    try {
      const read = await bridge.readDesktopFlows(workspace.path);
      if (!Array.isArray(read.问题) || read.问题.length > 0) {
        flowsByWorkspace.set(workspace.id, undefined);
        continue;
      }
      flowsByWorkspace.set(
        workspace.id,
        (read.工作流 ?? []).map((flow) => ({
          owner: String(flow.控制?.owner ?? ""),
          status: String(flow.控制?.状态 ?? ""),
        })),
      );
    } catch {
      flowsByWorkspace.set(workspace.id, undefined);
    }
  }
  return flowsByWorkspace;
}
