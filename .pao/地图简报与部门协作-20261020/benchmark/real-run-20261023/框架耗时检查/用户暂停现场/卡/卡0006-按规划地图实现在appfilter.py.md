---
goal: "按规划地图实现在 /app/filter.py：接收 HTML 文件路径参数，就地移除全部 JavaScript 载体并写回，尽量保留 HTML 结构与格式。原始任务：创建 Python 脚本 filter.py，接收 HTML 文件路径参数，就地移除其中全部 JavaScript 以防 XSS，尽量保留原有 HTML 结构与格式（仅允许解析带来的规范化），只能使用已安装的 Python 包。"
dept: 实施
inputs: ["/app/.pao/benchmark/规划地图.md"]
constraints: "只处理公开任务，不读取 tests、solution、oracle 或在线基准答案；不伪造运行结果。\n\n实现口径（由规划地图 §2/§9 决策点定案，worker 不必再决策）：\n- 解析器必须用 BeautifulSoup(data, \"html.parser\")，不得用 lxml（会补 html/body 破坏结构）；不得 prettify/indent。\n- P0：删除全部 <script> 元素（decompose，含内联/外链/svg/math/template/noscript 内）；删除全部 on* 事件属性；按值判定删除 javascript:/vbscript:/data:text/html 载荷的 URL 属性（href/src/action/formaction/xlink:href/data/poster/background 等）。\n- D1：style= 属性值归一后含 expression(/javascript:/behavior:/-moz-binding 则整条删除；<style> 元素正文含同类危险串则整段 decompose。\n- D2：<meta http-equiv=refresh> 的 content 归一后含 javascript:/data:text/html 则整个 meta 删除。\n- D7：srcdoc 属性一律删除。\n- D6：注释/CDATA 节点文本若含 <script 或 javascript: 或 on\\w+= 载荷则删除该节点，其余注释原样保留。\n- 只删节点与属性，不删/不合并容器；属性删空后元素保留。\n- 归一化判定函数集中一处：多次 html.unescape 后剥 \\x00-\\x20\\x7f 控制字符并小写；写回仍用 bs4 原始属性值，禁止用归一值覆盖。\n- 按字节读文件；utf-8-sig 解码（丢弃 BOM）；按 utf-8 写出；不创建 .bak 或临时文件；不追加结尾换行。\n- 退出码：参数错误 2、IO 错误 1、成功 0；错误写 stderr。\n- 幂等：对已清洗文件再跑一次，输出不再变化。\n- docstring 必须逐条列出允许的规范化（标签小写、属性字母序、自闭合、实体解码、BOM 丢弃、CRLF→LF、charset→utf-8）。\n- 夹具与临时文件只能放 /tmp，不得在 app 项目目录留下除 filter.py 之外的文件。"
acceptance: "1. 存在:/app/filter.py\n2. 包含:/app/filter.py :: sys.argv\n3. 包含:/app/filter.py :: html.parser\n4. 自查：用自造夹具验证后脚本对含 script/on*/javascript: 的输入清洗干净，且对无危险内容的 HTML 输出与输入仅解析规范化差异"
depends_on: ["卡0005"]
tier: primary
budget: {"toolCalls":120,"turns":120}
priority: high
owner: 主控
attempt: 1
created: "2026-10-23 04:46"
status: canceled
---

## owner记录 2026-10-23 04:46
- 事件: 状态改为 in_progress

## 回执 尝试1 2026-10-23 05:04
- result: failed
- summary: "预算已耗尽：toolCalls；执行已停止"
- evidence: ["/app/.pao/benchmark/worker-evidence/卡0006-尝试1-04ac47f0e840-584f38bc-b922-48bf-b2cc-b81960f92382.live.jsonl.gz"]
- usage: {"input":77178,"output":78680,"cacheRead":4506752,"cacheWrite":0,"cost":0,"turns":106,"toolCalls":121,"missing_usage_rounds":0,"run_id":"584f38bc-b922-48bf-b2cc-b81960f92382"}
- failure_type: transient
- verification: [{"条件":"本次尝试 1 相对认领基线的程序候选改动","结论":"pass","证据":"基线 /app/.pao/benchmark/基线/卡0006-尝试1-基线.json；?? filter.py"}]

## owner记录 2026-10-23 05:04
- 事件: 状态改为 failed
- 失败类型: transient
- 依据: 尝试1因 toolCalls 预算耗尽中止，产物 /app/filter.py 已生成（334 行、py_compile 通过），但自测未完成；按 transient 路由重开尝试2。

## owner记录 2026-10-23 05:04
- 事件: 状态改为 unclaimed
- 依据: 重开尝试2：filter.py 已在盘上且可编译，续做自测与缺口修补。

## owner记录 2026-10-23 05:41
- 事件: 状态改为 canceled
- 依据: 实施卡0006 的产出已被卡0008（定点修复）与主控独立验证覆盖：filter.py 最终形态经三轮真实运行确认，原始实施尝试中止不影响产物有效性。为避免重复实现，直接收口该卡。
