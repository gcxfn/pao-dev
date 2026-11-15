---
goal: "创建 /app/filter.py（纯 Python，单文件，仅用环境已装库：stdlib 为主，bs4 4.13.4 只作只读校验），实现 HTML 中的 JavaScript 清除，并完成基础自测。\n\n【真实路径】\n- 唯一交付物：/app/filter.py（/app 当前为空目录，filter.py 不存在，需新建）。\n- 自测夹具与日志：/tmp/pf/、/tmp/pf/logs/（可自由创建）。\n- 禁止改动 /app 下其他任何文件；禁止创建 venv；禁止 pip install；禁止联网。\n\n【CLI 契约】\n- `python3 /app/filter.py <html-file>`：argv[1] 为单个 HTML 文件路径，原地修改该文件。\n- 无 argv[1]：stderr 打印一行用法，exit 2，禁止 traceback。\n- 路径不存在/不可读：stderr 一行错误，exit 1，禁止 traceback。\n- 可选 `--check <file>` 只读校验模式不得影响 argv[1] 主路径行为。\n\n【I/O 层】\n- 以二进制读入，先 utf-8 strict 解码，失败退 utf-8 + errors='surrogateescape'；写回使用同一编码与 errors，保证非 UTF-8 原始字节可原样回写。\n- 写回用同目录临时文件 + os.replace，保留文件权限；空文件（0 字节）不改内容、exit 0。\n\n【清洗核心：单遍状态机，禁止对全文做 str(soup) 重序列化】\n必须区分 DATA / TAG（引号感知）/ COMMENT / RAWTEXT(script,style) 状态，标签内未命中危险时按原始字节区间原样输出，保留原始空白、属性顺序、引号风格、大小写、doctype、实体写法。\n删除/处理规则：\n1) `<script ...>...</script>` 整段删除（含 src 型、含未闭合则删至 EOF、自闭合 `<script/>` 整段删除）；`</script>` 残留不得出现。\n2) 属性名匹配 `on[a-z0-9_:.-]*`（任意大小写、含 xlink:onload 等命名空间前缀）整条属性删除，保留标签与其他属性。\n3) `srcdoc` 属性整条删除（其值可内嵌 script）。\n4) 危险 URL 属性整条删除：href、src、action、formaction、xlink:href、poster、background、data、cite、longdesc、dynsrc、lowsrc、profile、ping。判定前先做 HTML 实体解码 + 去除 ASCII 空白与 \\x00-\\x1f 控制字符 + 小写化，前缀命中 javascript:/vbscript:/livescript:/mocha:/data:text/html/data:image/svg+xml 即删。必须覆盖 `java\\tscript:`、`&#106;avascript:`、`&#x09;`、`JaVaScRiPt:`、前导空白等变体。\n5) `<meta http-equiv=refresh content=...url=javascript:...>` 整标签删除；`<base href=...>` 整标签删除。\n6) `style` 属性仅在值（解码后）含 expression( / behavior: / -moz-binding / url(javascript: 时删除，良性 `color:red` 必须原样保留。\n7) `<style>` 元素：良性内容原样保留；内容含 expression( / javascript: / -moz-binding 时整元素删除。\n8) 注释 `<!-- -->` 保留，但删除其中的 `<script`、`javascript:` 等危险子串（不改其他注释文本）。\n9) 可见文本节点默认逐字保留；不得静默删除普通文本。输出前若自检发现残留，stderr 打一条 warning，仍写回已清洗内容。\n\n【基础自测（必须真跑并落盘证据，禁止伪造）】\nV1 环境：`python3 -V`、`python3 -c \"import bs4;print(bs4.__version__)\"`、`python3 -m py_compile /app/filter.py` 三条 exit 0。\nV2 良性零改动：造 /tmp/pf/benign.html（doctype、注释、table/thead/tbody/tr/td、h1-h3、ul/li、class/id/data-*、&amp;、&nbsp;、单双引号混用、多空格与换行），先 cp 为 benign.orig，跑一次后 `cmp -s` 必须返回 0（字节完全相同）。\nV3 危险清除矩阵（每项独立文件）：a `<script>alert(1)</script>` 删净且前后文本保留；b `<script src=//x.js></script>`；c `<img src=x onerror=alert(1)>` 保留 src、去 onerror；d `<a href=\"javascript:alert(1)\">t</a>` 去 href 保文本；e `jav&#x09;ascript:` / `&#106;avascript:` / `JaVaScRiPt:` 三例去净；f `<iframe srcdoc=\"<script>...\">` 去 srcdoc；g `<svg onload=...><animate onbegin=...>` 去事件属性且 svg 结构保留；h 危险 meta refresh 整标签消失而良性 meta charset 保留；i `<form action=\"javascript:...\">` 与 formaction 去净；j `<div style=\"color:red\">` 保留；k `<div title=\"a>b\" onclick='x'>` 只删 onclick，title 仍等于 a>b。断言用 python 断言 + grep 双证。\nV4 幂等：V3 全部文件跑第二遍，`cmp` 与第一遍输出一致（0）。\n\n【证据交付】/tmp/pf/logs/ 下按 V1-V4 分文件保存真实命令与输出；末尾在 /tmp/pf/logs/summary-card1.md 写实际命令、exit code、关键输出片段。任何未跑项必须标注「未验证」，不得写成通过。"
dept: 实施
inputs: [".pao/benchmark/工作流实例-基准开发流水线.md"]
constraints: "只处理原始公开任务，不读取 /tests、/solution、oracle 或在线基准答案；不伪造运行结果；所有角色均使用 DeepSeek high。\n只允许新建/修改 /app/filter.py 与 /tmp/pf 下文件；不读 /tests、/solution、oracle 或任何基准答案；不联网、不 pip install、不改系统包、不删 /app 其他文件；不得用 str(soup) 全量重序列化替换原文；所有角色使用 DeepSeek high；预算以现场共享授权为准。"
acceptance: "1) /app/filter.py 存在且 `python3 -m py_compile /app/filter.py` exit 0；`python3 /app/filter.py` 无参数时 exit 2 且 stderr 无 Traceback。\n2) benign 回归：/tmp/pf/benign.orig 与清洗后文件 `cmp -s` 返回 0，日志中有该命令与退出码。\n3) V3 的 a–k 每一项都有独立夹具、真实命令输出与断言结果；危险串（script 标签、on* 属性、javascript: 协议属性、srcdoc、危险 meta refresh、危险 base）在全矩阵 grep 计数为 0；同时表格/标题/列表/普通属性计数与输入一致。\n4) V4 幂等：全部夹具第二遍 cmp 返回 0。\n5) /tmp/pf/logs/ 内 V1–V4 日志与 summary-card1.md 齐全，行内命令可复现；无伪造输出，未跑项标注「未验证」。"
depends_on: []
tier: primary
priority: medium
owner: 主控
attempt: 1
created: "2026-10-21 13:01"
completed: "2026-10-21 13:21"
status: delivered
---

