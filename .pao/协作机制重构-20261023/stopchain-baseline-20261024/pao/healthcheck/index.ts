/**
 * pao_health_check 工具(M0-07):GLM 端点冒烟——固定探针表(普通对话/工具调用/思考档),
 * 逼近上下文上限为深度开关默认跳过;结果按架构 §6.2「评测」条目格式落盘
 * (部门知识库未建前暂存 .pao/体检/,即第一条评测条目的种子)。
 * 真跑即 M0-06 验收的机械化补充;密钥只在调用层经手,不进报告/日志/测试。
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";

import type { ExtensionAPI, ToolDefinition } from "../../core/extensions/types.ts";
import type { ResolvedRequestAuth } from "../../core/model-registry.ts";
import { resolvePaoHome } from "../routing/config.ts";
import { readJsonSafe } from "../shared/json.ts";
import { nowString } from "../shared/time.ts";
import {
	type CacheProbeResult,
	type ProbeClock,
	realClock,
	renderCacheProbeReport,
	runCacheProbe,
	validateCacheProbeParams,
} from "./cache-probe.ts";
import { type HealthcheckCaller, type HealthcheckCallOptions, runHealthcheck } from "./probes.ts";
import { type HealthcheckReport, sumProbeUsage, writeEvalEntry } from "./report.ts";

export * from "./cache-probe.ts";
export * from "./probes.ts";
export * from "./report.ts";

/** 工具执行结果 details:报告 + 落盘路径(+ 显式跑过时的缓存探针结果,纯文本不落盘) */
export interface HealthcheckReportWithPaths extends HealthcheckReport {
	out_path: string;
	cache_probe?: CacheProbeResult;
}

export interface PaoHealthcheckOptions {
	/** 测试注入:覆盖真实调用器工厂(免网络免密钥) */
	resolveCaller?: (
		model: Model<any>,
		auth: ResolvedRequestAuth | undefined,
		signal: AbortSignal | undefined,
	) => HealthcheckCaller;
	/** 覆盖落盘目录(缺省 $PAO_HOME/.pao/体检) */
	resolveOutDir?: () => string;
	/** 测试注入:覆盖缓存探针时钟(免真实等待;调用器走 resolveCaller) */
	resolve缓存时钟?: () => ProbeClock;
}

const HealthcheckParams = Type.Object({
	deep: Type.Optional(
		Type.Boolean({
			description:
				"加跑「逼近上下文上限」探针(最贵的一条,约消耗 1.1 倍窗口的输入 token);缺省 false 只跑三条便宜探针",
		}),
	),
	cache_probe: Type.Optional(
		Type.Object(
			{
				context_chars: Type.Integer({
					description: "固定上下文的填充字符数(粗估 4 字符≈1 token);每次采样整包重发、按输入计费",
					minimum: 1,
				}),
				sample_points: Type.Array(Type.Number({ description: "相对首采样的延迟秒(绝对偏移,按升序执行)" }), {
					description: "重发采样的延迟秒序列,如 [30, 120, 600];每次采样都是一次真实补全请求",
					minItems: 1,
				}),
				decay_threshold: Type.Optional(
					Type.Number({
						description:
							"判定衰减的缓存命中率阈值(0-1,相对首个成功读缓存的采样;冷启动首采样只写不读,不作参照);缺省 0.5",
						exclusiveMinimum: 0,
						maximum: 1,
					}),
				),
			},
			{
				description:
					"缓存衰减探针:对同一固定上下文按延迟序列重发补全,记录每次 usage 并输出缓存衰减曲线(纯文本,不落盘)。缺省绝不触发——每次采样都是真实计费的 API 请求,只在确实要测供应商 prompt/KV 缓存衰减时才传",
			},
		),
	),
	out_dir: Type.Optional(Type.String({ description: "评测条目落盘目录;缺省 $PAO_HOME/.pao/体检" })),
});

const HEALTHCHECK_SYSTEM_PROMPT = "你是端点体检的目标模型。如实、简短作答,不做多余客套。";

/** 真实调用器:绑当前会话模型与注册表鉴权,一次性补全(冒烟探针不写缓存;缓存探针显式要 short) */
function defaultCaller(
	model: Model<any>,
	auth: ResolvedRequestAuth | undefined,
	signal: AbortSignal | undefined,
): HealthcheckCaller {
	return (messages, options) =>
		completeSimple(
			model,
			{ systemPrompt: HEALTHCHECK_SYSTEM_PROMPT, messages, tools: options?.tools },
			{
				apiKey: auth?.ok ? auth.apiKey : undefined,
				headers: auth?.ok ? auth.headers : undefined,
				signal,
				maxTokens: options?.maxTokens,
				reasoning: options?.reasoning,
				cacheRetention: options?.cacheRetention ?? "none",
				timeoutMs: 120_000,
			},
		);
}

