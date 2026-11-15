/**
 * 扇出执行(卡0007):把一批卡并行派给一次性 worker。
 * - 拉起全部经 WorkerRunner.run(进程全部进登记册),本模块零自建进程管理代码;
 * - 回执逐卡经 appendReceipt 落卡(卡号+尝试号,不混批);
 * - 认领(R14/架构 §14)与工具层 pao_change_status 走同一快照入口 snapshotClaimBaseline,交回执比对有基线;
 *   单卡链路(校验→认领＋基线快照→构建 runOptions→拉起→登记)已提取为 worker 模块
 *   dispatch-core 共享核心,本模块与 pao_dispatch_card 同源调用(依赖方向 fanout→worker 单向);
 * - 交回执时 §14 越界核查:git 真值(当前 status 减认领基线)比对回执声明产物,虚报/越界结构化亮出;
 * - 并发上限约束调度名额；同一执行根仍由长锁互斥，独立执行根可并行；超限排队不丢弃;
 * - 停止契约 R05:先阻新调用(补位车道停拉)→ cancel 在跑进程并等真退出 → 才返回;
 *   cancel/stopAll 全部复用 runner,本模块不杀进程。
 */
import { type BoundaryWriteCheck, checkBoundaryWrite } from "../cards/baseline.ts";
import {
	changeCardStatus,
	diffAgainstBaseline,
	type FailureRouting,
	type ParsedCard,
	type ReceiptOutcome,
	readCard,
	routeFailure,
} from "../cards/index.ts";
import { recordFrictionDraft } from "../friction/drafts.ts";
import { logWarn } from "../shared/log.ts";
import { nowString } from "../shared/time.ts";
import { buildDispatchBudgetGate } from "../usage/dispatch-gate.ts";
import {
	appendDispatchReceipt,
	classifyWorkerFailure,
	type DispatchBaseline,
	executeDispatch,
	FANOUT_OPERATOR,
	locateDispatchCard,
	projectRootForCards,
	taskStateRoutingLine,
} from "../worker/dispatch-core.ts";
import { PaoWorkerError } from "../worker/errors.ts";
import {
	defaultWorkerRunner,
	type WorkerReceipt,
	type WorkerRunner,
	type WorkerRunOptions,
	type WorkerStatus,
} from "../worker/index.ts";
import { resolveWorkerSupervisionRoute } from "../worker/supervision.ts";
import { resolveWorkflowDispatch } from "../workflow/dispatch-context.ts";
import { createSingleRootWorktreeHost, type PaoWorktreeHost, type WorktreeTarget } from "../worktrees/types.ts";
import { type FanoutBatchPlan, planFanout } from "./plan.ts";

/** 扇出以主控身份做 owner 侧动作(认领/重开);共享核心 claimCardForDispatch 的操作者 */
const OPERATOR = FANOUT_OPERATOR;

/** 单卡终态:runner 四态映射 + 未拉起(卡状态不允许或定位失败,进程从未启动) */
export type FanoutFinalState = "成功" | "失败" | "结果未知" | "取消" | "未拉起";

const FINAL_STATE_BY_STATUS: Record<WorkerStatus, FanoutFinalState> = {
	success: "成功",
	failed: "失败",
	unknown: "结果未知",
	canceled: "取消",
};

