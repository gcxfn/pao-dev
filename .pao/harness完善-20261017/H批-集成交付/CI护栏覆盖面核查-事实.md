# CI 护栏覆盖面核查（只读事实）

**日期**：2026-10-17
**执行**：d3-host（lead 决策 2 交办）
**性质**：**只读核查，只报事实，不下结论**。未修改任何 workflow 文件、未触发任何 CI 运行、未 git commit。

---

## 0. 一句话事实

`desktop/.github/workflows/` 下共 **6 个** workflow。**没有任何一个 job 在 Windows runner 上运行 `test:guards` 或 `pnpm check`**；`test:guards` 唯一被执行的地方是 `ci.yml` 的 `typecheck` job，而它 `runs-on: ubuntu-latest`。

---

## 1. workflow 清单与 runner 分布

| workflow 文件 | job（`runs-on`） |
|---|---|
| `ci.yml` | `ci-required`(**ubuntu-latest**) / `typecheck`(**ubuntu-latest**) / `website-build`(**ubuntu-latest**) / `desktop-core`(**ubuntu-latest**) / `desktop-core-shards`(PR 时 **ubuntu-latest**，push main 时 **macos-latest**) / `desktop-package-linux`(**ubuntu-latest**) / `desktop-package-windows`(**windows-latest**) |
| `release.yml` | 14 处 `runs-on`：ubuntu-latest ×6、macos-latest ×4、windows-latest ×3（`build-windows` L204 / `verify-draft-windows` L402 / `verify-published-windows` L577） |
| `windows-release-diagnostic.yml` | 2 个 job，均 **windows-latest**（L15、L38） |
| `desktop-core-trend.yml` | 1 个 job，**macos-latest**（L17） |
| `claude.yml` | 1 个 job，**ubuntu-latest**（L20） |
| `claude-code-review.yml` | 1 个 job，**ubuntu-latest**（L20） |

> 另有 `.github/dependabot.yml`（非 workflow）与 `.github/scripts/summarize-playwright-trend.mjs`（+ `.test.mjs`）。
> 仓库根 `D:\AI\workspace\pao-dev\.github` **不存在**——CI 只在 `desktop/` 这个子仓里。

---

## 2. `test:guards` 与 `pnpm check` 在 CI 里的落点

| 命令 | 在哪个 workflow 的哪个 job | runner |
|---|---|---|
| `pnpm check`（= `format:check && lint && check:architecture && typecheck && test:baseline`，**内含 `pnpm test:guards`**） | `ci.yml` → `typecheck` job，步骤名 `Baseline checks (same command as local development)`（**L52-53**） | **ubuntu-latest** |
| `pnpm test:guards` 单独作为步骤 | **无** | — |

推导链：`package.json` 里 `check = pnpm format:check && pnpm lint && pnpm check:architecture && pnpm typecheck && pnpm test:baseline`，而 `test:baseline = pnpm test:guards && ...`。

---

## 3. Windows runner 上实际跑了什么（`desktop-package-windows`，`ci.yml` L227-253）

```
L243-244  Verify dev launcher argv/PATH contract   → pnpm --dir apps/desktop run verify:launcher-contract
L246-247  Changed-file adapter tests              → pnpm --filter @pi-gui/desktop run test:changed-files
L249-250  Package Windows directory               → pnpm --filter @pi-gui/desktop run package:win:dir
L252-253  Verify packaged runtime dependencies    → pnpm --dir apps/desktop run verify:packaged-runtime-deps:windows
```

**不含**：`test:guards`、`pnpm check`、`check:architecture`、`typecheck`（全量）、`test:baseline`。

`release.yml` 的 `build-windows`（L204 起）在 windows-latest 上有一步 `Typecheck` → **`pnpm typecheck`（L219-220）**，**但不含 `test:guards`**。（`release.yml` 里 `pnpm typecheck` 共出现 3 次：L70-71、L153-154、L219-220，其中 L219-220 属 windows-latest 的 `build-windows`。）

---

## 4. 由此可确证的事实（不含推断）

1. 首行结论成立：**`test:guards` 在 CI 里的唯一执行点是 ubuntu-latest**。
2. 在 Windows runner 上，CI 跑的是一份**专选的小集合**（launcher contract / changed-files / 打包 / packaged runtime deps），不是 `check` 全量。
3. 因此，**本机这篇 H1 记录里那 39 条只在 Windows 上出现的 `test:guards` 失败，CI 从未有机会报出来**——因为没有 Windows job 跑过这条命令。
4. 反过来，**`pnpm typecheck` 在 windows-latest 上确有执行**（`release.yml` 的 `build-windows`），所以 H1 的 #1 绿在 Windows 上是有 CI 覆盖的。

---

## 5. 明确标注为「未查」的项

| 项 | 状态 |
|---|---|
| 这些 workflow 是否真的在 GitHub 上启用（仓库是否有 remote、Actions 是否开启） | **未查**。本轮只读本地文件，未访问远端 |
| 最近一次 CI 运行的实际状态与结论 | **未查**。未调用 `gh`，未访问 API |
| `pnpm check` 在 ubuntu-latest 上是否真的通过（即这 39 条在 Linux 上是否真绿） | **未验**。本机无 Linux 环境；与 H1 记录 §6 的未验项一致 |
| 是否曾有人在这台机器以外发现过这批失败 | **无法查证** |

---

## 6. 复现方式

```powershell
Get-ChildItem 'D:\AI\workspace\pao-dev\desktop\.github\workflows' -Filter '*.yml'
Select-String -Path 'D:\AI\workspace\pao-dev\desktop\.github\workflows\*.yml' -Pattern 'runs-on'
Select-String -Path 'D:\AI\workspace\pao-dev\desktop\.github\workflows\*.yml' -Pattern 'test:guards|pnpm check'
```
