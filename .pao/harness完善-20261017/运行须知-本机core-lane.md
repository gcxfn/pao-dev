# 本机 core lane 运行须知（Electron 测试环境陷阱）

记录日期：2026-10-17
适用：在 DSH agent 会话内跑 `desktop` 的 Playwright Electron 用例（core lane / production lane）。

## 结论

在 DSH 桌面 profile 的 agent shell 里，环境变量 `ELECTRON_RUN_AS_NODE=1` 是**被宿主进程注入的**，会让 `electron.exe` 退化成纯 Node 模式运行，导致所有 Electron 用例启动即失败。

跑测试前必须清掉它：

```powershell
Remove-Item env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
# 同一个 pwsh 进程里继续 build / test，否则清了个寂寞
```

## 证据链（2026-10-17 实测，本机）

1. `Get-ChildItem env:ELECTRON_RUN_AS_NODE` → `1`；`[Environment]::GetEnvironmentVariable('ELECTRON_RUN_AS_NODE','Machine'/'User')` → 均为空。
   → 不是机器配置、不是项目配置，是宿主进程环境继承。
2. 变量存在时跑 core 用例：`out/main/main.js` 被当普通 Node 脚本执行，`electron.protocol` 为 undefined：
   `TypeError: Cannot read properties of undefined (reading 'registerSchemesAsPrivileged')` → 进程 exit 1。
3. Playwright 报错里出现 `bad option: --remote-debugging-port=0` 是**次生现象**：
   该参数是 Playwright 内部追加的，不在 `apps/desktop/tests/helpers/electron-app.ts` 里
   （`launchDesktop` 只传 `args: electronCliArgs(desktopDir)`、`cwd`、`env`，可选 `recordVideo`；
   `grep remote-debugging` 在 helpers 与 `playwright.config.ts` 里零命中）。进程先死，Playwright 再把参数提示混进错误。
4. 关键对照实验（只差一个变量，结论决定性）：

   | 环境 | 命令 | 结果 |
   |---|---|---|
   | 变量在 | `electron.exe --remote-debugging-port=0 --version` | `bad option`，exit 9 |
   | 变量在 | `electron.exe --version` | `v22.21.1` |
   | 清掉变量 | `electron.exe --remote-debugging-port=0 --version` | **`v37.10.3`，exit 0** |
   | 清掉变量 | `electron.exe --version` | **`v37.10.3`** |

   机制：Node 模式下 `--remote-debugging-port=0` 被 Node 的选项解析器拒收，
   Playwright 的 `-r .../electron/loader.js` 还没来得及执行
   （其第 4 行 `process.argv.splice(1, process.argv.indexOf("--remote-debugging-port=0"))` 就是为剪掉该参数而存在）。
   即：**该参数本身合法，Electron 37 不拒收它**。

## 已排除的错误结论（勿重复踩）

- 「electron 装错版本」：`node_modules/electron/dist/version`、`node_modules/electron/package.json`、`electron.exe` 的 FileVersion/ProductVersion 全部为 `37.10.3`，与 `apps/desktop/package.json` 声明的 `"electron": "37.10.3"` 一致。
  `electron --version` 输出的 `v22.21.1` 是 Electron 内嵌的 **Node** 版本，不是 Electron 版本。
  想核对版本请用：`electron -e "console.log(process.versions.electron, process.versions.node)"`。
- 「helpers 传了 --remote-debugging-port」：不成立，见证据 3。
- 「Playwright 1.58.2 与 Electron 37.10.3 工具链不兼容、需降级 playwright-core 或改用 pipe」：不成立，见证据 4 的对照实验。不要降级依赖、不要改 helpers、不要动 node_modules。

## 陷阱 1 的误判形态（2026-10-17 d3 实测补充）

变量在时，**不是个别用例红，是整批一起红**，且每一条都停在启动阶段而不是断言阶段：

```
  16 failed
    apps\desktop\tests\core\composer-draft.spec.ts:192:7 › ...
    apps\desktop\tests\core\skills-settings.spec.ts:12:5 › ...
  9 did not run
    Error: electron.launch: Process failed to launch!
    - [pid=15412][err] electron.exe: bad option: --remote-debugging-port=0
       at helpers\electron-app.ts:166   ← launchDesktop 抛的，不是用例断言
```

看到「一批用例全在 `launchDesktop` 这一行失败」时，**先怀疑这个变量，不要先怀疑自己刚改的代码**。
当日该变量清掉后同一批 24 passed，代码一行未改。`Remove-Item` 后立刻在同一次 pwsh 调用里跑 `pnpm exec playwright test`。

