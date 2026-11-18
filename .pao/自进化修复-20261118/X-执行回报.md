# X 组执行回报 — AF05 token 账本 + AF03 验证请求接宿主路由与逐请求许可/预留/结算

日期：2026-11-18。任务书：`.pao/自进化修复-20261118/任务书.md` X 行。来源：`memory-evolution-audit-20261112/优化任务.md` AF03/AF05 行 + `final-evolution-kernel-audit.md` FE5 + `final-memory-7c2a-report.md` M1。

## 设计决定回报（任务书要求）

- 现有 `总预算账.json` 只记美元：`BudgetReservation.预留额/已结算费用`、`BudgetGrant.总预算` 全是 USD，无 token 字段；`MemoryBudgetConfig.每日上限/单次预留上限` 也是纯美元。
- **方案**：不迁移/不改写旧字段，新增**可选**中文字段做 token 平行轴——`预留token`/`已结算token`/`token预算`/`每日token上限`/`单次token预留上限`。配置任一 token 键才启用 token 门；没配的旧账本/旧调用行为逐字节一致。美元语义不动：settled 但无 `已结算费用`（token 已结算、金额缺单价）时 `committedSpend` 对该条按 `预留额` 保守占住，防止美元超支。
- 主代理已确认按此方案实施（附加约束全部落进代码与用例）。

## 改了什么

全部为新增字段 + 局部修改，无整文件重写。

### `src/pao/usage/budget-ledger.ts`（AF05 核心）

- `BudgetReservation` 新增 `预留token?: number`、`已结算token?: number`；`BudgetGrant` 新增 `token预算?: number`。`isOptionalToken` 校验器只收非负有限数。
- `committedSpend`：settled 行 `已结算费用 ?? 预留额`——token 已结算但金额未估算的记录继续保守占美元（金额未估算 ≠ 零费用）。`reserveBudget` 日累计循环同口径。
- 新增 `committedTokens(file)`：settled 用 `已结算token ?? 预留token`、reserved/unknown 用 `预留token`、released 与纯美元记录不计。新增 `remainingTokens(file)`：只在 grant 声明 `token预算` 时有值。
- `reserveBudget` 新增 `预留token?` / `当日token上限?`；新错误码 `insufficient_tokens` / `daily_tokens_exceeded`。token 日累计与美元日累计同临界区聚合；token 总量门只在 `grant.token预算 !== undefined && input.预留token !== undefined` 时启用（不凭空限额）。
- `settleBudget` 新增 `实际token?`：**已 settled 记录重复结算直接早退**（逐请求幂等）。token 已知（`实际token` 传入）→ settled + 落 `已结算token`；`实际费用` 同时给才写 `已结算费用`，否则备注「token 已结算；金额缺单价未估算（美元侧按预留额保守占用）」。两者都缺 → `unknown` 继续占住；仅 `实际费用` → 兼容旧口径 settled。
- `releaseBudget` settled 报错文案兼容金额未估算：「金额未估算（已结算 N token）」。

### `src/pao/memory/budget.ts`（AF05 记忆侧门面）

- `MemoryBudgetConfig` 新增 `每日token上限?`、`单次token预留上限?`（`readMemoryBudgetConfig` 同样回读）。
- `CheckMemoryJobBudgetInput` 新增 `预留token?`。token 门启用条件 = `每日token上限 || 单次token预留上限` 任一已配；`insufficient_tokens`/`daily_tokens_exceeded` 映射为 `kind:"额度不足"`。
- `settleMemoryJobBudget` 第 8 参 `实际token?: number`；调用 `settleBudget` 时 `实际费用`/`实际token` 各自独立传/省略（缺价不把 token 拖成 unknown）。

### `src/pao/memory/usage-query.ts`（AF05 聚合口径）

- 已知/未知拆分：`tokensKnown = totalTokens>0`（与金额单价无关）；`costKnown = cost?.total>0`；`known = tokensKnown`。token 有但缺单价 → token 照实累计、金额 `known.cost` 留 undefined（未估算）；零 token（嵌入端点不回 usage）仍进 `unknownCount`。文件头契约注释与 `aggregateByPurpose` 注释同步改写。

