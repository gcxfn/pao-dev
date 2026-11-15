/**
 * 配方库（工作流重构阶段 2）单元测试：renderToString 直渲染，无浏览器依赖。
 * 覆盖 全部／我的／模板／最近 四页签的内容来源、模板身份门、最近标签的排序与存在性过滤。
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeAll, describe, expect, test } from "@playwright/test";
import type { CanvasSnapshot } from "../../contracts/canvas";
import type { WorkflowTabRecord } from "../../contracts/desktop-state";
import type { WorkflowCatalogSnapshot } from "../../contracts/workflow-wizard";

/**
 * Playwright 的 babel transform 会把所有 .tsx 的 JSX 编到它自带的 playwright/jsx-runtime，
 * renderToString 无法消化；先把该模块在 require 缓存里换成真 react/jsx-runtime 再加载组件。
 */
let RecipeLibrary: (typeof import("../../src/features/canvas/recipe-library"))["RecipeLibrary"];
let RecipeRowContextMenu: (typeof import("../../src/features/canvas/recipe-library"))["RecipeRowContextMenu"];
beforeAll(() => {
  const real = require("react/jsx-runtime");
  require.cache[require.resolve("playwright/jsx-runtime")] = {
    id: "react/jsx-runtime",
    filename: require.resolve("playwright/jsx-runtime"),
    loaded: true,
    exports: real,
  } as never;
  ({ RecipeLibrary, RecipeRowContextMenu } = require("../../src/features/canvas/recipe-library") as {
    RecipeLibrary: typeof RecipeLibrary;
    RecipeRowContextMenu: typeof RecipeRowContextMenu;
  });
});

const snapshot: CanvasSnapshot = {
  state: "available",
  recipes: [
    {
      name: "安装流程",
      available: true,
      recipe: {
        version: 2,
        autoExecute: false,
        params: [],
        placeholders: [],
        topoOrder: ["实现"],
        nodes: [{ name: "实现", dept: "工程", dependsOn: [], requiresConfirmation: false }],
      },
    },
    { name: "坏配方", available: false, error: { code: "RECIPE_CYCLE", detail: "检测到环" } },
  ],
  instances: [
    {
      name: "安装流程-1",
      path: "D:/inst/1",
      workflow: "安装流程",
      cardDir: "cards",
      startedAt: "2026-10-05",
      status: "运行中",
      params: {},
      nodes: [],
    },
  ],
  anomalies: [{ path: "D:/inst/bad", reason: "版本不识别" }],
};

const catalog: WorkflowCatalogSnapshot = {
  state: "available",
  recipes: [],
  departments: [],
  skills: [],
  tiers: [],
  thinkingLevels: [],
  templates: [{ id: "starter", name: "起步模板", description: "三卡起步" }],
  errors: [],
};

function tab(patch: Partial<WorkflowTabRecord> & { id: string }): WorkflowTabRecord {
  return { workspaceId: "ws-a", title: patch.id, mode: "edit", ...patch };
}

const projectTabs: WorkflowTabRecord[] = [
  tab({ id: "t1", title: "安装流程", mode: "edit", recipeName: "安装流程" }),
  tab({ id: "t2", title: "运行实例", mode: "runtime", instanceName: "安装流程-1" }),
  tab({ id: "t3", title: "已删配方", mode: "edit", recipeName: "不存在的配方" }),
];
const activeTab = projectTabs[1];

function render(props: Partial<Parameters<typeof RecipeLibrary>[0]> = {}): string {
  return renderToString(
    createElement(RecipeLibrary, {
      snapshot,
      catalog,
      projectTabs,
      activeTab,
      onSelect: () => undefined,
      onInstallTemplate: () => undefined,
      ...props,
    }),
  );
}

