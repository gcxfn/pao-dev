# O08/O09、O12/O13 宿主审核

核实日期：2026-11-15。H1 已按授权修复，仅修改 artifact-registration.ts 业务文件及成果登记测试；审核文件均使用 final-hosts- 前缀。未访问正式 PAO_HOME，未发模型请求，未全量测试或构建。

结论：O08 的真实可执行成果复用已补证，Git 与 managed 两路均有实际 node 执行、结果文件、卡回执和 use 归因。H1 成果登记身份跨项目碰撞已修复；H2—H5（浏览后无关回执误记复用、未挂载资源误记 used、worker 资源清单被全量装配扩大、回退结果未被运行宿主消费）保持未关闭。现有 Electron 证据覆盖种子详情与用户控制，不能据此判定真实新会话装配、退步热回退或重启恢复已经验收。

## 已补的 O08 有效证据

测试：[final-hosts-o08.test.ts](D:/AI/workspace/pao-dev/.pao/memory-evolution-audit-20261112/evidence/final-audit/final-hosts-o08.test.ts)。运行入口为开发根：

```powershell
$env:PI_OFFLINE='1'
$env:PI_NO_LOCAL_LLM='1'
$env:PAO_HOME='D:/AI/workspace/pao-dev/.pao/memory-evolution-audit-20261112/evidence/final-audit/final-hosts-unused-home'
node PAO/node_modules/vitest/vitest.mjs run --config .pao/memory-evolution-audit-20261112/evidence/final-audit/final-hosts-vitest.config.ts
```

本次按疑点分次运行各场景，未重复无关已通过场景。断言同时覆盖有效链路与缺陷存在；测试通过不表示发现的问题已修复。

| 路线 | 实际链路 | 结果证据 |
|---|---|---|
| managed | SessionManager 持久会话工具调用→captureToolCallSource→真实 write 写 compute.cjs→pao_submit_receipt 登记→另一会话/卡 resolve→真实 write 写回读字节→实际 node 子进程→pao_submit_receipt 提交真实 stdout 与 result.json→artifact_uses | [managed 结果](D:/AI/workspace/pao-dev/.pao/memory-evolution-audit-20261112/evidence/final-audit/final-hosts-managed-EstpGN/final-hosts-result.json) |
| Git | 同上生产脚本→真实机械验收→pao_deliver_card 实际 commit 并登记 Git 版本→另一会话/卡 resolve→实际 node→结果回执与 use | [Git 结果](D:/AI/workspace/pao-dev/.pao/memory-evolution-audit-20261112/evidence/final-audit/final-hosts-git-9KmCL0/final-hosts-result.json) |

两路均先改写工作树 compute.cjs 为必抛错脚本，再确切回读已登记版本执行。执行输入 11，stdout 为 `{"input":11,"answer":80}`，退出码 0，result.json 同值。生产会话、复用会话与浏览会话分离；use.task_id 与 origin_task_id 不同。没有手工 INSERT 来源、成果或 use，也没有手填 pass 回执；复用回执仍如实为 pending_review。

证据层级：离线、确定性工具边界集成。注册与调用真实生产工具及同一登记闭包；工具调用顺序由审核脚本驱动，执行使用真实 node 子进程。没有启动 CLI/Electron agent，也没有模型决定调用；不能把它写成实际桌面或模型自主复用验收。脚本、持久会话、卡回执、结果 JSON 与 [执行日志](D:/AI/workspace/pao-dev/.pao/memory-evolution-audit-20261112/evidence/final-audit/final-hosts-o08-run.log) 保留；隔离 home 与缓存已移入回收站。

## H1：同一 PAO_HOME 中不同项目同号卡串用登记身份（P1，已修复）

受支持触发：两个独立 Git 项目共用一个 PAO_HOME，各自第一次提交卡 0001、尝试 1，文件内容分别为 alpha/beta。

