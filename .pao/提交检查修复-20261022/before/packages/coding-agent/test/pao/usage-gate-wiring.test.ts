/**
 * G4 总预算门禁接入真实派发链的行为钉（计划 §8.2 / 出批条件「并发不重复授额」）。
 *
 * 这条闭环要证明的是「规则真的生效了」，不是「门禁自己算得对」（后者在 usage-budget.test.ts）。
 * 所以全部从**真实派发入口**进去：registerWorkerTools → pao_dispatch_card → executeDispatch，
 * 断言的是派发链外面的可观察事实（卡状态、在途表、通知面、返回文案、盘上账本）。
 *
 * 五组：
 * 1. 未授权总预算 = 零行为变化（接线前的行为逐字不变，且盘上不会凭空多出账本）。
 * 2. 授权后放行 = 先预留再开跑，完成后按真实用量结算。
 * 3. 真并发争同一份总额：两个请求只能过一个（不是顺序化后假装）。
 * 4. 拒绝不假成功：卡状态没变、在途表没留、通知面说的是"被拒"而不是"完成"。
 * 5. 认领失败/提交失败时预留归还（没开跑的钱必须还回去）。
 *
 * 一律 tmpdir + FakeRunner 替身，不碰真实 PAO_HOME，不起真实模型。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import {
	type CardCreateInput,
	changeCardStatus,
	createCard,
	type ParsedCard,
	readCard,
} from "../../src/pao/cards/index.ts";
import {
	BUDGET_LEDGER_FILENAME,
	budgetLedgerPath,
	grantBudget,
	inspectReservation,
} from "../../src/pao/usage/budget-ledger.ts";
import { readBudgetStatus } from "../../src/pao/usage/dispatch-gate.ts";
import { DISPATCH_NOTIFY_SECTION, registerWorkerTools } from "../../src/pao/worker/index.ts";
import type { WorkerReceipt } from "../../src/pao/worker/receipt.ts";
import type { ProcessEntry } from "../../src/pao/worker/registry.ts";
import { WorkerRunner, type WorkerRunOptions } from "../../src/pao/worker/runner.ts";

const dirs: string[] = [];
const runners: WorkerRunner[] = [];
const shutdowns: (() => unknown)[] = [];
afterEach(async () => {
	for (const shutdown of shutdowns.splice(0)) await shutdown();
	for (const runner of runners.splice(0)) await runner.stopAll();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-g4-gate-"));
	dirs.push(dir);
	return dir;
}
async function card(cardsDir: string, extra: Partial<CardCreateInput> = {}): Promise<ParsedCard> {
	mkdirSync(cardsDir, { recursive: true });
	return createCard(
		cardsDir,
		{ 目标: "离线任务", 部门: "测试", 验收: "完成", 创建: "2026-10-03 10:00", ...extra },
		{ counterPath: join(cardsDir, "..", "卡号.txt") },
	);
}

/** 离线假 worker:不出真进程,只回一份可控回执。 */
class FakeRunner extends WorkerRunner {
	runs: WorkerRunOptions[] = [];
	/** 回执里的费用（undefined＝回执不带 usage）。 */
	costs: (number | undefined)[] = [];
	/** 每次 run 前等一下（制造真重叠）。 */
	delayMs = 0;
	/** run 抛错（模拟拉起失败）。 */
	throwOnRun: Error | undefined;
	/** 指定回执里的缺账轮数（undefined 或 0 表示不缺账）。 */
	missingUsageRounds: number | undefined;
	/** 固定回执状态（缺省 success）。 */
	receiptStatus: WorkerReceipt["status"] = "success";
	/** 完全省略 usage 字段，模拟旧链/异常回执。 */
	omitUsage = false;
	override async run(options: WorkerRunOptions): Promise<WorkerReceipt> {
		this.runs.push(options);
		const index = this.runs.length - 1;
		if (this.delayMs > 0) await new Promise((done) => setTimeout(done, this.delayMs));
		if (this.throwOnRun) throw this.throwOnRun;
		const cost = this.costs[index];
		this.registry.register({
			pid: 900000 + index,
			card_no: options.卡号,
			card_path: options.卡路径,
			attempt: options.尝试号 ?? 1,
			command: "fake-runner",
			dept: options.部门 ?? null,
			dispatch_reason: options.派单理由 ?? null,
		});
		// 不带 runId 清除该 pid 的全部条目（run_id 由 registry 自己生成,这里不猜它的值）。
		this.registry.markExited(900000 + index);
		const receipt: WorkerReceipt = {
			card_no: options.卡号,
			card_path: options.卡路径,
			attempt: options.尝试号 ?? 1,
			status: this.receiptStatus,
			artifact_path: [],
			summary: "离线假回执",
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: cost ?? 0, turns: 1 },
			...(this.missingUsageRounds !== undefined
				? { missing_usage_rounds: this.missingUsageRounds }
				: cost === undefined
					? { missing_usage_rounds: 1 }
					: {}),
			工具调用次数: 0,
			evidence_path: "",
			exitCode: 0,
			command: "fake-runner",
			pid: 900000 + index,
			duration_ms: 1,
		};
		if (this.omitUsage) {
			// WorkerReceipt 的生产契约要求 usage，但故障链可能交来缺字段的旧形回执；
			// 结算边界仍须按未知处理，不能让取值异常跳过账本口径。
			delete (receipt as Partial<WorkerReceipt>).usage;
			delete receipt.missing_usage_rounds;
		}
		return receipt;
	}
}

