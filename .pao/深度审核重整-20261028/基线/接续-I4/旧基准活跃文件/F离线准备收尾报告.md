# F 离线准备收尾报告

> 本文下方为授权前的离线历史。2026-10-21 用户已批准 DeepSeek high、无预算上限及 Docker；当前 Linux 环境和真实调用证据统一见 [运行记录](真实对比运行记录.md)。下方“待授权”和预算建议已失效，不再约束当前运行。

日期：2026-10-21。**Windows 离线准备及最终源码快照已核，真实运行仍待授权。** Harbor 0.24.0 导入与三份真实 schema 校验通过；既有 adapter 7 项、usage 10 项与真实 SessionManager 离线 JSONL 汇总证据保留。完整 `pip check` 仍缺固定 litellm；不将 Windows 安装结果写成 Linux 成功。没有真实 benchmark 模型调用或 Docker 运行。

15:24 收尾：single/post 配置现指向同一份 [2299 文件源码 ZIP](source-freeze-20261021/PAO-source.zip)，SHA-256 `3f2d1f25076471cce3c05427cd1446178f8c012abf6a4619a6228c1d65341b17`，[逐文件清单](source-freeze-20261021/manifest.json)已重读核对。更新后的配置/Harbor schema 再验 exit 0，见 [当前日志](../checks/direct-implementation/benchmark-offline-final.log)。Windows 内核构建与实际桌面/解包发行专项通过，不能替代 Linux SDK/容器测试。下列安装经过保留为历史。

## 已修改与已准备

- 在指定 `f-harbor-import` 内创建 Python 3.12.14 venv，复制固定 Harbor 提交及必要 workspace 构建材料，优先复用本地 uv 缓存。原 Harbor 工作树未修改。
- 新增真实 SessionManager 探针与证据汇总脚本，使用产品源码写父、worker 两份 JSONL，再调用本轮 Python 汇总器。
- 更新本报告、F 准备稿、manifest 与依赖审核；历史报告与证据保存至 `evidence/prior-offline-close/`。产品、计划总册、正式 PAO_HOME 和其他代理文件未修改。
- 实际 venv 包清单写入 `requirements-venv.lock`。安装器为既有 uv 0.12.5；不把固定版本缺失的 `litellm` 换成其他版本。

## 已实际运行

- 显式解释器：指定 Python 创建 Python 3.12.14 隔离 venv；当前本机 Node 为 v24.19.0，目标 Linux 仍为 v24.18.0。
- 固定 Harbor wheel 离线安装成功；`import harbor` 与 `harbor.models.job.config` 成功，版本 0.24.0。
- `offline_validate.py` 真实解析三份配置并校验 `PAOAgent`／`PAOOptions`，exit 0。
- `test_pao_agent.py` 7 项通过；`test_usage.py` 10 项通过；`validate_preparation.py` 在 Windows 与 WSL 均通过；`single-entry.mjs` 语法检查通过。
- `uv pip check` exit 1，只报告 `harbor` 需要 `litellm>=1.92.0` 而未安装。
- 固定 `litellm==1.93.0` 的 wheel-only 安装失败：当前 Windows 无可用 wheel。已有缓存源码构建也失败：Rust 已启动，但 `link.exe` 缺失。
- 真实 `SessionManager` 生成 5 个父条目和 1 个 worker 条目；按 session+entry 汇总得到 input 191、output 28、cache 17、cache write 4、4 个计费事件、1 个未知 token/cost 事件，`complete=false`。

## 结果与限制

| 项目 | 真实结果 |
|---|---|
| Harbor import／schema／adapter | 通过 |
| Harbor 完整依赖 | 失败：仅 `litellm` 缺失 |
| 用量分类 | 通过：正常摘要不误判 unknown；辅助 usage 计入；custom unknown 保留；父回执不双计 |
| 产品真实 SessionManager JSONL | 通过；仍是离线夹具，不是模型调用 |
| Linux／Docker／真实模型 | 未运行 |

此前公开安装曾触发 `puccinialin` 在 `C:/Users/ASUS/AppData/Local/puccinialin/puccinialin/Cache/` 写入 Rust 工具链，随后已停止 PID 22556、26108、25668、41016。外部残留未删除，未修改系统 PATH 或服务。本轮再次离线构建时已明确失败在缺失 `link.exe`，没有继续安装 MSVC 工具链。历史明细见 [stopped-result.json](evidence/harbor-import-20261021/stopped-result.json)。

## 未验与固定边界

Windows 最终源码构建已通过，single/post 最终源码 SHA 与归档路径已固定；pre 两份 ZIP 重算 SHA 一致。Linux SDK、Docker/pre 启动、独立验收器与真实模型效果仍未验。

全部门／RPC／auxiliary session 覆盖面未验，PAO 用量仅为已观察下界；未知 token/cost 不按零，父回执汇总不能与子账本双计。Terminal-Bench 独立 Linux 题目不证明 Windows/Electron 或跨任务地图复用。主已用最终构建无模型实跑 single SDK 装配探针，规则、技能和四项初始工具保持，PAO 工具未混入，见 [当前探针日志](../checks/direct-implementation/benchmark-single-final.log)及退出码；旧 `evidence/single-probe.json` 保留历史身份，不当作新结果。

## 9 trial 与超时预算框架

首轮为 3 组 × 3 题 × 1 次 = **9 trial**；并发 1、尝试 1、自动重试 0。沿公开元数据的当前时限：

| 任务 | 环境构建 | agent | verifier |
|---|---|---|---|
| `html-js-filter` | 600 秒 | 28800 秒 | 1800 秒 |
| `bun-sourcemap-leak` | 600 秒 | 28800 秒 | 600 秒 |
| `nextjs-performance` | 900 秒 | 28800 秒 | 300 秒 |

三组相加的 agent 上限为 259200 秒，环境构建 6300 秒，验收 8100 秒；合计 76 小时，仅为这些固定阶段的顺序预算框架，另加安装 smoke、源码构建、拉取、日志留存及基础设施等待。不是实测耗时或已批准的运行上限；正式运行前必须设置总墙钟、每题墙钟和安装时限，到线停止，不自动加轮数。

费用按全部角色及辅助调用的输入／输出／缓存读写／失败与重试，加基础设施分别记录；先固定供应商单价，再设总 token、总金额和每题硬上限。未知保持 unknown，不预设节省百分比。

## 后续授权缺项

1. 指定实际模型标识和思考档位。
2. 指定总 token 或美元预算，并授权真实模型调用与发送公开任务输入。
3. 授权启动或连接 Docker Desktop Linux engine，进行 Linux SDK／容器安装 smoke 与真实验收。

用户模型、思考档位、总预算或 Docker 授权到位前，不运行真实实验。

## 精确入口

- 本轮每项命令与 exit：`.pao/地图简报与部门协作-20261020/benchmark/evidence/offline-close-20261021/results.json`
- Harbor import／schema／adapter 原始日志：同目录 `harbor-import.log`、`offline-validate.log`、`test-pao-agent.log`、`pip-check.log`
- 用量测试与真实 SessionManager：同目录 `test-usage.log`、`real-session-usage.log`；临时目录内另有两份真实 JSONL 和 `aggregate-result.json`
- 固定 litellm 源码构建失败原文：`D:/AI/workspace/临时文件夹/地图简报基准-20261020/f-harbor-import/install-litellm-cached-source-offline.log`
