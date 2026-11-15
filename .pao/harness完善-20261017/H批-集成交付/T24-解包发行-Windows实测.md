# T24 解包发行 Windows 实测 —— **补充：Windows Playwright production 车道的首次实测**（H 批）

> **与总报告的关系**：T24 的正本**不是本文件**，而是
> [`..\H批-解包发行验证\T24-解包发行总报告.md`](../H批-解包发行验证/T24-解包发行总报告.md)（19,731 B / 242 行，2026-10-17 16:21）
> 加它的两份分步原件（`T24-解包发行验证-第2步.md` 15,367 B、`第3步.md` 19,043 B）。
> 那套正本用的是**手写驱动脚本**（`驱动-建部建配方.mjs` / `驱动-关键流.mjs` / `探针-重开查回.mjs`）直连桌面 API；
> **本文件只补它没覆盖的一层**：用仓库自带的 `apps/desktop/tests/production` 车道（Playwright + 真实 `PAO.exe`）
> 在 Windows 上跑一遍，并且**重新打了一次包**（22:24:11）替换掉原先那份 14:24:56 的产物。
> 两条线互补：正本证明「关键流四段走到哪」，本文件证明「production 车道在 Windows 上是什么结果 + 这一轮的包与仓是否逐字节一致」。
> **口径沿用正本 §1**：与分步原件冲突时，以分步原件的原始输出为准；本文件所有数字都标了是哪一次打包/哪一次运行测的。
>
> - 日期：2026-10-17
> - 执行：teammate `d3-host`
> - 纪律：**不改产品源码、不改现有 spec/helper**；正式 PAO_HOME（`D:\AI\workspace\pao`）全程未读写，所有 userDataDir 都是 `mkdtemp` 出来的临时目录。

---

## §1 结论

**一句话**：**本轮重新打的包（22:24:11）与开发仓逐字节一致，production 车道在 Windows 上首次跑通全目录：13 例 = 2 passed / 9 failed / 2 skipped（1.9 分钟，EXIT=1）**；
9 条红里 **8 条是 macOS 专属**（4 条 macOS 通知语义 + 4 条依赖 macOS 发行物/`/Applications`），**2 条跳过也是 macOS 专属用例自带 skip**；
**唯一一条与平台无关的红（`packaged-extension-view.spec.ts:57`）已用临时探针定案：不是产品缺陷，是 Playwright 坐标点击进不了跨源扩展 frame，属测试前提**（§5.3，含探针全文与输出）。

| 项 | 实测结果 | 证据 |
|---|---|---|
| 内核离线重建 `pnpm build:offline` | **EXIT=0，15.3 秒** | `t24-kernel-build-offline.log`（5,592 B） |
| 第 1 次 `package:win:dir`（22:05:34） | **EXIT=1，1.3 秒**，被内核 dist 陈旧门 fail-closed 拒绝 | `t24-package-win-dir.log`（2,050 B） |
| 第 2 次 `package:win:dir`（22:24:12） | **EXIT=0，303.9 秒** | `t24-package-win-dir-2.log`（10,572 B） |
| 新包与仓内容一致性（逐文件 SHA256） | **2158 个文件全部一致，0 不同、0 缺失** | `T24-现场\T24-包内与仓内比对.cjs` → `t24-asar-vs-repo.json`（2,468 B） |
| production 车道：**旧包（14:24:56）** | 5 spec / **7 例**：`5 failed` / `2 passed (1.8m)`，EXIT=1，110.4 秒 | `t24-production-run.log`（25,026 B，UTF-16LE+BOM） |
| production 车道：**新包（22:24:11）** | 10 spec / **13 例**：`9 failed` / `2 skipped` / `2 passed (1.9m)`，EXIT=1，114.3 秒 | `t24-production-new-package.log`（43,492 B，UTF-16LE+BOM） |
| CI 在 Windows 上真正跑的打包校验（对新包复跑） | **两项 EXIT=0** | `t24-verify-packaged-deps-2.log`（3,868 B）、`t24-verify-launcher-contract-2.log`（734 B） |
| `packaged-extension-view.spec.ts:57` 定案 | **测试前提问题**（坐标点击没进 frame；frame 内 DOM 点击则链路全通） | `t24-probe-frame-click-2.log`（4,210 B）+ §8 附录 |

三条最重要的话：

1. **包是对的**：新包 `app.asar` 里 2054 个内核条目 + `out/` 6 个 + 4 个 `@pi-gui/*` 工作区包共 **2158 个文件与开发仓同路径文件 SHA256 全等**；内核试金石文件 `dist/pao/usage/budget-command.js`（7,621 B）两侧同为 `DD3FB5003B46DCF8C7B230C412B6873203355548FFA4E5E82E6407BDD6CB31B6`（与正本 §2 记的 14:24 那次同值 ⇒ 本次重建是确定性的）。
2. **车道在 Windows 上「不成立」的部分全是 macOS 专属**：8 条红 + 2 条跳，判据都是用例名/断言或 helper 显式要求 macOS（§5.1、§5.2）；**这个车道在任何平台的 CI 里都没有基线**（§6.2），所以这些红只能叫「首次实测发现」，不能叫回归。
3. **唯一一条平台无关的红已定案为测试前提，不是产品缺陷**：坐标点击 `Increment` 后 frame 的 `data-clicks` 仍是 `null`（点击没进 frame 的 JS）；改用 frame 内 DOM 自点一次，`data-clicks="1"`、`#counter` 变 `Count 1 · activations 1`、无 error ⇒ 处理函数、Chord 服务调用、状态回流**全通**（§5.3）。

