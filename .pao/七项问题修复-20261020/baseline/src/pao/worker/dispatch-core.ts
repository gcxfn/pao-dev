/**
 * 单卡派发共享核心(pao_dispatch_card 与 pao_fanout 同一条链路,2026-10-02 定案):
 * 校验 → 认领(unclaimed→in_progress,失败卡先重开)＋认领基线快照 → 构建 runOptions → 拉起 → 登记。
 *
 * 从 fanout/execute.ts 提取(认领状态迁移＋基线快照＋runOptions 构建),fanout 改为调用本模块;
 * 依赖方向 fanout→worker 单向——本模块不得 import fanout,故 worker 提示词构建
 * (buildWorkerPrompt)与回执缺省分型(classifyWorkerFailure)随之迁入,fanout/plan 再转发导出
 * 保公共面不变。权限(fail-closed)与部门并发上限(保温配置)是 pao_dispatch_card 的派前校验,也在此。
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { FailureType } from "../cards/index.ts";
import {
	appendReceipt,
	blackboardPointer,
	changeCardStatus,
	checkDependencies,
	ensureBlackboard,
	formatCardNumber,
	listCards,
	PaoCardError,
	type ParsedCard,
	parseCardRef,
	projectRootForCards,
	type ReceiptOutcome,
	readCard,
	scanCards,
	snapshotClaimBaseline,
} from "../cards/index.ts";
import type { CardBudget } from "../cards/types.ts";
import { readWarmConfig, WARM_CONFIG_RELATIVE_PATH } from "../host/config.ts";
import { isPatrolGoal } from "../patrol/draft.ts";
import { resolvePaoRole } from "../role.ts";
import { loadTierConfig, resolveTierConfigPath, tierNameToModel } from "../routing/config.ts";
import { logWarn } from "../shared/log.ts";
import { pathKey } from "../shared/path-key.ts";
import { nowString } from "../shared/time.ts";
// 工作流解释已归 workflow/dispatch-context（T02）:worker 只经注入回调消费其最小上下文,
// 这里仅类型引用（import type,运行期零依赖）——worker 不得再 import workflow 实现。
import type { WorkflowDispatchContext } from "../workflow/dispatch-context.ts";
import { checkCleanupReadyForDispatch } from "./cleanup.ts";
import { PaoWorkerError } from "./errors.ts";
import { acquireProjectLock, type ProjectWriteLock, releaseProjectLock } from "./lock.ts";
import type { WorkerReceipt } from "./receipt.ts";
import type { ProcessEntry } from "./registry.ts";
import type { WorkerRunner, WorkerRunOptions } from "./runner.ts";

// ── 提示词与分型(自 fanout/plan 迁入;fanout/plan 转发导出,公共面不变) ──────────

/** worker 提示词:只给指针(卡文件路径),不搬运卡面内容(指针铁律,架构 §2)。
 *  末段 JSON 协议即 schema 正本(伴生形态,2026-10-07 S5 包1起含任务态四态+verification+changes)。 */
export function buildWorkerPrompt(card: ParsedCard, attemptNo: number): string {
	return [
		`你是 pao worker,执行${formatCardNumber(card.card_no)}(尝试 ${attemptNo})。`,
		`先读卡文件:${card.path}`,
		"卡上的目标/输入/约束/验收是唯一任务定义;按输入指针自取材料,不把目录翻一遍。",
		'最后一条助手消息必须只输出 JSON 回执：{"result":"success","artifact_path":[],"summary":"不超过 3 行"}。没有文件产物时明确写 []；文件产物写相对项目根的真实路径。失败/未知须加 "failure_type"（transient/missing_input/insufficient_capability/unknown_outcome）。不要用退出码、普通说明或虚构路径代替回执。',
		'另须自报（键名逐字一致）：任务态∈{"completed"|"completed_with_deviations"|"blocked"|"checkpoint"}——验收全达标=completed；有未达项但可交付=completed_with_deviations；无法继续须用户输入=blocked；到决策点须指引=checkpoint。verification=[{"条件":"…","结论":"pass"|"fail"|"not_run","证据":"…"}] 逐条对卡上验收自核（没跑的写 not_run，不谎报 pass）。changes=[{"路径":"…","类型":"created"|"modified"|"deleted"|"moved"|"untouched","说明":"…"}] 声明本次全部文件改动（含源码修改，不只产物）。自报只拦不放行：谎报 pass 不会免检，漏报改动会被 git 真值比对拦下。',
		"Windows 脚本编码：新增或改写含中文的 .ps1 时，必须保存为带 UTF-8 BOM 的 UTF-8（PowerShell 5.1 才能正确识别中文）；其他文件不强制加 BOM。写入后须实际运行验证脚本行为。",
		// 只许/禁止清单（S5 包4 四写法③：纪律白纸黑字进角色提示词,不只留在架构文档）
		"只许:按卡干活;一次性任务,完成即交回执并退出;只写任务工作区与目标项目。",
		"禁止:不得再派发子任务;不得翻查输入指针之外的材料;不得改卡状态与信封字段(回执由 owner 转交);不得谎报 pass 或漏报改动(机械验收有 git 真值比对)。",
	].join("\n");
}

/**
 * worker 回执状态 → 失败四型的缺省分型(架构 §2.1;与 cards 的 routeFailure 同一口径)。
 * - unknown(runner 的 "unknown":已改项目但拿不到结果)→ "unknown_outcome";
 * - failed → 缺省按 "transient"(可自动重派)路由;missing_input/insufficient_capability 的精细分型由回执审查阶段订正,
 *   机器不冒充判断;
 * - success/canceled 不算失败,返回 undefined。
 */
export function classifyWorkerFailure(
	receipt: Pick<WorkerReceipt, "status" | "failure_type">,
): FailureType | undefined {
	if (receipt.failure_type && (receipt.status === "failed" || receipt.status === "unknown"))
		return receipt.failure_type;
	if (receipt.status === "unknown") return "unknown_outcome";
	if (receipt.status === "failed") return "transient";
	return undefined;
}

// ── S5 包4 四写法②：回执标签路由（任务态→处理动作,单源）＋③ 主控/部长纪律块 ────

/** 任务态标签 → owner 处理动作对照（办完即停,不忙等;消费面:派单结果/扇出摘要,别处引用不复制正文） */
export function taskStateRoutingLine(任务态: NonNullable<WorkerReceipt["任务态"]>): string {
	switch (任务态) {
		case "completed":
			return "任务态 completed（自报验收全达标）→ pao_verify_card 机械验收，过则交付；办完即停，不忙等";
		case "completed_with_deviations":
			return "任务态 completed_with_deviations（有未达项）→ 先审 verification 中 fail/not_run 条目再定验收；办完即停，不忙等";
		case "blocked":
			return "任务态 blocked（须用户输入）→ 补输入或退回补卡，不忙等";
		case "checkpoint":
			return "任务态 checkpoint（到决策点须指引）→ 给指引后可另开新尝试续跑，不忙等";
	}
}

