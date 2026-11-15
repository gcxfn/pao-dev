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
import { desktopPathKey } from "../../../contracts/path-identity";

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
  readonly cards?: readonly {
    readonly cardRef: string;
    readonly status: string;
    readonly error?: string;
  }[];
  readonly suspended?: string;
  readonly confirmation?: string;
  readonly sessionId?: string;
  /** 当前实例中的节点未出现在冻结配方里，不能推断其依赖。 */
  readonly unmapped?: boolean;
  /** 仅用于桌面展示的显式分组提示；不参与调度和依赖判断。 */
  readonly visualGroupId?: string;
  readonly visualGroupLabel?: string;
  readonly visualGroupKind?: "stage" | "parallel" | "condition";
  readonly branchId?: string;
  readonly joinId?: string;
  /** 审核退回边；只用于解释运行路径，不参与普通依赖分层。 */
  readonly reviewEdges?: readonly {
    readonly target: string;
    readonly limit: number;
    readonly overflowAction: "停滞" | "修完这轮放行";
  }[];
}

export type CanvasNodeFilter = "all" | "attention" | "running" | "completed" | "pending";

/** 搜索始终作用于真实节点，包含已经折叠的分组成员。 */
export function filterCanvasNodes(
  nodes: readonly CanvasNodeView[],
  query: string,
  filter: CanvasNodeFilter,
): CanvasNodeView[] {
  const text = query.trim().toLocaleLowerCase();
  return nodes.filter((node) => {
    const tone = canvasNodeTone(node);
    const matchesStatus =
      filter === "all" ||
      (filter === "attention" && needsCanvasAttention(node)) ||
      (filter === "running" && tone === "blue") ||
      (filter === "completed" && tone === "green") ||
      (filter === "pending" && tone === "grey");
    return (
      matchesStatus &&
      (!text ||
        [
          node.name,
          node.dept,
          node.cardRef,
          ...(node.cards ?? []).map((card) => card.cardRef),
          node.suspended,
          node.status ? cardStatusLabel(node.status) : "",
        ]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase()
          .includes(text))
    );
  });
}

/** 正常等待前置或落卡不要求人工处理，避免异常定位被整条等待链淹没。 */
export function needsCanvasAttention(node: CanvasNodeView): boolean {
  return (
    node.unmapped === true ||
    node.status === "failed" ||
    node.status === "读取异常" ||
    (node.requiresConfirmation && !node.confirmation && node.status === "delivered") ||
    Boolean(node.suspended && !/^(等待前置|等待落卡|等待绑定)/.test(node.suspended))
  );
}

/** 专注视图沿上下游分别扩展，避免沿汇聚点反查时误把旁支当成上游。 */
export function focusedCanvasNodes(
  nodes: readonly CanvasNodeView[],
  selected: string,
  depth = 1,
): CanvasNodeView[] {
  const current = nodes.find((node) => node.name === selected);
  if (!current) return [...nodes];
  const names = new Set([
    selected,
    ...current.dependsOn,
    ...(current.reviewEdges ?? []).map((edge) => edge.target),
  ]);
  const byName = new Map(nodes.map((node) => [node.name, node]));
  const downstream = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      const children = downstream.get(dependency) ?? [];
      children.push(node.name);
      downstream.set(dependency, children);
    }
  }
  for (const direction of ["up", "down"] as const) {
    const visited = new Set([selected]);
    let frontier = [selected];
    for (let level = 0; level < depth && frontier.length > 0; level++) {
      const next: string[] = [];
      for (const name of frontier) {
        const neighbours = direction === "up" ? byName.get(name)?.dependsOn : downstream.get(name);
        for (const neighbour of neighbours ?? []) {
          if (visited.has(neighbour)) continue;
          visited.add(neighbour);
          names.add(neighbour);
          next.push(neighbour);
        }
      }
      frontier = next;
    }
  }
  for (const node of nodes) {
    if (node.reviewEdges?.some((edge) => edge.target === selected)) names.add(node.name);
  }
  return nodes.filter((node) => names.has(node.name));
}

export interface CanvasOverviewGroup {
  readonly id: string;
  readonly label: string;
  readonly kind: "stage" | "parallel" | "condition";
  readonly members: readonly CanvasNodeView[];
  readonly summary: string;
  readonly tone: CanvasNodeTone;
}

