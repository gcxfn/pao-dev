# S8 与 S9 接入边界审核

核实日期：2026-11-12。范围：S8-01—13 全部，S9 当前实现的发布、任务绑定、加载、观察和恢复接入边界。

本报告记录源码初审批次。公开入口运行深审见[深度审核 D3—D5](深度审核.md)：选择后冻结失败、空验收可发布并生效、同输入双侧执行未自动装配候选资源；修复状态仍以优化任务为准。

## 结论

**S8 已有分模块实现和模拟机制证据，但真实问题→生成→实际执行→独立验证尚未在产品中装配完整，不能按原完成判据认定全部完成。** 核心断点为：

- 实际摩擦事件只登记 Problem；分类、选择、冻结、生成、验证没有产品侧调用者，主动声明也没有注册成模型工具。
- command runner 不读取或挂载 baseline/candidate 资源。现有 E2E 由测试主动把两版 SKILL.md 放进不同的 initialFiles，再检查文本片段；这证明文件内容检查和模块组合，不能证明技能实际生效。
- agent runner 没有产品工厂；即使注入工厂，会话返回就记 passed，没有执行 acceptance 判定。评估器还接受空结果、漏交正常/保留组，并将带退出码的环境启动失败当成有效旧版失败。
- S9 已有发布、绑定、回退和页面实现；发布入口没有接 S8 边界审计，宿主只读取既有绑定，没有创建新任务初始绑定的产品调用。**新 S9 报告、主计划及 README 已声明 S9-01—14 全部完成，但新增证据仍为直接种子、内核函数调用和发行物页面展示，不能支持真实改进及完整产品闭环完成。**

## 基线、依据与阅读深度

Git HEAD：开发根 `1ccec6e4c894b6e5b5edb91adef139263c12deab`；PAO `1a6683ceeb968378a6dae910516c1da021ca75ff`；desktop `c9fc3f34d2618872ab5343d394de271baf9e840d`。结论以工作区文件为准：evolution 目录及测试尚未跟踪，main、resource-loader、memory/store、friction/drafts 和桌面桥、页面、driver 均有他人未提交改动，不能用 HEAD 代表本次全部实现。本报告纳入 2026-11-12 的 S9-验收报告.md、S9/s9-acceptance.mjs 及更新后的总计划 §10、README:127；S9 完成声明按当前源码与实际证据审核。

已读根及 PAO、desktop、plans、driver、desktop app、desktop tests 的 AGENTS.md，以及 code-simplicity 技能和引用的审查维度。没有可用代码图工具，调用关系通过源码搜索核对。

需求依据：

- [设计 §7](../../plans/未完成/2026-11-08-内置记忆与受控自进化设计.md)：真实问题、允许资源、实际效果、空闲维护、验证后启用及退步回退。
- [总计划 §3.6、§5 S8/S9、§10](../../plans/未完成/2026-11-08-内置记忆与受控自进化实施计划.md)：有限候选、保留组失败停止、逐项完成判据与原状态。
- [S8/S9 详细路径](../../plans/未完成/2026-11-08-受控自进化实施路径-S8-S9.md)：装配、资源副本、三组冻结样例、预算取消、来源失效、发布加载契约。
- [本次审核计划](../../plans/未完成/2026-11-12-持久记忆与自进化审核优化计划.md)及[方案调查 §7](../../plans/未完成/2026-11-08-记忆与自进化方案调查.md)。

深入阅读：S8 的 types、policy、resources、problems、select、validation、candidates、runner、evaluate、boundary；friction 实际登记路径；S8 E2E；原验收报告与 D2 任务书。来源清理、S9 activation、versions、binding、host-mount 的相关实现及宿主调用已定向阅读。桌面问题详情、验证展示、来源跳转、资源控制、DTO/桥/driver 按实际链路阅读；其测试按关键场景抽样。S9 regression、control、recovery 沿接入和发布判据抽样，不作全部 S9 正确性结论；记忆内部提炼、检索、删除实现不属本次负责范围，只核对进化接入。

## S8 原任务逐项覆盖

表中“已有测试”只表示读到相应断言，非本轮复跑成功；实际运行证据单列在后文。

