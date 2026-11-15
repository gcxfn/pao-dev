/**
 * 临时计划定义（通用工作台 · 阶段 3 第 ①–③⑤ 项）回归。
 * 覆盖：结构/依赖/成环/未知部门校验、请求 ID 幂等与并发、版本漂移、撤销冻结、
 * 定义→v2 配方适配、启动关联找回（含响应丢失）、确认事实可信来源、模板白名单保存。
 */
import type * as fs from "node:fs";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startWorkflow } from "../../src/pao/workflow/driver.ts";
import {
	assertPlanConfirmation,
	createTemporaryPlan,
	findTemplatePaths,
	listPlanHistory,
	listTemporaryPlans,
	modifyTemporaryPlan,
	planDir,
	planExecDir,
	planFilePath,
	planHistoryPath,
	planRecipeName,
	planStartRecordPath,
	planToRecipe,
	queryTemporaryPlan,
	readTemporaryPlan,
	recordPlanStart,
	recordStartIntent,
	resolvePlanExecution,
	resolveRecoverablePlan,
	revertTemporaryPlan,
	savePlanAsTemplate,
	TemporaryPlanError,
	undoTemporaryPlan,
} from "../../src/pao/workflow/plan.ts";
import { parseRecipe } from "../../src/pao/workflow/recipe.ts";
import { parseFrontmatter } from "../../src/utils/frontmatter.ts";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const dirs: string[] = [];
const 部门 = ["策划部", "写作部", "审稿部"];
/** 创建计划的来源主控：批次 A 起改/撤/启/存模板都要带它，否则被归属检查拒。 */
const 会话 = "sess-1";

