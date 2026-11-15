/**
 * PAO 工作流画布查询桥（只读，P4-2）：一次调用返回画布整页数据＋整体 ok/unavailable
 * 状态。与 workboard-query 同一口径——所有失败都落成可展示的错误/不可用结果，绝不把
 * 异常抛到主进程顶层，也绝不把失败伪装成空列表。
 *
 * 数据整形函数（normalize*）单独导出：fork 行结构校验失败＝显式 error，不是空。
 * readDesktopCanvas 来自 @pi-gui/pi-sdk-driver 的 re-export 包装（fork 构建产物），
 * 惰性动态加载；不写任何文件、不轮询、不缓存，渲染层打开视图拉一次。
 */
import { realpathSync } from "node:fs";
import { desktopPathKey } from "../../../contracts/path-identity";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { asText, checkPaoHome, loadDriver, reasonOf } from "./bridge-common";
import type {
  CanvasAnomalyRow,
  CanvasInstanceRow,
  CanvasNodeDetailData,
  CanvasNodeDetailResult,
  CanvasNodeExecutionRef,
  CanvasNodeInstanceRow,
  CanvasNodeReceiptRound,
  CanvasNodeSessionStats,
  CanvasNodeUsage,
  CanvasNodeUsageTotal,
  CanvasParallelGroup,
  CanvasRecipeEntry,
  CanvasRecipeSummary,
  CanvasResult,
  CanvasSnapshot,
  CanvasUnavailable,
  CanvasUnavailableCode,
  CanvasViewEnvelope,
} from "../../../contracts/canvas";
import type {
  PaoDesktopCanvasReader,
  PaoDesktopCard,
  PaoDesktopExecution,
  PaoDesktopNodeDetailReader,
  PaoDesktopRuntimeReader,
  PaoDesktopSessionIncrement,
} from "@pi-gui/pi-sdk-driver";

function issue(code: CanvasUnavailableCode, message: string): CanvasUnavailable {
  return { state: "unavailable", code, message };
}

/** Load the fork canvas reader re-export; overridable so unit tests stay hermetic. */
async function loadDefaultReader(): Promise<PaoDesktopCanvasReader> {
  return (await loadDriver("loadPaoDesktopCanvas"))();
}

/** Load the fork D8d node detail reader re-export; overridable so unit tests stay hermetic. */
async function loadDefaultDetailReader(): Promise<PaoDesktopNodeDetailReader> {
  return (await loadDriver("loadPaoDesktopNodeDetail"))();
}

/** Load the fork runtime read model (cards + exec mapping + session increment); overridable in tests. */
async function loadDefaultRuntimeReader(): Promise<PaoDesktopRuntimeReader> {
  return (await loadDriver("loadPaoDesktopRuntimeReader"))();
}

export interface CanvasQueryOptions {
  /** Overrides process.env.PAO_HOME (tests). */
  readonly paoHome?: string;
  /** Overrides the lazy driver import (tests). */
  readonly loadReader?: () => Promise<PaoDesktopCanvasReader>;
  /** Overrides the lazy D8d reader import (tests). */
  readonly loadDetailReader?: () => Promise<PaoDesktopNodeDetailReader>;
  /** Overrides the lazy runtime read-model import (tests). */
  readonly loadRuntimeReader?: () => Promise<PaoDesktopRuntimeReader>;
}

export interface CanvasQuery {
  /** Never throws; every failure is part of the returned result. */
  collect(): Promise<CanvasResult>;
  /** D8d 节点详情深读；失败落 failed 结果，不抛顶层。 */
  readNodeDetail(
    instancePath: string,
    nodeName: string,
    cardRef?: string,
  ): Promise<CanvasNodeDetailResult>;
}

/** 配方节点概要整形：缺名字/部门的坏行剔除，不静默当有效模板。 */
function normalizeNodeTemplate(value: unknown):
  | {
      name: string;
      dept: string;
      dependsOn: string[];
      requiresConfirmation: boolean;
      model?: string;
      thinkingLevel?: string;
      parallelGroupId?: string;
      branchId?: string;
      joinId?: string;
      reviewEdges?: { target: string; limit: number; overflowAction: "停滞" | "修完这轮放行" }[];
    }
  | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const name = asText(record["名字"]).trim();
  const dept = asText(record["部门"]).trim();
  if (!name || !dept) return undefined;
  const dependsOn = Array.isArray(record["depends_on"])
    ? record["depends_on"].flatMap((item) => {
        const dep = asText(item).trim();
        return dep ? [dep] : [];
      })
    : [];
  const parallelGroupId = asText(record["parallelGroupId"]).trim();
  const branchId = asText(record["branchId"]).trim();
  const joinId = asText(record["joinId"]).trim();
  const reviewEdges = normalizeReviewEdges(record["reviewEdges"]);
  return {
    name,
    dept,
    dependsOn,
    requiresConfirmation: record["人工确认"] === true,
    ...(asText(record["模型"]).trim() ? { model: asText(record["模型"]).trim() } : {}),
    ...(asText(record["思考强度"]).trim()
      ? { thinkingLevel: asText(record["思考强度"]).trim() }
      : {}),
    ...(parallelGroupId ? { parallelGroupId } : {}),
    ...(branchId ? { branchId } : {}),
    ...(joinId ? { joinId } : {}),
    ...(reviewEdges ? { reviewEdges } : {}),
  };
}

