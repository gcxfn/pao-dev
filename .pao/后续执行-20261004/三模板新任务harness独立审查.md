# 三模板新任务harness独立审核

2026-10-04，只读检查 `临时文件夹/PAO-对照验收-20261004/冻结三模板内核.mjs` 和 `三模板业务验收.mjs`；未修改脚本、未执行API或构建。

必须收口三点：

1. actualTask存在但parameters缺失时，`actualTask?.parameters ?? 冻结样本参数` 会静默退回T1/T2目标。独立新任务应强制校验parameters对象及项目/目标/范围/验收所需字段，缺失拒绝，不能回退冻结目标。
2. prepare仅冻结baseline，未存actualTask参数和预算；同kind/runId/baseline替换任务JSON内容仍可执行。应prepare存完整任务或其hash，run/recover核对，避免准备与执行目标/预算漂移。
3. actualTask支持feature/review，但workerTurns逐节点核验只在bugfix分支。这两种真实模板可能未采用该预算，而报告仍载入新任务预算。建议当前实际需求仅bugfix时显式限制新任务kind；否则各kind均启动前核预算。

其余核对：

- 内核清单独占文件名、wx防覆盖，四包dist逐文件hash；构建退出码仍明确由主代理核验，不伪称脚本证明。
- 参数完整的actualTask优先于T1目标；项目强绑定独占工作树。baseline支持独立新源码快照，run前HEAD及clean核验。
- 唯一600/2账本仍强校验；requestAllowance明确只是观察阈值，50ms轮询可能有在途超出，不是假装严格子额度。旧失败卡/工作树不覆盖，recover单独保留尝试。
- 凭证仅zai-coding-cn复制到隔离私有配置，finally删除，未见打印凭证字段。授权供应商仍通过既有档位解析，未新增网络搜索或模型供应商调用。调用环境继承process.env为既有行为，本次新增任务JSON只给本地文件，不直接读取认证文件。
- 未把RPC成功等同业务通过；控制未完成明确失败；人机确认仍取消并保留真实人工请求。

修后须保持原样本断言及原失败证据。此报告仅脚本独审，不代表三模板真实业务验收通过。

整改复核：两脚本node --check通过，实际任务已限bugfix、7字段必填、预算明确、准备保存完整actualTask。残余一处：deepEqual应无条件执行；当前if(actualTask)在执行时漏传任务变量会绕过完整任务核验。两边undefined的原样本仍可通过无条件比较，故无需牺牲原流程。已通知主代理。

最终复核：deepEqual已无条件执行，缺失actualTask也拒绝漂移；原样本两侧undefined仍兼容。node --check通过，以上发现全部关闭。
