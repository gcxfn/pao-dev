/**
 * 查库双路混合（§6.3 + R08）：
 * - 词法（文件名/钩子/路径子串匹配）始终参与，负责精确词命中；
 * - 语义（云端嵌入 + 余弦暴力打分 + JSON 向量缓存）负责换说法的召回；
 * - 两路合并去重，词法精确命中保底在列，不被纯语义高分挤掉；
 * - 端点未配置/调用失败/禁外发 → 词法独跑，结果带 degraded；
 * - 待验证、待复核、未知命中独列风险提示，不挤占正式 top_k；
 * - 归档区不进检索。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
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
} from "./cache.ts";
import {
	cosine,
	DEFAULT_EMBED_TIMEOUT_MS,
	type EmbedClient,
	EmbedTimeoutError,
	embedTexts,
	type FetchLike,
	loadEmbedConfig,
	type QueryEmbeddingCache,
	sharedQueryEmbedding,
	throwIfAborted,
} from "./embed.ts";
import { isMarkdownEntryFile, parseEntry, stripEvidenceBlock } from "./entry.ts";
import { DEFAULT_STALE_DAYS, inspectHook } from "./inspect.ts";
import { lexicalScore } from "./lexical.ts";
import { checkOutbound, loadOutboundConfig, type OutboundConfig } from "./outbound.ts";
import { type EntryMeta, SEARCH_AREAS, type SearchHit, type SearchResult } from "./types.ts";

export interface ScanEntry {
	meta: EntryMeta;
	absPath: string;
	raw: string;
	mtime: number;
	size: number;
}

export interface SearchOptions {
	libRoot: string;
	query: string;
	topK?: number;
	/** 查询绑定的项目（R01：从可信任务上下文绑定，用于禁外发检查） */
	project?: string;
	/** 嵌入客户端；缺省时从环境变量读，未配置则词法独跑 */
	embed?: EmbedClient | null;
	/** 外发许可配置；缺省时从 PAO_HOME 读 */
	outbound?: OutboundConfig;
	/** 是否写缓存。受限补查门必须传 false（只读，无任何写路径）。 */
	writeCache?: boolean;
	fetchImpl?: FetchLike;
	/** 用户取消信号；取消会停止嵌入等待，不走词法降级，也不写缓存。 */
	signal?: AbortSignal;
	/** 嵌入请求等待上限（毫秒），默认 15 秒；超时沿词法降级路径返回原因。 */
	timeoutMs?: number;
	/** 单次跨库查询共享的查询词向量 Promise；每库授权通过后才调用。 */
	queryEmbeddingCache?: QueryEmbeddingCache;
	/** 巡检轻核验参数 */
	staleDays?: number;
	expectedVersion?: string;
	now?: Date;
	chunkParams?: ChunkParams;
}

export interface ScanOptions {
	/** 是否包含归档区（默认不进检索） */
	includeArchive?: boolean;
	/** 已验证未变条目的缓存（relPath→缓存条目）：mtime+size 一致时用缓存 meta 快照，零读盘零 sha1 */
	trusted?: Record<string, CachedVector>;
}

/** 扫库：列出各类型区 + 待验证（+可选归档）的条目。 */
export function scanLibrary(libRoot: string, options: ScanOptions = {}): ScanEntry[] {
	const areas = options.includeArchive ? [...SEARCH_AREAS, "归档" as const] : SEARCH_AREAS;
	const entries: ScanEntry[] = [];
	for (const area of areas) {
		const dir = join(libRoot, area);
		if (!existsSync(dir)) continue;
		for (const file of readdirSync(dir).filter(isMarkdownEntryFile).sort()) {
			const abs = join(dir, file);
			const relPath = `${area}/${file}`;
			const { mtimeMs, size } = statSync(abs);
			const trusted = options.trusted?.[relPath];
			if (trusted && trusted.mtime === mtimeMs && trusted.size === size && trusted.meta) {
				// mtime+size 与缓存一致 → 条目未变：meta 用缓存快照，正文只在真被用到（嵌入）时才读
				entries.push({
					meta: trusted.meta,
					absPath: abs,
					mtime: mtimeMs,
					size,
					get raw() {
						return stripEvidenceBlock(readFileSync(abs, "utf8"));
					},
				});
				continue;
			}
			// 引用证据区块只挂不索引不注入（S5 包2）：钩子解析与云端嵌入同源吃剥除后文本
			const raw = stripEvidenceBlock(readFileSync(abs, "utf8"));
			entries.push({ meta: parseEntry(raw, relPath), absPath: abs, raw, mtime: mtimeMs, size });
		}
	}
	return entries;
}

