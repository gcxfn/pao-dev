/**
 * 记忆供应商插拔接口（架构 §18.5,M2-05）。
 *
 * 契约（定案锁死）：供应商＝名字→工厂;供应商实现 写入/召回/忘却(可选)＋能力声明;
 * 换供应商＝改配置,数据不自动迁移。配置住 `$PAO_HOME/pao配置/记忆供应商.json`,
 * **缺文件＝不启用记忆,静默不装不报错**(记忆是纯增益能力,没有它主控照常干活);
 * 配置存在但坏(坏 JSON/缺字段/查无此厂)＝结构化警告＋降级为无记忆,不阻断会话
 * ——与档位缺失同款哲学(index.ts「配置缺失=未用此功能」)。
 *
 * 生命周期（R05 用户态,不做常驻服务）：供应商子进程由主会话惰性拉起(首次读写才 spawn,
 * 不给每个会话白付一份冷启动),随主会话 session_shutdown 全停进程树。停树不抄 worker
 * internals——pi-mcp 的 StdioTransport.close() 自带同款语义(stdin 宽限→SIGTERM→SIGKILL,
 * Windows taskkill /T /F 杀整棵树),本模块只管幂等关闭与状态翻转。
 *
 * 降级语义：启动失败(命令不存在/initialize 超时/工具清单不符)＝本会话内标记已降级,
 * 后续读写直接返回无记忆提示,不反复重试 spawn(Windows stdio 冷启动贵,定案实施核);
 * 会话边界(session_shutdown 关闭)后状态复位,下个会话再给一次机会。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseJsonRaw } from "../shared/json.ts";
import { logWarn } from "../shared/log.ts";

/** 供应商能力声明（§18.5:是否语义检索、是否需嵌入端点、忘却可选） */
export interface MemoryCapabilities {
	/** 召回是否含语义(向量)路;false=纯词法 */
	语义检索: boolean;
	/**
	 * pao 侧是否需要供给嵌入端点。mnemosyne 的 API 配置由 EMBED_* 补缺注入子进程环境。
	 */
	需嵌入端点: boolean;
	/** 是否支持忘却(忘却是可选契约;调用方须先取得显式授权,§18.5) */
	忘却: boolean;
}

/** 一条召回命中:内容必带,相关度/来源供应商能给就给 */
export interface MemoryHit {
	内容: string;
	/** 供应商的准确 ID，授权忘却时用；不能用检索词代替。 */
	记忆ID?: string;
	相关度?: number;
	来源?: string;
}

export interface MemoryWriteReceipt {
	记忆ID: string;
	状态: string;
}

/**
 * 记忆供应商契约。实现方保证:启动前调用 写入/召回/忘却 抛错(不要自己静默 spawn);
 * 关闭 幂等。启动失败抛结构化中文错误——降级判定在 MemoryVendorManager,不在供应商内。
 */
export interface MemoryVendor {
	readonly vendorName: string;
	readonly capabilities: MemoryCapabilities;
	/** 惰性启动:拉起子进程/建连/校验工具清单;幂等(已启动直接返回) */
	start(): Promise<void>;
	/** 写入一条记忆;标签可选 */
	write(content: string, label?: readonly string[]): Promise<MemoryWriteReceipt> | Promise<void>;
	/** 召回:按检索词取前 上限 条(缺省由适配器定,§18.1 口径 top3) */
	recall(searchQuery: string, limit?: number): Promise<MemoryHit[]>;
	/** 忘却:按准确记忆 ID 清除,返回清除条数;仅 能力.忘却=true 的供应商实现 */
	forget?(memoryId: string): Promise<number>;
	/** 随主会话 session_shutdown 停子进程树;幂等 */
	close(): Promise<void>;
}

/** 供应商工厂:接收配置里的「参数」(形状由各供应商自定义),产出供应商实例(同步构造,连接走 启动) */
export type MemoryVendorFactory = (params: unknown) => MemoryVendor;

// ============================================================================
// 供应商注册表(名字→工厂;插拔的「拔」就是换配置里的名字)
// ============================================================================

const vendorFactories = new Map<string, MemoryVendorFactory>();

/** 登记一个记忆供应商工厂;同名重复登记以最后一次为准(测试注入用) */
export function registerMemoryVendor(vendorName: string, factory: MemoryVendorFactory): void {
	vendorFactories.set(vendorName, factory);
}

