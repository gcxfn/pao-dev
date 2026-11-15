import { readFileSync, writeFileSync } from "node:fs";
const spec = "D:/AI/workspace/pao-dev/桌面端/apps/desktop/tests/unit/kanban-command.spec.ts";
let s = readFileSync(spec, "utf8");
const bad = '    "卡目录":"D:/项目/.pao/卡",\n';
if (!s.includes(bad)) throw new Error("锚点不匹配");
s = s.replace(bad, "    '\"卡目录\":\"D:/项目/.pao/卡\",',\n");
writeFileSync(spec, s);
console.log("ok");