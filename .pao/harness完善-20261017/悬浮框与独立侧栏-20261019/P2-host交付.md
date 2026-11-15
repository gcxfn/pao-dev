# P2 desktop 辅助对话宿主 IPC 交付

日期：2026-10-19  
范围：desktop 宿主的辅助对话读取与发送接线。  
状态：宿主 patch 已完成；runtime 接线与真实集成验收尚未完成。本报告不宣布 P2 整项完成。

## 完成需求

| 需求 | 当前宿主证据 |
|---|---|
| A02、A05 | 新增按 `workspaceId + sessionId` 读取和发送两个窄 IPC。来源由来源窗口当前选择及已登记 workspace 的 session 列表共同校验，不接受任意路径。 |
| A04、A07 | 宿主只暴露以上两个通道，没有增加写文件、终端、派发、停止、审批、提交、扩展或通用控制 IPC。请求字段使用白名单，`command`、附件等越界字段会在进入 handler 前拒绝。 |
| A06 | 没有新增 prefill 或自动回传通道；带回主对话继续由 UI 现有草稿逻辑承担。 |
| A02 的非阻塞接线目标 | 两个辅助对话 handler 直接调用 `DesktopAppStore`，没有进入普通 `sessionControl` 窗串行队列。主控正在运行时的真实并发尚未集成验证。 |
| A05 的隔离目标 | 宿主只接受当前来源窗口选中的来源，并直接调用 driver 的独立问答通道；宿主没有增加第二套问答持久化。 |

## 修改文件与关键入口

修改：

- `desktop/apps/desktop/contracts/ipc.ts`
  - 新增 `SideChatRequest`、`SendSideChatMessageRequest`、`desktopIpc.getSideChat`、`desktopIpc.sendSideChatMessage` 与两个 renderer API 声明。
- `desktop/apps/desktop/electron/preload.ts`
  - 仅在 `contextBridge` 暴露的 `api` 中新增 `getSideChat` 和 `sendSideChatMessage`。
- `desktop/apps/desktop/electron/ipc/request-validation.ts`
  - 新增 `expectSideChatRequest` 与 `expectSendSideChatMessageRequest`。ID 非空且最长 256 字符；正文拒绝空白、超过 100,000 字符和未知字段。
- `desktop/apps/desktop/electron/ipc/register-desktop-ipc.ts`
  - 两个通道均通过 `handleMainFrame` 注册；校验窗口主框架、来源选择和工作区登记后，直接调用 store。
- `desktop/apps/desktop/electron/application/app-store.ts`
  - 新增 `getSideChat(source)` 与 `sendSideChatMessage(input)`。再次检查来源仍存在，随后调用 driver 的窄方法。

新增：

- `desktop/apps/desktop/contracts/side-chat.ts`
  - 只从 `@pi-gui/session-driver` 重新导出 `SideChatSnapshot` 与 `SendSideChatMessageInput`，没有在 desktop 复制类型。
- `desktop/apps/desktop/electron/ipc/side-chat-source.ts`
  - `requireSideChatSource` 同时校验调用窗口选中来源与已登记 workspace/session。
- `desktop/apps/desktop/tests/unit/side-chat-ipc.spec.ts`
  - 覆盖主框架注册结构、请求字段、长度、来源窗口和来源存在性。

接口与类型选择：renderer 调 `getSideChat({ workspaceId, sessionId })` 与 `sendSideChatMessage({ workspaceId, sessionId, text })`。宿主在进入 store 前转换或校验为 driver 的实际输入；store 对 `PiSdkDriver` 调用 `getSideChat(source)` 与 `sendSideChatMessage({ source, text })`。类型以当前 `desktop/packages/session-driver/src/side-chat.ts` 为准，其中快照还包含 `busy`，`sync.boundaryId` 的实际类型是 `string | null`。

## 验证命令与日志

有效执行轮次的工作目录为 `D:\AI\workspace\pao-dev\desktop`。以下日志被最后一轮执行覆盖，日志内均记录命令、开始时间、标准输出与标准错误、结束时间和 `EXIT_CODE`。