/** 审核回边是可选展示元数据；坏行过滤，旧内核缺字段时保持 undefined。 */
function normalizeReviewEdges(
  value: unknown,
): { target: string; limit: number; overflowAction: "停滞" | "修完这轮放行" }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const edges = value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const target = asText(record["target"]).trim();
    const limit = record["limit"];
    const overflowAction = record["overflowAction"];
    if (
      !target ||
      typeof limit !== "number" ||
      !Number.isSafeInteger(limit) ||
      limit < 0 ||
      (overflowAction !== "停滞" && overflowAction !== "修完这轮放行")
    )
      return [];
    const action: "停滞" | "修完这轮放行" = overflowAction;
    return [{ target, limit, overflowAction: action }];
  });
  return edges.length > 0 ? edges : undefined;
}

/** 并行组策略是只读显示元数据；坏组过滤，旧配方缺字段时保持 undefined。 */
function normalizeParallelGroups(value: unknown): CanvasParallelGroup[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const groups = value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const id = asText(record["id"]).trim();
    if (!id) return [];
    const maxConcurrency = record["maxConcurrency"];
    const failurePolicy = record["failurePolicy"];
    const cancelPolicy = record["cancelPolicy"];
    if (
      maxConcurrency !== undefined &&
      (typeof maxConcurrency !== "number" ||
        !Number.isSafeInteger(maxConcurrency) ||
        maxConcurrency < 1)
    )
      return [];
    if (
      failurePolicy !== undefined &&
      failurePolicy !== "fail_fast" &&
      failurePolicy !== "allow_partial" &&
      failurePolicy !== "any_success"
    )
      return [];
    if (
      cancelPolicy !== undefined &&
      cancelPolicy !== "cancel_pending" &&
      cancelPolicy !== "drain_started"
    )
      return [];
    const normalizedFailurePolicy: CanvasParallelGroup["failurePolicy"] =
      failurePolicy === "fail_fast" ||
      failurePolicy === "allow_partial" ||
      failurePolicy === "any_success"
        ? failurePolicy
        : undefined;
    const normalizedCancelPolicy: CanvasParallelGroup["cancelPolicy"] =
      cancelPolicy === "cancel_pending" || cancelPolicy === "drain_started"
        ? cancelPolicy
        : undefined;
    const group: CanvasParallelGroup = {
      id,
      ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
      ...(normalizedFailurePolicy !== undefined ? { failurePolicy: normalizedFailurePolicy } : {}),
      ...(normalizedCancelPolicy !== undefined ? { cancelPolicy: normalizedCancelPolicy } : {}),
    };
    return [group];
  });
  return groups.length > 0 ? groups : undefined;
}

