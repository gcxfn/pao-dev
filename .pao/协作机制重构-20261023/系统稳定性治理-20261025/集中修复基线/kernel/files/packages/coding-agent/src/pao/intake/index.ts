/**
 * 完整任务受理（intake）模块对外出口。
 *
 * 唯一业务入口是 `acceptIntake`；下面三个 `acceptIntakeXxx` 只是**参数适配**，
 * 不写第二、第三份逻辑（架构原则 5：终端、桌面、单任务、批量共用业务入口和数据契约）。
 *
 * 旧入口与新入口的关系（不改旧工具行为与工具名——兼容契约）：
 * | 旧入口 | 新入口对应的步 |
 * |---|---|
 * | `pao_build_card` | 建卡步（同一个 createCard / 同一个发号器） |
 * | `pao_dispatch_card` | 派发步（同一个 executeDispatch 后台链） |
 * | `pao_inventory` | 查询（不受理；受理只回身份，不另做查询实现） |
 */
import type { PreflightItem } from "../preflight/index.ts";
import { acceptIntake } from "./accept.ts";
import type { IntakeOptions, IntakeOutcome, IntakeReport, IntakeRequest } from "./types.ts";

export { acceptIntake, isIntakeOutcomeStale } from "./accept.ts";
export {
	commitIntakeEntry,
	dropIntakeKey,
	findIntakeLedgerEntry,
	INTAKE_LEDGER_RELATIVE_PATH,
	IntakeLedgerError,
	intakeLedgerPath,
	readIntakeLedger,
	reserveIntakeKey,
	updateIntakeEntry,
	writeIntakeLedger,
} from "./ledger.ts";
export type { LegacyTaskFields, TaskBook, TaskFields } from "./task-book.ts";
export {
	legacyTaskFields,
	mergeConstraints,
	normalizeTaskBook,
	renderTaskBook,
	TaskBookSchema,
	taskBookConstraints,
	taskBookFields,
} from "./task-book.ts";
export type {
	IntakeCounts,
	IntakeDispatchHook,
	IntakeLedgerEntry,
	IntakeLedgerFile,
	IntakeLedgerHit,
	IntakeOptions,
	IntakeOutcome,
	IntakeReport,
	IntakeRequest,
	IntakeStatus,
	IntakeTemplateBody,
} from "./types.ts";

/** 一条「请求 + 宿主自报身份」的入参（桌面/终端的会话上下文里才有这些东西）。 */
export interface IntakeEntryRequest extends IntakeRequest {}

/** 终端入口参数。 */
export interface IntakeCliInput {
	/** 卡目录（终端在项目里跑，缺省 `.pao/卡` 之类由调用方给出）。 */
	cardsDir: string;
	/** 一条命令一行任务；批量受理用数组。 */
	requests: readonly IntakeEntryRequest[];
	/** 宿主装配（PAO_HOME、派发通道等）。 */
	options: IntakeOptions;
}

/** 桌面入口参数：除卡目录外，多一个内核会话上下文（只用于回填真实身份，不参与受理判断）。 */
export interface IntakeDesktopInput {
	cardsDir: string;
	requests: readonly IntakeEntryRequest[];
	options: IntakeOptions;
	/** 宿主会话 id（随派发注入，用于工作流 owner 重核）；缺省＝不带。 */
	sessionId?: string;
}

/** 批量入口参数。 */
export interface IntakeBatchInput {
	cardsDir: string;
	requests: readonly IntakeEntryRequest[];
	options: IntakeOptions;
}

/**
 * 终端入口：一行命令 → 一条请求。只做参数搬运。
 * 缺 PAO_HOME 等装配问题不在适配层判断——统一由 acceptIntake 如实拒绝（同一出口一个真相）。
 */
export async function acceptIntakeCli(input: IntakeCliInput): Promise<IntakeReport> {
	return acceptIntake(input.cardsDir, input.requests, input.options);
}

/** 桌面入口：同上，sessionId 有值时才覆盖 ownerSession（不传就不改 options）。 */
export async function acceptIntakeDesktop(input: IntakeDesktopInput): Promise<IntakeReport> {
	const options: IntakeOptions =
		input.sessionId !== undefined && input.sessionId.trim().length > 0
			? { ...input.options, ownerSession: input.sessionId }
			: input.options;
	return acceptIntake(input.cardsDir, input.requests, options);
}

/** 批量入口：多条请求一次受理；`partial` 字段告诉调用方是否部分成功。 */
export async function acceptIntakeBatch(input: IntakeBatchInput): Promise<IntakeReport> {
	return acceptIntake(input.cardsDir, input.requests, input.options);
}

/** 把受理结果渲染成一行摘要（终端/桌面共用同一文案源；只读 report，不改判断）。 */
export function summarizeIntakeReport(report: IntakeReport): string {
	const { counts } = report;
	const parts = [
		`受理 ${counts.accepted} 条`,
		counts.duplicate > 0 ? `重复 ${counts.duplicate} 条` : "",
		counts.deferred > 0 ? `推迟 ${counts.deferred} 条` : "",
		counts.rejected > 0 ? `未受理 ${counts.rejected} 条` : "",
	].filter((part) => part.length > 0);
	const head = parts.join("、");
	return report.partial ? `部分受理：${head}` : head;
}

/** 单条结果的展示文案（问题项逐条列出，不吞问题）。 */
export function describeIntakeOutcome(outcome: IntakeOutcome): string {
	const identity =
		outcome.cardNo !== undefined
			? `卡${outcome.cardNo}${outcome.attempt !== undefined ? `（尝试 ${outcome.attempt}）` : "（待认领）"}`
			: "未建卡";
	const reason = outcome.reason !== undefined ? `：${outcome.reason}` : "";
	const problems: PreflightItem[] = outcome.problems;
	const riskText =
		problems.length > 0 ? `；另有 ${problems.length} 项提示（${problems.map((item) => item.level).join("、")}）` : "";
	return `${statusLabel(outcome) || ""}${identity}${reason}${riskText}`;
}

function statusLabel(outcome: IntakeOutcome): string {
	switch (outcome.status) {
		case "accepted":
			return "已受理 ";
		case "duplicate":
			return "重复提交（首次已受理）";
		case "deferred":
			return "已受理未派发 ";
		case "rejected":
			return "未受理 ";
	}
}
