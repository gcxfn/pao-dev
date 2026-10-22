# H-C2 独立审核

审核日期：2026-10-22

## 结论

C2 的审核和复修已完成，可以进入最终构建：重开具备原实例、owner、节点、轮次、现场核查、卡状态、当前回执和活工人检查；旧卡与旧轮历史保留；实例级暂停和叫人记录不再被单节点重开清除；独立旁支的节点控制数据不被重置；工具入口要求界面确认；完成、暂停或异常退出后的部长收场统一按原实例脉络和项目根收窄。定向测试实际通过。

本轮只修改了以下产品边界：

- [control.ts](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/workflow/control.ts:712)：`reopenControl` 保留实例暂停与叫人记录，恢复继续走既有 `resumeControl`。
- [host-bridge.ts](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/workflow/host-bridge.ts:374)：`drive` 的正常、暂停和异常收场共用隔离失败的逐部长停止逻辑。
- [workflow-reopen.test.ts](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/test/pao/workflow-reopen.test.ts:79) 与 [workflow-host-bridge.test.ts](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/test/pao/workflow-host-bridge.test.ts:141)：增加本轮反例回归。

主控已同步更新 `tools.ts` 的工具描述，明确“重开保留暂停，继续推进另用 resume”；本次没有修改该文件。

其余检查未发现能够确认的重复派发、旧回执冒充、独立旁支被节点重置或跨项目部长被收场的问题。未运行付费模型和真实四部门闭环，因此本文不宣称实机闭环已通过。

## 修复结果

### 1. 重开保留实例级保护

原实现会在 [control.ts](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/workflow/control.ts:712) 的 `reopenControl` 成功后清除实例级 `暂停` 和 `叫人`，导致单节点修复顺带解除其他旁支的停止条件。现在只重置目标节点、递增轮次和清空目标节点的部长绑定，`暂停` 与 `叫人` 保持原值。

[workflow-reopen.test.ts](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/test/pao/workflow-reopen.test.ts:79) 会先设置暂停和叫人记录，再重开目标节点，核对轮次已变、暂停和叫人仍在、实例仍为挂起；随后调用既有 [resumeControl](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/workflow/control.ts:894)，确认暂停被显式清除且节点保持新轮。

### 2. 收场失败不覆盖业务结果

原 `drive` 的 `catch` 会直接循环停止部长，后续 `finally` 又会读取控制、后台状态并停止部长；任一步抛错都可能覆盖正常报告或原始业务异常。现在：

- 异常暂停落盘失败只通过 `shared/log.ts` 的 `logWarn` 告警，原始业务异常继续原样抛出。
- 收场前重新读取控制正本，并核对实例仍是本次启动的实例；读取失败或实例已切换时跳过部长停止，不使用旧 `flow` 归属盲杀。
- 每个部长分别读取后台状态、尝试 `teardown`。后台状态读取失败会保留该部长并继续下一个；停止失败会保留宿主失败登记、告警并继续下一个。
- 告警包含原实例、部门、部长会话、项目根和真实异常。
- 所有收场异常都在 `finally` 内隔离，不 `return`、不重新抛出，因此完成的报告和原始业务异常都不会被替换。

新增反例分别验证了：多个部长中第一个停止失败不影响第二个；控制正本读取失败时仍返回已完成报告且不调用部长停止；原始业务异常相同时，异常收场第一次停止失败不影响第二个部长尝试，最终仍抛出同一原始错误对象。

## 已核实保护

### 顺序与重复派发

`reopenControl` 先持有控制文件的 `.dispatch` 锁，再进入 `mutate` 的主控文件锁；`runAutoChain` 的 v2 路径使用相同锁顺序，未发现反向锁序。重开在持锁后重新读取控制正本，并核对实例、原 owner、当前 owner 会话、节点、轮次和现场核查。旧轮身份随后因轮次不符无法继续拆卡；测试覆盖了旧身份交卡被拒绝。

单卡和扇出派发路径没有直接持有 `.dispatch` 锁，但执行链在派发前重读控制、认领后卡变为 `in_progress`，且最终派发保护会再次核对身份与卡状态。仅凭“外层未持锁”不能证明存在重复派发；本次没有找到可确认的重复执行路径。

### 节点、旁支与历史

