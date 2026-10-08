# 合并审核：S7-B 看板操作侧（54928e0）＋ 桌面小修批（4cff4e4）

- 日期：2026-10-08。审核者：对抗式审核子代理（S9 前置波审·合并波次审）。
- 方法：锚定提交审核——桌面侧全部读 `git show 4cff4e4` / `git show 54928e0`（不信工作树）；内核侧只读 `git show c0787c704:...`（PAO 仓 S9 改名中）。只读任务，未改任何源码、未跑改状态操作。
- 抽验比例：S7-B 21 文件实读 12 个核心面（操作桥全链、拖放判定、租约查询/芯片、批量循环、三件套、driver 两件、4 个单测 spec 全文、e2e 4 条全文）≈57%；小修批 4 文件全读 100%。留档 log 抽验 14 份（下文逐一点名）。

## 结论：放行（两包）

P0＝0，P1＝0，P2＝3，P3＝4。事实核对全对上（落点行号、门数字、红→绿证据无一虚报）；S7-B 操作桥安全面闭环成立；小修批三件逐点核等价/合法成立；四条红线全过。唯一保留：S7-B 新 e2e 2 红（:658/:748）的归因（spec 写作缺陷）经独立复核**可信但未实验室复现**，收尾卡复跑即确认点——若复跑翻案（证明产品行为问题），本结论升级为打回该两例覆盖面。

## 一、事实核对（抽查 vs 记录）

| 记录声称 | 实比 | 结果 |
|---|---|---|
| S7-B request-validation.ts:886 expectKanbanCardOpInput | :886 原文在 | ✓ |
| S7-B preload.ts:220-221、register-desktop-ipc.ts:332-339、ipc.ts 通道 :310/API :1015 | 逐一到 | ✓ |
| S7-B kanban-query.ts:107-117 代数取大 | :107-117 原文在 | ✓ |
| S7-B kanban-page.tsx:71 Set→Map、workboard-page.tsx:297 映回原路径 | :71 / :293-299 在 | ✓ |
| S7-B desktop.ts:505 仅一行标注、零新增 git 调用 | diff 确为单行文案 | ✓ |
| 小修批 canvas-page.tsx:134 守卫、:635-652 调用点、spec.ts:338-350 夹具 | 逐一到 | ✓ |
| 小修批 session-supervisor.ts:1190-1230＋:1089-1096＋:1257-1264 | 三处行号全中 | ✓ |
| 门数字：定向 47/47、全量 583过/15败、件一 4/4、件二 47/47、件三 201/200/1、批二 tsc 双0、批二 kanban 6过/2红、批二 workflow-instance 4/4 | log 逐一实读 | ✓（log 名见证据链） |

## 二、S7-B 对抗面逐项

1. **输入校验闭环（双面核）**：renderer 类型面（KanbanCardAction 仅「取消」）→ preload 透传 → mainFrameHandler 先验 sender 主框架（main-frame-ipc.ts:22-40，扩展 iframe 拒）→ expectKanbanCardOpInput 重建对象丢多余字段＋action 白名单＋cardNumber 非负安全整数＋cardPath ≤4096/拒 NUL → 执行器内再断言 action。渲染层传任意 action 在入口即 TypeError（单测 ipc-request-validation.spec 有「已交付」「进行中」负例）。**闭环成立**。
2. **路径越界**：resolveExistingWorkspacePath（workspace-paths.ts）＝resolve＋assertInsideWorkspace＋双 realpath（symbolic link 逃逸也拒）；执行器再卡文件名「卡NNNN-*.md」格式且卡号与提交卡号一致，不一致/缺文件均不触内核（单测 kernelTouched=false 断言）。**成立**。
3. **白名单绕道**：preload 只暴露 kanbanCardOp 一个口，无泛化 invoke；UI 全部入口（拖放/批量条/右键）只提交「取消」；主进程校验不信任类型。内核侧最深处单写者＋迁移白名单（statemachine.ts checkTransition/checkWriterAuthority 锚定读实比：用户取消含无主卡放行、终态无出边、非 owner 写拒）。**无绕道**。
4. **拖放判定 vs 内核状态机**：kanbanDropAction（kanban-command.ts:19）＝非终态拖「取消」执行、拖「已交付」点名验收链拒、其余拒、终态拒；与内核 ALLOWED_TRANSITIONS（待认领/进行中/失败→取消；已交付/取消无出边）**逐状态一致**，单测五状态全枚举。
5. **租约代数取大**：normalizeKanban 按 卡路径 聚合，`generationOf(entry) >= generationOf(existing)` —— 最大代数赢、同代保持后到者、缺失代数视为 -1 不覆盖带代数行。单测含最坏到达序（新代在前/旧行后到不赢）＋双旧代行后到者。真内核 registry 注入 e2e 因 spec 缺陷红（见 P2-1），产品面由单测覆盖。**语义正确**。
6. **批量失败中断语义**：runCancel 逐卡 await 串行、失败不中断（继续下一张）、逐项 ok/message 收集、终了清选区＋onRefresh 重读权威。半成功半失败时 UI 回执逐项如实（e2e :613 断言 data-ok=1/1 各一＋失败行含「不允许的状态迁移」＋乙卡换列/丙卡原列）。**一致**。P3 级注：批量执行中无逐卡进度（全部完成才出回执），长批量体感空白，非正确性问题。
7. **权限面探针**：内核入口探针.log 三断言（用户取消成功/终态再取消 INVALID_TRANSITION/用户→已交付 FORBIDDEN_WRITER）实读在案，与内核锚定源码行为一致。

