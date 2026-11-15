/**
 * 画布 DAG 纯函数层（P4-2，设计包 §1.2）：分层布局（拓扑层×从左到右）＋节点状态着色。
 * 只输出坐标/分层/边，交给 ReactFlow 渲染；旧配方摘要保留只读后备视图。
 * 实例清单永不反向成为任务真相：状态着色一律以传入的卡现读值为准。
 */
import type {
  CanvasInstanceRow,
  CanvasNodeTemplate,
  CanvasRecipeSummary,
  CanvasResult,
  CanvasSnapshot,
  CanvasViewEnvelope,
} from "../../../contracts/canvas";

/** 节点状态色板（未落卡灰/进行中蓝/已交付绿/人工门等待黄/挂起橙/读取异常红）。 */
export type CanvasNodeTone = "grey" | "blue" | "green" | "yellow" | "orange" | "red";

export interface CanvasNodeView {
  readonly position?: { readonly x: number; readonly y: number };
  readonly name: string;
  readonly dept: string;
  readonly dependsOn: readonly string[];
  readonly requiresConfirmation: boolean;
  readonly model?: string;
  readonly thinkingLevel?: string;
  /** 卡现读状态；模板节点（未跑实例）缺省＝无卡灰。 */
  readonly status?: string;
  readonly cardRef?: string;
  readonly suspended?: string;
  readonly confirmation?: string;
  readonly sessionId?: string;
}

/**
 * 着色判定（v1 口径，挂起原因里带「人工」＝人工门等待黄，其余挂起橙；
 * 失败卡与读取异常同为红色警示；无卡/待认领/取消/未知一律灰）。
 * 值域单域英文（S10 单源化 2026-10-08：内核 controlView 投影 delivered/in_progress/
 * no_card＋坏卡卡面英文透传），另有 v1 旧实例本地态「读取异常」。
 */
export function canvasNodeTone(node: {
  readonly status?: string;
  readonly suspended?: string;
}): CanvasNodeTone {
  const status = node.status ?? "no_card";
  if (status === "读取异常" || status === "failed") return "red";
  if (node.suspended !== undefined) {
    return node.suspended.includes("人工") ? "yellow" : "orange";
  }
  if (status === "delivered") return "green";
  if (status === "in_progress") return "blue";
  return "grey";
}

/** 卡状态显示名：英文值映射回中文（含 S10 投影 no_card）；「读取异常」等原样透传。 */
const CARD_STATUS_LABELS: Readonly<Record<string, string>> = {
  unclaimed: "待认领",
  in_progress: "进行中",
  delivered: "已交付",
  failed: "失败",
  canceled: "取消",
  no_card: "未落卡",
};

export function cardStatusLabel(status: string | undefined): string {
  if (status === undefined) return "";
  return CARD_STATUS_LABELS[status] ?? status;
}

/** 画布几何常量（px）：节点框尺寸＋层间/行间距＋内边距，坐标全部由此推出。 */
export const CANVAS_NODE_WIDTH = 176;
export const CANVAS_NODE_HEIGHT = 68;
export const CANVAS_COLUMN_GAP = 64;
export const CANVAS_ROW_GAP = 18;
export const CANVAS_PADDING = 12;

export interface CanvasLayoutEdge {
  readonly from: string;
  readonly to: string;
  /** 回边＝指向更早（或同层）依赖的边，渲染为虚线。 */
  readonly back: boolean;
}

export interface CanvasLayoutBox {
  readonly name: string;
  readonly dept: string;
  readonly layer: number;
  readonly row: number;
  readonly x: number;
  readonly y: number;
  readonly tone: CanvasNodeTone;
  readonly node: CanvasNodeView;
}

export interface CanvasLayout {
  readonly boxes: readonly CanvasLayoutBox[];
  readonly edges: readonly CanvasLayoutEdge[];
  readonly width: number;
  readonly height: number;
}

/**
 * 分层布局：layer(n)＝最长路径深度（只统计画布内存在的依赖；成环依赖用访问栈守卫，
 * 环上依赖不参与深度以免死循环——好配方本不该成环，坏输入兜底不炸）。同层行序＝输入序。
 */
