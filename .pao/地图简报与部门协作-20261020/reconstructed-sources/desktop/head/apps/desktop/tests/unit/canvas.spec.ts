/**
 * 工作流画布（P4-2）单元测试：查询桥整形（好/坏配方混合＋多状态实例）＋DAG 纯函数
 * （分层布局/着色/回边）＋组件渲染快照断言（三区渲染/着色/坏配方错误行/刷新按钮）。
 * 组件用 react-dom/server renderToString 直渲染（受控选中态），无浏览器依赖。
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeAll, describe, expect, test } from "@playwright/test";
import type { CanvasRecipeSummary, CanvasResult, CanvasSnapshot } from "../../contracts/canvas";
import {
  createCanvasQuery,
  normalizeAnomalies,
  normalizeCanvasView,
  normalizeInstances,
  normalizeNodeInstance,
  normalizeRecipeEntries,
} from "../../electron/platform/pao/canvas-query";
import type { PaoDesktopCanvasReader } from "@pi-gui/pi-sdk-driver";
import {
  canvasArrivalPlan,
  canvasNodeTone,
  computeCanvasLayout,
  instanceDagNodes,
  recipeForInstance,
  resolveInstance,
} from "../../src/features/canvas/canvas-model";
import type { RecipeEditorEntry } from "../../src/features/canvas/recipe-canvas-editor";
import type { WorkflowCatalogSnapshot } from "../../contracts/workflow-wizard";

/**
 * Playwright 的 babel transform 会把所有 .tsx 的 JSX 编到它自带的 playwright/jsx-runtime
 * （产出 {__pw_type} 伪元素，供组件测试浏览器挂载用），renderToString 无法消化。
 * 组件渲染测试先把该模块在 require 缓存里换成真 react/jsx-runtime，再加载组件。
 */
let CanvasPageView: (typeof import("../../src/features/canvas/canvas-page"))["CanvasPageView"];
let resolveEditorEntry: (typeof import("../../src/features/canvas/canvas-page"))["resolveEditorEntry"];
let pullCanvasAfterStart: (typeof import("../../src/features/canvas/canvas-page"))["pullCanvasAfterStart"];
beforeAll(() => {
  const real = require("react/jsx-runtime");
  require.cache[require.resolve("playwright/jsx-runtime")] = {
    id: "react/jsx-runtime",
    filename: require.resolve("react/jsx-runtime"),
    loaded: true,
    exports: real,
  } as never;
  ({ CanvasPageView, resolveEditorEntry, pullCanvasAfterStart } =
    require("../../src/features/canvas/canvas-page") as {
      CanvasPageView: typeof CanvasPageView;
      resolveEditorEntry: typeof resolveEditorEntry;
      pullCanvasAfterStart: typeof pullCanvasAfterStart;
    });
});

const snapshot: CanvasSnapshot = {
  state: "available",
  recipes: [
    {
      name: "好流",
      available: true,
      recipe: {
        version: 2,
        autoExecute: false,
        params: ["目标项目"],
        placeholders: ["目标项目"],
        topoOrder: ["实现", "复核"],
        nodes: [
          { name: "实现", dept: "工程", dependsOn: [], requiresConfirmation: false },
          {
            name: "复核",
            dept: "评审",
            dependsOn: ["实现"],
            requiresConfirmation: true,
            model: "主力",
            thinkingLevel: "high",
          },
        ],
      },
    },
    { name: "坏流", available: false, error: { code: "RECIPE_CYCLE", detail: "节点依赖成环" } },
  ],
  instances: [
    {
      name: "好流",
      path: "/p/.pao/工作流实例-好流.md",
      workflow: "好流",
      cardDir: "/p/.pao/卡",
      startedAt: "2026-10-05 10:00",
      status: "运行中",
      params: { 目标项目: "项目X" },
      nodes: [
        {
          name: "实现",
          cardRef: "卡0001",
          status: "delivered",
          suspended: undefined,
          confirmation: undefined,
          sessionId: "sess-run",
          sessionState: "运行中",
        },
        { name: "复核", status: "no_card", suspended: "等待人工确认" },
      ],
    },
    {
      name: "幽灵",
      path: "/p/.pao/工作流实例-幽灵.md",
      workflow: "坏流",
      cardDir: "/p/.pao/卡",
      startedAt: "2026-10-05 10:00",
      status: "运行中",
      params: {},
      nodes: [{ name: "甲", status: "读取异常" }],
    },
  ],
  anomalies: [{ path: "/p/.pao/工作流实例-坏档.md", reason: "清单损坏" }],
};
const initialRecipe = snapshot.recipes[0];
if (!initialRecipe.available) throw new Error("测试配方应可用");
snapshot.instances[0] = { ...snapshot.instances[0], frozenRecipe: initialRecipe.recipe };

/** 查询桥先 stat 再读：加载器类用例需要一个真实存在的目录占位 PAO_HOME。 */
async function realDir(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return mkdtemp(join(tmpdir(), "pi-gui-canvas-home-"));
}

describe("canvas node tone", () => {
  test("状态着色六态：灰/蓝/绿/黄/橙/红（S10 单域英文值域）", () => {
    expect(canvasNodeTone({ status: "no_card" })).toBe("grey");
    expect(canvasNodeTone({ status: "unclaimed" })).toBe("grey");
    expect(canvasNodeTone({ status: "canceled" })).toBe("grey");
    expect(canvasNodeTone({ status: "任意未知值" })).toBe("grey");
    expect(canvasNodeTone({ status: "in_progress" })).toBe("blue");
    expect(canvasNodeTone({ status: "delivered" })).toBe("green");
    expect(canvasNodeTone({ status: "no_card", suspended: "等待人工确认" })).toBe("yellow");
    expect(canvasNodeTone({ status: "in_progress", suspended: "缺输入停" })).toBe("orange");
    expect(canvasNodeTone({ status: "读取异常" })).toBe("red");
    expect(canvasNodeTone({ status: "failed" })).toBe("red");
    expect(canvasNodeTone({})).toBe("grey");
  });
});

