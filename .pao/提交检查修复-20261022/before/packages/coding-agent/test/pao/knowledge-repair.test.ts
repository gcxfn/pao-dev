/**
 * M2-05 知识维护异常路径：改名/引用失效的机械修复入口（G2-08「正本/索引可修复；失效引用可见」）
 * ＋ 门面/子索引一致性两向核对（条目在库无索引行 / 索引行无条目）。
 * 全部走临时夹具库，不碰真实库。
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { checkIndexConsistency, inspectLibrary } from "../../src/pao/knowledge/inspect.ts";
import { repairIndex } from "../../src/pao/knowledge/repair.ts";
import { withFileLock } from "../../src/pao/shared/lock.ts";

let libRoot: string;

beforeEach(() => {
	libRoot = mkdtempSync(join(tmpdir(), "pao-kb-repair-"));
	for (const dir of ["教训", "导览", "做法", "评测", "待验证", "归档"]) {
		mkdirSync(join(libRoot, dir));
	}
});

afterEach(() => {
	rmSync(libRoot, { recursive: true, force: true });
});

const ENTRY = `连接池排查 2026-10-01
正确做法：调大 pool 上限。
适用范围: demo-proj`;

function writeEntry(relPath: string, content: string): void {
	const abs = join(libRoot, relPath);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content, "utf8");
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

describe("M2-05：改名/移动后的引用机械修复", () => {
	test("区内改名（绕过工具直接改文件）→ 失效行摘除＋新行按条目生成，子索引自愈", async () => {
		writeEntry("教训/旧名.md", ENTRY);
		writeSubindex("教训", ["# 教训 子索引", "", "- [旧名.md](旧名.md) — 旧钩子（2026-10-01）"]);
		// 部长在库内直接改名（机械修复入口的典型现场）
		renameSync(join(libRoot, "教训/旧名.md"), join(libRoot, "教训/新名.md"));

		const result = await repairIndex(libRoot);

		expect(result.actions.join("\n")).toContain("摘除失效行：旧名.md");
		expect(result.actions.join("\n")).toContain("补生成行：新名.md");
		const rows = rowsOf("教训");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("](新名.md)");
		expect(rows[0]).toContain("连接池排查"); // 行由条目生成，钩子随正本
	});

	test("跨区移动 → 旧区失效行摘除、新区补生成行，条目正文不动", async () => {
		writeEntry("教训/搬移.md", ENTRY);
		writeSubindex("教训", ["# 教训 子索引", "", "- [搬移.md](搬移.md) — x（2026-10-01）"]);
		renameSync(join(libRoot, "教训/搬移.md"), join(libRoot, "做法/搬移.md"));

		await repairIndex(libRoot);

		expect(rowsOf("教训")).toEqual([]);
		const rows = rowsOf("做法");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("](搬移.md)");
		expect(readFileSync(join(libRoot, "做法/搬移.md"), "utf8")).toBe(ENTRY);
	});

	test("幂等重跑：收敛后重跑无新动作、行不重复生成", async () => {
		writeEntry("教训/旧名.md", ENTRY);
		writeSubindex("教训", [
			"# 教训 子索引",
			"",
			"- [旧名.md](旧名.md) — x（2026-10-01）",
			"- [孤儿.md](孤儿.md) — 幽灵行（无日期）",
		]);
		renameSync(join(libRoot, "教训/旧名.md"), join(libRoot, "教训/新名.md"));

		const first = await repairIndex(libRoot);
		expect(first.actions.length).toBeGreaterThan(0);
		const count1 = rowsOf("教训").length;

		const second = await repairIndex(libRoot);
		expect(second.actions).toEqual([]); // 收敛：无新动作
		expect(rowsOf("教训")).toHaveLength(count1);
		expect(second.失效引用).toEqual(first.失效引用); // 报告稳定
	});

	test("门面：声明 moves 改写旧引用；未声明的失效引用只报告不删除", async () => {
		writeEntry("教训/改名后.md", ENTRY);
		writeSubindex("教训", ["# 教训 子索引", "", "- [改名后.md](改名后.md) — x（2026-10-01）"]);
		writeFileSync(
			join(libRoot, "索引.md"),
			["# 部门知识库", "", "- 重点条目：[连接池](教训/旧名.md)", "- 导览：[子索引](教训/子索引.md)", ""].join("\n"),
			"utf8",
		);

		const result = await repairIndex(libRoot, [{ from: "教训/旧名.md", to: "教训/改名后.md" }]);
		expect(result.actions.join("\n")).toContain("门面引用已改写");

		const facade = readFileSync(join(libRoot, "索引.md"), "utf8");
		expect(facade).toContain("](教训/改名后.md)");
		expect(facade).not.toContain("旧名.md");
		// 子索引自愈（旧名行失效被摘、新名行生成）
		expect(rowsOf("教训").map((r) => r.includes("改名后.md"))).toEqual([true]);
		// 幂等：重跑同一 moves 无新动作
		const replay = await repairIndex(libRoot, [{ from: "教训/旧名.md", to: "教训/改名后.md" }]);
		expect(replay.actions).toEqual([]);
	});

	test("门面失效引用可见：指向不存在条目的策展链接原样保留并列入 失效引用", async () => {
		writeFileSync(
			join(libRoot, "索引.md"),
			["# 部门知识库", "", "- 幽灵：[不存在的条目](教训/幽灵.md)", ""].join("\n"),
			"utf8",
		);
		const result = await repairIndex(libRoot);
		expect(result.失效引用).toEqual(["索引.md: 教训/幽灵.md"]);
		// 策展内容不被机械删除
		expect(readFileSync(join(libRoot, "索引.md"), "utf8")).toContain("教训/幽灵.md");
	});
});

describe("M2-05：门面/子索引一致性两向核对（巡检报告）", () => {
	test("两向都可见：条目在库无索引行 ＋ 索引行无条目", async () => {
		writeEntry("教训/无行条目.md", ENTRY);
		writeEntry("教训/有行条目.md", ENTRY);
		writeSubindex("教训", [
			"# 教训 子索引",
			"",
			"- [有行条目.md](有行条目.md) — x（2026-10-01）",
			"- [幽灵.md](幽灵.md) — 幽灵（无日期）",
		]);

		const consistency = checkIndexConsistency(libRoot);
		expect(consistency.entriesWithoutRow).toEqual(["教训/无行条目.md"]);
		expect(consistency.rowsWithoutEntry).toEqual(["教训/幽灵.md"]);

		// 巡检报告带同一现场
		const report = await inspectLibrary(libRoot, { staleDays: 90, now: new Date("2026-10-02T00:00:00") });
		expect(report.consistency?.entriesWithoutRow).toEqual(["教训/无行条目.md"]);
		expect(report.consistency?.rowsWithoutEntry).toEqual(["教训/幽灵.md"]);
	});

	test("巡检同批补行修复「无行」向；「失效行」不自动摘（留 repair/退役 处理）", async () => {
		writeEntry("教训/无行条目.md", ENTRY);
		writeSubindex("教训", ["# 教训 子索引", "", "- [幽灵.md](幽灵.md) — 幽灵（无日期）"]);

		await inspectLibrary(libRoot, { staleDays: 90, now: new Date("2026-10-02T00:00:00") });

		// 无行 → 巡检 markSubindex 已补行（两向之一当场修复）
		expect(rowsOf("教训").filter((r) => r.includes("无行条目.md"))).toHaveLength(1);
		// 失效行不自动摘：中断重放的中间态不该被巡检误伤
		expect(rowsOf("教训").filter((r) => r.includes("幽灵.md"))).toHaveLength(1);
		// repairIndex 对账后幽灵行摘除
	});

	test("条目在库无索引行 → repairIndex 补行后两向清零", async () => {
		writeEntry("教训/无行条目.md", ENTRY);
		const before = checkIndexConsistency(libRoot);
		expect(before.entriesWithoutRow).toEqual(["教训/无行条目.md"]);

		await repairIndex(libRoot);
		const after = checkIndexConsistency(libRoot);
		expect(after.entriesWithoutRow).toEqual([]);
		expect(after.rowsWithoutEntry).toEqual([]);
	});

	test("删除条目后（索引行无条目）→ repairIndex 摘行，两向清零", async () => {
		writeEntry("教训/将删.md", ENTRY);
		await inspectLibrary(libRoot, { staleDays: 90, now: new Date("2026-10-02T00:00:00") }); // 生成行
		unlinkSync(join(libRoot, "教训/将删.md"));

		const before = checkIndexConsistency(libRoot);
		expect(before.rowsWithoutEntry).toEqual(["教训/将删.md"]);

		await repairIndex(libRoot);
		const after = checkIndexConsistency(libRoot);
		expect(after.rowsWithoutEntry).toEqual([]);
		expect(rowsOf("教训")).toEqual([]);
	});

	test("修复在锁内重新取条目列表，不把等待期间晋升的新索引行摘掉", async () => {
		writeEntry("教训/原条目.md", ENTRY);
		let repairing: ReturnType<typeof repairIndex> | undefined;
		await withFileLock(join(libRoot, "教训", "子索引.md"), async () => {
			repairing = repairIndex(libRoot);
			await new Promise((resolve) => setTimeout(resolve, 80));
			writeEntry("教训/新条目.md", ENTRY);
			writeSubindex("教训", ["# 教训 子索引", "", "- [新条目.md](新条目.md) — 新行"]);
		});
		await repairing!;
		expect(rowsOf("教训").some((row) => row.includes("新条目.md"))).toBe(true);
		expect(checkIndexConsistency(libRoot).entriesWithoutRow).toEqual([]);
	});
});
