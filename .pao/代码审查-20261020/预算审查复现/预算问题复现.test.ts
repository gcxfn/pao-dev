/**
 * 用途：只读复现 PAO 派发预算门禁的两条实际调用路径。
 * 输入：当前 PAO/packages/coding-agent/src 下的生产源码。
 * 输出：终端中的 JSON 事实；任一条与预期不符时以非零状态退出。
 * 隔离：卡目录和 PAO_HOME 均创建在
 * D:\AI\workspace\临时文件夹\预算审查-20261020 下的唯一 mkdtemp 子目录，
 * 不读写正式 PAO_HOME。
 * 清理：用例结束即删除本轮登记的 mkdtemp 子目录；脚本、证据和输出保留。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCard, readCard, serializeCard } from "../../../PAO/packages/coding-agent/src/pao/cards/index.ts";
import { executeFanout } from "../../../PAO/packages/coding-agent/src/pao/fanout/execute.ts";
import {
	budgetLedgerPath,
	grantBudget,
	inspectReservation,
} from "../../../PAO/packages/coding-agent/src/pao/usage/budget-ledger.ts";
import {
	buildDispatchBudgetGate,
	settleDispatchBudget,
} from "../../../PAO/packages/coding-agent/src/pao/usage/dispatch-gate.ts";
import { executeDispatch } from "../../../PAO/packages/coding-agent/src/pao/worker/dispatch-core.ts";
import type { WorkerReceipt } from "../../../PAO/packages/coding-agent/src/pao/worker/receipt.ts";
import {
	WorkerRunner,
	type WorkerRunOptions,
} from "../../../PAO/packages/coding-agent/src/pao/worker/runner.ts";

const temporaryRoots: string[] = [];
const fixtureBase = String.raw`D:\AI\workspace\临时文件夹\预算审查-20261020`;

class FakeRunner extends WorkerRunner {
	runs: WorkerRunOptions[] = [];
	fixedCost: number;

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
	it("扇出回执成功落卡后，预算账仍停在 reserved（P2）", async () => {
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
		expect(evidence.预算账状态).toBe("reserved");
		if (reservation.state !== "missing") {
			expect(reservation.reservation.预留额).toBe(10);
		}
	});

	it("重试有剩余 $4 时仍按整卡 $10 预留，派发被拒且 worker 未启动（P2）", async () => {
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
				await settleDispatchBudget({
					paoHome: home,
					idempotencyKey: budgetKey(card.card_no, 1),
					实际费用: 6,
					现在: "2026-10-20T02:01:00.000Z",
				});
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
		expect(evidence.重试是否放行).toBe(false);
		expect(evidence.拒绝原因).toContain("本次需要 $10.00，剩余 $4.00");
		expect(evidence.重试worker运行次数).toBe(0);
		expect(evidence.尝试2预算记录).toBe("missing");
	});
});
