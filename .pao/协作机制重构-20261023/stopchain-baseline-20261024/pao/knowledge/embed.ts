/**
 * 嵌入客户端：OpenAI 兼容 `/embeddings` 端点（黑板约定）。
 * 凭证不落库。端点未配置或调用失败由调用方捕获后降级为词法独跑（§6.3）。
 *
 * 配置来源链（v2-ARCHITECTURE「正常密钥输入」三级）：
 *   1. env（生产即 process.env）中的 EMBED_BASE_URL / EMBED_API_KEY / EMBED_MODEL 优先；
 *   2. 缺项时惰性加载 .env 补齐：PAO_ENV_FILE 显式路径优先 → cwd/.env → 从本模块路径逐级
 *      上溯（至多 8 级，同时覆盖 src/pao/knowledge 源码层与 dist/bundle 打包层）；
 *   3. 补齐后仍缺任一项 → null，调用方降级为词法独跑。
 *
 * 安全门：仅当调用方未显式传 env（env === process.env，生产路径）才触文件系统；
 * 显式传入 env 记录＝测试语义，一律不读任何文件，杜绝测试读到真实 .env。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface EmbedConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
}

/** 只关心这三个键，env 文件里其余内容一律无视（不把不相干的密钥捞进内存）。 */
const EMBED_ENV_KEYS = ["EMBED_BASE_URL", "EMBED_API_KEY", "EMBED_MODEL"] as const;
type EmbedEnvKey = (typeof EMBED_ENV_KEYS)[number];

const ENV_FILENAME = ".env";
/** 自模块路径上溯的最大级数：源码层 src/pao/knowledge→仓库根 5 级，打包层 dist/bundle→仓库根 3 级，8 级富余。 */
const MAX_WALK_LEVELS = 8;

type EmbedEnvValues = Partial<Record<EmbedEnvKey, string>>;

/** 行键是否属于三键之一（类型谓词：让下面的 out[key] 赋值能收窄）。 */
function isEmbedEnvKey(key: string): key is EmbedEnvKey {
	return (EMBED_ENV_KEYS as readonly string[]).includes(key);
}

/**
 * 解析 env 文件文本：逐行 KEY=VALUE，容忍 #注释、空行与坏行（无 = 或空键直接跳过），
 * 值可带成对的单/双引号；只取三个 EMBED_* 键，其余键忽略。
 */
export function parseEnvFile(text: string): EmbedEnvValues {
	const out: EmbedEnvValues = {};
	for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		if (!isEmbedEnvKey(key)) continue;
		let value = line.slice(eq + 1).trim();
		if (
			value.length >= 2 &&
			((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
		) {
			value = value.slice(1, -1);
		}
		if (value !== "") out[key] = value;
	}
	return out;
}

/**
 * 定位 .env 文件（可注入 env/startDir 便于测试）：
 * PAO_ENV_FILE 显式路径最优先——即便文件不存在也以它为准、不再回退上溯；
 * 否则 cwd/.env → 自 startDir（默认本模块目录）逐级上溯取第一个存在的 .env。
 */
export function locateEnvFile(opts?: { env?: Record<string, string | undefined>; startDir?: string }): string | null {
	const explicit = opts?.env?.PAO_ENV_FILE?.trim();
	if (explicit) return explicit;
	const candidates = [join(process.cwd(), ENV_FILENAME)];
	let dir = opts?.startDir ?? dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i <= MAX_WALK_LEVELS; i++) {
		candidates.push(join(dir, ENV_FILENAME));
		const parent = dirname(dir);
		if (parent === dir) break; // 到根（Windows 盘符/POSIX /）为止
		dir = parent;
	}
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/** 取三键值：undefined/空白视同未设置（半配置允许文件补齐，不做猜测）。 */
function pickEmbedValues(env: Record<string, string | undefined>): EmbedEnvValues {
	const out: EmbedEnvValues = {};
	for (const key of EMBED_ENV_KEYS) {
		const value = env[key]?.trim();
		if (value) out[key] = value;
	}
	return out;
}

function toConfig(values: EmbedEnvValues): EmbedConfig | null {
	const { EMBED_BASE_URL: baseUrl, EMBED_API_KEY: apiKey, EMBED_MODEL: model } = values;
	// 三项齐全才算可用，缺任一项都退回词法独跑，不做半配置猜测
	if (!baseUrl || !apiKey || !model) return null;
	return { baseUrl, apiKey, model };
}

/**
 * 嵌入配置三级来源：env 优先 → 惰性 .env 补缺 → 仍不全返回 null。
 * 显式传 env＝测试语义，只认 env、不触任何文件；生产路径（env === process.env）才做文件加载。
 * 查库低频，.env 每次现读即可，不做缓存。
 */
export function loadEmbedConfig(env: Record<string, string | undefined> = process.env): EmbedConfig | null {
	const fromEnv = pickEmbedValues(env);
	if (fromEnv.EMBED_BASE_URL && fromEnv.EMBED_API_KEY && fromEnv.EMBED_MODEL) {
		return toConfig(fromEnv);
	}
	if (env !== process.env) return null; // 安全门：显式 env 记录不触文件
	const envFile = locateEnvFile({ env });
	if (envFile) {
		try {
			const fromFile = pickEmbedValues(parseEnvFile(readFileSync(envFile, "utf8")));
			return toConfig({ ...fromFile, ...fromEnv }); // env 优先级高于文件
		} catch {
			// .env 读不了就算了，当没有这个文件
		}
	}
	return null;
}

export type FetchLike = (
	url: string,
	init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{
	ok: boolean;
	status: number;
	statusText?: string;
	json: () => Promise<unknown>;
}>;

export interface EmbedClient {
	config: EmbedConfig;
	fetchImpl: FetchLike;
}

/** 查库网络请求的默认等待上限；调用方可在一次查询内缩短它用于界面快速取消。 */
export const DEFAULT_EMBED_TIMEOUT_MS = 15_000;

/** 原生 AbortSignal 超时单独标记，供查库保留“超时降级、用户取消直接停止”的区别。 */
export class EmbedTimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`嵌入请求超时（${timeoutMs}ms）`);
		this.name = "TimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

export interface EmbedRequestOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

/** 同一次自动路由查询内的查询词嵌入 Promise 缓存；缓存不跨调用、不落盘。 */
export type QueryEmbeddingCache = Map<string, Promise<number[]>>;

/** 将取消原因转成可抛出的 Error，避免把取消静默当成普通网络失败。 */
export function abortError(signal: AbortSignal): Error {
	const reason = signal.reason;
	if (reason instanceof Error) return reason;
	const error = new Error("查库已取消");
	error.name = "AbortError";
	return error;
}

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError(signal);
}

