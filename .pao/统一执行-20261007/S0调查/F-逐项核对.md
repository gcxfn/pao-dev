# F 清单（pi-maestro-flow 参照实施清单）16 项源码核对

调查日期：2026-10-07（只读调查，未修改任何源码；本文件为唯一新建产物）。
调查人：S0 只读调查子代理。

## 调查方法

1. 读 F 正本 `plans/已完成/存档-收编-2026-10-07/2026-10-07-pi-maestro-flow参照实施清单.md`（16 项机制描述与完成判据）与附件摘录 `plans/附件/2026-10-07-pi-maestro-flow抄改代码摘录.md`（参照实现形态）。
2. 读统一计划 `plans/已完成/2026-10-07-统一分阶段自主执行计划.md` 第 5 节（S2/S4—S7 范围）与第 7 节（16 项阶段归属、C1—C5 条件项）。
3. 逐项用 grep 定位关键标识符（`sessionGeneration`/`lease`/`completed_with_deviations`/`operationId`/`realpath` 等）并读源码确认，覆盖 PAO 内核 `PAO/packages/coding-agent/src/pao/`、pi 内核 `PAO/packages/coding-agent/src/core/`、桌面 `desktop/apps/desktop/electron/` 与 `desktop/apps/desktop/src/`、桌面共享包 `desktop/packages/`。
4. 代码图（codebase-memory，D-AI-workspace-pao-dev-PAO / D-AI-workspace-pao-dev-desktop）确认可用（状态 ready，索引 2026-10-06），本轮以 grep+精读为准；行号截至 2026-10-07 工作区现状，仅供定位。

判定口径：**已实现**＝机制主体在位且验收可对照；**部分**＝机制一半在位或形态不同需改造衔接；**未实现**＝未找到对应机制；**条件项未触发**＝统一计划 C1—C5，现状零或仅有底座，不实施不算缺口。

## 总览

| 状态 | 项 |
|---|---|
| 已实现（基本可对照验收） | A-3、A-10 |
| 部分 | A-5、A-6（窗口在、闸未装）、A-7、A-8、B-2、B-4 |
| 未实现 | A-1、A-2、A-4、A-9、B-3、B-6 |
| 条件项未触发（符合预期） | B-1、B-5（B-5 有规则分类底座） |

与统一计划第 7 节预期差异最大的两项：**A-10**（计划列为 C5 硬前置、未触发不建，实际护栏已建成并有测试，仅巡库派发启用）和 **A-3**（计划预期"待复验+补齐"，实际内核三边界+连线即时拒+依赖门+转移白名单都在，缺口只剩桌面向导 IPC 的骨架级校验）。

## 逐项核对

### A-1 桌面状态通道（投影纯函数＋四字段信封＋指纹去重＋查询回放）— **未实现**

- 现有实现：无信封。全仓 grep `sessionGeneration`/`publishedAt`/`publishFull`/`SNAPSHOT_VERSION` 零命中；内核与桌面均无 UiPublisher 类物。
- 现状替代：桌面画布/看板走一次性只读查询桥——`desktop/apps/desktop/electron/platform/pao/canvas-query.ts:2`（一次调用返回画布整页）、`workboard-query.ts`（头注释：不轮询、不缓存，渲染层打开视图拉一次）、`flow-control-query.ts`；对话时间线有 `desktop/apps/desktop/electron/conversation/streaming-ui-publisher.ts:13`（50ms 尾沿节流整页发布），但那是会话时间线层，不是画布运行态信封，无版本/换代/指纹语义。
- 与 F 验收差距：六态着色经通道更新、切标签不串、打开即有数据所需的四字段信封（version/sessionGeneration/revision/publishedAt）、指纹去重、查询回放订阅全部要建。
- 归属：S6（S7 消费）。
- 备注：投影函数抄形即可，权威数据源已是卡/控制清单文件，纯函数投影面清晰；桌面 app-store 事件发布骨架可挂。

### A-2 看板增量纪律（游标单调＋gap 诚实＋超前报错）— **未实现**（WS 二期为 C1）

