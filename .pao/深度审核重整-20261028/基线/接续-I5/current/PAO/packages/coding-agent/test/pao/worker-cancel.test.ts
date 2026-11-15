import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { PaoWorkerError } from "../../src/pao/worker/errors.ts";
import { acquireProjectLock, isProjectLocked, releaseProjectLock } from "../../src/pao/worker/lock.ts";
import { StopProof, WorkerRunner } from "../../src/pao/worker/runner.ts";

const tempDirs: string[] = [];
const scripts: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	scripts.length = 0;
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-worker-cancel-"));
	tempDirs.push(dir);
	return dir;
}

function writeScript(body: string): string {
	const file = join(tempDir(), `fake-${scripts.length}.js`);
	scripts.push(file);
	writeFileSync(file, body, "utf8");
	return file;
}

/** 常驻假 worker:发一条事件后挂住不退 */
const LONG_SCRIPT = `
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "工作中" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, stopReason: "end" } }));
setInterval(() => {}, 1000);
`;

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function waitUntil(fn: () => boolean, timeoutMs = 5000): Promise<boolean> {
	return new Promise((resolve) => {
		const start = Date.now();
		const tick = (): void => {
			if (fn() || Date.now() - start > timeoutMs) resolve(fn());
			else setTimeout(tick, 50);
		};
		tick();
	});
}

describe("取消顺序:①阻止新调用 ②停执行并确认真停 ③才放锁", () => {
	it("取消期间锁未释放;停妥后凭 StopProof 放锁;进程确认真停", async () => {
		const projectRoot = tempDir();
		const lock = await acquireProjectLock({ 项目根: projectRoot, 持有者: "卡0002" });
		expect(await isProjectLocked(projectRoot)).toBe(true);

		const runner = new WorkerRunner();
		const runPromise = runner.run({
			卡号: "0002",
			提示词: "长任务",
			命令: process.execPath,
			参数: [writeScript(LONG_SCRIPT)],
			证据目录: tempDir(),
		});
		// 等子进程真实登记
		await waitUntil(() => runner.isRunning("0002"));
		const pid = runner.registry.list()[0].pid;

		// ① + ②发起:cancel 调用即阻止新调用并开始停进程;此刻锁必须还在
		const proofPromise = runner.cancel("0002");
		expect(await isProjectLocked(projectRoot)).toBe(true);

		// ②确认真停:进程退出(reap)
		const proof = await proofPromise;
		const receipt = await runPromise;
		expect(receipt.status).toBe("canceled");
		expect(alive(pid)).toBe(false);
		expect(proof.stoppedProcesses).toEqual([
			{
				pid,
				卡号: "0002",
				方式: process.platform === "win32" ? expect.stringContaining("taskkill") : expect.any(String),
			},
		]);
		expect(proof).toBeInstanceOf(StopProof);

		// ③放锁:必须出示运行器签发的凭据
		await releaseProjectLock(lock, proof);
		expect(await isProjectLocked(projectRoot)).toBe(false);
		// 放锁后可再次获锁
		const lock2 = await acquireProjectLock({ 项目根: projectRoot, 持有者: "下一轮" });
		await releaseProjectLock(lock2, proof); // 凭据只验类型,锁已归新持有者正常释放
	});

	it("伪造凭据放不了锁:结构上强制先停后放", async () => {
		const projectRoot = tempDir();
		const lock = await acquireProjectLock({ 项目根: projectRoot, 持有者: "卡0003" });
		// 没停过任何进程,拿不出 StopProof:普通对象/undefined 都被拒
		await expect(releaseProjectLock(lock, {} as StopProof)).rejects.toMatchObject({ code: "无效凭据" });
		await expect(releaseProjectLock(lock, undefined as unknown as StopProof)).rejects.toMatchObject({
			code: "无效凭据",
		});
		expect(await isProjectLocked(projectRoot)).toBe(true);
	});

	it("取消后同卡新调用被拒;未运行卡的取消返回空凭据", async () => {
		const runner = new WorkerRunner();
		await expect(runner.cancel("0099")).resolves.toMatchObject({ stoppedProcesses: [] });

		// 预置一个已取消卡
		const runPromise = runner.run({
			卡号: "0005",
			提示词: "任务",
			命令: process.execPath,
			参数: [writeScript(LONG_SCRIPT)],
			证据目录: tempDir(),
		});
		await waitUntil(() => runner.isRunning("0005"));
		await runner.cancel("0005");
		await runPromise;

		await expect(runner.run({ 卡号: "0005", 提示词: "再来", 证据目录: tempDir() })).rejects.toMatchObject({
			code: "已取消",
		} satisfies Partial<PaoWorkerError>);
	});
});

// ── T04 红线:重复取消/退出、启动中取消的证据保留(StopProof 不退化为布尔) ──

describe("T04 红线:重复停止与启动中取消", () => {
	it("重复 cancel/stopAll 不伪造已停记录:已停条目只来自真实停止,重复停止返回空凭据", async () => {
		const projectRoot = tempDir();
		const lock = await acquireProjectLock({ 项目根: projectRoot, 持有者: "卡0006" });
		const runner = new WorkerRunner();
		const runPromise = runner.run({
			卡号: "0006",
			提示词: "长任务",
			命令: process.execPath,
			参数: [writeScript(LONG_SCRIPT)],
			证据目录: tempDir(),
		});
		await waitUntil(() => runner.isRunning("0006"));
		const pid = runner.registry.list()[0].pid;

		const first = await runner.cancel("0006");
		const receipt = await runPromise;
		expect(receipt.status).toBe("canceled");
		// 取消路径也落证据:live/正本证据文件在磁盘上可查
		expect(existsSync(receipt.evidence_path)).toBe(true);
		expect(first.stoppedProcesses).toEqual([{ pid, 卡号: "0006", 方式: expect.stringContaining("taskkill") }]);

		// 重复取消:条目已摘除,返回空凭据——不把首次的已停记录再报一遍(不伪造),也不抛
		await expect(runner.cancel("0006")).resolves.toMatchObject({ stoppedProcesses: [] });
		// stopAll 后再 stopAll:同样空凭据;封锁后同卡新派发拒绝
		await expect(runner.stopAll()).resolves.toMatchObject({ stoppedProcesses: [] });
		await expect(runner.stopAll()).resolves.toMatchObject({ stoppedProcesses: [] });
		await expect(runner.run({ 卡号: "0006", 提示词: "x", 证据目录: tempDir() })).rejects.toMatchObject({
			code: "已取消",
		} satisfies Partial<PaoWorkerError>);
		// 锁没被这次取消偷偷放掉:放锁仍须凭据显式调用
		expect(await isProjectLocked(projectRoot)).toBe(true);
		await releaseProjectLock(lock, first);
		expect(await isProjectLocked(projectRoot)).toBe(false);
	});

	it("启动中取消:signal 已中止时拒绝启动,不留进程不留登记(取消先于 spawn)", async () => {
		const runner = new WorkerRunner();
		const controller = new AbortController();
		controller.abort();
		await expect(
			runner.run({
				卡号: "0007",
				提示词: "x",
				命令: process.execPath,
				参数: [writeScript(LONG_SCRIPT)],
				证据目录: tempDir(),
				信号: controller.signal,
			}),
		).rejects.toMatchObject({ code: "已取消" } satisfies Partial<PaoWorkerError>);
		expect(runner.registry.list()).toHaveLength(0);
		expect(runner.isRunning("0007")).toBe(false);
	});
});