/**
 * 等待一次可能不响应 AbortSignal 的异步操作。
 *
 * 有些测试替身和第三方 fetch 实现只接收 signal，却不会在取消时自行
 * 拒绝；因此不能只依赖 fetch 的实现。请求头和 response.json() 都经过
 * 这里，且 finally 会移除监听器，避免一次查询结束后继续持有调用方的
 * AbortSignal。
 */
function awaitWithAbort<T>(
	operation: () => PromiseLike<T>,
	userSignal: AbortSignal | undefined,
	timeoutSignal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<T> {
	throwIfAborted(userSignal);
	if (timeoutSignal?.aborted) throw new EmbedTimeoutError(timeoutMs);
	let cancelled = false;
	let cleanup = () => {};
	const abortPromise = new Promise<never>((_, reject) => {
		const onUserAbort = () => {
			cancelled = true;
			reject(abortError(userSignal!));
		};
		const onTimeout = () => {
			cancelled = true;
			reject(new EmbedTimeoutError(timeoutMs));
		};
		if (userSignal) {
			if (userSignal.aborted) onUserAbort();
			else userSignal.addEventListener("abort", onUserAbort, { once: true });
		}
		if (timeoutSignal) {
			if (timeoutSignal.aborted) onTimeout();
			else timeoutSignal.addEventListener("abort", onTimeout, { once: true });
		}
		cleanup = () => {
			userSignal?.removeEventListener("abort", onUserAbort);
			timeoutSignal?.removeEventListener("abort", onTimeout);
		};
	});
	const task = Promise.resolve().then(() => {
		if (cancelled) return new Promise<T>(() => {});
		return operation();
	});
	return Promise.race([task, abortPromise]).finally(cleanup);
}

function embedConfigKey(config: EmbedConfig): string {
	return `${config.baseUrl}\u0000${config.apiKey}\u0000${config.model}`;
}

/**
 * 同配置、同查询词只复用查询向量 Promise；调用方必须先完成本库外发授权，
 * 因此这个接缝不会把一个已授权库的权限扩散给禁外发库。
 */
export function sharedQueryEmbedding(
	client: EmbedClient,
	query: string,
	cache: QueryEmbeddingCache,
	options?: EmbedRequestOptions,
): Promise<number[]> {
	const key = `${embedConfigKey(client.config)}\u0000${query}`;
	const existing = cache.get(key);
	if (existing) return existing;
	const task = embedTexts(client, [query], options).then(([vector]) => {
		if (!vector) throw new Error("嵌入端点返回缺少查询向量");
		return vector;
	});
	cache.set(key, task);
	return task;
}

/** 调用 /embeddings，按输入顺序返回向量。失败抛错，调用方负责降级。 */
export async function embedTexts(
	client: EmbedClient,
	texts: string[],
	options: EmbedRequestOptions = {},
): Promise<number[][]> {
	if (texts.length === 0) return [];
	throwIfAborted(options.signal);
	const timeoutMs = options.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS;
	const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
	const requestSignal =
		options.signal && timeoutSignal
			? AbortSignal.any([options.signal, timeoutSignal])
			: (options.signal ?? timeoutSignal);
	const endpoint = `${client.config.baseUrl.replace(/\/+$/, "")}/embeddings`;
	const response = await awaitWithAbort(
		() =>
			client.fetchImpl(endpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${client.config.apiKey}`,
				},
				body: JSON.stringify({ model: client.config.model, input: texts }),
				signal: requestSignal,
			}),
		options.signal,
		timeoutSignal,
		timeoutMs,
	);
	throwIfAborted(options.signal);
	if (!response.ok) {
		throw new Error(`嵌入端点返回 ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
	}
	const payload = (await awaitWithAbort(() => response.json(), options.signal, timeoutSignal, timeoutMs)) as {
		data?: Array<{ index?: number; embedding?: number[] }>;
	};
	throwIfAborted(options.signal);
	if (!Array.isArray(payload.data) || payload.data.length !== texts.length) {
		throw new Error("嵌入端点返回数据与输入数量不符");
	}
	const vectors: number[][] = new Array(texts.length);
	payload.data.forEach((item, i) => {
		const idx = typeof item.index === "number" ? item.index : i;
		if (!Array.isArray(item.embedding)) throw new Error("嵌入端点返回缺少向量");
		vectors[idx] = item.embedding;
	});
	return vectors;
}

/** 余弦相似度（暴力打分，不上向量库）。 */
export function cosine(a: number[], b: number[]): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	if (normA === 0 || normB === 0) return 0;
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
