/**
 * 工作流自动执行链（M2-06 第一段：单卡全链＋串行；架构 §11–§14）。
 * 在驱动器落卡之上串联：受保护派发（复用 executeDispatch——认领/基线/预算/名额/写锁/
 * 巡库护栏注入全部随链生效，不造第二派发器）→ 有效回执 → 越界核查（checkBoundaryWrite）
 * → 机械验收（verifyCard；全机械全过自动落已交付）→ 交卷（deliverCard）→ 再 tick 解锁下游。
 *
 * 触发面：配方 frontmatter `自动执行: true` 时 启流首 tick / 推流 / 确认流点头 走本模块；
 * 缺省不开启时行为与手动链逐字节一致。无定时器无轮询（R05 保持）：S6 起链体由 tools.ts 的
 * 后台受理面（pao_dispatch_card 模式）在宿主内 fire-and-forget 驱动——受理与快照在工具调用的同步等待里，
 * 回执后的越界→验收→交卷→解锁下游在同一后台链内事件驱动收敛；owner/暂停/轮次在链内锁后重核，
 * 取消不接工具 signal（树杀承担）。maxCards 在本入口与实例累计余量合并（S6-K2）：限额总量按实例
 * 计（启动到终局），已派卡累计落实例正本（v1 manifest / v2 FlowControl「已派卡」）不按调用重置。
 *
 * 失败语义（诚实优先）：
 * - 回执失败/回执落卡失败 → 卡落「失败」（机械证据：classifyWorkerFailure 分型，落卡失败=结果未知），
 *   绝不伪造成功；驱动器既有「失败即停」挂起下游。
 * - 越界/虚报（git 真值与声明对不上）→ 卡落「失败」（结果未知：改动不可信）。
 * - 越界无法核对（基线不可用等环境问题）→ 不落失败、链停，卡留 owner 裁决。
 * - 验收未过/无法机械判/混人话句 → 不落失败不交卷，链停给主控（§12 交付规则原样）。
 * - 人工门节点：交付与交卷照常，下游等 确认流 点头（门是流程闸不是交付闸）。
 */
import { baselineSnapshotPath, checkBoundaryWrite, diffAgainstBaseline } from "../cards/baseline.ts";
import { deliverCard } from "../cards/delivery.ts";
import { changeCardStatus, parseCardRef } from "../cards/index.ts";
import { verifyCard } from "../cards/verifier.ts";
import { withFileLock } from "../shared/lock.ts";
import { nowString } from "../shared/time.ts";
import { glyphFor } from "../ui/glyphs.ts";
import { buildDispatchBudgetGate } from "../usage/dispatch-gate.ts";
import {
	appendDispatchReceipt,
	checkDispatchPermission,
	classifyWorkerFailure,
	executeDispatch,
	locateDispatchCard,
} from "../worker/dispatch-core.ts";
import type { WorkerReceipt } from "../worker/receipt.ts";
import type { WorkerRunner } from "../worker/runner.ts";
import { bumpControlDispatched, controlPath, controlReport, readControl } from "./control.ts";
import { resolveWorkflowDispatch } from "./dispatch-context.ts";
import {
	bumpManifestDispatched,
	type DriveReport,
	type DriverOptions,
	readAutoChainDispatched,
	refundManifestDispatched,
	renderReport,
	tickWorkflow,
} from "./driver.ts";
import type { RecipeNode, WorkflowRecipe } from "./recipe.ts";

/**
 * v2 卡的派发增量（模型/思考档来源与名额等待）。版本判断集中在 runAutoChain 入口的
 * 解释器分流：v2 解释器用自己的控制正本算好本对象再传下去，runChainForCard 不再自查
 * recipe.版本——v1/v2 各自解释控制语义，共用同一个受保护派发（executeDispatch）。
 * 旧实例（控制正本版本缺失或未知）在 readControl 处明确拒绝自动恢复并保留原件。
 */
interface V2CardDispatch {
	/** 冻结配方里的节点定义（模型/思考档按它代参；每批派发前轮次一致性已重核） */
	nodeDefinition: RecipeNode;
	/** 当前轮次（重做两次后升主力模型的判据） */
	round: number;
}

