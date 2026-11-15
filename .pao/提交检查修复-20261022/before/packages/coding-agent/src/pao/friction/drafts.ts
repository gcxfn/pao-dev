/**
 * 摩擦日志自动草稿（M0-08）：打回／重试到顶／升级人／扇出取消四事件发生时，
 * 机械往 $PAO_HOME/.pao/摩擦草稿.md 追加事实；正式摩擦日志由开发项目维护。
 *
 * 规格出处：pao 仓库根 摩擦日志.md 头部「自动草稿机制」段（M0-08 定案）。
 * 分工：机器只灌事实，人补一句「为什么难受」后把行移进正式区（转正）。
 *
 * 机制要点：
 * - 去重：同「卡目录＋卡号＋场景」累计次数，不合并不同项目的同号卡；
 * - 周清：每次追加时顺带清掉「最后更新时间超过 7 天」的草稿行（惰性 GC，不建定时器——纪律 R05 不做常驻）；
 *   转正＝人把行从草稿区剪走，留在草稿区即视为未转正；
 * - 并发安全：跨进程文件锁（shared/lock.ts）内完成读改写，写盘走原子写（shared/atomic.ts）；
 *   同进程多次追加经模块级写队列串行，避免锁内自旋；
 * - 文件缺失：只创建「# 摩擦日志」＋「## 草稿区」两级骨架（正文本体归外层仓库管）；
 *   草稿区标题缺失则在文件尾补标题（本文件约定草稿区为最后一段）；
 * - 只认机器格式的行做去重/周清，人手写或改写过的其他行原样保留。
 *
 * 草稿行格式（单行，字段用「 | 」分隔）：
 *   - [草稿] 2026-10-02 14:30 | 打回 | 卡0001 | ×1 | 机械校验拒绝：部门「X」不在注册表
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { writeFileAtomic } from "../shared/atomic.ts";
import { withFileLock } from "../shared/lock.ts";
import { logWarn } from "../shared/log.ts";
import { pathKey } from "../shared/path-key.ts";

/** 四类摩擦场景（与 M0-08 定案一一对应） */
export const FRICTION_SCENARIOS = ["打回", "重试到顶", "升级人", "扇出取消"] as const;
export type FrictionScenario = (typeof FRICTION_SCENARIOS)[number];

/** 一条草稿的机器可见事实 */
export interface FrictionDraftEntry {
	场景: FrictionScenario;
	/** 卡号（格式化引用，如 卡0001）；无卡号事件传「无」 */
	卡号: string;
	/** 事件所属卡目录，用完整路径区分不同项目的同号卡。 */
	卡目录?: string;
	/** 一句话机器可见事实（多行会被压成单行） */
	事实: string;
}

export interface FrictionDraftOptions {
	/** 时间源（测试注入）；缺省 new Date() */
	时间?: () => Date;
}

/** 运行时只记录草稿；正式日志仍在开发项目，不在使用现场另造一份。 */
export function frictionLogPath(home: string): string {
	return join(home, ".pao", "摩擦草稿.md");
}

/** 文件不存在时创建的最小骨架：只有两级标题，正式区内容归外层仓库维护 */
const SKELETON = "# 摩擦日志\n\n## 草稿区";

/** 草稿行解析；不匹配机器格式的行（占位文字、人补记行）返回 undefined，原样保留 */
const DRAFT_LINE_RE =
	/^- \[草稿\] (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) \| ([^|]+?) \| ([^|]+?) \| ×(\d+) \| (.*?)(?: \| 卡目录=(.*))?$/;

interface ParsedDraftLine {
	/** 最后更新时间（YYYY-MM-DD HH:mm，即行首时间戳；去重命中时刷新） */
	时间: string;
	场景: string;
	卡号: string;
	次数: number;
	事实: string;
	卡目录?: string;
}

/** 事实压成单行并限长，避免一条草稿占多行破坏「一行一事」 */
function sanitizeFact(fact: string): string {
	const oneLine = fact.replace(/\s*\r?\n\s*/g, " ").trim();
	return oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine;
}

function renderDraftLine(
	scenario: string,
	cardNo: string,
	fact: string,
	times: number,
	time: string,
	cardDir?: string,
): string {
	return `- [草稿] ${time} | ${scenario} | ${cardNo} | ×${times} | ${sanitizeFact(fact)}${cardDir ? ` | 卡目录=${cardDir}` : ""}`;
}

function parseDraftLine(line: string): ParsedDraftLine | undefined {
	const match = DRAFT_LINE_RE.exec(line.trim());
	if (!match) return undefined;
	return { 时间: match[1], 场景: match[2], 卡号: match[3], 次数: Number(match[4]), 事实: match[5], 卡目录: match[6] };
}

