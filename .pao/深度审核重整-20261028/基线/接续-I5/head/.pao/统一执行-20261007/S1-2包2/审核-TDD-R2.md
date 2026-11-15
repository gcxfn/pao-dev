# S1-2 包2 TDD 审核 R2（独立只读，V2 修复后复验）

日期：2026-10-07。审核对象：V1《实施记录.md》＋《V2-实施记录.md》对应 desktop 仓改动。
审核者环境：隔离 `PAO_HOME=D:\AI\workspace\临时文件夹\S1-2包2审核R2-20261007\pao-home`＋`PI_OFFLINE=1`＋`PI_NO_LOCAL_LLM=1`，cwd=desktop/apps/desktop。
本审核未修改任何被审核文件；唯一写入为本报告（审核临时目录仅存自跑日志与对照文件）。

## 结论

**通过。**

R1 F1-F8 全部关闭（其中 F2 关闭但附一项新发现的测试区分力保留，F1 关闭但恢复/复绿段属记录声明＋本审核现状佐证）。V2 唯一真红→绿（F8 连点）链完整；其余 V2 用例按钉子属性登记，登记如实。三 spec 合跑 20/20 自跑复绿，tsc 双 config 与架构检查全过。范围纪律干净：desktop 仓相对开工快照增量恰为本包 8 文件，零意外。无 P0/P1/P2；新发现 P3×1（测试质量）＋P4×3（留痕强度），均不阻塞。

---

## 一、R1 发现 F1-F8 关闭表（逐项证据）

| # | R1 发现 | V2 处置 | 判定 | 核对证据 |
|---|---|---|---|---|
| F1 | 红灯留档缺（M3） | 删模块复红法留档 | **已关闭（附注①②）** | `红灯-删模块复红.log` 确为两文件加载失败全红：`Cannot find module '../../electron/platform/dead-pipe'`＋`Cannot find module '../../contracts/session-lock-notice'`，各自栈指向两 spec 的 import 行；尾部 `Error: No tests found` 表明该跑只点名两份原 spec（第三份未入参，当时或尚未存在），与 V2 记录「两份 spec 全红」口径一致。恢复与复绿未录进 log 本身，由 V2 记录第五节声明（恢复后 20/20＋git status 回 `??` 原态）；本审核现状核对成立：两文件在位且 `??`、自跑 20/20 绿。定性核对：V2 如实称「删模块复红法」「贴近 V1 实际红形态」，未拔高为行为级红——该形态是最弱红（仅证明测试-模块连线，不区分行为断言），V2 亦未拿它冒充新行为红（唯一新行为 F8 另有真红） |
| F2 | 事件级守卫单测（M1） | session-lock-notice.spec +2 测（:185、:216） | **已关闭（附保留，见新发现 P3-1）** | 覆盖齐：非 error 级（info/warning）、非 notify kind（confirm/select）、消息未变同一性（`toBe` miss 例）、命中返新对象（`not.toBe`）且原事件不被原地改（`original.request` 复核）。断言全部测公开行为——返回值身份与内容、入参不可变，无内部状态镜像；app-store 接线点（:3606）调用的正是被测函数。保留：四条守卫断言均传 `paoHome=undefined`，守卫被删时这些断言仍绿（区分力缺口，详见发现 P3-1） |
| F3 | 确认取消路径两层（M2） | 纯函数提取＋单测＋真实 dismiss 腿 | **已关闭** | ①提取合理性：`handleSessionTakeoverClick` 在生产组件 `takeOver()` 内真实接线（timeline-item.tsx:289-298），window.confirm 与 `submitComposer` 接线留组件侧——决策核（confirm/alreadySubmitted/submit）与副作用分离，非测试专用通道；②单测层：取消→`commands=[]`＋`submitted=false`（spec:36-40）；③真实层：归档脚本 `s12-session-lock-takeover-v2.verify.spec.ts` 第四段 `dialog.dismiss`→等 8 秒窗口→报错行 `count===1`（无误提交回显）、锁 token 未变、按钮仍 Enabled（截图 2），断言无提交成立。两层齐 |
| F4 | token 命中但记录无效分支（M4） | test 6 改固定 token | **已关闭** | 现用例（spec:90-107）以固定 TOKEN 写 `partial.json`（`{token: TOKEN, pid: "not-a-pid"}`）并以同 TOKEN 查询→`toBeUndefined`：真实踩到「token 命中但 isOwnerRecord 失败→undefined」分支（session-lock-owner.ts:64），且有区分力（若校验被删、返回无效记录，用例红）。R1 指出的「两个 randomUUID 实走不匹配路径」缺陷已消除。钉子属性登记属实（分支 V1 代码即有） |
| F5 | 契约复制型钉定漂移（M5） | 注释互指 | **已关闭（处置可接受）** | 双点落位：dead-pipe-boundary.spec:9-13 注明内核正本路径＋「本地复刻钉定——内核改集合措辞不会使本用例变红，改内核时须两处同步」；session-lock-notice.spec:22-26 同（notify 包装＋三段文案正本＋「有意不建跨仓校验」）。可接受性判定：跨仓运行时校验需 unit lane 读内核仓源码（路径脆弱、任务书禁动内核仓），两轮 R1 审核已实证三方字串一致，漂移风险以双点注释显式登记而非隐藏——注释互指是此约束下的合理选择。残余风险（内核变更不红）属复制型钉定固有属性，已如实显影 |
| F6 | 单测输出栈噪音（M6） | 吸收日志单行化 | **已关闭（自跑实证）** | 本审核合跑实录 test 4 输出恰一行：`[main] ignored dead-pipe error: EPIPE synthetic EPIPE (at errWithCode (...dead-pipe-boundary.spec.ts:20:24))`，无多行栈。实现（dead-pipe.ts:49-57）取 stack 首帧拼单行、try 包裹写失败回流流边界，与决策笔记「stack 只作诊断线索不归因」一致 |
| F7 | 无效 ISO 回退未测（M7） | 一行用例 | **已关闭** | spec:167-171：`acquiredAt:"不是ISO时间"`→断言含「持有自 不是ISO时间」，有区分力（回退分支被删将渲染 Invalid Date/NaN 串） |
| F8 | 连点无钉（M8／对抗式 P3-3） | 红→绿＋守卫＋禁用 | **已关闭** | 红灯-连点禁用.log＝干净红：仅第 3 测「连点防护」败（`Received ["/pao runtime takeover 39c64f0e-…"]` vs `Expected []`），前 2 测过——失败面恰为新行为本身。实现三件套：`alreadySubmitted` 守卫（timeline-item.tsx:58）、提交成功后 `setTakeoverSubmitted(true)`（:299-301）、`disabled={takeoverSubmitted}`（:312）。真实层：V2 验证脚本第五段 `toBeDisabled` 程序化断言＋截图 3。红→绿链完整（附注③） |

