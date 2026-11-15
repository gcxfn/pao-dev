# github 示例假 gh 的 Windows 修法

## 零、一句话结论

`github` 示例的 4 条 Windows 失败已修好（**修前 `tests 6 / pass 2 / fail 4`，修后 `tests 7 / pass 7 / fail 0`**），
修法与 pr-review 同形：加一个环境变量入口把「程序 + 前置参数」交给产品，默认行为一字未变，
既有的 `options.gh` 注入点保留且优先。
整条 `test:extension-examples` 的 `test` 步五段全绿；`build:check` 步在本机因 CRLF 必红，
那是**环境问题、不是产物陈旧**，已在第一节用实验证明（本机红，CI Linux 绿）。

## 一、`build:check` 的假红是环境造成的（复现 lead 的实验）

这一节回答「那 5 条 red 到底是什么」，全部是本机实跑、可复现。**结论：dist 与源码逐字节一致，
红/绿只由工作区行尾决定。**

**第一步：重建前后对比**

```
HEAD blob（git show HEAD:.../dist/desktop.js）
  pr-review  bytes=6517  LF=5    CRLF=0
  test-runs  bytes=9474  LF=247  CRLF=0
  github     bytes=30651 LF=694  CRLF=0
  usage      bytes=29050 LF=780  CRLF=0
  trace      bytes=26421 LF=672  CRLF=0

工作区（签出后，被 core.autocrlf=true 转成 CRLF）
  pr-review  bytes=6522  LF=5    CRLF=5
  test-runs  bytes=9721  LF=247  CRLF=247
  github     bytes=31345 LF=694  CRLF=694
  usage      bytes=29830 LF=780  CRLF=780
  trace      bytes=27093 LF=672  CRLF=672
```

工作区字节数 − HEAD 字节数 = 该 bundle 的换行符个数（6517+5=6522、9474+247=9721、
30651+694=31345、29050+780=29830、26421+672=27093），**一个字节都不多不少**。

**第二步：重建五个 bundle 后看 `git diff --numstat`**

```
$ node examples/desktop-extensions/<name>/build.mjs     # 五个各跑一次
  pr-review  rebuilt bytes=6517  CRLF=0
  test-runs  rebuilt bytes=9474  CRLF=0
  github     rebuilt bytes=30651 CRLF=0
  usage      rebuilt bytes=29050 CRLF=0
  trace      rebuilt bytes=26421 CRLF=0

$ git diff --numstat -- examples/desktop-extensions
55      3       examples/desktop-extensions/github/source.ts
188     119     examples/desktop-extensions/github/test/source.test.mts
26      9       examples/desktop-extensions/pr-review/integration.test.mjs
55      8       examples/desktop-extensions/pr-review/repository.ts
```

**`numstat` 里没有一条 dist 记录，五行全部为空。** 重建产物与 HEAD 内容完全相同。

**第三步：只差行尾，`build:check` 结果翻转**

```
重建后（工作区是 LF）
  pr-review : EXIT=0 | PR Review browser bundle matches its source.
  test-runs : EXIT=0 | Test Runs browser bundle is current.
  github    : EXIT=0 | GitHub browser bundle is current.
  usage     : EXIT=0 | Usage browser bundle is current.
  trace     : EXIT=0 | Trace browser bundle is current.

$ git checkout -- <五个 dist>
还原后（工作区是 CRLF）
  pr-review : EXIT=1 | Error: PR Review browser bundle is stale. ...
  test-runs : EXIT=1 | Error: The Test Runs browser bundle is stale. ...
  github    : EXIT=1 | Error: The GitHub browser bundle is stale. ...
  usage     : EXIT=1 | Error: The Usage browser bundle is stale. ...
  trace     : EXIT=1 | Error: The Trace browser bundle is stale. ...
```

**第四步：还原后 `git status` 干净**

