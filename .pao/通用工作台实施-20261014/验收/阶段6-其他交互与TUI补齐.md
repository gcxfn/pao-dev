# 阶段 6 验收：其他交互与 TUI 中文补齐

计划：`plans/已完成/2026-10-14-通用工作台与内核可靠性实施总计划.md`（阶段 6 执行项见 `:288-300`，完成条件见 `:300`；§8.1 九类展示项见 `:345-359`；§8.2 四类疑点见 `:361-366`）

## 结论

- §8.1 九类展示项全部处理：普通流程里不再出现整段预算 JSON、原始用量键、UTC ISO 时刻、英文状态或内部 key。
- §8.2 四类疑点各有结论，其中第 1、2、3 项改了展示，第 4 项结论是**不改**（内核的预算 JSON 只出现在机器面，普通视图不经过它）。
- 阶段 6 第 5 项：**真实 Windows ConPTY** 验证通过——同名实例精确选择、损坏实例钻取、坏卡问题与交接页都有实机证据，且 TUI 与桌面卡片页对同一个隔离现场给出同一结论。

## 数据是否模拟

- 桌面侧：**不模拟**。真实 Electron，夹具由内核构建产物真实建计划/实例/卡/回执。
- TUI 侧：**不模拟**。真实 ConPTY 跑真实 CLI bundle（`dist/bundle/cli.js`），夹具是脚本用内核构建产物建的隔离 PAO_HOME 与项目。
- 全程离线：`PI_OFFLINE=1`、`PI_NO_LOCAL_LLM=1`、`PAO_SESSION_BUDGET={"turns":0}`、供应商密钥清空；未调用任何真实供应商。

## §8.1 九类展示项

| 编号 | 展示项（计划条目） | 期望 | 实际 | 证据 |
|---|---|---|---|---|
| 6-1 | 预算对象（§8.1-1） | 分项显示轮次/工具次数/费用/协作额度，普通详情不出现整段预算 JSON | 看板详情改为逐项 `DetailField`（`Budget turns`/`Budget tool calls`/`Budget cost`/`Budget collaboration quota`），未知键收进「预算里的其他键」可展开原始值；缺的项不填假 0 | `src/features/workboard/kanban-board.tsx` 的 `cardBudgetFields`/`cardBudgetUnknownKeys`；`src/styles/kanban.css` 的 `.kanban-detail__raw` |
| 6-2 | 取消/终止命令（§8.1-2） | 中文意图/目标/范围可见，技术参数可展开复制，复制只报已复制 | `kanban-command-intent`/`kanban-command-scope` 两行说明可见；textarea 与复制按钮进「技术参数（展开后可复制）」`<details>`；文案明说「看板自己不改变任何东西，主控没有回报真实工具结果前不算已取消」 | `src/features/workboard/kanban-command.ts`、`kanban-board.tsx` |
| 6-3 | 通用工具输入输出（§8.1-3） | PAO 已知工具按计划/任务/文件/结果展示，输入与结果分开，未知工具有安全回退，原始记录可查 | 展开体分成「输入」「结果」两块（`timeline-tool-input`/`timeline-tool-output`，空值显示 `—`）；未知工具仍用主进程给的标签；复制按钮给整段原始记录 | `src/features/conversation/timeline-item.tsx` |
| 6-4 | 工作流复盘历史（§8.1-4） | 复盘按步骤/轮次列完成、打回、成果与人工确认 | 内核复盘报告新增按轮次的打回原因行「第 N 次尝试被打回（类型）：摘要」 | `PAO/packages/coding-agent/src/pao/workflow/review.ts` 的 `ReviewNodeRow.打回记录`；`test/pao/workflow-review.test.ts` |
| 6-5 | 节点成果路径（§8.1-5） | 成果路径可读、可点、能区分缺失/移动 | 由阶段 5 的步骤卡工作台「成果文件」承担：真实产物只来自已交付卡的回执，按**项目根**解析并在盘上核对，越界/非普通文件/找不到分别给中文原因 | 见 `验收/阶段5-步骤卡工作台与真实产物.md`（缺陷 A） |
| 6-6 | 回执用量原始键（§8.1-6） | 共用中文字段与单位，未知/部分记录说明可见，Token 与费用不混用 | 用量分项为「输入/输出/缓存读取/缓存写入 Token」「合计 Token」「轮次」「费用」；`missing_usage_rounds > 0` 时明说「有 N 轮没拿到用量，这里是已知下界」；扩展键原样追加 | `kanban-board.tsx` 的 `usageParts`/`USAGE_TOKEN_KEYS` |
| 6-7 | 工具名称/状态/耗时（§8.1-7） | 注册中文名、中文状态、可读耗时；已失败不显示完成；技术名与原始时间可查 | 45 个 `pao_*` 工具显示中文名（如 `pao_submit_receipt`→交回执）；状态为 运行中/已完成/失败；耗时为「用时 2 分 5 秒」「工作了 8 秒」；原始 `createdAt → finishedAt` 放进 `title`，技术名始终显示 | `timeline-item.tsx` 的 `PAO_TOOL_NAMES`/`statusLabel`/`toolDurationText`；`electron/orchestration/app-store-orchestration.ts` 记 `finishedAt` |
| 6-8 | 执行编号与原始错误码（§8.1-8） | 执行编号可读，原始错误码可查 | 步骤详情新增「这一步的执行记录」：按轮次列出「第 N 次执行」＋判定＋原因，每条附「原始记录」展开原样打印 `round=/cards=/verdict=/reason=` | 内核 `desktop/plans.ts` 的 `DesktopPlanStepRecord` → 契约 `TemporaryPlanStepRecordRow` → `workflow-cards-view.tsx` |
| 6-9 | 扩展状态内部 key/分隔线（§8.1-9） | 已知内部 key 显示中文，未知 key 保留原文，分隔线不是内部 JSON | 扩展坞块标题经 `titleOf` 本地化，`todo-summary` 显示「待办清单」；未知 key 原样；`--------------------` 只是块间分隔线 | `src/features/extensions/extension-session-ui.tsx` 的 `buildExtensionDockModel`；`src/app/App.tsx` 传 `t` |

