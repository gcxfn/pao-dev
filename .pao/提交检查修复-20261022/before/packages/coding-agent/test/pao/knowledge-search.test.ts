/**
 * 卡0004 验收 1/2/3：双路合并去重、户口完整、降级与空态。
 * 嵌入全部走 mock fetch，不接真实端点。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type FetchLike, loadEmbedConfig } from "../../src/pao/knowledge/embed.ts";
import type { OutboundConfig } from "../../src/pao/knowledge/outbound.ts";
import { type SearchOptions, searchLibrary } from "../../src/pao/knowledge/search.ts";

const OUTBOUND: OutboundConfig = { projects: { "demo-proj": { allowed: true, asOf: "2099-12-31" } } };

let libRoot: string;

beforeEach(() => {
	libRoot = mkdtempSync(join(tmpdir(), "pao-kb-search-"));
	for (const dir of ["教训", "导览", "做法", "评测", "待验证", "归档"]) {
		mkdirSync(join(libRoot, dir));
	}
});

afterEach(() => {
	rmSync(libRoot, { recursive: true, force: true });
});

const ENTRY_POOL = `MySQL 连接池超时排查 2026-10-01
现象：并发上来后连接池耗尽。
正确做法：调大 pool 上限并加超时。
适用范围: demo-proj
来源: 内部压测`;

const ENTRY_CAP = `容量评估通用清单 2026-10-01
按 QPS 与数据量估算容量。
适用范围: demo-proj
来源: 内部压测`;

const ENTRY_PENDING = `候选：索引缺失导致慢查询 2026-10-01
尚待验证，证据不足。
适用范围: demo-proj`;

/** 「做法」的验证出处标记行（审查第 13 项）：没有这行的做法只能挂待验证，所以「正式做法」夹具必须带上。 */
const VERIFY_LINE = "\n验证出处: 卡0007 2026-10-01 真机验收";
const ENTRY_CAP_VERIFIED = ENTRY_CAP + VERIFY_LINE;
const ENTRY_POOL_VERIFIED = ENTRY_POOL + VERIFY_LINE;

function writeEntry(relPath: string, content: string): void {
	const abs = join(libRoot, relPath);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content, "utf8");
}

interface RecordedCall {
	url: string;
	body: { model?: string; input?: string[] };
}

/** mock 嵌入端点：按文本查固定向量表，记录请求体供外发断言用。 */
function mockEmbed(
	vectors: Record<string, number[]>,
	fallback: number[] = [1, 0],
): FetchLike & { calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const impl = (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
		const body = JSON.parse(init?.body ?? "{}") as { model?: string; input?: string[] };
		calls.push({ url, body });
		const input = body.input ?? [];
		return {
			ok: true,
			status: 200,
			json: async () => ({ data: input.map((t, i) => ({ index: i, embedding: vectors[t] ?? fallback })) }),
		};
	}) as FetchLike & { calls: RecordedCall[] };
	impl.calls = calls;
	return impl;
}

const EMBED = { baseUrl: "http://mock.embed", apiKey: "test-key", model: "mock-embed" };

function search(overrides: Partial<SearchOptions>): ReturnType<typeof searchLibrary> {
	return searchLibrary({ libRoot, query: "连接池 超时", outbound: OUTBOUND, ...overrides });
}

describe("验收1：双路合并去重", () => {
	test("词法与语义同时命中同一批条目，合并后每条只出现一次", async () => {
		writeEntry("教训/mysql-连接池超时.md", ENTRY_POOL);
		writeEntry("做法/容量评估清单.md", ENTRY_CAP_VERIFIED);
		const fetchImpl = mockEmbed({
			[ENTRY_POOL]: [0.1, 0.9],
			[ENTRY_CAP_VERIFIED]: [0.99, 0.01], // 语义高分：与查询向量几乎同向
			"连接池 超时": [1, 0],
		});
		const result = await search({ embed: { config: EMBED, fetchImpl }, project: "demo-proj" });

		expect(result.degraded).toBe(false);
		const paths = result.hits.map((h) => h.relPath);
		// 词法命中的条目不被纯语义高分挤掉（词法保底在列）
		expect(paths).toContain("教训/mysql-连接池超时.md");
		expect(paths).toContain("做法/容量评估清单.md");
		// 合并去重：每条只出现一次
		expect(new Set(paths).size).toBe(paths.length);
		// 每条命中确实同时来自两路：词法条目带语义分，语义条目带词法信息
		const pool = result.hits.find((h) => h.relPath === "教训/mysql-连接池超时.md")!;
		expect(pool.lexicalScore).toBeGreaterThan(0);
		expect(pool.exactLexical).toBe(true);
		const cap = result.hits.find((h) => h.relPath === "做法/容量评估清单.md")!;
		expect(cap.semanticScore).not.toBeNull();
	});

	test("词法精确命中条数超过 top_k 剩余空位时仍全部保底在列", async () => {
		for (const name of ["alpha-连接池.md", "beta-连接池.md", "gamma-连接池.md"]) {
			writeEntry(`教训/${name}`, `${name} 连接池排查 2026-10-01\n内容\n适用范围: demo-proj`);
		}
		writeEntry("做法/无关条目.md", ENTRY_CAP);
		const fetchImpl = mockEmbed({
			[ENTRY_CAP]: [1, 0],
			"连接池 排查": [1, 0],
		});
		// top_k=3：三个词法精确命中 + 语义高分条目，精确命中不被挤出
		const result = await search({
			query: "连接池 排查",
			topK: 3,
			embed: { config: EMBED, fetchImpl },
			project: "demo-proj",
		});
		const paths = result.hits.map((h) => h.relPath);
		expect(paths).toContain("教训/alpha-连接池.md");
		expect(paths).toContain("教训/beta-连接池.md");
		expect(paths).toContain("教训/gamma-连接池.md");
		expect(result.hits.every((h) => h.exactLexical)).toBe(true);
	});
});