export interface AutoChainOptions extends DriverOptions {
	driveDepartments?: (recipe: WorkflowRecipe, options: AutoChainOptions) => Promise<AutoChainReport>;
	/** 派发运行器（与 pao_dispatch_card 同一注册表面） */
	运行器: WorkerRunner;
	paoHome?: string;
	/** 验收与状态变更的操作者身份（单写者口径；权限经 checkDispatchPermission 解出） */
	操作者?: string;
	/** 影子沙箱根（验收「跑:」句式用；缺省系统临时目录） */
	沙箱根?: string;
	/** 单条跑命令超时毫秒 */
	命令超时毫秒?: number;
	/**
	 * 单次自动推进的卡数上限，与实例余量取较严者（S6-K2；配方配错防失控长跑）。
	 * 实例总量缺省 50（AUTO_CHAIN_CARD_LIMIT），显式更大的 maxCards 可临时抬基数——
	 * 超过缺省须每次显式授权，不给后台链留无限额度。
	 */
	maxCards?: number;
}

/** 自动链卡数上限缺省（单次调用与实例总量共用基数，防配方失控长跑）。 */
export const AUTO_CHAIN_CARD_LIMIT = 50;

/**
 * S6-K2 限额合并规则（v1/v2 同一式）：本次生效上限＝min(本次 options, 实例余量)，
 * 实例余量＝max(0, max(缺省 50, 本次 options) − 实例已派累计)。返回
 * { cap, remaining, perCall }——remaining<=perCall 即实例余量是较严者（停因按实例口径报）。
 */
function mergeCardLimit(maxCards: number | undefined, used: number) {
	const perCall = maxCards ?? AUTO_CHAIN_CARD_LIMIT;
	const remaining = Math.max(0, Math.max(AUTO_CHAIN_CARD_LIMIT, perCall) - used);
	return { cap: Math.min(perCall, remaining), remaining, perCall };
}

/** 实例余量先耗尽的停因（两版共用口径；测试断言认「实例累计」「卡数上限」字样）。 */
function instanceLimitStopReason(perCall: number, totalDispatched: number): string {
	return `实例累计已达自动链卡数上限 ${Math.max(AUTO_CHAIN_CARD_LIMIT, perCall)}（防配方失控长跑；实例已派 ${totalDispatched} 张），继续推进须显式传更大上限或人工复核`;
}

/** 卡数上限停下的原因：实例余量是较严者时按实例口径报，否则按本次上限报（两处逐卡检查共用措辞）。 */
function cardLimitStopReason(
	limit: { cap: number; remaining: number; perCall: number },
	totalDispatched: number,
): string {
	return limit.remaining <= limit.perCall
		? instanceLimitStopReason(limit.perCall, totalDispatched)
		: `单次自动推进已达卡数上限 ${limit.perCall}（防配方失控长跑），剩余节点下次推流续跑`;
}

/** 链步阶段（值是面向主控的中文显示口径,随 renderAutoChain 输出,勿改值） */
export type ChainStage = "派发" | "回执" | "越界" | "验收" | "交卷" | "完成" | "失败" | "停审";

export interface ChainStep {
	node: string;
	cardRef: string;
	stage: ChainStage;
	note: string;
}

export interface AutoChainReport {
	/** 循环结束时最后一次驱动 tick 的报告（节点/状态/挂起原因以它为准） */
	report: DriveReport;
	/** 本次自动推进的逐步机械记录 */
	steps: ChainStep[];
	/** 链停下的原因（undefined＝自然跑完） */
	stopReason?: string;
}

