# 存储、来源与自动提炼审核

核实日期：2026-11-12。范围：S0—S2、S4-12—15。结论对应当前工作区源码，包含未提交改动。

## 结论

数据库正本、修订事务、来源回读、删除作业、builtin 配置切换和角色装载边界已形成可用实现。**自动提炼的确认状态演进、纠正入口、停用重放、恢复调度、外发许可和预算仍有缺口，不能按原阶段“全部完成”认定需求完整兑现。**

本轮确认 13 项问题，另记录 3 项结构优化。执行两组无网络、无磁盘写入的定向探针：第一组实际调用提交函数与作业函数，命中确认状态被吞、停用重放进入新建路径、累计尝试次数耗尽三项；第二组实际调用候选校验入口，确认工具失败回执及助手引文能错误通过用户事实校验。模型返回与落库服务的替身使用范围见 §6，未将其作为真实模型成功证据。

删除实现没有发现可据当前证据判定的新增确定性缺陷；已实现真实会话、归档、索引、附件和共享引用的范围处理。该结论不扩展到未深读的 S8/S9 进化候选副本。

## 1. 基线、依据与审读深度

| 仓库 | HEAD | 当前相关工作区差异 |
|---|---|---|
| 开发根 | `1ccec6e4c894b6e5b5edb91adef139263c12deab` | README、需求、架构及计划/证据等存在未提交内容 |
| PAO | `1a6683ceeb968378a6dae910516c1da021ca75ff` | memory/paths.ts、store.ts、desktop/memory.ts、desktop/index.ts、friction/drafts.ts；另有 evolution 模块与宿主挂载等在建内容 |
| desktop | `c9fc3f34d2618872ab5343d394de271baf9e840d` | driver、memory bridge、进化页面及 IPC 等存在 S9 相关改动 |

遵循工作区、开发根、PAO、desktop、plans、driver、desktop app 规则及 code-simplicity 技能。未修改业务代码或其他人的文件。审核产物为本报告及 §6 引用的两组原探针输入/输出。

依据：设计全文、实施总计划相关正文及 S0—S2/S4 任务、S0—S4 详细路径、方案调查固定提交要求、S0/S1/S2/S4 原验收报告、S4 的 I04/I08 原始回执及 S4-17 current manifest、S0 规模预算及调用点清单、当前操作说明和需求/架构对应段。

深入阅读：memory 的 paths/store、sources/capture/archive、service 的创建/读取/纠正/状态/合并/重议/来源、extraction-jobs/scheduler、extract-model/commit、tools 装配与管理工具；deletion 的范围展开、共享保留、持久计划、数据库清理、文件推进和会话协调关键段；session 的 builtin 纠正命令；knowledge 经验入库与 auto-route；总入口和 role。

沿实际调用者核对：CLI 扩展总装配、桌面初始化与 mutation、driver 公开加载、worker 派发引用、workflow/distill。测试源码为定向审读和覆盖扫描，本轮没有重新运行 Vitest/Electron/发行物测试。S3 搜索算法与 resident 主体不在本轮范围；仅定位装配边界，未给算法通过结论。S5—S9 只读本轮链路直接依赖的边界。

路径缩写：`K` = `D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao`；`KT` = 同包 `test/pao`；`D` = `D:/AI/workspace/pao-dev/desktop/apps/desktop`；`B` = `D:/AI/workspace/pao-dev/desktop/packages/pi-sdk-driver`。下列位置均为本轮当前源码行号。

## 2. 实际装配与数据去向

```text
CLI/桌面共享扩展入口 K/index.ts
  → registerMemory 读取 记忆供应商.json
  → builtin: registerBuiltinMemory
      → 惰性 MemoryService + 引用计数 MemoryStore
      → registerCapture(session_start / before_agent_start / turn_end / agent_settled)
      → 首次 before_agent_start 装 extraction scheduler
      → turn_end 登记会话，agent_settled 启动 drain
      → 来源归档回读 → related 摘要 → requestExtraction
      → 档位 fast → modelRegistry.find → streamSimple.result
      → candidate 校验 → commitExtractionCandidates → service 创建/重议
      → 游标与 job 状态 → 当前修订嵌入
```

关键位置：`K/index.ts:888`、`K/memory/index.ts:493`、`K/memory/tools.ts:655,709,721`、`capture.ts:360`、`extraction-scheduler.ts:242,356,426`。自动提炼确有真实生产调用，未停留在导出或测试函数层。

数据与来源：`PAO_HOME/memory/memory.sqlite` 是结构化正本；归档、附件、成果同在其 memory 根。来源由实际 sessionId/entryId/eventType 定位，来源关联按 memoryId+revision 保存。采集先写允许保存的归档事件，再登记来源。启用边界以 boundary 来源标记，增量按条目 ID 去重。

后台模型沿现有注册表、认证与档位，不创建第二套模型运行时。`runtime-embedding.ts:137` 把 job 账本放在 `PAO_HOME/memory/background-ledger/<jobId>`，当前实现已替代 S2 原报告所述的内存账本。`extract-model.ts:341,417` 分别记尝试与 usage；消息返回 error/aborted 时仍记录已返回用量。请求直接抛出时只留 attempt/failure；供应商金额缺失不能据零值声称免费。

部门新经验：`K/index.ts:715` 注入同一 builtin service；`knowledge/tools.ts:492,535,580,591` 要求真实成功回执、归档并回读来源、创建 experience，再把候选移入文件归档。`auto-route.ts:207,303,425` 分开正式与待定经验及文件资料；`workflow/distill.ts:180` 按任务时间窗和可信项目/任务查数据库，替代 Markdown mtime 点名。