describe("canvas dag layout", () => {
  test("分层布局：依赖链从左到右，边正向", () => {
    const layout = computeCanvasLayout([
      { name: "实现", dept: "工程", dependsOn: [], requiresConfirmation: false },
      { name: "复核", dept: "评审", dependsOn: ["实现"], requiresConfirmation: true },
    ]);
    expect(layout.boxes.map((box) => [box.name, box.layer])).toEqual([
      ["实现", 0],
      ["复核", 1],
    ]);
    expect(layout.edges).toEqual([{ from: "实现", to: "复核", back: false }]);
    const 实现 = layout.boxes[0];
    const 复核 = layout.boxes[1];
    expect(复核.x).toBeGreaterThan(实现.x);
    expect(layout.width).toBeGreaterThan(复核.x);
  });

  test("回边（指向同层/更早依赖）标记 back，环依赖不炸", () => {
    const layout = computeCanvasLayout([
      { name: "甲", dept: "工程", dependsOn: ["乙"], requiresConfirmation: false },
      { name: "乙", dept: "工程", dependsOn: ["甲"], requiresConfirmation: false },
    ]);
    // 环兜底不炸：两条边都在，先入环的节点被垫到更深层，指向它的那条标 back。
    expect(layout.edges).toHaveLength(2);
    expect(layout.edges.filter((edge) => edge.back)).toEqual([
      { from: "甲", to: "乙", back: true },
    ]);
  });

  test("画布外依赖不参与分层", () => {
    const layout = computeCanvasLayout([
      { name: "甲", dept: "工程", dependsOn: ["不存在"], requiresConfirmation: false },
    ]);
    expect(layout.boxes[0].layer).toBe(0);
    expect(layout.edges).toEqual([]);
  });
});

describe("instance dag join", () => {
  test("修改最新配方不能改变旧实例，缺冻结图不借最新配方", () => {
    const instance = snapshot.instances[0];
    const updated = { ...snapshot, recipes: [] };
    expect(recipeForInstance(updated, instance)).toEqual(instance.frozenRecipe);
    expect(recipeForInstance(snapshot, { ...instance, frozenRecipe: undefined })).toBeUndefined();
  });
  test("保存坐标从查询桥传到实例布局", () => {
    const rows = normalizeInstances([
      {
        名字: "旧流",
        路径: "/p/i",
        节点: [],
        frozenRecipe: {
          版本: 2,
          节点: [{ 名字: "开发", 部门: "工程", depends_on: [] }],
          ui: { positions: { 开发: { x: 820, y: 440 } } },
        },
      },
    ]);
    const nodes = instanceDagNodes(rows[0], recipeForInstance(snapshot, rows[0]));
    const layout = computeCanvasLayout(nodes);
    expect(layout.boxes[0]).toMatchObject({ x: 820, y: 440 });
    expect(layout.width).toBeGreaterThan(820);
  });
  test("卡现读状态为准，配方不可读退化为清单-only", () => {
    const instance = snapshot.instances[0];
    const recipe = recipeForInstance(snapshot, instance);
    expect(recipe).toBeDefined();
    const nodes = instanceDagNodes(instance, recipe);
    expect(nodes.map((node) => [node.name, node.status])).toEqual([
      ["实现", "delivered"],
      ["复核", "no_card"],
    ]);
    expect(nodes[1].suspended).toBe("等待人工确认");
    const ghost = snapshot.instances[1];
    expect(recipeForInstance(snapshot, ghost)).toBeUndefined(); // 坏配方不参与 DAG
    const degraded = instanceDagNodes(ghost, undefined);
    expect(degraded.map((node) => node.dependsOn)).toEqual([[]]);
  });
});

