// 临时计划桥透传夹具：真实 fork 构建产物（dist/pao/desktop/index.js）＋ hermetic 临时目录，零落盘只读。
// 覆盖：加载器取到 readDesktopPlans；读到步骤摘要（步骤 ID 稳定、人工门/依赖如实）；
// 没有计划目录＝空结果而不是读失败；坏定义点名进问题，不当「还没有计划」。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPaoDesktopPlans } from "../dist/pao-plans.js";

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 手写一份计划定义（内核 plan.ts 的落盘格式：frontmatter 中文键，步骤带稳定步骤 ID）。 */
function writePlan(项目根: string, 计划ID: string, extra: string[] = []): void {
  const 计划目录 = join(项目根, ".pao", "临时工作流", 计划ID);
  mkdirSync(计划目录, { recursive: true });
  writeFileSync(
    join(计划目录, "计划.md"),
    [
      "---",
      `计划ID: ${计划ID}`,
      "显示名: 小说创作",
      "定义版本: 1",
      `项目根: ${项目根}`,
      "来源会话: sess-1",
      '创建时刻: "2026-10-14 10:00"',
      '更新时刻: "2026-10-14 10:00"',
      "步骤:",
      "  - 步骤ID: s1",
      "    标题: 讨论计划",
      "    部门: 策划部",
      "    要求: 把方向与章节计划讨论清楚",
      "    人工门: true",
      "  - 步骤ID: s2",
      "    标题: 写初稿",
      "    部门: 写作部",
      "    要求: 按计划写初稿",
      "    依赖:",
      "      - s1",
      "请求记录: {}",
      ...extra,
      "---",
      "",
      "主控创建的临时工作流定义。",
      "",
    ].join("\n"),
    "utf8",
  );
}

test("没有临时计划目录时是空结果，不是读失败", async () => {
  const 项目根 = tempDir("pao-plan-bridge-empty-");
  const bridge = await loadPaoDesktopPlans();
  assert.deepEqual(bridge.readDesktopPlans(项目根), { 计划: [], 问题: [] });
});

test("读到计划定义与步骤摘要：步骤 ID 稳定、人工门与依赖如实、未启动不带关联", async () => {
  const 项目根 = tempDir("pao-plan-bridge-read-");
  writePlan(项目根, "p-20261014-abc123");
  const bridge = await loadPaoDesktopPlans();
  const result = bridge.readDesktopPlans(项目根);
  assert.deepEqual(result.问题, []);
  assert.equal(result.计划.length, 1);
  const plan = result.计划[0]!;
  assert.equal(plan.计划ID, "p-20261014-abc123");
  assert.equal(plan.显示名, "小说创作");
  assert.equal(plan.定义版本, 1);
  assert.equal(plan.已撤销, false);
  assert.equal(plan.来源会话, "sess-1");
  assert.deepEqual(
    plan.步骤.map((step) => step.步骤ID),
    ["s1", "s2"],
  );
  assert.equal(plan.步骤[0]!.人工门, true);
  assert.deepEqual(plan.步骤[1]!.依赖, ["s1"]);
  assert.deepEqual(plan.启动, []);
  assert.deepEqual(plan.意见, []);
});

test("坏定义点名进问题，计划列表不冒充完整", async () => {
  const 项目根 = tempDir("pao-plan-bridge-bad-");
  writePlan(项目根, "p-20261014-good01");
  const 坏目录 = join(项目根, ".pao", "临时工作流", "p-20261014-bad001");
  mkdirSync(坏目录, { recursive: true });
  writeFileSync(join(坏目录, "计划.md"), "---\n显示名: 缺计划ID\n---\n正文\n", "utf8");
  const bridge = await loadPaoDesktopPlans();
  const result = bridge.readDesktopPlans(项目根);
  assert.equal(result.计划.length, 1);
  assert.equal(result.计划[0]!.计划ID, "p-20261014-good01");
  assert.ok(result.问题.length >= 1);
  assert.ok(result.问题.some((issue) => issue.路径.includes("p-20261014-bad001")));
});
