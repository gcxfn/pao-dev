/**
 * 机械巡检（§6.7）：扫条目首行的日期与来源版本，超期未核或版本不符 → 子索引行标 ⚠️。
 * 纯比对、不起进程；机器只说「多久没核 / 版本对不上 / 缺标注」，从不说「错了」。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../shared/atomic.ts";
import { withFileLock } from "../shared/lock.ts";
import { parseEntry, subindexRow } from "./entry.ts";
import { subindexPath } from "./paths.ts";
import { ENTRY_TYPES, type EntryType } from "./types.ts";

export const DEFAULT_STALE_DAYS = 90;

export interface InspectionOptions {
	/** 期望的来源版本；只比对已经声明来源版本的条目，不要求通用做法凭空绑定版本。 */
	expectedVersion?: string;
	/** 超期阈值天数，默认 90 */
	staleDays?: number;
	now?: Date;
	/** 显式巡检默认四区；入库只传受影响的类型区。 */
	areas?: readonly EntryType[];
}

export interface HookFinding {
	flagged: boolean;
	/** 机械问题描述，只陈述差异，不下「错了」的结论 */
	problems: string[];
}

export function inspectHook(hook: string, opts: InspectionOptions = {}): HookFinding {
	const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS;
	const now = opts.now ?? new Date();
	const meta = parseEntry(hook, "x");
	const problems: string[] = [];
	if (!meta.lastVerified) {
		problems.push("缺最后核验日期，核验时间未知");
	} else {
		const verified = new Date(`${meta.lastVerified}T00:00:00`);
		const days = Math.floor((now.getTime() - verified.getTime()) / 86_400_000);
		if (!Number.isNaN(days) && days > staleDays) {
			problems.push(`超期 ${days} 天未核验（上次核验 ${meta.lastVerified}，阈值 ${staleDays} 天）`);
		}
	}
	if (opts.expectedVersion && meta.version && meta.version !== opts.expectedVersion) {
		problems.push(`版本对不上：期望 ${opts.expectedVersion}，条目标注 ${meta.version}`);
	}
	return { flagged: problems.length > 0, problems };
}

export interface InspectionFinding extends HookFinding {
	relPath: string;
}

export interface InspectionReport {
	findings: InspectionFinding[];
	flaggedCount: number;
	/**
	 * 门面/子索引一致性两向核对（M2-05/G2-08，巡检标记前的现场）：
	 * - entriesWithoutRow：条目在库但子索引无行——本次巡检的 markSubindex 已同批补行修复；
	 * - rowsWithoutEntry：子索引有行但条目不在库（改名/移动/删除后的失效引用）——不自动摘行
	 *   （中断重放的中间态不该被巡检误伤），由 repairIndex 对账或 退役/打回 摘行。
	 */
	consistency?: IndexConsistency;
}

/** 门面/子索引一致性两向核对结果（§6.6 读者路径 门面→子索引→条目）。 */
export interface IndexConsistency {
	entriesWithoutRow: string[];
	rowsWithoutEntry: string[];
}

const ROW_LINK_RE = /- \[[^\]]*\]\(([^)]+)\)/;

function areaConsistency(type: EntryType, files: string[], lines: string[]): IndexConsistency {
	const fileSet = new Set(files);
	const rowFiles = new Set<string>();
	const rowsWithoutEntry: string[] = [];
	for (const line of lines) {
		const m = ROW_LINK_RE.exec(line);
		if (!m) continue;
		const target = m[1];
		const name = target.includes("/") ? target.slice(target.lastIndexOf("/") + 1) : target;
		rowFiles.add(name);
		if (!fileSet.has(name)) rowsWithoutEntry.push(`${type}/${name}`);
	}
	return {
		entriesWithoutRow: files.filter((file) => !rowFiles.has(file)).map((file) => `${type}/${file}`),
		rowsWithoutEntry,
	};
}

/**
 * 一致性两向核对（纯读不写）：逐类型区对「条目文件集合」与「子索引行集合」做双向差。
 * 「条目在库无索引行」与「索引行无条目」都可见，不偏袒任何一向。
 */
