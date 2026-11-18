# Z 组执行回报 — AF06 / AF07（自进化使用观察与换版 + worker 清单口径）

对应任务行：`优化任务.md` AF06、AF07；审计来源 `final-hosts-audit.md` H3/H4/H5、`final-evolution-kernel-audit.md` FE4。

## 结论（先说结果）

- AF06：使用观察改为「按本进程装配期实际挂载的资源版本」记 used——新增进程内 mounted 登记（commitTaskMountedResources），settled 观察只遍历登记清单，skipped/missing 不再被记成实际参与；worker 失败路径不再对每条绑定无条件 `handleRegression`（FE4 自满环消除），一般失败只留 used(failure) 行；桌面 restoreVersion 已接通 affectedTasks → 安全点换版（live=reloaded，忙=deferred，非 live=not-live，如实分层）。**Phase2 补强：逐任务换版结果（reloaded/deferred/not-live/failed）现在随返回结果的 `resourceSwitch` 字段回传 renderer；回调抛错时附明确「换版未执行」原因，不再静默 console.warn。**
- AF07：**Phase2 修正**——worker 身份判定改为派发方显式注入的 `PAO_EVOLUTION_WORKER=1` 环境标记（runner spawn env 统一注入，含自定义命令与续作路径），不再靠 `--mode json --session-id` argv 猜。修复前续作 worker 走 `--session <旧>`（argv 无 `--session-id`）被误判主会话→全量 ensure 把全部已生效资源补绑到旧任务（正是要堵的泄漏）；用户手动 `pao --mode json --session-id x` 也误判 worker。worker 子进程按 `--skill` 派发清单 basename→`skill:<name>` 建绑定，主会话/交互/无标记 json 仍按全量已生效资源 ensure。
- 全部 18 条定向测试（含 4 条真实 spawn）通过；受影响面回归集 114 条通过（9 文件）；内核 tsc 0 错误、桌面 typecheck（electron+renderer）通过、改动文件 biome/eslint 0 警告。
- **Phase2 顺手修复跨组遗留断裂**：AF02 组新增的 freeze 门（normal/holdout 缺组不得冻结）使共享夹具 `evolution-legal-chain.ts` 与 `evolution-e2e.test.ts` 两处直调 freeze 的用例全部冻结失败（回归集 50 条红）。已把夹具改为三组各种一条 + 全 case 双侧回执，e2e 两处补 normal/holdout——回归集由 50 失败/31 通过恢复为 114/114 通过。

## 改动文件与函数

### 内核 `PAO/packages/coding-agent`

| 文件 | 函数/区段 | 改动 |
|---|---|---|
| `src/pao/evolution/host-mount.ts` | 新增 mounted 登记区 | `MountedResourceEntry`、`taskMountedRegistry`、`commitTaskMountedResources`、`getTaskMountedResources`（未提交返回 undefined）、`clearTaskMountedResources` |
| `src/main.ts` | `resolveTaskBoundPathsForSession` + 装配点 | 新增 `scope:"main"|"worker"`；worker 分支按 `--skill` basename→`skill:<name>` 组 resourceIds；**Phase2：`isWorkerSubprocess = isTruthyEnvFlag(process.env[PAO_EVOLUTION_WORKER_ENV])`——认派发方显式标记，不认 argv**；装配真完成后 `commitTaskMountedResources` |
| `src/pao/worker/runner-invocation.ts` | 新增导出 | `PAO_EVOLUTION_WORKER_ENV = "PAO_EVOLUTION_WORKER"`（argv/派发契约属主文件，常量单点定义） |
| `src/pao/worker/runner.ts` | spawn env 块 | 注入 `PAO_EVOLUTION_WORKER=1`——对全部 worker spawn（含自定义命令 + `--session` 续作）统一生效 |
| `src/pao/memory/tools.ts` | settled 观察处理器 | 改为 `getTaskMountedResources(sessionId)`；`undefined`/空 → 不记 used；只对登记项 `recordUsed`（receiptRef=`session:{id}:settled:{turn}`） |
| `src/pao/worker/dispatch-core.ts` | 失败回执处理 | 移除无条件 `handleRegression` 块（FE4）；保留 `recordUsed` 记 outcome 观察；注释说明归因边界 |
| `src/pao/desktop/host-mount.ts` | 转发 | 从 `../evolution/host-mount.ts` 引入并 re-export `commitTaskMountedResources`/`getTaskMountedResources`/`MountedResourceEntry`（经 `desktop/index.ts` 桶出） |
| `src/pao/desktop/memory.ts` | 契约类型（Phase2） | 新增 `DesktopEvolutionResourceSwitchOutcome`（taskId + `reloaded\|deferred\|not-live\|failed` + pendingTo/message）；`DesktopEvolutionRestoreVersionResult` 增可选 `resourceSwitch: { outcomes?; error? }`——宿主恢复后回填逐任务结果；`error` = 明确「换版未执行」原因。旧消费方不受影响（可选字段） |

