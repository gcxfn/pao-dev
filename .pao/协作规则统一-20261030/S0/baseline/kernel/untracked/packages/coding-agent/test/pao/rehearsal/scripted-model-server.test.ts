import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { completeSimple, type Model } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";

const REHEARSAL_ROOT = resolve(import.meta.dirname, "../../../../../../bench/rehearsal");
const { createScriptedModelServer } = await import(
	pathToFileURL(join(REHEARSAL_ROOT, "scripted-model-server.mjs")).href
);

interface ModelServer {
	baseUrl: string;
	host: string;
	port: number;
	close(): Promise<void>;
}

interface ScriptedChatCompletion {
	object: "chat.completion";
	choices: Array<{
		message: {
			content: string | null;
			tool_calls?: Array<{
				function: {
					name: string;
					arguments: string;
				};
			}>;
		};
	}>;
	usage: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
		synthetic: true;
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScriptedChatCompletion(value: unknown): value is ScriptedChatCompletion {
	if (!isRecord(value) || value.object !== "chat.completion") return false;
	if (!Array.isArray(value.choices) || value.choices.length === 0) return false;
	const choice = value.choices[0];
	if (!isRecord(choice) || !isRecord(choice.message)) return false;
	const { content, tool_calls: toolCalls } = choice.message;
	if (content !== null && typeof content !== "string") return false;
	if (
		toolCalls !== undefined &&
		(!Array.isArray(toolCalls) ||
			toolCalls.some(
				(call) =>
					!isRecord(call) ||
					!isRecord(call.function) ||
					typeof call.function.name !== "string" ||
					typeof call.function.arguments !== "string",
			))
	) {
		return false;
	}
	if (!isRecord(value.usage) || value.usage.synthetic !== true) return false;
	return (
		typeof value.usage.prompt_tokens === "number" &&
		typeof value.usage.completion_tokens === "number" &&
		typeof value.usage.total_tokens === "number"
	);
}

async function readChatCompletion(response: Response): Promise<ScriptedChatCompletion> {
	const value: unknown = await response.json();
	if (!isScriptedChatCompletion(value)) {
		throw new Error("脚本模型返回了无法识别的 chat.completion 响应");
	}
	return value;
}

const roots: string[] = [];
const servers: ModelServer[] = [];

function fixtureParent(): string {
	const paoHome = process.env.PAO_HOME?.trim();
	if (!paoHome) {
		throw new Error("测试前置错误：必须显式设置隔离 PAO_HOME，夹具会创建在其父目录下");
	}
	const parent = dirname(resolve(paoHome));
	mkdirSync(parent, { recursive: true });
	return parent;
}

function fixture(rules: unknown[]) {
	const root = mkdtempSync(join(fixtureParent(), "pao-scripted-model-"));
	roots.push(root);
	const scenarioPath = join(root, "scenario.json");
	const evidenceDir = join(root, "evidence");
	writeFileSync(
		scenarioPath,
		JSON.stringify({
			schemaVersion: 1,
			name: "协议夹具",
			model: { provider: "harbor-endpoint", id: "minimax-code/MiniMax-M3.1-Flash" },
			unmatched: "fail",
			rules,
		}),
	);
	return { root, scenarioPath, evidenceDir };
}

async function start(rules: unknown[]) {
	const f = fixture(rules);
	const server = (await createScriptedModelServer({
		scenarioPath: f.scenarioPath,
		evidenceDir: f.evidenceDir,
	})) as ModelServer;
	servers.push(server);
	return { ...f, server };
}

async function post(server: ModelServer, body: Record<string, unknown>) {
	return fetch(`${server.baseUrl}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: "Bearer never-log-this" },
		body: JSON.stringify(body),
	});
}

afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("彩排脚本模型服务", () => {
	it("默认只绑定 127.0.0.1 的随机空闲端口", async () => {
		const { server } = await start([
			{
				id: "main-text",
				match: { role: "main" },
				respond: { kind: "text", text: "回环" },
			},
		]);
		expect(server.host).toBe("127.0.0.1");
		expect(server.port).toBeGreaterThan(0);
		expect(server.baseUrl).toBe(`http://127.0.0.1:${server.port}/v1`);
	});

	it("流式文本返回 finish_reason 与明确标为模拟的 usage", async () => {
		const { server } = await start([
			{
				id: "main-text",
				match: { role: "main" },
				respond: { kind: "text", text: "固定回应" },
			},
		]);
		const response = await post(server, {
			model: "minimax-code/MiniMax-M3.1-Flash",
			stream: true,
			messages: [{ role: "user", content: "你是主控" }],
			tools: [{ type: "function", function: { name: "pao_start_flow" } }],
		});
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toContain('"content":"固定回应"');
		expect(text).toContain('"finish_reason":"stop"');
		expect(text).toContain('"synthetic":true');
		expect(text).toContain("不是真实 token");
		expect(text).toContain("data: [DONE]");
	});