- 现有实现：无 cursor/observe/gap 机制（grep 零命中）。现状＝打开拉全量＋失败显式错误不伪装空列表（`workboard-query.ts:1-10`；`canvas-query.ts:809` 读不回时提示刷新核对）。
- 与 F 验收差距：两条纪律（补不齐显式全量重读、进度超前报错）需先有游标事件流才有对象；首版 S7 只做打开拉取＋手动刷新（全量口径），纪律随增量通道引入才适用。
- 归属：S7；WS 断线续传为 C1 未触发。
- 备注：参照的 observe 语义（`board-store.ts` observe）在引入时整段可抄；失败显式错误的既有口径已对齐纪律精神，勿在 S7 重做。

### A-3 连线校验三边界（保存/读取/启动跑环检测＋悬空依赖；连线当场拒；转移白名单；依赖完成才可启动；归档不收被依赖卡）— **已实现（一处补齐）**

- 解析全量校验：`PAO/.../pao/workflow/recipe.ts:195` `parseRecipe`——悬空依赖 `RECIPE_DEP_UNKNOWN`（约 :400-411）、自依赖、Kahn 环检测 `RECIPE_CYCLE`（:410-437）、占位符声明校验、ui.positions 引用校验。
- 三边界在位：读取 `loadRecipe`（recipe.ts:493，:504 过 parseRecipe）；保存 `saveRecipe`（workflow/distill.ts:308，:317 校验不过零落盘）＋桌面渲染保存 `renderDesktopRecipe`/`checkDesktopRecipeEdit`（pao/desktop/editor.ts:59/66，含 revision 冲突与运行中实例拒改）；启动控制清单重过 parseRecipe 验冻结结构（workflow/control.ts:106）。
- 连线当场拒：桌面 `planConnection`（`desktop/.../features/canvas/recipe-canvas-editor.tsx:167`，:189 成环拒绝、审核回边单独配置）。
- 转移白名单：`cards/statemachine.ts:42` `INVALID_TRANSITION`；依赖完成放行门 `cards/deps.ts:61-76` `checkDependencies`＋环检测 `findReachableCycles`（:24）；工作流侧 ready 判定 `workflow/control.ts:172-177`（依赖全「已交付」＋审核 pass＋人工确认）。
- 归档保护：PAO 无卡归档/回收机制（grep 无 deleteCard/prune），「归档不收被依赖卡」前提不成立；若后续引入归档须同批加被依赖保护。
- 差距：桌面向导 IPC 的 `expectWizardRecipe`（`desktop/.../electron/ipc/request-validation.ts:783`）与 `validRecipeShape`（`desktop/.../electron/platform/pao/workflow-wizard-bridge.ts:165`）只验骨架（名字＋节点数组）后断言类型——正是 S2 验收点名"不只验骨架"的待补点；坏配方要到内核 parseRecipe 才报错。
- 归属：S2（复验＋补齐骨架深校验）。
- 备注：无需抄参照的三色 DFS（Kahn 已有且出成环节点清单）；补齐方向是让向导保存/启动 IPC 入口复用内核全量校验或前置等价校验。

### A-4 派单租约（认领记到期＋孤儿显式接管＋代栅栏）— **未实现**

- 现有实现：认领链在位——`worker/dispatch-core.ts:133` `claimCard`（待认领→进行中、失败重开校验 owner 与尝试上限）、尝试号纪律（`cards/receipts.ts:76` appendReceipt：旧尝试留档不推进、迟到留档、超前报错）、owner 单写者校验（`cards/statemachine.ts:81-116`）。停滞/静默监控有（dispatch-core.ts:330 读「停滞阈值分钟」；桌面 `kanban-activity.ts` 静默活性四态）。
- 未找到：租约到期时间（leaseExpiresAt）、到期不自动放权、孤儿判定、显式接管、认领代数 claimGeneration 单调＋1 与旧 worker 操作拒绝。
- 与 F 验收差距：B 档监督 30min 判据所需租约事实、旧 worker 复活操作被拒的代栅栏，全缺；现attempt（尝试号）只管回执推进，不管认领权。
- 归属：S5 第 3 包（S7 amber 呈现消费）。
- 备注：租约落运行器登记不进卡字段（运行期事实），现登记表（worker/registry.ts）与保温配置是可挂点；尝试号≈参照 generation 的卡侧对位已有，勿双写两套代数。

