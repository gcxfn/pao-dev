# test:guards 39 条红：归因与修复（H1 附带发现，2026-10-17）

## 结论

`desktop/` 的 `pnpm run test:guards` 在 Windows 上**从来没绿过**（不是被谁改坏，是写的时候只在 POSIX 上验过）。39 条红分属 5 个文件、**同为「路径是被拼成字符串而不是按路径比较」这一个病根**（35 条是失败文案里的反斜杠，3 条是路径文案，1 条是拿字符串比 TS 的文件名）。**修根因不改夹具**：改 4 处产品/测试代码共 5 个文件，不改 6 处写死 `/` 的期望正则。

修复后实测：

| 时点 | tests | pass | fail | 退出码 |
|---|---|---|---|---|
| 修前（d3-host H1 实测） | 114 | 75 | 39 | 1 |
| Lead 只修 `check-renderer-boundary.mjs:83` 后 | 114 | 110 | 4 | 1 |
| 再修 `typed-lint.test.mjs:136`、`check-workspace-typechecks.mjs:22` 后 | 114 | 111 | 3 | 1 |
| 修 `contract-resolution.test.mjs` 后（单跑 2 passed） | — | — | — | 0 |
| **四文件全修后 `pnpm run test:guards`** | **114** | **114** | **0** | **0** |

隔离验证：`pnpm run check:architecture` 修后仍 EXIT=0，四条全绿（`Renderer boundary passed (190 first-party runtime source files).` / `Owned workspace contracts have no ambient redeclarations.` / `Host dependencies stay outside renderer and test implementation.` / `Timeline scroll ownership passed.`）——证明受影响的只有 guards 车道的输出文案与用例入口，没动边界判定。

## 一、39 条红的分区

| 文件 | 条数 | 断言在 | 生产者（真正造出反斜杠的地方） |
|---|---|---|---|
| `desktop/scripts/check-renderer-boundary.test.mjs` | 35 | 期望正则 6 种，全写死 `/` | `desktop/scripts/check-renderer-boundary.mjs:83` |
| `desktop/scripts/typed-lint.test.mjs:160` | 1 | `/packages\/new-feature: add a typed project/` | 测试内 `workspaceLintFailures()`（`:136`） |
| `desktop/scripts/check-workspace-typechecks.test.mjs:8` | 1 | `/modules\/new-workspace\/package.json: missing scripts.typecheck/` | `desktop/scripts/check-workspace-typechecks.mjs:22` |
| `desktop/scripts/contract-resolution.test.mjs:10` | 1 | `assert.equal(diagnostics[0].file?.fileName, file)` | TypeScript 编译器规范化后的文件名 |
| `desktop/scripts/test-entrypoints.test.mjs:93` | 1 | `result.status === 0`（Playwright `--list`） | Playwright 的 spec 位置参数匹配 |

## 二、根因证据（三条独立、方向一致）

**证据 1：守卫本体自己就知道要归一，唯独输出处漏了。**
`desktop/scripts/check-renderer-boundary.mjs` 里，同一文件 `:19-21` 对文件路径做了

```js
path.relative(root, file).split(path.sep).join("/")
```

而 `:83` 拼失败消息时直接用

```js
failures.push(`${path.relative(root, file)}:${line + 1}: ${reason}`)
```

同一份相对路径，一处归一、一处不归一 ⇒ 不是没意识到 Windows，是漏了一处。

**证据 2：测试文件里一处归一代码都没有。**
`check-renderer-boundary.test.mjs` 全文件 grep `path\.sep|replace\(|split\(` **命中 0**。而同目录 `desktop/scripts/test-entrypoints.test.mjs:175` 就有 `file.split(path.sep)[0]` ⇒ 同一批脚本里，有的写了、这个没写。

