/**
 * 用途：主代理独立验收 PAO 派发预算门禁的两条实际调用路径。
 * 输入：当前 PAO/packages/coding-agent/src 下的生产源码。
 * 输出：终端中的 JSON 事实；任一条与预期不符时以非零状态退出。
 * 隔离：卡目录和 PAO_HOME 均创建在
 * D:\AI\workspace\临时文件夹\七项修复独立预算-20261020 下的唯一 mkdtemp 子目录，
 * 不读写正式 PAO_HOME。
 * 清理：用例结束即删除本轮登记的 mkdtemp 子目录；脚本、证据和输出保留。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCard, readCard, serializeCard } from "../../PAO/packages/coding-agent/src/pao/cards/index.ts";
import { executeFanout } from "../../PAO/packages/coding-agent/src/pao/fanout/execute.ts";
import {
	budgetLedgerPath,
	grantBudget,
	inspectReservation,
} from "../../PAO/packages/coding-agent/src/pao/usage/budget-ledger.ts";
import {
	buildDispatchBudgetGate,
	readBudgetStatus,
} from "../../PAO/packages/coding-agent/src/pao/usage/dispatch-gate.ts";
import { executeDispatch } from "../../PAO/packages/coding-agent/src/pao/worker/dispatch-core.ts";
import type { WorkerReceipt } from "../../PAO/packages/coding-agent/src/pao/worker/receipt.ts";
import {
	WorkerRunner,
	type WorkerRunOptions,
} from "../../PAO/packages/coding-agent/src/pao/worker/runner.ts";

const temporaryRoots: string[] = [];
const fixtureBase = String.raw`D:\AI\workspace\临时文件夹\七项修复独立预算-20261020`;

class FakeRunner extends WorkerRunner {
	runs: WorkerRunOptions[] = [];
	fixedCost: number;
	missingUsageRounds = 0;

	constructor(fixedCost: number) {
		super();
		this.fixedCost = fixedCost;
	}

	override async run(options: WorkerRunOptions): Promise<WorkerReceipt> {
		this.runs.push(options);
		const index = this.runs.length - 1;
		const pid = 930000 + index;

		this.registry.register({
			pid,
			card_no: options.卡号,
			card_path: options.卡路径,
			attempt: options.尝试号 ?? 1,
			command: "budget-review-fake-runner",
			dept: options.部门 ?? null,
			dispatch_reason: options.派单理由 ?? null,
		});
		this.registry.markExited(pid);

		return {
			card_no: options.卡号,
			card_path: options.卡路径,
			attempt: options.尝试号 ?? 1,
			status: "success",
			missing_usage_rounds: this.missingUsageRounds,
			artifact_path: [],
			summary: "隔离假 worker 回执",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				cost: this.fixedCost,
				turns: 1,
			},
			evidence_path: "",
			exitCode: 0,
			command: "budget-review-fake-runner",
			pid,
			duration_ms: 1,
		};
	}
}

function workspace(tag: string): { cardsDir: string; home: string } {
	mkdirSync(fixtureBase, { recursive: true });
	const root = mkdtempSync(join(fixtureBase, `run-${tag}-`));
	temporaryRoots.push(root);
	const cardsDir = join(root, ".pao", "卡");
	const home = join(root, "PAO_HOME");
	mkdirSync(cardsDir, { recursive: true });
	mkdirSync(home, { recursive: true });
	return { cardsDir, home };
}

async function makeCard(cardsDir: string, cost: number) {
	return createCard(
		cardsDir,
		{
			目标: `预算审查-${crypto.randomUUID()}`,
			部门: "测试",
			验收: "隔离用例完成",
			创建: "2026-10-20 10:00",
			预算: { cost },
		},
		{ counterPath: join(cardsDir, "..", "卡号.txt") },
	);
}

async function grant(home: string, total: number): Promise<void> {
	await grantBudget(budgetLedgerPath(home), {
		总预算: total,
		授权人: "隔离审查用户",
		授权时间: "2026-10-20T02:00:00.000Z",
	});
}

function budgetKey(cardNo: number, attempt: number): string {
	return `派发:卡${String(cardNo).padStart(4, "0")}:尝试${attempt}`;
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("PAO 总预算实际调用路径", () => {
	it("已有真实回执后业务回调抛错，费用只结算一次且不归还", async () => {
		const { cardsDir, home } = workspace("callback-error");
		await grant(home, 10);
		const card = await makeCard(cardsDir, 5);
		const factory = buildDispatchBudgetGate({ paoHome: home })!;
		let settled = 0;
		let unknown = 0;
		let released = 0;
		await expect(executeDispatch(
			{ cardsDir, card_no: String(card.card_no), operator: "测试", time: "2026-10-20 10:00" },
			{
				运行器: new FakeRunner(2), paoHome: home, workflowCheck: () => undefined,
				预算门禁: async (...args) => {
					const gate = await factory(...args);
					if (!gate.ok) return gate;
					return {
						...gate,
						settle: async (receipt) => { settled++; return gate.settle(receipt); },
						settleUnknown: async (reason) => { unknown++; return gate.settleUnknown(reason); },
						release: async () => { released++; return gate.release(); },
					};
				},
			},
			async () => { throw new Error("注入结果处理失败"); },
		)).rejects.toThrow("注入结果处理失败");
		expect({ settled, unknown, released }).toEqual({ settled: 1, unknown: 0, released: 0 });
		expect(inspectReservation(home, budgetKey(card.card_no, 1)).state).toBe("settled");
		expect(readBudgetStatus(home).已占).toBe(2);
	});

	it("批量任务有缺账轮次时标未知，保留全部预留而不按部分费用释放", async () => {
		const { cardsDir, home } = workspace("partial-usage");
		await grant(home, 10);
		const card = await makeCard(cardsDir, 5);
		const runner = new FakeRunner(1);
		runner.missingUsageRounds = 1;
		const result = await executeFanout(
			{ cardsDir, 卡号列表: [String(card.card_no)], 并发上限: 1, 理由: "缺账验收" },
			{ 运行器: runner, paoHome: home },
		);
		const reservation = inspectReservation(home, budgetKey(card.card_no, 1));
		expect(reservation.state).toBe("unknown");
		if (reservation.state !== "missing") expect(reservation.reservation.已结算费用).toBeUndefined();
		expect(readBudgetStatus(home).已占).toBe(5);
		expect(result.结果[0]?.派发告警?.join("\n")).toContain("费用未知");
	});

	it("扇出完成后按实际费用结算，释放差额", async () => {
		const { cardsDir, home } = workspace("fanout");
		await grant(home, 20);
		const card = await makeCard(cardsDir, 10);
		const runner = new FakeRunner(1.25);

		const summary = await executeFanout(
			{
				cardsDir,
				卡号列表: [String(card.card_no)],
				并发上限: 1,
				理由: "只读隔离复现扇出预算结算",
			},
			{ 运行器: runner, paoHome: home },
		);

		const reservation = inspectReservation(home, budgetKey(card.card_no, 1));
		const evidence = {
			case: "fanout-success-not-settled",
			成功数: summary.count.成功,
			回执落卡: summary.结果[0]?.回执落卡,
			尝试号: summary.结果[0]?.attempt,
			worker运行次数: runner.runs.length,
			预算账状态: reservation.state,
			预留额:
				reservation.state === "missing" ? undefined : reservation.reservation.预留额,
			实际费用: summary.结果[0]?.终态 === "成功" ? 1.25 : undefined,
		};
		console.log(`复现输出：${JSON.stringify(evidence)}`);

		expect(evidence.成功数).toBe(1);
		expect(evidence.回执落卡).toBe("已记录");
		expect(evidence.worker运行次数).toBe(1);
		expect(evidence.预算账状态).toBe("settled");
		if (reservation.state !== "missing") {
			expect(reservation.reservation.预留额).toBe(10);
			expect(reservation.reservation.已结算费用).toBe(1.25);
		}
		expect(readBudgetStatus(home).剩余).toBe(18.75);
	});

	it("首轮花6后重试仅预留4，两次共花10且正常受理", async () => {
		const { cardsDir, home } = workspace("retry");
		await grant(home, 10);
		const card = await makeCard(cardsDir, 10);

		await executeDispatch(
			{
				cardsDir,
				card_no: String(card.card_no),
				operator: "测试",
				time: "2026-10-20 10:00",
			},
			{
				运行器: new FakeRunner(6),
				paoHome: home,
				workflowCheck: () => undefined,
				预算门禁: buildDispatchBudgetGate({ paoHome: home }),
			},
			async (claimed, receipt) => {
				const current = readCard(claimed.card.path);
				const usage = {
					input: receipt.usage.input,
					output: receipt.usage.output,
					cacheRead: receipt.usage.cacheRead,
					cacheWrite: receipt.usage.cacheWrite,
					cost: receipt.usage.cost,
					turns: receipt.usage.turns,
				};
				writeFileSync(
					current.path,
					serializeCard(
						current.frontmatter,
						`${current.body.trimEnd()}\n\n## 回执 尝试1 2026-10-20 10:00\n- result: success\n- summary: "首轮已花 6"\n- usage: ${JSON.stringify(usage)}\n`,
					),
				);
				return "first";
			},
		);

		const afterFirst = readCard(card.path);
		writeFileSync(
			card.path,
			serializeCard({ ...afterFirst.frontmatter, status: "failed" }, afterFirst.body),
		);

		const retryRunner = new FakeRunner(4);
		const second = await executeDispatch(
			{
				cardsDir,
				card_no: String(card.card_no),
				operator: "测试",
				time: "2026-10-20 10:01",
			},
			{
				运行器: retryRunner,
				paoHome: home,
				workflowCheck: () => undefined,
				预算门禁: buildDispatchBudgetGate({ paoHome: home }),
			},
			async () => "second",
		);

		const ledger = JSON.parse(
			readFileSync(budgetLedgerPath(home), "utf8"),
		) as {
			grants: { 总预算: number }[];
			reservations: {
				idempotencyKey: string;
				status: string;
				预留额: number;
				已结算费用?: number;
			}[];
		};
		const firstReservation = ledger.reservations.find(
			(row) => row.idempotencyKey === budgetKey(card.card_no, 1),
		);
		const evidence = {
			case: "retry-reserves-full-card-budget",
			首次已结算费用: firstReservation?.已结算费用,
			总预算: ledger.grants.at(-1)?.总预算,
			重试是否放行: second.可派,
			拒绝原因: second.可派 ? undefined : second.原因,
			重试worker运行次数: retryRunner.runs.length,
			尝试2预算记录: inspectReservation(home, budgetKey(card.card_no, 2)).state,
		};
		console.log(`复现输出：${JSON.stringify(evidence)}`);

		expect(evidence.首次已结算费用).toBe(6);
		expect(evidence.总预算).toBe(10);
		expect(evidence.重试是否放行).toBe(true);
		expect(evidence.拒绝原因).toBeUndefined();
		expect(evidence.重试worker运行次数).toBe(1);
		expect(evidence.尝试2预算记录).toBe("settled");
		const retryReservation = inspectReservation(home, budgetKey(card.card_no, 2));
		if (retryReservation.state !== "missing") {
			expect(retryReservation.reservation.预留额).toBe(4);
			expect(retryReservation.reservation.已结算费用).toBe(4);
		}
		expect(readBudgetStatus(home).已占).toBe(10);
		expect(readBudgetStatus(home).剩余).toBe(0);
	});
});

