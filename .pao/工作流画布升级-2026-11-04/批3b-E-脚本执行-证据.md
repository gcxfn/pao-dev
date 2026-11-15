# 批 3b-E 脚本 schema 与执行生命周期 — 验收证据

日期：2026-11-04。规格：`plans/未完成/2026-11-04-工作流画布升级.md` §4 批 3b-E（第 185–213 行 + 批 3b-E 执行评审段 2026-11-04 写入）、§5 第 228 行。

方法：内核执行评审侦察（认领/停止/回执/恢复函数逐项 + failureType 对应 + 执行宿主二选一）→ 评审结论写入计划 §4 → 三个并行实施分片（A schema+配方链+failureType、B 执行宿主+回执、C canvas 投影+用量）→ 三个独立分片审核（A 执行生命周期、B schema+状态机、C §5 逐项+集成有效性+flaky 复核）→ 统一修补代理 → 主对话整合验收。

## 执行评审结论（已写入计划 §4）

- **执行宿主＝WorkerRunner `命令`/`参数` 覆盖（方案甲）**：runner.run 支持非 pi 进程（stdio 无 ipc、MANAGED_PARENT_ENV=0、跳 session bridge+usage 检查），免费得停止/超时/取消/证据落盘/登记表/StopProof；不新建执行模块重建生命周期整面。
- **failureType 方案 a（结构化扩展）**：`FailureType` 扩为 `...|"script_start"|"script_timeout"|"script_artifact_missing"|`script_exit:${number}``——TS 模板字面量保留动态码，让 script_exit:1/3 可区分路由；不选方案 b（卡面落四值+正文精确值），后者丢结构化值不忠实 L198。
- **所复用函数**：claimCardForDispatch（认领）/changeCardStatus（attempt+1）/executeDispatch（事务链）/stopCurrentAttempt+killTree（停止）/appendDispatchReceipt→appendReceipt（回执）/takeoverOrphanForDispatch（孤儿接管）/claimRefusalDetail（不盲重放）/cancelWorker（取消终态）。
- **CLI/桌面同一入口**：CLI `pao flow` 与桌面 `startDesktopWorkflow` 均汇 executeDispatch/defaultWorkerRunner，内核实现一次两宿主自动获得。
- **PowerShell 调用**：物化 `<evidenceDir>/scripts/卡NNNN-尝试N.ps1`（UTF-8 BOM，`flag:"wx"` 不覆盖）后 `-File` 执行——比 `-Command` 少一层内联转义；评审段「按 -Command」的历史表述以本实现为准（L227 括注）。

## 实施定位（未提交工作区改动）

