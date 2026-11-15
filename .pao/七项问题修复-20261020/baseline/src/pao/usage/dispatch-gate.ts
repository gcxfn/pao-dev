/**
 * 派发边界的总预算门禁（计划 §8.2）。
 *
 * 分工（同一规则只实现一次）：
 * - `usage/budget-ledger.ts`：**钱**的账（用户显式给的总预算、预留、结算、归还）。
 * - `runtime/shared-budget.ts`：**并发名额**的账（既有实现，`reserveSharedRequest`）。
 * - 本模块：把两者在"派发前"这个边界上串起来，并给出明确的三态判定。
 *
 * 为什么不让它持有状态：门禁必须是**无状态**的——所有事实都在盘上。
 * 这样"重启能核原请求"就是天然成立的（新进程读同一份账，得到同样的结论）。
 */
import { createHash } from "node:crypto";

import { reserveSharedRequest, type SharedBudgetConfig } from "../runtime/shared-budget.ts";
import {
	BudgetLedgerError,
	budgetLedgerPath,
	currentGrant,
	inspectReservation,
	releaseBudget,
	remainingBudget,
	reserveBudget,
	readBudgetLedger,
	settleBudget,
	type BudgetReservation,
} from "./budget-ledger.ts";

/** 派发门禁的判定结果。 */
export type DispatchBudgetVerdict =
	/** 通过：已预留下钱（并占住并发名额）。 */
	| {
			ok: true;
			/** 本次预留记录（重启后按同一判据能查到）。 */
			reservation: BudgetReservation;
			/** 释放并发名额（会话结束/派发失败时调用；幂等）。 */
			releaseSlot: () => Promise<void>;
	  }
	/** 不许派发：`reason` 是给用户看的真实原因，`kind` 供调用方决定后续动作。 */
	| { ok: false; kind: "未授权" | "额度不足" | "结果不明" | "并发已满" | "参数无效"; reason: string };

/** 门禁入参。 */
export interface DispatchBudgetInput {
	/** PAO_HOME（账本落在这里）。 */
	paoHome: string;
	/**
	 * 请求判据：同一判据的重复派发必须复用同一条预留（不重复授额）。
	 * 调用方用 `fingerprintRequest` 算，或自己给稳定串。
	 */
	idempotencyKey: string;
	/** 本次要预留多少钱（美元）。0 表示"只在用完时拦"的软门禁。 */
	金额: number;
	/** 内容指纹：同一判据不同内容会被拒（防止不同任务被当成同一条）。 */
	指纹: string;
	/** 现在（ISO）。由调用方给，便于测试与归档一致性。 */
	现在: string;
	/** 卡号（可空）。 */
	卡号?: string;
	/**
	 * 共享并发名额配置。不给 = 不检查并发名额（只查钱）。
	 * 给了就复用既有 `reserveSharedRequest` 的原子计次与 ESRCH 清理，不另写一套。
	 */
	并发名额?: SharedBudgetConfig;
}

/**
 * 派发前的总预算检查 + 预留。
 *
 * 顺序是刻意的：**先查结果不明的同判据请求，再看余额**。
 * 因为"上次这条请求结果不明"时，那笔钱还占着——先查能给出准确原因（"先查"），
 * 而不是笼统报"额度不足"。
 *
 * 并发不重复授额由 `reserveBudget` 的文件锁保证（见该函数注释）：检查与写在同一个锁内，
 * 两个并发请求会在锁上排队，后到的只看得到扣掉前者之后的余额。
 */
