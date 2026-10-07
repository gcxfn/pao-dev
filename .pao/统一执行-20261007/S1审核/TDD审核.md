# S1 阶段级 TDD 审核（兼 S1 收口批重审）

日期：2026-10-07。审核者：S1 阶段级 TDD 审核子代理（独立、只读；唯一写入为本报告）。
审核对象：S1-2 包1（内核停止链健壮性，V1→V3）、S1-2 包2（桌面 EPIPE 断管边界＋会话锁显式接管，V1→V2）、S1 收口批（第 12 测＋注释/解构微缩）。
材料：两包全部实施记录与 TDD 审核（包1 R1/R2/R3、包2 R1/R2）、红绿留档日志、收口批实施记录、现行源码与测试全文、审核者自跑复验＋变异法实证。
自跑隔离：`PAO_HOME=D:\AI\workspace\临时文件夹\S1审核TDD-20261007\pao-home`（新建空目录）＋`PI_OFFLINE=1`＋`PI_NO_LOCAL_LLM=1`，全程零付费模型调用。

---

## 结论：**通过**

四项审核任务全部完成且无新增有效缺陷（P0—P3 均无）：

1. **收口批第 12 测质量——变异法实证成立**。该测具真实区分力：守卫注释掉后**恰该测变红**（其余 11 测全绿），恢复后 12/12 复绿、SHA 逐字节还原、git 终态零残留。「修前即绿（钉子属性）」的声明与「守卫删→红」的守卫声明双双被独立证实。
2. **S1 全阶段红绿链完整**。6 份红灯留档全部存在、签名可归因、计数自洽；仅有的两处历史缺口（包1 V2 A1 重取红灯未留档、包1 树杀用例非确定性修前未红）均已在使用侧披露并定性，且前者已被 V3 红灯留档实质覆盖，不构成未登记缺口。
3. **测试增量总账干净**。S1 净增 33 测（PAO 12＋desktop 21），逐条有行为锚点、无重复断言面、无未登记放宽（两处历史 diff 抽查确认纯增/等义改写）。
4. **dead-pipe.ts 解构微缩为纯等价重写**。R2 冻结版由现行版做且仅做收口批声称的两处反向替换即逐字节复原（SHA 8e43223c… 精确命中），无隐藏漂移；运行期语义无差。

自跑退出码：desktop 三 spec 21/21（EXIT 0）、tsc 双 config（均 0）、PAO 钉住两文件 12/12（EXIT 0）、变异红→恢复绿（1 红/11 绿 → 12/12，EXIT 0）。未跑全量慢链（口径见第六节）。

---

## 一、任务 1：收口批第 12 测变异法实证（变异与恢复全程留档）

### 1.1 被变异对象

`desktop/apps/desktop/electron/platform/pao/session-lock-owner.ts` 的 `enrichSessionLockOwnerEvent` 事件级守卫（:96-98）：

```ts
if (event.request.kind !== "notify" || event.request.level !== "error") {
  return event;
}
```

被测钉子：`session-lock-notice.spec.ts` 第 12 测「事件级守卫区分力：paoHome 存在且锁记录匹配时非 error 级 notify 仍原事件返回（TDD-R2 P3-1 补腿）」（:216-240）——真实临时 home＋按 sha256(sessionId) 落盘的匹配锁记录＋info 级 notify 事件，断言 `toBe(info)`。

### 1.2 变异过程实录（最小变异：守卫块注释掉）

