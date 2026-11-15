import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DispatchBriefError } from "../../src/pao/dispatch-brief/errors.ts";
import { captureDispatchMap } from "../../src/pao/dispatch-brief/workspace.ts";
import { GIT_READ_TIMEOUT_MS } from "../../src/pao/shared/git.ts";
import { inventory } from "../../src/pao/worker/inventory.ts";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const spawnSync = vi.fn((command: string, args: string[], options: unknown) => {
		const executorCode = process.env.PAO_TEST_GIT_EXECUTOR_CODE;
		if (executorCode && command === "git" && args.includes("cat-file")) {
			// 模拟子进程一直占住执行器，直到超时边界返回；不等待生产 30 秒预算。
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
			const error = Object.assign(new Error(`spawnSync git ${executorCode}`), {
				code: executorCode,
				killed: executorCode === "ETIMEDOUT",
				signal: "SIGTERM",
			});
			return {
				pid: 1,
				output: [null, "", Buffer.from("partial stderr")],
				stdout: null,
				stderr: Buffer.from("partial stderr"),
				status: null,
				signal: "SIGTERM",
				error,
			};
		}
		return actual.spawnSync(command, args, options as Parameters<typeof actual.spawnSync>[2]);
	});
	type ExecFileCallback = Parameters<typeof actual.execFile>[3];
	const execFile = vi.fn((command: string, args: string[], options: unknown, callback: ExecFileCallback) => {
		if (!callback) throw new Error("fixture: execFile callback required");
		if (process.env.PAO_TEST_GIT_EXECUTOR_CODE === "ETIMEDOUT" && command === "git" && args.includes("status")) {
			const error = Object.assign(new Error("Command failed: git status"), {
				killed: true,
				signal: "SIGTERM" as const,
			}) satisfies NodeJS.ErrnoException;
			queueMicrotask(() => callback(error, "", "warning: partial inventory stderr"));
			return {};
		}
		return actual.execFile(
			command,
			args,
			options as Parameters<typeof actual.execFile>[2],
			callback as Parameters<typeof actual.execFile>[3],
		);
	});
	return {
		...actual,
		spawnSync: spawnSync as unknown as typeof actual.spawnSync,
		execFile: execFile as unknown as typeof actual.execFile,
	};
});

const roots: string[] = [];

afterEach(() => {
	delete process.env.PAO_TEST_GIT_EXECUTOR_CODE;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(): string {
	const root = mkdtempSync(join(tmpdir(), "pao-git-read-boundaries-"));
	roots.push(root);
	execFileSync("git", ["init", "--quiet"], { cwd: root });
	writeFileSync(join(root, "source.ts"), "export const value = 1;\n");
	execFileSync("git", ["add", "source.ts"], { cwd: root });
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "fixture"], { cwd: root });
	return root;
}

describe("Git 读取执行器边界", () => {
	it.each(["ETIMEDOUT", "EACCES"])("gitSucceeded 收到 %s 时抛领域错误并保留部分 stderr", (code) => {
		const root = repo();
		process.env.PAO_TEST_GIT_EXECUTOR_CODE = code;
		const captured = (() => {
			try {
				captureDispatchMap({
					id: "executor-error",
					projectRoot: root,
					coverage: ["source.ts"],
					scopeConfirmed: true,
					scopeBasis: ["fixture"],
				});
			} catch (error) {
				return error;
			}
		})();
		expect(captured).toBeInstanceOf(DispatchBriefError);
		expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
			"git",
			["-c", "core.quotepath=off", "cat-file", "-e", "HEAD:source.ts"],
			expect.objectContaining({ timeout: GIT_READ_TIMEOUT_MS }),
		);
		expect((captured as DispatchBriefError).code).toBe("missing_input");
		expect((captured as Error).message).toContain(code);
		expect((captured as Error).message).toContain("partial stderr");
		if (code === "ETIMEDOUT") expect((captured as Error).message).toContain("30000ms");
	});

	it("inventory 默认 execFile 回调同时保留超时执行器原因与部分 stderr", async () => {
		const root = repo();
		const workspace = join(root, ".pao", "任务");
		mkdirSync(join(workspace, "卡"), { recursive: true });
		process.env.PAO_TEST_GIT_EXECUTOR_CODE = "ETIMEDOUT";
		const report = await inventory({ 工作区: workspace });
		expect(report.git.可用).toBe(false);
		expect(report.git.原因).toContain("30000ms");
		expect(report.git.原因).toContain("warning: partial inventory stderr");
	});
});
