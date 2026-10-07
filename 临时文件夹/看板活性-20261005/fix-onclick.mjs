import { readFileSync, writeFileSync } from "node:fs";
const src = "D:/AI/workspace/pao-dev/桌面端/apps/desktop/src/features/workboard/kanban-board.tsx";
let t = readFileSync(src, "utf8");
const old = 'onClick={copy}';
if (!t.includes(old)) throw new Error("onClick 锚点不匹配");
t = t.replace(old, 'onClick={() => void copy()}');
writeFileSync(src, t);
console.log("ok");