# O11 独立复核日志（E06/E07/E08）

核实日期：2026-11-15 · 复核方式：源码审查 + 独立重跑 + 自造反面场景探针

## 重跑数字

| 项 | 命令 | 结果 |
|---|---|---|
| 全量 evolution 测试 | `node ../../node_modules/vitest/vitest.mjs run test/pao/evolution-*.test.ts --maxWorkers=1`（隔离 PAO_HOME、PI_OFFLINE=1、PI_NO_LOCAL_LLM=1） | **13 files / 213 tests 全过**（38.2s）日志 `o11-evolution-vitest.log` |
| tsc | `tsc -p tsconfig.build.json --noEmit` | exit 0，零输出（`o11-tsc.log`） |
| o10 E01 重跑 | `vitest run test/pao/evolution-o10.test.ts` | **15/15 全过**——O10 复核时 E01 断言 passed+publish 失败，O11 落地后转绿确认 |
| 独立探针 | `test/pao/o11-review.test.ts`（7 个自造场景） | **7/7 全过**（`o11-review.log`） |

## E06（空验收/漏交样例得 passed）— 满足

- `evaluate.ts:366` caseResults 空集 → `invalid_input` 拒绝（探针 E06-1 实证：ok=false，消息含「空集」）。
- `evaluate.ts:373-408` 读 plan（注入对象或 `<paoHome>/evolution/validations/<tpId>/plan.json`），按 caseId 比对：未知/重复/缺项 → `completeWithIncompleteVerdict` 写 incomplete 行 + 候选 cancelled。
- 探针 E06-2（漏 holdout）→ incomplete + 候选 cancelled + failure_reason 含 `holdout-0`。
- 探针 E06-3（无 plan 可读）→ incomplete（不静默放行）。
- 既有用例同覆盖：未知 caseId（evaluate.test.ts:640）、重复 caseId(:674)、缺 holdout(:605)。

## E07（runner 不装版本副本 / 完成当通过）— 满足（附 1 个结构性残留）

- `runner.ts:233-256` `materializeVersionCopy`：baseline 物化 `versions/<dirSafe>/<baseVersion>/`、candidate 物化 `candidates/<dirSafe>/<candidateId>/` 到 `workDir/resource/`；源缺失/空目录抛错不静默。boundary.test.ts:417 实证双侧内容差 → baseline failed / candidate passed。
- `runner.ts:489-515`：abortReason→`executionFailure:"cancel"`；`completed=false`（或 completed 未给且 output 空）→`executionFailure:"start"`；`passed=true` 仅表示「会话跑完」。
- `runner.ts:412-414` command：failureKind=start/timeout → 结构化 `executionFailure`；`passed = code===0 && 无 executionFailure`。
- `evaluate.ts:141` `isEnvironmentFailure` 改认 `executionFailure` 字段；`:416` 任一侧环境失败 → incomplete。探针 E07-1 实证 start 的 baseline 不再充当「旧版真失败」。
- `runner.ts:646-774` `createValidationAgentSession` 生产工厂：prioritySkillPaths（skill-path）/additionalExtensionPaths 挂版本副本、SessionManager/SettingsManager/createAgentSession 全用现成 API（已核实签名存在）、tools=VALIDATION_TOOL_ALLOWLIST∩allowedTools、timeoutMs 经 AbortSignal.any 合成、modelConfig.model 钉定 provider/id。boundary.test.ts:497 用 faux provider 实证「同一 provider，baseline 副本输出缺词、candidate 副本输出命中」——机制全链真实，模型假（代码注释如实标注）。
- 回执 `resourceFingerprint`（runner.ts:562）写源目录指纹——E08 绑定的锚点。

## E08（边界审计没进门）— 满足

- `versions.ts:299-501` 审计门在 `publishCandidate` **内部**（passed 终态无出边，编排层无法绕过）：
  1. `auditResourceCapabilityCoverage` — extension → not_ready（version.test.ts:494 实证「能力未覆盖」拒发）；command 同样列缺口。
  2. `checkOwnerSourceLinksIntact`（observe.ts:740）四级 owner：problem→candidate→testPlan→validation。
  3. plan.json 实质篡改：从盘上 plan 重算 `testPlanCaseFingerprint` 与 testPlanId 尾段比对（versions.ts:385-404）——快照自比只证明「可读」，指纹比对证明「未改」。version.test.ts:572 实证。
  4. `auditCandidateForPublish`（boundary.ts:199）：路径逃逸归一化 + assertCandidateWithinScope（**action 已补传** problemRow.action，versions.ts:438）+ verifyManagedInputsIntact + runFileChanges 越区核对。
  5. 双侧指纹绑定：baseline 版本目录重算指纹 vs baseVersion 值（versions.ts:459-470）；candidate 目录指纹 vs runs/ 回执里 `side=candidate` 的 resourceFingerprint 集合（:475-501）。探针 E08-1 实证「换掉 baseline 正文 → 拒发」；version.test.ts:554 实证「改候选文件 → 拒发」。
- 合法路径：version.test.ts:596 发布文件与已验副本逐字一致。
- `recovery.ts:110` 仍有第 4 份私有 `fingerprintDirectory`（activation/control 已改委托 `fingerprintResourceRoot`，recovery 未改）——实施方标注归 O12/O14，属一致性留白非 blocker。

## 结构性残留（如实记录）

1. **kind="agent" reproduction 永远到不了 passed**：runner 对正常收尾的会话一律 `passed=true`，baseline 侧也一样 → evaluate 里 reproduction 组 baseline.passed=true → incomplete（前提不成立）。生产编排（tools.ts:1349）全部用例走 kind=agent → **reproduction 永远 incomplete → 候选永远 cancelled → 永远不发**。
   - 判定：方向是 fail-closed（宁停不发），符合审核「不造假通过」的口径；代价是 agent 通道的进化闭环在功能上走不通——真实技能改善只在 kind=command 通道可达 passed/publish。**建议归 O15**（真 provider + output-vs-acceptance 判据一起解）。
2. **acceptance 文本从不与 output 比对**：evaluate 只信 `passed` 标志与 executionFailure；agent 会话正常返回即 passed=true → normal/holdout 组「答错也算过」。command 用例由 exit code 代理判据，成立；agent 用例缺「答案核对」层。同上被 reproduction-incomplete 掩盖（发不出去），但属审核口径「错误答案不可通过」的未闭合点。**建议归 O15**。
3. `repairedContradictions` 保留为输入字段但不改判定（注释自说明）——符合审核「不稳定不宣称改善」口径，incomplete 由逐项逻辑自然得出。
4. `evolve-handler.ts` 测试夹具把三组并在一起跑（304 行），生产 tools.ts 是分 dev/holdout 两批（1376/1388）——语义等价（holdout 仍在定稿后），无行为差。

## 结论

**O11 可关闭。** E06/E07/E08 三条审核缺陷的最小修法全部落盘且亲验通过；审计门在 publish 内部；O10 遗留 E01 已转绿。结构性残留（agent 通道 acceptance 核对/reproduction 可发布性）如实归 O15；recovery.ts 第 4 份指纹重复归 O12/O14 清理。
