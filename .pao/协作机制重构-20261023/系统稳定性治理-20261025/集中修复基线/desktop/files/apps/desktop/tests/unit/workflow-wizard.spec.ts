/**
 * 启流向导（P4-3）单元测试：纯函数（必填参数/代入预览/节点覆盖物化与脏检查/红项过滤）
 * ＋主进程桥（hermetic 假模块：目录整形/坏行显错误/预检整形/变更面错误透出）
 * ＋组件渲染（renderToString：模板三卡无会话禁用/参数必填禁用/红项禁启按钮）。
 * 桥的加载器注入假模块，不触真实 PAO_HOME 内容（stat 占位目录仅证明可达）。
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeAll, describe, expect, test } from "@playwright/test";
import type { PaoDesktopWorkflowModule, PaoRecipeCatalog } from "@pi-gui/pi-sdk-driver";
import type { WizardRecipe } from "../../contracts/workflow-wizard";
import { expectWorkflowPreflightInput, expectWorkflowTierSaveInput } from "../../electron/ipc/request-validation";
import {
  createWorkflowWizardBridge,
  normalizeCatalog,
  normalizePreview,
} from "../../electron/platform/pao/workflow-wizard-bridge";
import {
  formForNode,
  materializeRecipe,
  recipeDirty,
  redItems,
  requiredParams,
  substitutePreview,
} from "../../src/features/canvas/workflow-wizard-model";

let WizardSelectStep: (typeof import("../../src/features/canvas/workflow-wizard"))["WizardSelectStep"];
let WizardParamsStep: (typeof import("../../src/features/canvas/workflow-wizard"))["WizardParamsStep"];
let WizardPreflightStep: (typeof import("../../src/features/canvas/workflow-wizard"))["WizardPreflightStep"];
let TierManagerPanel: (typeof import("../../src/features/canvas/workflow-wizard"))["TierManagerPanel"];
beforeAll(() => {
  const real = require("react/jsx-runtime");
  require.cache[require.resolve("playwright/jsx-runtime")] = {
    id: "react/jsx-runtime",
    filename: require.resolve("react/jsx-runtime"),
    loaded: true,
    exports: real,
  } as never;
  ({ WizardSelectStep, WizardParamsStep, WizardPreflightStep, TierManagerPanel } =
    require("../../src/features/canvas/workflow-wizard") as {
      WizardSelectStep: typeof WizardSelectStep;
      WizardParamsStep: typeof WizardParamsStep;
      WizardPreflightStep: typeof WizardPreflightStep;
      TierManagerPanel: typeof TierManagerPanel;
    });
});

const recipe: WizardRecipe = {
  名字: "小修",
  版本: 1,
  参数: ["项目", "目标", ""],
  节点: [
    {
      名字: "实现",
      部门: "工程@{项目}",
      目标: "{目标}",
      档位: "主力",
      预算: { turns: 10, cost: 1 },
    },
    { 名字: "复核", 部门: "评审", 技能: ["review"], 人工确认: true },
  ],
};

describe("wizard model", () => {
  test("requiredParams 只收非空参数名", () => {
    expect(requiredParams(recipe)).toEqual(["项目", "目标"]);
  });

  test("substitutePreview 已填代入、未填与未知键保持原样", () => {
    expect(substitutePreview("工程@{项目}", { 项目: "仓A" })).toBe("工程@仓A");
    expect(substitutePreview("{目标} {未声明}", { 项目: "仓A" })).toBe("{目标} {未声明}");
  });

  test("materializeRecipe 覆盖模型/思考/预算，清空删键且档位回落、其余字段透传", () => {
    const next = materializeRecipe(recipe, {
      实现: { model: "专家", thinkingLevel: "", budgetTurns: "", budgetCost: "2.5" },
    });
    const node = next.节点[0] as Record<string, unknown>;
    expect(node["模型"]).toBe("专家");
    expect(node["档位"]).toBe("主力");
    expect(node["思考强度"]).toBeUndefined();
    expect(node["预算"]).toEqual({ cost: 2.5 });
    expect(node["目标"]).toBe("{目标}");
    expect(recipe.节点[0]["模型"]).toBeUndefined();
    const untouched = next.节点[1] as Record<string, unknown>;
    expect(untouched["人工确认"]).toBe(true);
    expect(untouched["技能"]).toEqual(["review"]);
  });

  test("recipeDirty 只看可编辑面：无覆盖不脏，改预算/清模型都脏", () => {
    expect(recipeDirty(recipe, {})).toBe(false);
    expect(recipeDirty(recipe, { 实现: { budgetTurns: "20" } })).toBe(true);
    // 基配方无 模型 键时选空＝保持配方值（不脏）；有 模型 键时清空才落差异。
    expect(recipeDirty(recipe, { 实现: { model: "" } })).toBe(false);
    const withModel = {
      ...recipe,
      节点: [{ ...(recipe.节点[0] as Record<string, unknown>), 模型: "专家" }, recipe.节点[1]],
    } as WizardRecipe;
    expect(recipeDirty(withModel, { 实现: { model: "" } })).toBe(true);
    expect(recipeDirty(recipe, { 复核: {} })).toBe(false);
  });

  test("redItems 只留阻止启动级；formForNode 表单初值字符串化", () => {
    const items = [
      { level: "阻止启动", subject: "部门", reason: "缺", suggestion: "建" },
      { level: "警告", subject: "预算", reason: "未设", suggestion: "确认" },
    ];
    expect(redItems(items)).toHaveLength(1);
    expect(formForNode(recipe.节点[0])).toEqual({
      model: "",
      thinkingLevel: "",
      budgetTurns: "10",
      budgetToolCalls: "",
      budgetCost: "1",
    });
  });
});

const fakeCatalog: PaoRecipeCatalog = {
  recipes: [
    { recipe: recipe as never, revision: "r1", content: "…" },
    { recipe: { 名字: "", 参数: [] } as never, revision: "r0", content: "坏行" },
  ],
  departments: ["工程", "评审"],
  skills: ["review"],
  tiers: [{ 名: "主力", provider: "zai", model: "glm", thinkingLevel: "high" }],
  thinkingLevels: ["low", "medium", "high"],
  templates: [
    { id: "bugfix", name: "小bug修复", description: "复现修复验证。" },
    { id: "review", name: "独立代码审查", description: "只读审查。" },
    { id: "", name: "坏模板", description: "应被剔除" },
  ],
  errors: [],
};

function fakeModule(overrides: Partial<PaoDesktopWorkflowModule> = {}): PaoDesktopWorkflowModule {
  return {
    readDesktopRecipeCatalog: () => fakeCatalog,
    previewDesktopWorkflow: () => ({
      report: {
        project: "/proj",
        checkedAt: "2026-10-05T00:00:00Z",
        canStart: false,
        items: [
          { level: "阻止启动", subject: "部门", reason: "缺工程@项目X", suggestion: "先建部门" },
          { level: "警告", subject: "预算", reason: "未设", suggestion: "确认" },
        ],
      },
      节点数: 2,
      节点: [
        {
          名字: "实现",
          部门: "工程@项目X",
          工人上限: 1,
          模型: "主力",
          思考强度: "档位默认",
          技能: [],
        },
      ],
      预算: { cost: null, turns: 10, 说明: "合计" },
      将落卡数: "待拆解",
    }),
    installDesktopTemplate: async () => {},
    saveDesktopRecipe: async () => {},
    startDesktopWorkflow: async () => {},
    deleteDesktopRecipe: async () => {},
    ...overrides,
  } as PaoDesktopWorkflowModule;
}

async function realDir(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return mkdtemp(join(tmpdir(), "pi-gui-wizard-home-"));
}

describe("wizard bridge", () => {
  test("缺 PAO_HOME＝unavailable pao-home-missing，不加载模块", async () => {
    let loaded = false;
    const bridge = createWorkflowWizardBridge({
      paoHome: "",
      loadModule: async () => {
        loaded = true;
        return fakeModule();
      },
    });
    const result = await bridge.collectCatalog();
    expect(result).toEqual({
      state: "unavailable",
      code: "pao-home-missing",
      message: expect.stringContaining("PAO home"),
    });
    expect(loaded).toBe(false);
  });

  test("normalizeCatalog：坏配方行显错误、空 id 模板剔除、档位/强度透传", () => {
    const snapshot = normalizeCatalog(fakeCatalog);
    expect(snapshot.recipes.map((entry) => entry.name)).toEqual(["小修"]);
    expect(snapshot.errors.some((row) => row.includes("名字或节点缺失"))).toBe(true);
    expect(snapshot.templates.map((entry) => entry.id)).toEqual(["bugfix", "review"]);
    expect(snapshot.tiers[0]).toEqual({
      name: "主力",
      provider: "zai",
      model: "glm",
      thinkingLevel: "high",
    });
    expect(snapshot.thinkingLevels).toEqual(["low", "medium", "high"]);
  });

  test("normalizeCatalog：非对象配方行与坏节点行剔除进 errors，不裸断言进目录快照", () => {
    const snapshot = normalizeCatalog({
      ...fakeCatalog,
      recipes: [
        { recipe: null as never, revision: "r9", content: "" },
        {
          recipe: {
            名字: "坏节点",
            参数: [],
            节点: [{ 名字: "甲", 部门: "工程" }, "坏行"],
          } as never,
          revision: "r8",
          content: "",
        },
      ],
    });
    expect(snapshot.recipes).toHaveLength(0);
    expect(snapshot.errors.some((row) => row.includes("非对象的工作流行"))).toBe(true);
    expect(snapshot.errors.some((row) => row.includes("坏节点: 节点行形状损坏"))).toBe(true);
  });

  test("normalizeCatalog：只有坏文件时仍 available 且 errors 原样透出，不伪装空目录或不可用", () => {
    const snapshot = normalizeCatalog({
      ...fakeCatalog,
      recipes: [],
      errors: ["D:/h/工作流/坏.md: RECIPE_CYCLE"],
    });
    expect(snapshot.state).toBe("available");
    expect(snapshot.recipes).toHaveLength(0);
    expect(snapshot.errors).toEqual(["D:/h/工作流/坏.md: RECIPE_CYCLE"]);
  });

  test("normalizeCatalog：ui.positions 原样透传（保存→重读坐标一致走同一整形出口）", () => {
    const withUi = {
      名字: "带坐标",
      参数: [],
      节点: [{ 名字: "开发", 部门: "工程" }],
      ui: { positions: { 开发: { x: 820, y: 440 } } },
    };
    const snapshot = normalizeCatalog({
      ...fakeCatalog,
      recipes: [{ recipe: withUi as never, revision: "r2", content: "" }],
    });
    expect(snapshot.recipes[0].recipe.ui).toEqual({ positions: { 开发: { x: 820, y: 440 } } });
  });

  test("runPreflight：同源报告整形（红项/canStart false/预算 null 保留）", async () => {
    const home = await realDir();
    const bridge = createWorkflowWizardBridge({
      paoHome: home,
      loadModule: async () => fakeModule(),
    });
    const result = await bridge.runPreflight({
      project: "/proj",
      recipe,
      parameters: { 项目: "项目X" },
    });
    expect(result.state).toBe("ok");
    if (result.state !== "ok") return;
    expect(result.report.canStart).toBe(false);
    expect(redItems(result.report.items)).toHaveLength(1);
    expect(result.report.nodes[0].dept).toBe("工程@项目X");
    expect(result.report.budget).toEqual({ cost: null, turns: 10, toolCalls: null, note: "合计" });
  });

  test("runPreflight：配方缺节点＝failed 可展示错误，不抛顶层", async () => {
    const home = await realDir();
    const bridge = createWorkflowWizardBridge({
      paoHome: home,
      loadModule: async () => fakeModule(),
    });
    const result = await bridge.runPreflight({
      project: "/proj",
      recipe: { 名字: "无节点", 参数: [] } as unknown as WizardRecipe,
      parameters: {},
    });
    expect(result.state).toBe("failed");
  });

  test("守卫等价性探针：同批坏形状 IPC 层与桥层双拒（对象性守卫双在位）", async () => {
    // 两层共有的节点行/配方对象性守卫：同批坏形状必须双拒，防单侧漂移无报警。
    // 有意分层（S2 选项一）：IPC 骨架另验名字/参数，桥层不验（IPC 强桥弱），深度契约单源＝内核。
    const badShapes = [
      "非对象配方",
      { 名字: "坏行", 参数: [], 节点: [{ 名字: "甲", 部门: "工程" }, 42] },
      { 名字: "空行", 参数: [], 节点: [null] },
      { 名字: "数组行", 参数: [], 节点: [["甲"]] },
    ];
    const bridge = createWorkflowWizardBridge({ loadModule: async () => fakeModule() });
    for (const bad of badShapes) {
      // IPC 层：骨架守卫快速失败（抛 TypeError）。
      expect(() =>
        expectWorkflowPreflightInput({ project: "/p", recipe: bad as never, parameters: {} }),
      ).toThrow();
      // 桥层：同一对象性守卫按桥语义返回可展示错误，不抛顶层。
      expect(
        await bridge.saveRecipe({
          sessionId: "s",
          project: "/p",
          recipe: bad as never,
          revision: "r1",
        }),
      ).toEqual({ state: "error", message: expect.stringContaining("保存工作流") });
    }
  });

  test("startWorkflow：fork owner 校验失败原样透出中文错误；成功 ok", async () => {
    const home = await realDir();
    const failing = fakeModule({
      startDesktopWorkflow: async () => {
        throw new Error("原会话 owner 不可用或已切换；请回到对应会话重新查看，不能重放旧动作。");
      },
    });
    const bridge = createWorkflowWizardBridge({
      paoHome: home,
      loadModule: async () => failing,
    });
    const failure = await bridge.startWorkflow({
      sessionId: "s1",
      project: "/proj",
      recipe,
      revision: "r1",
      parameters: {},
      masterTier: "主力",
      thinking: "high",
    });
    expect(failure).toEqual({
      state: "error",
      message: "原会话 owner 不可用或已切换；请回到对应会话重新查看，不能重放旧动作。",
    });
    const ok = await createWorkflowWizardBridge({
      paoHome: home,
      loadModule: async () => fakeModule(),
    }).startWorkflow({
      sessionId: "s1",
      project: "/proj",
      recipe,
      revision: "r1",
      parameters: {},
      masterTier: "主力",
      thinking: "high",
    });
    expect(ok).toEqual({ state: "ok" });
  });

  test("installTemplate/saveRecipe：缺会话身份或指纹＝结构化错误", async () => {
    const home = await realDir();
    const bridge = createWorkflowWizardBridge({
      paoHome: home,
      loadModule: async () => fakeModule(),
    });
    expect(
      await bridge.installTemplate({ sessionId: "", project: "/p", templateId: "bugfix" }),
    ).toEqual({
      state: "error",
      message: expect.stringContaining("安装模板"),
    });
    expect(
      await bridge.saveRecipe({ sessionId: "s", project: "/p", recipe, revision: "" }),
    ).toEqual({
      state: "error",
      message: expect.stringContaining("保存工作流"),
    });
  });

  test("新配方 null 版本透传，不伪造旧配方指纹", async () => {
    const home = await realDir();
    let revisionSeen: string | null | undefined;
    const bridge = createWorkflowWizardBridge({
      paoHome: home,
      loadModule: async () =>
        fakeModule({
          saveDesktopRecipe: async (_session, _project, _recipe, revision) => {
            revisionSeen = revision;
          },
        }),
    });
    expect(
      await bridge.saveRecipe({ sessionId: "s", project: "/p", recipe, revision: null }),
    ).toEqual({ state: "ok" });
    expect(revisionSeen).toBeNull();
  });

  test("deleteRecipe：缺会话/名字＝结构化错误；revision 原样透传（null 不伪造指纹）", async () => {
    const home = await realDir();
    const seen: { name?: string; revision?: string | null } = {};
    const bridge = createWorkflowWizardBridge({
      paoHome: home,
      loadModule: async () =>
        fakeModule({
          deleteDesktopRecipe: async (_session, _project, name, revision) => {
            seen.name = name;
            seen.revision = revision;
          },
        }),
    });
    expect(
      await bridge.deleteRecipe({ sessionId: "", project: "/p", name: "旧流", revision: null }),
    ).toEqual({ state: "error", message: expect.stringContaining("删除") });
    expect(
      await bridge.deleteRecipe({ sessionId: "s", project: "/p", name: "  ", revision: "r1" }),
    ).toEqual({ state: "error", message: expect.stringContaining("删除") });
    expect(seen.name).toBeUndefined();
    expect(
      await bridge.deleteRecipe({ sessionId: "s", project: "/p", name: "旧流", revision: null }),
    ).toEqual({ state: "ok" });
    expect(seen).toEqual({ name: "旧流", revision: null });
  });

  test("deleteRecipe：fork 守卫错误原样透出；成功 ok", async () => {
    const home = await realDir();
    const failing = fakeModule({
      deleteDesktopRecipe: async () => {
        throw new Error("该配方有运行中的冻结实例；先暂停，再删除。");
      },
    });
    const bridge = createWorkflowWizardBridge({
      paoHome: home,
      loadModule: async () => failing,
    });
    expect(
      await bridge.deleteRecipe({ sessionId: "s", project: "/p", name: "旧流", revision: "r1" }),
    ).toEqual({
      state: "error",
      message: "该配方有运行中的冻结实例；先暂停，再删除。",
    });
    expect(
      await createWorkflowWizardBridge({
        paoHome: home,
        loadModule: async () => fakeModule(),
      }).deleteRecipe({ sessionId: "s", project: "/p", name: "旧流", revision: "r1" }),
    ).toEqual({ state: "ok" });
  });

  test("normalizePreview：level 空值回落未验证、evidence 空不透出", () => {
    const report = normalizePreview({
      report: {
        project: "/p",
        checkedAt: "",
        canStart: true,
        items: [{ level: "", subject: "", reason: "", suggestion: "", evidence: "  " }],
      },
      节点数: 0,
      节点: [],
      预算: { cost: undefined as never, turns: "x" as never, 说明: "" },
      将落卡数: "",
    });
    expect(report.items[0].level).toBe("未验证");
    expect(report.items[0].evidence).toBeUndefined();
    expect(report.budget).toEqual({ cost: null, turns: null, toolCalls: null, note: "" });
  });
});

describe("wizard tier admin bridge（S9-2 档位管理）", () => {
  test("saveTier：缺 PAO_HOME＝错误透出，不加载档位管理模块", async () => {
    let loaded = false;
    const bridge = createWorkflowWizardBridge({
      paoHome: "",
      loadTierAdmin: async () => {
        loaded = true;
        return fakeTierAdmin();
      },
    });
    const result = await bridge.saveTier({ tier: { name: "新", provider: "a", model: "b", thinkingLevel: "low" } });
    expect(result.state).toBe("error");
    expect(loaded).toBe(false);
  });

  test("saveTier：必填缺失＝结构化错误，不进 driver", async () => {
    const home = await realDir();
    let called = false;
    const bridge = createWorkflowWizardBridge({
      paoHome: home,
      loadTierAdmin: async () =>
        fakeTierAdmin(() => {
          called = true;
        }),
    });
    const result = await bridge.saveTier({
      tier: { name: "  ", provider: "a", model: "b", thinkingLevel: "low" },
    });
    expect(result).toEqual({ state: "error", message: expect.stringContaining("保存档位") });
    expect(called).toBe(false);
  });

  test("saveTier：字段 trim 后以中文键透传 driver，editing 原样到达；成功 ok", async () => {
    const home = await realDir();
    const calls: { home: string; tier: Record<string, string>; editing?: string }[] = [];
    const bridge = createWorkflowWizardBridge({
      paoHome: home,
      loadTierAdmin: async () =>
        fakeTierAdmin((h, tier, editing) => calls.push({ home: h, tier, editing })),
    });
    const ok = await bridge.saveTier({
      tier: { name: " 专家 ", provider: " zai ", model: " glm-max ", thinkingLevel: "high" },
      editing: "快",
    });
    expect(ok).toEqual({ state: "ok" });
    expect(calls).toHaveLength(1);
    expect(calls[0].home).toBe(home);
    expect(calls[0].tier).toEqual({ 名: "专家", provider: "zai", model: "glm-max", thinkingLevel: "high" });
    expect(calls[0].editing).toBe("快");
    const fresh = await bridge.saveTier({
      tier: { name: "全新", provider: "a", model: "b", thinkingLevel: "low" },
    });
    expect(fresh).toEqual({ state: "ok" });
    expect(calls[1].editing).toBeUndefined();
  });

  test("saveTier：driver 重名/坏 JSON 错误原样透出（不吞不改）", async () => {
    const home = await realDir();
    const bridge = createWorkflowWizardBridge({
      paoHome: home,
      loadTierAdmin: async () =>
        fakeTierAdmin(() => {
          throw new Error("档位「专家」已存在，要改请直接选它编辑");
        }),
    });
    const result = await bridge.saveTier({
      tier: { name: "专家", provider: "a", model: "b", thinkingLevel: "low" },
    });
    expect(result).toEqual({
      state: "error",
      message: "档位「专家」已存在，要改请直接选它编辑",
    });
  });

  test("expectWorkflowTierSaveInput：非对象与缺字段拒绝；editing 可选非空", () => {
    expect(() => expectWorkflowTierSaveInput(null)).toThrow();
    expect(() => expectWorkflowTierSaveInput({ tier: { name: "", provider: "a", model: "b", thinkingLevel: "low" } })).toThrow();
    expect(() =>
      expectWorkflowTierSaveInput({
        tier: { name: "新", provider: "a", model: "b", thinkingLevel: "" },
      }),
    ).toThrow();
    const valid = expectWorkflowTierSaveInput({
      tier: { name: "新", provider: "a", model: "b", thinkingLevel: "low" },
      editing: "快",
    });
    expect(valid.editing).toBe("快");
    expect(() =>
      expectWorkflowTierSaveInput({
        tier: { name: "新", provider: "a", model: "b", thinkingLevel: "low" },
        editing: "",
      }),
    ).toThrow();
  });
});

/** driver 档位管理模块的 hermetic 假件（记录调用，可注入抛错）。 */
function fakeTierAdmin(onUpsert?: (home: string, tier: Record<string, string>, editing?: string) => void) {
  return {
    upsert: (home: string, tier: Record<string, string>, editing?: string) => {
      onUpsert?.(home, tier, editing);
    },
  };
}