### A-5 人工交互接管协议（open(request):Handle|undefined 缝＋竞速＋取消清理）— **部分**

- 现有实现：无 AskTransport/PlanTransport/`Symbol.for` 注册表（grep 零命中）。但有单宿主版人工门通道：桌面 `desktop/packages/session-driver/src/types.ts:287-320` HostUiRequest（confirm/input/select/editor，requestId）＋HostUiResponse（值/确认/取消）；`desktop/packages/pi-sdk-driver/src/session-supervisor.ts:235` pendingHostUiRequests 登记、:696 应答、closeSession 时 :1595 取消全部 pending；未送达通知重放（:1576-1582）。
- 未找到：内核侧多宿主竞速缝（先答生效、输家收到 cancel 清理）、无桌面时回落 TUI 的显式协议、plan 侧"改后回传带期望版本"。
- 与 F 验收差距：桌面窗口答人工门（已有基础）、终端先答桌面自动关（竞速缺）、无桌面行为不变（回落语义要显式化）。
- 归属：S4 第 5 条。
- 备注：取消清理已有（closeSession 取消 pending），参照可抄的是 `open():Handle|undefined` 注册表与竞速输家 cancel；HostUiRequest 的 requestId 通道可作桌面注册端的承载，不必另起协议。

### A-6 提交防连点（单飞竞态闸）— **部分（竞态窗口在，闸未装；S4 核触发）**

- 现状：未装任何闸（无 submit-gate 类扩展）。fork `core/agent-session.ts`：`prompt()`（:1922）的异步前置——扩展 input 事件（:1946 起）、技能/模板展开、模型鉴权 await、提交前压缩 `_checkCompaction` await——全部发生在 `_isAgentRunActive = true`（`_runAgentPrompt` :1784）之前；入口守卫只查 `isStreaming`（:1431，实现＝`_isAgentRunActive`）与压缩互斥。结构上与参照根因描述一致：前置窗口内第二次 idle 提交可通过 isStreaming 检查并发进入。
- 与 F 验收差距：A-6 本是条件备查项，S4 要求"先核 pi 是否仍有单飞竞态"。按 fork 源码结构判断窗口存在，但"实际可触发"须 S4 用真实异步前置（压缩/鉴权慢）实测确认；事件名按当前 fork 核对。
- 归属：S4 第 6 条（核触发；确认有才借排队重放＋60s 兜底）。
- 备注：参照 extension 的 input 闸/排队重放/agent_settled 释放三件套可直接对位 fork 的扩展事件；若实测无竞态，按计划留"不需要补丁"证据。

### A-7 worker 回执 schema（四态＋恰好一次＋verification/changes 声明面）— **部分**

- 现有实现：结构化回执在位——`worker/receipt.ts:15` `WorkerStatus = 成功/失败/取消/未知`、:60/:77 `validateReceipt` 必填七字段（卡号/尝试/状态/产物路径/摘要/用量/证据路径）、:234-245 状态枚举与失败类型强制；「恰好一次」终局 JSON 纪律在派发提示词（dispatch-core.ts:51）；尝试号三态处理（旧尝试留档/迟到留档/已记录）`cards/receipts.ts:22`/:76；回执内容三格校验（产物存在、摘要≤3 行）receipts.ts:33。
- 差距（对照 F 验收）：①四态语义不同——参照 `completed/completed_with_deviations/blocked/checkpoint`（带偏差可交付、决策点求指导），现「成功/失败/取消/未知」无 deviations/checkpoint 语义；②无 verification 数组（机械验收员吃卡面验收字段 `parseAcceptance`，cards/verifier.ts:78，不吃 worker 自报）；③无 changes 声明数组（越界比对走认领基线快照对 git 真实差异，dispatch-core.ts:144-158＋cards/delivery.ts:141-162——机械面更强但不来自 worker 声明）；④schema 在代码而非与角色定义伴生的文件。
- 归属：S5 第 1 包（S8 扩展"未勾项"列出）。
- 备注：S5 落地时决定「四态扩到现有 WorkerStatus」还是「映射表」，changes 声明面与基线 diff 的双轨关系要在工作包里定案，避免两套事实。

