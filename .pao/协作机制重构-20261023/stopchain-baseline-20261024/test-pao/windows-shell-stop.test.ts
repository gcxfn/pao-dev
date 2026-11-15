import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createLocalBashOperations } from "../../src/core/tools/bash.ts";
import { killTree } from "../../src/utils/kill-tree.ts";

it.skipIf(process.platform !== "win32")(
	"实际Git bash工具取消等待Node停止写入，独立进程保持存活",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "pao-shell-stop-"));
		const progress = join(dir, "progress.txt");
		const pidFile = join(dir, "pid.txt");
		const script = join(dir, "work.cjs");
		writeFileSync(
			script,
			`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>fs.appendFileSync(${JSON.stringify(progress)},'x'),30)`,
		);
		const independent = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
			stdio: "ignore",
			windowsHide: true,
		});
		const controller = new AbortController();
		const operation = createLocalBashOperations().exec(`node '${script.replaceAll("\\", "/")}'`, dir, {
			onData: () => {},
			signal: controller.signal,
		});
		const rejected = expect(operation).rejects.toThrow("aborted");
		try {
			const deadline = Date.now() + 10000;
			while (!existsSync(progress)) {
				if (Date.now() > deadline) throw new Error("实际工具未开始写入");
				await new Promise((resolve) => setTimeout(resolve, 30));
			}
			const pid = Number(readFileSync(pidFile, "utf8"));
			controller.abort();
			await rejected;
			expect(() => process.kill(pid, 0)).toThrow();
			const saved = readFileSync(progress, "utf8");
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(readFileSync(progress, "utf8")).toBe(saved);
			expect(() => process.kill(independent.pid!, 0)).not.toThrow();
		} finally {
			controller.abort();
			await operation.catch(() => {});
			if (existsSync(pidFile)) await killTree(Number(readFileSync(pidFile, "utf8")));
			independent.kill();
			rmSync(dir, { recursive: true, force: true });
		}
	},
	30000,
);
