import { basename, dirname } from "node:path";
import { type Static, Type } from "typebox";

import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { addPaoSubcommand } from "../command-router.ts";
import { recordProjectServed } from "../dept/projects.ts";
import { resolvePaoHome } from "../routing/config.ts";
import { nowString } from "../shared/time.ts";
import { baselineSnapshotPath, checkBoundaryWrite, diffAgainstBaseline, snapshotClaimBaseline } from "./baseline.ts";
import {
	createCard,
	listCards,
	loadCard,
	loadCardBodyTemplate,
	resolveCardTemplatePath,
	scanCards,
} from "./cardfile.ts";
import { formatCardNumber, parseCardRef } from "./counter.ts";
import { checkDependencies, findReachableCycles } from "./deps.ts";
import { PaoCardError } from "./errors.ts";
import { renderHandoff } from "./handoff.ts";
import { appendReceipt, isPendingReview } from "./receipts.ts";
import { renderAllQueues, renderQueue } from "./render.ts";
import { changeCardStatus, checkTransition, checkWriterAuthority } from "./statemachine.ts";
import type { ParsedCard, QueueCardView } from "./types.ts";
import { CARD_PRIORITIES, CARD_STATUSES, CARD_TIERS, FAILURE_TYPES } from "./types.ts";
import { reviewCardForDelivery } from "./verifier.ts";
import { findUnlockedCards, renderUnlockNotice, wakeupViews } from "./wakeup.ts";

/**
 * 卡片工具注册。路径一律参数传入（卡目录 / 计数器路径），不硬编码；
 * 提供 resolveCardsDir 时，各工具的 卡目录 参数可省略（主控接线时注入，如 PAO_HOME 派生）。
 */
export interface CardToolsOptions {
	/** 返回默认卡目录（任务工作区的 卡/ 目录）的解析函数。 */
	resolveCardsDir?: () => string;
	/**
	 * 渲染追加段提供者（接线层注入;架构 §2.2 的「待验证积压、⚠️」部门面板走这里）。
	 * 返回的每段追加在 /pao queue 渲染尾部;不配置则行为与纯卡片渲染完全一致。
	 */
	appendQueueSections?: () => string[] | Promise<string[]>;
	/**
	 * PAO_HOME（使用现场根目录）解析函数：pao_create_card「模板」按名字查找
	 * `<PAO_HOME>/pao配置/卡模板/<名>.md` 用；未配置时模板只收绝对路径（报错不静默，见 resolveCardTemplatePath）。
	 */
	resolvePaoHome?: () => string;
	/** 当前宿主停止这张卡的执行；确认成功后才把卡落为取消。 */
	cancelWorker?: (card: ParsedCard) => Promise<void>;
}

/** PaoCardError 转成带 code 前缀的 Error 抛出，框架按 isError 结果回给模型。 */
function fail(error: unknown): never {
	if (error instanceof PaoCardError) {
		throw new Error(`[${error.code}] ${error.message}`);
	}
	throw error;
}

function toQueueView(card: ParsedCard, pendingReview: boolean): QueueCardView {
	const fm = card.frontmatter;
	return {
		card_no: card.card_no,
		goal: fm.goal,
		status: fm.status,
		priority: fm.priority ?? "medium",
		created: fm.created,
		completed: fm.completed,
		owner: fm.owner,
		depends_on: fm.depends_on ?? [],
		parent: fm.parent,
		pending_review: pendingReview,
	};
}

function requireCardsDir(param: string | undefined, options?: CardToolsOptions): string {
	const dir = param ?? options?.resolveCardsDir?.();
	if (!dir) {
		throw new PaoCardError("INVALID_CARD", "缺少 cards_dir 参数，且未配置默认卡目录", {});
	}
	return dir;
}

// ============================================================================
// pao_create_card
// ============================================================================