### 桌面 `desktop/`

| 文件 | 改动 |
|---|---|
| `packages/pi-sdk-driver/src/session-supervisor.ts` | `resolveTaskBoundPaths` 返回 mounted 并 `commitTaskMountedResources`；`pendingResourceSwitch` 增 `switchedMounted`；`switchSessionResourceAtSafePoint` 计算 switchedMounted，立即 reloaded 即提交，deferred 暂存待 `runReload` 完成时提交；新增 `applyEvolutionSwitchToLiveSessions`（按 sessionId 映射 live 记录，返回 per-task `reloaded|deferred|not-live|failed`） |
| `packages/pi-sdk-driver/src/pi-sdk-driver.ts` | 新增 `switchSessionResourceAtSafePoint`、`applyEvolutionSwitchToLiveSessions` 委托 |
| `apps/desktop/electron/application/app-store.ts` | 新增 `applyEvolutionRestoreToLiveSessions` → driver 委托 |
| `apps/desktop/electron/ipc/register-desktop-ipc.ts` | `MemoryHostOwner` Pick 增 `applyEvolutionRestoreToLiveSessions`；`createMemoryBridge` 接线该回调 |
| `apps/desktop/electron/platform/pao/memory-bridge.ts` | `MemoryBridgeOptions` 增 `applyEvolutionRestoreToLiveSessions` 回调类型；`evolutionMutate` 在 `restoreVersion && restored===true && affectedTasks>0` 时消费 `affectedTasks` 调回调。**Phase2：回调返回的逐任务 outcomes 写进 `result.resourceSwitch.outcomes` 回传 renderer；回调抛错时 `result.resourceSwitch.error` = `受影响会话安全点换版未执行：<原因>`，restored 仍为 true，不再静默** |
| `apps/desktop/tests/unit/memory-bridge.spec.ts` | Phase2 新增 3 用例 + `evolutionRestoreModule`/`restoreAction`/`affectedBindings` helper：①reloaded+deferred outcomes 随结果返回且回调参数（resourceId/newVersionId/taskIds）正确；②failed+not-live outcomes 可见、restored 保留；③回调抛错→`resourceSwitch.error` 含「换版未执行」+具体原因，`outcomes` 缺省、`restored` 仍 true |

## 验收覆盖（每条 → 测试名 + 结果）

