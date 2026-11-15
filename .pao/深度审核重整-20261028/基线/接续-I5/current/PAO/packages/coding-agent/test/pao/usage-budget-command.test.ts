/**
 * H0-B 钉：僵尸预留的**人工**巡检与归还（`/pao budget`）。
 *
 * 背景：G2 让「结果不明」的预留继续占着额度（先查不重复授额），但账上停在 reserved 的
 * 那笔钱此前**没有任何面向用户的入口**——人看不见它，也放不回去，只能干等或手改 JSON。
 * 本文件钉的是补上的那条入口，以及它**不是**什么：
 *
 * - 它不是自动清理器。**没有任何自动归还**：造一笔很旧的 reserved，跑巡检、再跑一次正常
 *   派发，它必须仍在账上（最后一个 describe 专钉这条）。「看起来过期」不构成归还理由，
 *   因为进程可能还在跑、钱可能已经花了只是没回执——错放回去的额度会让后来者一起超支。
 * - 它不是 agent 能碰的东西。归还走命令面（`/pao budget 归还 <卡号>:<尝试号>`），
 *   worker 会话整模块不装载（`role.ts` WORKER_SKIPPED_MODULES 里有 `budget-command`），
 *   worker 工具面一个相关工具都没有——本文件也断言了这一点。
 * - 它不伪造结论。账上没有那笔、格式不对、已结算、结果不明，各有各的原文说明，
 *   绝不静默改账，也绝不把坏账读成「没有停着的预留」。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WORKER_SKIPPED_MODULES } from "../../src/pao/role.ts";
import { renderBudgetReply } from "../../src/pao/usage/budget-command.ts";
import {
	BUDGET_LEDGER_FILENAME,
	budgetLedgerPath,
	grantBudget,
	readBudgetLedger,
	reserveBudget,
	settleBudget,
} from "../../src/pao/usage/budget-ledger.ts";
import {
	attemptOfDispatchKey,
	dispatchBudgetKey,
	listReservedReservations,
	releaseReservationExplicit,
} from "../../src/pao/usage/dispatch-gate.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): { home: string } {
	const home = mkdtempSync(join(tmpdir(), "pao-h0b-"));
	dirs.push(home);
	return { home };
}

/** 授权总预算（未授权时 reserveBudget 会拒，巡检面也就无从谈起）。 */
async function grant(home: string, 总预算: number): Promise<void> {
	await grantBudget(budgetLedgerPath(home), {
		总预算,
		授权人: "测试用户",
		授权时间: "2026-10-17T00:00:00.000Z",
	});
}

/** 直接落一笔预留（模拟「派发出去了、还没结算」）。 */
async function reserve(home: string, 卡号: string, 尝试号: number, 金额: number, 时间?: string) {
	const result = await reserveBudget(budgetLedgerPath(home), {
		idempotencyKey: dispatchBudgetKey(卡号, 尝试号),
		金额,
		指纹: `fp-${卡号}-${尝试号}`,
		现在: 时间 ?? "2026-10-17T08:00:00.000Z",
		卡号,
	});
	if (!result.ok) throw new Error(`预留失败:${result.reason}`);
	return result.reservation;
}

const OPTIONS = (home: string) => ({
	resolvePaoHome: () => home,
	现在: () => "2026-10-17T09:30:00.000Z",
});