```
$ git status --porcelain -- examples/desktop-extensions/*/dist/
（无输出，干净）
```

原因在 `build.mjs` 的校验方式：它用 `expected.equals(Buffer.from(result.outputFiles[0].contents))`
做**原始字节比较**（`pr-review/build.mjs:21`），而 esbuild 的产物永远是 LF；
工作区被签出成 CRLF，字节必然不等。

**第五步：根因是本机 git 配置，不是仓库**

```
$ git config --show-origin --get core.autocrlf
file:C:/Program Files/Git/etc/gitconfig   true      ← 唯一的来源
$ git ls-files --eol -- examples/desktop-extensions/pr-review/contract.ts
i/lf    w/crlf  attr/
$ desktop/.gitattributes
（不存在）
```

⇒ **仓库里存的全是 LF，CI 在 Linux 上按 LF 签出，这五条在 Linux 上是绿的。
本机因 `core.autocrlf=true` 变成 CRLF 才红。**

**同一根因也解释了 `format:check`**：lead 实跑 `pnpm exec prettier --check .` 得 740 个文件不合规；
`desktop/.prettierignore` 只排除了 `/examples/desktop-extensions/*/dist/`，源码全在扫描范围内。
（本报告第 3 问的答案即此，由 lead 查清，此处引用。）

**处置**：按 lead 指示，**没有刷 `dist/`、没有改行尾、没有加 `.gitattributes`**。
实验中途重建的五个 dist 已 `git checkout --` 全部还原，`git status` 确认无 dist 改动。

## 二、改了什么

写范围 `examples/desktop-extensions/github/`，只动 2 个文件：

| 文件 | 改动 |
|---|---|
| `github/source.ts` | +58/−3；新增 `GH_EXECUTABLE_ENV`、`GhCommand`、`ghCommand(env)`；`run()` 里改唯一执行点 |
| `github/test/source.test.mts` | 换掉「把 `.mjs` 当 `options.gh`」的注入方式，改用环境变量入口；新增 1 条入口契约用例 |

### 2.1 新入口（产品侧）

```
export const GH_EXECUTABLE_ENV = "GITHUB_GH_EXECUTABLE";

export interface GhCommand {
  readonly program: string;
  readonly prefix: readonly string[];
}

export function ghCommand(env: NodeJS.ProcessEnv = process.env): GhCommand
```

值是 JSON 字符串数组：第一项程序，其余前置参数。

| 环境变量值 | `ghCommand()` 返回 |
|---|---|
| 不设 / 空白 | `{ program: "gh", prefix: [] }`（**默认行为完全不变**） |
| `["node","--","fake-gh.cjs"]` | `{ program: "node", prefix: ["--","fake-gh.cjs"] }` |
| 不以 `[` 开头 | 抛 `GITHUB_GH_EXECUTABLE 须为 JSON 字符串数组，例如 ["node", "--", "fake-gh.cjs"]。` |
| `[not json` | 抛 `GITHUB_GH_EXECUTABLE 不是合法 JSON：<前 200 字>` |
| `[]` 或含非字符串项 | 抛 `GITHUB_GH_EXECUTABLE 须为非空的字符串数组。` |

写错直接抛错而不静默退回真 gh：静默退回会让「假 gh 没生效」表现成「打到了真网络」，更难排查。

### 2.2 两个入口的优先级（lead 要求写清）

`run()` 里：

```
const configured = options.gh;
const command = configured ? { program: configured, prefix: [] } : ghCommand(options.env);
execFile(command.program, [...command.prefix, ...args], {...});
```

**显式 `options.gh` 优先于环境变量**，两者同时存在时只用 `options.gh`。理由：
`options.gh` 表达的是「这一次用哪个 gh」，是调用方逐次指定的更具体意图；
`GH_EXECUTABLE_ENV` 表达的是「整个进程怎么启动 gh」（程序 + 前置参数），是兜底默认。
更具体的优先。