/** 单次自动推进：tick → 对就绪卡逐张跑链 → 交付后再 tick 解锁下游，直到无进展或停。 */
export async function runAutoChain(
	recipe: WorkflowRecipe,
	options: AutoChainOptions,
	firstReport?: DriveReport,
): Promise<AutoChainReport> {
	if (recipe.版本 === 2) {
		return withFileLock(`${controlPath(recipe, options)}.dispatch`, async () => {
			const steps: ChainStep[] = [];
			const flow = readControl(recipe, options);
			if (flow.owner !== options.ownerSessionId) throw new Error("工作流 owner 不匹配");
			if (flow.暂停) return { report: controlReport(flow), steps, stopReason: flow.暂停 };
			// S6-K2 实例级累计：累计读控制正本「已派卡」，本次上限与实例余量取较严者
			// （mergeCardLimit）；每批派卡随记（bumpControlDispatched 走主锁并重核 owner）。
			const limit = mergeCardLimit(options.maxCards, flow.已派卡 ?? 0);
			let count = 0;
			for (const node of flow.节点) {
				const def = flow.冻结配方.节点.find((n) => n.名字 === node.名字)!;
				// 每批重读轮次与卡状态，不跨批缓存；派发前最终核验仍在 executeDispatch。
				for (;;) {
					options.signal?.throwIfAborted();
					const fresh = readControl(recipe, options);
					if (fresh.暂停 || fresh.节点.find((n) => n.名字 === node.名字)?.轮次 !== node.轮次)
						return { report: controlReport(fresh), steps, stopReason: "实例暂停或轮次已改变" };
					const cards = node.卡.map((ref) => ({
						ref,
						status: locateDispatchCard(options.cardsDir, ref).frontmatter.status,
					}));
					const waiting = cards.filter((card) => card.status === "unclaimed").map((card) => card.ref);
					if (!waiting.length) break;
					const slots = Math.max(
						0,
						(def.工人数量 ?? 1) - cards.filter((card) => card.status === "in_progress").length,
					);
					if (!slots) break;
					const batch = waiting.slice(0, slots).slice(0, Math.max(0, limit.cap - count));
					if (!batch.length)
						return {
							report: controlReport(fresh),
							steps,
							stopReason:
								limit.remaining <= limit.perCall
									? instanceLimitStopReason(limit.perCall, (flow.已派卡 ?? 0) + count)
									: "本次卡数上限；未派卡保留排队",
						};
					count += batch.length;
					// 先记账后派发：进程中断也不丢已认领卡数的账（已派＝已认领进链）。
					await bumpControlDispatched(recipe, options, batch.length);
					// 每张卡独立收集过程，全部结算后按输入卡序汇总，避免并行完成先后打乱报告。
					const batchSteps = batch.map((): ChainStep[] => []);
					// 审查第 11 项：确定未获受理的卡（权限拒绝/名额或状态不放行）把预留额度还回来——
					// 预留本身要保留（并发上限靠它），只在确定没派出去时归还。已受理后失败不当未运行退账。
					const onUnaccepted = async (): Promise<void> => {
						await bumpControlDispatched(recipe, options, -1);
					};
					const settled = await Promise.allSettled(
						batch.map((ref, index) =>
							runChainForCard(
								flow.冻结配方,
								node.名字,
								ref,
								options,
								batchSteps[index],
								{
									nodeDefinition: def,
									round: node.轮次,
								},
								onUnaccepted,
							),
						),
					);
					steps.push(...batchSteps.flat());
					const rejected = settled.find((result) => result.status === "rejected");
					if (rejected?.status === "rejected") throw rejected.reason;
					const outcomes = settled.map((result) => (result.status === "fulfilled" ? result.value : undefined));
					const stopped = outcomes.find((outcome) => outcome !== undefined);
					if (stopped) {
						// 在命令返回前，把同一份由卡面推导的状态持久化并返回给调用方；
						// 这轮刷新不追加全局暂停，也不改动无关节点与轮次。
						return { report: await tickWorkflow(recipe, options), steps, stopReason: stopped };
					}
				}
			}
			const report = await tickWorkflow(recipe, options);
			return {
				report,
				steps,
				stopReason: report.status === "completed" ? undefined : "等待部长拆卡、结束信号或节点判定",
			};
		});
	}
	const steps: ChainStep[] = [];
	const processed = new Set<string>();
	// S6-K2 实例级累计：累计读实例清单「已派卡」，本次上限与实例余量取较严者（mergeCardLimit）；
	// 每张卡进链即记账（bumpManifestDispatched）——审查第 10 项：cap 改成逐卡核对，批内不再越限。
	const limit = mergeCardLimit(options.maxCards, readAutoChainDispatched(recipe, options));
	let stopReason: string | undefined;
	let report = firstReport ?? (await tickWorkflow(recipe, options));

	for (;;) {
		options.signal?.throwIfAborted();
		const actionable = report.nodes.filter(
			(node) =>
				node.card_no !== undefined && node.status === "unclaimed" && !node.hold && !processed.has(node.card_no),
		);
		if (actionable.length === 0) break;
		if (processed.size >= limit.cap) {
			stopReason = cardLimitStopReason(limit, readAutoChainDispatched(recipe, options));
			break;
		}
		for (const node of actionable) {
			options.signal?.throwIfAborted();
			// 审查第 10 项：上限逐卡核对。批前只看一次会让「本批节点数 > 剩余额度」时整批放行，
			// 实际派卡越过 maxCards 与实例上限；未获额度的节点保持未派，下次推流续跑。
			if (processed.size >= limit.cap) {
				stopReason = cardLimitStopReason(limit, readAutoChainDispatched(recipe, options));
				break;
			}
			processed.add(node.card_no!);
			await bumpManifestDispatched(recipe, options);
			// 审查第 11 项：确定未获受理时归还这笔预留（同样只在「确定没派出去」时归还）。
			const outcome = await runChainForCard(recipe, node.name, node.card_no!, options, steps, undefined, () =>
				refundManifestDispatched(recipe, options),
			);
			if (outcome !== undefined) {
				stopReason = outcome;
				break;
			}
		}
		if (stopReason !== undefined) break;
		// 本批卡全部走完：再 tick——交付过的节点解锁下游、可能落新卡，循环继续
		report = await tickWorkflow(recipe, options);
	}
	if (stopReason !== undefined && !options.signal?.aborted) {
		// 中途停也要让实例清单反映真挂起原因（失败即停/人工门）：补一次只读性质的 tick
		report = await tickWorkflow(recipe, options);
	}
	if (stopReason === undefined && report.status !== "completed") {
		stopReason = deriveHoldNote(report);
	}
	return { report, steps, stopReason };
}