describe("canvas query shaping", () => {
  test("normalizeCanvasView 整形中文键原始视图", () => {
    const shaped = normalizeCanvasView({
      配方: [
        {
          名字: "好流",
          可用: true,
          配方: {
            版本: 2,
            自动执行: true,
            参数: ["目标项目"],
            占位符: ["目标项目"],
            拓扑序: ["实现"],
            节点: [
              {
                名字: "实现",
                部门: "工程",
                depends_on: [],
                人工确认: false,
                模型: "主力",
                思考强度: "high",
              },
              { 部门: "工程" }, // 坏行剔除
              null,
            ],
          },
        },
        { 名字: "坏流", 可用: false, 错误: { 代码: "RECIPE_CYCLE", 说明: "成环" } },
      ],
      实例: [
        {
          名字: "好流",
          路径: "/p/i",
          工作流: "好流",
          卡目录: "/p/卡",
          启动: "2026-10-05 10:00",
          状态: "运行中",
          参数: { 目标项目: "项目X" },
          节点: [{ 名字: "实现", 卡号: "卡0001", 状态: "delivered", 会话标识: "sess-run" }, null],
        },
      ],
      异常: [{ 路径: "/p/bad", 原因: "清单损坏" }, { 路径: "" }],
      错误: "配方目录不可读",
    });
    expect(shaped.state).toBe("available");
    expect(shaped.error).toBe("配方目录不可读");
    expect(shaped.recipes).toHaveLength(2);
    if (shaped.recipes[0].available) {
      expect(shaped.recipes[0].recipe.nodes).toHaveLength(1);
      expect(shaped.recipes[0].recipe.nodes[0]).toEqual({
        name: "实现",
        dept: "工程",
        dependsOn: [],
        requiresConfirmation: false,
        model: "主力",
        thinkingLevel: "high",
      });
    } else {
      throw new Error("unreachable");
    }
    expect(shaped.recipes[1]).toEqual({
      name: "坏流",
      available: false,
      error: { code: "RECIPE_CYCLE", detail: "成环" },
    });
    expect(shaped.instances[0].params).toEqual({ 目标项目: "项目X" });
    expect(shaped.instances[0].nodes).toEqual([
      {
        name: "实现",
        status: "delivered",
        cardRef: "卡0001",
        sessionId: "sess-run",
      },
    ]);
    expect(shaped.anomalies).toEqual([{ path: "/p/bad", reason: "清单损坏" }]);
  });

  test("normalize* 拒绝非列表输入", () => {
    expect(() => normalizeRecipeEntries("nope")).toThrow();
    expect(() => normalizeRecipeSummary_shim()).toThrow();
    expect(() => normalizeInstances(42)).toThrow();
    expect(() => normalizeAnomalies(undefined)).toThrow();
    expect(() => normalizeCanvasView("nope")).toThrow();
  });

  test("normalizeRecipeEntries：形状坏的条目显式错误行，不静默消失（与 wizard 剔错同口径）", () => {
    const rows = normalizeRecipeEntries([
      { 名字: "坏流", 可用: false, 错误: { 代码: "RECIPE_CYCLE", 说明: "成环" } },
      42,
      { 可用: true, 配方: { 节点: [] } },
    ]);
    expect(rows).toEqual([
      { name: "坏流", available: false, error: { code: "RECIPE_CYCLE", detail: "成环" } },
      {
        name: "未知",
        available: false,
        error: { code: "形状损坏", detail: "配方条目不是对象（number）。" },
      },
      {
        name: "未知",
        available: false,
        error: { code: "形状损坏", detail: "配方条目缺名字。" },
      },
    ]);
  });

  test("normalizeNodeInstance：坏输入剔除＋空状态兜底 no_card＋可选字段条件展开", () => {
    // 非对象剔除（normalizeInstances 节点段口径：坏节点不进行，不抛）
    expect(normalizeNodeInstance(undefined)).toBeUndefined();
    expect(normalizeNodeInstance(null)).toBeUndefined();
    expect(normalizeNodeInstance(42)).toBeUndefined();
    expect(normalizeNodeInstance("节点")).toBeUndefined();
    // 名字缺失/空白＝undefined
    expect(normalizeNodeInstance({ 状态: "delivered" })).toBeUndefined();
    expect(normalizeNodeInstance({ 名字: "  ", 状态: "delivered" })).toBeUndefined();
    // 状态空兜底 no_card（S10 投影单域英文），其余可选中字段空串不出现键
    expect(normalizeNodeInstance({ 名字: "实现" })).toEqual({ name: "实现", status: "no_card" });
    // 六个可选中字段：有值才展开，原值透传
    expect(
      normalizeNodeInstance({
        名字: "复核",
        状态: "delivered",
        卡号: "卡0002",
        挂起: "等待人工确认",
        确认: "待确认",
        会话标识: "sess-1",
        会话路径: "/s/t.jsonl",
        会话状态: "running",
      }),
    ).toEqual({
      name: "复核",
      status: "delivered",
      cardRef: "卡0002",
      suspended: "等待人工确认",
      confirmation: "待确认",
      sessionId: "sess-1",
      sessionPath: "/s/t.jsonl",
      sessionState: "running",
    });
    expect(
      Object.keys(
        normalizeNodeInstance({
          名字: "甲",
          状态: "x",
          卡号: " ",
          挂起: "",
          确认: "",
          会话标识: "",
          会话路径: "",
          会话状态: "",
        }),
      ),
    ).toEqual(["name", "status"]);
  });

  // normalizeRecipeSummary 未单独导出的断言借 normalizeCanvasView 覆盖（非对象摘要抛错）。
  function normalizeRecipeSummary_shim(): void {
    normalizeCanvasView({
      配方: [{ 名字: "坏档", 可用: true, 配方: 42 }],
      实例: [],
      异常: [],
    });
  }

  test("createCanvasQuery：缺 PAO_HOME 不加载读取器", async () => {
    let loaded = false;
    const query = createCanvasQuery({
      paoHome: "",
      loadReader: async () => {
        loaded = true;
        throw new Error("unreachable");
      },
    });
    const result = await query.collect();
    expect(result.state).toBe("unavailable");
    if (result.state !== "unavailable") throw new Error("unreachable");
    expect(result.code).toBe("pao-home-missing");
    expect(loaded).toBe(false);
  });

  test("createCanvasQuery：读取器加载失败＝unavailable，不伪装空画布", async () => {
    const query = createCanvasQuery({
      paoHome: await realDir(),
      loadReader: async () => {
        throw new Error("fork build products missing");
      },
    });
    const result = await query.collect();
    expect(result.state).toBe("unavailable");
    if (result.state !== "unavailable") throw new Error("unreachable");
    expect(result.code).toBe("aggregates-unavailable");
    expect(result.message).toContain("fork build products missing");
  });

  test("createCanvasQuery：happy path 透传＋整形（好/坏配方混合）", async () => {
    const raw = {
      配方: snapshot.recipes.map((entry) =>
        entry.available
          ? {
              名字: entry.name,
              可用: true,
              配方: {
                版本: entry.recipe.version,
                自动执行: entry.recipe.autoExecute,
                参数: [...entry.recipe.params],
                占位符: [...entry.recipe.placeholders],
                拓扑序: [...entry.recipe.topoOrder],
                节点: entry.recipe.nodes.map((node) => ({
                  名字: node.name,
                  部门: node.dept,
                  depends_on: [...node.dependsOn],
                  人工确认: node.requiresConfirmation,
                  ...(node.model !== undefined ? { 模型: node.model } : {}),
                  ...(node.thinkingLevel !== undefined ? { 思考强度: node.thinkingLevel } : {}),
                })),
              },
            }
          : {
              名字: entry.name,
              可用: false,
              错误: { 代码: entry.error.code, 说明: entry.error.detail },
            },
      ),
      实例: snapshot.instances.map((instance) => ({
        名字: instance.name,
        路径: instance.path,
        工作流: instance.workflow,
        卡目录: instance.cardDir,
        启动: instance.startedAt,
        状态: instance.status,
        参数: { ...instance.params },
        节点: instance.nodes.map((node) => ({
          名字: node.name,
          ...(node.cardRef !== undefined ? { 卡号: node.cardRef } : {}),
          状态: node.status,
          ...(node.suspended !== undefined ? { 挂起: node.suspended } : {}),
          ...(node.sessionId !== undefined ? { 会话标识: node.sessionId } : {}),
          ...(node.sessionState !== undefined ? { 会话状态: node.sessionState } : {}),
        })),
      })),
      异常: snapshot.anomalies.map((row) => ({ 路径: row.path, 原因: row.reason })),
    };
    const home = await realDir();
    const reader: PaoDesktopCanvasReader = (passed) => {
      expect(passed).toBe(home);
      return raw as ReturnType<PaoDesktopCanvasReader>;
    };
    const query = createCanvasQuery({ paoHome: home, loadReader: async () => reader });
    const result = await query.collect();
    expect(result.state).toBe("available");
    if (result.state !== "available") throw new Error("unreachable");
    expect(result.recipes).toHaveLength(2);
    expect(result.instances).toHaveLength(2);
    expect(result.instances[0].nodes[0].status).toBe("delivered");
    expect(result.anomalies).toEqual([{ path: "/p/.pao/工作流实例-坏档.md", reason: "清单损坏" }]);
  });
});

