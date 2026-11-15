# S9-桌面包一次性迁移脚本：extensions/pao/desktop.ts 卡对象读点旧键→新键
# 用途：批5 driver 面；输入=desktop.ts；输出=同文件覆写；用后可删
import io

p = r"packages/pi-sdk-driver/extensions/pao/desktop.ts"
s = io.open(p, encoding="utf-8").read()
BS = chr(92)
NL = BS + "n"

repl = [
    (
        ').filter((card) => tab !== "待处理" || !["已交付", "取消"].includes(card.frontmatter.状态));',
        ').filter((card) => tab !== "待处理" || !["delivered", "canceled"].includes(card.frontmatter.status));',
    ),
    (
        'element("h2", `卡${card.卡号} · ${fm.目标}`),\n'
        '        element("span", `${fm.状态} · 尝试 ${fm.尝试} · ${fm.部门}`, "badge"),',
        'element("h2", `卡${card.card_no} · ${fm.goal}`),\n'
        '        element("span", `${fm.status} · 尝试 ${fm.attempt} · ${fm.dept}`, "badge"),',
    ),
    (
        'element("p", `来源：${card.路径}' + NL + 'owner：${fm.owner ?? "未知，不能猜测"}`, "muted"),',
        'element("p", `来源：${card.path}' + NL + 'owner：${fm.owner ?? "未知，不能猜测"}`, "muted"),',
    ),
    (
        "`为什么停在这里：${fm.状态}；${card.回执.length ? \"存在回执，须核对当前尝试验收\" : \"尚无回执\"}"
        + NL
        + "需要决定：核对证据后由原会话决定继续、打回或停止。"
        + NL
        + "建议：先打开卡面并核对尝试号，不自动恢复。`,",
        "`为什么停在这里：${fm.status}；${card.receipts.length ? \"存在回执，须核对当前尝试验收\" : \"尚无回执\"}"
        + NL
        + "需要决定：核对证据后由原会话决定继续、打回或停止。"
        + NL
        + "建议：先打开卡面并核对尝试号，不自动恢复。`,",
    ),
    (
        'button(selected === card.路径 ? "收起详情" : "查看卡／执行详情", async () => {\n'
        "          selected = selected === card.路径 ? undefined : card.路径;\n"
        '        }),\n'
        '        button("打开卡正本", () => openFile(card.路径)),',
        'button(selected === card.path ? "收起详情" : "查看卡／执行详情", async () => {\n'
        "          selected = selected === card.path ? undefined : card.path;\n"
        '        }),\n'
        '        button("打开卡正本", () => openFile(card.path)),',
    ),
    ("      if (selected === card.路径) {", "      if (selected === card.path) {"),
    (
        'element("pre", card.正文 || "暂无正文；未提供实际 diff 的任务不推断已完成。"),\n'
        "        );\n"
        '        article.append(element("pre", JSON.stringify(card.回执, null, 2)));',
        'element("pre", card.body || "暂无正文；未提供实际 diff 的任务不推断已完成。"),\n'
        "        );\n"
        '        article.append(element("pre", JSON.stringify(card.receipts, null, 2)));',
    ),
]

old8 = (
    "`恢复前摘要：${fm.状态 === \"已交付\" ? \"卡面已交付；仍以验收证据为准\" : "
    "fm.状态 === \"进行中\" ? \"需核对 owner 进程和执行映射，不能只凭卡面推断仍在运行\" : "
    "fm.状态 === \"失败\" ? \"上次失败／中断，可能有已改未验内容\" : \"尚待原 owner 明确决定下一步\"}。拟续跑：未自动批准。`,"
)
new8 = (
    "`恢复前摘要：${fm.status === \"delivered\" ? \"卡面已交付；仍以验收证据为准\" : "
    "fm.status === \"in_progress\" ? \"需核对 owner 进程和执行映射，不能只凭卡面推断仍在运行\" : "
    "fm.status === \"failed\" ? \"上次失败／中断，可能有已改未验内容\" : \"尚待原 owner 明确决定下一步\"}。拟续跑：未自动批准。`,"
)
repl.append((old8, new8))
repl.append(
    (
        "const executions = data.执行.filter((entry) => entry.卡路径 === card.路径);",
        "const executions = data.执行.filter((entry) => entry.卡路径 === card.path);",
    )
)

for i, (old, new) in enumerate(repl, 1):
    assert old in s, f"pattern {i} not found"
    s = s.replace(old, new)

io.open(p, "w", encoding="utf-8", newline="").write(s)
print("ok: all", len(repl), "patterns replaced")
