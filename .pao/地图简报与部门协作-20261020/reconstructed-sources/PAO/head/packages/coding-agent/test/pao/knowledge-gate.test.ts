/**
 * 卡0004 验收 7：受限补查门——部门锁死（拒绝 全部/别名/跨部）、
 * 一次（按卡号+授权轮次计，重试不恢复额度）、只读（无写路径）、回执记录。
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { FetchLike } from "../../src/pao/knowledge/embed.ts";
import { ALL_DEPT_ALIASES, createRestrictedGate, type QueryReceipt } from "../../src/pao/knowledge/gate.ts";
import type { OutboundConfig } from "../../src/pao/knowledge/outbound.ts";
import { vectorCachePath } from "../../src/pao/knowledge/paths.ts";

let libRoot: string;

beforeEach(() => {
	libRoot = mkdtempSync(join(tmpdir(), "pao-kb-gate-"));
	for (const dir of ["教训", "导览", "做法", "评测", "待验证", "归档"]) {
		mkdirSync(join(libRoot, dir));
	}
});

afterEach(() => {
	rmSync(libRoot, { recursive: true, force: true });
});

function writeEntry(relPath: string, content: string): void {
	const abs = join(libRoot, relPath);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content, "utf8");
}

describe("验收7：受限补查门", () => {
	test("首次补查成功，回执记录 查了什么词/返回几条", async () => {
		writeEntry("教训/连接池.md", "连接池排查 2026-10-01\n正文\n适用范围: demo-proj");
		const receipts: QueryReceipt[] = [];
		const gate = createRestrictedGate({
			libRoot,
			deptName: "后端",
			auth: { cardId: "卡0007", round: 1 },
			appendReceipt: (r) => {
				receipts.push(r);
			},
		});
		expect(gate.used).toBe(false);

		const result = await gate.query("连接池");
		expect(result.hits.map((h) => h.relPath)).toContain("教训/连接池.md");
		expect(gate.used).toBe(true);
		expect(receipts).toHaveLength(1);
		expect(receipts[0]).toMatchObject({
			cardId: "卡0007",
			round: 1,
			dept: "后端",
			query: "连接池",
			hitCount: 1,
		});
	});

	test("二次调用拒绝并说明；同卡同轮重试不恢复额度", async () => {
		const gate = createRestrictedGate({
			libRoot,
			deptName: "后端",
			auth: { cardId: "卡0008", round: 1 },
			appendReceipt: () => {},
		});
		await gate.query("第一次");
		// 二次调用：原实例拒绝
		await expect(gate.query("第二次")).rejects.toThrow(/只允许一次补查.*重试不恢复额度/s);
		// 重开新门（模拟重试）也不恢复额度
		const retryGate = createRestrictedGate({
			libRoot,
			deptName: "后端",
			auth: { cardId: "卡0008", round: 1 },
			appendReceipt: () => {},
		});
		await expect(retryGate.query("重试")).rejects.toThrow("受限补查已用过");
	});

	test("追加授权轮次（round+1）才恢复额度", async () => {
		const gate1 = createRestrictedGate({
			libRoot,
			deptName: "后端",
			auth: { cardId: "卡0009", round: 1 },
			appendReceipt: () => {},
		});
		await gate1.query("第一轮");
		const gate2 = createRestrictedGate({
			libRoot,
			deptName: "后端",
			auth: { cardId: "卡0009", round: 2 },
			appendReceipt: () => {},
		});
		await expect(gate2.query("第二轮")).resolves.toBeDefined();
	});

	test("跨部参数拒绝；部门=全部 及别名一律拒绝", async () => {
		const gate = createRestrictedGate({
			libRoot,
			deptName: "后端",
			auth: { cardId: "卡0010", round: 1 },
			appendReceipt: () => {},
		});
		await expect(gate.query("跨部查询", { dept: "前端" })).rejects.toThrow("拒绝跨部");
		for (const alias of ALL_DEPT_ALIASES) {
			await expect(gate.query("绕出尝试", { dept: alias })).rejects.toThrow("只允许查本部");
		}
		// 拒绝不算消耗额度：本部查询仍可用
		await expect(gate.query("本部查询")).resolves.toBeDefined();
	});

	test("回执文件跨会话核对额度：重开会话（新进程内登记为空）也不恢复", async () => {
		// 用默认回执路径（写 PAO_HOME/.pao/补查回执.jsonl）
		const home = mkdtempSync(join(tmpdir(), "pao-kb-home-"));
		try {
			const receiptPath = join(home, ".pao", "补查回执.jsonl");
			const gate1 = createRestrictedGate({
				libRoot,
				deptName: "后端",
				auth: { cardId: "卡0011", round: 1 },
				receiptPath,
			});
			await gate1.query("查一次");
			const gate2 = createRestrictedGate({
				libRoot,
				deptName: "后端",
				auth: { cardId: "卡0011", round: 1 },
				receiptPath,
			});
			await expect(gate2.query("再查")).rejects.toThrow("受限补查已用过");
			// 回执内容可读
			const content = readFileSync(receiptPath, "utf8");
			expect(content).toContain("卡0011");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("回执文件里形状不对的合法 JSON 行跳过：不误吞额度，好行照常核对", async () => {
		const home = mkdtempSync(join(tmpdir(), "pao-kb-home-"));
		try {
			const receiptPath = join(home, ".pao", "补查回执.jsonl");
			mkdirSync(join(home, ".pao"), { recursive: true });
			// 坏行：round 是字符串／非对象行——不许吃掉额度；好行：跨会话照常恢复额度
			appendFileSync(
				receiptPath,
				`{"cardId":"卡0020","round":"1"}\n42\n{"time":"t","cardId":"卡0021","round":1,"dept":"后端","query":"q","hitCount":0}\n`,
				"utf8",
			);
			const okGate = createRestrictedGate({
				libRoot,
				deptName: "后端",
				auth: { cardId: "卡0020", round: 1 },
				receiptPath,
			});
			await expect(okGate.query("坏行不吞额度")).resolves.toBeDefined();
			const usedGate = createRestrictedGate({
				libRoot,
				deptName: "后端",
				auth: { cardId: "卡0021", round: 1 },
				receiptPath,
			});
			await expect(usedGate.query("好行照常核对")).rejects.toThrow("受限补查已用过");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("只读：门内查询不写任何东西（向量缓存文件不落盘）", async () => {
		writeEntry("教训/连接池.md", "连接池排查 2026-10-01\n正文\n适用范围: demo-proj");
		const vectors: Record<string, number[]> = {
			"连接池排查 2026-10-01\n正文\n适用范围: demo-proj": [1, 0],
			连接池: [1, 0],
		};
		let requests = 0;
		const fetchImpl = (async (_url: string, init?: { body?: string }) => {
			requests++;
			const body = JSON.parse(init?.body ?? "{}") as { input?: string[] };
			return {
				ok: true,
				status: 200,
				json: async () => ({
					data: (body.input ?? []).map((t, i) => ({ index: i, embedding: vectors[t] ?? [1, 0] })),
				}),
			};
		}) as FetchLike;
		const gate = createRestrictedGate({
			libRoot,
			deptName: "后端",
			auth: { cardId: "卡0012", round: 1 },
			embed: { config: { baseUrl: "http://mock", apiKey: "k", model: "m" }, fetchImpl },
			outbound: { projects: { "demo-proj": { allowed: true, asOf: "2026-10-02" } } } as OutboundConfig,
			project: "demo-proj",
			now: new Date("2026-10-02T00:00:00"),
			appendReceipt: () => {},
		});
		await gate.query("连接池");
		expect(requests).toBeGreaterThan(0);
		// 语义照常跑了（能出结果），但缓存文件没写——无任何写路径
		expect(existsSync(vectorCachePath(libRoot))).toBe(false);
	});
});
