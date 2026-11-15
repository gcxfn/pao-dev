/**
 * gbrain 适配器生命周期验收（M2-05,2026-10-03 切换）:全部打在自起的假 MCP HTTP 服务器上
 * (node:http 按真实探针行为回包:POST /mcp＋Bearer、initialize 200/2025-03-26、无 session、
 * notifications 204、工具结果＝JSON.stringify 进 content[0]、空召回追加第二 text 块、
 * 忘却不存在的 ID 回 JSON-RPC error)。不碰真 gbrain 容器/真 token/真实 .env。
 * 验:参数解析→token 三级链(env 优先/显式 env 不触文件/PAO_ENV_FILE 文件补缺)→
 * 起(握手＋工具清单→能力)→写读忘一轮(duplicate 幂等/已过期=0/未知 ID 报错)→
 * 起不来降级(401/超时/缺工具/缺 token/拒连)→接线(registerMemory)三工具全链路。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { GbrainVendor, loadGbrainToken, resolveGbrainParams } from "../../src/pao/memory/gbrain.ts";
import { registerMemory } from "../../src/pao/memory/index.ts";
import { type MemoryVendorConfig, MemoryVendorManager } from "../../src/pao/memory/memory-vendor.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-gbrain-"));
	tempDirs.push(dir);
	return dir;
}

/** 假服务器的记忆事实(in-memory;fact_id 从 1 递增,与真实探针同形状) */
interface FakeFact {
	factId: string;
	fact: string;
	provenance: string;
	expired: boolean;
}

interface FakeGbrainCall {
	name: string;
	args: Record<string, unknown>;
}

interface FakeGbrainHandle {
	port: number;
	server: Server;
	/** 服务器收到的 tools/call 记录(断言参数用) */
	calls: FakeGbrainCall[];
	/** 服务器收到的 JSON-RPC 方法记录(断言不会覆盖未清理连接) */
	methods: string[];
	close(): Promise<void>;
}

/**
 * 起假 gbrain MCP HTTP 服务器:按真实探针(2026-10-03)逐项对齐协议行为。
 * token 不符回 401;hangInitialize 收到 initialize 不回包(超时路径);
 * tools 定制工具清单(缺 remember/缺 forget 路径);duplicateOnSameFact 开时
 * 同文重复写入回 status=duplicate(幂等契约);忘却按 expired 状态机回
 * expired:true/false,未知 ID 回 JSON-RPC error(真实 not_found 语义)。
 */
