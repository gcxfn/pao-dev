/** 真子进程、模拟 pi 事件；验证压缩前后的完整记录，不调用真实模型。 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { readWorkerEvidenceFile } from "../../src/pao/shared/evidence.ts";
import { PaoWorkerError } from "../../src/pao/worker/errors.ts";
import { validateReceipt } from "../../src/pao/worker/receipt.ts";
import { WorkerRunner } from "../../src/pao/worker/runner.ts";
import { killTree } from "../../src/utils/kill-tree.ts";

const directories: string[] = [];
afterEach(() => {
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const update = {
	type: "message_update",
	usage: { input: 5, output: 10, cost: 0.5 },
	assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "完整片段🙂" },
};
const finalEvent = {
	type: "message_end",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "模拟完成" }],
		usage: { input: 5, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } },
		stopReason: "end",
	},
};
const stdoutBody = `${JSON.stringify(update)}\n`.repeat(4000) + `${JSON.stringify(finalEvent)}\n`;
const stderrBody = "诊断🙂\r\n".repeat(30000) + "STDERR_DONE\n";

function fixture(exitCode = 0) {
	const root = join(tmpdir(), "pao-evidence-archive");
	mkdirSync(root, { recursive: true });
	const dir = mkdtempSync(join(root, "run-"));
	directories.push(dir);
	const gate = join(dir, "finish");
	const script = join(dir, "worker.cjs");
	writeFileSync(
		script,
		`const fs=require('node:fs');
process.stdout.write(${JSON.stringify(stdoutBody)});
process.stderr.write(${JSON.stringify(stderrBody)});
const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(timer);process.exitCode=${exitCode};}},20);
`,
	);
	return {
		dir,
		gate,
		options: { 卡号: "0077", 提示词: "模拟事件", 命令: process.execPath, 参数: [script], cwd: dir, 证据目录: dir },
	};
}

async function waitForCompleteLive(dir: string) {
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		const names = readdirSync(dir);
		const out = names.find((name) => name.endsWith(".live.jsonl"));
		const err = names.find((name) => name.endsWith(".live.stderr.log"));
		if (out && err) {
			const stdoutPath = join(dir, out),
				stderrPath = join(dir, err);
			const stdout = readFileSync(stdoutPath),
				stderr = readFileSync(stderrPath);
			if (stdout.toString().includes("模拟完成") && stderr.toString().endsWith("STDERR_DONE\n"))
				return { stdoutPath, stderrPath, stdout, stderr };
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("模拟子进程未写出完整的待压缩记录");
}

describe("运行器结算后的完整证据归档", () => {
	for (const exitCode of [0, 7]) {
		it(`退出码 ${exitCode}：运行中原文可读，结束后 gzip 与原始字节一致、用量不变`, async () => {
			const f = fixture(exitCode),
				runner = new WorkerRunner();
			const pending = runner.run(f.options);
			try {
				const live = await waitForCompleteLive(f.dir);
				expect(existsSync(`${live.stdoutPath}.gz`)).toBe(false);
				writeFileSync(f.gate, "结束");
				const receipt = await pending;
				expect(receipt.status).toBe(exitCode === 0 ? "success" : "failed");
				expect(receipt.evidence_path).toBe(`${live.stdoutPath}.gz`);
				expect(receipt.live_evidence_path).toBe(receipt.evidence_path);
				expect(receipt.live_stderr_path).toBe(`${live.stderrPath}.gz`);
				expect(existsSync(live.stdoutPath)).toBe(false);
				const restored = await readWorkerEvidenceFile(receipt.evidence_path);
				expect(restored.subarray(0, live.stdout.length).equals(live.stdout)).toBe(true);
				const lines = restored.toString("utf8").trimEnd().split("\n");
				expect(lines.slice(1, -1).join("\n") + "\n").toBe(stdoutBody);
				expect(JSON.parse(lines.at(-1)!).type).toBe("pao_worker_evidence");
				expect((await readWorkerEvidenceFile(live.stdoutPath)).equals(restored)).toBe(true);
				expect((await readWorkerEvidenceFile(live.stderrPath)).equals(live.stderr)).toBe(true);
				expect(statSync(receipt.evidence_path).size).toBeLessThan(restored.length / 10);
				expect(receipt.usage).toMatchObject({ input: 5, output: 10, cost: 0.5, turns: 1 });
				expect(validateReceipt(receipt).有效).toBe(true);
			} finally {
				await runner.stopAll();
				await pending;
			}
		});
	}

	it("取消并确认真停后仍保留完整归档，取消结果不变", async () => {
		const f = fixture(),
			runner = new WorkerRunner();
		const pending = runner.run(f.options);
		try {
			const live = await waitForCompleteLive(f.dir);
			await runner.cancel(f.options.卡号);
			const receipt = await pending;
			expect(receipt.status).toBe("canceled");
			expect(receipt.evidence_path).toBe(`${live.stdoutPath}.gz`);
			expect(
				(await readWorkerEvidenceFile(receipt.evidence_path)).subarray(0, live.stdout.length).equals(live.stdout),
			).toBe(true);
			expect(receipt.usage.cost).toBe(0.5);
		} finally {
			await runner.stopAll();
			await pending;
		}
	});

	it("压缩目标冲突时保留原文与旧目标，告警可见但任务结果和费用不变", async () => {
		const f = fixture(),
			runner = new WorkerRunner();
		const pending = runner.run(f.options);
		try {
			const live = await waitForCompleteLive(f.dir);
			const previousArchive = gzipSync("由测试创建的既有目标，不能覆盖");
			writeFileSync(`${live.stdoutPath}.gz`, previousArchive);
			writeFileSync(f.gate, "结束");
			const receipt = await pending;
			expect(receipt.status).toBe("success");
			expect(receipt.evidence_path).toBe(live.stdoutPath);
			expect(existsSync(live.stdoutPath)).toBe(true);
			expect(readFileSync(`${live.stdoutPath}.gz`).equals(previousArchive)).toBe(true);
			expect(receipt.派发告警?.join("\n")).toContain("原文保留");
			expect(receipt.usage.cost).toBe(0.5);
		} finally {
			await runner.stopAll();
			await pending;
		}
	});

	it("停止失败的子进程仍存活时不压缩或移除原始现场", async () => {
		const f = fixture();
		const controller = new AbortController();
		let failOnce = true;
		const runner = new WorkerRunner({
			树杀: async (pid, ...args) => {
				if (failOnce) {
					failOnce = false;
					throw new PaoWorkerError("停止失败", "模拟停止未确认");
				}
				return killTree(pid, ...args);
			},
		});
		const pending = runner.run({ ...f.options, 信号: controller.signal });
		try {
			const live = await waitForCompleteLive(f.dir);
			controller.abort();
			const receipt = await pending;
			expect(receipt.evidence_path).toBe(live.stdoutPath);
			expect(existsSync(live.stdoutPath)).toBe(true);
			expect(existsSync(`${live.stdoutPath}.gz`)).toBe(false);
			expect(runner.isRunning(f.options.卡号)).toBe(true);
			expect(receipt.summary).toContain("停止确认失败");
		} finally {
			await runner.stopAll();
			await pending;
		}
	});
});