| 验收口径 | 覆盖 | 结果 |
|---|---|---|
| 未挂载的资源不记 used | `skipped 资源（template-file）进入 skipped 不在 mounted`；`missing 资源（versionDir 已删）进入 missing 不在 mounted`；`settled 观察只对已挂载资源记 used`（skill used=1，skipped template used=0） | 通过 |
| 服务连接失败这类一般失败不触发回退 | `服务连接失败这类一般失败：只留 used(failure) 行，不自动回退`（effective 保持 v1，failure=1） | 通过 |
| 相关退步可以回退 | `相关退步（problemId 关联候选发布坏版）仍可回退`（isRegression=true，rolledBack=true，effective 回到 base） | 通过 |
| 桌面后续动作使用旧的好版本 | deferred 期间 mounted 登记仍持旧版（`pendingResourceSwitch.switchedMounted` 只在 runReload 完成时提交）——结构层已接，live 会话换版走 updateAdditionalPaths+reloadSessionWhenIdle | 通过（桌面侧路径 typecheck+结构验证；真实桌面运行未起 Electron，标注为未端到端） |
| 忙中换版如实标为 deferred | `switchSessionResourceAtSafePoint` → `reloadSessionWhenIdle` 返回 deferred 时存入 pendingResourceSwitch，不提交 mounted；`applyEvolutionSwitchToLiveSessions` 返回 `deferred` | 通过（结构验证） |
| 同一回执不重复计数 | settled 轮次递增使 receiptRef 唯一；`同 receiptRef 多轮 settled 不重复计数`（写一次 used=1） | 通过 |
| 真实换版留下历史 | `switchTaskResourceAtSafePoint 真实换版留 switch_history 历史`（version_id=base，switch_history_json 含 to=base） | 通过 |
| 真实 worker 子进程只看到 requested 技能，无关技能/扩展不加入 | `带标记的 worker（--session-id --skill X）只绑 X`（真实 spawn，evolution_task_bindings 仅 `skill:requested`）；`带标记的 worker 无 --skill 不绑任何资源`；**Phase2：`续作 worker（--session <旧> + 标记 + --skill X）只绑 X`——argv 无 --session-id 的续作路径不再被误判主会话，unrelated 不补绑到旧任务** | 通过（真实子进程验证） |
| 无标记的 json+session-id 进程按主会话口径 | **Phase2 新增**：`无标记的 json+session-id 进程按主会话口径：全量已生效资源都绑`——用户手动 `pao --mode json --session-id x` 不再误判 worker（旧 argv 判定会绑 0 条，新判定绑 requested+unrelated 两条已生效资源） | 通过（真实子进程验证） |
| 桌面 restore 逐任务换版结果回传 renderer（Phase2） | memory-bridge spec 3 新用例：deferred/failed/not-live outcomes 进 `result.resourceSwitch.outcomes`；回调抛错→`resourceSwitch.error` 含「换版未执行」+原因、`restored` 仍 true | 用例已就位——**但本机 Playwright unit 车道跑不起来**（`pao-desktop-module.ts:3` `exports is not defined` 预置环境问题，spec 加载即失败、基线用例同挂，见限制节） |
| 主会话全量加载行为保持不变 | `主会话全量口径保持：缺省 resourceIds 仍绑全部已生效资源`（skill-a+skill-b 均入 mounted） | 通过 |

## 执行命令与日志

- `node ../../node_modules/vitest/vitest.mjs run test/pao/evolution-af06-af07.test.ts --maxWorkers=1` → **18/18 通过**（Phase2 由 16 增至 18：续作 + 无标记主会话两条新增；worker spawn 用例改为带标记口径）
- 受影响面回归集（o13/regression/binding/control/activation/restart/e2e + worker-dispatch + worker-session-bridge）→ **114/114 通过**（修跨组遗留断裂前为 50 失败/31 通过）
- `npx tsc --noEmit -p tsconfig.build.json` → 0 错误；`tsc -p tsconfig.build.json` 重建 dist（`PAO_EVOLUTION_WORKER` 已入 `dist/main.js`，`cli.js` 为 160 字节 shim → `cli-runtime.js`）
- 桌面 `tsc -p tsconfig.electron.json --noEmit` + `tsc -p tsconfig.json --noEmit` → 均 0 错误（内核 dist 重建后 `resourceSwitch` 可见）
- `npx eslint electron/platform/pao/memory-bridge.ts tests/unit/memory-bridge.spec.ts --max-warnings 0` → 通过；`biome check`（改动内核文件 + 夹具 + e2e）→ 通过
- `npx playwright test tests/unit/memory-bridge.spec.ts` → **本机跑不起来**：`pao-desktop-module.ts:3` `export type PaoDesktopModule = typeof PaoDesktopExports` 在 Playwright CommonJS 加载链下报 `exports is not defined`，spec 加载即失败（"No tests found"），同文件基线用例同挂——预置环境问题，与本次改动无关
- 日志：`checks/Z-kernel-checks-phase2.log`、`checks/Z-desktop-checks-phase2.log`（Phase1 留档 `checks/Z-kernel-checks.log`、`checks/Z-desktop-checks.log`）

