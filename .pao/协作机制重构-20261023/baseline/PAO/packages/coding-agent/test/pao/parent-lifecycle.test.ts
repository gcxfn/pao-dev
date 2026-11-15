import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { killTree } from "../../src/utils/kill-tree.ts";

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

it.skipIf(process.platform !== "win32")(
	"受管进程安装生命周期后挂 SIGHUP(控制台关闭自停)与 disconnect(父亡自停)监听",
	async () => {
		const probe = spawn(
			process.execPath,
			[fileURLToPath(new URL("./parent-lifecycle-child.ts", import.meta.url)), "probe"],
			{
				stdio: ["ignore", "pipe", "pipe", "ipc"],
				env: { ...process.env, PAO_MANAGED_PARENT: "1" },
			},
		);
		try {
			const line = await new Promise<string>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("probe 启动超时")), 10_000);
				probe.stdout?.on("data", (data: Buffer) => {
					clearTimeout(timer);
					resolve(data.toString().split("\n")[0]);
				});
				probe.once("error", (error) => {
					clearTimeout(timer);
					reject(error);
				});
			});
			// SIGHUP 监听给控制台关闭留出宽限窗口(不装则 JS 被默认处理直接终止,树杀来不及跑);
			// disconnect 监听覆盖父亡路径;delivery 由活任务验证(关终端场)把关
			expect(JSON.parse(line)).toEqual({ sighup: 1, disconnect: 1 });
		} finally {
			probe.kill();
		}
	},
	15_000,
);

it.skipIf(process.platform !== "win32")(
	"真实 Windows 父进程强杀后受管孩子与孙进程停止写入",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "pao-parent-lifecycle-"));
		const marker = join(dir, "heartbeat.txt");
		const supervisor = spawn(
			process.execPath,
			[fileURLToPath(new URL("./parent-lifecycle-child.ts", import.meta.url)), "supervisor", marker],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		let identities: { worker: number; writer: number } | undefined;
		try {
			identities = await new Promise<{ worker: number; writer: number }>((resolve, reject) => {
				let buffer = "";
				const timer = setTimeout(() => reject(new Error("进程夹具启动超时")), 10000);
				supervisor.once("error", (error) => {
					clearTimeout(timer);
					reject(error);
				});
				supervisor.stdout?.on("data", (data: Buffer) => {
					buffer += data.toString();
					if (buffer.includes("\n")) {
						clearTimeout(timer);
						resolve(JSON.parse(buffer.split("\n")[0]));
					}
				});
			});
			const readyDeadline = Date.now() + 5000;
			while (!existsSync(marker) && Date.now() < readyDeadline) await delay(50);
			expect(existsSync(marker)).toBe(true);
			// 只杀父进程，不能用 /T 替受测父亡机制杀掉后代。
			supervisor.kill();
			const deadline = Date.now() + 8000;
			while ((alive(identities.worker) || alive(identities.writer)) && Date.now() < deadline) await delay(100);
			expect(alive(identities.worker)).toBe(false);
			expect(alive(identities.writer)).toBe(false);
			const stopped = readFileSync(marker, "utf8");
			await delay(250);
			expect(readFileSync(marker, "utf8")).toBe(stopped);
		} finally {
			for (const pid of [identities?.writer, identities?.worker, supervisor.pid])
				if (pid && alive(pid)) await killTree(pid);
			rmSync(dir, { recursive: true, force: true });
		}
	},
	25000,
);