export async function checkDispatchBudget(input: DispatchBudgetInput): Promise<DispatchBudgetVerdict> {
	const path = budgetLedgerPath(input.paoHome);
	let 名额释放: (() => Promise<void>) | undefined;
	try {
		// ① 先查原请求（重启后也走这条路）：同判据已有预留时的行为。
		const existing = inspectReservation(input.paoHome, input.idempotencyKey);
		if (existing.state === "unknown") {
			return {
				ok: false,
				kind: "结果不明",
				reason: `该请求上次结果不明（预留 $${existing.reservation.预留额.toFixed(2)} 仍占额度）：先查清结果再重派，不重复授额`,
			};
		}
		if (existing.state === "settled") {
			return {
				ok: false,
				kind: "结果不明",
				reason: `该请求已经结算过（$${(existing.reservation.已结算费用 ?? 0).toFixed(2)}）：不重复受理，换新判据才能重派`,
			};
		}
		// ② 并发名额（复用既有实现：它在发送前永久计次，失败/取消不退次）。
		if (input.并发名额) {
			try {
				名额释放 = await reserveSharedRequest(input.并发名额);
			} catch (error) {
				const message = (error as Error).message;
				return {
					ok: false,
					kind: message.includes("并发名额已满") ? "并发已满" : "额度不足",
					reason: message,
				};
			}
		}
		// ③ 钱的预留（锁内检查+写，并发不重复授额）。
		const reserved = await reserveBudget(path, {
			idempotencyKey: input.idempotencyKey,
			金额: input.金额,
			指纹: input.指纹,
			现在: input.现在,
			...(input.卡号 ? { 卡号: input.卡号 } : {}),
		});
		if (!reserved.ok) {
			await 名额释放?.();
			名额释放 = undefined;
			const 未授权 = reserved.reason.includes("未显式给总预算");
			return { ok: false, kind: 未授权 ? "未授权" : "额度不足", reason: reserved.reason };
		}
		return { ok: true, reservation: reserved.reservation, releaseSlot: async () => 名额释放?.() };
	} catch (error) {
		// 账坏了/锁超时/参数不合法：一律不派发（fail-closed），并释放已占的并发名额。
		await 名额释放?.().catch(() => undefined);
		return { ok: false, kind: "参数无效", reason: String(error) };
	}
}

/** 派发成功、拿到真实用量后结算。`实际费用` 为 undefined = 费用未知（状态记 unknown，钱继续占着）。 */
export async function settleDispatchBudget(input: {
	paoHome: string;
	idempotencyKey: string;
	实际费用?: number;
	现在: string;
	备注?: string;
}): Promise<BudgetReservation> {
	return settleBudget(budgetLedgerPath(input.paoHome), {
		idempotencyKey: input.idempotencyKey,
		...(input.实际费用 === undefined ? {} : { 实际费用: input.实际费用 }),
		现在: input.现在,
		...(input.备注 ? { 备注: input.备注 } : {}),
	});
}

/** 明确未受理（派发前就被拒）：把钱还回去。 */
export async function releaseDispatchBudget(input: {
	paoHome: string;
	idempotencyKey: string;
	现在: string;
	备注?: string;
}): Promise<BudgetReservation | undefined> {
	return releaseBudget(budgetLedgerPath(input.paoHome), input);
}

/** 当前余额概览（只读）：未授权时 `enabled:false`，**不返回 0 假装额度是零**。 */
export function readBudgetStatus(paoHome: string): {
	enabled: boolean;
	总预算?: number;
	已占?: number;
	剩余?: number;
	版本?: number;
	说明: string;
} {
	const file = readBudgetLedger(budgetLedgerPath(paoHome));
	const grant = currentGrant(file);
	if (!grant) {
		return { enabled: false, 说明: "用户未显式给总预算：跨任务额度未启用（不凭空设默认限额）" };
	}
	const 剩余 = remainingBudget(file) ?? 0;
	const 已占 = grant.总预算 - 剩余;
	return {
		enabled: true,
		总预算: grant.总预算,
		已占,
		剩余,
		版本: grant.version,
		说明: `版本 ${grant.version} 总预算 $${grant.总预算.toFixed(2)}（授权人 ${grant.授权人}，授权于 ${grant.授权时间}）`,
	};
}

export type { SharedBudgetConfig } from "../runtime/shared-budget.ts";

