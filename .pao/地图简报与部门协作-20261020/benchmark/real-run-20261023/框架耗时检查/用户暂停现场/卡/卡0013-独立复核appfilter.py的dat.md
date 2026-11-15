---
goal: "独立复核 /app/filter.py 的 data: 危险 URL 加固，确认删除侧与保留侧均正确且终审结论无回归，把判定写入 /app/.pao/benchmark/加固复核报告.md。原始任务：创建 Python 脚本 filter.py，接收 HTML 文件路径参数，就地移除其中全部 JavaScript 以防 XSS，尽量保留原有 HTML 结构与格式（仅允许解析带来的规范化），只能使用已安装的 Python 包。"
dept: 审核
inputs: ["/app/filter.py", "/app/.pao/benchmark/终审报告.md"]
constraints: "独立复核，不修改 /app/filter.py 与 app 项目内其他业务文件；夹具只放 /tmp；不读取 tests、solution、oracle 或在线基准答案；不伪造运行结果；不因前轮判定通过而跳过实跑。\n\n必须覆盖：\n1. 删除侧：data:text/javascript、data:application/javascript、data:application/x-javascript、data:application/ecmascript、data:text/ecmascript、data:application/xhtml+xml、data:text/html、data:image/svg+xml，以及大小写变体、MIME 参数（;charset=utf-8）、前导空白/控制字符、实体编码双层——每例实跑并断言属性被删。\n2. 保留侧：data:image/png、image/jpeg、image/gif、image/webp、font/woff2、font/ttf、audio/mpeg、video/mp4、text/plain、application/pdf 的 base64 或明文字面——每例实跑并断言属性保留（逐字节）。\n3. 不得误删的边界：data: 后带多余空白、data:;base64、data:,明文中文、data:text/css。\n4. 回归：终审报告 §0 的 8 项结论与 B-1（含 template/rt/rp/plaintext 容器）、B-2、N-2 全部重跑确认无回退。\n5. 幂等：删除侧与保留侧夹具各连跑两次 cmp 相同。\n6. 结论须给出总判定（通过/不通过）与「未验证」段；缺陷给最小复现、期望、实际与级别。"
acceptance: "1. 存在:/app/.pao/benchmark/加固复核报告.md\n2. 包含:/app/.pao/benchmark/加固复核报告.md :: 判定\n3. 包含:/app/.pao/benchmark/加固复核报告.md :: 未验证\n4. 对 data: 加固的删除侧与保留侧逐项实跑并给证据，且确认终审报告 9 项与 B-1/B-2/N-2 无回归"
depends_on: ["卡0012"]
tier: primary
budget: {"toolCalls":160,"turns":120}
priority: high
owner: 主控
attempt: 1
created: "2026-10-23 06:46"
status: in_progress
---

## owner记录 2026-10-23 06:46
- 事件: 状态改为 in_progress
