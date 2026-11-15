/**
 * 自动路由门面验收（架构 §18.3/§18.4，M2-05）：pao_query_kb 路由:"自动"。
 * 钉死的硬约束：不传 路由 参数时现有行为逐字节不变（对照 knowledge-search/tools 的关键断言）。
 * 隔离临时目录建多库＋注册表（照抄 knowledge-search.test.ts 的建库夹具模式），不触真实 PAO_HOME。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type DeptRegistryRow, formatRegistry } from "../../src/pao/dept/registry.ts";
import { type AutoRouteResult, autoPatrol, labelHit } from "../../src/pao/knowledge/auto-route.ts";
import type { OutboundConfig } from "../../src/pao/knowledge/outbound.ts";
import { registerKnowledgeTools } from "../../src/pao/knowledge/tools.ts";
import type { SearchResult } from "../../src/pao/knowledge/types.ts";
import type { MemoryHit } from "../../src/pao/memory/memory-vendor.ts";

const OUTBOUND: OutboundConfig = { projects: { "demo-proj": { allowed: true, asOf: "2099-12-31" } } };

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "pao-kb-auto-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

/** 建一个部门知识库骨架（六目录，照 knowledge-search.test.ts 夹具） */
function makeDeptLib(homeDir: string, dept: string): string {
	const libRoot = join(homeDir, "部门", dept, "知识库");
	for (const dir of ["教训", "导览", "做法", "评测", "待验证", "归档"]) {
		mkdirSync(join(libRoot, dir), { recursive: true });
	}
	return libRoot;
}

function writeEntry(libRoot: string, relPath: string, content: string): void {
	writeFileSync(join(libRoot, relPath), content, "utf8");
}

function writeRegistry(homeDir: string, rows: DeptRegistryRow[]): void {
	mkdirSync(join(homeDir, "部门"), { recursive: true });
	writeFileSync(join(homeDir, "部门", "注册表.md"), formatRegistry(rows), "utf8");
}

const ENTRY = (hook: string) => `${hook} 2026-10-01\n正文内容\n适用范围: demo-proj\n来源: 内部`;

/** 默认注册表：三行——两业务部＋主控部（主控部无特殊分支，照常参与路由） */
function defaultRows(): DeptRegistryRow[] {
	return [
		{ 名字: "后端", 标签: ["MySQL", "数据库", "API"], 库路径: "部门/后端/知识库", 建部日期: "2026-10-01" },
		{ 名字: "平台评测", 标签: ["性能", "基准测试"], 库路径: "部门/平台评测/知识库", 建部日期: "2026-10-01" },
		{ 名字: "主控部", 标签: ["调度", "编排", "验收"], 库路径: "部门/主控部/知识库", 建部日期: "2026-10-01" },
	];
}

/** 默认夹具：三库齐建＋注册表＋每库一条典型条目 */
function buildDefaultFixture(): void {
	writeRegistry(home, defaultRows());
	const backend = makeDeptLib(home, "后端");
	const evalLib = makeDeptLib(home, "平台评测");
	const controller = makeDeptLib(home, "主控部");
	writeEntry(backend, "教训/mysql-连接池.md", ENTRY("MySQL 连接池超时排查"));
	writeEntry(evalLib, "评测/qps-基准.md", ENTRY("QPS 性能基准测试"));
	writeEntry(controller, "教训/派卡节奏.md", ENTRY("调度 派卡节奏经验"));
}

interface RegisteredTool {
	name: string;
	definition: ToolDefinition<TSchema, unknown, unknown>;
}

function fakePi(): ExtensionAPI & { registered: RegisteredTool[] } {
	const registered: RegisteredTool[] = [];
	const api = {
		registerTool(definition: ToolDefinition<TSchema, unknown, unknown>) {
			registered.push({ name: definition.name, definition });
		},
	};
	return Object.assign(api, { registered }) as never;
}

