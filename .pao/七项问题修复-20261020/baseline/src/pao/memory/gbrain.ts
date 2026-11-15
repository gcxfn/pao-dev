/**
 * gbrain 记忆供应商适配器（架构 §18.5,M2-05;2026-10-03 切换,替代 mnemosyne 成默认现场）。
 *
 * gbrain＝Docker 里的常驻记忆服务(gbrain-local,Express+pgvector/pg16),Hermes 已先用它,
 * pao 同脑共读共写(visibility=world 的 facts 跨 agent 可见是 gbrain 的定案模型)。
 * 接入面＝MCP over HTTP:POST {base_url}/mcp ＋ Authorization: Bearer,无 session、
 * JSON-RPC 直来直往(真实探针 2026-10-03:initialize 200/protocolVersion 2025-03-26/
 * 无 mcp-session-id;notifications/initialized 回 204;工具结果＝JSON 序列化进单个 text 块)。
 *
 * MCP 客户端复用 @earendil-works/pi-mcp 的 McpClient＋StreamableHttpTransport(零新增包,
 * 与 mnemosyne 适配器同款取舍:封帧/握手/超时/id 配对全现成)。openGetStream 关死——
 * gbrain 无服务器→客户端流,开着只会白连。无 session ⇒ transport.close() 不发 DELETE、
 * 只掐未决请求,「关闭」语义天然幂等(R05:不归本适配器管进程树,gbrain 容器是用户态常驻)。
 *
 * 记忆动词(MEMORY VERBS v1,真实源码 verbs.ts 契约):remember{fact,provenance(必),
 * visibility:world}/recall{query,limit}→facts[].fact_id/forget{id}(幂等,expired=false 也是成功)。
 * 作者标识走 provenance 前缀「pao」(对应 mnemosyne 时代的 MNEMOSYNE_AUTHOR_ID=pao;
 * gbrain 传统 token 的写源下限＝default 源,与 Hermes 同源共写,不另建 source)。
 * token 在容器侧经 `gbrain auth create` 铸发,SHA-256 落库只显一次;pao 侧经
 * GBRAIN_TOKEN 环境变量供给(env 优先→惰性 .env 补缺,与 EMBED_* 同链同安全门),
 * 绝不写进配置文件/仓库。缺 token＝启动失败→由 MemoryVendorManager 降级为无记忆。
 *
 * 能力声明:语义检索=pgvector 混合检索(引擎定案);需嵌入端点=false(gbrain 自带嵌入供给,
 * pao 无需喂端点——这是与 mnemosyne 的关键差异);忘却=按服务器工具清单定。
 */
import { readFileSync } from "node:fs";
import { type CallToolResult, McpClient, StreamableHttpTransport, type TextContent } from "@earendil-works/pi-mcp";

import { locateEnvFile } from "../knowledge/embed.ts";
import type { MemoryCapabilities, MemoryHit, MemoryVendor, MemoryWriteReceipt } from "./memory-vendor.ts";
import { DEFAULT_RECALL_LIMIT } from "./mnemosyne.ts";

/** 缺省 gbrain HTTP 服务地址(本机 Docker 端口映射) */
export const DEFAULT_GBRAIN_BASE_URL = "http://127.0.0.1:7333";
/** token 的缺省环境变量名(与 Hermes 的 token_env 命名习惯一致) */
export const DEFAULT_GBRAIN_TOKEN_ENV = "GBRAIN_TOKEN";
/** 默认单次 MCP 请求超时(含 initialize 握手);gbrain 本机热路径,30s 富余 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** gbrain 服务限流 60 req/min per token;§18.1 每轮 top3 自动召回远在其下,无需节流 */

/** gbrain 适配器参数(配置文件「参数」字段的形状;全部可缺省) */
export interface GbrainVendorParams {
	/** gbrain HTTP 服务基址;缺省 "http://127.0.0.1:7333"(POST {base_url}/mcp) */
	base_url?: string;
	/** Bearer token 的环境变量名;缺省 "GBRAIN_TOKEN" */
	token环境变量?: string;
	/** 写入 provenance 的作者前缀;缺省 "pao"(跨 agent 共脑的作者标识) */
	来源标识?: string;
	/** 单次 MCP 请求(含 initialize)超时毫秒;缺省 30000 */
	请求超时毫秒?: number;
}

