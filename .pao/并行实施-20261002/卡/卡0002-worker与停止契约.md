---
目标: 在 PAO fork 内实现 headless worker 运行器:拉起/结构化回执收集/取消先停后放锁/主会话退出停进程树/重启只读盘点
部门: 核心机制
输入: [plans/v2-ARCHITECTURE.md §1 后台运行契约/R05, plans/已完成/2026-10-02-实施前契约修订.md R05, PAO/packages/coding-agent/examples/extensions/subagent/index.ts(spawn与JSON事件流参考), .pao/并行实施-20261002/黑板.md]
约束: 只动 PAO/packages/coding-agent/src/pao/worker/ 与 test/pao/worker-*.test.ts;不碰其余源码
验收: 见正文
depends_on: []
档位: 主力
预算: { turns: 40 }
优先级: 高
owner: 主控
尝试: 1
创建: 2026-10-02 21:00
状态: 已交付
---

## 设计要点

- 回执落盘与状态推进**不归本卡**:worker 运行器通过回调/返回值把结构化回执交给调用方(主控接线时接 A 卡 `pao_交回执`)。本卡只负责进程生命周期与回执收集。
- 项目写锁:本卡提供锁原语(获取/释放/查询),「取消先停后放」顺序契约在运行器内实现;锁本身管受 PAO 调度的写,不承诺拦外部编辑器(架构 R06)。

## 验收(全部机械可判,逐条附测试;今晚无真实模型端点,worker 可用 `--print` 假任务/echo 脚本代替模型交互测进程管理)

1. **拉起与回执收集**:参考 subagent 示例 spawn 本仓库 pi(`--mode json -p --no-session` 等价入口,或直接以 node 跑仓库入口,写明选择依据);从 stdout JSON 行收 `message_end` 聚合 usage(input/output/cacheRead/cacheWrite/cost 各自分开)、stopReason、exitCode、stderr;用量只从事件流取,不采信模型自报。
2. **回执结构**:卡号+尝试号+状态(成功/失败/取消/未知)+产物路径+≤3行摘要+用量+证据路径;缺任一必填字段的回执判无效。
3. **取消顺序**:取消 = ①阻止新调用 ②停执行并**确认真停**(进程退出或 kill 后 reap)③才放项目写锁——顺序在代码结构上可验证(如放锁必须传入停止确认凭据);测试:取消期间锁未释放,停妥后释放。
4. **进程登记表**:运行器登记本轮拉起的全部进程(pid、命令、卡号);提供 `stopAll()`;主会话退出钩子(session_shutdown / process exit)调 stopAll;只处理登记在案的进程,不按进程名全局清理。
5. **Windows 停树**:子进程再派孙进程时,停止用 `taskkill /PID <pid> /T /F` 或等价树杀(写明依据);对「强杀主进程留尾巴」的场景在交付说明如实标注限制(调度单允许:哪种停不干净就如实报告)。
6. **重启只读盘点**:提供 `盘点()` 纯读函数:扫工作区卡目录列未完卡(状态+尝试数+最后回执摘要)+ 对开工基线的 git status 差异摘要;绝不写文件、不清锁、不重跑。
7. **worker 无再派发入口**:构造 worker 启动参数时工具白名单可选传入(接线时主控定白名单);本卡测试验证白名单参数确实传到子进程命令行。
8. **尝试计数统一**:同一卡的重试由运行器统一计数(同一调度轮次内),子进程内部失败不触发独立重试;计数器供调用方读。

## 交付

- `src/pao/worker/` 模块(index.ts 导出 `registerWorkerTools(pi)` + 纯库:`runWorker`/`cancel`/`stopAll`/`盘点`/锁原语)
- 测试 `test/pao/worker-*.test.ts`(进程管理测试用轻量假进程:node -e 或脚本,不依赖模型端点)
- 交付说明 `.pao/并行实施-20261002/产物/卡0002-交付说明.md`:API 签名、Windows 停树实测结果与已知限制
