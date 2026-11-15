/**
 * 缓存衰减探针(pao_health_check 显式选填项,只建机制、不主动跑):对同一固定上下文按给定
 * 延迟序列重发补全请求,逐次记录 usage(input/output/cacheRead/cacheWrite/cost),
 * 输出衰减曲线纯文本 + 末尾结论(衰减到阈值以下的首个间隔),供「空闲会话缓存预热」择时。
 *
 * 铁律:每次采样都是真实计费的 API 请求,工具参数 缓存探针 缺省绝不触发。
 * 时钟与「发一次请求」全部注入,本模块不做任何网络/落盘;单点采样失败只记失败,不炸整份报告。
 */
import type { Message, Usage } from "@earendil-works/pi-ai";

import { addUsage, emptyUsage, type HealthcheckCaller, type HealthcheckCallOptions, truncateText } from "./probes.ts";

/** 探针时钟:now 取当前毫秒时戳;sleep 等待指定毫秒(测试注入即时兑现的假件) */
export interface ProbeClock {
	now(): number;
	sleep(ms: number): Promise<void>;
}

/** 真实时钟:sleep 可被中止信号打断(采样间隔可能等几分钟,必须能取消) */
export function realClock(signal?: AbortSignal): ProbeClock {
	return {
		now: () => Date.now(),
		sleep: (ms: number) =>
			new Promise<void>((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("缓存探针已中止"));
					return;
				}
				const cleanup = () => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
				};
				const onAbort = () => {
					cleanup();
					reject(new Error("缓存探针已中止"));
				};
				const timer = setTimeout(() => {
					cleanup();
					resolve();
				}, ms);
				signal?.addEventListener("abort", onAbort, { once: true });
			}),
	};
}

/** 缓存探针参数(pao_health_check 工具的显式选填 缓存探针 参数;缺省绝不触发) */
export interface CacheProbeParams {
	/** 固定上下文填充字符数(粗估 4 字符≈1 token),每次采样整包重发、按输入计费 */
	context_chars: number;
	/** 采样延迟秒序列:相对首采样的绝对偏移(如 [30, 120, 600]),按升序执行 */
	sample_points: number[];
	/** 判定衰减的命中率阈值(0-1,相对首个成功读缓存的采样;缺省 0.5) */
	decay_threshold?: number;
}

export interface CacheSampleRecord {
	/** 相对首采样起点的偏移秒(首采样固定 0) */
	偏移秒: number;
	状态: "成功" | "失败";
	/** 成功时的单次用量 */
	用量?: Usage;
	/** 相对基线(首个成功读缓存的采样)的缓存命中率:本采样 cacheRead / 基线 cacheRead;基线缺失或本采样在基线之前(纯写方)时 undefined */
	命中率?: number;
	/** 失败原因 */
	说明?: string;
}

export interface CacheProbeResult {
	上下文字符数: number;
	衰减阈值: number;
	采样: CacheSampleRecord[];
	/** 成功采样的用量合计 */
	总用量: Usage;
}

export const DEFAULT_DECAY_THRESHOLD = 0.5;

/** 参数校验:不合法即抛错。必须在任何计费请求之前调用(工具壳与跑缓存探针 双保险) */
export function validateCacheProbeParams(params: CacheProbeParams): void {
	if (!Number.isFinite(params.context_chars) || params.context_chars < 1) {
		throw new Error(`缓存探针参数不合法:context_chars 须为正整数,收到 ${params.context_chars}`);
	}
	if (!Array.isArray(params.sample_points) || params.sample_points.length === 0) {
		throw new Error("缓存探针参数不合法:sample_points 不能为空(至少给一个延迟秒,如 [30])");
	}
	for (const delaySeconds of params.sample_points) {
		if (!Number.isFinite(delaySeconds) || delaySeconds < 0) {
			throw new Error(`缓存探针参数不合法:采样点延迟秒须为非负数,收到 ${delaySeconds}`);
		}
	}
	if (
		params.decay_threshold !== undefined &&
		(!Number.isFinite(params.decay_threshold) || params.decay_threshold <= 0 || params.decay_threshold > 1)
	) {
		throw new Error(`缓存探针参数不合法:decay_threshold 须在 (0,1] 区间,收到 ${params.decay_threshold}`);
	}
}

/** 与基线(首采样)的缓存命中率:当前 cacheRead / 基线 cacheRead;基线缺失或为 0 → undefined */
export function cacheHitRate(baseline: Usage | undefined, current: Usage): number | undefined {
	if (!baseline || !(baseline.cacheRead > 0)) return undefined;
	return current.cacheRead / baseline.cacheRead;
}

/**
 * 固定上下文:构造一次、全程复用同一对象(内容与时间戳都不变,避免扰动供应商缓存键)。
 * 纯数字填充同「逼近上下文上限」探针口径(4 字符≈1 token)。
 */
export function buildFixedContext(charCount: number): Message[] {
	const filler = "0123456789".repeat(Math.ceil(charCount / 10)).slice(0, charCount);
	return [
		{
			role: "user",
			content: `${filler}\n\n上面是一段固定内容。请只回答:OK`,
			timestamp: Date.now(),
		},
	];
}

/** 缓存探针专用调用选项:小输出省钱;显式要 short 留存,让供应商真的写 prompt 缓存 */
function probeCallOptions(): HealthcheckCallOptions {
	return { maxTokens: 16, cacheRetention: "short" };
}

