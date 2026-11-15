# F 离线准备收尾报告

日期：2026-10-21。结论：离线准备已收尾，真实运行仍未验。本轮只写 benchmark 与指定临时独立目录；未改产品、计划总册或正式 PAO_HOME，未安装依赖、启动 Docker 或调用模型。没有跨写需求。

## 修改与原因

| 文件 | 改动 |
|---|---|
| `scripts/single-entry.mjs`、`scripts/probe-single.mjs` | 用现有 SDK 的 `extensionFactories` 只装共同四扩展，避免导入 PAO 时注册业务钩子；规则／技能沿真实加载器装配 |
| `map_bench_pao/pao_agent.py`、`test_pao_agent.py` | 修正 single 边界；pre 直接核两份 ZIP；post/single pending 拒绝安装；从同一归档构建 CLI／SDK；去除 nvm 入口假设和重复 prompt 模板装饰；失败与同步错误不吞掉 |
| `configs/{single,pre-pao,post-pao}.yaml`、`fixed-manifest.json` | 固定相同模型占位符、off、任务 refs、环境、构建命令、并发 1／尝试 1／重试 0；资源与独立验收沿固定任务元数据 |
| `map_bench_pao/usage.py`、`test_usage.py` | 原生会话按 session+entry 去重；覆盖各角色、辅助调用、压缩、失败与缺用量；不把回执内容汇总再加到子账本 |
| `scripts/offline_validate.py`、`scripts/validate_preparation.py` | 真实 Harbor schema 检查和标准库准备检查分别报告；不使用模拟依赖伪装集成通过 |
| `public-inputs.json`、`dependency-audit.json`、准备稿、`evidence/` | 公开输入逐文件摘要、直接依赖许可证／维护状态、原始日志与实际工具／规则／技能证据 |

原有 tracked SHA 在 manifest 中少一位；已改为主验 `.sha256` 文件及实算一致的 `1127a01e7aba02309291958fd25d9e583d743dcae72b6b8b3dba45a12ccf2b80`。untracked 保持 `bd4c76811efd005b9db54a8c3f4db771aeb8bc425ab12e275163cc9455f597d6`。仅核两份归档摘要，没有重复主验的逐文件重建。旧选题偏差说明完整保留在准备稿及 manifest。

## 已检查和实际运行

解释器均用绝对路径：Python `C:/Users/ASUS/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe`（3.12.14）；Node 同根 `dependencies/node/bin/node.exe`（v24.19.0）。TMP／TEMP／TMPDIR 均指向 `D:/AI/workspace/临时文件夹/地图简报基准-20261020/f-offline-close`，Python 禁写字节码。

| 实际命令（相对 benchmark） | 结果 |
|---|---|
| Python `scripts/offline_validate.py` | exit 1，`ModuleNotFoundError: No module named 'yaml'` |
| Python `test_pao_agent.py` | exit 1，`ModuleNotFoundError: No module named 'harbor'`；测试体尚未执行 |
| Python `scripts/validate_preparation.py` | exit 0，三组公平项／固定身份／pre 真实归档摘要／Python 语法通过 |
| Python `test_usage.py` | exit 0，8 项测试通过，全部为模拟事件，无真实模型 |
| Node `scripts/probe-single.mjs D:/AI/workspace/pao-dev/PAO <独立目录>/sdk-probe` | exit 0，真实 SDK 装配；样例规则和技能进入系统提示；禁用 fetch，无模型调用 |
| Node `--check scripts/single-entry.mjs` | exit 0，语法检查通过 |

可复跑命令：`& 'D:/AI/workspace/临时文件夹/地图简报基准-20261020/f-offline-close/run-checks.ps1'`。脚本记录每项完整绝对命令、退出码及日志位置到 `results.json`，副本见 [check-results.json](evidence/check-results.json)。失败原文见 [offline-validate.log](evidence/offline-validate.log)、[test-pao-agent.log](evidence/test-pao-agent.log)。未借用旧 3.13 venv 冒充指定 3.12 解释器，也未安装缺失包。

single 实测：初始 `read/bash/edit/write`；全部注册工具为 `read/bash/powershell/edit/write/grep/find/ls/codemode/tool_search`；扩展为 `builtin:llama.cpp/codemode/tool-search/mcp`，无 `pao_*`。样例 AGENTS 规则、技能摘要都进入系统提示；正常发现本机用户技能但未执行。完整输出见 [single-probe.json](evidence/single-probe.json)。

源码和已有 dist 都没有 `includePaoBuiltinExtension` 选项，不能传一个被忽略的属性假装生效。证据入口为 `PAO/packages/coding-agent/src/core/sdk.ts` 的 `CreateAgentSessionOptions`、`core/resource-loader.ts` 的 `DefaultResourceLoaderOptions`／构造函数、`src/main.ts` 的 `MainOptions` 和 `scripts/build-coding-agent-bundle.mjs`。入口只从 `PAO_BENCH_SOURCE/packages/coding-agent/dist` 导入 SDK；同一源码构建产生 PAO CLI bundle，安装时不再抓另一份源码。本机探针记录当前 source/dist/bundle 摘要用于定位，不将其写成最终源码归档 SHA。

## 未验和限制

- Harbor 依赖链、schema 和修改后适配器行为尚未真实跑通；标准库检查不替代它们。`pydantic` 安装元数据存在，`yaml`／`harbor` 缺失原错已保留，后续依赖链缺什么仍需实际暴露。
- 当前 dist 只证明本机已有构建可装配。最终 single/post 归档路径和源码 SHA 都为 `pending`；封板后必须用同一归档构建，并复验 Linux 下规则、技能、共同扩展、工具及项目配置的信任行为。
- pre 构建与启动、三题环境依赖安装、separate 验收路径、真实模型成功率／成本／时长均未验。目标 Linux Node 仍固定 v24.18.0，本机 v24.19.0 不能替代目标环境验证。
- 当前适配器收集主会话及 `/app/.pao/worker会话`；部门/RPC 及全部辅助调用是否已完整归档未证明。PAO `context` 总费用／token 为未知，仅在 metadata 提供已观察下界；不得用于宣称全角色节省。
- 隔离 PAO_HOME 尚未经过配方／路由／各 worker 同模型同思考档位的 smoke 核验；不读取正式现场补齐。CLI 无 managed host 时不能宣称桌面托管工作树收益。
- 固定公开输入与资源／验收元数据已离线核对；任务依赖许可正文缺失和当前维护状态保持未验／unknown。Bun task 未声明 GPU，未虚填为零；TypeScript 是该题源码语言，未虚列成 npm 直接依赖。
- Terminal-Bench 独立 Linux 题目不能证明 Windows/Electron 或跨任务地图复用；样本按公开输入形成准备方分类，不是官方难度结论。

## 需要用户授权的后续项

建议主对话在产品最终封板和缺依赖处理完成后，集中确认 Docker Linux engine、精确模型、思考档位、公开输入发送给模型供应商的授权，以及总 token／金额硬上限。没有发布、上游上传或 login 的需要。

首轮预算框架为 **3 组 × 3 题 × 1 次 = 9 个独立 trial**，另列安装 smoke 和基础设施费用。覆盖主控、侦察、规划、各部门／worker、审核、重试、压缩和辅助调用；缓存读写单列，未知费用不按零。先按已固定供应商单价计算输入／输出／缓存费用，再设总额与每题硬上限、到线停止和人工介入规则；本轮未固定价格，不能猜金额。不得自动追加轮数或预设节省百分比。