export interface CanvasOverviewItem {
  readonly id: string;
  readonly view: CanvasNodeView;
  readonly group?: CanvasOverviewGroup;
}

export interface CanvasOverviewGraph {
  readonly items: readonly CanvasOverviewItem[];
  readonly edges: readonly CanvasLayoutEdge[];
  readonly groups: readonly CanvasOverviewGroup[];
}

export const COMPACT_OVERVIEW_NODE_COUNT = 8;

/** 大图或收起后的单条主干按行折返；分支图保留 DAG，不猜执行顺序。 */
export function overviewChainOrder(graph: CanvasOverviewGraph): readonly string[] | undefined {
  if (
    graph.items.length < 4 ||
    (graph.items.length < COMPACT_OVERVIEW_NODE_COUNT && !graph.items.some((item) => item.group))
  )
    return undefined;
  const incoming = new Map(graph.items.map((item) => [item.id, 0]));
  const next = new Map<string, string>();
  for (const edge of graph.edges) {
    if (edge.back) continue;
    if (next.has(edge.from)) return undefined;
    next.set(edge.from, edge.to);
    const count = (incoming.get(edge.to) ?? 0) + 1;
    if (count > 1) return undefined;
    incoming.set(edge.to, count);
  }
  const starts = [...incoming].filter(([, count]) => count === 0);
  if (starts.length !== 1) return undefined;
  const order: string[] = [];
  const visited = new Set<string>();
  let current: string | undefined = starts[0]?.[0];
  while (current !== undefined && !visited.has(current)) {
    visited.add(current);
    order.push(current);
    current = next.get(current);
  }
  return order.length === graph.items.length ? order : undefined;
}

function groupTone(members: readonly CanvasNodeView[]): CanvasNodeTone {
  const tones = members.map(overviewNodeTone);
  if (tones.includes("red")) return "red";
  if (tones.includes("orange")) return "orange";
  if (tones.includes("yellow")) return "yellow";
  if (tones.includes("blue")) return "blue";
  if (tones.length > 0 && tones.every((tone) => tone === "green")) return "green";
  return "grey";
}

/** 读取异常是数据可读性问题，不能在压缩组摘要里冒充失败节点。 */
function overviewNodeTone(node: CanvasNodeView): CanvasNodeTone {
  return node.status === "读取异常" ? "grey" : canvasNodeTone(node);
}

function groupSummary(members: readonly CanvasNodeView[]): string {
  const counts = new Map<CanvasNodeTone, number>();
  const readErrorCount = members.filter((member) => member.status === "读取异常").length;
  for (const member of members) {
    const tone = overviewNodeTone(member);
    counts.set(tone, (counts.get(tone) ?? 0) + 1);
  }
  const parts = [`${members.length} 个节点`];
  const branches = new Set(
    members
      .map((member) => member.branchId?.trim())
      .filter((branch): branch is string => Boolean(branch)),
  );
  if (branches.size > 0) parts.push(`${branches.size} 条分支`);
  const labels: readonly [CanvasNodeTone, string][] = [
    ["green", "已完成"],
    ["blue", "进行中"],
    ["yellow", "待确认"],
    ["orange", "已挂起"],
    ["red", "失败"],
    ["grey", "待处理"],
  ];
  for (const [tone, label] of labels) {
    // 读取异常不是执行失败；从灰色“待处理”里拆出来，避免摘要把坏读档
    // 显示成“失败 N”，同时保留普通未落卡节点的待处理计数。
    const count = tone === "grey" ? (counts.get(tone) ?? 0) - readErrorCount : counts.get(tone);
    if (count) parts.push(`${label} ${count}`);
  }
  if (readErrorCount > 0) parts.push(`读取异常 ${readErrorCount}`);
  return parts.join(" · ");
}

function makeGroup(
  id: string,
  label: string,
  kind: CanvasOverviewGroup["kind"],
  members: readonly CanvasNodeView[],
): CanvasOverviewGroup {
  return { id, label, kind, members, summary: groupSummary(members), tone: groupTone(members) };
}

/**
 * 把 DAG 压成安全的树状展示投影：显式 visualGroupId 优先，其余只压缩至少 3 个节点的
 * 单进单出线性段。投影只改变画布显示，原始节点和边始终保留在详细图中。
 */
