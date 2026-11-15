# 桌面与 CLI 连接结构审查

审查日期：2026-10-22  
范围：桌面 PAO 工作流、部门、任务连接边界；PAO core/modes 与 CLI 的 PAO 接入点。  
审核方式：只读。本文没有修改产品源码、测试、配置或 `AGENTS.md`，也没有运行构建、类型检查或测试。

## 结论

共享连接边界整体成立：CLI 与桌面都通过 PAO 扩展接入；`session-driver` 保持通用会话传输职责；工作流持久状态在卡和控制清单，画布、看板、部门与运行控制读取的是投影；桌面启流最终调用同一 `/pao flow` 内核入口。没有必要新增统一的 CLI/桌面启动层。

建议只处理以下三项最有价值的结构简化：

1. **高优先：删除桌面 IPC 装配中重复且被忽略的 `flowControl` 实例，统一使用注入实体。**
2. **中优先：收拢 `pi-sdk-driver` 对 PAO 构建产物的反推与重复加载，优先使用已公开的 `@earendil-works/pi-coding-agent/pao/desktop`。**
3. **中低优先：把两处完全相同的模型模式合并逻辑移到已有共享类型包，作为带测试的纯函数。**

没有列出全局 `truncate` 的 AST 重复：两处默认长度分别为 140 和 160，且分属桌面展示契约与 SDK 会话摘要，当前没有共享实现能同时表达这两个接口；为了消重统一默认值会改变行为。

## 实际覆盖与抽样

### 已核对的结构区域

- `desktop/packages/pi-sdk-driver/src`：重点读取 PAO 加载器、工作流桥、控制桥、部门/画布/看板/计划/工作板/卡操作及 `runtime-supervisor` 相关段落；查看了包导出与调用者。
- `desktop/packages/session-driver/src`：核对包边界、公共类型和 PAO 业务关键字；未发现工作流、部门、任务业务实现。该包继续作为通用会话驱动契约。
- `desktop/apps/desktop/contracts`：核对了 IPC、桌面状态、工具标签与工作联系点；用户给出的 `contracts/electron/src` 在仓库中不存在，实际契约位于 `desktop/apps/desktop/contracts/`，Electron 宿主位于 `desktop/apps/desktop/electron/`。
- `desktop/apps/desktop/electron`：检查了 `main.ts` 的装配、`register-desktop-ipc.ts` 的 owner 接口和 handler，以及 PAO 查询、向导、控制、看板、部门、临时计划、工作区分派等边界。
- `desktop/apps/desktop/src`：核对工作流画布、看板、部门、文件工作台等消费侧；重点是调用语义和展示投影，没有逐行审完所有界面组件。
- `PAO/packages/coding-agent/src/pao`：检查了 `desktop/index.ts`、`editor.ts`、`preflight` 调用以及 `workflow/tools.ts` 的 `startWorkflowCore` 和 `/pao flow` 路由。`desktop/index.ts` 的启流段完整读取；其它大模块只围绕该调用链抽样。
- `PAO/packages/coding-agent/src`：重点核对 CLI 扩展注册、`core`/`modes` 的接入点与 PAO 与内核边界；没有评审所有上游 `pi` 模式实现。
- 根目录、桌面根目录及有额外 `AGENTS.md` 的 `pi-sdk-driver`、桌面应用目录规则已读；`session-driver` 与契约目录没有独立规则文件。

### 抽样与未读范围

本次不是逐文件、逐行全库审计。未完整阅读全部 renderer 组件、全部 PAO 子模块、全部历史测试、`archive/`、发布脚本、上游 `pi` 全量实现和无关桌面功能。没有启动 Electron、容器、独立对话或付费基准；没有执行真实 IPC 集成测试。

代码图用于定位调用者：桌面项目名为 `D-AI-workspace-pao-dev-desktop`，索引时间 `2026-10-19T07:08:07Z`；PAO 项目名为 `D-AI-workspace-pao-dev-PAO`，索引时间 `2026-10-20T02:49:15Z`。两者均早于当前文件，因此下列结论均已回到当前源码核对。代码图包含 `archive/`，同名查询可能产生歧义，未把 `archive/` 命中当作现行调用者。

