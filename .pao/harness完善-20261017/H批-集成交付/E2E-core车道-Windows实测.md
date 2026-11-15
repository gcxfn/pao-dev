# E2E core 车道 Windows 实测（2026-10-17）

- 产物路径：`D:\AI\workspace\pao-dev\.pao\harness完善-20261017\H批-集成交付\E2E-core车道-Windows实测.md`
- 本报告只记录**实际跑出来**的数字与原文；没跑的一律写「未做」，不估算、不外推。
- 原始日志（唯一事实源）：`e2e-core-full-20261017-195054.log`。本报告与日志冲突时**以日志原文为准**。

## 1 结论

**core 车道在本机 Windows 11 上从头跑到尾（357 个用例、1 worker、零重试），用真实 Electron 产物跑通了 smoke 与全量两轮：smoke 3/3 全绿，全量 `310 passed / 37 failed / 10 skipped (1.7h)`、退出码 1、总耗时 6,098.6 秒。37 条红里，平台相关 12 条、**既存失败 5 条（本批之前就存在、不是本批回归，见 §7）**、未定因 19 条、探针 1 条；没有任何一条红是「Electron 装坏了」或「产品起不来」。**

### 1.1 四段结论

| 段 | 内容 | 证据 |
|---|---|---|
| 起点问题已排除 | 先前「Electron 打不开、`bad option: --remote-debugging-port=0`」的根因是 **DSH 宿主注入到子进程的 `ELECTRON_RUN_AS_NODE=1`**，把 electron.exe 降级成 Node 跑。清掉该变量后 `electron.exe --version` = `v37.10.3`，smoke 3 passed。二进制本身完好（PE 完整、dist 75 文件 332,780,936 字节全齐）。与产品代码无关。 | `Electron可执行文件异常-诊断.md`；`e2e-smoke.log` |
| 本轮跑通 | 全量 core：357 用例、1 worker、串行、无重试（`retries = 0`，因 `PI_APP_TEST_MODE=background`）。日志收尾三行逐字：`37 failed` / `10 skipped` / `310 passed (1.7h)`；`END=2026-10-17 21:32:33`、`EXIT=1`、`ELAPSED_SEC=6098.6`。 | `e2e-core-full-20261017-195054.log` |
| 红的构成 | 37 条红全部是断言/超时失败，**没有一条是「应用起不来」或「Electron 启动失败」**；应用起来后 UI 都渲染了（失败截图可查）。 | `apps/desktop/test-results/*/test-failed-*.png` |
| 最关键的 3 条 | ① **12 条属 Windows 专属的平台差**，可归成三个子类：窗口内容区 ≠ `setSize` 外框（恒差 14×36）、把 POSIX shell 语法敲进 cmd.exe、路径编码/缩写；② **5 条是「侧栏 Skills/Extensions 按钮不存在」**，**已用同平台 A/B 实测定案**：HEAD（`2cf4c807`）上跑同样的 3 个 spec，结果同样是 5 failed / 1 passed、挂点逐字相同；根因提交 `c3e68243`（2026-10-04 20:01:48 +0800，`git merge-base --is-ancestor` 证实是 HEAD 的祖先、早 48 个提交）里用户拍板把这两个按钮从侧栏挪进设置，而该提交没改这几个 spec ⇒ **既存失败（E 类），不是本批回归；lead 原来的「本批回归」定性已撤回**；③ **19 条未定因里，#19/#20 已给出根因级证据且都与本批改动无关，另有 2 条（#1、#13）做了部分定位**。 | §6 / §7 / §8 |

### 1.2 从零结论

- 「Electron 起不来」不是产品问题，是**进程环境变量**问题；本机 `ELECTRON_RUN_AS_NODE` 只在 Process 作用域，User/Machine 与注册表都没有，来源是 DSH 桌面宿主为「Node 模式子进程」显式注入（`app.asar` 内 `function desktopNodeEnvironment(...)` 含 `ELECTRON_RUN_AS_NODE: "1"`），经 `dsh-subprocess-local/lib/runner.js` 原样透传进每个 shell 命令。
- **跑本仓任何 Electron 用例前，清掉这个变量是硬前置**，否则会得到「Electron 装坏了」的假红。已写进运行须知。

### 1.3 口径优先级

1. 数字与失败原文以 `e2e-core-full-20261017-195054.log` 为准。
2. 失败逐条定性以本报告 §5 表为准；表里的「断言点」是我复核后的真实报错行，可能与 Playwright 报的用例起始行不同。
3. 本报告与任何分步记录冲突时，以日志原文为准。

## 2 本次产物

