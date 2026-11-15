/**
 * 完整任务受理（complete intake）——计划 §5.2 的唯一业务入口。
 *
 * ## 一句话
 * `acceptIntake(cardsDir, requests, options)` 一次调用做完「集中预检 → 建卡 → 可选派发 → 返回真实身份」，
 * 逐条给出受理身份或真实拒绝原因；终端、桌面、批量三条入口**只做参数适配**，共用这一个函数。
 *
 * ## 旧入口适配（不改旧工具行为、不改工具名——兼容契约）
 * | 旧入口 | 在新入口里是哪一步 |
 * |---|---|
 * | `pao_build_card`（建卡） | 第③步「建卡」：逐条调 cards 的 `createCard`，同一个发号器、同一个原子写 |
 * | `pao_dispatch_card`（派发） | 第⑤步「派发」：`request.dispatch === true` 时经注入的 `dispatchInBackground` 走既有后台派发链（同 `executeDispatch`） |
 * | `pao_inventory`（查询） | 不在受理链内：受理是写动作，查询仍走 pao_inventory / `/pao queue`（受理结果只回身份，不做第二套查询） |
 * 三条旧入口继续可用、语义不变；新入口不是它们的替代品，而是「把建卡＋派发合成一次调用并补上幂等与集中预检」。
 *
 * ## 为什么这样分工（同一规则只实现一次）
 * - 建卡：调 `createCard`，**不**自己发号、不自己写卡；
 * - 预检：调 `checkPreflight`，**不**另写部门/档位/预算/可写性检查；
 * - 派发：调注入的 `dispatchInBackground`（就是 worker/index.ts 里 `registerWorkerTools` 闭包那个），
 *   **不**自己 spawn runner、不新开运行时。注入而非 import，避免 `index.ts → intake → worker/index.ts` 成环；
 * - 幂等：`ledger.ts` 用既有 `withFileLock` + `writeFileAtomic` 落盘，**不**新建第二套编号。
 *
 * ## 身份回填纪律
 * 卡号/卡路径/尝试号是内核真实事实；实例/节点/轮次是工作流执行身份，只有工作流派发真实解出实例上下文
 * 时才填——普通卡没有工作流实例，如实留 `undefined`，**不编造**。派发是后台链，认领发生在后台，
 * 因此 dispatch=true 的受理返回时 `attempt` 通常为 undefined（卡面 attempt 仍为 0＝未真实启动），
 * 真实尝试号以卡面/派卡通知为准。详见 `types.ts` 的 IntakeOutcome 注释。
 */
import { resolve } from "node:path";
import { inspect } from "node:util";
import { type CardCreateInput, CardCreationReadError } from "../cards/cardfile.ts";
import {
	checkDependencies,
	createCard,
	formatCardNumber,
	listCards,
	type ParsedCard,
	projectRootForCards,
	readCard,
} from "../cards/index.ts";
import { checkPreflight, type PreflightItem, type PreflightLevel, type PreflightReport } from "../preflight/index.ts";
import { nowString, utcNow } from "../shared/time.ts";
import { checkDispatchPermission, claimRefusalDetail, locateDispatchCard } from "../worker/dispatch-core.ts";
import { commitIntakeEntry, dropIntakeKey, intakeLedgerPath, reserveIntakeKey, updateIntakeEntry } from "./ledger.ts";
import { legacyTaskFields, mergeConstraints, normalizeTaskBook, type TaskBook, taskBookFields } from "./task-book.ts";
import type {
	IntakeDispatchHook,
	IntakeLedgerEntry,
	IntakeOptions,
	IntakeOutcome,
	IntakeReport,
	IntakeRequest,
	IntakeStatus,
} from "./types.ts";

/** 会让受理停下来的预检级别；其余级别只作为 problems 带出（受理继续，但风险如实告知）。 */
const BLOCKING_LEVEL: PreflightLevel = "阻止启动";

/** 失败详情使用 Node 原生格式化，保留 code、cause 与聚合子错；不另建错误协议。 */
function intakeErrorText(error: unknown): string {
	return inspect(error, { depth: null, colors: false, customInspect: false });
}