| 命令 | 退出码 | 结果 | 日志 |
|---|---:|---|---|
| `pnpm exec playwright test -c apps/desktop/playwright.config.ts apps/desktop/tests/unit/side-chat-ipc.spec.ts apps/desktop/tests/unit/ipc-request-validation.spec.ts` | 0 | 23 passed；其中 side-chat 4 项、既有 request-validation 19 项 | [P2-side-chat-ipc.log](P2-side-chat-ipc.log) |
| 主对话独立复跑 `apps/desktop/tests/unit/side-chat-ipc.spec.ts` | 0 | 4 passed | [主对话复核-host-unit.log](主对话复核-host-unit.log) |
| `pnpm exec tsc -p apps/desktop/tsconfig.electron.json --noEmit --pretty false`，独立保存轮次 | 2 | 当前静态检查失败；保留原日志指纹并另存，未纳入新生成轮次的通过项 | [runtime15 独立日志](P2-desktop-electron-typecheck-runtime15-20261019.log) |
| `pnpm exec tsc -p apps/desktop/tsconfig.json --noEmit --pretty false`，独立保存轮次 | 2 | 当前 UI 集成静态检查失败；单独保留，不覆盖原日志 | [UI 独立日志](P2-desktop-renderer-typecheck-ui-20261019.log) |
| `pnpm --dir packages/pi-sdk-driver typecheck`，独立保存轮次 | 2 | 当前 runtime 静态检查失败；不沿用此前一条 runtime 通过记录作为本轮结论 | [runtime 独立日志](P2-pi-sdk-driver-typecheck-runtime-20261019.log) |
| `node --test scripts/ipc-main-frame-boundary.test.mjs` | 0 | 2 passed | [P2-ipc-main-frame-boundary.log](P2-ipc-main-frame-boundary.log) |
| `node --test scripts/check-host-boundary.test.mjs scripts/check-contract-authority.test.mjs scripts/ipc-main-frame-boundary.test.mjs` | 0 | 20 passed | [P2-boundary-guards.log](P2-boundary-guards.log) |
| `node scripts/check-host-boundary.mjs` | 0 | Host 依赖未混入 renderer 或测试实现 | [P2-host-boundary.log](P2-host-boundary.log) |
| `node scripts/check-contract-authority.mjs` | 0 | 自有 workspace 契约没有 ambient redeclaration | [P2-contract-authority.log](P2-contract-authority.log) |
| `pnpm --dir packages/session-driver typecheck` | 0 | 通过 | [P2-session-driver-typecheck.log](P2-session-driver-typecheck.log) |
| `pnpm exec prettier --check <本工作包 8 个文件>` | 0 | 全部符合格式 | [P2-format.log](P2-format.log) |
| `git diff --check -- <本工作包 8 个文件>` | 0 | 无空白错误，仅有仓库既有 LF/CRLF 提示 | [P2-git-diff-check.log](P2-git-diff-check.log) |
| `pnpm exec tsc -p apps/desktop/tsconfig.electron.json --noEmit --pretty false` | 2 | 失败，只有 `PiSdkDriver` 尚缺两个方法 | [P2-desktop-electron-typecheck.log](P2-desktop-electron-typecheck.log) |
| `pnpm exec tsc -p apps/desktop/tsconfig.json --noEmit --pretty false` | 2 | 失败，详见下文；错误位于本轮无权修改的 `src` UI | [P2-desktop-renderer-typecheck.log](P2-desktop-renderer-typecheck.log) |
| `pnpm --dir packages/pi-sdk-driver typecheck` | 2 | 失败，错误位于 runtime 正在接入的 `src/side-chat.ts` 与 supervisor 导出链 | [P2-pi-sdk-driver-typecheck.log](P2-pi-sdk-driver-typecheck.log) |

electron 类型检查的两条当前错误：

```text
apps/desktop/electron/application/app-store.ts(698,24): error TS2339: Property 'getSideChat' does not exist on type 'PiSdkDriver'.
apps/desktop/electron/application/app-store.ts(708,24): error TS2339: Property 'sendSideChatMessage' does not exist on type 'PiSdkDriver'.
```

renderer 类型检查的两条当前错误：

```text
apps/desktop/src/app/App.tsx(1393,12): Property 'prepareSideChatDraft' is missing ...
apps/desktop/src/app/task-status-dock.tsx(241,36): '"department"' is not assignable to parameter type '"files" | "changes" | "terminal" | "side-chat"'.
```

这两条属于本轮明确禁止修改的 `src` UI 范围，不代表宿主 IPC 的错误，也尚未由对应 UI 写者修复。pi-sdk-driver 的失败没有计入本工作包通过项。

上表保留的是原留档文件的证据指纹和当时的错误文本；截至 2026-10-19 14:36 的独立复跑中，electron 类型检查还出现 `session-supervisor.ts` 的依赖、状态和 `leafId` 问题；renderer 当前另有 `workbenchTargetRef`、`onOpenSourceChat`、`side-chat` panel 契约问题；pi-sdk-driver 当前日志记录 18 行错误。错误数量与内容会随 runtime 修改变化，因此当前轮次不能用先前错误清单替代，也不能把之前某条检查的退出码自动沿用。

## 定向边界测试