function startFakeGbrain(
	opts: { token?: string; tools?: string[]; hangInitialize?: boolean; duplicateOnSameFact?: boolean } = {},
): Promise<FakeGbrainHandle> {
	const expectedToken = opts.token ?? "test-token";
	const tools = opts.tools ?? ["remember", "recall", "forget", "search"];
	const facts: FakeFact[] = [];
	const calls: FakeGbrainCall[] = [];
	const methods: string[] = [];
	let nextFactId = 1;

	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			if (req.headers.authorization !== `Bearer ${expectedToken}`) {
				res.writeHead(401, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: "unauthorized" }));
				return;
			}
			const message = JSON.parse(body) as { id?: number | string; method: string; params?: Record<string, unknown> };
			methods.push(message.method);
			const reply = (payload: unknown) => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify(payload));
			};
			if (message.id === undefined) {
				// notifications/initialized 等通知:真实服务器回 204
				res.writeHead(204);
				res.end();
				return;
			}
			if (message.method === "initialize") {
				if (opts.hangInitialize) return; // 不回包,超时路径
				reply({
					jsonrpc: "2.0",
					id: message.id,
					result: {
						protocolVersion: "2025-03-26",
						capabilities: {},
						serverInfo: { name: "fake-gbrain", version: "0.0.0" },
					},
				});
				return;
			}
			if (message.method === "tools/list") {
				reply({
					jsonrpc: "2.0",
					id: message.id,
					result: {
						tools: tools.map((name) => ({
							name,
							description: "",
							inputSchema: { type: "object", properties: {} }, // pi-mcp 校验必带
						})),
					},
				});
				return;
			}
			if (message.method === "tools/call") {
				const name = String(message.params?.name ?? "");
				const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
				calls.push({ name, args });
				const toolResult = (payload: unknown, extraBlocks: string[] = []) => {
					reply({
						jsonrpc: "2.0",
						id: message.id,
						result: {
							content: [
								{ type: "text", text: JSON.stringify(payload, null, 2) },
								...extraBlocks.map((text) => ({ type: "text", text })),
							],
						},
					});
				};
				if (name === "remember") {
					const fact = String(args.fact ?? "");
					const existing = facts.find((f) => f.fact === fact && !f.expired);
					if (existing && opts.duplicateOnSameFact) {
						toolResult({
							id: existing.factId,
							status: "duplicate",
							status_text: "Already remembered.",
							entity_slug: null,
							valid_until: null,
							protocol_version: 1,
						});
						return;
					}
					const factId = String(nextFactId++);
					facts.push({ factId, fact, provenance: String(args.provenance ?? ""), expired: false });
					toolResult({
						id: factId,
						status: "inserted",
						status_text: "Stored.",
						entity_slug: null,
						valid_until: null,
						protocol_version: 1,
					});
					return;
				}
				if (name === "recall") {
					const query = String(args.query ?? "");
					const limit = typeof args.limit === "number" ? args.limit : 50;
					const hit = facts
						.filter((f) => !f.expired && (query === "" || f.fact.includes(query) || query.includes(f.fact)))
						.slice(0, limit)
						.map((f) => ({
							id: Number(f.factId),
							fact_id: f.factId,
							fact: f.fact,
							kind: "fact",
							entity_slug: null,
							provenance: f.provenance,
							valid_until: null,
							visibility: "world",
						}));
					// 空召回追加第二个 text 块(真实 D8 行为,钉住适配器的首段 JSON 截取)
					toolResult(
						{ facts: hit, total: hit.length, protocol_version: 1 },
						hit.length === 0 ? ["(空检索诊断)没有任何事实匹配该查询。"] : [],
					);
					return;
				}
				if (name === "forget") {
					const id = String(args.id ?? "");
					const target = facts.find((f) => f.factId === id);
					if (!target) {
						reply({
							jsonrpc: "2.0",
							id: message.id,
							error: { code: -32602, message: `not_found: no fact with id ${id}` },
						});
						return;
					}
					const wasActive = !target.expired;
					target.expired = true;
					toolResult({ id, expired: wasActive, reason: null, protocol_version: 1 });
					return;
				}
				reply({
					jsonrpc: "2.0",
					id: message.id,
					error: { code: -32602, message: `unknown tool: ${name}` },
				});
				return;
			}
			reply({
				jsonrpc: "2.0",
				id: message.id,
				error: { code: -32601, message: `unknown method ${message.method}` },
			});
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as { port: number }).port;
			resolve({
				port,
				server,
				calls,
				methods,
				close: () =>
					new Promise<void>((done) => {
						server.closeAllConnections?.();
						server.close(() => done());
					}),
			});
		});
	});
}

/** 构造指向假服务器的供应商(token 固定注入——测试绝不走默认 .env 链,不碰真实密钥) */
function vendorTo(handle: FakeGbrainHandle, params: Record<string, unknown> = {}): GbrainVendor {
	return new GbrainVendor({ base_url: `http://127.0.0.1:${handle.port}`, ...params }, { token加载: TOKEN_INJECTED });
}

const TOKEN_INJECTED = () => "test-token";

describe("参数解析:缺省全给,坏参数结构化报错", () => {
	it("缺省参数＝本机 Docker 地址＋GBRAIN_TOKEN＋pao 前缀＋30s 超时;尾斜杠剥掉", () => {
		const resolved = resolveGbrainParams({ base_url: "http://127.0.0.1:7333/" });
		expect(resolved.baseUrl).toBe("http://127.0.0.1:7333");
		expect(resolved.tokenEnv).toBe("GBRAIN_TOKEN");
		expect(resolved.来源标识).toBe("pao");
		expect(resolved.requestTimeoutMs).toBe(30000);
		expect(resolveGbrainParams(undefined).baseUrl).toBe("http://127.0.0.1:7333");
	});

	it("非 http(s) 地址/非对象/空字符串/非正数超时 → 中文报错", () => {
		expect(() => resolveGbrainParams("http://x")).toThrow("gbrain 参数应为对象");
		expect(() => resolveGbrainParams({ base_url: "ftp://x" })).toThrow("http(s)");
		expect(() => resolveGbrainParams({ base_url: "  " })).toThrow("base_url");
		expect(() => resolveGbrainParams({ 请求超时毫秒: -1 })).toThrow("请求超时毫秒");
		expect(() => resolveGbrainParams({ token环境变量: 3 })).toThrow("token环境变量");
	});
});

