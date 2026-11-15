---
goal: "对照原始任务审计并实测 /app/filter.py（当前已存在一版实现，禁止推倒重写）：它必须能 `python3 filter.py <FILE>` 就地去除 HTML 中的 JavaScript，且除被删除的有害片段外逐字节保留其余内容（缩进、换行、属性顺序与引号风格、实体、注释、表格与标题结构、非危险属性）。步骤：①只读通读 /app/filter.py，核对其覆盖 <script>、on* 事件属性、javascript:/vbscript:/script 型 data: URL、style 与 <style> 中的 expression()、meta refresh、svg animate、srcdoc 等载体，以及 argv[1]/就地/标准库约束；②新建并维护回归自测脚本 /app/selfcheck_filter.py（纯标准库，夹具全部写入 tempfile 临时目录，不往 /app 直写测试数据），覆盖：无 JS 文档逐字节不变、各类 JS 载体被移除、合法结构与属性保留、重复运行幂等且不改 mtime、UTF-8 与 BOM 处理、输出可被 html.parser 解析、缺参/文件不存在的退出码；③对自测暴露的真实缺陷做最小必要修正；若全部通过则保持现有实现不动并在回执中说明。回执必须给出实际命令与真实回显、修改前后差异片段、以及未验证/存疑项。"
dept: 实施
inputs: []
constraints: "只处理原始公开任务，不读取 /tests、/solution、oracle 或在线基准答案；不伪造运行结果；所有角色均使用 DeepSeek high；保存节点地图时必须传 scope_confirmed=true 且 scope_review_required=false（覆盖范围已核对足以检出新增使用点），否则下游会以「交接地图未确认有效」停链。\n只用 Python 标准库与环境中已安装包，禁止联网安装依赖；只改 /app/filter.py，另可新增/维护 /app/selfcheck_filter.py，不得在 /app 留下一性垃圾文件；严禁读取 /tests、/solution、oracle 或任何基准答案，严禁上网搜题解；不得伪造任何运行输出，每条结论必须有真实命令回显；不得改变既有字节保真契约（除删除的 JS 片段外不得重排版/重序列化），不得改变调用约定（argv[1]、就地修改、成功 0）；不要为了让自测通过而写死用例或塞入基准特征串。"
acceptance: "跑: python3 -m py_compile filter.py\n跑: python3 selfcheck_filter.py\n存在: filter.py\n存在: selfcheck_filter.py\n包含: filter.py::sys.argv\n包含: selfcheck_filter.py::fidelity\n人工审核: 部长核对工人回执：是否给出真实命令回显与修改前后 diff；实体编码/空白与控制字符折叠/大小写混淆的 javascript: 协议、on* 事件属性、style 与 <style> 的 expression()、meta refresh、iframe srcdoc、svg animate 等边界的实际覆盖；是否引入任务无关改动、新依赖或对已正确逻辑的重写；未验证项是否如实列出。质量与风格判断不由自动勾选代替。"
depends_on: []
tier: primary
priority: medium
owner: 主控
attempt: 1
created: "2026-10-23 18:25"
status: in_progress
---

<!-- pao-workflow:流=基准开发流水线/节点=实施 -->
<!-- pao-workflow-v2:实例=b5367981-cbaf-48a8-86a5-560458732f31/轮次=1 -->

## owner记录 2026-10-23 18:25
- 事件: 状态改为 in_progress
