/**
 * EMBED_*→MNEMOSYNE_* 注入验收(2026-10-02 真实接线期修订)。
 * mnemosyne 4.0.0b3 的 API 嵌入只认子进程环境变量,其 config.yaml 嵌入键到不了嵌入代码;
 * 故适配器把知识库嵌入端点(EMBED_* 三键,env→惰性 .env)映射注入:只补缺,配置 env 显式给的
 * 优先;缺嵌入配置不注入、照常启动(供应商侧自行降级 fallback 嵌入)。
 * 全部打在假 stdio 服务器上——启动即把 MNEMOSYNE_* 环境整包落 JSON 文件,不碰真 mnemosyne。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MnemosyneVendor } from "../../src/pao/memory/mnemosyne.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 假 mnemosyne MCP 服务器:握手/列工具最小回包;启动即把 MNEMOSYNE_* 环境落 --pao-env-file */
const FAKE_SERVER_SCRIPT = `
const fs = require("node:fs");
const argv = process.argv.slice(2);
const i = argv.indexOf("--pao-env-file");
if (i >= 0) {
	const dump = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (k.startsWith("MNEMOSYNE_")) dump[k] = v;
	}
	fs.writeFileSync(argv[i + 1], JSON.stringify(dump));
}
process.stdin.setEncoding("utf8");
let buffer = "";
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let idx;
	while ((idx = buffer.indexOf("\\n")) >= 0) {
		const line = buffer.slice(0, idx).trim();
		buffer = buffer.slice(idx + 1);
		if (!line) continue;
		let msg;
		try { msg = JSON.parse(line); } catch { continue; }
		if (msg.method === "initialize") {
			send(msg.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } });
		} else if (msg.method === "tools/list") {
			send(msg.id, { tools: ["mnemosyne_remember", "mnemosyne_recall", "mnemosyne_forget"].map((name) => ({ name, inputSchema: { type: "object" } })) });
		}
	}
});
setInterval(() => {}, 1000);
`;

/** 起一个带注入配置的 vendor,等假服务器把环境落盘,返回解析后的 MNEMOSYNE_* 键值 */
async function startAndDumpEnv(
	params: Record<string, unknown>,
	embedConfig: () => { baseUrl: string; apiKey: string; model: string } | null,
): Promise<Record<string, string>> {
	const dir = mkdtempSync(join(tmpdir(), "pao-mne-embed-"));
	tempDirs.push(dir);
	const script = join(dir, "fake-mnemosyne-mcp.js");
	writeFileSync(script, FAKE_SERVER_SCRIPT, "utf8");
	const envFile = join(dir, "env.json");
	const vendor = new MnemosyneVendor(
		{ command: process.execPath, args: [script, "--pao-env-file", envFile], 请求超时毫秒: 10_000, ...params },
		{ 嵌入配置: embedConfig },
	);
	try {
		await vendor.start();
		return JSON.parse(readFileSync(envFile, "utf8")) as Record<string, string>;
	} finally {
		await vendor.close();
	}
}

describe("EMBED_*→MNEMOSYNE_* 注入(只补缺,配置 env 优先)", () => {
	const config = () => ({ baseUrl: "https://embed.example/v1", apiKey: "k-test-1", model: "BAAI/bge-m3" });

	it("三键齐全:URL/KEY/MODEL 全注入,作者标识照常默认 pao", async () => {
		const dump = await startAndDumpEnv({}, config);
		expect(dump.MNEMOSYNE_EMBEDDING_API_URL).toBe("https://embed.example/v1");
		expect(dump.MNEMOSYNE_EMBEDDING_API_KEY).toBe("k-test-1");
		expect(dump.MNEMOSYNE_EMBEDDING_MODEL).toBe("BAAI/bge-m3");
		expect(dump.MNEMOSYNE_AUTHOR_ID).toBe("pao"); // 共库护栏①不受注入影响
	});

	it("配置 env 显式给的嵌入键优先:MODEL 不被覆盖,DIM 等非密钥键原样透传", async () => {
		const dump = await startAndDumpEnv(
			{ env: { MNEMOSYNE_EMBEDDING_MODEL: "explicit-model", MNEMOSYNE_EMBEDDING_DIM: "1024" } },
			config,
		);
		expect(dump.MNEMOSYNE_EMBEDDING_MODEL).toBe("explicit-model"); // 只补缺,不覆盖
		expect(dump.MNEMOSYNE_EMBEDDING_DIM).toBe("1024");
		expect(dump.MNEMOSYNE_EMBEDDING_API_URL).toBe("https://embed.example/v1"); // 缺的照补
		expect(dump.MNEMOSYNE_EMBEDDING_API_KEY).toBe("k-test-1");
	});

	it("缺嵌入配置(三级链返回 null):不注入 URL/KEY,照常启动", async () => {
		const dump = await startAndDumpEnv({}, () => null);
		// 只断言适配器会注入的两个键:MODEL 可能来自宿主继承(本机就有用户级
		// MNEMOSYNE_EMBEDDING_MODEL——正是「只补缺+配置优先」要对抗的真实情形)
		expect(dump.MNEMOSYNE_EMBEDDING_API_URL).toBeUndefined();
		expect(dump.MNEMOSYNE_EMBEDDING_API_KEY).toBeUndefined();
		expect(dump.MNEMOSYNE_AUTHOR_ID).toBe("pao");
	});
});