describe("token 三级链:env 优先、显式 env 不触文件、PAO_ENV_FILE 文件补缺", () => {
	it("env 现值优先;显式 env 记录缺键＝null,绝不触文件系统", () => {
		expect(loadGbrainToken("K", { K: "v" })).toBe("v");
		expect(loadGbrainToken("K", {})).toBeNull();
		expect(loadGbrainToken("K", { K: "  " })).toBeNull();
	});

	it("生产路径(env 缺省＝process.env)经 PAO_ENV_FILE 读临时文件;容忍引号与注释", () => {
		const dir = tempDir();
		const envFile = join(dir, ".env");
		writeFileSync(envFile, '# 注释\nGBRAIN_TEST_PLAIN=from-file\nGBRAIN_TEST_QUOTED="quoted value"\n', "utf8");
		const savedFile = process.env.PAO_ENV_FILE;
		delete process.env.GBRAIN_TEST_PLAIN;
		delete process.env.GBRAIN_TEST_QUOTED;
		process.env.PAO_ENV_FILE = envFile;
		try {
			expect(loadGbrainToken("GBRAIN_TEST_PLAIN")).toBe("from-file");
			expect(loadGbrainToken("GBRAIN_TEST_QUOTED")).toBe("quoted value");
			expect(loadGbrainToken("GBRAIN_TEST_ABSENT")).toBeNull();
		} finally {
			if (savedFile === undefined) delete process.env.PAO_ENV_FILE;
			else process.env.PAO_ENV_FILE = savedFile;
		}
	});
});