const buildCardParams = Type.Object({
	cards_dir: Type.Optional(
		Type.String({ description: "卡目录（任务工作区的 卡/ 目录，绝对路径）；已配置默认卡目录时可省略" }),
	),
	goal: Type.String({ description: "一句话目标" }),
	dept: Type.String({ description: "能力标签（部门名）" }),
	acceptance: Type.String({ description: "可判验收条件，尽量机械化" }),
	inputs: Type.Optional(Type.Array(Type.String(), { description: "指针列表：路径/卡#N/知识库条目，不装内容" })),
	constraints: Type.Optional(Type.String({ description: "引用规则文件，不复述标准" })),
	depends_on: Type.Optional(Type.Array(Type.String(), { description: "前置卡引用（卡#N），全部已交付才放行" })),
	parent: Type.Optional(Type.String({ description: "协作卡归属父卡（卡#N）；只表归属与预算，不参与依赖判断" })),
	tier: Type.Optional(
		Type.Union(
			CARD_TIERS.map((tier) => Type.Literal(tier)),
			{ description: "模型档位：fast/primary" },
		),
	),
	budget: Type.Optional(
		Type.Object(
			{
				turns: Type.Optional(Type.Integer({ minimum: 0, description: "模型轮次上限" })),
				toolCalls: Type.Optional(Type.Integer({ minimum: 0, description: "工具调用次数上限" })),
				cost: Type.Optional(Type.Number({ minimum: 0, description: "独立的费用上限，不是调用次数" })),
				collab_quota: Type.Optional(Type.Integer({ minimum: 0 })),
			},
			{
				description:
					"卡预算：turns＝模型轮次，toolCalls＝工具调用次数（如 100/1000＝100 轮、1000 次工具调用）；cost 是独立费用上限。卡类型参考：微任务≈20/200、常规≈100/1000、大活≈500/5000。主控按任务规模逐卡预估，不设全局死数；worker 用实际计数执行机械熔断。这里只校验非负数值，不裁决预算是否合理。",
			},
		),
	),
	priority: Type.Optional(
		Type.Union(
			CARD_PRIORITIES.map((p) => Type.Literal(p)),
			{ description: "high/medium/low，缺省 medium" },
		),
	),
	owner: Type.Optional(Type.String({ description: "初始 owner（指派时填）；缺省为待认领无主" })),
	template: Type.Optional(
		Type.String({
			description:
				"卡正文模板（M2-09 卡模板库）：模板文件绝对路径，或 PAO_HOME/pao配置/卡模板/ 下的模板名（如 侦察/巡库/评审）。模板正文骨架插入新卡正文（机械验收句式＋约束引用），frontmatter 仍由本工具其余参数生成；缺 PAO_HOME 时只收绝对路径",
		}),
	),
	counter_path: Type.Optional(
		Type.String({ description: "卡号计数器文件路径；缺省取 卡目录/../../卡号.txt（项目 .pao/ 下）" }),
	),
});

/** 模板名查找用的 PAO_HOME：接线层未注入或环境未配置时返回 undefined，由 resolveCardTemplatePath 报「只收绝对路径」。 */
function paoHomeForTemplate(options?: CardToolsOptions): string | undefined {
	if (!options?.resolvePaoHome) return undefined;
	try {
		return options.resolvePaoHome();
	} catch {
		return undefined; // PAO_HOME 未配置：名字查找按「只收绝对路径」报错，不静默吞
	}
}

/**
 * 建卡命中项目根时记入服务过的项目清单（M2-01 §5 写入时机）：卡目录须呈
 * <项目根>/.pao/卡 形状才记（与卡号计数器「卡目录/../../」同款父级约定），
 * 临时/任意目录不进清单；无 PAO_HOME＝无处可记，静默跳过；记录失败不连累
 * 建卡（纯增益旁挂），仅在输出带一行提示。派卡侧接线随待决③（派发入口）落。
 */