实现：[artifact-registration.ts:96](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/artifact-registration.ts:96) 的回执键使用 `${taskId}:${attempt}`；[artifact-registration.ts:174](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/artifact-registration.ts:174) 的交卷键使用 `${taskId}:deliver:${fullSha.sha}`。taskId 复用 taskIdForCard 的规范卡目录身份。回执按同卡同尝试重放幂等；交卷按同任务的确切完整提交版本区分，不同提交分别登记，同提交重放幂等。

验证：[成果登记测试](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/test/pao/memory-artifact-card-hooks.test.ts:149) 的 receipt/delivery 两个场景验证两个独立 Git 项目共用 home、同号卡分别交付不同内容，各有自己的成果、登记键及确切回读内容；直接重放同一登记闭包输入，返回原 version、版本集合不变。交卷用例另使用同一任务、同一尝试的两个真实 Git 提交，断言登记两个确切版本、分别回读内容，重放任一提交均不新增版本；第二次登记传短 SHA，键中仍为完整 SHA。审核探针另验证两项目自己的成果和 task 引用：[独立项目结果](D:/AI/workspace/pao-dev/.pao/memory-evolution-audit-20261112/evidence/final-audit/final-hosts-project-identity-Oc08F5/final-hosts-result.json)。

本次交卷定向 2/2 通过：跨项目登记隔离/同提交重放，以及同任务不同提交分别登记/同提交重放。日志：[final-hosts-h1-delivery-run.log](D:/AI/workspace/pao-dev/.pao/memory-evolution-audit-20261112/evidence/final-audit/final-hosts-h1-delivery-run.log)。回执、managed 和真实脚本执行未重复运行；既有 8 项验证记录见 [final-hosts-h1-run.log](D:/AI/workspace/pao-dev/.pao/memory-evolution-audit-20261112/evidence/final-audit/final-hosts-h1-run.log)。已有实际执行结果：[managed](D:/AI/workspace/pao-dev/.pao/memory-evolution-audit-20261112/evidence/final-audit/final-hosts-managed-LcotkV/final-hosts-result.json)、[Git](D:/AI/workspace/pao-dev/.pao/memory-evolution-audit-20261112/evidence/final-audit/final-hosts-git-kY66Ol/final-hosts-result.json)，node 退出码 0、answer=80，回执和 use 归因存在。

运行入口（开发根，环境同上）：

```powershell
node PAO/node_modules/vitest/vitest.mjs run --config .pao/memory-evolution-audit-20261112/evidence/final-audit/final-hosts-h1-vitest.config.ts -t 'delivery：跨项目|F11 挂点 B'
```

H2—H5 未修改、未关闭。本次未更新发行物，也未补写旧登记数据。

## H2：只浏览后提交无关回执仍记 reuse（P2，Git/managed 均已复现）

受支持触发：任务浏览某成果用于判断是否适用，未执行或复用，随后提交其独立工作的回执。

位置：[tools.ts:688](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/tools.ts:688) 把成功 resolve 放进会话列表；[artifact-registration.ts:109](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/artifact-registration.ts:109) 在任意卡回执处枚举全列表，[artifact-registration.ts:112](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/artifact-registration.ts:112) 无执行关联地写 reuse。

证据：上述 Git/managed JSON 的 usesAfterBrowse 均仍为 1；浏览任务提交明确写着“未执行或复用脚本”的回执后，usesAfterUnrelatedReceipt 均变为 2。单独浏览暂不写库，但其后的无关回执会把它转成虚假执行引用，误导使用历史和成果保留判断。

最小修法：回执只归因本任务明确声明、且与本次实际执行关联的版本，不遍历会话全部 resolve；浏览列表不能充当执行证据。复用成功场景保留当前真实执行和结果回执。

## H3：加载桥明确跳过的资源仍显示实际 used（P1，事件边界已复现）

受支持触发：显式登记并快照文件型模板，启动普通主会话，完成一轮交互。O12 正式支持这种文件型资源。