/** 单次采样:调一次记一条;抛错记失败(截断防刷屏),不炸整份报告 */
async function sampleOnce(
	call: HealthcheckCaller,
	context: Message[],
	offsetSeconds: number,
): Promise<CacheSampleRecord> {
	try {
		const reply = await call(context, probeCallOptions());
		return { 偏移秒: offsetSeconds, 状态: "成功", 用量: reply.usage ?? emptyUsage() };
	} catch (error) {
		return {
			偏移秒: offsetSeconds,
			状态: "失败",
			说明: truncateText(error instanceof Error ? error.message : String(error), 200),
		};
	}
}

/**
 * 跑缓存衰减探针:首采样(偏移 0)建基线,再按升序延迟逐点重发同一固定上下文。
 * 时钟与调用器都注入;任何单点失败只记失败,继续跑完剩余采样点。
 */
export async function runCacheProbe(
	call: HealthcheckCaller,
	clock: ProbeClock,
	params: CacheProbeParams,
): Promise<CacheProbeResult> {
	validateCacheProbeParams(params);
	const decayThreshold = params.decay_threshold ?? DEFAULT_DECAY_THRESHOLD;
	const context = buildFixedContext(params.context_chars);
	const startAt = clock.now();

	const samples: CacheSampleRecord[] = [await sampleOnce(call, context, 0)];
	for (const delaySeconds of [...params.sample_points].sort((a, b) => a - b)) {
		const waitMs = startAt + delaySeconds * 1000 - clock.now();
		if (waitMs > 0) await clock.sleep(waitMs);
		samples.push(await sampleOnce(call, context, delaySeconds));
	}

	// 基线 = 首个成功「读缓存」的采样(冷启动首采样只写不读,cacheRead=0 不能当参照;
	// 全程无人读到缓存时基线缺失,曲线与结论都如实降级)
	const baselineIndex = samples.findIndex((entry) => entry.状态 === "成功" && (entry.用量?.cacheRead ?? 0) > 0);
	const baselineUsage = baselineIndex >= 0 ? samples[baselineIndex].用量 : undefined;
	// 基线之前的采样是「建立缓存」的写方,没有读可谈 → 命中率 undefined(报告显示 —);
	// 基线之后读到 0 是真衰减到底,照实显示 0.0%
	for (const [index, entry] of samples.entries()) {
		entry.命中率 =
			baselineUsage && entry.用量 && index >= baselineIndex ? cacheHitRate(baselineUsage, entry.用量) : undefined;
	}
	const totalUsage = emptyUsage();
	for (const entry of samples) {
		addUsage(totalUsage, entry.用量);
	}
	return { 上下文字符数: params.context_chars, 衰减阈值: decayThreshold, 采样: samples, 总用量: totalUsage };
}

function formatPercent(ratio: number | undefined): string {
	return ratio === undefined ? "—" : `${(ratio * 100).toFixed(1)}%`;
}

/** 结论一行:衰减到阈值以下的首个间隔(跳过失败采样);全程无缓存读命中时如实说 */
export function decayVerdict(samples: CacheSampleRecord[], threshold: number): string {
	const baseline = samples.find((entry) => entry.状态 === "成功" && (entry.用量?.cacheRead ?? 0) > 0);
	if (!baseline?.用量) {
		return "结论:全程无缓存读命中(缓存未建立或供应商未回报 cacheRead),无法评估衰减;先确认供应商缓存开关与计费口径再重测";
	}
	const breach = samples.find(
		(entry) => entry.状态 === "成功" && entry.偏移秒 > 0 && entry.命中率 !== undefined && entry.命中率 < threshold,
	);
	if (!breach) {
		const farthest = Math.max(0, ...samples.map((entry) => entry.偏移秒));
		return `结论:直到 +${farthest}s 命中率仍未跌破 ${formatPercent(threshold)},采样范围内未见衰减;可拉长采样间隔再测`;
	}
	return `结论:衰减到阈值以下的首个间隔为 +${breach.偏移秒}s(命中率 ${formatPercent(breach.命中率)} < ${formatPercent(threshold)});空闲预热间隔应短于该值`;
}

/** 渲染衰减曲线:表头一行 + 每次采样一行 + 末尾结论一行;纯文本,不落盘 */
export function renderCacheProbeReport(result: CacheProbeResult): string {
	const successCount = result.采样.filter((entry) => entry.状态 === "成功").length;
	const lines: string[] = [
		`缓存衰减探针:固定上下文约 ${result.上下文字符数} 字符(≈${Math.ceil(result.上下文字符数 / 4)} token),衰减阈值 ${formatPercent(result.衰减阈值)};成功采样 ${successCount}/${result.采样.length},合计成本 $${(result.总用量.cost?.total ?? 0).toFixed(6)}`,
	];
	for (const entry of result.采样) {
		if (entry.状态 === "失败") {
			lines.push(`+${entry.偏移秒}s:采样失败(${entry.说明 ?? "未知错误"})`);
			continue;
		}
		const usage = entry.用量!;
		lines.push(
			`+${entry.偏移秒}s:cacheRead ${usage.cacheRead} / cacheWrite ${usage.cacheWrite} token;输入 ${usage.input} / 输出 ${usage.output} token;成本 $${(usage.cost?.total ?? 0).toFixed(6)};相对首采样命中率 ${formatPercent(entry.命中率)}`,
		);
	}
	lines.push(decayVerdict(result.采样, result.衰减阈值));
	return lines.join("\n");
}
