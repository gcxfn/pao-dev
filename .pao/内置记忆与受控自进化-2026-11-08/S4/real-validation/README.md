# S4-18 记忆验收入口

入口提供冻结输入校验、离线机械性能、基础场景 runtime、I04 stale adapter、
I06/I09/I10 boundary adapter、I07/I08 生命周期 adapter 和 20 条同义查询薄入口。
真实模型与嵌入批次要等 S4-17 发行物通过，并由主线显式启动。当前文档中的真实运行命令
没有实际执行。

## 命令

从项目根执行：

```powershell
node PAO/packages/coding-agent/scripts/run-memory-acceptance.mjs --validate-only
node PAO/packages/coding-agent/scripts/run-memory-acceptance.mjs --benchmark-local
node --test PAO/packages/coding-agent/scripts/runtime.test.mjs
node --test PAO/packages/coding-agent/scripts/memory-acceptance-lifecycle.test.mjs
node --test PAO/packages/coding-agent/scripts/run-memory-acceptance.test.mjs
node --test scripts/memory-acceptance-stale.test.mjs
node --test PAO/packages/coding-agent/scripts/memory-semantic-validation.test.mjs
```

结果写到 `.pao/内置记忆与受控自进化-2026-11-08/S4/real-validation/runs/<run-id>/`：

- `validation.json`：冻结 schema、场景能力状态和零网络／零产品库写入证据。
- `execution-plan.json`：真实 SDK 装配、别名映射、证据字段、I04/I07 顺序、I06/I09/I10 路由和 I08 删除契约。
- `frozen-inputs/`：本次实际读取的 I01—I10、20 条同义查询和独立 I01 补充输入。
- `benchmark.json`：1千／1万条确定性机械造数的本地检索结果。它与真实语义召回质量分开记录。
- `real-gate.json`：真实运行的显式授权、S4-17 manifest 和 `PI_OFFLINE` 门控证据。
- `basic-scenario.json`：门控通过后，基础 runtime、boundary adapter 或生命周期 adapter 返回的实际装配与执行证据。
- `external-usage.json`：helper 执行期间由 `createFetchUsageObserver` 记录的外部请求。

## 当前能力状态

| 场景 | 当前能力 |
|---|---|
| I01/I02/I03/I05 | 基础 runtime 可离线执行；显式 `executeReal=true` 后走真实 SDK prompt、提炼任务和检索。 |
| I04 | 独立 adapter 已完成页面纠正/迟到交付接缝和请求快照离线验证；真实模型尚未运行，`not_proven`。 |
| I06 | 独立 boundary adapter 已完成离线模拟：真实 Git 主仓、linked worktree 与同名非 Git 根的隔离均已验证；真实模型入口已接入，尚未运行。 |
| I07 | 生命周期 adapter 已完成离线 faux SDK 验证；真实模型验收仍为 `not_proven`。 |
| I08 | 生命周期 adapter 已接通真实服务与协调器；离线 faux SDK 用例已验证来源回复清理、共享保留与递归纳入，结果为 `completed_offline`，真实模型验收尚未运行。 |
| I09 | 独立 boundary adapter 已完成离线模拟：独立进程重开来源、归档缺失和来源动作分流均已验证；真实模型入口已接入，尚未运行。 |
| I10 | 独立 boundary adapter 已完成显式拒绝、缺许可和允许后端点失败的离线模拟；真实模型入口已接入，20 条质量批次仍待真实 embedding。 |

I04 使用独立的 stale adapter，详见 [I04.md](I04.md)。I06/I09/I10 使用独立 boundary
adapter；在线状态是 adapter 已就绪、真实结果未证明，不计入基础普通链。

## CLI 与真实门控

CLI 的 `--scenario` 可明确选择 `I01`—`I10`。`I07/I08` 仍由 `runBasicScenario`
转交 `runLifecycleScenario`；I04 仍由基础 runtime 返回精确 `incomplete`；
I06/I09/I10 则直接分派到 `runBoundaryScenario`。

`real` 模式先校验 `--mode real`、`--allow-real`、S4-17 通过 manifest 和实际存在的 artifacts，并拒绝把 `PI_OFFLINE`、skip 或 fake model 记作通过。门控失败时不会加载 runtime，网络请求为 `0`。

基础 runtime 与生命周期路径的参数形态：

```javascript
runBasicScenario({
  scenarioPath,
  runRoot,
  executeReal: true,
  authPath,
  modelsPath,
  model: { provider, id, thinkingLevel },
  tierConfig,
  prompt,
  jobTimeoutMs,
  signal,
});
```

I06/I09/I10 门控通过后调用 boundary adapter 支持的参数形态：

```javascript
runBoundaryScenario({
  scenarioId: "I06",
  runRoot,
  executeReal: true,
  authPath,
  modelsPath,
  tierConfig,
  tierName,
  signal,
});
```

基础场景命令形态：

```powershell
node PAO/packages/coding-agent/scripts/run-memory-acceptance.mjs `
  --mode real `
  --allow-real `
  --manifest <S4-17通过manifest> `
  --scenario I01 `
  --auth-path <只读auth.json路径> `
  --models-path <只读models.json路径> `
  --model magpie/group/deepseek `
  --tier-config <档位JSON路径>
```