function emptyCounts(): IntakeReport["counts"] {
	return { accepted: 0, rejected: 0, duplicate: 0, deferred: 0 };
}

/** 卡号（整数）→ 受理契约里的四位编号（"0001"）。注意 formatCardNumber 带「卡」前缀，
 *  那是卡引用/文件名的形状；IntakeOutcome.cardNo 约定为纯编号，与 parseCardRef 接受的 "17"/"卡0017" 兼容。 */
function intakeCardNo(n: number): string {
	return String(n).padStart(4, "0");
}

function outcomeFor(
	request: IntakeRequest,
	status: IntakeStatus,
	acceptedAt: string,
	extra: Partial<IntakeOutcome> = {},
): IntakeOutcome {
	return {
		idempotencyKey: request.idempotencyKey,
		status,
		acceptedAt,
		problems: [],
		dispatchRequested: request.dispatch,
		...extra,
	};
}

function problem(level: PreflightLevel, subject: string, reason: string, suggestion: string): PreflightItem {
	return { level, subject, reason, suggestion };
}

async function recordDispatchState(
	ledger: string,
	idempotencyKey: string,
	dispatched: boolean,
	attempt?: number,
): Promise<PreflightItem | undefined> {
	let reason = "找不到对应的受理账条目";
	try {
		const updated = await updateIntakeEntry(ledger, idempotencyKey, {
			dispatched,
			...(attempt !== undefined ? { attempt } : {}),
		});
		if (updated) return undefined;
	} catch (error) {
		reason = intakeErrorText(error);
		// 当前 outcome 仍按刚观察到的真实结果返回；下面只警告账未跟上，避免下次 duplicate 被误读。
	}
	return problem(
		"警告",
		"受理账",
		`卡已建好且本次派发状态为 ${dispatched ? "已提交后台派发" : "未提交后台派发"}，但受理账补写失败：${reason}；下次重复提交时该状态可能未记录`,
		"以当前结果为准；必要时查卡面和派发现场，不要仅凭旧受理账判断是否已派发",
	);
}

function requestLegacyFields(request: IntakeRequest) {
	return {
		...(request.goal !== undefined ? { goal: request.goal } : {}),
		...(request.acceptance !== undefined ? { acceptance: request.acceptance } : {}),
		...(request.inputs !== undefined ? { inputs: request.inputs } : {}),
		...(request.constraints !== undefined ? { boundaries: request.constraints } : {}),
	};
}

function normalizeRequestTask(request: IntakeRequest): TaskBook | undefined {
	return request.task ? normalizeTaskBook(request.task, requestLegacyFields(request)) : undefined;
}

/** 请求自身的静态校验（不依赖现场）：判据/目标/部门/验收非空，派发要给理由。 */
function requestShapeProblems(request: IntakeRequest, task: TaskBook | undefined): string[] {
	const problems: string[] = [];
	if (typeof request.idempotencyKey !== "string" || request.idempotencyKey.trim().length === 0)
		problems.push("缺少请求判据 idempotencyKey（没有判据无法区分重试与新任务，不猜）");
	if (!task && (typeof request.goal !== "string" || request.goal.trim().length === 0)) problems.push("缺少目标 goal");
	if (typeof request.dept !== "string" || request.dept.trim().length === 0) problems.push("缺少部门 dept");
	if (!task && (typeof request.acceptance !== "string" || request.acceptance.trim().length === 0))
		problems.push("缺少验收 acceptance");
	if (request.dispatch && (typeof request.reason !== "string" || request.reason.trim().length === 0))
		problems.push("dispatch=true 时须给派单理由 reason（trim 后不得为空；理由留痕供上级审查）");
	return problems;
}

/** 预检项 → 带进 outcome 的 problems（剔除「阻止启动」：那些会转成 rejected，不该同时出现）。 */
function nonBlockingProblems(report: PreflightReport): PreflightItem[] {
	return report.items.filter((item) => item.level !== BLOCKING_LEVEL);
}

function blockingProblems(report: PreflightReport): PreflightItem[] {
	return report.items.filter((item) => item.level === BLOCKING_LEVEL);
}

function problemText(item: PreflightItem): string {
	return `${item.subject}：${item.reason}`;
}

