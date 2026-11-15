import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { writeFileAtomic } from "../shared/atomic.ts";
import { projectRootForCards, serializeCard, serializeReceipt } from "./cardfile.ts";
import { PaoCardError } from "./errors.ts";
import { type ParsedCard, type Receipt, TERMINAL_TASK_STATES } from "./types.ts";

/** worker 交回执内部入参（工具层转译自 schema 参数；字段名非机器协议，S9 不随迁）。 */
export interface AppendReceiptInput {
	/** worker 交回执必带卡号+尝试号（架构 §2）。 */
	尝试号: number;
	时间: string;
	结果?: string;
	摘要?: string;
	产物路径?: string[];
	证据?: string[];
	用量?: Record<string, unknown>;
	值得沉淀?: string;
	失败类型?: Receipt["failure_type"];
	/** F-A7 自报任务态（S5 包1）；旧链路不填。 */
	任务态?: Receipt["任务态"];
	verification?: Receipt["verification"];
	changes?: Receipt["changes"];
}

export type ReceiptOutcome =
	| { kind: "已记录"; 待审: boolean }
	| { kind: "旧尝试留档" }
	| { kind: "迟到回执留档" }
	| { kind: "重复终结留档" };

/**
 * 回执内容三格校验（M2-09 回执校验加强，增量非新建；必填七字段在 worker/receipt.ts 的
 * validateReceipt，不在本通道重复）。拒收＝现有校验同款 PaoCardError 通道，让 worker 重写，
 * 不静默截断——垃圾回执不许落卡，免得在 §14 越界比对／§15 用量聚合／终止门禁各炸一次：
 * 1. 产物路径真实存在（existsSync）：仅当声明了产物路径时查——回答型任务无文件产物合法，
 *    不因无产物拒收；相对路径与 worker cwd 一致，以项目根为基准解析，绝对路径原样查。
 *    留档回执（旧尝试/迟到）同样过这道门：§14/§15 消费的是卡上全部回执，留档垃圾一样污染。
 * 2. 摘要 ≤3 行（按换行计，超行拒收）。
 * 3. 尝试号与卡面连续：既有校验已覆盖，此处不重复实现——尝试号 > 卡面当前尝试已在
 *    appendReceipt 报 INVALID_RECEIPT；< 当前尝试按模板 §2 走旧尝试留档（不推进状态）；
 *    只有等于卡面当前尝试的回执能以「已记录」落卡并派生待审。
 */
export function validateReceiptContent(card: ParsedCard, input: AppendReceiptInput): void {
	const artifact = input.产物路径;
	if (artifact !== undefined && artifact.length > 0) {
		const root = projectRootForCards(dirname(card.path));
		const missing = artifact.filter((p) => {
			const target = p.trim();
			if (target.length === 0) return true; // 空条目＝没写出产物，与不存在同罪
			return !existsSync(isAbsolute(target) ? target : join(root, target));
		});
		if (missing.length > 0) {
			throw new PaoCardError(
				"INVALID_RECEIPT",
				`回执产物路径不存在：${missing.join("、")}（相对路径以卡所在工作区 ${root} 为基准；回答型任务可不报产物，报了必须真实存在，请核实后重交）`,
				{ card_no: card.card_no, 尝试号: input.尝试号, 缺失产物: missing, 基准目录: root },
			);
		}
	}
	if (input.摘要 !== undefined) {
		const lineCount = input.摘要.split("\n").length;
		if (lineCount > 3) {
			throw new PaoCardError("INVALID_RECEIPT", `回执摘要超过 3 行（实为 ${lineCount} 行），压到 3 行以内再重交`, {
				card_no: card.card_no,
				尝试号: input.尝试号,
				行数: lineCount,
			});
		}
	}
}

/**
 * worker 交回执（单写者协议：worker 只追加，不改状态、不改信封字段）。
 * 处理规则（模板 §2 / 验收条目 5、6）：
 * - 尝试号 == 当前尝试号 且卡未终态：追加回执；状态不变（进行中仍进行中，派生“待审”）；
 * - 尝试号 <  当前尝试号：旧尝试回执，追加留档但不推进状态、不触发重试；
 * - 尝试号 >  当前尝试号：结构化错误（超前尝试不存在）；
 * - 卡已终态（已交付/取消）：迟到回执，追加留档，不再变状态。
 * 追加为原子写。
 * 内容三格校验（M2-09）：产物路径存在（声明了才查）、摘要 ≤3 行，见 validateReceiptContent；
 * 拒收走 PaoCardError，卡文件不动，worker 重写后再交。
 */
