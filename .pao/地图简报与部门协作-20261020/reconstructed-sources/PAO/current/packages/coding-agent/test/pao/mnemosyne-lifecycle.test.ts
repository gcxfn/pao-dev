/**
 * mnemosyne 适配器生命周期验收（M2-05）:全部打在自起的假 MCP stdio 服务器上
 * (node 子进程按 JSON-RPC over stdio 回包,不装任何包、不碰真 mnemosyne/Hermes)。
 * 验:起(initialize 握手＋pid 在)→列工具(能力声明按服务器清单定)→调一轮记忆写读→
 * shutdown 停树(连孙进程)→起不来降级(ENOENT/握手挂起/工具清单缺)→坏配置降级(接线层)。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { registerMemory } from "../../src/pao/memory/index.ts";
import { MemoryVendorManager } from "../../src/pao/memory/memory-vendor.ts";
import { MnemosyneVendor } from "../../src/pao/memory/mnemosyne.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-mnemosyne-"));
	tempDirs.push(dir);
	return dir;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitUntil(fn: () => boolean, timeoutMs = 10000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start <= timeoutMs) {
		if (fn()) return true;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return fn();
}

/**
 * 假 mnemosyne MCP 服务器:stdio 上按行收发 JSON-RPC。
 * 记忆工具参数和 text JSON 返回对齐本机 tool_schemas.py / mcp_tools.py / mcp_server.py；
 * 没有 isError 的业务错误也原样模拟，不能用 imagined structuredContent 替代真实协议。
 * 默认 stdin 关了也不退(setInterval 挂住)——让 transport 的停树路径真的走一遍;
 * --pao-grandchild-pid-file 给了就再 spawn 一个挂住的孙进程(验树杀);
 * --pao-env-file 给了就落 MNEMOSYNE_AUTHOR_ID(验共库作者标识护栏);--pao-hang-init 收到 initialize 不回包。
 */
const FAKE_SERVER_SCRIPT = `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf("--" + name); return i >= 0 ? argv[i + 1] : dflt; };
const tools = (arg("pao-tools", "mnemosyne_remember,mnemosyne_recall,mnemosyne_forget")).split(",").filter(Boolean);
const forcedReply = arg("pao-reply");
const storeFile = arg("pao-store-file");
const pidFile = arg("pao-pid-file");
if (pidFile) fs.writeFileSync(pidFile, String(process.pid));
const gcPidFile = arg("pao-grandchild-pid-file");
if (gcPidFile) {
	const gc = spawn(process.execPath, ["-e", "setInterval(()=>{},500)"], { stdio: "ignore" });
	fs.writeFileSync(gcPidFile, String(gc.pid));
}
const envFile = arg("pao-env-file");
if (envFile) fs.writeFileSync(envFile, String(process.env.MNEMOSYNE_AUTHOR_ID || ""));
const hangInit = argv.includes("--pao-hang-init");
const state = { items: [] };
if (storeFile && fs.existsSync(storeFile)) { try { state.items = JSON.parse(fs.readFileSync(storeFile, "utf8")); } catch {} }
const respond = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
const save = () => { if (storeFile) fs.writeFileSync(storeFile, JSON.stringify(state.items)); };
const handle = (msg) => {
	if (msg.method === "initialize") {
		if (hangInit) return; // 挂起:握手超时路径
		respond(msg.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-mnemosyne", version: "0.0.1" } });
		return;
	}
	if (msg.method === "tools/list") {
		respond(msg.id, { tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })) });
		return;
	}
	if (msg.method === "tools/call") {
		const name = msg.params.name;
		const a = msg.params.arguments || {};
		const reply = (payload) => respond(msg.id, { isError: false, content: [{ type: "text", text: JSON.stringify(payload) }] });
		if (forcedReply) { reply(JSON.parse(forcedReply)); return; }
		if (name === "mnemosyne_remember") {
			const id = "mem-" + String(state.items.length + 1).padStart(3, "0");
			state.items.push({ id, content: a.content, metadata: a.metadata || {} });
			save();
			reply({ status: "stored", memory_id: id, content_preview: a.content.slice(0, 100), bank: "personal" });
			return;
		}
		if (name === "mnemosyne_recall") {
			const q = String(a.query || "");
			const hits = state.items.filter((it) => it.content.includes(q)).slice(0, a.limit || 3)
				.map((it, i) => ({ id: it.id, content: it.content, score: Number((1 - i * 0.1).toFixed(2)), source: "mcp" }));
			reply({ status: "ok", count: hits.length, results: hits, bank: "personal" });
			return;
		}
		if (name === "mnemosyne_forget") {
			if (!a.memory_id) { reply({ error: "memory_id is required" }); return; }
			const before = state.items.length;
			state.items = state.items.filter((it) => it.id !== a.memory_id);
			const deleted = before - state.items.length;
			save();
			reply({ status: deleted ? "deleted" : "not_found", memory_id: a.memory_id });
			return;
		}
		respond(msg.id, { isError: true, content: [{ type: "text", text: "查无此工具:" + name }] });
	}
};
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let idx;
	while ((idx = buffer.indexOf("\\n")) >= 0) {
		const line = buffer.slice(0, idx).trim();
		buffer = buffer.slice(idx + 1);
		if (line) { try { handle(JSON.parse(line)); } catch {} }
	}
});
setInterval(() => {}, 1000); // 不随 stdin 端退出:关闭一律走停树
`;

