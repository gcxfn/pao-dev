/**
 * 工作流工具与命令注册（架构 §11 v1＝M2a：只做手动一键，定时/事件触发暂缓）。
 * 模型面：pao_start_flow / pao_push_flow / pao_query_flow / pao_confirm_flow；用户面：/pao flow（启动或列配方）、/pao flow see、/pao flow confirm。
 * 两面统一收口（2026-10-03）：前置解析各管各的（命令面解析 args 字符串、工具面解析结构化参数），
 * 核心执行共用文末 *Core 一段——改行为只改核心，不许在任一面另写平行逻辑（反漂移钉见 workflow-tools.test.ts 同口径组）。
 * 路径全部注入式解析（PAO_HOME 用环境变量，卡目录/工作区由接线层给），不硬编码。
 * worker 派发不在本层：落卡后由接线层把新卡交给 pao_fanout（配合点说明见模块尾部）。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionToolContext,
} from "../../core/extensions/types.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { formatCardNumber, loadCard, parseCardRef, projectRootForCards } from "../cards/index.ts";
import { addPaoSubcommand } from "../command-router.ts";
import { toastEnabled } from "../host/config.ts";
import { paoHome as defaultPaoHome } from "../knowledge/paths.ts";
import { sendToast } from "../notify/toast.ts";
import { checkPreflight, renderPreflight } from "../preflight/index.ts";
import { logWarn } from "../shared/log.ts";
import { pathKey } from "../shared/path-key.ts";
import { defaultWorkerRunner } from "../worker/index.ts";
import {
	createDispatchNotifySurface,
	type DispatchNotifyEvent,
	type DispatchNotifySurface,
	sendDispatchNotifyWakeup,
} from "../worker/notify.ts";
import type { WorkerRunner } from "../worker/runner.ts";
import { checkIndependentReviewWorktreeCapability } from "../worktrees/types.ts";
import { type AutoChainOptions, type AutoChainReport, renderAutoChain, runAutoChain } from "./auto.ts";
import {
	buildDecisionPackage,
	confirmControl,
	type Decision,
	decideNode,
	pauseControl,
	readControl,
	readControlReport,
	reopenControl,
	resumeControl,
	reworkControl,
} from "./control.ts";
import { distillRecipe, emitRecipeMarkdown, saveRecipe } from "./distill.ts";
import {
	confirmWorkflowNode,
	type DriveReport,
	type DriverOptions,
	humanCalled,
	humanGateSuspendReason,
	manifestPath,
	parseManifest,
	queryWorkflow,
	recordCalledHuman,
	renderReport,
	startWorkflow,
	suspendCallHumanKey,
	tickWorkflow,
	WorkflowDriverError,
} from "./driver.ts";
import { type PlanToolsOptions, registerPlanTools } from "./plan-tools.ts";
import {
	deleteRecipe,
	isWorkflowRecipeError,
	listRecipes,
	loadRecipe,
	validateRecipeName,
	type WorkflowRecipe,
	WorkflowRecipeError,
} from "./recipe.ts";
import { buildReviewReport, buildV2ReviewReport, renderReviewReport, WORKFLOW_REVIEW_SECTION } from "./review.ts";

/** 两面共用的注册态：终态复盘入队是注册闭包的会话内存态（命令面/工具面共用同一队列），toast 开关与 pao_start_flow 同源解析。 */
export interface WorkflowCommon {
	queueReview: (report: DriveReport, cardsDir: string) => void;
	/** toast 开关用的 PAO_HOME（保温.json「toast 通知」位置） */
	paoHome?: string;
	/** S6 后台受理面：注册闭包提供＝工具/命令两面受理即返；缺省（直调核心）保持同步推进到终局——既有直调口径。 */
	background?: AutoChainBackground;
}

/**
 * S6-K1 后台自动链受理面（pao_dispatch_card 后台受理模式推广到自动链，不另起新模式）：
 * 受理即返——首 tick 落卡/控制正本快照同步做（快速失败＋快照），worker 终局起在宿主内
 * fire-and-forget 推进（回执→越界核查→验收→交卷→解锁下游循环，复用 runAutoChain/部长驱动原体，
 * 不新建守护服务；文件锁与执行登记随链原样生效）。
 * 不接工具 signal（派单先例）：取消语义由 runner 树杀承担（session_shutdown/pao_stop_background/pao_terminate_card）。
 * inFlight 按流登记防并发双跑；链停/失败/完成进通知缓冲（下一轮 before_agent_start 注入＋叫人 toast）。
 * K2 衔接：maxCards 等选项原样透传 runAutoChain——实例级限额累计的计数点留在 runAutoChain 入口，本面不重置不重授。
 */
export interface AutoChainBackground {
	/** 受理一次自动链推进（useDrive＝v2 部长驱动段），返回受理文本（含当前已落卡/已派发快照）。 */
	accept(
		recipe: WorkflowRecipe,
		options: AutoChainOptions,
		firstReport: DriveReport | undefined,
		useDrive: boolean,
	): Promise<string>;
	/** 等全部在途链收敛（测试与收尾用）；链体永不 reject（异常进通知缓冲）。 */
	waitForAutoChain(): Promise<void>;
	/** 当前后台自动链数量（生命周期宿主据此判断是否仍有在途工作）。 */
	backgroundCount(): { inFlight: number };
}

function autoChainCardIdentity(
	options: AutoChainOptions,
	flow: ReturnType<typeof readControl> | undefined,
	refs: readonly string[],
) {
	if (flow === undefined) return [];
	return [...new Set(refs)].sort().map((ref) => {
		const card = loadCard(options.cardsDir, parseCardRef(ref));
		return {
			card: formatCardNumber(card.card_no),
			status: card.frontmatter.status,
			attempt: card.frontmatter.attempt,
			completed: card.frontmatter.completed,
			// 完整当前有效回执参与身份：verification、changes 等业务变化不能被误判为旧事件。
			receipts: card.receipts.filter(
				(receipt) => receipt.archive_flag === undefined && receipt.attempt === card.frontmatter.attempt,
			),
		};
	});
}

/**
 * 自动链事件身份取当前业务事实，不解析正文，也不纳入历史轮、历史回执、停链记录或机械步骤。
 * owner 控制动作、当前节点/卡/尝试、当前有效回执变化都会产生新状态；通知 key 使用同一业务状态，
 * 避免重复执行产生相同停因时反复唤醒。
 */
function autoChainNoticeKey(
	recipe: WorkflowRecipe,
	options: AutoChainOptions,
	chain: AutoChainReport,
	flow: ReturnType<typeof readControl> | undefined,
): string {
	const state = {
		workflow: recipe.名字,
		instance: flow?.实例 ?? recipe.文件路径,
		owner: flow?.owner,
		parameters: flow?.参数,
		paused: flow?.暂停,
		ruling: flow?.裁定,
		controlStatus: flow?.状态,
		status: chain.report.status,
		stopReason: chain.report.stop_reason,
		nodes: (flow?.节点 ?? chain.report.nodes).map((node) => {
			const name = "轮次" in node ? node.名字 : node.name;
			const report = chain.report.nodes.find((candidate) => candidate.name === name);
			return "轮次" in node
				? {
						name: node.名字,
						round: node.轮次,
						cards: node.卡,
						decompositionEnded: node.拆解结束,
						zeroCardReason: node.零卡理由,
						ministerSession: node.部长会话,
						confirmed: node.确认,
						decision: node.判定,
						reworkReason: node.重做理由,
						repairReleased: node.放行修复,
						status: report?.status,
						hold: report?.hold,
					}
				: {
						name: node.name,
						round: node.round,
						cards: node.card_refs,
						manualConfirm: node.manual_confirm,
						confirmed: node.confirmed,
						status: node.status,
						hold: node.hold,
					};
		}),
		cards: autoChainCardIdentity(options, flow, [
			...(flow?.节点.flatMap((node) => node.卡) ?? []),
			...(flow === undefined ? chain.report.nodes.flatMap((node) => node.card_refs ?? []) : []),
		]),
	};
	const notice = {
		state,
		stopReason: chain.stopReason,
		waitingForEvent: chain.waitingForEvent === true,
	};
	return createHash("sha256").update(JSON.stringify(notice)).digest("hex");
}

