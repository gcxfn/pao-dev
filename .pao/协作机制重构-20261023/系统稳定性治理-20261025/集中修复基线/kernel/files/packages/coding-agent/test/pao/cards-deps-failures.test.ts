import { describe, expect, test } from "vitest";

import { checkDependencies } from "../../src/pao/cards/deps.ts";
import { ALL_FAILURE_ROUTINGS, routeFailure } from "../../src/pao/cards/failures.ts";
import type { CardStatus } from "../../src/pao/cards/types.ts";

describe("checkDependencies 依赖放行", () => {
	const statuses = new Map<number, CardStatus>([
		[1, "delivered"],
		[2, "failed"],
		[3, "canceled"],
		[4, "in_progress"],
		[5, "unclaimed"],
	]);
	const statusOf = (cardNo: number) => statuses.get(cardNo);

	test("depends_on 全部已交付才放行", () => {
		expect(checkDependencies(["卡#1"], statusOf)).toEqual({ 放行: true, 阻塞: [] });
		expect(checkDependencies([], statusOf)).toEqual({ 放行: true, 阻塞: [] });
	});

	test("失败/取消前置不放行（虽是终态但不满足放行）", () => {
		const result = checkDependencies(["卡#1", "卡#2", "卡#3"], statusOf);
		expect(result.放行).toBe(false);
		expect(result.阻塞).toEqual([
			{ 卡号: 2, 状态: "failed" },
			{ 卡号: 3, 状态: "canceled" },
		]);
	});

	test("查询接口返回等哪张卡、那张卡什么状态（含进行中/待认领）", () => {
		const result = checkDependencies(["卡#4", "卡#5"], statusOf);
		expect(result.放行).toBe(false);
		expect(result.阻塞).toEqual([
			{ 卡号: 4, 状态: "in_progress" },
			{ 卡号: 5, 状态: "unclaimed" },
		]);
	});

	test("前置卡不存在按阻塞处理，状态标不存在", () => {
		const result = checkDependencies(["卡#99"], statusOf);
		expect(result.放行).toBe(false);
		expect(result.阻塞).toEqual([{ 卡号: 99, 状态: "不存在" }]);
	});

	test("引用格式兼容 卡0017 / 卡#17 / 17", () => {
		const result = checkDependencies(["卡0001", "1"], statusOf);
		expect(result.放行).toBe(true);
	});
});

describe("routeFailure 失败分型路由（纯数据输出）", () => {
	test("瞬时故障 → 重试，允许自动重派", () => {
		const routing = routeFailure("transient");
		expect(routing.建议动作).toBe("重试");
		expect(routing.自动重派).toBe(true);
	});

	test("缺输入 → 退回补卡，不自动重派", () => {
		const routing = routeFailure("missing_input");
		expect(routing.建议动作).toBe("退回补卡");
		expect(routing.自动重派).toBe(false);
	});

	test("能力不足 → 改派拆卡；结果未知 → 查现场", () => {
		expect(routeFailure("insufficient_capability").建议动作).toBe("改派拆卡");
		expect(routeFailure("unknown_outcome").建议动作).toBe("查现场");
		expect(routeFailure("unknown_outcome").自动重派).toBe(false);
	});

	test("四类分型齐全", () => {
		expect(ALL_FAILURE_ROUTINGS.map((r) => r.类型).sort()).toEqual(
			["unknown_outcome", "insufficient_capability", "missing_input", "transient"].sort(),
		);
	});
});