type ToolReply = { isError?: boolean; content: { text?: string }[]; details: unknown };
type Tool = { execute: (...args: unknown[]) => Promise<ToolReply> };

/** 会话级 harness:捕工具＋事件,读注入() 模拟一轮 before_agent_start（消费式）。 */
function harness(runner: WorkerRunner, cardsDir: string, paoHome?: string) {
	const tools = new Map<string, Tool>();
	const handlers = new Map<string, (event: unknown) => unknown>();
	const pi = {
		registerTool: (tool: { name: string } & Tool) => tools.set(tool.name, tool),
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
		...(paoHome ? { resolvePaoHome: () => paoHome } : {}),
	});
	const shutdown = handlers.get("session_shutdown");
	const beforeStart = handlers.get("before_agent_start");
	if (!shutdown || !beforeStart) throw new Error("派卡生命周期钩子未注册");
	shutdowns.push(() => shutdown({}));
	const readInjection = (): string => {
		const sections: Record<string, string> = {};
		beforeStart({ systemPromptOptions: { sections } });
		return sections[DISPATCH_NOTIFY_SECTION] ?? "";
	};
	return { tool: (name: string) => tools.get(name) as Tool, face, readInjection };
}

/** 一个项目根（卡目录 = <根>/.pao/卡），外加一个隔离 PAO_HOME。 */
function workspace(): { root: string; cardsDir: string; home: string } {
	const root = temp();
	const cardsDir = join(root, ".pao", "卡");
	mkdirSync(cardsDir, { recursive: true });
	const home = temp();
	return { root, cardsDir, home };
}

async function grant(home: string, total: number): Promise<void> {
	await grantBudget(budgetLedgerPath(home), {
		总预算: total,
		授权人: "测试用户",
		授权时间: "2026-10-03T10:00:00.000Z",
	});
}

function dispatch(tool: Tool, cardsDir: string, cardNo: number | string, reason = "测试派单") {
	return tool.execute("t1", {
		card_ref: String(cardNo),
		reason,
		cards_dir: cardsDir,
	});
}

