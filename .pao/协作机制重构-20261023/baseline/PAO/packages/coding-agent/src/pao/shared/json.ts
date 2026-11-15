import { readFileSync } from "node:fs";

/**
 * 读 JSON 文件的公共口。全仓各写各的「readFileSync＋JSON.parse」散装点统一从这里走。
 *
 * 约束:
 * - UTF-8 BOM(\uFEFF)一律剥掉再 parse——Windows 记事本/PowerShell 写出的配置文件常带 BOM,
 *   裸 JSON.parse 在首个字符即炸,坏的是用户配置不是用户。剥 BOM 只影响原本必炸的输入,
 *   无 BOM 文本逐字节不变。
 * - 两种容错语义分开供面,调用方按原有语义选,迁移不得混用:
 *   readJsonRaw(throw 型)/readJsonSafe(容错型,任何失败返回 undefined)。
 * - 坏 JSON 的告警文案与降级行为归调用方——本模块不 console.warn,不吞成假成功。
 */

/** 剥 UTF-8 BOM;无 BOM 原样返回(同一字符串对象语义,内容不变) */
export function stripUtf8Bom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 解析 JSON 文本(throw 型):BOM 容错,坏 JSON 原样抛 SyntaxError(消息与裸 JSON.parse 一致) */
export function parseJsonRaw(text: string): unknown {
	return JSON.parse(stripUtf8Bom(text));
}

/** 读 JSON 文件(throw 型):读不到/不可读/坏 JSON 都原样抛,错误分型归调用方处理 */
export function readJsonRaw(filePath: string): unknown {
	return parseJsonRaw(readFileSync(filePath, "utf8"));
}

/**
 * 读 JSON 文件(容错型):文件缺失/不可读/坏 JSON 一律返回 undefined,不打崩调用方。
 * 「缺失」与「坏」不区分——需要区分时(如 ENOENT 静默、其余抛错)用 readJsonRaw 自行捕获。
 */
export function readJsonSafe(filePath: string): unknown {
	try {
		return readJsonRaw(filePath);
	} catch {
		return undefined;
	}
}
