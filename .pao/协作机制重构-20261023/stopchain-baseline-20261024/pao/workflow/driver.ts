/**
 * 工作流机械驱动器（架构 §11.3，模型不在环）。
 * 驱动循环：找出「depends_on 全部已交付（人工门已确认）」的未跑节点 → 走 cards.createCard 落卡 → 交付即解锁下游。
 * 状态归属：真相只有卡（§11 定位）。实例清单 `工作流实例-<名字>.md` 只记 节点名↔卡号 映射、挂起原因、人工确认
 * 与叫人去重记录（§23 toast②），可从卡正文 pao-workflow 标记重建，永不反向成为任务真相。
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { stringify as stringifyYaml } from "yaml";

import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { formatCardNumber, parseCardRef } from "../cards/counter.ts";
import { type CardScanProblem, createCard, loadCard, scanCards } from "../cards/index.ts";
import type { CardStatus, ParsedCard } from "../cards/types.ts";
import { writeFileAtomic } from "../shared/atomic.ts";
import { withFileLock } from "../shared/lock.ts";
import { logWarn } from "../shared/log.ts";
import { parseWorkflowMarker, workflowMarker } from "../shared/marker.ts";
import { pathKey } from "../shared/path-key.ts";
import { nowString as sharedNowString } from "../shared/time.ts";
import { bar, glyphFor, treePrefix } from "../ui/glyphs.ts";
import {
	controlHumanCalled,
	controlReport,
	readControl,
	recordControlCalledHuman,
	startControl,
	tickControl,
} from "./control.ts";
import {
	type RecipeNode,
	requireParams,
	substituteParams,
	validateRecipeName,
	type WorkflowRecipe,
	WorkflowRecipeError,
} from "./recipe.ts";

/** 实例清单里的节点条目：只记映射、挂起原因与人工确认，不记卡状态（卡状态每次从卡现读）。 */
export interface ManifestNodeEntry {
	名字: string;
	卡号?: string;
	挂起?: string;
	/** 人工门点头记录（人为事件，重建清单后需重新确认） */
	确认?: string;
}

export interface WorkflowManifest {
	工作流: string;
	卡目录: string;
	启动: string;
	状态: "运行中" | "挂起" | "已完成";
	节点: ManifestNodeEntry[];
	/** 启动时代入的参数值（持久化进清单：断点续跑落卡时代入仍要用） */
	参数: Record<string, string>;
	/**
	 * §23 toast②叫人去重记录（挂起叫人键的返回值）：同一门实例只弹一次 toast。
	 * 必须落盘——去重状态放内存则进程一重启重弹（2026-10-03 线上事故）；确认点头即清（confirmWorkflowNode）。
	 */
	叫人?: string;
	/**
	 * S6-K2 自动链实例级累计：本实例从启动起自动链已派卡数（跨调用累计，落盘防后台续链把
	 * 单次上限重置成无限额度）。老清单缺该键＝0；每派一张卡 +1（bumpAutoChainDispatched）。
	 */
	已派卡?: number;
}

export interface DriverOptions {
	ownerSessionId?: string;
	/** 任务工作区的卡目录（createCard 落卡处） */
	cardsDir: string;
	/** 实例清单所在工作区目录；缺省取 cardsDir 上一级（任务目录） */
	workspaceDir?: string;
	/** 卡号计数器路径；缺省沿用 createCard 默认推导 */
	counterPath?: string;
	/** 当前工具调用的取消信号；取消只停止后续落卡，已落卡映射保留。 */
	signal?: AbortSignal;
	/** 时钟注入（测试用）；缺省取当前时间，格式 YYYY-MM-DD HH:mm */
	now?: () => string;
}

export interface NodeReport {
	card_refs?: string[];
	round?: number;
	name: string;
	card_no?: string;
	/** 值取自持久面读时投影：v2 控制流＝单域英文（无卡 no_card，S10 单源化）；v1 清单本地态 未落卡/读取异常 保留中文（表外） */
	status: CardStatus | "no_card" | "未落卡" | "读取异常";
	manual_confirm: boolean;
	confirmed?: string;
	hold?: string;
	/** 展示用并行元数据；当前只读，不触发并发调度。 */
	parallel_group_id?: string;
	branch_id?: string;
	join_id?: string;
	/** 审核回边，保持运行记录可解释。 */
	review_edges?: { target: string; limit: number; overflow_action: "停滞" | "修完这轮放行" }[];
}