async function recordProjectIfShaped(cardsDir: string, options?: CardToolsOptions): Promise<string> {
	if (basename(cardsDir) !== "卡" || basename(dirname(cardsDir)) !== ".pao") return "";
	let home: string;
	try {
		home = options?.resolvePaoHome ? options.resolvePaoHome() : resolvePaoHome();
	} catch {
		return ""; // 无 PAO_HOME：与模板名查找同款口径，静默不记
	}
	try {
		const outcome = await recordProjectServed(home, dirname(dirname(cardsDir)));
		return outcome === "created" ? "，已记入项目清单" : "";
	} catch {
		return "，项目清单记录失败（不影响建卡）";
	}
}

async function executeBuildCard(params: Static<typeof buildCardParams>, options?: CardToolsOptions): Promise<string> {
	try {
		const cardsDir = requireCardsDir(params.cards_dir, options);
		const templateBody =
			params.template !== undefined
				? loadCardBodyTemplate(resolveCardTemplatePath(params.template, paoHomeForTemplate(options)))
				: undefined;
		// 依赖环防呆（用户拍板 2026-10-03）：带依赖建卡时查上游可达环——新卡此刻是叶子
		// （无人依赖还不存在的卡），建卡瞬间自身不可能成环；环靠逐步累积（后建的卡指回链上）
		// 或手工编辑产生。这里拦「上游已在环中」：本卡会跟着死等，拒建并报环成员。
		if (params.depends_on && params.depends_on.length > 0) {
			const existing = listCards(cardsDir);
			const depsOf = (cardNo: number): readonly number[] | undefined =>
				existing.find((c) => c.card_no === cardNo)?.frontmatter.depends_on?.map(parseCardRef);
			const cycle = findReachableCycles(params.depends_on.map(parseCardRef), depsOf);
			// 全已交付的历史环放行（M2-02 定案：程序只拒死等，不翻旧账）——环里只要有
			// 任一卡未交付才是活死锁
			const undeliveredInCycle = cycle.filter(
				(n) => existing.find((c) => c.card_no === n)?.frontmatter.status !== "delivered",
			);
			if (undeliveredInCycle.length > 0) {
				const names = undeliveredInCycle.map((n) => formatCardNumber(n)).join("、");
				fail(
					new PaoCardError(
						"INVALID_CARD",
						`依赖环防呆：上游已在依赖环中（环含未交付卡 ${names}，互等永远无法交付），本卡会跟着死等——已拒建。请先解开环（改卡或确认哪些卡该取消）再建。`,
					),
				);
			}
		}
		const card = await createCard(
			cardsDir,
			{
				目标: params.goal,
				部门: params.dept,
				验收: params.acceptance,
				输入: params.inputs,
				约束: params.constraints,
				depends_on: params.depends_on,
				parent: params.parent,
				档位: params.tier,
				预算: params.budget,
				优先级: params.priority,
				owner: params.owner,
				创建: nowString(),
			},
			{ counterPath: params.counter_path, 模板正文: templateBody },
		);
		const templateNote = params.template !== undefined ? `，正文带模板「${params.template}」骨架` : "";
		const manifestNote = await recordProjectIfShaped(cardsDir, options);
		return `已建卡：${card.filename}（${card.path}），状态 unclaimed${templateNote}${manifestNote}`;
	} catch (error) {
		fail(error);
	}
}

// ============================================================================
// pao_submit_receipt（worker 专用，只追加）
// ============================================================================