/** 主控/部长派单纪律块（S5 包4 四写法③：单写者/不读产物正文/不亲自动手/上限,随 pao_dispatch_card 描述注入） */
export const OWNER_DISPATCH_DISCIPLINES =
	"只许/禁止（角色纪律，白纸黑字）：卡状态与信封字段只经状态机单写（单写者）；主控/部长不读产物正文，只读回执与机械验收结论；不亲自改任务产物——派卡交付；worker 数受部门并发上限与共享名额约束。" +
	"派完即停：派出即返回，不忙等不轮询——回执/静默提醒经 pao 派卡通知 唤醒后再进（消息唤醒，不为等待 worker 建模型轮询）。";

// ── S5 包3：同号重试去重（唯一操作号＝卡路径＋尝试号）与认领租约 ────────────────

/**
 * 拒派原因＋同号去重信息（S5 包3）：进行中卡的拒因附带当前尝试既有回执结果——
 * 已有回执＝返回既有结果（同号不重派,按回执处理）;无回执＝结果未知（先查现场,重启不盲重放）。
 * 其余状态沿用 claimRefusalReason 原文案。
 */
export function claimRefusalDetail(card: ParsedCard): string | undefined {
	const reason = claimRefusalReason(card.frontmatter.status);
	if (reason === undefined || card.frontmatter.status !== "in_progress") return reason;
	const attempt = card.frontmatter.attempt;
	const receipts = card.receipts.filter((r) => r.attempt === attempt && !r.archive_flag);
	if (receipts.length === 0) {
		return `${reason}。当前尝试 ${attempt} 无回执＝结果未知：先查现场（pao_inventory；live 证据以登记表为准），重启后不盲重放在途操作`;
	}
	const last = receipts[receipts.length - 1];
	return `${reason}。同号重试去重：当前尝试 ${attempt} 已有回执（result ${last.result ?? "未记"}${last.任务态 ? `，任务态 ${last.任务态}` : ""}）——按回执处理（机械验收/落终态），同号不重派`;
}

/** 认领租约三字段（S5 包3,运行器事实）：到期＝监督信号（不自动放权）;时长与派发超时同源配置 */
export function buildClaimLease(
	now: Date,
	leaseMs: number,
	generation: number,
): { 认领时间: string; 租约到期: string; 认领代数: number } {
	return {
		认领时间: now.toISOString(),
		租约到期: new Date(now.getTime() + leaseMs).toISOString(),
		认领代数: generation,
	};
}

/** 路径等价判定（shared/path-key 唯一实现,与 runner executionKey 同口径）;pao_terminate_card 同号收窄同用 */
export function sameCardPath(a: string, b: string): boolean {
	return pathKey(a) === pathKey(b);
}

/**
 * 孤儿显式接管（S5 包3,仅 接管=true 时进入）：进行中卡＋登记表无活条目 → 推进代数、
 * 卡走状态机落失败（结果未知,依据＝孤儿接管）,随后 claimCardForDispatch 按失败重开分支
 * 开新尝试。三种拒绝:已有当前尝试回执（同号去重优先）、登记表有活进程（先终止）、非进行中
 * （走常规认领分支,接管参数无效）。跨进程旧链在途由项目写锁拦（锁被占用即拒）。
 */
async function takeoverOrphanForDispatch(
	registry: { list(): ProcessEntry[]; bumpClaimGeneration(cardPath: string): number },
	input: DispatchClaimInput,
): Promise<string | undefined> {
	const located = locateDispatchCard(input.cardsDir, input.card_no);
	if (located.frontmatter.status !== "in_progress") return undefined;
	const receipts = located.receipts.filter((r) => r.attempt === located.frontmatter.attempt && !r.archive_flag);
	if (receipts.length > 0) {
		const last = receipts[receipts.length - 1];
		return `接管被拒：当前尝试 ${located.frontmatter.attempt} 已有回执（result ${last.result ?? "未记"}${last.任务态 ? `，任务态 ${last.任务态}` : ""}）——同号不重派，按回执处理（机械验收/落终态），要重做先落终态再派`;
	}
	const live = registry
		.list()
		.find((entry) => entry.running && entry.card_path !== undefined && sameCardPath(entry.card_path, located.path));
	if (live) {
		return `接管被拒：卡${formatCardNumber(located.card_no)} 尝试 ${located.frontmatter.attempt} 仍有活进程(pid=${live.pid})——先 pao_terminate_card 停掉再接管，不双跑`;
	}
	// 推进代数（旧条目随之打 被接管）,再走状态机落失败——依据留痕进回执区
	registry.bumpClaimGeneration(located.path);
	changeCardStatus(located, {
		操作者: input.operator,
		to: "failed",
		失败类型: "unknown_outcome",
		依据: `孤儿接管：当前尝试 ${located.frontmatter.attempt} 无回执且登记表无活进程，由 ${input.operator} 显式接管推进代际`,
		时间: input.time,
	});
	return undefined;
}

// ── 时间与回执落卡(自 fanout/execute 迁入,两条链路同一实现) ──────────────────

// 回执/owner 记录的时间格式是卡片协议冻结的本地「YYYY-MM-DD HH:mm」——唯一实现在
// shared/time(9 处重复定义合一);机器可读字段(登记表等)才用 UTC ISO,别混。

/** 回执使用启动时捕获的尝试号；重读只为按当前状态判断旧尝试/迟到回执。 */
export async function appendDispatchReceipt(
	card: ParsedCard,
	receipt: WorkerReceipt,
	now: () => Date = () => new Date(),
): Promise<ReceiptOutcome> {
	const current = readCard(card.path);
	return appendReceipt(current, {
		尝试号: card.frontmatter.attempt,
		时间: nowString(now()),
		结果: receipt.status,
		摘要: receipt.summary,
		产物路径: receipt.artifact_path,
		证据: receipt.evidence_path ? [receipt.evidence_path] : undefined,
		用量: {
			...receipt.usage,
			toolCalls: receipt.工具调用次数,
			missing_usage_rounds: receipt.missing_usage_rounds,
			run_id: receipt.run_id,
		},
		失败类型: classifyWorkerFailure(receipt),
		// F-A7 自报透传（S5 包1）：任务态/verification/changes 落卡，机械验收消费。
		任务态: receipt.任务态,
		verification: receipt.verification,
		changes: receipt.changes,
	});
}

// ── 认领链路(自 fanout/execute 提取;操作者参数化:扇出=主控,派单=派单者) ────────

/** 扇出以主控身份做 owner 侧动作(认领/重开);架构 §1「蜂群是主会话的一个动作」 */
export const FANOUT_OPERATOR = "主控";