export interface DriveReport {
	workflow: string;
	/** 实例流状态回包投影(持久面仍存 运行中/挂起/已完成,§4 仅回包投影用) */
	status: "running" | "hold" | "completed";
	/** 本次 tick 新落的卡 */
	created_cards: { node: string; card_no: string }[];
	nodes: NodeReport[];
	/** 附加说明（如清单缺失走重建视图） */
	note?: string;
	/** 可持久重读的停链原因；当前状态仍只由原有 running/hold/completed 表达。 */
	stop_reason?: string;
	stop_history?: { 时间: string; 事件: string; 节点?: string; 轮次?: number; 理由: string }[];
}

export class WorkflowDriverError extends Error {
	readonly code:
		| "FLOW_NOT_STARTED"
		| "FLOW_EXISTS"
		| "FLOW_NODE_NOT_GATED"
		| "FLOW_NODE_UNKNOWN"
		| "FLOW_NOT_DELIVERED";

	constructor(code: WorkflowDriverError["code"], message: string) {
		super(message);
		this.name = "WorkflowDriverError";
		this.code = code;
	}
}

// 流归属标记正本在 shared/marker.ts（cards 侧也用，反向 import 会成环）；转出口保持原导入面
export { parseWorkflowMarker, workflowMarker };
/** 时刻格式(测试可注入字符串钟;缺省走 shared/time 的唯一实现) */
function nowString(now?: () => string): string {
	return now ? now() : sharedNowString();
}

export function manifestPath(recipe: Pick<WorkflowRecipe, "名字">, options: DriverOptions): string {
	const workspaceDir = options.workspaceDir ?? dirname(options.cardsDir);
	return join(workspaceDir, `工作流实例-${recipe.名字}.md`);
}

function serializeManifest(manifest: WorkflowManifest): string {
	const body =
		"<!-- 驱动器维护：只记 节点名↔卡号 映射、挂起原因与人工确认；任务真相在卡上，映射可从卡正文 pao-workflow 标记重建 -->";
	const data: Record<string, unknown> = {
		工作流: manifest.工作流,
		卡目录: manifest.卡目录,
		启动: manifest.启动,
		状态: manifest.状态,
		参数: manifest.参数,
		节点: manifest.节点.map((entry) => {
			const row: Record<string, string> = { 名字: entry.名字 };
			if (entry.卡号 !== undefined) row.卡号 = entry.卡号;
			if (entry.挂起 !== undefined) row.挂起 = entry.挂起;
			if (entry.确认 !== undefined) row.确认 = entry.确认;
			return row;
		}),
	};
	// 叫人记录按需写入：老清单没有该键，序列化缺键保持兼容
	if (manifest.叫人 !== undefined) data.叫人 = manifest.叫人;
	if (manifest.已派卡 !== undefined) data.已派卡 = manifest.已派卡;
	return `---\n${stringifyYaml(data)}---\n${body}\n`;
}