// ============================================================================
// 派发侧门禁工厂（G4 首版写在 worker/index.ts；H0 搬到此处，因为 fansout/自动链
// 需要共用同一个工厂，而它们与 worker/index.ts 已存在 fanout→worker 的依赖方向，
// 反向 import 会成环。搬动是零逻辑变更：判据与文案仍只有一份。）
// ============================================================================

/**
 * 派发的总预算判据（一段纯函数，**门禁预留与完成结算必须用同一份**，
 * 否则结算会找不到那条预留——这正是"同一规则只实现一次"要防的）。
 */
export function dispatchBudgetKey(卡号: string, 尝试号: number): string {
	return `派发:卡${卡号}:尝试${尝试号}`;
}

/** 门禁拒绝时给用户的下一步（每种拒绝都要有出路，不能只说"不行"）。 */
export const BUDGET_REFUSAL_NEXT: Record<string, string> = {
	未授权: "让用户显式给总预算后才能派发；单卡预算不受影响",
	额度不足: "等额度或让用户显式加额度；也可先查总预算账里被谁占着",
	结果不明: "先查清那笔请求的真实结果再重派，不要直接加额度绕过",
	并发已满: "等前面的请求收跑，或调大上游并发上限",
	参数无效: "核对总预算账文件是否完好，修好再试",
};

/** dispatch-core 的门禁结果形状（`ExecuteDispatchOptions.预算门禁` 的返回类型）。 */
export type DispatchBudgetGateResult =
	/** 放行：`commit` 在即将拉起 runner 前调用；`release` 在确定没开跑时归还。 */
	| {
			ok: true;
			/** 预留判据/身份说明（进通知与回执，便于人对照账本）。 */
			说明?: string;
			commit: () => Promise<void>;
			release: () => Promise<void>;
	  }
	/** 拒绝：`reason` 是给用户看的真实原因（含下一步）。 */
	| { ok: false; reason: string };

/**
 * 派发要走的总预算门禁（计划 §8.2）：**没授权总预算时返回 undefined**。
 *
 * 为什么用"不注入"来表达"未启用"：dispatch-core 里门禁是可选钩子，
 * 不注入就完全跳过那一段——于是"用户没给总预算"时行为与接线前逐字一致，
 * 不存在"默认限额"这种东西，也不多读一次盘。这就是"零行为变化"。
 *
 * 判据（`idempotencyKey`）：同一张卡的同一个尝试号＝同一笔请求。
 * 这样同一卡同尝试的并发重派只会在账上留一条预留（复用而不是再扣一份），
 * 换尝试号（重开）才是新的一笔——与卡状态机的尝试语义对齐。
 *
 * 金额：卡的每卡预算 `budget.cost` 就是这次派发**最多可能花多少**，用它做预留额；
 * 没写每卡预算时按 0 预留（= 软门禁，只靠"总额已被占满"来拦），不凭空捏一个数。
 *
 * 三处装配（单卡/扇出/自动链）共用本函数，所以判据与拒绝文案不可能分叉。
 * `paoHome` 收字符串而非取 home 的函数：三个装配点在调用时都已拿到确定值
 * （各自都有 resolveHome 口径，惰性算一次即可），函数签名越窄越不容易被绕开。
 * 另注意：本函数**不需要** cardsDir（G4 首版带这个入参但内部从未使用，已删——
 * 不是漏传，是真的用不上：门禁只看 home、卡对象与尝试号）。
 */
