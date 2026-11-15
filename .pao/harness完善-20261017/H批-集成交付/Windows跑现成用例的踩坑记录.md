# 在 Windows 上跑现成用例：本轮踩到的坑（2026-10-17，H 批）

这份记录只记「**当场实测过的平台差异**」，不写猜测。每条都给出实测命令与原文报错，方便下一个人复现。

## 一、`test:guards` 的路径断言（已修，见 `guards-39条红-归因与修复.md`）

一句话：守卫脚本把 `path.relative()` 的结果直接拼进失败消息，Windows 上带 `\`，而断言写死 `/`。
**这条与产品代码无关**，产品一行没坏。

## 二、`session-lease` 的「固定 1 秒起跑」竞争（已修）

`desktop/packages/pi-sdk-driver/test/session-lease.test.mts:254` 的 `raceForLease()` 原来这样起跑：

```js
const startAt = Date.now() + 1_000;
// 子进程里：if (Date.now() > startAt) { 输出 "late" }  // 判定自己迟到 → 用例红
while (Date.now() < startAt) {}
```

6 个 Node 子进程在 1 秒内拉不齐（机器一忙就会）就必然红。实测：单跑该文件 3 次全绿；跑全包时红过 1 次。
**改法**：换成「报到式起跑」——子进程加载完先输出 `ready`，父进程集齐 6 个 `ready` 后向各子进程 stdin 各写一行 `go`，子进程收到才去抢租约。竞争照旧是真竞争（6 个进程同时 `acquireLeaseFile`），只是起跑线不再靠猜时间。
改后：单跑 3 次全绿；全包连跑 4 次，无失败。

## 三、`pr-review` 集成用例的 `gh` 替身（**已按 3.3 的建议修好，本节保留为过程记录**）

> **2026-10-17 20:05 状态更新**：3.3 提出的修法（产品侧读环境变量拿 gh 可执行路径）**已实施并验证**：
> `examples/desktop-extensions/pr-review/repository.ts` 新增 `PR_REVIEW_GH_EXECUTABLE`（值为 JSON 字符串数组 = 程序 + 前置参数），
> 不设时仍返回 `{program:"gh", prefix:[]}`，**默认行为不变**；`integration.test.mjs` 删掉整个 Windows 专用分支，
> 改用 `.mjs` 替身 + `.cjs` 启动器。实测 `pr-review` 用例 **5/5 pass EXIT=0**。
> 详细过程见 `pr-review假gh-Windows修法.md`。下面 3.1/3.2 的四次失败记录**仍然有效**，是"为什么不能靠往 PATH 放替身"的证据。

### 3.1 三层报错，逐层都是平台差异

| 阶段 | 现象 | 实测原文 |
|---|---|---|
| 原样跑 | 红 | `Error: gh could not read this PR: Command failed: gh pr view --json …` + `no git remotes found` |
| 只放无扩展名 `gh` 脚本 | 仍红，**跑到真 gh 上了** | 同上（本机装了 `C:\Program Files\GitHub CLI\gh.exe`，CreateProcess 按 PATHEXT 跳过无扩展名脚本） |
| 只放 `gh.cmd` | 红 | node `execFile` 不经过 shell 时，libuv 对 `.cmd/.bat` 返回 `spawn EINVAL` |
| 自制 `gh.exe`（拷 PE 模板 + 追加 `\r\n<script>\0` + 重算校验和） | 红 | 跑起来的**既不是我们的脚本、也不是真 gh**，输出是一屏进程列表（`tasklist` 风格：`0 0 [System Process]`…），随后 `SyntaxError: Unexpected non-whitespace character after JSON` |
| 自制 `gh.exe`（拷 **node.exe** + 追加 `\r\n<脚本>\0`） | 红，但**错误变了** | `Error: Cannot find module 'C:\...\checkout\pr'` —— 见 3.2 第 3 条 |

### 3.2 关于「自制 gh.exe」的三条硬事实

1. **`node_modules/pnpm/dist/vendor/fastlist-0.3.0-x64.exe` 是 pnpm 自带的二进制，不是 cmd-shim。**
   实测：PE section 末尾之后**没有任何追加段**（`extra 0 tail ""`），所以「拷贝它 + 追加脚本路径」不能把它变成「运行某个脚本」的启动器——它照旧运行自己的内容。
   我先前据此写下的「cmd-shim 的 exe 逐字节相同、只差末尾追加段」**对本机这个文件不成立**，撤回。
2. 本机 `node_modules/.bin` 下**没有任何 `.exe`**（pnpm 装出来的 bin 只有无扩展名脚本 + `.CMD` + `.ps1`），仓库里唯一的 cmd-shim 模板来源因此不存在。
   自制的 `gh.exe` 在 PATH 命中时能被 CreateProcess 执行（`where gh` 会先列它），但**它不会去执行我们的 `.cmd`**。
3. **拷 `node.exe` + 追加脚本路径这条也走不通，且瓶颈不在「找模板」**：`gh.exe` 确实被调起来了（node 起来了），但拿到的是 `Cannot find module '…\checkout\pr'`——
   参数 `pr` 被当成了脚本路径，说明**追加的 `\r\n<script>` 那一段没有被当作 argv[0] 用上**，而真正传进来的 `pr view …` 被顶到了脚本位。
   也就是说：libuv 以「绝对路径直接执行 `.exe`」的方式启动（CreateProcess 的 `lpApplicationName` 明确给出）时，node 的「exe 尾部脚本」机制不参与。
   要继续只能改产品的调用方式，或者在本机装一个真正的启动器，**都不属于「跑测试」的范围**。

### 3.3 结论：这条用例在 Windows 上仍是红的，**修法要产品配合**

- 现状（2026-10-17 18:50）：`pnpm run test:extension-examples` = `tests 5 / pass 4 / fail 1`，红的仍是
  「the actual file-based extension keeps a rejected Pi preflight Requested, then restores Interrupted」。
- **关键判断**：要让它绿，只能让代码里那个 `gh` 能指向替身，这需要产品侧支持（例如从环境变量读 gh 的可执行路径，或允许注入仓库对象）。
  这是**示例代码的接口变化**，本轮没做，也不该由跑测试的人顺手改。
- 代码现状：四次尝试都已撤掉，`integration.test.mjs` 只保留**两处平台无关的确定修正**——
  `chmod` 只在 POSIX 调、PATH 用 `path.delimiter` 拼；Windows 分支保留 `gh.exe`（node 拷贝）的增量尝试但**带注释说明尚未跑通**。
  `git diff` = `1 file changed, 32 insertions(+), 9 deletions(-)`；`prettier --check` 通过；文件 **7314B / 184 行 / FFFD=0 / CJK=109 / 全 LF**。
  **要不要回退这 32 行、以及采用哪种修法，待你定**（见汇报「待决策」）。

### 3.4 顺带确认的三条（可以放心用）

1. **`chmod` 在 Windows 上会直接 `ENOENT`**（本机 PATH 里没有它，Windows 也没有这个命令）；原代码无条件 `await chmod(gh, 0o755)` 在 Windows 上是死路。今后写跨平台用例，`chmod` 一律只在 POSIX 调。
2. **PATH 拼接必须用 `path.delimiter`**：原代码写死 `:`，在 Windows 上会把 `bin` 与 `C:\...` 拼成一个无效路径。
3. **`.cmd` 不能用 node 的 `execFile` 直接跑**：不经过 shell 时 libuv 直接返回 `spawn EINVAL`；而 `spawn(file, args, { shell: true })` 会把参数过一遍 shell，测试里不要用。

## 四、**本机 `core.autocrlf=true` 让「字节比较型」检查全部假红**（2026-10-17 20:10 实测，**最容易误判的一条**）

### 4.1 症状

同一份没动过的代码，在 Windows 上跑检查会红，而且**红得像是仓库坏了**：

| 检查 | Windows 本地结果 | 真相 |
|---|---|---|
| `pnpm format:check`（= `prettier --check .`） | **740 files 不合规**，`EXIT=1` | 内容全合规，只是行尾 |
| `node examples/desktop-extensions/*/build.mjs --check` | **5 个全 `EXIT=1`**，报 `bundle is stale` | 产物与源码**逐字节一致**，只是行尾 |

### 4.2 根因（一条命令定案）

```
git config --system core.autocrlf   →  true      ← 唯一来源；local 与 global 都是空
git ls-files --eol                  →  i/lf  w/crlf
i/lf 计数 = 894     i/crlf 计数 = 0      ← 仓库里存的**全部是 LF**
w/crlf 计数 = 700   w/lf 计数 = 185      ← 工作区被签出成 CRLF
desktop/.gitattributes              →  不存在（没有 eol 约束）
desktop/.prettierrc.json            →  "endOfLine": "lf"
```

⇒ **仓库内容没问题，CI 在 Linux 上（LF 签出）这些检查是绿的。** 本机因为系统级 `core.autocrlf=true`，签出成 CRLF，而 prettier 要求 LF、`build.mjs --check` 用 `Buffer.equals` 做原始字节比较，于是必然不等。

### 4.3 两条实测证据

**证据一（prettier 只差行尾）**——用 prettier API 对同一文件比两次：

| 文件 | CRLF 行数 | 原样 `check` | 把 CRLF 归一成 LF 后 `check` |
|---|---|---|---|
| `examples/desktop-extensions/pr-review/repository.ts` | 171 | `false` | **`true`** |
| `apps/desktop/contracts/kanban.ts` | 113 | `false` | **`true`** |
| `scripts/test-entrypoints.test.mjs` | 228 | `false` | **`true`** |
| `README.md` | 212 | `false` | **`true`** |

**证据二（bundle 与源码逐字节一致）**——重建 5 个 bundle 后与 HEAD 对比：

| 示例 | HEAD blob | 签出到工作区 | 重建后 | `git diff --numstat` |
|---|---|---|---|---|
| pr-review | 6517 | 6522 | 6517 | **空** |
| test-runs | 9474 | 9721 | 9474 | **空** |
| github | 30651 | 31345 | 30651 | **空** |
| usage | 29050 | 29830 | 29050 | **空** |
| trace | 26421 | 27093 | 26421 | **空** |

差值恰好等于该 bundle 的换行符个数（github 差 694 = 694 个换行）。
同一批文件只改行尾，`build.mjs --check` 结果翻转：**LF 工作副本 → 5 个全 `EXIT=0`；`git checkout --` 还原成 CRLF → 5 个全 `EXIT=1`。**

### 4.4 处置与口径（今后一律照此）

1. **不要为了让它绿去刷 `dist/` 或改行尾**——那会把"环境问题"伪装成"代码改动"，产出 5 个内容其实没变的脏文件，污染可审查性。
2. **`pnpm check` 在本机 Windows 上第 1 步 `format:check` 必然红**，与任何人的改动无关。判断某文件是否真的格式不合规，必须先把行尾归一成 LF 再判（见 4.3 证据一的做法）。
3. **`test:extension-examples` 整条在本机不可能 `EXIT=0`**，因为脚本里嵌了 5 个 `build:check`。报验收时**分段报**：5 个 `test` 步看真实结果，5 个 `build:check` 步标「本机红、CI Linux 绿」并附 4.3 证据二。
4. 本机想真正复现 `pnpm check`，需要 `git config --local core.autocrlf false` 后重新签出（**只在工作区干净时做**，否则会把未提交改动一起冲掉）。**本轮没做这个操作**，因为工作区有 105 个未提交文件。
5. 仓库侧的持久修法是加 `.gitattributes`（如 `* text=auto eol=lf`），这属仓库级规范决定，**本轮未做**，已上报用户。

## 五、`ELECTRON_RUN_AS_NODE=1`：DSH 会话内所有 Electron 二进制退化成 Node

详见 `.pao/harness完善-20261017/执行记录.md` 的「H 批补记：Electron E2E 起不来的根因」一节。此处只留结论与操作要点：

- 症状：`electron.launch()` 全挂，原文 `electron.exe: bad option: --remote-debugging-port=0`，`exitCode=9`。
- 根因：`D:\AI\agent\dsh\resources\runtime\cli\bin\dsh.cmd:3` 与 `...\runtime\bin\node.cmd:2` 都有 `set ELECTRON_RUN_AS_NODE=1`，由 DSH 启动脚本注入整棵子进程树；`HKCU/HKLM` 注册表与四个 `$PROFILE` 全无 ⇒ **运行时注入，非持久设置**。
- **操作要点：在 DSH 会话里跑任何 Electron 命令前，先 `Remove-Item Env:\ELECTRON_RUN_AS_NODE`。** 清掉后 smoke 从 3 failed 变 3 passed。
- 传染面：本机任何 Electron 程序（`package:win:dir` 起的安装包、`test:e2e:native`、`tests/production`、桌面冒烟）都起不来。
- 另：`desktop/node_modules/electron/install.js` 的 `isInstalled()` **只比对 `dist/version` 与 `path.txt`，不校验二进制**，所以被污染时不会报错、只会神秘失败。
