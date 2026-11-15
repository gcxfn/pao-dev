# H2 Electron / ConPTY · 交付记录

**日期**：2026-10-17
**执行**：d3-host（task-23）
**环境**：Windows，Node v24.18.0（`process.versions.modules=137`），`process.platform=win32`、`arch=x64`；`node-pty` **1.1.0**（`desktop/node_modules/node-pty`）
**纪律**：本轮**未启动 Electron、未跑任何 Playwright 用例、未调真实供应商、未读写 `D:\AI\workspace\pao`、未 git commit**。

---

## 0. 结论速览

| 半边 | 结论 |
|---|---|
| **动态半**（纯 Node 探针，不弹窗） | **3 组全部通过**：spawn+退出码 ✅、窗口尺寸三组原样生效 ✅（100×30 / 500×200 / 10×4） |
| **静态半**（读代码） | **已检查、未运行**：`resize()` 热调整、`ownerWebContentsId` 归属校验、三个终端 spec（被禁令挡下） |
| **缺陷候选 H2-D1** | ConPTY 下 `terminalExit.signal` **恒为 `undefined`** —— **已记录，未定级**（见 §3，含一条对初判的修正） |
| **验不到的** | 4 项，单列 §4，**未混入「已验」** |

---

## 1. 前提：为什么普通 Node 能加载 node-pty（不启动 Electron）

`desktop/apps/desktop/electron/platform/terminal-service.ts`：
- **`:1** `import type { WebContents } from "electron";` —— 纯类型导入，**运行时擦除**
- 全文件对 `electron` 只有这一行；真正加载原生插件的是 **`:536** `nodePty ??= require("node-pty") as NodePty;`

因此 `node-pty` 不依赖 Electron ABI，普通 Node 24 即可加载。**这是本卡能"不弹窗验底层"的全部依据**，不是绕过。

`node-pty` 预编译产物已确认存在（`desktop/node_modules/node-pty/prebuilds/win32-x64/`）：
`conpty.node`(312320B)、`pty.node`(303104B)、`conpty_console_list.node`(134656B)、`winpty.dll`(256000B)、`winpty-agent.exe`(307712B)、`conpty/conpty.dll`(109600B)、`conpty/OpenConsole.exe`(1148448B)。

---

## 2. 动态半：探针真实输出

**探针脚本**（已保留，可复跑）：
`D:\AI\workspace\pao-dev\.pao\harness完善-20261017\H批-集成交付\探针-conpty.mjs`
跑法：`node "D:\AI\workspace\pao-dev\.pao\harness完善-20261017\H批-集成交付\探针-conpty.mjs"`

### 2.1 探针 1：spawn + 退出码

```json
{
  "exitEventKeys": ["exitCode", "signal"],
  "exitCode": 0,
  "hasSignalKey": true,
  "outputContainsToken": true,
  "rawHead": "\u001b[?9001h\u001b[?1004h\u001b[?25l\u001b[2J\u001b[m\u001b[HCONPTY_PROBE_OK\r\n\u001b]0;C:\\Windows\\system32\\cmd.exe\u0007\u001b[?25h"
}
```

- spawn 成功、收到 `exitCode: 0`、输出里含 `CONPTY_PROBE_OK` ✅
- 退出事件对象**含 `signal` 这个键**（`hasSignalKey: true`）——但**键在 ≠ 值有**，见 §3

### 2.2 探针 2：窗口尺寸传递（三组）

| 组 | 请求 | `mode con` 回读 | 是否原样生效 |
|---|---|---|---|
| ① 常规 | `cols:100, rows:30` | `rows:30, cols:100` | **✅ match** |
| ② 上限 | `cols:500, rows:200` | `rows:200, cols:500` | **✅ match** |
| ③ 下限 | `cols:10, rows:4` | `rows:4, cols:10` | **✅ match** |

- ②③ 分别是 `terminal-service.ts:454-455` `normalizeSize` 的上下限：
  `cols: clampInteger(size?.cols, 80, 10, 500)` / `rows: clampInteger(size?.rows, 24, 4, 200)`
- **结论**：`spawn` 的 `cols`/`rows`（`terminal-service.ts:307-313` 六参之一）到 ConPTY 之间**没有丢失、没有被 Windows 二次夹断**，上下限内部原样生效。

### 2.3 一条关于「怎么测量」的实证（会被长期文档用到）

下限 10×4 那一组，`mode con` 的输出在 raw 流里是**被折行打散、中间插满光标定位序列**的：

```
…\u001b[3;10HCON:       \r\n--------- \u001b[4;1H\n    行:　 \r\n\u001b[3;10H       4   \r\n    列:　 \r\n\u001b[3;10H 　     10 …
```

