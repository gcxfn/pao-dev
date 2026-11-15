# W 来源（工作流与看板形态重构需求）逐项核对

截至 2026-10-07。只读调查，未修改任何源文件。

## 调查方法

1. 读 W 正本 `plans/未完成/2026-10-05-工作流与看板形态重构需求.md` 全文，提取全部条目。
2. 读历史证据：`.pao/工作流重构-20261005/交付报告.md`（含 2026-10-05 追加、收尾检查点等全部末尾段落，共 98 行）；`.pao/整体重构-20261005/交付报告.md` 中画布/看板相关行；统一计划第 5 节阶段表（S2 画布基础、S3 属性标签、S4 主控、S5-S6 运行、S7 看板）。
3. 逐条 grep/读源码核实当前工作区（含未提交修改，不用 HEAD 判断）。主要文件：
   - 桌面：`desktop/apps/desktop/src/features/canvas/`（canvas-page.tsx、canvas-model.ts、recipe-canvas-editor.tsx、workflow-editor.tsx、recipe-library.tsx、workflow-tabs.tsx、instance-workflow-view.tsx、workflow-runtime-controls.tsx、workflow-wizard.tsx）、`src/features/workboard/kanban-board.tsx`、`src/features/conversation/embedded-chat.tsx`、`src/app/App.tsx`、`contracts/desktop-state.ts`、`contracts/i18n-zh.ts`、`contracts/i18n-en.ts`、`electron/application/workflow-tabs.ts`、`electron/platform/pao/`（canvas-query.ts、workflow-wizard-bridge.ts、kanban-query.ts、workboard-query.ts）、`electron/windows/workflow-leave-guard.ts`
   - 内核：`PAO/packages/coding-agent/src/pao/workflow/`（recipe.ts、tools.ts、auto.ts、control.ts）、`pao/desktop/`（canvas.ts、editor.ts）、`pao/cards/`（statemachine.ts、deps.ts）、`pao/runtime/`（session-lock.ts、index.ts）

状态口径：**已实现**（代码在位且有历史验证）/ **部分**（有实现但有明确缺口）/ **未实现**（源码无痕迹）。

## 一、四区布局与产品语义表（W §二）