## 三、小修批对抗面逐项

1. **件一夹具合法性**：改后路径 待认领→进行中（主控认领，applyOwnerOnClaim 置 owner=主控）→（目标非进行中时）进行中→已交付/失败（operator=owner 合法；失败带 瞬时故障）。对照锚定 statemachine 迁移表**合法**；改前红 log（INVALID_TRANSITION 待认领→已交付）与批二 :379 真绿（4/4）闭环。
2. **件二守卫对称性**：pullCanvasAfterStart 提取逐字忠实（含 0/多匹配文案、S4-1 唯一性、tab 构造）；catch 守卫 `requestId.current !== currentRequest` 与 refresh 版（同文件 :447）**同款同位**；finally 守卫保持。红（迟到失败覆写 errors）→绿（47/47 含不误伤对照）＋bug5 真机回归 2/2 绿。
3. **件三五处参数化等价（逐点）**：① deliverAs 源（参数化）② entry 时间源（record.updatedAt vs nowIso，留在调用点构造 entry）③ 步内 isStreaming 复查（recheckStreaming 旗标；忙转原版无复查＝false 正确）④ closed 错误形态（finished() vs Session closed）⑤ 尾随 startQueuedMessageWhenIdle 留在忙转调用点。另核：queued=true 均在 queuePrompt 成功后、回滚 filter 同、persist/emit 失败仅告警同、原版 sendCheckedMessage 分支的前置 `!session.isStreaming` 预检保留在调用点。**等价成立**。

## 四、红线核查

- IPC 三件套：通道名 `pi-gui:kanban-card-op` 唯一无冲突，契约/preload/注册三处同批同源，序列化走既有 expectXxx 重建口径。✓
- 卡协议中文键：全 diff 无改名字段；PaoCardStatusChangeInput（操作者/依据/时间/失败类型）与内核 StatusChangeInput 锚定同源，只新增不改动。✓
- kill.ts / recipe-canvas-editor / tabSelectionRef：两提交文件清单均不含。✓
- S7-B 未擅改内核：桌面提交无内核仓路径；driver pao-card-ops.ts 只动态加载 dist 并白名单暴露 readCard/changeCardStatus 两函数；批二纪律记录实证 PAO dist mtime 跑前跑后未动。✓

## 五、ponytail review（54928e0＋4cff4e4 全 diff）

1. `apps/desktop/electron/platform/pao/kanban-ops.ts:L33-38`: reuse: 本地 cardNumberFromFileName 重实现内核已导出同名函数（cards/index.js，同一加载点已在手；内核 regex `/^卡0*(\d+)-/` 不要求 .md，桌面版更严）。替换：经 PaoCardOpsModule 多暴露一个纯函数（加载点现成），或接受漂移并登记差异理由。
2. `apps/desktop/electron/ipc/request-validation.ts:L886`＋`kanban-ops.ts:L58`: shrink: 「取消」字面量在两处运行时硬编码，KANBAN_CARD_ACTIONS 常量运行时无人消费（仅类型派生）。替换：校验与断言改 `KANBAN_CARD_ACTIONS.includes()`，白名单单一事实源。
3. `packages/pi-sdk-driver/src/session-supervisor.ts:L1196-1200`: reuse: helper options 内联 images 元素形状与同文件 SessionMessageInput（:2457）重复。替换：`NonNullable<SessionMessageInput["images"]>`。
4. `apps/desktop/src/workboard/workboard-page.tsx:L350`＋`kanban-page.tsx:L141`: reuse: 同款 pathKey 两文件各一份（782c706 已存在的旧重复，本批第二次消费把它坐实）。替换：提为共享导出（如 kanban-command.ts）。

加分项（不是问题，登记防误伤）：动作白名单收窄＋拒绝预建身份模型＝正确 yagni 反向操作；拖放用原生 HTML5 事件零新依赖；formatCardNumber 桌面平行实现（kanban-command.ts:38）因渲染层不可达内核可接受，漂移风险随 1 号项一并登记。小修批无可剪——件三是净删 30 行、pullCanvasAfterStart 11 参对象是无 DOM 单测环境的最小测试缝（resolveEditorEntry 先例）。

net: -10 lines possible.

## 六、分级清单

