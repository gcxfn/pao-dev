# dispatch 输入升版运行时回流报告

## 结论

本切片已完成并冻结。`onReferenceImpact` 已从只发通知接成实际运行时回流：

- 进行中的受影响 attempt 会按完整卡路径与冻结 attempt 精确停止，并等待真实 `StopProof`。
- 停止前重读卡，核对影响事件记录的 `status`、`attempt` 和 `owner`；迟到事件不会停止已经进入的新 attempt。
- 待执行卡保持原状态时，只通知“受影响输入失效、需补输入并复核”，不调用停止、不改卡。
- 停止失败或空 `StopProof` 明确报 `stop unknown`、需人工核验，保留锁与占用，并让保存工具返回错误。
- 旧卡定义、输入快照、执行绑定和旧 attempt 证据不被改写；没有调用永久 `cancel`。
- 实际派发链把普通 `canceled` 旧回执落卡后，测试由 owner 经现有合法状态机复核并重派 attempt 2。

最终定向结果：`runtime-impact.test.ts` 共 6 个测试全部通过，退出码 0。既有 CLI 装配结果为 2 个测试全部通过，但本轮收尾没有重复运行它。

## 实际改动

| 文件 | 改动 |
|---|---|
| `PAO/packages/coding-agent/src/pao/index.ts` | 将 `onReferenceImpact` 接到 `reconcileDispatchReferenceImpact`，等待回流完成后才返回工具结果；callback 仍为 `void \| Promise<void>`。 |
| `PAO/packages/coding-agent/src/pao/runtime-impact.ts` | 按事件记录的身份与状态处理 active 精确停止、pending 输入失效通知、迟到事件和停止未知。 |
| `PAO/packages/coding-agent/test/pao/runtime-impact.test.ts` | 覆盖真实工具入口、真实离线 Node 子进程、精确停止、pending、停止失败、空凭据及真实派发链回执后的合法重派。 |
| `PAO/packages/coding-agent/test/pao/index-wiring.test.ts` | 保持 CLI 单卡、扇出和 worker 角色装配测试；本轮只做了 Biome 要求的测试写法收口。 |

`role.ts` 在本轮没有新增改动，仍属于前序 dirty 写集；本轮没有跨改 `cards/`、`worker/dispatch-core.ts`、`worker/index.ts`、runner、lock、desktop。

## 关键行为

### active 回流

1. 从影响事件取得卡路径、事件记录的状态、attempt、owner。
2. 停止前重读当前卡。
3. 状态、attempt 或 owner 已变化时，只通知事件过期。
4. 状态仍为 `in_progress` 且身份一致时，调用：

```ts
await runner.stopCurrentAttempt(cardPath, attempt)
```

5. 只有 `proof.stoppedProcesses.length > 0` 才报告已停止。
6. 停止抛错或空凭据都通知 `stop unknown`，要求人工核验。代码不自行释放锁；派发链原有的 finally 仍会按现有 `confirmStopped` 逻辑收尾。

回流不写卡、不 append 第二份回执，也不直接释放锁。既有派发链在拿到真实回执后按原路径落卡，随后自行完成停止确认和资源释放。

### pending 回流

影响事件记录状态为 `unclaimed` 或 `failed`，且重读后状态、attempt、owner 未变化时：

- 通知“受影响输入已失效，需补输入并复核”；
- 不停止任何进程；
- 不修改卡状态；
- 不把保持 pending 误报为“事件已过期”。

无关 pending 卡由影响计算列入 `ignored`，不产生通知。

### 旧 attempt 与新 attempt

真实派发链测试使用实际 `executeDispatch`、实际回执落卡和真实离线 Node 子进程。旧 attempt 停止后：

- 派发链落下的回执为 `canceled`，且没有 `failure_type` 或 `任务态`；
- 回执本身没有自动把卡改为终态，卡仍为 `in_progress`，等待 owner 处理；
- 测试直接由 owner 使用现有状态机执行 `in_progress → failed(missing_input)`，再执行 `failed → unclaimed`；
- 再次派发后卡进入 attempt 2，真实子进程启动；
- attempt 1 的回执内容仍与重派前一致，旧证据继续可读。

这条测试验证的是现有回流机制：普通 `canceled` 如实记录 worker 已停止，不自动改变卡状态，也不自动转换为其他失败类型；owner 读取旧回执后，按现有合法状态机决定复核和重派。人工 owner 复核是本轮明确边界，不再增加自动转换字段或机制。

## 验证

### impact 最终定向测试

命令：

```powershell
Set-Location D:/AI/workspace/pao-dev/PAO
node node_modules/vitest/vitest.mjs run `
  --config packages/coding-agent/vitest.config.ts `
  packages/coding-agent/test/pao/runtime-impact.test.ts `
  --maxWorkers=1 --no-file-parallelism --reporter=verbose