| 条目 | 实现位置 | 历史证据 | 当前缺口 | 阶段 |
|---|---|---|---|---|
| 顶部标签＝一个工作流工作空间、`+` 建空白 | workflow-tabs.tsx:22-55；canvas-page.tsx:286-313（新建）、184-208（开标签）；electron/application/workflow-tabs.ts（对账）；contracts/desktop-state.ts:428-447（持久化契约） | 报告"标签与独立主控重开真实 Electron 37.8s 通过；重启恢复标签与绑定" | **预设工作流常驻**无实现痕迹 | S3 |
| 配方库：搜索/全部/我的/模板/最近、点击立即加载、可折叠 | recipe-library.tsx:19-26（四筛选）、243-249（搜索）、117（点击 onSelect）；canvas-page.tsx:184-208（选中即开标签加载）、775-796（折叠/展开） | 报告"配方库可折叠…四筛选页签真实 Electron 2 passed" | 搜索范围=名称/节点/部门，无"关键词"全文 | S3 复验 |
| 画布：自由坐标/拖动节点/手动连线/增删节点/缩放/Fit/MiniMap | workflow-editor.tsx:133-169（ReactFlow+MiniMap+Controls+fitView）、144-154（拖动存坐标）；recipe-canvas-editor.tsx:410-435（添加节点）、363-399（连线）、717-749（删节点）、803-827（删连线） | 报告阶段1"拖动、连线、缩放与撑满布局…坐标与连线真实 Electron 42.6s" | 无 | S2 复验 |
| 框选多选 | workflow-editor.tsx:159（selectionOnDrag） | — | 仅多选拖动位置，无批量操作语义 | S2 |
| 自动整理（非强制分层） | recipe-canvas-editor.tsx:460-467（清 positions 回默认布局按钮）；canvas-model.ts:86-153（默认分层兜底） | 报告"提供拖动、依赖连线、缩放、小地图、保存、放弃、自动整理" | 无 | S2 |
| 保存/另存为/放弃＋标签 ● dirty | recipe-canvas-editor.tsx:312-362（保存/放弃）、469-489（另存为）、405-408（●未保存/已保存）；workflow-tabs.tsx:36（标签 ●） | 报告"原保存、另存与新建真实 Electron 35.8s" | 示意图的"已保存＋时间戳"两态无时间戳 | S3 |
| 右侧 Inspector 三分支（工作流/节点/连线） | recipe-canvas-editor.tsx:518-865：节点=名字/部门/目标/验收/模型/思考/人工确认/审核节点(v2)＋部门标准/技能/回边（上限、超限动作）；连线=依赖说明/审核回退上限/超限动作/删除；工作流=名称(新建时)/适用场景/自动执行 | 报告"右侧属性栏接入部门、任务目标、验收要求、模型、思考强度、技能和人工确认…审核回边显示为虚线…可编辑回退上限与超限动作" | Prompt/Inputs/Outputs/Retry/Timeout/执行条件未提供＝符合"前置4 只显示已接通"定案，不算缺口 | S3 复验 |
| 底部主控对话：内嵌新建对话、可折叠、可拖高度 | canvas-page.tsx:316-317、634-644（纵向 Group＋Panel＋Separator）；embedded-chat.tsx:10-65（折叠/展开）；canvas-surface.tsx:57-72（onCreateController 新建会话绑定标签） | 报告"内嵌主控草稿真实 Electron 39.1s；甲/乙草稿互不串、折叠/展开保持、重启保留"；"每个配方建立新的项目主控会话…不借用随意选中的普通会话" | 发送/流式/工具执行未真实 provider 验证（报告明示，需授权） | S4 |
| 启动＝当前配方生成不可变快照再启动 | 内核 workflow/control.ts:270（冻结配方落盘）；desktop/canvas.ts:207-213（readControl 验证冻结图）；workflow-wizard-bridge.ts:305-330（启动需已保存 revision） | 报告"画布桥经 readControl 读取 v2 冻结图"；"冻结实例只读图真实 Electron 37.4s" | 无 | S2/S6 复验 |
| 运行态：画布位置不变、锁定编辑、六态着色 | instance-workflow-view.tsx:100-127（只读 readOnly＋冻结图）；canvas-model.ts:36-48（六态着色）；workflow-editor.tsx:155-159（readOnly 锁拖动/连线） | 同上 37.4s＋"冻结坐标、只读拖动/连线锁定…通过" | 无 | S2 |
| 右侧运行态：实例信息/当前节点/输入/输出/日志/错误/耗时/Token | node-runtime-details.tsx＋canvas-page.tsx:1050-1150（D8d 模板vs卡面/回执轮次/升档理由/执行锚点）；内核 desktop/canvas.ts:472-560 | 报告"运行详情已补接真实可选字段…缺数据显示未记录，不补零。数据层 16/16" | 多卡节点只显示首卡（内核 canvas.ts:494-496 明示错误"其余卡须在看板查看"）——S7 需补全卡 | S7 |
| 主控对话（运行态）可停止实例 | —（workflow-runtime-controls.tsx 仅确认/暂停推进/人工恢复/打开原主控/返回配方编辑） | 报告"没有现成停止接口时，界面不得显示停止实例并伪造成功" | **停止实例未实现**（内核无停止接口，属 S6 停止链范畴） | S6 |
| 修改运行中流程＝不改实例、重建 | workflow-runtime-controls.tsx:163-170（返回配方编辑）；内核 desktop/editor.ts:88-95（有运行冻结实例禁编辑配方，要求先暂停） | 报告"停止后编辑须启动新实例"口径验收在 S6 | 见存疑项 2（暂停语义 vs 停止语义） | S6 |

## 二、问题清单（W §六 bug1-9）

