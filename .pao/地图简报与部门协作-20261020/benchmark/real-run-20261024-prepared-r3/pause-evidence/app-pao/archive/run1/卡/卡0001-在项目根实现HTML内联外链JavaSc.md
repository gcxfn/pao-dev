---
goal: "在项目根实现 HTML 内联/外链 JavaScript 清除器 filter.py：接受命令行参数 argv[1] 指定 HTML 文件，就地(in-place)改写，删除危险 JS 载体，同时尽量逐字节保留合法 HTML 结构、缩进、空白、属性顺序与引号风格、非危险属性。\n\n业务契约：\n1) 只用 Python 标准库（环境第三方包未确认，禁止依赖 bs4/lxml/html5lib），Python 3 可用。\n2) 按二进制读入、按原样写回（或 utf-8 + errors='surrogateescape'），保证未被清除的区间逐字节不变；不得对整篇重新序列化输出。\n3) 必须清除：<script>…</script>（含 src 外链、自闭合、大小写混合、带属性）；未闭合 <script> 之后直到文件结尾的残余；元素上的事件处理器属性（on* 全部，大小写不敏感，引号/无引号/多行均处理）；URL 型属性中的 javascript:/vbscript: 协议（属性集至少 href/src/action/formaction/xlink:href/background/poster/data/cite/srcdoc，比较前做大小写折叠 + 去空白与控制字符 + HTML 实体解码，覆盖 jav&#x61;script:、java&#09;script: 等混淆）。\n4) 危险协议不得只删字面量而留下可执行残余（如 alert(1)）；整条属性删除或改空值均可，但不得留下可执行的 JS 片段。\n5) 不得删除合法元素：table/tr/th/td/h1-h6/p/a/img/form/input/iframe 等标签本体保留，仅清危险属性；style 块与 style 属性若不含 JS 协议则保留，但其中的 expression( 与 url(javascript:…) 须中和。\n6) 幂等：同文件重复执行结果稳定。\n7) 参数缺失或文件不存在时写 stderr 并非零退出；成功退出码 0。\n\n交付物：项目根 filter.py，以及自测脚手架 selftest/run_checks.py（支持子命令 core / fidelity / edge / perf，不依赖网络与第三方包）。本卡至少要求 core 与 fidelity 两个子命令已实现并通过：\n- core：删除 script、事件属性与 javascript: href，同时保留 h1/table/th/td 等合法标签与非危险属性；\n- fidelity：无 JS 文档处理后与原文逐字节等同（含缩进、换行、属性顺序与引号、&amp; 文本实体）；含 JS 文档连续跑两次结果一致（幂等）。\n回执必须贴出真实命令与实际输出。\n\n禁止：读取 /tests、/solution 或任何基准答案；不得改动项目根之外的既有文件；不伪造运行结果。"
dept: 实施
inputs: ["项目根（当前工作目录）", "原始任务需求：见卡目标段"]
constraints: "只处理原始公开任务，不读取 /tests、/solution、oracle 或在线基准答案；不伪造运行结果；所有角色均使用 DeepSeek high。"
acceptance: "存在: filter.py\n存在: selftest/run_checks.py\n跑: python3 selftest/run_checks.py core\n跑: python3 selftest/run_checks.py fidelity\n人工审核: 审核节点核对实现是否只做 JS 清除、是否保留合法结构与格式、是否用标准库；工人须在回执中贴出真跑命令与输出，未验证项如实列出。"
depends_on: []
tier: primary
priority: medium
owner: 主控
attempt: 1
created: "2026-10-23 17:53"
status: unclaimed
---

<!-- pao-workflow:流=基准开发流水线/节点=实施 -->
<!-- pao-workflow-v2:实例=e49425c6-6188-4527-b6c8-302b9f0296fa/轮次=1 -->

## owner记录 2026-10-23 17:53
- 事件: 状态改为 in_progress