export function buildDispatchBudgetGate(input: {
	paoHome: string | undefined;
	/** 现在（ISO 生成器）；缺省 `new Date()`，测试注入固定时间用。 */
	现在?: () => string;
}): ((card: { card_no: number | string; frontmatter: { budget?: { cost?: number }; goal?: string } }, 尝试号: number) => Promise<DispatchBudgetGateResult>) | undefined {
	const home = input.paoHome;
	if (!home) return undefined;
	const now = input.现在 ?? (() => new Date().toISOString());
	// 未授权总预算 = 跨任务额度未启用：不注入门禁（零行为变化，见上方注释）。
	let enabled: boolean;
	try {
		enabled = readBudgetStatus(home).enabled;
	} catch (error) {
		// 账坏了不静默放行:如实拒派并说明该修哪个文件（宁可少派一次,也不悄悄绕过总预算）。
		const reason = error instanceof Error ? error.message : String(error);
		return async () => ({
			ok: false,
			reason: `总预算账读不了（拒绝在账不明的情况下派发）：${reason}；请修好 ${budgetLedgerPath(home)} 或显式重新授权`,
		});
	}
	if (!enabled) return undefined;
	return async (card, 尝试号) => {
		const 卡号 = String(card.card_no).padStart(4, "0");
		const 金额 = card.frontmatter.budget?.cost ?? 0;
		const 指纹 = createHash("sha256")
			.update(JSON.stringify({ 卡号, 尝试号, 目标: card.frontmatter.goal }), "utf8")
			.digest("hex");
		const verdict = await checkDispatchBudget({
			paoHome: home,
			idempotencyKey: dispatchBudgetKey(卡号, 尝试号),
			金额,
			指纹,
			现在: now(),
			卡号,
		});
		if (!verdict.ok) return { ok: false, reason: `${verdict.reason}（下一步：${BUDGET_REFUSAL_NEXT[verdict.kind]}）` };
		return {
			ok: true,
			commit: async () => {
				// 预留已在 reserveBudget 落盘（status=reserved）；这里不再重复写：
				// 真正落地由完成回调用同一判据 settle（按真实用量）。若中途进程崩掉，
				// 账上停在 reserved＝"占着但不知结果"，重启后可由人用 inspectReservation 核对。
			},
			release: async () => {
				await releaseDispatchBudget({
					paoHome: home,
					idempotencyKey: dispatchBudgetKey(卡号, 尝试号),
					现在: now(),
					备注: "派发前未开跑（认领失败/提交失败），预留额全额归还",
				});
				await verdict.releaseSlot();
			},
		};
	};
}

/**
 * 完成回调里的结算（G4）。
 *
 * 关键口径（计划 §8.2 + G2 定案）：
 * - 有真实费用 → 按它结算（`settleDispatchBudget`），差额自动归还；
 * - **该轮缺 usage 或用量来源未知 → 实际费用留 undefined**，G2 记「结果不明」，预留额继续占着。
 *   这是硬红线：未知不能填 0 冒充"没花钱"。
 * - 结算本身失败（账坏了/没找到那条预留）不推翻派发结果——卡状态与回执才是真相，
 *   但要把说明写进回执文本，让人知道钱没结上。
 *
 * 返回一句给人看的说明（无异常时 undefined）。
 */
export function settleDispatchBudgetQuietly(input: {
	paoHome: string | undefined;
	卡号: string;
	尝试号: number;
	/** 回执里缺 usage 的轮次数（>0 即真实费用不可信）。 */
	缺账轮次: number;
	/** 回执声明的费用（undefined＝回执不带 usage）。 */
	实际费用: number | undefined;
	现在?: () => string;
}): Promise<string | undefined> | undefined {
	const home = input.paoHome;
	if (!home) return undefined;
	const now = input.现在 ?? (() => new Date().toISOString());
	return (async (): Promise<string | undefined> => {
		// 没授权总预算 = 这道门禁从未启用过,账上也没有这次派发的预留——
		// 不在这里尝试结算（否则每次派发都会冒一条"没有预留记录"的假警告）。
		let enabled: boolean;
		try {
			enabled = readBudgetStatus(home).enabled;
		} catch {
			// 账坏了:门禁那边已经会拒派,这里不再叠加噪声（真出问题在门禁处就有明确原因）。
			return undefined;
		}
		if (!enabled) return undefined;
		// 该轮有缺 usage 的轮次＝这次的真实费用不可信（可能少算），按"未知"记，不按收到的部分当全部。
		const 缺账轮次 = input.缺账轮次;
		const 实际费用 = 缺账轮次 > 0 ? undefined : input.实际费用;
		try {
			const settled = await settleDispatchBudget({
				paoHome: home,
				idempotencyKey: dispatchBudgetKey(input.卡号, input.尝试号),
				...(实际费用 === undefined ? {} : { 实际费用 }),
				现在: now(),
			});
			return 实际费用 === undefined
				? `总预算结算:费用未知(${缺账轮次 > 0 ? `有 ${缺账轮次} 轮没回 usage` : "回执未带 usage"}),预留额 $${settled.预留额.toFixed(2)} 继续占着——先查清再结算,不重复授额`
				: undefined;
		} catch (error) {
			return `总预算结算失败（派发结果不受影响,但钱没结上,请核对总预算账）:${
				error instanceof Error ? error.message : String(error)
			}`;
		}
	})();
}

