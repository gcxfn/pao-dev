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
import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import {
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";
import type { Connection, Edge, Node, NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { cardStatusLabel, canvasNodeTone, computeCanvasLayout } from "./canvas-model";
import type { CanvasNodeView } from "./canvas-model";
import type { ConnectionPlan, ConnectVerdict } from "./recipe-canvas-editor";

type WorkerFlowNode = Node<{ view: CanvasNodeView }, "worker">;

function WorkerNode({ data, selected }: NodeProps<WorkerFlowNode>) {
  const node = data.view;
  const tone = canvasNodeTone(node);
  return (
    <div
      className={`canvas-flow-node canvas-node--${tone}${tone === "blue" ? " canvas-flow-node--running" : ""}${selected ? " canvas-node--active" : ""}`}
      data-testid="workflow-node"
    >
      <Handle type="target" position={Position.Left} />
      <strong>{node.name}</strong>
      <span>
        {node.dept || "未知部门"} · {node.status ? cardStatusLabel(node.status) : "部门任务"}
      </span>
      {node.requiresConfirmation ? <small>需要人工确认</small> : null}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { worker: WorkerNode };

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
        label: "依赖",
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
  fitView: (options?: {
    nodes?: { id: string }[];
    duration?: number;
    padding?: number;
  }) => void;
}

export interface WorkflowEditorProps {
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
  readonly onNodeContextMenu?: (
    event: ReactMouseEvent | MouseEvent,
    nodeId: string,
  ) => void;
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
  const initialNodes = useMemo(
    () =>
      computeCanvasLayout(views).boxes.map((box): WorkerFlowNode => ({
        id: box.name,
        type: "worker",
        position: { x: box.x, y: box.y },
        data: { view: box.node },
        ...(selectedNode !== undefined ? { selected: box.name === selectedNode } : {}),
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
      })),
    [views, selectedNode, connectMode?.source, verdicts],
  );
  const [nodes, setNodes] = useState<WorkerFlowNode[]>(initialNodes);
  // 视图/选中变化时重建节点表。必须保留已测得的 measured：v12 对未测量节点置
  // visibility:hidden（nodeHasDimensions），而 ResizeObserver 只在尺寸变化时回调，
  // 整表重置 measured 会让既有节点永久不可见、点击落到 pane 上。
  useEffect(() => {
    setNodes((current) => {
      const measured = new Map(
        current
          .filter((node) => node.measured?.width !== undefined && node.measured?.height !== undefined)
          .map((node) => [node.id, node.measured]),
      );
      return initialNodes.map((node) => {
        const size = measured.get(node.id);
        return size ? { ...node, measured: size } : node;
      });
    });
  }, [initialNodes]);
  const edges = useMemo(() => workflowEdges(views, reviewEdges), [views, reviewEdges]);
  const wrapperRef = useRef<HTMLDivElement>(null);
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
      data-testid="workflow-editor"
      data-mode={readOnly ? "runtime" : "edit"}
      data-connect-mode={connectMode ? "on" : undefined}
      onPointerMove={(event) => {
        pointerRef.current = { x: event.clientX, y: event.clientY };
      }}
    >
      <ReactFlow<WorkerFlowNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={(changes) => setNodes((current) => applyNodeChanges(changes, current))}
        onConnect={(connection: Connection) => {
          if (!readOnly && connection.source && connection.target)
            runConnect(connection.source, connection.target);
        }}
        onNodeClick={(_, node) => {
          if (connectMode) {
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
          onSelectEdge?.(edge.source, edge.target, edge.data?.review === true)
        }
        onNodeDragStop={(_, stopped, dragged) => {
          if (!readOnly) {
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
          if (readOnly) return;
          event.preventDefault();
          onNodeContextMenu?.(event, node.id);
        }}
        onEdgeContextMenu={(event, edge) => {
          if (readOnly) return;
          event.preventDefault();
          onEdgeContextMenu?.(event, edge.source, edge.target, edge.data?.review === true);
        }}
        onPaneContextMenu={(event) => {
          if (readOnly) return;
          event.preventDefault();
          onPaneContextMenu?.(event);
        }}
        onInit={(instance) => onInit?.(instance)}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        edgesReconnectable={false}
        deleteKeyCode={null}
        selectionOnDrag={!readOnly}
        fitView
        fitViewOptions={{ maxZoom: 1, padding: 0.2 }}
        minZoom={0.15}
        maxZoom={3}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} />
        <MiniMap position="top-right" pannable zoomable />
        <Controls showInteractive={false} />
      </ReactFlow>
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