桌面配置：`D/electron/platform/pao/memory-bootstrap.ts:36` 经 driver 调内核 initializeMemoryConfig。缺文件创建 builtin，已有文件保持；CLI 有显式 init/use/switch 命令。切换仅影响新会话，不停旧共享服务。worker 的 memory/knowledge/resident 由 `K/role.ts:96` 跳过；派发经 `K/index.ts:662` 取 selectedReferences，`dispatch-brief/brief.ts:409` 冻结 ID、修订、条件和来源。

## 3. 已确认问题

### F01 · P1：云端提炼绕过外发许可

- 位置：[extraction-scheduler.ts:426](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/extraction-scheduler.ts:426)、[extract-model.ts:399](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/extract-model.ts:399)。下游 `core/model-registry.ts:138` 直接转运行时；运行时该调用路径没有 PAO 项目外发检查。
- 支持触发：builtin 已启用且 fast 指向云端模型，项目外发许可缺失、拒绝或过期；正常新对话 settled 后仍把归档正文及相关决定发送给模型。
- 需求：[实施总计划第 40 行](D:/AI/workspace/pao-dev/plans/未完成/2026-11-08-内置记忆与受控自进化实施计划.md:40)原文：`| 外发许可 | K/knowledge/outbound.ts | 云端嵌入、提炼和验证沿用已有许可；本地读写与本地关键词查找不依赖外发许可 |`（路径的 Markdown 反引号略去）。这是本项目明确扩展至云端提炼的定案；F01 不以 outbound.ts 的嵌入专用字段注释推导适用范围。
- 影响：本地管理与云端提炼的许可边界不一致。嵌入路径有许可检查不能替代提炼检查。
- 最小修法：提炼请求前按本批实际来源范围复用 checkOutbound；拒绝时保留未提交范围和明确原因，本地采集/管理照常。
- 验证：用请求记录器覆盖缺失/拒绝/过期/允许及撤销后的下一批；前三种与撤销后请求数应为零，允许时才发送。当前结论为生产调用链静态确认，未真实外发。

### F02 · P1：后台预算门未接入自动提炼

- 位置：[extraction-scheduler.ts:394](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/extraction-scheduler.ts:394)、[extract-model.ts:399](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/extract-model.ts:399)、`K/memory/budget.ts:106`。
- 支持触发：新装 builtin、档位可用，但没有记忆后台预算或额度已用尽；settled 仍直接调用模型。
- 需求：S2-12、总计划 §9 的日常后台额度边界；budget.ts 自身约定未配置不开展额外付费作业。
- 证据：生产领取/请求链未调用 checkMemoryJobBudget；该符号在 memory 内只有定义和导出。记 usage 不等于额度预留和停止。
- 影响：首次验收不限额的决定会在产品日常路径中表现成无门控调用。
- 最小修法：在实际模型请求处接既有预留、结算、未知费用占额和拒绝后的 pending；不同增量批次保持独立用量，避免会话 job 的旧预留被无限复用。
- 验证：无配置、零额度、额度不足不调用模型；有额度调用并结算，失败尝试仍计费，未知费用不释放为零。此项是 S2 调用链缺陷，预算算法本身的完整审核归 S7。

### F03 · P1：自然语言纠正没有到同一修订入口

- 位置：[tools.ts:216](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/tools.ts:216)、[tools.ts:282](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/tools.ts:282)、[extract-commit.ts:451](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/extract-commit.ts:451)、`K/memory/session.ts:1016`。
- 支持触发：对话中明确说“把刚才那条 top5 改为 top3”，模型使用现有写入工具或后台提炼处理。写入工具只有 content/tags，直接 createMemory；提炼只 create/flag，没有 correction 操作或目标修订字段。
- 需求：S2-08 及详细路径要求命令和写入工具接受明确 correction，页面与对话共用 correctMemory，并即时清理旧依据。
- 影响：旧正式决定保持 active，新相反结论成为另一条 active 记忆；用户必须改用页面或交互命令才能可靠纠正，普通对话不能兑现该契约。
- 最小修法：给既有写入工具增加明确 correction 操作与准确 ID/expectedRevision，唯一目标时调用 service.correctMemory；确有多个影响后续动作的目标才询问。普通提炼不能自行把相反结论视为用户纠正。
- 验证：通过真实会话工具链说出明确纠正，确认同一 ID 新修订、旧版历史、当前后续动作使用新依据；无 UI 会话也应能使用明确工具操作。

### F04 · P1：同结论去重吞掉确认状态、条件和理由变化

- 位置：[extract-commit.ts:194](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/extract-commit.ts:194)、[extract-commit.ts:378](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/extract-commit.ts:378)、[extract-commit.ts:402](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/extract-commit.ts:402)。
- 支持触发：先“可以考虑 SQLite”，下一轮“就用 SQLite”；或同一来源补提炼出相同结论但更完整条件/真实理由。批内、来源级及同结论同条件去重均没有比较 confirmation/evidenceKind/rationale；来源级还在条件变化判断之前返回。
- 需求：S2-05/06/07：讨论与正式决定分开，明确选择形成正式修订，条件变化能重议。
- 证据：纯内存调用真实 commit 函数，confirmed 候选返回 duplicate；库中原记录仍 tentative，create 调用为 0。批内相同结论也直接跳过第二条候选。
- 影响：明确确认无法转正；被否/待定与正式状态可能被首条记录固定，条件/理由更新丢失。
- 最小修法：只对业务字段一致的候选复用补链；确认与条件的有效变化走明确的修订/重议分支。保留用户依据，不能让模型推断自行升级。
- 验证：tentative→confirmed、rejected→用户重新采纳、相同结论异条件、同来源补理由、批内不同状态分别验证字段及修订历史。

