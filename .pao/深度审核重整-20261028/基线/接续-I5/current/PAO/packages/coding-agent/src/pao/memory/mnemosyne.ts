/**
 * mnemosyne 记忆供应商适配器（架构 §18.5,M2-05;默认供应商）。
 *
 * 定案锁死:mnemosyne 以 `mnemosyne mcp` stdio 子进程挂载,主会话惰性拉起、随主会话
 * session_shutdown 全停(R05,不做常驻服务)。真实接线期(2026-10-02 共库落地)核对结论:
 * mnemosyne 4.0.0b3 的 API 嵌入只认子进程环境变量(MNEMOSYNE_EMBEDDING_API_URL/KEY/MODEL),
 * 其 config.yaml 的嵌入三键到不了嵌入代码——故由本适配器把 pao 侧 EMBED_* 三键
 * (env→惰性 .env,与查库嵌入端点同源同键)映射注入子进程环境;适配器仍不读不写任何
 * mnemosyne/Hermes 配置文件,密钥只经内存。缺嵌入三键时照常启动,mnemosyne 自行降级
 * 为本地 fallback 嵌入(向量通道形同虚设,词法召回不受影响)。
 * 写入默认带 `MNEMOSYNE_AUTHOR_ID=pao` 作者标识(与 Hermes 共库护栏①,配置 env 可覆盖)。
 *
 * MCP 客户端复用 @earendil-works/pi-mcp(coding-agent 既有依赖,零新增包):JSON-RPC 封帧、
 * initialize 握手、超时与 id 配对都是现成的;StdioTransport.close() 自带停树
 * (POSIX 进程组 SIGTERM→SIGKILL,Windows `taskkill /T /F`),与 worker/kill.ts 同思路(原 worker/kill.ts,现 utils/kill-tree.ts)
 * 而不必抄其 internals。命令起不来(ENOENT/握手超时/工具清单不符)＝抛结构化错误,
 * 由 MemoryVendorManager 降级为无记忆——不阻断会话。
 *
 * 参数与返回按本机 mnemosyne 的 tool_schemas.py/mcp_tools.py 对齐：标签进 metadata，
 * 忘却用 memory_id；MCP text 块里的 JSON 先解包，再核 status/error，不把错误当成功。
 */
import { type CallToolResult, McpClient, StdioTransport, type TextContent } from "@earendil-works/pi-mcp";
import { type EmbedConfig, loadEmbedConfig } from "../knowledge/embed.ts";
import type { MemoryCapabilities, MemoryHit, MemoryVendor } from "./memory-vendor.ts";

/** 默认单次 MCP 请求超时(含 initialize 握手);Windows stdio 冷启动预算见定案实施核 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** stderr 只留尾部做诊断,不整段进日志(防供应商侧输出混入敏感内容) */
const STDERR_TAIL_LIMIT = 500;
/** 召回缺省条数(§18.1:每轮召回 top3) */
export const DEFAULT_RECALL_LIMIT = 3;

/** mnemosyne 启停参数(配置文件「参数」字段的形状;全部可缺省) */
export interface MnemosyneVendorParams {
	/** stdio 命令;缺省 "mnemosyne"(PyPI mnemosyne-memory 的 CLI 入口) */
	command?: string;
	/** 命令参数;缺省 ["mcp"] */
	args?: readonly string[];
	/** 子进程工作目录;缺省继承 */
	cwd?: string;
	/**
	 * 额外环境变量(如 MNEMOSYNE_HOME 指向与 Hermes 共库的数据目录),在继承环境上合并;
	 * 缺省注入 MNEMOSYNE_AUTHOR_ID=pao(共库作者标识,此处显式传入可覆盖)。
	 * EMBED_* 三键映射出的 MNEMOSYNE_EMBEDDING_API_URL/KEY/MODEL 同样只补缺不覆盖——
	 * 这里显式给的值优先于 fork 根 .env。
	 */
	env?: Record<string, string>;
	/** 单次 MCP 请求(含 initialize)超时毫秒;缺省 30000 */
	请求超时毫秒?: number;
	/** 服务器侧工具名映射；缺省 mnemosyne_remember/mnemosyne_recall/mnemosyne_forget */
	工具映射?: { 写入?: string; 召回?: string; 忘却?: string };
}

interface ResolvedMnemosyneParams {
	command: string;
	args: string[];
	cwd: string | undefined;
	env: Record<string, string>;
	requestTimeoutMs: number;
	工具: { 写入: string; 召回: string; 忘却: string };
}