/**
 * 受理选项归一：项目根缺省由卡目录推导（与受理账、项目写锁同一口径）。
 * 返回 string＝选项本身不可用（缺 PAO_HOME）——受理必须如实拒绝，不能拿空 home 跑预检
 * （空 home 会让「部门未登记」变成必然结论，那是假拒绝）。
 */
function normalizeOptions(cardsDir: string, options: IntakeOptions): { projectRoot: string; paoHome: string } | string {
	const paoHome = typeof options.paoHome === "string" ? options.paoHome.trim() : "";
	if (!paoHome) return "受理未执行：缺 PAO_HOME（预检要读部门注册表/档位/预算配置，空 home 不跑）";
	const projectRoot = options.projectRoot?.trim() ? resolve(options.projectRoot) : projectRootForIntake(cardsDir);
	return { projectRoot, paoHome };
}

/**
 * 卡目录 → 项目根（复用 cards 的 projectRootForCards，唯一口径）。
 * 卡目录可能尚不存在（首次受理即建卡），而 projectRootForCards 走 realpath 会对不存在路径抛错；
 * 此时退回 `<卡目录>/../..`——与 createCard 的缺省发号路径同形（`join(cardsDir, "..", "..")`），
 * 不引入第二套项目根判据。
 */
function projectRootForIntake(cardsDir: string): string {
	try {
		return projectRootForCards(cardsDir);
	} catch {
		return resolve(cardsDir, "..", "..");
	}
}

/**
 * 建卡：请求 → 卡片协议字段（中文 frontmatter 键是外部契约，映射只在这一处）。
 * 模板正文由调用方经 `resolveTemplate` 给出（解析实现住在 cards 模板库，不在这里重做第二遍）。
 */
async function createCardForRequest(
	cardsDir: string,
	request: IntakeRequest,
	task: TaskBook | undefined,
	options: IntakeOptions,
	created: string,
): Promise<ParsedCard> {
	const templateBody = options.resolveTemplate ? await options.resolveTemplate(request) : undefined;
	const fields = task ? taskBookFields(task) : legacyTaskFields(requestLegacyFields(request));
	const constraints = mergeConstraints(fields.boundaries, task);
	const input: CardCreateInput = {
		目标: fields.goal,
		部门: request.dept,
		验收: fields.acceptance,
		...(fields.inputs !== undefined ? { 输入: fields.inputs } : {}),
		...(constraints !== undefined ? { 约束: constraints } : {}),
		...(request.depends_on !== undefined ? { depends_on: request.depends_on } : {}),
		...(request.parent !== undefined ? { parent: request.parent } : {}),
		...(request.tier !== undefined ? { 档位: request.tier } : {}),
		...(request.budget !== undefined ? { 预算: request.budget } : {}),
		...(request.priority !== undefined ? { 优先级: request.priority } : {}),
		...(request.owner !== undefined ? { owner: request.owner } : {}),
		创建: created,
		// 受理只建卡：默认待认领。派发由派发通道的认领推进，不在这里预置状态。
		状态: "unclaimed",
	};
	return createCard(cardsDir, input, {
		...(templateBody ? { 模板正文: templateBody.body } : {}),
		...(options.signal ? { signal: options.signal } : {}),
	});
}

/** 依赖是否放行（复用 cards 的 checkDependencies 纯函数，判据同队列视图）。 */
function dependenciesBlocked(cardsDir: string, card: ParsedCard): string | undefined {
	const cards = listCards(cardsDir);
	const gate = checkDependencies(
		card.frontmatter.depends_on ?? [],
		(number) => cards.find((item) => item.card_no === number)?.frontmatter.status,
	);
	if (gate.放行) return undefined;
	const detail = gate.阻塞.map((item) => `${formatCardNumber(item.卡号)}(${item.状态})`).join("、");
	return detail;
}