	it("流式工具调用保留函数名和 JSON 参数", async () => {
		const { server } = await start([
			{
				id: "worker-write",
				match: { role: "worker", tool: "write" },
				respond: {
					kind: "tool_call",
					call: { name: "write", arguments: { path: "业务/结果.txt", content: "完成\n" } },
				},
			},
		]);
		const response = await post(server, {
			model: "minimax-code/MiniMax-M3.1-Flash",
			stream: true,
			messages: [{ role: "user", content: "工人执行卡0001" }],
			tools: [{ type: "function", function: { name: "write" } }],
		});
		const text = await response.text();
		expect(text).toContain('"name":"write"');
		expect(text).toContain("业务/结果.txt");
		expect(text).toContain('"finish_reason":"tool_calls"');
	});

	it("非流式响应使用 OpenAI chat.completion 形状", async () => {
		const { server } = await start([
			{
				id: "worker-text",
				match: { role: "worker" },
				respond: { kind: "text", text: "非流式回应" },
			},
		]);
		const response = await post(server, {
			model: "minimax-code/MiniMax-M3.1-Flash",
			stream: false,
			messages: [{ role: "user", content: "工人执行任务" }],
		});
		const json = await readChatCompletion(response);
		expect(json.object).toBe("chat.completion");
		expect(json.choices[0]?.message.content).toBe("非流式回应");
		expect(json.usage.synthetic).toBe(true);
	});

	it("未匹配请求直接失败，并报告角色和工具缺口", async () => {
		const { server, evidenceDir } = await start([
			{
				id: "main-only",
				match: { role: "main" },
				respond: { kind: "text", text: "不应命中" },
			},
		]);
		const response = await post(server, {
			model: "minimax-code/MiniMax-M3.1-Flash",
			messages: [{ role: "user", content: "工人执行任务" }],
			tools: [{ type: "function", function: { name: "read" } }],
		});
		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({
			error: { type: "scripted_model_unmatched" },
		});
		const logged = readFileSync(join(evidenceDir, "responses.jsonl"), "utf8");
		expect(logged).toContain('"rule":null');
	});

	it("断流场景发送内容但不写 finish_reason", async () => {
		const { server } = await start([
			{
				id: "disconnect",
				match: { role: "main" },
				respond: { kind: "disconnect", text: "断流前片段" },
			},
		]);
		const response = await post(server, {
			model: "minimax-code/MiniMax-M3.1-Flash",
			stream: true,
			messages: [{ role: "user", content: "你是主控" }],
			tools: [{ type: "function", function: { name: "pao_start_flow" } }],
		});
		const text = await response.text();
		expect(text).toContain("断流前片段");
		expect(text).not.toContain("finish_reason");
		expect(text).not.toContain("[DONE]");
	});

	it("证据日志脱敏认证与密钥字段", async () => {
		const { server, evidenceDir } = await start([
			{
				id: "main-text",
				match: { role: "main" },
				respond: { kind: "text", text: "已记录" },
			},
		]);
		await post(server, {
			model: "minimax-code/MiniMax-M3.1-Flash",
			messages: [
				{
					role: "user",
					content: "你是主控",
					api_key: "secret-api-key",
					credential: { password: "secret-password" },
				},
			],
			tools: [{ type: "function", function: { name: "pao_start_flow" } }],
		});
		const logged = readFileSync(join(evidenceDir, "requests.jsonl"), "utf8");
		expect(logged).toContain('"api_key":"[REDACTED]"');
		expect(logged).toContain('"credential":"[REDACTED]"');
		expect(logged).not.toContain("secret-api-key");
		expect(logged).not.toContain("secret-password");
		expect(logged).not.toContain("never-log-this");
	});