附注：
① F1 的「删模块复红」红形态下 log 未捕获退出码行，V2 声明 EXIT=1 与日志内容（两模块加载失败）相符，但退出码本身未留痕（P4-1）。
② 「恢复后复绿」无独立 log 段，采信 V2 记录声明＋本审核现状核对（文件回位＋20/20 自跑绿）。
③ F8 红版 spec 行号较现行 +3（失败帧 test 位于 :51:5／断言 :53:20，现行 :48:5／:50:3），两早测名与失败断言文本与现行逐字一致，判为注释级编辑；文件 untracked 无法逐字节核（P4-2）。

---

## 二、新增用例逐条判定（14→20 的 6 条）

构成核对：dead-pipe-boundary 6（不变）＋session-lock-notice 11（8+3）＋session-takeover-button 3（新增）＝20。行数：dead-pipe spec 121→125（+4＝F5 头注扩展，非断言）；session-lock-notice spec 158→255（+97＝M7 一测＋M1 两测＋hostEvent 助手＋M4/注释−readFile 尾行）；takeover spec 新增 52 行。

| 用例 | 断言面 | 判定 |
|---|---|---|
| M1 守卫测（notice:185） | info/warning/confirm/select 四例 `toBe(原事件)` | 钉住现行为成立、断言公开行为；**区分力缺口**：`paoHome=undefined` 使守卫删除不可测（见 P3-1）；非凑数 |
| M1 同一性测（notice:216） | 查无 token→`toBe(miss)`（真 home，有区分力）；命中→`not.toBe`＋`toMatchObject`（kind＋message containment）＋原事件 message 复核 | 合格；`toMatchObject` 属部分匹配，但全串钉定由消息层用例（:63 幂等、:126 containment）覆盖，不构成放宽 |
| M7 回退测（notice:167） | 无效 ISO 原样回显 containment | 独立回退分支，一行不凑数 |
| takeover 取消（button:36） | `commands=[]`＋`submitted=false` | 公开行为、有区分力 |
| takeover 确认（button:42） | `toEqual([命令串])` 精确单条 | 精确断言，与 F8 测不重复（提交一次 vs 不重复提交） |
| F8 连点（button:48） | 已提交再点→不发＋返回 false | **唯一真红→绿**，区分力由红灯日志实证 |

