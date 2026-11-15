# V18 清理守卫状态

截至 2026-10-20。

## 已实际通过

命令（隔离 TMP/TEMP/TMPDIR 到本工作区）：

```powershell
desktop\node_modules\.bin\playwright.cmd test -c apps\desktop\playwright.config.ts apps\desktop\tests\unit\pao-worktree-host.spec.ts --reporter=line
```

退出码：`0`；结果：`7 passed (56.6s)`。

覆盖：

- 源仓 dirty、二进制、untracked 内容可恢复到新建工作树，源仓内容摘要不变。
- 同 request_id 同输入复用，异输入拒绝。
- 宿主重启后仍能解析同一可恢复基线。
- active、dirty、untracked、未合入均拒绝清理，目录和 `pi/` 分支保留。
- 正常 clean 且已合入时非 force 移除目录，分支保留。
- 单根宿主 dirty/untracked/active 均返回 `unknown`。

## 当前接口阻塞

- `worker/lock.ts` 的 `acquireExecutionRootGuard`、`detectExecutionOccupancy` 正由 Heisenberg 实现。
- 仅查桌面 driver 内存状态不足；清理必须持有任务根侧跨进程 guard，并在 guard 内复核 executionRoot 的租约和持久占位。
- executionRoot 内的 `.pao/执行锁`、派发日志可能在正常释放后成为 untracked；宿主不得复制锁规则或递归清理，须消费锁模块给出的受控运行元数据处置接口。

## 尚未验证

- 另一会话/进程同根执行反例。
- 清理检查后新派发抢入反例。
- owner 正常停止后释放目录、停止未确认和死 owner 保留现场反例。
- 装配工具注册、`check:gates`、Electron 发行物、解包 SDK worktree → dispatch 链路。
