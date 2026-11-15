# 不引入 pi-maestro-flow 引擎与技能集（2026-10-07）

> 背景：2026-10-07 对 pi-maestro-flow v0.31.3（pi 生态多代理编排套件，MIT，源仓 catlog22/pi-maestro-flow）做参照调研，16 项机制经用户逐项拍板按注记采纳（进度账本＝[实施清单](../../../plans/未完成/存档-收编-2026-10-07/2026-10-07-pi-maestro-flow参照实施清单.md)，代码＝[摘录附件](../../../plans/附件/2026-10-07-pi-maestro-flow抄改代码摘录.md)）。以下整体**不引入**，记 why 备查；推翻本笔记须用户明示。

## 不引入清单

1. **flow-schedule 编排引擎本体**（事件溯源 reducer＋actor/broker/outbox＋派发双轴状态机）：与同包 gateway board 双轨解决同一问题（store 单文件 1679 行），状态爆炸（transport/business 双轴＋outbox 三态＋binding 五态）；更与既有定案冲突——「引擎不抄，工作流以卡为唯一真相源」（需求 §4.1 OMP 销账段、架构 §11）。个人项目抄 board 一侧的机制即可。
2. **63 技能／32 角色的规模**：近半为同一套会话/知识管理的同义变体（maestro-learn 628 行、skill-tuning 252KB 超标），`<teammate_contract>` 契约块在 20+ 文件逐字重复而非 include。抄结构不抄规模——四写法已单独采纳（架构 §4 注记）。
3. **statusline／TUI 渲染层**：终端专属件，PAO 桌面壳（§27.3）无对应面。

## 卫生观察（非本项目决策，防误抄）

该 npm 包混入作者本机运行数据（`.pi/monitor-sessions` 等 206 个目录、gateway 任务、委派记录）——参考其 `.pi/` 资源树时须区分「设计」与「运行残留」，勿把残留当约定抄。
