# E 整合与审核验收

验收日期：2026-10-21（Asia/Shanghai）。最新结论：主直接实施回执执行根修复后，E 的五文件在同次 20 文件回归中共 **65 项通过**（execution-context 从 7 增至 9，其余数量不变）。[当前结果](checks/direct-kernel-receipt-final/results.json)共 179 项全通过、0 skip、exit 0，[前后摘要](checks/direct-kernel-receipt-final/summary.json)一致。桌面及发行结论见[最终报告](最终验收报告-待封板.md)，真实模型实验仍未运行。

## 上一阶段 63 项记录（历史证据）

| 测试文件 | 通过 | 证据与边界 |
|---|---:|---|
| integration.test.ts | 17/17 | [最终 JSON](checks/E-进程树补验/final-integration-configured.json)、[日志](checks/E-进程树补验/final-integration-configured.log)；真实 Git、临时受管根和检查子进程，包含受控整合、冲突、幂等、旧证据、检查期间修改与停止未确认保锁 |
| delivery-commit.test.ts | 20/20 | [最终 JSON](checks/E-取消窄修/delivery-commit-fixed.json)、[退出码](checks/E-取消窄修/delivery-commit-fixed.exit)；真实 Git 提交、既有 dirty/index 保护、受管执行根和真实取消父子进程。部分宿主登记与验收前置由测试夹具提供 |
| delivery-wakeup.test.ts | 9/9 | [主审 JSON](checks/main-e-final-review/delivery-wakeup.json)、[真实退出结果](checks/main-e-final-review/results.json)；装配与通知定向测试，不是真实模型 |
| execution-context.test.ts | 7/7 | [主审 JSON](checks/main-e-final-review/execution-context.json)、[真实退出结果](checks/main-e-final-review/results.json)；身份绑定与旧尝试边界 |
| card-process-stop.test.ts | 10/10 | [主审 JSON](checks/main-e-final-review/card-process-stop.json)、[真实退出结果](checks/main-e-final-review/results.json)；真实本地进程与受控故障注入，不能将注入树杀失败描述成系统自然失败 |

这些结果来自不同时间的定向运行，不能表述成一次全库测试。取消测试窄修只改变测试代理的字节转发和诊断，未改变产品行为，也未放松断言。完整交卷文件的最终运行没有跳过项。

## 源码与证据对应

- 主核 `checks/E-进程树补验/source-frozen.json.Files` 的六份产品源码仍逐一相同：baseline、delivery、verifier、execution-context、integration、process。
- 主核 [取消窄修冻结清单](checks/E-取消窄修/source-frozen.json) 的五项也全部相同，当前交卷测试摘要为 `152912CA5712A4EE271D292C764B236BBDE532F787E052A80881A106C2F49CDE`。
- [主审运行摘要](checks/main-e-final-review/summary.json) 记录真实生产类型检查退出 0、运行前后冻结记录相符。当时取消测试尚有一项失败，不能把该摘要本身写成全过；该红灯随后由上述独立窄修与完整 20 项通过关闭。
- baseline 误覆盖已精确恢复，当前 32,988 字节，摘要 `78271F2252985600FD01BECB80E79D1B0F4427FF7347AEA64E7B3B8920120130`。恢复来源与核验见[主审核接手记录](主审核接手记录-2026-10-21.md)。

## 失败证据与处理

先前五文件 59 项通过期间发生源码变化，不能作为当前版本的最终证明，原证据保留。误从仓根使用默认 5 秒测试配置的超时失败也保留；最终 integration 使用本包既有配置，没有为求绿削弱断言。

主审的交卷取消测试先后两次失败。新增诊断确认真实操作在取消点前就因工作目录身份不一致退出；测试里的 .NET 代理把 Git 路径先解码、再按默认控制台编码输出，破坏了中文路径。子代理改为直接转发原始 stdout/stderr 字节，保留真实 commit-tree、后代停止、无关进程存活、主仓 HEAD 和受控引用保护断言。详情及失败现场见 [E-取消窄修报告](E-取消窄修报告.md)。

## 仍需后续验收

桌面完整双工作树关键链、源码冻结后的解包发行物，以及真实 Terminal-Bench 4.0 模型实验分别记录，不由本报告代替。未触碰正式 PAO_HOME，未提交、推送或发布。
