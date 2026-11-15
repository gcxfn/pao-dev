# F 真实对比最小准备

更新日期：2026-10-21

## 结论

已完成三组离线配置、single SDK 薄入口和公开输入摘要。真实 SDK 装配已证明样例规则／技能保留；8 项模拟用量测试及配置一致性检查通过。原有 Harbor 检查实际执行后因缺依赖中止，Docker 和真实模型未运行，尚不能宣称三组可运行或有收益。完整证据见 [F离线准备收尾报告](F离线准备收尾报告.md)。

## 固定身份

| 项目 | 固定值 | 核验方式 |
|---|---|---|
| Terminal-Bench | `4.0` | 官方发布页 |
| 数据集 | `terminal-bench/terminal-bench@4.0.0` | 官方 4.0 说明 |
| Terminal-Bench tag | `v4.0.0` | `git ls-remote` |
| Terminal-Bench commit | `452bf305c6daa62fc59061d22133a7cbc7c1572e` | 远端 tag 与本地 HEAD |
| Harbor commit | `77094ca610014a3c7c2dcac6a29ef01f7ef800c8` | 本地固定检出 |
| Harbor 版本 | `0.24.0` | 固定提交的包元数据 |
| 目标 Linux Node.js | `v24.18.0` | 继续使用前稿固定下载身份；本轮未联网下载 |
| 本轮本机探针 Node.js | `v24.19.0` | bundled Node 实际输出，符合项目 `>=22.19.0` 声明；不等同 Linux 验证 |
| Node Linux x64 SHA-256 | `55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742` | 官方下载文件 |

## 三项候选

| 任务 | 用途定位 | 依据 | CPU / 内存 / 磁盘 | 环境构建 / 验收时限 |
|---|---|---|---|---|
| `html-js-filter` | 边界清楚的小修改 | 任务说明聚焦单一前端过滤需求；专家时间估计 0.75 小时 | 2 / 8192 MB / 10 GB | 600 秒 / 1800 秒 |
| `bun-sourcemap-leak` | 需要调查根因的中等任务 | 任务说明要求定位产物泄露来源；专家时间估计 1.5 小时 | 2 / 4096 MB / 10 GB | 600 秒 / 600 秒 |
| `nextjs-performance` | 多路由、跨模块的并行改造候选 | 任务说明涉及多个页面与性能约束；专家时间估计 3 小时 | 2 / 4096 MB / 15 GB | 900 秒 / 300 秒 |

这三类定位是根据公开任务说明和元数据形成的审阅分类。Terminal-Bench 4.0 没有官方承诺每项任务分别代表“小任务、调查任务、可并行任务”，不能把此分类写成官方结论。

## 三组身份

| 组 | 源码身份 | 运行方式 |
|---|---|---|
| `single` | 修复后 PAO 的同一源码；最终归档路径／SHA 为 `pending` | `scripts/single-entry.mjs` 从同一解包源码的 dist 调 SDK，只装共同扩展，不导入 PAO 模块 |
| `pre-pao` | A 基线重建源码 | 旧 PAO 实际流程；不加入新地图、简报和部门协作能力 |
| `post-pao` | 最终修复后的 PAO | 允许按任务调用地图、简报和部门协作能力 |

A 基线提交为 `a2380612e69f38a0d21e7dd9586e65c42f8fb20e`。主验已通过 tracked + untracked 字节重建；本轮只引用该结论并核对两份归档摘要。旧 PAO 启动／任务完成仍未验。pre 配置直接使用这两份 ZIP，不把基线重建成另一份未固定源码。post 与 single 最终封板前保持 `pending`，安装入口拒绝 `pending`。

当前源码没有 `includePaoBuiltinExtension`；实际可用的是资源加载器的 `extensionFactories`。single 使用 `llama.cpp`、`codemode`、`tool-search`、`mcp` 四个原有工厂，不设置 `noExtensions/noSkills/noContextFiles`。本机实测初始工具为 `read/bash/edit/write`；全部已注册工具含 `powershell/grep/find/ls/codemode/tool_search`。Windows 专属工具不代表 Linux 工具表，最终容器须复验。探针还正常发现本机用户技能，这只是发现机制证据，未执行任何技能，也不把本机技能打包给被测 agent。

