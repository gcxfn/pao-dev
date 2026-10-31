# PAO 行为映射与纯 PI-Desktop 插件接入评估

主控复核注：本报告为独立静态调查原稿，主要按专用collaboration路线判断。另一调查和主控已确认普通公开desktop.control会话接口可由常驻service使用，不能据专用spawn/send限制推断后台自动链必须改宿主；工作树也找到isolated:true的源码可达路线。最终结论与证据以[宿主评估的主控复核](PI-Desktop宿主评估.md)为准，以下原稿的未发现项不等于不存在。

## 结论

**条件可行，但当前不能承诺“PI-Desktop 是唯一执行宿主、零源码修改，并能无人值守地确定性完成全部 PAO 工作流”。**

把 PAO 业务代码、任务卡、工作流、验收、返修、后台服务和自有界面装入一个 PI-Desktop 插件，技术上可以做到，也不需要修改 PI-Desktop 或 pi 源码。CLI 可以继续保留，与桌面插件共用同一套 PAO 业务包；这里的“完全迁移桌面”不等于取消 CLI。

当前缺少的关键证据是自动接续：PI-Desktop 的 `spawn/send` 只能在活动 Agent 的工具调用中执行，子会话完成后只会生成一条回到来源 Session 的 `completion` 消息。现有公开证据能证明这条消息会进入来源 Session 的消息队列，不能证明后台 service 会因此再次获得工具调用身份并确定性地执行“验收、返修、回上级”。因此：

| 目标 | 当前结论 |
|---|---|
| PAO 业务和界面以插件发行，不修改宿主或 pi 源码 | 可行 |
| CLI 保留，桌面插件与 CLI 共用业务包 | 可行 |
| 有人在场、由模型选择下一步，或允许人工恢复的协作链 | 条件可行 |
| 无人值守、确定性、完整自动链 | 当前未证明，不能作为零修改可行结论交付 |
| 插件内嵌入旧 `MinisterHost`、`WorkerRunner`、pi SDK 或 RPC 执行服务 | 可做到零源码修改，但等于在插件内保留第二个执行宿主，维护代价仍然存在 |
| 正常退出前等待所有工作完成 | 当前公开生命周期契约不足 |
| 持久暂停、精确中断，重启后人工确认并恢复 | 可接受的重构方向 |

本次只评估、未实施。固定 PAO HEAD 为 `0236147ed7c8724d58f19934288ce6d468bf239f`，固定 PI-Desktop 为 `d2c9fc44087f24260521c66530c4f92c04790105`。未安装依赖，未启动模型、基准或宿主，未触碰正式 `PAO_HOME`，未修改源码、合并或提交。PAO 本地工作树有既有修改，本报告不把“工作树干净”作为证据，也不声称完成了全库审计。

## 证据分级

| 等级 | 本报告中的含义 | 代表证据 |
|---|---|---|
| 文档承诺 | PI-Desktop 文档明确写出、但本文没有做端到端运行验证 | 协作 API、生命周期、受信任扩展文档 |
| 已实现公开契约 | PI-Desktop 或 PAO 源码中存在真实入口和调用链，且属于可被外部宿主或插件使用的边界 | `plugin-runtime.ts`、`session-collaboration.ts`、Rust `host-core`、PAO 的 `index.ts`/`host.ts` |
| 内部接口 | 只适合参考或搬运行为，不能直接当作稳定插件依赖 | `electron/platform/pao/*`、`@pi-gui/pi-sdk-driver` |
| 未核实 | 只有文档名称、事件通知或设计推断，没有公开实现证据证明可满足 PAO | completion 自动再次执行 PAO 工具、跨任意项目 spawn、长排空窗口 |

## PAO 必须保留的核心事实

PAO 不是一组聊天提示词，而是一套带身份、历史和状态约束的任务系统。迁移时至少要保留下列事实；可以改变表和类的组织方式，不能把它们退化成“发一条消息再猜结果”。

