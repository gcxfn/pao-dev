import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import lockfile from "proper-lockfile";

import { writeFileAtomic } from "../shared/atomic.ts";
import { pathKey } from "../shared/path-key.ts";
import { nowString } from "../shared/time.ts";

/**
 * 服务过的项目清单(M2-01 §5):独立文件 <PAO_HOME>/项目清单.md,不扩部门注册表——
 * 注册表行是部门,项目正交且一项目可跨多部门。一行一项目:项目名/项目根/首次服务/最近服务。
 * 追加复用 appendRegistryRow 同款 proper-lockfile 锁模式(跨进程安全,Windows 可用,自带 stale 恢复);
 * 幂等:同项目根(归一化比对)已有行只刷「最近服务」,显示列保留首次记录的原始写法。
 * 本步只提供函数;建卡/派卡机械层的写入时机接线在后续步。
 */

/** 项目清单文件名,固定在 PAO_HOME 根下 */
export const PROJECT_LIST_FILE_NAME = "项目清单.md";

/** 项目清单一行 = 一个服务过的项目 */
export interface ProjectListRow {
	/** 项目名,取项目根 basename;显示用,保留原始大小写 */
	项目名: string;
	/** 项目根(绝对路径);显示用,保留首次记录的原始写法 */
	项目根: string;
	/** 首次服务时间 YYYY-MM-DD HH:mm;同项目根重复记录不刷此列 */
	首次服务: string;
	/** 最近服务时间 YYYY-MM-DD HH:mm;同项目根重复记录只刷此列 */
	最近服务: string;
}

/** 项目清单文件路径:$PAO_HOME/项目清单.md */
export function projectListPath(paoHome: string): string {
	return join(paoHome, PROJECT_LIST_FILE_NAME);
}

/**
 * 项目根归一化比对键:trim＋反斜杠折叠成正斜杠＋去尾斜杠,大小写折叠走 shared/path-key 正本
 * (NTFS 大小写不敏感,摩擦日志 2026-10-02 分仓搬迁实测教训;posix 保原样)。
 * 只用于查重比对,显示列一律保留原始写法。
 */
export function normalizedProjectRoot(projectRoot: string): string {
	return pathKey(projectRoot.trim().replace(/\\/g, "/")).replace(/\/+$/, "");
}

/** 项目清单文本 → 行数组。解析 markdown 表格行;跳过表头与分隔行。 */
export function parseProjectList(text: string): ProjectListRow[] {
	const rows: ProjectListRow[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim().startsWith("|")) continue;
		const cells = line
			.split("|")
			.map((cell) => cell.trim())
			.filter((_, index, all) => !(index === 0 || index === all.length - 1));
		if (cells.length < 4) continue;
		// 表头分隔行:| --- | --- | --- | --- |
		if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;
		if (cells[0] === "项目名") continue;
		rows.push({
			项目名: cells[0],
			项目根: cells[1] ?? "",
			首次服务: cells[2] ?? "",
			最近服务: cells[3] ?? "",
		});
	}
	return rows;
}

export function formatProjectListRow(row: ProjectListRow): string {
	return `| ${row.项目名} | ${row.项目根} | ${row.首次服务} | ${row.最近服务} |`;
}

/** 空项目清单文本(带表头,文件从创建起就是可解析的;两列时间由代码写,无任何待填占位) */
export function formatProjectList(rows: ProjectListRow[]): string {
	return [
		"# 服务过的项目清单",
		"",
		"<!-- 一行一项目:项目名/项目根/首次服务/最近服务;由代码在建卡/派卡命中项目根时锁追加维护(幂等:同项目根只刷最近服务),不靠模型手改;查重比对用归一化键(小写+正斜杠+去尾斜杠),显示保留原始写法 -->",
		"",
		"| 项目名 | 项目根 | 首次服务 | 最近服务 |",
		"| --- | --- | --- | --- |",
		...rows.map(formatProjectListRow),
		"",
	].join("\n");
}

/** 读项目清单;文件不存在视为空(空态由渲染层说明,不报错) */
export function readProjectList(listPath: string): ProjectListRow[] {
	if (!existsSync(listPath)) return [];
	return parseProjectList(readFileSync(listPath, "utf8"));
}

/** 纯只读:PAO_HOME → 服务过的项目行数组(渲染与聚合都从这里读,不写盘) */
export function listProjects(paoHome: string): ProjectListRow[] {
	return readProjectList(projectListPath(paoHome));
}

/**
 * 在表格文本中原位刷新匹配项目根那一行的「最近服务」,其余行与表外内容逐字节保留。
 * 返回刷新后的全文与是否命中;显示列(项目名/项目根/首次服务)保留原始写法。
 */
function refreshRecentInText(text: string, projectRoot: string, time: string): { text: string; found: boolean } {
	const key = normalizedProjectRoot(projectRoot);
	let found = false;
	const lines = text.split(/\r?\n/).map((line) => {
		if (found || !line.trim().startsWith("|")) return line;
		const cells = line
			.split("|")
			.map((cell) => cell.trim())
			.filter((_, index, all) => !(index === 0 || index === all.length - 1));
		if (cells.length < 4) return line;
		if (normalizedProjectRoot(cells[1] ?? "") !== key) return line;
		found = true;
		return formatProjectListRow({
			项目名: cells[0] ?? "",
			项目根: cells[1] ?? "",
			首次服务: cells[2] ?? "",
			最近服务: time,
		});
	});
	return { text: lines.join("\n"), found };
}

/**
 * 记录一个服务过的项目(带文件锁,同 appendRegistryRow 的跨进程安全参数)。
 * - 该项目根(归一化比对)尚无行 → 追加一行,返回 "created";项目名取根 basename,首次/最近服务都写本次时间;
 * - 已有行 → 只刷「最近服务」列(原位替换单行,文件其余内容不动),返回 "refreshed"。
 * 时间由调用方传入(缺省取当前时刻),不内藏时钟,保持可测。
 */
export async function recordProjectServed(
	paoHome: string,
	projectRoot: string,
	time: string = nowString(),
): Promise<"created" | "refreshed"> {
	const root = projectRoot.trim();
	if (!root) throw new Error("项目根为空,拒绝记录服务过的项目");
	const listPath = projectListPath(paoHome);
	mkdirSync(dirname(listPath), { recursive: true });
	if (!existsSync(listPath)) {
		writeFileAtomic(listPath, formatProjectList([]));
	}
	// sync API 不支持 retries,用异步锁(与 dept/registry.ts appendRegistryRow 同款参数)
	const release = await lockfile.lock(listPath, {
		retries: { retries: 9, factor: 2, minTimeout: 50, maxTimeout: 1000, randomize: false },
		stale: 10_000,
		// 目标可能刚创建;不做 realpath 解析
		realpath: false,
	});
	try {
		const rows = readProjectList(listPath);
		const key = normalizedProjectRoot(root);
		if (rows.some((row) => normalizedProjectRoot(row.项目根) === key)) {
			const current = readFileSync(listPath, "utf8");
			const refreshed = refreshRecentInText(current, root, time);
			if (refreshed.text !== current) writeFileAtomic(listPath, refreshed.text);
			return "refreshed";
		}
		let text = readFileSync(listPath, "utf8");
		if (!text.endsWith("\n")) text += "\n";
		const row: ProjectListRow = {
			项目名: basename(root.replace(/\\/g, "/")),
			项目根: root,
			首次服务: time,
			最近服务: time,
		};
		writeFileAtomic(listPath, `${text + formatProjectListRow(row)}\n`);
		return "created";
	} finally {
		await release();
	}
}
