import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { WorkerRunner } from "../../src/pao/worker/runner.ts";

/**
 * M1-06 异常核(worker 运行层):
 * - 内部请求次数与尝试次数分开记录,重试不倍增(G1-05);
 * - 长错误输出:摘要截断但原日志在证据文件可展开,不截断丢错(G1-14);
 * - 中文与空格路径:worker 拉起/证据落盘照常(G1-14)。
 */

const tempDirs: string[] = [];
const scripts: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	scripts.length = 0;
});

function tempDir(prefix = "pao-exc-run-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function writeScript(body: string, prefix = "pao-exc-run-"): string {
	const file = join(tempDir(prefix), `fake-${scripts.length}.js`);
	scripts.push(file);
	writeFileSync(file, body, "utf8");
	return file;
}

/** 发 N 条 message_end(= N 次接口请求返回)后正常退出 */
function turnsScript(n: number): string {
	const lines: string[] = [];
	for (let i = 1; i <= n; i++) {
		lines.push(
			`console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "第${i}轮" }], usage: { input: ${i}, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01 }, stopReason: "end" } }));`,
		);
	}
	return lines.join("\n");
}

describe("内部请求次数与尝试次数分开记录(G1-05 重试不倍增)", () => {
	it("一次尝试内的接口请求次数 = turns,逐轮从事件流取;尝试号仍是 1", async () => {
		const runner = new WorkerRunner();
		const receipt = await runner.run({
			卡号: "0001",
			提示词: "多轮任务",
			命令: process.execPath,
			参数: [writeScript(turnsScript(4))],
			证据目录: tempDir(),
		});
		expect(receipt.status).toBe("success");
		expect(receipt.attempt).toBe(1);
		// 4 次接口请求各计一次,不倍增
		expect(receipt.usage.turns).toBe(4);
		expect(receipt.usage.input).toBe(1 + 2 + 3 + 4);
		expect(receipt.usage.cost).toBeCloseTo(0.04, 6);
	});

	it("重试一轮:尝试 +1,但每轮尝试各自的请求次数不互相倍增", async () => {
		const runner = new WorkerRunner();
		const opts = { 命令: process.execPath as string, 证据目录: tempDir() };
		const first = await runner.run({ ...opts, 卡号: "0002", 提示词: "第一次", 参数: [writeScript(turnsScript(3))] });
		const second = await runner.run({ ...opts, 卡号: "0002", 提示词: "重试", 参数: [writeScript(turnsScript(2))] });
		expect(first.attempt).toBe(1);
		expect(first.usage.turns).toBe(3);
		expect(second.attempt).toBe(2);
		expect(second.usage.turns).toBe(2); // 重试只记本轮请求,不把上轮翻倍
		// 调度层统一计数:尝试表可读,供重试上限门禁用
		expect(runner.attemptCount("0002")).toBe(2);
	});

	it("运行器零重试路径:子进程内部失败一次就是一次,请求次数不翻倍", async () => {
		const runner = new WorkerRunner();
		const receipt = await runner.run({
			卡号: "0003",
			提示词: "任务",
			命令: process.execPath,
			参数: [writeScript('console.error("boom");process.exit(1);')],
			证据目录: tempDir(),
		});
		expect(receipt.status).toBe("failed");
		expect(receipt.attempt).toBe(1);
		expect(receipt.usage.turns).toBe(0); // 没有任何接口请求成功返回
	});
});

describe("长错误输出:摘要截断,原日志可展开,不丢错(G1-14)", () => {
	it("百行 stderr:回执摘要 ≤3 行,stderrTail 有界,事件流证据完整保留 stdout 错误", async () => {
		const errLines: string[] = [];
		for (let i = 1; i <= 100; i++) errLines.push(`ERROR line ${i}: 详细堆栈信息xxxxx`);
		const script = writeScript(`console.error(${JSON.stringify(errLines.join("\n"))});\nprocess.exit(1);`);
		const runner = new WorkerRunner();
		const receipt = await runner.run({
			卡号: "0004",
			提示词: "任务",
			命令: process.execPath,
			参数: [script],
			证据目录: tempDir(),
		});
		expect(receipt.status).toBe("failed");
		// 摘要有界,但错误原因可见(不是被吞成空)
		expect(receipt.summary.split("\n").length).toBeLessThanOrEqual(3);
		expect(receipt.summary).toContain("ERROR");
		// stderrTail 有界且保留尾部(最新错误)
		expect(receipt.stderrTail!.length).toBeLessThanOrEqual(2000);
		expect(receipt.stderrTail).toContain("ERROR line 100");
		// 原日志可展开:证据 JSONL 落盘,含 stderr 尾部证据行
		expect(existsSync(receipt.evidence_path)).toBe(true);
		const evidence = readFileSync(receipt.evidence_path, "utf8");
		expect(evidence).toContain("pao_worker_evidence");
		expect(evidence).toContain("ERROR line 100");
	});

	it("错误走事件流(message_end errorMessage)时:摘要带错误,证据文件保留原始行", async () => {
		const script = writeScript(
			'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "端点 502:upstream connect error,重试 3 次均失败,错误详情' +
				"很".repeat(400) +
				'" }], usage: { input: 1, output: 1, cost: 0 }, stopReason: "error", errorMessage: "端点 502" } }));',
		);
		const runner = new WorkerRunner();
		const receipt = await runner.run({
			卡号: "0005",
			提示词: "任务",
			命令: process.execPath,
			参数: [script],
			证据目录: tempDir(),
		});
		expect(receipt.status).toBe("failed");
		expect(receipt.stopReason).toBe("error");
		// 超长单行被截到 200 字符加省略号——但完整原文在证据 JSONL 里可展开
		expect(receipt.summary.length).toBeLessThanOrEqual(3 * 201 + 2);
		const evidence = readFileSync(receipt.evidence_path, "utf8");
		expect(evidence).toContain("很很很"); // 原始长行保留,未被摘要截断丢弃
	});
});

describe("中文与空格路径:worker 拉起与证据落盘照常(G1-14)", () => {
	it("cwd 与证据目录都含中文和空格:运行成功,证据落盘路径正确", async () => {
		const workDir = tempDir("pao-exc-中文 空格-");
		const script = writeScript(turnsScript(1), "pao-exc-中文 空格-");
		const runner = new WorkerRunner();
		const receipt = await runner.run({
			卡号: "0006",
			提示词: "中文路径任务",
			命令: process.execPath,
			参数: [script],
			证据目录: join(workDir, "证据 目录"),
			cwd: workDir,
		});
		expect(receipt.status).toBe("success");
		expect(receipt.usage.turns).toBe(1);
		expect(existsSync(receipt.evidence_path)).toBe(true);
		expect(receipt.evidence_path).toContain("证据 目录");
	});
});
