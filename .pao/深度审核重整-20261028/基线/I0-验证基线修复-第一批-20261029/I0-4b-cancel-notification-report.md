# I0-4b 取消通知修复

## 结论

个人取消现在会结算真实费用 `1.75` 并产生一次 `canceled` 完成通知；显式全停仍不通知或唤醒；监督宿主已经接收结果时仍不重复通知。

## 调用链检查

- codebase-memory-mcp 索引状态为 ready，索引时间 `2026-10-23T01:05:53Z`。
- 调用图为 `registerWorkerTools → dispatchInBackground → finishTrackedSupervision → MinisterHost.finishSupervision`。
- 当前源码确认 `WorkerRunner.isStopped()` 只在 `stopAll()` 后为真，单卡取消不会置位。
- `finishTrackedSupervision` 返回 `true` 表示监督宿主已接收，后续派卡通知应跳过。

## 修改

- `src/pao/worker/index.ts`：完成通知条件从 `!delivered && outcome !== "canceled" && !runner.isStopped()` 改为 `!delivered && !runner.isStopped()`。
- `test/pao/usage-gate-wiring.test.ts`：个人取消用例断言费用 `1.75`、`[派卡完成]` 和 `(canceled)` 各一次；新增全停不通知、监督宿主已接收不重复通知两类回归。

没有修改 runner、保护逻辑、预算门禁或其他产品代码。

## 运行条件

- cwd：`D:\AI\workspace\pao-dev\PAO\packages\coding-agent`
- `PAO_HOME=D:\AI\workspace\临时文件夹\深度审核重整-20261028\i0-4b-cancel-notice\PAO_HOME`
- `TEMP` 与 `TMP` 均为 `D:\AI\workspace\临时文件夹\深度审核重整-20261028\i0-4b-cancel-notice\tmp`
- `PI_OFFLINE=1`、`PI_NO_LOCAL_LLM=1`
- 未设置 `--testTimeout`；未构建、未调用真实模型、Harbor 或 Docker。
- 命令：`node ../../node_modules/vitest/vitest.mjs run <test> --maxWorkers=1 --reporter=verbose`

## 结果

| 阶段 | 文件 | 数量 | 退出码 | 日志 |
|---|---|---:|---:|---|
| 修复前 | `usage-gate-wiring.test.ts` | 1 失败 / 14 通过 | 1 | `I0-4b-usage-gate-wiring-before.log` |
| 新回归、修复前 | `usage-gate-wiring.test.ts` | 1 失败 / 16 通过 | 1 | `I0-4b-tests-before-product-fix.log` |
| 修复后 | `usage-gate-wiring.test.ts` | 17 通过 | 0 | `I0-4b-usage-gate-wiring-after.log` |
| 修复后回归 | `worker-tools.test.ts` | 8 通过 | 0 | `I0-4b-worker-tools-after.log` |

`git diff --check` 退出码为 0。

## 限制

- 未运行全套测试。
- 未验证真实模型或真实关闭进程树；本任务按用户边界只做隔离离线测试。
- codebase-memory-mcp 图索引早于当前未提交修改，因此影响判断同时核对了当前源码和实际测试。
