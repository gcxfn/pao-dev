# O14 收拢改善证据

核实日期：2026-11-15。验收口径要求「读盘次数 / 事务范围 / 重复消除行数」有具体改善证据；
本文件登记三条可复跑的探针结论，断言均在测试内，非「理论上更好」。

## #6 来源回读按段复用 —— 读盘次数

测试：`test/pao/memory-extraction-scheduler.test.ts` 末尾
「O14：同段多来源一批只读段文件一次（读盘次数探针）」。

机制：`ExtractionSchedulerDeps.readSegment` 探针包住 `readSegmentLines`，
对同一归档段的 3 个来源一次 `entriesFromSources`。

断言：
- `seenBatches === [[s1, s2, s3]]`（三个来源进同一批）；
- `segmentReads === 1`（段文件只读/解压一次）。

改前逐来源 `readMemorySource` 读同段 3 次；改后 1 次。**读盘次数 3→1。**

## #10 成果登记事务缩短 —— 事务范围

测试：`test/pao/memory-artifacts.test.ts`
「O14：登记事务内不发起 git 子进程（事务范围证据）」。

机制：`vi.mock("node:child_process")` 计数 `spawnSync("git",…)`；
`store.transaction` 包一层置 `probe.inTx`，统计事务体内的 git 子进程。

断言：
- `probe.gitSpawnsTotal > 0`（确实走了 Git 定位路径，防假通过）；
- `probe.gitSpawnsInTx === []`（写事务体内 git 子进程数 = 0）。

改前 `prepareFile` 的 `rev-parse`/`cat-file`（30s `GIT_READ_TIMEOUT_MS`）
全在写事务内；改后 `resolveFile` 把所有子进程与受管读盘挪到事务前，
事务内只剩身份核对 + 行写。**事务范围从「含子进程」收为「无子进程」。**

## #12 上下文查询先选最近文件 —— 行为证据

测试：`test/pao/memory-desktop-usage-bridge.test.ts`
「O14：按文件 mtime 先选候选——旧会话占满 limit 时新会话仍被取到」。

机制：两目录 `--proj-a-old--`/`--proj-b-new--`，utimes 把旧文件拨早、
新文件拨晚；`limit:1` 只容下一个候选。

断言：`items[0].requestId === "req-new"` —— 按 mtime 先选候选后，
目录序靠后但更新的新会话必须进结果（改前被旧会话占位跳过）。

## 附：重复消除

- `select.ts` 删除自有完整 Problem 行/SELECT/rowToProblem，改由
  `problems.ts` 导出的 `getProblemRow`/`rowToProblem`（O14 注释 :56）。
- `candidates.ts:328` 去 diff 哈希改逐字段比较（diffs 已在内存）。
- `capture.ts:170` 去每图 SHA256，用已有 attachmentId(entryId+块序号)。
- `backup.ts` 删 manifest 的 sha256 字段与逐段额外读盘。
- `usage-query.ts` 内核一次聚合 byPurpose，`desktop/memory.ts` 只 DTO 映射。
- `maintenance.ts` 删 pendingScopes 内存正本，drain 统一扫库内 pending。
