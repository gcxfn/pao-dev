/**
 * S9 存量卡迁移工具（正本对照＝`.pao/统一执行-20261007/S9调查/定名表-默认方案.md`，已锁定）。
 *
 * 迁移面＝卡文件（定名表 §9）：frontmatter 12 键改名＋3 英文键保留、CardBudget 协作配额→collab_quota、
 * 回执区 bullet 8 键改名＋已英文化载荷键（任务态/verification/changes）保留、值域五组（状态/优先级/档位/失败类型/留档）。
 * 不动面：回执段标题 `## 回执 尝试N …`（定名表未定义新标题格式，冻结原样，待 S9-内核包定案）、
 * owner记录审计区、机械验收 DSL、配方与控制清单键（D5）、配置文件键（D6）、卡文件名与卡号.txt。
 *
 * 纪律（S9 第 5 条）：显式目标根、dry-run 预览、未知键/无法唯一映射即拒（不猜）、转换前备份、
 * 逐文件结果、任一失败非零退出且停止提交（幂等重跑续上）。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { parse } from "yaml";
import { formatYamlValue, RECEIPT_HEADING_PATTERN } from "../cards/cardfile.ts";
import { writeFileAtomic } from "../shared/atomic.ts";

// ---------------------------------------------------------------------------
// 定名表（唯一事实源的代码化副本；改定名表须同批改这里）
// ---------------------------------------------------------------------------

/** CardFrontmatter 中文键 → 英文名（定名表 §3.1；depends_on/parent/owner 已英文保留）。 */
export const FRONTMATTER_KEY_MAP = {
	目标: "goal",
	部门: "dept",
	输入: "inputs",
	约束: "constraints",
	验收: "acceptance",
	档位: "tier",
	预算: "budget",
	优先级: "priority",
	尝试: "attempt",
	创建: "created",
	完成: "completed",
	状态: "status",
} as const;

/** CardBudget 嵌套键改名；turns/toolCalls/cost 已英文保留。 */
export const BUDGET_KEY_MAP = { 协作配额: "collab_quota" } as const;

/** 回执区 bullet 键（盘上 `- 键: 值`）改名；任务态/verification/changes 已英文化保留。 */
export const RECEIPT_BULLET_KEY_MAP = {
	留档: "archive_flag",
	结果: "result",
	摘要: "summary",
	产物路径: "artifact_path",
	证据: "evidence",
	用量: "usage",
	值得沉淀: "worth_distilling",
	失败类型: "failure_type",
} as const;

/** 值域映射（定名表 §4.1）。 */
export const VALUE_MAPS = {
	状态: { 待认领: "unclaimed", 进行中: "in_progress", 已交付: "delivered", 失败: "failed", 取消: "canceled" },
	优先级: { 高: "high", 中: "medium", 低: "low" },
	档位: { 快: "fast", 主力: "primary" },
	失败类型: {
		瞬时故障: "transient",
		缺输入: "missing_input",
		能力不足: "insufficient_capability",
		结果未知: "unknown_outcome",
	},
	留档: { 旧尝试留档: "old_attempt", 迟到回执: "late_receipt" },
} as const;

/** 新键序列化固定顺序（与 cardfile.ts FIELD_ORDER 同序、按 §3.1 换名）。 */
const NEW_FIELD_ORDER = [
	"goal",
	"dept",
	"inputs",
	"constraints",
	"acceptance",
	"depends_on",
	"parent",
	"tier",
	"budget",
	"priority",
	"owner",
	"attempt",
	"created",
	"completed",
	"status",
] as const;

/** frontmatter 必需字段（新名；对应 cardfile.ts REQUIRED_FIELDS）。 */
const REQUIRED_NEW = ["goal", "dept", "acceptance", "attempt", "created", "status"] as const;

const NEW_FM_NAMES = new Set<string>(Object.values(FRONTMATTER_KEY_MAP));
const FM_KEEP = new Set<string>(["depends_on", "parent", "owner"]);
const BUDGET_KEEP = new Set<string>(["turns", "toolCalls", "cost"]);
const BULLET_KEEP = new Set<string>(["任务态", "verification", "changes"]);
const NEW_BULLET_NAMES = new Set<string>(Object.values(RECEIPT_BULLET_KEY_MAP));

// ---------------------------------------------------------------------------
// 序列化：与 cardfile.ts 共用同一份实现（审查第 3 项——迁移输出是同类写卡路径，
// 字符串变型必须在同一个正本里修掉，不能各留一份副本）
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 单文件规划（纯函数：旧内容 → 新内容或冲突理由）
// ---------------------------------------------------------------------------

export type MigrationPlan =
	| { status: "ok"; content: string; changes: string[] }
	| { status: "conflict"; reason: string };

/** 值域归一：旧值→新值；已是新值原样；都不认识 → null（调用方判冲突）。 */
function mapValue(domain: keyof typeof VALUE_MAPS, value: unknown): string | null {
	if (typeof value !== "string") return null;
	const map = VALUE_MAPS[domain] as Record<string, string>;
	if (value in map) return map[value];
	if (Object.values(map).includes(value)) return value;
	return null;
}