**证据 3：上游 POSIX CI 上 `/` 恒真，所以从来没人发现。**
`desktop/.github/workflows/ci.yml:37` 的 `typecheck` job 是 `runs-on: ubuntu-latest`，`:52-53` 跑的 `pnpm check` 里含 `test:baseline`（含 `test:guards`）。POSIX 上 `path.relative()` 返回的就是 `/`，断言必然通过；`ci.yml:227` 的 `desktop-package-windows` 虽然 `runs-on: windows-latest`，但只跑 `verify:launcher-contract` / `test:changed-files` / `package:win:dir` / `verify:packaged-runtime-deps:windows`，**不含 `test:guards`**。

**不是被改坏的证据**：文件首次出现 `68642b38`（2026-09-18），最后一次 `0234f2f3` (#154)（2026-09-23 14:20 北京时间），此后没人动过；20 条带 windows/win32/guards 字样的提交里没有一条针对这个文件（`1f73884c` win32 skip×9、`20a65cbd` skip×3、`1dbcdc33` S12 都落在 `test:desktop-unit` / `e2e` / 冒烟车道）。

## 三、四次修复（逐处）

### 1. `desktop/scripts/check-renderer-boundary.mjs:83`（消 35 条）

```js
// 改前
failures.push(`${path.relative(root, file)}:${line + 1}: ${reason}`);
// 改后
failures.push(`${path.relative(root, file).split(path.sep).join("/")}:${line + 1}: ${reason}`);
```

实测产出的实际值：`"apps\\desktop\\src\\index.ts:1: Forbidden renderer runtime dependency 'node:fs'. Use the preload API instead."`（改前）→ `apps/desktop/src/index.ts:1: …`（改后）。

### 2. `desktop/scripts/typed-lint.test.mjs:136`（消 1 条）

同一处测试函数 `workspaceLintFailures()` 自己产出这段文案，所以改在测试里：

```js
`${path.relative(workspaceRoot, project.path).split(path.sep).join("/")}: add a typed project in eslint.config.mjs; missing ${missing.join(", ")}.`
```

### 3. `desktop/scripts/check-workspace-typechecks.mjs:22`（消 1 条）

```js
`${path.relative(root, workspace.path).split(path.sep).join("/")}/package.json: missing scripts.typecheck. Add a typecheck command so this workspace participates in CI.`
```

### 4. `desktop/scripts/contract-resolution.test.mjs`（消 1 条）

这一条不是「文案里带反斜杠」，是**拿字符串直接比文件名**：TypeScript 编译器的 `sourceFile.fileName` 是规范化后的值，Windows 下与 `path.join()` 拼出来的不完全相等。改法是按解析后的路径比：

- `:30-31` `name === file` → `path.resolve(name) === path.resolve(file)`
- `:40` `assert.equal(diagnostics[0].file?.fileName, file)` → `assert.equal(diagnostics[0].file && path.resolve(diagnostics[0].file.fileName), path.resolve(file))`，并加注释「TypeScript 规范化文件名（Windows 下分隔符与大小写都可能不同），比较须按解析后的路径」
- `:42` 前加 `assert.ok(source, "program must contain the in-memory contract proof")`（`getSourceFile(file)` 因此也可能取空，先断言再解引用，别让它以 TypeError 的形式失败）
- `:47-50` `assert.equal(path.resolve(declaration.getSourceFile().fileName), path.resolve(path.join(root, "packages/session-driver/dist/types.d.ts")))`

### 5. `desktop/scripts/test-entrypoints.test.mjs:93`（消 1 条）

改前用 `spawnSync` 调 Playwright `--list`，传**绝对路径 spec**，报 `Error: No tests found.` / `1 !== 0`。最小复现（只 `--list`，不跑用例、不起 Electron）：

| 传法 | 结果 |
|---|---|
| 绝对 cfg + 绝对 spec | 0 files |
| 绝对 cfg + `core/smoke.spec.ts` | `Total: 3 tests in 1 file` |
| 绝对 cfg + `core\smoke.spec.ts` | `Total: 3 tests in 1 file` |
| 相对 cfg + 绝对 spec | 0 files |

⇒ **Playwright 的 spec 位置参数按相对路径匹配**，与斜杠方向无关。改后：

```js
      // Playwright 的 spec 位置参数按相对路径匹配：传绝对路径在 Windows 上找不到用例
      // （实测 --list 返回 No tests found），相对路径正反斜杠都能匹配。
      path.relative(root, smokeSpec).split(path.sep).join("/"),
```

## 四、为什么修根因不修夹具

1. **一处胜六处**：改产品 1 行（`check-renderer-boundary.mjs:83`）消掉 35 条；改 6 条期望正则要动 35 个断言点，且下次再加一条检查又得记住写归一。
2. **归一后的文案已通过「语法有效」检验**：守卫本体 `:19-21` 就是同一写法，两条路径现在一致，不再有「一处归一、一处不归一」的裂缝。
3. **不改守卫的判定**：隔离证据是 `check:architecture` 四条仍全绿——改动只发生在**失败消息的拼接**，不在判定逻辑。

## 五、教训（要进长期文档）

1. **Windows 上「护栏红」先怀疑护栏自己**：39 条红全部来自脚本自身的路径文案，产品代码一行没坏。判据是「红的断言全是路径/文件名比较」+「POSIX CI 上是绿的」。
2. **`test:guards` 在 Windows 上从未被验收**：`desktop/.github/workflows/ci.yml:37` 是 `ubuntu-latest`，Windows 那个 job（`:227`）跑的是另一套命令。这条要单列成待用户决定的事项（「Windows 上该由谁保证护栏有效」），不是本批能自决的。
3. **期望正则写死 `/` 是一种隐式平台假设**：以后新写路径断言，一律 `split(path.sep).join("/")`，或用 `path.resolve()` 后比较。
4. **失败消息里带路径时，和日志/UI 用同一套归一规则**：否则日志好看、断言难写，两边各写一遍。

## 六、边界

- 本轮**未启动 Electron、未跑 Playwright 用例**（`--list` 只列用例不执行；d3-host 复现时也未起窗口）。
- 未提交 git。改动面：`git diff --stat -- scripts/` = 5 files changed, 22 insertions(+), 8 deletions(-)。
- 未验：Linux 上是否仍全绿（本机无 Linux，按证据 3 属推断）。

## 七、追问：`test:baseline` 还差一条

`test:guards` 修绿后，Lead 立刻往上一层验 `pnpm run test:baseline`（= `test:guards && …`），**EXIT=1**，剩下的失败与本修复无关：

| 段 | tests | pass | fail |
|---|---|---|---|
| `test:guards`（本轮修复对象） | 114 | 114 | 0 |
| 下一段 | 29 | 29 | 0 |
| `@pi-gui/pi-sdk-driver` 的 `node --test "test/**/*.test.mts"` | 226 | 225 | **1** |

失败用例：`desktop/packages/pi-sdk-driver/test/session-lease.test.mts:308:7`「processes racing to take over a dead lease: exactly one acquires」，
报 `Error: child started after the race`（`session-lease.test.mts:284:50`）。

**为什么它和本修复无关**（三条）：①它在 `packages/pi-sdk-driver`，本轮 5 个改动文件全在 `desktop/scripts/`，包内一行没动；②它失败的理由在测试自己的**时间假设**上——`raceForLease()`（`session-lease.test.mts:254-298`）把起跑时刻定成 `Date.now() + 1_000`，6 个子进程 `spawn()` 后各自 busy-wait 到那一刻，**谁在起跑线之前还没加载完就用 `Date.now() > startAt` 判自己「迟到」直接判负**（`:261`），所以只要机器在 1 秒内拉不起 6 个 Node 进程（本轮基线运行时机器上还有别的活）就会红；③复跑 3 次全绿（`session-lease.test.mts` 单跑 3 次：`pass=16 fail=0` ×3，每次都含「racing to take over a dead lease」那条，用时 5.5s / 5 轮）。

**判定：环境相关的 flaky 用例（机器负载敏感），不是产品缺陷，不是本轮引入，未修。** 修法（若将来要修）只在测试里：把 1 秒固定余量换成「子进程先报到、父进程再宣布起跑」的同步，或把余量做成按机器能力取值的参数——**但这是 pi-sdk-driver 的活，不在本批边界内，留作待决事项**。

