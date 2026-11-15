# 阻塞 4：桌面与 status 读取版本一致实施报告

日期：2026-10-23

结论：生产源码已冻结。桌面真实读面、status 与 panel/panorama 的真实入口均使用异步 Fresh 读取，版本事实来自共享控制入口对当前 Git 内容树的核对。本代理负责的终端定向测试、SDK 加载测试和限定 Biome 检查均通过；主控统一 `npm run check`、内核最终构建和桌面最终构建也已通过。最终 Electron 整合验收以主控结果为准。

## 根因

控制核心已经把“历史 pass 只有在当前内容树仍匹配时才算完成”放进异步 `readControlReport` / `readControlView`。旧桌面读面仍同步调用 `readDesktopFlows`，于是刚完成的流程可能在控制报告中为 `completed`，桌面却显示“运行中”。panel 的实例选择与 panorama 的聚合、钻取也仍读取同步实例扫描结果，因此同样缺少当前 tree 核对。

修复只在既有读取边界接入异步 Fresh 结果，没有在 SDK、Electron、panel 或 panorama 复制版本判断。同步 API 因旧契约保留，并明确表示只读取持久正本声明、未经当前 tree 核对。

## 已修改与接线范围

- 内核共享读取：`PAO/packages/coding-agent/src/pao/desktop/*`、`src/pao/status/*`。
- 终端真实入口：`PAO/packages/coding-agent/src/pao/panel/index.ts` 的 `:631` 与 `:723` 均等待 `scanInstanceSignalsFresh`；`src/pao/panorama/index.ts` 的首次聚合、钻取清单、钻取详情和刷新循环均等待 Fresh 扫描或实例读取。
- Electron 实际消费者：`desktop/apps/desktop/electron/platform/pao/flow-control-query.ts`、`ephemeral-sweep.ts`、`canvas-query.ts`、`temporary-plans-query.ts`、`workboard-session-query.ts` 均等待 Promise，RPC 载荷字段未改。
- SDK 薄适配：`desktop/packages/pi-sdk-driver/src/pao-*.ts` 与 `extensions/pao/*`。共享读取逻辑只在控制核心里维护。
- Fresh 读取会在每次刷新时重新核对当前 tree，没有持久缓存有效 pass，也不把历史 tree 当成当前 tree。
- 未修改 `control.ts`、`host-bridge.ts`、`verifier.ts`、`delivery.ts`，也未修改主控持有的 `pao-review-version.spec.ts`。

测试夹具的 schema 必填字段修复位于 `PAO/packages/coding-agent/test/pao/desktop-status-fresh.test.ts:215`：补入真实说明“确定性阻塞 4 验收工作流；只验证共享当前内容树读取，不调用模型。”，没有用 `any`、断言、可选字段或关闭检查绕过。

## 终端定向验证

实际命令（工作目录 `D:/AI/workspace/pao-dev/PAO/packages/coding-agent`）：

```powershell
& 'C:/Program Files/nodejs/node.exe' '../../node_modules/vitest/vitest.mjs' run `
  'test/pao/panel-view.test.ts' `
  'test/pao/panorama-page.test.ts' --reporter=json
```

实际结果：退出码 0，40 项测试通过。新增场景使用可控延迟 Promise，证明 panel 查看进度、panorama 聚合与详情钻取都等待 Fresh 读取，未在结果返回前执行下一步。相关测试文件是 `test/pao/panel-view.test.ts` 与 `test/pao/panorama-page.test.ts`。

限定 Biome 实际命令（工作目录 `D:/AI/workspace/pao-dev/PAO`）：

```powershell
& 'C:/Program Files/nodejs/node.exe' 'node_modules/@biomejs/biome/bin/biome' check `
  'packages/coding-agent/test/pao/panel-view.test.ts' `
  'packages/coding-agent/test/pao/panorama-page.test.ts' `
  'packages/coding-agent/test/pao/desktop-status-fresh.test.ts' `
  --error-on-warnings
```

实际结果：退出码 0，检查 3 个文件且无修复。主控统一 `npm run check` 也已退出 0，因此未重复跑全仓检查。

## SDK 与 Electron 边界验证

工作目录 `D:/AI/workspace/pao-dev/desktop/packages/pi-sdk-driver`，使用重建后的 kernel/desktop 产物运行：

```powershell
& 'C:/Program Files/nodejs/node.exe' --test `
  'test/pao-plans.test.mts' `
  'test/pao-canvas.test.mts' `
  'test/pao-public-bridge-identity.test.mts' `
  'test/pao-workboard.test.mts'
```

实际结果：退出码 0，11/11 通过，0 失败、0 取消、0 跳过、0 todo。原始日志为 `.pao/四项改进-20261023/阻塞4-SDK定向.log`。主控 Prettier 只格式化了 `ephemeral-sweep.ts`、`temporary-plans-query.ts`、`pao-flow-control.ts`、`pao-kanban.ts`；格式化后 SDK 4 项已重新运行通过。

`ephemeral-sweep.ts` 的 Promise 调用错误已修复：先等待 `loadPaoDesktopFlowControl` 加载器，再调用并等待 `bridge.readDesktopFlows`。已有 `ephemeral-sessions.spec.ts` 3 项定向测试通过，桌面类型检查退出 0；主控桌面最终构建退出 0。

## 主控统一验证状态

- 冻结生产版本 `npm run check`：退出码 0。
- 内核最终 build：退出码 0，`dist` 包含 Fresh 公共导出。
- 桌面最终 build：退出码 0。
- 主控已只读核对接线。最终 Electron 页面场景仍由主控使用 `desktop/apps/desktop/tests/core/f-desktop-owner.spec.ts` 与 `pao-review-version.spec.ts` 验收，旧 owner 测试不能替代版本场景。

## 正确性与简洁性复核

- 版本事实只由共享控制入口产生，SDK 与 Electron 只转发异步结果。
- panel/panorama 复用共享 status 读取；panorama 同一轮只扫描一次，钻取只读取被选中实例。
- 没有新增版本规则、缓存层、通用包装器或无关 UI 重写。
- 同步导出只保留旧契约，真实用户读面使用 Fresh。
- 未发现新的 `any`、`unknown` 绕过、重复版本判断或历史 tree 复用。

## 局限

- 本代理的验证止于内核定向测试、SDK 加载和 Electron 边界；最终真实 Electron 页面交互由主控验收。
- 已有 Electron 4/4 结果早于最后一次 ephemeral Promise 小修；该修复已由 3 项边界测试、桌面类型检查和桌面最终构建覆盖，未重复 owner 3 项。
- Fresh 读取会为实例执行 Git 内容树核对，存在子进程成本；本批优先保证当前性，没有增加持久缓存或做性能 benchmark。
- 未访问正式 PAO_HOME，未恢复第三题 Docker，未运行付费模型或新 benchmark，未安装依赖、提交 Git、跑全仓格式化或放宽检查。

