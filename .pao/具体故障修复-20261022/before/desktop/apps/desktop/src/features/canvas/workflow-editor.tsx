/**
 * 画布交互改编自 AACS111/pi-studio/components/WorkflowEditor.tsx。
 * MIT License — Copyright (c) 2026 agegr
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 * PAO 仅复用画布交互；节点、依赖与审核回边遵循现有配方，父组件持有草稿。
 * S3-2 增：右键菜单事件上报、连线模式（点选起点→终点，与拖拽同走 onConnect 单源判定）、
 * 合法目标高亮、跟随光标的拒绝/已存在依赖浮层。本组件不持有草稿，只上报意图。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import {
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  MiniMap,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useStore,
  useUpdateNodeInternals,
  useReactFlow,
} from "@xyflow/react";
import type { Connection, Edge, Node, NodeProps, ReactFlowInstance } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  buildCanvasOverview,
  cardStatusLabel,
  canvasNodeTone,
  COMPACT_OVERVIEW_NODE_COUNT,
  computeCanvasLayout,
  overviewChainOrder,
  filterCanvasNodes,
  focusedCanvasNodes,
} from "./canvas-model";
import type { CanvasNodeFilter, CanvasNodeView, CanvasOverviewGroup } from "./canvas-model";
import type { ConnectionPlan, ConnectVerdict } from "./recipe-canvas-editor";
import { readCanvasViewPreference, saveCanvasViewPreference } from "./canvas-view-preferences";

type FlowNodeData = {
  readonly targetPosition?: Position;
  readonly sourcePosition?: Position;
} & (
  | { readonly kind: "worker"; readonly view: CanvasNodeView; readonly onSelect: () => void }
  | {
      readonly kind: "group";
      readonly group: CanvasOverviewGroup;
      readonly onToggle: () => void;
    }
);
type WorkerFlowNode = Node<FlowNodeData, "worker" | "overview">;

function WorkerNode({ id, data, selected }: NodeProps<WorkerFlowNode>) {
  const flow = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, data.targetPosition, data.sourcePosition, updateNodeInternals]);
  if (data.kind === "group")
    return (
      <OverviewGroupNode
        data={data.group}
        onToggle={data.onToggle}
        selected={selected}
        targetPosition={data.targetPosition}
        sourcePosition={data.sourcePosition}
      />
    );
  const node = data.view;
  const tone = canvasNodeTone(node);
  return (
    <div
      className={`canvas-flow-node canvas-node--${tone}${tone === "blue" ? " canvas-flow-node--running" : ""}${selected ? " canvas-node--active" : ""}`}
      data-testid="workflow-node"
      title={node.name}
      role="button"
      tabIndex={0}
      onFocus={() => {
        void flow
          .fitView({ nodes: [{ id }], padding: 0.5, maxZoom: 1, duration: 0 })
          .catch((error: unknown) => window.reportError(error));
      }}
      aria-label={`${node.name}，${node.status ? cardStatusLabel(node.status) : "部门任务"}，前置：${node.dependsOn.join("、") || "无"}`}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          data.onSelect();
        }
      }}
    >
      <Handle type="target" position={data.targetPosition ?? Position.Left} />
      <strong>{node.name}</strong>
      {node.unmapped ? <small>未映射 · 依赖未知</small> : null}
      <span>
        {node.dept || "未知部门"} · {node.status ? cardStatusLabel(node.status) : "部门任务"}
      </span>
      {node.requiresConfirmation ? <small>需要人工确认</small> : null}
      {node.cards && node.cards.length > 1 ? (
        <small>
          {node.cards.length} 张卡 · 已交付{" "}
          {node.cards.filter((card) => card.status === "delivered").length}
        </small>
      ) : null}
      <Handle type="source" position={data.sourcePosition ?? Position.Right} />
    </div>
  );
}

function OverviewGroupNode({
  data,
  onToggle,
  selected,
  targetPosition = Position.Left,
  sourcePosition = Position.Right,
}: {
  data: CanvasOverviewGroup;
  onToggle: () => void;
  selected?: boolean;
  targetPosition?: Position;
  sourcePosition?: Position;
}) {
  const kindLabel =
    data.kind === "parallel" ? "并行组" : data.kind === "condition" ? "条件分支" : "连续阶段";
  return (
    <div
      className={`canvas-flow-node canvas-flow-group canvas-node--${data.tone}${selected ? " canvas-node--active" : ""}`}
      data-testid="workflow-group"
      title={`${data.label}：${data.summary}`}
      role="button"
      tabIndex={0}
      aria-label={`${data.label}，${data.summary}，按 Enter 展开或收起`}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          // 分组在自身处理展开按键，避免 ReactFlow 的外层节点继续处理选择，
          // 并阻止空格触发画布的平移快捷键。
          event.stopPropagation();
          onToggle();
        }
      }}
    >
      <Handle type="target" position={targetPosition} />
      <strong>{data.label}</strong>
      <span>
        {kindLabel} · {data.summary}
      </span>
      <small>点击展开节点</small>
      <Handle type="source" position={sourcePosition} />
    </div>
  );
}

// 避开 ReactFlow 内置 group 类型的固定宽度和边框，尺寸由我们的节点样式测量。
const nodeTypes = { worker: WorkerNode, overview: WorkerNode };

/**
 * 执行中节点的边集（S6-D1 抽出纯函数）：目标节点执行中（六态蓝＝真在跑且未挂起）的
 * 依赖边标 animated，走 ReactFlow 内建流动虚线动画；审核回边是流程控制，不冒充执行动画。
 */