### `src/pao/memory/extract-model.ts`（AF05 调用点）

- 提炼请求的 `settleMemoryJobBudget` 调用补 `实际token`（`totalTokens>0`）与 `实际费用`（仅 `cost.total>0`）——缺单价时只传 token，不把已知用量拖成 unknown。

### `src/pao/memory/runtime-embedding.ts`（AF05 调用点）

- `settleForBatch` 显式传 `undefined` 第 8 参：嵌入端点不返回 usage，token/金额两轴都保守按 `unknown` 占住。

### `src/pao/evolution/candidates.ts`（AF05 调用点 ×8）

- 集中算 `实际token`/`实际费用` 后，全部 8 处 `settleMemoryJobBudget`（正常/异常/超额/取消各分支）统一传 `实际费用 + 实际token`。

### `src/pao/evolution/runner.ts`（AF03 核心）

- `AgentSessionFactoryInput` 新增 `hostModelRuntime?: unknown` 与 `hostGate?: {paoHome, jobId, jobKind, outboundProjects, outbound?, ledger?, candidateId?, budgetAmount?}`。
- `AgentSessionRunOutcome` 新增 `deniedReason?: string`、`requestCount?: number`。
- `executeAgentCase`：`outcome.deniedReason` → `{passed:false, executionFailure:"start", failureReason:"未验证:{deniedReason}"}`——verdict 走 `incomplete`，不算通过也不算业务失败。
- `createValidationAgentSession`：`baseModelRuntime = options.modelRuntime ?? input.hostModelRuntime ?? (modelConfig.modelRuntime ?? ModelRuntime.create(隔离agentDir))`；`pendingSettles` 数组；`gatedStreamSimple` 用 `lazyStream` 包宿主 `streamSimple`，每次实际请求顺序过 `checkOutbound`（外发许可）→ `checkMemoryJobBudget`（attemptKey=`val-${randomUUID().slice(0,12)}` 逐请求独立判据）→ 真实请求 → `settleMemoryJobBudget` + `gate.ledger?.appendUsage("evolution_validation", …)`（含 `jobId`/`candidateId`/`requestId`）。`modelRuntime = new Proxy(baseModelRuntime, …)`：只覆写 `streamSimple`，其余方法 `Reflect.get` + `bind(target)` 保 `this`（类方法在原型上，对象展开会丢 `getModel`/`find` 等）。
- `finally` 收尾 `await Promise.allSettled(pendingSettles)`：`session.waitForIdle()` 在 `done` 事件触发时返回，**不等**流内 `.result()` 后的异步结算/记账——不收拢会出现「请求已发但账未落」的并发漂移。
- 拒绝路径：门在 `lazyStream` setup 内抛错 → 转成 error AssistantMessage（`stopReason:"error"`），`deniedReason` 记「未验证」原因，请求零外发。

### `src/pao/memory/tools.ts`（AF03 接线，仅局部 Edit）

- `runBothSides` 的 `agentSessionFactory` 改用 `hostInjectedFactory = (factoryInput) => createValidationAgentSession({...factoryInput, hostModelRuntime: over.ctx.modelRegistry, hostGate: {paoHome: over.paoHome, jobId: over.job.jobId, jobKind: "evolve", outboundProjects: [over.outboundProject], outbound: over.outbound, ledger: over.ledger, candidateId}})`——baseline/candidate 两侧复用同一份宿主模型路由与逐请求门。

### `test/pao/usage-budget-af05.test.ts`（新文件，12 用例）

- 全部 `mkdtempSync` 隔离 PAO_HOME + `locked()` 真账本文件，离线。

### `test/pao/evolution-af03.test.ts`（新文件，3 用例）

- `mkdtempSync` 隔离 PAO_HOME + `registerFauxProvider` 假 provider（`callCount` 即外发探针），零真实网络。

## 关账验证对照

### AF05（`优化任务.md` AF05 行）