export function parseManifest(content: string, filePath?: string): WorkflowManifest {
	const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
	// 格式版本与编辑版本分开：这里的「版本」是格式版本（1=旧清单 / 2=控制正本），不是编辑修订号。
	// 未知格式版本（如 3）一律拒绝降级读取：补默认值当 v1 会把新版现场误画成旧清单，属假成功。
	if (frontmatter.版本 !== undefined) {
		const where = filePath ? `（文件：${filePath}）` : "";
		if (frontmatter.版本 === 2) {
			throw new Error(
				`带版本控制的实例须经 v2 控制入口读取，不得降为旧映射${where}；` +
					"实例状态未变、原件保留，请用 v2 入口（pao_query_flow / 控制正本）读取，不要手工改版本号",
			);
		}
		throw new Error(
			`实例格式版本「${String(frontmatter.版本)}」不认识，只认 1（旧清单）与 2（控制正本）${where}；` +
				"原件保留不动，按新版处理须升级内核；不得当旧清单续跑，也不得手工改版本号掩盖",
		);
	}
	// 必要控制字段严格校验（浅字段分流修复 2026-10-04）：坏字段/缺字段显式抛错——
	// 不得降级伪装成「运行中」（在挂起扫描里＝伪装空闲），也不得静默当空映射；保留原件人工核对。
	const problems: string[] = [];
	for (const key of ["工作流", "卡目录", "启动"] as const) {
		const value = frontmatter[key];
		if (typeof value !== "string" || !value.trim()) problems.push(`缺必要控制字段「${key}」（须为非空字符串）`);
	}
	if (frontmatter.状态 !== "运行中" && frontmatter.状态 !== "挂起" && frontmatter.状态 !== "已完成") {
		problems.push(
			`控制字段「状态」${frontmatter.状态 === undefined ? "缺失" : `为 ${JSON.stringify(frontmatter.状态)}`}（须为 运行中/挂起/已完成），不得降级为运行中`,
		);
	}
	if (!Array.isArray(frontmatter.节点)) problems.push("缺必要控制字段「节点」（须为数组）");
	if (
		frontmatter.已派卡 !== undefined &&
		(!Number.isSafeInteger(frontmatter.已派卡) || (frontmatter.已派卡 as number) < 0)
	)
		problems.push("控制字段「已派卡」须为非负整数（自动链实例累计计数）");
	const rawNodes = Array.isArray(frontmatter.节点) ? frontmatter.节点 : [];
	const names = new Set<string>();
	const refs = new Set<number>();
	rawNodes.forEach((raw, index) => {
		const name = (raw as Record<string, unknown> | null)?.名字;
		if (typeof raw !== "object" || raw === null || typeof name !== "string" || !name.trim()) {
			problems.push(`节点[${index}] 缺「名字」（须为非空字符串）`);
		}
		if (typeof name === "string") {
			if (names.has(name)) problems.push(`重复节点「${name}」`);
			names.add(name);
		}
		const ref = (raw as Record<string, unknown> | null)?.卡号;
		if (ref !== undefined) {
			try {
				const number = parseCardRef(String(ref));
				if (refs.has(number)) problems.push(`重复卡号「${ref}」，一张卡不能归属多个节点`);
				refs.add(number);
			} catch {
				problems.push(`节点[${index}] 卡号「${String(ref)}」无效`);
			}
		}
	});
	if (problems.length > 0) {
		throw new Error(`实例清单损坏：${problems.join("；")}；保留原件人工核对，不得当空闲清理或自动续跑`);
	}
	const rawParams = frontmatter.参数;
	const params: Record<string, string> = {};
	if (typeof rawParams === "object" && rawParams !== null && !Array.isArray(rawParams)) {
		for (const [key, value] of Object.entries(rawParams as Record<string, unknown>)) {
			params[key] = String(value);
		}
	}
	return {
		工作流: frontmatter.工作流 as string,
		卡目录: frontmatter.卡目录 as string,
		启动: frontmatter.启动 as string,
		状态: frontmatter.状态 as WorkflowManifest["状态"],
		参数: params,
		叫人: frontmatter.叫人 === undefined ? undefined : String(frontmatter.叫人),
		已派卡: frontmatter.已派卡 as number | undefined,
		节点: rawNodes.map((raw) => {
			const node = raw as Record<string, unknown>;
			return {
				名字: node.名字 as string,
				卡号: node.卡号 === undefined ? undefined : String(node.卡号),
				挂起: node.挂起 === undefined ? undefined : String(node.挂起),
				确认: node.确认 === undefined ? undefined : String(node.确认),
			};
		}),
	};
}

function loadManifestFile(path: string): WorkflowManifest | undefined {
	if (!existsSync(path)) return undefined;
	return parseManifest(readFileSync(path, "utf8"), path);
}

function saveManifest(path: string, manifest: WorkflowManifest): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileAtomic(path, serializeManifest(manifest));
}

/** 从卡正文标记重建 节点↔卡号 映射（§11.2「可从卡重建」）。只统计属于本工作流的卡。 */
export function rebuildEntriesFromCards(recipe: WorkflowRecipe, cardsDir: string): ManifestNodeEntry[] {
	return scanWorkflowCards(recipe, cardsDir).entries;
}

/**
 * 重建映射并一并交出读不出来的卡（审查第 5 项）：读不出的卡可能正是本工作流已落的卡，
 * 只丢进「未落卡」会让续跑再落一张，所以问题必须外传给报告，不能在这里静默吞掉。
 */
export function scanWorkflowCards(
	recipe: WorkflowRecipe,
	cardsDir: string,
): { entries: ManifestNodeEntry[]; problems: CardScanProblem[] } {
	const entries: ManifestNodeEntry[] = [];
	if (!existsSync(cardsDir)) return { entries, problems: [] };
	const { cards, problems } = scanCards(cardsDir);
	for (const card of cards) {
		const marker = parseWorkflowMarker(card.body);
		if (!marker || marker.流 !== recipe.名字) continue;
		const nodeName = marker.节点;
		const node = recipe.节点.find((candidate) => candidate.名字 === nodeName);
		if (!node) continue; // 配方已改且节点已删的旧卡：不进映射，报告里按孤儿处理
		entries.push({ 名字: nodeName, 卡号: formatCardNumber(card.card_no) });
	}
	return { entries, problems };
}

interface NodeState {
	node: RecipeNode;
	entry: ManifestNodeEntry;
	卡?: ParsedCard;
	状态: CardStatus | "未落卡" | "读取异常";
	/** deps 全部完成（已交付且过人工门） */
	可落卡: boolean;
}

