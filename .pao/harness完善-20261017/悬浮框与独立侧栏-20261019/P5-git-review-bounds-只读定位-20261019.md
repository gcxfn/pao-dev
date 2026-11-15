# P5 Git Review bounds 单例只读定位

## 结论

- 唯一失败是真实产品缺陷在 Windows 上的稳定复现，不是本轮新增回归。
- 失败用例、产品实现和测试辅助函数都没有本轮未提交差异；用例和失败行均来自 2026-09-22 提交 `31f517afc`。
- `patch.txt` 的 1,260,000 字节补丁可由 Git 正常截断到 1 MiB，产品已经得到 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` 和截断输出。
- 失败发生在 `git-review.ts:1020` 的临时目录清理：立即 `rm(..., { recursive: true, force: true })` 在 Windows 报 `EBUSY`，`finally` 的异常覆盖了原本本应返回的 `available + partial` 结果。
- 该问题在 2026-10-14 的桌面验收中已记录为既有 Windows `EBUSY`，同一用例历史上的通过和失败记录都有。当前检出单跑稳定失败。
- 修复需改产品文件，按主对话要求只报告分配，本次未改产品、既有测试或 helper，也未 build/package。

## 因果链

1. 测试在隔离仓库写入 `"new line\n"` 140,000 次，文件大小 1,260,000 字节。
2. `readGitReviewFile` 的当前状态检查通过，返回 `null`。
3. `readPatch` 生成 `git diff --no-index`。产品设定的 `maxBuffer` 是 1 MiB，进程因 stdout 超过上限被终止，回调得到：
   - `error.code = ERR_CHILD_PROCESS_STDIO_MAXBUFFER`
   - `stdout.length = 1048576`
4. 产品把该错误转换成 `truncated: true`，本可继续生成 `partial` 补丁。
5. `finally` 立即删除 `pi-gui-review-*` 临时目录，Windows 上 Git 子进程仍暂时持有文件句柄，`rm` 返回 `EBUSY`。
6. 外层 catch 把清理异常转成：
   - `state: failed`
   - `code: file-review-failed`
   - `message: EBUSY: resource busy or locked, rmdir ...`

## 证据

- 直接探测的失败结果和完整 JSON：
  `P5-git-review-bounds-probe-20261019-01/probe-existing-failed-repo.log`
- 同一失败仓库第二次探测：
  `P5-git-review-bounds-probe-20261019-01/probe-repeat-existing-failed-repo.log`
- 新单跑失败仓库探测：
  `P5-git-review-bounds-probe-20261019-01/probe-single-test-failed-repo.log`
- 独立 Git 与临时目录清理对照：
  `P5-git-review-bounds-probe-20261019-01/execfile-cleanup-probe.log`
  `P5-git-review-bounds-probe-20261019-01/execfile-cleanup-retry-probe.log`
- 新单例复跑日志：
  `P5-git-review-bounds-single-20261019-01.log`
- 新单例 trace：
  `P5-git-review-bounds-single-20261019-01/unit-git-review-bounds-sna-676ca-ther-than-a-complete-result/trace.zip`
- 首次最终 unit 结果 trace 的独立副本：
  `P5-git-review-unit-fail-trace-20261019-01/unit-git-review-bounds-sna-676ca-ther-than-a-complete-result/trace.zip`
  SHA-256 `B7888A1CA5A18B270A57BE2EFEA97FF9FFB66FC10E4928A4834DFC79E54C4142`，7,875 字节。
- 上述独立副本与原始 trace 字节一致；新单跑未覆盖原始 trace。
- 历史既有失败记录：
  `.pao/通用工作台实施-20261014/验收/阶段6-其他交互与TUI补齐.md:80-83`

## 实验数据

| 实验 | 次数 | 结果 |
|---|---:|---|
| 原产品调用：测试失败仓库 | 3 个不同仓库 | 3 次均 `failed`，`message` 为 `EBUSY` |
| `execFile` 截断后立即 `rm` | 5 | 5 次均 `EBUSY` |
| `execFile` 截断后 `rm` 增加 `maxRetries: 5, retryDelay: 50` | 5 | 5 次清理成功，耗时约 57-68 ms |
| Playwright 原样单跑 | 1 | 1 failed，持续 890 ms |

临时补丁注入脚本没有命中 Playwright 实际加载的产品模块，因此仅保留失败日志，不把临时注入当成修复验证。

## 边界与未验

- 本轮 `主对话复核-最终unit01.log` 的 76 通过、2 个既有 Windows skip、1 失败合计 79 项。
- 本次另外只复跑了失败单例，没有重新跑 79 项全集。
- 未改 UI，因此没有真实 Electron、发行包或离线替身证据。
- 建议的最小产品修复：在 `apps/desktop/electron/platform/files/git-review.ts:1020` 的清理调用中增加 Windows 可接受的有限重试，例如 `maxRetries: 5, retryDelay: 50`；重试仍失败时保留清理异常。需要产品写者确认对全部平台的语义。
- 建议定点复验：
  1. 用原命令单跑 `bounds snapshot hashing`。
  2. 若通过，再跑完整 `git-review.spec.ts`，确认其他截断、二进制、路径与 staging 分支不受影响。
  3. 运行相关 TypeScript 检查。
  4. 检查 `%TEMP%\pi-gui-review-*` 不再因该分支新增残留目录。
- 不在本小包顺手修改 `checkpoint-store.ts` 的类似清理；其历史 `EBUSY` 是独立问题，需单独立项验证。

## 命令与退出

| 命令 | 退出码 | 结果 |
|---|---:|---|
| `git status/diff/log` | 0 | 失败用例与产品文件无本轮未提交差异；历史定位到提交 |
| `jiti probe.mts <失败仓库>` | 0 | 脚本完成，记录产品返回 `failed` |
| `node execfile-cleanup-probe.mjs` | 0 | 5/5 次立即清理 `EBUSY` |
| `node execfile-cleanup-retry-probe.mjs` | 0 | 5/5 次重试清理成功 |
| `playwright test ... --grep "bounds snapshot hashing"` | 1 | 1 failed，原断言在 `git-review.spec.ts:64` |
| 临时补丁注入 Playwright（首次） | 1 | Node `NODE_OPTIONS` 路径格式错误，未运行测试 |
| 临时补丁注入 Playwright（第二次） | 1 | 加载模块解析错误，未运行测试 |
| 临时补丁注入 Playwright（命中尝试） | 1 | 测试仍 failed；注入未命中产品模块，不作修复证据 |

## 临时脚本

仅在工作区 `临时文件夹/git-review-bounds-investigation-20261019/` 创建：

- `probe.mts`
- `execfile-cleanup-probe.mjs`
- `execfile-cleanup-retry-probe.mjs`
- `register-git-review-retry-patch.mjs`

产品与既有测试文件未修改。
