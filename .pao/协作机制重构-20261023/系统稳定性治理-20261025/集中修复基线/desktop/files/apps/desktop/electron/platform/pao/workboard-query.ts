/**
 * PAO 工作看板查询桥（只读）：一次调用返回三段聚合＋整体 ok/unavailable 状态。
 * 与 git-review 同一口径——所有失败都落成可展示的错误/不可用结果，绝不把异常
 * 抛到主进程顶层（历史事故：无守卫扫描崩宿主弹框），也绝不把失败伪装成空列表。
 *
 * 数据整形函数（normalize*）单独导出：fork 行结构校验失败＝该段显式 error，
 * 不是空。聚合函数本体来自 @pi-gui/pi-sdk-driver 的 re-export 包装（fork 构建
 * 产物），惰性动态加载；不写任何文件、不轮询、不缓存，渲染层打开视图拉一次。
 */
import type {
  WorkboardDeptRow,
  WorkboardInstanceAnomalyRow,
  WorkboardPendingItemRow,
  WorkboardResult,
  WorkboardSection,
  WorkboardSnapshot,
  WorkboardSuspendedInstanceRow,
  WorkboardUnavailable,
  WorkboardUnavailableCode,
} from "../../../contracts/workboard";
import { asText, checkPaoHome, loadDriver } from "./bridge-common";
import type { PaoPendingLimits, PaoWorkboardAggregates } from "@pi-gui/pi-sdk-driver";

function issue(code: WorkboardUnavailableCode, message: string): WorkboardUnavailable {
  return { state: "unavailable", code, message };
}

/**
 * 待处理段全量拉取：三个 fork 内部限额全放到顶（桌面看板是全量台账视图,不做首跑清单式截断）。
 * 只影响本次拉取的聚合参数,不改 fork 默认行为;上限数值即 JS 安全整数上界,fork 端 slice 安全。
 */
const FULL_PENDING_LIMITS: PaoPendingLimits = {
  itemLimit: Number.MAX_SAFE_INTEGER,
  instanceGateLimit: Number.MAX_SAFE_INTEGER,
  cardItemLimit: Number.MAX_SAFE_INTEGER,
};

/** Load the fork aggregation re-exports; overridable so unit tests stay hermetic. */
async function loadDefaultAggregates(): Promise<PaoWorkboardAggregates> {
  return (await loadDriver("loadPaoWorkboardAggregates"))();
}

export interface WorkboardQueryOptions {
  /** Overrides process.env.PAO_HOME (tests). */
  readonly paoHome?: string;
  /** Overrides the lazy driver import (tests). */
  readonly loadAggregates?: () => Promise<PaoWorkboardAggregates>;
}

export interface WorkboardQuery {
  /** Never throws; every failure is part of the returned result. */
  collect(): Promise<WorkboardResult>;
}

/** 部门积压行整形：非数组＝抛错（调用方落段错误）；坏行剔除，不静默当空。 */
export function normalizeDeptRows(value: unknown): WorkboardDeptRow[] {
  if (!Array.isArray(value)) throw new Error("Department backlog data is not a list.");
  const rows: WorkboardDeptRow[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const dept = asText(record["部门"]).trim();
    if (!dept) continue;
    const rawWarnings = Array.isArray(record["警示"]) ? record["警示"] : [];
    rows.push({
      dept,
      pendingValidation:
        typeof record["待验证"] === "number" && Number.isFinite(record["待验证"])
          ? record["待验证"]
          : Number(record["待验证"]) || 0,
      warnings: rawWarnings.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const warning = item as Record<string, unknown>;
        const area = asText(warning["area"]);
        const count = typeof warning["count"] === "number" ? warning["count"] : 0;
        return area ? [{ area, count }] : [];
      }),
    });
  }
  return rows;
}

export interface NormalizedInstanceScan {
  readonly suspended: WorkboardSuspendedInstanceRow[];
  readonly anomalies: WorkboardInstanceAnomalyRow[];
}

/** 工作流实例扫描整形（挂起＋异常两段同源，一段坏不拖另一段）。 */
export function normalizeInstanceScan(value: unknown): NormalizedInstanceScan {
  if (!value || typeof value !== "object") {
    throw new Error("Workflow instance scan data is not an object.");
  }
  const record = value as Record<string, unknown>;
  const suspended: WorkboardSuspendedInstanceRow[] = [];
  if (Array.isArray(record["挂起"])) {
    for (const entry of record["挂起"]) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as Record<string, unknown>;
      const workflow = asText(row["工作流"]);
      const path = asText(row["路径"]);
      if (!workflow && !path) continue;
      suspended.push({ workflow, project: asText(row["项目"]), path });
    }
  }
  const anomalies: WorkboardInstanceAnomalyRow[] = [];
  if (Array.isArray(record["异常"])) {
    for (const entry of record["异常"]) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as Record<string, unknown>;
      const path = asText(row["路径"]);
      const file = asText(row["文件"]);
      if (!path && !file) continue;
      anomalies.push({ path, file, reason: asText(row["原因"]) });
    }
  }
  return { suspended, anomalies };
}

/** 待处理项整形：保持固定四行口径，证据非字符串项剔除；部门（卡侧项）原值透传供定位。 */
export function normalizePendingItems(value: unknown): WorkboardPendingItemRow[] {
  if (!Array.isArray(value)) throw new Error("Pending item data is not a list.");
  const rows: WorkboardPendingItemRow[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const subject = asText(row["主体"]).trim();
    if (!subject) continue;
    const evidence = Array.isArray(row["证据"])
      ? row["证据"].flatMap((item) => (typeof item === "string" && item.length > 0 ? [item] : []))
      : [];
    const dept = asText(row["部门"]).trim();
    rows.push({
      kind: asText(row["类型"]),
      subject,
      whyStopped: asText(row["为什么停"]),
      decisionNeeded: asText(row["要决定什么"]),
      suggestion: asText(row["建议"]),
      evidence,
      ...(dept ? { dept } : {}),
    });
  }
  return rows;
}

/** 单段聚合：成功整形成 rows，任何抛错（含 fork 聚合与整形校验）落成段 error。 */
async function collectSection<T>(
  run: () => Promise<T[]>,
): Promise<WorkboardSection<T>> {
  try {
    return { kind: "rows", rows: await run() };
  } catch (error) {
    return {
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function createWorkboardQuery(options: WorkboardQueryOptions = {}): WorkboardQuery {
  return {
    async collect(): Promise<WorkboardResult> {
      const home = await checkPaoHome(options.paoHome);
      if (typeof home !== "string") return home;
      let aggregates: PaoWorkboardAggregates;
      try {
        aggregates = await (options.loadAggregates ?? loadDefaultAggregates)();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return issue("aggregates-unavailable", reason);
      }
      // 挂起与异常同源于一次实例扫描，一次失败两段同报，不冒充空闲。
      let instanceScan: Promise<NormalizedInstanceScan> | undefined;
      const scanOnce = () => {
        instanceScan ??= aggregates
          .workflowInstances(home)
          .then((scan) => normalizeInstanceScan(scan));
        return instanceScan;
      };
      const snapshot: WorkboardSnapshot = {
        state: "available",
        departments: await collectSection(async () =>
          normalizeDeptRows(await aggregates.deptBacklog(home)),
        ),
        suspendedInstances: await collectSection(async () => (await scanOnce()).suspended),
        instanceAnomalies: await collectSection(async () => (await scanOnce()).anomalies),
        pendingItems: await collectSection(async () =>
          normalizePendingItems(await aggregates.pending(home, FULL_PENDING_LIMITS)),
        ),
      };
      return snapshot;
    },
  };
}
