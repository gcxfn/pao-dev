/**
 * H0 覆盖钉：总预算门禁必须**三条派发路径都真的生效**（单卡 / 扇出 / 自动链）。
 *
 * 为什么要有这个文件：G4 只把门禁接进了 `worker/index.ts` 的 `dispatchInBackground`，
 * 而 `executeDispatch` 另有两个调用点（`fanout/execute.ts` 的补位车道、
 * `workflow/auto.ts` 的单卡派发）**从未注入门禁**——于是「并发不重复授额」
 * 在外派与自动链上是空的：用户给了总预算，扇出照样能把它花穿。
 *
 * | 路径 | 入口 | 走 executeDispatch | 本文件对应 describe |
 * |---|---|---|---|
 * | 单卡/受理链 | `pao_dispatch_card` → `dispatchInBackground` | 是 | 「单卡路径」 |
 * | 扇出 | `pao_fanout` → `executeFanout` → 补位车道 | 是 | 「扇出路径」 |
 * | 自动链 | `runAutoChain` → 单卡派发 | 是 | 「自动链路径」 |
 *
 * 三条路径断言的是同一组可观察事实（lead 硬要求）：
 * ① 未授权时账本文件压根不生成（零行为变化，不能凭空出现默认限额）；
 * ② 被拒时不假成功——卡状态、进程、预留、停因文案四处都查，
 *    且文案必须能看出「哪张卡、为什么、下一步」；
 * ③ 不出现「已硬限额/绝不超支」这类承诺（额度是尽力而为的软约束，不是硬上限）。
 *
 * 另有一条防回归：门禁在装配处必须排在 `...dispatchOptions` **之后**，
 * 否则调用方一个同名键就能把门禁静默关掉（今天类型上不可达，放宽类型即失效）。
 *
 * 一律 tmpdir + FakeRunner 替身，不碰真实 PAO_HOME，不起真实模型。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import {
	type CardCreateInput,
	createCard,
	loadCard,
	type ParsedCard,
	parseCardRef,
	readCard,
} from "../../src/pao/cards/index.ts";
import { executeFanout } from "../../src/pao/fanout/execute.ts";
import {
	BUDGET_LEDGER_FILENAME,
	budgetLedgerPath,
	grantBudget,
	inspectReservation,
} from "../../src/pao/usage/budget-ledger.ts";
import { buildDispatchBudgetGate } from "../../src/pao/usage/dispatch-gate.ts";
import { registerWorkerTools } from "../../src/pao/worker/index.ts";
import type { WorkerReceipt } from "../../src/pao/worker/receipt.ts";
import { WorkerRunner, type WorkerRunOptions } from "../../src/pao/worker/runner.ts";
import { runAutoChain } from "../../src/pao/workflow/auto.ts";
import {
	addNodeCards,
	bindMinister,
	endDecomposition,
	readControl,
	startControl,
} from "../../src/pao/workflow/control.ts";
import { loadRecipe, type WorkflowRecipe } from "../../src/pao/workflow/recipe.ts";

const dirs: string[] = [];
const runners: WorkerRunner[] = [];
const shutdowns: (() => unknown)[] = [];
afterEach(async () => {
	for (const shutdown of shutdowns.splice(0)) await shutdown();
	for (const runner of runners.splice(0)) await runner.stopAll();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix = "pao-h0-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

/** 一个隔离现场：项目根、卡目录（<根>/.pao/卡）、独立 PAO_HOME。 */
function workspace(): { root: string; cardsDir: string; home: string } {
	const root = temp();
	const cardsDir = join(root, ".pao", "卡");
	mkdirSync(cardsDir, { recursive: true });
	return { root, cardsDir, home: temp("pao-h0-home-") };
}

async function card(cardsDir: string, extra: Partial<CardCreateInput> = {}): Promise<ParsedCard> {
	mkdirSync(cardsDir, { recursive: true });
	return createCard(
		cardsDir,
		{ 目标: "离线任务", 部门: "测试", 验收: "完成", 创建: "2026-10-17 10:00", ...extra },
		{ counterPath: join(cardsDir, "..", "卡号.txt") },
	);
}

async function grant(home: string, total: number): Promise<void> {
	await grantBudget(budgetLedgerPath(home), {
		总预算: total,
		授权人: "测试用户",
		授权时间: "2026-10-17T10:00:00.000Z",
	});
}

