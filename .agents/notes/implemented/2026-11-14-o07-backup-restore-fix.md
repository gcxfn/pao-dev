# O07：记忆备份/恢复缺陷修复（F07/F08/F15）

核实与任务书：`.pao/memory-evolution-audit-20261112/o07-实施任务书.md`。
唯一改动源文件：`PAO/packages/coding-agent/src/pao/memory/backup.ts`。

## F15（API 兼容）

- 备份：`db.serialize()` 换成 `db.exec("VACUUM INTO '<snapshot>'")`。VACUUM INTO
  输出非 WAL 的一致性主库镜像，目标文件须不存在；路径单引号 `''` 转义。
- 恢复：去掉「deserialize→serialize→写盘」中转，VACUUM 快照本身就是干净镜像，
  直接 `copyFileSync(snapshot → targetPaths.database)`，再 `new DatabaseSync` 打开置
  `journal_mode=WAL`/`foreign_keys=ON`。
- 只用双端共有 API（exec/prepare/VACUUM INTO）；Electron 37/Node 22 的
  `DatabaseSync` 没有 serialize/deserialize/backup，Node 24 的也不能替 Electron 兜底。

## F07（恢复重定位 + 受管成果纳入备份）

- 段文件复制到 `targetHome/memory/archives/<sessionId>/<file>` 后，在恢复库内
  UPDATE `archive_segments`：`.gz` 落点写 `compressed_path` 并把 `original_path` 置
  NULL，反之写 `original_path` 把 `compressed_path` 置 NULL——`readSourceEvents`
  走 `compressedPath ?? originalPath` 读到恢复副本，不回旧 home 绝对路径。
- 受管成果（`artifact_versions` 中 `location.kind==="managed"`）备份时把
  `location.dir` 下文件复制进 `artifacts/<artifactId>/<versionId>/<file>`，
  manifest 新增 `artifacts` 段登记（缺省为空，旧 manifest 兼容读取）。
  恢复时复制回 `targetHome/memory/artifacts/<artifactId>/<versionId>/`，并把
  `location_json.dir` 重写到新落点。`kind==="git"` 的版本不动——Git 对象由仓自身保留。

## F08（恢复重放删除要清正文）

原 `purgeDerivedIndexes` 只清 FTS/向量，正本/修订/来源行保留。改成
`purgeExcludedContent`：重放 exclusion 后按既有删除语义清。

- 「整体被排除」判定复用 `sources.ts` 的 `isSourceGloballyExcluded`，不自造。
- 命中修订分两类：
  - 排除行带 `memory_id` 的「该记忆被删」标记 → 该记忆全部修订命中（关键修复：
    否则共享保留来源下被删记忆正本会残留）；
  - 整体被排除来源 → 其全部引用修订命中。
- 全修订被排除的记忆才清正本（memories/memory_revisions/memory_fts/vectors/usage/
  links/revision_links + `unlinkArtifactRefsForMemories`）；部分命中的共享保留记忆
  只清命中修订 FTS/向量。
- 来源行删除守卫 `NOT EXISTS remaining links`：整体排除来源 + 整删记忆独占来源
  才清；仍被有效记忆引用的共享保留来源保留。
- task_continuations 正文按排除命中 UPDATE content_available=0（applyDatabasePlan 同款）。
- 归档段重写：purge 后用 `isSourceGloballyExcluded`（sessionId+entryId 形态，
  sources 行已删不影响排除表查询）选段重写候选，调 `deletion.ts` 的
  `rewriteSegmentFile` 按 entryId+eventType 整事件移除；未能重写的计入 limitation。

## 结果形状

- `CreateMemoryBackupResult` 新增 `copiedArtifacts`/`missingArtifacts`；
  `RestoreMemoryBackupResult` 新增 `restoredArtifacts`/`purgedMemories`/
  `purgedRevisions`/`purgedSources`/`redactedArchiveLines`。均为新增字段，
  不破坏既有调用方与公共签名（createMemoryBackup/restoreMemoryBackup/
  parseArchiveJobScope/BackupManifest 不变）。

## 验证

- `memory-backup.test.ts` 9/9；`memory-maintenance-command.test.ts` 9/9；
  `memory-deletion.test.ts` 17/17（rewriteSegmentFile 复用无回归）。
- 反面场景亲验：共享保留来源下被删记忆正本清除且来源行保留可读；
  独占删除来源的段条目重写移除。
