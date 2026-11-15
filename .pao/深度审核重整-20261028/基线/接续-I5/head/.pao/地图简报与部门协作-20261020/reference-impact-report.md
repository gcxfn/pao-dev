# C 接口与依赖切片报告：引用影响与来源门

日期：2026-10-21（Asia/Shanghai）

## 结论

本切片已完成并冻结。`dispatch-brief` 的引用影响、同 ID 契约升版门、显式替代后拒绝旧来源、junction 实际路径判界和旧 attempt 简报间接来源均已按当前源码核对，并有定向测试及独立进程重启证据。

最终定向回归：

```text
test/pao/dispatch-brief-artifacts.test.ts
test/pao/dispatch-brief-prepare.test.ts
Test Files  2 passed (2)
Tests       31 passed (31)
exit        0
```

证据入口：[dispatch-brief-final-tests.log](./dispatch-brief-final-tests.log)、[dispatch-brief-final-tests.exit](./dispatch-brief-final-tests.exit)。

全工程生产类型检查暂未通过：

```text
npm exec tsc -- -p tsconfig.build.json --noEmit --pretty false
exit 1
```

13 个错误全部位于本切片外的 `src/pao/cards/process.ts`（3 个）和 `src/pao/worker/runner.ts`（10 个）。前者涉及 `stop(graceMs?: number)` 与 abort `EventListener` 的签名，后者涉及 `ActiveEntry` 缺 `attempt`、`card_path` 字段。这两处已由主控交其他组处理，本切片未跨写。证据入口：[production-tsc.log](./production-tsc.log)、[production-tsc.exit](./production-tsc.exit)。

## 四项风险门

| 风险门 | 状态 | 已运行证据 | 限制 |
|---|---|---|---|
| 显式替代后重启拒旧 | 通过 | 两个独立 Node 进程；第一进程 PID 12280、退出码 0；第二进程 PID 13948、退出码 0。第二进程重读后，旧地图和旧契约仍可只读加载，`precheck` 与 `verify` 均拒绝两者 | 真实临时 Git 仓库与真实产物；没有启动正式 PAO 宿主 |
| 实际间接引用影响 | 通过 | 前置卡冻结快照经 `depends_on` 命中未终态下游；显式旧 attempt 简报按其 `cardNo + attempt` 命中原快照；无关、终态卡排除 | 影响计算是定向文件/Git/快照测试，没有接 runtime 事件消费 |
| 同 ID 升版门 | 通过 | 首次版本可无替代；完全相同重放幂等；换 version 缺替代参数拒绝；从历史版本分叉拒绝；同版本不同内容拒绝；旧版本仍可加载 | 未引入 semver，不同 ID 不受影响 |
| junction 保存与读取 | 通过 | 工具保存时项目内 junction 指向项目外被拒；冻结后把 `src` 换成 junction，`precheck` 与 `verify` 均报越界 | 使用 Windows NTFS junction 和真实临时目录；不是模拟路径字符串 |

### 同 ID 升版门的真实行为

`saveDispatchContractReference` 的当前源码处理如下：

- 同 `id` 没有已保存当前版本：允许首次保存，不强制 `previousRef`。
- 同 `id`、同 `version`、内容完全相同：返回原结果，保持幂等。
- 同 `id`、同 `version`、内容不同：返回 `artifact_conflict`。
- 同 `id`、不同 `version`：必须同时给 `previousRef` 和 `supersessionReason`。
- `previousRef` 必须指向同 ID 的当前版本；从历史版本分叉被拒。
- 不同 ID 不比较版本语义，不猜测两个 ID 是否相同。
- 旧版本记录保持只读可加载；新派发由 `precheck`、冻结和 `verify` 拒绝已知被显式替代的旧引用。

因此，不能通过“同 ID 写不同 version，但不传替代信息”悄悄覆盖当前指针。覆盖当前指针前先验证替代链。

### 旧 attempt 简报边界

当前支持路径确实允许卡 `inputs` 显式引用上一 attempt 保存的 `pao-brief`。若来源卡后来升到新 attempt，不能用来源卡当前 attempt 代替简报产物自己记录的 attempt。

`briefIdentityRefs` 现按 `artifact.cardNo + artifact.attempt` 读取对应冻结快照。新增回归让旧简报来源卡升到 attempt 2，再让 attempt 0 的下游显式引用 attempt 1 的简报；旧简报所绑定的 contract 升版后，下游仍被命中。旧输入与旧快照未改写。

### junction 两个接点

- 保存接点：`readDispatchContractContent` 和 `saveDispatchContractReference` 使用真实路径判界；工具不再在判界前自行读取 `content_path`。
- 实际读取接点：`resolveDispatchContractContentPath` 对词法路径和 `realpathSync` 结果都判界，复用 `sameRepositoryPath` 判断仓库身份，没有增加无条件小写比较。
- 冻结后的 `precheck` 与 `verify` 都会调用该读取定位，因此 junction 换向不能只绕过保存门。

## 做了什么

本切片直接修改的 8 个文件：