| 步骤 | 动作 | 证据 |
|---|---|---|
| ① 变异前 | `session-lock-owner.ts` SHA-256＝`c4267bbdf9d525754f5eedfca2c3da6da0bea60bf002f9e73fe2c94110c70df4`（与包2 TDD-R2 §五冻结值一致，证收口批后无人再动） | 本报告 |
| ② 注入变异 | 守卫三行改为 `//` 注释（唯一改动，其余零触碰） | Edit 记录 |
| ③ 变异跑 | 跑全份 session-lock-notice.spec：**1 failed / 11 passed**——失败者恰为第 12 测，签名：`expect(await enrichSessionLockOwnerEvent(info, home)).toBe(info)` 失败，received 的 message 被追加「（原控制方：pid 4242，宿主面 desktop，持有自 2026-10-07 11:04:05）」＝info 事件被富化返回新对象 | 运行输出（关键行引文如上；该跑经管道取尾未单独捕获 playwright 退出码，失败内容与断言 diff 已足证，见 P4-5） |
| ④ 反证力 | 同一变异下第 10 测（M1 四腿，`paoHome=undefined`）**仍绿**——与 R2 P3-1「M1 单独无区分力」的判断完全吻合 | 同上运行输出 |
| ⑤ 恢复 | 守卫三行还原 | Edit 记录 |
| ⑥ 恢复核验 | SHA-256 回到 `c4267bbd…`（逐字节一致）；复跑 12/12 passed、EXIT=0 | 复绿日志 `临时文件夹/S1审核TDD-20261007/复绿-session-lock-notice.log` |
| ⑦ 终态 | `git status`：session-lock-owner.ts / session-lock-notice.spec.ts / dead-pipe.ts 均保持 `??` 未跟踪原态，desktop 仓 porcelain 总行数 91 与变异前一致，**零残留** | 本报告 |

**判定：收口批对第 12 测的守卫声明为真，钉子属性（修前即绿）登记与变异实证相容。** 变异法不可行的顾虑不存在，本次实际执行完成。

---

## 二、任务 2：S1 全阶段红绿链完整性盘点

### 2.1 红灯留档盘点表（逐份抽验）

| # | 留档 | 存在性 | 内容核验（本轮实读） | 证明力 |
|---|---|---|---|---|
| 1 | 包1 `红灯-钉住测试-修前.log` | 有 | **5 红/1 绿（6 用例）**；红签名：取消用例得 stopError 而期望 `{name:'AbortError'}`（与历史红同构）、降级炸穿、重试次数/返回形态等；绿 1 条＝守卫 b（修前修后均应绿，判定合理） | 行为级红，强 |
| 2 | 包1 `复现-全量test-pao-修前.log` | 有 | **7 败/1399 过（1406）**；含历史签名 `expected Error: Command failed: C:\Windows\System32… to match object { name: 'AbortError' }`——与 S2 全量（8 败/1406，同签名本轮实读命中）构成三轮同签名链 | 历史红归因，强 |
| 3 | 包1 `红灯-V2-钉住测试-修前.log` | 有 | **4 红/6 绿（10 用例）**；本轮实读命中三处干净行为红：A3 `expected undefined to be Error: 模拟：PowerShell 树杀超时失败`（cause 缺失）、A4 `…to contain 'Tree member still alive: 4242'`（截头）、A2 `expected 120000 to be less than or equal to 90000`；第四红为 A1 作废取参版 `expected '-Command' to match /\b4244\b/`（记录 §二已披露，见缺口 a） | 3/4 强；A1 留档本身不具行为红证明力（已另获覆盖） |
| 4 | 包1 `红灯-V3-钉住测试-修前.log` | 有 | **3 红/9 绿（12 用例）**；received＝V2 形态二跳脚本全文（无身份元组、全文无 `PID reused`、预写行 `indexOf`＝−1），证明红确取自修前实现；A1 强化断言的干净红在档（`to contain '@(4244,1339778498123)'`） | 行为级红，强；顺带覆盖缺口 a |
| 5 | 包2 `红灯-删模块复红.log` | 有 | 两模块加载失败全红：`Cannot find module '../../electron/platform/dead-pipe'`＋`Cannot find module '../../contracts/session-lock-notice'`，栈指向两 spec import 行；尾部 `Error: No tests found` 与「仅点名两份原 spec」口径一致 | 连线级最弱红（R2 已如实定性，未拔高） |
| 6 | 包2 `红灯-连点禁用.log` | 有 | 干净行为红：仅第 3 测「连点防护」败（`Expected []` vs `Received ["/pao runtime takeover 39c64f0e-…"]`），前 2 测过——失败面恰为新行为本身 | 行为级红，强 |
| 7 | 收口批「钉子即绿登记」 | 有（收口批实施记录 §一第 4 项「钉子属性（修前即绿），本 spec 11→12 测」） | 无红灯属钉子属性的正确形态；守卫区分力已由本审核第一节变异法实证补足 | 变异实证补强，闭合 |

