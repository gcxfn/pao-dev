# S7-09：记忆库与归档的一致性备份/恢复

- 日期：2026-11-10
- 位置：`PAO/packages/coding-agent/src/pao/memory/backup.ts`；archive handler 挂 `tools.ts`；测试 `test/pao/memory-backup.test.ts`

## 决定

- 备份不走「复制活跃 WAL 主库文件」，用 `DatabaseSync.serialize()` 取一致快照落 `memory.snapshot`，manifest.json 登记段文件清单（含 sha256/sizeBytes）。
- 恢复：serialize 输出带源库 WAL journal 头，直接 deserialize 到磁盘路径在 node:sqlite v24 下报 "unable to open database file"。走「快照→`:memory:` 库→再 serialize→writeFileSync 写盘」中转，得到干净非 WAL 镜像再正常打开。
- exclusion 语义是「检索不可见」不是物理删除：恢复时 liveHome 的 `source_exclusions` 用 `INSERT OR IGNORE` 重放，再清命中行的 memory_fts/memory_vectors 派生索引，正本 memories/memory_revisions 行保留。不传 liveHome 的独立旧备份只留备份自带 exclusion，manifest.limitation 如实声明「无法推断备份后删除」。
- 「暂停本 home 记忆写作业」由 archive jobKind 占用 extraction_jobs 队列自然满足，不加全局写锁。
- `serialize`/`deserialize` 不在 @types/node 声明，须 `as unknown as` 强转；`run().changes` 是 `number|bigint`，计数须 `Number()`。

## 被否方案

- `PRAGMA journal_mode=DELETE` + 直接 deserialize 到磁盘：仍报 unable to open（journal 头已随快照携带）。
- serialize 前 `wal_checkpoint(TRUNCATE)`：不改变 serialize 输出的 journal 模式字段。
