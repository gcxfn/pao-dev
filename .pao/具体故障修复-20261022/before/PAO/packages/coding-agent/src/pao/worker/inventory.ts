import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import * as path from "node:path";

import { setTimeout as delay } from "node:timers/promises";

import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { parseReceipts, type Receipt } from "../cards/index.ts";
import { gitSpawnErrorText } from "../shared/git.ts";

/**
 * 重启只读盘点(架构 §1 无常驻纪律 / R05):主会话异常重启后,先纯读盘点再由人决定
 * 重派或作废——绝不写文件、不清锁、不重跑。
 *
 * 盘点两件事:
 * 1. 扫任务工作区 卡/ 目录(含部门子队列),列未完卡(状态 unclaimed/in_progress:状态+尝试数+
 *    当前尝试有效回执+最近收到回执);
 * 2. 对开工基线的 git status 差异摘要(上轮 worker 可能已改了项目,续跑前先核现场)。
 */

export interface UnfinishedCard {
	/** 从文件名取(卡NNNN-目标简述.md) */
	卡号: string;
	文件: string;
	目标: string;
	/** 卡面当前状态;保持原有盘点字段名与取值。 */
	状态: string;
	/** 按 frontmatter 当前 attempt 找出的未归档回执结果;旧 attempt 与归档回执不替本轮作证。 */
	当前尝试回执结果: string;
	/** 正文里最近收到的回执结果;可能来自历史 attempt,不冒充当前尝试,也不拿卡状态冒充。 */
	最近收到回执结果: string;
	尝试: number;
	最后回执摘要: string;
}

/**
 * 已终结的卡(canceled/failed/delivered)。只报卡面事实,不读受理账:
 * 判不出「这条受理是被 dup 还是被停」(见 已知边界.md)。
 */
export interface SettledCard {
	/** 从文件名取(卡NNNN-目标简述.md) */
	卡号: string;
	文件: string;
	目标: string;
	/** 终态: canceled / failed / delivered */
	状态: string;
	/** 终结时间:卡面 completed 优先(delivered 才写),否则取最后一段 owner记录的时间;都没有则 undefined */
	终结时间?: string;
	/** 最后一段 owner记录的原因摘要(已截断),没有记录时为空串 */
	原因摘要: string;
	/** 用于排序的毫秒时间戳;解析不出时间则 0(排最后) */
	排序时间: number;
}

export interface GitStatusSummary {
	可用: boolean;
	分支?: string;
	head?: string;
	变更: { 状态: string; 文件: string }[];
	汇总: string;
	/** 不可用原因(非 git 仓库/git 不可用) */
	原因?: string;
}

export interface InventoryReport {
	工作区: string;
	项目根: string;
	未完卡: UnfinishedCard[];
	/** 最近终结的卡(最多 settledCardLimit 张,新的在前);空数组时输出侧不出现该分区 */
	已终结卡: SettledCard[];
	/** 有终态卡但超过上限未列出的张数;0 表示没截断 */
	已终结卡截断: number;
	git: GitStatusSummary;
	盘点时间: string;
}

export interface InventoryOptions {
	/** 任务工作区(内含 卡/ 目录) */
	工作区: string;
	/** 目标项目根;缺省 = 工作区的上两级(任务工作区约定为 <项目>/.pao/<任务名-YYYYMMDD>/) */
	项目根?: string;
}

export interface InventoryRenderOptions {
	/** 默认只给监督所需摘要；按需读取时保留完整目标与多行回执。 */
	full?: boolean;
}

// ── 卡片解析(frontmatter 复用 utils/frontmatter 的 YAML 真解析,与 cards/cardfile.ts 同口径;
//    目标等字段含 `:`/`#` 时不再被手写正则截断) ──

