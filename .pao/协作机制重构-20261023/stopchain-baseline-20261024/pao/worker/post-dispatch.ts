/** 派发结束并释放执行锁后的共同完成链；直接任务与工作流共用核查、验收及交付。 */
import {
	baselineSnapshotPath,
	captureContentTree,
	checkBoundaryWrite,
	diffAgainstBaseline,
} from "../cards/baseline.ts";
import { deliverCard } from "../cards/delivery.ts";
import { changeCardStatus, parseCardRef, projectRootForCards } from "../cards/index.ts";
import { reviewCardForDelivery, verifyCard } from "../cards/verifier.ts";
import { nowString } from "../shared/time.ts";
import { logWarn } from "../shared/log.ts";
import type { WorktreeTarget } from "../worktrees/types.ts";
import { classifyWorkerFailure, locateDispatchCard } from "./dispatch-core.ts";
import type { WorkerReceipt } from "./receipt.ts";
import type { WorkerRunner } from "./runner.ts";
export type PostDispatchStage = "派发" | "回执" | "越界" | "验收" | "交卷" | "完成" | "失败" | "停审";
export interface PostDispatchStep {
	cardRef: string;
	stage: PostDispatchStage;
	note: string;
}
export interface PostDispatchReceiptEvent {
	cardRef: string;
	attempt: number;
	result: WorkerReceipt["status"];
	receipt: WorkerReceipt;
	recorded: boolean;
}

export interface PostDispatchReviewEvent {
	cardRef: string;
	attempt: number;
	/** 当前执行根；没有受管执行上下文时是项目根。 */
	executionRoot: string;
	/** 若本次派发有 execution-context，给出原绑定摘要。 */
	bindingDigest?: string;
	/** 机械验收已经全过的条目。 */
	mechanicalResults: {
		序号: number;
		类型: string;
		摘要: string;
		结果: "过";
		说明: string;
	}[];
	/** 需要部长判断的人话句；没有时为空数组。 */
	requirements: string[];
	/** 当前 attempt 回执中的 fail/not_run；这些项不能被部长 pass 绕过。 */
	unmetReports: {
		尝试: number;
		verification_index: number;
		条件: string;
		自报结论: "fail" | "not_run";
		证据?: string;
	}[];
	/** worker 产物声明，供部长和宿主核对真实证据。 */
	artifactPaths: string[];
	evidencePath: string;
}

export type PostDispatchReviewDecision = { result: "pass"; basis: string } | { result: "hold"; basis: string };