function evaluateStates(
	recipe: WorkflowRecipe,
	manifest: WorkflowManifest,
	options: DriverOptions,
): Map<string, NodeState> {
	const states = new Map<string, NodeState>();
	const byName = new Map(manifest.节点.map((entry) => [entry.名字, entry]));
	for (const name of recipe.拓扑序) {
		const node = recipe.节点.find((candidate) => candidate.名字 === name)!;
		const entry = byName.get(name) ?? { 名字: name };
		let card: ParsedCard | undefined;
		let status: CardStatus | "未落卡" | "读取异常" = "未落卡";
		if (entry.卡号 !== undefined) {
			try {
				card = loadCard(options.cardsDir, parseCardRef(entry.卡号));
				const marker = parseWorkflowMarker(card.body);
				if (marker && (marker.流 !== recipe.名字 || marker.节点 !== name)) {
					throw new Error(`卡 ${entry.卡号} 的流归属与节点「${name}」不一致`);
				}
				status = card.frontmatter.status;
			} catch {
				status = "读取异常";
			}
		}
		const done = (depName: string): boolean => {
			const dep = states.get(depName);
			if (!dep || dep.状态 !== "delivered") return false;
			const depNode = recipe.节点.find((candidate) => candidate.名字 === depName)!;
			return !depNode.人工确认 || dep.entry.确认 !== undefined;
		};
		states.set(name, {
			node,
			entry,
			卡: card,
			状态: status,
			可落卡: status === "未落卡" && node.depends_on.every(done),
		});
	}
	return states;
}

/** 人工门待点头的挂起文案（清单/报告/toast 判断共用一个口径，判人工门用结构化字段别再对文案）。 */
export const humanGateSuspendReason = "等待人工确认";

/**
 * 叫人去重键（§23 toast②）：同一门实例只弹一次 toast 的实例标识。
 * 结构化主判据＝报告里 挂起=人工门挂起原因 的节点（键 门:<节点>）；留 owner 无结构化信号，
 * 优先用卡在途节点（同一张卡是同一实例，键 owner:<节点>:<卡号>），没有再退化到停因文案。
 * 门换节点/换卡 → 键变 → 允许再叫；门被确认后再挂 → 记录已清（confirmWorkflowNode/confirmControl）→ 允许再叫。
 * S6：失败停链也去重（键 败:<节点,…>，同一失败现场只叫一次）；K3 起节点带轮次时键含轮次
 * （v2 控制报告恒带；v1 报告无轮次键不变）——同节点新轮次再失败＝新失败现场，允许再叫。
 */
export function suspendCallHumanKey(report: DriveReport, stopReason?: string): string | undefined {
	const keyed = (node: NodeReport) => (node.round === undefined ? node.name : `${node.name}:${node.round}`);
	const gate = report.nodes.find((node) => node.hold === humanGateSuspendReason);
	if (gate) return `门:${keyed(gate)}`;
	const failed = report.nodes.filter((node) => node.status === "failed");
	if (failed.length > 0) return `败:${failed.map(keyed).join(",")}`;
	if (stopReason === undefined || !stopReason.includes("留 owner")) return undefined;
	const inFlight = report.nodes.find((node) => node.status === "in_progress");
	return inFlight ? `owner:${inFlight.name}:${inFlight.card_no ?? ""}` : `owner:${stopReason}`;
}

/**
 * 查实例正本「叫人」记录：键一致＝该停链现场已叫过，不再弹。状态在盘上——跨进程（重启）不重弹。
 * v1＝实例清单、v2＝控制正本（K3 起落盘，v2 失败/人工门叫人与 v1 同语义去重）。
 * 正本缺失/损坏按未叫过（尽力而为路径不放大错误）。
 */
export function humanCalled(recipe: WorkflowRecipe, options: DriverOptions, key: string): boolean {
	if (recipe.版本 === 2) return controlHumanCalled(recipe, options, key);
	return loadManifestFile(manifestPath(recipe, options))?.叫人 === key;
}

/**
 * 叫人后把去重键落实例正本；同键幂等，写失败尽力而为（toast 已发出，不掩盖主流程）。
 * v1 直接写清单（既有口径）；v2 经 mutate 走主锁（正本多写者，不能裸写覆盖并发状态），故为异步。
 */
export async function recordCalledHuman(recipe: WorkflowRecipe, options: DriverOptions, key: string): Promise<void> {
	if (recipe.版本 === 2) return recordControlCalledHuman(recipe, options, key);
	const path = manifestPath(recipe, options);
	return withFileLock(path, () => {
		const manifest = loadManifestFile(path);
		if (!manifest || manifest.叫人 === key) return;
		manifest.叫人 = key;
		try {
			saveManifest(path, manifest);
		} catch (error) {
			logWarn(`[pao] 工作流叫人记录保存失败:${String(error)}`);
		}
	});
}