export function checkIndexConsistency(libRoot: string): IndexConsistency {
	const entriesWithoutRow: string[] = [];
	const rowsWithoutEntry: string[] = [];
	for (const type of ENTRY_TYPES) {
		const dir = join(libRoot, type);
		if (!existsSync(dir)) continue;
		const files = readdirSync(dir)
			.filter((f) => f.endsWith(".md") && f !== "子索引.md")
			.sort();
		const subindexFile = subindexPath(libRoot, type);
		const lines = existsSync(subindexFile) ? readFileSync(subindexFile, "utf8").split(/\r?\n/) : [];
		const area = areaConsistency(type, files, lines);
		entriesWithoutRow.push(...area.entriesWithoutRow);
		rowsWithoutEntry.push(...area.rowsWithoutEntry);
	}
	return {
		entriesWithoutRow: entriesWithoutRow.sort(),
		rowsWithoutEntry: rowsWithoutEntry.sort(),
	};
}

/** 按类型区锁住读取、核验与索引写回；每区只读写一次子索引。 */
export async function inspectLibrary(libRoot: string, opts: InspectionOptions = {}): Promise<InspectionReport> {
	const consistency: IndexConsistency = { entriesWithoutRow: [], rowsWithoutEntry: [] };
	const findings: InspectionFinding[] = [];
	for (const type of opts.areas ?? ENTRY_TYPES) {
		const dir = join(libRoot, type);
		if (!existsSync(dir)) continue;
		const subindexFile = subindexPath(libRoot, type);
		await withFileLock(subindexFile, () => {
			const files = readdirSync(dir)
				.filter((file) => file.endsWith(".md") && file !== "子索引.md")
				.sort();
			const lines = existsSync(subindexFile)
				? readFileSync(subindexFile, "utf8").split(/\r?\n/)
				: [`# ${type} 子索引`, ""];
			const area = areaConsistency(type, files, lines);
			consistency.entriesWithoutRow.push(...area.entriesWithoutRow);
			consistency.rowsWithoutEntry.push(...area.rowsWithoutEntry);
			const rows = files.map((file) => {
				const meta = parseEntry(readFileSync(join(dir, file), "utf8"), `${type}/${file}`);
				const finding = inspectHook(meta.hook, opts);
				findings.push({ ...finding, relPath: meta.relPath });
				return { meta, flagged: finding.flagged };
			});
			if (rows.length > 0) updateSubindexRows(subindexFile, lines, rows);
		});
	}
	consistency.entriesWithoutRow.sort();
	consistency.rowsWithoutEntry.sort();
	return { findings, flaggedCount: findings.filter((f) => f.flagged).length, consistency };
}

/** 子索引行维护：确保该条目有一行（缺则补），并按巡检结果同步行尾 ⚠️。 */
export async function markSubindex(
	libRoot: string,
	type: EntryType,
	meta: ReturnType<typeof parseEntry>,
	flagged: boolean,
): Promise<void> {
	const file = subindexPath(libRoot, type);
	mkdirSync(join(libRoot, type), { recursive: true });
	await withFileLock(file, () => {
		const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [`# ${type} 子索引`, ""];
		updateSubindexRows(file, lines, [{ meta, flagged }]);
	});
}

function updateSubindexRows(
	file: string,
	lines: string[],
	rows: { meta: ReturnType<typeof parseEntry>; flagged: boolean }[],
): void {
	const names = new Set(rows.map(({ meta }) => meta.fileName));
	const kept = lines.filter((line) => {
		const match = ROW_LINK_RE.exec(line);
		if (!line.trim().startsWith("- [") || !match) return true;
		const target = match[1];
		const name = target.includes("/") ? target.slice(target.lastIndexOf("/") + 1) : target;
		return !names.has(name);
	});
	while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
	if (kept.length > 0) kept.push("");
	for (const { meta, flagged } of rows) kept.push(`${subindexRow(meta)}${flagged ? " ⚠️" : ""}`);
	const next = kept.join("\n").replace(/\n*$/, "\n");
	// 整写型（子索引行整文件写回）：原子写；内容未变不重写
	if (!existsSync(file) || lines.join("\n") !== next) writeFileAtomic(file, next);
}