/** 已派发快照：登记表里本卡目录下仍在跑的 worker 行（runner 登记即「已派发」事实源，盘点 ①）。 */
function activeWorkerLines(options: AutoChainOptions): string {
	const root = resolve(options.cardsDir);
	const active = options.运行器.registry
		.list()
		.filter((entry) => entry.running && entry.card_no && (entry.card_path ?? "").startsWith(root));
	if (active.length === 0) return "- 后台进程:无在跑 worker";
	return `- 后台进程 ${active.length} 个在跑:${active.map((entry) => `卡${entry.card_no}`).join("、")}`;
}

/**
 * §23 toast②:自动链停在「等人工门/留 owner/失败」时叫人(人可能走开);人工门按报告结构化挂起判（挂起=人工门挂起原因），
 * 留 owner 无结构化信号只认停因文案。
 * S6 修正（原「在场敲命令者已见摘要」假设随后台化失效——受理即返后停因不再同步回到场者）：失败停链也须叫人，
 * 终局在后台发生,失败不叫＝用户只能等下一次工具调用才得知;完成仍不叫(终态复盘提醒已覆盖)。
 * 去重：同一停链现场只弹一次——键（挂起叫人键）落实例正本「叫人」字段（v1 清单/v2 控制正本，盘上跨进程持久，
 * 2026-10-03 线上事故：每次评估挂起链都重弹）；门换节点/换卡或确认后再挂起才再叫。开关=保温.json「toast 通知」,缺省开;尽力而为。
 * 键粒度：节点带轮次时含轮次（v2）——同节点新轮次再失败＝新失败现场会再叫；v1 无轮次键不变。
 */
async function toastIfHeld(
	recipe: WorkflowRecipe,
	chain: AutoChainReport,
	driverOptions: DriverOptions,
	common: WorkflowCommon,
): Promise<void> {
	if (chain.stopReason === undefined) return;
	const waitForHumanGate = chain.report.nodes.some((node) => node.hold === humanGateSuspendReason);
	const failed = chain.report.nodes.some((node) => node.status === "failed");
	if (!waitForHumanGate && !failed && !chain.stopReason.includes("留 owner")) return;
	const key = suspendCallHumanKey(chain.report, chain.stopReason);
	if (key === undefined || !humanCalled(recipe, driverOptions, key)) {
		void sendToast(
			`PAO 工作流「${recipe.名字}」${failed ? "失败停链" : "停下等人"}`,
			chain.stopReason.slice(0, 200),
			{
				enabled: toastEnabled(common.paoHome),
			},
		);
	}
	if (key !== undefined) await recordCalledHuman(recipe, driverOptions, key);
}

// ── 命令/工具统一核心（两面共用，改行为只改这里）────────────────────────────

/**
 * 自动执行链推进段（S6）：注册闭包提供受理面时后台受理即返（首 tick/快照同步）；直调核心
 * （测试/内联路径）无受理面，保持同步推进到终局。v2 部长驱动段（useDrive）与 runAutoChain 段的
 * 后处理分野保持既有口径：驱动段只渲染，链段含叫人 toast 与终态复盘入队。
 */
async function runAutoChainPhase(
	recipe: WorkflowRecipe,
	options: AutoChainOptions,
	firstReport: DriveReport | undefined,
	common: WorkflowCommon,
	useDrive: boolean,
): Promise<string> {
	if (common.background) return common.background.accept(recipe, options, firstReport, useDrive);
	if (useDrive && options.driveDepartments) return renderAutoChain(await options.driveDepartments(recipe, options));
	const chain = await runAutoChain(recipe, options, firstReport);
	// 显式全停只保留真实终局与停因；toast 和终态复盘都会请求模型处理，不能再发起。
	if (!options.运行器.isStopped()) {
		await toastIfHeld(recipe, chain, options, common);
		common.queueReview(chain.report, options.cardsDir);
	}
	return renderAutoChain(chain);
}

/** 启流核心：校验参数→写实例清单→落首批卡；自动执行配方直接进自动链（含人工门叫人与终态复盘入队）。 */
export async function startWorkflowCore(
	recipe: WorkflowRecipe,
	params: Record<string, string>,
	options: AutoChainOptions,
	common: WorkflowCommon,
): Promise<string> {
	options.signal?.throwIfAborted();
	if (recipe.节点.some((node) => node.人工确认) && options.hostHasUI !== true)
		throw new Error("配方含人工确认门，但当前宿主没有可核验的交互界面；启流前拒绝，避免无人值守越过人工门");
	if (recipe.节点.some((node) => node.只读 && node.审核)) {
		const capability = await checkIndependentReviewWorktreeCapability(
			options.worktreeHost,
			projectRootForCards(options.cardsDir),
		);
		if (!capability.ok) throw new Error(`配方要求独立审核验证，但${capability.reason}；须提供隔离验证能力后再启动`);
	}
	if (recipe.版本 === 2) {
		if (!options.paoHome) throw new Error("v2 工作流启动须指定 PAO_HOME 以核对部门与技能");
		const replace = (text: string) => text.replace(/\{([^{}\s]+)\}/g, (all, key: string) => params[key] ?? all);
		const report = checkPreflight({
			project: projectRootForCards(options.cardsDir),
			paoHome: options.paoHome,
			departments: [...new Set(recipe.节点.map((node) => replace(node.部门)))],
			skills: [...new Set(recipe.节点.flatMap((node) => (node.技能 ?? []).map(replace)))],
			parameters: params,
			requiredParameters: recipe.参数,
		});
		if (!report.canStart) throw new Error(renderPreflight(report));
	}
	const first = await startWorkflow(recipe, params, options);
	// v2 启流回执尾注：恢复三件套与部长死因排查落点，只描述规则不编造状态（query/push 回包不含）
	const hint =
		recipe.版本 === 2
			? `提示：实例暂停/主会话关闭后 push 不会自动重开部长；恢复用 pao_control_node（action=resume，须实例号＋原owner＋现场核查三件套）。部长启动失败时错误带 stderr 尾摘要，全量留证在 ${join(projectRootForCards(options.cardsDir), ".pao", "部长留证")}${sep}。`
			: undefined;
	if (recipe.版本 === 2 && options.driveDepartments)
		return withHint(await runAutoChainPhase(recipe, options, undefined, common, true), hint);
	if (!recipe.自动执行) {
		common.queueReview(first, options.cardsDir);
		return withHint(renderReport(first), hint);
	}
	return withHint(await runAutoChainPhase(recipe, options, first, common, false), hint);
}

/** 回执文本追加尾注行（无尾注时原样返回）。 */
function withHint(text: string, hint: string | undefined): string {
	return hint ? `${text}\n${hint}` : text;
}

/** 推流核心：自动执行配方走自动链续跑（直到停因），手动配方单 tick 落卡解锁下游。 */
export async function tickWorkflowCore(
	recipe: WorkflowRecipe,
	options: AutoChainOptions,
	common: WorkflowCommon,
): Promise<string> {
	if (recipe.版本 === 2 && options.driveDepartments)
		return runAutoChainPhase(recipe, options, undefined, common, true);
	if (recipe.自动执行) return runAutoChainPhase(recipe, options, undefined, common, false);
	const report = await tickWorkflow(recipe, options);
	common.queueReview(report, options.cardsDir);
	return renderReport(report);
}