## §8.2 四类疑点

| 编号 | 疑点（计划条目） | 结论 | 证据 |
|---|---|---|---|
| 6-10 | 错误出口（§8.2-1） | **有结论，已改**：工作台加载失败时补一句可操作提示（去查项目里 `.pao/临时工作流` 是否还能读、刷新页面）；动作失败时补「动作没有生效、控制正本没有变，看上面的原因再重试或交给主控」 | `src/features/workflow-cards/workflow-cards-view.tsx`、`contracts/i18n-zh.ts` |
| 6-11 | 时间与实例摘要（§8.2-2） | **有结论，已改**：看板详情原来直接显示 UTC ISO（登记时间/最近输出/认领时间/租约到期），现在按本地时区显示 `YYYY-MM-DD HH:mm`，原始 ISO 放进 `title` 可查 | 新增 `src/lib/string-utils.ts` 的 `formatLocalMinute`（与内核 `shared/time.ts` 的 `utcToLocalDisplay` 同口径；渲染层不能深引内核）；`tests/unit/string-utils.spec.ts` |
| 6-12 | 设置中的配置路径（§8.2-3） | **有结论，已改**：设置页新增「正在使用的 PAO 目录」一行，值来自主进程真实的 `PAO_HOME`，没配就写「未配置」 | `contracts/desktop-state.ts` 的 `paoHomeEffective`、`electron/persistence/app-store.ts` 注入、`settings-general-section.tsx` 的 `settings-pao-home-effective`；`tests/core/settings-general.spec.ts` |
| 6-13 | 内核传给部门的预算 JSON（§8.2-4） | **结论：不改**。预算 JSON 只出现在三处机器面：worker 环境变量 `PAO_WORKER_BUDGET`（`worker/runner.ts:411`）、派卡/派部长提示里的「每卡预算」（`workflow/control.ts:475`）、配方文件 frontmatter（`workflow/distill.ts:98`，由 `cards/cardfile.ts:126` 解析回对象）。三者都不是普通用户视图，符合计划「纯机器输入保持结构，不为界面美化破坏模型事实」 | 代码核查 |

## 阶段 6 第 5 项：真实 Windows ConPTY 一致性验证

夹具脚本：`临时文件夹/阶段6-ConPTY与TUI一致性-20261015/verify-tui-consistency.mjs`（自建隔离 PAO_HOME、项目、会话目录；真实 ConPTY 跑 `PAO/packages/coding-agent/dist/bundle/cli.js`）。
隔离现场：同名的两个挂起实例（A 在 `.pao/工作流实例-小说首章.md`，B 埋在 `.pao/临时工作流/p-20261015-same/执行/req-1/`，各带自己的卡目录 `卡-a`/`卡-b`）、一个损坏实例（`工作流实例-坏实例.md`，v2 但缺「卡目录」）、一张坏卡（`.pao/卡/卡0001-坏卡.md`）。