| 条目 | 实现位置 | 历史证据 | 当前缺口 | 阶段 |
|---|---|---|---|---|
| bug1 积压卡点击无反应→开详情 | kanban-board.tsx:245-254（全列卡均为可点按钮）→207-213+327-475（KanbanDetail：正文/验收/输入/依赖/回执轮次/执行记录/worker 活性） | 报告"看板真实 Electron 两项通过…完整详情与回执"；kanban-board.spec.ts 2 passed | 无 | S7 复验 |
| bug2 配方库选中无反应→选中即加载 | canvas-page.tsx:184-208（openSelection 建标签＋加载） | 报告阶段2 验收通过项 | 无 | S3 复验 |
| bug3 画布太小→撑满 | canvas-page.tsx:316-317（70% 上区）＋recipe-library 折叠＋recipe-canvas-editor 横向分栏 | 报告"配方库可折叠，画布可把中间区域撑开" | 无 | S2 |
| bug4 「工作流画布」→「工作流」 | contracts/i18n-zh.ts:533 `"Workflow canvas": "工作流"`；i18n-en.ts:8 `"Workflow"`；sidebar.tsx:423-428 | 报告"画布入口中英文名改为工作流" | 无 | — |
| bug5 主控对话切走切回消失 | canvas-page.tsx:150-163（useEffect：活动标签已绑定主控且 chatTarget 不符时自动 onActivateController 重激活）；canvas-surface.tsx:46-56 | W 列为待修（2026-10-07 诊断） | **修复机制已在工作区在位但 W 未更新**；未见专门真机复验记录（见存疑项 1） | S4 复验 |
| bug6 主控对话不跟随最新消息 | App.tsx:314 `active: snapshot?.activeView === "threads"` | W 列为待修 | **未修**：active 条件仍不含 canvas 视图 | S4 |
| bug7 主进程 EPIPE 崩溃弹窗 | —（electron/ 无 EPIPE、uncaughtException 管道兜底；内核仅 TUI 侧 interactive-mode.ts:290 有 EIO/EPIPE 集合，与 electron 主进程无关） | W 列为待修 | **未修** | S1 |
| bug8 pao_推流阻塞主控 | PAO workflow/tools.ts:130 附近 `tickWorkflowCore` 仍 `await runAutoChain`；auto.ts:124 附近 `await Promise.allSettled(runChainForCard…)` 同步跑完整链 | W 列为待修 | **未修**：推流仍同步阻塞至链停 | S6 |
| bug9 残留会话锁挡主控 | 内核 runtime/session-lock.ts:48 附近 fail-closed（`残留会话锁须显式接管`）；runtime/index.ts:79,101-108（`/pao runtime takeover <原控制标识>` 模型侧入口＋报错提示） | W 列为待修 | **部分**：fail-closed 设计保持；模型侧显式接管已有；桌面/TUI 用户侧一键接管入口未找到（desktop src/electron grep"接管/takeover"零命中） | S1 |

## 三、实施前补齐（W §七 1-7）

