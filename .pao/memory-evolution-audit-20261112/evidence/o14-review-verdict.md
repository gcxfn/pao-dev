# O14 独立复核结论（复核修正：O14 独立复核）

核实日期：2026-11-15。不采信实施报告，按反面场景逐项亲验。

## 判定：O14 可关闭

全部 12 个收拢项通过；4 个 scheduler 测试失败经独立复核证实为 O03 期既有夹具
问题（非 O14 回归），实施代理的「in-flight O03」归因属实。

## 逐项结论

| # | 项 | 结论 | 亲验证据 |
|---|---|---|---|
| 1 | select/problems 行映射 | PASS | select.ts:15 只 import `getProblemRow`/`rowToProblem`，私有副本已删；problems.ts:48-94 导出 `EvolutionProblemDbRow`/`rowToProblem`，:600 导出 `getProblemRow`；select 决策、store.transaction、状态机约束（:84-179）完整未动。 |
| 2 | candidates 去哈希 | PASS | candidates.ts:331 `diffsEqual` 改逐字段（path/kind/newContent）排序后比较，sort 保留。自建对偶探针 `o14-review-probe-diffsequal.mjs` 8 边界全过：同 path 不同 newContent→不等、同内容不同 kind→不等、diff 字段有无不影响、delete vs edit-空→不等、乱序→等、长度差→不等。edit 差异语义靠 newContent（applyEdits :312 总写 newContent），diff 字段仅是表达形式，忽略它正确。 |
| 3 | 指纹第 4 份 | PASS（O13 收口确认） | recovery.ts:96/258 用 `fingerprintResourceRoot`（versions.ts:168 共享实现），注释 :91 标 O13/S9-11；grep 无 recovery 私有副本。control.ts:145/activation.ts:138 的 `fingerprintDirectory` 是共享函数薄封装非重复实现。 |
| 4 | 进化入口唯一化 | PASS | grep 全 src/pao：classify/select/freeze/propose 仅 tools.ts `evolveOneProblem`(:1221) 编排调用；其唯一生产入口是 maintenance.ts 的 `evolve` handler（:1138），经 `enqueueEvolveJob` 唤醒。无编排外跳过 select/freeze 的生产路径。 |
| 5 | extract-commit 保留现状 | PASS | 亲验 node:sqlite 嵌套 BEGIN（IMMEDIATE 与普通）均抛 `cannot start a transaction within a transaction`（探针 `o14-review-probe-nested-tx.mjs`）。服务方法 `createMemory`/`flagForReDiscussion`/`correctMemory` 各自开 BEGIN IMMEDIATE，要把补链折进同一事务必须 service 新增「在已开事务内执行」接口=新增服务面。实施已把补链包 `store.transaction`（extract-commit :434/622/730）满足「候选级事务」契约。理由属实非借口。 |
| 6 | 来源回读按段复用 | PASS | extraction-scheduler.ts:172 `entriesFromSources` 用 `readSourceEventsBatch`（archive.ts:392），同段分组每段 `readSegment` 一次。`range:{limit:1}` 传入 → `windowEventsFromLines`（archive.ts:342）limit 钳位 1、锚定 `source.entryId`——与原 `readMemorySource({limit:1})`（service.ts:765→readSourceEvents :546 limit 钳位同口径）窗口语义一致，不漂移成 50 窗口。探针断言 `segmentReads===1` 是真计数。 |
| 7 | capture 去附件 SHA256 | PASS | capture.ts:180 `attachmentId=att-${indexPrefix}-${index}`（entryId+块序号），无 createHash/sha256 调用。重复采集幂等靠 `isCaptured`（:292 sources 查重）与 `existsSync(filePath)`（:186）双挡；附件共享删除走 deletion.ts `findManagedAttachments` 的 managedPath 引用比对（非哈希），受管路径未动。 |
| 8 | pendingScopes 删内存正本 | PASS | maintenance.ts `pendingScopes` Set 已删；`drainQueue`(:216) 扫 `status='pending' AND job_kind != 'extract'` 覆盖原内存集全部用途（embed/organize/archive/evolve）。`enqueue`(:198) 只调本实例 `wakeup()`（`lastSettledCtx` 复用）；跨实例广播收窄到 `wakeHomeJobs`(:369) 只被 `enqueueEvolveJob`(:389) 用——宿主路径不再广播，O03/I02「B 的 settled 领 B 的 job」语义保持。提炼收尾 `embedForSession`(extraction-scheduler:422) 与 embed handler(tools.ts:1078) 同调 `embedCurrentMemories`(runtime-embedding:114)，取消/预算/记账不分叉。 |
| 9 | 费用内核聚合 | PASS | usage-query.ts:299 `byPurpose=aggregateByPurpose(entries)`，:334 已知/未知口径（`totalTokens>0 && cost.total!==undefined`）与主 `byJob`(:217) 一致；desktop/memory.ts:2006-2037 只 DTO 映射 `result.byPurpose`/`result.total`，页面侧无重复分组判定残留。 |
| 10 | artifacts 事务缩短 | PASS | artifacts.ts `resolveFile`(:361) 在事务外做 git rev-parse/cat-file + 受管读盘；事务(:451) 内只剩 source 校验/重放/Git 查重 SQL/行写/受管副本落盘。受管副本留事务内理由成立：副本目录依赖事务内决出的 artifactId+versionId(:544)，且副本写(:606-616)在版本行 INSERT(:618)前，写失败 throw→ROLLBACK 不留「版本行指向缺失文件」。探针 `gitSpawnsInTx===[]` 是真收集数组。 |
| 11 | backup 去摘要 | PASS | backup.ts:69/84 sha256 字段仅保兼容形状不再写；备份用 `copyFileSync`+`statSync(dest).size`(:281/309) 不整文件重读。恢复侧（:399-856）manifest 只读 `backupPath`/`file`，不读 sha256；身份/路径/大小保留。 |
| 12 | desktop mtime 先选候选 | PASS | desktop/memory.ts:2109-2129 收集全部 session 文件 + mtime → `sort(mtimeMs desc)` → `slice(0,limit)` 先选候选再逐文件解析；夹具断言 `items[0].requestId==="req-new"` 真断言业务结果。边界：mtime 相同按枚举序（与原目录序同为有界任意序）、只扫一层子目录、坏文件 try/catch 跳过——无回归。 |
| 13 | scheduler 4 失败归属 | PASS | `o06-scheduler.log`/`o06-recheck-scheduler.log`（O06 批）里同样的 stale/F06/F05/I01 用例已以相同「等待 scheduler 收尾超时」失败——O03 期既有夹具时序问题，非 O14 回归。独立探针另证失败机制：F05 job 实际到 done 是「来源 projectId 被 resolveMemoryProjectIdentity(cwd) 解析为真实项目 d:\ai\workspace\pao-dev\pao 覆盖 job scope 的 proj-f05」→ stopped 记忆 scope 不匹配未被拦截——该 scope 覆盖逻辑（scopeForSource :274 + defaultSessionProjectResolver :259，O03/O05 期代码）非 O14 所改。 |

