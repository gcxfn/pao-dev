/**
 * 知识库路径约定。目录结构由建部工具生成（架构 §6.2），
 * 本模块的工具把知识库根目录当作参数，不依赖建部工具实现。
 */
import { join } from "node:path";
import { ENTRY_TYPES, type EntryType } from "./types.ts";

/** 库根下的固定成员 */
export const INDEX_FILE = "索引.md";
export const PENDING_DIR = "待验证";
export const ARCHIVE_DIR = "归档";
/** 每个类型区的子索引文件名 */
export const SUBINDEX_FILE = "子索引.md";
/** 向量缓存文件名（衍生品，可删可重建，永不作为正本） */
export const VECTOR_CACHE_FILE = ".pao-vector-cache.json";

/** 四个类型区目录的绝对路径 */
export function typeDirs(libRoot: string): Record<EntryType, string> {
	const out = {} as Record<EntryType, string>;
	for (const t of ENTRY_TYPES) out[t] = join(libRoot, t);
	return out;
}

export function pendingDir(libRoot: string): string {
	return join(libRoot, PENDING_DIR);
}

export function archiveDir(libRoot: string): string {
	return join(libRoot, ARCHIVE_DIR);
}

export function subindexPath(libRoot: string, type: EntryType): string {
	return join(libRoot, type, SUBINDEX_FILE);
}

export function vectorCachePath(libRoot: string): string {
	return join(libRoot, VECTOR_CACHE_FILE);
}

/** PAO 仓库根（含 `部门/`），从环境变量读，不硬编码。 */
export function paoHome(env: Record<string, string | undefined> = process.env): string {
	return env.PAO_HOME || process.cwd();
}
