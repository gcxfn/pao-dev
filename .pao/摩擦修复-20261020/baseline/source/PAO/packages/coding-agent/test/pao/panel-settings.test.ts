/**
 * /pao 面板设置读写单测（命令统一批·B 线）:写盘往返保真——只改目标键、其余键原样
 * 保留（含记忆供应商的「供应商」「参数」连接配置字段）、原子写、坏文件拒写不覆盖、
 * 记忆供应商.json 缺失拒写（不代建坏配置）。测试一律用临时目录造 fixture,
 * 不读真实 PAO_HOME,fixture 里的「参数」字段为无意义假值（不打印任何疑似密钥）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readWarmConfig, toastEnabled } from "../../src/pao/host/config.ts";
import { loadMemoryVendorConfig } from "../../src/pao/memory/memory-vendor.ts";
import {
	resolveMemoryHomeConfigPath,
	resolveWarmConfigPath,
	writeMemorySetting,
	writeWarmSetting,
} from "../../src/pao/panel/settings.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeHome(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-panel-test-"));
	tempDirs.push(dir);
	return dir;
}

function writeFixture(home: string, fileName: "保温.json" | "记忆供应商.json", obj: unknown): void {
	mkdirSync(join(home, "pao配置"), { recursive: true });
	writeFileSync(join(home, "pao配置", fileName), `${JSON.stringify(obj, null, "  ")}\n`, "utf8");
}

describe("保温.json 写入（面板设置）", () => {
	it("文件缺失时新建只含目标键的文件;读回口径与 toastEnabled 同源", () => {
		const home = makeHome();
		expect(existsSync(resolveWarmConfigPath(home))).toBe(false);
		writeWarmSetting(home, "toast 通知", false);
		expect(JSON.parse(readFileSync(resolveWarmConfigPath(home), "utf8"))).toEqual({ "toast 通知": false });
		expect(toastEnabled(home)).toBe(false); // 与现有读取函数同语义往返
		writeWarmSetting(home, "toast 通知", true);
		expect(toastEnabled(home)).toBe(true);
	});

	it("只改目标键,其余键（含其他保温功能键）原样保留", () => {
		const home = makeHome();
		writeFixture(home, "保温.json", { 空闲分钟: 45, 部门并发上限: 2, 上游并发上限: 3 });
		writeWarmSetting(home, "上游并发上限", 6);
		expect(JSON.parse(readFileSync(resolveWarmConfigPath(home), "utf8"))).toEqual({
			空闲分钟: 45,
			部门并发上限: 2,
			上游并发上限: 6,
		});
		expect(readWarmConfig(home).上游并发上限).toBe(6);
	});

	it("写 undefined ＝ 删键（「默认」档还原为键缺失＝不启用配置层）", () => {
		const home = makeHome();
		writeFixture(home, "保温.json", { 空闲分钟: 45, 上游并发上限: 6 });
		writeWarmSetting(home, "上游并发上限", undefined);
		expect(JSON.parse(readFileSync(resolveWarmConfigPath(home), "utf8"))).toEqual({ 空闲分钟: 45 });
		expect(readWarmConfig(home).上游并发上限).toBeUndefined();
	});

	it("坏 JSON 拒写并抛错,原文件字节不动（绝不整文件覆盖）", () => {
		const home = makeHome();
		mkdirSync(join(home, "pao配置"), { recursive: true });
		const bad = "{ 不是合法 json";
		writeFileSync(resolveWarmConfigPath(home), bad, "utf8");
		expect(() => writeWarmSetting(home, "toast 通知", false)).toThrow(/不是合法 JSON/);
		expect(readFileSync(resolveWarmConfigPath(home), "utf8")).toBe(bad);
	});
});

describe("记忆供应商.json 写入（面板设置）", () => {
	it("文件缺失时拒绝写并抛错（新建只剩开关的文件是坏配置,不代建）", () => {
		const home = makeHome();
		expect(() => writeMemorySetting(home, "自动召回", true)).toThrow(/不存在/);
		expect(existsSync(resolveMemoryHomeConfigPath(home))).toBe(false);
	});

	it("只翻目标布尔键,「供应商」「参数」连接配置字段原样保留", () => {
		const home = makeHome();
		const fixture = {
			供应商: "fixture-vendor",
			参数: { endpoint: "https://fixture.example/embed", apiKey: "fixture-not-a-real-key" },
			自动召回: false,
		};
		writeFixture(home, "记忆供应商.json", fixture);
		writeMemorySetting(home, "自动交接", true);
		const after = JSON.parse(readFileSync(resolveMemoryHomeConfigPath(home), "utf8"));
		expect(after).toEqual({ ...fixture, 自动交接: true });
		const parsed = loadMemoryVendorConfig(resolveMemoryHomeConfigPath(home));
		expect(parsed?.供应商).toBe("fixture-vendor");
		expect(parsed?.自动交接).toBe(true);
		expect(parsed?.自动召回).toBe(false);
		// 翻回再验一次开关位
		writeMemorySetting(home, "自动召回", true);
		expect(loadMemoryVendorConfig(resolveMemoryHomeConfigPath(home))?.自动召回).toBe(true);
	});

	it("坏 JSON 拒写并抛错,原文件字节不动", () => {
		const home = makeHome();
		mkdirSync(join(home, "pao配置"), { recursive: true });
		const bad = "{ 坏的";
		writeFileSync(resolveMemoryHomeConfigPath(home), bad, "utf8");
		expect(() => writeMemorySetting(home, "自动召回", true)).toThrow(/不是合法 JSON/);
		expect(readFileSync(resolveMemoryHomeConfigPath(home), "utf8")).toBe(bad);
	});
});