## 应保留的正确连接边界

- `PAO/packages/coding-agent/src/extensions/index.ts:3` 导入 `paoExtension`，`:17` 将它注册为内置扩展；`PAO/packages/coding-agent/src/main.ts:575` 把内置扩展交给统一扩展工厂。CLI 没有另造 PAO 工作流入口。
- `desktop/packages/pi-sdk-driver/src/pi-sdk-driver.ts:61-63` 将 `options.paoExtensionOptions` 传给 `RuntimeSupervisor`，桌面会话与桌面桥因此接入同一扩展装配面并共享 owner 表。
- `desktop/packages/session-driver/src` 中没有 PAO 工作流、部门或任务业务实现，继续保留为传输和公共类型边界。
- 持久化状态正本是配方、实例卡和控制清单。画布、看板、部门目录、工作板和工作流控制查询是只读投影；不要为读取建立第二份缓存状态。
- `PAO/packages/coding-agent/src/pao/workflow/tools.ts:857-925` 的 `/pao flow` 将启动解析转交给 `startWorkflowCore`。桌面 `startDesktopWorkflow` 在 `PAO/packages/coding-agent/src/pao/desktop/index.ts:256-326` 进行 owner、版本、预检、确认和重核后，仍调用 `flow.run(...)`，没有复制调度器。
- 桌面 `register-desktop-ipc.ts` 的工作区解析、请求骨架校验、`flow-control-query.ts:221-238` 的节点和轮次关联复核，以及内核 owner 校验，分别承担边界防御和业务判定，应保留。

## 三项结构调整

### 1. 高优先：IPC 中重复创建并被忽略的 `flowControl`

**现状与证据**

- `desktop/apps/desktop/electron/main.ts:1351-1354` 已经创建 `workboard`、`canvas`、`workflowWizard`、`flowControl`，其中 `flowControl: createFlowControlQuery()` 位于 `:1354`。
- `desktop/apps/desktop/electron/ipc/register-desktop-ipc.ts:213-229` 的 `DesktopIpcOwners` 声明 `owners.flowControl` 是外部注入的 `Pick<FlowControlQuery, "collect" | "run">`。
- 同文件 `:39` 又导入 `createFlowControlQuery`，`:364` 新建局部 `const flowControl = createFlowControlQuery()`；`:370` 和 `:380` 使用它，而没有使用 `owners.flowControl`。
- 相邻 owner 用法可对照：workboard、canvas、workflowWizard 在 `main.ts:1351-1353` 注入后，由 IPC 模块消费注入对象；只有控制桥重复构造。这个局部实例当前没有内部可观察状态或订阅，若未来构造器获得状态，它还会成为两个来源。

**真实调用者**

`desktop/apps/desktop/electron/main.ts:1332` 调用 `registerDesktopIpc`，并在 `:1340` 之后的 owner 表中提供注入的 `flowControl`。IPC handler 是 `getWorkflowControl` 和 `controlWorkflow` 的桌面调用入口。

**建议最小改动**

1. 删除 `register-desktop-ipc.ts:39` 的 `createFlowControlQuery` 导入，以及 `:364` 的局部构造。
2. 仅将 `:370` 和 `:380` 改为使用 `owners.flowControl.collect(...)` 与 `owners.flowControl.run(...)`。
3. 保留 `DesktopIpcOwners.flowControl` 和 `main.ts` 的注入；不要反向删掉注入、再让 IPC 自己构造，否则会把装配职责放回 handler 文件。

此项不需要改动 `flow-control-query.ts`、IPC 契约、请求校验或 PAO 控制桥。

**保留的行为与边界**

保留 `createFlowControlQuery` 内部读取控制清单、磁盘真值匹配、异常结果处理和请求关联校验。仅去掉多一次无状态工厂调用；返回对象、错误文案和 handler 行为保持一致。

