# I06/I09/I10 独立验收 adapter

入口为 `PAO/packages/coding-agent/scripts/memory-acceptance-boundaries.mjs` 的 `runBoundaryScenario(options)`，定向测试为同目录的 `memory-acceptance-boundaries.test.mjs`。adapter 只接受冻结场景 I06、I09、I10。

## 运行口径

默认离线运行不需要 auth、models 或网络：

```js
await runBoundaryScenario({
  scenarioId: "I06",
  runRoot: "D:/AI/workspace/临时文件夹/记忆边界验收",
});
```

离线仍调用实际 `requestExtraction`、`commitExtractionCandidates`、`SessionManager`、`createCapture`、`MemoryService` 与归档 API；模型输出由 adapter 内明确的 mock registry 提供。结果状态固定为 `simulation_only`，`acceptance.realAcceptanceClaimed` 固定为 `false`，不能作为真实 I 场景通过。

真实入口须由 S4-17 通过后显式传入 `executeReal: true`：

```js
await runBoundaryScenario({
  scenarioId: "I09",
  executeReal: true,
  runRoot,
  authPath,
  modelsPath,
  tierConfig,
  tierName: "fast",
  signal,
});
```

真实模式只接受 `authPath`、`modelsPath`、`tierConfig`（或 `tierConfigPath`）、`tierName`、`runRoot` 和 `signal`。auth 与 models 由 `ReadOnlyAuthStorage` / `ModelRuntime` 直接读取，不复制到隔离现场，不修改正式 PAO_HOME 或全局配置。现有授权示例为 `C:/Users/ASUS/.pi/agent/auth.json` 与 `C:/Users/ASUS/.pi/agent/models.json`；模型档位可使用 `magpie/group/deepseek`，其中 model id 保留斜杠。

## 场景边界

I06 在 `runRoot` 下创建真实 Git 主仓、真实 linked branch `worktree-feature`、另一目录下的同名 `pao-dev` 非 Git 根和隔离运行 home。两个冻结会话分别用真实 execution root 建立 `SessionManager`，`projectId` 只取自实际 `resolveMemoryScope`。冻结夹具里的 `pao-dev` 只映射到实际项目 ID 供断言，不写入数据库。主仓与 worktree 应指向同一记忆和项目 ID，同名其他根不得命中。

I09 先经实际来源回读组装提炼输入并提交决定，再用现有 `sealSegment` 封存归档段。服务、模型运行时、账本和 session 宿主关闭后，adapter 启动独立 Node 子进程，用同一隔离 home、实际 sourceId、sessionId 和 entryId 重开只读 `MemoryService`。随后临时移走归档文件，确认同一读取返回 `source_missing`，并及时恢复文件。冻结输入中的 `query: readMemorySource src-sess-j-001` 执行来源读取动作，不进入普通搜索。

I10 对同一条实际入库决定依次验证三组隔离许可：显式 deny、许可文件缺失、允许但本地 HTTP 端点返回 503。三组都走实际 `MemoryService.searchMemory` 和 `getMemory/readMemorySource`；拒绝与缺许可时本地端点请求数为 0，允许失败分支产生本地请求并显示语义降级。没有使用 fake 成功向量，也没有把缺失许可自动放行。

## 证据

每次运行在 `runRoot` 下创建独立子目录，并写 `boundary-result.json`。证据包含冻结输入、实际 session/entry/source/memory ID、实际 scope/execution root/branch、模型请求输入输出、提交结果、来源回读、延迟、provider 侧记账条目、许可分支和本地端点请求。mock 用量与归一化零值明确标为 synthetic，不作为零费用；缺失成本统一为 `unknown`。

## 本地模拟验证结果

2026-11-09 使用现有 `dist` 完成两个脚本的 `node --check`，并运行：

```powershell
node --test packages/coding-agent/scripts/memory-acceptance-boundaries.test.mjs
```

定向测试 4/4 通过。I06 验证真实 Git 主仓与 linked worktree 共享实际 project ID、真实 branch 为 `worktree-feature`，另一同名项目根和另一运行 home 均隔离。I09 验证独立 Node 子进程从同一隔离 home 的实际 sourceId 回读原文并核对实际 session/entry，归档文件缺失时返回 `source_missing`。离线时冻结的“并发策略”查询如实记录为语义降级且未命中；另以 `WAL` 词法查询命中同一实际 memoryId，作为本地可达性控制，不冒充真实语义验收。I10 验证显式拒绝与缺许可均为 0 请求，允许但本机端点 503 的分支请求一次并降级，三条搜索路径都命中同一实际 memoryId 且来源可读。

本轮定向测试未发送真实模型或云端 embedding 请求。I10 唯一网络动作是请求 `127.0.0.1` 上的临时 503 服务。所有结果仍为 `simulation_only`，`realAcceptanceClaimed: false`；真实模型入口尚未执行，留待 S4-17 跨宿主实测。