// ── S6-K2 自动链实例级累计（v1）：限额总量按实例计，累计住实例清单 ─────────────

/** 读实例已派卡累计（清单缺失/老清单无键＝0；缺失时链内下一步 tick 会按 FLOW_NOT_STARTED 抛错）。 */
export function readAutoChainDispatched(recipe: Pick<WorkflowRecipe, "名字">, options: DriverOptions): number {
	return loadManifestFile(manifestPath(recipe, options))?.已派卡 ?? 0;
}

/**
 * 已派卡 +delta 落实例清单。auto 是唯一调用方；返回 false 表示清单缺失，
 * 保存失败直接抛出。worker 受理前必须确认计数已落盘，否则跨调用累计仍会沿用旧值。
 */
export async function bumpManifestDispatched(
	recipe: Pick<WorkflowRecipe, "名字">,
	options: DriverOptions,
	delta = 1,
): Promise<boolean> {
	const path = manifestPath(recipe, options);
	return withFileLock(path, () => {
		const manifest = loadManifestFile(path);
		if (!manifest) return false;
		manifest.已派卡 = (manifest.已派卡 ?? 0) + delta;
		saveManifest(path, manifest);
		return true;
	});
}

/**
 * 已派卡 -delta 落实例清单，且不低于 0（审查第 11 项：未获受理的预留额度要归还）。
 * 读改写全在同一文件锁内，避免并发归还把计数压成负数；清单缺失不在此建。
 */
export async function refundManifestDispatched(
	recipe: Pick<WorkflowRecipe, "名字">,
	options: DriverOptions,
	delta = 1,
): Promise<void> {
	const path = manifestPath(recipe, options);
	return withFileLock(path, () => {
		const manifest = loadManifestFile(path);
		if (!manifest) return;
		manifest.已派卡 = Math.max(0, (manifest.已派卡 ?? 0) - delta);
		try {
			saveManifest(path, manifest);
		} catch (error) {
			logWarn(
				`[pao] 自动链实例计数归还落盘失败（限额可能偏严）:${error instanceof Error ? error.message : String(error)}`,
			);
		}
	});
}

function nodeHoldReason(state: NodeState, states: Map<string, NodeState>): string | undefined {
	if (state.状态 === "读取异常") {
		return `卡 ${state.entry.卡号} 读取失败（文件缺失或损坏），请核对卡目录`;
	}
	if (state.状态 === "failed" || state.状态 === "canceled") {
		return `节点「${state.node.名字}」${state.状态}，补齐后续跑`;
	}
	if (state.状态 === "delivered" && state.node.人工确认 && state.entry.确认 === undefined) {
		return humanGateSuspendReason;
	}
	if (state.状态 === "未落卡") {
		const failedDep = state.node.depends_on
			.map((dep) => states.get(dep)!)
			.find((dep) => dep.状态 === "failed" || dep.状态 === "canceled");
		if (failedDep) return `前置「${failedDep.node.名字}」${failedDep.状态}，失败即停（§11.3），补齐后续跑`;
	}
	return undefined;
}

/** 单次驱动 tick：落当前可落的卡、刷新挂起原因与流状态并写回实例清单。 */
export async function tickWorkflow(recipe: WorkflowRecipe, options: DriverOptions): Promise<DriveReport> {
	if (recipe.版本 === 2) return tickControl(recipe, options);
	options.signal?.throwIfAborted();
	const path = manifestPath(recipe, options);
	if (!existsSync(dirname(path)))
		throw new WorkflowDriverError("FLOW_NOT_STARTED", `工作流「${recipe.名字}」尚未启动（找不到 ${path}），先走启流`);
	return withFileLock(path, async () => {
		options.signal?.throwIfAborted();
		const manifest = loadManifestFile(path);
		if (!manifest) {
			throw new WorkflowDriverError(
				"FLOW_NOT_STARTED",
				`工作流「${recipe.名字}」尚未启动（找不到 ${path}），先走启流`,
			);
		}
		const savedDir = pathKey(resolve(manifest.卡目录));
		const currentDir = pathKey(resolve(options.cardsDir));
		if (savedDir !== currentDir) {
			throw new WorkflowDriverError(
				"FLOW_NOT_STARTED",
				`实例清单归属卡目录 ${manifest.卡目录}，与传入 ${options.cardsDir} 不一致，请核对任务工作区`,
			);
		}
		return runTick(recipe, manifest, path, options);
	});
}

