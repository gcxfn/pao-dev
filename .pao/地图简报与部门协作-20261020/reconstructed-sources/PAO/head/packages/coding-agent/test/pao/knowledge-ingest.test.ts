/**
 * 卡0004 验收 5：入库幂等——转正三件事（移条目/子索引加行/触发巡检），
 * 重复执行修索引不重复生成，中断重跑修复，子索引行可由条目文件校验生成。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseEntry, subindexRow } from "../../src/pao/knowledge/entry.ts";
import { ingestEntry } from "../../src/pao/knowledge/ingest.ts";

let libRoot: string;

beforeEach(() => {
	libRoot = mkdtempSync(join(tmpdir(), "pao-kb-ingest-"));
	for (const dir of ["教训", "导览", "做法", "评测", "待验证", "归档"]) {
		mkdirSync(join(libRoot, dir));
	}
});

afterEach(() => {
	rmSync(libRoot, { recursive: true, force: true });
});

const CONTENT = `数据库连接池超时三条经验 2026-10-01
正确做法：调大 pool 上限。
适用范围: demo-proj
来源: 内部压测`;

const subindex = () => readFileSync(join(libRoot, "教训", "子索引.md"), "utf8");
const rowsOf = () =>
	subindex()
		.split("\n")
		.filter((l) => l.trim().startsWith("- ["));

describe("验收5：入库幂等", () => {
	test("转正：移条目进类型目录 + 子索引加行 + 触发巡检", async () => {
		const candidate = join(libRoot, "待验证", "连接池经验.md");
		writeFileSync(candidate, CONTENT, "utf8");

		const result = await ingestEntry({ libRoot, candidatePath: candidate, type: "教训" });

		expect(existsSync(join(libRoot, "教训", "连接池经验.md"))).toBe(true);
		expect(existsSync(candidate)).toBe(false);
		expect(rowsOf()).toHaveLength(1);
		expect(result.actions.some((a) => a.includes("机械巡检"))).toBe(true);
		expect(result.alreadyPromoted).toBe(false);
		expect(result.inspection.findings).toHaveLength(1);
	});

	test("重复执行同一次转正（条目已在目标位）→ 修索引不重复生成", async () => {
		const candidate = join(libRoot, "待验证", "连接池经验.md");
		writeFileSync(candidate, CONTENT, "utf8");
		await ingestEntry({ libRoot, candidatePath: candidate, type: "教训" });

		// 用原始候选路径重放同一指令
		const replay = await ingestEntry({ libRoot, candidatePath: candidate, type: "教训" });
		expect(replay.alreadyPromoted).toBe(true);
		expect(replay.actions.join("\n")).toContain("子索引行已校验");
		expect(rowsOf()).toHaveLength(1);

		// 用目标位路径再重放，同样幂等
		const replay2 = await ingestEntry({
			libRoot,
			candidatePath: join(libRoot, "教训", "连接池经验.md"),
			type: "教训",
		});
		expect(replay2.alreadyPromoted).toBe(true);
		expect(rowsOf()).toHaveLength(1);
	});

	test("模拟中断（只移动未加行）→ 重跑修复索引", async () => {
		const candidate = join(libRoot, "待验证", "连接池经验.md");
		writeFileSync(candidate, CONTENT, "utf8");
		// 中断现场：条目已移动，但子索引还没写
		renameSync(candidate, join(libRoot, "教训", "连接池经验.md"));
		expect(existsSync(join(libRoot, "教训", "子索引.md"))).toBe(false);

		const result = await ingestEntry({
			libRoot,
			candidatePath: join(libRoot, "教训", "连接池经验.md"),
			type: "教训",
		});
		expect(result.alreadyPromoted).toBe(true);
		expect(result.actions.join("\n")).toContain("子索引已加行");
		expect(rowsOf()).toHaveLength(1);
	});

	test("模拟中断（行已写但未移动）→ 重跑完成移动且不重复加行", async () => {
		const candidate = join(libRoot, "待验证", "连接池经验.md");
		writeFileSync(candidate, CONTENT, "utf8");
		// 中断现场：手工预写了行（相当于上一个动作序列反常的残留）
		writeFileSync(
			join(libRoot, "教训", "子索引.md"),
			`# 教训 子索引\n\n${subindexRow(parseEntry(CONTENT, "教训/连接池经验.md"))}\n`,
			"utf8",
		);

		const result = await ingestEntry({ libRoot, candidatePath: candidate, type: "教训" });
		expect(existsSync(candidate)).toBe(false);
		expect(existsSync(join(libRoot, "教训", "连接池经验.md"))).toBe(true);
		expect(rowsOf()).toHaveLength(1);
		expect(result.actions.join("\n")).toContain("子索引行已校验");
	});

	test("子索引行可由条目文件校验生成（行内容 = subindexRow(parseEntry(正文))）", async () => {
		const candidate = join(libRoot, "待验证", "连接池经验.md");
		writeFileSync(candidate, CONTENT, "utf8");
		await ingestEntry({ libRoot, candidatePath: candidate, type: "教训" });

		const targetRaw = readFileSync(join(libRoot, "教训", "连接池经验.md"), "utf8");
		const expected = subindexRow(parseEntry(targetRaw, "教训/连接池经验.md"));
		expect(rowsOf()).toEqual([expected]);
	});

	test("目标位已有同名且内容不同的条目 → 拒绝，不自动覆盖", async () => {
		const candidate = join(libRoot, "待验证", "连接池经验.md");
		writeFileSync(candidate, CONTENT, "utf8");
		writeFileSync(join(libRoot, "教训", "连接池经验.md"), "另一份不同的内容 2026-09-01\n正文", "utf8");

		await expect(ingestEntry({ libRoot, candidatePath: candidate, type: "教训" })).rejects.toThrow("不自动覆盖");
	});

	test("候选与目标都不存在 → 报错", async () => {
		await expect(
			ingestEntry({ libRoot, candidatePath: join(libRoot, "待验证", "不存在.md"), type: "教训" }),
		).rejects.toThrow("不存在");
	});

	test("入库只巡检受影响类型区，不改其他区的子索引", async () => {
		const candidate = join(libRoot, "待验证", "新做法.md");
		writeFileSync(candidate, CONTENT);
		writeFileSync(join(libRoot, "教训", "超期.md"), "超期教训 2026-01-01\n正文\n适用范围: demo-proj");
		const untouched = "# 教训 子索引\n\n- [超期.md](超期.md) — 保留的旧行\n";
		writeFileSync(join(libRoot, "教训", "子索引.md"), untouched);
		const result = await ingestEntry({
			libRoot,
			candidatePath: candidate,
			type: "做法",
			now: new Date("2026-10-02T00:00:00"),
		});
		expect(result.inspection.findings.map((finding) => finding.relPath)).toEqual(["做法/新做法.md"]);
		expect(readFileSync(join(libRoot, "教训", "子索引.md"), "utf8")).toBe(untouched);
	});
});

describe("借鉴③：知识条目带验证出处", () => {
	test("入库带出处 → 落「验证出处:」标记行,回读拿得到", async () => {
		const candidate = join(libRoot, "待验证", "连接池经验.md");
		writeFileSync(candidate, CONTENT, "utf8");
		const result = await ingestEntry({
			libRoot,
			candidatePath: candidate,
			type: "教训",
			验证出处: "卡0007 2026-10-04 真机验收",
		});

		const target = join(libRoot, "教训", "连接池经验.md");
		const raw = readFileSync(target, "utf8");
		expect(result.actions.join("\n")).toContain("验证出处行已落");
		expect(raw).toContain("验证出处: 卡0007 2026-10-04 真机验收");
		expect(parseEntry(raw, "教训/连接池经验.md").验证出处).toBe("卡0007 2026-10-04 真机验收");
	});

	test("不带出处 → 不写标记行,回读为 null（旧条目不编造出处,只标未验证）", async () => {
		const candidate = join(libRoot, "待验证", "连接池经验.md");
		writeFileSync(candidate, CONTENT, "utf8");
		await ingestEntry({ libRoot, candidatePath: candidate, type: "教训" });

		const raw = readFileSync(join(libRoot, "教训", "连接池经验.md"), "utf8");
		expect(raw).not.toContain("验证出处");
		expect(parseEntry(raw, "教训/连接池经验.md").验证出处).toBeNull();
	});

	test("复验改出处 → 覆盖同一行,不新增行", async () => {
		const candidate = join(libRoot, "待验证", "连接池经验.md");
		writeFileSync(candidate, CONTENT, "utf8");
		await ingestEntry({ libRoot, candidatePath: candidate, type: "教训", 验证出处: "卡0007 首次验收" });
		await ingestEntry({
			libRoot,
			candidatePath: join(libRoot, "教训", "连接池经验.md"),
			type: "教训",
			验证出处: "卡0011 复验",
		});

		const raw = readFileSync(join(libRoot, "教训", "连接池经验.md"), "utf8");
		expect(raw.match(/验证出处[:：]/g)?.length).toBe(1);
		expect(raw).toContain("验证出处: 卡0011 复验");
		expect(raw).not.toContain("卡0007 首次验收");
	});
});

describe("入库路径越界校验", () => {
	test("候选路径在库外（绝对路径逃逸）→ 拒绝且不移动", async () => {
		const outside = mkdtempSync(join(tmpdir(), "pao-kb-outside-"));
		try {
			const outsideFile = join(outside, "恶意.md");
			writeFileSync(outsideFile, CONTENT, "utf8");
			await expect(ingestEntry({ libRoot, candidatePath: outsideFile, type: "教训" })).rejects.toThrow("越界");
			expect(existsSync(join(libRoot, "教训", "恶意.md"))).toBe(false);
			expect(existsSync(outsideFile)).toBe(true);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("候选路径 .. 越界 → 拒绝", async () => {
		const escapee = join(libRoot, "待验证", "..", "..", "逃逸.md");
		await expect(ingestEntry({ libRoot, candidatePath: escapee, type: "教训" })).rejects.toThrow("越界");
	});

	test("新文件名 .. 越界 → 拒绝且候选不被移动", async () => {
		const candidate = join(libRoot, "待验证", "连接池经验.md");
		writeFileSync(candidate, CONTENT, "utf8");
		await expect(
			ingestEntry({ libRoot, candidatePath: candidate, type: "教训", newFileName: `..${sep}..${sep}逃逸.md` }),
		).rejects.toThrow("越界");
		expect(existsSync(candidate)).toBe(true);
		expect(existsSync(join(libRoot, "教训", "逃逸.md"))).toBe(false);
	});

	test("Windows 反斜杠/盘符变体越界 → 拒绝", async () => {
		if (process.platform !== "win32") return;
		const backslashed = `${join(libRoot, "待验证")}\\..\\..\\逃逸.md`;
		await expect(ingestEntry({ libRoot, candidatePath: backslashed, type: "教训" })).rejects.toThrow("越界");
		await expect(ingestEntry({ libRoot, candidatePath: "C:\\pao-库外逃逸.md", type: "教训" })).rejects.toThrow(
			"越界",
		);
	});
});
