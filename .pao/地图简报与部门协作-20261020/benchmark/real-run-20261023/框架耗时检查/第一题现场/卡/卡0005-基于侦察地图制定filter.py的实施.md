---
goal: "基于侦察地图制定 filter.py 的实施与验收计划并写入 /app/.pao/benchmark/规划地图.md：需清除的 JavaScript 载体清单（危险面）、保留格式的策略、边界情形、可机械执行的本地验证命令。原始任务：创建 Python 脚本 filter.py，接收 HTML 文件路径参数，就地移除全部 JavaScript 以防 XSS，尽量保留 HTML 结构与格式（仅允许解析带来的规范化），只能用已安装的 Python 包。"
dept: 规划
inputs: ["/app/.pao/benchmark/侦察地图.md"]
constraints: "只读规划，不修改 app 项目业务文件；不读取 tests、solution、oracle 或在线基准答案；不伪造运行结果；不重复全仓调查（复用侦察地图）；不改动验收规则。"
acceptance: "1. 存在:/app/.pao/benchmark/规划地图.md\n2. 包含:/app/.pao/benchmark/规划地图.md :: 危险面\n3. 包含:/app/.pao/benchmark/规划地图.md :: 验证\n4. 规划只基于侦察地图与公开任务，给出可执行步骤与机械验收方式，并明示未验证项"
depends_on: ["卡0004"]
tier: fast
budget: {"toolCalls":80,"turns":80}
priority: high
owner: 主控
attempt: 1
created: "2026-10-23 04:42"
completed: "2026-10-23 04:46"
status: delivered
---

## owner记录 2026-10-23 04:42
- 事件: 状态改为 in_progress

## 回执 尝试1 2026-10-23 04:46
- result: success
- summary: "基于侦察地图产出 filter.py 实施与验收计划：九类危险面分级(P0/P1)、html.parser 免包裹策略、BOM/空文件/GBK/幂等边界、V0–V9 可粘贴验证命令、11 条未验证项与 D1–D6 决策点。\n关键新发现已在 /tmp 实测：空文件若把 bytes 直接交 bs4 会写出 \"b''\"（须先 decode utf-8-sig）；清洗字节级不幂等（DOM 级幂等）。\n原型仅在 /tmp 验证，未写入 /app 业务文件；黑板上已挂规划地图便签。"
- artifact_path: [".pao/benchmark/规划地图.md"]
- evidence: ["/app/.pao/benchmark/worker-evidence/卡0005-尝试1-d2aa89d76339-11d967c0-df50-43a3-bd88-6f3f7279c1b2.live.jsonl.gz"]
- usage: {"input":37883,"output":29489,"cacheRead":792960,"cacheWrite":0,"cost":0,"turns":34,"toolCalls":35,"missing_usage_rounds":0,"run_id":"11d967c0-df50-43a3-bd88-6f3f7279c1b2"}
- 任务态: completed
- verification: [{"条件":"存在:/app/.pao/benchmark/规划地图.md","结论":"pass","证据":"ls -la .pao/benchmark/规划地图.md → -rw-r--r-- 1 root root 27391 Oct 23 04:45 .pao/benchmark/规划地图.md"}, {"条件":"包含:/app/.pao/benchmark/规划地图.md :: 危险面","结论":"pass","证据":"grep -c '危险面' .pao/benchmark/规划地图.md → 5；§2「危险面清单（必须清除的 JavaScript 载体）」为九类分级表"}, {"条件":"包含:/app/.pao/benchmark/规划地图.md :: 验证","结论":"pass","证据":"grep -c '验证' .pao/benchmark/规划地图.md → 18；§6「可机械执行的本地验证（命令即判据）」含 V0–V9，每条带 PASS= 判据"}, {"条件":"规划只基于侦察地图与公开任务，给出可执行步骤与机械验收方式，并明示未验证项","结论":"pass","证据":"§0 每条事实标注侦察地图章节锚点(§0/§1/§2/§3.1-§3.4/§4.x/§5)；§5 为 S1–S8 八步可直接照做；§6 V0–V9 均已在本轮 /tmp 实测片段语法与执行有效性(proto2.py 跑出 PASS_main/PASS_frag/PASS_idem、空文件 0 字节、GBK→UTF-8、BOM 丢弃、退出码 2/1/0)；§8 列 11 条未验证项；§9 列 D1–D6 决策点"}, {"条件":"本次尝试 1 相对认领基线的程序候选改动","结论":"pass","证据":"基线 /app/.pao/benchmark/基线/卡0005-尝试1-基线.json；无候选改动"}]
- changes: [{"路径":".pao/benchmark/规划地图.md","类型":"created","说明":"卡0005 交付物：filter.py 实施与验收规划（危险面分级、保留格式策略、边界情形、V0–V9 验证命令、未验证清单、决策点、风险回退）"}, {"路径":".pao/benchmark/黑板.md","类型":"modified","说明":"按黑板规则追加一条指向规划地图的便签（先挂链接再写摘要，含两个实现必看坑）"}]

## 机械验收 2026-10-23 04:46
- 结论: 全过停人工审
- 尝试: 1
- 执行根: /app
- 仓库根: /app
- 关联摘要: sha256:8608ca229746228f473f4ba8b2db10c433b2030c722b83fcfeaef48cee396f9a
- 工作树摘要: sha256:b8bca25f69037306eb624854a6dd04b428d51b20cffb7a2947c297e76349067a
- 输入快照: sha256:571ca7efd5d695f1de10ca84f8f20353ae70f3511ff63d8e6e4be55e268af439
- 简报: pao-brief://brief-card-0005-attempt-1?digest=sha256%3Aac501e0ce2a89c4d13f7c7add89b027e715ea4d32df0eb1a90e3048f22b75f5c
- 人话句 4 条待主控审
- [人话句] "1. 存在:/app/.pao/benchmark/规划地图.md"
- [人话句] "2. 包含:/app/.pao/benchmark/规划地图.md :: 危险面"
- [人话句] "3. 包含:/app/.pao/benchmark/规划地图.md :: 验证"
- [人话句] "4. 规划只基于侦察地图与公开任务，给出可执行步骤与机械验收方式，并明示未验证项"

## owner记录 2026-10-23 04:46
- 事件: 状态改为 delivered
- 依据: 主控核对产物：/app/.pao/benchmark/规划地图.md 真实存在（27391 字节）；grep 确认含「危险面」5 处、「验证」18 处、「未验证」13 处；内容为可执行实施口径（九类危险面分级、html.parser 免包裹策略、V0–V9 可粘贴验证命令），未重复全仓调查，未读取 tests/solution。
