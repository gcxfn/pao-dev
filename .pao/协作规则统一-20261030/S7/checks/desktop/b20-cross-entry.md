# B20 桌面侧对表证据：同一停因，桌面读面 / 内核读面 / CLI 侧三方一致

- 采集时间：2026-11-01（Asia/Shanghai）
- 采集人：Agent Team 成员 `desktop`（S7 桌面与发行）
- 对照伙伴：`boundary`（CLI 侧，`pao_query_flow` / `/pao flow see` / 内核纯函数 `projectControlStop`）
- 被测对象：真实 Electron（`apps/desktop` 开发构建，Playwright `_electron` 驱动）＋ 内核 `PAO/packages/coding-agent/dist`（Lead 2026-11-01 重建的 bundle 同源）
- 隔离：独立 PAO_HOME（`s7\desktop\pao-home`）、独立 user-data、独立 TEMP；假凭证；fixture 不派发部长、不调模型，因此全程无外网、无付费供应商
- 覆盖停因：`manual_pause`（人工暂停）、`recovery_required`（关闭/异常恢复类）；`decision`、`terminal_block`、`legacy_unknown` 未由桌面侧构造（见 §7）

## 1. 口径

同一个隔离项目里，用内核公开 API 造出真实停因，然后三方取数：

- **桌面读面**：`window.piApp.getWorkflowControl({ workspaceId, instanceName, instancePath })`
  → preload `apps/desktop/electron/preload.ts:245` → IPC `apps/desktop/electron/ipc/register-desktop-ipc.ts:363`
  → `apps/desktop/electron/platform/pao/flow-control-query.ts`（`normalizeFlowControl` L135 / `normalizeStop` L87）
  → 桌面桥 `desktop/packages/pi-sdk-driver/src/pao-flow-control.ts:113-123`（`readDesktopFlows: readDesktopFlowsFresh`）
- **内核读面**：`PAO/packages/coding-agent/dist/pao/desktop/workflow.js` 的 `readDesktopFlowsFresh(project)`（脚本直接 import；`boundary` 的 `test/pao/workflow-stop.test.ts:198` 用的是同一函数）
- **CLI 侧**：内核纯函数 `projectControlStop`（`src/pao/workflow/policy.ts:50-75`）的输出，`pao_query_flow` 与 `/pao flow see` 共用同一投影（`workflow-tools.test.ts:1174` 断言两者渲染逐字一致，本轮实跑 46 passed / exit 0）

## 2. 停因 fixture（由内核 API 产生，不是手改文件）

`b20-parity.mjs` 的 fixture 子进程用内核 `dist/pao` 的 `workflow/plan.js` + `workflow/control.js`：

1. `createTemporaryPlan`（显示名「B20 对表」、请求 ID `b20-parity`、步骤「对表步骤」）
2. `resolvePlanExecution`
3. `startControl`（owner = `b20-parity-owner-session`）
4. `recordPlanStart`（受理时刻 2026-11-01 16:10）
5. 停因二选一：
   - `manual_pause`：`pauseControl(execution.配方, options, "B20 对表：人工暂停")`
   - `recovery_required`：`pauseControlIfUnpaused(execution.配方, options, "任意关闭提示")`（关闭/异常共用保守入口，`control.ts:1914`）

## 3. 对照表 A：`manual_pause`（10/10 相等，两轮均为扩展后检查集）

| # | 字段 | 桌面读面（IPC） | 内核读面（`readDesktopFlowsFresh`） | CLI 侧（`projectControlStop` 投影） | 相等 |
|---|---|---|---|---|---|
| 1 | 实例 | `9bf880df-…` | 同左 | 同左（同一控制正本） | ✅ |
| 2 | owner | `b20-parity-owner-session` | 同左 | 同左 | ✅ |
| 3 | 停因.category | `manual_pause` | `manual_pause` | `manual_pause`（枚举见 `policy.ts:32-41`） | ✅ |
| 4 | 停因.reason | `B20 对表：人工暂停` | 同左 | 原样透出，逐字不改写（`...structuredClone(stop)`） | ✅ |
| 5 | 停因.authority | `human` | `human` | `human`：`actionable = category==="decision" && …`，manual_pause 恒非 actionable → authority 恒 `human`（`policy.ts:59-66`） | ✅ |
| 6 | 停因.actions | `["resume"]` | `["resume"]` | `["resume"]`：非 actionable 一律 `["resume"]`（`policy.ts:67-72`） | ✅ |
| 7 | deadline | 无 | 无 | 无（只有 actionable 才附，`policy.ts:73`） | ✅ |
| 8 | pauseReason | `B20 对表：人工暂停` | 同左（`控制.暂停`） | 同左（CLI 渲染 `控制.暂停`） | ✅ |
| 9 | 裁定（负向） | `undefined` | `undefined`（`控制.裁定`） | `undefined` | ✅ |
| 10 | 脚本声明停因 = 两侧 category | `manual_pause` | `manual_pause` | — | ✅ |