export function buildCanvasOverview(
  nodes: readonly CanvasNodeView[],
  expandedGroups: ReadonlySet<string> = new Set(),
): CanvasOverviewGraph {
  const byName = new Map(nodes.map((node) => [node.name, node]));
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of nodes) {
    incoming.set(node.name, 0);
    outgoing.set(node.name, []);
  }
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (!byName.has(dep)) continue;
      incoming.set(node.name, (incoming.get(node.name) ?? 0) + 1);
      outgoing.get(dep)?.push(node.name);
    }
  }

  const groups: CanvasOverviewGroup[] = [];
  const memberGroup = new Map<string, CanvasOverviewGroup>();
  const usedIds = new Set(nodes.map((node) => node.name));
  const allocateGroupId = (base: string): string => {
    let id = base;
    let suffix = 2;
    while (usedIds.has(id)) id = `${base}~${suffix++}`;
    usedIds.add(id);
    return id;
  };
  const reviewBoundary = new Set<string>();
  for (const node of nodes) {
    if (node.requiresConfirmation || (node.reviewEdges?.length ?? 0) > 0) {
      reviewBoundary.add(node.name);
    }
    for (const review of node.reviewEdges ?? []) reviewBoundary.add(review.target);
  }
  const explicit = new Map<string, CanvasNodeView[]>();
  for (const node of nodes) {
    if (node.visualGroupId && !reviewBoundary.has(node.name)) {
      const list = explicit.get(node.visualGroupId) ?? [];
      list.push(node);
      explicit.set(node.visualGroupId, list);
    }
  }
  for (const [id, members] of explicit) {
    const first = members[0];
    if (!first) continue;
    const group = makeGroup(
      allocateGroupId(`visual:${id}`),
      first.visualGroupLabel ?? id,
      first.visualGroupKind ?? "stage",
      members,
    );
    groups.push(group);
    for (const member of members) memberGroup.set(member.name, group);
  }

  const visited = new Set<string>();
  const starts = nodes.filter(
    (node) => !memberGroup.has(node.name) && (incoming.get(node.name) ?? 0) !== 1,
  );
  const tryLinear = (start: CanvasNodeView) => {
    if (visited.has(start.name)) return;
    const members: CanvasNodeView[] = [];
    let current: CanvasNodeView | undefined = start;
    while (
      current &&
      !visited.has(current.name) &&
      !memberGroup.has(current.name) &&
      !reviewBoundary.has(current.name)
    ) {
      members.push(current);
      visited.add(current.name);
      const nextNames = outgoing.get(current.name) ?? [];
      const nextName = nextNames[0];
      if (!nextName || nextNames.length !== 1 || (incoming.get(nextName) ?? 0) !== 1) break;
      current = byName.get(nextName);
    }
    if (members.length >= 3) {
      const firstMember = members[0];
      if (!firstMember) return;
      const group = makeGroup(
        allocateGroupId(`linear:${firstMember.name}`),
        `${firstMember.name} → ${members.at(-1)?.name ?? firstMember.name}`,
        "stage",
        members,
      );
      groups.push(group);
      for (const member of members) memberGroup.set(member.name, group);
    }
  };
  for (const node of starts) tryLinear(node);
  for (const node of nodes)
    if (!visited.has(node.name) && !memberGroup.has(node.name)) tryLinear(node);

  // 只有收缩后仍是 DAG 才允许显示组。任意组的成员跨过外部节点形成环时，
  // 保留该组的原节点，避免总览凭空制造循环。
  const isAcyclic = (collapsed: ReadonlySet<CanvasOverviewGroup>): boolean => {
    const projected = new Map<string, Set<string>>();
    const itemOf = (name: string): string => {
      const group = memberGroup.get(name);
      return group && collapsed.has(group) ? group.id : name;
    };
    for (const node of nodes) {
      const to = itemOf(node.name);
      const targets = projected.get(to) ?? new Set<string>();
      projected.set(to, targets);
      for (const dep of node.dependsOn) {
        if (!byName.has(dep)) continue;
        const from = itemOf(dep);
        if (from === to) continue;
        const targets = projected.get(from) ?? new Set<string>();
        targets.add(to);
        projected.set(from, targets);
      }
    }
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (id: string): boolean => {
      if (visiting.has(id)) return false;
      if (done.has(id)) return true;
      visiting.add(id);
      for (const next of projected.get(id) ?? []) if (!visit(next)) return false;
      visiting.delete(id);
      done.add(id);
      return true;
    };
    return [...projected.keys()].every(visit);
  };
  const collapsed = new Set<CanvasOverviewGroup>();
  for (const group of groups) {
    const candidate = new Set(collapsed);
    candidate.add(group);
    if (isAcyclic(candidate)) collapsed.add(group);
  }

  // 大图即使被人工确认或审核边界切断、无法合并，也应独立整理总览。
  // 小图保留冻结位置；详细图始终保留原坐标，不将总览位置写回配方。
  const hasCollapsedGroup = groups.some(
    (group) => collapsed.has(group) && !expandedGroups.has(group.id),
  );
  const useCompactLayout = hasCollapsedGroup || nodes.length >= COMPACT_OVERVIEW_NODE_COUNT;

  const items: CanvasOverviewItem[] = [];
  const itemByNode = new Map<string, string>();
  for (const node of nodes) {
    const group = memberGroup.get(node.name);
    if (group && collapsed.has(group) && !expandedGroups.has(group.id)) {
      itemByNode.set(node.name, group.id);
      continue;
    }
    itemByNode.set(node.name, node.name);
  }
  const added = new Set<string>();
  for (const node of nodes) {
    const group = memberGroup.get(node.name);
    const id =
      group && collapsed.has(group) && !expandedGroups.has(group.id) ? group.id : node.name;
    if (added.has(id)) continue;
    added.add(id);
    if (group && collapsed.has(group) && !expandedGroups.has(group.id)) {
      const synthetic: CanvasNodeView = {
        name: group.id,
        dept:
          group.kind === "parallel" ? "并行组" : group.kind === "condition" ? "条件分支" : "阶段",
        dependsOn: [],
        requiresConfirmation: group.members.some((member) => member.requiresConfirmation),
        status:
          group.tone === "green" ? "delivered" : group.tone === "blue" ? "in_progress" : "no_card",
      };
      items.push({ id, view: synthetic, group });
    } else {
      if (useCompactLayout) {
        // 总览使用独立布局；详情页仍保留原节点 position。
        const { position: _position, ...overviewNode } = node;
        items.push({ id, view: overviewNode });
      } else {
        // 没有压缩组的运行态总览沿用冻结图坐标，避免少量节点被挪到左上角。
        items.push({ id, view: node });
      }
    }
  }
  const edgeSet = new Set<string>();
  const edges: CanvasLayoutEdge[] = [];
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      const from = itemByNode.get(dep);
      const to = itemByNode.get(node.name);
      if (!from || !to || from === to) continue;
      const key = `dependency:${from}->${to}`;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      edges.push({ from, to, back: false });
    }
  }
  // 审核退回是独立的控制边。总览中保留它，避免收起并行组或连续阶段后
  // “为什么回到上游”变成一条看不懂的普通连线；详细图仍会显示完整标签。
  for (const node of nodes) {
    for (const review of node.reviewEdges ?? []) {
      const from = itemByNode.get(node.name);
      const to = itemByNode.get(review.target);
      if (!from || !to || from === to) continue;
      const key = `review:${from}->${to}`;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      edges.push({ from, to, back: true });
    }
  }
  return { items, edges, groups };
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
 * 环上依赖不参与深度以免死循环。同层按前置节点的平均行位排序，同位保留输入顺序。
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
  const rowByName = new Map<string, number>();
  const layers = new Map<number, CanvasNodeView[]>();
  for (const node of nodes) {
    const layer = layerByName.get(node.name) ?? 0;
    const members = layers.get(layer) ?? [];
    members.push(node);
    layers.set(layer, members);
  }
  const lastLayer = Math.max(0, ...layerByName.values());
  // 清单外节点放在单独一列，不能与真实起点混在一起。
  for (const node of nodes) if (node.unmapped) layerByName.set(node.name, lastLayer + 1);
  if (nodes.some((node) => node.unmapped)) {
    layers.clear();
    for (const node of nodes) {
      const layer = layerByName.get(node.name) ?? 0;
      layers.set(layer, [...(layers.get(layer) ?? []), node]);
    }
  }
  for (const [layer, members] of [...layers].sort(([a], [b]) => a - b)) {
    const centre = (node: CanvasNodeView, fallback: number) => {
      const rows = node.dependsOn.flatMap((name) => {
        const row = rowByName.get(name);
        return row === undefined ? [] : [row];
      });
      return rows.length > 0 ? rows.reduce((sum, row) => sum + row, 0) / rows.length : fallback;
    };
    const ordered = members
      .map((node, index) => ({ node, index, centre: centre(node, index) }))
      .sort((a, b) => a.centre - b.centre || a.index - b.index);
    ordered.forEach(({ node }, row) => rowByName.set(node.name, row));
    rowsPerLayer.set(layer, ordered.length);
  }
  const boxes = nodes.map((node) => {
    const layer = layerByName.get(node.name) ?? 0;
    const row = rowByName.get(node.name) ?? 0;
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
    ...(template.parallelGroupId !== undefined
      ? { visualGroupId: template.parallelGroupId, visualGroupLabel: template.parallelGroupId }
      : {}),
    ...(template.parallelGroupId !== undefined ? { visualGroupKind: "parallel" as const } : {}),
    ...(template.branchId !== undefined ? { branchId: template.branchId } : {}),
    ...(template.joinId !== undefined ? { joinId: template.joinId } : {}),
    ...(template.reviewEdges !== undefined ? { reviewEdges: template.reviewEdges } : {}),
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
    const view: CanvasNodeView = {
      ...templateView(template),
      ...(recipe?.ui?.positions[template.name]
        ? { position: recipe.ui.positions[template.name] }
        : {}),
      ...(live ?? { status: "no_card" }),
    };
    // 实例节点的实时元数据优先于冻结模板；旧实例缺省时沿用冻结值。
    const parallelGroupId = live?.parallelGroupId ?? template.parallelGroupId;
    const branchId = live?.branchId ?? template.branchId;
    const joinId = live?.joinId ?? template.joinId;
    const reviewEdges = live?.reviewEdges ?? template.reviewEdges;
    views.push({
      ...view,
      ...(parallelGroupId !== undefined
        ? {
            visualGroupId: parallelGroupId,
            visualGroupLabel: parallelGroupId,
            visualGroupKind: "parallel" as const,
          }
        : {}),
      ...(branchId !== undefined ? { branchId } : {}),
      ...(joinId !== undefined ? { joinId } : {}),
      ...(reviewEdges !== undefined ? { reviewEdges } : {}),
    });
  }
  for (const node of instance.nodes) {
    if (seen.has(node.name)) continue;
    views.push({
      name: node.name,
      dept: "",
      dependsOn: [],
      requiresConfirmation: false,
      unmapped: true,
      status: node.status,
      ...(node.cardRef !== undefined ? { cardRef: node.cardRef } : {}),
      ...(node.cards !== undefined ? { cards: node.cards } : {}),
      ...(node.suspended !== undefined ? { suspended: node.suspended } : {}),
      ...(node.confirmation !== undefined ? { confirmation: node.confirmation } : {}),
      ...(node.sessionId !== undefined ? { sessionId: node.sessionId } : {}),
      ...(node.parallelGroupId !== undefined
        ? { visualGroupId: node.parallelGroupId, visualGroupLabel: node.parallelGroupId }
        : {}),
      ...(node.parallelGroupId !== undefined ? { visualGroupKind: "parallel" as const } : {}),
      ...(node.branchId !== undefined ? { branchId: node.branchId } : {}),
      ...(node.joinId !== undefined ? { joinId: node.joinId } : {}),
      ...(node.reviewEdges !== undefined ? { reviewEdges: node.reviewEdges } : {}),
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
    selection.path
      ? desktopPathKey(row.path) === desktopPathKey(selection.path)
      : row.name === selection.name,
  );
  if (matches.length === 1) return { instance: matches[0], ambiguous: false };
  return { ambiguous: matches.length > 1 };
}

/**
 * 启动成功后定位新运行记录（S6-D1）：同名工作流、启动前快照里没有的路径、
 * 且落在当前项目根内。历史路径与项目根都使用跨视图共用的路径比较键。
 */
export function locateNewInstances(
  instances: readonly CanvasInstanceRow[],
  workflow: string,
  beforePaths: ReadonlySet<string>,
  projectRoot: string,
): CanvasInstanceRow[] {
  const root = desktopPathKey(projectRoot).replace(/\/$/, "") + "/";
  const before = new Set([...beforePaths].map((path) => desktopPathKey(path)));
  return instances.filter(
    (row) =>
      row.workflow === workflow &&
      !before.has(desktopPathKey(row.path)) &&
      desktopPathKey(row.path).startsWith(root),
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
