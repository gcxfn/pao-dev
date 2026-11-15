/**
 * 记忆适配器共享契约测试(T07,2026-10-06):gbrain 与 mnemosyne 两个适配器打同一套
 * MemoryVendor 接口断言——能力声明形状/启动前调用拒绝/启动幂等/写入→召回往返/上限尊重/
 * 忘却往返/关闭幂等且关后拒绝,验证「同一接口」(memory-vendor.ts 契约定案)。
 * 供应商个性差异(401/超时/停树/duplicate 等)归各自生命周期测试,这里不重复。
 *
 * 模拟供应商声明:全部打在自起假服务器上——gbrain=进程内假 MCP HTTP 服务器(127.0.0.1
 * 随机端口);mnemosyne=node 假 stdio 服务器(临时目录,stdin 断开即退,不留孤儿进程)。
 * 不碰真容器/真 mnemosyne/真 token/真实 .env;真实在线验证需单独授权,不在本测试范围。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { GbrainVendor } from "../../src/pao/memory/gbrain.ts";
import { createVendorRecall } from "../../src/pao/memory/index.ts";
import { type MemoryVendor, MemoryVendorManager, registerMemoryVendor } from "../../src/pao/memory/memory-vendor.ts";
import { MnemosyneVendor } from "../../src/pao/memory/mnemosyne.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 假 gbrain:最小 MCP over HTTP(握手＋工具清单＋写读忘),协议细节归 gbrain-lifecycle */
interface FakeGbrainHttp {
	port: number;
	recalls: number;
	cancellations: number;
	releaseFirstRecall: () => void;
	close: () => Promise<void>;
}

function startFakeGbrainHttp(options: { slowFirstRecall?: boolean } = {}): Promise<FakeGbrainHttp> {
	const facts = new Map<string, string>();
	let nextId = 1;
	let recalls = 0;
	let cancellations = 0;
	let releaseFirstRecall: () => void = () => {};
	const firstRecallGate = new Promise<void>((resolve) => {
		releaseFirstRecall = resolve;
	});
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", async () => {
			const message = JSON.parse(body) as {
				id?: number;
				method: string;
				params?: { name?: string; arguments?: Record<string, unknown> };
			};
			const reply = (result: unknown) => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
			};
			const replyError = (messageText: string) => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: messageText } }));
			};
			if (message.method === "notifications/cancelled") {
				cancellations++;
				res.writeHead(204);
				res.end();
				return;
			}
			if (message.id === undefined) {
				res.writeHead(204);
				res.end();
				return;
			}
			if (message.method === "initialize") {
				reply({
					protocolVersion: "2025-03-26",
					capabilities: {},
					serverInfo: { name: "fake-gbrain-contract", version: "0.0.0" },
				});
				return;
			}
			if (message.method === "tools/list") {
				reply({
					tools: ["remember", "recall", "forget"].map((name) => ({
						name,
						description: "",
						inputSchema: { type: "object", properties: {} },
					})),
				});
				return;
			}
			if (message.method === "tools/call") {
				const name = String(message.params?.name ?? "");
				const args = message.params?.arguments ?? {};
				if (name === "remember") {
					const id = String(nextId++);
					facts.set(id, String(args.fact ?? ""));
					reply({ content: [{ type: "text", text: JSON.stringify({ id, status: "inserted" }) }] });
					return;
				}
				if (name === "recall") {
					recalls++;
					if (options.slowFirstRecall && recalls === 1) {
						await firstRecallGate;
						res.writeHead(204);
						res.end();
						return;
					}
					const query = String(args.query ?? "");
					const limit = typeof args.limit === "number" ? args.limit : 3;
					const hits = [...facts]
						.filter(([, fact]) => fact.includes(query))
						.slice(0, limit)
						.map(([id, fact]) => ({ fact_id: id, fact, provenance: "pao" }));
					reply({ content: [{ type: "text", text: JSON.stringify({ facts: hits }) }] });
					return;
				}
				if (name === "forget") {
					const id = String(args.id ?? "");
					if (!facts.has(id)) {
						replyError(`not_found: no fact with id ${id}`); // 与真实 gbrain 同:未知 ID 报错,不回 0
						return;
					}
					facts.delete(id);
					reply({ content: [{ type: "text", text: JSON.stringify({ id, expired: true }) }] });
					return;
				}
			}
			replyError(`unknown tool/method`);
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as { port: number }).port;
			resolve({
				port,
				get recalls() {
					return recalls;
				},
				get cancellations() {
					return cancellations;
				},
				releaseFirstRecall: () => releaseFirstRecall(),
				close: () =>
					new Promise<void>((done) => {
						server.closeAllConnections?.();
						server.close(() => done());
					}),
			});
		});
	});
}