/** 取正文最后一段回执的 ≤3 行摘要(每次尝试追加一段,取最新) */
function lastReceiptSummary(body: string): string {
	const lines = body.split("\n");
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (/^\s*(#{1,6}\s*.*回执.*|回执[:：])/.test(lines[i])) start = i;
	}
	if (start === -1) return "(无回执)";
	const picked: string[] = [];
	for (let i = start + 1; i < lines.length && picked.length < 3; i++) {
		const line = lines[i].trim();
		if (!line) continue;
		if (/^#{1,6}\s/.test(line) && picked.length > 0) break;
		picked.push(line.length > 200 ? `${line.slice(0, 200)}…` : line);
	}
	return picked.length > 0 ? picked.join("\n") : "(无回执)";
}

function currentAttemptReceiptResult(receipts: readonly Receipt[], currentAttempt: number): string {
	const receipt = [...receipts]
		.reverse()
		.find((candidate) => candidate.attempt === currentAttempt && candidate.archive_flag === undefined);
	return receipt?.result ?? "无有效回执";
}

/** 最近收到的回执只看正文里最后一段规范回执;它可能来自历史 attempt,调用处必须如实标注。 */
function lastReceivedReceiptResult(receipts: readonly Receipt[]): string {
	return receipts.at(-1)?.result ?? "无回执";
}

const unfinishedStatus = new Set(["unclaimed", "in_progress"]);

/** 终态集合:落进这些状态的卡不再算"未完卡",但仍要在盘点上留一行痕迹。 */
const settledStatus = new Set(["canceled", "failed", "delivered"]);

/**
 * 终态卡分区默认只报最近 5 张。理由:
 * 1. 这个分区的用途是"我刚停的那张卡去哪了"——一次操作只涉及一两张,5 张足够覆盖近因;
 * 2. 盘点是监督面不是全量报表,条数无限增长会把真正的未完卡挤到看不见的地方;
 * 3. 需要全量时给的是真实可行的下一步(按文件路径自己翻),不是假装全量。
 */
const SETTLED_CARD_LIMIT = 5;

/** owner记录段单条原因摘要上限(字符);盘点是监督面,不朗读全文。 */
const SETTLED_REASON_MAX = 80;

/** 取正文里最后一段 `## owner记录 <时间>` 的时间与原因摘要(状态迁移时才写)。 */
function lastOwnerNote(body: string): { 时间?: string; 原因摘要: string } {
	const lines = body.split("\n");
	let start = -1;
	let 时间: string | undefined;
	for (let i = 0; i < lines.length; i++) {
		const m = /^##\s*owner记录\s*(.*)$/.exec(lines[i].trim());
		if (m) {
			start = i;
			时间 = m[1].trim() || undefined;
		}
	}
	if (start === -1) return { 原因摘要: "" };
	const picked: string[] = [];
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i].trim();
		if (/^#{1,6}\s/.test(line)) break;
		if (!line) continue;
		// 优先"依据"——人停止卡时写的就是理由;没有依据就退回其余条目
		const m = /^[-*]\s*依据[:：]\s*(.+)$/.exec(line);
		if (m) {
			picked.unshift(m[1].trim());
			continue;
		}
		if (/^[-*]\s*/.test(line)) picked.push(line.replace(/^[-*]\s*/, ""));
	}
	const text = picked.join("；");
	return { 时间, 原因摘要: text.length > SETTLED_REASON_MAX ? `${text.slice(0, SETTLED_REASON_MAX)}…` : text };
}

/** 把 `2026-10-17 11:43` / ISO 串解析成毫秒;解析不出返回 0(排序时垫底,不编造时间)。 */
function parseTime(value: string | undefined): number {
	if (!value) return 0;
	const normalized = value.includes("T") ? value : value.replace(" ", "T");
	const ms = Date.parse(normalized);
	return Number.isFinite(ms) ? ms : 0;
}

async function walkCards(dir: string, depth: number): Promise<string[]> {
	if (depth > 3) return [];
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await walkCards(full, depth + 1)));
		else if (entry.isFile() && entry.name.endsWith(".md")) files.push(full);
	}
	return files;
}

