# 简报与侦察交接阶段报告

## 结论

本次已收口主对话要求的侦察边界、V04 卡定义保护、地图/契约版本与执行工作树核验：

- 侦察工具保存结果时，不再回写源卡 `inputs`，源卡文件保存前后逐字一致。
- 侦察输出引用保存到当前 attempt 的独立交接记录，依赖路由读取该记录。
- 新派发路径可固定使用 `dependencyReconMode: "handoff-only"`，完全不扫描上游卡旧 `inputs`。
- 交接记录的执行绑定摘要可以和当前 `ExecutionBinding.bindingDigest` 精确比对；不一致返回 `execution_binding_invalid`。
- prepare 捕获卡定义摘要，freeze 重读并比对，verify 再从磁盘重读并比对。冻结后即使只增加一条仍能解析的 `inputs`，也返回 `card_changed`。
- 地图覆盖路径全程使用仓库相对路径，真实 Windows 暂存、未暂存、未跟踪内容都进入摘要；覆盖外提交不使地图失效。
- 已知 dirty 基线在主目录和 linked worktree 内容一致时可复用；覆盖内内容变化返回 `stale_map`。
- 契约保留原绝对 `ref`，另存仓库相对 `contentPath` 和保存仓库根；核验映射到实际执行工作树。只改 linked worktree 契约时返回 `contract_changed`。
- 契约/地图新版可用 `previousRef + supersessionReason` 追溯旧版；旧产物、旧快照和旧卡保留。
- 升版影响只命中现有 `inputs` 精确引用旧版或新版 URI 的未终态卡，输出 `action: "checkpoint"` 影响事件并交给宿主现有通知回调；无关卡继续运行。
- 同一上游侦察产物按实现、规划、审核用途装配；审核正文使用当前 attempt 回执中的 `changes`、`verification`、风险和证据。

截至 2026-10-20，定向 24 例全部通过，内核 `tsc -p tsconfig.build.json --noEmit` 退出 0，`check:gates` 三项退出 0。

## 精确接口

### 依赖侦察来源

```ts
interface DispatchBriefInput {
  // 默认值保持旧卡兼容；新 dispatch-core 固定传 handoff-only。
  dependencyReconMode?: "handoff-only" | "handoff-then-legacy-inputs";

  // 可选。返回当前依赖尝试由 execution-context 解析出的身份。
  dependencyExecutionBinding?: (key: {
    cardsDir: string;
    cardNo: number;
    attempt: number;
  }) => DispatchLiveBindingInput | Promise<DispatchLiveBindingInput>;
}

prepareDispatchBrief(input: DispatchBriefInput): Promise<DispatchBriefDraft>;
```

`handoff-only` 的语义：

- 依赖卡当前 attempt 有交接记录时，只读交接记录中的侦察产物。
- 没有交接记录时贡献空数组；不读取依赖卡 `inputs`。
- 提供了 `dependencyExecutionBinding` 且交接记录存在时，`handoff.bindingDigest` 必须等于返回的 `digest`，否则拒绝 `execution_binding_invalid`。

### 独立读取并核验交接

```ts
resolveCurrentAttemptReconRefs(input: {
  cardsDir: string;
  cardNo: number;
  attempt: number;
  executionBindingDigest: string;
  executionBindingRef?: string;
  requireHandoff?: boolean;
}): DispatchArtifactReference[];
```

返回 `{ ref, digest }[]`。

- 没有记录：默认返回 `[]`；`requireHandoff: true` 时返回 `missing_input`。
- 绑定摘要或绑定引用不符：抛出 `execution_binding_invalid`，details 带 `path`、`expectedDigest`、`actualDigest`。
- 记录损坏、产物摘要不符或身份不符：抛出 `bad_reference`。

Dirac 可先按依赖卡当前 attempt 调用 `resolveExecutionContext(...)`，再把其 `bindingDigest` 传给此函数。也可把同一解析函数传给 `prepareDispatchBrief({ dependencyExecutionBinding })`，让正文装配直接完成核验。

### 侦察保存

```ts
commitDispatchReconResult(input: CommitDispatchReconInput): Promise<DispatchReconCommitResult>;
```

只保存侦察产物和 attempt 交接记录。不会调用 `appendCardInputReference*`，不会改写源卡定义，也不会覆写执行输入快照。

### 卡定义

```ts
interface DispatchCardDefinitionSnapshot {
  goal: string;
  dept: string;
  inputs: string[];
  constraints?: string;
  acceptance: string;
  depends_on: string[];
  parent?: string;
  tier?: "fast" | "primary";
  budget?: CardBudget;
  priority?: "high" | "medium" | "low";
  created: string;
  definitionDigest: string;
}

interface DispatchBriefDraft {
  cardDefinition: DispatchCardDefinitionSnapshot;
}

interface DispatchInputSnapshot {
  cardDefinition?: DispatchCardDefinitionSnapshot;
}
```

