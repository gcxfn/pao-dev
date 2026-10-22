# 批次 E：监督通知修复报告

## 结论

本次确认并修复了两个真实的通知面缺陷：

1. 普通进度原先也调用 `triggerTurn`，会让没有业务变化的轮询凭空启动模型轮次。
2. 第一版修复只阻止了 `progress` 主动唤醒，但 `unreadCount()` 仍把通知正文条数当成“需要处理数”。于是仅有 `progress` 时，后台端口仍报 `unread > 0`，print 模式会继续等待，父宿主也可能把部长完成误判成仍有子后台未读。

最终口径是：`progress` 正文仍进入通知缓冲，留到下一次真实回合注入；它不计入“需要处理的未读”，也不主动唤醒。未传 `category` 的旧调用仍按终态处理，保留原有唤醒与未读行为。

定向回归已经从当前源码通过。主控统一 23 文件长测的旧结果保留，不覆盖；它启动时尚未加载最终 `unreadCount()` 实现，所以两条 `worker-notify` 新测试得到“期望 0、实际 1”。当前源码单独复跑为 2 个文件、22 项全部通过。

## 通知类别与接线

`DispatchNotifyOptions.category` 的取值为：

| 取值 | 行为 |
| --- | --- |
| `progress` | 只缓冲正文和发送可选 toast，不启动模型，不计入后台“需要处理数” |
| `result` | 完成结果，主动唤醒 |
| `failure` | 失败或投递失败，主动唤醒 |
| `ruling` | 人工门、待裁定或需要上级决策，主动唤醒 |
| `supervision` | 15/30 分钟监督到期，主动唤醒 |
| 未提供 | 保留旧行为，主动唤醒并计入未读 |

类别由调用方显式提供，不从正文或自然语言关键词猜测。工作流已用 `AutoChainReport.waitingForEvent` 区分普通等待和终态：正常等待事件标为 `progress`，完成标为 `result`，其他停因标为 `ruling`。主控已经补齐 `index.ts` 和 `host/tools.ts` 的类别透传；本代理没有修改这两个主控文件。

没有增加 500ms 合并定时器。现有 `wakePending` 会在通知正文真正注入前合并同一批终态；注入后紧接着发生的新终态属于下一轮，必须按新事件处理。本次实际通知的条件重放没有证明需要额外计时器。

## 最终通知面语义

`unreadCount()` 现在只统计 `category !== "progress"` 的缓冲项。没有另建 `actionableCount` 或第二份状态：

- `buffer` 仍是正文的唯一存储；
- `progress` 仍在 `buffer` 中，随后被正常注入并消费；
- 主动唤醒只由显式终态类别触发；
- 终态正文注入前连续到达时，由 `wakePending` 合并；
- 通知面的变化订阅仍会收到 `added` 事件，后台端口只根据新的 `unreadCount()` 判断是否需要继续等待。

这使 `createBackgroundHost` 的真实端口在“无 running、仅有 progress”时返回 `{ running: 0, unread: 0 }`，`hasBackgroundWork()` 为 `false`；正文没有丢失，下一次真实回合仍能读到。

## 修改文件

产品代码：

- `PAO/packages/coding-agent/src/pao/worker/notify.ts`
  - 新增显式通知类别；
  - `progress` 不主动唤醒；
  - `unreadCount()` 排除 `progress`，同时保留正文缓冲和旧默认类别行为。
- `PAO/packages/coding-agent/src/pao/host/host.ts`
  - 通知和本地通知回调透传 `DispatchNotifyCategory`；
  - 完成、失败、待裁定、监督到期和普通提示线分别标记正确类别；
  - 延迟结果投递保留类别。

测试：

- `PAO/packages/coding-agent/test/pao/worker-notify.test.ts`
- `PAO/packages/coding-agent/test/pao/runtime-background.test.ts`
- `PAO/packages/coding-agent/test/pao/host-tools.test.ts`
- `PAO/packages/coding-agent/test/pao/index-wiring.test.ts`
- `PAO/packages/coding-agent/test/pao/host-supervision.test.ts`

`src/pao/supervision/state.ts` 和 `src/pao/host/events.ts` 已核实，未发现本次需要修改的确定缺陷。

## 验证证据

以下命令均在 `PAO/packages/coding-agent` 执行，使用现有 Node 与 `node_modules`，没有安装依赖。