/** 校验并补全启停参数;坏参数抛结构化中文错误(注册期与启动期都会走到) */
export function resolveMnemosyneParams(params: unknown): ResolvedMnemosyneParams {
	if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) {
		throw new Error("mnemosyne 参数应为对象({command,args,env,请求超时毫秒,工具映射})");
	}
	const raw = (params ?? {}) as Record<string, unknown>;
	for (const field of ["command", "cwd"] as const) {
		const value = raw[field];
		if (value !== undefined && (typeof value !== "string" || !value.trim())) {
			throw new Error(`mnemosyne 参数「${field}」应为非空字符串`);
		}
	}
	if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.some((item) => typeof item !== "string"))) {
		throw new Error("mnemosyne 参数「args」应为字符串数组");
	}
	if (raw.env !== undefined && (typeof raw.env !== "object" || raw.env === null)) {
		throw new Error("mnemosyne 参数「env」应为字符串到字符串的对象");
	}
	for (const [key, value] of Object.entries((raw.env ?? {}) as Record<string, unknown>)) {
		if (typeof value !== "string") throw new Error(`mnemosyne 参数「env.${key}」应为字符串`);
	}
	if (
		raw.请求超时毫秒 !== undefined &&
		(typeof raw.请求超时毫秒 !== "number" || !Number.isFinite(raw.请求超时毫秒) || raw.请求超时毫秒 <= 0)
	) {
		throw new Error("mnemosyne 参数「请求超时毫秒」应为正数");
	}
	const mapping = raw.工具映射;
	if (mapping !== undefined && (typeof mapping !== "object" || mapping === null)) {
		throw new Error("mnemosyne 参数「工具映射」应为对象({写入,召回,忘却})");
	}
	const toolMapping = (mapping ?? {}) as Record<string, unknown>;
	for (const [key, value] of Object.entries(toolMapping)) {
		if (typeof value !== "string" || !value.trim())
			throw new Error(`mnemosyne 参数「工具映射.${key}」应为非空字符串`);
	}
	const env = { ...((raw.env ?? {}) as Record<string, string>) };
	// 共库护栏①:pao 写入带作者标识;配置 env 已给 MNEMOSYNE_AUTHOR_ID 时不覆盖
	if (!env.MNEMOSYNE_AUTHOR_ID) env.MNEMOSYNE_AUTHOR_ID = "pao";
	return {
		command: ((raw.command as string | undefined) ?? "mnemosyne").trim(),
		args: (raw.args as string[] | undefined) ?? ["mcp"],
		cwd: raw.cwd as string | undefined,
		env,
		requestTimeoutMs: (raw.请求超时毫秒 as number | undefined) ?? DEFAULT_REQUEST_TIMEOUT_MS,
		工具: {
			写入: (toolMapping.写入 as string | undefined) ?? "mnemosyne_remember",
			召回: (toolMapping.召回 as string | undefined) ?? "mnemosyne_recall",
			忘却: (toolMapping.忘却 as string | undefined) ?? "mnemosyne_forget",
		},
	};
}

/** 从工具结果取纯文本（JSON 解包／错误说明）。 */
function textFromResult(result: CallToolResult): string {
	return result.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

/** mnemosyne MCP 返回对象；实际 stdio 服务器把它序列化进一个 text 块。 */
function payloadFromResult(result: CallToolResult): Record<string, unknown> {
	if (result.isError) throw new Error(`mnemosyne 返回错误:${textFromResult(result) || "(无说明)"}`);
	let payload: unknown = result.structuredContent;
	if (payload === undefined) {
		try {
			payload = JSON.parse(textFromResult(result));
		} catch {
			throw new Error("mnemosyne 返回的文本不是合法 JSON");
		}
	}
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		throw new Error("mnemosyne 返回的 JSON 应为对象");
	}
	const obj = payload as Record<string, unknown>;
	// 真实服务器的普通错误没有 isError，必须检查业务返回。
	if (obj.error !== undefined || obj.status === "error") {
		throw new Error(`mnemosyne 返回错误:${String(obj.error ?? "status=error")}`);
	}
	return obj;
}

