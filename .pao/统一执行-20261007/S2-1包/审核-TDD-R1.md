# S2-1 包 TDD 审核 R1（独立只读）

日期：2026-10-07。审核人：TDD 审核 R1（独立会话，零付费模型调用，只读本包改动面与规程，唯一写入为本文件）。

## 结论：**有保留**

代码与测试本体质量合格：守卫最小、注释与内核实况一致、钉子断言测公开行为、新 e2e 区分力足够、自跑复验全绿、13 条终判登记满足 S2 第 6 条字面。保留点集中在 **TDD 登记性质**：实施记录红绿证据段声称「全部 pin 修前即绿」，经 HEAD 版本静态推演，**其中 2 条（A2 的 ipc 骨架预检测试、A3 的坏行剔除测试）在修前代码下必红**——它们是行为改动（守卫改变拒绝时机与文案）的配套测试，不是钉子，且无红灯留档。因端到端拒绝行为修前已由内核 parseRecipe 单源成立、且 S2 第 4 条定案明示本项工作，判**登记缺口（P2）而非产品缺陷**；另有一处守卫腿无测试（P3）。

## A/B/C 三任务 TDD 判定表

| 任务 | 性质判定 | 依据 | 判定 |
|---|---|---|---|
| A1 契约注释 | 纯文档，无需红绿 | diff 仅注释块替换行内注释；注释所写三入口内核终判点逐一对上代码（editor.ts:75/:79/:110 parseRecipe 与 checkDesktopRecipeEdit、index.ts:203 `revision: string \| null`、:242 revision 比对、:244 渲染比对、:252/:268 check/recheck） | 合规 |
| A2 P1 守卫（ipc expectWizardRecipe） | **行为改动，非钉子**。HEAD:699-710 仅查 `Array.isArray(节点)`，`[对象, 42]` 修前能过 IPC 层；新测试断言 `toThrow("node objects")`，修前必红（静态可证），无红灯留档 | 端到端拒绝修前已由内核 parseRecipe（workflow/recipe.ts:242 拒非对象节点行）在三入口终判成立，守卫＝拒绝时机前移（快速失败），S2 第 4 条定案明示此口径 → 降为登记缺口 | **TDD 缺口（P2-1）** |
| A2 P1 守卫（桥 validRecipeShape） | 行为改动（新增节点行对象守卫腿），**无任何配套测试**（ipc 层等价守卫有测，桥层新腿零覆盖） | workflow-wizard.spec 全文无 saveRecipe/startWorkflow 携坏节点行的用例；生产可达路径上 ipc 守卫先行，桥守卫属双保险，故仅登记 | **覆盖缺口（P3-1）** |
| A3 normalizeCatalog 坏行剔除 | **函数级行为改动，非钉子**。HEAD 版让坏节点行配方进 `recipes`（仅查名字＋节点为数组）；新测试断言 `toHaveLength(0)` 与「非对象的配方行」「节点行形状损坏」两条消息，修前必红 | 生产输入面修前已成立：内核 readDesktopRecipeCatalog（editor.ts:34）逐文件 parseRecipe，坏文件进 errors，坏行配方根本进不了 `value.recipes`——剔除口径属防御面对齐，定案明示 → 并入同一登记缺口 | **TDD 缺口（P2-1，与 A2 同条）** |
| B1 坐标链路钉 | 真钉子 | canvas.spec.ts:172/:178 两条在基线日志（desktop-test-baseline.log:1608-1609）修前即在且绿；ui.positions 透传钉：HEAD normalizeCatalog 整对象透传，静态推演修前绿 | 合规 |
| B2 启动先保存重读＋失败零副作用钉 | 真钉子 | e2e「保存失败→向导不打开、草稿保留」修前已在（:85-94，T08/T09 时代文件）；零落盘 pin（:404 rejects.toThrow）行为修前成立（saveDesktopRecipe 先 check 后写，HEAD 即然），绿属性成立 | 合规 |
| B3 三处校验读取面钉 | 真钉子 | 「只坏文件不伪装空目录」：HEAD 代码静态推演修前绿（errors 原样透出、state available）；「startWorkflow fork owner 校验」基线 :240 修前在案 | 合规 |
| B4 派发门/状态机 | 登记不适用成立 | desktop 侧无卡片派发入口（派发为内核 worker 职责）；内核覆盖**本次审核实跑补验**：cards-statemachine＋dep-cycle-guard＋worker-dispatch-guards 共 3 文件 34 条全绿 | 合规 |
| B5 归档回收保护 | 登记不适用成立 | PAO 无归档/回收机制，前提不成立（F 核对在案） | 合规 |
| C1 退出重开 e2e | 新增测试（非行为修复，验收性用例） | 见下节质量审 | 合规 |
| C2 真机收证 | 留档核验 | 证据目录在位：3 张截图＋验证日志.txt＋归档脚本 s2-exit-reopen.verify.spec.ts | 合规 |

