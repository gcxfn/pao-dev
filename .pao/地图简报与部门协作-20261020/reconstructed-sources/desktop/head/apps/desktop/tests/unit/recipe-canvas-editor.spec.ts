/**
 * 审核回边连线规则单元测试（纯函数，无浏览器）。
 *
 * 只覆盖 recipe-canvas-editor.tsx 里「已接通」的依赖与审核回边判定；schema 与内核
 * workflow/recipe.ts 同源：回边＝{ 目标, 上限, 超限动作 }[]，只有 审核: true 的节点可挂，
 * 目标必须是依赖链上游。不测试未实现的连线条件。
 *
 * S3-2 增：连线应用单源 applyConnection（拖拽/连线模式两入口共用）、连线模式判定
 * connectVerdicts、复制节点 planNodeCopy、改名提交 commitNodeRename、连接桩样式尺寸。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "@playwright/test";
import type { WizardRecipeNode } from "../../contracts/workflow-wizard";
import type { CanvasNodeView } from "../../src/features/canvas/canvas-model";
import {
  applyConnection,
  commitNodeRename,
  connectVerdicts,
  decodeSelectedElement,
  dependencyAncestors,
  editorUnsaved,
  encodeSelectedElement,
  isReviewNode,
  planConnection,
  planNodeCopy,
  readReviewEdges,
  selectedElementExists,
} from "../../src/features/canvas/recipe-canvas-editor";

function node(name: string, patch: Record<string, unknown> = {}): WizardRecipeNode {
  return { 名字: name, 部门: "部门", depends_on: [], ...patch } as WizardRecipeNode;
}

/** 开发 → 测试 → 审查，审查为审核节点。 */
const chain: WizardRecipeNode[] = [
  node("开发"),
  node("测试", { depends_on: ["开发"] }),
  node("审查", { depends_on: ["测试"], 审核: true, 部门标准: "标准" }),
];

describe("审核回边连线规则", () => {
  test("readReviewEdges 按内核口径整形并跳过坏条目", () => {
    const review = node("审查", {
      审核: true,
      回边: [
        { 目标: "开发", 上限: 2, 超限动作: "修完这轮放行" },
        { 目标: "测试" },
        { 目标: "", 上限: 1 },
        { 目标: "开发", 上限: -1 },
        "坏条目",
      ],
    });
    expect(readReviewEdges(review)).toEqual([
      { 目标: "开发", 上限: 2, 超限动作: "修完这轮放行" },
      { 目标: "测试", 上限: 3, 超限动作: "停滞" },
    ]);
  });

  test("isReviewNode 只认 审核: true", () => {
    expect(isReviewNode(node("审查", { 审核: true }))).toBe(true);
    expect(isReviewNode(node("审查"))).toBe(false);
    expect(isReviewNode(node("审查", { 审核: "true" }))).toBe(false);
  });

  test("dependencyAncestors 收集传递上游、不含自身", () => {
    expect([...dependencyAncestors(chain, "审查")].sort()).toEqual(["开发", "测试"]);
    expect([...dependencyAncestors(chain, "开发")]).toEqual([]);
  });

  test("审核节点连到上游＝新增审核回边（默认 3／停滞）", () => {
    expect(planConnection(chain, "审查", "开发")).toEqual({
      kind: "review",
      review: "审查",
      target: "开发",
      edge: { 目标: "开发", 上限: 3, 超限动作: "停滞" },
    });
    expect(planConnection(chain, "审查", "测试")).toEqual({
      kind: "review",
      review: "审查",
      target: "测试",
      edge: { 目标: "测试", 上限: 3, 超限动作: "停滞" },
    });
  });

  test("非审核节点连到上游＝拒绝成环；普通连线＝新增依赖", () => {
    expect(planConnection(chain, "测试", "开发")).toEqual({
      kind: "reject",
      message: "该依赖会形成循环。审核退回须在审核节点上单独配置。",
    });
    expect(planConnection([node("甲"), node("乙")], "甲", "乙")).toEqual({
      kind: "dependency",
      target: "乙",
      source: "甲",
    });
  });

  test("重复回边、自连给出拒绝，已存在的普通依赖为 noop", () => {
    const withEdge: WizardRecipeNode[] = [
      node("开发"),
      node("测试", { depends_on: ["开发"] }),
      node("审查", {
        depends_on: ["测试"],
        审核: true,
        回边: [{ 目标: "开发", 上限: 3, 超限动作: "停滞" }],
      }),
    ];
    expect(planConnection(withEdge, "审查", "开发")).toEqual({
      kind: "reject",
      message: "该审核回边已存在。",
    });
    expect(planConnection(chain, "审查", "审查")).toEqual({
      kind: "reject",
      message: "节点不能依赖自己。",
    });
    expect(planConnection(chain, "开发", "测试")).toEqual({ kind: "noop" });
    expect(planConnection(chain, "不存在", "开发")).toEqual({ kind: "noop" });
  });
});

