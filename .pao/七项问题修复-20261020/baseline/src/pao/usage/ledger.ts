/**
 * 跨会话用量账本（§15/M2-04 尾）：$PAO_HOME/用量账.jsonl 纯追加，每行一个会话结账记录。
 *
 * - 落盘点＝session_shutdown（正常退出一次一行）；会话中途崩溃＝该会话缺账，
 *   不补记不伪造（如实缺账——与 R05/R07 同一诚实口径）。
 * - R07 口径延续：缺 usage 的会话行如实带「缺用量轮次」，聚合时明示「已知下界」，不填零。
 * - 每轮 footer 仍是会话内账（usage-display.ts，行为不变）；本账只服务跨会话聚合
 *   （/状态 用量区）。footer 每轮读盘是 IO 浪费——砍。
 * - 全角色对账（M2-04 交付原文）：行带「角色」字段，主控/部长/worker 会话都落账。
 * - 本模块零反向依赖（不 import usage-display）：buildLedgerRow 用结构化参数收 state，
 *   格式化工具自带，避免 usage-display→ledger 的环。
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** 账本文件名（相对 PAO_HOME） */
export const USAGE_LEDGER_FILENAME = "用量账.jsonl";

/** 一行＝一个会话的结账记录（字段名与 UsageFooterState.累计 对齐＋会话元信息） */
export interface UsageLedgerRow {
	会话开始: string;
	会话结束: string;
	角色: string;
	input: number;
	output: number;
	cacheRead: number;
	cost: number;
	turns: number;
	缺用量轮次: number;
}

/** buildLedgerRow 收的结构（UsageFooterState 结构兼容，鸭子类型零 import） */
export interface LedgerTotals {
	累计: { input: number; output: number; cacheRead: number; cost: number; turns: number };
	缺用量轮次: number;
}

export function buildLedgerRow(
	state: LedgerTotals,
	role: string,
	sessionStart: string,
	now: Date = new Date(),
): UsageLedgerRow {
	return {
		会话开始: sessionStart,
		会话结束: now.toISOString(),
		角色: role,
		input: state.累计.input,
		output: state.累计.output,
		cacheRead: state.累计.cacheRead,
		cost: state.累计.cost,
		turns: state.累计.turns,
		缺用量轮次: state.缺用量轮次,
	};
}

export function renderLedgerRow(row: UsageLedgerRow): string {
	return JSON.stringify(row);
}

export interface ParsedLedger {
	rows: UsageLedgerRow[];
	/** 非 JSON 或字段形状不对的行数（跳过不吞——聚合文本如实报） */
	坏行数: number;
}

/** 逐行解析：空行跳过；JSON.parse 失败或字段形状不对（数字/字符串字段缺一）算坏行。 */
export function parseLedger(text: string): ParsedLedger {
	const rows: UsageLedgerRow[] = [];
	let badLineCount = 0;
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const obj: unknown = JSON.parse(trimmed);
			if (isLedgerRow(obj)) rows.push(obj);
			else badLineCount++;
		} catch {
			badLineCount++;
		}
	}
	return { rows, 坏行数: badLineCount };
}

function isLedgerRow(value: unknown): value is UsageLedgerRow {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.会话开始 === "string" &&
		typeof v.会话结束 === "string" &&
		typeof v.角色 === "string" &&
		typeof v.input === "number" &&
		typeof v.output === "number" &&
		typeof v.cacheRead === "number" &&
		typeof v.cost === "number" &&
		typeof v.turns === "number" &&
		typeof v.缺用量轮次 === "number"
	);
}

export interface LedgerAggregate {
	会话数: number;
	/** 按角色分组的会话数（迭代序＝首现序；渲染时按固定序重排） */
	按角色: Record<string, number>;
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cost: number;
	/** 含缺 usage 轮的会话数（R07：这些会话的数字是下界） */
	缺账会话数: number;
}

export function aggregateLedger(rows: readonly UsageLedgerRow[]): LedgerAggregate {
	const agg: LedgerAggregate = {
		会话数: rows.length,
		按角色: {},
		turns: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cost: 0,
		缺账会话数: 0,
	};
	for (const row of rows) {
		agg.按角色[row.角色] = (agg.按角色[row.角色] ?? 0) + 1;
		agg.turns += row.turns;
		agg.input += row.input;
		agg.output += row.output;
		agg.cacheRead += row.cacheRead;
		agg.cost += row.cost;
		if (row.缺用量轮次 > 0) agg.缺账会话数++;
	}
	return agg;
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function formatCost(n: number): string {
	if (n === 0) return "$0";
	if (n < 0.01) return `$${n.toFixed(4)}`;
	return `$${n.toFixed(2)}`;
}

/** 角色展示固定序（主控→部长→worker→其余按首现） */
const ROLE_ORDER = ["主控", "部长", "worker"];

/** /状态 用量区正文：零会话＝如实空态（不冒充零用量）；缺账/坏行如实标注。 */
export function formatLedgerSummary(agg: LedgerAggregate, badLineCount = 0): string {
	if (agg.会话数 === 0) {
		const badLineNote = badLineCount > 0 ? `\n${badLineCount} 行坏行已跳过` : "";
		return `── 用量区（跨会话累计 · ${USAGE_LEDGER_FILENAME}）──\n尚无跨会话账（首次会话正常退出后产生；中途崩溃的会话如实缺账不补记）${badLineNote}`;
	}
	const roleOrder = [
		...ROLE_ORDER.filter((r) => agg.按角色[r]),
		...Object.keys(agg.按角色).filter((r) => !ROLE_ORDER.includes(r)),
	];
	const roles = roleOrder.map((r) => `${r} ${agg.按角色[r]}`).join(" · ");
	const lines = [
		`── 用量区（跨会话累计 · ${USAGE_LEDGER_FILENAME}）──`,
		`会话 ${agg.会话数}（${roles}）· 轮次 ${agg.turns} · ↑${formatTokens(agg.input)} ↓${formatTokens(agg.output)} · ${formatCost(agg.cost)}`,
	];
	if (agg.缺账会话数 > 0) lines.push(`${agg.缺账会话数} 会话未回 usage——累计为已知下界`);
	if (badLineCount > 0) lines.push(`${badLineCount} 行坏行已跳过`);
	return lines.join("\n");
}

// ── 薄 IO（纯函数之上最小封装；测试经临时目录走真文件） ─────────────────────

export function usageLedgerPath(paoHome: string): string {
	return join(paoHome, USAGE_LEDGER_FILENAME);
}

/** 追加一行（目录缺失先建；失败由调用方处理——落账失败如实缺账不炸退出流程） */
export function appendLedgerRow(paoHome: string, row: UsageLedgerRow): void {
	const path = usageLedgerPath(paoHome);
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${renderLedgerRow(row)}\n`, "utf8");
}

/** 读账本全文；文件不存在＝空串（尚未开账，不是错误） */
export function readLedgerText(paoHome: string): string {
	try {
		return readFileSync(usageLedgerPath(paoHome), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}
