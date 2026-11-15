const fs = require("node:fs");
const p = "D:/AI/workspace/pao-dev/桌面端/apps/desktop/tests/unit/recipe-canvas-editor-review-node.spec.ts";
let s = fs.readFileSync(p, "utf8");

const oldDecl = [
  "let RecipeCanvasEditor: (typeof import(\"../../src/features/canvas/recipe-canvas-editor\"))[\"RecipeCanvasEditor\"];",
].join("\n");
const newDecl = [
  "let RecipeCanvasEditor: (typeof import(\"../../src/features/canvas/recipe-canvas-editor\"))[\"RecipeCanvasEditor\"];",
  "let reviewTogglePatch: (typeof import(\"../../src/features/canvas/recipe-canvas-editor\"))[\"reviewTogglePatch\"];",
].join("\n");
if (s.split(oldDecl).length - 1 !== 1) { console.error("decl anchor not found"); process.exit(1); }
s = s.replace(oldDecl, newDecl);

const oldReq = [
  "  ({ RecipeCanvasEditor } = require(\"../../src/features/canvas/recipe-canvas-editor\") as {",
  "    RecipeCanvasEditor: typeof RecipeCanvasEditor;",
  "  });",
].join("\n");
const newReq = [
  "  ({ RecipeCanvasEditor, reviewTogglePatch } = require(",
  "    \"../../src/features/canvas/recipe-canvas-editor\",",
  "  ) as {",
  "    RecipeCanvasEditor: typeof RecipeCanvasEditor;",
  "    reviewTogglePatch: typeof reviewTogglePatch;",
  "  });",
].join("\n");
if (s.split(oldReq).length - 1 !== 1) { console.error("req anchor not found"); process.exit(1); }
s = s.replace(oldReq, newReq);

const anchor = [
  "  test(\"非审核节点不显示部门标准 textarea\", () => {",
  "    const html = render([node(\"开发\")], \"开发\");",
  "    expect(html).not.toContain('aria-label=\"部门标准\"');",
  "  });",
  "});",
].join("\n");
const added = [
  "  test(\"非审核节点不显示部门标准 textarea\", () => {",
  "    const html = render([node(\"开发\")], \"开发\");",
  "    expect(html).not.toContain('aria-label=\"部门标准\"');",
  "  });",
  "",
  "  test(\"取消审核清空回边、保留部门标准；勾选审核只置审核\", () => {",
  "    expect(reviewTogglePatch(true)).toEqual({ 审核: true });",
  "    expect(reviewTogglePatch(false)).toEqual({ 审核: false, 回边: [] });",
  "    expect(reviewTogglePatch(false)).not.toHaveProperty(\"部门标准\");",
  "  });",
  "});",
].join("\n");
if (s.split(anchor).length - 1 !== 1) { console.error("test anchor not found"); process.exit(1); }
s = s.replace(anchor, added);

fs.writeFileSync(p, s, "utf8");
console.log("ok");