describe("画布选中元素编码与恢复校验", () => {
  test("节点用名字原文编码，未选中返回 undefined", () => {
    expect(encodeSelectedElement({ kind: "node", name: "开发" })).toBe("开发");
    expect(encodeSelectedElement(null)).toBeUndefined();
    expect(encodeSelectedElement(undefined)).toBeUndefined();
  });

  test("连线用 edge: 前缀加 JSON 编码，含 review 布尔", () => {
    expect(encodeSelectedElement({ kind: "edge", from: "审查", to: "开发", review: true })).toBe(
      `edge:${JSON.stringify(["审查", "开发", true])}`,
    );
    expect(encodeSelectedElement({ kind: "edge", from: "开发", to: "测试", review: false })).toBe(
      `edge:${JSON.stringify(["开发", "测试", false])}`,
    );
  });

  test("decode 与 encode 往返一致；空串与坏格式当作未选中", () => {
    const node = { kind: "node", name: "开发" } as const;
    const edge = { kind: "edge", from: "审查", to: "开发", review: true } as const;
    expect(decodeSelectedElement(encodeSelectedElement(node))).toEqual(node);
    expect(decodeSelectedElement(encodeSelectedElement(edge))).toEqual(edge);
    expect(decodeSelectedElement(undefined)).toBeUndefined();
    expect(decodeSelectedElement("")).toBeUndefined();
    expect(decodeSelectedElement("edge:不是 JSON")).toBeUndefined();
    expect(decodeSelectedElement(`edge:${JSON.stringify(["甲", "乙"])}`)).toBeUndefined();
    expect(decodeSelectedElement(`edge:${JSON.stringify(["甲", "乙", "是"])}`)).toBeUndefined();
  });

  test("节点选中在校验：存在为 true，被删/改名后为 false", () => {
    expect(selectedElementExists({ kind: "node", name: "开发" }, chain)).toBe(true);
    expect(selectedElementExists({ kind: "node", name: "已删" }, chain)).toBe(false);
  });

  test("连线选中校验：依赖边与审核回边各自核对，删除后为 false", () => {
    expect(selectedElementExists({ kind: "edge", from: "开发", to: "测试", review: false }, chain)).toBe(
      true,
    );
    expect(selectedElementExists({ kind: "edge", from: "测试", to: "开发", review: false }, chain)).toBe(
      false,
    );
    const withReview = chain.map((row) =>
      row.名字 === "审查"
        ? { ...row, 回边: [{ 目标: "开发", 上限: 3, 超限动作: "停滞" }] }
        : row,
    );
    expect(
      selectedElementExists({ kind: "edge", from: "审查", to: "开发", review: true }, withReview),
    ).toBe(true);
    expect(
      selectedElementExists({ kind: "edge", from: "审查", to: "开发", review: true }, chain),
    ).toBe(false);
    expect(
      selectedElementExists({ kind: "edge", from: "测试", to: "开发", review: true }, chain),
    ).toBe(false);
  });
});