| 原编号 | 结论 | 实现、调用与证据 |
|---|---|---|
| S8-01 | 部分满足 | types.ts、policy.ts 有资源类别、禁止对象、操作与能力描述，policy 测试覆盖局部判断；实际生成未传 action/policyRefs，发布未消费 boundary 判定，费用边界见 E08/E09。不能将常量清单视为执行边界已接通。 |
| S8-02 | 部分满足 | resources.ts 有显式登记、查询、单项开关、首版快照，普通用户文件没有自动扫描登记；template/recipe 的文件型资源与目录型快照冲突，见 E12。停用不阻止生成，见 E10。 |
| S8-03 | 部分满足 | friction/drafts.ts:207 是真实调用；declareImprovementIntent 可登记并复用问题。实际调用未带项目/任务/会话身份，来源仅为字符串定位；无主动声明工具注册，见 E01/E02。 |
| S8-04 | 部分满足 | classifyProblem 查询 memory_usage，但没有产品调用者；任何未 used 的同会话记忆都能改变归因，未建立与失败的相关性。重复来源还会虚增次数，见 E02/E03。 |
| S8-05 | 部分满足 | selectImprovement 有 no_change/core_issue 分支；已有资源一律 modify，delete/merge/no_change 输入选择被覆盖；选择后状态阻止下一步冻结，见 E04。核心建议未定位实际文件/函数。 |
| S8-06 | 部分满足 | validation.ts 冻结 plan.json，三组分开、reproduction 至少一条，目录不在 candidates 下；没有产品侧旧版先跑和冻结编排，normal/holdout 可为空；E04/E06 阻止按要求完成。 |
| S8-07 | 部分满足 | candidates.ts 有模型路由、副本、合法路径编辑、相同差异判断与三个候选行上限；提示词不含基础正文和真实问题正文，有限循环/保留组停止未接，见 E05/E10。原 fakeRegistry 不能证明真实生成质量。 |
| S8-08 | 部分满足 | runner.ts 为每侧建独立 home/work/session/agent，命令调用 runCardProcess，传 timeout/signal 并保存回执；command 不消费版本资源，agent 工厂未装配且未接模型预算，见 E01/E07/E09。 |
| S8-09 | 未满足实际执行判据 | boundary.ts 的工具交集、受管输入检查、范围审计和能力缺口判断都有局部实现；全源码调用搜索未见产品消费。尤其 extension 不可自动发布的判定未接发布入口，见 E08。 |
| S8-10 | 未满足完成判据 | evaluate.ts 对已提交结果逐项裁决，不用总分抵消失败，这部分正确；冻结计划完整性、acceptance、环境失败语义均有缺口，见 E06/E07。没有实际技能执行证据。 |
| S8-11 | 部分满足 | evaluate 能写 failed/cancelled，observe 有清理、过期辅助函数；生成预算拒绝返回 rejected。删除/过期辅助函数没有产品调用，候选不继承问题来源，保留组失败和停用不阻止下一次生成，预算重用漏计，见 E09—E11。 |
| S8-12 | 部分满足 | 问题列表→详情→候选→验证 DTO/IPC/preload/driver/renderer 已接；原报告记录真实 Electron 1 passed，属于种子数据 UI 证据。实际摩擦问题不进入项目列表、来源无法回读；页面仅展示新正文而非真实差异，费用/回执依据不足，见 E02/E13。 |
| S8-13 | 待真实验证，未达到原判据 | 原 S8 报告明确 fakeRegistry 模拟；D2 任务书和 evolution-e2e.test.ts 都是预设补丁、合成来源、文本包含检查，且跳过 selectImprovement。未找到替代它的真实重复问题、真实生成及实际技能执行闭环。后续 S9 夹具未补足该证据。 |

建议原 S8 状态改为“机制实现及模拟验收已交付；实际装配、必要缺陷修复和 S8-13 真实闭环未完成”。本轮不回写状态正本。

## 已确认问题

### E01 · P1：真实问题止于登记，生成和验证没有产品装配

位置：[drafts.ts:207](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/friction/drafts.ts:207)、[candidates.ts:327](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/candidates.ts:327)、[runner.ts:367](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/runner.ts:367)。

受支持触发：任务产生摩擦失败，或模型应申报有依据的改进意图。实际源码中 declareImprovementIntent 只有摩擦入口调用；collectEvolutionProblem、classifyProblem、selectImprovement、freezeValidationPlan、proposeCandidate、runValidationCase、evaluateCandidate 没有外部生产调用。agentSessionFactory 只有注入接口，没有实现/装配；模型工具注册没有主动声明入口。S7 maintenance 也没有消费这些进化函数。

需求与影响：S8-03—10 要求真实事实进入候选与隔离验证，当前只有可手动组合的函数，日常运行不能形成该链路。S9 版本模块不能补上前半段。

最小修法：在共享业务入口中串起单次进化作业，接现有空闲/取消/预算调度；注册只登记意图的窄工具，宿主补身份。优先只完成文本技能，不另建队列、评测宿主或费用系统。

验证：从现有真实失败入口启动，观察同一 problemId 经选择、冻结、真实模型生成到实际候选执行；普通任务开始时停止后台模型工作。直接数据库种子不作为该接线的证据。

### E02 · P1：真实问题缺身份与可回读证据，重复申报还虚增发生次数

位置：[drafts.ts:206](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/friction/drafts.ts:206)、[problems.ts:194](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/problems.ts:194)、[problems.ts:234](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/problems.ts:234)、[desktop/memory.ts:2566](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/desktop/memory.ts:2566)、[memory-page.tsx:586](/D:/AI/workspace/pao-dev/desktop/apps/desktop/src/features/memory/memory-page.tsx:586)。

触发与证据：实际摩擦调用不传 projectId/taskId/sessionId/entryId/toolCallId；问题 project_id 为 NULL，而项目列表使用 `p.project_id = ?`，所以真实摩擦问题不可见。来源 `friction:场景:卡号:目录` 没有单次事件身份，非 src- 引用不解析有效性；insertProblemSourceLink 不写 memoryId/revision，页面无这两者就提示不能回读。相同来源重报复用 problemId 后仍加 occurrence_count；纯内存执行相同输入两次，次数变成 2。

需求与影响：S8-03/04/12 要求当前宿主身份、独立事实计数、原任务和来源可回读。当前真实失败难以发现，重放被误认重复，后续“真实重复问题”依据不可靠。

最小修法：从事件调用者传递已有身份和唯一回执引用，登记时解析来源；同一事件重报幂等，发生次数按不同真实事件计算。详情按 sourceId/回执定位读取，不能要求失败必须先成为记忆修订。

验证：同一事件重放次数不增，第二个独立事件才增加；实际摩擦问题出现在对应项目，点击来源读到该次回执及任务。

### E03 · P2：无关未采用记忆会覆盖失败归因

位置：[problems.ts:437](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/problems.ts:437)、[problems.ts:492](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/problems.ts:492)。

触发：同一会话有某条 search/inject/expand 记录但无 used，随后登记另一资源的实现故障或核心问题。detectUnusedExperience 只按 task/session 查询全部使用记录，返回第一条未 used 的记忆；classifyProblem 无条件优先改成 unused_experience，甚至早于 core_issue 分支。

