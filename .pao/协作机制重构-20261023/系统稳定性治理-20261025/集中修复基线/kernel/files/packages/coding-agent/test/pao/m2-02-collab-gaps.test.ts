import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "../../src/core/extensions/types.ts";
import { findReachableCycles } from "../../src/pao/cards/deps.ts";
import { createCard, listCards } from "../../src/pao/cards/index.ts";
import type { CardFrontmatter, ParsedCard } from "../../src/pao/cards/types.ts";
import type { CollabAuditRecord, CollabReviewResult } from "../../src/pao/collab/index.ts";
import { registerCollab } from "../../src/pao/collab/index.ts";
import { type CollabCardDraft, validateCollabCard } from "../../src/pao/collab/review.ts";
import { listPaoSubcommands, resetPaoSubcommandsForTest } from "../../src/pao/command-router.ts";
import { type DeptRegistryRow, formatRegistry } from "../../src/pao/dept/index.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// 依赖环检测（cards/deps 纯函数，M2-02「检查未知卡、自依赖、环」的环部分）
// ============================================================================

describe("findReachableCycles 依赖环检测", () => {
	it("自依赖：卡依赖自己＝长度 1 的环", () => {
		const cycle = findReachableCycles([5], (n) => (n === 5 ? [5] : []));
		expect(cycle).toEqual([5]);
	});

	it("互等环：从依赖出发可达的环全部成员报告", () => {
		// 卡2 → 卡3 → 卡2；本卡（草稿）依赖卡2
		const edges = (n: number): number[] => (n === 2 ? [3] : n === 3 ? [2] : []);
		expect(findReachableCycles([2], edges).sort()).toEqual([2, 3]);
	});

	it("不可达的环不报告：与本卡无关的死锁组件不扩大打击面", () => {
		const edges = (n: number): number[] => (n === 7 ? [8] : n === 8 ? [7] : n === 2 ? [] : []);
		expect(findReachableCycles([2], edges)).toEqual([]);
	});

	it("菱形依赖不成环", () => {
		const edges = (n: number): number[] => (n === 1 ? [2, 3] : n === 2 ? [4] : n === 3 ? [4] : []);
		expect(findReachableCycles([1], edges)).toEqual([]);
	});
});

// ============================================================================
// 校验协作卡 的依赖环拒绝（等待环上卡＝死等一张等不来的卡）
// ============================================================================

let cardNoSeq = 0;

/** 造既有卡夹具（不落盘，校验器只读内存视图；与 collab-review.test.ts 同款约定） */
function makeCard(overrides: Partial<CardFrontmatter> & { 卡号?: number } = {}): ParsedCard {
	cardNoSeq += 1;
	const cardNo = overrides.卡号 ?? cardNoSeq;
	const frontmatter: CardFrontmatter = {
		goal: `目标${cardNo}`,
		dept: "前端",
		acceptance: "可判验收",
		attempt: 0,
		created: "2026-10-03 09:00",
		status: "in_progress",
		...overrides,
	};
	delete (frontmatter as { 卡号?: number }).卡号;
	return {
		path: join("虚拟", "卡", `卡${String(cardNo).padStart(4, "0")}-x.md`),
		filename: `卡${String(cardNo).padStart(4, "0")}-x.md`,
		card_no: cardNo,
		frontmatter,
		body: "",
		receipts: [],
	};
}

const registry: DeptRegistryRow[] = [{ 名字: "后端", 标签: ["api"], 库路径: "部门/后端/知识库" }];

function makeDraft(overrides: Partial<CollabCardDraft> = {}): CollabCardDraft {
	return { 目标: "帮忙压测", 部门: "后端", 验收: "报告落产物", parent: "卡#1", ...overrides };
}