## 陷阱 2：PowerShell 管道回写源码会写坏 UTF-8（同日 d3 实测）

`(Get-Content $f -Raw) -replace 'a','b' | Set-Content $f` 会把文件里的中文改写成替换字符 `U+FFFD`，
后果是 read 工具报 `invalid UTF-8 text`、随后 `vite build` 报解析错误。

- 处置：**源码一律用 `edit` / `write` 工具改**，不要用 PowerShell 管道回写。
- 自检：`(Get-Content $f -Raw -Encoding UTF8).Contains([char]0xFFFD)` 应为 `False`。
- 一旦写坏：**不要**再基于坏文件继续改，先确认坏在哪一行，用 `git diff` 核对后从原文重建该处。

### 实例（D4/E5 批次，2026-10-17，同一陷阱第二次出现）

`(Get-Content -Raw) -replace ... | Set-Content -Encoding utf8` 用来批量改测试文件里的中文，
`Get-Content` 默认按 GBK 解码 UTF-8 源文件，回写后 569 行中文全部变成 `娴嬭瘯` 式乱码。
发现途径是 `Select-String` 打出的行号内容显示为乱码，随后用字节级读取确认。

- **关键认知：损坏发生在「读」的那一侧，`-Encoding utf8` 救不了。**
  它只影响写，读的时候已经按错的编码解错过了。
- 处置：乱码不可逆，**不要尝试修补**（只会造出半对半错的文件）；按原结构整文件重写，保留新增内容。
  重写后校验：`bytes`、`FFFD=0`、`BOM=False`、`mojibake_lines=0`，再跑测试确认用例数没变。
- 纪律补充：**禁止用任何 shell 管道或重定向回写仓内源码与文档**；
  批量替换只能用 `edit` 工具的 `replace_all`。

### 同一根因的「只读」那面：读数会坏，文件是好的（G 批实测，2026-10-17）

上一条说的是「读错→写坏」。同一处解码错误，**不回写时就只坏结论、不坏文件**——G 批
（e1 G1）据此把一份交付记录写成了「`status/index.ts` 乱码、内容不可修补」，实际上是误判。

- 复现：本机 `[System.Text.Encoding]::Default` = `gb2312`、代码页 `936`；仓内源码是 **UTF-8 无 BOM**。
  PowerShell 5.1 的 `Get-Content` **不带 `-Encoding`** 时按 `.NET Default`（GBK）解码，
  无 BOM 时不会自动猜 UTF-8，于是三字节汉字被按双字节切开。
- 实测四条对照（同一文件 `PAO/packages/coding-agent/src/pao/status/index.ts`）：

  | 读法 | 首行输出 |
  |---|---|
  | `Get-Content $p -Raw`（无 `-Encoding`） | `搂21 /pao status 浠〃鐩樷€斺€斾换鍔★紜閮ㄩ棬…`（乱码） |
  | `Get-Content $p`（逐行，无 `-Encoding`） | 同上 |
  | `Get-Content $p -Encoding UTF8 -Raw` | `§21 /pao status 仪表盘——任务＋部门（先行区）＋用量（M2-04 尾接入）。`（正常） |
  | 字节级 `ReadAllBytes` + `UTF8.GetString` | `bytes=5235 FFFD=0 CJK=703 BOM=False`（文件完好） |

- **鉴别「文件坏了」还是「读法错了」**：
  1. 字节级读一遍：`ReadAllBytes` → `UTF8.GetString` → `FFFD == 0` 且 CJK 计数正常 ⇒ **文件是好的，错在读法**；
  2. `FFFD > 0` ⇒ 真损坏（写坏的，见上一条）；
  3. `FFFD == 0` 但内容读起来是「娴嬭瘯」式乱码 ⇒ 已被写坏的 GBK 回写文件，不可逆；
  4. 拿不准时看 `git status`：**与 HEAD 一致（输出为空）就说明本轮没人写过它**，别急着报缺陷。
- 纪律：**判断源码内容一律用 `read` 工具**（或 `Get-Content -Encoding utf8`）；
  不要用 `cat` / `type` / 无参 `Get-Content` 的输出去判断文件编码或内容对不对。
- 另有一条相邻的**独立**坑（不是编码问题，别混成一件事）：`[System.IO.File]::ReadAllBytes("相对路径")`
  不跟随 PowerShell 的 `cd`（.NET 静态方法用进程 cwd，`cd` 只改 Provider 位置），会抛
  `未能找到路径…`（也可能解析到别的目录）。字节级读取与校验一律传**绝对路径**。

