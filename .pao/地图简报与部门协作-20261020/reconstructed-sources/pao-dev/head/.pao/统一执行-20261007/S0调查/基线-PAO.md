# PAO 内核仓基线检查报告（统一执行计划 §8.1）

日期：2026-10-07。执行者：S0 基线子代理。性质：只跑检查/测试/构建，未修改任何源码、测试、配置；未做 git 操作。
源码身份：`D:\AI\workspace\pao-dev\PAO`，分支 pao-main，含大量未提交修改（既有成果基态）。

## 一、环境

- Node v24.18.0，npm 11.16.0，Windows（win32 10.0.26200），shell 为 Git Bash。
- 隔离设置：`PAO_HOME=D:\AI\workspace\临时文件夹\基线-pao-home-20261007`（新建空目录）、`PI_OFFLINE=1`、`PI_NO_LOCAL_LLM=1`。除基线门净化环境只读回退读使用现场 档位.json（§二步骤 4 已披露）外，未读取正式现场 `D:\AI\workspace\pao`；未写入任何正式数据。
- `PAO\packages\coding-agent\test\AGENTS.md` 不存在（计划要求"执行时再读"，实际无此文件）；隔离口径取计划第 73 行：显式隔离 PAO_HOME＋PI_OFFLINE/PI_NO_LOCAL_LLM。
- 命令形态核对：清单中全部命令与 `PAO\package.json`、`packages\coding-agent\package.json` scripts 一致，无差异。

## 二、逐步结果

| # | 工作目录 | 命令 | 退出码 | 日志（`.pao\统一执行-20261007\基线\`） | 结论 |
|---|---|---|---|---|---|
| 1 | PAO\packages\coding-agent | `npx vitest run test/pao/ --maxWorkers=4`（带隔离环境变量） | 1 | PAO-vitest-pao.log | 150 文件：148 过 2 败；1406 用例：1399 过 7 败（见三） |
| 1a | 同上 | 隔离复验：两失败文件 `--maxWorkers=1` | 1 | PAO-vitest-定向复验.log | host-inventory-dispatch 全过（并发 flaky 实锤）；loadout-tiers-config 仍 5 败（缺 fixture，确定性）。复验命令行未录入日志，复跑依据为定向复验日志时间戳与隔离路径，如需精确命令行可复跑 |
| 2 | PAO\packages\coding-agent | `npm run check:gates` | 0 | PAO-check-gates.log | 内核导入/边界/路径探针 16 项全 PASS |
| 3 | PAO | `npm run build:offline` | 0 | PAO-build-offline.log | 13 包依序构建成功，dist/bundle 74 文件 9.3MiB |
| 4 | PAO | `node scripts/check-baseline-failures.mjs --save-log …\PAO-baseline-failures.log` | 1 | PAO-baseline-failures-run.log（比对输出）＋PAO-baseline-failures.log（JSON 留档） | 较 2026-10-02 基线扩大：新增 15、消失 6；当前 78 败/23 文件（4133 用例） |
| 5a | PAO | `.\node_modules\.bin\biome.cmd check --error-on-warnings .` | 1 | PAO-biome.log（截断版）＋PAO-biome-full.log（全量诊断） | 103 错＋3 警＋5 信（70 文件格式 diff＋organizeImports 33＋杂项 lint 8），未写修复 |
| 5b | PAO | `npm run check:pinned-deps` | 0 | PAO-pinned-deps.log | 通过 |
| 5c | PAO | `npm run check:runtime-deps` | 0 | PAO-runtime-deps.log | 通过 |
| 5d | PAO | `npm run check:ts-imports` | 0 | PAO-ts-imports.log | 通过 |
| 5e | PAO | `npm run check:entry-graphs` | 0 | PAO-entry-graphs.log | 通过 |
| 5f | PAO | `npm run check:install-lock:coding-agent` | 0 | PAO-install-lock.log | 通过 |
| 5g | PAO | `.\node_modules\.bin\tsc.cmd --noEmit` | 1 | PAO-tsc-noEmit.log | 4 条类型错误（见三.3） |
| 5h | PAO | `npm run check:browser-smoke` | 0 | PAO-browser-smoke.log | 通过 |

说明（步骤 4 的门自身行为）：该门自建净化环境（PATH 等白名单），会**剔除外部传入的 PAO_HOME**并自带 PI_OFFLINE/PI_NO_LOCAL_LLM；因此门的全量跑中 `loadout-tiers-config.test.ts` 按测试设计回退读使用现场 `workspace\pao\pao配置\档位.json` 并通过。这是门的既有设计，非本次选择；该文件只被读取，未被修改。

## 三、失败清单与归因

### 1. 步骤 1（test/pao/ 定向回归，4 workers，隔离 PAO_HOME）——7 败