| 关账验证 | 用例名 | 结果 |
|---|---|---|
| 1200 token 在缺价/零价/正价三路均计入 1200 | `1200 token 缺单价 → settled + 已结算token=1200，已结算费用 undefined`；`1200 token、价格为正 → 已结算费用与已结算token 都落账`；`美元与 token 双门并列：美元够但 token 不足即拒，反之亦然`（含零价路径） | ✅ 三路 settled + `已结算token=1200` |
| 缺 usage 保留未知占额 | `实际token/实际费用都未回 → unknown，预留 token 继续占住`；`memory_runtime_embedding` 嵌入 settle 显式 `undefined` | ✅ `status=unknown` + `预留token` 计 `committedTokens` |
| 失败/取消用量正确结算 | `evolution-af03` 授权成功用例 `stopReason` 分支 + `candidates.ts`/`extract-model.ts`/`runtime-embedding.ts` 失败路径统一传 `实际token` | ✅ 已发生消耗照实落账 |
| 逐请求幂等 | `同一 requestId 重复结算不重复累计（逐请求幂等）` | ✅ 二次 settle 直接早退，`已结算token`/`已结算费用` 不被覆盖 |
| 日累计正确 | `当日 token 累计超限 → daily_tokens_exceeded` | ✅ token 日累计与美元日累计同临界区、独立阈值 |
| 旧金额记录不误作 token | `无 token 字段的旧记录读写不丢字段、校验通过`；`未配置 token 门的预留不写 token 字段（纯美元记录行为不变）` | ✅ 旧账本 roundtrip 无损；新 token 字段完全不写 |
| 双门并列、任一不足即拒 | `token 总量不足 → insufficient_tokens，美元够也拒`；`美元与 token 双门并列`；`token 总量门只在授权声明 token预算 时启用` | ✅ 两码分判、不越权限额 |

### AF03（`优化任务.md` AF03 行）

| 关账验证 | 用例名 | 结果 |
|---|---|---|
| 唯一请求身份 | `请求发出（假 provider 记调用），usage 记到宿主 ledger，预算按 token 结算` | ✅ `requestId=val-…` 进判据与 `appendUsage` note |
| 无许可零外发 | `外发未许可 → executionFailure=start + 未验证，假 provider 零调用` | ✅ `callCount=0` + `deniedReason` 含「禁外发」 |
| 无额度零外发 | `总预算未授权 → 未验证，请求不发出` | ✅ `callCount=0` + `deniedReason` 含「总预算未授权」 |
| token 用量归候选 | `请求发出…` 用例断言 `ledger` 中 `evolution_validation` note 含 `jobId=job-1 candidateId=cand-x` | ✅ 归属正确 |
| 宿主自定义模型可用 | `请求发出…` 用例注入 `hostModelRuntime = 假 modelRegistry` | ✅ `callCount=1`，走宿主路由非隔离 agentDir 自建 |
| 拒绝走「未验证」 | 两例拒绝用例均断言 `executionFailure === "start"` + `failureReason` 前缀 `未验证:` | ✅ verdict 走 `incomplete` |

## 检查结果

- 新增测试 15/15 通过：`usage-budget-af05.test.ts` 12 + `evolution-af03.test.ts` 3（`checks/x-af05-af03-tests.log`）
- 回归测试 255/255 通过（usage-budget/-command/-ledger/-native-ledger/-rollup、usage-gate-coverage/-wiring、f-budget-concurrency、worker-budget、worker-usage-display、memory-usage、memory-embeddings、memory-runtime-embedding、memory-context-usage、memory-desktop-usage-bridge、evolution-o10/o13/validation/evaluate 共 19 文件）：`checks/x-regression.log`
- `npx tsc --noEmit`：本组触碰文件零错误。仅剩 2 处错误在其他组新测试文件（`test/pao/evolution-af06-af07.test.ts:383`、`test/pao/memory-f14-review.test.ts:371`），非本组范围：`checks/x-tsc.log`
- `npx biome check --diagnostic-level=error` 本组 11 个文件：`Found 1 error`——`candidates.ts:622` `noImplicitAnyLet`（HEAD 即有 `let message;`）。`tools.ts` format 偏差已由主代理 LF 换行统一顺手修复。新增/触碰行零新增错误：`checks/x-biome.log`