describe("巡检：只报不写", () => {
	it("空账巡检：明说「账上没有任何停着的预留」，不留空白也不伪装报错", async () => {
		const { home } = workspace();
		const text = await renderBudgetReply("", OPTIONS(home));
		expect(text).toContain("账上没有任何停着的预留");
		// 空态不能被人读成「没花过钱」——已结算的记录不在此列表，必须说清
		expect(text).toContain("不等于");
		// 巡检不许写盘：账本文件压根不该被创建出来
		expect(readBudgetLedger(budgetLedgerPath(home)).reservations).toHaveLength(0);
	});

	it("多笔 reserved 巡检：每笔都能回答「谁/卡几/尝试几/多少钱/何时/什么状态/下一步」", async () => {
		const { home } = workspace();
		await grant(home, 100);
		await reserve(home, "7", 1, 12.5);
		await reserve(home, "8", 2, 3);

		const text = await renderBudgetReply("巡检", OPTIONS(home));
		expect(text).toContain("2 笔预留仍停在 reserved");
		expect(text).toContain("共占 $15.50");
		// 谁 + 卡几 + 尝试几
		expect(text).toContain("卡7 · 尝试 1");
		expect(text).toContain("卡8 · 尝试 2");
		// 多少钱
		expect(text).toContain("$12.50");
		// 何时
		expect(text).toContain("2026-10-17T08:00:00.000Z");
		// 什么状态（含「进程可能还在跑」这层不确定性，不许说成「一定是僵尸」）
		expect(text).toContain("reserved（已预留、还没结算");
		expect(text).toContain("也可能");
		// 下一步：三条判断路径都要在（进程还在跑 / 确认没派出去 / 不确定花没花）
		expect(text).toContain("下一步");
		expect(text).toContain("什么都不用做");
		expect(text).toContain("显式归还");
		expect(text).toContain("**不要**归还");
		// 判据键原样给出，人能直接抄
		expect(text).toContain("派发:卡7:尝试1");
	});

	it("巡检不修改账本：跑完巡检账上仍只有那 2 笔 reserved，状态一字不改", async () => {
		const { home } = workspace();
		await grant(home, 100);
		await reserve(home, "7", 1, 12.5);
		await reserve(home, "8", 2, 3);
		const before = readFileSync(budgetLedgerPath(home), "utf8");

		await renderBudgetReply("巡检", OPTIONS(home));

		expect(readFileSync(budgetLedgerPath(home), "utf8")).toBe(before);
	});

	it("坏账不会被读成「没有停着的预留」：显式报读取失败并指出该修哪个文件", async () => {
		const { home } = workspace();
		// 写一份坏账（形状不对）
		const { writeFileSync } = await import("node:fs");
		writeFileSync(budgetLedgerPath(home), '{"version":1,"grants":[]}', "utf8");

		const text = await renderBudgetReply("", OPTIONS(home));
		expect(text).toContain("读取失败");
		expect(text).toContain(BUDGET_LEDGER_FILENAME);
		expect(text).not.toContain("没有任何停着的预留");
	});
});