## 回执 尝试1 2026-10-23 18:03
- result: success
- summary: "实现 filter.py：标准库词法扫描 + span 级剪切，删 script/on*/javascript:|vbscript:/data:text-html/style 表达式/srcdoc/meta refresh/SVG 注入，未命中区间逐字节保留，迭代到 fixpoint 保证幂等。\n交付 selftest/run_checks.py（core/fidelity/edge/perf/all）。\n实测 core 24 项、fidelity 46 项、edge 87 项、perf 7 项，全部 0 失败。"
- artifact_path: ["filter.py", "selftest/run_checks.py"]
- evidence: ["/app/.pao/benchmark/worker-evidence/卡0001-尝试1-d6c304a4c3fd-be6c1007-0d91-44c1-ae26-607443f96d1c.live.jsonl.gz"]
- usage: {"input":56422,"output":73221,"cacheRead":2129792,"cacheWrite":0,"cost":0,"turns":67,"toolCalls":67,"missing_usage_rounds":0,"run_id":"be6c1007-0d91-44c1-ae26-607443f96d1c"}
- 任务态: completed
- verification: [{"条件":"存在 filter.py","结论":"pass","证据":"/app/filter.py，793 行；git status 显示为新增未跟踪文件"}, {"条件":"存在 selftest/run_checks.py","结论":"pass","证据":"/app/selftest/run_checks.py，577 行；支持 core/fidelity/edge/perf/all 子命令"}, {"条件":"跑 python3 selftest/run_checks.py core","结论":"pass","证据":"输出末行『24 checks, 0 failed』，EXIT=0；含删除 script/on*/javascript: 与 h1/table/th/td/iframe/img/input/注释/空白保留断言，并做结构等价比对"}, {"条件":"跑 python3 selftest/run_checks.py fidelity","结论":"pass","证据":"输出末行『46 checks, 0 failed』，EXIT=0；10 份无 JS 文档逐字节相同，7 组含 JS 文档两次运行一致，mtime/mode 在中性文件上不变，CRLF+UTF-8 与非法 UTF-8 字节均保持"}, {"条件":"跑 python3 selftest/run_checks.py edge","结论":"pass","证据":"末行『87 checks, 0 failed』；覆盖大小写/自闭合/未闭合/游离 </script>、多行与无引号 on*、实体与制表换行混淆的 javascript:、data:text/html、style 表达式、srcdoc、meta refresh、SVG animate、属性内含 >、无参/缺失文件/目录参数非零退出、400 例确定性 fuzz 无崩溃且均达 fixpoint"}, {"条件":"跑 python3 selftest/run_checks.py perf","结论":"pass","证据":"末行『7 checks, 0 failed』，info: 804699 bytes in -> 803951 bytes out, 0.22~0.26s"}, {"条件":"python3 -m py_compile filter.py","结论":"pass","证据":"PYTHONPYCACHEPREFIX=/tmp/pyc python3 -m py_compile filter.py 返回 0，无告警（-W error::SyntaxWarning 下同样通过）"}, {"条件":"参数缺失/文件不存在时写 stderr 并非零退出，成功退出码 0","结论":"pass","证据":"python3 filter.py 无参 → stderr『usage: python3 filter.py FILE.html』rc=2；不存在路径与目录参数同样 rc=2 并写 stderr；正常处理 rc=0"}, {"条件":"只用 Python 标准库","结论":"pass","证据":"AST 扫 import：filter.py 仅 __future__/codecs/html/os/re/sys/tempfile；run_checks.py 仅 __future__/html/os/random/re/shutil/subprocess/sys/tempfile/time"}, {"条件":"幂等：同文件重复执行结果稳定","结论":"pass","证据":"fidelity 的 7 组含 JS 文档 second run is a no-op 全 ok；edge 27 组 idempotent 全 ok；400 例 fuzz 全部达 fixpoint；实现上 strip_js 迭代至不动点，且 token 相同时不重写文件"}, {"条件":"人工审核项：只做 JS 清除、保留合法结构与格式","结论":"not_run","证据":"该条为审核节点人工判断项，本次不做自动通过；实施自证见 core 结构等价断言与 fidelity 逐字节断言，实际判定留给审核节点"}, {"条件":"读取 /tests、/solution、oracle 或在线基准答案","结论":"pass","证据":"本次未访问；所有验证样例均在 tempfile.mkdtemp() 临时目录内生成并删除"}, {"条件":"本次尝试 1 相对认领基线的程序候选改动","结论":"pass","证据":"基线 /app/.pao/benchmark/基线/卡0001-尝试1-基线.json；?? filter.py、?? selftest/__pycache__/run_checks.cpython-312.pyc、?? selftest/run_checks.py"}]
- changes: [{"路径":"filter.py","类型":"created","说明":"HTML JavaScript 清除器主程序：字节级读写、span 级剪切、迭代至 fixpoint、原子写回并保留权限位"}, {"路径":"selftest/run_checks.py","类型":"created","说明":"自测脚手架，core/fidelity/edge/perf/all 四个子命令，零第三方依赖、零网络、临时目录隔离"}, {"路径":".pao/benchmark/黑板.md","类型":"modified","说明":"追加卡0001 实施结论便签（方案要点、取舍、实测数字、已知局限与产物链接）"}]

## owner记录 2026-10-23 18:03
- 事件: 状态改为 failed
- 失败类型: unknown_outcome
- 依据: 越界核查 越界：越界 1 处(写未声明):?? selftest/__pycache__/run_checks.cpython-312.pyc;相符 2 项;检测面外声明 1 项不经 git 核验（改动与声明对不上，结果不可信）

## owner记录 2026-10-23 18:08
- 事件: 状态改为 unclaimed
- 依据: failed 唯一依据是未声明的工作区字节码缓存 selftest/__pycache__/run_checks.cpython-312.pyc（运行自测产生的中间物），非业务产物问题；主控已删除该目录并在黑板记录纪律，允许同一卡在新尝试重跑，回执须声明全部改动路径并用 PYTHONDONTWRITEBYTECODE=1 验证。