/** 配方摘要整形：节点段坏行剔除；必要字段缺失＝抛错（该配方条目落错误行）。 */
export function normalizeRecipeSummary(value: unknown): CanvasRecipeSummary {
  if (!value || typeof value !== "object") {
    throw new Error("Recipe summary data is not an object.");
  }
  const record = value as Record<string, unknown>;
  const nodes = Array.isArray(record["节点"])
    ? record["节点"].flatMap((item) => {
        const node = normalizeNodeTemplate(item);
        return node ? [node] : [];
      })
    : [];
  const parallelGroups = normalizeParallelGroups(record["parallelGroups"]);
  const version = record["版本"] === 2 ? 2 : 1;
  const topoOrder = Array.isArray(record["拓扑序"])
    ? record["拓扑序"].map((item) => asText(item)).filter((item) => item.trim() !== "")
    : [];
  let ui: CanvasRecipeSummary["ui"];
  if (record.ui !== undefined) {
    if (!record.ui || typeof record.ui !== "object" || Array.isArray(record.ui))
      throw new Error("工作流坐标字段不是映射。");
    const rawPositions = (record.ui as Record<string, unknown>).positions;
    if (!rawPositions || typeof rawPositions !== "object" || Array.isArray(rawPositions))
      throw new Error("工作流节点坐标不是映射。");
    const positions: Record<string, { x: number; y: number }> = {};
    for (const [name, position] of Object.entries(rawPositions)) {
      if (!position || typeof position !== "object" || Array.isArray(position))
        throw new Error(`节点 ${name} 坐标无效。`);
      const point = position as Record<string, unknown>;
      if (
        typeof point.x !== "number" ||
        !Number.isFinite(point.x) ||
        typeof point.y !== "number" ||
        !Number.isFinite(point.y)
      )
        throw new Error(`节点 ${name} 坐标须为有限数。`);
      if (!nodes.some((node) => node.name === name))
        throw new Error(`坐标引用了不存在的节点 ${name}。`);
      Object.defineProperty(positions, name, {
        value: { x: point.x, y: point.y },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    ui = { positions };
  }
  return {
    ...(ui ? { ui } : {}),
    ...(parallelGroups ? { parallelGroups } : {}),
    version,
    autoExecute: record["自动执行"] === true,
    params: Array.isArray(record["参数"])
      ? record["参数"].map((item) => asText(item)).filter((item) => item.trim() !== "")
      : [],
    placeholders: Array.isArray(record["占位符"])
      ? record["占位符"].map((item) => asText(item)).filter((item) => item.trim() !== "")
      : [],
    topoOrder,
    nodes,
  };
}

/** 配方段整形：好配方出摘要、坏配方显错误，两侧都不拖别的条目。 */
export function normalizeRecipeEntries(value: unknown): CanvasRecipeEntry[] {
  if (!Array.isArray(value)) throw new Error("Recipe entry data is not a list.");
  const rows: CanvasRecipeEntry[] = [];
  for (const entry of value) {
    const record = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const name = asText(record["名字"]).trim();
    if (!name) {
      // 与 wizard normalizeCatalog 同口径（S2 验收「坏文件明确报错」）：形状坏的条目
      // 显式上报成错误行，不静默消失；名字缺失时以「未知」占位展示。
      rows.push({
        name: "未知",
        available: false,
        error: {
          code: "形状损坏",
          detail:
            entry && typeof entry === "object"
              ? "配方条目缺名字。"
              : `配方条目不是对象（${typeof entry}）。`,
        },
      });
      continue;
    }
    if (record["可用"] === true) {
      rows.push({ name, available: true, recipe: normalizeRecipeSummary(record["配方"]) });
    } else {
      const error = (record["错误"] ?? {}) as Record<string, unknown>;
      rows.push({
        name,
        available: false,
        error: { code: asText(error["代码"]) || "未知", detail: asText(error["说明"]) },
      });
    }
  }
  return rows;
}

/** 实例节点整形：清单字段＋卡现读状态＋关联键会话锚点原值透传。 */
export function normalizeNodeInstance(value: unknown): CanvasNodeInstanceRow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const name = asText(record["名字"]).trim();
  if (!name) return undefined;
  const cardRef = asText(record["卡号"]).trim();
  const suspended = asText(record["挂起"]).trim();
  const confirmation = asText(record["确认"]).trim();
  const sessionId = asText(record["会话标识"]).trim();
  const sessionPath = asText(record["会话路径"]).trim();
  const sessionState = asText(record["会话状态"]).trim();
  const parallelGroupId = asText(record["parallelGroupId"]).trim();
  const branchId = asText(record["branchId"]).trim();
  const joinId = asText(record["joinId"]).trim();
  const reviewEdges = normalizeReviewEdges(record["reviewEdges"]);
  return {
    name,
    status: asText(record["状态"]).trim() || "no_card", // S10 投影单域英文；空值兜底同域
    ...(cardRef ? { cardRef } : {}),
    ...(Array.isArray(record["卡列表"])
      ? {
          cards: (record["卡列表"] as Record<string, unknown>[]).map((card) => ({
            cardRef: asText(card["卡号"]),
            status: asText(card["状态"]),
            ...(card["错误"] ? { error: asText(card["错误"]) } : {}),
          })),
        }
      : {}),
    ...(suspended ? { suspended } : {}),
    ...(confirmation ? { confirmation } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(sessionPath ? { sessionPath } : {}),
    ...(sessionState ? { sessionState } : {}),
    ...(parallelGroupId ? { parallelGroupId } : {}),
    ...(branchId ? { branchId } : {}),
    ...(joinId ? { joinId } : {}),
    ...(reviewEdges ? { reviewEdges } : {}),
  };
}

/** 实例段整形：单实例坏字段剔除该实例（异常段另有显式行，这里只保好的）。 */
export function normalizeInstances(value: unknown): CanvasInstanceRow[] {
  if (!Array.isArray(value)) throw new Error("Instance data is not a list.");
  const rows: CanvasInstanceRow[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const name = asText(record["名字"]).trim();
    const path = asText(record["路径"]).trim();
    if (!name && !path) continue;
    const params: Record<string, string> = {};
    const rawParams = record["参数"];
    if (rawParams && typeof rawParams === "object" && !Array.isArray(rawParams)) {
      for (const [key, value] of Object.entries(rawParams as Record<string, unknown>)) {
        params[key] = asText(value);
      }
    }
    rows.push({
      name,
      path,
      ...(record.frozenRecipe !== undefined
        ? { frozenRecipe: normalizeRecipeSummary(record.frozenRecipe) }
        : {}),
      ...(asText(record.frozenRecipeError)
        ? { frozenRecipeError: asText(record.frozenRecipeError) }
        : {}),
      workflow: asText(record["工作流"]),
      cardDir: asText(record["卡目录"]),
      startedAt: asText(record["启动"]),
      status: asText(record["状态"]),
      params,
      nodes: Array.isArray(record["节点"])
        ? record["节点"].flatMap((item) => {
            const node = normalizeNodeInstance(item);
            return node ? [node] : [];
          })
        : [],
    });
  }
  return rows;
}

/** 异常行整形：路径/原因至少有其一才保留。 */
export function normalizeAnomalies(value: unknown): CanvasAnomalyRow[] {
  if (!Array.isArray(value)) throw new Error("Anomaly data is not a list.");
  const rows: CanvasAnomalyRow[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const path = asText(record["路径"]).trim();
    const reason = asText(record["原因"]).trim();
    if (!path && !reason) continue;
    rows.push({ path, reason });
  }
  return rows;
}

/**
 * 视图信封整形（S6-D2 透传，K4 冻结契约）：整包兜底——version 必须＝1 且三个字符串字段
 * 非空，任一不满足＝整个信封按未知处理（旧内核 dist 无信封/坏信封都＝undefined，不炸、
 * 不伪装部分信封）。publishedAt 原样透出（不参与指纹，消费方不去重它）。
 */
export function normalizeCanvasEnvelope(value: unknown): CanvasViewEnvelope | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return undefined;
  const sessionGeneration = record.sessionGeneration;
  const revision = record.revision;
  const publishedAt = record.publishedAt;
  if (
    typeof sessionGeneration !== "string" ||
    sessionGeneration.trim() === "" ||
    typeof revision !== "string" ||
    revision.trim() === "" ||
    typeof publishedAt !== "string" ||
    publishedAt.trim() === ""
  ) {
    return undefined;
  }
  return { version: 1, sessionGeneration, revision, publishedAt };
}

/** 整页视图整形：任何一段结构坏＝抛错（调用方落 unavailable，不伪装空画布）。 */
export function normalizeCanvasView(value: unknown): CanvasSnapshot {
  if (!value || typeof value !== "object") {
    throw new Error("Canvas view data is not an object.");
  }
  const record = value as Record<string, unknown>;
  const envelope = normalizeCanvasEnvelope(record["envelope"]);
  const snapshot: CanvasSnapshot = {
    state: "available",
    recipes: normalizeRecipeEntries(record["配方"]),
    instances: normalizeInstances(record["实例"]),
    anomalies: normalizeAnomalies(record["异常"]),
    ...(envelope ? { envelope } : {}),
  };
  const error = asText(record["错误"]).trim();
  if (error) {
    return { ...snapshot, error };
  }
  return snapshot;
}

/** 非负有限数字；缺/坏/负数一律 undefined（不补零，不猜）。 */
function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** 回执用量整形：只认非负有限数；一个都没有＝该回执未记用量。 */
function normalizeUsage(value: unknown): CanvasNodeUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const input = numeric(record.input);
  const output = numeric(record.output);
  const cacheRead = numeric(record.cacheRead);
  const cacheWrite = numeric(record.cacheWrite);
  const cost = numeric(record.cost);
  const turns = numeric(record.turns);
  const toolCalls = numeric(record.toolCalls);
  const unknownRounds = numeric(record["missing_usage_rounds"]);
  const usage: CanvasNodeUsage = {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(cost !== undefined ? { cost } : {}),
    ...(turns !== undefined ? { turns } : {}),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(unknownRounds !== undefined ? { unknownRounds } : {}),
  };
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * 回执轮次行整形：缺尝试号的坏行剔除；产物/证据/用量原样带出（不解析不推断）。
 * 两种线上形态并存：节点详情深读投影（内核 desktop/canvas 保留中文键）与
 * 运行态 ParsedCard 回执（S9 迁移后英文键），逐字段双键取值。
 */
function normalizeReceiptRound(value: unknown): CanvasNodeReceiptRound | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const attempt = record["attempt"] ?? record["尝试号"];
  if (typeof attempt !== "number") return undefined;
  const result = asText(record["result"] ?? record["结果"]).trim();
  const failureType = asText(record["failure_type"] ?? record["失败类型"]).trim();
  const summary = asText(record["summary"] ?? record["摘要"]).trim();
  const archived = asText(record["archive_flag"] ?? record["留档标记"]).trim();
  const worthRecording = asText(record["worth_distilling"] ?? record["值得沉淀"]).trim();
  const evidenceRaw = record["evidence"] ?? record["证据"];
  const evidence = Array.isArray(evidenceRaw)
    ? evidenceRaw.map((item) => asText(item)).filter((item) => item.trim() !== "")
    : [];
  const artifactsRaw = record["artifact_path"] ?? record["产物路径"];
  const artifacts = Array.isArray(artifactsRaw)
    ? artifactsRaw.map((item) => asText(item)).filter((item) => item.trim() !== "")
    : [];
  const usage = normalizeUsage(record["usage"] ?? record["用量"]);
  return {
    attempt,
    time: asText(record["time"] ?? record["时间"]),
    ...(result ? { result } : {}),
    ...(failureType ? { failureType } : {}),
    ...(summary ? { summary } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(usage ? { usage } : {}),
    ...(worthRecording ? { worthRecording } : {}),
    ...(archived ? { archived } : {}),
    ...(evidence.length > 0 ? { evidence } : {}),
  };
}

/** 执行锚点整形：缺执行标识的坏行剔除。 */
function normalizeExecutionRef(value: unknown): CanvasNodeExecutionRef | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const execId = asText(record["执行标识"]).trim();
  if (!execId) return undefined;
  const status = asText(record["映射状态"]).trim();
  const sessionPath = asText(record["会话路径"]).trim();
  const time = asText(record["时间"]).trim();
  return {
    execId,
    source: asText(record["来源"]) || "未知",
    ...(status ? { status } : {}),
    ...(sessionPath ? { sessionPath } : {}),
    ...(time ? { time } : {}),
  };
}

/** 预算整形：非对象值丢弃（卡面/模板两侧同口径，键值原样透传）。 */
function normalizeBudget(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Readonly<Record<string, unknown>>;
}

/** D8d 节点详情整形：结构坏＝抛错（调用方落 failed，不伪装空详情）。 */
export function normalizeNodeDetail(value: unknown): CanvasNodeDetailData {
  if (!value || typeof value !== "object") {
    throw new Error("Node detail data is not an object.");
  }
  const record = value as Record<string, unknown>;
  const node = asText(record["节点"]).trim();
  const instance = asText(record["实例"]).trim();
  if (!node || !instance) {
    throw new Error("Node detail data is missing its node or instance identity.");
  }
  const templateRow =
    record["模板"] && typeof record["模板"] === "object" && !Array.isArray(record["模板"])
      ? (record["模板"] as Record<string, unknown>)
      : undefined;
  const template =
    templateRow && asText(templateRow["部门"]).trim()
      ? {
          dept: asText(templateRow["部门"]).trim(),
          ...(asText(templateRow["模型"]).trim()
            ? { model: asText(templateRow["模型"]).trim() }
            : {}),
          ...(asText(templateRow["档位"]).trim()
            ? { tier: asText(templateRow["档位"]).trim() }
            : {}),
          ...(asText(templateRow["思考强度"]).trim()
            ? { thinkingLevel: asText(templateRow["思考强度"]).trim() }
            : {}),
          ...(normalizeBudget(templateRow["预算"])
            ? { budget: normalizeBudget(templateRow["预算"]) }
            : {}),
          ...(Array.isArray(templateRow["技能"])
            ? {
                skills: templateRow["技能"]
                  .map((item) => asText(item))
                  .filter((item) => item.trim() !== ""),
              }
            : {}),
        }
      : undefined;
  const cardRow =
    record["卡"] && typeof record["卡"] === "object" && !Array.isArray(record["卡"])
      ? (record["卡"] as Record<string, unknown>)
      : undefined;
  const card =
    cardRow && asText(cardRow["卡号"]).trim()
      ? {
          cardRef: asText(cardRow["卡号"]).trim(),
          status: asText(cardRow["状态"]) || "未知",
          attempts: typeof cardRow["尝试"] === "number" ? cardRow["尝试"] : 0,
          created: asText(cardRow["创建"]),
          path: asText(cardRow["路径"]),
          ...(asText(cardRow["档位"]).trim() ? { tier: asText(cardRow["档位"]).trim() } : {}),
          ...(normalizeBudget(cardRow["预算"]) ? { budget: normalizeBudget(cardRow["预算"]) } : {}),
          ...(asText(cardRow["完成"]).trim() ? { completed: asText(cardRow["完成"]).trim() } : {}),
          receipts: Array.isArray(cardRow["回执"])
            ? cardRow["回执"].flatMap((item) => {
                const round = normalizeReceiptRound(item);
                return round ? [round] : [];
              })
            : [],
        }
      : undefined;
  const executions = Array.isArray(record["执行"])
    ? record["执行"].flatMap((item) => {
        const ref = normalizeExecutionRef(item);
        return ref ? [ref] : [];
      })
    : [];
  const tierNote = asText(record["升档理由"]).trim();
  const error = asText(record["错误"]).trim();
  return {
    node,
    instance,
    executions,
    ...(template ? { template } : {}),
    ...(card ? { card } : {}),
    ...(tierNote ? { tierNote } : {}),
    ...(error ? { error } : {}),
  };
}

// ── 运行态补充（readDesktopProject / readDesktopSessionIncrement） ───────────
// 节点详情深读只带模板值与回执子集；输入、产物路径、用量、执行映射的尝试号与会话统计
// 都在内核既有只读模型里。这里只做组合与整形：缺数据不加字段＝界面按「未记录」显示，
// 绝不用默认值/估计补位。会话路径只认 readDesktopProject 已校验的执行记录。

/** 会话统计读取结果：成功给 stats，失败给 error；都不影响执行锚点本身。 */
export interface NodeRuntimeSessionStat {
  readonly stats?: CanvasNodeSessionStats;
  readonly error?: string;
}

/** createCanvasQuery 拉到的运行时真值（纯函数 withNodeRuntime 负责合并）。 */
export interface NodeRuntimeData {
  readonly card?: PaoDesktopCard;
  readonly executions?: readonly PaoDesktopExecution[];
  readonly sessions?: ReadonlyMap<string, NodeRuntimeSessionStat>;
  readonly error?: string;
}

function sessionStatsOf(increment: PaoDesktopSessionIncrement): CanvasNodeSessionStats {
  return {
    responses: increment.本段统计.响应,
    toolCalls: increment.本段统计.工具,
    tokens: increment.本段统计.token,
    unknownUsage: increment.本段统计.未知用量,
    complete: !increment.还有更多 && !increment.末行未完,
    nextOffset: increment.下次偏移,
    more: increment.还有更多,
  };
}

/** "YYYY-MM-DD HH:mm" → 本地毫秒；解析不出 undefined（与 cards/metrics.ts 同口径）。 */
function parseCardMinute(text: unknown): number | undefined {
  if (typeof text !== "string") return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(text.trim());
  if (!match) return undefined;
  const [, y, m, d, h, min] = match;
  return new Date(Number(y), Number(m) - 1, Number(d), Number(h), Number(min)).getTime();
}

/** 创建→完成秒数；任一端未记录/不可解析＝undefined（未记录，不估）。 */
function durationSecondsOf(createdAt: unknown, finishedAt: unknown): number | undefined {
  const start = parseCardMinute(createdAt);
  const end = parseCardMinute(finishedAt);
  if (start === undefined || end === undefined) return undefined;
  return Math.max(0, Math.round((end - start) / 1000));
}

const USAGE_FIELDS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "cost",
  "turns",
  "toolCalls",
] as const;
type UsageField = (typeof USAGE_FIELDS)[number];

