/**
 * 知识库共享类型。
 * 库骨架见 plans/v2-ARCHITECTURE.md §6.2：目录名即类型，文件名不带前缀。
 */

export const ENTRY_TYPES = ["教训", "导览", "做法", "评测"] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

/** 检索范围：四个类型区 + 待验证；归档不进默认检索（§6.3）。 */
export const SEARCH_AREAS = [...ENTRY_TYPES, "待验证"] as const;
export type SearchArea = (typeof SEARCH_AREAS)[number];

/**
 * 条目状态。前三个来自任务卡验收；「未知」来自 R08：
 * 适用范围缺失时标未知，不自动认作有效。
 */
export type EntryStatus = "有效" | "待验证" | "待复核⚠️" | "未知";

/** 条目解析结果（户口的原始来源）。 */
export interface EntryMeta {
	/** 相对知识库根的路径，如 `教训/mysql-连接池超时.md` */
	relPath: string;
	/** 所在类型区名 */
	area: string;
	/** 文件名 */
	fileName: string;
	/** 首行钩子 */
	hook: string;
	/** 最后核验日期 YYYY-MM-DD；缺失为 null */
	lastVerified: string | null;
	/** 来源版本标注；缺失为 null */
	version: string | null;
	/** 正文已有的状态标记；未声明时从区域与机械核验派生。 */
	declaredStatus: EntryStatus | null;
	/** 适用范围（项目名列表）；缺失为 null（未知） */
	scope: string[] | null;
	/** 来源；缺失为 null（未知） */
	source: string | null;
	/**
	 * 验证出处（genericagent 借鉴③）：这条「做法」由哪张卡、哪次真实验证过。
	 * 正文「验证出处:」标记行取值；缺失为 null＝未验证，条目不删、不参与高置信引用。
	 * 只活在知识库条目里，不进卡协议 14 字段。
	 */
	验证出处: string | null;
}

/** 一次查库命中（户口完整，含派生状态）。 */
export interface SearchHit {
	relPath: string;
	titlePath: string;
	fileName: string;
	area: string;
	summary: string;
	status: EntryStatus;
	scope: string[] | null;
	lastVerified: string | null;
	source: string | null;
	lexicalScore: number;
	semanticScore: number | null;
	/** 词法精确命中（文件名或钩子里出现完整关键词） */
	exactLexical: boolean;
	/** 本次结果是否降级（语义路未参与） */
	degraded: boolean;
}

/** 查库结果：只有有效条目作正式依据，其他状态独列风险提示（R08）。 */
export interface SearchResult {
	hits: SearchHit[];
	riskHits: SearchHit[];
	degraded: boolean;
	/** 降级原因（未配置嵌入端点 / 嵌入调用失败 / 禁外发） */
	degradeReason?: string;
	/** 两路都无命中时的明确空态 */
	emptyReason?: string;
}
