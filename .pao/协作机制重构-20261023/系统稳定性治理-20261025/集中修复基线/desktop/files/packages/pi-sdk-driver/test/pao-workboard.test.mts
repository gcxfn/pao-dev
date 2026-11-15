// 看板聚合透传夹具：真实 fork 构建产物（dist/pao），hermetic 临时目录，零落盘只读。
// collectPending 的限额覆盖（PaoPendingLimits）必须原样到达 fork；部门字段随卡面透出。
// S9 收口门面：卡文件键与失败分型值已按定名表新协议改写；内核包构建产物落位后重跑。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadPaoWorkboardAggregates } from "../dist/pao-workboard.js";

const base = resolve("D:/AI/workspace/临时文件夹/PAO-看板聚合测试-20261004");
mkdirSync(base, { recursive: true });

/** 手写一张失败卡（S9 新卡文件协议：frontmatter 英文键＋回执段英文键；分型值＝missing_input 等）。 */
function 失败卡(卡目录: string, 卡号: number, 目标: string, 分型: string): void {
  const 编号 = String(卡号).padStart(4, "0");
  writeFileSync(
    join(卡目录, `卡${编号}-${目标}.md`),
    [
      "---",
      `goal: ${目标}`,
      "dept: 测试",
      'acceptance: "完成"',
      "attempt: 1",
      'created: "2026-10-04 12:00"',
      "status: failed",
      "---",
      "",
      `## 回执 尝试1 2026-10-04 12:05`,
      "",
      "- result: failed",
      `- summary: ${分型}回执`,
      `- failure_type: ${分型}`,
      "",
    ].join("\n"),
    "utf8",
  );
}

function setup(t: test.TestContext): string {
  const home = mkdtempSync(join(base, "home-"));
  const 项目根 = mkdtempSync(join(base, "proj-"));
  const 卡目录 = join(项目根, ".pao", "卡");
  mkdirSync(卡目录, { recursive: true });
  writeFileSync(
    join(home, "项目清单.md"),
    [
      "| 项目名 | 项目根 | 首次服务 | 最近服务 |",
      "| --- | --- | --- | --- |",
      `| 项目甲 | ${项目根} | 2026-10-04 10:00 | 2026-10-04 10:00 |`,
      "",
    ].join("\n"),
    "utf8",
  );
  for (const [index, 目标] of ["缺甲", "缺乙", "缺丙", "缺丁", "缺戊"].entries()) {
    失败卡(卡目录, index + 1, 目标, "missing_input");
  }
  t.after(() => {
    assert.ok(home.startsWith(base) && 项目根.startsWith(base));
    rmSync(home, { recursive: true, force: true });
    rmSync(项目根, { recursive: true, force: true });
  });
  return home;
}

test("pending 默认口径：单类前 3 条＋尾行计数（fork 内部默认不变）", async (t) => {
  const home = setup(t);
  const aggregates = await loadPaoWorkboardAggregates();
  const items = await aggregates.pending(home);
  assert.equal(items.length, 4);
  assert.deepEqual(
    items.map((item) => item.类型),
    ["缺输入补卡", "缺输入补卡", "缺输入补卡", "缺输入补卡"],
  );
  assert.match(items[3]!.主体, /另有 2 张缺输入失败卡未列出/);
});

test("pending 透传限额：cardItemLimit 放行全量,itemLimit 截总,部门字段随卡面", async (t) => {
  const home = setup(t);
  const aggregates = await loadPaoWorkboardAggregates();
  const full = await aggregates.pending(home, { cardItemLimit: 10 });
  assert.equal(full.length, 5);
  assert.ok(full.every((item) => item.部门 === "测试"));
  assert.ok(full.every((item) => item.证据.length === 1));
  const 截总 = await aggregates.pending(home, { itemLimit: 2 });
  assert.equal(截总.length, 2);
});

test("pending 不传限额与旧签名同形：证据/四行字段齐全", async (t) => {
  const home = setup(t);
  const aggregates = await loadPaoWorkboardAggregates();
  const items = await aggregates.pending(home);
  for (const item of items) {
    assert.equal(typeof item.为什么停, "string");
    assert.equal(typeof item.要决定什么, "string");
    assert.equal(typeof item.建议, "string");
    assert.ok(Array.isArray(item.证据));
  }
});
