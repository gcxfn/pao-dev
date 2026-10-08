# r1 整批红条分类（L8 桌面道整理，2026-10-08）

log：E2E-core整批-r1-中断.log（37f115e 版面，14:33-15:35，退出码 1）
总计：184 过 / 66 红（其中 37 条＝worker 0xC0000142 崩溃伤亡，29 条真断言红）/ 9 跳 / 70 未跑 / 1 worker teardown 超时（reopen-state 退出挂起族）

## 29 条真断言红（全部∈T00 编号集合，零新增）
  1) apps\desktop\tests\core\changed-files.spec.ts:19:5 › preserves an exact changed-file path through diff and stage actions 
  2) apps\desktop\tests\core\composer-controls.spec.ts:196:5 › dark mode keeps the send button visible before and after typing 
  3) apps\desktop\tests\core\composer-image-limits.spec.ts:269:5 › legacy migration skips oversize-pixel images before the composer map 
  4) apps\desktop\tests\core\custom-endpoints.spec.ts:407:5 › custom endpoint dialog supports a long-list keyboard flow with sticky actions 
  5) apps\desktop\tests\core\extension-card-actions.spec.ts:86:5 › card buttons run through main: a keyed card updates in place, and non-extension commands are refused 
  6) apps\desktop\tests\core\extension-command-compatibility.spec.ts:47:5 › fails fast for unsupported handoff-like commands and learns terminal-only status 
  7) apps\desktop\tests\core\extension-dock-reload.spec.ts:44:5 › resets dock expansion on /reload and extension enable or disable transitions 
  8) apps\desktop\tests\core\extension-dock-reload.spec.ts:95:5 › refreshes runtime with new extension output and keeps the dock collapsed after rebuild 
  9) apps\desktop\tests\core\extension-examples.spec.ts:36:5 › the actual Test Runs example streams real processes, retains closed-tab work and isolates tasks 
  10) apps\desktop\tests\core\extension-trace-view.spec.ts:86:5 › the Trace example shows a live waterfall of the reply's model calls and tools with context 
  11) apps\desktop\tests\core\extension-usage-view.spec.ts:93:5 › the Usage example totals real pi sessions for the folder and explains what fills context 
  12) apps\desktop\tests\core\extension-view-links.spec.ts:65:5 › an extension view opens https links and threads beside its own 
  13) apps\desktop\tests\core\extension-view-security.spec.ts:18:5 › custom frontend exchanges Chord state while its opaque frame cannot access preload, parent, network or navigation 
  14) apps\desktop\tests\core\extension-view-security.spec.ts:111:5 › a failed author mount keeps conversation editable and Reload view recovers the same backend 
  15) apps\desktop\tests\core\extension-view-security.spec.ts:140:5 › two real windows share one task backend while their frame connections remain isolated 
  16) apps\desktop\tests\core\extensions-dialogs.spec.ts:141:5 › renders extension dialogs in the Electron surface and routes responses back to the session 
  17) apps\desktop\tests\core\extensions-session-isolation.spec.ts:26:5 › keeps extension widgets, status, and title scoped to the active session 
  18) apps\desktop\tests\core\integrated-terminal.spec.ts:178:5 › writes an oversized terminal paste in chunks instead of dropping it 
  19) apps\desktop\tests\core\mcp-settings.spec.ts:194:5 › rejects a server Settings cannot run and leaves mcp.json alone 
  20) apps\desktop\tests\core\model-change-keeps-draft.spec.ts:15:5 › changing model or thinking from the composer footer keeps the typed prompt and attachments 
  21) apps\desktop\tests\core\new-thread-auto-title.spec.ts:141:5 › manual rename beats a delayed auto-title result 
  22) apps\desktop\tests\core\new-thread-auto-title.spec.ts:188:5 › manual rename applies after the run is aborted via Stop 
  23) apps\desktop\tests\core\reopen-state.spec.ts:15:5 › reopens persisted folders and thread state while a saved running session keeps streaming updates 
  24) apps\desktop\tests\core\review-layout.spec.ts:22:5 › Review shows the diff beside a filterable file tree with Staged and Unstaged scopes 
  25) apps\desktop\tests\core\review-scopes.spec.ts:258:5 › choosing another review checkout preserves the task and terminal checkout 
  26) apps\desktop\tests\core\review-scopes.spec.ts:335:5 › large changed-file lists scroll with bounded row layout and expandable coverage 
  27) apps\desktop\tests\core\secondary-surface-inset.spec.ts:26:5 › Back to app lines up with New thread below the window buttons 
  28) apps\desktop\tests\core\session-lease.spec.ts:31:5 › a second pi-gui process cannot open a thread the first one holds 
  29) apps\desktop\tests\core\settings-appearance.spec.ts:134:5 › every preset recolours the same design instead of restyling it 