async function runTick(
	recipe: WorkflowRecipe,
	manifest: WorkflowManifest,
	path: string,
	options: DriverOptions,
): Promise<DriveReport> {
	options.signal?.throwIfAborted();
	const states = evaluateStates(recipe, manifest, options);
	const newCard: DriveReport["created_cards"] = [];
	const now = nowString(options.now);
	const existingFailure = [...states.values()].some((state) => state.状态 === "failed" || state.状态 === "canceled");
	const existingCards = [...states.values()].some((state) => state.可落卡)
		? rebuildEntriesFromCards(recipe, options.cardsDir)
		: [];

	try {
		for (const name of recipe.拓扑序) {
			options.signal?.throwIfAborted();
			const state = states.get(name)!;
			// 落卡：depends_on 全部完成的未跑节点（走 cards 既有建卡导出，卡协议零改动）
			if (state.可落卡 && !existingFailure) {
				if (existingCards.some((entry) => entry.名字 === name)) {
					throw new Error(
						`节点「${name}」已有带归属标记的卡，但实例映射缺失；保留原件，人工核对后续跑，禁止重复落卡`,
					);
				}
				const depRefs = state.node.depends_on
					.map((dep) => states.get(dep)!.entry.卡号)
					.filter((ref): ref is string => ref !== undefined);
				const card = await createCard(
					options.cardsDir,
					{
						目标: substituteParams(state.node.目标, manifest.参数),
						部门: state.node.部门,
						验收: substituteParams(state.node.验收, manifest.参数),
						输入: state.node.输入?.map((item) => substituteParams(item, manifest.参数)),
						约束: state.node.约束 === undefined ? undefined : substituteParams(state.node.约束, manifest.参数),
						档位: state.node.档位,
						预算: state.node.预算,
						优先级: state.node.优先级,
						depends_on: depRefs,
						创建: now,
					},
					{
						counterPath: options.counterPath,
						signal: options.signal,
						模板正文: workflowMarker(recipe.名字, state.node.名字),
					},
				);
				// 卡及归属标记在首次原子写入时一并落盘。
				state.卡 = card;
				state.状态 = card.frontmatter.status;
				state.可落卡 = false;
				state.entry.卡号 = formatCardNumber(card.card_no);
				if (!manifest.节点.some((entry) => entry.名字 === name)) manifest.节点.push({ 名字: name });
				const entry = manifest.节点.find((candidate) => candidate.名字 === name)!;
				entry.卡号 = state.entry.卡号;
				entry.挂起 = undefined;
				newCard.push({ node: name, card_no: state.entry.卡号 });
			}
		}
		options.signal?.throwIfAborted();
	} catch (error) {
		// 中途异常（取消或落卡失败）也要把已建卡的映射落盘，不让实际存在的卡脱离工作流；保映射尽力而为不掩盖原始异常。
		if (manifest.节点.length > 0) {
			try {
				saveManifest(path, manifest);
			} catch {
				// 尽力而为
			}
		}
		throw error;
	}

	// 挂起原因刷新：人工门待点头 / 前置卡失败即停（正常等待前置不标挂起，是默认态）
	let anySuspended = false;
	for (const name of recipe.拓扑序) {
		const state = states.get(name)!;
		const suspend = nodeHoldReason(state, states);
		const entry = manifest.节点.find((candidate) => candidate.名字 === name);
		if (entry) entry.挂起 = suspend;
		if (suspend) anySuspended = true;
		state.entry.挂起 = suspend;
	}

	const allCompleted = recipe.拓扑序.every((name) => {
		const state = states.get(name)!;
		return state.状态 === "delivered" && (!state.node.人工确认 || state.entry.确认 !== undefined);
	});
	manifest.状态 = allCompleted ? "已完成" : anySuspended ? "挂起" : "运行中";
	saveManifest(path, manifest);

	return {
		workflow: recipe.名字,
		status: manifest.状态 === "已完成" ? "completed" : manifest.状态 === "挂起" ? "hold" : "running",
		created_cards: newCard,
		nodes: recipe.拓扑序.map((name) => {
			const state = states.get(name)!;
			return {
				name,
				card_no: state.entry.卡号,
				status: state.状态,
				manual_confirm: state.node.人工确认,
				confirmed: state.entry.确认,
				hold: state.entry.挂起,
				parallel_group_id: state.node.parallelGroupId,
				branch_id: state.node.branchId,
				join_id: state.node.joinId,
				review_edges: state.node.回边?.map((edge) => ({
					target: edge.目标,
					limit: edge.上限,
					overflow_action: edge.超限动作,
				})),
			};
		}),
	};
}

/**
 * 一键启动：校验参数 → 写实例清单 → 跑首个 tick（落第一批卡）。
 * 已有同名实例清单时拒绝重复启动（续跑走推流），防止同一流双实例。
 */
