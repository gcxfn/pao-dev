/**
 * 卡0004 验收 4：向量缓存——记录模型与切分参数、变化整体重建、
 * 删文件重建、条目修改/归档/删除同批失效（不只处理新增）。
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadVectorCache } from "../../src/pao/knowledge/cache.ts";
import type { FetchLike } from "../../src/pao/knowledge/embed.ts";
import type { OutboundConfig } from "../../src/pao/knowledge/outbound.ts";
import { vectorCachePath } from "../../src/pao/knowledge/paths.ts";
import { scanLibrary, searchLibrary } from "../../src/pao/knowledge/search.ts";
import type { EntryMeta } from "../../src/pao/knowledge/types.ts";

let libRoot: string;

beforeEach(() => {
	libRoot = mkdtempSync(join(tmpdir(), "pao-kb-cache-"));
	for (const dir of ["教训", "导览", "做法", "评测", "待验证", "归档"]) {
		mkdirSync(join(libRoot, dir));
	}
});

afterEach(() => {
	rmSync(libRoot, { recursive: true, force: true });
});

const ENTRY_A = `连接池排查 2026-10-01\n正文A\n适用范围: demo-proj`;
const ENTRY_B = `索引优化 2026-10-01\n正文B\n适用范围: demo-proj`;
const QUERY = "数据库 问题";

function writeEntry(relPath: string, content: string): void {
	const abs = join(libRoot, relPath);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content, "utf8");
}

interface RecordedCall {
	input: string[];
}

function mockEmbed(vectors: Record<string, number[]>): FetchLike & { calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const impl = (async (_url: string, init?: { body?: string }) => {
		const body = JSON.parse(init?.body ?? "{}") as { input?: string[] };
		const input = body.input ?? [];
		calls.push({ input });
		return {
			ok: true,
			status: 200,
			json: async () => ({ data: input.map((t, i) => ({ index: i, embedding: vectors[t] ?? [0.5, 0.5] })) }),
		};
	}) as FetchLike & { calls: RecordedCall[] };
	impl.calls = calls;
	return impl;
}

const EMBED = { baseUrl: "http://mock.embed", apiKey: "test-key", model: "mock-embed" };
const VECTORS = { [ENTRY_A]: [1, 0], [ENTRY_B]: [0, 1], [QUERY]: [1, 0] };
const OUTBOUND: OutboundConfig = { projects: { "demo-proj": { allowed: true, asOf: "2026-10-02" } } };

function doSearch(fetchImpl: FetchLike, overrides: Record<string, unknown> = {}): Promise<unknown> {
	return searchLibrary({
		libRoot,
		query: QUERY,
		embed: { config: EMBED, fetchImpl },
		project: "demo-proj",
		outbound: OUTBOUND,
		now: new Date("2026-10-02T00:00:00"),
		...overrides,
	});
}

describe("验收4：缓存重建与失效", () => {
	test("缓存 JSON 记录嵌入模型与切分参数", async () => {
		writeEntry("教训/条目A.md", ENTRY_A);
		writeEntry("教训/条目B.md", ENTRY_B);
		const fetchImpl = mockEmbed(VECTORS);
		await doSearch(fetchImpl);
		const cache = loadVectorCache(libRoot);
		expect(cache).not.toBeNull();
		expect(cache!.embedModel).toBe("mock-embed");
		expect(cache!.chunkParams).toEqual({ granularity: "whole-entry", version: 1 });
		expect(Object.keys(cache!.vectors).sort()).toEqual(["教训/条目A.md", "教训/条目B.md"].sort());
	});

	test("改嵌入模型或切分参数 → 旧缓存整体失效重建", async () => {
		writeEntry("教训/条目A.md", ENTRY_A);
		writeEntry("教训/条目B.md", ENTRY_B);
		const fetch1 = mockEmbed(VECTORS);
		await doSearch(fetch1);
		// 命中缓存：第二次查询只嵌查询词
		const fetch2 = mockEmbed(VECTORS);
		await doSearch(fetch2);
		const embeddedAfterWarm = fetch2.calls.flatMap((c) => c.input);
		expect(embeddedAfterWarm).not.toContain(ENTRY_A);
		// 换模型 → 全部条目重新嵌入
		const fetch3 = mockEmbed(VECTORS);
		await doSearch(fetch3, { embed: { config: { ...EMBED, model: "mock-embed-v2" }, fetchImpl: fetch3 } });
		expect(fetch3.calls.flatMap((c) => c.input)).toEqual(expect.arrayContaining([ENTRY_A, ENTRY_B]));
		// 换切分参数 → 同样整体重建
		const fetch4 = mockEmbed(VECTORS);
		await doSearch(fetch4, { chunkParams: { granularity: "section", version: 1 } });
		expect(fetch4.calls.flatMap((c) => c.input)).toEqual(expect.arrayContaining([ENTRY_A, ENTRY_B]));
	});

	test("删缓存文件 → 从库重建", async () => {
		writeEntry("教训/条目A.md", ENTRY_A);
		writeEntry("教训/条目B.md", ENTRY_B);
		await doSearch(mockEmbed(VECTORS));
		expect(existsSync(vectorCachePath(libRoot))).toBe(true);
		unlinkSync(vectorCachePath(libRoot));
		const fetch2 = mockEmbed(VECTORS);
		await doSearch(fetch2);
		expect(fetch2.calls.flatMap((c) => c.input)).toEqual(expect.arrayContaining([ENTRY_A, ENTRY_B]));
		const cache = loadVectorCache(libRoot);
		expect(Object.keys(cache!.vectors)).toHaveLength(2);
	});

	test("坏缓存（vectors: null 或数组）→ 按损坏处理，主查询不抛异常走重建", async () => {
		writeEntry("教训/条目A.md", ENTRY_A);
		writeEntry("教训/条目B.md", ENTRY_B);
		const badCache = (vectors: unknown) =>
			JSON.stringify({
				formatVersion: 1,
				embedModel: "mock-embed",
				chunkParams: { granularity: "whole-entry", version: 1 },
				vectors,
			});
		writeFileSync(vectorCachePath(libRoot), badCache(null), "utf8");
		expect(loadVectorCache(libRoot)).toBeNull();
		const fetch1 = mockEmbed(VECTORS);
		await expect(doSearch(fetch1)).resolves.toBeTruthy();
		expect(fetch1.calls.flatMap((c) => c.input)).toEqual(expect.arrayContaining([ENTRY_A, ENTRY_B]));
		writeFileSync(vectorCachePath(libRoot), badCache([]), "utf8");
		expect(loadVectorCache(libRoot)).toBeNull();
		const fetch2 = mockEmbed(VECTORS);
		await expect(doSearch(fetch2)).resolves.toBeTruthy();
	});

	test("条目修改 → 只重嵌该条目（不只处理新增）", async () => {
		writeEntry("教训/条目A.md", ENTRY_A);
		writeEntry("教训/条目B.md", ENTRY_B);
		await doSearch(mockEmbed(VECTORS));
		// 热缓存下再查：只嵌查询词
		const warm = mockEmbed(VECTORS);
		await doSearch(warm);
		expect(warm.calls.flatMap((c) => c.input)).toEqual([QUERY]);
		// 修改条目 A → 下次查询只补嵌 A + 查询词
		const entryA2 = `连接池排查 2026-10-02\n正文A 改过了\n适用范围: demo-proj`;
		writeEntry("教训/条目A.md", entryA2);
		const after = mockEmbed({ ...VECTORS, [entryA2]: [1, 0] });
		await doSearch(after);
		expect(after.calls.flatMap((c) => c.input)).toEqual(expect.arrayContaining([entryA2]));
		expect(after.calls.flatMap((c) => c.input)).not.toContain(ENTRY_B);
		const cache = loadVectorCache(libRoot)!;
		expect(Object.keys(cache.vectors)).toHaveLength(2);
	});

	test("热缓存二次查询零变化：不重嵌条目、缓存文件零变化不写盘", async () => {
		writeEntry("教训/条目A.md", ENTRY_A);
		writeEntry("教训/条目B.md", ENTRY_B);
		await doSearch(mockEmbed(VECTORS)); // 建缓存（含 mtime+size+meta 快照）
		const cacheFile = vectorCachePath(libRoot);
		const before = readFileSync(cacheFile, "utf8");
		const beforeStat = statSync(cacheFile).mtimeMs;
		const warm = mockEmbed(VECTORS);
		await doSearch(warm);
		// 只嵌查询词：条目经 mtime+size 判未变，不重读重算重嵌
		expect(warm.calls.flatMap((c) => c.input)).toEqual([QUERY]);
		// 缓存内容零变化 → 不重写（字节与 mtime 均不变）
		expect(readFileSync(cacheFile, "utf8")).toBe(before);
		expect(statSync(cacheFile).mtimeMs).toBe(beforeStat);
	});

	test("scanLibrary 命中 trusted（mtime+size 一致）的条目零读盘：meta 用缓存快照", () => {
		writeEntry("教训/条目A.md", ENTRY_A);
		const abs = join(libRoot, "教训/条目A.md");
		// 旧缓存判据的 mtime 钉到 60 秒前：与磁盘现状必然差出毫秒——mtime 维度有鉴别力的前提
		const past = new Date(Date.now() - 60_000);
		utimesSync(abs, past, past);
		const stat = statSync(abs);
		const meta: EntryMeta = {
			relPath: "教训/条目A.md",
			area: "教训",
			fileName: "条目A.md",
			hook: "缓存快照钩子",
			lastVerified: "2026-10-01",
			version: null,
			declaredStatus: null,
			scope: ["demo-proj"],
			source: null,
			验证出处: null,
		};
		// 把条目文件换成同名目录：statSync 正常、readFileSync 必抛 EISDIR——
		// trusted 命中（mtime+size 与缓存一致）时若仍读盘，本测试直接炸
		rmSync(abs);
		mkdirSync(abs);
		const dirStat = statSync(abs);
		// 夹具自证：mtime 与 size 两维度都确有差异（任一相同会使对应变异逃逸，这里大声失败）
		expect(stat.mtimeMs).not.toBe(dirStat.mtimeMs);
		expect(stat.size).not.toBe(dirStat.size);
		const trusted = {
			"教训/条目A.md": {
				sha1: "deadbeef",
				mtime: dirStat.mtimeMs,
				size: dirStat.size,
				meta,
				embedding: [],
			},
		};
		const entries = scanLibrary(libRoot, { trusted });
		expect(entries[0].meta.hook).toBe("缓存快照钩子");
		// 同 size 不同 mtime（等长改写后的旧缓存判据）→ 不信缓存，现读现解析（目录读盘抛 EISDIR 如实上抛）；
		// 只比 size 不比 mtime 的变异会命中 trusted 不读盘 → 本断言转红
		expect(() =>
			scanLibrary(libRoot, {
				trusted: {
					...trusted,
					"教训/条目A.md": { ...trusted["教训/条目A.md"], mtime: stat.mtimeMs },
				},
			}),
		).toThrow();
		// 同 mtime 不同 size（内容变长后的旧缓存判据）→ 同样不信缓存
		expect(() =>
			scanLibrary(libRoot, {
				trusted: {
					...trusted,
					"教训/条目A.md": { ...trusted["教训/条目A.md"], size: stat.size },
				},
			}),
		).toThrow();
	});

	test("条目原样重落（mtime 变、内容不变）→ 免重嵌，且刷新判据后下次免读", async () => {
		writeEntry("教训/条目A.md", ENTRY_A);
		writeEntry("教训/条目B.md", ENTRY_B);
		await doSearch(mockEmbed(VECTORS));
		// touch：同内容重写（mtime/size 漂移但 sha1 相同）
		const touch = new Date(Date.now() + 5000);
		utimesSync(join(libRoot, "教训/条目A.md"), touch, touch);
		const after = mockEmbed(VECTORS);
		await doSearch(after);
		// 内容未变 → 不重嵌条目
		expect(after.calls.flatMap((c) => c.input)).toEqual([QUERY]);
		const cache = loadVectorCache(libRoot)!;
		expect(cache.vectors["教训/条目A.md"]).toMatchObject({ sha1: expect.any(String) });
	});

	test("条目归档/删除 → 向量与候选同批失效", async () => {
		writeEntry("教训/条目A.md", ENTRY_A);
		writeEntry("教训/条目B.md", ENTRY_B);
		await doSearch(mockEmbed(VECTORS));
		// 归档 A
		renameSync(join(libRoot, "教训/条目A.md"), join(libRoot, "归档/条目A.md"));
		const afterArchive = mockEmbed(VECTORS);
		const archiveResult = (await doSearch(afterArchive)) as { hits: Array<{ relPath: string }> };
		expect(archiveResult.hits.map((h) => h.relPath)).not.toContain("教训/条目A.md");
		let cache = loadVectorCache(libRoot)!;
		expect(cache.vectors["教训/条目A.md"]).toBeUndefined();
		// 删除 B
		rmSync(join(libRoot, "教训/条目B.md"));
		await doSearch(mockEmbed(VECTORS));
		cache = loadVectorCache(libRoot)!;
		expect(cache.vectors["教训/条目B.md"]).toBeUndefined();
		expect(Object.keys(cache.vectors)).toHaveLength(0);
	});
});