const submitReceiptParams = Type.Object({
	cards_dir: Type.Optional(Type.String({ description: "cards_dir；已配置默认卡目录时可省略" })),
	card_ref: Type.Union([Type.Number(), Type.String()], { description: "card_ref（数字或 卡#N）" }),
	attempt: Type.Number({ description: "本次尝试号（认领启动后卡上的当前尝试）" }),
	result: Type.Optional(Type.String({ description: "结果：完成/失败/部分完成" })),
	summary: Type.Optional(Type.String({ description: "≤3 行摘要" })),
	artifact_path: Type.Optional(Type.Array(Type.String(), { description: "产物指针列表" })),
	evidence: Type.Optional(Type.Array(Type.String(), { description: "证据（测试命令/输出位置）" })),
	usage: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "用量（turns/token 等）" })),
	worth_distilling: Type.Optional(Type.String({ description: "值得沉淀的知识候选（可选）" })),
	failure_type: Type.Optional(
		Type.Union(
			FAILURE_TYPES.map((t) => Type.Literal(t)),
			{ description: "失败时建议标注：transient/missing_input/insufficient_capability/unknown_outcome" },
		),
	),
});

async function executeSubmitReceipt(
	params: Static<typeof submitReceiptParams>,
	options?: CardToolsOptions,
): Promise<string> {
	try {
		const cardsDir = requireCardsDir(params.cards_dir, options);
		const card = loadCard(cardsDir, parseCardRef(String(params.card_ref)));
		const outcome = appendReceipt(card, {
			尝试号: params.attempt,
			时间: nowString(),
			结果: params.result,
			摘要: params.summary,
			产物路径: params.artifact_path,
			证据: params.evidence,
			用量: params.usage,
			值得沉淀: params.worth_distilling,
			失败类型: params.failure_type,
		});
		switch (outcome.kind) {
			case "已记录":
				return `回执已追加到 ${card.filename}（尝试 ${params.attempt}）。状态仍为 ${card.frontmatter.status}，${outcome.待审 ? "待 owner 审核后方可交付" : "尚未到验收环节"}。worker 不得改状态。\n回执≠终态：回执只是 worker 声称完成，owner 验收（终态变更）以 owner 执行 pao_change_status 为准；汇报请区分「已交回执」与「已交付终态」，勿把前者说成后者。`;
			case "旧尝试留档":
				return `回执为旧尝试 ${params.attempt}（当前尝试 ${card.frontmatter.attempt}），已追加留档，不推进状态、不触发重试。`;
			case "迟到回执留档":
				return `卡已终态（${card.frontmatter.status}），回执按迟到留档，不再变状态。`;
			case "重复终结留档":
				return `当前尝试 ${params.attempt} 已接纳过终结自报，本条按重复终结留档，不再重复接纳。`;
		}
	} catch (error) {
		fail(error);
	}
}

// ============================================================================
// pao_change_status（owner 专用）
// ============================================================================

const changeStatusParams = Type.Object({
	cards_dir: Type.Optional(Type.String({ description: "cards_dir；已配置默认卡目录时可省略" })),
	card_ref: Type.Union([Type.Number(), Type.String()], { description: "card_ref（数字或 卡#N）" }),
	operator: Type.String({ description: "调用者身份（owner 名）；取消可传“用户”" }),
	new_status: Type.Union(
		CARD_STATUSES.map((s) => Type.Literal(s)),
		{ description: "目标状态" },
	),
	failure_type: Type.Optional(
		Type.Union(
			FAILURE_TYPES.map((t) => Type.Literal(t)),
			{ description: "转入失败时必填" },
		),
	),
	basis: Type.Optional(
		Type.String({ description: "迁移依据说明，落卡审计区；人工验收标为已完成时必填，不能替代机械检查" }),
	),
	max_attempts: Type.Optional(Type.Number({ description: "同轮授权尝试上限（默认 2）；提高须 owner 显式给出" })),
});