describe("校验协作卡:依赖环拒绝", () => {
	it("依赖链可达互等环（环上有未交付卡）→ 拒绝并点名环成员", () => {
		const existing = [
			makeCard({ 卡号: 1 }),
			makeCard({ 卡号: 2, status: "in_progress", depends_on: ["卡#3"] }),
			makeCard({ 卡号: 3, status: "unclaimed", depends_on: ["卡#2"] }),
		];
		const result = validateCollabCard(makeDraft({ depends_on: ["卡#2"] }), registry, existing);
		expect(result.裁决).toBe("拒绝");
		const cycleReason = result.原因.find((r) => r.类型 === "依赖环");
		expect(cycleReason).toBeDefined();
		expect(cycleReason!.说明).toContain("卡0002");
		expect(cycleReason!.说明).toContain("卡0003");
	});

	it("环上全部已交付（历史环已解开）→ 不报依赖环，依赖门放行", () => {
		const existing = [
			makeCard({ 卡号: 1 }),
			makeCard({ 卡号: 2, status: "delivered", depends_on: ["卡#3"] }),
			makeCard({ 卡号: 3, status: "delivered", depends_on: ["卡#2"] }),
		];
		const result = validateCollabCard(makeDraft({ depends_on: ["卡#2"] }), registry, existing);
		expect(result.裁决).toBe("放行");
		expect(result.原因.some((r) => r.类型 === "依赖环")).toBe(false);
	});

	it("与本卡依赖无关的环不报（只看从 depends_on 可达的部分）", () => {
		const existing = [
			makeCard({ 卡号: 1 }),
			makeCard({ 卡号: 4, status: "delivered" }),
			makeCard({ 卡号: 7, status: "in_progress", depends_on: ["卡#8"] }),
			makeCard({ 卡号: 8, status: "unclaimed", depends_on: ["卡#7"] }),
		];
		const result = validateCollabCard(makeDraft({ depends_on: ["卡#4"] }), registry, existing);
		expect(result.裁决).toBe("放行");
		expect(result.原因.some((r) => r.类型 === "依赖环")).toBe(false);
	});
});

// ============================================================================
// 已批准模板绑定授权范围（§8.2「用已批准模板」＋ M2-02「不让字段填齐成为任意操作的通行证」）
// ============================================================================

/** 极简注册口:截获工具/命令/发出消息,供直接调用(不接真实会话) */
function capturePi() {
	const tools: ToolDefinition[] = [];
	const commands: { name: string; handler: (args: string, ctx: never) => Promise<void> }[] = [];
	const messages: { customType: string; text: string }[] = [];
	const pi = {
		registerTool: (tool: ToolDefinition) => tools.push(tool),
		registerCommand: (name: string, options: { handler: (args: string, ctx: never) => Promise<void> }) =>
			commands.push({ name, handler: options.handler }),
		sendMessage: (message: { customType: string; content: { type: string; text: string }[] }) =>
			messages.push({ customType: message.customType, text: message.content[0].text }),
	} as unknown as ExtensionAPI;
	resetPaoSubcommandsForTest();
	const runSub = async (name: string, args = "", ctx: unknown = {}) => {
		const sub = listPaoSubcommands(pi).find((entry) => entry.name === name);
		if (!sub) throw new Error(`子命令 ${name} 未注册`);
		await sub.run(pi, args, ctx);
	};
	return { tools, commands, messages, pi, runSub };
}

/** 临时任务工作区＋已批准模板库：<root>/pao配置/卡模板/ 侦察、空骨架 两枚 */
function tempWorkspace(): { root: string; cardsDir: string; registryPath: string; paoHome: string } {
	const root = mkdtempSync(join(tmpdir(), "pao-m2-02-"));
	tempDirs.push(root);
	const cardsDir = join(root, "pao", "task-20261003", "卡");
	mkdirSync(cardsDir, { recursive: true });
	const registryPath = join(root, "pao", "部门", "注册表.md");
	mkdirSync(join(root, "pao", "部门"), { recursive: true });
	const rows: DeptRegistryRow[] = [
		{ 名字: "后端", 标签: ["api"], 库路径: "部门/后端/知识库" },
		{ 名字: "测试", 标签: ["qa"], 库路径: "部门/测试/知识库" },
	];
	writeFileSync(registryPath, formatRegistry(rows), "utf8");
	const paoHome = join(root, "pao");
	const templateDir = join(paoHome, "pao配置", "卡模板");
	mkdirSync(templateDir, { recursive: true });
	writeFileSync(
		join(templateDir, "侦察.md"),
		"---\n目标: 模板占位\n---\n\n## 机械验收\n\n- 只认机械句式：列出全部文件清单并落产物\n- 约束：引用 约束.md，不复述标准\n",
		"utf8",
	);
	writeFileSync(join(templateDir, "空骨架.md"), "---\n目标: 只有 frontmatter\n---\n", "utf8");
	return { root, cardsDir, registryPath, paoHome };
}