/** "YYYY-MM-DD HH:mm" → 本地时区 Date（解析失败返回 undefined，按不清理处理） */
function parseTimestamp(text: string): Date | undefined {
	const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(text);
	if (!match) return undefined;
	const [, y, m, d, h, min] = match;
	return new Date(Number(y), Number(m) - 1, Number(d), Number(h), Number(min));
}

/** 周清阈值：最后更新时间超过 7 天的草稿行清掉 */
const GC_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** 同进程追加串行队列：同步挂钩点（状态机）只能尾随写入，队列避免两次追加并发进锁 */
let writeQueue: Promise<void> = Promise.resolve();

/**
 * 追加一条摩擦草稿（整个读改写在跨进程文件锁内完成，含去重与惰性周清）。
 * 摩擦日志目录不存在时随原子写自动建目录；文件不存在时先落两级骨架。
 */
export function appendFrictionDraft(
	home: string,
	entry: FrictionDraftEntry,
	options?: FrictionDraftOptions,
): Promise<void> {
	const run = writeQueue.then(() => appendOnce(home, entry, options));
	// 队列吞掉失败：后续追加不被前一次失败卡死
	writeQueue = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

/** 等待本进程内排队的草稿写入全部落盘（同步挂钩点的尾随写入靠它等齐；测试用，生产无须调用） */
export function drainFrictionDraftWrites(): Promise<void> {
	return writeQueue;
}

async function appendOnce(home: string, entry: FrictionDraftEntry, options?: FrictionDraftOptions): Promise<void> {
	const logPath = frictionLogPath(home);
	mkdirSync(dirname(logPath), { recursive: true });
	const now = (options?.时间 ?? (() => new Date()))();
	const timeText = formatTimestamp(now);
	const dir = entry.卡目录 ? resolve(entry.卡目录).replaceAll("\\", "/") : undefined;
	// 日志里存的是换正斜杠的键（冻结存储形状），只借 pathKey 折叠大小写，不改存储格式
	const cardDir = dir !== undefined ? pathKey(dir) : undefined;
	await withFileLock(logPath, () => {
		const content = existsSync(logPath) ? readFileSync(logPath, "utf8") : SKELETON;
		const lines = content.split(/\r?\n/);
		const key = `${cardDir ?? ""}|${entry.场景}|${entry.卡号}`;
		const kept: string[] = [];
		let deduped = false;
		for (const line of lines) {
			const parsed = parseDraftLine(line);
			if (!parsed) {
				kept.push(line); // 非机器格式行（标题、占位文字、人改过的行）原样保留
				continue;
			}
			// 周清：最后更新时间超过 7 天的草稿行直接丢弃
			const last = parseTimestamp(parsed.时间);
			if (last !== undefined && now.getTime() - last.getTime() > GC_AGE_MS) continue;
			// 去重：同卡同场景只累计次数、刷新时间戳（事实保留首次记录）
			if (!deduped && `${parsed.卡目录 ?? ""}|${parsed.场景}|${parsed.卡号}` === key) {
				deduped = true;
				kept.push(renderDraftLine(parsed.场景, parsed.卡号, parsed.事实, parsed.次数 + 1, timeText, cardDir));
				continue;
			}
			kept.push(line);
		}
		if (!deduped) {
			// 收掉文件尾空行；草稿区标题缺失则补（约定草稿区为最后一段）
			while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
			if (!kept.some((line) => /^##\s*草稿区\s*$/.test(line))) kept.push("", "## 草稿区");
			kept.push(renderDraftLine(entry.场景, entry.卡号, entry.事实, 1, timeText, cardDir));
		}
		writeFileAtomic(logPath, `${kept.join("\n")}\n`);
	});
}

export function formatTimestamp(date: Date): string {
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 事件挂钩入口（各事件落定处调用）：解析 PAO_HOME 并追加草稿，任何失败只警告不抛——
 * 草稿记不上不能影响主流程。PAO_HOME 未配置＝摩擦日志机制未启用，静默跳过（对齐
 * index.ts「配置缺失＝未用此功能」的口径，也避免无 pao 环境的测试刷警告）。
 *
 * 同步代码路径（如状态机）用 `void recordFrictionDraft(...)` 尾随调用，落盘时序由
 * 模块级写队列保证；测试等齐用 drainFrictionDraftWrites()。
 */
export async function recordFrictionDraft(
	scenario: FrictionScenario,
	cardNo: string,
	fact: string,
	cardDir?: string,
): Promise<void> {
	try {
		const home = process.env.PAO_HOME?.trim();
		if (!home) return;
		await appendFrictionDraft(home, { 场景: scenario, 卡号: cardNo, 事实: fact, 卡目录: cardDir });
	} catch (error) {
		logWarn(`[摩擦日志] 草稿记录失败（不影响主流程）:${error instanceof Error ? error.message : String(error)}`);
	}
}