### A-8 配方四写法＋常驻监督员 — **部分**

- 现有实现：派完即停（worker/index.ts:225「本工具调用到此返回，不等 worker」）；完成消息唤醒零轮询（worker/notify.ts:16 派卡通知面，before_agent_start 消费式注入；workflow/auto.ts:8「无定时器无轮询」）；角色装载面隔离强于提示词约束——`role.ts:39` MINISTER_SKIPPED_MODULES（部长跳过 fanout/collab/host/resident，注册层不装）；监督唤醒是机械轮次阈值挂事件边界（host/host.ts:478-484，host/config.ts:30-33 工人/部门监督轮次），非模型轮询、非时钟。
- 差距：①无「概要常驻/干法按需」部门配方双层结构（grep 干法/概要仅注释提及）；②无回执标签路由表（RESEARCH-*式前缀路由不存在，仅能力标签匹配协作/知识库 auto-route）；③配方模板未按四写法生成（workflow/templates.ts 模板是单层节点字段）。
- 归属：S5 第 4 包（配方四写法部分可随配方模板先行）。
- 备注：参照可抄的是 SKILL.md 薄路由＋外置 required_reading＋回执标签路由表形态；常驻监督员三段（孵化→消息唤醒→shutdown）与现有派卡通知/轮次阈值是两代形态，S5 定案以消息唤醒为主、轮次阈值保留为机械兜底。

### A-9 入库注入防线（正文与证据分字段纯函数）— **未实现**

- 现有实现：knowledge/ 无 transcriptQuote/content 分字段结构（grep 无 bindTranscriptEvidence 类纯函数）；`knowledge/crystallize.ts:104` 只有 L1 指针/L2 正文层级纪律；`knowledge/gate.ts` 是 worker 受限补查门（锁本部/只读/限次），与提取注入无关。入库链 `knowledge/ingest.ts` 无"引文永不自动填充正文"的机械闸与分离测试。
- 与 F 验收差距：注入试验（引文内容无法进入可检索正文）无法通过——机制本体缺。
- 归属：S5 第 2 包。
- 备注：参照 bindTranscriptEvidence 纯函数＋"分离不可再接通"测试整段可抄；落点在 knowledge 沉淀/入库工具（crystallize/ingest）。

### A-10 worker 护栏四判定（硬门槛）— **已实现（一处缺口）**

- 现有实现：`pao/patrol/shell-guard.ts`（549 行纯函数机械筛）＋`patrol/wire.ts`（tool_call 钩子：`PAO_SHELL_GUARD_WORKSPACE` env 注入才启用，拦 bash/powershell，拒因模型可见）＋派发链注入（dispatch-core.ts:246 巡库卡注入锁定工作区，runner 转进子进程 env）；非巡库派发零行为。测试在位：`test/pao/patrol-shell-guard.test.ts`、`patrol-shell-guard-wire.test.ts`、`patrol-hook.test.ts`。
- 四判定对照：①拆段逐段过规则——有（路径类 token 逐个提取判定，含重定向目标、套壳拆壳递归再审）；②命令替换——比参照更紧：$()/反引号/未知变量一律拒（参照是"通配失效但逐字精确规则放行"的逃生门，PAO fail-closed 无逃生门）；③realpath 出圈即拒——**缺**：护栏声明纯函数不查文件系统，工作区内 symlink/junction 指向外部列为已知绕过面、靠第一道防线（工具白名单）兜底；④win32 大小写不敏感——有（路径段大小写折叠＋段前缀比较防同前缀误吞）。
- 与 F 验收差距：仅 realpath 真值判定缺；F 判据四条里第三条（realpath 出圈即拒）未满足，其余三条满足或更严。
- 归属：C5 硬前置（无人巡库上线前必须补齐第③条或以工具白名单实证补偿）。
- 备注：**与统一计划预期差异最大项**——计划把它当"未建的前置"，实际已建成有测试。S0 应登记为"已装、仅巡库启用、缺 realpath 判定"；触发 C5 时补第③条（参照 resolveRealPathCandidate 逐层向上 realpath 的做法可抄，需把纯函数边界改为可注入 fs 探测）。

