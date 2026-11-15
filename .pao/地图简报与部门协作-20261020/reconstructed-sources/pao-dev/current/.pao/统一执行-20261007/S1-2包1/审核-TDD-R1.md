# S1-2 包1 TDD 审核 R1（内核停止链健壮性）

日期：2026-10-07。审核者：TDD 审核子代理（独立、只读；唯一写入为本报告）。
审核对象：`实施记录.md`＋工作树实际 diff＋留档日志＋审核者自跑复验。
自跑环境：`PAO_HOME=D:\AI\workspace\临时文件夹\S1-2包1审核-pao-home-20261007`＋`PI_OFFLINE=1`＋`PI_NO_LOCAL_LLM=1`，在 `PAO/packages/coding-agent` 下执行。

## 结论

**TDD 审核通过。** 红→绿证据链完整：历史红三轮同签名（S2 基线门→S2 全量→本包修前全量），6 条钉住测试先红留档且失败原因均为「新行为未实现」，修后全量 6/1412 全为已知环境族、verifier-run 转绿；既有测试零断言语义变化（仅标识符英化，期望值逐一比对不变）；无为绿放宽断言；非确定性披露如实。缺陷仅 4 项 P3（缺 1 个补测建议＋3 项记录/微覆盖建议），无阻塞项。

## 一、红→绿证据对应表（审核者自行复核）

### A. 历史红（既有 verifier-run 用例，非本包新测试）

| 轮次 | 证据 | 审核复核 |
|---|---|---|
| 第1轮（S2 前基线门） | `S2前置修复包/实施记录.md` §二引述签名 | 签名：`expected Error: Command failed: C:\Windows\System3… to match object { name: 'AbortError' }` |
| 第2轮（S2 全量 04:34） | `S2前置修复包/验证-全量test-pao.log`（8 败/1406） | 行 157 取消用例签名与第1轮**逐字一致**；另有树杀用例红×1（「超时判 124…孙进程随整棵树终止」），错误体为同一严格树杀 PS 脚本报错 |
| 第3轮（本包修前） | `S1-2包1/复现-全量test-pao-修前.log`（7 败/1406） | 行 156-157 签名与前两轮**逐字一致**（同一断言行、同一 PS 脚本错误体、`killed:true`＋`signal:SIGTERM` 即 PS 被 15s 预算杀死）；本轮树杀用例未红，记录已如实标注非确定性 |
| 修后 | `S1-2包1/验证-全量test-pao-修后.log` | **6 败/1412**＝loadout-tiers-config ×5＋host-inventory ×1，全部已知环境族；verifier-run 0 红、零新失败 |

签名一致性判定：**成立**（三轮同测试名、同断言、同错误体结构；逐字核对行 157）。

### B. 钉住测试 6 用例红→绿

| 用例 | 修前（`红灯-钉住测试-修前.log`，5红/1绿） | 修后留档 | 审核者自跑 |
|---|---|---|---|
| a 取消时 AbortError 优先（单测） | **红**：得到 `Error: 模拟：PowerShell 树杀超时失败`，期望 `{name:'AbortError'}`——与历史红同构 | 6/6（`绿-钉住测试-修后.log`） | **6/6 绿，exit 0** |
| b 无取消树杀失败仍报错（守卫） | 绿（修前修后均应绿，判定合理） | 同上 | 同上 |
| c 树杀失败降级「无法判」＋沙箱保留＋不自动交付 | **红**：`Error: 模拟：PowerShell 树杀超时失败` 炸穿 verifyCard | 同上 | 同上 |
| d 端到端取消仍 AbortError | **红**：stopError 顶替 AbortError（历史红同构） | 同上 | 同上 |
| e 首次失败重试成功→2 次调用、正常返回 | **红**：应 resolve 却 reject | 同上 | 同上 |
| f 两次都失败才报错、不再第三次调用 | **红**：`called 1 times`≠2 | 同上 | 同上 |

**先红证据已留档**（修前 5 红逐条核对，失败原因均为新行为未实现，非环境噪声），无需动用「代码结构证明」兜底。记录 §二.4 还如实登记了首轮用例含 `>` 被安检门拦、改写后重取红灯基线的经过——重写只改命令写法（去串联符），未放松任何断言，判定合规。

### C. 审核者自跑复验（本轮实测绿）

| 命令 | 结果 |
|---|---|
| `vitest run test/pao/card-process-stop.test.ts test/pao/kill-tree-retry.test.ts --maxWorkers=1` | **6/6 通过，exit 0**（2.0s） |
| `vitest run test/pao/verifier-run.test.ts --maxWorkers=1` | **22/22 通过，exit 0**（21.7s，与记录 26.6s 同量级） |

## 二、覆盖面（审核任务点名的 6 个触发行为）

| 触发行为 | 钉住用例 | 判定 |
|---|---|---|
| AbortError 优先（abort＋stopError 并存） | a（runCardProcess 单测）＋d（verifyCard 端到端） | **覆盖** |
| 真超时仍报错 | f（execFile 错→reject→两次才抛）＋b（无取消→以 stopError 拒绝，真超时语义不吞） | **覆盖（行为级）**；60000 预算值本身无用例（见 P3-2） |
| 重试两次才抛 | f（含「不再第三次调用」断言） | **覆盖** |
| 第一次成功不重试 | — | **缺失**（见 P3-1）：无「成功→恰 1 次调用」用例 |
| 降级含错误原文 | c（`条目结果[0].说明` 含「PowerShell 树杀超时失败」） | **覆盖**；160 字符截断未测（P3-3） |
| 取消不降级 | d（abort 后以 AbortError 上抛，落不到「无法判」条目；同时覆盖 verifier catch 内 `throwIfAborted` 分支） | **覆盖** |

