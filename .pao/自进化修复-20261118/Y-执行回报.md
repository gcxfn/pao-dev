# Y 组执行回报 — AF04 作业按来源项目解析外发许可

日期：2026-11-18。任务书：`.pao/自进化修复-20261118/任务书.md` Y 行。来源：`memory-evolution-audit-20261112/优化任务.md` AF04 行 + `final-evolution-kernel-audit.md` FE6。

## 改了什么

四处文件，全部新增/局部修改，无整文件重写。

### `src/pao/memory/project-identity.ts`
- 新增 `resolveMemoryProjectRootById(paoHome, projectId): { projectRoot, source } | undefined`：只读打开 MemoryStore，按 `projects.canonical_root → project_context.project_root → task_continuations.project_root → memories.scope_json.executionRoot` 顺序反查持久身份根，每个候选根 `existsSync` 验证后返回。查不到返回 undefined。

### `src/pao/memory/maintenance.ts`
- `enqueueEvolveJob` 输入签名加 `executionRoot?: string`；写入 `sourceScope` JSON 时带上（供跨会话续作的来源身份）。

### `src/pao/memory/tools.ts`（与 X/Z 同文件，仅局部 Edit）
- `pao_evolution_declare` 工具登记作业时把 `scope.executionRoot` 写进 `sourceScope`。
- `RegisterBuiltinMemoryOptions.evolve` 删除 `outboundProjects?: string[]` 字段（FE6 的全局固定项目路径收口——X 组 AF05 不依赖该字段）。
- `buildMaintenanceHandlers` 加 `export`（测试复用生产 handler）。
- 新增 `parseScopedMaintenanceJob` / `parseEvolveJobScope`：从 `job.sourceScope` JSON 解析 `projectId`/`executionRoot`/`taskId`。
- 新增 `resolveEvolveJobOutboundRoot(paoHome, scope)`：先取 sourceScope 自带 `executionRoot`（`existsSync` 验证）；否则按 `projectId` 反查库内持久根。都拿不到返回 `undefined`。
- evolve handler：调用 `resolveEvolveJobOutboundRoot`；`undefined` 时 `throw`（走 `runJob` 的 catch → `failJob` 落 `status=failed + last_error=无法定位来源项目…`）；拿到根后用 `resolveMemoryOutboundContext(home, outboundRoot).project` 解析外发许可项目。**判定主体是作业来源项目，不是唤醒会话的 ctx.cwd**。
- embed handler：`projectId` 与 `executionPath` 同样走 `parseScopedMaintenanceJob` + `resolveMemoryProjectRootById` 反查，查不到才退回 `ctx.cwd`（同 AF04 缺陷在 embed 上的展开——提炼收尾嵌入的外发主体也应是来源项目）。

### `src/pao/memory/extraction-scheduler.ts`
- import `resolveMemoryProjectRootById`。
- 新增 `outboundProjectForJob(paoHome, projectId, ctxCwd)`：按 `projectId` 反查持久根 → `resolveMemoryOutboundContext` 判许可；查不到退回 `ctxCwd`（新批登记方本进程即来源，与现语义一致）。
- `requestExtraction` 的 `outboundProjects` 改用 `[outboundProjectForJob(deps.paoHome, jobScope.projectId, ctx.cwd)]`（原硬编码 `resolveMemoryOutboundContext(deps.paoHome, ctx.cwd).project`——提炼 job 续作到别会话时本应按 job 来源项目判，同 AF04 缺陷）。
- `embedForSession` 的 `executionPath` 改用 `resolveMemoryProjectRootById(deps.paoHome, scope.projectId)?.projectRoot ?? ctx.cwd`。

### `test/pao/evolution-af04.test.ts`（新文件）
5 个用例，全部用 `mkdtempSync` 隔离 home + 假 `streamSimple`（计数即外发探针），离线验证零真实外发。

## 关账验证对照

| 场景 | 用例名 | 结果 |
|---|---|---|
| A 留作业、B 唤醒；A 允许而 B 不允许 → 按 A 执行 | `A 留作业、B 唤醒；A 允许而 B 不允许 → 按 A 发模型请求` | ✅ requests.length > 0 |
| A 不允许而 B 允许 → 按 A 拒绝，零外发 | `A 留作业、B 唤醒；A 不允许而 B 允许 → 按 A 拒绝，零外发` | ✅ requests=0 + `pao-evolution-rejected` 账条含「禁外发」 |
| 无法定位来源项目 → 拒绝 + 明确状态 | `无法定位来源项目 → 作业 failed + 明确 last_error，零外发` | ✅ `status=failed` + `last_error` 含「无法定位来源项目」 + requests=0 |
| 同项目路径不变 | `同项目路径不变：A 留作业、A 会话唤醒，仍按该项目许可判定` | ✅ requests.length > 0 |
| 旧作业（sourceScope 无 executionRoot）兼容 | `旧作业（sourceScope 无 executionRoot）按 projectId 反查库内持久根` | ✅ 反查 `projects` 表成功 + 按 A 许可放行 |