/** 判据＝卡号补零 + 尝试号（与 usage/dispatch-gate 的 dispatchBudgetKey 同形）。 */
function keyOf(cardNo: number | string, attempt: number): string {
	return `派发:卡${String(cardNo).padStart(4, "0")}:尝试${attempt}`;
}

/** 离线假 worker：不出真进程，只回一份可控回执。 */
class FakeRunner extends WorkerRunner {
	runs: WorkerRunOptions[] = [];
	costs: (number | undefined)[] = [];
	override async run(options: WorkerRunOptions): Promise<WorkerReceipt> {
		this.runs.push(options);
		const index = this.runs.length - 1;
		this.registry.register({
			pid: 910000 + index,
			card_no: options.卡号,
			card_path: options.卡路径,
			attempt: options.尝试号 ?? 1,
			command: "fake-runner",
			dept: options.部门 ?? null,
			dispatch_reason: options.派单理由 ?? null,
		});
		this.registry.markExited(910000 + index);
		const cost = this.costs[index];
		return {
			card_no: options.卡号,
			card_path: options.卡路径,
			attempt: options.尝试号 ?? 1,
			status: "success",
			artifact_path: [],
			summary: "离线假回执",
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: cost ?? 0, turns: 1 },
			...(cost === undefined ? { missing_usage_rounds: 1 } : {}),
			工具调用次数: 0,
			evidence_path: "",
			exitCode: 0,
			command: "fake-runner",
			pid: 910000 + index,
			duration_ms: 1,
		};
	}
}

/** 单卡路径的会话级 harness（与 usage-gate-wiring.test.ts 同款口径）。 */
function harness(runner: WorkerRunner, cardsDir: string, paoHome: string) {
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const handlers = new Map<string, (event: unknown) => unknown>();
	const pi = {
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never),
		on: (event: string, handler: (event: unknown) => unknown) => {
			handlers.set(event, handler);
			return () => {};
		},
	} as unknown as ExtensionAPI;
	runners.push(runner);
	const face = registerWorkerTools(pi, {
		runner,
		signals: false,
		resolveCardsDir: () => cardsDir,
		resolvePaoHome: () => paoHome,
	});
	const shutdown = handlers.get("session_shutdown");
	const beforeStart = handlers.get("before_agent_start");
	if (!shutdown || !beforeStart) throw new Error("派卡生命周期钩子未注册");
	shutdowns.push(() => shutdown({}));
	const readInjection = (): string => {
		const sections: Record<string, string> = {};
		beforeStart({ systemPromptOptions: { sections } });
		return Object.values(sections).join("\n");
	};
	const dispatch = async (cardNo: number | string) =>
		(await tools.get("pao_dispatch_card")!.execute("t1", {
			card_ref: String(cardNo),
			reason: "H0 覆盖测试",
			cards_dir: cardsDir,
		})) as { content: { text?: string }[]; isError?: boolean };
	return { face, dispatch, readInjection };
}

/** 不许出现的承诺：额度是软约束，不是硬上限。 */
const FORBIDDEN_PROMISES = ["已硬限额", "绝不超支", "不会超支", "硬限额"];

function expectNoHardLimitPromise(text: string): void {
	for (const phrase of FORBIDDEN_PROMISES) {
		expect(text, `文案不得承诺「${phrase}」（额度是尽力而为的软约束，不能保证不超支）`).not.toContain(phrase);
	}
}