export function workflowEdges(
  views: readonly CanvasNodeView[],
  reviewEdges: readonly { readonly from: string; readonly to: string }[] = [],
): Edge[] {
  const running = new Set(
    views.filter((node) => canvasNodeTone(node) === "blue").map((node) => node.name),
  );
  return [
    ...views.flatMap((node) =>
      node.dependsOn.map((dep) => ({
        id: JSON.stringify(["dependency", dep, node.name]),
        source: dep,
        target: node.name,
        data: { review: false },
        markerEnd: { type: MarkerType.ArrowClosed },
        animated: running.has(node.name),
      })),
    ),
    ...reviewEdges.map((edge) => ({
      id: JSON.stringify(["review", edge.from, edge.to]),
      source: edge.from,
      target: edge.to,
      data: { review: true },
      label: "审核退回",
      style: { stroke: "#d63031", strokeDasharray: "6 4" },
    })),
  ];
}

/** 画布实例的最小面（「居中到该节点」用）：只暴露 fitView，不泄漏 React Flow 内部类型。 */
export interface WorkflowEditorApi {
  fitView: (options?: { nodes?: { id: string }[]; duration?: number; padding?: number }) => void;
  getViewport?: () => { x: number; y: number; zoom: number };
  setViewport?: (
    viewport: { x: number; y: number; zoom: number },
    options?: { duration?: number },
  ) => void;
}

export interface WorkflowEditorProps {
  readonly preferenceKey?: string;
  readonly nodes: readonly CanvasNodeView[];
  readonly reviewEdges?: readonly { readonly from: string; readonly to: string }[];
  readonly readOnly: boolean;
  readonly selectedNode?: string | null;
  readonly onPositionsChange?: (positions: Record<string, { x: number; y: number }>) => void;
  /** 连线意图应用（单源）：拖拽与连线模式点选两入口都调它；返回 plan 供本组件出浮层。 */
  readonly onConnect?: (from: string, to: string) => ConnectionPlan;
  readonly onSelectNode: (name: string | null) => void;
  readonly onSelectEdge?: (from: string, to: string, review: boolean) => void;
  /** 连线模式：非空＝激活；source＝已选起点（null＝待点选）。 */
  readonly connectMode?: { readonly source: string | null } | null;
  /** 起点已定时各节点的判定（合法高亮/非法置灰与 hover 提示文本）。 */
  readonly verdicts?: Readonly<Record<string, ConnectVerdict>>;
  /** 连线模式未选起点时点击节点＝选起点。 */
  readonly onPickConnectSource?: (name: string) => void;
  /** 右键节点/边/空白（编辑态才上报）：父层据此弹菜单或取消连线模式。
   *  React Flow 的 pane 事件可能给原生 MouseEvent，取两者并集，只用到坐标。 */
  readonly onNodeContextMenu?: (event: ReactMouseEvent | MouseEvent, nodeId: string) => void;
  readonly onEdgeContextMenu?: (
    event: ReactMouseEvent | MouseEvent,
    from: string,
    to: string,
    review: boolean,
  ) => void;
  readonly onPaneContextMenu?: (event: ReactMouseEvent | MouseEvent) => void;
  /** 画布实例（fitView 面）就绪回调。 */
  readonly onInit?: (api: WorkflowEditorApi) => void;
}

export function WorkflowEditor(props: WorkflowEditorProps) {
  return (
    <ReactFlowProvider>
      <WorkflowGraph {...props} />
    </ReactFlowProvider>
  );
}

