import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Message, Model, Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import type { ExtensionAPI, ToolDefinition } from "../../src/core/extensions/types.ts";
import {
	type HealthcheckCaller,
	type HealthcheckReportWithPaths,
	type ProbeResult,
	probeChat,
	probeContextLimit,
	probeReasoning,
	probeToolCall,
	registerHealthcheck,
	renderEvalEntry,
	runHealthcheck,
	sumProbeUsage,
	writeEvalEntry,
} from "../../src/pao/healthcheck/index.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** 模型调用全部走注入假件,密钥与网络永不进测试(R10) */
function makeUsage(input: number, output: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function textReply(text: string, extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "fake",
		model: "fake-model",
		usage: makeUsage(10, 5),
		stopReason: "stop",
		timestamp: Date.now(),
		...extra,
	};
}

function toolReply(id: string, name: string, args: { 甲: number }): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		api: "openai-completions",
		provider: "fake",
		model: "fake-model",
		usage: makeUsage(12, 8),
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function thinkingReply(thinking: string, text: string, extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return textReply(text, {
		content: [
			{ type: "thinking", thinking },
			{ type: "text", text },
		],
		...extra,
	});
}

const fakeModel = {
	id: "glm-4.7/fake",
	name: "假GLM",
	api: "openai-completions",
	provider: "zhipu-fake",
	baseUrl: "https://fake.example/v1",
	input: ["text"],
	cost: {},
	reasoning: true,
	contextWindow: 1000,
	maxTokens: 4096,
} as unknown as Model<any>;

const endsWithToolResult = (messages: Message[]): boolean => messages.some((m) => m.role === "toolResult");

describe("探针:普通对话", () => {
	it("拿到非空文本即通过,用量入账", async () => {
		const result = await probeChat(async () => textReply("1 加 1 等于 2。"));
		expect(result.状态).toBe("通过");
		expect(result.观察[0]).toContain("首答");
		expect(result.用量.input).toBe(10);
	});

	it("空文本判失败;抛错记错误不炸", async () => {
		const emptyReply = await probeChat(async () => textReply("   "));
		expect(emptyReply.状态).toBe("失败");
		expect(emptyReply.说明).toContain("没有任何文本内容");
		const crashReply = await probeChat(async () => {
			throw new Error("connect ECONNREFUSED");
		});
		expect(crashReply.状态).toBe("失败");
		expect(crashReply.观察[0]).toContain("ECONNREFUSED");
	});
});

describe("探针:工具调用两跳", () => {
	it("命中工具且消费结果判通过", async () => {
		const caller: HealthcheckCaller = async (messages) =>
			endsWithToolResult(messages) ? textReply("结果是 84。") : toolReply("c1", "pao_health_check探针", { 甲: 42 });
		const result = await probeToolCall(caller);
		expect(result.状态).toBe("通过");
		expect(result.观察.join(";")).toContain("工具命中:pao_health_check探针");
		expect(result.用量.input).toBe(22); // 两跳用量合计(12+10)
	});

	it("首跳不调工具判失败", async () => {
		const result = await probeToolCall(async () => textReply("84"));
		expect(result.状态).toBe("失败");
		expect(result.说明).toContain("未发起工具调用");
	});

	it("第二跳不消费结果判失败", async () => {
		const caller: HealthcheckCaller = async (messages) =>
			endsWithToolResult(messages) ? textReply("我不知道") : toolReply("c1", "pao_health_check探针", { 甲: 42 });
		const result = await probeToolCall(caller);
		expect(result.状态).toBe("失败");
		expect(result.说明).toContain("未消费结果");
	});
});

describe("探针:思考档", () => {
	it("返回思考块判「支持」;无思考块且无回标判「不支持或被忽略」", async () => {
		const supportedCase = await probeReasoning(
			async () => thinkingReply("瑞利散射…", "因为瑞利散射。", { providerThinkingLevel: "high" }),
			fakeModel,
		);
		expect(supportedCase.状态).toBe("观察完成");
		expect(supportedCase.说明).toContain("支持");
		const ignoredCase = await probeReasoning(async () => textReply("因为瑞利散射。"), {
			...fakeModel,
			reasoning: false,
		} as unknown as Model<any>);
		expect(ignoredCase.说明).toContain("不支持或被忽略");
	});
});

describe("探针:逼近上下文上限(深度开关项)", () => {
	it("超窗被明确拒绝且错误可归类判通过,并确实发了大输入", async () => {
		let receivedChars = 0;
		const caller: HealthcheckCaller = async (messages) => {
			receivedChars = JSON.stringify(messages[0]).length;
			throw new Error("This model's maximum context length is 1000 tokens. However, you requested 1100 tokens.");
		};
		const result = await probeContextLimit(caller, fakeModel);
		expect(result.状态).toBe("通过");
		expect(result.说明).toContain("明确拒绝");
		expect(receivedChars).toBeGreaterThan(1000); // 窗口 1000 → 填充约 4400 字符
	});

	it("静默接受记观察完成;不可归类报错判失败;窗口缺失跳过", async () => {
		const silentCase = await probeContextLimit(async () => textReply("OK"), fakeModel);
		expect(silentCase.状态).toBe("观察完成");
		expect(silentCase.说明).toContain("未被拒绝");
		const weirdErrorCase = await probeContextLimit(async () => {
			throw new Error("内部错误");
		}, fakeModel);
		expect(weirdErrorCase.状态).toBe("失败");
		const noWindowCase = await probeContextLimit(async () => textReply("OK"), {
			...fakeModel,
			contextWindow: 0,
		} as unknown as Model<any>);
		expect(noWindowCase.状态).toBe("跳过");
	});
});