export interface PostDispatchOptions {
	cardsDir: string;
	cardRef: string;
	operator: string;
	runner: WorkerRunner;
	receipt: WorkerReceipt;
	receiptWriteError?: string;
	signal?: AbortSignal;
	sandboxRoot?: string;
	commandTimeoutMs?: number;
	now?: () => string;
	worktreeTarget?: WorktreeTarget;
	/** 独立审核在派发前取得的原项目版本；结束后必须仍然相同。 */
	reviewSourceTree?: string;
	independentReview?: boolean;
	/** 由调用方提供原有显示语境；不参与业务判断。 */
	label?: string;
	retryHint?: string;
	onStep?: (step: PostDispatchStep) => void;
	onReceipt?: (event: PostDispatchReceiptEvent) => void | Promise<void>;
	onReviewRequired?: (
		event: PostDispatchReviewEvent,
	) => PostDispatchReviewDecision | Promise<PostDispatchReviewDecision>;
}
async function emitReceipt(options: PostDispatchOptions, event: PostDispatchReceiptEvent): Promise<void> {
	if (!options.onReceipt || options.runner.isStopped()) return;
	try {
		await options.onReceipt(event);
	} catch (error) {
		logWarn(
			"[pao] 完成链回执回调失败（卡" +
				event.cardRef +
				"）：" +
				(error instanceof Error ? error.message : String(error)),
		);
	}
}
/** 返回停因表示不能继续；undefined 表示本次核查、验收和必要交付完成。 */
export async function completeDispatchedTask(options: PostDispatchOptions): Promise<string | undefined> {
	options.signal?.throwIfAborted();
	const initialChange = changedCardReason(options);
	if (initialChange) return initialChange;
	const { cardsDir, cardRef, operator, receipt, receiptWriteError, reviewSourceTree, independentReview } = options;
	const cardNumber = parseCardRef(cardRef);
	const label = options.label ?? `卡${cardRef}`;
	const steps = { push: (step: PostDispatchStep) => options.onStep?.(step) };
	const step = {
		cardRef,
		stage: "回执",
		note: `worker 回执 ${receipt.status}${receiptWriteError ? `（回执落卡失败:${receiptWriteError}）` : ""}${
			receipt.派发告警?.length ? `；派发告警:${receipt.派发告警.join(";")}` : ""
		}`,
	} satisfies PostDispatchStep;
	// ② 回执失败族 → 卡落失败（分型照 classifyWorkerFailure；落卡失败＝结果未知，不伪造）
	const receiptUnrecorded = receiptWriteError !== undefined;
	if (receipt.status !== "success" || receiptUnrecorded) {
		const failureType = receiptUnrecorded ? "unknown_outcome" : (classifyWorkerFailure(receipt) ?? "unknown_outcome");
		const basis = receiptUnrecorded
			? `回执落卡失败（${receiptWriteError}），按结果未知处理，证据仍在 ${receipt.evidence_path}`
			: `worker 回执 ${receipt.status}${receipt.failure_type ? `（${receipt.failure_type}）` : ""}，自动链如实落失败`;
		await failCard(cardsDir, cardRef, operator, failureType, basis);
		steps.push(step);
		await emitReceipt(options, {
			cardRef,
			attempt: receipt.attempt,
			result: receipt.status,
			receipt,
			recorded: receiptWriteError === undefined,
		});
		steps.push({ cardRef, stage: "失败", note: `${failureType}:${basis}` });
		return `${label}回执${receiptUnrecorded ? "无效" : "失败"}，已落失败态，下游按「失败即停」挂起`;
	}
	steps.push(step);
	await emitReceipt(options, {
		cardRef,
		attempt: receipt.attempt,
		result: receipt.status,
		receipt,
		recorded: receiptWriteError === undefined,
	});
	if (options.runner.isStopped()) return `${label}执行器已全停，保留回执，不再验收或交卷`;
	const callbackChange = changedCardReason(options);
	if (callbackChange) return callbackChange;

	// ③ 越界核查（git 真值 vs 回执声明）
	const diff = await diffAgainstBaseline(baselineSnapshotPath(cardsDir, cardNumber, receipt.attempt), options.signal);
	options.signal?.throwIfAborted();
	const boundaryChange = changedCardReason(options);
	if (boundaryChange) return boundaryChange;
	if (reviewSourceTree !== undefined) {
		const current = await captureContentTree(projectRootForCards(cardsDir), options.signal);
		const reviewChange = changedCardReason(options);
		if (reviewChange) return reviewChange;
		if (current.tree !== reviewSourceTree || diff.worker改动.length > 0) {
			await failCard(
				cardsDir,
				cardRef,
				operator,
				"unknown_outcome",
				"验证期间业务内容发生变化；验证卡只能提交证据，不得修改业务成果",
			);
			steps.push({ cardRef, stage: "失败", note: "验证卡修改了业务内容或原项目版本已变化" });
			return `卡${cardRef} 审核验证成果版本不一致，拒绝放行；副本与证据保留供核查`;
		}
	}
	const check = checkBoundaryWrite(
		diff,
		receipt.changes?.map((change) => change.路径) ?? receipt.artifact_path ?? [],
		{ 项目根: diff.项目根 },
	);
	steps.push({ cardRef, stage: "越界", note: check.汇总 });
	if (check.结论 === "虚报" || check.结论 === "越界" || check.结论 === "虚报+越界") {
		const basis = `越界核查 ${check.结论}：${check.汇总}（改动与声明对不上，结果不可信）`;
		await failCard(cardsDir, cardRef, operator, "unknown_outcome", basis);
		steps.push({
			cardRef,
			stage: "失败",
			note: `unknown_outcome:${basis}`,
		});
		return `${label}越界核查 ${check.结论}，已落失败态，下游挂起`;
	}
	if (check.结论 === "无法核对") {
		steps.push({
			cardRef,
			stage: "停审",
			note: `越界核查无法核对（${check.原因 ?? diff.汇总}），不自动定罪，留 owner`,
		});
		return `${label}越界核查无法核对（${check.原因 ?? diff.汇总}），链停留 owner 裁决`;
	}

	// ④ 机械验收（全机械全过 → verifyCard 内自动落已交付）
	if (options.runner.isStopped()) return `${label}执行器已全停，保留核查证据，不再验收或交卷`;
	const { result: verification } = await verifyCard(cardsDir, cardNumber, {
		operator,
		executionKey: { cardsDir, cardNo: cardNumber, attempt: receipt.attempt },
		sandbox_root: options.sandboxRoot,
		命令超时毫秒: options.commandTimeoutMs,
		signal: options.signal,
	});
	options.signal?.throwIfAborted();
	steps.push({ cardRef, stage: "验收", note: `${verification.结论}（${verification.汇总}）` });
	if (verification.结论 === "未过") {
		const basis = `机械验收未过：${verification.汇总}`;
		const fresh = locateDispatchCard(cardsDir, cardRef);
		if (fresh.frontmatter.status === "in_progress" && fresh.frontmatter.attempt === receipt.attempt) {
			await failCard(cardsDir, cardRef, operator, "unknown_outcome", basis);
			steps.push({ cardRef, stage: "失败", note: `unknown_outcome:${basis}` });
			const next = options.retryHint ?? "owner 可按 failed→unclaimed→in_progress 重试，仍受尝试上限约束。";
			return `${label}机械验收未过，已落失败态并保留验收证据；下游按「失败即停」挂起。${next}`;
		}
		steps.push({
			cardRef,
			stage: "停审",
			note: `验收未过，但卡状态为 ${fresh.frontmatter.status}、尝试为 ${fresh.frontmatter.attempt}（本次 ${receipt.attempt}）；保留现状，不覆盖`,
		});
		return `${label}验收未过，卡状态或尝试已变化，保留现状并停链`;
	}
	if (verification.结论 !== "全过自动交付") {
		if (verification.结论 === "全过停人工审" && options.onReviewRequired && !options.runner.isStopped()) {
			const executionRoot = verification.执行上下文?.executionRoot ?? diff.项目根 ?? projectRootForCards(cardsDir);
			const event: PostDispatchReviewEvent = {
				cardRef,
				attempt: receipt.attempt,
				executionRoot,
				...(verification.执行上下文?.bindingDigest ? { bindingDigest: verification.执行上下文.bindingDigest } : {}),
				mechanicalResults: verification.条目结果.map((entry) => ({
					序号: entry.序号,
					类型: entry.类型,
					摘要: entry.摘要,
					结果: "过" as const,
					说明: entry.说明,
				})),
				requirements: verification.人话句,
				unmetReports: verification.自报未达项 ?? [],
				artifactPaths: receipt.artifact_path ?? [],
				evidencePath: receipt.evidence_path,
			};
			let decision: PostDispatchReviewDecision;
			try {
				decision = await waitForReview(options, options.onReviewRequired(event));
			} catch (error) {
				if (options.runner.isStopped()) return `${label}执行器已全停，审核期间原始回执和停因已保留，链停且不再唤醒`;
				steps.push({
					cardRef,
					stage: "停审",
					note: `部长审核调用失败:${error instanceof Error ? error.message : String(error)}，留 owner`,
				});
				return `${label}部长审核调用失败，链停，留 owner 处理后续跑`;
			}
			// 部长审核是异步等待；期间用户可能显式全停。不能用等待前的事实放行。
			if (options.runner.isStopped()) return `${label}执行器已全停，审核返回不推进，原始回执和停因已保留`;
			if (
				(decision.result !== "pass" && decision.result !== "hold") ||
				typeof decision.basis !== "string" ||
				!decision.basis.trim()
			) {
				steps.push({ cardRef, stage: "停审", note: "部长审核结果缺少有效 pass/hold 判定或依据" });
				return `${label}部长审核结果无效，链停，留 owner`;
			}
			if (decision.result === "pass" && event.unmetReports.length > 0) {
				steps.push({
					cardRef,
					stage: "停审",
					note: `部长要求通过，但当前 attempt 有 ${event.unmetReports.length} 条自报未达项；不能由部长自动放行`,
				});
				return `${label}存在自报未达项，部长不能自动放行，链停留 owner 逐项裁决`;
			}
			if (decision.result === "hold") {
				steps.push({ cardRef, stage: "停审", note: `部长审核 hold:${decision.basis.trim()}` });
				return `${label}部长审核 hold：${decision.basis.trim()}，链停，留 owner`;
			}
			// 审核期间可能已换 attempt、终止或交付；部长 pass 只能进入原审核入口，不能直接改状态。
			const fresh = locateDispatchCard(cardsDir, cardRef);
			if (fresh.frontmatter.status !== "in_progress" || fresh.frontmatter.attempt !== receipt.attempt) {
				return `${label}部长审核期间卡状态或尝试已变化，链停留 owner`;
			}
			steps.push({
				cardRef,
				stage: "验收",
				note: `部长审核 pass:${decision.basis.trim()}；进入原交卷路径`,
			});
			let delivered: Awaited<ReturnType<typeof reviewCardForDelivery>>;
			try {
				// 复用人工交付原本的机械条件、当前回执、越界和执行绑定门；0 机械项也不能绕过。
				delivered = await reviewCardForDelivery(
					cardsDir,
					cardNumber,
					{
						operator,
						executionKey: { cardsDir, cardNo: cardNumber, attempt: receipt.attempt },
						signal: options.signal,
					},
					`部长审核通过：${decision.basis.trim()}`,
				);
			} catch (error) {
				return `${label}部长审核 pass 未通过原机械审核：${
					error instanceof Error ? error.message : String(error)
				}，链停，留 owner`;
			}
			if (options.runner.isStopped()) return `${label}执行器已全停，审核通过不推进，原始回执和停因已保留`;
			const transitioned =
				delivered.frontmatter.status === "delivered"
					? delivered
					: changeCardStatus(delivered, {
							操作者: operator,
							to: "delivered",
							依据: `部长审核通过：${decision.basis.trim()}`,
							时间: options.now?.() ?? nowString(new Date()),
						});
			if (transitioned.frontmatter.status !== "delivered" || transitioned.frontmatter.attempt !== receipt.attempt)
				return `${label}审核通过后未能把当前尝试落为已交付，链停留 owner`;
		} else {
			return `${label}验收结论「${verification.结论}」，不自动交付，留 owner 处理后推流续跑`;
		}
	}

	// ⑤ 交卷（幂等：无文件产物的回答型任务不空提交也算走完）
	if (options.runner.isStopped()) return `${label}执行器已全停，保留验收证据，不再交卷`;
	const verifiedCard = locateDispatchCard(cardsDir, cardRef);
	if (verifiedCard.frontmatter.status !== "delivered" || verifiedCard.frontmatter.attempt !== receipt.attempt) {
		return `${label}尚未通过当前尝试的交付检查，不交卷：${verification.交付说明 ?? verification.汇总}`;
	}
	// 验证卡只交证据，不把副本中的构建或测试生成物合并进业务项目。
	if (independentReview) return undefined;
	const delivery = await deliverCard(cardsDir, cardNumber, {
		signal: options.signal,
		...(options.worktreeTarget?.kind === "managed"
			? { executionKey: { cardsDir, cardNo: cardNumber, attempt: receipt.attempt } }
			: {}),
	});
	steps.push({
		cardRef,
		stage: delivery.交卷 || !delivery.原因 ? "完成" : "停审",
		note: delivery.消息,
	});
	if (!delivery.交卷 && delivery.原因) {
		return `${label}已交付但交卷失败（${delivery.原因}），提交留 owner 手工接手`;
	}
	return undefined;
}

