# 记忆主链最终审核

核实日期：2026-11-15。范围：O01—O07 与 O14 的记忆调用链。业务修改仅涉及用户授权的 backup.ts、memory-backup.test.ts、archive.ts、memory-source.test.ts，以及 memory-extraction-scheduler.test.ts 的两处夹具身份。总报告未修改。

## 结论

scheduler 原四项失败是夹具项目身份不一致；不是 O14 回归。原测试夹具已修正，整个原套件 10/10 通过，断言和时限保持。O07 P3 和同段重复解析已修复。M1—M5 保留为待修事项，相关业务代码保持只读。当前范围不能判为全部通过。

## 已复现、尚未修复

### M1 / P1：预算仍按金额结算，缺少 token 额度闭环

成本按实际 token 用量计量，规则见[成本计量口径](../../优化任务.md#成本计量口径)。已返回的 1200 token 是已知成本；缺少模型单价只影响金额估算，不要求把这些 token 标未知。

受支持触发：配置自定义模型但省略可选 cost，模型返回正常 token 用量，然后走 requestExtraction。无需异常供应商输入。

路径：D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/core/provider-composer.ts:240 为未声明价格补零费率；D:/AI/workspace/pao-dev/PAO/packages/ai/src/api/openai-completions.ts:1558 调 calculateCost；D:/AI/workspace/pao-dev/PAO/packages/ai/src/models.ts:1211 合成 total；D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/extract-model.ts:535 将该数结算；D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/usage-query.ts:217 与 :344 按字段存在认定已知。

证据：final-memory-7c2a-cost-observed.json、final-memory-7c2a-cost-results.json。内存定义没有 cost，真实运行时补四项 0，SDK 计算 1200 token 为 0；真实提炼入口将 0.05 预留结为 settled/0，实际账本聚合 unknownCount=0。仅模型响应为离线替身，配置装配、计算、预算和账本查询均为真实实现。

影响：当前预算使用美元预留和 SDK 金额结算，1200 token 不直接参与额度扣减，尚不能按 token 限制后台消耗。金额为零不等于没有 token 消耗。

最小修法：复用现有账本接入明确的 token 额度、预留与结算，各请求按实际 usage 汇总。缺实际用量才保留未知占额；缺价不阻断已知 token 的结算。金额有单价时补充估算，没有单价显示未估算；旧金额记录不改解释为 token。

V4 结论：已有 evidence.json 的 1200 token 支持该次用量已知，不能据 SDK cost.total=0 宣称零 token 消耗。现有金额路径探针用于定位当前账本接线，不作为 token 控额已经正确的证据；token 控额的关账要求见 AF05。

### M2 / P1：图片引用被脱敏抹掉，彻底删除仍遗留受管图片

受支持触发：普通用户图片消息被采集，再删除唯一引用该来源的记忆。

路径：D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/capture.ts:173 把图片落盘并生成 attachmentId/managedPath，:214 将引用交给通用脱敏；D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/context/index.ts:134 将所有 image 块变成 omitted；D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/deletion.ts:598 只能从归档引用收集待删附件。

证据：final-memory-7c2a-attachment-observed.json。真实持久会话图片文件已落盘，归档只剩 image/omitted，无附件引用；真实删除返回 complete、pendingObjects=[]，图片字节仍存在。

最小修法：在采集脱敏口保留已卸载的受管附件身份与路径，继续剔除原始二进制；让现有附件引用扫描完成共享判断与删除。无需新建附件登记正本。

### M3 / P2：记忆备份不包含采集所得图片附件

受支持触发：同一普通图片采集后，调用已有备份/恢复到新 home。

路径：D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/backup.ts:241 读取受管成果清单，:282 复制来源段，:310 复制成果；没有附件复制分支。附件真实归属见 D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/paths.ts:38。

证据：同 attachment-observed.json；恢复成功且 restoredSegments=1，但原 home 有图片、新 home 没有图片。该事实独立于 M2 的引用丢失。

最小修法：沿已有来源段清单纳入其受管附件，恢复到目标 memory/attachments，复用来源删除范围排除已删除附件；保留缺失提示，不新增摘要或独立备份平台。此次授权的 backup 修改仅限 P3，未扩大修复。

### M4 / P2：索引重建使仍存在的历史修订失去词法召回

受支持触发：同一记忆经 correctMemory 产生旧修订，使用 /pao memory rebuild，然后按旧修订独有词查询 history/superseded。

路径：D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/session.ts:1484 调重建；D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/rebuild-index.ts:140 清索引，:158 只重建 current_revision。

证据：final-memory-7c2a-integration-results.json 的 FINAL-HISTORY。重建前独有词命中 rev1，重建后无命中；数据库仍有两个修订，droppedFts=2、rebuiltFts=1。语义路明确离线禁用，这是受支持的词法降级路径，不要求配置向量。

影响：O04 的历史检索与 O06 的维护入口不一致，旧结论只能凭准确身份追溯，不能按内容发现。current 检索继续只取当前修订的规则本身正确。

最小修法：在既有重建入口恢复范围内可查历史修订的 FTS，保留 current 查询的当前修订筛选、范围隔离和来源排除。无需改变修订正本。

### M5 / P2：取消旧后台尚未收尾时，新 settled 的唤醒会丢失

受支持触发：后台提炼在途；用户启动新回合取消后台；新回合先 settled，旧请求/异步读或取消收尾之后才结束。这是异步调用的先后顺序，不依赖毫秒抢锁。

路径：D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/extraction-scheduler.ts:348 在 draining 存在时直接返回，:350 清锁但不消费已登记的后续唤醒。

证据：final-memory-7c2a-integration-results.json 的 FINAL-WAKE。真实调度器、采集、队列与释放路径；离线请求替身固定上述合法顺序。第二次 settled 后，旧请求释放，job 留在 pending，调用数仍为 1。静态调用链确认没有 drain 尾部唤醒。尚未做真实供应商取消延迟验证，不能将此描述成已实测某供应商故障。

最小修法：在现有串行 drain 内保留一次“期间收到新 settled”的唤醒，收尾且前台空闲后消费；仅有新唤醒才续轮，避免普通失败立即无限重试。不新增轮询器或队列。

## 已修复

### O07 P3

D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/backup.ts:674：旧 manifest 未登记的 managed 版本也逐版本 missing+=1。D:/AI/workspace/pao-dev/PAO/packages/coding-agent/test/pao/memory-backup.test.ts:635 断言 restoredArtifacts=0、limitation 包含“受管成果副本缺失 1 个”。

新断言在修复前失败（final-memory-7c2a-backup-before.json），修复后整个备份套件 12/12 通过（final-memory-7c2a-backup-after.json）。原路径重定位与 unavailable 断言均保留。

### FINAL-PARSE / O14

D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/archive.ts:475 每段解析一次，组内窗口复用解析结果。既有 windowEventsFromLines 签名保持，局部解析数据只在本批使用。

D:/AI/workspace/pao-dev/PAO/packages/coding-agent/test/pao/memory-source.test.ts:480 增补读盘/解析计数、与逐条回读的窗口结果一致、缺来源和坏行语义。三来源三事件由 1 次读段、9 次 JSON.parse 降为 1 次读段、3 次 JSON.parse。来源套件 10/10；独立 FINAL-PARSE 与 scheduler 原 O14 用例 2/2 通过。证据：final-memory-7c2a-source-after.json、final-memory-7c2a-parse-after.json。

## scheduler 四失败归属

原副本复现 stale、F06、F05、I01 四失败。F06 是 projectId 断言不符，其余三项等待预期 failed 状态超时，并非四项都是超时。

原因：createCapture 默认由真实会话 cwd/进程 cwd 解析项目，夹具却用 proj-a、proj-f05 等手写身份建记忆和 job；调度正确优先使用来源自身的项目身份后，旧记忆范围不匹配。

仅证据副本的 createCapture 注入 resolveSessionProject 对齐既有夹具 projectId；业务代码、原断言、等待时间不变，十项全部通过，包括四项原失败。原测试夹具现已落地：D:/AI/workspace/pao-dev/PAO/packages/coding-agent/test/pao/memory-extraction-scheduler.test.ts:89 的采集器使用 SCOPE.projectId；:308 的共用夹具采集器使用 scope.projectId。断言和等待时限保持，scopeForSource 来源优先逻辑保持。原套件仅运行一次，10/10 通过。最终结果见 final-memory-7c2a-scheduler-final-results.json，变更范围核对见 final-memory-7c2a-scheduler-final-change.json。

证据：final-memory-7c2a-scheduler-original.test.ts、final-memory-7c2a-scheduler-aligned.test.ts、final-memory-7c2a-scheduler-results.json。后者记录原副本 6 通过/4 失败、对齐副本 10 通过。来源批读优化后又定向验证原 O14 同段读取用例通过，没有重跑无关四项。

## 覆盖与限制

已读根、PAO、desktop 规则，优化任务和 O01—O07/O14 相关任务书/复核，沿采集、来源身份、提炼提交、持久队列、scope、current/history、来源展开、整理、索引重建、删除、备份恢复、请求费用边界核对。O02 确认/纠正和 O04 范围筛选的已有修复未见本轮可确认回退；O06 条件/确认兼容与维护登记事务静态核对未发现新增确定问题，没有重跑它们已通过的无关检查。

本轮新增复现均使用隔离 PAO_HOME；模型响应为离线替身，来源/SQLite/服务/预算均为真实实现。未发付费请求，未读正式 D:/AI/workspace/pao，未读私人 auth/models 内容，未运行全量测试、构建或 Electron。没有审核自进化、成果业务或桌面页面；备份涉及的 managed 版本仅用于 P3 既有用例。

未覆盖：真实模型费用来源和真实延迟取消、实际 Electron/发行包、长期大段性能耗时、跨进程并发故障注入、全量删除故障恢复。上述未完成项无环境阻塞，按本轮范围收口保留，不作为已通过。

复现入口：在开发根运行 node PAO/node_modules/vitest/vitest.mjs run --config .pao/memory-evolution-audit-20261112/evidence/final-audit/final-memory-7c2a.config.ts；可用 -t FINAL-HISTORY、FINAL-WAKE、FINAL-COST、FINAL-ATTACHMENT 分别定向。未修复项断言仍应失败；PARSE 已通过。原始结构化结果保留，不覆写为全绿。

## 最终交付

原 scheduler 夹具两处项目身份已落地，原套件单次运行 10/10 通过。新增来源测试已按文件既有 tab 缩进整理；archive.ts 注释准确区分未解析 lines、parseSegmentLines 与 windowEventsFromParsed 的批内复用。此后仅文字/格式调整，未重复测试。

本轮 scheduler 的隔离 home、临时目录与 cache 位于 final-memory-7c2a-scheduler-runtime，已通过 Microsoft.VisualBasic FileIO DeleteDirectory + SendToRecycleBin 移入回收站。结果见 final-memory-7c2a-scheduler-final-cleanup.json；测试源码、结构化结果与报告保留。M1—M5 状态仍为待修。