async function seedParentCard(cardsDir: string): Promise<void> {
	await createCard(cardsDir, {
		目标: "登录页改版",
		部门: "前端",
		验收: "页面渲染并测试绿",
		创建: "2026-10-03 09:00",
	});
}

function collabToolOf(captured: { tools: ToolDefinition[] }): ToolDefinition {
	return captured.tools.find((t) => t.name === "pao_collab_relay")!;
}

describe("协作中转:已批准模板绑定授权范围", () => {
	it("库内模板名 → 放行落卡,模板正文骨架进卡正文,frontmatter 不新增模板字段", async () => {
		const { cardsDir, registryPath, paoHome } = tempWorkspace();
		await seedParentCard(cardsDir);
		const captured = capturePi();
		registerCollab(captured.pi, {
			resolveCardsDir: () => cardsDir,
			resolveRegistryPath: () => registryPath,
			resolvePaoHome: () => paoHome,
		});
		const result = await collabToolOf(captured).execute(
			"t1",
			{ goal: "侦察登录模块", dept: "后端", acceptance: "地图落产物", parent: "卡#1", template: "侦察" },
			undefined,
			undefined,
			{} as never,
		);
		expect((result.details as CollabReviewResult).裁决).toBe("放行");
		const collab = listCards(cardsDir).find((c) => c.card_no === 2)!;
		expect(collab.body).toContain("机械验收");
		expect(collab.body).toContain("列出全部文件清单并落产物");
		const raw = readFileSync(collab.path, "utf8");
		expect(raw).not.toMatch(/^模板:/m); // 协议零新增:模板是路由字段,不落 frontmatter
	});

	it("绝对路径模板 → 拒绝(模板未批准):只收已批准库,不收来路不明的正文", async () => {
		const { cardsDir, registryPath, paoHome, root } = tempWorkspace();
		await seedParentCard(cardsDir);
		const captured = capturePi();
		registerCollab(captured.pi, {
			resolveCardsDir: () => cardsDir,
			resolveRegistryPath: () => registryPath,
			resolvePaoHome: () => paoHome,
		});
		const result = await collabToolOf(captured).execute(
			"t1",
			{ goal: "侦察", dept: "后端", acceptance: "地图落产物", parent: "卡#1", template: join(root, "来路不明.md") },
			undefined,
			undefined,
			{} as never,
		);
		expect((result.details as CollabReviewResult).裁决).toBe("拒绝");
		const reason = (result.details as CollabReviewResult).原因.find((r) => r.类型 === "模板未批准");
		expect(reason!.说明).toContain("不收绝对路径");
		expect(listCards(cardsDir)).toHaveLength(1); // 未落卡
	});

	it("相对路径穿越(../../ 指向库外 .md) → 拒绝(模板未批准):解析后必须仍在模板库内", async () => {
		const { cardsDir, registryPath, paoHome } = tempWorkspace();
		await seedParentCard(cardsDir);
		// 库外放一枚真 .md 诱惑穿越:库目录 = paoHome/pao配置/卡模板,
		// ../../ 从卡模板退两级落到 paoHome 根——文件在那里真实存在,
		// 必须由包含防线拒绝,而不是靠「找不到文件」碰巧拦下
		writeFileSync(join(paoHome, "库外.md"), "# 别处的正文\n\n- 诱饵条目\n", "utf8");
		const captured = capturePi();
		registerCollab(captured.pi, {
			resolveCardsDir: () => cardsDir,
			resolveRegistryPath: () => registryPath,
			resolvePaoHome: () => paoHome,
		});
		const result = await collabToolOf(captured).execute(
			"t-trav",
			{ goal: "侦察", dept: "后端", acceptance: "地图落产物", parent: "卡#1", template: "../../库外.md" },
			undefined,
			undefined,
			{} as never,
		);
		expect((result.details as CollabReviewResult).裁决).toBe("拒绝");
		const reason = (result.details as CollabReviewResult).原因.find((r) => r.类型 === "模板未批准");
		expect(reason!.说明).toContain("越出已批准模板库");
		expect(listCards(cardsDir)).toHaveLength(1); // 未落卡,库外正文没进卡
	});

	it("库外名字/只有 frontmatter 的空骨架 → 拒绝(模板未批准),不静默降级为无模板", async () => {
		const { cardsDir, registryPath, paoHome } = tempWorkspace();
		await seedParentCard(cardsDir);
		const captured = capturePi();
		registerCollab(captured.pi, {
			resolveCardsDir: () => cardsDir,
			resolveRegistryPath: () => registryPath,
			resolvePaoHome: () => paoHome,
		});
		const tool = collabToolOf(captured);
		const absent = await tool.execute(
			"t1",
			{ goal: "侦察", dept: "后端", acceptance: "x", parent: "卡#1", template: "不存在的模板" },
			undefined,
			undefined,
			{} as never,
		);
		expect((absent.details as CollabReviewResult).原因.some((r) => r.类型 === "模板未批准")).toBe(true);
		const emptySkeleton = await tool.execute(
			"t2",
			{ goal: "侦察", dept: "后端", acceptance: "x", parent: "卡#1", template: "空骨架" },
			undefined,
			undefined,
			{} as never,
		);
		const reason = (emptySkeleton.details as CollabReviewResult).原因.find((r) => r.类型 === "模板未批准");
		expect(reason!.说明).toContain("没有正文骨架");
		expect(listCards(cardsDir)).toHaveLength(1);
	});
});