interface FakeServerHandle {
	script: string;
	pidFile: string;
	gcPidFile: string;
	storeFile: string;
	envFile: string;
	args: string[];
}

function startFakeServer(
	dir: string,
	options: { tools?: string; grandchild?: boolean; hangInit?: boolean; reply?: Record<string, unknown> } = {},
): FakeServerHandle {
	const script = join(dir, "fake-mnemosyne-mcp.js");
	writeFileSync(script, FAKE_SERVER_SCRIPT, "utf8");
	const handle: FakeServerHandle = {
		script,
		pidFile: join(dir, "server.pid"),
		gcPidFile: join(dir, "grandchild.pid"),
		storeFile: join(dir, "记忆库.json"),
		envFile: join(dir, "env.txt"),
		args: [
			script,
			"--pao-tools",
			options.tools ?? "mnemosyne_remember,mnemosyne_recall,mnemosyne_forget",
			"--pao-store-file",
			join(dir, "记忆库.json"),
			"--pao-pid-file",
			join(dir, "server.pid"),
			"--pao-env-file",
			join(dir, "env.txt"),
			...(options.grandchild ? ["--pao-grandchild-pid-file", join(dir, "grandchild.pid")] : []),
			...(options.hangInit ? ["--pao-hang-init"] : []),
			...(options.reply ? ["--pao-reply", JSON.stringify(options.reply)] : []),
		],
	};
	return handle;
}

function mnemosyneParams(handle: FakeServerHandle, timeoutMs = 10000) {
	return {
		command: process.execPath,
		args: handle.args,
		请求超时毫秒: timeoutMs,
	};
}

