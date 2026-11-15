/**
 * 结卡四指标机械摘要（M2-09）：卡落终态（已交付/失败/取消）时往 PAO 编排区的四指标账
 * （`<卡目录上一级>/四指标账.txt`，标准布局即 `.pao/四指标账.txt`）机械追加一行：
 * `卡号\t目标\t终态\t总时长秒\t全角色合计成本\t介入次数`。
 *
 * 口径（对照实验依赖此账，需求 §6 四指标；机械可数，不造数）：
 * - 总时长秒＝frontmatter 创建时间（types.ts 的「创建」，YYYY-MM-DD HH:mm）→ 终态时刻
 *   （本次状态迁移时间）。解析不出按 0 记，负值（时钟回拨）按 0 收。
 * - 全角色合计成本＝该卡全部回执（含留档回执）的「用量」汇总。汇总口径复用
 *   worker/usage.ts 的 usageLineFromEventState＋汇总用量，不另立计数路径；
 *   卡面回执未记「缺用量轮次」，无法标 R07 的「未知」，按任务定案无用量回执计 0（不入行）。
 * - 介入次数 v1＝人工门确认次数＋打回次数＋分支裁决。分支裁决未落机制，不造数，v1 恒 0。
 *   打回次数＝卡上被判定为不合格的回执条数（appendReceipt 判为非「已记录」的留档回执，
 *   即带 留档标记 的条数，见 ReceiptOutcome）。人工门确认次数＝工作流实例清单里指向本卡
 *   且已点头的节点条数（卡不在任何工作流为 0）。**不含用户自由插话**——账文件首行写死
 *   口径注释（appendMetricsLine 建文件时落，追加行不重复写）。
 *
 * 结构：buildMetricsLine / sumReceiptCost / countRejections / metricsDurationSeconds /
 * countGateConfirms 为纯函数（countGateConfirms 只读清单文件）；appendMetricsLine 是唯一
 * 写盘点（薄 IO，原子写复用 writeFileAtomic），路径推导独立成 metricsLedgerPath，测试打纯函数。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { writeFileAtomic } from "../shared/atomic.ts";
import { parseWorkflowMarker } from "../shared/marker.ts";
import { totalsUsage, usageLineFromEventState, type WorkerUsage } from "../shared/usage.ts";
import { formatCardNumber } from "./counter.ts";
import type { CardStatus, ParsedCard, Receipt } from "./types.ts";

/** 账文件首行口径注释（建文件时写死一次；追加行不重复写）。 */
export const METRICS_LEDGER_HEADER = "# 四指标账：介入次数=人工门+打回+分支裁决，不含用户自由插话";

/** 账文件名（落 PAO 编排区，与认领基线快照的 基线/ 同层）。 */
export const METRICS_LEDGER_FILE_NAME = "四指标账.txt";

/**
 * 账路径推导：卡目录上一级＝任务工作区/编排区（在 `<项目>/.pao/卡` 布局下即项目 `.pao/`，
 * 与认领基线快照落 `<卡目录>/../基线/` 同源同层）。账是 pao 自己的状态文件，必须落在
 * .pao 编排区内——§14/§13 的差分检测面排除 .pao（baseline.ts 排除路径），账行不会被
 * 误算进 worker 产物或卷进交卷提交。自定布局的调用方用 appendMetricsLine 显式传路径覆盖。
 */
export function metricsLedgerPath(cardsDir: string): string {
	return join(resolve(dirname(cardsDir)), METRICS_LEDGER_FILE_NAME);
}

// ── 纯函数：三个指标槽位 ─────────────────────────────────────────────────

/** "YYYY-MM-DD HH:mm" → 本地时区毫秒；解析不出返回 undefined。 */
function parseCardTime(text: string): number | undefined {
	const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(text.trim());
	if (!match) return undefined;
	const [, y, m, d, h, min] = match;
	return new Date(Number(y), Number(m) - 1, Number(d), Number(h), Number(min)).getTime();
}

/** 总时长秒：创建 → 终态时刻。任一端解析不出按 0 记；负值（时钟回拨）按 0 收，不造负数。 */
export function metricsDurationSeconds(created: string, finalStateAt: string): number {
	const start = parseCardTime(created);
	const end = parseCardTime(finalStateAt);
	if (start === undefined || end === undefined) return 0;
	return Math.max(0, Math.round((end - start) / 1000));
}

/** 回执「用量」→ WorkerUsage：只认非负有限数，缺/坏字段计 0（卡面用量是自由 Record，不猜单位）。 */
function toWorkerUsage(raw: Record<string, unknown>): WorkerUsage {
	const num = (value: unknown): number =>
		typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
	return {
		input: num(raw.input),
		output: num(raw.output),
		cacheRead: num(raw.cacheRead),
		cacheWrite: num(raw.cacheWrite),
		cost: num(raw.cost),
		turns: num(raw.turns),
	};
}

/**
 * 全角色合计成本：全部回执（含留档）的「用量」逐行过 usageLineFromEventState（卡面未记
 * 缺用量轮次，按事件流口径入行）后走 汇总用量 聚合——复用 §15 的口径，不重算。
 * 无用量回执计 0（不入行）；用量不是对象的回执（解析退化成字符串等）同样计 0。
 * 返回值只做显示级取整（6 位小数，去浮点尾），聚合本身不动。
 */
export function sumReceiptCost(cardNo: number, receipts: readonly Receipt[]): number {
	const ref = formatCardNumber(cardNo);
	const lines = receipts
		.filter(
			(receipt): receipt is Receipt & { usage: Record<string, unknown> } =>
				typeof receipt.usage === "object" && receipt.usage !== null && !Array.isArray(receipt.usage),
		)
		.map((receipt) =>
			usageLineFromEventState(ref, receipt.attempt, {
				用量: toWorkerUsage(receipt.usage),
				缺用量轮次: 0,
			}),
		);
	const cost = totalsUsage(ref, lines).用量.cost;
	return Math.round(cost * 1e6) / 1e6;
}