### F05 · P1：停用后以原来源重新提炼仍能走新建

- 位置：[extraction-scheduler.ts:171](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/extraction-scheduler.ts:171)、[extract-commit.ts:206](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/extract-commit.ts:206)、[extract-commit.ts:365](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/extract-commit.ts:365)。
- 支持触发：记忆已停用，未完成范围重试或原来源重放；请求 related 查询只取 active，停用项不进入快照，来源去重又跳过 stopped，最后直接 createMemory。
- 需求：S1-10、S2-09：停用后不能从同来源另建 active 副本。
- 证据：真实 commit 函数在 stopped 原条目、相同原来源、空 active 快照下调用 createMemory。探针的创建服务为替身，证明提交决策，不证明磁盘落库。
- 影响：旧来源绕过“忘掉”；当前已有测试覆盖的是请求先读 active、之后停用的迟到窗口，未覆盖请求开始时已停用。
- 最小修法：来源级检查独立于 active related 列表；原来源关联到 stopped/被纠正记录时不能靠换 ID 新建同一认识。新用户来源明确重申仍须保留可表达路径。
- 验证：请求前已停用、请求途中停用、同来源改写、独立新来源重申四种情况分开断言。

### F06 · P1：持久提炼作业恢复没有进入实际消费队列

- 位置：[extraction-scheduler.ts:248](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/extraction-scheduler.ts:248)、[extraction-scheduler.ts:298](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/extraction-scheduler.ts:298)。
- 支持触发：会话 A 提炼中退出/失败，重启后使用会话 B。recoverJobs 把 A 改成 pending，但 drain 只拍 pendingSessions 的内存集合；只由当前会话 turn_end/settled 加入 sessionId。
- 需求：S2-01/12：重启后继续未处理范围，而不是只恢复一个数据库状态。
- 影响：A 可永久挂起，直到再次使用 A；仅测试 recoverJobs 返回 pending 不能证明生产续作成功。
- 最小修法：在空闲调度中领取数据库 extract pending，按作业自身来源及项目身份处理，不借当前会话身份；复用 maintenance.ts:159 已有“内存+持久 pending”消费方式。保留存活 owner 不抢占。
- 验证：关闭 A 后只启动/使用 B，确认 A 未提交范围被处理，已提交游标不重算，来源与费用仍属于 A。

### F07 · P2：成功批次也累计失败重试额度

- 位置：[extraction-jobs.ts:175](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/extraction-jobs.ts:175)、[extraction-jobs.ts:221](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/extraction-jobs.ts:221)、[extraction-jobs.ts:315](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/extraction-jobs.ts:315)。
- 支持触发：同会话三轮成功提炼，第四轮一次临时错误。job 按 session 永久复用；每次 claim 加 attempt_count，done 后重开不重置，recover 只处理 count<3。
- 需求：S2-12 的有限失败重试与可续处理。
- 证据：真实作业函数在内存库完成三次成功后制造一次临时失败，结果 failed、attempt_count=4、recovered=0。
- 影响：正常长会话第一次临时故障就停摆；第三次或之后 running 状态遇进程退出也无法按该筛选恢复。
- 最小修法：重试次数按未提交批次/连续失败计算，成功推进并开启新增量时重置失败额度；历史尝试仍在账本保留。
- 验证：多轮成功后临时失败仍可重试；同一未提交批次连续失败三次停止；恢复不抹历史费用。

### F08 · P1：候选证据身份检查不能约束“用户事实”

- 位置：[extract-model.ts:279](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/extract-model.ts:279)、[extract-model.ts:299](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/extract-model.ts:299)、[tools.ts:298](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/tools.ts:298)。
- 支持触发：模型候选输出出错，这是 S2-04 明确要约束的输入。校验把 user 与 toolResult 视为同一确认集合；不要求 quotedSpan.sourceId 属于候选 sourceIds，也不要求 user_statement 的实际引文来自用户。
- 证据：真实 requestExtraction + 假模型响应的两例均 accepted=1、rejected=[]：①仅有“测试失败”工具回执，却声称用户已正式采用 PostgreSQL 并补造节约金额；②sourceIds 只列“先不定”的用户条目，quotedSpan 引用助手“正式选用”条目，仍以 confirmed/user_statement 通过。
- 需求：S2-04/05：模型推断、用户明确选择、执行结果分开；虚构理由不能转正。
- 影响：可定位的一段原文被误当成整条结论、理由和确认状态有依据。手动 pao_memory_write 还直接把 assistant 工具调用登记成 confirmed/user_statement，绕过提炼校验，不能据其作者为 model 就解释为用户已确认。
- 最小修法：引用集合闭合；按 evidenceKind 核对实际来源身份；正式 decision 必须有用户选择依据，工具失败不能证明选择。没有对应依据的理由保持未知。手动写入显式关联原用户条目或保留推断/待定，不能仅由模型调用工具就转正。语义依据判断复用这次提炼请求，避免增加第二轮逐项模型审判。
- 验证：上述两例必须拒绝或降为待定；另测真实用户选择、成功执行事实、失败执行、外部资料、助手建议和补造理由。