直接用「连续文本」正则匹配（如 `行:\s*(\d+)`）会**匹配不到**。探针里因此改成「先剥掉 OSC/CSI 再容错匹配」（`探针-conpty.mjs` 的 `extractSize()`）。

**这不是一条建议，是实证**：将来若要给「终端窗口大小」写预期行为测试，**必须比对归一化后的屏幕，不能比对 raw 字节流**。

### 2.4 环境现象，不是产品行为（按纪律单列）

探针 stderr 出现 3 次：

```
D:\AI\workspace\pao-dev\desktop\node_modules\node-pty\lib\conpty_console_list_agent.js:13
var consoleProcessList = getConsoleProcessList(shellPid);
Error: AttachConsole failed
```

- 来源：node-pty 内部的 `conpty_console_list_agent`，在 **无 tty 宿主**（`node xxx.mjs`、`node -e`）下无法 AttachConsole。
- 次数对应本探针的 4 次 pty 创建中的 kill 路径调用。
- **不当成桌面端产品行为采样**：Electron 主进程环境下宿主有控制台，是否触发未知，本批也**没验**。
- 附带说明：这也意味着本条探针的 `kill` 路径在无 tty 环境不可靠，**不影响 §2.2 的尺寸结论**（尺寸在 kill 之前已回读到）。

---

## 3. 缺陷候选 H2-D1：ConPTY 下 `terminalExit.signal` 恒为 `undefined`

**定级：已记录，未定级。**

### 3.1 透传链（已核实）