export class MnemosyneVendor implements MemoryVendor {
	readonly vendorName = "mnemosyne";
	private readonly params: ResolvedMnemosyneParams;
	private client: McpClient | undefined;
	private transport: StdioTransport | undefined;
	/** 启动完成且工具能力已校验；仅有底层连接仍不足以下发记忆调用。 */
	private running = false;
	private serverTools = new Set<string>();
	private stderrTail = "";
	private capabilityState: MemoryCapabilities = {
		语义检索: true, // SQLite+FTS5+向量混合排序是 mnemosyne 引擎定案
		// 真实接线期修订:向量通道要真生效,嵌入端点须经 pao 的 EMBED_* 三键注入子进程 env
		// (mnemosyne 自家 config.yaml 的嵌入键到不了嵌入代码);缺三键则降级本地 fallback 嵌入
		需嵌入端点: true,
		忘却: false, // 启动时按服务器实际工具清单定
	};

	/** 嵌入配置来源(测试注入用;缺省＝知识库嵌入端点的三级链 env→惰性 .env→null) */
	private readonly embedLoader: () => EmbedConfig | null;

	constructor(params: unknown = {}, opts?: { 嵌入配置?: () => EmbedConfig | null }) {
		this.params = resolveMnemosyneParams(params);
		this.embedLoader = opts?.嵌入配置 ?? loadEmbedConfig;
	}

	get capabilities(): MemoryCapabilities {
		return { ...this.capabilityState };
	}

	/** 子进程 pid(诊断/测试用;未启动为 undefined) */
	get pid(): number | undefined {
		return this.transport?.pid;
	}

	/** 启动诊断:子进程 stderr 尾部(启动失败时并入错误信息) */
	get tailLog(): string {
		return this.stderrTail;
	}

	async start(): Promise<void> {
		if (this.running) return;
		if (this.transport) {
			throw new Error("mnemosyne 上次启动清理失败,必须先重试 close() 关闭保留的连接");
		}
		const { command, args, cwd, requestTimeoutMs } = this.params;
		this.injectEmbedEnv();
		const env = { ...this.params.env };
		this.stderrTail = "";
		const transport = new StdioTransport({
			command,
			args,
			cwd,
			env,
			stderr: "pipe",
			onStderr: (chunk) => {
				this.stderrTail = `${this.stderrTail}${chunk}`.slice(-STDERR_TAIL_LIMIT);
			},
		});
		const client = new McpClient({
			name: "pao",
			version: "0.1.0",
			requestTimeoutMs,
		});
		// 从连接建立前就保留身份：connect/listTools 任一步失败后，首次收尾若也失败，
		// 管理器仍能拿到同一 client/transport 再试，而不是把存活子进程遗忘。
		this.transport = transport;
		this.client = client;
		try {
			await client.connect(transport);
			this.serverTools = new Set((await client.listTools()).map((tool) => tool.name));
			for (const required of [this.params.工具.写入, this.params.工具.召回] as const) {
				if (!this.serverTools.has(required)) {
					throw new Error(
						`mnemosyne 服务器缺工具「${required}」(实际提供:${[...this.serverTools].sort().join("、") || "无"};可用「工具映射」配置改工具名)`,
					);
				}
			}
			this.capabilityState = { ...this.capabilityState, 忘却: this.serverTools.has(this.params.工具.忘却) };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const tail = this.stderrTail.trim();
			const startError = new Error(
				`mnemosyne MCP 启动失败(command=${command} ${args.join(" ")}):${message}${tail ? `|stderr 尾部:${tail}` : ""}`,
				{ cause: error },
			);
			try {
				await this.close();
			} catch (cleanupError) {
				// 保留 client/transport；只有 close() 成功才清身份，管理器因此还能重试。
				throw new AggregateError([startError, cleanupError], "mnemosyne MCP 启动及清理失败");
			}
			throw startError;
		}
		this.running = true;
	}

	async write(content: string, label?: readonly string[]): Promise<void> {
		const payload = payloadFromResult(
			await this.callRequired(this.params.工具.写入, {
				content: content,
				...(label && label.length > 0 ? { metadata: { tags: [...label] } } : {}),
			}),
		);
		if (payload.status === "filtered") throw new Error("mnemosyne 已过滤本条内容，未写入记忆库");
		if (payload.status !== "stored" || typeof payload.memory_id !== "string" || !payload.memory_id.trim()) {
			throw new Error("mnemosyne 未返回 stored 状态与记忆 ID，不能确认写入成功");
		}
	}