## 陷阱 3 / 4：不 rebuild 就重跑，跑的是旧产物（两副面孔）

这两个是同一条根因的两面：Playwright 加载的是 `apps/desktop/out/` 里的**已构建产物**，不是 `src/`。

| 面孔 | 症状 | 误判成 |
|---|---|---|
| 3. build 失败但用例「通过」 | 旧 `out/` 还在，用例对着**旧 bundle** 跑，拿到绿灯 | 「我的修复已验证」 |
| 4. 改了 view/资源没 rebuild 就重跑 | 用例对着**旧 renderer bundle** 跑，看到的是改前的界面 | 「实现本身有缺陷」（D1 本轮把「composer 为空」误判成实现问题，实际是没 rebuild） |

- 处置：**`build` 必须在 `playwright` 之前，且必须确认它真的成功**。
  `pnpm --filter @pi-gui/desktop run build` 的正常尾巴是三个 ✓（`out/main/main.js` / `out/preload/preload.js` / `out/renderer/...`），
  看到 `error` / `Error` 就停下修构建，**不要继续跑用例**——此时无论红绿都不作数。
- 改 `src/electron/preload` 下任何文件后都要重跑 build；只改 `tests/` 下的 spec 不用。

## 陷阱 5：改了内核 `src` 却没重编内核 `dist`，桌面读到的还是旧内核（2026-10-17 E2b 实测）

比陷阱 3/4 更隐蔽：**桌面不读内核源码，读内核的 `dist` 构建产物**。

- 链路：`desktop/apps/desktop/node_modules/@earendil-works/pi-coding-agent` 是指向内核包的
  Junction（`D:\AI\workspace\pao-dev\PAO\packages\coding-agent`），其 `package.json` 的
  `exports["./pao"]` 指向 `./dist/pao/index.js`。所以 `pnpm --filter @pi-gui/desktop run build`
  打包时，打进 `out/` 的是**内核 dist 里那一刻的内容**，与内核 `src` 无关。
- 症状：只改 `PAO/packages/coding-agent/src/**`、跑桌面 `build` + Playwright，用例行为**完全不变**，
  看上去像「我的修复没生效」或「代码写错了」；而内核侧 `vitest` 跑 `src` 是绿的，两边结论打架。
- 实测时间戳（E2b）：`src/pao/dept/catalog.ts` = 13:04:02，`dist/pao/dept/catalog.js` = 11:57:34
  ⇒ 差了 1 小时，桌面读的是旧 `dist`；重编后 `dist` 变 13:06:27，用例随即 3 passed。
- 处置：**改了内核 `src` 且要由桌面验证时，先后核三步**
  1. `cd PAO/packages/coding-agent && pnpm run build`（内部是 `tsc -p tsconfig.build.json` + 打 bundle；
     正常尾巴是 `Built packages\coding-agent\dist\bundle (N files, ...)`）。
     注意：该脚本用 `npm run` 串联，stderr 会打一行 `node.exe : $ npm run build:unbundled ...`
     与 `NativeCommandError`——**那是 pnpm 的转述噪声，不是失败**，以 `BUILD_EXIT=0` 与产物时间为准。
  2. 核对 `dist/...` 的 `LastWriteTime` 晚于 `src/...`；必要时 grep 一个新标识符确认已落进 `dist`。
  3. 再 `pnpm --filter @pi-gui/desktop run build`，最后跑 Playwright。
- 只改内核、只在内核验证（`vitest`）时不需要编 `dist`；但只要证据要由桌面/Electron 出，就必须编。

## 陷阱 6：界面「还是英文」先查语言设置，别先怀疑漏用 `t()`（2026-10-17 G 批实测）

D 批、E 批的截图里左侧栏一直是英文（`Work board` / `Department detail` / `Progress 0Running 0…`），
连查两轮才定位清楚。**结论：产品默认语言是 `en`，不切语言看到英文是正常的。**

- 事实：`desktop/apps/desktop/contracts/desktop-state.ts:539` 是 `language: "en"`；
  `contracts/i18n.ts:21` 的 `translate(language, key)` 实现是 `dictionaries[language][key] ?? key`
  —— 词典里没有就回退成英文键本身，所以英文一定看得见，中文只有切到 `zh` 才出现。