export async function startWorkflow(
	recipe: WorkflowRecipe,
	params: Record<string, string>,
	options: DriverOptions,
): Promise<DriveReport> {
	if (recipe.版本 === 2) return startControl(recipe, params, options);
	options.signal?.throwIfAborted();
	validateRecipeName(recipe.名字);
	requireParams(recipe, params);
	const path = manifestPath(recipe, options);
	mkdirSync(dirname(path), { recursive: true });
	return withFileLock(path, async () => {
		options.signal?.throwIfAborted();
		if (loadManifestFile(path)) {
			throw new WorkflowDriverError(
				"FLOW_EXISTS",
				`工作流「${recipe.名字}」已有实例清单（${path}），不重复启动；续跑走推流，查看走查流`,
			);
		}
		const manifest: WorkflowManifest = {
			工作流: recipe.名字,
			卡目录: options.cardsDir,
			启动: nowString(options.now),
			状态: "运行中",
			节点: [],
			参数: Object.fromEntries(recipe.占位符.map((name) => [name, params[name] ?? ""])),
		};
		mkdirSync(options.cardsDir, { recursive: true });
		return runTick(recipe, manifest, path, options);
	});
}

/** 人工门点头：仅对标记人工确认、卡已交付且未确认的节点生效；确认后立即续跑一个 tick。 */
export async function confirmWorkflowNode(
	recipe: WorkflowRecipe,
	nodeName: string,
	options: DriverOptions,
): Promise<DriveReport> {
	if (recipe.版本 === 2) throw new Error("v2 确认须携带实例及轮次，使用 pao_control_node 确认动作");
	options.signal?.throwIfAborted();
	const path = manifestPath(recipe, options);
	if (!existsSync(dirname(path)))
		throw new WorkflowDriverError("FLOW_NOT_STARTED", `工作流「${recipe.名字}」尚未启动（找不到 ${path}）`);
	return withFileLock(path, async () => {
		options.signal?.throwIfAborted();
		const manifest = loadManifestFile(path);
		if (!manifest) {
			throw new WorkflowDriverError("FLOW_NOT_STARTED", `工作流「${recipe.名字}」尚未启动（找不到 ${path}）`);
		}
		// 审查第 17 项：与 tickWorkflow 同款目录归属守卫。确认会写清单卡号并续跑 tick，
		// 若放过「工作区 A + 卡目录 B」的错配，会把 B 的卡号当 A 的进度写进 A 清单（任何写入前先拒）。
		const savedDir = pathKey(resolve(manifest.卡目录));
		const currentDir = pathKey(resolve(options.cardsDir));
		if (savedDir !== currentDir) {
			throw new WorkflowDriverError(
				"FLOW_NOT_STARTED",
				`实例清单归属卡目录 ${manifest.卡目录}，与传入 ${options.cardsDir} 不一致，请核对任务工作区`,
			);
		}
		const node = recipe.节点.find((candidate) => candidate.名字 === nodeName);
		if (!node) {
			throw new WorkflowDriverError("FLOW_NODE_UNKNOWN", `工作流「${recipe.名字}」没有节点「${nodeName}」`);
		}
		if (!node.人工确认) {
			throw new WorkflowDriverError(
				"FLOW_NODE_NOT_GATED",
				`节点「${nodeName}」未标人工确认，交付后自动放行，无须点头`,
			);
		}
		const entry = manifest.节点.find((candidate) => candidate.名字 === nodeName);
		if (entry?.卡号 === undefined) {
			throw new WorkflowDriverError("FLOW_NOT_DELIVERED", `节点「${nodeName}」尚未落卡，无从确认`);
		}
		const card = loadCard(options.cardsDir, parseCardRef(entry.卡号));
		const marker = parseWorkflowMarker(card.body);
		if (marker && (marker.流 !== recipe.名字 || marker.节点 !== nodeName)) {
			throw new Error(`卡 ${entry.卡号} 的流归属与节点「${nodeName}」不一致，拒绝确认`);
		}
		if (card.frontmatter.status !== "delivered") {
			throw new WorkflowDriverError(
				"FLOW_NOT_DELIVERED",
				`节点「${nodeName}」的卡 ${entry.卡号} 状态是 ${card.frontmatter.status}，已交付后才等人点头`,
			);
		}
		entry.确认 = nowString(options.now);
		entry.挂起 = undefined;
		// 确认即清叫人记录：同一个人工门确认后再挂起要允许重新叫人（§23 toast②去重的再挂分支）
		manifest.叫人 = undefined;
		return runTick(recipe, manifest, path, options);
	});
}