| 层 | 文件 | 改动 |
|---|---|---|
| 内核 worker | `worker/script-run.ts`（新，139 行） | `planScriptRun`（getPowerShellConfig pwsh→powershell 探测、>64KiB 字节拒、物化 .ps1 带 BOM、argv=config.args 去尾换 `-File`、超时×1000）；`resolveScriptArtifactPaths`/`checkScriptArtifacts`（normalize+resolve+realpath 边界，拒绝对/空/逃逸）；`scriptArtifactProjectRoot`（execution-context 绑定 projectRoot 优先、回退卡目录推导）；`isScriptCard`；常量 64KiB/300s |
| 内核 worker | `worker/dispatch-core.ts` | `isScriptCard` 分支→planScriptRun 覆盖 `命令/参数/要求回执:false/超时毫秒/提示词:""` + 清空 pi 专属参数（模型/思考档/工具白名单/skills/附加系统提示词/会话标识——修补后不再尾随进 argv）；plan 失败合成 `script_start` 回执；产物声明合法性校验前移 planScriptRun（派发前拒），存在性核对留跑完；后置归类 exit0+全产物→success / 非零→`script_exit:<code>` / timeout→`script_timeout` / exit0+缺产物→`script_artifact_missing` / pid≤0→`script_start`；usage `{来源:"脚本",turns:0,cost:0}`；截断标注并入摘要末行无条件附 |
| 内核 worker | `worker/runner.ts` | `WORKER_STREAM_TAIL_CHARS=64KiB` 统一 stdout/stderr 两路；`stdoutTail/stderrFullTail/stdoutTruncated/stderrTruncated` 四字段进 WorkerReceipt；`命令` 覆盖时 stdio `["ignore","pipe","pipe"]` 无 ipc、MANAGED_PARENT_ENV=0、跳 session bridge+usage 检查 |
| 内核 workflow | `workflow/recipe.ts` | `执行方式` 加「脚本」；`脚本/超时/产物` 字段；workerCount 解析顺序修正（isScriptNode+互斥判定移到补默认 `工人数量 ?? 1` 之前，「显式 vs 缺省」可分）；脚本节点拒只读/审核/显式工人数量；产物拒绝对路径/`..`；脚本字节 64KiB 用 `TextEncoder` 真字节口径；`collectPlaceholders` 扫描面不含 `node.脚本`（修补后，产物 `node.产物` 保留）；RECIPE_SCRIPT_MAX_BYTES/RECIPE_SCRIPT_DEFAULT_TIMEOUT_SECONDS |
| 内核 workflow | `workflow/control.ts` | `prepareScriptNode`（重复推进不重复发卡）；createNodeCards 卡面 `script: input.script` 原文不代入（修补后）、`artifacts` 代入保留；`bindMinister` 拒脚本节点；L844-849 hold 文案排除脚本（脚本节点未发卡落 `wait_direct_card`「等待脚本任务建卡」，不落部长绑定文案）；startControl 代入清单补 `产物`（不补 `脚本`） |
| 内核 workflow | `workflow/distill.ts` | Pick+发射清单带脚本字段；`distillRecipe` nodes.push 透传 执行方式/脚本/超时/产物（修补后，连带补 `版本:2`——脚本字段属 v2 专属，蒸馏自检需带版本） |
| 内核 workflow | `workflow/plan.ts` | stepToNode/normalizeSteps/fingerprint 脚本字段（L462-471 校验、L548-553 fingerprint、L1075-1080 透传） |
| 内核 workflow | `workflow/auto.ts`、`workflow/host-bridge.ts`、`supervision-query.ts` | `执行方式==="直接" ‖ "脚本"` 同走人工门/拓扑分支；host-bridge `#deliverPostDispatchResult` 脚本 early-return |
| 内核 cards | `cards/types.ts`/`cardfile.ts`/`failures.ts`/`statemachine.ts` | FailureType 模板字面量扩展 + `isFailureType` 白名单（cardfile.ts L119→131）；`routeFailure` script_*→查现场不自动重派；script_timeout 校验注 Node setTimeout 2^31-1 上限注释（修补后） |
| 桌面 renderer | `src/features/canvas/node-runtime-details.tsx` | 用量分区 `executionMode==="脚本"` 分支渲「脚本节点无模型用量」，不补零 token |
| 桌面 contracts | `contracts/i18n-zh.ts` | `"Script nodes have no model usage."`→「脚本节点无模型用量。」 |
| 桌面 vendor | `vendor/pao-kernel/`、`scripts/vendor-pao-kernel.mjs` | 重出 vendor 内核含 `script-run.js`；publishKernel 收尾在 vendor 根建 `node_modules` junction→`pao-runtime/node_modules`（修补后，解决 shell-quote 依赖解析；junction 不进 electron-builder files） |

## 审核发现 → 修补（3 审核；1 major + 多 minor 全修）

