/**
 * PAO 工作看板只读聚合出口（桌面 P3 首件）：把本地 PAO fork 已有的聚合函数
 * 收拢成一个加载点，桌面壳一次 IPC 拉取三段数据（部门积压／挂起与异常工作流实例／
 * 待处理事项），不在桌面层重造解析。
 *
 * 部门积压从包根入口读取；工作流实例扫描与待处理事项从公开桌面入口读取。
 * 三个函数均来自内核公开导出，不反推内部构建目录，也不缓存读取结果。
 */
import { deptBacklogSnapshot, type DeptBacklogRow } from "@earendil-works/pi-coding-agent/pao";
import { loadPaoDesktopModule } from "./pao-desktop-module.js";

export type { DeptBacklogRow };

/** fork status/workflow-instances.ts 的挂起实例行（包入口未导出类型，此处按结构声明）。 */
export interface PaoSuspendedInstanceRow {
  readonly 工作流: string;
  readonly 项目: string;
  readonly 路径: string;
}

/** fork status/workflow-instances.ts 的实例异常行（坏字段/读失败/目录不可达显式行）。 */
export interface PaoInstanceAnomalyRow {
  readonly 路径: string;
  readonly 文件: string;
  readonly 原因: string;
}

/** fork status/workflow-instances.ts 的 scanWorkflowInstances 返回结构。 */
export interface PaoWorkflowInstanceScan {
  readonly 挂起: readonly PaoSuspendedInstanceRow[];
  readonly 异常: readonly PaoInstanceAnomalyRow[];
}

/** fork status/pending.ts 的待处理项（固定四行口径）。 */
export interface PaoPendingItem {
  readonly 类型: string;
  readonly 主体: string;
  readonly 为什么停: string;
  readonly 要决定什么: string;
  readonly 建议: string;
  readonly 证据: readonly string[];
  /** 卡侧项的归属部门（卡面原值）；实例/异常项缺省。 */
  readonly 部门?: string;
}

/**
 * fork collectPending 的限额覆盖（全部可选，原样透传给构建产物）。
 * 桌面看板取全量传大值；缺省与 fork 内部默认一致。
 */
export interface PaoPendingLimits {
  readonly itemLimit?: number;
  readonly instanceGateLimit?: number;
  readonly cardItemLimit?: number;
}

/** 桌面看板一次拉取所需的三个只读聚合。零落盘；status 两件为动态加载故为异步。 */
export interface PaoWorkboardAggregates {
  deptBacklog(home: string): Promise<DeptBacklogRow[]>;
  workflowInstances(home: string): Promise<PaoWorkflowInstanceScan>;
  pending(home: string, limits?: PaoPendingLimits): Promise<PaoPendingItem[]>;
}

/** 动态加载公开入口并返回三个只读聚合；加载失败抛错，由调用方降级为不可用。 */
export async function loadPaoWorkboardAggregates(): Promise<PaoWorkboardAggregates> {
  const module = await loadPaoDesktopModule();
  const { scanWorkflowInstancesFresh, collectPendingFresh } = module;
  if (typeof deptBacklogSnapshot !== "function")
    throw new Error("PAO 构建产物缺少看板入口 deptBacklogSnapshot。");
  if (typeof scanWorkflowInstancesFresh !== "function")
    throw new Error("PAO 构建产物缺少看板入口 scanWorkflowInstancesFresh。");
  if (typeof collectPendingFresh !== "function")
    throw new Error("PAO 构建产物缺少看板入口 collectPendingFresh。");
  return {
    deptBacklog: async (home) => deptBacklogSnapshot(home),
    workflowInstances: async (home) => scanWorkflowInstancesFresh(home),
    pending: async (home, limits) => collectPendingFresh(home, limits),
  };
}
