// 离线跨进程派发名额夹具；只使用隔离 stateRoot，不拉起供应商或真实 worker。
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

import { acquireExecutionRootGuard } from "../../src/pao/worker/lock.ts";
import { WorkerRunner } from "../../src/pao/worker/runner.ts";

const [role, stateRoot, identity = "卡/独立进程.md", department = "测试", marker] = process.argv.slice(2);

function waitForInput(): Promise<void> {
	return new Promise((resolve) => process.stdin.once("data", () => resolve()));
}

if (role === "reserve") {
	process.stdout.write(`${JSON.stringify({ ready: process.pid })}\n`);
	await waitForInput();
	try {
		const release = await new WorkerRunner({ dispatchStateRoot: stateRoot }).reserveDispatchSlot({
			身份: identity,
			部门: department,
			部门上限: 10,
			并发上限: 1,
		});
		process.stdout.write(`${JSON.stringify({ reserved: process.pid })}\n`);
		await waitForInput();
		release();
	} catch (error) {
		process.stdout.write(
			`${JSON.stringify({ rejected: process.pid, reason: error instanceof Error ? error.message : String(error) })}\n`,
		);
	}
} else if (role === "parent-with-worker") {
	if (!marker) throw new Error("parent-with-worker 缺少存活标记路径");
	process.stdout.write(`${JSON.stringify({ started: process.pid })}\n`);
	const release = await new WorkerRunner({ dispatchStateRoot: stateRoot }).reserveDispatchSlot({
		身份: identity,
		部门: department,
		部门上限: 10,
		并发上限: 2,
	});
	process.stdout.write(`${JSON.stringify({ reserved: process.pid })}\n`);
	const worker = spawn(
		process.execPath,
		[
			"-e",
			`const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(marker)},"worker\\n"+process.pid);setInterval(()=>{},1000);`,
		],
		{ detached: true, stdio: "ignore", windowsHide: true },
	);
	worker.unref();
	for (let index = 0; index < 100; index++) {
		try {
			if (readMarker(marker).startsWith("worker\n")) break;
		} catch {
			// 等待子进程写完。
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	if (!readMarker(marker).startsWith("worker\n")) throw new Error("owner 自己拉起的 worker 未写出存活标记");
	const workerPid = Number(readMarker(marker).split("\n")[1]);
	if (!Number.isInteger(workerPid) || workerPid <= 0) throw new Error("owner 拉起的 worker pid 无效");
	process.stdout.write(`${JSON.stringify({ parent: process.pid, worker: workerPid })}\n`);
	// 故意不 release；父进程退出后预约仍应占位。
	void release;
	setInterval(() => {}, 1_000);
} else if (role === "hold-guard") {
	const guard = await acquireExecutionRootGuard({
		taskRoot: stateRoot,
		executionRoot: identity,
		holder: "跨进程守卫持有者",
	});
	process.stdout.write(`${JSON.stringify({ guard: process.pid, occupancy: guard.occupancy })}\n`);
	await waitForInput();
	await guard.release();
	process.stdout.write(`${JSON.stringify({ released: process.pid })}\n`);
	process.exit(0);
} else {
	throw new Error(`未知夹具角色: ${role}`);
}

function readMarker(file: string): string {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return "";
	}
}
