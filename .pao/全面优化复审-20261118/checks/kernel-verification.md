# 内核改动复审 — 检查与测试核实报告

日期：2026-11-18
基线：commit `4ad0797b3`（HEAD），工作区 = K01—K14 + S01—S14 改动后
测试隔离：`PAO_HOME` 指向 `D:\AI\workspace\临时文件夹\pao-review-home-20261118-a`（当前）/`-b`（基线），均为新建空目录；未触碰 `D:\AI\workspace\pao`。

## 一、静态检查（当前工作区）

| 命令 | 结果 | 实施方说法 | 核实 |
|---|---|---|---|
| `npx biome check --error-on-warnings packages/coding-agent/src/pao packages/coding-agent/test/pao` | 失败（退出 1）：128 errors / 44 warnings / 5 infos，677 文件 | 128 错误 / 44 警告 / 5 提示 | **一致**。落在本批改动文件里的诊断仅 1 条：`src/pao/desktop/index.ts:1:1` `assist/source/organizeImports`（export 排序，`host-mount.ts` 排在 `flow-control-payload.ts` 之前）。经对照基线同位置代码排序完全相同，属既有诊断的延续，**非新增** |
| `npx tsc --noEmit` | 失败（退出 1）：1 个错误 | 只剩 `memory-f14-review.test.ts:371` TS2339 | **一致**：`test/pao/memory-f14-review.test.ts(371,16)` TS2339，`continuation` 不存在于 `MemoryResult<ReadTaskContinuationOutput>` 的 `{ok:false}` 分支 |
| `npm run check:pao:kernel` | 失败（退出 1） | B5 有两处既有失败 | **一致**：`[FAIL] B5(pao/index.ts)` 与 `[FAIL] B5(pao/desktop/index.ts)`——内核公开导出闭包经 `index.ts -> src/main.ts`、`extensions/mcp/cli.lazy.ts -> extensions/mcp/cli.ts` 引到 CLI 入口。其余 B1/B2/B6/B7 及自检全 PASS |
| `packages/coding-agent` 下 `npm run check:gates` | 失败（退出 1） | — | `tsc -p tsconfig.integration.json` PASS；B1—B4、B6、B7 全 PASS；仅同样两处 B5 FAIL，无新增失败 |

## 二、vitest（`test/pao`，隔离 PAO_HOME，--maxWorkers=4）

当前工作区结果（`kernel-vitest-current.json`）：

- 测试文件（testResults 条目）：343；聚合套件 1199（含 describe）
- 用例：3869 总，**3859 通过，3 失败**，1 pending；success=false
- 失败套件 6（其中 3 个是含失败断言的 describe 计数；文件级失败 4 个，含 1 个非断言型失败）

失败清单：

| 文件 | 用例 | 错误摘要 | 基线对照 |
|---|---|---|---|
| `test/pao/command-router-isolation.test.ts` | 同进程两会话命令、帮助和面板独立，后注册不接走先注册者命令 | `registerCommand` mock 收到额外第 4 实参 `"/pao action"` | **基线同样失败**（逐字符相同断言差异）→ 既有失败 |
| `test/pao/loadout-role.test.ts` | worker 会话装载面…主控(默认):全部工具与命令注册齐全 | `expected [Array(15)] to deeply equal [Array(13)]`（注册表多出 2 项） | **基线同样失败** → 既有失败 |
| `test/pao/wiring-smoke.test.ts` | pao 接线冒烟 总入口注册全部工具与命令 | 同上 `Array(15)` vs `Array(13)` | **基线同样失败** → 既有失败 |
| `test/pao/zz-review-cjk-recall-probe.test.ts` | —（无断言） | suite 级错误 `Cannot find module '/@id/...zz-review-cjk-recall-probe.test.ts'` | 该文件在基线工作树与当前工作树**均不存在**；系运行期间测试目录被并行改动（`memory-search-cjk.test.ts` 于 01:28 新建、zz-probe 文件被删）导致的收集期残留引用，与本批改动无关 |

**新增失败：0**。3 个断言失败在基线 `4ad0797b3` 上用同一隔离 PAO_HOME 重跑逐字复现（baseline JSON：`kernel-vitest-baseline-failures.json`，16 通过 / 3 失败，断言文本一致），全部归类为既有失败。

补充：新增未跟踪文件 `test/pao/desktop-inject.test.ts` 在本次运行中 2/2 通过；`memory-search-cjk.test.ts`（运行中途新增，未进收集列表）单独补跑 14/14 通过。

## 三、验证过程留痕与限制

1. 首次 vitest 全量跑（默认 forks 池、不限制 worker 数）在收尾阶段因子进程池 `write EPIPE` 崩溃（`ForksPoolWorker.send` → `ChildProcess.target.send`），未产出 JSON。改用 `--maxWorkers=4` 重跑成功产出完整 JSON。该崩溃是测试基础设施稳定性问题，非断言失败。
2. 基线工作树初次跑 3 个失败文件时因缺少 gitignore 的生成目录 `packages/ai/src/providers/data/`（`generate:models` 产物）报 `Cannot find module './data/amazon-bedrock.json'`；从主仓复制该目录后正常执行。基线 node_modules 通过 junction 指向主仓，未做 npm install。
3. 运行期间 `test/pao/` 目录被并发修改（`zz-review-cjk-recall-probe.test.ts` 被删、`memory-search-cjk.test.ts` 新建），导致收集列表与磁盘不一致；已单独补跑新文件确认通过。
4. 清理：baseline worktree 的 junction 已用 `cmd /c rmdir` 解除（主仓 node_modules 完好），复制的 providers/data 已删，`git worktree remove --force` + `worktree prune` 已执行。

## 四、结论

- 实施方三项声明（biome 128/44/5 无新增、tsc 仅 1 处 TS2339、check:pao:kernel 仅 2 处 B5 既有失败）**全部核实一致**。
- vitest 3 个失败用例均为**既有失败**，基线逐字复现；**未发现本批 K/S 改动引入的新增测试失败**。
- 唯一新观察：`zz-review-cjk-recall-probe.test.ts` 的 suite 级 "Cannot find module" 为测试目录并发变动的收集期残留，与本批改动无关。