describe("mnemosyne 适配器:起、列工具、写读一轮", () => {
	it.each([
		{ reply: { status: "filtered", bank: "personal" }, error: "未写入记忆库" },
		{ reply: { error: "write failed" }, error: "write failed" },
		{ reply: { status: "stored" }, error: "不能确认写入成功" },
	])("写入状态 $reply 不得当成功", async ({ reply, error }) => {
		const handle = startFakeServer(tempDir(), { reply });
		const vendor = new MnemosyneVendor(mnemosyneParams(handle), { 嵌入配置: () => null });
		try {
			await vendor.start();
			await expect(vendor.write("模拟事实")).rejects.toThrow(error);
		} finally {
			await vendor.close();
		}
	});

	it("普通业务 error 未设 isError：召回与忘却都显式失败，不伪造命中或零删除", async () => {
		const handle = startFakeServer(tempDir(), { reply: { error: "memory_id is required" } });
		const vendor = new MnemosyneVendor(mnemosyneParams(handle), { 嵌入配置: () => null });
		try {
			await vendor.start();
			await expect(vendor.recall("模拟查询")).rejects.toThrow("memory_id is required");
			await expect(vendor.forget("mem-123")).rejects.toThrow("memory_id is required");
		} finally {
			await vendor.close();
		}
	});

	it("initialize 握手＋列工具→写入落盘→召回带相关度→忘却清条;作者标识默认 pao", async () => {
		const dir = tempDir();
		const handle = startFakeServer(dir);
		const vendor = new MnemosyneVendor(mnemosyneParams(handle), { 嵌入配置: () => null });

		await vendor.start(); // 起:spawn＋initialize＋notifications/initialized
		expect(vendor.pid).toBeTypeOf("number");
		expect(alive(vendor.pid!)).toBe(true);
		expect(vendor.capabilities).toEqual({ 语义检索: true, 需嵌入端点: true, 忘却: true }); // 列工具:忘却按服务器清单声明;嵌入端点经 EMBED_* 注入(真实接线期修订)

		await vendor.write("用户偏好深色主题", ["偏好"]); // 调一轮记忆写
		const stored = JSON.parse(readFileSync(handle.storeFile, "utf8")) as {
			id: string;
			content: string;
			metadata: { tags: string[] };
		}[];
		expect(stored).toEqual([{ id: "mem-001", content: "用户偏好深色主题", metadata: { tags: ["偏好"] } }]);
		expect(readFileSync(handle.envFile, "utf8")).toBe("pao"); // 共库护栏①:作者标识不经配置也默认带上

		const hits = await vendor.recall("深色"); // 读
		expect(hits).toHaveLength(1);
		expect(hits[0]!.内容).toBe("用户偏好深色主题");
		expect(hits[0]!.相关度).toBeTypeOf("number");
		expect(hits[0]!.记忆ID).toBe("mem-001");
		expect(hits[0]!.来源).toBe("mcp");
		expect(await vendor.recall("不存在词")).toEqual([]);

		expect(await vendor.forget("mem-不存在-123")).toBe(0);
		expect(await vendor.recall("深色")).toHaveLength(1); // 不按检索词或数字匹配批删
		expect(await vendor.forget(hits[0]!.记忆ID!)).toBe(1);
		expect(await vendor.recall("深色")).toEqual([]);
		expect(vendor.capabilities.忘却).toBe(true);

		await vendor.close(); // shutdown
		expect(await waitUntil(() => !alive(vendor.pid!))).toBe(true);
	});

	it("服务器不提供忘却工具 → 能力.忘却=false,忘却调用如实拒绝", async () => {
		const dir = tempDir();
		const handle = startFakeServer(dir, { tools: "mnemosyne_remember,mnemosyne_recall" });
		const vendor = new MnemosyneVendor(mnemosyneParams(handle));
		await vendor.start();
		expect(vendor.capabilities.忘却).toBe(false);
		await expect(vendor.forget("任意")).rejects.toThrow(/未提供忘却工具/);
		await vendor.close();
	});
});

describe("shutdown 停树:server 挂住不退也要连孙进程一起停", () => {
	it("关闭后 server 与孙进程都真停(树杀,不靠 stdin 端的自觉)", async () => {
		const dir = tempDir();
		const handle = startFakeServer(dir, { grandchild: true });
		const vendor = new MnemosyneVendor(mnemosyneParams(handle));
		await vendor.start();
		expect(await waitUntil(() => existsSync(handle.gcPidFile))).toBe(true);
		const serverPid = vendor.pid!;
		const gcPid = Number.parseInt(readFileSync(handle.gcPidFile, "utf8").trim(), 10);
		expect(alive(serverPid)).toBe(true);
		expect(alive(gcPid)).toBe(true);

		await vendor.close();
		expect(await waitUntil(() => !alive(serverPid) && !alive(gcPid))).toBe(true);
		expect(vendor.pid).toBeUndefined(); // 关闭幂等的基础:状态已清
		await vendor.close(); // 幂等,不抛
	});
});