/** 查流核心（只读聚合）：两面同一渲染。 */
export async function queryWorkflowCore(recipe: WorkflowRecipe, options: DriverOptions): Promise<string> {
	return renderReport(
		recipe.版本 === 2
			? await readControlReport(readControl(recipe, options), options)
			: queryWorkflow(recipe, options),
	);
}

/** 确认核心：人工门点头续跑（放行下游）；自动执行配方点头后接自动链。 */
export async function confirmWorkflowCore(
	recipe: WorkflowRecipe,
	nodeName: string,
	options: AutoChainOptions,
	common: WorkflowCommon,
): Promise<string> {
	const report = await confirmWorkflowNode(recipe, nodeName, options);
	if (!recipe.自动执行) {
		common.queueReview(report, options.cardsDir);
		return renderReport(report);
	}
	return runAutoChainPhase(recipe, options, report, common, false);
}

export interface WorkflowToolsOptions {
	verificationCommandRunner?: AutoChainOptions["verificationCommandRunner"];
	driveDepartments?: AutoChainOptions["driveDepartments"];
	worktreeHost?: AutoChainOptions["worktreeHost"];
	worktreeTarget?: AutoChainOptions["worktreeTarget"];
	expectedInputVersion?: string;
	resolveOwnerSessionId?: () => string | undefined;
	/** PAO_HOME 解析（配方目录 <PAO_HOME>/工作流）；缺省读 PAO_HOME 环境变量，无则 cwd */
	resolvePaoHome?: () => string;
	/** 默认卡目录（任务工作区的 卡/ 目录）；给了它工具的 卡目录 参数可省略 */
	resolveCardsDir?: () => string;
	/** 默认工作区目录（实例清单落点）；缺省取卡目录上一级 */
	resolveWorkspaceDir?: () => string;
	/**
	 * 自动执行链的派发运行器（配方 自动执行: true 时用）；缺省与 pao_dispatch_card 共用
	 * defaultWorkerRunner——同一登记表、同一退出停树面，不另起第二套进程管理。
	 */
	runner?: WorkerRunner;
	/** 影子沙箱根（自动链机械验收「跑:」句式用）；缺省系统临时目录 */
	沙箱根?: string;
	/**
	 * T04 共用通知缓冲（S6-K3）：链终局通知与 worker 派卡通知共用同一实例——一轮 before_agent_start
	 * 一段注入；缺省自建独立面（单独注册本模块仍可用）。
	 */
	notifySurface?: DispatchNotifySurface;
	/**
	 * 临时计划（通用工作台）用：项目根解析（定义落 <项目根>/.pao/临时工作流/）。
	 * 主控会话 cwd 就是项目根时可用缺省；宿主另有布局时注入。
	 */
	resolveProjectRoot?: () => string | undefined;
	/**
	 * 宿主确认回调：用户对「哪一版计划的哪一次启动」的真实确认只能由宿主交回来。
	 * 不注入时临时计划的启动工具一律拒（模型自述不算确认）。
	 */
	requestConfirmation?: PlanToolsOptions["requestConfirmation"];
	/** 后台自动链登记或收敛后通知宿主；宿主应只更新生命周期，不在这里推进业务。 */
	onBackgroundChange?: () => void;
}

function fail(error: unknown): never {
	if (isWorkflowRecipeError(error) || error instanceof WorkflowDriverError) {
		throw new Error(`[${error.code}] ${error.message}`);
	}
	throw error;
}

/** 域错误文案（命令面回显与 fail 上抛共用一个 [CODE] 口径；非域错误原样消息）。 */
function formatErrorText(error: unknown): string {
	if (isWorkflowRecipeError(error) || error instanceof WorkflowDriverError) return `[${error.code}] ${error.message}`;
	return error instanceof Error ? error.message : String(error);
}

/** 工具面统一外皮：核心文本 → 工具回包；域错误经 fail 带 [CODE] 上抛，不每工具重写 try/catch。 */
async function toolResult(
	fn: () => Promise<string>,
): Promise<{ content: { type: "text"; text: string }[]; details: undefined }> {
	try {
		return { content: [{ type: "text", text: await fn() }], details: undefined };
	} catch (error) {
		fail(error);
	}
}

const CARDS_DIR_DESC = "卡目录绝对路径（任务工作区的 卡/ 目录）；留空用扩展配置注入的默认卡目录";

interface ToolParams {
	name: string;
	cards_dir?: string;
	params?: Record<string, string>;
	node?: string;
}

function buildDriverOptions(
	params: ToolParams,
	options: WorkflowToolsOptions | undefined,
	signal?: AbortSignal,
): DriverOptions {
	const cardsDir = params.cards_dir ?? options?.resolveCardsDir?.();
	if (!cardsDir) {
		throw new Error("未提供卡目录：请传 cards_dir 参数，或在扩展配置中注入默认卡目录（resolveCardsDir）。");
	}
	return {
		cardsDir,
		ownerSessionId: options?.resolveOwnerSessionId?.(),
		signal,
		// 显式换项目时，清单跟最终卡目录走；默认工作区只适用于默认卡目录。
		workspaceDir: params.cards_dir === undefined ? options?.resolveWorkspaceDir?.() : undefined,
	};
}

function loadRecipeFor(params: ToolParams, options: WorkflowToolsOptions | undefined) {
	validateRecipeName(params.name);
	const cardsDir = params.cards_dir ?? options?.resolveCardsDir?.();
	if (cardsDir) {
		// 运行中读取冻结图；用户修改甚至删坏配方不应改变正在运行的实例。
		const path = manifestPath({ 名字: params.name }, buildDriverOptions(params, options));
		if (existsSync(path)) {
			const { frontmatter } = parseFrontmatter<{ 版本?: number; 冻结配方?: WorkflowRecipe }>(
				readFileSync(path, "utf8"),
			);
			if (frontmatter.版本 === 2 && frontmatter.冻结配方) {
				if (frontmatter.冻结配方.名字 !== params.name) throw new Error("冻结配方名与实例文件不一致");
				return readControl(frontmatter.冻结配方, buildDriverOptions(params, options)).冻结配方;
			}
		}
	}
	return loadRecipe(options?.resolvePaoHome?.() ?? defaultPaoHome(), params.name);
}

/** 自动执行链参数（配方 自动执行: true 时三入口共用；运行器缺省与 pao_dispatch_card 同一实例）。 */
function buildAutoOptions(
	params: ToolParams,
	options: WorkflowToolsOptions | undefined,
	signal?: AbortSignal,
	hasUI = false,
): AutoChainOptions {
	return {
		...buildDriverOptions(params, options, signal),
		driveDepartments: options?.driveDepartments,
		运行器: options?.runner ?? defaultWorkerRunner,
		paoHome: options?.resolvePaoHome?.(),
		...(options?.worktreeHost ? { worktreeHost: options.worktreeHost } : {}),
		...(options?.worktreeTarget ? { worktreeTarget: options.worktreeTarget } : {}),
		...(options?.expectedInputVersion !== undefined ? { expectedInputVersion: options.expectedInputVersion } : {}),
		沙箱根: options?.沙箱根,
		verificationCommandRunner: options?.verificationCommandRunner,
		hostHasUI: hasUI,
	};
}

/**
 * 注册工作流工具与 /pao flow 子命令（pi 扩展入口）。
 * 模型面四工具：pao_start_flow（校验参数＋写实例清单＋落首批卡）、pao_push_flow（断点续跑 tick）、
 * pao_query_flow（只读聚合：当前节点/卡号/pao status）、pao_confirm_flow（人工门点头后续跑）。
 * S6 起本注册返回后台链受理面（backgroundCount＝生命周期观察，waitForAutoChain＝测试与收尾）。
 */