---

## §2 本轮产物

全部在 `D:\AI\workspace\pao-dev\.pao\harness完善-20261017\H批-集成交付\`：

| 文件 | 字节 | 内容 |
|---|---|---|
| `T24-解包发行-Windows实测.md` | 本文件 | 补充报告 |
| `t24-kernel-build-offline.log` | 5,592 | `pnpm build:offline` 全文（末尾 `Built packages\coding-agent\dist\bundle (74 files, 9.6 MiB)`） |
| `t24-package-win-dir.log` | 2,050 | 第 1 次打包失败原文（陈旧门） |
| `t24-package-win-dir-2.log` | 10,572 | 第 2 次打包全文（EXIT=0） |
| `t24-production-run.log` | 25,026 | production 车道（旧包，7 例）逐字日志 |
| `t24-production-new-package.log` | 43,492 | production 车道（新包，13 例）逐字日志 |
| `t24-extview-trace-on.log` | 6,072 | `packaged-extension-view` 单跑 + `--trace on`（EXIT=1，29 秒） |
| `t24-extview-foreground-ab.log` | 10,948 | 同 spec 改 `PI_APP_TEST_MODE=foreground` 的 A/B（EXIT=1，55.4 秒含 retry1） |
| `t24-probe-frame-click.log` / `-2.log` | 3,514 / 4,210 | 临时探针两次运行输出（`PROBE_FRAME_CLICK` 标记行） |
| `t24-verify-packaged-deps.log` / `-2.log` | 3,868 / 3,868 | CI「打包运行时依赖」校验（前者旧包、后者新包） |
| `t24-verify-launcher-contract.log` / `-2.log` | 734 / 734 | CI「开发启动器契约」校验（同上） |
| `t24-asar-vs-repo.json` | 2,468 | 包内 vs 仓内逐文件比对结果 |
| `t24-production-两张表.txt` | 14,810 | 两份生产日志的逐条解析（失败头 + 首错行） |
| `T24-现场\生产车道-新包-失败产物\` | 10 文件 / 298,921 B | **失败产物备份**（9 个 `production-*` 目录） |
| `T24-现场\T24-新包数字.cjs` | — | 取新包数字与内核 SHA256 的可复现脚本 |
| `T24-现场\T24-包内与仓内比对.cjs` | — | 逐文件比对脚本 |
| `T24-现场\T24-解析生产日志.mjs` | — | 生产日志解析脚本（UTF-16LE+BOM + ANSI） |
| `T24-现场\b67-摘要与原文.txt` | 170,561 | 本轮对话原文留档（含全部命令） |

> **产物现状声明（如实）**：`desktop\apps\desktop\test-results\` 现在**是 0 个目录**——Playwright 每次跑都会先清 `outputDir`，
> 我后续的单跑（`--trace on` 重跑、foreground A/B、探针两次）把它清空了；**跑生产车道那一次的 9 个失败目录已提前备份**到上表的 `T24-现场\生产车道-新包-失败产物\`。
> 更早 core 车道的 55 个目录也是同一机制被清掉的（不是我手工删的），其清单/体积已记在 `E2E-core车道-Windows实测.md` §12。

---

## §3 T24-A 打包

### A.1 第 1 次打包：失败（内核 dist 陈旧门，fail-closed）

命令（cwd `D:\AI\workspace\pao-dev\desktop\apps\desktop`，前置 `Remove-Item Env:\ELECTRON_RUN_AS_NODE`）：

```powershell
pnpm run package:win:dir
```

结果：**EXIT=1，1.3 秒**（2026-10-17 22:05:34），日志 2,050 B。停在第一个子步骤 `pnpm run vendor:kernel`，逐字：

```
> node scripts/vendor-pao-kernel.mjs
[vendor-pao-kernel] 内核 dist 陈旧：D:\AI\workspace\pao-dev\PAO\packages\coding-agent\src\pao\已知边界.md 比最新 dist 产物
（D:\AI\workspace\pao-dev\PAO\packages\coding-agent\dist\bundle\cli.js）新。先在 fork 根跑 pnpm build:offline 再打包；陈旧产物不进包。
 ELIFECYCLE  Command failed with exit code 1.   （两次）