重复断言面检查：takeover 三测钉的是此前零覆盖的点击策略表面；M1 钉事件级（此前仅消息级）；M7 钉回退分支——无重复、无凑数。jsx-runtime shim 沿 canvas-node-detail.spec 既有同款，测的是导出纯函数的公开行为。

**对既有 14 条的改动核对**：V1 spec 无留档副本（untracked 无 git 历史），逐字节 diff 不可得；采「R1 引证 × V2 声明 × 现文件」三角核对——TDD-R1/过度设计-R1 对 V1 8 测主题的描述与现行 test 1-8 逐一吻合；唯一断言级改动＝test 6 的 M4 固定 token 改写（钉既有行为，修前即绿，已按钉子属性如实登记）；其余为 F5 注释与删 readFile 尾行（过度设计纯建议②）。dead-pipe 6 测仅头注扩展。**未发现声明外断言改动**（证据强度低于 diff，P4-3 登记）。

钉子属性登记核对（V2 第五节）：M1×2、M2 取消钉、M4、M7、确认提交钉＝补测即绿，F8 连点＝真红→绿——与证据吻合，登记如实无拔高。提取本身属无行为变化的重构（取消/提交行为 V1 内联即有），不需要红，V2 未虚构成红。

---

## 三、发现清单（R2 新增）

**P0/P1/P2：无。**

- **P3-1（测试质量，M1 守卫测区分力缺口）**：session-lock-notice.spec:185 四条守卫断言均以 `paoHome=undefined` 调用，而 `enrichSessionLockOwnerMessage` 对 undefined paoHome 短路返回原文——即使删掉 `enrichSessionLockOwnerEvent` 的 kind/level 守卫，四条 `toBe` 仍绿；全套件无用例能在守卫被删时变红（需真实 home＋匹配锁记录＋非 error/非 notify 事件组合）。该守卫实际承重：生产 paoHome 恒配置，select/confirm 事件无 message 字段，守卫被删（且绕过类型检查）时富化会对 undefined 调 `parseResidualSessionLockToken` 抛错、打断事件处理。建议一行补强：守卫例中 info 一腿改传含匹配锁记录的真实 home（守卫在→`toBe(info)`；守卫删→返回新对象→红）。不阻塞：现行为已钉住，回归属未来风险。
- **P4-1（留痕）**：两份红灯日志均未捕获退出码行，「EXIT=1」为 V2 记录声明；日志内容与失败一致。
- **P4-2（留痕）**：F8 红版 spec 与现行版本行号差 3 行（untracked 无法逐字节归因；失败帧断言文本与现行逐字一致，判注释级编辑）。
- **P4-3（留痕）**：V1 spec 无留档副本，既有 14 条改动核对采三角法，证据强度低于逐字节 diff。

建议（不计发现）：自下包起，新 spec 修前版本随手留档（或红灯 log 附 `git stash`/副本），可一并消 P4-2/P4-3；M1 守卫例按 P3-1 建议补一腿真实 home。

---

## 四、自跑复验（命令与退出码）

隔离：`PAO_HOME=D:\AI\workspace\临时文件夹\S1-2包2审核R2-20261007\pao-home`＋`PI_OFFLINE=1`＋`PI_NO_LOCAL_LLM=1`。

| 门 | 命令（cwd 另有注记者除外） | 结果 |
|---|---|---|
| 三 spec 合跑 | `npx playwright test -c playwright.config.ts tests/unit/dead-pipe-boundary.spec.ts tests/unit/session-lock-notice.spec.ts tests/unit/session-takeover-button.spec.ts`（cwd=desktop/apps/desktop） | **exit 0，20/20 passed（1.6s）** |
| tsc app | `npx tsc -p tsconfig.json --noEmit`（cwd=desktop/apps/desktop） | exit 0 |
| tsc electron | `npx tsc -p tsconfig.electron.json --noEmit`（cwd=desktop/apps/desktop） | exit 0 |
| 架构检查 | `pnpm run check:architecture`（cwd=desktop 仓根） | exit 0（4 项全过，日志留档 R2-架构检查.log） |