/** 打回次数：卡上判定为不合格的回执条数＝带 留档标记（旧尝试留档/迟到回执）的条数。 */
export function countRejections(receipts: readonly Receipt[]): number {
	return receipts.filter((receipt) => receipt.archive_flag !== undefined).length;
}

// ── 人工门确认次数（只读工作流实例清单） ───────────────────────────────

/**
 * 卡正文的流归属标记（§11）：正本在 shared/marker.ts（driver 生成/解析同源，本文件只读
 * 解析，不回写；此前因 cards 反向 import driver 成环而在此按冻结格式重述正则）。
 */

/**
 * 人工门确认次数（机械可数）：卡正文 pao-workflow 标记 → 卡目录上一级的工作流实例清单
 * `工作流实例-<流名>.md`（driver.manifestPath 缺省布局）→ 数「卡号指向本卡且 确认 已点头」
 * 的节点条数。卡不在任何工作流、清单缺失或解析失败一律 0（不造数）；清单结构见
 * workflow/driver.ts 的 WorkflowManifest（只读，不改清单）。
 */
export function countGateConfirms(card: ParsedCard): number {
	const marker = parseWorkflowMarker(card.body);
	if (!marker) return 0; // 卡不在任何工作流：人工门计 0
	const manifestPath = join(dirname(card.path), "..", `工作流实例-${marker.流}.md`);
	if (!existsSync(manifestPath)) return 0; // 清单缺失（可从卡重建的场景）：不猜，计 0
	try {
		const { frontmatter } = parseFrontmatter<Record<string, unknown>>(readFileSync(manifestPath, "utf8"));
		const nodes = Array.isArray(frontmatter.节点) ? frontmatter.节点 : [];
		const ref = formatCardNumber(card.card_no);
		let count = 0;
		for (const raw of nodes) {
			if (typeof raw !== "object" || raw === null) continue;
			const entry = raw as Record<string, unknown>;
			if (typeof entry.卡号 === "string" && entry.卡号.trim() === ref) {
				const confirm = entry.确认;
				if (confirm !== undefined && String(confirm).trim().length > 0) count++;
			}
		}
		return count;
	} catch {
		return 0; // 清单坏：不造数
	}
}

// ── 账行拼装与薄 IO ─────────────────────────────────────────────────────

export interface MetricsInput {
	/** 结卡对象：目标/卡号/创建时间取自 frontmatter */
	card: ParsedCard;
	/** 卡上全部回执（含留档回执；用量与打回都从这份数据出） */
	receipts: readonly Receipt[];
	/** 终态：已交付/失败/取消（失败可重试，但每次落入都结一行账——账是流水，不是状态） */
	终态: CardStatus;
	/** 终态时刻（本次状态迁移时间，YYYY-MM-DD HH:mm） */
	终态时刻: string;
	/** 人工门确认次数（IO 侧经 countGateConfirms 数出；卡不在任何工作流为 0） */
	人工门确认次数: number;
}

/**
 * 结卡账行（纯函数）：`卡号\t目标\t终态\t总时长秒\t全角色合计成本\t介入次数`。
 * 介入次数＝人工门确认次数＋打回次数＋分支裁决；**分支裁决未落机制，不造数，v1 恒 0**。
 * 目标里的换行/Tab 压成空格——账一行一卡，Tab 是字段分隔符。
 */
export function buildMetricsLine(input: MetricsInput): string {
	const totalSeconds = metricsDurationSeconds(input.card.frontmatter.created, input.终态时刻);
	const totalCost = sumReceiptCost(input.card.card_no, input.receipts);
	const rejectCount = countRejections(input.receipts);
	const branchRulingCount = 0; // 分支裁决未落机制，不造数（v1 定案；落机制后在此接入机械计数）
	const interventionCount = input.人工门确认次数 + rejectCount + branchRulingCount;
	const goal = input.card.frontmatter.goal
		.replace(/\s*\r?\n\s*/g, " ")
		.replace(/\t/g, " ")
		.trim();
	return [
		formatCardNumber(input.card.card_no),
		goal,
		input.终态,
		String(totalSeconds),
		String(totalCost),
		String(interventionCount),
	].join("\t");
}

/**
 * 追加一行账（薄 IO，唯一写盘点）：文件不存在（或空）先落首行口径注释再落数据行；
 * 已存在只追加数据行，不重复写注释。账是纯追加日志（一行一事件）——常规路径用
 * appendFileSync 单行追加，不再「读整个账本＋整体原子重写」（账变大后每次结卡都全量 IO）；
 * 只有建文件（首行注释＋首行数据）走 writeFileAtomic 整体写。格式与旧版逐字节兼容：
 * 机器写路径恒 \n 结尾；人工编辑产生无尾换行时新追加行会与末行粘连（契约外）。
 * 跨进程并发追加比旧读改写更安全——
 * O_APPEND 单行写不再有「两个进程读到同一底本、各写各的、丢一行」的窗口。
 */
export function appendMetricsLine(ledgerPath: string, line: string): void {
	mkdirSync(dirname(ledgerPath), { recursive: true });
	let size = 0;
	try {
		size = statSync(ledgerPath).size;
	} catch {
		// 文件不存在：走建文件路径
	}
	if (size > 0) {
		appendFileSync(ledgerPath, `${line}\n`);
		return;
	}
	writeFileAtomic(ledgerPath, `${METRICS_LEDGER_HEADER}\n${line}\n`);
}
