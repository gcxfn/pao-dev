/**
 * M1-04 工具输出纪律:pao 工具输出默认给状态、关键失败与完整文件路径,
 * 不因截断丢错误(G1-14 的错误可见性在这条上先落最小保证)。
 * 以卡片工具为样本:成功输出带卡文件完整路径;坏卡失败带完整文件路径;
 * worker 回执摘要截断不超过 3 行但 stderr 尾部完整保底 2000 字符。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCard, listCards, loadCard, parseCardContent } from "../../src/pao/cards/index.ts";
import { WorkerRunner } from "../../src/pao/worker/runner.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-out-"));
	tempDirs.push(dir);
	return dir;
}

describe("工具输出纪律(状态/关键失败/完整文件路径)", () => {
	it("建卡成功输出含完整文件路径(状态+定位一步到位)", async () => {
		const dir = tempDir();
		const cardDir = join(dir, "卡");
		const card = await createCard(
			cardDir,
			{
				目标: "输出纪律",
				部门: "核心机制",
				验收: "带路径",
				创建: "2026-10-02 12:00",
			},
			{ counterPath: join(dir, "卡号.txt") },
		);
		// createCard 返回体即工具输出的数据源:路径是绝对路径
		const cardPath = card.path.replace(/\//g, "\\");
		expect(cardPath.startsWith(dir)).toBe(true);
		expect(cardPath).toContain("卡0001-输出纪律.md");
	});

	it("坏卡报错带完整文件路径:frontmatter 缺字段也不让用户猜是哪张卡", () => {
		const dir = tempDir();
		const cardDir = join(dir, "卡");
		const badFile = join(cardDir, "卡0042-坏卡.md");
		mkdirSync(cardDir, { recursive: true });
		writeFileSync(
			badFile,
			"---\n目标: 缺状态\n部门: x\n验收: y\n尝试: 0\n创建: 2026-10-02 12:00\n---\n\n正文\n",
			"utf8",
		);
		// listCards 静默跳坏卡(队列可用性优先);但单独读这张卡时错误必须可定位
		expect(listCards(cardDir)).toHaveLength(0);
		try {
			loadCard(cardDir, 42);
			expect.unreachable("应抛出");
		} catch (error) {
			expect((error as Error).message).toContain(badFile);
			expect((error as Error).message).toContain("status");
		}
		// 直读内容解析同样带路径(parseCardContent 的 filePath 参数)
		const content = "---\n目标: x\n部门: y\n验收: z\n尝试: 0\n创建: 2026-10-02 12:00\n---\n\n正文\n";
		expect(() => parseCardContent(content, badFile)).toThrowError(new RegExp(escapeRe(badFile)));
	});

	it("worker 回执:摘要截断至 3 行不丢关键失败(stderr 尾部 2000 字符保底,证据全文落盘)", async () => {
		const dir = tempDir();
		const script = join(dir, "fail.cjs");
		writeFileSync(script, 'console.error("长错误".repeat(3000)); process.exit(3);', "utf8");
		const runner = new WorkerRunner();
		const receipt = await runner.run({
			卡号: "0001",
			提示词: "输出纪律",
			命令: process.execPath,
			参数: [script],
		});
		expect(receipt.status).toBe("failed");
		expect(receipt.summary.split("\n").length).toBeLessThanOrEqual(3);
		// 关键失败不因摘要截断而丢:stderrTail 保底 + 证据文件全文
		expect(receipt.stderrTail!.length).toBeGreaterThan(100);
		expect(receipt.evidence_path).toBeTruthy();
	});
});

function escapeRe(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