新冻结快照一定写入 `cardDefinition`。旧快照仍可加载；verify 发现缺失时 fail-closed，返回 `card_changed`。

`DispatchPreflightIssue` 新增可选字段：

```ts
{
  code: "card_changed";
  message: string;
  path: string;
  field: "cardDefinition";
  expectedDigest: string;
  actualDigest: string;
}
```

运行态 `owner`、`attempt`、`status`、`completed` 和正文回执不进入卡定义摘要；`inputs`、目标和依赖数组保持原顺序。

### 地图覆盖与复用

```ts
captureDispatchMap(input: DispatchMapInput): DispatchMapArtifact;

sameDispatchMapCoverage(
  saved: DispatchMapArtifact,
  current: DispatchMapArtifact,
): boolean;
```

- `coverage.paths`、文件快照 `files[].path` 和排除路径都是仓库相对路径；Windows 测试验证结果不带绝对根。
- 每个覆盖文件保存 HEAD、index、working 和实际内容摘要；未跟踪文件也纳入。
- 复用只比较覆盖范围、边界确认依据和覆盖内文件身份。`repo.head`、`treeId` 只留作采集证据，不因无关提交或覆盖外文件变化而全局失效。
- 声明 `scopeConfirmed: true` 时必须同时给出 `scopeBasis`；只有目录覆盖不能推断调用边界已确认。

### 契约版本与执行工作树

```ts
interface DispatchContractVersionRecord {
  id: string;
  version: string;
  /** 原始绝对定位，供人查看和兼容；核验不直接读取。 */
  ref: string;
  projectRoot: string;
  /** 保存时真实 Git 顶层，可选以兼容旧记录。 */
  repositoryRoot?: string;
  /** 相对 repositoryRoot；非 Git 项目相对 projectRoot。 */
  contentPath?: string;
  contentDigest: string;
  previousRef?: string;
  supersessionReason?: string;
}

resolveDispatchContractContentPath(input: {
  artifact: DispatchContractReference;
  projectRoot: string;
  executionRoot: string;
}): string;
```

路径解析先按共同 Git 目录核验保存仓库与执行根同仓，再把 `contentPath` 映射到执行工作树。父子目录关系不用于判断同仓。`precheckDispatchReferences` 和 `verifyDispatchSnapshot` 共用此函数；执行工作树契约变化返回 `contract_changed`，issue 的 `path` 指向实际执行工作树文件。

### 升版影响与 checkpoint 回流

```ts
interface DispatchReferenceImpact {
  ref: string;
  previousRef?: string;
  reason?: string;
  affected: Array<{
    cardNo: number;
    cardPath: string;
    status: CardStatus;
    attempt: number;
    owner?: string;
    matchedRef: string;
    action: "checkpoint";
    message: string;
  }>;
  ignored: number[];
}

findDispatchReferenceImpact(input: {
  cardsDir: string;
  ref: string;
  previousRef?: string;
  reason?: string;
}): DispatchReferenceImpact;

formatDispatchReferenceImpact(
  impact: DispatchReferenceImpact,
): string | undefined;
```

`affected` 只包含卡现有 `inputs` 精确引用旧版或新版 URI 的 `unclaimed`、`in_progress`、`failed` 卡；`delivered`、`canceled` 和无关卡进入 `ignored`。`affectedCards` 是可追溯元数据，不是强制提醒名单。工具保存替代版本后调用 `DispatchBriefToolOptions.onReferenceImpact`。当前宿主只消费通知文本，Dirac 必须在 runtime 消费 `action: "checkpoint"` 并进入现有 checkpoint/停发回流。旧 attempt 的输入、证据和回执不改。

## 验证

已实际运行：

```text
npm test -- --reporter=verbose test/pao/dispatch-brief-artifacts.test.ts test/pao/dispatch-brief-prepare.test.ts
2 files passed, 24 tests passed

npm exec tsc -- -p tsconfig.build.json --noEmit
exit 0

npm run check:gates
导入副作用、边界、路径入口全部 PASS
```

关键真实用例：

