# 内核派发单写者阶段报告（2026-10-20）

## 结论

本轮处于“接口接入未收口”阶段，不能宣称 D 已完成。已恢复父预算池串行队列的调用，并开始按“从未启动 / 已启动 / 已确认停止”阶段处理共享名额与执行根守卫；当前源码还不能编译通过，因此这些修改尚未形成可交付切片。

没有提交代码，没有触碰正式 PAO_HOME，没有终止其他执行者的进程。

## 本轮已改

- `PAO/packages/coding-agent/src/pao/worker/dispatch-core.ts`
  - 恢复 A 基线的 `budgetOwners` + 预算池级 `queueProjectWrite` 调用，目标是让预算重读、认领和启动决策处在同一预算池队列内。
  - 新增 `runnerPhase` 阶段标记：`notStarted | started | stopProven`。
  - 正常释放 execution 长锁后同步标记 `executionStopProven` 和 `stopProven`。
  - finally 改为：只有确认停止或确认从未启动才释放共享名额；运行后停止未知则保留名额并报告。
  - finally 用实际认领卡路径确认停止，避免把初始卡路径当成运行身份。
  - managed guard 在“长锁已成功释放并证明停止”时释放；在取得长锁前失败的回滚路径释放。
  - 保留此前已落盘的正式派发守卫、冻结简报、execution binding、输入升版等未提交修改。

## 真实命令结果

- `npx tsc -p tsconfig.build.json --noEmit --pretty false`
  - 退出码 1。
  - `src/pao/worker/dispatch-core.ts(1028,31)`：找不到 `queueProjectWrite`，因为当前文件尚未导入该函数。
  - `src/pao/cards/integration.ts(290,21)`：`IntegrationRecord` 上不存在 `targetCardsDir`。该文件不在本代理独占写集，未改。
- 此前主兼容快照：43 例，41 通过、2 失败。
  - 证据：`.pao/地图简报与部门协作-20261020/main-compat-stage1.json`
  - 失败集中在 `worker-dispatch-guards.test.ts`：父预算只读子卡未串行；扇出回执落卡失败语义。
- 此前本代理重跑 guards 时，测试环境出现 `pi.sendMessage is not a function` 和多项 30 秒超时；该进程已由本代理停止。不能把这次超时当作产品通过证据。
- 主代理已独立验证：简报 24 例、runner/lock 36 例、桌面 architecture 4 例通过；本轮未重复这些检查。

## 尚未完成

1. `dispatch-core.ts` 补回 `queueProjectWrite` 的精确导入并重新类型检查。
2. 父预算队列必须覆盖锁后预算重读与启动决策，验证同父只读子卡第二张被拒；跨执行根并行不能绕过同一预算约束。
3. 新增 finally 反例：
   - 运行后树杀失败：execution 长锁、managed guard、共享名额均保留。
   - 获取 execution 长锁后、runner 启动前失败：正常释放长锁、guard 和名额。
   - 正常停止：先释放长锁，再释放 guard 与名额。
4. 扇出回执落卡失败：修复 `executeFanout` 当前把卡 0002 显示为“未拉起”而非“失败 + 未落卡 + unknown_outcome”的实际回归。
5. 默认 CLI 无 managed host：普通 primary 必须自动装配 `createSingleRootWorktreeHost`，worker/fanout/workflow 工具实际注册，managed 目标仍明确拒绝。
6. `upstreamBriefReferences` 与 `prepareDispatchBrief` 统一使用 `resolveCurrentAttemptReconRefs` 和当前 `ExecutionBinding`，同时核 `bindingRef` 与 `bindingDigest`。
7. `onReferenceImpact` 从“只通知”接成实际停发/回流：相关 pending 与 active 任务需复核，active 复用 cancel 与 checkpoint 路径，旧 attempt 快照不改；停止失败保锁，无关任务继续。
8. 真实主路径：默认 CLI 普通非 Git 卡、两个不同 managed 执行根时间重叠、同执行根互斥。
9. 角色工具面：主控/worker 实际注册名单测试，worker 即使有 host 也不得获得 worktree 创建/清理、整合或普通 append。
10. 与 Heisenberg 同步 runner/lock 冻结与预约接口。本会话工具面没有可用的代理消息工具，未能直接发送；需要主对话转交。

## 当前进程

- 本轮刚启动的类型检查命令已结束，退出码 1。
- 未发现由本轮刚启动且仍需停止的工具进程。
- 先前本代理启动的 guards session `79489` 已停止。
- 未清理其他执行者的 integration Vitest 进程。

## 共享文件冲突

- `worker/runner.ts`、`worker/lock.ts` 及对应 runner/lock 测试继续冻结，由 Heisenberg 负责。
- `cards/execution-context.ts` 由 Beauvoir 负责，`dispatch-brief/` 由 Copernicus 负责，worktree host 与桌面装配由 Pauli 负责。
