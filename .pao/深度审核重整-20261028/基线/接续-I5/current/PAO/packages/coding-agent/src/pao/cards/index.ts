/**
 * pao 卡片系统核心库（卡0001）。
 *
 * 导出两层：
 * - registerCardTools(pi)：注册 pao_create_card / pao_submit_receipt / pao_change_status / pao_query_queue 工具与 /队列 命令；
 * - 纯库函数与类型：供 B 卡（worker）与主控接线复用。
 */

export { writeFileAtomic } from "../shared/atomic.ts";
export type { FileLockOptions } from "../shared/lock.ts";
export { withFileLock } from "../shared/lock.ts";
export type { BaselineDiff, BoundaryWriteCheck, ClaimBaseline } from "./baseline.ts";
export { baselineSnapshotPath, checkBoundaryWrite, diffAgainstBaseline, snapshotClaimBaseline } from "./baseline.ts";
export { BLACKBOARD_TEMPLATE, blackboardPath, blackboardPointer, ensureBlackboard } from "./blackboard.ts";
export type { CardCreateInput, CardScanProblem, CardScanResult, CreateCardOptions } from "./cardfile.ts";
export {
	CardCreationReadError,
	cardFileName,
	cardNumberFromFileName,
	createCard,
	listCards,
	loadCard,
	parseCardContent,
	parseReceipts,
	projectRootForCards,
	readCard,
	scanCards,
	serializeCard,
	serializeReceipt,
	slugifyGoal,
	validateFrontmatter,
} from "./cardfile.ts";
export { formatCardNumber, nextCardNumber, parseCardRef } from "./counter.ts";
export * from "./delivery.ts";
export type { DependencyGateResult, DependencyStatus } from "./deps.ts";
export { checkDependencies } from "./deps.ts";
export type { PaoCardErrorCode } from "./errors.ts";
export { isPaoCardError, PaoCardError } from "./errors.ts";
export type { FailureRouting } from "./failures.ts";
export { ALL_FAILURE_ROUTINGS, routeFailure } from "./failures.ts";
export * from "./metrics.ts";
export type { AppendReceiptInput, ReceiptOutcome } from "./receipts.ts";
export { appendReceipt, currentAttemptReceipt, hasConflictingTerminalReceipts, isPendingReview } from "./receipts.ts";
export { renderAllQueues, renderQueue } from "./render.ts";
export type { StatusChangeInput, TransitionCheckInput } from "./statemachine.ts";
export {
	applyOwnerOnClaim,
	applyTransitionEffects,
	changeCardStatus,
	checkTransition,
	checkWriterAuthority,
	DEFAULT_ATTEMPT_LIMIT,
	isTerminal,
} from "./statemachine.ts";
export type { CardToolsOptions } from "./tools.ts";
export { registerCardTools } from "./tools.ts";
export type {
	CardBudget,
	CardFrontmatter,
	CardPriority,
	CardStatus,
	CardTier,
	FailureType,
	ParsedCard,
	QueueCardView,
	Receipt,
} from "./types.ts";
export { CARD_PRIORITIES, CARD_STATUSES, CARD_TIERS, FAILURE_TYPES } from "./types.ts";
export * from "./verifier.ts";
export type { UnlockedCard, WakeupCardView } from "./wakeup.ts";
export { findUnlockedCards, renderUnlockNotice, wakeupViews } from "./wakeup.ts";