位置：[host-mount.ts:111](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/host-mount.ts:111) 将 template-file 列为 skipped；[tools.ts:1635](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/tools.ts:1635) 的 agent_settled 处理器在 [tools.ts:1637](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/tools.ts:1637) 枚举全部 active 绑定，并在 [tools.ts:1641](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/tools.ts:1641) 对每条记 used。未消费 mounted/skipped/missing 结果。

证据：[结果](D:/AI/workspace/pao-dev/.pao/memory-evolution-audit-20261112/evidence/final-audit/final-hosts-skipped-use-Eo4Z2k/final-hosts-result.json)、[日志](D:/AI/workspace/pao-dev/.pao/memory-evolution-audit-20261112/evidence/final-audit/final-hosts-skipped-use-run.log)：mounted 为空、template:example 在 skipped，调用真实扩展 settled 处理器后仍有该版本 action=used。此探针直接驱动事件处理器，不声称启动真实 Electron。

影响：详情使用数失真，绑定意图被当作实际加载；missing 降级路径静态同样没有排除条件，可能把实际资源根的运行记到缺失版本。

最小修法：观察使用宿主实际成功装配的版本集合，排除 skipped/missing；换版 reload 成功后再更新该集合，不能用绑定表替代运行时已加载版本。

## H4：worker 的显式技能清单被 CLI 子进程扩大（P1，共享调用序列已复现，真实 spawn 待验）

受支持触发：home 已登记 requested/unrelated 两技能，配方只声明 requested，派发正常会话 worker。

位置：[dispatch-core.ts:1640](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/worker/dispatch-core.ts:1640) 按 resourceIds 清单 ensure；worker CLI 进入共用 createRuntime 后，[main.ts:832](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/main.ts:832) 对同 sessionId 调解析，[main.ts:620](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/main.ts:620) 又不带清单 ensure；[host-mount.ts:188](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/host-mount.ts:188) 缺省取全量 effective 资源，[main.ts:881](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/main.ts:881) 全部放进 prioritySkillPaths。

证据：[结果](D:/AI/workspace/pao-dev/.pao/memory-evolution-audit-20261112/evidence/final-audit/final-hosts-worker-list-Svrs6b/final-hosts-result.json)、[日志](D:/AI/workspace/pao-dev/.pao/memory-evolution-audit-20261112/evidence/final-audit/final-hosts-worker-list-run.log)：派发序列 mounted 只有 requested；执行源码 CLI 相同的第二次 ensure 后 mounted 同时包含 unrelated。没有运行真实 worker CLI 子进程。

影响：配方未声明的资源进入 worker 上下文，绑定与使用归属偏离任务实际声明；同一全量选择也包含已登记 extension-path。

最小修法：主会话才做全量初始 ensure；worker 只解析派发期已写绑定，或明确传同一资源清单，不在子进程补绑全库。

## H5：退步/恢复结果没有接到实际运行会话的换版入口（P1，静态调用链）

受支持触发：已绑定新版的桌面会话内声明退步并触发回退；或资源详情恢复旧版本时仍有活跃任务绑定新版。

位置：[tools.ts:997](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/tools.ts:997) 只对当前 sessionId 调数据库 switch；[dispatch-core.ts:1796](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/worker/dispatch-core.ts:1796) 收到退步结果后只在回执告警中写资源已回退，未消费 affectedTasks。[memory.ts:3278](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/desktop/memory.ts:3278) 恢复操作返回 affectedTasks；[memory-bridge.ts:785](D:/AI/workspace/pao-dev/desktop/apps/desktop/electron/platform/pao/memory-bridge.ts:785) 直接透传结果；[evolution-detail.tsx:582](D:/AI/workspace/pao-dev/desktop/apps/desktop/src/features/memory/evolution-detail.tsx:582) 仅提示仍绑旧版。

现成加载入口 [session-supervisor.ts:2107](D:/AI/workspace/pao-dev/desktop/packages/pi-sdk-driver/src/session-supervisor.ts:2107) 能更新 priority paths 并安全点 reload，但全仓引用只有其定义，没有业务调用者。当前声明工具对桌面也走同一只改 DB 路径，后续 settled 还按新 DB 版本记 used，实际 loader 可能仍是坏版。

