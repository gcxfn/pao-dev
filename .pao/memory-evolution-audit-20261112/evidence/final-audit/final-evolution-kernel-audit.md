# O10—O13 共享内核端到端审核

核实日期：2026-11-15。范围：共享内核 evolution、memory/tools 及 worker 编排；业务代码只读。结论：自动技能进化的生产链未闭合，发布验收与退步归因仍有实质缺口。

## 契约结论

原 S8 要求三组验收，并要求核对实际行为。不是必须把所有资源一律交给 agent：命令资源可用命令验证器；文本技能的行为改善必须有技能参与执行的结果，检查 SKILL.md 字面内容不能替代。

- [实施总计划第 166 行](D:/AI/workspace/pao-dev/plans/未完成/2026-11-08-内置记忆与受控自进化实施计划.md:166)：验证包括原问题复现、正常用法和独立保留样例。
- [实施路径第 131 行](D:/AI/workspace/pao-dev/plans/未完成/2026-11-08-受控自进化实施路径-S8-S9.md:131)：逐项比较预期行为、输出、退出码和受影响文件。
- [O11 第 25 行](D:/AI/workspace/pao-dev/.pao/memory-evolution-audit-20261112/o11-实施任务书.md:25)：executeAgentCase 不得对正常返回直接 passed:true。
- [O11 第 38 行](D:/AI/workspace/pao-dev/.pao/memory-evolution-audit-20261112/o11-实施任务书.md:38)：编排保证三组双侧回执齐再 evaluate。

## 发现

### FE1 · P1 · agent 完成态代替验收，生产 reproduction 永远不能通过

状态：机制已复现；真实 provider 未运行。这是既有 O11 已登记残留的现状确认，仍未关闭，不作为新发现重复计数。

触发：已登记文本技能的问题，经窄工具/摩擦入口进入 evolve 作业并生成候选；生产编排固定走 kind=agent。

位置：[tools.ts:1392](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/tools.ts:1392)、[runner.ts:502](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/runner.ts:502)、[runner.ts:518](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/runner.ts:518)、[evaluate.ts:431](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/evaluate.ts:431)、[evaluate.ts:449](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/evaluate.ts:449)。

证据：`agent-wrong-to-correct` 使用真实 runner/evaluate、假会话输出 NO→YES，冻结判据要求 YES。双侧均 passed=true，evaluate 判 incomplete。agent 的另一条失败路径带 executionFailure，同样只能 incomplete。没有表示“会话完成但业务验收失败”的路径。另一个 `wrong-output-publish` 探针提供三组齐全的回执：reproduction 用命令回执证明旧版失败/候选成功，normal/holdout 用假 agent 输出 NO（判据为 YES），真实 evaluate 仍 passed，真实 publish 返回 versionId。这证明输出验收缺失不限于“生产链发不出去”的表象。

影响：自动文本技能链不能发布；正常/保留组的错误答案又不受验收约束。不能用命令通道发布成功作为该缺陷已解决的证据。

最小修法：冻结一个核心控制、能实际执行的结果判据，runner 在会话完整结束后核对实际 output/受影响文件，产出业务 passed/failed；执行故障保持 incomplete。evaluate 消费该结果，不把 completed 当 passed。文本技能首例使用明确可执行判据即可，无需新增通用评测框架。

### FE2 · P1 · 正常组、保留组缺席仍能发布

状态：已复现业务 API 的冻结→运行回执→评估→发布；生产固定空组为静态确认。

触发：调用受支持的 freezeValidationPlan，传 reproduction 一条、normal=[]、holdout=[]。生产 evolve 正在这样调用。

位置：[tools.ts:1312](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/tools.ts:1312)、[validation.ts:177](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/validation.ts:177)、[evaluate.ts:364](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/evaluate.ts:364)、[versions.ts:269](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/versions.ts:269)。

证据：`empty-groups-publish` 用既有合法链夹具调用真实 freeze、runner、evaluate、publish，命令退出码通过假执行器注入，publish 返回 versionId。没有直接把候选设成 passed 来绕发布门。冻结只要求 reproduction 非空，evaluate 的“完整集合”只核对已提供计划中的 ID，因此不会发现整个正常组/保留组缺席。

影响：没有任何关键正常用法与独立保留证据也被系统判可发布。这是业务门缺陷；某一验收运行没有提供三组，则同时构成证据不足。

最小修法：冻结与评估入口要求三组均有用例，生产编排从真实问题及既有用例取得正常/保留样例；未取得时明确待补验收并停止生成/发布，不生成虚构样例。

