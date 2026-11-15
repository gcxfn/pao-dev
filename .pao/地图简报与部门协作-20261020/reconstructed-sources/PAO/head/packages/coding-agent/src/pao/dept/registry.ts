import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { writeFileAtomic } from "../shared/atomic.ts";

/** 部门总目录名(相对 PAO_HOME) */
export const DEPT_DIR_NAME = "部门";

/** 注册表文件名,固定在 <PAO_HOME>/部门/ 下;唯一真相:名字/能力标签/库路径 */
export const REGISTRY_FILE_NAME = "注册表.md";

/** 注册表一行 = 一个部门 */
export interface DeptRegistryRow {
	/** 部门名字,即目录名 */
	名字: string;
	/** 能力标签,主控派卡/协作路由的匹配依据 */
	标签: string[];
	/** 该部门知识库路径(相对 PAO_HOME) */
	库路径: string;
	/** 建部日期 YYYY-MM-DD;pao_create_dept 代码取当天写入,不是模型参数;旧 3 列行解析不出时为 undefined */
	建部日期?: string;
}

function splitTags(raw: string): string[] {
	return raw
		.split(/[、,，;；]/)
		.map((tag) => tag.trim())
		.filter(Boolean);
}

/** 注册表文本 → 行数组。解析 markdown 表格行;跳过表头与分隔行;渲染与查询都从这里读。 */
export function parseRegistry(text: string): DeptRegistryRow[] {
	const rows: DeptRegistryRow[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim().startsWith("|")) continue;
		const cells = line
			.split("|")
			.map((cell) => cell.trim())
			.filter((_, index, all) => !(index === 0 || index === all.length - 1));
		if (cells.length < 3) continue;
		// 表头分隔行:| --- | --- | --- |
		if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;
		if (cells[0] === "名字") continue;
		rows.push({
			名字: cells[0],
			标签: splitTags(cells[1] ?? ""),
			库路径: cells[2] ?? "",
			建部日期: cells[3] || undefined,
		});
	}
	return rows;
}

export function formatRegistryRow(row: DeptRegistryRow): string {
	return `| ${row.名字} | ${row.标签.join("、")} | ${row.库路径} | ${row.建部日期 ?? ""} |`;
}

/** 空注册表文本(带表头,注册表文件从创建起就是可解析的;建部日期列由 pao_create_dept 代码写当天,无任何待填占位) */
export function formatRegistry(rows: DeptRegistryRow[]): string {
	return [
		"# 部门注册表",
		"",
		"<!-- 唯一真相:名字/能力标签/库路径/建部日期;建部日期由 pao_create_dept 代码取当天写入,不让模型传;会话启动时渲染进主控与部长提示;改这里,下一次会话天然生效 -->",
		"",
		"| 名字 | 能力标签 | 库路径 | 建部日期 |",
		"| --- | --- | --- | --- |",
		...rows.map(formatRegistryRow),
		"",
	].join("\n");
}

/** 读注册表;文件不存在视为空(空态由渲染层说明,不报错) */
export function readRegistry(registryPath: string): DeptRegistryRow[] {
	if (!existsSync(registryPath)) return [];
	return parseRegistry(readFileSync(registryPath, "utf8"));
}

/**
 * 带文件锁追加一行(同款跨进程安全:proper-lockfile,mkdir 原子性,Windows 可用,自带 stale 恢复)。
 * 幂等:已有同名部门行则原样保留(不覆盖已有内容),返回 "exists"。
 */
export async function appendRegistryRow(registryPath: string, row: DeptRegistryRow): Promise<"created" | "exists"> {
	mkdirSync(dirname(registryPath), { recursive: true });
	if (!existsSync(registryPath)) {
		// 原子写:半截注册表会让并发读方把已有部门解析丢行(锁只保追加序,不保读方看到的完整性)
		writeFileAtomic(registryPath, formatRegistry([]));
	}
	// sync API 不支持 retries,用异步锁(与 src/pao/shared/lock.ts 同款参数)
	const release = await lockfile.lock(registryPath, {
		retries: { retries: 9, factor: 2, minTimeout: 50, maxTimeout: 1000, randomize: false },
		stale: 10_000,
		// 目标可能刚创建;不做 realpath 解析
		realpath: false,
	});
	try {
		const rows = readRegistry(registryPath);
		if (rows.some((existing) => existing.名字 === row.名字)) return "exists";
		let text = readFileSync(registryPath, "utf8");
		if (!text.endsWith("\n")) text += "\n";
		writeFileAtomic(registryPath, `${text + formatRegistryRow(row)}\n`);
		return "created";
	} finally {
		await release();
	}
}
