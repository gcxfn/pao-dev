/**
 * 词法路打分。
 *
 * 中文不做分词：查询按空白/标点切成词块，条目侧对 文件名 / 首行钩子 /
 * 标题路径 做子串匹配计数（中文友好、零依赖）。权重：文件名 3、钩子 2、
 * 路径 1。整句查询也作为一个词块参与，兼顾「完整短语命中」。
 */
import type { EntryMeta } from "./types.ts";

export const WEIGHT_FILE_NAME = 3;
export const WEIGHT_HOOK = 2;
export const WEIGHT_TITLE_PATH = 1;

export interface LexicalScore {
	score: number;
	/** 是否有词块完整命中文件名或钩子（精确命中，合并去重时保底在列） */
	exact: boolean;
}

/** 查询切词：空白与标点切分，去空，保留中文原块不拆字。 */
export function splitQueryTerms(query: string): string[] {
	const chunks = query
		.split(/[\s，。、；：？！()（）[\]【】,.;:?!]+/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	const trimmed = query.trim();
	if (trimmed && !chunks.includes(trimmed)) chunks.push(trimmed);
	return chunks;
}

function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let pos = haystack.indexOf(needle);
	while (pos !== -1) {
		count++;
		pos = haystack.indexOf(needle, pos + needle.length);
	}
	return count;
}

/** 对单个条目打词法分（纯函数）。 */
export function lexicalScore(query: string, meta: Pick<EntryMeta, "fileName" | "hook" | "relPath">): LexicalScore {
	const terms = splitQueryTerms(query);
	const titlePath = meta.relPath;
	let score = 0;
	let exact = false;
	for (const term of terms) {
		const inName = countOccurrences(meta.fileName.toLowerCase(), term.toLowerCase());
		const inHook = countOccurrences(meta.hook.toLowerCase(), term.toLowerCase());
		const inPath = countOccurrences(titlePath.toLowerCase(), term.toLowerCase());
		if (inName > 0) score += WEIGHT_FILE_NAME;
		if (inHook > 0) score += WEIGHT_HOOK;
		if (inPath > 0) score += WEIGHT_TITLE_PATH;
		if ((inName > 0 || inHook > 0) && term.length >= 2) exact = true;
	}
	return { score, exact };
}
