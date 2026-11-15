/**
 * 卡片协议类型（架构 §2 / 黑板第 5 条字段名；S9 机器协议英文化已按定名表随迁英文键）。
 * 状态五值与优先级、失败分型也在此冻结。
 */

export const CARD_STATUSES = ["unclaimed", "in_progress", "delivered", "failed", "canceled"] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

export const CARD_PRIORITIES = ["high", "medium", "low"] as const;
export type CardPriority = (typeof CARD_PRIORITIES)[number];

export const CARD_TIERS = ["fast", "primary"] as const;
export type CardTier = (typeof CARD_TIERS)[number];

/** 失败分型四类（架构 §2.1：依赖未就绪不算失败，走依赖放行，不在此列）。 */
export const FAILURE_TYPES = ["transient", "missing_input", "insufficient_capability", "unknown_outcome"] as const;
export type FailureType = (typeof FAILURE_TYPES)[number];

/**
 * F-A7 worker 自报任务态（S5 包1，参照 pi-maestro-flow 四态）：
 * completed=验收全达标；completed_with_deviations=有未达项但可交付；
 * blocked=无法继续须用户输入；checkpoint=到决策点须指引（非终结）。
 */
export const TASK_STATES = ["completed", "completed_with_deviations", "blocked", "checkpoint"] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** 终结性自报（S5：有效尝试的终结结果仅接纳一次；checkpoint 不算终结）。 */
export const TERMINAL_TASK_STATES = ["completed", "completed_with_deviations", "blocked"] as const;
export type TerminalTaskState = (typeof TERMINAL_TASK_STATES)[number];

/** 自报逐条核对（消费侧只拦不放行：fail/not_run 增加拒绝，pass 不免检不授予，§12.2）。键为 S5 已定载荷键，S9 不随迁。 */
export interface ReceiptVerification {
	条件: string;
	结论: "pass" | "fail" | "not_run";
	证据?: string;
}

/** 自报改动声明（机械验收与 git 真值比对的声明面；类型五值沿用 A-7）。键为 S5 已定载荷键，S9 不随迁。 */
export interface ReceiptChange {
	路径: string;
	类型: "created" | "modified" | "deleted" | "moved" | "untouched";
	说明?: string;
}

export interface CardBudget {
	/** 模型轮次上限。 */
	turns?: number;
	/** 工具调用次数上限；cost 保留为独立的费用上限。 */
	toolCalls?: number;
	cost?: number;
	/** 协作配额（定名表 §3.1：协作配额→collab_quota 并入预算对象）。 */
	collab_quota?: number;
}

/** 卡片 frontmatter（信封字段）。创建/完成格式固定 "YYYY-MM-DD HH:mm" 字符串，不用 YAML 日期对象。 */
export interface CardFrontmatter {
	goal: string;
	dept: string;
	inputs?: string[];
	constraints?: string;
	acceptance: string;
	depends_on?: string[];
	parent?: string;
	tier?: CardTier;
	budget?: CardBudget;
	priority?: CardPriority;
	owner?: string;
	/** 当前尝试号：已真实启动的尝试次数。创建时 0，待认领→进行中（实际启动）+1。 */
	attempt: number;
	created: string;
	completed?: string;
	status: CardStatus;
}

/** worker 交回的回执（正文区一段，带卡号+尝试号）。 */
export interface Receipt {
	card_no: number;
	attempt: number;
	time: string;
	result?: string;
	summary?: string;
	artifact_path?: string[];
	evidence?: string[];
	usage?: Record<string, unknown>;
	worth_distilling?: string;
	failure_type?: FailureType;
	/** F-A7 自报任务态（S5 包1）；缺省＝旧链路/手工回执未自报。 */
	任务态?: TaskState;
	/** 自报逐条核对（只拦不放行）。 */
	verification?: ReceiptVerification[];
	/** 自报改动声明（§14 与 git 真值比对）。 */
	changes?: ReceiptChange[];
	/** 旧尝试留档 / 迟到回执 / 重复终结留档时由写入层标注，非 worker 填写。
	 *  值域定名表只定 old_attempt/late_receipt；「重复终结留档」定名表未覆盖（S9-迁移包待决策移交），保留原值。 */
	archive_flag?: "old_attempt" | "late_receipt" | "重复终结留档";
}

export interface ParsedCard {
	path: string;
	filename: string;
	card_no: number;
	frontmatter: CardFrontmatter;
	body: string;
	receipts: Receipt[];
}

/** /pao queue 渲染用的卡片视图（render.ts 纯函数输入）。 */
export interface QueueCardView {
	card_no: number;
	goal: string;
	status: CardStatus;
	priority: CardPriority;
	created: string;
	completed?: string;
	owner?: string;
	depends_on: string[];
	parent?: string;
	/** 回执在而状态未终 = 待审（架构 §2：worker 交回执只是待审）。 */
	pending_review: boolean;
}
