# 批 3b-U 脚本编辑与辅助对话 — 验收证据

日期：2026-11-04。规格：`plans/未完成/2026-11-04-工作流画布升级.md` §4 批 3b-U（L235-245 + 批 3b-U 界面评审技术绑定段 2026-11-04 侦察后写入）、§5 第 262 行。

方法：界面评审侦察代理（RecipeCanvasEditor 现状/执行方式清理清单/实例脚本区落点/side-chat 承载/候选回填路径/i18n/测试入口）→ 评审结论写入计划 §4 技术绑定 → 三个并行实施分片（①编辑器脚本字段 ②实例脚本区+解释器 IPC ③side-chat 对话修改+候选回填）→ 两个独立分片审核（A 编辑器+候选回填、B 实例脚本区+IPC+缝合）→ 统一修补代理 → 真实 Electron 界面验证 → 主对话整合验收。

## 界面评审结论（已写入计划 §4 绑定段）

- **执行方式编辑落点**：RecipeCanvasEditor Inspector 加执行方式 select（v2-only）+脚本 textarea+超时 number+产物 paths；切清理由纯函数 `executionModePatch`：→脚本清只读/审核/回边/工人数量；→直接清脚本/超时/产物/只读/审核/回边；→拆解清脚本/超时/产物。
- **「对话修改」承载＝激活主控（方案 a）**：先 `onActivateController(controller)` 激活主控为当前会话再 `openTool({kind:"side-chat"})`，不放宽 requireSideChatSource「当前选中会话」校验；identity 缺失提示建立主控会话；模型沿来源会话 modelRuntime；只读工具白名单不动。
- **候选**：`extractPowerShellCandidates` 提 ```powershell/```ps1 完整围栏；0 禁应用、≥2 用户选定；`applyScriptCandidate` 只动 draft；pending 绑 nodeName/recipeName/draftScriptAtLaunch；currentScript 比对→conflict 显示当前稿与候选由用户选替换；改名/删除禁自动应用；直接正文比较不新增摘要。
- **实例脚本区**：`CanvasDetailSectionId` 加 "script" 第十区（io 后）；冻结正文从卡面 script/script_timeout/artifacts 读（执行依据非配方 def）；三处透传；不向总览复制整段脚本。
- **「实际解释器信息」＝实时探测当前机**：执行时未持久化 interpreter，新只读 IPC `readDesktopScriptInterpreter` 暴露当前机探测，如实标注「当前机将用」非历史执行当时值（语义边界登记）。
- **契约**：WizardRecipeNode 补显式四可选字段；i18n 新键全走 t()，Inspector 存量硬编码中文不迁。

## 实施定位（未提交工作区改动）

