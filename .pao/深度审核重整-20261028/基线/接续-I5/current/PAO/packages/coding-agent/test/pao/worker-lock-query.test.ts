import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { isProjectLocked } from "../../src/pao/worker/lock.ts";

/**
 * isProjectLocked 读失败语义（P2 清账）:proper-lockfile 的 check 已把「锁目录不存在
 * (ENOENT)」归一为 false;其余错误（权限/IO）必须如实上抛,不许吞成「未锁」——
 * 提示性检查误报读失败会掩盖真问题。用注入 env 开关的 delegating mock 只改 check。
 */
vi.mock("proper-lockfile", async (importOriginal) => {
	const actual = await importOriginal<typeof import("proper-lockfile")>();
	// 运行时是 CJS:default import 拿到的是 module.exports(类型声明只写具名导出,这里用断言桥接)
	const moduleExports = actual as unknown as { default?: typeof actual } & typeof actual;
	const realCheck = actual.check;
	const mockCheck = (file: string, options?: Parameters<typeof realCheck>[1]) => {
		if (process.env.PAO_TEST_LOCK_CHECK_FAIL === "1") {
			const error = new Error("fixture: lock check permission denied") as NodeJS.ErrnoException;
			error.code = "EACCES";
			return Promise.reject(error);
		}
		return realCheck(file, options);
	};
	const mocked = {
		...moduleExports.default,
		check: mockCheck,
	};
	return {
		...actual,
		check: mockCheck,
		default: mocked,
	} as unknown as typeof actual;
});

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pao-lock-query-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	delete process.env.PAO_TEST_LOCK_CHECK_FAIL;
	for (const dir of tempDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		} catch {
			// Windows 句柄释放延迟,残留交系统临时目录清理
		}
	}
});

describe("isProjectLocked 读失败语义", () => {
	test("无锁:锁目录不存在(ENOENT)按未锁返回 false,不因缺目录报错", async () => {
		const root = tempDir("free");
		await expect(isProjectLocked(root)).resolves.toBe(false);
	});

	test("check 真错误(EACCES)如实上抛,不吞成「未锁」", async () => {
		const root = tempDir("eacces");
		process.env.PAO_TEST_LOCK_CHECK_FAIL = "1";
		// 旧实现 catch 全吞返 false——这里必须 rejects 才算语义成立
		await expect(isProjectLocked(root)).rejects.toThrow(/permission denied/);
	});

	test("项目根不存在:canonicalDir 如实抛 无效参数(既有行为,不经 check 吞掉)", async () => {
		const missing = join(tempDir("missing-root"), "不存在的子目录");
		await expect(isProjectLocked(missing)).rejects.toThrow(/项目根不存在/);
	});
});
