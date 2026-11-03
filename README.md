# pao-dev

PAO 的开发源码与工程文档仓。PAO 是以 [pi](https://github.com/earendil-works/pi) 为基座的个人编码 agent：一个共享内核（PAO 业务 + pi fork），两种宿主（终端 CLI 与内嵌内核的桌面应用）。

> 本仓是**开发现场**，不是日常使用现场。正式运行数据（PAO_HOME）在独立目录
> `D:\AI\workspace\pao`，测试一律使用隔离 PAO_HOME，勿混用。

## 正式使用入口

日常使用不依赖本仓源码与全局 CLI，直接运行桌面发行物：

- 可执行文件：`desktop/apps/desktop/release/win-unpacked/PAO.exe`（exe 由
  `desktop/` 下 `pnpm run package:win:dir` 打出；需要安装版时改跑
  `pnpm run package:win` 重打）。
- 新安装默认数据目录和覆盖优先级见[架构 §27.3](plans/v2-ARCHITECTURE.md#273-内核--cli--桌面宿主关系2026-10-05-用户定案2026-10-06-已实施)。本机现有现场截至 2026-10-20 仍为 `D:\AI\workspace\pao`，已保存设置继续生效，本轮不迁移正式数据。
- 模型凭证：用户级 `~/.pi/agent/auth.json`（zai-coding-cn OAuth），CLI 与
  桌面共用，随用户目录走、不随仓库分发。

## 仓库结构

| 目录 | 内容 | 说明文档 |
|---|---|---|
| `PAO/` | pi fork 与 PAO 内核（独立 Git 仓） | `PAO/AGENTS.md` |
| `desktop/` | 内嵌内核的桌面应用 pi-gui（独立 Git 仓，monorepo） | `desktop/AGENTS.md`、`desktop/CONTRIBUTING.md` |
| `plans/` | 需求、架构与实施计划正本 | `plans/v2-ARCHITECTURE.md`、`plans/v2-REQUIREMENTS.md` |
| `bench/` | 基准控制、准备、观察、报告与测试源码 | `bench/控制器使用说明.md` |
| `.pao/` | 任务卡、运行留档与验收产物 | 具体证据由对应计划链接；当前状态统一看执行计划 §10 |
| `AGENTS.md` | 本仓执行约束（规则正本，先读再改） | — |

内核负责会话与业务能力；CLI 与桌面是平级宿主，只负责装配入口、终端/窗口交互与生命周期。桌面发行物内嵌内核，不依赖全局 CLI，也不依赖本仓绝对路径。

## 首次开发

前置：Node 22.19.0+，内核使用 npm，桌面使用 pnpm（corepack）。两个子仓各自使用已跟踪的锁文件，在各自仓根安装依赖；不要在成员包内单独安装。以下命令按 2026-10-29 的仓库清单核对，本轮未重新安装依赖；desktop 侧依赖细节见 `desktop/CONTRIBUTING.md`：

```bash
npm --prefix PAO ci
pnpm --dir desktop install
```

## 开发与检查命令

以下命令均为本仓实际使用的检查入口（最近一次复核 2026-11-01，复核范围见 `.pao/协作规则统一-20261030/S7/` 验收记录与各批交付记录；标「已验证」的命令曾在该复核日或注明日期实际执行通过）：

```bash
# PAO 内核（cwd 任意，命令内已含路径）
cd PAO
node node_modules/typescript/bin/tsc --noEmit    # 构建级类型门（已验证 2026-11-01，exit 0）
npm run check:types:integration                  # 集成类型门（已验证 2026-11-01，exit 0）
cd packages/coding-agent
node ../../node_modules/vitest/vitest.mjs run test/pao/<测试文件> --maxWorkers=2  # 定向行为测试（隔离 PAO_HOME + PI_OFFLINE=1 + PI_NO_LOCAL_LLM=1）
node ../../node_modules/vitest/vitest.mjs run test/pao/ --maxWorkers=2            # 模块门（全套，改动面大时跑）

# 桌面（desktop/ 根执行）
pnpm run build:shared                          # 先建 workspace 共享包（已验证，exit 0）
pnpm --dir apps/desktop run typecheck          # renderer + electron 类型门（已验证，exit 0）
pnpm --dir apps/desktop run build              # 完整应用构建（2026-10-06 迁移后已验证，exit 0）
pnpm --dir ../.. exec playwright test -c apps/desktop/playwright.config.ts \
  apps/desktop/tests/unit/<spec>               # 单元抽样（已验证，8/8 过）
pnpm test:baseline                             # 桌面基线检查（不启动真实 Electron）
pnpm e2e                                       # 真实 Electron core 车道：会真的弹出 Electron 窗口（重，按需）
```

`pnpm e2e` 会启动真实窗口。无人值守、不希望弹窗，或只是验证代码没坏时，改跑 `pnpm test:baseline`（纯 Node 与单元层，不启窗口）；代价是失去真窗口内的证据，这类缺口须在对应批次留档里如实登记为未验。

跑真实 Electron 用例前须剥离宿主可能注入的 `ELECTRON_RUN_AS_NODE`（否则 `electron.exe` 以 Node 模式启动，报 `bad option: --remote-debugging-port=0`）；剥离后 `electron.exe --version` 应打印 37.x 而不是 22.x。

PAO 的隔离测试环境变量（防止污染正式现场）：`PAO_HOME=<临时目录> PI_OFFLINE=1 PI_NO_LOCAL_LLM=1`。

内核根目录的`npm run check`只读检查，自动修复须显式执行`npm run check:fix`。
内核单仓关口为`npm run check:pao:kernel`（`gate-kernel-import.mjs --kernel-only` ＋ `gate-boundary.mjs --kernel-only` ＋ `gate-kernel-import` 自检）；内核和桌面一起整合时，另需在`PAO`根执行`node packages/coding-agent/scripts/gate-boundary.mjs`跑全量边界门（含 B3/B4 宿主闭包与 B7 反向依赖自检），使用对应构建及桌面vendor。本仓没有 `check:gates` 这个 script。

协作基准源码位于 `bench/`，在本仓根用已安装基准依赖的 Python 绝对路径执行：

```powershell
& $python -m bench --help
& $python -m bench prepare --sources <来源配置>
& $python -m bench run --rehearsal --node <Node可执行文件绝对路径> --output <尚不存在的隔离目录>
& $python -m bench report --run <运行目录>
```

`$python` 须先设为实际解释器路径，不能依赖 PATH 猜版本。`doctor` 检查环境，`run` 启动，
`status` 观察，`collect` 收取，`score` 独立评分，`clean` 默认预览；各自参数见子命令的 `--help`。
启动真实模型和 Docker 必须已有明确授权，并由对应参数显式传入。
`run --rehearsal` 用本机回环脚本模型运行产品主控、部长和工人子进程，生成独立 Git 现场及验收证据；
它不使用真实模型或 Docker，不能证明真实模型质量、费用或官方评分。
旧 `.pao/地图简报与部门协作-20261020/benchmark/` 顶层命令仍兼容转发到同一实现；
逐轮的 `r*-prepare/launch/start` 脚本及 `*-runtime-snapshot/` 属于历史留档，不作为新轮维护入口。
历史冻结件不为更新入口而改写。

零模型最终装配检查为 `bench/tests/test_final_assembly.py`：显式提供
`PAO_FINAL_ASSEMBLY_SOURCES`（prepare来源清单）和`PAO_HARBOR_PYTHON`（已有Linux Harbor解释器），
然后用已选解释器执行 `-m unittest -v bench.tests.test_final_assembly`。缺少前置会明确跳过，跳过不能算验收通过。
测试依赖已有`bwrap`和`setpriv`；Windows经WSL以root启动安装测试进程，在本轮挂载目录内
实际切换root/agent身份，不修改宿主账户或网络设置。系统依赖安装明确模拟，不证明实际OS隔离或模型流程成功。

## 文档导航

### Harness 完善与工作台迭代（2026-10-17 起）

| 要查什么 | 入口 |
|---|---|
| 任务安排与当前状态 | [执行计划 §10](plans/未完成/2026-10-17-Harness完善与工作台迭代执行计划.md#10-分批实施与依赖) |
| 协作稳定性集中治理 | [完整修复计划](plans/已完成/2026-10-25-PAO协作稳定性集中治理计划.md)、[主控审核证据](.pao/协作机制重构-20261023/系统稳定性治理-20261025/主控实施与审核.md)；进度仍看执行计划 §10.21 |
| 整体深度审核与架构重整（2026-10-28 起） | [任务书](plans/未完成/2026-10-28-整体深度审核与架构重整任务书.md)、[目标架构与实施分路](.pao/深度审核重整-20261028/目标架构与实施分路.md)；状态看执行计划 §10.22 |
| 协作规则统一与模块边界优化 | [实施计划（已完成）](plans/已完成/2026-10-30-协作规则统一与模块边界优化实施计划.md)、[审查依据](.pao/架构审查-20261030/审查报告.md)、[S7 交付报告](.pao/协作规则统一-20261030/S7/交付报告.md)；阶段状态看执行计划 §10.23 |
| 右上悬浮框、独立侧栏与辅助对话 | [归档任务书](plans/已完成/2026-10-19-右上悬浮框与独立侧栏任务书.md)、[交付报告](.pao/harness完善-20261017/悬浮框与独立侧栏-20261019/交付报告.md)；状态仍看执行计划 §10 |
| 实施经过与验证证据 | [执行记录](.pao/harness完善-20261017/执行记录.md) |
| 10 月 20 日摩擦修复验收 | [本轮记录](.pao/摩擦修复-20261020/实施与验收记录.md)；任务状态看执行计划 §10.7 |
| 验收覆盖与未验项 | [T01–T25 覆盖表](.pao/harness完善-20261017/F批-全链离线验证/T01-T25-覆盖表.md) |
| 打包后的应用验证 | [发行验证总报告](.pao/harness完善-20261017/H批-解包发行验证/T24-解包发行总报告.md) |
| 关键遗留与后续处理 | [本轮续办任务](plans/未完成/2026-10-17-Harness完善与工作台迭代执行计划.md#101-2026-10-18-续办任务) |
| 下一会话接手入口 | [交接文档](.pao/harness完善-20261017/交接-新会话-20261018.md) |

批次状态只在执行计划 §10 维护；各报告保留对应运行轮次的事实与限制，不把旧结果当成最新验证。

### 其他项目文档

- 运维、删除预演与人工交付：[操作说明](PAO/packages/coding-agent/docs/pao-operations.md)。
- 主控与部长后台交接、15/30分钟监督配置：[分层监督说明](PAO/docs/pao-supervision.md)。
- 部门简介与结构化便捷派发：[架构说明 §28.4](plans/v2-ARCHITECTURE.md#284-结构化任务书与便捷派发2026-10-24)、[工程审核记录](.pao/协作机制重构-20261023/提示词派发优化-20261024/主控整合审核.md)。
- 执行约束：`AGENTS.md`（本仓）、`PAO/AGENTS.md`、`desktop/AGENTS.md`。
- 架构与需求正本：`plans/v2-ARCHITECTURE.md`（含 §27 模块边界、§28 部门目录与唯一受理入口、§29 上下文恢复与总预算门禁、§33 多部门协作与主控减负、§34 深度审核后的技术边界、§35 协作规则统一与模块边界定案）、`plans/v2-REQUIREMENTS.md`。
- 整体重构（2026-10-06 完成）：计划归档 `plans/已完成/2026-10-05-整体模块化重构总计划.md`，执行留档与交付结论在 `.pao/整体重构-20261005/`。
- 内核模块清单与上游差异归因：`.pao/整体重构-20261005/现状与基线.md`。
- 通用工作台与内核可靠性（2026-10-14 起）：计划 `plans/已完成/2026-10-14-通用工作台与内核可靠性实施总计划.md`，执行证据与验收结论在 `.pao/通用工作台实施-20261014/`（`验收/阶段1…阶段7` 七份，`基线/` 四份）。工作流的默认界面是**步骤卡工作台**（`desktop/apps/desktop/src/features/workflow-cards/`），画布已冻结在 `desktop/archive/canvas-frozen-20261014/`。
