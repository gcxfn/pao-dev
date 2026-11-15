# I0-2b 既有关闭夹具剩余文件验收

结论：5 个目标文件均以默认预算单跑通过，共 64/64 项；历史默认日志中的 32 项失败均未复现。本批没有新增代码修改，也没有改产品源码、package、锁文件、断言、skip 或超时。

环境：包目录 `D:\AI\workspace\pao-dev\PAO\packages\coding-agent`；隔离 `PAO_HOME=D:\AI\workspace\临时文件夹\深度审核重整-20261028\i0-2b-shutdown-remaining\PAO_HOME`；`PI_OFFLINE=1`；`PI_NO_LOCAL_LLM=1`。未构建、未安装依赖、未运行真实模型或 Docker。

## 既有修改核对

`git diff --numstat` 显示以下文件均只有 `2 additions, 1 deletion`。实际差异均为两点：引入 `./fixtures/session-shutdown.ts`；把 `afterEach` 的逐个 shutdown 调用改为 `fireSessionShutdownHandlers(shutdowns.splice(0))`。

- `blackboard-upstream.test.ts`：import 第 18 行，调用第 30 行。
- `host-inventory-dispatch.test.ts`：import 第 14 行，调用第 35 行。
- `s5p4-roles-supervision.test.ts`：import 第 20 行，调用第 41 行。
- `worker-dispatch-guards.test.ts`：import 第 35 行，调用第 42 行。
- `worker-dispatch.test.ts`：import 第 17 行，调用第 34 行。

## 旧失败与当前复跑

| 文件 | A6 原默认日志 | 历史剩余诊断 | 当前结果 | 退出码 | 当前日志 |
|---|---:|---:|---:|---:|---|
| `blackboard-upstream.test.ts` | 9 项中 3 失败 | 3 失败 | 9/9 通过 | 0 | `I0-2b-blackboard-upstream-current.log` |
| `host-inventory-dispatch.test.ts` | 5 项中 5 失败 | 2 失败 | 5/5 通过 | 0 | `I0-2b-host-inventory-dispatch-current.log` |
| `s5p4-roles-supervision.test.ts` | 9 项中 3 失败 | 无剩余记录 | 9/9 通过 | 0 | `I0-2b-s5p4-roles-supervision-current.log` |
| `worker-dispatch-guards.test.ts` | 21 项中 6 失败 | 1 失败 | 21/21 通过 | 0 | `I0-2b-worker-dispatch-guards-current.log` |
| `worker-dispatch.test.ts` | 20 项中 15 失败 | 2 失败 | 20/20 通过 | 0 | `I0-2b-worker-dispatch-current.log` |

历史剩余的两项 `worker-dispatch` 是“真 git 仓库认领/基线快照/登记”和“正常完成后删除 Python 缓存目录”。本轮前者 3973ms 通过，后者 4538ms 通过；未再触及产品接口、并发或预算约束。guard 历史剩余的“真实本地非 Git primary 子进程”也已因主控修复 `execution-context.ts` 而通过。

## 精确命令

每个文件单独执行，公共命令如下；仅把 `<file>` 依次替换为 `test/pao/blackboard-upstream.test.ts`、`test/pao/host-inventory-dispatch.test.ts`、`test/pao/s5p4-roles-supervision.test.ts`、`test/pao/worker-dispatch-guards.test.ts`、`test/pao/worker-dispatch.test.ts`：

```powershell
$env:PAO_HOME='D:\AI\workspace\临时文件夹\深度审核重整-20261028\i0-2b-shutdown-remaining\PAO_HOME'; $env:PI_OFFLINE='1'; $env:PI_NO_LOCAL_LLM='1'; node ../../node_modules/vitest/vitest.mjs run <file> --maxWorkers=1 --reporter=verbose
```

每个当前日志开头保存了实际工作目录、隔离 `PAO_HOME`、环境变量和替换后的完整命令；日志末尾保存实际 `exitCode`。

## 未验项与边界

本批 5 个目标文件已全部实际运行，不存在目标文件未验项。Windows 链接 8 项、真实模型、Harbor、Docker 和正式 `PAO_HOME` 均按任务边界未运行。工作区其他未提交文件和既有并行修改均保持原状；未提交。
