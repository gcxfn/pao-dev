import { readFileSync, writeFileSync } from "node:fs";

const file = "D:/AI/workspace/pao-dev/桌面端/apps/desktop/src/features/canvas/recipe-canvas-editor.tsx";

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function applyPair(text, oldText, newText, label) {
  const pattern = new RegExp(oldText.split("\n").map(escapeRegExp).join("(\\r?\\n)"), "g");
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`${label}: expected 1, found ${matches.length}`);
  const ending = matches[0][1] || "\n";
  return text.replace(pattern, () => newText.split("\n").join(ending));
}

let text = readFileSync(file, "utf8");

// A. props
text = applyPair(text,
`export function RecipeCanvasEditor({
  api,
  entry,
  identity,
  onSaved,
  onDirtyChange,
  catalog,
  editorRef,
}: {
  readonly api: PiDesktopApi;
  readonly entry: RecipeEditorEntry;
  readonly identity?: WorkflowWizardIdentity;
  readonly onSaved: (name: string) => void;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly catalog: WorkflowCatalogSnapshot;
  readonly editorRef?: Ref<RecipeEditorActions>;
}) {`,
`export function RecipeCanvasEditor({
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
}) {`, "A");

// B. state init
text = applyPair(text,
`  const [selected, setSelected] = useState<string | null>(null);
  const [nodeName, setNodeName] = useState("");
  const [edge, setEdge] = useState<{ from: string; to: string; review: boolean } | null>(null);`,
`  const initialSelection = decodeSelectedElement(initialSelectedElementId);
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
  );`, "B");

// C. dirty effect + selection emit/validity
text = applyPair(text,
`  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);`,
`  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  const selectionId = selected
    ? encodeSelectedElement({ kind: "node", name: selected })
    : encodeSelectedElement(
        edge ? { kind: "edge", from: edge.from, to: edge.to, review: edge.review } : undefined,
      );
  useEffect(() => onSelectedElementIdChange?.(selectionId), [selectionId, onSelectedElementIdChange]);
  // 草稿变化（放弃修改、删除节点等）后选中元素可能已不存在，清空以免持久化坏引用。
  useEffect(() => {
    if (selected && !selectedElementExists({ kind: "node", name: selected }, draft.节点)) {
      setSelected(null);
    }
    if (edge && !selectedElementExists({ kind: "edge", ...edge }, draft.节点)) {
      setEdge(null);
    }
  }, [draft, selected, edge]);`, "C");

// D. helpers after isReviewNode
text = applyPair(text,
`/** 只有显式声明 审核: true 的节点才能挂审核回边（内核同源约束）。 */
export function isReviewNode(node: WizardRecipeNode): boolean {
  return (node as Record<string, unknown>).审核 === true;
}`,
`/** 只有显式声明 审核: true 的节点才能挂审核回边（内核同源约束）。 */
export function isReviewNode(node: WizardRecipeNode): boolean {
  return (node as Record<string, unknown>).审核 === true;
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
 * 编码选中元素：节点用名字原文，连线用 \`edge:\` 前缀加 JSON \`[from,to,review]\`
 * （review 为布尔）。未选中返回 undefined。这是持久化用的紧凑格式，仅渲染层解释。
 */
export function encodeSelectedElement(
  selection: SelectedElement | null | undefined,
): string | undefined {
  if (!selection) return undefined;
  if (selection.kind === "node") return selection.name || undefined;
  return \`\${EDGE_SELECTION_PREFIX}\${JSON.stringify([selection.from, selection.to, selection.review])}\`;
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
}`, "D");

writeFileSync(file, text, "utf8");
console.log("OK", file);