口径注明：**未跑 unit lane 全量与 core e2e**（慢链移尾部；unit lane 16 败族归属采信对抗式 R1 关沙箱复跑数据＋S0 基线档逐 spec 对照，未三次复跑）。真实 Electron 两腿未重复执行（V2 已留证 1 passed＋3 截图，本审核核对其脚本断言面与记录一致）。

---

## 五、范围纪律与触碰文件

- desktop 仓 git status 与开工快照 desktop 段精确对照（程序化 diff）：相对增量恰为本包 8 文件——V1 新增 5（dead-pipe.ts、session-lock-notice.ts、session-lock-owner.ts、dead-pipe-boundary.spec.ts、session-lock-notice.spec.ts）＋V1 新改 2（timeline-item.tsx、timeline.css，快照时未 M）＋V2 新增 1（session-takeover-button.spec.ts）；**零意外新增、零删除**。main.ts/app-store.ts/i18n-zh.ts 为快照时已 M 共享文件；其余 M/?? 全部与快照一致（并行包面未变）。
- 内核 PAO 仓：`session-lock.ts`、`runtime/index.ts` 不在改动面；`worker/lock.ts` 为快照前既有 M（diff 为中文标识符迁移，零 pipe/takeover/desktop 关联字）——V2「零触碰」声明成立。
- 开发根仓：`.agents/notes/implemented/2026-10-07-桌面dead-pipe全局吸收腿决策.md` 新增（在位，内容与 dead-pipe.ts 头注一致）；无代码改动。
- 无 git add/commit/push 痕迹；全程零付费模型调用。

触碰文件 SHA-256（本包 V1+V2 全集，2026-10-07 审核时点）：

| 文件 | SHA-256 |
|---|---|
| desktop/apps/desktop/electron/platform/dead-pipe.ts | 8e43223c9fd5a1768159972eae6e27e02bdac6a65ac95427a8ed1df36f86b2df |
| desktop/apps/desktop/contracts/session-lock-notice.ts | 94b9a280a81c84d484386c34ffaad0ed564b5593c6b7392610886bc5e1c5ec97 |
| desktop/apps/desktop/electron/platform/pao/session-lock-owner.ts | c4267bbdf9d525754f5eedfca2c3da6da0bea60bf002f9e73fe2c94110c70df4 |
| desktop/apps/desktop/src/features/conversation/timeline-item.tsx | 1acfcd9c2b79dddd309e7e60bbe734c4e0dc9b74b72a86a2cd6cf365285e4a28 |
| desktop/apps/desktop/src/styles/timeline.css | 6a38025a276f85fbea5963272165d8365bf3360d429a56837fb575009c2d4e63 |
| desktop/apps/desktop/tests/unit/dead-pipe-boundary.spec.ts | 2a016777f84dd2e5875fc7194562f89a16a85fb765aeaf28e06f54f820ea858d |
| desktop/apps/desktop/tests/unit/session-lock-notice.spec.ts | d7c4b8b987cbaea6f1f37ca09383e066a29ac86ebd1478b362e31e5ceeec9975 |
| desktop/apps/desktop/tests/unit/session-takeover-button.spec.ts | 16785725fe16f9bb5147f866aa5356d8f1bcca14dee4b0166a00fc18142c1b82 |
| desktop/apps/desktop/electron/main.ts（V1 触碰，共享 M） | 961cbe052d2b8c9f16718d820cf9d35ecfb3940c7bf3df2898b1c529eb37b794 |
| desktop/apps/desktop/electron/application/app-store.ts（V1+V2 触碰，共享 M） | 9306533fdd17ce695f87f7d1626ace9208251a24b7351a0dc15077092416c414 |
| desktop/apps/desktop/contracts/i18n-zh.ts（V1 触碰，共享 M） | a08be581a5991a45a586cd87b287920d385d203ee4e34708dd148e5f2bc3b7c9 |
| .agents/notes/implemented/2026-10-07-桌面dead-pipe全局吸收腿决策.md | 01a4c487add5859fde8eeb2c81968320bf5617060fe7610ef7409447d7dcc1bf |

---

## 六、审核者动作留痕

- 读：根/desktop AGENTS.md、实施记录 V1+V2、四份 R1、6 个源文件全量、3 份 spec 全量、2 份红灯日志、V2 接管验证日志＋归档脚本、决策笔记、开工快照 desktop/PAO 段。
- 跑：第四节 4 项（日志留档 `临时文件夹/S1-2包2审核R2-20261007/`）；F6 噪音以合跑实录单行输出实证；PAO 仓 worker/lock.ts diff 抽验。
- 写：仅本报告。