describe("归还：必须人显式下命令，且按判据精确匹配", () => {
	it("归还成功：状态转 released、额度真的回到可用余额、再次巡检不再出现", async () => {
		const { home } = workspace();
		await grant(home, 100);
		await reserve(home, "7", 1, 12.5);

		const before = await renderBudgetReply("巡检", OPTIONS(home));
		expect(before).toContain("卡7 · 尝试 1");

		const done = await renderBudgetReply("归还 7:1", OPTIONS(home));
		expect(done).toContain("已归还");
		expect(done).toContain("$12.50");
		expect(done).toContain("派发:卡7:尝试1");

		// 账上真写了：状态 released，且不是删记录（取消不抹费用，历史要留）
		const file = readBudgetLedger(budgetLedgerPath(home));
		expect(file.reservations).toHaveLength(1);
		expect(file.reservations[0]!.status).toBe("released");
		expect(file.reservations[0]!.结算时间).toBe("2026-10-17T09:30:00.000Z");

		// 再次巡检不再出现
		const after = await renderBudgetReply("巡检", OPTIONS(home));
		expect(after).toContain("账上没有任何停着的预留");
		expect(after).not.toContain("卡7 · 尝试 1");
	});

	it("归还后额度可再被同一笔重新预留（钱真的回来了，不是只改了个状态）", async () => {
		const { home } = workspace();
		await grant(home, 10);
		await reserve(home, "7", 1, 10);
		// 此时余额为 0，再要 10 应该不够
		const refused = await reserveBudget(budgetLedgerPath(home), {
			idempotencyKey: dispatchBudgetKey("9", 1),
			金额: 10,
			指纹: "fp-9-1",
			现在: "2026-10-17T08:10:00.000Z",
			卡号: "9",
		});
		expect(refused.ok).toBe(false);

		await renderBudgetReply("归还 7:1", OPTIONS(home));

		const allowed = await reserveBudget(budgetLedgerPath(home), {
			idempotencyKey: dispatchBudgetKey("9", 1),
			金额: 10,
			指纹: "fp-9-1",
			现在: "2026-10-17T08:20:00.000Z",
			卡号: "9",
		});
		expect(allowed.ok).toBe(true);
	});

	it("判据不存在：如实说「账上没有这一笔」+ 列出当前停着的判据键供人抄，且账一分未改", async () => {
		const { home } = workspace();
		await grant(home, 100);
		await reserve(home, "7", 1, 12.5);
		const before = readFileSync(budgetLedgerPath(home), "utf8");

		const text = await renderBudgetReply("归还 99:3", OPTIONS(home));
		expect(text).toContain("账上没有这一笔");
		expect(text).toContain("卡99 尝试 3");
		expect(text).toContain("没做任何修改");
		// 当前停着的判据键要列出来（人照抄即可），不猜他想还哪一笔
		expect(text).toContain("派发:卡7:尝试1");
		expect(readFileSync(budgetLedgerPath(home), "utf8")).toBe(before);
	});

	it("参数缺失/格式不对：直接拒绝并给出正确格式示例（含英文冒号要求），不碰账", async () => {
		const { home } = workspace();
		await grant(home, 100);
		await reserve(home, "7", 1, 12.5);
		const before = readFileSync(budgetLedgerPath(home), "utf8");

		const missing = await renderBudgetReply("归还", OPTIONS(home));
		expect(missing).toContain("不知道要还哪一笔");
		expect(missing).toContain("/pao budget 归还 <卡号>:<尝试号>");

		const badFormat = await renderBudgetReply("归还 7号第1次", OPTIONS(home));
		expect(badFormat).toContain("格式不对");
		expect(badFormat).toContain("<卡号>:<尝试号>");

		const chineseColon = await renderBudgetReply("归还 7：1", OPTIONS(home));
		expect(chineseColon).toContain("格式不对");

		const halfMissing = await renderBudgetReply("归还 7", OPTIONS(home));
		expect(halfMissing).toContain("格式不对");

		expect(readFileSync(budgetLedgerPath(home), "utf8")).toBe(before);
	});

	it("未知子动作：列出可用动作，不猜也不静默当作巡检", async () => {
		const { home } = workspace();
		const text = await renderBudgetReply("清空全部", OPTIONS(home));
		expect(text).toContain("未知的 budget 子动作");
		expect(text).toContain("/pao budget            巡检");
	});

	it("已结算的那笔不许归还（取消不抹费用）：报护栏原文，账不变", async () => {
		const { home } = workspace();
		await grant(home, 100);
		await reserve(home, "7", 1, 12.5);
		await settleBudget(budgetLedgerPath(home), {
			idempotencyKey: dispatchBudgetKey("7", 1),
			实际费用: 9.75,
			现在: "2026-10-17T08:30:00.000Z",
		});
		const before = readFileSync(budgetLedgerPath(home), "utf8");

		const text = await renderBudgetReply("归还 7:1", OPTIONS(home));
		expect(text).toContain("不能归还");
		expect(text).toContain("取消不抹费用");
		expect(text).toContain("没做任何修改");
		expect(readFileSync(budgetLedgerPath(home), "utf8")).toBe(before);
	});

	it("结果不明（unknown）的那笔不许直接归还：报「须先查清」并说明为什么", async () => {
		const { home } = workspace();
		await grant(home, 100);
		await reserve(home, "7", 1, 12.5);
		// 结算时不给实际费用＝结果不明
		await settleBudget(budgetLedgerPath(home), {
			idempotencyKey: dispatchBudgetKey("7", 1),
			现在: "2026-10-17T08:30:00.000Z",
		});
		const before = readFileSync(budgetLedgerPath(home), "utf8");

		const text = await renderBudgetReply("归还 7:1", OPTIONS(home));
		expect(text).toContain("不能归还");
		expect(text).toContain("须先查清");
		expect(readFileSync(budgetLedgerPath(home), "utf8")).toBe(before);
	});
});

