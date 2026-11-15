/**
 * PAO 工作看板只读聚合出口（桌面 P3 首件）：把本地 PAO fork 已有的同步聚合函数
 * 收拢成一个加载点，桌面壳一次 IPC 拉取三段数据（部门积压／挂起与异常工作流实例／
 * 待处理事项），不在桌面层重造解析。
 *
 * fork 的包入口（./pao）直接导出 deptBacklogSnapshot；status 两件
 * （workflow-instances／pending）未列入包 exports，只能按构建产物的真实路径深引——
 * 从 ./pao 入口的落盘位置反推 dist/pao 目录，再以 file URL 动态 import 构建产物，
 * 绝不引 fork 源码、不写任何文件、不缓存数据。
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { deptBacklogSnapshot, type DeptBacklogRow } from "@earendil-works/pi-coding-agent/pao";

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

function resolvePaoEntryPath(): string {
  const resolve = (import.meta as ImportMeta & { resolve?: (specifier: string) => string })
    .resolve;
  if (typeof resolve !== "function") {
    throw new Error("import.meta.resolve is unavailable in this runtime.");
  }
  return fileURLToPath(resolve("@earendil-works/pi-coding-agent/pao"));
}

/** ./pao 入口（dist/pao/index.js）所在目录即 fork 构建产物的 dist/pao。 */
function forkPaoDistDir(): string {
  return dirname(resolvePaoEntryPath());
}

async function loadWorkflowInstanceScan(home: string): Promise<PaoWorkflowInstanceScan> {
  const module = (await import(
    pathToFileURL(join(forkPaoDistDir(), "status", "workflow-instances.js")).href
  )) as {
    scanWorkflowInstances?: (paoHome: string) => PaoWorkflowInstanceScan;
  };
  if (typeof module.scanWorkflowInstances !== "function") {
    throw new Error("scanWorkflowInstances is not available in the PAO build products.");
  }
  return module.scanWorkflowInstances(home);
}

async function loadPendingItems(home: string, limits?: PaoPendingLimits): Promise<PaoPendingItem[]> {
  const module = (await import(
    pathToFileURL(join(forkPaoDistDir(), "status", "pending.js")).href
  )) as {
    collectPending?: (paoHome: string, options?: PaoPendingLimits) => PaoPendingItem[];
  };
  if (typeof module.collectPending !== "function") {
    throw new Error("collectPending is not available in the PAO build products.");
  }
  return module.collectPending(home, limits);
}

/** 动态加载 fork 构建产物并返回三个只读聚合；加载失败抛错，由调用方降级为不可用。 */
export async function loadPaoWorkboardAggregates(): Promise<PaoWorkboardAggregates> {
  // 静态引入已在模块图里，这里仅为把入口失败与两件深引失败放进同一个加载点。
  if (typeof deptBacklogSnapshot !== "function") {
    throw new Error("deptBacklogSnapshot is not available in the PAO build products.");
  }
  return {
    deptBacklog: async (home) => deptBacklogSnapshot(home),
    workflowInstances: (home) => loadWorkflowInstanceScan(home),
    pending: (home, limits) => loadPendingItems(home, limits),
  };
}
