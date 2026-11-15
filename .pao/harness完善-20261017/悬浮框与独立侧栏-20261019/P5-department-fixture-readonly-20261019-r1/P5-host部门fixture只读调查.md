# P5 生产部门 fixture 失败只读调查

## 结论

`V04 已读甲部门工人切乙部门或乙主控后不残留甲记录` 的失败不是运行时计划查询读错目录，也不是刷新缓存、重开窗口或计划注册状态造成的。actual 运行中，来源甲的 PAO 主会话实际登记在工作区乙；真实内核却把来源甲的计划写在工作区甲。页面按当前来源会话所属工作区乙调用临时计划查询，因此只能返回空列表，并显示“当前会话尚无 PAO 计划”。

最小建议：由 P5 在生产测试的线程准备处复用现有 `createNamedThread` 的 `workspaceName` 选项，将来源甲明确创建在工作区甲。若乙主控要验证“乙部门/乙主控独立记录”，应同时明确把来源乙创建在工作区乙，并从乙工作区创建或注册其计划。这个改动只落在 P5 已拥有的生产测试；未发现需要改产品查询或 host 权限。

## actual 运行与源码版本对齐

- 原 JSON 报告是 `production.log`，报告内用例起始行 `1181`、失败位置 `1235`，时间为 `2026-10-19T09:28:07.631Z`。
- 当前工作树 [packaged-side-chat.spec.ts](D:/AI/workspace/pao-dev/desktop/apps/desktop/tests/production/packaged-side-chat.spec.ts) 的对应用例从 `1191` 起、断言在 `1245`，与报告有固定行偏移。原 trace 的堆栈行号与报告一致，说明报告跑的是当前 manifest/spec 结构附近的版本，不能拿当前已编辑文件的行号替代 actual 行号。
- 失败内容为 5 秒重试 9 次，`task-status-todos` 收到 `当前会话尚无 PAO 计划`，期望 `DEPARTMENT_LONG_GOAL`。

## 真实临时目录与身份证据

按 actual 起始时间锁定真实 userData：

`C:\Users\ASUS\AppData\Local\Temp\pao-packaged-department-switch-aP9Qnp`

该目录创建于 `2026-10-19T09:28:07.644Z`，与 actual 用例起始时间相差约 13 毫秒。没有用后来或其他运行的同前缀目录代替它。

### 工作区

- 工作区甲：`C:\Users\ASUS\AppData\Local\Temp\pi-gui-workspace-kF8ZiB\packaged-department-switch`
- 工作区乙：`C:\Users\ASUS\AppData\Local\Temp\pi-gui-workspace-7scKKx\packaged-department-switch-b`

真实 `catalogs.json` 将两个 workspace 都登记正确；也登记了两个 PAO 主会话，但两个会话的 `workspaceId` 和 `sessionRef.workspaceId` 都是工作区乙：

- 来源甲：`01a1537d-6bba-76f7-9430-6acad2e51a09`
- 来源乙：`01a1537d-79b9-76f7-9430-6acd92aa1eee`