`options.gh` 的语义与签名**一字未改**（`gh?: string`，仍是「可执行文件名或路径」），
只是文档注释补了一句「优先于 `GH_EXECUTABLE_ENV`」。用例
`the model's github_read gets one issue or PR as bounded, quoted text` 里现存的
`readItem({ ...options, gh: join(tmpdir(), "no-such-gh") }, ...)` 断言仍然通过——
它现在**同时**验证了这条优先级：环境变量指着能跑的假 gh，但显式 `options.gh` 指着坏路径，
结果必须是「gh 未安装」。

### 2.3 测试侧

删掉了「把 `fake-gh.mjs` 的路径直接当 `options.gh` 传」这条在 Windows 上必然 `spawn EFTYPE` 的路
（`.mjs` 不是 PE，`CreateProcess` 拒绝）。改为：

- `fakeGhCommand(fake, env)` 在临时目录写一个 `.cjs` 启动器（用动态 `import()` 加载 ESM 替身，
  因为 `require()` 不接受 `file://` URL），设
  `env[GH_EXECUTABLE_ENV] = JSON.stringify([process.execPath, "--", launcher])`。
- 每个用例 `try { ... } finally { delete process.env[GH_EXECUTABLE_ENV] }` 还原。
- 没用 PATH 冒充，没造 `.exe`。
- 新增用例 `ghCommand: unset stays on the system gh, explicit options.gh wins`，
  覆盖上表全部六行。

## 三、验收（逐条真实输出）

### 3.1 github 示例：修前 → 修后

```
修前
$ pnpm --dir examples/desktop-extensions/github test
ℹ tests 6 / ℹ pass 2 / ℹ fail 4       GITHUB_TEST_EXIT=1
  四条全是 spawn EFTYPE (errno -4028)，栈顶 source.ts:78 的 execFile

修后
$ pnpm --dir examples/desktop-extensions/github test
ℹ tests 7 / ℹ pass 7 / ℹ fail 0       TEST_EXIT=0

  ✔ data comes from gh with fixed arguments and is normalized
  ✔ a missing gh says how to set it up
  ✔ gh's own failures are explained
  ✔ check rollups distinguish pending, passing and none
  ✔ drafts reference the issue or PR and never ask to post to GitHub
  ✔ the model's github_read gets one issue or PR as bounded, quoted text
  ✔ ghCommand: unset stays on the system gh, explicit options.gh wins
```

用例数从 6 变 7 是因为新增了那条入口契约用例；原有 6 条全部保留且全过。

### 3.2 五个 `test` 步（我自己亲跑，未引用旧结论）

```
$ pnpm --dir examples/desktop-extensions/<each> test
pr-review : EXIT=0 | ℹ tests 5  | ℹ pass 5  | ℹ fail 0
test-runs : EXIT=0 | ℹ tests 12 | ℹ pass 12 | ℹ fail 0
github    : EXIT=0 | ℹ tests 7  | ℹ pass 7  | ℹ fail 0
usage     : EXIT=0 | ℹ tests 7  | ℹ pass 7  | ℹ fail 0
trace     : EXIT=0 | ℹ tests 10 | ℹ pass 10 | ℹ fail 0
```

### 3.3 整条 `test:extension-examples`

```
$ cd desktop && pnpm run test:extension-examples
ℹ tests 5 / pass 5     (pr-review)
ℹ tests 12 / pass 12   (test-runs)
ℹ tests 7 / pass 7     (github)
ℹ tests 7 / pass 7     (usage)
ℹ tests 10 / pass 10   (trace)
Error: PR Review browser bundle is stale. ...
EXT_EXAMPLES_EXIT=1
```

**这条整条命令不要求 EXIT=0，也不应该期待它 EXIT=0**：它里面嵌了 5 个 `build:check`，
而 `build:check` 在本机 CRLF 工作区下必然红（第一节已用实验证明是环境问题）。
**五个 `test` 步全绿，红的是 `build:check` 步，且只在这一步红。**

