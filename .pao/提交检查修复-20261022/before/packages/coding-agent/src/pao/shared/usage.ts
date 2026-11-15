/**
 * R07 计量口径契约（worker/显示层/卡四指标三处共用）：用量记录、来源判定与父子汇总的唯一实现。
 * - 用量只从事件流与接口返回取，不凭空自报；接口未回 usage 的轮次记「未知」，不填零；
 * - 父卡总额 = 子项汇总，不把已含子卡的总额再相加：汇总行再进汇总通道结构化拒绝（不双计）。
 *
 * 自 pao/worker/receipt.ts（WorkerUsage）与 pao/worker/usage.ts（行/聚合）迁入，解 cards↔worker
 * 互边；worker/receipt.ts 与 worker/usage.ts 兼容再导出同名符号，公开面（package exports 的
 * ./pao barrel）不变。
 */
export interface WorkerUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

/** 用量来源：事件流 = 可复算；未知 = 接口有轮次未回 usage（不填零）；汇总 = 由子项算出的父总额。 */
export type UsageSource = "事件流" | "未知" | "汇总";

export interface UsageLine {
	卡号: string;
	/** 尝试号；批次/部门级汇总行可缺省 */
	尝试?: number;
	用量: WorkerUsage;
	来源: UsageSource;
	/** 来源为未知/汇总时的说明（未知轮数、子项数等） */
	说明?: string;
}

/**
 * 事件流状态 → 用量行：有任一轮未回 usage 即整行按「未知」记，已知合计只当下界。
 * 入参只取 用量+缺用量轮次 两个字段（结构化入参）：完整事件状态与回执里的用量快照都能走
 * 本入口——显示层不另立计数路径（架构 §15：数据只从事件流与汇总来）。
 */
export function usageLineFromEventState(
	cardNo: string,
	attempt: number,
	state: { 用量: WorkerUsage; 缺用量轮次: number },
): UsageLine {
	if (state.缺用量轮次 > 0) {
		return {
			卡号: cardNo,
			尝试: attempt,
			用量: state.用量,
			来源: "未知",
			说明: `${state.缺用量轮次}项用量不完整，已知下界，不填零按未知记（R07）`,
		};
	}
	return { 卡号: cardNo, 尝试: attempt, 用量: state.用量, 来源: "事件流" };
}

export interface UsageAggregate {
	卡号: string;
	用量: WorkerUsage;
	来源: "汇总";
	/** 子项里有来源未知的行 → 父总额也只是已知下界，预算门禁按未知处理 */
	含未知: boolean;
	/** 含未知时的说明（几个子项未知） */
	说明?: string;
	子项: readonly UsageLine[];
}

function addUsage(target: WorkerUsage, source: WorkerUsage): void {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.cost += source.cost;
	target.turns += source.turns;
}

/**
 * 父子汇总：父卡总额 = 子项逐行相加。入参里已含「来源:"汇总"」的行直接拒绝——
 * 不把已含子卡的总额再相加（R07 不双计），调用方必须给叶子行。
 */
export function totalsUsage(cardNo: string, lines: readonly UsageLine[]): UsageAggregate {
	const offending = lines.filter((line) => line.来源 === "汇总").map((line) => line.卡号);
	if (offending.length > 0) {
		throw new Error(`汇总行不得再进汇总（父卡总额=子项汇总，不把已含子卡的总额再相加）：${offending.join("、")}`);
	}
	const usage: WorkerUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	for (const line of lines) addUsage(usage, line.用量);
	const unknownCount = lines.filter((line) => line.来源 === "未知").length;
	return {
		卡号: cardNo,
		用量: usage,
		来源: "汇总",
		含未知: unknownCount > 0,
		...(unknownCount > 0 ? { 说明: `${unknownCount} 个子项来源未知，父总额为已知下界` } : {}),
		子项: lines,
	};
}