export interface FanoutCardResult {
	卡号: string;
	终态: FanoutFinalState;
	/** 落卡回执的尝试号(= 认领后的卡面尝试);未拉起时缺省 */
	attempt?: number;
	/** worker 回执摘要(≤3 行) */
	摘要?: string;
	失败类型?: ReturnType<typeof classifyWorkerFailure>;
	/** 失败按四型的路由建议(与 cards 的 routeFailure 同口径);非失败缺省 */
	路由建议?: FailureRouting;
	证据路径?: string;
	/** 回执落卡结果(appendReceipt 的 kind;自拟回执回调时为 "已记录") */
	回执落卡?: ReceiptOutcome["kind"] | "未落卡";
	落卡说明?: string;
	未拉起原因?: string;
	/** runner.run 抛错时的原因(只发生在卡/运行器已被取消时) */
	错误?: string;
	持续毫秒?: number;
	/**
	 * 认领基线快照结果(R14/架构 §14):扇出认领与工具层 pao_change_status 走同一快照入口
	 * snapshotClaimBaseline(经 worker 模块 dispatch-core 共享核心),交回执比对
	 * (diffAgainstBaseline)与交卷清点以此为基线——用户既有脏改动不算 worker 的账。
	 * 可用:false 时原因如实标注(非 git 工作区等),不静默;非认领(未拉起/终态卡)缺省。
	 */
	认领基线?: DispatchBaseline;
	/**
	 * §14 越界核查:git 真值(当前 status 减认领基线)比对回执声明的产物清单,
	 * 虚报/越界/干净结构化亮出(文件级精度)。有认领快照且回执在手时才查;
	 * 手动会话主控看标记自行判断,工作流模式自动插人工门待 §11 工作流引擎(挂点在调用侧)。
	 */
	越界核查?: BoundaryWriteCheck;
	/** S5 包2 派发告警(工具表外名截严/仓内技能未经本地确认被忽略);无告警缺省 */
	派发告警?: string[];
	/** S5 包4 任务态自报(completed/completed_with_deviations/blocked/checkpoint);旧链路缺省。
	 *  标签路由行由 formatFanoutSummary 现算（单源 dispatch-core taskStateRoutingLine），不另存副本。 */
	任务态?: WorkerReceipt["任务态"];
}

export interface FanoutSummary {
	plan: FanoutBatchPlan;
	/** 批量派单理由(工具层必填;executor 直调可缺省)——随摘要输出,供上级审查 */
	理由?: string;
	/** 每卡终态,按拉起顺序排列 */
	结果: FanoutCardResult[];
	count: { 成功: number; 失败: number; 结果未知: number; 取消: number; 未拉起: number };
	/** 是否因取消信号中途停止(在跑进程已树杀确认,排队卡不再拉起) */
	已停止: boolean;
	/** 每张卡都有终态记录(无遗漏) */
	全部完成: boolean;
}

export interface FanoutDispatchInput {
	/** 卡引用列表(卡0017 / 卡#17 / 17),去重保序 */
	卡号列表: readonly string[];
	/** 并发上限,默认 2，硬上限 8 */
	并发上限?: number;
	/** 任务工作区卡目录 */
	cardsDir: string;
	/**
	 * 批量派单理由(pao_fanout 工具必填并留痕):随每条登记表记录(派单理由)与聚合摘要带出,
	 * 供上级审查。executor 直调可缺省(既有测试/宿主注入路径不强制)。
	 */
	理由?: string;
	/**
	 * 调用方会话 id（pao_fanout 工具层取 pi 工具上下文 sessionManager.getSessionId）:
	 * 注入 workflowCheck 做实例 owner 重核——T03 收口,单卡/扇出/自动链三入口准入一致;
	 * 缺省（直调无会话上下文,既有测试/宿主注入路径）不核 owner,行为不变。
	 */
	owner?: string;
}

