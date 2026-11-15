---
goal: "新建 /app/filter.py：命令行 `python3 /app/filter.py <file.html>`（argv[1]），原地覆写该 HTML 文件，移除其中全部 JavaScript，同时保证除被删内容外其余字节完全不变（不含任何 JS 的良性 HTML 输入与输出必须逐字节相同）。仅使用 Python 标准库。"
dept: 实施
inputs: []
constraints: "只处理原始公开任务，不读取 /tests、/solution、oracle 或在线基准答案；不伪造运行结果；所有角色使用本轮选定模型与 high。\n边界：\n1. 仓库内只允许新增 /app/filter.py，以及本卡验收所需的三个小文件：filter_test/selftest.py、filter_test/benign.html、filter_test/malicious.html。不得再新增其他仓库文件；除 filter_test/ 内三个文件外，其余一律放 /tmp/filter_test/；不得在 /app 留下 __pycache__ 等残留。\n2. filter_test/benign.html 与 filter_test/malicious.html 必须是未过滤的原始样例（被测时先复制再过滤，不得就地覆盖样例本身）。selftest.py 必须真实生成样例并断言，不得写成永远成功的空壳。\n3. 不得读取 /tests、/solution、oracle 或任何在线参考答案，不得联网。\n4. 只用 Python 标准库；主实现路径不得使用 bs4/lxml/html5lib 等会重排 HTML 的解析器（可仅在自测脚本里做交叉解析）。\n5. 不得对样例内容做硬编码或特判，不得通过“只处理本次输入”等取巧实现。\n6. 不要改变本卡规定的验收口径（尤其“良性输入输出逐字节相同”）。\n\n## 交付物\n- /app/filter.py：可命令行运行的过滤脚本，仅标准库，实现 JS 移除与原地覆写\n- filter_test/selftest.py：真实自测脚本（生成样例、调用 filter.py、断言退出码与字节结果），全部检查通过时退出码 0\n- filter_test/benign.html、filter_test/malicious.html：原始样例（良性无 JS / 含 JS），保持未过滤原样\n- 工人回执中的真实证据：实际执行命令与真实输出（stdout/stderr/退出码）、A–H 逐例结论、“良性样例逐字节相同”的真实通过记录、CLI 错误码的实际退出码、逐条移除口径清单（R1–R9 哪些落地、哪些是显式取舍）、以及明确标注的未验证项清单\n\n## 实施提示\n实现口径（务必逐条落地，并在回执中逐条说明）：\n\nA. 字节级“切除式”扫描器，不用会重排输出的 HTML 解析器。理由：验收要求良性输入输出逐字节相同，bs4/lxml/html5lib 会补 <html><body>、改实体大小写与引号风格。stdlib html.parser 仅可用于自测侧交叉校验，不得作为主输出路径。\n\nB. 全程 bytes：read 全部字节 → 在 bytes 上分词并求出待删除区间 → 直接 open(path,'wb') 写回。这样 BOM、CRLF、非 UTF-8(latin-1) 原样保留，无换行翻译、无编解码往返。仅在判定危险 URL 时把属性值用 latin-1 视图（bytes↔str 一一对应）交给 html.unescape 做实体解码，不改原文。\n\nC. tokenizer 规格：逐个 '<' 位置判定：(a) '<!--' 起注释，找到 '-->'（兼容 '--!>'）为注释跨度；(b) '<!' 起 doctype/伪注释，找到 '>'; (c) '<?' 起处理指令，找到 '>'; (d) '</' 起结束标签，匹配 </[a-zA-Z] 后找 '>'; (e) '<name' 起开始标签：标签名=[^\\s/>]+，随后解析属性直到配对的 '>'（引号内 '>' 不算），识别自闭合 '/'; (f) 其余 '<' 视为普通文本，从 pos+1 继续扫描。属性用 bytes 正则 ([^\\s/>=]+)(?:\\s*=\\s*(?:\\\"[^\\\"]*\\\"|'[^']*'|[^\\s>]*))? 逐个记录【值跨度】与【其前导空白跨度】。\n\nD. 删除属性时必须连同其前导空白一并切除，避免空格残留（<a href=\"x\" > → <a>），这是最易错点。\n\nE. script 元素整块删除（含内容与结束标签）；标签名带命名空间前缀（如 svg:script）同样按 script 处理；若找不到对应 </script（大小写不敏感），按 HTML5 语义删除到文件末尾（<script/> 不自闭合），并在回执中标注这一取舍。\n\nF. 非 script 的原始文本元素（style、textarea、title、iframe、noembed、noframes、xmp）内容按纯文本处理，不在其中解析标签，保留原文；其中 style 内容另做 CSS 清洗。noscript 按普通标记解析（使其中的 <script> 也被删除，安全优先，与浏览器 RAWTEXT 语义的有意偏差需在回执中记录）。\n\nG. 移除口径：\n R1 script 元素整体删除；例外：<script> 带 type 属性且值（去空白小写）属于 {application/json, application/ld+json, text/template, text/x-template} 时保留整块（数据块非 JS，尽量保留）。\n R2 事件属性：属性名小写后匹配 ^on[a-z]（onclick/onerror/onload/onmouseover 等）→ 删除该属性含前导空白；data-on* 等不以 on 开头的保留。\n R3 危险 URL 属性：属性名属 URL 语义集合（href/src/action/formaction/data/poster/background/cite/longdesc/usemap/ping/codebase/classid/archive/manifest/profile，或名字里含 href/src/url/action/uri）且值判定为 javascript:/vbscript:/livescript:/jscript:/ecmascript:/mocha: → 删除整个属性；data: 仅当 MIME 属 text/html、application/xhtml+xml、image/svg+xml、text/javascript、application/javascript 时删除（data:image/png 等安全 data URL 保留）。scheme 判定前必须：html.unescape 实体解码 → 去掉所有 \\x00-\\x20 与 \\x7f 控制/空白 → 小写 → 取首个 ':' 前部分。必须覆盖 &#106;avascript:、&#x6a;avascript:、JAVASCRIPT:、\" javascript:\"、\"java\\tscript:\" 等绕过形式。\n R4 srcdoc 属性整体删除（值是内联 HTML，可含脚本）。\n R5 meta http-equiv=refresh 的 content 属性若含危险 scheme → 删除该 content 属性（保留 <meta http-equiv=\"refresh\">）。\n R6 CSS 清洗（仅在 style 元素内容与 style 属性值内做 token 级删除，其余 CSS 原样保留）：删除含 javascript:/vbscript: 的整个 url( ... ) 调用；删除 expression( ... ) 调用；删除裸露的 javascript:/vbscript: 词元（连冒号一并删）。\n R7 <base href=\"javascript:…\">、<object data=…>、<embed src=…>、<form action=…>、SVG/MathML 的 xlink:href=\"javascript:…\" 由 R3 通用规则覆盖。\n R8 注释内容默认逐字节保留，但注释内若出现 <script …>…</script> 块（IE 条件注释场景）也切除该块。\n R9 可见文本节点逐字节不动，不对正文里的 javascript: 字样做中和（保内容优先）；这一取舍必须在回执中写明。\n\nH. 性能：属性正则要线性可退化，不得用嵌套量词导致灾难性回溯（评测可能有超时约束）。\n\nI. CLI：argv[1] 为唯一必需参数；正常处理退出码 0；缺参数或文件不可读时向 stderr 报错并以非 0 退出码结束；不得依赖解释器特有行为，python 与 python3 均应可运行。\n\nJ. 验收样例（机器会直接跑，必须满足）：\n 1) filter_test/benign.html：不含任何 JavaScript 的良性 HTML，必须含 doctype、表格（table/th/td）、class 与 id 属性、实体 &amp; 与 &#39;、一条 https 链接、一段 style CSS、注释、中文或 emoji、CRLF 换行；被过滤后必须与原文逐字节相同（机器会先复制再过滤并做字节比对）。\n 2) filter_test/malicious.html：必须同时包含 <script> 块、onclick= 事件属性、onerror= 事件属性、值为 javascript: 的 href 属性，并含可保留的文本标记 before 与 after；注意：不要在可见正文里写字面量 javascript:（机器用纯文本子串 “javascript:” 判定是否已清除），也不要出现 description 之类含 script 字样的英文单词，以免干扰判定。机器会先复制再过滤，然后断言复制件里不再含 script 标签、javascript:、onclick、onerror，且 before/after 仍保留。\n 3) filter_test/selftest.py：用标准库真实跑一遍上述两个样例（先复制到临时目录再过滤），并覆盖：属性类绕过（&#106;avascript:、JAVASCRIPT&#58;、带前导空格的 \" javascript:\"）、SVG 内 <svg><script>、CSS 中 url(javascript:)、meta refresh、BOM 与 latin-1 字节保真、幂等（连跑两次字节相同）、畸形输入不崩溃、缺参数与不存在文件返回非 0 退出码；所有断言通过时脚本自身退出码为 0，任一失败时非 0。\n 4) 不要在 filter_test/ 里留下被过滤后的产物（_acc_ 开头的文件是机器生成的，可不管）。\n\nK. 证据要求（回执必须如实给出，不得伪造）：实际执行的命令与其真实输出（stdout/stderr 与退出码）、A–H 逐例结论、“良性样例逐字节相同”的真实通过记录、CLI 错误码的实际退出码、编码样例的字节对比结果，以及明确标注的未验证项。禁止读取 /tests、/solution、oracle 或任何在线答案。"
acceptance: "存在: filter.py\n包含: filter.py::argv\n跑: python3 -c \"compile(open('filter.py').read(),'filter.py','exec')\"\n存在: filter_test/selftest.py\n存在: filter_test/benign.html\n存在: filter_test/malicious.html\n跑: python3 filter_test/selftest.py\n跑: python3 -c \"exec(\\\"import shutil\\nshutil.copyfile('filter_test/benign.html','filter_test/_acc_benign.html')\\\")\"\n跑: python3 filter.py filter_test/_acc_benign.html\n跑: python3 -c \"exec(\\\"import sys\\nsys.exit(0 if open('filter_test/_acc_benign.html','rb').read()==open('filter_test/benign.html','rb').read() else 1)\\\")\"\n跑: python3 -c \"exec(\\\"import shutil\\nshutil.copyfile('filter_test/malicious.html','filter_test/_acc_mal.html')\\\")\"\n跑: python3 filter.py filter_test/_acc_mal.html\n跑: python3 -c \"exec(\\\"import sys\\nlt=bytes([60])\\nt=open('filter_test/_acc_mal.html','rb').read().lower()\\nsys.exit(0 if (lt+b'script') not in t and b'javascript:' not in t and b'onclick' not in t and b'onerror' not in t and b'before' in t and b'after' in t else 1)\\\")\"\n跑: python3 -c \"exec(\\\"import sys\\nlt=bytes([60])\\nt=open('filter_test/malicious.html','rb').read().lower()\\nsys.exit(0 if (lt+b'script') in t and b'javascript:' in t and b'onclick' in t else 1)\\\")\"\n跑: python3 -c \"exec(\\\"import shutil\\nshutil.copyfile('filter_test/_acc_mal.html','filter_test/_acc_mal2.html')\\\")\"\n跑: python3 filter.py filter_test/_acc_mal2.html\n跑: python3 -c \"exec(\\\"import sys\\nsys.exit(0 if open('filter_test/_acc_mal.html','rb').read()==open('filter_test/_acc_mal2.html','rb').read() else 1)\\\")\"\n跑: python3 -c \"exec(\\\"import sys,subprocess\\nr=subprocess.run([sys.executable,'filter.py'],capture_output=True)\\nsys.exit(0 if r.returncode!=0 else 1)\\\")\"\n跑: python3 -c \"exec(\\\"import sys,subprocess\\nr=subprocess.run([sys.executable,'filter.py','no_such_file_zz.html'],capture_output=True)\\nsys.exit(0 if r.returncode!=0 else 1)\\\")\""
depends_on: []
tier: primary
priority: medium
owner: 主控
attempt: 1
created: "2026-10-27 20:57"
status: unclaimed
---