describe("配方库", () => {
  test("全部页签：配方＋实例＋异常行，保留旧 data-testid 与搜索框", () => {
    const html = render();
    expect(html).toContain('data-testid="canvas-list"');
    expect(html).toContain("canvas-search");
    expect(html).toContain('data-testid="recipe-library-filter-all"');
    expect(html).toContain('data-testid="recipe-library-filter-mine"');
    expect(html).toContain('data-testid="recipe-library-filter-templates"');
    expect(html).toContain('data-testid="recipe-library-filter-recent"');
    expect(html).toContain('data-testid="canvas-recipe-row"');
    expect(html).toContain('data-testid="canvas-recipe-error"');
    expect(html).toContain("RECIPE_CYCLE");
    expect(html).toContain('data-testid="canvas-instance-row"');
    expect(html).toContain('data-testid="canvas-anomaly-row"');
  });

  test("我的页签：只列配方，不含实例", () => {
    const html = render({ initialFilter: "mine" });
    expect(html).toContain('data-testid="canvas-recipe-row"');
    expect(html).toContain('data-testid="canvas-recipe-error"');
    expect(html).not.toContain('data-testid="canvas-instance-row"');
  });

  test("模板页签：列出目录真实模板，可安装", () => {
    const html = render({ initialFilter: "templates" });
    expect(html).toContain('data-testid="recipe-library-template-row"');
    expect(html).toContain("起步模板");
    expect(html).toContain("三卡起步");
    expect(html).not.toContain('data-testid="canvas-instance-row"');
    expect(html).not.toContain('data-testid="recipe-library-template-hint"');
  });

  test("模板页签：身份未建立时提示并禁用安装", () => {
    const html = render({ initialFilter: "templates", canInstallTemplate: false });
    expect(html).toContain('data-testid="recipe-library-template-hint"');
    expect(html).toContain("主控会话");
    expect(html).toMatch(/data-testid="recipe-library-template-row"[^>]*disabled/);
  });

  test("模板页签：目录缺失时提示不可用", () => {
    const html = render({ initialFilter: "templates", catalog: undefined });
    expect(html).toContain("模板目录不可用");
    expect(html).not.toContain('data-testid="recipe-library-template-row"');
  });

  test("最近页签：只列当前项目仍存在的已打开标签，当前标签优先", () => {
    const html = render({ initialFilter: "recent" });
    expect(html).toContain('data-testid="recipe-library-recent-note"');
    expect(html).toContain("已打开的标签");
    // t2（实例）是当前激活标签，应排在 t1（配方）之前
    expect(html.indexOf('data-testid="canvas-instance-row"')).toBeGreaterThan(-1);
    expect(html.indexOf('data-testid="canvas-instance-row"')).toBeLessThan(
      html.indexOf('data-testid="canvas-recipe-row"'),
    );
    expect(html).toContain("当前标签");
    // t3 的配方已不存在，整条不列
    expect(html).not.toContain("已删配方");
    expect(html).not.toContain("不存在的配方");
  });

  test("运行记录在途 badge（波3 §2c）：运行中点名、非运行中不点名", () => {
    const running = render();
    expect(running).toContain('data-testid="canvas-instance-running-badge"');
    expect(running).toContain("工作流运行中");

    const finished: CanvasSnapshot = {
      ...snapshot,
      instances: [{ ...snapshot.instances[0]!, name: "安装流程-2", status: "已完成" }],
    };
    const html = render({ snapshot: finished });
    expect(html).toContain('data-testid="canvas-instance-row"');
    expect(html).not.toContain('data-testid="canvas-instance-running-badge"');
  });
});

describe("配方库行右键菜单（S3-3 删除链接线）", () => {
  test("「删除工作流」菜单项可用并携带删除回调", () => {
    const html = renderToString(
      createElement(RecipeRowContextMenu, {
        name: "安装流程",
        onRemove: () => undefined,
        onClose: () => undefined,
      }),
    );
    expect(html).toContain('data-testid="recipe-row-context-menu"');
    expect(html).toContain("删除工作流");
    // 菜单项启用（S3-2 占位禁用已由 S3-3 接线替换；点击行为由 core e2e 覆盖）。
    const button = html.match(/<button[^>]*>/)?.[0] ?? "";
    expect(button).not.toContain("disabled");
  });

  test("「在新标签中打开」菜单项随回调提供（S4-1⑤），未提供时不显示", () => {
    const withEntry = renderToString(
      createElement(RecipeRowContextMenu, {
        name: "安装流程",
        onRemove: () => undefined,
        onClose: () => undefined,
        onOpenInNewTab: () => undefined,
      }),
    );
    expect(withEntry).toContain("在新标签中打开");
    const withoutEntry = renderToString(
      createElement(RecipeRowContextMenu, {
        name: "安装流程",
        onRemove: () => undefined,
        onClose: () => undefined,
      }),
    );
    expect(withoutEntry).not.toContain("在新标签中打开");
  });
});
