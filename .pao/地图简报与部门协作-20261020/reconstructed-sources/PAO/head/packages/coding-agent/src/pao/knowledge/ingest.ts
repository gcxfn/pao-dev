/**
 * 入库工具的机械核（§6.6）：转正三件事——移条目进类型目录、子索引加行、触发机械巡检。
 * 按幂等可重放设计：条目是正本，中断后重跑修复索引、不重复生成条目；
 * 子索引机械行由条目文件生成/校验；移动、条目内订正与子索引行写入收进同一
 * 子索引文件锁临界区，两个会话并发晋升同一候选时后到者按幂等重放收尾（G2-08）。
 * 缓存同批失效：旧路径与新路径向量都丢弃，下次查询按需重建。
 */
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { writeFileAtomic } from "../shared/atomic.ts";
import { withFileLock } from "../shared/lock.ts";
import { isCacheUsable, loadVectorCache, saveVectorCache } from "./cache.ts";
import { parseEntry, subindexRow } from "./entry.ts";
import { type InspectionOptions, type InspectionReport, inspectLibrary } from "./inspect.ts";
import { ENTRY_TYPES, type EntryType } from "./types.ts";

export interface IngestOptions extends InspectionOptions {
	libRoot: string;
	/** 候选条目路径（通常在 待验证/ 下；幂等重放时也可以已在目标位） */
	candidatePath: string;
	/** 目标类型区 */
	type: EntryType;
	/** 落位文件名；缺省沿用原文件名 */
	newFileName?: string;
	/**
	 * 新钩子（摩擦日志 2026-10-02「子索引钩子区分度弱」）：传入则改写条目首行钩子，
	 * 子索引行随之用它。建议含可检索具体名词并保留最后核验日期；不传沿用原首行。
	 */
	新钩子?: string;
	/**
	 * 适用范围（禁外发门禁键，§6.3/R08）：传入则确保条目有「适用范围: <值>」标记行——
	 * 无则插入（首个二级标题前），有且值不同则改写，一致则不动。值须与
	 * PAO_HOME/知识库配置/外发许可.json 的白名单键一致，否则语义路按未授权降级词法独跑。
	 */
	适用范围?: string;
	/**
	 * 验证出处（genericagent 借鉴③）：传入则确保条目有「验证出处: <值>」标记行——
	 * 记录这条做法由哪张卡、哪次真实验证过（无出处旧条目标注未验证，不删除、不参与高置信引用）。
	 * 与「来源:」不同：来源是知识从哪抄来的，验证出处是本地哪次真实跑过。
	 */
	验证出处?: string;
	/** 入库后是否顺带清理空缓存文件以外的旧缓存（默认仅失效相关向量） */
	now?: Date;
}

export interface IngestResult {
	targetPath: string;
	/** 实际执行的动作（重放时可能只剩校验类动作） */
	actions: string[];
	/** 本次调用是否为幂等重放（条目已在目标位） */
	alreadyPromoted: boolean;
	inspection: InspectionReport;
}

