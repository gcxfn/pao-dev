/**
 * 完整任务受理（complete intake）数据契约 —— 计划 §5.2「完整任务受理」。
 *
 * 一次调用就返回受理身份（卡号/尝试号）或真实拒绝原因；三条入口（终端、桌面、批量）
 * 共用同一入口 acceptIntake，本文件只放类型，不含任何业务逻辑。
 *
 * 契约稳定性：字段名与导出名已冻结（将写入长期接口文档）。新增字段只可追加可选字段。
 */
import type { CardBudget, CardPriority, CardTier, ParsedCard } from "../cards/index.ts";
import type { PreflightItem } from "../preflight/index.ts";

/**
 * 受理请求：一条待受理的任务。
 *
 * 机器字段用 ASCII 英文（本模块新代码命名规则），语义在注释里用中文写清——
 * 与卡片协议的中文 frontmatter 键（外部契约，不改名）在 createCard 边界处映射。
 */
export interface IntakeRequest {
	/**
	 * 请求判据（幂等键）：同一 key 重复提交＝同一次受理，不重复建卡、不重复派发。
	 * 必填且 trim 后非空——没有判据就无法区分「重试」与「新任务」，宁可拒绝也不猜。
	 */
	idempotencyKey: string;
	/** 目标（卡 frontmatter 的 goal）。必填，trim 后非空。 */
	goal: string;
	/** 部门（卡 frontmatter 的 dept）。须为已登记部门，由集中预检把关，不自动建部。 */
	dept: string;
	/** 验收标准（卡 frontmatter 的 acceptance）。必填，trim 后非空。 */
	acceptance: string;
	/** 输入指针列表（可空；缺省落空数组）。 */
	inputs?: string[];
	/** 约束正文（可空）。 */
	constraints?: string;
	/** 依赖卡号列表（可空；缺省落空数组）。未放行时拒绝受理。 */
	depends_on?: string[];
	/** 父卡引用（可空）。 */
	parent?: string;
	/** 档位（可空；给了就由预检核对档位配置里是否真有这一档）。 */
	tier?: CardTier;
	/** 预算（可空；给了就由预检校验，且 0 值视为阻止启动）。 */
	budget?: CardBudget;
	/** 优先级（可空；缺省 medium，与 createCard 同口径）。 */
	priority?: CardPriority;
	/** 归属（owner，可空；预置归属人，缺省不写）。 */
	owner?: string;
	/**
	 * 卡模板名或绝对路径（可空）。解析与正文取出由调用方经模板库完成并传 templateBody，
	 * 本模块不碰模板库文件系统（避免第二个读取实现）。
	 */
	template?: string;
	/**
	 * 是否立即派发：true＝建卡后经既有 dispatchInBackground 通道派发；false＝只建卡（待认领）。
	 * 缺省 false——受理默认不替你花钱，派发要显式要。
	 */
	dispatch: boolean;
	/** 派单理由（dispatch=true 时必填，trim 后非空；进登记表留痕，供上级审查）。 */
	reason?: string;
}

/**
 * 模板正文骨架（已批准模板的正文）。
 *
 * 模板解析的**唯一实现**在 cards/cardfile.ts（`resolveCardTemplate`/`loadCardBodyTemplate`）；
 * 本模块不重做读取，只接收调用方解析结果。缺省＝无模板正文（createCard 的既有行为）。
 */
export interface IntakeTemplateBody {
	/** 模板名（仅留痕用）。 */
	name: string;
	/** 已取出的正文骨架；空串视为坏模板，createCard 会结构化报错。 */
	body: string;
}

/** 单条受理结果状态。 */
export type IntakeStatus =
	/** 已受理：卡已真实落在卡目录。 */
	| "accepted"
	/** 受理未完成：给出真实原因；建卡后失败时仍回填卡身份，调用方须据此核对现场。 */
	| "rejected"
	/** 重复提交：同一 idempotencyKey 已受理过，回填第一次的真实身份，不新建不重派。 */
	| "duplicate"
	/** 已受理但推迟：卡已建好但因依赖未放行等原因没有派发（dispatch=true 时才会出现）。 */
	| "deferred";

/**
 * 单条受理结果。
 *
 * 身份回填纪律：**能给才给，给不出就 undefined，绝不编**。
 * - cardNo / cardPath / attempt 是内核真实可查的事实（卡文件与认领结果）；
 * - instance / node / round 是工作流实例身份，只有工作流派发校验（workflowCheck）在准备期
 *   真实解出实例上下文时才填；普通卡没有实例，如实留 undefined。
 */
export interface IntakeOutcome {
	/** 本条对应的请求判据，原样回填（调用方据此把结果对回自己的请求，不靠数组下标）。 */
	idempotencyKey: string;
	status: IntakeStatus;
	/** 卡号（四位补零，如 "0001"）；未建卡时 undefined。 */
	cardNo?: string;
	/** 卡文件绝对/真实路径；未建卡时 undefined。 */
	cardPath?: string;
	/** 工作流执行实例 id；仅工作流派发真实给出时填，普通卡与未派发时 undefined。 */
	instance?: string;
	/** 工作流节点 id；同上。 */
	node?: string;
	/** 工作流轮次号；同上。 */
	round?: number;
	/** 真实启动的尝试号（认领后卡面 attempt）；未派发时 undefined（未启动就没有尝试）。 */
	attempt?: number;
	/** 真实原因：rejected 时是拒绝原因；deferred 时是推迟原因；accepted/duplicate 时为 undefined。 */
	reason?: string;
	/**
	 * 问题项（复用 PreflightItem 形状，不新造一套）：预检的「可排队/警告/未验证」项带进这里，
	 * 让调用方知道「受理了但有已知风险」。rejected 时含全部「阻止启动」项。
	 */
	problems: PreflightItem[];
	/** 首次受理时间（YYYY-MM-DD HH:mm，卡片协议格式）；duplicate 时为**第一次**的受理时间。 */
	acceptedAt: string;
	/** 本条是否为重复提交回填（等价于 status === "duplicate"，便于调用方直接判）。 */
	duplicateOf?: IntakeOutcome;
}

