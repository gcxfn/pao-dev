---
goal: "新建 /app/filter.py：命令行接收 HTML 文件路径（argv[1]），就地(in-place)改写同一文件，移除其中全部 JavaScript（script 块、on* 事件属性、javascript:/vbscript:/data: 等危险 URL、srcdoc、内联 CSS 中的 expression()/@import/behavior/-moz-binding、meta refresh 指向危险 URL、SVG 内脚本与事件），同时保证除被判定为有害的片段外，其余内容逐字节不变（DOCTYPE、注释、实体、属性引号风格、空格、缩进、CRLF、BOM、emoji、非 UTF-8 字节均须原样保留）；同时满足命令行契约：argv[1] 传入路径、就地写回、缺参数/多参数退出码非 0 且不触碰文件、文件不存在退出码非 0 且不留半成品、成功退出码 0 且 stdout 安静。另新建 /app/filter_check.py（纯标准库独立自检脚本）验证这些行为。"
dept: 实施
inputs: []
constraints: "只处理原始公开任务，不读取 /tests、/solution、oracle 或在线基准答案；不伪造运行结果；所有角色使用本轮选定模型与 high。\n范围：只做本卡目标描述的 JS 清除与保真。不引入新依赖。不改其他业务文件。不美化/不重排 HTML。不输出多余 stdout 日志。不做网络访问。不得把 script 正文留在输出里当可见文本。只用 Python 标准库（环境虽有 bs4/lxml，本卡一律不用）。不读 /tests、/solution、任何 oracle 或在线答案。只允许新建/修改 /app/filter.py 与 /app/filter_check.py，不得改动 /app 下其他业务文件与编排目录 .pao。不得借机新增任务外的功能。不得用 '<script.*?</script>' 一刀切正则。\n\n## 交付物\n- /app/filter.py（可执行脚本，含 main() 与 __main__ 守卫，仅用标准库）\n- /app/filter_check.py（纯标准库独立自检脚本，真实断言，退出码 0）\n- 一次真实运行的证据：上述「跑:」命令全部退出码 0，终端记录含自检输出（逐项断言名与结果）\n\n## 实施提示\n实现路线（已定，勿改）：自研轻量分词器 + 原文切片编辑，只用标准库。禁止用 bs4/lxml 解析后整树序列化（会改引号/实体转义/自闭合形式、丢 DOCTYPE 与注释，违反“不得改变格式”）。\n\n1) 分词器：扫描 '<' 时依次判定 '<!--'(注释至 '-->')、'<![CDATA['(至 ']]>')、'<!'(至 '>')、'<?'(至 '>')、'</'+字母(结束标签)、'<'+ASCII字母(开始标签+属性，属性值引号内的 '>' 不算标签结束)，其余 '<' 视为普通文本。\n2) 原始文本元素：script/style/textarea/title/noscript/plaintext 的内容按 raw text 处理（直到对应 '</name' 后跟空白、'/' 或 '>'），避免破坏 textarea/title 正文。\n3) R1 脚本块：开始标签名 == 'script' 或名字含 '<script'（畸形嵌套如 '<scr<script>'）→ 删除该标签，并删除其后直到并包含下一个名字含 'script' 的结束标签（无则删到 EOF）；孤立结束标签 '</script>' 直接删除；脚本正文不得残留为可见文本。\n4) R2 属性级（在原文 raw 文本上解析属性并记录 span）：事件属性（名以 on 开头且长度>2，如 onerror/onclick/onload/onmouseover）删除；srcdoc 删除；URL 类属性 href/src/action/formaction/xlink:href/xml:base/poster/background/cite/longdesc/profile/usemap/codebase/classid/archive/manifest/lowsrc/dynsrc/ping/folder 以及 object 标签的 data，命中危险 scheme 即删除该属性。\n5) 危险 scheme 判定：先 html.unescape 解实体 → 去掉所有 <=0x20 的空白与控制字符 → 小写 → 命中前缀 javascript: vbscript: livescript: mocha: data:text/html data:application/xhtml+xml data:image/svg+xml data:text/xml data:text/javascript data:application/javascript 即判定命中（覆盖 &#106;avascript:、JaVaScRiPt:、java<TAB>script:、前导空格等变形）。\n6) R2 其余：srcset 按逗号切分逐项判定；style 属性按 ';' 拆声明，删除含 expression(/javascript:/vbscript:/behavior:/-moz-binding/@import 的声明并保留其余（如 style=\"width:100px;background:url(javascript:...)\" 只剩 width:100px），清理后为空则删属性；meta http-equiv=refresh 的 content 含 url= + 危险 scheme 则删 content 保留 http-equiv；SVG animate/set 且 attributeName 为 href/xlink:href 时 values/from/to 命中则删。\n7) 删除动作细节：删属性时连带其前方一段空白，避免双空格；例 '<img src=\"x\" onerror=\"alert(1)\">' → '<img src=\"x\">'；'<div onclick=\"alert(1)\" class=\"c\">' → '<div class=\"c\">'；其余字符一律不动。\n8) R3 <style> 元素内容：删除含 expression(/javascript:/vbscript:/-moz-binding/behavior 的 CSS 声明片段与危险 @import，其余 CSS 原样保留。\n9) R4 注释：注释内部出现 '<script ...>...</script>'（大小写不敏感）时删除该内嵌片段并保留 <!-- --> 边界（覆盖 IE 条件注释）。\n10) R5 文本残留：普通文本 token 原样保留（正文出现 'onclick=' 字样不得误删）；仅当同一文本 token 内同时出现 '<script' 与 '</script' 时才删除该区间；textarea/title 的 raw text 不做此清理。\n11) R6 编辑应用：所有修改区间按 start 升序合并（重叠取并集），在原文上一次性切片重建，保证未判定有害的部分逐字节不变。\n12) IO 与编码：bytes 读入 → decode('utf-8', errors='surrogateescape') → 处理 → encode('utf-8', errors='surrogateescape') → 以 'wb' 截断写回同一路径（保留原权限，不用临时文件替换）；surrogateescape 往返保证非 UTF-8 字节与 BOM 其余字节不变。\n13) CLI 契约：main() 用 if __name__ == '__main__' 守卫以保证可安全 import；缺参数或参数多于 1 个 → stderr 打印用法、exit 2 且不触碰文件；文件不存在/不可读 → stderr 报错、exit 1 且不留半成品；成功 exit 0 且 stdout 安静。\n14) /app/filter_check.py 要求：纯标准库（环境无 pytest），用 subprocess 调用 filter.py，用 tempfile 建临时 HTML 文件（临时目录可用 tempfile 模块创建，不要硬编码 /tests 之类路径）；逐项真实断言：(a) 良性样本（DOCTYPE/注释/实体/表格/中文/emoji/CRLF/BOM）在处理后字节完全相同；(b) 恶意样本中 <script>、onerror=、javascript:、alert( 等被清除且良性片段（如 img 的 src 属性、链接文字）仍在；(c) 脚本正文不作为可见文本残留；(d) 同一文件连续运行两次结果幂等；(e) 缺参数时退出码非 0 且文件未被修改；(f) 路径不存在时退出码非 0。断言失败时打印失败详情并以非 0 退出；禁止 try/except 吞掉断言、禁止无条件通过。成功时打印每项断言名与 OK，整体退出码 0。\n\n人工审核项（由审核节点判断，非自动项）：脚本正文是否整段删除而非留作可见正文；删除区间是否最小且未误删正文；是否用了粗糙正则；良性样本是否字节不变；filter_check.py 是否为真实断言而非空壳；错误路径 stderr 是否清晰且不损坏原文件。"
acceptance: "存在: filter.py\n包含: filter.py::def main\n存在: filter_check.py\n跑: python3 -m py_compile filter.py\n跑: python3 filter_check.py"
depends_on: []
tier: primary
priority: medium
owner: 主控
attempt: 2
created: "2026-10-27 19:54"
status: unclaimed
---