| 核心需求 | 必须保留的事实 | 证据 |
|---|---|---|
| 真实身份 | 部门、项目根、脉络、真实 Session ID、任务卡、attempt；不能把消息 ID 当作工人身份 | `PAO/packages/coding-agent/src/pao/cards/types.ts:56-95`、`PAO/packages/coding-agent/src/pao/host/host.ts:852-981` |
| 卡片状态 | 待执行、执行中、待验收、通过、失败等状态；合法迁移、单写者、重试上限 | `PAO/packages/coding-agent/src/pao/cards/statemachine.ts:17-23,39-61,87-112` |
| 回执历史 | attempt、结果、证据、任务态、变更；旧尝试、迟到回执、重复终结必须留档 | `PAO/packages/coding-agent/src/pao/cards/types.ts:56-95`、`cards/receipts.ts:92-177` |
| 去重 | 同内容回执去重、待审派生、旧 attempt 与迟到回执区分 | `cards/receipts.ts:92-185` |
| 返修 | 原卡和历史保留；显式返修后，下一次真实启动才递增 attempt | `cards/rework.ts:1-52,74-94` |
| 验收 | 机械验收、命令安检、影子沙箱、执行根约束；不能只信模型自述 | `cards/verifier.ts:48-62,93-196,318-328` |
| 执行上下文 | 卡和 attempt 绑定执行根、工作树、输入快照与摘要 | `cards/execution-context.ts:11-40,348-369` |
| 工作流控制正本 | 冻结配方、实例、节点轮次、历史、回边、人工门、叫人去重、暂停、裁定 | `PAO/packages/coding-agent/src/pao/workflow/control.ts:68-88,111-200,626-669` |
| 主控到部长 | 回执定向送回绑定部长；部长审核、返修和自动链由 PAO 控制面驱动 | `workflow/host-bridge.ts:76-110,154-260,382-423` |
| 认领与停止 | 依赖门、基线、写锁、并发限制、精确 attempt 停止、停止证明 | `worker/dispatch-core.ts:425-474`、`worker/runner.ts:600-730` |
| 热会话与交接 | 部门/项目/脉络绑定部长；真实握手、任务注入、散场交接、树杀、失败保留登记 | `host/host.ts:852-981,1378-1478,1565-1637,1893-1896` |
| 暂停与恢复 | 未完成流写暂停，不自动重放中断工作；重新打开必须能对应原卡、attempt 和投递 | `workflow/host-bridge.ts:818-834`、`runtime/background.ts:59-106`、`runtime/index.ts:75-97` |
| 退出 | 先中止自动链、落暂停、停止部长和工人，并检查是否还有未停止登记 | `workflow/host-bridge.ts:818-834`、`host/host.ts:1565-1637` |

PAO 的入口虽然是扩展，但内部已经真实创建 `WorkerRunner`、`MinisterHost` 并观察活动。迁移不能只把入口文件改名，必须把这些依赖替换为明确的宿主适配层：

- `PAO/packages/coding-agent/src/pao/index.ts:134-176,253-258,324-327,360-405,529-549,623-625`
- `PAO/packages/coding-agent/src/pao/host/host.ts` 与 `worker/runner.ts` 继续承担原执行宿主职责时，属于“插件内第二宿主”，不是纯宿主复用。

## 最少宿主契约

要让一个纯插件承载 PAO，宿主至少需要提供下列能力。表中“当前状态”是本次源码和公开文档核对结果，不是对未公开能力的猜测。

