---
goal: "编写 /app/tests_filter/selftest_filter.py（仅标准库），把 F1-F25 夹具逐条固化为期望字节，通过 subprocess 调用 python3 /app/filter.py 处理临时文件并逐字节比对，全部通过时退出码 0，任一失败退出码非 0 并打印差异；并在夹具暴露缺陷时于 D1-D8 约定范围内修正 /app/filter.py。"
dept: 实施
inputs: [".pao/benchmark/输入快照/map/wf-729b1d4c-ece9-4e74-9cf3-05ab53594a76----1-0fe6adea-000a-41c7-85de-4f59729dcce8.json", "filter.py"]
constraints: "只处理原始公开任务，不读取 /tests、/solution、oracle 或在线基准答案；不伪造运行结果；所有角色使用本轮选定模型与 high。\n不读 /tests、/solution、oracle；不查在线解法；不引入第三方依赖（selftest 与 filter.py 都只用标准库）；不修改 D1-D8 既定约定来迁就实现；除 /app/filter.py 与 /app/tests_filter/selftest_filter.py 外不改仓库其他文件（不得删改卡一已交的 check_case.py 与夹具期望文件）；夹具临时文件只放系统临时目录并清理。\n\n## 交付物\n- /app/tests_filter/selftest_filter.py（仅标准库，覆盖 F1-F25 全部夹具，含 F22 编码用例与 F23 幂等用例）\n- /app/filter.py（如因夹具暴露缺陷而做的修正，仅限 D1-D8 约定范围内的缺陷修复）\n- 工人回执：自测脚本真实运行的完整输出与退出码、修正点清单（文件+行+原因）、仍未覆盖/未验证项\n\n## 实施提示\n脚本要求：仅用标准库（unittest 或裸 assert）；每个夹具写入临时目录的独立文件 → 以 subprocess 调用 python3 filter.py <file>（相对路径，工作目录为仓库根 /app）→ 逐字节比对期望 → 全部通过退出码 0，任一失败退出码非 0 并打印实际值与期望值差异；末尾必须含 F23 幂等用例与 F22 编码用例；脚本自身不得读写 /tests、/solution；临时文件只放 tempfile 目录并清理，仓库内不留残留。\n\n夹具期望（必须逐条固化）：\nF1 <div><script>alert(1)</script>text</div> → <div>text</div>\nF2 <script src=\"app.js\"></script> → 空\nF3 <SCRIPT TYPE=\"text/javascript\">alert(1)</SCRIPT> → 空\nF4 <img src=\"x.png\" onerror=\"alert(1)\"> → <img src=\"x.png\">\nF5 <div OnClick=\"x()\">t</div> → <div>t</div>\nF6 <a href=\"javascript:alert(1)\">x</a> → <a>x</a>\nF7 <a href=\"JaVaScRiPt:alert(1)\">x</a> → <a>x</a>\nF8 <a href=\"&#106;avascript:alert(1)\">x</a> → <a>x</a>\nF9 <a href=\"  javascript:alert(1)\">x</a> → <a>x</a>\nF10 <form action=\"javascript:x\" method=\"post\">f</form> → <form method=\"post\">f</form>\nF11 <a href=javascript:alert(1)>x</a> → <a>x</a>\nF12 <svg><script>alert(1)</script><circle r=\"1\"/></svg> → <svg><circle r=\"1\"/></svg>\nF13 <iframe srcdoc=\"<script>alert(1)</script>\"></iframe> → <iframe></iframe>\nF14 <meta http-equiv=\"refresh\" content=\"0;url=javascript:alert(1)\"> → <meta http-equiv=\"refresh\">\nF15 干净文档（doctype、table/tr/th/td、h1、style 属性、&/< 实体、注释、UTF-8 中文 café）→ 输出与输入逐字节相同\nF16 <!-- <script>alert(1)</script> --> → <!--  -->\nF17 <script/>alert(1)</script>after → after\nF18 <script>var s = \"</script>\";</script>after → ;after（首个 </script 即闭合，符合 HTML5）\nF19 <a href=\"javascript:void(0)\" title=\"t\">x</a> → <a title=\"t\">x</a>\nF20 <a href=\"data:text/html,<script>alert(1)</script>\">x</a> → <a>x</a>\nF21 CRLF：<p>a</p>\\r\\n<script>x</script>\\r\\n → <p>a</p>\\r\\n\\r\\n\nF22 latin-1 字节 b'<p>caf\\xe9</p><script>x</script>' → b'<p>caf\\xe9</p>'（0xE9 原样保留）\nF23 幂等：对同一文件连续执行两次，第二次输出与第一次逐字节相同\nF24 <div onclick=\"a()\"\\n  class=\"x\"> → <div\\n  class=\"x\">\nF25 <a href=\"#\">ok</a> 与 <a HREF=\"#\">ok</a> 均原样不变（属性名大小写与引号风格不得被改写）\n\n修正边界：只修 D1-D8 约定范围内的缺陷（例如某条规则漏实现、属性前空白处理不一致、编码回退写错）；若某夹具期望与 D1-D8 明显冲突（如 F18 的首个 </script 闭合语义、F13 的 srcdoc 只在真含危险内容时删），以 D1-D8 为准并在回执说明差异，不要为了迁就实现而改写约定语义。"
acceptance: "跑: python3 -m py_compile filter.py\n跑: python3 -m py_compile tests_filter/selftest_filter.py\n跑: python3 tests_filter/selftest_filter.py\n存在: tests_filter/selftest_filter.py\n包含: tests_filter/selftest_filter.py::srcdoc\n包含: tests_filter/selftest_filter.py::javascript:\n包含: tests_filter/selftest_filter.py::data:text/html"
depends_on: []
tier: primary
priority: medium
owner: 主控
attempt: 1
created: "2026-10-27 17:40"
status: unclaimed
---

<!-- pao-workflow:流=基准开发流水线/节点=实施 -->
<!-- pao-workflow-v2:实例=729b1d4c-ece9-4e74-9cf3-05ab53594a76/轮次=1 -->

## owner记录 2026-10-27 17:43
- 事件: 状态改为 in_progress
- 依据: 卡0002 因自动链派发异常（派发交接的地图覆盖内容在卡0001 交付后已变化）未被派出；现由 owner 通道放行为进行中以重新触发派发。depends_on 为空、卡面输入含已交付的 filter.py，交付物范围不与卡0001 冲突。

## owner记录 2026-10-27 17:44
- 事件: 状态改为 failed
- 失败类型: transient
- 依据: 卡0002 尝试 1 未真正开工：自动链在派发交接时报「派发交接的地图覆盖内容已变化」（卡0001 交付后工作树与输入快照地图不再一致），随后部长 RPC 握手超时导致实施部长会话与全部 worker 退出，本卡无任何回执、无运行证据，现状为僵尸进行中状态。为避免误判为在跑 worker，改判为瞬时失败后重排，等链恢复时以新快照重新派发。

## owner记录 2026-10-27 17:44
- 事件: 状态改为 unclaimed
- 依据: 尝试数 1 低于同轮上限 2，允许重排：卡0002 回到待认领，待自动链恢复（部长会话可正常握手）后以包含卡0001 已交卷成果的新快照重新派发。
