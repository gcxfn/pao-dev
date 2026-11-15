import { readFileSync, writeFileSync } from "node:fs";
const src = "D:/AI/workspace/pao-dev/桌面端/apps/desktop/tests/unit/kanban-query.spec.ts";
let t = readFileSync(src, "utf8");
const must = (needle, label) => {
  if (!t.includes(needle)) throw new Error("锚点不匹配: " + label);
};

const three = `  const [first, second, third] = result.cards;
  expect(first.activity).toEqual({`;
must(three, "三卡解构");
t = t.replace(
  three,
  `  const first = result.cards[0];
  const second = result.cards[1];
  const third = result.cards[2];
  if (!first || !second || !third) throw new Error("期望读到三张卡，实际不足三张");
  expect(first.activity).toEqual({`,
);

const bad = `  expect(result.cards).toHaveLength(1);
  expect(result.cards[0].activity).toBeUndefined();
  expect(result.issues[0].message).toContain("活性字段无效");`;
must(bad, "坏活性行断言");
t = t.replace(
  bad,
  `  expect(result.cards).toHaveLength(1);
  expect(result.issues).toHaveLength(1);
  const kept = result.cards[0];
  const raised = result.issues[0];
  if (!kept || !raised) throw new Error("期望坏活性行只丢信号：卡仍在、问题已落");
  expect(kept.activity).toBeUndefined();
  expect(raised.message).toContain("活性字段无效");`,
);
writeFileSync(src, t);
console.log("ok: 类型缩窄已改，断言未削弱");