describe("gbrain 适配器:起、列工具、写读忘一轮", () => {
	it("启动＝initialize 握手＋工具清单→能力{语义检索,需嵌入端点=false,忘却按清单};关停幂等", async () => {
		const handle = await startFakeGbrain();
		try {
			const vendor = vendorTo(handle);
			await expect(vendor.start()).resolves.toBeUndefined();
			expect(vendor.capabilities).toEqual({ 语义检索: true, 需嵌入端点: false, 忘却: true });
			expect(vendor.toolList).toContain("remember");
			await expect(vendor.close()).resolves.toBeUndefined();
			await expect(vendor.close()).resolves.toBeUndefined(); // 幂等
		} finally {
			await handle.close();
		}
	});

	it("写入带 visibility=world＋provenance 前缀(标签拼进 provenance);召回映射 fact/fact_id/provenance;忘却清条", async () => {
		const handle = await startFakeGbrain();
		try {
			const vendor = vendorTo(handle);
			await vendor.start();
			await vendor.write("用户偏好深色主题", ["偏好", "ui"]);
			const remember = handle.calls.find((c) => c.name === "remember");
			expect(remember?.args.visibility).toBe("world");
			expect(remember?.args.provenance).toBe("pao｜标签:偏好,ui");
			await vendor.write("无标签事实");
			expect(handle.calls.filter((c) => c.name === "remember").at(-1)?.args.provenance).toBe("pao");

			const hits = await vendor.recall("深色主题");
			expect(hits).toHaveLength(1);
			expect(hits[0]).toMatchObject({ 内容: "用户偏好深色主题", 记忆ID: "1", 来源: "pao｜标签:偏好,ui" });

			await expect(vendor.forget("1")).resolves.toBe(1);
			await expect(vendor.recall("深色主题")).resolves.toEqual([]); // 空召回(带第二 text 块)也解得开
		} finally {
			await handle.close();
		}
	});

	it("duplicate 状态＝幂等成功不抛;忘却已过期条目返回 0;未知 ID 报错不伪造零删除", async () => {
		const handle = await startFakeGbrain({ duplicateOnSameFact: true });
		try {
			const vendor = new GbrainVendor(
				{ base_url: `http://127.0.0.1:${handle.port}` },
				{ token加载: TOKEN_INJECTED },
			);
			await vendor.start();
			await vendor.write("同一事实");
			await expect(vendor.write("同一事实")).resolves.toEqual({ 记忆ID: "1", 状态: "duplicate" });
			await expect(vendor.forget("1")).resolves.toBe(1);
			await expect(vendor.forget("1")).resolves.toBe(0); // 已过期＝幂等 0
			await expect(vendor.forget("999")).rejects.toThrow(/not_found/);
		} finally {
			await handle.close();
		}
	});

	it("服务器不提供 forget → 能力.忘却=false,忘却调用本地拒绝(不发 HTTP)", async () => {
		const handle = await startFakeGbrain({ tools: ["remember", "recall"] });
		try {
			const vendor = vendorTo(handle);
			await vendor.start();
			expect(vendor.capabilities.忘却).toBe(false);
			await expect(vendor.forget("1")).rejects.toThrow("未提供忘却工具");
			expect(handle.calls.filter((c) => c.name === "forget")).toHaveLength(0);
		} finally {
			await handle.close();
		}
	});

	it("缺工具 remember → 启动失败,报错列出实际工具清单", async () => {
		const handle = await startFakeGbrain({ tools: ["recall", "forget"] });
		try {
			await expect(vendorTo(handle).start()).rejects.toThrow(/缺工具「remember」.*forget、recall/);
		} finally {
			await handle.close();
		}
	});

	it("token 不符(401) → 启动失败带 HTTP 401;缺 token → 不发请求即失败", async () => {
		const handle = await startFakeGbrain({ token: "别的-token" });
		try {
			await expect(vendorTo(handle).start()).rejects.toThrow(/HTTP 401/);
		} finally {
			await handle.close();
		}
		const vendor = new GbrainVendor({}, { token加载: () => null });
		await expect(vendor.start()).rejects.toThrow("缺 Bearer token");
	});

	it("initialize 挂起 → 请求超时,同样失败(不无限等)", async () => {
		const handle = await startFakeGbrain({ hangInitialize: true });
		try {
			const vendor = vendorTo(handle, { 请求超时毫秒: 400 });
			await expect(vendor.start()).rejects.toThrow("gbrain MCP 启动失败");
		} finally {
			await handle.close();
		}
	});

	it("启动失败且首次清理也失败 → 双错与 cause 保留；未清理前拒绝覆盖连接", async () => {
		const handle = await startFakeGbrain({ tools: ["recall", "forget"] });
		const cleanupFailure = new Error("模拟首次 HTTP transport 清理失败");
		const closeSpy = vi.spyOn(StreamableHttpTransport.prototype, "close").mockRejectedValueOnce(cleanupFailure);
		try {
			const vendor = vendorTo(handle);
			const failure = await vendor.start().catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(AggregateError);
			const aggregate = failure as AggregateError;
			expect(aggregate.errors).toHaveLength(2);
			expect(aggregate.errors[0]).toMatchObject({ message: expect.stringContaining("缺工具「remember」") });
			expect(aggregate.errors[1]).toBe(cleanupFailure);
			expect(aggregate.cause).toBe(aggregate.errors[0]);
			expect((aggregate.errors[0] as Error).cause).toMatchObject({
				message: expect.stringContaining("缺工具「remember」"),
			});

			await expect(vendor.start()).rejects.toThrow("必须先重试 close()");
			expect(handle.methods.filter((method) => method === "initialize")).toHaveLength(1);

			await expect(vendor.close()).resolves.toBeUndefined();
			expect(closeSpy).toHaveBeenCalledTimes(2); // 首次拒绝；重试成功后才清身份
		} finally {
			closeSpy.mockRestore();
			await handle.close();
		}
	});

	it("关闭失败保留同一连接；重试成功后清身份，下一次启动建立新连接", async () => {
		const handle = await startFakeGbrain();
		const closeFailure = new Error("模拟 HTTP transport 关闭失败");
		const closeSpy = vi.spyOn(StreamableHttpTransport.prototype, "close").mockRejectedValueOnce(closeFailure);
		try {
			const vendor = vendorTo(handle);
			await vendor.start();
			await expect(vendor.close()).rejects.toBe(closeFailure);

			await expect(vendor.start()).rejects.toThrow("必须先重试 close()");
			expect(handle.methods.filter((method) => method === "initialize")).toHaveLength(1);

			await expect(vendor.close()).resolves.toBeUndefined();
			await expect(vendor.start()).resolves.toBeUndefined();
			expect(handle.methods.filter((method) => method === "initialize")).toHaveLength(2);
			await vendor.close();
		} finally {
			closeSpy.mockRestore();
			await handle.close();
		}
	});
});