需求与影响：S8-04 要求核对“相关正确经验”及原参数、错误、资源版本；当前没有相关性、正确修订、失败时段或证据关系判断，会把真实实现问题引向检索策略，核心问题也可能失去原归因。

最小修法：只对问题明确关联的记忆修订和当次执行证据判定未采用；没有依据时保留待分析/原分类，不凭同会话存在未使用记录直接归因。核心禁止对象判断先于可改资源选择。

验证：无关记忆被注入但未引用时，已确认工具实现缺陷和核心问题保持分类；相关正确经验未采用的对照项才改变目标。

### E04 · P1：选择动作后无法冻结，动作选择也被覆盖

位置：[select.ts:186](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/select.ts:186)、[select.ts:201](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/select.ts:201)、[validation.ts:145](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/validation.ts:145)。

触发：按详细路径执行 classify→select→freeze。select 将可改问题推进 candidate，freeze 仅接受 classified，直接拒绝。纯内存运行已确认 select 后状态为 candidate。现有 S8 E2E 主链直接 classify→freeze，跳过了 select。

另一个同入口缺口：invocation/implementation_defect 只要有 resourceId，选择就固定 modify；传入 delete/merge/no_change 也不保留。buildDevelopmentSuggestion 只返回摘要及泛化禁止对象，没有具体相关文件/函数。

需求与影响：S8-05/06 的规定顺序不能执行，非修改动作未兑现，范围外问题也没有可落地开发建议。

最小修法：选择可改目标时保持 classified，实际生成候选后再置 candidate；保留有证据的动作选择及合法终态，核心建议附实际定位。不要通过跳过选择步骤掩盖状态冲突。

验证：按规定完整顺序跑通；modify/delete/merge/no_change/开发建议各检查最终动作及是否发起模型生成。

### E05 · P1：模型看不到基础资源，无法作有依据的局部修改

位置：[candidates.ts:435](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/candidates.ts:435)、[candidates.ts:448](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/candidates.ts:448)。

触发：正常调用 proposeCandidate，模型须输出被编辑文件的完整新正文。副本虽已复制到磁盘，模型请求只含允许文件名、问题 ID/资源 ID/版本 ID、devCases，以及固定请求文本；没有原文件正文，也没读取 problems 中的 summary/reason/expected/actual。streamSimple 没有文件读取工具。

需求与影响：S8-07 要求在资源副本上基于真实诊断生成局部差异。当前模型只能猜全文，容易丢失正常步骤；fakeRegistry 预设完整修复掩盖了这个缺口。

最小修法：从确切 baseVersion 读取允许文件正文，将真实问题及开发反馈纳入请求；保留组内容仍不提供。现有正文比较足够，无须新增指纹。

验证：使用含独有正常步骤的基础技能，截获请求确认模型可见该正文；真实生成保留正常行为并修复问题，换不同基础正文时不能仍使用固定预设补丁作证。

### E06 · P1：空验收、漏交样例可以得到 passed

位置：[validation.ts:164](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/validation.ts:164)、[evaluate.ts:197](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/evaluate.ts:197)、[evaluate.ts:236](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/evaluate.ts:236)。

触发与实测：evaluate 只对传入结果 map/some，不读取冻结计划核对完整集合；`caseResults: []` 得到 passed，候选也写 passed。只交 reproduction-0、没有 normal/holdout，同样 passed。freeze 只要求 reproduction 非空，本身允许其余两组为空。

需求与影响：S8-06/10 要求原问题、关键正常用法和独立保留样例都有实际结果。漏跑、未装配或组装遗漏会被误认证，S9 最新 validation=passed 的门槛继续接受它。

最小修法：评估读取冻结计划，结果按 caseId 一一对应、每侧回执和版本对应；缺项标 incomplete，不接受空集成功。首个文本技能闭环冻结三组实际样例，最终保留组在候选定稿后执行。

验证：空集、漏一条保留项、重复/未知 caseId、缺一侧回执均不可 passed；完整真实对照才允许通过。

### E07 · P1：runner 未实际装配候选技能，完成会话又被当作行为通过

位置：[runner.ts:292](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/runner.ts:292)、[runner.ts:377](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/runner.ts:377)、[runner.ts:409](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/runner.ts:409)、[evaluate.ts:127](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/evaluate.ts:127)。

触发与证据：

- command 分支只将 initialFiles 写 workDir，执行 verifier.cmd/args；resourceId/baseVersion/candidateId 是回执标签，resourceCopyDir 没有被 command 分支读取或传给验证器。按冻结用例同一 initialFiles 执行，两侧不会因为传入不同候选 ID 而变化。
- agent 分支仅把 resourceCopyDir/loadMethod 传给外部工厂，没有生产实现验证 additionalSkillPaths、工具集或版本实际加载。现有工厂测试返回固定 assistant output，只检查隔离目录和 requestId。
- AgentSessionRunOutcome 只有 output/requestId/usageRef/abortReason 等，没有通过判定。返回后直接 passed=true，evaluate 对 candidate.passed=true 不再核对 acceptance 或输出。工厂返回 abortReason 也未被消费。
- command 的 failureKind=start/timeout 被放入 failureReason，但仍带 output、exitCode；evaluate 的环境判断只认“无 output 且无 exitCode”。纯内存输入旧版 start/127、候选 code=0，评估得到 passed，即把启动故障当作成功修复。

需求与影响：S8-08/10、审核计划 §6.2 明确要求通过产品资源加载产生真实行为差异，环境故障不能充当旧版业务失败。当前文本检查成功不能支持技能有效性；会话结束也不能支持行为通过。

