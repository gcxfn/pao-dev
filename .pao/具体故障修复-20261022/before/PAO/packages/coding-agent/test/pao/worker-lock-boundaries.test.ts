import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const control = vi.hoisted(() => ({
	abortBeforeResolve: undefined as AbortController | undefined,
	failLogWrites: false,
	failReservationRemoval: false,
	lockCalls: 0,
	releaseCalls: 0,
	releaseError: undefined as Error | undefined,
}));

vi.mock("proper-lockfile", async (importOriginal) => {
	const actual = await importOriginal<typeof import("proper-lockfile")>();
	const moduleExports = actual as unknown as { default?: typeof actual } & typeof actual;
	const lock = vi.fn(async () => {
		control.lockCalls++;
		const abort = control.abortBeforeResolve;
		control.abortBeforeResolve = undefined;
		abort?.abort();
		return async () => {
			control.releaseCalls++;
			if (control.releaseError) throw control.releaseError;
		};
	});
	const mocked = {
		...moduleExports.default,
		lock,
	};
	return {
		...actual,
		lock,
		default: mocked,
	} as unknown as typeof actual;
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		appendFileSync: vi.fn(
			(file: Parameters<typeof actual.appendFileSync>[0], ...args: unknown[]) => {
				if (!control.failLogWrites || !String(file).endsWith("派发日志.jsonl"))
					return (actual.appendFileSync as (...parameters: unknown[]) => unknown)(file, ...args);
				const error = new Error("fixture: audit log permission denied") as NodeJS.ErrnoException;
				error.code = "EACCES";
				throw error;
			},
		),
	};
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		rm: vi.fn(async (file: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) => {
			if (control.failReservationRemoval && String(file).endsWith("执行占位.json")) {
				const error = new Error("fixture: reservation removal failed") as NodeJS.ErrnoException;
				error.code = "EACCES";
				throw error;
			}
			return actual.rm(file, options);
		}),
	};
});

vi.mock("../../src/pao/shared/log.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/pao/shared/log.ts")>();
	return {
		...actual,
		logWarn: vi.fn(),
	};
});

import { logWarn } from "../../src/pao/shared/log.ts";
import {
	acquireExecutionLock,
	acquireExecutionRootGuard,
	detectExecutionOccupancy,
	dispatchLockLogPath,
	isExecutionLocked,
	listReleasedExecutionArtifacts,
	prepareExecutionRootForRemoval,
	releaseDispatchLock,
} from "../../src/pao/worker/lock.ts";
import { WorkerRunner } from "../../src/pao/worker/runner.ts";

const tempDirs: string[] = [];
const childPids: number[] = [];
const reservationChild = fileURLToPath(new URL("./worker-slot-reservation-child.ts", import.meta.url));

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pao-lock-boundary-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

beforeEach(() => {
	control.abortBeforeResolve = undefined;
	control.failLogWrites = false;
	control.failReservationRemoval = false;
	control.lockCalls = 0;
	control.releaseCalls = 0;
	control.releaseError = undefined;
	vi.mocked(logWarn).mockClear();
});

afterEach(() => {
	for (const pid of childPids.splice(0)) {
		try {
			process.kill(pid);
		} catch {
			// 子进程可能已自行退出。
		}
	}
	for (const dir of tempDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		} catch {
			// Windows 文件句柄释放可能延迟，残留交给系统临时目录清理。
		}
	}
});

function nextJsonLine(
	child: ReturnType<typeof spawn>,
	predicate: (value: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		let buffered = "";
		const onData = (chunk: Buffer): void => {
			buffered += chunk.toString();
			for (;;) {
				const newline = buffered.indexOf("\n");
				if (newline < 0) return;
				const line = buffered.slice(0, newline);
				buffered = buffered.slice(newline + 1);
				if (!line) continue;
				const value = JSON.parse(line) as Record<string, unknown>;
				if (!predicate(value)) continue;
				cleanup();
				resolve(value);
				return;
			}
		};
		const cleanup = (): void => {
			child.stdout?.off("data", onData);
			child.off("error", onError);
		};
		const onError = (error: Error): void => {
			cleanup();
			reject(error);
		};
		child.stdout?.on("data", onData);
		child.once("error", onError);
	});
}

function slotChild(stateRoot: string, identity: string): ReturnType<typeof spawn> {
	return spawn(process.execPath, ["--experimental-strip-types", reservationChild, "reserve", stateRoot, identity], {
		stdio: ["pipe", "pipe", "pipe"],
	});
}

