import { readFileSync, writeFileSync } from "node:fs";
const src = "D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/desktop/index.ts";
let t = readFileSync(src, "utf8");
const old = 'import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";';
if (!t.includes(old)) throw new Error("导入不匹配");
t = t.replace(old, 'import type { ExtensionContext } from "../../core/extensions/types.ts";');
writeFileSync(src, t);
console.log("ok");