**必要验证**

- 桌面类型检查，确认 `DesktopIpcOwners` 与调用点一致。
- 运行 `desktop/apps/desktop/tests/unit/flow-control-query.spec.ts`。
- 修改 IPC 装配后运行相关桌面 core lane；无需先跑全量测试。

### 2. 中优先：driver 重复反推 PAO 构建目录并深引内部文件

**现状与证据**

PAO 包已有公开导出：

- `PAO/packages/coding-agent/package.json:28-31` 公开 `./pao/desktop`，指向 `dist/pao/desktop/index.js` 及对应类型。
- 但 bridge 仍多次从 `./pao` 入口反推 `dist/pao` 后拼接文件名。例：
  - `desktop/packages/pi-sdk-driver/src/pao-workflow.ts:156-178`：反推 `dist/pao`，深引 `desktop/index.js`。
  - `desktop/packages/pi-sdk-driver/src/pao-flow-control.ts:91-107`：同一路径与内部文件名。
  - `desktop/packages/pi-sdk-driver/src/pao-dept.ts:205-220`：同一路径。
  - `desktop/packages/pi-sdk-driver/src/pao-canvas.ts:168-203`、`:304-319`：反推 `desktop/canvas.js`、`read-model.js`。
  - `desktop/packages/pi-sdk-driver/src/pao-kanban.ts:8-46`：反推 `read-model.js`。
  - `desktop/packages/pi-sdk-driver/src/pao-plans.ts:121-134`：再次深引 `desktop/index.js`。
  - `desktop/packages/pi-sdk-driver/src/pao-workboard.ts:67-115` 和 `desktop/packages/pi-sdk-driver/src/pao-card-ops.ts:43-57`：继续依赖 `status/`、`cards/` 等内部路径。
- `desktop/packages/pi-sdk-driver/src/index.ts:36-130` 已把这些加载器作为 SDK 公共面导出，说明这不是一次性局部代码，而是桌面与 PAO 包之间的稳定连接结构。
- 这里是真实重复的构建目录知识，不是名称相似的巧合：多个加载器各自解析同一包入口并拼接内部模块；迁移 `dist` 布局时，需要同步修改多处。

**真实调用者**

主要经 `desktop/apps/desktop/electron/platform/pao/workflow-wizard-bridge.ts:46`、`canvas-query.ts:49-59`、`workboard-query.ts:40`、`flow-control-query.ts:98`、`kanban-ops.ts:26` 等桌面桥调用；`ephemeral-sweep.ts:38` 也使用控制加载器。

**建议最小改动**

1. 先在 `pi-sdk-driver` 内建立一个很小的惰性 PAO 桌面模块加载器，以 `@earendil-works/pi-coding-agent/pao/desktop` 为唯一公开入口，缓存已加载模块。
2. 把已经存在于同一导出模块的 `index.js` 桥（工作流、控制、部门、计划）统一改为从该入口取函数。
3. 对于确实没有从公开入口导出的 `canvas.js`、`read-model.js`、`status/*`、`cards/*`，逐个判断是否需要新增公开子路径；只新增真实有调用者的导出，不要建立通用动态插件系统。
4. 保留每个桥函数所需函数的显式存在性检查；加载失败仍明确报错，不能用空对象替代。

**保留的行为与保护**

必须保留惰性加载、同一构建产物实例、owner 表共享、显式错误和桌面桥现有返回结构。不能为了去掉深引而复制 PAO 解析器，也不能把内核业务塞回桌面。新增导出应当只是把现有模块入口公开化，不改变工作流、控制或部门判定。

**必要验证**

- PAO 包 build/类型检查，确认 `package.json` 与声明文件导出。
- `pi-sdk-driver` build 与类型检查，覆盖新增的公共加载入口。
- driver 相关 unit tests，至少验证工作流、画布、控制三个加载器。
- Electron fixture 跑一条真实 IPC 路径，确认 `pao/desktop` 与内置 PAO 扩展加载的是同一构建实例并且 owner 表共享。

