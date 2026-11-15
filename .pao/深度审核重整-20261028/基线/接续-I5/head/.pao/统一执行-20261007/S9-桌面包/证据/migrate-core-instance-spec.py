# 用途：S9-桌面包 批7——tests/core/workflow-instance.spec.ts 机器协议随迁
#       （changeCardStatus 值域→英文五值、失败类型→transient、addNodeCards 卡规格键→goal/acceptance）。
# 输入：desktop/apps/desktop/tests/core/workflow-instance.spec.ts（原样）
# 输出：同文件（覆写）；stdout 打印替换计数，断言不符即失败。
# 说明：真实加载内核 dist 的收口门面；节点框/详情的中文状态标签断言保留（渲染走 cardStatusLabel）。
import io

P = r"D:\AI\workspace\pao-dev\desktop\apps\desktop\tests\core\workflow-instance.spec.ts"
s = io.open(P, encoding="utf-8").read()

pairs = [
    # 两处夹具的 addNodeCards 卡规格：NodeCardInput 已是 frontmatter 英文键
    ('[{ 目标: "实现冻结甲", 验收: "文件存在" }]', '[{ goal: "实现冻结甲", acceptance: "文件存在" }]', 1),
    ('{ 目标: "执行 " + nodeName, 验收: "文件存在" }', '{ goal: "执行 " + nodeName, acceptance: "文件存在" }', 1),
    # changeCardStatus 值域（输入键 操作者/to/时间/失败类型 保留中文）
    ('to: "进行中", 时间: "2026-10-05 10:01"', 'to: "in_progress", 时间: "2026-10-05 10:01"', 1),
    ('to: "进行中", 时间: "2026-10-07 10:01"', 'to: "in_progress", 时间: "2026-10-07 10:01"', 1),
    ('if (cardStatus !== "进行中") {', 'if (cardStatus !== "in_progress") {', 1),
    ('失败类型: "瞬时故障"', '失败类型: "transient"', 1),
    ('driveNode("执行甲", "minister-a", "已交付", true)', 'driveNode("执行甲", "minister-a", "delivered", true)', 1),
    ('driveNode("执行乙", "minister-b", "进行中", true)', 'driveNode("执行乙", "minister-b", "in_progress", true)', 1),
    ('driveNode("执行丙", "minister-c", "失败", false)', 'driveNode("执行丙", "minister-c", "failed", false)', 1),
    # 同函数注释里的状态机描述改为新值域，避免误导
    ("  // 合法迁移路径（内核状态机）：待认领只能→进行中/取消，进行中才能→已交付/失败；\n  // 转入失败必须带失败类型。卡先认领成进行中，再按目标态走第二步。",
     "  // 合法迁移路径（内核状态机）：unclaimed 只能→in_progress/canceled，in_progress 才能→delivered/failed；\n  // 转入 failed 必须带失败类型。卡先认领成 in_progress，再按目标态走第二步。", 1),
]

for i, (old, new, count) in enumerate(pairs, 1):
    found = s.count(old)
    assert found == count, f"pattern {i} 命中 {found} 处，期望 {count}：{old[:60]}"
    s = s.replace(old, new)

io.open(P, "w", encoding="utf-8", newline="").write(s)
print("ok:", len(pairs), "patterns")