function startGuardChild(taskRoot: string, executionRoot: string): ReturnType<typeof spawn> {
	return spawn(
		process.execPath,
		["--experimental-strip-types", reservationChild, "hold-guard", taskRoot, executionRoot],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);
}

describe("跨进程共享派发名额", () => {
	test("两个独立进程同时预约 cap=1，只允许一个成功", async () => {
		const stateRoot = tempDir("slots");
		const first = slotChild(stateRoot, "卡/并发甲.md");
		const second = slotChild(stateRoot, "卡/并发乙.md");
		try {
			await Promise.all([
				nextJsonLine(first, (value) => value.ready !== undefined),
				nextJsonLine(second, (value) => value.ready !== undefined),
			]);
			const firstResult = nextJsonLine(
				first,
				(value) => value.reserved !== undefined || value.rejected !== undefined,
			);
			const secondResult = nextJsonLine(
				second,
				(value) => value.reserved !== undefined || value.rejected !== undefined,
			);
			first.stdin?.write("start\n");
			second.stdin?.write("start\n");
			const results = await Promise.all([firstResult, secondResult]);
			expect(results.filter((value) => value.reserved !== undefined)).toHaveLength(1);
			expect(results.filter((value) => value.rejected !== undefined)).toHaveLength(1);
			const winnerIndex = results.findIndex((value) => value.reserved !== undefined);
			const winner = winnerIndex === 0 ? first : second;
			childPids.push(Number(results[winnerIndex]?.reserved));
			winner.stdin?.write("release\n");
		} finally {
			first.kill();
			second.kill();
		}
	});

	test("损坏的半写预约按未知占位拒绝新预约，不自动清零", async () => {
		const stateRoot = tempDir("bad-slot");
		const slots = join(stateRoot, "派发名额");
		mkdirSync(slots, { recursive: true });
		const broken = join(slots, "半写.json");
		writeFileSync(broken, '{"type":"pao_dispatch_slot","身份":', "utf8");

		await expect(
			new WorkerRunner({ dispatchStateRoot: stateRoot }).reserveDispatchSlot({
				身份: "卡/坏记录之后.md",
				部门: "测试",
				部门上限: 10,
				并发上限: 1,
			}),
		).rejects.toThrow("存在 1 个未知占位");
		expect(existsSync(broken)).toBe(true);
	});

	test("未知占位无法证明部门未满：总上限大于 1、具体部门上限为 1 时仍拒绝派发", async () => {
		const stateRoot = tempDir("unknown-department");
		const slots = join(stateRoot, "派发名额");
		mkdirSync(slots, { recursive: true });
		const broken = join(slots, "未知部门.json");
		writeFileSync(broken, '{"type":"pao_dispatch_slot","身份":', "utf8");

		await expect(
			new WorkerRunner({ dispatchStateRoot: stateRoot }).reserveDispatchSlot({
				身份: "卡/新任务.md",
				部门: "测试",
				部门上限: 1,
				并发上限: 2,
			}),
		).rejects.toThrow("存在 1 个未知占位");
		expect(existsSync(broken)).toBe(true);
		expect(readdirSync(slots).filter((name) => name.endsWith(".json"))).toEqual(["未知部门.json"]);
	});

	test("同一卡在不同进程重复预约被拒绝，且不写第二条持久预约", async () => {
		const stateRoot = tempDir("same-card-processes");
		const identity = "卡/同卡跨进程.md";
		const first = slotChild(stateRoot, identity);
		const second = slotChild(stateRoot, identity);
		try {
			await Promise.all([
				nextJsonLine(first, (value) => value.ready !== undefined),
				nextJsonLine(second, (value) => value.ready !== undefined),
			]);
			const firstResult = nextJsonLine(
				first,
				(value) => value.reserved !== undefined || value.rejected !== undefined,
			);
			first.stdin?.write("start\n");
			const reserved = await firstResult;
			expect(reserved.reserved).toBeTypeOf("number");
			childPids.push(Number(reserved.reserved));

			const secondResult = nextJsonLine(
				second,
				(value) => value.reserved !== undefined || value.rejected !== undefined,
			);
			second.stdin?.write("start\n");
			const rejected = await secondResult;
			expect(rejected.rejected).toBeTypeOf("number");
			expect(rejected.reason).toContain("该卡已经占用派发名额");

			const slots = join(stateRoot, "派发名额");
			expect(readdirSync(slots).filter((name) => name.endsWith(".json"))).toHaveLength(1);
			first.stdin?.write("release\n");
		} finally {
			first.kill();
			second.kill();
		}
	}, 15_000);

	test("owner 亲自拉起 worker 后退出：worker 仍活时预约继续占位，不按 owner pid 自动删除", async () => {
		const stateRoot = tempDir("dead-owner");
		const marker = join(stateRoot, "worker-live.txt");
		const parent = spawn(
			process.execPath,
			["--experimental-strip-types", reservationChild, "parent-with-worker", stateRoot, "卡/父进程.md", "测试", marker],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);
		await nextJsonLine(parent, (value) => value.started !== undefined);
		await nextJsonLine(parent, (value) => value.reserved !== undefined);
		const identity = await nextJsonLine(parent, (value) => value.parent !== undefined);
		const parentPid = Number(identity.parent);
		const workerPid = Number(identity.worker);
		childPids.push(workerPid);
		parent.kill();
		await new Promise<void>((resolve) => parent.once("close", () => resolve()));
		expect(() => process.kill(parentPid, 0)).toThrow();
		expect(() => process.kill(workerPid, 0)).not.toThrow();
		const slots = join(stateRoot, "派发名额");
		const reservationFiles = (await import("node:fs/promises")).readdir(slots).then((names) =>
			names.filter((name) => name.endsWith(".json")),
		);
		await expect(reservationFiles).resolves.toHaveLength(1);

		await expect(
			new WorkerRunner({ dispatchStateRoot: stateRoot }).reserveDispatchSlot({
				身份: "卡/重开之后.md",
				部门: "测试",
				部门上限: 10,
				并发上限: 1,
			}),
		).rejects.toThrow("共享并发名额已达上限 1");
	}, 15_000);
});