### F09 · P2：CLI 纠正丢条件/理由，且没有纠正原文来源

- 位置：[session.ts:1016](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/session.ts:1016)、[service.ts:523](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/service.ts:523)、[service.ts:536](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/service.ts:536)。
- 支持触发：对有条件和理由的条目执行文档公开的 `/pao memory correct 编号 新内容`。命令只提交 conclusion/evidenceKind/confirmation，source 只有 sessionId；服务用替换结构建新修订，未传条件/理由消失，无 entryId 又退回旧修订来源。
- 需求：S2-08、S1-04/09：纠正仍保留正确条件与可回读的用户来源。页面已有 archivePageOperation，不存在同样的缺来源问题。
- 影响：条件性决定变成无条件；新结论的“来源”仍指说旧话的条目，无法回读实际纠正。
- 最小修法：普通单字段 CLI 纠正保留未编辑条件/理由；复用已有用户操作归档原语保存完整命令与替换内容，关联新来源，再提交同一 correctMemory。
- 验证：带条件/理由条目经公开 CLI 命令纠正后字段完整，新来源回读含真实纠正，旧版仍读原依据。

### F10 · P2：无损压缩能力未接入正常生命周期

- 位置：[archive.ts:232](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/archive.ts:232)、[capture.ts:395](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/capture.ts:395)、`K/memory/tools.ts:626`。
- 支持触发：正常会话持续采集和退出。全内核生产源码中 sealSegment 只有定义，没有调用；archive 维护 handler 实际执行数据库备份，不封存事件段。
- 需求：S1-07 与设计 §3：原始事件无损压缩、归档后可回查。
- 影响：单会话一直追加未封存 JSONL，压缩测试能过但产品不压缩。archive.ts:129/209 每次追加前全读段数行；长会话累计采集读量随段增长。
- 最小修法：在无该段 writer 的既有空闲/会话安全边界调用封存，并创建后续新段；保留失败原段。无需新建归档框架。
- 验证：通过实际会话采集→正常安全点→重开，观察 sealed 状态与原文回读；故意压缩失败仍读原段。性能影响目前为静态复杂度判断，未宣称实测延迟。

### F11 · P2：重议修订保留旧结论，却替换掉旧结论的来源

- 位置：[extract-commit.ts:410](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/extract-commit.ts:410)、[service.ts:845](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/service.ts:845)、[service.ts:863](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/service.ts:863)。
- 支持触发：同结论新条件触发重议，调用方传 candidate.sourceIds。服务复制旧正式结论、旧条件、旧证据类别/确认状态和旧理由，只把本次来源集替换为新条件来源。
- 需求：S2-06、S1-04：旧正式选择不被模型替换；当前修订仍能回查结论与理由依据。
- 影响：当前 confirmed 内容及旧理由不再关联其原始出处；来源看起来只有本次重议事件。历史版尚能找旧来源，不等于当前版来源正确。
- 最小修法：重议修订保留当前结论的原来源并追加触发来源，用现有 flagged_rediscussion 关系区分触发依据。
- 验证：旧决定+新条件，检查当前版同时拥有原决定/理由来源及重议来源，业务确认不自动变化。

### F12 · P2：任意不同结论被写成“相反/相关”关系

- 位置：[extract-commit.ts:293](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/extract-commit.ts:293)、[extract-commit.ts:451](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/extract-commit.ts:451)。
- 支持触发：同项目已有“数据库用 SQLite”，新增“界面使用深色主题”，两条 kind 都是 decision。扫描只判断结论不相等，返回第一个不同条目，然后写 related。
- 需求：S2-06/07/13：实质冲突/变更关系有依据，不能凭不同文本建立语义关系。
- 影响：无关条目形成伪关联，真正相反结论也可能挂到无关首条，关系历史不能解释实际决定变化。
- 最小修法：移除“首个不相等即相反”的分支；只有候选显式关联且有可定位依据时建 related/supersedes。暂时没有可靠关联时各自保存即可。
- 验证：同项目无关两决定不建关系；明确同问题冲突才关联；任务边界和出处不变。

### F13 · P2：来源暂不可读被当作已处理并推进游标

- 位置：[extraction-scheduler.ts:137](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/extraction-scheduler.ts:137)、[extraction-scheduler.ts:415](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/extraction-scheduler.ts:415)、[extraction-scheduler.ts:540](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/extraction-scheduler.ts:540)。
- 支持触发：归档文件缺失/不可定位而 readMemorySource 返回 source_missing；该情况是公开契约和已有来源测试明确支持的故障。entriesFromSources 将它与已排除来源一样 skipped；全空时直接越过，部分可读时最后仍按整个 batch 的最后 sourceId 推进。
- 需求：S1-08 明确缺来源，S2-01/12 保留未提交范围与失败原因。
- 影响：来源恢复后不再自动处理，job 可标 done；不能区分“没有可提炼内容”与“证据未读成功”。
- 最小修法：区分已排除与读取失败；排除可推进，读取失败保留具体原因和未提交范围，成功前不越过失败来源。
- 验证：批次中间一个来源缺失，运行后游标不能越过；恢复原段后继续，不重复提交此前已完成候选。

## 4. 逐项需求覆盖（45 项）

“满足”表示本轮静态实现/接线与列出的证据支持该要求；历史运行证据均注明。没有把测试文件存在写成当前行为成功。一个阶段包含满足项不等于阶段整体验收通过。

### S0

