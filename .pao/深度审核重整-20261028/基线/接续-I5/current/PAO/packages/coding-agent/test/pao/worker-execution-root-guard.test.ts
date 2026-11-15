import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

import { acquireExecutionRootGuard } from "../../src/pao/worker/lock.ts";

// 离线跨进程 guard 夹具；只使用隔离临时目录，不启动供应商或真实 worker。
const child = fileURLToPath(new URL("./worker-slot-reservation-child.ts", import.meta.url));
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		try {
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		} catch {
			// Windows 句柄释放延迟时保留目录，交由测试临时根清理。
		}
	}
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pao-execution-root-guard-"));
	roots.push(root);
	return root;
}

function createLineReader(processHandle: ReturnType<typeof spawn>): () => Promise<Record<string, unknown>> {
	let buffer = "";
	let pendingResolve: ((value: Record<string, unknown>) => void) | undefined;
	let pendingReject: ((error: Error) => void) | undefined;
	const settle = (): void => {
		if (!pendingResolve) return;
		const newline = buffer.indexOf("\n");
		if (newline < 0) return;
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		const resolve = pendingResolve;
		pendingResolve = undefined;
		pendingReject = undefined;
		resolve(JSON.parse(line) as Record<string, unknown>);
	};
	const onData = (chunk: Buffer): void => {
		buffer += chunk.toString();
		settle();
	};
	const onError = (error: Error): void => {
		pendingReject?.(error);
	};
	processHandle.stdout?.on("data", onData);
	processHandle.once("error", onError);
	return () =>
		new Promise((resolve, reject) => {
			pendingResolve = resolve;
			pendingReject = reject;
			settle();
		});
}

describe("任务根侧执行目录跨进程守卫", () => {
	test("首实例持有时第二实例立即失败，释放后可取得", async () => {
		const root = tempRoot();
		const taskRoot = join(root, "task");
		const executionRoot = join(root, "execution");
		mkdirSync(taskRoot, { recursive: true });
		mkdirSync(executionRoot, { recursive: true });
		const holder = spawn(
			process.execPath,
			["--experimental-strip-types", child, "hold-guard", taskRoot, executionRoot],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);
		const readLine = createLineReader(holder);
		try {
			const started = await readLine();
			expect(started).toMatchObject({ guard: expect.any(Number), occupancy: "idle" });
			await expect(acquireExecutionRootGuard({ taskRoot, executionRoot, holder: "第二实例" })).rejects.toThrow(
				"执行根已有清理或占用守卫",
			);
			holder.stdin?.write("release\n");
			await readLine();
			await new Promise<void>((resolve, reject) => {
				holder.once("close", () => resolve());
				holder.once("error", reject);
			});
			const guard = await acquireExecutionRootGuard({
				taskRoot,
				executionRoot,
				holder: "释放后重试",
			});
			expect(guard.occupancy).toBe("idle");
			await guard.release();
		} finally {
			holder.kill();
		}
	}, 15_000);
});
