/**
 * 卡0004 验收 6：机械巡检——扫条目首行日期与来源版本，超期或版本不符
 * → 子索引行标 ⚠️；纯比对不起进程；巡检只标不说「错了」。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { inspectHook, inspectLibrary } from "../../src/pao/knowledge/inspect.ts";
import { withFileLock } from "../../src/pao/shared/lock.ts";

let libRoot: string;
const NOW = new Date("2026-10-02T00:00:00");

beforeEach(() => {
	libRoot = mkdtempSync(join(tmpdir(), "pao-kb-inspect-"));
	for (const dir of ["教训", "导览", "做法", "评测", "待验证", "归档"]) {
		mkdirSync(join(libRoot, dir));
	}
});

afterEach(() => {
	rmSync(libRoot, { recursive: true, force: true });
});

function writeEntry(relPath: string, content: string): void {
	const abs = join(libRoot, relPath);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content, "utf8");
}

const FRESH = "新鲜的条目 2026-09-25 版本:v2\n正文\n适用范围: demo-proj";
const STALE = "超期的条目 2026-01-01 版本:v2\n正文\n适用范围: demo-proj";
const WRONG_VERSION = "版本不符的条目 2026-09-25 版本:v1\n正文\n适用范围: demo-proj";
const NO_DATE = "没有日期的条目\n正文\n适用范围: demo-proj";

describe("验收6：机械巡检", () => {
	test("超期未核（可配阈值）→ 标 ⚠️，附多久没核", () => {
		const finding = inspectHook(STALE, { staleDays: 90, now: NOW });
		expect(finding.flagged).toBe(true);
		expect(finding.problems[0]).toContain("超期");
		expect(finding.problems[0]).toContain("2026-01-01");

		const ok = inspectHook(FRESH, { staleDays: 90, now: NOW });
		expect(ok.flagged).toBe(false);
		// 阈值可配：放宽到 365 天后同一条目不再超期
		const relaxed = inspectHook(STALE, { staleDays: 365, now: NOW });
		expect(relaxed.flagged).toBe(false);
	});

	test("来源版本不符才比对；通用做法不强制绑定版本，缺日期仍标", () => {
		const mismatch = inspectHook(WRONG_VERSION, { expectedVersion: "v2", now: NOW });
		expect(mismatch.flagged).toBe(true);
		expect(mismatch.problems.join(";")).toContain("版本对不上");
		expect(mismatch.problems.join(";")).toContain("v1");

		const generic = inspectHook("通用做法 2026-09-25", { expectedVersion: "v2", now: NOW });
		expect(generic.flagged).toBe(false);
		const missingDate = inspectHook(NO_DATE, { now: NOW });
		expect(missingDate.problems.join(";")).toContain("缺最后核验日期");
	});

	test("巡检全库并同步子索引行 ⚠️；纯比对、不下「错了」的结论", async () => {
		writeEntry("教训/新鲜的.md", FRESH);
		writeEntry("教训/超期的.md", STALE);
		writeEntry("做法/版本不符.md", WRONG_VERSION);

		const report = await inspectLibrary(libRoot, { expectedVersion: "v2", staleDays: 90, now: NOW });
		expect(report.flaggedCount).toBe(2);

		const staleRows = readFileSync(join(libRoot, "教训", "子索引.md"), "utf8");
		expect(staleRows).toContain("- [超期的.md](超期的.md)");
		expect(staleRows).toContain("⚠️");
		// 新鲜条目不带 ⚠️
		const freshLine = staleRows.split("\n").find((l) => l.includes("新鲜的.md"));
		expect(freshLine).not.toContain("⚠️");
		// 做法区也标了
		expect(readFileSync(join(libRoot, "做法", "子索引.md"), "utf8")).toContain("⚠️");
		// 机器只陈述差异，从不说「错了」
		for (const finding of report.findings) {
			for (const problem of finding.problems) {
				expect(problem).not.toContain("错");
			}
		}
	});

	test("⚠️ 是同步不是追加：复检通过后 ⚠️ 摘掉", async () => {
		writeEntry("教训/超期的.md", STALE);
		await inspectLibrary(libRoot, { staleDays: 90, now: NOW });
		expect(readFileSync(join(libRoot, "教训", "子索引.md"), "utf8")).toContain("⚠️");

		// 部长更新日期后复检
		writeEntry("教训/超期的.md", "超期的条目 2026-09-30 版本:v2\n正文\n适用范围: demo-proj");
		await inspectLibrary(libRoot, { staleDays: 90, now: NOW });
		const line = readFileSync(join(libRoot, "教训", "子索引.md"), "utf8")
			.split("\n")
			.find((l) => l.includes("超期的.md"));
		expect(line).toBeDefined();
		expect(line!.includes("⚠️")).toBe(false);
		const before = readFileSync(join(libRoot, "教训", "子索引.md"), "utf8");
		await inspectLibrary(libRoot, { staleDays: 90, now: NOW });
		expect(readFileSync(join(libRoot, "教训", "子索引.md"), "utf8")).toBe(before);
	});

	test("归档区与待验证区不参与子索引标记（归档不进索引、待验证不设索引）", async () => {
		writeEntry("归档/旧条目.md", STALE);
		writeEntry("待验证/候选.md", STALE);
		const report = await inspectLibrary(libRoot, { staleDays: 90, now: NOW });
		expect(report.findings.map((f) => f.relPath)).toEqual([]);
		expect(existsSync(join(libRoot, "归档", "子索引.md"))).toBe(false);
		expect(existsSync(join(libRoot, "待验证", "子索引.md"))).toBe(false);
	});

	test("巡检等待同一区域写锁，并读取锁释放后的新增条目，保住新索引行", async () => {
		writeEntry("教训/原条目.md", FRESH);
		const indexPath = join(libRoot, "教训", "子索引.md");
		let inspecting: ReturnType<typeof inspectLibrary> | undefined;
		let completed = false;
		await withFileLock(indexPath, async () => {
			inspecting = inspectLibrary(libRoot, { now: NOW, areas: ["教训"] });
			void inspecting.then(() => {
				completed = true;
			});
			await new Promise((resolve) => setTimeout(resolve, 80));
			expect(completed).toBe(false);
			writeEntry("教训/新条目.md", FRESH);
			writeFileSync(indexPath, "# 教训 子索引\n\n- [新条目.md](新条目.md) — 新行\n");
		});
		const report = await inspecting!;
		expect(report.findings).toHaveLength(2);
		const rows = readFileSync(indexPath, "utf8");
		expect(rows).toContain("新条目.md");
		expect(rows).toContain("原条目.md");
	});
});
