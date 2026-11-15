/**
 * 工作看板（只读）契约：一次 IPC 拉取三段聚合——部门/项目与卡积压、挂起与异常
 * 工作流实例、待处理事项。数据全部来自 PAO fork 已有聚合函数，桌面层只做整形，
 * 不重造解析、不落盘、不轮询、不缓存。
 *
 * 整体状态二值：available（三段数据，任一段读失败降级为该段的 error，不伪装空）
 * 与 unavailable（PAO home 缺失/不可达/聚合加载失败，message 是可直接展示的原因）。
 */

/** 单段数据：rows 为空就是如实空态；error 是该段读失败的显式行。 */
export type WorkboardSection<T> =
  | { readonly kind: "rows"; readonly rows: readonly T[] }
  | { readonly kind: "error"; readonly message: string };

/** 部门/项目与卡积压行（fork deptBacklogSnapshot 同源）。 */
export interface WorkboardDeptRow {
  readonly dept: string;
  readonly pendingValidation: number;
  readonly warnings: readonly { readonly area: string; readonly count: number }[];
}

/** 挂起的工作流实例行（fork scanWorkflowInstances 的「挂起」段）。 */
export interface WorkboardSuspendedInstanceRow {
  readonly workflow: string;
  readonly project: string;
  readonly path: string;
}

/** 实例异常行（坏字段/读失败/目录不可达——显式上报，不与空闲混同）。 */
export interface WorkboardInstanceAnomalyRow {
  readonly path: string;
  readonly file: string;
  readonly reason: string;
}

/** 待处理项：固定四行口径（为什么停/要决定什么/建议/证据）＋主体标识。 */
export interface WorkboardPendingItemRow {
  readonly kind: string;
  readonly subject: string;
  readonly whyStopped: string;
  readonly decisionNeeded: string;
  readonly suggestion: string;
  readonly evidence: readonly string[];
  /** 卡侧项的归属部门（fork 卡面原值）；实例/异常项缺省——部门积压行据此定位卡条目。 */
  readonly dept?: string;
}

export interface WorkboardSnapshot {
  readonly state: "available";
  readonly departments: WorkboardSection<WorkboardDeptRow>;
  readonly suspendedInstances: WorkboardSection<WorkboardSuspendedInstanceRow>;
  readonly instanceAnomalies: WorkboardSection<WorkboardInstanceAnomalyRow>;
  readonly pendingItems: WorkboardSection<WorkboardPendingItemRow>;
}

export type WorkboardUnavailableCode =
  | "pao-home-missing"
  | "pao-home-unreachable"
  | "pao-home-not-directory"
  | "aggregates-unavailable";

export interface WorkboardUnavailable {
  readonly state: "unavailable";
  readonly code: WorkboardUnavailableCode;
  readonly message: string;
}

export type WorkboardResult = WorkboardSnapshot | WorkboardUnavailable;