对应绿侧：`绿-钉住测试-修后.log` 6/6、`绿-V2-钉住测试-修后.log` 10/10、`绿-V3-钉住测试-修后.log` 12/12、`复现-verifier-run-定向.log` 22/22（隔离绿，支撑非确定性披露）——本轮逐份实读计数全部吻合。时间线（红 05:29/06:21/07:09 → 修 → 绿）与 R2/R3 审核记载自洽。

### 2.2 残余缺口盘点（「声称为红但无留档」「留档红签名不具证明力」）

- **缺口 a：包1 V2 A1「重取红灯」未留档**（留档系作废取参版）。定性：已在 V3 实施记录 §四.3 注记、R2 P3-A 关闭、R3 判「双重关闭」。本轮追加核验：**V3 红灯日志中 A1 强化断言的干净红在档**（received＝V2 脚本全文，结构性不可能含身份元组），旧缺口被后继留档实质覆盖。**不再开放，仅 P4-4 备案。**
- **缺口 b：包1 树杀用例（历史红第 2 条）修前未红（非确定性）**。实施记录 §六.2 如实披露「未取得该条目修前红的本轮实证」，以同链路取消用例转绿＋修后全量 0 新失败佐证——非虚报红灯，属已披露的非确定性残余；S12 真实验收（V1 项）仍会覆盖该面。**维持披露，不构成违规。**
- **包2 V1 红灯无原始留档**（14 测「模块不存在」仅文字声明）：V2 已用删模块复红法补留档（表 #5），R2 F1 关闭；行为断言区分力由 R1 逐条推演＋钉子属性登记补强，F8 行为红独立在档。**闭合。**
- **「留档红签名不具证明力」清单**：即表 #3 第四红（作废版）与表 #5（连线级弱红）两处，均已在使用侧如实定性、未冒充行为红。除此之外未发现签名不可归因的红留档。

**盘点结论：S1 阶段不存在「声称为红但无留档且未披露」或「以弱红冒充行为红」的未登记残余。**

---

## 三、任务 3：测试增量总账（S1 净增 33 测）

### 3.1 包1（PAO，净增 12：card-process-stop 4→5，kill-tree-retry 2→7）

| 用例 | 锚点行为 | 红绿形态 |
|---|---|---|
| card a 取消时 AbortError 优先（V1）＋V2 扩展 cause toBe＋warnSpy | 停止失败不掩盖取消语义 | V1 真 红→绿；V2 扩展红（cause undefined）→绿 |
| card b 无取消树杀失败仍报错 | 真超时报错不吞 | 守卫（修前即绿，登记如实） |
| card c 树杀失败降级「无法判」＋沙箱保留＋不自动交付 | 降级不炸穿 | V1 真 红→绿 |
| card d 端到端取消仍 AbortError | 取消传播端到端 | V1 真 红→绿（历史红同构） |
| card A4 降级说明保留错误尾部 | 截尾取真实原因 | V2 真 红→绿 |
| kill e 首次失败重试成功→恰 2 次调用 | 重试策略 | V1 真 红→绿 |
| kill f 两次都失败才报错、无第三次 | 重试上界 | V1 真 红→绿 |
| kill A5 首次成功只调 1 次＋钉首跳 60000 | 成功路径不重试＋成本契约起点 | V2 钉子（修前即绿，登记如实） |
| kill A2 两次超时合计 ≤90000 | 杀阶段预算封顶 | V2 真 红→绿 |
| kill A1 二跳按身份元组种子续杀 | 空选不假绿 | V2 红（留档缺口已补，见 P4-4）→V3 改对红→绿 |
| kill C1 复用种子双配对丢弃＋记录 | 防 pid 复用误杀 | V3 真 红→绿 |
| kill C2 预写清单先于收尾检查 | 收尾前秒级窗口 | V3 真 红→绿 |

### 3.2 包2（desktop，净增 21：14→20→21）