### 3. 中低优先：模型模式合并的跨层重复

**现状与证据**

`desktop/apps/desktop/electron/application/app-store.ts:5332-5346` 和 `desktop/packages/pi-sdk-driver/src/runtime-supervisor.ts:1445-1459` 是相同的 15 行纯函数：从已有模式开头、用 `Set` 去重并追加新模式。两处真实调用点分别是：

- `app-store.ts:2078`：已连接 provider 自动启用模型模式。
- `runtime-supervisor.ts:891`：已认证 provider 自动启用模型模式。

两处都先保持当前顺序，并依靠 `nextPatterns.length === currentPatterns.length` 判断没有新增；因此共享函数必须保留“已有值优先、追加时去重、重复项不改变长度”的语义。

**建议最小改动**

把它作为纯函数放在 `desktop/packages/session-driver/src/runtime-types.ts` 或其他已有公共模型设置类型模块旁，从 `@pi-gui/session-driver` 公开导出；`pi-sdk-driver` 和桌面应用都改为导入该函数，删除两份私有实现。

这样不会新增包依赖：桌面 `package.json` 与 `tsconfig.paths.json` 已有 `@pi-gui/session-driver` 依赖；SDK 也已有该依赖。不要把它放进 `contracts/tool-labels.ts` 或新建一个只含一个函数的包。

**保留的行为与保护**

纯函数只处理字符串数组和顺序；不合并 provider 认证状态、设置持久化、workspace 解析或错误处理。保留现有去重顺序和长度检测，避免把“已有模式”或 project scope 的语义挪进工具函数。

**必要验证**

- `session-driver` 类型检查。
- `pi-sdk-driver` 类型检查和模块测试，覆盖空数组、交叉重复、重复 provider 输入、顺序保持。
- 桌面 provider 自动启用相关 core 测试；如果现阶段没有直接 JSON fixture，应先补最小 hermetic 单测，并明确是否只是模拟数据。

## AST 补充候选的处理

- `scrollIntoContainer`：`desktop/apps/desktop/src/features/workbench/file-editor-pane.tsx:335-351` 与 `file-explorer.tsx:219-235` 完全相同；都有真实调用者，分别 `:307` 和 `:195`，并有 `workspace-file-lines.spec.ts:190,197` 的滚动可见性验证。可提取到 workbench 同目录的现有状态/UI 工具文件，属于安全但低收益的消重，未进入前三。
- `truncate`：`desktop/apps/desktop/contracts/tool-labels.ts:90-96` 默认 160，`desktop/packages/pi-sdk-driver/src/session-supervisor-utils.ts:237-243` 默认 140。两者所在包和显示契约不同，统一默认值会改变用户看到的内容，未建议合并。
- `extractText`、`optionalText` 等其它 AST 候选未纳入本次范围；它们没有在本轮建立的“真实调用者、职责边界、可直接删除或合并”证据链上全部核对。

## 限制与未验证事项

- 代码图索引早于当前源码，报告中所有行号与调用关系已以当前文件为准；代码图只用来辅助寻找影响面。
- 本轮没有运行 `desktop`/`PAO` 的 typecheck、构建或任何测试，因此上述验证是建议，不代表已通过。
- 没有重新调查 `.pao/三题实测问题诊断-20261022/诊断报告.md` 中的既有故障，也没有把 `empty owner`、`stale_map` 等已知问题当作本轮简化项。

## 给主控的实施顺序

先做第 1 项，它的删除面最小且能立即消除重复状态来源；再做第 3 项，先补纯函数测试再接调用者；第 2 项牵涉包导出和构建产物，应单独实施并保留真实 Electron fixture 验证。不要同时修改 CLI、PAO 内核与桌面 IPC 装配，以便定位回归。

## AGENTS 约束的核对

本轮只读审查，没有修改 `AGENTS.md`。通用 `AGENTS.md` 草案作为用户待批准事项保留，未在本报告中写入规则文件。