export function locateDispatchCard(cardsDir: string, cardNo: string): ParsedCard {
	const target = parseCardRef(cardNo);
	const { cards, problems } = scanCards(cardsDir);
	const card = cards.find((parsed) => parsed.card_no === target);
	if (!card) {
		// 坏卡会让「找不到」变成假结论：把读不到的卡一并报出来，别让 owner 去猜（审查第 5 项）
		const unreadable =
			problems.length > 0
				? `；另有 ${problems.length} 张卡读不出来：${problems.map((p) => `${p.path}（${p.reason}）`).join("；")}`
				: "";
		throw new PaoCardError("INVALID_CARD", `卡目录 ${cardsDir} 中找不到卡${cardNo}${unreadable}`, {
			卡号: cardNo,
			cardsDir,
			读取问题: problems,
		});
	}
	return card;
}

/**
 * 同步拒派判定(纯函数,2026-10-05 修):终态/进行中卡不可认领的拒派原因——claimCard 的
 * 链内把关与 pao_dispatch_card 的即时回执共用一份文案,已交付卡重复派单不再只等下一轮派卡通知
 * 才能看到原因。可认领状态(unclaimed/failed)返回 undefined。
 */
export function claimRefusalReason(status: string): string | undefined {
	if (status === "delivered" || status === "canceled") return `卡已终态(${status}),不重跑;要重做请另立新卡`;
	if (status === "in_progress") {
		return "卡在先前的尝试手中(in_progress),不双跑;先由 owner 查现场并落终态(failed/canceled)再重派(架构 §2.1)";
	}
	return undefined;
}

/**
 * 拉起前的卡状态处理(owner 侧,经 changeCardStatus 走状态机,不手写 frontmatter):
 * - 待认领 → 认领进行中(尝试 +1,无主则 owner=操作者);
 * - 失败 → 点名即重派决定:失败→待认领(校验 owner 与尝试上限)→进行中;
 * - 进行中 → 不拉起(在先前尝试手中,防双跑;先由 owner 查现场落终态再重派,架构 §2.1);
 * - 已交付/取消 → 不拉起(已终态,重做请另立新卡)。
 */
function claimCard(card: ParsedCard, operator: string, time: string): { card: ParsedCard } | { 原因: string } {
	const status = card.frontmatter.status;
	const refusal = claimRefusalDetail(card);
	if (refusal) return { 原因: refusal };
	if (status === "failed") {
		const reopened = changeCardStatus(card, { 操作者: operator, to: "unclaimed", 时间: time });
		return { card: changeCardStatus(reopened, { 操作者: operator, to: "in_progress", 时间: time }) };
	}
	return { card: changeCardStatus(card, { 操作者: operator, to: "in_progress", 时间: time }) };
}

/** 认领基线快照结果(R14/架构 §14):扇出与派单同一形状 */
export interface DispatchBaseline {
	可用: boolean;
	/** 快照文件路径(可用时才有) */
	快照路径?: string;
	/** 认领当刻工作树已有的改动条数(用户既有脏文件数,不计 worker 的账) */
	既有条目数: number;
	/** 不可用原因(非 git 仓库/git 不可用) */
	原因?: string;
}

/**
 * 认领基线快照(§14/R14):认领与新尝试(原状态 unclaimed/failed)才落快照,与工具层 pao_change_status
 * 走同一快照入口 snapshotClaimBaseline,交回执比对与交卷清点才有依据。
 * 非认领(终态/进行中卡)返回 undefined;快照不可用不阻断认领,原因如实带上不静默。
 */
export async function claimBaselineForDispatch(input: {
	cardsDir: string;
	卡号: number;
	/** 认领前的卡状态(只有 unclaimed/failed 是新尝试认领) */
	原状态: string;
	/** 认领时的验收声明原文（S5 包2：哈希记账进快照，机械验收自动交付前比对，一变即失效须重审） */
	验收?: string;
	owner?: string;
	时间: string;
}): Promise<DispatchBaseline | undefined> {
	if (input.原状态 !== "unclaimed" && input.原状态 !== "failed") return undefined;
	try {
		const baseline = await snapshotClaimBaseline(input.cardsDir, input.卡号, {
			owner: input.owner,
			时间: input.时间,
			...(input.验收 !== undefined ? { 验收: input.验收 } : {}),
		});
		return baseline.可用
			? { 可用: true, 快照路径: baseline.快照路径, 既有条目数: baseline.既有条目数 }
			: { 可用: false, 既有条目数: 0, 原因: baseline.原因 };
	} catch (error) {
		return { 可用: false, 既有条目数: 0, 原因: error instanceof Error ? error.message : String(error) };
	}
}

export interface DispatchClaimInput {
	/** 任务工作区卡目录 */
	cardsDir: string;
	/** 卡引用(卡0017 / 卡#17 / 17 均可) */
	card_no: string;
	/** owner 侧动作身份(扇出=主控;pao_dispatch_card=派单者:主控写「主控」,部长写 PAO_DEPT 值) */
	operator: string;
	time: string;
	/**
	 * 孤儿显式接管(S5 包3):进行中卡＋登记表无活条目＋当前尝试无回执时,推进认领代数并
	 * 落失败重开新尝试。缺省 false＝进行中卡一律拒派(同号去重/查现场)。
	 */
	接管?: boolean;
}

export type DispatchClaimResult =
	| {
			可派: true;
			/** 认领后的卡(已写盘) */
			card: ParsedCard;
			尝试号: number;
			/** 认领前的状态(unclaimed/failed = 本次是真认领,已落基线快照) */
			原状态: string;
			claimBaseline?: DispatchBaseline;
	  }
	| { 可派: false; 原因: string };

/**
 * 定位卡 → 认领(unclaimed→in_progress,失败卡先重开)＋认领基线快照。
 * 找不到卡抛 PaoCardError(调用方扇出记 未拉起/派单报错);状态不允许返回 可派:false。
 */
export async function claimCardForDispatch(input: DispatchClaimInput): Promise<DispatchClaimResult> {
	const located = locateDispatchCard(input.cardsDir, input.card_no);
	const cards = listCards(input.cardsDir);
	const gate = checkDependencies(
		located.frontmatter.depends_on ?? [],
		(number) => cards.find((card) => card.card_no === number)?.frontmatter.status,
	);
	if (!gate.放行)
		return {
			可派: false,
			原因: `依赖未放行：${gate.阻塞.map((item) => `${formatCardNumber(item.卡号)}(${item.状态})`).join("、")}`,
		};
	const previousStatus = located.frontmatter.status;
	const prepared = claimCard(located, input.operator, input.time);
	if ("原因" in prepared) return { 可派: false, 原因: prepared.原因 };
	const claimBaseline = await claimBaselineForDispatch({
		cardsDir: input.cardsDir,
		卡号: located.card_no,
		原状态: previousStatus,
		验收: located.frontmatter.acceptance,
		owner: prepared.card.frontmatter.owner,
		时间: input.time,
	});
	return {
		可派: true,
		card: prepared.card,
		尝试号: prepared.card.frontmatter.attempt,
		原状态: previousStatus,
		claimBaseline: claimBaseline,
	};
}