<!-- pao-workflow:流=基准开发流水线/节点=实施 -->
<!-- pao-workflow-v2:实例=86e2c830-6291-46e1-aa32-8c3d55e474eb/轮次=1 -->

## owner记录 2026-10-21 13:01
- 事件: 状态改为 in_progress

## owner记录 2026-10-21 13:05
- 事件: 状态改为 in_progress

## owner记录 2026-10-21 13:06
- 事件: 状态改为 in_progress

## owner记录 2026-10-21 13:10
- 事件: 状态改为 in_progress

## 回执 尝试1 2026-10-21 13:17
- result: success
- summary: "创建 /app/filter.py（593 行，单遍引号感知状态机，未用 str(soup) 重序列化）：整段删 script、事件属性、srcdoc、危险 URL 属性（实体/控制字符/零宽解码后判定）、危险 meta refresh 与 base，良性 style/注释/文本原样保留。\nV1 三条 exit 0；V2 benign cmp=0（字节相同）；V3 a–l 全部独立夹具，67 条 python 断言 0 FAIL + grep 危险串计数全 0、结构计数 1:1；V4 12/12 cmp=0。\n证据落盘 /tmp/pf/logs/（V1–V5 + EXTRA + summary-card1.md），含真实命令、exit code 与输出片段。"
- artifact_path: ["filter.py"]
- evidence: ["/app/.pao/benchmark/worker-evidence/卡0001-尝试1-2439aebd11e6-920c1c58-4a62-46c1-91b6-cb0604525c91.live.jsonl.gz"]
- usage: {"input":75337,"output":72980,"cacheRead":4241920,"cacheWrite":0,"cost":0,"turns":94,"toolCalls":94,"missing_usage_rounds":0,"run_id":"920c1c58-4a62-46c1-91b6-cb0604525c91"}
- 任务态: completed
- verification: [{"条件":"/app/filter.py 存在且 python3 -m py_compile exit 0；无参数 exit 2 且 stderr 无 Traceback","结论":"pass","证据":"logs/V1-env.log: py_compile exit=0，ls -la /app 仅 filter.py；logs/V5-robustness.log: 无参 exit=2、traceback_count=0；不存在路径 exit=1、traceback_count=0"}, {"条件":"benign 回归 cmp -s 返回 0，日志有命令与退出码","结论":"pass","证据":"logs/V2-benign.log: cmp_exit=0，md5 双向 3bdbfe06…，946 字节一致（含 doctype/注释/table/thead/tbody/h1-h3/ul/li/data-*/&amp;/&nbsp;/单双引号/多空格换行）"}, {"条件":"V3 a–k 每项独立夹具+真实输出+断言；危险串全矩阵 grep 计数 0；结构/普通属性计数与输入一致","结论":"pass","证据":"logs/V3-run.log 逐项命令与输出；logs/V3-assert.log 67 PASS / FAILURES: 0 / assert_exit=0；logs/V3-grep.log script·on*·javascript:·vbscript:·livescript:·mocha:·srcdoc·meta refresh·base 全 0，table 1:1/tr 3:3/td 4:4/th 2:2/h1-h3 各 1:1/ul 1:1/li 2:2/p 12:12，良性属性各 1（另加 l 复合夹具，日志见 V3-grep-onattr.log 说明 content= 的 on* 误匹配）"}, {"条件":"V4 全部夹具第二遍 cmp 返回 0","结论":"pass","证据":"logs/V4-idempotent.log: a–l 共 12 条 cmp -s -> 0，idempotency_failures=0"}, {"条件":"/tmp/pf/logs/ 内 V1–V4 日志与 summary-card1.md 齐全、命令可复现、未跑项标注未验证","结论":"pass","证据":"logs/ 含 V1-env/V2-benign/V3-run/V3-assert/V3-grep/V3-grep-onattr/V4-idempotent/V5-robustness + EXTRA-cases/evasion/warning/check/text-perm + summary-card1.md；summary 末节显式列出「未验证：隐藏验收判定方式未知、未读 /tests 与 solution」"}]
- changes: [{"路径":"filter.py","类型":"created","说明":"唯一交付物：HTML JavaScript 清除器，单遍状态机实现，CLI 含主路径与 --check 只读模式"}, {"路径":"/tmp/pf/benign.html","类型":"created","说明":"良性零改动回归夹具"}, {"路径":"/tmp/pf/benign.orig","类型":"created","说明":"benign 原始副本，用于 cmp 比对"}, {"路径":"/tmp/pf/v3/a.in–l.in 与 a.html–l.html","类型":"created","说明":"V3 危险矩阵 12 组夹具（含复合结构夹具 l）"}, {"路径":"/tmp/pf/v3/","类型":"modified","说明":"夹具经 /app/filter.py 跑第一、二遍后为清洗后输出，另外保留 *.pass1 幂等快照"}, {"路径":"/tmp/pf/extra/","类型":"created","说明":"边界夹具：未闭合 script、自闭合 script、良性/危险 style 元素、注释、doctype 实体、命名空间事件、混淆 URL"}, {"路径":"/tmp/pf/v3_assert.py","类型":"created","说明":"V3 python 断言脚本（67 条断言 + 残留扫描 + 结构计数）"}, {"路径":"/tmp/pf/extra_fixtures.py","类型":"created","说明":"边界夹具生成脚本"}, {"路径":"/tmp/pf/latin1.html","类型":"created","说明":"非 UTF-8 字节往返验证夹具"}, {"路径":"/tmp/pf/big.html","类型":"created","说明":"237 KB 大文件性能验证夹具"}, {"路径":"/tmp/pf/empty.html","类型":"created","说明":"0 字节空文件验证夹具"}, {"路径":"/tmp/pf/perm.html","类型":"created","说明":"文件权限 640 保留验证夹具"}, {"路径":"/tmp/pf/checkme.html","类型":"created","说明":"--check 只读模式验证夹具"}, {"路径":"/tmp/pf/unclean.html、unclean.bak","类型":"created","说明":"--check 不安全/干净两种语义验证夹具"}, {"路径":"/tmp/pf/warn.html、warn-quoted.html、warn-unclosed.html、textnode.html、probe.html、dbl.html","类型":"created","说明":"warning 路径、畸形属性名、可见文本保留、逃逸回归探针"}, {"路径":"/tmp/pf/o.txt、o2.txt、e.txt、e2.txt、out.txt、out2.txt、err.txt、err2.txt、tn.out、tn.err、w.out、w.err","类型":"created","说明":"CLI stdout/stderr 捕获临时文件"}, {"路径":"/tmp/pf/logs/","类型":"created","说明":"V1–V5、EXTRA 分项日志与 summary-card1.md（实际命令、exit code、输出片段）"}, {"路径":"/app/__pycache__/","类型":"deleted","说明":"python3 -m py_compile 的解释器副产物，已删除以保证 /app 仅含 filter.py（未改动 /app 其他文件）"}]

