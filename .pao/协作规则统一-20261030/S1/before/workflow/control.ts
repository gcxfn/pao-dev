/** v2 流程控制正本。卡保留执行结果；本文件保留冻结图、轮次与决策，不从卡猜恢复状态。 */

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { stringify } from "yaml";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import {
	baselineSnapshotPath,
	captureContentTree,
	diffAgainstBaseline,
	PROJECT_CONTENT_PATHSPECS,
	verifyReviewEvidenceVersion,
} from "../cards/baseline.ts";
import { executionContextPath, readExecutionBinding, resolveExecutionContext } from "../cards/execution-context.ts";
import {
	changeCardStatus,
	checkTransition,
	createCard,
	currentAttemptReceipt,
	deliverCard,
	formatCardNumber,
	hasConflictingTerminalReceipts,
	listCards,
	loadCard,
	parseCardRef,
	projectRootForCards,
	readCard,
	reviewCardForDelivery,
} from "../cards/index.ts";
import { reopenForReview, reopenOriginalCard } from "../cards/rework.ts";
import type { CardFrontmatter, CardStatus, ParsedCard } from "../cards/types.ts";
import { readLatestVerdict, validateAcceptance } from "../cards/verifier.ts";
import { loadDispatchMapArtifact } from "../dispatch-brief/artifacts.ts";
import { validateLegacyInputReferences } from "../dispatch-brief/brief.ts";
import { parseDispatchUri } from "../dispatch-brief/uri.ts";
import { assertDispatchMapHandoff } from "../dispatch-brief/workspace.ts";
import { writeFileAtomic } from "../shared/atomic.ts";
import { GIT_READ_TIMEOUT_MS, gitProcessErrorText } from "../shared/git.ts";
import { withFileLock } from "../shared/lock.ts";
import { pathKey } from "../shared/path-key.ts";
import { nowString } from "../shared/time.ts";
import { readWorkerChangeFacts } from "../worker/change-facts.ts";
import { readWorkerExecutionFacts } from "../worker/evidence-facts.ts";
import { detectExecutionOccupancy } from "../worker/lock.ts";
import { isCompletedTaskState } from "../worker/receipt.ts";
import type { ProcessEntry } from "../worker/registry.ts";
import type { DriveReport, DriverOptions } from "./driver.ts";
import { requiresDispatchMapHandoff } from "./handoff.ts";
import {
	assertRunModeAllowsRecipeGates,
	type ControlResult,
	type ControlRunMode,
	decisionFieldProblems,
	displayRunMode,
	formatDecisionFieldProblems,
	type IndependentReviewSubmissionSkip,
	isUnattended,
	type PendingResolutionRecord,
	type PendingResolutionStage,
	pendingDeadline,
	pendingKey,
	resolveControlRunMode,
	splitControlRunModeParams,
	storedControlRunMode,
	validatePending,
	validatePendingResolutionRecords,
	type WorkflowPending,
} from "./policy.ts";
import { parseRecipe, type RecipeNode, requireParams, substituteParams, type WorkflowRecipe } from "./recipe.ts";
import {
	type BoundDeviationDecision,
	createRulingPending,
	expirePending as expirePendingFact,
	mergePending,
	type PendingDecisionInput,
	pendingSummary,
	planPendingResolution,
} from "./transition.ts";

export const WORKFLOW_NODE_MAP_EVENT = "节点交接地图";
export const WORKFLOW_WORKER_REVIEW_RESULT_EVENT = "工人审核结论";

export interface NodeControl {
	名字: string;
	轮次: number;
	卡: string[];
	拆解结束: boolean;
	零卡理由?: string;
	部长会话?: string;
	确认?: string;
	判定?: Decision;
	重做理由?: string;
	放行修复?: boolean;
	历史: { 轮次: number; 卡: string[]; 判定?: Decision; 原因: string }[];
	基线?: { 项目根: string; 提交: string; 未跟踪: string[] };
	基线错误?: string;
}
export interface Decision {
	结果: "pass" | "change" | "reject";
	理由: string;
	失败轴?: "card" | "dept_standard" | "both";
	引用: string[];
	目标?: string;
	/** 范围外改进仅列建议，不参与回边与自动派发。 */
	建议?: string[];
	/** 判定所对应的真实 Git 内容树；成功追加判定时捕获，主控修改成果后失效。 */
	projectRoot?: string;
	contentTree?: string;
	时间: string;
}
export interface FlowControl {
	版本: 2;
	实例: string;
	owner: string;
	脉络: string;
	工作流: string;
	卡目录: string;
	启动: string;
	状态: "运行中" | "挂起" | "已完成";
	冻结配方: WorkflowRecipe;
	参数: Record<string, string>;
	/** 新实例启动时冻结；旧实例缺字段按有人值守读取，不能中途切换。 */
	运行方式?: ControlRunMode;
	节点: NodeControl[];
	回边次数: Record<string, number>;
	/** S6-K2 自动链实例级累计：本实例自动链已派卡数（跨调用累计，防后台续链重置单次上限；随派随记） */
	已派卡?: number;
	/** S6-K3 叫人去重（v2）：最近一次叫人的去重键（同 v1 清单「叫人」语义；undefined＝未叫过/已确认清空） */
	叫人?: string;
	暂停?: string;
	裁定?: { 节点: string; 轮次: number; 理由: string; 通道: "主控" | "人工" };
	/** 结构化待决现场；同一时间只允许一个，旧清单缺字段时按既有裁定/暂停行为读取。 */
	待决?: WorkflowPending;
	/** 单次待决办理的阶段正本；与卡五态分离，用于验收后失败定位和幂等恢复。 */
	待决办理?: PendingResolutionRecord[];
	/** 业务结果维度；与卡五态、实例 running/hold/completed 分开记录。 */
	结果?: ControlResult[];
	记录: { 时间: string; 事件: string; 节点?: string; 轮次?: number; 理由: string }[];
}
export type ControlRecord = FlowControl["记录"][number];
export interface NodeIdentity {
	实例: string;
	节点: string;
	轮次: number;
	部长会话: string;
}
export type NodeCardInput = Pick<
	CardFrontmatter,
	"goal" | "acceptance" | "inputs" | "constraints" | "priority" | "budget"
>;
export interface PendingResolutionInput {
	pending_key: string;
	decisions: PendingDecisionInput[];
}

export interface PendingResolutionResult {
	pending_key: string;
	stage: "completed";
	idempotent: boolean;
	submission: NonNullable<PendingResolutionRecord["submission"]>;
	flow_status: DriveReport["status"];
}

export function controlPath(recipe: Pick<WorkflowRecipe, "名字">, options: DriverOptions): string {
	return join(options.workspaceDir ?? dirname(options.cardsDir), `工作流实例-${recipe.名字}.md`);
}
function fail(message: string): never {
	throw new Error(`[FLOW_CONTROL] ${message}`);
}
function canonical(path: string): string {
	return pathKey(resolve(path));
}

export function readControl(recipe: WorkflowRecipe, options: DriverOptions): FlowControl {
	const path = controlPath(recipe, options);
	if (!existsSync(path)) fail(`缺少控制清单（文件：${path}）；只能展示旧卡，须人工重建，不能自动恢复`);
	const { frontmatter: raw } = parseFrontmatter<Record<string, unknown>>(readFileSync(path, "utf8"));
	// 格式版本分离：2 才是控制正本。未知新版（如 3）不补默认值、不按 v2 解释——原件保留，
	// 如实报出盘上实际版本，由人工或升级内核处理，避免把新版现场读成 v2 造成假成功。
	if (raw.版本 !== 2)
		fail(
			`旧实例或未知版本只可历史展示；须显式创建新副本，不可按 v2 续跑（文件：${path}；盘上格式版本：${
				raw.版本 === undefined ? "缺失" : String(raw.版本)
			}，控制正本须为 2）；原件保留不动，请用 pao_query_flow 查历史状态或新建实例`,
		);
	if (
		typeof raw.实例 !== "string" ||
		!raw.实例 ||
		typeof raw.owner !== "string" ||
		!raw.owner ||
		typeof raw.脉络 !== "string" ||
		!raw.脉络 ||
		typeof raw.卡目录 !== "string" ||
		raw.工作流 !== recipe.名字 ||
		!Array.isArray(raw.节点) ||
		!Array.isArray(raw.记录) ||
		!raw.冻结配方 ||
		typeof raw.冻结配方 !== "object" ||
		!raw.参数 ||
		typeof raw.参数 !== "object" ||
		!raw.回边次数 ||
		typeof raw.回边次数 !== "object" ||
		!["运行中", "挂起", "已完成"].includes(String(raw.状态))
	)
		fail(`控制清单损坏（文件：${path}）；原件保留不动，须人工重建摘要，不得自动续跑`);
	const flow = raw as unknown as FlowControl;
	if (canonical(flow.卡目录) !== canonical(options.cardsDir)) fail("卡目录与控制清单归属不一致");
	if (flow.运行方式 !== undefined) {
		try {
			storedControlRunMode(flow.运行方式);
		} catch (error) {
			fail(error instanceof Error ? error.message : String(error));
		}
	}
	// 重新走配方解析验证冻结结构，不能相信 JSON/YAML 强制类型转换。
	const frozen = flow.冻结配方;
	const validated = parseRecipe(`---\n${stringify({ ...frozen, 版本: 2 })}---\n${frozen.说明 ?? ""}`, frozen.文件路径);
	if (
		validated.名字 !== flow.工作流 ||
		flow.节点.length !== validated.节点.length ||
		new Set(flow.节点.map((n) => n.名字)).size !== flow.节点.length
	)
		fail("冻结图与控制节点不一致");
	for (const node of flow.节点) {
		if (
			!validated.节点.some((n) => n.名字 === node.名字) ||
			!Number.isSafeInteger(node.轮次) ||
			node.轮次 < 1 ||
			!Array.isArray(node.卡) ||
			node.卡.some((ref) => typeof ref !== "string" || !/^(?:卡)?\d+$/.test(ref)) ||
			typeof node.拆解结束 !== "boolean" ||
			!Array.isArray(node.历史)
		)
			fail("节点控制字段损坏");
		for (const key of ["零卡理由", "部长会话", "确认", "重做理由", "基线错误"] as const)
			if (node[key] !== undefined && (typeof node[key] !== "string" || !node[key]!.trim())) fail(`节点 ${key} 损坏`);
		if (node.放行修复 !== undefined && typeof node.放行修复 !== "boolean") fail("配置放行标记损坏");
		if (
			node.判定 &&
			(!["pass", "change", "reject"].includes(node.判定.结果) ||
				typeof node.判定.理由 !== "string" ||
				!node.判定.理由.trim() ||
				!Array.isArray(node.判定.引用) ||
				!node.判定.引用.length ||
				(node.判定.projectRoot !== undefined &&
					(typeof node.判定.projectRoot !== "string" || !node.判定.projectRoot.trim())) ||
				(node.判定.contentTree !== undefined &&
					(typeof node.判定.contentTree !== "string" || !/^[a-f0-9]{40,64}$/i.test(node.判定.contentTree))))
		)
			fail("节点判定损坏");
		if (new Set(node.卡).size !== node.卡.length) fail("同一节点重复卡映射");
		if (
			node.基线 &&
			(typeof node.基线.项目根 !== "string" ||
				!/^[a-f0-9]{40,64}$/.test(node.基线.提交) ||
				!Array.isArray(node.基线.未跟踪))
		)
			fail("节点基线损坏");
	}
	if (Object.values(flow.参数).some((v) => typeof v !== "string")) fail("参数损坏");
	const allRefs = flow.节点.flatMap((node) => node.卡);
	if (new Set(allRefs).size !== allRefs.length) fail("一张卡不能归属多个当前节点");
	for (const count of Object.values(flow.回边次数))
		if (!Number.isSafeInteger(count) || count < 0) fail("回边计数损坏");
	if (flow.已派卡 !== undefined && (!Number.isSafeInteger(flow.已派卡) || flow.已派卡 < 0))
		fail("自动链已派卡计数损坏");
	if (flow.叫人 !== undefined && (typeof flow.叫人 !== "string" || !flow.叫人.trim())) fail("叫人记录损坏");
	if (flow.暂停 !== undefined && (typeof flow.暂停 !== "string" || !flow.暂停.trim())) fail("暂停记录损坏");
	if (flow.待决 !== undefined) {
		const problems = validatePending(flow.待决);
		if (problems.length > 0) fail(`控制清单待决损坏：${problems.join("；")}`);
		if (flow.待决.instance !== flow.实例) fail("待决 instance 与控制清单不一致");
		const node = flow.节点.find((candidate) => candidate.名字 === flow.待决!.node);
		if (!node || node.轮次 !== flow.待决.round) fail("待决 node/round 不属于当前控制节点");
		if (flow.待决.card_ref !== undefined) {
			let bound = false;
			try {
				bound = node.卡.some((ref) => parseCardRef(ref) === parseCardRef(flow.待决!.card_ref!));
			} catch {
				fail(`待决 card_ref 无效：${flow.待决.card_ref}`);
			}
			if (!bound) fail("待决 card_ref 不属于当前控制节点");
		}
	}
	if (flow.待决办理 !== undefined) {
		const problems = validatePendingResolutionRecords(flow.待决办理);
		if (problems.length > 0) fail(`控制清单待决办理记录损坏：${problems.join("；")}`);
		if (flow.待决办理.some((record) => record.instance !== flow.实例)) fail("待决办理记录 instance 与控制清单不一致");
	}
	if (flow.结果 !== undefined) {
		if (!Array.isArray(flow.结果)) fail("控制清单结果记录须为数组");
		for (const [index, result] of flow.结果.entries()) {
			if (
				!result ||
				typeof result !== "object" ||
				!["failed", "canceled", "stop_unconfirmed"].includes(String(result.state)) ||
				typeof result.reason !== "string" ||
				!result.reason.trim() ||
				typeof result.time !== "string" ||
				!Number.isFinite(Date.parse(result.time)) ||
				(result.pending_key !== undefined &&
					(typeof result.pending_key !== "string" || !result.pending_key.trim())) ||
				(result.writer_stop_confirmed !== undefined && typeof result.writer_stop_confirmed !== "boolean")
			)
				fail(`控制清单结果记录第 ${index + 1} 项损坏`);
		}
	}
	flow.冻结配方 = validated;
	return flow;
}
function saveControl(recipe: WorkflowRecipe, options: DriverOptions, flow: FlowControl): void {
	writeFileAtomic(
		controlPath(recipe, options),
		`---\n${stringify(flow)}---\n<!-- v2 流程控制正本，不得从卡重建或当缓存删除 -->\n`,
	);
}
function assertOwner(flow: FlowControl, options: DriverOptions): void {
	options.signal?.throwIfAborted();
	if (!options.ownerSessionId || options.ownerSessionId !== flow.owner)
		fail("owner 会话不匹配；恢复须显式核对现场并接管");
}
function cardStates(flow: FlowControl, node: NodeControl) {
	return node.卡.map((ref) => loadCard(flow.卡目录, parseCardRef(ref)));
}
function reviewVersionHold(flow: FlowControl, node: NodeControl, contentTree?: string): string | undefined {
	const decision = node.判定;
	if (decision?.结果 !== "pass" || node.放行修复) return undefined;
	if (currentPass(node, projectRootForCards(flow.卡目录), contentTree)) return undefined;
	if (contentTree === undefined) return "审核判定未核对：当前成果版本不可确认";
	if (!decision.projectRoot || !decision.contentTree) return "审核判定失效：旧判定没有成果版本证据，须重新独立验证";
	if (pathKey(resolve(decision.projectRoot)) !== pathKey(resolve(projectRootForCards(flow.卡目录))))
		return "审核判定失效：判定属于其他项目根，须在当前成果上重新独立验证";
	return "审核判定失效：成果内容已变化，须重新独立验证";
}
type ReviewEvidence =
	| { kind: "verified"; sourceTree: string; copyTree: string }
	| { kind: "unverified" }
	| { kind: "blocked"; reason: string };