function tempDir(prefix = "pao-plan-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

function 步骤(overrides: Partial<Parameters<typeof createTemporaryPlan>[0]["步骤"][number]> = {}) {
	return {
		标题: "讨论计划",
		部门: "策划部",
		要求: "把小说方向与章节计划讨论清楚",
		...overrides,
	};
}

async function 建计划(项目根: string, overrides: Partial<Parameters<typeof createTemporaryPlan>[0]> = {}) {
	return createTemporaryPlan({
		项目根,
		显示名: "小说创作",
		来源会话: "sess-1",
		步骤: [步骤(), 步骤({ 标题: "写初稿", 部门: "写作部", 要求: "按计划写初稿", 依赖: [] })],
		请求ID: "req-create-1",
		已注册部门: 部门,
		当刻: "2026-10-14 10:00",
		...overrides,
	});
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("临时计划定义：创建与校验（阶段 3 第 ①②项）", () => {
	it("创建落盘后读回一致，步骤 ID 按顺序稳定发号", async () => {
		const 项目根 = tempDir();
		const created = await 建计划(项目根);
		expect(created.回放).toBe(false);
		expect(created.计划ID).toMatch(/^p-\d{8}-[0-9a-f]{6}$/);
		expect(created.定义版本).toBe(1);
		expect(existsSync(planFilePath(项目根, created.计划ID))).toBe(true);
		const definition = readTemporaryPlan(项目根, created.计划ID);
		expect(definition.显示名).toBe("小说创作");
		expect(definition.来源会话).toBe("sess-1");
		expect(definition.步骤.map((step) => step.步骤ID)).toEqual(["s1", "s2"]);
		expect(definition.步骤.map((step) => step.标题)).toEqual(["讨论计划", "写初稿"]);
		expect(created.摘要).toContain("临时计划");
		expect(created.摘要).toContain("s1 讨论计划（策划部）");
	});

	it("创建只落定义，不落控制正本、不落卡（创建不启动）", async () => {
		const 项目根 = tempDir();
		const created = await 建计划(项目根);
		const execDir = planExecDir(项目根, created.计划ID, "start-1");
		expect(existsSync(execDir)).toBe(false);
	});

	it("未知部门/缺标题/缺要求/依赖不存在/依赖成环/审核缺标准都在落盘前拒", async () => {
		const 项目根 = tempDir();
		const cases: { 步骤: ReturnType<typeof 步骤>[]; 期望: string }[] = [
			{ 步骤: [步骤({ 部门: "不存在部" })], 期望: "部门未注册" },
			{ 步骤: [步骤({ 标题: "  " })], 期望: "缺「标题」" },
			{ 步骤: [步骤({ 要求: " " })], 期望: "缺「要求」" },
			{ 步骤: [步骤({ 标题: "甲", 依赖: ["s9"] })], 期望: "依赖不存在的步骤" },
			{ 步骤: [步骤({ 标题: "甲", 依赖: ["s1"] })], 期望: "依赖自身" },
			{
				步骤: [
					步骤({ 标题: "甲", 依赖: ["s3"] }),
					步骤({ 标题: "乙", 依赖: ["s1"] }),
					步骤({ 标题: "丙", 依赖: ["s2"] }),
				],
				期望: "依赖成环",
			},
			{ 步骤: [步骤({ 审核: true })], 期望: "标了审核但缺「部门标准」" },
		];
		for (const [index, item] of cases.entries()) {
			await expect(
				建计划(项目根, { 步骤: item.步骤, 请求ID: `req-bad-${index}`, 当刻: "2026-10-14 10:00" }),
			).rejects.toThrow(item.期望);
		}
		expect(listTemporaryPlans(项目根)).toHaveLength(0);
	});

	it("同请求 ID 重试是回放：盘上只有一份定义、版本不动", async () => {
		const 项目根 = tempDir();
		const first = await 建计划(项目根);
		const again = await 建计划(项目根);
		expect(again.回放).toBe(true);
		expect(again.计划ID).toBe(first.计划ID);
		expect(again.定义版本).toBe(1);
		expect(listTemporaryPlans(项目根)).toHaveLength(1);
	});

	it("同请求 ID 换参数被拒（不许拿旧 ID 塞新内容）", async () => {
		const 项目根 = tempDir();
		await 建计划(项目根);
		await expect(建计划(项目根, { 显示名: "另一部小说" })).rejects.toThrow("已用于另一组参数");
	});

	it("并发同请求 ID 只落一份定义（项目级锁内查幂等）", async () => {
		const 项目根 = tempDir();
		const results = await Promise.all([建计划(项目根), 建计划(项目根), 建计划(项目根)]);
		expect(new Set(results.map((result) => result.计划ID)).size).toBe(1);
		expect(results.filter((result) => result.回放 === false)).toHaveLength(1);
		expect(listTemporaryPlans(项目根)).toHaveLength(1);
	});

	it("不同请求 ID 建同名计划可以并存（不按名字合并）", async () => {
		const 项目根 = tempDir();
		const a = await 建计划(项目根, { 请求ID: "req-a" });
		const b = await 建计划(项目根, { 请求ID: "req-b" });
		expect(a.计划ID).not.toBe(b.计划ID);
		expect(listTemporaryPlans(项目根)).toHaveLength(2);
	});
});

describe("临时计划定义：修改与撤销（阶段 3 第 ③项）", () => {
	it("改标题不动步骤 ID，定义版本 +1", async () => {
		const 项目根 = tempDir();
		const created = await 建计划(项目根);
		const definition = readTemporaryPlan(项目根, created.计划ID);
		const 改后 = definition.步骤.map((step, index) => (index === 0 ? { ...step, 标题: "重新讨论计划" } : step));
		const modified = await modifyTemporaryPlan({
			项目根,
			来源会话: 会话,
			计划ID: created.计划ID,
			请求ID: "req-modify-1",
			预期定义版本: 1,
			步骤: 改后,
			已注册部门: 部门,
			当刻: "2026-10-14 11:00",
		});
		expect(modified.定义版本).toBe(2);
		const after = readTemporaryPlan(项目根, created.计划ID);
		expect(after.步骤.map((step) => step.步骤ID)).toEqual(["s1", "s2"]);
		expect(after.步骤[0]!.标题).toBe("重新讨论计划");
	});

	it("预期版本与盘上不一致（版本漂移）拒改", async () => {
		const 项目根 = tempDir();
		const created = await 建计划(项目根);
		await expect(
			modifyTemporaryPlan({
				项目根,
				来源会话: 会话,
				计划ID: created.计划ID,
				请求ID: "req-modify-stale",
				预期定义版本: 99,
				显示名: "改个名",
				已注册部门: 部门,
			}),
		).rejects.toThrow("定义版本漂移");
	});

	it("撤销是一把有版本检查的修改：定义保留、状态标已撤销、之后不能再改不能启", async () => {
		const 项目根 = tempDir();
		const created = await 建计划(项目根);
		const undone = await undoTemporaryPlan({
			项目根,
			来源会话: 会话,
			计划ID: created.计划ID,
			请求ID: "req-undo-1",
			预期定义版本: 1,
			当刻: "2026-10-14 12:00",
		});
		expect(undone.定义版本).toBe(2);
		expect(readTemporaryPlan(项目根, created.计划ID).已撤销).toBe(true);
		await expect(
			modifyTemporaryPlan({
				项目根,
				来源会话: 会话,
				计划ID: created.计划ID,
				请求ID: "req-modify-after-undo",
				预期定义版本: 2,
				显示名: "再改",
				已注册部门: 部门,
			}),
		).rejects.toThrow("已撤销，不能再改");
		expect(() =>
			resolvePlanExecution({ 项目根, 计划ID: created.计划ID, 启动请求ID: "start-1", 定义版本: 2, 来源会话: 会话 }),
		).toThrow("已撤销，不能启动");
	});

	it("定义文件损坏时显式报错，不重建假状态", async () => {
		const 项目根 = tempDir();
		const created = await 建计划(项目根);
		writeFileSync(planFilePath(项目根, created.计划ID), "---\n显示名: 只有名字\n---\n", "utf8");
		expect(() => readTemporaryPlan(项目根, created.计划ID)).toThrow(TemporaryPlanError);
		expect(() => readTemporaryPlan(项目根, created.计划ID)).toThrow("缺「计划ID」");
	});
});

describe("临时计划 → v2 配方适配（阶段 3 第 ②项）", () => {
	it("节点名＝稳定步骤 ID，依赖映射为节点名，人工门与验收按定义落进配方", async () => {
		const 项目根 = tempDir();
		const created = await createTemporaryPlan({
			项目根,
			来源会话: 会话,
			显示名: "小说创作",
			步骤: [
				步骤({
					标题: "写初稿",
					部门: "写作部",
					要求: "按计划写初稿",
					预期成果: "创作成果/第1章/初稿.md",
					人工门: true,
					约束: "不要改设定大纲",
					预算: { turns: 1000 },
					档位: "primary",
					技能: ["小说笔法"],
				}),
				步骤({ 标题: "审稿", 部门: "审稿部", 要求: "逐条审稿", 依赖: [], 审核: true, 部门标准: "审稿部标准.md" }),
			],
			请求ID: "req-recipe",
			已注册部门: 部门,
		});
		const definition = readTemporaryPlan(项目根, created.计划ID);
		const recipe = planToRecipe({
			...definition,
			步骤: definition.步骤.map((step, index) => (index === 1 ? { ...step, 依赖: ["s1"] } : step)),
		});
		expect(recipe.版本).toBe(2);
		expect(recipe.名字).toBe(planRecipeName(created.计划ID));
		expect(recipe.自动执行).toBe(true);
		expect(recipe.节点.map((node) => node.名字)).toEqual(["s1", "s2"]);
		expect(recipe.节点[1]!.depends_on).toEqual(["s1"]);
		expect(recipe.节点[0]!.人工确认).toBe(true);
		expect(recipe.节点[1]!.人工确认).toBe(false);
		expect(recipe.节点[0]!.验收).toBe("创作成果/第1章/初稿.md");
		expect(recipe.节点[0]!.目标).toContain("写初稿");
		expect(recipe.节点[0]!.目标).toContain("预期成果：创作成果/第1章/初稿.md");
		expect(recipe.节点[0]!.预算).toEqual({ turns: 1000 });
		expect(recipe.节点[0]!.技能).toEqual(["小说笔法"]);
		expect(recipe.节点[1]!.审核).toBe(true);
		expect(recipe.节点[1]!.部门标准).toBe("审稿部标准.md");
		expect(recipe.拓扑序).toEqual(["s1", "s2"]);
	});

	it("配方发射后能过既有全量校验（emit + parseRecipe 同源）", async () => {
		const 项目根 = tempDir();
		const created = await 建计划(项目根);
		const recipe = planToRecipe(readTemporaryPlan(项目根, created.计划ID));
		expect(recipe.节点).toHaveLength(2);
		expect(recipe.占位符).toEqual([]);
	});
});

describe("确认事实（阶段 3 第 ③项：模型自述不算确认）", () => {
	const expect3 = { 计划ID: "p-20261014-abcdef", 定义版本: 3, 启动请求ID: "start-1" };

	it("没有确认事实 / 来源不可信 / 三者不一致都拒", () => {
		expect(() => assertPlanConfirmation(undefined, expect3)).toThrow("需要宿主确认回调");
		expect(() => assertPlanConfirmation({ confirmed: true }, expect3)).toThrow("来源不可信");
		expect(() => assertPlanConfirmation({ ...expect3, 来源: "模型推断", 时刻: "2026-10-14 10:00" }, expect3)).toThrow(
			"来源不可信",
		);
		expect(() =>
			assertPlanConfirmation({ ...expect3, 定义版本: 2, 来源: "宿主确认回调", 时刻: "2026-10-14 10:00" }, expect3),
		).toThrow("与本次请求不一致");
	});

	it("宿主确认回调给的同一版事实放行", () => {
		const confirmation = { ...expect3, 来源: "宿主确认回调" as const, 时刻: "2026-10-14 10:00" };
		expect(assertPlanConfirmation(confirmation, expect3)).toEqual(confirmation);
	});
});

describe("启动关联与找回（阶段 3 第 ④项）", () => {
	it("未启动时给出确定的工作区/卡目录/控制清单，不落任何文件", async () => {
		const 项目根 = tempDir();
		const created = await 建计划(项目根);
		const execution = resolvePlanExecution({
			项目根,
			来源会话: 会话,
			计划ID: created.计划ID,
			启动请求ID: "start-1",
			定义版本: 1,
		});
		expect(execution.工作区).toBe(planExecDir(项目根, created.计划ID, "start-1"));
		expect(execution.卡目录).toBe(join(execution.工作区, "卡"));
		expect(execution.控制清单).toBe(join(execution.工作区, `工作流实例-${planRecipeName(created.计划ID)}.md`));
		expect(execution.找回).toBeUndefined();
		expect(existsSync(execution.工作区)).toBe(false);
	});

	it("真实启动一次 v2 实例：受理后按启动请求 ID 找回同一实例，不启第二份", async () => {
		const 项目根 = tempDir();
		const created = await 建计划(项目根);
		const execution = resolvePlanExecution({
			项目根,
			来源会话: 会话,
			计划ID: created.计划ID,
			启动请求ID: "start-1",
			定义版本: 1,
		});
		await startWorkflow(
			execution.配方,
			{},
			{
				cardsDir: execution.卡目录,
				workspaceDir: execution.工作区,
				ownerSessionId: "sess-1",
			},
		);
		const 实例 = parseFrontmatter<{ 实例: string }>(readFileSync(execution.控制清单, "utf8")).frontmatter.实例;
		expect(实例).toBeTruthy();
		recordPlanStart(execution.关联路径, {
			计划ID: created.计划ID,
			定义版本: 1,
			启动请求ID: "start-1",
			实例,
			配方名: execution.配方名,
			工作区: execution.工作区,
			卡目录: execution.卡目录,
			控制清单: execution.控制清单,
			owner会话: "sess-1",
			受理时刻: "2026-10-14 10:30",
		});
		const retry = resolvePlanExecution({
			项目根,
			计划ID: created.计划ID,
			启动请求ID: "start-1",
			定义版本: 1,
			来源会话: 会话,
		});
		expect(retry.找回?.实例).toBe(实例);
		// 只受理一次：再起一次 v2 会被既有「实例已存在」守卫挡住，不会出现第二份控制正本
		await expect(
			startWorkflow(
				retry.配方,
				{},
				{
					cardsDir: retry.卡目录,
					workspaceDir: retry.工作区,
					ownerSessionId: "sess-1",
				},
			),
		).rejects.toThrow("实例已存在");
		expect(readdirSync(execution.工作区).filter((name) => name.startsWith("工作流实例-"))).toHaveLength(1);
	});

	it("控制正本已形成但关联丢失（响应丢失/进程中断）：仍能找回原实例，不误报未受理", async () => {
		const 项目根 = tempDir();
		const created = await 建计划(项目根);
		const execution = resolvePlanExecution({
			项目根,
			来源会话: 会话,
			计划ID: created.计划ID,
			启动请求ID: "start-lost",
			定义版本: 1,
		});
		await startWorkflow(
			execution.配方,
			{},
			{
				cardsDir: execution.卡目录,
				workspaceDir: execution.工作区,
				ownerSessionId: "sess-1",
			},
		);
		expect(existsSync(execution.关联路径)).toBe(false);
		const retry = resolvePlanExecution({
			项目根,
			计划ID: created.计划ID,
			启动请求ID: "start-lost",
			定义版本: 1,
			来源会话: 会话,
		});
		expect(retry.找回?.实例).toBeTruthy();
		expect(retry.找回?.控制清单).toBe(execution.控制清单);
	});

	it("关联指向的实例与控制正本对不上：报不完整启动，不下「未受理」结论也不再启", async () => {
		const 项目根 = tempDir();
		const created = await 建计划(项目根);
		const execution = resolvePlanExecution({
			项目根,
			来源会话: 会话,
			计划ID: created.计划ID,
			启动请求ID: "start-partial",
			定义版本: 1,
		});
		mkdirSync(execution.工作区, { recursive: true });
		writeFileSync(execution.控制清单, `---\n版本: 2\n实例: 真实例\nowner: sess-1\n---\n`, "utf8");
		recordPlanStart(execution.关联路径, {
			计划ID: created.计划ID,
			定义版本: 1,
			启动请求ID: "start-partial",
			实例: "另一个实例",
			配方名: execution.配方名,
			工作区: execution.工作区,
			卡目录: execution.卡目录,
			控制清单: execution.控制清单,
			owner会话: "sess-1",
			受理时刻: "2026-10-14 10:30",
		});
		expect(() =>
			resolvePlanExecution({
				项目根,
				计划ID: created.计划ID,
				启动请求ID: "start-partial",
				定义版本: 1,
				来源会话: 会话,
			}),
		).toThrow("不完整启动");
	});

	it("确认后计划被改（版本漂移）则旧确认失效，拒启", async () => {
		const 项目根 = tempDir();
		const created = await 建计划(项目根);
		const definition = readTemporaryPlan(项目根, created.计划ID);
		await modifyTemporaryPlan({
			项目根,
			来源会话: 会话,
			计划ID: created.计划ID,
			请求ID: "req-modify-2",
			预期定义版本: 1,
			步骤: definition.步骤.map((step, index) => (index === 0 ? { ...step, 标题: "改过的标题" } : step)),
			已注册部门: 部门,
		});
		expect(() =>
			resolvePlanExecution({ 项目根, 计划ID: created.计划ID, 启动请求ID: "start-1", 定义版本: 1, 来源会话: 会话 }),
		).toThrow("旧确认失效");
	});

	it("已启动的计划定义被冻结：不能再改也不能再撤", async () => {
		const 项目根 = tempDir();
		const created = await 建计划(项目根);
		const execution = resolvePlanExecution({
			项目根,
			来源会话: 会话,
			计划ID: created.计划ID,
			启动请求ID: "start-1",
			定义版本: 1,
		});
		await startWorkflow(
			execution.配方,
			{},
			{
				cardsDir: execution.卡目录,
				workspaceDir: execution.工作区,
				ownerSessionId: "sess-1",
			},
		);
		recordPlanStart(execution.关联路径, {
			计划ID: created.计划ID,
			定义版本: 1,
			启动请求ID: "start-1",
			实例: parseFrontmatter<{ 实例: string }>(readFileSync(execution.控制清单, "utf8")).frontmatter.实例,
			配方名: execution.配方名,
			工作区: execution.工作区,
			卡目录: execution.卡目录,
			控制清单: execution.控制清单,
			owner会话: "sess-1",
			受理时刻: "2026-10-14 10:30",
		});
		await expect(
			modifyTemporaryPlan({
				项目根,
				来源会话: 会话,
				计划ID: created.计划ID,
				请求ID: "req-modify-started",
				预期定义版本: 1,
				显示名: "改不动",
				已注册部门: 部门,
			}),
		).rejects.toThrow("定义已冻结");
		await expect(
			undoTemporaryPlan({
				项目根,
				计划ID: created.计划ID,
				请求ID: "req-undo-started",
				预期定义版本: 1,
				来源会话: 会话,
			}),
		).rejects.toThrow("定义已冻结");
	});
});

describe("查询与模板保存（阶段 3 第 ③④⑤项）", () => {
	it("查询列全部：报出哪份已启动到哪个实例；坏定义逐条点名不当没有", async () => {
		const 项目根 = tempDir();
		const created = await 建计划(项目根);
		const execution = resolvePlanExecution({
			项目根,
			来源会话: 会话,
			计划ID: created.计划ID,
			启动请求ID: "start-1",
			定义版本: 1,
		});
		await startWorkflow(
			execution.配方,
			{},
			{
				cardsDir: execution.卡目录,
				workspaceDir: execution.工作区,
				ownerSessionId: "sess-1",
			},
		);
		recordPlanStart(execution.关联路径, {
			计划ID: created.计划ID,
			定义版本: 1,
			启动请求ID: "start-1",
			实例: parseFrontmatter<{ 实例: string }>(readFileSync(execution.控制清单, "utf8")).frontmatter.实例,
			配方名: execution.配方名,
			工作区: execution.工作区,
			卡目录: execution.卡目录,
			控制清单: execution.控制清单,
			owner会话: "sess-1",
			受理时刻: "2026-10-14 10:30",
		});
		const broken = await 建计划(项目根, { 请求ID: "req-broken", 显示名: "坏定义" });
		writeFileSync(planFilePath(项目根, broken.计划ID), "---\n显示名: 只有名字\n---\n", "utf8");
		vi.mocked(readFileSync).mockClear();
		const view = queryTemporaryPlan(项目根);
		expect(view.摘要).toContain("已启动：");
		expect(view.摘要).toContain(created.计划ID);
		expect(view.启动.map((start) => start.启动请求ID)).toEqual(["start-1"]);
		const definitionPaths = readdirSync(join(项目根, ".pao", "临时工作流"))
			.map((name) => join(项目根, ".pao", "临时工作流", name, "计划.md"))
			.filter(existsSync);
		const definitionReads = definitionPaths.map(
			(path) => vi.mocked(readFileSync).mock.calls.filter(([readPath]) => readPath === path).length,
		);
		expect(definitionReads).toEqual([1, 1]);
		const startRecordPath = planStartRecordPath(项目根, created.计划ID, "start-1");
		expect(vi.mocked(readFileSync).mock.calls.filter(([readPath]) => readPath === startRecordPath).length).toBe(1);
		expect(view.问题).toHaveLength(1);
		expect(view.问题[0]).toContain("缺「计划ID」");
		expect(queryTemporaryPlan(项目根, created.计划ID).定义?.计划ID).toBe(created.计划ID);
	});

	it("保存模板：白名单发射进模板库，定义版本不一致或同名已存在都拒", async () => {
		const 项目根 = tempDir();
		const paoHome = tempDir("pao-plan-home-");
		const created = await 建计划(项目根);
		const saved = savePlanAsTemplate({
			项目根,
			来源会话: 会话,
			计划ID: created.计划ID,
			定义版本: 1,
			模板名: "小说创作模板",
			paoHome,
		});
		expect(existsSync(saved.路径)).toBe(true);
		const recipe = parseRecipe(readFileSync(saved.路径, "utf8"), saved.路径);
		expect(recipe.版本).toBe(2);
		expect(recipe.节点.map((node) => node.名字)).toEqual(["s1", "s2"]);
		expect(recipe.名字).toBe("小说创作模板");
		expect(() =>
			savePlanAsTemplate({
				项目根,
				计划ID: created.计划ID,
				来源会话: 会话,
				定义版本: 1,
				模板名: "小说创作模板",
				paoHome,
			}),
		).toThrow("已被占用");
		expect(() =>
			savePlanAsTemplate({
				项目根,
				计划ID: created.计划ID,
				来源会话: 会话,
				定义版本: 9,
				模板名: "另一个名字",
				paoHome,
			}),
		).toThrow("定义版本漂移");
	});

	it("本次特有路径默认拒存模板并列出路径；显式确认后保存且回报未泛化名单", async () => {
		const 项目根 = tempDir();
		const paoHome = tempDir("pao-plan-home-");
		const created = await createTemporaryPlan({
			项目根,
			来源会话: 会话,
			显示名: "小说创作",
			步骤: [步骤({ 预期成果: join(项目根, "创作成果", "第1章.md"), 要求: "写第 1 章" })],
			请求ID: "req-path",
			已注册部门: 部门,
		});
		const definition = readTemporaryPlan(项目根, created.计划ID);
		expect(findTemplatePaths(definition).some((path) => path.includes("创作成果"))).toBe(true);
		expect(() =>
			savePlanAsTemplate({
				项目根,
				计划ID: created.计划ID,
				来源会话: 会话,
				定义版本: 1,
				模板名: "带路径的模板",
				paoHome,
			}),
		).toThrow("含本次特有路径");
		const saved = savePlanAsTemplate({
			项目根,
			来源会话: 会话,
			计划ID: created.计划ID,
			定义版本: 1,
			模板名: "带路径的模板",
			paoHome,
			允许未泛化路径: true,
		});
		expect(saved.未泛化路径.some((path) => path.includes("创作成果"))).toBe(true);
	});
});

describe("归属校验：项目与来源主控（批次 A 第 ①项）", () => {
	it("定义落在本项目、记的却是别的项目根：拒改（PLAN_FORBIDDEN），不当成没这回事", async () => {
		const 项目根 = tempDir();
		const 别的项目 = tempDir();
		const created = await 建计划(项目根);
		// 把定义目录整份搬到别的项目下：路径在 B，frontmatter 里的「项目根」还写着 A。
		const 目标 = join(别的项目, ".pao", "临时工作流", created.计划ID);
		mkdirSync(dirname(目标), { recursive: true });
		cpSync(planDir(项目根, created.计划ID), 目标, { recursive: true });
		const err = await modifyTemporaryPlan({
			项目根: 别的项目,
			来源会话: 会话,
			计划ID: created.计划ID,
			请求ID: "req-cross-project",
			预期定义版本: 1,
			显示名: "跨项目改名",
			已注册部门: 部门,
		}).catch((error: unknown) => error);
		expect(err).toBeInstanceOf(TemporaryPlanError);
		expect((err as TemporaryPlanError).code).toBe("PLAN_FORBIDDEN");
		expect((err as TemporaryPlanError).message).toContain("不能跨项目操作");
		expect((err as TemporaryPlanError).details).toMatchObject({ 计划项目根: 项目根, 当前项目根: 别的项目 });
	});

	it("在本项目里操作别的项目的计划：找不到就是找不到，不误报成项目不符", async () => {
		const 项目根 = tempDir();
		const 别的项目 = tempDir();
		await 建计划(项目根);
		// 计划只在 A 里；拿 B 去操作，B 里根本没有这份定义。
		const err = await modifyTemporaryPlan({
			项目根: 别的项目,
			来源会话: 会话,
			计划ID: "p-20261014-000000",
			请求ID: "req-other-project",
			预期定义版本: 1,
			显示名: "跨项目改名",
			已注册部门: 部门,
		}).catch((error: unknown) => error);
		expect((err as TemporaryPlanError).code).toBe("PLAN_NOT_FOUND");
		expect(listTemporaryPlans(别的项目)).toHaveLength(0);
	});

	it("跨主控操作被拒：来源主控只能改自己建的这份计划", async () => {
		const 项目根 = tempDir();
		const created = await 建计划(项目根);
		const err = await modifyTemporaryPlan({
			项目根,
			来源会话: "sess-2",
			计划ID: created.计划ID,
			请求ID: "req-cross-owner",
			预期定义版本: 1,
			显示名: "别人来改",
			已注册部门: 部门,
		}).catch((error: unknown) => error);
		expect(err).toBeInstanceOf(TemporaryPlanError);
		expect((err as TemporaryPlanError).code).toBe("PLAN_FORBIDDEN");
		expect((err as TemporaryPlanError).message).toContain("来源主控是 sess-1");
		// 启动与存模板同样受限。
		expect(() =>
			resolvePlanExecution({
				项目根,
				计划ID: created.计划ID,
				启动请求ID: "start-1",
				定义版本: 1,
				来源会话: "sess-2",
			}),
		).toThrow("来源主控是 sess-1");
		expect(() =>
			savePlanAsTemplate({
				项目根,
				来源会话: "sess-2",
				计划ID: created.计划ID,
				定义版本: 1,
				模板名: "别人的模板",
				paoHome: tempDir("pao-plan-home-"),
			}),
		).toThrow("来源主控是 sess-1");
		// 撤销同理（异步入口）。
		await expect(
			undoTemporaryPlan({
				项目根,
				来源会话: "sess-2",
				计划ID: created.计划ID,
				请求ID: "req-cross-owner-undo",
				预期定义版本: 1,
			}),
		).rejects.toThrow("来源主控是 sess-1");
	});

	it("没登记来源主控的计划不设归属限制（CLI 一次性会话的常态）", async () => {
		const 项目根 = tempDir();
		const created = await createTemporaryPlan({
			项目根,
			显示名: "无主计划",
			步骤: [步骤()],
			请求ID: "req-no-owner",
			已注册部门: 部门,
		});
		await expect(
			modifyTemporaryPlan({
				项目根,
				来源会话: "sess-anyone",
				计划ID: created.计划ID,
				请求ID: "req-modify-no-owner",
				预期定义版本: 1,
				显示名: "谁都能改",
				已注册部门: 部门,
			}),
		).resolves.toMatchObject({ 定义版本: 2 });
	});
});

describe("取消穿透：受理前被取消不落任何东西（批次 A 第 ②项）", () => {
	const 已取消 = () => AbortSignal.abort(new Error("用户取消"));

	it("修改与撤销两个写入口都在受理前拒绝已取消的请求，且盘上定义不变", async () => {
		const 项目根 = tempDir();
		const created = await 建计划(项目根);
		const 改 = await modifyTemporaryPlan({
			项目根,
			来源会话: 会话,
			计划ID: created.计划ID,
			请求ID: "req-abort-modify",
			预期定义版本: 1,
			显示名: "取消了的改名",
			已注册部门: 部门,
			信号: 已取消(),
		}).catch((error: unknown) => error);
		expect((改 as TemporaryPlanError).code).toBe("PLAN_ABORTED");
		expect((改 as TemporaryPlanError).message).toContain("用户取消");
		expect((改 as TemporaryPlanError).message).toContain("没有落定义变更");
		expect(readTemporaryPlan(项目根, created.计划ID).定义版本).toBe(1);
		await expect(
			undoTemporaryPlan({
				项目根,
				来源会话: 会话,
				计划ID: created.计划ID,
				请求ID: "req-abort-undo",
				预期定义版本: 1,
				信号: 已取消(),
			}),
		).rejects.toThrow("在受理前被取消");
		expect(readTemporaryPlan(项目根, created.计划ID).已撤销).toBeUndefined();
	});

	it("启动与存模板也在受理前拒绝已取消的请求，不留执行目录与模板文件", async () => {
		const 项目根 = tempDir();
		const paoHome = tempDir("pao-plan-home-");
		const created = await 建计划(项目根);
		expect(() =>
			resolvePlanExecution({
				项目根,
				来源会话: 会话,
				计划ID: created.计划ID,
				启动请求ID: "start-abort",
				定义版本: 1,
				信号: 已取消(),
			}),
		).toThrow("在受理前被取消");
		expect(() =>
			savePlanAsTemplate({
				项目根,
				来源会话: 会话,
				计划ID: created.计划ID,
				定义版本: 1,
				模板名: "取消了的模板",
				paoHome,
				信号: 已取消(),
			}),
		).toThrow("在受理前被取消");
		expect(existsSync(planExecDir(项目根, created.计划ID, "start-abort"))).toBe(false);
		expect(existsSync(join(paoHome, "工作流", "取消了的模板.md"))).toBe(false);
	});
});

describe("冻结窗口：受理一落盘，编辑立刻被拒（批次 A 第 ③项）", () => {
	it("只有受理意图（控制正本还没形成）时，改与撤都已被冻结", async () => {
		const 项目根 = tempDir();
		const created = await 建计划(项目根);
		// 模拟「受理已落盘、实例尚未落实」的窗口：只写意图，不写完整关联、不启流。
		recordStartIntent(planStartRecordPath(项目根, created.计划ID, "start-intent"), {
			计划ID: created.计划ID,
			定义版本: 1,
			启动请求ID: "start-intent",
			owner会话: 会话,
		});
		await expect(
			modifyTemporaryPlan({
				项目根,
				来源会话: 会话,
				计划ID: created.计划ID,
				请求ID: "req-modify-window",
				预期定义版本: 1,
				显示名: "窗口里偷改",
				已注册部门: 部门,
			}),
		).rejects.toThrow("定义已冻结");
		await expect(
			undoTemporaryPlan({
				项目根,
				来源会话: 会话,
				计划ID: created.计划ID,
				请求ID: "req-undo-window",
				预期定义版本: 1,
			}),
		).rejects.toThrow("定义已冻结");
	});

	it("关联整份丢了、控制正本还在，照样算已启动：不能靠删关联解冻", async () => {
		const 项目根 = tempDir();
		const created = await 建计划(项目根);
		const execution = resolvePlanExecution({
			项目根,
			来源会话: 会话,
			计划ID: created.计划ID,
			启动请求ID: "start-no-record",
			定义版本: 1,
		});
		await startWorkflow(
			execution.配方,
			{},
			{ cardsDir: execution.卡目录, workspaceDir: execution.工作区, ownerSessionId: 会话 },
		);
		// 故意不写启动关联：只靠执行目录里的控制正本作为冻结证据。
		expect(existsSync(execution.关联路径)).toBe(false);
		await expect(
			modifyTemporaryPlan({
				项目根,
				来源会话: 会话,
				计划ID: created.计划ID,
				请求ID: "req-modify-no-record",
				预期定义版本: 1,
				显示名: "删了关联想解冻",
				已注册部门: 部门,
			}),
		).rejects.toThrow("定义已冻结");
	});

	it("受理意图还在、控制正本读不到时，同启动请求回报不完整启动而不是再启一份", async () => {
		const 项目根 = tempDir();
		const created = await 建计划(项目根);
		recordStartIntent(planStartRecordPath(项目根, created.计划ID, "start-half"), {
			计划ID: created.计划ID,
			定义版本: 1,
			启动请求ID: "start-half",
			owner会话: 会话,
		});
		const err = (() => {
			try {
				return resolvePlanExecution({
					项目根,
					来源会话: 会话,
					计划ID: created.计划ID,
					启动请求ID: "start-half",
					定义版本: 1,
				});
			} catch (error: unknown) {
				return error;
			}
		})();
		expect(err).toBeInstanceOf(TemporaryPlanError);
		expect((err as TemporaryPlanError).code).toBe("PLAN_START_PARTIAL");
		expect((err as TemporaryPlanError).message).toContain("不完整启动");
		expect((err as TemporaryPlanError).message).toContain("不会自动再启一份");
	});
});

describe("最小版本历史与撤销最近修改（批次 C 第 ①项：新审阅 6）", () => {
	it("改一次就存一版历史：内容是真旧版全文，不是只记差异", async () => {
		const 项目根 = tempDir();
		const created = await 建计划(项目根);
		await modifyTemporaryPlan({
			项目根,
			来源会话: 会话,
			计划ID: created.计划ID,
			请求ID: "req-h-1",
			预期定义版本: 1,
			显示名: "改过的名字",
			已注册部门: 部门,
			当刻: "2026-10-14 11:00",
		});
		const 历史 = listPlanHistory(项目根, created.计划ID);
		expect(历史.map((entry) => entry.定义版本)).toEqual([1]);
		// 历史里存的是被替换掉的那一版的完整定义（含名字与步骤），能直接读回来。
		expect(历史[0]!.定义?.显示名).toBe("小说创作");
		expect(历史[0]!.定义?.步骤).toHaveLength(2);
		expect(历史[0]!.问题).toBeUndefined();
		expect(readTemporaryPlan(项目根, created.计划ID).显示名).toBe("改过的名字");
	});

	it("撤销最近一次修改：内容真回到旧版，并作为新的一版落盘（版本号继续往前走）", async () => {
		const 项目根 = tempDir();
		const created = await 建计划(项目根);
		await modifyTemporaryPlan({
			项目根,
			来源会话: 会话,
			计划ID: created.计划ID,
			请求ID: "req-r-1",
			预期定义版本: 1,
			显示名: "改坏了的名字",
			已注册部门: 部门,
			当刻: "2026-10-14 11:00",
		});
		const 撤销 = await revertTemporaryPlan({
			项目根,
			来源会话: 会话,
			计划ID: created.计划ID,
			请求ID: "req-r-2",
			预期定义版本: 2,
			当刻: "2026-10-14 12:00",
		});
		expect(撤销.恢复自).toBe(1);
		expect(撤销.恢复为).toBe(3);
		expect(撤销.摘要).toContain("已撤销最近一次修改");
		expect(撤销.摘要).toContain("撤回整份计划");
		const 现在 = readTemporaryPlan(项目根, created.计划ID);
		// 内容真回到第 1 版；版本号是 3 而不是退回 1——撤销本身也是一次新修订。
		expect(现在.显示名).toBe("小说创作");
		expect(现在.定义版本).toBe(3);
		expect(现在.步骤.map((step) => step.标题)).toEqual(["讨论计划", "写初稿"]);
		// 撤销后这份计划仍然可以继续改（没有被冻结、没有被标已撤销）。
		expect(现在.已撤销).toBeUndefined();
	});

	it("撤销可以连着来：撤销动作本身也存档，第二次撤销回到上一次撤销前的那一版", async () => {
		const 项目根 = tempDir();
		const created = await 建计划(项目根);
		for (const [请求ID, 名字, 版本] of [
			["req-c-1", "第二版", 1],
			["req-c-2", "第三版", 2],
		] as const) {
			await modifyTemporaryPlan({
				项目根,
				来源会话: 会话,
				计划ID: created.计划ID,
				请求ID,
				预期定义版本: 版本,
				显示名: 名字,
				已注册部门: 部门,
			});
		}
		// 两次修改后历史里有第 1、2 版。
		expect(listPlanHistory(项目根, created.计划ID).map((entry) => entry.定义版本)).toEqual([1, 2]);
		// 第一次撤销（默认回到最近一版＝第 2 版「第二版」）：撤销动作把「第三版」也存档。
		await revertTemporaryPlan({
			项目根,
			来源会话: 会话,
			计划ID: created.计划ID,
			请求ID: "req-c-3",
			预期定义版本: 3,
		});
		expect(readTemporaryPlan(项目根, created.计划ID).显示名).toBe("第二版");
		// 第二次撤销：上一版（第三版）已被第一次撤销时存档，所以再退一步到「第三版」——
		// 撤销是「回到上一版」而不是「一直往回退到最初」，要回到第 1 版得用 target_version 点名。
		const 再撤 = await revertTemporaryPlan({
			项目根,
			来源会话: 会话,
			计划ID: created.计划ID,
			请求ID: "req-c-4",
			预期定义版本: 4,
		});
		expect(再撤.恢复自).toBe(3);
		expect(readTemporaryPlan(项目根, created.计划ID).显示名).toBe("第三版");
		// 点名第 1 版才能真的回到最初那一版。
		await revertTemporaryPlan({
			项目根,
			来源会话: 会话,
			计划ID: created.计划ID,
			请求ID: "req-c-5",
			预期定义版本: 5,
			目标定义版本: 1,
		});
		expect(readTemporaryPlan(项目根, created.计划ID).显示名).toBe("小说创作");
	});

	it("版本冲突拒覆盖：盘上已经是别的版本时，撤销不按旧预期动手", async () => {
		const 项目根 = tempDir();
		const created = await 建计划(项目根);
		await modifyTemporaryPlan({
			项目根,
			来源会话: 会话,
			计划ID: created.计划ID,
			请求ID: "req-vc-1",
			预期定义版本: 1,
			显示名: "第二版",
			已注册部门: 部门,
		});
		const err = await revertTemporaryPlan({
			项目根,
			来源会话: 会话,
			计划ID: created.计划ID,
			请求ID: "req-vc-2",
			预期定义版本: 1,
		}).catch((error: unknown) => error);
		expect(err).toBeInstanceOf(TemporaryPlanError);
		expect((err as TemporaryPlanError).code).toBe("PLAN_VERSION_CONFLICT");
		expect((err as TemporaryPlanError).message).toContain("版本漂移");
		// 冲突时不动盘上内容。
		expect(readTemporaryPlan(项目根, created.计划ID).显示名).toBe("第二版");
	});

	it("没有历史可恢复时说清是「还没被改过」而不是给一份假定义", async () => {
		const 项目根 = tempDir();
		const created = await 建计划(项目根);
		const err = await revertTemporaryPlan({
			项目根,
			来源会话: 会话,
			计划ID: created.计划ID,
			请求ID: "req-noh",
			预期定义版本: 1,
		}).catch((error: unknown) => error);
		expect(err).toBeInstanceOf(TemporaryPlanError);
		expect((err as TemporaryPlanError).code).toBe("PLAN_INVALID");
		expect((err as TemporaryPlanError).message).toContain("没有可恢复的历史版本");
	});

	it("撤回整份计划与撤销最近修改是两件事：撤销后计划照旧有效，撤回后定义冻结不改", async () => {
		const 项目根 = tempDir();
		const created = await 建计划(项目根);
		await modifyTemporaryPlan({
			项目根,
			来源会话: 会话,
			计划ID: created.计划ID,
			请求ID: "req-two-1",
			预期定义版本: 1,
			显示名: "改过",
			已注册部门: 部门,
		});
		await revertTemporaryPlan({
			项目根,
			来源会话: 会话,
			计划ID: created.计划ID,
			请求ID: "req-two-2",
			预期定义版本: 2,
		});
		// 撤销完还能继续改：说明它是「内容回到上一版」，不是「整份撤回」。
		await expect(
			modifyTemporaryPlan({
				项目根,
				来源会话: 会话,
				计划ID: created.计划ID,
				请求ID: "req-two-3",
				预期定义版本: 3,
				显示名: "撤销之后又改",
				已注册部门: 部门,
			}),
		).resolves.toMatchObject({ 定义版本: 4 });
		// 撤回整份才是另一条路：之后这份定义不能再改。
		await undoTemporaryPlan({ 项目根, 来源会话: 会话, 计划ID: created.计划ID, 请求ID: "req-two-4", 预期定义版本: 4 });
		await expect(
			modifyTemporaryPlan({
				项目根,
				来源会话: 会话,
				计划ID: created.计划ID,
				请求ID: "req-two-5",
				预期定义版本: 5,
				显示名: "撤回之后还想改",
				已注册部门: 部门,
			}),
		).rejects.toThrow("已撤销");
	});

	it("当前版写坏时能定位到上一有效版：只认通过校验的版本，不用空步骤填默认", async () => {
		const 项目根 = tempDir();
		const created = await 建计划(项目根);
		await modifyTemporaryPlan({
			项目根,
			来源会话: 会话,
			计划ID: created.计划ID,
			请求ID: "req-rec-1",
			预期定义版本: 1,
			显示名: "第二版",
			已注册部门: 部门,
		});
		// 模拟「写当前版时被中断」：当前版文件坏掉，历史里还留着完好的第 1 版。
		const 计划路径 = planFilePath(项目根, created.计划ID);
		writeFileSync(计划路径, "这不是合法定义：没有 frontmatter\n", "utf8");
		const 恢复 = resolveRecoverablePlan(项目根, created.计划ID);
		expect(恢复.来源).toBe("历史");
		expect(恢复.定义.定义版本).toBe(1);
		expect(恢复.定义.显示名).toBe("小说创作");
		expect(恢复.定义.步骤).toHaveLength(2);
		expect(恢复.问题.join("；")).toContain("缺");
		// 原件没有被改掉：恢复只是「读出可用的一版」，写盘由调用方显式做。
		expect(readFileSync(计划路径, "utf8")).toContain("这不是合法定义");
	});

	it("历史文件坏掉时点名那个版本，不用它恢复", async () => {
		const 项目根 = tempDir();
		const created = await 建计划(项目根);
		await modifyTemporaryPlan({
			项目根,
			来源会话: 会话,
			计划ID: created.计划ID,
			请求ID: "req-bad-1",
			预期定义版本: 1,
			显示名: "第二版",
			已注册部门: 部门,
		});
		writeFileSync(planHistoryPath(项目根, created.计划ID, 1), "坏掉的历史\n", "utf8");
		const 历史 = listPlanHistory(项目根, created.计划ID);
		expect(历史).toHaveLength(1);
		expect(历史[0]!.定义).toBeUndefined();
		expect(历史[0]!.问题).toBeTruthy();
		const err = await revertTemporaryPlan({
			项目根,
			来源会话: 会话,
			计划ID: created.计划ID,
			请求ID: "req-bad-2",
			预期定义版本: 2,
			目标定义版本: 1,
		}).catch((error: unknown) => error);
		expect(err).toBeInstanceOf(TemporaryPlanError);
		expect((err as TemporaryPlanError).code).toBe("PLAN_CORRUPT");
		expect((err as TemporaryPlanError).message).toContain("读不出");
	});
});

describe("查询区分列表与详情（批次 C 第 ③项：新审阅 8）", () => {
	it("列表默认简短：给摘要行，不把每步的完整字段全倒出来", async () => {
		const 项目根 = tempDir();
		await 建计划(项目根, {
			步骤: [步骤({ 要求: "这段要求很长很长很长很长很长很长很长很长", 约束: "约束不该出现在简短列表里" })],
		});
		const 列表 = queryTemporaryPlan(项目根);
		expect(列表.摘要).toContain("小说创作");
		expect(列表.摘要).not.toContain("约束不该出现在简短列表里");
	});

	it("详情面在工具层：见 workflow-plan-tools.test.ts 的「查询详情与按对象读取」", () => {
		// 详情/分页是工具面能力（`pao_plan_query` 的 around_step/step_detail），
		// 内核的 queryTemporaryPlan 只负责简短列表与坏定义点名，故此处只锁列表口径。
		expect(typeof queryTemporaryPlan).toBe("function");
	});
});

describe("模板参数化（批次 C 第 ④项：新审阅 7）", () => {
	it("用 params 把本次绝对路径换成占位符：模板声明参数，换项目填参就能再跑一份", async () => {
		const 项目根 = tempDir();
		const paoHome = tempDir();
		const 本次路径 = join(项目根, "素材", "设定.md");
		const created = await 建计划(项目根, {
			步骤: [步骤({ 要求: `按 ${本次路径} 里的设定写`, 预期成果: "创作成果/初稿.md" })],
		});
		const saved = savePlanAsTemplate({
			项目根,
			来源会话: 会话,
			计划ID: created.计划ID,
			定义版本: 1,
			模板名: "带参数模板",
			paoHome,
			参数: { 设定路径: 本次路径 },
		});
		expect(saved.未泛化路径).toEqual([]);
		const content = readFileSync(saved.路径, "utf8");
		expect(content).toContain("{设定路径}");
		expect(content).not.toContain(本次路径);
		// 同一套配方校验器认这份模板：占位符已在「参数」里声明。
		const recipe = parseRecipe(content, saved.路径);
		expect(recipe.参数).toEqual(["设定路径"]);
		expect(recipe.占位符).toEqual(["设定路径"]);
	});

	it("参数名点名了一段不存在的文本：拒存，不静默留一个用不上的空参数", async () => {
		const 项目根 = tempDir();
		const paoHome = tempDir();
		const created = await 建计划(项目根);
		const err = (() => {
			try {
				savePlanAsTemplate({
					项目根,
					来源会话: 会话,
					计划ID: created.计划ID,
					定义版本: 1,
					模板名: "空参数模板",
					paoHome,
					参数: { 不存在的参数: "D:\\别处\\没有这段.md" },
				});
			} catch (error: unknown) {
				return error;
			}
		})();
		expect(err).toBeInstanceOf(TemporaryPlanError);
		expect((err as TemporaryPlanError).code).toBe("PLAN_INVALID");
		expect((err as TemporaryPlanError).message).toContain("没找到要替换的文本");
		expect(existsSync(join(paoHome, "工作流", "空参数模板.md"))).toBe(false);
	});

	it("参数化之后再判未泛化路径：被参数化掉的路径不该再报成「本次特有」", async () => {
		const 项目根 = tempDir();
		const paoHome = tempDir();
		const 本次路径 = join(项目根, "素材", "设定.md");
		const created = await 建计划(项目根, {
			步骤: [步骤({ 要求: `参考 ${本次路径}` })],
		});
		// 不给 params：本次特有路径被拒（本来就该拒）。
		await expect(async () =>
			savePlanAsTemplate({
				项目根,
				来源会话: 会话,
				计划ID: created.计划ID,
				定义版本: 1,
				模板名: "未泛化",
				paoHome,
			}),
		).rejects.toThrow("本次特有路径");
		// 给了 params：同一条计划能存下来，且不再点名这条路径。
		const saved = savePlanAsTemplate({
			项目根,
			来源会话: 会话,
			计划ID: created.计划ID,
			定义版本: 1,
			模板名: "已泛化",
			paoHome,
			参数: { 设定路径: 本次路径 },
		});
		expect(saved.未泛化路径).toEqual([]);
	});

	it("模板保留本次特有路径必须显式确认，并在结果里点名", async () => {
		const 项目根 = tempDir();
		const paoHome = tempDir();
		const 本次路径 = join(项目根, "素材", "设定.md");
		const created = await 建计划(项目根, {
			步骤: [步骤({ 要求: `参考 ${本次路径}` })],
		});
		const saved = savePlanAsTemplate({
			项目根,
			来源会话: 会话,
			计划ID: created.计划ID,
			定义版本: 1,
			模板名: "原样保留",
			paoHome,
			允许未泛化路径: true,
		});
		expect(saved.未泛化路径).toEqual([本次路径]);
		// 路径原样留在节点正文里（YAML 会把反斜杠转义成 \\，所以按解析后的值断言）。
		const front = parseFrontmatter<{ 节点?: { 目标?: string }[] }>(readFileSync(saved.路径, "utf8")).frontmatter;
		expect(front.节点?.[0]?.目标).toContain(本次路径);
	});

	it("模板白名单：不带会话、卡号、实例状态与请求记录进模板（说明文字里的计划 ID 是溯源标注，不是状态）", async () => {
		const 项目根 = tempDir();
		const paoHome = tempDir();
		const created = await 建计划(项目根);
		const saved = savePlanAsTemplate({
			项目根,
			来源会话: 会话,
			计划ID: created.计划ID,
			定义版本: 1,
			模板名: "白名单模板",
			paoHome,
		});
		const content = readFileSync(saved.路径, "utf8");
		// 会话/请求记录都不进模板；frontmatter 里也不该有执行态字段（「实例」只出现在正文说明里）。
		expect(content).not.toContain(会话);
		expect(content).not.toContain("请求记录");
		const front = parseFrontmatter(readFileSync(saved.路径, "utf8")).frontmatter;
		expect(Object.keys(front).sort()).toEqual(["参数", "名字", "版本", "节点", "自动执行"].sort());
		const 正文 = JSON.stringify(front);
		expect(正文).not.toContain(created.计划ID);
		expect(正文).not.toContain("实例");
		expect(正文).not.toContain("卡");
		expect(正文).not.toContain("状态");
	});
});