### 3.4 类型检查与 lint

```
$ pnpm --dir examples/desktop-extensions/github typecheck
TYPECHECK_EXIT=0
$ pnpm exec eslint examples/desktop-extensions/github examples/desktop-extensions/pr-review --max-warnings 0
ESLINT_EXIT=0
```

## 四、格式（CRLF 归一后真判）

prettier 判合规的前提是 LF。我把四个改动文件先归一到 LF 再用 prettier API 校验：

```
examples/desktop-extensions/github/source.ts                 -> 合规
examples/desktop-extensions/github/test/source.test.mts      -> 合规
examples/desktop-extensions/pr-review/repository.ts          -> 合规
examples/desktop-extensions/pr-review/integration.test.mjs   -> 合规
```

第一次校验时 `source.test.mts` 报不合规，原因是我新增的 import 行超过 `printWidth: 100`；
已按 prettier 意愿拆成多列并复验通过。**没有靠调宽配置或加 ignore 凑绿。**

## 五、最终改动面

```
$ git status --porcelain -- examples/desktop-extensions
 M examples/desktop-extensions/github/source.ts
 M examples/desktop-extensions/github/test/source.test.mts
 M examples/desktop-extensions/pr-review/integration.test.mjs
 M examples/desktop-extensions/pr-review/repository.ts

$ git diff --stat -- examples/desktop-extensions
 github/source.ts                    |  58 +++-
 github/test/source.test.mts         | 313 +++++++++++++++++--------
 pr-review/integration.test.mjs      |  35 ++-
 pr-review/repository.ts             |  63 ++++-
 4 files changed, 330 insertions(+), 139 deletions(-)

$ git status --porcelain -- examples/desktop-extensions/*/dist/
（无输出，dist 干净）
```

`source.test.mts` 的 diff 行数偏大（313 行）不是重写：整个文件的工作区副本是 CRLF，
而我的编辑以 LF 写回，`git diff` 按行展示时把缩进变化的段落一并计入。
文件里的 6 个原有用例逐条保留、断言未放宽。

## 六、未验证范围与已知局限

**未验证**

1. 未在真实 macOS / Linux 上跑过。本机是 Windows，POSIX 相关行为（本示例不涉及 `chmod`）未实际执行。
2. 未验证真实 `gh` 认证下的读取（全程用替身，按要求不调真实供应商与网络）。
3. 未验证桌面应用里真实渲染 github 视图的端到端链路（按要求不启动 Electron、不跑 Playwright）。
4. 整条 `test:extension-examples` 未 EXIT=0，见 3.3；原因是 `build:check` 的环境性红，不是未修完。
5. 没有在 LF 工作副本上跑整条命令——那需要把工作区行尾改掉，而 lead 明确禁止动行尾。
   3.1 的实验已经单独证明：LF 工作副本下五个 `build:check` 全 EXIT=0。
6. 未做任何 git 提交。

**已知局限**

1. `GITHUB_GH_EXECUTABLE` 是给测试与排障用的入口，不是给终端用户的开关。普通用户不该设置；
   设置错误会直接抛错而不退回真 gh（故意的，见 2.1）。
2. 该入口只影响 `gh`；示例里没有别处调用外部程序。
3. 环境变量是进程级的，测试必须自己在 `finally` 里还原；并行跑多个用例会互相干扰。
4. 两个入口同时存在时只认 `options.gh`——这意味着若有调用方既传 `options.gh` 又想用环境变量的
   前置参数，前置参数会被忽略。这是刻意的简单取舍：`options.gh` 从不带前置参数，
   避免「半个命令来自这里、半个来自那里」的隐式组合。
5. `--` 是启动器写法的必要部分（`node -- <launcher> pr view ...`），若将来有人去掉，
   `pr` 会被当成 node 要跑的脚本名。