/**
 * 派发：经注入通道派出（唯一派发链），并把「可立即判定」的拒派原因提前到同步面。
 *
 * 先做与 `pao_dispatch_card` **同源**的同步快校验（定位 → 权限 → 拒派详情 → 依赖门），
 * 通过后才交给 dispatchInBackground（后台认领/并发/锁由派发链自己再核一遍，这里不重复实现）。
 *
 * deferred（卡已建、没派出去，必须说清为什么）：
 * - 宿主没装配 dispatchInBackground → 不自己 spawn runner；
 * - 权限不允许（部长越部门）→ 如实报；
 * - 依赖未放行 → 卡合法但此刻不该派（排队语义，不是拒绝）；
 * - 并发/预算名额满等后台链拒绝 → 由通知面回报，本条如实 deferred。
 */
async function dispatchAcceptedCard(
	cardsDir: string,
	request: IntakeRequest,
	options: IntakeOptions,
	cardNo: string,
	time: string,
): Promise<{ ok: true } | { ok: false; status: "deferred" | "rejected"; reason: string }> {
	const hook: IntakeDispatchHook | undefined = options.dispatchInBackground;
	if (!hook) {
		return {
			ok: false,
			status: "deferred",
			reason:
				"已受理并建卡，但宿主未装配派发通道（options.dispatchInBackground 未给）——受理不自己 spawn runner，请由宿主装配后经派发入口派出",
		};
	}
	let located: ParsedCard;
	try {
		located = locateDispatchCard(cardsDir, cardNo);
	} catch (error) {
		return { ok: false, status: "rejected", reason: `已建卡但派发未执行：${intakeErrorText(error)}` };
	}
	const permission = checkDispatchPermission({ 卡部门: located.frontmatter.dept });
	if (!permission.允许) return { ok: false, status: "deferred", reason: `已建卡但未派发：${permission.原因}` };
	const refusal = claimRefusalDetail(located);
	if (refusal) return { ok: false, status: "rejected", reason: `已建卡但派发被拒：${refusal}` };
	const blocked = dependenciesBlocked(cardsDir, located);
	if (blocked !== undefined)
		return {
			ok: false,
			status: "deferred",
			reason: `已建卡但未派发：依赖未放行（${blocked}）——前序完成后经派发入口派出`,
		};
	try {
		hook(
			{
				cardsDir,
				card_no: cardNo,
				operator: options.operator?.trim() || permission.操作者,
				time,
				...(request.reason !== undefined ? { dispatch_reason: request.reason.trim() } : {}),
			},
			{},
			`${resolve(cardsDir)}#卡${cardNo}`,
			cardNo,
			options.ownerSession,
		);
	} catch (error) {
		return { ok: false, status: "rejected", reason: `已建卡但派发通道调用失败：${intakeErrorText(error)}` };
	}
	return { ok: true };
}

/** 从账内既有正式条目构造 duplicate 结果（回填**第一次**的真实身份，不是布尔）。 */
function duplicateOutcome(request: IntakeRequest, entry: IntakeLedgerEntry): IntakeOutcome {
	const duplicate = outcomeFor(request, "duplicate", entry.acceptedAt, {
		cardNo: entry.cardNo,
		cardPath: entry.cardPath,
		...(entry.dispatchRequested !== undefined ? { dispatchRequested: entry.dispatchRequested } : {}),
		...(entry.dispatched !== undefined ? { dispatched: entry.dispatched } : {}),
		...(entry.attempt !== undefined ? { attempt: entry.attempt } : {}),
		...(entry.instance !== undefined ? { instance: entry.instance } : {}),
		...(entry.node !== undefined ? { node: entry.node } : {}),
		...(entry.round !== undefined ? { round: entry.round } : {}),
	});
	// outcomeFor 默认带的是「本次调用」的派发请求。旧账没有首次字段时不能拿本次值冒充历史，
	// 否则同一旧账先以 dispatch=false、后以 dispatch=true 重提，就会凭空改变首次事实。
	if (entry.dispatchRequested === undefined) delete duplicate.dispatchRequested;
	// 首次受理快照：下游工具面要如实显示「这就是第一次那条」，不必再查一遍账。
	duplicate.duplicateOf = outcomeFor(request, "accepted", entry.acceptedAt, {
		cardNo: entry.cardNo,
		cardPath: entry.cardPath,
		...(entry.dispatchRequested !== undefined ? { dispatchRequested: entry.dispatchRequested } : {}),
		...(entry.dispatched !== undefined ? { dispatched: entry.dispatched } : {}),
		...(entry.attempt !== undefined ? { attempt: entry.attempt } : {}),
		...(entry.instance !== undefined ? { instance: entry.instance } : {}),
		...(entry.node !== undefined ? { node: entry.node } : {}),
		...(entry.round !== undefined ? { round: entry.round } : {}),
	});
	if (entry.dispatchRequested === undefined) delete duplicate.duplicateOf.dispatchRequested;
	return duplicate;
}