- **[major] M1 脚本正文被代入**（审核 A）：createNodeCards `script: substituteParams(...)` + recipe collectPlaceholders 收 `node.脚本` → 违反规格 L191「脚本正文按原文执行，不做无差别字符串插值」。修：正文存原文、扫描面移除脚本字段（产物代入保留）；workflow-recipe/control 测试改断言正文不代入（`{0,-20} {1}` -f 格式串能过不被替换）；§4 L226 执行评审误读句订正。
- **[minor] A-m1 argv 被 pi 参数污染**：isScriptCard 只覆盖命令/参数/回执/超时/提示词，未清模型/思考档/工具白名单/skills/附加系统提示词 → buildArgs 尾随 `--append-system-prompt "任务黑板:…"` 等进 PowerShell argv。修：同步清空。
- **[minor] A-m2 产物校验弱+时机晚**：resolveScriptArtifactPaths 只 normalize 无 realpath（junction/symlink 逃逸不拦）；checkScriptArtifacts 跑完才调（手工编辑卡面绕过 schema 时跑完才炸卡挂 in_progress）。修：planScriptRun 阶段增 realpath 边界+声明合法性校验（派发前拒→script_start），存在性核对留跑完。
- **[minor] A-m3 截断标注条件丢失**：`summary.split("\n").length <= 2` 才附标注（buildSummary 常产 3 行→丢）。修：标注并入摘要末行无条件附（不破 ≤3 行硬校验）。
- **[minor] hold 文案未排除脚本**（审核 B/C 同报）：control.ts L844 `!== "直接"` 未排脚本→脚本节点误报「等待部长会话绑定」。修：L845 排除+脚本归 `wait_direct_card`「等待脚本任务建卡」。
- **[minor] distill 丢脚本字段**（审核 B）：distillRecipe nodes.push 丢 执行方式/脚本/超时/产物（emit 已带，蒸馏读丢）。修：透传+连带补 `版本:2`。
- **[中] C-F3 桌面 vendor 内核未刷新**：vendor 无 `script-run.js`（桌面端缺能力）+vendor verifier.js import shell-quote 无 node_modules 可解析。修：重出 vendor 内核 + publishKernel 在 vendor 根建 node_modules junction（断链/错位自动重建，不进 electron-builder files）。
- **[中低] C-F1 startControl 缺产物代入**：代入清单不含产物→冻结正本存 `{目录}` 占位符，3b-U 实例脚本区会显示占位符。修：清单补 `产物`（不补 `脚本`，与 M1 协调）。
- **[低] plan 无定向测试**（B/C 同报）：补 TemporaryPlanStep→RecipeNode 脚本字段往返+PLAN_INVALID 拒收用例。
- **[低] C-F5 biome 未过**：9 errors+3 warnings（未用 import+format）。修：`biome check --write`+手工删未用 import，0 error 0 warning。
- **[判读] B 报的「内核自检拒收走 error 非 rejected」非缺陷**：state:"error" 与 disposition:"rejected" 在 UI 都走 refused 保正文，符合 L168/L160。
- **[flaky 复核] B 判定的 flaky 成立**（审核 C 复核）：全量 100 例 99 过 1 失败=L1806 人工门 30s 超时；单跑全过（L1806 24.81s/L1397 26.78s 贴边）。根因=默认 30s 全局超时+负载争抢，非脚本引入缺陷。脚本两条 FakeRunner 用例稳定。

## §5 批 3b-E 验收逐项（L228）

| # | 验收项 | 判定 | 证据 |
|---|---|---|---|
| 1 | 真实解释器成功/非零/启动失败/超时+含子进程停止 | ✅ | worker-script-run.test.ts 3 条真实 pwsh 集成（exit0 写文件+产物核对 / Write-Error+exit1→script_exit:1 / Start-Sleep 60+2s 超时真实杀树→script_timeout）；script_start 两路（planScriptRun 抛错合成+FakeRunner exitCode<0&pid≤0）；孙进程树杀复用 killTree（taskkill /T /F 整树） |
| 2 | 单次终态回执 | ✅ | 一认一跑一 completed→appendDispatchReceipt 单通道；auto-chain 断言 receipts 单终态 |
| 3 | 宿主中断不自动重跑 | ✅ | takeoverOrphanForDispatch 无活进程+无回执才接管落 unknown_outcome；auto.ts deriveHoldNote 留 owner 不重派 |
| 4 | 重试 attempt/依赖/回边/交付后人工门 | ✅ | attempt+1 复用 changeCardStatus；prepareScriptNode 不重复发卡；depends_on delivered 门同直接节点；脚本可作回边目标；host-bridge `直接‖脚本` 同走人工门 |
| 5 | 缺产物失败+已有产物留存 | ✅ | checkScriptArtifacts 分存在/缺失；script_artifact_missing 落缺失项+artifact_path 写已存在产物+摘要列缺失 |
| 6 | 大日志有界截尾 | ✅ | 64KiB 统一两路；runner 真实 node 子进程 ~80KiB→Truncated=true 尾部含末行；摘要末行注流名+是否截断（修补后无条件） |
| 7 | 字节限额+非法字段组合 | ✅ | TextEncoder 真字节拒>64KiB；脚本+只读/审核/显式工人数量拒；非脚本带脚本字段拒；产物拒绝对/`..`；planScriptRun 双保险；卡面 validateFrontmatter 验 script_timeout |
| 8 | 冻结及 plan/distill 往返不丢字段 | ✅ | 冻结正本存代入后产物+原文脚本；emitRecipeMarkdown→parseRecipe 回读四字段过；distillRecipe 透传（修补后）；plan stepToNode/fingerprint 透传+定向测试（修补后） |
| 9 | CLI/桌面共用入口 | ✅ | `pao flow` 与 `startDesktopWorkflow` 同汇 executeDispatch/defaultWorkerRunner；脚本在 dispatch-core 单点两宿主自动获得；vendor 已含 script-run.js |

