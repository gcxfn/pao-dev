import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { DeptRegistryRow } from "../../src/pao/dept/registry.ts";
import { autoPatrol } from "../../src/pao/knowledge/auto-route.ts";
import { EmbedTimeoutError, embedTexts, type FetchLike } from "../../src/pao/knowledge/embed.ts";
import type { OutboundConfig } from "../../src/pao/knowledge/outbound.ts";
import { vectorCachePath } from "../../src/pao/knowledge/paths.ts";
import { type SearchOptions, searchLibrary } from "../../src/pao/knowledge/search.ts";

const OUTBOUND: OutboundConfig = {
	projects: {
		"demo-proj": { allowed: true, asOf: "2099-12-31" },
	},
};

const EMBED_A = { baseUrl: "http://embed-a", apiKey: "key-a", model: "model-a" };
const EMBED_B = { baseUrl: "http://embed-b", apiKey: "key-b", model: "model-b" };

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	for (const server of servers.splice(0)) {
		if (server.listening) {
			server.closeAllConnections?.();
			await Promise.race([
				new Promise<void>((resolve) => server.close(() => resolve())),
				new Promise<void>((resolve) => setTimeout(resolve, 1000)),
			]);
		}
	}
});

function library(name: string): string {
	const root = mkdtempSync(join(tmpdir(), `pao-kb-cancel-${name}-`));
	roots.push(root);
	for (const area of ["教训", "导览", "做法", "评测", "待验证", "归档"]) mkdirSync(join(root, area));
	return root;
}

function entry(root: string, area: string, file: string, scope: string): void {
	writeFileSync(join(root, area, file), `连接池超时排查 2026-10-01\n说明：测试条目\n适用范围: ${scope}\n`, "utf8");
}

function response(input: string[], vector = [1, 0]): Awaited<ReturnType<FetchLike>> {
	return {
		ok: true,
		status: 200,
		json: async () => ({ data: input.map((_, index) => ({ index, embedding: vector })) }),
	};
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 2000 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 1));
	if (!predicate()) throw new Error("测试等待条件未满足");
}

async function delayedEmbedServer(options: { headersMs?: number; bodyMs?: number }) {
	let requests = 0;
	let cancelled = 0;
	let closed = 0;
	const server = createServer((req, res) => {
		requests++;
		let bodyEnded = false;
		req.resume();
		res.on("close", () => {
			closed++;
			if (!bodyEnded) cancelled++;
		});
		const body = JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] });
		const send = () => {
			res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
			if (options.bodyMs)
				setTimeout(() => {
					bodyEnded = true;
					res.end(body);
				}, options.bodyMs);
			else {
				bodyEnded = true;
				res.end(body);
			}
		};
		if (options.headersMs) setTimeout(send, options.headersMs);
		else send();
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	servers.push(server);
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("测试 HTTP 服务未监听端口");
	return {
		url: `http://127.0.0.1:${address.port}`,
		get requests() {
			return requests;
		},
		get closed() {
			return closed;
		},
		get cancelled() {
			return cancelled;
		},
	};
}

