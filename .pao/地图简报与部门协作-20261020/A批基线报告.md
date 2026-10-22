# A 批源码恢复基线报告

结论：A 批通过。任务开始时三仓的 HEAD、已有 tracked/untracked 修改和可恢复源码字节已固定，三仓重建核对均为 `pass`，捕获前后三仓 tracked 文件哈希均未变化，已据此放行 B–E 实施。

本报告只证明源码基线可恢复，不证明修复前 PAO 已完整启动，也不证明 V01–V18 的产品行为通过。

## 1. 三仓身份与覆盖

基线证据目录：[baseline](baseline/)；机器可读汇总：[summary.json](baseline/summary.json)。

| 仓库 | 分支 | HEAD | status 项 | 当前 tracked | 缺失 tracked | untracked 纳入 | untracked 排除 | 重建 |
|---|---|---|---:|---:|---:|---:|---:|---|
| `pao-dev` | `main` | `f4bfd6d55e6dcbeaf167b4e0a669df546ae25a4d` | 6797 | 2637 | 0 | 16 | 6778 | `pass` |
| `PAO` | `pao-main` | `a2380612e69f38a0d21e7dd9586e65c42f8fb20e` | 182 | 2210 | 0 | 52 | 18 | `pass` |
| `desktop` | `main` | `2cf4c807e7c15afe40c8907dcaf7078b9afd8b15` | 245 | 910 | 6 | 65 | 64 | `pass` |

每仓均保存：

- `head.txt`：实施前提交身份。
- `head-tree.zip`：该 HEAD 的 Git 树内容。
- `tracked-current.zip`：按 `git ls-files` 枚举的当前真实文件字节，包括已有 tracked 修改。
- `tracked-current.sha256.json`、`tracked-after-capture.sha256.json`：捕获时及捕获后的逐文件 SHA-256。
- `tracked-deleted.json`：当前缺失的 tracked 文件清单。`desktop` 有 6 个缺失测试文件，见[该仓清单](baseline/desktop/tracked-deleted.json)。
- `untracked-sources.zip`、`untracked-included.json`：纳入的未跟踪源码、文档和工程文件。
- `untracked-excluded.json` 与 `untracked-excluded-summary.json`：明确排除的运行留档、临时文件和归档。
- `status-before.txt`、`status-after.txt`：原 Git 状态全量留档，供人工对照。
- `tracked-changes.patch`：tracked 改动的可读补丁，作为辅助证据；恢复以 ZIP 中的真实文件字节为准。
- `reconstruction-check.json`：逐文件 SHA-256 重建核对结果。

`desktop` 缺失的 tracked 文件是：

```text
apps/desktop/tests/core/workflow-bug5-reactivation.spec.ts
apps/desktop/tests/core/workflow-canvas.spec.ts
apps/desktop/tests/core/workflow-control.spec.ts
apps/desktop/tests/core/workflow-instance.spec.ts
apps/desktop/tests/core/workflow-single-view.spec.ts
apps/desktop/tests/core/workflow-tabs.spec.ts
```

它们按任务开始时的真实工作区记为缺失，没有从 HEAD 冒充当前文件。

## 2. 实施前运行证据

以下是主协调实际运行并转告的真实结果，原工作表未归档在本目录：

| 检查 | 实际命令或环境 | 结果 |
|---|---|---|
| 运行时 | Node `v24.18.0`、npm `11.16.0`、pnpm `11.18.0` | 已实测 |
| 内核类型检查 | `PAO/packages/coding-agent` 下执行 `../../node_modules/.bin/tsc.cmd -p tsconfig.build.json --noEmit` | 退出 0，无输出 |
| 修改前定向测试 | `vitest run test/pao/worker-dispatch-guards.test.ts test/pao/worker-lock.test.ts test/pao/delivery-commit.test.ts` | 实际匹配 2 个文件、35 个用例通过，退出 0，28.96 秒；`worker-lock.test.ts` 未匹配 |

这条记录不能改写成“3 个测试文件通过”。

## 3. 包和锁文件身份

截至 2026-10-20 的实际内容和项目声明：

| 文件或声明 | 实测值 |
|---|---|
| `PAO/package.json` | 包名 `pi-monorepo`，版本 `0.0.3`；Node 要求 `>=22.19.0` |
| `PAO/packages/coding-agent/package.json` | 版本 `1.0.2` |
| PAO TypeScript 声明 | `7.0.2` |
| `PAO/package-lock.json` SHA-256 | `845F6D44CA3111955038138613AAFDC309EBA9B04FFF00CAD52F4EF87C28630D` |
| `PAO/pnpm-lock.yaml` SHA-256 | `7748374D23E01933DB2917F61E613E08D8BF1FCCFB40744D5307FFEEE8300F64` |
| `desktop/package.json` | 包名 `pi-gui`，版本 `1.0.1`；声明 `packageManager: pnpm@10.25.0` |
| desktop TypeScript 声明 | `^5.9.3` |
| `desktop/pnpm-lock.yaml` SHA-256 | `CE13729B8A0CA2604C33C481CC40E282837A666E09E16F2CF5B220F0DA0D3111` |

