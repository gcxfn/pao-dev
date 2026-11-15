import { describe, expect, it } from "vitest";
import type { ParsedCard } from "../../src/pao/cards/index.ts";
import { buildWorkerPrompt, classifyWorkerFailure, planFanout } from "../../src/pao/fanout/plan.ts";
import type { WorkerStatus } from "../../src/pao/worker/index.ts";

function fakeCard(cardNo: number): ParsedCard {
	return {
		path: `D:/tmp/卡/卡${String(cardNo).padStart(4, "0")}-任务.md`,
		filename: `卡${String(cardNo).padStart(4, "0")}-任务.md`,
		card_no: cardNo,
		frontmatter: {
			goal: "做事",
			dept: "测试",
			acceptance: "完成",
			attempt: 1,
			created: "2026-10-02 10:00",
			status: "in_progress",
		},
		body: "",
		receipts: [],
	};
}

describe("planFanout:批次规划纯函数", () => {
	it("顺序稳定、无遗漏无重复:去重保序,重复剔除只记一次", () => {
		const plan = planFanout(["卡#3", "1", "卡0010", "3", "0001"]);
		expect(plan.拉起顺序).toEqual(["0003", "0001", "0010"]);
		expect(plan.重复剔除).toEqual(["0003", "0001"]);
		expect(plan.并发上限).toBe(2); // 个人项目默认并发 2
	});

	it("波次静态切分:每波 ≤ 并发上限,拼接等于拉起顺序(不重不漏)", () => {
		const plan = planFanout(["1", "2", "3", "4", "5", "6", "7"], 3);
		expect(plan.波次).toEqual([["0001", "0002", "0003"], ["0004", "0005", "0006"], ["0007"]]);
		const flattened = plan.波次.flat();
		expect(flattened).toEqual(plan.拉起顺序);
		expect(new Set(flattened).size).toBe(flattened.length);
	});

	it("并发上限收敛:下限 1,不取非整数", () => {
		expect(planFanout(["1", "2"], 0).并发上限).toBe(1);
		expect(planFanout(["1", "2"], -3).并发上限).toBe(1);
		expect(planFanout(["1", "2"], 2.9).并发上限).toBe(2);
		expect(planFanout([], 8).拉起顺序).toEqual([]);
		expect(planFanout([], 8).波次).toEqual([]);
	});

	it("无法识别的卡引用抛结构化错误", () => {
		expect(() => planFanout(["卡#1", "abc"])).toThrow(/卡引用/);
	});
});

describe("classifyWorkerFailure:回执状态 → 失败四型缺省分型", () => {
	it("失败→瞬时故障(缺省可重试),未知→结果未知,成功/取消不算失败", () => {
		const cases: [WorkerStatus, string | undefined][] = [
			["failed", "transient"],
			["unknown", "unknown_outcome"],
			["success", undefined],
			["canceled", undefined],
		];
		for (const [status, expected] of cases) {
			expect(classifyWorkerFailure({ status: status })).toBe(expected);
		}
	});
});

describe("buildWorkerPrompt:只给指针不搬内容", () => {
	it("含卡文件路径与尝试号,含失败四型清单与不再派发约束", () => {
		const prompt = buildWorkerPrompt(fakeCard(17), 2);
		expect(prompt).toContain("卡0017");
		expect(prompt).toContain(fakeCard(17).path);
		expect(prompt).toContain("尝试 2");
		expect(prompt).toContain("transient/missing_input/insufficient_capability/unknown_outcome");
		expect(prompt).toContain("不得再派发子任务");
		// 指针铁律:不把卡面内容(目标/验收正文)复述进提示词
		expect(prompt).not.toContain("做事");
	});
});
