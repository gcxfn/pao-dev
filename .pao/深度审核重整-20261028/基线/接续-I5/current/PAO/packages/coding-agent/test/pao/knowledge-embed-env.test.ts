/**
 * 嵌入配置 .env 惰性加载：文件补齐、env 优先于文件、缺键 null、坏行容忍，
 * 以及安全门——显式传 env 一律不触文件（测试全用 tmpdir 假值 fixture，绝不读真实 .env）。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadEmbedConfig, locateEnvFile, parseEnvFile } from "../../src/pao/knowledge/embed.ts";

// 全部假值，不含任何真实凭证
const FILE_CFG = {
	EMBED_BASE_URL: "https://embed.fixture.invalid/v1",
	EMBED_API_KEY: "file-fake-key-1",
	EMBED_MODEL: "fixture-embed-1",
};

const MANAGED_KEYS = ["EMBED_BASE_URL", "EMBED_API_KEY", "EMBED_MODEL", "PAO_ENV_FILE"] as const;

let tmpDir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "pao-embed-env-"));
	// 清空四个相关键，保证文件路径真的被走到；原值在 afterEach 恢复
	for (const key of MANAGED_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
	for (const key of MANAGED_KEYS) {
		const value = savedEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function writeFixtureEnv(name: string, content: string): string {
	const path = join(tmpDir, name);
	writeFileSync(path, content, "utf8");
	return path;
}

describe("loadEmbedConfig：.env 惰性加载", () => {
	test("env 缺项时由 PAO_ENV_FILE 指向的 .env 补齐（文件补齐）", () => {
		const envPath = writeFixtureEnv(
			".env",
			[
				`EMBED_BASE_URL=${FILE_CFG.EMBED_BASE_URL}`,
				`EMBED_API_KEY=${FILE_CFG.EMBED_API_KEY}`,
				`EMBED_MODEL=${FILE_CFG.EMBED_MODEL}`,
				"",
			].join("\n"),
		);
		process.env.PAO_ENV_FILE = envPath;
		expect(loadEmbedConfig()).toEqual({
			baseUrl: FILE_CFG.EMBED_BASE_URL,
			apiKey: FILE_CFG.EMBED_API_KEY,
			model: FILE_CFG.EMBED_MODEL,
		});
	});

	test("env 与文件同时有值时 env 优先；env 只缺一项时文件只补缺项", () => {
		writeFixtureEnv(
			".env",
			[
				"EMBED_BASE_URL=https://from-file.invalid",
				"EMBED_API_KEY=file-fake-key-2",
				"EMBED_MODEL=from-file-model",
			].join("\n"),
		);
		process.env.PAO_ENV_FILE = join(tmpDir, ".env");
		process.env.EMBED_MODEL = "env-model-wins";
		expect(loadEmbedConfig()).toEqual({
			baseUrl: "https://from-file.invalid",
			apiKey: "file-fake-key-2",
			model: "env-model-wins",
		});
	});

	test("补齐后仍缺键 → null（半配置不猜测）", () => {
		writeFixtureEnv(".env", ["EMBED_BASE_URL=https://partial.invalid", "EMBED_API_KEY=partial-key"].join("\n"));
		process.env.PAO_ENV_FILE = join(tmpDir, ".env");
		expect(loadEmbedConfig()).toBeNull();
	});

	test("坏行容忍：注释、空行、无等号行、引号包裹、无关键全部跳过，三键照常解析", () => {
		writeFixtureEnv(
			".env",
			[
				"# 顶部注释",
				"",
				"   ",
				"这一行没有等号",
				`=空键名`,
				"SOME_OTHER_SECRET=should-not-be-read",
				`EMBED_BASE_URL="${FILE_CFG.EMBED_BASE_URL}"`,
				"EMBED_API_KEY='file-fake-key-3'",
				`  EMBED_MODEL = ${FILE_CFG.EMBED_MODEL}  `,
				"EMBED_TIMEOUT=30",
			].join("\n"),
		);
		process.env.PAO_ENV_FILE = join(tmpDir, ".env");
		expect(loadEmbedConfig()).toEqual({
			baseUrl: FILE_CFG.EMBED_BASE_URL,
			apiKey: "file-fake-key-3",
			model: FILE_CFG.EMBED_MODEL,
		});
	});

	test("安全门：显式传 env 且不设 PAO_ENV_FILE 时，即便 tmpdir 有 .env 也不读（不触文件）", () => {
		// PAO_ENV_FILE 已在 beforeEach 删除；tmpDir 放一份三项齐全的 .env
		writeFixtureEnv(
			".env",
			[
				"EMBED_BASE_URL=https://must-not-be-read.invalid",
				"EMBED_API_KEY=must-not-be-read",
				"EMBED_MODEL=must-not-be-read",
			].join("\n"),
		);
		// 显式空 env：若代码违规读了文件，这里会拿到文件值而非 null
		expect(loadEmbedConfig({})).toBeNull();
		// 显式部分 env：缺 MODEL，即便上溯路径上存在 .env 也不许补
		expect(loadEmbedConfig({ EMBED_BASE_URL: "https://env-only.invalid", EMBED_API_KEY: "env-only-key" })).toBeNull();
		// 显式完整 env：原样返回，与文件无关
		expect(
			loadEmbedConfig({
				EMBED_BASE_URL: "https://env-full.invalid",
				EMBED_API_KEY: "env-full-key",
				EMBED_MODEL: "env-full-model",
			}),
		).toEqual({ baseUrl: "https://env-full.invalid", apiKey: "env-full-key", model: "env-full-model" });
		// 假 .env 确实存在，排除「fixture 没写出来导致假阳性」
		expect(existsSync(join(tmpDir, ".env"))).toBe(true);
	});

	test("PAO_ENV_FILE 指向不存在的文件：以显式路径为准，不回退上溯", () => {
		process.env.PAO_ENV_FILE = join(tmpDir, "nope.env");
		expect(loadEmbedConfig()).toBeNull();
		expect(locateEnvFile({ env: process.env })).toBe(join(tmpDir, "nope.env"));
	});
});

describe("locateEnvFile：可注入定位", () => {
	test("startDir 注入：命中起始目录的 .env", () => {
		const envPath = writeFixtureEnv(".env", "EMBED_MODEL=startdir-marker");
		expect(locateEnvFile({ env: {}, startDir: tmpDir })).toBe(envPath);
	});

	test("startDir 深层子目录逐级上溯，第一个存在的 .env 胜出", () => {
		writeFixtureEnv(".env", "EMBED_MODEL=top-marker");
		mkdirSync(join(tmpDir, "a", "b"), { recursive: true });
		const shallow = join(tmpDir, "a", ".env");
		writeFileSync(shallow, "EMBED_MODEL=shallow-marker", "utf8");
		expect(locateEnvFile({ env: {}, startDir: join(tmpDir, "a", "b") })).toBe(shallow);
		expect(locateEnvFile({ env: {}, startDir: join(tmpDir, "a") })).toBe(shallow);
	});

	test("无任何 .env 可找 → null", () => {
		mkdirSync(join(tmpDir, "empty"), { recursive: true });
		expect(locateEnvFile({ env: {}, startDir: join(tmpDir, "empty") })).toBeNull();
	});
});

describe("parseEnvFile：解析口径", () => {
	test("注释/空行/坏行/引号/无关键", () => {
		const parsed = parseEnvFile(
			[
				"\uFEFF# BOM 后的注释",
				"",
				"NOT_EMBED=value",
				"broken-line",
				"=no-key",
				'EMBED_BASE_URL="https://quoted.invalid"',
				"EMBED_API_KEY='single-quoted'",
				"EMBED_MODEL=bare-model",
			].join("\n"),
		);
		expect(parsed).toEqual({
			EMBED_BASE_URL: "https://quoted.invalid",
			EMBED_API_KEY: "single-quoted",
			EMBED_MODEL: "bare-model",
		});
	});

	test("空值不算已设置（允许被 env 或其他来源补齐）", () => {
		const parsed = parseEnvFile("EMBED_BASE_URL=\nEMBED_MODEL=  \n");
		expect(parsed).toEqual({});
	});
});