export function planCardMigration(content: string): MigrationPlan {
	const normalized = content.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---\n")) {
		return { status: "conflict", reason: "无 frontmatter 信封（--- 开头）" };
	}
	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { status: "conflict", reason: "frontmatter 信封未闭合（缺结尾 ---）" };
	}
	const yamlBlock = normalized.slice(4, endIndex);
	const bodyRemainder = normalized.slice(endIndex + 4); // 含正文前空行，逐字节保留

	let fm: Record<string, unknown>;
	try {
		const parsed = parse(yamlBlock);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return { status: "conflict", reason: "frontmatter 不是键值映射" };
		}
		fm = parsed as Record<string, unknown>;
	} catch (error) {
		return { status: "conflict", reason: `frontmatter 无法解析：${String((error as Error).message).slice(0, 120)}` };
	}

	const changes: string[] = [];
	const renamed: Record<string, unknown> = {};

	// 键改名与冲突检测：未知键即拒；新旧并存即拒
	for (const [key, value] of Object.entries(fm)) {
		if (key in FRONTMATTER_KEY_MAP) {
			const newName = FRONTMATTER_KEY_MAP[key as keyof typeof FRONTMATTER_KEY_MAP];
			if (fm[newName] !== undefined) {
				return { status: "conflict", reason: `新旧键并存：${key}/${newName}` };
			}
			renamed[newName] = value;
			if (newName !== key) changes.push(`frontmatter ${key}→${newName}`);
		} else if (FM_KEEP.has(key) || NEW_FM_NAMES.has(key)) {
			renamed[key] = value;
		} else {
			return { status: "conflict", reason: `frontmatter 未知键（定名表未覆盖，不猜）：${key}` };
		}
	}
	for (const field of REQUIRED_NEW) {
		if (renamed[field] === undefined) {
			return { status: "conflict", reason: `缺必需字段：${field}` };
		}
	}

	// 值域映射（状态/优先级/档位）
	for (const domain of ["状态", "优先级", "档位"] as const) {
		const newKey = FRONTMATTER_KEY_MAP[domain];
		const raw = renamed[newKey];
		if (raw === undefined) continue;
		const mapped = mapValue(domain, raw);
		if (mapped === null) {
			return { status: "conflict", reason: `${domain}值无法映射：${String(raw)}` };
		}
		if (mapped !== raw) changes.push(`值 ${domain}:${String(raw)}→${mapped}`);
		renamed[newKey] = mapped;
	}

	// 预算嵌套键
	const budget = renamed.budget;
	if (budget !== undefined) {
		if (typeof budget !== "object" || budget === null || Array.isArray(budget)) {
			return { status: "conflict", reason: "budget 须为对象（turns/toolCalls/cost/collab_quota）" };
		}
		const newBudget: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(budget as Record<string, unknown>)) {
			if (key === "协作配额") {
				if ((budget as Record<string, unknown>).collab_quota !== undefined) {
					return { status: "conflict", reason: "预算内新旧键并存：协作配额/collab_quota" };
				}
				newBudget.collab_quota = value;
				changes.push("预算 协作配额→collab_quota");
			} else if (BUDGET_KEEP.has(key) || key === "collab_quota") {
				newBudget[key] = value;
			} else {
				return { status: "conflict", reason: `预算内未知键：${key}` };
			}
		}
		renamed.budget = newBudget;
	}

	// 正文：只动回执段 bullet 键与失败类型/留档值；其余逐字节保留（含 owner记录审计区）。
	// 段感知：`## 回执 尝试N` 开段，任何其他 `## ` 标题闭段——真实卡存在回执后的 owner记录区
	// （事件/依据 bullet），它们不属于回执区、保持原文（parseReceipts 的跨段吞并是读端无害行为，写端不照搬）。
	const lines = bodyRemainder.split("\n");
	let inReceipt = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		if (trimmed.startsWith("## ")) {
			inReceipt = RECEIPT_HEADING_PATTERN.test(trimmed);
			continue;
		}
		if (!inReceipt) continue;
		const field = /^- ([^:]+): ?(.*)$/.exec(line);
		if (!field) continue;
		const key = field[1].trim();
		const value = field[2];
		let newKey = key;
		if (key in RECEIPT_BULLET_KEY_MAP) {
			newKey = RECEIPT_BULLET_KEY_MAP[key as keyof typeof RECEIPT_BULLET_KEY_MAP];
		} else if (BULLET_KEEP.has(key) || NEW_BULLET_NAMES.has(key)) {
			newKey = key;
		} else {
			return { status: "conflict", reason: `回执区未知键（定名表未覆盖，不猜）：${key}` };
		}
		// 值域键（失败类型/留档；新旧键名都归一）
		if (key === "失败类型" || key === "failure_type") {
			const mapped = mapValue("失败类型", value.trim());
			if (mapped === null) {
				return { status: "conflict", reason: `失败类型值无法映射：${value.trim()}` };
			}
			changes.push(`回执 ${key}:${value.trim()}→${newKey}:${mapped}`);
			lines[i] = `- ${newKey}: ${mapped}`;
			continue;
		}
		if (key === "留档" || key === "archive_flag") {
			const mapped = mapValue("留档", value.trim());
			if (mapped === null) {
				return {
					status: "conflict",
					reason: `留档值无法映射：${value.trim()}（定名表只定 旧尝试留档/迟到回执 两值）`,
				};
			}
			changes.push(`回执 ${key}:${value.trim()}→${newKey}:${mapped}`);
			lines[i] = `- ${newKey}: ${mapped}`;
			continue;
		}
		const rebuilt = `- ${newKey}: ${value}`;
		if (rebuilt !== line) changes.push(`回执 ${key}→${newKey}`);
		lines[i] = rebuilt;
	}

	const fmLines: string[] = [];
	for (const key of NEW_FIELD_ORDER) {
		const value = renamed[key];
		if (value === undefined) continue;
		fmLines.push(`${key}: ${formatYamlValue(value)}`);
	}
	const newContent = `---\n${fmLines.join("\n")}\n---${lines.join("\n")}`;
	return { status: "ok", content: newContent, changes };
}

