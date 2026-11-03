# T（todo 渲染）与 E（工程化重构）逐项现状核对

日期：2026-10-07。性质：S0 只读调查，未修改任何源码。核对基准：三仓 HEAD——pao-dev `7a3472d`、PAO `70451fde0`、desktop `5256008`（均含各自未提交工作区，未逐一展开）。
来源：[T 计划](../../../plans/已完成/存档-收编-2026-10-07/2026-10-07-todo渲染-桌面与TUI.md)、[E 计划](../../../plans/已完成/存档-收编-2026-10-07/2026-10-07-全项目工程化重构.md)、[七维检查报告](../../工程化检查-20261007/检查报告.md) 及同目录七份原始报告、[统一执行计划](../../../plans/已完成/2026-10-07-统一分阶段自主执行计划.md) S8—S11。

**总结论：T 与 E 的全部整改条目均未实施（源码零改动）。七维报告的行号几乎零漂移（唯一实测漂移：error-text 内联 79→80、.pao log 426→429、worker 待办文本 455-460→457），说明 2026-10-07 检查轮之后无人动过被点名区域。**

---

## 一、T 部分（S8：TodoWrite 与两端显示）

### 1.1 关键事实核验

**a) TodoWrite 工具不存在（T 计划的核心前提再次证实，且"上游可复用"不成立）**

- `PAO/packages/coding-agent/src/` 全量 grep `TodoWrite|todo_write|todo-write`：0 处工具实现。内置工具目录 `core/tools/` 仅 bash、edit（含 edit-diff）、find、grep、ls、powershell、read、write，无 todo。
- node_modules pi 相关包（`@earendil-works/pi-agent-core`、`pi-ai`、`pi-coding-agent`、`pi-tui` 等）：唯一 TodoWrite 字样在 **pi-ai 的 `src/api/anthropic-messages.ts:116`**（fork 侧同文件同位置）——那是"伪装 Claude Code"的**工具名大小写映射数组**（claudeCodeTools，含 Read/Write/TodoWrite 等 17 个名字），不是工具实现。
- `pi-agent-core/dist/harness/` 里的 "todo" 命中是 `@earendil-works/chord` 的 `TODO_CONTEXT` 异步上下文键和一处代码注释，与任务清单无关。
- **结论：本地依赖中无可复用的 TodoWrite 实现。统一计划 S8 第 1 条"先核真实来源"的核对结果＝本地没有；后续按该条走"查公开来源或用现有工具/会话扩展做最小实现"。桌面 todo-table.tsx:4 注释"pi's TodoWrite tool uses these four"是对未来载荷形状的假设，不构成存在证据。**

**b) 桌面现有渲染链：完整但从未触发，无常驻呈现**

- `desktop/apps/desktop/src/features/conversation/todo-table.tsx`：`parseTodoList`（:20，解析 `{todos:[{content,status}]}`）、`isTodoToolCall`（:64，工具名含 todo 即认）、`TodoTable`（:93，四态符号 ○◐✓⊘ 在 ：68-73）。
- 接线：`timeline-item.tsx:27` import、**:290-291** 判定＋解析、:348-350 渲染。与 T 计划记载的 :290 完全一致。
- 测试：`desktop/apps/desktop/tests/core/todo-table.spec.ts` 存在；desktop HEAD 5256008 提交曾修 todo-table fixture（dock 被 usage footer 顶掉的根因），链路本身被维护过但仍无工具可触发。
- **无** pi-desktop 式输入区常驻折叠条（TodoDock）。

**c) TUI 零 todo：`PAO/packages/tui/src` 大小写不敏感 grep "todo"＝0 处。**

**d) 参考件定位（T 计划记载属实）**

| 参考 | 路径 | 现状 |
|---|---|---|
| pi-desktop v0.16.1（LGPL-3.0） | `D:/AI/workspace/pi-desktop/` | `apps/desktop/src/components/TodoDock.tsx` 存在；`apps/desktop/src/features/chat/todos/` 含 `useSessionTodosRecovery.ts`＋`session-todos-recovery.ts` |
| omp v18.3.2 | `D:/AI/agent/omp/` | 仅 `omp.exe`＋`omp.cmd`，无源码；只能运行观察样式 |