// ══════════════════════════════════════════════════════════════════════════
// 僵尸预留的人工巡检面（H0-B）
//
// 「僵尸预留」＝账上停在 reserved、实际那个进程早就没了的那笔钱。它必须一直占着额度
// （G2：结果不明先不重复授额），但**必须有人能看见它、并显式决定要不要归还**。
//
// 三条纪律（缺一条就会变成悄悄超支的通道）：
// 1. **本模块不做任何过期推断**。只有 `预留时间` 是事实，`现在 - 预留时间 > X` 不是
//    「可以归还」的证据——进程可能还在跑，只是慢。所以这里只提供「列出来」和「按人明确
//    命令归还」，绝不提供「自动归还看起来过期的」。
// 2. **归还只按判据精确匹配**（卡号+尝试号），不做模糊/批量；找不到就如实说没有，
//    并把当前停着的判据键列出来让人自己抄，不猜他想还哪一笔。
// 3. **写盘复用 `budget-ledger.ts` 的加锁+原子写与既有护栏**（已结算/结果不明一律抛），
//    本模块不另写一套落盘，否则两套并发语义迟早冲突。
// ══════════════════════════════════════════════════════════════════════════

/** 巡检返回的一条停着的预留（只读事实，不含任何推断）。 */
export interface ReservedReservationRow {
	/** 判据键（原样给人抄，归还时按它精确匹配）。 */
	idempotencyKey: string;
	/** 这张卡（可能为空：总量预留可先于具体卡）。 */
	卡号?: string;
	/** 从判据键解析出的尝试号（解析不出为 undefined——不猜）。 */
	尝试号?: number;
	/** 预留金额（美元）。 */
	预留额: number;
	/** 预留发生时刻（ISO）。 */
	预留时间: string;
	/** 当前状态：本函数只返回 reserved，保留字段是为了调用方不必按函数名猜。 */
	状态: "reserved";
}

/** 从 `派发:卡0007:尝试2` 这样的判据键里取尝试号；不是本模块产出的判据键返回 undefined。 */
export function attemptOfDispatchKey(idempotencyKey: string): number | undefined {
	const matched = /^派发:卡(\d+):尝试(\d+)$/.exec(idempotencyKey.trim());
	if (!matched) return undefined;
	const 尝试号 = Number(matched[2]);
	return Number.isSafeInteger(尝试号) && 尝试号 > 0 ? 尝试号 : undefined;
}

/**
 * 巡检：列出账上所有停在 `reserved` 的预留。**纯读，不写盘，不做任何过期判断**。
 *
 * 为什么不复用 `readBudgetStatus`：那个回答「还剩多少钱」，不回答「谁占着、占多久了」。
 * 巡检要答的是后者——人看到一条 3 小时前的 reserved 才能判出来是崩了还是还在跑。
 *
 * 账本不存在（从未授权）→ 返回空数组，不抛；账本坏了 → 照 `readBudgetLedger` 抛
 * （坏账必须显式失败，不能伪装成"没有停着的预留"）。
 */
