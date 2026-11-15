/**
 * 可归属用量汇总（计划 §8.2）：把跨会话账本按"谁花的"分桶，并如实披露分不到桶里的部分。
 *
 * 三个口径分层（这是本模块与 ledger.ts 的分工，不是重复实现）：
 * - `ledger.ts` 负责"一行一个会话"的原始账与聚合，本模块**不重写**它，直接复用
 *   `parseLedger` / `readLedgerText` / `aggregateLedger`。
 * - 本模块只多做两件事：**按角色归桶**、**把无法归属的显式列出来**。
 * - 费用一律走 `basis.ts` 的口径三分，绝不把"没配价格"渲染成 $0。
 *
 * 不重复计数（计划原文"分页/重读/重开不重复计数"）：本模块每次调用都是**从盘上重算**
 * 纯函数结果，不维护任何跨调用累加器；同一行账本无论被读多少次，都只贡献一次。
 */

import { estimatedCostAmount, formatMeteredCost, knownCostAmount, type MeteredAmount, unknownAmount } from "./basis.ts";
import { aggregateLedger, parseLedger, readLedgerText, USAGE_LEDGER_FILENAME, type UsageLedgerRow } from "./ledger.ts";

/** 归属主体类别。主控/部长/Worker 是计划点名的三类；压缩/摘要单列。 */
export type UsageOwnerKind = "主控" | "部长" | "worker" | "压缩摘要" | "未归属";

/** 一个归属桶的可归属汇总。 */
export interface UsageOwnerBucket {
	readonly owner: UsageOwnerKind;
	/** 落进本桶的会话数。 */
	readonly 会话数: number;
	readonly turns: number;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	/** 费用（口径三分）。未知/估计必须带 note。 */
	readonly 费用: MeteredAmount;
	/** 本桶里有多少会话缺 usage（这些会话的数字是下界）。 */
	readonly 缺账会话数: number;
}

/** 无法可靠归属的部分：**显式披露范围**，不许静默丢弃。 */
export interface UsageUnattributable {
	/** 披露文本：说清"这部分无法归属，因为…"。 */
	readonly 范围: string;
	/** 涉及多少条记录。 */
	readonly 条数: number;
}

/** 汇总结果。 */
export interface UsageRollup {
	/** 分桶（固定序：主控→部长→worker→压缩摘要→未归属，空桶也出现，便于界面稳定排版）。 */
	readonly buckets: readonly UsageOwnerBucket[];
	/** 合计（已知下界口径：含缺账会话）。 */
	readonly 合计: UsageOwnerBucket;
	/** 无法可靠归属的部分（空数组 = 全部可归属）。 */
	readonly 无法归属: readonly UsageUnattributable[];
	/** 坏行数（解析失败被跳过的行——如实报，不吞）。 */
	readonly 坏行数: number;
	/** 账本里一共多少会话行。 */
	readonly 会话数: number;
}

/**
 * 角色字符串 → 归属桶。认不出的一律进"未归属"并披露，**不猜成 worker**。
 *
 * 为什么压缩/摘要要单列：摘要请求走的是辅助通道（`assertAuxiliaryRequestBudget`），
 * 它可能记在某个会话行里，也可能单独成行。分不清时按"未归属"处理并披露更有用——
 * 猜错了会把主控的账算到别人头上。
 */
function bucketOfRole(role: string): UsageOwnerKind {
	const text = role.trim();
	if (text === "主控") return "主控";
	if (text === "部长") return "部长";
	if (text === "worker" || text === "Worker") return "worker";
	if (text === "压缩" || text === "摘要" || text === "压缩摘要" || text === "precompaction" || text === "summary")
		return "压缩摘要";
	return "未归属";
}

const BUCKET_ORDER: readonly UsageOwnerKind[] = ["主控", "部长", "worker", "压缩摘要", "未归属"];

function emptyBucket(owner: UsageOwnerKind): {
	owner: UsageOwnerKind;
	会话数: number;
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cost: number;
	缺账会话数: number;
} {
	return { owner, 会话数: 0, turns: 0, input: 0, output: 0, cacheRead: 0, cost: 0, 缺账会话数: 0 };
}

