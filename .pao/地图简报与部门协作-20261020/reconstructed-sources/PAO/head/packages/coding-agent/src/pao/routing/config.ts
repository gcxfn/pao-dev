import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

import { writeFileAtomic } from "../shared/atomic.ts";
import { parseJsonRaw } from "../shared/json.ts";

/** 可选思考档全集(与 pi 虚拟模型机制一致) */
export const THINKING_LEVELS: readonly ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/** 虚拟模型默认挂载的 provider id */
export const DEFAULT_VIRTUAL_PROVIDER = "pao";

/** 档位配置文件在 PAO_HOME 下的相对路径 */
export const TIER_CONFIG_RELATIVE_PATH = join("pao配置", "档位.json");

/** 档位定义:封装一个物理模型 + 推荐思考档。协议层只见档位名,换模型只改配置。 */
export interface TierDefinition {
	/** 档位名,即虚拟模型 id(如「快」「主力」) */
	名: string;
	/** 物理模型所属 provider */
	provider: string;
	/** 物理模型 id */
	model: string;
	/** 推荐思考档:注册为该虚拟模型的默认选中档;用户显式选档时跟随请求 */
	thinkingLevel: ModelThinkingLevel;
	/** 可选:首个响应前的上下文窗口展示值 */
	contextWindow?: number;
	/** 可选:首个响应前的最大输出展示值 */
	maxTokens?: number;
}

/** 档位配置文件结构(pao配置/档位.json) */
export interface TierConfig {
	/** 虚拟模型挂载的 provider id,缺省 "pao" */
	provider: string;
	/** 档位清单,至少一档 */
	档位: TierDefinition[];
	/** 可选:部门默认档(部门名→档名;§22 编辑器可改,查无档名校验报错) */
	部门默认?: Record<string, string>;
}

/** 读并校验档位配置。缺字段/字段不合法直接抛结构化中文错误(指明缺哪个),不做静默兜底。 */
export function loadTierConfig(configPath: string): TierConfig {
	let raw: string;
	try {
		raw = readFileSync(configPath, "utf8");
	} catch (error) {
		throw new Error(`无法读取档位配置文件 ${configPath}:${(error as Error).message}`);
	}
	let parsed: unknown;
	try {
		parsed = parseJsonRaw(raw);
	} catch (error) {
		throw new Error(`档位配置文件 ${configPath} 不是合法 JSON:${(error as Error).message}`);
	}
	return validateTierConfig(parsed, configPath);
}

/** 校验档位配置对象;所有错误都指明出处与缺失字段 */
export function validateTierConfig(parsed: unknown, source: string): TierConfig {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`档位配置 ${source} 的顶层应为 JSON 对象`);
	}
	const obj = parsed as Record<string, unknown>;
	const provider =
		typeof obj.provider === "string" && obj.provider.trim() ? obj.provider.trim() : DEFAULT_VIRTUAL_PROVIDER;
	if (!Array.isArray(obj.档位) || obj.档位.length === 0) {
		throw new Error(`档位配置 ${source} 缺少字段「档位」(非空数组,每项含 名/provider/model/thinkingLevel)`);
	}
	const tiers = obj.档位.map((entry, index) => validateTier(entry, index, source));
	const seen = new Set<string>();
	for (const tier of tiers) {
		if (seen.has(tier.名)) {
			throw new Error(
				`档位配置 ${source} 存在重复档名「${tier.名}」(档位名即虚拟模型 id,须唯一,否则注册时静默覆盖丢档)`,
			);
		}
		seen.add(tier.名);
	}
	const config: TierConfig = { provider, 档位: tiers };
	if (obj.部门默认 !== undefined) {
		config.部门默认 = validateDeptDefaults(obj.部门默认, tiers, source);
	}
	return config;
}

/** 部门默认档校验:对象且每值须为已定义档名(部门名非空字符串) */
function validateDeptDefaults(raw: unknown, tier: TierDefinition[], source: string): Record<string, string> {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error(`档位配置 ${source} 的「部门默认」应为对象(部门名→档名)`);
	}
	const names = new Set(tier.map((t) => t.名));
	const result: Record<string, string> = {};
	for (const [dept, tier] of Object.entries(raw as Record<string, unknown>)) {
		if (!dept.trim()) {
			throw new Error(`档位配置 ${source} 的「部门默认」含空部门名`);
		}
		if (typeof tier !== "string" || !names.has(tier)) {
			throw new Error(
				`档位配置 ${source} 的「部门默认.${dept}」引用未定义档位「${String(tier)}」(现有:${[...names].join("、")})`,
			);
		}
		result[dept.trim()] = tier;
	}
	return result;
}