describe("起不来降级:不阻断会话,降级为无记忆", () => {
	it("命令不存在(ENOENT) → 管理器降级,本会话不再重试", async () => {
		const warnings: string[] = [];
		const manager = new MemoryVendorManager(
			{ 供应商: "mnemosyne", 参数: { command: "pao-没有这个命令-xyz", args: ["mcp"] } },
			(message) => warnings.push(message),
		);
		await expect(manager.acquire()).resolves.toBeUndefined();
		expect(manager.status).toBe("已降级");
		expect(manager.degradeReason).toContain("启动失败");
		expect(manager.degradeReason).toContain("pao-没有这个命令-xyz");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("已降级为无记忆(会话不受影响)");
		await expect(manager.acquire()).resolves.toBeUndefined(); // 短路,不反复 spawn
		expect(warnings).toHaveLength(1);
	});

	it("initialize 挂起 → 请求超时,同样降级", async () => {
		const dir = tempDir();
		const handle = startFakeServer(dir, { hangInit: true });
		const warnings: string[] = [];
		const manager = new MemoryVendorManager({ 供应商: "mnemosyne", 参数: mnemosyneParams(handle, 1500) }, (message) =>
			warnings.push(message),
		);
		await expect(manager.acquire()).resolves.toBeUndefined();
		expect(manager.status).toBe("已降级");
		expect(manager.degradeReason).toContain("启动失败");
		expect(warnings[0]).toContain("启动失败");
	});

	it("工具清单缺写入工具 → 启动失败降级,报错列出实际工具", async () => {
		const dir = tempDir();
		const handle = startFakeServer(dir, { tools: "mnemosyne_recall" });
		const warnings: string[] = [];
		const manager = new MemoryVendorManager({ 供应商: "mnemosyne", 参数: mnemosyneParams(handle) }, (message) =>
			warnings.push(message),
		);
		await expect(manager.acquire()).resolves.toBeUndefined();
		expect(manager.status).toBe("已降级");
		expect(manager.degradeReason).toContain("缺工具「mnemosyne_remember」");
		expect(manager.degradeReason).toContain("mnemosyne_recall");
		expect(warnings).toHaveLength(1);
	});
});

