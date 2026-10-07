import fs from "node:fs";
const path = "D:/AI/workspace/pao-dev/桌面端/apps/desktop/src/features/canvas/recipe-canvas-editor.tsx";
let text = fs.readFileSync(path, "utf8");
const old = [
"    const rawLimit = record.上限 ?? 3;",
"    const 上限 =",
"      typeof rawLimit === \"number\" && Number.isSafeInteger(rawLimit) && rawLimit >= 0",
"        ? rawLimit",
"        : 3;",
"    const 超限动作: ReviewAction = record.超限动作 === \"修完这轮放行\" ? \"修完这轮放行\" : \"停滞\";",
"    edges.push({ 目标, 上限, 超限动作 });",
].join("\n");
const neu = [
"    // 缺省字段按内核口径补默认值；显式给出但非法的值按坏条目跳过，不静默改写。",
"    const rawLimit = record.上限;",
"    if (",
"      rawLimit !== undefined &&",
"      !(typeof rawLimit === \"number\" && Number.isSafeInteger(rawLimit) && rawLimit >= 0)",
"    )",
"      continue;",
"    const 上限 = rawLimit === undefined ? 3 : rawLimit;",
"    const rawAction = record.超限动作;",
"    if (rawAction !== undefined && rawAction !== \"停滞\" && rawAction !== \"修完这轮放行\") continue;",
"    const 超限动作: ReviewAction = rawAction === \"修完这轮放行\" ? \"修完这轮放行\" : \"停滞\";",
"    edges.push({ 目标, 上限, 超限动作 });",
].join("\n");
const count = text.split(old).length - 1;
if (count !== 1) throw new Error("expected 1 match, found " + count);
text = text.replace(old, neu);
fs.writeFileSync(path, text, "utf8");
console.log("readReviewEdges updated");
