---
goal: "在上一卡的 filter.py 基础上做边界加固与独立验证（仍只改 filter.py，其余只动自测脚手架 selftest/run_checks.py）：\n1) 混淆与灰区：实体编码协议（jav&#x61;script:、java&#09;script:、&#106;avascript:）、大小写混合、值内外空白/换行/制表、无引号属性值、属性值内嵌引号。\n2) 其它 JS 载体：<iframe srcdoc=\"<script>…\">、<meta http-equiv=refresh content=\"0;url=javascript:…\">、<form action=javascript:…>、<svg onload=…>、<object data=javascript:…>、<embed src=javascript:…>；标签本体与非危险属性要保留。\n3) 畸形输入：未闭合 <script>（其后不得残留可执行脚本且输出仍可解析）、脚本块内字符串含 </script> 字样、注释中的 script、连续多个/空 script、<script src> 无结束标签。\n4) 幂等与格式保持：无 JS 文档逐字节等同；含 JS 文档除被删的 harmful 子串外其余字节保持原样，不引入新标签/属性，不重排表格。\n5) 规模：≥1MB 文档不崩、无超线性耗时（10 秒内完成）。\n验证方式：脚手架补充 edge / perf 子命令，真跑并记录命令与输出；每类边界给出处理前后对比（可截断但可核对）。\n禁止：读取 /tests、/solution 或任何基准答案；不伪造运行结果；不改动项目根之外的既有文件。"
dept: 实施
inputs: ["项目根 filter.py（上一卡产出）", "项目根 selftest/run_checks.py（上一卡产出）"]
constraints: "只处理原始公开任务，不读取 /tests、/solution、oracle 或在线基准答案；不伪造运行结果；所有角色均使用 DeepSeek high。"
acceptance: "存在: filter.py\n跑: python3 selftest/run_checks.py edge\n跑: python3 selftest/run_checks.py perf\n跑: python3 selftest/run_checks.py core\n跑: python3 selftest/run_checks.py fidelity\n人工审核: 审核节点核对加固后是否仍只做 JS 清除、非危险字节是否逐字节保留、未覆盖/未验证场景是否在回执中如实声明；工人须贴出真跑命令与输出。"
depends_on: []
tier: primary
priority: medium
attempt: 0
created: "2026-10-23 17:53"
status: unclaimed
---

<!-- pao-workflow:流=基准开发流水线/节点=实施 -->
<!-- pao-workflow-v2:实例=e49425c6-6188-4527-b6c8-302b9f0296fa/轮次=1 -->