describe("管理器降级:拒连/失败后本会话不再重试,关闭复位", () => {
	it("连不上(拒连端口) → 获取()=undefined＋降级原因;关闭后状态复位", async () => {
		const config: MemoryVendorConfig = {
			供应商: "gbrain",
			参数: { base_url: "http://127.0.0.1:1", 请求超时毫秒: 500 },
		};
		const warnings: string[] = [];
		// 注入假 token 走 env 现值,默认 .env 链绝不在测试里触真实文件
		const saved = process.env.GBRAIN_TOKEN;
		process.env.GBRAIN_TOKEN = "refused-test";
		try {
			const manager = new MemoryVendorManager(config, (m) => warnings.push(m));
			await expect(manager.acquire()).resolves.toBeUndefined();
			expect(manager.status).toBe("已降级");
			expect(manager.degradeReason).toContain("gbrain");
			expect(warnings[0]).toContain("[pao]");
			await expect(manager.acquire()).resolves.toBeUndefined(); // 已降级不再重试
			await manager.close();
			expect(manager.status).toBe("待启动");
		} finally {
			if (saved === undefined) delete process.env.GBRAIN_TOKEN;
			else process.env.GBRAIN_TOKEN = saved;
		}
	});
});

describe("接线(registerMemory):gbrain 正常注册三工具全链路;拒连降级为无记忆文本", () => {
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

	function configDir(body: string): string {
		const dir = tempDir();
		mkdirSync(join(dir, "pao配置"), { recursive: true });
		writeFileSync(join(dir, "pao配置", "记忆供应商.json"), body, "utf8");
		return dir;
	}

	it("正常配置 → 三工具;写入→召回→忘却全链路落到假服务器;session_shutdown 关停", async () => {
		const handle = await startFakeGbrain();
		const dir = configDir(
			JSON.stringify({
				供应商: "gbrain",
				参数: { base_url: `http://127.0.0.1:${handle.port}`, token环境变量: "GBRAIN_TEST_TOOL_TOKEN" },
			}),
		);
		const saved = process.env.GBRAIN_TEST_TOOL_TOKEN;
		process.env.GBRAIN_TEST_TOOL_TOKEN = "test-token";
		try {
			const { pi, tools, handlers } = fakePi();
			expect(
				registerMemory(pi, {
					resolveConfigPath: () => join(dir, "pao配置", "记忆供应商.json"),
					outbound: { projects: { [basename(dir)]: { allowed: true, asOf: "2099-12-31" } } },
				}),
			).toBeDefined();
			expect(tools.map((t) => t.name)).toEqual(["pao_memory_write", "pao_memory_recall", "pao_memory_forget"]);

			const byName = (name: string) => tools.find((t) => t.name === name)!;
			const written = await byName("pao_memory_write").execute(
				"t1",
				{ content: "用户在 Windows 上开发", tags: ["环境"] } as never,
				undefined,
				undefined,
				{ cwd: dir } as never,
			);
			expect(written.content[0].text).toBe("已写入记忆库。");
			const recalled = await byName("pao_memory_recall").execute(
				"t2",
				{ query: "Windows" } as never,
				undefined,
				undefined,
				{ cwd: dir } as never,
			);
			expect(recalled.content[0].text).toContain("召回 1 条");
			expect(recalled.content[0].text).toContain("用户在 Windows 上开发");
			const forgotten = await byName("pao_memory_forget").execute("t3", { memory_id: "1", confirm: true } as never);
			expect(forgotten.content[0].text).toBe("已忘却 1 条。");

			expect(() => handlers.get("session_shutdown")?.()).not.toThrow();
		} finally {
			if (saved === undefined) delete process.env.GBRAIN_TEST_TOOL_TOKEN;
			else process.env.GBRAIN_TEST_TOOL_TOKEN = saved;
			await handle.close();
		}
	});

	it("拒连 → 首次调用返回降级文本(isError),会话不受影响", async () => {
		const dir = configDir(
			JSON.stringify({ 供应商: "gbrain", 参数: { base_url: "http://127.0.0.1:1", 请求超时毫秒: 500 } }),
		);
		const saved = process.env.GBRAIN_TOKEN;
		process.env.GBRAIN_TOKEN = "refused-test"; // env 现值优先,不触真实 .env
		try {
			const { pi, tools } = fakePi();
			registerMemory(pi, {
				resolveConfigPath: () => join(dir, "pao配置", "记忆供应商.json"),
				outbound: { projects: { [basename(dir)]: { allowed: true, asOf: "2099-12-31" } } },
			});
			const write = tools[0]!;
			const result = await write.execute("t1", { content: "x" } as never, undefined, undefined, {
				cwd: dir,
			} as never);
			expect(result.isError).toBeUndefined(); // 降级≠失败(degradeResult 不带 isError,模型可继续干活)
			expect(result.content[0].text).toContain("记忆供应商不可用");
		} finally {
			if (saved === undefined) delete process.env.GBRAIN_TOKEN;
			else process.env.GBRAIN_TOKEN = saved;
		}
	});
});