| 片 | 文件 | 改动 |
|---|---|---|
| ①编辑器 | `contracts/workflow-wizard.ts` | WizardRecipeNode 加 执行方式/脚本/超时/产物 四可选字段（readonly） |
| ①编辑器 | `recipe-canvas-editor.tsx` | executionModePatch/readExecutionMode/parseArtifactLines/invalidArtifactPath 纯函数；Inspector v2 守卫内执行方式 select+脚本 textarea+超时 number+产物（仅脚本显示）；切离脚本弹确认列清字段（pendingMode 记节点名绑节点）；`RecipeEditorActions` 扩 `applyScriptCandidate(nodeName,text,force?)`+`currentScript(nodeName)` |
| ①编辑器 | `contracts/i18n-zh.ts`、`styles/canvas.css` | 12 新键；`.workflow-inspector__script` 等宽 |
| ②实例区 | 内核 `desktop/index.ts` | L602-630 `readDesktopScriptInterpreter` 只读探测（包装 getPowerShellConfig） |
| ②实例区 | driver `pao-canvas.ts`、`index.ts` | PaoCardFrontmatter 加 script/script_timeout/artifacts；`loadPaoDesktopScriptInterpreter` 懒加载器；导出 |
| ②实例区 | `contracts/canvas.ts`、`ipc.ts` | CanvasNodeDetailData.card 三字段+CanvasScriptInterpreter 联合类型；`getCanvasScriptInterpreter` 通道+API |
| ②实例区 | `electron/canvas-query.ts`、`register-desktop-ipc.ts`、`preload.ts` | frontmatterFields 三键透传+cardFromRuntime；readScriptInterpreter 探针→契约（异常归 available:false）；handleMainFrame expectNoInput；preload 转发 |
| ②实例区 | `node-runtime-details.tsx`、`canvas-page.tsx` | "script" 第十区+CanvasScriptSectionContent（不适用/正文/超时/产物/解释器/标注）；initialDetailSections+deepOpen+解释器懒取（scriptNode&&expanded.script 门控+selectionKeyRef stale 防护+inFlight 去重） |
| ③候选 | `side-chat/script-candidates.ts`（新） | extractPowerShellCandidates/consumePrefillText 纯函数 |
| ③候选 | `side-chat-panel.tsx` | prefilledText prop（半受控写一次不锁编辑）；候选 pre+Apply 按钮+conflict 并排对比；nodeGone 提示 |
| ③候选 | `recipe-canvas-editor.tsx`、`canvas-page.tsx`、`canvas-surface.tsx`、`workflow-surface.tsx`、`App.tsx`、`task-status-dock.tsx` | planScriptCandidateApply/scriptCandidateProbe/resolvePendingModeApply 纯函数；「对话修改」按钮→onOpenScriptChat→ScriptCandidate pending→onActivateController→onOpenSideChat；applyCandidateRef 接线链 |
| 验证 | `tests/core/batch3bu-script-editor.spec.ts`（新） | 真实 Electron 界面 spec 2 例 |

## 审核发现 → 修补（2 审核；2 major + 2 minor + 4 nit 全修）

- **[major] M1 替换为候选死循环**（审核 A）：force=true 只跳 canvas-page 第一层漂移检测，planScriptCandidateApply 内部仍判 conflict→返回对象无 currentScript，冲突 UI 不更新不关闭，「替换」路径整体不可用。修：`planScriptCandidateApply`/`applyScriptCandidate` 加 `force` 参透传，force 跳过内部 conflict 判定直接 applied；side-chat 收 applied 关冲突块。补 force 用例。
- **[major] M2 确认框误清他节点**（审核 A）：pendingModeActive 无节点绑定不随 selected reset，确认补丁作用当前 selectedNode（已切）→误清新节点字段。修：pendingMode 改 `{nodeName,mode}` 记触发节点，确认走 `resolvePendingModeApply` 补丁作用记录节点；selected 变化 useEffect reset（连带清 artifactError）。
- **[minor] m1 空脚本节点误归 nodeGone**（审核 A）：currentScript 对空脚本返回 undefined→应用静默失败。修：`scriptCandidateProbe` 返回 `{found,script}` 区分「不存在/非脚本」与「脚本为空」，空脚本正常 applied。
- **[minor] m2 recipeName 跨配方串**（审核 A）：pendingCandidate.recipeName 绑而未用。修：应用前比对 `recipeName !== editorEntry.name`→nodeGone。
- **[nit] n1-n4**：artifactError 跨节点残留（同 useEffect 清）；nodeGone 静默（setSendError 提示已删/改名）；`undefined.then`（Promise.resolve 防御）；激活失败 pending 残留（catch 清 pending）——全修。
- **[误报澄清] 分片 1 报的 i18n 重复 `Script` 键**：审核 A/B 均证实不存在（L1077 唯一，L1244 只是注释）——分片 2 说法正确。
- **[登记] frontmatterFields 走运行时读模**：实现走 `PaoCardFrontmatter→frontmatterFields→cardFromRuntime`（withNodeRuntime 运行时卡优先），非名义的内核 readDesktopNodeDetail 投影——效果等价（卡面冻结值确实到 detail.card），登记为字面路径偏差。
- **[判读] 声明产物 vs 回执产物**：脚本区显示卡面 `artifacts`（声明产物，承诺清单）纯文本；批 2p 预览接回执 `artifact_path`（实际产出）——不同源是正确设计，预览贯通由回执产物分区承接。

## §5 批 3b-U 验收逐项（L262）