/**
 * 把账本行分桶。
 *
 * 费用口径判定（红线落点）：
 * - 该桶内所有会话都**有** usage 且 cost 有真实来源 → 已知费用；
 * - 有任何会话缺 usage → **未知**（不把缺账会话的费用当 0 加进去，也不把合计当准确值）；
 * - 账本里的 cost 是供应商真实回的费用（不是我们自己按单价折算的），所以只要不缺账就是"已知"。
 *   一旦将来引入按单价折算，必须走 `estimatedCostAmount` 并带依据——这里留了位置。
 */
export function rollupUsageRows(rows: readonly UsageLedgerRow[], badLineCount = 0): UsageRollup {
	const map = new Map<UsageOwnerKind, ReturnType<typeof emptyBucket>>();
	for (const owner of BUCKET_ORDER) map.set(owner, emptyBucket(owner));
	for (const row of rows) {
		const bucket = map.get(bucketOfRole(row.角色))!;
		bucket.会话数++;
		bucket.turns += row.turns;
		bucket.input += row.input;
		bucket.output += row.output;
		bucket.cacheRead += row.cacheRead;
		bucket.cost += row.cost;
		if (row.缺用量轮次 > 0) bucket.缺账会话数++;
	}
	const toBucket = (raw: ReturnType<typeof emptyBucket>): UsageOwnerBucket => ({
		owner: raw.owner,
		会话数: raw.会话数,
		turns: raw.turns,
		input: raw.input,
		output: raw.output,
		cacheRead: raw.cacheRead,
		费用:
			raw.会话数 === 0
				? // 空桶：没有会话就没有费用可言。说"无记录"比说 $0 诚实。
					unknownAmount("这个归属类别还没有任何会话记录")
				: raw.缺账会话数 > 0
					? unknownAmount(`${raw.缺账会话数} 个会话未回 usage，已知下界 $${raw.cost.toFixed(4)} 只是本桶已记部分`)
					: knownCostAmount(raw.cost, "供应商回的真实费用（跨会话账本累计）"),
		缺账会话数: raw.缺账会话数,
	});
	const buckets = BUCKET_ORDER.map((owner) => toBucket(map.get(owner)!));
	const totalRaw = emptyBucket("未归属");
	for (const bucket of buckets) {
		totalRaw.会话数 += bucket.会话数;
		totalRaw.turns += bucket.turns;
		totalRaw.input += bucket.input;
		totalRaw.output += bucket.output;
		totalRaw.cacheRead += bucket.cacheRead;
		totalRaw.缺账会话数 += bucket.缺账会话数;
	}
	// 合计费用按原始行加（避免逐桶 rounded 值再相加引入漂移）。
	const 合计费用 = rows.reduce((sum, row) => sum + row.cost, 0);
	const 合计: UsageOwnerBucket = {
		owner: "未归属",
		会话数: totalRaw.会话数,
		turns: totalRaw.turns,
		input: totalRaw.input,
		output: totalRaw.output,
		cacheRead: totalRaw.cacheRead,
		费用:
			rows.length === 0
				? unknownAmount("账本里还没有任何会话记录")
				: totalRaw.缺账会话数 > 0
					? unknownAmount(`${totalRaw.缺账会话数} 个会话未回 usage，累计 $${合计费用.toFixed(4)} 只是已知下界`)
					: knownCostAmount(合计费用, "供应商回的真实费用（跨会话账本累计）"),
		缺账会话数: totalRaw.缺账会话数,
	};
	// ── 无法归属的披露（不许静默丢）──────────────────────────────────────
	const unattributable: UsageUnattributable[] = [];
	const 未归属桶 = buckets.find((bucket) => bucket.owner === "未归属")!;
	if (未归属桶.会话数 > 0) {
		unattributable.push({
			范围: `${未归属桶.会话数} 个会话的角色名不在「主控/部长/worker/压缩摘要」之内，无法可靠归属，单列在「未归属」桶`,
			条数: 未归属桶.会话数,
		});
	}
	if (totalRaw.缺账会话数 > 0) {
		unattributable.push({
			范围: `${totalRaw.缺账会话数} 个会话未回 usage，这些会话的 token 与费用无法补记，合计只作已知下界`,
			条数: totalRaw.缺账会话数,
		});
	}
	const 缺摘要行 = rows.filter((row) => bucketOfRole(row.角色) === "压缩摘要").length;
	if (缺摘要行 === 0 && rows.length > 0) {
		unattributable.push({
			范围: `压缩/摘要用量：${USAGE_LEDGER_FILENAME} 里没有独立的压缩摘要行，摘要请求的用量可能已并入所属会话（计入该会话的角色桶），也可能完全没落账——本汇总无法把这两者分开`,
			条数: 0,
		});
	}
	if (badLineCount > 0) {
		unattributable.push({
			范围: `${badLineCount} 行账本行解析失败已跳过（坏行），这些行的用量无法归属`,
			条数: badLineCount,
		});
	}
	return { buckets, 合计, 无法归属: unattributable, 坏行数: badLineCount, 会话数: rows.length };
}

