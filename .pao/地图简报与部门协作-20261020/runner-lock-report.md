# Worker 锁与派发名额收口报告

日期：2026-10-20

## 结论

本轮 D 项已形成可主验收切片：

- 共享派发名额的检查与预约写入已在同一个跨进程短锁内完成。
- 损坏或半写预约按未知占位计数，不自动清零；owner 死亡不自动回收预约。
- 执行锁取得后取消会回滚租约并清理本次占位。
- 执行锁释放按“租约已释放”和“占位待删除”分阶段保存，失败重试不会重复释放租约。
- 执行根守卫覆盖同根清理与新派发互斥；坏执行占位返回 `unknown`，不当作安全的 `idle`。
- 真实双子进程 `cap=1`、坏预约、owner 死而 worker 活、无停止证明保锁、审计写入失败、守卫跨进程互斥等反例均通过。

本组最终组合测试 36/36 通过；当前内核生产构建类型检查退出 0；写集差异空白检查通过。

## 实际改动

### `PAO/packages/coding-agent/src/pao/worker/runner.ts`

- 新增可选 `dispatchStateRoot`。正式入口已将共享根注入到 `$PAO_HOME/派发状态`；没有注入时保留原有单 runner 名额口径。
- `reserveDispatchSlot` 在共享根存在时使用既有 `withFileLock`，在同一事务中读取预约、统计外部活进程与未知占位、校验上限并原子写入预约。
- 同卡重复预约直接核对全部持久预约身份；其他进程已持有同一卡时拒绝，不写第二条预约。
- 任一损坏或缺身份预约都视为未知占位；即使总上限仍有余量、具体部门上限也未从记录中可见，也明确拒派并保留原文件。
- 预约文件只保存身份、部门、owner pid、创建时间和预约令牌；不按 owner pid 是否存活自动删除。
- 无共享根路径继续计入 runner 登记表中的活进程；有共享根时排除已有持久预约，避免同一个活进程重复占位。
- 停止审计补记 `cancel-start`、`cancel-confirmed`、`stop-failed`，停止失败仍上抛。

### `PAO/packages/coding-agent/src/pao/worker/lock.ts`

- 执行锁使用持久占位 `执行占位.json`，只有合法 `StopProof` 的释放路径可移除。
- 执行锁在取得租约后取消时，先回滚租约，再删除本次占位；任一步失败均保留现场并报告。
- 释放句柄保存 `lease-held` / `lease-released` 阶段。租约成功后，占位删除失败可安全重试，且不会重复释放租约。
- 审计日志写入失败会报告文件路径、错误码与嵌套 cause；互斥状态不受影响。
- `detectExecutionOccupancy` 读取持久占位内容：合法记录为 `active`，半写、缺身份、读取异常为 `unknown`，只有明确无占用才是 `idle`。
- `acquireExecutionRootGuard` 提供任务根侧跨进程守卫，供执行根清理和同根派发互斥。
- `prepareExecutionRootForRemoval` 只在守卫有效且占用为 `idle` 时处理三类 PAO 运行元数据；非空锁目录、未知占位和其他文件保留。
- `listReleasedExecutionArtifacts` 只列出实际存在的锁 marker、空锁目录和派发日志，不读取坏占位，不递归。
- `retainDispatchLock` 记录的停止未确认原因会随最终释放审计保留。

### 测试与夹具

- `PAO/packages/coding-agent/test/pao/worker-lock-boundaries.test.ts`
- `PAO/packages/coding-agent/test/pao/worker-execution-root-guard.test.ts`
- `PAO/packages/coding-agent/test/pao/worker-slot-reservation-child.ts`
- `PAO/packages/coding-agent/test/pao/worker-run.test.ts`

`worker-run.test.ts` 的旧“外部活进程”用例原本只登记裸卡号，后以临时绝对路径查询；这与真实派发登记的卡路径不是同一身份。测试改为登记真实卡路径，并补充同一共享任务根中的独立卡号。产品身份比较未因此增加卡号猜测。

## 真实命令与通过证据

测试临时目录均显式指向工作区：