| 最少契约 | PAO 需要的语义 | PI-Desktop 当前证据 | 状态 |
|---|---|---|---|
| 创建真实子 Session | 主控能创建部长，部长能创建工人；保留来源和层级 | `crates/host-core/src/session_collaboration/mod.rs:108-176`；继承父项目，父会话最多 4，单插件最多 16 | 已实现，但有层级和数量限制 |
| 发送持久消息 | 消息可排队、去重、定向到指定 Session；需要来源 turn/invocation | `docs/spec/07-plugins/03-plugin-api.md:809-880`；`session-collaboration.ts:116-170,271-314` | 已实现 |
| 查询与取结果 | 查询状态、列出子会话、读取完成结果 | 同一公开协作 API；`session-collaboration/mod.rs:35-106` | 已实现 |
| 精确取消 | 能取消指定 queued/running 投递或任务 | `session-collaboration.ts:173-190`；`session-collaboration/settlement.rs:137-205` | 已实现 |
| 幂等和内容冲突 | 同一业务投递重试不重复执行；不同内容复用同一键要报冲突 | `session-collaboration/mod.rs:35-106`、`session-collaboration.ts:116-170` | 已实现 |
| 完成回执 | 工人完成后把结果送回来源 Session，最多一次 | `session-collaboration.ts:193-236`；`settlement.rs:49-135` | 已实现，但结果取最后 assistant 文本，最多 12k |
| 工具调用身份 | `spawn/send` 必须绑定当前活动工具调用的 Session、turn、invocation | `plugin-runtime.ts:5611-5744`；`session-collaboration.ts:107-114` | 已实现，也是主要硬限制 |
| 后台确定性续跑 | service 收到完成事件后能获得可调用的 PAO 工具上下文，或直接安全推进工作流 | 公开文档和实现只证明 completion 是来源 Session 的 pending 消息；`session-collaboration.ts:193-236` | **未证明** |
| 项目目录 | 能把任务放到正确项目根/工作树，而不仅是继承父项目 | `session_collaboration/mod.rs:148-170`；`SpawnInput` 未看到任意执行根参数 | 受父 Session 项目限制 |
| 重启恢复 | 重启后 queued 保留，running/未入队投递变 interrupted，不自动重放 | `settlement.rs:137-205`；生命周期文档与安全文档 | 已实现，需由 PAO 显式映射 |
| 关闭排空 | 正常退出前等待所有任务、子进程和交接完成 | 生命周期总 teardown 约 3 秒后强杀；事件 30 秒；dispose 先取消 Agent work | **不足** |
| 插件界面与后台服务 | 自有 panel/view、后台 service、工具和命令 | 公开插件文档与插件运行时 | 可组织，但 panel/service 不能直接调用需要工具身份的 `spawn/send` |
| PAO 持久存储 | 保存卡片、attempt、投递映射、暂停和恢复账 | PAO 自有业务层 | 必须由插件自己承担 |

这里有一个重要限制：宿主的 `result` 是给上层继续聊天的短结果，不是 PAO 的结构化回执。PAO 必须自己持久化卡、attempt、证据和验收结果，不能把最多 12k 的最后 assistant 文本当作完整回执。

## 最短调用路线

```mermaid
flowchart LR
  A[主控 Agent 的活动工具调用] --> B[PAO 插件工具]
  B --> C[HostAdapter: spawn/send]
  C --> D[宿主持久投递与幂等账]
  D --> E[部长真实 Session/turn]
  E --> F[部长通过 PAO 工具派工人]
  F --> G[工人执行并写 PAO 卡与回执]
  G --> H[宿主 completion 回到来源 Session]
  H -. 仅证明成为 Session 消息 .-> I[部长验收/返修]
  I -. 无公开证据证明后台确定性续跑 .-> J[主控或上级验收]
```

可以确定的路线是：

1. 主控在活动工具调用中通过 PAO 工具发起投递。
2. 宿主验证 invocation，把消息写入持久投递账。
3. 部长获得真实 Session/turn。
4. 部长在它的活动工具调用中派工人；工人不能继续无限向下派发。
5. 工人完成后，宿主生成回到来源 Session 的 completion 消息。

不能从现有公开证据确定的是：