- `PAO/packages/coding-agent/src/pao/dispatch-brief/artifacts.ts`
- `PAO/packages/coding-agent/src/pao/dispatch-brief/impact.ts`
- `PAO/packages/coding-agent/src/pao/dispatch-brief/precheck.ts`
- `PAO/packages/coding-agent/src/pao/dispatch-brief/snapshot.ts`
- `PAO/packages/coding-agent/src/pao/dispatch-brief/tool.ts`
- `PAO/packages/coding-agent/src/pao/dispatch-brief/index.ts`
- `PAO/packages/coding-agent/test/pao/dispatch-brief-artifacts.test.ts`
- `PAO/packages/coding-agent/test/pao/dispatch-brief-prepare.test.ts`

主要行为：

1. 影响计算同时读取卡直接 inputs、当前 attempt 冻结快照、前置卡当前 attempt 快照和简报身份对应的冻结快照，不使用 `affectedCards` 任意名单。
2. 简报身份按产物自己的卡号与 attempt 定位，不拿消费卡或来源卡的当前 attempt 替换。
3. 快照路径直接复用 `snapshot.ts` 导出的 `dispatchInputSnapshotPath`，没有第二份持久路径规则。
4. 地图和契约的显式替代关系复用已保存产物判断；旧版本加载保持只读，新派发在准备、冻结和验证入口拒绝旧引用。
5. 同 ID 契约换版本必须形成从当前版本到新版本的显式替代链。
6. 契约正本保存读取和实际执行根读取共用真实路径判界，防 junction/symlink 越界。
7. `DispatchReferenceImpact` 接口保持不变，没有改动 `pao/index`、`role`、`core`、`cards` 或 `desktop`。

`PAO` 是独立 Git 仓库；这 8 个文件在 `PAO` 内当前都是未跟踪新文件，因此普通 `git diff` 不显示内容。没有提交、reset、stash 或覆盖用户已有的其他修改。

写集 SHA-256 与稳定性检查见 [write-set.sha256](./write-set.sha256) 和 [write-set-stability.json](./write-set-stability.json)。最终检查时 8 个文件的测试前后哈希全部一致。

## 独立进程重启反例

证据目录：[restart-proof](./restart-proof/)。

运行命令：

```powershell
& 'D:\AI\workspace\临时文件夹\地图简报验证-20261020\restart-proof\run.ps1'
```

脚本显式设置 `TMP`、`TEMP`、`TMPDIR` 为临时验证目录。第一进程创建真实临时 Git 仓库，保存地图 v1、契约 v1，冻结含旧引用的卡，再保存地图 v2、契约 v2 后退出。第二进程从磁盘重新加载卡、快照和产物。

真实结果：

- 第一进程 PID 12280，退出码 0：[first-process.log](./restart-proof/first-process.log)、[first-process.exit](./restart-proof/first-process.exit)。
- 第二进程 PID 13948，退出码 0：[second-process.log](./restart-proof/second-process.log)、[second-process.exit](./restart-proof/second-process.exit)。
- 旧地图 v1 与契约 v1 均可只读加载。
- `precheck` 同时返回 `stale_map` 与 `contract_changed`，引用分别为旧地图、旧契约。
- `verify` 同时返回 `stale_map` 与 `contract_changed`，引用分别为旧地图、旧契约。
- 影响计算命中卡 1 的地图与契约来源。
- 第二进程结果中的五项检查全部为 `true`：[second-process-result.json](./restart-proof/second-process-result.json)。

该验证是真实临时 Git 仓库和真实独立 Node 进程；它没有启动正式 PAO 宿主，也没有验证正式 PAO_HOME。

## 验证与边界

### 已修改并实际通过

- 新增/更新 `dispatch-brief` 定向测试，覆盖同 ID 升版、幂等重放、替代链、旧版本只读、旧来源停发、前置卡快照影响、旧 attempt 简报、无关/终态排除、真实 junction。
- 两份 `dispatch-brief` 测试文件最终 31/31 通过，退出码 0。
- 独立双进程重启反例通过。
- 8 个写集文件测试后哈希稳定。
- `git diff --check` 对可比较写集无输出。

### 已检查但未证明

- 代码图状态为 ready，节点 30753、边 156993、索引时间 `2026-10-20T02:49:15Z`，见 [codebase-index-status.log](./codebase-index-status.log)。
- `findDispatchReferenceImpact` 与 `saveDispatchContractReference` 的 `search_graph` 查询均返回 0，见 [codebase-impact-search.log](./codebase-impact-search.log) 与 [codebase-contract-search.log](./codebase-contract-search.log)。因此本次影响结论来自当前源码、定向测试和真实临时 Git，不宣称旧代码图覆盖新文件。
- runtime 事件消费由另一 `index` 作者接线；本切片只提供并测试影响结果与通知回调，没有验证完整宿主事件循环。
- 未运行全量测试、构建、Electron 验收或正式 PAO_HOME。
- 生产 `tsc` 暂红，错误在本切片外，待主控统一复验。

## 待主控处理

1. `index` 作者按现有 `DispatchReferenceImpact` 接口接 runtime 消费；本切片没有改该接口，没有跨写 `index`。
2. 其他组修复 `cards/process.ts` 与 `worker/runner.ts` 后，主控统一复跑生产 `tsc`。
3. 本轮不继续扩展 junction、影响链或重启验证；本切片源码已冻结，仅保留报告与证据。
