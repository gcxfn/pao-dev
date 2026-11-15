/**
 * 条目退役与打回（§6.7 终审三选一的两向机械核，M2-05 知识维护异常路径）：
 * - 退役：移归档区＋子索引同批摘行，只归档不删除（正文一字不动）；
 * - 打回待验证：移回 待验证/ ＋子索引同批摘行（存疑内容不冒充有效货）。
 * 与入库同款纪律：幂等可重放（条目是正本，中断后重跑只修复）、临界区用子索引文件锁、
 * 向量缓存同批失效（旧路径向量丢弃，下次查询按需重建，R08 不只处理新增）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../shared/atomic.ts";
import { withFileLock } from "../shared/lock.ts";
import { isCacheUsable, loadVectorCache, saveVectorCache } from "./cache.ts";
import { ENTRY_TYPES } from "./types.ts";

export interface MoveOutOptions {
	libRoot: string;
	/** 条目当前相对路径（相对库根，如 `教训/连接池.md`） */
	relPath: string;
}

export interface MoveOutResult {
	/** 移动后的路径 */
	targetPath: string;
	/** 实际执行的机械动作（重放时只剩校验类动作） */
	actions: string[];
	/** 本次调用是否为幂等重放（条目已在目标区） */
	alreadyMoved: boolean;
}

/** 解析库内相对路径；越界（..）与非法区域当场拒绝，不猜。 */
function splitRelPath(relPath: string, allowedRegions: readonly string[]): { area: string; fileName: string } {
	if (relPath.includes("..") || relPath.includes("\\") || relPath.startsWith("/")) {
		throw new Error(`条目路径越界：${relPath}（须是库内相对路径，如 教训/xx.md）`);
	}
	const cut = relPath.indexOf("/");
	if (cut <= 0) {
		throw new Error(`条目路径缺区域前缀：${relPath}（应为 区域/文件名）`);
	}
	const area = relPath.slice(0, cut);
	const fileName = relPath.slice(cut + 1);
	if (!allowedRegions.includes(area)) {
		throw new Error(`区域「${area}」不允许此操作，允许：${allowedRegions.join("、")}`);
	}
	if (!fileName || fileName.endsWith("/")) {
		throw new Error(`条目路径缺文件名：${relPath}`);
	}
	return { area, fileName };
}

/**
 * 把条目移出索引区（退役/打回共用的机械核）：
 * 移动＋子索引摘行在同一子索引文件锁临界区内同批完成（§6.7「子索引同批摘行」），
 * 目标位冲突语义与入库一致（同名不同内容拒绝、同内容按幂等重放收尾）。
 * cacheLabel 只是动作文案用的人类标签（如「退役」「打回待验证」）。
 */
async function moveOutOfIndex(
	options: MoveOutOptions,
	toArea: string,
	cacheLabel: string,
	allowedSources: readonly string[],
): Promise<MoveOutResult> {
	const { libRoot, relPath } = options;
	const { area, fileName } = splitRelPath(relPath, allowedSources);
	const sourcePath = join(libRoot, area, fileName);
	const targetDir = join(libRoot, toArea);
	const targetPath = join(targetDir, fileName);

	const actions: string[] = [];
	let alreadyMoved = false;

	if (!existsSync(sourcePath) && !existsSync(targetPath)) {
		throw new Error(`条目不存在：${sourcePath}`);
	}

	// —— 临界区：移动与摘行同批（两会话同时终审同一条件不双写、不半途）——
	await withFileLock(join(libRoot, area, "子索引.md"), () => {
		// 锁内权威复核：目标位同名且内容不同 → 拒绝，不自动覆盖（与入库同款语义）
		if (targetPath !== sourcePath && existsSync(targetPath) && existsSync(sourcePath)) {
			if (readFileSync(targetPath, "utf8") !== readFileSync(sourcePath, "utf8")) {
				throw new Error(`目标位已有同名且内容不同的条目：${targetPath}；请先人工核对，不自动覆盖`);
			}
			alreadyMoved = true;
		}

		// 第 1 步：移条目（只归档不删除：正文一字不动，rename 原子搬移）
		if (existsSync(sourcePath) && sourcePath !== targetPath) {
			mkdirSync(targetDir, { recursive: true });
			renameSync(sourcePath, targetPath);
			actions.push(`已移动 ${area}/${fileName} → ${toArea}/${fileName}（${cacheLabel}，正文原样保留）`);
		} else if (existsSync(targetPath)) {
			alreadyMoved = true;
			actions.push(`条目已在${toArea}区，跳过移动`);
		}

		// 第 2 步：子索引同批摘行（行由条目生成，按文件名匹配摘除；无行也是合法重放终态）
		const subindexFile = join(libRoot, area, "子索引.md");
		if (existsSync(subindexFile)) {
			const lines = readFileSync(subindexFile, "utf8").split(/\r?\n/);
			const kept = lines.filter((l) => !(l.trim().startsWith("- [") && l.includes(`](${fileName})`)));
			if (kept.length !== lines.length) {
				writeSubindexLines(subindexFile, kept);
				actions.push(`${area} 子索引已摘行`);
			}
		}
	});

	// —— 第 3 步：向量缓存同批失效（旧路径 + 目标路径，不只处理新增）——
	const cache = loadVectorCache(libRoot);
	if (cache) {
		let dropped = 0;
		for (const rel of [`${area}/${fileName}`, `${toArea}/${fileName}`]) {
			if (rel in cache.vectors) {
				delete cache.vectors[rel];
				dropped++;
			}
		}
		if (dropped > 0) {
			if (isCacheUsable(cache, cache.embedModel, cache.chunkParams)) saveVectorCache(libRoot, cache);
			actions.push(`已失效 ${dropped} 条旧向量`);
		}
	}

	return { targetPath, actions, alreadyMoved };
}

function writeSubindexLines(file: string, lines: string[]): void {
	// 与入库/巡检同款写回：清多余空行，保尾部换行；整写型→原子写（同目录临时文件＋rename）
	const cleaned: string[] = [];
	for (const line of lines) {
		if (line.trim() === "" && (cleaned.length === 0 || cleaned[cleaned.length - 1] === "")) continue;
		cleaned.push(line);
	}
	writeFileAtomic(file, `${cleaned.join("\n").replace(/\n*$/, "\n")}`);
}

/** 退役（§6.7 三选一）：移归档区＋子索引同批摘行，只归档不删除。归档区不设子索引、不进检索与巡检。 */
export function retireEntry(options: MoveOutOptions): Promise<MoveOutResult> {
	return moveOutOfIndex(options, "归档", "退役", [...ENTRY_TYPES, "待验证"]);
}

/** 打回待验证（§6.7 三选一）：移回 待验证/ ＋子索引同批摘行，存疑内容不冒充有效货。 */
export function demoteToPending(options: MoveOutOptions): Promise<MoveOutResult> {
	return moveOutOfIndex(options, "待验证", "打回待验证", ENTRY_TYPES);
}
