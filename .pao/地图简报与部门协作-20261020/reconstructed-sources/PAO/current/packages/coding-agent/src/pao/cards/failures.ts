import type { FailureType } from "./types.ts";

/**
 * 失败分型路由（架构 §2.1）：
 * - 瞬时故障 → 重试（同轮尝试上限内自动重派）；
 * - 缺输入 → 退回补卡，不自动重派（重派也是白跑）；
 * - 能力不足 → 改派或拆卡；
 * - 结果未知 → 先查现场（git status / 跑测试）再定续跑还是重跑，不盲目整个重做。
 * 纯数据结构输出，不含执行逻辑。
 */
export interface FailureRouting {
	类型: FailureType;
	建议动作: "重试" | "退回补卡" | "改派拆卡" | "查现场";
	/** 是否允许在尝试上限内自动重派。 */
	自动重派: boolean;
	说明: string;
}

const ROUTING: Record<FailureType, Omit<FailureRouting, "类型">> = {
	transient: {
		建议动作: "重试",
		自动重派: true,
		说明: "瞬时故障自动重试；尝试数达上限即升级人，不论失败原因",
	},
	missing_input: {
		建议动作: "退回补卡",
		自动重派: false,
		说明: "缺输入不自动重派；退回派卡方补卡（补输入指针），问题补上后走失败→待认领重试",
	},
	insufficient_capability: {
		建议动作: "改派拆卡",
		自动重派: false,
		说明: "能力不足改派或拆卡；换部门/降粒度后重发新卡",
	},
	unknown_outcome: {
		建议动作: "查现场",
		自动重派: false,
		说明: "已改项目但结果未知：先查现场（git status / 跑测试）再定续跑还是重跑",
	},
};

export function routeFailure(type: FailureType): FailureRouting {
	return { 类型: type, ...ROUTING[type] };
}

export const ALL_FAILURE_ROUTINGS: FailureRouting[] = Object.keys(ROUTING).map((key) =>
	routeFailure(key as FailureType),
);
