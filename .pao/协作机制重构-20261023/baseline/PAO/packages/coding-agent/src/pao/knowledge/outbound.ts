/**
 * 禁外发检查（架构 §6.3 红线 + R08）。
 *
 * 「哪些项目的资料允许外发云端」是配置项，不只查密钥。
 * 查询嵌入、条目嵌入、批量重建三个入口共享同一个 checkOutbound 函数，
 * 不各写一份。配置变化先阻断新外发；缓存清理不等于撤回上游已收数据。
 */
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { readJsonSafe } from "../shared/json.ts";
import { paoHome } from "./paths.ts";

export interface OutboundRule {
	/** 是否允许该项目语料发往云端嵌入端点 */
	allowed: boolean;
	/** 授权截至日期 YYYY-MM-DD（可随时撤销，撤销只阻断新外发） */
	asOf: string;
}

export interface OutboundConfig {
	/** 项目名 -> 授权条目。未列出的项目一律不允许。 */
	projects: Record<string, OutboundRule>;
}

/** 外发许可配置文件位置（PAO_HOME 下，凭证不入库，这里只存许可清单）。 */
export function outboundConfigPath(home: string = paoHome()): string {
	return join(home, "知识库配置", "外发许可.json");
}

/** 缺文件或解析失败都按「没有任何项目被授权」处理（保守）。 */
export function loadOutboundConfig(
	home: string = paoHome(),
	env: Record<string, string | undefined> = process.env,
): OutboundConfig {
	const override = env.PAO_OUTBOUND_CONFIG;
	const file = override ? override : outboundConfigPath(home);
	// 容错读点走 shared readJsonSafe（缺失/不可读/坏 JSON 一律 undefined），语义与旧散装点逐字对齐；
	// 副作用只有一处且按 shared 口径是改进：UTF-8 BOM 不再当坏 JSON（原本必炸的输入，坏的是工具不是配置）
	const raw = readJsonSafe(file) as Partial<OutboundConfig> | undefined;
	if (!raw || typeof raw.projects !== "object" || raw.projects === null) return { projects: {} };
	return { projects: raw.projects };
}

export interface OutboundCheck {
	allowed: boolean;
	/** 被阻断的项目名（含「未知」占位） */
	blocked: string[];
}

/** 适用范围缺失占位：未知来源一律不发云端（R08：缺失标未知，不自动认有效）。 */
export const UNKNOWN_PROJECT = "未知";

/**
 * 唯一的禁外发判定函数。projects 里出现任何未被显式授权（allowed===true）的
 * 项目即整体阻断——同一批请求里混入未授权语料也算违规。
 */
export function checkOutbound(projects: string[], config: OutboundConfig, now: Date = new Date()): OutboundCheck {
	const normalized = projects.length === 0 ? [UNKNOWN_PROJECT] : projects;
	const blocked: string[] = [];
	const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
	for (const p of normalized) {
		// Windows 项目目录大小写不改变身份，但不将 pao-dev 等不同名字映射到 PAO。
		const rule =
			config.projects[p] ??
			(process.platform === "win32"
				? Object.entries(config.projects).find(([name]) => name.toLowerCase() === p.toLowerCase())?.[1]
				: undefined);
		if (!rule || rule.allowed !== true || !/^\d{4}-\d{2}-\d{2}$/.test(rule.asOf) || rule.asOf < today) {
			blocked.push(p);
		}
	}
	return { allowed: blocked.length === 0, blocked };
}

/** 从宿主 cwd 取项目名：最近的 git 根优先，非 git 目录用 cwd；不读取模型工具参数。 */
export function projectFromCwd(cwd: string | undefined): string | undefined {
	if (!cwd?.trim()) return undefined;
	const start = resolve(cwd);
	let dir = start;
	while (true) {
		if (existsSync(join(dir, ".git"))) return basename(dir) || undefined;
		const parent = dirname(dir);
		if (parent === dir) return basename(start) || undefined;
		dir = parent;
	}
}