<!-- pao-workflow:流=基准开发流水线/节点=实施 -->
<!-- pao-workflow-v2:实例=7c70bd87-fe07-4edf-aa39-6a2fc175c087/轮次=1 -->

## owner记录 2026-10-27 20:57
- 事件: 状态改为 in_progress

## 回执 尝试1 2026-10-27 21:01
- result: success
- summary: "新建 /app/filter.py（纯标准库、bytes 级切除式扫描器，R1–R9 全部落地）与 filter_test/ 三个文件；机器验收命令逐条真实执行退出码 0，selftest 98 项断言 0 失败，良性样例过滤后 cmp 逐字节相同（exit 0），缺参数退出码 2 / 文件不存在退出码 1。\n显式取舍：未闭合 <script> 按 HTML5 删至文件末尾；noscript 按普通标记解析（其内 <script> 也删）；R9 正文可见文本中的 javascript: 字样不做中和。\n待审：机器对“javascript:”子串的隐藏口径、真实评测 HTML 的具体编码与内容未实测，后续审核由系统另行发起。"
- artifact_path: ["filter.py", "filter_test/selftest.py", "filter_test/benign.html", "filter_test/malicious.html"]
- evidence: ["/app/.pao/benchmark/worker-evidence/卡0001-尝试1-ba18bd117685-0f8a8df0-895a-4c11-8669-b2b53a8861ee.live.jsonl.gz", "/app/.pao/benchmark/worker-evidence/卡0001-尝试1-ba18bd117685-0f8a8df0-895a-4c11-8669-b2b53a8861ee.live.jsonl.receipt-format-recovery.json"]
- usage: {"input":62098,"output":44917,"cacheRead":1390630,"cacheWrite":0,"cost":0,"turns":32,"toolCalls":33,"missing_usage_rounds":0,"run_id":"0f8a8df0-895a-4c11-8669-b2b53a8861ee"}
- verification: [{"条件":"存在 /app/filter.py 且含 argv 处理","结论":"pass","证据":"ls: /app/filter.py（581 行）；grep -c argv filter.py → 6；python3 -c \"compile(open('filter.py').read(),'filter.py','exec')\" → exit 0"}, {"条件":"存在 filter_test/selftest.py、benign.html、malicious.html 三个原始样例文件","结论":"pass","证据":"ls -l filter_test/ → selftest.py 14618B、benign.html 899B、malicious.html 507B；样例未被就地覆盖（selftest 断言 A3/J8 PASS）"}, {"条件":"python3 filter_test/selftest.py 全部断言通过且退出码 0","结论":"pass","证据":"实跑输出 '98 checks, 0 failures'，退出码 0（覆盖 A 良性字节相同/B script/C 属性绕过/D SVG/E CSS+meta/F 编码/G 幂等/H 畸形/CLI 错误码）"}, {"条件":"良性样例过滤后与原文逐字节相同（机器口径 cmp）","结论":"pass","证据":"复制 _acc_benign.html → python3 filter.py 退出码 0 → cmp -s _acc_benign.html benign.html 退出码 0；机器命令 sys.exit(0 if ...==... else 1) 退出码 0；另测含 DOCTYPE 内部子集/媒体查询/引号 url() 的扩展良性文档亦逐字节相同"}, {"条件":"恶意样例过滤后不含 <script/javascript:/onclick/onerror 且保留 before/after","结论":"pass","证据":"机器断言脚本退出码 0；实测输出保留 <!DOCTYPE html>、<style>、<p>before</p>、<p>after</p>，script/onclick/onerror/href=javascript: 全部切除"}, {"条件":"原始 malicious.html 仍含 <script、javascript:、onclick（未被就地改写）","结论":"pass","证据":"机器断言脚本退出码 0；selftest J0 各项 PASS，J8 校验样例字节未被修改"}, {"条件":"幂等：同一文件连跑两次输出逐字节相同","结论":"pass","证据":"_acc_mal.html 与 _acc_mal2.html cmp 退出码 0；selftest G1 PASS"}, {"条件":"缺参数与不存在文件返回非 0 退出码并写 stderr","结论":"pass","证据":"python3 filter.py → stderr 'usage: filter.py <file.html>'，退出码 2；python3 filter.py no_such_file_zz.html → stderr 'cannot process ... No such file or directory'，退出码 1；目录参数退出码 1；机器两条断言退出码 0"}, {"条件":"python 与 python3 两个解释器均可运行","结论":"pass","证据":"python filter.py <file> 退出码 0；python filter_test/selftest.py 退出码 0"}, {"条件":"仅用标准库、主路径不使用会重排 HTML 的解析器","结论":"pass","证据":"filter.py 仅 import html/re/sys；无 bs4/lxml/html5lib"}, {"条件":"性能线性可退化、无灾难性回溯","结论":"pass","证据":"9.9MB 文档 2.08s；压力用例 many_lt 2MB1.25s、long_attr 1MB 0.10s、unterminated_tag 0.31s、nested_parens_css 0.19s、many_attrs 1.4MB 0.58s，均 rc=0"}, {"条件":"仓库洁净：仅新增 4 个文件，无 __pycache__/_acc_ 残留","结论":"pass","证据":"git status --short → ?? filter.py ?? filter_test/（.pao/ 为认领前 harness 目录）；find 无 __pycache__/*.pyc；已删除自测产生的 _acc_* 文件"}, {"条件":"评测机真实输入 HTML 的内容/编码未知、隐藏的 javascript: 子串口径未知","结论":"not_run","证据":"卡面未提供评测输入，无法在本地复现；已按通用 HTML + R9 取舍实现并记录待审"}, {"条件":"本次尝试 1 相对认领基线的程序候选改动","结论":"pass","证据":"基线 /app/.pao/benchmark/基线/卡0001-尝试1-基线.json；?? filter_test/benign.html、?? filter_test/malicious.html、?? filter_test/selftest.py、?? filter.py"}]
- changes: [{"路径":"filter.py","类型":"created","说明":"新建：bytes 级切除式 HTML 过滤器，CLI `python3 filter.py <file.html>` 原地覆写；实现 R1–R9（script 整块删除含 svg:script 与未闭合删至 EOF、事件属性、危险 URL scheme 实体/控制字符绕过、srcdoc、meta refresh、CSS 清洗、注释内 script、文本节点不动）"}, {"路径":"filter_test/selftest.py","类型":"created","说明":"新建：真实自测脚本，构造 98 项断言样例，调用 filter.py 子进程校验退出码与字节结果，全部通过退出 0"}, {"路径":"filter_test/benign.html","类型":"created","说明":"新建：未过滤原始良性样例（doctype、table/th/td、class/id、&amp; 与 &#39;、https 链接、style CSS、注释、中文与 emoji、CRLF），过滤后逐字节不变"}, {"路径":"filter_test/malicious.html","类型":"created","说明":"新建：未过滤原始恶意样例（script 块、onclick、onerror、href=javascript:，可见文本含 before/after），过滤后按机器口径检不出"}, {"路径":".pao/benchmark/黑板.md","类型":"modified","说明":"仅追加一条过程便签（实现结论与两个易错点），非交付物、非仓库产品文件"}]

