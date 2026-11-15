---
goal: "加固 /app/filter.py 的危险 URL 判定：使 data:text/javascript、data:application/javascript、data:application/xhtml+xml 等可执行/可承载脚本的 data: 载荷被删除，同时不误删合法媒体 data: URL（图片/字体/音频）。原始任务：创建 Python 脚本 filter.py，接收 HTML 文件路径参数，就地移除其中全部 JavaScript 以防 XSS，尽量保留原有 HTML 结构与格式（仅允许解析带来的规范化），只能使用已安装的 Python 包。"
dept: 实施
inputs: ["/app/filter.py", "/app/.pao/benchmark/终审报告.md"]
constraints: "定点加固，只扩展危险判定，不重构、不放宽其他口径；不读取 tests、solution、oracle 或在线基准答案；不伪造运行结果；夹具只放 /tmp。\n\n依据终审报告 §8 R-1/R-2：现有 _DANGEROUS_SCHEMES 只含 data:text/html 与 data:image/svg+xml，导致\n- <a href=\"data:text/javascript,alert(1)\"> 原样保留\n- <a href=\"data:application/xhtml+xml,<script>1</script>\"> 原样保留（实体转义但仍可解出脚本）\n\n要求：\n- 危险 data: 判定扩展为：文本类/可执行类 MIME 前缀，至少覆盖 data:text/javascript、data:application/javascript、data:application/x-javascript、data:application/ecmascript、data:text/ecmascript、data:application/xhtml+xml，以及现有 data:text/html、data:image/svg+xml。实现建议按类型前缀匹配而非穷举整串，并对 MIME 参数与空白做归一。\n- 合法媒体类型必须保留：data:image/png;base64,…、data:image/jpeg、data:image/gif、data:image/webp、data:font/woff2、data:audio/mpeg、data:text/plain（纯文本非 HTML）等不得误删。给出保留侧证据。\n- 归一化后判定（大小写、实体、控制字符、MIME 参数如 ;charset=utf-8）不得绕过。\n- 修复后必须给出：删除侧每类的真实命令与输出、保留侧每类的真实命令与输出、以及普通文档二次运行 cmp 相同的证据。"
acceptance: "1. 自查：href=\"data:text/javascript,alert(1)\" 运行后该属性被删除\n2. 自查：href=\"data:application/xhtml+xml,<script>1</script>\" 运行后该属性被删除\n3. 自查：合法的 data:image/png;base64 图片属性必须保留（不误删）\n4. 自查：普通 javascript:/vbscript:/data:text/html 清除效果与幂等性不回退"
depends_on: ["卡0011"]
tier: primary
budget: {"toolCalls":90,"turns":90}
priority: high
owner: 主控
attempt: 1
created: "2026-10-23 06:43"
completed: "2026-10-23 06:46"
status: delivered
---

## owner记录 2026-10-23 06:43
- 事件: 状态改为 in_progress