describe("查库取消、超时和跨库查询嵌入复用", () => {
	test("用户取消会中止嵌入请求，不再发查询词请求或写向量缓存", async () => {
		const libRoot = library("abort");
		entry(libRoot, "教训", "pool.md", "demo-proj");
		const controller = new AbortController();
		let calls = 0;
		let requestSignal: AbortSignal | undefined;
		const fetchImpl: FetchLike = async (_url, init) => {
			calls++;
			requestSignal = init?.signal;
			return new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("取消")), {
					once: true,
				});
			});
		};
		const pending = searchLibrary({
			libRoot,
			query: "连接池",
			project: "demo-proj",
			outbound: OUTBOUND,
			embed: { config: EMBED_A, fetchImpl },
			signal: controller.signal,
			writeCache: true,
			timeoutMs: 1000,
		});
		await waitUntil(() => requestSignal !== undefined);
		controller.abort(new Error("用户取消查库"));
		await expect(pending).rejects.toThrow("用户取消查库");
		expect(calls).toBe(1);
		// 未完成的嵌入不能写出新缓存文件。
		expect(existsSync(vectorCachePath(libRoot))).toBe(false);
	});

	test("嵌入请求超时沿词法降级路径返回清楚原因", async () => {
		const libRoot = library("timeout");
		entry(libRoot, "教训", "pool.md", "demo-proj");
		const fetchImpl: FetchLike = async () => {
			await new Promise((resolve) => setTimeout(resolve, 100));
			return response(["连接池超时排查"]);
		};
		const result = await searchLibrary({
			libRoot,
			query: "连接池",
			project: "demo-proj",
			outbound: OUTBOUND,
			embed: { config: EMBED_A, fetchImpl },
			timeoutMs: 10,
		});
		expect(result.degraded).toBe(true);
		expect(result.degradeReason).toContain("超时");
		expect(result.hits.map((hit) => hit.relPath)).toContain("教训/pool.md");
	});

	test("真实 localhost 响应头延迟会超时并取消连接", async () => {
		const server = await delayedEmbedServer({ headersMs: 500 });
		await expect(
			embedTexts({ config: { ...EMBED_A, baseUrl: server.url }, fetchImpl: fetch }, ["连接池"], { timeoutMs: 100 }),
		).rejects.toBeInstanceOf(EmbedTimeoutError);
		await waitUntil(() => server.requests === 1 && server.cancelled > 0);
	});

	test("真实 localhost 响应体延迟也能被用户取消并断开连接", async () => {
		const server = await delayedEmbedServer({ bodyMs: 100 });
		const controller = new AbortController();
		const pending = embedTexts({ config: { ...EMBED_A, baseUrl: server.url }, fetchImpl: fetch }, ["连接池"], {
			signal: controller.signal,
			timeoutMs: 1000,
		});
		await waitUntil(() => server.requests === 1);
		controller.abort(new Error("用户取消正文读取"));
		await expect(pending).rejects.toThrow("用户取消正文读取");
		await waitUntil(() => server.cancelled > 0);
	});

	test("嵌入请求成功后移除用户取消监听器", async () => {
		const controller = new AbortController();
		const add = vi.spyOn(controller.signal, "addEventListener");
		const remove = vi.spyOn(controller.signal, "removeEventListener");
		const result = await embedTexts({ config: EMBED_A, fetchImpl: async () => response(["连接池"]) }, ["连接池"], {
			signal: controller.signal,
			timeoutMs: 0,
		});
		expect(result).toEqual([[1, 0]]);
		expect(add).toHaveBeenCalledTimes(2);
		expect(remove).toHaveBeenCalledTimes(2);
	});

	test("自动跨库在各库授权后复用同配置查询向量，禁外发条目不随共享请求外发", async () => {
		const first = library("shared-a");
		const second = library("shared-b");
		entry(first, "教训", "allowed.md", "demo-proj");
		entry(second, "教训", "blocked.md", "other-proj");
		const calls: { model: string; input: string[] }[] = [];
		const fetchImpl: FetchLike = async (_url, init) => {
			const body = JSON.parse(init?.body ?? "{}") as { model?: string; input?: string[] };
			calls.push({ model: body.model ?? "", input: body.input ?? [] });
			return response(body.input ?? []);
		};
		const rows: DeptRegistryRow[] = [
			{ 名字: "甲部", 标签: ["连接池"], 库路径: "甲部" },
			{ 名字: "乙部", 标签: ["连接池"], 库路径: "乙部" },
		];
		// routeByLabel 按 PAO_HOME 拼接相对库路径；两个临时库都位于系统临时目录下。
		const paoHome = tmpdir();
		const absoluteRows = [
			{ ...rows[0]!, 库路径: first.slice(paoHome.length + 1) },
			{ ...rows[1]!, 库路径: second.slice(paoHome.length + 1) },
		];
		const result = await autoPatrol({
			查询: "连接池",
			注册表行: absoluteRows,
			paoHome目录: paoHome,
			project: "demo-proj",
			outbound: OUTBOUND,
			embed: { config: EMBED_A, fetchImpl },
		});
		expect(result.失败库).toEqual([]);
		// 允许库的一次条目嵌入 + 两库共享的一次查询词嵌入；禁外发库的 blocked.md 不在请求体。
		expect(calls).toHaveLength(2);
		expect(calls.some((call) => call.input.some((text) => text.includes("blocked.md")))).toBe(false);
		expect(calls.filter((call) => call.input.length === 1 && call.input[0] === "连接池")).toHaveLength(1);
	});

	test("不同嵌入配置不共享查询向量", async () => {
		const first = library("config-a");
		const second = library("config-b");
		const calls: string[] = [];
		const makeFetch =
			(label: string): FetchLike =>
			async (_url, init) => {
				calls.push(label);
				const body = JSON.parse(init?.body ?? "{}") as { input?: string[] };
				return response(body.input ?? []);
			};
		const paoHome = tmpdir();
		const rows: DeptRegistryRow[] = [
			{ 名字: "甲部", 标签: ["查询"], 库路径: first.slice(paoHome.length + 1) },
			{ 名字: "乙部", 标签: ["查询"], 库路径: second.slice(paoHome.length + 1) },
		];
		await autoPatrol({
			查询: "查询",
			注册表行: rows,
			paoHome目录: paoHome,
			project: "demo-proj",
			outbound: OUTBOUND,
			searchImpl: (options: SearchOptions) =>
				searchLibrary({
					...options,
					embed:
						options.libRoot === first
							? { config: EMBED_A, fetchImpl: makeFetch("a") }
							: { config: EMBED_B, fetchImpl: makeFetch("b") },
				}),
		});
		expect(calls.sort()).toEqual(["a", "b"]);
	});
});