function registerTool(options: Parameters<typeof registerKnowledgeTools>[1] = {}) {
	const pi = fakePi();
	registerKnowledgeTools(pi, { embed: null, outbound: OUTBOUND, defaultProject: "demo-proj", ...options });
	return pi.registered.find((t) => t.name === "pao_query_kb")!.definition;
}

/** PAO_HOME 环境隔离：执行期间指向临时 home，完了恢复（异步安全版） */
async function withPaoHome<T>(homeDir: string, fn: () => Promise<T>): Promise<T> {
	const old = process.env.PAO_HOME;
	process.env.PAO_HOME = homeDir;
	try {
		return await fn();
	} finally {
		if (old === undefined) delete process.env.PAO_HOME;
		else process.env.PAO_HOME = old;
	}
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
	return result.content[0].type === "text" ? (result.content[0].text ?? "") : "";
}

describe("硬约束：不传 路由 参数时现有行为逐字节不变", () => {
	test("显式 知识库路径 查库照旧：词法独跑降级＋户口完整，且无任何自动路由标注", async () => {
		const libRoot = makeDeptLib(home, "独立库");
		writeEntry(libRoot, "教训/连接池.md", ENTRY("连接池排查"));
		const tool = registerTool();
		const result = await tool.execute(
			"id",
			{ query: "连接池", kb_path: libRoot } as never,
			undefined,
			undefined,
			{} as never,
		);
		expect(result.isError).toBeUndefined();
		const text = textOf(result as never);
		// 对照 knowledge-search.test.ts 关键断言：降级标注＋降级原因＋命中路径＋户口字段
		expect(text).toContain("[降级]");
		const details = result.details as SearchResult;
		expect(details.degraded).toBe(true);
		expect(details.degradeReason).toContain("未配置");
		expect(details.hits.map((h) => h.relPath)).toContain("教训/连接池.md");
		expect(details.hits.every((h) => h.degraded)).toBe(true);
		expect(text).toContain('"status"');
		// 自动路由未介入
		expect(text).not.toContain("[自动路由]");
		expect(text).not.toContain("语义库");
		expect("路由部门" in (result.details as object)).toBe(false);
	});

	test("部门与知识库路径都不传 → 原样 isError 提示用法，不落入自动路由", async () => {
		const tool = registerTool();
		const result = await tool.execute("id", { query: "x" } as never, undefined, undefined, {} as never);
		expect(result.isError).toBe(true);
		expect(textOf(result as never)).toContain("dept");
	});

	test("注册参数签名不变：仍是四个工具，pao_query_kb 新增的 路由 是可选参数", () => {
		const pi = fakePi();
		registerKnowledgeTools(pi, { embed: null });
		expect(pi.registered.map((t) => t.name)).toEqual([
			"pao_query_kb",
			"pao_restricted_query",
			"pao_ingest_kb",
			"pao_inspect_kb",
		]);
		const params = pi.registered[0].definition.parameters as { properties: Record<string, unknown> };
		expect(Object.keys(params.properties)).toContain("routing");
		expect(params.properties.routing).toMatchObject({ const: "auto" });
	});
});

describe("机械匹配规则（纯函数）", () => {
	test("大小写不敏感、双向子串；单字不参与包含匹配防噪声", () => {
		expect(labelHit("mysql", "MySQL")).toBe(true);
		expect(labelHit("mysql连接池", "MySQL")).toBe(true);
		expect(labelHit("数据库", "mysql数据库调优")).toBe(true);
		expect(labelHit("池", "数据库")).toBe(false);
		expect(labelHit("超时", "性能")).toBe(false);
	});
});