```

两个时间戳（实测）：

| 文件 | 字节 | mtime |
|---|---|---|
| `PAO\packages\coding-agent\src\pao\已知边界.md` | 16,271 | 2026-10-17 **16:04:49** |
| `PAO\packages\coding-agent\dist\bundle\cli.js` | 160 | 2026-10-17 **14:22:34** |

门本身是 `desktop\apps\desktop\scripts\vendor-pao-kernel.mjs:35-67` 的 fail-closed 设计（**无跳过开关**），
正本 §2 最后一行与第 2 步 §6 已把它记为已知机制——**本轮不是新发现，是踩到了它**。
（`cli.js` 只有 160 B 是**正常的薄入口**，真身在 `cli-runtime.js` 与 `chunks\`，见 `build:offline` 日志末行 `74 files, 9.6 MiB`。）

### A.2 先补内核离线重建：`pnpm build:offline`

命令（cwd `D:\AI\workspace\pao-dev\PAO`）：

```powershell
pnpm build:offline
```

结果：**EXIT=0，15.3 秒**（2026-10-17 22:18:24），日志 5,592 B，末尾逐字 `Built packages\coding-agent\dist\bundle (74 files, 9.6 MiB)`；
`git -C PAO status --porcelain` 条目数 **137 → 137**（不走 `--short` 统计，前后一致；且 `git -C PAO ls-files 'packages/coding-agent/dist'` = 0 个文件，dist 不被 git 跟踪 ⇒ 重建不产生 diff）。

### A.3 第 2 次打包：成功

命令同上 `pnpm run package:win:dir`；结果 **EXIT=0，303.9 秒**（END 2026-10-17 22:24:12），日志 10,572 B。要点：

- `vendor:kernel` 通过并物化：`[vendor-pao-kernel] 已物化：kernel dist＋6 个兄弟运行时（@earendil-works/chord、pi-agent-core、pi-ai、pi-codemode、pi-mcp、pi-tui）＋缺失补扫 5 包（grok-mermaid、quickjs-wasi、pi-telemetry、get-east-asian-width、marked），合计约 92.6 MB`（vendor 目录 mtime 22:19:10）。
- electron-builder：`packaging platform=win32 arch=x64 electron=37.10.3 appOutDir=release\win-unpacked`；`skipped dependencies rebuild reason=npmRebuild is set to false`；`updating asar integrity executable resource` + 若干 `signing with signtool.exe`（PAO.exe、node-pty 的 OpenConsole/winpty-agent、esbuild.exe 等）。

### A.4 新包（22:24:11）实测数字——**引用时请注明「22:24 这次」**

| 项 | 新包（**22:24:11 这次**） | 旧包（14:24:56 那次，引自正本 §2 与我的复测） |
|---|---|---|
| 入口 exe | `release\win-unpacked\PAO.exe` **204,530,176 B**（195.06 MiB），mtime 22:24:11 | 同尺寸，mtime 14:24:56 |
| 解包目录 | **264 文件 / 567,440,123 B（541.2 MiB）** | 264 文件 / 541.2 MiB（正本 §2 同值） |
| `resources\app.asar` | **210,616,175 B**，mtime 22:24:08，asar 条目 **37,112** 个 | 210,613,231 B（差 +2,944 B） |
| asar 顶层 | `node_modules` 37,100 / `out` 11 / `package.json` 1 | 同结构 |
| `resources\app.asar.unpacked` | 189 文件 / 24,132,686 B（`@earendil-works`、`@esbuild`、`@silvia-odwyer`、`node-pty`、`quickjs-wasi`） | 同 |
| 内核试金石 `dist/pao/usage/budget-command.js` | 7,621 B，SHA256 `DD3FB5003B46DCF8C7B230C412B6873203355548FFA4E5E82E6407BDD6CB31B6`，与开发仓同路径**逐字节相同** | 同值（正本 §2） |
| `release\` 其它条目 | `builder-debug.yml` 848 B @22:24:11；`PAO-1.0.1-x64-setup.exe` 128,218,462 B / `PAO-1.0.1-x64-portable.exe` 128,065,050 B / `latest.yml` 343 B **均为 2026-10-12 09:02** | — |

> **两个安装包不是本轮的**：它们 mtime 是 **2026-10-12 09:02**，而本轮跑的是 `package:win:dir`（`--dir`，只出解包目录，不产安装包）⇒ 那是 10-12 那次 `package:win` 的遗留产物，**未发布**（脚本带 `--publish never`）。`release\` 里也没有任何 `.zip`（后面 release-zip 用例全红的原因）。

### A.5 包内容 vs 仓内容：逐文件 SHA256（新包）

脚本 `T24-现场\T24-包内与仓内比对.cjs`（只读；asar 目录条目按前缀跳过），结果 `t24-asar-vs-repo.json`：

| 组 | asar 内条目 | 目录 | **逐字节相同** | 不同 | 仓内缺失 |
|---|---|---|---|---|---|
| 内核 `node_modules/@earendil-works/pi-coding-agent/` | 2,054 | 116 | **1,938** | 0 | 0 |
| 应用自身构建产物 `out/` | 10 | 4 | **6** | 0 | 0 |
| `@pi-gui/extension-ui` | 21 | 3 | **18** | 0 | 0 |
| `@pi-gui/session-driver` | 32 | 2 | **30** | 0 | 0 |
| `@pi-gui/catalogs` | 43 | 4 | **39** | 0 | 0 |
| `@pi-gui/pi-sdk-driver` | 134 | 7 | **127** | 0 | 0 |
| **合计文件** | | | **2,158 全等** | **0** | **0** |

⇒ 「包 = 仓」这一层，本轮是**逐文件**验的，不是抽样。

---

## §4 T24-B 生产车道（旧包 / 新包两张表）

两次都：cwd `desktop\apps\desktop`，前置清 `ELECTRON_RUN_AS_NODE`，`$env:PI_APP_TEST_LANE='production'; $env:PI_APP_REAL_AUTH='0'; $env:PI_APP_TEST_MODE='background'`，
`pnpm --dir ../.. exec playwright test -c apps/desktop/playwright.config.ts <spec 列表> --reporter=line`（**spec 位置参数必须相对路径**）。

### B.1 表 1：**旧包（14:24:56）** —— 只挑了 5 个 spec 文件，共 7 例

命令实参（5 个文件）：`packaged-smoke.spec.ts` / `packaged-terminal.spec.ts` / `packaged-extension-view.spec.ts` /
`notification-onboarding-packaged.spec.ts` / `notification-settings-packaged.spec.ts`；结果 `5 failed` / `2 passed (1.8m)`，EXIT=1，110.4 秒。

| # | spec:行 | 用例名 | 结果 | 错误首行 |
|---|---|---|---|---|
| 1 | `notification-onboarding-packaged.spec.ts:17` | requests notification permission in the packaged app when active work moves to the background | **红** | `expect(received).toBe(expected)`：Expected `"default"` / Received `"granted"` |
| 2 | `notification-settings-packaged.spec.ts:19` | shows not enabled yet … Ask macOS updates the authoritative macOS status | **红** | 同上（`"default"` → `"granted"`） |
| 3 | `notification-settings-packaged.spec.ts:65` | keeps showing not enabled yet … does not change packaged macOS notification access | **红** | 同上（`"default"` → `"granted"`） |
| 4 | `notification-settings-packaged.spec.ts:103` | refreshes packaged notification status after returning from System Settings | **红** | Expected `"denied"` / Received `"granted"` |
| 5 | `packaged-extension-view.spec.ts:16` | packaged extension frame loads its bundled bridge and exchanges live Chord state | **红** | `expect(locator).toHaveText`：`#counter` Expected `"Count 1 · activations 1"` / Received `"Count 0 · activations 1"`（`:57:45`） |
| 6 | `packaged-smoke.spec.ts:11` | launches the packaged app bundle and starts a thread through the real UI | **绿** | — |
| 7 | `packaged-terminal.spec.ts:11` | packaged app opens a real integrated terminal | **绿**（弱，见 §5.4） | — |