describe("未保存判定单一谓词（S3-1）", () => {
  test("有内容改动或未落盘（revision 为空）都算未保存；已落盘且无改动才是已保存", () => {
    // 全新骨架即使一字未动也算未保存（revision===null），与工具栏徽章同源。
    expect(editorUnsaved(false, null)).toBe(true);
    expect(editorUnsaved(true, null)).toBe(true);
    expect(editorUnsaved(true, "指纹")).toBe(true);
    expect(editorUnsaved(false, "指纹")).toBe(false);
  });
});

describe("连线应用单源 applyConnection（S3-2：拖拽与连线模式两入口共用）", () => {
  test("普通连线产出加依赖的节点表，plan 与 planConnection 同一结论", () => {
    const { plan, nodes } = applyConnection(chain, "开发", "审查");
    expect(plan).toEqual(planConnection(chain, "开发", "审查"));
    expect(plan).toEqual({ kind: "dependency", target: "审查", source: "开发" });
    expect(nodes?.find((row) => row.名字 === "审查")?.depends_on).toEqual(["测试", "开发"]);
    // 未涉及的节点保持原样
    expect(nodes?.find((row) => row.名字 === "开发")).toEqual(chain[0]);
  });

  test("审核节点连上游＝追加默认回边（上限 3／停滞）", () => {
    const { plan, nodes } = applyConnection(chain, "审查", "开发");
    expect(plan.kind).toBe("review");
    expect(
      readReviewEdges(nodes?.find((row) => row.名字 === "审查") as WizardRecipeNode),
    ).toEqual([{ 目标: "开发", 上限: 3, 超限动作: "停滞" }]);
  });

  test("成环拒绝与已存在依赖 noop 不改节点表，plan 原样带回（供跟随浮层提示）", () => {
    const rejected = applyConnection(chain, "测试", "开发");
    expect(rejected.plan).toEqual({
      kind: "reject",
      message: "该依赖会形成循环。审核退回须在审核节点上单独配置。",
    });
    expect(rejected.nodes).toBeUndefined();
    const noop = applyConnection(chain, "开发", "测试"); // 测试 已依赖 开发
    expect(noop.plan).toEqual({ kind: "noop" });
    expect(noop.nodes).toBeUndefined();
  });
});

describe("连线模式判定 connectVerdicts（S3-2：高亮与 hover 提示）", () => {
  test("合法依赖/审核回边为 legal；环拒绝与已存在为非法并带原因文本", () => {
    const withReview = [
      ...chain,
      node("验收", { depends_on: [] }),
    ];
    const verdicts = connectVerdicts(withReview, "审查");
    expect(verdicts["开发"]).toMatchObject({ legal: true });
    expect(verdicts["开发"]?.text).toContain("审核回边");
    expect(verdicts["验收"]).toMatchObject({ legal: true });
    expect(verdicts["验收"]?.text).toContain("依赖");
    const fromTest = connectVerdicts(withReview, "测试");
    expect(fromTest["开发"]?.legal).toBe(false);
    expect(fromTest["开发"]?.text).toBe("该依赖会形成循环。审核退回须在审核节点上单独配置。");
    const dup = connectVerdicts(chain, "开发");
    expect(dup["测试"]).toMatchObject({ legal: false, text: "已存在依赖" });
  });
});