// ── 1. 未授权总预算 = 零行为变化 ──────────────────────────────────────────
describe("未授权总预算时零行为变化（不凭空设默认限额）", () => {
	it("没授权记录 → 派发照常成功，且盘上根本不产生总预算账", async () => {
		const { cardsDir, home } = workspace();
		const created = await card(cardsDir, { 目标: "未授权也要能派" });
		const runner = new FakeRunner();
		const h = harness(runner, cardsDir, home);

		const reply = await dispatch(h.tool("pao_dispatch_card"), cardsDir, created.card_no);
		// pao_dispatch_card 是非阻塞的（B 档）:受理即返回「已派出」,真实结果另经通知面送达。
		expect(reply.content[0]?.text ?? "").toContain("已派出");
		await h.face.waitForBackground();

		// 真的跑过了（不是空转），并且完成通知到位
		expect(runner.runs).toHaveLength(1);
		const 通知 = h.readInjection();
		expect(通知).toContain("派卡完成");
		expect(通知).toContain("success");
		// 卡按原逻辑落成进行中（派发成功＝认领发生了）
		expect(readCard(created.path).frontmatter.status).toBe("in_progress");
		// 关键：没有授权就绝不写账本，也不出现任何"额度"字样
		expect(readdirSync(home).includes(BUDGET_LEDGER_FILENAME)).toBe(false);
		expect(通知).not.toContain("总预算");
	});

	it("授权后行为立刻不同（对照上面：同一场景注入门禁，账上留下预留并结算）", async () => {
		const { cardsDir, home } = workspace();
		await grant(home, 10);
		const created = await card(cardsDir, { 目标: "授权后派发", 预算: { cost: 2 } });
		const runner = new FakeRunner();
		runner.costs = [1.5];
		const h = harness(runner, cardsDir, home);

		await dispatch(h.tool("pao_dispatch_card"), cardsDir, created.card_no);
		await h.face.waitForBackground();

		const 判据 = `派发:卡${String(created.card_no).padStart(4, "0")}:尝试1`;
		const 记录 = inspectReservation(home, 判据);
		expect(记录.state).toBe("settled");
		if (记录.state !== "missing") expect(记录.reservation.已结算费用).toBe(1.5);
		// 账本确实落盘了（对照上一条用例的"根本没有账本"）
		expect(readdirSync(home).includes(BUDGET_LEDGER_FILENAME)).toBe(true);
	});
});

