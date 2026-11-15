/**
 * 卡0004 验收 9 + 工具注册：四个工具（pao_query_kb/pao_restricted_query/pao_ingest_kb/pao_inspect_kb）
 * 注册签名正确、description 中文、execute 可跑通；嵌入端点缺失走降级主路径。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { registerKnowledgeTools } from "../../src/pao/knowledge/tools.ts";
import type { SearchResult } from "../../src/pao/knowledge/types.ts";

let libRoot: string;

beforeEach(() => {
	libRoot = mkdtempSync(join(tmpdir(), "pao-kb-tools-"));
	for (const dir of ["教训", "导览", "做法", "评测", "待验证", "归档"]) {
		mkdirSync(join(libRoot, dir));
	}
});

afterEach(() => {
	rmSync(libRoot, { recursive: true, force: true });
});

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

describe("验收9：工具注册与执行", () => {
	test("注册四个知识库工具，名字与中文 description 齐全", () => {
		const pi = fakePi();
		registerKnowledgeTools(pi, { embed: null });
		const names = pi.registered.map((t) => t.name);
		expect(names).toEqual(["pao_query_kb", "pao_restricted_query", "pao_ingest_kb", "pao_inspect_kb"]);
		for (const tool of pi.registered) {
			expect(tool.definition.description.length).toBeGreaterThan(10);
			// description 面向模型，用中文
			expect(tool.definition.description).toMatch(/[\u4e00-\u9fa5]/);
			expect(tool.definition.parameters).toBeDefined();
			expect(typeof tool.definition.execute).toBe("function");
		}
	});

	test("审查第 13 项：缺验证出处的做法只进风险提示，且输出里写明缺的是验证出处", async () => {
		writeFileSync(
			join(libRoot, "做法", "没出处的做法.md"),
			"连接池调优 2026-10-01\n调大 pool 上限\n适用范围: demo-proj\n来源: 内部压测",
			"utf8",
		);
		writeFileSync(
			join(libRoot, "做法", "有出处的做法.md"),
			`连接池调优 2026-10-01\n调大 pool 上限\n适用范围: demo-proj\n验证出处: 卡0007 2026-10-01 真机验收`,
			"utf8",
		);
		const pi = fakePi();
		registerKnowledgeTools(pi, { embed: null });
		const tool = pi.registered.find((t) => t.name === "pao_query_kb")!.definition;
		const result = await tool.execute(
			"id",
			{ query: "连接池", kb_path: libRoot } as never,
			undefined,
			undefined,
			{} as never,
		);
		const text = result.content[0].type === "text" ? result.content[0].text : "";
		const details = result.details as SearchResult;
		// 有出处的做法是正式依据，没出处的只作风险提示
		expect(details.hits.map((hit) => hit.relPath)).toEqual(["做法/有出处的做法.md"]);
		expect(details.riskHits.map((hit) => hit.relPath)).toEqual(["做法/没出处的做法.md"]);
		expect(details.riskHits[0].status).toBe("待验证");
		// 披露原因：模型必须看得到「缺验证出处」这个判断依据
		expect(text).toContain("unverified_reason");
		expect(text).toContain("验证出处");
	});

	test("pao_query_kb：端点缺失 → 词法独跑降级路径（主测路径）照常出结果", async () => {
		writeFileSync(
			join(libRoot, "教训", "连接池.md"),
			"连接池排查 2026-10-01\n调大 pool 上限\n适用范围: demo-proj",
			"utf8",
		);
		const pi = fakePi();
		registerKnowledgeTools(pi, { embed: null });
		const tool = pi.registered.find((t) => t.name === "pao_query_kb")!.definition;
		const result = await tool.execute(
			"id",
			{ query: "连接池", kb_path: libRoot } as never,
			undefined,
			undefined,
			{} as never,
		);
		const text = result.content[0].type === "text" ? result.content[0].text : "";
		expect(text).toContain("[降级]");
		expect(text).toContain("教训/连接池.md");
		expect(text).toContain('"status"');
	});

	test("pao_restricted_query：未绑定授权 → 拒绝并说明", async () => {
		const pi = fakePi();
		registerKnowledgeTools(pi, { embed: null });
		const tool = pi.registered.find((t) => t.name === "pao_restricted_query")!.definition;
		const result = await tool.execute("id", { query: "x" } as never, undefined, undefined, {} as never);
		expect(result.isError).toBe(true);
		expect(result.content[0].type === "text" && result.content[0].text).toContain("未授权");
	});

	test.each(["pao_query_kb", "pao_restricted_query"])(
		"%s：期望版本从公共参数透传，错版本不挤占正式 top_k",
		async (name) => {
			const date = new Date().toISOString().slice(0, 10);
			writeFileSync(join(libRoot, "教训", "连接池.md"), `连接池排查 ${date} 版本:v1\n正文\n适用范围: demo-proj`);
			writeFileSync(
				join(libRoot, "做法", "新版连接池.md"),
				// 审查第 13 项：做法必须带「验证出处:」才会进正式依据，这里验的是版本透传，先让它合格
				`新版连接池排查 ${date} 版本:v2\n正文\n适用范围: demo-proj\n验证出处: 卡0007 ${date} 真机验收`,
			);
			const pi = fakePi();
			registerKnowledgeTools(pi, {
				embed: null,
				restricted: {
					deptName: "后端",
					libRoot,
					auth: { cardId: `${name}-${libRoot}`, round: 1 },
					receiptPath: join(libRoot, "补查回执.jsonl"),
				},
			});
			const tool = pi.registered.find((t) => t.name === name)!.definition;
			expect(tool.parameters).toMatchObject({ properties: { expected_version: { type: "string" } } });
			const result = await tool.execute(
				"versioned",
				{
					query: "连接池",
					top_k: 1,
					expected_version: "v2",
					...(name === "pao_query_kb" ? { kb_path: libRoot } : {}),
				} as never,
				undefined,
				undefined,
				{ cwd: libRoot } as never,
			);
			expect(result.isError).toBeUndefined();
			const details = result.details as SearchResult;
			expect(details.hits.map((hit) => hit.relPath)).toEqual(["做法/新版连接池.md"]);
			expect(details.riskHits.map((hit) => hit.relPath)).toEqual(["教训/连接池.md"]);
			expect(details.riskHits[0].status).toBe("待复核⚠️");
		},
	);

	test("公共查库不采信模型绑定项目；当前项目来自 cwd 的 git 根", async () => {
		writeFileSync(join(libRoot, "教训", "连接池.md"), "连接池排查 2026-10-03\n正文\n适用范围: open-proj");
		const project = join(libRoot, "open-proj");
		mkdirSync(join(project, ".git"), { recursive: true });
		mkdirSync(join(project, "src"), { recursive: true });
		const bodies: string[][] = [];
		const pi = fakePi();
		registerKnowledgeTools(pi, {
			outbound: { projects: { "open-proj": { allowed: true, asOf: "2099-12-31" } } },
			embed: {
				config: { baseUrl: "http://mock", apiKey: "test-key", model: "test" },
				fetchImpl: async (_url, init) => {
					const input = (JSON.parse(init?.body ?? "{}") as { input: string[] }).input;
					bodies.push(input);
					return {
						ok: true,
						status: 200,
						json: async () => ({ data: input.map((_, index) => ({ index, embedding: [1, 0] })) }),
					};
				},
			},
		});
		const tool = pi.registered.find((t) => t.name === "pao_query_kb")!.definition;
		const blocked = await tool.execute(
			"blocked",
			{ query: "连接池", kb_path: libRoot } as never,
			undefined,
			undefined,
			{ cwd: join(libRoot, "private-proj") } as never,
		);
		expect(bodies).toHaveLength(0);
		expect((blocked.details as SearchResult).degradeReason).toContain("private-proj");
		const allowed = await tool.execute(
			"allowed",
			{ query: "连接池", kb_path: libRoot } as never,
			undefined,
			undefined,
			{ cwd: join(project, "src") } as never,
		);
		expect((allowed.details as SearchResult).degraded).toBe(false);
		expect(bodies.flat()).toContain("连接池");
	});

	test.skipIf(process.platform !== "win32")("Windows 使用现场 pao 可匹配 PAO 许可，pao-dev 仍被阻断", async () => {
		writeFileSync(join(libRoot, "教训", "连接池.md"), "连接池排查 2026-10-03\n正文\n适用范围: PAO");
		const project = join(libRoot, "pao");
		mkdirSync(join(project, ".git"), { recursive: true });
		const bodies: string[][] = [];
		const pi = fakePi();
		registerKnowledgeTools(pi, {
			outbound: { projects: { PAO: { allowed: true, asOf: "2099-12-31" } } },
			embed: {
				config: { baseUrl: "http://mock", apiKey: "test-key", model: "test" },
				fetchImpl: async (_url, init) => {
					const input = (JSON.parse(init?.body ?? "{}") as { input: string[] }).input;
					bodies.push(input);
					return {
						ok: true,
						status: 200,
						json: async () => ({ data: input.map((_, index) => ({ index, embedding: [1, 0] })) }),
					};
				},
			},
		});
		const tool = pi.registered.find((t) => t.name === "pao_query_kb")!.definition;
		const blocked = await tool.execute(
			"blocked",
			{ query: "连接池", kb_path: libRoot } as never,
			undefined,
			undefined,
			{ cwd: join(libRoot, "pao-dev") } as never,
		);
		expect((blocked.details as SearchResult).degradeReason).toContain("pao-dev");
		expect(bodies).toHaveLength(0);
		const allowed = await tool.execute(
			"allowed",
			{ query: "连接池", kb_path: libRoot } as never,
			undefined,
			undefined,
			{ cwd: project } as never,
		);
		expect((allowed.details as SearchResult).degraded).toBe(false);
		expect(bodies.flat()).toContain("连接池");
	});

	test("pao_restricted_query：绑定授权后可查，且额度按卡号+轮次消耗", async () => {
		writeFileSync(join(libRoot, "导览", "目录.md"), "后端导览 2026-10-01\n本部结构\n适用范围: demo-proj", "utf8");
		const pi = fakePi();
		registerKnowledgeTools(pi, {
			embed: null,
			restricted: {
				deptName: "后端",
				libRoot,
				auth: { cardId: "卡0004", round: 1 },
				// 回执写到本次测试的临时库目录里，不污染真实 PAO_HOME，也不跨测试残留
				receiptPath: join(libRoot, "补查回执.jsonl"),
			},
		});
		const tool = pi.registered.find((t) => t.name === "pao_restricted_query")!.definition;
		// 第一次：工具内部每次调用都新建门，额度靠进程内登记卡住
		const first = await tool.execute("id", { query: "导览" } as never, undefined, undefined, {} as never);
		expect(first.isError).toBeUndefined();
		// 第二次：同一卡号+轮次已消耗，工具返回错误
		const second = await tool.execute("id", { query: "导览" } as never, undefined, undefined, {} as never);
		expect(second.isError).toBe(true);
		expect(second.content[0].type === "text" && second.content[0].text).toContain("受限补查已用过");
	});

	test("pao_ingest_kb 与 pao_inspect_kb 可直接执行", async () => {
		writeFileSync(join(libRoot, "待验证", "候选.md"), "候选条目 2026-10-01\n正文\n适用范围: demo-proj", "utf8");
		const pi = fakePi();
		registerKnowledgeTools(pi, { embed: null });

		const ingest = pi.registered.find((t) => t.name === "pao_ingest_kb")!.definition;
		const ingestResult = await ingest.execute(
			"id",
			{ kb_path: libRoot, candidate_path: join(libRoot, "待验证", "候选.md"), type: "教训" } as never,
			undefined,
			undefined,
			{} as never,
		);
		const ingestText = ingestResult.content[0].type === "text" ? ingestResult.content[0].text : "";
		expect(ingestText).toContain("入库完成");

		const inspect = pi.registered.find((t) => t.name === "pao_inspect_kb")!.definition;
		const inspectResult = await inspect.execute(
			"id",
			{ kb_path: libRoot } as never,
			undefined,
			undefined,
			{} as never,
		);
		const inspectText = inspectResult.content[0].type === "text" ? inspectResult.content[0].text : "";
		expect(inspectText).toContain("巡检完成");
	});
});

describe("使用现场分仓：库定位防猜错层（部门参数 + 路径不存在报错）", () => {
	function withPaoHome<T>(home: string | undefined, fn: () => T): T {
		const old = process.env.PAO_HOME;
		if (home === undefined) delete process.env.PAO_HOME;
		else process.env.PAO_HOME = home;
		try {
			return fn();
		} finally {
			if (old === undefined) delete process.env.PAO_HOME;
			else process.env.PAO_HOME = old;
		}
	}

	test("传 部门 → 从 PAO_HOME 解析库路径，照常检索", async () => {
		const home = mkdtempSync(join(tmpdir(), "pao-kb-home-"));
		const deptLib = join(home, "部门", "后端", "知识库");
		for (const dir of ["教训", "导览", "做法", "评测", "待验证", "归档"]) {
			mkdirSync(join(deptLib, dir), { recursive: true });
		}
		writeFileSync(join(deptLib, "教训", "超时.md"), "超时排查 2026-10-02\n加熔断\n适用范围: demo-proj", "utf8");
		const pi = fakePi();
		registerKnowledgeTools(pi, { embed: null });
		const tool = pi.registered.find((t) => t.name === "pao_query_kb")!.definition;
		try {
			const result = withPaoHome(home, () =>
				tool.execute("id", { query: "超时", dept: "后端" } as never, undefined, undefined, {} as never),
			);
			const settled = await result;
			const text = settled.content[0].type === "text" ? settled.content[0].text : "";
			expect(text).toContain("教训/超时.md");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("部门拼出的路径不存在 → isError 且说明 PAO_HOME，不当空库", async () => {
		const home = mkdtempSync(join(tmpdir(), "pao-kb-home-"));
		const pi = fakePi();
		registerKnowledgeTools(pi, { embed: null });
		const tool = pi.registered.find((t) => t.name === "pao_query_kb")!.definition;
		try {
			const settled = await withPaoHome(home, () =>
				tool.execute("id", { query: "x", dept: "不存在的部" } as never, undefined, undefined, {} as never),
			);
			expect(settled.isError).toBe(true);
			const text = settled.content[0].type === "text" ? settled.content[0].text : "";
			expect(text).toContain("知识库目录不存在");
			expect(text).toContain(home);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("部门与知识库路径都不传 → isError 提示用法", async () => {
		const pi = fakePi();
		registerKnowledgeTools(pi, { embed: null });
		const tool = pi.registered.find((t) => t.name === "pao_query_kb")!.definition;
		const settled = await tool.execute("id", { query: "x" } as never, undefined, undefined, {} as never);
		expect(settled.isError).toBe(true);
		const text = settled.content[0].type === "text" ? settled.content[0].text : "";
		expect(text).toContain("dept");
	});
});
