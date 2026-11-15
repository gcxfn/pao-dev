/**
 * 实例运行图（只读）：把实例自己的冻结配方交给现有 WorkflowEditor 渲染。
 * 节点状态仍以卡现读值为准（canvasNodeTone 六态着色），画布只读锁定；
 * D8d 节点详情继续由画布页右侧详情栏负责，本组件只通过 onSelectNode 通知选中节点。
 */
import { useMemo } from "react";
import type { CanvasInstanceRow, CanvasSnapshot } from "../../../contracts/canvas";
import { useI18n } from "../../i18n/react";
import {
  AMBIGUOUS_INSTANCE_MESSAGE,
  instanceDagNodes,
  instanceFailedNodes,
  recipeForInstance,
  resolveInstance,
  type CanvasNodeView,
} from "./canvas-model";
import { WorkflowEditor } from "./workflow-editor";

export interface InstanceWorkflowModel {
  readonly instance?: CanvasInstanceRow;
  readonly nodes: readonly CanvasNodeView[];
  /** 冻结配方缺失（旧实例/读取失败）＝退化：只按清单列节点，不画依赖边。 */
  readonly degraded: boolean;
  /** 同名多实例且标签没带路径：不猜第一个，提示用户从配方库明确选择。 */
  readonly ambiguous: boolean;
}

/**
 * 实例图数据：只读实例自己的冻结配方；配方后来增删节点或改坐标，都不影响旧实例。
 * 冻结配方缺失时退化为清单-only，并如实标记 degraded，不借用最新配方。
 * 同名多实例、标签又没带路径时不读第一个，返回 ambiguous 交由界面提示。
 */
export function instanceWorkflowModel(
  snapshot: CanvasSnapshot,
  instanceName: string | null | undefined,
  instancePath?: string,
): InstanceWorkflowModel {
  if (!instanceName) return { nodes: [], degraded: false, ambiguous: false };
  const { instance, ambiguous } = resolveInstance(snapshot.instances, {
    kind: "instance",
    name: instanceName,
    ...(instancePath !== undefined ? { path: instancePath } : {}),
  });
  if (!instance) return { nodes: [], degraded: false, ambiguous };
  const recipe = recipeForInstance(snapshot, instance);
  return {
    instance,
    nodes: instanceDagNodes(instance, recipe),
    degraded: recipe === undefined,
    ambiguous: false,
  };
}

export interface InstanceWorkflowViewProps {
  readonly snapshot: CanvasSnapshot;
  /** 实例名（左栏选中项）；为空＝未选中，渲染空态。 */
  readonly instanceName: string | null | undefined;
  readonly instancePath?: string;
  /** 节点选中变化；点击空白画布回调 null。 */
  readonly onSelectNode?: (name: string | null) => void;
  readonly selectedNode?: string | null;
}

/**
 * 实例运行图：ReactFlow 只读渲染，节点点击经 onSelectNode 通知父级，
 * 由父级继续驱动既有 D8d 节点详情栏。
 */
export function InstanceWorkflowView({
  snapshot,
  instanceName,
  instancePath,
  onSelectNode,
  selectedNode,
}: InstanceWorkflowViewProps) {
  const { t } = useI18n();
  const { instance, nodes, degraded, ambiguous } = useMemo(
    () => instanceWorkflowModel(snapshot, instanceName, instancePath),
    [snapshot, instanceName, instancePath],
  );

  if (ambiguous) {
    return (
      <div className="canvas-board instance-workflow-view" data-testid="canvas-dag">
        <p className="canvas-status" role="alert" data-testid="canvas-instance-ambiguous">
          {AMBIGUOUS_INSTANCE_MESSAGE}
        </p>
      </div>
    );
  }

  if (!instance) {
    return (
      <div className="canvas-board instance-workflow-view" data-testid="canvas-dag">
        <p className="canvas-empty" data-testid="canvas-dag-empty">
          {t("Select a recipe or an instance on the left to see its graph.")}
        </p>
      </div>
    );
  }

  const failedNodes = instanceFailedNodes(instance);
  return (
    <div
      className="canvas-board instance-workflow-view"
      data-testid="canvas-dag"
      data-mode="runtime"
      data-instance={instance.name}
      style={{ display: "flex", flexDirection: "column", gap: 8, minHeight: 0, height: "100%" }}
    >
      {/* 实例失败要可见（S6-D1）：实例级状态（挂起）不点名失败，这里点名失败节点，不静默。 */}
      {failedNodes.length > 0 ? (
        <p className="error-banner" role="alert" data-testid="canvas-instance-failure">
          该运行记录有失败节点：{failedNodes.join("、")}。失败不会自动消失，请在右侧节点详情查看回执与失败原因。
        </p>
      ) : null}
      {degraded ? (
        <p className="canvas-status" role="status" data-testid="canvas-dag-degraded">
          {t("The recipe for this instance could not be read; nodes are listed without edges.")}
        </p>
      ) : null}
      {nodes.length === 0 ? (
        <p className="canvas-empty" data-testid="canvas-dag-empty">
          {t("Select a recipe or an instance on the left to see its graph.")}
        </p>
      ) : (
        <WorkflowEditor
          nodes={nodes}
          readOnly
          selectedNode={selectedNode}
          onSelectNode={(name) => onSelectNode?.(name)}
        />
      )}
    </div>
  );
}