## 回执 尝试1 2026-10-23 06:46
- result: success
- summary: "filter.py 的 data: 危险判定改为按 mediatype 前缀/子类型关键词匹配（text/html、application/xhtml+xml、image/svg+xml、*javascript*、*ecmascript* 等），先剥离 MIME 参数；合法媒体 data:（png/jpeg/gif/webp/font/woff2/audio、text/plain）保留。\n卡面 4 项验收全 pass，37 例删/留矩阵 0 fail，120 组 fuzz 无泄漏且二次运行字节恒等。\n仅改 filter.py，未新增文件，未读取 tests/solution/oracle。"
- artifact_path: ["filter.py"]
- evidence: ["/app/.pao/benchmark/worker-evidence/卡0012-尝试1-e50f4ea07b40-bf87d2f4-7d4f-4f27-bc97-0536e49400e3.live.jsonl.gz", "/app/.pao/benchmark/worker-evidence/卡0012-尝试1-e50f4ea07b40-bf87d2f4-7d4f-4f27-bc97-0536e49400e3.live.jsonl.receipt-format-recovery.json"]
- usage: {"input":26328,"output":19877,"cacheRead":493568,"cacheWrite":0,"cost":0,"turns":27,"toolCalls":32,"missing_usage_rounds":0,"run_id":"bf87d2f4-7d4f-4f27-bc97-0536e49400e3"}
- 任务态: completed
- verification: [{"条件":"验收1：href=\"data:text/javascript,alert(1)\" 运行后该属性被删除","结论":"pass","证据":"printf '<html><body><a href=\"data:text/javascript,alert(1)\">y</a></body></html>' > /tmp/c12/acc/v1.html && python3 /app/filter.py /tmp/c12/acc/v1.html; exit=0; 输出 <html><body><a>y</a></body></html>（href 消失）；另覆盖 data:text/javascript;charset=utf-8、大写 DATA:TEXT/JAVASCRIPT、含空白/制表符、实体混淆 data&colon;text&#47;javascript、src/formaction 载体，全部删除（/tmp/c12/check.py 前 16 例）"}, {"条件":"验收2：href=\"data:application/xhtml+xml,<script>1</script>\" 运行后该属性被删除","结论":"pass","证据":"python3 /app/filter.py /tmp/c12/acc/v2.html; exit=0; 输出 <html><body><a>y</a></body></html>（不再出现转义后的 &lt;script&gt;）；带 ;base64 的 data:application/xhtml+xml 同删"}, {"条件":"验收3：合法 data:image/png;base64 图片属性必须保留（不误删）","结论":"pass","证据":"python3 /app/filter.py /tmp/c12/acc/v3.html; exit=0; 输入输出均为 <img src=\"data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==\"/> 逐字保留；保留侧共 17 例（image/png|jpeg|gif|webp|x-icon、font/woff2、application/font-woff2、audio/mpeg、video/mp4、application/pdf|json、text/plain、text/css、普通相对/https URL、data-* 文本）全 PASS"}, {"条件":"验收4：普通 javascript:/vbscript:/data:text/html 清除效果与幂等性不回退","结论":"pass","证据":"python3 /app/filter.py /tmp/c12/acc/v4.html → <html><body><a>a</a><a>b</a><a>c</a></body></html>（javascript:/vbscript:/data:text/html 各属性全删，exit=0）；再跑一次 cmp acc/v4.once.html acc/v4.html → IDENTICAL；综合文档 /tmp/c12/final/d.html 连跑 3 次 cmp 均 IDENTICAL；120 组 fuzz nonconv_or_leak=0"}, {"条件":"归一化后判定不得被绕过（大小写/实体/控制字符/MIME 参数）","结论":"pass","证据":"check.py 中 DATA:TEXT/JAVASCRIPT、data&colon;text&#47;javascript、\"data:text/ javascript,\\talert(1)\"、data:text/javascript;charset=utf-8、data:text/html;charset=utf-8、data:application/xhtml+xml;base64 全部 ABSENT；直接调用 _is_dangerous_data_url：13 个危险 mediatype 0 miss，27 个合法 mediatype 0 误判（image/avif、font/ttf、audio/ogg、application/zip、空 mediatype 等）"}, {"条件":"不影响既有口径（on*/srcdoc/style/注释/raw-text/CLI 退出码）","结论":"pass","证据":"回归文档含 on* 事件、srcdoc、style expression(javascript:)、危险 <style>、载荷注释、条件注释、template/rt/rp/iframe/xmp/noembed/noframes/plaintext/svg/math 10 例：删除侧全删、无载荷侧逐字保留且两次运行 IDENTICAL（/tmp/c12/reg、/tmp/c12/raw）；CLI 0 参数/2 参数 exit=2、缺失文件 exit=1、正常 exit=0"}, {"条件":"语法健全（py_compile）","结论":"pass","证据":"python3 -c \"import py_compile;py_compile.compile('/app/filter.py',cfile='/tmp/c12/x.pyc',doraise=True)\" → py_compile ok；/app 下无遗留 __pycache__"}, {"条件":"本次尝试 1 相对认领基线的程序候选改动","结论":"pass","证据":"基线 /app/.pao/benchmark/基线/卡0012-尝试1-基线.json；M filter.py"}]
- changes: [{"路径":"filter.py","类型":"modified","说明":"data: 危险判定由整串枚举改为 mediatype 前缀 + 子类型关键词匹配（先剥离 MIME 参数），新增 _DANGEROUS_DATA_MIME / _DANGEROUS_DATA_MIME_KEYWORDS / _DATA_MIME_RE / _DATA_IN_TEXT_RE / _data_mime / _is_dangerous_data_url / _contains_dangerous_data_url；_is_dangerous_url 与 _content_has_dangerous_scheme 接入；docstring 同步口径说明"}]

## 机械验收 2026-10-23 06:46
- 结论: 全过停人工审
- 尝试: 1
- 执行根: /app
- 仓库根: /app
- 关联摘要: sha256:4520336c7d282e66795faab10c5c39bb89caea432a7cd3d2f807801fce823087
- 工作树摘要: sha256:b8bca25f69037306eb624854a6dd04b428d51b20cffb7a2947c297e76349067a
- 输入快照: sha256:962e20b47ce3726a9a8da69cecaa263a754434a8b64303990f98b96fc98dfa68
- 简报: pao-brief://brief-card-0012-attempt-1?digest=sha256%3A31a7b441916dce05e38bdcd13400bd1cca9d90b627284e37ecadb43819ad8ec7
- 人话句 4 条待主控审
- [人话句] "1. 自查：href=\"data:text/javascript,alert(1)\" 运行后该属性被删除"
- [人话句] "2. 自查：href=\"data:application/xhtml+xml,<script>1</script>\" 运行后该属性被删除"
- [人话句] "3. 自查：合法的 data:image/png;base64 图片属性必须保留（不误删）"
- [人话句] "4. 自查：普通 javascript:/vbscript:/data:text/html 清除效果与幂等性不回退"

## owner记录 2026-10-23 06:46
- 事件: 状态改为 delivered
- 依据: 主控独立验收卡0012：删除侧 10 类载荷（data:text/javascript、application/javascript、x-javascript、application/ecmascript、text/ecmascript、application/xhtml+xml、data:text/html、data:image/svg+xml、大写 DATA:TEXT/JAVASCRIPT、带 ;charset 参数、前导空格 javascript:）全部清除，残留计数 0；保留侧 data:image/png/jpeg/gif/webp、font/woff2、audio/mpeg、text/plain 全部保留（img 保留计数 4），diff 仅见 void 自闭合与属性字母序，二次运行 IDEM_OK；越界核查声明与 git 真值相符（仅 filter.py）。