### B.2 表 2：**新包（22:24:11）** —— 跑整个 `tests\production`（10 个 spec 文件，排除真供应商那条），共 13 例

命令实参：`Get-ChildItem tests\production -Filter *.spec.ts` 去掉 `pao-live-smoke.spec.ts` 后的 **10 个**文件（pwsh 数组展开 `@specs`）；结果 `9 failed` / `2 skipped` / `2 passed (1.9m)`，EXIT=1，114.3 秒。

| # | spec:行 | 用例名 | 结果 | 错误首行 |
|---|---|---|---|---|
| 1 | `applications-relaunch.spec.ts:15` | launches an installed app copy from `/Applications` and relaunches with persisted state | **红** | `Error: No packaged macOS release zip found under …\release. Run pnpm --filter @pi-gui/desktop run package first.`（`helpers\packaged-app.ts:73`） |
| 2 | `finder-env-open-folder.spec.ts:18` | launches a packaged app under a Finder-style PATH and opens the first folder | **跳过** | 用例自带 `test.skip(process.platform !== "darwin", "Finder-style packaged app coverage is macOS-only")`（`:16`） |
| 3 | `notification-onboarding-packaged.spec.ts:17` | requests notification permission in the packaged app when active work moves to the background | **红** | Expected `"default"` / Received `"granted"` |
| 4 | `notification-settings-packaged.spec.ts:19` | … authoritative macOS status | **红** | Expected `"default"` / Received `"granted"` |
| 5 | `notification-settings-packaged.spec.ts:65` | … packaged macOS notification access | **红** | Expected `"default"` / Received `"granted"` |
| 6 | `notification-settings-packaged.spec.ts:103` | refreshes packaged notification status after returning from System Settings | **红** | Expected `"denied"` / Received `"granted"` |
| 7 | `open-folder-real.spec.ts:13` | opens the real macOS folder picker from the empty state button and adds the selected workspace | **跳过** | 用例自带 `test.skip(process.platform !== "darwin", "Real open-folder production coverage is macOS-only")`（`:11`） |
| 8 | `packaged-extension-view.spec.ts:16` | packaged extension frame loads its bundled bridge and exchanges live Chord state | **红** | 同表 1 #5（`#counter`：`"Count 0 · activations 1"`） |
| 9 | `packaged-smoke.spec.ts:11` | launches the packaged app bundle and starts a thread through the real UI | **绿** | — |
| 10 | `packaged-terminal.spec.ts:11` | packaged app opens a real integrated terminal | **绿**（弱） | — |
| 11 | `release-zip-reopen-new-thread.spec.ts:20` | relaunches a packaged release-zip build with a new auto-titled thread … | **红** | `No packaged macOS release zip found …`（`packaged-app.ts:73`） |
| 12 | `release-zip-reopen-new-thread.spec.ts:93` | relaunches a packaged release-zip build with multiple new threads … | **红** | 同上 |
| 13 | `release-zip-smoke.spec.ts:11` | launches the packaged release zip app bundle from an extracted download path and starts a thread | **红** | 同上 |

### B.3 两表对照：**差异只来自选样，不来自包的新旧**

- **旧包那轮只挑了 5 个 spec 文件**（7 例），**新包这轮跑整个目录**（13 例）⇒ 例数不同是**选样不同**，不是行为变化。
- 两次**共同的 7 例**逐条同结果：5 红（4 条 notification + `packaged-extension-view`）+ **同样那 2 条绿**（`packaged-smoke`、`packaged-terminal`）；
  `packaged-extension-view` 的挂点与期望/实收**逐字相同** ⇒ **与包新旧无关**。
- 新包那轮多出来的 6 例：4 红（`applications-relaunch` + 3 条 release-zip）+ 2 跳（两条 macOS 专属用例自带 skip）。

---

## §5 T24-C 失败定性

### 5.1 四条 macOS 通知用例（#3/#4/#5/#6）——**macOS 专属平台相关**，判据是「读了哪个 API / 哪行断言」

**判据链（都是产品代码里的硬开关，不是猜的）**：

