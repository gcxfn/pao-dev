/**
 * 体检探针(M0-07):对当前会话模型做端点冒烟——固定探针表四条:
 * 普通对话/工具调用(两跳)/思考档;逼近上下文上限是深度开关项,默认跳过(最贵的一条)。
 * 探针只依赖注入的「体检调用器」;真实网络与鉴权由接线层组装,测试注入脚本化假件,
 * 密钥永不进测试环境(R10/需求 §8)。
 */
import type { AssistantMessage, Message, Model, Tool, Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";

/** 体检调用选项:随一次补全下发的参数 */
export interface HealthcheckCallOptions {
	/** 工具声明(工具调用探针用) */
	tools?: Tool[];
	/** 请求思考档;省略 = 不带思考参数 */
	reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	maxTokens?: number;
	/** 缓存留存偏好;省略 = 接线层缺省(冒烟探针不写缓存);缓存探针显式传 "short" */
	cacheRetention?: "none" | "short" | "long";
}

/** 体检调用器:一次模型补全。接线层绑真实模型与鉴权;测试注入假件 */
export type HealthcheckCaller = (messages: Message[], options?: HealthcheckCallOptions) => Promise<AssistantMessage>;

export type ProbeStatus = "通过" | "失败" | "跳过" | "观察完成";

export interface ProbeResult {
	探针: string;
	状态: ProbeStatus;
	/** 失败原因/跳过原因/观察结论 */
	说明?: string;
	观察: string[];
	/** 本探针各次调用的用量合计 */
	用量: Usage;
	持续毫秒?: number;
}

const PROBE_TOOL_NAME = "pao_health_probe";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 文本截断,观察行防刷屏 */
export function truncateText(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function concatTextBlocks(reply: AssistantMessage): string {
	return reply.content
		.filter((block): block is Extract<(typeof reply.content)[number], { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("")
		.trim();
}

export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function addUsage(sum: Usage, once: Usage | undefined): void {
	if (!once) return;
	sum.input += once.input ?? 0;
	sum.output += once.output ?? 0;
	sum.cacheRead += once.cacheRead ?? 0;
	sum.cacheWrite += once.cacheWrite ?? 0;
	sum.totalTokens += once.totalTokens ?? 0;
	sum.cost.input += once.cost?.input ?? 0;
	sum.cost.output += once.cost?.output ?? 0;
	sum.cost.cacheRead += once.cost?.cacheRead ?? 0;
	sum.cost.cacheWrite += once.cost?.cacheWrite ?? 0;
	sum.cost.total += once.cost?.total ?? 0;
	if (once.reasoning !== undefined) sum.reasoning = (sum.reasoning ?? 0) + once.reasoning;
}

function failureResult(probe: string, error: unknown, startedAt: number, usage: Usage): ProbeResult {
	return {
		探针: probe,
		状态: "失败",
		说明: "调用抛错",
		观察: [truncateText(errorMessage(error), 200)],
		用量: usage,
		持续毫秒: Date.now() - startedAt,
	};
}

/** 探针一:普通对话——最小问答,拿到非空文本即通过 */
export async function probeChat(call: HealthcheckCaller): Promise<ProbeResult> {
	const startedAt = Date.now();
	const usage = emptyUsage();
	try {
		const reply = await call([{ role: "user", content: "用一句话回答:1 加 1 等于几?", timestamp: Date.now() }], {
			maxTokens: 200,
		});
		addUsage(usage, reply.usage);
		const text = concatTextBlocks(reply);
		return {
			探针: "普通对话",
			状态: text.length > 0 ? "通过" : "失败",
			说明: text.length > 0 ? undefined : "回复里没有任何文本内容",
			观察: [`首答 ${text.length} 字:${truncateText(text, 60)}`, `停止原因 ${reply.stopReason}`],
			用量: usage,
			持续毫秒: Date.now() - startedAt,
		};
	} catch (error) {
		return failureResult("普通对话", error, startedAt, usage);
	}
}

/**
 * 探针二:工具调用两跳——首跳给工具声明看模型是否发起调用;
 * 第二跳回工具结果,看模型是否把结果消费进答案(需求 §8「结果消费」,不是只看调用到达)。
 */
export async function probeToolCall(call: HealthcheckCaller): Promise<ProbeResult> {
	const startedAt = Date.now();
	const usage = emptyUsage();
	const tool: Tool = {
		name: PROBE_TOOL_NAME,
		description: "体检专用工具:返回参数甲的两倍。需要知道结果时必须调用它。",
		parameters: Type.Object({ 甲: Type.Number({ description: "要翻倍的数" }) }),
	};
	const promptMessages: Message[] = [
		{
			role: "user",
			content: `请调用工具 ${PROBE_TOOL_NAME}(参数 甲=42),用它返回的结果回答:结果是多少?只答数字。`,
			timestamp: Date.now(),
		},
	];
	try {
		const firstHop = await call(promptMessages, { tools: [tool], maxTokens: 500 });
		addUsage(usage, firstHop.usage);
		const toolCallHit = firstHop.content.find(
			(block): block is Extract<(typeof firstHop.content)[number], { type: "toolCall" }> =>
				block.type === "toolCall",
		);
		if (!toolCallHit) {
			return {
				探针: "工具调用",
				状态: "失败",
				说明: "模型未发起工具调用(首跳无 toolCall 块)",
				观察: [
					`首跳停止原因 ${firstHop.stopReason}`,
					`首跳文本:${truncateText(concatTextBlocks(firstHop) || "(空)", 60)}`,
				],
				用量: usage,
				持续毫秒: Date.now() - startedAt,
			};
		}
		const doubledInput = typeof toolCallHit.arguments?.甲 === "number" ? toolCallHit.arguments.甲 : 42;
		const doubledValue = doubledInput * 2;
		const secondHop = await call(
			[
				...promptMessages,
				firstHop,
				{
					role: "toolResult",
					toolCallId: toolCallHit.id,
					toolName: toolCallHit.name,
					content: [{ type: "text", text: String(doubledValue) }],
					isError: false,
					timestamp: Date.now(),
				},
			],
			{ tools: [tool], maxTokens: 200 },
		);
		addUsage(usage, secondHop.usage);
		const answer = concatTextBlocks(secondHop);
		const consumed = answer.includes(String(doubledValue));
		return {
			探针: "工具调用",
			状态: consumed ? "通过" : "失败",
			说明: consumed ? undefined : `模型调用了工具但未消费结果(答案里没有 ${doubledValue})`,
			观察: [
				`工具命中:${toolCallHit.name}(甲=${doubledInput})`,
				`第二跳答案:${truncateText(answer || "(空)", 60)}`,
				`停止原因 ${secondHop.stopReason}`,
			],
			用量: usage,
			持续毫秒: Date.now() - startedAt,
		};
	} catch (error) {
		return failureResult("工具调用", error, startedAt, usage);
	}
}

/**
 * 探针三:思考档——请求 high 档一次,如实三分:支持(有思考块)/被接受但无思考内容/不支持或被忽略。
 * 通过与否不取决于模型会不会思考,取决于是否拿到明确结论(G0-04:支持/不支持/被忽略如实区分)。
 */
export async function probeReasoning(call: HealthcheckCaller, model: Model<any>): Promise<ProbeResult> {
	const startedAt = Date.now();
	const usage = emptyUsage();
	try {
		const reply = await call([{ role: "user", content: "用一句话说明:为什么天空是蓝的?", timestamp: Date.now() }], {
			reasoning: "high",
			maxTokens: 4096,
		});
		addUsage(usage, reply.usage);
		const thinkingBlocks = reply.content.filter(
			(block): block is Extract<(typeof reply.content)[number], { type: "thinking" }> => block.type === "thinking",
		);
		const thinkingChars = thinkingBlocks.reduce((sum, block) => sum + block.thinking.length, 0);
		let verdict: string;
		if (thinkingBlocks.length > 0) {
			verdict = `支持:返回 ${thinkingBlocks.length} 个思考块(共 ${thinkingChars} 字)`;
		} else if (reply.providerThinkingLevel !== undefined || reply.thinkingLevel !== undefined) {
			verdict = "请求被接受但无思考内容(档位声明到达,内容可能被服务商丢弃)";
		} else {
			verdict = "不支持或被忽略:正常返回、无思考内容、无档位回标";
		}
		return {
			探针: "思考档",
			状态: "观察完成",
			说明: verdict,
			观察: [
				`模型目录声明 reasoning=${String(model.reasoning)}`,
				`请求 high;响应 thinkingLevel=${reply.thinkingLevel ?? "未标"},providerThinkingLevel=${reply.providerThinkingLevel ?? "未标"}`,
				`停止原因 ${reply.stopReason}`,
			],
			用量: usage,
			持续毫秒: Date.now() - startedAt,
		};
	} catch (error) {
		return failureResult("思考档", error, startedAt, usage);
	}
}

/**
 * 探针四(深度开关,默认跳过):逼近上下文上限——发约 1.1 倍窗口的输入,
 * 看溢出行为是否可识别(G0-05:受控模拟、标明类型)。被明确拒绝且错误可归类 = 通过;
 * 静默接受或不可归类的报错如实记录。
 */
export async function probeContextLimit(call: HealthcheckCaller, model: Model<any>): Promise<ProbeResult> {
	const contextWindow = model.contextWindow;
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
		return { 探针: "逼近上下文上限", 状态: "跳过", 说明: "模型未声明上下文窗口", 观察: [], 用量: emptyUsage() };
	}
	const startedAt = Date.now();
	const usage = emptyUsage();
	// 粗估 4 字符≈1 token(纯数字串);宁可略超以触发溢出
	const targetTokens = Math.ceil(contextWindow * 1.1);
	const filler = "0123456789".repeat(Math.ceil((targetTokens * 4) / 10));
	try {
		const reply = await call(
			[{ role: "user", content: `${filler}\n\n上面是一长串数字。请只回答:OK`, timestamp: Date.now() }],
			{ maxTokens: 16 },
		);
		addUsage(usage, reply.usage);
		return {
			探针: "逼近上下文上限",
			状态: "观察完成",
			说明: "约 1.1 倍窗口的超大输入未被拒绝(服务端可能内部截断);日常大上下文行为待真实任务确认",
			观察: [`输入约 ${targetTokens} token;停止原因 ${reply.stopReason}`],
			用量: usage,
			持续毫秒: Date.now() - startedAt,
		};
	} catch (error) {
		const message = errorMessage(error);
		const limitLike = /context|token|length|too long|maximum|exceed|input/i.test(message);
		return {
			探针: "逼近上下文上限",
			状态: limitLike ? "通过" : "失败",
			说明: limitLike ? "溢出被明确拒绝,错误可识别" : "报错但不像上下文超限,未能归类",
			观察: [truncateText(message, 200)],
			用量: usage,
			持续毫秒: Date.now() - startedAt,
		};
	}
}

/** 按固定顺序跑探针表;深度=false 时第四条记跳过(不花钱) */
export async function runHealthcheck(
	call: HealthcheckCaller,
	model: Model<any>,
	options: { 深度?: boolean } = {},
): Promise<ProbeResult[]> {
	const results = [await probeChat(call), await probeToolCall(call), await probeReasoning(call, model)];
	if (options.深度) {
		results.push(await probeContextLimit(call, model));
	} else {
		results.push({
			探针: "逼近上下文上限",
			状态: "跳过",
			说明: "深度开关未开(最贵的一条,默认跳过;开深度=true 才跑)",
			观察: [],
			用量: emptyUsage(),
		});
	}
	return results;
}