// ============================================================================
// /派 用户直派的审计留痕（M2-02:程序直接落队列并留审计——用户直派也不缺账）
// ============================================================================

describe("/pao collab 审计留痕", () => {
	it("落卡成功 → 审计 JSONL 记 用户直派(来源部门=用户,卡号=新卡)", async () => {
		const { cardsDir, root } = tempWorkspace();
		const captured = capturePi();
		registerCollab(captured.pi, { resolveCardsDir: () => cardsDir });
		await captured.runSub("collab", "修超时 | 后端 | 全部登录测试绿");
		expect(captured.messages[0].text).toContain("已派卡");
		const lines = readFileSync(join(cardsDir, "..", "协作审计.jsonl"), "utf8")
			.trim()
			.split("\n");
		expect(lines).toHaveLength(1);
		const record = JSON.parse(lines[0]) as CollabAuditRecord;
		expect(record).toMatchObject({
			来源部门: "用户",
			目标部门: "后端",
			卡号: 1,
			校验结果: "用户直派",
			目标: "修超时",
		});
		expect(root.length).toBeGreaterThan(0); // root 归 afterEach 清理
	});

	it("审计写入失败不回滚落卡:卡照落,回执文本如实标注", async () => {
		const { cardsDir } = tempWorkspace();
		const captured = capturePi();
		registerCollab(captured.pi, {
			resolveCardsDir: () => cardsDir,
			resolveAuditPath: () => cardsDir, // 目录不可当文件追加 → 写审计必炸
		});
		await captured.runSub("collab", "修超时 | 后端 | 全部登录测试绿");
		expect(captured.messages[0].text).toContain("已派卡");
		expect(captured.messages[0].text).toContain("审计写入失败");
		expect(listCards(cardsDir)).toHaveLength(1); // 卡是任务真相,不因旁挂审计失败而丢
	});
});