async function executeChangeStatus(
	params: Static<typeof changeStatusParams>,
	options?: CardToolsOptions,
	signal?: AbortSignal,
): Promise<string> {
	try {
		const cardsDir = requireCardsDir(params.cards_dir, options);
		let card = loadCard(cardsDir, parseCardRef(String(params.card_ref)));
		if (card.frontmatter.status === "unclaimed" && params.new_status === "in_progress") {
			// 依赖放行门：depends_on 全部已交付才可启动（parent 不参与）
			const cards = listCards(cardsDir);
			const statuses = new Map(cards.map((c) => [c.card_no, c.frontmatter.status] as const));
			const gate = checkDependencies(card.frontmatter.depends_on ?? [], (cardNo) => statuses.get(cardNo));
			if (!gate.放行) {
				// 环内卡永远到不了已交付，表现为无限阻塞——这里点名环成员，不让人对着
				// "上游进行中"的表象死等（环多来自手工编辑或历史遗留；建卡入口已拦新增）。
				const depsOf = (cardNo: number): readonly number[] | undefined =>
					cards.find((c) => c.card_no === cardNo)?.frontmatter.depends_on?.map(parseCardRef);
				const cycle = findReachableCycles([card.card_no], depsOf);
				if (cycle.length > 0) {
					const names = cycle.map((n) => formatCardNumber(n)).join("、");
					throw new PaoCardError(
						"DEPS_NOT_MET",
						`依赖环：${names} 互等永远无法交付（不是等进度，是死锁）——请解开环后再启动。`,
						{ 环: cycle },
					);
				}
				const detail = gate.阻塞.map((b) => `${formatCardNumber(b.卡号)}=${b.状态}`).join("、");
				throw new PaoCardError("DEPS_NOT_MET", `依赖未放行：${detail}`, { 阻塞: gate.阻塞 });
			}
		}
		if (params.new_status === "canceled" && options?.cancelWorker) {
			// 先验证操作者，避免无权改状态的调用先停掉别人的任务。
			checkTransition({ from: card.frontmatter.status, to: "canceled", 尝试: card.frontmatter.attempt });
			checkWriterAuthority(card.frontmatter, params.operator, "canceled");
			await options.cancelWorker(card);
			card = loadCard(cardsDir, card.card_no);
			if (card.frontmatter.status === "canceled") return `卡 ${card.filename}：执行已停止，状态 canceled`;
		}
		const claimStart = card.frontmatter.status === "unclaimed" && params.new_status === "in_progress";
		const previousStatus = card.frontmatter.status; // changeCardStatus 原地改 frontmatter，先留旧值供消息显示
		if (params.new_status === "delivered") {
			// 先验权限，再核成果；无权调用不得先追加验收记录或执行验收命令。
			checkTransition({ from: card.frontmatter.status, to: "delivered", 尝试: card.frontmatter.attempt });
			checkWriterAuthority(card.frontmatter, params.operator, "delivered");
			card = await reviewCardForDelivery(
				cardsDir,
				card.card_no,
				{ operator: params.operator, signal },
				params.basis,
			);
		}
		const updated =
			params.new_status === "delivered" && card.frontmatter.status === "delivered"
				? card
				: changeCardStatus(card, {
						操作者: params.operator,
						to: params.new_status,
						失败类型: params.failure_type,
						依据: params.basis,
						时间: nowString(),
						尝试上限: params.max_attempts,
					});
		let baselineNote = "";
		if (claimStart) {
			// R14：认领时落 git status 快照入工作区，交回执比对以此减基线——
			// 用户既有脏工作树不算 worker 的账。快照失败不阻断认领，边界如实标注。
			try {
				const baseline = await snapshotClaimBaseline(cardsDir, card.card_no, {
					owner: updated.frontmatter.owner,
					时间: nowString(),
				});
				baselineNote = baseline.可用
					? `；认领基线快照已落 ${baseline.快照路径}（既有改动 ${baseline.既有条目数} 条不计 worker 的账）`
					: `；认领基线快照不可用：${baseline.原因}（git 不可见区不在比对面，边界如实标注）`;
			} catch (error) {
				baselineNote = `；认领基线快照未落（${error instanceof Error ? error.message : String(error)}），比对无基线可用`;
			}
		}
		const suffix =
			updated.frontmatter.status === "in_progress"
				? `（尝试 ${updated.frontmatter.attempt}，owner=${updated.frontmatter.owner}）`
				: "";
		// §19 通道①：落已交付时机械扫一遍卡目录，下游就绪就地提示（无就绪卡零噪音）
		let unlockNote = "";
		if (updated.frontmatter.status === "delivered") {
			const note = renderUnlockNotice(findUnlockedCards(wakeupViews(listCards(cardsDir))));
			if (note) unlockNote = `\n${note}`;
		}
		return `卡 ${updated.filename}：${previousStatus} → ${updated.frontmatter.status}${suffix}${baselineNote}${unlockNote}`;
	} catch (error) {
		fail(error);
	}
}