describe("验收2：户口完整", () => {
	test("每条命中带 路径/标题路径/摘要/状态/适用范围/最后核验/来源/degraded", async () => {
		writeEntry("教训/mysql-连接池超时.md", ENTRY_POOL);
		const fetchImpl = mockEmbed({ [ENTRY_POOL]: [1, 0], "连接池 超时": [1, 0] });
		const result = await search({ embed: { config: EMBED, fetchImpl }, project: "demo-proj" });

		expect(result.hits).toHaveLength(1);
		const hit = result.hits[0];
		expect(hit.relPath).toBe("教训/mysql-连接池超时.md");
		expect(hit.titlePath).toBe("教训/mysql-连接池超时.md");
		expect(hit.summary).toContain("MySQL 连接池超时排查");
		expect(hit.status).toBe("有效");
		expect(hit.scope).toEqual(["demo-proj"]);
		expect(hit.lastVerified).toBe("2026-10-01");
		expect(hit.source).toBe("内部压测");
		expect(hit.degraded).toBe(false);
	});

	test("待验证区命中只列风险提示区，不挤占正式 top_k", async () => {
		writeEntry("教训/mysql-连接池超时.md", ENTRY_POOL);
		writeEntry("待验证/索引缺失慢查询.md", ENTRY_PENDING);
		const fetchImpl = mockEmbed({ [ENTRY_POOL]: [0.1, 0.9], [ENTRY_PENDING]: [1, 0], "连接池 超时": [1, 0] });
		const result = await search({ embed: { config: EMBED, fetchImpl }, project: "demo-proj" });

		// 待验证条目即使语义分最高，也不进正式 hits
		expect(result.hits.map((h) => h.relPath)).toEqual(["教训/mysql-连接池超时.md"]);
		expect(result.riskHits.map((h) => h.relPath)).toEqual(["待验证/索引缺失慢查询.md"]);
		expect(result.riskHits[0].status).toBe("待验证");
	});

	test("适用范围缺失标「未知」状态，不自动认有效（R08）", async () => {
		writeEntry("教训/无范围条目.md", "无范围的教训 2026-10-01\n正文");
		const result = await search({ query: "无范围" });
		expect(result.hits).toHaveLength(0);
		expect(result.riskHits[0].status).toBe("未知");
		expect(result.riskHits[0].scope).toBeNull();
	});

	test("超期条目命中标 待复核⚠️（返回前顺手轻量机械核验）", async () => {
		writeEntry("教训/老条目.md", "连接池 老教训 2026-01-01\n正文\n适用范围: demo-proj");
		const result = await search({
			query: "连接池",
			staleDays: 90,
			now: new Date("2026-10-02T00:00:00"),
		});
		expect(result.hits).toHaveLength(0);
		expect(result.riskHits[0].status).toBe("待复核⚠️");
	});

	test("风险高分不挤占正式 top_k；期望版本仅让匹配版本的条目进入正式结果", async () => {
		writeEntry("教训/连接池旧版.md", "连接池旧版 2026-10-01 版本:v1\n正文\n适用范围: demo-proj");
		writeEntry("做法/连接池新版.md", `连接池新版 2026-10-01 版本:v2\n正文\n适用范围: demo-proj${VERIFY_LINE}`);
		const result = await search({
			query: "连接池",
			topK: 1,
			embed: null,
			expectedVersion: "v2",
			now: new Date("2026-10-02T00:00:00"),
		});
		expect(result.hits.map((hit) => hit.relPath)).toEqual(["做法/连接池新版.md"]);
		expect(result.hits[0].status).toBe("有效");
		expect(result.riskHits.map((hit) => hit.relPath)).toEqual(["教训/连接池旧版.md"]);
		expect(result.riskHits[0].status).toBe("待复核⚠️");
	});

	test("明确查询版本时缺版本只作提示；未指定版本的通用知识保持可用", async () => {
		writeEntry("做法/连接池通用.md", ENTRY_POOL_VERIFIED);
		const versioned = await search({
			query: "连接池",
			embed: null,
			expectedVersion: "v2",
			now: new Date("2026-10-02T00:00:00"),
		});
		expect(versioned.hits).toHaveLength(0);
		expect(versioned.riskHits[0].status).toBe("未知");
		const generic = await search({ query: "连接池", embed: null, now: new Date("2026-10-02T00:00:00") });
		expect(generic.hits.map((hit) => hit.relPath)).toEqual(["做法/连接池通用.md"]);
	});

	test("正文已标待复核的条目即使日期新鲜也不作为正式依据", async () => {
		writeEntry("教训/连接池待复核.md", `${ENTRY_POOL}\n状态: 待复核⚠️`);
		const result = await search({ query: "连接池", embed: null });
		expect(result.hits).toHaveLength(0);
		expect(result.riskHits[0].status).toBe("待复核⚠️");
	});

	test("审查第 13 项：做法缺「验证出处」只作待验证，并披露缺的是什么", async () => {
		// 有日期、适用范围、来源的「做法」，唯独没有「验证出处:」——不能当正式依据
		writeEntry("做法/没出处的做法.md", "连接池调优 2026-10-01\n正文\n适用范围: demo-proj\n来源: 内部压测");
		const result = await search({ query: "连接池", embed: null });
		expect(result.hits).toHaveLength(0);
		expect(result.riskHits.map((h) => h.relPath)).toEqual(["做法/没出处的做法.md"]);
		expect(result.riskHits[0].status).toBe("待验证");
		expect(result.riskHits[0].unverifiedReason).toContain("验证出处");
	});

	test("审查第 13 项：有验证出处且其他条件合格的做法仍是正式依据；其他类型不被无差别降级", async () => {
		writeEntry("做法/有出处的做法.md", `连接池调优 2026-10-01\n正文\n适用范围: demo-proj${VERIFY_LINE}`);
		// 教训没有「验证出处」的概念，不该被这条规则降级
		writeEntry("教训/同款教训.md", "连接池调优 2026-10-01\n正文\n适用范围: demo-proj");
		const result = await search({ query: "连接池", embed: null });
		expect(result.hits.map((h) => h.relPath).sort()).toEqual(["做法/有出处的做法.md", "教训/同款教训.md"]);
		expect(result.hits.every((h) => h.unverifiedReason === undefined)).toBe(true);
		expect(result.riskHits).toHaveLength(0);
	});
});