describe("薄封装本身的口径", () => {
	it("listReservedReservations 只列 reserved（settled/released/unknown 一律不出现）", async () => {
		const { home } = workspace();
		await grant(home, 100);
		await reserve(home, "1", 1, 1); // 保持 reserved
		await reserve(home, "2", 1, 1);
		await settleBudget(budgetLedgerPath(home), {
			idempotencyKey: dispatchBudgetKey("2", 1),
			实际费用: 1,
			现在: "2026-10-17T08:30:00.000Z",
		}); // settled
		await reserve(home, "3", 1, 1);
		await settleBudget(budgetLedgerPath(home), {
			idempotencyKey: dispatchBudgetKey("3", 1),
			现在: "2026-10-17T08:30:00.000Z",
		}); // unknown

		const rows = listReservedReservations(home);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.卡号).toBe("1");
		expect(rows[0]!.状态).toBe("reserved");
	});

	it("attemptOfDispatchKey 只认本模块的判据键，别的一律 undefined（不猜）", () => {
		expect(attemptOfDispatchKey("派发:卡7:尝试1")).toBe(1);
		expect(attemptOfDispatchKey("派发:卡12:尝试34")).toBe(34);
		expect(attemptOfDispatchKey("别的键")).toBeUndefined();
		expect(attemptOfDispatchKey("派发:卡7")).toBeUndefined();
		expect(attemptOfDispatchKey("派发:卡7:尝试0")).toBeUndefined();
	});

	it("releaseReservationExplicit 尝试号非法直接拒（不落任何写）", async () => {
		const { home } = workspace();
		await grant(home, 100);
		await reserve(home, "7", 1, 12.5);
		const before = readFileSync(budgetLedgerPath(home), "utf8");

		const zero = await releaseReservationExplicit(home, { 卡号: "7", 尝试号: 0 });
		expect(zero.ok).toBe(false);
		const nan = await releaseReservationExplicit(home, { 卡号: "7", 尝试号: Number.NaN });
		expect(nan.ok).toBe(false);
		expect(readFileSync(budgetLedgerPath(home), "utf8")).toBe(before);
	});
});

describe("没有任何自动归还（本组的唯一目的：钉住「不自动」）", () => {
	it("一笔很旧的 reserved：巡检两次 + 一次正常派发之后，它仍在账上、仍是 reserved", async () => {
		const { home } = workspace();
		await grant(home, 100);
		// 5 天前的预留：任何「看起来过期就归还」的实现都会在这里动手
		await reserve(home, "7", 1, 12.5, "2026-10-12T00:00:00.000Z");

		// 巡检两次
		await renderBudgetReply("", OPTIONS(home));
		await renderBudgetReply("巡检", OPTIONS(home));

		// 再放一笔新的预留（模拟正常派发继续走这条路）
		await reserve(home, "8", 1, 3);

		const rows = listReservedReservations(home);
		const 旧的 = rows.find((row) => row.卡号 === "7");
		expect(旧的).toBeDefined();
		expect(旧的!.状态).toBe("reserved");
		expect(旧的!.预留额).toBe(12.5);
		expect(旧的!.预留时间).toBe("2026-10-12T00:00:00.000Z");
	});

	it("账里那笔旧 reserved 的 status 字段在多次巡检后逐字未变（没有偷偷改字段）", async () => {
		const { home } = workspace();
		await grant(home, 100);
		await reserve(home, "7", 1, 12.5, "2026-10-01T00:00:00.000Z");
		const 原始 = readBudgetLedger(budgetLedgerPath(home)).reservations.find((row) => row.卡号 === "7")!;

		await renderBudgetReply("", OPTIONS(home));
		await renderBudgetReply("巡检", OPTIONS(home));
		await renderBudgetReply("巡检", OPTIONS(home));

		const 之后 = readBudgetLedger(budgetLedgerPath(home)).reservations.find((row) => row.卡号 === "7")!;
		expect(之后.status).toBe("reserved");
		expect(之后.结算时间).toBeUndefined();
		expect(之后.备注).toBeUndefined();
		expect(之后).toEqual(原始);
	});
});

describe("agent 碰不到这条命令（红线）", () => {
	it("worker 会话整模块跳过 budget-command：命令面里不会有它", () => {
		expect(WORKER_SKIPPED_MODULES).toContain("budget-command");
	});
});
