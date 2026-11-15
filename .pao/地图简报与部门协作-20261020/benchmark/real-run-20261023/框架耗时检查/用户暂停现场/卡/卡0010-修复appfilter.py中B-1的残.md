---
goal: "修复 /app/filter.py 中 B-1 的残余分支：raw-text 元素位于 template/rt/rp 容器内时，其文本节点为 TemplateString/RubyTextString/RubyParenthesisString，被 filter.py:275 的类型判断跳过，导致实体重复转义与输出无界增长；同时修复复审报告 N-2。修复后各类容器连跑两次必须字节一致，且清洗效果无回退。原始任务：创建 Python 脚本 filter.py，接收 HTML 文件路径参数，就地移除其中全部 JavaScript 以防 XSS，尽量保留原有 HTML 结构与格式（仅允许解析带来的规范化），只能使用已安装的 Python 包。"
dept: 实施
inputs: ["/app/filter.py", "/app/.pao/benchmark/复审报告.md"]
constraints: "定点修 B-1 残余，不重构、不放宽清洗口径；不读取 tests、solution、oracle 或在线基准答案；不伪造运行结果；夹具只放 /tmp。\n\n缺陷：raw-text 元素落在 template/rt/rp 等容器内时，其文本不是裸 NavigableString，而是 TemplateString / RubyTextString / RubyParenthesisString。filter.py:275 的 `type(node) is not NavigableString` 把它们整体跳过，于是不转义保护失效，settle 循环每轮放大转义：实测 <template><iframe> 109→145→181→217B，ruby/rt 113→149→185B，template+plaintext 395→719→1043→1367B。\n\n要求：\n- 修法必须覆盖 bs4 所有 NavigableString 子类（建议用 isinstance 并显式排除 Comment/CData/Doctype/ProcessingInstruction/Declaration/PreformattedString 之外的危险类型，或把这三类字符串类型一并纳入保护），并说明为何不会再漏。\n- 修复后 4 类容器（裸挂载、template、rt、rp 与 plaintext 组合）各连跑两次，cmp 必须完全相同。\n- 必须回归确认 template/rt/rp 内的 <script>、on*=、javascript: 载荷仍然被清除（不因不转义而漏清）。\n- 同时修复复审报告 N-2（注释内 on*= 载荷在 ; . / ( , : 或紧邻字母前接时漏删）：注释内载荷判定应能识别 on<name>= 前不是字母数字的常见接续情形；给出保留无害注释与删除真载荷两侧证据。\n\n交付时务必给出每类容器的真实 cmp 输出与字节数，不要只写结论。"
acceptance: "1. 自查：夹具 <template><iframe>a &amp; b</iframe></template> 连跑两次 cmp 相同，且 iframe 文本稳定为 a &amp; b\n2. 自查：<rt>/<rp> 内 raw-text 同场景连跑两次 cmp 相同\n3. 自查：<template> 内 <script>/on*/javascript: 载荷仍被清除（不漏清）\n4. 自查：普通 HTML（doctype/表格/中文/实体/注释/CRLF/BOM）运行后二次运行字节不变"
depends_on: ["卡0009"]
tier: primary
budget: {"toolCalls":120,"turns":120}
priority: high
owner: 主控
attempt: 1
created: "2026-10-23 06:11"
completed: "2026-10-23 06:16"
status: delivered
---

## owner记录 2026-10-23 06:11
- 事件: 状态改为 in_progress