	it("按角色、工具和阶段选择响应，并记录识别出的阶段", async () => {
		const { server, evidenceDir } = await start([
			{
				id: "worker-write-implementation",
				match: { role: "worker", tool: "write", stage: "实施" },
				respond: {
					kind: "tool_call",
					call: { name: "write", arguments: { path: "结果.txt" } },
				},
			},
			{
				id: "worker-text-review",
				match: { role: "worker", stage: "审核" },
				respond: { kind: "text", text: "审核完成" },
			},
		]);
		const response = await post(server, {
			model: "minimax-code/MiniMax-M3.1-Flash",
			messages: [
				{ role: "user", content: "阶段：审核" },
				{ role: "user", content: "阶段: 实施" },
			],
			tools: [{ type: "function", function: { name: "write" } }],
		});
		expect(response.status).toBe(200);
		const payload = await readChatCompletion(response);
		expect(payload.choices[0]?.message.tool_calls?.[0]?.function.name).toBe("write");
		const asciiResponse = await post(server, {
			model: "minimax-code/MiniMax-M3.1-Flash",
			messages: [
				{ role: "system", content: "stage=impl" },
				{ role: "user", content: "执行卡0001" },
			],
			tools: [{ type: "function", function: { name: "write" } }],
		});
		expect(asciiResponse.status).toBe(200);
		const asciiPayload = await readChatCompletion(asciiResponse);
		expect(asciiPayload.choices[0]?.message.tool_calls?.[0]?.function.name).toBe("write");
		const logged = readFileSync(join(evidenceDir, "requests.jsonl"), "utf8");
		expect(logged).toContain('"stage":"实施"');
		expect(logged).toContain('"matchedRule":"worker-write-implementation"');
	});

	it("部长提示引用主控会话和绑定节点时仍按部长专用工具识别", async () => {
		const { server, evidenceDir } = await start([
			{
				id: "minister-node",
				match: { role: "minister" },
				respond: { kind: "text", text: "部长节点已保存" },
			},
		]);
		const response = await post(server, {
			model: "minimax-code/MiniMax-M3.1-Flash",
			messages: [
				{
					role: "user",
					content: "主控会话要求你绑定节点；你是当前部长",
				},
			],
			tools: [
				{ type: "function", function: { name: "read" } },
				{ type: "function", function: { name: "pao_minister_save_node_map" } },
			],
		});
		expect(response.status).toBe(200);
		const logged = JSON.parse(
			readFileSync(join(evidenceDir, "requests.jsonl"), "utf8").trim().split("\n").at(-1) ?? "{}",
		);
		expect(logged).toMatchObject({
			role: "minister",
			roleEvidence: {
				kind: "tool",
				name: "pao_minister_save_node_map",
			},
		});
	});

	it("worker 提示引用主控会话和绑定节点时仍按工人结果工具识别", async () => {
		const { server, evidenceDir } = await start([
			{
				id: "worker-receipt",
				match: { role: "worker" },
				respond: { kind: "text", text: "工人回执完成" },
			},
		]);
		const response = await post(server, {
			model: "minimax-code/MiniMax-M3.1-Flash",
			messages: [
				{
					role: "user",
					content: "主控会话已指定绑定节点；worker 完成回执",
				},
			],
			tools: [
				{ type: "function", function: { name: "write" } },
				{ type: "function", function: { name: "pao_submit_receipt" } },
			],
		});
		expect(response.status).toBe(200);
		const logged = JSON.parse(
			readFileSync(join(evidenceDir, "requests.jsonl"), "utf8").trim().split("\n").at(-1) ?? "{}",
		);
		expect(logged).toMatchObject({
			role: "worker",
			roleEvidence: {
				kind: "tool",
				name: "pao_submit_receipt",
			},
		});
	});