// ══════════════════════════════════════════════════════════════════════════
// 一、未授权总预算 → 三条路径都零行为变化，且盘上根本不生成账本
// ══════════════════════════════════════════════════════════════════════════
describe("未授权总预算时三条派发路径都零行为变化（不凭空设默认限额）", () => {
	it("单卡路径：派发照常成功，盘上根本不产生总预算账", async () => {
		const { cardsDir, home } = workspace();
		const created = await card(cardsDir, { 目标: "未授权单卡" });
		const runner = new FakeRunner();
		const h = harness(runner, cardsDir, home);

		await h.dispatch(created.card_no);
		await h.face.waitForBackground();

		expect(runner.runs).toHaveLength(1);
		expect(readCard(created.path).frontmatter.status).toBe("in_progress");
		expect(readdirSync(home).includes(BUDGET_LEDGER_FILENAME)).toBe(false);
		expect(h.readInjection()).not.toContain("总预算");
	});

	it("扇出路径：全部卡照常派出（每卡虽写了 $5 预算也没有默认限额拦它），盘上根本不产生总预算账", async () => {
		const { cardsDir, home } = workspace();
		const a = await card(cardsDir, { 目标: "未授权扇出A", 预算: { cost: 5 } });
		const b = await card(cardsDir, { 目标: "未授权扇出B", 预算: { cost: 5 } });
		const runner = new FakeRunner();
		runners.push(runner);

		const summary = await executeFanout(
			{ cardsDir, 卡号列表: [String(a.card_no), String(b.card_no)] },
			{ 运行器: runner, paoHome: home },
		);

		expect(summary.count.成功).toBe(2);
		expect(runner.runs).toHaveLength(2);
		expect(readdirSync(home).includes(BUDGET_LEDGER_FILENAME)).toBe(false);
	});

	it("自动链路径：照常派卡推进，盘上根本不产生总预算账", async () => {
		const { cardsDir, home } = workspace();
		const recipe = writeAutoRecipe(home, "未授权自动链");
		const runner = new FakeRunner();
		runners.push(runner);
		const root = join(cardsDir, "..", "..");
		attachSuccessScript(runner, root);
		const options = { cardsDir, paoHome: home, ownerSessionId: "owner", 运行器: runner };
		const refs = await prepareAutoChain(recipe, options, ["自动链甲"], { cost: 5 });

		const chain = await runAutoChain(recipe, options);

		// 卡真的被派过（链照常推进），且没有任何账本
		expect(refs).toHaveLength(1);
		expect(runner.runs.length).toBeGreaterThanOrEqual(1);
		expect(chain.steps.some((step) => step.stage === "派发")).toBe(true);
		expect(readdirSync(home).includes(BUDGET_LEDGER_FILENAME)).toBe(false);
	});
});

// ══════════════════════════════════════════════════════════════════════════
// 二、授权后：扇出与自动链都必须真的受总额约束（G4 缺口）
// ══════════════════════════════════════════════════════════════════════════
describe("扇出路径受总预算约束（H0 补上的缺口）", () => {
	it("超出总额的卡被拒：卡没被认领、没起进程、拒绝原因带卡号+为什么+下一步", async () => {
		const { cardsDir, home } = workspace();
		await grant(home, 3); // 只给 $3
		const 能过 = await card(cardsDir, { 目标: "扇出甲", 预算: { cost: 2 } });
		const 被拒 = await card(cardsDir, { 目标: "扇出乙", 预算: { cost: 5 } }); // 要 $5
		const runner = new FakeRunner();
		runners.push(runner);

		const summary = await executeFanout(
			{ cardsDir, 卡号列表: [String(能过.card_no), String(被拒.card_no)], 并发上限: 1 },
			{ 运行器: runner, paoHome: home },
		);

		// ① 只跑了一次
		expect(runner.runs).toHaveLength(1);
		// ② 被拒那张卡状态没动（门禁在认领之前拦下），能过那张已被认领
		expect(readCard(被拒.path).frontmatter.status).toBe("unclaimed");
		expect(readCard(能过.path).frontmatter.status).toBe("in_progress");
		// ③ 被拒那条没有预留（钱没占，下次还能派）
		expect(inspectReservation(home, keyOf(被拒.card_no, 1)).state).toBe("missing");
		// ④ 汇总里能看出是哪张卡、为什么、下一步
		const 被拒结果 = summary.结果.find((result) => result.卡号 === String(被拒.card_no).padStart(4, "0"));
		expect(被拒结果).toBeDefined();
		const 文案 = JSON.stringify(被拒结果);
		expect(文案).toContain("总预算");
		expect(文案).toContain("下一步");
		expectNoHardLimitPromise(文案);
	});

	it("授权充足时扇出成功会按真实用量结算（同一判据与单卡一致）", async () => {
		const { cardsDir, home } = workspace();
		await grant(home, 10);
		const created = await card(cardsDir, { 预算: { cost: 4 } });
		const runner = new FakeRunner();
		runner.costs = [1.25];
		runners.push(runner);

		const summary = await executeFanout(
			{ cardsDir, 卡号列表: [String(created.card_no)] },
			{ 运行器: runner, paoHome: home },
		);

		expect(summary.count.成功).toBe(1);
		const 记录 = inspectReservation(home, keyOf(created.card_no, 1));
		expect(记录.state).toBe("settled");
		if (记录.state !== "missing") {
			expect(记录.reservation.预留额).toBe(4);
			expect(记录.reservation.已结算费用).toBe(1.25);
		}
	});
});