脚本输出：`PARITY_SUMMARY checks=10 failed=0`，退出码 0，4.1s（运行 `runs\2026-11-01T08-24-05-736Z`）。

## 4. 对照表 B：`recovery_required`（10/10 相等）

| # | 字段 | 桌面读面 | 内核读面 | CLI 侧（结构性） | 相等 |
|---|---|---|---|---|---|
| 1 | 停因.category | `recovery_required` | `recovery_required` | `recovery_required`（`pauseControlIfUnpaused` 写；`workflow-stop.test.ts:189/203` 断言同类） | ✅ |
| 2 | 停因.reason | `任意关闭提示` | 同左 | 原样透出 | ✅ |
| 3 | 停因.authority | `human` | `human` | `human`（非 decision → 非 actionable） | ✅ |
| 4 | 停因.actions | `["resume"]` | `["resume"]` | `["resume"]`（`workflow-stop.test.ts:210` 断言 `进度.停止?.actions` = `["resume"]`） | ✅ |
| 5 | pauseReason | `任意关闭提示` | 同左 | 同左（`workflow-stop.test.ts:208` 断言 `控制.暂停`） | ✅ |
| 6 | 裁定（负向） | `undefined` | `undefined` | `undefined`（`workflow-stop.test.ts:209` 断言 `控制.裁定 === undefined`） | ✅ |
| 7 | 实例 / owner / 状态 / 声明核对 | 一致 | 一致 | — | ✅ |

脚本输出：`PARITY_SUMMARY checks=10 failed=0`，退出码 0，4.9s（运行 `runs\2026-11-01T08-23-52-873Z`）。

> `boundary` 的关键结构性结论：`manual_pause` / `recovery_required` 在任何运行方式下都是 `authority=human / actions=["resume"]`，不存在「无人值守就能自己放行」的分支；`authority=owner / actions=["rule","resolve_pending"]` 只在 `category==="decision"` 且 pending 未过期、且（无人值守时）才可能出现（`policy.ts:59-72`，`workflow-stop.test.ts:110/126-133` 用 decision 类停因断言了这一点）。所以桌面 10/10 一致是**结构性保证，不是巧合**。

## 5. 桌面侧「只能读、不能自行放行」的证据

1. **代码路径单点**：桌面非测试代码里没有任何 `pauseControl` / `resumeControl` / `confirmControl` 直接调用；唯一改控制正本的入口是 `flow-control-query.ts:297` 的 `await bridge.runDesktopFlowCommand(command.sessionId, project, { ...params })`，即把动作交回内核执行，桌面只做请求关联校验（提交的节点/轮次必须仍是用户所见），owner、理由、实例合法性由内核判定（该文件头注释第 12–15 行写明「不重复业务」）。
2. **停因投影不做默认值兜底**：`normalizeStop`（`flow-control-query.ts:86-87`）要求 category ∈ {decision, manual_pause, recovery_required, terminal_block, legacy_unknown}、authority ∈ {owner, human}、actions ⊆ {rule, resolve_pending, resume}、reason 非空；字段不全或类别未知即**显式失败**，不猜、不补默认值——界面拿不到「可放行」的假停因。
3. **真实 Electron 负向用例**：`apps/desktop/tests/core/f-desktop-owner.spec.ts:301:5`「T15 确认被拒绝时如实报错、不动控制正本，不显示成成功」（EXIT=0，1 passed）——内核拒绝时界面只显示错误，控制正本不变。
4. **桌面读面本身不写盘**：`readDesktopFlowsFresh` 经 `readControlView` 只核当前内容树后返回投影，`flow-control-query.ts` 的 `getWorkflowControl` 分支只 normalize + 返回，不调用任何写入口。

**结论句**：桌面侧对停因只做投影与转发，`normalizeStop` 字段不全即显式失败不猜停因，且无任何绕过内核回执改写控制正本的代码路径——即 B20 要求的「界面不自行放行」。