最小修法：实现共享的隔离 agent 工厂，显式加载固定资源并核对实际采用；command 类将冻结验证器绑定到明确版本副本，冻结 initialFiles 不由调用方逐侧替换资源来制造区别。运行完成与判据通过分开；消费结构化执行失败、取消原因，依据冻结 acceptance 生成业务结果。

验证：技能正文决定输出的任务，基线加载旧版、候选加载新版，其余输入相同；未加载资源、返回错误答案、返回 abortReason、进程启动失败和超时都不能通过。检查实际加载路径和回执，不只检查提示词或文件是否含词。

### E08 · P1：S8 边界审计没有进入验证和发布门

位置：[boundary.ts:52](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/boundary.ts:52)、[boundary.ts:199](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/boundary.ts:199)、[boundary.ts:299](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/boundary.ts:299)、[versions.ts:189](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/versions.ts:189)、[activation.ts:339](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/activation.ts:339)。

触发：通过公开 publishCandidate/activateCandidate 发布已有 passed 候选。源码搜索显示工具交集、auditCandidateForPublish、auditResourceCapabilityCoverage 只有定义，无产品调用。publish 检查状态、最新 verdict 和非空目录后复制；activate 检查版本目录、有效指向、开关、原目录及来源，没有补接该审计。extension/command 的不可自动发布缺口因此只存在于报告函数中。生成的范围判断也没有传 action/policyRefs。

验证文件与发布内容还没有实质绑定：publish 读取候选目录当时的文件并重新产生版本 ID，不将这些正文与已验证的 base+diffs/运行资源核对；校验新版本自洽不能证明它就是通过验收的内容。runner 只遍历 workDir，无法以其 fileChanges 证明 scratch 之外从未改变。

需求与影响：S8-09、S9-01/02 要求受管验收完整、能力缺口阻止发布、保存已验证文件。当前仅靠 passed 状态不能成立这些保证。这是现有自动发布契约缺失，不需要扩建操作系统沙箱。

最小修法：在共享发布入口消费范围、能力覆盖和受管输入检查；先只放行已具备实际验证入口的文本技能。用现有基础正文与实际差异核对发布文件，固定通过验收的副本，不新增校验和文件。工具交集在工厂激活工具时执行。

验证：未覆盖的 extension、改变验收条件、验证后改变候选正文、缺受管输入记录都应拒绝发布；合法文本技能通过后发布的文件逐项等于实际验过的副本。

### E09 · P1：同问题多次生成复用结算键，费用覆盖且不重新预留

位置：[candidates.ts:374](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/candidates.ts:374)、[candidates.ts:640](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/candidates.ts:640)、[budget-ledger.ts:285](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/usage/budget-ledger.ts:285)、[budget-ledger.ts:354](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/usage/budget-ledger.ts:354)。

触发：按支持的最多三个候选，为同一 problem 第二次调用 proposeCandidate，使用默认预算身份。jobId 固定 evo-problemId、kind=candidate、scope 固定 resource:baseVersion；reserveBudget 遇同键直接复用已有记录，包括 settled/unknown，发生在剩余额度判断之前；第二次 settleBudget 用本次费用覆盖已结算费用，未累加。

需求与影响：S8-07/11 要求完整归因且重试不刷新额度。当前每次确实新发模型请求，却当成同一请求的重入，预算账漏计前次费用，后续候选可能越过剩余额度。session appendUsage 逐次记录不能修复预算门的账。

验证 runner 本身也没有模型预算门；agent 工厂依赖未包括预留/结算装配。隔离目录不等于预算隔离。

最小修法：每个实际模型尝试有稳定独立 attempt/request 身份，恢复同次才复用；不同尝试分别预留、结算，仍归同一 problem 的共享总预算。实际隔离会话复用相同预算与账本入口。

验证：第一候选花费后第二候选独立占额，三次费用合计；余额不足不发第二次请求，unknown 不可重入再次付费，失败及取消后的已发生费用保留。本轮为静态确认，未写预算账实测。

### E10 · P2：保留组失败、资源停用没有阻止下一次生成

位置：[candidates.ts:344](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/candidates.ts:344)、[candidates.ts:359](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/candidates.ts:359)、[control.ts:55](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/control.ts:55)、[runner.ts:377](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/runner.ts:377)。

触发：保留组失败后问题仍是 candidate，再调用生成；或用户已停用自动进化后调用生成。propose 只检查问题状态、资源存在及候选行数，没有检查失败组/本轮终止，也不读 autoEvolutionEnabled。control 注释明确承认只在生效时拦截。三个候选行上限正确，但 no_change、duplicate、解析失败等已付费尝试不形成候选行，不能代替尝试终止条件。

取消/超时方面，命令分支传了 timeout/signal；agent 工厂只收到 signal，没有 timeoutMs，runner 没有对会话耗时或模型预算收口。当前没有编排器提供其他保证。

需求与影响：S8-07/11、S9-10 要求保留组失败结束本轮、停用停止新领取、普通任务优先。发布时拒绝不能挽回已经发出的后台请求。

最小修法：在共享作业领取/每次生成前判断单资源开关和本轮终止；保留组失败不回灌生成器，直接结束。沿现有作业记录限制尝试并保存取消/额度状态；agent 会话接统一超时与取消，不另建停止系统。

验证：保留组失败、停用资源、已取消作业均不再发模型请求；正常开发组失败可在限制内生成不同候选。超时或前台任务开始后会话确认停止并记录未完成。

### E11 · P1：来源失效未贯通候选与发布

位置：[observe.ts:94](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/observe.ts:94)、[candidates.ts:610](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/candidates.ts:610)、[activation.ts:267](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/activation.ts:267)。