interface ResolvedGbrainParams {
	baseUrl: string;
	tokenEnv: string;
	来源标识: string;
	requestTimeoutMs: number;
}

/** remember 返回的冻结状态枚举(verbs.ts STATUS_ENUM;duplicate/superseded 也是写入成功语义) */
const REMEMBER_STATUS_ENUM = ["inserted", "duplicate", "superseded"] as const;

/** 校验并补全参数;坏参数抛结构化中文错误(注册期与启动期都会走到) */
export function resolveGbrainParams(params: unknown): ResolvedGbrainParams {
	if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) {
		throw new Error("gbrain 参数应为对象({base_url,token环境变量,来源标识,请求超时毫秒})");
	}
	const raw = (params ?? {}) as Record<string, unknown>;
	for (const field of ["base_url", "token环境变量", "来源标识"] as const) {
		const value = raw[field];
		if (value !== undefined && (typeof value !== "string" || !value.trim())) {
			throw new Error(`gbrain 参数「${field}」应为非空字符串`);
		}
	}
	const baseUrl = ((raw.base_url as string | undefined) ?? DEFAULT_GBRAIN_BASE_URL).trim().replace(/\/+$/, "");
	if (!/^https?:\/\//.test(baseUrl)) {
		throw new Error(`gbrain 参数「base_url」应为 http(s) 地址(实际:${baseUrl})`);
	}
	if (
		raw.请求超时毫秒 !== undefined &&
		(typeof raw.请求超时毫秒 !== "number" || !Number.isFinite(raw.请求超时毫秒) || raw.请求超时毫秒 <= 0)
	) {
		throw new Error("gbrain 参数「请求超时毫秒」应为正数");
	}
	return {
		baseUrl,
		tokenEnv: ((raw.token环境变量 as string | undefined) ?? DEFAULT_GBRAIN_TOKEN_ENV).trim(),
		来源标识: ((raw.来源标识 as string | undefined) ?? "pao").trim(),
		requestTimeoutMs: (raw.请求超时毫秒 as number | undefined) ?? DEFAULT_REQUEST_TIMEOUT_MS,
	};
}

/**
 * 取 token 的 .env 文件解析(只认指定键,容忍注释/空行/坏行/成对引号——与 embed.ts 同规则)。
 * 独立小份实现而非改通用件:knowledge/embed 的解析绑死 EMBED_* 三键,这里只需一键,
 * 各自私有、互不牵连的口径与 mnemosyne 适配器「不碰别人配置」的边界一致。
 */
function parseEnvFileValue(text: string, key: string): string | undefined {
	for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		if (line.slice(0, eq).trim() !== key) continue;
		let value = line.slice(eq + 1).trim();
		if (
			value.length >= 2 &&
			((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
		) {
			value = value.slice(1, -1);
		}
		if (value !== "") return value;
	}
	return undefined;
}

/**
 * 三级取 token:env 现值优先 → 惰性 .env 补缺(PAO_ENV_FILE 显式路径→cwd/.env→自模块上溯,
 * 与 EMBED_* 同链) → 仍缺返回 null。
 * 安全门与 embed 同款:显式传入 env(≠process.env)＝测试语义,只认 env、绝不触文件系统,
 * 杜绝测试读到真实 .env;生产路径(env 缺省＝process.env)才做文件加载。
 */
export function loadGbrainToken(
	tokenEnv: string = DEFAULT_GBRAIN_TOKEN_ENV,
	env: Record<string, string | undefined> = process.env,
): string | null {
	const fromEnv = env[tokenEnv]?.trim();
	if (fromEnv) return fromEnv;
	if (env !== process.env) return null; // 安全门:显式 env 记录不触文件
	const envFile = locateEnvFile({ env });
	if (envFile) {
		try {
			return parseEnvFileValue(readFileSync(envFile, "utf8"), tokenEnv) ?? null;
		} catch {
			// .env 读不了就算了,当没有这个文件
		}
	}
	return null;
}

/** 从工具结果取纯文本(JSON 解包/错误说明用)。 */
function textFromResult(result: CallToolResult): string {
	return result.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

/**
 * 取 text 里的首个完整 JSON 对象(平衡括号截取,字符串内的括号不计)。
 * gbrain 的 content[0] 恒为业务 JSON;但空召回/未知参数警告会在其后追加第二个
 * text 块(模型可见诊断,dispatch.ts D8 定案),整段 parse 会炸——只取首段。
 */
function firstJsonObject(text: string): unknown {
	const start = text.indexOf("{");
	if (start < 0) throw new Error("gbrain 返回的文本不含 JSON 对象");
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			if (inString) escaped = true;
			continue;
		}
		if (ch === '"') inString = !inString;
		if (inString) continue;
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return JSON.parse(text.slice(start, i + 1));
		}
	}
	throw new Error("gbrain 返回的文本含不完整的 JSON 对象");
}

