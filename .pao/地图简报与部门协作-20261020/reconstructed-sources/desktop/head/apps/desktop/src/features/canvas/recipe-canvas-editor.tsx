import { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, Ref } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import type { PiDesktopApi } from "../../../contracts/ipc";
import type {
  WizardRecipe,
  WizardRecipeEntry,
  WizardRecipeNode,
  WorkflowCatalogSnapshot,
} from "../../../contracts/workflow-wizard";
import type { WorkflowWizardIdentity } from "./workflow-wizard";
import { computeCanvasLayout } from "./canvas-model";
import type { CanvasNodeView } from "./canvas-model";
import { WorkflowEditor } from "./workflow-editor";
import type { WorkflowEditorApi } from "./workflow-editor";

/** 审核回边（内核 RecipeNode.回边 的已接通字段）：打回目标、回退上限、超限动作。 */
export type ReviewAction = "停滞" | "修完这轮放行";
export interface ReviewEdge {
  readonly 目标: string;
  readonly 上限: number;
  readonly 超限动作: ReviewAction;
}
export const REVIEW_ACTIONS: readonly ReviewAction[] = ["停滞", "修完这轮放行"];

function rawReviewEdges(node: WizardRecipeNode): unknown[] {
  const raw = (node as Record<string, unknown>).回边;
  return Array.isArray(raw) ? raw : [];
}

/**
 * 读出节点声明的审核回边并整形为内核口径：目标为非空字符串，上限为非负安全整数
 * （缺省 3），超限动作只在「停滞／修完这轮放行」里取（缺省「停滞」）。坏条目跳过，
 * 不静默改成别的规则；保存时仍由内核 parseRecipe 兜底校验。
 */
export function readReviewEdges(node: WizardRecipeNode): ReviewEdge[] {
  const edges: ReviewEdge[] = [];
  for (const raw of rawReviewEdges(node)) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const goal = typeof record.目标 === "string" ? record.目标.trim() : "";
    if (!goal) continue;
    // 缺省字段按内核口径补默认值；显式给出但非法的值按坏条目跳过，不静默改写。
    const rawLimit = record.上限;
    if (
      rawLimit !== undefined &&
      !(typeof rawLimit === "number" && Number.isSafeInteger(rawLimit) && rawLimit >= 0)
    )
      continue;
    const limit = rawLimit === undefined ? 3 : rawLimit;
    const rawAction = record.超限动作;
    if (rawAction !== undefined && rawAction !== "停滞" && rawAction !== "修完这轮放行") continue;
    const overLimitAction: ReviewAction = rawAction === "修完这轮放行" ? "修完这轮放行" : "停滞";
    edges.push({ 目标: goal, 上限: limit, 超限动作: overLimitAction });
  }
  return edges;
}

/** 只有显式声明 审核: true 的节点才能挂审核回边（内核同源约束）。 */
export function isReviewNode(node: WizardRecipeNode): boolean {
  return (node as Record<string, unknown>).审核 === true;
}

/**
 * 勾选/取消「审核节点」的节点补丁：取消时清空回边（内核只允许审核节点声明回边），
 * 但保留部门标准（内核要求审核节点须给出部门标准，取消审核不代为删除该字段）。
 */
export function reviewTogglePatch(checked: boolean): Partial<WizardRecipeNode> {
  return { 审核: checked, ...(checked ? {} : { 回边: [] }) };
}

/** 画布当前选中元素的渲染层表示：一个节点，或一条连线（依赖边／审核回边）。 */
export type SelectedElement =
  | { readonly kind: "node"; readonly name: string }
  | {
      readonly kind: "edge";
      readonly from: string;
      readonly to: string;
      readonly review: boolean;
    };

/** 连线选中在持久化字符串里的前缀；节点直接存名字原文。 */
const EDGE_SELECTION_PREFIX = "edge:";

/**
 * 编码选中元素：节点用名字原文，连线用 `edge:` 前缀加 JSON `[from,to,review]`
 * （review 为布尔）。未选中返回 undefined。这是持久化用的紧凑格式，仅渲染层解释。
 */
export function encodeSelectedElement(
  selection: SelectedElement | null | undefined,
): string | undefined {
  if (!selection) return undefined;
  if (selection.kind === "node") return selection.name || undefined;
  return `${EDGE_SELECTION_PREFIX}${JSON.stringify([selection.from, selection.to, selection.review])}`;
}