## 命令结果

| 命令 | 结果 |
|---|---|
| `npx tsc -p tsconfig.build.json --noEmit`（内核） | 0 错 |
| `npx biome check`（13 改动文件） | 0 error 0 warning（修补后） |
| `npx vitest --run worker-script-run.test.ts` | 19/19 过（3 真实 pwsh 集成，58s） |
| `npx vitest` workflow-recipe/plan/save/control + control-hold-kind/action-contract/desktop-flow-payload | 28+53+22+48+117 全过 |
| `npx vitest` workflow-auto-chain（全量后台）+recipe+plan | 181 合计过；全量 100 例 99 过 1 flaky=L1806 人工门 30s 超时（非本批缺陷，复核成立） |
| `npx vitest` worker-dispatch/guards + dispatch-fault-injection/kill-tree-retry/stoptree | 41+16 全过 |
| 桌面 `playwright test canvas.spec.ts+canvas-node-detail.spec.ts` | 140/140 过 |
| `node scripts/vendor-pao-kernel.test.mjs` | 通过（真实 npm 构建/输入冻结/产物约束/跨卷回滚） |
| `node scripts/gate-boundary.mjs`（PAO） | 全 PASS（B7 worker→workflow 禁依赖守住） |
| vendor 内核重出 | `vendor/pao-kernel/dist/pao/worker/script-run.js` 存在；vendor 根 node_modules junction→pao-runtime 就位 |

## 存疑/如实标注

- **桌面 vendor 经修补已刷新**：F3 前桌面发行物内嵌旧内核缺脚本能力；本轮 `vendor-pao-kernel.mjs` 重出后 `script-run.js` 就位+根 junction 建立，vendor 发布测试通过。junction 是本轮新建的 vendor 布局件，下次 vendor:kernel 自动维护。
- **flaky 用例未顺手补 timeout**：L1806/L1397 人工门用例单跑 24.81s/26.78s 贴 30s 上限，满负载会挂——复核判定非本批缺陷（建议后续补 `{timeout:60_000}`），登记不挡交付。
- **登记项不挡**：C-F6 集成用例已补 win32 平台守卫（`describePwsh`）；A-n1 script_timeout 上限补注释不加硬校验；Minor3 owner tool schema 4 值、F7 常量双处（worker 不依赖 workflow 合规必须分两处）、F8 回执尾部字段对 pi worker 冗余、F9 脚本+人工门无组合端到端用例——均登记不动代码。
- **非 Windows 环境**：脚本执行首批 Windows-only（规格 L270 其他 OS 不在首批范围）；集成用例平台守卫已加，非 Windows 会 skip 不失败。
- **L227 历史表述**：评审段「本批按 -Command；若改落临时 .ps1 再切 -File」——实现已切 -File（物化 .ps1 带 BOM），括注以本证据为准。

## 结论

批 3b-E 满足规格 §5 L228 全部九项必需验收：真实解释器四类终态+树杀、单次回执、不自动重跑、重试/依赖/回边/人工门同直接节点、缺产物+已有产物留存、64KiB 有界截尾+标注、64KiB 字节限额+非法组合拒收、冻结/plan/distill 往返不丢字段、CLI/桌面共用入口。1 个 major（脚本正文误代入）+9 个 minor/中低发现全部修补并有定向测试兜底；桌面 vendor 内核已刷新含新执行模块。可在 §7 标完成。