| 文件/用例 | 锚点行为 | 红绿形态 |
|---|---|---|
| dead-pipe ×6：口径集合／双流吸收＋微任务／非断管 rethrow＋路由／uncaught 断管吸收／uncaught 非断管转发／dispose 还原 | 断管边界两条腿＋生命周期 | V1 模块不存在红（删模块复红法留档＋断言推演）；均为补测即绿 |
| notice ×12：token 解析／命令拼装／详情格式化／幂等追加／按 token 读取／损坏＋固定 token 无效（M4 改写）/富化分支／字段同构／ISO 回退（M7）／M1 四腿／**第 12 测守卫区分力（收口批）**／同一性＋命中不原地改 | 契约＋富化＋守卫 | 补测即绿（登记如实）；第 12 测变异实证（第一节）；M4 改写为纯增增强（登记于 V2 §一） |
| takeover ×3：取消不提交／确认恰一条命令／F8 连点防双发 | 点击策略表面 | 前两条补测即绿；F8 唯一真 红→绿 |

### 3.3 重复断言面与放宽检查

- **无重复凑数**：takeover「确认恰一条」与 F8 维度不同（提交一次 vs 已提交后不重复）；M1 四腿（`paoHome=undefined`）与第 12 测（真 home）是严格增强关系，四腿另钉 confirm/select kind 不冗余；kill e 与 A5 分居失败/成功路径；kill f 与 A2 同 mock 面但断言面不同（报错传播 vs 预算合计）。
- **历史 diff 抽查两处（V1→V3）**：
  1. card a：V1 红灯行帧 `:84:19 await expect(op).rejects.toMatchObject({ name: "AbortError" })` → 现行 ：79 改为 captured 形态 `expect(captured).toMatchObject({ name: "AbortError" })`＋**纯增** cause toBe＋warnSpy 断言（V2 §一.4 登记的扩展）——核心断言逐字保留，纯增强非放宽。
  2. kill f：V1 红灯行帧 ：53-54（`failOnce(); …rejects.toThrow("PS 脚本超时"); …toHaveBeenCalledTimes(2)`）与现行 ：50-51 逐字同，零变化。
- 结合 R2/R3 已做的行帧逐字比对（desktop 三 spec 与 PAO 两文件）与「未发现声明外断言改动」结论，**未发现 V1→V3 过程中被放宽又未登记的断言**。既有（非新增）测试零断言语义变化此前已由包1 R1 §五、包2 R1 §二.6 分别核实，本轮无反证。

---

## 四、任务 4：dead-pipe.ts 解构微缩的行为等价

- **变更面字节级锁定**：由现行版（SHA-256 `f317ee12…`，与收口批漂移表改后值一致）做且仅做两处反向替换——`const { code } = error as NodeJS.ErrnoException;` → `const code = (error as NodeJS.ErrnoException).code;`、`${code}` → `${String(code)}`——重建文本 SHA-256 **精确命中** R2 冻结值 `8e43223c9fd5a1768159972eae6e27e02bdac6a65ac95427a8ed1df36f86b2df`。变更恰为收口批声称的两处，无任何隐藏漂移；两版均 72 行，「净 0 行」声明成立。
- **语义等价论证**：该行处于 `if (isDeadPipeError(error))` 分支内；`isDeadPipeError` 为真当且仅当 `code !== undefined && DEAD_PIPE_ERROR_CODES.has(code)`（实现 ：15-21），故运行期 `code` 恒为集合内字符串。对任意字符串，`String(code)` 与模板插值同为 ToString，输出逐字符相同。理论唯一差异点是 Symbol（模板插值抛 TypeError 而 `String()` 不抛），但 `Set<string>.has(symbol)` 恒为 false，该分支对 Symbol 不可达；undefined 已被 `isDeadPipeError` 前置排除。类型层面两写法均为 `string | undefined`，插值合法，tsc 双 config 0。
- **判定：纯等价重写，无语义差。** 收口批「isDeadPipeError 为真时 code 必非 undefined，插值输出相同」的理由成立，且实际约束比其声称的更强（集合成员资格排除一切非字符串）。

---

## 五、发现清单

**P0／P1／P2／P3：无。**（四项任务均未产生新的有效缺陷；两包历轮 TDD 审核的 P0-P3 均已闭环，本轮未发现回退或漏网。）

