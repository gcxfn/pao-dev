/**
 * §22 档位编辑器纯库单测：部门默认档校验（查无档位报错/空部门名/非对象）、
 * saveTierConfig 写回（写前自校验拒坏结构＋时间戳备份＋原子写保留 部门默认＋首建无备份）。
 * 交互层（/model 档位列表与引导流）见 routing-model-command.test.ts。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadTierConfig, saveTierConfig, validateTierConfig } from "../../src/pao/routing/index.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-tier-save-"));
	tempDirs.push(dir);
	return dir;
}

const VALID: import("../../src/pao/routing/config.ts").TierConfig = {
	provider: "pao",
	档位: [
		{ 名: "快", provider: "faux", model: "m-fast", thinkingLevel: "low" },
		{ 名: "主力", provider: "faux", model: "m-main", thinkingLevel: "high" },
	],
	部门默认: { 测试部: "快" },
};

describe("部门默认档校验（§22 封装层字段）", () => {
	it("合法:部门名→已定义档名,通过并保留", () => {
		const config = validateTierConfig(VALID, "测试源");
		expect(config.部门默认).toEqual({ 测试部: "快" });
	});

	it("引用未定义档位:报错并列出现有档", () => {
		expect(() => validateTierConfig({ ...VALID, 部门默认: { 测试部: "不存在的档" } }, "测试源")).toThrow(
			/「部门默认\.测试部」引用未定义档位「不存在的档」.*快、主力/,
		);
	});

	it("非对象与空部门名:报错", () => {
		expect(() => validateTierConfig({ ...VALID, 部门默认: ["快"] }, "测试源")).toThrow(/部门默认.*应为对象/);
		expect(() => validateTierConfig({ ...VALID, 部门默认: { " ": "快" } }, "测试源")).toThrow(/空部门名/);
	});

	it("字段缺省:不设键,行为与旧配置兼容", () => {
		const config = validateTierConfig({ provider: "pao", 档位: VALID.档位 }, "测试源");
		expect(config.部门默认).toBeUndefined();
	});
});

describe("saveTierConfig（备份＋原子写回）", () => {
	it("写回:旧文件时间戳备份,新内容可再读回,部门默认保留", () => {
		const dir = tempDir();
		const path = join(dir, "档位.json");
		writeFileSync(
			path,
			JSON.stringify({ provider: "pao", 档位: [{ 名: "旧档", provider: "a", model: "m", thinkingLevel: "off" }] }),
			"utf8",
		);
		const fixedNow = () => new Date(2026, 9, 3, 14, 5, 6);
		saveTierConfig(path, VALID, fixedNow);
		const backup = `${path}.bak-20261003-140506-000`; // 毫秒定宽三位,字典序=时间序
		expect(existsSync(backup)).toBe(true);
		expect(JSON.parse(readFileSync(backup, "utf8"))).toEqual({
			provider: "pao",
			档位: [{ 名: "旧档", provider: "a", model: "m", thinkingLevel: "off" }],
		});
		const reread = loadTierConfig(path);
		expect(reread.档位.map((t) => t.名)).toEqual(["快", "主力"]);
		expect(reread.部门默认).toEqual({ 测试部: "快" });
	});

	it("首建(旧文件不存在):无备份直接写", () => {
		const dir = tempDir();
		const path = join(dir, "档位.json");
		saveTierConfig(path, VALID);
		expect(loadTierConfig(path).档位).toHaveLength(2);
		expect(readdirSync(dir).filter((f) => f.includes("bak"))).toHaveLength(0);
	});

	it("同一毫秒连改两次:两份备份并存不互盖(序号区分),文件名字典序=时间序", () => {
		const dir = tempDir();
		const path = join(dir, "档位.json");
		writeFileSync(
			path,
			JSON.stringify({ provider: "pao", 档位: [{ 名: "旧档", provider: "a", model: "m", thinkingLevel: "off" }] }),
			"utf8",
		);
		const fixedNow = () => new Date(2026, 9, 3, 14, 5, 6, 789);
		// 第一次写回:旧文件(旧档)进备份;第二次写回:第一次的新内容(快/主力)进备份——秒级时间戳会同名互盖,毫秒+序号不
		saveTierConfig(path, VALID, fixedNow);
		const content2 = JSON.parse(JSON.stringify(VALID)) as typeof VALID;
		content2.档位 = [{ 名: "新档", provider: "a", model: "m2", thinkingLevel: "low" }];
		content2.部门默认 = {}; // 换档集后原部门默认引用的「快」已不存在,不清会被写前自校验拒写
		saveTierConfig(path, content2, fixedNow);
		const backups = readdirSync(dir)
			.filter((f) => f.includes("bak"))
			.sort();
		expect(backups).toEqual(["档位.json.bak-20261003-140506-789", "档位.json.bak-20261003-140506-789-1"]);
		expect(JSON.parse(readFileSync(join(dir, backups[0]!), "utf8")).档位[0].名).toBe("旧档");
		expect(JSON.parse(readFileSync(join(dir, backups[1]!), "utf8")).档位[0].名).toBe("快");
	});

	it("写前自校验:坏结构拒写不落盘不备份", () => {
		const dir = tempDir();
		const path = join(dir, "档位.json");
		writeFileSync(path, JSON.stringify(VALID), "utf8");
		expect(() => saveTierConfig(path, { provider: "pao", 档位: [], 部门默认: { X: "快" } } as never)).toThrow(
			/缺少字段「档位」/,
		);
		expect(JSON.parse(readFileSync(path, "utf8")).档位).toHaveLength(2); // 原文件未动
		expect(readdirSync(dir)).toHaveLength(1); // 无备份
	});
});