/** 回执用量累计：逐字段只加真有记录的数字；缺失/未知轮次进 partial＋note，不填零。 */
function aggregateUsage(
  receipts: readonly CanvasNodeReceiptRound[],
): CanvasNodeUsageTotal | undefined {
  if (receipts.length === 0) return undefined;
  const totals: Record<UsageField, number> = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
    toolCalls: 0,
  };
  const seen = new Set<UsageField>();
  const attemptsWithoutUsage: number[] = [];
  const attemptsWithUnknownRounds: number[] = [];
  let attemptsWithUsage = 0;
  let unknownRounds = 0;
  for (const receipt of receipts) {
    const usage = receipt.usage;
    if (!usage) {
      attemptsWithoutUsage.push(receipt.attempt);
      continue;
    }
    if (usage.unknownRounds !== undefined && usage.unknownRounds > 0) {
      attemptsWithUnknownRounds.push(receipt.attempt);
      unknownRounds += usage.unknownRounds;
    }
    const recorded = USAGE_FIELDS.filter((field) => usage[field] !== undefined);
    if (recorded.length === 0) {
      attemptsWithoutUsage.push(receipt.attempt);
      continue;
    }
    attemptsWithUsage++;
    for (const field of recorded) {
      totals[field] += usage[field]!;
      seen.add(field);
    }
  }
  const partial = attemptsWithoutUsage.length > 0 || attemptsWithUnknownRounds.length > 0;
  const notes: string[] = [];
  if (attemptsWithoutUsage.length > 0)
    notes.push(`尝试 ${attemptsWithoutUsage.join("/")} 未记用量`);
  if (attemptsWithUnknownRounds.length > 0)
    notes.push(`尝试 ${attemptsWithUnknownRounds.join("/")} 有 ${unknownRounds} 轮未回 usage`);
  return {
    ...Object.fromEntries([...seen].map((field) => [field, totals[field]])),
    ...(unknownRounds > 0 ? { unknownRounds } : {}),
    attemptsWithUsage,
    attemptsWithoutUsage,
    attemptsWithUnknownRounds,
    partial,
    ...(notes.length > 0
      ? { note: `${notes.join("；")}；累计只含已记录部分，缺失按未记录计，不做估计。` }
      : {}),
  };
}

