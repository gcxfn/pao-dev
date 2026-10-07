# pao-dev

PAO 的开发源码与工程文档仓。PAO 是以 [pi](https://github.com/earendil-works/pi) 为基座的个人编码 agent：一个共享内核（PAO 业务 + pi fork），两种宿主（终端 CLI 与内嵌内核的桌面应用）。

> 本仓是**开发现场**，不是日常使用现场。正式运行数据（PAO_HOME）在独立目录
> `D:\AI\workspace\pao`，测试一律使用隔离 PAO_HOME，勿混用。

## 仓库结构

| 目录 | 内容 | 说明文档 |
|---|---|---|
| `PAO/` | pi fork 与 PAO 内核（独立 Git 仓） | `PAO/AGENTS.md` |
| `desktop/` | 内嵌内核的桌面应用 pi-gui（独立 Git 仓，monorepo） | `desktop/AGENTS.md`、`desktop/CONTRIBUTING.md` |
| `plans/` | 需求、架构与实施计划正本 | `plans/v2-ARCHITECTURE.md`、`plans/v2-REQUIREMENTS.md` |
| `.pao/` | 任务卡、运行留档与验收产物 | `.pao/整体重构-20261005/`（当前重构总册） |
| `AGENTS.md` | 本仓执行约束（规则正本，先读再改） | — |

内核负责会话与业务能力；CLI 与桌面是平级宿主，只负责装配入口、终端/窗口交互与生命周期。桌面发行物内嵌内核，不依赖全局 CLI，也不依赖本仓绝对路径。

## 首次开发

前置：Node 20+ 与 pnpm（corepack）。两个子仓各自独立安装依赖（以下 install 命令为各仓标准入口，
本轮未实际执行验证；desktop 侧依赖细节见 `desktop/CONTRIBUTING.md`）：

```bash
pnpm --dir PAO install
pnpm --dir desktop install
```

## 开发与检查命令

以下命令均为本仓实际使用的检查入口（标注「已验证」的命令于 2026-10-06 在迁移后的目录上实际执行通过）：

```bash
# PAO 内核（cwd 任意，命令内已含路径）
cd PAO/packages/coding-agent
npx tsc -p tsconfig.build.json --noEmit        # 构建级类型门（已验证，exit 0）
npx vitest run test/pao/<测试文件> --maxWorkers=4  # 定向行为测试（已验证，隔离 PAO_HOME + PI_OFFLINE=1）
npx vitest run test/pao/ --maxWorkers=4        # 模块门（全套，改动面大时跑）

# 桌面（desktop/ 根执行）
pnpm run build:shared                          # 先建 workspace 共享包（已验证，exit 0）
pnpm --dir apps/desktop run typecheck          # renderer + electron 类型门（已验证，exit 0）
pnpm --dir apps/desktop run build              # 完整应用构建（2026-10-06 迁移后已验证，exit 0）
pnpm --dir ../.. exec playwright test -c apps/desktop/playwright.config.ts \
  apps/desktop/tests/unit/<spec>               # 单元抽样（已验证，8/8 过）
pnpm test                                      # 真实 Electron core 车道（重，按需）
```

PAO 的隔离测试环境变量（防止污染正式现场）：`PAO_HOME=<临时目录> PI_OFFLINE=1 PI_NO_LOCAL_LLM=1`。

## 文档导航

- 执行约束：`AGENTS.md`（本仓）、`PAO/AGENTS.md`、`desktop/AGENTS.md`。
- 架构与需求正本：`plans/v2-ARCHITECTURE.md`（含 §27 模块边界）、`plans/v2-REQUIREMENTS.md`。
- 整体重构（2026-10-06 完成）：计划归档 `plans/已完成/2026-10-05-整体模块化重构总计划.md`，执行留档与交付结论在 `.pao/整体重构-20261005/`。
- 内核模块清单与上游差异归因：`.pao/整体重构-20261005/现状与基线.md`。