export interface FanoutDispatchOptions {
	/** 本次派发使用的权威工作树宿主及目标；正式入口必填。 */
	worktreeHost?: PaoWorktreeHost;
	worktreeTarget?: WorktreeTarget;
	expectedInputVersion?: string;
	/** 运行器;缺省 = worker 模块 defaultWorkerRunner(进程进同一登记册,pao_stop_background能全停) */
	运行器?: WorkerRunner;
	/**
	 * 回执落卡回调;缺省 = 重读卡 → appendReceipt(尝试号 = 卡面当前尝试,失败带缺省分型)。
	 * 注入可覆盖(测试/宿主);无论哪种,逐卡调用,不混批。
	 */
	交回执?: (card: ParsedCard, receipt: WorkerReceipt) => ReceiptOutcome | Promise<ReceiptOutcome>;
	/** 当前回执实际落卡后由宿主投递直接上级；不代替回执、验收或状态机。 */
	onReceipt?: (card: ParsedCard, receipt: WorkerReceipt) => void | Promise<void>;
	/** 透传给每次 WorkerRunner.run 的公共参数(cwd/超时/环境变量/工具白名单/证据目录等) */
	公共参数?: Partial<Omit<WorkerRunOptions, "卡号" | "提示词">>;
	/** 按卡追加运行参数(测试按卡注入环境变量/ sleep 时长等);与公共参数浅合并,每卡参数优先 */
	每卡参数?: (card: ParsedCard) => Partial<Omit<WorkerRunOptions, "卡号" | "提示词">>;
	/** 批次取消信号:中止 = 先阻新卡(车道停拉)→ cancel 在跑进程(树杀+确认) */
	信号?: AbortSignal;
	/** 时间源(测试注入);缺省 new Date() */
	时间?: () => Date;
	paoHome?: string;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 与自动链同口径：changes 一旦出现（包括 []）就优先，只有缺省时才回落 artifact_path。 */
function receiptDeclarations(receipt: WorkerReceipt): string[] {
	return receipt.changes?.map((change) => change.路径) ?? receipt.artifact_path ?? [];
}

function summarize(
	plan: FanoutBatchPlan,
	input: FanoutDispatchInput,
	results: Map<string, FanoutCardResult>,
	stopped: boolean,
): FanoutSummary {
	const count = { 成功: 0, 失败: 0, 结果未知: 0, 取消: 0, 未拉起: 0 };
	let fallbackNote = 0;
	const ordered: FanoutCardResult[] = plan.拉起顺序.map((cardNo) => {
		const known = results.get(cardNo);
		if (known) return known;
		fallbackNote++;
		// 补位车道因停止提前收工,排队卡从未拉起:取消(停止语义),不算结果未知
		return stopped
			? { 卡号: cardNo, 终态: "取消", 未拉起原因: "扇出已停止,该卡仍在排队,未拉起" }
			: { 卡号: cardNo, 终态: "结果未知", 错误: "无执行记录(内部异常)" };
	});
	for (const result of ordered) count[result.终态]++;
	return {
		...(input.理由 ? { 理由: input.理由 } : {}),
		plan: plan,
		结果: ordered,
		count: count,
		已停止: stopped,
		全部完成: fallbackNote === 0 || stopped,
	};
}

/**
 * 执行一次扇出:定位卡 → 逐卡认领(或记录不拉起原因)→ 补位式并发执行 → 逐卡落回执 → 聚合摘要。
 * 全部卡有了终态才返回(前台等待完成;进程树归属主会话,关闭即停,无常驻)。
 */
export async function executeFanout(
	input: FanoutDispatchInput,
	options: FanoutDispatchOptions = {},
): Promise<FanoutSummary> {
	const projectRoot = projectRootForCards(input.cardsDir);
	const worktreeHost = options.worktreeHost ?? createSingleRootWorktreeHost(projectRoot);
	const worktreeTarget = options.worktreeTarget ?? { kind: "primary" as const };
	const runner = options.运行器 ?? defaultWorkerRunner;
	const now = options.时间 ?? (() => new Date());
	const plan = planFanout(input.卡号列表, input.并发上限);
	const results = new Map<string, FanoutCardResult>();

	// 拉起前准备(串行):定位卡 + 认领 + 认领基线快照(共享核心 dispatch-core);失败/不满足的卡记 未拉起,不进执行队列
	const runnable: { cardNo: string; card: ParsedCard }[] = [];
	for (const cardNo of plan.拉起顺序) {
		try {
			runnable.push({ cardNo: cardNo, card: locateDispatchCard(input.cardsDir, cardNo) });
		} catch (error) {
			results.set(cardNo, { 卡号: cardNo, 终态: "未拉起", 未拉起原因: errorMessage(error) });
		}
	}

	// ── 补位式执行:并发上限个车道,一个完成立刻从队列补位拉下一张,不按波次等待 ──
	const stopped = { value: options.信号?.aborted ?? false };
	const claimedCards = new Set<string>();
	const markStopped = (): void => {
		stopped.value = true;
	};
	options.信号?.addEventListener("abort", markStopped, { once: true });
	let next = 0;

	const runOne = async (item: (typeof runnable)[number]): Promise<FanoutCardResult> => {
		const { cardNo } = item;
		const startedAt = Date.now();
		try {
			let receiptDelivery: { card: ParsedCard; receipt: WorkerReceipt } | undefined;
			const dispatched = await executeDispatch<FanoutCardResult>(
				{
					cardsDir: input.cardsDir,
					card_no: cardNo,
					operator: OPERATOR,
					time: nowString(now()),
					dispatch_reason: input.理由,
				},
				{
					运行器: runner,
					paoHome: options.paoHome ?? process.env.PAO_HOME?.trim(),
					worktreeHost,
					worktreeTarget,
					...(options.expectedInputVersion !== undefined
						? { expectedInputVersion: options.expectedInputVersion }
						: {}),
					// 工作流派发校验（T02 装配注入,T03 owner 收口）:扇出派工作流卡同样过
					// 实例/轮次/owner/暂停/冻结版本校验,与单卡/自动链同判,不绕行。
					workflowCheck: (card) =>
						resolveWorkflowDispatch(card, {
							cardsDir: input.cardsDir,
							paoHome: options.paoHome ?? process.env.PAO_HOME?.trim(),
							owner: input.owner,
						}),
					解析监督路由: (card) =>
						resolveWorkerSupervisionRoute(card, {
							cardNo: String(card.card_no),
							cardsDir: input.cardsDir,
							operator: OPERATOR,
							ownerSession: input.owner,
							goal: card.frontmatter.goal ?? "",
						}) ?? null,
					// 总预算门禁（H0）:与单卡/自动链共用同一个工厂（usage/dispatch-gate 的
					// buildDispatchBudgetGate），判据与拒绝文案不可能分叉。没授权总预算时返回
					// undefined＝这条路行为与接线前逐字一致。扇出是最可能大额花钱的入口，
					// 不接这一处等于「并发不重复授额」在外派上是空的。
					预算门禁: buildDispatchBudgetGate({ paoHome: options.paoHome ?? process.env.PAO_HOME?.trim() }),
					并发上限: plan.并发上限,
					等待名额: true,
					公共参数: options.公共参数,
					每卡参数: options.每卡参数,
					信号: options.信号,
					认领: (claim) => {
						claimedCards.add(claim.card.path);
					},
				},
				async (claimed, receipt): Promise<FanoutCardResult> => {
					const { card, 尝试号: attempt, claimBaseline } = claimed;
					let writeCard: FanoutCardResult["回执落卡"];
					let writeCardNote: string | undefined;
					try {
						const outcome = options.交回执
							? await options.交回执(card, receipt)
							: await appendDispatchReceipt(card, receipt, now);
						writeCard = outcome.kind;
					} catch (error) {
						writeCard = "未落卡";
						writeCardNote = `回执落卡失败:${errorMessage(error)}(证据仍在 ${receipt.evidence_path})`;
					}
					if (writeCard === "已记录" && options.onReceipt && !runner.isStopped()) {
						receiptDelivery = { card, receipt };
					}
					const failureType = writeCard === "未落卡" ? "unknown_outcome" : classifyWorkerFailure(receipt);
					// §14 越界核查:git 真值(当前 status 减认领基线)比对回执声明的产物清单,虚报/越界
					// 结构化亮出(差异表随结果呈现,主控自行判断)。工作流模式「有差异自动插人工门(停流等
					// 点头)」的挂点在此:结论 !== "干净" 时分流进 §11 工作流引擎——引擎尚未实现,不硬做。
					let boundaryAudit: BoundaryWriteCheck | undefined;
					const snapshotPath = claimBaseline?.available ? claimBaseline.snapshotPath : undefined;
					if (snapshotPath) {
						try {
							boundaryAudit = checkBoundaryWrite(
								await diffAgainstBaseline(snapshotPath),
								receiptDeclarations(receipt),
							);
						} catch (error) {
							const reason = errorMessage(error);
							boundaryAudit = {
								结论: "无法核对",
								虚报: [],
								越界: [],
								相符: [],
								不可核验: [],
								汇总: `越界核查执行失败:${reason}`,
								原因: reason,
							};
						}
					}
					return {
						卡号: cardNo,
						终态: writeCard === "未落卡" ? "失败" : FINAL_STATE_BY_STATUS[receipt.status],
						attempt,
						摘要: receipt.summary,
						失败类型: writeCard === "未落卡" ? "unknown_outcome" : failureType,
						路由建议:
							writeCard === "未落卡"
								? routeFailure("unknown_outcome")
								: failureType
									? routeFailure(failureType)
									: undefined,
						证据路径: receipt.evidence_path,
						回执落卡: writeCard,
						落卡说明: writeCardNote,
						持续毫秒: Date.now() - startedAt,
						认领基线: claimBaseline,
						越界核查: boundaryAudit,
						派发告警: receipt.派发告警,
						// S5 包4 四写法②：任务态自报随结果带出(路由行由摘要现算,单源不存副本)
						任务态: receipt.任务态,
					};
				},
			);
			const result = dispatched.可派
				? dispatched.result
				: { 卡号: cardNo, 终态: "未拉起" as const, 未拉起原因: dispatched.原因 };
			// 直接上级投递依赖宿主 RPC，不能占用 executeDispatch 的任务根共享锁；
			// 回执落卡已完成，投递失败只补可回取的说明并告警，不改派发/回执终态。
			if (
				dispatched.可派 &&
				result.回执落卡 === "已记录" &&
				receiptDelivery &&
				options.onReceipt &&
				!runner.isStopped()
			) {
				try {
					await options.onReceipt(receiptDelivery.card, receiptDelivery.receipt);
				} catch (error) {
					result.落卡说明 = `回执已落卡，但直接上级投递失败:${errorMessage(error)}`;
					logWarn(`[pao] 卡${cardNo}${result.落卡说明}`);
				}
				result.持续毫秒 = Date.now() - startedAt;
			}
			return result;
		} catch (error) {
			if (error instanceof PaoWorkerError && error.code === "停止失败") throw error;
			const started = error instanceof PaoWorkerError && error.dispatchFailurePhase === "started";
			// 等执行锁或名额时 AbortSignal 会抛原始取消原因，尚未进入 runner，不能
			// 误记成普通“未拉起”而跳过取消落卡；其他真实异常仍保留原失败分类。
			const cancelled =
				(error instanceof PaoWorkerError && error.code === "已取消") ||
				(!started &&
					options.信号?.aborted === true &&
					(error === options.信号.reason || (error instanceof Error && error.name === "AbortError")));
			if (cancelled && runner.isStopped()) stopped.value = true;
			return {
				卡号: cardNo,
				终态: cancelled ? "取消" : started ? "失败" : "未拉起",
				错误: errorMessage(error),
				未拉起原因: cancelled || started ? undefined : errorMessage(error),
				持续毫秒: Date.now() - startedAt,
			};
		}
	};

	const laneCount = Math.min(plan.并发上限, runnable.length);
	const lanes = Array.from({ length: laneCount }, async () => {
		while (!stopped.value && !runner.isStopped()) {
			const index = next++;
			if (index >= runnable.length) return;
			const item = runnable[index];
			results.set(item.cardNo, await runOne(item));
		}
	});
	const laneResults = await Promise.allSettled(lanes);
	options.信号?.removeEventListener("abort", markStopped);
	const failedLane = laneResults.find((result) => result.status === "rejected");
	if (failedLane?.status === "rejected") throw failedLane.reason;
	if (runner.isStopped()) stopped.value = true;

	// ── 停止收尾:被本批认领(已改「进行中」)但扇出终态为取消的卡,owner 侧补落「取消」终态 ──
	// 不收尾的话卡文件停在「进行中」,下次扇出被 prepareCard「在先前尝试手中」拒派,只能人工收场。
	// 在跑被杀的卡可能已落「结果:取消」的 worker 回执(runner 对取消是正常 resolve,不走 catch),
	// 但回执不改状态——两类(在跑被杀/从未拉起)都要 owner 侧落终态;
	// 正常完成(成功/失败)并落了回执的卡不动——按既有语义留在「进行中」等 owner 审。
	if (stopped.value) {
		for (const item of runnable) {
			const known = results.get(item.cardNo);
			const pendingWrapUp = known === undefined || known.终态 === "取消";
			if (!pendingWrapUp) continue;
			// 扇出取消（M0-08）：被中途停止波及的卡逐张记摩擦草稿；recordFrictionDraft 自兜失败，不影响收尾
			await recordFrictionDraft(
				"扇出取消",
				`卡${item.cardNo}`,
				"扇出被中途停止(在跑进程已树杀确认,排队卡未拉起),该卡未跑完",
				input.cardsDir,
			);
			try {
				const current = readCard(item.card.path);
				if (current.frontmatter.status === "in_progress" && !claimedCards.has(current.path)) continue;
				if (current.frontmatter.status !== "in_progress" && current.frontmatter.status !== "unclaimed") continue;
				changeCardStatus(current, {
					操作者: current.frontmatter.owner === OPERATOR ? OPERATOR : "用户",
					to: "canceled",
					依据: "扇出被中途停止(在跑进程已树杀确认,排队卡未拉起)",
					时间: nowString(now()),
				});
			} catch (error) {
				// 中止路径不能再失败:收尾失败只记说明,不抛
				const writeCardNote = `停止收尾失败(卡文件仍停在原状态):${errorMessage(error)}`;
				results.set(item.cardNo, {
					...(known ?? { 卡号: item.cardNo, 终态: "取消" as const, 未拉起原因: "扇出已停止,该卡仍在排队,未拉起" }),
					落卡说明: writeCardNote,
				});
			}
		}
	}

	return summarize(plan, input, results, stopped.value);
}

/** 聚合摘要 → 用户可见文本(先总后分,失败卡带路由建议;批量理由随摘要留痕) */
export function formatFanoutSummary(summary: FanoutSummary): string {
	const { count, plan } = summary;
	const head =
		`扇出完成:${summary.结果.length} 张卡(并发上限 ${plan.并发上限})——` +
		`成功 ${count.成功},失败 ${count.失败},结果未知 ${count.结果未知},取消 ${count.取消},未拉起 ${count.未拉起}` +
		(summary.已停止 ? ";本次扇出被中途停止(在跑进程已树杀并确认退出,排队卡不再拉起)" : "");
	const lines = [head];
	if (summary.理由) lines.push(`派单理由:${summary.理由}`);
	if (plan.重复剔除.length > 0) {
		lines.push(`重复卡号已剔除(只跑一次):${plan.重复剔除.map((n) => `卡${n}`).join("、")}`);
	}
	for (const r of summary.结果) {
		let line = `- 卡${r.卡号}〔${r.终态}〕`;
		if (r.attempt !== undefined) line += ` 尝试${r.attempt}`;
		if (r.摘要) line += `:${r.摘要.split("\n")[0]}`;
		if (r.未拉起原因) line += `:${r.未拉起原因}`;
		if (r.错误) line += `(${r.错误})`;
		if (r.落卡说明) line += `;${r.落卡说明}`;
		lines.push(line);
		if (r.认领基线) {
			lines.push(
				r.认领基线.available
					? `  认领基线:快照已落 ${r.认领基线.snapshotPath}(既有 ${r.认领基线.existingEntryCount} 条不计 worker 的账,交回执比对以此为基线)`
					: `  认领基线:不可用——${r.认领基线.reason ?? "原因未记"}(越界比对无基线,边界如实标注)`,
			);
		}
		if (r.越界核查) {
			lines.push(`  越界核查:${r.越界核查.汇总}`);
		}
		if (r.派发告警?.length) {
			lines.push(`  派发告警:${r.派发告警.join(";")}`);
		}
		if (r.路由建议) {
			lines.push(`  路由建议:${r.路由建议.类型} → ${r.路由建议.建议动作}(${r.路由建议.说明})`);
		}
		// S5 包4 四写法②：任务态标签路由行(标签→处理动作,办完即停)
		if (r.任务态) lines.push(`  ${taskStateRoutingLine(r.任务态)}`);
	}
	return lines.join("\n");
}