describe("canvas view envelope（S6-D2 视图信封消费）", () => {
  const envelope = {
    version: 1 as const,
    sessionGeneration: "a".repeat(64),
    revision: "b".repeat(64),
    publishedAt: "2026-10-07T02:00:00.000Z",
  };

  test("normalizeCanvasView 透出信封四字段（K4 契约：version/sessionGeneration/revision/publishedAt）", () => {
    const shaped = normalizeCanvasView({
      配方: [],
      实例: [],
      异常: [],
      envelope: { ...envelope },
    });
    expect(shaped.envelope).toEqual(envelope);
  });

  test("unknown 兜底：旧内核 dist 无信封键＝envelope 缺省，画布照常整形不炸", () => {
    const shaped = normalizeCanvasView({ 配方: [], 实例: [], 异常: [] });
    expect(shaped.state).toBe("available");
    expect(shaped.envelope).toBeUndefined();
    expect(shaped.recipes).toEqual([]);
  });

  test("unknown 兜底：信封形态坏（非对象/version≠1/缺字段/空串）整包按未知处理", () => {
    for (const bad of [
      42,
      "envelope",
      [],
      { ...envelope, version: 2 },
      { ...envelope, sessionGeneration: undefined },
      { ...envelope, revision: 7 },
      { ...envelope, publishedAt: "" },
      { version: 1, sessionGeneration: "a".repeat(64), revision: "b".repeat(64) },
    ]) {
      const shaped = normalizeCanvasView({ 配方: [], 实例: [], 异常: [], envelope: bad });
      expect(shaped.envelope).toBeUndefined();
    }
  });

  test("到达判定：旧 requestId 响应作废（竞速旧响应不覆新）", () => {
    expect(
      canvasArrivalPlan({
        requestId: 1,
        latestRequestId: 2,
        arrival: { sessionGeneration: "gA", revision: "r1" },
        baseline: {},
      }),
    ).toBe("drop");
  });

  test("换代际后旧响应作废：新代际请求已采纳基准，迟到的旧代际响应被丢弃", () => {
    // 请求 1（代际 gA）在途；用户刷新发起请求 2（代际 gB）并已提交、基准换成 gB。
    const committed = canvasArrivalPlan({
      requestId: 2,
      latestRequestId: 2,
      arrival: { sessionGeneration: "gB", revision: "r2" },
      baseline: { sessionGeneration: "gA", revision: "r1" },
    });
    expect(committed).toBe("commit"); // 新代际＝切作用域，新查询接管基准并提交
    // 此后请求 1 的旧响应才到达：requestId 已落后＝作废（不旧覆新）。
    expect(
      canvasArrivalPlan({
        requestId: 1,
        latestRequestId: 2,
        arrival: { sessionGeneration: "gA", revision: "r1" },
        baseline: { sessionGeneration: "gB", revision: "r2" },
      }),
    ).toBe("drop");
  });

  test("指纹去重：同代际同 revision＝dedupe 不重渲染；publishedAt 变化不算变化（不参与指纹）", () => {
    expect(
      canvasArrivalPlan({
        requestId: 3,
        latestRequestId: 3,
        arrival: { sessionGeneration: "gA", revision: "r1" },
        baseline: { sessionGeneration: "gA", revision: "r1" },
      }),
    ).toBe("dedupe");
  });

  test("同代际内容变化或代际变化＝commit；信封缺省（旧 dist）从不去重", () => {
    expect(
      canvasArrivalPlan({
        requestId: 4,
        latestRequestId: 4,
        arrival: { sessionGeneration: "gA", revision: "r2" },
        baseline: { sessionGeneration: "gA", revision: "r1" },
      }),
    ).toBe("commit");
    expect(
      canvasArrivalPlan({
        requestId: 5,
        latestRequestId: 5,
        arrival: { sessionGeneration: "gB", revision: "r1" },
        baseline: { sessionGeneration: "gA", revision: "r1" },
      }),
    ).toBe("commit");
    expect(
      canvasArrivalPlan({
        requestId: 6,
        latestRequestId: 6,
        arrival: {},
        baseline: { sessionGeneration: "gA", revision: "r1" },
      }),
    ).toBe("commit");
    expect(
      canvasArrivalPlan({
        requestId: 7,
        latestRequestId: 7,
        arrival: { sessionGeneration: "gA", revision: "r1" },
        baseline: {},
      }),
    ).toBe("commit");
  });
});

