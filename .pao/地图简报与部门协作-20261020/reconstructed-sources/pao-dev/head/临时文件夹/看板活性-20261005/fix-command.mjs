import { readFileSync, writeFileSync } from "node:fs";
const cmd = "D:/AI/workspace/pao-dev/桌面端/apps/desktop/src/features/workboard/kanban-command.ts";
const spec = "D:/AI/workspace/pao-dev/桌面端/apps/desktop/tests/unit/kanban-command.spec.ts";
let t = readFileSync(cmd, "utf8");
const must = (text, needle) => {
  if (!text.includes(needle)) throw new Error("锚点不匹配: " + needle.slice(0, 40));
};

const oldComment = "/** 终态卡不再提供取消：状态机已收敛，只能复核历史。 */";
must(t, oldComment);
t = t.replace(
  oldComment,
  "/** 终态只有 已交付/取消（失败可重试，属合法取消来源）；终态不再提供取消。 */",
);
const oldFn = `export function canPrepareCancel(card: KanbanCard): boolean {
  return card.status !== "已交付" && card.status !== "失败" && card.status !== "取消";
}`;
must(t, oldFn);
t = t.replace(
  oldFn,
  `export function canPrepareCancel(card: KanbanCard): boolean {
  return card.status !== "已交付" && card.status !== "取消";
}`,
);
const oldDir = `function cardDirectory(path: string): string {
  const match = /^(.*)[\\\\/][^\\\\/]*$/.exec(path);
  return match ? match[1] : path;
}`;
must(t, oldDir);
t = t.replace(
  oldDir,
  `function cardDirectory(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\\\"));
  return index > 0 ? path.slice(0, index) : path;
}`,
);
writeFileSync(cmd, t);

let s = readFileSync(spec, "utf8");
const oldAssert = `  expect(canPrepareCancel(card("已交付"))).toBe(false);
  expect(canPrepareCancel(card("失败"))).toBe(false);
  expect(canPrepareCancel(card("取消"))).toBe(false);`;
if (!s.includes(oldAssert)) throw new Error("测试断言不匹配");
s = s.replace(
  oldAssert,
  `  expect(canPrepareCancel(card("已交付"))).toBe(false);
  expect(canPrepareCancel(card("失败"))).toBe(true);
  expect(canPrepareCancel(card("取消"))).toBe(false);`,
);
s = s.replace(
  '    "进行中 / 2",',
  '    "进行中 / 2",\n    "卡目录":"D:/项目/.pao/卡",',
);
writeFileSync(spec, s);
console.log("ok: 已修 cardDirectory 与失败可取消");