## 公平边界

- 三组共用模型、思考档位、Harbor/TB/Node 版本、基础工具、代码读写能力、构建步骤、独立 `PAO_HOME`、初始输入和验收器。
- 三份 [配置](configs/) 均为 JSON 形式的合法 YAML；模型为相同占位符，思考档位固定为 `off`（真实运行前仍须用户确认）。任务使用固定 `hub_task_ref`，资源／独立验收模式／时限沿对应公开 `task.toml`，无覆盖值。
- 四项共同初始工具沿原生默认装配，保留其他基础工具与共同扩展的可发现能力；PAO 组额外业务工具属于待测差异。不得通过 `--tools` 把 PAO 业务工具一并关掉，也不得另设不一致的 `defaultTools`。
- 每组每题使用独立容器和初始输入，不共享修改结果、会话或运行数据。
- `n_attempts=1`、`retry.max_retries=0`、`n_concurrent_trials=1`。
- 单代理保留原生 Git、项目规则、技能和正常验收。PAO 地图、简报、部门调度和托管工作树属于待测差异，不要求单代理模拟。
- 不向 agent 注入 Task README、`solution/`、`tests/`、`cheat/`、oracle 或隐藏验收正文。

## 当前验证等级

| 项目 | 状态 |
|---|---|
| 官方版本与候选任务元数据 | 已核实 |
| 最小审阅稿 | 已完成 |
| 三组配置／manifest 一致性 | 标准库检查通过；不是 Harbor schema 验证 |
| single 规则／技能／实际工具 | 当前已有 dist 的真实 SDK 离线装配通过；不是最终源码封板证明 |
| 用量去重／未知与不双计 | 8 项模拟事件测试通过；未调用真实模型 |
| Harbor schema／适配器测试 | 已真实执行，分别缺 `yaml`／`harbor`；原始失败日志保留 |
| 全角色原生会话覆盖 | 未验；PAO 总 token／费用保留未知，已观察下界单列 |
| Docker 容器安装 | 未验，Docker Linux engine 未启动 |
| 真实模型调用、通过率、费用 | 未验，尚未指定并授权 |
| Windows/Electron | Terminal-Bench 不能证明，保留专项验收 |
| 跨任务地图复用 | Terminal-Bench 单题独立容器不能证明，保留专项验收 |
| CLI 缺少 managed host 时的收益 | 独立容器未必覆盖，保留专项验收 |

公开输入的文件路径、字节数和 SHA-256 见 [public-inputs.json](public-inputs.json)，不含文件正文。依赖许可证来源和维护状态见 [dependency-audit.json](dependency-audit.json)：固定仓库许可证已核对；任务依赖旧稿许可声明缺少正文者标未验，维护状态保留 unknown。Bun 项目的 package.json 无 TypeScript npm 依赖，已纠正旧稿误列；其 GPU 字段公开元数据未指定，保留未知。Terminal-Bench 不能证明 Windows/Electron 或跨任务地图复用。

建议预算按 3 组 × 3 题 = 9 个独立 trial 制定，另列安装 smoke 与失败留存；不自动追加次数。全角色输入／输出／缓存读写、辅助调用、基础设施费用和人工介入均计入；先固定供应商价格及总 token／金额硬上限，再确定每题上限。未固定模型价格时不猜金额，也不预设节省比例。PAO 配方／路由及所有 worker 模型档位需在隔离 smoke 中核对，不从正式 PAO_HOME 复制。

## 尚未授权

1. 启动或连接 Docker Desktop Linux engine。
2. 指定实际模型标识与思考档位。
3. 指定 token 或美元总预算。
4. 明确授权对应的真实模型调用。

另需如实保留两项准备过程偏差：曾为选择候选读取过部分任务 `README.md`，其中可能包含解法或验证提示，但未复制答案或验收正文，也未据已知模型成功经验筛题；首次非稀疏检出让 `solution/`、`tests/`、`cheat/` 短暂出现在工作树，未打开旧检出的隐藏内容，随后已删除并按固定元数据重新准备。