**e) 编排待办标记（与 S8 分开的另一套，维持原状）**：`pao/host/host.ts:757` `todoView()` 返回 `{部门, 项目名, 标记}[]`；worker 交付时拼 `[待办标记〔部门@项目〕:…]` 纯文本（`pao/worker/index.ts:457`；报告记 455-460，行号微漂移）。

**f) 纪律钩子前提成立**：`PAO/packages/agent/src/agent-loop.ts:709-710` 定义 `beforeToolCall|afterToolCall` 钩子，:891-893 调用，`types.ts:77` 支持部分覆写工具结果——T 计划第 3 条"afterToolCall 追加对账提醒"的基建确实在。

**g) evals 无 todo 用例**：`PAO/packages/evals/src` 无任何 todo 相关代码。

### 1.2 T 计划六条逐项现状

| # | 条目（统一计划 S8） | 当前实际状态（证据） | 归属 |
|---|---|---|---|
| 1 | 核 TodoWrite 真实来源/许可证 | 已核：本地依赖无实现（见 1.1a）；pi-desktop 另有私有实现属 LGPL 参考件 | S8（本次调查已完成核对这一步） |
| 2 | 单一会话 todo 契约（四态/校验/持久化/恢复） | 无任何代码 | S8，未实施 |
| 3 | 系统提示纪律段＋afterToolCall 陈旧提醒 | 无；钩子基建在（agent-loop.ts:891） | S8，未实施 |
| 4 | worker 交付列未勾 todo 对账 | 无；现行只有卡待办标记纯文本（worker/index.ts:457） | S8，未实施 |
| 5 | 桌面输入区常驻折叠摘要 | 无；时间线 TodoTable 链完整但死置（todo-table.tsx＋timeline-item.tsx:290） | S8，未实施 |
| 6 | TUI 同源呈现＋evals 及时性用例 | TUI 0 处 todo；evals 0 用例 | S8，未实施 |

---

## 二、E 部分（六批整改＋API/卡字段英文化＋四项决策）

### 批次 1：快赢＋死代码＋两项已拍板删除（S10）——全部未动

| 条目 | 报告发现 | 当前实际状态（file:line） | 归属 |
|---|---|---|---|
| .gitignore 补规则 | `.pao/**/*.log` 等未忽略 | 未加：`.gitignore` 仅 auth.json/jsonl/zip/exe 等规则；盘上 `.pao` log 实测 429 个（报告 426）；`.pnpm-store/`、`临时文件夹/` 无规则 | S10 |
| 删 door-clean.txt、desktop/f1 | 废文件 | 两文件均在盘上 | S10 |
| SearchArea | knowledge/types.ts:11 全仓 0 引用 | 仍在 `pao/knowledge/types.ts:11` | S10 |
| GbrainVendorParams / MnemosyneVendorParams | 两个死接口 | 仍在 gbrain.ts:42（index.ts:38 转出）、mnemosyne.ts:34 | S10 |
| utils/deprecation.ts 整文件 | 14 行并行遗留 | 文件仍存在 | S10 |
| experimental/coordinator-entry.ts | 孤儿入口 | 仍在 | S10 |
| experimental/ 子系统（决策①：移除） | 46 文件约 9,950 行 | **仍在**：`coding-agent/src/experimental/` 实测 46 个 ts 文件 | S10 |
| 4 个死图标 | icons.tsx:47/118/133/386 | 四个导出原位仍在 | S10 |
| resolveModelSettingsOwnerId | model-settings.ts:50 | 仍在 | S10 |
| output-pruning（决策③：删除） | 83 行默认永关 | **仍在**：`pao/output-pruning/` 目录＋`pao/index.ts:119` 注册行原样 | S10 |
| P3 仅测试引用降级 | usage-display 5 导出等约 15 项 | 5 导出仍在（usage-display.ts:80/266/297/302/307） | S10（可缓） |

pi 底座功能（决策②：保留扩展管理 UI 与定时任务）无需改动，现状一致。

### 批次 2：命名（S9）——全部未动，中文键原样