export function registerWorkflowTools(pi: ExtensionAPI, options?: WorkflowToolsOptions): AutoChainBackground {
	// §11.6 跑后复盘·终态提醒（与 §20 pao-fanout-done 同机制）:实例到终态（全部交付/有节点失败）
	// → 下一轮 before_agent_start 消费式注入提醒;会话级内存态（R25 重启归零）,同一流一次终态只提醒一次。
	const reviewPendingInjection: string[] = [];
	const remindedFinal = new Set<string>();
	const queueReview = (report: DriveReport, cardsDir: string): void => {
		if (options?.runner?.isStopped()) return;
		const finalState = report.status === "completed" || report.nodes.some((node) => node.status === "failed");
		const key = `${pathKey(resolve(cardsDir))}#${report.workflow}`;
		if (!finalState || remindedFinal.has(key)) return;
		remindedFinal.add(key);
		reviewPendingInjection.push(
			`工作流「${report.workflow}」已到终态（${report.status === "completed" ? "全部交付" : "有节点失败"}）——请调 pao_review_flow 出机械报告,基于报告给改进意见,用户拍板后用 pao_write_recipe 回写配方。`,
		);
	};
	// 命令/工具两面共用的注册态：复盘同一队列＋toast 开关同源（核心收口 2026-10-03）
	const common: WorkflowCommon = { queueReview, paoHome: options?.resolvePaoHome?.() };
	pi.on("before_agent_start", (event) => {
		if (options?.runner?.isStopped()) {
			reviewPendingInjection.splice(0);
			return;
		}
		if (reviewPendingInjection.length === 0) return;
		const body = reviewPendingInjection.splice(0).join("\n\n");
		event.systemPromptOptions.sections[WORKFLOW_REVIEW_SECTION] =
			`[pao 工作流复盘提醒] 以下工作流已跑完,等复盘（运行态通知,重启归零;卡与回执是真相,R25）:\n${body}`;
	});

	// ── S6-K1 后台自动链受理面（pao_dispatch_card 后台受理模式：受理即返＋fire-and-forget＋inFlight 防双跑）──
	// 链终局通知并入 T04 共用缓冲（S6-K3,worker/notify.ts——与派卡通知同一缓冲/注入段,不另起炉灶):
	// 完成/停下/失败全文进缓冲,下一轮 before_agent_start 消费式注入(会话级内存态,R25 重启归零;
	// 卡文件状态与回执是真相)。缺省自建独立面;宿主接线传入共享实例时与派卡通知一轮一段。
	const notifySurface =
		options?.notifySurface ??
		createDispatchNotifySurface({
			resolvePaoHome: () => common.paoHome,
			wakeUp: () => sendDispatchNotifyWakeup(pi),
		});
	const notifyBackgroundChange = (): void => {
		try {
			options?.onBackgroundChange?.();
		} catch (error) {
			logWarn(`[pao] 后台在途数量变化通知失败:${error instanceof Error ? error.message : String(error)}`);
		}
	};
	pi.on("before_agent_start", (event) => {
		// 全停保留卡面/回执/停因，但旧缓冲不能跨下一轮继续唤醒模型。
		if (options?.runner?.isStopped()) {
			notifySurface.inject({ systemPromptOptions: { sections: {} } });
			return;
		}
		notifySurface.inject(event as DispatchNotifyEvent);
	});
	const chainInFlight = new Map<string, { done: Promise<void> }>();
	const lastNoticeKey = new Map<string, string>();
	pi.on("session_shutdown", (event) => {
		const cleanup = () => {
			if (!options?.notifySurface) notifySurface.shutdown();
			lastNoticeKey.clear();
			chainInFlight.clear();
		};
		if (event.onConfirmedShutdown) event.onConfirmedShutdown(cleanup);
		else cleanup();
	});
	/** 链收敛后处理：与同步路径同口径（驱动段只渲染,链段含叫人 toast＋终态复盘入队）＋通知缓冲。 */
	const settleChain = async (
		key: string,
		recipe: WorkflowRecipe,
		options: AutoChainOptions,
		chain: AutoChainReport,
		useDrive: boolean,
	): Promise<void> => {
		if (options.运行器.isStopped()) return;
		const flow = recipe.版本 === 2 ? readControl(recipe, options) : undefined;
		const noticeKey = autoChainNoticeKey(recipe, options, chain, flow);
		const previousNoticeKey = lastNoticeKey.get(key);
		lastNoticeKey.set(key, noticeKey);
		if (previousNoticeKey === noticeKey) return;
		if (previousNoticeKey !== undefined) notifySurface.markHandled(previousNoticeKey);
		if (!useDrive) {
			await toastIfHeld(recipe, chain, options, common);
			common.queueReview(chain.report, options.cardsDir);
		}
		notifySurface.notify(
			`[自动链${chain.stopReason === undefined ? "完成" : "停下"}] 工作流「${recipe.名字}」\n${renderAutoChain(chain)}`,
			undefined,
			undefined,
			{
				category: chain.waitingForEvent ? "progress" : chain.report.status === "completed" ? "result" : "ruling",
				key: noticeKey,
				retainAfterInjected: chain.waitingForEvent !== true && chain.report.status !== "completed",
			},
		);
	};
	const background: AutoChainBackground = {
		accept: async (recipe, options, firstReport, useDrive) => {
			const key = `${pathKey(resolve(options.cardsDir))}#${recipe.名字}`;
			if (chainInFlight.has(key)) {
				return [
					`自动链仍在后台推进:工作流「${recipe.名字}」的在途链未收敛,本次不重复受理（重复推流不双跑）。`,
					activeWorkerLines(options),
					"停下/完成以 pao 后台通知 注入下一轮;查询:pao_query_flow / pao_inventory。",
				].join("\n");
			}
			// 第一次异步读取前预留在途位置；收敛口也等待受理阶段，失败会释放。
			let finishAcceptance!: () => void;
			const entry = {
				done: new Promise<void>((resolveDone) => {
					finishAcceptance = resolveDone;
				}),
			};
			chainInFlight.set(key, entry);
			notifyBackgroundChange();
			try {
				// 受理快照同步做（v1 首 tick 落卡/v2 控制正本现读）:FLOW_NOT_STARTED、旧实例未知版本等
				// 快速失败保持同步抛给调用方,不让受理掩盖启动类错误;工具 signal 只守护这段同步面。
				options.signal?.throwIfAborted();
				let snapshot = firstReport;
				const flow = recipe.版本 === 2 ? readControl(recipe, options) : undefined;
				if (snapshot === undefined && flow !== undefined) snapshot = await readControlReport(flow, options);
				else if (snapshot === undefined) snapshot = await tickWorkflow(recipe, options);
				options.signal?.throwIfAborted();
				// 显式推流仍由现有驱动器重核成果；卡状态不变不能证明文件没有改变。
				// 相同停因的主动唤醒只在 settleChain 的通知生产口去重。
				const done = (async (): Promise<void> => {
					try {
						// signal 不接后台链（派单先例）:工具调用此刻就返回,取消语义由 runner 树杀承担
						// (session_shutdown/pao_stop_background/pao_terminate_card);owner/暂停/轮次在链内锁后重核不变。
						// 后台链不接本次工具调用的短命 signal，但必须接运行器的全停 signal；
						// stopAll 会同步 abort，使部长审核等待和排队中的派发及时收敛。
						const bgOptions: AutoChainOptions = { ...options, signal: options.运行器.stopSignal };
						const chain =
							useDrive && options.driveDepartments
								? await options.driveDepartments(recipe, bgOptions)
								: await runAutoChain(recipe, bgOptions, snapshot);
						await settleChain(key, recipe, options, chain, useDrive);
					} catch (error) {
						const reason = error instanceof Error ? error.message : String(error);
						// 普通异常仍即时通知；显式全停后的取消/中止只清理在途，不唤醒主控或部长。
						if (!options.运行器.isStopped())
							notifySurface.notify(
								`[自动链失败] 工作流「${recipe.名字}」:${reason}`,
								`PAO 工作流「${recipe.名字}」链失败`,
								reason.slice(0, 200),
							);
					} finally {
						chainInFlight.delete(key);
						notifyBackgroundChange();
						finishAcceptance();
					}
				})();
				void done;
				return [
					`自动链已受理:工作流「${recipe.名字}」在后台推进（派发→回执→越界核查→机械验收→交卷→解锁下游循环）,本工具调用到此返回,不等 worker。`,
					"—— 当前快照 ——",
					renderReport(snapshot),
					activeWorkerLines(options),
					"停下/失败/完成以 pao 后台通知 注入下一轮（伴叫人 toast）;查询:pao_query_flow / pao_inventory;终止在途 worker:pao_terminate_card。",
				].join("\n");
			} catch (error) {
				chainInFlight.delete(key);
				notifyBackgroundChange();
				finishAcceptance();
				throw error;
			}
		},
		waitForAutoChain: async () => {
			await Promise.all([...chainInFlight.values()].map((entry) => entry.done));
		},
		backgroundCount: () => ({ inFlight: chainInFlight.size }),
	};
	common.background = background;
	// 临时计划主控工具：与工作流工具同一注册面、同一 common（后台链受理面共用，链终局通知不断线）。
	registerPlanTools(
		pi,
		{
			resolvePaoHome: options?.resolvePaoHome,
			resolveProjectRoot: options?.resolveProjectRoot,
			resolveOwnerSessionId: options?.resolveOwnerSessionId,
			driveDepartments: options?.driveDepartments,
			worktreeHost: options?.worktreeHost,
			runner: options?.runner,
			沙箱根: options?.沙箱根,
			verificationCommandRunner: options?.verificationCommandRunner,
			requestConfirmation: options?.requestConfirmation,
		},
		common,
	);

	const baseParams = {
		name: Type.String({ description: "工作流配方名（<PAO_HOME>/工作流/<名字>.md）" }),
		cards_dir: Type.Optional(Type.String({ description: CARDS_DIR_DESC })),
	};
	const nodeControlTool = {
		name: "pao_control_node",
		label: "工作流部门节点控制",
		description:
			"主控的 v2 节点确认、暂停、人工恢复、当前节点重开（reopen）或审核回边返工（rework）。resume/reopen 须真实界面确认。常规质量返工只走已声明回边。拆卡、判定和原卡返修由真实部长提交。",
		parameters: Type.Object({
			...baseParams,
			action: Type.Union(["confirm", "pause", "resume", "reopen", "rework", "rule"].map((s) => Type.Literal(s))),
			node: Type.Optional(Type.String()),
			instance: Type.Optional(Type.String()),
			round: Type.Optional(Type.Integer({ minimum: 1 })),
			reason: Type.Optional(Type.String()),
			result: Type.Optional(Type.Union([Type.Literal("pass"), Type.Literal("change"), Type.Literal("reject")])),
			failure_axis: Type.Optional(
				Type.Union([Type.Literal("card"), Type.Literal("dept_standard"), Type.Literal("both")]),
			),
			references: Type.Optional(Type.Array(Type.String())),
			target: Type.Optional(Type.String()),
			prev_owner: Type.Optional(Type.String()),
		}),
		execute: async (
			_id: string,
			params: {
				name: string;
				cards_dir?: string;
				action: "confirm" | "pause" | "resume" | "reopen" | "rework" | "rule";
				node?: string;
				instance?: string;
				round?: number;
				reason?: string;
				result?: Decision["结果"];
				failure_axis?: Decision["失败轴"];
				references?: string[];
				target?: string;
				prev_owner?: string;
			},
			signal: AbortSignal | undefined,
			_update: unknown,
			ctx: ExtensionContext,
		) =>
			toolResult(async () => {
				signal?.throwIfAborted();
				const recipe = loadRecipeFor(params, options);
				const driver = buildDriverOptions(params, options, signal);
				if (recipe.版本 !== 2) throw new Error("节点控制只支持显式 v2 配方");
				if (readControl(recipe, driver).实例 !== params.instance) throw new Error("节点控制实例不匹配");
				const identity = {
					实例: params.instance ?? "",
					节点: params.node ?? "",
					轮次: params.round ?? 0,
				};
				if (["bind", "submit_cards", "breakdown_done", "decision"].includes(params.action))
					throw new Error("部长动作只能由真实宿主绑定的部长会话提交；主控请用推流启动部长");
				const confirmHumanAction = async (title: string, detail: string): Promise<void> => {
					if (
						!ctx.hasUI ||
						!(await ctx.ui.confirm(
							"工作流人工确认",
							`${title} ${params.name} / ${params.node ?? "实例"}？\n${detail}`,
						))
					)
						throw new Error("须用户在界面显式确认；无交互界面不能自动恢复或代替人工门");
				};
				signal?.throwIfAborted();
				switch (params.action) {
					case "confirm":
						await confirmHumanAction("confirm", params.reason ?? "");
						if (readControl(recipe, driver).实例 !== identity.实例) throw new Error("确认实例不匹配");
						await confirmControl(recipe, driver, identity.节点, identity.轮次);
						break;
					case "pause":
						await pauseControl(recipe, driver, params.reason ?? "");
						break;
					case "rule": {
						const flow = readControl(recipe, driver);
						const node = flow.节点.find((n) => n.名字 === identity.节点);
						if (!node?.部长会话 || !params.result) throw new Error("裁定须指定当前节点与三态结果");
						if (flow.裁定?.通道 === "人工")
							await confirmHumanAction("人工裁定", `${params.result}\n${params.reason ?? ""}`);
						signal?.throwIfAborted();
						// 工具参数英文名 → Decision 持久键（D5 保留）的写入映射收口在此一处。
						await decideNode(
							recipe,
							driver,
							{ ...identity, 部长会话: node.部长会话 },
							{
								结果: params.result,
								理由: params.reason ?? "",
								引用: params.references ?? [],
								失败轴: params.failure_axis,
								目标: params.target,
							},
							flow.裁定?.通道 ?? "主控",
						);
						break;
					}
					case "resume":
						await confirmHumanAction("resume", params.reason ?? "");
						await resumeControl(recipe, driver, {
							实例: identity.实例,
							原owner: params.prev_owner ?? "",
							现场核查: params.reason ?? "",
						});
						break;
					case "reopen":
						await confirmHumanAction("reopen", params.reason ?? "");
						await reopenControl(
							recipe,
							driver,
							{
								实例: identity.实例,
								原owner: params.prev_owner ?? "",
								节点: identity.节点,
								轮次: identity.轮次,
								现场核查: params.reason ?? "",
							},
							() => (options?.runner ?? defaultWorkerRunner).registry.list(),
						);
						break;
					case "rework": {
						const flow = readControl(recipe, driver);
						const node = flow.节点.find((candidate) => candidate.名字 === identity.节点);
						if (!node?.部长会话 || !params.target) throw new Error("常规质量返工须指定当前审核节点和回边目标");
						await reworkControl(
							recipe,
							driver,
							{ ...identity, 部长会话: node.部长会话 },
							params.reason ?? "",
							params.target,
							() => (options?.runner ?? defaultWorkerRunner).registry.list(),
						);
						break;
					}
					default:
						throw new Error("未知节点动作");
				}
				return renderReport(await readControlReport(readControl(recipe, driver), driver));
			}),
	};
	pi.registerTool(nodeControlTool);

	const runStart = async (params: ToolParams, signal: AbortSignal | undefined, hasUI: boolean) =>
		toolResult(async () =>
			startWorkflowCore(
				loadRecipeFor(params, options),
				params.params ?? {},
				buildAutoOptions(params, options, signal, hasUI),
				common,
			),
		);

	const startTool = {
		name: "pao_start_flow",
		label: "启动工作流",
		description:
			"一键启动工作流：按配方名从 <PAO_HOME>/工作流/<名字>.md 加载并校验（有向无环、参数占位符全有值才放行），写实例清单 工作流实例-<名字>.md，落首批卡（depends_on 全完成的节点）。同一流已有实例清单时拒绝重复启动。配方标 自动执行: true 时首批卡进后台自动链（派发→回执→越界核查→机械验收→交卷→解锁下游）——受理即返不等 worker，停下/失败/完成以 pao 后台通知 注入下一轮；缺省只落卡。",
		parameters: Type.Object({
			...baseParams,
			params: Type.Optional(
				Type.Record(Type.String(), Type.String(), { description: "配方参数占位符的取值，键值对" }),
			),
		}),
		execute: async (
			_toolCallId: string,
			params: ToolParams,
			signal?: AbortSignal,
			_update?: unknown,
			ctx?: ExtensionToolContext,
		) => runStart(params, signal, ctx?.hasUI === true),
	};
	pi.registerTool(startTool);
	pi.registerTool({
		name: "pao_decision_pack",
		label: "生成节点判定包",
		description:
			"读取冻结基线 diff、卡面、双轴标准、派单理由与验收证据，生成自足单文件；缺证据如实标明。回执宣称不能替代运行证据。",
		parameters: Type.Object({
			...baseParams,
			instance: Type.String(),
			node: Type.String(),
			round: Type.Integer({ minimum: 1 }),
			minister_session: Type.String(),
		}),
		execute: async (
			_id,
			params: {
				name: string;
				cards_dir?: string;
				instance: string;
				node: string;
				round: number;
				minister_session: string;
			},
			signal,
		) =>
			toolResult(async () => {
				const path = await buildDecisionPackage(
					loadRecipeFor(params, options),
					buildDriverOptions(params, options, signal),
					// 工具参数英文名 → NodeIdentity 持久键（D5 保留）的写入映射收口在此一处。
					{
						实例: params.instance,
						节点: params.node,
						轮次: params.round,
						部长会话: params.minister_session,
					},
					(options?.runner ?? defaultWorkerRunner).registry.list(),
				);
				return `判定包：${path}\n\n${readFileSync(path, "utf8")}`;
			}),
	});

	pi.registerTool({
		name: "pao_push_flow",
		label: "推进工作流",
		description:
			"推进工作流一个驱动循环：从卡现读各节点状态，把 depends_on 全部已交付（人工门已确认）的未跑节点落卡。挂起补齐后、回执交付后调用它续跑；失败即停不硬闯。配方标 自动执行: true 时进后台自动链（派发→回执→越界核查→机械验收→交卷→解锁下游循环）——受理即返不等 worker（在途重复推流不双跑），停下/失败/完成以 pao 后台通知 注入下一轮；缺省只落卡。",
		parameters: Type.Object(baseParams),
		execute: async (_toolCallId: string, params: ToolParams, signal, _update?: unknown, ctx?: ExtensionToolContext) =>
			toolResult(async () =>
				tickWorkflowCore(
					loadRecipeFor(params, options),
					buildAutoOptions(params, options, signal, ctx?.hasUI === true),
					common,
				),
			),
	});

	pi.registerTool({
		name: "pao_query_flow",
		label: "查工作流",
		description:
			"查工作流进度（只读）：当前跑到哪个节点、各节点卡号与卡状态、人工门与挂起原因。真相在卡上，实例清单只提供映射；清单缺失时自动从卡正文标记重建视图。",
		parameters: Type.Object(baseParams),
		execute: async (_toolCallId, params: ToolParams) =>
			toolResult(async () => queryWorkflowCore(loadRecipeFor(params, options), buildDriverOptions(params, options))),
	});

	pi.registerTool({
		name: "pao_confirm_flow",
		label: "确认工作流节点",
		description:
			"人工门点头：对标记人工确认且卡已交付的节点记录确认并立即续跑（放行下游）。未交付、未标人工门的节点会被拒绝。配方标 自动执行: true 时点头后进后台自动链——受理即返不等 worker，停下/完成以 pao 后台通知 注入下一轮。",
		parameters: Type.Object({
			...baseParams,
			node: Type.String({ description: "要确认的节点名" }),
		}),
		execute: async (
			_toolCallId: string,
			params: ToolParams,
			signal?: AbortSignal,
			_update?: unknown,
			ctx?: ExtensionToolContext,
		) =>
			toolResult(async () => {
				const hasUI = ctx?.hasUI === true;
				if (!hasUI || !(await ctx!.ui.confirm("工作流人工确认", `${params.name} / ${params.node}？`)))
					throw new Error("须用户在界面显式确认；无交互界面不能代替人工门");
				return confirmWorkflowCore(
					loadRecipeFor(params, options),
					params.node!,
					buildAutoOptions(params, options, signal, hasUI),
					common,
				);
			}),
	});

	// 生成路两工具（2026-10-03 拍板「走完一次存配方」）:蒸馏出草稿、校验后落盘。
	// 从零起草路（对话里主控手写配方）不经 pao_save_flow,但落盘同样过 pao_write_recipe 这一个机械校验闸。
	pi.registerTool({
		name: "pao_save_flow",
		label: "蒸馏工作流草稿",
		description:
			"从已完任务的卡目录蒸馏工作流配方草稿（逐字提取,不落盘）:每张卡→一个节点（目标/部门/验收/约束/输入/档位/预算/优先级原样进节点,依赖卡号映射为节点名）;人工确认一律 false（手动跑的任务没有确认留痕,审草稿时人工标）;参数表留空。草稿过全量校验（依赖成环拒绝出稿）后返回 markdown——先审改（建议把项目名/路径换成 {参数} 占位符并在参数表声明）,再用 pao_write_recipe 落盘。",
		parameters: Type.Object({
			cards_dir: Type.String({ description: CARDS_DIR_DESC }),
			recipe_name: Type.String({ description: "草稿 frontmatter「名字」（落盘时的文件名,蒸馏只写进草稿不落盘）" }),
			source_workflow: Type.Optional(
				Type.String({ description: "v2 实例名；从冻结图蒸馏，保留并发、判定、回边及模型设置" }),
			),
		}),
		execute: async (_toolCallId, params: { cards_dir: string; recipe_name: string; source_workflow?: string }) =>
			toolResult(async () => {
				const paoHome = options?.resolvePaoHome?.() ?? defaultPaoHome();
				if (params.source_workflow) {
					const recipe = loadRecipe(paoHome, params.source_workflow);
					const flow = readControl(
						recipe,
						buildDriverOptions({ name: params.source_workflow, cards_dir: params.cards_dir }, options),
					);
					return emitRecipeMarkdown({ ...flow.冻结配方, 名字: params.recipe_name });
				}
				const { content, cardCount, edgeCount, skipped } = distillRecipe(
					params.cards_dir,
					params.recipe_name,
					toolTimestamp(),
					paoHome,
				);
				return [
					content,
					"── 蒸馏摘要 ──",
					`卡 ${cardCount} 张、依赖边 ${edgeCount} 条;跳过 ${skipped.length} 个非卡/坏文件${skipped.length > 0 ? `（${skipped.join("、")}）` : ""}。`,
					"下一步:审改草稿（参数化建议、人工确认标记）后用 pao_write_recipe 落盘。",
				].join("\n");
			}),
	});

	const saveTool = {
		name: "pao_write_recipe",
		label: "落盘工作流配方",
		description:
			"把配方内容（蒸馏草稿或对话起草）校验后写入 <PAO_HOME>/工作流/<名字>.md:frontmatter 可解析、文件名与「名字」一致、依赖无环、占位符全部已在参数表声明,全过才原子落盘。同名已存在默认拒绝;overwrite:true 时先把旧文件备份为 .bak-时间戳 再写。",
		parameters: Type.Object({
			name: Type.String({ description: "配方名（文件名,非空、≤64、无路径分隔符等非法字符）" }),
			content: Type.String({ description: "完整配方 markdown（--- frontmatter --- ＋说明正文）" }),
			overwrite: Type.Optional(
				Type.Boolean({ description: "同名配方已存在时是否覆盖（默认 false;覆盖前自动备份旧版）" }),
			),
		}),
		execute: async (
			_toolCallId: string,
			params: { name: string; content: string; overwrite?: boolean },
			signal?: AbortSignal,
		) =>
			toolResult(async () => {
				signal?.throwIfAborted();
				const result = saveRecipe(options?.resolvePaoHome?.() ?? defaultPaoHome(), params.name, params.content, {
					覆盖: params.overwrite === true,
					备份时间: toolTimestamp(),
				});
				return [
					`已落盘:${result.路径}（${result.节点数} 节点）`,
					result.备份 ? `旧版备份:${result.备份}` : "",
					"下一步:/pao flow <名字> k=v 或 pao_start_flow 启动。",
				]
					.filter(Boolean)
					.join("\n");
			}),
	};
	pi.registerTool(saveTool);

	// 跑后复盘（§11.6）:机械报告从卡与回执现读;终态时下一轮自动注入 pao-workflow-review 提醒（见 registerWorkflowTools 顶部）。
	pi.registerTool({
		name: "pao_review_flow",
		label: "复盘工作流",
		description:
			"工作流复盘机械报告（跑完检查实施用）:从卡与回执现读,每节点一行——卡号/状态/尝试与重试/派发次数/打回与失败类型/末次成功摘要/产物/人工门确认/预算 vs 实耗,末尾总账与孤儿卡点名。只做机械汇总不给建议;改进意见由你（主控）基于报告给,用户逐条拍板后用 pao_write_recipe 回写配方。不建第二套真相。",
		parameters: Type.Object(baseParams),
		execute: async (_toolCallId, params: ToolParams) =>
			toolResult(async () => {
				const recipe = loadRecipeFor(params, options);
				const driverOptions = buildDriverOptions(params, options);
				if (recipe.版本 === 2) {
					const flow = readControl(recipe, driverOptions);
					return renderReviewReport(buildV2ReviewReport(recipe, driverOptions.cardsDir, flow));
				}
				const manifestFile = manifestPath(recipe, driverOptions);
				const manifest = existsSync(manifestFile)
					? parseManifest(readFileSync(manifestFile, "utf8"), manifestFile)
					: undefined;
				return renderReviewReport(buildReviewReport(recipe, driverOptions.cardsDir, manifest));
			}),
	});

	// /pao flow（原 /流 /流查 /流确认 三命令合并,2026-10-03 命令统一）:
	// 二级动词路由——see 查进度、confirm 过人工门,其余＝启动工作流（无参列配方）。
	// 核心执行与工具面共用 startWorkflowCore/queryWorkflowCore/confirmWorkflowCore——
	// 命令面只做 args 字符串解析（键=值 参数、二级动词）,不另写平行执行逻辑（防漂移）。
	// 配方名撞动词（真叫 see/confirm）时走 pao_start_flow 工具,不在命令面特判。
	/** 命令面自动链选项：与 buildAutoOptions 同源（运行器与 pao_dispatch_card 共用同一实例），仅卡目录来自注入默认而非参数。 */
	function commandAutoOptions(paoHome: string, cardsDir?: string): AutoChainOptions {
		return {
			verificationCommandRunner: options?.verificationCommandRunner,
			cardsDir: cardsDir ?? requireDefaultCardsDir(options),
			driveDepartments: options?.driveDepartments,
			ownerSessionId: options?.resolveOwnerSessionId?.(),
			// 显式选择实例时，实例清单随所选卡目录定位；默认卡目录才使用宿主注入的工作区。
			workspaceDir: cardsDir === undefined ? options?.resolveWorkspaceDir?.() : undefined,
			运行器: options?.runner ?? defaultWorkerRunner,
			paoHome,
			沙箱根: options?.沙箱根,
		};
	}

	/**
	 * /pao flow 的路径参数不能直接带空格（命令面按空白分词），统一要求
	 * cards_dir= 后跟 encodeURIComponent 编码值；解析失败要明确告诉用户修正输入。
	 */
	function parseCommandCardsDir(parts: string[]): { positional: string[]; cardsDir?: string } {
		const positional: string[] = [];
		let cardsDir: string | undefined;
		for (const part of parts) {
			if (!part.startsWith("cards_dir=")) {
				positional.push(part);
				continue;
			}
			if (cardsDir !== undefined) throw new Error("cards_dir 参数只能传一次");
			const encoded = part.slice("cards_dir=".length);
			if (!encoded) throw new Error("cards_dir 参数不能为空");
			try {
				cardsDir = decodeURIComponent(encoded);
			} catch (error) {
				throw new Error(`cards_dir 不是有效 URI 编码：${error instanceof Error ? error.message : String(error)}`);
			}
			if (!cardsDir) throw new Error("cards_dir 参数不能为空");
		}
		return { positional, cardsDir };
	}

	async function runFlowStart(pi: ExtensionAPI, args: string, hasUI: boolean): Promise<void> {
		const paoHome = options?.resolvePaoHome?.() ?? defaultPaoHome();
		const parts = args.trim().split(/\s+/).filter(Boolean);
		let text: string;
		try {
			if (parts.length === 0) {
				const available = listRecipes(paoHome);
				text =
					available.length > 0
						? `可用工作流配方：${available.join("、")}`
						: `没有可用配方（${joinWorkflowDir(paoHome)} 为空或不存在）`;
			} else {
				const [name, ...pairs] = parts;
				const params: Record<string, string> = {};
				for (const pair of pairs) {
					const eq = pair.indexOf("=");
					if (eq <= 0) throw new Error(`参数须写 键=值 形式，收到「${pair}」`);
					params[pair.slice(0, eq)] = pair.slice(eq + 1);
				}
				text = await startWorkflowCore(
					loadRecipeFor({ name }, options),
					params,
					{ ...commandAutoOptions(paoHome), hostHasUI: hasUI },
					common,
				);
			}
		} catch (error) {
			text = formatErrorText(error);
		}
		pi.sendMessage({ customType: "pao-workflow", content: [{ type: "text", text }], display: true });
	}

	async function runFlowSee(pi: ExtensionAPI, args: string): Promise<void> {
		let text: string;
		try {
			const parsed = parseCommandCardsDir(args.trim().split(/\s+/).filter(Boolean));
			const [name, ...extra] = parsed.positional;
			if (!name) {
				text = "用法：/pao flow see <名字>";
			} else if (extra.length > 0) {
				throw new Error("查看进度参数过多；卡目录请写 cards_dir=<URI编码路径>");
			} else {
				const recipe = loadRecipeFor({ name, cards_dir: parsed.cardsDir }, options);
				const paoHome = options?.resolvePaoHome?.() ?? defaultPaoHome();
				const driver = commandAutoOptions(paoHome, parsed.cardsDir);
				text = await queryWorkflowCore(recipe, {
					cardsDir: driver.cardsDir,
					workspaceDir: driver.workspaceDir,
				});
			}
		} catch (error) {
			text = formatErrorText(error);
		}
		pi.sendMessage({ customType: "pao-workflow", content: [{ type: "text", text }], display: true });
	}

	async function runFlowConfirm(pi: ExtensionAPI, args: string, hasUI: boolean): Promise<void> {
		let text: string;
		try {
			const parsed = parseCommandCardsDir(args.trim().split(/\s+/).filter(Boolean));
			const [name, node, instance, round, ...extra] = parsed.positional;
			if (!name || !node) {
				text = "用法：/pao flow confirm <名字> <节点>";
			} else if (extra.length > 0) {
				throw new Error("确认参数过多；卡目录请写 cards_dir=<URI编码路径>");
			} else {
				const paoHome = options?.resolvePaoHome?.() ?? defaultPaoHome();
				const recipe = loadRecipeFor({ name, cards_dir: parsed.cardsDir }, options);
				const driver = commandAutoOptions(paoHome, parsed.cardsDir);
				if (recipe.版本 === 2) {
					if (!hasUI) throw new Error("人工确认须用户从真实命令界面执行；无交互界面不能自动确认");
					if (!instance || !round || !/^\d+$/.test(round) || readControl(recipe, driver).实例 !== instance)
						throw new Error("v2 确认须传当前实例与轮次：confirm <名字> <节点> <实例> <轮次>");
					await confirmControl(recipe, driver, node, Number(round));
					text = await tickWorkflowCore(recipe, driver, common);
				} else {
					if (!hasUI) throw new Error("人工确认须用户从真实命令界面执行；无交互界面不能自动确认");
					text = await confirmWorkflowCore(recipe, node, driver, common);
				}
			}
		} catch (error) {
			text = formatErrorText(error);
		}
		pi.sendMessage({ customType: "pao-workflow", content: [{ type: "text", text }], display: true });
	}
	async function runFlowResume(pi: ExtensionAPI, args: string, hasUI: boolean): Promise<void> {
		let text: string;
		try {
			const [name, instance, originalOwner, ...reason] = args.trim().split(/\s+/).filter(Boolean);
			if (!name || !instance || !originalOwner || !reason.length)
				throw new Error("用法：/pao flow resume <名字> <实例> <原owner> <现场核查说明>");
			const recipe = loadRecipeFor({ name }, options);
			const driver = commandAutoOptions(options?.resolvePaoHome?.() ?? defaultPaoHome());
			if (!hasUI) throw new Error("人工恢复须用户从真实命令界面执行；无交互界面不能自动恢复");
			await resumeControl(recipe, driver, { 实例: instance, 原owner: originalOwner, 现场核查: reason.join(" ") });
			text = await tickWorkflowCore(recipe, driver, common);
		} catch (error) {
			text = formatErrorText(error);
		}
		pi.sendMessage({ customType: "pao-workflow", content: [{ type: "text", text }], display: true });
	}

	addPaoSubcommand(pi, {
		name: "flow",
		label: "工作流",
		description:
			"/pao flow <名字> k=v 启动工作流（无参列出可用配方）；see <名字> 查进度；confirm <名字> <节点> 人工门放行",
		run: async (pi, args, rawCtx) => {
			const ctx = rawCtx as ExtensionCommandContext;
			const trimmed = args.trim();
			if (trimmed.startsWith("control ")) {
				try {
					const params = JSON.parse(trimmed.slice(8)) as Parameters<typeof nodeControlTool.execute>[1];
					if (!Check(nodeControlTool.parameters, params)) throw new Error("控制参数不符合节点控制协议");
					const result = await nodeControlTool.execute("owner-command", params, ctx.signal, undefined, ctx);
					pi.sendMessage({ customType: "pao-workflow", content: result.content, display: true });
				} catch (error) {
					pi.sendMessage({
						customType: "pao-workflow",
						content: [{ type: "text", text: formatErrorText(error) }],
						display: true,
					});
					throw error;
				}
			} else if (trimmed.startsWith("start ") || trimmed.startsWith("save ")) {
				try {
					const params: unknown = JSON.parse(trimmed.slice(trimmed.indexOf(" ") + 1));
					let result: Awaited<ReturnType<typeof toolResult>>;
					if (trimmed.startsWith("start ")) {
						if (!Check(startTool.parameters, params)) throw new Error("启动参数不符合协议");
						result = await runStart(params as ToolParams, ctx.signal, ctx.hasUI === true);
					} else {
						if (!Check(saveTool.parameters, params)) throw new Error("保存参数不符合协议");
						result = await saveTool.execute(
							"owner-command",
							params as Parameters<typeof saveTool.execute>[1],
							(ctx as ExtensionContext).signal,
						);
					}
					pi.sendMessage({ customType: "pao-workflow", content: result.content, display: true });
				} catch (error) {
					pi.sendMessage({
						customType: "pao-workflow",
						content: [{ type: "text", text: formatErrorText(error) }],
						display: true,
					});
					throw error;
				}
			} else if (trimmed === "see" || trimmed.startsWith("see ")) await runFlowSee(pi, trimmed.slice(3).trim());
			else if (trimmed === "resume" || trimmed.startsWith("resume "))
				await runFlowResume(pi, trimmed.slice(6).trim(), ctx.hasUI === true);
			else if (trimmed === "confirm" || trimmed.startsWith("confirm "))
				await runFlowConfirm(pi, trimmed.slice(7).trim(), ctx.hasUI === true);
			else await runFlowStart(pi, trimmed, ctx.hasUI === true);
		},
	});

	// /pao recipe-del <名字>：删除 <PAO_HOME>/工作流/<名字>.md。删错有 .bak 备份与 git 兜底，
	// 故不设确认；机械核 deleteRecipe 与 loadRecipe 同一名字校验闸（fail-closed，不存在报错）。
	addPaoSubcommand(pi, {
		name: "recipe-del",
		label: "删除配方",
		description:
			"/pao recipe-del <名字> 删除工作流配方 <PAO_HOME>/工作流/<名字>.md（名字不存在报错；同名 .bak 备份保留；无确认步骤）",
		run: async (pi, args) => {
			const name = args.trim();
			let text: string;
			if (!name) {
				text = "用法：/pao recipe-del <名字>";
			} else {
				try {
					const result = deleteRecipe(options?.resolvePaoHome?.() ?? defaultPaoHome(), name);
					text = [
						`已删除配方：${result.名字}`,
						`路径：${result.路径}`,
						"（同名 .bak 备份保留；/pao flow 无参可查剩余配方）",
					].join("\n");
				} catch (error) {
					text = formatErrorText(error);
				}
			}
			pi.sendMessage({ customType: "pao-workflow", content: [{ type: "text", text }], display: true });
		},
	});

	return background;
}