// ============================================================================
// pao_check_overreach（§14 越界写检测的工具层入口，交卷/验收/主控调用；比对基线 = 认领快照 R14）
// ============================================================================

export const checkBoundaryParams = Type.Object({
	cards_dir: Type.Optional(Type.String({ description: "cards_dir；已配置默认卡目录时可省略" })),
	card_ref: Type.Union([Type.Number(), Type.String()], { description: "card_ref（数字或 卡#N）" }),
	artifact_path: Type.Optional(
		Type.Array(Type.String(), { description: "回执声明的产物清单；缺省取卡上最新一条回执的产物路径" }),
	),
});

/**
 * 回执产物清单归一：卡面把产物路径写成无引号 YAML flow 序列（如 [产物.txt]，中文路径不加
 * 引号），重读解析失败时会退化成单个字符串——这里统一收敛成 string[] 供比对。
 */
function normalizedArtifacts(artifactPath: string[] | string | undefined): string[] {
	if (artifactPath === undefined) return [];
	if (Array.isArray(artifactPath)) return artifactPath;
	const text = artifactPath.trim();
	if (text.startsWith("[") && text.endsWith("]")) {
		try {
			const parsed: unknown = JSON.parse(text);
			if (Array.isArray(parsed)) return parsed.map(String);
		} catch {
			// 无引号 flow 序列：退化为按逗号拆
			return text
				.slice(1, -1)
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
		}
	}
	return text.length > 0 ? [text] : [];
}

/**
 * §14 越界写核查：git 真值（当前 status 减认领基线快照）机械比对回执声明的产物清单，
 * 虚报（说了没做）/越界（做了没说）/干净结构化亮出，文件级精度。可被交卷（§13）与
 * 机械验收（§12）调用；工作流模式「有差异自动插人工门」挂在本工具的返回结论上
 * （结论 !== 干净 时分流，待 §11 工作流引擎落地接线）。
 */
export async function executeCheckBoundaryWrite(
	params: Static<typeof checkBoundaryParams>,
	options?: CardToolsOptions,
): Promise<string> {
	try {
		const cardsDir = requireCardsDir(params.cards_dir, options);
		const card = loadCard(cardsDir, parseCardRef(String(params.card_ref)));
		const takeFromReceipt = params.artifact_path === undefined;
		const declared =
			params.artifact_path ??
			normalizedArtifacts(card.receipts.at(-1)?.artifact_path as string[] | string | undefined);
		const snapshotPath = baselineSnapshotPath(cardsDir, card.card_no);
		const diff = await diffAgainstBaseline(snapshotPath);
		const check = checkBoundaryWrite(diff, declared);
		const lines = [
			`卡 ${card.filename} 越界核查（§14：git 真值 = 当前 status 减认领基线，比对回执声明的产物清单）`,
			diff.基线可用
				? `比对基线：${snapshotPath}（既有 ${diff.既有条目数} 条不计 worker 的账）`
				: `比对基线不可用：${diff.原因 ?? diff.汇总}`,
			`声明来源：${takeFromReceipt ? (card.receipts.length > 0 ? "卡上最新回执的产物路径" : "卡上无回执，按无声明处理") : "调用方显式给出"}`,
			`结论：${check.结论}——${check.汇总}`,
		];
		if (check.虚报.length > 0) lines.push(`虚报（声明未写）：${check.虚报.join("、")}`);
		if (check.越界.length > 0) lines.push(`越界（写未声明）：${check.越界.join("、")}`);
		if (check.相符.length > 0) lines.push(`相符：${check.相符.join("、")}`);
		if (check.不可核验.length > 0) lines.push(`检测面外（不经 git 核验）：${check.不可核验.join("、")}`);
		return lines.join("\n");
	} catch (error) {
		fail(error);
	}
}

