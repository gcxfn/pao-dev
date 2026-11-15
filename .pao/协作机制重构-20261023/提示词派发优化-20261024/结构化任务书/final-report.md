# 结构化任务书第 2 批交付报告

日期：2026-10-24

## 结论

三个已授权入口均支持可选 `task` 对象：`pao_accept_task`、`pao_spawn_minister`、`pao_minister_submit_cards`。旧 flat 调用继续兼容；新旧字段只在双方都显式给出且内容不同时拒绝。

公共 `acceptIntake` 已直接支持 task-only 请求，目标、验收、输入和边界映射到原卡字段。交付物与实施提示通过现有 `constraints` 进入真实卡正文，冻结简报读取同一份卡面内容。没有新增任务状态、编号器、模板框架或持久卡字段。

派发状态按事实记录：`dispatch=false` 直接记 `false`；`dispatch=true` 在建卡时保持未知，后台 hook 明确受理后才记 `true`，确定未派才记 `false`。补写受理账失败会向当前 outcome 加明确警告，旧账或未知状态在 duplicate 中保持未知，并提示查现场。

## 最小实现

| 入口 | 映射 |
|---|---|
| `pao_accept_task` | 可选 `task`，同时保留 `target`/`acceptance`/`inputs`/`constraints` 旧参数 |
| `pao_spawn_minister` | 可选 `task`；渲染为清晰中文任务书后注入，与 `first_message` 二选一 |
| `pao_minister_submit_cards` | 每张卡可选 `task`；转换为原 `NodeCardInput`，旧 `goal`/`acceptance` 继续兼容 |
| 公共 Intake | 同一套归一和映射；task-only 直接受理可用 |

`task` 字段：

- `goal`：必填，非空。
- `inputs`：可选，允许空数组；空值归一省略。
- `boundaries`：可选，空白归一省略。
- `acceptance`：必填，非空。
- `deliverables`：必填，至少一项且每项非空。
- `implementation_hints`：可选，空白归一省略。

输入继承规则：`task.inputs` 缺失时继承旧 inputs；双方显式给出时逐项比较，相同允许、不同拒绝。边界按同样原则比较。目标与验收同理。

`constraints` 只写一份边界，再附交付物与实施提示。`CardCreateInput`、卡 frontmatter 键、编号、状态、身份、幂等、依赖、派发、回执、验收和交卷保护均沿用原实现。

## 派发返回语义

- `accepted + dispatched=true`：已提交后台派发链，等待结果通知；不代表 worker 已认领或模型已启动。
- `accepted + dispatched=false`：只建卡，未提交后台派发。
- `accepted + dispatched=undefined`：受理账未记录派发状态，不能据此认定仅建卡；必要时查现场。
- `deferred`：卡已建但未派，明确原因和解除后的可执行下一步。
- `duplicate`：返回首次真实身份，不重复建卡或派发；首次派发状态未知时明确说未知。
- `stale=true`：优先报告旧结果失效，不再提示等待通知。

工具 description 只保留 task 推荐、旧字段兼容与冲突拒绝、dispatch 默认值及 reason、后台受理含义、幂等重试。详细参数留在 schema；旧工具名、details 和停止能力未变。

## 修改文件

- `PAO/packages/coding-agent/src/pao/intake/task-book.ts`（新增共享 schema、归一和渲染）
- `PAO/packages/coding-agent/src/pao/intake/{index,types,accept,ledger}.ts`
- `PAO/packages/coding-agent/src/pao/worker/index.ts`
- `PAO/packages/coding-agent/src/pao/host/tools.ts`
- `PAO/packages/coding-agent/src/pao/workflow/minister.ts`
- `PAO/packages/coding-agent/test/pao/{intake-tool,intake-accept,host-tools,workflow-control}.test.ts`

未修改 `src/pao/index.ts`、`dept/*`、持久卡协议、权限边界或终止策略。

## 定向验证

| 检查 | 退出码 | 结果 |
|---|---:|---|
| 生产 TypeScript 类型检查 | 0 | 通过 |
| Biome（本批 11 个非历史文件） | 0 | 通过 |
| `intake-tool.test.ts`、`intake-accept.test.ts`、`host-tools.test.ts` | 0 | 3 个文件，60 项通过 |
| `workflow-control.test.ts --testTimeout=30000` | 0 | 1 个文件，31 项通过 |
| 增量 diff 生成脚本 | 0 | 已生成 `incremental.diff` |

命令：

```powershell
& '.\node_modules\.bin\tsc.CMD' -p '.\packages\coding-agent\tsconfig.build.json' --noEmit
& '.\node_modules\.bin\vitest.CMD' run '.\packages\coding-agent\test\pao\intake-tool.test.ts' '.\packages\coding-agent\test\pao\intake-accept.test.ts' '.\packages\coding-agent\test\pao\host-tools.test.ts'
& '.\node_modules\.bin\vitest.CMD' run '.\packages\coding-agent\test\pao\workflow-control.test.ts' --testTimeout=30000
```

测试覆盖了真实注册工具到受理、真实卡正文和冻结简报、执行提示词、task-only 公共入口、旧 flat 调用、冲突与必填缺失、幂等 duplicate、旧账未知状态、派发写账失败、host 任务书注入与冲突、workflow 卡正文与简报。写账失败用 `atomic.writeFileAtomic` 的故障注入模拟，并在报告中标注为模拟测试。

## Baseline 与 diff

- 初次 `baseline/` 保存了 9 个入口/类型/测试文件。
- `baseline-review2/` 保存了后续审查前的 `ledger.ts`、`intake-accept.test.ts`、`host-tools.test.ts`、`workflow-control.test.ts`。
- `incremental.diff` 合并 11 个本批源文件与测试；外层仓库大量历史 dirty 未计入。
- `ledger.ts` 的当前改动属于本批派发状态落账能力。后续 review2 baseline 已包含该改动，因此单独 diff 为空；当前工作树相对仓库原始提交仍能看到这段改动，它已随 `accept.ts`、`types.ts` 和写账失败测试一并审阅。

## 未验项与限制

- 未调用真实模型，不能验证行为收益、提示词效果或 token 降幅。
- 未运行全库测试、官方完整测试、Docker，未安装依赖。
- `workflow-control.test.ts` 默认 5 秒超时下有历史慢用例；本次按项目实际配置覆盖为 30 秒后通过。
- 本轮只接通三个既有入口和公共 Intake 兼容面；批量、桌面及其他派发入口没有做全量迁移调查。
- 未迁移历史任务，未新增旧任务回填。