// ---------------------------------------------------------------------------
// 目录级执行（显式根、备份、逐文件结果、失败即停）
// ---------------------------------------------------------------------------

export interface FileMigrationResult {
	file: string;
	status: "migrated" | "unchanged" | "would-migrate" | "conflict" | "error";
	changes: string[];
	detail?: string;
}

export interface MigrationOptions {
	dryRun?: boolean;
	/** 备份目录（缺省 <root>/.pao-migration-backup）；首份备份不随后续运行覆盖。 */
	backupDir?: string;
	/** 演练用：逐文件间同步停顿毫秒数（制造可杀窗口）。 */
	sleepMs?: number;
	/** 逐文件结果回调（CLI 流式输出用）。 */
	onResult?: (result: FileMigrationResult) => void;
}

export interface MigrationRun {
	results: FileMigrationResult[];
	exitCode: 0 | 1;
}

const CARD_FILE_PATTERN = /^卡0*\d+-.*\.md$/;

function listCardFiles(root: string, subdir = ""): string[] {
	const abs = join(root, subdir);
	const found: string[] = [];
	for (const entry of readdirSync(abs, { withFileTypes: true })) {
		const rel = subdir ? `${subdir}/${entry.name}` : entry.name;
		if (entry.isDirectory()) found.push(...listCardFiles(root, rel));
		else if (entry.isFile() && CARD_FILE_PATTERN.test(entry.name)) found.push(rel);
	}
	return found.sort();
}

function syncSleep(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 迁移 root 下全部卡文件（递归，卡名模式与 listCards 一致）。
 * 实跑遇任一 conflict/error 即停（不全量提交，幂等重跑续上）；dry-run 全量预览不写盘。
 */
export function runCardMigration(root: string, options: MigrationOptions = {}): MigrationRun {
	const absRoot = resolve(root);
	if (!existsSync(absRoot)) throw new Error(`目标根不存在：${absRoot}（--root 必填，不猜默认）`);
	// 备份缺省放目标根的同级目录（不得在根内：扫描递归会把备份本体也迁掉，毁掉可恢复副本）
	const backupDir =
		options.backupDir !== undefined
			? resolve(options.backupDir)
			: join(dirname(absRoot), `${basename(absRoot)}-migration-backup`);
	if (backupDir === absRoot || backupDir.startsWith(`${absRoot}${sep}`)) {
		throw new Error(`备份目录不能位于目标根内（重跑会迁移备份本体）：${backupDir}`);
	}
	const results: FileMigrationResult[] = [];
	const emit = (result: FileMigrationResult) => {
		results.push(result);
		options.onResult?.(result);
	};
	for (const rel of listCardFiles(absRoot)) {
		const absPath = join(absRoot, rel);
		let content: string;
		let plan: MigrationPlan;
		try {
			content = readFileSync(absPath, "utf8");
			plan = planCardMigration(content);
		} catch (error) {
			emit({ file: rel, status: "error", changes: [], detail: String((error as Error).message).slice(0, 200) });
			return { results, exitCode: 1 };
		}
		if (plan.status === "conflict") {
			emit({ file: rel, status: "conflict", changes: [], detail: plan.reason });
			if (!options.dryRun) return { results, exitCode: 1 }; // 任一失败即停，不全量提交
			continue; // dry-run 继续全量预览，但退出码仍记失败
		}
		if (plan.content === content) {
			emit({ file: rel, status: "unchanged", changes: [] });
		} else if (options.dryRun) {
			emit({ file: rel, status: "would-migrate", changes: plan.changes });
		} else {
			const backupPath = join(backupDir, rel);
			if (!existsSync(backupPath)) {
				mkdirSync(dirname(backupPath), { recursive: true });
				copyFileSync(absPath, backupPath); // 转换前可恢复副本；首份不覆盖
			}
			writeFileAtomic(absPath, plan.content);
			emit({ file: rel, status: "migrated", changes: plan.changes });
		}
		if (options.sleepMs && options.sleepMs > 0) syncSleep(options.sleepMs);
	}
	const failed = results.some((r) => r.status === "conflict" || r.status === "error");
	return { results, exitCode: failed ? 1 : 0 };
}