async function reviewEvidence(
	card: ParsedCard,
	cardsDir: string,
	currentTree?: string,
	independentReview?: boolean,
): Promise<ReviewEvidence> {
	const hasCurrentExecutionEvidence = (attempt: number): boolean =>
		existsSync(executionContextPath({ cardsDir, cardNo: card.card_no, attempt })) ||
		existsSync(baselineSnapshotPath(cardsDir, card.card_no, attempt));
	const verdict = readLatestVerdict(card.body);
	if (independentReview !== true) {
		return verdict
			? { kind: "blocked", reason: "普通实施节点不能冒充独立审核的只读证据版本" }
			: { kind: "unverified" };
	}
	const hasReceiptEvidence = card.receipts.some(
		(receipt) => receipt.archive_flag === undefined && (receipt.evidence?.length ?? 0) > 0,
	);
	if (!verdict) {
		if (hasCurrentExecutionEvidence(card.frontmatter.attempt))
			return {
				kind: "blocked",
				reason: "当前尝试已有 execution-context 或基线，但缺少机械验收结论，不能降级为静态审核",
			};
		return hasReceiptEvidence && currentTree === undefined
			? { kind: "blocked", reason: "当前成果版本不可确认" }
			: { kind: "unverified" };
	}
	if (verdict.结论 === "未过" || verdict.结论 === "无法机械判")
		return { kind: "blocked", reason: `最近验收结论为“${verdict.结论}”` };
	const field = (name: string): string | undefined =>
		new RegExp(`^-\\s*${name}:\\s*(.+)$`, "m").exec(verdict.原文)?.[1]?.trim();
	const attempt = Number(field("尝试"));
	const beforeTree = field("检查前 tree");
	const afterTree = field("检查后 tree");
	if (!Number.isSafeInteger(attempt) || attempt !== card.frontmatter.attempt)
		return { kind: "blocked", reason: "最近验收不属于卡面当前尝试" };
	if (!beforeTree || !afterTree) {
		return hasCurrentExecutionEvidence(attempt)
			? { kind: "blocked", reason: "最近验收缺少当前尝试的检查前后 tree，不能降级为静态审核" }
			: { kind: "unverified" };
	}
	if (beforeTree !== afterTree) return { kind: "blocked", reason: "最近验收检查前后成果不一致" };
	if (currentTree === undefined) return { kind: "blocked", reason: "当前成果版本不可确认" };
	const executionRoot = field("执行根");
	const bindingDigest = field("关联摘要");
	if (!executionRoot && !bindingDigest)
		return hasCurrentExecutionEvidence(attempt)
			? {
					kind: "blocked",
					reason: "当前尝试已有 execution-context 或基线，但缺少执行根和关联摘要，不能降级为静态审核",
				}
			: { kind: "unverified" };
	if (!executionRoot || !bindingDigest || !field("仓库根") || !field("工作树摘要") || !field("输入快照"))
		return { kind: "blocked", reason: "最近验收的执行绑定字段不完整" };
	try {
		const key = {
			cardsDir,
			cardNo: card.card_no,
			attempt,
		};
		const binding = await resolveExecutionContext(key, {
			expectedCurrentAttempt: card.frontmatter.attempt,
			requireLiveExecutionRoot: true,
		});
		if (
			pathKey(resolve(binding.projectRoot)) !== pathKey(resolve(projectRootForCards(cardsDir))) ||
			pathKey(resolve(executionRoot)) !== pathKey(resolve(binding.executionRoot)) ||
			pathKey(resolve(field("仓库根")!)) !== pathKey(resolve(binding.repositoryRoot)) ||
			field("关联摘要") !== binding.bindingDigest ||
			field("工作树摘要") !== binding.worktree.bindingDigest ||
			field("输入快照") !== binding.snapshotDigest
		)
			return { kind: "blocked", reason: "最近验收与 execution-context 执行绑定不一致" };
		const baselinePath = baselineSnapshotPath(cardsDir, card.card_no, attempt);
		const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as {
			projectRoot?: unknown;
			executionRoot?: unknown;
			repositoryRoot?: unknown;
			bindingDigest?: unknown;
			snapshotDigest?: unknown;
			tree?: unknown;
		};
		if (
			typeof baseline.projectRoot !== "string" ||
			typeof baseline.executionRoot !== "string" ||
			typeof baseline.repositoryRoot !== "string" ||
			typeof baseline.bindingDigest !== "string" ||
			typeof baseline.snapshotDigest !== "string" ||
			typeof baseline.tree !== "string" ||
			pathKey(resolve(baseline.projectRoot)) !== pathKey(resolve(binding.projectRoot)) ||
			pathKey(resolve(baseline.executionRoot)) !== pathKey(resolve(binding.executionRoot)) ||
			pathKey(resolve(baseline.repositoryRoot)) !== pathKey(resolve(binding.repositoryRoot)) ||
			baseline.bindingDigest !== binding.bindingDigest ||
			baseline.snapshotDigest !== binding.snapshotDigest
		)
			return { kind: "blocked", reason: "最近验收的基线证据与 execution-context 不一致" };
		const receipt = currentAttemptReceipt(card);
		if (!receipt) return { kind: "blocked", reason: "独立审核缺少当前尝试回执" };
		const version = await verifyReviewEvidenceVersion({
			diff: await diffAgainstBaseline(baselinePath),
			declarations: receipt.changes?.map((change) => change.路径) ?? receipt.artifact_path ?? [],
			expectedCopyTree: afterTree,
			expectedCopyRoot: binding.canonicalExecutionRoot,
			expectedSourceTree: currentTree,
			projectRoot: binding.projectRoot,
		});
		return { kind: "verified", sourceTree: version.sourceTree, copyTree: version.copyTree };
	} catch (error) {
		return {
			kind: "blocked",
			reason: `最近验收的执行绑定不可核对（${error instanceof Error ? error.message : String(error)}）`,
		};
	}
}
async function reviewEvidenceHold(
	flow: FlowControl,
	node: NodeControl,
	decision: Decision,
	contentTree?: string,
	independentReview?: boolean,
): Promise<string | undefined> {
	if (decision.结果 !== "pass") return undefined;
	try {
		const states = await Promise.all(
			cardStates(flow, node).map((card) => reviewEvidence(card, flow.卡目录, contentTree, independentReview)),
		);
		if (!states.length && !decision.理由.includes("未验证运行"))
			return "零卡审核未运行验证；放行理由须明确未验证运行";
		const blocked = states.find((state) => state.kind === "blocked");
		if (blocked?.kind === "blocked") return `审核证据不可放行：${blocked.reason}`;
		if (states.some((state) => state.kind === "unverified") && !decision.理由.includes("未验证运行"))
			return "审核证据含未验证运行的卡；放行理由须明确未验证运行";
		const sources = new Set(states.filter((state) => state.kind === "verified").map((state) => state.sourceTree));
		if (sources.size > 1) return "审核证据不可放行：验证卡覆盖了多个原成果版本";
		if (sources.size === 1 && contentTree !== [...sources][0])
			return "审核证据不可放行：审核所依据的原成果与当前原项目不一致";
		return undefined;
	} catch (error) {
		return `审核证据不可核对（${error instanceof Error ? error.message : String(error)}）`;
	}
}
/**
 * owner 待裁决只从当前卡与当前 attempt 的有效回执派生，不新增持久状态。
 * 最近验收必须是同一 attempt 的「全过停人工审」；卡交付或返修换 attempt 后，
 * 条件自然失效，历史原因仍只留在既有「自动链停因」记录中。
 */
function ownerReviewPendingHold(
	flow: FlowControl,
	node: NodeControl,
	cards: readonly ParsedCard[],
): string | undefined {
	if (!node.拆解结束) return undefined;
	const pending = cards.flatMap((card) => {
		if (card.frontmatter.status !== "in_progress") return [];
		if (hasConflictingTerminalReceipts(card)) return [];
		const receipt = currentAttemptReceipt(card);
		if (!receipt) return [];
		const verdict = readLatestVerdict(card.body);
		if (verdict?.结论 !== "全过停人工审") return [];
		const attempt = Number(/^-\s*尝试:\s*(\d+)\s*$/m.exec(verdict.原文)?.[1]);
		if (attempt !== card.frontmatter.attempt) return [];
		const unmet = (Array.isArray(receipt.verification) ? receipt.verification : []).filter(
			(item) => item?.结论 === "fail" || item?.结论 === "not_run",
		);
		const held = latestWorkerReviewHeld(flow, node, card);
		return unmet.length > 0 || held ? [{ card, unmet }] : [];
	});
	if (pending.length === 0) return undefined;
	const summary = pending
		.map(
			({ card, unmet }) =>
				`${formatCardNumber(card.card_no)} 第 ${card.frontmatter.attempt} 次尝试${
					unmet.length > 0
						? `有 ${unmet.length} 条自报未达项（not_run ${unmet.filter((item) => item.结论 === "not_run").length}，fail ${unmet.filter((item) => item.结论 === "fail").length}）`
						: "的最新部长审核结论为 hold"
				}`,
		)
		.join("；");
	return `节点 ${node.名字}：${summary}，待 owner 裁决，不能自动交付；下一步：核对成果后经 pao_change_status 转 delivered，并按自报未达项填写 accepted_deviations；或由原部长调用 pao_minister_rework_cards 返修并重新执行。`;
}

/**
 * 当前 attempt 的最新工人审核结论必须完整匹配真实现场；后续同 attempt 的 pass
 * 自然覆盖较早 hold，旧授权不能继续放行。
 */
function latestWorkerReviewHeld(flow: FlowControl, node: NodeControl, card: ParsedCard): boolean {
	for (let index = flow.记录.length - 1; index >= 0; index--) {
		const record = flow.记录[index]!;
		if (record.事件 !== WORKFLOW_WORKER_REVIEW_RESULT_EVENT || record.节点 !== node.名字 || record.轮次 !== node.轮次)
			continue;
		let parsed: Record<string, unknown>;
		try {
			const value: unknown = JSON.parse(record.理由);
			if (!value || typeof value !== "object") continue;
			parsed = value as Record<string, unknown>;
		} catch {
			continue;
		}
		if (
			parsed.type === "worker-review-result" &&
			parsed.instance === flow.实例 &&
			parsed.node === node.名字 &&
			parsed.round === node.轮次 &&
			parsed.cardRef === formatCardNumber(card.card_no) &&
			parsed.attempt === card.frontmatter.attempt &&
			parsed.ministerSession === node.部长会话
		)
			return parsed.result === "hold";
	}
	return false;
}

/** 当前 attempt 的最新有效回执且最近机械验收为全过停审；自报未达或精确部长 hold 才可返修。 */
function reviewPendingOriginalInput(flow: FlowControl, node: NodeControl, card: ParsedCard): void {
	if (card.frontmatter.status !== "in_progress")
		throw new Error(`卡${formatCardNumber(card.card_no)}当前状态为 ${card.frontmatter.status}，不能按待审原卡返修`);
	if (hasConflictingTerminalReceipts(card))
		throw new Error(`卡${formatCardNumber(card.card_no)}当前 attempt 有互相冲突的未留档终结回执，不能返修`);
	const receipt = currentAttemptReceipt(card);
	if (!receipt)
		throw new Error(
			`卡${formatCardNumber(card.card_no)}缺少当前 attempt ${card.frontmatter.attempt} 的有效回执，不能返修`,
		);
	const verdict = readLatestVerdict(card.body);
	if (verdict?.结论 !== "全过停人工审")
		throw new Error(`卡${formatCardNumber(card.card_no)}最近机械验收不是“全过停人工审”，不能按待审原卡返修`);
	const attempt = Number(/^-\s*尝试:\s*(\d+)\s*$/m.exec(verdict.原文)?.[1]);
	if (attempt !== card.frontmatter.attempt)
		throw new Error(`卡${formatCardNumber(card.card_no)}最近机械验收不属于当前 attempt，不能返修`);
	const unmet = (receipt.verification ?? []).filter((item) => item.结论 === "fail" || item.结论 === "not_run");
	if (unmet.length === 0 && !latestWorkerReviewHeld(flow, node, card))
		throw new Error(`卡${formatCardNumber(card.card_no)}没有本轮自报未达项或精确部长 hold；只能由 owner 核对后交付`);
}

function currentPass(node: NodeControl, projectRoot: string, contentTree?: string): boolean {
	return (
		node.判定?.结果 === "pass" &&
		Boolean(node.判定.projectRoot) &&
		Boolean(node.判定.contentTree) &&
		pathKey(resolve(node.判定.projectRoot!)) === pathKey(resolve(projectRoot)) &&
		node.判定.contentTree === contentTree
	);
}
function complete(flow: FlowControl, node: NodeControl, projectRoot: string, contentTree?: string): boolean {
	const def = flow.冻结配方.节点.find((n) => n.名字 === node.名字)!;
	if (!node.拆解结束 || (!node.卡.length && !node.零卡理由)) return false;
	if (!cardStates(flow, node).every((card) => card.frontmatter.status === "delivered")) return false;
	if (def.审核 && !node.放行修复 && node.判定?.结果 !== "pass") return false;
	if (def.审核 && node.判定?.结果 === "pass" && !currentPass(node, projectRoot, contentTree)) return false;
	return !def.人工确认 || node.确认 !== undefined;
}
function ready(flow: FlowControl, node: NodeControl, projectRoot: string, contentTree?: string): boolean {
	return flow.冻结配方.节点
		.find((n) => n.名字 === node.名字)!
		.depends_on.every((dep) => complete(flow, flow.节点.find((n) => n.名字 === dep)!, projectRoot, contentTree));
}
/** 回包流状态反投持久面：清单/控制正本只存 运行中/挂起/已完成（§4.2 值随持久键同进退）。 */
function persistedStatus(status: DriveReport["status"]): FlowControl["状态"] {
	return status === "completed" ? "已完成" : status === "hold" ? "挂起" : "运行中";
}
/**
 * 桌面/状态视图信封（K4）：键名中文保留，节点状态值域单域英文（S10 单源化 2026-10-08）——
 * complete()＝delivered、有卡未完成＝in_progress、无卡＝no_card、坏卡透传卡面英文；
 * D5 持久正本（控制实例落盘中文状态）不动，只有此跨进程投影切英文。工具回包投影见 controlReport。
 * @param deadMinisters 已无热进程的部长会话标识集合（可选）：挂起文案据此把「等待部长本轮拆解结束」
 * 换成死绑定提示；不传（或集合不含该会话）时挂起文案与旧调用一致。说明 行恒含实例、owner、脉络与卡目录。
 */