## 新 e2e 质量审（workflow-canvas.spec.ts:435-525）

断言面逐条读，区分力足够，坏实现钻不过：

1. **坐标**：真实鼠标拖动（mouse.down/move/up 8 步）→ 取 DOM `style.transform` 原串 → 重开后 `expect.poll` 等值。坏实现若重启后重算默认布局，transform 必不等。
2. **磁盘内容**（堵死「只存 localStorage/ui-state 不落配方」类坏实现）：读盘拆 `ui: ` 行 JSON——`positions.开发` 不等于初值 `{40,90}`（防漏写）、`positions.审查` 仍 `{380,90}`（防串写）、`depends_on: ["开发"]` 文本在（防边丢失/反向）。
3. **连线**：重开后 `.react-flow__edge` count 1。方向未在 UI 层断言，由磁盘 depends_on 文本兜住（见 P4-1）。
4. **重启真实性**：同 profile＋同 PAO_HOME 两次 `launchDesktop`，`app.close()` 真退出再开，非刷新模拟。

**与 workflow-tabs 重启恢复断言面无重复**：workflow-tabs.spec.ts:86-107 钉的是 workflowTabs 状态等值、activeView、controller sessionId 绑定、composer 草稿；本条钉坐标 transform、边数、配方文件磁盘内容。重叠仅重启机制同模式，断言面不相交。

## 既有测试零改动核查

- **ipc-request-validation.spec.ts**（M）：diff 仅 import 新增＋追加新测试，既有用例零触碰。✓
- **workflow-wizard.spec.ts**（M）：新增 3 条（与记录声称一致）；既有行变化全部为 prettier 格式化（beforeAll 解构、fakeModule 节点数组、两处 expect 换行），断言语义逐条比对无变化；既有「normalizeCatalog：坏配方行显错误…」用例未被改写（「名字或节点缺失」路径与消息保留）。✓
  - 附：该文件 diff 里另有第 4 条新测试「新配方 null 版本透传」，**经基线日志核实（:2095，spec:299）修前已存在**，属既往在库工作，不计入本包——记录「＋3」计数属实。
- **workflow-canvas.spec.ts**（未跟踪新文件，T08/T09 起在库）：无法 git diff；:421 既有失败的修前性由三重证据支撑——①实施方证据日志「去新增行仍红」（1 failed :353:5 该测试）；②S0 基线档 T09 引用 workflow-canvas:347（同名失败，行号随追加漂移）；③基线 core-e2e 日志该批未跑无从直接对照。成立，但证据链依赖留档而非 git（见 P3-3）。对既有测试的唯一改动是在「配方建立独立主控后真实保存并读回文件」内**追加**零落盤断言（:403-404），属只增不放宽，且记录如实申报。✓
- **canvas.spec.ts（声明面之外）**：存在既有断言**改写**（「选中实例：DAG 节点着色…」与「回边虚线…」的 SSR 类断言替换为单测 tone 断言）。mtime 2026-10-05 19:32，早于本包执行窗口（10-07 上午），且配套 canvas-page.tsx/canvas.css（10-05/10-06）均非本包声明面——**归属并行画布改动，非本包所为**，本包「顺手改既有断言」不成立（见 P3-2）。

## 13 条终判登记完整性

满足 S2 第 6 条字面：13 条逐条有去向＋理由，登记于实施记录「13 条终判登记」节，且与统一计划 :313 登记区同文（已实读核对）、:210 载主控终判与选项一口径。分布：#3/#4/#5→S10（3 条）；#6/7/8/13/14/15 不采纳（6 条）；#9-12 不采纳、留 S10 类型清理批可选顺带（4 条）。P1 #1/#2 属 S2 第 4 条点名、不在 13 条内，口径一致。记录与盘点①表建议的差异（#9-12 由「建议 C 并批」改「不采纳」）以计划定案为准，无脱档。

## 发现清单

### P0／P1
无。