I06/I09/I10 使用同一门控和凭证参数，以场景 ID 与档位名选择专用 adapter：

```powershell
node PAO/packages/coding-agent/scripts/run-memory-acceptance.mjs `
  --mode real `
  --allow-real `
  --manifest <S4-17通过manifest> `
  --scenario I06 `
  --auth-path <只读auth.json路径> `
  --models-path <只读models.json路径> `
  --tier-config <档位JSON路径> `
  --tier-name fast
```

`--scenario I06` 可替换为 `I09` 或 `I10`。这几个场景的提炼模型由档位配置中的
`provider/model/thinkingLevel` 决定；`--model`、`--thinking-level`、`--prompt` 和
`--job-timeout-ms` 用于基础 runtime 的会话与提炼参数，不会作为未声明字段传给 boundary adapter。

`--model` 按第一个斜杠切分：`magpie/group/deepseek` 得到 provider `magpie` 和 model ID `group/deepseek`。也可以用 `--model-provider` 与 `--model-id` 分列，但两种写法不能混用。`--thinking-level`、`--prompt` 和 `--job-timeout-ms` 按需追加。凭证和模型目录只以路径参数传入；CLI 不复制 `auth.json`，不改正式授权文件，不输出密钥值。

`executeReal` 默认是 `false`。离线生命周期 adapter 使用 faux provider，但会走实际的 `session.prompt()`、提炼调度、持久 job、`MemoryService` 和 `session.compact()`；faux 结果只用于链验证，不构成 I07/I08 真实验收。I06/I09/I10 的离线 boundary 模拟同样只证明动作与边界，不构成真实模型验收。真实运行仍等待 S4-17 通过后由主对话显式启动。

helper 调用前安装 lib 的 `createFetchUsageObserver`，并在 `finally` 中恢复原 `globalThis.fetch`。生命周期定向测试还会替换 `globalThis.fetch` 为抛错计数桩，断言零次调用。外发许可继续由产品 `PAO_OUTBOUND_CONFIG` 和隔离 home 配置决定；CLI 不设置默认许可。

## 输入与模型证据

根冻结场景仍是输入正本，位于 `PAO/packages/coding-agent/test/pao/fixtures/memory/scenarios/`。runtime 和测试读取该目录中的 `I01.json` 等正本，不依赖 `.pao` 下的离线复制产物。

冻结 assistant 输入只被补齐实际 `AssistantMessage` 所需的合法元数据：`api/provider/model/usage/stopReason` 等。每条输入证据标 `inputFixture: true`，assistant usage 标 `usageBasis: synthetic`，记录为 `metadataBasis: fixture_synthetic_assistant_metadata`。合成 usage 只让 SDK 能正确处理历史输入，不计作真实模型请求、真实 token 或真实费用。

`observeStreamSimple` 记录原始请求上下文、最终 payload（公开回调可见时）、响应状态／header Request ID、原始 assistant message、输出文本、迭代事件、延迟、usage 和失败取消。公开面拿不到的 HTTP body 记 `unavailable_public_surface`；接口未返回的字段记 `unknown`。

供应商未提供价格依据时，`normalizeUsage` 的费用字段统一记 `unknown`，并记 `costBasis: unknown`、`costSource: unknown`。faux provider 的费用标 `synthetic`，来源为 `faux_provider`；不会把缺价格的 `0` 说成实际费用。

## I07：压缩、重启与恢复

`runLifecycleScenario()` 对 I07 执行：

1. 用实际 SDK 装配持久 `SessionManager`、PAO extension、只读 `ModelRuntime` 和隔离 `PAO_HOME`。
2. 经实际 `session.prompt()` 触发提炼，并等待持久 job 进入 `done`。
3. 调用真实 `await session.compact()`，检查 session JSONL 新增原生 `compaction` entry。
4. 关闭 session，确认所有权锁释放；用 `SessionManager.open()` 重开同一文件并重新取得锁。
5. 调用 `MemoryService.searchMemory()`，再发 prompt 观察 resident 注入。
6. 重复同一 prompt，确认同一 memory revision 不新增第二条自动召回。

resident 渲染把 memory ID 和 revision 放在同一元数据组中，例如 `记忆ID <id>｜rev-N`。adapter 分别断言这两个真实字段，不依赖不存在的拼接字符串。I07 离线测试保留 prompt 输入输出、提炼请求、模型响应、usage、延迟、compact 事件、关闭／重开和锁证据。

## I08：停用、恢复与彻底删除

I08 用两个持久会话分别执行实际 prompt 和提炼，然后按冻结顺序调用真实公开面：

`stop → search → restore → delete → readDeletionOperation → resumeDeletion`

删除前，两个活动会话各自持有真实所有权锁，因此 `deleteMemory()` 必须返回 `pending`。adapter 关闭并重开当前实际持有的 session，取新锁后，将真实 `prepare/close/reload` coordinator 接入新的 `openMemoryService`，再读取并恢复删除操作。删除最终要求：

