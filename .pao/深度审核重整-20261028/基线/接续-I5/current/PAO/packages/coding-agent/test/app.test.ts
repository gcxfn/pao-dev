import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectLocalDesktop, runDesktopApp } from "../src/cli/app.ts";
import { VERSION } from "../src/config.ts";

describe("本地桌面入口（模拟安装布局，无窗口无模型）", () => {
	it("缺产物/第二内核明确拒绝，终端回退不探测桌面", async () => {
		const root = mkdtempSync(join(tmpdir(), "pao-app-fixture-"));
		const report = inspectLocalDesktop(root, join(root, "kernel"));
		expect(report.compatible).toBe(false);
		expect(report.problems.length).toBeGreaterThan(0);
		await expect(runDesktopApp(["--terminal"])).resolves.toBe("terminal");
		await expect(runDesktopApp(["--unknown"])).rejects.toThrow("用法");
	});
	it("当前 fork 与本地 SDK 同一目录且产物完整才通过静态检查", () => {
		const root = mkdtempSync(join(tmpdir(), "pao-app-layout-"));
		const kernel = join(root, "packages", "pi-sdk-driver", "node_modules", "@earendil-works", "pi-coding-agent");
		const files = [
			"apps/desktop/out/main/main.js",
			"packages/pi-sdk-driver/dist/index.js",
			"node_modules/electron/path.txt",
			"node_modules/electron/dist/electron.exe",
		];
		for (const file of files) {
			const path = join(root, file);
			mkdirSync(join(path, ".."), { recursive: true });
			writeFileSync(path, file.endsWith("path.txt") ? "electron.exe" : "fixture");
		}
		mkdirSync(join(kernel, "dist"), { recursive: true });
		writeFileSync(join(kernel, "dist", "index.js"), "fixture");
		writeFileSync(join(kernel, "package.json"), JSON.stringify({ version: VERSION, piConfig: { name: "pao" } }));
		expect(inspectLocalDesktop(root, kernel).compatible).toBe(true);
		writeFileSync(join(kernel, "package.json"), JSON.stringify({ version: "0.0.0", piConfig: { name: "pi" } }));
		expect(inspectLocalDesktop(root, kernel).problems.join()).toContain("身份不符");
	});
});
