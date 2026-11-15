/**
 * WorkerRunner.listActive 实时尾巴单测(全景三批·任务 1):
 * - spawn 中 listActive 可见,pid/卡号/命令/执行标识齐全,stdoutTail 切末 N 行(默认 50);
 * - settle(自然退出/取消)后条目从 listActive 消失——生命周期钉死;
 * - 结算/回执路径不受影响(回执照常落盘,取消语义不变)。
 * 造假进程用真小进程(node -e),模式同 worker-run.test.ts。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerRunner } from "../../src/pao/worker/runner.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-worker-listactive-"));
	tempDirs.push(dir);
	return dir;
}

function writeScript(body: string): string {
	const file = join(tempDir(), `fake-${Math.random().toString(36).slice(2)}.js`);
	writeFileSync(file, body, "utf8");
	return file;
}

describe("WorkerRunner.listActive 实时尾巴", () => {
	it("spawn 中可见:pid/卡号/命令/执行标识齐全,尾巴切末 50 行且含最新输出", async () => {
		const runner = new WorkerRunner();
		const evidenceDir = tempDir();
		const script = writeScript(
			["for (let i = 1; i <= 60; i++) console.log('行' + i);", "setTimeout(() => {}, 8000);"].join("\n"),
		);
		const runPromise = runner.run({
			卡号: "0001",
			提示词: "",
			命令: process.execPath,
			参数: [script],
			cwd: evidenceDir,
			证据目录: evidenceDir,
		});
		try {
			let row: ReturnType<WorkerRunner["listActive"]>[number] | undefined;
			for (let i = 0; i < 200; i++) {
				row = runner.listActive().find((entry) => entry.卡号 === "0001");
				if (row?.stdoutTail().includes("行60")) break;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			expect(row).toBeDefined();
			expect(row!.pid).toBeGreaterThan(0);
			expect(row!.卡号).toBe("0001");
			expect(row!.命令).toContain("fake-");
			expect(row!.执行标识).toBeTruthy();
			// 默认尾巴 = 末 50 行,含最后一行「行60」且不含最早的「行1」
			const tail = row!.stdoutTail();
			expect(tail.split("\n")).toHaveLength(50);
			expect(tail).toContain("行60");
			expect(tail).not.toContain("行1\n");
			// 显式行数切片
			const two = row!.stdoutTail(2).split("\n");
			expect(two).toHaveLength(2);
			expect(two[1]).toBe("行60");
		} finally {
			// 结算路径不受影响:取消照常树杀,回执照常返回
			await runner.cancel("0001");
		}
		const receipt = await runPromise;
		expect(receipt.status).toBe("canceled");
		expect(receipt.evidence_path).toBeTruthy();
	});

	it("settle 后消失:listActive 清空,回执正常;快照函数随之返回 undefined(实时页末态依据)", async () => {
		const runner = new WorkerRunner();
		const evidenceDir = tempDir();
		const script = writeScript("console.log('尾行输出');");
		const runPromise = runner.run({
			卡号: "0002",
			提示词: "",
			命令: process.execPath,
			参数: [script],
			cwd: evidenceDir,
			证据目录: evidenceDir,
		});
		// 运行中可查到(允许小轮询等 spawn 完成)
		let seen = false;
		for (let i = 0; i < 200 && !seen; i++) {
			seen = runner.listActive().some((entry) => entry.卡号 === "0002");
			if (!seen) await new Promise((resolve) => setTimeout(resolve, 25));
		}
		const receipt = await runPromise;
		expect(seen).toBe(true);
		expect(receipt.status, JSON.stringify(receipt)).toBe("success");
		expect(runner.listActive()).toHaveLength(0);
		// 全景钻取的快照取口:settle 后取不到条目 → 实时页显示末态并自动收页
		expect(runner.listActive().find((entry) => entry.卡号 === "0002")).toBeUndefined();
	});
});
