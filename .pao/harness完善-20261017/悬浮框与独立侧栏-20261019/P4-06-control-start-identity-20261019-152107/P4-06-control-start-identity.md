# P4-06 最新启动与控制快照定向修复

日期：2026-10-19

## 结论

P4-06 已在授权的 task-status 范围内修复。同一 plan 出现新启动后，Rail 立即停止使用旧启动的 control，并以该 plan 的最新 `startRequestId` 重新绑定控制快照。控制读取完成后，只有 `instanceId`、`controlPath`、`ownerSessionId` 都与最新启动一致时才进入步骤合并；任一不一致会显示明确的读取失败，不把旧或错配的 control 交给 `stepCardViews()`。异步旧返回也不能回填新启动。

共享 `workflow-cards.stepCardViews` 的签名和其他调用者未改，没有新增控制动作或权限框架。
Task Status Rail 现有动作仍只有计划、部门、看板和差异的只读跳转；本次没有新增控制入口。

## 支持路径

| 证据 | 位置 |
|---|---|
| starts 按每次启动记录 `startRequestId`、`instanceId`、`recipeName`、`controlPath`、`ownerSessionId` | `desktop/apps/desktop/contracts/temporary-plans.ts` 的 `TemporaryPlanStartRow` |
| control 同时提供 `instanceId`、`path`、`ownerSessionId` | `desktop/apps/desktop/contracts/workflow-control.ts` 的 `WorkflowControlIdentity` |
| Rail 使用最新 start 请求 `getWorkflowControl` | `desktop/apps/desktop/src/features/task-status/task-status-rail.tsx` |
| Rail 只按完整控制身份选择快照，失败态不向 `stepCardViews` 传 control | 同文件的 `planStatuses` 计算 |
| 身份比较和单次控制校验位于 Rail 唯一使用的 helper | `desktop/apps/desktop/src/features/task-status/task-status-model.ts` |

## 修改

- `task-status-rail.tsx`
  - 控制缓存按完整启动身份和本次加载代次管理。
  - 最新启动发生变化时立即渲染 loading，旧 control 不参与步骤合并。
  - 异步结果落地前再次核对当前 latest start；旧加载代次或旧启动的结果直接丢弃。
- `task-status-model.ts`
  - 原有 todo 和部门 helper 保持；新增 task-status 专用的最新启动、控制身份和加载 helper。
  - 控制身份包含 `planId`、`startRequestId`、`instanceId`、`controlPath`、`ownerSessionId`。
  - `controlMatchesLatestStart()` 在唯一装配 helper 中核对控制的实例、清单路径和 owner。
  - 错配返回不带 control 的 `state: "failed"` 快照，错误文案指出启动与控制实例。
- `task-status.spec.ts`
  - 使用两个受控 Promise：旧启动先完成但不得回填，新启动完成前保持 loading，新控制完成后切到新状态。
  - 分别覆盖实例、控制路径和 owner 三项不匹配，要求显示失败且不携带 control。

## 验证

工作目录：`D:\AI\workspace\pao-dev\desktop`

| 检查 | 退出码 | 日志 |
|---|---:|---|
| Prettier check | 0 | `P4-06-owner-format-check.log` |
| 定向 ESLint | 0 | `P4-06-owner-lint.log` |
| renderer `tsc` | 0 | `P4-06-owner-renderer-tsc.log` |
| `task-status.spec.ts` | 0 | `P4-06-owner-unit.log` |

单测结果：5 passed，1 worker。最终退出码汇总见 `P4-06-owner-final-exit-codes.json`。
首跑 lint 有 1 个浮动 Promise，日志见 `P4-06-lint-first.log`；后续新增 `plansRef` 时又遇到一次变量声明顺序类型错误，日志见 `P4-06-renderer-tsc-final.log`。另外 P4-06 首轮及前两次复跑的日志也均保留；修正后以 owner 后缀再次运行，最终检查全部通过。

产品文件在最终检查通过后冻结，SHA-256 见 `P4-06-owner-file-sha256.log`：

| 授权文件 | SHA-256 |
|---|---|
| `task-status-rail.tsx` | `1885E712A76A795DC05F6C6202033292DAD372C758D5A513412D4B7EDEDAE305` |
| `task-status-model.ts` | `4C8CA0DF184DE0CB4501DBAAC5386A5ECD57B6609122DDD417FEC50BAC19589D` |
| `task-status.spec.ts` | `24FD38464ED0827D254F41880CF79D22B322C2C97765FBB3FA65F814B607FB35` |

## 未验与限制

- 未运行 build；按当前分工由 Archimedes 统一构建。
- 未运行真实 Electron、真实供应商或发行环境；本轮结论只覆盖已修改、静态检查和模型回归。
- P4-06 报告提出的画布动作错投位于 `workflow-cards-view.tsx`，不在本次授权文件内，本轮未修改或验证。
- 根仓库 `.gitignore:3` 忽略整个 `desktop/`，因此根仓库 `git diff` 不产出这三个文件的 diff；`git diff --check` 退出 0 不能单独证明文件范围。
- 产品改动完成后冻结；后续只有 P5/审查负责人可重新分配修改。