- 视图侧早就调过 `t()`（`src/features/threads/sidebar.tsx` 逐处核对过），**问题从来不是漏用 `t()`**。
- 排查界面文案的三步顺序（按此顺序做，别倒过来）：
  1. 视图有没有 `t()`；
  2. 词典 `contracts/i18n-zh.ts` 有没有这个键（**缺键比漏用更常见**）；
  3. 当前语言是不是 `zh`。
- 要在截图/断言里看到中文，必须在设置里把语言切到中文再取证。切换入口是
  `src/features/settings/settings-general-section.tsx:80-87` 的 `<select aria-label="Language">`
  （**没有 data-testid**，用 `getByLabel("Language")`），选项值是 `en` / `zh`。
- 取证后要回主界面再截侧栏：设置面会盖住侧栏。回主界面的按钮文本是「返回应用」，
  但**在中文态下该按钮不在 DOM 里**（实测 `count = 0`），用 `Escape` 关闭设置面。
- 侧栏根元素是 `<aside className="sidebar">`，**没有 `data-testid="sidebar"`**
  （用过 `getByTestId("sidebar")` 会一直超时，容易被误判成「点击无效」）。用 `window.locator("aside.sidebar")`。

## 陷阱 7：两类「跑的不是你以为的那份代码」（2026-10-17 F 批实测，两次误判都由它引起）

### 7.1 桌面读的是内核 `dist`，不是内核 `src`
`desktop/apps/desktop/node_modules/@earendil-works/pi-coding-agent` 是指向
`PAO/packages/coding-agent` 的 **Junction**，桌面加载的是 `PAO/packages/coding-agent/dist/pao/**` 的编译产物。
改了 `src/pao` 却没重建 `dist`，桌面证据验的就是旧代码。

**判断「dist 过期没有」的正确做法：拿 dist 与 src 逐文件比，不要看目录或文件时间戳。**
反例（实测）：`dist/pao` 里 177 个 .js 全是同一个 `14:17:02`，而 `src/pao` 里有 20 个 .ts 晚于上一次构建的 `13:06:27`。
只看 `dist` 目录时间会以为「刚建过、是新的」，实际差着 20 处源码改动。

重建命令（workdir `PAO/packages/coding-agent`）：`pnpm run build:unbundled`（= `tsc -p tsconfig.build.json` + `copy-assets`），
成功后 `dist/pao/**` 全量刷新。注意 `pnpm run build` 还会跑 bundle 脚本，一般验证只需 `build:unbundled`。

### 7.2 测试文件在 `??` 未跟踪状态时，凭回执推断改动内容会出事
`desktop/apps/desktop/tests/core/` 下有一批 spec（如 `plan-recovery.spec.ts`）**没有被 git 跟踪**（`??`），
`src/features/workflow-cards/` 整个目录亦然。这类文件：没有 diff 可看、没有回退基准。

由此产生的真实误判（本批记录在案）：Lead 收到某队员「我已把断言改成 X，等重建后跑」的回执后，
在**没有重读文件**的情况下，用「第二轮 3 passed」推断出「内核投影行为在两次构建之间变了」，
并下令把断言撤回。真相是那次第二轮跑的就是改后的断言，前提整条是假的。

**纪律两条：**
1. 判断「测试为什么红/绿」之前，先回答「**这次跑的到底是哪一份代码**」——源码版本、构建产物版本、被测文件当时的实际内容，三者都要落实，**文件内容必须重读，不能凭回执推断**。
2. 改 `??` 状态的测试/源码文件前，先 `Copy-Item` 备份到 `.pao/harness完善-20261017/备份/`（命名带时间与改动意图），确认无误再删。

## 陷阱 8：拿 `window.piApp` 写脚本取证时，五个通道/夹具坑（2026-10-17 T24 实测）

这几条都是「**签名与认知不符**」型：代码跑得通，但传错了不报编译错，只在运行期回一句看不懂的错。

### 8.1 `getTemporaryPlans` / `getWorkflowControl` 的入参必须是对象
主进程侧校验的是 `input.workspaceId must be a string` —— **入参是对象，不是字符串**：

```js
await window.piApp.getTemporaryPlans({ workspaceId })   // ✅ workspaceId 是 string
await window.piApp.getTemporaryPlans(workspaceId)       // ❌ TypeError: input.workspaceId must be a string
```

`getWorkflowControl` / `getKanban` 同理。反过来，`selectWorkspace` / `selectSession` 收的才是对象里套字符串：
`selectWorkspace({ workspaceId })`、`selectSession({ workspaceId, sessionId })`。

