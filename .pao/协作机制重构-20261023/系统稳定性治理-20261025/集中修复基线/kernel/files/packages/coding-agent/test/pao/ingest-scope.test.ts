import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseEntry } from "../../src/pao/knowledge/entry.ts";
import { ingestEntry } from "../../src/pao/knowledge/ingest.ts";

let dir: string | undefined;
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

function setupLib(entryBody: string): string {
	dir = mkdtempSync(join(tmpdir(), "pao-ingest-scope-"));
	mkdirSync(join(dir, "待验证"), { recursive: true });
	const name = `${entryBody.slice(1, 20).replaceAll(/[\\/:*?"<>|#\s]/g, "_")}.md`;
	writeFileSync(join(dir, "待验证", name), entryBody, "utf8");
	return join(dir, "待验证", name);
}

const ENTRY = [
	"# 某手法:做法留档 2026-10-02",
	"",
	"> 候选条目:整理自某处,待验证",
	"",
	"## 适用边界",
	"",
	"正文一句话。",
].join("\n");

describe("pao_ingest_kb 适用范围参数（外发门禁键）", () => {
	it("无行则插入首个二级标题前，parseEntry 能读回", async () => {
		const candidate = setupLib(ENTRY);
		const result = await ingestEntry({ libRoot: dir!, candidatePath: candidate, type: "做法", 适用范围: "PAO" });
		expect(result.actions.join("\n")).toContain("已插入「适用范围: PAO」");
		const raw = readFileSync(result.targetPath, "utf8");
		expect(raw.indexOf("适用范围: PAO")).toBeLessThan(raw.indexOf("## 适用边界"));
		expect(parseEntry(raw, "做法/x.md").scope).toEqual(["PAO"]);
	});

	it("值一致则不动（幂等重放不加动作）", async () => {
		const candidate = setupLib(ENTRY);
		await ingestEntry({ libRoot: dir!, candidatePath: candidate, type: "做法", 适用范围: "PAO" });
		const again = await ingestEntry({ libRoot: dir!, candidatePath: candidate, type: "做法", 适用范围: "PAO" });
		expect(again.alreadyPromoted).toBe(true);
		expect(again.actions.join("\n")).not.toContain("适用范围行已落");
	});

	it("值不同则改写原行", async () => {
		const candidate = setupLib(["# 某手法:做法留档 2026-10-02", "", "适用范围: 旧项目", "", "正文。"].join("\n"));
		const result = await ingestEntry({ libRoot: dir!, candidatePath: candidate, type: "做法", 适用范围: "PAO" });
		expect(result.actions.join("\n")).toContain("适用范围: 旧项目 → 适用范围: PAO");
		const raw = readFileSync(result.targetPath, "utf8");
		expect(raw).toContain("适用范围: PAO");
		expect(raw).not.toContain("旧项目");
	});

	it("不传则一字不动", async () => {
		const candidate = setupLib(ENTRY);
		const result = await ingestEntry({ libRoot: dir!, candidatePath: candidate, type: "做法" });
		expect(result.actions.join("\n")).not.toContain("适用范围");
		expect(readFileSync(result.targetPath, "utf8")).not.toContain("适用范围:");
	});
});