```powershell
$env:TMP = 'D:\AI\workspace\pao-dev\临时文件夹\地图简报验证-20261020\runner-lock\<子目录>'
$env:TEMP = $env:TMP
$env:TMPDIR = $env:TMP
```

在 `D:\AI\workspace\pao-dev\PAO\packages\coding-agent` 执行：

```powershell
npx vitest run test/pao/worker-lock-boundaries.test.ts test/pao/worker-execution-root-guard.test.ts test/pao/worker-run.test.ts
```

结果：3 个测试文件、36 个用例全部通过。日志：

- `.pao/地图简报与部门协作-20261020/runner-lock-final-combined.log`

```powershell
npx tsc -p tsconfig.build.json --noEmit --pretty false
```

结果：退出码 0，空日志，见：

- `.pao/地图简报与部门协作-20261020/runner-lock-final-tsconfig-build.log`
- 主对话早先独立复跑的同命令空日志：`.pao/地图简报与部门协作-20261020/main-types-stage3.log`

```powershell
git -C PAO diff --check -- packages/coding-agent/src/pao/worker/runner.ts packages/coding-agent/src/pao/worker/lock.ts packages/coding-agent/test/pao/worker-run.test.ts packages/coding-agent/test/pao/worker-lock-boundaries.test.ts packages/coding-agent/test/pao/worker-execution-root-guard.test.ts packages/coding-agent/test/pao/worker-slot-reservation-child.ts
```

结果：退出码 0，无输出。

真实派发主路径：

```powershell
npx vitest run test/pao/worker-dispatch-guards.test.ts -t "真实本地非 Git primary"
npx vitest run test/pao/worker-dispatch-guards.test.ts -t "目标项目已有写锁时拒绝认领"
```

结果分别为 1/1 通过，日志：

- `临时文件夹/地图简报验证-20261020/runner-lock/worker-dispatch-guards-final-main-real.out.log`
- `临时文件夹/地图简报验证-20261020/runner-lock/worker-dispatch-guards-final-lock-main.out.log`

两条路径均使用本地假 worker，不调用模型供应商，不产生费用。

## 反例覆盖

| 反例 | 实际结果 |
|---|---|
| 两个独立进程同时预约 `cap=1` | 恰好一个成功、一个被拒 |
| 半写预约文件 | 计入未知占位，拒绝新预约，文件保留 |
| 总上限 2、部门上限 1、存在一个未知部门占位 | 未知部门不能假定不占该部门，明确拒派且只保留原占位 |
| 两个独立进程预约同一卡 | 一个成功；另一个明确拒绝，持久预约文件仍只有一条 |
| owner 进程退出、它拉起的 worker 仍活 | 预约继续占位，不因 owner pid 死亡删除 |
| 执行锁取得后 signal 取消 | 租约回滚，本次占位删除，可重新取得 |
| 租约已释放、占位删除失败 | 首次失败保留现场；重试只删占位，不重复释放租约 |
| 审计日志写失败 | 报路径、`EACCES` 和 cause；锁仍可正常释放 |
| 无合法 `StopProof` | 拒绝释放，执行锁和持久占位均保留 |
| 坏执行占位 | `detectExecutionOccupancy` 和守卫均返回 `unknown`，不自动删除 |
| 清理守卫持有期间另一进程派发 | 新派发在取得执行根守卫时被拒 |
| 执行锁持有期间另一进程清理 | 守卫观察到 `active`，不进入运行元数据处置 |

## 失败与已解决过程

本轮先补“守卫持有期间新派发”反例，首次运行失败：清理守卫与执行锁原本使用不同锁文件，新派发仍可取得执行锁。证据：

- `临时文件夹/地图简报验证-20261020/runner-lock/worker-lock-boundaries-current.log`

随后按既有派发顺序验证“派发先取执行根守卫，再取执行锁”，守卫持有期间新派发被拒。修正后同组测试通过：

- `临时文件夹/地图简报验证-20261020/runner-lock/worker-lock-boundaries-current-r2.log`

较早的派发主路径曾超时；该失败日志保留：

