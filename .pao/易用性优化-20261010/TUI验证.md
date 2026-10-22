# TUI 验证

- 验证日期：2026-10-11
- 范围：PAO fork 的 `packages/coding-agent/src/pao/` 面板、工作流引导、全景详情；不含 pi 本体、`packages/tui` 和桌面端。
- 正式 `D:\AI\workspace\pao`、正式用户目录和凭证未作为测试对象。

## 代码与组件验证

以下检查针对当前工作树执行，均成功：

- `pnpm exec vitest run packages/coding-agent/test/pao/panel-view.test.ts packages/coding-agent/test/pao/panel-settings.test.ts --config packages/coding-agent/vitest.config.ts`：2 个文件、26 项通过。
- `pnpm exec vitest run packages/coding-agent/test/pao/workflow-tools.test.ts packages/coding-agent/test/pao/panorama-page.test.ts packages/coding-agent/test/pao/workflow-instance-scan.test.ts --config packages/coding-agent/vitest.config.ts`：3 个文件、55 项通过。
- `pnpm exec tsc --noEmit -p packages/coding-agent/tsconfig.build.json`：通过。

新增回归覆盖：12/16/24 行与 resize、无结果后退格恢复、记忆配置缺失/非法 JSON/字段错误/合法关闭/不可读、v2 实例详情、同名实例跨项目选择，以及工作流引导选择实际卡目录。

## 真实 Windows ConPTY 验证

先执行：

```text
npm run build:offline
```

构建成功，生成当前 fork 的 `packages/coding-agent/dist/bundle`（74 个文件，约 9.4 MiB）。随后执行：

```text
node D:/AI/workspace/临时文件夹/PAO易用性优化-20261010/tui/verify-conpty.mjs
```

进程退出码为 `0`，脚本报告以下项目全部通过：

- ConPTY 启动与 `/pao` 面板打开；
- 终端 12、16、24 行 resize 后进程保持运行；
- 搜索无结果后继续输入、退格恢复中文筛选；
- 全景同名实例选择后详情定位到第二个卡目录；
- `/quit` 正常退出，退出码为 `0`。

脚本使用严格环境白名单，只保留运行 Node/ConPTY 所需的系统变量，并显式设置隔离 `PAO_HOME`、`PAO_CODING_AGENT_DIR`、`PAO_CODING_AGENT_SESSION_DIR`、`HOME/USERPROFILE`、临时目录、`PI_OFFLINE=1`、`PI_NO_LOCAL_LLM=1`、`--no-skills` 和 `--no-context-files`。脚本没有继承凭证或其他 `PAO_*` 变量；运行结束只清理脚本自己创建的现场目录。

证据文件：

- 脚本：`D:\AI\workspace\临时文件夹\PAO易用性优化-20261010\tui\verify-conpty.mjs`
- 结果：`D:\AI\workspace\临时文件夹\PAO易用性优化-20261010\tui\结果.json`
- 原始终端输出：`D:\AI\workspace\临时文件夹\PAO易用性优化-20261010\tui\终端原始输出.txt`

## 限制

ConPTY 运行使用隔离的离线现场和 v1 挂起实例夹具，未调用真实模型、供应商或正式项目数据；v2 详情和工作流冻结配方由内核单测覆盖。启动时出现 `档位.json` 缺失和离线模式下 `fd` 不下载提示，属于隔离现场的预期提示，不影响上述面板交互结果。桌面端本轮未启动实测。