缺失清单：仅 P3-1 一项。次级观察：树杀成功路径（首次成功不重试）当前由 worker-stoptree/windows-shell-stop 真实链路测试间接覆盖「功能正确」，但不可见「调用次数」。

## 三、公开行为判定：**合格，非镜像实现**

- `card-process-stop.test.ts`：被测对象是导出函数 `runCardProcess`／`verifyCard`；`killTree` 在模块边界 mock（OS 副作用的自然注入缝，注入面仅 1 个函数）；断言全部为可观察结果（拒绝的 name／报错原文、验收结论、条目结果与说明、卡状态停留「进行中」、沙箱保留路径非空、自动交付缺席），且用真卡文件＋真沙箱＋真 node 子进程。无内部调用序列镜像。
- `kill-tree-retry.test.ts`：被测对象是导出函数 `killTree` 的重试策略；`execFile` mock 是 OS 边界；「调用次数」断言即重试策略本身的可观察契约（钉的语义就是「试几次」），不属 mock 过深。
- 未出现「为可测而改产品代码暴露内部」迹象（diff 中无测试导出/注入口新增）。

## 四、非确定性处理：**披露成立，无放宽断言**

1. 复现方法成立：历史红只在 4-worker 全量高负载出现（S2 04:34 全量与本包修前全量同口径复现），隔离定向始终绿（S2 六组证据＋本包修前 22/22＋审核者自跑 22/22）——记录 §一.1 如实呈现「定向不红、全量才红」。
2. 树杀用例（历史红第 2 条）本轮修前未红：记录 §一.2 与 §六.2 明示「非确定性、未取得本轮实证，以同链路取消用例转绿＋全量 0 新失败佐证」——未谎称双红转绿，**如实披露成立**。
3. 无为绿放宽断言：历史红用例的核心断言 `rejects.toMatchObject({ name: "AbortError" })` 在工作树中原样保留（diff 中仅周边标识符改名，断言本体未动）；转绿来源是**语义修复**（process.ts 判定对调后，即便树杀失败也归 AbortError）＋预算/重试降低 stopError 发生率，不是把测试改松。新测试亦未用 try/catch 吞断言。

## 五、既有测试：**零断言语义变化**

git diff 逐一核对 9 个 stop-chain 相关既有测试文件（verifier-run／verifier-parse／worker-stoptree／worker-cancel／worker-run／parent-lifecycle＋child／host-fuse／worker-dispatch-guards）：

- 全部改动为标识符英化，与 src 同映射（卡目录→cardDir、工作目录→workDir、已停进程→stoppedProcesses、已在运行→isRunning、计数→count 等）；期望值逐一比对**无一处变化**（verifier-run 20 删/20 增 expect 一一对应，值全同；卡协议中文字段 类型/主体/结果/结论/状态 均未改名，兼容契约完好）。
- 新增块均属其他工作包（worker-cancel「T04 红线」2 用例、parent-lifecycle probe 用例、worker-run 垫片用例加 PI_PACKAGE_DIR 且注明 T12）——非本包改动，且均为纯新增，不含既有断言放松。
- 本包仅新增 2 个测试文件（git untracked 证实：card-process-stop.test.ts、kill-tree-retry.test.ts），符合「只允许新增测试文件」。
- 范围外 `src/core/tools/bash.ts:165-170` 同款 stopError 先判模式确认存在且**未被本包改动**（git status 干净），记录 §五 的范围外观察登记属实。

审核口径说明：工作树为多包混载的未提交状态，git diff 无法把 hunk 归因到单一包；本审核以「断言语义是否变化」裁定（这也是任务真正要判的问题）——结论为零语义变化。

## 六、发现汇总（P0-P3）

| 级别 | 发现 | 建议 |
|---|---|---|
| P0/P1/P2 | 无 | — |
| P3-1 | 缺「第一次成功不重试」用例：killTree 首次成功→应恰 1 次 execFile 调用，套件不可见该契约 | 后续包顺手补 1 用例（fail 0 次＋succeed 1 次→toHaveBeenCalledTimes(1)）；当前结构成功即 return，风险低 |
| P3-2 | 60000 超时预算值无用例钉住；若回归回 15s 套件不可见 | 不必钉常量（钉常量＝镜像实现）；可在 kill.ts 注释保持现状即可，接受 |
| P3-3 | 降级说明 160 字符截断未测 | 微小，随 P3-1 顺手补或不补 |
| P3-4 | 实施记录 §二 对三文件 diff 的描述只列语义改动（「2 个判定块换序＋2 行注释」），未提同文件内的标识符英化（timeout毫秒→timeoutMs、宽限毫秒→graceMs、verifier 全文件类型英化） | 英化系工程公约允许的「顺手改」，断言语义零变化，不构成违例；若英化属本包所做，记录宜补一句以如实呈现可见 diff 面（多包混载下 git 无法归因，存疑不罚） |

## 七、审核动作清单

只读核对了：实施记录、三源文件 diff（kill.ts/process.ts/verifier.ts 全文）、2 新测试文件全文、9 既有测试文件 diff 的全部含 expect 行、修前/修后及 S2 历史共 6 份日志的关键行、bash.ts 观察点、check-gates 日志；复跑 2 组定向测试（隔离 PAO_HOME＋PI_OFFLINE=1，均绿）。未修改任何被审核文件。