// ============================================================================
// pao_query_queue 与 /pao queue 子命令
// ============================================================================

const queryQueueParams = Type.Object({
	cards_dir: Type.Optional(Type.String({ description: "cards_dir；已配置默认卡目录时可省略" })),
});

async function executeQueryQueue(params: Static<typeof queryQueueParams>, options?: CardToolsOptions): Promise<string> {
	try {
		const cardsDir = requireCardsDir(params.cards_dir, options);
		const { cards, problems } = scanCards(cardsDir);
		const views = cards.map((card) => toQueueView(card, isPendingReview(card)));
		const base = renderQueue(views);
		// 读不到的卡必须显式列账：队列看着干净不等于没有任务（审查第 5 项）
		const problemNote =
			problems.length > 0
				? [
						`## 读取问题（${problems.length} 项，未计入上面的队列）`,
						...problems.map((p) => `- ${p.path}：${p.reason}`),
					].join("\n")
				: undefined;
		const extra = options?.appendQueueSections ? await options.appendQueueSections() : [];
		return [base, ...(problemNote ? [problemNote] : []), ...extra].join("\n\n");
	} catch (error) {
		fail(error);
	}
}

// ============================================================================
// pao_handoff（M2-09 件4：交接页机械生成，四段 markdown，整页只读不落盘）
// ============================================================================

const handoffParams = Type.Object({
	cards_dir: Type.Optional(Type.String({ description: "cards_dir；已配置默认卡目录时可省略" })),
});

async function executeHandoff(params: Static<typeof handoffParams>, options?: CardToolsOptions): Promise<string> {
	try {
		const cardsDir = requireCardsDir(params.cards_dir, options);
		return await renderHandoff(cardsDir);
	} catch (error) {
		fail(error);
	}
}

/**
 * 注册 pao 卡片工具与 /pao queue 子命令（pi 扩展入口）。
 * 工具：pao_create_card / pao_submit_receipt（worker 只追加）/ pao_change_status（owner）/ pao_query_queue /
 * pao_check_overreach（§14）/ pao_handoff（交接页机械生成，M2-09）。
 */