/**
 * gbrain 把业务返回 JSON.stringify 进单个 text 块(真实 dispatch.ts 定案);
 * 解包成对象并核业务错误。structuredContent 优先(gbrain 目前不发,留作上游演进)。
 */
function payloadFromResult(result: CallToolResult): Record<string, unknown> {
	if (result.isError) throw new Error(`gbrain 返回错误:${textFromResult(result) || "(无说明)"}`);
	let payload: unknown = result.structuredContent;
	if (payload === undefined) payload = firstJsonObject(textFromResult(result));
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		throw new Error("gbrain 返回的 JSON 应为对象");
	}
	const obj = payload as Record<string, unknown>;
	if (obj.error !== undefined) throw new Error(`gbrain 返回错误:${String(obj.error)}`);
	return obj;
}

export class GbrainVendor implements MemoryVendor {
	readonly vendorName = "gbrain";
	private readonly params: ResolvedGbrainParams;
	private client: McpClient | undefined;
	private serverTools = new Set<string>();
	private capabilityState: MemoryCapabilities = {
		语义检索: true, // pgvector＋关键词混合检索是 gbrain 引擎定案
		需嵌入端点: false, // gbrain 服务端自带嵌入供给,pao 不喂端点(与 mnemosyne 的关键差异)
		忘却: false, // 启动时按服务器实际工具清单定
	};

	/** token 加载器(测试注入用;缺省＝三级链 env→惰性 .env→null) */
	private readonly tokenLoader: (tokenEnv: string) => string | null;

	constructor(params: unknown = {}, opts?: { token加载?: (tokenEnv: string) => string | null }) {
		this.params = resolveGbrainParams(params);
		this.tokenLoader = opts?.token加载 ?? ((tokenEnv) => loadGbrainToken(tokenEnv));
	}

	get capabilities(): MemoryCapabilities {
		return { ...this.capabilityState };
	}

	/** 启动诊断:服务器工具清单(启动失败报错里列出实际工具) */
	get toolList(): string[] {
		return [...this.serverTools].sort();
	}

	async start(): Promise<void> {
		if (this.client) return;
		const token = this.tokenLoader(this.params.tokenEnv);
		if (!token) {
			throw new Error(`gbrain 缺 Bearer token(环境变量 ${this.params.tokenEnv} 未设置;.env 亦未补给)`);
		}
		const transport = new StreamableHttpTransport({
			url: `${this.params.baseUrl}/mcp`,
			headers: { Authorization: `Bearer ${token}` },
			openGetStream: false, // gbrain 无服务器→客户端流;开着只会白连
		});
		const client = new McpClient({
			name: "pao",
			version: "0.1.0",
			requestTimeoutMs: this.params.requestTimeoutMs,
		});
		try {
			await client.connect(transport); // initialize 握手(真实探针:200/2025-03-26/无 session)
			this.serverTools = new Set((await client.listTools()).map((tool) => tool.name));
			for (const required of ["remember", "recall"] as const) {
				if (!this.serverTools.has(required)) {
					throw new Error(
						`gbrain 服务器缺工具「${required}」(实际提供:${[...this.serverTools].sort().join("、") || "无"})`,
					);
				}
			}
			this.capabilityState = { ...this.capabilityState, 忘却: this.serverTools.has("forget") };
		} catch (error) {
			await client.close().catch(() => {});
			const message = error instanceof Error ? error.message : String(error);
			const status = (error as { status?: number }).status; // McpHttpError 带 HTTP 状态码
			throw new Error(
				`gbrain MCP 启动失败(${this.params.baseUrl}/mcp):${status ? `HTTP ${status} ` : ""}${message}`,
			);
		}
		this.client = client;
	}