describe("wizard components", () => {
  const catalogSnapshot = normalizeCatalog(fakeCatalog);

  test("选择步：模板三卡渲染，无会话身份时安装禁用并提示", () => {
    const html = renderToString(
      createElement(WizardSelectStep, {
        catalog: catalogSnapshot,
        busy: false,
        hasIdentity: false,
        onSelect: () => {},
        onInstallTemplate: () => {},
      }),
    );
    expect(html).toContain("小bug修复");
    expect(html).toContain("独立代码审查");
    expect(html).toContain("wizard-template-no-session");
    expect(html).toContain("disabled");
  });

  test("参数步：必填未填时下一步禁用；预览含节点部门代入", () => {
    const html = renderToString(
      createElement(WizardParamsStep, {
        recipe,
        parameters: { 项目: "仓A" },
        onParameterChange: () => {},
        complete: false,
        onBack: () => {},
        onNext: () => {},
      }),
    );
    expect(html).toContain('data-param="项目"');
    expect(html).toContain("工程@仓A");
    expect(html).toContain("(required)");
    expect(html).toContain("disabled");
  });

  test("预检步：红项时禁启并显示阻断横幅；无红项时启动可点", () => {
    const common = {
      busy: false,
      dirty: false,
      tiers: catalogSnapshot.tiers,
      thinkingLevels: catalogSnapshot.thinkingLevels,
      masterTier: "主力",
      thinking: "high",
      hasIdentity: true,
      onMasterTierChange: () => {},
      onThinkingChange: () => {},
      onRerun: () => {},
      onBack: () => {},
      onStart: () => {},
      onSaveTier: () => Promise.resolve({ state: "ok" as const }),
    };
    const blocked = renderToString(
      createElement(WizardPreflightStep, {
        ...common,
        preflight: {
          state: "ok",
          report: {
            canStart: false,
            items: [{ level: "阻止启动", subject: "部门", reason: "缺", suggestion: "建" }],
            nodes: [],
            budget: { cost: null, turns: null, toolCalls: null, note: "" },
            checkedAt: "",
          },
        },
      }),
    );
    expect(blocked).toContain("wizard-blocked");
    expect(blocked).toContain("wizard-check--red");
    const startDisabled = /data-testid="wizard-start"[^>]*disabled/.test(blocked);
    expect(startDisabled).toBe(true);

    const passable = renderToString(
      createElement(WizardPreflightStep, {
        ...common,
        preflight: {
          state: "ok",
          report: {
            canStart: true,
            items: [],
            nodes: [],
            budget: { cost: 1, turns: 2, toolCalls: null, note: "" },
            checkedAt: "",
          },
        },
      }),
    );
    expect(passable).toContain("wizard-can-start");
    expect(/data-testid="wizard-start"[^>]*disabled/.test(passable)).toBe(false);
  });

  test("预检步：无会话身份或未选档位时启动禁用", () => {
    const html = renderToString(
      createElement(WizardPreflightStep, {
        busy: false,
        dirty: false,
        tiers: catalogSnapshot.tiers,
        thinkingLevels: catalogSnapshot.thinkingLevels,
        masterTier: "",
        thinking: "",
        hasIdentity: false,
        preflight: {
          state: "ok",
          report: {
            canStart: true,
            items: [],
            nodes: [],
            budget: { cost: null, turns: null, toolCalls: null, note: "" },
            checkedAt: "",
          },
        },
        onMasterTierChange: () => {},
        onThinkingChange: () => {},
        onRerun: () => {},
        onBack: () => {},
        onStart: () => {},
        onSaveTier: () => Promise.resolve({ state: "ok" }),
      }),
    );
    expect(/data-testid="wizard-start"[^>]*disabled/.test(html)).toBe(true);
    expect(html).toContain("wizard-no-session");
  });

  test("档位管理面板：渲染编辑对象下拉（新建＋现有档）、档名/物理模型/思考档字段与写回提示", () => {
    const html = renderToString(
      createElement(TierManagerPanel, {
        tiers: catalogSnapshot.tiers,
        thinkingLevels: catalogSnapshot.thinkingLevels,
        disabled: false,
        onSave: () => Promise.resolve({ state: "ok" }),
      }),
    );
    expect(html).toContain('data-testid="wizard-tier-picker"');
    expect(html).toContain('data-testid="wizard-tier-name"');
    expect(html).toContain('data-testid="wizard-tier-model"');
    expect(html).toContain('data-testid="wizard-tier-thinking"');
    expect(html).toContain('data-testid="wizard-tier-save"');
    // 测试环境界面语言为英文（t 回落键名），中文词条不在此断言
    expect(html).toContain("New tier");
    expect(html).toContain("主力");
    expect(html).toContain("档位.json");
    // 思考档下拉选项来自目录 thinkingLevels
    expect(html).toContain("medium");
  });
});
