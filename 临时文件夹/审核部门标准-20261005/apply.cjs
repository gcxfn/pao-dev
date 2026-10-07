const fs = require("node:fs");
const p = "D:/AI/workspace/pao-dev/桌面端/apps/desktop/src/features/canvas/recipe-canvas-editor.tsx";
let s = fs.readFileSync(p, "utf8");
const oldText = [
  "                      审核节点",
  "                    </label>",
  "                    <p className=\"canvas-detail__note\">",
  "                      审核节点可对依赖链上游提出打回。取消审核会清除该节点的审核回边。",
  "                    </p>",
].join("\n");
const newText = [
  "                      审核节点",
  "                    </label>",
  "                    {isReviewNode(selectedNode) ? (",
  "                      <label>",
  "                        部门标准",
  "                        <textarea",
  "                          aria-label=\"部门标准\"",
  "                          value={",
  "                            typeof selectedNode.部门标准 === \"string\" ? selectedNode.部门标准 : \"\"",
  "                          }",
  "                          placeholder=\"审核节点的审查标准（必填）\"",
  "                          onChange={(event) =>",
  "                            updateNode({ 部门标准: event.target.value || undefined })",
  "                          }",
  "                        />",
  "                      </label>",
  "                    ) : null}",
  "                    <p className=\"canvas-detail__note\">",
  "                      审核节点须填写部门标准，可对依赖链上游提出打回。取消审核会清除该节点的审核回边，但保留部门标准。",
  "                    </p>",
].join("\n");
if (s.split(oldText).length - 1 !== 1) { console.error("old text not found uniquely"); process.exit(1); }
s = s.replace(oldText, newText);
fs.writeFileSync(p, s, "utf8");
console.log("ok");