触发：真实来源删除/纠正，或基础资源变化。cleanupSourceReferences/markStaleCandidates 只有定义，没有产品调用；propose 只写候选和问题状态，不继承 Problem 的来源关联。freeze/evaluate 的 sourceRefs 又是可选。activate 的来源检查只枚举候选/计划/验证已有 links，不读取 Problem 链；没有 links 就通过，有 source_id 也只在 memory_id 非空时核对记忆行存在，不核对 sources/排除记录/当前修订。

即便单调清理函数，它也只是缩减 evidenceRefs、取消直接关联未通过候选，未清 Problem summary/reason/expected/actual、候选 rationale/diffs 或 plan.json 中来自被删来源的正文。

需求与影响：S8-11、S9-02 要求删除后不恢复旧依据，必要来源失效待重评估；当前来源删除可能不影响生成/发布，受管进化产物仍保留目标正文。这里仅报告进化接入，不评价记忆删除模块自身。

最小修法：候选继承已解析的问题来源；现有删除操作接进化清理，沿 problem→candidate→plan/validation 清受管正文并保留必要排除定位。发布核对必要来源与修订，空关联不能代替有效依据。

验证：正常登记→生成后，从实际删除入口删除唯一必要来源，再生成/评估/发布都不能恢复旧依据；共享来源保留未删除范围，目标正文不残留在受管计划和详情。

### E12 · P2：已授权文件型资源无法快照

位置：[policy.ts:109](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/policy.ts:109)、[policy.ts:137](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/policy.ts:137)、[resources.ts:231](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/resources.ts:231)、[resources.ts:319](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/resources.ts:319)。

触发：按类别表登记存在的 `工作流/<name>.md` 模板或 `部门/<name>/配方.md`。snapshotResourceFiles 对 relativeRoot 一律作目录遍历，readdirSync 遇文件抛 ENOTDIR。不是假设输入，是本项目明确登记的资源形态。

需求与影响：S8-02 要求登记当前可恢复版本；这两类在建立 baseVersion 阶段就中断。host-mount 明确 skipped 是 S9 加载范围限制，不能解释 S8 快照失败。

最小修法：快照入口按既有文件/目录形态处理，文件型在版本目录保存原文件名；差异路径和装载保持一致。没有必要新增通用资源适配框架。

验证：真实模板、配方分别登记→快照→读取准确文件→局部候选；目录技能回归保持路径。

### E13 · P2：详情有页面链，但尚不足以审查真实候选证据

位置：[evolution-detail.tsx:330](/D:/AI/workspace/pao-dev/desktop/apps/desktop/src/features/memory/evolution-detail.tsx:330)、[evolution-detail.tsx:263](/D:/AI/workspace/pao-dev/desktop/apps/desktop/src/features/memory/evolution-detail.tsx:263)、[memory-page.tsx:586](/D:/AI/workspace/pao-dev/desktop/apps/desktop/src/features/memory/memory-page.tsx:586)。

触发：查看当前正常候选详情。改动区只展开 newContent，不显示 baseVersion 正文对照或 diff.diff，删除项更无改前正文。验证区列组、verdict、输出摘要/退出码，没有对应 acceptance、回执定位和费用引用；DTO 虽含 usageRefs/totalUsageRef，页面未消费。实际来源回读受 E02 限制。

需求与影响：S8-12 详细路径要求实际差异、旧版/候选结果、失败原因、回执及费用和来源可读，用户目前无法仅凭页面判断改了什么及证据是否充分。原 Electron 种子用例证实渲染，不证明上述真实链路。

最小修法：复用现有文本差异组件读取确切 baseVersion；验证项展示冻结判据、回执和费用链接，失败/未完成保留具体理由；修来源导航。

验证：真实登记的问题中，修改和删除均能对照旧版；失败、环境未完成分开显示并回查回执；费用未知明确未知。真实 Electron 定向验证，不以 DTO 字段存在代替显示成功。

## S9 完成声明与已实现接入边界

### 已确认的接入缺口

**E14 · P1：新会话没有建立初始版本绑定。** [main.ts:589](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/main.ts:589)和[session-supervisor.ts:535](/D:/AI/workspace/pao-dev/desktop/packages/pi-sdk-driver/src/session-supervisor.ts:535)只读已有 bindings；[host-mount.ts:105](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/host-mount.ts:105)从 listTaskBindings 开始，无绑定则空列表。全生产源码没有 bindTaskResources 的调用者。因此正常新任务即使已有 effectiveVersion，也不会自动加载它，继续发现原资源根。最小修法是在共享任务创建入口为实际使用的受控资源建立绑定，再构造 loader；恢复复用旧绑定。验证必须从 CLI/桌面创建新会话读取数据库绑定并证明新版实际执行，不能先手工插绑定。对应 S9-04 已声称完成，但实际装配未满足判据。

**E15 · P2：第二轮正常进化会被误判为人工改动。** [activation.ts:422](/D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/activation.ts:422)固定比较原资源目录指纹与候选 baseVersion；第一次发布只写版本目录和有效指向，不覆盖原目录。发布 v1 后，再基于有效 v1 生成 v2，原目录仍 v0，于是合法 v2 激活必然冲突。最小修法是分清“当前有效版本基线”和“原目录人工修改基线”，沿已有版本历史核对原目录是否被改，不要求原目录等于每次新 effectiveVersion；不要为解决它逐文件覆盖正式资源根。验证连续两轮改进成功，期间真实手工改原资源则仍阻止覆盖。对应 S9-02，静态确认，尚未运行发布实测。