### 8.2 `getWorkflowCatalog()` 无参；`piApp` 上没有任何 dept 通道
- `getWorkflowCatalog()` 契约是**零参数**（`desktop/apps/desktop/contracts/ipc.ts:1020`）。传参不报错，但**被忽略**——按参数取部门会永远拿到全量，容易误判成「过滤生效了」。
- 返回值里**确实有** `departments` / `recipes` / `skills` / `tiers`，可以直接用来核部门可见性。
- `piApp` 上**没有** `getDeptCatalog` / `getDesignCatalog` 之类通道（调 `api.getDesignCatalog()` 直接报 `is not a function`）。部门投影只走「部门详情」扩展面板的 `deptCatalog` / `deptDetail` 服务
  （`desktop/packages/pi-sdk-driver/extensions/pao/index.ts:137`、`:151`）。**写脚本前先查通道名，别按名字猜。**

### 8.3 假 provider 必须走 SSE 流，回一次性 JSON 会被判成断流
内核 `openai-completions` 走流式（SSE），收尾必须有 `finish_reason`。假 provider 若直接回一整块 JSON，
报错原文是 `Stream ended without finish_reason`。
判据在 asar 内 `node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js`：
`:479`/`:485-486` 是这条判定的实现，`:1267` 的 `supportsFinishReason: true` 说明本 provider 必须给 `finish_reason`。
**假 provider 要按 `data: {...}\n\n` 逐块吐，最后一块带 `finish_reason`。**

### 8.4 让假 provider 落文件时，工具名优先 `write`，不要先 `edit`
`edit` 要求传 `edits` 数组，假 provider 只给一个替换串就报
`Validation failed for tool "edit"`。坑在于：**模型侧会以为已经改成功**（回执照常继续），
而盘上两处都没落 —— 证据看着像「产品没写盘」，其实是夹具造错了。
判据：任务里明确「用 `write` 整文件写」，一次落盘一次校验。

### 8.5 `SITE` 必须是绝对路径
脚本里是 `resolve(process.env.SITE)`，给相对路径时工作区拼到 `C:` 上，
报错是 `spawn C:\Windows\system32\cmd.exe ENOENT` —— 从报错完全看不出真因是 SITE 没给对。
**同一条也适用于 `EXE`：都传绝对路径。**

### 8.6 `PAO_DISABLE_BUILTIN_EXTENSION` 是死开关，真正的隔离是 `PI_CODING_AGENT_DIR`

这两个变量常被当成同一类「隔离手段」用，实际差别很大，混淆过一次：

- **`PAO_DISABLE_BUILTIN_EXTENSION` 对打包发行物无效。** 它的判断只在 `@pi-gui/pi-sdk-driver` 按包名解析的那一份副本里
  （`npm-package-fallback.ts:87` 的 `const paoBuiltinDisabled = process.env.PAO_DISABLE_BUILTIN_EXTENSION === "1";`），
  而包里实际加载的是 `node_modules/@pi-gui/pi-sdk-driver/dist/*.js` —— **打包件里没有这个判断**。
  实测：设 `"0"` / `"1"` / 不设，三次结果**完全一样**。**别拿它当「装不装 pao」的开关。**
- **`PI_CODING_AGENT_DIR` 才是真生效的隔离手段。** 模型/供应商配置读 `<override>/settings.json`
  （`desktop/apps/desktop/electron/application/app-store.ts:5220-5228 resolveGlobalSettingsPath`）。
  不指它就会读到宿主机用户态 `~/.pi/agent`，把用户自己的扩展与模型清单带进测试现场。
  注意它与内核 `getAgentDir()` **不是同一个解析** —— app-store 的注释原文：
  the app store passes no custom agentDir, so the default resolution here matches the driver's。

**要确认 pao 扩展装没装，别看投影看实际发生的事**：看会话级命令清单
`state.sessionCommandsBySession["<工作区绝对路径>:<sessionId>"]` 里有没有 `pao`（`sourceInfo.path:"builtin:pao"`），
或看模型请求里带的工具数（pao 在场时那一批是 50 个工具）。
`state.runtimeByWorkspace[ws.id].extensions` 是**工作区级**清单、不含内置扩展，**照它判断会误判**（本批真误判过一次）。

## 纪律

- 不要为了跑通用例去改 `tests/helpers/electron-app.ts`，也不要动 `node_modules`。
  （例外：改动**主进程公共行为**后，公共测试辅助需要同步适配时，可在辅助里收口——但要在交付记录里写明原因与影响面，并扫一遍所有既有调用方。）
- 环境类问题先贴**原始报错原文**（命令、错误行、exit code），再做对照实验定位，不要凭单一命令的输出下结论。