export async function ingestEntry(options: IngestOptions): Promise<IngestResult> {
	const { libRoot, candidatePath, type } = options;
	if (!ENTRY_TYPES.includes(type)) {
		throw new Error(`未知类型区「${type}」，允许：${ENTRY_TYPES.join("、")}`);
	}
	const typeDir = join(libRoot, type);
	const sourcePath = candidatePath;
	const fileName = options.newFileName ?? basename(sourcePath);
	const targetPath = join(typeDir, fileName);

	// 候选与目标路径都须落在库根内，不猜（与 retire.ts 同款纪律）
	assertInsideLib(libRoot, sourcePath);
	assertInsideLib(libRoot, targetPath);

	const actions: string[] = [];
	let alreadyPromoted = false;

	if (!existsSync(sourcePath) && !existsSync(targetPath)) {
		throw new Error(`候选条目不存在：${sourcePath}`);
	}

	// —— 临界区（§6.6 子索引文件锁；G2-08 并发晋升）：移动、条目内订正、子索引行同锁串行——
	// 两个会话同时入库同一候选时在锁上排队，后到者看到条目已在目标位，按幂等重放收尾：
	// 不重复生成条目、不半途覆盖、不因对方抢先移动而 ENOENT 崩溃。
	// 锁目标在类型区下，先确保区目录存在（首入库时还没有；mkdir 幂等）。
	mkdirSync(typeDir, { recursive: true });
	await withFileLock(join(typeDir, "子索引.md"), () => {
		// 锁内权威复核：目标位同名且内容不同 → 拒绝，不自动覆盖
		if (existsSync(targetPath) && existsSync(sourcePath) && sourcePath !== targetPath) {
			const targetRaw = readFileSync(targetPath, "utf8");
			const sourceRaw = readFileSync(sourcePath, "utf8");
			if (targetRaw !== sourceRaw) {
				throw new Error(`目标位已有同名且内容不同的条目：${targetPath}；请先人工核对，不自动覆盖`);
			}
			// 目标位内容一致：说明上次转正已移动过（或重复投递），以目标位为准
			alreadyPromoted = true;
		}

		// —— 第 1 步：移条目（移动是原子的第一步，中断后重跑从这里修复）——
		if (existsSync(sourcePath) && sourcePath !== targetPath) {
			mkdirSync(typeDir, { recursive: true });
			renameSync(sourcePath, targetPath);
			actions.push(`已移动 ${basename(sourcePath)} → ${type}/${fileName}`);
		} else if (existsSync(targetPath)) {
			alreadyPromoted = true;
			actions.push("条目已在目标位，跳过移动");
		}

		// —— 第 1.5 步：条目内机械订正（只动状态行与新钩子首行，正文其余一字不动）——
		const statusNote = correctStatusLine(targetPath);
		if (statusNote) actions.push(`条目状态行已订正：${statusNote} → 状态: 正式`);
		const newHook = options.新钩子?.trim();
		if (newHook) {
			const rewritten = rewriteFirstLine(targetPath, newHook);
			if (rewritten) actions.push(`条目首行钩子已改写（子索引行随之更新）：${rewritten}`);
		}
		const scopeValue = options.适用范围?.trim();
		if (scopeValue) {
			const scopeNote = ensureScopeLine(targetPath, scopeValue);
			if (scopeNote) actions.push(`条目适用范围行已落：${scopeNote}`);
		}
		const verifyValue = options.验证出处?.trim();
		if (verifyValue) {
			const verifyNote = ensureVerificationLine(targetPath, verifyValue);
			if (verifyNote) actions.push(`条目验证出处行已落：${verifyNote}`);
		}

		// —— 第 2 步：子索引加行（同一临界区内，行由条目生成，可重复校验）——
		const raw = readFileSync(targetPath, "utf8");
		const meta = parseEntry(raw, `${type}/${fileName}`);
		const row = subindexRow(meta);
		{
			const subindexFile = join(typeDir, "子索引.md");
			let lines: string[];
			if (existsSync(subindexFile)) {
				lines = readFileSync(subindexFile, "utf8").split(/\r?\n/);
			} else {
				lines = [`# ${type} 子索引`, ""];
			}
			const deduped = lines.filter((l) => !(l.trim().startsWith("- [") && l.includes(`](${fileName})`)));
			const hadRow = deduped.length !== lines.length;
			deduped.push(row);
			writeSubindex(subindexFile, deduped);
			if (!hadRow) actions.push("子索引已加行");
			else actions.push("子索引行已校验（未重复生成）");
		}
	});

	// —— 第 3 步：缓存同批失效（旧路径 + 新路径，不只处理新增）——
	const cache = loadVectorCache(libRoot);
	if (cache) {
		let dropped = 0;
		const oldRel = relativePosix(libRoot, sourcePath);
		const newRel = `${type}/${fileName}`;
		if (oldRel && oldRel in cache.vectors) {
			delete cache.vectors[oldRel];
			dropped++;
		}
		if (newRel in cache.vectors) {
			delete cache.vectors[newRel];
			dropped++;
		}
		if (dropped > 0) {
			if (isCacheUsable(cache, cache.embedModel, cache.chunkParams)) saveVectorCache(libRoot, cache);
			actions.push(`已失效 ${dropped} 条旧向量`);
		}
	}

	// —— 第 4 步：触发机械巡检（只本类型区）——
	const inspection = await inspectLibrary(libRoot, {
		expectedVersion: options.expectedVersion,
		staleDays: options.staleDays,
		now: options.now,
		areas: [type],
	});
	actions.push(`机械巡检完成（${type} 区 ⚠️ ${inspection.flaggedCount} 条）`);

	return { targetPath, actions, alreadyPromoted, inspection };
}

function writeSubindex(file: string, lines: string[]): void {
	mkdirSync(join(file, ".."), { recursive: true });
	// 清理多余空行再写回；原子写（同目录临时文件＋rename），中断不留半截子索引
	const cleaned: string[] = [];
	for (const line of lines) {
		if (line.trim() === "" && (cleaned.length === 0 || cleaned[cleaned.length - 1] === "")) continue;
		cleaned.push(line);
	}
	writeFileAtomic(file, `${cleaned.join("\n").replace(/\n*$/, "\n")}`);
}

/**
 * 条目内状态行机械订正（摩擦日志 2026-10-02「位置与正文状态打架」）：条目已搬进类型区（位置转正），
 * 正文里残留的候选语义状态行（如 状态: 候选待晋升/待晋升/候选/待验证/未知/空）同批订正为 状态: 正式。
 * 只动命中的状态行，正文其余字节原样保留；无命中则不写文件。返回被订正的旧值描述，无订正返回 null。
 */
const CANDIDATE_STATUS_RE =
	/^([ \t]*)状态[ \t]*[:：][ \t]*(候选待晋升|待晋升|候选|待验证|未知|unknown)?[ \t]*(\r?)$/gim;

