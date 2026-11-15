// 真实文件配合明确的系统调用故障注入；不调用模型，不证明断电安全。
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFileAtomic } from "../../src/pao/shared/atomic.ts";
import { withFileLock } from "../../src/pao/shared/lock.ts";

const faults = vi.hoisted(() => ({
	renameError: undefined as NodeJS.ErrnoException | undefined,
	writeError: undefined as Error | undefined,
	cleanupError: undefined as Error | undefined,
	renameCalls: 0,
}));
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return {
		...fs,
		renameSync: (...args: Parameters<typeof fs.renameSync>) => {
			faults.renameCalls++;
			if (faults.renameError) throw faults.renameError;
			return fs.renameSync(...args);
		},
		writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
			if (faults.writeError) {
				fs.writeFileSync(args[0], "部分临时内容");
				throw faults.writeError;
			}
			return fs.writeFileSync(...args);
		},
		unlinkSync: (...args: Parameters<typeof fs.unlinkSync>) => {
			if (faults.cleanupError) throw faults.cleanupError;
			return fs.unlinkSync(...args);
		},
	};
});
const dirs: string[] = [];
function target(): string {
	const parent = tmpdir();
	mkdirSync(parent, { recursive: true });
	const dir = mkdtempSync(join(parent, "state-"));
	dirs.push(dir);
	const file = join(dir, "state.json");
	writeFileSync(file, "完整旧内容");
	return file;
}
afterEach(() => {
	faults.renameError = undefined;
	faults.writeError = undefined;
	faults.cleanupError = undefined;
	faults.renameCalls = 0;
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("原子替换故障保持旧正本", () => {
	it("真实并发读线程始终只看到完整版本", async () => {
		const file = target();
		const allowed = ["完整旧内容", ...Array.from({ length: 20 }, (_, i) => `${i}:${"x".repeat(100_000)}`)];
		const stop = new SharedArrayBuffer(4);
		const worker = new Worker(new URL("./atomic-reader-child.mjs", import.meta.url), {
			workerData: { file, allowed, stop },
		});
		const done = new Promise<{ reads: number; invalid?: string }>((resolve, reject) => {
			worker.on("message", (message) => {
				if (message !== "ready") resolve(message);
			});
			worker.on("error", reject);
		});
		try {
			await new Promise<void>((resolve, reject) => {
				worker.once("message", () => resolve());
				worker.once("error", reject);
			});
			for (const payload of allowed.slice(1)) {
				try {
					writeFileAtomic(file, payload);
				} catch (error) {
					// Windows读句柄占用可导致明确替换失败；失败也必须保留完整旧版。
					expect(["EPERM", "EACCES"]).toContain((error as NodeJS.ErrnoException).code);
				}
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
			Atomics.store(new Int32Array(stop), 0, 1);
			const observation = await done;
			expect(observation.reads).toBeGreaterThan(0);
			expect(observation.invalid).toBeUndefined();
		} finally {
			Atomics.store(new Int32Array(stop), 0, 1);
			await worker.terminate();
		}
	});
	it.each(["EPERM", "EACCES", "EIO"])("%s 不退回覆盖", (code) => {
		const file = target();
		const error = Object.assign(new Error(`模拟${code}`), { code });
		faults.renameError = error;
		expect(() => writeFileAtomic(file, "完整新内容")).toThrow(error);
		expect(readFileSync(file, "utf8")).toBe("完整旧内容");
		expect(faults.renameCalls).toBe(code === "EIO" ? 1 : 3);
		expect(readdirSync(join(file, ".."))).toEqual(["state.json"]);
	});
	it("临时文件部分写入即失败，旧正本仍完整", () => {
		const file = target();
		faults.writeError = new Error("模拟临时写中断");
		expect(() => writeFileAtomic(file, "新内容")).toThrow(faults.writeError);
		expect(readFileSync(file, "utf8")).toBe("完整旧内容");
		expect(faults.renameCalls).toBe(0);
	});
	it("替换与清理均失败保留两种原始异常", () => {
		const file = target();
		faults.renameError = Object.assign(new Error("模拟替换失败"), { code: "EIO" });
		faults.cleanupError = new Error("模拟清理失败");
		try {
			writeFileAtomic(file, "新内容");
			throw new Error("不应成功");
		} catch (error) {
			expect(error).toBeInstanceOf(AggregateError);
			expect((error as AggregateError).errors).toEqual([faults.renameError, faults.cleanupError]);
		}
		expect(readFileSync(file, "utf8")).toBe("完整旧内容");
	});
});

describe("文件锁业务与释放结果", () => {
	it.each([
		[false, false],
		[true, false],
		[false, true],
		[true, true],
	])("业务失败=%s 释放失败=%s", async (businessFails, releaseFails) => {
		const businessError = new Error("模拟业务失败");
		const releaseError = new Error("模拟释放失败");
		const release = vi.fn(async () => {
			if (releaseFails) throw releaseError;
		});
		vi.spyOn(lockfile, "lock").mockResolvedValue(release);
		const result = withFileLock("unused", async () => {
			if (businessFails) throw businessError;
			return 42;
		});
		if (businessFails && releaseFails) {
			await expect(result).rejects.toMatchObject({ errors: [businessError, releaseError], cause: businessError });
		} else if (businessFails || releaseFails) {
			await expect(result).rejects.toBe(businessFails ? businessError : releaseError);
		} else {
			await expect(result).resolves.toBe(42);
		}
		expect(release).toHaveBeenCalledTimes(1);
	});
});