/** 解码持久化字符串；空串或格式非法返回 undefined（当作未选中）。 */
export function decodeSelectedElement(raw: string | undefined): SelectedElement | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!raw.startsWith(EDGE_SELECTION_PREFIX)) return { kind: "node", name: raw };
  try {
    const parsed: unknown = JSON.parse(raw.slice(EDGE_SELECTION_PREFIX.length));
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string" &&
      typeof parsed[2] === "boolean"
    ) {
      return { kind: "edge", from: parsed[0], to: parsed[1], review: parsed[2] };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** 选中元素在当前草稿里是否仍存在；节点被删／改名或连线被删后返回 false。 */
export function selectedElementExists(
  selection: SelectedElement,
  nodes: readonly WizardRecipeNode[],
): boolean {
  if (selection.kind === "node") {
    return nodes.some((node) => node.名字 === selection.name);
  }
  if (selection.review) {
    const reviewNode = nodes.find((node) => node.名字 === selection.from);
    return (
      !!reviewNode &&
      isReviewNode(reviewNode) &&
      readReviewEdges(reviewNode).some((row) => row.目标 === selection.to)
    );
  }
  const target = nodes.find((node) => node.名字 === selection.to);
  return target?.depends_on?.includes(selection.from) === true;
}

/** 依赖链上游：沿 depends_on 传递收集的全部前置节点（不含自身）。 */
export function dependencyAncestors(nodes: readonly WizardRecipeNode[], from: string): Set<string> {
  const byName = new Map(nodes.map((node) => [node.名字, node]));
  const ancestors = new Set<string>();
  const visit = (name: string) => {
    for (const dep of byName.get(name)?.depends_on ?? []) {
      if (ancestors.has(dep)) continue;
      ancestors.add(dep);
      visit(dep);
    }
  };
  visit(from);
  return ancestors;
}

/**
 * 连线意图判定（纯函数，供组件与测试共用）：审核节点连到自己的依赖链上游＝新增审核回边
 * （默认上限 3／停滞，已存在不重复）；其余连到上游＝成环拒绝；普通连线＝新增 depends_on。
 * 只判定已接通的依赖与审核回边，不猜测未实现的连线条件。
 */
export type ConnectionPlan =
  | { readonly kind: "noop" }
  | { readonly kind: "reject"; readonly message: string }
  | { readonly kind: "dependency"; readonly target: string; readonly source: string }
  | {
      readonly kind: "review";
      readonly review: string;
      readonly target: string;
      readonly edge: ReviewEdge;
    };

export function planConnection(
  nodes: readonly WizardRecipeNode[],
  from: string,
  to: string,
): ConnectionPlan {
  if (from === to) return { kind: "reject", message: "节点不能依赖自己。" };
  const source = nodes.find((node) => node.名字 === from);
  const target = nodes.find((node) => node.名字 === to);
  if (!source || !target) return { kind: "noop" };
  const ancestors = dependencyAncestors(nodes, from);
  if (isReviewNode(source) && ancestors.has(to)) {
    if (readReviewEdges(source).some((edge) => edge.目标 === to))
      return { kind: "reject", message: "该审核回边已存在。" };
    return {
      kind: "review",
      review: from,
      target: to,
      edge: { 目标: to, 上限: 3, 超限动作: "停滞" },
    };
  }
  if (target.depends_on?.includes(from)) return { kind: "noop" };
  if (ancestors.has(to))
    return { kind: "reject", message: "该依赖会形成循环。审核退回须在审核节点上单独配置。" };
  return { kind: "dependency", target: to, source: from };
}

export interface ConnectionApplication {
  readonly plan: ConnectionPlan;
  readonly nodes?: readonly WizardRecipeNode[];
}

/**
 * 连线意图的应用（单源，S3-2）：拖拽与连线模式两入口都经此函数走 planConnection 并产出
 * 下一份节点表，两入口结论天然一致；拒绝与 noop 不改节点，plan 原样带回供跟随浮层提示。
 * 规则只在 planConnection（冻结不改），本函数只做应用。
 */
export function applyConnection(
  nodes: readonly WizardRecipeNode[],
  from: string,
  to: string,
): ConnectionApplication {
  const plan = planConnection(nodes, from, to);
  if (plan.kind === "dependency") {
    return {
      plan,
      nodes: nodes.map((node) =>
        node.名字 === plan.target
          ? { ...node, depends_on: [...(node.depends_on ?? []), plan.source] }
          : node,
      ),
    };
  }
  if (plan.kind === "review") {
    return {
      plan,
      nodes: nodes.map((node) =>
        node.名字 === plan.review
          ? {
              ...node,
              回边: [
                ...rawReviewEdges(node),
                { 目标: plan.edge.目标, 上限: plan.edge.上限, 超限动作: plan.edge.超限动作 },
              ],
            }
          : node,
      ),
    };
  }
  return { plan };
}

export interface ConnectVerdict {
  readonly legal: boolean;
  readonly text: string;
}

/** 连线模式下各节点判定（S3-2）：合法目标高亮、非法置灰与 hover 提示共用同一份。 */
export function connectVerdicts(
  nodes: readonly WizardRecipeNode[],
  from: string,
): Readonly<Record<string, ConnectVerdict>> {
  const verdicts: Record<string, ConnectVerdict> = {};
  for (const node of nodes) {
    if (node.名字 === from) continue;
    const plan = planConnection(nodes, from, node.名字);
    verdicts[node.名字] =
      plan.kind === "dependency"
        ? { legal: true, text: `将建依赖：${node.名字} 依赖 ${from}` }
        : plan.kind === "review"
          ? { legal: true, text: `将建审核回边：${from} 可打回 ${node.名字}` }
          : plan.kind === "noop"
            ? { legal: false, text: "已存在依赖" }
            : { legal: false, text: plan.message };
  }
  return verdicts;
}

/**
 * 复制节点（S3-2）：重名自动派生（「副本」「副本2」…）；依赖与回边不复制——回边目标须为
 * 依赖链上游，清依赖后保留会非法；位置＝源节点有效位置（保存坐标或布局坐标）偏移 40/40。
 */
export function planNodeCopy(
  nodes: readonly WizardRecipeNode[],
  views: readonly CanvasNodeView[],
  name: string,
): { name: string; node: WizardRecipeNode; position: { x: number; y: number } } | undefined {
  const source = nodes.find((row) => row.名字 === name);
  if (!source) return undefined;
  let copyName = `${name}副本`;
  let index = 1;
  while (nodes.some((row) => row.名字 === copyName)) {
    index += 1;
    copyName = `${name}副本${index}`;
  }
  const saved = views.find((view) => view.name === name)?.position;
  const laid = computeCanvasLayout(views).boxes.find((box) => box.name === name);
  const base = saved ?? laid ?? { x: 40, y: 40 };
  return {
    name: copyName,
    node: { ...source, 名字: copyName, depends_on: [], 回边: undefined },
    position: { x: base.x + 40, y: base.y + 40 },
  };
}

export interface RenameResult {
  readonly draft?: WizardRecipe;
  readonly error?: string;
}

/**
 * 节点改名提交（S3-2，回车/失焦共用，Esc 不经此）：一次同步名字、ui 坐标键、依赖引用
 * 与回边目标。重名返回错误且不改草稿（保留原名）；空白或同名为 no-op。
 */
export function commitNodeRename(
  draft: WizardRecipe,
  oldName: string,
  nextName: string,
): RenameResult {
  const name = nextName.trim();
  if (!name || name === oldName) return {};
  if (draft.节点.some((node) => node.名字 === name)) {
    return { error: "节点名称已存在，请换一个名称。" };
  }
  const positions = {
    ...(
      draft.ui as { positions?: Record<string, { x: number; y: number }> } | undefined
    )?.positions,
  };
  if (positions[oldName]) {
    positions[name] = positions[oldName];
    delete positions[oldName];
  }
  return {
    draft: {
      ...draft,
      ui: { positions },
      节点: draft.节点.map((node) => ({
        ...node,
        名字: node.名字 === oldName ? name : node.名字,
        depends_on: node.depends_on?.map((dep) => (dep === oldName ? name : dep)),
        ...(Array.isArray((node as Record<string, unknown>).回边)
          ? {
              回边: ((node as Record<string, unknown>).回边 as { 目标: string }[]).map((row) => ({
                ...row,
                目标: row.目标 === oldName ? name : row.目标,
              })),
            }
          : {}),
      })),
    },
  };
}

export interface RecipeEditorActions {
  save: () => Promise<boolean>;
  discard: () => void;
}

/** 未保存判定单一事实源：有内容改动（dirty）或尚未落盘（revision 为空）。
 *  工具栏徽章、上报给页面的守卫信号都必须经它取值，不得各自另算（S3-1）。 */
export function editorUnsaved(dirty: boolean, revision: string | null): boolean {
  return dirty || revision === null;
}

export type RecipeEditorEntry = Omit<WizardRecipeEntry, "revision"> & {
  readonly revision: string | null;
};

/** 画布右键菜单（S3-2）：节点或连线，坐标相对编辑器外壳（menu 供定位）。 */
type CanvasMenu =
  | { readonly kind: "node"; readonly name: string; readonly x: number; readonly y: number }
  | {
      readonly kind: "edge";
      readonly from: string;
      readonly to: string;
      readonly review: boolean;
      readonly x: number;
      readonly y: number;
    };

export function RecipeCanvasEditor({
  api,
  entry,
  identity,
  onSaved,
  onDirtyChange,
  catalog,
  editorRef,
  initialSelectedElementId,
  onSelectedElementIdChange,
}: {
  readonly api: PiDesktopApi;
  readonly entry: RecipeEditorEntry;
  readonly identity?: WorkflowWizardIdentity;
  readonly onSaved: (name: string) => void;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly catalog: WorkflowCatalogSnapshot;
  readonly editorRef?: Ref<RecipeEditorActions>;
  /** 恢复上次选中的画布元素（见 SelectedElement 编码）；无效或节点已删时自动清空。 */
  readonly initialSelectedElementId?: string;
  /** 选中变化回调；未选中时传 undefined。仅上报选中，不影响 dirty 草稿。 */
  readonly onSelectedElementIdChange?: (id: string | undefined) => void;
}) {
  const [draft, setDraft] = useState<WizardRecipe>(entry.recipe);
  const [revision, setRevision] = useState(entry.revision);
  const [base, setBase] = useState(entry.recipe);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [copyName, setCopyName] = useState("");
  // S3-2 交互状态：右键菜单、连线模式（起点可与拖拽并存同一判定）、改名输入焦点。
  const [menu, setMenu] = useState<CanvasMenu | null>(null);
  const [linkMode, setLinkMode] = useState(false);
  const [linkSource, setLinkSource] = useState<string | null>(null);
  const editorShellRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const flowApiRef = useRef<WorkflowEditorApi | null>(null);
  const initialSelection = decodeSelectedElement(initialSelectedElementId);
  const restoredSelection =
    initialSelection && selectedElementExists(initialSelection, entry.recipe.节点)
      ? initialSelection
      : undefined;
  const [selected, setSelected] = useState<string | null>(
    restoredSelection?.kind === "node" ? restoredSelection.name : null,
  );
  const [nodeName, setNodeName] = useState("");
  const [edge, setEdge] = useState<{ from: string; to: string; review: boolean } | null>(
    restoredSelection?.kind === "edge"
      ? {
          from: restoredSelection.from,
          to: restoredSelection.to,
          review: restoredSelection.review,
        }
      : null,
  );
  const selectedNode = draft.节点.find((node) => node.名字 === selected);
  useEffect(() => setNodeName(selectedNode?.名字 ?? ""), [selectedNode?.名字]);
  const reviewNodeForEdge =
    edge && edge.review ? draft.节点.find((node) => node.名字 === edge.from) : undefined;
  const reviewEdge =
    reviewNodeForEdge && edge
      ? readReviewEdges(reviewNodeForEdge).find((row) => row.目标 === edge.to)
      : undefined;
  const patchReviewEdge = (patch: Partial<ReviewEdge>) => {
    if (!edge?.review) return;
    setDraft({
      ...draft,
      节点: draft.节点.map((node) =>
        node.名字 === edge.from
          ? {
              ...node,
              回边: readReviewEdges(node).map((row) =>
                row.目标 === edge.to ? { ...row, ...patch } : row,
              ),
            }
          : node,
      ),
    });
  };
  const reviewEdges = draft.节点.flatMap((node) =>
    readReviewEdges(node).map((row) => ({ from: node.名字, to: row.目标 })),
  );
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  // 上报口径＝editorUnsaved（含未落盘）：离开守卫、标签圆点与徽章同源。
  const unsaved = editorUnsaved(dirty, revision);
  useEffect(() => onDirtyChange(unsaved), [unsaved, onDirtyChange]);
  const selectionId = selected
    ? encodeSelectedElement({ kind: "node", name: selected })
    : encodeSelectedElement(
        edge ? { kind: "edge", from: edge.from, to: edge.to, review: edge.review } : undefined,
      );
  useEffect(
    () => onSelectedElementIdChange?.(selectionId),
    [selectionId, onSelectedElementIdChange],
  );
  // 草稿变化（放弃修改、删除节点等）后选中元素可能已不存在，清空以免持久化坏引用。
  useEffect(() => {
    if (selected && !selectedElementExists({ kind: "node", name: selected }, draft.节点)) {
      setSelected(null);
    }
    if (edge && !selectedElementExists({ kind: "edge", ...edge }, draft.节点)) {
      setEdge(null);
    }
  }, [draft, selected, edge]);
  const nodes = useMemo((): CanvasNodeView[] => {
    const ui = draft.ui as { positions?: Record<string, { x: number; y: number }> } | undefined;
    return draft.节点.map((node) => ({
      name: node.名字,
      dept: node.部门,
      dependsOn: node.depends_on ?? [],
      requiresConfirmation: node.人工确认 === true,
      position: ui?.positions?.[node.名字],
      model: node.模型,
      thinkingLevel: node.思考强度,
    }));
  }, [draft]);
  const save = async (targetName?: string) => {
    if (busy) {
      setMessage("正在保存，请等待当前操作结束。");
      return false;
    }
    if (!identity) {
      setMessage("请先在项目中建立主控会话，再保存工作流。");
      return false;
    }
    setBusy(true);
    setMessage("");
    try {
      const nextRecipe = targetName ? { ...draft, 名字: targetName } : draft;
      const result = await api.saveWorkflowRecipe({
        ...identity,
        recipe: nextRecipe,
        revision: targetName ? null : revision,
      });
      if (result.state === "error") {
        setMessage(result.message);
        return false;
      }
      const catalog = await api.getWorkflowCatalog();
      if (catalog.state !== "available") {
        setMessage(catalog.message);
        return false;
      }
      const saved = catalog.recipes.find((row) => row.name === nextRecipe.名字);
      if (!saved) {
        setMessage("保存后未能读回工作流，请重新加载核对。");
        return false;
      }
      setRevision(saved.revision);
      setBase(saved.recipe);
      setDraft(saved.recipe);
      onSaved(saved.name);
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy(false);
    }
  };
  useImperativeHandle(editorRef, () => ({
    save,
    discard: () => {
      setDraft(base);
      setMessage("");
    },
  }));
  const connect = (from: string, to: string): ConnectionPlan => {
    // 单源应用：拖拽与连线模式两入口都走 applyConnection（其内即 planConnection，冻结不改）。
    // 拒绝/noop 不再落画布顶部 banner，由画布浮层跟随光标提示（§8.1）。
    const { plan, nodes: nextNodes } = applyConnection(draft.节点, from, to);
    if (nextNodes) setDraft({ ...draft, 节点: nextNodes });
    if (plan.kind === "review") {
      setSelected(plan.review);
      setEdge({ from: plan.review, to: plan.target, review: true });
    }
    if (plan.kind === "dependency" || plan.kind === "review") {
      setMessage("");
      setLinkMode(false);
      setLinkSource(null);
    }
    return plan;
  };
  const verdicts = useMemo(
    () => (linkMode && linkSource ? connectVerdicts(draft.节点, linkSource) : undefined),
    [linkMode, linkSource, draft.节点],
  );
  const patchNode = (name: string, patch: Partial<WizardRecipeNode>) =>
    setDraft((current) => ({
      ...current,
      节点: current.节点.map((node) => (node.名字 === name ? { ...node, ...patch } : node)),
    }));
  const updateNode = (patch: Partial<WizardRecipeNode>) => {
    if (selected) patchNode(selected, patch);
  };
  const copyNode = (name: string) => {
    const copy = planNodeCopy(draft.节点, nodes, name);
    if (!copy) return;
    const positions = {
      ...(
        draft.ui as { positions?: Record<string, { x: number; y: number }> } | undefined
      )?.positions,
      [copy.name]: copy.position,
    };
    setDraft({ ...draft, ui: { positions }, 节点: [...draft.节点, copy.node] });
    setSelected(copy.name);
    setEdge(null);
  };
  const deleteNode = (name: string) => {
    const positions = {
      ...(
        draft.ui as { positions?: Record<string, { x: number; y: number }> } | undefined
      )?.positions,
    };
    delete positions[name];
    setDraft({
      ...draft,
      ui: { positions },
      节点: draft.节点
        .filter((node) => node.名字 !== name)
        .map((node) => ({
          ...node,
          depends_on: node.depends_on?.filter((dep) => dep !== name),
          ...(Array.isArray((node as Record<string, unknown>).回边)
            ? {
                回边: ((node as Record<string, unknown>).回边 as { 目标: string }[]).filter(
                  (row) => row.目标 !== name,
                ),
              }
            : {}),
        })),
    });
    setSelected(null);
  };
  const deleteEdge = (target: { from: string; to: string; review: boolean }) => {
    setDraft({
      ...draft,
      节点: draft.节点.map((node) =>
        target.review && node.名字 === target.from
          ? { ...node, 回边: readReviewEdges(node).filter((row) => row.目标 !== target.to) }
          : !target.review && node.名字 === target.to
            ? { ...node, depends_on: node.depends_on?.filter((dep) => dep !== target.from) }
            : node,
      ),
    });
    setEdge(null);
  };
  /** 节点改名提交（回车/失焦共用）：重名提示并保留原名；no-op 时同步回输入框。
   *  失焦路径由 onBlur 捕获当时的名字对并延迟一拍再调这里：同步提交会在
   *  mousedown→blur→mouseup 之间重渲染画布，把用户这次点击劫持到 pane 上
   *  （click 落到 pane→清空选择），吞掉「点谁提交后选中谁」。延迟后按名字对
   *  提交，不依赖选中态；选中若已被随后的 click 移走，只迁名字不抢选择。 */
  const commitNodeName = (fromName?: string, toName?: string) => {
    if (!selectedNode) return;
    const from = fromName ?? selectedNode.名字;
    const nextName = (toName ?? nodeName).trim();
    const result = commitNodeRename(draft, from, nextName);
    if (result.error) {
      setMessage(result.error);
      return;
    }
    if (!result.draft) {
      if (selected === from) setNodeName(from);
      return;
    }
    setDraft(result.draft);
    setSelected((current) => (current === from ? nextName : current));
    setEdge(null);
    setMessage("");
  };
  const openMenuAt = (
    event: ReactMouseEvent | MouseEvent,
    base: { kind: "node"; name: string } | { kind: "edge"; from: string; to: string; review: boolean },
  ) => {
    if (busy) return;
    const rect = editorShellRef.current?.getBoundingClientRect();
    setMenu({
      ...base,
      x: event.clientX - (rect?.left ?? 0),
      y: event.clientY - (rect?.top ?? 0),
    });
  };
  const cancelLink = () => {
    setMenu(null);
    setLinkMode(false);
    setLinkSource(null);
  };
  // Esc 取消菜单与连线模式（输入控件内的 Esc 由控件自己处理，不在此截获）。
  useEffect(() => {
    if (!menu && !linkMode) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      setMenu(null);
      setLinkMode(false);
      setLinkSource(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu, linkMode]);
  // 点菜单外任意处关闭菜单（菜单自身 mousedown 已 stopPropagation）。
  useEffect(() => {
    if (!menu) return;
    const closeFromOutside = () => setMenu(null);
    window.addEventListener("mousedown", closeFromOutside);
    return () => window.removeEventListener("mousedown", closeFromOutside);
  }, [menu]);
  return (
    <Group className="recipe-panels" orientation="horizontal">
      <Panel id="workflow-graph" defaultSize="70%" minSize="35%">
        <div className="recipe-canvas-editor" data-testid="recipe-canvas-editor" ref={editorShellRef}>
          <div className="workflow-toolbar">
            <strong>
              {draft.名字}
              {unsaved ? " ● 未保存" : " · 已保存"}
            </strong>
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={() => {
                let index = 1;
                while (draft.节点.some((node) => node.名字 === `任务${index}`)) index++;
                const name = `任务${index}`;
                setDraft({
                  ...draft,
                  节点: [
                    ...draft.节点,
                    {
                      名字: name,
                      部门: catalog.departments[0] ?? "",
                      目标: "",
                      验收: "",
                      人工确认: false,
                      depends_on: [],
                    },
                  ],
                });
                setSelected(name);
                setEdge(null);
              }}
            >
              添加部门任务
            </button>
            <button
              className="button"
              type="button"
              data-testid="canvas-link-toggle"
              aria-pressed={linkMode}
              disabled={busy}
              onClick={() => {
                setLinkMode((current) => !current);
                setLinkSource(null);
              }}
            >
              {linkMode ? "退出连线" : "连线"}
            </button>
            <button
              className="button"
              type="button"
              disabled={busy || !dirty}
              onClick={() => {
                save().catch((error: unknown) =>
                  setMessage(error instanceof Error ? error.message : String(error)),
                );
              }}
            >
              保存
            </button>
            <button
              className="button"
              type="button"
              disabled={busy || !dirty}
              onClick={() => {
                setDraft(base);
                setMessage("");
              }}
            >
              放弃修改
            </button>
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={() => setDraft({ ...draft, ui: { positions: {} } })}
            >
              自动整理
            </button>
          </div>
          <div className="workflow-toolbar">
            <input
              aria-label="另存为名称"
              placeholder="输入新的工作流名"
              value={copyName}
              disabled={busy}
              onChange={(event) => setCopyName(event.target.value)}
            />
            <button
              className="button"
              type="button"
              disabled={busy || !copyName.trim()}
              onClick={() => {
                void save(copyName.trim()).catch((error: unknown) =>
                  setMessage(error instanceof Error ? error.message : String(error)),
                );
              }}
            >
              另存为
            </button>
          </div>
          {message ? (
            <p className="error-banner" role="alert">
              {message}
            </p>
          ) : null}
          <WorkflowEditor
            nodes={nodes}
            reviewEdges={reviewEdges}
            readOnly={busy}
            onPositionsChange={(positions) => setDraft({ ...draft, ui: { positions } })}
            onConnect={connect}
            onSelectNode={(name) => {
              setSelected(name);
              setEdge(null);
            }}
            onSelectEdge={(from, to, review) => {
              setEdge({ from, to, review });
              setSelected(null);
            }}
            connectMode={busy || !linkMode ? null : { source: linkSource }}
            verdicts={verdicts}
            onPickConnectSource={(name) => setLinkSource(name)}
            onNodeContextMenu={(event, name) => openMenuAt(event, { kind: "node", name })}
            onEdgeContextMenu={(event, from, to, review) =>
              openMenuAt(event, { kind: "edge", from, to, review })
            }
            onPaneContextMenu={() => cancelLink()}
            onInit={(api) => {
              flowApiRef.current = api;
            }}
          />
          {menu ? (
            <div
              className="canvas-context-menu"
              data-testid="canvas-context-menu"
              role="menu"
              style={{ left: menu.x, top: menu.y }}
              onMouseDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setMenu(null);
                }
              }}
            >
              {menu.kind === "node" ? (
                <>
                  <button type="button" role="menuitem" onClick={() => {
                    setLinkMode(true);
                    setLinkSource(menu.name);
                    setMenu(null);
                  }}>
                    连线到…
                  </button>
                  <button type="button" role="menuitem" onClick={() => {
                    setSelected(menu.name);
                    setEdge(null);
                    setMenu(null);
                    // 右键菜单改名入口（替代原「重命名节点」按钮）：聚焦 Inspector 名称输入框。
                    requestAnimationFrame(() => nameInputRef.current?.focus());
                  }}>
                    重命名节点
                  </button>
                  {draft.版本 === 2 ? (
                    <button type="button" role="menuitem" onClick={() => {
                      const target = draft.节点.find((node) => node.名字 === menu.name);
                      patchNode(menu.name, reviewTogglePatch(!(target && isReviewNode(target))));
                      setMenu(null);
                    }}>
                      {draft.节点.some(
                        (node) => node.名字 === menu.name && isReviewNode(node),
                      )
                        ? "取消审核节点"
                        : "设为审核节点"}
                    </button>
                  ) : null}
                  <button type="button" role="menuitem" onClick={() => {
                    flowApiRef.current?.fitView({
                      nodes: [{ id: menu.name }],
                      duration: 200,
                      padding: 3,
                    });
                    setMenu(null);
                  }}>
                    居中到该节点
                  </button>
                  <button type="button" role="menuitem" onClick={() => {
                    copyNode(menu.name);
                    setMenu(null);
                  }}>
                    复制节点
                  </button>
                  <button type="button" role="menuitem" onClick={() => {
                    deleteNode(menu.name);
                    setMenu(null);
                  }}>
                    删除节点
                  </button>
                </>
              ) : (
                <>
                  {menu.review ? (
                    <button type="button" role="menuitem" onClick={() => {
                      // 审核回边直达 Inspector：选中该回边并显示回退设置。
                      setEdge({ from: menu.from, to: menu.to, review: true });
                      setSelected(null);
                      setMenu(null);
                    }}>
                      编辑回退设置
                    </button>
                  ) : null}
                  <button type="button" role="menuitem" onClick={() => {
                    deleteEdge({ from: menu.from, to: menu.to, review: menu.review });
                    setMenu(null);
                  }}>
                    删除连线
                  </button>
                </>
              )}
            </div>
          ) : null}
          <p className="canvas-status">
            {linkMode
              ? linkSource
                ? `连线模式：从「${linkSource}」出发，点击目标节点完成；Esc 或右键空白处取消。`
                : "连线模式：先点击起点节点，再点击终点；Esc 或右键空白处取消。"
              : selected
                ? `已选择 ${selected}`
                : "拖动节点调整位置；从右侧圆点连到另一节点左侧圆点建立依赖；审核节点连到上游节点即添加审核回边。"}
          </p>
        </div>
      </Panel>
      <Separator className="workflow-separator" />
      <Panel id="workflow-properties" defaultSize="30%" minSize="220px">
        <aside className="canvas-detail workflow-inspector" data-testid="workflow-inspector">
          <h2 className="canvas-panel__title">
            {selectedNode ? "节点属性" : edge ? "连线属性" : "工作流信息"}
          </h2>
          <fieldset disabled={busy}>
            {selectedNode ? (
              <>
                <strong>{selectedNode.名字}</strong>
                <label>
                  节点名称
                  <input
                    ref={nameInputRef}
                    value={nodeName}
                    onChange={(event) => setNodeName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        commitNodeName();
                      } else if (event.key === "Escape") {
                        // Esc 放弃：恢复原名，不触发改名链。
                        event.preventDefault();
                        event.stopPropagation();
                        setNodeName(selectedNode.名字);
                      }
                    }}
                    onBlur={() => {
                      // 延迟到 click 之后提交（见 commitNodeName 注释），名字对在 blur 时捕获。
                      const from = selectedNode?.名字;
                      const to = nodeName;
                      window.setTimeout(() => commitNodeName(from, to), 0);
                    }}
                  />
                </label>
                <label>
                  部门
                  <input
                    aria-label="部门"
                    value={selectedNode.部门}
                    onChange={(event) => updateNode({ 部门: event.target.value })}
                    placeholder="选择或输入部门名称"
                  />
                </label>
                {catalog.departments.length > 0 ? (
                  <label>
                    已有部门
                    <select
                      value={
                        catalog.departments.includes(selectedNode.部门) ? selectedNode.部门 : ""
                      }
                      onChange={(event) => {
                        if (event.target.value) updateNode({ 部门: event.target.value });
                      }}
                    >
                      <option value="">选择已有部门</option>
                      {catalog.departments.map((name) => (
                        <option key={name}>{name}</option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <label>
                  任务目标
                  <textarea
                    value={typeof selectedNode.目标 === "string" ? selectedNode.目标 : ""}
                    onChange={(event) => updateNode({ 目标: event.target.value })}
                  />
                </label>
                <label>
                  验收要求
                  <textarea
                    value={typeof selectedNode.验收 === "string" ? selectedNode.验收 : ""}
                    onChange={(event) => updateNode({ 验收: event.target.value })}
                  />
                </label>
                <label>
                  模型
                  <input
                    value={selectedNode.模型 ?? ""}
                    placeholder="继承部门配置"
                    onChange={(event) => updateNode({ 模型: event.target.value || undefined })}
                  />
                </label>
                <label>
                  思考强度
                  <select
                    aria-label="思考强度"
                    value={selectedNode.思考强度 ?? ""}
                    onChange={(event) => updateNode({ 思考强度: event.target.value || undefined })}
                  >
                    <option value="">继承部门配置</option>
                    {[...new Set([...catalog.thinkingLevels, selectedNode.思考强度])]
                      .filter((name): name is string => !!name)
                      .map((name) => (
                        <option key={name}>{name}</option>
                      ))}
                  </select>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={selectedNode.人工确认 === true}
                    onChange={(event) => updateNode({ 人工确认: event.target.checked })}
                  />
                  交付后等待人工确认
                </label>
                {draft.版本 === 2 ? (
                  <>
                    <label>
                      <input
                        type="checkbox"
                        checked={isReviewNode(selectedNode)}
                        onChange={(event) => updateNode(reviewTogglePatch(event.target.checked))}
                      />
                      审核节点
                    </label>
                    {isReviewNode(selectedNode) ? (
                      <label>
                        部门标准
                        <textarea
                          aria-label="部门标准"
                          value={
                            typeof selectedNode.部门标准 === "string" ? selectedNode.部门标准 : ""
                          }
                          placeholder="审核节点的审查标准（必填）"
                          onChange={(event) =>
                            updateNode({ 部门标准: event.target.value || undefined })
                          }
                        />
                      </label>
                    ) : null}
                    <p className="canvas-detail__note">
                      审核节点须填写部门标准，可对依赖链上游提出打回。取消审核会清除该节点的审核回边，但保留部门标准。
                    </p>
                  </>
                ) : null}
                <p className="canvas-detail__note">技能</p>
                {[...new Set([...catalog.skills, ...(selectedNode.技能 ?? [])])].map((name) => (
                  <label key={name}>
                    <input
                      type="checkbox"
                      checked={selectedNode.技能?.includes(name) ?? false}
                      onChange={(event) =>
                        updateNode({
                          技能: event.target.checked
                            ? [...(selectedNode.技能 ?? []), name]
                            : selectedNode.技能?.filter((skill) => skill !== name),
                        })
                      }
                    />
                    {name}
                  </label>
                ))}
                {isReviewNode(selectedNode) ? (
                  <div className="canvas-detail__note">
                    <p>审核回边</p>
                    {readReviewEdges(selectedNode).length === 0 ? (
                      <p>从本节点右侧圆点连到上游节点左侧圆点，可添加审核回边。</p>
                    ) : (
                      readReviewEdges(selectedNode).map((row) => (
                        <button
                          className="button"
                          type="button"
                          key={row.目标}
                          onClick={() => {
                            setEdge({ from: selectedNode.名字, to: row.目标, review: true });
                            setSelected(null);
                          }}
                        >
                          {row.目标} · 上限 {row.上限} · {row.超限动作}
                        </button>
                      ))
                    )}
                  </div>
                ) : null}
                <button
                  className="button"
                  type="button"
                  onClick={() => deleteNode(selectedNode.名字)}
                >
                  删除节点
                </button>
              </>
            ) : edge ? (
              <>
                <p>
                  {edge.from} → {edge.to}
                </p>
                {edge.review ? (
                  <>
                    <p>审核退回：打回 {edge.to}，上游重跑后再交回审核。</p>
                    {reviewEdge ? (
                      <>
                        <label>
                          回退上限
                          <input
                            aria-label="回退上限"
                            type="number"
                            min={0}
                            step={1}
                            value={reviewEdge.上限}
                            onChange={(event) => {
                              const raw = event.target.value;
                              if (raw === "") return;
                              const value = Number(raw);
                              if (Number.isSafeInteger(value) && value >= 0)
                                patchReviewEdge({ 上限: value });
                            }}
                          />
                        </label>
                        <label>
                          超限动作
                          <select
                            aria-label="超限动作"
                            value={reviewEdge.超限动作}
                            onChange={(event) =>
                              patchReviewEdge({ 超限动作: event.target.value as ReviewAction })
                            }
                          >
                            {REVIEW_ACTIONS.map((action) => (
                              <option key={action}>{action}</option>
                            ))}
                          </select>
                        </label>
                        <p className="canvas-detail__note">
                          上限 0 表示不限次数；超过上限后按超限动作处理（停滞＝挂起等人工恢复）。
                        </p>
                      </>
                    ) : (
                      <p className="canvas-detail__note">该回边声明已损坏，保存前请删除后重连。</p>
                    )}
                  </>
                ) : (
                  <p>下游任务等待上游交付</p>
                )}
                <button
                  className="button"
                  type="button"
                  onClick={() => deleteEdge(edge)}
                >
                  删除连线
                </button>
              </>
            ) : (
              <>
                <strong>{draft.名字}</strong>
                {revision === null ? (
                  <label>
                    工作流名称
                    <input
                      value={draft.名字}
                      onChange={(event) => setDraft({ ...draft, 名字: event.target.value })}
                    />
                  </label>
                ) : null}
                <label>
                  适用场景
                  <textarea
                    value={typeof draft.适用 === "string" ? draft.适用 : ""}
                    onChange={(event) =>
                      setDraft({ ...draft, 适用: event.target.value || undefined })
                    }
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={draft.自动执行 === true}
                    onChange={(event) => setDraft({ ...draft, 自动执行: event.target.checked })}
                  />
                  启动后自动派发和推进
                </label>
                <p className="canvas-detail__note">
                  选择节点编辑部门任务；选择连线查看依赖。保存时检查工作流，启动前还会检查部门和模型等执行条件。
                </p>
              </>
            )}
          </fieldset>
        </aside>
      </Panel>
    </Group>
  );
}