| 条目 | 当前实际状态（file:line） | 归属 |
|---|---|---|
| 39 个 `pao_中文` 工具名 | grep `name: "pao_..."` 唯一名**仍精确 39 个**，全中文 | S9 |
| 工具参数键约 150 处中文 | cards/tools.ts、workflow/tools.ts 等原样（抽查「模板/卡目录/理由」等仍在） | S9 |
| 卡协议 14 字段中文键 | CardFrontmatter/Receipt 落盘键未动 | S9 |
| ParsedCard 内存键（波及最大） | `cards/types.ts:68-75`：路径/文件名/正文/回执 仍在 | S9 独立工作包 |
| 后台计数 | status/index.ts:24、panorama/index.ts:36 仍在（:82/:222 消费） | S9 |
| worker改动 | cards/baseline.ts:76 仍在；delivery.ts:152/164、handoff.ts:98/103 扩散仍在 | S9 |
| 作者/操作者 | delivery.ts:109 `作者?:{名,邮箱}`；statemachine.ts:66 `操作者` 均在 | S9 |
| resolve缓存时钟/pi版本 | healthcheck/index.ts:50、report.ts:37 均在 | S9 |
| ClaimBaseline/ClaimDiff 键 | baseline.ts:70-76 基线可用/既有条目数等仍在 | S9 |
| 桌面泄漏载荷键 | flow-control-query.ts:222-229：名字/卡目录/实例/节点/轮次/动作/理由 原样 | S9 |
| 测试 3 处中文变量 | fanout-baseline.test.ts:58-59（声明/私货/缺账轮）、host-ledger.test.ts:58 在 | S9 |

### 批次 3：重复收编（S10）——全部未动

| 条目 | 当前实际状态（file:line） | 归属 |
|---|---|---|
| bridge-result.ts / read-guard.ts / contracts/pao-unavailable.ts | 三文件**均不存在** | S10 |
| issue()/asText() 三份同体 | workboard-query.ts、canvas-query.ts、workflow-wizard-bridge.ts 各自仍定义 | S10 |
| PAO_HOME 三查门 4 处 | pao-home.ts 无 tMain 文案，未并入门控 | S10 |
| time 3 处同体拷贝 | dept/render.ts:15-17、friction/drafts.ts:169-170、workflow/distill.ts:116 formatMtime 仍在；shared/time.ts nowString 未被引用 | S10 |
| parseCardMinute 双份 | cards/metrics.ts:51（parseCardTime）vs canvas-query.ts:516 | S10 |
| error-text 单源 | `shared/error-text.ts` 不存在；内联 `instanceof Error ?` 实测 **80 处**（报告 79，+1 漂移） | S10 |
| pathKey 6 份分叉 | workflow/control.ts canonical 仍**不换斜杠**（:72-75）；utils/paths.ts:28 canonicalizePath 仍无人组合 | S10 |
| marker 正则两份 | shared/marker.ts 不存在；metrics.ts:114 仍重述 | S10 |
| CARD_STATUSES 桌面硬编码 | kanban-query.ts:85 五态字面量仍在 | S10 |
| 回执用量聚合 4 份 | canvas-query.ts:544 aggregateUsage、workflow/review.ts:54、cards/metrics.ts、usage-display.ts 均在 | S10 |
| 回执行 UI 两份 | kanban-board.tsx:547 ReceiptRow vs canvas-page.tsx:1237 ReceiptRoundRow | S10 |
| 冻结配方平行读取 | status/workflow-instances.ts:77 注释"与 desktop/workflow.ts 同口径"仍在 | S10 |
| JSON 裸读绕开 shared/json | session-lock.ts:35/76/84、shared-budget.ts:23、preflight/index.ts:133/185、dispatch-core.ts:336、app.ts:46 全部原样 | S10 |

### 批次 4：结构归位（S10）——全部未动，行号零漂移

| 条目 | 当前实际状态（file:line） | 归属 |
|---|---|---|
| app.ts 桌面仓布局知识（P1 唯一实锤） | pao/app.ts:19-28：`../../../desktop` 默认路径＋`out/main/main.js`＋`electron/path.txt` 原样 | S10 |
| core→pao 反向 import 6 处 | bash.ts:7(killTree)、model-runtime.ts:68、agent-session.ts:59、sdk.ts:6-8、extensions/loader.ts:102 全在 | S10 |
| cards↔friction 互边 | statemachine.ts:3 import friction/drafts ↔ drafts.ts:24-25 import cards/atomic+lock | S10 |
| cards↔dept 互边 | dept/projects.ts:5、dept/registry.ts:3 取 cards/atomic 的 writeFileAtomic | S10 |
| cards↔worker 互边 | cards/metrics.ts:26-27（worker/usage）、cards/process.ts:2（worker/kill） | S10 |
| knowledge↔memory | knowledge/tools.ts:12、auto-route.ts:19 type-only MemoryHit | S10 |
| workflow→ui/glyphs | workflow/driver.ts:18、auto.ts:24 | S10 |
| 内核感知 Electron 宿主 | worker/runner.ts:168/395、host/host.ts:250 `process.versions.electron` | S10 |