function readCodingAgentVersion(): string {
	const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "package.json");
	const parsed = readJsonSafe(pkgPath) as { version?: unknown } | undefined;
	const version = parsed?.version;
	return typeof version === "string" ? version : "未知";
}

function summarize(report: HealthcheckReport, outPath: string): string {
	const failed = report.probes.filter((item) => item.状态 === "失败");
	const header =
		`体检完成(${report.model.name},${report.calls} 次模型调用):` +
		(failed.length === 0 ? "无失败" : `${failed.length} 项失败——${failed.map((item) => item.探针).join("、")}`);
	const lines = report.probes.map((item) => `- ${item.探针}:${item.状态}${item.说明 ? `(${item.说明})` : ""}`);
	return [
		header,
		...lines,
		`总用量:输入 ${report.total_usage.input} / 输出 ${report.total_usage.output} token`,
		`评测条目已落盘:${outPath}`,
	].join("\n");
}

function buildHealthcheckTool(
	options: PaoHealthcheckOptions,
): ToolDefinition<typeof HealthcheckParams, HealthcheckReportWithPaths> {
	return {
		name: "pao_health_check",
		label: "端点体检",
		description:
			"对当前会话模型做端点冒烟体检:普通对话/工具调用(两跳含结果消费)/思考档三条固定探针,结果按评测条目格式落盘到 $PAO_HOME/.pao/体检/。深度=true 加跑「逼近上下文上限」(最贵,默认跳过)。缓存探针(显式选填)对同一固定上下文按延迟序列重发补全并输出缓存衰减曲线——缺省绝不触发:每次采样都是真实计费的 API 请求,只在确实要测供应商缓存衰减供预热择时才传。换端点/换模型/升级后跑一次,得到可入库的实测记录。",
		parameters: HealthcheckParams,
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			const model = ctx?.model;
			if (!model) {
				throw new Error("当前会话没有选中模型,pao_health_check 需要在可用模型的会话里跑(先选一个模型)");
			}
			// 缓存探针参数先校验:不合法就在任何计费请求(包括冒烟探针)之前报错
			if (params.cache_probe) validateCacheProbeParams(params.cache_probe);
			let auth: ResolvedRequestAuth | undefined;
			let authDesc = "未从注册表解析到 key,走环境变量兜底";
			try {
				auth = await ctx.modelRegistry?.getApiKeyAndHeaders(model);
				if (auth?.ok && auth.apiKey) authDesc = "modelRegistry 解析到 key(值不记录)";
				else if (auth && !auth.ok) authDesc = `注册表解析失败:${auth.error}`;
			} catch (error) {
				authDesc = `注册表解析异常:${error instanceof Error ? error.message : String(error)}`;
			}

			const baseCaller = options.resolveCaller?.(model, auth, signal) ?? defaultCaller(model, auth, signal);
			let callCount = 0;
			const countingCaller = async (
				messages: Parameters<HealthcheckCaller>[0],
				opts?: HealthcheckCallOptions,
			): Promise<AssistantMessage> => {
				callCount++;
				return baseCaller(messages, opts);
			};

			const probeResults = await runHealthcheck(countingCaller, model, { 深度: params.deep === true });
			const outDir = params.out_dir ?? options.resolveOutDir?.() ?? join(resolvePaoHome(), ".pao", "体检");
			const report: HealthcheckReport = {
				time: nowString(),
				model: {
					id: model.id,
					name: model.name,
					provider: model.provider,
					baseUrl: model.baseUrl,
					contextWindow: model.contextWindow,
					reasoning: model.reasoning,
				},
				auth: authDesc,
				probes: probeResults,
				total_usage: sumProbeUsage(probeResults),
				calls: callCount,
			};
			const outPath = writeEvalEntry(outDir, report, {
				pi_version: readCodingAgentVersion(),
				platform: `${process.platform}/${process.version}`,
			});
			// 缓存衰减探针:显式选填才跑(每次采样真实计费);走基础调用器,不计入体检报告的
			// 调用次数/总用量(那份口径要落盘入库),探针结果只以纯文本回给调用方,不落盘。
			let cacheProbeResult: CacheProbeResult | undefined;
			const textBlocks: { type: "text"; text: string }[] = [{ type: "text", text: summarize(report, outPath) }];
			if (params.cache_probe) {
				const clock = options.resolve缓存时钟?.() ?? realClock(signal);
				cacheProbeResult = await runCacheProbe(baseCaller, clock, params.cache_probe);
				textBlocks.push({ type: "text", text: renderCacheProbeReport(cacheProbeResult) });
			}
			const details: HealthcheckReportWithPaths = {
				...report,
				out_path: outPath,
				...(cacheProbeResult ? { cache_probe: cacheProbeResult } : {}),
			};
			return { content: textBlocks, details };
		},
	};
}

export function registerHealthcheck(pi: ExtensionAPI, options: PaoHealthcheckOptions = {}): void {
	pi.registerTool(buildHealthcheckTool(options));
}
