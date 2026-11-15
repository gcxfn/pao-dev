/**
 * 条目解析。条目规范（§6.2）：不用 YAML frontmatter，读者是模型不是查询引擎；
 * 首行 = 钩子 + 最后核验日期（+ 可选版本标注）；适用范围与来源写在正文标记行。
 * 约定：
 *   首行形如「钩子文本 2026-10-02 版本:v2」——日期取首个 YYYY-MM-DD，
 *   版本取「版本:」后的词；正文里「适用范围:」「来源:」开头的行各取值。
 */
import type { EntryMeta, EntryStatus } from "./types.ts";

export const DATE_RE = /20\d{2}-\d{2}-\d{2}/;
const VERSION_RE = /版本[:：]\s*([^\s，。；（）()]+)/;
const SCOPE_LINE_RE = /^适用范围[:：]\s*(.+)$/m;
const SOURCE_LINE_RE = /^来源[:：]\s*(.+)$/m;
/** 验证出处标记行（借鉴③）：哪张卡、哪次真实验证过；无行＝未验证。 */
const VERIFY_LINE_RE = /^验证出处[:：]\s*(.+)$/m;
const STATUS_LINE_RE = /^[ \t]*状态[ \t]*[:：][ \t]*([^\r\n]*)/m;

/**
 * 引用证据区块定界（S5 包2，K14/A-9）：worker 回执引文等不可信原文只挂在 HTML 注释区块里，
 * 「只挂不索引不注入」——钩子解析与云端嵌入都吃剥除后的文本。注释语法使其对 Markdown 读者不可见。
 */
export const EVIDENCE_BLOCK_START = "<!-- pao 引用证据 开始 -->";
export const EVIDENCE_BLOCK_END = "<!-- pao 引用证据 结束 -->";

/**
 * 行级剥除证据区块（从开始标记行到结束标记行的所有行整段去掉）；开始后无结束标记（未闭合）
 * 时剥到文件尾（fail-closed：宁可多剥不可漏注入）。区块外的正文行原样保留。
 */
export function stripEvidenceBlock(raw: string): string {
	const lines = raw.split(/\r?\n/);
	const kept: string[] = [];
	let inBlock = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed === EVIDENCE_BLOCK_START) {
			inBlock = true;
			continue;
		}
		if (trimmed === EVIDENCE_BLOCK_END) {
			inBlock = false;
			continue;
		}
		if (!inBlock) kept.push(line);
	}
	return kept.join("\n");
}

export function parseEntry(raw: string, relPath: string): EntryMeta {
	const lines = raw.split(/\r?\n/);
	const hook = (lines.find((l) => l.trim().length > 0) ?? "").trim();
	const dateMatch = hook.match(DATE_RE);
	const versionMatch = hook.match(VERSION_RE);
	const scopeMatch = raw.match(SCOPE_LINE_RE);
	const sourceMatch = raw.match(SOURCE_LINE_RE);
	const verifyMatch = raw.match(VERIFY_LINE_RE);
	const statusMatch = raw.match(STATUS_LINE_RE);
	const statusValue = statusMatch?.[1]?.trim();
	let declaredStatus: EntryStatus | null = null;
	if (statusMatch) {
		if (statusValue === "正式" || statusValue === "有效") declaredStatus = "有效";
		else if (["候选待晋升", "待晋升", "候选", "待验证"].includes(statusValue ?? "")) declaredStatus = "待验证";
		else if (statusValue === "待复核" || statusValue === "待复核⚠️") declaredStatus = "待复核⚠️";
		else declaredStatus = "未知";
	}
	return {
		relPath,
		area: relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "",
		fileName: relPath.slice(relPath.lastIndexOf("/") + 1),
		hook,
		lastVerified: dateMatch ? dateMatch[0] : null,
		version: versionMatch ? versionMatch[1] : null,
		declaredStatus,
		scope: scopeMatch
			? scopeMatch[1]
					.split(/[,，、\s]+/)
					.map((s) => s.trim())
					.filter(Boolean)
			: null,
		source: sourceMatch ? sourceMatch[1].trim() : null,
		验证出处: verifyMatch ? verifyMatch[1].trim() : null,
	};
}

/** 子索引机械行可由条目文件生成/校验（§6.6）。链接目标用原文件名（中文名不转码）。 */
export function subindexRow(meta: EntryMeta): string {
	const date = meta.lastVerified ?? "无日期";
	return `- [${meta.fileName}](${meta.fileName}) — ${meta.hook}（${date}）`;
}
