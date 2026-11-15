# S1-2 包2 TDD 审核 R1（独立只读）

日期：2026-10-07。审核对象：desktop EPIPE 断管边界＋会话锁显式接管（V1 首轮）。
审核者自跑环境：隔离 `PAO_HOME=D:\AI\workspace\临时文件夹\S1-2包2-审核-pao-home-20261007`＋`PI_OFFLINE=1`＋`PI_NO_LOCAL_LLM=1`。

## 结论

**TDD 通过（有保留，P2×3＋P3×5，无 P0/P1）。**
绿已独立复核（14/14 自跑全绿）；覆盖面在单测可及范围内良好、契约钉定合格、真实验证与单测分工声明如实、未发现包2 改既有测试断言。保留点：红灯证据未留档（仅记录文字声明）、实际接线的事件级富化函数无单测、确认弹窗取消路径零层覆盖。

## 一、红绿对应表（含自跑）

| 用例组 | 红阶段（记录声明） | 性质判定 | 绿（自跑 2026-10-07） |
|---|---|---|---|
| dead-pipe-boundary.spec.ts ×6 | 模块不存在全挂（Cannot find module dead-pipe） | 新模块 TDD 合法红；断言区分力逐条推演成立：不注册监听→`emit("error")` 抛（test2 红）；吞非断管→test3 rethrow 断言红；转发 EPIPE→test4 红；dispose 失效→test6 红 | **6/6 ok**（991ms 总批） |
| session-lock-notice.spec.ts ×8 | 模块不存在全挂（Cannot find module session-lock-notice） | 同上；解析/命令/格式化/幂等/读取各用例对错误实现均有区分力 | **8/8 ok** |
| 合计 | 14 挂＝红灯成立（声明） | — | **14/14 passed**（本轮自跑；记录另声明 unit lane 511 过/3 skip，lane 全量未在审核内复跑，仅登记） |

红证据缺口见发现 F1。

## 二、逐项核验

1. **红→绿**：红仅存在于实施记录文字（第 28 行），无留档日志——包1 同批有 `红灯-*.log` 惯例，包2 未沿用。性质判定：「模块不存在」是新模块 TDD 的合法红（最弱形式），已用断言推演补强其合法性（见上表）。
2. **自跑绿**：两文件 14/14 通过（命令与隔离变量见文首）。注：test4 输出中泄漏一个带 EPIPE 栈的错误打印（吸收路径内部 `console.error` 所致，测试仍 ok，见 F8）。
3. **覆盖面**：见第三节清单。EPIPE 侧三 errno×双流、非断管呈现与路由、同边界混合、uncaughtException 两形态、dispose 均已钉；接管侧富化字段、活锁/查无/无 PAO_HOME 原文返回、真实临时锁文件读取、字段同构均已钉。
4. **公开行为 vs 实现镜像**：合格。断言钉的是命令字面（内核 slash 契约 `/pao runtime takeover <token>`）、详情 containment（不锁全串）、幂等行为、记录字段集与内核 SessionOwner 同构（`Object.keys` 对比）。两处轻度实现触碰均可接受：`listeners("error").at(-1)` 取处理器直调（测 rethrow 的唯一可行法）、`process.listenerCount` 前后计数（公共 API）。无业务内部状态镜像。
5. **真实验证与单测分工**：**如实**。单测管纯契约＋主进程读取器；真实 Electron 验证（证据 `证据/EPIPE-*/`、`证据/接管-*/`，脚本归档 `归档脚本/`，两日志各 1 passed）补 OS 级真断管（销毁读端＋杀 launcher，探针实录 `EPIPE,EPIPE`、`alivePid===mainPid`）、错误框可见性、按钮→确认→锁文件换主全链路。归档脚本自述「非 EPIPE 腿用 process.emit 走同一监听链，验证接线与可见性」——没有把驱动受限的腿冒充真未捕获异常验收；实施记录未验证项 5 条如实登记。契约字串经审核者今日核对与内核一致：`PAO\packages\coding-agent\src\pao\runtime\session-lock.ts:44-48`（三段文案）＋`src\pao\runtime\index.ts:79`（notify 包装）＋`src\modes\interactive\interactive-mode.ts:290`（DEAD_TERMINAL_ERROR_CODES）。
6. **既有测试零改动**：两 spec 均为新增 untracked（git status `??`）。工作区既有测试文件的改动（composer-controls/stop-running-prompt/workbench-tabs/canvas-node-detail/canvas/ipc-request-validation/pao-home/persisted-data/workbench-persistence/workflow-wizard）经 diff 内容归属核查：均为并行包范围（submitChannel→sessionControl 改名、持久化 version 19→20、Max 按钮名、canvas/wizard 用例），**零 hunk 涉及 dead-pipe/session-lock/takeover**；包2 声明清单不含任何既有测试文件。注：desktop 仓全树未提交，归属按 diff 内容判定而非 git 权威，如实说明。