## 回执 尝试1 2026-10-23 06:16
- result: success
- summary: "B-1 残余已修：_mark_raw_text 改用 isinstance(node, NavigableString) 并排除 PreformattedString 家族，覆盖 TemplateString/RubyTextString/RubyParenthesisString/Script/Stylesheet；N-2 已修：注释载荷正则改为 (?<![0-9A-Za-z])on…=。template/rt/rp/template+plaintext 四类连跑两次 cmp 全 IDENTICAL（73/73、77/77、79/79、79/79B），旧版 109→145→181→217B 已消除；无形态回退。"
- artifact_path: ["filter.py", "/app/.pao/benchmark/黑板.md"]
- evidence: ["/app/.pao/benchmark/worker-evidence/卡0010-尝试1-60d4c85f60f5-3b1e7e15-dbc9-4ddc-bc5a-28e8297d80fb.live.jsonl.gz"]
- usage: {"input":44947,"output":29896,"cacheRead":1045376,"cacheWrite":0,"cost":0,"turns":36,"toolCalls":44,"missing_usage_rounds":0,"run_id":"3b1e7e15-dbc9-4ddc-bc5a-28e8297d80fb"}
- 任务态: completed
- verification: [{"条件":"验收1 自查：<template><iframe>a &amp; b</iframe></template> 连跑两次 cmp 相同，iframe 文本稳定为 a &amp; b","结论":"pass","证据":"/tmp/acc: printf '%s' '<html><body><template><iframe>a &amp; b</iframe></template></body></html>' > v1.html; python3 /app/filter.py v1.html; cp v1.html v1.r1; 再跑一次 → v1.r2; cmp v1.r1 v1.r2 → exit=0 IDENTICAL，bytes=73/73；v1.r2 内容 <html><body><template><iframe>a &amp; b</iframe></template></body></html>（文本仍为 a &amp; b）。连跑 3 次尺寸恒定 [73,73,73]；旧实现同夹具 4 次为 [109,145,181,217]（已消除放大）。"}, {"条件":"验收2 自查：<rt>/<rp> 内 raw-text 同场景连跑两次 cmp 相同","结论":"pass","证据":"/tmp/acc: v2rt=<html><body><ruby>漢<rt><iframe>a &amp; b</iframe></rt></ruby></body></html> → cmp v2rt.r1 v2rt.r2 exit=0 IDENTICAL，bytes=77/77；v2rp=<html><body><ruby>漢<rp>(<iframe>a &amp; b</iframe>)</rp></ruby></body></html> → cmp exit=0 IDENTICAL，bytes=79/79。另 /tmp/t1 中 template+plaintext 组合 79/79B IDENTICAL，48 格（17 祖先×iframe/xmp/plaintext）矩阵 fails=0/48，140 组带祖先 fuzz idem_fail=0，200 组字符汤 fuzz idem_fail=0。"}, {"条件":"验收3 自查：<template> 内 <script>/on*/javascript: 载荷仍被清除（不漏清）","结论":"pass","证据":"/tmp/acc v3.html=<template><script>alert(1)</script><img src=x onerror=alert(1)><a href=\"javascript:alert(1)\">x</a><iframe onload=alert(1) srcdoc=\"<script>y</script>\">t &amp; u</iframe></template> → 输出 <html><body><template><img src=\"x\"/><a>x</a><iframe>t &amp; u</iframe></template></body></html>（95B，两次 cmp=IDENTICAL）；bs4 DOM 断言 script_tags=0、on*=0、javascript:=0、字节中无字面 '<script'。另 11 例 template/rt/rp 内载荷矩阵 bad=0/11（含 iframe 内嵌 <script> 被中和为 &lt;script、srcdoc、style behavior、svg onload、jav&#x61;script:）；22 组危险面 DOM 断言 fails=0/22。旧/新实现 26 组危险+良性对比仅 2 处差异且均是真修复（template/rt 内 &amp; 不再放大）。"}, {"条件":"验收4 自查：普通 HTML（doctype/表格/中文/实体/注释/CRLF/BOM）运行后二次运行字节不变","结论":"pass","证据":"/tmp/acc: v4.html（GBK 声明的 doctype+表格+中文+实体+注释 options=1+表单）→ cmp v4.r1 v4.r2 exit=0 IDENTICAL，bytes=261/261，输出 <meta charset=\"utf-8\"/>、注释 <!-- 普通注释 options=1 --> 逐字节保留；CRLF 夹具 69/69B IDENTICAL；BOM 夹具 49/49B IDENTICAL；GBK 中文夹具连跑 2 次 161/161B 不变。另 24 例良性文档 idem fails=0/24；150 组纯良性文档新旧实现 diff=0。"}, {"条件":"N-2：注释内 on*= 载荷在 ; . / ( , : 或紧邻字母前接时不再漏删，同时保留无害注释","结论":"pass","证据":"180 格前缀×载荷矩阵：old_deleted=30 → new_deleted=165，new_missed 仅剩前缀 'x'/'0'/'Z'（字母数字，正是 options=/buttons= 保留条件，旧实现同样不删，非回退）。删除侧：<!--x;onclick=…-->、<!--a.b.onclick=…-->、<!--[if IE]><img/src=x/onerror=…>、<!--[if IE]><svg/onload=…>、<!--;onerror=…>、<!--(onmouseover=…> 全部删除（输出仅 <p>a</p>）。保留侧：<!-- options=1 controls the menu -->、<!-- buttons=3 and icons=4 -->、<!-- lessons=5 persons=6 revision=7 -->、<!-- 中文注释：模板 options=1 -->、<!-- persons: name -->、<!--[if IE]><p>hello</p><![endif]--> 全部逐字节保留。"}, {"条件":"影响面核查：CLI 退出码、就地改写 inode、无法解码字节分支、imports 与编译","结论":"pass","证据":"noarg rc=2、twoarg rc=2、missing rc=1、dir rc=1、正常 rc=0；inode 582330→582330、mode 644→644；不可解码 /tmp/t1/bad.bin 跑后 exit=1 且 cmp 与原始 UNCHANGED；python3 -m py_compile /app/filter.py → COMPILE_OK；未新增 import（仍是 stdlib + bs4）。"}, {"条件":"本次尝试 1 相对认领基线的程序候选改动","结论":"pass","证据":"基线 /app/.pao/benchmark/基线/卡0010-尝试1-基线.json；M __pycache__/filter.cpython-312.pyc、M filter.py"}]
- changes: [{"路径":"filter.py","类型":"modified","说明":"B-1 残余修复：_mark_raw_text 由 type(node) is not NavigableString 改为 not isinstance(node, NavigableString) or isinstance(node, PreformattedString)（覆盖 TemplateString/RubyTextString/RubyParenthesisString/Script/Stylesheet，排除 Comment/CData/Doctype/ProcessingInstruction/Declaration 等标记类）；N-2 修复：_ON_PAYLOAD_RE 由 (?:^|[\\s\"'])on[a-z0-9_:-]+= 改为 (?<![0-9A-Za-z])on[a-z0-9_:-]+=；同步更新 docstring 与注释说明。全文其余逻辑未改，sha256=72ad03cb709bcfeceebd2a39285f5cdb0405d60a8127de2a1791dc74047731f5。"}, {"路径":".pao/benchmark/黑板.md","类型":"modified","说明":"追加一条「filter.py 修复（卡0010 尝试1）」便签：两处根因与修法、180 格前缀矩阵 old_deleted=30→165、四类容器 cmp 真实字节数、48 格矩阵/fuzz/diff 数据、未改的 N-3 记录。"}]