### 批次 5：测试补齐与提速（S11）——全部未动

| 条目 | 当前实际状态 | 归属 |
|---|---|---|
| P1 六组直接单测缺口 | parseWorkflowMarker、parseWorkerFinalResult、checkWriterAuthority、splitQueryTerms/routeByLabel、normalizeNodeInstance、applyPaoHomeSetting——grep 两侧 test 目录**全部 0 命中**，无一补测 | S11 |
| 3 巨测＋1 单 describe | 行数与报告完全一致：tui editor.test.ts 4380、package-manager 2831、model-registry 2146、workflow-auto-chain 909 | S11 |
| 游离探针测试 | `.pao/后续执行-20261004/S4-空闲取消独立复现.test.ts` 仍在原处 | S11 |
| composer 保稿 8 用例 | composer-draft-flush.spec.ts 仍 8 个 test() 独立冷启 | S11 |
| 硬等 2.3 秒 | timeline-pinning.spec.ts:592 `waitForTimeout(2_300)` 原样 | S11 |
| workflow-control 进程直跑 | test/pao/workflow-control.test.ts:1 仍 execFileSync | S11 |

### 批次 6：构建链路（S11）——全部未动

| 条目 | 当前实际状态 | 归属 |
|---|---|---|
| check 门重复 build:shared | desktop/package.json `check` 脚本原样（lint 与 typecheck 各内嵌 build:shared，全文件 4 处字样） | S11 |
| 35 处测试脚本内嵌 pnpm build | apps/desktop/package.json 实测仍精确 35 处 | S11 |
| Playwright win32 串行 | playwright.config.ts:16-22：workers 仅 linux+background 本地＝3，win32 默认仍 1 | S11 |
| unit 车道无独立 config | tests/unit 仍复用同一 config | S11 |
| PAO 串行 build 链 | package.json:15-16 `build`/`build:offline` 仍 13 包手写串行 cd 链，未改 tsc -b | S11 |
| tsconfig composite 死配置 | desktop/tsconfig.base.json:14 `composite: true` 仍在 | S11 |
| test:spec 参数化 | 不存在该脚本；约 25 个逐字节相同脚本未收敛 | S11 |

### 类型安全 P1 两条（并入画布阶段，不单排）

| 条目 | 当前实际状态 | 归属 |
|---|---|---|
| expectWizardRecipe 只验骨架透传 | electron/ipc/request-validation.ts:788-796 仍 `...record`＋`as WizardRecipe`，节点行内容零校验 | S2/S3 |
| validRecipeShape 二次裸断言 | workflow-wizard-bridge.ts:165（:180/:254 消费）原样 | S2/S3 |

### 四项已决策取舍的落地状态

| 决策 | 拍板内容 | 落地状态 |
|---|---|---|
| ① experimental/ 移除 | 并入批次 1 | **未落地**（46 文件全在） |
| ② pi 底座功能保留 | — | 无需动作，现状一致 |
| ③ output-pruning 删除 | 并入批次 1 | **未落地**（目录＋注册行在） |
| ④ 参数键 150 处并入工具名一次改 | 并入批次 2 单张对照表 | **未落地**（S9 待做） |

---

## 三、核对方法与边界说明

- 所有"未动"结论均以本次实测 grep/读文件为据，非沿用报告文字；标注 file:line 的条目都已实际打开验证。
- 未逐条复跑构建/测试（只读调查）；批次 6 中"desktop 12 包/PAO 13 包增量收益"类量化断言未重测，仅核脚本形态未变。
- error-text 内联计数（80 vs 79）与 .pao log 数（429 vs 426）为允许的计数漂移，不影响结论。
- 类型安全 P2/P3 共 13 条未逐条复核（检查报告未将其编入六批整改主线，归属 S2/S3 或随 S10 顺手项处理）；如需可另行补核。