| 条目 | 实现位置 | 历史证据 | 当前缺口 | 阶段 |
|---|---|---|---|---|
| 1 节点坐标贯通保存链路 | 内核 workflow/recipe.ts:74,339-366（ui.positions 解析校验）、478（保留输出）；desktop/editor.ts:66-70（渲染后 parseRecipe 回验） | 报告"内核配方支持 ui.positions…发射配方时保留坐标"；"坐标与连线真实 Electron 42.6s 通过…读盘坐标、刷新后坐标与依赖一致" | 无 | S2 复验 |
| 2 旧实例读启动时的图 | canvas-model.ts:214-220（recipeForInstance 只读 frozenRecipe）；内核 desktop/canvas.ts:333-347（冻结配方缺失如实提示不借用最新）；:506（节点详情拒以最新配方代替） | 报告"节点详情不再使用最新配方。没有冻结图的旧实例只展示卡映射并提示依赖与坐标未知"；"最新配方与实例不同图、冻结坐标…通过" | 无 | S2 |
| 3 启动先保存并检查 | workflow-wizard.tsx 头注＋i18n-zh:1035"覆盖会在启动前保存"；workflow-wizard-bridge.ts:305-330（启动必须带非空 revision，先经预检）；内核 tools.ts 启动前 checkPreflight | 报告"启动向导读回并预选当前配方，不以旧目录数据冒充保存后的版本" | 无（S2 验收"保存失败不启动"复验） | S2 |
| 4 属性对应真实执行能力 | recipe-canvas-editor.tsx 属性面板仅部门任务字段＋审核回边（v2）；无 Prompt/重试/超时/工具节点控件 | 报告"只显示已经接通的可编辑项" | 无 | S3 |
| 5 完整处理未保存内容 | canvas-page.tsx:220-257（切标签/切配方保存/放弃/取消弹窗）；electron/windows/workflow-leave-guard.ts＋register-desktop-ipc.ts:485,840,1123（侧栏切页/切会话/切项目/关窗/退出守卫，startThread/removeWorkspace/selectThread 均包 runLeavingWorkflow） | 报告"新增主进程离开守卫…取消退出不会提前停止会话"；"导航/关窗/程序退出取消链再次通过 30.9s"；"关闭应用及侧栏主要导航已有保护…仍须按入口实际操作补验" | 原生崩溃/无响应弹窗未在真实异常中操作验收；强制退出交互未提供；重启草稿恢复按计划首期不实现（契约 desktop-state.ts:425 明示 dirty 只留内存） | S3 |
| 6 看板状态操作遵守卡规则 | kanban-board.tsx 头注"看板不提供拖拽改状态，不绕过验收"；:442-475（主控动作=生成指令文案，不直接改卡） | 报告"指令不直接改卡状态"真实 Electron 通过 | 无 | S7 |
| 7 连线校验三边界 | 保存/读取＝内核 parseRecipe：自依赖(recipe.ts:390)/悬空引用(:396)/成环 Kahn(:410-436)/回边须指上游(:450-452) 全拒绝；连线当场＝recipe-canvas-editor.tsx:167-191 planConnection（自依赖/成环/重复回边 reject 带 message，单测在案）；启动＝checkPreflight＋冻结时 readControl 校验；状态转移白名单＝cards/statemachine.ts:16,40（ALLOWED_TRANSITIONS，非法迁移抛错）；依赖放行门＝cards/deps.ts（依赖环检测/放行门） | 报告"自依赖和依赖成环直接报错"；S2 验收要求"planConnection 规则与已有单测不因后续交互改造而改写" | noop（依赖已存在）静默无提示（:365 直接 return）；拒绝提示在画布顶部 error-banner 非跟随浮层；"归档不得回收仍被依赖的卡"未逐条核实（S2 复验） | S2 |

## 四、§8.1-8.4 补充定案（2026-10-07，待开工）

| 条目 | 实现位置 | 当前缺口 | 阶段 |
|---|---|---|---|
| 8.1 右键节点/连线菜单（连线到…/设审核/居中/复制/删除/编辑回退设置） | —（features/canvas 全目录 grep onContextMenu 零命中） | **未实现** | S3 |
| 8.1 连线模式（hover 判定/合法高亮/非法置灰/Esc 取消/工具栏复用） | — | **未实现** | S3 |
| 8.1 拖拽连线修复（连接桩 10-12px/hover 放大/noop 提示/浮层拒绝原因） | workflow-editor.tsx:46,52（xyflow 默认 Handle）；canvas.css 无 .react-flow__handle 定制；noop 静默（:365） | **未实现** | S3 |
| 8.1 Inspector 节点名即改（回车/失焦提交、Esc 放弃、删重命名按钮） | recipe-canvas-editor.tsx:527-575 仍是"节点名称"输入框＋「重命名节点」按钮 | **未实现**（改名同步坐标/依赖/回边引用的逻辑已备，:535-571，只差提交交互改造＋e2e 同步 workflow-canvas.spec.ts） | S3 |
| 8.2 删除工作流桌面链路 | 内核 workflow/recipe.ts:512 deleteRecipe＋CLI /pao recipe-del 已有；desktop electron/SDK 驱动层 grep 零命中 | **未实现**（照 saveWorkflowRecipe 五层样板接线＋确认弹窗＋删标签联动） | S3 |
| 8.3 配方→工作流、实例→运行记录改名 | —（i18n-zh:992 仍"配方库"、:997"实例"、:277"我的配方"；src 内"运行记录"零命中） | **未实现**；「快照」不出现在界面文案＝已满足（仅代码注释有"快照"指数据结构） | S3 |
| 8.4 运行动画（执行中节点脉冲/进行边流动） | —（canvas.css 无 animation/keyframes；仅看板 kanban.css:540 有进行中卡 kanban-arc-spin） | **未实现** | S6 |
| 8.4 启动后自动进入运行视图 | canvas-page.tsx:398-451（onStarted 自动建 runtime 标签并切换） | **部分**：0 匹配/多匹配时只报错不进入（:418-431，口径诚实）；节点执行动画无 | S6 |
| 8.4 对话内打开工作流＝该标签视图（sidebar 会话→标签反查） | sidebar.tsx:425 无条件 onSetActiveView("canvas") 进完整中心 | **未实现**（无反查派生索引、无单工作流嵌入视图） | S4 |
| 8.4 标签↔主控 1:1 唯一性校验 | —（electron/application/workflow-tabs.ts 校验成员存在性/归档，无"一会话至多一标签"检查） | **未实现** | S4 |
| 8.4 绑定失效降级（主控删/归档→无主控态，可重建） | electron/application/workflow-tabs.ts:63-87,111-147（controllerProblem→withoutController 解绑保留标签）；canvas-page.tsx:150-163＋runtime-controls onOpenOwner 可重建绑定 | 已实现（对账层）；"sidebar 入口对失效视为无绑定进中心"随 8.4 反查一并做 | S4 复验 |