// ── 2. 放行：先预留再开跑，完成按真实用量结算 ────────────────────────────
describe("门禁放行：先预留、后开跑、完成按真实用量结算", () => {
	it("一次成功派发：预留额＝每卡预算，结算额＝回执真实费用", async () => {
		const { cardsDir, home } = workspace();
		await grant(home, 10);
		const created = await card(cardsDir, { 预算: { cost: 3 } });
		const runner = new FakeRunner();
		runner.costs = [2.25];
		const h = harness(runner, cardsDir, home);

		await dispatch(h.tool("pao_dispatch_card"), cardsDir, created.card_no);
		await h.face.waitForBackground();

		const 判据 = `派发:卡${String(created.card_no).padStart(4, "0")}:尝试1`;
		const 记录 = inspectReservation(home, 判据);
		expect(记录.state).toBe("settled");
		if (记录.state === "missing") return;
		expect(记录.reservation.预留额).toBe(3); // 每卡预算上限
		expect(记录.reservation.已结算费用).toBe(2.25); // 真实花费
	});

	it("单卡重试只预留上次消耗后的剩余额度", async () => {
		const { cardsDir, home } = workspace();
		await grant(home, 10);
		const created = await card(cardsDir, { 预算: { cost: 10 } });
		const firstRunner = new FakeRunner();
		firstRunner.costs = [6];
		const first = harness(firstRunner, cardsDir, home);

		const firstReply = await dispatch(first.tool("pao_dispatch_card"), cardsDir, created.card_no);
		await first.face.waitForBackground();
		expect(firstReply.content[0]?.text ?? "").toContain("已派出");
		expect(readCard(created.path).frontmatter.status).toBe("in_progress");

		// 用状态机落失败：单卡认领已推进到尝试 1，重试必须再推进到尝试 2。
		changeCardStatus(readCard(created.path), {
			操作者: "主控",
			to: "failed",
			失败类型: "transient",
			依据: "隔离用例模拟首轮失败，验证重试预算",
			时间: "2026-10-03 10:01",
		});
		const secondRunner = new FakeRunner();
		secondRunner.costs = [4];
		const second = harness(secondRunner, cardsDir, home);
		await dispatch(second.tool("pao_dispatch_card"), cardsDir, created.card_no);
		await second.face.waitForBackground();

		expect(secondRunner.runs).toHaveLength(1);
		const 判据 = `派发:卡${String(created.card_no).padStart(4, "0")}:尝试2`;
		const 记录 = inspectReservation(home, 判据);
		expect(记录.state).toBe("settled");
		if (记录.state !== "missing") {
			expect(记录.reservation.预留额).toBe(4);
			expect(记录.reservation.已结算费用).toBe(4);
		}
		const ledger = JSON.parse(readFileSync(budgetLedgerPath(home), "utf8")) as {
			reservations: { idempotencyKey: string; 已结算费用?: number }[];
		};
		expect(ledger.reservations.find((row) => row.idempotencyKey.endsWith(":尝试1"))?.已结算费用).toBe(6);
		expect(readBudgetStatus(home).已占).toBe(10);
	});

	it("回执缺 usage → 记「结果不明」，钱继续占着，且回执文本如实说明（不填 0 冒充没花钱）", async () => {
		const { cardsDir, home } = workspace();
		await grant(home, 10);
		const created = await card(cardsDir, { 预算: { cost: 4 } });
		const runner = new FakeRunner();
		runner.costs = [undefined]; // 回执带 missing_usage_rounds
		const h = harness(runner, cardsDir, home);

		const reply = await dispatch(h.tool("pao_dispatch_card"), cardsDir, created.card_no);
		await h.face.waitForBackground();
		const text = reply.content[0]?.text ?? "";

		const 判据 = `派发:卡${String(created.card_no).padStart(4, "0")}:尝试1`;
		const 记录 = inspectReservation(home, 判据);
		expect(记录.state).toBe("unknown");
		if (记录.state !== "missing") {
			expect(记录.reservation.已结算费用).toBeUndefined(); // 不是 0
			expect(记录.reservation.预留额).toBe(4); // 仍占着
		}
		const 通知 = h.readInjection();
		expect(通知).toContain("费用未知");
		expect(通知).toContain("继续占着");
		expect(通知).not.toContain("$0.00（"); // 不把未知渲染成 0
		// 派发本身仍成功（回执是真事实）:同步回执说"已派出",完成通知说 success
		expect(text).toContain("已派出");
		expect(通知).toContain("success");
	});

	it("回执只缺部分 usage → 整笔费用记「结果不明」，不能拿部分金额当全额结算", async () => {
		const { cardsDir, home } = workspace();
		await grant(home, 10);
		const created = await card(cardsDir, { 预算: { cost: 4 } });
		const runner = new FakeRunner();
		runner.costs = [1.25];
		runner.missingUsageRounds = 1;
		const h = harness(runner, cardsDir, home);

		await dispatch(h.tool("pao_dispatch_card"), cardsDir, created.card_no);
		await h.face.waitForBackground();

		const 判据 = `派发:卡${String(created.card_no).padStart(4, "0")}:尝试1`;
		const 记录 = inspectReservation(home, 判据);
		expect(记录.state).toBe("unknown");
		if (记录.state !== "missing") {
			expect(记录.reservation.已结算费用).toBeUndefined();
			expect(记录.reservation.预留额).toBe(4);
		}
		const 通知 = h.readInjection();
		expect(通知).toContain("有 1 轮没回 usage");
		expect(通知).toContain("继续占着");
	});

	it("回执完全缺 usage 字段 → 仍记「结果不明」，不因结算代码取值而抛错", async () => {
		const { cardsDir, home } = workspace();
		await grant(home, 10);
		const created = await card(cardsDir, { 预算: { cost: 4 } });
		const runner = new FakeRunner();
		runner.omitUsage = true;
		const h = harness(runner, cardsDir, home);

		await dispatch(h.tool("pao_dispatch_card"), cardsDir, created.card_no);
		await h.face.waitForBackground();

		const 判据 = `派发:卡${String(created.card_no).padStart(4, "0")}:尝试1`;
		const 记录 = inspectReservation(home, 判据);
		expect(记录.state).toBe("unknown");
		if (记录.state !== "missing") {
			expect(记录.reservation.已结算费用).toBeUndefined();
			expect(记录.reservation.预留额).toBe(4);
		}
		const 通知 = h.readInjection();
		expect(通知).toContain("总预算记「结果不明」");
		expect(通知).toContain("回执未带 usage");
	});

	it("取消回执带实际费用 → 按实际费用结算，取消不抹费用", async () => {
		const { cardsDir, home } = workspace();
		await grant(home, 10);
		const created = await card(cardsDir, { 预算: { cost: 4 } });
		const runner = new FakeRunner();
		runner.receiptStatus = "canceled";
		runner.costs = [1.75];
		const h = harness(runner, cardsDir, home);

		await dispatch(h.tool("pao_dispatch_card"), cardsDir, created.card_no);
		await h.face.waitForBackground();

		const 判据 = `派发:卡${String(created.card_no).padStart(4, "0")}:尝试1`;
		const 记录 = inspectReservation(home, 判据);
		expect(记录.state).toBe("settled");
		if (记录.state !== "missing") {
			expect(记录.reservation.预留额).toBe(4);
			expect(记录.reservation.已结算费用).toBe(1.75);
		}
		const 通知 = h.readInjection();
		expect(通知).toContain("canceled");
		expect(通知).not.toContain("不能归还");
	});
});