1. 断言读的是 `globalThis.window.piApp.getNotificationPermissionStatus()`（`notification-settings-packaged.spec.ts:42/53`、`notification-onboarding-packaged.spec.ts:36-38`），期望值由**夹具状态文件**驱动：spec 在 `:22` 写 `default\n`，并用 env `PI_APP_TEST_NOTIFICATION_PERMISSION_HELPER_STATUS_FILE`（`:27`）把它交给「macOS 通知状态 helper」。
2. 产品侧读这条链：`electron\platform\notification-permission.ts:185-197 readNotificationPermissionStatus()` → 先试 `:192 readPackagedMacOsNotificationPermissionStatus()`，拿不到才 `:197` 回落到 renderer。
3. `:311-335`：`readPackagedMacOsNotificationPermissionStatus()` 依赖 `:329-335 resolveNotificationStatusHelperPath()`，而它写着 ——
   `if (process.platform !== "darwin" || !app.isPackaged) return undefined;`（`:330`）⇒ **Windows 上恒为 undefined，helper 永远不会被调用，夹具写的 `default` 没人读**。
4. 回落路径 `:293-309 readRendererNotificationPermission()` 执行的是 `globalThis.Notification?.permission`（`:301-304`）⇒ **Windows 打包件实收 `granted`**，与 4 条红的 `Received: "granted"` 完全对应。
5. 另一处同源：`:262-291 openSystemNotificationSettingsInternal()` 在 `:269` 对非 darwin 直接 `shell.openExternal(Apple 支持页)` 返回；spec 里「Open System Settings」那条断言（`notification-settings-packaged.spec.ts:47`）在非 macOS 上没有对应行为。
6. 夹具改写 helper 状态的入口 `:346-365 updatePackagedHelperOverrideStatus()` 也只在 `:205 if (process.platform === "darwin" && app.isPackaged)` 分支里可达。

⇒ **判定：4 条全是「macOS 专属平台相关」**；在 Windows 上它们**不是回归、也不是产品缺陷**，而是「读的是 macOS 系统通知授权状态」的用例放错了平台。

### 5.2 四条依赖 macOS 发行物/`/Applications` 的红（#1、#11、#12、#13）——**macOS 专属**

- 三条 release-zip + `applications-relaunch` 都栽在同一处：`tests\helpers\packaged-app.ts:68-82 resolvePackagedReleaseZip()` 在 `release\` 里找 `-arm64.zip` → `-mac.zip` → 任意 `.zip`（`:71-73`），而 Windows 的 `package:win:dir` **只产出 `win-unpacked` 目录**，`release\` 里 `ZIP_COUNT=0`（实测）。
- `applications-relaunch.spec.ts:15` 的用例名本身写着 `launches an installed app copy from /Applications`（macOS 安装位置），走的也是同一条 zip 解包 + `resolveAppBundleExecutable`（读 `.app/Contents/MacOS`）。
- 报错首行逐字：`Error: No packaged macOS release zip found under D:\AI\workspace\pao-dev\desktop\apps\desktop\release. Run pnpm --filter @pi-gui/desktop run package first.`（`at helpers\packaged-app.ts:73`）。

⇒ **判定：4 条全是「macOS 专属平台相关」**（本机没有也不该有 macOS zip）。

### 5.3 唯一一条平台无关的红：`packaged-extension-view.spec.ts:57` —— **已定案 = 测试前提问题（不是产品缺陷）**

**症状**：`:53` heading 可见、`:54` 基线 `#counter = "Count 0 · activations 1"`、`:55` `expectExtensionViewReady`（宿主 `data-state=ready`）**都过**；
`:56` 点 frame 里的 `Increment` 不报错；`:57` 期望 `"Count 1 · activations 1"` 仍是 `"Count 0 · activations 1"`。

**已排除的两件事**：

1. **不是打包缺陷**：打包件把这一节要验的东西都做对了——`app.asar` 身份断言（`:29-31 isPackaged=true / defaultApp=false / appPath 以 app.asar 结尾`）通过、用**包内**的 `@pi-gui/extension-ui/dist/index.js` 装夹具（`:35-39`）、`pi-extension://…/_host/frame-bridge.js` 响应 **200**（`:44-49`）、frame `sandbox="allow-scripts"`（`:52`）。
2. **不是 background 测试模式（隐藏窗口）造成的**：`main.ts:595 show:false` + `:696-700 if (!backgroundTestMode) window.show()` ⇒ background 模式窗口从不显示；为此做了 A/B —— 同 spec 改 `PI_APP_TEST_MODE=foreground`（窗口真显示）单跑：**仍然 1 failed**（`t24-extview-foreground-ab.log`，EXIT=1，55.4 秒，含 retry1，挂点逐字相同）。
3. 另注：本项目 Playwright 对 Electron 的自动 trace **不含 DOM 快照**（两份 trace.zip 条目类型只有 `before`/`after`/`context-options`/`error`，`resources\` 为空；`--trace on` 重跑也一样）⇒ 纯看 trace 拿不到 frame DOM。

**定案手段：临时探针（lead 2026-10-17 批准，未跟踪、跑完即删，全文见 §8 附录）**
输出逐字（`t24-probe-frame-click-2.log`，EXIT=0，27.7 秒）：

```json
{"probe":"clicks-vs-error","bridgeStatus":200,"sandbox":"allow-scripts","frameSrc":"pi-extension://b8d15c4a-…/",
 "before":{"counter":"Count 0 · activations 1","incrementClicks":null,"incrementError":null,"rootError":null,
           "boundary":"{\"preload\":\"undefined\",\"process\":\"undefined\",\"require\":\"undefined\",\"parentAccess\":\"blocked\",\"origin\":\"null\"}"},
 "after":{"counter":"Count 0 · activations 1","incrementClicks":null,"incrementError":null,"rootError":null, "boundary":"…同上…"},
 "counterUnchanged":true}
{"probe":"programmatic-click","afterProgrammaticClick":{"counter":"Count 1 · activations 1","incrementClicks":"1","incrementError":null,"rootError":null,"boundary":"…同上…"},"counterChanged":true}
```

- 坐标点击后 **`incrementClicks` 仍是 `null`**（夹具在 `tests\helpers\desktop-extension-fixture.ts:54-58` 里把点击次数写进 `button.dataset.clicks`）⇒ **点击事件根本没进 frame 的 JS**，所以既没计数也没错误。
- 改用 **frame 内 DOM 自点一次**（`frame.locator("#increment").evaluate(b => b.click())`）：`incrementClicks="1"`、`#counter` → **`Count 1 · activations 1`**、`incrementError=null`、`rootError=null` ⇒ **frame 的处理函数、Chord 服务调用、宿主状态变更、状态回流到 frame 这条链全部正常**。

