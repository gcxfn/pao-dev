---
goal: "在卡1产物 /app/filter.py 基础上做健壮性与边界硬化，并补齐结构/文本保留验证。可修复卡1暴露的缺陷，但不得回归卡1已通过的 benign 零改动与危险清除矩阵。\n\n【必须覆盖的边界与修复】\n1) 编码：非 UTF-8 高位字节（latin-1 样例）文件除风险串外字节保持；非法 UTF-8 序列不抛异常、不丢内容；带 BOM 的 UTF-8 不产生多余 BOM 或丢 BOM（行为需在报告中写明）。\n2) 空文件 0 字节 → exit 0 且仍为 0 字节；仅空白文件保持字节不变。\n3) 大小写与畸形标记：`<SCRIPT>`、`<ScRiPt SrC=x>`、`</SCRIPT >`、未闭合 script、`<scr<script>ipt>`、属性无引号 `<img src=x onerror=alert(1)>`、属性值含 `>`（如 title=\"a>b\"）、单引号/双引号/混合、注释中的 `<script>` 与 `javascript:`。\n4) 危险 URL 进一步变体：`java\\nscript:`、`\\x00javascript:`、`javascript&#58;`、`&#x6a;avascript:`、`data:text/html;base64,...`、`vbscript:`、`xlink:href=\"javascript:...\"`、`<object data=\"javascript:...\">` / `<embed src=\"javascript:...\">`。\n5) 结构塌陷防护：删除危险属性时不得残留空引号、孤立 `=`、双空格导致标签解析异常；删除 script 元素时不得吞掉其后兄弟元素或闭合标签。\n6) 性能与规模：生成约 2MB、含 1000 个 script 的文件，单次运行用 `time` 记录，要求 < 5s 且 exit 0，输出中无 script 残留。\n7) 错误路径复核：不存在路径 exit 1；无参数 exit 2；stderr 均无 Traceback。\n\n【结构/文本保留验证（bs4 只读校验，不参与写出）】\n对卡1 V3 全部夹具与新增夹具，用 bs4(html.parser) 解析输入与输出，断言：\n- 输出中无 script 标签、无 attr 名以 on 开头、无 srcdoc、无属性值解码后命中危险协议、无危险 meta refresh 与 base href；\n- table/tr/td/th/h1-h3/ul/li/p 标签计数与输入一致（被删 script 内的标签除外，需在报告中说明差异来源）；\n- 可见文本 get_text() 的差集恰为被删 script/style 文本，不出现普通文本丢失。\n\n【证据交付】/tmp/pf/logs/card2/ 保存每个用例的命令、退出码、cmp/grep/断言输出；/tmp/pf/logs/summary-card2.md 汇总「用例 → 命令 → 结果」，并列出仍未验证项。"
dept: 实施
inputs: [".pao/benchmark/工作流实例-基准开发流水线.md", "/app/filter.py"]
constraints: "只处理原始公开任务，不读取 /tests、/solution、oracle 或在线基准答案；不伪造运行结果；所有角色均使用 DeepSeek high。\n仅修改 /app/filter.py 与 /tmp/pf 下文件；严禁读 /tests、/solution、oracle 或基准答案；严禁联网与 pip install；不得为通过用例而删改夹具期望值；不得回归卡1已通过的 benign 零改动（良性输入字节必须保持一致）；所有角色使用 DeepSeek high。"
acceptance: "1) 上述 1–7 每项都有真实夹具文件与命令日志；性能用例贴出 `time` 输出与实测耗时。\n2) 非 UTF-8 与非法 UTF-8 用例：除被删风险串外 `cmp` 一致，且无异常/无内容截断。\n3) 畸形标记与 URL 变体用例：`grep -c` 危险串为 0，同时良性兄弟节点与属性（src/title/class/data-*）仍在，bs4 可正常解析且断言全过。\n4) 结构计数与文本差集断言全过，日志中贴出实际计数数字。\n5) 卡1 的 benign `cmp -s` 与 V3 矩阵复跑仍全过（回归证据）。\n6) summary-card2.md 中所有通过项均有对应日志文件路径；未跑/未验证项显式标注。"
depends_on: ["卡0001"]
tier: primary
priority: medium
owner: 主控
attempt: 1
created: "2026-10-21 13:01"
completed: "2026-10-21 14:06"
status: delivered
---

