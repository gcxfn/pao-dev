# I0-4a 剩余行为失败复核

结论：四组 A6 旧失败 `7 + 3 + 2 + 2` 中，现只剩用量门禁的“取消回执通知为空”1 项。其余 13 项已通过；新日志为 8/8、15/15、14/15、11/11。

## 运行条件

- cwd：`D:\AI\workspace\pao-dev\PAO\packages\coding-agent`
- `PAO_HOME=D:\AI\workspace\临时文件夹\深度审核重整-20261028\i0-4a-behavior-groups\PAO_HOME`
- `PI_OFFLINE=1`
- `PI_NO_LOCAL_LLM=1`
- 未加 `--testTimeout`，未构建，未调用真实模型、Harbor 或 Docker。
- 命令：`node ../../node_modules/vitest/vitest.mjs run test/pao/<file> --maxWorkers=1 --reporter=verbose`

## 红绿结果

| 文件 | A6 旧失败 | 修改前 | 当前 | 退出码 |
|---|---:|---|---|---:|
| `dispatch-workflow-check.test.ts` | 7 | 1/8 | 8/8 | 0 |
| `worker-budget.test.ts` | 3 | 15/15 | 15/15 | 0 |
| `usage-gate-wiring.test.ts` | 2 | 13/15 | 14/15 | 1 |
| `patrol-shell-guard-wire.test.ts` | 2 | 9/11 | 11/11 | 0 |

旧日志与当前日志均在本目录，文件名为 `I0-4a-*-before.log` 和 `I0-4a-*.test-after.log`。

## 测试侧修改

- `dispatch-workflow-check.test.ts`：`setupV2()` 显式把首个节点设为“拆解”，匹配当前出厂模板“直接”节点不能 `bindMinister` 的真实语义。
- `patrol-shell-guard-wire.test.ts`：假卡补齐 `ParsedCard` 的 `body`、`filename`、`receipts` 等必填字段，移除 `as never as ParsedCard`；原断言未变。
- `usage-gate-wiring.test.ts`：两张并发卡放在两个独立项目执行根，第二项目卡号计数器设为 `100`，避免执行根占位和相同预算判据抢先导致拒绝；原并发、额度和拒绝原因断言未变。
- `worker-budget.test.ts`：保留 `receipt.result_source === "tool"`，证明新回执工具免计普通工具次数；预算断言及其余额度/并发护栏未放宽。

## 剩余差异

`usage-gate-wiring.test.ts > 取消回执带实际费用 → 按实际费用结算，取消不抹费用` 仍在第 386 行断言处失败：预算记录已正确结算为 `1.75`，但注入通知为空，`expected '' to contain 'canceled'`。

这是产品行为问题，不是夹具问题。最小修复点在 `src/pao/worker/index.ts` 的 `registerWorkerTools()` 内、当前第 1077 行：

```ts
if (!delivered && outcome !== "canceled" && !runner.isStopped()) {
```

紧邻注释说明“个人 terminate 不置 `isStopped`，仍走原有取消回执与通知语义”，但 `outcome !== "canceled"` 恰好阻止该路径。建议产品所有者核验后改为 `if (!delivered && !runner.isStopped())`；这仍保留全停时 `runner.isStopped()` 不唤醒的护栏。本任务未修改产品源码。

## 未验项

- 未在全套测试中复跑；只运行了指定的四个文件。
- 未验证上述产品修复建议，因为产品源码不在 I0-4a 可写范围。