⇒ **判定：属 lead 判据的第二支 —— 「点击没进 frame」，Playwright/Electron 在 Windows 上把坐标输入投递进跨源（OOPIF）扩展 frame 时没有触发其 DOM 事件；产品侧无缺陷。** 补充证据：`boundary` 显示 `preload/process/require = undefined`、`parentAccess = blocked`、`origin = "null"`，说明 frame 的沙箱隔离按设计生效（这一节本来就是安全用例）。
**影响面**：这条红**不是 T24 引入的**——同形失败在**开发/core 车道**也有（Windows 上 `extension-view-security.spec.ts:56` 同一点红，`:57`/`:134`/`:196` 同样卡在「点 Increment 后计数不动」），所以它是**跨车道、跨打包的测试前提问题**。
**修法方向（本轮不动手）**：这类断言若要跨平台，应避免依赖坐标输入进 OOPIF（例如在 frame 内触发、或对 frame 内交互改用 `frame.evaluate` 驱动的等价操作），或把该用例标为平台限定；**不要去改产品**。

### 5.4 两条绿的读法（`packaged-smoke` 强、`packaged-terminal` 弱）

- `packaged-smoke.spec.ts:11`（**强**）：`packaged-smoke-assertions.ts:6-42` 断言 `process.defaultApp=false` 且 `process.execPath` 就是 `win-unpacked\PAO.exe`、侧栏列出临时工作区、New thread → 填 prompt → Start thread → `.chat-header__title` 非空、composer 聚焦、transcript 含 prompt 文本 ⇒ **打包件能启动、能建线程、能跑完一条真实对话骨架**。
- `packaged-terminal.spec.ts:11`（**弱**）：它敲进终端的是字面量 `printf 'PI_PACKAGED_TERMINAL_OK\n'`（`:30`），断言只是「终端行里出现 `PI_PACKAGED_TERMINAL_OK`」（`:32`）；Windows 上集成终端是 `cmd.exe`，`printf` 不是命令，**但敲进去的字符本身被回显**，所以断言照样命中 ⇒ **通过不等于命令真执行**。对照 core 车道的 `workbench-tabs.spec.ts`（#34/#35）把字符串拆成两段才暴露出「POSIX 语法敲进 cmd.exe」的平台差。建议后续把它改成同一手法。

---

## §6 T24-D 未验与口径

### 6.1 未验（明说）

| 项 | 状态 | 原因 |
|---|---|---|
| `pao-live-smoke.spec.ts` | **未跑** | 需真实供应商凭证；按用户授权与明令不跑（该 spec 自己也有 `test.skip(...)` 在 `:21`），**已从命令里显式排除** |
| macOS 专属 6 条（`applications-relaunch`、3 条 release-zip、2 条通知族中的 `/Applications`/Finder 类） | **跑了、红了** | 需要 macOS 发行物（`.zip`/`.app`）或 macOS 系统 API；本机是 Windows |
| `finder-env-open-folder`、`open-folder-real` | **跑了、被 skip** | 用例自带 `test.skip(process.platform !== "darwin", …)`（`:16` / `:11`） |
| 整条车道的重打后复跑（第二次全量） | **未做** | 22:24 新包只跑了一轮全目录（13 例）；旧包那轮是选样 7 例 |
| `--shard` / 多 worker | **未做** | Windows 上配置即 1 worker；本轮串行 |
| 正式 PAO_HOME 影响面比对 | **未做** | 本轮所有 userDataDir 都是临时目录；`D:\AI\workspace\pao` 未读写（设计保证 + 未访问，非内容比对） |

### 6.2 口径一：**生产车道整体不在 CI 里**，所以「Windows 无基线」比 core 车道更彻底