## 五、看板映射（W §五）

| 条目 | 实现位置 | 历史证据 | 当前缺口 | 阶段 |
|---|---|---|---|---|
| 状态列＝卡状态现读 | kanban-board.tsx:48（五列：待认领/进行中/已交付/失败/取消）、82（groupByStatus） | 报告"五列卡状态、搜索/项目/部门筛选" | 列值与统一计划 S7 表述（待派发/执行中/…）不同，以卡协议现读为准（见存疑项 5） | S7 复验 |
| 卡片 assignee＝部门/worker | kanban-board.tsx:262-263（部门/owner chip）；kanban-detail Worker activity（owner/executionId/attempt） | 报告"部门积压定位待处理项" | 无独立部门/工作流多看板过滤视图 | S7（可后置） |
| 依赖 chips | kanban-board.tsx:267-271（依赖 chip＋title） | — | 无 | S7 |
| 停滞预警（amber/red 两档→租约判据） | kanban-activity.ts:23-31（单档 stale＝同进程活性登记静默阈值）；kanban-query.ts:69-95（活性字段缺省=无信号，坏行不拖卡） | 报告"amber 预警已接入同进程 worker 活性登记…red 阈值本期不实现" | red 档未实现（明示）；**租约判据（认领时刻＋租约时长、孤儿显式接管、代际推进）未实现** | S5（判据）/S7（呈现） |
| 评论线程＝回执轮次详情 | kanban-board.tsx:389-399（Receipt rounds 按尝试号＋证据） | 报告"回执与执行记录"验收通过 | 无 | S7 复验 |
| 多看板切换（部门/工作流过滤） | —（仅搜索＋项目/部门下拉筛选） | W 标注可后置 | 未实现（后置项） | S7 可后置 |
| WebSocket 实时 | —（打开拉取＋手动刷新：kanban-board.tsx:99-107 刷新按钮；canvas-page.tsx:259-279 打开拉一次） | W 定为首版手动刷新，WS 二期 | 符合计划，不算缺口 | 条件项 C1 |
| 增量同步纪律（全量重读提示/不冒充最新） | —（手动刷新全量，无增量通道） | 首版无增量即无此问题 | S7 接 WS 时落地 | S7/C1 |
| 拖放/多选/批量条/右键菜单/running 边框动画 | kanban-board.tsx:256（kanban-arc 进行中边框动画已有）；拖放/多选/批量/右键无 | W 要求核实并补齐 | **拖放、多选、批量条、右键菜单未实现**（只读是刻意设计，S7 需在"只绑定内核已有合法操作"前提下补） | S7 |

## 六、抄改来源与依赖（W §三、§七前置）