/** 无可动卡且未完成时，把「现在卡在哪」说人话（等人工门/等 owner/等前置）。 */
function deriveHoldNote(report: DriveReport): string | undefined {
	for (const node of report.nodes) {
		if (node.hold) return `节点「${node.name}」${node.hold}`;
	}
	for (const node of report.nodes) {
		if (node.status === "in_progress") {
			return `卡${node.card_no}（节点 ${node.name}）在进行中/待审，留 owner 处理后推流续跑`;
		}
	}
	return undefined;
}

/** 返回 undefined＝该卡走完全链可续跑；字符串＝链停原因（含失败与停审两类）。
 *  v2 派发增量（v2Dispatch）由 runAutoChain 的 v2 解释器算好传入；v1 不传＝v1 无节点级
 *  并发与模型代参，派发参数保持既有手动链口径。
 *  onUnaccepted（审查第 11 项）：本卡确定没被受理（权限拒绝或派发门不放行）时回调，
 *  调用方据此归还先前记的预留额度；已受理后失败不走这条路径（已运行就不退账）。 */
async function runChainForCard(
	recipe: WorkflowRecipe,
	nodeName: string,
	cardRef: string,
	options: AutoChainOptions,
	steps: ChainStep[],
	v2Dispatch?: V2CardDispatch,
	onUnaccepted?: () => Promise<void> | void,
): Promise<string | undefined> {
	const cardsDir = options.cardsDir;
	const cardNumber = parseCardRef(cardRef);
	const located = locateDispatchCard(cardsDir, cardRef);
	const permission = checkDispatchPermission({ 卡部门: located.frontmatter.dept, env: process.env });
	if (!permission.允许) {
		steps.push({ node: nodeName, cardRef, stage: "停审", note: `权限拒绝：${permission.原因}` });
		await onUnaccepted?.();
		return `卡${cardRef} 派发被拒：${permission.原因}，自动链停，留 owner 处理`;
	}
	const operator = options.操作者 ?? permission.操作者;
	const timestamp = options.now?.() ?? nowString(new Date());

	// ① 受保护派发（认领/基线/预算/名额/写锁全在 executeDispatch 链内;workflowCheck 由
	// workflow/dispatch-context 注入——自动链派卡同样过实例/轮次/owner/暂停/冻结版本的锁后重核）
	let chainReceipt: { receipt: WorkerReceipt; receiptWriteError?: string };
	try {
		const dispatched = await executeDispatch(
			{
				cardsDir,
				card_no: cardRef,
				operator,
				time: timestamp,
				dispatch_reason: `工作流自动链:${recipe.名字}/${nodeName}`,
			},
			{
				运行器: options.运行器,
				paoHome: options.paoHome,
				信号: options.signal,
				workflowCheck: (card) =>
					resolveWorkflowDispatch(card, {
						cardsDir,
						paoHome: options.paoHome,
						owner: options.ownerSessionId,
					}),
				...(v2Dispatch
					? {
							等待名额: true,
							公共参数: {
								...(v2Dispatch.nodeDefinition.模型 && v2Dispatch.round <= 3
									? { 模型: v2Dispatch.nodeDefinition.模型 }
									: {}),
								...(v2Dispatch.nodeDefinition.思考强度 ? { 思考档: v2Dispatch.nodeDefinition.思考强度 } : {}),
							},
						}
					: {}),
				// 总预算门禁（H0）:与单卡/扇出共用同一个工厂（usage/dispatch-gate 的
				// buildDispatchBudgetGate），判据与拒绝文案不可能分叉。没授权总预算时返回
				// undefined＝自动链行为与接线前逐字一致。不接这一处等于「自动链不重复授额」是空的：
				// 自动链是无人值守的连续派卡，最该受总额约束。
				预算门禁: buildDispatchBudgetGate({ paoHome: options.paoHome }),
			},
			async (claimed, receipt) => {
				let receiptWriteError: string | undefined;
				try {
					await appendDispatchReceipt(claimed.card, receipt);
				} catch (error) {
					receiptWriteError = error instanceof Error ? error.message : String(error);
				}
				return { receipt, receiptWriteError };
			},
		);
		if (!dispatched.可派) {
			steps.push({ node: nodeName, cardRef, stage: "停审", note: `派发被拒:${dispatched.原因}` });
			await onUnaccepted?.();
			// 原因原样带出（含门禁给的「下一步」），不在这里二次归纳成"并发上限/依赖/状态"——
			// 那种归纳会把预算拒绝说成别的原因，读者据此会走错方向。
			return `卡${cardRef}（节点 ${nodeName}）派发被拒：${dispatched.原因}；自动链停`;
		}
		steps.push({
			node: nodeName,
			cardRef,
			stage: "派发",
			note: `已派发（理由 工作流自动链:${recipe.名字}/${nodeName}）`,
		});
		chainReceipt = dispatched.result;
	} catch (error) {
		if (options.signal?.aborted) throw error;
		steps.push({ node: nodeName, cardRef, stage: "停审", note: `派发异常:${String(error)}` });
		return `卡${cardRef} 派发异常：${error instanceof Error ? error.message : String(error)}，自动链停`;
	}
	options.signal?.throwIfAborted();
	const { receipt, receiptWriteError } = chainReceipt;
	steps.push({
		node: nodeName,
		cardRef,
		stage: "回执",
		note: `worker 回执 ${receipt.status}${receiptWriteError ? `（回执落卡失败:${receiptWriteError}）` : ""}${
			receipt.派发告警?.length ? `；派发告警:${receipt.派发告警.join(";")}` : ""
		}`,
	});

	// ② 回执失败族 → 卡落失败（分型照 classifyWorkerFailure；落卡失败＝结果未知，不伪造）
	const receiptUnrecorded = receiptWriteError !== undefined;
	if (receipt.status !== "success" || receiptUnrecorded) {
		const failureType = receiptUnrecorded ? "unknown_outcome" : (classifyWorkerFailure(receipt) ?? "unknown_outcome");
		const basis = receiptUnrecorded
			? `回执落卡失败（${receiptWriteError}），按结果未知处理，证据仍在 ${receipt.evidence_path}`
			: `worker 回执 ${receipt.status}${receipt.failure_type ? `（${receipt.failure_type}）` : ""}，自动链如实落失败`;
		await failCard(cardsDir, cardRef, operator, failureType, basis, steps, nodeName);
		return `卡${cardRef}（节点 ${nodeName}）回执${receiptUnrecorded ? "无效" : "失败"}，已落失败态，下游按「失败即停」挂起`;
	}

	// ③ 越界核查（git 真值 vs 回执声明）
	const diff = await diffAgainstBaseline(baselineSnapshotPath(cardsDir, cardNumber), options.signal);
	options.signal?.throwIfAborted();
	const check = checkBoundaryWrite(diff, receipt.artifact_path ?? [], { 项目根: diff.项目根 });
	steps.push({ node: nodeName, cardRef, stage: "越界", note: check.汇总 });
	if (check.结论 === "虚报" || check.结论 === "越界" || check.结论 === "虚报+越界") {
		await failCard(
			cardsDir,
			cardRef,
			operator,
			"unknown_outcome",
			`越界核查 ${check.结论}：${check.汇总}（改动与声明对不上，结果不可信）`,
			steps,
			nodeName,
		);
		return `卡${cardRef}（节点 ${nodeName}）越界核查 ${check.结论}，已落失败态，下游挂起`;
	}
	if (check.结论 === "无法核对") {
		steps.push({
			node: nodeName,
			cardRef,
			stage: "停审",
			note: `越界核查无法核对（${check.原因 ?? diff.汇总}），不自动定罪，留 owner`,
		});
		return `卡${cardRef}（节点 ${nodeName}）越界核查无法核对（${check.原因 ?? diff.汇总}），链停留 owner 裁决`;
	}

	// ④ 机械验收（全机械全过 → verifyCard 内自动落已交付）
	const { result: verification } = await verifyCard(cardsDir, cardNumber, {
		operator,
		sandbox_root: options.沙箱根,
		命令超时毫秒: options.命令超时毫秒,
		signal: options.signal,
	});
	options.signal?.throwIfAborted();
	steps.push({ node: nodeName, cardRef, stage: "验收", note: `${verification.结论}（${verification.汇总}）` });
	if (verification.结论 !== "全过自动交付") {
		return `卡${cardRef}（节点 ${nodeName}）验收结论「${verification.结论}」，不自动交付，留 owner 处理后推流续跑`;
	}

	// ⑤ 交卷（幂等：无文件产物的回答型任务不空提交也算走完）
	const delivery = await deliverCard(cardsDir, cardNumber, { signal: options.signal });
	steps.push({
		node: nodeName,
		cardRef,
		stage: delivery.交卷 || !delivery.原因 ? "完成" : "停审",
		note: delivery.消息,
	});
	if (!delivery.交卷 && delivery.原因) {
		return `卡${cardRef}（节点 ${nodeName}）已交付但交卷失败（${delivery.原因}），提交留 owner 手工接手`;
	}
	return undefined;
}

