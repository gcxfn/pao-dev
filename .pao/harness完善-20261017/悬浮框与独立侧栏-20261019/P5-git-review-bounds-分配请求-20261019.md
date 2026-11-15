# P5 Git Review bounds 修复分配请求

## 请求主对话分配

请分配给 `git-review.ts` 的产品唯一写者，修复 Windows 临时目录清理失败覆盖成功结果的问题。

建议位置：

`D:/AI/workspace/pao-dev/desktop/apps/desktop/electron/platform/files/git-review.ts:1020`

现状：

```ts
await rm(scratch, { recursive: true, force: true });
```

建议最小改动：

```ts
await rm(scratch, {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 50,
});
```

理由：

- `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` 后 Git 子进程在 Windows 上短时间仍持有临时文件句柄。
- 立即清理稳定返回 `EBUSY`，`finally` 异常覆盖已生成的 `available + partial` 结果。
- 独立 Node 实验 5/5 立即清理失败；同样加入 `maxRetries: 5, retryDelay: 50` 后 5/5 成功。
- 重试耗尽仍抛错的现有行为保留，不吞真实清理失败。

分配后的复验：

1. 单跑 `bounds snapshot hashing`。
2. 通过后跑完整 `git-review.spec.ts`。
3. 跑相关 TypeScript 检查。
4. 检查该分支不再新增 `%TEMP%\pi-gui-review-*` 残留目录。

本次未改产品。当前正在 build/package，不要求本调查代理自行插入修改。