| 条目 | 状态 | 证据 |
|---|---|---|
| pi-studio WorkflowEditor 抄改＋MIT 许可证保留 | 已实现 | workflow-editor.tsx:1-20 保留 MIT 全文＋"PAO 仅复用画布交互"注记 |
| @xyflow/react＋react-resizable-panels 已装并使用 | 已实现 | workflow-editor.tsx:22-33；canvas-page.tsx:6、recipe-canvas-editor.tsx:3 |
| 主控对话 EmbeddedChat 抽取复用 | 已实现 | embedded-chat.tsx（不新建消息系统，复用 App 级会话节点） |
| 看板 Hermes 前端大量抄改 | 部分 | 实际为参照 Hermes 形态自写 kanban-board（684 行）；列/卡/详情/running 动画有，拖放/多选/批量/Drawer 无（部分是刻意只读） |
| pi-dynamic-workflows 只借机制 | 未实现 | S5/S6 范畴（并发/租约/usage） |

## 七、发现的可疑点/存疑项

1. **bug5 修复疑似已在工作区落地**：canvas-page.tsx:150-163 的 useEffect 正是 W bug5 描述的修法（切回画布时按标签自动 onActivateController 重激活），但 W（2026-10-07 02:01 更新）仍列为待修，且交付报告无对应真机复验记录。S4 复验须覆盖：切普通会话→切回、跨项目切换、onActivateController 失败路径；并确认 identity 内存回退（controllers[controllerKey]）不绕过标签绑定。
2. **内核编辑配方口径比 W 红线更严**：desktop/editor.ts:88-95 要求"有运行中的冻结实例；先暂停，再编辑配方"，而 W 口径是"停止/回编辑态→改配方→新建实例"。两者兼容但语义不同（暂停≠停止在途），S6 统一时需明确口径，界面不得伪造"停止"。
3. **S2"三处共用图合法性校验"的形式差异**：保存/读取同源 parseRecipe；启动边界是 checkPreflight（部门/技能/参数）＋冻结写入时 readControl 校验，与"三处都跑 parseRecipe"不完全等价，S2 复验需确认启动冻结路径对悬空/成环的实际拦截点。
4. **看板五列状态值分歧**：现有实现（待认领/进行中/已交付/失败/取消）与统一计划 S7 表述（待派发/执行中/待验收/打回/挂起/完成）不同。现有列以卡协议状态现读直排，S7 核映射时以卡协议为准，勿照搬任一侧字面。
5. **预设工作流常驻**（W §二顶部标签）无实现痕迹，统一计划 S3 条目未显式点名，S3 派包时需补进范围或明确砍掉。
6. **整体重构遗留**：canvas.css 曾有 `--surface-hover` 未定义 token（已派 T08 修，需确认已落地）；`canvas-query.ts` 与 `flow-control-query.ts` 的 reasonOf 双份重复留桌面模块任务；"画布标签面"3 条产品失败基线（14 仍败中）归属桌面模块——S2/S3 基线复跑时一并核。
7. **多卡节点详情限首卡**：内核 desktop/canvas.ts:494-496 明确只显示第一张卡并提示"其余卡须在看板查看"；但看板目前按卡号组织、无"按节点聚合全部卡"视图，S7"多卡节点可查看所有卡"需要新数据入口或聚合口径。
8. **bug7/bug8/bug9 三项全未动**，与统一计划 S1（EPIPE/接管入口）、S6（推流即返）的分派一致；其中 bug9 桌面接管入口在 S1 范围而非 S4，注意别漏。

## 八、总数统计

按上表可数核对点合计 50 项：

- **已实现（含已修复，其中 2 项待真机复验：坐标/冻结图 S2 复验、bug5）≈ 28 项**——四区布局与编辑/保存/冻结/运行态/内嵌对话骨架、bug1-5、补齐 1-6、绑定失效降级、回执轮次/五列/依赖 chips、依赖与许可证。
- **部分实现 ≈ 8 项**——框选多选（无批量）、残留锁接管（缺桌面入口）、三边界（noop 静默/归档依赖待核）、启动自动进运行视图（0/多匹配不进）、看板 assignee/停滞预警/增量纪律/running 反馈。
- **未实现 ≈ 14 项**——bug6/7/8、停止实例、预设常驻、§8.1 全套（4 项）、§8.2 删除链路、§8.3 改名、§8.4 运行动画、对话内单工作流视图、1:1 唯一性校验、多看板（后置）。