/**
 * 查流（只读聚合）：当前跑到哪个节点、各节点卡号与状态。
 * 状态一律从卡现读（真相在卡上），实例清单只提供映射；清单丢失时从卡标记重建内存映射，不落盘。
 */
export function queryWorkflow(recipe: WorkflowRecipe, options: DriverOptions): DriveReport {
	if (recipe.版本 === 2) return controlReport(readControl(recipe, options));
	const path = manifestPath(recipe, options);
	let manifest = loadManifestFile(path);
	let rebuild = false;
	let rebuildProblems: CardScanProblem[] = [];
	if (!manifest) {
		rebuild = true;
		const rebuilt = scanWorkflowCards(recipe, options.cardsDir);
		rebuildProblems = rebuilt.problems;
		manifest = {
			工作流: recipe.名字,
			卡目录: options.cardsDir,
			启动: "未知（清单缺失，从卡重建）",
			状态: "运行中",
			节点: rebuilt.entries,
			参数: {},
		};
	}
	const states = evaluateStates(recipe, manifest, options);
	let anySuspended = false;
	const nodes = recipe.拓扑序.map((name) => {
		const state = states.get(name)!;
		const suspend = nodeHoldReason(state, states);
		if (suspend) anySuspended = true;
		return {
			name,
			card_no: state.entry.卡号,
			status: state.状态,
			manual_confirm: state.node.人工确认,
			confirmed: state.entry.确认,
			hold: suspend,
			parallel_group_id: state.node.parallelGroupId,
			branch_id: state.node.branchId,
			join_id: state.node.joinId,
			review_edges: state.node.回边?.map((edge) => ({
				target: edge.目标,
				limit: edge.上限,
				overflow_action: edge.超限动作,
			})),
		};
	});
	const allCompleted = recipe.拓扑序.every((name) => {
		const state = states.get(name)!;
		return state.状态 === "delivered" && (!state.node.人工确认 || state.entry.确认 !== undefined);
	});
	const errorNode = nodes.filter((node) => node.status === "读取异常").map((node) => node.name);
	const description = [
		rebuild ? "实例清单缺失，本次从卡正文标记重建视图（未落盘）；续跑前先重建清单" : undefined,
		rebuildProblems.length > 0
			? `卡目录有 ${rebuildProblems.length} 张卡读不出来，本次重建视图不含它们（可能把已落卡的节点看成未落卡）：${rebuildProblems
					.map((problem) => `${problem.path}（${problem.reason}）`)
					.join("；")}`
			: undefined,
		errorNode.length > 0
			? `节点 ${errorNode.join("、")} 的卡读取失败（文件缺失或损坏），该节点按读取异常处理`
			: undefined,
	]
		.filter(Boolean)
		.join("；");
	return {
		workflow: recipe.名字,
		status: allCompleted ? "completed" : anySuspended ? "hold" : "running",
		created_cards: [],
		nodes,
		note: description === "" ? undefined : description,
	};
}

/** 渲染查流/推流报告为面向主控的中文文本（二批图形化：进度条＋树形连接符＋状态符号）。 */
export function renderReport(report: DriveReport): string {
	const lines: string[] = [`工作流「${report.workflow}」状态：${report.status}`];
	if (report.created_cards.length > 0) {
		lines.push(`本次落卡：${report.created_cards.map((item) => `${item.node}→${item.card_no}`).join("、")}`);
	}
	lines.push("节点进度：");
	const deliveredCount = report.nodes.filter((node) => node.status === "delivered").length;
	lines.push(`  进度 ${bar(deliveredCount, report.nodes.length)} ${deliveredCount}/${report.nodes.length}`);
	report.nodes.forEach((node, index) => {
		const gate = node.manual_confirm
			? node.confirmed
				? `［人工门已确认 ${node.confirmed}］`
				: "［人工门待确认］"
			: "";
		const hold = node.hold ? `，挂起：${node.hold}` : "";
		const glyph = glyphFor(node.status);
		lines.push(
			`  ${treePrefix(index, report.nodes.length)}${glyph ? ` ${glyph}` : ""} ${node.name}：${node.card_refs?.join("、") || node.card_no || "未落卡"}（${node.status}）${node.round ? ` 第${node.round}轮` : ""}${gate}${hold}`,
		);
	});
	if (report.note) lines.push(report.note);
	if (report.stop_reason) lines.push(`停链原因（可恢复）：${report.stop_reason}`);
	if (report.stop_history?.length) {
		const latest = report.stop_history.at(-1);
		if (latest && latest.理由 !== report.stop_reason) lines.push(`最近停链记录：${latest.时间} ${latest.理由}`);
	}
	return lines.join("\n");
}

export { WorkflowRecipeError };
