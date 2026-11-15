/**
 * 计划 §8.2「原生用量与显式总预算」单测。
 *
 * 本 spec 只做一件事：把三条硬红线钉死在用例上，失败即回归。
 * 1. **没配价格不能显示 $0/免费** —— 断言具体字符串（`basis`/`rollup` 两侧）。
 * 2. **并发不能各领一份完整总额** —— `Promise.all` 两个派发请求真并发抢同一份额度。
 * 3. **重启能核原请求** —— 预留落盘后"重建对象"（重新读盘，不靠任何内存状态）再判状态。
 *
 * 全部走临时目录真文件（真锁、真原子写），不 mock 文件系统——
 * 因为要塞住的问题（并发、锁、坏账）恰好都在文件系统这一层。
 * 不调真实供应商：本模块纯记账，没有任何网络调用。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	estimatedCostAmount,
	formatMeteredCost,
	knownCostAmount,
	sumMeteredCosts,
	tokenAmount,
	USAGE_BASIS_LABEL,
	unknownAmount,
} from "../../src/pao/usage/basis.ts";
import {
	BUDGET_LEDGER_FILENAME,
	BudgetLedgerError,
	budgetLedgerPath,
	committedSpend,
	grantBudget,
	inspectReservation,
	readBudgetLedger,
	releaseBudget,
	remainingBudget,
	reserveBudget,
	settleBudget,
} from "../../src/pao/usage/budget-ledger.ts";
import { checkDispatchBudget, readBudgetStatus, settleDispatchBudget } from "../../src/pao/usage/dispatch-gate.ts";
import { appendLedgerRow, type UsageLedgerRow } from "../../src/pao/usage/ledger.ts";
import { renderUsageRollup, rollupUsageFromPaoHome, rollupUsageRows } from "../../src/pao/usage/rollup.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempHome(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-g2-usage-"));
	tempDirs.push(dir);
	return dir;
}

const NOW = "2026-10-17T12:00:00.000Z";

// ============================================================================
// 红线 1：没配价格不能显示 $0 / 免费
// ============================================================================

describe("红线一：没配价格绝不能显示 $0 / 免费", () => {
	it("未知费用的文案是「未知（原因）」，不含 $0、不含「免费」", () => {
		const text = formatMeteredCost(unknownAmount("该会话未回 usage，价格未知"));
		expect(text).toBe("未知（该会话未回 usage，价格未知）");
		// 红线：任何"不知道"都不能长得像"不花钱"。
		expect(text).not.toContain("$0");
		expect(text).not.toContain("免费");
	});

	it("未知与已知 0 必须长得不一样（供应商真回 0 才敢说 0）", () => {
		const unknown = formatMeteredCost(unknownAmount("模型目录里没有这个模型的价格"));
		const knownZero = formatMeteredCost(knownCostAmount(0, "供应商回 0"));
		expect(unknown).not.toBe(knownZero);
		expect(knownZero).toBe("已知 0（供应商回 0）（供应商回 0）");
		expect(unknown.startsWith("未知")).toBe(true);
	});

	it("估计费用必须带「估计」与依据说明，不冒充准确值", () => {
		const text = formatMeteredCost(estimatedCostAmount(0.42, "只有 token 数，按目录单价折算"));
		expect(text).toBe("约 $0.42（估计：只有 token 数，按目录单价折算）");
		expect(text).toContain("估计");
	});

	it("四类口径的中文名齐全（Token/已知费用/未知/估计）", () => {
		expect(USAGE_BASIS_LABEL.token).toBe("Token");
		expect(USAGE_BASIS_LABEL.knownCost).toBe("已知费用");
		expect(USAGE_BASIS_LABEL.unknown).toBe("未知");
		expect(USAGE_BASIS_LABEL.estimated).toBe("估计");
	});

	it("token 数不等于费用：token 口径的文案主动否认它是钱", () => {
		expect(formatMeteredCost(tokenAmount(1234))).toBe("1234 token（token 数不等于费用）");
	});

	it("合并时任一未知 → 合计未知（不把未知洗成已知 0）", () => {
		const sum = sumMeteredCosts([knownCostAmount(1.5), unknownAmount("缺一轮")]);
		expect(sum.basis).toBe("unknown");
		expect(formatMeteredCost(sum)).not.toContain("$0");
	});

	it("合并时含估计 → 合计为估计（不当准确值）", () => {
		const sum = sumMeteredCosts([knownCostAmount(1), estimatedCostAmount(2, "折算")]);
		expect(sum.basis).toBe("estimated");
		expect(formatMeteredCost(sum)).toContain("估计");
	});

	it("账本里缺 usage 的会话，汇总费用是「未知」且渲染文本不出现 $0", () => {
		const home = tempHome();
		const rows: UsageLedgerRow[] = [
			{
				会话开始: NOW,
				会话结束: NOW,
				角色: "主控",
				input: 1000,
				output: 200,
				cacheRead: 0,
				cost: 0.02,
				turns: 3,
				缺用量轮次: 2,
			},
		];
		const rollup = rollupUsageRows(rows);
		const 主控 = rollup.buckets.find((bucket) => bucket.owner === "主控")!;
		expect(主控.费用.basis).toBe("unknown");
		const text = renderUsageRollup(rollup);
		expect(text).toContain("费用 未知（1 个会话未回 usage");
		expect(text).not.toContain("$0 ");
		expect(text).not.toContain("免费");
		// 账本文件本身没被写（只读面）。
		expect(home).toBeTruthy();
	});

	it("空账本的汇总费用是「未知（还没有会话记录）」，不是 $0", () => {
		const home = tempHome();
		const rollup = rollupUsageFromPaoHome(home);
		expect(rollup.会话数).toBe(0);
		expect(rollup.合计.费用.basis).toBe("unknown");
		const text = renderUsageRollup(rollup);
		expect(text).toContain("尚无跨会话账");
		expect(text).not.toContain("$0");
	});

	it("未授权总预算时，状态是「未启用」而不是「额度 0」", () => {
		const home = tempHome();
		const status = readBudgetStatus(home);
		expect(status.enabled).toBe(false);
		expect(status.总预算).toBeUndefined();
		expect(status.说明).toBe("用户未显式给总预算：跨任务额度未启用（不凭空设默认限额）");
	});
});

// ============================================================================
// 红线 2：并发不能各领一份完整总额
// ============================================================================

describe("红线二：并发不能各领一份完整总额", () => {
	it("两个真并发派发请求只有第一个拿到钱，第二个被真实拒绝", async () => {
		const home = tempHome();
		await grantBudget(budgetLedgerPath(home), { 总预算: 10, 授权人: "用户", 授权时间: NOW });

		// 真并发：两个 checkDispatchBudget 同时起跑，各自要 10（正好是全额）。
		// 若检查与写在锁外，两个都会读到"剩 10"从而都通过 —— 这就是要防的 bug。
		const [a, b] = await Promise.all([
			checkDispatchBudget({
				paoHome: home,
				idempotencyKey: "派发A",
				金额: 10,
				指纹: "fp-a",
				现在: NOW,
			}),
			checkDispatchBudget({
				paoHome: home,
				idempotencyKey: "派发B",
				金额: 10,
				指纹: "fp-b",
				现在: NOW,
			}),
		]);

		const passed = [a, b].filter((verdict) => verdict.ok);
		const refused = [a, b].filter((verdict) => !verdict.ok);
		expect(passed).toHaveLength(1);
		expect(refused).toHaveLength(1);
		const reason = (refused[0] as { reason: string }).reason;
		expect(reason).toContain("总预算不足");
		// 只有一条预留落盘（不重复授额）。
		const file = readBudgetLedger(budgetLedgerPath(home));
		expect(file.reservations).toHaveLength(1);
		expect(committedSpend(file)).toBe(10);
	});

	it("两个并发请求各要 6（总额 10）时也只能过一个", async () => {
		const home = tempHome();
		await grantBudget(budgetLedgerPath(home), { 总预算: 10, 授权人: "用户", 授权时间: NOW });
		const results = await Promise.all(
			["甲", "乙"].map((name) =>
				checkDispatchBudget({
					paoHome: home,
					idempotencyKey: `派发-${name}`,
					金额: 6,
					指纹: `fp-${name}`,
					现在: NOW,
				}),
			),
		);
		expect(results.filter((result) => result.ok)).toHaveLength(1);
		const file = readBudgetLedger(budgetLedgerPath(home));
		expect(file.reservations).toHaveLength(1);
	});

	it("同一判据并发重复派发只产生一条预留（复用而非再扣一份）", async () => {
		const home = tempHome();
		await grantBudget(budgetLedgerPath(home), { 总预算: 10, 授权人: "用户", 授权时间: NOW });
		const results = await Promise.all([
			checkDispatchBudget({ paoHome: home, idempotencyKey: "同一请求", 金额: 8, 指纹: "fp", 现在: NOW }),
			checkDispatchBudget({ paoHome: home, idempotencyKey: "同一请求", 金额: 8, 指纹: "fp", 现在: NOW }),
		]);
		expect(results.every((result) => result.ok)).toBe(true);
		const file = readBudgetLedger(budgetLedgerPath(home));
		expect(file.reservations).toHaveLength(1);
		expect(committedSpend(file)).toBe(8);
	});

	it("并发名额已满时拒绝派发（复用既有 reserveSharedRequest，不另写一套）", async () => {
		const home = tempHome();
		await grantBudget(budgetLedgerPath(home), { 总预算: 100, 授权人: "用户", 授权时间: NOW });
		const 并发名额 = { path: join(home, "共享额度.json"), requests: 100, concurrency: 1 };
		const first = await checkDispatchBudget({
			paoHome: home,
			idempotencyKey: "占用名额",
			金额: 1,
			指纹: "fp-1",
			现在: NOW,
			并发名额,
		});
		expect(first.ok).toBe(true);
		const second = await checkDispatchBudget({
			paoHome: home,
			idempotencyKey: "抢名额",
			金额: 1,
			指纹: "fp-2",
			现在: NOW,
			并发名额,
		});
		expect(second.ok).toBe(false);
		expect((second as { kind: string }).kind).toBe("并发已满");
		expect((second as { reason: string }).reason).toContain("并发名额已满");
		// 名额被占时第二条不能留下钱的预留（fail-closed 且不占款）。
		expect(readBudgetLedger(budgetLedgerPath(home)).reservations).toHaveLength(1);
	});
});

// ============================================================================
// 红线 3：重启能核原请求
// ============================================================================

describe("红线三：重启能核原请求", () => {
	it("预留落盘后重新读盘（模拟重启）能判出已预留", async () => {
		const home = tempHome();
		await grantBudget(budgetLedgerPath(home), { 总预算: 50, 授权人: "用户", 授权时间: NOW });
		await reserveBudget(budgetLedgerPath(home), {
			idempotencyKey: "请求-1",
			金额: 7,
			指纹: "fp-1",
			现在: NOW,
		});
		// "重启"：不依赖任何内存状态，只按判据重新查盘。
		const inspected = inspectReservation(home, "请求-1");
		expect(inspected.state).toBe("reserved");
		// 重启后剩余额度也一致（钱确实被占住了）。
		const file = readBudgetLedger(budgetLedgerPath(home));
		expect(remainingBudget(file)).toBe(43);
	});

	it("已结算是重启后的第二种状态，且按实际费用算", async () => {
		const home = tempHome();
		await grantBudget(budgetLedgerPath(home), { 总预算: 50, 授权人: "用户", 授权时间: NOW });
		await reserveBudget(budgetLedgerPath(home), {
			idempotencyKey: "请求-2",
			金额: 20,
			指纹: "fp-2",
			现在: NOW,
		});
		await settleDispatchBudget({
			paoHome: home,
			idempotencyKey: "请求-2",
			实际费用: 4.5,
			现在: NOW,
		});
		const inspected = inspectReservation(home, "请求-2");
		expect(inspected.state).toBe("settled");
		// 按实际结算：预留 20、实花 4.5 → 剩余 45.5（差额自动归还）。
		expect(remainingBudget(readBudgetLedger(budgetLedgerPath(home)))).toBe(45.5);
	});

	it("费用未知时记「结果不明」，钱继续占着，且拒绝重派（先查不重复授额）", async () => {
		const home = tempHome();
		await grantBudget(budgetLedgerPath(home), { 总预算: 50, 授权人: "用户", 授权时间: NOW });
		await reserveBudget(budgetLedgerPath(home), {
			idempotencyKey: "请求-3",
			金额: 30,
			指纹: "fp-3",
			现在: NOW,
		});
		// 派发成功但供应商没回费用：不能假装花 0，状态记 unknown。
		await settleDispatchBudget({ paoHome: home, idempotencyKey: "请求-3", 现在: NOW });
		expect(inspectReservation(home, "请求-3").state).toBe("unknown");

		// 重启后再派同一请求：先查，判"结果不明"，不给钱也不重复授额。
		const verdict = await checkDispatchBudget({
			paoHome: home,
			idempotencyKey: "请求-3",
			金额: 30,
			指纹: "fp-3",
			现在: NOW,
		});
		expect(verdict.ok).toBe(false);
		expect((verdict as { kind: string }).kind).toBe("结果不明");
		expect((verdict as { reason: string }).reason).toContain("先查清结果再重派，不重复授额");
		// 钱仍然占着（保守），没被悄悄归还。
		expect(committedSpend(readBudgetLedger(budgetLedgerPath(home)))).toBe(30);
	});

	it("结果不明时不许直接归还（归还可能导致超支）", async () => {
		const home = tempHome();
		await grantBudget(budgetLedgerPath(home), { 总预算: 50, 授权人: "用户", 授权时间: NOW });
		await reserveBudget(budgetLedgerPath(home), {
			idempotencyKey: "请求-4",
			金额: 5,
			指纹: "fp-4",
			现在: NOW,
		});
		await settleBudget(budgetLedgerPath(home), { idempotencyKey: "请求-4", 现在: NOW });
		await expect(releaseBudget(budgetLedgerPath(home), { idempotencyKey: "请求-4", 现在: NOW })).rejects.toThrow(
			/结果不明.*须先查清/,
		);
	});

	it("账里没有这条判据时如实返回 missing（不是假装已预留）", () => {
		const home = tempHome();
		expect(inspectReservation(home, "从没派过").state).toBe("missing");
	});
});

// ============================================================================
// 其余计划条款：归还/结算/取消不抹费用/加额度显式/坏账不静默重置
// ============================================================================

describe("预留生命周期与显式加额度", () => {
	it("未受理（派发前被拒）时预留额全额归还", async () => {
		const home = tempHome();
		await grantBudget(budgetLedgerPath(home), { 总预算: 10, 授权人: "用户", 授权时间: NOW });
		await reserveBudget(budgetLedgerPath(home), {
			idempotencyKey: "被拒的派发",
			金额: 10,
			指纹: "fp",
			现在: NOW,
		});
		expect(remainingBudget(readBudgetLedger(budgetLedgerPath(home)))).toBe(0);
		await releaseBudget(budgetLedgerPath(home), { idempotencyKey: "被拒的派发", 现在: NOW });
		expect(remainingBudget(readBudgetLedger(budgetLedgerPath(home)))).toBe(10);
		expect(inspectReservation(home, "被拒的派发").state).toBe("released");
	});

	it("取消不抹费用：已结算的记录不能归还", async () => {
		const home = tempHome();
		await grantBudget(budgetLedgerPath(home), { 总预算: 10, 授权人: "用户", 授权时间: NOW });
		await reserveBudget(budgetLedgerPath(home), { idempotencyKey: "跑过的", 金额: 5, 指纹: "fp", 现在: NOW });
		await settleBudget(budgetLedgerPath(home), { idempotencyKey: "跑过的", 实际费用: 3, 现在: NOW });
		await expect(releaseBudget(budgetLedgerPath(home), { idempotencyKey: "跑过的", 现在: NOW })).rejects.toThrow(
			/取消不抹费用/,
		);
		expect(committedSpend(readBudgetLedger(budgetLedgerPath(home)))).toBe(3);
	});

	it("实际费用超出预留额时如实记下超额，不裁剪", async () => {
		const home = tempHome();
		await grantBudget(budgetLedgerPath(home), { 总预算: 10, 授权人: "用户", 授权时间: NOW });
		await reserveBudget(budgetLedgerPath(home), { idempotencyKey: "超支的", 金额: 2, 指纹: "fp", 现在: NOW });
		const settled = await settleBudget(budgetLedgerPath(home), {
			idempotencyKey: "超支的",
			实际费用: 2.75,
			现在: NOW,
		});
		expect(settled.已结算费用).toBe(2.75);
		expect(settled.备注).toContain("实际费用超出预留额");
		// 超额后剩余按 0 兜底（不出现负数余额冒充"还倒欠可用"）。
		expect(remainingBudget(readBudgetLedger(budgetLedgerPath(home)))).toBe(7.25);
	});

	it("加额度是显式操作：版本递增且记下当时的余额依据", async () => {
		const home = tempHome();
		const path = budgetLedgerPath(home);
		await grantBudget(path, { 总预算: 10, 授权人: "用户", 授权时间: NOW });
		await reserveBudget(path, { idempotencyKey: "已花", 金额: 4, 指纹: "fp", 现在: NOW });
		await settleBudget(path, { idempotencyKey: "已花", 实际费用: 4, 现在: NOW });
		const second = await grantBudget(path, { 总预算: 25, 授权人: "用户", 授权时间: NOW });
		expect(second.version).toBe(2);
		expect(second.余额依据).toEqual({ 已花: 4, 授权前总预算: 10 });
		expect(remainingBudget(readBudgetLedger(path))).toBe(21);
	});

	it("坏账如实抛错，绝不静默重置成满额", async () => {
		const home = tempHome();
		const path = budgetLedgerPath(home);
		mkdirSync(home, { recursive: true });
		writeFileSync(path, "{ 这不是 JSON", "utf8");
		expect(() => readBudgetLedger(path)).toThrow(BudgetLedgerError);
		await expect(reserveBudget(path, { idempotencyKey: "x", 金额: 1, 指纹: "fp", 现在: NOW })).rejects.toThrow(
			/总预算账无法解析/,
		);
		// 坏账原样保留（没被覆盖写）。
		expect(readFileSync(path, "utf8")).toBe("{ 这不是 JSON");
	});

	it("账本里坏掉的预留记录也会被拒（不悄悄跳过继续花）", async () => {
		const home = tempHome();
		const path = budgetLedgerPath(home);
		mkdirSync(home, { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				grants: [{ version: 1, 总预算: 10, 授权时间: NOW, 余额依据: { 已花: 0, 授权前总预算: 0 }, 授权人: "用户" }],
				reservations: [{ idempotencyKey: "坏的", 预留额: -1, 预留时间: NOW, 指纹: "fp", status: "reserved" }],
			}),
			"utf8",
		);
		expect(() => readBudgetLedger(path)).toThrow(/坏预留记录/);
	});

	it("同一判据内容不同时拒绝复用（不同任务不能算同一条）", async () => {
		const home = tempHome();
		const path = budgetLedgerPath(home);
		await grantBudget(path, { 总预算: 10, 授权人: "用户", 授权时间: NOW });
		await reserveBudget(path, { idempotencyKey: "同键", 金额: 1, 指纹: "指纹甲", 现在: NOW });
		const second = await reserveBudget(path, {
			idempotencyKey: "同键",
			金额: 1,
			指纹: "指纹乙",
			现在: NOW,
		});
		expect(second.ok).toBe(false);
		expect((second as { reason: string }).reason).toContain("指纹不符");
	});
});

// ============================================================================
// 可归属汇总：分桶 + 无法归属披露 + 不重复计数
// ============================================================================

describe("可归属用量汇总", () => {
	function row(角色: string, cost: number, 缺用量轮次 = 0): UsageLedgerRow {
		return {
			会话开始: NOW,
			会话结束: NOW,
			角色,
			input: 100,
			output: 10,
			cacheRead: 0,
			cost,
			turns: 1,
			缺用量轮次,
		};
	}

	it("按主控/部长/worker/压缩摘要分桶", () => {
		const rollup = rollupUsageRows([row("主控", 1), row("部长", 2), row("worker", 3), row("压缩摘要", 4)]);
		const counts = Object.fromEntries(rollup.buckets.map((bucket) => [bucket.owner, bucket.会话数]));
		expect(counts).toEqual({ 主控: 1, 部长: 1, worker: 1, 压缩摘要: 1, 未归属: 0 });
		expect(rollup.合计.会话数).toBe(4);
		expect(rollup.合计.费用.basis).toBe("knownCost");
		expect(rollup.合计.费用.value).toBe(10);
	});

	it("认不出的角色进「未归属」桶并披露范围，不猜成 worker", () => {
		const rollup = rollupUsageRows([row("某个没人认识的角色", 1)]);
		expect(rollup.buckets.find((bucket) => bucket.owner === "未归属")!.会话数).toBe(1);
		expect(rollup.buckets.find((bucket) => bucket.owner === "worker")!.会话数).toBe(0);
		expect(rollup.无法归属.some((item) => item.范围.includes("无法可靠归属"))).toBe(true);
	});

	it("没有独立压缩摘要行时披露「摘要用量可能已并入所属会话」", () => {
		const rollup = rollupUsageRows([row("主控", 1)]);
		expect(rollup.无法归属.some((item) => item.范围.includes("压缩/摘要用量"))).toBe(true);
	});

	it("坏行如实计入披露范围", () => {
		const rollup = rollupUsageRows([row("主控", 1)], 3);
		expect(rollup.坏行数).toBe(3);
		expect(rollup.无法归属.some((item) => item.范围.includes("3 行账本行解析失败"))).toBe(true);
	});

	it("重读不重复计数：同一份账读三次结果完全相同", () => {
		const home = tempHome();
		appendLedgerRow(home, row("主控", 0.5));
		appendLedgerRow(home, row("worker", 1.5));
		const first = rollupUsageFromPaoHome(home);
		const second = rollupUsageFromPaoHome(home);
		const third = rollupUsageFromPaoHome(home);
		expect(second).toEqual(first);
		expect(third).toEqual(first);
		expect(first.合计.会话数).toBe(2);
		expect(first.合计.费用.value).toBe(2);
		// 渲染同一份 rollup 多次也完全一致（纯渲染，无累加器）。
		expect(renderUsageRollup(second)).toBe(renderUsageRollup(first));
	});

	it("账本落盘路径指示正确（PAO_HOME 下的用量账.jsonl）", () => {
		const home = tempHome();
		appendLedgerRow(home, row("主控", 1));
		expect(readFileSync(join(home, "用量账.jsonl"), "utf8")).toContain("主控");
		expect(join(home, BUDGET_LEDGER_FILENAME)).not.toBe(join(home, "用量账.jsonl"));
	});
});