function correctStatusLine(filePath: string): string | null {
	const raw = readFileSync(filePath, "utf8");
	const oldValues: string[] = [];
	const fixed = raw.replace(CANDIDATE_STATUS_RE, (_match, indent: string, value: string | undefined, cr: string) => {
		oldValues.push(value ? `状态: ${value}` : "状态:（空）");
		return `${indent}状态: 正式${cr}`;
	});
	if (oldValues.length === 0) return null;
	// 整写型（读原文→订正→整文件写回）：原子写，不留半成品
	writeFileAtomic(filePath, fixed);
	return [...new Set(oldValues)].join("、");
}

/** 改写条目首行钩子（只动第一行，换行风格与正文其余原样保留）；首行已一致则不动。返回原首行，无改动返回 null。 */
function rewriteFirstLine(filePath: string, newHook: string): string | null {
	const raw = readFileSync(filePath, "utf8");
	const breakAt = raw.search(/\r?\n/);
	const firstLine = breakAt === -1 ? raw : raw.slice(0, breakAt);
	if (firstLine.trim() === newHook) return null;
	const rest = breakAt === -1 ? "\n" : raw.slice(breakAt);
	// 整写型：原子写
	writeFileAtomic(filePath, `${newHook}${rest}`);
	return firstLine.trim() || "（原首行为空）";
}

const SCOPE_LINE = /^适用范围[:：]\s*(.*)$/;

/**
 * 确保「适用范围: <值>」标记行存在（外发门禁键，§6.3/R08）：无行则插在首个二级标题前
 * （无标题则追加末尾），已有且值不同则改写该行，一致则不动。换行风格保留原文件口径。
 * 返回给人看的动作说明；无改动返回 null。
 */
function ensureScopeLine(filePath: string, value: string): string | null {
	const raw = readFileSync(filePath, "utf8");
	const eol = raw.includes("\r\n") ? "\r\n" : "\n";
	const lines = raw.split(/\r?\n/);
	const idx = lines.findIndex((line) => SCOPE_LINE.test(line));
	if (idx >= 0) {
		const current = SCOPE_LINE.exec(lines[idx])?.[1]?.trim() ?? "";
		if (current === value) return null;
		const old = lines[idx].trim();
		lines[idx] = `适用范围: ${value}`;
		// 整写型：原子写
		writeFileAtomic(filePath, lines.join(eol));
		return `${old} → ${lines[idx]}`;
	}
	let insertAt = lines.findIndex((line) => line.startsWith("## "));
	if (insertAt < 0) insertAt = lines.length;
	const insert = lines[insertAt - 1] === "" ? [`适用范围: ${value}`] : [`适用范围: ${value}`, ""];
	lines.splice(insertAt, 0, ...insert);
	// 整写型：原子写
	writeFileAtomic(filePath, lines.join(eol));
	return `已插入「适用范围: ${value}」`;
}

const VERIFY_LINE = /^验证出处[:：]\s*(.*)$/;

/**
 * 确保「验证出处: <值>」标记行存在（genericagent 借鉴③）：位置与「适用范围:」同策略
 * （首个二级标题前，无标题则追加末尾），已有且值不同则改写该行，一致则不动；
 * 换行风格保留原文件口径。返回给人看的动作说明；无改动返回 null。
 */
function ensureVerificationLine(filePath: string, value: string): string | null {
	const raw = readFileSync(filePath, "utf8");
	const eol = raw.includes("\r\n") ? "\r\n" : "\n";
	const lines = raw.split(/\r?\n/);
	const idx = lines.findIndex((line) => VERIFY_LINE.test(line));
	if (idx >= 0) {
		const current = VERIFY_LINE.exec(lines[idx])?.[1]?.trim() ?? "";
		if (current === value) return null;
		const old = lines[idx].trim();
		lines[idx] = `验证出处: ${value}`;
		// 整写型：原子写
		writeFileAtomic(filePath, lines.join(eol));
		return `${old} → ${lines[idx]}`;
	}
	let insertAt = lines.findIndex((line) => line.startsWith("## "));
	if (insertAt < 0) insertAt = lines.length;
	const insert = lines[insertAt - 1] === "" ? [`验证出处: ${value}`] : [`验证出处: ${value}`, ""];
	lines.splice(insertAt, 0, ...insert);
	// 整写型：原子写
	writeFileAtomic(filePath, lines.join(eol));
	return `已插入「验证出处: ${value}」`;
}

/** 库内校验：解析后必须落在知识库根内；越界（..、绝对路径逃逸、反斜杠/盘符变体）当场拒绝，不猜。 */
function assertInsideLib(libRoot: string, path: string): void {
	const root = resolve(libRoot);
	const resolved = resolve(path);
	if (resolved !== root && !resolved.startsWith(root + sep)) {
		throw new Error(`入库路径越界：${path}（解析后须落在知识库根内：${root}）`);
	}
}

/** Windows 路径转 POSIX 相对串；越界返回空串。 */
function relativePosix(from: string, to: string): string {
	const rel = to
		.slice(from.length)
		.replace(/^[\\/]/, "")
		.replace(/\\/g, "/");
	return to.startsWith(from) ? rel : "";
}