### P2
- **P2-1 红绿证据段「全部 pin 修前即绿」登记不实（TDD 缺口）**：A2 的 ipc 骨架预检测试与 A3 的坏行剔除测试在 HEAD 代码下静态可证必红（HEAD expectWizardRecipe 仅查 Array.isArray——HEAD:702-704；HEAD normalizeCatalog 让坏节点行进 recipes——HEAD:79-93），实为行为改动配套测试，无红灯留档且被标注为钉子属性。缓解项：端到端拒绝行为修前已由内核 parseRecipe 单源成立（recipe.ts:242、editor.ts:34），守卫仅前移拒绝时机与改善文案，S2 第 4 条定案明示此项工作，故不构成产品缺陷。处置建议：更正实施记录红绿证据段的定性（2 条改标「行为改动配套测试、无修前红留档」即可，无需补跑红灯）。

### P3
- **P3-1 桥层 validRecipeShape 新增节点行守卫腿零测试**：ipc 层等价守卫有测，桥层「两层各一段同形守卫」只有第一层有配套用例。守卫为 1 行谓词且生产路径 ipc 先行，风险低；建议 S2 收口前补 1 条桥层坏行用例或在该守卫注释标注「由 ipc 层测试覆盖等价行为」。
- **P3-2 多包共树使逐包零改动核查只能 declaration-based＋旁证**：canvas.spec.ts 存在既有断言改写，mtime（10-05 19:32）与配套源码改动（canvas-page.tsx 10-05/10-06）证明早于本包、非本包所为；但 git 无法区分未提交工作区内各包足迹，本结论依赖声明面＋时间戳＋基线日志三方旁证。
- **P3-3 workflow-canvas.spec.ts 为未跟踪文件，:421 既有失败的修前性靠留档证据链**（去新增行仍红日志＋S0 T09 引用）而非 git，证据成立但脆弱；建议该文件尽早纳入版本控制以便后续包可 diff。

### P4／建议（不阻塞）
- P4-1 新 e2e 连线方向未在 UI 层断言（仅 edge count），方向由磁盘 depends_on 文本兜住；建议后续补 `data-id` 方向断言。
- P4-2 e2e 首跑关窗超时抖动：实施方已如实登记（同代码复跑 2 次绿）；本次审核单跑 29.9s 绿，未再现。
- P4-3 实施记录「未验证项」第 3 条（内核三测试未重跑）已由本次审核实跑补验（34 passed），S2 收口时可将该条销掉。

## 自跑复验（隔离：临时 PAO_HOME＝D:/AI/workspace/临时文件夹/s2-1审核-20261007/pao-home，PI_OFFLINE=1＋PI_NO_LOCAL_LLM=1，均在 desktop/apps/desktop 下）

| 命令 | 结果 | 退出码 |
|---|---|---|
| `pnpm exec playwright test -c playwright.config.ts tests/unit/workflow-wizard.spec.ts tests/unit/ipc-request-validation.spec.ts`（附 PAO_HOME 隔离） | 36 passed (1.3s)，与声称 36 一致 | 0 |
| `pnpm exec playwright test -c playwright.config.ts tests/unit/canvas.spec.ts tests/unit/recipe-canvas-editor.spec.ts tests/unit/recipe-canvas-editor-review-node.spec.ts tests/unit/workflow-tabs.spec.ts tests/unit/recipe-library.spec.ts tests/unit/canvas-node-detail.spec.ts tests/unit/workflow-leave-guard.spec.ts` | 72 passed (1.9s)，与声称 72 一致 | 0 |
| `PI_APP_TEST_LANE=core PI_APP_REAL_AUTH=0 PI_APP_TEST_MODE=background PI_OFFLINE=1 PI_NO_LOCAL_LLM=1 pnpm exec playwright test -c playwright.config.ts tests/core/workflow-canvas.spec.ts --grep "退出程序重开"` | 1 passed (29.9s) | 0 |
| `pnpm exec tsc -p tsconfig.json --noEmit` | 过 | 0 |
| `pnpm exec tsc -p tsconfig.electron.json --noEmit` | 过 | 0 |
| B4 补验（PAO 仓 coding-agent，根 vitest 直跑）：`vitest run test/pao/cards-statemachine.test.ts test/pao/dep-cycle-guard.test.ts test/pao/worker-dispatch-guards.test.ts`（附隔离 PAO_HOME＋PI_OFFLINE=1） | 3 files / 34 tests passed (15.95s) | 0 |

**口径注明**：按审核指令未跑全量慢链（unit lane 全量、core lane 全批、driver/catalogs 车道均未跑）；unit 两批与 e2e 单条为定向复验，tsc 双 config 覆盖类型面。B4 内核三测试为审核补验，非本包自证。
