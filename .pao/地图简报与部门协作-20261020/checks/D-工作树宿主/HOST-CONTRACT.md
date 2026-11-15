# D 工作树宿主权威边界与并发清理风险

日期：2026-10-20（Asia/Shanghai）

## 权威类型

唯一宿主正本为 `PAO/packages/coding-agent/src/pao/worktrees/types.ts` 的 `WorktreeBinding`。它只证明宿主解析到哪个 `executionRoot`、与什么输入版本相同。cards `ExecutionBinding.worktree` 必须原样持有一份该类型，只负责 attempt 持久关联，不另造 linked/path/baseHead 平行结构。

最小宿主接口保持五项：

```ts
interface PaoWorktreeHost {
  capability(projectRoot: string): Promise<WorktreeCapability>;
  create(input: CreateWorktreeRequest): Promise<WorktreeBinding>;
  inspect(input: InspectWorktreesRequest): Promise<readonly WorktreeInspection[]>;
  resolveForDispatch(input: ResolveWorktreeForDispatchRequest): Promise<WorktreeBinding>;
  requestCleanup(input: RequestWorktreeCleanupRequest): Promise<WorktreeCleanupResult>;
}
```

`registerWorktreeTools` 只注册 `pao_worktree_create`、`pao_worktree_list`、`pao_worktree_cleanup`。项目根和活动状态均从宿主/运行时上下文取得，模型参数不接收任意 path、branch、startPoint 或 force。桌面由 `app-store` 安装 `PaoDesktopWorktreeHost`，驱动通过 `paoExtensionOptions` 透传；内核装配由 Dirac 修改 `PAO/packages/coding-agent/src/pao/index.ts`。

## 已确认风险

1. `createSingleRootWorktreeHost.inspect` 对 dirty/untracked/active 均返回 `"unknown"`，不得伪造 false。
2. 桌面宿主已有真实 Git 路径、主/共同 Git 目录、跨仓与外部路径检查；仍需增加跨仓、未知 ID、创建失败保留现场真实反例。
3. `isExecutionActive` 仅查本驱动进程内存。桌面构造宿主时应使用真实执行锁/持久占位来判断跨会话和跨进程占用；停止未确认、owner 已死都不得释放。清理检查与删除之间还必须与派发互斥，避免检查后新任务启动的竞态。
4. worktree 创建后出现的 `.pao/执行锁`、派发日志等属于 Git untracked，不能把正常任务自建的可释放资源与用户改动混为一谈。只允许在已确认无活动 owner、无未保留成果、且资源身份/生命周期明确的条件下处理；不得 `git clean -fdx`、`worktree remove --force` 或自动删除分支。
5. 现有源码的创建失败路径保留目录与 `pi/` 分支，正常清理直接执行非 force 的 `git worktree remove`，不调用会删分支的 `GitWorktreeManager.removeWorktree`。真实的“自建运行元数据可安全释放”与“用户 untracked 保留”仍需集成验证。

## 建议的最小清理协议

宿主不改公开五项方法；`requestCleanup` 内部按此顺序原子地获得执行占用证明、读取持久 owner/停止状态、复核 Git 和资源归属、与派发共享互斥地执行非 force 移除、再释放占用。任一步未知或失败均 `{ ok:false, retained:true }`。不得把 `executionActive:false` 参数当成充分证据。执行锁正本、owner 存活和停止确认由 Dirac 负责；桌面宿主只消费公开能力，不能复制锁规则。
