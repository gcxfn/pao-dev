---
goal: "为已实现的 /app/filter.py 编写纯标准库全面自测脚本 /app/filter_selftest.py（真实断言，覆盖良性样本字节不变、恶意样本 JS 清除、脚本正文不残留、幂等性、错误路径），并用已有的独立自检脚本 /app/filter_check.py 交叉复核；发现缺陷则在 /app/filter.py 内修复，直至全部机械验收（存在性、编译、自测脚本、交叉自检）退出码均为 0。"
dept: 实施
inputs: ["filter.py", "filter_check.py"]
constraints: "只处理原始公开任务，不读取 /tests、/solution、oracle 或在线基准答案；不伪造运行结果；所有角色使用本轮选定模型与 high。\n范围：仅围绕 filter.py 的 JS 清除与保真行为编写与运行测试、修复其缺陷。不得新增 filter.py 之外的功能模块。不得把 /tests、/solution 或任何参考答案作为依据；测试样例必须由本卡自行构造。不得联网。只用 Python 标准库自测（环境无 pytest）。只允许修改 /app/filter.py、/app/filter_selftest.py、/app/filter_check.py，不得改其他业务文件与编排目录 .pao。修复缺陷时只允许调整 JS 判定与删除区间逻辑，不得改变良性内容的字节（不得重排缩进、不得规范化引号或实体、不得增删 DOCTYPE/注释）。不得把自测写成空壳（禁止 try/except 吞掉断言失败、禁止无条件 pass）。\n\n## 交付物\n- /app/filter_selftest.py（纯标准库 unittest 或自写断言，含真实断言与 test_ 方法，python3 filter_selftest.py 退出码 0）\n- /app/filter.py 的修复版本（若自测或交叉校验发现缺陷）\n- 一次真实运行的证据输出：自测脚本逐项通过记录 + filter_check.py 通过记录 + 修复前后的差异说明\n\n## 实施提示\n自测矩阵 B（良性样本必须字节不变，逐字节比较）：标准文档（DOCTYPE/head/meta/title/h1/table/tr/td/注释/p 含 &amp;）、中文与 emoji、CRLF 行尾、UTF-8 BOM、单双引号混合属性、含 data-* 与 ARIA 的良性标签、正文出现 'onclick=' 字样（须原样保留，不得当成事件属性删除）。\n\n自测矩阵 J（JS 移除，断言输出不含对应 script 标签/on* 属性/javascript: 载荷/alert(/expression(，且对应良性片段仍在）：script 块（默认/带 src/大写/多行）、onerror（带引号与无引号）、javascript: href（混合大小写、实体 &#106;、前导空格、内嵌制表符）、iframe src=javascript:、srcdoc、style 中 url(javascript:)、<style> 中 expression()、meta refresh、svg 内 script、svg onload、body onload、变异 '<scr<script>ipt>alert(1)</script>'、保留 title/class 的混合属性、条件注释内 script、object data=data:text/html、form action、formaction、embed src=data:、孤立 </script>、table background、expression()、vbscript:。\n\n自测矩阵 S：脚本内容不残留为可见文本；对同一文件连续运行两次幂等（第二次输出等于第一次且退出码 0）；缺参数时退出码非 0 且不修改文件；路径不存在时退出码非 0。\n\n注意：矩阵 J 的“输出不含某子串”断言只适用于该样本中确实以属性/URL 形式出现的载荷；纯文本里的 'onclick=' 字样必须保留，不得据此判失败。测试用临时文件请用 tempfile 模块创建，不要硬编码路径。\n\n人工审核项（由审核节点判断，非自动项）：自测是否为真实断言而非空壳/吞异常；良性样本是否真的逐字节比较；缺陷修复是否只改 JS 判定与删除区间而未改动良性内容字节；错误路径 stderr 是否清晰。"
acceptance: "存在: filter_selftest.py\n包含: filter_selftest.py::def test_\n跑: python3 filter_selftest.py\n跑: python3 filter_check.py\n跑: python3 -m py_compile filter.py"
depends_on: []
tier: primary
priority: medium
attempt: 0
created: "2026-10-27 19:54"
status: unclaimed
---

<!-- pao-workflow:流=基准开发流水线/节点=实施 -->
<!-- pao-workflow-v2:实例=0fb6d724-268d-480e-9852-b4e5bae8e324/轮次=1 -->