| 任务 | 当前结论 | 实现与证据 |
|---|---|---|
| S0-01 | 满足；环境版本为历史实测 | S0 报告 §1 给 Node/Electron 内嵌 Node/vendor/发行解析矩阵；本轮未重新启动两宿主打印版本 |
| S0-02 | 历史探针通过；当前未复跑 | KT/fixtures/memory 存储探针；S0 §2 记 9/9，当前 store 固定 DatabaseSync |
| S0-03 | 历史宿主证据成立，当前发行物待复验 | S0 §2 Electron 探针；S4-17 current manifest 与 evidence；不以外部 Node 替代 Electron |
| S0-04 | 满足 | K/memory/store.ts:13 唯一 node:sqlite；未建双驱动框架，S0 驱动选择记录 |
| S0-05 | 历史并发验证通过；当前未复跑 | S0 §4 双进程新增/CAS/退出恢复；store.ts:544 设置 WAL、外键、busy_timeout=5000，事务 BEGIN IMMEDIATE |
| S0-06 | 本地机制有历史证据；真实语义不在本轮复核范围 | S0 §5 固定向量/FTS5；真实同义证据列在 S4；不把固定向量等同真实语义 |
| S0-07 | 满足，当前身份实现成立 | K/memory/project-identity.ts:135 区分 common-dir 与 executionRoot，非 Git 规范全路径；桌面复用内核映射；I06 为历史证据 |
| S0-08 | 满足 | K/memory/types.ts、service.ts；内容/条件/确认/证据、来源、CAS、错误与停用/删除结构化，S0 类型草案作历史规格 |
| S0-09 | 调用点清单已建，替换仍按产品切换边界保留旧路径 | KT/fixtures/memory/call-point-inventory.md；当前 K/index.ts:715,888 和 role.ts；旧适配器仍服务未切换配置，不据此判定 builtin 依赖 gbrain |
| S0-10 | 满足 | 设计与 plans/v2-REQUIREMENTS.md、v2-ARCHITECTURE.md §18 当前定案改为数据库正本；旧供应商内容置于替代说明之后 |
| S0-11 | 满足夹具要求 | KT/fixtures/memory/scenarios/I01—I10；输入与期望分离；本轮未改夹具，未重跑模型 |
| S0-12 | 满足规模/预算定义；效果不重新认定 | S0/验证规模与预算.md 定 1千/1万、双宿主、p95≤300ms、语义≤3s及真实样本；定义目标不等于当前达到目标 |

### S1

| 任务 | 当前结论 | 实现与证据 |
|---|---|---|
| S1-01 | 满足 | K/memory/paths.ts:32 显式 home；运行目录与开发源码分离 |
| S1-02 | 满足连接与事务设计，历史行为证据可复用 | store.ts:533,587 按真实模式区分连接、引用计数、短事务/回滚；S1 报告和 KT/memory-store.test.ts；本轮内存库成功载入当前 schema，不证明磁盘重开 |
| S1-03 | 基础创建/读取满足；事实可信性受 F08 限制 | service.ts:340,401 保存结构化字段与来源；confirmation 默认 tentative；手动写入自动 confirmed 问题见 F08 |
| S1-04 | 多对多及修订级来源满足；管理派生修订部分不满足 | sources.ts:170,188 及 service.ts:263；F09/F11 的新修订来源有误，不能整体判来源完整 |
| S1-05 | 正常增量采集满足，重启后的未提炼处理见 F06 | capture.ts:218,360 按公开 session 投影、条目 ID、boundary；turn_end 与 settled 补扫，不扫描启用前历史 |
| S1-06 | 已有脱敏与附件分类接线成立；完整凭证面待验证 | capture.ts:189,295 复用 context.redactContext，图片卸受管副本；原报告与 source 测试有已知测试密钥证据；本轮未重新字节扫描 |
| S1-07 | 部分满足 | archive.ts:232 封存/失败保留/重试可用，生产调用缺失见 F10；测试直接调函数不能证明自动封存 |
| S1-08 | 回读接口满足；调度消费缺陷见 F13 | archive.ts:332 / service.ts:741 支持未封存/gzip、范围、缺来源；S1 与 I09 为历史回读证据 |
| S1-09 | 修订事务满足 | service.ts:491 CAS、appendRevision、supersedes、FTS 与 scope revision 同事务；S1 双进程历史证据，I04 原始 page-correction/stale-commit |
| S1-10 | 部分满足 | service.ts:567 停用/恢复保留当前内容和历史；同来源另建副本仍可达，F05 |
| S1-11 | 基础合并满足；当前未复跑 | service.ts:629 CAS、canonical、来源并集、历史与 confirmed 不同结论拒合并；原 S1 管理操作证据 |
| S1-12 | 满足静态范围计算要求 | deletion.ts:816 计算目标/共享引用/会话/归档/附件/外部未知；显式 retain 或 include-referencing-memories |
| S1-13 | 当前已实现原 S1 遗留的会话删除链；历史情景通过 | deletion.ts:1545,1677 排除/清库与作业原子提交、文件推进、pending；session-redaction.ts 用公开会话重写及所有权；I08 sequence 原回执支持该情景，不扩展到进化副本 |
| S1-14 | 已接共享服务，读写管理语义部分满足 | memory/index.ts:493 builtin 分流、tools.ts:655 同服务注册；forget 默认 stopped；F03/F08 是写入/纠正语义缺口 |
| S1-15 | 有行为测试及历史成功证据，当前覆盖不足 | KT/memory-{store,source,deletion}.test.ts，原 S1 报告；本轮没复跑，不据旧 32 例覆盖 F05/F09/F10/F11/F13 |