## 协调事项

- 期间主代理在 `src/pao/memory/tools.ts` 做临时改动并还原验证 AF04 用例。本组 `hostInjectedFactory`（行 ~1501）与主代理新增的 `resolveEvolveJobOutboundRoot`（行 ~1276）+ `project-identity` 导入（行 ~52）均已确认在最新文件中并存，未互相覆盖。

## 未验证与限制

- 全部用例走 `mkdtempSync` + 假 provider/假 `modelRegistry`，**零真实外发、零真实模型调用**（符合任务书第 4 条）。
- AF03 的「宿主自定义模型可用」在测试中用 `createInMemoryModelRegistry` + `registerFauxProvider` 模拟宿主路由，未跑真实 `ModelRuntime.create(宿主 agentDir)`——后者需要真实凭证与网络，不在离线验收范围。
- `budget-ledger.ts` 的 `remainingTokens` 仅在 `grant.token预算` 声明时有值；`token预算` 字段在 `grantBudget` 入参暴露但尚未有 CLI/配置入口写入（本任务书只要求账本层能力，写入入口由后续批次挂接）。
- 嵌入端点 `runtime-embedding.ts` 的 settle 传 `undefined` token/费用是两轴都 `unknown` 的语义实现，但嵌入真实路径是否会产生非零 usage 未在真 provider 上验证（离线假 provider 本就不回 usage）。
- 未起 worker 子进程、未碰桌面端、未跑真实 PAO_HOME（任务书禁）。

## 运行过的命令

```bash
cd packages/coding-agent && node ../../node_modules/vitest/vitest.mjs run test/pao/usage-budget-af05.test.ts test/pao/evolution-af03.test.ts --maxWorkers=1
cd packages/coding-agent && node ../../node_modules/vitest/vitest.mjs run test/pao/usage-budget.test.ts test/pao/usage-budget-command.test.ts test/pao/usage-ledger.test.ts test/pao/usage-native-ledger.test.ts test/pao/usage-rollup.test.ts test/pao/usage-gate-coverage.test.ts test/pao/usage-gate-wiring.test.ts test/pao/f-budget-concurrency.test.ts test/pao/worker-budget.test.ts test/pao/worker-usage-display.test.ts test/pao/memory-usage.test.ts test/pao/memory-embeddings.test.ts test/pao/memory-runtime-embedding.test.ts test/pao/memory-context-usage.test.ts test/pao/memory-desktop-usage-bridge.test.ts test/pao/evolution-o10.test.ts test/pao/evolution-o13.test.ts test/pao/evolution-validation.test.ts test/pao/evolution-evaluate.test.ts --maxWorkers=1
cd packages/coding-agent && npx tsc --noEmit
cd packages/coding-agent && npx biome check --diagnostic-level=error <本组 11 个文件>
```

日志在 `.pao/自进化修复-20261118/checks/`（`x-af05-af03-tests.log` / `x-regression.log` / `x-tsc.log` / `x-biome.log`）。

## 主代理复核（2026-11-18）

- 重跑 X 新增用例与相关回归 8 个文件 113/113 通过（`checks/main-x-review.log`）。
- 反面验证：临时让 `runner.ts` 跳过外发许可判断，`evolution-af03` 的「外发未许可 → 零调用」用例随即失败；已恢复原文件。说明门控用例确实在拦截。
- 三处既有测试断言的改动与已确认的 AF05 口径一致（token 已知、缺价不再整条记 unknown），且新增了 `已结算token`/`已结算费用` 断言，没有放宽。
- 生产唯一调用点 `tools.ts` 的 `hostInjectedFactory` 总是传 `hostGate`；未注入时不加门只用于离线/测试。
- 结论：AF05、AF03 通过。