<!-- pao-workflow:流=基准开发流水线/节点=实施 -->
<!-- pao-workflow-v2:实例=86e2c830-6291-46e1-aa32-8c3d55e474eb/轮次=1 -->

## owner记录 2026-10-21 13:21
- 事件: 状态改为 in_progress

## 回执 尝试1 2026-10-21 13:52
- result: success
- summary: "卡2 硬化完成：filter.py 修复 </scriptx> 提前闭合、<scr<script>ipt> bogus 标签、未引号 java\\nscript:、控制字符/畸形标签名、属性删后标签塌陷、CSS 注释/转义混淆、<?…?> 危险 PI；新增 42 夹具全部 PASS（run-cases 204 PASS/0 FAIL，struct-text 69 PASS/0 FAIL + 47 幂等 cmp=0，全程 grep 危险串 0、良性标记 0 缺失）。\n编码三态字节级验证：latin-1/非法 UTF-8 走 surrogateescape 除风险串外逐字节相同，BOM 恰好 1 个不增不减；空文件仍 0 字节、仅空白字节不变；2.1MB/1000 script 实测 1.02s（bash time 1.00s）< 5s 且无残留；无参 exit 2、不存在/目录/读失败 exit 1 均无 Traceback。\n卡1 零回归：benign.orig cmp=0（md5 一致）、V3 a–l 与 pass1 12/12 cmp=0、卡1 EXTRA 10/10 SAME、卡1 断言脚本 FAILURES: 0；未验证项已在 summary 第 11 节如实标注。"
- artifact_path: ["filter.py", "/tmp/pf/logs/summary-card2.md", "/tmp/pf/logs/card2/run-cases.log", "/tmp/pf/logs/card2/struct-text.log", "/tmp/pf/logs/card2/grep-per-case.log", "/tmp/pf/logs/card2/perf-2mb.log", "/tmp/pf/logs/card2/perf-2mb-bashtime.log", "/tmp/pf/logs/card2/cli-error-paths.log", "/tmp/pf/logs/card2/benign-corpus.log", "/tmp/pf/logs/card2/regress-card1.log", "/tmp/pf/logs/card2/regress-v3-assert.log", "/tmp/pf/logs/card2/regress-extra-vs-card1.log", "/tmp/pf/logs/card2/perm-mode.log", "/tmp/pf/logs/card2/fuzz.log", "/tmp/pf/logs/card2/probe-text-preserved.log", "/tmp/pf/card2/run_all.sh"]
- evidence: ["/app/.pao/benchmark/worker-evidence/卡0002-尝试1-a515d7691ca3-e8682f7b-0065-4a0b-a8f6-63e11806e295.live.jsonl.gz"]
- usage: {"input":143286,"output":161269,"cacheRead":15476992,"cacheWrite":0,"cost":0,"turns":191,"toolCalls":194,"missing_usage_rounds":0,"run_id":"e8682f7b-0065-4a0b-a8f6-63e11806e295"}
- 任务态: completed
- verification: [{"条件":"1) 7 项边界（编码/空文件/畸形标记/URL 变体/结构塌陷/性能/错误路径）各有真实夹具与命令日志，性能贴出 time 输出","结论":"pass","证据":"/tmp/pf/logs/card2/run-cases.log（47 例逐项命令+exit）、perf-2mb.log（wall_clock_seconds=1.017<5s）、perf-2mb-bashtime.log（real=0.999）、cli-error-paths.log"}, {"条件":"2) 非 UTF-8 与非法 UTF-8 用例：除被删风险串外 cmp 一致，且无异常/无内容截断","结论":"pass","证据":"perm-mode.log: enc-latin1/enc-invalid-utf8 均 byte_exact_except_removed_script=True，高位与非法字节逐段 preserved=True；enc-bom bom_count_in=1 bom_count_out=1"}, {"条件":"3) 畸形标记与 URL 变体：grep -c 危险串为 0，良性兄弟节点与属性（src/title/class/data-*）仍在，bs4 可正常解析且断言全过","结论":"pass","证据":"grep-per-case.log total_danger_hits=0 / missing_benign_markers=0（62 输出文件逐例 DANGER/BENIGN）；run-cases.log 每例 [armed] script=0 on*=0 srcdoc=0 danger_url=0 meta/base=0"}, {"条件":"4) 结构计数与文本差集断言全过，日志贴出实际计数数字","结论":"pass","证据":"run-cases.log 每例打印 in=/out=/skipped-in-removed=；struct-text.log 69 PASS/0 FAIL（24 例）；runner 断言 get_text() 差集==被删 script/style token"}, {"条件":"5) 卡1 benign cmp -s 与 V3 矩阵复跑仍全过（回归证据）","结论":"pass","证据":"benign-corpus.log cmp_exit=0 md5 3bdbfe06…（双向）；regress-card1.log V3 a–l 12/12 cmp_vs_card1_pass1=0；regress-v3-assert.log FAILURES: 0；regress-extra-vs-card1.log extra_diffs=0/10"}, {"条件":"6) summary-card2.md 中所有通过项均有对应日志文件路径；未跑/未验证项显式标注","结论":"pass","证据":"/tmp/pf/logs/summary-card2.md 第 1–12 节逐条挂日志名，第 11 节列出 EACCES/浏览器语义/隐藏验收 not_run 及 EXTRA 日志拼接澄清"}]
- changes: [{"路径":"filter.py","类型":"modified","说明":"卡2 硬化：_END_SCRIPT_RE/_END_STYLE_RE 加 (?=[\\s/>]) 前瞻防 </scriptx> 提前闭合；新增 _find_bogus 丢弃 <scr<script>ipt> 类 bogus 标签语法（start/end tag 双路径）；_parse_tag 对未引号 URL 值在危险 scheme 严格前缀时吸收空白 token；新增 _clean_name/_tag_is 折叠控制字符后判定 script/style；_rebuild_tag 改为每属性前单空格+立即闭合并修掉截断标签凭空补 '>'；新增 _css_unescape/_normalize_css 处理 expr/*x*/ession( 与 CSS 转义；<?…?> 含危险子串整节点删除；删除 _parse_tag 中未使用的 tok_start 变量（593→755 行）"}, {"路径":"/tmp/pf/card2/fixtures.py","类型":"created","说明":"卡2 夹具生成器：编码三态（latin-1/非法 UTF-8/BOM）、空/空白、大小写+畸形标记 9 组、URL 变体 10 组、结构塌陷 10 组、CSS 混淆/PI 6 组、2.1MB·1000 script 性能夹具、probes/ 散文探针"}, {"路径":"/tmp/pf/card2/runner.py","类型":"created","说明":"卡2 主驱动：逐例运行 filter.py、记录命令/exit/耗时，bs4 只读断言（无 script、无 on*、无 srcdoc、无危险协议、无危险 meta/base、结构计数、文本差集 token 多重集、属性包含性、标签卫生断言）"}, {"路径":"/tmp/pf/card2/check_extra.py","类型":"created","说明":"对卡1 V3 a–l + EXTRA 10 + benign 共 24 例复跑同一套 bs4 结构/文本断言，并对 47 个输出做第二遍幂等 cmp"}, {"路径":"/tmp/pf/card2/perf.py","类型":"created","说明":"2MB/1000 script 性能用例：perf_counter 计时 + 残留/结构计数 + 10 条 PASS/FAIL 断言"}, {"路径":"/tmp/pf/card2/grep_cases.py","类型":"created","说明":"逐例 grep 双证：62 个输出文件的 10 类危险 token 计数与 20+ 组良性标记在场检查"}, {"路径":"/tmp/pf/card2/fuzz.py","类型":"created","说明":"300 例畸形 token 汤不崩（exit 0/无 Traceback）+ 200 例随机 benign 文档字节恒等"}, {"路径":"/tmp/pf/card2/probe_text.py","类型":"created","说明":"可见散文含 javascript: 字面量必须保留的探针（规则 9），显式排除在全 corpus grep 之外"}, {"路径":"/tmp/pf/card2/enc_probe.py","类型":"created","说明":"三份编码夹具的解码路径判定与 byte_exact_except_removed_script 证明"}, {"路径":"/tmp/pf/card2/run_all.sh","类型":"created","说明":"15 步整包复跑脚本：一条命令重生成全部夹具与 /tmp/pf/logs/card2/ 下全部日志，末尾清理 /app/__pycache__ 并打印 /app 列表"}, {"路径":"/tmp/pf/logs/summary-card2.md","类型":"created","说明":"卡2 汇总报告：用例→命令→结果、BOM/非 UTF-8 行为说明、结构计数差异来源说明、卡1 不回归证据、8 项硬化改动、5 项未验证如实标注、日志清单"}, {"路径":"/tmp/pf/logs/card2/","类型":"created","说明":"22 份证据日志：env/fixtures/run-cases/run-cases.failures/struct-text/benign-corpus/regress-card1/regress-v3-assert/regress-extra-vs-card1/cli-error-paths/perf-2mb/perf-2mb-bashtime/perm-mode/grep-residue/grep-per-case/fuzz/probe-text-preserved + 4 份驱动 stdout + _run_all.console"}, {"路径":"/tmp/pf/card2/cases/","类型":"created","说明":"42 份卡2 夹具（bytes 级），含 enc-*/empty/blank/case-*/attr-*/comment-*/url-*/struct-*/css-*/pi-*/benign-*/perf-big"}, {"路径":"/tmp/pf/card2/work/","类型":"created","说明":"逐例清洗后输出（62 份），供 grep 双证与幂等复跑"}, {"路径":"/tmp/pf/card2/work2/","类型":"created","说明":"check_extra.py 的卡1 夹具复跑输出"}, {"路径":"/tmp/pf/card2/work-extra/","类型":"created","说明":"卡1 EXTRA 10 例复跑输出，用于与 EXTRA-cases.log 历史记录比对"}, {"路径":"/tmp/pf/card2/work-probe/","类型":"created","说明":"散文探针输出"}, {"路径":"/tmp/pf/card2/probes/","类型":"created","说明":"text-prose.html 散文探针夹具（单独存放，避免污染全 corpus grep）"}, {"路径":"/tmp/pf/card2/fuzz/","类型":"created","说明":"fuzz 输入/输出 500 份临时文件"}, {"路径":"/tmp/pf/card2/err/","类型":"created","说明":"CLI 错误路径的 stdout/stderr 捕获与 --check 探针文件"}]