### S2

| 任务 | 当前结论 | 实现与证据 |
|---|---|---|
| S2-01 | 部分满足 | extraction-jobs.ts:127 持久 job、scopeKey、cursor；scheduler.ts:298 未消费旧会话 pending，F06 |
| S2-02 | 正常事件接线满足；恢复与安全收尾仍需定向验证 | tools.ts:721 首轮装配，scheduler.ts:257/267/279 挂 turn_end/settled/start/shutdown；未用 agent_end；本轮未跑真实宿主在途关闭 |
| S2-03 | 模型路由及持久用量接线成立；许可/预算不满足 | extract-model.ts:369/399/417，runtime-embedding.ts:137 持久 job 账本；F01/F02；S4 有真实模型子链路历史记录，不代替自动调度完整效果 |
| S2-04 | 部分满足 | 范围、原文子串和 model_inference+confirmed 拒绝已实现；引文身份/理由依据不足，两例实际校验通过，F08 |
| S2-05 | 部分满足 | types 与提炼提示分 evidenceKind/confirmation；单次新条目可分别保存；F04 状态演进失败、F08 可误认用户事实 |
| S2-06 | 部分满足 | extract-commit.ts:402 同结论异条件 flag；不自动改原正式内容正确；F04 来源去重提前吞变化，F11 丢旧来源，F12 伪关联 |
| S2-07 | 部分满足 | 来源/批内归一去重存在；F04 比较字段不足；不以相似度覆盖矛盾正确，F12 的不同文本关联并不证明冲突 |
| S2-08 | 未完整满足 | session.ts:1016 交互命令和页面进入 correctMemory；普通写入工具无 correction，F03；CLI 条件/来源丢失，F09 |
| S2-09 | 部分满足 | source_exclusions、请求前快照、已变修订阻断成立；I04 extraction-stale-commit 明确 skipped；F05 请求开始前停用可重建；stale 后续作见 §8 |
| S2-10 | 静态实现满足，当前宿主行为未复跑 | store.ts:660 单调修订；tools.ts:721,743,756 在轮次/context/相关 tool_call 前检查并更新或阻断旧依据；不承担 S3 注入算法验收 |
| S2-11 | 满足“不产生执行授权” | extract-commit.ts:467 commitmentStatus=open；提炼器只拿 create/flag 服务，无派卡/执行入口；来源任务绑定条件在 scopeForCandidate:56 核对 |
| S2-12 | 部分满足 | 失败原因/usage/cursor 与 recover 有实现；F02 无额度未阻断，F06 不实际消费恢复，F07 成功累计耗尽重试，F13 读失败越过游标；真实请求超时/关闭待验证 |
| S2-13 | 部分满足 | 小批确定性去重，未引入无依据模型自动合并；F04 去重丢信息、F12 错关联；关系补链还分散在服务事务外 |
| S2-14 | 有定向测试与历史证据，尚不足完整通过 | KT/memory-extraction.test.ts、memory-correction.test.ts、memory-extraction-scheduler.test.ts；现有停用测试是 active 快照后停用；本轮命中未覆盖正常路径，不能沿用“测试存在即行为成功” |

### S4-12—15

| 任务 | 当前结论 | 实现与证据 |
|---|---|---|
| S4-12 | 经验正本替换主链满足，字段/证据问题仍受本报告约束 | knowledge/tools.ts:492,580,591 新经验仅创建数据库正文并归档候选；auto-route.ts:303,425 分正式/待定与文件资料；workflow/distill.ts:180 从数据库取经验，真实回执由 K/index.ts:713 匹配；本轮未重新跑完整入库宿主情景 |
| S4-13 | 静态装载与派发边界满足，完整角色行为待复验 | role.ts:66,96；K/index.ts:662；dispatch-brief/brief.ts:409；worker 无 memory/knowledge/resident 注册，上级接回执。未找到计划命名的 KT/memory-role.test.ts，不能据名称宣称该测试通过；已有其他装载测试不代替真实三角色闭环 |
| S4-14 | 满足切换/初始化实现；当前无请求证明未复跑 | config.ts:40,55；session.ts:1124；桌面 memory-bootstrap.ts:36 与 main 调用；memory/index.ts:522 builtin 不构造旧 manager，knowledge 闭包也不接旧 recall；KT/memory-config.test.ts 为已有覆盖；未切换配置仍走旧供应商是明确产品契约 |
| S4-15 | 主操作说明与当前架构/需求满足；自然纠正能力不足单列 F03 | README.md:127/128 链接计划和操作说明；docs/pao-operations.md:10/26/42/54 说明数据库唯一正本、角色、forget=停用、明确删除；dept/scaffold.ts:93,138 更新文件资料定位；不据此推定所有历史配方都已迁移 |

## 5. 正确部分与 Hindsight 机制核对

### 保留的实现

1. **本地单一存储路线成立。** node:sqlite 无额外进程依赖，实际读写模式分开、同模式引用计数、WAL/外键/忙等待与短事务，有明确职责。
2. **用户修订优先的基本事务成立。** correctMemory 不执行“写新再忘旧”两步，CAS 冲突带最新修订；FTS 与 scope revision 随同一事务更新。
3. **来源是业务实体。** 会话/条目身份、修订级多对多、归档窗口、明确 source_missing 都已实现，不依赖 renderer 或可变文档路径猜历史。
4. **删除为可续作的真实清理。** preview 支持共享保留/扩大范围，记录不受管对象；数据库清理前持久化计划和排除；原文及派生结构重写保留条目父链与工具配对，活动 writer 需安全停止/所有权；未完成不标 complete。这些保护有真实需求，不应为简洁删除。
5. **builtin 与旧现场有明确切换边界。** 配置备份、原子写、新会话生效和不改旧共享服务成立；保留公开旧适配接口服务切换前会话，不属于无用途兼容层。
6. **角色边界复用一个正本。** worker 只消费冻结依据，上级验收与提炼；部门查询与经验入库复用同一 service，文件资料保留原归属。