安全点补审入口：[session-supervisor.ts:2102](/D:/AI/workspace/pao-dev/desktop/packages/pi-sdk-driver/src/session-supervisor.ts:2102)先写绑定、updateAdditionalPaths，末尾才调用 reloadSessionWhenIdle；busy 时会返回 deferred，数据库已显示新绑定而当前 runtime 仍旧版。实际调用者尚未接上，属于 S9-05 的接口与验收缺口：应等真实安全点后同步提交实际加载与绑定，重载失败也不能显示已换版。没有据此宣称日常会话已发生版本漂移。

### 最新可见证据的含义

已读 [S9-验收报告.md](../内置记忆与受控自进化-2026-11-08/S9/S9-验收报告.md)，其标题下声称 S9-01—14 全部完成、隔离现场与真实发行物出口全通。总计划 §10 和 README:127 同样声明完成。报告同时明确脚本不触发模型调用，真实模型改进待积累；该证据不足以满足总计划 S9-13 和交付 III 的真实问题闭环判据，不能把验收要求改写成后续使用积累。

已读 [home-packaged/s9-acceptance-results.json](../内置记忆与受控自进化-2026-11-08/S9/home-packaged/s9-acceptance-results.json)和 home-run1 同名结果：11 项 pass。核对正本 [S9/s9-acceptance.mjs:77](/D:/AI/workspace/pao-dev/.pao/内置记忆与受控自进化-2026-11-08/S9/s9-acceptance.mjs:77)及 home-check 脚本可见：

- `seedPassedCandidate` 直接写 passed 候选与 passed 验证，case_results_json 为空；所以这些结果不能补齐 S8-13。
- C4 以 deactivateTaskBinding 模拟后台取消，未启动/中止后台模型或验证子进程。
- C6 是关库重开和 recoverEvolutionState 查询，不是宿主退出重启后真实加载。
- C9 使用 task-cli/task-desktop 等名字直接调用绑定函数，不是 CLI 与 Electron 两宿主实际任务。
- C10 证明挂载路径解析/分流，不证明 loader 已消费候选并改变行为。

发行物 Electron 用例 [packaged-s9-evolution.spec.ts:31](/D:/AI/workspace/pao-dev/desktop/apps/desktop/tests/production/packaged-s9-evolution.spec.ts:31)也直接插 resources/problems/activations/task_bindings/observations，版本目录由测试写入。resource load_method 为 `on-demand`，不在受支持的 skill-path/extension-path 挂接集合；绑定 taskId 固定 task-beta-001，不是当前真实任务。启动时设置 PAO_DISABLE_BUILTIN_EXTENSION=1、离线且清除供应商环境，断言只检查六区文本和截图，没有执行技能、真实任务切换、进程重启后加载或自动退步回退。因此，真实 Electron 和真实发行物进程成立，真实生成、产品资源生效和真实问题改善不成立。

这些是内核直接调用及打包内核路径的机制证据，可支持对应局部状态规则，不能升级成发行物真实改进、双宿主自动生效、后台进化取消或真实重启证明。S9 报告称 activation“复用 auditCandidateForPublish”与当前源码调用搜索不符，见 E08。

| S9 编号 | 当前审核结论 | 实现与证据边界 |
|---|---|---|
| S9-01 | 部分满足 | versions.ts 固化文件及写凭据已实现；未将发布正文绑定到实际验过的内容，E08。 |
| S9-02 | 部分满足 | activation 有 CAS、开关、目录检查；冻结验收/来源前置有 E06/E08/E11，第二轮误冲突 E15。 |
| S9-03 | 局部满足，产品有效性待证 | effectiveVersion 与历史在同事务更新，文件完成后才写凭据；不证明上游验收真实。 |
| S9-04 | 未满足接入判据 | 既有绑定可解析到 loader 优先路径；新任务初始绑定无生产调用，E14。 |
| S9-05 | 部分满足 | 有显式换版函数及延后 reload，但绑定先写；无真实 busy→安全点→实际重载证据。 |
| S9-06 | 未满足接入判据 | recordPatched 已接生效事务；recordUsed 无生产调用，种子观察不是真实采用。 |
| S9-07 | 部分满足、实际归因待验 | judgeRegression 有结构化判定；脚本注入关联失败，不证明真实执行诊断及自动调用。 |
| S9-08 | 部分满足 | rollback/handleRegression 有直接调用证据；实际任务观察触发及通知递送未接证。 |
| S9-09 | 未满足实际操作判据 | 返回 affectedTasks 不等于停止后续相关操作，未找到宿主消费该返回以取消/重载的链路。 |
| S9-10 | 部分满足 | 单资源控制/恢复、DTO/写桥已实现，原报告有 Electron 证据；停用不阻止新生成，E10。 |
| S9-11 | 未满足宿主接入判据 | recoverEvolutionState 有查询与直接调用证据，无宿主启动调用；关库重开不能代替退出、恢复、加载。 |
| S9-12 | 部分满足 | 原报告六个 Electron 用例与发行物一个用例支持数据展示/部分写动作；实际绑定与观察证据不足，E13/E14。 |
| S9-13 | 未满足 | 无真实模型生成、真实问题改善、双宿主实际加载和后台进化取消证据；仅夹具直驱和种子页面。 |
| S9-14 | 文档已交付，交付 III 结论未成立 | 操作说明及报告存在；“完整链/全部验收完成”超出证据，需按本表修订交付结论。 |

推荐主控据此修订 S9 与交付 III 状态：保留已完成的模块/页面与机制证据，明确实际装配和真实闭环未验收，不将它们归为已完成之后的可选增强。

### seedPassedCandidate 与公开函数可达性的判定

