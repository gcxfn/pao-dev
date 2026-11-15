---
goal: "修复 /app/filter.py 的两处审核缺陷：B-1 raw-text 元素（iframe/xmp/noembed/noframes/plaintext）实体重复转义导致非幂等与格式破坏；B-2 无害注释因 on...= 裸子串误删。修复后保持既有清洗效果不回退。原始任务：创建 Python 脚本 filter.py，接收 HTML 文件路径参数，就地移除其中全部 JavaScript 以防 XSS，尽量保留原有 HTML 结构与格式（仅允许解析带来的规范化），只能使用已安装的 Python 包。"
dept: 实施
inputs: ["/app/.pao/benchmark/审核报告.md", "/app/filter.py"]
constraints: "只修两处缺陷，不重构、不放宽清洗口径；不读取 tests、solution、oracle 或在线基准答案；不伪造运行结果；夹具只放 /tmp。\n\n缺陷 B-1（阻断，必须修）：raw-text 元素 iframe/xmp/noembed/noframes/plaintext 的文本含 & 或实体时，str(soup) 会再次转义，且 filter_html 的 settle 循环每轮把转义放大，导致输出字节无界增长、非幂等。\n要求：任一文件跑两次必须字节完全相同（cmp 通过），且 iframe 内 a &amp; b 语义与文本形态稳定不变。注意：审核已实测「给文本节点换 Script 类」的补丁无效，需在序列化环节介入（例如序列化后对 raw-text 元素的原始文本区间做还原，或改为不重复经过 settle 的定点策略）。修完必须给出连跑两次 cmp 的真实输出。\n\n缺陷 B-2（一般，必须修）：_ON_PAYLOAD_RE = r\"on[a-z0-9_:-]+=\" 在注释全文上裸子串匹配，导致 <!-- options=1 controls the menu --> 被误删。要求改为要求 on 前是词边界/空白/引号，如 (?:^|[\\s\"'])on[a-z0-9_:-]+=；修完确认 buttons=/icons=/lessons= 一类无害注释保留，同时 <!-- onclick=x() --> 这类真载荷仍被删除。"
acceptance: "1. 包含:/app/filter.py :: _ON_PAYLOAD_RE\n2. 自查：/tmp 夹具 <!DOCTYPE html><html><body><iframe>a &amp; b</iframe></body></html> 连跑两次后 cmp 相同，且 iframe 内文本仍为 a &amp; b\n3. 自查：/tmp 夹具 <p>a</p><!-- options=1 controls the menu --><p>b</p> 运行后注释原样保留\n4. 自查：<script>/on* 事件属性/javascript: 载荷的原有清除效果不回退"
depends_on: ["卡0007"]
tier: primary
budget: {"toolCalls":100,"turns":100}
priority: high
owner: 主控
attempt: 1
created: "2026-10-23 05:26"
completed: "2026-10-23 05:41"
status: delivered
---

## owner记录 2026-10-23 05:26
- 事件: 状态改为 in_progress