```powershell
& 'C:\Program Files\nodejs\node.exe' '..\..\node_modules\vitest\vitest.mjs' --run `
  test/pao/worker-notify.test.ts `
  test/pao/runtime-background.test.ts
```

结果：2 个文件通过，22 项通过。直接覆盖了 progress 不计未读、正文仍可注入，以及真实 `createBackgroundHost` 端口 `running=0/unread=0`、`hasBackgroundWork=false`。

```powershell
& 'C:\Program Files\nodejs\node.exe' '..\..\node_modules\vitest\vitest.mjs' --run `
  test/pao/host-tools.test.ts
```

结果：17 项通过。远端 ack 经父宿主真实 `tool_execution_end` 核验后投为 `progress`，不主动唤醒；通知正文仍可从共享通知面注入。

```powershell
& 'C:\Program Files\nodejs\node.exe' '..\..\node_modules\vitest\vitest.mjs' --run `
  test/pao/index-wiring.test.ts `
  test/pao/supervision-state.test.ts `
  test/pao/host-supervision.test.ts `
  test/pao/host-lifecycle.test.ts `
  test/pao/host-events-wire.test.ts
```

结果：5 个文件、60 项通过。覆盖真实主控装配中的 progress/result 分派、15/30 分钟可控时钟、ack 后的处理范围、事件解析和部长生命周期。

主控统一 23 文件回归记录为 `.pao/具体故障修复-20261022/checks/kernel-tests.json`（417 通过、2 失败；生成时间 16:12:27）。该文件原样保留，未覆盖。统一回归启动于 15:59，早于最终 `unreadCount()` 修复；Vitest 进程预载了旧模块，因而旧测试与最终源码不一致。上述当前源码定向复跑已确认最终实现稳定。

类型检查命令：

```powershell
& 'C:\Program Files\nodejs\node.exe' '..\..\node_modules\typescript\bin\tsc' --noEmit -p tsconfig.build.json
```

结果：退出码 0。

## 监督到期与 ack 作用域

已用当前源码和可控时钟核实：

- 工人提醒按部门、项目根、`context` 和可用的 `sessionId` 精确匹配；
- 本地部长 ack 校验部门、项目根和 `context`；
- 远端 ack 校验真实 RPC 会话、对象 route 和可选 `sessionId`；
- 错误 key、错误会话或错误作用域不会重置监督；
- 未注入不阻止重试，已注入但未显式处理时不会按同一周期重复唤醒；
- `completed`、`failed`、`needs_ruling` 和 `canceled` 退出周期监督，其中前三类按结果语义投递给直接上级。

现有测试没有暴露必须修改的 due 或 ack 作用域缺陷，因此没有为了“看起来更严”增加额外条件。独立并行 `context` 继续保留；部长 teardown 按部门、项目根和 `context` 定位，不删除其他并行实例，也不删除独立旧 `context`。

## 原 15/30 分钟未提醒：未定位

原运行约 47 分钟内有 93 个 assistant `message_end`，但这不是 93 次后台通知；真实的自定义通知只有 6 条，其中两条相隔约 344ms。因此不能把总运行时长直接等同于一个监督对象的完整计时时长，也不能据此断言计时器错误。

原运行没有 `[监督检查]` 正文，也没有成功的 `pao_ack_supervision` 调用。现有日志不足以还原活动记录连续存在、消失、重建的具体时刻，不能证明某个记录确实连续跨过完整 15 或 30 分钟。**原始未提醒的具体原因仍未定位，保留为未知，不作“计时真实缺陷”的硬改。**

可控时钟重放只证明当前状态机和接线在记录连续存在时会在 15/30 分钟到期，并证明 ack 后重新计时、显式 0 关闭、旧轮次监督默认关闭；它不能替代对原始运行活动序列的完整重放。

## 边界与未验证

- 未运行付费模型，未使用正式 `PAO_HOME`。
- 未独立运行全包 build、gates 或全量测试；主控统一回归和后续重建由主控负责。
- `host-bridge.ts` 未修改。替代实例的旧部长是否自动收场由主控在 bridge/lifecycle 边界处理；本次通知类别和 teardown 作用域修改与该边界没有直接冲突。
- 原始 15/30 分钟未提醒的具体原因未定位，见上一节。
