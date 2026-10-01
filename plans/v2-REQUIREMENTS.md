# PAO v2 需求定案

> 定案日期：2026-10-01。来源：三轮需求访谈。
> 本文是 v2 重启的需求基线；架构决策见 `v2-ARCHITECTURE.md`，实施计划另立。
> 现状断言均截至上述日期，来源退役或版本变化时同批订正。

## 1. 一句话定位

以 pi 为内核的个人编码 agent：**终端先行、桌面端二期做纯壳，最终完全替代 ZCode 成为日常编码主力**。
一切定制优先走 pi 扩展 API，不动 pi 源码；跟 pi 上游更新的成本必须保持低。

## 2. 需求定案（访谈结论）

| 问题 | 定案 |
|---|---|
| 为什么推倒重来 | 基座受限（有的功能可能要 fork 源码，但想跟上更新）＋方向不对（旧 PAO 做成了重型编排平台）＋没真用起来 |
| 真实场景 | 日常编码主力（对标 ZCode / Claude Code），自己掌控提示词、工具、上下文策略 |
| 交互形态 | 先终端；桌面端最终要，但必须是「壳不带内核」——内核跟 pi 上游同步 |
| 上游同步策略 | **锁版本使用，升级时适配**（2026-10-01 定案）：不追单个 release、不维护 fork；锁定一个 pi 版本日常用，按批次升级，升级时执行一次适配（见 §5.4） |
| 验收标准 | 日常杂活全部切过去，能顶住就算成 |
| 投入节奏 | 慢推：每天 1–2 小时，重可持续不重速度 |
| 必须能力 | ①模型路由 ②扩展生态（skills+MCP） ③跨会话记忆 ④子代理与工作流（四块全选） |
| 记忆系统 | **不采用 hindsight**（注入噪音大、成本高、系统重，2026-10-01 否决）；记忆 = 文件式部门知识库，细则见 `v2-ARCHITECTURE.md` §6 |
| 旧代码处置 | 需求定了再定取舍（本文第 7 节给出建议） |

## 3. 明确不要的（旧 PAO 教训）

- SQLite Command Kernel、Director→Agent→Worker 重编排、控制协议、预算/审批机器、Desktop 大仓——与「日常编码主力」目标不匹配。
- GUI 先行、为平台而平台的功能。旧 PAO 四天推到 500+ 后端/1000+ 桌面测试后从未真实使用，v2 以真实使用为唯一进度表。

## 4. pi 现状与能力映射（截至 2026-10-01，pi 0.99.2）

版本事实：旧 PAO 锁定 0.84.2（2026-08-14）→ 当前 0.99.2（2026-09-30），6 周约 20 个版本；
0.86.0 / 0.87.0 均含 breaking changes → 升级必须小步 + 冒烟。

| v2 需求 | pi 0.99 已有能力 | 需要 fork？ |
|---|---|---|
| 模型路由 | `models.json` 自定义 provider（OpenAI 兼容端点）；0.99 起扩展可 `registerVirtualModel()` 按请求路由物理模型与思考档位 | 否 |
| 扩展生态 | 内置 MCP（`mcp.json` / `pi mcp add` / `pi.registerMcpServer()`，stdio+HTTP+OAuth）；`skills/` 原生；工具 `exposure`/`namespace`/`prepareLoadload` 注：`prepareLoadout()` | 否 |
| 跨会话记忆 | 自写文件式知识库即可（**hindsight 已否决**，2026-10-01：噪音/成本/重；pi 生态该能力存在但不用） | 否 |
| 子代理与工作流 | SDK `createAgentSession` / `pi --print` 子进程；RPC `steer`/`follow_up` | 否（自建薄调度层） |
| 上下文工程 | `context` / `context_with_system` / `before_agent_start`(systemPrompt) / `ContextEditEntry` / per-model compaction | 否 |
| 桌面壳（二期） | `pi --mode rpc` / `RpcClient` / rpc-extension-ui 文档 | 否（壳经 RPC 对接，不内置内核） |

**结论：访谈中担心的「基座受限」在 0.99 已大幅缓解，四块必须能力大概率零 fork 可达成；先用 M0/M1 实测验证，再谈任何 fork。**

## 5. 架构原则

1. **插件优先**：一切定制 = 扩展包 + 配置（settings / models / mcp / skills），pi 源码零修改是默认态。
2. **fork 是最后手段**：仅当扩展 API 确认做不到时薄 fork，改动最小化、争取回流上游 PR、定期 rebase。
3. **摩擦日志驱动**：日常使用每次「这不行」记一条；只有反复出现的摩擦才立项。
4. **升级纪律（已定案）**：锁版本使用，不逐版追逐；**按批次升级**——默认每月一次，或摩擦日志出现「新版才修复/才有」的项时提前。每次升级执行适配四步：
   ① 比对锁定版 → 目标版之间的 CHANGELOG，重点扫 breaking changes 与自己依赖面相关的条目；
   ② 跑冒烟测试集（覆盖扩展包实际用到的 pi API）；
   ③ 修复扩展包/配置中受影响处；
   ④ 更新锁版记录（版本号 + 日期），同步订正文档中的现状断言。
   当前锁定：**0.99.2（2026-10-01）**。
5. **桌面壳不做第二真相源**：会话与状态真相在 pi，壳只渲染与操控（旧 PAO 控制协议教训的简化版）。

## 6. 路线（慢推，每步以真实使用验收）

- **M0 裸奔周（零代码）**：GLM 经 `models.json` 接入（参考 `docs/custom-provider.md`、`docs/models.md`），原生 pi 顶日常杂活，建摩擦日志。验收：连续 3 天日常活用 pi 完成。
- **M1 扩展包骨架**：新仓库（命名待定，按工作区公约配 AGENTS.md）；移植高频 skills、挂 MCP（番茄下载器桥 / codebase-memory）、系统提示词定制；消化摩擦日志 top 项。
- **M2 记忆与蜂群**：文件式部门知识库最小版（不搞注入式记忆，方案见 `v2-ARCHITECTURE.md`）；蜂群最小闭环——部门配置、卡片协议、`/队列` 治理、后台子代理（pi 子进程 + 结果回填 + 交付唤醒，参考旧 worker-spawner 思路但砍掉状态机）。
- **M3 桌面壳（二期）**：纯壳经 RPC 驱动 pi；动手前先读 `docs/rpc.md` 与 `docs/rpc-extension-ui.md`。
- **持续**：升级纪律运转；摩擦日志滚动。

## 7. 旧 PAO 资产处置（建议，待确认）

- 无论取舍：**D:\PAO 的 167 项未提交变更先 commit 存档**（无远端、仅此一份，是唯一参考材料）。
- 保留复用：`docs/code-audit/pi-capabilities.md`（能力审计范式与已知坑，如 setThinkingLevel 污染全局设置）、`prompts/`、冒烟测试思路、worker spawner 思路（M2 参考）。
- 不复活：Kernel / 编排 / 控制协议 / Desktop。

## 8. 待验证清单（M0/M1 中核实）

- GLM 经 OpenAI 兼容端点的思考档位、工具调用、上下文溢出识别的实际表现。
- ZCode skills 的 SKILL.md 与 pi skills 格式的兼容度（`docs/skills.md`）。
- 番茄下载器桥、codebase-memory 以 MCP 方式挂载的实测。
- virtual models 路由多模型的实测。
- Windows（Git Bash / PowerShell）日常坑。
