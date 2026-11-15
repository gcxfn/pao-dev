---
goal: "独立复审修复后的 /app/filter.py，确认审核报告中的 B-1（raw-text 实体重复转义、非幂等）与 B-2（无害注释误删）确已修复且无回归，把逐项判定写入 /app/.pao/benchmark/复审报告.md。原始任务：创建 Python 脚本 filter.py，接收 HTML 文件路径参数，就地移除其中全部 JavaScript 以防 XSS，尽量保留原有 HTML 结构与格式（仅允许解析带来的规范化），只能使用已安装的 Python 包。"
dept: 审核
inputs: ["/app/filter.py", "/app/.pao/benchmark/审核报告.md"]
constraints: "独立复审，不修改 /app/filter.py 与 app 项目内其他业务文件；夹具只放 /tmp；不读取 tests、solution、oracle 或在线基准答案；不伪造运行结果；不把自测当官方验收；不因「上一轮已通过」而跳过复核。\n\n必须复检：\n1. B-1：raw-text 元素（iframe/xmp/noembed/noframes/plaintext）文本含 & 与实体时，连跑两次 cmp 必须相同，且文本语义与形态稳定。请额外测：iframe 内含 &amp;amp; 双层实体、iframe 内含字面 <script 串、嵌套 raw-text、plaintext。\n2. B-2：<!-- options=1 controls the menu -->、buttons=、icons=、lessons= 这类无害注释必须保留；<!-- onclick=x() -->、<!-- onload= --> 这类真载荷仍应删除。给出两侧证据。\n3. 回归：卡0007 报告中已 pass 的 7 项（命令行接口、就地修改、彻底性、健壮性、依赖、py_compile、以及保留性中除注释外的 22 项）不得回退。\n4. 新增风险：检查修复是否引入新问题，特别是 raw-text 内 javascript: 或 on* 载荷是否因「不转义」而漏清；给出具体夹具与断言。\n5. 幂等与格式保持：对不含危险内容的普通 HTML（含 doctype、中文、表格、表单、实体、注释、CRLF、BOM）运行后与输入差异是否仅限解析规范化，逐条解释。\n\n报告须有总判定（通过/不通过）与「未验证」段；缺陷给最小复现、期望与实际、严重级别。"
acceptance: "1. 存在:/app/.pao/benchmark/复审报告.md\n2. 包含:/app/.pao/benchmark/复审报告.md :: 判定\n3. 包含:/app/.pao/benchmark/复审报告.md :: 未验证\n4. 对卡0007 报告中的 B-1、B-2 与 9 项核查逐一给出复检结论，并附真实命令与输出"
depends_on: ["卡0008"]
tier: primary
budget: {"toolCalls":160,"turns":120}
priority: high
owner: 主控
attempt: 1
created: "2026-10-23 05:41"
status: in_progress
---

## owner记录 2026-10-23 05:41
- 事件: 状态改为 in_progress