/** 命令面没有参数可传卡目录：未注入默认卡目录时给出明确指引而不是拿空路径去跑。 */
function requireDefaultCardsDir(options: WorkflowToolsOptions | undefined): string {
	const cardsDir = options?.resolveCardsDir?.();
	if (!cardsDir) {
		throw new WorkflowDriverError(
			"FLOW_NOT_STARTED",
			"未注入默认卡目录：请在扩展配置提供 resolveCardsDir 后再用 /pao flow 命令",
		);
	}
	return cardsDir;
}

function joinWorkflowDir(paoHome: string): string {
	return `${paoHome}/工作流`;
}

/** 工具层时间戳（YYYYMMDD-HHmmss,与 档位.json 备份同款格式）;蒸馏/备份留档用。 */
function toolTimestamp(): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	const d = new Date();
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// 配合点说明：
// 1. 驱动器通过 createCard 的模板正文参数写入流归属标记，首次落盘即包含完整身份。
// 2. worker 派发双模式：缺省（配方未标 自动执行）仍是手动链——落卡后接线层把 report.created_cards 交给
//    pao_dispatch_card/pao_fanout，回执交付后再推流解锁下游；配方标 自动执行: true 时推流/启流/确认流直接走
//    auto.ts 自动链（executeDispatch 同源派发＋§12 验收＋§13 交卷＋§14 越界核查，M2-06）。
// 3. 驱动器与全部 worker 归在线主会话（§11.3）：本注册入口只在主会话扩展接线时调用一次；
//    自动链无定时器无轮询（R05 保持）——S6 起受理在工具调用的同步等待里（首 tick＋快照），
//    链体在宿主内后台 fire-and-forget 推进（pao_dispatch_card 后台受理模式），终局经链事件通知回到主控/用户。
export { manifestPath, WorkflowRecipeError };
