# R06/V03/V12 宽度边界校准

日期：2026-10-19

## 结论

已确认并修复工具列宽度上限不一致：task-status CSS 把工具列封顶在 `.main` 容器的 55%，但 `workbenchBounds` 宣告 65%。在真实 Electron 的 1440 内容窗口中，实际 CSS 上限为 676px，旧手柄却宣告 799px。源码现统一为 55%，过时的“工作台嵌右侧坞”注释已删除。

授权的 core 测试已新增独立 wide 宽度用例，并用真实 boundingBox 替代“工具加号必须低于聊天标题”的旧纵向断言。源码静态检查通过。当前 Electron 测试加载旧 renderer 产物，因此最终真实宽端复验必须等 P5 统一 build。

## 修改

| 文件 | 内容 |
|---|---|
| `desktop/apps/desktop/src/features/workbench/workbench-resize-handle.tsx` | 宽端 max 从 `65%` 对齐为 CSS 的 `55%`；窄窗 320px 规则和 1200px 上限保持；清理过时布局注释。 |
| `desktop/apps/desktop/tests/core/workbench-tabs.spec.ts` | 新增独立 wide max 用例：检查 ARIA max、键盘 End、拖拽越界与实际 DOM 宽度一致；旧大用例的过时纵向关系改为 R01/R03 的顶栏水平分区，其余原断言保留。 |

`workbenchBounds` 调用链只进入 `Workbench`，其上层是 `TaskStatusDock`/AppShell；没有发现第二套宽度边界协议。共享 CSS、PaneResizeHandle、App、Dock、workbench、其他测试均未修改。

## 已有证据

真实 Electron 修复前探针：

- `.main.clientWidth = 1229`
- CSS 55% 上限：`676`
- 旧 handle：`aria-valuemax="799"`（65%）
- 日志：`R06-width-pre-fix-instrumented.log`
- 独立 max 用例在旧 out 上复现旧值：`R06-width-independent-pre-build.log`

旧大用例的纵向位置断言在修复前和一次修复后复跑中失败，截图与 trace 分别保留在 `playwright-results/pre-fix-valid/`、`playwright-results/pre-fix-boundary-contained/`、`playwright-results/fixed-wide/`。该旧断言现已按新定案替换，并非删除业务覆盖。

## 静态检查

工作目录：`D:\AI\workspace\pao-dev\desktop`

| 检查 | 退出码 | 日志 |
|---|---:|---|
| Prettier write/check | 0 | `R06-final-format-write.log`、`R06-final-format-check.log` |
| 定向 ESLint | 0 | `R06-final-lint.log` |
| renderer `tsc` | 0 | `R06-final-renderer-tsc.log` |

另一次指定不存在的 `apps/desktop/tsconfig.test.json` 退出 1，属命令路径错误；原始日志保留为 `R06-test-tsc.log`，未添加配置规避。

## P5 统一 build 后执行

源码修改尚未进入当前 out。请 Archimedes/P5 统一 build 后运行定向真实 Electron 用例：

```powershell
Set-Location D:\AI\workspace\pao-dev\desktop
.\node_modules\.bin\playwright test -c apps/desktop/playwright.config.ts apps/desktop/tests/core/workbench-tabs.spec.ts --grep "wide workbench width controls"
.\node_modules\.bin\playwright test -c apps/desktop/playwright.config.ts apps/desktop/tests/core/workbench-tabs.spec.ts --grep "keeps one resizable width"
```

第一条证明 wide ARIA、键盘和拖拽上限都等于 CSS/实际 DOM 宽度；第二条证明既有跨工具、任务、重启宽度行为和 R01/R03 顶栏分区。按当前分工未运行 build；未宣称这两条在源码修复后的 out 上通过。