function safeReadCard(path: string): ParsedCard | undefined {
	try {
		return readCard(path);
	} catch {
		return undefined;
	}
}

/**
 * 受理单条请求（内部）。任何失败都收敛成 outcome，不抛——批量受理靠这个保证单条不拖垮其它条。
 * 顺序：形状 → 占位（幂等）→ 集中预检 → 建卡 → 转正 → 派发；建卡前失败撤占位，建卡后保留身份。
 */
async function acceptOne(
	cardsDir: string,
	request: IntakeRequest,
	options: IntakeOptions,
	context: { projectRoot: string; paoHome: string },
	clock: () => Date,
): Promise<IntakeOutcome> {
	const time = nowString(clock());
	const ledger = intakeLedgerPath(cardsDir);

	// ① 请求形状
	let task: TaskBook | undefined;
	try {
		task = normalizeRequestTask(request);
	} catch (error) {
		const reason = `结构化任务 task 无效：${(error as Error).message}`;
		return outcomeFor(request, "rejected", time, {
			reason,
			problems: [problem(BLOCKING_LEVEL, "请求形状", reason, "补齐任务书后重新提交；不猜、不填默认值")],
		});
	}
	const shape = requestShapeProblems(request, task);
	if (shape.length > 0) {
		return outcomeFor(request, "rejected", time, {
			reason: shape.join("；"),
			problems: shape.map((reason) =>
				problem(BLOCKING_LEVEL, "请求形状", reason, "补齐请求字段后重新提交；不猜、不填默认值"),
			),
		});
	}
	const idempotencyKey = request.idempotencyKey.trim();

	// ② 幂等占位：同判据并发/重复提交时只有一个调用能进去建卡
	let reservation: Awaited<ReturnType<typeof reserveIntakeKey>>;
	try {
		reservation = await reserveIntakeKey(ledger, {
			idempotencyKey,
			pending: true,
			cardNo: "",
			cardPath: "",
			acceptedAt: time,
		});
	} catch (error) {
		return outcomeFor(request, "rejected", time, {
			dispatched: false,
			reason: `受理占位失败，未建卡、未派发：${intakeErrorText(error)}`,
		});
	}
	if (!reservation.reserved && reservation.existing) {
		const existing = reservation.existing;
		if (existing.pending === true) {
			// 占位未转正＝同判据正在受理中，或上次受理中断在半路（进程被杀）。
			// 如实报，不抢过来重复建卡（抢过来就可能建出两张卡）。
			return outcomeFor(request, "deferred", existing.acceptedAt, {
				reason:
					"该请求判据正在受理中或上次受理未完成（占位未转正）：不重复建卡；确认无在途受理后清理 .pao/intake/受理账.json 中该条占位再重试",
			});
		}
		return duplicateOutcome(request, existing);
	}

	let placeholderHeld = true;
	let createdCard: Pick<ParsedCard, "card_no" | "path"> | undefined;
	const releasePlaceholder = async (): Promise<PreflightItem[]> => {
		if (!placeholderHeld || createdCard) return [];
		try {
			const dropped = await dropIntakeKey(ledger, idempotencyKey);
			placeholderHeld = false;
			if (dropped) return [];
			return [problem("警告", "受理占位", "占位未撤回：条目已不存在或已经转正", "核查受理账，不要据此重复建卡")];
		} catch (error) {
			return [
				problem("警告", "受理占位", `占位撤回失败：${intakeErrorText(error)}`, "核查受理账与在途受理后再处理占位"),
			];
		}
	};

	try {
		// ③ 集中预检（一次调用，复用 checkPreflight，不另写检查）
		const preflight = checkPreflight(
			{
				project: context.projectRoot,
				paoHome: context.paoHome,
				departments: [request.dept],
				...(request.tier !== undefined ? { tier: request.tier } : {}),
				...(request.budget !== undefined ? { budget: request.budget } : {}),
			},
			process.env,
		);
		const blocking = blockingProblems(preflight);
		if (blocking.length > 0) {
			const cleanupProblems = await releasePlaceholder();
			return outcomeFor(request, "rejected", time, {
				reason: blocking.map(problemText).join("；"),
				problems: [...blocking, ...cleanupProblems],
			});
		}
		const problems = nonBlockingProblems(preflight);

		// ④ 建卡（复用 createCard：同一发号器、同一原子写、同一状态机缺省）
		let card: ParsedCard;
		try {
			card = await createCardForRequest(cardsDir, request, task, options, time);
			createdCard = card;
		} catch (error) {
			if (error instanceof CardCreationReadError) {
				createdCard = { card_no: error.cardNo, path: error.cardPath };
				return outcomeFor(request, "rejected", time, {
					cardNo: intakeCardNo(error.cardNo),
					cardPath: error.cardPath,
					dispatched: false,
					reason: `${intakeErrorText(error)}；保留受理占位，核查已有卡后再恢复，不能重复建卡`,
					problems,
				});
			}
			const cleanupProblems = await releasePlaceholder();
			return outcomeFor(request, "rejected", time, {
				reason: `建卡失败：${intakeErrorText(error)}`,
				problems: [...problems, ...cleanupProblems],
			});
		}
		const cardNo = intakeCardNo(card.card_no);

		// ⑤ 占位转正：把判据绑定到真实卡号。转正失败＝卡已建但幂等不可靠，如实报（不假装受理）。
		try {
			const committed = await commitIntakeEntry(ledger, idempotencyKey, {
				cardNo,
				cardPath: card.path,
				acceptedAt: time,
				dispatchRequested: request.dispatch,
				// dispatch=true 时后台 hook 尚未调用，结果未知；只有确定未派或提交成功后才写布尔值。
				...(request.dispatch ? {} : { dispatched: false }),
			});
			if (!committed)
				return outcomeFor(request, "rejected", time, {
					cardNo,
					cardPath: card.path,
					dispatched: false,
					reason: `已建卡${cardNo}（${card.path}），但受理账里找不到该判据的占位条目，无法保证幂等——请人工核查 .pao/intake/受理账.json`,
					problems,
				});
			placeholderHeld = false;
		} catch (error) {
			return outcomeFor(request, "rejected", time, {
				cardNo,
				cardPath: card.path,
				dispatched: false,
				reason: `已建卡${cardNo}（${card.path}），但受理账写入失败，无法保证幂等：${intakeErrorText(error)}`,
				problems,
			});
		}

		// ⑥ 派发（可选，经注入通道）
		if (!request.dispatch) {
			return outcomeFor(request, "accepted", time, {
				cardNo,
				cardPath: card.path,
				dispatched: false,
				problems,
			});
		}
		const dispatched = await dispatchAcceptedCard(cardsDir, request, options, cardNo, time);
		if (!dispatched.ok) {
			const ledgerProblem = await recordDispatchState(ledger, idempotencyKey, false);
			return outcomeFor(request, dispatched.status, time, {
				cardNo,
				cardPath: card.path,
				dispatched: false,
				reason: dispatched.reason,
				problems: ledgerProblem ? [...problems, ledgerProblem] : problems,
			});
		}
		// 尝试号：派发是后台链，认领在后台发生——此刻卡面 attempt 仍为 0（未真实启动）。
		// 如实留 undefined，不让调用方以为已经跑起来；真值以卡面/派卡通知为准。
		const running = safeReadCard(card.path);
		const attempt = running && running.frontmatter.attempt > 0 ? running.frontmatter.attempt : undefined;
		// 认领可能已完成（快路径）：把尝试号补进账，duplicate 回填时能给出真实身份。
		const ledgerProblem = await recordDispatchState(ledger, idempotencyKey, true, attempt);
		return outcomeFor(request, "accepted", time, {
			cardNo,
			cardPath: card.path,
			dispatched: true,
			...(attempt !== undefined ? { attempt } : {}),
			problems: ledgerProblem ? [...problems, ledgerProblem] : problems,
		});
	} catch (error) {
		const cleanupProblems = await releasePlaceholder();
		return outcomeFor(request, "rejected", time, {
			reason: `受理过程出错：${intakeErrorText(error)}`,
			...(createdCard
				? { cardNo: intakeCardNo(createdCard.card_no), cardPath: createdCard.path }
				: { dispatched: false }),
			problems: cleanupProblems,
		});
	}
}

