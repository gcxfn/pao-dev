/**
 * 审核节点「部门标准」输入（renderToString 直渲染）：
 * 勾审核后必须能填部门标准，否则保存时内核 parseRecipe 报「审核节点须给出部门标准」。
 * 覆盖：审核节点显示 textarea 并回填现有值、未填时不造默认、非审核节点不显示。
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeAll, describe, expect, test } from "@playwright/test";
import type { WizardRecipeNode } from "../../contracts/workflow-wizard";
import type { WorkflowCatalogSnapshot } from "../../contracts/workflow-wizard";
import type { PiDesktopApi } from "../../contracts/ipc";

/**
 * Playwright 的 babel transform 会把 .tsx 编到它自带的 playwright/jsx-runtime，
 * renderToString 无法消化；先把该模块换成真 react/jsx-runtime 再加载组件。
 */
let RecipeCanvasEditor: (typeof import("../../src/features/canvas/recipe-canvas-editor"))["RecipeCanvasEditor"];
let reviewTogglePatch: (typeof import("../../src/features/canvas/recipe-canvas-editor"))["reviewTogglePatch"];
beforeAll(() => {
  const real = require("react/jsx-runtime");
  require.cache[require.resolve("playwright/jsx-runtime")] = {
    id: "react/jsx-runtime",
    filename: require.resolve("react/jsx-runtime"),
    loaded: true,
    exports: real,
  } as never;
  ({ RecipeCanvasEditor, reviewTogglePatch } = require(
    "../../src/features/canvas/recipe-canvas-editor",
  ) as {
    RecipeCanvasEditor: typeof RecipeCanvasEditor;
    reviewTogglePatch: typeof reviewTogglePatch;
  });
});

const catalog: WorkflowCatalogSnapshot = {
  state: "available",
  recipes: [],
  departments: ["工程"],
  skills: [],
  tiers: [],
  thinkingLevels: [],
  templates: [],
  errors: [],
};

function node(name: string, patch: Partial<WizardRecipeNode> = {}): WizardRecipeNode {
  return { 名字: name, 部门: "工程", depends_on: [], 目标: "目标", 验收: "验收", ...patch };
}

function render(entryNodes: readonly WizardRecipeNode[], selected: string): string {
  return renderToString(
    createElement(RecipeCanvasEditor, {
      api: {} as PiDesktopApi,
      entry: {
        name: "配方",
        revision: null,
        recipe: { 名字: "配方", 参数: [], 节点: entryNodes, 版本: 2 },
      },
      onSaved: () => undefined,
      onDirtyChange: () => undefined,
      catalog,
      initialSelectedElementId: selected,
    }),
  );
}

function standardTextareaValue(html: string): string | undefined {
  const match = html.match(/<textarea[^>]*aria-label="部门标准"[^>]*>([^<]*)<\/textarea>/);
  return match ? match[1] : undefined;
}

describe("审核节点部门标准输入", () => {
  test("审核节点显示部门标准 textarea，并回填现有值", () => {
    const html = render([node("审查", { 审核: true, 部门标准: "对照验收清单" })], "审查");
    expect(html).toContain('aria-label="部门标准"');
    expect(standardTextareaValue(html)).toBe("对照验收清单");
    expect(html).toContain("审核节点须填写部门标准");
  });

  test("审核节点未填部门标准时输入为空，不造默认标准", () => {
    const html = render([node("审查", { 审核: true })], "审查");
    expect(html).toContain('aria-label="部门标准"');
    expect(standardTextareaValue(html)).toBe("");
  });

  test("非审核节点不显示部门标准 textarea", () => {
    const html = render([node("开发")], "开发");
    expect(html).not.toContain('aria-label="部门标准"');
  });

  test("取消审核清空回边、保留部门标准；勾选审核只置审核", () => {
    expect(reviewTogglePatch(true)).toEqual({ 审核: true });
    expect(reviewTogglePatch(false)).toEqual({ 审核: false, 回边: [] });
    expect(reviewTogglePatch(false)).not.toHaveProperty("部门标准");
  });
});