// ── runOptions 构建(公共参数/每卡参数合并 + 部门/派单理由进登记表) ──────────────

export function buildDispatchRunOptions(input: {
	card: ParsedCard;
	尝试号: number;
	/** 公共参数(cwd/超时/环境变量/工具白名单/证据目录等) */
	公共参数?: Partial<Omit<WorkerRunOptions, "卡号" | "提示词">>;
	/** 按卡/按次追加参数;与公共参数浅合并,本参数优先 */
	追加参数?: Partial<Omit<WorkerRunOptions, "卡号" | "提示词">>;
	/** 派单理由留痕(进登记表;扇出=批次理由,派单=单卡理由) */
	派单理由?: string | null;
}): WorkerRunOptions {
	const merged: Partial<Omit<WorkerRunOptions, "卡号" | "提示词">> = { ...input.公共参数, ...(input.追加参数 ?? {}) };
	// 巡库卡=无人值守(§6 预案①硬门槛):锁定工作区随派发注入,worker 会话 shell 全过护栏。
	// 锁定值=实际 spawn cwd(runner 对缺省 cwd 回落 process.cwd(),这里同步解析保持一致)。
	if (isPatrolGoal(input.card.frontmatter.goal ?? "")) {
		merged.锁定工作区 = resolve(merged.cwd ?? process.cwd());
	}
	return {
		...merged,
		卡号: String(input.card.card_no).padStart(4, "0"),
		卡路径: input.card.path,
		尝试号: input.尝试号,
		要求回执: true,
		提示词: buildWorkerPrompt(input.card, input.尝试号),
		部门: input.card.frontmatter.dept ?? null,
		派单理由: input.派单理由 ?? null,
	};
}

// ── pao_dispatch_card 派前校验:权限(fail-closed)与部门并发上限(配额护栏) ─────────────────

export type DispatchPermission =
	| { 允许: true /** owner 侧动作身份:主控写「主控」,部长写 PAO_DEPT 值 */; 操作者: string }
	| { 允许: false; 原因: string };

/**
 * 派单权限(fail-closed,2026-10-02 定案):主控角色任意卡;部长角色必须 PAO_DEPT env 已设
 * 且与卡的「部门」frontmatter 一致,否则拒派(报错写明缺什么/差什么)。
 * worker 角色显式拒派——worker 面本就整模块跳过,这里是纵深防御,不留「非部长即主控」的暗门。
 */
export function checkDispatchPermission(input: { 卡部门: string; env?: NodeJS.ProcessEnv }): DispatchPermission {
	const env = input.env ?? process.env;
	const role = resolvePaoRole(env);
	if (role === "worker") {
		return { 允许: false, 原因: "worker 角色不得派单(worker 一次一卡,不得再派发子任务);派单是主控/部长共面" };
	}
	if (role !== "部长") return { 允许: true, 操作者: "主控" };
	const dept = env.PAO_DEPT?.trim();
	if (!dept) {
		return {
			允许: false,
			原因: "部长角色派单须先设 PAO_DEPT 环境变量(标明本部门);当前缺 PAO_DEPT,按 fail-closed 拒派",
		};
	}
	if (input.卡部门 !== dept) {
		return {
			允许: false,
			原因: `部长只派本部门卡:卡的部门是「${input.卡部门}」,与 PAO_DEPT「${dept}」不一致,拒派`,
		};
	}
	return { 允许: true, 操作者: dept };
}

/**
 * 部门并发上限缺省 3:保温配置文件不存在或键缺失时照样生效。
 * 这是配额护栏——安全默认开;与「缺保温文件=不保温」的功能语义(开关缺省关)相反,勿混。
 */
export const DEFAULT_DEPT_CONCURRENCY = 3;

/** 部门并发上限配置文件相对 PAO_HOME 的路径(保温.json 共享读取模块同源,host/config) */
export { WARM_CONFIG_RELATIVE_PATH as DEPT_CONCURRENCY_CONFIG_RELATIVE_PATH } from "../host/config.ts";

/** 读部门并发上限:配置缺失/坏 JSON/键缺失/非法值一律回落缺省 3(护栏不因配置坏而失效)。
 * 读取统一走保温配置共享模块(host/config.ts readWarmConfig),键语义全仓一份。 */
export function readDeptConcurrencyCap(paoHome: string | undefined): number {
	return readWarmConfig(paoHome).部门并发上限 ?? DEFAULT_DEPT_CONCURRENCY;
}

/**
 * 读上游并发上限(M2-03 共享额度):登记表全部活进程＋在途名额的账号级硬顶(跨部门合并计,
 * 「模型名称不同但共用账号配额的不能各算一套并发」)。键缺失/非法＝undefined＝不启用
 * 配置层(派单缺省 2/扇出计划值照旧)——这是「配额已知超卖才显式收紧」的功能语义,
 * 与部门上限护栏的安全默认开相反。真正的名额检查在 runner.reserveDispatchSlot。
 */
export function readUpstreamConcurrencyCap(paoHome: string | undefined): number | undefined {
	return readWarmConfig(paoHome).上游并发上限;
}

/**
 * 派发超时缺省 24 小时(B 档,2026-10-03 定案):机械超时的定位从主判决降级为
 * 「静默提醒叫了人但无人应答」的最后底线——监督链路是 静默→叫醒上级看输出→上级裁决
 * (pao_terminate_card),机械杀只在无人应答时兜底,防止 worker 挂死无限期占着项目写锁
 * (同项目所有卡堵死)与并发名额。此前 2h 会把还在慢跑的正常任务误杀。
 */
export const DEFAULT_DISPATCH_TIMEOUT_MS = 86_400_000;

/** 读派发超时(毫秒):保温.json「派发超时分钟」×60_000,与空闲分钟/停滞阈值分钟同款数值键口径。
 *  键缺失/非法/文件缺失/坏 JSON 一律回落缺省 24 小时(护栏语义,安全默认开:派发链不留无限期悬挂;
 *  静默提醒才是主判决,本超时只兜「叫了人也没人应答」的底)。 */
export function readDispatchTimeoutMs(paoHome: string | undefined): number {
	if (!paoHome) return DEFAULT_DISPATCH_TIMEOUT_MS;
	try {
		const raw: unknown = JSON.parse(readFileSync(join(paoHome, WARM_CONFIG_RELATIVE_PATH), "utf8"));
		const value =
			typeof raw === "object" && raw !== null && !Array.isArray(raw)
				? (raw as Record<string, unknown>).派发超时分钟
				: undefined;
		return typeof value === "number" && Number.isFinite(value) && value >= 1
			? Math.floor(value) * 60_000
			: DEFAULT_DISPATCH_TIMEOUT_MS;
	} catch {
		return DEFAULT_DISPATCH_TIMEOUT_MS;
	}
}

