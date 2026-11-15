import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getPackageDir } from "../../src/config.ts";
import { defaultInvocation } from "../../src/pao/worker/runner.ts";

describe("SDK 宿主的 worker 入口", () => {
	it("当前入口是测试宿主时仍选择本地 PAO CLI，而不是重启宿主", () => {
		const cli = join(getPackageDir(), "dist", "bundle", "cli.js");
		expect(existsSync(cli)).toBe(true);
		const original = process.argv[1];
		process.argv[1] = join(getPackageDir(), "package.json");
		try {
			expect(defaultInvocation(["--mode", "rpc"])).toEqual({
				command: process.execPath,
				args: [cli, "--mode", "rpc"],
			});
		} finally {
			process.argv[1] = original;
		}
	});

	it("无当前脚本（SDK 内嵌态）时解析内嵌构建入口，不暗退全局 pao 命令", () => {
		const cli = join(getPackageDir(), "dist", "bundle", "cli.js");
		expect(existsSync(cli)).toBe(true);
		const original = process.argv[1];
		delete process.argv[1];
		try {
			expect(defaultInvocation(["--mode", "rpc"])).toEqual({
				command: process.execPath,
				args: [cli, "--mode", "rpc"],
			});
		} finally {
			process.argv[1] = original;
		}
	});

	it("桌面宿主（Electron）缺内嵌构建时明确报错，不暗退 PATH 上的全局 pao", () => {
		const original = process.argv[1];
		const savedPkgDir = process.env.PI_PACKAGE_DIR;
		process.env.PI_PACKAGE_DIR = join(tmpdir(), `pao-no-embed-${Date.now()}`);
		const savedElectron = process.versions.electron;
		(process.versions as Record<string, string | undefined>).electron = "37.10.3";
		delete process.argv[1];
		try {
			expect(() => defaultInvocation(["--mode", "rpc"])).toThrow(/拒绝回落.*全局 pao/);
		} finally {
			process.argv[1] = original;
			if (savedPkgDir === undefined) delete process.env.PI_PACKAGE_DIR;
			else process.env.PI_PACKAGE_DIR = savedPkgDir;
			if (savedElectron === undefined) delete (process.versions as Record<string, string | undefined>).electron;
			else (process.versions as Record<string, string | undefined>).electron = savedElectron;
		}
	});
});