## 机械验收 2026-10-27 21:01
- 结论: 未过
- 尝试: 1
- 执行根: /app
- 仓库根: /app
- 关联摘要: sha256:54218fa7006856655541b5f31f88b34c14fdcfb2e8d88bad63d0a02f2069ab63
- 工作树摘要: sha256:45e9e1b1fad4bf211ccf505efa712447137e63485abec1583f7539b365e437d4
- 输入快照: sha256:37566bf096cfd7517834324a131f7875066c017236ebc02f26c09c06a66612db
- 简报: pao-brief://brief-card-0001-attempt-1?digest=sha256%3Aa31745871e128a2ba3a707382fb547a3dea73f186825e68ecb5ddfc0ba9021b4
- 基线 tree: 4b825dc642cb6eb9a060e54bf8d69288fbee4904
- 检查前 tree: c6c5a8bc23ba80728cb5b044e67495de958ad588
- 检查后 tree: c6c5a8bc23ba80728cb5b044e67495de958ad588
- 检查前 HEAD: 9ca607fb04ba8235dd4244f95630023e04665697
- 检查后 HEAD: 9ca607fb04ba8235dd4244f95630023e04665697
- 检查后内容摘要: sha256:04604dcd975f07f647d1d2369bc2ccbdacdec3593790cef43dd70b1911f7f54f
- [自报复核] #12 评测机真实输入 HTML 的内容/编码未知、隐藏的 javascript: 子串口径未知 → not_run（卡面未提供评测输入，无法在本地复现；已按通用 HTML + R9 取舍实现并记录待审）
- [存在] filter.py → 过（路径存在（项目根 /app；实际路径 /app/filter.py））
- [包含] filter.py :: argv → 过（找到目标文本（项目根 /app；实际路径 /app/filter.py））
- [跑] python3 -c "compile(open('filter.py').read(),'filter.py','exec')" → 过（exit 0）
- [存在] filter_test/selftest.py → 过（路径存在（项目根 /app；实际路径 /app/filter_test/selftest.py））
- [存在] filter_test/benign.html → 过（路径存在（项目根 /app；实际路径 /app/filter_test/benign.html））
- [存在] filter_test/malicious.html → 过（路径存在（项目根 /app；实际路径 /app/filter_test/malicious.html））
- [跑] python3 filter_test/selftest.py → 过（exit 0）
- [跑] python3 -c "exec(\"import shutil\nshutil.copyfile('filter_test/benign.html','filter_test/_acc_benign.html')\")" → 未过（exit 1：File "<string>", line 1
    exec(\
        ^
SyntaxError: '(' was never closed）
- [跑] python3 filter.py filter_test/_acc_benign.html → 未过（exit 1：filter.py: cannot process filter_test/_acc_benign.html: [Errno 2] No such file or directory: 'filter_test/_acc_benign.html'）
- [跑] python3 -c "exec(\"import sys\nsys.exit(0 if open('filter_test/_acc_benign.html','rb').read()==open('filter_test/benign.html','rb').read() else 1)\")" → 未过（exit 1：File "<string>", line 1
    exec(\
        ^
SyntaxError: '(' was never closed）
- [跑] python3 -c "exec(\"import shutil\nshutil.copyfile('filter_test/malicious.html','filter_test/_acc_mal.html')\")" → 未过（exit 1：File "<string>", line 1
    exec(\
        ^
SyntaxError: '(' was never closed）
- [跑] python3 filter.py filter_test/_acc_mal.html → 未过（exit 1：filter.py: cannot process filter_test/_acc_mal.html: [Errno 2] No such file or directory: 'filter_test/_acc_mal.html'）
- [跑] python3 -c "exec(\"import sys\nlt=bytes([60])\nt=open('filter_test/_acc_mal.html','rb').read().lower()\nsys.exit(0 if (lt+b'script') not in t and b'javascript:' not in t and b'onclick' not in t and b'onerror' not in t and b'before' in t and b'after' in t else 1)\")" → 未过（exit 1：File "<string>", line 1
    exec(\
        ^
SyntaxError: '(' was never closed）
- [跑] python3 -c "exec(\"import sys\nlt=bytes([60])\nt=open('filter_test/malicious.html','rb').read().lower()\nsys.exit(0 if (lt+b'script') in t and b'javascript:' in t and b'onclick' in t else 1)\")" → 未过（exit 1：File "<string>", line 1
    exec(\
        ^
SyntaxError: '(' was never closed）
- [跑] python3 -c "exec(\"import shutil\nshutil.copyfile('filter_test/_acc_mal.html','filter_test/_acc_mal2.html')\")" → 未过（exit 1：File "<string>", line 1
    exec(\
        ^
SyntaxError: '(' was never closed）
- [跑] python3 filter.py filter_test/_acc_mal2.html → 未过（exit 1：filter.py: cannot process filter_test/_acc_mal2.html: [Errno 2] No such file or directory: 'filter_test/_acc_mal2.html'）
- [跑] python3 -c "exec(\"import sys\nsys.exit(0 if open('filter_test/_acc_mal.html','rb').read()==open('filter_test/_acc_mal2.html','rb').read() else 1)\")" → 未过（exit 1：File "<string>", line 1
    exec(\
        ^
SyntaxError: '(' was never closed）
- [跑] python3 -c "exec(\"import sys,subprocess\nr=subprocess.run([sys.executable,'filter.py'],capture_output=True)\nsys.exit(0 if r.returncode!=0 else 1)\")" → 未过（exit 1：File "<string>", line 1
    exec(\
        ^
SyntaxError: '(' was never closed）
- [跑] python3 -c "exec(\"import sys,subprocess\nr=subprocess.run([sys.executable,'filter.py','no_such_file_zz.html'],capture_output=True)\nsys.exit(0 if r.returncode!=0 else 1)\")" → 未过（exit 1：File "<string>", line 1
    exec(\
        ^
SyntaxError: '(' was never closed）
- 沙箱: 保留于 /tmp/pao-验收沙箱/保留/app-f419dd94-9eff-40bf-b30d-72fd92d99dbd-卡0001-沙箱

## owner记录 2026-10-27 21:01
- 事件: 状态改为 failed
- 失败类型: unknown_outcome
- 依据: 机械验收未过：机械验收 12/19 条未过，输出结构化结果留 owner

## owner记录 2026-10-27 21:01
- 事件: 状态改为 unclaimed
- 依据: 第1轮机械验收 12/19 未过，逐条核对判定：失败根因是验收命令定义自身的转义缺陷，不是交付物缺陷，因此不作为质量失败终局，转为 attempt 2 重试。

证据核对（对照卡面机械验收段原文）：
1. 9 条报 `File "<string>", line 1  exec(\  SyntaxError: '(' was never closed` 的项，命令形如 `python3 -c "exec(\"import shutil\n...\")"`，嵌套双引号/反斜杠在验收器中被截断为 `exec(\`，命令在 Python 解析阶段即失败，从未调用到 filter.py。同组的 `python3 -c "compile(open('filter.py').read(),'filter.py','exec')"` 通过，证明验收器可处理"外层双引号 + 内层单引号"，不可处理嵌套双引号转义。
2. 3 条 `python3 filter.py filter_test/_acc_benign.html` / `_acc_mal.html` / `_acc_mal2.html` 的 "No such file or directory" 是复制命令失败后的连锁（复制件从未生成），非 filter.py 行为异常。
3. 唯一 not_run 项（评测机真实输入 HTML 未知）本轮仍属外部不可得输入，继续显式标注为未验证项。

attempt 2 要求（写入卡审计区）：
- 修正验收命令口径：所有 `python3 -c` 一律用"外层双引号 + 内层单引号"且不用 exec 包裹，例如 `python3 -c "import shutil; shutil.copyfile('filter_test/benign.html','filter_test/_acc_benign.html')"`、`python3 -c "import sys; sys.exit(0 if open('filter_test/_acc_benign.html','rb').read()==open('filter_test/benign.html','rb').read() else 1)"`；多行逻辑改单行分号，或写入 /tmp 下临时 .py 后 `python3 /tmp/xxx.py` 调用，避免任何嵌套转义。验收口径实质（良性逐字节相同、恶意剔除 script/javascript:/onclick/onerror 且保留 before/after、幂等、CLI 非零退出码）不得放宽。
- 修正后原样重跑全部 19 条，逐条给出真实退出码与 stdout/stderr，不复用上一轮结论。
- 交付物本身（/app/filter.py、filter_test/selftest.py、filter_test/benign.html、filter_test/malicious.html）保持现状；仅在真实跑出缺陷时才允许改动，改动需给出 diff 说明。
- 旧卡尝试1保留不动，新尝试独立留证。
