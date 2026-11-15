// 用途：按 check-baseline-failures.mjs 的归一化键口径，差分本次全量与旧基线，输出消失名单。
// 输入：.pao/整体重构-20261005/日志/T00-PAO基线失败对照.log（JSON 报告）、.pao/并行实施-20261002/产物/基线测试-coding-agent.log（原始输出）
// 输出：新增/消失键清单（stdout）
import { readFileSync } from "node:fs";
import { parseVitestFailures } from "file:///D:/AI/workspace/pao-dev/PAO/scripts/check-baseline-failures.mjs";

const cur = parseVitestFailures(readFileSync("D:/AI/workspace/pao-dev/.pao/整体重构-20261005/日志/T00-PAO基线失败对照.log", "utf8"));
const base = parseVitestFailures(readFileSync("D:/AI/workspace/pao-dev/.pao/并行实施-20261002/产物/基线测试-coding-agent.log", "utf8"));
const curSet = new Set(cur.keys), baseSet = new Set(base.keys);
const added = cur.keys.filter(k => !baseSet.has(k));
const gone = base.keys.filter(k => !curSet.has(k));
console.log(`基线键数=${base.keys.length} 本次键数=${cur.keys.length} 新增=${added.length} 消失=${gone.length}`);
console.log("\n== 消失名单（基线有、本次无） ==");
for (const k of gone) console.log("- " + k);
console.log("\n== 新增名单（本次有、基线无） ==");
for (const k of added) console.log("- " + k);
console.log("\n== package-command-paths 相关键（基线/本次） ==");
for (const k of base.keys.filter(k => k.includes("package-command"))) console.log("基线: " + k);
for (const k of cur.keys.filter(k => k.includes("package-command"))) console.log("本次: " + k);