/**
 * 唯一业务入口：受理一批请求（串行处理，单条失败不影响其它条）。
 *
 * 为什么串行：幂等判据的「先到者为准」只有在串行下才有确定含义；并发受理同一 key 还得多加一层
 * 无谓的锁竞争。批量的是请求条数，不是并发度——真并发派发由派发链自己的并发名额管。
 *
 * @param cardsDir 任务工作区卡目录（内含 `卡NNNN-*.md`）
 * @param requests 受理请求，按给定顺序串行处理
 * @param options  宿主装配（paoHome 必填；dispatch=true 时须给 dispatchInBackground）
 */
export async function acceptIntake(
	cardsDir: string,
	requests: readonly IntakeRequest[],
	options: IntakeOptions,
): Promise<IntakeReport> {
	const clock = options.now ?? (() => new Date());
	const context = normalizeOptions(cardsDir, options);
	const outcomes: IntakeOutcome[] = [];
	for (const request of requests) {
		// 选项不可用 → 整批逐条如实拒绝（一条请求一个 outcome，不许静默丢条）
		if (typeof context === "string") {
			outcomes.push(outcomeFor(request, "rejected", nowString(clock()), { reason: context }));
			continue;
		}
		if (options.signal?.aborted) {
			outcomes.push(
				outcomeFor(request, "rejected", nowString(clock()), {
					reason: "受理前已取消（取消信号已触发）：未建卡、未派发",
				}),
			);
			continue;
		}
		outcomes.push(await acceptOne(cardsDir, request, options, context, clock));
	}
	const counts = emptyCounts();
	for (const outcome of outcomes) counts[outcome.status] += 1;
	return {
		outcomes,
		counts,
		// 「部分成功」＝有的受理了、有的没受理；全失败不算部分（调用方据此决定怎么提示）
		partial: counts.accepted + counts.duplicate + counts.deferred > 0 && counts.rejected > 0,
		at: utcNow(clock()),
	};
}