## 三、缺失测试清单（分级）

### P2（建议本包收尾或紧邻后续包补，均为单测/core lane 可补）

| # | 缺失测试 | 触发行为（回归后果） | 补法 |
|---|---|---|---|
| M1 | `enrichSessionLockOwnerEvent` 事件级守卫（实际接线进 app-store 的就是它，单测只测了 message 层） | 非 error 级 notify、非 notify kind 被误富化；或 message 未变时未返回同一事件对象（身份破坏影响下游 coalesced emit） | 纯单测：构造 hostUiRequest 各 kind/level 各一例＋原文返回时对象同一性断言 |
| M2 | 确认弹窗取消路径：window.confirm 拒绝→不发 submitComposer | 用户点取消仍发出接管命令；两层（单测/真实）现都只覆盖接受腿（真实脚本 `dialog.accept()`） | core lane：`dialog.dismiss`＋断言 composer 无提交 |
| M3 | 红灯证据留档（流程项） | TDD 红阶段不可独立复核，本轮采信记录文字 | 后续包沿用包1 `红灯-*.log` 惯例；本包可补跑一次「删模块复红」留档（成本极低） |

### P3（登记不要求）

| # | 缺失/瑕疵 | 说明 |
|---|---|---|
| M4 | 「token 匹配但字段无效」分支未钉：`partial.json` 写入的 token 与查询 token 是两个不同 `randomUUID`，实际走「不匹配 continue」路径；`readSessionLockOwnerByToken` 里 token 命中但 `isOwnerRecord` 失败返回 undefined 的分支无测试（若回归为返回无效记录，会把 `pid:"not-a-pid"` 富化上屏） | 改用固定 token 命中即可钉住 |
| M5 | 口径一致性靠硬编码复刻：DEAD_PIPE_ERROR_CODES 断言字面集合、kernelResidualNotice 是本地复刻文案——内核措辞/集合变更不会使本测试红（漂移型钉定）。今日已核对三方一致 | 可加跨仓一致性校验或注释互指；不阻塞 |
| M6 | 断管吸收路径 `console.error` 把带栈错误对象泄进 unit lane stderr（审核自跑 test4 实录，测试仍 ok；真实壳内该写失败会回流被流边界吸收，属设计内「尽力记录」） | 可捕获 console 或降为无栈 message，纯净化 |
| M7 | `formatAcquiredAt` 无效 ISO 回退原串分支未测 | 一行用例 |
| M8 | 接管按钮双击连点无防伏/无钉 | 第二发命令会走内核「错误 owner 拒」显式失败（真实验证已覆盖拒绝腿），正确性有内核保护，风险低 |

## 四、发现汇总（P0-P3）

- **P0/P1：无。**
- **P2**：F1＝红灯证据未留档（＝M3）；F2＝`enrichSessionLockOwnerEvent` 无单测（＝M1）；F3＝确认取消路径零层覆盖（＝M2）。
- **P3**：F4＝token 命中但记录无效分支未钉（＝M4）；F5＝契约复制型钉定漂移风险（＝M5）；F6＝单测输出噪音（＝M6）；F7＝无效 ISO 回退未测（＝M7）；F8＝连点无钉（＝M8）。

## 五、审核者动作留痕

- 自跑：`npx playwright test -c apps/desktop/playwright.config.ts apps/desktop/tests/unit/dead-pipe-boundary.spec.ts apps/desktop/tests/unit/session-lock-notice.spec.ts`（隔离 PAO_HOME）→ 14 passed（991ms）。
- 交叉核对：dead-pipe.ts / session-lock-notice.ts / session-lock-owner.ts / main.ts:109-119 / app-store.ts:3606 / timeline-item.tsx:258-291 / i18n-zh.ts:1098-1101；内核三文件字串一致；证据目录两腿截图与 flag 齐全；两验证日志各 1 passed。
- 本审核未修改任何被审核文件；仅写入本报告与审核用临时 PAO_HOME（`临时文件夹/S1-2包2-审核-pao-home-20261007`）。