/**
 * 假 mnemosyne:最小 JSON-RPC over stdio 服务器。与 mnemosyne-lifecycle 的假服务器差异:
 * stdin 断开即退(契约测试不练停树,树杀归生命周期测试),不留孤儿进程。
 */
const FAKE_STDIO_SCRIPT = `
const tools = ["mnemosyne_remember", "mnemosyne_recall", "mnemosyne_forget"];
const state = { items: [] };
const respond = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
const handle = (msg) => {
	if (msg.method === "initialize") { respond(msg.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-mnemosyne-contract", version: "0.0.0" } }); return; }
	if (msg.method === "tools/list") { respond(msg.id, { tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })) }); return; }
	if (msg.method === "tools/call") {
		const a = msg.params.arguments || {};
		if (msg.params.name === "mnemosyne_remember") {
			const id = "mem-" + String(state.items.length + 1).padStart(3, "0");
			state.items.push({ id, content: a.content });
			respond(msg.id, { isError: false, content: [{ type: "text", text: JSON.stringify({ status: "stored", memory_id: id }) }] });
			return;
		}
		if (msg.params.name === "mnemosyne_recall") {
			const q = String(a.query || "");
			const hits = state.items.filter((it) => it.content.includes(q)).slice(0, a.limit || 3)
				.map((it) => ({ id: it.id, content: it.content, score: 0.9 }));
			respond(msg.id, { isError: false, content: [{ type: "text", text: JSON.stringify({ status: "ok", count: hits.length, results: hits }) }] });
			return;
		}
		if (msg.params.name === "mnemosyne_forget") {
			const before = state.items.length;
			state.items = state.items.filter((it) => it.id !== a.memory_id);
			const deleted = before - state.items.length;
			respond(msg.id, { isError: false, content: [{ type: "text", text: JSON.stringify({ status: deleted ? "deleted" : "not_found", memory_id: a.memory_id }) }] });
			return;
		}
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
process.stdin.on("end", () => process.exit(0));
`;

/** 契约测试针对的两个模拟供应商(gbrain/mnemosyne)均实现可选契约「忘却」(memory-vendor.ts:
 * 忘却仅 能力.忘却=true 的供应商实现)。测试按非可选签名调用,类型面收窄为必选,不改产品契约。 */
type VendorWithForget = MemoryVendor & Required<Pick<MemoryVendor, "forget">>;

/** 供应商夹具:构造方式各适配器不同,契约断言完全同一套 */
interface VendorFixture {
	name: string;
	make: () => Promise<{ vendor: VendorWithForget; dispose: () => Promise<void> }>;
}

const fixtures: VendorFixture[] = [
	{
		name: "gbrain(模拟MCP HTTP服务器)",
		make: async () => {
			const fake = await startFakeGbrainHttp();
			return {
				vendor: new GbrainVendor(
					{ base_url: `http://127.0.0.1:${fake.port}` },
					{ token加载: () => "contract-test-token" }, // token 注入,绝不走真实 .env 链
				),
				dispose: () => fake.close(),
			};
		},
	},
	{
		name: "mnemosyne(模拟stdio服务器)",
		make: async () => {
			const dir = mkdtempSync(join(tmpdir(), "pao-contract-mnemosyne-"));
			tempDirs.push(dir);
			const script = join(dir, "fake-mnemosyne-contract.js");
			writeFileSync(script, FAKE_STDIO_SCRIPT, "utf8");
			const vendor = new MnemosyneVendor(
				{ command: process.execPath, args: [script], 请求超时毫秒: 10000 },
				{ 嵌入配置: () => null }, // 不读真实 EMBED_*/.env
			);
			return { vendor, dispose: () => vendor.close() };
		},
	},
];

async function withVendor(fixture: VendorFixture, run: (vendor: VendorWithForget) => Promise<void>): Promise<void> {
	const { vendor, dispose } = await fixture.make();
	try {
		await run(vendor);
	} finally {
		await vendor.close().catch(() => {});
		await dispose();
	}
}

