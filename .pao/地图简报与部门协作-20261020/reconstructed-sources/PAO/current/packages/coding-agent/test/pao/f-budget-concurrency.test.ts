/**
 * F1 件二：T20 并发不重授额 / 拒绝零痕迹 / 未知费用不填 0 / 重开不重复授额。
 *
 * 与 G2（`usage-budget.test.ts`，门禁自身算得对不对）和 G4（`usage-gate-wiring.test.ts`，
 * 两条请求的接线行为）的口径区别——本文件**不复制它们的用例**，只补三处它们覆盖不到的场景：
 *
 * 1. **N 路真并发恰好只过允许的数量**：G4 只有 2 张卡，且真实派发链上同一项目有项目写锁
 *    （`dispatch-core.ts:859` `acquireProjectLock` 在预算门禁 `:871` 之前），实际是串行的。
 *    要验"恰好 N 个"就必须绕开那层锁，直接对**钱的账**（`usage/budget-ledger.ts` 的
 *    `reserveBudget`，其注释承诺「检查与写在同一个锁内」）造 8 路并发。
 * 2. **拒绝零痕迹**：被拒的卡必须**根本没进认领**（`cards/statemachine.ts:17-23` 的
 *    `ALLOWED_TRANSITIONS` 没有 `in_progress → unclaimed` 回退，所以"进去再退"根本不可表达）。
 *    从真实 `executeDispatch` 入口验，断言卡文件**全部逐字节不变**、尝试号不涨、在途表零。
 * 3. **未知费用不填 $0.00**：`usage/basis.ts:108` `sumMeteredCosts` 的"任一未知则合计未知"，
 *    接上真实预算账的 unknown 状态一起看：账上 unknown 的钱继续占着，合计口径也不许洗成已知。
 *
 * hermetic：临时 PAO_HOME + 临时项目根，FakeRunner 替身不出真进程，不调真实供应商，
 * 不读写正式 PAO_HOME。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CardCreateInput, createCard, type ParsedCard, readCard } from "../../src/pao/cards/index.ts";
import { formatMeteredCost, knownCostAmount, sumMeteredCosts, unknownAmount } from "../../src/pao/usage/basis.ts";
import {
	budgetLedgerPath,
	committedSpend,
	grantBudget,
	inspectReservation,
	readBudgetLedger,
} from "../../src/pao/usage/budget-ledger.ts";
import { checkDispatchBudget, readBudgetStatus, settleDispatchBudget } from "../../src/pao/usage/dispatch-gate.ts";
import { executeDispatch } from "../../src/pao/worker/dispatch-core.ts";
import type { WorkerReceipt } from "../../src/pao/worker/receipt.ts";
import { WorkerRunner, type WorkerRunOptions } from "../../src/pao/worker/runner.ts";

const NOW = "2026-10-17T10:00:00.000Z";
const dirs: string[] = [];
const runners: WorkerRunner[] = [];
afterEach(async () => {
	for (const runner of runners.splice(0)) await runner.stopAll();
	// 模块级项目写队列（dispatch-core 的 projectQueues）随目录删除自然失效：
	// 每个用例都用新临时目录，键不同，不互相阻塞。
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pao-f-${prefix}-`));
	dirs.push(dir);
	return dir;
}

function workspace(prefix: string): { root: string; cardsDir: string; home: string } {
	const root = temp(`${prefix}-项目`);
	const cardsDir = join(root, ".pao", "卡");
	mkdirSync(cardsDir, { recursive: true });
	const home = temp(`${prefix}-现场`);
	return { root, cardsDir, home };
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
	await grantBudget(budgetLedgerPath(home), { 总预算: total, 授权人: "测试用户", 授权时间: NOW });
}

/** 离线假 worker：不出真进程，只回一份可控回执。 */
class FakeRunner extends WorkerRunner {
	runs: WorkerRunOptions[] = [];
	/** 回执里的费用（undefined＝回执不带真实 usage）。 */
	costs: (number | undefined)[] = [];
	override async run(options: WorkerRunOptions): Promise<WorkerReceipt> {
		this.runs.push(options);
		const index = this.runs.length - 1;
		const cost = this.costs[index];
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

/**
 * 从 executeDispatch 入口（不经 registerWorkerTools）派一张卡。
 *
 * 为什么绕开工具层：工具层是非阻塞的（受理即返回「已派出」，真实结果进通知面），
 * 而这里要断言的是"这一单到底派成没派成"——直接拿 executeDispatch 的返回值最干净。
 * `预算门禁` 按 `worker/index.ts:176 buildDispatchBudgetGate` 的同一口径手工接：
 * 判据 `派发:卡NNNN:尝试N`、金额取每卡预算、指纹取 sha256 —— 只是照抄口径，不改实现。
 */
function dispatchViaCore(input: {
	runner: WorkerRunner;
	cardsDir: string;
	home: string;
	cardNo: number;
	gate: (
		card: ParsedCard,
		尝试号: number,
		剩余预算?: { cost?: number },
	) => Promise<
		| {
				ok: true;
				commit: () => Promise<void>;
				release: () => Promise<void>;
				settle: (receipt: WorkerReceipt) => Promise<string | undefined>;
				settleUnknown: (reason: string) => Promise<string | undefined>;
		  }
		| { ok: false; reason: string }
	>;
	/** 完成回调被调用的次数观察点（认领发生才会被调用）。 */
	onCompleted?: () => void;
}) {
	return executeDispatch(
		{ cardsDir: input.cardsDir, card_no: String(input.cardNo), operator: "F1用例", time: "2026-10-17 10:00" },
		{
			运行器: input.runner,
			paoHome: input.home,
			workflowCheck: () => undefined,
			预算门禁: input.gate,
		},
		// 被拒时这条回调根本不会被调用（认领没发生）；真被调用说明门禁没拦住，返回占位值让断言去炸。
		async () => {
			input.onCompleted?.();
			return "已开跑";
		},
	);
}

// ── 1. N 路真并发：恰好只过允许的数量，且账本不超总额 ──────────────────────
describe("T20-1 N 路真并发不重授额", () => {
	it("总额 10、8 个请求各要 3 → 恰好 3 个通过，committedSpend=9 不超总额", async () => {
		const home = temp("并发-现场");
		await grant(home, 10);
		const 金额 = 3;
		const 请求数 = 8;

		// 同时起跑，不是顺序化后假装：Promise.all 一次性发出 8 个 checkDispatchBudget。
		// 若"检查余额"与"写预留"不在同一把锁内，多个请求会各读到同样的剩额从而都通过。
		const verdicts = await Promise.all(
			Array.from({ length: 请求数 }, (_unused, index) =>
				checkDispatchBudget({
					paoHome: home,
					idempotencyKey: `派发:卡${String(index + 1).padStart(4, "0")}:尝试1`,
					金额,
					指纹: `fp-${index}`,
					现在: NOW,
					...(index === 0 ? {} : {}),
				}),
			),
		);

		const 通过 = verdicts.filter((verdict) => verdict.ok);
		const 拒绝 = verdicts.filter((verdict) => !verdict.ok);
		// 恰好 floor(10/3)=3 个（第 4 个会需要 12 > 10）
		expect(通过).toHaveLength(3);
		expect(拒绝).toHaveLength(请求数 - 3);

		// 账本事实：只落 3 条预留，钱占 9，不超总额 10
		const file = readBudgetLedger(budgetLedgerPath(home));
		expect(file.reservations).toHaveLength(3);
		expect(committedSpend(file)).toBe(9);
		expect(committedSpend(file)).toBeLessThanOrEqual(10);
		// 剩余额度如实（不被某个并发请求"多领"走）
		const status = readBudgetStatus(home);
		expect(status.enabled).toBe(true);
		expect(status.剩余).toBe(1);

		// 被拒的每一条都带着真实原因（不是笼统"失败"），且指得出下一步该看什么
		for (const verdict of 拒绝) {
			if (verdict.ok) continue;
			expect(verdict.kind).toBe("额度不足");
			expect(verdict.reason).toContain("总预算不足");
			expect(verdict.reason).toContain("剩余 $1.00");
		}
		// 被拒的那几条在账上根本不存在（没扣额＝没留痕）
		const 被占判据 = new Set(file.reservations.map((row) => row.idempotencyKey));
		expect(被占判据.size).toBe(3);
	});

	it("同判据并发重入只留一条预留（复选而非再扣一份）", async () => {
		const home = temp("并发同判据-现场");
		await grant(home, 10);
		const verdicts = await Promise.all(
			Array.from({ length: 4 }, () =>
				checkDispatchBudget({ paoHome: home, idempotencyKey: "派发:卡0001:尝试1", 金额: 4, 指纹: "fp", 现在: NOW }),
			),
		);
		// 4 条全部放行（同一条请求的重复受理），但账上只有一条预留、只占 4
		expect(verdicts.every((verdict) => verdict.ok)).toBe(true);
		const file = readBudgetLedger(budgetLedgerPath(home));
		expect(file.reservations).toHaveLength(1);
		expect(committedSpend(file)).toBe(4);
	});
});

// ── 2. 拒绝零痕迹：卡没进认领，状态机没有回退可走 ────────────────────────
describe("T20-2 门禁拒绝后卡根本没进入认领", () => {
	it("executeDispatch 被拒 → 卡文件逐字节不变、尝试号不涨、在途表零、runner 一次没跑", async () => {
		const { cardsDir, home } = workspace("拒绝");
		await grant(home, 1); // 只给 $1
		const created = await card(cardsDir, { 预算: { cost: 5 } }); // 要 $5
		const before = readFileSync(created.path);
		const beforeCard = readCard(created.path);

		const runner = new FakeRunner();
		runners.push(runner);
		// 完成回调被调用＝门禁没拦住（认领发生了）。用一个可观察的旗标把这件事钉死：
		// 只断言 runner.runs 为 0 还不够——认领成功但拉起前抛错的路径也不会进 runs。
		let 完成回调被调用 = 0;
		const 判据 = `派发:卡${String(created.card_no).padStart(4, "0")}:尝试1`;

		// 门禁用真实实现，只是把 try/catch 包一层让拒绝以返回值形态出现（executeDispatch 正常返回 outcome，
		// 不 throw）；这样能同时断言"拒绝原因带下一步"与"卡面零痕迹"。
		let 拒绝原因: string | undefined;
		const outcome = await dispatchViaCore({
			runner,
			cardsDir,
			home,
			cardNo: created.card_no,
			onCompleted: () => {
				完成回调被调用 += 1;
			},
			gate: async (gateCard, 尝试号) => {
				const verdict = await checkDispatchBudget({
					paoHome: home,
					idempotencyKey: `派发:卡${String(gateCard.card_no).padStart(4, "0")}:尝试${尝试号}`,
					金额: gateCard.frontmatter.budget?.cost ?? 0,
					指纹: `fp-卡${gateCard.card_no}`,
					现在: NOW,
				});
				if (!verdict.ok) {
					拒绝原因 = verdict.reason;
					return { ok: false, reason: verdict.reason };
				}
				return {
					ok: true,
					commit: async () => {},
					release: async () => {
						await verdict.releaseSlot();
					},
					settle: async (receipt) => {
						await settleDispatchBudget({
							paoHome: home,
							idempotencyKey: `派发:卡${String(gateCard.card_no).padStart(4, "0")}:尝试${尝试号}`,
							实际费用: receipt.usage?.cost,
							现在: NOW,
						});
						return undefined;
					},
					settleUnknown: async () => {
						await settleDispatchBudget({
							paoHome: home,
							idempotencyKey: `派发:卡${String(gateCard.card_no).padStart(4, "0")}:尝试${尝试号}`,
							现在: NOW,
						});
						return undefined;
					},
				};
			},
		});

		// ① 派发结果：被拒，原因里既有"缺多少"也有下一步
		expect(outcome.可派).toBe(false);
		if (!outcome.可派) expect(outcome.原因).toContain("总预算门禁拒绝派发");
		expect(拒绝原因).toContain("总预算不足");
		expect(拒绝原因).toContain("总预算 $1.00");

		// ② 卡文件逐字节不变——这是"根本没进入认领"最强的证据：
		//    状态机（statemachine.ts:17-23）没有 in_progress→unclaimed，一旦认领就退不回来，
		//    所以"进去再退"这种实现根本不可能通过这条断言。
		expect(readFileSync(created.path).equals(before)).toBe(true);
		const afterCard = readCard(created.path);
		expect(afterCard.frontmatter.status).toBe("unclaimed");
		expect(afterCard.frontmatter.attempt).toBe(beforeCard.frontmatter.attempt);
		expect(afterCard.receipts).toHaveLength(0);

		// ③ 一行代码没跑、在途表干净、以及最关键的：完成回调一次都没被调用
		//    （完成回调只在"认领成功且 run 返回回执"之后才走，它没被调用＝认领根本没发生）
		expect(完成回调被调用).toBe(0);
		expect(runner.runs).toHaveLength(0);
		expect(runner.registry.list().filter((entry) => entry.running)).toHaveLength(0);

		// ④ 账上没留预留（钱没被占，修好预算后同一判据还能派）
		expect(inspectReservation(home, 判据).state).toBe("missing");
		const file = readBudgetLedger(budgetLedgerPath(home));
		expect(file.reservations).toHaveLength(0);
	});

	it("账本损坏时按 fail-closed 拒派，错误文案指得出该修哪个文件", async () => {
		const { cardsDir, home } = workspace("坏账拒派");
		// 造坏账：不是 JSON
		mkdirSync(home, { recursive: true });
		const { writeFileSync } = await import("node:fs");
		writeFileSync(budgetLedgerPath(home), "{ 这不是 JSON", "utf8");
		const created = await card(cardsDir, { 预算: { cost: 1 } });
		const before = readFileSync(created.path);
		const runner = new FakeRunner();
		runners.push(runner);

		// buildDispatchBudgetGate（worker/index.ts:185-193）在门禁启用判断阶段就吞掉坏账、
		// 换成"一律拒绝"的门禁。这里直接复刻那一段的语义：读不了账就拒派并指出文件。
		const { readBudgetStatus: statusOf } = await import("../../src/pao/usage/dispatch-gate.ts");
		let 坏账原因: string | undefined;
		try {
			statusOf(home);
		} catch (error) {
			坏账原因 = error instanceof Error ? error.message : String(error);
		}
		expect(坏账原因).toContain("总预算账");
		expect(坏账原因).toContain(budgetLedgerPath(home));

		const outcome = await dispatchViaCore({
			runner,
			cardsDir,
			home,
			cardNo: created.card_no,
			gate: async () => ({
				ok: false,
				reason: `总预算账读不了（拒绝在账不明的情况下派发）：${坏账原因}；请修好 ${budgetLedgerPath(home)} 或显式重新授权`,
			}),
		});
		expect(outcome.可派).toBe(false);
		if (!outcome.可派) {
			expect(outcome.原因).toContain("总预算账读不了");
			expect(outcome.原因).toContain(BUDGET_LEDGER_BASENAME);
		}
		// 拒绝仍零痕迹
		expect(readFileSync(created.path).equals(before)).toBe(true);
		expect(runner.runs).toHaveLength(0);
	});
});

const BUDGET_LEDGER_BASENAME = "总预算账.json";

// ── 3. 未知费用不填 0：单个未知、合计也未知 ──────────────────────────────
describe("T20-3 未知费用不填 $0.00", () => {
	it("会话没回 usage → 账上 unknown（钱继续占着），费用文案是「未知」不是「$0.00」", async () => {
		const home = temp("未知费用-现场");
		await grant(home, 10);
		const 判据 = "派发:卡0001:尝试1";
		const verdict = await checkDispatchBudget({
			paoHome: home,
			idempotencyKey: 判据,
			金额: 4,
			指纹: "fp",
			现在: NOW,
		});
		expect(verdict.ok).toBe(true);

		// 会话结束没回 usage：settle 不给实际费用 → unknown，预留额继续占着
		const settled = await settleDispatchBudget({ paoHome: home, idempotencyKey: 判据, 现在: NOW });
		expect(settled.status).toBe("unknown");
		expect(settled.已结算费用).toBeUndefined(); // 关键：不是 0

		// 重开再查：仍是 unknown（不自动转 settled、不自动归还）
		const 重开 = inspectReservation(home, 判据);
		expect(重开.state).toBe("unknown");
		const file = readBudgetLedger(budgetLedgerPath(home));
		expect(committedSpend(file)).toBe(4); // 钱继续占着，不多不少

		// 费用文案：unknown 分支渲染「未知（原因）」，绝不出现 $0 / 免费
		const 未知 = unknownAmount("本轮会话未回 usage，真实扣费不可知");
		const 文案 = formatMeteredCost(未知);
		expect(文案).toContain("未知");
		expect(文案).toContain("未回 usage");
		expect(文案).not.toContain("$0");
		expect(文案).not.toContain("免费");
		expect(未知.value).toBeUndefined();

		// 已知 0 与未知 0 必须长得不一样（供应商真的回 0 ≠ 不知道花了多少）
		const 已知零 = formatMeteredCost(knownCostAmount(0));
		expect(已知零).toContain("已知 0");
		expect(已知零).not.toBe(文案);
	});

	it("合计里任一未知 → 合计也是未知（不把未知洗成已知数字）", async () => {
		const 三项 = [knownCostAmount(2.5), unknownAmount("第 2 轮缺 usage"), knownCostAmount(1.25)];
		const 合计 = sumMeteredCosts(三项);
		expect(合计.basis).toBe("unknown");
		expect(合计.value).toBeUndefined(); // 不给一个 3.75 的"合计"
		const 文案 = formatMeteredCost(合计);
		expect(文案).toContain("1 项费用拿不到依据");
		expect(文案).not.toContain("3.75");
		expect(文案).not.toContain("$0");

		// 对照：全部已知时才给数字
		const 全已知 = sumMeteredCosts([knownCostAmount(2.5), knownCostAmount(1.25)]);
		expect(全已知.basis).toBe("knownCost");
		expect(formatMeteredCost(全已知)).toContain("$3.75");

		// 空集不算未知（没有花费 ≠ 不知道花了多少）
		expect(sumMeteredCosts([]).basis).toBe("knownCost");
	});
});

// ── 4. 重开不重复授额 ────────────────────────────────────────────────────
describe("T20-4 重开不重复授额", () => {
	it("结算后重开再查 → settled；同判据再派被拒；不产生第二条预留", async () => {
		const home = temp("重开-现场");
		await grant(home, 10);
		const 判据 = "派发:卡0001:尝试1";
		const first = await checkDispatchBudget({ paoHome: home, idempotencyKey: 判据, 金额: 6, 指纹: "fp", 现在: NOW });
		expect(first.ok).toBe(true);
		await settleDispatchBudget({ paoHome: home, idempotencyKey: 判据, 实际费用: 2.5, 现在: NOW });

		// "重开"：没有任何内存态可清，全部事实在盘上——重读就是重开
		const 重开 = inspectReservation(home, 判据);
		expect(重开.state).toBe("settled");
		if (重开.state !== "missing") {
			expect(重开.reservation.已结算费用).toBe(2.5);
			expect(重开.reservation.预留额).toBe(6);
		}

		// 同判据再来一次：先查后拒，明确说"已经结算过"，不是笼统"额度不足"
		const again = await checkDispatchBudget({
			paoHome: home,
			idempotencyKey: 判据,
			金额: 6,
			指纹: "fp",
			现在: NOW,
		});
		expect(again.ok).toBe(false);
		if (!again.ok) {
			expect(again.kind).toBe("结果不明");
			expect(again.reason).toContain("已经结算过");
			expect(again.reason).toContain("$2.50");
			expect(again.reason).toContain("换新判据");
		}

		// 账本：仍是一条预留，实花 2.5，差额自动归还（剩 7.5）
		const file = readBudgetLedger(budgetLedgerPath(home));
		expect(file.reservations).toHaveLength(1);
		expect(committedSpend(file)).toBe(2.5);
		expect(readBudgetStatus(home).剩余).toBe(7.5);
	});

	it("reserved 的过期项不会被自动归还，也不许对同一判据再授一次额", async () => {
		const home = temp("过期预留-现场");
		await grant(home, 10);
		const 判据 = "派发:卡0002:尝试1";
		await checkDispatchBudget({ paoHome: home, idempotencyKey: 判据, 金额: 7, 指纹: "fp", 现在: NOW });

		// 进程被杀：没有任何人结算，账上停在 reserved。时间过去很久也不该自己变。
		const 很久以后 = "2027-10-17T10:00:00.000Z";
		const 状态 = inspectReservation(home, 判据);
		expect(状态.state).toBe("reserved");
		const file = readBudgetLedger(budgetLedgerPath(home));
		expect(committedSpend(file)).toBe(7); // 钱还占着，没被"过期清理"
		expect(readBudgetStatus(home).剩余).toBe(3);

		// 同一判据（同指纹）再申请：复用那条 reserved，不新增、不再扣一份
		const 重入 = await checkDispatchBudget({
			paoHome: home,
			idempotencyKey: 判据,
			金额: 7,
			指纹: "fp",
			现在: 很久以后,
		});
		expect(重入.ok).toBe(true);
		const after = readBudgetLedger(budgetLedgerPath(home));
		expect(after.reservations).toHaveLength(1);
		expect(committedSpend(after)).toBe(7);

		// 同判据但内容不同（指纹不符）→ 拒，不把不同任务当成同一条
		const 不同内容 = await checkDispatchBudget({
			paoHome: home,
			idempotencyKey: 判据,
			金额: 7,
			指纹: "另一个任务的指纹",
			现在: 很久以后,
		});
		expect(不同内容.ok).toBe(false);
		if (!不同内容.ok) {
			expect(不同内容.reason).toContain("指纹不符");
			expect(不同内容.reason).toContain("拒绝把不同任务当成同一条");
		}
	});
});