	async recall(searchQuery: string, limit: number = DEFAULT_RECALL_LIMIT): Promise<MemoryHit[]> {
		const payload = payloadFromResult(
			await this.callRequired(this.params.工具.召回, { query: searchQuery, limit: limit }),
		);
		if (payload.status !== "ok" || !Array.isArray(payload.results)) {
			throw new Error("mnemosyne 召回未返回 ok 状态与 results 数组");
		}
		return payload.results.map((item: unknown): MemoryHit => {
			if (typeof item !== "object" || item === null || Array.isArray(item)) {
				throw new Error("mnemosyne 召回条目应为对象");
			}
			const hit = item as Record<string, unknown>;
			if (typeof hit.content !== "string" || !hit.content.trim()) {
				throw new Error("mnemosyne 召回条目缺少 content");
			}
			return {
				内容: hit.content,
				...(typeof hit.id === "string" ? { 记忆ID: hit.id } : {}),
				...(typeof hit.score === "number" && Number.isFinite(hit.score) ? { 相关度: hit.score } : {}),
				...(typeof hit.source === "string" ? { 来源: hit.source } : {}),
			};
		});
	}

	async forget(memoryId: string): Promise<number> {
		if (!this.capabilityState.忘却) {
			throw new Error(`mnemosyne 服务器未提供忘却工具「${this.params.工具.忘却}」(能力.忘却=false,勿调)`);
		}
		if (!memoryId.trim()) throw new Error("忘却须提供明确的记忆 ID");
		const payload = payloadFromResult(await this.callRequired(this.params.工具.忘却, { memory_id: memoryId }));
		if (payload.memory_id !== memoryId || !["deleted", "not_found"].includes(String(payload.status))) {
			throw new Error("mnemosyne 未返回对应记忆 ID 的 deleted/not_found 状态，不能确认忘却结果");
		}
		return payload.status === "deleted" ? 1 : 0;
	}

	/**
	 * 随主会话 session_shutdown 停子进程树:client.close() → transport.close(),后者自带
	 * stdin 宽限→SIGTERM→SIGKILL / Windows taskkill /T /F(连孙进程)。幂等。
	 */
	async close(): Promise<void> {
		const client = this.client;
		const transport = this.transport;
		if (!client && !transport) return;
		// client.close() 会先标记连接关闭；此后即使 transport 停失败，也不能再让业务调用
		// 命中这个只供关闭重试的资源。
		this.running = false;
		const failures: unknown[] = [];
		try {
			await client?.close();
		} catch (error) {
			failures.push(error);
		}
		// McpClient.close() 在 transport.close() 完成前就先丢掉 transport；这里另行保留同一对象，
		// 任一层失败都继续尝试另一层，并在成功后仍保留身份，供下一次 close() 重试。
		try {
			await transport?.close();
		} catch (error) {
			failures.push(error);
		}
		if (failures.length > 0) {
			throw new AggregateError(failures, "mnemosyne MCP 资源关闭失败");
		}
		this.client = undefined;
		this.transport = undefined;
		this.serverTools = new Set();
		this.capabilityState = { ...this.capabilityState, 忘却: false };
	}

	private requireClient(): McpClient {
		if (!this.running || !this.client) {
			throw new Error("mnemosyne 未启动或上次清理未完成(应先经 启动();由 MemoryVendorManager 保证)");
		}
		return this.client;
	}

	/**
	 * 把 EMBED_* 三键映射进子进程环境(只补缺,配置 env 显式给的优先):
	 * MNEMOSYNE_EMBEDDING_API_URL←EMBED_BASE_URL、…API_KEY←EMBED_API_KEY、…MODEL←EMBED_MODEL。
	 * 维度 MNEMOSYNE_EMBEDDING_DIM 不在此列——它不是密钥、且随库走,住配置 env。
	 */
	private injectEmbedEnv(): void {
		const embed = this.embedLoader();
		if (!embed) return;
		const inject: Record<string, string> = {
			MNEMOSYNE_EMBEDDING_API_URL: embed.baseUrl,
			MNEMOSYNE_EMBEDDING_API_KEY: embed.apiKey,
			MNEMOSYNE_EMBEDDING_MODEL: embed.model,
		};
		for (const [key, value] of Object.entries(inject)) {
			if (!this.params.env[key]) this.params.env[key] = value;
		}
	}

	private async callRequired(toolName: string, params: Record<string, unknown>): Promise<CallToolResult> {
		return await this.requireClient().callTool(toolName, params);
	}
}

/** mnemosyne 工厂(注册进供应商注册表的名字→工厂) */
export function createMnemosyneVendor(params: unknown): MnemosyneVendor {
	return new MnemosyneVendor(params);
}
