# fork 运行与路由审查（2026-10-14）

本轮只读审查当前工作区（包含既有未提交修改），没有修改生产源码或测试，没有读取正式 PAO_HOME，没有调用真实模型。

## 已确认发现

### P1：预算提醒轮被父运行器提前终止

- 位置：`PAO/packages/coding-agent/src/pao/worker/runner.ts:482`；子会话例外在 `worker/budget.ts:103-119`，回执工具豁免在 `worker/budget.ts:124-128`。
- 真实入口：单卡和扇出共用 `worker/dispatch-core.ts:827-846`，剩余卡预算传入 `runner.run`。例如 turns=1，第一轮调用工具后还需一轮输出最终回执。
- 子会话明确定义“到线最多放行一次回执提醒轮”，但父运行器仅判断 `开始轮次 > budget.turns`，没有提醒/回执例外。第二个 `turn_start` 一到就启动树杀并记 `budgetReason`；即使回执在停止完成前输出，也按失败结算。
- 影响：单独预算门的测试允许完成，实际派发却会丢失最终回执或把完成记失败；这是同一预算两层规则冲突。
- 依据：现有离线真实 AgentSession 用例 `worker-budget.test.ts:135-143` 已运行通过（1 passed / 11 skipped），证明 turns=1 的第二次请求是有意放行。历史 R40 计划也明确这项例外，没有发现父运行器应故意取消该例外的依据。
- 隔离协议模拟输出：`{"scenario":"worker-reminder-protocol-simulation","status":"failed","stopReason":"budget:turns","summary":"预算已耗尽：turns；执行已停止"}`。模拟子进程按真实 turn_start/message_end 形状发事件，未启动真实模型；尚未运行完整正式 CLI + 模型集成。
- 建议：两层共用相同预算状态/通知语义；父层作为失控兜底时也须识别唯一回执提醒轮，不能直接删除父层预算限制。

### P2：编辑含斜杠的模型 ID 会保存成错误模型

- 位置：`PAO/packages/coding-agent/src/pao/routing/model-command.ts:135`。
- 真实入口：`/pao model` → 编辑档位 → 从物理模型列表选择 OpenRouter 模型 → 确认。
- 原因：列表选项先由真实 provider/model 拼接，再 `split('/')` 只取前两段。模型 ID 本身支持斜杠，例如仓内 `packages/ai/test/context-overflow.test.ts:544` 使用 `getModel("openrouter", "anthropic/claude-sonnet-4")`。
- 使用真实命令处理器、模拟 UI 回答的隔离复现：选中 `openrouter/anthropic/claude-sonnet-4`，实际保存 `{"provider":"openrouter","model":"anthropic"}`，同时提示“已写回并重注册”。随后虚拟路由按错误 ID 查模型而失败（`routing/tiers.ts:30-32`）。
- 建议：下拉选择直接保留被选模型对象；手输仅按第一个斜杠分开供应商与完整模型 ID。

### P2：向忙碌部长插话会丢失，却报告已注入

- 位置：`PAO/packages/coding-agent/src/pao/host/host.ts:625-626`；用户可达入口 `host/tools.ts:74-75,136-138`（拉起/复用会话的 first_message）。
- 触发：部长已有任务在运行，主控再次调用 `pao_spawn_minister` 并提供 first_message，复用热会话后插话。
- 原因：inject 发普通 RPC prompt，不指定 streamingBehavior，也不等 RPC 确认。上游 `modes/rpc/rpc-mode.ts:398-411` 传入这个空值；`core/agent-session.ts:1976-1980` 明确拒绝忙碌时没有 steer/followUp 的输入。宿主只处理 `entry.任务.id` 匹配的失败响应（host.ts:441），不跟踪 inject 的请求 ID。
- 隔离模拟 RPC 复现：第二次 `inject` 返回 `{"ok":true}`，子进程实际响应 `{"type":"response","command":"prompt","success":false,"error":"Agent is already processing. Specify streamingBehavior"}`。这是协议模拟，拒绝条件已与真实上游源码核对，没有宣称真实模型端到端已验证。
- 影响：用户以为补充指令已送达，部长实际继续按原指令执行；同一 inject 的监督投递也受影响。
- 建议：明确插话应即时干预还是排队续办，再传 steer/followUp；按请求 ID 等待成功确认后再报告注入成功，失败保留可重试信息。

## 检查与边界

- 已读 worker/、host/、runtime/、routing/ 的主要运行器、派发、停止、进程表、锁、预算、RPC、路由与上游 AgentSession 接缝；仓内未找到单独的 pao/launch 目录。
- 已使用 codebase-memory-mcp 查询 inject、executeTask、registerSessionBudget、resolveDispatchParameters、editTierFlow，索引为 2026-10-10，结论均以当前源码再核实。
- 额外定向验证：`runtime-control.test.ts` 与 `runtime-fetch.test.ts` 共 8 项通过；未运行全量测试、构建或线上集成。
- 证据脚本：本目录 `runtime-review.mjs`。专用隔离数据在 `review-fixture/`；脚本启动的子进程均已停止。
