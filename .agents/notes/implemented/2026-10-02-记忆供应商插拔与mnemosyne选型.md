# 记忆供应商插拔接口与 mnemosyne 选型（2026-10-02）

## 定案

- §18.1 语义记忆库的引擎升级为**插拔式记忆供应商接口**（架构 §18.5）：契约＝写入/召回/忘却（可选）＋能力声明；配置 `PAO_HOME/pao配置/记忆.json`，换供应商＝改配置；数据不自动迁移。
- **默认供应商＝mnemosyne**（PyPI `mnemosyne-memory`，`mnemosyne mcp` stdio 子进程挂载，`--bank` 与 Hermes 分库）；**兜底＝qmd**（零 Python 依赖，降级保召回闭环）。
- 同晚早先的「检索引擎终选 qmd」就此作废（门面从单引擎串行改为：供应商召回＋经验层文件检索并行两路）。

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

- `mnemosyne-memory`：MIT，作者 Abdias J（github.com/mnemosyne-oss/mnemosyne），活跃（本机 4.0.0b3，随 Hermes 插件目录安装）。注意 4.x 是 beta 线，pao 侧自装 `mnemosyne-memory[mcp]` 并锁版（与 Hermes 的安装互不捆绑），升级按批次纪律。
- 依赖面：需要本机 Python 3.10+（用户机器已有，Hermes 在用）。

## 实施红线

- **密钥边界**：mnemosyne 的嵌入密钥住它自家 config.yaml（用户已配 API 模式，bge-m3）；该文件含真实 key，**绝不拷贝进 pao 仓库/文档/日志**；pao 代码与文档只出现 `EMBED_*` .env 占位。
- 实施核（M2 接入时）：Windows stdio 冷启动延迟、每轮召回延迟预算、MCP 工具 exposure 控制（按需暴露勿全量灌给模型）、断链降级路径。