| 边界 | 实际测试方式 | 结果 |
|---|---|---|
| 窗口授权 | `side-chat-ipc.spec.ts` 读取 `register-desktop-ipc.ts`，断言 `getSideChat` 和 `sendSideChatMessage` 分别通过 `handleMainFrame` 注册；主框架守卫测试另验证 helper 拒绝非主框架及文件中的裸注册。 | 渠道声明与注册结构通过；真实 Electron 门控未验证。 |
| 来源窗口不匹配 | 构造已登记但对应当前窗口选择之外的 session，调用 `requireSideChatSource`，断言明确抛出 `Side chat source must be the selected session in this window.` | 通过。 |
| 来源不存在 | workspace 被移除，或 session ID 不在已登记 workspace 的 session 列表，断言抛出 `Unknown side chat source: workspace-a:session-id`。 | 通过。 |
| 空来源 | workspace 填空字符串，断言请求校验在进入 handler 前拒绝。 | 通过。 |
| 空白和超长正文 | 纯空白与 100,001 字符正文分别断言明确拒绝；正常正文两侧空白原样保留。 | 通过。 |
| 未知字段 | 发送请求额外携带 `command: "rm"`，断言抛出 `unsupported field: command`；读取请求和发送请求都用字段白名单。 | 通过。 |

这些是 Node 单元与源码结构测试。PLAYWRIGHT 的 `unit` lane 没有启动 Electron。它们证明渠道声明、请求输入校验、来源选择与已登记会话校验纯函数，以及源码中的主框架注册方式；不能证明 Electron 运行时实际收到 invoke、正确区分主框架和 iframe、拒绝未授权窗口，或完成真实 IPC 往返。真实 Electron 门控由 P5 后续验证。

V09 要求的是辅助对话不能借真实宿主工具入口修改文件、执行终端、派发、停止任务、审批、使用可写扩展或 MCP，并检查实际文件、Git 与任务状态未改变。本工作包只证明没有新增上述控制类 IPC、请求白名单拒绝越界字段，以及两个渠道的宿主接线结构；它不等同于 V09 全过。

## 证据分层（当前轮次）

| 层 | 当前证据 | 不能推出的结论 |
|---|---|---|
| 已改 | 本报告列出的 8 个宿主文件已接线，接口、输入校验、来源约束和窄 driver 调用已存在。 | 代码存在不等于 runtime 能编译或真实交互成功。 |
| 静态检查 | 本轮之前的定向单元、守卫和格式检查保留原日志；当前独立静态复跑仍失败，见上表。 | 不能把旧留档中的通过自动带入当前代码状态。 |
| Node 单元/源码结构 | 主对话独立复跑 `side-chat-ipc.spec.ts` 为 4 passed；证明渠道声明、输入校验、来源纯函数和注册文本结构。 | 不等于真实 Electron 主框架、窗口授权或 IPC 往返通过。 |
| 真实 Electron | 本轮没有新的真实 Electron 成功运行；P5 待验。 | 不能用 unit 测试或结构测试代替 P5 证据。 |
| 发行物 | 本轮未构建或运行发行物。 | 不能声称发行物中可用。 |
| 离线替身 | 本轮没有模型替身问答结果。 | 不能声称真实或离线模型问答已经成功。 |

## 未验证与依赖

- `PiSdkDriver.getSideChat(source)` 与 `sendSideChatMessage({ source, text })` 的 runtime 实现、导出和 supervisor 接入尚未稳定；electron 类型检查因此失败。
- 未启动真实 Electron，无法验证 renderer → preload → mainFrame helper → workspace/session 校验 → app-store → driver 的完整 IPC 往返。真实 Electron 主框架与实际窗口授权门控由 P5 后续验证。
- 未验证真实辅助问答、只读工具拒绝、主控运行期间并发问答、关闭与重开后的恢复、跨主控和工作树隔离。
- 未验证真实 UI 错误可见性。宿主使用明确异常；renderer 如何展示仍由 UI 写者承担。
- renderer 类型检查另有 `App.tsx` 与 `task-status-dock.tsx` 的 UI 契约错误，需对应写者处理。

## 排障与日志限制

首两轮统一落盘命令因 PowerShell 参数传递写法错误，出现 `pnpm exec` 被当成单个命令名及类似错误；没有把这两轮计作项目失败或通过。修正参数展开后重跑得到上表有效结果。新增主框架结构断言时，初次使用 `import.meta.url` 触发测试运行器的 CommonJS 兼容错误，改用现有测试惯用的 `__dirname` 后通过。这些排障过程不改变上述有效日志和代码结论。

后续复跑使用新的“轮次或后缀”文件，不覆盖现有日志：首次失败快照保存在 [P2-首次失败快照-20261019-1433](P2-首次失败快照-20261019-1433/)，现有 Playwright 临时输出中的本项探针文件已复制到 [P2-Playwright历史输出-20261019](P2-Playwright历史输出-20261019/)。留档目录中的原文件不动。真实 Electron 若产生失败截图、视频、trace 或错误上下文，应先复制到本项留档的独立轮次目录，再允许下一次测试运行清理项目内的 `test-results`。当前留档没有新的真实 Electron 失败截图或 trace。

未执行 reset、stash、提交、装机、正式 `PAO_HOME`、供应商或全局配置操作。未修改 runtime、`src` UI、`contracts/workbench.ts`、session-driver、pi-sdk-driver、PAO 或测试 helpers。