describe("canvas page view (renderToString)", () => {
  const selection = { kind: "instance" as const, name: "好流" };

  function render(props: Partial<Parameters<typeof CanvasPageView>[0]> = {}): string {
    return renderToString(
      createElement(CanvasPageView, {
        result: snapshot,
        loading: false,
        onRefresh: () => undefined,
        ...props,
      }),
    );
  }

  test("三区渲染＋坏配方错误行＋异常行＋刷新按钮", () => {
    const html = render();
    expect(html).toContain('data-testid="canvas-list"');
    expect(html).toContain('data-testid="canvas-dag"');
    expect(html).toContain('data-testid="canvas-node-detail"');
    expect(html).toContain('data-testid="canvas-recipe-row"');
    expect(html).toContain('data-testid="canvas-recipe-error"');
    expect(html).toContain("RECIPE_CYCLE");
    expect(html).toContain('data-testid="canvas-instance-row"');
    expect(html).toContain('data-testid="canvas-anomaly-row"');
    expect(html).toContain('data-testid="canvas-refresh"');
    // 未选中时中/右区为空态，不画节点
    expect(html).toContain('data-testid="canvas-dag-empty"');
    expect(html).not.toContain('data-testid="canvas-node"');
  });

  test("选中实例：DAG 节点着色＋依赖边＋回边虚线类缺失", () => {
    const html = render({ selection, selectedNode: null });
    expect(html).toContain('data-mode="runtime"');
    // ReactFlow SSR 输出外壳；实际节点和锁定操作由 Electron 检查。
    const nodes = instanceDagNodes(
      snapshot.instances[0],
      recipeForInstance(snapshot, snapshot.instances[0]),
    );
    // 实现已交付＝绿；复核未落卡但挂起等待人工确认＝黄
    expect(nodes.map(canvasNodeTone)).toEqual(["green", "yellow"]);
    expect(nodes[1].dependsOn).toEqual(["实现"]);
  });

  test("回边虚线：成环配方实例退化清单-only 无边", () => {
    const ghost = { kind: "instance" as const, name: "幽灵" };
    const html = render({ selection: ghost });
    expect(instanceDagNodes(snapshot.instances[1], undefined).map(canvasNodeTone)).toEqual(["red"]);
    expect(html).toContain('data-testid="canvas-dag-degraded"');
    expect(html).not.toContain('data-testid="canvas-edge"');
  });

  test("节点详情：选中节点后展示 v1 字段＋模板值", () => {
    const html = render({ selection, selectedNode: "复核" });
    expect(html).toContain('data-testid="canvas-node-detail-fields"');
    expect(html).toContain("Node details"); // 无 I18nProvider 时回落英文键
    expect(html).toContain("主力"); // 配方模板模型
    expect(html).toContain("high"); // 配方模板思考强度
    expect(html).toContain("Human confirmation");
    expect(html).toContain("未落卡");
    expect(html).toContain("等待人工确认"); // 挂起原因在详情栏透出
  });

  test("会话标识透出到详情（关联键）", () => {
    const html = render({ selection, selectedNode: "实现" });
    expect(html).toContain("sess-run");
    expect(html).toContain("卡0001");
  });

  test("unavailable 降级中文横幅；加载中刷新禁用", () => {
    const unavailable = render({
      result: { state: "unavailable", code: "pao-home-missing", message: "PAO home 未设置。" },
    });
    expect(unavailable).toContain('data-testid="canvas-unavailable"');
    expect(unavailable).toContain("PAO home 未设置。");
    const loading = render({ loading: true });
    expect(loading).toContain("disabled");
  });

  test("顶层错误横幅（配方目录不可读）", () => {
    const html = render({
      result: { ...snapshot, error: "配方目录不可读：权限不足" },
    });
    expect(html).toContain('data-testid="canvas-top-error"');
    expect(html).toContain("配方目录不可读：权限不足");
  });
});
describe("same-name instance resolution", () => {
  const recipe: CanvasRecipeSummary = {
    version: 2,
    autoExecute: false,
    params: [],
    placeholders: [],
    topoOrder: ["乙"],
    nodes: [{ name: "乙", dept: "工程", dependsOn: [], requiresConfirmation: false }],
  };
  const dup: CanvasSnapshot = {
    state: "available",
    recipes: [],
    instances: [
      {
        name: "同名",
        path: "/p/.pao/工作流实例-同名.md",
        workflow: "配方A",
        cardDir: "/p/.pao/卡",
        startedAt: "2026-10-05 10:00",
        status: "运行中",
        params: {},
        nodes: [{ name: "甲", status: "delivered" }],
      },
      {
        name: "同名",
        path: "/p/.pao/子/工作流实例-同名.md",
        workflow: "配方A",
        cardDir: "/p/.pao/子/卡",
        startedAt: "2026-10-05 10:00",
        status: "运行中",
        params: {},
        nodes: [{ name: "乙", status: "no_card" }],
        // 只有第二个实例可读冻结配方：命中它就不该出现降级横幅，据此可判定读的是哪一个。
        frozenRecipe: recipe,
      },
    ],
    anomalies: [],
  };
  const [first, second] = dup.instances;
  if (!first || !second) throw new Error("重复实例夹具应有两行");

  function renderSelection(
    result: CanvasSnapshot,
    selection: { kind: "instance"; name: string; path?: string },
  ): string {
    return renderToString(
      createElement(CanvasPageView, {
        result,
        loading: false,
        onRefresh: () => undefined,
        selection,
      }),
    );
  }

  test("resolveInstance：路径唯一／同名唯一才可定位，同名多实例＝ambiguous 不读第一个", () => {
    expect(resolveInstance(dup.instances, { kind: "instance", name: "同名" })).toEqual({
      ambiguous: true,
    });
    expect(
      resolveInstance(dup.instances, {
        kind: "instance",
        name: "同名",
        path: second.path,
      }).instance?.path,
    ).toBe(second.path);
    expect(resolveInstance([first], { kind: "instance", name: "同名" }).instance?.path).toBe(
      first.path,
    );
    expect(resolveInstance(dup.instances, { kind: "instance", name: "不存在" })).toEqual({
      ambiguous: false,
    });
    expect(
      resolveInstance(dup.instances, {
        kind: "instance",
        name: "同名",
        path: "/p/.pao/没有这个实例.md",
      }),
    ).toEqual({ ambiguous: false });
    expect(resolveInstance(dup.instances, { kind: "recipe", name: "同名" })).toEqual({
      ambiguous: false,
    });
  });

  test("instanceWorkflowModel：同名多实例无路径＝ambiguous，带路径命中具体实例", () => {
    const { instanceWorkflowModel } =
      require("../../src/features/canvas/instance-workflow-view") as typeof import("../../src/features/canvas/instance-workflow-view");
    const unresolved = instanceWorkflowModel(dup, "同名");
    expect(unresolved.ambiguous).toBe(true);
    expect(unresolved).not.toHaveProperty("instance");
    const hit = instanceWorkflowModel(dup, "同名", second.path);
    expect(hit.ambiguous).toBe(false);
    expect(hit.instance?.path).toBe(second.path);
    expect(hit.degraded).toBe(false);
  });
  test("同名旧标签无路径：不改读第一个，提示从配方库重新选择", () => {
    const html = renderSelection(dup, { kind: "instance", name: "同名" });
    expect(html).toContain('data-testid="canvas-instance-ambiguous"');
    expect(html).not.toContain('data-mode="runtime"');
  });

  test("同名旧标签带路径：精确定位到该路径的实例（可读配方，无降级）", () => {
    const html = renderSelection(dup, { kind: "instance", name: "同名", path: second.path });
    expect(html).toContain('data-mode="runtime"');
    expect(html).not.toContain('data-testid="canvas-instance-ambiguous"');
    expect(html).not.toContain('data-testid="canvas-dag-degraded"');
  });

  test("同名唯一时仍可按名回退到该实例", () => {
    const single: CanvasSnapshot = { ...dup, instances: [second] };
    const html = renderSelection(single, { kind: "instance", name: "同名" });
    expect(html).toContain('data-mode="runtime"');
    expect(html).not.toContain('data-testid="canvas-instance-ambiguous"');
    expect(html).not.toContain('data-testid="canvas-dag-degraded"');
  });
});

