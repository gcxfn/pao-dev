---
goal: "对 /app/filter.py 做独立对抗性复核（第三轮，只改真实缺陷），模拟隐藏验收可能采用的检查方式，产出最终可核对证据包。\n\n【对抗性夹具（新建 /tmp/pf/final/，不得复用卡1/卡2 期望值篡改）】至少 20 个文件，必须包含：\n- 内联/外链/自闭合/未闭合 script；script 在 head、body、table 单元格内、属性值字符串中（仅文本出现不算标签）；\n- 事件属性：onclick、ONERROR、onmouseover、onload、onbegin、xlink:onload、`onclick = \"...\"` 带空格；\n- URL 混淆：`java\\tscript:`、`java&#x0A;script:`、`&#106;avascript:`、`JaVaScRiPt:`、前导空格、`data:text/html`、`vbscript:`；属性 href/src/action/formaction/poster/background/xlink:href；\n- srcdoc 嵌套 HTML、meta refresh（危险与良性各一）、base href、object/embed 危险 data/src；\n- style 属性良性/含 expression(；style 元素良性/含 javascript:；\n- 注释内 `<script>` 与 `javascript:`；CDATA/`<![if ...]>` 等伪注释；\n- SVG/MathML 内事件属性；\n- 完全良性复杂页面（doctype、table、header、nav、form 良性 action、img alt/src、实体与引号混用）。\n\n【检查方法（全部真跑）】\n1) 每个夹具先 sha256sum 记录输入，跑 `python3 /app/filter.py` 后再次 sha256sum；\n2) 危险面：对输出 grep -Ei 检查 `<script`、`on[a-z]+\\s*=`、`javascript:`、`vbscript:`、`srcdoc`、`http-equiv\\s*=\\s*[\"']?refresh`、`<base` 的残留（文本中确有良性字面量的用例需在报告中逐条说明并单独论证）；\n3) 良性面：完全良性页面 `cmp -s` 必须一致；含危险串的页面用 bs4 比对标签计数与 get_text()，确认仅风险子串被删；\n4) 幂等：全部夹具跑两遍 `cmp` 一致；\n5) 回归：复跑卡1 V1–V4 与卡2 关键用例，全部通过；\n6) 命令行契约：无参数 exit 2、坏路径 exit 1，stderr 无 Traceback。\n\n【修复授权】只允许为真实失败用例修改 /app/filter.py 的清洗逻辑，每次修改后必须复跑全部历史用例，证明无回归；不得为让用例通过而放宽删除规则或修改夹具期望。\n\n【最终交付】/tmp/pf/logs/final/ 下按用例保存命令与输出；/tmp/pf/logs/summary-final.md 给出：交付物路径与 `wc -l`、依赖清单（确认只用 stdlib+已装 bs4 校验）、20+ 用例结果表（用例/命令/exit/cmp/grep 结论）、复跑回归结果、明确列出的未验证项与已知取舍（例如可见文本中的 javascript: 字面量、style 元素含危险构造时整元素删除）。"
dept: 实施
inputs: [".pao/benchmark/工作流实例-基准开发流水线.md", "/app/filter.py"]
constraints: "只处理原始公开任务，不读取 /tests、/solution、oracle 或在线基准答案；不伪造运行结果；所有角色均使用 DeepSeek high。\n仅修改 /app/filter.py 与 /tmp/pf 下文件；严禁读 /tests、/solution、oracle 或在线基准答案；严禁联网、pip install、猜测隐藏测试；不得伪造命令输出或退出码；不得删除/篡改卡1/卡2 的既有日志与夹具原始副本；所有角色使用 DeepSeek high。"
acceptance: "1) /tmp/pf/final/ 至少 20 个夹具，逐一有输入 sha256、运行命令、输出 sha256、危险面 grep 结果、良性面结构断言；\n2) 完全良性页面 `cmp -s` 返回 0；含危险串页面输出中危险面 grep 计数为 0（文本字面量例外需逐条列证）；\n3) 全部夹具第二遍 `cmp` 一致（幂等）；\n4) 卡1/卡2 历史用例复跑全部通过，有日志可核；\n5) 无参数 exit 2、坏路径 exit 1、stderr 无 Traceback，日志贴出实际退出码；\n6) summary-final.md 存在且结论与日志一致，未验证项与取舍如实列出；不存在声称通过但无日志的条目。"
depends_on: ["卡0002"]
tier: primary
priority: medium
owner: 主控
attempt: 2
created: "2026-10-21 13:01"
status: in_progress
---

<!-- pao-workflow:流=基准开发流水线/节点=实施 -->
<!-- pao-workflow-v2:实例=86e2c830-6291-46e1-aa32-8c3d55e474eb/轮次=1 -->

## owner记录 2026-10-21 14:06
- 事件: 状态改为 in_progress

## 回执 尝试1 2026-10-21 14:33
- result: failed
- summary: "无有效回执：最终输出缺少有效 JSON 回执（result、artifact_path、summary）"
- evidence: ["/app/.pao/benchmark/worker-evidence/卡0003-尝试1-5b3d51944d20-18922b09-805e-4a4c-bd29-9a90f6fb65f6.live.jsonl.gz"]
- usage: {"input":111047,"output":136926,"cacheRead":7090560,"cacheWrite":0,"cost":0,"turns":100,"toolCalls":104,"missing_usage_rounds":0,"run_id":"18922b09-805e-4a4c-bd29-9a90f6fb65f6"}
- failure_type: unknown_outcome

## owner记录 2026-10-21 14:33
- 事件: 状态改为 failed
- 失败类型: unknown_outcome
- 依据: worker 回执 failed（unknown_outcome），自动链如实落失败

## owner记录 2026-10-21 14:36
- 事件: 状态改为 unclaimed
- 依据: 尝试1 回执 unknown_outcome（最终输出缺有效 JSON 回执），但本轮产物与日志真实存在（/tmp/pf/logs/final/ 20 份日志、summary-final.md 46/46 PASS、0 FAIL）。按「失败卡须重试或取消，不能直接交付」重置为待认领，重派一次以取得有效回执。

## owner记录 2026-10-21 14:36
- 事件: 状态改为 in_progress