- `desktop\.github\workflows\ci.yml` 里**没有任何 job 跑 `tests/production`**：Windows 作业（`:228-253`）只有 `verify:launcher-contract` → `test:changed-files` → `package:win:dir` → `verify:packaged-runtime-deps:windows`；core 车道在 `:105-150`（PR 走 ubuntu、推 main 走 macos，`--shard=N/4`）；还有一条 ubuntu 的 linux 打包依赖校验（`:166-188`）。
- `apps\desktop\package.json:71-78` 只有**逐 spec 的手动脚本**（`test:prod:packaged-smoke` / `:packaged-terminal` / `:notification-onboarding` / `:notification-settings` / `:applications-relaunch` / `:release-zip-smoke` / `:open-folder-real`），**没有整条车道的脚本**；且这些脚本都以 `pnpm run package:dir`（macOS 分支）开头，Windows 不可用。
- `docs\ci-baseline.md` 通篇**没提** production/packaged 车道（只在 `:68-69` 说明 Windows 打包作业是分开的、`pnpm check` 不覆盖它们）。
- ⇒ **`packaged-extension-view` 在任何平台的 CI 里都没被跑过**；§5.3 的红只能称「首次实测发现」，不能称回归。同理，§5.1/§5.2 的 macOS 专属红也不是回归。

### 6.3 口径二：**引用包数字必须注明是哪一次打的**

`release\win-unpacked` 已被本轮 22:24:11 那次覆盖。凡引用「264 文件 / 541.2 MB」「`app.asar` 200.86 MB」等数字时都属**14:24:56 那次**（正本 §2 口径）；
本轮的对应数字见 §A.4（264 文件 / 567,440,123 B；`app.asar` 210,616,175 B）。

### 6.4 顺带登记：F 批文档里三处与「T24 已有实测」互相矛盾（**只登记，未改**）

| 位置 | 原文（摘） | 与事实的冲突 |
|---|---|---|
| `.pao\harness完善-20261017\F批-全链离线验证\T01-T25-覆盖表.md:50`（T24 行） | 「**无**。本批未做打包，也没有任何解包发行跑次」…「**本机未做，无任何本轮证据**；新令禁止跑 Electron 桌面用例」 | 那是 F 批当时的状态；H 批已完成打包（14:24 与 22:24 两次 EXIT=0）与 production 车道实测 |
| 同文件 `:306` | `| L3 | 解包发行（pnpm run package:win:dir + packaged 测试） | 未验 | 本批未打包，无任何证据 |` | 同上，层级结论已过时 |
| `F批-对账结论.md:322` | `| U3 | 解包发行（pnpm run package:win:dir + packaged 测试） | 属 T24 / H 批 | T24 保持 \`未验\` |` | T24 已不再是「未验」 |
| `执行记录.md:484` | 「解包发行（T24）、机器重启 / 125% DPI / 真实读屏（T25）未做，T24/T25 保持 `未验`」 | 同上 |
| `执行记录.md:499` | `| H3 解包发行 | — | — | F 批已做掉大半，余「补发行口径」 |` | **与同一文件 `:484` 自相矛盾**（一个说未做，一个说已做掉大半） |

⇒ 我按 lead 指示**只登记不改**；请 lead 决定 F 批文档怎么订正（我这边的事实只有两条：①H 批已实测并有正本；②`执行记录.md` 内部两行互斥）。

---

## §7 环境与纪律