export function controlView(
	flow: FlowControl,
	deadMinisters?: ReadonlySet<string>,
	contentTree?: string,
): {
	工作流: string;
	运行方式: ControlRunMode;
	状态: FlowControl["状态"];
	新建卡: DriveReport["created_cards"];
	节点: {
		名字: string;
		状态: CardStatus | "no_card" | "读取异常";
		卡号?: string;
		卡号列表: string[];
		轮次?: number;
		人工确认: boolean;
		已确认?: string;
		挂起?: string;
		/** 展示用并行元数据；只读投影，不改变当前调度。 */
		parallelGroupId?: string;
		branchId?: string;
		joinId?: string;
		/** 审核退回边，供运行图解释回到哪个上游节点。 */
		回边?: RecipeNode["回边"];
	}[];
	/** 当前停链原因；恢复后不清历史，历史看最近停链记录。 */
	停链原因?: string;
	/** 当前及历史停链记录；同一控制正本，不另建状态机。 */
	停链记录: ControlRecord[];
	/** 结构化待决正本的只读投影；控制回包从它生成停链摘要，不从暂停文案反解析。 */
	待决?: WorkflowPending;
	说明: string;
} {
	// 单次投影共享卡与依赖结果；坏卡只影响所在节点及其下游。
	const reads = new Map<string, { cards: readonly ParsedCard[]; error?: string }>(
		flow.节点.map((node) => {
			try {
				return [node.名字, { cards: cardStates(flow, node), error: undefined }] as const;
			} catch (error) {
				return [node.名字, { cards: [], error: error instanceof Error ? error.message : String(error) }] as const;
			}
		}),
	);
	const definitions = new Map(flow.冻结配方.节点.map((node) => [node.名字, node]));
	const ownerReviewHolds = new Map(
		flow.节点.map((node) => {
			const read = reads.get(node.名字)!;
			return [node.名字, read.error ? undefined : ownerReviewPendingHold(flow, node, read.cards)] as const;
		}),
	);
	const completion = new Map(
		flow.节点.map((node) => {
			const def = definitions.get(node.名字)!;
			const read = reads.get(node.名字)!;
			return [
				node.名字,
				!read.error &&
					node.拆解结束 &&
					!!(node.卡.length || node.零卡理由) &&
					read.cards.every((card) => card.frontmatter.status === "delivered") &&
					(!def.审核 || currentPass(node, projectRootForCards(flow.卡目录), contentTree) || !!node.放行修复) &&
					(!def.人工确认 || !!node.确认),
			] as const;
		}),
	);
	const nodes = flow.节点.map((node) => {
		const def = definitions.get(node.名字)!;
		const { cards, error } = reads.get(node.名字)!;
		const bad = cards.find((card) => ["failed", "canceled"].includes(card.frontmatter.status));
		const done = completion.get(node.名字)!;
		const reviewHold = def.审核 ? reviewVersionHold(flow, node, contentTree) : undefined;
		const pendingStop = flow.待决 ? pendingSummary(flow.待决) : undefined;
		const hold =
			(error ? `卡读取异常:${error}` : undefined) ??
			pendingStop ??
			flow.暂停 ??
			(bad
				? `卡 ${formatCardNumber(bad.card_no)} ${bad.frontmatter.status}`
				: !def.depends_on.every((dep) => completion.get(dep))
					? "等待前置节点"
					: !node.部长会话 && def.执行方式 !== "直接"
						? "等待部长会话绑定"
						: !node.拆解结束
							? def.执行方式 === "直接"
								? "等待直接任务建卡"
								: node.部长会话 && deadMinisters?.has(node.部长会话)
									? "部长会话已断开(绑定会话无热进程)；重推流将按同会话重开一轮，实例暂停则须人工恢复"
									: "等待部长本轮拆解结束"
							: (ownerReviewHolds.get(node.名字) ??
								(def.审核 && !node.判定 && (!node.放行修复 || !(node.卡.length || node.零卡理由))
									? "等待节点判定"
									: reviewHold
										? reviewHold
										: def.人工确认 && !node.确认
											? "等待人工确认"
											: undefined)));
		return {
			名字: node.名字,
			状态: error
				? ("读取异常" as const)
				: done
					? ("delivered" as const)
					: (bad?.frontmatter.status ?? (cards.length ? ("in_progress" as const) : ("no_card" as const))),
			卡号: node.卡[0],
			卡号列表: [...node.卡],
			轮次: node.轮次,
			人工确认: def.人工确认,
			已确认: node.确认,
			挂起: hold,
			...(def.parallelGroupId !== undefined ? { parallelGroupId: def.parallelGroupId } : {}),
			...(def.branchId !== undefined ? { branchId: def.branchId } : {}),
			...(def.joinId !== undefined ? { joinId: def.joinId } : {}),
			...(def.回边 !== undefined && def.回边.length > 0 ? { 回边: def.回边 } : {}),
		};
	});
	const allDone = flow.节点.length > 0 && [...completion.values()].every(Boolean);
	const stoppedBelow = [...nodes].reverse().find((node) => node.挂起)?.挂起;
	const ownerReviewStop = [...nodes]
		.reverse()
		.find((node) => node.挂起 && node.挂起 === ownerReviewHolds.get(node.名字))?.挂起;
	const pendingStop = flow.待决 ? pendingSummary(flow.待决) : undefined;
	const stopReason =
		pendingStop ??
		flow.暂停 ??
		(nodes.some((node) => node.状态 === "failed" || node.状态 === "canceled" || node.状态 === "读取异常")
			? stoppedBelow
			: ownerReviewStop);
	return {
		工作流: flow.工作流,
		运行方式: storedControlRunMode(flow.运行方式),
		状态:
			flow.暂停 || pendingStop
				? "挂起"
				: allDone
					? "已完成"
					: nodes.some((n) => n.状态 === "failed" || n.状态 === "canceled" || n.状态 === "读取异常") ||
							ownerReviewStop !== undefined
						? "挂起"
						: "运行中",
		新建卡: [],
		节点: nodes,
		...(stopReason ? { 停链原因: stopReason } : {}),
		停链记录: flow.记录.filter((record) => record.事件 === "自动链停因"),
		...(flow.待决 ? { 待决: structuredClone(flow.待决) } : {}),
		说明: `实例 ${flow.实例}；owner ${flow.owner}；脉络 ${flow.脉络}；卡目录 ${flow.卡目录}${flow.节点.some((n) => n.放行修复) ? "；按配置放行，仍有未解决项" : ""}`,
	};
}