**夹具本身不构成对手绕库的产品缺陷；它证明的是调用者预置 passed 后，发布/生效函数可以执行。** 本机合作者有数据库写权限不是本项目要防御的对手模型，不建议加防篡改数据库、签名或额外安全平台。

但本项目确实另有**无需直接写 passed 行的公开函数路径**，不能以“只是夹具”驳回 E06/E08：

1. 对已登记、已有基线的资源，用 declareImprovementIntent→classifyProblem 正常登记问题。
2. 调用 proposeCandidate 时传普通 testPlanId 字符串。其输入与实现没有读取 plan.json、核对冻结计划存在或核对三组样例；正常模型返回合法编辑就写 proposed 候选。
3. 对这个实际 proposed 候选调用 evaluateCandidate，testPlanId 与候选一致，caseResults=[]。本轮真实内存 SQLite 已确认会由函数写入 passed 候选和 passed validation，无须调用者伪造这两种状态。
4. publishCandidate 只检查 passed/最新 passed/非空候选目录，产生完整版本与凭据；activateCandidate 核对基线、开关、目录等，但不读取冻结计划或样例回执。candidate/plan/validation 的 links 都为空时 checkSourceLinksIntact 直接通过，不回查 Problem 的真实来源。

其中 2、4 为当前源码逐步静态确认，3 为本轮运行确认；本轮没有新建磁盘夹具执行完整发布链。实际模型可生成合法编辑是现有公开功能的正常前提，不需要恶意输入；问题在于调用组合遗漏冻结/运行步骤仍被核心认作通过。产品目前缺 E01 编排，不能进一步声称这条路径已在日常后台自动发生。

**空 diffs 的区别：** S9 脚本的 diffs=[] 是直接种子的特征，不据此宣称正常 propose 会产生空差异候选；正常 propose 确实要求实际 changed。公开路径的确认问题是“真实 changed 候选仍可在空验收后发布”，不是“任意人可改数据库”。空 source links 可由正常 propose 不继承问题来源、freeze/evaluate 来源参数可选达到，见 E11。

最小修法仍为 E06/E08/E11：核心评估必须消费真实冻结计划和完整运行回执，发布确认已验证的具体资源及必要来源；不因夹具需要快进而放宽公开业务判据。定向验证应使用正常 proposed 候选，不直接种 passed，省略 freeze 或 runner 时必须拒绝，完整链才可发布。

## 正确部分与外部机制对应

确认应保留的设计和实现：

- 问题登记本身不调用生成模型、不发布资源；有 no_change 与开发建议的合法出口。
- 生成有独立副本、文件清单检查、直接正文比较后才记录变更；已有不同候选行最多三个。
- 冻结样例按三组组织，plan 存在独立受管目录；生成提示不直接包含 holdout。
- 对实际提交的关键失败，evaluate 不用总分抵消；本轮完整提交 holdout 失败得到 failed，属于有效保护。
- command runner 复用参数数组、独立工作目录、进程超时/取消和回执；不能因其他缺口删掉这些能力。
- passed 与 effectiveVersion 分离；S9 发布先完成文件再写凭据，生效指向及历史事务更新；rollback 在当前已非坏版时不覆盖较新修复。这些边界正确。
- 宿主已有 bindings 时会把固定技能路径送入 loader 优先通道；四类不支持装载方式明确 skipped，未伪装已装载。
- SQLite 是指向与业务状态正本，没有额外 current.json；桌面沿既有窄桥传输，不在 renderer 复制生效规则。

外部源码已按调查 §7 固定提交在线读取，不用宣传效果替代 PAO 效果：