## 机械验收 2026-10-21 13:21
- 结论: 全过停人工审
- 尝试: 1
- 人话句 5 条待主控审
- [人话句] "1) /app/filter.py 存在且 `python3 -m py_compile /app/filter.py` exit 0；`python3 /app/filter.py` 无参数时 exit 2 且 stderr 无 Traceback。"
- [人话句] "2) benign 回归：/tmp/pf/benign.orig 与清洗后文件 `cmp -s` 返回 0，日志中有该命令与退出码。"
- [人话句] "3) V3 的 a–k 每一项都有独立夹具、真实命令输出与断言结果；危险串（script 标签、on* 属性、javascript: 协议属性、srcdoc、危险 meta refresh、危险 base）在全矩阵 grep 计数为 0；同时表格/标题/列表/普通属性计数与输入一致。"
- [人话句] "4) V4 幂等：全部夹具第二遍 cmp 返回 0。"
- [人话句] "5) /tmp/pf/logs/ 内 V1–V4 日志与 summary-card1.md 齐全，行内命令可复现；无伪造输出，未跑项标注「未验证」。"

## owner记录 2026-10-21 13:21
- 事件: 状态改为 delivered
- 依据: 尝试1 回执 success，机械验收派生段显示 5 条均为验收人话句、机械条目全过；主控在 /tmp/smoke 独立复跑关键契约：含 script/onerror 的夹具清洗后 script 与 onerror 消失且表格/标题/实体保留；benign 夹具跑后 cmp 与原件字节相同；无参数 exit=2、坏路径 exit=1、stderr 无 Traceback；纯良性事件属性/混淆 javascript（java\t 与 &#x09;）均删净。越界核查因 /app 无 git 且基线快照缺失无法核对，已按「无法核对」记录，未据此定罪；卡面声明产物为 filter.py 一项，/app 下仅 filter.py 存在。