/** 工具回包投影（定名表 D5：读时投影，单向不回写）：持久视图 controlView → 英文 DriveReport。 */
export function controlReport(
	flow: FlowControl,
	deadMinisters?: ReadonlySet<string>,
	contentTree?: string,
): DriveReport {
	const view = controlView(flow, deadMinisters, contentTree);
	return reportFromView(view);
}
function reportFromView(view: ReturnType<typeof controlView>): DriveReport {
	return {
		workflow: view.工作流,
		run_mode: displayRunMode(view.运行方式),
		status: view.状态 === "已完成" ? "completed" : view.状态 === "挂起" ? "hold" : "running",
		created_cards: view.新建卡,
		nodes: view.节点.map((node) => ({
			name: node.名字,
			status: node.状态, // 单域英文（S10 单源化），直通不再翻译
			card_no: node.卡号,
			card_refs: node.卡号列表,
			round: node.轮次,
			manual_confirm: node.人工确认,
			confirmed: node.已确认,
			hold: node.挂起,
			parallel_group_id: node.parallelGroupId,
			branch_id: node.branchId,
			join_id: node.joinId,
			review_edges: node.回边?.map((edge) => ({
				target: edge.目标,
				limit: edge.上限,
				overflow_action: edge.超限动作,
			})),
		})),
		stop_reason: view.停链原因,
		stop_history: view.停链记录,
		...(view.待决
			? {
					pending_key: view.待决.key,
					pending_item_refs: view.待决.items.map((item) => item.item_ref),
				}
			: {}),
		note: view.说明,
	};
}
async function mutate<T>(
	recipe: WorkflowRecipe,
	options: DriverOptions,
	fn: (flow: FlowControl) => Promise<T> | T,
): Promise<T> {
	return withFileLock(controlPath(recipe, options), async () => {
		const flow = readControl(recipe, options);
		assertOwner(flow, options);
		const result = await fn(flow);
		// 显式暂停不依赖项目仍可读取；即使 Git/执行目录丢失，也必须能保存停止意图。
		// 已持控制锁时不能再走异步读面，否则同进程会等待自己持有的锁。
		const contentTree = flow.暂停
			? undefined
			: await currentContentTree(
					options,
					flow.节点.some((node) => node.判定?.结果 === "pass" || node.放行修复),
				);
		flow.状态 = persistedStatus(controlReport(flow, undefined, contentTree).status);
		saveControl(recipe, options, flow);
		return result;
	});
}
export async function startControl(
	recipe: WorkflowRecipe,
	params: Record<string, string>,
	options: DriverOptions,
): Promise<DriveReport> {
	if (recipe.版本 !== 2 || !options.ownerSessionId?.trim()) fail("启动 v2 须有版本 2 配方和真实 owner 会话 ID");
	const split = splitControlRunModeParams(params);
	const runMode = resolveControlRunMode(split.requested, options.runMode ?? "attended");
	try {
		assertRunModeAllowsRecipeGates(recipe.节点, runMode);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
	requireParams(recipe, split.params);
	const frozen = structuredClone(recipe);
	for (const node of frozen.节点) {
		for (const key of ["部门", "目标", "验收", "约束", "模型", "思考强度", "部门标准"] as const)
			if (node[key] !== undefined) node[key] = substituteParams(node[key]!, split.params);
		if (node.输入) node.输入 = node.输入.map((value) => substituteParams(value, split.params));
		if (node.技能) node.技能 = node.技能.map((value) => substituteParams(value, split.params));
	}
	mkdirSync(dirname(controlPath(recipe, options)), { recursive: true });
	// 建实例即保证卡目录真实存在：0 落卡的实例也须有真目录，读面（桌面 realpath 校验）才不炸；
	// 不可建（盘满/权限）按本函数失败口径报中文，不裸抛 ENOENT/EACCES
	try {
		mkdirSync(resolve(options.cardsDir), { recursive: true });
	} catch (error) {
		fail(`卡目录不可建(${resolve(options.cardsDir)}):${error instanceof Error ? error.message : String(error)}`);
	}
	return withFileLock(controlPath(recipe, options), async () => {
		options.signal?.throwIfAborted();
		if (existsSync(controlPath(recipe, options))) fail("实例已存在；保留原件，禁止隐式重启覆盖");
		const id = randomUUID();
		const flow: FlowControl = {
			版本: 2,
			实例: id,
			owner: options.ownerSessionId!,
			脉络: id,
			工作流: recipe.名字,
			卡目录: resolve(options.cardsDir),
			启动: new Date().toISOString(),
			状态: "运行中",
			冻结配方: frozen,
			参数: { ...split.params },
			运行方式: runMode,
			节点: recipe.节点.map((node) => ({ 名字: node.名字, 轮次: 1, 卡: [], 拆解结束: false, 历史: [] })),
			回边次数: {},
			记录: [],
		};
		saveControl(recipe, options, flow);
		return controlReport(flow);
	});
}
export async function tickControl(recipe: WorkflowRecipe, options: DriverOptions): Promise<DriveReport> {
	const tree = await currentContentTree(
		options,
		readControl(recipe, options).节点.some((node) => node.判定?.结果 === "pass" || node.放行修复),
	);
	return mutate(recipe, options, (flow) => controlReport(flow, undefined, tree));
}
function identify(
	flow: FlowControl,
	identity: NodeIdentity,
	contentTree?: string,
	allowExistingPending = false,
): NodeControl {
	const node = flow.节点.find((n) => n.名字 === identity.节点);
	if (
		identity.实例 !== flow.实例 ||
		!node ||
		identity.轮次 !== node.轮次 ||
		!identity.部长会话 ||
		identity.部长会话 !== node.部长会话
	)
		fail("旧轮次、错误实例或部长会话；拒绝推进当前节点");
	if ((!allowExistingPending && flow.暂停) || !ready(flow, node, projectRootForCards(flow.卡目录), contentTree))
		fail("实例已暂停或前置未完成");
	return node;
}
async function captureNodeBaseline(node: NodeControl, options: DriverOptions, flow: FlowControl): Promise<void> {
	if (!node.基线 && !node.基线错误) {
		const cwd = projectRootForCards(options.cardsDir);
		const root = await gitOutput(["rev-parse", "--show-toplevel"], cwd);
		if (root.code !== 0) node.基线错误 = `非 git 项目或 git 不可用:${root.error}`;
		else {
			const snapshot = await captureContentTree(cwd, options.signal, false, false).then(
				(captured) => ({ code: 0, text: captured.tree, error: "" }),
				(error: unknown) => ({
					code: 1,
					text: "",
					error: error instanceof Error ? error.message : String(error),
				}),
			);
			const head = await gitOutput(["rev-parse", "HEAD"], cwd);
			const untracked = await gitOutput(
				["ls-files", "--others", "--exclude-standard", "-z", "--", ...PROJECT_CONTENT_PATHSPECS],
				cwd,
			);
			if (snapshot.code !== 0 || head.code !== 0 || untracked.code !== 0)
				node.基线错误 = `无法固定 git 内容基线:${snapshot.error || head.error || untracked.error}`;
			else {
				node.基线 = {
					项目根: cwd,
					提交: snapshot.text.trim() || head.text.trim(),
					未跟踪: untracked.text.split("\0").filter(Boolean),
				};
				const pinned = await gitOutput(
					["update-ref", `refs/pao-workflow/${flow.实例}/${flow.节点.indexOf(node)}-${node.轮次}`, node.基线.提交],
					cwd,
				);
				if (pinned.code !== 0) {
					node.基线错误 = `基线无法保留:${pinned.error}`;
					node.基线 = undefined;
				}
			}
		}
	}
}
export async function bindMinister(
	recipe: WorkflowRecipe,
	options: DriverOptions,
	nodeName: string,
	session: string,
): Promise<string> {
	const contentTree = await currentContentTree(
		options,
		readControl(recipe, options).节点.some((node) => node.判定?.结果 === "pass" || node.放行修复),
	);
	return mutate(recipe, options, async (flow) => {
		const node = flow.节点.find((n) => n.名字 === nodeName);
		if (flow.冻结配方.节点.find((n) => n.名字 === nodeName)?.执行方式 === "直接") fail("直接节点不启动部长");
		if (!node || !session.trim() || !ready(flow, node, projectRootForCards(flow.卡目录), contentTree) || flow.暂停)
			fail("节点未就绪或部长会话为空");
		if (node.部长会话 && node.部长会话 !== session) fail("已绑定其他部长；须恢复操作明确接管");
		node.部长会话 = session;
		await captureNodeBaseline(node, options, flow);
		const def = flow.冻结配方.节点.find((n) => n.名字 === nodeName)!;
		return [
			`实例:${flow.实例}`,
			`脉络:${flow.脉络}`,
			`节点:${nodeName}`,
			`轮次:${node.轮次}`,
			`目标:${def.目标}`,
			`验收:${def.验收}`,
			`输入:${(def.输入 ?? []).join("\n")}`,
			`范围与约束:${def.约束 ?? "未指定"}`,
			`每卡预算:${def.预算 ? JSON.stringify(def.预算) : "未配置；须遵守现场共享授权"}；待拆卡数未知，不编造总费用`,
			`技能:${(def.技能 ?? []).join("、") || "未额外挂载"}`,
			`部门标准:${def.部门标准 ?? "非审核节点"}`,
			`工人并发上限:${def.工人数量 ?? 1}`,
			`在途:${cardStates(flow, node).filter((c) => c.frontmatter.status === "in_progress").length}`,
			`排队:${cardStates(flow, node).filter((c) => c.frontmatter.status === "unclaimed").length}`,
			`模型:${node.轮次 > 3 ? "主力（原档重做两次后升级）" : (def.模型 ?? def.档位 ?? "部门默认")}`,
			`思考强度:${def.思考强度 ?? "档位默认"}`,
			node.重做理由 ? `重做理由:${node.重做理由}` : "",
			def.只读
				? def.审核
					? "独立审核节点：可交验证工人卡；验证卡只派到受管副本，检查业务只读，临时生成物只可写副本。部长只规划和判断，不直接执行 shell。"
					: "只读规划节点：禁止交工人卡；使用只读工具完成检查，说明零卡理由并结束拆解。"
				: "请分批交卡，最后显式交拆解结束；审核节点还须提交双轴判定。",
		]
			.filter(Boolean)
			.join("\n");
	});
}
async function createNodeCards(
	recipe: WorkflowRecipe,
	options: DriverOptions,
	flow: FlowControl,
	node: NodeControl,
	inputs: NodeCardInput[],
): Promise<string[]> {
	if (node.拆解结束 || !inputs.length) fail("拆解已结束或本批没有卡");
	const def = flow.冻结配方.节点.find((n) => n.名字 === node.名字)!;
	if (def.只读 && !def.审核) fail("只读规划节点不能派工或写项目；独立审核节点的验证卡须走受管副本");
	const tracked = new Set(
		flow.节点.flatMap((n) => [...n.卡, ...n.历史.flatMap((round) => round.卡)]).map(parseCardRef),
	);
	const orphan = listCards(options.cardsDir).filter(
		(card) => card.body.includes(`<!-- pao-workflow-v2:实例=${flow.实例}/`) && !tracked.has(card.card_no),
	);
	if (orphan.length)
		fail(
			`发现未登记的工作流卡 ${orphan.map((card) => formatCardNumber(card.card_no)).join("、")}；可能是控制保存中断，保留卡和控制原件，人工核对后再交卡`,
		);
	// 整批先核最终文本，任一条非法时不发号、不留下半批正式卡。
	const projectRoot = projectRootForCards(options.cardsDir);
	const prepared = inputs.map((input) => ({
		input,
		goal: substituteParams(input.goal, flow.参数),
		acceptance: substituteParams(input.acceptance, flow.参数),
		inputs: [
			...(def.输入 ?? []),
			...(input.inputs ?? []),
			...(node.重做理由 ? [`本轮重做理由:${node.重做理由}`] : []),
		].map((value) => substituteParams(value, flow.参数)),
		constraints: [def.约束, input.constraints]
			.filter((value): value is string => Boolean(value))
			.map((value) => substituteParams(value, flow.参数))
			.join("\n"),
	}));
	for (const card of prepared) {
		validateAcceptance(card.acceptance, projectRoot);
		validateLegacyInputReferences(projectRoot, card.inputs);
	}
	const added: string[] = [];
	for (const card of prepared) {
		options.signal?.throwIfAborted();
		const created = await createCard(
			options.cardsDir,
			{
				...card.input,
				部门: def.部门,
				目标: card.goal,
				验收: card.acceptance,
				输入: card.inputs,
				约束: card.constraints,
				档位: node.轮次 > 3 ? "primary" : def.档位,
				预算: card.input.budget ?? def.预算,
				depends_on: def.depends_on.flatMap((name) => flow.节点.find((n) => n.名字 === name)!.卡),
				创建: options.now?.() ?? nowString(),
			},
			{
				counterPath: options.counterPath,
				signal: options.signal,
				模板正文: `<!-- pao-workflow:流=${recipe.名字}/节点=${node.名字} -->\n<!-- pao-workflow-v2:实例=${flow.实例}/轮次=${node.轮次} -->`,
			},
		);
		const ref = formatCardNumber(created.card_no);
		node.卡.push(ref);
		// 卡及完整归属已原子写入，再保存控制映射；失败留下的孤儿卡仍受工作流派发检查保护。
		saveControl(recipe, options, flow);
		added.push(ref);
	}
	return added;
}

/** 直接节点没有部长身份；在原控制锁内落一张卡并结束编排，重复推进只复用映射。 */
export async function prepareDirectNode(
	recipe: WorkflowRecipe,
	options: DriverOptions,
	nodeName: string,
): Promise<void> {
	const tree = await currentContentTree(
		options,
		readControl(recipe, options).节点.some((node) => node.判定?.结果 === "pass" || node.放行修复),
	);
	await mutate(recipe, options, async (flow) => {
		const node = flow.节点.find((candidate) => candidate.名字 === nodeName);
		const def = flow.冻结配方.节点.find((candidate) => candidate.名字 === nodeName);
		if (!node || def?.执行方式 !== "直接" || def.只读 || def.审核) fail("不是可直接执行的节点");
		if (flow.暂停 || !ready(flow, node, projectRootForCards(flow.卡目录), tree)) fail("实例已暂停或前置未完成");
		if (node.部长会话) fail("直接节点不能冒用部长会话");
		if (node.拆解结束) return;
		await captureNodeBaseline(node, options, flow);
		if (!node.卡.length)
			await createNodeCards(recipe, options, flow, node, [{ goal: def.目标, acceptance: def.验收 }]);
		if (node.卡.length !== 1) fail("直接节点卡映射异常，保留现场核查");
		node.拆解结束 = true;
	});
}
export async function addNodeCards(
	recipe: WorkflowRecipe,
	options: DriverOptions,
	identity: NodeIdentity,
	inputs: NodeCardInput[],
): Promise<string[]> {
	const contentTree = await currentContentTree(
		options,
		readControl(recipe, options).节点.some((node) => node.判定?.结果 === "pass" || node.放行修复),
	);
	return mutate(recipe, options, async (flow) => {
		const node = identify(flow, identity, contentTree);
		return createNodeCards(recipe, options, flow, node, inputs);
	});
}
export async function endDecomposition(
	recipe: WorkflowRecipe,
	options: DriverOptions,
	identity: NodeIdentity,
	zeroReason?: string,
): Promise<void> {
	const contentTree = await currentContentTree(
		options,
		readControl(recipe, options).节点.some((node) => node.判定?.结果 === "pass" || node.放行修复),
	);
	await mutate(recipe, options, async (flow) => {
		const node = identify(flow, identity, contentTree);
		if (!node.卡.length && !zeroReason?.trim()) fail("零卡结束必须说明理由，禁止意外空完成");
		const def = flow.冻结配方.节点.find((candidate) => candidate.名字 === node.名字)!;
		if (def.只读 && requiresDispatchMapHandoff(flow, node.名字)) {
			const record = flow.记录.findLast(
				(entry) => entry.事件 === WORKFLOW_NODE_MAP_EVENT && entry.节点 === node.名字 && entry.轮次 === node.轮次,
			);
			const ref = record ? parseDispatchUri(record.理由).canonical : undefined;
			const artifact = ref ? loadDispatchMapArtifact(ref, { cardsDir: options.cardsDir }) : undefined;
			assertDispatchMapHandoff(artifact, {
				stage: "complete",
				required: true,
				...(ref ? { ref } : {}),
				node: node.名字,
			});
		}
		node.拆解结束 = true;
		node.零卡理由 = zeroReason;
	});
}
export async function decideNode(
	recipe: WorkflowRecipe,
	options: DriverOptions,
	identity: NodeIdentity,
	decision: Omit<Decision, "时间">,
	requestedRuling: false | "主控" | "人工" = false,
): Promise<void> {
	const rulingStart = requestedRuling ? readControl(recipe, options) : undefined;
	const initialTree = await currentContentTree(options, decision.结果 === "pass");
	await mutate(recipe, options, async (flow) => {
		const contentTree = decision.结果 === "pass" ? initialTree : undefined;
		if (decision.结果 === "pass") {
			const lockedTree = await currentContentTree(options, true);
			if (initialTree !== lockedTree) fail("判定期间成果内容发生变化，须重新核验");
		}
		const node = flow.节点.find((candidate) => candidate.名字 === identity.节点);
		const def = flow.冻结配方.节点.find((candidate) => candidate.名字 === identity.节点);
		if (
			!node ||
			!def ||
			flow.实例 !== identity.实例 ||
			node.轮次 !== identity.轮次 ||
			!identity.部长会话 ||
			node.部长会话 !== identity.部长会话
		)
			fail("旧轮次、错误实例或部长会话；拒绝推进当前节点");
		if (!["pass", "change", "reject"].includes(decision.结果)) fail("result 须为 pass/change/reject");
		const fieldProblems = decisionFieldProblems({ reason: decision.理由, references: decision.引用 });
		if (fieldProblems.length) fail(formatDecisionFieldProblems(fieldProblems));
		if (decision.结果 !== "pass" && !["card", "dept_standard", "both"].includes(decision.失败轴 ?? ""))
			fail("打回或拒绝须标明失败轴");
		if (requestedRuling) {
			if (
				flow.裁定?.通道 !== requestedRuling ||
				flow.裁定.节点 !== identity.节点 ||
				flow.裁定.轮次 !== identity.轮次 ||
				!rulingStart ||
				JSON.stringify(rulingStart.裁定) !== JSON.stringify(flow.裁定)
			)
				fail(`没有匹配的${requestedRuling}裁定请求`);
			if (flow.暂停 !== `等待${requestedRuling}裁定:${flow.裁定.理由}`)
				fail(`当前暂停不是等待${requestedRuling}裁定；不能借裁定绕过人工门`);
			if (!def.审核) {
				if (
					!node.拆解结束 ||
					!cardStates(flow, node).every((card) => card.frontmatter.status === "delivered") ||
					hasStartedDescendant(flow, node)
				)
					fail("普通执行节点裁定须在拆解结束、全部卡机械交付且下游尚未启动后记录");
				if (!ready(flow, node, projectRootForCards(flow.卡目录), contentTree))
					fail("普通执行节点裁定须在前置节点完成后记录");
				const stamp = new Date().toISOString();
				flow.记录.push(
					{
						时间: stamp,
						事件: `${requestedRuling}裁定`,
						节点: identity.节点,
						轮次: identity.轮次,
						理由: `${decision.理由}；处理结果：${decision.结果}`,
					},
					{
						时间: stamp,
						事件: "自动链停因",
						节点: identity.节点,
						轮次: identity.轮次,
						理由: `收到匹配的${requestedRuling}裁定，下一轮按真实卡状态继续`,
					},
				);
				flow.裁定 = undefined;
				flow.待决 = undefined;
				flow.暂停 =
					decision.结果 === "reject"
						? `${requestedRuling}裁定拒绝:${decision.理由}`
						: decision.结果 === "change"
							? `${requestedRuling}裁定要求修改:${decision.理由}`
							: undefined;
				return;
			}
		}
		const releaseRulingPause =
			requestedRuling &&
			flow.裁定?.通道 === requestedRuling &&
			flow.裁定.节点 === node.名字 &&
			flow.裁定.轮次 === node.轮次 &&
			flow.暂停 === `等待${requestedRuling}裁定:${flow.裁定.理由}`;
		if ((flow.暂停 && !releaseRulingPause) || !ready(flow, node, projectRootForCards(flow.卡目录), contentTree))
			fail("实例已暂停或前置未完成");
		if (!def.审核 || !node.拆解结束 || !cardStates(flow, node).every((c) => c.frontmatter.status === "delivered"))
			fail("审核判定须在拆解结束且全部卡机械交付后");
		if (requestedRuling) {
			flow.记录.push({
				时间: new Date().toISOString(),
				事件: `${requestedRuling}裁定`,
				节点: identity.节点,
				轮次: identity.轮次,
				理由: decision.理由,
			});
			flow.暂停 = undefined;
			flow.裁定 = undefined;
			flow.待决 = undefined;
		}
		if (node.判定) {
			if (node.判定.结果 !== "pass" || !def.审核) fail("本轮已判定，拒绝重复决定");
			if (currentPass(node, projectRootForCards(options.cardsDir), contentTree))
				fail("本轮已有同一成果版本的通过判定，拒绝重复决定");
			flow.记录.push({
				时间: new Date().toISOString(),
				事件: "审核判定失效",
				节点: node.名字,
				轮次: node.轮次,
				理由: node.判定.contentTree
					? "成果内容树已变化；旧通过判定不再放行，须重新独立验证"
					: "旧通过判定没有成果版本证据；按失效处理，须重新独立验证",
			});
			node.判定 = undefined;
		}
		if (
			decision.建议 !== undefined &&
			(!Array.isArray(decision.建议) || decision.建议.some((item) => typeof item !== "string" || !item.trim()))
		)
			fail("改进建议须为非空文本列表；不自动扩大原任务验收范围");
		const evidenceHold = await reviewEvidenceHold(
			flow,
			node,
			{ ...decision, 时间: new Date().toISOString() },
			contentTree,
			def.只读 === true && def.审核 === true,
		);
		if (evidenceHold) fail(evidenceHold);
		const stamp = new Date().toISOString();
		node.判定 = {
			...decision,
			时间: stamp,
			...(decision.结果 === "pass" ? { projectRoot: projectRootForCards(options.cardsDir), contentTree } : {}),
		};
		flow.记录.push({ 时间: stamp, 事件: decision.结果, 节点: node.名字, 轮次: node.轮次, 理由: decision.理由 });
		if (decision.结果 === "reject") {
			flow.暂停 = `审核拒绝:${decision.理由}`;
			return;
		}
		if (decision.结果 !== "change") return;
		applyReviewBackEdge(flow, node, def, decision, stamp, options);
	});
}

function applyReviewBackEdge(
	flow: FlowControl,
	node: NodeControl,
	def: RecipeNode,
	decision: Omit<Decision, "时间">,
	timestamp: string,
	options: DriverOptions,
): void {
	const edge = def.回边?.find((e) => e.目标 === decision.目标);
	if (!edge) fail("打回目标没有声明回边");
	const key = `${node.名字}→${edge.目标}`;
	const count = (flow.回边次数[key] ?? 0) + 1;
	flow.回边次数[key] = count;
	const exceeded = edge.上限 !== 0 && count > edge.上限;
	if (exceeded && edge.超限动作 === "停滞") {
		flow.暂停 = `回边 ${key} 超限 ${edge.上限}:${decision.理由}`;
		return;
	}
	const affected = descendantNodeNames(flow, edge.目标);
	if (
		flow.节点.some(
			(n) => affected.has(n.名字) && cardStates(flow, n).some((c) => c.frontmatter.status === "in_progress"),
		)
	)
		fail("受影响下游仍有在途卡；先取消并确认停止，再打回");
	const targets = flow.节点.filter((n) => affected.has(n.名字));
	const repairs = targets.filter(
		(target) =>
			flow.冻结配方.节点.find((def) => def.名字 === target.名字)?.执行方式 !== undefined && target.卡.length > 0,
	);
	// 返修涉及多文件：先持久化暂停，任何中断都保留现场，不能以半更新控制清单继续派发。
	if (repairs.length) {
		flow.暂停 = "审核返修正在更新原卡；更新中断须核查现场后显式恢复";
		saveControl(flow.冻结配方, options, flow);
		for (const target of repairs) {
			for (const card of cardStates(flow, target)) {
				reopenForReview({
					card,
					operator: card.frontmatter.owner ?? "",
					reason: decision.理由,
					time: timestamp,
					oldMarker: `<!-- pao-workflow-v2:实例=${flow.实例}/轮次=${target.轮次} -->`,
					newMarker: `<!-- pao-workflow-v2:实例=${flow.实例}/轮次=${target.轮次 + 1} -->`,
				});
			}
		}
	}
	for (const target of targets) {
		// 被打回目标的旧轮记审核方本次判定，其余下游保留各自原判定。
		const refs = repairs.includes(target) ? [...target.卡] : [];
		const baseline = target.基线;
		const baselineError = target.基线错误;
		resetNodeRound(target, decision.理由, target.名字 === edge.目标 ? { ...decision, 时间: timestamp } : target.判定);
		if (refs.length) {
			target.卡 = refs;
			target.拆解结束 = true;
			// 原任务累计 diff 继续参照初始基线；本次写操作另由新尝试认领基线核对。
			target.基线 = baseline;
			target.基线错误 = baselineError;
		}
		target.放行修复 = exceeded && target.名字 === node.名字;
	}
	if (repairs.length) {
		flow.暂停 = undefined;
	}
}

function descendantNodeNames(flow: FlowControl, name: string): Set<string> {
	const affected = new Set([name]);
	for (const candidate of flow.冻结配方.拓扑序)
		if (flow.冻结配方.节点.find((node) => node.名字 === candidate)!.depends_on.some((dep) => affected.has(dep)))
			affected.add(candidate);
	return affected;
}

function hasStartedDescendant(flow: FlowControl, node: NodeControl): boolean {
	const affected = descendantNodeNames(flow, node.名字);
	return flow.节点.some(
		(candidate) =>
			candidate !== node &&
			affected.has(candidate.名字) &&
			Boolean(
				candidate.部长会话 ||
					candidate.卡.length ||
					candidate.历史.length ||
					candidate.拆解结束 ||
					candidate.判定 ||
					candidate.确认,
			),
	);
}

function receiptConflict(card: ParsedCard): boolean {
	const receipts = card.receipts.filter(
		(receipt) => !receipt.archive_flag && receipt.attempt >= card.frontmatter.attempt,
	);
	return (
		hasConflictingTerminalReceipts(card) ||
		receipts.some((receipt) => receipt.attempt > card.frontmatter.attempt || card.frontmatter.status === "unclaimed")
	);
}

function activeWorkerForCards(
	flow: FlowControl,
	cards: readonly ParsedCard[],
	processes: () => readonly ProcessEntry[] = () => [],
): boolean {
	return processes().some(
		(entry) =>
			entry.running &&
			cards.some((card) =>
				entry.card_path
					? canonical(entry.card_path) === canonical(card.path)
					: /^(?:卡)?\d+$/.test(entry.card_no) &&
						parseCardRef(entry.card_no) === card.card_no &&
						(!entry.task_root || canonical(entry.task_root) === canonical(dirname(flow.卡目录))),
			),
	);
}

/** 回边和显式恢复共用历史与重置规则，旧卡始终保留。 */
function resetNodeRound(node: NodeControl, reason: string, decision = node.判定): void {
	node.历史.push({ 轮次: node.轮次, 卡: [...node.卡], 判定: decision, 原因: reason });
	node.轮次++;
	node.卡 = [];
	node.拆解结束 = false;
	node.确认 = undefined;
	node.判定 = undefined;
	node.零卡理由 = undefined;
	node.基线 = undefined;
	node.基线错误 = undefined;
	node.重做理由 = reason;
	node.放行修复 = undefined;
}

/** 常规质量返工：只走声明回边并复用判定/轮次重置规则；人工确认、暂停和裁定门不在这里清除。 */
export async function reworkControl(
	recipe: WorkflowRecipe,
	options: DriverOptions,
	identity: NodeIdentity,
	reason: string,
	target: string,
	processes: () => readonly ProcessEntry[] = () => [],
): Promise<void> {
	const contentTree = await currentContentTree(
		options,
		readControl(recipe, options).节点.some((node) => node.判定?.结果 === "pass" || node.放行修复),
	);
	await withFileLock(`${controlPath(recipe, options)}.dispatch`, () =>
		mutate(recipe, options, (flow) => {
			const node = identify(flow, identity, contentTree);
			const def = flow.冻结配方.节点.find((n) => n.名字 === node.名字)!;
			if (!def.审核 || !reason.trim()) fail("常规质量返工只适用于审核节点，且须给出理由");
			if (flow.裁定) fail("仍有待处理裁定；先通过 rule 完成裁定，不能以返工绕过");
			if (flow.暂停) fail("实例已暂停；须人工恢复后才能返工");
			if (!node.拆解结束 || !cardStates(flow, node).every((card) => card.frontmatter.status === "delivered"))
				fail("常规质量返工须在全部审核卡交付后");
			if (!node.判定) fail("质量返工须有独立审核判定，不能凭主控自报绕过审核");
			const affected = descendantNodeNames(flow, target);
			const activeCards = flow.节点
				.filter((candidate) => affected.has(candidate.名字))
				.flatMap((candidate) => cardStates(flow, candidate));
			if (activeCards.some((card) => card.frontmatter.status === "in_progress"))
				fail("受影响范围仍有在途卡；先确认停止，再返工");
			if (activeWorkerForCards(flow, activeCards, processes))
				fail("受影响范围仍有登记中的活工人；先终止并确认停止，再返工");
			const oldRound = node.轮次;
			applyReviewBackEdge(
				flow,
				node,
				def,
				{ 结果: "change", 理由: reason, 失败轴: "card", 引用: node.判定.引用, 目标: target },
				new Date().toISOString(),
				options,
			);
			flow.记录.push({
				时间: new Date().toISOString(),
				事件: "常规质量返工",
				节点: node.名字,
				轮次: oldRound,
				理由: `${reason}（回边目标：${target}）`,
			});
		}),
	);
}

/** 原实例当前节点受控重开；调用方负责人工确认，锁内重核身份和实时进程。 */
export async function reopenControl(
	recipe: WorkflowRecipe,
	options: DriverOptions,
	input: { 实例: string; 原owner: string; 节点: string; 轮次: number; 现场核查: string },
	processes: () => readonly ProcessEntry[],
): Promise<void> {
	await withFileLock(`${controlPath(recipe, options)}.dispatch`, () =>
		mutate(recipe, options, async (flow) => {
			options.signal?.throwIfAborted();
			const node = flow.节点.find((candidate) => candidate.名字 === input.节点);
			if (
				flow.实例 !== input.实例 ||
				flow.owner !== input.原owner ||
				!node ||
				node.轮次 !== input.轮次 ||
				!input.现场核查.trim()
			)
				fail("重开身份、轮次不符或缺现场核查；先用 pao_query_flow 核对 instance、prev_owner、node、round");
			const contentTree = await currentContentTree(
				options,
				readControl(recipe, options).节点.some((node) => node.判定?.结果 === "pass" || node.放行修复),
			);
			if (flow.状态 === "已完成" || complete(flow, node, projectRootForCards(options.cardsDir), contentTree))
				fail("节点或实例已完成，不能作为故障恢复重派");
			if (!node.拆解结束 || !ready(flow, node, projectRootForCards(options.cardsDir), contentTree))
				fail("仅能重开前置已完成且拆解已结束的当前节点；未结束拆解请推流恢复原部长");
			if (flow.裁定) fail("仍有待处理裁定；先通过 rule 完成裁定，不能以重开绕过");
			const affected = descendantNodeNames(flow, node.名字);
			if (
				flow.节点.some(
					(candidate) =>
						candidate !== node &&
						affected.has(candidate.名字) &&
						(candidate.部长会话 || candidate.卡.length || candidate.拆解结束 || candidate.判定 || candidate.确认),
				)
			)
				fail("下游已经启动或产生结果，不能只重开当前节点；先核对下游并使用审核回边处理");
			const cards = cardStates(flow, node);
			for (const card of cards) {
				if (card.frontmatter.status === "in_progress")
					fail(`卡 ${formatCardNumber(card.card_no)} 仍在途；先核对回执并落态或确认停止，不能重派`);
				if (card.frontmatter.status === "delivered")
					fail(`卡 ${formatCardNumber(card.card_no)} 已交付；不能通过故障重开重复执行已完成成果`);
				if (receiptConflict(card))
					fail(`卡 ${formatCardNumber(card.card_no)} 有回执归属冲突；先核对当前 attempt 与回执，不重派`);
			}
			if (activeWorkerForCards(flow, cards, processes))
				fail("当前节点仍有登记中的活工人；先 pao_terminate_card 并确认停止，不能重开");
			const oldRound = node.轮次;
			resetNodeRound(node, input.现场核查);
			node.部长会话 = undefined;
			// 实例级暂停与叫人去重可能属于其他旁支；单节点重开只能修本节点，显式 resume 才恢复实例。
			flow.记录.push({
				时间: new Date().toISOString(),
				事件: "当前节点重开",
				节点: node.名字,
				轮次: oldRound,
				理由: input.现场核查,
			});
		}),
	);
}
/**
 * 已结束拆解后的原卡返修：只重开当前节点已有卡，保持实例、轮次、attempt、预算与历史。
 * 调用方须提供真实部长身份；本入口不新增卡，也不负责启动部长或模型。
 */
export async function reworkOriginalCards(
	recipe: WorkflowRecipe,
	options: DriverOptions,
	identity: NodeIdentity,
	input: { 卡: readonly string[]; 理由: string },
	processes: () => readonly ProcessEntry[],
): Promise<string[]> {
	return withFileLock(`${controlPath(recipe, options)}.dispatch`, () =>
		mutate(recipe, options, async (flow) => {
			options.signal?.throwIfAborted();
			const node = flow.节点.find((candidate) => candidate.名字 === identity.节点);
			if (
				flow.实例 !== identity.实例 ||
				!node ||
				node.轮次 !== identity.轮次 ||
				!identity.部长会话 ||
				node.部长会话 !== identity.部长会话
			)
				fail("原卡返修须由当前实例、节点、轮次的真实部长提交");
			if (flow.暂停 || flow.裁定) fail("实例已暂停或仍有待处理裁定；不能借原卡返修绕过恢复和人工门");
			const contentTree = await currentContentTree(
				options,
				flow.节点.some((candidate) => candidate.判定?.结果 === "pass" || candidate.放行修复),
			);
			if (
				flow.状态 === "已完成" ||
				node.确认 ||
				node.判定 ||
				complete(flow, node, projectRootForCards(options.cardsDir), contentTree)
			)
				fail("当前节点已确认、判定或完成；原卡返修只修未完成节点的失败或验收缺陷，其它情况须走审核回边");
			if (!node.拆解结束) fail("原卡返修须在拆解结束后；拆解中用正常交卡入口");
			const reason = input.理由.trim();
			if (!reason) fail("原卡返修理由不能为空");
			if (!input.卡.length) fail("原卡返修至少指定一张已有卡");
			const requested = input.卡.map(parseCardRef);
			if (new Set(requested).size !== requested.length) fail("原卡返修不能重复指定同一张卡");
			const affected = descendantNodeNames(flow, node.名字);
			if (
				flow.节点.some(
					(candidate) =>
						candidate !== node &&
						affected.has(candidate.名字) &&
						(candidate.部长会话 ||
							candidate.卡.length ||
							candidate.历史.length ||
							candidate.拆解结束 ||
							candidate.判定 ||
							candidate.确认),
				)
			)
				fail("下游已经启动或产生结果，不能直接改前置产物；请使用既有审核回边或人工恢复流程");
			const roundMarker = `<!-- pao-workflow-v2:实例=${flow.实例}/轮次=${node.轮次} -->`;
			const current = new Map(node.卡.map((ref) => [parseCardRef(ref), loadCard(flow.卡目录, parseCardRef(ref))]));
			const cards = requested.map((cardNo) => {
				const card = current.get(cardNo);
				if (!card) fail(`卡${formatCardNumber(cardNo)}不属于当前节点，不能借返修新增任务`);
				if (card.body.split(roundMarker).length !== 2)
					fail(`卡${formatCardNumber(cardNo)}的流程身份已损坏或不属于当前轮`);
				if (!card.frontmatter.owner?.trim()) fail(`卡${formatCardNumber(cardNo)}没有 owner；无法确认返修写者`);
				const reviewPending = card.frontmatter.status === "in_progress";
				if (reviewPending) reviewPendingOriginalInput(flow, node, card);
				if (card.frontmatter.status === "unclaimed")
					fail(
						`卡${formatCardNumber(cardNo)}当前状态为 unclaimed，已排队等待主控推进；无需重复返修或新增卡，旧尝试回执不代表待执行尝试失败`,
					);
				if (!["delivered", "failed", "in_progress"].includes(card.frontmatter.status))
					fail(`卡${formatCardNumber(cardNo)}当前状态为 ${card.frontmatter.status}，不能返修`);
				checkTransition({
					from: reviewPending || card.frontmatter.status === "delivered" ? "failed" : card.frontmatter.status,
					to: "unclaimed",
					尝试: card.frontmatter.attempt,
					卡号: card.card_no,
					卡目录: dirname(card.path),
				});
				if (receiptConflict(card))
					fail(`卡${formatCardNumber(cardNo)}有回执归属冲突；先核对当前 attempt 与回执，不返修`);
				return card;
			});
			if (activeWorkerForCards(flow, cards, processes)) fail("待返修卡仍有登记中的活工人；先终止并确认停止");
			const cardsProjectRoot = projectRootForCards(flow.卡目录);
			for (const card of cards) {
				const cardLabel = formatCardNumber(card.card_no);
				let binding: ReturnType<typeof readExecutionBinding>;
				try {
					binding = readExecutionBinding({
						cardsDir: flow.卡目录,
						cardNo: card.card_no,
						attempt: card.frontmatter.attempt,
					});
				} catch (error) {
					fail(
						`卡${cardLabel}无法读取当前 attempt 的真实执行绑定，拒绝返修：${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}
				if (pathKey(resolve(binding.projectRoot)) !== pathKey(resolve(cardsProjectRoot)))
					fail(`卡${cardLabel}的执行绑定不属于当前任务，拒绝返修`);
				const occupancy = await detectExecutionOccupancy(binding.executionRoot);
				if (occupancy !== "idle")
					fail(`卡${cardLabel}的执行根 ${binding.executionRoot} 占用状态为 ${occupancy}；必须确认停止`);
			}
			const stamp = new Date().toISOString();
			// 多卡先固定更新意图；中途失败保留暂停，下一入口不会按半更新现场继续派发。
			flow.暂停 = "原卡返修正在更新；更新中断须核查现场后显式恢复";
			saveControl(recipe, options, flow);
			for (const card of cards)
				reopenOriginalCard({
					card,
					operator: card.frontmatter.owner ?? "",
					oldMarker: roundMarker,
					newMarker: roundMarker,
					reason,
					time: stamp,
					assertReviewPending: () => {
						const latest = readCard(card.path);
						if (latest.frontmatter.status === "in_progress") reviewPendingOriginalInput(flow, node, latest);
					},
				});
			flow.暂停 = undefined;
			flow.记录.push({
				时间: stamp,
				事件: "原卡返修",
				节点: node.名字,
				轮次: node.轮次,
				理由: `${reason}（卡：${cards.map((card) => formatCardNumber(card.card_no)).join("、")}）`,
			});
			return cards.map((card) => formatCardNumber(card.card_no));
		}),
	);
}
export async function confirmControl(
	recipe: WorkflowRecipe,
	options: DriverOptions,
	name: string,
	round: number,
): Promise<DriveReport> {
	const contentTree = await currentContentTree(
		options,
		readControl(recipe, options).节点.some((node) => node.判定?.结果 === "pass" || node.放行修复),
	);
	return mutate(recipe, options, (flow) => {
		const node = flow.节点.find((n) => n.名字 === name);
		const def = flow.冻结配方.节点.find((n) => n.名字 === name);
		const cardsDeclared = node ? node.卡.length > 0 || Boolean(node.零卡理由?.trim()) : false;
		const reviewReleased =
			def?.审核 &&
			(node?.放行修复 ||
				(node?.判定?.结果 === "pass" && currentPass(node, projectRootForCards(options.cardsDir), contentTree)));
		if (
			!node ||
			!def?.人工确认 ||
			round !== node.轮次 ||
			!node.拆解结束 ||
			!cardsDeclared ||
			!cardStates(flow, node).every((c) => c.frontmatter.status === "delivered") ||
			(def.审核 && !reviewReleased)
		)
			fail("旧确认、成果版本已变化或节点尚未满足确认条件");
		node.确认 = new Date().toISOString();
		// 确认即清叫人记录（v1 confirmWorkflowNode 同款）：同一门确认后再挂起要允许重新叫人
		flow.叫人 = undefined;
		return controlReport(flow, undefined, contentTree);
	});
}
async function setPause(
	recipe: WorkflowRecipe,
	options: DriverOptions,
	reason: string,
	preserveExisting: boolean,
): Promise<boolean> {
	return withFileLock(controlPath(recipe, options), async () => {
		options.signal?.throwIfAborted();
		const flow = readControl(recipe, options);
		assertOwner(flow, options);
		if (!reason.trim()) fail("暂停理由不能为空");
		if (preserveExisting && flow.暂停 !== undefined) return false;
		if (preserveExisting && (await readControlReport(flow, options)).status === "completed") return false;
		flow.暂停 = reason;
		flow.状态 = persistedStatus(controlReport(flow, undefined, undefined).status);
		saveControl(recipe, options, flow);
		return true;
	});
}
export async function pauseControl(recipe: WorkflowRecipe, options: DriverOptions, reason: string): Promise<void> {
	await setPause(recipe, options, reason, false);
}
/** 关闭与执行异常共用的保守入口：控制锁内重读，已有停因优先。 */
export async function pauseControlIfUnpaused(
	recipe: WorkflowRecipe,
	options: DriverOptions,
	reason: string,
): Promise<boolean> {
	return setPause(recipe, options, reason, true);
}

/**
 * 自动链停因追加到控制正本已有审计记录。只在实例未完成时写；内容不变则幂等，
 * 不改变 运行中/挂起/已完成 状态，也不推进节点或轮次。
 */
export async function recordControlStopReason(
	recipe: WorkflowRecipe,
	options: DriverOptions,
	stop: { reason: string; 节点?: string; 轮次?: number },
): Promise<void> {
	await mutate(recipe, options, (flow) => {
		const reason = stop.reason.trim();
		if (!reason) fail("自动链停因不能为空");
		if (flow.状态 === "已完成") return;
		const latest = flow.记录.at(-1);
		if (
			latest?.事件 === "自动链停因" &&
			latest.理由 === reason &&
			latest.节点 === stop.节点 &&
			latest.轮次 === stop.轮次
		)
			return;
		flow.记录.push({
			时间: new Date().toISOString(),
			事件: "自动链停因",
			...(stop.节点 !== undefined ? { 节点: stop.节点 } : {}),
			...(stop.轮次 !== undefined ? { 轮次: stop.轮次 } : {}),
			理由: reason,
		});
	});
}

/**
 * S6-K2 自动链实例级累计（v2）：已派卡 +delta 落控制正本。经 mutate 走主锁并重核 owner。
 * 自动链在 .dispatch 内原子预留和退款，锁序 .dispatch→主控锁；结算结果不低于 0。
 */
export function bumpControlDispatched(recipe: WorkflowRecipe, options: DriverOptions, delta: number): Promise<void> {
	return mutate(recipe, options, (flow) => {
		flow.已派卡 = Math.max(0, (flow.已派卡 ?? 0) + delta);
	});
}

/** 在控制锁内重核节点身份并按实例剩余额度预留一张。 */
export function reserveControlDispatch(
	recipe: WorkflowRecipe,
	options: DriverOptions,
	input: { instance: string; node: string; round: number; cardRef: string; limit: number },
): Promise<boolean> {
	return mutate(recipe, options, (flow) => {
		const node = flow.节点.find((candidate) => candidate.名字 === input.node);
		if (
			flow.实例 !== input.instance ||
			flow.暂停 ||
			flow.裁定 ||
			flow.状态 === "已完成" ||
			!node ||
			node.轮次 !== input.round ||
			!node.卡.some((ref) => parseCardRef(ref) === parseCardRef(input.cardRef))
		)
			fail("实例已改变、暂停、待裁定、已完成或节点/轮次/卡身份已改变，拒绝认领");
		if ((flow.已派卡 ?? 0) >= input.limit) return false;
		flow.已派卡 = (flow.已派卡 ?? 0) + 1;
		return true;
	});
}

// ── S6-K3 v2 叫人去重落盘（K1 留白）：控制正本「叫人」字段，盘上去重跨重启 ──────

/** 查控制正本「叫人」记录：键一致＝该停链现场已叫过。正本缺失/损坏按未叫过（尽力而为路径不放大错误）。 */
export function controlHumanCalled(recipe: WorkflowRecipe, options: DriverOptions, key: string): boolean {
	try {
		return readControl(recipe, options).叫人 === key;
	} catch {
		return false;
	}
}

/**
 * 叫人后把去重键落控制正本。经 mutate 走主锁并重核 owner——正本多写者（部长 mutate/驱动链），
 * 不能裸读改写覆盖并发状态（丢的是真实回执映射，不是只丢去重）。写失败尽力而为：toast 已发出，
 * 不掩盖主流程（最坏＝重启后同一现场重弹一次，与 v1 清单写失败同语义）。
 */
export function recordControlCalledHuman(recipe: WorkflowRecipe, options: DriverOptions, key: string): Promise<void> {
	return mutate(recipe, options, (flow) => {
		if (flow.叫人 !== key) flow.叫人 = key;
	}).catch(() => undefined);
}

function assertPendingBinding(flow: FlowControl, pending: WorkflowPending): NodeControl {
	const problems = validatePending(pending);
	if (problems.length > 0) fail(`待决结构无效：${problems.join("；")}`);
	if (flow.状态 === "已完成") fail("实例已完成，不能登记或合并待决");
	if (flow.实例 !== pending.instance) fail("待决 instance 与控制实例不一致");
	const node = flow.节点.find((candidate) => candidate.名字 === pending.node);
	if (!node) fail(`待决节点不存在：${pending.node}`);
	if (node.轮次 !== pending.round) fail(`待决轮次过期：当前第 ${node.轮次} 轮，收到第 ${pending.round} 轮`);
	const expectedKey = pendingKey({
		kind: pending.kind,
		instance: pending.instance,
		node: pending.node,
		round: pending.round,
		...(pending.card_ref !== undefined ? { cardRef: pending.card_ref } : {}),
		...(pending.attempt !== undefined ? { attempt: pending.attempt } : {}),
	});
	if (pending.key !== expectedKey) fail(`待决 key 与绑定身份不一致；期望 ${expectedKey}`);
	if (pending.phase !== "待处理") fail(`待决阶段为 ${pending.phase}，不能再登记或合并`);
	if (pending.card_ref === undefined) {
		if (pending.attempt !== undefined) fail("待决 attempt 必须与 card_ref 一同绑定");
	} else {
		let boundRef: number;
		try {
			boundRef = parseCardRef(pending.card_ref);
		} catch {
			fail(`待决 card_ref 无效：${pending.card_ref}`);
		}
		if (!node.卡.some((ref) => parseCardRef(ref) === boundRef)) fail("待决卡不属于当前节点");
		if (pending.attempt === undefined) fail("待决绑定卡时必须填写当前 attempt");
		let card: ParsedCard;
		try {
			card = loadCard(flow.卡目录, boundRef);
		} catch (error) {
			fail(`待决卡读取失败：${error instanceof Error ? error.message : String(error)}`);
		}
		if (card.frontmatter.attempt !== pending.attempt)
			fail(`待决 attempt 已过期：卡面当前 attempt=${card.frontmatter.attempt}，收到 ${pending.attempt}`);
	}
	if ((pending.kind === "普通偏差" || pending.kind === "部长hold") && pending.items.length === 0)
		fail(`${pending.kind}待决必须包含至少一项 fail/not_run 事实`);
	const def = flow.冻结配方.节点.find((candidate) => candidate.名字 === node.名字)!;
	if ((!def.只读 || def.审核) && hasStartedDescendant(flow, node))
		fail("下游已经启动或产生结果，不能为已移交节点登记迟到待决");
	return node;
}

function applyPending(flow: FlowControl, pending: WorkflowPending, reasonEvent: string): WorkflowPending {
	assertPendingBinding(flow, pending);
	let next = pending;
	let firstWrite = false;
	if (flow.待决) {
		if (flow.待决.key !== pending.key)
			fail(`已有不同待决 ${flow.待决.key}，不能用 ${pending.key} 覆盖；须先按当前现场办理`);
		next = mergePending(flow.待决, pending);
	} else {
		if (flow.暂停 || flow.裁定) fail("实例已有非结构化暂停或旧裁定，不能隐式覆盖");
		firstWrite = true;
	}
	const before = flow.待决 ? JSON.stringify(flow.待决) : undefined;
	flow.待决 = next;
	flow.暂停 = pendingSummary(next);
	if (next.kind === "普通裁定" || next.kind === "人工确认")
		flow.裁定 = { 节点: next.node, 轮次: next.round, 理由: next.reason, 通道: next.channel };
	if (firstWrite || JSON.stringify(next) !== before)
		flow.记录.push({
			时间: next.created_at,
			事件: reasonEvent,
			节点: next.node,
			轮次: next.round,
			理由: pendingSummary(next),
		});
	return structuredClone(next);
}

/** 将绑定当前卡 attempt 的普通偏差或部长 hold 写入控制正本；同键幂等合并。 */
export async function recordPending(
	recipe: WorkflowRecipe,
	options: DriverOptions,
	pending: WorkflowPending,
): Promise<WorkflowPending> {
	return mutate(recipe, options, (flow) =>
		applyPending(flow, pending, pending.kind === "部长hold" ? "登记部长hold待决" : "登记普通偏差待决"),
	);
}

/** 从控制正本读取结构化待决；key 用于主控核对同一现场，不解析暂停文案。 */
export async function readPending(
	recipe: WorkflowRecipe,
	options: DriverOptions,
	key?: string,
): Promise<WorkflowPending | undefined> {
	const pending = readControl(recipe, options).待决;
	if (!pending || (key !== undefined && pending.key !== key)) return undefined;
	return structuredClone(pending);
}

/** 调度时捕获的完整待决身份；到期落盘前在控制锁内再次逐项核对。 */
export type PendingExpirationExpectation = Pick<
	WorkflowPending,
	"instance" | "key" | "node" | "round" | "card_ref" | "attempt" | "deadline"
>;

export async function expirePending(
	recipe: WorkflowRecipe,
	options: DriverOptions,
	expected?: PendingExpirationExpectation,
): Promise<WorkflowPending | undefined> {
	const now = options.now?.() ?? new Date().toISOString();
	if (!Number.isFinite(Date.parse(now))) fail(`待决到期检查时间无效：${now}`);
	return mutate(recipe, options, (flow) => {
		if (!flow.待决) return undefined;
		if (
			expected &&
			(flow.实例 !== expected.instance ||
				flow.待决.instance !== expected.instance ||
				flow.待决.key !== expected.key ||
				flow.待决.node !== expected.node ||
				flow.待决.round !== expected.round ||
				flow.待决.card_ref !== expected.card_ref ||
				flow.待决.attempt !== expected.attempt ||
				flow.待决.deadline !== expected.deadline)
		)
			return undefined;
		const result = expirePendingFact(flow.待决, now);
		if (!result) return undefined;
		flow.结果 ??= [];
		flow.结果.push(result);
		flow.记录.push({
			时间: now,
			事件: "待决截止",
			节点: flow.待决.node,
			轮次: flow.待决.round,
			理由: result.reason,
		});
		return structuredClone(flow.待决);
	});
}

export async function requestRuling(
	recipe: WorkflowRecipe,
	options: DriverOptions,
	identity: NodeIdentity,
	reason: string,
	ownerPresent: boolean,
): Promise<WorkflowPending> {
	const initial = readControl(recipe, options);
	const tree = await currentContentTree(
		options,
		initial.节点.some((node) => node.判定?.结果 === "pass" || node.放行修复),
	);
	const createdAt = options.now?.() ?? new Date().toISOString();
	const deadline = pendingDeadline(createdAt);
	return mutate(recipe, options, (flow) => {
		const node = identify(flow, identity, tree, Boolean(flow.待决?.phase === "待处理"));
		const def = flow.冻结配方.节点.find((n) => n.名字 === node.名字)!;
		if (!reason.trim()) fail("裁定理由不能为空");
		if (flow.状态 === "已完成") fail("实例已完成，不能再请求裁定");
		// 只读部长可被宿主召回复核地图；普通执行/审核节点移交下游后不再接受迟到裁定。
		if ((!def.只读 || def.审核) && hasStartedDescendant(flow, node))
			fail("下游已经启动或产生结果，不能从已移交节点请求裁定；请由当前审核节点处理并使用审核回边");
		if (
			def.审核 &&
			(!node.拆解结束 || !cardStates(flow, node).every((card) => card.frontmatter.status === "delivered"))
		)
			fail("审核裁定须先由 owner 完成逐项处理和机械交付，并结束拆解");
		const channel = def.人工确认
			? "人工"
			: isUnattended(flow) || (def.允许请求主控裁定 && ownerPresent)
				? "主控"
				: "人工";
		if (flow.待决) {
			if (flow.待决.instance !== identity.实例 || flow.待决.node !== node.名字 || flow.待决.round !== node.轮次)
				fail(`已有另一现场待决 ${flow.待决.key}，拒绝用当前节点请求覆盖`);
			if (flow.待决.phase !== "待处理") fail(`待决阶段为 ${flow.待决.phase}，不能继续请求裁定`);
			if (flow.待决.channel !== channel) fail(`已有待决通道为 ${flow.待决.channel}，不能用 ${channel} 覆盖`);
			const next = structuredClone(flow.待决);
			if (!next.reason.split("\n").includes(reason)) next.reason = `${next.reason}\n${reason}`;
			flow.待决 = next;
			flow.裁定 = { 节点: node.名字, 轮次: node.轮次, 理由: next.reason, 通道: channel };
			flow.暂停 = `等待${channel}裁定:${next.reason}`;
			return structuredClone(next);
		}
		const pending = createRulingPending({
			instance: identity.实例,
			node: node.名字,
			round: node.轮次,
			reason,
			channel,
			createdAt,
			deadline,
		});
		const applied = applyPending(flow, pending, channel === "人工" ? "请求人工确认" : "请求主控裁定");
		flow.裁定 = { 节点: node.名字, 轮次: node.轮次, 理由: applied.reason, 通道: channel };
		flow.暂停 = `等待${channel}裁定:${reason}`;
		return applied;
	});
}

function assertExactKeys(
	value: unknown,
	allowed: readonly string[],
	label: string,
): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} 须为映射`);
	const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unexpected.length > 0) fail(`${label} 含未允许字段：${unexpected.join("、")}`);
}

function validatePendingResolutionInput(input: unknown): asserts input is PendingResolutionInput {
	assertExactKeys(input, ["pending_key", "decisions"], "待决办理输入");
	if (typeof input.pending_key !== "string" || !input.pending_key.trim())
		fail("待决办理输入 pending_key 须为非空字符串");
	if (!Array.isArray(input.decisions)) fail("待决办理输入 decisions 须为数组");
	for (const [index, decision] of input.decisions.entries()) {
		assertExactKeys(decision, ["item_ref", "basis"], `decisions[${index}]`);
		if (typeof decision.item_ref !== "string" || !decision.item_ref.trim())
			fail(`decisions[${index}].item_ref: 须为非空字符串`);
		if (typeof decision.basis !== "string") fail(`decisions[${index}].basis: 须为非空字符串`);
	}
}

function pendingResolutionDigest(input: PendingResolutionInput): string {
	const decisions = [...input.decisions]
		.map((decision) => ({ item_ref: decision.item_ref, basis: decision.basis.trim() }))
		.sort((left, right) => left.item_ref.localeCompare(right.item_ref));
	const stable = JSON.stringify({ pending_key: input.pending_key, decisions });
	return `sha256:${createHash("sha256").update(stable, "utf8").digest("hex")}`;
}

function resolutionClock(options: DriverOptions): { iso: string; card: string } {
	const raw = options.now?.() ?? new Date().toISOString();
	const milliseconds = Date.parse(raw);
	if (!Number.isFinite(milliseconds)) fail(`待决办理时间无效：${raw}`);
	const date = new Date(milliseconds);
	return { iso: date.toISOString(), card: nowString(date) };
}

function resolutionFlowStatus(flow: FlowControl): DriveReport["status"] {
	return flow.状态 === "已完成" ? "completed" : flow.状态 === "挂起" ? "hold" : "running";
}

function assertTrustedUnattended(flow: FlowControl, options: DriverOptions): void {
	if (options.runMode !== "unattended") fail("可信宿主未授权无人值守，拒绝程序办理待决；有人值守实例保持人工入口");
	if (!isUnattended(flow)) fail("当前实例不是无人值守运行方式，拒绝程序办理待决");
}

function findPendingResolution(flow: FlowControl, key: string): PendingResolutionRecord | undefined {
	return flow.待决办理?.find((record) => record.pending_key === key);
}

function assertPendingResolutionIdentity(
	record: PendingResolutionRecord,
	pending: WorkflowPending,
	card: ParsedCard,
	digest?: string,
): void {
	if (
		record.pending_key !== pending.key ||
		record.instance !== pending.instance ||
		record.node !== pending.node ||
		record.round !== pending.round ||
		record.card_ref !== pending.card_ref ||
		record.card_no !== card.card_no ||
		record.attempt !== card.frontmatter.attempt
	)
		fail(`待决办理记录身份与当前控制正本不一致；记录 ${record.pending_key}`);
	if (digest !== undefined && record.input_digest !== digest)
		fail(`同一待决 ${pending.key} 已绑定不同裁决依据，拒绝重放修改`);
}

function assertPendingReceiptFacts(card: ParsedCard, pending: WorkflowPending): void {
	if (hasConflictingTerminalReceipts(card)) fail("当前尝试存在互相冲突的终结回执，拒绝程序办理");
	const receipt = currentAttemptReceipt(card);
	if (!receipt) fail(`当前 attempt ${card.frontmatter.attempt} 缺少回执，拒绝程序办理`);
	if (receipt.attempt !== card.frontmatter.attempt)
		fail(`回执 attempt ${receipt.attempt} 与卡面当前 attempt ${card.frontmatter.attempt} 不一致`);
	if (!isCompletedTaskState(receipt.任务态))
		fail(`当前回执任务态为 ${receipt.任务态 ?? "(缺失)"}；只允许 completed 或 completed_with_deviations`);
	const current = (receipt.verification ?? [])
		.map((item, verification_index) => ({ item, verification_index }))
		.filter(({ item }) => item.结论 === "fail" || item.结论 === "not_run");
	if (current.length !== pending.items.length)
		fail(`当前回执未达项 ${current.length} 项与待决 ${pending.items.length} 项不一致，拒绝部分办理`);
	for (const bound of pending.items) {
		const source = receipt.verification?.[bound.verification_index];
		if (!source || source.条件 !== bound.condition || source.结论 !== bound.report)
			fail(
				`待决项 ${bound.item_ref} 的回执事实已变化：期望 #${bound.verification_index} ${bound.condition} ${bound.report}`,
			);
	}
}

async function inspectPendingResolution(
	recipe: WorkflowRecipe,
	options: DriverOptions,
	key: string,
	digest: string,
	expectedStages: readonly PendingResolutionStage[],
	checkOccupancy: boolean,
): Promise<{
	record: PendingResolutionRecord;
	pending: WorkflowPending;
	card: ParsedCard;
	operator: string;
	cardsDir: string;
	executionKey: { cardsDir: string; cardNo: number; attempt: number };
	independentReview: boolean;
}> {
	return withFileLock(controlPath(recipe, options), async () => {
		options.signal?.throwIfAborted();
		const flow = readControl(recipe, options);
		assertOwner(flow, options);
		assertTrustedUnattended(flow, options);
		const record = findPendingResolution(flow, key);
		if (!record) fail(`找不到待决办理记录 ${key}`);
		const pending = flow.待决;
		if (!pending || pending.key !== key) fail(`当前待决不是 ${key}，拒绝串用其他现场`);
		assertPendingBinding(flow, pending);
		if (!expectedStages.includes(record.stage))
			fail(`待决办理 ${key} 当前阶段为 ${record.stage}，不能从该阶段继续当前动作`);
		const cardNo = pending.card_ref ? parseCardRef(pending.card_ref) : 0;
		if (!cardNo || pending.attempt === undefined) fail("待决办理必须绑定当前卡与 attempt");
		const card = loadCard(flow.卡目录, cardNo);
		assertPendingResolutionIdentity(record, pending, card, digest);
		if (!["in_progress", "delivered"].includes(card.frontmatter.status))
			fail(`卡面状态为 ${card.frontmatter.status}，不是可办理的 in_progress/delivered`);
		assertPendingReceiptFacts(card, pending);
		const operator = card.frontmatter.owner?.trim();
		if (!operator) fail("当前卡缺少 owner，拒绝调用验收、状态机或交卷");
		const clock = resolutionClock(options);
		if (Date.parse(clock.iso) >= Date.parse(pending.deadline)) fail(`待决 ${key} 已到截止时间 ${pending.deadline}`);
		const executionKey = { cardsDir: flow.卡目录, cardNo, attempt: card.frontmatter.attempt };
		if (checkOccupancy) {
			const execution = await resolveExecutionContext(executionKey, {
				expectedCurrentAttempt: card.frontmatter.attempt,
				requireLiveExecutionRoot: true,
			});
			const occupancy = await detectExecutionOccupancy(execution.canonicalExecutionRoot);
			if (occupancy !== "idle") fail(`执行根占用状态为 ${occupancy}；只有明确 idle 才可办理，未证明写者停止`);
		}
		return {
			record: structuredClone(record),
			pending: structuredClone(pending),
			card,
			operator,
			cardsDir: flow.卡目录,
			executionKey,
			independentReview: flow.冻结配方.节点.some((node) => node.名字 === pending.node && node.只读 && node.审核),
		};
	});
}

async function updatePendingResolution(
	recipe: WorkflowRecipe,
	options: DriverOptions,
	key: string,
	digest: string,
	expectedStages: readonly PendingResolutionStage[],
	update: (record: PendingResolutionRecord, flow: FlowControl, card: ParsedCard) => void,
): Promise<PendingResolutionRecord> {
	return withFileLock(controlPath(recipe, options), async () => {
		options.signal?.throwIfAborted();
		const flow = readControl(recipe, options);
		assertOwner(flow, options);
		assertTrustedUnattended(flow, options);
		const record = findPendingResolution(flow, key);
		if (!record) fail(`找不到待决办理记录 ${key}`);
		if (record.input_digest !== digest) fail(`同一待决 ${key} 已绑定不同裁决依据，拒绝重放修改`);
		if (!expectedStages.includes(record.stage)) fail(`待决办理 ${key} 当前阶段为 ${record.stage}，不能写入预期阶段`);
		const pending = flow.待决;
		if (!pending || pending.key !== key) fail(`当前待决不是 ${key}，拒绝串用其他现场`);
		const cardNo = pending.card_ref ? parseCardRef(pending.card_ref) : 0;
		if (!cardNo) fail("待决办理必须绑定卡号");
		const card = loadCard(flow.卡目录, cardNo);
		assertPendingResolutionIdentity(record, pending, card, digest);
		update(record, flow, card);
		record.updated_at = resolutionClock(options).iso;
		saveControl(recipe, options, flow);
		return structuredClone(record);
	});
}

function resolutionErrorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function recordResolutionFailure(
	recipe: WorkflowRecipe,
	options: DriverOptions,
	key: string,
	digest: string,
	expectedStages: readonly PendingResolutionStage[],
	stage: "review_failed" | "delivery_failed",
	failureStage: "review" | "delivery",
	error: unknown,
): Promise<void> {
	const time = resolutionClock(options).iso;
	await updatePendingResolution(recipe, options, key, digest, expectedStages, (record) => {
		record.stage = stage;
		record.failure = {
			stage: failureStage,
			message: resolutionErrorText(error),
			time,
		};
	});
}

function combinedResolutionBasis(pending: WorkflowPending, decisions: readonly BoundDeviationDecision[]): string {
	const parts = decisions.map((decision) => `${decision.item_ref}: ${decision.basis}`);
	return [`待决 ${pending.key}: ${pending.reason}`, ...parts].join("\n");
}

async function independentReviewSubmission(
	flow: FlowControl,
	card: ParsedCard,
	options: DriverOptions,
): Promise<NonNullable<PendingResolutionRecord["submission"]> & { skip: IndependentReviewSubmissionSkip }> {
	assertOwner(flow, options);
	assertTrustedUnattended(flow, options);
	const pending = flow.待决;
	if (
		!pending ||
		!pending.card_ref ||
		pending.attempt !== card.frontmatter.attempt ||
		parseCardRef(pending.card_ref) !== card.card_no
	)
		fail("独立审核证据与当前待决卡或 attempt 不一致");
	assertPendingBinding(flow, pending);
	const def = flow.冻结配方.节点.find((node) => node.名字 === pending.node);
	if (!def?.只读 || !def.审核) fail("只有冻结的独立只读审核节点可免除副本合并");
	const execution = await resolveExecutionContext(
		{ cardsDir: flow.卡目录, cardNo: card.card_no, attempt: card.frontmatter.attempt },
		{ expectedCurrentAttempt: card.frontmatter.attempt, requireLiveExecutionRoot: true },
	);
	if (execution.worktree.kind !== "managed") fail("独立审核必须使用真实受管副本");
	const evidence = await reviewEvidence(card, flow.卡目录, await currentContentTree(options, true), true);
	if (evidence.kind !== "verified")
		fail(`独立审核证据不可确认：${evidence.kind === "blocked" ? evidence.reason : "缺少当前机械验收版本"}`);
	if ((await detectExecutionOccupancy(execution.canonicalExecutionRoot)) !== "idle")
		fail("独立审核副本尚未确认 idle，保留占位，不办理");
	const skip: IndependentReviewSubmissionSkip = {
		reason: "independent_review_evidence",
		attempt: card.frontmatter.attempt,
		binding_digest: execution.bindingDigest,
		source_tree: evidence.sourceTree,
		copy_tree: evidence.copyTree,
	};
	return {
		交卷: false,
		原因: "独立审核仅交证据",
		消息: "独立审核证据已核对；未合并副本、未创建业务提交",
		暂存文件: [],
		skip,
	};
}

async function assertNoChangeSubmission(
	submission: NonNullable<PendingResolutionRecord["submission"]>,
	executionKey: { cardsDir: string; cardNo: number; attempt: number },
	options: DriverOptions,
): Promise<void> {
	const skip = submission.skip;
	if (
		submission.交卷 ||
		submission.提交哈希 !== undefined ||
		!skip ||
		skip.reason !== "no_worker_changes" ||
		skip.attempt !== executionKey.attempt ||
		skip.baseline_tree !== skip.current_tree
	)
		fail(`${submission.原因 ?? "交卷未完成"}：${submission.消息}`);
	const execution = await resolveExecutionContext(executionKey, {
		expectedCurrentAttempt: executionKey.attempt,
		requireLiveExecutionRoot: true,
	});
	if (skip.binding_digest !== execution.bindingDigest) fail("无改动交付的执行绑定与当前 attempt 不一致，拒绝办理");
	const diff = await diffAgainstBaseline(
		baselineSnapshotPath(executionKey.cardsDir, executionKey.cardNo, executionKey.attempt),
		options.signal,
	);
	if (
		!diff.基线可用 ||
		diff.worker改动.length !== 0 ||
		!diff.基线Tree ||
		!diff.当前Tree ||
		diff.基线Tree !== diff.当前Tree ||
		skip.baseline_tree !== diff.基线Tree ||
		skip.current_tree !== diff.当前Tree ||
		!diff.当前ContentRoot ||
		canonical(diff.当前ContentRoot) !== canonical(execution.canonicalExecutionRoot)
	)
		fail("无改动交付的真实基线与当前内容 tree 不一致，拒绝办理");
	const occupancy = await detectExecutionOccupancy(execution.canonicalExecutionRoot);
	if (occupancy !== "idle") fail(`执行根占用状态为 ${occupancy}；无改动交付仍要求明确 idle，未证明写者停止`);
}

/**
 * 无人值守单次待决办理。身份全部从控制正本与卡面读取；调用方仅提交 pending_key 和逐项依据。
 * 业务动作按阶段落盘，失败后可用完全相同输入重放；完整成功后重放只返回原交卷结果。
 */
export async function resolvePendingOnce(
	recipe: WorkflowRecipe,
	options: DriverOptions,
	input: PendingResolutionInput,
): Promise<PendingResolutionResult> {
	validatePendingResolutionInput(input);
	const digest = pendingResolutionDigest(input);
	const clock = resolutionClock(options);
	const initial = await withFileLock(
		controlPath(recipe, options),
		async (): Promise<
			| {
					kind: "completed";
					record: PendingResolutionRecord;
					flowStatus: DriveReport["status"];
			  }
			| {
					kind: "ready";
					record: PendingResolutionRecord;
					pending: WorkflowPending;
					stage: PendingResolutionStage;
			  }
		> => {
			options.signal?.throwIfAborted();
			const flow = readControl(recipe, options);
			assertOwner(flow, options);
			assertTrustedUnattended(flow, options);
			const existing = findPendingResolution(flow, input.pending_key);
			if (existing?.stage === "completed") {
				if (existing.input_digest !== digest)
					fail(`同一待决 ${input.pending_key} 已绑定不同裁决依据，拒绝重放修改`);
				if (!existing.submission) fail(`待决办理 ${input.pending_key} 已完成但缺少交卷结果`);
				return {
					kind: "completed",
					record: structuredClone(existing),
					flowStatus: resolutionFlowStatus(flow),
				};
			}
			if (existing?.stage === "pending_cleared") {
				if (existing.input_digest !== digest)
					fail(`同一待决 ${input.pending_key} 已绑定不同裁决依据，拒绝重放修改`);
				if (!existing.submission) fail(`待决办理 ${input.pending_key} 已清场但缺少交卷结果`);
				existing.stage = "completed";
				existing.updated_at = clock.iso;
				saveControl(recipe, options, flow);
				return {
					kind: "completed",
					record: structuredClone(existing),
					flowStatus: resolutionFlowStatus(flow),
				};
			}
			const pending = flow.待决;
			if (!pending) fail(`控制正本没有待决 ${input.pending_key}`);
			if (pending.key !== input.pending_key) fail(`当前待决为 ${pending.key}，不能用 ${input.pending_key} 覆盖`);
			assertPendingBinding(flow, pending);
			if (!pending.card_ref || pending.attempt === undefined) fail("待决办理必须绑定当前卡与 attempt");
			const cardNo = parseCardRef(pending.card_ref);
			const card = loadCard(flow.卡目录, cardNo);
			if (existing) assertPendingResolutionIdentity(existing, pending, card);
			if (existing && existing.stage !== "validation_failed" && existing.input_digest !== digest)
				fail(`同一待决 ${input.pending_key} 已绑定不同裁决依据，拒绝重放修改`);
			let record: PendingResolutionRecord;
			if (!existing || existing.stage === "validation_failed") {
				const decisions = planPendingResolution(pending, input.decisions).sort((left, right) =>
					left.item_ref.localeCompare(right.item_ref),
				);
				assertPendingReceiptFacts(card, pending);
				if (Date.parse(clock.iso) >= Date.parse(pending.deadline))
					fail(`待决 ${pending.key} 已到截止时间 ${pending.deadline}`);
				if (!card.frontmatter.owner?.trim()) fail("当前卡缺少 owner，拒绝程序办理");
				const executionKey = { cardsDir: flow.卡目录, cardNo, attempt: card.frontmatter.attempt };
				const execution = await resolveExecutionContext(executionKey, {
					expectedCurrentAttempt: card.frontmatter.attempt,
					requireLiveExecutionRoot: true,
				});
				const occupancy = await detectExecutionOccupancy(execution.canonicalExecutionRoot);
				if (occupancy !== "idle") fail(`执行根占用状态为 ${occupancy}；只有明确 idle 才可办理，未证明写者停止`);

				record =
					existing ??
					({
						pending_key: pending.key,
						instance: pending.instance,
						node: pending.node,
						round: pending.round,
						card_ref: pending.card_ref,
						card_no: card.card_no,
						attempt: card.frontmatter.attempt,
						input_digest: digest,
						decisions: [],
						stage: "validated",
						created_at: clock.iso,
						updated_at: clock.iso,
					} satisfies PendingResolutionRecord);
				record.input_digest = digest;
				record.decisions = decisions;
				record.stage = "validated";
				record.failure = undefined;
				record.updated_at = clock.iso;
				if (!existing) {
					flow.待决办理 ??= [];
					flow.待决办理.push(record);
				}
				saveControl(recipe, options, flow);
			} else {
				record = existing;
			}
			return {
				kind: "ready",
				record: structuredClone(record),
				pending: structuredClone(pending),
				stage: record.stage,
			};
		},
	);

	if (initial.kind === "completed") {
		return {
			pending_key: input.pending_key,
			stage: "completed",
			idempotent: true,
			submission: initial.record.submission!,
			flow_status: initial.flowStatus,
		};
	}

	let stage = initial.stage;
	let storedSubmission: NonNullable<PendingResolutionRecord["submission"]> | undefined;

	if (stage === "validated" || stage === "review_failed") {
		const beforeReview = await inspectPendingResolution(
			recipe,
			options,
			input.pending_key,
			digest,
			["validated", "review_failed"],
			true,
		);
		try {
			if (beforeReview.independentReview)
				await independentReviewSubmission(readControl(recipe, options), beforeReview.card, options);
			await reviewCardForDelivery(
				beforeReview.cardsDir,
				beforeReview.card.card_no,
				{
					operator: beforeReview.operator,
					时间: nowString(new Date(beforeReview.record.created_at)),
					executionKey: beforeReview.executionKey,
					...(options.signal ? { signal: options.signal } : {}),
				},
				combinedResolutionBasis(beforeReview.pending, beforeReview.record.decisions),
				beforeReview.record.decisions,
			);
		} catch (error) {
			await recordResolutionFailure(
				recipe,
				options,
				input.pending_key,
				digest,
				["validated", "review_failed"],
				"review_failed",
				"review",
				error,
			);
			throw new Error(`待决办理机械验收失败：${resolutionErrorText(error)}`, { cause: error });
		}
		await updatePendingResolution(
			recipe,
			options,
			input.pending_key,
			digest,
			["validated", "review_failed"],
			(record) => {
				record.stage = "reviewed";
				record.failure = undefined;
			},
		);
		stage = "reviewed";
	}

	if (stage === "reviewed" || stage === "delivery_failed") {
		const beforeStatus = await inspectPendingResolution(
			recipe,
			options,
			input.pending_key,
			digest,
			["reviewed", "delivery_failed"],
			true,
		);
		try {
			if (beforeStatus.card.frontmatter.status === "in_progress") {
				changeCardStatus(beforeStatus.card, {
					操作者: beforeStatus.operator,
					to: "delivered",
					依据: combinedResolutionBasis(beforeStatus.pending, beforeStatus.record.decisions),
					时间: nowString(new Date(beforeStatus.record.created_at)),
				});
			} else if (beforeStatus.card.frontmatter.status !== "delivered") {
				fail(`验收后卡面状态为 ${beforeStatus.card.frontmatter.status}，不能进入交付`);
			}
		} catch (error) {
			await recordResolutionFailure(
				recipe,
				options,
				input.pending_key,
				digest,
				["reviewed", "delivery_failed"],
				"delivery_failed",
				"delivery",
				error,
			);
			throw new Error(`待决办理卡交付失败：${resolutionErrorText(error)}`, { cause: error });
		}
		await updatePendingResolution(
			recipe,
			options,
			input.pending_key,
			digest,
			["reviewed", "delivery_failed"],
			(record) => {
				record.stage = "delivered";
				record.failure = undefined;
			},
		);
		stage = "delivered";
	}

	if (stage === "delivered" || stage === "submission_failed") {
		const beforeSubmission = await inspectPendingResolution(
			recipe,
			options,
			input.pending_key,
			digest,
			["delivered", "submission_failed"],
			true,
		);
		let submission: NonNullable<PendingResolutionRecord["submission"]>;
		try {
			if (beforeSubmission.independentReview) {
				submission = await independentReviewSubmission(
					readControl(recipe, options),
					beforeSubmission.card,
					options,
				);
			} else {
				submission = await deliverCard(beforeSubmission.cardsDir, beforeSubmission.card.card_no, {
					executionKey: beforeSubmission.executionKey,
					...(options.signal ? { signal: options.signal } : {}),
				});
				if (!submission.交卷 || !submission.提交哈希)
					await assertNoChangeSubmission(submission, beforeSubmission.executionKey, options);
			}
		} catch (error) {
			const failedSubmission = {
				交卷: false as const,
				消息: resolutionErrorText(error),
				暂存文件: [] as string[],
			};
			await updatePendingResolution(
				recipe,
				options,
				input.pending_key,
				digest,
				["delivered", "submission_failed"],
				(record) => {
					record.stage = "submission_failed";
					record.failure = { stage: "submission", message: resolutionErrorText(error), time: clock.iso };
					record.submission = failedSubmission;
				},
			);
			throw new Error(`待决办理交卷失败：${resolutionErrorText(error)}`, { cause: error });
		}
		storedSubmission = {
			交卷: submission.交卷,
			...(submission.提交哈希 !== undefined ? { 提交哈希: submission.提交哈希 } : {}),
			...(submission.原因 !== undefined ? { 原因: submission.原因 } : {}),
			...(submission.skip ? { skip: submission.skip } : {}),
			消息: submission.消息,
			暂存文件: submission.暂存文件,
		};
		await updatePendingResolution(
			recipe,
			options,
			input.pending_key,
			digest,
			["delivered", "submission_failed"],
			(record) => {
				record.stage = "submitted";
				record.failure = undefined;
				record.submission = storedSubmission!;
			},
		);
		stage = "submitted";
	}

	if (stage !== "submitted") fail(`待决办理 ${input.pending_key} 处于不可继续的阶段 ${stage}；须人工核对控制正本`);

	const flowStatus = await withFileLock(controlPath(recipe, options), async () => {
		options.signal?.throwIfAborted();
		const flow = readControl(recipe, options);
		assertOwner(flow, options);
		assertTrustedUnattended(flow, options);
		const record = findPendingResolution(flow, input.pending_key);
		if (!record || record.input_digest !== digest) fail(`待决办理 ${input.pending_key} 记录已变化`);
		if (record.stage !== "submitted") fail(`待决办理 ${input.pending_key} 当前阶段为 ${record.stage}，不能清待决`);
		const submission = storedSubmission ?? record.submission;
		if (!submission) fail(`待决办理 ${input.pending_key} 缺少交卷结果，拒绝清待决`);
		const pending = flow.待决;
		if (!pending || pending.key !== input.pending_key) fail(`当前待决不是 ${input.pending_key}，拒绝清其他现场`);
		assertPendingBinding(flow, pending);
		const cardNo = pending.card_ref ? parseCardRef(pending.card_ref) : 0;
		const card = cardNo ? loadCard(flow.卡目录, cardNo) : undefined;
		if (!card || card.frontmatter.attempt !== pending.attempt || card.frontmatter.status !== "delivered")
			fail("交卷后卡面 attempt/status 已变化，拒绝清待决");
		const def = flow.冻结配方.节点.find((node) => node.名字 === pending.node);
		if (def?.只读 && def.审核) {
			const expected = (await independentReviewSubmission(flow, card, options)).skip;
			const actual = submission.skip;
			if (
				submission.交卷 ||
				submission.提交哈希 !== undefined ||
				actual?.reason !== "independent_review_evidence" ||
				actual.attempt !== expected.attempt ||
				actual.binding_digest !== expected.binding_digest ||
				actual.source_tree !== expected.source_tree ||
				actual.copy_tree !== expected.copy_tree
			)
				fail("独立审核证据版本或免合并凭据已变化，拒绝清待决");
		} else if (!submission.交卷 || !submission.提交哈希) {
			await assertNoChangeSubmission(
				submission,
				{ cardsDir: flow.卡目录, cardNo: record.card_no, attempt: record.attempt },
				options,
			);
		}
		const expectedPause = pendingSummary(pending);
		const rulingPause = `等待${pending.channel}裁定:${pending.reason}`;
		if (flow.暂停 !== expectedPause && flow.暂停 !== rulingPause)
			fail("当前暂停文案不属于该结构化待决，拒绝清除并掩盖其他停因");
		if (
			flow.裁定 &&
			(flow.裁定.节点 !== pending.node || flow.裁定.轮次 !== pending.round || flow.裁定.通道 !== pending.channel)
		)
			fail("当前裁定不属于该待决，拒绝清除其他现场");
		flow.待决 = undefined;
		flow.暂停 = undefined;
		flow.裁定 = undefined;
		flow.记录.push({
			时间: clock.iso,
			事件: "无人值守待决办理完成",
			节点: pending.node,
			轮次: pending.round,
			理由:
				submission.skip?.reason === "no_worker_changes"
					? `待决 ${pending.key} 已逐项验收并交付；当前 attempt 无改动，无需创建提交`
					: submission.skip?.reason === "independent_review_evidence"
						? `待决 ${pending.key} 已逐项验收并交付审核证据；未合并副本，未创建业务提交`
						: `待决 ${pending.key} 已逐项验收、交付并交卷；提交 ${submission.提交哈希}`,
		});
		record.stage = "pending_cleared";
		record.updated_at = clock.iso;
		record.submission = submission;
		const contentTree = await currentContentTree(
			options,
			flow.节点.some((node) => node.判定?.结果 === "pass" || node.放行修复),
		);
		flow.状态 = persistedStatus(controlReport(flow, undefined, contentTree).status);
		saveControl(recipe, options, flow);
		return resolutionFlowStatus(flow);
	});

	const finalRecord = await withFileLock(controlPath(recipe, options), async () => {
		options.signal?.throwIfAborted();
		const flow = readControl(recipe, options);
		assertOwner(flow, options);
		assertTrustedUnattended(flow, options);
		const record = findPendingResolution(flow, input.pending_key);
		if (!record || record.input_digest !== digest) fail(`待决办理 ${input.pending_key} 记录已变化`);
		if (record.stage !== "pending_cleared")
			fail(`待决办理 ${input.pending_key} 当前阶段为 ${record.stage}，不能收尾`);
		if (flow.待决?.key === input.pending_key) fail("待决仍存在，拒绝伪称办理完成");
		record.stage = "completed";
		record.updated_at = clock.iso;
		saveControl(recipe, options, flow);
		return structuredClone(record);
	});

	return {
		pending_key: input.pending_key,
		stage: "completed",
		idempotent: false,
		submission: finalRecord.submission!,
		flow_status: flowStatus,
	};
}

/**
 * 记录待决办理后的自动推进已经由真实调用受理。
 * 只写既有待决办理记录，供工具重放区分“业务已办理但推进未受理”和“推进已经受理”。
 */
export async function markPendingResolutionAdvanceAccepted(
	recipe: WorkflowRecipe,
	options: DriverOptions,
	pendingKey: string,
): Promise<void> {
	await withFileLock(controlPath(recipe, options), async () => {
		options.signal?.throwIfAborted();
		const flow = readControl(recipe, options);
		assertOwner(flow, options);
		assertTrustedUnattended(flow, options);
		const record = findPendingResolution(flow, pendingKey);
		if (!record) fail(`找不到待决办理记录 ${pendingKey}，拒绝记录自动推进受理`);
		if (record.stage !== "completed") fail(`待决办理 ${pendingKey} 当前阶段为 ${record.stage}，不能记录自动推进受理`);
		if (record.advance?.status === "accepted") return;
		const clock = resolutionClock(options);
		record.advance = { status: "accepted", accepted_at: clock.iso };
		record.updated_at = clock.iso;
		saveControl(recipe, options, flow);
	});
}

/** 人工恢复必须提供看到的实例/原 owner 和现场核查说明；不由重启自动调用。 */
export async function resumeControl(
	recipe: WorkflowRecipe,
	options: DriverOptions,
	input: { 实例: string; 原owner: string; 现场核查: string },
): Promise<void> {
	await withFileLock(controlPath(recipe, options), async () => {
		options.signal?.throwIfAborted();
		const flow = readControl(recipe, options);
		const contentTree = await currentContentTree(
			options,
			readControl(recipe, options).节点.some((node) => node.判定?.结果 === "pass" || node.放行修复),
		);
		if (!options.ownerSessionId || flow.实例 !== input.实例 || flow.owner !== input.原owner || !input.现场核查.trim())
			fail(
				`恢复身份不符或缺现场核查说明；须提供 实例=${flow.实例}、prev_owner=${flow.owner}、reason=<现场核查说明>（pao_control_node action=resume）`,
			);
		if (flow.节点.some((n) => cardStates(flow, n).some((c) => c.frontmatter.status === "in_progress")))
			fail("仍有在途卡，先确认停止及卡状态");
		flow.owner = options.ownerSessionId;
		for (const node of flow.节点)
			if (node.判定?.结果 === "reject") {
				flow.记录.push({
					时间: new Date().toISOString(),
					事件: "人工撤回拒绝以重新判定",
					节点: node.名字,
					轮次: node.轮次,
					理由: input.现场核查,
				});
				node.判定 = undefined;
			}
		flow.暂停 = undefined;
		flow.裁定 = undefined;
		flow.待决 = undefined;
		flow.记录.push({ 时间: new Date().toISOString(), 事件: "人工恢复", 理由: input.现场核查 });
		flow.状态 = persistedStatus(controlReport(flow, undefined, contentTree).status);
		saveControl(recipe, options, flow);
	});
}

/** 当前项目根的 Git 内容树；工作流各读写入口共用这一份只读证据。 */
async function currentContentTree(options: DriverOptions, required: boolean): Promise<string | undefined> {
	if (!required) return undefined;
	return (await captureContentTree(projectRootForCards(options.cardsDir), options.signal)).tree;
}

/** 真实读面共用版本核对；同步投影不把未经核对的旧通过判定当作完成。 */
export async function readControlView(
	flow: FlowControl,
	options: DriverOptions,
	deadMinisters?: ReadonlySet<string>,
): Promise<ReturnType<typeof controlView>> {
	const tree = await currentContentTree(
		options,
		flow.节点.some((node) => node.判定?.结果 === "pass" || node.放行修复),
	);
	return controlView(flow, deadMinisters, tree);
}

export async function readControlReport(
	flow: FlowControl,
	options: DriverOptions,
	deadMinisters?: ReadonlySet<string>,
): Promise<DriveReport> {
	return reportFromView(await readControlView(flow, options, deadMinisters));
}

function gitOutput(
	args: string[],
	cwd: string,
	env?: NodeJS.ProcessEnv,
): Promise<{ code: number; text: string; error: string }> {
	return new Promise((done) =>
		execFile(
			"git",
			["-c", "core.quotepath=false", ...args],
			{
				cwd,
				windowsHide: true,
				timeout: GIT_READ_TIMEOUT_MS,
				maxBuffer: 16 * 1024 * 1024,
				env: env ? { ...process.env, ...env } : process.env,
			},
			(error, stdout, stderr) =>
				done({
					code: error ? 1 : 0,
					text: stdout,
					error: error ? gitProcessErrorText(error, stderr, GIT_READ_TIMEOUT_MS) : stderr,
				}),
		),
	);
}

/** 自足判定包：机械读卡及 git 基线内容；回执明确仅为宣称，未知处不捏造。 */
export async function buildDecisionPackage(
	recipe: WorkflowRecipe,
	options: DriverOptions,
	identity: NodeIdentity,
	processes: ProcessEntry[] = [],
): Promise<string> {
	const flow = readControl(recipe, options);
	assertOwner(flow, options);
	const tree = await currentContentTree(
		options,
		flow.节点.some((node) => node.判定?.结果 === "pass" || node.放行修复),
	);
	const node = identify(flow, identity, tree);
	const def = flow.冻结配方.节点.find((n) => n.名字 === node.名字)!;
	const sources = [node, ...def.depends_on.map((name) => flow.节点.find((n) => n.名字 === name)!)];
	const parts = [
		`# 判定包 ${flow.实例}/${node.名字}/第${node.轮次}轮`,
		`卡面轴：${substituteParams(def.验收, flow.参数)}`,
		`部门标准轴：${def.部门标准 ?? "未声明"}`,
		"两轴独立引用；机械验收已覆盖项不重复判。回执只是宣称，不能代替 diff 与运行证据。",
	];
	for (const source of sources) {
		parts.push(`## 节点 ${source.名字} 第${source.轮次}轮`);
		if (!source.基线) parts.push(`缺 diff 基线：${source.基线错误 ?? "未固定"}`);
		else {
			const diff = await gitOutput(
				["diff", "--no-ext-diff", "--no-textconv", source.基线.提交, "--", ...PROJECT_CONTENT_PATHSPECS],
				source.基线.项目根,
			);
			if (diff.code !== 0) throw new Error(`判定 diff 读取失败:${diff.error}`);
			parts.push(`基线:${source.基线.提交}\n已跟踪内容 diff:\n${diff.text}`);
			if (source.基线.未跟踪.length)
				parts.push(`基线已有未跟踪文件，内容变化未能归因，须独立核查:${source.基线.未跟踪.join("、")}`);
			const untracked = await gitOutput(
				["ls-files", "--others", "--exclude-standard", "-z", "--", ...PROJECT_CONTENT_PATHSPECS],
				source.基线.项目根,
			);
			if (untracked.code !== 0) throw new Error(`未跟踪文件读取失败:${untracked.error}`);
			for (const path of untracked.text
				.split("\0")
				.filter((p) => p && !p.startsWith(".pao/") && !source.基线!.未跟踪.includes(p)))
				parts.push(`新增未跟踪文件:${path}\n${readFileSync(join(source.基线.项目根, path), "utf8")}`);
		}
		for (const card of cardStates(flow, source)) {
			const actualEntries = processes.filter(
				(entry) =>
					typeof entry.card_path === "string" &&
					canonical(entry.card_path) === canonical(card.path) &&
					entry.attempt === card.frontmatter.attempt,
			);
			const actual = actualEntries.map((entry) => ({
				run_id: entry.run_id,
				dispatch_reason: entry.dispatch_reason,
			}));
			const receipt = currentAttemptReceipt(card);
			// 落卡协议固定把 receipt.evidence_path 放在 evidence[0]；恢复证据只能附后。
			// 这里只读取协议槽，是否可信仍由 worker facts helper 核对头尾卡、attempt 和 run_id。
			const evidencePath = receipt?.evidence?.[0]?.trim() || undefined;
			const receiptRunId =
				typeof receipt?.usage?.run_id === "string" && receipt.usage.run_id.trim()
					? receipt.usage.run_id.trim()
					: undefined;
			const registeredRunIds = [
				...new Set(
					actualEntries.map((entry) => entry.run_id?.trim()).filter((runId): runId is string => Boolean(runId)),
				),
			];
			let runId = registeredRunIds.length === 1 ? registeredRunIds[0] : receiptRunId;
			let runIssue: string | undefined;
			if (registeredRunIds.length > 1) {
				runIssue = `当前派单登记包含多个不同 run_id：${registeredRunIds.join("、")}；拒绝猜测证据归属`;
				runId = undefined;
			} else if (runId && receiptRunId && runId !== receiptRunId) {
				runIssue = `当前派单登记 run_id ${runId} 与当前回执 usage.run_id ${receiptRunId} 不一致`;
				runId = undefined;
			}
			const executionKey = {
				cardsDir: dirname(card.path),
				cardNo: card.card_no,
				attempt: card.frontmatter.attempt,
			};
			const bindingPath = executionContextPath(executionKey);
			const attemptBaselinePath = baselineSnapshotPath(
				executionKey.cardsDir,
				executionKey.cardNo,
				executionKey.attempt,
			);
			let binding: ReturnType<typeof readExecutionBinding> | undefined;
			let bindingIssue: string | undefined;
			try {
				binding = readExecutionBinding(executionKey);
			} catch (error) {
				bindingIssue = `当前 attempt 执行绑定不可用（${bindingPath}）：${
					error instanceof Error ? error.message : String(error)
				}`;
			}

			const programFacts = [
				`#### 程序采集事实（JSONL 工具事件与真实内容树；只读派生，不是回执宣称）`,
				`- 当前 attempt：${card.frontmatter.attempt}`,
				`- 执行绑定：${bindingPath}`,
				`- 标准基线：${attemptBaselinePath}`,
				`- 当前证据（evidence[0] 协议槽）：${evidencePath ?? "缺当前 attempt 回执或 receipt.evidence_path"}`,
				`- run_id：${runId ?? "未取得可唯一确认的 run_id"}`,
				"- 文件差异口径：当前执行根相对该 attempt 基线；可能包含后续任务写入，不能单凭这些差异归因工人。",
			];
			if (runIssue) programFacts.push(`- 运行事实不可用：${runIssue}`);

			if (!evidencePath) {
				programFacts.push("- 命令事实：未知；缺当前 attempt 证据路径");
			} else if (runIssue) {
				programFacts.push(`- 命令事实：未知；${runIssue}`);
			} else {
				const executionFacts = await readWorkerExecutionFacts(evidencePath, {
					cardPath: card.path,
					attempt: card.frontmatter.attempt,
					...(runId !== undefined ? { runId } : {}),
				});
				if (!executionFacts.complete) {
					programFacts.push(`- 命令事实：不可用；${executionFacts.issues.join("；") || "worker 证据不完整"}`);
				} else if (executionFacts.commands.length === 0) {
					programFacts.push("- 命令事实：可用；证据中没有 bash 或 powershell 命令");
				} else {
					programFacts.push("- 命令事实：可用");
					for (const command of executionFacts.commands) {
						programFacts.push(
							`  - 工具：${command.toolName}；toolCallId：${command.toolCallId}；结构化 exit_code：${
								command.exitCode === null ? "未知" : command.exitCode
							}；已结束：${command.completed ? "是" : "否"}；命令：${JSON.stringify(command.command)}`,
						);
					}
				}
			}

			if (bindingIssue) {
				programFacts.push(`- 文件改动事实：不可用；${bindingIssue}`);
			} else if (!evidencePath) {
				programFacts.push("- 文件改动事实：未知；缺当前 attempt 证据路径");
			} else if (runIssue) {
				programFacts.push(`- 文件改动事实：不可用；${runIssue}`);
			} else {
				const changeFacts = await readWorkerChangeFacts({
					binding: binding!,
					baselinePath: attemptBaselinePath,
					evidencePath,
					cardPath: card.path,
					...(runId !== undefined ? { runId } : {}),
					...(options.signal !== undefined ? { signal: options.signal } : {}),
				});
				if (changeFacts.available) {
					programFacts.push(
						"- 文件改动事实：可用",
						`  - created：${JSON.stringify(changeFacts.created)}`,
						`  - modified：${JSON.stringify(changeFacts.modified)}`,
						`  - deleted：${JSON.stringify(changeFacts.deleted)}`,
					);
				} else {
					programFacts.push(`- 文件改动事实：不可用；${changeFacts.reason ?? "未给出原因"}`);
				}
			}

			parts.push(
				`### ${card.path}\n派单登记理由:${
					actual.length ? JSON.stringify(actual) : "缺派单登记证据（不得从回执推断）"
				}\n\n${programFacts.join("\n")}\n\n#### 当前卡正文（完整原文，仅展示一次；回执 changes/verification 仅模型宣称）\n以下回执中的 changes/verification 仅为模型宣称，不是程序事实；程序事实见上方程序采集段。\n\n${readFileSync(card.path, "utf8")}\n\n${
					card.body.includes("## 机械验收") ? "验收记录见以上卡正文机械验收段" : "当前卡正文没有机械验收段"
				}`,
			);
		}
	}
	const path = join(
		options.workspaceDir ?? dirname(options.cardsDir),
		"判定包",
		`${flow.实例}-${node.轮次}-${randomUUID()}.md`,
	);
	writeFileAtomic(path, parts.join("\n\n"));
	return path;
}