### B-1 goal 对照件 — **条件项未触发（C2），现状零**

- 现有实现：无 goal 工具/扩展（grep 仅 slugifyGoal 等卡命名助手）。预算/三态判定/分账计数均无。
- 归属：C2（pi-goal-x 评估启动时对照，不预装）。

### B-2 压缩检查点 — **部分（底座有，链与阈值无；C3 未触发）**

- 现有实现：压缩前任务原文快照——`pao/memory/compaction-state.ts:20` captureTaskSnapshot（用户约束/工具错误/进展原文＋entryId，去重、未完成行筛选），已接线（pao/index.ts:23/:117 registerTaskCompactionState）；头注释明确"不写入共享事实库"（与参照"检查点不进知识库"同向）。
- 差距：无血缘链（previousCheckpointId）、无丢结果留指针（evidenceIndex 会话回执）、无双模型联动阈值——pi 内核 `core/compaction/compaction.ts:128` 只有单模型 reserveTokens(16384)＋窗口判定（:269），无 summary 模型窗口推导/取更小/自托提前触发。
- 归属：C3（部长会话首次真实压缩摩擦才动工）；触发时底座快照可复用为检查点明细的一部分。

### B-3 重试幂等与结果未知（唯一操作号＋payloadHash＋启动栅栏）— **未实现**

- 现有实现：无 operationId/canonical JSON/回执 id 去重/outcomeUnknownAt（grep 零命中）。派发/回执无操作号；重启后在途操作无栅栏概念。
- 相邻机制：「结果未知」作为失败分型一等类存在（cards/types.ts:15 FAILURE_TYPES；cards/failures.ts:35-40 路由"先查现场（git status/跑测试）再定续跑还是重跑"）——参照"结果未知走先查现场"的语义在失败分型层有了雏形，但那是事后分型，不是操作幂等。
- 与 F 验收差距：同号重试返回缓存、跨项目同号、重启不重放在途操作，全缺。
- 归属：S5 第 3 包（与 A-4 租约同包）。
- 备注：参照 canonical payload＋sha256 回执 id 整段可抄；落点在派发/回执通道（dispatch-core/ receipts）＋控制清单或运行器登记。

### B-4 外部内容只拦不放行（不对称授权＋信任哈希账本）— **部分（形态不同）**

- 现有实现（同向机制）：①协作卡裁决标记——`collab/review.ts:15-19` COLLAB_VERDICTS＋RULING_FLAGS（插队/新权限/超预算覆写/验收存疑），带标记的卡不落队列、交主控裁决＝外部声明不能自我授权；②机械验收员安检门只拦不放（verifier.ts:110 句式安检、:563 路径安检，拒＝安检拦截态，无任何"输出导致免检"通道）；③worker 受限补查门（knowledge/gate.ts：卡号＋授权轮次，重试不恢复额度）。
- 差距：无声明文件内容哈希信任账本（失信重审机制无对应物）；"验收条目任何输出不能造成免检"无测试钉死（现结构上无免检通道，但属"无对象可免检"而非"有防线有测试"）。
- 归属：S5 第 2 包（与 A-9 同包）。
- 备注：作用点取决于 S5 定案的权限面形态（pi fork 无 settings 式 allow 规则引擎，tool_call 钩子 block 通道是现成拦截面）；参照 trust.ts 的 path→hash 账本在引入声明文件时同步落。

### B-5 失败预分类影子双跑 — **条件项未触发（C4）；规则分类底座已有**

- 现有实现：规则侧分类在位——cards/failures.ts `routeFailure`（:42）四型路由（瞬时故障→重试/缺输入→退回补卡/能力不足→改派拆卡/结果未知→查现场），纯数据结构；无模型同判、无 shadow 模式、无 jsonl 记录。
- 归属：C4（重试量足以观察分布才启动）；触发时参照三模式（off/shadow/jev）与规则 terminal 语义可对照现有路由直接落。

### B-6 仓库不自我提权（allow 整体忽略＋默认只收紧＋总是允许只写本地）— **未实现**