describe("接线(registerMemory):缺文件静默、坏配置警告降级、正常注册带停树钩子", () => {
	function fakePi() {
		const tools: {
			name: string;
			execute: (
				...args: unknown[]
			) => Promise<{ content: { type: "text"; text: string }[]; details?: unknown; isError?: boolean }>;
		}[] = [];
		const handlers = new Map<string, () => unknown>();
		const pi = {
			registerTool: (tool: {
				name: string;
				execute: (
					...args: unknown[]
				) => Promise<{ content: { type: "text"; text: string }[]; details?: unknown; isError?: boolean }>;
			}) => {
				tools.push(tool);
			},
			on: (event: string, handler: () => unknown) => {
				handlers.set(event, handler);
				return () => {};
			},
		} as unknown as ExtensionAPI;
		return { pi, tools, handlers };
	}

	function configDir(body: string | undefined): string {
		const dir = tempDir();
		mkdirSync(join(dir, "pao配置"), { recursive: true });
		if (body !== undefined) {
			writeFileSync(join(dir, "pao配置", "记忆供应商.json"), body, "utf8");
		}
		return dir;
	}

	it("缺配置文件 → 不装任何工具,零警告(不启用记忆,静默)", () => {
		const dir = configDir(undefined);
		const warnings: string[] = [];
		const { pi, tools } = fakePi();
		registerMemory(pi, {
			resolveConfigPath: () => join(dir, "pao配置", "记忆供应商.json"),
			onWarn: (m) => warnings.push(m),
		});
		expect(tools).toEqual([]);
		expect(warnings).toEqual([]);
	});

	it("坏配置(坏 JSON) → 结构化警告＋不装工具,不抛错", () => {
		const dir = configDir("{ 供应商: ");
		const warnings: string[] = [];
		const { pi, tools } = fakePi();
		expect(() =>
			registerMemory(pi, {
				resolveConfigPath: () => join(dir, "pao配置", "记忆供应商.json"),
				onWarn: (m) => warnings.push(m),
			}),
		).not.toThrow();
		expect(tools).toEqual([]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("[pao]");
		expect(warnings[0]).toContain("已降级为无记忆");
		expect(warnings[0]).toContain("记忆供应商.json");
	});

	it("配置指向未注册供应商 → 同款警告降级", () => {
		const dir = configDir(JSON.stringify({ 供应商: "查无此厂" }));
		const warnings: string[] = [];
		const { pi, tools } = fakePi();
		registerMemory(pi, {
			resolveConfigPath: () => join(dir, "pao配置", "记忆供应商.json"),
			onWarn: (m) => warnings.push(m),
		});
		expect(tools).toEqual([]);
		expect(warnings[0]).toContain("查无此厂");
	});

	it("正常配置 → 三工具＋session_shutdown 停树钩子;工具全链路落到假服务器", async () => {
		const dir = tempDir();
		const handle = startFakeServer(dir);
		const configPath = join(dir, "pao配置", "记忆供应商.json");
		mkdirSync(join(dir, "pao配置"), { recursive: true });
		writeFileSync(configPath, JSON.stringify({ 供应商: "mnemosyne", 参数: mnemosyneParams(handle) }), "utf8");
		const warnings: string[] = [];
		const { pi, tools, handlers } = fakePi();
		registerMemory(pi, {
			resolveConfigPath: () => configPath,
			onWarn: (m) => warnings.push(m),
			outbound: { projects: { [basename(dir)]: { allowed: true, asOf: "2099-12-31" } } },
		});
		expect(warnings).toEqual([]);
		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"pao_memory_forget",
			"pao_memory_recall",
			"pao_memory_write",
		]);
		expect(handlers.has("session_shutdown")).toBe(true);

		// 全链路:注册工具 → 惰性拉起假 mnemosyne → 写入 → 召回 → 按 ID 忘却
		const write = tools.find((tool) => tool.name === "pao_memory_write")!;
		const recall = tools.find((tool) => tool.name === "pao_memory_recall")!;
		const forget = tools.find((tool) => tool.name === "pao_memory_forget")!;
		const writeResult = await write.execute("t1", { content: "用户在杭州,通勤地铁" } as never, undefined, undefined, {
			cwd: dir,
		} as never);
		expect(writeResult.content[0]!.text).toContain("已写入");
		const recallResult = await recall.execute("t2", { query: "杭州" } as never, undefined, undefined, {
			cwd: dir,
		} as never);
		expect(recallResult.content[0]!.text).toContain("杭州");
		expect(recallResult.content[0]!.text).toContain("非用户输入"); // 防污染标注(§18.4)
		expect(recallResult.content[0]!.text).toContain("记忆ID mem-001");
		const missing = await forget.execute("t3", { memory_id: "mem-不存在-123", confirm: true });
		expect(missing.content[0]!.text).toContain("未删除任何记忆");
		const forgotten = await forget.execute("t4", { memory_id: "mem-001", confirm: true });
		expect(forgotten.content[0]!.text).toContain("已忘却 1 条");
		expect(JSON.parse(readFileSync(handle.storeFile, "utf8"))).toEqual([]);

		// 会话停:树杀假服务器
		const serverPid = Number.parseInt(readFileSync(handle.pidFile, "utf8").trim(), 10);
		expect(alive(serverPid)).toBe(true);
		await handlers.get("session_shutdown")!();
		expect(await waitUntil(() => !alive(serverPid))).toBe(true);
	}, 20000);

	it("未许可项目即使传绑定项目也不启动供应商；许可撤销后每次调用重新检查", async () => {
		const dir = tempDir();
		const handle = startFakeServer(dir);
		const configPath = join(dir, "pao配置", "记忆供应商.json");
		const outboundPath = join(dir, "知识库配置", "外发许可.json");
		mkdirSync(join(dir, "pao配置"), { recursive: true });
		mkdirSync(join(dir, "知识库配置"), { recursive: true });
		writeFileSync(configPath, JSON.stringify({ 供应商: "mnemosyne", 参数: mnemosyneParams(handle) }));
		writeFileSync(
			outboundPath,
			JSON.stringify({ projects: { [basename(dir)]: { allowed: true, asOf: "2099-12-31" } } }),
		);
		const { pi, tools, handlers } = fakePi();
		registerMemory(pi, { resolvePaoHome: () => dir });
		const write = tools.find((tool) => tool.name === "pao_memory_write")!;
		const recall = tools.find((tool) => tool.name === "pao_memory_recall")!;
		try {
			const blocked = await write.execute(
				"blocked",
				{ 内容: "模拟事实", 绑定项目: basename(dir) },
				undefined,
				undefined,
				{ cwd: join(dir, "别的项目") },
			);
			expect(blocked.isError).toBe(true);
			expect(blocked.content[0].text).toContain("禁外发");
			expect(existsSync(handle.pidFile)).toBe(false);
			const allowed = await write.execute("allowed", { content: "模拟事实" }, undefined, undefined, { cwd: dir });
			expect(allowed.content[0].text).toContain("已写入");
			writeFileSync(outboundPath, JSON.stringify({ projects: {} }));
			const revoked = await recall.execute("revoked", { query: "模拟事实" }, undefined, undefined, { cwd: dir });
			expect(revoked.isError).toBe(true);
			expect(revoked.content[0].text).toContain("未调用记忆供应商");
		} finally {
			await handlers.get("session_shutdown")!();
		}
	});

	it("供应商过滤写入时，公共工具显式报失败，不返回已写入", async () => {
		const dir = tempDir();
		const handle = startFakeServer(dir, { reply: { status: "filtered", bank: "personal" } });
		const configPath = join(dir, "pao配置", "记忆供应商.json");
		mkdirSync(join(dir, "pao配置"), { recursive: true });
		writeFileSync(configPath, JSON.stringify({ 供应商: "mnemosyne", 参数: mnemosyneParams(handle) }));
		const { pi, tools, handlers } = fakePi();
		registerMemory(pi, {
			resolveConfigPath: () => configPath,
			outbound: { projects: { [basename(dir)]: { allowed: true, asOf: "2099-12-31" } } },
		});
		try {
			const result = await tools
				.find((tool) => tool.name === "pao_memory_write")!
				.execute("filtered", { content: "模拟事实" }, undefined, undefined, { cwd: dir });
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("未写入记忆库");
			expect(result.content[0].text).not.toContain("已写入记忆库");
		} finally {
			await handlers.get("session_shutdown")!();
		}
	});

	it("控制组:无关进程不受停树影响", async () => {
		const control = spawn(process.execPath, ["-e", "setInterval(()=>{},500)"], { stdio: "ignore" });
		const dir = tempDir();
		const handle = startFakeServer(dir);
		const vendor = new MnemosyneVendor(mnemosyneParams(handle));
		await vendor.start();
		await vendor.close();
		expect(await waitUntil(() => !alive(vendor.pid!))).toBe(true);
		expect(alive(control.pid!)).toBe(true);
		control.kill(); // 收尾控制进程(不经被测代码,只保本测试不漏进程)
	});
});