/** 查工厂;查无此厂返回 undefined(配置指向未注册供应商＝坏配置,调用方降级) */
export function getMemoryVendorFactory(vendorName: string): MemoryVendorFactory | undefined {
	return vendorFactories.get(vendorName);
}

/** 已注册的供应商名(报错提示用) */
export function listMemoryVendors(): string[] {
	return [...vendorFactories.keys()];
}

// ============================================================================
// 配置($PAO_HOME/pao配置/记忆供应商.json)
// ============================================================================

/** 记忆供应商配置文件在 PAO_HOME 下的相对路径 */
export const MEMORY_CONFIG_RELATIVE_PATH = join("pao配置", "记忆供应商.json");

/** 记忆供应商配置文件路径:$PAO_HOME/pao配置/记忆供应商.json */
export function resolveMemoryConfigPath(paoHome: string): string {
	return join(paoHome, MEMORY_CONFIG_RELATIVE_PATH);
}

/** 配置形状:「供应商」指工厂注册名;「参数」原样透传给该工厂(形状各供应商自定义) */
export interface MemoryVendorConfig {
	供应商: string;
	参数: Record<string, unknown>;
	/** §18.1 每轮自动召回 top3 开关;缺省/缺字段＝false,不开则既有行为逐字节不变 */
	自动召回?: boolean;
	/** §18.1 上下文压缩交接开关(压缩摘要 handoff 写进供应商);缺省/缺字段＝false */
	自动交接?: boolean;
}

/**
 * 读并校验记忆供应商配置。三级语义:
 * - 文件不存在 → 返回 undefined(＝不启用记忆,调用方静默不装,不算错);
 * - 文件存在但坏(坏 JSON/顶层不是对象/缺「供应商」) → 抛结构化中文错误(调用方警告＋降级);
 * - 合法 → 返回 {供应商, 参数} ＋ 可选开关「自动召回」「自动交接」(布尔,缺省关)。
 */
