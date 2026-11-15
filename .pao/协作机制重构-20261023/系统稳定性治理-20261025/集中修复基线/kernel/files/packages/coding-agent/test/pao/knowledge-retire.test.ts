/**
 * M2-05 知识维护异常路径：退役/打回（§6.7 终审三选一机械核）——
 * 移归档区＋子索引同批摘行（只归档不删除）；打回待验证（存疑内容不冒充有效货）；
 * 幂等可重放；向量缓存同批失效；正文一字不动。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { emptyVectorCache, loadVectorCache, saveVectorCache, sha1Text } from "../../src/pao/knowledge/cache.ts";
import { demoteToPending, retireEntry } from "../../src/pao/knowledge/retire.ts";

let libRoot: string;

beforeEach(() => {
	libRoot = mkdtempSync(join(tmpdir(), "pao-kb-retire-"));
	for (const dir of ["教训", "导览", "做法", "评测", "待验证", "归档"]) {
		mkdirSync(join(libRoot, dir));
	}
});

afterEach(() => {
	rmSync(libRoot, { recursive: true, force: true });
});

const ENTRY = `连接池排查 2026-10-01 版本:v2
正确做法：调大 pool 上限。
适用范围: demo-proj`;

function writeEntry(relPath: string, content: string): string {
	const abs = join(libRoot, relPath);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content, "utf8");
	return abs;
}

function writeSubindex(area: string, lines: string[]): void {
	writeFileSync(join(libRoot, area, "子索引.md"), `${lines.join("\n")}\n`, "utf8");
}

function rowsOf(area: string): string[] {
	const file = join(libRoot, area, "子索引.md");
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.trim().startsWith("- ["));
}

describe("M2-05：退役（移归档＋同批摘行，只归档不删除）", () => {
	test("退役：条目移归档区、子索引同批摘行、正文一字不动、归档区不设子索引", async () => {
		writeEntry("教训/连接池.md", ENTRY);
		writeSubindex("教训", ["# 教训 子索引", "", "- [连接池.md](连接池.md) — 连接池排查 2026-10-01（2026-10-01）"]);
		const before = readFileSync(join(libRoot, "教训/连接池.md"), "utf8");

		const result = await retireEntry({ libRoot, relPath: "教训/连接池.md" });

		// 移归档＋摘行
		expect(existsSync(join(libRoot, "归档/连接池.md"))).toBe(true);
		expect(existsSync(join(libRoot, "教训/连接池.md"))).toBe(false);
		expect(rowsOf("教训")).toEqual([]);
		expect(result.actions.join("\n")).toContain("子索引已摘行");
		expect(result.alreadyMoved).toBe(false);
		// 只归档不删除：正文一字不动
		expect(readFileSync(join(libRoot, "归档/连接池.md"), "utf8")).toBe(before);
		// 归档区不设子索引（摘行不建行）
		expect(existsSync(join(libRoot, "归档/子索引.md"))).toBe(false);
	});

	test("退役幂等重放：条目已在归档区 → 不报错、只确认摘行", async () => {
		writeEntry("教训/连接池.md", ENTRY);
		writeSubindex("教训", ["# 教训 子索引", "", "- [连接池.md](连接池.md) — x（2026-10-01）"]);
		await retireEntry({ libRoot, relPath: "教训/连接池.md" });

		const replay = await retireEntry({ libRoot, relPath: "教训/连接池.md" });
		expect(replay.alreadyMoved).toBe(true);
		expect(existsSync(join(libRoot, "归档/连接池.md"))).toBe(true);
		expect(rowsOf("教训")).toEqual([]);
	});

	test("中断重放（已移动未摘行）→ 重跑只修复摘行", async () => {
		writeEntry("教训/连接池.md", ENTRY);
		// 模拟中断现场：条目已移归档，子索引行还挂着
		renameSync(join(libRoot, "教训/连接池.md"), join(libRoot, "归档/连接池.md"));
		writeSubindex("教训", ["# 教训 子索引", "", "- [连接池.md](连接池.md) — x（2026-10-01）"]);

		const result = await retireEntry({ libRoot, relPath: "教训/连接池.md" });
		expect(result.alreadyMoved).toBe(true);
		expect(result.actions.join("\n")).toContain("子索引已摘行");
		expect(rowsOf("教训")).toEqual([]);
	});

	test("归档位同名不同内容 → 拒绝不自动覆盖；向量缓存同批失效", async () => {
		writeEntry("教训/连接池.md", ENTRY);
		writeFileSync(join(libRoot, "归档/连接池.md"), "另一份不同内容 2026-09-01", "utf8");
		await expect(retireEntry({ libRoot, relPath: "教训/连接池.md" })).rejects.toThrow("不自动覆盖");

		// 缓存同批失效：旧路径向量被丢弃，归档目标路径的旧向量也收敛
		writeEntry("教训/可退役.md", ENTRY);
		const cache = emptyVectorCache("mock-embed");
		cache.vectors["教训/可退役.md"] = { sha1: sha1Text(ENTRY), mtime: 0, embedding: [1, 0] };
		cache.vectors["归档/可退役.md"] = { sha1: "stale", mtime: 0, embedding: [0, 1] };
		saveVectorCache(libRoot, cache);
		await retireEntry({ libRoot, relPath: "教训/可退役.md" });
		const after = loadVectorCache(libRoot)!;
		expect(after.vectors["教训/可退役.md"]).toBeUndefined();
		expect(after.vectors["归档/可退役.md"]).toBeUndefined();
	});

	test("路径越界与非法区域当场拒绝", async () => {
		await expect(retireEntry({ libRoot, relPath: "../逃逸.md" })).rejects.toThrow("越界");
		await expect(retireEntry({ libRoot, relPath: "归档/已在归档.md" })).rejects.toThrow("不允许");
	});
});

describe("M2-05：打回待验证（存疑内容不冒充有效货）", () => {
	test("打回：移回待验证区＋子索引同批摘行＋缓存失效", async () => {
		writeEntry("教训/存疑.md", ENTRY);
		writeSubindex("教训", ["# 教训 子索引", "", "- [存疑.md](存疑.md) — x（2026-10-01）"]);

		const result = await demoteToPending({ libRoot, relPath: "教训/存疑.md" });
		expect(existsSync(join(libRoot, "待验证/存疑.md"))).toBe(true);
		expect(existsSync(join(libRoot, "教训/存疑.md"))).toBe(false);
		expect(rowsOf("教训")).toEqual([]);
		expect(result.alreadyMoved).toBe(false);
		// 正文原样保留（打回是搬移不是改写）
		expect(readFileSync(join(libRoot, "待验证/存疑.md"), "utf8")).toBe(ENTRY);
	});

	test("打回幂等重放：条目已在待验证区 → 不报错不重复生成", async () => {
		writeEntry("教训/存疑.md", ENTRY);
		await demoteToPending({ libRoot, relPath: "教训/存疑.md" });
		const replay = await demoteToPending({ libRoot, relPath: "教训/存疑.md" });
		expect(replay.alreadyMoved).toBe(true);
		expect(existsSync(join(libRoot, "待验证/存疑.md"))).toBe(true);
	});

	test("待验证区不能再打回（来源区域限定）", async () => {
		writeEntry("待验证/候选.md", ENTRY);
		await expect(demoteToPending({ libRoot, relPath: "待验证/候选.md" })).rejects.toThrow("不允许");
	});
});