- `descendantNodeNames` 从目标节点沿依赖向下计算受影响集合；重开只重置目标节点，不重置旁支节点。
- 重开前会拒绝已经启动或产生结果的下游节点，避免只重开目标却留下下游成果。
- `resetNodeRound` 保留旧卡映射和旧判定，递增轮次，清除本轮拆解、确认、判定、零卡理由、基线及放行状态；回边和目标节点重开共用这一规则。
- 独立旁支绑定部长后，目标节点重开不会改变旁支当前控制数据；测试实际覆盖。

### 卡、回执与活工人

- 当前节点存在 `in_progress` 或 `delivered` 卡时拒绝重开。
- 未认领卡带当前 attempt 的回执、同一当前 attempt 有多条回执、回执 attempt 超前时拒绝重开。
- 已失败卡上的单次当前回执允许保留后重开，不删除原回执证据。
- 即使卡仍为未认领，登记中仍在运行的工人也会阻止重开；进程匹配支持卡路径以及卡号加任务根两种身份。
- 已完成节点或已完成实例不能通过重开重复派发。

### 工具入口

`tools.ts` 把 `reopen` 纳入与 `confirm`、`resume` 相同的界面确认条件；没有界面或用户拒绝时，不会进入 `reopenControl`。主控已把工具描述更新为“重开保留实例暂停，恢复推进另用 resume”。测试实际验证了无界面拒绝和确认后轮次由 1 变为 2。

### 生命周期收场

- 收场先确认最新控制正本仍是本次原实例，再只选择与其 `脉络` 相同、项目根规范化后相同的部长句柄；控制读取失败或实例已切换时跳过停止。
- 存在当前脉络运行中工人时，不释放部长。
- 对每个部长单独检查其后台在途数，有后台任务的部长保留，确保完成投递仍有接收者。
- 异常收场中，单个部长的后台状态读取或停止失败只告警，后续部长继续独立尝试；宿主失败登记保留。
- 显式暂停和完成会释放闲置部长；独立脉络或其他项目的部长不会被本轮收场。

`hold`、失败等非显式暂停路径保留部长，可能是为了等待人工处理和结果投递。本次没有足够证据把它判为错误；相应生命周期组合仍属于测试缺口。

## 代码图核查

使用项目 `D-AI-workspace-pao-dev-PAO` 查询了现有索引。`index_status` 显示索引时间为 `2026-10-22T07:31:16Z`，早于本次 C2 新函数改动，因此：

- `drive` 的调用关系可以查到。
- `reopenControl`、`resetNodeRound`、`descendantNodeNames` 均返回零节点，属于索引陈旧后的缺失证据，不能据此判断函数不存在。
- 本文对这些新函数的结论来自当前源码、与 `before/` 的差异及实际测试。

## 实际验证

工作目录：`D:/AI/workspace/pao-dev/PAO/packages/coding-agent`

Node：`C:/Program Files/nodejs/node.exe`

| 命令 | 结果 |
|---|---|
| `& 'C:/Program Files/nodejs/node.exe' 'D:/AI/workspace/pao-dev/PAO/node_modules/vitest/vitest.mjs' run test/pao/workflow-reopen.test.ts test/pao/workflow-host-bridge.test.ts` | 2 个测试文件、45 项测试通过，耗时 9.57 秒 |
| `& 'C:/Program Files/nodejs/node.exe' 'D:/AI/workspace/pao-dev/PAO/node_modules/vitest/vitest.mjs' run test/pao/workflow-control.test.ts test/pao/workflow-reopen.test.ts test/pao/workflow-host-bridge.test.ts test/pao/workflow-tools.test.ts` | 4 个测试文件、101 项测试通过，耗时 10.75 秒 |
| `git diff --check -- <本轮四个产品文件>` | 通过，无空白错误 |

## 边界与未验证

- 已修改：`control.ts`、`host-bridge.ts`、`workflow-reopen.test.ts`、`workflow-host-bridge.test.ts` 和本报告；`tools.ts` 的文字由主控另行更新。
- 已检查：本批指定源码和对应 `before/` 差异、当前 `resume` 与工具入口，以及本批相关测试。
- 实际运行成功：上述定向 Vitest 测试和差异格式检查。
- 未运行：付费模型、真实四部门完整闭环、正式 `PAO_HOME`、全部内核回归、完整类型检查。
- 本批测试使用模拟宿主和真实磁盘控制正本；它们不能替代真实宿主 RPC 生命周期验证。
- 未清理工作区中其他代理的并行产物，也未运行正式 `PAO_HOME`。