- operation `complete`，`pendingObjects` 为空。
- target memory、当前／历史正文、FTS、vector、source link 和 usage 不残留。
- session、archive、artifacts、attachments、index 和数据库均被扫描。
- `sourceId/sessionId/entryId`、exclusion 和 operation 等定位身份可以保留。
- 用原候选和原 source refs 经 `commitExtractionCandidates()` 重放，结果必须是 `source_excluded`，且不复活记忆。

删除范围以 `previewMemoryDeletion()` 返回的 `sources` 和 `sessions[].derivedEntryIds` 为持久选择。派生回复只从已登记用户来源出发，沿实际 `SessionEntry.parentId` 与受管 recall 锚点定位；确认和 resume 消费已保存范围，不再按相似正文扫描会话。每条残留证据记录完整 `needle`、surface、文件路径、行号、entry ID、entry 类型、role、观测正文、`withinUserPreviewSelection` 和 `previewAction`。

当前离线生命周期用例的 `managed_surface_content_absent` 为通过。两轮用户来源后的 assistant 确认回复在 preview 中明确进入 `derivedEntryIds`，删除后目标正文从 session、archive、index 和数据库消失；无关用户消息、回复、entry 身份、父链与 tool call 配对保留。回复同时支撑其他记忆时，默认 `retain` 明确保留共享来源，`include-referencing-memories` 在 preview 中纳入对应 keeper 并清理回复。

该验证使用离线 faux SDK，因此顶层 acceptance 仍为 `not_proven`，不能作为真实模型验收。

## 语义判定与别名

结构化字段按冻结值精确比较。自由文本先检查数字、否定词和明确条件：

- 数字、否定或条件冲突直接 `fail`。
- 归一化后精确一致，或由冻结输入明确声明为同义时 `pass`。
- 字面相似度只用于发现 alias 候选，不能单独产生 `pass`；其余结果进入 `pending_main_review`。
- 实际结果未声明 `evidenceKind` 时不硬判不一致；冻结输入未记录理由时也不补造。

实际 memory UUID 由当时阶段的语义行映射到 `mem-*` 逻辑 alias。I08 来源 alias 只接受
`source_exclusions` 或 `deletion_operation` 身份；活跃 `sources` 行不是必需证据。

20 条同义查询质量入口见 [semantic-20.md](semantic-20.md)。它接受由实际运行证据建立的
scenario scope 与 `alias→{memoryId,revision}` 映射，按 `service.searchMemory()` 实际
返回记录 mode、hits、matchKind、request、latency 和 usage。默认离线只校验输入且零网络；
真实模式要求隔离许可和成功 embedding。未映射 alias 保持 `incomplete`，词法命中、
degraded 或缺失真实 semantic 证据不能记作通过。

I10 的 deny/降级验收和 20 条质量子批次分列。deny 时可验证词法降级行为，但它不能作为
质量批次的语义通过；质量批次必须在隔离的明确许可下真实调用 embedding。

## 真实批次边界

`real` 入口一次执行一个显式选择的场景。I01—I10 批次编排、运行后逐字段语义判定和交付报告尚未接入本 CLI；成功返回执行证据的场景以 `pending_main_review` 表示等待主线判定。

S4-17 manifest 最小结构：

```json
{
  "schemaVersion": 1,
  "ticket": "S4-17",
  "status": "passed",
  "artifacts": [{ "path": "发行物相对路径或绝对路径" }]
}
```

`artifacts[].path` 相对 manifest 所在目录解析，且每个路径必须实际存在。`PI_OFFLINE`、skip、fake model 或缺失 manifest 都不能记为通过。

## 隔离与限制

运行使用 S4 专用临时 `PAO_HOME`、`agentDir`、会话目录、worktree 状态和项目副本。模型路由及凭证从现有授权入口只读复用，不复制凭证，不改正式 `PAO_HOME`。

当前已知限制：

- I04 adapter 已完成离线接缝验证，但真实模型请求尚未执行，不能记为通过。
- I06 的离线主仓、linked worktree 与同名根隔离已由 boundary adapter 验证；真实模型结果尚未运行。
- I08 的离线生命周期删除验收已通过；真实模型请求尚未运行，不能记为真实模型验收通过。
- I09 的离线重开来源与 `readMemorySource` 分流已由 boundary adapter 验证；真实模型结果尚未运行。
- I10 的离线拒绝/降级分支已由 boundary adapter 验证；真实模型入口与 20 条质量批次尚未执行，当前没有真实 embedding 证据。
- 真实外发 HTTP body 不在公开 view 返回面时只能记 `unavailable_public_surface`，不能用归一化候选冒充原始响应。

## 配置项名称

只列名称，不记录值：

`PAO_HOME`、`PAO_CODING_AGENT_DIR`、`PAO_CODING_AGENT_SESSION_DIR`、`PAO_WORKTREE_STATE_ROOT`、`auth.json`、`models.json`、`models-store.json`、`S4_EXTRACTION_TIER`、`EMBED_BASE_URL`、`EMBED_API_KEY`、`EMBED_MODEL`、`PAO_OUTBOUND_CONFIG`、`PAO_ENV_FILE`、`S4_17_MANIFEST`、`S4_RUN_ROOT`。
