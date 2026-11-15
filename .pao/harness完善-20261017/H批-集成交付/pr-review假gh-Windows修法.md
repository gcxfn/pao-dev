# pr-review 假 gh 的 Windows 修法

## 零、一句话结论

把「假 gh」的冒充方式从「往 PATH 里放文件、让系统自己挑」改成「由环境变量告诉产品该执行哪个程序」，
产品默认行为一字未变，`pr-review` 示例 5 个用例从 4 过 1 挂变成 5 过 0 挂（EXIT=0）。

## 一、前四次为什么都不行

先看清 Windows 上「冒充一个叫 gh 的程序」这条路为什么整体走不通。产品代码里调用 gh 的方式是
Node 的 `execFile("gh", [...])`，它最终走 Windows 的 `CreateProcess`，而 `CreateProcess` 不走 shell，
两条最直觉的路都被堵死：

| 次数 | 做法 | 失败原文 | 失败原因 |
|---|---|---|---|
| 1 | 往 PATH 目录里放一个无扩展名的 `gh` 脚本 | `no git remotes found` | `CreateProcess` 按 `PATHEXT` 补扩展名去找，无扩展名文件被跳过，实际跑到了真机上的 `C:\Program Files\GitHub CLI\gh.exe` |
| 2 | 往 PATH 里放 `gh.cmd` | `spawn EINVAL` | libuv 不经 shell，不认 `.cmd` / `.bat`，直接拒绝 |
| 3 | 拷一个 PE 可执行文件当模板、把脚本内容追加到 exe 尾部 | `SyntaxError: Unexpected non-whitespace character after JSON` | 选的模板不是 cmd-shim、没有尾部追加段（实测 `extra 0 tail ""`），被当成真的 exe 执行了 |
| 4 | 拷 `node.exe`、把脚本路径追加到 exe 尾部 | `Cannot find module 'C:\...\checkout\pr'` | libuv 用绝对路径执行 `.exe` 时，node 的「exe 尾部脚本」机制不参与，node 把第一个真参数 `pr` 当成了要跑的脚本名 |

第 3 条当时有个判断错误要如实记下：我曾认定那个 PE 模板是 cmd-shim（pkg 打的 exe 会带一个尾部追加段），
实测 `extra 0 tail ""` 证伪，该判断已撤回。

第 4 条在本轮重新复现过：修前直接跑基线 `node test.mjs`，拿到的就是完全相同的那句
`Cannot find module '...\checkout\pr'`，不是偶发。

另外两条与环境有关的事实：`chmod` 在 Windows 上抛 `ENOENT`；拼 PATH 必须用 `path.delimiter`
（Windows 是 `;`），手写 `:` 会拼出坏路径。

**结论**：靠「往 PATH 里放文件」冒充 gh，在 Windows 上没有一条路能通。问题不在脚本写得对不对，
而在于产品把「执行哪个程序」写死成了字符串 `"gh"`，调用方没有插手的余地。

## 二、新入口

产品侧加一个环境变量 `PR_REVIEW_GH_EXECUTABLE`，值是 **JSON 字符串数组**，第一项是程序、其余是前置参数。

```
不设                          → 执行 gh（默认行为完全不变）
["node", "--", "fake-gh.cjs"] → 执行 node -- fake-gh.cjs ...
```

为什么是 JSON 数组而不是「空格分隔的字符串」：中途试过空格分隔的写法，遇到含空格的路径
`C:\Program Files\nodejs\node.exe` 会被切坏，报 `Error: C:\Program could not read this PR: spawn C:\Program ENOENT`。
JSON 数组由 `JSON.parse` 负责分词，路径带空格也不会有歧义。

为什么值里要带 `--`：Node 20 起 `node.exe <脚本> <参数...>` 的 argv 是 `[exe, 脚本, ...参数]`。
若写成 `["node", "fake-gh.cjs"]`，产品拼出的是 `node fake-gh.cjs pr view --json ...`，这没问题；
但测试端的替身要经一个 `.cjs` 启动器再去动态 `import` 真正的 `.mjs` 替身，此时 `--` 用来把「node 自己的选项」
和「脚本名」隔开，拼出来是 `node -- <fake-gh.cjs> pr view --json ...`，`pr` 就只是普通参数了。
没有 `--` 时实测把 `pr` 当成脚本名，报 `Cannot find module '...\checkout\pr'`。

配置写错的三种情况都会抛出明确中文错误，不会静默回退成执行真 gh（避免测试偷偷打真网络）：

- 开头不是 `[`  → `PR_REVIEW_GH_EXECUTABLE 须为 JSON 字符串数组，例如 ["node", "--", "fake-gh.cjs"]。`
- JSON 解析失败 → `PR_REVIEW_GH_EXECUTABLE 不是合法 JSON：<原始错误前 200 字>`
- 空数组或含非字符串项 → `PR_REVIEW_GH_EXECUTABLE 须为非空的字符串数组。`