/** frontmatter 真值 → 输入字段；缺省键不加，界面据此显示「未记录」。 */
function frontmatterFields(
  frontmatter: PaoDesktopCard["frontmatter"],
): Partial<NonNullable<CanvasNodeDetailData["card"]>> {
  const inputs = frontmatter.inputs?.filter((item) => item.trim() !== "") ?? [];
  const dependsOn = frontmatter.depends_on?.filter((item) => item.trim() !== "") ?? [];
  return {
    ...(frontmatter.goal?.trim() ? { target: frontmatter.goal.trim() } : {}),
    ...(inputs.length > 0 ? { inputs } : {}),
    ...(frontmatter.constraints?.trim() ? { constraints: frontmatter.constraints.trim() } : {}),
    ...(frontmatter.acceptance?.trim() ? { acceptance: frontmatter.acceptance.trim() } : {}),
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
    ...(frontmatter.owner?.trim() ? { owner: frontmatter.owner.trim() } : {}),
  };
}

function cardFromRuntime(
  card: PaoDesktopCard,
  receipts: readonly CanvasNodeReceiptRound[],
): NonNullable<CanvasNodeDetailData["card"]> {
  const frontmatter = card.frontmatter;
  const budget = normalizeBudget(frontmatter.budget);
  const durationSeconds = durationSecondsOf(frontmatter.created, frontmatter.completed);
  return {
    // 卡号四位补零与内核 formatCardNumber（cards/counter.ts，./pao 的 require 出口已补，
    // 主进程 require(esm) 车道实测可通）同体。但 playwright 单测把内核文件按 CJS 转译，
    // 内核图第二跳兄弟工作区包（pi-ai 等）exports 仍只有 import 条件，单测车道仍消费不到，
    // 维持内联（另一份在 renderer kanban-command.ts，渲染层 bundle 不能拖内核 barrel）
    // （S11-导出面微批实测，证据/接线-canvas-node-detail.log）。
    cardRef: `卡${String(card.card_no).padStart(4, "0")}`,
    status: asText(frontmatter.status) || "未知",
    attempts: typeof frontmatter.attempt === "number" ? frontmatter.attempt : 0,
    created: asText(frontmatter.created),
    path: card.path,
    ...(asText(frontmatter.tier).trim() ? { tier: asText(frontmatter.tier).trim() } : {}),
    ...(budget ? { budget } : {}),
    ...(asText(frontmatter.completed).trim()
      ? { completed: asText(frontmatter.completed).trim() }
      : {}),
    ...frontmatterFields(frontmatter),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    receipts,
  };
}

