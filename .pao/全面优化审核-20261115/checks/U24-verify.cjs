const fs = require("node:fs");
const ts = require("../../../desktop/node_modules/typescript");
const directory = "desktop/apps/desktop/src/features/memory/";
function functionBody(text, name) {
  const source = ts.createSourceFile("sample.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let body;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) body = node.body.getText(source);
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer?.body) body = node.initializer.body.getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!body) throw Error(name + " 不存在");
  return body;
}
for (const [name, from, to] of [
  ["loadMore", "memory-page.tsx", "use-memory-list.ts"],
  ["submitCorrection", "memory-management.tsx", "use-memory-management.ts"],
  ["MemoryDeletionRecovery", "memory-management.tsx", "memory-deletion-recovery.tsx"],
]) {
  const before = fs.readFileSync(".pao/全面优化审核-20261115/checks/U23-" + from + ".txt", "utf8");
  const after = fs.readFileSync(directory + to, "utf8");
  if (functionBody(before, name) !== functionBody(after, name)) throw Error(name + " 函数体不同");
  console.log(name + "：函数体逐字相同");
}
const before = fs.readFileSync(".pao/全面优化审核-20261115/checks/U-memory-evolution-baseline.txt", "utf8");
const after = fs.readFileSync("desktop/apps/desktop/tests/core/memory-evolution.spec.ts", "utf8");
if (before !== after) throw Error("受保护测试正文不同");
console.log("memory-evolution.spec.ts：与起始正文直接比对相同");
for (const [path, limit] of [
  [directory + "memory-page.tsx", 450],
  [directory + "memory-management.tsx", 500],
  ["desktop/apps/desktop/src/styles/memory.css", 900],
]) {
  const lines = fs.readFileSync(path, "utf8").trimEnd().split("\n").length;
  if (lines > limit) throw Error(path + " 超出行数目标");
  console.log(path + "：" + lines + " 行，目标 ≤ " + limit);
}
require("./U24-css.cjs");