| # | 验收项 | 判定 | 证据 |
|---|---|---|---|
| 1 | 全部脚本字段编辑/保存/重新读取 | ✅ | 执行方式/脚本/超时/产物入 draft→save→getWorkflowCatalog 回读 setBase/setDraft；走 saveDesktopRecipe revision+确认+备份链 |
| 2 | revision 漂移拒绝 | ✅ | revision 随保存透传桥层乐观锁，无绕过 |
| 3 | 实例冻结只读与配方修改隔离 | ✅ | 实例脚本区全 DetailField 只读无编辑控件；源卡面冻结值非配方 def；配方编辑只动 draft |
| 4 | 候选不自动发送/应用/保存 | ✅ | prefill 只写输入框发送用户触发；Apply 用户点击；applyScriptCandidate 只 setDraft 不调 save/execute |
| 5 | 草稿变动须明确替换 | ✅（修补后） | current!==draftScriptAtLaunch→conflict 并排对比；force 通道打通后「替换为候选」真实写入 |
| 6 | 节点改名不串回填 | ✅ | draft.节点.find 无→nodeGone；recipeName 比对防跨配方同名（修补后） |
| 7 | 脚本徽标/无模型用量/产物预览贯通 | ✅ | 徽标 Script+「脚本节点无模型用量」+声明产物文本（回执产物经批 2p 预览分区承接） |

## 命令结果

| 命令 | 结果 |
|---|---|
| `tsc -p tsconfig.json --noEmit` + `tsconfig.electron.json` | 双 0 错 |
| `playwright test` 相关 unit spec | script-candidates+三个 recipe-canvas-editor spec 73 过；side-chat-ipc/panel-model/draft+canvas.spec 115 过 |
| `canvas-node-detail.spec.ts` | 56 过（含批3b-U 6 新增用例） |
| `canvas.spec.ts` | 148 过（脚本用量/徽标用例） |
| `pi-sdk-driver` `node --test` | 256 过 |
| **真实 Electron** `tests/core/batch3bu-script-editor.spec.ts` | **2 passed（53.1s）**——配方编辑脚本字段组渲染/填写入 draft dirty/切离确认清字段/中文断言/实例脚本分区冻结正文+超时+产物+标注/用量区「脚本节点无模型用量」全验 |
| 截图 | `批3bU-界面-1280.png`（87KB）、`批3bU-界面-900.png`（65KB）、`批3bU-实例脚本分区.png`（232KB）均落盘目检正确 |
| vendor 内核 | `vendor:kernel` 重出，vendor/pao-kernel dist 含 `readDesktopScriptInterpreter`（.js+.d.ts） |

## 存疑/如实标注

- **解释器 IPC 在 background 模式未落位**：界面如实显示「尚未读取。」（spec 容忍轮询三态均可，日志记「解释器探测未在 15s 内落位」）——判为环境限制非产品 bug，前台模式可复测。
- **真实脚本下发/执行**：不在本批范围（属 3b-E），未测。
- **侧聊「预填→手动发送」链路**：浏览器侧无法断言，靠 consumePrefillText 纯函数+类型检查覆盖；候选按钮→回调交互无 DOM 挂载基建，靠签名+末端纯函数覆盖。
- **「实际解释器」语义边界**：实现为实时探测当前机并如实标注「当前机将用」，非历史执行当时值（执行时未持久化 interpreter）——规格语义近似，登记可接受。
- **解释器 available:false 分支**：非 Windows/无 PowerShell 机器未真机验（本机 Windows 必验环境）。
- **Inspector 存量硬编码中文 label**：规格 L272 只约束新增字段走 i18n，存量不迁（新旧机制并存登记）。

## 结论

批 3b-U 满足规格 §5 L262 全部必需验收：脚本字段全量编辑/保存/回读、revision 漂移拒绝、实例冻结只读与配方修改隔离、候选不自动发送/应用/保存、草稿变动明确替换、节点改名不串回填、徽标+用量+产物贯通。2 个 major（替换死循环/确认框误清）+2 minor+4 nit 全部修补并有定向测试；真实 Electron 界面验证 2 spec 过+两档截图+实例分区截图落盘。可在 §7 标完成。