## 未端到端验证的限制（如实标注）

- **桌面侧换版的真实 Electron 运行**未起：`applyEvolutionSwitchToLiveSessions`/`pendingResourceSwitch`/`runReload` 的时序经结构实现 + typecheck + 内核 bundle 复用 `commitTaskMountedResources` 验证；真实 GUI 跑 restore→busy→deferred→idle→commit 的链路未实际驱动（Electron 集成测试不在本批）。
- **memory-bridge 3 条新 spec 用例本机跑不了**：`@playwright/test` 加载 `pao-desktop-module.ts`（`export type X = typeof import(...)` 的 ESM 写法）即报 `exports is not defined`，spec 一个用例都起不来（"No tests found"），同文件既有基线用例同样失败——属 `test:desktop-unit` 车道无构建步骤的预置环境问题，非本次改动引入。用例本身经 `tsc -p tsconfig.electron.json` + eslint 验证类型与语法正确；逻辑等价路径（回调 outcomes 进 `resourceSwitch`、throw→error）已在 memory-bridge 源码层由类型契约约束。**需在修好该车道后补跑这 3 条。**
- **worker 失败不再自动归因**是行为删减（移除 FE4 自满环）：保留 used(failure) 观察，真实退步仍走 `pao_evolution_declare`/`problemId` 显式路径回退（已由「相关退步可以回退」用例覆盖）。
- 真实 spawn 验证复用 `cli-lifecycle-provider.mjs` faux provider 与隔离 PAO_HOME（tmpdir 下 `pao-evolution-af-*`/`pao-worker-root-*`），离线、不发真实模型请求、不触正式 `D:\AI\workspace\pao`。
- **Phase2 越界修了共享测试设施**（如实报备）：`evolution-legal-chain.ts` 夹具与 `evolution-e2e.test.ts` 两处 freeze 直调因 AF02 的「三组缺组不得冻结」门全红——非 AF06/AF07 相关代码，但不修则整个回归集 50 条失败无法验收。修复方式是把夹具/用例改成与新门一致的合法形态（三组各种一条 + 全量双侧回执），未改任何生产代码语义。

## 主代理复核（2026-11-18）

- **去掉平行标记**：`WorkerRunner` 对每个 worker 子进程本来就注入 `PAO_ROLE=worker`（`pao/role.ts`，G1-12 角色装载用的正本）。Z 新增的 `PAO_EVOLUTION_WORKER` 与它语义相同，属于平行正本，因此已删除。`main.ts` 改为 `resolvePaoRole(process.env) === "worker"`；`runner.ts`、`runner-invocation.ts` 撤回新增的常量和注入；测试改为注入 `PAO_ROLE=worker`。
- **反面验证**：内核产物（`dist/bundle`）重建前，子进程还按旧标记判断，测试注入 `PAO_ROLE` 后 3 条 worker 用例全部失败（会多绑无关技能）；重建后 18/18 通过（`checks/main-z-role-review.log`、`checks/main-kernel-build.log`）。说明这些用例确实依赖判断逻辑。
- `loadout-role.test.ts` 的「13 项 vs 15 项」失败是复审报告第三节已列出的既有问题，与本组无关。
- 共享夹具 `evolution-legal-chain.ts` 和 `evolution-e2e.test.ts` 后续交给 W 组负责（已通知 W）。
- 结论：AF06、AF07 通过；`memory-bridge.spec.ts` 新增的 3 条用例因既有车道问题未能运行，仍是未验证项。
