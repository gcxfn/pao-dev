/**
 * 索引引用机械修复（M2-05 维护异常路径，G2-08「正本/索引可修复；失效引用可见」）：
 * 条目被改名或移动（无论走没走进库工具）后，旧路径引用的修复入口。
 *
 * 口径：
 * - 子索引是机械品（§6.6「子索引的机械行可由条目生成/校验」）：失效行（链接目标不在本区）
 *   摘除、缺行（条目在库无行）按条目重新生成——改名/移动后子索引自愈，不造第二份索引；
 * - 门面是策展品：只按调用方声明的 moves 改写引用（幂等：旧引用不复存在后重跑即无动作），
 *   无声明的失效引用只报告不删除（删策展内容不是机械的事，留部长终审）；
 * - 幂等可重跑：全部动作收敛后重跑 actions 为空、失效引用清单稳定。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../shared/atomic.ts";
import { withFileLock } from "../shared/lock.ts";
import { isMarkdownEntryFile, parseEntry, subindexRow } from "./entry.ts";
import { INDEX_FILE } from "./paths.ts";
import { ENTRY_TYPES } from "./types.ts";

/** 一次改名/移动的声明：库内相对路径 旧 → 新 */
export interface IndexMove {
	from: string;
	to: string;
}

export interface RepairResult {
	/** 实际执行的机械动作（收敛后重跑为空） */
	actions: string[];
	/** 门面里仍指向不存在条目的引用（策展品只报告不删除，格式 索引.md: 旧路径） */
	失效引用: string[];
}

const ROW_LINK_RE = /^(\s*-\s*\[[^\]]*\]\()([^)]+)(\).*)$/;

/** 从子索引行提取链接目标文件名（行内约定 `](文件名)`，兼容带路径写法）。 */
function rowTargetFile(line: string): string | null {
	const m = ROW_LINK_RE.exec(line);
	if (!m) return null;
	const target = m[2];
	return target.includes("/") ? target.slice(target.lastIndexOf("/") + 1) : target;
}

/** 单区子索引对账：失效行摘除＋缺行按条目生成。返回动作清单。 */
async function reconcileSubindex(libRoot: string, area: string): Promise<string[]> {
	const dir = join(libRoot, area);
	if (!existsSync(dir)) return [];
	const subindexFile = join(dir, "子索引.md");
	const actions: string[] = [];
	await withFileLock(subindexFile, () => {
		const entries = readdirSync(dir).filter(isMarkdownEntryFile).sort();
		let lines: string[];
		if (existsSync(subindexFile)) {
			lines = readFileSync(subindexFile, "utf8").split(/\r?\n/);
		} else {
			lines = [`# ${area} 子索引`, ""];
		}
		const entrySet = new Set(entries);
		const rowFiles = new Set<string>();
		const kept: string[] = [];
		const removed: string[] = [];
		for (const line of lines) {
			const target = rowTargetFile(line);
			if (target === null) {
				kept.push(line); // 非行内容（标题/注释/空行）原样保留
				continue;
			}
			if (entrySet.has(target)) {
				rowFiles.add(target);
				kept.push(line);
			} else {
				removed.push(target); // 索引行无条目：摘除（条目若只是改名，下面按条目重新生成新行）
			}
		}
		if (removed.length > 0) actions.push(`${area} 子索引摘除失效行：${removed.join("、")}`);
		// 条目在库无索引行：按条目机械生成（§6.6 行可由条目生成/校验）
		const added: string[] = [];
		for (const file of entries) {
			if (rowFiles.has(file)) continue;
			const raw = readFileSync(join(dir, file), "utf8");
			kept.push(subindexRow(parseEntry(raw, `${area}/${file}`)));
			added.push(file);
		}
		if (added.length > 0) actions.push(`${area} 子索引补生成行：${added.join("、")}`);
		if (removed.length > 0 || added.length > 0) {
			// 整写型（对账后整文件写回）：原子写，中断不留半截子索引
			writeFileAtomic(subindexFile, normalizeLines(kept));
		}
	});
	return actions;
}

function normalizeLines(lines: string[]): string {
	const cleaned: string[] = [];
	for (const line of lines) {
		if (line.trim() === "" && (cleaned.length === 0 || cleaned[cleaned.length - 1] === "")) continue;
		cleaned.push(line);
	}
	return `${cleaned.join("\n").replace(/\n*$/, "\n")}`;
}

/** 门面引用改写：按声明 moves 把 `](旧)` 换成 `](新)`（相对路径与裸文件名两种写法都认）。 */
function rewriteFacadeMoves(facadePath: string, moves: IndexMove[]): string[] {
	if (!existsSync(facadePath) || moves.length === 0) return [];
	const actions: string[] = [];
	let raw = readFileSync(facadePath, "utf8");
	for (const move of moves) {
		const fromFile = move.from.includes("/") ? move.from.slice(move.from.lastIndexOf("/") + 1) : move.from;
		const toFile = move.to.includes("/") ? move.to.slice(move.to.lastIndexOf("/") + 1) : move.to;
		const pairs: Array<[string, string]> = [
			[`(${move.from})`, `(${move.to})`],
			[`(${fromFile})`, `(${toFile})`],
		];
		let hit = false;
		for (const [from, to] of pairs) {
			if (raw.includes(from)) {
				raw = raw.split(from).join(to);
				hit = true;
			}
		}
		if (hit) actions.push(`门面引用已改写：${move.from} → ${move.to}`);
	}
	if (actions.length > 0) writeFileAtomic(facadePath, raw); // 整写型：原子写
	return actions;
}

/** 门面失效引用盘点：链接目标 .md 且文件不存在 → 报告（策展品不机删）。 */
function scanFacadeStale(libRoot: string, facadePath: string): string[] {
	if (!existsSync(facadePath)) return [];
	const stale: string[] = [];
	for (const line of readFileSync(facadePath, "utf8").split(/\r?\n/)) {
		const m = /\[[^\]]*\]\(([^)]+)\)/.exec(line);
		if (!m) continue;
		const target = m[1];
		if (!target.toLowerCase().endsWith(".md") || /^https?:/.test(target)) continue;
		const resolved = join(libRoot, target); // 门面在库根，链接目标相对库根解析
		if (!existsSync(resolved)) stale.push(`索引.md: ${target}`);
	}
	return stale;
}

/**
 * 引用机械修复入口：子索引对账（失效行摘＋缺行生成，逐区文件锁）＋门面声明 moves 改写＋
 * 门面失效引用报告。幂等可重跑；只动衍生品与声明的引用，条目正文与门面策展内容一字不动。
 */
export async function repairIndex(libRoot: string, moves: IndexMove[] = []): Promise<RepairResult> {
	const actions: string[] = [];
	for (const area of ENTRY_TYPES) {
		actions.push(...(await reconcileSubindex(libRoot, area)));
	}
	const facadePath = join(libRoot, INDEX_FILE);
	actions.push(...rewriteFacadeMoves(facadePath, moves));
	return { actions, 失效引用: scanFacadeStale(libRoot, facadePath) };
}
