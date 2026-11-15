/**
 * 部门知识面板（/队列 追加段与 /状态 部门区共用的纯读聚合,架构 §6.6 三道锁可见锁）。
 * 从接线层（原 src/pao/index.ts）迁入部门域：数据源本来就是部门注册表与子索引。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { DEPT_DIR_NAME, REGISTRY_FILE_NAME, readRegistry } from "./registry.ts";

/** 数子索引里带 ⚠️ 标记的行（纯读;⚠️ 由 pao_inspect_kb 写入,面板只数不写） */
function countFlagsInSubindex(libRoot: string, area: string): number {
	const file = join(libRoot, area, "子索引.md");
	if (!existsSync(file)) return 0;
	return readFileSync(file, "utf8")
		.split(/\r?\n/)
		.filter((line) => line.includes("⚠️")).length;
}

function countPendingCandidates(libRoot: string): number {
	const dir = join(libRoot, "待验证");
	if (!existsSync(dir)) return 0;
	return readdirSync(dir).filter((name) => name.endsWith(".md")).length;
}

/** 部门积压结构化快照（面板渲染与 §16.1 首跑清单同源计数,不建第二份口径） */
export interface DeptBacklogRow {
	部门: string;
	待验证: number;
	/** 各区 ⚠️ 行数（只记非零区） */
	警示: { area: string; count: number }[];
}

/** 部门积压读取结果。rows 为空时仍需区分“确实没有部门”和“读取失败”。 */
interface DeptBacklogReadResult {
	rows: DeptBacklogRow[];
	error?: string;
}

function formatReadError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function readDeptBacklogSnapshot(home: string): DeptBacklogReadResult {
	let rows: ReturnType<typeof readRegistry>;
	try {
		rows = readRegistry(join(home, DEPT_DIR_NAME, REGISTRY_FILE_NAME));
	} catch (error) {
		return { rows: [], error: formatReadError(error) };
	}
	try {
		const snapshot: DeptBacklogRow[] = [];
		for (const row of rows) {
			const libRoot = join(home, row.库路径);
			if (!existsSync(libRoot)) continue;
			snapshot.push({
				部门: row.名字,
				待验证: countPendingCandidates(libRoot),
				警示: (["教训", "导览", "做法", "评测"] as const)
					.map((area) => ({ area, count: countFlagsInSubindex(libRoot, area) }))
					.filter((item) => item.count > 0),
			});
		}
		return { rows: snapshot };
	} catch (error) {
		return { rows: [], error: formatReadError(error) };
	}
}

/**
 * 部门知识积压快照（纯读）：逐部门 待验证 条数与各区 ⚠️ 数。
 * 注册表缺失/为空 → 空数组；读取失败抛明确错误，由调用界面显示原因。
 */
export function deptBacklogSnapshot(home: string): DeptBacklogRow[] {
	const result = readDeptBacklogSnapshot(home);
	if (result.error) throw new Error(`部门知识积压读取失败：${result.error}；请核对注册表和库目录后重试`);
	return result.rows;
}

/**
 * 部门知识面板（纯读）:逐部门显示 待验证积压 条数与各区 ⚠️ 数。
 * 注册表缺失/为空 → 空数组；读失败返回错误行，不影响 /队列 本体渲染。
 */
export async function renderDeptPanels(home: string): Promise<string[]> {
	const lines: string[] = [];
	const result = readDeptBacklogSnapshot(home);
	if (result.error) return [`⚠ 部门知识面板读取失败：${result.error}`];
	for (const row of result.rows) {
		const parts = [`待验证 ${row.待验证} 条`];
		if (row.警示.length > 0) parts.push(`⚠️ ${row.警示.map((f) => `${f.area} ${f.count}`).join("、")}`);
		// 二批图形化:行首状态符号——有积压/警示 ⚠,干净 ✓(子串「部门:…」原样保留)
		const prefix = row.待验证 > 0 || row.警示.length > 0 ? "⚠ " : "✓ ";
		lines.push(`${prefix}- ${row.部门}:${parts.join("｜")}`);
	}
	if (lines.length === 0) return [];
	return [[`── 部门知识面板(候选滞留可见,§6.6 三道锁可见锁) ──`, ...lines].join("\n")];
}
