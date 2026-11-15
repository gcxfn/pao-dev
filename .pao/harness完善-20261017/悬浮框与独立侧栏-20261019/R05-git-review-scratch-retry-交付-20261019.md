# R05 Git Review scratch 清理重试交付

## 结论

批准的最小修复已完成并验证：

- 仅修改 `desktop/apps/desktop/electron/platform/files/git-review.ts` 的 `readPatch` 临时目录清理。
- 使用 Node `rm` 原生有限重试：`maxRetries: 5`、`retryDelay: 50`。
- 重试耗尽仍由 `rm` 抛错，未吞错。
- 未改变 1 MiB 补丁预算、截断判定、成功结果或现有测试断言。
- 原有失败单例通过；完整 `git-review.spec.ts` 为 23 passed、2 个既有 Windows skip、0 failed。
- ESLint 与 Electron TypeScript 检查通过。
- 本次新增清理片段的独立 snippet Prettier 检查通过；全文件 Prettier 检查仍失败，且 HEAD 基线同样失败，属于该文件既有的整文件格式差异。本次未扩大改动。
- 单例和完整 spec 前后，本轮 `pi-gui-review-*` scratch 新增数均为 0。
- 未 build、未 package、未提交。

这是 R05 相关统计与既有差异查看的回归小修。历史缺陷不冒称本轮引入。

## 修改文件

`D:/AI/workspace/pao-dev/desktop/apps/desktop/electron/platform/files/git-review.ts`

```diff
   } finally {
-    await rm(scratch, { recursive: true, force: true });
+    await rm(scratch, {
+      recursive: true,
+      force: true,
+      maxRetries: 5,
+      retryDelay: 50,
+    });
   }
```

没有改测试、断言、skip 或 helper。

## 验证

| 检查 | 退出码 | 结果 | 日志 |
|---|---:|---|---|
| 失败单例 | 0 | 1 passed，1.9s | `R05-git-review-scratch-retry-20261019-01.single.log` |
| 完整 `git-review.spec.ts` | 0 | 23 passed、2 skipped、0 failed | `R05-git-review-scratch-retry-20261019-02.git-review-full.log` |
| ESLint 首次 | 0 | 无输出，通过 | `R05-git-review-scratch-retry-20261019-03.eslint.log` |
| Electron tsc 首次 | 0 | 无输出，通过 | `R05-git-review-scratch-retry-20261019-03.electron-tsc.log` |
| Prettier 首次 | 1 | 指出整文件格式不一致 | `R05-git-review-scratch-retry-20261019-03.format.log` |
| ESLint 复跑 | 0 | 无输出，通过 | `R05-git-review-scratch-retry-20261019-04.eslint.log` |
| Electron tsc 复跑 | 0 | 无输出，通过 | `R05-git-review-scratch-retry-20261019-04.electron-tsc.log` |
| Prettier 复跑 | 1 | 结果不变 | `R05-git-review-scratch-retry-20261019-04.format.log` |
| `git diff --check` | 0 | 无空白错误 | 本次命令输出 |

完整 spec 的 2 个 skip 是文件原有、Windows 条件跳过项：

- 病理路径、rename pair、unborn additions。
- 符号链接文本与超大内容。

本次没有改动这两个 skip。

## scratch 核验

| 阶段 | 测试前 | 测试后 | 新增 |
|---|---:|---:|---:|
| 失败单例 | 28 | 28 | 0 |
| 完整 git-review spec | 28 | 28 | 0 |

记录：

- `R05-git-review-scratch-retry-20261019-01.scratch.txt`
- `R05-git-review-scratch-retry-20261019-02.scratch.txt`

另有只读定位阶段的独立实验脚本留下了 5 个
`pi-review-cleanup-probe-*` 临时目录。它们是本轮明确生成的 1,260,000 字节单文件样本；
一次试图在同一条命令中“再次核验后删除”被自动化安全策略拒绝，删除未发生。
- 自动审批拒绝的动作：递归删除本轮创建的 5 个
  `pi-review-cleanup-probe-*` 目录。
- 拒绝理由：自动化安全策略阻止了同一条命令中的“检测后递归删除”流程；没有执行任何目录删除。
- 安全替代：5 个目录全部保留，作为 Windows 暂占用失败的对照证据。清理不是必需交付，无需用户额外决定，也不再重试删除。

## Prettier 说明

对工作树文件直接运行 `prettier --check` 返回 1。进一步用固定 LF 副本检查：

- HEAD 原始文件的临时副本也不通过。
- 当前修改后的临时副本也不通过。
- 差异覆盖整份 1,100 多行文件，并非本次新增对象造成。

为避免把批准的一处修复扩大为整文件重排，未运行会重写该文件的批量格式化。

本次新增片段的独立证据：

- 证据文件：`R05-git-review-scratch-retry-20261019-07.fragment.ts`
- 检查命令：`prettier --check` 仅指向该证据文件
- 退出码：0
- 结果：`All matched files use Prettier code style!`
- SHA-256：`ABBE9A05311CFB62A28A61ED2F9EDBC2A396C130A970BD8B65606A31553BAD11`
- 日志：`R05-git-review-scratch-retry-20261019-07.fragment-format.log`

该证据只证明本次新增的 `rm` 参数片段符合当前 Prettier 规则，不表示
`git-review.ts` 全文件通过 Prettier，也没有削弱现有全局格式检查。

曾经的 `--check --range-start/--range-end` 尝试记录在
`R05-git-review-scratch-retry-20261019-06.fragment-format.log`，退出码 1。
当前 Prettier 在该组合下仍报告整文件摘要，不能单独证明片段通过；该失败证据保留，
没有用它替代独立 snippet 检查。

## 未验

- 未 build。
- 未 package。
- 未跑完整 79 项 unit。
- 未跑真实 Electron、发行包或离线替身。
- 未验证 `checkpoint-store` 的同类 Windows 清理问题；不在本次授权范围。

## 留档

- 本文件。
- 同一目录的独立日志与本轮 Playwright output。
- 修复前失败 trace 与原因分析仍保留在：
  `P5-git-review-unit-fail-trace-20261019-01/`
  `P5-git-review-bounds-只读定位-20261019.md`
