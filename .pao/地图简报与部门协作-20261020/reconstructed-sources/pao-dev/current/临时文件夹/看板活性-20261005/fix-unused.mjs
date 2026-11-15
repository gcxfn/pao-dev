import { readFileSync, writeFileSync } from "node:fs";
const src = "D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/desktop/read-model.ts";
let text = readFileSync(src, "utf8");
const old = 'import { readDesktopWorkerActivity, type DesktopWorkerActivityRow } from "./owners.ts";';
if (!text.includes(old)) throw new Error("导入行不匹配");
text = text.replace(old, 'import { readDesktopWorkerActivity } from "./owners.ts";');
writeFileSync(src, text);
console.log("ok");