/** 批量受理结果汇总计数。 */
export interface IntakeCounts {
	accepted: number;
	rejected: number;
	duplicate: number;
	deferred: number;
}

/** 批量受理结果：逐条 outcome 数组＋汇总计数＋是否部分成功。 */
export interface IntakeReport {
	/** 与入参请求同序、同长度（一条请求一个 outcome，失败的也占位——不许静默丢条）。 */
	outcomes: IntakeOutcome[];
	counts: IntakeCounts;
	/**
	 * 是否部分成功：有的受理了、有的没受理。
	 * 全成功/全失败时为 false（全失败不是「部分」），批量调用方据此决定是否提示用户。
	 */
	partial: boolean;
	/** 受理时间（UTC ISO，机器可读字段口径）。 */
	at: string;
}

/**
 * 派发钩子：**唯一派发通道**的注入点。
 *
 * 类型刻意与 worker/index.ts 的 `DispatchInBackground` 保持结构兼容（同一个函数可直接传进来），
 * 但本模块不 import worker/index.ts——那是装配层，反向依赖会成环（index.ts → intake → worker/index.ts）。
 * 装配方（终端/桌面/批量宿主）把 registerWorkerTools 闭包里的 dispatchInBackground 传进来即可。
 */
export type IntakeDispatchHook = (
	input: {
		cardsDir: string;
		card_no: string;
		operator: string;
		time: string;
		dispatch_reason?: string;
	},
	dispatchOptions: { 公共参数?: Record<string, unknown> },
	key: string,
	cardNo: string,
	ownerSession?: string,
) => void;

/** 受理选项：宿主装配信息。 */
export interface IntakeOptions {
	/** 项目根（预检的 project；缺省由卡目录推导，见 projectRootForCards）。 */
	projectRoot?: string;
	/** PAO_HOME（预检的 paoHome，读部门注册表/档位/预算/记忆配置）。 */
	paoHome: string;
	/**
	 * 派发通道。dispatch=true 时必须给——不给就如实 rejected，**不**自己 spawn runner
	 * （同一规则只实现一次：派发链只有 executeDispatch 一条）。
	 */
	dispatchInBackground?: IntakeDispatchHook;
	/** 委派者身份（认领 operator）；缺省按角色判定（主控/PAO_DEPT，与 checkDispatchPermission 同源）。 */
	operator?: string;
	/** 调用方会话 id（随派发注入 workflowCheck 做实例 owner 重核）。 */
	ownerSession?: string;
	/** 模板名/路径 → 正文骨架；缺省视为无模板正文。解析实现由调用方复用 cards 模板库。 */
	resolveTemplate?: (
		request: IntakeRequest,
	) => Promise<IntakeTemplateBody | undefined> | IntakeTemplateBody | undefined;
	/** 时钟注入（测试用）；缺省 new Date()。 */
	now?: () => Date;
	/** 取消信号：受理前检查，已取消条目不建卡。 */
	signal?: AbortSignal;
}

/** 幂等判据落盘的一条记录（.pao/intake/受理账.json 的条目形状）。 */
export interface IntakeLedgerEntry {
	/** 请求判据。 */
	idempotencyKey: string;
	/**
	 * 占位标记：true＝该判据已被受理流程占用、但卡尚未建成（并发互斥用）。
	 * 占位条目 cardNo/cardPath 为空串；建卡成功即转正（删掉本标记并写入真实身份），
	 * 建成失败则撤回占位。正式记录不带此标记。
	 */
	pending?: true;
	/** 首次受理时的卡号（四位补零）；占位时为空串。 */
	cardNo: string;
	/** 首次受理时的卡路径；占位时为空串。 */
	cardPath: string;
	/** 首次受理时间（YYYY-MM-DD HH:mm）。 */
	acceptedAt: string;
	/** 当时的尝试号（已派发才有）。 */
	attempt?: number;
	/** 实例/节点/轮次（工作流真实给出时才写）。 */
	instance?: string;
	node?: string;
	round?: number;
}

/** 幂等账文件形状（版本号用于将来迁移；读到未知版本按坏账如实报错，不静默重置）。 */
export interface IntakeLedgerFile {
	version: 1;
	entries: IntakeLedgerEntry[];
}

/** 受理判据命中项：账内既有记录 + 当前磁盘上该卡的真实状态（用于判失效）。 */
export interface IntakeLedgerHit {
	entry: IntakeLedgerEntry;
	/** 重读卡文件得到的当前卡（卡已被删则 undefined——账还在但现场没了，如实报）。 */
	card?: ParsedCard;
}
