import { describe, expect, test } from "vitest";
import { parseWorkflowMarker, workflowMarker } from "../../src/pao/shared/marker.ts";

describe("parseWorkflowMarker（shared 正本，S11-K 下沉后唯一实现）", () => {
	test("正常解析｜前导空白容忍｜非标记返回 undefined", () => {
		const marker = workflowMarker("梳理流", "节点二");
		expect(parseWorkflowMarker(marker)).toEqual({ 流: "梳理流", 节点: "节点二" });
		expect(parseWorkflowMarker(`\n\n  ${marker}`)).toEqual({ 流: "梳理流", 节点: "节点二" });
		expect(parseWorkflowMarker("普通正文没有标记")).toBeUndefined();
	});
});