describe("自动链路径受总预算约束（H0 补上的缺口）", () => {
	it("总额不足时停链：卡没被派、进程没起、stopReason 带卡号+原因+下一步", async () => {
		const { cardsDir, home } = workspace();
		await grant(home, 1); // 只给 $1，卡却要 $5
		const recipe = writeAutoRecipe(home, "预算不足链");
		const runner = new FakeRunner();
		runners.push(runner);
		const options = { cardsDir, paoHome: home, ownerSessionId: "owner", 运行器: runner };
		const refs = await prepareAutoChain(recipe, options, ["链甲"], { cost: 5 });

		const chain = await runAutoChain(recipe, options);
		// 自动链的卡引用形如 "卡0001"；loadCard 按数字卡号在卡目录里找（findCardFile 返回的是相对名）
		const 该卡 = loadCard(cardsDir, parseCardRef(refs[0]!));

		// ① 一行代码都没跑
		expect(runner.runs).toHaveLength(0);
		// ② 卡状态没动
		expect(该卡.frontmatter.status).toBe("unclaimed");
		// ③ 停因文案：哪张卡 + 为什么 + 下一步
		expect(chain.stopReason).toBeDefined();
		expect(chain.stopReason).toContain("派发被拒");
		expect(chain.stopReason).toContain("总预算");
		expect(chain.stopReason).toContain("下一步");
		expect(chain.stopReason).toContain(String(refs[0]));
		expectNoHardLimitPromise(chain.stopReason ?? "");
		// ④ 步骤里也留了可追溯的一条停审记录
		const 停审 = chain.steps.filter((step) => step.stage === "停审");
		expect(停审.length).toBeGreaterThanOrEqual(1);
		expect(JSON.stringify(停审)).toContain("总预算");
		// ⑤ 被拒那条不留预留
		expect(inspectReservation(home, keyOf(该卡.card_no, 1)).state).toBe("missing");
	});

	it("授权充足时自动链照常派发（门禁不误伤正常流程）", async () => {
		const { cardsDir, home } = workspace();
		await grant(home, 100);
		const recipe = writeAutoRecipe(home, "预算充足链");
		const runner = new FakeRunner();
		runner.costs = [2];
		runners.push(runner);
		attachSuccessScript(runner, join(cardsDir, "..", ".."));
		const options = { cardsDir, paoHome: home, ownerSessionId: "owner", 运行器: runner };
		await prepareAutoChain(recipe, options, ["链乙"], { cost: 2 });

		await runAutoChain(recipe, options);

		expect(runner.runs).toHaveLength(1);
		const 记录 = inspectReservation(home, keyOf(runner.runs[0]!.卡号, runner.runs[0]!.尝试号 ?? 1));
		expect(记录.state).toBe("settled");
		if (记录.state !== "missing") expect(记录.reservation.已结算费用).toBe(2);
	});
});

// ══════════════════════════════════════════════════════════════════════════
// 三、防回归：门禁在装配处不可被 dispatchOptions 覆盖
// ══════════════════════════════════════════════════════════════════════════
describe("装配顺序防回归：调用方同名键不得关掉门禁", () => {
	it("总额不足时单卡派发确实被拦（门禁真生效），且源码里 `...dispatchOptions` 排在门禁之前", async () => {
		const { cardsDir, home } = workspace();
		await grant(home, 1);
		const created = await card(cardsDir, { 预算: { cost: 5 } });
		const runner = new FakeRunner();
		const h = harness(runner, cardsDir, home);

		await h.dispatch(created.card_no);
		await h.face.waitForBackground();

		// 门禁生效＝$5 的卡在 $1 总额下被拒：一行没跑、卡没动
		expect(runner.runs).toHaveLength(0);
		expect(readCard(created.path).frontmatter.status).toBe("unclaimed");
		expect(h.readInjection()).toContain("总预算");

		// 源码顺序钉：`...dispatchOptions` 必须先于 `预算门禁`。
		// 今天 dispatchOptions 的类型装不下 预算门禁（结构上不可达），但只要有人把类型放宽成
		// Partial<ExecuteDispatchOptions>，顺序写反就会让调用方一个同名字段静默关掉总预算门禁——
		// 那种失效不报错、只悄悄不限额，所以这里用字符位置把它钉死。
		const 源码 = readFileSync(join(import.meta.dirname, "..", "..", "src", "pao", "worker", "index.ts"), "utf8");
		const 展开位置 = 源码.indexOf("...dispatchOptions,");
		const 门禁位置 = 源码.indexOf("预算门禁: buildDispatchBudgetGate(");
		expect(展开位置).toBeGreaterThan(-1);
		expect(门禁位置).toBeGreaterThan(-1);
		expect(
			展开位置,
			"`...dispatchOptions` 必须排在 `预算门禁` 之前，否则调用方一个同名字段就能静默关掉总预算门禁",
		).toBeLessThan(门禁位置);
	});
});