export { projectRootForCards };

function recipeField(recipe: string, name: string): string | undefined {
	return recipe.match(new RegExp(`^\\s*-\\s*${name}\\s*[:：]\\s*(.+)$`, "m"))?.[1].trim();
}

// ── 仓库内容不得自我提权（S5 包2/架构 §4:98,参照 maestro B-6）──────────────────
// 仓内工作流冻结实例声明的「技能」是 allow 类规则(装载面)；未经用户确认落本地前整体忽略并告警。
// 允许清单 PAO_HOME/pao配置/skills/允许清单.json 只读不写——「总是允许」只经本地用户确认写本地,
// PAO 任何代码路径不写该文件。部门配方住 PAO_HOME(用户本地,对位受信的 local settings)不受此门。

/** 技能允许清单相对 PAO_HOME 的路径。 */
export const SKILL_ALLOW_LIST_RELATIVE_PATH = join("pao配置", "skills", "允许清单.json");

/** 只读技能允许清单（技能名集合）；文件缺失/坏 JSON/表外类型一律空集（fail-closed，不猜）。 */
export function loadSkillAllowList(paoHome: string | undefined): Set<string> {
	if (!paoHome) return new Set();
	try {
		const raw: unknown = JSON.parse(readFileSync(join(paoHome, SKILL_ALLOW_LIST_RELATIVE_PATH), "utf8"));
		if (!Array.isArray(raw)) return new Set();
		return new Set(raw.filter((name): name is string => typeof name === "string" && name.trim().length > 0));
	} catch {
		return new Set();
	}
}

/** 配方「详细干法」段标题（S5 包4 双层配方切分标记）：该标题起的正文不常驻注入,worker 按需读取 */
export const RECIPE_METHOD_HEADING = "## 干法";

/** 按卡→配方默认档位→档位.json 部门默认→主力解析；显式配置损坏或找不到档位时直接拒派。
 *  工作流标记/冻结配方/实例校验已归 workflow/dispatch-context（T02）——这里只接收其解析出的
 *  节点技能（workflowSkills）与部门配方技能合并去重,worker 不再知道配方版本。 */