// ── 3. 真并发争同一份总额：只能过一个 ────────────────────────────────────
describe("真并发争同一份总额（出批条件）", () => {
	it("两张卡各要 6、总额 10 → 只过一个，另一个拿到真实拒绝原因且卡未被派发", async () => {
		const { cardsDir, home } = workspace();
		await grant(home, 10);
		const a = await card(cardsDir, { 目标: "并发A", 预算: { cost: 6 } });
		const b = await card(cardsDir, { 目标: "并发B", 预算: { cost: 6 } });
		const runner = new FakeRunner();
		runner.delayMs = 40; // 让两次派发的门禁与认领真重叠
		const h = harness(runner, cardsDir, home);

		// 真并发：两个请求同时发出，不是顺序化后假装
		const [ra, rb] = await Promise.all([
			dispatch(h.tool("pao_dispatch_card"), cardsDir, a.card_no, "并发A"),
			dispatch(h.tool("pao_dispatch_card"), cardsDir, b.card_no, "并发B"),
		]);
		await h.face.waitForBackground();
		// 同步回执两条都是「已派出」（非阻塞工具如实说"何时返回",不代表派发成功与否）
		expect([ra.content[0]?.text ?? "", rb.content[0]?.text ?? ""].every((t) => t.includes("已派出"))).toBe(true);

		// 真实结果只在通知面:一条完成、一条被拒
		const 通知 = h.readInjection();
		expect(通知).toContain("派卡完成");
		expect(通知).toContain("派卡被拒");
		// 拒绝原因必须是真实原因，带下一步
		expect(通知).toContain("总预算不足");
		expect(通知).toContain("下一步");

		// 只有一张卡真被派发（认领发生了），另一张状态没动
		const 状态 = [readCard(a.path).frontmatter.status, readCard(b.path).frontmatter.status];
		expect(状态.filter((s) => s === "in_progress")).toHaveLength(1);
		expect(状态.filter((s) => s === "unclaimed")).toHaveLength(1);
		expect(runner.runs).toHaveLength(1);

		// 被拒那条不留预留（钱没占，下次还能派）
		const 被拒卡 = 状态[0] === "unclaimed" ? a : b;
		const 被拒判据 = `派发:卡${String(被拒卡.card_no).padStart(4, "0")}:尝试1`;
		expect(inspectReservation(home, 被拒判据).state).toBe("missing");
	});
});

