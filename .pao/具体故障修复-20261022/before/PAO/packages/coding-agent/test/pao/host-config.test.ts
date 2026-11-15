import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readWarmConfig, WARM_CONFIG_RELATIVE_PATH } from "../../src/pao/host/config.ts";
import { DEFAULT_DEPT_CONCURRENCY, readDeptConcurrencyCap } from "../../src/pao/worker/dispatch-core.ts";

/**
 * 保温配置共享读取模块(定案5):键语义全仓一份,pao_dispatch_card 的部门并发上限(dispatch-core)
 * 内部改调本模块后行为不变——护栏缺省 3 在文件/键缺失/坏值时照样生效。
 */

const tempDirs: string[] = [];

// Windows 下被杀进程的 cwd 句柄释放有延迟,rmSync 可能 EPERM——清理尽力而为,不让收尾失败连累已通过的断言
function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	} catch {
		// 残留目录交给系统临时目录清理,不影响测试结果
	}
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) cleanupDir(dir);
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pao-host-config-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

function writeWarm(home: string, body: string): void {
	mkdirSync(join(home, "pao配置"), { recursive: true });
	writeFileSync(join(home, "pao配置", "保温.json"), body, "utf8");
}

describe("readWarmConfig:缺文件=不保温(功能缺省关)", () => {
	it("无 PAO_HOME / 文件不存在 / 坏 JSON / 顶层不是对象 → 存在:false", () => {
		expect(readWarmConfig(undefined)).toEqual({ 存在: false });
		expect(readWarmConfig(tempDir("missing"))).toEqual({ 存在: false });
		const bad = tempDir("bad");
		writeWarm(bad, "{ 不是 JSON");
		expect(readWarmConfig(bad)).toEqual({ 存在: false });
		const arr = tempDir("arr");
		writeWarm(arr, "[]");
		expect(readWarmConfig(arr)).toEqual({ 存在: false });
	});

	it("文件存在:已知键解析,未知键忽略,非法值按缺键处理(不猜)", () => {
		const home = tempDir("valid");
		writeWarm(
			home,
			JSON.stringify({
				空闲分钟: 45,
				轮次提示: 300,
				调用提示: 4000,
				工人监督轮次: 50,
				部门监督轮次: 100,
				停滞阈值分钟: 15,
				循环K: 5,
				部门并发上限: 4,
				未知键: "随便",
			}),
		);
		expect(readWarmConfig(home)).toEqual({
			存在: true,
			空闲分钟: 45,
			轮次提示: 300,
			调用提示: 4000,
			工人监督轮次: 50,
			部门监督轮次: 100,
			停滞阈值分钟: 15,
			循环K: 5,
			部门并发上限: 4,
		});
	});

	it("监督轮次 0 必须可表达(0=该级关);负数/小数按缺键;正小数取整", () => {
		const home = tempDir("zero");
		writeWarm(home, JSON.stringify({ 工人监督轮次: 0, 空闲分钟: -5, 部门并发上限: 2.9 }));
		const config = readWarmConfig(home);
		expect(config.工人监督轮次).toBe(0);
		expect(config.空闲分钟).toBeUndefined();
		expect(config.部门并发上限).toBe(2);
	});
});

describe("readDeptConcurrencyCap:共享模块改调后护栏行为不变", () => {
	it("缺省 3:无 PAO_HOME / 文件缺失 / 键缺失 / 坏值一律 3(护栏缺省开)", () => {
		expect(readDeptConcurrencyCap(undefined)).toBe(DEFAULT_DEPT_CONCURRENCY);
		expect(readDeptConcurrencyCap(tempDir("none"))).toBe(3);
		const empty = tempDir("empty");
		mkdirSync(join(empty, "pao配置"), { recursive: true });
		writeFileSync(join(empty, WARM_CONFIG_RELATIVE_PATH), JSON.stringify({ 空闲分钟: 30 }), "utf8");
		expect(readDeptConcurrencyCap(empty)).toBe(3);
		const bad = tempDir("badcap");
		writeWarm(bad, JSON.stringify({ 部门并发上限: 0 }));
		expect(readDeptConcurrencyCap(bad)).toBe(3);
	});

	it("显式配置生效:1 → 1", () => {
		const home = tempDir("cap1");
		writeWarm(home, JSON.stringify({ 部门并发上限: 1 }));
		expect(readDeptConcurrencyCap(home)).toBe(1);
	});
});