P4（登记级，均不阻塞）：

| # | 内容 | 状态 |
|---|---|---|
| P4-1 | 包2 两份红灯日志未捕获退出码行（`EXIT=1` 为实施侧声明） | 包2 V2 §九已登记，维持 |
| P4-2 | 包2 F8 红版 spec 与现行版行号差 3 行（untracked 无法逐字节归因） | 已登记，维持 |
| P4-3 | 包2 V1 spec 无留档副本，既有 14 测改动核对采三角法 | 已登记，维持 |
| P4-4 | 包1 V2 A1「重取红灯」未留档——历史缺口；V3 红灯日志已提供同一断言强化版的干净红（本轮实读确认），实质覆盖 | 历史备案，不开放 |
| P4-5 | 本审核变异红跑经管道取尾，未单独捕获 playwright 退出码（失败内容与断言 diff 足证） | 本报告如实登记 |

建议（不计发现）：

1. session-lock-notice.spec 各用例 `mkdtemp` 后无清理，长期在系统临时目录累积（既有模式，非本批范围）——挂 S11 测试卫生随手项。
2. 钉子测的「守卫删除→红」区分力用变异法抽查成本低、证明力强，可纳入后续包 TDD 审核惯例。

---

## 六、自跑复验与退出码

隔离：`PAO_HOME=D:\AI\workspace\临时文件夹\S1审核TDD-20261007\pao-home`（新建）＋`PI_OFFLINE=1`＋`PI_NO_LOCAL_LLM=1`。

| 门 | 命令 | 退出码 | 结果 |
|---|---|---|---|
| desktop 三 spec 合跑 | `npx playwright test -c apps/desktop/playwright.config.ts <dead-pipe-boundary＋session-lock-notice＋session-takeover-button>`（cwd=desktop 仓根） | **0** | **21/21 passed（6.3s）** |
| tsc app | `npx tsc -p tsconfig.json --noEmit`（cwd=apps/desktop） | **0** | — |
| tsc electron | `npx tsc -p tsconfig.electron.json --noEmit`（cwd=apps/desktop） | **0** | include 覆盖 main.ts＋dead-pipe.ts |
| PAO 钉住两文件 | `npx vitest run test/pao/kill-tree-retry.test.ts test/pao/card-process-stop.test.ts --maxWorkers=1`（cwd=packages/coding-agent） | **0** | **12/12 passed（5.6s）** |
| 变异红跑（任务 1） | 同 desktop 合跑但守卫注释掉 | （内容证据） | 1 failed（恰第 12 测）/ 11 passed |
| 变异恢复跑 | 同 desktop 单 spec | **0** | 12/12 passed |

**口径注明（未跑项）**：unit lane 全量、core e2e、全量 `test/pao/`、electron-vite build 等**全量慢链未跑**——按用户既定纪律移尾部集中批次，本审核不重复执行；unit lane 16 败族的 S0 基线既有族定性采信包2 对抗式 R1 关沙箱复跑＋R2 直核（逐 spec 同族同数、本包触碰面零出入），真实 Electron 两腿未重复执行（包2 V2 已留证）。本审核自跑日志存 `临时文件夹/S1审核TDD-20261007/`。

## 七、审核者动作留痕

- 读：根/PAO/desktop 三 AGENTS.md、统一计划 §4.3 与 §5 S1、两包全部实施记录（包1 V1/V2/V3、包2 V1/V2、收口批）、五份 TDD 审核报告全文、内核仓归属对账、执行总册 S1 段；源码 6 个（dead-pipe.ts、session-lock-owner.ts、main.ts 接线段、kill.ts 关键段、两 PAO 测试文件全文）＋desktop 三 spec 全文＋session-takeover-button spec 全文。
- 核：收口批 SHA-256 漂移表 4 文件改后值逐一命中；R2 冻结版 dead-pipe.ts 字节级重建命中；红灯留档 6 份＋绿留档 4 份实读抽验；两处历史 diff 断言抽查；变异全过程（注入→红→恢复→SHA 还原→绿→git 零残留）。
- 写：仅本报告；变异与恢复已逐字节还原（SHA-256 复核），被审核文件零净变更。