	async write(content: string, label?: readonly string[]): Promise<MemoryWriteReceipt> {
		const provenance =
			label && label.length > 0 ? `${this.params.来源标识}｜标签:${[...label].join(",")}` : this.params.来源标识;
		const payload = payloadFromResult(
			await this.callRequired("remember", { fact: content, provenance, visibility: "world" }),
		);
		// 冻结状态枚举:inserted=新插入,duplicate/superseded=幂等命中既有条目,三者都是写入成功
		if (typeof payload.status !== "string" || !(REMEMBER_STATUS_ENUM as readonly string[]).includes(payload.status)) {
			throw new Error(
				`gbrain remember 未返回冻结状态枚举(${REMEMBER_STATUS_ENUM.join("/")}),实际:${String(payload.status)}`,
			);
		}
		if (typeof payload.id !== "string" && typeof payload.id !== "number") {
			throw new Error("gbrain remember 未返回事实 ID,不能确认写入成功");
		}
		return { 记忆ID: String(payload.id), 状态: payload.status };
	}

	async recall(searchQuery: string, limit: number = DEFAULT_RECALL_LIMIT): Promise<MemoryHit[]> {
		const payload = payloadFromResult(await this.callRequired("recall", { query: searchQuery, limit: limit }));
		if (!Array.isArray(payload.facts)) {
			throw new Error("gbrain recall 未返回 facts 数组");
		}
		return payload.facts.map((item: unknown): MemoryHit => {
			if (typeof item !== "object" || item === null || Array.isArray(item)) {
				throw new Error("gbrain recall 条目应为对象");
			}
			const hit = item as Record<string, unknown>;
			if (typeof hit.fact !== "string" || !hit.fact.trim()) {
				throw new Error("gbrain recall 条目缺少 fact");
			}
			return {
				内容: hit.fact,
				...(typeof hit.fact_id === "string" || typeof hit.fact_id === "number"
					? { 记忆ID: String(hit.fact_id) }
					: {}),
				...(typeof hit.provenance === "string" ? { 来源: hit.provenance } : {}),
			};
		});
	}

	async forget(memoryId: string): Promise<number> {
		if (!this.capabilityState.忘却) {
			throw new Error("gbrain 服务器未提供忘却工具「forget」(能力.忘却=false,勿调)");
		}
		if (!memoryId.trim()) throw new Error("忘却须提供明确的记忆 ID");
		const payload = payloadFromResult(await this.callRequired("forget", { id: memoryId }));
		// 幂等契约:expired=true 本次清除;false＝本就过期(成功语义);unknown id 走 isError 报错
		if (String(payload.id) !== String(memoryId) || typeof payload.expired !== "boolean") {
			throw new Error("gbrain forget 未返回对应 ID 的 expired 布尔,不能确认忘却结果");
		}
		return payload.expired ? 1 : 0;
	}

	/**
	 * 幂等关闭:client.close() 连带 transport.close()(无 session ⇒ 不发 DELETE,只掐未决请求)。
	 * gbrain 容器是用户态常驻服务(R05 之外部例外,由 Docker 管生命周期),本适配器不停容器。
	 */
	async close(): Promise<void> {
		const client = this.client;
		this.client = undefined;
		this.serverTools = new Set();
		this.capabilityState = { ...this.capabilityState, 忘却: false };
		if (client) await client.close();
	}

	private async callRequired(toolName: string, params: Record<string, unknown>): Promise<CallToolResult> {
		if (!this.client) throw new Error("gbrain 未启动(应先经 启动();由 MemoryVendorManager 保证)");
		return await this.client.callTool(toolName, params);
	}
}

/** gbrain 工厂(注册进供应商注册表的名字→工厂) */
export function createGbrainVendor(params: unknown): GbrainVendor {
	return new GbrainVendor(params);
}
