/** v2 流程控制正本。卡保留执行结果；本文件保留冻结图、轮次与决策，不从卡猜恢复状态。 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { stringify } from "yaml";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { baselineSnapshotPath, captureContentTree, PROJECT_CONTENT_PATHSPECS } from "../cards/baseline.ts";
import { executionContextPath, readExecutionBinding } from "../cards/execution-context.ts";
import {
	createCard,
	checkTransition,
	formatCardNumber,
	listCards,
	loadCard,
	parseCardRef,
	projectRootForCards,
} from "../cards/index.ts";
import type { CardFrontmatter, CardStatus, ParsedCard } from "../cards/types.ts";
import { reopenForReview, reopenOriginalCard } from "../cards/rework.ts";
import { readLatestVerdict, validateAcceptance } from "../cards/verifier.ts";
import { loadDispatchMapArtifact } from "../dispatch-brief/artifacts.ts";
import { parseDispatchUri } from "../dispatch-brief/uri.ts";
import { assertDispatchMapHandoff } from "../dispatch-brief/workspace.ts";
import { writeFileAtomic } from "../shared/atomic.ts";
import { gitSpawnErrorText } from "../shared/git.ts";
import { withFileLock } from "../shared/lock.ts";
import { pathKey } from "../shared/path-key.ts";
import { nowString } from "../shared/time.ts";
import { detectExecutionOccupancy } from "../worker/lock.ts";
import type { ProcessEntry } from "../worker/registry.ts";
import type { DriveReport, DriverOptions } from "./driver.ts";
import { requiresDispatchMapHandoff } from "./handoff.ts";
import { parseRecipe, type RecipeNode, requireParams, substituteParams, type WorkflowRecipe } from "./recipe.ts";

export const WORKFLOW_NODE_MAP_EVENT = "节点交接地图";

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
	节点: NodeControl[];
	回边次数: Record<string, number>;
	/** S6-K2 自动链实例级累计：本实例自动链已派卡数（跨调用累计，防后台续链重置单次上限；随派随记） */
	已派卡?: number;
	/** S6-K3 叫人去重（v2）：最近一次叫人的去重键（同 v1 清单「叫人」语义；undefined＝未叫过/已确认清空） */
	叫人?: string;
	暂停?: string;
	裁定?: { 节点: string; 轮次: number; 理由: string; 通道: "主控" | "人工" };
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
type ReviewEvidence = { kind: "verified"; tree: string } | { kind: "unverified" } | { kind: "blocked"; reason: string };
function reviewEvidence(card: ParsedCard, cardsDir: string, currentTree?: string): ReviewEvidence {
	const hasCurrentExecutionEvidence = (attempt: number): boolean =>
		existsSync(executionContextPath({ cardsDir, cardNo: card.card_no, attempt })) ||
		existsSync(baselineSnapshotPath(cardsDir, card.card_no, attempt));
	const verdict = readLatestVerdict(card.body);
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
	if (afterTree !== currentTree) return { kind: "blocked", reason: "检查后 tree 已过期，当前成果须重新独立验证" };
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
		const binding = readExecutionBinding({
			cardsDir,
			cardNo: card.card_no,
			attempt,
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
		const baseline = JSON.parse(readFileSync(baselineSnapshotPath(cardsDir, card.card_no, attempt), "utf8")) as {
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
	} catch (error) {
		return {
			kind: "blocked",
			reason: `最近验收的执行绑定不可核对（${error instanceof Error ? error.message : String(error)}）`,
		};
	}
	return { kind: "verified", tree: afterTree };
}
function reviewEvidenceHold(
	flow: FlowControl,
	node: NodeControl,
	decision: Decision,
	contentTree?: string,
): string | undefined {
	if (decision.结果 !== "pass") return undefined;
	try {
		const states = cardStates(flow, node).map((card) => reviewEvidence(card, flow.卡目录, contentTree));
		if (!states.length && !decision.理由.includes("未验证运行"))
			return "零卡审核未运行验证；放行理由须明确未验证运行";
		const blocked = states.find((state) => state.kind === "blocked");
		if (blocked?.kind === "blocked") return `审核证据不可放行：${blocked.reason}`;
		if (states.some((state) => state.kind === "unverified") && !decision.理由.includes("未验证运行"))
			return "审核证据含未验证运行的卡；放行理由须明确未验证运行";
		const seen = new Set(states.filter((state) => state.kind === "verified").map((state) => state.tree));
		if (seen.size > 1) return "审核证据不可放行：验证卡覆盖了多个成果版本";
		if (seen.size === 1 && contentTree !== [...seen][0])
			return "审核证据不可放行：验证卡检查后 tree 与当前成果不一致";
		return undefined;
	} catch (error) {
		return `审核证据不可核对（${error instanceof Error ? error.message : String(error)}）`;
	}
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
		const hold =
			(error ? `卡读取异常:${error}` : undefined) ??
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
							: def.审核 && !node.判定 && (!node.放行修复 || !(node.卡.length || node.零卡理由))
								? "等待节点判定"
								: reviewHold
									? reviewHold
									: def.人工确认 && !node.确认
										? "等待人工确认"
										: undefined);
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
	const stopReason =
		flow.暂停 ??
		(nodes.some((node) => node.状态 === "failed" || node.状态 === "canceled" || node.状态 === "读取异常")
			? stoppedBelow
			: undefined);
	return {
		工作流: flow.工作流,
		状态: flow.暂停
			? "挂起"
			: allDone
				? "已完成"
				: nodes.some((n) => n.状态 === "failed" || n.状态 === "canceled" || n.状态 === "读取异常")
					? "挂起"
					: "运行中",
		新建卡: [],
		节点: nodes,
		...(stopReason ? { 停链原因: stopReason } : {}),
		停链记录: flow.记录.filter((record) => record.事件 === "自动链停因"),
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
	requireParams(recipe, params);
	const frozen = structuredClone(recipe);
	for (const node of frozen.节点) {
		for (const key of ["部门", "目标", "验收", "约束", "模型", "思考强度", "部门标准"] as const)
			if (node[key] !== undefined) node[key] = substituteParams(node[key]!, params);
		if (node.输入) node.输入 = node.输入.map((value) => substituteParams(value, params));
		if (node.技能) node.技能 = node.技能.map((value) => substituteParams(value, params));
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
			参数: { ...params },
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
function identify(flow: FlowControl, identity: NodeIdentity, contentTree?: string): NodeControl {
	const node = flow.节点.find((n) => n.名字 === identity.节点);
	if (
		identity.实例 !== flow.实例 ||
		!node ||
		identity.轮次 !== node.轮次 ||
		!identity.部长会话 ||
		identity.部长会话 !== node.部长会话
	)
		fail("旧轮次、错误实例或部长会话；拒绝推进当前节点");
	if (flow.暂停 || !ready(flow, node, projectRootForCards(flow.卡目录), contentTree)) fail("实例已暂停或前置未完成");
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
	for (const input of inputs) validateAcceptance(substituteParams(input.acceptance, flow.参数), projectRoot);
	const added: string[] = [];
	for (const input of inputs) {
		options.signal?.throwIfAborted();
		const card = await createCard(
			options.cardsDir,
			{
				...input,
				部门: def.部门,
				目标: substituteParams(input.goal, flow.参数),
				验收: substituteParams(input.acceptance, flow.参数),
				输入: [
					...(def.输入 ?? []),
					...(input.inputs ?? []),
					...(node.重做理由 ? [`本轮重做理由:${node.重做理由}`] : []),
				].map((s) => substituteParams(s, flow.参数)),
				约束: [def.约束, input.constraints]
					.filter(Boolean)
					.map((s) => substituteParams(s!, flow.参数))
					.join("\n"),
				档位: node.轮次 > 3 ? "primary" : def.档位,
				预算: input.budget ?? def.预算,
				depends_on: def.depends_on.flatMap((name) => flow.节点.find((n) => n.名字 === name)!.卡),
				创建: options.now?.() ?? nowString(),
			},
			{
				counterPath: options.counterPath,
				signal: options.signal,
				模板正文: `<!-- pao-workflow:流=${recipe.名字}/节点=${node.名字} -->\n<!-- pao-workflow-v2:实例=${flow.实例}/轮次=${node.轮次} -->`,
			},
		);
		const ref = formatCardNumber(card.card_no);
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
				(entry) =>
					entry.事件 === WORKFLOW_NODE_MAP_EVENT &&
					entry.节点 === node.名字 &&
					entry.轮次 === node.轮次,
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
	const initialTree = await currentContentTree(options, decision.结果 === "pass");
	await mutate(recipe, options, async (flow) => {
		const contentTree = decision.结果 === "pass" ? initialTree : undefined;
		if (decision.结果 === "pass") {
			const lockedTree = await currentContentTree(options, true);
			if (initialTree !== lockedTree) fail("判定期间成果内容发生变化，须重新核验");
		}
		if (requestedRuling) {
			if (
				flow.裁定?.通道 !== requestedRuling ||
				flow.裁定.节点 !== identity.节点 ||
				flow.裁定.轮次 !== identity.轮次
			)
				fail("没有匹配的主控裁定请求");
			flow.记录.push({
				时间: new Date().toISOString(),
				事件: `${requestedRuling}裁定`,
				节点: identity.节点,
				轮次: identity.轮次,
				理由: decision.理由,
			});
			flow.暂停 = undefined;
			flow.裁定 = undefined;
		}
		const node = identify(flow, identity, contentTree);
		const def = flow.冻结配方.节点.find((n) => n.名字 === node.名字)!;
		if (!def.审核 || !node.拆解结束 || !cardStates(flow, node).every((c) => c.frontmatter.status === "delivered"))
			fail("审核判定须在拆解结束且全部卡机械交付后");
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
			!["pass", "change", "reject"].includes(decision.结果) ||
			!decision.理由.trim() ||
			decision.理由.length > 1600 ||
			(decision.理由.match(/[\p{Script=Han}]|[\p{L}\p{N}_]+/gu)?.length ?? 0) > 400 ||
			!decision.引用.length ||
			decision.引用.some((ref) => !/^.+:\d+/.test(ref))
		)
			fail("判定须含理由（最多 400 词，中文逐字计；最多 1600 字符）与 file:line 引用");
		if (decision.结果 !== "pass" && !["card", "dept_standard", "both"].includes(decision.失败轴 ?? ""))
			fail("打回或拒绝须标明失败轴");
		if (
			decision.建议 !== undefined &&
			(!Array.isArray(decision.建议) || decision.建议.some((item) => typeof item !== "string" || !item.trim()))
		)
			fail("改进建议须为非空文本列表；不自动扩大原任务验收范围");
		const evidenceHold = reviewEvidenceHold(flow, node, { ...decision, 时间: new Date().toISOString() }, contentTree);
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

function receiptConflict(card: ParsedCard): boolean {
	const receipts = card.receipts.filter(
		(receipt) => !receipt.archive_flag && receipt.attempt >= card.frontmatter.attempt,
	);
	return (
		receipts.length > 1 ||
		receipts.some(
			(receipt) => receipt.attempt > card.frontmatter.attempt || card.frontmatter.status === "unclaimed",
		)
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
			const current = new Map(
				node.卡.map((ref) => [parseCardRef(ref), loadCard(flow.卡目录, parseCardRef(ref))]),
			);
			const cards = requested.map((cardNo) => {
				const card = current.get(cardNo);
				if (!card) fail(`卡${formatCardNumber(cardNo)}不属于当前节点，不能借返修新增任务`);
				if (card.frontmatter.status !== "delivered" && card.frontmatter.status !== "failed")
					fail(`卡${formatCardNumber(cardNo)}当前状态为 ${card.frontmatter.status}，只有已交付或失败卡可返修`);
				if (card.body.split(roundMarker).length !== 2)
					fail(`卡${formatCardNumber(cardNo)}的流程身份已损坏或不属于当前轮`);
				if (!card.frontmatter.owner?.trim())
					fail(`卡${formatCardNumber(cardNo)}没有 owner；无法确认返修写者`);
				checkTransition({
					from: card.frontmatter.status === "delivered" ? "failed" : card.frontmatter.status,
					to: "unclaimed",
					尝试: card.frontmatter.attempt,
					卡号: card.card_no,
					卡目录: dirname(card.path),
				});
				if (receiptConflict(card))
					fail(`卡${formatCardNumber(cardNo)}有回执归属冲突；先核对当前 attempt 与回执，不返修`);
				return card;
			});
			if (activeWorkerForCards(flow, cards, processes))
				fail("待返修卡仍有登记中的活工人；先终止并确认停止");
			const cardsProjectRoot = projectRootForCards(flow.卡目录);
			for (const card of cards) {
				const cardLabel = formatCardNumber(card.card_no);
				let binding;
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
export async function pauseControl(
	recipe: WorkflowRecipe,
	options: DriverOptions,
	reason: string,
): Promise<void> {
	await mutate(recipe, options, (flow) => {
		if (!reason.trim()) fail("暂停理由不能为空");
		flow.暂停 = reason;
	});
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
		const latest = [...flow.记录].reverse().find((record) => record.事件 === "自动链停因");
		if (latest?.理由 === reason && latest.节点 === stop.节点 && latest.轮次 === stop.轮次) return;
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
 * S6-K2 自动链实例级累计（v2）：已派卡 +delta 落控制正本。经 mutate 走主锁并重核 owner——
 * 自动链调用方持有 .dispatch 锁（与主锁不同文件），锁序 .dispatch→主控锁与链内 tick 同序。
 * delta 可为负（审查第 11 项：未获受理的预留额度归还），结算结果不低于 0。
 */
export function bumpControlDispatched(recipe: WorkflowRecipe, options: DriverOptions, delta: number): Promise<void> {
	return mutate(recipe, options, (flow) => {
		flow.已派卡 = Math.max(0, (flow.已派卡 ?? 0) + delta);
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
export async function requestRuling(
	recipe: WorkflowRecipe,
	options: DriverOptions,
	identity: NodeIdentity,
	reason: string,
	ownerPresent: boolean,
): Promise<void> {
	const tree = await currentContentTree(
		options,
		readControl(recipe, options).节点.some((node) => node.判定?.结果 === "pass" || node.放行修复),
	);
	await mutate(recipe, options, (flow) => {
		const node = identify(flow, identity, tree);
		const def = flow.冻结配方.节点.find((n) => n.名字 === node.名字)!;
		if (!reason.trim()) fail("裁定理由不能为空");
		const channel = def.允许请求主控裁定 && ownerPresent ? "主控" : "人工";
		flow.裁定 = { 节点: node.名字, 轮次: node.轮次, 理由: reason, 通道: channel };
		flow.暂停 = `等待${channel}裁定:${reason}`;
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
			{ cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env },
			(error, stdout, stderr) =>
				done({ code: error ? 1 : 0, text: stdout, error: stderr || (error ? gitSpawnErrorText(error) : "") }),
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
			const actual = processes
				.filter(
					(entry) =>
						entry.card_path &&
						canonical(entry.card_path) === canonical(card.path) &&
						entry.attempt === card.frontmatter.attempt,
				)
				.map((entry) => ({ run_id: entry.run_id, dispatch_reason: entry.dispatch_reason }));
			parts.push(
				`### ${card.path}\n派单登记理由:${actual.length ? JSON.stringify(actual) : "缺派单登记证据（不得从回执推断）"}\n${readFileSync(card.path, "utf8")}\n${card.body.includes("## 机械验收") ? "验收记录见以上卡正文机械验收段" : "缺运行证据"}\n回执证据引用:${card.receipts.flatMap((r) => r.evidence ?? []).join("、") || "缺运行证据"}`,
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
