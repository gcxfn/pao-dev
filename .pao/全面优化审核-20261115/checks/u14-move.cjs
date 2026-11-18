const fs = require("node:fs");
const path = require("node:path");
const ts = require(path.resolve("desktop/node_modules/typescript"));
const root = "desktop/apps/desktop/src/features/";
const groups = {
  model: ["canvas/canvas-page.tsx", "canvas/canvas-page-model.ts", ["dagNodesFor", "canvasNodeCardRefs", "discussNodeInstruction", "stopNodeCardsInstruction", "initialDetailSections", "CanvasSessionTarget", "canvasWorkerAnchor", "canvasSessionInput", "canvasMinisterStatus", "CanvasInjectionTarget", "CanvasInjectionPlan", "canvasInjectionPlan", "canvasInjectionCommand", "resolveEditorEntry", "pullCanvasAfterStart", "CanvasSelection"]],
  actions: ["canvas/canvas-page.tsx", "canvas/canvas-node-actions.tsx", ["CanvasNodeActions"]],
  dag: ["canvas/canvas-page.tsx", "canvas/canvas-dag-panel.tsx", ["CanvasDagPanel"]],
  detail: ["canvas/canvas-page.tsx", "canvas/canvas-detail-panel.tsx", ["CanvasDetailPanel", "CanvasNodeDetailBody"]],
  view: ["canvas/canvas-page.tsx", "canvas/canvas-page-view.tsx", ["CanvasPageViewProps", "CanvasPageView"]],
  steps: ["workflow-cards/workflow-cards-view.tsx", "workflow-cards/step-card-list.tsx", ["StepCardListProps", "StepCardList", "StepCardProps", "StepCard"]],
  outputs: ["workflow-cards/workflow-cards-view.tsx", "workflow-cards/step-output-list.tsx", ["OutputGroupProps", "OutputGroup", "OutputListProps", "OutputList"]],
  stepDetail: ["workflow-cards/workflow-cards-view.tsx", "workflow-cards/step-detail.tsx", ["StepDetailProps", "StepDetail", "FilePreviewProps", "FilePreview"]],
  workspace: ["workflow-cards/workflow-cards-view.tsx", "workflow-cards/plan-workspace.tsx", ["PlanWorkspaceProps", "PlanWorkspace"]],
};
const [source, destination, names] = groups[process.argv[2]];
const sourcePath = root + source;
const destPath = root + destination;
const text = fs.readFileSync(sourcePath, "utf8");
const parse = (file, value) => ts.createSourceFile(file, value, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const ast = parse(sourcePath, text);
const moved = ast.statements.filter((node) => names.includes(node.name?.text));
if (moved.length !== names.length) throw new Error("搬移声明数量不符：" + names.filter((name) => !moved.some((node) => node.name?.text === name)));
const imports = ast.statements.filter(ts.isImportDeclaration).map((node) => node.getText(ast)).join("\n");
const exported = (node) => {
  const raw = text.slice(node.getFullStart(), node.end);
  const start = node.getStart(ast) - node.getFullStart();
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ? raw
    : raw.slice(0, start) + "export " + raw.slice(start);
};
let next = text;
for (const node of [...moved].reverse()) next = next.slice(0, node.getFullStart()) + next.slice(node.end);
const moduleName = "./" + path.basename(destination).replace(/\.tsx?$/, "");
next += `\nexport * from "${moduleName}";\n`;
const declared = (node) => node.name?.text;
const localNames = ast.statements.filter((node) => !moved.includes(node) && declared(node)).map(declared);
let dest = imports + "\n" + moved.map(exported).join("\n") + "\n";
const identifiers = (file, value) => {
  const result = new Set();
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isIdentifier(node)) result.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(parse(file, value));
  return result;
};
const destUsed = identifiers(destPath, dest);
const sourceUsed = identifiers(sourcePath, next);
const backImports = localNames.filter((name) => destUsed.has(name));
if (backImports.length) {
  for (const name of backImports) {
    const node = ast.statements.find((node) => declared(node) === name);
    if (!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      const old = node.getText(ast);
      next = next.replace(old, "export " + old);
    }
  }
  dest = `import { ${backImports.join(", ")} } from "./${path.basename(source).replace(/\.tsx?$/, "")}";\n` + dest;
}
const required = names.filter((name) => sourceUsed.has(name));
if (required.length) next = `import { ${required.join(", ")} } from "${moduleName}";\n` + next;
fs.writeFileSync(sourcePath, next);
fs.writeFileSync(destPath, dest);
// 仅整理 import；声明文本保持原样。
const configPath = path.resolve("desktop/apps/desktop/tsconfig.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile).config;
const parsed = ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(configPath));
const host = {
  ...ts.sys,
  getCompilationSettings: () => parsed.options,
  getScriptFileNames: () => parsed.fileNames,
  getScriptVersion: () => "1",
  getScriptSnapshot: (file) => {
    const value = ts.sys.readFile(file);
    return value === undefined ? undefined : ts.ScriptSnapshot.fromString(value);
  },
  getCurrentDirectory: () => process.cwd(),
  getDefaultLibFileName: ts.getDefaultLibFilePath,
};
const service = ts.createLanguageService(host);
const changes = [sourcePath, destPath].flatMap((file) => service.organizeImports({ type: "file", fileName: path.resolve(file) }, {}, {}));
for (const change of changes) {
  let value = fs.readFileSync(change.fileName, "utf8");
  for (const edit of [...change.textChanges].sort((a,b) => b.span.start - a.span.start)) value = value.slice(0, edit.span.start) + edit.newText + value.slice(edit.span.start + edit.span.length);
  fs.writeFileSync(change.fileName, value);
}
console.log(destination + ": " + names.join(", "));