function WorkflowGraph({
  preferenceKey,
  nodes: views,
  reviewEdges = [],
  readOnly,
  selectedNode,
  onPositionsChange,
  onConnect,
  onSelectNode,
  onSelectEdge,
  connectMode = null,
  verdicts,
  onPickConnectSource,
  onNodeContextMenu,
  onEdgeContextMenu,
  onPaneContextMenu,
  onInit,
}: WorkflowEditorProps) {
  const viewKey = useMemo(() => views.map((view) => view.name).join("\u0000"), [views]);
  const storageKey = preferenceKey
    ? JSON.stringify(["pao-canvas-view", preferenceKey, viewKey])
    : undefined;
  const savedPreference = useMemo(() => readCanvasViewPreference(storageKey), [storageKey]);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [graphWidth, setGraphWidth] = useState(0);
  useEffect(() => {
    const element = wrapperRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setGraphWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const [mode, setMode] = useState<"overview" | "detail">(
    savedPreference.mode ?? (readOnly ? "overview" : "detail"),
  );
  const [listOpen, setListOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [focusDepth, setFocusDepth] = useState(1);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CanvasNodeFilter>("all");
  const [locateRequest, setLocateRequest] = useState<string | null>(null);
  const searchResults = useMemo(
    () => filterCanvasNodes(views, query, filter),
    [views, query, filter],
  );
  const focusViews = useMemo(
    () => (focusMode && selectedNode ? focusedCanvasNodes(views, selectedNode, focusDepth) : views),
    [focusMode, focusDepth, selectedNode, views],
  );
  const relatedNames = useMemo(
    () =>
      new Set(
        selectedNode
          ? focusedCanvasNodes(views, selectedNode, Infinity).map((node) => node.name)
          : [],
      ),
    [views, selectedNode],
  );
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set(savedPreference.expandedGroups),
  );
  const toggleGroup = useCallback((groupId: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);
  useEffect(() => {
    setMode(savedPreference.mode ?? (readOnly ? "overview" : "detail"));
    setExpandedGroups(new Set(savedPreference.expandedGroups));
    setQuery("");
    setFilter("all");
    setFocusMode(false);
    setListOpen(false);
  }, [readOnly, viewKey, savedPreference]);
  const overview = useMemo(
    () => buildCanvasOverview(views, expandedGroups),
    [views, expandedGroups],
  );
  const displayViews = useMemo(
    () => (mode === "overview" ? overview.items.map((item) => item.view) : focusViews),
    [mode, overview.items, focusViews],
  );
  const layoutViews = useMemo(() => {
    if (mode !== "overview") return displayViews;
    const incoming = new Map<string, string[]>();
    for (const edge of overview.edges) {
      if (edge.back) continue;
      const deps = incoming.get(edge.to) ?? [];
      deps.push(edge.from);
      incoming.set(edge.to, deps);
    }
    return displayViews.map((view) => ({
      ...view,
      // 复合节点的真实成员依赖已经被 overview.edges 压缩；把压缩后的入口
      // 临时投影给布局函数，避免所有组节点落在同一层。它只影响坐标，不改模型。
      dependsOn: incoming.get(view.name) ?? [],
    }));
  }, [displayViews, mode, overview.edges]);
  const overviewById = useMemo(
    () => new Map(overview.items.map((item) => [item.id, item])),
    [overview.items],
  );
  const chainOrder = useMemo(
    () => (mode === "overview" ? overviewChainOrder(overview) : undefined),
    [mode, overview],
  );
  const compactColumns = graphWidth >= 540 ? 2 : 1;
  const compactOrder = useMemo(
    () => new Map(chainOrder?.map((id, index) => [id, index])),
    [chainOrder],
  );
  const layout = useMemo(() => computeCanvasLayout(layoutViews), [layoutViews]);
  const treeOverview =
    mode === "overview" &&
    !chainOrder &&
    overview.items.length >= COMPACT_OVERVIEW_NODE_COUNT &&
    overview.groups.length === 0;
  const compactHeight = chainOrder
    ? Math.ceil(chainOrder.length / compactColumns) * 160 + 80
    : undefined;
  const initialNodes = useMemo(
    () =>
      layout.boxes.map((box): WorkerFlowNode => {
        const item = mode === "overview" ? overviewById.get(box.name) : undefined;
        const group = item?.group;
        const selected = group
          ? group.members.some((member) => member.name === selectedNode)
          : box.name === selectedNode;
        const index = compactOrder.get(box.name);
        const row = index === undefined ? 0 : Math.floor(index / compactColumns);
        const slot = index === undefined ? 0 : index % compactColumns;
        const reverse = row % 2 === 1;
        const compact = treeOverview
          ? { targetPosition: Position.Top, sourcePosition: Position.Bottom }
          : index === undefined
            ? {}
            : {
                targetPosition:
                  index > 0 && slot === 0 ? Position.Top : reverse ? Position.Right : Position.Left,
                sourcePosition:
                  slot === compactColumns - 1
                    ? Position.Bottom
                    : reverse
                      ? Position.Left
                      : Position.Right,
              };
        return {
          id: box.name,
          type: group ? "overview" : "worker",
          position: treeOverview
            ? { x: 12 + box.row * 240, y: 60 + box.layer * 128 }
            : index === undefined
              ? { x: box.x, y: box.y }
              : { x: 12 + (reverse ? compactColumns - 1 - slot : slot) * 280, y: 60 + row * 160 },
          data: group
            ? { kind: "group", group, onToggle: () => toggleGroup(group.id), ...compact }
            : {
                kind: "worker",
                view: box.node,
                onSelect: () => onSelectNode(box.name),
                ...compact,
              },
          ...(selectedNode !== undefined ? { selected } : {}),
          ...(readOnly && selectedNode
            ? {
                className: (
                  group
                    ? group.members.some((member) => relatedNames.has(member.name))
                    : relatedNames.has(box.name)
                )
                  ? "canvas-path-related"
                  : "canvas-path-muted",
              }
            : {}),
          ...(connectMode?.source && verdicts
            ? {
                className:
                  box.name === connectMode.source
                    ? "canvas-link-source"
                    : verdicts[box.name]?.legal
                      ? "canvas-link-target"
                      : "canvas-link-blocked",
              }
            : {}),
        };
      }),
    [
      layout,
      treeOverview,
      mode,
      overviewById,
      selectedNode,
      connectMode?.source,
      toggleGroup,
      verdicts,
      compactColumns,
      compactOrder,
      onSelectNode,
      relatedNames,
      readOnly,
    ],
  );
  const [nodes, setNodes] = useState<WorkerFlowNode[]>(initialNodes);
  const positionKey = useMemo(
    () =>
      views
        .map((view) => `${view.name}:${view.position?.x ?? ""},${view.position?.y ?? ""}`)
        .join("\u0000"),
    [views],
  );
  const previousPositionKeyRef = useRef(positionKey);
  const previousModeRef = useRef(mode);
  // 视图/选中变化时重建节点表。必须保留已测得的 measured：v12 对未测量节点置
  // visibility:hidden（nodeHasDimensions），而 ResizeObserver 只在尺寸变化时回调，
  // 整表重置 measured 会让既有节点永久不可见、点击落到 pane 上。
  useEffect(() => {
    const positionsChanged = previousPositionKeyRef.current !== positionKey;
    const sameMode = previousModeRef.current === mode;
    previousPositionKeyRef.current = positionKey;
    previousModeRef.current = mode;
    setNodes((current) => {
      const matchesInitial =
        current.length === initialNodes.length &&
        current.every((currentNode, index) => {
          const nextNode = initialNodes[index];
          if (!nextNode) return false;
          // ReactFlow/父层可能在每次状态刷新时重建相同形状的 data 对象；
          // 只比较可序列化展示字段，避免 effect 因引用变化反复 setNodes 触发
          // React 的最大更新深度错误。组节点里的 onToggle 函数会被 JSON 忽略。
          const sameData = JSON.stringify(currentNode.data) === JSON.stringify(nextNode.data);
          return (
            currentNode.id === nextNode.id &&
            currentNode.type === nextNode.type &&
            currentNode.position.x === nextNode.position.x &&
            currentNode.position.y === nextNode.position.y &&
            currentNode.selected === nextNode.selected &&
            currentNode.className === nextNode.className &&
            sameData
          );
        });
      if (matchesInitial) return current;
      const measured = new Map(
        current
          .filter(
            (node) => node.measured?.width !== undefined && node.measured?.height !== undefined,
          )
          .map((node) => [node.id, node.measured]),
      );
      const currentById = new Map(current.map((node) => [node.id, node]));
      return initialNodes.map((node) => {
        const size = measured.get(node.id);
        const previous = currentById.get(node.id);
        // 详细图内的运行状态刷新不覆盖手工坐标；跨模式时采用原图坐标，
        // 避免把总览的自动布局当成详细图的手工位置。
        // 用户明确修改/清空坐标时，positionKey 变化，采用新的布局坐标。
        const position =
          mode === "detail" && sameMode && !positionsChanged && previous
            ? previous.position
            : node.position;
        return {
          ...node,
          position,
          ...(selectedNode === undefined && previous ? { selected: previous.selected } : {}),
          ...(size ? { measured: size } : {}),
        };
      });
    });
  }, [initialNodes, mode, positionKey, selectedNode]);
  const derivedReviewEdges = useMemo(
    () =>
      views.flatMap((node) =>
        (node.reviewEdges ?? []).map((edge) => ({ from: node.name, to: edge.target })),
      ),
    [views],
  );
  const effectiveReviewEdges = reviewEdges.length > 0 ? reviewEdges : derivedReviewEdges;
  const overviewEdges = useMemo(() => {
    if (mode !== "overview" || effectiveReviewEdges.length === 0) return overview.edges;
    const itemByNode = new Map<string, string>();
    for (const item of overview.items) {
      if (item.group) {
        for (const member of item.group.members) itemByNode.set(member.name, item.id);
      } else {
        itemByNode.set(item.view.name, item.id);
      }
    }
    const result = [...overview.edges];
    const reviewKeys = new Set(
      result.filter((edge) => edge.back).map((edge) => `${edge.from}->${edge.to}`),
    );
    for (const edge of effectiveReviewEdges) {
      const from =
        itemByNode.get(edge.from) ?? (overviewById.has(edge.from) ? edge.from : undefined);
      const to = itemByNode.get(edge.to) ?? (overviewById.has(edge.to) ? edge.to : undefined);
      if (!from || !to || from === to) continue;
      const key = `${from}->${to}`;
      if (reviewKeys.has(key)) continue;
      reviewKeys.add(key);
      result.push({ from, to, back: true });
    }
    return result;
  }, [effectiveReviewEdges, mode, overview.edges, overview.items, overviewById]);
  const baseEdges = useMemo(() => {
    if (mode === "overview") {
      const running = new Set(
        displayViews.filter((node) => canvasNodeTone(node) === "blue").map((node) => node.name),
      );
      return overviewEdges.map((edge) => ({
        id: JSON.stringify([edge.back ? "review" : "dependency", edge.from, edge.to]),
        source: edge.from,
        target: edge.to,
        data: { review: edge.back },
        type: chainOrder || treeOverview ? "smoothstep" : undefined,
        markerEnd: { type: MarkerType.ArrowClosed },
        label: edge.back ? "审核退回" : undefined,
        style: edge.back ? { stroke: "#d63031", strokeDasharray: "6 4" } : undefined,
        animated: !edge.back && running.has(edge.to),
      }));
    }
    const displayed = new Set(displayViews.map((node) => node.name));
    return workflowEdges(displayViews, effectiveReviewEdges).filter(
      (edge) => displayed.has(edge.source) && displayed.has(edge.target),
    );
  }, [displayViews, effectiveReviewEdges, mode, overviewEdges, views, chainOrder, treeOverview]);
  const edges = useMemo(() => {
    if (!readOnly || !selectedNode) return baseEdges;
    const relatedIds = new Set(
      initialNodes
        .filter((node) => node.className === "canvas-path-related")
        .map((node) => node.id),
    );
    return baseEdges.map((edge) => ({
      ...edge,
      style: {
        ...edge.style,
        ...(relatedIds.has(edge.source) && relatedIds.has(edge.target)
          ? { strokeWidth: 2 }
          : { opacity: 0.2 }),
      },
    }));
  }, [baseEdges, initialNodes, readOnly, selectedNode]);
  const [flowApi, setFlowApi] = useState<ReactFlowInstance<WorkerFlowNode> | null>(null);
  const surfaceWidth = useStore((state) => state.width);
  const surfaceHeight = useStore((state) => state.height);
  const previousSurface = useRef<{
    width: number;
    height: number;
    mode: typeof mode;
    viewKey: string;
  } | null>(null);
  useEffect(() => {
    const previous = previousSurface.current;
    previousSurface.current = { width: surfaceWidth, height: surfaceHeight, mode, viewKey };
    if (
      !flowApi ||
      !previous ||
      previous.mode !== mode ||
      previous.viewKey !== viewKey ||
      !previous.width ||
      !previous.height ||
      !surfaceWidth ||
      !surfaceHeight ||
      (previous.width === surfaceWidth && previous.height === surfaceHeight)
    )
      return;
    // 聊天区或侧栏改变可用面积时保持画布中心和倍率，不让原本可见节点落到裁切区。
    const viewport = flowApi.getViewport();
    flowApi
      .setViewport({
        ...viewport,
        x: viewport.x + (surfaceWidth - previous.width) / 2,
        y: viewport.y + (surfaceHeight - previous.height) / 2,
      })
      .catch((error: unknown) => window.reportError(error));
  }, [flowApi, surfaceWidth, surfaceHeight, mode, viewKey]);
  const nodesInitialized = useNodesInitialized();
  const viewportsRef = useRef(
    new Map<"overview" | "detail", { x: number; y: number; zoom: number }>(
      Object.entries(savedPreference.viewports ?? {}) as [
        "overview" | "detail",
        { x: number; y: number; zoom: number },
      ][],
    ),
  );
  const rememberView = () =>
    saveCanvasViewPreference(storageKey, {
      mode,
      expandedGroups: [...expandedGroups],
      viewports: Object.fromEntries(viewportsRef.current),
    });
  useEffect(() => {
    saveCanvasViewPreference(storageKey, {
      mode,
      expandedGroups: [...expandedGroups],
      viewports: Object.fromEntries(viewportsRef.current),
    });
  }, [storageKey, mode, expandedGroups]);
  const expandedGroupKey = [...expandedGroups].sort().join("\u0000");
  const [overviewReset, setOverviewReset] = useState(0);
  const viewportRequestRef = useRef<{
    mode: typeof mode;
    expandedGroupKey: string;
    viewKey: string;
    readOnly: boolean;
    compactColumns: number;
    overviewReset: number;
  } | null>(null);
  const changeMode = (nextMode: typeof mode) => {
    setListOpen(false);
    setFocusMode(false);
    if (nextMode === "overview") {
      setExpandedGroups(new Set());
      if (nextMode === mode && treeOverview) setOverviewReset((current) => current + 1);
    }
    if (nextMode === mode) return;
    if (flowApi) viewportsRef.current.set(mode, flowApi.getViewport());
    setMode(nextMode);
  };
  const locateNode = (name: string) => {
    onSelectNode(name);
    if (mode === "overview") {
      const group = overview.items.find((item) =>
        item.group?.members.some((member) => member.name === name),
      )?.group;
      if (group) setExpandedGroups((current) => new Set([...current, group.id]));
    }
    setLocateRequest(name);
  };
  useEffect(() => {
    if (!locateRequest || !flowApi || !nodesInitialized || listOpen) return;
    if (!nodes.some((node) => node.id === locateRequest)) return;
    const frame = window.requestAnimationFrame(() => {
      void flowApi
        .fitView({ nodes: [{ id: locateRequest }], padding: 0.5, maxZoom: 1, duration: 0 })
        .catch((error: unknown) => window.reportError(error));
      setLocateRequest(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [locateRequest, flowApi, nodesInitialized, nodes, listOpen]);
  useEffect(() => {
    if (!flowApi || !nodesInitialized) return;
    // 切换后先等受控节点表和尺寸同步，不能对上一模式的节点适配视口。
    if (
      nodes.length !== initialNodes.length ||
      nodes.some(
        (node, index) =>
          node.id !== initialNodes[index]?.id || node.type !== initialNodes[index]?.type,
      )
    )
      return;
    const previous = viewportRequestRef.current;
    const contextChanged =
      !previous || previous.viewKey !== viewKey || previous.readOnly !== readOnly;
    const expansionChanged = previous?.expandedGroupKey !== expandedGroupKey;
    const layoutChanged = Boolean(chainOrder && previous?.compactColumns !== compactColumns);
    const resetOverview = mode === "overview" && previous?.overviewReset !== overviewReset;
    if (
      !contextChanged &&
      previous.mode === mode &&
      !expansionChanged &&
      !layoutChanged &&
      !resetOverview
    )
      return;
    const frame = window.requestAnimationFrame(() => {
      if (previous && contextChanged) viewportsRef.current.clear();
      const saved =
        previous && (contextChanged || expansionChanged || layoutChanged || resetOverview)
          ? undefined
          : viewportsRef.current.get(mode);
      viewportRequestRef.current = {
        mode,
        expandedGroupKey,
        viewKey,
        readOnly,
        compactColumns,
        overviewReset,
      };
      // 无动画恢复，避免上一模式的动画结束事件写进新模式的保存槽。
      if (saved && (!treeOverview || saved.zoom >= 0.75)) {
        flowApi.setViewport(saved).catch((error: unknown) => window.reportError(error));
      } else if (treeOverview) {
        // 长树从入口开始，以可读倍率展示；其余节点通过平移/缩略图查看。
        // 不能撑高整个页面再居中，否则入口和工具条会落到屏幕外。
        const width = Math.max(0, ...layout.boxes.map((box) => box.row)) * 240 + 200;
        const zoom = Math.min(1, Math.max(0.75, (surfaceWidth - 48) / width));
        flowApi
          .setViewport({ x: Math.max(24, (surfaceWidth - width * zoom) / 2), y: 20, zoom })
          .catch((error: unknown) => window.reportError(error));
      } else {
        flowApi
          .fitView({ padding: 0.2, maxZoom: 1, minZoom: 0.1 })
          .catch((error: unknown) => window.reportError(error));
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    expandedGroupKey,
    flowApi,
    initialNodes,
    mode,
    nodes,
    nodesInitialized,
    readOnly,
    viewKey,
    chainOrder,
    compactColumns,
    overviewReset,
    treeOverview,
    layout,
    surfaceWidth,
  ]);
  const pointerRef = useRef({ x: 0, y: 0 });
  const floatTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(floatTimer.current), []);
  const [float, setFloat] = useState<{
    x: number;
    y: number;
    text: string;
    hover: boolean;
  } | null>(null);
  /** 跟随最近一次光标位置的浮层：hover 判定随离开消失；拒绝/已存在依赖 3 秒自动消失。 */
  const showFloat = (text: string, hover = false) => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    setFloat({
      x: pointerRef.current.x - (rect?.left ?? 0),
      y: pointerRef.current.y - (rect?.top ?? 0),
      text,
      hover,
    });
    window.clearTimeout(floatTimer.current);
    if (!hover) floatTimer.current = window.setTimeout(() => setFloat(null), 3000);
  };
  const runConnect = (from: string, to: string) => {
    const plan = onConnect?.(from, to);
    if (!plan) return;
    if (plan.kind === "reject") showFloat(plan.message);
    else if (plan.kind === "noop") showFloat("已存在依赖");
  };
  return (
    <div
      ref={wrapperRef}
      className="workflow-graph"
      style={compactHeight ? { minHeight: compactHeight } : undefined}
      data-testid="workflow-editor"
      data-mode={readOnly ? "runtime" : "edit"}
      data-view-mode={mode}
      data-presentation={listOpen ? "list" : focusMode ? "focus" : "graph"}
      data-connect-mode={connectMode ? "on" : undefined}
      onPointerMove={(event) => {
        pointerRef.current = { x: event.clientX, y: event.clientY };
      }}
    >
      {readOnly ? (
        <div className="canvas-node-search">
          <input
            aria-label="搜索工作流节点"
            placeholder="搜索节点、部门、卡号"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <select
            aria-label="筛选节点状态"
            value={filter}
            onChange={(event) => setFilter(event.target.value as CanvasNodeFilter)}
          >
            <option value="all">全部状态</option>
            <option value="attention">需要处理</option>
            <option value="running">进行中</option>
            <option value="completed">已完成</option>
            <option value="pending">待开始</option>
          </select>
          <button
            type="button"
            className="button"
            onClick={() => {
              const waiting = filterCanvasNodes(views, "", "attention");
              const index = waiting.findIndex((node) => node.name === selectedNode);
              const next = waiting[(index + 1) % waiting.length];
              if (next) locateNode(next.name);
            }}
            disabled={filterCanvasNodes(views, "", "attention").length === 0}
          >
            下个待处理
          </button>
        </div>
      ) : null}
      {readOnly && (listOpen || query.trim() || filter !== "all") ? (
        <div
          className={`canvas-node-results${listOpen ? " canvas-node-results--list" : ""}`}
          data-testid="canvas-node-results"
        >
          <p role="status">
            {searchResults.length} / {views.length} 个节点
            {focusMode ? ` · 专注显示 ${focusViews.length} 个` : ""}
          </p>
          {searchResults.length === 0 ? (
            <p>没有匹配的节点。</p>
          ) : (
            searchResults.map((node) => (
              <button
                type="button"
                key={node.name}
                className={`canvas-node-result canvas-node--${canvasNodeTone(node)}`}
                aria-pressed={node.name === selectedNode}
                onClick={() => locateNode(node.name)}
              >
                <strong>{node.name}</strong>
                <span>
                  {node.dept} · {node.status ? cardStatusLabel(node.status) : "未开始"}
                </span>
                <small>
                  {node.cards?.length ? `${node.cards.length} 张卡 · ` : ""}
                  {node.suspended ?? `前置：${node.dependsOn.join("、") || "无"}`}
                </small>
              </button>
            ))
          )}
        </div>
      ) : null}
      <div
        className="canvas-flow-surface"
        aria-hidden={listOpen}
        inert={listOpen}
        style={listOpen ? { visibility: "hidden", opacity: 0, pointerEvents: "none" } : undefined}
      >
        <ReactFlow<WorkerFlowNode>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={(changes) => setNodes((current) => applyNodeChanges(changes, current))}
          onConnect={(connection: Connection) => {
            if (mode === "detail" && !readOnly && connection.source && connection.target)
              runConnect(connection.source, connection.target);
          }}
          onNodeClick={(_, node) => {
            if (mode === "overview" && node.type === "overview") {
              const group = overviewById.get(node.id)?.group;
              if (group) toggleGroup(group.id);
              return;
            }
            if (connectMode) {
              if (mode !== "detail") return;
              if (connectMode.source) runConnect(connectMode.source, node.id);
              else onPickConnectSource?.(node.id);
              return;
            }
            onSelectNode(node.id);
          }}
          onNodeMouseEnter={(_, node) => {
            if (connectMode?.source && verdicts?.[node.id])
              showFloat(verdicts[node.id]?.text ?? "", true);
          }}
          onNodeMouseLeave={() => setFloat((current) => (current?.hover ? null : current))}
          onPaneClick={() => onSelectNode(null)}
          onEdgeClick={(_, edge) =>
            mode === "detail" &&
            onSelectEdge?.(edge.source, edge.target, edge.data?.review === true)
          }
          onNodeDragStop={(_, stopped, dragged) => {
            if (!readOnly && mode === "detail") {
              const moved = new Map(dragged.map((node) => [node.id, node.position]));
              moved.set(stopped.id, stopped.position);
              onPositionsChange?.(
                Object.fromEntries(
                  nodes.map((node) => [node.id, moved.get(node.id) ?? node.position]),
                ),
              );
            }
          }}
          onNodeContextMenu={(event, node) => {
            if (readOnly || mode !== "detail") return;
            event.preventDefault();
            onNodeContextMenu?.(event, node.id);
          }}
          onEdgeContextMenu={(event, edge) => {
            if (readOnly || mode !== "detail") return;
            event.preventDefault();
            onEdgeContextMenu?.(event, edge.source, edge.target, edge.data?.review === true);
          }}
          onPaneContextMenu={(event) => {
            if (readOnly || mode !== "detail") return;
            event.preventDefault();
            onPaneContextMenu?.(event);
          }}
          onInit={(instance) => {
            setFlowApi(instance);
            onInit?.(instance);
          }}
          onMoveEnd={(_, viewport) => {
            viewportsRef.current.set(mode, viewport);
            rememberView();
          }}
          nodesDraggable={!readOnly && mode === "detail"}
          nodesConnectable={!readOnly && mode === "detail"}
          edgesReconnectable={false}
          deleteKeyCode={null}
          selectionOnDrag={!readOnly}
          minZoom={0.1}
          maxZoom={3}
          proOptions={{ hideAttribution: true }}
          ariaLabelConfig={{
            "controls.zoomIn.ariaLabel": "放大",
            "controls.zoomOut.ariaLabel": "缩小",
            "controls.fitView.ariaLabel": "适应画布",
            "minimap.ariaLabel": "工作流缩略图",
          }}
        >
          <Background gap={20} size={1} />
          <MiniMap position="bottom-right" pannable zoomable />
          <Controls
            showInteractive={false}
            fitViewOptions={{ padding: 0.2, maxZoom: 1, minZoom: 0.1 }}
          />
        </ReactFlow>
      </div>
      <div className="canvas-view-mode" role="group" aria-label="工作流视图模式">
        <button
          type="button"
          className={mode === "overview" && !listOpen ? "canvas-view-mode__active" : undefined}
          aria-pressed={mode === "overview" && !listOpen}
          onClick={() => changeMode("overview")}
        >
          总览
        </button>
        <button
          type="button"
          className={
            mode === "detail" && !listOpen && !focusMode ? "canvas-view-mode__active" : undefined
          }
          aria-pressed={mode === "detail" && !listOpen && !focusMode}
          onClick={() => changeMode("detail")}
        >
          详细图
        </button>
        {readOnly ? (
          <>
            <button
              type="button"
              disabled={!selectedNode}
              aria-pressed={focusMode && !listOpen}
              onClick={() => {
                changeMode("detail");
                setFocusMode(true);
                if (selectedNode) setLocateRequest(selectedNode);
              }}
            >
              专注
            </button>
            <button type="button" aria-pressed={listOpen} onClick={() => setListOpen(true)}>
              列表
            </button>
            {focusMode && !listOpen ? (
              <select
                aria-label="专注上下游范围"
                value={String(focusDepth)}
                onChange={(event) => {
                  setFocusDepth(Number(event.target.value));
                  if (selectedNode) setLocateRequest(selectedNode);
                }}
              >
                <option value="1">上下游 1 层</option>
                <option value="2">上下游 2 层</option>
                <option value="Infinity">全部上下游</option>
              </select>
            ) : null}
          </>
        ) : null}
        {mode === "overview" && expandedGroups.size > 0 ? (
          <button
            type="button"
            onClick={() => setExpandedGroups(new Set())}
            aria-label="收起全部分组"
          >
            收起全部
          </button>
        ) : null}
        {mode === "overview" && !listOpen ? (
          <span className="canvas-view-summary" role="status">
            {views.length} 个节点 · 当前显示 {displayViews.length} 块
          </span>
        ) : null}
      </div>
      {float ? (
        <div
          className="canvas-connect-float"
          data-testid="canvas-connect-float"
          role="status"
          style={{ left: float.x, top: float.y }}
        >
          {float.text}
        </div>
      ) : null}
    </div>
  );
}