const DEFAULT_TOP_K = 5;

export async function searchLibrary(options: SearchOptions): Promise<SearchResult> {
	throwIfAborted(options.signal);
	const topK = options.topK && options.topK > 0 ? Math.floor(options.topK) : DEFAULT_TOP_K;
	const outbound = options.outbound ?? loadOutboundConfig();
	const now = options.now ?? new Date();
	const staleDays = options.staleDays ?? DEFAULT_STALE_DAYS;

	let degraded = false;
	let degradeReason: string | undefined;
	let queryVector: number[] | null = null;
	let vectors = new Map<string, number[]>();
	let cache = null as ReturnType<typeof loadVectorCache>;
	// embed 显式传入（含 null）就照用；未传才从 EMBED_* 环境变量读
	const loadedEmbedConfig = options.embed === undefined ? loadEmbedConfig() : null;
	let embedClient: EmbedClient | null =
		options.embed !== undefined
			? options.embed
			: loadedEmbedConfig
				? { config: loadedEmbedConfig, fetchImpl: options.fetchImpl ?? fetch }
				: null;

	if (!embedClient) {
		// 端点未配置 → 词法独跑，结果带 degraded（§6.3）
		degraded = true;
		degradeReason = "嵌入端点未配置（EMBED_BASE_URL/EMBED_API_KEY/EMBED_MODEL），词法独跑";
	}

	if (embedClient) {
		const chunkParams = options.chunkParams ?? DEFAULT_CHUNK_PARAMS;
		cache = loadVectorCache(options.libRoot);
		if (!isCacheUsable(cache, embedClient.config.model, chunkParams)) {
			cache = emptyVectorCache(embedClient.config.model, chunkParams); // 模型/切分变化 → 整体重建
		}
	}
	// 缓存中 mtime+size 已验证未变的条目：扫描零读盘（词法 meta 用缓存快照）
	const scanned = scanLibrary(options.libRoot, { trusted: cache?.vectors });

	// —— 词法路（始终参与）——
	const lexScored = scanned.map((e) => ({ entry: e, ...lexicalScore(options.query, e.meta) }));
	const maxLex = Math.max(...lexScored.map((l) => l.score), 0);

	// —— 语义路（可降级）——
	if (embedClient) {
		// 只允许嵌入显式授权项目的条目；适用范围缺失（未知）不发云端
		const allowedEntries = scanned.filter((e) => checkOutbound(e.meta.scope ?? [], outbound, now).allowed);
		throwIfAborted(options.signal);
		// 禁外发收敛（R08）：授权撤销/归档/删除的条目同批裁出缓存——即使本次查询被阻断也要收敛
		const keep = new Set(allowedEntries.map((e) => e.meta.relPath));
		throwIfAborted(options.signal);
		if (pruneCache(cache!, (relPath) => keep.has(relPath)) > 0 && options.writeCache !== false) {
			throwIfAborted(options.signal);
			saveVectorCache(options.libRoot, cache!);
		}
		// 查询词绑定的项目未授权 → 查询词不进嵌入请求，词法独跑
		const queryCheck = checkOutbound(options.project ? [options.project] : [], outbound, now);
		if (!queryCheck.allowed) {
			degraded = true;
			degradeReason = `禁外发：项目 ${queryCheck.blocked.join("、")} 未授权云端嵌入，词法独跑`;
			embedClient = null;
			cache = null;
		} else {
			try {
				let cacheDirty = false;
				// ponytail: mtime+size 一致即视为未变，同刻度同长度的改写检测不到；库条目人工编辑
				// 必变 mtime/长度，真出现漏检再退回全量 sha1。
				// 需要（重新）嵌入的条目：缓存缺失，或 mtime+size 不一致且全文 sha1 证实内容已变——不只处理新增
				const missing: ScanEntry[] = [];
				for (const e of allowedEntries) {
					throwIfAborted(options.signal);
					const cached: CachedVector | undefined = cache!.vectors[e.meta.relPath];
					if (!cached) missing.push(e);
					else if (cached.mtime === e.mtime && cached.size === e.size)
						continue; // 未变：零读盘零 sha1
					else if (cached.sha1 === sha1Text(e.raw)) {
						// 内容未变仅 stat 漂移（重落/复制）：刷新判据与 meta 快照，下次免读
						cached.mtime = e.mtime;
						cached.size = e.size;
						cached.meta = e.meta;
						cacheDirty = true;
					} else missing.push(e);
				}
				if (missing.length > 0) {
					const fresh = await embedTexts(
						embedClient,
						missing.map((e) => e.raw),
						{ signal: options.signal, timeoutMs: options.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS },
					);
					throwIfAborted(options.signal);
					missing.forEach((e, i) => {
						cache!.vectors[e.meta.relPath] = {
							sha1: sha1Text(e.raw),
							mtime: e.mtime,
							size: e.size,
							meta: e.meta,
							embedding: fresh[i],
						};
					});
					cacheDirty = true;
				}
				const queryPromise = options.queryEmbeddingCache
					? sharedQueryEmbedding(embedClient, options.query, options.queryEmbeddingCache, {
							signal: options.signal,
							timeoutMs: options.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS,
						})
					: embedTexts(embedClient, [options.query], {
							signal: options.signal,
							timeoutMs: options.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS,
						}).then(([vector]) => {
							if (!vector) throw new Error("嵌入端点返回缺少查询向量");
							return vector;
						});
				queryVector = await queryPromise;
				throwIfAborted(options.signal);
				// 缓存内容真变化（新嵌入/判据刷新）才写盘；零变化不重写
				if (cacheDirty && options.writeCache !== false) {
					throwIfAborted(options.signal);
					saveVectorCache(options.libRoot, cache!);
				}
			} catch (error) {
				if (options.signal?.aborted) throw error;
				// 云端失败不崩：词法独跑
				degraded = true;
				degradeReason =
					error instanceof EmbedTimeoutError || (error instanceof Error && error.name === "TimeoutError")
						? `嵌入调用超时（${options.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS}ms），词法独跑`
						: `嵌入调用失败（${error instanceof Error ? error.message : String(error)}），词法独跑`;
				embedClient = null;
				queryVector = null;
				vectors = new Map();
			}
		}
		if (queryVector && cache) {
			for (const [relPath, cached] of Object.entries(cache.vectors)) {
				vectors.set(relPath, cached.embedding);
			}
		}
	}
	throwIfAborted(options.signal);

	// —— 合并去重打分 ——
	interface Candidate {
		entry: ScanEntry;
		lex: number;
		lexNorm: number;
		semantic: number | null;
		combined: number;
		exact: boolean;
	}
	const byPath = new Map<string, Candidate>();
	for (const l of lexScored) {
		if (l.score <= 0) continue;
		byPath.set(l.entry.meta.relPath, {
			entry: l.entry,
			lex: l.score,
			lexNorm: maxLex > 0 ? l.score / maxLex : 0,
			semantic: null,
			combined: 0,
			exact: l.exact,
		});
	}
	if (queryVector) {
		for (const [relPath, embedding] of vectors) {
			const score = cosine(queryVector, embedding);
			if (score <= 0) continue;
			const existing = byPath.get(relPath);
			if (existing) {
				existing.semantic = score;
			} else {
				const entry = scanned.find((e) => e.meta.relPath === relPath)!;
				byPath.set(relPath, { entry, lex: 0, lexNorm: 0, semantic: score, combined: 0, exact: false });
			}
		}
	}
	for (const c of byPath.values()) {
		c.combined = 0.5 * c.lexNorm + 0.5 * (c.semantic ?? 0);
	}
	const candidates = [...byPath.values()].sort((a, b) => b.combined - a.combined);

	// —— 状态派生（含返回前顺手轻量机械核验，§6.3）——
	function toHit(c: Candidate): SearchHit {
		const meta = c.entry.meta;
		const finding = inspectHook(meta.hook, { staleDays, expectedVersion: options.expectedVersion, now });
		let status: SearchHit["status"];
		let unverifiedReason: string | undefined;
		if (meta.area === "待验证" || meta.declaredStatus === "待验证") status = "待验证";
		else if (meta.declaredStatus === "待复核⚠️") status = "待复核⚠️";
		else if (meta.declaredStatus === "未知") status = "未知";
		else if (meta.scope === null)
			status = "未知"; // R08：适用范围缺失标未知，不自动认有效
		else if (options.expectedVersion && !meta.version)
			status = "未知"; // 明确版本请求中，缺版本不能认作该版本的依据
		else if (finding.flagged) status = "待复核⚠️";
		else if (meta.area === "做法" && meta.验证出处 === null) {
			// 审查第 13 项：做法没有「验证出处:」就只够待验证——有日期、适用范围、正式状态也不能
			// 当高置信依据（参考卡协议口径：没有出处的做法只能挂待验证）。只在做法区生效，
			// 教训/导览/评测不套用这条，避免无差别降级。
			status = "待验证";
			unverifiedReason = "做法缺「验证出处:」标记行：没有哪张卡、哪次真实验证过的记录，只作待验证提示，不作正式依据";
		} else status = "有效";
		return {
			relPath: meta.relPath,
			titlePath: meta.relPath,
			fileName: meta.fileName,
			area: meta.area,
			summary: meta.hook,
			status,
			scope: meta.scope,
			lastVerified: meta.lastVerified,
			source: meta.source,
			lexicalScore: c.lex,
			semanticScore: c.semantic,
			exactLexical: c.exact,
			degraded,
			...(unverifiedReason ? { unverifiedReason } : {}),
		};
	}

	// 先判断状态再选正式 top_k，风险项不能挤掉有效项。
	const classified = candidates.map(toHit);
	const formal = classified.filter((hit) => hit.status === "有效");
	const chosen = formal.slice(0, topK);
	// 词法精确命中保底：被语义高分挤出 top_k 的精确命中换回来
	for (const e of formal.filter((hit) => hit.exactLexical)) {
		if (chosen.includes(e)) continue;
		const replaceAt = findLastIndex(chosen, (hit) => !hit.exactLexical);
		if (replaceAt >= 0) chosen[replaceAt] = e;
		else if (chosen.length < topK) chosen.push(e);
	}
	chosen.sort((a, b) => classified.indexOf(a) - classified.indexOf(b));
	const hits = chosen;
	const riskHits = classified.filter((hit) => hit.status !== "有效").slice(0, topK);
	if (hits.length === 0 && riskHits.length === 0) {
		return { hits, riskHits, degraded, degradeReason, emptyReason: "无可用依据：词法与语义两路均无命中" };
	}
	return { hits, riskHits, degraded, degradeReason };
}

function findLastIndex<T>(arr: T[], pred: (item: T) => boolean): number {
	for (let i = arr.length - 1; i >= 0; i--) {
		if (pred(arr[i])) return i;
	}
	return -1;
}

// 供缓存失效复用（入库时丢旧路径向量）
export { dropVector };