两个实际 session JSONL 都位于 `agent\sessions\--C--Users-ASUS-AppData-Local-Temp-pi-gui-workspace-7scKKx-packaged-department-switch-b--\`，首行 `cwd` 也都是工作区乙。actual 结束时 `ui-state.json` 的 `selectedWorkspaceId` 是乙、`selectedSessionId` 是来源甲。

### 计划与来源

工作区甲真实落盘：

- `p-20261019-fb7bf7\计划.md`
  - `项目根`：工作区甲
  - `来源会话`：来源甲 `01a1537d-6bba...`
  - 长目标位于步骤 `s1`
  - 含真实计划执行实例、卡、部长与工人会话、执行映射
- `p-20261019-1d5683\计划.md`
  - `项目根`：工作区甲
  - `来源会话`：来源乙 `01a1537d-79b9...`
  - 显示名 `乙主控部门隔离`

工作区乙的 `.pao` 目录不存在。也就是说，页面当前指向乙时看不到甲目录里的来源甲计划。

真实内核 fixture 的 `in_progress -> delivered`、卡状态和执行记录均已成功写入工作区甲；失败发生在这些成功之后的界面查询断言，不是内核计划生成或状态转换失败。

## 调用链

1. `TaskStatusRail` 从当前选中会话取得 `workspaceId` / `sessionId`，并在刷新时调用 `api.getTemporaryPlans({ workspaceId })`。见 [task-status-rail.tsx](D:/AI/workspace/pao-dev/desktop/apps/desktop/src/features/task-status/task-status-rail.tsx:85) 和 [task-status-rail.tsx](D:/AI/workspace/pao-dev/desktop/apps/desktop/src/features/task-status/task-status-rail.tsx:107)。
2. IPC 端仅用 `workspaceId` 通过已登记 workspace 表解析项目路径，再查询临时计划。见 [register-desktop-ipc.ts](D:/AI/workspace/pao-dev/desktop/apps/desktop/electron/ipc/register-desktop-ipc.ts:386)。
3. 计划列表随后按 `sourceSessionId === sessionId` 过滤。来源甲虽与 session id 匹配，但查询的项目根是乙，因此列表本身为空。见 [task-status-rail.tsx](D:/AI/workspace/pao-dev/desktop/apps/desktop/src/features/task-status/task-status-rail.tsx:140)。
4. 当前生产用例在 `createNamedThread(window, DEPARTMENT_OWNER_A)` 和 `createNamedThread(window, DEPARTMENT_OWNER_B)` 时都没有传 `workspaceName`。helper 在没有名称时使用当时的 `selectedWorkspaceId`。见 [packaged-side-chat.spec.ts](D:/AI/workspace/pao-dev/desktop/apps/desktop/tests/production/packaged-side-chat.spec.ts:1209) 和 [electron-app.ts](D:/AI/workspace/pao-dev/desktop/apps/desktop/tests/helpers/electron-app.ts:2156)。
5. actual trace 的两次 `createNamedThread` evaluate 调用也都显示请求参数没有任何指定 workspace；第二次建线程后来源甲已最终落在乙。随后刷新请求沿用当前来源甲的乙归属。

同文件的既有恢复等用例已经使用 `{ workspaceName: basename(workspaceA) }`，说明无需新增入口。

## 刷新、重开与注册判断

- 刷新：无效。它只重新查询当前来源会话绑定的 workspace，不会改变 workspace 归属。
- 关闭重开：无效。`catalogs.json` 已把来源甲持久绑定乙，重开仍恢复乙。
- 重新注册计划：无效。计划已在真实工作区甲合法注册，且实际执行成功；问题是主会话不在甲。
- 正确入口：在建线程时就指定目标 workspace。P5 可在原生产用例中使用：
  `createNamedThread(window, DEPARTMENT_OWNER_A, { workspaceName: basename(workspacePath) })`。
  乙主控按用例意图指定乙；其计划也应在乙工作区由真实内核入口创建，才能与来源主会话的项目根一致。

## 边界与错误归因

这是生产验收 fixture 的准备工作区入参错配，属于当前生产用例失败原因，不是本轮 side-chat 产品功能代码新增的缺陷；没有证据表明 `getTemporaryPlans` 的 workspace 解析、source-session 过滤、refresh 或 Electron 权限门控实现错误。真实内核 fixture 成功这一事实也不能替代对产品 UI 查询链的验证；只有修正 fixture 后重跑 actual，才能证明后续部门面板和隔离断言。

## 证据文件

本目录保留：

- `original-test-failed-1.png`：原 actual 失败截图，复制自 P5 原始 production-output。
- `original-trace.zip`：原 actual Playwright trace，复制自同一原始目录。
- `production.original.log`：原 JSON 报告副本。
- `source-a-plan.md`、`source-b-plan.md`：真实工作区甲的计划副本。
- `actual-catalogs.json`、`actual-ui-state.json`：真实 userData 的会话与选中状态副本。
- `source-a-session.jsonl`、`source-b-session.jsonl`：真实 session JSONL 副本，含实际 `cwd`。
- `trace-key-events.log`：从原 trace 提取的建线程、刷新、选中会话与失败事件。
- `actual-workspaces-summary.txt`：甲/乙工作区 `.pao` 文件清单和 Git 追踪状态摘要。
- `commands.log`：本轮命令、退出码和关键输出位置说明。
- `sha256.json`：原复制证据与源文件哈希核对。

原始 P5 目录保持不变，未移动任何原证据。

## 命令、退出码与测试状态

本轮只读调查，没有运行 build，也没有运行 Playwright actual，没有修改产品或测试。

- codebase-memory-mcp 首次使用错误的 `--repo-id`，退出 1；随后按 `--help` 改用 `--project`。
- 一次 shell 误把 PowerShell 写成 bash，退出 2；没有产生修改，随后以规定的绝对 pwsh、`login:false` 重跑。
- 真实目录枚举、计划读取、catalog/JSONL 解析、trace 解包和哈希：退出 0。
- `git status --porcelain` 只读检查真实甲/乙工作区：退出 0；无 Git 跟踪文件变化，只有 fixture 创建的未跟踪 `.pao`、`.pi` 和受保护文件。
- 未验：修正测试后的 actual 重跑、部门面板可见性/工人会话、切乙后隔离断言、Electron/P5 的真正门控，以及整个 `production.log` 报告全通过。不能把本调查当作 V09 或整项 P5 验收完成。
