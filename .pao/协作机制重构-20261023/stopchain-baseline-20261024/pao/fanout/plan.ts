/**
 * 扇出批次规划(卡0007):纯函数,无进程、无 IO。
 * 规划 = 去重保序的拉起顺序 + 静态波次视图;实际执行(execute.ts)按拉起顺序排队补位,
 * 不按波次等待——波次只是展示/审计用的静态切分,不是执行语义。
 */
import { parseCardRef } from "../cards/index.ts";

// 提示词构建与回执缺省分型已迁入 worker 模块的单卡派发共享核心(依赖方向 fanout→worker 单向,
// worker 不得反向 import fanout);此处转发导出保公共面不变(既有 import 路径全部照旧可用)。
export { buildWorkerPrompt, classifyWorkerFailure } from "../worker/dispatch-core.ts";

/** 个人项目默认 2；同一主会话最多 8 个 worker。 */
export const DEFAULT_FANOUT_CONCURRENCY = 2;
export const MAX_FANOUT_CONCURRENCY = 8;

export interface FanoutBatchPlan {
	/** 去重保序后的拉起顺序(四位卡号,如 "0017");执行按此排队补位 */
	拉起顺序: string[];
	/** 静态波次视图(每波 ≤ 并发上限),仅用于展示/审计;执行为补位式,不按波次等待 */
	波次: string[][];
	/** 收敛后的并发上限(下限 1) */
	并发上限: number;
	/** 输入中重复出现而剔除的卡号(首次出现入队,后续重复不计) */
	重复剔除: string[];
}

/**
 * 批次规划:N 个卡引用 + 并发上限 → 拉起计划。
 * 顺序稳定(按输入首次出现序)、无遗漏(每张入队一次)、无重复(同卡去重);
 * 不拒绝不丢弃——超上限的卡全部进队,由执行层依序补位。
 * 无法识别的卡引用抛结构化错误(PaoCardError)。
 */
export function planFanout(
	cardNoList: readonly string[],
	concurrencyLimit: number = DEFAULT_FANOUT_CONCURRENCY,
): FanoutBatchPlan {
	if (!Number.isFinite(concurrencyLimit)) throw new Error("并发上限须为有限数值");
	const limit = Math.min(MAX_FANOUT_CONCURRENCY, Math.max(1, Math.floor(concurrencyLimit)));
	const spawnOrder: string[] = [];
	const dedupe: string[] = [];
	const seen = new Set<string>();
	for (const ref of cardNoList) {
		const cardNo = String(parseCardRef(ref)).padStart(4, "0");
		if (seen.has(cardNo)) {
			dedupe.push(cardNo);
			continue;
		}
		seen.add(cardNo);
		spawnOrder.push(cardNo);
	}
	const wave: string[][] = [];
	for (let i = 0; i < spawnOrder.length; i += limit) {
		wave.push(spawnOrder.slice(i, i + limit));
	}
	return { 拉起顺序: spawnOrder, 波次: wave, 并发上限: limit, 重复剔除: dedupe };
}
