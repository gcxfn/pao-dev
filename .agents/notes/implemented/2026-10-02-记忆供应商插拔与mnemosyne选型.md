# 记忆供应商插拔接口与 mnemosyne 选型（2026-10-02）

## 定案

- §18.1 语义记忆库的引擎升级为**插拔式记忆供应商接口**（架构 §18.5）：契约＝写入/召回/忘却（可选）＋能力声明；配置 `PAO_HOME/pao配置/记忆.json`，换供应商＝改配置；数据不自动迁移。
- **默认供应商＝mnemosyne**（PyPI `mnemosyne-memory`，`mnemosyne mcp` stdio 子进程挂载）；**兜底＝qmd**（零 Python 依赖，降级保召回闭环）。
- **与 Hermes 共用同一安装与同一记忆库**（用户定向「一个大脑」，当晚二问定案）：不自装、共享库；护栏＝pao 作者标识写入＋准入口径防污染＋版本随 Hermes 同批；分家逃生舱＝export/import 或 sync 定向同步（`sync_roles` 过滤用户级事实）。
- 同晚早先的「检索引擎终选 qmd」就此作废（门面从单引擎串行改为：供应商召回＋经验层文件检索并行两路）。

## 为什么共库（并推翻当晚早先「自装独立」的建议）

- 用户诉求实质：Hermes 已积累的用户/环境/偏好事实不想重新教一遍，两边此后学的互通——分 bank 满足不了。
- 共库必须同版，与其两套安装锁同版，不如直接复用 Hermes 的同一份安装，版本天然一致、零漂移。
- 多代理共库是 mnemosyne 设计内场景：`MNEMOSYNE_AUTHOR_ID` 作者标识、SQLite WAL、数据目录自带 `mnemosyne.db.init.lock` 并发初始化锁。
- 单人使用，Hermes 与 pao 主会话同时高频写库概率低，写竞争可忽略；共享不改变「记忆单点」现状（本来就只有一份）。
- 风险知情项：Hermes 的自动整理（sleep 巩固/persona/model refresh）会消化 pao 写入的内容——由准入口径（只有用户契约/环境/偏好类事实进库，任务态不入，R10）控制写入面来缓解；mnemosyne 4.x 是 beta 线，Hermes 升级带 schema 迁移时 pao 同批跑冒烟。

## 为什么

- 用户定向：「记忆插件作为一个插拔式的接口，可以调换别的记忆供应商」＋ Hermes 实用经验「光 MEMORY.md 不够，事实层还有个记忆供应商」。
- 机盘核实（2026-10-02，本机 Hermes 安装）：`mnemosyne-memory` 是通用记忆层而非 Hermes 专属——引擎包自带 `mcp_server.py`（stdio/SSE/HTTP 三传输，`mnemosyne mcp` 即起），有 CLI（store/recall/migrate 等），Hermes 只是它的一个宿主。
- 接入面干净：pi 原生支持 MCP，pao 把 mnemosyne 配成 stdio MCP server 即用，**零代码依赖、不增 rebase 面**；stdio 子进程随主会话生命周期，R05（不做常驻服务）相容。
- 引擎本身成熟：SQLite＋FTS5＋向量混合排序（词法 0.3/向量 0.5/重要性 0.2＋新近度半衰期），嵌入可 API 可本地（fastembed），用户已在 Hermes 侧日常使用。

## 被否方案

- **qmd 一把梭**（当晚早先终选）：能吃 markdown 但没有语义库的写入式增长模型，且用户明确要 mnemosyne 级供应商；降级为经验层文件检索件＋兜底供应商。
- **Node 同构自建向量库**（better-sqlite3＋FTS5＋sqlite-vec）：重造 mnemosyne 已成熟件，违背复用优先原则。
- **mnemosy.ai 的 TS 版 mnemosyne**（Aristotle Intelligence，MIT）：同名异厂，与本机 Hermes 侧数据/生态无亲缘，引入徒增混淆；其「TS SDK＋Memory Tools 虚拟文件操作」设计记档备查。
- letta/mem0 独立记忆服务：维持 §18.4 已否（过配）。

## 许可证与维护状态

- `mnemosyne-memory`：MIT，作者 Abdias J（github.com/mnemosyne-oss/mnemosyne），活跃（本机 4.0.0b3，随 Hermes 插件目录安装）。注意 4.x 是 beta 线；pao 不自装，复用 Hermes 同一份安装（共库必须同版，复用天然满足），mnemosyne 升级随 Hermes 走、pao 同批跑冒烟（召回＋写入各一条）——R21 订正，原「自装并互不捆绑」系共库定案前残句。
- 依赖面：需要本机 Python 3.10+（用户机器已有，Hermes 在用）。

## 实施红线

- **密钥边界**：mnemosyne 的嵌入密钥住它自家 config.yaml（用户已配 API 模式，bge-m3）；该文件含真实 key，**绝不拷贝进 pao 仓库/文档/日志**；pao 代码与文档只出现 `EMBED_*` .env 占位。
- 实施核（M2 接入时）：Windows stdio 冷启动延迟、每轮召回延迟预算、MCP 工具 exposure 控制（按需暴露勿全量灌给模型）、断链降级路径。
