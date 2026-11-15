# 基线检查——桌面仓（统一执行 2026-10-07 S0）

- 执行日：2026-10-07（凌晨起跑，core 批次约 02:37 启动）
- 对象：`D:\AI\workspace\pao-dev\desktop`（main 分支，含大量未提交修改＝既有成果；只读未改，无 git 操作）
- 日志目录：`D:\AI\workspace\pao-dev\.pao\统一执行-20261007\基线\`
- 隔离：测试全程外层设 `PAO_HOME=D:/AI/workspace/pao-dev/.pao/统一执行-20261007/基线/隔离PAO_HOME`（本报告同批创建的空目录）；测试助手内部再自设 `PI_CODING_AGENT_DIR`/`PAO_CODING_AGENT_DIR` 临时目录并设 `PAO_DISABLE_BUILTIN_EXTENSION=1`（tests/helpers/electron-app.ts:439,1054-1057）。未读取、未污染 `D:\AI\workspace\pao` 正式现场。
- 环境：Windows 10.0.26200 x64，node v24.18.0，pnpm 10.25.0，Git Bash。
- 范围：仅统一执行计划 §8.1 清单的 5 个门；`pnpm check` 全套中的 format:check/lint 不在本轮清单，未跑。

## 结论速览

| 门 | 命令 | 退出码 | 结果 |
|---|---|---|---|
| 架构检查 | `pnpm check:architecture` | 0 | 4 项全过 |
| 类型检查 | `pnpm typecheck` | 2 | 工作区 7/7 项目全过；extension-examples 段败（5 个示例目录全部缺 node_modules，既有环境缺口） |
| 基线测试 | `pnpm test:baseline` | 1 | 链在 test:guards 止（114 项：75 过 39 败＝存量逐字一致）；其余 6 子门分阶段补跑，下详 |
| 桌面构建 | `pnpm --filter @pi-gui/desktop run build` | 0 | build:deps＋通知助手＋electron-vite 全过 |
| core e2e | `bash apps/desktop/scripts/run-core-batches.sh 0 11`（12 批 112 spec 入口） | 中断（无总结局码） | **按用户 2026-10-07 指令跳过，移后续阶段执行**；批 00-04＋批 05 一部分已跑后被终止，日志 基线/desktop-core-e2e.log |

**失败计数（不含被跳过的 core 全批）：59 条用例失败＋2 处门级缺依赖失败；部分 core 批另录 17 条失败＋2 批被终止。初步归因全部为既有/已知集合内。新增产品失败：0。**

## 各门明细

### 1. 架构检查 —— 通过

- 命令：`pnpm check:architecture`（desktop 根；实际脚本＝renderer-boundary＋contract-authority＋host-boundary＋timeline-owner 四段 node 脚本）
- 退出码：0；日志：`基线\desktop-check-architecture.log`
- 输出：180 个第一方运行时源文件边界通过；契约无环境性重声明；host 依赖不进 renderer；时间线滚动归属通过。

### 2. 类型检查 —— 失败（既有环境缺口，非产品）

- 命令：`pnpm typecheck`（＝check:workspaces→build:shared→7 工作区 typecheck→typecheck:extension-examples）
- 退出码：2；日志：`基线\desktop-typecheck.log`
- 事实：`check:workspaces`、`build:shared`、7 个工作区项目（含 apps/desktop 双 tsconfig）全部 Done；失败在 `typecheck:extension-examples` 的第一个目录 pr-review：`error TS2307: Cannot find module '@earendil-works/pi-ai'`（9 条 TS2307/TS7006，根因同为该目录无 node_modules）。
- 归因：**环境失败（既有）**。5 个 `examples/desktop-extensions/*` 均不在 pnpm workspace（workspaces=globs apps/*,packages/*,video），本机从未安装其依赖；与 2026-10-06 T00（`整体重构-20261005\日志\T00-桌面类型检查.log`，同包同错同退出码）和 T09 执行记录「示例扩展的缺包与隐式类型错误导致总命令失败」逐字一致。

### 3. 基线测试 test:baseline —— 链式中止，分阶段补跑完成

- 命令：`PAO_HOME=<隔离目录> pnpm test:baseline`
- 退出码：1；日志：`基线\desktop-test-baseline.log`（链式段＋分阶段续跑段同文件）
- **脚本形态差异（如实记录）**：`test:baseline` 是 `&&` 链，在第一段 `test:guards` 39 败处即中止， catalogs/driver/extension-ui/extension-examples/release-helpers/desktop-unit 六段未执行。为完整测量，按 T09 既有先例分阶段单跑（不改脚本、不降低检查），各段退出码以 `*_EXIT=` 标记写进同一日志。

| 子门 | 结果（过/败/跳） | 退出码 | 失败明细与归因 |
|---|---|---|---|
| test:guards | 75/39/0（114 项） | 1 | 39 条全是护栏脚本自测的 **Windows 路径分隔符平台特征**：脚本输出 `apps\desktop\src\index.ts:1:` 反斜杠路径，测试断言正则写 `/src\/index.ts:1:/` 正斜杠。含 check-renderer-boundary 26、contract-authority 5、check-host-boundary 7、check-workspace-typechecks 1、typed-lint 1、contract-resolution 1（找 `contract-proof.ts` 得 undefined，同族路径解析）、test-entrypoints 1（playwright --list 报 No tests found，同族）。**与 T00（75/39）与 T09（「114 用例 39 败＝存量口径精确一致」）逐字一致＝既有** |
| catalogs | 28/1/0（29 项） | 1 | `atomic-write.test.mts:36 concurrent writes never collide`——并发 rename EPERM，T00 已实锤的 Windows 文件锁语义**平台失败（既有）**，同名同点位 |
| pi-sdk-driver | 186/3/0（189 项） | 1 | T00 为 9 败（8 条 turn-capture 缺 PAO_HOME＋1 条归档强杀时序）；本次外层设隔离 PAO_HOME 后 turn-capture 8 条全部转绿。余 3 败：session-lease 竞态 2 条（absent/dead lease race，T09 已见同类、隔离复跑全绿＝**负载抖动环境族**）＋「实际worker归档正在删除时强杀父进程」1 条（T00 同名，真子进程时序负载敏感＝**环境失败既有**） |
| extension-ui | 11/0/0 | 0 | 全绿 |
| extension-examples | 门级失败 | 1 | `ERR_MODULE_NOT_FOUND: Cannot find package '@earendil-works/pi-coding-agent'`（pr-review integration.test.mjs）——与 typecheck 同根：示例目录缺 node_modules。**环境失败（既有）**，T00 阶段5、T09 同因同包 |
| release-helpers | 27/0/0 | 0 | 全绿 |
| desktop-unit | 497/16/3（2.0 分钟） | 1 | **与 T00 基线总数逐字一致（497/16/3）**。16 败中 15 条与 T00 归因档同名同点位：symlink EPERM 环境族 6（checkpoint-store:89/456/631、extension-view-source:52、git-review:325、worktree-manager:239）、autocrlf 环境 1（git-review:512）、Windows 文件名/文件语义平台族 7（checkpoint-store:246、timeline-turn-changes:71、git-review:159/129/285/463/177）、原子替换共享锁平台 1（atomic-file-write:7）；另 1 条 checkpoint-store:532 为 T09 已登记的**负载抖动**条目（T09 同样多出它，隔离复跑过）。T00 唯一产品失败 theme:108（--surface-hover 未定义 token）经 T08 修复后本次**保持绿** |

### 4. 桌面构建 —— 通过

- 命令：`pnpm --filter @pi-gui/desktop run build`（＝build:deps 四共享包→build:notification-helper→electron-vite build）
- 退出码：0；日志：`基线\desktop-build.log`
- 未跑 `package:win:dir` 与 `vendor:kernel`（打包属后续阶段，按指令排除）。

### 5. core e2e 分批 —— 按用户指令跳过（部分批次已跑后被终止）

- 命令：构建产物就绪后 `cd apps/desktop && CORE_BATCH_LOG=<基线日志> PAO_HOME=<隔离目录> bash scripts/run-core-batches.sh 0 11`
- **脚本形态差异（如实记录）**：分批脚本自身不含构建步骤（与 lane 脚本 `test:e2e:core` 的 `pnpm build && ...` 不同），故前置执行第 4 步构建；每批独立 playwright 进程＝新 worker，防 0xC0000142 长跑衰减（T00 实锤机制）。
- **执行经过**：批 00 于 02:37:51 启动。批 03 结束后（约 02:59）收到用户指令「core 全 12 批跳过，移后续阶段执行」，随后安全终止：批 05 的 playwright 树与批处理循环 bash 定向 taskkill，无关进程未触碰，日志尾部已追加中断标记。**注意：后台任务停止时 bash 循环未被立即带走，曾自动进入批 04/05，均已在终止动作中清理，日志自 03:04 起静止。**

| 批 | 结果 | 失败条目（全部在 T00/T09 旧集合内，见对比节） |
|---|---|---|
| 00 | 26 过/2 败/5 跳（7.4m）EXIT=1 | changed-files:19、composer-controls:196 |
| 01 | 14 过/4 败（4.8m）EXIT=1 | composer-image-limits:269、custom-endpoints:407、extension-card-actions:86、extension-command-compatibility:47 |
| 02 | 9 过/3 败/3 跳（4.5m）EXIT=1 | extension-dock-reload:44、extension-dock-reload:95、extension-examples:36 |
| 03 | 6 过/8 败（3.9m）EXIT=1 | extension-trace-view:86、extension-usage-view:93、extension-view-links:65、extension-view-security:18/111/140、extensions-dialogs:141、extensions-session-isolation:26 |
| 04 | 14 过后被中途终止，无统计 | 无失败记录（被终止非跑完） |
| 05 | 执行约 2 分钟被指令终止，无统计 | 无失败记录 |
| 06-11 | 未启动 | — |

- **未跑的门（明确记录）**：core 全 12 批完整基线未跑——批 04 统计缺失、批 05 无统计、批 06-11 共 6 批未启动。原因＝用户 2026-10-07 指令跳过、移后续阶段执行；非环境故障、非测试卡死。不能据此声称 core 门通过或失败，后续阶段需完整重跑 12 批（或从批 04 起续跑并补批 04/05）。

## 与旧基线对比

| 对照档 | 日期 | 口径 | 与本次关系 |
|---|---|---|---|
| T00（整体重构-20261005\基线失败归因-桌面侧.md） | 2026-10-06 | core 58 败＋44 未跑（worker 0xC0000142 连锁）；unit 16 败（环境 7/平台 8/产品 1）；driver 9 败（全环境，缺 PAO_HOME）；catalogs 1 败（平台） | guards 39＝逐字一致；unit 16＝总数一致、条目仅 theme:108（已修转绿）↔checkpoint-store:532（已知抖动）互换；driver 9→3（隔离 PAO_HOME 清掉 8 条，与 T00 复现实验预言一致）；catalogs 1＝同条 |
| T09（整体重构-20261005\执行记录.md 526-548） | 2026-10-06 | guards 39＝存量精确一致；unit 497/16/3 逐字一致；driver 9 败＝基线 9 条逐条同（另 lease race 抖动 1）；core 12 批 49 失败条目（5＋1 条待深挖：transcript-annotations:76、workflow-canvas:347、workspace-file-lines:72、timeline-pinning:727、worktrees:113、review-scopes:335） | 本次 core 对照集合即此 49 条清单＋T00 归因档 58 条 |
| 上游对照基线（288dda6，基线失败归因档 B 节） | 2026-10-06 | 上游仅 9 败，不含扩展视图族 | 部分 core 批若扩展视图族仍败＝Windows 真机平台族（既有），非上游回归 |

**部分 core 批（00-03）17 条失败逐条对照**：changed-files:19（T00 平台#1）、composer-controls:196（T00 待判定#3）、composer-image-limits:269（平台#4）、custom-endpoints:407（平台#5）、extension-card-actions:86（平台族）、extension-command-compatibility:47（先前已存在#7）、extension-dock-reload:44/95（先前已存在#8/#9）、extension-examples:36（平台族）、extension-trace-view:86（平台族）、extension-usage-view:93（环境#26，examples 缺依赖同根）、extension-view-links:65、extension-view-security:18/111/140、extensions-dialogs:141（T09 同条）、extensions-session-isolation:26（平台族）——**17/17 全在旧集合内，零新增**。T09 的 5＋1 条待深挖条目（transcript-annotations:76 等）所在批未跑，无从对照。

## 失败清单与归因（59 条用例＋2 门级，另有部分 core 批 17 条）

全部落在旧集合内，无新增产品失败：

1. **平台失败（Windows 特征，POSIX 可过）49＋14 条**：guards 路径分隔符族 39＋1（typed-lint）＋1（contract-resolution 路径解析）＋1（test-entrypoints playwright list）；unit 平台族 8；catalogs atomic-write 1；部分 core 批 14 条平台族/先前已存在（逐条对照见对比节）。机制均有 T00/T09 实锤（反斜杠输出 vs 正斜杠正则、EPERM rename、非法文件名、devNull、共享锁、autocrlf）。
2. **环境失败 9 条**：unit symlink EPERM 族 6＋autocrlf 1（git 系统配置）、driver 归档强杀时序 1（负载敏感）、core extension-usage-view:93 1（examples 缺依赖同根）。
3. **已知负载抖动 3 条**：driver session-lease 竞态 2、unit checkpoint-store:532 1（均为 T09 已登记同款，隔离复跑口径下可绿）。
4. **门级环境缺依赖 2 处**：typecheck 与 extension-examples 两段的 examples 五目录 node_modules 未安装（修复路径＝安装示例依赖，属环境处置）。
5. **产品失败 0**（theme:108 已确认修复；待判定族 composer-controls:196 本次仍复现，维持 T00 待判定口径）。

## 未跑的门与偏差说明

- **未跑的门：core 全 12 批完整基线**。按用户 2026-10-07 指令跳过、移后续阶段执行。实际状态：批 00-03 自然跑完（有统计）、批 04 被中途终止（无统计）、批 05 跑约 2 分钟被终止（无统计）、批 06-11 未启动。后续阶段应完整重跑（或自批 04 续跑并补齐批 04/05），本次部分批结果不构成 core 门通过或失败结论。
- test:baseline 链式脚本在 guards 存量 39 败处即止→其余六段分阶段单跑，与 T09 同款处置，已逐段留退出码；未修改任何脚本、源码、配置。
- 测试隔离口径：外层 PAO_HOME 指向本报告同批创建的隔离目录（driver 的 8 条 PAO_HOME 族失败因此转绿，属隔离口径修正而非回归修复）；未触碰 `D:\AI\workspace\pao`。
- 未执行任何 git 写操作；除日志与本报告外无文件写入（隔离 PAO_HOME 目录为测试隔离要求所建，运行期可能被测试写入临时数据）。
- 本文件由基线执行子代理生成，属任务指定的唯一写文件例外（日志与本报告）。