function mergeExecutions(
  base: readonly CanvasNodeExecutionRef[],
  snapshot: readonly PaoDesktopExecution[],
  sessions: ReadonlyMap<string, NodeRuntimeSessionStat> | undefined,
): CanvasNodeExecutionRef[] {
  const merged = new Map<string, CanvasNodeExecutionRef>();
  for (const ref of base) merged.set(ref.execId, { ...ref });
  for (const execution of snapshot) {
    const previous = merged.get(execution.执行标识);
    merged.set(execution.执行标识, {
      ...(previous ?? { execId: execution.执行标识, source: "执行映射" }),
      attempt: execution.尝试,
      current: execution.当前尝试,
      ...(execution.状态 ? { status: execution.状态 } : {}),
      ...(execution.会话路径 ? { sessionPath: execution.会话路径 } : {}),
      ...(execution.时间 ? { time: execution.时间 } : {}),
    });
  }
  return [...merged.values()].map((ref) => {
    const session = sessions?.get(ref.execId);
    if (!session) return ref;
    return {
      ...ref,
      ...(session.stats ? { sessionStats: session.stats } : {}),
      ...(session.error ? { statsError: session.error } : {}),
    };
  });
}

/**
 * 把运行时真值合并进节点详情（纯函数）：卡面 frontmatter、回执产物/用量、
 * 执行映射尝试号/当前尝试、会话日志统计。缺数据一律不加字段＝界面显示「未记录」。
 */