/**
 * 受理结果是否已失效（计划 §5.4「停止后不得再用旧回执判成功」）。
 *
 * 背景：受理返回的是**当时**的身份快照。之后用户可能停卡（取消）、或者卡被重开进入了新的尝试
 * （`attempt` 变大）。这时再拿旧 outcome 当「成功受理/正在跑」就是假话——调度面板必须据此降级显示。
 *
 * 判据（全部基于磁盘真实状态，不看内存快照）：
 * - 卡文件已不存在 → 失效；
 * - 卡状态是终结态（delivered/failed/canceled）→ 失效（本次受理的那段已经结束了，
 *   尤其 canceled＝用户停止，绝不能再说成功）；
 * - outcome 记了尝试号，而卡面尝试号已不同（重派开了新尝试）→ 失效；
 * - 其余情况（卡还在 unclaimed/in_progress 且尝试号对得上）→ 未失效。
 *
 * @returns true＝旧结果不可再当成功/在跑；false＝仍有效。查不到卡时按失效处理（查不到就不许说成功）。
 */
export function isIntakeOutcomeStale(outcome: IntakeOutcome, cardsDir: string): boolean {
	if (!outcome.cardNo && !outcome.cardPath) return true;
	let card: ParsedCard | undefined;
	if (outcome.cardPath) card = safeReadCard(outcome.cardPath);
	if (!card && outcome.cardNo) {
		try {
			card = locateDispatchCard(cardsDir, outcome.cardNo);
		} catch {
			card = undefined;
		}
	}
	if (!card) return true;
	const status = card.frontmatter.status;
	if (status === "delivered" || status === "failed" || status === "canceled") return true;
	if (outcome.attempt !== undefined && card.frontmatter.attempt !== outcome.attempt) return true;
	return false;
}