/** 旧尝试和已终结任务的回执只能留档，不能由后处理改变当前任务。 */
function changedCardReason(options: PostDispatchOptions): string | undefined {
	const card = locateDispatchCard(options.cardsDir, options.cardRef);
	if (card.frontmatter.status !== "in_progress" || card.frontmatter.attempt !== options.receipt.attempt) {
		return `卡${options.cardRef}状态或尝试已变化，保留现状，不用旧回执推进或落失败`;
	}
	return undefined;
}

/**
 * 审核回调可能由桥接层等待部长工具，而外部实现不一定自行监听 signal。
 * 自动链自己把这个 Promise 与运行器全停/宿主关闭 signal 合并，确保等待可收尾；
 * 回调本身仍只提供 pass/hold 判定，不会在这里改卡。
 */
function waitForReview(
	options: PostDispatchOptions,
	pending: Promise<PostDispatchReviewDecision> | PostDispatchReviewDecision,
): Promise<PostDispatchReviewDecision> {
	const promise = Promise.resolve(pending);
	const signal = options.signal;
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<PostDispatchReviewDecision>((resolve, reject) => {
		const onAbort = () => {
			cleanup();
			reject(signal.reason ?? new Error("自动链审核等待已取消"));
		};
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		signal.addEventListener("abort", onAbort, { once: true });
		void promise.then(
			(decision) => {
				cleanup();
				resolve(decision);
			},
			(error: unknown) => {
				cleanup();
				reject(error);
			},
		);
	});
}

async function failCard(
	cardsDir: string,
	cardRef: string,
	operator: string,
	failureType: "transient" | "missing_input" | "insufficient_capability" | "unknown_outcome",
	basis: string,
): Promise<void> {
	const fresh = locateDispatchCard(cardsDir, cardRef);
	changeCardStatus(fresh, {
		操作者: operator,
		to: "failed",
		失败类型: failureType,
		依据: basis,
		时间: nowString(new Date()),
	});
}
