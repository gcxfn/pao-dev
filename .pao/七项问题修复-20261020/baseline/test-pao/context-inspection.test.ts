import { afterEach, describe, expect, it } from "vitest";
import {
	armContextCapture,
	clearContextCapture,
	getContextCapture,
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
});
