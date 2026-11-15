# 用途：S9-桌面包 批7——tests/core/kanban-board.spec.ts 机器协议随迁（卡状态值/失败分型→英文；
#       data-status＝英文值、列标题保持中文标签；addNodeCards 卡规格键→goal/acceptance）。
# 输入：desktop/apps/desktop/tests/core/kanban-board.spec.ts（原样）
# 输出：同文件（覆写）；stdout 打印每条替换计数，断言不符即失败。
# 说明：本文件是真实加载内核 dist 的收口门面，期望值已迁新契约，跑门待内核包产物落位。
import io

P = r"D:\AI\workspace\pao-dev\desktop\apps\desktop\tests\core\kanban-board.spec.ts"
s = io.open(P, encoding="utf-8").read()

HEADER_OLD = """ * 边界：不连 provider、不派发 worker、不调用模型；夹具的状态变化只证明看板按卡面现读刷新，
 * 不证明执行、验收或交付成立。
 */"""
HEADER_NEW = """ * 边界：不连 provider、不派发 worker、不调用模型；夹具的状态变化只证明看板按卡面现读刷新，
 * 不证明执行、验收或交付成立。
 *
 * S9 键名随迁（2026-10-08）：卡状态值/失败分型按定名表迁英文——data-status＝英文现读值、
 * 列标题保持中文标签；夹具建卡/改状态用新值域，addNodeCards 卡规格改 goal/acceptance 键。
 * 本文件真实加载内核 dist（收口门面）：期望已按新契约改写，内核包构建产物落位后重跑——收口门跑。
 */"""

LOOP_OLD = """    // 五列固定顺序，列标题就是卡状态现读值。
    const statuses = ["待认领", "进行中", "已交付", "失败", "取消"];
    await expect(page.getByTestId("kanban-column")).toHaveCount(statuses.length);
    for (const [index, status] of statuses.entries()) {
      const column = columnOf(status);
      await expect(column).toHaveCount(1);
      await expect(page.getByTestId("kanban-column").nth(index)).toHaveAttribute(
        "data-status",
        status,
      );
      await expect(column.getByRole("heading", { level: 2 })).toHaveText(status);
    }"""
LOOP_NEW = """    // 五列固定顺序：data-status＝卡状态英文现读值，列标题保持中文标签。
    const statuses: [string, string][] = [
      ["unclaimed", "待认领"],
      ["in_progress", "进行中"],
      ["delivered", "已交付"],
      ["failed", "失败"],
      ["canceled", "取消"],
    ];
    await expect(page.getByTestId("kanban-column")).toHaveCount(statuses.length);
    for (const [index, [status, label]] of statuses.entries()) {
      const column = columnOf(status);
      await expect(column).toHaveCount(1);
      await expect(page.getByTestId("kanban-column").nth(index)).toHaveAttribute(
        "data-status",
        status,
      );
      await expect(column.getByRole("heading", { level: 2 })).toHaveText(label);
    }"""

# (old, new, expected_count；None＝不查计数只查命中)
pairs = [
    (HEADER_OLD, HEADER_NEW, 1),
    (LOOP_OLD, LOOP_NEW, 1),
    ('状态: "待认领",', '状态: "unclaimed",', 1),
    ("card.frontmatter.目标 === 目标", "card.frontmatter.goal === 目标", 1),
    ('to: "进行中"', 'to: "in_progress"', 2),
    ('to: "已交付"', 'to: "delivered"', 1),
    ('to: "失败"', 'to: "failed"', 1),
    ('to: "取消"', 'to: "canceled"', 1),
    ('失败类型: "缺输入",', '失败类型: "missing_input",', 2),
    ('"目标: 坏卡"', '"goal: 坏卡"', 1),
    ('{ 目标: "多卡第一张", 验收: "第一张就位" }', '{ goal: "多卡第一张", acceptance: "第一张就位" }', 1),
    ('{ 目标: "多卡第二张", 验收: "第二张就位" }', '{ goal: "多卡第二张", acceptance: "第二张就位" }', 1),
    ('columnOf("待认领")', 'columnOf("unclaimed")', 8),
    ('columnOf("进行中")', 'columnOf("in_progress")', 6),
    ('columnOf("已交付")', 'columnOf("delivered")', 4),
    ('columnOf("失败")', 'columnOf("failed")', 2),
    ('columnOf("取消")', 'columnOf("canceled")', 4),
    ('cardOf("进行中", "乙卡进行中"), "已交付")', 'cardOf("in_progress", "乙卡进行中"), "delivered")', 1),
    ('cardOf("待认领", "甲卡待认领"), "取消")', 'cardOf("unclaimed", "甲卡待认领"), "canceled")', 1),
    ('[data-status="失败"]', '[data-status="failed"]', 1),
    ('[data-status="进行中"]', '[data-status="in_progress"]', 1),
    ('[data-status="已交付"]', '[data-status="delivered"]', 1),
    ('toHaveAttribute("data-status", "进行中")', 'toHaveAttribute("data-status", "in_progress")', 1),
    ('toHaveAttribute("data-status", "失败")', 'toHaveAttribute("data-status", "failed")', 2),
    ('\'"新状态":"取消"\'', '\'"new_status":"canceled"\'', 2),
    ('toContainText("缺输入")', 'toContainText("missing_input")', 2),
]

for i, (old, new, count) in enumerate(pairs, 1):
    found = s.count(old)
    assert found > 0, f"pattern {i} 未命中：{old[:60]}"
    if count is not None:
        assert found == count, f"pattern {i} 命中 {found} 处，期望 {count}：{old[:60]}"
    s = s.replace(old, new)

io.open(P, "w", encoding="utf-8", newline="").write(s)
print("ok:", len(pairs), "patterns")
