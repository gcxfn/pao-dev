import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runCardProcess } from "../../src/pao/cards/process.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("可执行文件存在而 cwd 缺失时，不把 ENOENT 误报成命令不存在", async () => {
	const root = mkdtempSync(join(tmpdir(), "pao-process-start-"));
	roots.push(root);
	const cwd = join(root, "missing");
	const result = await runCardProcess(process.execPath, ["-e", "process.exit(0)"], cwd, 5000);
	expect(result.code).toBe(127);
	expect(result.failureKind).toBe("start");
	expect(result.stderr).toContain("ENOENT");
	expect(result.stderr).toContain(cwd);
	expect(result.stderr).toContain(process.execPath);
	expect(result.stderr).not.toContain("命令不存在");
});

it.each([124, 127])("程序主动退出 %i 保留检查失败语义", async (code) => {
	const result = await runCardProcess(process.execPath, ["-e", `process.exit(${code})`], process.cwd(), 5000);
	expect(result.code).toBe(code);
	expect(result.failureKind).toBeUndefined();
});

it("命令缺失时仍返回 127，并保留真实命令和工作目录", async () => {
	const root = mkdtempSync(join(tmpdir(), "pao-process-start-"));
	roots.push(root);
	const result = await runCardProcess("pao-nonexistent-executable", [], root, 5000);
	expect(result.code).toBe(127);
	expect(result.stderr).toContain("pao-nonexistent-executable");
	expect(result.stderr).toContain(root);
});