export function computeCanvasLayout(nodes: readonly CanvasNodeView[]): CanvasLayout {
  const byName = new Map<string, CanvasNodeView>();
  for (const node of nodes) {
    if (!byName.has(node.name)) byName.set(node.name, node);
  }
  const layerByName = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (name: string): number => {
    const known = layerByName.get(name);
    if (known !== undefined) return known;
    if (visiting.has(name)) return 0; // 环兜底：不展开
    visiting.add(name);
    const node = byName.get(name);
    let depth = 0;
    if (node) {
      for (const dep of node.dependsOn) {
        if (!byName.has(dep)) continue; // 画布外依赖（如清单只记了部分节点）不参与分层
        depth = Math.max(depth, depthOf(dep) + 1);
      }
    }
    visiting.delete(name);
    layerByName.set(name, depth);
    return depth;
  };
  for (const name of byName.keys()) depthOf(name);

  const rowsPerLayer = new Map<number, number>();
  const boxes = nodes.map((node) => {
    const layer = layerByName.get(node.name) ?? 0;
    const row = rowsPerLayer.get(layer) ?? 0;
    rowsPerLayer.set(layer, row + 1);
    return {
      name: node.name,
      dept: node.dept,
      layer,
      row,
      x: node.position?.x ?? CANVAS_PADDING + layer * (CANVAS_NODE_WIDTH + CANVAS_COLUMN_GAP),
      y: node.position?.y ?? CANVAS_PADDING + row * (CANVAS_NODE_HEIGHT + CANVAS_ROW_GAP),
      tone: canvasNodeTone(node),
      node,
    };
  });

  const edges: CanvasLayoutEdge[] = [];
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (!byName.has(dep)) continue;
      const from = layerByName.get(dep) ?? 0;
      const to = layerByName.get(node.name) ?? 0;
      edges.push({ from: dep, to: node.name, back: from >= to });
    }
  }

  const columns = Math.max(0, ...[...rowsPerLayer.keys()]) + 1;
  const maxRows = Math.max(1, ...rowsPerLayer.values());
  return {
    boxes,
    edges,
    width: Math.max(
      CANVAS_PADDING * 2 + columns * CANVAS_NODE_WIDTH + (columns - 1) * CANVAS_COLUMN_GAP,
      ...boxes.map((box) => box.x + CANVAS_NODE_WIDTH + CANVAS_PADDING),
    ),
    height: Math.max(
      CANVAS_PADDING * 2 + maxRows * CANVAS_NODE_HEIGHT + (maxRows - 1) * CANVAS_ROW_GAP,
      ...boxes.map((box) => box.y + CANVAS_NODE_HEIGHT + CANVAS_PADDING),
    ),
  };
}

function templateView(template: CanvasNodeTemplate): CanvasNodeView {
  return {
    name: template.name,
    dept: template.dept,
    dependsOn: template.dependsOn,
    requiresConfirmation: template.requiresConfirmation,
    ...(template.model !== undefined ? { model: template.model } : {}),
    ...(template.thinkingLevel !== undefined ? { thinkingLevel: template.thinkingLevel } : {}),
  };
}

/** 配方模板节点（未跑实例）：全部无卡灰，带模型/思考强度/人工确认模板值。 */
export function recipeDagNodes(recipe: CanvasRecipeSummary): CanvasNodeView[] {
  return recipe.nodes.map((node) => ({
    ...templateView(node),
    ...(recipe.ui?.positions[node.name] ? { position: recipe.ui.positions[node.name] } : {}),
  }));
}

/**
 * 实例节点：配方结构（分层＋depends_on）为骨，清单映射＋卡现读状态为肉——
 * 配方缺该节点（改配方后跑的旧实例）时按清单补占位节点；配方不可读（undefined）
 * 时退化为清单-only（无 depends_on，全部同层）。
 */
export function instanceDagNodes(
  instance: CanvasInstanceRow,
  recipe: CanvasRecipeSummary | undefined,
): CanvasNodeView[] {
  const listed = new Map(instance.nodes.map((node) => [node.name, node]));
  const views: CanvasNodeView[] = [];
  const seen = new Set<string>();
  for (const template of recipe?.nodes ?? []) {
    seen.add(template.name);
    const live = listed.get(template.name);
    views.push({
      ...templateView(template),
      ...(recipe?.ui?.positions[template.name]
        ? { position: recipe.ui.positions[template.name] }
        : {}),
      ...(live ?? { status: "no_card" }),
    });
  }
  for (const node of instance.nodes) {
    if (seen.has(node.name)) continue;
    views.push({
      name: node.name,
      dept: "",
      dependsOn: [],
      requiresConfirmation: false,
      status: node.status,
      ...(node.cardRef !== undefined ? { cardRef: node.cardRef } : {}),
      ...(node.suspended !== undefined ? { suspended: node.suspended } : {}),
      ...(node.confirmation !== undefined ? { confirmation: node.confirmation } : {}),
      ...(node.sessionId !== undefined ? { sessionId: node.sessionId } : {}),
    });
  }
  return views;
}

/** 实例只读自己的冻结图；缺失时不借用最新配方。 */
export function recipeForInstance(
  _snapshot: CanvasSnapshot,
  instance: CanvasInstanceRow,
): CanvasRecipeSummary | undefined {
  return instance.frozenRecipe;
}

/** 实例定位输入：左侧选中项（配方或实例）。 */
export interface CanvasInstanceSelection {
  readonly kind: string;
  readonly name: string;
  readonly path?: string;
}

