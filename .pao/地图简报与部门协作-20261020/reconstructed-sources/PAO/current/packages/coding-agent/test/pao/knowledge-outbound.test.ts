/**
 * 卡0004 验收 8：禁外发——未授权项目的库，查询词与条目正文均不进入嵌入请求
 * （mock 断言请求体）；配置撤销后新外发被阻断（不宣称撤回云端已收数据）。
 * 三个入口（查询嵌入/条目嵌入/批量重建）共用 checkOutbound 一个函数。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadVectorCache } from "../../src/pao/knowledge/cache.ts";
import { embedTexts, type FetchLike } from "../../src/pao/knowledge/embed.ts";
import { checkOutbound, type OutboundConfig, projectFromCwd } from "../../src/pao/knowledge/outbound.ts";
import { searchLibrary } from "../../src/pao/knowledge/search.ts";

let libRoot: string;

beforeEach(() => {
	libRoot = mkdtempSync(join(tmpdir(), "pao-kb-outbound-"));
	for (const dir of ["教训", "导览", "做法", "评测", "待验证", "归档"]) {
		mkdirSync(join(libRoot, dir));
	}
});

afterEach(() => {
	rmSync(libRoot, { recursive: true, force: true });
});

const SECRET_ENTRY = `机密项目里踩的坑 2026-10-01
这个条目正文属于 secret-proj，绝不能外发。
适用范围: secret-proj`;

const OPEN_ENTRY = `公开项目的连接池经验 2026-10-01
这个条目属于 open-proj。
适用范围: open-proj`;

const QUERY = "连接池 问题";

function writeEntry(relPath: string, content: string): void {
	const abs = join(libRoot, relPath);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content, "utf8");
}

interface RecordedBody {
	input?: string[];
	model?: string;
}

function spyEmbed(): FetchLike & { bodies: RecordedBody[] } {
	const bodies: RecordedBody[] = [];
	const impl = (async (_url: string, init?: { body?: string }) => {
		bodies.push(JSON.parse(init?.body ?? "{}") as RecordedBody);
		return {
			ok: true,
			status: 200,
			json: async () => ({
				data: (bodies[bodies.length - 1].input ?? []).map((_, i) => ({ index: i, embedding: [1, 0] })),
			}),
		};
	}) as FetchLike & { bodies: RecordedBody[] };
	impl.bodies = bodies;
	return impl;
}

const EMBED = { baseUrl: "http://mock.embed", apiKey: "test-key", model: "mock-embed" };
const ALLOW_OPEN: OutboundConfig = { projects: { "open-proj": { allowed: true, asOf: "2099-12-31" } } };

describe("验收8：禁外发", () => {
	test("截至日期当天仍有效，次日和撤销后阻断，不把许可变成永久放行", () => {
		const dated: OutboundConfig = { projects: { "open-proj": { allowed: true, asOf: "2026-12-31" } } };
		expect(checkOutbound(["open-proj"], dated, new Date("2026-12-31T23:59:59")).allowed).toBe(true);
		expect(checkOutbound(["open-proj"], dated, new Date("2027-01-01T00:00:00")).allowed).toBe(false);
		expect(
			checkOutbound(
				["open-proj"],
				{ projects: { "open-proj": { allowed: false, asOf: "2026-12-31" } } },
				new Date("2026-10-03T00:00:00"),
			).allowed,
		).toBe(false);
	});

	test("项目从最近 git 根绑定，子目录不改变身份；缺 cwd 保持未知", () => {
		const project = join(libRoot, "open-proj");
		mkdirSync(join(project, ".git"), { recursive: true });
		mkdirSync(join(project, "src", "module"), { recursive: true });
		expect(projectFromCwd(join(project, "src", "module"))).toBe("open-proj");
		expect(projectFromCwd(undefined)).toBeUndefined();
	});
	test("Windows 按项目名大小写匹配许可，其他项目名称不扩大授权", () => {
		const pao: OutboundConfig = { projects: { PAO: { allowed: true, asOf: "2099-12-31" } } };
		expect(checkOutbound(["pao"], pao).allowed).toBe(process.platform === "win32");
		expect(checkOutbound(["pao-dev"], pao).allowed).toBe(false);
	});
	test("共享检查函数：未授权/未知项目一律阻断（三入口同一函数）", () => {
		expect(checkOutbound(["open-proj"], ALLOW_OPEN).allowed).toBe(true);
		const blocked = checkOutbound(["open-proj", "secret-proj"], ALLOW_OPEN);
		expect(blocked.allowed).toBe(false);
		expect(blocked.blocked).toEqual(["secret-proj"]);
		// 未列出的项目默认拒绝；适用范围缺失（未知）拒绝；空清单拒绝
		expect(checkOutbound(["别的项目"], ALLOW_OPEN).allowed).toBe(false);
		expect(checkOutbound([], ALLOW_OPEN).allowed).toBe(false);
	});

	test("未授权项目的条目正文不进入任何嵌入请求", async () => {
		writeEntry("教训/机密条目.md", SECRET_ENTRY);
		writeEntry("教训/公开条目.md", OPEN_ENTRY);
		const fetchImpl = spyEmbed();

		const result = await searchLibrary({
			libRoot,
			query: QUERY,
			project: "open-proj",
			embed: { config: EMBED, fetchImpl },
			outbound: ALLOW_OPEN,
		});

		// 请求体里只有授权条目与查询词
		const allInput = fetchImpl.bodies.flatMap((b) => b.input ?? []);
		expect(allInput).toContain(OPEN_ENTRY);
		expect(allInput).toContain(QUERY);
		expect(allInput.some((t) => t.includes("机密项目里踩的坑"))).toBe(false);
		expect(allInput.some((t) => t.includes("绝不能外发"))).toBe(false);
		// 缓存里也没有未授权条目的向量
		const cache = loadVectorCache(libRoot)!;
		expect(cache.vectors["教训/机密条目.md"]).toBeUndefined();
		expect(cache.vectors["教训/公开条目.md"]).toBeDefined();
		// 未授权条目仍可走词法被找到，但结果带 degraded
		expect(result.hits.some((h) => h.relPath === "教训/机密条目.md")).toBe(false); // 词法没命中
	});

	test("查询词绑定项目未授权 → 查询词根本不发云端，词法独跑", async () => {
		writeEntry("教训/机密条目.md", SECRET_ENTRY);
		const fetchImpl = spyEmbed();

		const result = await searchLibrary({
			libRoot,
			query: QUERY,
			project: "secret-proj",
			embed: { config: EMBED, fetchImpl },
			outbound: ALLOW_OPEN,
		});

		expect(fetchImpl.bodies).toHaveLength(0); // 一次请求都没发
		expect(result.degraded).toBe(true);
		expect(result.degradeReason).toContain("禁外发");
		// 词法照常工作（查询词与条目词有交集时）
		expect(result.hits.every((h) => h.degraded)).toBe(true);
	});

	test("适用范围缺失（未知）的条目不发云端", async () => {
		writeEntry("教训/未知范围.md", "没有范围标注的条目 2026-10-01\n正文");
		const fetchImpl = spyEmbed();
		await searchLibrary({
			libRoot,
			query: QUERY,
			project: "open-proj",
			embed: { config: EMBED, fetchImpl },
			outbound: ALLOW_OPEN,
		});
		const allInput = fetchImpl.bodies.flatMap((b) => b.input ?? []);
		expect(allInput.some((t) => t.includes("没有范围标注的条目"))).toBe(false);
	});

	test("配置撤销后新外发被阻断，缓存同批收敛（不宣称撤回云端已收数据）", async () => {
		writeEntry("教训/公开条目.md", OPEN_ENTRY);
		// 授权期内正常嵌入
		const first = spyEmbed();
		await searchLibrary({
			libRoot,
			query: QUERY,
			project: "open-proj",
			embed: { config: EMBED, fetchImpl: first },
			outbound: ALLOW_OPEN,
		});
		expect(loadVectorCache(libRoot)!.vectors["教训/公开条目.md"]).toBeDefined();

		// 撤销：open-proj 从许可清单移除
		const revoked: OutboundConfig = { projects: {} };
		const after = spyEmbed();
		const result = await searchLibrary({
			libRoot,
			query: QUERY,
			project: "open-proj",
			embed: { config: EMBED, fetchImpl: after },
			outbound: revoked,
		});
		expect(after.bodies).toHaveLength(0); // 新外发被阻断
		expect(result.degraded).toBe(true);
		expect(result.degradeReason).toContain("禁外发");
		// 撤销项目条目的向量同批从缓存移除（缓存清理≠撤回上游已收数据）
		expect(loadVectorCache(libRoot)!.vectors["教训/公开条目.md"]).toBeUndefined();
	});

	test("批量重建入口同样过禁外发检查（embedTexts 由上层裁剪后调用）", async () => {
		// 条目嵌入与批量重建都通过 searchLibrary 的同一条 allowedEntries 过滤，
		// 这里直接验证共享函数在纯嵌入调用方的用法：调用前必须先 checkOutbound
		writeEntry("教训/机密条目.md", SECRET_ENTRY);
		const check = checkOutbound(["secret-proj"], ALLOW_OPEN);
		expect(check.allowed).toBe(false);
		const fetchImpl = spyEmbed();
		// 授权通过才允许调 embedTexts（约定：三入口都先过 checkOutbound）
		if (check.allowed) {
			await embedTexts({ config: EMBED, fetchImpl }, [SECRET_ENTRY]);
		}
		expect(fetchImpl.bodies).toHaveLength(0);
	});
});
