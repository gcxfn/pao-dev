/**
 * 向量缓存：JSON 文件，衍生品——可删除、可整体重建，永不作为正本（§6.3/R08）。
 * 记录嵌入模型名与切分参数；任一变化 → 缓存整体失效重建。
 * 条目按 relPath 记 sha1+mtime+size+meta 快照：mtime+size 一致即视为未变（免读盘免 sha1），
 * 不一致再以全文 sha1 判内容是否真变，内容变化即对应向量失效，不只处理新增。
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "../shared/atomic.ts";
import { readJsonSafe } from "../shared/json.ts";
import { vectorCachePath } from "./paths.ts";
import type { EntryMeta } from "./types.ts";

/** 切分参数：条目粒度等。变化即整体重建。 */
export interface ChunkParams {
	granularity: string;
	version: number;
}

export const DEFAULT_CHUNK_PARAMS: ChunkParams = { granularity: "whole-entry", version: 1 };

export interface CachedVector {
	sha1: string;
	mtime: number;
	/** 条目字节数；与 mtime 一起做「未变」快判。旧缓存无此字段 → 判不一致，重读一次后补齐 */
	size?: number;
	/** 条目元信息快照（词法路零读盘用）；与向量同判据信任：mtime+size 一致即未变 */
	meta?: EntryMeta;
	embedding: number[];
}

export interface VectorCache {
	formatVersion: number;
	embedModel: string;
	chunkParams: ChunkParams;
	/** relPath -> 向量 */
	vectors: Record<string, CachedVector>;
}

export function emptyVectorCache(embedModel: string, chunkParams: ChunkParams = DEFAULT_CHUNK_PARAMS): VectorCache {
	return { formatVersion: 1, embedModel, chunkParams, vectors: {} };
}

export function sha1Text(text: string): string {
	return createHash("sha1").update(text, "utf8").digest("hex");
}

/** 读缓存；文件缺失或损坏返回 null（调用方按重建处理）。 */
export function loadVectorCache(libRoot: string): VectorCache | null {
	const parsed = readJsonSafe(vectorCachePath(libRoot)) as VectorCache | undefined;
	if (!parsed || parsed.formatVersion !== 1) return null;
	if (parsed.vectors === null || typeof parsed.vectors !== "object" || Array.isArray(parsed.vectors)) return null;
	return parsed as VectorCache;
}

export function saveVectorCache(libRoot: string, cache: VectorCache): void {
	const file = vectorCachePath(libRoot);
	mkdirSync(dirname(file), { recursive: true });
	// 原子写:半截 JSON 会让下次读缓存误判损坏而全量重建
	writeFileAtomic(file, JSON.stringify(cache, null, "\t"));
}

/** 模型或切分参数任一变化 → 整体失效（返回 false，调用方换空缓存重建）。 */
export function isCacheUsable(
	cache: VectorCache | null,
	embedModel: string,
	chunkParams: ChunkParams = DEFAULT_CHUNK_PARAMS,
): boolean {
	if (!cache) return false;
	if (cache.embedModel !== embedModel) return false;
	return JSON.stringify(cache.chunkParams) === JSON.stringify(chunkParams);
}

/** 删除单个条目的向量（条目修改/归档/删除时同批失效）。 */
export function dropVector(cache: VectorCache, relPath: string): boolean {
	if (relPath in cache.vectors) {
		delete cache.vectors[relPath];
		return true;
	}
	return false;
}

/** 裁剪：只保留 keep 返回 true 的向量，返回删除条数（归档/删除/禁外发撤销后同批收敛）。 */
export function pruneCache(cache: VectorCache, keep: (relPath: string) => boolean): number {
	let dropped = 0;
	for (const relPath of Object.keys(cache.vectors)) {
		if (!keep(relPath)) {
			delete cache.vectors[relPath];
			dropped++;
		}
	}
	return dropped;
}