### Hindsight

核对固定提交 `0bd55015393d224deec1073d63b24bcc0faad164` 的 [consolidator.py](https://github.com/vectorize-io/hindsight/blob/0bd55015393d224deec1073d63b24bcc0faad164/hindsight-api-slim/hindsight_api/engine/consolidation/consolidator.py)。直接读取该提交源码的模块说明、来源列表、准备与提交的来源存活复核；未运行第三方引擎。

| 参考机制 | PAO 当前对应 | 判断 |
|---|---|---|
| 原事实与归纳观察分层 | sources/archives 与 memory_revisions；evidenceKind、confirmation 分字段 | 形状成立；用户事实与推断的实际约束不足，F08 |
| 归纳保留来源，变更有历史 | memory_source_links 按修订、revision_links、getMemory 历史 | 基本成立；F09/F11 的纠正/重议来源不完整 |
| 提交时重新复核来源仍存在及读后变化 | source_exclusions、related snapshot、revision/usageState 检查 | 部分落实；已有 I04 迟到响应证据，F05 说明 stopped 在快照之外仍可恢复旧认识 |
| 来源数量不等同用户正式决定 | confirmed 与 evidenceKind 分开 | 设计成立；F04/F08 阻碍真实行为兑现 |

PAO 无需复制 Hindsight 的 PostgreSQL、独立服务或完整图结构。当前所需修法集中在既有候选、来源与修订契约。搜索融合和 S7 归纳整理的深入结论交对应审核范围。

## 6. 本轮离线验证与证据强度

两个探针均通过 PowerShell stdin 执行 `node --experimental-strip-types --input-type=module`，无临时脚本，无网络，无 PAO_HOME 读写。第一组从当前 store.ts 读取 schema，在 `DatabaseSync(':memory:')` 中执行；直接导入当前 extract-commit.ts 与 extraction-jobs.ts。第二组直接导入当前 extract-model.ts，使用内存 ledger 与假 registry，档位显式注入，未加载现场档位/凭证。

原始输入与工具返回的文本输出从本会话工具历史保存，未重新运行：

- 第一组：[原脚本](evidence/storage-probe-commit-jobs.mjs)、[原输出](evidence/storage-probe-commit-jobs.json)。
- 第二组：[原脚本](evidence/storage-probe-candidate-evidence.mjs)、[原输出](evidence/storage-probe-candidate-evidence.json)。

`.mjs` 保存当时传入 stdin 的脚本文本；原工作目录为 `D:/AI/workspace/pao-dev`，相对导入按该目录解析，不是直接以 evidence 目录作为模块根运行。`.json` 仅用 `stdout` 字符串封装当时工具返回的输出文本，保留 JSONL 行；没有补造运行时间、退出码或完整执行回执。脚本中的固定业务时间是实际输入夹具值。

运行目的及失败后动作：第一组检测去重吞确认、停用重放新建、正常成功耗尽重试；若命中则分别认定提交决策/重试语义缺陷。第二组检测错误来源被认成用户明确选择；若通过则认定候选边界校验不足，保留真实模型发生率为未知。

| 定向情景 | 实际观测 | 可支持的结论 |
|---|---|---|
| tentative 原条目 + 新用户 confirmed 同结论 | outcome=duplicate；current.confirmation=tentative；create 调用 0 | F04，实际提交分支与数据库内容未升级 |
| stopped 原条目 + 原 source + active related 为空 | outcome=submitted；createMemory 调用 1 | F05，真实提交函数允许新建；创建服务为替身，不声称磁盘落库 |
| 同会话三批成功后第四批临时失败 | status=failed；attempt_count=4；recovered=0 | F07，真实作业函数错误消耗重试额度 |
| toolResult“测试失败”支持 confirmed/user_statement 决定及无依据理由 | accepted=1，rejected=[] | F08，假模型候选可穿过真实校验 |
| 用户 sourceIds + 助手 quotedSpan，用户原文是“先不定” | accepted=1，rejected=[] | F08，引用集合和用户身份未闭合 |

这些是确定性机制验证，不是模型质量、Electron UI 或持续使用效果验证。其他问题为当前源码与真实调用链静态确认，未伪称全部复现。

## 7. 原验收证据的复核

- [S0 报告](../内置记忆与受控自进化-2026-11-08/S0/S0-验收报告.md)记录两宿主 SQLite 探针、并发 CAS 和固定向量；能支持当时环境能力，不证明当前宿主/发行物重新运行成功。
- [S1 报告](../内置记忆与受控自进化-2026-11-08/S1/S1-验收报告.md)有 capture→create→关闭重开→原文回读历史证据；其明确遗留真实会话删除。当前源码已补该链，不能仍据旧报告认定删除完全未实现。
- [S2 报告](../内置记忆与受控自进化-2026-11-08/S2/S2-验收报告.md)主要是数据面、假模型和测试证据；不能单凭它认定完整自动采集→真实模型→用户纠正闭环成功。当前持久账本与 stale snapshot 比原报告已有变化，应以当前实现核对。
- [I04 page-correction](../内置记忆与受控自进化-2026-11-08/S4/real-validation/runs/real-I04-20261110/page-correction.json)记录实际页面操作来源、r1→r2；[stale-commit](../内置记忆与受控自进化-2026-11-08/S4/real-validation/runs/real-I04-20261110/extraction-stale-commit.json)记录 stale_request_snapshot、submitted=0。它证明该条旧来源迟到提交被拦，不能推广到请求开始前已停用或自然语言纠正。
- I04 superseded/main-review.json 的 `coreEvidence` 指向 `../real-I04-20261110/basic-scenario.json`，当前该文件不存在；同目录真实 page-correction/stale-commit 等仍在。应修复证据索引指向现存原件，不抹去已有原始证据，也不据失效链接认定整案无证据。
- [I08 sequence 原始记录](../内置记忆与受控自进化-2026-11-08/S4/real-validation/runs/real-I08-20261110-sequence/basic-scenario.json)显式标出 fixture 输入、synthetic assistant 元数据、actual_sdk_response 用量；[主审](../内置记忆与受控自进化-2026-11-08/S4/real-validation/runs/real-I08-20261110-sequence/main-review.json)列删除完成、受管扫描与原候选排除。可确认夹具来源上的真实模型及管理子链路历史证据，不能表述成自然用户长期对话或完整自动 scheduler 证明。
- [S4-17 current manifest](../内置记忆与受控自进化-2026-11-08/S5/packaged-validation/S4-17-current-passed.json)指向打包桌面/CLI 跨宿主 evidence、数据库和页面截图；属于当时发行物历史证明。当前 S9 未提交装配改动没有本轮再发行验证。
- 原 S4 报告供应商结算金额为 unknown，本报告沿用，不把 SDK 默认零成本视为免费。

## 8. 结构优化与未核实范围

### 结构优化

| 建议 | 位置与收益 | 保持的行为与验证 |
|---|---|---|
| 收拢候选提交事务职责 | extract-commit.ts 自行查询/补 memory_source_links/revision_links，create/flag 又进 service；同一修订规则散在两处。把候选去重后的补链/变更提交收回现有服务事务，减少状态判断重复 | 保留逐候选独立结果、CAS、来源排除、scope 通知；验证同源重放和状态变化。无需新增通用 Repository/UnitOfWork 框架 |
| 将来源回读按段复用 | scheduler.ts:137 逐来源调用 readMemorySource；archive.ts:286/355 每次解压/解析整段。同一批 n 个来源可能重复读同一段 n 次，追加计数还全读段 | 在单批内按 segment 读一次后准确切事件；分页、缺来源、解压失败语义保持。以实际长段测读次数/字节再决定是否进一步索引，不增加长期缓存 |
| 去掉附件无决策价值的内容摘要 | capture.ts:169 对每张图算 SHA256，但 attachmentId 还含 entryId/index；不能跨条目去重，同条目已有 isCaptured。摘要没有替代实质更贵操作 | 使用已有稳定条目/块身份定位即可，保留重复采集幂等、附件共享删除与受管路径；先核对所有引用后小范围替换。与用户范围规则一致，不增新指纹文件 |

### 未核实与已知限制

1. **stale 快照失败后的可续处理不完整。** scheduler.ts:527 写 markJobNeedsReevaluation；extraction-jobs.ts:318 明确排除该前缀，runSessionJob:365 对 failed 只跑嵌入，同 session scopeKey 永久复用。静态上会连后续新增量也一起堵住；本轮未追完全部公开管理接口是否提供人工重评入口。应由整合者核实该入口；若没有，增加对既有 job 的明确重新评估/新范围续作，不自动重放旧模型结果。该项不能按 S2-12 已完整续作处理。
2. **真实宿主在途取消与关闭。** 已确认 start/shutdown 有 AbortSignal，但未本轮验证“关闭不等待长请求”、关闭后迟到 usage、同一进程切会话恢复等全部行为；未因有 abort 就判完整成功。模型请求未见提炼层 deadline，端点长期无响应的实际表现待定向验证。
3. **S9 接入边界。** store/paths 与桌面桥已有进化表和入口；未审核 evolution_source_links、候选/验证文件中的正文清理是否真正由记忆删除消费。这属于 S8-11/S9 补审，不能把本轮 S1 删除结论扩大为所有进化副本已清。
4. **真实长期收益。** 本轮未付费、未全量构建、未运行完整 Electron 或正式 PAO_HOME。跨月减少纠错、自动后台全过程和长期成本收益仍需真实对照；已有冻结输入及单次历史回执只支持各自范围。
5. **来源/删除覆盖。** 本轮深读受管删除核心与历史 I08；没有重新扫描所有历史数据库、备份、附件和会话，也未对所有错误恢复分支做故障注入。明确共享保留的来源仍保留属于用户选定范围，不作为删除残留缺陷。
6. **S3 搜索与 resident。** 不给检索融合、召回完整性、常驻正文、语义质量或其性能结论；S0-06 只登记既有机制证据。S4-12 的并联文件资料和数据库分类已追踪，未据此认证搜索排序。

整合建议：先处理 F01/F02 的实际请求边界、F03—F05/F08 的事实与纠正语义、F06/F07/F13 的恢复，再补 CLI 来源和自动封存。复用现有服务、队列、操作归档与账本，按同一组定向情景验证，不另造评测宿主。

