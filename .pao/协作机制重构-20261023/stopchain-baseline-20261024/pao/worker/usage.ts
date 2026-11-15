/**
 * 用量对账（R07 计量口径 / M1-06 交付）：
 * - 用量只从事件流与接口返回取（receipt.ts 的 message_end usage），不让 worker 凭空自报；
 * - 接口未回 usage 的轮次记「未知」，不填零——汇总行如实标 来源:"未知"，可复算性不破坏；
 * - 父卡总额 = 子项汇总，不把已含子卡的总额再相加：汇总结果标 来源:"汇总"，
 *   再次进汇总通道会被结构化拒绝（双计在结构上不可表达，而非靠自觉）；
 * - 预算门禁挡新请求：耗尽（或用量未知无法证明未超限）不开新请求，不承诺在途请求零费用。
 *
 * 行/聚合口径正本已下沉 pao/shared/usage.ts（cards 四指标同口径复用）；此处保留兼容再导出
 * （./pao 公开 barrel 经 worker/index.ts 转出，符号与路径不变），budgetGate 留守本模块。
 */
export {
	totalsUsage,
	type UsageAggregate,
	type UsageLine,
	type UsageSource,
	usageLineFromEventState,
	type WorkerUsage,
} from "../shared/usage.ts";

import type { UsageLine } from "../shared/usage.ts";

export interface BudgetVerdict {
	/** false = 不开新请求 */
	允许新请求: boolean;
	/** 耗尽/不可判的预算字段 */
	超限: string[];
	原因?: string;
}

/**
 * 预算门禁（纯函数）：挡「新请求/新派发」，不承诺在途请求零费用（R07）。
 * - 某项已用 >= 限额 → 耗尽，不开新请求；
 * - 已用来源为「未知」而该项有限额 → 无法证明未超限，按超限处理（未知不当零的反面：也不当无穷）；
 * - 未设预算或该项无限额 → 放行该项。
 */
export function budgetGate(
	used: Pick<UsageLine, "用量" | "来源"> & { 含未知?: boolean; 工具调用次数?: number },
	budget: { turns?: number; cost?: number; toolCalls?: number },
): BudgetVerdict {
	const usageUnknown = used.来源 === "未知" || used.含未知 === true;
	const overLimit: string[] = [];
	let unknownReason: string | undefined;
	if (budget.turns !== undefined) {
		if (used.用量.turns >= budget.turns) overLimit.push("turns");
	}
	if (budget.toolCalls !== undefined) {
		if (used.工具调用次数 === undefined) unknownReason = "toolCalls";
		else if (used.工具调用次数 >= budget.toolCalls) overLimit.push("toolCalls");
	}
	if (budget.cost !== undefined) {
		if (usageUnknown) unknownReason ??= "cost";
		else if (used.用量.cost >= budget.cost) overLimit.push("cost");
	}
	if (overLimit.length > 0) {
		return {
			允许新请求: false,
			超限: overLimit,
			原因: `预算耗尽:${overLimit.join("、")}，不开新请求（在途请求费用不承诺为零）`,
		};
	}
	if (unknownReason) {
		return {
			允许新请求: false,
			超限: [unknownReason],
			原因: `已用用量未知（接口未回 usage），无法证明未超预算，不开新请求（R07 未知不当零）`,
		};
	}
	return { 允许新请求: true, 超限: [] };
}