describe("验收3：降级与空态", () => {
	test("未配置 EMBED_* 环境变量 → 词法独跑 + degraded=true", async () => {
		writeEntry("教训/mysql-连接池超时.md", ENTRY_POOL);
		// 显式传 null（端点未配置）；loadEmbedConfig 对空环境同样返回 null
		const result = await search({ embed: null });
		expect(result.degraded).toBe(true);
		expect(result.degradeReason).toContain("未配置");
		expect(result.hits.map((h) => h.relPath)).toContain("教训/mysql-连接池超时.md");
		expect(result.hits.every((h) => h.degraded)).toBe(true);
		expect(loadEmbedConfig({})).toBeNull();
		expect(loadEmbedConfig({ EMBED_BASE_URL: "http://x", EMBED_API_KEY: "k" })).toBeNull(); // 缺 MODEL 也不可用
	});

	test("mock 嵌入抛错 → 同样降级不崩，词法结果照常返回", async () => {
		writeEntry("教训/mysql-连接池超时.md", ENTRY_POOL);
		const failing = (async () => {
			throw new Error("网络不通");
		}) as unknown as FetchLike;
		const result = await search({ embed: { config: EMBED, fetchImpl: failing }, project: "demo-proj" });
		expect(result.degraded).toBe(true);
		expect(result.degradeReason).toContain("嵌入调用失败");
		expect(result.hits.map((h) => h.relPath)).toContain("教训/mysql-连接池超时.md");
	});

	test("两路都无命中 → 明确「无可用依据」空态", async () => {
		writeEntry("教训/mysql-连接池超时.md", ENTRY_POOL);
		const result = await search({ query: "kubernetes 网络策略 完全无关" });
		expect(result.hits).toHaveLength(0);
		expect(result.riskHits).toHaveLength(0);
		expect(result.emptyReason).toContain("无可用依据");
	});
});
