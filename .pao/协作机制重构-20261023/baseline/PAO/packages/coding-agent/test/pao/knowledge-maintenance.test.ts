/**
 * M2-05 知识维护异常路径：并发晋升（G2-08）、缓存污染与外发撤销、重建失败。
 * - 并发晋升：两会话同时入库同一候选——临界区互斥（子索引文件锁同锁移动）、后到者按幂等重放收尾；
 * - 外发撤销：撤销后旧向量缓存不再被语义路使用（重查重新过门，再授权才重嵌）；
 * - 缓存损坏：坏 JSON / 坏格式版本 → 当无缓存重建，不崩查库；
 * - 重建失败：嵌入中途中断 → 降级不落盘，下次查库按需续建（sha1 增量）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadVectorCache } from "../../src/pao/knowledge/cache.ts";
import type { FetchLike } from "../../src/pao/knowledge/embed.ts";
import { ingestEntry } from "../../src/pao/knowledge/ingest.ts";
import type { OutboundConfig } from "../../src/pao/knowledge/outbound.ts";
import { vectorCachePath } from "../../src/pao/knowledge/paths.ts";
import { searchLibrary } from "../../src/pao/knowledge/search.ts";
import type { SearchResult } from "../../src/pao/knowledge/types.ts";
import { withFileLock } from "../../src/pao/shared/lock.ts";

let libRoot: string;

beforeEach(() => {
	libRoot = mkdtempSync(join(tmpdir(), "pao-kb-maint-"));
	for (const dir of ["教训", "导览", "做法", "评测", "待验证", "归档"]) {
		mkdirSync(join(libRoot, dir));
	}
});

afterEach(() => {
	rmSync(libRoot, { recursive: true, force: true });
});

const ENTRY_A = `连接池排查 2026-10-01
正文A
适用范围: demo-proj`;
const ENTRY_B = `索引优化 2026-10-01
正文B
适用范围: demo-proj`;
const QUERY = "连接池 问题";
const EMBED = { baseUrl: "http://mock.embed", apiKey: "test-key", model: "mock-embed" };
const OUTBOUND: OutboundConfig = { projects: { "demo-proj": { allowed: true, asOf: "2026-10-02" } } };

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

function doSearch(fetchImpl: FetchLike, overrides: Record<string, unknown> = {}): Promise<SearchResult> {
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

describe("M2-05：并发晋升同一候选（G2-08）", () => {
	test("两会话 Promise.all 同时入库同一候选 → 都成功、只有一个执行移动、子索引一行不重复", async () => {
		const candidate = join(libRoot, "待验证", "连接池.md");
		writeFileSync(candidate, ENTRY_A, "utf8");

		const [a, b] = await Promise.all([
			ingestEntry({ libRoot, candidatePath: candidate, type: "教训" }),
			ingestEntry({ libRoot, candidatePath: candidate, type: "教训" }),
		]);

		// 都成功收尾，不崩不半途
		expect(existsSync(join(libRoot, "教训/连接池.md"))).toBe(true);
		expect(existsSync(candidate)).toBe(false);
		// 后到者按幂等重放收尾：恰好一个执行移动，另一个报「已在目标位」
		const moved = [a, b].filter((r) => !r.alreadyPromoted);
		const replayed = [a, b].filter((r) => r.alreadyPromoted);
		expect(moved).toHaveLength(1);
		expect(replayed).toHaveLength(1);
		expect(replayed[0]!.actions.join("\n")).toContain("条目已在目标位，跳过移动");
		// 子索引恰好一行（行可由条目校验，不重复生成）
		const rows = readFileSync(join(libRoot, "教训", "子索引.md"), "utf8")
			.split("\n")
			.filter((l) => l.trim().startsWith("- ["));
		expect(rows).toHaveLength(1);
	});

	test("临界区互斥：他方持锁时入库在锁上排队，持锁释放后才完成", async () => {
		const candidate = join(libRoot, "待验证", "互斥.md");
		writeFileSync(candidate, ENTRY_A, "utf8");
		const lockTarget = join(libRoot, "教训", "子索引.md");

		let release!: () => void;
		const held = withFileLock(lockTarget, async () => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		});

		const ingesting = ingestEntry({ libRoot, candidatePath: candidate, type: "教训" });
		// 持锁期间入库不得完成（临界区互斥，不绕锁硬写）
		const loser = await Promise.race([
			ingesting.then(() => "done"),
			new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 300)),
		]);
		expect(loser).toBe("pending");

		release();
		await held;
		const result = await ingesting;
		expect(result.alreadyPromoted).toBe(false);
		expect(existsSync(join(libRoot, "教训/互斥.md"))).toBe(true);
	});
});

describe("M2-05：外发撤销后旧向量缓存不再被语义路使用", () => {
	test("授权→缓存→撤销：重查降级、语义分清零、缓存收敛；再授权→重新过门重嵌", async () => {
		writeEntry("教训/公开条目.md", ENTRY_A);
		// 授权期内：正常嵌入并落缓存
		const first = mockEmbed({ [ENTRY_A]: [1, 0], [QUERY]: [1, 0] });
		const ok = await doSearch(first);
		expect(ok.degraded).toBe(false);
		expect(ok.hits[0]!.semanticScore).not.toBeNull();
		expect(loadVectorCache(libRoot)!.vectors["教训/公开条目.md"]).toBeDefined();

		// 撤销（许可清单清空）后重查：新外发阻断、旧向量不参与语义路
		const revoked = mockEmbed({ [QUERY]: [1, 0] });
		const after = await doSearch(revoked, { outbound: { projects: {} } });
		expect(after.degraded).toBe(true);
		expect(after.degradeReason).toContain("禁外发");
		expect(revoked.calls.flatMap((c) => c.input)).not.toContain(ENTRY_A); // 条目正文不出库
		for (const hit of after.hits) {
			expect(hit.semanticScore).toBeNull(); // 旧缓存向量不参与打分
		}
		expect(loadVectorCache(libRoot)!.vectors["教训/公开条目.md"]).toBeUndefined(); // 同批收敛

		// 重新过门：再授权后重查 → 条目重新嵌入（重查重新过门，不沿用撤销期状态）
		const reguard = mockEmbed({ [ENTRY_A]: [1, 0], [QUERY]: [1, 0] });
		const again = await doSearch(reguard);
		expect(again.degraded).toBe(false);
		expect(reguard.calls.flatMap((c) => c.input)).toContain(ENTRY_A);
		expect(again.hits[0]!.semanticScore).not.toBeNull();
	});

	test("撤销条目级授权（适用范围改绑他项目）→ 同批裁出缓存，语义路不再使用", async () => {
		writeEntry("教训/绑A.md", ENTRY_A);
		const first = mockEmbed({ [ENTRY_A]: [1, 0], [QUERY]: [1, 0] });
		await doSearch(first);
		expect(loadVectorCache(libRoot)!.vectors["教训/绑A.md"]).toBeDefined();

		// 条目适用范围改为未授权项目 → 下次查询允许项目保持 demo-proj，该条目裁出缓存
		writeEntry("教训/绑A.md", `连接池排查 2026-10-01\n正文A\n适用范围: secret-proj`);
		const after = mockEmbed({});
		const result = await doSearch(after);
		expect(loadVectorCache(libRoot)!.vectors["教训/绑A.md"]).toBeUndefined();
		const hit = result.hits.find((h) => h.relPath === "教训/绑A.md");
		if (hit) expect(hit.semanticScore).toBeNull(); // 词法可命中，语义分必须为空
	});
});

describe("M2-05：缓存文件损坏 → 当无缓存重建，不崩查库", () => {
	test("坏 JSON：查库照常、按无缓存全量重嵌、缓存文件被重建为合法 JSON", async () => {
		writeEntry("教训/条目A.md", ENTRY_A);
		writeEntry("教训/条目B.md", ENTRY_B);
		writeFileSync(vectorCachePath(libRoot), "{{{坏掉的JSON", "utf8");

		const fetchImpl = mockEmbed({ [ENTRY_A]: [1, 0], [ENTRY_B]: [0, 1], [QUERY]: [1, 0] });
		const result = await doSearch(fetchImpl);

		expect(result.degraded).toBe(false); // 不崩、不因缓存损坏降级
		expect(fetchImpl.calls.flatMap((c) => c.input)).toEqual(expect.arrayContaining([ENTRY_A, ENTRY_B]));
		const cache = loadVectorCache(libRoot);
		expect(cache).not.toBeNull(); // 已重建为合法缓存
		expect(Object.keys(cache!.vectors)).toHaveLength(2);
	});

	test("坏格式版本：formatVersion 不认 → 同样整体重建", async () => {
		writeEntry("教训/条目A.md", ENTRY_A);
		writeFileSync(
			vectorCachePath(libRoot),
			JSON.stringify({ formatVersion: 99, embedModel: "mock-embed", chunkParams: {}, vectors: {} }),
			"utf8",
		);
		const fetchImpl = mockEmbed({ [ENTRY_A]: [1, 0], [QUERY]: [1, 0] });
		await doSearch(fetchImpl);
		expect(fetchImpl.calls.flatMap((c) => c.input)).toContain(ENTRY_A); // 旧缓存整体弃用
	});
});

describe("M2-05：重建中断 → 下次查库按需续建", () => {
	test("嵌入中途中断：降级、缓存不落盘污染；下次查库把缺失条目续建齐", async () => {
		writeEntry("教训/条目A.md", ENTRY_A);
		writeEntry("教训/条目B.md", ENTRY_B);
		// 第一轮成功：缓存落盘
		await doSearch(mockEmbed({ [ENTRY_A]: [1, 0], [ENTRY_B]: [0, 1], [QUERY]: [1, 0] }));
		const onDiskBefore = loadVectorCache(libRoot)!;

		// 两条目内容都改 → 需要重建；但嵌入端中途抛错
		const A2 = `连接池排查 2026-10-02\n正文A2\n适用范围: demo-proj`;
		const B2 = `索引优化 2026-10-02\n正文B2\n适用范围: demo-proj`;
		writeEntry("教训/条目A.md", A2);
		writeEntry("教训/条目B.md", B2);
		const failing = (async () => {
			throw new Error("嵌入请求中断");
		}) as unknown as FetchLike;
		const interrupted = await doSearch(failing);
		expect(interrupted.degraded).toBe(true);
		expect(interrupted.degradeReason).toContain("嵌入调用失败");

		// 盘上缓存不被半截重建污染：仍是中断前的旧内容（按 sha1 判定）
		const onDiskAfter = loadVectorCache(libRoot)!;
		expect(onDiskAfter.vectors["教训/条目A.md"]!.sha1).toBe(onDiskBefore.vectors["教训/条目A.md"]!.sha1);

		// 恢复后查库：两个改过的条目都续建（不只处理新增），缓存重新可用
		const recovered = mockEmbed({ [A2]: [1, 0], [B2]: [0, 1], [QUERY]: [1, 0] });
		const result = await doSearch(recovered);
		expect(result.degraded).toBe(false);
		expect(recovered.calls.flatMap((c) => c.input)).toEqual(expect.arrayContaining([A2, B2]));
		expect(Object.keys(loadVectorCache(libRoot)!.vectors)).toHaveLength(2);
	});
});