<!-- pao-workflow:流=基准开发流水线/节点=实施 -->
<!-- pao-workflow-v2:实例=0fb6d724-268d-480e-9852-b4e5bae8e324/轮次=1 -->

## owner记录 2026-10-27 19:54
- 事件: 状态改为 in_progress

## 回执 尝试1 2026-10-27 19:57
- result: failed
- summary: "无有效回执：最终输出缺少有效 JSON 回执（result、artifact_path、summary）"
- evidence: ["/app/.pao/benchmark/worker-evidence/卡0001-尝试1-ee70d0e72d99-9c62244b-e3dd-4ad8-94b3-a54c7484cde1.live.jsonl.gz"]
- usage: {"input":54496,"output":38053,"cacheRead":316672,"cacheWrite":0,"cost":0,"turns":10,"toolCalls":10,"missing_usage_rounds":0,"run_id":"9c62244b-e3dd-4ad8-94b3-a54c7484cde1"}
- failure_type: unknown_outcome
- verification: [{"条件":"本次尝试 1 相对认领基线的程序候选改动","结论":"pass","证据":"基线 /app/.pao/benchmark/基线/卡0001-尝试1-基线.json；?? filter_check.py、?? filter.py"}]

## owner记录 2026-10-27 19:57
- 事件: 状态改为 failed
- 失败类型: unknown_outcome
- 依据: worker 回执 failed（unknown_outcome），自动链如实落失败

## owner记录 2026-10-27 19:57
- 事件: 状态改为 unclaimed
- 依据: 卡0001 失败类型为 unknown_outcome：产物已落盘（/app/filter.py、/app/filter_check.py 存在），但 worker 最终输出缺少有效 JSON 回执，属回执格式缺失而非真实机械失败。按合法迁移退回待认领，重派同卡重跑以补出可核验回执与运行证据；attempt 1 < 上限 2。

## owner记录 2026-10-27 19:58
- 事件: 状态改为 in_progress

## 回执 尝试2 2026-10-27 19:59
- result: failed
- summary: "无有效回执：最终输出缺少有效 JSON 回执（result、artifact_path、summary）"
- evidence: ["/app/.pao/benchmark/worker-evidence/卡0001-尝试2-ee70d0e72d99-a0dddb06-12cc-4fc1-b90b-138658240d9b.live.jsonl.gz"]
- usage: {"input":30131,"output":13878,"cacheRead":1366272,"cacheWrite":0,"cost":0,"turns":19,"toolCalls":19,"missing_usage_rounds":0,"run_id":"a0dddb06-12cc-4fc1-b90b-138658240d9b"}
- failure_type: unknown_outcome
- verification: [{"条件":"本次尝试 2 相对认领基线的程序候选改动","结论":"pass","证据":"基线 /app/.pao/benchmark/基线/卡0001-尝试2-基线.json；M filter_check.py、M filter.py"}]

## owner记录 2026-10-27 19:59
- 事件: 状态改为 failed
- 失败类型: unknown_outcome
- 依据: worker 回执 failed（unknown_outcome），自动链如实落失败

## owner记录 2026-10-27 20:00
- 事件: 状态改为 unclaimed
- 依据: 尝试1、尝试2 均为 unknown_outcome（worker 产物持续改进并落盘，但最终输出未被解析为有效 JSON 回执），非真实机械失败。attempt=2 已达默认上限，owner 显式提高同轮尝试上限至 4 后退回待认领重派，以取得一次有效回执与机械验收运行证据。