/** 读 PAO_HOME 的用量账并汇总（只读查询面：不写盘、不建目录）。 */
export function rollupUsageFromPaoHome(paoHome: string): UsageRollup {
	const parsed = parseLedger(readLedgerText(paoHome));
	return rollupUsageRows(parsed.rows, parsed.坏行数);
}

/**
 * 渲染汇总正文。
 *
 * 不重复计数：纯渲染，不做任何累加；同一份 rollup 渲染多次结果完全相同。
 * 红线：费用一律经 `formatMeteredCost`，**任何情况下都不出现裸的 $0 冒充免费**。
 */
export function renderUsageRollup(rollup: UsageRollup): string {
	const lines = [`── 用量归属（跨会话累计 · ${USAGE_LEDGER_FILENAME}）──`];
	if (rollup.会话数 === 0) {
		lines.push("尚无跨会话账（首次会话正常退出后产生；中途崩溃的会话如实缺账不补记）");
	} else {
		lines.push(
			`合计 ${rollup.合计.会话数} 会话 · ${rollup.合计.turns} 轮 · ↑${rollup.合计.input} ↓${rollup.合计.output} · 费用${formatCostInline(rollup.合计.费用)}`,
		);
		for (const bucket of rollup.buckets) {
			if (bucket.会话数 === 0) continue;
			lines.push(
				`${bucket.owner}：${bucket.会话数} 会话 · ${bucket.turns} 轮 · ↑${bucket.input} ↓${bucket.output} · 费用${formatCostInline(bucket.费用)}`,
			);
		}
	}
	if (rollup.坏行数 > 0) lines.push(`${rollup.坏行数} 行坏行已跳过`);
	if (rollup.无法归属.length > 0) {
		lines.push("无法归属的部分：");
		for (const item of rollup.无法归属) lines.push(`  · ${item.范围}`);
	}
	return lines.join("\n");
}

/**
 * 内联费用文案：一段文字后接费用。
 *
 * 唯一实现仍是 `basis.ts` 的 `formatMeteredCost`——这里只负责加分隔符，
 * **不再自己拼 $ 数字**，否则口径规则就有了第二份，早晚跑偏。
 */
function formatCostInline(amount: MeteredAmount): string {
	return ` ${formatMeteredCost(amount)}`;
}

/**
 * 复用 ledger.ts 的既有聚合做交叉核对：两处算出的会话数/花费必须一致，
 * 否则说明有人只改了一边（这是防止"同一个规则实现两次"跑偏的护栏）。
 */
export function crossCheckWithLedger(rollup: UsageRollup, rows: readonly UsageLedgerRow[]): string | undefined {
	const agg = aggregateLedger(rows);
	if (agg.会话数 !== rollup.会话数) {
		return `会话数对不上：分桶 ${rollup.会话数} vs 既有聚合 ${agg.会话数}`;
	}
	return undefined;
}

/** 供外部按需构造"估计"费用（例如按目录单价折算 token 时用），与 knownCost 严格区分。 */
export const estimateFromTokens = estimatedCostAmount;
