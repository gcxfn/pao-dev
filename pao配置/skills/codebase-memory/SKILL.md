---
name: codebase-memory
description: 改函数、重构、修 bug 前先用 codebase-memory 代码图查调用链与影响面。当任务涉及"这个函数被谁调用""改动会影响哪些地方""追踪一条调用路径""搜索代码图"时使用;已建图项目首次开工先建图。无代码图数据或服务器不可用时直接退回普通读码,不要卡住。
license: MIT
compatibility: 本机已安装 codebase-memory-mcp（C:/Users/ASUS/.local/bin/codebase-memory-mcp.exe），缓存目录 D:/cbm-cache（env CBM_CACHE_DIR）
metadata:
  仓库内来源: PAO 根 AGENTS.md 工作规则第 9 条
---

# 代码图优先：先查影响面，再动代码

改代码前先查代码图，代替逐文件翻读。代码图按项目分库存放在 `D:\cbm-cache`，随文件改动自动同步。

## MCP 工具（pao 会话已挂 codebase-memory 服务器时首选）

工具名前缀 `mcp__codebase-memory__`，常用：

- **建图**（项目首次开工做一次）：`index_repository`，参数给仓库绝对路径，如 `D:\AI\workspace\pao\PAO`。
- **查影响面**：改函数/重构前查调用链——`trace_path`（追一条从调用方到被调方的路径）、`search_graph`（按符号搜索图节点与边）。
- 图过期（服务未运行期间发生了大改动）时先用 `index_status` 确认，过期再 `index_repository` 重建。

## CLI 兜底（MCP 未挂或会话外）

`codebase-memory-mcp` 本体在 `C:/Users/ASUS/.local/bin/codebase-memory-mcp.exe`，可用子命令直跑：

```
codebase-memory-mcp cli --quiet index_repository --repo_path <项目绝对路径>
codebase-memory-mcp cli --quiet trace_path ...
```

## 纪律

- **先查再改**：这是 pao 工作规则第 9 条，不是可选优化；重构/修 bug/改函数签名前必查。
- **不手改缓存**：`D:\cbm-cache` 下的库文件由工具自动维护，出问题用重建，不手工编辑。
- **降级明确**：查不到图（未建图/服务器不可用）就明说"未用代码图，逐文件确认过"，再动手；不要假装查过。