// ══════════════════════════════════════════════════════════════════════════
// 四、门禁工厂自身：未授权＝不注入（= dispatch-core 整段跳过）
// ══════════════════════════════════════════════════════════════════════════
describe("buildDispatchBudgetGate：未授权就不注入（零行为变化的实现方式）", () => {
	it("paoHome 缺失 → 返回 undefined（不是「默认限额」）", () => {
		expect(buildDispatchBudgetGate({ paoHome: undefined })).toBeUndefined();
	});

	it("有 home 但账本里没有授权记录 → 返回 undefined", () => {
		const home = temp("pao-h0-empty-");
		expect(buildDispatchBudgetGate({ paoHome: home })).toBeUndefined();
	});

	it("授权后 → 返回门禁；拒绝时文案带「下一步」，且不承诺绝不超支", async () => {
		const home = temp("pao-h0-granted-");
		await grant(home, 1);
		const gate = buildDispatchBudgetGate({ paoHome: home });
		expect(gate).toBeDefined();
		const verdict = await gate!({ card_no: "0001", frontmatter: { budget: { cost: 5 }, goal: "太贵" } }, 1);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.reason).toContain("总预算");
			expect(verdict.reason).toContain("下一步");
			expectNoHardLimitPromise(verdict.reason);
		}
	});
});

// ══════════════════════════════════════════════════════════════════════════
// 自动链 fixture（v2：自动链只对 版本:2 配方生效，v1 走手动 tick）
// ══════════════════════════════════════════════════════════════════════════
function writeAutoRecipe(paoHome: string, name: string): WorkflowRecipe {
	const dir = join(paoHome, "工作流");
	mkdirSync(dir, { recursive: true });
	const body = [
		"---",
		`名字: ${name}`,
		"版本: 2",
		"自动执行: true",
		"参数: []",
		"节点:",
		"  - 名字: 甲",
		"    目标: 甲任务",
		"    部门: 测试",
		'    验收: "完成"',
		"---",
		"说明: H0 覆盖测试配方",
	].join("\n");
	writeFileSync(join(dir, `${name}.md`), body, "utf8");
	return loadRecipe(paoHome, name);
}

/**
 * 把自动链推到「可派发」状态：启流 → 绑部长 → 加卡 → 结束拆解。
 * 自动链只对 版本:2 配方生效（v1 走手动 tick），所以 fixture 配方带 版本: 2；
 * v2 无需人工确认——节点判定由链内自动推进。返回本批卡的引用（如 "卡0001"）。
 */
async function prepareAutoChain(
	recipe: WorkflowRecipe,
	options: { cardsDir: string; paoHome: string; ownerSessionId: string },
	goals: string[],
	budget?: { cost: number },
): Promise<string[]> {
	await startControl(recipe, {}, options);
	await bindMinister(recipe, options, "甲", "minister-h0");
	const flow = readControl(recipe, options);
	const identity = { 实例: flow.实例, 节点: "甲", 轮次: 1, 部长会话: "minister-h0" };
	const added = await addNodeCards(
		recipe,
		options,
		identity,
		goals.map((goal) => ({ goal, acceptance: "完成", ...(budget ? { budget } : {}) })),
	);
	await endDecomposition(recipe, options, identity);
	return added;
}

/**
 * 让假 worker 会「交卷」：写产物文件 + 回成功回执（声明该产物）。
 * 自动链要走到验收/交卷，回执里的 artifact_path 必须与盘上真实改动对得上（越界核查）。
 */
function attachSuccessScript(runner: FakeRunner, root: string): void {
	const 原run = runner.run.bind(runner);
	runner.run = async (options: WorkerRunOptions): Promise<WorkerReceipt> => {
		const receipt = await 原run(options);
		if (receipt.status !== "success") return receipt;
		// 相对仓库根写一个产物（越界核查按项目根比对），并把它声明进回执
		const 相对路径 = `产物-${String(options.卡号).padStart(4, "0")}.txt`;
		try {
			writeFileSync(join(root, 相对路径), "产物\n");
		} catch {
			// 写不进去就让回执照原样返回（该用例只关心门禁是否放行，不判验收结果）
			return receipt;
		}
		return { ...receipt, artifact_path: [相对路径] };
	};
}
