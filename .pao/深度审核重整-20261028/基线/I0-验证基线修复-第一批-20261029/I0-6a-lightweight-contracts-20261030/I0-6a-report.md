# I0-6a 轻量契约/并发测试修复报告

日期：2026-10-30

## 结论

- 三个获准测试文件已完成最小修改，产品源码、package 和锁文件未改。
- 最终默认预算逐文件复跑全部通过：`index-wiring` 4/4、`worker-dispatch-nongit-real` 3/3、`friction-drafts` 14/14，合计 21/21，三个真实退出码均为 0。
- 根 `tsc --noEmit` 退出码为 1，仅报告 `src/pao/worker/post-dispatch.ts` 的 3 个既有/跨路类型错误；本批三个测试文件没有类型错误。

## 修改前红测

| 文件 | 修改前数量与退出码 | 原始失败 |
|---|---:|---|
| `index-wiring.test.ts` | 2 passed / 2 failed，exit 1 | 默认宿主已自动注册 `pao_worktree_create`；worker 已注册窄版 `pao_submit_receipt`。旧断言要求两者均不存在。 |
| `worker-dispatch-nongit-real.test.ts` | 2 passed / 1 failed，exit 1 | `claimBaseline` 已使用公开字段 `available` / `reason`，测试仍断言旧中文 `可用` / `原因`。 |
| `friction-drafts.test.ts` | 13 passed / 1 failed，exit 1 | 同项目写锁由卡 2 先取得，真实 attempts 为 `[0,1,0,0]`；测试硬编码卡 1 获胜的 `[1,0,0,0]`。 |

## 修改与断言

- `index-wiring.test.ts:188` 的测试装配增加可选 `projectRoot`，只用于构造独立非 Git 根。
- `index-wiring.test.ts:338` 改为允许默认本地宿主注册 managed 工具；实际对非 Git 根调用 `pao_worktree_create`，断言真实拒绝并包含 `not a git repository`。
- `index-wiring.test.ts:438` 检查 worker 回执 schema 只含 `result`、`artifact_path`、`summary`、`failure_type`、`任务态`、`verification`、`changes`，并明确不含 `card_ref`、`card_no`、`attempt`、`state`、`status`、`owner`。
- `index-wiring.test.ts:497` 实际执行窄回执，断言 `worker_self_report` / `host_verification: pending`，且卡状态、尝试号和 owner 未改变。worker 仍无派工、扇出、建树、整合、建卡和改卡工具。
- `worker-dispatch-nongit-real.test.ts:86` 对准公开字段 `available: false` 与 `reason`；保留真实子进程、成功回执、`versionControl: "none"`、执行根、仓库根和锁释放断言。
- `friction-drafts.test.ts:414` 从真实进程启动日志识别唯一获胜卡，按卡号位置构造 attempts；保留 4 张全部取消、未拉起结果无 attempt、卡面未拉起 attempt 为 0、4 条取消草稿等断言。

## 最终命令与结果

统一环境：

```text
PAO_HOME=D:\AI\workspace\临时文件夹\深度审核重整-20261028\i0-6a-lightweight-contracts-20261030\isolated\PAO_HOME
TEMP=TMP=TMPDIR=D:\AI\workspace\临时文件夹\深度审核重整-20261028\i0-6a-lightweight-contracts-20261030\isolated\tmp
PI_OFFLINE=1
PI_NO_LOCAL_LLM=1
```

工作目录：`D:\AI\workspace\pao-dev\PAO\packages\coding-agent`

```powershell
& 'C:\Program Files\nodejs\node.exe' 'D:\AI\workspace\pao-dev\PAO\node_modules\vitest\vitest.mjs' run test/pao/index-wiring.test.ts --reporter=verbose
& 'C:\Program Files\nodejs\node.exe' 'D:\AI\workspace\pao-dev\PAO\node_modules\vitest\vitest.mjs' run test/pao/worker-dispatch-nongit-real.test.ts --reporter=verbose
& 'C:\Program Files\nodejs\node.exe' 'D:\AI\workspace\pao-dev\PAO\node_modules\vitest\vitest.mjs' run test/pao/friction-drafts.test.ts --reporter=verbose
```

未设置全局 `testTimeout`。同一 PowerShell 脚本顺序运行并保存真实退出码：`D:\AI\workspace\临时文件夹\深度审核重整-20261028\i0-6a-lightweight-contracts-20261030\run-after-tests.ps1`。

| 文件 | 最终结果 | 退出码 | 日志 |
|---|---|---:|---|
| `index-wiring.test.ts` | 1 file / 4 tests passed | 0 | `index-wiring.test.ts-after.stdout.log`, `.stderr.log`, `.exit.txt` |
| `worker-dispatch-nongit-real.test.ts` | 1 file / 3 tests passed | 0 | `worker-dispatch-nongit-real.test.ts-after.stdout.log`, `.stderr.log`, `.exit.txt` |
| `friction-drafts.test.ts` | 1 file / 14 tests passed | 0 | `friction-drafts.test.ts-after.stdout.log`, `.stderr.log`, `.exit.txt` |

开始、结束与耗时保存在 `after-timings.json`。修改前证据保存在同目录 `*-before.*`。

## 根类型检查

工作目录：`D:\AI\workspace\pao-dev\PAO`

```powershell
& 'C:\Program Files\nodejs\node.exe' 'D:\AI\workspace\pao-dev\PAO\node_modules\typescript\bin\tsc' --noEmit
```

退出码：1。日志：`root-tsc-after.stdout.log`、`root-tsc-after.stderr.log`、`root-tsc-after.exit.txt`。

错误均位于本批范围外的 `packages/coding-agent/src/pao/worker/post-dispatch.ts`：

- 291 行：`自报未达项` 可能为 `undefined`，与目标数组类型不兼容。
- 300、305 行：读取 `verification.自报未达项` 前未收窄 `undefined`。

## 边界与未验证

- 未修改产品源码、package、锁文件、四部门测试或其他慢 workflow 组。
- 未构建，未调用真实模型、Harbor 或 Docker，未访问正式 `PAO_HOME`。
- 未提交。未验证项只有本任务范围外路径；根 tsc 的跨路错误需由对应所有者处理。
