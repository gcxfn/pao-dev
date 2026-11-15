const fs = require("node:fs");
const p = "D:/AI/workspace/pao-dev/桌面端/apps/desktop/src/features/canvas/recipe-canvas-editor.tsx";
let s = fs.readFileSync(p, "utf8");

const helperAnchor = [
  "/** 只有显式声明 审核: true 的节点才能挂审核回边（内核同源约束）。 */",
  "export function isReviewNode(node: WizardRecipeNode): boolean {",
  "  return (node as Record<string, unknown>).审核 === true;",
  "}",
].join("\n");
const helperNew = [
  "/** 只有显式声明 审核: true 的节点才能挂审核回边（内核同源约束）。 */",
  "export function isReviewNode(node: WizardRecipeNode): boolean {",
  "  return (node as Record<string, unknown>).审核 === true;",
  "}",
  "",
  "/**",
  " * 勾选/取消「审核节点」的节点补丁：取消时清空回边（内核只允许审核节点声明回边），",
  " * 但保留部门标准（内核要求审核节点须给出部门标准，取消审核不代为删除该字段）。",
  " */",
  "export function reviewTogglePatch(checked: boolean): Partial<WizardRecipeNode> {",
  "  return { 审核: checked, ...(checked ? {} : { 回边: [] }) };",
  "}",
].join("\n");
if (s.split(helperAnchor).length - 1 !== 1) { console.error("helper anchor not found"); process.exit(1); }
s = s.replace(helperAnchor, helperNew);

const useOld = [
  "                        onChange={(event) =>",
  "                          updateNode({",
  "                            审核: event.target.checked,",
  "                            ...(event.target.checked ? {} : { 回边: [] }),",
  "                          })",
  "                        }",
].join("\n");
const useNew = [
  "                        onChange={(event) => updateNode(reviewTogglePatch(event.target.checked))}",
].join("\n");
if (s.split(useOld).length - 1 !== 1) { console.error("use anchor not found"); process.exit(1); }
s = s.replace(useOld, useNew);

fs.writeFileSync(p, s, "utf8");
console.log("ok");