## 37 条崩溃伤亡（Error: worker process exited unexpectedly (code=3221225794, signal=null)＝0xC0000142）
  30) apps\desktop\tests\core\settings-general.spec.ts:15:5 › ignores persisted multiple app instance opt-in and hides the setting 
  31) apps\desktop\tests\core\side-panel-picker.spec.ts:11:5 › one icon and keyboard shortcuts toggle the selected workspace tool 
  32) apps\desktop\tests\core\side-panel-tab-shortcuts.spec.ts:16:5 › Control or Alt with 1-9 selects side panel tabs while Cmd or Ctrl keeps switching threads 
  33) apps\desktop\tests\core\sidebar-folder-collapse.spec.ts:12:5 › folds a folder group from its row and keeps it folded across restart 
  34) apps\desktop\tests\core\sidebar-layout.spec.ts:10:5 › folder rows start a new thread in that folder 
  35) apps\desktop\tests\core\sidebar-ordering.spec.ts:13:5 › sidebar thread order is stable after creation and does not flicker 
  36) apps\desktop\tests\core\sidebar-recency.spec.ts:23:5 › caps each time bucket at five and hides workspace headers 
  37) apps\desktop\tests\core\sidebar-toggle.spec.ts:119:5 › toggles and persists the primary sidebar from the button and keyboard shortcut 
  38) apps\desktop\tests\core\skills-settings.spec.ts:12:5 › shows skills and settings surfaces from runtime data 
  39) apps\desktop\tests\core\slash-command-attachments.spec.ts:14:5 › a typed slash command keeps composer attachments across thread switch and restart 
  40) apps\desktop\tests\core\smoke.spec.ts:15:5 › adds a workspace to an empty launched app ───────
  41) apps\desktop\tests\core\stop-running-prompt.spec.ts:23:7 › Thread switching and pin controls stay responsive during a pending prompt (stop: Keep this prompt pending until Stop) 
  42) apps\desktop\tests\core\streaming-publish.spec.ts:114:5 › coalesces token publishes without losing stick-to-bottom or wheel unpin 
  43) apps\desktop\tests\core\terminal-diff-layout.spec.ts:10:5 › Review and Terminal share one side workspace while the composer stays available 
  44) apps\desktop\tests\core\thread-menu.spec.ts:28:5 › right-click thread menu supports rename, archive/restore, mark read, and copy id 
  45) apps\desktop\tests\core\thread-switcher.spec.ts:26:5 › Ctrl-Tab switches threads in most-recently-used order and keeps it across restart 
  46) apps\desktop\tests\core\timeline-overflow.spec.ts:224:5 › keeps long tool metadata and user rows inside the transcript at wide and narrow widths 
  47) apps\desktop\tests\core\timeline-pinning.spec.ts:278:5 › keeps the latest assistant content visible when the composer grows at the bottom of a thread 
  48) apps\desktop\tests\core\timeline-viewport.spec.ts:16:5 › long messages stay windowed and wheel scrolling preserves the visible row during streaming 
  49) apps\desktop\tests\core\todo-table.spec.ts:152:5 › TodoWrite tool calls render a task checklist table, live and after restart 
  50) apps\desktop\tests\core\tool-output-images.spec.ts:26:5 › shows images a tool returned in its row, not their base64 text 
  51) apps\desktop\tests\core\transcript-annotations.spec.ts:76:5 › adds transcript selections to chat with comments and sends them before the message 
  52) apps\desktop\tests\core\transcript-staleness.spec.ts:17:5 › shows messages appended to the pi session file by an external writer after relaunch 
  53) apps\desktop\tests\core\tree-command.spec.ts:18:5 › opens /tree from the composer, navigates branches, and blocks it on the new-thread surface 
  54) apps\desktop\tests\core\turn-changes-card.spec.ts:69:5 › a turn that edits files gets a changes card whose rows open that file's diff 
  55) apps\desktop\tests\core\unread-state.spec.ts:19:5 › selecting an unread thread persists read state through the latest known activity 
  56) apps\desktop\tests\core\workbench-tabs.spec.ts:117:5 › adds singleton tool tabs, closes to a neighbor, and keeps an empty chooser 
  57) apps\desktop\tests\core\workflow-bug5-reactivation.spec.ts:19:5 › bug5 复验：切普通会话再切回画布，主控面板恢复且会话回到标签主控 
  58) apps\desktop\tests\core\workflow-canvas.spec.ts:36:5 › 配方点击加载、拖动产生修改、放弃还原 ────────────────────
  59) apps\desktop\tests\core\workflow-control.spec.ts:20:5 › 主控暂停与人工恢复真实落盘，确认未交付节点显示内核拒绝 ──────────
  60) apps\desktop\tests\core\workflow-instance.spec.ts:134:5 › 实例运行图只读：冻结节点不同最新配方、不可拖不可连、点节点开详情 ───
  61) apps\desktop\tests\core\workflow-single-view.spec.ts:24:5 › 同配方另开标签：右键入口开出第二标签，两标签各自独立主控（S4-1⑤） 
  62) apps\desktop\tests\core\workflow-tabs.spec.ts:7:5 › 工作流标签重开后保留独立主控，切换和关闭保护修改 ─────────────────
  63) apps\desktop\tests\core\workspace-file-lines.spec.ts:72:5 › assistant file lines open in the Files panel and web links stay external 
  64) apps\desktop\tests\core\workspace-files.spec.ts:36:5 › Files workbench puts the explorer to the right of an open file pane 
  65) apps\desktop\tests\core\workspace-menu.spec.ts:12:5 › supports workspace rename and remove from the sidebar menu 
  66) apps\desktop\tests\core\worktrees.spec.ts:54:5 › creates and selects a worktree-backed workspace from the desktop UI 