async function failCard(
	cardsDir: string,
	cardRef: string,
	operator: string,
	failureType: "transient" | "missing_input" | "insufficient_capability" | "unknown_outcome",
	basis: string,
	steps: ChainStep[],
	nodeName: string,
): Promise<void> {
	const fresh = locateDispatchCard(cardsDir, cardRef);
	changeCardStatus(fresh, {
		操作者: operator,
		to: "failed",
		失败类型: failureType,
		依据: basis,
		时间: nowString(new Date()),
	});
	steps.push({ node: nodeName, cardRef, stage: "失败", note: `${failureType}:${basis}` });
}

/** 自动链结果 → 面向主控的中文文本（驱动器报告＋逐步记录＋停因；二批逐步行加状态符号前缀）。 */
export function renderAutoChain(chain: AutoChainReport): string {
	const lines = [renderReport(chain.report)];
	if (chain.steps.length > 0) {
		lines.push("自动链逐步：");
		for (const step of chain.steps) {
			const glyph = glyphFor(step.stage);
			lines.push(`-${glyph ? ` ${glyph}` : ""} ${step.node}/卡${step.cardRef}〔${step.stage}〕${step.note}`);
		}
	}
	if (chain.stopReason) lines.push(`自动链停因：${chain.stopReason}`);
	return lines.join("\n");
}