- completion 进入来源 Session 后，模型是否稳定调用正确的 PAO 验收工具。
- 后台 service 是否能直接取得新的活动工具身份，进而执行 `spawn/send`。
- completion 的“最多一次”与 PAO 的迟到回执、旧 attempt、重复终结语义如何无损对应。
- 一个主 Session 能否把工人派到任意另一个项目根，而不是只继承来源项目。

推荐为每次投递保存稳定业务键，并持久化：

```text
PAO owner/部门/项目/脉络
  <-> host Session ID
  <-> message ID / turn ID
  <-> card ID / attempt / delivery ID
```

`messageId` 和 `turnId` 只能作为宿主投递标识，不能替代 PAO 的工人身份或 attempt。

## PI-Desktop 公开契约与硬缺口

### 已实现的协作能力

- 公开操作包括 `spawn`、`send`、`list`、`status`、`result`、`cancel`：
  `docs/spec/07-plugins/03-plugin-api.md:809-880`。
- 当前 Agent 的工具调用期间才能 `spawn/send`，宿主会注入来源 Session、turn 和 invocation：
  `docs/spec/07-plugins/03-plugin-api.md:809-880`、`plugin-runtime.ts:5611-5744`。
- 没有活动工具调用时，`spawn/send` 会被拒绝：
  `session-collaboration.ts:107-114`。
- 面板只能取消本插件自己的投递；service、panel 或没有工具上下文的调用不能直接 `spawn/send`：
  `docs/spec/07-plugins/13-plugin-permissions-matrix.md:43`、
  `docs/spec/07-plugins/04-plugin-security.md:41-46,66-85`。
- 宿主对子 Session 设有父会话最多 4、单插件最多 16 的并发限制，并禁止工人继续 spawn：
  `crates/host-core/src/session_collaboration/mod.rs:108-176`。

### 不能把 completion 当作确定性回调

`session-collaboration.ts:193-236` 证明 completion 会作为来源 Session 的 pending 消息被 drain；`settlement.rs:49-135` 证明结果最多提交一次，并取最后 assistant 文本。公开文档没有给出“完成事件触发插件 service 回调”或“service 获得工具 invocation”的契约。

`pi.sendUserMessage` 是公开的当前 Session 消息队列入口：

- `docs/spec/07-plugins/16-trusted-extensions.md:282-287`
- `packages/agent-runtime/src/runtime.ts:2990-3008`

它可以向当前 Session 入队消息，但不能替代跨 Session `spawn/send` 的来源工具身份。`turn_end`、`agent_end` 等通知事件有 30 秒预算，也没有证明可直接获得某个活动工具调用的 invocation。

因此，模型驱动、有人在场或允许人工恢复的协作可以按条件成立；无人值守的确定性自动链必须保留为未证明缺口，不能写成已经实现。

### 目录和身份限制

`spawn` 实际创建新 Session 时主要继承父 `project_path`、thinking 和 permission，公开 `SpawnInput` 没有看到任意项目根或执行根参数：`crates/host-core/src/session_collaboration/mod.rs:148-170`。所以：

- 跨项目任务应从对应项目的来源 Session 发起。
- 不能假定一个主 Session 能 `spawn` 到任意项目目录。
- 若要求一个主控跨项目自由派发，当前要么在项目来源 Session 侧建立桥，要么保留插件内第二执行宿主。

## 关闭、暂停和恢复

用户补充的文档证据和实现证据一致：`docs/spec/07-plugins/05-plugin-lifecycle.md:44` 说明普通 `onUnload` 名义预算为 5 秒、退出为 1.5 秒；同文件 `68-77` 说明 service stop 先于 `onUnload`；`100-122` 说明全部插件 teardown 总预算为 3 秒，之后强杀。实现对应位置为：

- `apps/desktop/electron/main/plugin-runtime.ts:651-662,2233-2260,2328-2351,4188-4205`
- `docs/spec/07-plugins/16-trusted-extensions.md:369-399`