describe("run体检 编排", () => {
	it("深度缺省时第四条记跳过且不花钱(调用器只被叫 3 次)", async () => {
		let callCount = 0;
		const caller: HealthcheckCaller = async () => {
			callCount++;
			return textReply("ok");
		};
		const result = await runHealthcheck(caller, fakeModel);
		expect(result).toHaveLength(4);
		expect(result[3].探针).toBe("逼近上下文上限");
		expect(result[3].状态).toBe("跳过");
		expect(callCount).toBe(3);
	});
});

describe("评测条目渲染与落盘", () => {
	const sampleProbes: ProbeResult[] = [
		{ 探针: "普通对话", 状态: "通过", 观察: ["首答 5 字:1 加 1 等于 2。"], 用量: makeUsage(10, 5) },
		{ 探针: "工具调用", 状态: "通过", 观察: ["工具命中:pao_health_check探针(甲=42)"], 用量: makeUsage(24, 13) },
		{ 探针: "思考档", 状态: "观察完成", 说明: "支持:返回 1 个思考块(共 120 字)", 观察: [], 用量: makeUsage(15, 90) },
		{
			探针: "逼近上下文上限",
			状态: "跳过",
			说明: "深度开关未开(最贵的一条,默认跳过;开深度=true 才跑)",
			观察: [],
			用量: makeUsage(0, 0),
		},
	];

	it("渲染含钩子/截至/适用边界/总用量/返工原因,密钥值不出现", () => {
		const rendered = renderEvalEntry(
			{
				time: "2026-10-02 12:00",
				model: {
					id: "glm-4.7/fake",
					name: "假GLM",
					provider: "zhipu-fake",
					baseUrl: "https://fake.example/v1",
					contextWindow: 1000,
					reasoning: true,
				},
				auth: "modelRegistry 解析到 key(值不记录)",
				probes: sampleProbes,
				total_usage: sumProbeUsage(sampleProbes),
				calls: 3,
			},
			{ pi_version: "0.99.2", platform: "win32/v22.0.0" },
		);
		expect(rendered).toContain("无失败");
		expect(rendered).toContain("截至 2026-10-02");
		expect(rendered).toContain("适用边界:glm-4.7/fake@zhipu-fake");
		expect(rendered).toContain("## 总用量");
		expect(rendered).toContain("## 返工原因");
		expect(rendered).toContain("无");
	});

	it("文件名安全化;同分钟重跑不覆盖(加 -2)", () => {
		const outDir = tempDir("pao-health-entry-");
		const report = {
			time: "2026-10-02 12:00",
			model: {
				id: "glm-4.7/思 no.1",
				name: "假GLM",
				provider: "zhipu-fake",
				baseUrl: "https://fake.example/v1",
				contextWindow: 1000,
				reasoning: true,
			},
			auth: "未从注册表解析到 key,走环境变量兜底",
			probes: sampleProbes,
			total_usage: sumProbeUsage(sampleProbes),
			calls: 3,
		};
		const meta = { pi_version: "0.99.2", platform: "win32/v22.0.0" };
		const path1 = writeEvalEntry(outDir, report, meta);
		expect(existsSync(path1)).toBe(true);
		expect(path1).toContain("体检-glm-4.7-思-no.1-1200.md");
		const path2 = writeEvalEntry(outDir, report, meta);
		expect(path2).not.toBe(path1);
		expect(path2).toContain("-2.md");
	});
});

function capturePi(): { pi: ExtensionAPI; tools: ToolDefinition[] } {
	const tools: ToolDefinition[] = [];
	const pi = {
		registerTool: (tool: ToolDefinition) => tools.push(tool),
	} as unknown as ExtensionAPI;
	return { pi, tools };
}

describe("pao_health_check 工具注册与全程执行", () => {
	it("注册工具;注入假调用器跑全程并落盘,详情带路径", async () => {
		const captured = capturePi();
		const outDir = tempDir("pao-health-out-");
		// 顺序脚本:1 对话、2 工具首跳、3 工具二跳、4 思考档(run体检 固定顺序)
		let n = 0;
		registerHealthcheck(captured.pi, {
			resolveCaller: () => async () => {
				n += 1;
				if (n === 2) return toolReply("c1", "pao_health_check探针", { 甲: 42 });
				if (n === 4) return thinkingReply("思考内容", "因为散射。", { providerThinkingLevel: "high" });
				return textReply(n === 3 ? "84" : "2");
			},
			resolveOutDir: () => outDir,
		});
		const tool = captured.tools.find((entry) => entry.name === "pao_health_check");
		expect(tool).toBeDefined();
		const result = await tool!.execute("t1", {}, undefined, undefined, { model: fakeModel } as never);
		const text = (result.content[0] as { type: string; text: string }).text;
		expect(text).toContain("无失败");
		const details = result.details as HealthcheckReportWithPaths;
		expect(details.calls).toBe(4);
		expect(details.out_path.startsWith(outDir)).toBe(true);
		const written = readFileSync(details.out_path, "utf8");
		expect(written).toContain("截至");
		expect(written).toContain("4 次模型调用");
	});

	it("会话无模型时明确报错,不静默", async () => {
		const captured = capturePi();
		registerHealthcheck(captured.pi, { resolveOutDir: () => tempDir("pao-health-out-") });
		await expect(captured.tools[0].execute("t2", {}, undefined, undefined, {} as never)).rejects.toThrow(
			/没有选中模型/,
		);
	});
});
