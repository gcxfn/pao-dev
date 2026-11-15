// 画布数据桥透传夹具：真实 fork 构建产物（dist/pao/desktop/canvas.js），hermetic 临时目录，
// 零落盘只读。覆盖：加载器取到 readDesktopCanvas、好/坏配方段隔离（成环显错误）、
// 实例节点卡状态现读（清单不作数）、坏清单进异常行不拖好实例、卡缺失如实报读取异常。
// S9 收口门面：本文件经 loadPaoDesktopCanvas 深引内核 dist/pao/desktop/canvas.js，
// 卡 frontmatter 键与状态值已按 S9 定名表新协议改写；内核包构建产物落位后重跑。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadPaoDesktopCanvas } from "../src/pao-canvas.ts";

const base = resolve("D:/AI/workspace/临时文件夹/PAO-画布桥测试-20261005");
mkdirSync(base, { recursive: true });

/** 手写一张卡（S9 新卡文件协议：frontmatter 英文键；状态值＝英文五值）。 */
function 手写卡(卡目录: string, 卡号: number, 目标: string, 状态: string): void {
  const 编号 = String(卡号).padStart(4, "0");
  writeFileSync(
    join(卡目录, `卡${编号}-${目标}.md`),
    [
      "---",
      `goal: ${目标}`,
      "dept: 测试",
      'acceptance: "完成"',
      "attempt: 1",
      'created: "2026-10-05 10:00"',
      `status: ${状态}`,
      "---",
      "",
    ].join("\n"),
    "utf8",
  );
}

function setup(t: test.TestContext): string {
  const home = mkdtempSync(join(base, "home-"));
  const 项目根 = mkdtempSync(join(base, "proj-"));
  const 卡目录 = join(项目根, ".pao", "任务甲", "卡");
  mkdirSync(卡目录, { recursive: true });
  // 好流配方（实现→复核，复核人工确认）
  mkdirSync(join(home, "工作流"), { recursive: true });
  writeFileSync(
    join(home, "工作流", "好流.md"),
    [
      "---",
      "版本: 2",
      "名字: 好流",
      "参数: [目标项目]",
      "节点:",
      "  - 名字: 实现",
      "    目标: 在 {目标项目} 落地功能",
      "    部门: 工程",
      "    验收: 测试通过",
      "    depends_on: []",
      "  - 名字: 复核",
      "    目标: 复核实现结果",
      "    部门: 评审",
      "    验收: 意见归档",
      "    depends_on: [实现]",
      "    人工确认: true",
      "    模型: 主力",
      "    思考强度: high",
      "---",
      "画布桥测试用配方。",
      "",
    ].join("\n"),
    "utf8",
  );
  // 坏流配方（实现↔复核成环，加载必须拒绝）
  writeFileSync(
    join(home, "工作流", "坏流.md"),
    [
      "---",
      "版本: 2",
      "名字: 坏流",
      "节点:",
      "  - 名字: 甲",
      "    目标: 甲任务",
      "    部门: 工程",
      "    验收: 验收甲",
      "    depends_on: [乙]",
      "  - 名字: 乙",
      "    目标: 乙任务",
      "    部门: 工程",
      "    验收: 验收乙",
      "    depends_on: [甲]",
      "---",
      "成环配方，加载必须拒绝。",
      "",
    ].join("\n"),
    "utf8",
  );
  // 项目清单登记项目
  writeFileSync(
    join(home, "项目清单.md"),
    [
      "| 项目名 | 项目根 | 首次服务 | 最近服务 |",
      "| --- | --- | --- | --- |",
      `| 项目甲 | ${项目根} | 2026-10-05 10:00 | 2026-10-05 10:00 |`,
      "",
    ].join("\n"),
    "utf8",
  );
  // 卡面：实现＝in_progress，复核无卡＝no_card（S10 投影单域英文；清单里只挂挂起原因）
  手写卡(卡目录, 1, "实现画布桥", "in_progress");
  // 实例清单（与 driver serializeManifest 同形状）
  writeFileSync(
    join(项目根, ".pao", "任务甲", "工作流实例-好流.md"),
    [
      "---",
      "工作流: 好流",
      `卡目录: ${JSON.stringify(卡目录)}`,
      '启动: "2026-10-05 10:00"',
      "状态: 运行中",
      "参数:",
      "  目标项目: 项目X",
      "节点:",
      "  - 名字: 实现",
      "    卡号: 卡0001",
      "  - 名字: 复核",
      "    挂起: 等待人工确认",
      "---",
      "<!-- 驱动器维护：测试 fixture -->",
      "",
    ].join("\n"),
    "utf8",
  );
  // 坏清单：状态字段非法，parseManifest 显式拒绝
  writeFileSync(
    join(项目根, ".pao", "工作流实例-坏档.md"),
    "---\n工作流: 坏档\n状态: 莫名其妙\n---\n<!-- 坏字段清单，保留原件人工核对 -->\n",
    "utf8",
  );
  t.after(() => {
    assert.ok(home.startsWith(base) && 项目根.startsWith(base));
    rmSync(home, { recursive: true, force: true });
    rmSync(项目根, { recursive: true, force: true });
  });
  return home;
}