	it("HTTP 错误注入返回真实 503 响应", async () => {
		const { server } = await start([
			{
				id: "provider-503",
				match: { role: "worker" },
				respond: { kind: "http_error", status: 503, message: "脚本注入的上游故障" },
			},
		]);
		const response = await post(server, {
			model: "minimax-code/MiniMax-M3.1-Flash",
			messages: [{ role: "user", content: "工人执行任务" }],
		});
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: { message: "脚本注入的上游故障" },
		});
	});

	it("规则乱序返回 409 并列出缺失前置规则", async () => {
		const { server } = await start([
			{
				id: "must-run-first",
				match: { role: "main", stage: "规划" },
				respond: { kind: "text", text: "前置" },
			},
			{
				id: "must-run-second",
				match: { role: "main", afterRule: "must-run-first" },
				respond: { kind: "text", text: "后置" },
			},
		]);
		const response = await post(server, {
			model: "minimax-code/MiniMax-M3.1-Flash",
			messages: [{ role: "user", content: "你是主控\n阶段：实施" }],
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			error: {
				type: "scripted_model_out_of_order",
				rule: "must-run-second",
				missing_prerequisites: ["must-run-first"],
			},
		});
	});

	it("返回请求未开放的工具时明确失败", async () => {
		const { server } = await start([
			{
				id: "forbidden-write",
				match: { role: "worker" },
				respond: {
					kind: "tool_call",
					call: { name: "write", arguments: { path: "结果.txt" } },
				},
			},
		]);
		const response = await post(server, {
			model: "minimax-code/MiniMax-M3.1-Flash",
			messages: [{ role: "user", content: "工人执行任务" }],
			tools: [{ type: "function", function: { name: "read" } }],
		});
		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({
			error: {
				type: "scripted_model_unknown_tool",
				tool: "write",
				available_tools: ["read"],
			},
		});
	});

	it("产品 pi-ai openai-completions 客户端通过真实 HTTP 得到工具调用和文本", async () => {
		const { server } = await start([
			{
				id: "client-write-implementation",
				match: { role: "worker", tool: "write", stage: "实施" },
				respond: {
					kind: "tool_call",
					call: {
						name: "write",
						arguments: { path: "客户结果.txt", content: "客户端调用完成\n" },
					},
				},
			},
			{
				id: "client-text",
				match: { role: "worker", stage: "审核" },
				respond: { kind: "text", text: "固定文本：审核完成" },
			},
		]);
		const model = {
			id: "minimax-code/MiniMax-M3.1-Flash",
			name: "本机脚本模型",
			provider: "harbor-endpoint",
			api: "openai-completions",
			baseUrl: server.baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		} satisfies Model<"openai-completions">;
		const writeTool = {
			name: "write",
			description: "写入经过验收的临时业务结果",
			parameters: Type.Object({
				path: Type.String(),
				content: Type.String(),
			}),
		};
		const toolResult = await completeSimple(
			model,
			{
				systemPrompt: "你是工人",
				messages: [
					{
						role: "user",
						content: "阶段：实施\n执行卡0001",
						timestamp: Date.now(),
					},
				],
				tools: [writeTool],
			},
			{ apiKey: "local-fake-key", maxRetries: 0 },
		);
		expect(toolResult.stopReason).toBe("toolUse");
		expect(toolResult.content).toContainEqual(
			expect.objectContaining({
				type: "toolCall",
				name: "write",
				arguments: { path: "客户结果.txt", content: "客户端调用完成\n" },
			}),
		);
		expect(toolResult.usage.input).toBe(1);
		expect(toolResult.usage.output).toBe(1);

		const textResult = await completeSimple(
			model,
			{
				systemPrompt: "你是工人",
				messages: [
					{
						role: "user",
						content: "阶段：审核",
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: "local-fake-key", maxRetries: 0 },
		);
		expect(textResult.stopReason).toBe("stop");
		expect(textResult.content).toContainEqual({
			type: "text",
			text: "固定文本：审核完成",
		});
	});

	it("产品 pi-ai 客户端以 tool_call_id 反查工具名并完成真实第二轮往返", async () => {
		const { server, evidenceDir } = await start([
			{
				id: "client-after-write",
				match: { role: "worker", latestToolName: "write" },
				respond: { kind: "text", text: "固定文本：写入结果已收到" },
			},
			{
				id: "client-write-first",
				match: { role: "worker", tool: "write", stage: "实施" },
				respond: {
					kind: "tool_call",
					call: {
						name: "write",
						arguments: { path: "往返结果.txt", content: "固定模拟工具结果\n" },
					},
				},
			},
		]);
		const model = {
			id: "minimax-code/MiniMax-M3.1-Flash",
			name: "本机脚本模型",
			provider: "harbor-endpoint",
			api: "openai-completions",
			baseUrl: server.baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		} satisfies Model<"openai-completions">;
		const writeTool = {
			name: "write",
			description: "写入固定模拟工具结果",
			parameters: Type.Object({
				path: Type.String(),
				content: Type.String(),
			}),
		};
		const firstUser = {
			role: "user" as const,
			content: "阶段：实施\n执行往返卡",
			timestamp: Date.now(),
		};
		const first = await completeSimple(
			model,
			{
				systemPrompt: "你是工人",
				messages: [firstUser],
				tools: [writeTool],
			},
			{ apiKey: "local-fake-key", maxRetries: 0 },
		);
		expect(first.stopReason).toBe("toolUse");
		const toolCall = first.content.find((block) => block.type === "toolCall");
		expect(toolCall).toMatchObject({
			type: "toolCall",
			name: "write",
			arguments: { path: "往返结果.txt", content: "固定模拟工具结果\n" },
		});
		if (!toolCall || toolCall.type !== "toolCall") {
			throw new Error("第一轮没有返回可继续的工具调用");
		}

		const second = await completeSimple(
			model,
			{
				systemPrompt: "你是工人",
				messages: [
					firstUser,
					first,
					{
						role: "toolResult",
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						content: [{ type: "text", text: "固定模拟工具执行完成" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
				tools: [writeTool],
			},
			{ apiKey: "local-fake-key", maxRetries: 0 },
		);
		expect(second.stopReason).toBe("stop");
		expect(second.content).toContainEqual({
			type: "text",
			text: "固定文本：写入结果已收到",
		});
		const requests = readFileSync(join(evidenceDir, "requests.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as unknown);
		const lastRequest = requests.at(-1);
		expect(lastRequest).toMatchObject({
			latestTool: {
				name: "write",
				content: "固定模拟工具执行完成",
				toolCallId: toolCall.id,
			},
			matchedRule: "client-after-write",
		});
		if (!isRecord(lastRequest) || !Array.isArray(lastRequest.messages)) {
			throw new Error("第二轮请求证据缺少消息数组");
		}
		const secondToolMessage = lastRequest.messages.find((message) => isRecord(message) && message.role === "tool");
		expect(secondToolMessage).toMatchObject({
			role: "tool",
			tool_call_id: toolCall.id,
			content: "固定模拟工具执行完成",
		});
		expect(secondToolMessage).not.toHaveProperty("name");
	});

	it("最新工具名为空字符串时只匹配尚未发生工具往返的请求", async () => {
		const { server, evidenceDir } = await start([
			{
				id: "before-tool",
				match: { role: "main", latestToolName: "" },
				respond: { kind: "text", text: "首次请求" },
			},
			{
				id: "after-start",
				match: { role: "main", latestToolName: "pao_start_flow" },
				respond: { kind: "text", text: "工具回执后停止" },
			},
		]);
		const baseMessages = [
			{ role: "user", content: "执行正常链" },
		];
		const first = await post(server, {
			model: "minimax-code/MiniMax-M3.1-Flash",
			messages: baseMessages,
			tools: [{ type: "function", function: { name: "pao_start_flow" } }],
		});
		expect(first.status).toBe(200);
		expect((await readChatCompletion(first)).choices[0]?.message.content).toBe("首次请求");

		const second = await post(server, {
			model: "minimax-code/MiniMax-M3.1-Flash",
			messages: [
				...baseMessages,
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call-start",
							type: "function",
							function: { name: "pao_start_flow", arguments: "{}" },
						},
					],
				},
				{
					role: "tool",
					tool_call_id: "call-start",
					content: "工作流已启动",
				},
			],
			tools: [{ type: "function", function: { name: "pao_start_flow" } }],
		});
		expect(second.status).toBe(200);
		expect((await readChatCompletion(second)).choices[0]?.message.content).toBe("工具回执后停止");
		const requests = readFileSync(join(evidenceDir, "requests.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { matchedRule?: string });
		expect(requests.map((request) => request.matchedRule)).toEqual(["before-tool", "after-start"]);
	});

	it("tool 消息显式 name 与 tool_call_id 反查结果不一致时明确拒绝", async () => {
		const { server } = await start([
			{
				id: "worker-after-write",
				match: { role: "worker", latestToolName: "write" },
				respond: { kind: "text", text: "不应猜测命中" },
			},
		]);
		const response = await post(server, {
			model: "minimax-code/MiniMax-M3.1-Flash",
			messages: [
				{ role: "user", content: "你是工人" },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call-mismatch",
							type: "function",
							function: { name: "write", arguments: "{}" },
						},
					],
				},
				{
					role: "tool",
					name: "edit",
					tool_call_id: "call-mismatch",
					content: "固定模拟工具结果",
				},
			],
			tools: [{ type: "function", function: { name: "write" } }],
		});
		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({
			error: {
				type: "scripted_model_tool_result_name_mismatch",
				tool_call_id: "call-mismatch",
				explicit_name: "edit",
				resolved_name: "write",
			},
		});
	});

	it("关闭服务后同一端口可重新绑定", async () => {
		const { server } = await start([
			{
				id: "main-text",
				match: { role: "main" },
				respond: { kind: "text", text: "关闭" },
			},
		]);
		const { host, port } = server;
		await server.close();
		const probe = createServer();
		await new Promise<void>((resolvePromise, reject) => {
			probe.once("error", reject);
			probe.listen(port, host, () => resolvePromise());
		});
		await new Promise<void>((resolvePromise, reject) => {
			probe.close((error) => (error ? reject(error) : resolvePromise()));
		});
	});

	it("拒绝非回环监听地址", async () => {
		const f = fixture([]);
		await expect(
			createScriptedModelServer({
				scenarioPath: f.scenarioPath,
				evidenceDir: f.evidenceDir,
				host: "localhost",
			}),
		).rejects.toThrow("只允许监听 127.0.0.1");
	});
});
