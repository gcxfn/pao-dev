#!/bin/bash
# S9-内核包 旧名 grep 计数基线（只读统计，不改文件）
# 用途：S9 机器协议英文化前的旧名出现计数；收尾验收对照
# 输入：PAO 仓 D:\AI\workspace\pao-dev\PAO
# 输出：stdout（由调用方重定向到 证据/旧名grep基线.txt）
cd /d/AI/workspace/pao-dev/PAO || exit 1

SCOPES=(
  "coding-agent-src:packages/coding-agent/src"
  "coding-agent-test:packages/coding-agent/test"
  "evals:packages/evals"
  "scripts:scripts"
  "ai-offlimits:packages/ai"
)

NAMES=(
  # §1 工具名（40）
  pao_建卡 pao_交回执 pao_改状态 pao_查队列 pao_交接 pao_越界核查 pao_验收 pao_交卷
  pao_建部 pao_查库 pao_受限补查 pao_入库 pao_巡检 pao_派单 pao_终止卡 pao_盘点
  pao_停后台 pao_拉起部长 pao_散场部长 pao_记忆写入 pao_记忆召回 pao_记忆忘却
  pao_协作中转 pao_扇出 pao_节点控制 pao_启流 pao_判定包 pao_推流 pao_查流 pao_确认流
  pao_存流 pao_落配方 pao_复盘流 pao_部长交卡 pao_拆解结束 pao_交判定 pao_部长判定包
  pao_请求裁定 pao_体检 pao_体检探针
  # §2 参数键（含拆分的 goal/target 两名来源）
  卡目录 卡号 卡号列表 部门 知识库路径 项目根 工作区 目标 验收 输入 约束 档位 预算
  协作配额 优先级 模板 计数器路径 零卡理由 尝试号 结果 摘要 产物路径 证据 用量
  值得沉淀 失败类型 操作者 新状态 依据 尝试上限 沙箱根 命令超时秒 作者名 作者邮箱
  名字 标签 默认档位 查询 检索词 上限 期望版本 路由 候选路径 类型 新文件名 新钩子
  适用范围 验证出处 超期阈值天 记忆ID 确认 内容 深度 缓存探针 上下文字符数 采样点
  衰减阈值 落盘目录 理由 原因 首条消息 并发上限 后台 来源部门 插队 新权限 超预算覆写
  验收存疑 动作 节点 实例 轮次 失败轴 引用 原owner 参数 配方名 来源工作流 覆盖 部长会话
  # §3 卡协议
  待审 留档标记 留档 时间 创建 完成 尝试 状态 新建卡 人工确认 已确认 挂起 说明
  # §3.5 worker 契约
  卡路径 缺用量轮次 证据路径 live证据路径 liveStderr路径 命令 持续时间毫秒 执行标识
  派单理由 运行中 方式
  # §4 值域
  待认领 进行中 已交付 取消 瞬时故障 缺输入 能力不足 结果未知 节点控制 绑定 交卡
  拆解结束 判定 卡面 部门标准 两轴 教训 导览 做法 评测 自动 运行中 主控 人工
  旧尝试留档 迟到回执
  # §6 details 临时键
  供应商 降级原因 条数 记忆 在途 完成未读 受理卡数 已派出 已终止 落盘路径 报告
  模型 鉴权 探针 总用量 调用次数 pi版本 平台 标题路径 最后核验
)

printf "%-14s %-10s %-10s %-10s %-10s %-10s\n" "name" "ca-src" "ca-test" "evals" "scripts" "ai(禁)"
for n in "${NAMES[@]}"; do
  line=$(printf "%-14s" "$n")
  for scope in "${SCOPES[@]}"; do
    label="${scope%%:*}"; path="${scope#*:}"
    if [ -d "$path" ]; then
      c=$(grep -rF -o -- "$n" "$path" --include='*.ts' --include='*.tsx' --include='*.mjs' --include='*.js' --include='*.md' 2>/dev/null | wc -l)
    else
      c=0
    fi
    line="$line $(printf "%-10s" "$c")"
  done
  printf "%s\n" "$line"
done
