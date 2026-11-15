/**
 * PAO 角色解析(M1-04 / R10 装载清单的代码锚点;M2-01 增部长角色)。
 *
 * 三角色装载面不同:worker 会话(WorkerRunner 拉起的 `pao --mode json -p --no-session`
 * 子进程)必须无 PAO 再派发/全库管理/自动推进/验收交卷入口;部长会话(在线宿主拉起的
 * RPC 常驻子进程)是 owner 侧的部门负责人,装载面＝主控减扇出与中转——不止藏提示词,
 * 而是扩展注册层直接跳过(G1-12:检查直接+间接入口;间接入口如巡检落卡钩子也随模块
 * 一起不注册)。
 *
 * 门控方式:环境变量 `PAO_ROLE`。WorkerRunner/在线宿主拉起子进程时强制注入,
 * 主控会话不设或设其他值一律按「主控」处理——缺失不静默变成低权限角色,反之亦然。
 */

export type PaoRole = "主控" | "部长" | "worker";

/** 角色环境变量名 */
export const PAO_ROLE_ENV = "PAO_ROLE";

/** 解析当前进程的 PAO 角色;未设置/无法识别时按主控处理(保守侧:主控装载面是超集) */
export function resolvePaoRole(env: NodeJS.ProcessEnv = process.env): PaoRole {
	const raw = (env[PAO_ROLE_ENV] ?? "").trim().toLowerCase();
	if (raw === "worker") return "worker";
	if (raw === "部长" || raw === "minister") return "部长";
	return "主控";
}

/**
 * 部长角色下跳过注册的模块(M2-01 设计包 §6 装载面差异表,2026-10-02 深夜定案):
 * - fanout:R10 预留口径——部长审卡不派扇出,再派发归主控。
 * - collab:协作中转是星型拓扑里主控专属的路由器(待决②已批)——部长起草协作卡走
 *   pao_create_card 经主控中转;部长自装中转则星型退化网状,路由裁决点碎裂。
 * - host:拉起/散场部长会话是主控专有(星型纪律:主控是唯一唤醒源,§8.6)——
 *   部长不再拉部长(worker 不递归的部长侧对称),通知面与保险丝钩也不装。
 * 其余全保留:cards(部长是 owner,审回执/落终态)、worker(派单与停树面)、
 * knowledge 全量(部门终审)、verifier/delivery(workflow 驱动时部长即 owner)。
 * - resident(§18.1):常驻索引注入/每轮自动召回/压缩交接是主控门面——部长的记忆
 *   需求走保留的 pao_memory_write/recall 工具,不叠每轮注入面。
 */
export const MINISTER_SKIPPED_MODULES: readonly string[] = ["fanout", "collab", "host", "resident"] as const;

/**
 * worker 角色下跳过注册的模块(派发/全库管理/自动推进/后台管理类):
 * - cards:建卡/交回执/改状态/查队列与 /pao queue 子命令(worker 不开卡、不改状态,回执由主控转交)
 * - collab / fanout:再派发入口(协作中转、扇出)——worker 无 PAO 再派发能力(G1-12)
 * - worker:后台进程管理(盘点/停后台)——worker 不再拉后台,也不背主控的进程登记表
 * - dept:建部工具与 before_agent_start 注册表注入(部 manage 与提示注入属主控)
 * - knowledge:查库/受限补查/入库/巡检——入库/巡检是全库管理,巡检落卡钩子是自动推进;
 *   worker 的受限补查待 M1-05 真实库接线时以最小白名单方式单开(见装载清单)。
 * - healthcheck:pao_health_check是主控选模型的诊断工具,worker 档位由主控派卡时指定。
 * - verifier:机械验收员是 owner/驱动器侧对 worker 交付的核对,worker 自验自过毫无意义;
 *   沙箱跑命令与四态结论都不该出现在 worker 会话。
 * - delivery:交卷跑 git(逐路径 add + commit)——worker 永不跑 git 的结构保证(§13)。
 * - workflow:启流/推流/确认流是再派发与推进入口(G1-12),worker 无自动推进能力。
 * - memory:记忆供应商(默认 mnemosyne,stdio 子进程)与写入/召回/忘却工具是主控/部长能力
 *   (§18.5)——worker 只认卡干活,不背共库写入面(防污染 Hermes 共库的准入口径),也不该
 *   每个 worker 会话各拉一份 mnemosyne 子进程(共库并发白吃亏,R05 子进程随会话全停);
 *   每轮自动召回注入是主控门面的事(§18.1),worker 的记忆需求走回执由主控代写。
 * - host:拉起/散场部长会话是主控专有(worker 无对下通道;星型纪律 §8.6)。
 * - resident:常驻索引/每轮自动召回/压缩交接是主控门面(§18.1)——worker 记忆需求
 *   走回执由主控代写,worker 会话也不该有每轮注入面。
 * - status:/pao status 仪表盘(§21)是 owner 侧全局总览——worker 只认卡干活,不装全局视图
 *   (与 /pao queue 在 cards 模块被跳过同款口径)。
 * - todo-summary(S8-TUI1):待办常驻摘要是交互 TUI 专用面(footer 折叠行＋/todo 展开挂件),
 *   worker 会话是 json 无头模式天然不渲染;不进跳过清单则 /todo 命令会破坏 worker「零命令」
 *   装载面纪律。todo_write 工具本体仍在(todo 模块不跳过,回执对账依赖)。
 * 主控角色全部注册,行为与接线层原有路径一致。
 */
export const WORKER_SKIPPED_MODULES: readonly string[] = [
	"cards",
	"collab",
	"worker",
	"dept",
	"knowledge",
	"fanout",
	"healthcheck",
	"verifier",
	"delivery",
	"workflow",
	"memory",
	"resident",
	"host",
	"status",
	"todo-summary",
	// H0-B /pao budget 能改钱账（显式归还停着的预留）:worker 会话是 agent 自己的装载面,
	// 不能让它看得见、敲得到这条命令（worker 工具面也刻意没加）。
	"budget-command",
] as const;
