import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { listSessionDirs } from "../../src/pao/migration/sessions.ts";

function makeSessionsRoot(): string {
	return mkdtempSync(join(tmpdir(), "pao-sessions-"));
}

describe("list-sessions（历史会话目录清单：只列不删）", () => {
	test("逐目录列 jsonl 数、字节数、最后修改时间", () => {
		const root = makeSessionsRoot();
		const dirA = join(root, "--D--AI-workspace-pao-dev--");
		const dirB = join(root, "--D--AI-workspace-pao--");
		mkdirSync(dirA, { recursive: true });
		mkdirSync(dirB, { recursive: true });
		writeFileSync(join(dirA, "20261001_120000_s1.jsonl"), '{"a":1}\n');
		writeFileSync(join(dirA, "20261002_130000_s2.jsonl"), '{"b":2}\n');
		writeFileSync(join(dirB, "20261003_140000_s3.jsonl"), "x");

		const dirs = listSessionDirs(root);
		expect(dirs).toHaveLength(2);
		const a = dirs.find((d) => d.dir.endsWith("pao-dev--"));
		expect(a?.sessions).toBe(2);
		expect(a?.bytes).toBe(16); // '{"a":1}\n' 8 字节 × 2
		expect(typeof a?.lastModified).toBe("string");
		const b = dirs.find((d) => d.dir.endsWith("pao--"));
		expect(b?.sessions).toBe(1);
	});

	test("空 jsonl 目录也列出（0 会话）；非目录项忽略；只读不改", () => {
		const root = makeSessionsRoot();
		mkdirSync(join(root, "--empty--"), { recursive: true });
		writeFileSync(join(root, "stray.txt"), "not a dir");
		const dirs = listSessionDirs(root);
		expect(dirs).toHaveLength(1);
		expect(dirs[0]?.sessions).toBe(0);
		// 只列不删：现场原样
		expect(readdirSync(root).length).toBe(2);
	});

	test("根不存在 → 结构化报错（不猜默认位置）", () => {
		expect(() => listSessionDirs(join(makeSessionsRoot(), "nope"))).toThrow(/不存在|nope/);
	});
});