`chmod` 只在 POSIX 分支执行；Windows 分支不再往 PATH 里放任何东西，也不再烤 `gh.exe`。

## 三、改了哪些文件

只动了 `desktop/examples/desktop-extensions/pr-review/` 下的两个文件，没有碰 `desktop/apps/`、
`desktop/packages/`、`apps/desktop/tests/`。

**`repository.ts`（产品侧，唯一改动的产品文件）**

- `GH_EXECUTABLE_ENV`：环境变量名常量。
- `GhCommand` 接口：`program` 程序 + `prefix` 前置参数。
- `ghCommand(env)`：读环境变量、校验、返回要执行的命令；不设时返回 `{ program: "gh", prefix: [] }`。
- `ReviewRepository.run` 多一个可选参数 `prefix`，执行时拼成 `execute(program, [...prefix, ...args], ...)`。
- `current()` 调用处改成用 `ghCommand()` 的结果。

`gh` 在整个示例里只有 `current()` 这一处调用点（代码图 `search_graph` / `trace_path` 已确认：
`current → run → execute`），所以改这一处就覆盖了全部调用路径。

`run` 的入边有 `current` 和 `read` 两处，但 `read` 只用于 `git`（`git diff` / `git show`），
不碰 `gh`，故 `run` 新增的 `prefix` 参数默认 `[]` 对 `read` 完全无影响——这也是把 `prefix`
做成 `run` 的可选尾部参数、而不是新建一个 gh 专用方法的理由：改动面最小，`read` 一行不用改。

**`integration.test.mjs`（测试侧）**

- 删掉整个 Windows 专用分支：不再写 `gh.cmd`、不再烤 `gh.exe`、不再改 `process.env.PATH`。
- 改写 `bin/fake-gh.mjs`（真正的替身，内容是一句 `process.stdout.write(...)` 输出 PR 的 JSON）+
  `bin/fake-gh.cjs`（启动器，用动态 `import()` 加载 `.mjs`；`require()` 不接受 `file://` URL，实测报
  `Cannot find module 'file:///...'`）。
- 设 `process.env.PR_REVIEW_GH_EXECUTABLE = JSON.stringify([process.execPath, "--", launcher])`，
  测试结束在 `finally` 里还原（原本没有这个变量就 `delete`，否则恢复旧值）。

## 四、逐字命令与结果

以下命令全部在 `D:\AI\workspace\pao-dev\desktop` 下真实执行。

**修前基线**

```
$ pnpm --dir examples/desktop-extensions/pr-review test
tests 5 / pass 4 / fail 1 / EXIT=1
  失败项：Cannot find module '...\checkout\pr'
```

**修后**

```
$ pnpm --dir examples/desktop-extensions/pr-review test
ℹ tests 5
ℹ pass 5
ℹ fail 0
ℹ duration_ms 1396.0248
TEST_MJS_EXIT=0
```

5 个用例逐条（`node test.mjs` 的 verbose 输出）：

```
✔ offline admission records a requested review and interrupts it without claiming completion
✔ only the active revision can record findings; arbitrary paths and malformed locations fail
✔ fix drafts retain source provenance and reject a changed PR, checkout, or incomplete review
✔ branch restoration ignores unrelated/malformed entries and never claims an orphaned run completed
✔ Git reads the captured commit, including its diff, after the working file changes
```

**类型检查与 lint**

```
$ pnpm --dir examples/desktop-extensions/pr-review typecheck
TYPECHECK_EXIT=0

$ pnpm exec eslint examples/desktop-extensions/pr-review --max-warnings 0
ESLINT_EXIT=0
```

## 五、回归确认

**`pnpm run test:guards`**

```
ℹ tests 114
ℹ pass 114
ℹ fail 0
GUARDS_EXIT=0
```

**`pnpm run check:architecture`**

```
Renderer boundary passed (190 first-party runtime source files).
Owned workspace contracts have no ambient redeclarations.
Host dependencies stay outside renderer and test implementation.
Timeline scroll ownership passed.
ARCH_EXIT=0
```

## 六、没达成的验收项与归因

`pnpm run test:extension-examples` **仍是 EXIT=1**，卡在 `github` 示例，不是 pr-review。以下三项如实报告。

### 6.1 `github` 示例在 Windows 上 4 条全挂（越界缺陷，已报告未修）

```
$ pnpm --dir examples/desktop-extensions/github test
tests 6 / pass 2 / fail 4 / EXIT=1
  four failures: spawn EFTYPE (errno -4028)
```

根因与 pr-review 同源但独立：`github/test/source.test.mts:11` 把
`fileURLToPath(new URL("./fake-gh.mjs", import.meta.url))` 直接当 `options.gh`，
经 `github/source.ts:71-106` 的 `run()` → `execFile(options.gh ?? "gh", args, {...})` 执行。
`.mjs` 不是 PE 文件，`CreateProcess` 报 `EFTYPE`。
还有 `source.test.mts:112` 期望用不存在的路径拿到 `ENOENT`，实际也拿 `EFTYPE`，
导致 `/isn't a GitHub repository/` 断言失配。