test("加载器取到 fork 构建产物的 readDesktopCanvas", async () => {
  const readDesktopCanvas = await loadPaoDesktopCanvas();
  assert.equal(typeof readDesktopCanvas, "function");
});

test("好/坏配方段隔离：坏配方显 RECIPE_CYCLE 错误不拖好配方", async (t) => {
  const home = setup(t);
  const readDesktopCanvas = await loadPaoDesktopCanvas();
  const view = readDesktopCanvas(home);
  assert.equal(view.配方.length, 2);
  const good = view.配方.find((entry) => entry.名字 === "好流");
  assert.ok(good && good.可用);
  assert.deepEqual(good.配方.拓扑序, ["实现", "复核"]);
  assert.equal(good.配方.节点.length, 2);
  assert.equal(good.配方.节点[1].模型, "主力");
  const bad = view.配方.find((entry) => entry.名字 === "坏流");
  assert.ok(bad && !bad.可用);
  assert.equal(bad.错误.代码, "RECIPE_CYCLE");
  assert.equal(view.错误, undefined);
});

test("实例节点卡状态现读＋坏清单进异常行不拖好实例", async (t) => {
  const home = setup(t);
  const readDesktopCanvas = await loadPaoDesktopCanvas();
  const view = readDesktopCanvas(home);
  assert.equal(view.实例.length, 1);
  const instance = view.实例[0];
  assert.equal(instance.状态, "运行中");
  assert.deepEqual(instance.参数, { 目标项目: "项目X" });
  assert.deepEqual(
    instance.节点.map((node) => [node.名字, node.状态]),
    [
      ["实现", "in_progress"],
      ["复核", "no_card"],
    ],
  );
  assert.equal(instance.节点[1].挂起, "等待人工确认");
  // 坏清单（状态非法）进异常行，不拖好实例
  assert.equal(view.异常.length, 1);
  assert.ok(view.异常[0].路径.includes("工作流实例-坏档.md"));
});

test("卡缺失如实报读取异常；清单卡号不作数", async (t) => {
  const home = setup(t);
  const 项目根 = join(base, "proj-missing-card");
  mkdirSync(join(项目根, ".pao", "卡"), { recursive: true });
  writeFileSync(
    join(home, "项目清单.md"),
    [
      "| 项目名 | 项目根 | 首次服务 | 最近服务 |",
      "| --- | --- | --- | --- |",
      `| 项目乙 | ${项目根} | 2026-10-05 10:00 | 2026-10-05 10:00 |`,
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(项目根, ".pao", "工作流实例-幽灵.md"),
    [
      "---",
      "工作流: 好流",
      `卡目录: ${JSON.stringify(join(项目根, ".pao", "卡"))}`,
      '启动: "2026-10-05 10:00"',
      "状态: 运行中",
      "节点:",
      "  - 名字: 实现",
      "    卡号: 卡0042",
      "---",
      "",
    ].join("\n"),
    "utf8",
  );
  const readDesktopCanvas = await loadPaoDesktopCanvas();
  const view = readDesktopCanvas(home);
  const instance = view.实例.find((row) => row.名字 === "幽灵");
  assert.ok(instance);
  assert.equal(instance.节点[0].状态, "读取异常");
});