export function withNodeRuntime(
  detail: CanvasNodeDetailData,
  runtime: NodeRuntimeData,
): CanvasNodeDetailData {
  const receipts = runtime.card
    ? [...runtime.card.receipts]
        .sort((a, b) => a.attempt - b.attempt)
        .flatMap((receipt) => {
          const normalized = normalizeReceiptRound(receipt);
          return normalized ? [normalized] : [];
        })
    : (detail.card?.receipts ?? []);
  const card = runtime.card
    ? cardFromRuntime(runtime.card, receipts)
    : detail.card
      ? { ...detail.card, ...(receipts.length > 0 ? { receipts } : {}) }
      : undefined;
  const usage = aggregateUsage(receipts);
  const executions = mergeExecutions(detail.executions, runtime.executions ?? [], runtime.sessions);
  return {
    ...detail,
    ...(card ? { card } : {}),
    ...(usage ? { usage } : {}),
    executions,
    ...(runtime.error ? { runtimeError: runtime.error } : {}),
  };
}

/** 从实例清单路径回溯项目根：找最近一层名为 .pao 的祖先，取其父目录。 */
function projectRootOf(instancePath: string): string | undefined {
  let current = dirname(resolve(instancePath));
  for (;;) {
    if (basename(current) === ".pao") return dirname(current);
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * 路径比较键：真实路径优先（大小写按平台折叠），与 fork locateCardExecutions 同口径。
 * realpath/resolve 保留在主进程；字符串比较规则与运行控制、画布和看板共用。
 */
function pathKey(path: string): string {
  let value = path;
  try {
    value = realpathSync(path);
  } catch {
    // 文件可能刚被移动/删除：退回 resolve，不做存在性断言
  }
  return desktopPathKey(resolve(value), process.platform === "win32");
}

function insideProject(projectRoot: string, candidate: string): boolean {
  const delta = relative(projectRoot, candidate);
  return delta === "" || (!delta.startsWith("..") && !isAbsolute(delta));
}

/** 有则取真实路径（跟随 junction/符号链接），无则退回 resolve；仅用于边界比较。 */
function realpathOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function createCanvasQuery(options: CanvasQueryOptions = {}): CanvasQuery {
  /**
   * 运行态补全：readDesktopProject 取卡面全文与执行映射，逐执行读会话增量统计。
   * 只补「真有的字段」；任一步失败落 runtimeError（基础详情仍 ok），不猜、不填零。
   */
  const attachRuntime = async (
    detail: CanvasNodeDetailData,
    instancePath: string,
  ): Promise<CanvasNodeDetailData> => {
    let runtime: NodeRuntimeData;
    try {
      const reader = await (options.loadRuntimeReader ?? loadDefaultRuntimeReader)();
      const projectRoot = projectRootOf(instancePath);
      if (!projectRoot) throw new Error("运行记录路径不在项目的 .pao 目录下，无法定位运行态数据。");
      const root = realpathOf(projectRoot);
      const cardPath = detail.card?.path;
      const snapshot = await reader.readDesktopProject(root, "桌面只读；owner 见卡面");
      const card = cardPath
        ? snapshot.cards.find((item) => pathKey(item.path) === pathKey(cardPath))
        : undefined;
      const executions = card
        ? snapshot.execution.filter((item) => pathKey(item.卡路径) === pathKey(card.path))
        : [];
      const sessions = new Map<string, NodeRuntimeSessionStat>();
      for (const execution of executions) {
        const sessionPath = execution.会话路径;
        if (!sessionPath) continue;
        if (!insideProject(root, sessionPath)) {
          sessions.set(execution.执行标识, { error: "会话路径越出所属项目，未读取。" });
          continue;
        }
        try {
          sessions.set(execution.执行标识, {
            stats: sessionStatsOf(reader.readDesktopSessionIncrement(sessionPath)),
          });
        } catch (error) {
          sessions.set(execution.执行标识, { error: reasonOf(error) });
        }
      }
      const readProblems = snapshot.issues.map((issue) => `${issue.路径}：${issue.说明}`);
      if (cardPath && !card)
        readProblems.push("当前节点卡未能从运行态数据读回，请刷新并核对卡文件。");
      runtime = {
        ...(card ? { card } : {}),
        executions,
        sessions,
        ...(readProblems.length ? { error: readProblems.join("\n") } : {}),
      };
    } catch (error) {
      runtime = { error: reasonOf(error) };
    }
    return withNodeRuntime(detail, runtime);
  };
  return {
    async collect(): Promise<CanvasResult> {
      const home = await checkPaoHome(options.paoHome);
      if (typeof home !== "string") return home;
      let readCanvas: PaoDesktopCanvasReader;
      try {
        readCanvas = await (options.loadReader ?? loadDefaultReader)();
      } catch (error) {
        return issue("aggregates-unavailable", reasonOf(error));
      }
      try {
        return normalizeCanvasView(readCanvas(home));
      } catch (error) {
        return issue("aggregates-unavailable", reasonOf(error));
      }
    },
    async readNodeDetail(
      instancePath: string,
      nodeName: string,
      cardRef?: string,
    ): Promise<CanvasNodeDetailResult> {
      const home = await checkPaoHome(options.paoHome);
      if (typeof home !== "string") return { state: "failed", message: home.message };
      let readDetail: PaoDesktopNodeDetailReader;
      try {
        readDetail = await (options.loadDetailReader ?? loadDefaultDetailReader)();
      } catch (error) {
        return { state: "failed", message: reasonOf(error) };
      }
      let detail: CanvasNodeDetailData;
      try {
        detail = normalizeNodeDetail(readDetail(home, instancePath, nodeName, cardRef));
      } catch (error) {
        return { state: "failed", message: reasonOf(error) };
      }
      // 基础详情已成形：运行态读取只做增量补全，失败落 runtimeError，不把整体降为 failed。
      return { state: "ok", detail: await attachRuntime(detail, instancePath) };
    },
  };
}