## 回执 尝试1 2026-10-23 05:40
- result: success
- summary: "B-1 修复：raw-text 元素文本改用 PreformattedString 子类在序列化环节不转义，plaintext 及未闭合祖先改为只输出开标签（deepcopy，不改原树），raw-text 内字面 <script 仅转义 <；五次跑两遍 cmp 均 identical。B-2 修复：_ON_PAYLOAD_RE 改为 (?:^|[\\s\"'])on[a-z0-9_:-]+= 并在未剥白空白原文上匹配，options=/buttons=/icons=/lessons= 保留而 onclick=/onload= 仍删。回归：200 组良性文档新旧字节零差异、22 组危险载荷输出全同、300 组混排 fuzz 幂等与残留 0，py_compile 通过。"
- artifact_path: ["filter.py", ".pao/benchmark/黑板.md"]
- evidence: ["/app/.pao/benchmark/worker-evidence/卡0008-尝试1-2aaae8ee3f45-8d2f2740-a098-4c72-a7ea-cadb92825db7.live.jsonl.gz", "/app/.pao/benchmark/worker-evidence/卡0008-尝试1-2aaae8ee3f45-8d2f2740-a098-4c72-a7ea-cadb92825db7.live.jsonl.receipt-format-recovery.json"]
- usage: {"input":49542,"output":86418,"cacheRead":2077312,"cacheWrite":0,"cost":0,"turns":69,"toolCalls":69,"missing_usage_rounds":0,"run_id":"8d2f2740-a098-4c72-a7ea-cadb92825db7"}
- 任务态: completed
- verification: [{"条件":"包含:/app/filter.py :: _ON_PAYLOAD_RE","结论":"pass","证据":"grep -n '_ON_PAYLOAD_RE' /app/filter.py → 105 行：_ON_PAYLOAD_RE = re.compile(r\"(?:^|[\\s\\\"'])on[a-z0-9_:-]+=\")，173 行使用"}, {"条件":"自查：夹具 <!DOCTYPE html><html><body><iframe>a &amp; b</iframe></body></html> 连跑两次 cmp 相同，且 iframe 内文本仍为 a &amp; b","结论":"pass","证据":"/tmp/card0008/a2.html：run1 exit=0 69B、run2 exit=0 69B，cmp a2.run1 a2.html → identical；内容 '<!DOCTYPE html>\\n\\n<html><body><iframe>a &amp; b</iframe></body></html>'；另五个 raw-text 元素（iframe/xmp/noembed/noframes/plaintext）各自连跑两次 cmp 全 pass，输出仍为 'a &amp; b'"}, {"条件":"自查：夹具 <p>a</p><!-- options=1 controls the menu --><p>b</p> 运行后注释原样保留","结论":"pass","证据":"/tmp/fix8/acc/f3.html 运行后 cat → '<p>a</p><!-- options=1 controls the menu --><p>b</p>'，grep 命中注释原文；扩展 13 例：options=/buttons=/icons=/lessons=/revision=/persons=/中文说明 on 均保留，<!-- onclick=x() -->、<!-- foo onload=alert(1) -->、<!-- on-error=1 -->、<!-- a javascript: b -->、<!-- <script> --> 仍被删除"}, {"条件":"自查：<script>/on* 事件属性/javascript: 载荷的原有清除效果不回退","结论":"pass","证据":"/tmp/fix8/acc/f4.html 含 body onload、<script>、href=javascript:、img onerror、srcdoc、<!-- onclick=x() -->，运行后输出 '<html><body><a>j</a><img src=\"x\"/><iframe></iframe></body></html>'，BeautifulSoup 复解析断言 script/on* 属性/javascript: 值残留均为 0；另有新旧实现对照脚本 /tmp/fix8/diff_probe.py：22 组危险载荷输出逐字节全同（danger changed = 0 / 22），200 组纯良性文档新旧字节零差异（safe-doc diffs = 0 / 200），300 组混排 fuzz 幂等+残留 0 失败"}, {"条件":"本次尝试 1 相对认领基线的程序候选改动","结论":"pass","证据":"基线 /app/.pao/benchmark/基线/卡0008-尝试1-基线.json；M __pycache__/filter.cpython-312.pyc、M filter.py"}]
- changes: [{"路径":"filter.py","类型":"modified","说明":"B-1：新增 _RAW_TEXT_ELEMENTS/_RAW_TEXT_SCRIPT_RE/_RawText(PreformattedString)/_mark_raw_text/_suppress_end_tag/_serialize_tree，serialize 与 decode_source 改走 _serialize_tree（不重复转义、plaintext 不补闭合标签、字面 <script 只转义 <）；B-2：_ON_PAYLOAD_RE 加词边界并在未剥白原文上匹配，抽出 _decode_repeatedly 复用；docstring 第 4/10 条与注释判定说明同步更新"}, {"路径":".pao/benchmark/黑板.md","类型":"modified","说明":"追加一条便签：B-1 用 PreformattedString（而非 Script 类）才真正不转义、plaintext 收口策略、B-2 必须在未剥白原文上匹配，附回归数字"}]

## 机械验收 2026-10-23 05:41
- 结论: 全过停人工审
- 尝试: 1
- 执行根: /app
- 仓库根: /app
- 关联摘要: sha256:3d5416247b300cd5b804ca179bfee9506e7c197d4759068785a44528ce24a205
- 工作树摘要: sha256:b8bca25f69037306eb624854a6dd04b428d51b20cffb7a2947c297e76349067a
- 输入快照: sha256:eb0ffbd07b7b3a9bd6ca2bc660a3cda02261989aa45f2b849759e146b2aa2044
- 简报: pao-brief://brief-card-0008-attempt-1?digest=sha256%3A7c3e0302e3893c5463ac901a20fef5ea6f15711dcdd10c2c5966a9cc31d38d85
- 人话句 4 条待主控审
- [人话句] "1. 包含:/app/filter.py :: _ON_PAYLOAD_RE"
- [人话句] "2. 自查：/tmp 夹具 <!DOCTYPE html><html><body><iframe>a &amp; b</iframe></body></html> 连跑两次后 cmp 相同，且 iframe 内文本仍为 a &amp; b"
- [人话句] "3. 自查：/tmp 夹具 <p>a</p><!-- options=1 controls the menu --><p>b</p> 运行后注释原样保留"
- [人话句] "4. 自查：<script>/on* 事件属性/javascript: 载荷的原有清除效果不回退"

## owner记录 2026-10-23 05:41
- 事件: 状态改为 delivered
- 依据: 主控独立验收卡0008：/tmp 夹具复现原 B-1 场景（<!DOCTYPE html><html><body><iframe>a &amp; b</iframe></body></html>）连跑两次 cmp 相同且 iframe 文本保持 a &amp; b；B-2 的 <!-- options=1 controls the menu --> 保留而 <!-- onclick=x() --> 仍被删；另用 15 项混合夹具验证 javascript:/vbscript:/data:text/html/onload/srcdoc/expression 残留计数为 0，table/class/id/实体/无害注释均保留，二次运行 IDEM_OK。越界一项为 __pycache__/filter.cpython-312.pyc（py_compile 副产物，非业务改动），可接受。