影响：资源全局指向已回退，当前任务仍可能继续使用坏版；CLI 仅写账本与绑定，没有把“须停止后续相关动作/下次会话生效”递送到实际当前会话。详情恢复提示“任务仍绑定旧版本”本身如实，但不是已完成运行宿主换版的证据。

最小修法：由宿主消费统一的 affectedTasks：本进程桌面记录调用既有 switchSessionResourceAtSafePoint，按 deferred/reloaded 如实展示；CLI 明确递送停止相关动作与重开生效提示；跨进程任务列明待处理，不宣称已停止。观察仍须使用真实已加载版本。未运行真实 Electron 回退验证。

## 已覆盖与未覆盖

- 已覆盖：当前源码 O08 A/B 回调实际工具链、来源捕获与确切内容回读、Git/managed 真实 node 执行及新回执/use、浏览反例、独立项目登记碰撞；O13 全量/清单装配接缝、skipped 观察事件、回退和恢复结果的消费者搜索。
- O09：静态核对 todoContinuationFacts 的全终态保存分支、当前任务过滤和 agent_settled 共用挂点，没有发现新的完成接续缺陷。既有已关闭边界未重复测试。
- O12：静态核对详情 DTO 的 baseFiles、冻结 acceptance/回执路径，以及页面 InlineDiff/delete/fallback 渲染，没有发现新的详情接线缺陷。删除算法、runner/发布算法不在本次职责。
- 启动恢复源码：CLI main.ts:603 消费恢复报告；桌面 electron/main.ts:215 调 recoverDesktopEvolutionState，needsAttention 走通知。未发现新的“恢复入口完全未接”问题；真实重启后会话资源装配尚未验证。
- 未覆盖：实际 CLI/worker 进程端到端资源加载、当前源码的真实 Electron 新任务/忙中换版/退出重启、跨进程停止、付费模型、发行物独立安装。没有运行全量测试/构建。

## Electron 与发行物证据边界

原 O08 的 [memory-artifacts.spec.ts:105](D:/AI/workspace/pao-dev/desktop/apps/desktop/tests/core/memory-artifacts.spec.ts:105) 直接 seed recordArtifactUse；能证明成果详情与历史呈现，不能证明复用成果被实际执行。此次离线真实脚本证据补足工具边界执行链。

原 O12 的 [memory-evolution.spec.ts:312](D:/AI/workspace/pao-dev/desktop/apps/desktop/tests/core/memory-evolution.spec.ts:312) 启动真实 Electron，但随后灌问题/候选/验证种子，并自行写 plan 与 runs 回执；六项用例证明详情对照和用户控制，不证明自动进化、实际挂载或重启恢复。[packaged-s9-evolution.spec.ts:110](D:/AI/workspace/pao-dev/desktop/apps/desktop/tests/production/packaged-s9-evolution.spec.ts:110) 同为单次启动加种子展示，未发现可直接复用、覆盖进化绑定真实退出重启的新会话用例。通用 release-zip 重开用例不验证进化资源，不列作替代。

V5 按主控核定为包内 API 跨进程读库证据，不作为发行物脱离开发仓或真实 Electron 恢复证据。未读取其脚本。

现有 app.asar 的只读宿主补证见 [final-hosts-package-result.json](D:/AI/workspace/pao-dev/.pao/memory-evolution-audit-20261112/evidence/final-audit/final-hosts-package-result.json)：包时间 2026-11-11T16:58:58.183Z，缺 artifact-registration.js；包内 main/desktop host-mount 没有当前 ensure/恢复接线，memory tools/worker dispatch 没有新增 used/退步接线。仅据此判定现包与本轮源码不一致，不把符号缺失当作真实运行测试。备份 serialize 故障的实际 Electron 复现采用主控 packaged-electron-results.json，本轮未重复运行。编译全文副本已移入回收站，保留只读检查脚本和符号/行号结果。