### FE3 · P1 · 生产验证的空工具集使技能不可见

状态：提示构建机制已复现；整条真实 provider 会话待验。

触发：生产 evolve 的文本技能验证。冻结用例固定 allowedTools=[]，工厂按交集激活零工具。

位置：[tools.ts:1312](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/tools.ts:1312)、[runner.ts:660](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/runner.ts:660)、[runner.ts:725](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/runner.ts:725)、[system-prompt.ts:165](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/core/system-prompt.ts:165)。

证据：`skill-visibility` 给真实 buildSystemPrompt 同一已加载技能，selectedTools=[] 时技能名不在提示中；selectedTools=['read'] 时技能名出现。生产 factory 仅把副本放 prioritySkillPaths，prompt 只发送 problem.actual_behavior，既没有直接展开技能正文，也没有启用 read。普通问题输入因此无法让模型看到或读取待验证技能。

影响：即使补好 FE1，现有装配仍不能证明 baseline/candidate 技能参与了任务。副本物化和指纹绑定证明文件身份，不证明技能行为。

最小修法：为冻结的技能行为用例授予既有白名单内 read，并明确选择/加载对应技能；或者由核心直接把该侧技能正文展开到输入。保持两侧同一任务与工具权限，记录实际参与的版本。

### FE4 · P1 · worker 任意失败会形成自己的回退证据

状态：已复现共享内核调用顺序及真实回退；未运行 worker 子进程。

触发：worker 使用一个已有自动激活版本后，因依赖服务不可用、任务自身错误或启动问题返回非 success 回执。

位置：[dispatch-core.ts:1765](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/worker/dispatch-core.ts:1765)、[dispatch-core.ts:1783](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/worker/dispatch-core.ts:1783)、[dispatch-core.ts:1795](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/worker/dispatch-core.ts:1795)、[regression.ts:428](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/regression.ts:428)。

证据：`unrelated-worker-failure` 通过真实 publish/activate 建当前版本和前版，为任务建绑定，照生产顺序先 recordUsed(outcome='failure') 再 handleRegression；失败描述为“测试依赖服务不可用，连接被拒绝”。结果 kind=normal_breakage、rolledBack=true。judge 只需要 active 绑定和该版本存在任意 used 行，本次写入就满足；不需要曾成功的正常用例、资源参与证据或失败与技能的关联。生产还对每个绑定技能逐条执行，多个资源可因同一无关失败被回退。

影响：外部服务故障等普通失败会停用正常资源版本，并影响后续任务。既有 O13 R5 只检查“别的任务有 used 时可归因”，未覆盖生产“本次失败先制造 used”的自满足链。

最小修法：保留真实使用记录；自动回退另要求本次失败与该资源/冻结正常用例的结构化关联，或者用户明确指认该版本退步。一般任务失败保留调查，不遍历所有绑定自动回退。

### FE5 · P1 · agent 验证请求未接入共享外发与预算边界

状态：静态可达；未发送模型请求，不对实际收费金额作结论。

触发：生成已获许可并返回候选，随后双侧验证；机器通过受支持的环境变量认证提供内置模型。此时验证会创建新的 ModelRuntime 并直接 session.prompt。若仅配置宿主自定义模型/持久认证，则该新隔离 runtime 不继承它们，可能先因无可用模型而失败。

位置：[tools.ts:1392](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/tools.ts:1392)、[runner.ts:686](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/runner.ts:686)、[runner.ts:718](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/runner.ts:718)、[runner.ts:749](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/runner.ts:749)、[runner.ts:768](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/runner.ts:768)、[model-runtime.ts:649](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/core/model-runtime.ts:649)。

证据：生成的 proposeCandidate 在 [candidates.ts:491](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/candidates.ts:491) 和 [candidates.ts:506](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/candidates.ts:506) 有许可/独立 attempt 预算门；验证工厂没有 paoHome 预算、项目许可、ledger 或 request/attempt 身份输入，未装宿主预算扩展，直接调用 SDK。返回 usageRef 仅为 session token 字符串；[tools.ts:1456](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/tools.ts:1456) 未聚合这些费用。SDK 的 before_provider_request 依赖实际注册 handler（[sdk.ts:366](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/core/sdk.ts:366)），不会自动提供 PAO 的共享门。

