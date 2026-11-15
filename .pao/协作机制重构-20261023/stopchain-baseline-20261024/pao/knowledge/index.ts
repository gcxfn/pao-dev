/**
 * pao 知识库模块（卡0004）。
 * 纯库：查库双路 / 入库幂等 / 机械巡检（含门面-子索引一致性核对）/ 受限补查门 / 嵌入客户端 /
 * 向量缓存 / 禁外发检查 / 退役与打回（终审三选一机械核）/ 引用机械修复 / 巡库初判记录约定。
 * 工具：registerKnowledgeTools(pi) 注册 pao_query_kb / pao_restricted_query / pao_ingest_kb / pao_inspect_kb。
 * 总入口 src/pao/index.ts 由主控统一接线。
 */

// 查库自动路由（§18.3 门面，M2-05）
export {
	AUTO_PER_LIB_TOP_K,
	AUTO_SEMANTIC_LIMIT,
	AUTO_TOTAL_LIMIT,
	type AutoRouteResult,
	autoPatrol,
	type FailureLibRecord,
	formatAutoRouteResult,
	labelHit,
	routeByLabel,
	type SourcedHit,
	type VendorRecall,
} from "./auto-route.ts";
export {
	type CachedVector,
	type ChunkParams,
	DEFAULT_CHUNK_PARAMS,
	dropVector,
	emptyVectorCache,
	isCacheUsable,
	loadVectorCache,
	pruneCache,
	saveVectorCache,
	sha1Text,
	type VectorCache,
} from "./cache.ts";
// 嵌入客户端与缓存
export { cosine, type EmbedClient, type EmbedConfig, embedTexts, type FetchLike, loadEmbedConfig } from "./embed.ts";
// 条目解析与类型
export { DATE_RE, parseEntry, subindexRow } from "./entry.ts";
// 受限补查门
export {
	ALL_DEPT_ALIASES,
	createRestrictedGate,
	type GateOptions,
	type QueryReceipt,
	type RestrictedGate,
	type RestrictedQueryAuth,
} from "./gate.ts";
// 入库与巡检
export { type IngestOptions, type IngestResult, ingestEntry } from "./ingest.ts";
export {
	checkIndexConsistency,
	DEFAULT_STALE_DAYS,
	type HookFinding,
	type IndexConsistency,
	type InspectionFinding,
	type InspectionOptions,
	type InspectionReport,
	inspectHook,
	inspectLibrary,
	markSubindex,
} from "./inspect.ts";
// 巡库初判记录文件约定（§6.7 初判走结果文件；worker 只准追加本文件与回执）
export {
	appendPatrolJudgment,
	JUDGMENT_ACTIONS,
	JUDGMENT_FILE,
	type JudgmentAction,
	judgmentFilePath,
	loadPatrolJudgments,
	type PatrolJudgment,
	rewriteJudgmentFile,
} from "./judgment.ts";
// 词法路
export { type LexicalScore, lexicalScore, splitQueryTerms } from "./lexical.ts";

// 禁外发检查（三入口共享）
export {
	checkOutbound,
	loadOutboundConfig,
	type OutboundCheck,
	type OutboundConfig,
	type OutboundRule,
	outboundConfigPath,
	UNKNOWN_PROJECT,
} from "./outbound.ts";
// 路径约定
export {
	ARCHIVE_DIR,
	archiveDir,
	INDEX_FILE,
	PENDING_DIR,
	paoHome,
	pendingDir,
	SUBINDEX_FILE,
	subindexPath,
	typeDirs,
	VECTOR_CACHE_FILE,
	vectorCachePath as libVectorCachePath,
} from "./paths.ts";
// 引用机械修复（改名/移动后的失效引用入口）
export { type IndexMove, type RepairResult, repairIndex } from "./repair.ts";
// 退役与打回（终审三选一机械核）
export { demoteToPending, type MoveOutOptions, type MoveOutResult, retireEntry } from "./retire.ts";
// 查库双路
export { type ScanEntry, type ScanOptions, type SearchOptions, scanLibrary, searchLibrary } from "./search.ts";
// 工具注册
export { formatResult, type KnowledgeToolsOptions, registerKnowledgeTools } from "./tools.ts";
export {
	ENTRY_TYPES,
	type EntryMeta,
	type EntryStatus,
	type EntryType,
	SEARCH_AREAS,
	type SearchHit,
	type SearchResult,
} from "./types.ts";