// ── 4. 拒绝不假成功：卡状态/在途表/通知面三者都没被写成已派发 ──────────────
describe("门禁拒绝不留已派发的任何痕迹", () => {
	it("总额不足被拒 → 卡仍 unclaimed、在途表归零、通知面只出现「被拒」不出现「完成」", async () => {
		const { cardsDir, home } = workspace();
		await grant(home, 1); // 只给 $1
		const created = await card(cardsDir, { 预算: { cost: 5 } }); // 要 $5
		const runner = new FakeRunner();
		const h = harness(runner, cardsDir, home);

		const before = readCard(created.path);
		const reply = await dispatch(h.tool("pao_dispatch_card"), cardsDir, created.card_no);
		await h.face.waitForBackground();

		// ① 卡状态：一个字段都没动（门禁在认领之前拦下，所以连 owner/尝试都不该变）
		const after = readCard(created.path);
		expect(after.frontmatter.status).toBe("unclaimed");
		expect(after.frontmatter.attempt).toBe(before.frontmatter.attempt);
		expect(after.receipts).toHaveLength(before.receipts.length);

		// ② 在途表：归零（没有挂着一条"在跑"的假象）
		expect(h.face.backgroundCount().inFlight).toBe(0);

		// ③ 通知面：说的是被拒，不是完成
		const 通知 = h.readInjection();
		expect(通知).toContain("派卡被拒");
		expect(通知).toContain("总预算不足");
		expect(通知).not.toContain("派卡完成");

		// ④ 同步回执如实说"已受理/后台会通知",绝不提前宣称成功;真实原因在通知面
		const text = reply.content[0]?.text ?? "";
		expect(text).toContain("已派出");
		expect(text).not.toContain("派单完成");

		// ⑤ 一行代码都没跑
		expect(runner.runs).toHaveLength(0);
	});

	it("上次结果不明的同判据请求 → 拒派并叫人先查，不重复授额", async () => {
		const { cardsDir, home } = workspace();
		await grant(home, 10);
		const created = await card(cardsDir, { 预算: { cost: 2 } });
		const runner = new FakeRunner();
		// 第一次：回执缺 usage → 账上留 unknown
		runner.costs = [undefined];
		const h1 = harness(runner, cardsDir, home);
		await dispatch(h1.tool("pao_dispatch_card"), cardsDir, created.card_no);
		await h1.face.waitForBackground();

		const 判据 = `派发:卡${String(created.card_no).padStart(4, "0")}:尝试1`;
		expect(inspectReservation(home, 判据).state).toBe("unknown");

		// 第二次同判据（同卡同尝试）：卡已是 in_progress，先被状态拦住也没关系——
		// 这里直接验门禁的语义：它必须先说"结果不明"，而不是笼统说"额度不足"。
		const { checkDispatchBudget } = await import("../../src/pao/usage/dispatch-gate.ts");
		const verdict = await checkDispatchBudget({
			paoHome: home,
			idempotencyKey: 判据,
			金额: 2,
			指纹: "任意",
			现在: new Date().toISOString(),
		});
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.kind).toBe("结果不明");
			expect(verdict.reason).toContain("先查清结果");
		}
	});
});