describe("自动模式：路由与并行合并", () => {
	test("标签命中路由只查命中库：未命中部门的库不被查询（其库目录缺失也不进失败库）", async () => {
		// 只建 后端 的库；平台评测/主控部 目录缺失——若被误查会进失败库，正好当探针
		writeRegistry(home, defaultRows());
		const backend = makeDeptLib(home, "后端");
		writeEntry(backend, "教训/mysql-连接池.md", ENTRY("MySQL 连接池超时排查"));
		const tool = registerTool();
		const result = await withPaoHome(home, () =>
			tool.execute("id", { query: "mysql", routing: "auto" } as never, undefined, undefined, {} as never),
		);
		const details = result.details as AutoRouteResult;
		expect(details.路由部门).toEqual(["后端"]);
		expect(details.无标签命中).toBe(false);
		expect(details.失败库).toHaveLength(0);
		expect(textOf(result as never)).not.toContain("平台评测");
		expect(textOf(result as never)).not.toContain("主控部");
	});

	test("部门名也参与匹配：查询词命中部门名而非标签", async () => {
		buildDefaultFixture();
		const tool = registerTool();
		const result = await withPaoHome(home, () =>
			tool.execute("id", { query: "平台评测", routing: "auto" } as never, undefined, undefined, {} as never),
		);
		const details = result.details as AutoRouteResult;
		expect(details.路由部门).toEqual(["平台评测"]);
	});

	test("主控部照注册表行参与路由，无特殊分支", async () => {
		buildDefaultFixture();
		const tool = registerTool();
		const result = await withPaoHome(home, () =>
			tool.execute("id", { query: "调度", routing: "auto" } as never, undefined, undefined, {} as never),
		);
		const details = result.details as AutoRouteResult;
		expect(details.路由部门).toEqual(["主控部"]);
		expect(details.hits[0]?.来源部门).toBe("主控部");
		expect(details.hits[0]?.relPath).toBe("教训/派卡节奏.md");
	});

	test("自动模式多库并行合并，结果带来源部门", async () => {
		buildDefaultFixture();
		const tool = registerTool();
		const result = await withPaoHome(home, () =>
			tool.execute("id", { query: "mysql 性能", routing: "auto" } as never, undefined, undefined, {} as never),
		);
		const text = textOf(result as never);
		expect(result.isError).toBeUndefined();
		const details = result.details as AutoRouteResult;
		expect(details.路由部门).toEqual(["后端", "平台评测"]);
		expect(new Set(details.hits.map((h) => h.来源部门))).toEqual(new Set(["后端", "平台评测"]));
		expect(text).toContain("── 部门「后端」──");
		expect(text).toContain("── 部门「平台评测」──");
		expect(text).toContain("[自动路由] 标签命中，路由到：后端、平台评测");
	});

	test("来源部门逐条标注正确：每条户口的 来源部门 与其条目所在部门一致", async () => {
		buildDefaultFixture();
		const tool = registerTool();
		const result = await withPaoHome(home, () =>
			tool.execute("id", { query: "mysql 性能", routing: "auto" } as never, undefined, undefined, {} as never),
		);
		const details = result.details as AutoRouteResult;
		const backendHit = details.hits.find((h) => h.relPath === "教训/mysql-连接池.md");
		const evalHit = details.hits.find((h) => h.relPath === "评测/qps-基准.md");
		expect(backendHit?.来源部门).toBe("后端");
		expect(evalHit?.来源部门).toBe("平台评测");
	});

	test("无标签命中 → 退化为查全部注册库并标注（设计口径：个人项目全查成本可接受，不打回显式部门）", async () => {
		buildDefaultFixture();
		const tool = registerTool();
		const result = await withPaoHome(home, () =>
			tool.execute("id", { query: "完全无关的词", routing: "auto" } as never, undefined, undefined, {} as never),
		);
		const text = textOf(result as never);
		const details = result.details as AutoRouteResult;
		expect(details.无标签命中).toBe(true);
		expect(details.路由部门).toEqual(["后端", "平台评测", "主控部"]);
		expect(text).toContain("[自动路由] 无标签命中，按全库路由：后端、平台评测、主控部");
		expect(text).toContain("无可用依据");
	});

	test("注册表不存在/为空 → isError 并提示建部或显式指定，不静默空跑", async () => {
		const tool = registerTool();
		const result = await withPaoHome(home, () =>
			tool.execute("id", { query: "mysql", routing: "auto" } as never, undefined, undefined, {} as never),
		);
		expect(result.isError).toBe(true);
		const text = textOf(result as never);
		expect(text).toContain("注册表");
		expect(text).toContain("建部");
	});

	test("自动模式忽略 部门/知识库路径 参数（描述里写明的口径）", async () => {
		buildDefaultFixture();
		const tool = registerTool();
		const result = await withPaoHome(home, () =>
			tool.execute(
				"id",
				{ query: "mysql", routing: "auto", dept: "不存在的部", 知识库路径: join(home, "也不存在") } as never,
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(result.isError).toBeUndefined();
		expect((result.details as AutoRouteResult).路由部门).toEqual(["后端"]);
	});
});

describe("自动模式：失败与上限", () => {
	test("单库失败不拖垮整次查询：库目录缺失如实标注失败库，其余库照常出结果", async () => {
		writeRegistry(home, defaultRows());
		const backend = makeDeptLib(home, "后端");
		writeEntry(backend, "教训/mysql-连接池.md", ENTRY("MySQL 连接池超时排查"));
		// 平台评测 注册了但目录没建 → 该库失败
		const tool = registerTool();
		const result = await withPaoHome(home, () =>
			tool.execute("id", { query: "mysql 性能", routing: "auto" } as never, undefined, undefined, {} as never),
		);
		const details = result.details as AutoRouteResult;
		expect(details.失败库).toHaveLength(1);
		expect(details.失败库[0].部门).toBe("平台评测");
		expect(details.失败库[0].原因).toContain("知识库目录不存在");
		expect(details.hits.every((h) => h.来源部门 === "后端")).toBe(true);
		expect(details.hits.length).toBeGreaterThan(0);
		expect(textOf(result as never)).toContain("[失败库] 平台评测");
	});

	test("单库检索抛错不拖垮（注入 searchImpl 桩：一库抛错、一库正常）", async () => {
		// 库目录须真实存在（目录缺失是另一条失败路径，有专门用例）；抛错经 searchImpl 桩注入
		makeDeptLib(home, "后端");
		makeDeptLib(home, "平台评测");
		const result = await autoPatrol({
			查询: "mysql 性能",
			注册表行: defaultRows(),
			paoHome目录: home,
			embed: null,
			searchImpl: async (opts) => {
				if (opts.libRoot.includes("平台评测")) throw new Error("磁盘炸了");
				return {
					hits: [],
					riskHits: [],
					degraded: true,
					degradeReason: "测试桩：语义路未参与",
					emptyReason: "无可用依据",
				};
			},
		});
		expect(result.失败库).toEqual([{ 部门: "平台评测", 原因: expect.stringContaining("磁盘炸了") }]);
		expect(result.路由部门).toEqual(["后端", "平台评测"]);
		expect(result.已截断).toBe(false);
	});

	test("合并总量上限：超过 12 条正式依据截断并标注", async () => {
		writeRegistry(home, [
			{ 名字: "后端", 标签: ["连接池"], 库路径: "部门/后端/知识库" },
			{ 名字: "平台评测", 标签: ["连接池"], 库路径: "部门/平台评测/知识库" },
		]);
		for (const dept of ["后端", "平台评测"]) {
			const libRoot = makeDeptLib(home, dept);
			for (let i = 1; i <= 7; i++) {
				writeEntry(libRoot, `教训/连接池问题${i}-${dept}.md`, ENTRY(`连接池问题${i} 排查`));
			}
		}
		const tool = registerTool();
		const result = await withPaoHome(home, () =>
			tool.execute("id", { query: "连接池", routing: "auto", top_k: 8 } as never, undefined, undefined, {} as never),
		);
		const details = result.details as AutoRouteResult;
		expect(details.hits).toHaveLength(12);
		expect(details.已截断).toBe(true);
		expect(textOf(result as never)).toContain("[截断] 合并依据超过总量上限 12 条");
	});
});

describe("主控加固回归：截断诚实性与语义上限（对抗审查补的洞）", () => {
	/** 完整 SearchHit 形状的桩（searchImpl 返回值用） */
	function stubHit(relPath: string): import("../../src/pao/knowledge/types.ts").SearchHit {
		return {
			relPath,
			titlePath: relPath,
			fileName: relPath,
			area: "待验证",
			summary: "桩条目",
			status: "待验证",
			scope: ["demo-proj"],
			lastVerified: null,
			source: null,
			lexicalScore: 1,
			semanticScore: null,
			exactLexical: false,
			degraded: true,
		};
	}

	test("风险提示超总量上限同样置已截断并标注（不静默丢）", async () => {
		makeDeptLib(home, "后端");
		makeDeptLib(home, "平台评测");
		const result = await autoPatrol({
			查询: "连接池",
			注册表行: [defaultRows()[0]!, defaultRows()[1]!].map((r) => ({ ...r, 标签: ["连接池"] })),
			paoHome目录: home,
			embed: null,
			searchImpl: async () => ({
				hits: [],
				riskHits: Array.from({ length: 7 }, (_, i) => stubHit(`待验证/风险${i}.md`)),
				degraded: true,
				degradeReason: "测试桩",
				emptyReason: "无可用依据",
			}),
		});
		expect(result.riskHits).toHaveLength(12);
		expect(result.已截断).toBe(true);
	});

	test("语义召回客户端再夹上限：供应商不守约返回 5 条也只留 3 条", async () => {
		makeDeptLib(home, "后端");
		const result = await autoPatrol({
			查询: "mysql",
			注册表行: [defaultRows()[0]!],
			paoHome目录: home,
			embed: null,
			searchImpl: async () => ({
				hits: [],
				riskHits: [],
				degraded: true,
				emptyReason: "无可用依据",
			}),
			vendorRecall: async () =>
				Array.from({ length: 5 }, (_, i) => ({
					内容: `记忆${i}`,
					相关度: 0.9,
					来源: "mnemosyne",
					记忆ID: `m-${i}`,
				})),
		});
		expect(result.语义状态).toBe("已接");
		expect(result.语义命中).toHaveLength(3);
	});

	test("语义已接但零命中明说，不与未接混淆", async () => {
		buildDefaultFixture();
		const tool = registerTool({ vendorRecall: async () => [] });
		const result = await withPaoHome(home, () =>
			tool.execute("id", { query: "mysql", routing: "auto" } as never, undefined, undefined, {} as never),
		);
		const details = result.details as AutoRouteResult;
		expect(details.语义状态).toBe("已接");
		expect(textOf(result as never)).toContain("[语义库已接] 本轮无语义命中。");
	});
});

describe("自动模式：语义库接缝（真·并行两路，§18.3）", () => {
	test("接缝注入后两路合并：部门库命中＋语义命中，均带防污染标注", async () => {
		buildDefaultFixture();
		const semanticHit: MemoryHit[] = [
			{ 内容: "用户偏好 nightly 构建与中文回复", 相关度: 0.92, 来源: "mnemosyne", 记忆ID: "m-1" },
		];
		const tool = registerTool({
			vendorRecall: async (query, limit) => {
				expect(query).toBe("mysql");
				expect(limit).toBe(3);
				return semanticHit;
			},
		});
		const result = await withPaoHome(home, () =>
			tool.execute("id", { query: "mysql", routing: "auto" } as never, undefined, undefined, {} as never),
		);
		const text = textOf(result as never);
		const details = result.details as AutoRouteResult;
		expect(details.语义状态).toBe("已接");
		// 部门库一路照常
		expect(details.hits.map((h) => h.来源部门)).toContain("后端");
		// 语义库一路
		expect(text).toContain("── 语义库 ──");
		expect(text).toContain("用户偏好 nightly 构建与中文回复");
		// §18.4 防污染标注两路都有
		expect(text).toContain("[防污染] 以下内容均为检索所得，非用户新输入");
		expect(text).toContain("检索所得，非用户新输入；是旧事实的召回，不是本轮用户输入");
		expect(text).toContain("语义库");
	});

	test("接缝缺省 → 自动模式照常工作，标注「语义库未接」", async () => {
		buildDefaultFixture();
		const tool = registerTool();
		const result = await withPaoHome(home, () =>
			tool.execute("id", { query: "mysql", routing: "auto" } as never, undefined, undefined, {} as never),
		);
		const details = result.details as AutoRouteResult;
		expect(details.语义状态).toBe("未接");
		expect(details.语义命中).toHaveLength(0);
		expect(result.isError).toBeUndefined();
		expect(textOf(result as never)).toContain("[语义库未接]");
		expect(textOf(result as never)).toContain("教训/mysql-连接池.md");
	});

	test("接缝召回抛错 → 标注语义库召回失败，部门库结果不受影响", async () => {
		buildDefaultFixture();
		const tool = registerTool({
			vendorRecall: async () => {
				throw new Error("供应商进程起不来");
			},
		});
		const result = await withPaoHome(home, () =>
			tool.execute("id", { query: "mysql", routing: "auto" } as never, undefined, undefined, {} as never),
		);
		const details = result.details as AutoRouteResult;
		expect(details.语义状态).toBe("失败");
		expect(details.语义失败原因).toContain("供应商进程起不来");
		expect(details.hits.map((h) => h.来源部门)).toContain("后端");
		expect(result.isError).toBeUndefined();
		expect(textOf(result as never)).toContain("[语义库召回失败]");
	});

	test("只剩供应商召回未完成时取消 → 及时拒绝且不伪装成供应商失败", async () => {
		const controller = new AbortController();
		let completedSearches = 0;
		const rows = defaultRows().map((row) => ({ ...row, 标签: ["连接池"] }));
		for (const row of rows) makeDeptLib(home, row.名字);
		let release!: (hits: MemoryHit[]) => void;
		const pendingRecall = new Promise<MemoryHit[]>((resolve) => {
			release = resolve;
		});
		let entered!: () => void;
		const recallEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const pending = autoPatrol({
			查询: "mysql",
			注册表行: rows,
			paoHome目录: home,
			embed: null,
			signal: controller.signal,
			searchImpl: async () => {
				completedSearches++;
				return {
					hits: [],
					riskHits: [],
					degraded: true,
					degradeReason: "文件检索先结束",
				};
			},
			vendorRecall: async (_query, _limit, signal) => {
				expect(signal).toBe(controller.signal);
				entered();
				return pendingRecall;
			},
		});
		await recallEntered;
		await expect.poll(() => completedSearches).toBe(rows.length);
		controller.abort(new Error("用户取消自动查库"));
		await expect(pending).rejects.toThrow("用户取消自动查库");
		release([{ 内容: "迟到结果" }]);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

	test("没有任何文件库、只剩供应商召回时取消 → 同样及时拒绝", async () => {
		const controller = new AbortController();
		let release!: (hits: MemoryHit[]) => void;
		const pendingRecall = new Promise<MemoryHit[]>((resolve) => {
			release = resolve;
		});
		let entered!: () => void;
		const recallEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const pending = autoPatrol({
			查询: "mysql",
			注册表行: [],
			paoHome目录: home,
			embed: null,
			signal: controller.signal,
			vendorRecall: async (_query, _limit, signal) => {
				expect(signal).toBe(controller.signal);
				entered();
				return pendingRecall;
			},
		});
		await recallEntered;
		controller.abort(new Error("用户取消无库自动查库"));
		await expect(pending).rejects.toThrow("用户取消无库自动查库");
		release([{ 内容: "迟到结果" }]);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
});