- `冻结后改写卡 inputs 明确报告 card_changed，旧快照保留冻结定义`
- `handoff-only 不扫描旧卡 inputs，且交接绑定摘要必须匹配当前 ExecutionBinding`
- `侦察角色结果可通过保存原语生成受控摘要，并由卡依赖自动进入实现/规划/审核正文`
- `覆盖外提交不使地图过期，覆盖内文件内容变化仍拒绝`
- `真实 linked worktree 通过共同 Git 目录核验，异仓或伪造共同目录被拒绝`
- `已知 dirty 基线在内容一致的 linked worktree 中复用，覆盖外变化仍复用而覆盖内变化失效`
- `契约升版保留旧版本与旧快照，影响事件命中 pending/active 并排除无关和已终态卡`
- `真实工具保存替代版本时把影响事件交给宿主现有通知回调，旧卡与旧版本不改`
- `linked worktree 中修改契约会拒绝旧简报，即使主目录契约未变`
- `契约升版在简报中保留旧版与原因，旧 attempt 的冻结输入不改`
- `同一上游侦察产物按实现、规划、审核用途装配；审核保留当前回执的 changes、verification、风险与证据`

侦察保存前后用 `readFileSync` 比较整张卡文本，确认逐字不变；工具保存结果后，上游卡交付，下游 `depends_on` 简报正文仍包含侦察 facts、unknowns 和 evidence。

替代链测试在升版前后比较 pending、active、无关和已交付卡的文件字节，并比较旧简报产物字节，确认均未改写。真实工具测试还断言宿主回调收到同一影响对象。

## 首次失败与修正

保留失败经过：

1. 新增 V04 用例首次失败：夹具只预期初始两条 `inputs`，实际 setup 已加入地图和契约 URI。实现捕获的四条内容与卡面一致；测试改为核对完整冻结值，再校验新定义摘要变化。
2. handoff-only 反例首次失败：测试漏导入 `executionContextPath`。补齐导入后继续运行。
3. 第二轮反例失败：无 handoff 时测试错误期待绑定摘要拒绝；实现正确地不扫描旧输入。拆成“无 handoff + 错绑定仍无旧输入”和“有 handoff + 错绑定拒绝”两个分支。
4. 第三轮反例失败：`saveDispatchReconHandoff` 夹具漏传 `cardPath`，真实保存原语拒绝 `undefined`。补齐路径后最终 18/18。
5. `precheck.ts` 的 `card` 曾改为不可缺省类型以消除静态告警，随即被 `tsc` 明确报“使用前未赋值”；恢复为 `ParsedCard | undefined`，继续依靠各分支的 `if (card)` 执行检查。
6. 根仓直接跑 `npm test` 时，Windows 消费方脚本把 `C:\Program Files\node.exe` 未加引号，2 个既有脚本用例失败；随后使用 coding-agent 包真实 Vitest 入口。仓库根没有 `tsconfig.build.json`，实际内核配置位于 `packages/coding-agent`。
7. linked worktree 契约用例首次失败：`bindingDigest` 使用测试自造字符串，真实冻结门要求 `sha256:` 格式；改为合法摘要后继续。
8. 同一用例第二次失败：新 worktree 里没有未提交的契约文件，执行工作树核验正确报 `missing_input`；夹具先写入与主目录一致的契约内容。
9. 替代链用例首次失败：测试漏建 `src/contract.md`，在保存前即报文件不存在；补齐真实文件后继续。
10. 替代链第二轮失败：测试把无关卡号放入 `affectedCards` 并期待命中，暴露出强制名单会误伤无关任务；实现改为只按卡现有 inputs 精确引用判断，测试改为断言无关卡进入 `ignored`。
11. 工具替代链首次失败：测试漏传 `project_root`，真实参数门拒绝；补齐后继续。
12. 角色用途用例首次失败：审核依赖的实现卡尚未交付，真实前置门返回 `missing_input`；补齐实现卡的当前 attempt 回执与交付状态后继续。
13. 契约升版正文用例首次失败：绑定对象已有替代元数据，但正文只显示新版引用，未显示旧版和更新原因；补充正文行后通过。

## 未覆盖与边界

- 本次没有修改调用方 `worker/dispatch-core.ts`。Dirac 接入新派发路径时，应固定传入 `dependencyReconMode: "handoff-only"` 和 `dependencyExecutionBinding`。
- 本模块已输出影响事件并验证宿主回调接点；当前 `src/pao/index.ts` 的回调仍只调用 `notifySurface.notify`，不能视为运行中升版回流。Dirac 必须在其真实 runtime 写集消费 `action: "checkpoint"`，实际停止或阻止相关 pending/active 任务继续使用旧输入，并接入现有 checkpoint/blocked 回流；无关任务继续。模块不直接改卡状态。
- `dependencyExecutionBinding` 必须由 Dirac 正式派发路径实际传入，并从当前依赖 attempt 的 cards/execution-context 正本解析 `ref/digest` 与执行根字段；新派发固定 `dependencyReconMode: "handoff-only"`，不得静默回退上游卡旧 inputs。
- 普通非 Git 旧卡无地图的模块测试已通过；真实 worker/host 主路径由 Dirac 按其写集接入并验证。
- 本次未在正式 PAO_HOME 或付费模型上运行，未自动提交。