## 机械验收 2026-10-21 14:06
- 结论: 全过停人工审
- 尝试: 1
- 人话句 6 条待主控审
- [人话句] "1) 上述 1–7 每项都有真实夹具文件与命令日志；性能用例贴出 `time` 输出与实测耗时。"
- [人话句] "2) 非 UTF-8 与非法 UTF-8 用例：除被删风险串外 `cmp` 一致，且无异常/无内容截断。"
- [人话句] "3) 畸形标记与 URL 变体用例：`grep -c` 危险串为 0，同时良性兄弟节点与属性（src/title/class/data-*）仍在，bs4 可正常解析且断言全过。"
- [人话句] "4) 结构计数与文本差集断言全过，日志中贴出实际计数数字。"
- [人话句] "5) 卡1 的 benign `cmp -s` 与 V3 矩阵复跑仍全过（回归证据）。"
- [人话句] "6) summary-card2.md 中所有通过项均有对应日志文件路径；未跑/未验证项显式标注。"

## owner记录 2026-10-21 14:06
- 事件: 状态改为 delivered
- 依据: 尝试1 回执 success，机械验收派生段 6 条人话句均无败；主控核验：卡2 日志文件均真实存在（summary-card2.md、run-cases.log 204 PASS/0 FAIL、struct-text.log、perf-2mb.log wall_clock_seconds=1.017<5s、grep-per-case.log total_danger_hits=0 与 missing_benign_markers=0、benign-corpus/regress-card1/fuzz 均在）。主控另在 /tmp/smoke 独立复跑：benign 文件跑后 cmp 与原件一致；py_compile exit 0；无参数 exit=2；大写 <SCRIPT> 与未引号 ONERROR 夹具清洗后无残留、正文 <p>x</p> 保留。越界核查因无 git/基线缺失无法核对，按无法核对记录，不据此定罪。