```

进程临时目录同时设置了 `TMP`、`TEMP`、`TMPDIR`：

```text
D:/AI/workspace/临时文件夹/地图简报验证-20261020/runtime-impact-final-20261021
```

真实结果：

```text
Test Files  1 passed (1)
Tests       6 passed (6)
Exit code   0
Duration    46.07s
```

证据：`.pao/地图简报与部门协作-20261020/runtime-impact-r9.log`

六个通过项：

1. 保存升版后只停止受影响的当前活动 attempt，保留旧证据。
2. 迟到 impact 不停止新 attempt，也不影响无关卡。
3. 停止失败显式报 unknown、保留占用并让工具失败。
4. 空 `StopProof` 不冒充停止成功。
5. pending 输入失效正确通知，无关 pending 不通知。
6. 真实派发链落旧回执后，owner 经合法状态机重派新 attempt，旧证据可读。

r10 是在主审确认 r9 后才启动的重复运行，完成结果同为 6/6；不作为新验收依据，冻结引用以 r9 为准。

### CLI 装配回归

既有日志：`index-wiring-regression-r1.log`

```text
Test Files  1 passed (1)
Tests       2 passed (2)
Exit code   0
Duration    12.74s
```

覆盖：

- 真实 `pao_dispatch_card.execute` 进入 `WiringRunner.run`；
- 真实 `pao_fanout.execute` 进入 `WiringRunner.run`；
- worker 角色保留真实侦察保存工具，不暴露递归派发、建树、整合、普通改卡和交回执入口。

该测试的 runner 是测试替身，只证明装配与工具路径；不能替代 impact 测试中的真实 `WorkerRunner` 子进程结论。

### 类型与格式

- 本切片生产类型检查有通过记录：`tsc --noEmit -p packages/coding-agent/tsconfig.build.json`，退出码 0，证据 `runtime-impact-tsc-r2.log`。该日志内容为空。
- 收尾时主审报告 baseline 已恢复且主生产 `tsc` 实际退出码 0；按主审安排，本轮没有再启动全局类型或集成验证。
- 收尾对 `runtime-impact.ts` 和 `runtime-impact.test.ts` 的 Biome 检查通过。`index-wiring.test.ts` 的原有格式问题已按 Biome 安全项修正，但修改后没有再次运行该测试；因此其 2/2 结果只证明修正前语义，修正仅涉及类型写法和格式化。

## 证据边界

| 项 | 性质 |
|---|---|
| Git | 真实临时 Git 仓库，执行 `init/add/commit`。 |
| 工具入口 | 真实 `pao_dispatch_brief.execute` 和 `executeDispatch`。 |
| WorkerRunner | impact 主例、迟到例、停止失败例和 attempt 2 恢复例使用真实 `WorkerRunner` 与离线 Node 子进程；不是模型 worker。 |
| 回执落卡 | attempt 2 恢复例走真实派发链的 `appendDispatchReceipt`。 |
| CLI 装配 | `WiringRunner` 是覆写 `run` 的测试替身。 |
| 真实模型 | 未调用。 |
| Electron/桌面 | 未验证，且本轮未修改桌面。 |
| 全量测试 | 未运行。 |

## 残留进程

最终查询没有找到本测试残留的 `runtime-impact.test.ts`、vitest worker 或本次临时目录相关进程；只匹配到执行查询自身的 PowerShell 进程。

另有一个更早启动、命令为 `node -e "setInterval(()=>{},1000)"` 的 PID 30696，父 PID 29232，创建于 08:56:44。其命令不指向本轮临时目录，不能确认由本测试创建，因此没有擅自清理；主审若确认归属其他组，应交给对应负责人处理。

## 冻结哈希

```text
1F81DA870B471899A693AD3E2EE4B0E1F2ADDA785425723D7DAE04325CDA9F50  PAO/packages/coding-agent/src/pao/index.ts
39FEEE32A0844926BACB2F0F338D0A6BFCAA7277FDBB29BAB1A33303EEFD0D6B  PAO/packages/coding-agent/src/pao/runtime-impact.ts
D5B75B320DB7CFBC533952CEFB0F52DB0EDDED1690661C1987287849EE2F9360  PAO/packages/coding-agent/test/pao/runtime-impact.test.ts
D5A3C5CF1B76E67843FFC5332B0605C3EFAF6A236E4AAD932EB6DE777D777A8D  PAO/packages/coding-agent/test/pao/index-wiring.test.ts
0880FE637722A933C335B6243F548B771EAC8B9751284DF78906A1B0D39018BD  PAO/packages/coding-agent/src/pao/role.ts
```

## 未完成

- pending 旧引用的持久 precheck/verify 由 C 模块负责；本切片没有另建任务状态源。
- 系统输入升版停止后使用普通 `canceled` 回执，并由 owner 沿现有状态机复核和重派；没有新增自动转换失败类型的任务要求。
- 本切片没有验证真实模型、Electron/桌面、真实协作质量或全量回归。
- CLI 两例在收尾格式化后未重跑；全局类型与集成验证按主审安排统一执行。