事件回调有 30 秒预算；dispose 会先取消 Agent work。直接使用 Node `spawn` 启动的子进程不在 SDK 进程组清理保证内。因此不能把 `onUnload` 当作现有 PAO 的“关闭排空”：

| 关闭模式 | 评估 |
|---|---|
| 持久暂停后恢复 | 可接受：预算内停止接新工作，持久化 paused/interrupted、精确取消、必要时强停；重启核对映射后由用户显式恢复 |
| 退出前等待全部工作完成 | 当前公开生命周期不足：没有找到长预算 quiesce/drain 接口，3 秒总 teardown 不能证明部长/工人进程树、交接和未停止登记都完成 |

现有 PAO 的关闭路径先中止自动链并写入暂停，然后 `stopAll`，最后还检查 `host.list()` 是否为空：`workflow/host-bridge.ts:818-834`。部长散场还会写交接、树杀并保留失败登记：`host/host.ts:1565-1637`。这些都是必须在插件业务层或新的宿主公开契约中重新证明的行为。

另外，现有桌面流控注释已经说明“暂停”只停止后续推进，不停止在途 worker：`desktop/apps/desktop/electron/platform/pao/flow-control-query.ts:80-94`。PAO 插件若只调用暂停，不能声称所有工作已经停止。

## 桌面机制复用清单

这一节只列本子代理已读取的桌面业务模块概览，不代替主控的 UI 审查。

### 可由 PI-Desktop 通用宿主承担

| 机制 | 插件方案 |
|---|---|
| Electron 外壳、窗口、聊天、模型设置、项目和工作树、通知、更新 | 复用 PI-Desktop 宿主；插件不重复实现 |
| 通用持久 Agent Session、turn 队列、取消和重启中断 | 复用公开宿主契约 |
| 通用 Session 投递、幂等、定向 completion、状态和结果 | 复用公开协作 API，但必须加 PAO 业务映射 |
| 自有 panel/view、后台 service、工具和命令 | 使用插件公开扩展面；panel/service 只能查看或取消，不能凭面板身份发起需要工具上下文的 `spawn/send` |

### PAO 专属必须保留

| PAO 机制 | 不能省略的原因 |
|---|---|
| 卡、attempt、回执、机械验收、返修 | 宿主 Session 和最后文本不具备 PAO 的状态与证据语义 |
| 工作流控制正本、节点轮次、回边、人工门、叫人去重、审计 | 这是 PAO 工作流的状态源，不应塞进聊天消息 |
| 部门配方、预算和档位、执行绑定 | 属于 PAO 业务配置 |
| PAO_HOME、项目 `.pao` 正本 | 运行数据与开发源码分离 |
| 看板、画布、临时计划等业务读模型 | 可以从通用 UI 重画，但业务聚合和权限不能交给宿主猜 |
| 身份映射与恢复账 | 用于 Session/message/turn 与卡/attempt 的跨重启对应 |

### 已读 desktop 模块：可借鉴但不能当公开契约

下列路径位于 `desktop/apps/desktop/electron/platform/pao/`，主要是现有桌面对 PAO 的内部适配层。插件可以重写其公开行为或把查询结果转成自己的 panel/view，但不能把导入内部驱动当作稳定的 PI-Desktop 插件接口。