- `临时文件夹/地图简报验证-20261020/runner-lock/worker-dispatch-guards-main-long-current.log`
- `临时文件夹/地图简报验证-20261020/runner-lock/worker-dispatch-guards-stopproof-long-current.log`
- `临时文件夹/地图简报验证-20261020/runner-lock/worker-dispatch-guards-full-current.log`

整组旧日志为 4 通过、14 失败；其中包含 5 秒超时和一次 `DispatchBriefError: execution_binding_invalid`（`prepared: "git"`、`frozen: undefined`）。后者位于 `dispatch-brief/snapshot.ts` / `dispatch-core.ts`，不属于本写集，未修改。上述旧失败不撤销；最终两条单独主路径复跑通过，但整组在较早时间点并非全绿。

包级测试配置的 `npx tsc --noEmit` 曾失败，错误全部位于其他并行测试文件；日志保留：

- `临时文件夹/地图简报验证-20261020/runner-lock/tsc-noemit-current.log`

生产构建配置 `tsc -p tsconfig.build.json --noEmit` 已单独通过，因此当前没有产品包级类型阻塞。

## 收口清理

已删除仅用于本组诊断的一次性测试文件 `PAO/packages/coding-agent/test/pao/worker-disposable-dispatch-diagnostic.test.ts` 及隔离现场 `临时文件夹/地图简报验证-20261020/runner-lock/tmp-debug/pao-debug-JyV8H3`。删除前均确认位于工作区；未清理其他会话目录或进程。

旧诊断目录 `C:\Users\ASUS\AppData\Local\Temp\pao-guard-debug-J6PTSZ` 已按精确绝对路径复核并删除，删除时其中只有两个空子目录。未清理其他会话目录或进程。

## 未验与限制

- 未调用真实模型供应商，未产生费用。
- 未读写正式 `PAO_HOME`；共享根和临时状态均使用隔离目录。
- 未运行整包全部测试；只运行本组直接边界、接口兼容、两条真实本地派发主路径，以及生产构建类型检查。
- 本轮 runner 侧只能证明持久预约不会因 owner pid 消失被自行删除。主对话已确认 `dispatch-core` 的 `finally` 在停止未确认时仍可能主动调用 `releaseSlot`；该真实派发调用方修复由 Dirac 负责，本轮未跨写 `dispatch-core`。因此 36/36 只覆盖 runner/lock 边界，不能替代真实停止失败主路径复验。
- `reserveDispatchSlot` 当前返回无参数的释放回调，调用方无法从接口层区分“正常释放”和“停止未确认”。主对话已把真实 `dispatch-core` 停止失败路径交给 Dirac；本写集没有修改该调用方，也没有额外发明释放凭据。若最终集成仍允许停止未确认时调用该回调，持久预约会被主动删除，不能把本轮 owner 死亡反例视为已经覆盖。
- `WorkerRunner.isExecutionActive` 仍只查本 runner 的内存状态。跨进程清理判断必须使用 `detectExecutionOccupancy` 或执行根守卫；本次未修改 `pao/index.ts` 的宿主装配。
- 正式 CLI、SDK、桌面宿主是否都正确注入 `dispatchStateRoot` 及执行根守卫，需装配负责人和主验收独立核验。
- 清理工具从“检查到删除”的完整宿主接线由相邻写集负责；本轮只提供并验证守卫、占用检测、元数据处置和清单接口。
- 本轮未提交 Git，未撤销其他会话已有差异。

## 文件边界

本组修改仅涉及：

- `PAO/packages/coding-agent/src/pao/worker/runner.ts`
- `PAO/packages/coding-agent/src/pao/worker/lock.ts`
- `PAO/packages/coding-agent/test/pao/worker-run.test.ts`
- `PAO/packages/coding-agent/test/pao/worker-lock-boundaries.test.ts`
- `PAO/packages/coding-agent/test/pao/worker-execution-root-guard.test.ts`
- `PAO/packages/coding-agent/test/pao/worker-slot-reservation-child.ts`
- 本报告

未修改 memory/context、dispatch-core、cards、workflow、role、core 或 desktop。