describe("复制节点 planNodeCopy（S3-2）", () => {
  const viewsOf = (nodes: readonly WizardRecipeNode[]): CanvasNodeView[] =>
    nodes.map((row) => ({
      name: row.名字,
      dept: row.部门,
      dependsOn: row.depends_on ?? [],
      requiresConfirmation: false,
    }));

  test("重名自动派生：首选「副本」，占用则「副本2」「副本3」", () => {
    const once = planNodeCopy(chain, viewsOf(chain), "开发");
    expect(once?.name).toBe("开发副本");
    const twice = planNodeCopy(
      [...chain, node("开发副本")],
      viewsOf([...chain, node("开发副本")]),
      "开发",
    );
    expect(twice?.name).toBe("开发副本2");
  });

  test("依赖与回边不复制，其余字段保留；位置＝源节点位置偏移落点", () => {
    const review = node("审查", {
      depends_on: ["测试"],
      审核: true,
      部门标准: "标准",
      回边: [{ 目标: "开发", 上限: 2, 超限动作: "停滞" }],
    });
    const nodes: WizardRecipeNode[] = [node("开发"), review];
    const views: CanvasNodeView[] = [
      { name: "开发", dept: "工程", dependsOn: [], requiresConfirmation: false },
      // 源节点已有保存坐标：副本落点＝坐标＋偏移
      { name: "审查", dept: "评审", dependsOn: [], requiresConfirmation: false, position: { x: 120, y: 80 } },
    ];
    const copy = planNodeCopy(nodes, views, "审查");
    expect(copy?.node).toMatchObject({
      名字: "审查副本",
      部门: "部门",
      部门标准: "标准",
      审核: true,
      depends_on: [],
    });
    expect(readReviewEdges(copy?.node as WizardRecipeNode)).toEqual([]);
    expect(copy?.position).toEqual({ x: 120 + 40, y: 80 + 40 });
    // 无保存坐标时用布局坐标偏移，仍给确定落点
    const laid = planNodeCopy(nodes, viewsOf(nodes), "开发");
    expect(laid?.position).toBeDefined();
    expect(laid?.position?.x).toBeGreaterThan(0);
  });
});

describe("改名提交 commitNodeRename（S3-2：回车/失焦共用，Esc 不经此）", () => {
  const draft = {
    名字: "配方",
    参数: [],
    节点: [
      node("开发", { depends_on: [] }),
      node("测试", { depends_on: ["开发"] }),
      node("审查", {
        depends_on: ["测试"],
        审核: true,
        回边: [{ 目标: "开发", 上限: 2, 超限动作: "停滞" }],
      }),
    ],
    ui: { positions: { 开发: { x: 40, y: 90 }, 测试: { x: 380, y: 90 } } },
  };

  test("一次提交同步名字、坐标、依赖与回边引用", () => {
    const result = commitNodeRename(draft, "开发", "实现新版");
    expect(result.error).toBeUndefined();
    const next = result.draft;
    expect(next?.节点.map((row) => row.名字)).toEqual(["实现新版", "测试", "审查"]);
    expect(next?.节点.find((row) => row.名字 === "测试")?.depends_on).toEqual(["实现新版"]);
    expect(
      readReviewEdges(next?.节点.find((row) => row.名字 === "审查") as WizardRecipeNode),
    ).toEqual([{ 目标: "实现新版", 上限: 2, 超限动作: "停滞" }]);
    const positions = (next?.ui as { positions: Record<string, unknown> }).positions;
    expect(positions["实现新版"]).toEqual({ x: 40, y: 90 });
    expect("开发" in positions).toBe(false);
    expect(positions["测试"]).toEqual({ x: 380, y: 90 });
  });

  test("重名报错且不改草稿；同名与空白为 no-op（保留原名）", () => {
    expect(commitNodeRename(draft, "开发", "测试")).toEqual({
      error: "节点名称已存在，请换一个名称。",
    });
    expect(commitNodeRename(draft, "开发", "开发").draft).toBeUndefined();
    expect(commitNodeRename(draft, "开发", "  ").draft).toBeUndefined();
    expect(commitNodeRename(draft, "开发", "测试").draft).toBeUndefined();
  });
});

describe("连接桩样式（S3-2：§8.1 尺寸 10–12px、hover 放大）", () => {
  test("canvas.css 定制 handle 尺寸且 hover 更大", () => {
    const css = readFileSync(join(__dirname, "../../src/styles/canvas.css"), "utf8");
    const base = css.match(/\.workflow-graph \.react-flow__handle \{[^}]*\}/)?.[0] ?? "";
    const hover = css.match(/\.workflow-graph \.react-flow__handle:hover \{[^}]*\}/)?.[0] ?? "";
    const baseSize = Number(base.match(/width:\s*(\d+(?:\.\d+)?)px/)?.[1]);
    const hoverSize = Number(hover.match(/width:\s*(\d+(?:\.\d+)?)px/)?.[1]);
    expect(baseSize).toBeGreaterThanOrEqual(10);
    expect(baseSize).toBeLessThanOrEqual(12);
    expect(hoverSize).toBeGreaterThan(baseSize);
  });
});