describe("执行锁故障边界", () => {
	test("租约取得后 signal 取消：先回滚已获租约，再清理本次占位，随后可重新获取", async () => {
		const root = tempDir("abort");
		const controller = new AbortController();
		control.abortBeforeResolve = controller;

		await expect(acquireExecutionLock({ root, holder: "取消边界", signal: controller.signal })).rejects.toMatchObject({
			name: "AbortError",
		});

		expect(control.lockCalls).toBe(1);
		expect(control.releaseCalls).toBe(1);
		expect(existsSync(join(root, ".pao", "执行占位.json"))).toBe(false);

		const retry = await acquireExecutionLock({ root, holder: "取消后重试" });
		await expect(isExecutionLocked(root)).resolves.toBe(true);
		const proof = new WorkerRunner().confirmStopped("取消后重试");
		await releaseDispatchLock(retry, proof);
		expect(control.releaseCalls).toBe(2);
		await expect(isExecutionLocked(root)).resolves.toBe(false);
	});

	test("租约已释放而占位删除失败：重试只补删占位，不重复释放租约", async () => {
		const root = tempDir("staged-release");
		const lock = await acquireExecutionLock({ root, holder: "分阶段释放" });
		const proof = new WorkerRunner().confirmStopped("分阶段释放");
		control.failReservationRemoval = true;

		await expect(releaseDispatchLock(lock, proof)).rejects.toThrow("reservation removal failed");
		expect(control.releaseCalls).toBe(1);
		expect(existsSync(join(root, ".pao", "执行占位.json"))).toBe(true);

		control.failReservationRemoval = false;
		await releaseDispatchLock(lock, proof);
		expect(control.releaseCalls).toBe(1);
		expect(existsSync(join(root, ".pao", "执行占位.json"))).toBe(false);
	});

	test("审计日志写入失败：暴露路径与 cause，持锁和后续释放继续生效", async () => {
		const root = tempDir("audit-warning");
		control.failLogWrites = true;

		const lock = await acquireExecutionLock({ root, holder: "审计降级" });
		expect(control.releaseCalls).toBe(0);
		await expect(isExecutionLocked(root)).resolves.toBe(true);
		expect(logWarn).toHaveBeenCalledWith(expect.stringContaining(dispatchLockLogPath(root)));
		expect(logWarn).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
		expect(logWarn).toHaveBeenCalledWith(expect.stringContaining("permission denied"));

		const proof = new WorkerRunner().confirmStopped("审计降级");
		await releaseDispatchLock(lock, proof);
		expect(control.releaseCalls).toBe(1);
		await expect(isExecutionLocked(root)).resolves.toBe(false);
	});

	test("无合法停止证明时拒绝释放，执行锁与持久占位均保留", async () => {
		const root = tempDir("missing-stop-proof");
		const lock = await acquireExecutionLock({ root, holder: "停止未确认" });
		const reservation = join(root, ".pao", "执行占位.json");
		expect(existsSync(reservation)).toBe(true);

		await expect(releaseDispatchLock(lock, {} as never)).rejects.toMatchObject({ code: "无效凭据" });
		await expect(isExecutionLocked(root)).resolves.toBe(true);
		expect(existsSync(reservation)).toBe(true);

		await releaseDispatchLock(lock, new WorkerRunner().confirmStopped("停止未确认"));
		await expect(isExecutionLocked(root)).resolves.toBe(false);
		expect(existsSync(reservation)).toBe(false);
	});

	test("持久占位存在时，即使 proper-lockfile 判断租约失效也拒绝重新派发", async () => {
		const root = tempDir("persistent-reservation");
		const paoDir = join(root, ".pao");
		mkdirSync(paoDir, { recursive: true });
		writeFileSync(
			join(paoDir, "执行占位.json"),
			JSON.stringify({ holder: "已崩溃但停止未确认", acquiredAt: "2026-10-19T00:00:00.000Z" }),
			"utf8",
		);

		await expect(acquireExecutionLock({ root, holder: "普通重试" })).rejects.toThrow("持久占位");
		expect(control.lockCalls).toBe(0);
		await expect(isExecutionLocked(root)).resolves.toBe(true);
	});

	test("执行锁 wait=true 会排队等待同根前一持有者自然结束", async () => {
		const realLock = await vi.importActual<typeof import("proper-lockfile")>("proper-lockfile");
		const mockedLock = (await import("proper-lockfile")).default;
		vi.mocked(mockedLock.lock).mockImplementation((...args: Parameters<typeof realLock.lock>) =>
			realLock.lock(...args),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const root = tempDir("execution-wait");
		const first = await acquireExecutionLock({ root, holder: "前序任务" });
		let secondSettled = false;
		try {
			const secondPromise = acquireExecutionLock({
				root,
				holder: "排队任务",
				wait: true,
			}).then((lock) => {
				secondSettled = true;
				return lock;
			});
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect(secondSettled).toBe(false);
			const proof = new WorkerRunner().confirmStopped("前序任务");
			await releaseDispatchLock(first, proof);
			const second = await secondPromise;
			expect(secondSettled).toBe(true);
			await releaseDispatchLock(second, new WorkerRunner().confirmStopped("排队任务"));
			await expect(isExecutionLocked(root)).resolves.toBe(false);
		} finally {
			if (!secondSettled) {
				try {
					const proof = new WorkerRunner().confirmStopped("前序任务");
					await releaseDispatchLock(first, proof);
				} catch {
					// 已经由正常路径释放。
				}
			}
		}
	});
});

describe("任务根侧执行目录守卫", () => {
	test("guard 把执行根占用映射为 active，并在释放后可再次取得", async () => {
		const root = tempDir("guard-root");
		const taskRoot = join(root, "task");
		const executionRoot = join(root, "execution");
		mkdirSync(taskRoot, { recursive: true });
		mkdirSync(executionRoot, { recursive: true });
		const lock = await acquireExecutionLock({ root: executionRoot, holder: "既有任务" });
		await expect(detectExecutionOccupancy(executionRoot)).resolves.toBe("active");
		const blocked = await acquireExecutionRootGuard({
			taskRoot,
			executionRoot,
			holder: "清理守卫",
		});
		expect(blocked.occupancy).toBe("active");
		await blocked.release();
		const proof = new WorkerRunner().confirmStopped("既有任务");
		await releaseDispatchLock(lock, proof);
		const idle = await acquireExecutionRootGuard({
			taskRoot,
			executionRoot,
			holder: "清理守卫",
		});
		expect(idle.occupancy).toBe("idle");
		await idle.release();
	});

	test("guard 遇到坏占位或检查异常都按非 idle 处理，且不自动删除", async () => {
		const root = tempDir("guard-unknown");
		const taskRoot = join(root, "task");
		const executionRoot = join(root, "execution");
		mkdirSync(taskRoot, { recursive: true });
		mkdirSync(join(executionRoot, ".pao"), { recursive: true });
		const reservation = join(executionRoot, ".pao", "执行占位.json");
		writeFileSync(reservation, '{"type":', "utf8");
		await expect(detectExecutionOccupancy(executionRoot)).resolves.toBe("unknown");
		const guard = await acquireExecutionRootGuard({
			taskRoot,
			executionRoot,
			holder: "坏占位清理",
		});
		expect(guard.occupancy).toBe("unknown");
		await guard.release();
		expect(existsSync(reservation)).toBe(true);

		rmSync(executionRoot, { recursive: true, force: true });
		await expect(detectExecutionOccupancy(executionRoot)).resolves.toBe("unknown");
	});

	test("guard 有活锁时，另一个进程的清理守卫不能进入处置阶段", async () => {
		const root = tempDir("guard-live-lock");
		const taskRoot = join(root, "task");
		const executionRoot = join(root, "execution");
		mkdirSync(taskRoot, { recursive: true });
		mkdirSync(executionRoot, { recursive: true });
		const lock = await acquireExecutionLock({ root: executionRoot, holder: "前台任务" });
		const child = startGuardChild(taskRoot, executionRoot);
		try {
			const ready = await nextJsonLine(child, (value) => value.guard !== undefined);
			expect(ready.occupancy).toBe("active");
			child.stdin?.write("release\n");
			await nextJsonLine(child, (value) => value.released !== undefined);
		} finally {
			child.kill();
			await releaseDispatchLock(lock, new WorkerRunner().confirmStopped("guard-live-lock"));
		}
	});

	test("执行根删除互斥期间，新派发在取得执行根守卫时被拒绝", async () => {
		const root = tempDir("guard-dispatch-race");
		const taskRoot = join(root, "task");
		const executionRoot = join(root, "execution");
		mkdirSync(taskRoot, { recursive: true });
		mkdirSync(executionRoot, { recursive: true });
		const child = startGuardChild(taskRoot, executionRoot);
		try {
			const ready = await nextJsonLine(child, (value) => value.guard !== undefined);
			expect(ready.occupancy).toBe("idle");
			await expect(acquireExecutionRootGuard({ taskRoot, executionRoot, holder: "清理竞态派发" })).rejects.toThrow(
				"执行根已有清理或占用守卫",
			);
			expect(existsSync(join(executionRoot, ".pao", "执行占位.json"))).toBe(false);
			child.stdin?.write("release\n");
			await nextJsonLine(child, (value) => value.released !== undefined);
		} finally {
			child.kill();
		}
	});

	test("正常停止后只归档派发日志并删除空锁目录，其他 .pao 文件和证据原样保留", async () => {
		const root = tempDir("guard-artifacts");
		const taskRoot = join(root, "task");
		const executionRoot = join(root, "execution");
		const archiveRoot = join(taskRoot, ".pao", "清理证据");
		mkdirSync(join(executionRoot, ".pao"), { recursive: true });
		mkdirSync(join(taskRoot, ".pao"), { recursive: true });
		writeFileSync(join(executionRoot, ".pao", "执行锁"), "", "utf8");
		writeFileSync(join(executionRoot, ".pao", "派发日志.jsonl"), '{"event":"lock"}\n', "utf8");
		writeFileSync(join(executionRoot, ".pao", "用户证据.txt"), "保留\n", "utf8");
		const guard = await acquireExecutionRootGuard({
			taskRoot,
			executionRoot,
			holder: "正常清理",
		});
		expect(guard.occupancy).toBe("idle");
		const artifacts = await prepareExecutionRootForRemoval({ guard, archiveRoot });
		expect(artifacts.filter((item) => item.action === "archived")).toHaveLength(2);
		expect(existsSync(join(executionRoot, ".pao", "执行锁"))).toBe(false);
		expect(existsSync(join(executionRoot, ".pao", "派发日志.jsonl"))).toBe(false);
		expect(existsSync(join(executionRoot, ".pao", "用户证据.txt"))).toBe(true);
		expect(existsSync(archiveRoot)).toBe(true);
		await guard.release();
	});

	test("宿主盘点的待归档清单精确列出三项，不读取坏占位且不递归", () => {
		const root = tempDir("guard-list");
		const paoDir = join(root, ".pao");
		mkdirSync(join(paoDir, "执行锁.lock"), { recursive: true });
		writeFileSync(join(paoDir, "执行锁"), "", "utf8");
		writeFileSync(join(paoDir, "派发日志.jsonl"), "", "utf8");
		writeFileSync(join(paoDir, "执行占位.json"), '{"type":', "utf8");
		writeFileSync(join(paoDir, "用户证据.txt"), "", "utf8");

		expect(listReleasedExecutionArtifacts(root)).toEqual([
			join(paoDir, "执行锁"),
			join(paoDir, "执行锁.lock"),
			join(paoDir, "派发日志.jsonl"),
		]);
		expect(existsSync(join(paoDir, "执行占位.json"))).toBe(true);
	});
});
