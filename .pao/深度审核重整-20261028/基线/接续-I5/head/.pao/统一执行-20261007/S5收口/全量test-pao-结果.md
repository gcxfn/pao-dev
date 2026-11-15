# S5 阶段收口 · 全量 test:pao 结果（2026-10-07）

## 结论

**退出码 1：Tests 8 failed | 1469 passed（1477），Test Files 3 failed | 156 passed（159）。**
8 条失败逐条归因：**基线既有环境族 5 条＋负载时序 flake 族 2 条＋S5 新败 1 条**。S5 新败 1 条（workflow-templates）已在隔离复跑中确定性复现——**按任务书构成阻断送审项**，详见 `.pao/统一执行-20261007/S5审核/合并审核-波次.md` 发现 #1。

## 运行方式（一次完整跑，无中途终止）

- 时间：2026-10-07 23:34:10 起，Duration 202.46s
- 命令：`cd PAO/packages/coding-agent && PAO_HOME=<临时隔离目录> PI_OFFLINE=1 PI_NO_LOCAL_LLM=1 npx vitest run test/pao/ --maxWorkers=4`
  （PI_OFFLINE=1 同时由 vitest 配置自带；PAO_HOME 指向新建空目录，隔离正式现场 `D:/AI/workspace/pao`）
- 起点残留检查：electron＝0；vitest/测试 worker＝0（在册 node 进程均为本会话基础设施与他方 pi 会话 `dist/bundle/cli.js`（PID 33920，非测试残留，未触碰）
- 证据 log：`证据/全量test-pao.log`（全文原文，末行 `EXITCODE=1`）

## 计数行原文（逐字）

```
 Test Files  3 failed | 156 passed (159)
      Tests  8 failed | 1469 passed (1477)
   Duration  202.46s
EXITCODE=1
```

## 失败逐条归因

| # | 失败（文件 > 用例） | 归类 | 依据 |
|---|---|---|---|
| 1-5 | loadout-tiers-config.test.ts ×5（「真实两档配置…」describe 全组：配置文件存在/两档快主力/registerTiers/route 映射/resolveTier 按名取档） | **基线既有环境族** | 该组断言生产 PAO_HOME 的 `pao配置/档位.json` 交付物在位；隔离空 home 必缺。与 S1-2 包1 基线（`验证-全量test-pao-修后.log`：6 败＝loadout ×5＋host-inventory ×1）中 loadout ×5 同集合同数 |
| 6-7 | host-inventory-dispatch.test.ts：`全局热会话数超 8:仅提示不拒`（:33）＋`热会话＋交接文件在:指针进附加系统提示词`（:254） | **环境 flake 族（负载时序）** | 基线记录该族 ×1；本次 4 并发负载下扩为 2 条。单文件隔离复跑（`证据/复跑-host-inventory.log`）：**5/5 全绿，退出码 0**——非 S5 行为变更所致 |
| 8 | workflow-templates.test.ts：`改安装配方不能改变 v2 卡的冻结技能，旧轮次卡拒派`（:102，expected undefined to deeply equal [original 技能路径]） | **S5 新败（确定性）** | 隔离复跑（`证据/复跑-workflow-templates.log`）：3 passed | 1 failed，退出码 1，同断言复现。根因：S5包2 允许清单只读门（dispatch-core.ts:558-568）把未经本地确认的仓内工作流技能忽略（fail-closed），该测试 fixture（`pao-template-frozen-*`）未补 `允许清单.json`；S5包1包2 的 mandated fixture 补丁只覆盖了 dispatch-workflow-skills/dispatch-workflow-check 两文件，漏了同用 `original` 技能的本文件。断言本身在 dad7408fa 内由 T02 切片改写（迁移到 resolveWorkflowDispatch），与本败同commit 混提 |

## S5 新败处置

按任务书「S5 新败＝阻断送审」：S5 波不放行，发现已并入 `S5审核/合并审核-波次.md` 发现总表 #1（P1）。修复面很小（本文件 fixture 补一行 `允许清单.json`，或按门语义改断言），修复后复跑该文件＋建议再跑一次全量确认即可解除阻断。

## 清理与去向

- 隔离 PAO_HOME 现场临时目录 `临时文件夹/S5收口-20261007/`（终态仅 `.pao/摩擦草稿.md`＋`项目清单.md` 两个运行期落盘文件，9KB）已整体删除，退出码 0。
- 留档去向：本文件＋`证据/全量test-pao.log`（全量原文）＋`证据/复跑-workflow-templates.log`、`证据/复跑-host-inventory.log`（归因复跑，单独留档）均在 `.pao/统一执行-20261007/S5收口/`。
- PAO 仓 git 全程只读，零提交（工作树两条 pnpm 未跟踪文件为前波遗留，未触碰）。