### P0（阻断）
无。

### P1（放行前修）
无。

### P2（后续包）
1. **kanban-board.spec.ts :658/:748 两条新 e2e 修复＋复跑**（收尾卡已立，应作为 S7-B 包关闭的必要门）：:658＝Windows 反斜杠路径直塞 CSS 属性选择器被转义吞（改 testid＋hasText＋getAttribute 值比对或 CSS 转义）；:748＝electronApp.evaluate 上下文不支持 ESM 动态 import（改 require 已加载模块或预置注入道）。在收尾卡落地前，拖放全链与租约接管呈现两条产品流**只有单测覆盖、无 e2e 覆盖**。本审核对两条归因独立复核为可信（:658 有同值 getAttribute 命中而选择器不匹配的旁证＋:613/:711 同 fixture 全过；:748 与 Playwright evaluate 的 vm 限制相符），但两脚本（check-css-escape*.mjs）未得出结论性复现——复跑翻案即升级打回。
2. **卡号格式函数漂移登记**（随收尾卡或独立一行登记）：内核 cardNumberFromFileName/formatCardNumber 在桌面两处平行实现（ponytail 1 号＋formatCardNumber），卡命名规则演进时须同步。
3. **session-lease:31（T00 既有）**：维持批二建议，并入控制域专卡，dump lease 内容定位写入者主体；两包无罪（早于两包三天，复跑同红确定性）。

### P3（记录订正）
1. S7-B 实施记录§三与提交信息「未知/缺字段 → 明确『租约状态未知』提示」与代码不符：实际＝缺字段不出芯片；到期时间不可解析＝按原值以「租约至 X」展示（state=active，不推断已到期）；「未知」芯片实指活性信号（kanban-activity.ts 信号 unknown）。订正为「未知＝活性信号芯片；租约字段残缺按原值展示不推断」。
2. S7-B 实施记录门表「红：操作桥单测 3 败 exit 1」：红灯-单测-操作桥.log 实为 spec 整文件导入失败（Cannot find module kanban-ops → No tests found，EXIT=1），非 3 例计数败。实质（模块未建时红）成立，数字口径订正。
3. 批量执行期间无逐卡进度反馈（全部完成才出回执列表），长批量体验空白——登记给后续 UI 打磨，不构成本包问题。
4. expectKanbanCardOpInput 的 reason 走 expectString（允许空串），空串会以「依据: 」落卡正文——无害但与「非空」直觉不符，可顺手收非空（与该函数其余字段口径一致）。

## 七、证据链

- 提交：desktop `4cff4e405252a5a38814ae5962899db6b8f0131b`、`54928e05286ae0addb8b6a2d66910740e955ad52`；内核锚定 `git show c0787c704:packages/coding-agent/src/pao/cards/{statemachine,cardfile,counter}.ts`。
- S7-B log（.pao/统一执行-20261007/S7-B包/）：红灯-单测-操作桥.log（导入失败 EXIT=1）、红灯-单测-旧代+拖放+校验.log（3败/25过）、证据/绿灯-单测.log（47/47）、证据/全量单测-对照.log（583过/15败/3跳，失败清单与本包零重叠）、证据/绿灯-单测-格式化后.log（583/15 同清单）、证据/内核入口探针.log（3 断言）、证据/绿灯-tsc双config.log、证据/绿灯-架构检查.log、证据/绿灯-driver-tsc.log。
- 小修批 log（桌面小修批/证据/）：红灯-件一-改前原样跑.log（:369 INVALID_TRANSITION 1败）、绿灯-件一-spec全量.log（4/4）、红灯-件二-守卫用例改前.log（1败）、绿灯-件二-canvas-spec全量.log（47/47）、件三-driver全套-带PAO_HOME.log（201/200/1＝「强杀父进程」既有负载例）、门-tsc双config.log、门-tsc-electron-config-单独.log、门-check-architecture.log。
- 批二（桌面门补跑批二/）：01-build-根build.log（绿）、02-tsc-双config.log（双0）、03-e2e-组A-kanban-board.log（6过/2红）＋03b-复跑（同红确定性）、04-e2e-组B-workflow-instance.log（4/4，:379 真绿）、05/06/07 号 log（基线红同位同签名）、08-e2e-组E-bug5-reactivation.log（2/2 绿）。
- 关键 file:line：request-validation.ts:886、register-desktop-ipc.ts:332-339、preload.ts:220、main-frame-ipc.ts:22、kanban-ops.ts（执行器全文）、workspace-paths.ts:18-35、kanban-query.ts:107-117、kanban-command.ts:19、kanban-board.tsx:144-167（runCancel）/420-428（菜单门控）/630-694（ActivityChip）、kanban-page.tsx:71/80、workboard-page.tsx:293-299、canvas-page.tsx:134/447、session-supervisor.ts:1190/1089/1257、pao-card-ops.ts、desktop.ts:505。
