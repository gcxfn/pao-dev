# 扩展面板（部门详情／PAO 工作流）不经 activeView 挂载

定案：2026-10-17（批次 D 装配时，执行者按 lead 复核意见落地）。状态：已实施。
对象：[Harness完善与工作台迭代执行计划](../../../plans/未完成/2026-10-17-Harness完善与工作台迭代执行计划.md) §5.2 第 8 条、§7.3、§12.2。

## 问题

§5.2 第 8 条要求主页面装配补上 D 的两个扩展面板（部门详情、PAO 工作流），而它们已经由扩展系统注册：

- `packages/pi-sdk-driver/extensions/pao/index.ts:183-189` 注册视图 `{ id: "pao", title: "部门详情", frontend: ./dist/desktop.js }`；
- `packages/pi-sdk-driver/extensions/pao/flow-backend.ts:56-59` 注册 `{ id: "pao-flow", title: "PAO 工作流", frontend: ./dist/flow-desktop.js }`。

最直接的做法是把这两个视图 id 加进 `snapshot.activeView` 分派，和 `scheduled`／`workboard`／`plans`／`canvas` 并列。**没有这么做。**

## 定案

主页面**不新增 activeView 分支**。侧栏加一张入口卡片，点击后走既有工作台通道：

```ts
const EXTENSION_SURFACE_VIEW_IDS = { "department-detail": "pao", "flow-panel": "pao-flow" } as const;
workbench.openTool({ kind: "extension", extensionId: view.extensionId, viewId: view.id });
```

不可用时不静默失败：入口按钮 `disabled`，并显示真实原因（「先打开一个对话才能用这个面板」／「这个对话里没有这个面板」）。

## 理由（三条，按分量排序）

1. **视图 id 是驱动侧契约，不是渲染层的。** §12.2 明确「保留公开工具名、卡协议、持久字段、v1/v2 实例和 view ID」。扩展视图 id、frontend 包地址和注册动作都由 `pi-sdk-driver` 的扩展注册表拥有。把它们抄进 `activeView` 分派，等于在渲染层复刻一份驱动侧注册表，两边一改就漂移。
2. **driver 薄封装边界。** `desktop/AGENTS.md` 要求 driver 保持对共享内核 SDK 的薄封装，渲染层也不该反向依赖扩展前端源码。`activeView` 分支渲染意味着 `App.tsx` 直接 import `extensions/pao/dist/*.js`，运行形态、主题变量、隔离都绕过了既有的 `useExtensionViews` + `ExtensionViewPanel`（`src/app/App.tsx:1375-1452`）。
3. **没有真实需求支持第二套运行时。** 扩展面板已经能正常挂在右侧工作台，`useExtensionViews` 管可用性/世代/错误态，`ExtensionViewPanel` 管样式隔离和主题。为了「主页面也能开」另起一条渲染路径，是给同一份界面建两套宿主，违反「同一规则只实现一次」和「控制复杂度」。

## 代价与已知限制

- 扩展面板只能在工作台侧栏开，不能占满主区域整页。当前需求（部门配置摘要＋定位、流程面板搭建入口）不需要整页，先按此走。
- 工作台的扩展面板需要选中的会话（`workbenchTarget`）。没有选中会话时入口不可用，界面如实说明原因，**不假装已打开**、不自动新建会话冒充。
- 若将来真需要整页扩展面板，正确做法是让驱动侧注册「可整页的视图类型」并经既有 IPC 暴露，而不是在渲染层硬编码视图 id。

## 被否方案

- **加 activeView 分支直接渲染扩展前端**：否，理由见上 1/2。
- **把扩展面板做成新的独立页面组件，重写一份部门详情/流程界面**：否，同一份界面两份实现，必然漂移。