export interface CanvasInstanceResolution {
  readonly instance?: CanvasInstanceRow;
  /** 多个同名实例且未带路径：不可猜，UI 必须提示用户从配方库明确选择。 */
  readonly ambiguous: boolean;
}

/**
 * 同名多实例、旧标签又没带路径时的统一提示：不猜第一个，让用户从配方库明确选择。
 * 与实例行一一对应；向导启动路径也有一致口径（发现多个同名实例不自动猜选）。
 */
export const AMBIGUOUS_INSTANCE_MESSAGE =
  "该运行记录名对应多个运行记录，无法确定是哪一个；请在左侧工作流库中重新选择具体运行记录。";

/**
 * 实例定位（唯一口径）：带路径按路径精确匹配；无路径只在同名唯一时回退。
 * 同名多实例时不读第一个，返回 ambiguous＝true，由调用方提示用户明确选择。
 */
export function resolveInstance(
  instances: readonly CanvasInstanceRow[],
  selection: CanvasInstanceSelection,
): CanvasInstanceResolution {
  if (selection.kind !== "instance") return { ambiguous: false };
  const matches = instances.filter((row) =>
    selection.path ? row.path === selection.path : row.name === selection.name,
  );
  if (matches.length === 1) return { instance: matches[0], ambiguous: false };
  return { ambiguous: matches.length > 1 };
}

/**
 * 启动成功后定位新运行记录（S6-D1）：同名工作流、启动前快照里没有的路径、
 * 且落在当前项目根内。before 集合存的是上次快照的原始路径（同源同形态，按原串比较）；
 * 项目根比较做反斜杠→正斜杠＋小写归一（Windows 现场两源格式不保证一致）。
 */
export function locateNewInstances(
  instances: readonly CanvasInstanceRow[],
  workflow: string,
  beforePaths: ReadonlySet<string>,
  projectRoot: string,
): CanvasInstanceRow[] {
  const root = projectRoot.replace(/\\/g, "/").toLowerCase().replace(/\/$/, "") + "/";
  return instances.filter(
    (row) =>
      row.workflow === workflow &&
      !beforePaths.has(row.path) &&
      row.path.replace(/\\/g, "/").toLowerCase().startsWith(root),
  );
}

/**
 * 实例失败可见性（S6-D1）：卡现读「失败」的节点名单。实例级状态字段
 * （运行中/挂起/已完成）不含失败——挂起可能正来自卡失败，不点名就是静默；
 * 「读取异常」是读取问题，如实红着色但不冒充失败。
 */
export function instanceFailedNodes(instance: CanvasInstanceRow): string[] {
  return instance.nodes.filter((node) => node.status === "failed").map((node) => node.name);
}

// ── 视图信封消费（S6-D2，K4 冻结契约） ────────────────────────────────────────
// 指纹算法（sessionGenerationOf/contentRevisionOf）只在内核，桌面不自实现；renderer
// 只做相等性比对。经 pi-sdk-driver loader 取内核原函数的桥已随 K4D2 审 P3-3 删除
// （零调用预留面；正本＝commit 782c706 的 pao-view-envelope.ts，事件订阅通道落地时再接）。

/** 已采纳/到达快照的信封基准：信封缺省（旧内核 dist）＝两字段都缺省。 */
export interface CanvasEnvelopeBaseline {
  readonly sessionGeneration?: string;
  readonly revision?: string;
}

/**
 * 画布到达判定：① requestId 竞速守卫（与 kanban/workboard 同款语义）——非当前请求＝
 * 竞速旧响应，作废（换代际后的旧请求同此作废）；② 信封指纹去重——同代际同 revision
 * ＝内容未变（revision 不含时间，publishedAt 变化不算），跳过提交不触发渲染更新。
 * 信封缺省＝不做去重（每次照常提交）。
 */
export function canvasArrivalPlan(input: {
  readonly requestId: number;
  readonly latestRequestId: number;
  readonly arrival: CanvasEnvelopeBaseline;
  readonly baseline: CanvasEnvelopeBaseline;
}): "commit" | "dedupe" | "drop" {
  if (input.requestId !== input.latestRequestId) return "drop";
  if (
    input.arrival.sessionGeneration !== undefined &&
    input.arrival.revision !== undefined &&
    input.arrival.sessionGeneration === input.baseline.sessionGeneration &&
    input.arrival.revision === input.baseline.revision
  ) {
    return "dedupe";
  }
  return "commit";
}

/** 查询结果的信封基准：unavailable 或无信封＝空基准（未知不拒、不去重）。 */
export function canvasBaselineOf(result: CanvasResult): CanvasEnvelopeBaseline {
  if (result.state !== "available") return {};
  const envelope: CanvasViewEnvelope | undefined = result.envelope;
  return {
    ...(envelope ? { sessionGeneration: envelope.sessionGeneration } : {}),
    ...(envelope ? { revision: envelope.revision } : {}),
  };
}