export function loadMemoryVendorConfig(configPath: string): MemoryVendorConfig | undefined {
	let raw: string;
	try {
		raw = readFileSync(configPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`无法读取记忆供应商配置 ${configPath}:${(error as Error).message}`);
	}
	let parsed: unknown;
	try {
		parsed = parseJsonRaw(raw);
	} catch (error) {
		throw new Error(`记忆供应商配置 ${configPath} 不是合法 JSON:${(error as Error).message}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`记忆供应商配置 ${configPath} 的顶层应为 JSON 对象`);
	}
	const obj = parsed as Record<string, unknown>;
	if (typeof obj.供应商 !== "string" || !obj.供应商.trim()) {
		throw new Error(`记忆供应商配置 ${configPath} 缺少字段「供应商」(字符串,如 "mnemosyne")`);
	}
	const params = obj.参数;
	if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) {
		throw new Error(`记忆供应商配置 ${configPath} 的「参数」应为对象(或缺省)`);
	}
	const autoRecall = obj.自动召回;
	const autoHandoff = obj.自动交接;
	if (autoRecall !== undefined && typeof autoRecall !== "boolean") {
		throw new Error(`记忆供应商配置 ${configPath} 的「自动召回」应为布尔值(true/false)`);
	}
	if (autoHandoff !== undefined && typeof autoHandoff !== "boolean") {
		throw new Error(`记忆供应商配置 ${configPath} 的「自动交接」应为布尔值(true/false)`);
	}
	return {
		供应商: obj.供应商.trim(),
		参数: (params ?? {}) as Record<string, unknown>,
		...(autoRecall !== undefined ? { 自动召回: autoRecall } : {}),
		...(autoHandoff !== undefined ? { 自动交接: autoHandoff } : {}),
	};
}

// ============================================================================
// 生命周期管理:惰性获取 ＋ 降级 ＋ 随会话关闭
// ============================================================================

export type MemoryVendorState = "待启动" | "已就绪" | "已降级";

/** 结构化警告的默认出口(shared/log 单点;测试注入捕获) */
export type MemoryWarnSink = (message: string) => void;

/**
 * 会话级记忆供应商管家:注册时已验过配置与工厂(见 memory/index.ts registerMemory),
 * 这里只管 惰性启动/失败降级/幂等关闭。
 */
export class MemoryVendorManager {
	private vendor: MemoryVendor | undefined;
	private state: MemoryVendorState = "待启动";
	private degradedReason: string | undefined;
	private readonly config: MemoryVendorConfig;
	private readonly onWarn: MemoryWarnSink;
	/** 在途启动：并发 acquire 共用同一份启动结果,不双拉供应商子进程 */
	private acquiring: Promise<MemoryVendor | undefined> | undefined;
	/** 生命周期世代：close 使其自增,让「关闭后才完成的启动」失效(不复活状态,立即关掉迟到实例) */
	private generation = 0;

	constructor(config: MemoryVendorConfig, onWarn: MemoryWarnSink = logWarn) {
		this.config = config;
		this.onWarn = onWarn;
	}

	get status(): MemoryVendorState {
		return this.state;
	}

	get vendorName(): string {
		return this.config.供应商;
	}

	/** 已降级的原因(未降级为 undefined) */
	get degradeReason(): string | undefined {
		return this.degradedReason;
	}

	/**
	 * 惰性获取已启动的供应商。已就绪→复用实例;在途启动→复用同一份启动结果(并发只 start 一次);
	 * 待启动→构造＋启动(失败即降级并警告,本会话内不再重试,后续调用拿到 undefined);
	 * 已降级→直接 undefined。
	 */
	async acquire(): Promise<MemoryVendor | undefined> {
		if (this.state === "已降级") return undefined;
		if (this.vendor) return this.vendor;
		if (this.acquiring) return this.acquiring;
		const generation = this.generation;
		// start 的同步前缀在赋值 acquiring 前跑完,同一 tick 的第二个 acquire 必然看到 acquiring。
		const pending = this.start(generation);
		this.acquiring = pending;
		try {
			return await pending;
		} finally {
			if (this.acquiring === pending) this.acquiring = undefined;
		}
	}

	/** 真正拉起供应商;generation 与关闭世代不符时视为「关闭后迟到的启动」并立即关掉。 */
	private async start(generation: number): Promise<MemoryVendor | undefined> {
		const factory = getMemoryVendorFactory(this.config.供应商);
		if (!factory) {
			// 注册时已验过工厂,这里只防运行期被反注册(测试);按坏配置同款降级
			if (generation === this.generation) this.markDegraded(`记忆供应商「${this.config.供应商}」没有已注册的工厂`);
			return undefined;
		}
		let vendor: MemoryVendor;
		try {
			vendor = factory(this.config.参数);
		} catch (error) {
			if (generation === this.generation)
				this.markDegraded(
					`记忆供应商「${this.config.供应商}」构造失败,已降级为无记忆(会话不受影响):${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			return undefined;
		}
		try {
			await vendor.start();
		} catch (error) {
			await vendor.close().catch(() => {});
			const message = error instanceof Error ? error.message : String(error);
			if (generation === this.generation)
				this.markDegraded(`记忆供应商「${this.config.供应商}」启动失败,已降级为无记忆(会话不受影响):${message}`);
			return undefined;
		}
		if (generation !== this.generation) {
			// close 已在启动期间发生:迟到实例不得把状态复活,当场关掉。
			await vendor.close().catch(() => {});
			return undefined;
		}
		this.vendor = vendor;
		this.state = "已就绪";
		return vendor;
	}

	/**
	 * 随主会话 session_shutdown 调用:停子进程树,幂等;状态复位(含已降级),
	 * 下个会话(reload/new 后扩展实例存活的场景)重新给一次启动机会。
	 * 关闭让世代自增:启动中的实例完成后自行关闭,不会复活;新 acquire 可重新拉起。
	 */
	async close(): Promise<void> {
		const vendor = this.vendor;
		const pending = this.acquiring;
		this.generation++;
		this.vendor = undefined;
		this.acquiring = undefined;
		this.state = "待启动";
		this.degradedReason = undefined;
		if (vendor) await vendor.close();
		// 在途启动不在这里等:供应商 start 可能长时间不返回,等它会把会话关闭卡住。
		// 迟到实例自己会在 start 里看到世代变化并当场关掉(上面的 generation 检查);这里只认领 rejection,避免未处理拒绝。
		if (pending) void pending.catch(() => {});
	}

	private markDegraded(reason: string): void {
		this.state = "已降级";
		this.degradedReason = reason;
		this.onWarn(`[pao] ${reason}`);
	}
}