| 编号 | 场景 | 期望 | 实际 | 证据 |
|---|---|---|---|---|
| 6-14 | 同名实例精确选择 | 两条同名实例各自带实例 ID，能选中指定那一条 | 钻取清单两条都带 `实例 <uuid>`；Down+Enter 选中第二条后详情页显示 `实例:198727ca-…`、`卡目录:…\卡-b`，即被选中的那一条 | 结果 `facts.钻取标签`、`facts.tui钻取到详情`、`facts.tui钻取实例` |
| 6-15 | 损坏实例钻取 | 损坏实例单独出行并给出原因 | TUI 全景：`实例异常 1:工作流实例-坏实例.md（v2 实例缺必要控制字段「卡目录」）` | 结果 `facts.异常数`/`异常原因` |
| 6-16 | 坏卡问题与交接页 | 队列区披露读不出来的卡，交接页列卡目录问题 | TUI `/pao queue` 出现「（另有 1 张卡读不出来，未计入以上数字）」；内核 `renderHandoff` 含「卡目录问题」 | 结果 `facts.tui队列披露坏卡`、`facts.交接页含卡目录问题` |
| 6-17 | TUI 与卡片页同一结论 | 两侧对同一隔离现场给出同一数字 | 内核侧与桌面侧都是 挂起 2 / 异常 1 / 实例问题 1，队列披露一致；TUI 全景同样「挂起 2」「实例异常 1」 | 结果 `facts.挂起数`/`facts.异常数`/`facts.桌面实例数`/`facts.桌面问题数` |
| 6-18 | TUI 正常退出 | `/quit` 退出码 0 | exitCode 0 | 结果 `facts.tuiExit` |

原始输出与结果：`临时文件夹/阶段6-ConPTY与TUI一致性-20261015/终端原始输出.txt`、`结果.json`（`status: 通过`）。

## 检查与命令

| 检查 | 命令（工作目录） | 结果 |
|---|---|---|
| 内核类型 | `npx tsc --noEmit -p packages/coding-agent/tsconfig.build.json`（`PAO`） | exit 0 |
| 内核 lint/格式 | `npx biome check packages/coding-agent/src/pao packages/coding-agent/test/pao`（`PAO`） | 342 files，无问题 |
| 内核用例（本轮改动） | `npx vitest --run test/pao/workflow-review.test.ts test/pao/desktop-plans.test.ts`（`PAO/packages/coding-agent`） | 19 passed |
| 内核构建产物 | `npm run build`（`PAO/packages/coding-agent`） | exit 0（**必须用 `build` 而不是 `build:unbundled`**，见下方坑） |
| 应用类型 | `npm run typecheck`（`desktop/apps/desktop`） | exit 0 |
| 应用格式 | `npx prettier --write`（本轮改动文件） | 全部一致 |
| 应用 lint | `npx eslint <本轮改动文件> --max-warnings 0`（`desktop/apps/desktop`） | 仅 1 条**既有**错误（`src/features/conversation/timeline-item.tsx:294` 的 `no-floating-promises`，用 `git show HEAD:` 的副本核实过不是本轮引入） |
| 应用单元 lane | `npx playwright test -c apps/desktop/playwright.config.ts apps/desktop/tests/unit`（`desktop`） | 672 passed / 2 failed / 13 skipped |
| 真实 Electron core（本轮受影响的 8 个 spec） | `npx playwright test -c apps/desktop/playwright.config.ts apps/desktop/tests/core/{settings-general,kanban-board,context-rail,tool-output-images,timeline-overflow,tool-calls,extension-continuation,workflow-cards}.spec.ts`（`desktop`，先清 `ELECTRON_RUN_AS_NODE`） | 首次 20 passed / 4 failed；按新界面修正 2 条断言后 12 passed / 2 failed（余下 2 例是本机窗口几何限制，见下） |
| 真实 Windows ConPTY | `node verify-tui-consistency.mjs`（`临时文件夹/阶段6-ConPTY与TUI一致性-20261015`） | 通过（18 项断言全过） |

### 受影响 core 用例的复跑与逐例结论

首次跑 8 个 spec（24 例）：20 passed / 4 failed。4 例里 2 例是本轮**故意**改的展示（断言写在旧文案/旧结构上），2 例与本轮无关：

