# 扩展运行时复用 SDK 导出

核实日期：2026-11-19。

内核加载扩展时需要会话、工具和界面组件，但根入口还导出 CLI 的 `main`，其闭包包括 MCP 命令入口。公开接口没有单独的共用导出面，导致扩展加载器把 CLI 装配带回内核。

将共用导出集中到 `PAO/packages/coding-agent/src/sdk.ts`，根 `index.ts` 继续汇出全部 SDK 及 `main`、`MainOptions`。虚拟模块和未打包 Node 运行时别名均指向共用 SDK。扩展的两种包名、会话、工具、界面组件与类型保持同一实现。

CHANGELOG 的 #5202 明确向扩展作者提供 `parseArgs` 和 `Args`。将纯参数解析移入 `core/args.ts`，CLI 原路径继续转出同一函数和类型，帮助输出留在 `cli/args.ts`；SDK 与扩展保留参数解析能力。文档、示例和测试没有扩展调用 `main` 的支持用法；`main` 是独立 CLI 启动装配，由普通包根入口提供，扩展运行时只提供共用 SDK。

影响面限根入口和扩展加载装配，不改变业务实现或门禁规则。升级上游时，将新增 SDK 导出并入 `sdk.ts`；运行现有 `gate-boundary.mjs`，以及 `pao-sdk-extension-boundary.test.ts`、扩展延迟加载和 Node SEA 回归，核对根入口契约、两种扩展包名与嵌入运行时装配。未打包产物需在发行验证中确认生成 `dist/sdk.js` 并能经别名加载扩展。