async function gitSummary(projectRoot: string): Promise<GitStatusSummary> {
	const run = (args: string[]): Promise<string> =>
		new Promise((resolve, reject) => {
			execFile(
				"git",
				args,
				{ cwd: projectRoot, windowsHide: true, maxBuffer: 1024 * 1024 },
				(error, stdout, stderr) => {
					if (error) reject(new Error(stderr || gitSpawnErrorText(error)));
					else resolve(stdout);
				},
			);
		});
	try {
		const porcelain = await run(["-c", "core.quotepath=off", "status", "--porcelain"]);
		const [branch, head] = await Promise.all([
			run(["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ""),
			run(["rev-parse", "--short", "HEAD"]).catch(() => ""),
		]);
		const change = porcelain
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => ({ 状态: line.slice(0, 2).trim(), 文件: line.slice(3).trim() }));
		const counts = new Map<string, number>();
		for (const c of change) counts.set(c.状态, (counts.get(c.状态) ?? 0) + 1);
		const totals =
			change.length === 0
				? "工作树干净(与基线无差异)"
				: `${change.length} 个文件有改动:${[...counts].map(([k, v]) => `${k} ${v}`).join("、")}`;
		return {
			可用: true,
			分支: branch.trim() || undefined,
			head: head.trim() || undefined,
			变更: change,
			汇总: totals,
		};
	} catch (error) {
		return { 可用: false, 变更: [], 汇总: "git 状态不可用", 原因: String((error as Error).message).slice(0, 300) };
	}
}

/** 只读盘点。对工作区与卡片文件零写入,不触碰项目写锁。 */
export async function inventory(options: InventoryOptions): Promise<InventoryReport> {
	const workspace = path.resolve(options.工作区);
	const projectRoot = path.resolve(options.项目根 ?? path.join(workspace, "..", ".."));
	const cardsDir = path.join(workspace, "卡");

	const unfinishedCard: UnfinishedCard[] = [];
	const settledAll: SettledCard[] = [];
	for (const file of await walkCards(cardsDir, 0)) {
		const text = await readFile(file, "utf8");
		const { frontmatter: fields, body } = parseFrontmatter<Record<string, unknown>>(text);
		const status = typeof fields.status === "string" ? fields.status : "";
		const name = path.basename(file, ".md");
		const cardNo = /^卡(\d+)/.exec(name)?.[1] ?? name;
		if (settledStatus.has(status)) {
			// 终态卡:只报卡面事实。终结时间取 completed(delivered 才写),否则取最后一段
			// owner记录的时间(人停卡/改失败时才写);两者都缺就不给时间,不用盘点时刻冒充。
			const owner = lastOwnerNote(body);
			const completed = typeof fields.completed === "string" && fields.completed ? fields.completed : undefined;
			const 终结时间 = completed ?? owner.时间;
			settledAll.push({
				卡号: cardNo,
				文件: file,
				目标: typeof fields.goal === "string" ? fields.goal : "",
				状态: status,
				终结时间,
				原因摘要: owner.原因摘要,
				排序时间: parseTime(终结时间),
			});
			continue;
		}
		if (!unfinishedStatus.has(status)) continue;
		const attempt = Number.parseInt(String(fields.attempt ?? "0"), 10) || 0;
		const receipts = parseReceipts(body, Number.parseInt(cardNo, 10) || 0);
		unfinishedCard.push({
			卡号: cardNo,
			文件: file,
			目标: typeof fields.goal === "string" ? fields.goal : "",
			状态: status,
			当前尝试回执结果: currentAttemptReceiptResult(receipts, attempt),
			最近收到回执结果: lastReceivedReceiptResult(receipts),
			尝试: attempt,
			最后回执摘要: lastReceiptSummary(body),
		});
	}

	// 新的在前;同一时间按卡号倒序(卡号越大越新)
	settledAll.sort((a, b) => b.排序时间 - a.排序时间 || b.卡号.localeCompare(a.卡号));
	const settledCard = settledAll.slice(0, SETTLED_CARD_LIMIT);

	const git = await gitSummary(projectRoot);
	return {
		工作区: workspace,
		项目根: projectRoot,
		未完卡: unfinishedCard,
		已终结卡: settledCard,
		已终结卡截断: Math.max(0, settledAll.length - settledCard.length),
		git,
		盘点时间: new Date().toISOString(),
	};
}

function oneLine(text: string, max = 120): string {
	const line =
		text
			.split(/\r?\n/)
			.map((value) => value.trim())
			.find(Boolean) ?? "";
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

/**
 * 盘点卡摘要渲染。数据仍来自 InventoryReport 与卡文件；默认压缩监督面，
 * full=true 才展开完整目标与最近回执。卡路径始终保留，供按需读取原卡。
 */
export function renderInventoryCards(
	report: Pick<InventoryReport, "未完卡" | "已终结卡" | "已终结卡截断">,
	options: InventoryRenderOptions = {},
): string {
	const full = options.full === true;
	const lines: string[] = [];
	if (report.未完卡.length === 0) {
		lines.push("- 未完卡:无");
	} else {
		lines.push(`- 未完卡 ${report.未完卡.length} 张:`);
		for (const card of report.未完卡) {
			const goal = full ? card.目标 : oneLine(card.目标);
			lines.push(
				`  · 卡${card.卡号}〔卡状态:${card.状态};当前尝试 ${card.尝试} 有效回执:${card.当前尝试回执结果};最近收到的回执:${card.最近收到回执结果}(可能来自历史尝试)〕:${goal}`,
			);
			if (full) {
				lines.push("    正文最后回执摘要(可能来自历史尝试):");
				for (const line of card.最后回执摘要.split("\n")) lines.push(`    ${line}`);
			} else {
				lines.push(`    最近回执摘要:${oneLine(card.最后回执摘要)}`);
			}
			lines.push(`    原卡:${card.文件}${full ? "" : "(需要完整目标和回执时按此路径读取)"}`);
		}
	}
	// 终态卡分区(E5 补「查回」闭环):没有终态卡就整段不输出——输出「终态卡:无」只让
	// 回执变长而信息为零。只报卡面事实,判不出「这条受理是被 dup 还是被停」(见 已知边界.md)。
	if (report.已终结卡.length > 0) {
		lines.push(`- 已终结卡 ${report.已终结卡.length} 张(最近在前;卡面事实,不查受理账):`);
		for (const card of report.已终结卡) {
			const when = card.终结时间 ? ` ${card.终结时间}` : "";
			const goal = full ? card.目标 : oneLine(card.目标);
			lines.push(`  · 卡${card.卡号}〔${card.状态}〕${when}:${goal}`);
			if (card.原因摘要) lines.push(`    原因:${card.原因摘要}`);
			lines.push(`    原卡:${card.文件}${full ? "" : "(需要完整内容时按此路径读取)"}`);
		}
		if (report.已终结卡截断 > 0) {
			lines.push(
				`  另有 ${report.已终结卡截断} 张已终结卡未列出(本轮只报最近 ${report.已终结卡.length} 张)。要看全量请直接列 卡 目录下的 .md 卡文件,按 frontmatter 的 status 过滤 canceled/failed/delivered。`,
			);
		}
	}
	return lines.join("\n");
}

/** 等待目录出现(测试辅助):最多等 timeoutMs */
export async function waitForFile(file: string, timeoutMs = 5000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			await stat(file);
			return true;
		} catch {
			await delay(50);
		}
	}
	return false;
}