- `tests/core/kanban-board.spec.ts:528` 断言 `input 1000`，本轮按 §8.1-6 把用量改成中文「输入 Token 1000」→ 断言改为新文案（该用例仍在验同一件事：回执用量如实、产物路径经主进程复核后导航）。修后通过。
- `tests/core/tool-output-images.spec.ts:26` 用 `.timeline-tool__pre` 定位，本轮按 §8.1-3 把输入与结果拆成两块后该选择器命中 2 个元素（strict mode violation）→ 断言改为结果侧 `timeline-tool-output`（图片本就是结果侧内容，base64 仍不外露）。修后通过。
- `tests/core/timeline-overflow.spec.ts:224`、`:286` 在 `setElectronWindowSize`（该文件 `:49-71`）就失败，还没走到任何时间线断言：请求外框 800×900，实测内容区 786×864。Windows 下窗口带系统边框，而 `electron/main.ts:576` 只设了 `titleBarStyle: "hiddenInset"`，没有 `frame:false`/`useContentSize`，所以「innerWidth/innerHeight 等于外框尺寸」在本机不可能成立。该 spec 与 `electron/main.ts` 都未被本轮触碰（`git status` 干净），属本机环境限制。

为确认这类失败不是本轮引入，另外跑了两个同样依赖窗口几何/终端行为的 spec：`workbench-tabs.spec.ts` 4 例中 2 例失败（其中一例是在 Windows `cmd.exe` 里执行 POSIX `printf 'WORKBENCH_READY\n'; pwd`，必然失败），`sidebar-toggle.spec.ts` 2 例失败（失败截图显示侧栏已经没有 `Skills`/`Extensions` 入口，spec 仍按旧界面找按钮）。两者都与本轮改动无关，属既有基线问题（上一批未提交改动与 Windows 环境差异），本轮未修改它们。

**2 例单元失败的如实记录**（都与本轮改动无关，都是 Windows 临时目录回收竞争）：

- `tests/unit/checkpoint-store.spec.ts:538` — `EBUSY: resource busy or locked, rmdir 'C:\Users\ASUS\AppData\Local\Temp\pi-checkpoint-…\turn-checkpoints\capture-…'`（阶段 4/5 就已存在并记录）。
- `tests/unit/git-review.spec.ts:480` — 同样 EBUSY：`{"state":"failed","code":"file-review-failed","message":"EBUSY: resource busy or locked, rmdir 'C:\\Users\\ASUS\\AppData\\Local\\Temp\\pi-gui-review-dl4Npc'"}`。该 spec 与 `electron/platform/files/git-review.ts` 自 2026-10-09 起未被本轮触碰，单跑同样复现。
- 顺带发现的既有泄漏：测试套件在 TEMP 留下 1059 个 `pi-gui-git-review-test-*` 目录（合计约 1.65 GB，最早的来自 2026-10-08），清理没成功。本轮未删除它们（不是本轮创建的）。

## 过程中踩到并修掉的坑

1. **CLI bundle 必须重建**：`npm run build:unbundled` 只更新 `dist/pao`，而 TUI 跑的是 `dist/bundle/cli.js`（`npm run build` 才会重建）。只重建 unbundled 时 TUI 全景报「挂起 1」，与桌面/内核真值（2）不一致——这不是产品缺陷，是验证脚本用错了构建产物。凡是要验 TUI，必须 `npm run build`。
2. **`tui.output()` 返回的是调用当刻的字符串快照**：验证脚本一开始把快照存进变量再断言，导致后面所有断言都在看旧内容（表现为「钻取没打开详情页」）。改成每次重新取。
3. **断言要看去掉 ANSI 的纯文本**：标题行被颜色码切开，`includes("── 工作流:…──")` 在原始输出里永远匹配不到。
4. **TUI 在 160 列换行**：`（另 有 1 张卡读不出来…` 会被拆行，断言只能用不会被拆开的短片段。
5. **断言失败时 TUI 还活着**：它占着夹具项目的 cwd，下一轮删目录会 `EPERM`。验证脚本收尾改为 `taskkill /PID <pty> /T /F` 连同子进程一起杀。
6. **`ELECTRON_RUN_AS_NODE=1`**：本机会话环境带着它会让 `electron.exe` 以 Node 运行，core lane 启动即失败；跑 core lane 前先 `Remove-Item Env:ELECTRON_RUN_AS_NODE`。

## 未覆盖范围

- 真实读屏软件朗读：只核了可访问性语义与键盘可达，没有真实读屏验证。
- 系统级显示缩放：core 用例用 `setZoomFactor(1.25)` 模拟 125%，没有改 Windows 显示缩放。
- TUI 钻取只覆盖了「挂起实例 → 详情页」这条路径；部门明细钻取与 worker 实时 stdout 尾巴未在本次夹具里覆盖（它们不属本阶段完成条件）。
- 真实模型：全程离线，「人工确认成功放行」「暂停/恢复成功」仍只在阶段 5 验了失败路径与正本不变。
- 阶段 7（离线集成、应用/机器恢复、性能决策、本地 Windows 发行物）在本文件写成时尚未开始。
