import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { waitForFile } from "../../src/pao/worker/inventory.ts";
import { WorkerRunner } from "../../src/pao/worker/runner.ts";
import { killTree } from "../../src/utils/kill-tree.ts";

const tempDirs: string[] = [];
const scripts: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	scripts.length = 0;
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-worker-tree-"));
	tempDirs.push(dir);
	return dir;
}

function writeScript(body: string): string {
	const file = join(tempDir(), `fake-${scripts.length}.js`);
	scripts.push(file);
	writeFileSync(file, body, "utf8");
	return file;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function waitUntil(fn: () => boolean, timeoutMs = 10000): Promise<boolean> {
	return new Promise((resolve) => {
		const start = Date.now();
		const tick = (): void => {
			if (fn() || Date.now() - start > timeoutMs) resolve(fn());
			else setTimeout(tick, 100);
		};
		tick();
	});
}

/** 假 worker:再派一个孙进程(挂住不退),把孙进程 pid 写到指定文件 */
const GRANDCHILD_SCRIPT = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const gc = spawn(process.execPath, ["-e", "setInterval(()=>{},500)"], { stdio: "ignore" });
fs.writeFileSync(process.argv[2], String(gc.pid));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "工作中" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, stopReason: "end" } }));
setInterval(() => {}, 1000);
`;

describe("Windows 停树:taskkill /T /F 连孙进程一起停;只杀登记在案的进程", () => {
	it("stopAll 树杀 worker 及其孙进程;未登记的同名控制进程不受影响", async () => {
		// 控制进程:同样是 node 挂住进程,但不经运行器拉起、不登记——不应被误杀
		const control = spawn(process.execPath, ["-e", "setInterval(()=>{},500)"], { stdio: "ignore" });
		const controlPid = control.pid!;

		const runner = new WorkerRunner();
		const dir = tempDir();
		const gcPidFile = join(dir, "gc.pid");
		const runPromise = runner.run({
			卡号: "0010",
			提示词: "长任务",
			命令: process.execPath,
			参数: [writeScript(GRANDCHILD_SCRIPT), gcPidFile],
			证据目录: dir,
		});
		expect(await waitForFile(gcPidFile)).toBe(true);
		await waitUntil(() => runner.isRunning("0010"));
		const childPid = runner.registry.list()[0].pid;
		const gcPid = Number.parseInt(readGcPid(gcPidFile), 10);

		expect(alive(childPid)).toBe(true);
		expect(alive(gcPid)).toBe(true);

		const proof = await runner.stopAll();
		await runPromise;

		// 主进程与孙进程都真停了(孙进程不在登记表里,靠树杀)
		expect(await waitUntil(() => !alive(childPid) && !alive(gcPid))).toBe(true);
		// 只处理登记在案的进程:控制进程活着
		expect(alive(controlPid)).toBe(true);
		// 登记表只有 worker 自己
		expect(runner.registry.list().length).toBe(1);
		// 凭据记录停止方式与进程
		expect(proof.stoppedProcesses.length).toBe(1);
		expect(proof.stoppedProcesses[0].pid).toBe(childPid);
		if (process.platform === "win32") {
			expect(proof.stoppedProcesses[0].方式).toContain("taskkill");
			expect(proof.stoppedProcesses[0].方式).toContain("/T");
			expect(proof.stoppedProcesses[0].方式).toContain("/F");
		}

		// 清理控制进程
		await killTree(controlPid);
	});

	it("killTree 对已退出进程静默成功", async () => {
		const shortLived = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
		await new Promise<void>((resolve) => shortLived.on("close", () => resolve()));
		await expect(killTree(shortLived.pid!)).resolves.toContain(String(shortLived.pid));
	});
});

function readGcPid(file: string): string {
	return readFileSync(file, "utf8").trim();
}