describe("未保存新配方骨架解析（per-tab，S3-1）", () => {
  const skeleton = (name: string): RecipeEditorEntry => ({
    name,
    revision: null,
    recipe: {
      版本: 2,
      名字: name,
      自动执行: false,
      参数: [],
      节点: [],
      ui: { positions: {} },
    },
  });
  const catalog: WorkflowCatalogSnapshot = {
    state: "available",
    recipes: [
      { name: "编辑验证", revision: "指纹A", recipe: { 名字: "编辑验证", 参数: [], 节点: [] } },
    ],
    departments: [],
    skills: [],
    tiers: [],
    thinkingLevels: [],
    templates: [],
    errors: [],
  };

  test("两个标签的骨架各自解析，互不覆盖（per-tab 不互毁）", () => {
    const newEntries = { tabA: skeleton("新工作流1"), tabB: skeleton("新工作流2") };
    expect(
      resolveEditorEntry({
        selection: { kind: "recipe", name: "新工作流1" },
        newEntries,
        activeTabId: "tabA",
        catalog,
      }),
    ).toEqual(skeleton("新工作流1"));
    expect(
      resolveEditorEntry({
        selection: { kind: "recipe", name: "新工作流2" },
        newEntries,
        activeTabId: "tabB",
        catalog,
      }),
    ).toEqual(skeleton("新工作流2"));
  });

  test("骨架命中优先于目录同名行（解析顺序显式化）", () => {
    const draft = skeleton("编辑验证");
    const resolved = resolveEditorEntry({
      selection: { kind: "recipe", name: "编辑验证" },
      newEntries: { tabA: draft },
      activeTabId: "tabA",
      catalog,
    });
    expect(resolved).toEqual(draft);
    expect(resolved?.revision).toBeNull();
  });

  test("标签竞态（activeTab 仍是旧标签）时同名骨架兜底，不被目录旧行顶掉", () => {
    const resolved = resolveEditorEntry({
      selection: { kind: "recipe", name: "新工作流1" },
      newEntries: { tabNew: skeleton("新工作流1") },
      activeTabId: "tabOld",
      catalog,
    });
    expect(resolved?.revision).toBeNull();
  });

  test("无骨架命中退回目录；实例选择、空选择与目录也没有的名字返回 undefined", () => {
    expect(
      resolveEditorEntry({
        selection: { kind: "recipe", name: "编辑验证" },
        newEntries: { tabB: skeleton("新工作流2") },
        activeTabId: "tabA",
        catalog,
      })?.revision,
    ).toBe("指纹A");
    expect(
      resolveEditorEntry({
        selection: { kind: "instance", name: "好流" },
        newEntries: {},
        activeTabId: "tabA",
        catalog,
      }),
    ).toBeUndefined();
    expect(resolveEditorEntry({ selection: null, newEntries: {}, catalog })).toBeUndefined();
    expect(
      resolveEditorEntry({
        selection: { kind: "recipe", name: "不存在" },
        newEntries: {},
        catalog,
      }),
    ).toBeUndefined();
  });
});