## 6. CLI 侧数据来源与证据等级

- `boundary` 提供（2026-11-01 消息）：`policy.ts:50-75` 的 `projectControlStop` 是 CLI 渲染与工具渲染共用的纯函数；`pao_query_flow` 与 `/pao flow see` 渲染逐字一致（`workflow-tools.test.ts:1174`，本轮 46 passed / exit 0，日志 `checks\boundary\workflow-tools.log`）；`pao_query_flow` 查询不改控制正本（`workflow-tools.test.ts:486`）；投影逐项断言 `workflow-stop.test.ts:110/126-133` 与桌面同源锚点 `workflow-stop.test.ts:198-210`（22 passed / exit 0，日志 `checks\boundary\workflow-stop.log`）。
- **等级说明**：CLI 侧目前是「结构性同源（同一 `projectControlStop` 函数）＋既有已跑用例」等级；`boundary` 尚未在静默窗口对这两个停因单独跑一次 CLI 逐字渲染取证，补齐后本表 CLI 列可升级为「同停因逐字渲染已跑」。桌面列（本文实测）不受此影响。

## 7. 未覆盖停因与原因

| 停因 | 状态 | 原因 |
|---|---|---|
| `decision`（待决裁定） | 未由桌面侧构造 | 需待决 + 到期/裁定链路；CLI 已用 `workflow-stop.test.ts:110/126-133` 覆盖 authority/actions 两策略差异 |
| `terminal_block` | 未由桌面侧构造 | 只能由「审核拒绝」（`decideNode` reject，`control.ts:1443`）或「回边超限」（`control.ts:1470`）产生，需审核节点 + 拆解结束 + 全部卡 delivered 的完整 fixture；`boundary` 的 CLI 侧已用 `expirePending` 路径覆盖（`workflow-stop.test.ts:177-185`，actions=["resume"]、`writer_stop_confirmed=false`）。桌面投影与 CLI 共用 `normalizeStop`/`controlView`，构造成本高于边际价值，未做 |
| `legacy_unknown` | 未构造 | 需旧文本控制文件迁移场景；`boundary` 侧 `workflow-stop.test.ts:212-222` 已覆盖只读保守查询 |

如需桌面侧补 `terminal_block` 证据，需扩展现有 fixture 为带审核节点的配方（预计新增一个 review fixture），可另行安排。

## 8. 证据文件（绝对路径）

- 总表（本文件）：`D:\AI\workspace\pao-dev\.pao\协作规则统一-20261030\S7\checks\desktop\b20-cross-entry.md`
- 运行日志：`checks\desktop\b20\b20-parity-manual.log`（manual_pause）、`checks\desktop\b20\b20-parity-recovery.log`（recovery_required）、`checks\desktop\b20\b20-parity.log`（首轮 8 项版，保留）
- 脚本：`D:\AI\workspace\临时文件夹\协作规则统一-20261030\s7\desktop\b20\b20-parity.mjs`（`node b20-parity.mjs [manual_pause|recovery_required]` 可重跑；`launch-min.mjs` 为 Electron 启动最小复现）
- 原始数据（每次运行新建）：
  - manual_pause：`...\b20\runs\2026-11-01T08-24-05-736Z\`（fixture.json、desktop-read.json、kernel-read.json、parity.json、desktop-control.png）
  - recovery_required：`...\b20\runs\2026-11-01T08-23-52-873Z\`
- 隔离环境：PAO_HOME=`s7\desktop\pao-home`、user-data=`runs\<ts>\user-data`、TEMP=`s7\desktop\tmp`；桌面构建 `D:\AI\workspace\pao-dev\desktop\apps\desktop\out`（11/01 16:00:33）

## 9. 环境事故记录（与本对表无关但影响复现）

1. `electron.launch` 首轮全部失败：宿主注入 `ELECTRON_RUN_AS_NODE=1` 使 electron.exe 以 Node 模式运行（`--version` 打 v22.21.1），Playwright 的 `--remote-debugging-port=0` 被当 Node 选项拒绝。已在运行器剥离该变量并在日志头部打印 `ELECTRON_RUN_AS_NODE=[]` 与 `v37.10.3` 复核。
2. 本对表脚本首轮超时：`args`/`cwd` 误用仓库根 `desktop` 而非应用目录 `apps/desktop`，Electron 找不到 app main 永不 ready（user-data 为空、`<ws connected>` 后停在 `Debugger attached.`）。修正后启动 1.3s、对表 4.8s。