影响：生成允许不等于双侧每次验证请求都还有额度和许可；有环境认证时验证可绕过后台逐请求结算，完整成本不归候选。仅宿主认证可用时则验证无法沿宿主路由继续。两种环境都不是完整生产装配。

最小修法：复用既有请求预算/外发执行边界及宿主已解析的模型路由，通过窄参数注入隔离会话；每次实际 provider request 独立预留、结算并关联候选。认证留在受控 runtime，不复制凭证文件。没有接好的验证能力保持待验。

### FE6 · P1 · 跨项目续作使用唤醒会话的外发项目

状态：静态可达；未发请求。

触发：同一隔离 PAO_HOME 内 A 留下待处理 evolve 作业，随后只打开 B；B 空闲后共享维护队列领取 A。A/B 的外发许可不同。这是现有持久维护队列支持的跨会话续作。

位置：[maintenance.ts:210](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/maintenance.ts:210)、[maintenance.ts:283](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/maintenance.ts:283)、[tools.ts:1144](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/tools.ts:1144)、[tools.ts:1154](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/tools.ts:1154)、[runtime-embedding.ts:28](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/runtime-embedding.ts:28)。

证据：handler 按 job.sourceScope 的 projectId 查询 A 的问题，却以 resolveMemoryOutboundContext(paoHome, ctx.cwd).project 生成 outboundProject；ctx 是当前 B 会话，由 maintenance 原样传给已领取作业。传入 proposeCandidate 的 outboundProjects 因而是 B；许可门自身正确，但校验对象错误。显式 evolve.outboundProjects[0] 的全局固定值同样不能为任意项目作业证明来源许可。

影响：B 许可而 A 未许可时，A 的问题/基础正文可能按 B 许可外发；反向则把本可执行的 A 作业错误拒绝。无需 agent 验证可用，生成请求阶段已可触发。

最小修法：从作业 projectId 对应的持久项目身份定位真实来源项目，再走已有外发解析；禁止回退到当前唤醒会话的 cwd。无法解析时如实拒绝该作业。

## 验证证据与覆盖

证据入口：[定向探针](D:/AI/workspace/pao-dev/.pao/memory-evolution-audit-20261112/evidence/final-audit/final-evolution-kernel.test.ts)、[运行日志](D:/AI/workspace/pao-dev/.pao/memory-evolution-audit-20261112/evidence/final-audit/final-evolution-kernel.log)、[结构化结果](D:/AI/workspace/pao-dev/.pao/memory-evolution-audit-20261112/evidence/final-audit/final-evolution-kernel-results.json)。配置为同目录 final-evolution-kernel.config.ts；执行入口为开发根 `node PAO/node_modules/vitest/vitest.mjs run --config .pao/memory-evolution-audit-20261112/evidence/final-audit/final-evolution-kernel.config.ts`，环境 PI_OFFLINE=1、PI_NO_LOCAL_LLM=1、PAO_HOME 指向本目录下隔离 home。

五个探针均命中描述的行为。它们断言当前缺陷现状，绿色表示复现成功，不表示产品验收通过。会话输出与命令退出码为注入值；真实运行的是冻结、资源副本物化、回执写盘、评估、发布、激活及回退事务。探针未调用真实 provider，也未启动 worker。隔离 home 保留数据库、版本及回执，可按结果定位。

已覆盖：O10—O13 任务书与原 S8/S9 契约；问题入口和分类/选择/冻结接缝；候选生成的模型输入、停止门、来源继承与预算边界；runner/evaluate/publish/activate 接缝；worker 使用/退步挂点；主会话绑定和 CLI 启动恢复调用；control 的恢复来源核对、recovery 的状态读取。空 caseResults、漏已有 plan case、结构化执行故障会阻止 passed；发布仍核能力范围、四级来源及已验文件绑定，这些静态保护成立，本轮未重复运行既有无关回归。

未覆盖/待验：真实付费 provider、实际 worker 子进程、CLI 交互热换版/中断重启、跨进程正在执行任务的停止、Electron/桌面 renderer/main、发行物、成果链、O15 证据脚本、全量测试及构建。O12 来源删除/恢复本轮仅核对接线，未重新做删除数据演练。FE5/FE6 的实际请求与许可账本表现仍需零外发的受控 provider 探针或后续获授权验收。

业务修复与证据补齐应分开验收：FE1—FE6 属现行代码路径问题；真实 provider 的技能行为、三组独立结果和实际使用/退步闭环属于必须补齐的证据。补跑命令文本检查不能关闭 agent 验收和技能参与缺口。