export function resolveDispatchParameters(
	card: ParsedCard,
	cardsDir: string,
	paoHome?: string,
	workflowSkills?: string[],
): Partial<WorkerRunOptions> {
	const result: Partial<WorkerRunOptions> = { cwd: projectRootForCards(cardsDir) };
	const recipePath = paoHome ? join(paoHome, "部门", card.frontmatter.dept, "配方.md") : undefined;
	const recipe = recipePath && existsSync(recipePath) ? readFileSync(recipePath, "utf8") : "";
	if (recipePath && recipe) {
		// 配方双层（S5 包4 四写法①）：概要（「## 干法」段之前）常驻注入,干法正文不常驻——
		// 配方加厚不增加常驻 token,worker 按指针自取。无标记的旧配方整文件路径注入,零行为变化。
		const cut = recipe.indexOf(RECIPE_METHOD_HEADING);
		result.附加系统提示词 =
			cut === -1
				? [recipePath]
				: [
						`${recipe.slice(0, cut).trimEnd()}\n\n（详细干法不常驻：按需读取 ${recipePath} 的「${RECIPE_METHOD_HEADING}」段；概要与职责边界以本段为准）`,
					];
	}
	const recipeTier = recipeField(recipe, "默认档位")?.split(/[（(]/)[0].trim();
	const configPath = paoHome ? resolveTierConfigPath(paoHome) : undefined;
	// §22 第三级:档位.json「部门默认」(/model 编辑器可改)——卡与配方未指定时的部门级缺省,再兜底主力
	const deptTier =
		configPath && existsSync(configPath) ? loadTierConfig(configPath).部门默认?.[card.frontmatter.dept] : undefined;
	const tierName = card.frontmatter.tier ?? recipeTier ?? deptTier ?? "primary";
	if (configPath && (existsSync(configPath) || card.frontmatter.tier || recipeField(recipe, "默认档位"))) {
		const tier = tierNameToModel(loadTierConfig(configPath), tierName);
		result.模型 = tier.model;
		result.思考档 = tier.thinkingLevel;
	} else if (card.frontmatter.tier) {
		throw new PaoWorkerError("无效参数", `卡指定档位「${tierName}」，但缺少 PAO_HOME/档位配置`);
	}
	const 派发告警: string[] = [];
	const toolField = recipeField(recipe, "工具");
	if (toolField && !toolField.includes("待填")) {
		const tools = toolField.split(/[,，、\s]+/).filter(Boolean);
		const builtins = new Set(["read", "grep", "find", "ls", "bash", "powershell", "write", "edit"]);
		if (tools.length) {
			// 默认权限只可收紧（S5 包2）：表外名不再让整张白名单作废回全默认面（放宽方向），
			// 而是截到合法子集并告警；全表外名无合法子集可留，维持不设白名单但同样告警留痕。
			const valid = tools.filter((tool) => builtins.has(tool));
			const invalid = tools.filter((tool) => !builtins.has(tool));
			if (invalid.length > 0) {
				派发告警.push(
					`配方「工具」含表外名（${invalid.join("、")}），已截到合法子集（默认权限只可收紧，不整表放宽）`,
				);
			}
			if (valid.length > 0) result.工具白名单 = valid;
		}
	}
	const skillField = recipeField(recipe, "skills") ?? recipeField(recipe, "技能");
	if (skillField && !skillField.includes("待填") && paoHome) {
		result.skills = skillField.split(/[,，、]+/).map((skill) => resolve(paoHome, "pao配置", "skills", skill.trim()));
		for (const skill of result.skills)
			if (!existsSync(skill)) throw new PaoWorkerError("无效参数", `配方技能路径不存在：${skill}`);
	}
	// §11.6 按需技能挂载:卡面工作流标记→配方节点「技能」声明的解析（含 v2 实例校验）已归
	// workflow/dispatch-context;本函数只做与部门配方技能的合并去重（手动链/自动链统一生效）。
	// 技能装载面收窄（S5 包2/§4:98）：仓内实例声明的技能未经本地允许清单确认 → 整体忽略并告警。
	if (workflowSkills?.length) {
		const allow = loadSkillAllowList(paoHome);
		const allowed = workflowSkills.filter((skill) => allow.has(basename(skill)));
		const ignored = workflowSkills.filter((skill) => !allow.has(basename(skill)));
		if (ignored.length > 0) {
			派发告警.push(
				`仓内工作流声明的技能未经本地允许清单确认，已忽略：${ignored.map((skill) => basename(skill)).join("、")}` +
					`（人工确认后写入 $PAO_HOME/${SKILL_ALLOW_LIST_RELATIVE_PATH} 才生效；该清单只经本地用户确认，程序不代写）`,
			);
		}
		if (allowed.length > 0) result.skills = [...new Set([...(result.skills ?? []), ...allowed])];
	}
	if (派发告警.length > 0) result.派发告警 = 派发告警;
	return result;
}

function receiptBudgetTotal(
	card: ParsedCard,
	cards: ParsedCard[],
	activeAncestors: Set<number>,
): { turns: number; toolCalls: number; cost: number; unknown: Set<string> } {
	const descendants = new Set<number>([card.card_no]);
	for (;;) {
		const size = descendants.size;
		for (const candidate of cards) {
			if (candidate.frontmatter.parent && descendants.has(parseCardRef(candidate.frontmatter.parent)))
				descendants.add(candidate.card_no);
		}
		if (descendants.size === size) break;
	}
	const total = { turns: 0, toolCalls: 0, cost: 0, unknown: new Set<string>() };
	const seen = new Set<string>();
	for (const candidate of cards.filter((item) => descendants.has(item.card_no))) {
		// 母卡当前可能正等待子卡；它的本次未完回执不等于 worker 已执行却缺账。
		// 其他已认领尝试（含本卡旧尝试）若缺回执，不能按零消耗继续分同一预算。
		const reportedAttempts = new Set(
			candidate.receipts.filter((receipt) => receipt.usage?.来源 !== "汇总").map((receipt) => receipt.attempt),
		);
		for (let attempt = 1; attempt <= candidate.frontmatter.attempt; attempt++) {
			if (
				activeAncestors.has(candidate.card_no) &&
				candidate.frontmatter.status === "in_progress" &&
				attempt === candidate.frontmatter.attempt
			)
				continue;
			if (!reportedAttempts.has(attempt)) {
				for (const key of ["turns", "toolCalls", "cost"]) total.unknown.add(key);
			}
		}
		for (const receipt of candidate.receipts) {
			const usage = receipt.usage;
			if (usage?.来源 === "汇总") continue;
			const id =
				typeof usage?.run_id === "string" ? usage.run_id : `${candidate.path}:${receipt.attempt}:${receipt.time}`;
			if (seen.has(id)) continue;
			seen.add(id);
			for (const key of ["turns", "toolCalls", "cost"] as const) {
				const value = usage?.[key];
				if (typeof value === "number" && Number.isFinite(value) && value >= 0) total[key] += value;
				else total.unknown.add(key);
			}
			if (
				usage?.来源 === "未知" ||
				(typeof usage?.missing_usage_rounds === "number" && usage.missing_usage_rounds > 0)
			)
				total.unknown.add("cost");
		}
	}
	return total;
}

/** 重试与协作子卡都从同一预算池扣已用量；费用缺账不影响已知轮次/工具次数。 */
function budgetOwners(card: ParsedCard, cards: ParsedCard[]): ParsedCard[] {
	const owners = [card];
	const seen = new Set<number>([card.card_no]);
	let cursor = card;
	while (cursor.frontmatter.parent) {
		const number = parseCardRef(cursor.frontmatter.parent);
		if (seen.has(number)) throw new PaoWorkerError("无效参数", "parent 预算归属形成循环");
		seen.add(number);
		const parent = cards.find((candidate) => candidate.card_no === number);
		if (!parent) throw new PaoWorkerError("无效参数", `找不到 parent 预算归属卡：${cursor.frontmatter.parent}`);
		owners.push(parent);
		cursor = parent;
	}
	return owners;
}

export function remainingDispatchBudget(card: ParsedCard, cards: ParsedCard[]): CardBudget | undefined {
	const owners = budgetOwners(card, cards);
	const activeAncestors = new Set(owners.slice(1).map((owner) => owner.card_no));
	const remaining: CardBudget = {};
	for (const owner of owners) {
		const budget = owner.frontmatter.budget;
		if (!budget) continue;
		const total = receiptBudgetTotal(owner, cards, activeAncestors);
		for (const key of ["turns", "toolCalls", "cost"] as const) {
			const limit = budget[key];
			if (limit === undefined) continue;
			if (total.unknown.has(key))
				throw new PaoWorkerError(
					"无效参数",
					`卡${formatCardNumber(owner.card_no)} 的 ${key} 已用量未知，不能确认剩余预算`,
				);
			const value = limit - total[key];
			if (value <= 0) throw new PaoWorkerError("无效参数", `卡${formatCardNumber(owner.card_no)} 预算耗尽：${key}`);
			remaining[key] = Math.min(remaining[key] ?? value, value);
		}
	}
	return Object.keys(remaining).length ? remaining : undefined;
}

const projectQueues = new Map<string, Promise<void>>();

async function queueProjectWrite(root: string, signal?: AbortSignal): Promise<() => void> {
	const key = pathKey(root);
	const previous = projectQueues.get(key) ?? Promise.resolve();
	let release: () => void = () => {};
	const held = new Promise<void>((resolveHeld) => {
		release = resolveHeld;
	});
	const tail = previous.then(() => held);
	projectQueues.set(key, tail);
	void tail.then(() => {
		if (projectQueues.get(key) === tail) projectQueues.delete(key);
	});
	let onAbort: (() => void) | undefined;
	try {
		await Promise.race([
			previous,
			new Promise<never>((_resolve, reject) => {
				onAbort = () => reject(new PaoWorkerError("已取消", "等待项目写锁期间已取消"));
				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
			}),
		]);
		return release;
	} catch (error) {
		release();
		throw error;
	} finally {
		if (onAbort) signal?.removeEventListener("abort", onAbort);
	}
}

export interface ExecuteDispatchOptions {
	运行器: WorkerRunner;
	paoHome?: string;
	并发上限?: number;
	等待名额?: boolean;
	公共参数?: Partial<Omit<WorkerRunOptions, "卡号" | "提示词">>;
	每卡参数?: (card: ParsedCard) => Partial<Omit<WorkerRunOptions, "卡号" | "提示词">>;
	信号?: AbortSignal;
	认领?: (claim: Extract<DispatchClaimResult, { 可派: true }>) => void;
	/**
	 * 工作流派发校验回调（T02 装配注入,实现归 workflow/dispatch-context）:
	 * 派发准备期解析工作流卡最小上下文（按需技能+实例身份;普通卡 undefined,非法即抛错拒派）;
	 * executeDispatch 在取得项目写锁后、认领拉起前用同一回调重读控制正本做最终重核
	 * （实例/轮次/owner/暂停/冻结版本,任一漂移即拒绝启动）。缺回调一律拒派——
	 * 工作流卡不能绕过实例校验（fail-closed,不默认放行）。
	 */
	workflowCheck: (card: ParsedCard) => WorkflowDispatchContext | undefined;
	/**
	 * 总预算门禁接线（计划 §8.2，G4）:在**认领之前**问一次「这次派发允不允许花钱」。
	 *
	 * 不传 = 完全零行为变化（跨任务额度未启用时的常态,也是既有所有调用方的现状）。
	 * 传了就必须表态:放行交回 `commit`（预留已落盘）与 `release`（确定未开跑时归还）,
	 * 拒绝交回 `reason`（给用户看的真实原因）。拒绝发生在锁后重核之后、认领之前——
	 * 此刻卡还没有任何写盘动作,因此"拒绝"不会留下已派发的痕迹（卡状态/in-flight/通知都不会变）。
	 *
	 * 为什么不在认领之后再拦:状态机没有 `in_progress → unclaimed` 这条迁移（见
	 * cards/statemachine.ts:17-23 的 ALLOWED_TRANSITIONS），认领之后再拒绝,卡会卡在
	 * 「进行中」而根本没有 worker 在跑——那正是要防的"已派发"假象。认领只许发生在
	 * 「这一步之后不会再被拒」的位置上,所以门禁必须前置。
	 */
	预算门禁?: (card: ParsedCard, 尝试号: number) => Promise<DispatchBudgetGateResult>;
}

/** 总预算门禁的接线契约（dispatch-core 只认这个形状,不 import usage/ 的实现）。 */
export type DispatchBudgetGateResult =
	/** 放行:`commit` 在即将拉起 runner 前调用（此刻已确定要开跑）;`release` 在确定没开跑时归还。 */
	| {
			ok: true;
			/** 预留判据/身份说明（进通知与回执,便于人对照账本）。 */
			说明?: string;
			commit: () => Promise<void>;
			release: () => Promise<void>;
	  }
	/** 拒绝:`reason` 是给用户看的真实原因（含下一步）。 */
	| { ok: false; reason: string };

/**
 * 归还门禁预留（G4）:只有"确定没开跑"的路径才调到这里。
 * 归还本身失败不推翻派发结果（卡状态与拒派原因才是真相）,记警示后放行——
 * 与认领基线/四指标账同款边界:派生数据落不了账不影响主判决。
 */
async function releaseGateQuietly(
	gate: Extract<DispatchBudgetGateResult, { ok: true }>,
	input: DispatchClaimInput,
): Promise<void> {
	try {
		await gate.release();
	} catch (error) {
		logWarn(
			`[pao] 总预算门禁预留归还失败（派发结果不受影响,额度可能仍占着,请核对总预算账）:卡${input.card_no} ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

/**
 * 单一受保护派发入口（T03:正式派发只有这一条事务链）。单卡(pao_dispatch_card)、扇出(pao_fanout)、
 * 工作流自动链三个入口都经它派发,准入判断同源;职责按五段拆在本模块既有函数,不另设管理器:
 * ①参数准备 resolveDispatchParameters/buildDispatchRunOptions
 * ②准入 checkDispatchPermission(工具层)/预算/名额/项目写锁/workflowCheck 锁后重核
 * ③认领 claimCardForDispatch(含基线快照) ④启动 runner.run ⑤结果处理 completed 回调＋finally 逆序释放
 * （写锁→名额→预算队列→项目队列;先停后放锁,停止确认失败不放锁）。
 * 锁序固定:项目队列→预算队列→并发名额→项目写锁→重核→认领,与既有安全约束一致。
 */
export async function executeDispatch<T>(
	input: DispatchClaimInput & { dispatch_reason?: string },
	options: ExecuteDispatchOptions,
	completed: (claim: Extract<DispatchClaimResult, { 可派: true }>, receipt: WorkerReceipt) => Promise<T>,
): Promise<{ 可派: true; result: T } | { 可派: false; 原因: string }> {
	const runner = options.运行器;
	// 工作流校验回调必填（fail-closed）:没有它就无法保证工作流卡的实例校验,任何卡都不放行。
	const workflowCheck = options.workflowCheck;
	if (!workflowCheck)
		throw new PaoWorkerError(
			"无效参数",
			"缺工作流派发校验回调（workflowCheck）:工作流卡不能绕过实例校验,拒派（fail-closed）",
		);
	const initial = locateDispatchCard(input.cardsDir, input.card_no);
	// 准备期工作流解释（workflow 模块注入）:解出按需技能并早失败;普通卡 undefined 零行为。
	const workflow = workflowCheck(initial);
	const resolved = resolveDispatchParameters(initial, input.cardsDir, options.paoHome, workflow?.skills);
	const extra = { ...options.公共参数, ...options.每卡参数?.(initial), 信号: options.信号 };
	const tools = extra.工具白名单 ?? resolved.工具白名单;
	const readOnly = !!tools?.length && tools.every((tool) => ["read", "grep", "find", "ls"].includes(tool));
	const projectRoot = projectRootForCards(input.cardsDir);
	const releaseQueue = readOnly ? () => {} : await queueProjectWrite(projectRoot, options.信号);
	let releaseBudgetQueue: (() => void) | undefined;
	let releaseSlot: (() => void) | undefined;
	let lock: ProjectWriteLock | undefined;
	let outcome!: { 可派: true; result: T } | { 可派: false; 原因: string };
	let bodyError: unknown;
	let stopConfirmFailed: unknown;
	/** 归一化尝试号（门禁要用它做判据；未注入门禁时不参与任何逻辑）。 */
	let 尝试号: number | undefined;
	/** 门禁预留是否已转成"已提交"（= 已经开始可能花钱）。 */
	let gateCommitted = false;
	/**
	 * 门禁放行后挂在这里的预留句柄:非 undefined 且未提交 = 还没来得及开跑,finally 负责归还。
	 * 声明在 try 外是因为 finally 要看见它（try 块内的 let 在 finally 里不可见）。
	 */
	let gate: Extract<DispatchBudgetGateResult, { ok: true }> | undefined;
	try {
		if (options.信号?.aborted) throw new PaoWorkerError("已取消", "派发在认领前已取消");
		const card = locateDispatchCard(input.cardsDir, input.card_no);
		const poolOwner = budgetOwners(card, listCards(input.cardsDir))
			.filter((owner) => {
				const budget = owner.frontmatter.budget;
				return budget && [budget.turns, budget.toolCalls, budget.cost].some((value) => value !== undefined);
			})
			.at(-1);
		if (poolOwner)
			releaseBudgetQueue = await queueProjectWrite(`${projectRoot}\u0000预算:${poolOwner.path}`, options.信号);
		remainingDispatchBudget(locateDispatchCard(input.cardsDir, input.card_no), listCards(input.cardsDir));
		// 共享上游额度(M2-03):保温.json「上游并发上限」是账号级硬顶,与本次派发意愿取小;
		// 键缺失＝不启用配置层(派单缺省 2/扇出计划值照旧,行为不变)。
		const upstreamCap = readUpstreamConcurrencyCap(options.paoHome);
		const willingnessLimit = options.并发上限 ?? 2;
		releaseSlot = await runner.reserveDispatchSlot({
			身份: card.path,
			部门: card.frontmatter.dept ?? null,
			部门上限: readDeptConcurrencyCap(options.paoHome),
			并发上限: upstreamCap !== undefined ? Math.min(willingnessLimit, upstreamCap) : willingnessLimit,
			等待: options.等待名额,
			信号: options.信号,
		});
		const budget = remainingDispatchBudget(
			locateDispatchCard(input.cardsDir, input.card_no),
			listCards(input.cardsDir),
		);
		if (!readOnly) lock = await acquireProjectLock({ 项目根: projectRoot, 持有者: card.path });
		// 派前最终重核（§3.3）:项目写锁到手后、认领拉起前重读控制正本——实例/轮次/owner/暂停/
		// 冻结版本任一漂移即拒绝启动（fail-closed）;准备期的检查结果不作永久许可。此刻认领尚未
		// 发生,拒派不给卡留任何已写状态。
		workflowCheck(locateDispatchCard(input.cardsDir, input.card_no));
		// 删除任务共享门禁：固定正文声明段一旦出现，首次只能在 owner 预演之后继续；预演+确认
		// 必须仍与当前文件元数据一致。所有单卡、扇出、工作流入口都在此处共用，普通卡零影响。
		const cleanupGate = await checkCleanupReadyForDispatch(
			input.cardsDir,
			locateDispatchCard(input.cardsDir, input.card_no),
			options.信号,
		);
		if (!cleanupGate.ok) {
			outcome = { 可派: false, 原因: cleanupGate.reason };
		} else {
			// 孤儿显式接管（S5 包3,锁内执行）:接管被拒（有回执/有活进程）即整单拒派;
			// 接管成功＝卡已落失败,随后 claimCardForDispatch 按失败重开分支开新尝试。
			const takeoverBlocked = input.接管 ? await takeoverOrphanForDispatch(runner.registry, input) : undefined;
			// 总预算门禁（G4,计划 §8.2）:位置刻意见注释——锁后重核之后、认领之前。
			// 此刻卡还没被写过,拒绝即"零痕迹";认领之后再拒会留下 in_progress 假象且无迁移可退。
			// 未注入预算门禁（= 用户没给总预算的常态）时这一段整体跳过,行为与原先逐字一致。
			let gateRefusal: string | undefined;
			if (options.预算门禁 && takeoverBlocked === undefined) {
				const gateCard = locateDispatchCard(input.cardsDir, input.card_no);
				尝试号 = gateCard.frontmatter.attempt + 1;
				const verdict = await options.预算门禁(gateCard, 尝试号);
				if (verdict.ok) gate = verdict;
				else gateRefusal = verdict.reason;
			}
			const claimed =
				takeoverBlocked !== undefined
					? ({ 可派: false as const, 原因: takeoverBlocked } as const)
					: gateRefusal !== undefined
						? ({ 可派: false as const, 原因: `总预算门禁拒绝派发：${gateRefusal}` } as const)
						: await claimCardForDispatch(input);
			if (!claimed.可派) {
				// 门禁已放行但最终没认领成功（依赖未放行/状态不允许/并发变更）:没有开跑,
				// 预留由 finally 统一归还,这里只如实给出拒派原因。
				outcome = claimed;
			} else {
				options.认领?.(claimed);
				// 任务黑板(M2-03):认领成功即首建(存在跳过,幂等);建失败不拒派——黑板是协作辅助,
				// 卡文件才是真相,写入失败只降级为无黑板可写。
				try {
					ensureBlackboard(input.cardsDir);
				} catch {
					// 首建失败(如只读文件系统)随派发继续,不阻塞任务
				}
				// 附加系统提示词是追加语义:配方提示(resolveDispatchParameters)与调用方注入
				// (M2-01 宿主的交接页指针等)拼接,不互相覆盖;黑板指针压轴(最贴近接卡动作);
				// 无注入时行为与原先完全一致。
				const extraPrompt = [
					...(resolved.附加系统提示词 ?? []),
					...(extra.附加系统提示词 ?? []),
					blackboardPointer(input.cardsDir),
				];
				const runOptions = buildDispatchRunOptions({
					card: claimed.card,
					尝试号: claimed.尝试号,
					公共参数: { ...resolved, ...extra, ...(extraPrompt.length > 0 ? { 附加系统提示词: extraPrompt } : {}) },
					追加参数: { 预算: budget },
					派单理由: input.dispatch_reason,
				});
				// 派发缺省超时(兜底护栏):调用方未显式给 超时毫秒 时按保温配置兜底(缺省 24 小时)——
				// 到点走与主动停止相同的收敛路径(树杀→证据→超时回执→finally 放锁/名额),不留无限期悬挂。
				// B 档定位:静默提醒叫人裁决是主判决,本超时只兜「无人应答」的底。
				runOptions.超时毫秒 ??= readDispatchTimeoutMs(options.paoHome);
				// 认领租约(S5 包3,运行器事实):认领时间/租约到期＝监督信号(到期不自动放权,amber 呈现),
				// 认领代数＝接管代际;时长与派发超时同源配置,随 run() 落登记表条目。
				runOptions.租约 = buildClaimLease(
					new Date(),
					runOptions.超时毫秒,
					runner.registry.claimGeneration(claimed.card.path),
				);
				// 门禁放行且认领成功＝这次真开跑:把"预留"转成"已提交"（此刻之后不再归还,
				// 因为 worker 可能已经花了钱）。commit 只落盘记账,不拉起任何进程。
				// 清空 gate 的时机在 commit 成功之后:commit 自己抛错＝还没开跑,交给 finally 归还。
				if (gate) {
					await gate.commit();
					gate = undefined;
					gateCommitted = true;
				}
				const receipt = await runner.run(runOptions);
				outcome = { 可派: true, result: await completed(claimed, receipt) };
			}
		}
	} catch (error) {
		bodyError = error;
	} finally {
		// 预留归还（G4）:只在"确定没开跑"时归还——gate 仍挂着＝commit 没成功（或压根没认领成功）,
		// 线程从未拉起,这笔钱没花;已 commit 或已有回执的都不归还（结果不明按 G2 口径留给人工查）。
		if (gate && !gateCommitted) await releaseGateQuietly(gate, input);
		try {
			if (lock) await releaseProjectLock(lock, runner.confirmStopped(initial.path));
		} catch (error) {
			stopConfirmFailed = error;
		}
		releaseSlot?.();
		releaseBudgetQueue?.();
		releaseQueue();
		if (stopConfirmFailed !== undefined && bodyError !== undefined) {
			// 原始错误优先上抛,停止确认失败单独记录不遮蔽
			logWarn(
				`[pao] 派发停止确认失败(锁未放,先停后放锁):${stopConfirmFailed instanceof Error ? stopConfirmFailed.message : String(stopConfirmFailed)}`,
			);
		}
	}
	if (bodyError !== undefined) throw bodyError;
	if (stopConfirmFailed !== undefined) throw stopConfirmFailed;
	return outcome;
}
