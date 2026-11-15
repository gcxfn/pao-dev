import { parseCardRef } from "./counter.ts";
import type { CardStatus } from "./types.ts";

/** 依赖卡的状态查询结果：找不到卡也算阻塞（状态=不存在）。 */
export interface DependencyStatus {
	卡号: number;
	状态: CardStatus | "不存在";
}

export interface DependencyGateResult {
	/** 放行 = depends_on 全部已交付（架构 §2：失败/取消虽终态但不满足放行）。 */
	放行: boolean;
	/** 阻塞明细：等哪张卡、那张卡什么状态。 */
	阻塞: DependencyStatus[];
}

/**
 * 依赖环检测（纯函数，M2-02「有限分叉/汇合」的机械检查之三）。
 * 在既有卡的依赖图（depsOf 给出每张卡 depends_on 解析后的卡号）里，找「从 roots 出发可达」的环，
 * 返回环上卡号（逐环展开、去重、升序）。roots 自身成环（含自依赖：depsOf(n) 含 n）同样计入。
 * 不可达的环不返回——与本卡无关的死锁组件不扩大打击面。
 * 口径：环上只要有任一卡未达已交付，整环互等永远无法交付（等待方把全部成员按环锁死）。
 */
export function findReachableCycles(
	roots: readonly number[],
	depsOf: (cardNo: number) => readonly number[] | undefined,
): number[] {
	const WHITE = 0;
	const GRAY = 1;
	const BLACK = 2;
	const color = new Map<number, number>();
	const cycleNodes = new Set<number>();
	/** 当前 DFS 栈（供回边命中时截取环段） */
	const stack: number[] = [];
	const onStack = new Set<number>();

	const visit = (cardNo: number): void => {
		color.set(cardNo, GRAY);
		stack.push(cardNo);
		onStack.add(cardNo);
		for (const next of depsOf(cardNo) ?? []) {
			const state = color.get(next) ?? WHITE;
			if (state === GRAY) {
				// 回边：栈中从 next 起到当前节点的段即一个环
				const start = stack.lastIndexOf(next);
				for (const member of stack.slice(start)) cycleNodes.add(member);
			} else if (state === WHITE) {
				visit(next);
			}
		}
		stack.pop();
		onStack.delete(cardNo);
		color.set(cardNo, BLACK);
	};

	for (const root of roots) if ((color.get(root) ?? WHITE) === WHITE) visit(root);
	return [...cycleNodes].sort((a, b) => a - b);
}

/**
 * 依赖放行门（纯函数）。parent 不参与依赖判断（架构 §2 定案），调用方无须传入。
 * statusOf 返回 undefined = 前置卡不存在（同队列查不到），按阻塞处理。
 */
export function checkDependencies(
	dependsOn: readonly string[],
	statusOf: (cardNo: number) => CardStatus | undefined,
): DependencyGateResult {
	const blocking: DependencyStatus[] = [];
	for (const ref of dependsOn) {
		const cardNo = parseCardRef(ref);
		const status = statusOf(cardNo);
		if (status !== "delivered") {
			blocking.push({ 卡号: cardNo, 状态: status ?? "不存在" });
		}
	}
	return { 放行: blocking.length === 0, 阻塞: blocking };
}