export function registerCardTools(pi: ExtensionAPI, options?: CardToolsOptions): void {
	pi.registerTool({
		name: "pao_create_card",
		label: "建卡",
		description:
			"在卡目录内建任务卡：发号（跨进程文件锁、按项目唯一递增）→ 写入 卡NNNN-目标简述.md（YAML frontmatter 信封字段 + 正文回执区，原子写）。新卡状态为 待认领。可选「模板」参数带入已批准卡模板（PAO_HOME/pao配置/卡模板/ 下的 侦察/巡库/评审 等，或绝对路径）的正文骨架——预填目标写法、机械验收三句式与约束引用；frontmatter 仍由本工具参数生成，模板只贡献正文。",
		parameters: buildCardParams,
		execute: async (_toolCallId, params) => {
			const text = await executeBuildCard(params, options);
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	pi.registerTool({
		name: "pao_submit_receipt",
		label: "交回执",
		description:
			"worker 交回执（只追加通道）：必带卡号+尝试号，追加到卡正文回执区（原子写）。硬校验三格：声明了产物路径则须真实存在（相对项目根）、摘要 ≤3 行、尝试号与卡面一致（旧尝试走留档通道）。不能改状态、不能改信封字段；旧尝试回执只留档不推进状态；卡已终态按迟到回执留档。回执≠终态：回执只代表 worker 声称完成，卡的终态变更唯经 owner 执行 pao_change_status。",
		parameters: submitReceiptParams,
		execute: async (_toolCallId, params) => {
			const text = await executeSubmitReceipt(params, options);
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	pi.registerTool({
		name: "pao_change_status",
		label: "改卡状态",
		description:
			"owner 改卡状态（单写者，owner 验收唯一通道）：待认领→进行中（依赖全部已交付才放行、实际启动递增尝试）、进行中→已交付/失败/取消、失败→待认领（尝试数须低于上限）。非法迁移与越权写入会被拒绝。回执成功＋机械验收过不等于终态变更；只有本工具执行成功，卡才算进入终态。",
		parameters: changeStatusParams,
		execute: async (_toolCallId, params, signal) => {
			const text = await executeChangeStatus(params, options, signal);
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	pi.registerTool({
		name: "pao_query_queue",
		label: "查队列",
		description:
			"读卡目录渲染队列：按状态分组，活卡优先级降序+创建升序，已交付完成倒序；显示依赖边、父卡边与待审标记。",
		parameters: queryQueueParams,
		execute: async (_toolCallId, params) => {
			const text = await executeQueryQueue(params, options);
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	pi.registerTool({
		name: "pao_handoff",
		label: "交接页",
		description:
			"交接页机械生成（M2-09）：四段 markdown——当前目标（队列非终态卡目标列表）／已发生改动（逐活卡认领基线比对，无基线如实标不可核验）／验证结果（卡上 ## 机械验收 段最近结论，无则标未验收）／未决事项（待审卡＋失败/取消卡）。整页只读不落盘、纯机械数据源，「已验证的」与「还在猜的」分明；worker 不得调用（owner/主控侧专用）。",
		parameters: handoffParams,
		execute: async (_toolCallId, params) => {
			const text = await executeHandoff(params, options);
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	pi.registerTool({
		name: "pao_check_overreach",
		label: "越界写检测",
		description:
			"越界写检测（§14）：以 git 真相（认领基线后的工作区差异）比对回执声明的产物清单，输出 虚报（声明了没改）/越界（改了没声明）/相符/不可核验 四清单与五态结论。只读检测不落任何改动；主控在改状态前跑，worker 交付与扇出认领已内置同款核查。",
		parameters: checkBoundaryParams,
		execute: async (_toolCallId, params) => {
			const text = await executeCheckBoundaryWrite(params, options);
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	// /pao queue（原 /队列,2026-10-03 命令统一迁入 pao 子命令路由）
	addPaoSubcommand(pi, {
		name: "queue",
		label: "队列",
		description:
			"查看任务卡队列（按状态分组渲染）；参数 --全部 按项目清单聚合各服务过项目的队列计数（不可达显式标注，不当零任务）",
		run: async (pi, args) => {
			let text: string;
			try {
				const trimmed = args.trim();
				if (trimmed === "--全部" || trimmed.startsWith("--全部")) {
					// --全部：读 PAO_HOME/项目清单.md 聚合全部项目队列（只读，M2-01 §5）
					const home = options?.resolvePaoHome ? options.resolvePaoHome() : resolvePaoHome();
					text = renderAllQueues(home);
				} else {
					const cardsDir = trimmed || options?.resolveCardsDir?.();
					if (!cardsDir) {
						text = "未提供卡目录：用法 /pao queue <卡目录绝对路径>，或在扩展配置中注入默认卡目录。";
					} else {
						const views = listCards(cardsDir).map((card) => toQueueView(card, isPendingReview(card)));
						const base = renderQueue(views);
						const extra = options?.appendQueueSections ? await options.appendQueueSections() : [];
						text = [base, ...extra].join("\n\n");
					}
				}
			} catch (error) {
				text = error instanceof PaoCardError ? `[${error.code}] ${error.message}` : String(error);
			}
			pi.sendMessage({
				customType: "pao-queue",
				content: [{ type: "text", text }],
				display: true,
			});
		},
	});
}