export function appendReceipt(card: ParsedCard, input: AppendReceiptInput): ReceiptOutcome {
	if (!Number.isInteger(input.尝试号) || input.尝试号 <= 0) {
		throw new PaoCardError("INVALID_RECEIPT", `回执尝试号必须是正整数：${String(input.尝试号)}`, {
			card_no: card.card_no,
			尝试号: input.尝试号,
		});
	}
	// 回执标题行按协议格式解析（cardfile 的 RECEIPT_HEADING_PATTERN 只认「YYYY-MM-DD HH:mm」）。
	// 传 ISO 之类别的时刻时，写下去的回执再也读不回来（等于静默丢回执），所以这里当场拒收。
	if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(input.时间 ?? "")) {
		throw new PaoCardError(
			"INVALID_RECEIPT",
			`回执时间必须是本地时刻「YYYY-MM-DD HH:mm」（协议格式）：${String(input.时间)}`,
			{ card_no: card.card_no, 时间: input.时间 },
		);
	}
	const currentAttempt = card.frontmatter.attempt;
	const terminal = card.frontmatter.status === "delivered" || card.frontmatter.status === "canceled";
	let marker: Receipt["archive_flag"];
	if (input.尝试号 > currentAttempt) {
		throw new PaoCardError("INVALID_RECEIPT", `回执尝试号 ${input.尝试号} 超前于当前尝试 ${currentAttempt}`, {
			card_no: card.card_no,
			当前尝试: currentAttempt,
		});
	}
	if (terminal) {
		marker = "late_receipt";
	} else if (input.尝试号 < currentAttempt) {
		marker = "old_attempt";
	}
	// 有效尝试的终结结果仅接纳一次（S5/F-A7）：当前尝试已接纳终结自报（completed/
	// completed_with_deviations/blocked）后，后续同尝试自报回执一律「重复终结留档」
	// （迟到 checkpoint 同罪——尝试已终结，不再有检查点）。旧链路（无任务态）不受影响。
	// 留档值「重复终结留档」定名表未覆盖（S9-迁移包待决策移交），保留原值。
	if (
		marker === undefined &&
		input.任务态 !== undefined &&
		card.receipts.some(
			(r) =>
				r.attempt === currentAttempt &&
				!r.archive_flag &&
				r.任务态 !== undefined &&
				// readonly 字面量元组的 includes 窄签名收不下全量 TaskState，按 string 集合比对
				(TERMINAL_TASK_STATES as readonly string[]).includes(r.任务态),
		)
	) {
		marker = "重复终结留档";
	}
	validateReceiptContent(card, input);
	const receipt: Receipt = {
		card_no: card.card_no,
		attempt: input.尝试号,
		time: input.时间,
		result: input.结果,
		summary: input.摘要,
		artifact_path: input.产物路径,
		evidence: input.证据,
		usage: input.用量,
		worth_distilling: input.值得沉淀,
		failure_type: input.失败类型,
		任务态: input.任务态,
		verification: input.verification,
		changes: input.changes,
		archive_flag: marker,
	};
	const body =
		card.body.trim().length > 0
			? `${card.body.trimEnd()}\n\n${serializeReceipt(receipt)}\n`
			: `${serializeReceipt(receipt)}\n`;
	writeFileAtomic(card.path, serializeCard(card.frontmatter, body));
	// 同步内存对象:同一卡对象连续多次 appendReceipt 时基于最新正文追加,
	// 不把上一份回执覆盖掉(生产路径每次重读卡,此处防御库调用方复用对象)
	card.body = body;
	card.receipts.push(receipt);
	if (marker === "old_attempt") return { kind: "旧尝试留档" };
	if (marker === "late_receipt") return { kind: "迟到回执留档" };
	if (marker === "重复终结留档") return { kind: "重复终结留档" };
	return { kind: "已记录", 待审: card.frontmatter.status === "in_progress" };
}

/** 派生状态：进行中且当前尝试的回执已交 = 待审（模板 §2：worker 交回执只是待审）。 */
export function isPendingReview(card: ParsedCard): boolean {
	const fm = card.frontmatter;
	if (fm.status !== "in_progress") return false;
	return card.receipts.some((receipt) => receipt.attempt === fm.attempt && !receipt.archive_flag);
}