| 文件（同目录 `H批-集成交付\`） | 说明 |
|---|---|
| `E2E-core车道-Windows实测.md` | 本报告 |
| `e2e-core-full-20261017-195054.log` | 全量 core 原始日志（295,430 B，含 37 条失败全文与收尾统计） |
| `解析-e2e日志.mjs` | 日志解析脚本（**处理 Windows 上 Playwright 日志是 UTF-16LE+BOM** 的坑） |
| `核对-e2e两条判据.mjs` | 三条判据的可复现脚本（文件名保留「两条」，实际含三条：#20 的 id 正则、#21/#25 的 CSS 转义） |
| `e2e-build.log` | 构建日志（3,522 B） |
| `e2e-smoke.log` | smoke 锚点日志（本轮那次 3 failed 的原文，用于记录 ELECTRON_RUN_AS_NODE 坑） |
| `head-ab-build.log` | HEAD worktree 的构建日志（3,522 B，`EXIT=0`／17.9 秒） |
| `head-ab-run.log` | HEAD worktree 跑 3 个 spec 的 A/B 日志（24,706 B，UTF-16LE+BOM；`5 failed` / `1 passed (3.3m)`） |
| `Electron可执行文件异常-诊断.md` | electron.exe 二进制取证（9,975 B / 165 行，结论：文件完好，是环境变量降级） |
| `electron-pe.json` | PE 头/节表/特征串偏移的机器可读结果（10,346 B） |
| `诊断-electron-pe.mjs` | 上面那份 JSON 的生成脚本（5,287 B） |
| `运行须知-本机core-lane.md` | 本机跑 core 车道的坑清单（含 `ELECTRON_RUN_AS_NODE` 硬前置） |

## 3 跑法与前置（逐字）

### 3.1 硬前置：清掉 `ELECTRON_RUN_AS_NODE`

```powershell
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
```

### 3.2 构建（cwd `D:\AI\workspace\pao-dev\desktop`）

```powershell
pnpm --filter @pi-gui/desktop run build
```

结果：`EXIT=0`，`START 19:38:07 / END 19:38:29`，**22 秒**。产出 `out/main/main.js 1,188.76 kB`、`out/preload/preload.js 29.64 kB`、renderer `index-*.js 3,774.07 kB` + `index-*.css 244.57 kB`。日志 `e2e-build.log`（3,522 B）。
本轮 E2E 跑的就是这次构建的产物（`out/renderer` 目录 mtime 19:38:29，未被后续改动污染）。

### 3.3 smoke 锚点（cwd `D:\AI\workspace\pao-dev\desktop\apps\desktop`）

```powershell
$env:PI_APP_TEST_LANE='core'; $env:PI_APP_REAL_AUTH='0'; $env:PI_APP_TEST_MODE='background'
pnpm --dir ../.. exec playwright test -c apps/desktop/playwright.config.ts apps/desktop/tests/core/smoke.spec.ts --reporter=line
```

- **未清变量时**：3 failed / 9.5 s，三条全部挂在 `helpers\electron-app.ts:166`，首错 `electron.exe: bad option: --remote-debugging-port=0`（exitCode=9）。
- **清掉变量后**：`3 passed / 35.5 s / EXIT=0`（lead 亲测，同样的 spec 与同样的隔离环境）。

### 3.4 全量 core（本轮主跑，后台 job `pwsh-caab88e12fd64007`）

```powershell
$ts=Get-Date -Format 'yyyyMMdd-HHmmss'
$log="D:\AI\workspace\pao-dev\.pao\harness完善-20261017\H批-集成交付\e2e-core-full-$ts.log"
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:PI_APP_TEST_LANE='core'; $env:PI_APP_REAL_AUTH='0'; $env:PI_APP_TEST_MODE='background'
$env:NO_COLOR='1'; $env:FORCE_COLOR='0'
$sw=[System.Diagnostics.Stopwatch]::StartNew()
Set-Location D:\AI\workspace\pao-dev\desktop\apps\desktop
& pnpm --dir ../.. exec playwright test -c apps/desktop/playwright.config.ts apps/desktop/tests/core --reporter=line *> $log
```

坑（已踩，供复用）：①`pnpm --dir ../..` 的 cwd 必须是 `desktop\apps\desktop`，在 `desktop` 下跑会 `ERR_PNPM_RECURSIVE_EXEC_NO_PACKAGE`；②spec 位置参数必须用**相对路径**（`apps/desktop/tests/core`），传绝对路径 Playwright 报 `No tests found`；③**输出重定向后是 UTF-16LE+BOM**，用 `fs.readFileSync(p,"utf8")` 解析会得到夹 `\u0000` 的乱码、所有正则数不到（`解析-e2e日志.mjs` 已按 BOM 分支修正）；④Playwright 的 line reporter 会把 `ESC[1A ESC[2K` 插进单词中间做局部重绘，匹配失败表头前必须先把 ANSI 剥净。

### 3.5 环境事实

| 项 | 值 |
|---|---|
| Windows | 11 家庭版 中文版，10.0.26200 / Build 26200 |
| CPU | 13th Gen Intel Core i7-13650HX，14 核 / 20 逻辑处理器 |
| Node / pnpm | v24.18.0 / 10.25.0 |
| Electron | 37.10.3（`electron.exe` 204,521,984 B，SHA256 `8D205E25B40DA3ADA4A08C92F32BFBD8E8D38EDB4BFE443DEEA77FC9DE685BAC`） |
| Playwright | 1.58.2（`playwright`/`playwright-core`/`@playwright/test` 同版） |
| 隔离 | `helpers/electron-app.ts:446-491 buildDesktopLaunchEnv()` 设临时 `PI_APP_USER_DATA_DIR`、`PI_CODING_AGENT_DIR`，并删掉所有供应商凭证变量 |
| 车道 | `PI_APP_TEST_LANE=core`、`PI_APP_REAL_AUTH=0`、`PI_APP_TEST_MODE=background` |
| 并发 | 1 worker（Windows 默认；Linux+background 才 3） |
| 重试 | 0（background 模式 `retries = 0`） |

## 4 总数 · 通过 · 失败 · 耗时（实测）

| 项 | 值 |
|---|---|
| 用例总数 | 357 |
| 通过 | 310 |
| 失败 | 37 |
| 跳过 / 未跑 | 10（逐条见 §4.1） |
| worker / 重试 | 1 / 0 |
| 总耗时 | 6,098.6 秒（1.7 小时；`END=2026-10-17 21:32:33`） |
| 退出码 | 1 |
| 原始日志 | `e2e-core-full-20261017-195054.log`（295,430 B） |

310 + 37 + 10 = 357 ✓（与日志收尾 `310 passed (1.7h)` 自洽）。

### 4.1 被跳过的 10 条（不是「没跑」，是 `test.skip` 主动跳过）

用 `grep 'skip' apps/desktop/tests/core` 实测：整个 core 车道只有 **7 个 skip 调用点、分布在 6 个文件**，其中 1 个在本轮条件下不生效，其余 6 个覆盖 10 个用例 —— 与日志的 `10 skipped` 完全对上。

| # | 文件:行 | skip 条件（逐字） | 覆盖用例数 |
|---|---|---|---|
| 1–5 | `core/app-lifecycle.spec.ts:47`（在 `test.describe("macOS last-window lifecycle")` 内，文件 46–107 行全在这个 describe 里） | `process.platform !== "darwin"`，原因 `"macOS keeps a normal app alive after its last window closes."` | **5**（2 个 `VALID_TEST_MODES`＝background/foreground 的「关最后一个窗口后退出」，3 个 `NORMAL_LIFECYCLE_CASES`＝unset/empty/invalid 的「保留正常行为」） |
| 6 | `core/changed-files.spec.ts:21` | `process.platform === "win32"`，原因 `"Windows rejects these characters in filenames."` | 1 |
| 7–8 | `core/extension-github-view.spec.ts:94` 与 `:149` | 两条都是 `process.platform === "win32"`，原因 `"The fake gh is a POSIX executable; Windows has a separate native verification lane."` | 2 |
| 9 | `core/extension-examples.spec.ts:170` | `process.platform === "win32"`，原因 `"The offline gh fixture uses a POSIX executable; Windows has a separate native verification lane."` | 1 |
| 10 | `core/open-folder.spec.ts:50` | `process.platform !== "darwin"`，原因 `"The application menu is only installed on macOS."` | 1 |

- 合计 5+1+2+1+1 = **10** ✓。
- **第 7 个 skip 调用点不生效**（如实登记）：`core/real-auth-contract.spec.ts:6` 的条件是 `process.env.PI_APP_REAL_AUTH === "1"`，本轮该变量为 `0` ⇒ **没有跳过**，该用例真跑了，且在 310 条通过项里。
- 这 10 条的跳过都与本批改动无关：全是平台条件（Windows 无 POSIX 假 `gh`、无 macOS 应用菜单/生命周期、文件名禁字符），属**测试的既定平台收敛**。

## 5 逐条失败清单（37 条）

「用例」= Playwright 报的起始行；「断言点」= 我复核后的真实报错位置；「类」见 §6–§9。

| # | 用例 | 断言点 | 首错摘要 | 类 |
|---|---|---|---|---|
| 1 | `composer-image-limits.spec.ts:269` | `:336:33` | `ENOENT …\attachments\C%3A%5CUsers%5C…%3A01a149ba….json` | C |
| 2 | `custom-endpoints.spec.ts:407` | `:439:5` | `setSize(900,600)` 后 `innerWidth/Height` = `886×564` | A |
| 3 | `extension-command-compatibility.spec.ts:47` | `:129:75` | 点击 `getByRole('button',{name:'Extensions'})` 30 s 超时 | E |
| 4 | `extension-dock-reload.spec.ts:44` | `:73:75` | 同上（Extensions 按钮） | E |
| 5 | `extension-dock-reload.spec.ts:95` | `:123:75` | 同上（Extensions 按钮） | E |
| 6 | `extension-examples.spec.ts:36` | `:68:7` | 扩展 iframe 里 `heading "Passing fixture · Command completed · exit 0"` 不存在 | C |
| 7 | `extension-trace-view.spec.ts:86` | `:177:52` | iframe 里 `#trace-args` 元素不存在 | C |
| 8 | `extension-usage-view.spec.ts:93` | `:105:24` | `clickSession("Review the redesign PR")` 30 s 超时：侧栏一条会话行都没有 | C |
| 9 | `extension-view-links.spec.ts:65` | `:110:5` | `openedLinks` `toEqual` 不符 | C |
| 10 | `extension-view-security.spec.ts:18` | `:56:29` | `Increment` 按钮 `data-*` 属性期望 `"1"` 实收 `""` | C |
| 11 | `extension-view-security.spec.ts:111` | `:134:45` | `#counter` 期望 `Count 1 · activations 1` 实收 `Count 0 · activations 1` | C |
| 12 | `extension-view-security.spec.ts:140` | `:196:51` | `#counter` 期望 `Count 2 · activations 1` 实收 `Count 1 · activations 1` | C |
| 13 | `extensions-dialogs.spec.ts:231` | — | `Test timeout of 60000ms exceeded.` | C |
| 14 | `extensions-session-isolation.spec.ts:26` | `:47:57` | `.chat-header__title` 期望 `Marked by extension` 实收 `Session A` | C |
| 15 | `f-probe-owner.spec.ts:97` | — | `Test timeout of 180000ms exceeded.`（探针用例） | D |
| 16 | `integrated-terminal.spec.ts:137` | `:165:5` | 粘贴计数 `toBe(1)` 实收 `0` | A |
| 17 | `integrated-terminal.spec.ts:178` | `:221:51` | 终端里出现 `SyntaxError: … Unterminated string constant` | A |
| 18 | `mcp-settings.spec.ts:194` | `:212:60` | 期望 `C:\Users\…\mcp.json`，实收 `~\AppData\…\mcp.json` | A |
| 19 | `persistence.spec.ts:579` | `:674:56` | `getByTestId('workspace-list')` 元素不存在（第二次启动工作区被整体丢弃） | C |
| 20 | `queued-messages.spec.ts:111` | `:162:65` | `getByTestId('queued-composer-editing')` 元素不存在（点 Edit 时 IPC 抛错） | C |
| 21 | `review-scopes.spec.ts:258` | `:291:5` | 点「切换 checkout」菜单项 30 s 超时（选择器被 CSS 转义吞掉） | A |
| 22 | `secondary-surface-inset.spec.ts:26` | `:42` / `:48:55` | (b) `Skills` 按钮 30 s 超时；(a) `Settings height` `toBeCloseTo` 32.6667 vs 32 | E（(b) 属 E 类；(a) 属 A 类机制） |
| 23 | `session-lease.spec.ts:31` | `:63:45` | 租约持有者 pid 期望 `33076` 实收 `30152` | C |
| 24 | `side-panel-picker.spec.ts:11` | `:95:53` | `.xterm-rows` 期望 `/i-search/`，实收 cmd.exe 横幅 + `^R` | A |
| 25 | `sidebar-folder-collapse.spec.ts:12` | `:35:56` | `.workspace-group[data-workspace-id="C:\\…"]` 解析到 **0 个元素** | A |
| 26 | `sidebar-toggle.spec.ts:119` | `:175:71` | 点击 `getByRole('button',{name:'Skills'})` 30 s 超时 | E |
| 27 | `sidebar-toggle.spec.ts:227` | `:87:3`（调用点 `:250`） | 期望 `{1200,760}` 实收 `{1186,724}` | A |
| 28 | `thread-menu.spec.ts:109` | `:180-182` | 复制会话 ID 后 `navigator.clipboard.readText()` 期望 session id 实收 `""` | C |
| 29 | `timeline-overflow.spec.ts:224` | `:63:3`（调用点 `:248:5`） | `setSize(1500,950)` 后 `innerWidth/Height` = `1486×914` | A |
| 30 | `timeline-overflow.spec.ts:286` | `:63:3`（调用点 `:297:5`） | `setSize(800,900)` 后 `innerWidth/Height` = `786×864` | A |
| 31 | `timeline-pinning.spec.ts:518` | `:561` | `mouse.wheel(0,-520)` 后 `remainingFromBottom` 期望 `>700` 实收 `520.333` | C |
| 32 | `timeline-pinning.spec.ts:728` | `:834`（谓词体 `:836`） | `expect.poll` 谓词 5 s 超时（等 sentinel 行位置） | C |
| 33 | `transcript-annotations.spec.ts:76` | — | `Test timeout of 90000ms exceeded.` | C |
| 34 | `workbench-tabs.spec.ts:117` | `:142:51` | 终端期望 `WORKBENCH_READY`，实收 cmd 回显 + `'printf' 不是内部或外部命令` | A |
| 35 | `workbench-tabs.spec.ts:347` | `:365:51` | 终端期望 `SHELL_READY`，实收 cmd 回显 + `'export' 不是内部或外部命令` | A |
| 36 | `workspace-file-lines.spec.ts:72` | `:172:66` | 点按钮（accessible name 含 Windows 绝对路径 `…\src\app.ts:3`）30 s 超时 | C |
| 37 | `worktrees.spec.ts:113` | `:137:36` | `expect(legacyWorkspace.kind).toBe("worktree")`，实收 `"primary"` | C |

分类计数：A 类 12 条（#2、#16、#17、#18、#21、#24、#25、#27、#29、#30、#34、#35）／**E 类既存失败 5 条（#3、#4、#5、#22、#26）**／C 类 19 条（#1、#6–#14、#19、#20、#23、#28、#31、#32、#33、#36、#37）／D 类 1 条（#15）。另：#22 的 (a) 断言虽落在 E 类用例里，机制属 A 类（§6.5），故 A 类**机制**共 13 处、**用例** 12 条。**B 类（本批回归）为 0 条**——lead 原先的 B 类定性已撤回，见 §7。

## 6 A 类：平台相关（12 条，三个子类）

### 6.1 子类一：窗口内容区 ≠ `setSize` 外框（#2、#27、#29、#30）

**凡是在 Windows 上断言「`BrowserWindow.setSize(w,h)` 之后 `window.innerWidth/innerHeight` 等于 `w,h`」的用例必挂，差值恒为 14×36（水平 14、垂直 36）。**

| # | 用例 | setSize 入参 | innerWidth/Height 实测 | 差 |
|---|---|---|---|---|
| 2 | `custom-endpoints.spec.ts:437` | `900×600` | `886×564` | 14×36 |
| 27 | `sidebar-toggle.spec.ts:250` | `1200×760` | `1186×724` | 14×36 |
| 29 | `timeline-overflow.spec.ts:248`（helper `:63 setElectronWindowSize`） | `1500×950` | `1486×914` | 14×36 |
| 30 | `timeline-overflow.spec.ts:297`（同一 helper） | `800×900` | `786×864` | 14×36 |

四条报错形态完全一致：`expect(received).toEqual(expected)`（深层比较 width/height）+ `Call Log: - Timeout 5000ms exceeded while waiting on the predicate`（`expect.poll` 用 5 s 的 `expect.timeout`），全部停在同一个 helper `timeline-overflow.spec.ts:63` / `custom-endpoints.spec.ts:439` / `sidebar-toggle.spec.ts:87`。
机制：Windows 的 `setSize` 设置的是**窗口外框**，`innerWidth/Height` 读的是**内容区**，差的就是窗口边框（14 水平、36 垂直）；Linux/xvfb 下无边框或边框为 0，所以相等。
判定：**A 类，平台相关，非本批回归**。修法方向（不改测试也可不改产品）：测试改断言内容区尺寸，或产品侧改用 `setContentSize`——由用户定，我不替他定。

### 6.2 子类二：把 POSIX shell 语法敲进 cmd.exe（#17、#24、#34、#35）

**终端类 spec 假设了 POSIX shell，Windows 上跑的是 cmd.exe，必挂。共同形状：期望某个 `X_READY` 子串，实收是 cmd 把整行原样回显（外加「不是内部或外部命令」）。**

| # | 用例:断言点 | 敲进去的东西 | 实收（关键片段） |
|---|---|---|---|
| 17 | `integrated-terminal.spec.ts:221` | `node -e '…单引号包裹…'` | cmd 回显 + `SyntaxError: Invalid or unexpected token` / `Unterminated string constant` |
| 24 | `side-panel-picker.spec.ts:95` | `Ctrl+R`（等 readline 的 `/i-search/`） | cmd 横幅 + `…workbench-shortcuts>^R`（cmd 没有 reverse-i-search） |
| 34 | `workbench-tabs.spec.ts:142` | `printf 'WORKBENCH_READY\n'` | 回显停在 `>printf 'W…` + `'printf' 不是内部或外部命令，也不是可运行的程序或批处理文件。` |
| 35 | `workbench-tabs.spec.ts:365` | `export PI_GUI_WORKBENCH_CANARY=retained; printf 'SHELL_READY\n'` | 回显停在 `>export PI…` + `'export' 不是内部或外部命令…` |

判定：**A 类，平台相关，非本批回归**。这四条与 H2 批的终端/ConPTY 工作同属一个家族，但**根因是测试的 shell 假设，不是终端实现**（终端确实跑起来了、也确实在跑 cmd.exe）。

### 6.3 子类三：路径编码 / 缩写（#18、#21、#25）

**(a) 家目录缩写（#18）**：`mcp-settings.spec.ts:212/213` 断言界面上出现 `join(agentDir,"mcp.json")` 的**原路径**（`agentDir` 在 `userDataDir` 下，即系统临时目录），实测界面显示 `~\AppData\…\mcp.json`。
产品侧机制（与 HEAD 相同、非本批改动）：`electron/application/app-store.ts:5214-5218`
```ts
/** Shows a path under the home directory as `~/…`, the way pi's docs and terminal name it. */
function withHomeAsTilde(path: string): string {
  const home = homedir();
  return path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}
```
Linux/macOS 的临时目录在 `/tmp`（不在家目录下）→ 不缩写 → 用例绿；Windows 的临时目录是 `C:\Users\ASUS\AppData\Local\Temp\…`（**在家目录下**）→ 被缩写成 `~\AppData\…` → 用例红。
附注（不阻塞）：`~` 缩写会同时吞掉 `AppData\Roaming`（APPDATA）与 `AppData\Local`（LOCALAPPDATA）的区分度，是可在产品侧讨论的小问题，但**不是缺陷**——注释写明它就是要有意「像文档/终端那样显示 `~`」。

**(b) CSS 属性选择器吞反斜杠（#21、#25）**：**测试把 Windows 绝对路径直接拼进 CSS 属性选择器，反斜杠被 CSS 当转义符吃掉，选择器永远匹配不到。** 判据脚本 `核对-e2e两条判据.mjs`（2,399 B / 46 行 / FFFD=0 / CTRL=0）实测：

| # | 拼出来的选择器 | CSS 解析后的值 | 与 DOM 属性相等 |
|---|---|---|---|
| 21 | `[data-option-id="C:\Users\ASUS\…\wt-c3793e"]` | `C:Users⏎SUS⏎ppDataLocalTemppi-gui-user-data-abpAruworktreesreview-checkout-rootwt-c3793e` | **false** |
| 25 | `.workspace-group[data-workspace-id="C:\Users\ASUS\…\collapse-alpha"]` | `C:Users⏎SUS⏎ppDataLocalTemppi-gui-workspace-seRWHJ⏎ollapse-alpha` | **false** |

- #21 代码位置：`apps/desktop/tests/helpers/electron-app.ts:1894-1897 chooseReviewCheckout()` → `menu.locator(\`[role="menuitemradio"][data-option-id="${checkoutId}"]\`).click()`；`chooseReviewCheckout` 由 `2357de51`（2026-09-26）引入。全仓 `data-option-id` 插值**只有这一处**（grep 实测）。
- #25 代码位置：`apps/desktop/tests/core/sidebar-folder-collapse.spec.ts:28,33` —— `workspaceId = alpha.id`（工作区绝对路径）后拼选择器，Playwright 报 `9 × locator resolved to 0 elements`。
- **同病根已被修过一次**：提交 `cb05ccf5`（2026-10-08）的正文逐字为「不再把Windows反斜杠路径拼CSS属性选择器（getAttribute读得到但选择器被转义吞）」，但那次没修到这两个 helper/用例。
- 判定：**A 类，平台相关**（Linux/macOS 的路径用 `/`，不是转义符，不会红）；**不是本批回归**（`electron-app.ts` 在本批只有 `reloadDesktopRenderer` 的重试改动 +12/−1，与本节无关；`sidebar-folder-collapse.spec.ts` 本批未改）。修法：`CSS.escape` 或改 `getByRole` + 文本。

### 6.4 剪贴板（#16）

`integrated-terminal.spec.ts:165` 数 `.xterm-rows` 里粘贴文本出现次数，`toBe(1)` 实收 `0`。**未做到根因**（未验 Windows 剪贴板 API / ConPTY 与 `readText()` 的交互）。判定：**A 类（疑似平台），但只做到「疑似」**。
旁证（同一家族、不构成结论）：#28 是**反方向**的同一操作——`navigator.clipboard.readText()` 读回空串。两条一起看，指向「本机 background 测试模式下的剪贴板读写都不通」，但本轮没做实验坐实。

### 6.5 亚像素/DPI 舍入（#22 的软断言 a）

`secondary-surface-inset.spec.ts:48` `expect.soft(backToApp.height, "Settings height").toBeCloseTo(newThread.height, 0)`：期望 `32.66667175292969`、实收 `32`，差 `0.667 > 0.5` 的精度门。**这与 6.1 不是同一机制**（不是固定 14×36，而是小数被舍成整数），属 DPI/布局取整差异。
判定：**A 类，机制独立**。注意 #22 的另一半是 E 类既存失败（见 §7）。

## 7 E 类：既存失败（5 条，本批之前就红，不是本批回归）

### 7.1 症状与逐条挂点（全量跑实测）

5 条红都指向同一个东西：**侧栏里不存在可被 `getByRole("button", { name: "Skills"|"Extensions", exact: true })` 命中的按钮**。

| # | 用例 | 断言点 | 要点的名字 |
|---|---|---|---|
| 3 | `extension-command-compatibility.spec.ts:47` | `:129:75` | Extensions |
| 4 | `extension-dock-reload.spec.ts:44` | `:73:75` | Extensions |
| 5 | `extension-dock-reload.spec.ts:95` | `:123:75` | Extensions |
| 22 | `secondary-surface-inset.spec.ts:26` | `:42` | Skills（循环 `["Settings","Skills","Extensions"]`，Settings 能点到） |
| 26 | `sidebar-toggle.spec.ts:119` | `:175:71` | Skills |

界面实证（第一手，非推断）：读 `test-results\core-extension-command-com-ad55a-learns-terminal-only-status\test-failed-1.png`（2199×1415），侧栏自上而下是：New thread / Workflow「Steps of the running plan」/ Work board「Cards grouped by their current status」/ Temporary plans「Plans not yet filed」/ Threads「Conversations」/ Scheduled / 说明文字 / Department detail / PAO flow / Progress / Latest result / Threads 段（分组 + 文件夹图标）/ 会话行 / 底部 Settings。**没有 Skills，也没有 Extensions。**

### 7.2 定案证据一：同平台 A/B 实测（HEAD 上同样红）

做法：`git worktree add ..\.t-head --detach HEAD` 拉一份 HEAD（`2cf4c807`）到 `D:\AI\workspace\pao-dev\.t-head`，把 `node_modules` 以 **junction** 指向 `desktop\node_modules`（该仓 `desktop\.npmrc` 是 `node-linker=hoisted`，主依赖都在 `desktop\node_modules`；另按需给 `apps/desktop` 与 `packages\{catalogs,extension-ui,pi-sdk-driver}` 建了 4 个 junction，`LinkType=Junction` 已核）。逐字命令（cwd `D:\AI\workspace\pao-dev\.t-head`，前置 `Remove-Item Env:\ELECTRON_RUN_AS_NODE`）：

```powershell
pnpm --filter @pi-gui/desktop run build   # EXIT=0，17.9 秒；out/main/main.js 1,138,809 B、out/renderer/index.html 477 B
# cwd 换成 .t-head\apps\desktop：
pnpm --dir ../.. exec playwright test -c apps/desktop/playwright.config.ts `
  apps/desktop/tests/core/sidebar-toggle.spec.ts `
  apps/desktop/tests/core/extension-dock-reload.spec.ts `
  apps/desktop/tests/core/extension-command-compatibility.spec.ts --reporter=line
# EXIT=1，ELAPSED_SEC=198.7，日志 24,706 B
```

结果逐字：**`5 failed` / `1 passed (3.3m)`**，5 条与全量跑里的同名同点、`waiting for` 也逐字相同：

| HEAD 上第几条 | 用例 | HEAD 上的首错 |
|---|---|---|
| 1 | `extension-command-compatibility.spec.ts:47:5` | `TimeoutError: locator.click: Timeout 30000ms exceeded.` / `- waiting for getByRole('button', { name: 'Extensions', exact: true })` |
| 2 | `extension-dock-reload.spec.ts:44:5` | 同上（Extensions 按钮） |
| 3 | `extension-dock-reload.spec.ts:95:5` | 同上（Extensions 按钮，断言点 `:123:75`） |
| 4 | `sidebar-toggle.spec.ts:119:5` | `- waiting for getByRole('button', { name: 'Skills', exact: true })` |
| 5 | `sidebar-toggle.spec.ts:227:5` | `expect(received).toEqual(expected)`：期望 `{height:760,width:1200}` 实收 `{height:724,width:1186}`（即全量跑的 #27，A 类窗口尺寸，**在 HEAD 上同样重现**） |

⇒ **#3、#4、#5、#26 这 4 条在 HEAD 上逐字同挂**（`getByRole` 点的就是那两个不存在的侧栏按钮）；附带把 A 类窗口尺寸的 #27 也钉成「HEAD 既有、与平台相关」。
**未覆盖**：本次 A/B 只跑了这 3 个 spec，**#22（`secondary-surface-inset.spec.ts`）不在其中、未做该条的 HEAD 实跑**，它按 §7.3 的提交级证据归类（该 spec 也是点侧栏 `Skills`/`Extensions` 按钮的那个循环）。

收尾（全部实测）：junction 用 `cmd /c rmdir`（只删链接、绝不递归进目标）逐个摘除 → `git worktree remove ..\.t-head --force` **EXIT=0** → `git worktree list` 只剩 `D:/AI/workspace/pao-dev/desktop 2cf4c807 [main]`、`.t-head` 目录已消失；`desktop\node_modules` 条目数 **588 → 588**（前后一致）、`electron`/`playwright` 残留 **0 / 0**。

### 7.3 定案证据二：提交级铁证（根因提交 `c3e68243`）

**根因提交（lead 查实、我已复核）**：`git log -S'Skills' -- apps/desktop/src/features/threads/sidebar.tsx` 直接指向 `c3e682433ae5de04cd3abef6674dd29af9675fbf`（2026-10-04 20:01:48 +0800）；`git merge-base --is-ancestor c3e68243 HEAD` 退出码 0 ⇒ **它是 HEAD 的祖先，比 HEAD 早 48 个提交**。该提交从 `sidebar.tsx` **删掉的行（原文）**：

```
-  readonly onOpenSkills: (workspaceId?: string) => void;
-  readonly onOpenExtensions: (workspaceId?: string) => void;
-    onOpenSkills,
-    onOpenExtensions,
-              onOpenSkills(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id)
-            <span>{t("Skills")}</span>
-              onOpenExtensions(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id)
-            <span>{t("Extensions")}</span>
```

它的提交说明原文（用户自己的决定）：「**②技能/扩展两按钮从nav删除(用户2026-10-04拍板:设置里可进;命令面板入口保留——App.tsx openSkills/openExtensions仍供useDesktopCommands消费)**」。该提交改的测试只有 `apps/desktop/tests/unit/git-review.spec.ts`（+14）与 `apps/desktop/tests/unit/thread-groups.spec.ts`（+36），**`sidebar-toggle.spec.ts` 一个字没动**；`git log -L 175,175:apps/desktop/tests/core/sidebar-toggle.spec.ts` 只列出创建它的 `dc79b758`（2026-04-28）⇒ 那句 `getByRole("button", { name: "Skills", exact: true })` 从 2026-04-28 起一字未改。

⇒ **这 5 条从 2026-10-04 起就挂了，是 48 个提交之前的老账。lead 原先「本批 D 回归」的定性已由 lead 本人撤回，§7 的两种口径已合并为本节这一条单一结论。**

我在读到该提交前的静态复核（三条，方向一致，留作旁证）：

我按同一批证据链复核，**无法证实这 5 条是本批改动造成的**，理由如下（全部可复现）：

1. **本批 `src` diff 没有删除任何一处 Skills/Extensions 入口。**
   `git -C D:\AI\workspace\pao-dev\desktop diff HEAD -- apps/desktop/src` 里，被删除的行中**没有一行**含 `Skills` 或 `Extensions`（唯一命中是 diff 头 `--- a/apps/desktop/src/features/extensions/extension-session-ui.tsx`，那是文件名）。
2. **HEAD 上不存在这样的按钮。**
   `git grep -F '"Skills"' HEAD -- apps/desktop/src` 的命中里，唯一可能成为按钮的是 `features/extensions/customize-page.tsx:238-243`，而它显式写着 **`role="tab"`**（`getByRole("button", …)` 不会命中 `role="tab"`）；另一处 `features/canvas/canvas-page.tsx:1432 label={t("Skills")}` 是**只读详情行**（同一节点的工作区版本在 `:1516-1517`，带 `value={detail.template?.skills?.length ? … : t("None")}`），**不是按钮**；`sidebar.tsx` 在 HEAD 里 `Skills|Extensions` 命中数为 0。
3. **入口被删的时间早于 HEAD。**
   `apps/desktop/tests/core/extensions.spec.ts:753` 的原注释写：「fork 定制（用户 2026-10-04 拍板，c3e6824）删除了 sidebar 的 Skills/Extensions 入口」；同文件 `:755-760` 的 `openExtensionsSurface()` 已改成走命令面板（`input.fill("Extensions")` + `getByRole("option", …)`）。**c3e6824 早于 HEAD `2cf4c807`（2026-10-10）**，且 `extensions.spec.ts` 与本批改动的 `sidebar-toggle.spec.ts`、`secondary-surface-inset.spec.ts`、`extension-dock-reload.spec.ts` 都**不在本批修改文件列表里**。

（上列三条只是静态旁证，且方向一致；**决定性证据是本节开头的提交级铁证 + §7.2 的 HEAD 同平台实跑**。lead 原先「本批回归」的定性已撤回，不再保留第二种口径。）

### 7.4 修复方向（测试侧老账，本轮按 lead 指示不动手）

- **这是测试侧的老账，不是产品缺陷。** 用户 2026-10-04 已拍板「设置里可进、命令面板入口保留」，所以正确修法是让 spec 改走「设置 → `Skills and extensions` 导航项」（`settings-sections.tsx` 的 `SETTINGS_NAV_ITEMS` 里 `id: "customize"`、`title: "Skills and extensions"`，由 `secondary-surfaces.tsx:412` 的 `navItems={SETTINGS_NAV_ITEMS}` 渲染成按钮）或命令面板（`extensions.spec.ts:755-760 openExtensionsSurface()` 已有现成写法：`input.fill("Extensions")` + `getByRole("option", …)`），**不要去改产品把按钮加回侧栏**。
- 受影响 spec 共 5 条用例：#3 `extension-command-compatibility.spec.ts:129`、#4 `extension-dock-reload.spec.ts:73`、#5 `extension-dock-reload.spec.ts:123`、#26 `sidebar-toggle.spec.ts:175`、#22(b) `secondary-surface-inset.spec.ts:41-42` 的 `for (const view of ["Settings","Skills","Extensions"])` 循环。

### 7.5 顺带登记一个易踩的坑（两处「假按钮」）

- `features/canvas/canvas-page.tsx` 的 `label={t("Skills")}`（HEAD `:1432`、工作区 `:1516-1517`）是 `<DetailField>` 的**显示标签**，不是按钮；
- `features/extensions/customize-page.tsx:146` 的 `ResourceTab label={t("Skills")}`（渲染在 `:238-243`）在 `CustomizePage` 内部、**自己就在 skills 面上**，不能用来「切到 skills 面」，而且它是 `role="tab"`，`getByRole("button", …)` 也不会命中；
- 设置导航里那一项的标题是 **"Skills and extensions"**（`settings-sections.tsx:96/103`），`exact: true` 的 `"Skills"` 匹配不上。
- ⇒ 这三处在本次排查中先后被误当成「侧栏那个按钮」，登记在此避免下次再踩。

## 8 C 类：未定因（19 条）

### 8.1 已定位根因、且与产品/平台无关（2 条：#19、#20）

| # | 根因 | 关键证据 |
|---|---|---|
| 19 | 用例把 **v2 形状**的附件索引当成 legacy 内联形状写回 `ui-state.json`，被产品侧 `decodeAttachments()` 拒收 → 第二次启动整份工作区被丢弃 → 侧栏 `workspace-list` 不存在 | 断言 `persistence.spec.ts:674:56 getByTestId('workspace-list')` + `element(s) not found`；`test-failed-2.png` 红条逐字：`Some saved workspaces could not be refreshed.` / `Invalid saved attachment at index 0: unsupported field; original data was retained.`，侧栏 Threads 段变 `No folders yet`；产品侧 `electron/persistence/attachment-store.ts:386-397 toStoredAttachments()` 产出的键是 `blob: \`${attachment.id}.bin\``，而 `:399-420 decodeAttachments()` 对非 file 类只允许 `["id","kind","name","mimeType","data"]`，`:417-420` 抛错；用例侧 `persistence.spec.ts:642` 直接 `JSON.parse(attachmentRaw).attachments` 回灌。`git diff --stat HEAD -- apps/desktop/electron/persistence/attachment-store.ts` **无输出** ⇒ 与 HEAD 相同 |
| 20 | 排队消息的合成附件 id 天然带冒号且长 60，被产品的 blob id 正则会拒 → 点 `Edit` 时 IPC 抛错 → 编辑态从未渲染 | 失败截图红条逐字：`Error invoking remote method 'pi-gui:edit-queued-composer-message': Error: Invalid attachment id for blob storage: queued-message-1:image:0:1e7ef36d-b000-4f3b-95d9-3068deaa7bf`；产品侧 `attachment-store.ts:239-245 blobPath()` 正则 `/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/`，`:241-243` 抛错；id 由 `electron/application/app-store-utils.ts:411` 拼成 `\`${messageId}:image:${index}:${randomUUID()}\``；脚本实测 `length = 60`、`regexPass = false`、`badChars = [[":",16],[":",22],[":",24]]`。两个文件**都不在本批改动列表**里、与 HEAD 相同 ⇒ HEAD 既有缺陷，**与平台无关** |

（#21 原列在本节，现按机制归入 §6.3，避免重复计数。）

### 8.2 疑似平台但未坐实（3 条：#23、#28、#36）

- **#23** `session-lease.spec.ts:63`：`expect(await leaseHolderPid(leasePath)).toBe(firstPid)`，`firstPid = first.electronApp.process().pid`（`:62`），期望 `33076`、实收 `30152`。疑似 Windows 进程模型（`electron.launch()` 拿到的 pid ≠ 真正持租约的进程），**未做 PID 链实测**。
- **#28** `thread-menu.spec.ts:180-182`：点「Copy session ID」后 `expect.poll(() => navigator.clipboard.readText()).toBe(sessionId)`，期望 `"01a149fc-3ccb-748a-b311-5a4945214f37"`、实收 `""`。菜单项本身（Rename/Pin/Archive/Mark as read/Add scheduled task…/Copy session ID/Delete thread）在该点之前已全部通过 ⇒ 不是菜单结构问题，**疑似 background 测试模式下的剪贴板读回不通**（与 #16 同族、方向相反），**未坐实**。
- **#36** `workspace-file-lines.spec.ts:172:66`：`getByRole("button", { name: 'C:\Users\ASUS\AppData\Local\Temp\pi-gui-workspace-LsIYP6\file-line-workspace/src/app.ts:3', exact: true })` 点击 30 s 超时，报错未给「解析到几个元素」。**疑似 accessible name 里 Windows 路径分隔符/显示形态与预期不一致**，但**没有证据**，故只记「疑似」。

### 8.3 扩展视图家族（8 条，#6/#7/#8/#9/#10/#11/#12/#14）—— 只到「形态」级

- **#8**：`clickSession("Review the redesign PR")` 30 s 超时（`helpers/electron-app.ts:1909`）。截图里应用已起来、侧栏有工作区行 `pi-gui`（带 `+`/`…`）、**一条会话行都没有**、主区写着 `Create a thread for this folder…`。用例夹具 `extension-usage-view.spec.ts:68-91` 用 `seedUsageSessions({cwd, agentDir, now})` 种了**真实 pi 会话文件** ⇒ 「种下去的会话没被列出来」。**不是** lead 早先猜的 Extensions 按钮问题。
- **#10/#11/#12**：三条的期望值与实收值**恰好差一次激活**（`""` vs `"1"`、`Count 0` vs `Count 1`、`Count 1` vs `Count 2`），形态高度一致，像「丢了一次点击/激活」。**未定位**。
- **#6/#7**：扩展 iframe（`[data-testid="extension-view-frame"]`）里的元素**不存在**（`Passing fixture · Command completed · exit 0` 标题、`#trace-args`）。
- **#9**：`openedLinks` `toEqual` 不符。**#14**：`.chat-header__title` 期望 `Marked by extension`、实收 `Session A`（扩展设的标题没生效）。
- 这 8 条我没有做根因级定位，**不编根因**。

### 8.4 其余未定因（2 条：#1、#13，做了部分定位）

- **#1** `composer-image-limits.spec.ts:336`：`ENOENT` 打开 `…\attachments\C%3A%5CUsers%5C…%3A01a149ba….json`。
  **我推翻「平台编码」的定性**：该目录实测只有 `blobs` 与 `sha256-5a4cc1a9…json`；产品侧 `attachment-store.ts` v2 写的是 `sha256-${sha256(sessionKey)}.json`（`:227-229`），`${encodeURIComponent(sessionKey)}.json`（`:319-320 legacyPath`）只在读兼容路径用，已不再写；用例 `:288` 读的却是 legacy 名。⇒ 成因与 Windows 编码无关，**真实成因未定**（`composer-image-limits.spec.ts` 不在本批改动列表里）。
- **#13** `extensions-dialogs.spec.ts:231`：只有 `Test timeout of 60000ms exceeded.`，无更多信息，**未定位**。

### 8.5 完全未定位、且未做任何实验（4 条：#31、#32、#33、#37）

- **#31** `timeline-pinning.spec.ts:561`：`mouse.wheel(0,-520)` 后 `expect.poll(() => …remainingFromBottom…).toBeGreaterThan(700)`，实收 `520.3330078125`（恰好等于一次滚轮位移量）。**形态可疑但不构成结论**：我没有读 trace 定位「是滚轮只生效一次，还是会话恢复时的滚动基准不同」。
- **#32** `timeline-pinning.spec.ts:834`：`Timeout 5000ms exceeded while waiting on the predicate`（谓词体 `:836`，等 sentinel 行的几何位置）。与 #31 同文件同族，**未定位**。
- **#33** `transcript-annotations.spec.ts:76`：仅 `Test timeout of 90000ms exceeded.`，**未定位**。
- **#37** `worktrees.spec.ts:137:36`：`expect(legacyWorkspace.kind).toBe("worktree")`，期望 `"worktree"`、实收 `"primary"`（上文 `:135 addWorkspace(profileAHarness, legacyWorktree)`、`:136 waitForWorkspaceByPath(window, canonicalLegacyWorktree)`）。**lead 要求重点看，我同意它最像真缺陷**：这是 37 条里唯一一条「断言直接落在产品行为上、且本批改动过的 `electron/application/app-store.ts`（D3 路径身份）恰好管着 workspace `kind` 判定」的红；`electron/platform/worktrees/app-worktree-roots.ts` 本批未改。**本轮没做复现与根因级定位，只记事实，不编结论。**

## 9 D 类：探针（1 条，不是回归）

- **#15** `f-probe-owner.spec.ts:97`（未跟踪的新文件，F 批留下的探针）：`Test timeout of 180000ms exceeded.`，日志里有
  `PROBE2-CONTROL-RESULT {"value":{"state":"error","message":"须用户在界面显式确认；无交互界面不能自动恢复或代替人工门"}}`、
  `PROBE2-CONTROL-CHANGED false`。
  ⇒ 该用例的断言本身就是「记录结果」而不是「判定通过」；它的超时是**探针行为**，**不能算产品回归**。

## 10 未做项（明说）

1. **Windows 上没有现成的 HEAD 基线**。本轮已为 §7 补做**小范围**同平台 A/B（HEAD worktree + 3 个 spec，见 §7.2）并据此定案；但**这不是全量 A/B**：其余 32 条红没有同平台 HEAD 对照，它们的「是否本批引入」仍未经实测（#19/#20 另有「文件与 HEAD 逐字节相同」的 git 证据，见 §8.1）。G 批 D1–D5 的逐条 A/B 也仍未做（见第 3 项）。
   背景：core 车道在 Windows 上从来不是受支持车道——`desktop\docs\ci-baseline.md:49-56` 写明 Electron Core 套件只在四个 runner 上 `--shard=N/4`（PR 在 Ubuntu+Xvfb / 推 main 在 macOS），`desktop\.github\workflows\ci.yml` 的 Windows job 只跑 `verify:launcher-contract` / `test:changed-files` / `package:win:dir` / `verify:packaged-runtime-deps:windows`，**从不跑 core**。
2. **未跑**：`test:e2e:live`（需真实供应商钥匙）、`test:e2e:native` 车道、`tests/production` 打包件验收、perf 车道、`test:desktop-unit` 单元车道（85 条）。
3. **未做** G 批 D1–D5 改动的逐条 A/B（要做到需 checkout HEAD + 二次构建 + 二次跑，约 25 分钟）。
4. **未对 #31/#32/#33/#36/#37 做实验或 trace 级定位**（只读日志原文与截图）。
5. **未改任何产品源码与测试源码**（本轮全程只读 + 落报告）。

## 11 残留进程与现场清理

- 全量跑于 `END=2026-10-17 21:32:33` 结束（`EXIT=1`）。
- **跑完后抽查（21:34）：`Get-Process electron` = 0 个、`Get-Process playwright` = 0 个**，本轮 E2E 的 Electron 进程已全部退出、**无残留**。
- `node` 进程当时有 8 个（pid 4876、22908、24816、28452、29996、31016、32572、34148），**不是本轮 E2E 启动的**（E2E 结束后才出现/残留的），我没有动它们。
- 跑动中（21:16 采样）曾有 4 个 electron（pid 4348、6628、25428、26092），随用例正常退出。
- **本轮 E2E 期间没有主动杀任何进程**；未清 `test-results`（按 lead 要求保留 55 个目录用于复核）；清理只涉及我自己误建的一个 TEMP 脚本（`_tmp-none.mjs`，已删）。
- 21:50 的 HEAD A/B（§7.2）另起过一次 Electron：跑完抽查 **`electron` = 0、`playwright` = 0**；`.t-head` worktree 已按 §7.2 收尾完全移除（`git worktree list` 只剩主工作树），`desktop\node_modules` 条目数 588 → 588 未损。该次运行在 `.t-head\apps\desktop\test-results\` 下产生的失败截图/trace **随 worktree 一并删除**（它们是 HEAD 基线产物、不是本轮改动的证据；日志 `head-ab-run.log` 已保留全文）。

## 12 产物与字节校验

本报告自身的字节校验（写入后实测，命令与输出原文）：

```powershell
$p='D:\AI\workspace\pao-dev\.pao\harness完善-20261017\H批-集成交付\E2E-core车道-Windows实测.md'
$b=[System.IO.File]::ReadAllBytes($p); $s=[System.Text.Encoding]::UTF8.GetString($b)
$fffd=([regex]::Matches($s,"\uFFFD")).Count; $ctrl=([regex]::Matches($s,"[\x00-\x08\x0B\x0C\x0E-\x1F]")).Count
# → bytes=44882 lines=427 fffd=0 ctrl=0 cjk=5032 bom=False
```

口径：上表数字是 **2026-10-17 22:01 按 lead 要求完成 §7 重写（B 类归零、新增 E 类既存失败、补 §7.2 HEAD 同平台 A/B）之后的实测值**。本节这次只替换了等宽数字，因此 `bytes`/`lines`/`cjk` 不受影响，可直接引用。此后若再有人编辑本文件，请以重新实测为准。

原始日志与关键脚本（同目录 `H批-集成交付\`）：

| 文件 | 字节数 | 备注 |
|---|---|---|
| `e2e-core-full-20261017-195054.log` | 295,430 | UTF-16LE+BOM（PowerShell 重定向所致），收尾三行 `37 failed` / `10 skipped` / `310 passed (1.7h)` |
| `e2e-build.log` | 3,522 | `EXIT=0`，22 秒 |
| `e2e-smoke.log` | 16,642 | 未清变量时的 3 failed 原文 |
| `head-ab-build.log` | 3,522 | HEAD worktree 构建，`EXIT=0`／17.9 秒 |
| `head-ab-run.log` | 24,706 | HEAD worktree A/B：`5 failed` / `1 passed (3.3m)`，UTF-16LE+BOM |
| `解析-e2e日志.mjs` | 3,190 | 已处理 BOM/ANSI 两层坑 |
| `核对-e2e两条判据.mjs` | 2,399 | 46 行 / FFFD=0 / CTRL=0（#20 的 id、#21/#25 的 CSS 转义） |
| `Electron可执行文件异常-诊断.md` | 9,975 | 165 行 / FFFD=0 / CTRL=0 |
| `electron-pe.json` | 10,346 | PE 取证机器可读结果 |
| `诊断-electron-pe.mjs` | 5,287 | 生成上面的 JSON |

失败现场（`apps/desktop/test-results/`）：**55 个目录**，其中 **37 个带 `trace.zip`**（与 37 条失败一一对应）、**35 个带 `test-failed-*.png`**（两条因 `Test timeout` 未落截图）。按 lead 要求**全部保留**。