## 检查结果

- AF04 测试 5/5 通过：`checks/af04-test.log`
- 回归测试 56/56 通过（evolution-o10 23 + memory-maintenance + memory-extraction-scheduler + memory-embeddings + memory-extraction-jobs）：`checks/af04-regression.log`
- `npx tsc --noEmit`：本组触碰文件零错误。剩余错误全部在 `budget-ledger.ts`（X 组 AF05 进行中，token 字段迁移）与 `memory-f14-review.test.ts`（非本组既有错）：`checks/af04-tsc.log`
- `npx biome check` 本组 5 个文件：`No fixes applied` 干净：`checks/af04-biome.log`

## 范围扩展说明

advisor 确认后把同一 AF04 缺陷在 embed/extraction 调度链路上的展开一并修了（`extraction-scheduler.ts` 的 `requestExtraction` 与 `embedForSession`、`tools.ts` embed handler）——同一个 job 来源项目判定问题，同一个小 helper `resolveMemoryProjectRootById` 复用。不改会让 embed/提炼续作走老路，等于修一半。

## 事故披露

中途误跑过一次 `git stash` 想做 biome 基线，扫走了 X/Z 组的未提交改动。已用 `git show stash@{0}:<path>` 导出本组 4 个文件 + `git stash pop` 冲突部分手工合并恢复，X/Z 组现场确认无丢失（host-mount.ts 的 AF06 标记、in-progress budget-ledger.ts 均在）。stash 已 drop。**未提交、未 reset、未 checkout**，符合任务书禁令。

## 未验证与限制

- 全部用例走 `mkdtempSync` + 假 `streamSimple`（`modelRegistry.streamSimple` 计数即探针），**零真实外发**。
- 未跑真实 PAO_HOME（任务书禁），未起 worker 子进程，未碰桌面端。
- `embed` handler 的来源项目判定按 taskScope 走 `parseScopedMaintenanceJob`（`taskId`/`projectId`/`executionRoot`），evolve 走 `parseEvolveJobScope`——两条路径都先取 sourceScope 根、再反查库，行为一致。
- `requestExtraction`/`embedForSession` 在 projectId 反查不到时退回 `ctx.cwd`——这是「新批登记方本进程即来源」的合理兜底，与 evolve 的「拒绝」不同（evolve 是跨会话续作场景，embed/提炼的 ctx.cwd 兜底本就是现行语义）。

## 运行过的命令

```bash
cd packages/coding-agent && node ../../node_modules/vitest/vitest.mjs run test/pao/evolution-af04.test.ts --maxWorkers=1
cd packages/coding-agent && node ../../node_modules/vitest/vitest.mjs run test/pao/evolution-o10.test.ts test/pao/memory-maintenance.test.ts test/pao/memory-extraction-scheduler.test.ts test/pao/memory-embeddings.test.ts test/pao/memory-extraction-jobs.test.ts --maxWorkers=1
cd packages/coding-agent && npx tsc --noEmit
cd PAO && npx biome check <本组 5 个文件>
```

日志在 `.pao/自进化修复-20261118/checks/`。

## 主代理复核（2026-11-18）

- 补充反面场景：作业登记的执行根仍存在但已属另一项目（projectId 仍是 A，执行根指向 B）。原实现只要执行根存在就直接用，会按 B 的许可放行。
- 修复：`tools.ts` `resolveEvolveJobOutboundRoot` 先核对执行根现在解析出的 projectId 与作业一致，不一致改按 projectId 反查持久身份。
- 用例：`evolution-af04.test.ts`「作业登记的执行根已属 B 项目、projectId 仍是 A；A 不允许而 B 允许 → 按 A 拒绝，零外发」。去掉核对时该用例失败，加上后 6/6 通过（`checks/af04-test-main-review.log`）。
- 事故记录：Y 组执行中误跑过一次 `git stash` 后自行恢复；内核仓 stash 列表已空，X/Z 改动的最终完整性在整合阶段统一复跑全部 AF 测试确认。