| 参考机制 | 固定源码 | PAO 采用结论 |
|---|---|---|
| Reef 副本、提议、评估、settle 分工 | `3a6db13b657b9e93be9f89fbf401c31303a3ef3a`，[backend.py](https://github.com/Human-Agent-Society/reef/blob/3a6db13b657b9e93be9f89fbf401c31303a3ef3a/reef/train/harness_backend/backend.py) | candidates/validation/versions 分工成立；真实编排和资源执行缺 E01/E05/E07，不能称机制完整兑现。 |
| Reef 同任务两侧比较，activation 独立 | 同提交，[policy.py](https://github.com/Human-Agent-Society/reef/blob/3a6db13b657b9e93be9f89fbf401c31303a3ef3a/reef/evaluation/harness/policy.py)、[activation.py](https://github.com/Human-Agent-Society/reef/blob/3a6db13b657b9e93be9f89fbf401c31303a3ef3a/reef/core/activation.py) | PAO 逐项关键保护比总体分数更符合本项目要求；但空验收、环境误判、审计未接使发布门不成立。没有照抄 Reef 丢弃失败运行的策略是正确取舍。 |
| Hermes view/use/patch 分开 | `8422e54df36f42371f31b8fbee653e7c801edcbd`，[skill_usage.py](https://github.com/NousResearch/hermes-agent/blob/8422e54df36f42371f31b8fbee653e7c801edcbd/tools/skill_usage.py) | PAO 有三态表及记录函数，activation 已记 patched；未见详情 viewed、实际任务 recordUsed 的生产调用，统计结构不等于真实活动证据。 |
| Hermes 空闲调度与受管技能 | 同提交，[curator.py](https://github.com/NousResearch/hermes-agent/blob/8422e54df36f42371f31b8fbee653e7c801edcbd/agent/curator.py) | PAO 已定按事实维护、不同于按少用时间归档，这一取舍合理；S8 进化还未接现有空闲调度，不能将 S7 维护已存在当作 S8 已接。 |

Reef 调查 §5 另引用旧提交 `281c730a0f7a5a3eadb475003c043907351c4f3b`；本报告具体机制比对采用 §7 的 `3a6db13…`。Hermes Self-Evolution/GEPA 的有限候选、开发反馈和独立保留要求以已定 PAO 路径审核，未重新运行第三方优化器。未发现需要新引入 Reef/Hermes 整套宿主或依赖的理由。

## 定向离线验证

运行目的：检测评估误通过、来源重复计数和选择状态是否阻断规定流程；失败时将对应完成结论改为缺陷，并指向最小修法，而非重复跑已有全套测试。

实际环境为 Node v24.18.0；通过 `node --experimental-vm-modules -` 执行 stdin 脚本，`stripTypeScriptTypes` 直接加载当前 types/problems/select/evaluate 源码，SQLite 使用真实 `DatabaseSync(':memory:')` 和当前 store.ts 的 SCHEMA_SQL，事务为 BEGIN IMMEDIATE/COMMIT。探针不创建 PAO_HOME 磁盘目录，不调用模型。getSource 导入用内存查询替身连接；样例用 friction 引用，不执行 src- 查询分支。结果是内核函数与真实内存 SQLite 验证，不是产品宿主或真实模型验证。

证据：[实际执行的原脚本](evidence/evolution-probe.mjs)、[工具历史原始输出](evidence/evolution-probe-output.json)。输出保留原进程警告、随机 problemId 和退出码，来源为本会话已执行记录 `995b80`，未重新运行。脚本保留原 stdin CommonJS 文本；需要复现时，在开发根用 PowerShell 执行 `Get-Content -Raw -LiteralPath '.pao/memory-evolution-audit-20261112/evidence/evolution-probe.mjs' | node --experimental-vm-modules -`，不直接按 ESM 执行该 .mjs 文件。候选初始行为数据由探针夹具写入 proposed，passed 状态由真实 evaluateCandidate 写入；该证据不包含 propose、磁盘冻结或发布执行。

| 输入/步骤 | 实际结果 | 判定 |
|---|---|---|
| 相同 evidenceRef 的同一声明调用两次 | 同一 problem，occurrence_count=2 | E02 确认 |
| classify 后 select modify | 问题状态 candidate | 与 freeze 只接受 classified 的源码条件冲突，E04 确认 |
| evaluate，caseResults=[] | verdict=passed，候选 status=passed，total=0 | E06 确认 |
| 只交 reproduction-0，旧版 code=1/候选 code=0 | verdict=passed，total=1 | 正常/保留组可遗漏，E06 确认 |
| 旧版 passed=false/code=127/output=""/failureReason=failureKind=start；候选 passed=true | verdict=passed | 环境故障可充当修复前提，E07 确认 |
| 完整交 reproduction、normal、holdout，holdout 候选失败 | verdict=failed，三项中两项通过 | 关键失败保护正确 |

本轮没有复跑原 Vitest、Electron、发行物或真实模型。已读原报告声称的 105 内核用例和 Electron 1 项，不将这些数量移作本轮结果。S9 结果 JSON 的 pass 也是留档证据，不是本轮实际执行。

## 结构优化建议

1. **收拢一次进化的业务入口。** 直接复用 S7 作业调度和现有模型/预算/执行器，在一个共享入口决定选择、冻结、生成、开发验证、最终保留验证和停止。收益是消除函数各自宣称由调用者保证、实际上没有调用者的责任空洞；保持 CLI/桌面只是装配层。先修 E01/E04/E06/E07，不建立通用优化框架。
2. **资源文件与版本定位复用一份实现。** resources、candidates、versions、activation、control、recovery 各有目录遍历、目录安全名或版本计算逻辑；同一文件/目录形态已出现 E12，原目录/有效版本也出现 E15。选现有版本模块承载小范围文件清单与定位函数，保持原版本 ID 契约，不新增格式、迁移层或校验文件。
3. **复用问题查询映射。** problems.ts 与 select.ts 重复定义完整 Problem 数据库行、SELECT 和 rowToProblem；select 可直接调用已有 getEvolutionProblem，再仅负责选择和状态提交，避免身份/来源字段增补时多处漏同步。保留事务和状态约束。
4. **候选去重直接比较实际差异。** candidates.ts:305 对已经在内存中的 path/kind/newContent 做哈希，只用于相等判断，没有替代更贵读取，也没有额外用途。保留排序及精确语义后直接比较即可；这与现有版本 ID 兼容契约不同，不建议借此全量更换版本机制。

建议处理顺序：接线与冻结顺序→真实资源执行和判据→完整验收与发布门→来源/预算/停止→真实来源 UI→S9 初始绑定和连续版本。先以一个文本技能完成真实闭环，再扩大类别。

## 未核实范围与已知限制

- S8-13 没有可确认的真实重复问题及真实模型闭环证据；本轮未新增真实付费调用。
- 原 Electron 截图与记录属于种子界面证据，本轮未重新启动界面；S9 页面/IPC 的已有验收按报告限定为展示及部分写动作，真实产品加载、任务切换和发行物改进效果仍需补验。
- 原始真实模型用量、实际候选验证延迟、持续收益和缓存效果未测；预算问题 E09 是调用键和结算语义的静态确认。
- S9 未穷尽审核；停止正在执行的工具、通知递送幂等、回退后的实际下一次操作及宿主重启自动恢复需补验，不能由函数返回的 affectedTasks/notification 或恢复查询代替。
- 单文件资源 ENOTDIR、连续第二轮激活冲突按现有受支持类别和公开调用链静态确认，未对磁盘创建夹具复现。
- 本报告不覆盖记忆内部保存、纠正、删除、召回、成果版本等实现质量；E03/E11 仅限进化对这些能力的消费边界。