修它必须改 `examples/desktop-extensions/github/`，超出本次授权范围，所以只报告不修。
该示例的 `source.ts` 已有 `options.gh` 注入点，缺的只是和 pr-review 同形的「程序 + 前置参数」入口，
修法可直接照搬。

### 6.2 五个示例的浏览器 bundle 都陈旧（既存问题，与本次改动无关）

```
$ pnpm --dir examples/desktop-extensions/pr-review build:check
Error: PR Review browser bundle is stale. Run node examples/desktop-extensions/pr-review/build.mjs
BUILD_CHECK_EXIT=1
```

用 esbuild（参数与各示例 `build.mjs` 保持一致：`bundle` / `platform: browser` / `format: esm` /
`target: es2022` / `minify` / `legalComments: none` / `sourcemap: false`）逐一比对五个示例
`dist/desktop.js` 与源码重新打包的结果：

```
pr-review: STALE cur=6522  next=6517
test-runs: STALE cur=9721  next=5985
github:    STALE cur=31345 next=21774
usage:     STALE cur=29830 next=18862
trace:     STALE cur=27093 next=17382
```

五个全都陈旧 ⇒ 是仓库既存状态，不是本次改动造成。另一个直接证据：浏览器 bundle 的入口是
`pr-review/desktop.ts`，它只 import `contract`，不 import `repository.ts`，
我改的两个文件都不在浏览器 bundle 的依赖里。

要不要重跑 `build.mjs` 刷新 `dist/` 是另一件事（它会改 5 个示例的产物文件），本次未做。

### 6.3 prettier 判不合规的文件有 10 个，其中 9 个我没碰过（既存问题）

```
$ pnpm exec prettier --check examples/desktop-extensions/pr-review
[warn] .../contract.ts  desktop.ts  index.ts  package.json  README.md
[warn] .../repository.ts  review.ts  test.mjs  tsconfig.json
[warn] Code style issues found in 10 files.    PRETTIER_EXIT=1
```

`README.md` 是例外：它是没被改动但仍报格式的 9 个之一，说明格式问题本来就存在。

我改的 `repository.ts` 里有一处超长行（`throw new Error(...)` 一行超过 printWidth 100），已按
prettier 的意愿拆成多行；拆完后**内容层面 diffcount=0**（与 prettier 输出逐行完全一致）。

剩下的唯一差异是行尾：`desktop/.prettierrc.json` 写了 `"endOfLine": "lf"`，但该文件在 git 里
提交的就是 CRLF（`HEAD:repository.ts` 实测 CRLF=124、LF=0），所以 prettier 永远判它不合规。
统计整个 `examples/desktop-extensions/` 目录：**61 个文件里 60 个是 CRLF、只有 1 个是 LF**
（那个 LF 的正是本次新写的 `integration.test.mjs`）。

也就是说，换行问题是整个示例目录的既有状态。要把 `repository.ts` 单独改成 LF，它反而会成为目录里的
异类，并且会在 diff 里显示整个文件全改，掩盖真正的改动。**故未改，留待统一决定。**

## 七、未验证范围与已知局限

**未验证**

1. 未在真实 macOS / Linux 上跑过。POSIX 分支的逻辑（`chmod 0o755`）保留未动，但本次环境是 Windows，
   那条分支没有实际执行到。
2. 未验证真实 `gh` 认证下的完整 PR 读取流程（本次全用替身，且不允许调真实供应商/网络）。
3. 未验证桌面应用里真实创建会话、真实请求 PR 的端到端链路（本次只到「服务层记录 requested 并中断」为止）。
4. `test:extension-examples` 整体未绿，见 6.1。
5. `build:check` 未绿，见 6.2。
6. prettier 未绿，见 6.3。
7. 未做任何 git 提交（按要求）。

**已知局限**

1. `PR_REVIEW_GH_EXECUTABLE` 是**给测试和排障用的入口**，不是面向用户的功能。普通用户不该设置它；
   一旦设置错误会直接抛错而不是回退到真 gh，这是故意的——静默回退会让「假 gh 没生效」这种故障
   表现成「打到了真网络」，更难查。
2. 该入口只影响 `gh`，不影响 `git`（其余读取全走 `git`，走的是系统 PATH，未提供同类入口）。
3. 值必须是合法 JSON，手写时要注意 Windows 路径里的反斜杠要转义成 `\\`；用代码生成
   （如测试里的 `JSON.stringify`）不会有这个问题。
4. `prefix` 机制对「不经 shell 的 `execFile`」有效；若将来有人把调用方式改成走 shell，
   这套参数前置的语义会变，需要重新评估。
5. 环境变量是**进程级**的，测试必须自己还原（本次在 `finally` 里做），并行跑多个用例时会互相干扰。
