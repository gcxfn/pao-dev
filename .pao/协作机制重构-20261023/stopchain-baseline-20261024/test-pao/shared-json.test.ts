import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseJsonRaw, readJsonRaw, readJsonSafe, stripUtf8Bom } from "../../src/pao/shared/json.ts";

/**
 * 公共 JSON 读取口(shared/json.ts):BOM 三态(有/无/坏 JSON)× 两种容错语义
 * (readJsonRaw throw 型 / readJsonSafe 容错型)。注入形状与生产线一致:
 * 读文件用 保温.json 的形状(host/config.ts 消费),解析文本用 档位.json 的形状(routing/config.ts 消费)。
 */

const tempDirs: string[] = [];

// Windows 下句柄释放有延迟,rmSync 可能 EPERM——清理尽力而为,不让收尾失败连累已通过的断言
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
	const dir = mkdtempSync(join(tmpdir(), `pao-shared-json-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

/** 保温.json 形状(与 host/config.ts 的 WarmConfig 消费面一致) */
const WARM_SHAPE = JSON.stringify({ 空闲分钟: 30, 部门并发上限: 5 });
/** 档位.json 形状(与 routing/config.ts 的 TierConfig 消费面一致) */
const TIER_SHAPE = JSON.stringify({
	provider: "pao",
	档位: [{ 名: "快", provider: "pao", model: "glm-flash", thinkingLevel: "low" }],
});

function writeConfig(dir: string, name: string, body: string): string {
	mkdirSync(join(dir, "pao配置"), { recursive: true });
	const file = join(dir, "pao配置", name);
	writeFileSync(file, body, "utf8");
	return file;
}

describe("stripUtf8Bom:只剥首字符 BOM,无 BOM 逐字节不变", () => {
	it("有 BOM 剥掉,无 BOM 原样,正文中间的 U+FEFF 不动", () => {
		expect(stripUtf8Bom('\uFEFF{"a":1}')).toBe('{"a":1}');
		expect(stripUtf8Bom('{"a":1}')).toBe('{"a":1}');
		expect(stripUtf8Bom('{"a":"\uFEFF"}')).toBe('{"a":"\uFEFF"}');
	});
});

describe("parseJsonRaw:BOM 容错,坏 JSON 原样抛", () => {
	it("无 BOM / 有 BOM 都解析出同一对象", () => {
		expect(parseJsonRaw(TIER_SHAPE)).toEqual(JSON.parse(TIER_SHAPE));
		expect(parseJsonRaw(`\uFEFF${TIER_SHAPE}`)).toEqual(JSON.parse(TIER_SHAPE));
	});

	it("坏 JSON 抛 SyntaxError(调用方按原语义包装,不吞)", () => {
		expect(() => parseJsonRaw("{ 不是 JSON")).toThrow(SyntaxError);
	});
});

describe("readJsonRaw(throw 型):读不到/坏 JSON 都抛,分型归调用方", () => {
	it("文件不存在抛 ENOENT", () => {
		expect(() => readJsonRaw(join(tempDir("missing"), "pao配置", "档位.json"))).toThrow(/ENOENT/);
	});

	it("文件存在(含 BOM)解析成功;坏 JSON 抛", () => {
		const dir = tempDir("raw");
		const file = writeConfig(dir, "档位.json", `\uFEFF${TIER_SHAPE}`);
		expect(readJsonRaw(file)).toEqual(JSON.parse(TIER_SHAPE));
		const bad = writeConfig(tempDir("raw-bad"), "档位.json", "{ 不是 JSON");
		expect(() => readJsonRaw(bad)).toThrow(SyntaxError);
	});
});

describe("readJsonSafe(容错型):任何失败返回 undefined,不打崩调用方", () => {
	it("文件存在且合法 → 返回解析对象(形状与保温.json 一致)", () => {
		const file = writeConfig(tempDir("safe-ok"), "保温.json", WARM_SHAPE);
		const parsed = readJsonSafe(file) as Record<string, unknown>;
		expect(parsed.空闲分钟).toBe(30);
		expect(parsed.部门并发上限).toBe(5);
	});

	it("文件带 BOM → 照常解析,不再误判损坏", () => {
		const file = writeConfig(tempDir("safe-bom"), "保温.json", `\uFEFF${WARM_SHAPE}`);
		const parsed = readJsonSafe(file) as Record<string, unknown>;
		expect(parsed.空闲分钟).toBe(30);
	});

	it("文件不存在 / 坏 JSON / 空文件 → undefined(不区分缺失与坏,需要区分用 readJsonRaw)", () => {
		expect(readJsonSafe(join(tempDir("safe-missing"), "pao配置", "保温.json"))).toBeUndefined();
		const bad = writeConfig(tempDir("safe-bad"), "保温.json", "{ 不是 JSON");
		expect(readJsonSafe(bad)).toBeUndefined();
		const empty = writeConfig(tempDir("safe-empty"), "保温.json", "");
		expect(readJsonSafe(empty)).toBeUndefined();
	});
});