// ── 5. 没开跑的钱必须还回去 ──────────────────────────────────────────────
describe("没开跑时预留归还（不给没派出去的请求占额度）", () => {
	it("门禁放行但认领因依赖未放行而失败 → 预留归还为 released，额度回到可用", async () => {
		const { cardsDir, home } = workspace();
		await grant(home, 5);
		// 前序卡保持 unclaimed（依赖未放行）。这条走的是 claimCardForDispatch 内部依赖闸,
		// 同步面（claimRefusalDetail 只看终态/进行中）拦不到,所以门禁一定会先放行、再认领失败——
		// 正是"没开跑的钱必须还回去"要覆盖的路径。
		const 前序 = await card(cardsDir, { 目标: "前序未完成" });
		const created = await card(cardsDir, { 预算: { cost: 5 }, depends_on: [String(前序.card_no)] });

		const runner = new FakeRunner();
		const h = harness(runner, cardsDir, home);
		await dispatch(h.tool("pao_dispatch_card"), cardsDir, created.card_no);
		await h.face.waitForBackground();

		// 门禁放行（预留写了）→ 认领被依赖挡住 → finally 归还
		const 判据 = `派发:卡${String(created.card_no).padStart(4, "0")}:尝试1`;
		const 记录 = inspectReservation(home, 判据);
		expect(记录.state).toBe("released");
		if (记录.state !== "missing") expect(记录.reservation.备注).toContain("归还");

		// 没跑起来,卡状态没动
		expect(runner.runs).toHaveLength(0);
		expect(readCard(created.path).frontmatter.status).toBe("unclaimed");
		const 通知 = h.readInjection();
		expect(通知).toContain("派卡被拒");
		expect(通知).toContain("依赖未放行");
	});

	it("runner 拉起就抛错（无回执）→ 账上如实记「结果不明」，钱继续占着、不归还", async () => {
		const { cardsDir, home } = workspace();
		await grant(home, 5);
		const created = await card(cardsDir, { 预算: { cost: 2 } });
		const runner = new FakeRunner();
		// 认领成功、commit 已过、run() 抛错：线程可能起过也可能没起，但**没有回执**，
		// 真实费用不可知 → 按 G2 记 unknown（钱继续占着），绝不能记成"没花钱"或停在 reserved。
		runner.throwOnRun = new Error("拉起失败");
		const h = harness(runner, cardsDir, home);
		await dispatch(h.tool("pao_dispatch_card"), cardsDir, created.card_no);
		await h.face.waitForBackground();

		const 判据 = `派发:卡${String(created.card_no).padStart(4, "0")}:尝试1`;
		const 记录 = inspectReservation(home, 判据);
		expect(记录.state).toBe("unknown");
		if (记录.state !== "missing") {
			expect(记录.reservation.已结算费用).toBeUndefined(); // 不知道花了多少,就不填 0
			expect(记录.reservation.预留额).toBe(2); // 钱继续占着
		}
		// 通知面必须把这件事说出来,而不是只报"派卡失败"
		const 通知 = h.readInjection();
		expect(通知).toContain("派卡失败");
		expect(通知).toContain("结果不明");
	});
});

// ── 6. 重启可核：新进程只读盘就能判出状态 ────────────────────────────────
describe("重启可核（不新造状态,全部复用 G2 持久账）", () => {
	it("派发完成后重建对象（模拟重启）仍能按判据判出 settled 与真实费用", async () => {
		const { cardsDir, home } = workspace();
		await grant(home, 10);
		const created = await card(cardsDir, { 预算: { cost: 3 } });
		const runner = new FakeRunner();
		runner.costs = [1.75];
		const h = harness(runner, cardsDir, home);
		await dispatch(h.tool("pao_dispatch_card"), cardsDir, created.card_no);
		await h.face.waitForBackground();
		await h.face.waitForBackground();

		// 模拟重启：清掉所有内存态，只从盘上重新读
		const 判据 = `派发:卡${String(created.card_no).padStart(4, "0")}:尝试1`;
		const 磁盘原文 = JSON.parse(readFileSync(budgetLedgerPath(home), "utf8")) as {
			reservations: { idempotencyKey: string; status: string; 已结算费用?: number }[];
		};
		const 落盘 = 磁盘原文.reservations.find((r) => r.idempotencyKey === 判据);
		expect(落盘?.status).toBe("settled");
		expect(落盘?.已结算费用).toBe(1.75);

		const 重读 = inspectReservation(home, 判据);
		expect(重读.state).toBe("settled");
	});

	it("登记表里不残留活条目（派发结束后可观察事实是干净的）", async () => {
		const { cardsDir, home } = workspace();
		await grant(home, 10);
		const created = await card(cardsDir, { 预算: { cost: 1 } });
		const runner = new FakeRunner();
		runner.costs = [0.5];
		const h = harness(runner, cardsDir, home);
		await dispatch(h.tool("pao_dispatch_card"), cardsDir, created.card_no);
		await h.face.waitForBackground();

		const 活条目: ProcessEntry[] = runner.registry.list().filter((entry) => entry.running);
		expect(活条目).toHaveLength(0);
	});
});