// ── S6-D1 桌面运行视图与动画 ────────────────────────────────────────────────

describe("S6-D1 启动定位新运行记录（locateNewInstances）", () => {
  const row = (path: string, workflow = "流A"): CanvasInstanceRow => ({
    name: "流A",
    path,
    workflow,
    cardDir: "/p/卡",
    startedAt: "2026-10-05 10:00",
    status: "运行中",
    params: {},
    nodes: [],
  });
  /** 同一 raw 形态的两条路径（内核 join 产出，Windows 现场为反斜杠）＋他项目同名实例。 */
  const rows = [
    row("D:\\proj\\.pao\\任务甲\\工作流实例-流A.md"),
    row("D:\\proj\\.pao\\任务乙\\工作流实例-流A.md"),
    row("D:\\other\\.pao\\工作流实例-流A.md"),
    row("D:\\proj\\.pao\\任务丙\\工作流实例-流B.md", "流B"),
  ];

  test("定位本次启动的新实例：before 集合里的旧实例、他项目同名实例、别的工作流都不入选", () => {
    const { locateNewInstances } =
      require("../../src/features/canvas/canvas-model") as typeof import("../../src/features/canvas/canvas-model");
    const before = new Set(["D:\\proj\\.pao\\任务甲\\工作流实例-流A.md"]);
    const found = locateNewInstances(rows, "流A", before, "D:\\proj");
    expect(found.map((instance) => instance.path)).toEqual([
      "D:\\proj\\.pao\\任务乙\\工作流实例-流A.md",
    ]);
  });

  test("停止后重启同一工作流：旧实例路径在 before 集合＝不入选，只有新实例被定位（旧实例不受影响）", () => {
    const { locateNewInstances } =
      require("../../src/features/canvas/canvas-model") as typeof import("../../src/features/canvas/canvas-model");
    const before = new Set(["D:\\proj\\.pao\\任务甲\\工作流实例-流A.md"]);
    const again = locateNewInstances(rows, "流A", before, "D:/proj/");
    expect(again.map((instance) => instance.path)).toEqual([
      "D:\\proj\\.pao\\任务乙\\工作流实例-流A.md",
    ]);
  });

  test("项目根按正斜杠＋尾斜杠传入同样命中（路径归一比较，不依赖分隔符形态）", () => {
    const { locateNewInstances } =
      require("../../src/features/canvas/canvas-model") as typeof import("../../src/features/canvas/canvas-model");
    const forwardRows = [
      row("D:/proj/.pao/任务甲/工作流实例-流A.md"),
      row("D:/proj/.pao/任务乙/工作流实例-流A.md"),
    ];
    const before = new Set(["D:/proj/.pao/任务甲/工作流实例-流A.md"]);
    const found = locateNewInstances(forwardRows, "流A", before, "D:/proj/");
    expect(found.map((instance) => instance.path)).toEqual([
      "D:/proj/.pao/任务乙/工作流实例-流A.md",
    ]);
  });
});

describe("S6-D1 实例失败可见（instanceFailedNodes＋渲染）", () => {
  /** 好流实例把「实现」改成失败卡现读；冻结配方沿用夹具。 */
  const failedSnapshot: CanvasSnapshot = {
    ...snapshot,
    instances: [
      {
        ...snapshot.instances[0]!,
        nodes: [
          { name: "实现", cardRef: "卡0001", status: "failed" },
          { name: "复核", status: "no_card", suspended: "等待人工确认" },
        ],
      },
      snapshot.instances[1]!,
    ],
  };

  test("失败节点名单只收卡面「失败」；读取异常是读取问题、不算失败", () => {
    const { instanceFailedNodes } =
      require("../../src/features/canvas/canvas-model") as typeof import("../../src/features/canvas/canvas-model");
    const instance = failedSnapshot.instances[0]!;
    expect(instanceFailedNodes(instance)).toEqual(["实现"]);
    expect(
      instanceFailedNodes({ ...instance, nodes: [{ name: "甲", status: "读取异常" }] }),
    ).toEqual([]);
    expect(
      instanceFailedNodes({ ...instance, nodes: [{ name: "甲", status: "delivered" }] }),
    ).toEqual([]);
  });

  test("失败实例运行图有明确横幅（含节点名），运行记录列表行有失败标记", () => {
    const html = renderToString(
      createElement(CanvasPageView, {
        result: failedSnapshot,
        loading: false,
        onRefresh: () => undefined,
        selection: { kind: "instance", name: "好流" },
      }),
    );
    expect(html).toContain('data-testid="canvas-instance-failure"');
    expect(html).toContain("实现");
    expect(html).toContain('data-failed="true"');
    expect(html).toContain("失败节点");
  });

  test("干净实例：无失败横幅、无失败标记（不静默也不误报）", () => {
    const html = renderToString(
      createElement(CanvasPageView, {
        result: snapshot,
        loading: false,
        onRefresh: () => undefined,
        selection: { kind: "instance", name: "好流" },
      }),
    );
    expect(html).not.toContain('data-testid="canvas-instance-failure"');
    expect(html).not.toContain("data-failed");
  });
});