| 项 | 值 |
|---|---|
| OS / Node / pnpm | Windows 11 家庭版 中文版 10.0.26200 / v24.18.0 / 10.25.0 |
| Electron / Playwright / electron-builder | 37.10.3 / 1.58.2（1 worker、background 无重试）/ 26.8.1 |
| 每条 Electron 命令的前置 | `Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue`（该变量由 DSH 宿主注入；不清它 electron.exe 会退化成 Node，全套起不来） |
| 车道环境 | `PI_APP_TEST_LANE=production`、`PI_APP_REAL_AUTH=0`、`PI_APP_TEST_MODE=background`（A/B 那次单独用 `foreground`） |
| 隔离 | userDataDir 全部 `mkdtemp`；供应商凭证变量由 `buildDesktopLaunchEnv()` 剔除；未读写正式 PAO_HOME |
| 内核重建的仓影响 | `git -C PAO status --porcelain` 条目数 137 → 137；`packages/coding-agent/dist` 不被 git 跟踪 |
| 探针文件 | `apps\desktop\tests\production\zz-probe-frame-click.spec.ts`（5,204 B / 127 行）**已删除**；`git -C desktop status --porcelain -- apps/desktop/tests/production` 删除后为**空** |
| 残留进程（最后复查） | `electron` **0**、`PAO` **0**、`playwright` **0** |
| 现场产物 | 失败产物备份保留在 `T24-现场\生产车道-新包-失败产物\`（10 文件 / 298,921 B）；`test-results\` 现为 0 目录（原因见 §2 声明） |

---

## §8 附录：临时探针 spec 全文（已删除，照此可重放）

文件曾位于 `apps\desktop\tests\production\zz-probe-frame-click.spec.ts`（5,204 B / 127 行），**跑完已删**。全文：

```ts
/**
 * 临时探针（T24 判据缺口专用，未跟踪、跑完即删）。
 *
 * 目的：`tests/production/packaged-extension-view.spec.ts:56-57` 在 Windows 上点 frame 里的
 * `Increment` 后宿主状态不动。夹具 `tests/helpers/desktop-extension-fixture.ts:53-58` 专门把
 * `button.dataset.clicks` / `button.dataset.error` 记在 DOM 上，用来区分「点击丢了」还是
 * 「调用丢了」；但本项目 Playwright 对 Electron 的自动 trace 不含 DOM 快照，读不到这两个值。
 *
 * 本探针只做三件事（lead 2026-10-17 批准）：
 *   ① 打开同一夹具（同一打包产物、同一车道，流程照抄 packaged-extension-view.spec.ts）；
 *   ② 点 `Increment`；
 *   ③ `frame.evaluate` 读 `#increment` 的 dataset、`#counter` 文本、frame src。
 * 不做任何断言判断、不改产品源码、不改现有 spec/helper。输出以 `PROBE_FRAME_CLICK` 标记。
 */
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  installDesktopExtensionFixture,
  expectExtensionViewReady,
  openDesktopExtensionFixture,
} from "../helpers/desktop-extension-fixture";
import {
  launchPackagedDesktop,
  makeUserDataDir,
  makeWorkspace,
  startThreadFromSurface,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

type FrameReading = {
  counter: string | null;
  incrementClicks: string | null;
  incrementError: string | null;
  rootError: string | null;
  boundary: string | null;
};

test("zz probe: does the frame record the Increment click and/or a call error", async () => {
  test.setTimeout(120_000);
  const workspace = await makeWorkspace("zz-probe-frame-click");
  const harness = await launchPackagedDesktop(await makeUserDataDir(), {
    initialWorkspaces: [workspace],
    testMode: process.env.PI_APP_TEST_MODE === "foreground" ? "foreground" : "background",
  });
  try {
    const artifact = await harness.electronApp.evaluate(({ app }) => ({
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      defaultApp: Boolean(process.defaultApp),
    }));
    test.info().annotations.push({
      type: "artifact",
      description: JSON.stringify(artifact),
    });

    await installDesktopExtensionFixture(
      workspace,
      "http://127.0.0.1:9/unused",
      join(artifact.appPath, "node_modules", "@pi-gui", "extension-ui", "dist", "index.js"),
    );
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspace);
    await startThreadFromSurface(window, { prompt: "zz probe frame click" });

    const bridgeResponse = window.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.protocol === "pi-extension:" && url.pathname === "/_host/frame-bridge.js";
    });
    await openDesktopExtensionFixture(window);
    const bridgeStatus = (await bridgeResponse).status();
    const frameElement = window.getByTestId("extension-view-frame");
    const frame = window.frameLocator('[data-testid="extension-view-frame"]');
    await expect(frame.getByRole("heading", { name: "Security fixture" })).toBeVisible();
    await expectExtensionViewReady(window);

    const read = async (): Promise<FrameReading> =>
      frame.locator("body").evaluate((body) => {
        const increment = body.querySelector<HTMLButtonElement>("#increment");
        const counter = body.querySelector("#counter");
        const boundary = body.querySelector("#boundary");
        const root = body.firstElementChild as HTMLElement | null;
        return {
          counter: counter?.textContent ?? null,
          incrementClicks: increment?.dataset.clicks ?? null,
          incrementError: increment?.dataset.error ?? null,
          rootError: (root?.dataset.error ?? body.dataset.error) ?? null,
          boundary: boundary?.textContent ?? null,
        };
      });

    const before = await read();
    const frameSrc = await frameElement.getAttribute("src");
    await frame.getByRole("button", { name: "Increment", exact: true }).click();
    await window.waitForTimeout(2_000);
    const after = await read();

    console.log(
      "PROBE_FRAME_CLICK " +
        JSON.stringify({
          probe: "clicks-vs-error",
          bridgeStatus,
          sandbox: await frameElement.getAttribute("sandbox"),
          frameSrc,
          before,
          after,
          counterUnchanged: before.counter === after.counter,
        }),
    );

    // 追加一步（同一三件事内的另一种点法）：坐标点击既然没进 frame，就用 frame 内 DOM 自己点一次，
    // 看「处理函数 + 服务调用 + 状态回流」这条链本身通不通。只为把「输入没进 frame」钉死。
    await frame.locator("#increment").evaluate((button: HTMLButtonElement) => button.click());
    await window.waitForTimeout(2_000);
    const afterProgrammaticClick = await read();
    console.log(
      "PROBE_FRAME_CLICK " +
        JSON.stringify({
          probe: "programmatic-click",
          afterProgrammaticClick,
          counterChanged:
            afterProgrammaticClick.counter !== before.counter,
        }),
    );
  } finally {
    await harness.close();
  }
});
```

重放命令（逐字，cwd `D:\AI\workspace\pao-dev\desktop\apps\desktop`，先清 `ELECTRON_RUN_AS_NODE`、设 `PI_APP_TEST_LANE=production` `PI_APP_REAL_AUTH=0` `PI_APP_TEST_MODE=background`）：

```powershell
pnpm --dir ../.. exec playwright test -c apps/desktop/playwright.config.ts apps/desktop/tests/production/zz-probe-frame-click.spec.ts --reporter=line
```

两次输出见 `t24-probe-frame-click.log`（3,514 B，第一次仅坐标点击）与 `t24-probe-frame-click-2.log`（4,210 B，含 programmatic-click 追加步），关键行已在 §5.3 逐字抄录。

---

## §9 字节自检

```
# 本文件写入后实测（PowerShell：ReadAllBytes + UTF8.GetString）
T24-解包发行-Windows实测.md
# → bytes=38425 lines=473 fffd=0 ctrl=0 cjk=3819 bom=False  mtime=2026-10-17 22:57:41
```

校验口径：`\uFFFD` 计数 0（无编码损坏）、`[\x00-\x08\x0B\x0C\x0E-\x1F]` 计数 0（无控制字符）、无 BOM、UTF-8。
日志侧：本轮所有 Playwright 日志（`t24-production-*.log` 等）都是 **UTF-16LE + BOM**（`FF FE`，PowerShell 重定向所致），必须按 Unicode 解码再剥 ANSI，否则每个字符后夹 `\0`，正则什么都数不到（本轮踩过）。