| 现有模块 | 已读职责 | 纯插件处理 |
|---|---|---|
| `pao-home.ts:1-8,34-60,66-123` | PAO_HOME 配置注入、便携默认目录 | 改成插件自己的存储配置和路径适配 |
| `canvas-query.ts:1-9,47-82,888-930` | 画布、节点详情、运行态只读聚合；动态调用内部 `@pi-gui/pi-sdk-driver` | 保留业务读模型，移除对内部驱动的直接依赖 |
| `flow-control-query.ts:1-17,80-94,201-245` | 工作流控制读面、确认/暂停/恢复；暂停只停后续推进 | 保留 PAO 控制语义，不能把暂停误写成全停止 |
| `kanban-query.ts:1-9,59-202,206-224` | 看板投影 | 改成插件只读查询或隔离 panel |
| `kanban-ops.ts:1-13,47-90` | 用户取消，实际委托 PAO 卡状态机 | 保留卡状态机，UI 只提交业务动作 |
| `workboard-query.ts:1-9,159-190` | 部门、挂起实例、异常、待办聚合 | 保留聚合读面 |
| `workflow-wizard-bridge.ts:1-9,215-280` | 目录、预检、模板、配方、启动、档位操作 | 改成插件命令或工具，不依赖内部 bridge |
| `temporary-plans-query.ts:522+` | 临时计划读面 | 保留业务读模型，接口由插件提供 |
| `ephemeral-sweep.ts:28-55` | 临时 owner 清理 | 改成显式恢复/清理任务 |
| `session-lock-owner.ts:1-103` | 残留锁 owner 只读信息 | 保留可观察信息 |
| `session-lock-cleanup.ts:1-100` | 死进程锁回收 | 作为插件自有安全操作，需重新验证宿主进程边界 |

这些模块能提供业务语义参考，不证明它们能作为插件依赖。尤其是 `@pi-gui/pi-sdk-driver`，本报告没有把它认定为稳定公开接口。

## 最简单的纯插件结构

```text
PAO 插件
├─ manifest
├─ agent extension
│  ├─ PAO 工具入口
│  └─ Session/turn 事件适配
├─ background service
│  └─ 恢复扫描、到期监督、通知
├─ isolated panel/view
│  └─ 看板、画布、工作流状态
├─ PAO 业务包
│  ├─ 卡与 attempt
│  ├─ 回执、验收、返修
│  ├─ 工作流控制正本
│  ├─ 部门、预算
│  └─ 业务读模型
├─ HostAdapter
│  ├─ spawn/send/status/result/cancel
│  ├─ sendUserMessage
│  └─ Session/message/turn 映射
└─ 持久存储
   ├─ PAO_HOME 配置
   └─ 项目 `.pao` 任务正本
```

这个结构的好处是：PAO 业务包与宿主无关，CLI 和桌面插件可以共用；桌面宿主提供通用会话和界面；插件只需要维护 PAO 专属状态与一层适配。

### 可确定复用的部分

- PI-Desktop 的通用外壳、模型、项目、Session、通知和窗口能力。
- 公开协作 API 的消息排队、幂等、定向投递、状态、结果和取消。
- 插件自有 panel/view、后台 service、工具和命令。

### 不能确定的边界

- 后台 service 如何获得新的工具 invocation。
- completion 能否在不依赖模型自由选择的情况下驱动下一条 PAO 工具。
- 3 秒总 teardown 内能否证明所有插件子进程和交接都停止。
- interrupted delivery 如何无损映射回原卡、attempt，并由用户显式恢复。
- 跨项目 spawn 是否存在未找到的公开替代入口；当前只能从对应项目父 Session 发起或保留第二宿主。

### 不接受的伪零修改

以下做法即使“不改 PI-Desktop 源码”，也不满足用户要求的公开接口零修改方案：

- 插件偷偷嵌入完整旧宿主或第二套执行服务，却不披露维护责任。
- 导入未公开内部模块作为稳定插件依赖。
- 修改 `node_modules`。
- 猴补丁或运行时注入宿主内部对象。

若选择嵌入旧 `MinisterHost`、`WorkerRunner`、pi SDK 或 RPC 执行服务，应明确标为“零源码修改、第二宿主方案”。它保留模型会话、进程树、取消、恢复、锁和用量账，仍需独立维护。

## 条件成立与硬缺口

### 条件成立