## 机械验收 2026-10-23 06:16
- 结论: 全过停人工审
- 尝试: 1
- 执行根: /app
- 仓库根: /app
- 关联摘要: sha256:57321deb8f4972cfe91920a0e7ca80709d035461c7fcc9a272a671cec8c07dea
- 工作树摘要: sha256:b8bca25f69037306eb624854a6dd04b428d51b20cffb7a2947c297e76349067a
- 输入快照: sha256:2f064a4ee5afc54c3c5b3b2965e9cbd3eae3d280a60391885c22bedfea1c143c
- 简报: pao-brief://brief-card-0010-attempt-1?digest=sha256%3A2ce32bcfa3ccb0b2fb2e2b2583a198adb8791ff04bfc59f0046bb33daa2fd680
- 人话句 4 条待主控审
- [人话句] "1. 自查：夹具 <template><iframe>a &amp; b</iframe></template> 连跑两次 cmp 相同，且 iframe 文本稳定为 a &amp; b"
- [人话句] "2. 自查：<rt>/<rp> 内 raw-text 同场景连跑两次 cmp 相同"
- [人话句] "3. 自查：<template> 内 <script>/on*/javascript: 载荷仍被清除（不漏清）"
- [人话句] "4. 自查：普通 HTML（doctype/表格/中文/实体/注释/CRLF/BOM）运行后二次运行字节不变"

## owner记录 2026-10-23 06:16
- 事件: 状态改为 delivered
- 依据: 主控独立验收卡0010：5 类容器（裸挂载 69B、template 90B、rt 82B、rp 75B、template+plaintext 96B、双层实体 73B）连跑两次全部 IDEM_OK，旧版 109→145→181→217B 的放大已消除；混合夹具确认 template 内 script/onclick/javascript: 与 rt 内 onmouseover 全部清除（残留计数 0），无害注释 options=/buttons= 保留，二次运行 IDEM_OK；普通 HTML diff 仅见 doctype 后空行、void 自闭合、JS 移除三类，class/id/表格/表单/实体/中文/注释均保留。越界一项为 __pycache__ 副产物。
