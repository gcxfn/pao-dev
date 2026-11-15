import { afterEach, describe, expect, it } from "vitest";
import {
	armContextCapture,
	clearContextCapture,
	getContextCapture,
	getProviderRequestMetrics,
	recordFinalProviderPayload,
	recordProviderResponse,
	redactContext,
} from "../../src/pao/context/index.ts";

afterEach(() => {
	clearContextCapture("one");
	clearContextCapture("two");
});

describe("按需实际请求查看（离线装配测试）", () => {
	it("未开启时不保存输入；最终装配不是已发送证明", () => {
		recordFinalProviderPayload("one", { messages: ["未开启"] });
		expect(getContextCapture("one")).toBeUndefined();
		armContextCapture("one");
		const id = recordFinalProviderPayload("one", { messages: ["已装配"] });
		expect(getContextCapture("one")?.状态).toBe("待发预览");
		expect(getContextCapture("one")?.最终装配已核).toBe(true);
		recordProviderResponse("one", id, 400);
		expect(getContextCapture("one")?.状态).toBe("已发送且收到响应");
		expect(getContextCapture("one")?.响应状态).toBe(400);
	});
	it("收到响应后不捕获后续请求，不混入另一会话", () => {
		armContextCapture("one");
		const id = recordFinalProviderPayload("one", { text: "第一条" });
		recordProviderResponse("one", id, 200);
		recordFinalProviderPayload("one", { text: "第二条" });
		recordFinalProviderPayload("two", { text: "其他会话" });
		expect(getContextCapture("one")?.供应商请求).toEqual({ text: "第一条" });
		expect(getContextCapture("two")).toBeUndefined();
		const copy = getContextCapture("one");
		if (copy) copy.状态 = "待发预览";
		expect(getContextCapture("one")?.状态).toBe("已发送且收到响应");
	});
	it("失败无响应不能让下一请求覆盖，旧响应不能标记新捕获", () => {
		armContextCapture("one");
		const old = recordFinalProviderPayload("one", { text: "失败请求" });
		expect(recordFinalProviderPayload("one", { text: "下一请求" })).toBeUndefined();
		expect(getContextCapture("one")?.供应商请求).toEqual({ text: "失败请求" });
		armContextCapture("one");
		recordFinalProviderPayload("one", { text: "重新开启" });
		recordProviderResponse("one", old, 200);
		expect(getContextCapture("one")?.状态).toBe("待发预览");
	});
	it("凭证字段、文本内明显凭证、隐藏推理在存储前去除", () => {
		const sanitized = JSON.stringify(
			redactContext({
				authorization: "Bearer private",
				api_key: "private",
				text: 'GBRAIN_TOKEN=private apiKey="private" Bearer private sk-abcdefghijk',
				content: [
					{ type: "thinking", thinking: "隐藏推理" },
					{ type: "text", text: "公开结论" },
				],
			}),
		);
		expect(sanitized).not.toContain("private");
		expect(sanitized).not.toContain("sk-abcdefghijk");
		expect(sanitized).toContain("公开结论");
		expect(sanitized).not.toContain('"thinking":"隐藏推理"');
	});
	it("未 arm 也记录最终工具规模；字段缺失保留未知而不是零", () => {
		recordFinalProviderPayload("one", { model: "m-1", messages: [] });
		const [missing] = getProviderRequestMetrics("one");
		expect(missing).toMatchObject({
			会话: "one",
			请求序号: 1,
			模型: "m-1",
			工具字段存在: false,
			工具数: null,
			工具JSON码点: null,
			工具UTF8字节: null,
			token: null,
			工具: [],
		});
		recordFinalProviderPayload("one", { model: "m-2", tools: [] });
		const metrics = getProviderRequestMetrics("one");
		expect(metrics[1]).toMatchObject({
			请求序号: 2,
			工具字段存在: true,
			工具数: 0,
			工具JSON码点: 2,
			工具UTF8字节: 2,
			token: null,
			工具: [],
		});
		expect(getContextCapture("one")).toBeUndefined();
	});
	it("只统计最终 payload，不计中间 before_provider_request；按码点和 UTF8 字节记录", () => {
		const intermediate = { tools: [{ name: "中间工具", description: "不应保存" }], model: "old" };
		const final = {
			model: "final",
			tools: [
				{
					name: "读取",
					description: "中文说明不能被元数据复制",
					parameters: { type: "object", properties: { path: { type: "string" } } },
				},
			],
		};
		recordFinalProviderPayload("one", final);
		const metrics = getProviderRequestMetrics("one");
		expect(metrics).toHaveLength(1);
		expect(metrics[0]!.模型).toBe("final");
		expect(metrics[0]!.工具数).toBe(1);
		expect(metrics[0]!.工具[0]).toMatchObject({ 工具名: "读取" });
		expect(metrics[0]!.工具JSON码点).toBe(Array.from(JSON.stringify(final.tools)).length);
		expect(metrics[0]!.工具UTF8字节).toBe(Buffer.byteLength(JSON.stringify(final.tools), "utf8"));
		const stored = JSON.stringify(metrics);
		expect(stored).not.toContain("中文说明不能被元数据复制");
		expect(stored).not.toContain("parameters");
		expect(JSON.stringify(intermediate)).toContain("中间工具");
		expect(stored).not.toContain("中间工具");
	});
	it("响应只更新同一请求；完整捕获仍只取 arm 后下一次", () => {
		armContextCapture("one");
		const first = recordFinalProviderPayload("one", { model: "first", tools: [] });
		const second = recordFinalProviderPayload("one", { model: "second", tools: [] });
		expect(first).toEqual(expect.any(String));
		expect(second).toBeUndefined();
		expect(getContextCapture("one")?.请求序号).toBe(1);
		expect(getProviderRequestMetrics("one").map((item) => item.请求序号)).toEqual([1, 2]);
		recordProviderResponse("one", first, 503);
		expect(getProviderRequestMetrics("one")).toMatchObject([{ 请求标识: first, 响应状态: 503 }, { 模型: "second" }]);
		armContextCapture("one");
		const capturedId = recordFinalProviderPayload("one", { model: "captured", tools: [] });
		expect(getContextCapture("one")?.供应商请求).toEqual({ model: "captured", tools: [] });
		recordProviderResponse("one", capturedId, 200);
		expect(getContextCapture("one")?.响应状态).toBe(200);
		recordFinalProviderPayload("one", { model: "after-capture", tools: [] });
		expect(getContextCapture("one")?.供应商请求).toEqual({ model: "captured", tools: [] });
		expect(getProviderRequestMetrics("one").at(-1)?.模型).toBe("after-capture");
	});
});