## 复核探针（源码副本在 evidence/，跑完即删不入测试树）

- `o14-review-probe-nested-tx.mjs`：node:sqlite 嵌套事务抛错实证（支撑 #5）。
- `o14-review-probe-diffsequal.mjs`：diffsEqual 8 边界对偶（支撑 #2）。
- `o14-review-probe-commit.mjs`：commit 层对 stopped 记忆返回 source_resting_stopped（定位 #13 失败在 scope 覆盖层非 commit 层）。
- `o14-review-probe-f05.mjs`：F05 场景 drain 实际推进 dump。

## 测试通过数（隔离 PAO_HOME，PI_OFFLINE=1 PI_NO_LOCAL_LLM=1）

- memory-artifacts + memory-desktop-usage-bridge + memory-backup：32 passed。
- memory-usage-aggregation + memory-usage + memory-extraction + memory-capture-boundary + memory-maintenance：56 passed。
- evolution-problems + evolution-validation + evolution-e2e + evolution-o10 + evolution-o13 + evolution-version：90 passed。
- evidence-archive + memory-context-usage + desktop-maintenance + evolution-activation + evolution-binding + evolution-control：70 passed。
- memory-extraction-scheduler：6 passed / 4 failed（O03 既有失败，非本批回归，证据见 #13）。

## 非 blocker 说明

- extraction-scheduler 的 4 个 O03 失败是「测试夹具在真实仓库 cwd 下解析来源 projectId 与夹具 scope.projectId 不一致」的既有问题，归 O03/O05 排查范围，不属 O14 收敛项；本复核不属修复范围，如实记录。
