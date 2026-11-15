/** 桌面机械子进程的只读巡检/本地索引预读；没有模型、派卡或入库入口。 */
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { readRegistry } from "../dept/registry.ts";
import { checkIndexConsistency, inspectHook } from "../knowledge/inspect.ts";
import { ENTRY_TYPES } from "../knowledge/types.ts";

export async function readMechanicalMaintenance(
	home: string,
	mode: "巡检" | "保温",
	checkpoint: () => Promise<void> = async () => {},
): Promise<string> {
	const root = realpathSync(home);
	const checked = (path: string) => {
		if (lstatSync(path).isSymbolicLink()) throw new Error(`机械维护拒绝符号链接：${path}`);
		const real = realpathSync(path);
		const rel = relative(root, real);
		if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`机械维护路径越界：${path}`);
		return real;
	};
	const registry = checked(join(root, "部门", "注册表.md"));
	const reports: unknown[] = [];
	for (const dept of readRegistry(registry)) {
		await checkpoint();
		const library = checked(join(root, dept.库路径));
		const findings: unknown[] = [];
		let bytes = 0;
		for (const area of ENTRY_TYPES) {
			const dir = join(library, area);
			if (!existsSync(dir)) continue;
			checked(dir);
			for (const file of readdirSync(dir)) {
				await checkpoint();
				if (!file.endsWith(".md")) continue;
				const body = await readFile(checked(join(dir, file)), "utf8");
				await checkpoint();
				bytes += Buffer.byteLength(body);
				if (mode === "巡检" && file !== "子索引.md")
					findings.push({ 文件: `${area}/${file}`, ...inspectHook(body.split(/\r?\n/)[0] ?? "") });
			}
		}
		reports.push({
			部门: dept.名字,
			读取字节: bytes,
			...(mode === "巡检" ? { findings, 一致性: checkIndexConsistency(library) } : {}),
		});
	}
	return JSON.stringify(
		{
			操作: mode,
			边界: "只读；不改子索引、不落卡、不写知识条目、不调用模型或嵌入。保温仅操作系统文件缓存预读，不宣称持久语义索引已刷新。",
			reports,
		},
		null,
		2,
	);
}