describe.each(fixtures)("记忆适配器共享契约:$name(模拟供应商)", (fixture) => {
	it("启动前调用写入/召回/忘却一律拒绝,不自行静默拉起连接", async () => {
		await withVendor(fixture, async (vendor) => {
			await expect(vendor.write("提前写入")).rejects.toThrow(/未启动/);
			await expect(vendor.recall("提前召回")).rejects.toThrow(/未启动/);
			await expect(vendor.forget("任意")).rejects.toThrow(); // 能力未声明(忘却=false),本地拒绝
		});
	});

	it("启动幂等;能力声明为三布尔字段,忘却按模拟服务器工具清单声明", async () => {
		await withVendor(fixture, async (vendor) => {
			await expect(vendor.start()).resolves.toBeUndefined();
			await expect(vendor.start()).resolves.toBeUndefined(); // 幂等
			expect(vendor.capabilities).toEqual({
				语义检索: expect.any(Boolean),
				需嵌入端点: expect.any(Boolean),
				忘却: true, // 两个模拟服务器都提供忘却工具
			});
		});
	});

	it("写入→召回往返:命中带记忆ID;未命中如实空数组,不伪造命中", async () => {
		await withVendor(fixture, async (vendor) => {
			await vendor.start();
			await vendor.write("契约事实:用户偏好深色主题", ["契约"]);
			const hits = await vendor.recall("深色主题");
			expect(hits).toHaveLength(1);
			expect(hits[0]!.内容).toBe("契约事实:用户偏好深色主题");
			expect(typeof hits[0]!.记忆ID).toBe("string");
			await expect(vendor.recall("不存在的检索词")).resolves.toEqual([]);
		});
	});

	it("召回尊重上限参数(检索词,上限)", async () => {
		await withVendor(fixture, async (vendor) => {
			await vendor.start();
			await vendor.write("上限事实甲");
			await vendor.write("上限事实乙");
			const hits = await vendor.recall("上限", 1);
			expect(hits).toHaveLength(1);
		});
	});

	it("忘却往返:按召回所得准确ID清除返回1,再召回归零", async () => {
		await withVendor(fixture, async (vendor) => {
			await vendor.start();
			await vendor.write("可忘却事实:过期密钥");
			const hit = (await vendor.recall("过期密钥"))[0]!;
			await expect(vendor.forget(hit.记忆ID!)).resolves.toBe(1);
			await expect(vendor.recall("过期密钥")).resolves.toEqual([]);
		});
	});

	it("关闭幂等;关闭后调用拒绝,本会话不再可用", async () => {
		await withVendor(fixture, async (vendor) => {
			await vendor.start();
			await expect(vendor.close()).resolves.toBeUndefined();
			await expect(vendor.close()).resolves.toBeUndefined(); // 幂等
			await expect(vendor.recall("任意")).rejects.toThrow(/未启动/);
		});
	});
});

describe("查库语义召回桥 createVendorRecall(§18.3,未启用/已降级如实抛错不静默空召回)", () => {
	it("管理器未启用(接线闭包 undefined)→ 抛错注明无记忆配置", async () => {
		const recall = createVendorRecall(() => undefined);
		await expect(recall("任意", 3)).rejects.toThrow(/记忆供应商未就绪.*无记忆配置/);
	});

	it("供应商已降级 → 抛错带降级原因(真实管理器,指向未注册工厂触发降级)", async () => {
		const manager = new MemoryVendorManager({ 供应商: "查无此厂", 参数: {} }, () => {});
		await manager.acquire(); // 触发降级标记
		const recall = createVendorRecall(() => manager);
		await expect(recall("任意", 3)).rejects.toThrow(/记忆供应商未就绪.*没有已注册的工厂/);
	});

	it("真实 gbrain 适配器收到 signal → McpClient 取消召回且共享 HTTP 客户端继续可用", async () => {
		const name = "gbrain-取消隔离实测";
		const fake = await startFakeGbrainHttp({ slowFirstRecall: true });
		let vendor: GbrainVendor | undefined;
		registerMemoryVendor(name, () => {
			vendor = new GbrainVendor(
				{ base_url: `http://127.0.0.1:${fake.port}` },
				{ token加载: () => "contract-test-token" },
			);
			return vendor;
		});
		const manager = new MemoryVendorManager({ 供应商: name, 参数: {} }, () => {});
		const recall = createVendorRecall(() => manager);
		try {
			const controller = new AbortController();
			const slowRecall = recall("契约取消", 3, controller.signal);
			await expect.poll(() => fake.recalls).toBe(1);
			controller.abort("用户取消召回");
			await expect(slowRecall).rejects.toBe("用户取消召回");
			await expect.poll(() => fake.cancellations).toBe(1);

			expect(manager.status).toBe("已就绪");
			const remaining = await Promise.race([
				recall("取消后仍可召回", 3),
				new Promise<never>((_resolve, reject) =>
					setTimeout(() => reject(new Error("延迟取消回包阻塞后续召回")), 1000),
				),
			]);
			expect(remaining).toEqual([]);
			expect(fake.recalls).toBe(2);
			expect(vendor!.toolList).toContain("recall");
		} finally {
			fake.releaseFirstRecall();
			await manager.close();
			await fake.close();
		}
	});
});