function validateTier(entry: unknown, index: number, source: string): TierDefinition {
	const where = `档位配置 ${source} 的「档位[${index}]」`;
	if (typeof entry !== "object" || entry === null) {
		throw new Error(`${where} 应为对象`);
	}
	const obj = entry as Record<string, unknown>;
	for (const field of ["名", "provider", "model"] as const) {
		if (typeof obj[field] !== "string" || !(obj[field] as string).trim()) {
			throw new Error(`${where} 缺少字段「${field}」`);
		}
	}
	if (typeof obj.thinkingLevel !== "string" || !THINKING_LEVELS.includes(obj.thinkingLevel as ModelThinkingLevel)) {
		throw new Error(
			`${where} 缺少合法的「thinkingLevel」(须为 ${THINKING_LEVELS.join("/")} 之一,实际 ${JSON.stringify(obj.thinkingLevel)})`,
		);
	}
	const tier: TierDefinition = {
		名: (obj.名 as string).trim(),
		provider: (obj.provider as string).trim(),
		model: (obj.model as string).trim(),
		thinkingLevel: obj.thinkingLevel as ModelThinkingLevel,
	};
	// 档名撞名防御：显式「模型」字段先按档名试解析再当 provider/model 直通——档名带斜杠时
	// 会被误当模型名命中（静默换模型），在配置加载这一处拒掉，两端（部长启动/worker 派单）同批生效。
	if (tier.名.includes("/")) {
		throw new Error(`${where} 的「名」不可含斜杠（避免与 provider/model 模型名混淆）:${tier.名}`);
	}
	for (const field of ["contextWindow", "maxTokens"] as const) {
		const value = obj[field];
		if (value === undefined) continue;
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
			throw new Error(`${where} 的「${field}」应为正数`);
		}
		tier[field] = value;
	}
	return tier;
}

/** 从环境解析 PAO_HOME(使用现场根目录,含「部门/」与「pao配置/」);缺失即报错,不猜测路径 */
export function resolvePaoHome(env: NodeJS.ProcessEnv = process.env): string {
	const home = env.PAO_HOME?.trim();
	if (!home) {
		throw new Error("缺少环境变量 PAO_HOME(使用现场根目录,应含「部门/」与「pao配置/」;开发仓与使用现场是两个仓库)");
	}
	return home;
}

/** 档位配置文件路径:$PAO_HOME/pao配置/档位.json */
export function resolveTierConfigPath(paoHome: string): string {
	return join(paoHome, TIER_CONFIG_RELATIVE_PATH);
}

/**
 * 内置档位名别名归一（定名表 §6 例外 1）：卡面 tier 值用英文 fast/primary，
 * 存量 档位.json 的内置档名仍是中文 快/主力——两侧都归一到中文正名再比对；
 * 用户自建档名不参与归一，新建 PAO_HOME 内置档名直接英文（fast/primary 归一后仍命中自身）。
 */
const TIER_ALIASES: Record<string, string> = { fast: "快", primary: "主力" };

function tierAliasKey(name: string): string {
	return TIER_ALIASES[name] ?? name;
}

/** 按档位名取定义;查无此档报错并列出现有档位 */
export function resolveTier(config: TierConfig, name: string): TierDefinition {
	const wanted = tierAliasKey(name);
	const tier = config.档位.find((candidate) => tierAliasKey(candidate.名) === wanted);
	if (!tier) {
		throw new Error(`未找到档位「${name}」,配置中现有:${config.档位.map((candidate) => candidate.名).join("、")}`);
	}
	return tier;
}

/**
 * 文件名时间戳:本地时间 YYYYMMDD-HHmmss-fff(文件名安全)。档位配置备份与部长留证共用同一口径。
 * 毫秒补零三位定宽——字典序即时间序,备份文件按名排序就是改动顺序;
 * 只到秒时同一秒内连改两次,第二次备份会盖掉第一次(丢一份改前快照),故必须到毫秒。
 */
export function backupTimestamp(date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	const pad3 = (n: number) => String(n).padStart(3, "0");
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad3(date.getMilliseconds())}`;
}

/**
 * 档位名→物理模型 provider/model＋该档推荐思考档(别名归一见 resolveTier)。
 * 部长启动(host-bridge --model)与 worker 派单(dispatch-core)共用的唯一解析口径;
 * 配置不可读/查无此档由 loadTierConfig/resolveTier 抛结构化中文错误。
 */
export function tierNameToModel(
	config: TierConfig,
	tierName: string,
): { model: string; thinkingLevel: ModelThinkingLevel } {
	const tier = resolveTier(config, tierName);
	return { model: `${tier.provider}/${tier.model}`, thinkingLevel: tier.thinkingLevel };
}

/**
 * §22 编辑器写回:写前自校验(调用方拼出的结构再过一遍 schema)＋旧文件时间戳备份＋原子写。
 * 备份失败如实抛错——保险不可静默跳过;旧文件不存在(首建)无备份直接写。
 * 序列化 tab 缩进(与既有 档位.json 格式一致),保留 部门默认 可选字段。
 */
export function saveTierConfig(configPath: string, config: TierConfig, now: () => Date = () => new Date()): string {
	validateTierConfig(config, configPath);
	if (existsSync(configPath)) {
		// 同毫秒不覆盖:时间戳到毫秒仍可能撞(连续保存快于 1ms),已存在则追加序号 -1 -2 ……
		// 定宽时间戳＋递增序号保证字典序=时间序,同毫秒内的多份备份并存不互盖。
		const timestamp = backupTimestamp(now());
		let backupPath = `${configPath}.bak-${timestamp}`;
		for (let ordinal = 1; existsSync(backupPath); ordinal++) {
			backupPath = `${configPath}.bak-${timestamp}-${ordinal}`;
		}
		copyFileSync(configPath, backupPath);
	}
	writeFileAtomic(configPath, `${JSON.stringify(config, null, "\t")}\n`);
	return configPath;
}