PAO 同时存在 npm 与 pnpm 的锁文件；本次按仓库当前实际命令继续使用 npm workspace。desktop 声明 pnpm 版本，实际本机版本更高，不能把两者写成相同版本。

## 4. 查图事实与限制

本机 CLI：

```text
C:\Users\ASUS\.local\bin\codebase-memory-mcp.exe
codebase-memory-mcp 0.11.0
```

实际执行过 `index_status`、`search_graph` 和部分 `trace_path`：

- PAO 项目名 `D-AI-workspace-pao-dev-PAO`；索引 `ready`，HEAD `a2380612...`，`indexed_at=2026-10-20T02:49:15Z`，30753 个节点、156993 条边。
- desktop 项目名 `D-AI-workspace-pao-dev-desktop`；索引 `ready`，HEAD `2cf4c807...`，`indexed_at=2026-10-19T07:08:07Z`，10738 个节点、49845 条边。
- PAO `search_graph --name-pattern 'dispatchCard|verifyCard|deliverCard'` 成功；也找到 `deliverCardOnce`、`deliverCards`、`verifyCard`。
- PAO `trace_path deliverCardOnce` 和 `verifyCard` 成功，找到 `runChainForCard` 等相关调用方。
- desktop `search_graph --name-pattern 'GitWorktreeManager|createWorktree|removeWorktree|pruneOrphanedWorktrees|appWorktreeRootMatcher'` 成功，找到工作树类与 `app-store` 调用点；一次限定名 `trace_path` 返回“function not found”，没有把它记为成功。

`ready` 只表示索引可查询，不等于与工作区完全同步。PAO 有 10 个部分解析文件，desktop 有 3 个；图中行号也比当前源码旧。因此覆盖表只把图用于发现入口，结论均以当前 `rg` 和源码范围核对为准。

## 5. 基线脚本和失败经过

- [build-baseline.ps1](build-baseline.ps1) 用途：采集三仓 HEAD、status、tracked 当前字节、筛选后的 untracked 源码和重建核对；输入：三仓工作区；输出：`baseline/`。脚本含 UTF-8 BOM，已实际执行完成。
- [baseline-reconstruct.ps1](baseline-reconstruct.ps1) 用途：从 `baseline/` 解包源码并核对逐文件 SHA-256；输出：本目录下 `reconstructed-sources/`。脚本含 UTF-8 BOM，并已做 PowerShell 解析检查；主审另行实际执行了该脚本，三仓 tracked 与纳入的 untracked 文件真实内容 SHA 全部一致，退出 0；该独立结果与采集脚本内部的临时解包核对相互印证。
- [build-baseline-run.log](build-baseline-run.log) 记录最终成功运行，三仓依次固定并输出完成路径。

最终方案曾经历全量未提交快照脚本多次只完成 `pao-dev` 的失败。为避免继续扩大通用快照系统，改用标准库 ZIP 保存 `git ls-files` 枚举的当前真实文件字节，再筛选并保存任务相关的 untracked 文件，最终三仓通过。`git update-index --refresh` 在工作区有真实修改时可能返回 1，这类已知 dirty 语义没有被当成假成功，也不改变真实文件哈希核验。

临时 index、Git 过滤器和换行差异不用于证明恢复内容。恢复目标是当前真实源码字节，不依赖重建出与工作区完全相同的 Git index。

## 6. 边界与不满足条件

- 本轮没有自动提交、stash、reset 或清理用户改动。
- 没有读取或复制正式 `PAO_HOME` 凭证；真实供应商配置没有归档。
- 旧 `.pao/`、`.pao/archive`、`archive/`、临时文件夹和 `.dsh-acl-recovery` 没有复制。它们是运行证据或非源码内容，不属于本次源码基线。
- `node_modules`、`dist`、`build`、`out`、release/发行物、`.git`、缓存、日志和系统临时文件没有纳入源码基线；依赖由现有安装或锁文件恢复。
- 源码恢复不等于完整运行环境恢复。真实供应商、模型效果和费用尚未获得实验授权，不能宣称可用。
- 真实 worktree 并行、Electron 关键链路和 V01–V18 产品行为没有在 A 批完成验收。
- B/C 实施中出现过新的候选模块，它们不属于 A 原始基线，也不反过来证明基线遗漏。

运行与复现步骤见[基线复现与排除清单](基线复现与排除清单.md)，问题覆盖见[V01–V18 覆盖表](问题-入口-修复-V01至V18覆盖表.md)。