`desktop/apps/desktop/electron/platform/terminal-service.ts`：
- **`:332** `session.exitSubscription = session.pty.onExit(({ exitCode, signal }) => {` —— **解构出 `signal`**
- **`:335** `session.signal = signal;` —— 存进会话状态
- **`:344-348** 原样通过 IPC 发渲染层：
  ```ts
  this.sendToOwner(webContents, session, desktopIpc.terminalExit, {
    terminalId: session.id,
    exitCode,
    signal,
  });
  ```
- **`:47-48** 类型声明：
  ```ts
  exitCode: number | undefined;
  signal: number | undefined;
  ```

### 3.2 实测：值确实是 `undefined`

§2.1 探针输出：`hasSignalKey: true`（键存在）**但** JSON 里没有 `signal` 字段的值——即 `signal: undefined`（`JSON.stringify` 会丢掉值为 `undefined` 的键）。`exitCode` 有值 `0`。

⇒ **ConPTY 分支回传的是 `{ exitCode: 0, signal: undefined }`**：`signal` 恒假。

### 3.3 **对初判的修正（重要，不许抹掉）**

Lead 此前（以及我最初）的判断是「ConPTY 下 `signal` 恒为 `undefined`」。
**实测显示：ConPTY 下它恒为 `undefined` 这一点成立；但「winpty 分支会给 signal」这一半是错的，必须撤回。**

依据是 `node-pty` 自身源码的类型声明，`desktop/node_modules/node-pty/typings/node-pty.d.ts`：

```ts
export interface IExitEvent {
    exitCode: number;
    signal: number;
}
```

**`IExitEvent.signal` 在 node-pty 1.1.0 里是必填 `number`，不分平台**——即 winpty 分支在类型层也宣告会给 `signal`。

所以准确表述应改成：

> **在 Windows 上，`terminalExit.signal` 恒为 `undefined`。** 原因不是「ConPTY 不给而 winpty 给」，而是 **node-pty 的 Windows 实现（与 ConPTY / winpty 无关）在满足 `IExitEvent` 类型声明上存在缺口**——类型说必有 `number`，运行期给 `undefined`。
> **「winpty 分支是否给 signal」未实测**（本机是 ConPTY 环境，winpty 要另跑），按类型声明推断「也不给」，但这仍是推断。

（本条口径修正已于 2026-10-17 采纳，缺口表统一按此表述；「winpty 给」的旧说法作废。）

### 3.4 为什么不定级

1. 要定「缺陷 vs 平台差异可接受」，先要知道**渲染层有没有人依赖 `signal`**——那要读 renderer 侧代码，属另一块活；
2. 「winpty 分支给不给」未实测（见 §3.3）；
3. 现在定级会把「观察到的事实」和「还没查的后果」混成一句结论。

**危害描述**（不升级为定级）：一个恒为 `undefined` 的字段，读它的代码无论写什么判断都不会成立——它的问题不是「少一个字段」，是**让人以为有这份信息**。

---

## 4. 验不到的（单列，未混入「已验」）

| 项 | 为什么验不到 | 状态 |
|---|---|---|
| `resize()` 运行时热调整 | `:144-149` `resize(webContents, terminalId, size)` 先过 `:145 requireOwnedSession(webContents, ...)`，**需要真的 `WebContents` 对象**才能进入；且要 `session.pty?.resize(...)`（`:148`）在**已存在的会话**上生效 | **静态已读、未运行** |
| `ownerWebContentsId` 归属校验 | `:369-375` `requireOwnedSession` 以 `session.ownerWebContentsId !== webContents.id` 判归属，`webContents.id` 是 Electron 对象属性 | **静态已读、未运行** |
| 集成终端 UI / replay / 截断 | `:352-356 appendReplay` 依赖 `contracts/terminal-model` 的 `appendTerminalReplay`，但其触发点在主进程 → 渲染层链路，UI 呈现只在 renderer | **未验** |
| 三个终端 spec | `apps/desktop/tests/core/integrated-terminal.spec.ts`、`tests/core/terminal-diff-layout.spec.ts`、`tests/production/packaged-terminal.spec.ts` 全部走 Playwright Electron | **本批未运行，原因是禁令** |

补充说明（静态观察，**不是验证结论**）：`:364 sendToOwner` 在发送前的归属判断是 `webContents.id === session.ownerWebContentsId && !webContents.isDestroyed()`——同样强依赖 Electron 对象，**运行行为本批未验**。

---

## 5. 静态半：已检查、未运行的要点

### 5.1 `resize()` 热调整

- **`:144-149`**
  ```ts
  resize(webContents: WebContents, terminalId: string, size: TerminalSize): void {
    const session = this.requireOwnedSession(webContents, terminalId);
    const normalizedSize = normalizeSize(size);
    session.size = normalizedSize;
    session.pty?.resize(normalizedSize.cols, normalizedSize.rows);
  }
  ```
- 与 spawn 时一致走 `normalizeSize`（`:452-457`），**同一套上下限**（10–500 / 4–200），因此 §2.2 验到的「上下限原样生效」对 resize 路径**是同一函数、同一区间**，但**resize 到 ConPTY 的运行时传递本批未运行**。

### 5.2 归属校验 `requireOwnedSession`

- **`:369-375`**：会话不存在**或**归属不符，统一抛 `Unknown terminal session: <id>` —— 不区分「没有」与「不是你的」，对外不泄漏他人会话的存在性。
- 调用点共 **8 处**：`:107`、`:120`、`:145`、`:156`、`:171`、`:194`（写/读/resize/restart/关闭等入口）。
- **强依赖 Electron `WebContents`，本批未运行。**

### 5.3 三个终端 spec

| spec | 归属 | 本批状态 |
|---|---|---|
| `tests/core/integrated-terminal.spec.ts` | Playwright Electron | **未运行** |
| `tests/core/terminal-diff-layout.spec.ts` | Playwright Electron | **未运行** |
| `tests/production/packaged-terminal.spec.ts` | Playwright Electron（打包件） | **未运行** |

理由：用户明确同意本批不跑真 Electron（弹窗干扰）。**不是「跑了通过」，是「按禁令没跑」。**

---

## 6. 与计划 §12.2 的对应

§12.2 要求「旧命令共用核心并保留原来支持行为」。本卡能提供的最强证据是 §2.2：**终端尺寸这条底层行为在 ConPTY 上原样生效（三组含上下限）**，且走的是 `terminal-service.ts` 自己的 `normalizeSize` 上下限。**「旧命令」（CLI 侧）共用核心这一条不在本卡范围**，本卡未验，不声称覆盖。

---

## 7. 复跑方式

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
node "D:\AI\workspace\pao-dev\.pao\harness完善-20261017\H批-集成交付\探针-conpty.mjs"
```

期望：三组 `"match": true`；stderr 可能出现 `AttachConsole failed`（环境现象，见 §2.4）。

---

## 8. 未验项汇总（与 H1 / CI 核查一致，不带入结论）

| 项 | 状态 |
|---|---|
| winpty 分支是否给 `signal` | **未实测**（§3.3） |
| 渲染层是否依赖 `exitCode` / `signal` | **未查** |
| Electron 主进程下 `AttachConsole failed` 是否触发 | **未验** |
| `resize()` 运行时热调整 | **未运行** |
| `ownerWebContentsId` 归属校验 | **未运行** |
| 三个终端 spec | **按禁令未运行** |
| CI 三条未查项（GitHub 上是否启用 / 最近运行状态 / ubuntu 上是否真绿） | 见 `CI护栏覆盖面核查-事实.md` §5，本记录不重复结论 |