| 用例 | 归因 | 证据 |
|---|---|---|
| host-inventory-dispatch > 全局热会话数超 8（afterEach 钩子 60s 超时） | 环境（并发负载 flaky，既有签名） | maxWorkers=1 复验全过；10-04 `S1-宿主握手修复验证.log` 有同签名，10-04 `S7-整合完整基线.json` 该文件全过 |
| host-inventory-dispatch > 派单交接页指针（断言缺"已把交接页指针附进派卡信封"） | 环境（并发负载 flaky） | 同上：隔离复验全过；同测试在门的全量跑（另一进程编排）中未复现 |
| loadout-tiers-config 5 条（配置文件存在/两档映射/注册/route/resolveTier） | 环境（隔离夹具缺失，非产品缺陷） | 全部为 `…基线-pao-home-20261007\pao配置\档位.json ENOENT`，测试自述"缺失即失败"；10-04 历史隔离现场（临时文件夹\PAO-终端验收-20261004、整体重构-20261005\T09）均播种了该文件。按"唯一写文件例外=日志与报告"纪律未播种；若播种后预期全过（错误发生在读配置之前，未触及产品逻辑；播种后预计全过为推定，未实测） |

### 2. 步骤 4（基线失败门 vs 2026-10-02 基线）——新增 15

| 新增失败（15） | 与 10-04 对比 | 归因 |
|---|---|---|
| tools.test.ts find 4 条＋tool cwd find 1 条；package-command-paths 1 条；3302 四条；3303 两条（共 12） | 全部在 10-04 `P2-基线失败门.log` 新增清单内（当时 tools 共 8 条，其中 grep 3 条现已修复） | 环境/平台差异（Windows），10-04 `P2-实施记录.md` 已给复验证据：rg 把盘符路径当正则转义、/tmp 路径映射语义、chmod 000 不成立；被测源码非 PAO 模块 |
| verifier-run.test.ts 2 条（验收命令取消父孙进程停止；超时 124 树杀不残留） | **10-04 S7 完整基线中该文件全过 → 10-04 之后新增** | 产品侧待查（Windows 真实进程树取消/树杀行为），首要修复候选 |
| host-inventory-dispatch > 热会话超 8（钩子超时） | 10-04 有同签名（握手修复期），S7 基线过 | 环境（并发 flaky，同三.1） |

基线中已消失 6 处（只提示）：tools grep 3 条等，属修复/不再复现，符合"不扩大"口径的存量改善。

### 3. 步骤 5g（tsc --noEmit）——4 条错误，**10-04 为零错误（P2-全仓类型检查.log：TSC_EXIT=0）→ 全部为 10-04 后新增**

- `packages/ai/test/stream.test.ts(705,50)` TS2345：`"claude-sonnet-4-5"` 不在当前模型目录联合类型内——上游测试数据与模型目录漂移。
- `packages/coding-agent/test/pao/results-aggregate.test.ts(194,305,306)` TS2339：`NodeDiffSection` 上不存在属性 `原因`——PAO 类型与测试脱节，首选修复候选。

### 4. 步骤 5a（biome 无写入检查）——103 错/3 警/5 信

分布：约 70 文件 format diff＋33 处 organizeImports＋8 处杂项（useLiteralKeys 3、useTemplate 2、noUnusedImports 2、noUnusedVariables 1），几乎全部落在本轮未提交的 PAO 模块（src/pao、test/pao）及 `src/core/extensions/loader.ts`、`src/modes/interactive/components/user-message.ts`。归因：产品侧既有（工作区累积未格式化），非环境、非本次引入；计划允许对明确文件列表定向 `biome --write`（本轮未做）。

## 四、与旧基线逐例对比小结

- 对比基准：`\.pao\并行实施-20261002\产物\基线测试-coding-agent.log`（门默认基线，68 败/21 文件）＋`\.pao\后续执行-20261004\`（P2-基线失败门.log、S7-整合完整基线.json、P2-全仓类型检查.log、S1-宿主握手修复验证.log）。
- 旧已败今已愈：10-04 的 pao 三败（loadout-role、wiring-smoke、workflow-save）与 fanout-baseline、knowledge-maintenance、tools grep 3 条均已转绿——存量收敛。
- 旧集合内仍在：tools find/cwd、3302、3303、package-command-paths（Windows 平台组，12 条）。
- **真新增（10-04 S7 基线没有）**：verifier-run 2 条（产品侧待查）、tsc 4 条（类型门由零变四）、biome 103 条（格式门，工作区累积）。

## 五、建议列入首个修复包

1. `results-aggregate` 的 `NodeDiffSection.原因` 类型脱节（3 处 tsc 错，PAO 自有代码）。
2. verifier-run 两条 Windows 进程树取消/树杀失败（新增，涉真实进程行为，先隔离复跑定性再修）。
3. `packages/ai/test/stream.test.ts` 模型名与目录联合类型对齐（1 处 tsc 错）。
4. 对 biome 清单文件定向 `--write`（格式/导入排序/未用导入，机械修复，须按计划只对明确文件列表）。
5. 隔离测试规程补充：隔离 PAO_HOME 需播种 `pao配置/档位.json`（历史现场有先例），否则 loadout-tiers-config 5 例在隔离环境下必败。
6. host-inventory-dispatch 钩子 60s 超时属并发负载敏感：维持"隔离复验、保留首次失败"规则，暂不列为产品缺陷。