export function listReservedReservations(paoHome: string): ReservedReservationRow[] {
	const file = readBudgetLedger(budgetLedgerPath(paoHome));
	return file.reservations
		.filter((reservation) => reservation.status === "reserved")
		.map((reservation) => ({
			idempotencyKey: reservation.idempotencyKey,
			卡号: reservation.卡号,
			尝试号: attemptOfDispatchKey(reservation.idempotencyKey),
			预留额: reservation.预留额,
			预留时间: reservation.预留时间,
			状态: "reserved" as const,
		}));
}

/** 人工归还的结果：要么真写了，要么如实说清为什么没写。 */
export type ReleaseExplicitResult =
	/** 归还成功（`reservation` 是写盘后的记录，status 已是 released）。 */
	| { ok: true; reservation: BudgetReservation }
	/** 账上没有这一笔：`reservedKeys` 是当前停着的判据键，供人抄。 */
	| { ok: false; kind: "没有这笔预留"; reservedKeys: string[] }
	/** 这一笔不许归还（已结算/结果不明）：`reason` 是账本护栏的原文。 */
	| { ok: false; kind: "不许归还"; reason: string }
	/** 账坏/锁超时/写失败：`reason` 原文抛出内容，`code` 便于调用方分流。 */
	| { ok: false; kind: "写盘失败"; reason: string; code: string };

/**
 * 人工归还一笔派发预留：**只按 (卡号, 尝试号) 精确匹配判据**，不做任何推断。
 *
 * 为什么必须由人显式下命令：归还会把额度放回去，如果判断错了（其实进程还在跑、
 * 钱已经花了只是没回执），放回去的额度会让后来者一起超支。所以「看起来过期」永远
 * 不构成归还理由——只有人知道那次派发到底怎么了。
 *
 * 落盘复用 `budget-ledger.ts` 的 `releaseBudget`（加锁 + 原子写 + 既有护栏）：
 * 已结算 → 抛「不能归还——取消不抹费用」；结果不明 → 抛「须先查清」。
 * 写盘失败 → 抛，原记录原样留在盘上（原子写保证不会写出半份账）。
 */
export async function releaseReservationExplicit(
	paoHome: string,
	input: { 卡号: string; 尝试号: number; 现在?: string; 备注?: string },
): Promise<ReleaseExplicitResult> {
	const 卡号 = input.卡号.trim();
	const 尝试号 = input.尝试号;
	if (!卡号) return { ok: false, kind: "写盘失败", reason: "缺卡号：归还必须指明是哪张卡", code: "BAD_INPUT" };
	if (!Number.isSafeInteger(尝试号) || 尝试号 <= 0) {
		return {
			ok: false,
			kind: "写盘失败",
			reason: `尝试号须为正整数：${String(input.尝试号)}（格式 <卡号>:<尝试号>，如 7:1）`,
			code: "BAD_INPUT",
		};
	}
	const idempotencyKey = dispatchBudgetKey(卡号, 尝试号);
	const now = input.现在 ?? new Date().toISOString();
	try {
		const released = await releaseBudget(budgetLedgerPath(paoHome), {
			idempotencyKey,
			现在: now,
			备注: input.备注 ?? "用户显式归还（人工巡检：确认该次派发未受理，额度放回）",
		});
		if (!released) {
			// 账上没有这一笔：如实报，并把当前停着的判据键交出去让人自己抄，不猜他想还哪一笔。
			return { ok: false, kind: "没有这笔预留", reservedKeys: listReservedReservations(paoHome).map((row) => row.idempotencyKey) };
		}
		return { ok: true, reservation: released };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		const code = error instanceof BudgetLedgerError ? error.code : "UNKNOWN";
		// 账本护栏（已结算/结果不明）是"不许归还"，与"写盘/锁坏了"要分开报——
		// 前者是正常业务结论（人该改主意或先查清），后者是该修文件。
		if (code === "BAD_LEDGER" && /不能归还|不许直接归还/.test(reason)) {
			return { ok: false, kind: "不许归还", reason };
		}
		return { ok: false, kind: "写盘失败", reason, code };
	}
}