describe("S6-D1 刷新不卸载画布（视口不跳）", () => {
  test("loading 中已可用的画布保持挂载：运行图不因刷新整块卸载重挂", () => {
    const html = renderToString(
      createElement(CanvasPageView, {
        result: snapshot,
        loading: true, // 手动刷新进行中（result 仍是上一次快照）
        onRefresh: () => undefined,
        selection: { kind: "instance", name: "好流" },
      }),
    );
    expect(html).toContain('data-mode="runtime"');
    expect(html).toContain('data-testid="canvas-dag"');
  });
});

describe("S6-D1 执行中节点与边动画（workflowEdges）", () => {
  const views = (overrides: { name: string; status?: string; suspended?: string }[]) =>
    overrides.map((row) => ({
      name: row.name,
      dept: "工程",
      dependsOn: row.name === "乙" || row.name === "丙" ? ["甲"] : [],
      requiresConfirmation: false,
      ...(row.status !== undefined ? { status: row.status } : {}),
      ...(row.suspended !== undefined ? { suspended: row.suspended } : {}),
    }));

  test("目标节点执行中（六态蓝）的依赖边 animated；未执行不动画；审核回边不参与", () => {
    const { workflowEdges } =
      require("../../src/features/canvas/workflow-editor") as typeof import("../../src/features/canvas/workflow-editor");
    const edges = workflowEdges(
      views([
        { name: "甲", status: "delivered" },
        { name: "乙", status: "in_progress" },
        { name: "丙", status: "no_card" },
      ]),
      [{ from: "丙", to: "甲" }],
    );
    const dep = (from: string, to: string) =>
      edges.find((edge) => edge.id === JSON.stringify(["dependency", from, to]));
    expect(dep("甲", "乙")?.animated).toBe(true); // 入边流动：乙在执行
    expect(dep("甲", "丙")?.animated).toBeFalsy(); // 丙未执行
    const review = edges.find((edge) => edge.id === JSON.stringify(["review", "丙", "甲"]));
    expect(review).toBeDefined();
    expect(review?.animated).toBeFalsy(); // 审核回边是流程控制，不冒充执行动画
  });

  test("挂起节点不算执行中（橙非蓝）：进行中＋挂起的入边不动画", () => {
    const { workflowEdges } =
      require("../../src/features/canvas/workflow-editor") as typeof import("../../src/features/canvas/workflow-editor");
    const edges = workflowEdges(
      views([
        { name: "甲", status: "delivered" },
        { name: "乙", status: "in_progress", suspended: "等待部长本轮拆解结束" },
      ]),
    );
    const edge = edges.find((item) => item.id === JSON.stringify(["dependency", "甲", "乙"]));
    expect(edge?.animated).toBeFalsy();
  });
});

describe("S6-D1 未记录耗时/Token 显示未知而非 0（D8d 渲染体特征钉）", () => {
  test("无完成时间、无回执用量：显示未记录/尚无，不出现 0 秒 / 0 个 Token", () => {
    const { NodeRuntimeDetails } =
      require("../../src/features/canvas/node-runtime-details") as typeof import("../../src/features/canvas/node-runtime-details");
    const detail = {
      node: "实现",
      instance: "好流",
      card: {
        cardRef: "卡0001",
        status: "in_progress",
        attempts: 1,
        created: "2026-10-05 10:00",
        path: "/p/卡/卡0001.md",
        receipts: [],
      },
      executions: [],
    } as unknown as import("../../contracts/canvas").CanvasNodeDetailData;
    const html = renderToString(createElement(NodeRuntimeDetails, { detail }));
    expect(html).toContain("未记录完成时间");
    expect(html).toContain("尚无回执用量记录");
    expect(html).not.toMatch(/0\s*秒/);
  });
});

describe("S6-D2 启动后补拉迟到失败守卫（波审 P2-1）", () => {
  const base = {
    applyCanvasResult: () => undefined,
    name: "某流",
    project: "/p",
    workspaceId: "ws",
    beforeStartPaths: { current: new Set<string>() },
    workflowTabs: [],
    changeTabs: async () => undefined,
  };
  /** 手动定决的 getCanvas：让测试控制失败到达前 requestId 是否已被更新请求取代。 */
  function deferredCanvas(): {
    getCanvas: () => Promise<CanvasResult>;
    reject: (error: unknown) => void;
  } {
    let reject!: (error: unknown) => void;
    return {
      getCanvas: () =>
        new Promise<CanvasResult>((_resolve, rej) => {
          reject = rej;
        }),
      reject: (error) => reject(error),
    };
  }

  test("被更新请求取代的迟到失败不覆写错误态；当前请求自身失败仍如实落错", async () => {
    const requestId = { current: 1 };
    const errors: string[] = [];
    const loading: boolean[] = [];
    const stale = deferredCanvas();
    const staleDone = pullCanvasAfterStart({
      ...base,
      currentRequest: requestId.current,
      requestId,
      getCanvas: stale.getCanvas,
      setLoadError: (message) => errors.push(message),
      setLoading: (value) => loading.push(value),
    });
    // 此后已有更新的请求（如用户又点了刷新）：这条失败是迟到的，必须作废。
    requestId.current = 2;
    stale.reject(new Error("过期的拉取失败"));
    await staleDone;
    expect(errors).toEqual([]);
    expect(loading).toEqual([]);

    // 对照：守卫不得误伤当前请求自身的失败。
    const live = deferredCanvas();
    const liveDone = pullCanvasAfterStart({
      ...base,
      currentRequest: 3,
      requestId: { current: 3 },
      getCanvas: live.getCanvas,
      setLoadError: (message) => errors.push(message),
      setLoading: (value) => loading.push(value),
    });
    live.reject(new Error("真实失败"));
    await liveDone;
    expect(errors).toEqual(["真实失败"]);
    expect(loading).toEqual([false]);
  });
});