- 现有实现：无 restrictUntrustedProjectPermissions 类机制。pi fork 权限面盘点：`core/settings-manager.ts` 只有 global/project 两 scope 与项目信任门（:473-474 项目未信任不加载 project settings）；`core/project-trust.ts` 是"是否信任此项目文件夹"提示，不分级裁剪 allow；扩展层有 tool_call 钩子 block 通道与 ToolAnnotations 提示（core/extensions/types.ts:513 注明提示不可信、供权限扩展参考），无 settings 式 allow/defaultMode 规则引擎。
- 与 F 验收差距：三机制（allow 忽略并告警、defaultMode 只接受收紧方向、总是允许只写本地）全部无对象——当前 PAO 配方/仓库根本没有 allow 声明面可被利用，属"攻击面尚未存在"而非"已防护"。
- 归属：S5 第 2 包。
- 备注：S5 落地时先定 PAO 权限声明面长什么样（配方/项目配置/环境变量），再决定是抄参照的 restrict 函数还是把声明面直接设计成"只收紧"形状（后者更小，符合最小实现）。

## 给 S0 收编的登记建议

1. A-10 状态从"C5 待建"改登"已装（巡库启用），缺 realpath 判定，C5 触发时补第③条"——避免后续把它当空白重造。
2. A-3 缺口收窄为"桌面向导 IPC 骨架校验补深"一项，内核侧三边界复验即可。
3. A-7/A-8 的"部分"项在 S5 工作包冻结时，先定「参照四态/双层配方与现有成功-失败-取消-未知、单层节点」的映射或替换关系，避免双事实模型。
4. A-5 的桌面 HostUiRequest 通道（session-driver/pi-sdk-driver）登记为 S4 复用起点；A-6 在 S4 以实测窗口证据定"装闸/不装"。
5. B-1/B-5 维持未触发登记；B-2 触发时 memory/compaction-state.ts 快照可作检查点底座复用。

## 主要引用位置索引（file:line 截至 2026-10-07）

| 机制 | 位置 |
|---|---|
| A-1 缺口对照 | desktop canvas-query.ts:2；workboard-query.ts:1-10；streaming-ui-publisher.ts:13 |
| A-3 | workflow/recipe.ts:195/410-437/493；workflow/distill.ts:308-317；workflow/control.ts:106/172-177；cards/statemachine.ts:42；cards/deps.ts:24/61-76；desktop recipe-canvas-editor.tsx:167-189；desktop editor.ts:59/66；ipc/request-validation.ts:783；platform/pao/workflow-wizard-bridge.ts:165 |
| A-4 | worker/dispatch-core.ts:133/144-158/330；cards/receipts.ts:76；cards/statemachine.ts:81-116 |
| A-5 | desktop packages/session-driver/src/types.ts:287-320；pi-sdk-driver/session-supervisor.ts:235/696/1595 |
| A-6 | core/agent-session.ts:1431/1784/1922/1946/1966-1971 |
| A-7 | worker/receipt.ts:15/60/77/234-245；cards/receipts.ts:22/33/76；worker/dispatch-core.ts:51；cards/verifier.ts:31/78；cards/delivery.ts:141-162 |
| A-8 | worker/index.ts:153/225；worker/notify.ts:16；role.ts:39；host/host.ts:478-484；host/config.ts:30-33；workflow/auto.ts:8 |
| A-9 | knowledge/crystallize.ts:104；knowledge/gate.ts（补查门，非注入防线） |
| A-10 | patrol/shell-guard.ts:1-60（头注释即判定清单）；patrol/wire.ts:20/36-53；worker/dispatch-core.ts:246；test/pao/patrol-shell-guard*.test.ts |
| B-2 | memory/compaction-state.ts:20；pao/index.ts:23/117；core/compaction/compaction.ts:128/269 |
| B-3 | cards/types.ts:15；cards/failures.ts:35-40（仅"结果未知"分型） |
| B-4 | collab/review.ts:15-19；cards/verifier.ts:110/563；knowledge/gate.ts |
| B-5 | cards/failures.ts:42 |
| B-6 | core/settings-manager.ts:473-474；core/project-trust.ts（均非 allow 裁剪） |