1. 桌面只迁移业务、数据和界面，CLI 继续存在，双方共用 PAO 业务包。
2. 协作链允许模型选择下一步、人工确认或人工恢复，不要求后台 service 获得隐藏工具身份。
3. 跨项目任务从对应项目的来源 Session 发起。
4. PAO 自己持久化卡、attempt、回执、投递映射和恢复账。
5. 退出语义改成“持久暂停后恢复”，接受强停后核对，而不是承诺退出前完成全部工作。

### 当前零修改硬缺口

1. **确定性自动续跑未证明**：completion 只证明会回到来源 Session，不证明能触发后台 PAO service 的安全回调。
2. **长关闭排空不存在于公开契约**：`onUnload` 不能等同现有 PAO 的完整排空。
3. **任意项目根 spawn 未证明**：子 Session 继承父项目，公开输入没有看到执行根参数。
4. **后台 service 与 panel 无工具身份**：不能在 service/panel 中直接调用需要 invocation 的 `spawn/send`。
5. **宿主结果不是完整回执**：completion 结果短且有上限，必须由 PAO 自己保留结构化证据。

### 可接受的重构

- 把主控入口改成来源 Session 上的 PAO agent extension 或工具。
- 用 `HostAdapter` 替换直接创建部长/工人的内部宿主调用。
- 用 PAO 自己的 durable ledger 保存 Session/message/turn 与卡/attempt 的映射。
- 把桌面内部查询、向导、看板包装改成插件只读查询、命令或隔离 panel。
- 把后台 service 限制为恢复扫描、监督、通知和业务查询；需要发消息时回到有工具上下文的主控入口。
- 把关闭设计成可恢复暂停，并把“完成全部任务”改成需要更长公开排空接口的后续条件。

## 否证点

- `docs/spec/07-plugins/16-trusted-extensions.md:282-287` 显示旧的 `sendMessage`、`sessionManager` 类能力在受信任扩展中不是当前可靠入口；延迟或不支持的接口不能用来证明完整迁移。
- `session-collaboration.ts:107-114` 直接拒绝无活动工具调用时的 `spawn/send`。
- `session_collaboration/mod.rs:148-170` 显示子 Session 主要继承父项目，没有看到任意项目根参数。
- `session-collaboration.ts:193-236` 显示 completion 是 Session pending 消息，不是 service 回调。
- `docs/spec/07-plugins/05-plugin-lifecycle.md:44,68-77,100-122` 显示 teardown 总预算不足以承担现有 PAO 的完整排空。
- `docs/spec/07-plugins/16-trusted-extensions.md:369-399` 显示事件有 30 秒预算，dispose 会先取消 Agent work；直接 Node 子进程不在宿主进程组清理保证内。

## 未核实项

以下项目本次没有做端到端运行或进一步扩展搜索，不能写成已验证：

- completion 回到来源 Session 后，模型是否稳定调用正确的 PAO 验收/返修工具。
- 是否存在只供内部使用的完成回调，能让后台 service 直接推进工作流；公开文档中未找到。
- interrupted delivery 与 PAO attempt 的完整重启恢复映射。
- 3 秒总 teardown 内能否证明插件启动的所有 Node 子进程树都停止。
- `@pi-gui/pi-sdk-driver` 是否能作为稳定的插件依赖；本报告不承认它是公开契约。
- 跨项目 spawn 是否有未公开但可公开申请的替代入口。
- 真实 UI 页面是否能完全替换为插件 panel/view；本子代理只确认插件自有界面方向，不代替主控 UI 审读。

## 调查限制与工具情况

- 这是源码和文档审查，不是模型、宿主、基准或真实工作流的集成运行。
- 未重建代码图；报告基于本轮已读源码、文档和调用链。
- 一次非关键 shell 循环因语法问题没有输出文件内容，随后用直接逐文件读取补齐了相关证据。
- 一次 bash 命令误用 PowerShell 的 `$ErrorActionPreference`，报 `=Stop: command not found`，没有产生文件修改。
- sparse checkout 缺文件时使用 `git show HEAD:path` 只读查看。
