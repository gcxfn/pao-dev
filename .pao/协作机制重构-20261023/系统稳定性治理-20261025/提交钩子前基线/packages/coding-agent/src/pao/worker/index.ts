/**
 * PAO worker 注册入口(headless worker 工具面;架构 §1 后台运行契约 / R05)。
 *
 * T04 拆分后本文件只保留:四个工具(pao_inventory/pao_stop_background/pao_dispatch_card/pao_terminate_card)的构建
 * 与 registerWorkerTools 装配;进程生命周期在 lifecycle.ts,静默扫描在 silence.ts,
 * 后台派卡通知面在 notify.ts,停止原语在 runner.ts/kill.ts——本文件不另建停止机制。
 * 注册面:主控/部长共用(worker 角色在 role.ts WORKER_SKIPPED_MODULES 整模块跳过)——
 * pao_dispatch_card 与 pao_fanout(主控专属)不同,部长也须能派本部门卡(单卡派发,配额与权限见 dispatch-core)。
 *
 * ── 工具面全景(计划 §5.2;旧入口名字与行为是兼容契约,一律不改) ────────────────────
 * | 工具 | 是什么 | 与新入口 pao_accept_task 的关系 |
 * |---|---|---|
 * | `pao_accept_task` | 完整任务受理:预检→建卡→可选派发,一次调用给身份或真实拒绝原因 | 新入口本身(业务全在 intake/) |
 * | `pao_build_card` | 建卡(cards/tools.ts) | 新入口的第 2 步:同一个 createCard、同一个发号器 |
 * | `pao_dispatch_card` | 单卡派发(非阻塞) | 新入口的第 3 步:同一个 dispatchInBackground/executeDispatch |
 * | `pao_inventory` | 只读盘点 | 不在受理链内:受理只回身份,查询仍归它 |
 * | `pao_terminate_card` | 终止运行中 worker | 不在受理链内:停完旧受理结果即失效(§5.4) |
 * | `pao_stop_background` | 停本轮全部后台进程 | 同上,收尾用 |
 */

import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import { type Static, Type } from "typebox";

import type { ExtensionAPI, ToolDefinition } from "../../core/extensions/types.ts";
import { loadCardBodyTemplate, resolveCardTemplatePath } from "../cards/cardfile.ts";
import {
	CARD_PRIORITIES,
	CARD_TIERS,
	type CardBudget,
	type CardPriority,
	type CardTier,
	parseCardRef,
	readCard,
	routeFailure,
} from "../cards/index.ts";
import { DEFAULT_WORKER_SILENCE_MINUTES, readWorkerSilenceMinutes } from "../host/config.ts";
import {
	defaultMinisterHost,
	globalHotSessionLimit,
	type MinisterHost,
	renderMinisterInventoryLine,
} from "../host/index.ts";
import {
	acceptIntake,
	type IntakeOutcome,
	type IntakeRequest,
	type IntakeTemplateBody,
	isIntakeOutcomeStale,
	legacyTaskFields,
	normalizeTaskBook,
	type TaskBook,
	TaskBookSchema,
	taskBookFields,
} from "../intake/index.ts";
import { resolvePaoRole } from "../role.ts";
import { logWarn } from "../shared/log.ts";
import { nowString } from "../shared/time.ts";
import { buildDispatchBudgetGate } from "../usage/dispatch-gate.ts";
import { resolveWorkflowDispatch } from "../workflow/dispatch-context.ts";
import { createSingleRootWorktreeHost, type PaoWorktreeHost, type WorktreeTarget } from "../worktrees/types.ts";
import {
	appendDispatchReceipt,
	checkDispatchPermission,
	claimRefusalDetail,
	classifyWorkerFailure,
	DEFAULT_DEPT_CONCURRENCY,
	DEPT_CONCURRENCY_CONFIG_RELATIVE_PATH,
	type DispatchBaseline,
	type DispatchClaimInput,
	type DispatchPermission,
	executeDispatch,
	locateDispatchCard,
	OWNER_DISPATCH_DISCIPLINES,
	projectRootForCards,
	sameCardPath,
	taskStateRoutingLine,
} from "./dispatch-core.ts";

export { killTree } from "../../utils/kill-tree.ts";
export * from "./budget.ts";
export * from "./dispatch-core.ts";
export * from "./errors.ts";
export * from "./inventory.ts";
export * from "./lifecycle.ts";
export * from "./lock.ts";
export * from "./notify.ts";
export * from "./receipt.ts";
export * from "./registry.ts";
export * from "./runner.ts";
export * from "./silence.ts";
export * from "./supervision.ts";
export * from "./usage.ts";
export * from "./usage-display.ts";

import { PaoWorkerError } from "./errors.ts";
import { InventoryPathError, type InventoryReport, inventory } from "./inventory.ts";
import { defaultWorkerRunner, installExitHooks } from "./lifecycle.ts";
import {
	createDispatchNotifySurface,
	type DispatchNotifyEvent,
	type DispatchNotifySurface,
	sendDispatchNotifyWakeup,
} from "./notify.ts";
import { completeDispatchedTask } from "./post-dispatch.ts";
import type { WorkerReceipt, WorkerUsage } from "./receipt.ts";
import type { ProcessEntry } from "./registry.ts";
import type { StopProof, WorkerRunner, WorkerRunOptions } from "./runner.ts";
import { createSilenceReminder } from "./silence.ts";
import { createWorkerSupervisionRouteResolver, type WorkerSupervisionRoute } from "./supervision.ts";

// ── pao_dispatch_card:单卡派发(2026-10-02 定案;B 档 2026-10-03 非阻塞化) ─────────────

/** 在途后台派卡的会话级登记(pao_terminate_card 等链收敛、后台计数共用;进程态真相仍以 runner 登记表为准) */
interface InFlightDispatch {
	cardNo: string;
	/** 整条派发链(executeDispatch:认领→运行→回执落卡→finally 放锁/名额)收敛的 promise;永不 reject */
	done: Promise<void>;
}

/** 工具回执的最小形状(结构上兼容 AgentToolResult<unknown>;details 用 unknown 免接口索引签名摩擦) */
interface DispatchToolReply {
	content: { type: "text"; text: string }[];
	details: unknown;
	isError?: boolean;
}

function toolError(text: string): DispatchToolReply {
	return { content: [{ type: "text", text }], details: {}, isError: true };
}

interface DispatchOutcome {
	cardNo: string;
	finalState: string;
	/** 回执自报任务态；用于把 blocked/checkpoint 立即投成待裁决。 */
	taskState?: WorkerReceipt["任务态"];
	dept: string | null;
	reason: string;
	operator: string;
	attempt?: number;
	summary?: string;
	evidencePath?: string;
	claimBaseline?: DispatchBaseline;
	receiptLanding?: string;
	receiptNote?: string;
	durationMs?: number;
}

/** 派单结果 → 用户可见文本(终态/理由/owner/摘要/基线,一行一事) */
export function formatDispatchResult(outcome: DispatchOutcome, receipt: WorkerReceipt): string {
	const lines = [
		`派单完成:卡${outcome.cardNo}〔${outcome.finalState}〕${outcome.attempt !== undefined ? `尝试 ${outcome.attempt}` : ""}(部门 ${outcome.dept ?? "无"})`,
		`派单理由:${outcome.reason}`,
		`owner:${outcome.operator}(认领走状态机:无主卡由派单者认领,有主卡须 owner 本人)`,
	];
	const failureType = classifyWorkerFailure(receipt);
	if (failureType) {
		const route = routeFailure(failureType);
		lines.push(`失败类型:${failureType} → ${route.建议动作}(${route.说明})`);
		if (failureType === "unknown_outcome") {
			lines.push(
				"成果待owner复核:本次没有可采信的完成回执,可能已改项目,不能自动判成功;先按证据查现场,再由 owner 通过 pao_change_status 填写 basis 走既有完成入口。",
			);
		}
	}
	// S5 包4 四写法②：任务态标签路由——标签→处理动作对照,办完即停不忙等
	if (receipt.任务态) lines.push(taskStateRoutingLine(receipt.任务态));
	// S5 包2 派发告警:工具表外名截严/仓内技能未确认被忽略等——忽略不等于静默,须点名
	if (receipt.派发告警?.length) lines.push(`派发告警:${receipt.派发告警.join(";")}`);
	if (outcome.summary) lines.push(`摘要:${outcome.summary.split("\n")[0]}`);
	if (outcome.evidencePath) lines.push(`证据:${outcome.evidencePath}`);
	if (outcome.claimBaseline) {
		lines.push(
			outcome.claimBaseline.available
				? `认领基线:快照已落 ${outcome.claimBaseline.snapshotPath}(既有 ${outcome.claimBaseline.existingEntryCount} 条不计 worker 的账)`
				: `认领基线:不可用——${outcome.claimBaseline.reason ?? "原因未记"}(越界比对无基线,边界如实标注)`,
		);
	}
	if (outcome.receiptNote) lines.push(outcome.receiptNote);
	return lines.join("\n");
}

// 总预算门禁的判据/工厂/下一步文案/结算四个东西已搬到 usage/dispatch-gate.ts（H0）：
// fanout 与 workflow/auto 两条路径要共用同一个工厂，而它们对 worker/index.ts 已有依赖方向，
// 反向 import 会成环。搬动是零逻辑变更，判据与文案仍只有一份（见下方 import 处）。

const DispatchParams = Type.Object({
	card_ref: Type.String({ description: "card_ref(卡0017/卡#17/17 均可)" }),
	reason: Type.String({
		description:
			"派单理由(必填,trim 后不得为空;派前自省:真的需要额外多派一个吗)。理由会留痕:进程登记表记录与工具回执都带此理由,供上级审查。",
	}),
	cards_dir: Type.Optional(
		Type.String({ description: "cards_dir:任务工作区卡目录(内含 卡NNNN-*.md);已配置默认卡目录时可省略" }),
	),
	worktree_id: Type.Optional(
		Type.String({
			minLength: 1,
			description:
				"本次派发使用的宿主已登记工作树 ID（由 pao_worktree_create 或 pao_worktree_list 获取），不接受任意执行路径；省略沿用宿主默认目标（通常为 primary 主目录）。无有效宿主或 ID 校验失败时拒派，不降级到主目录。",
		}),
	),
	接管: Type.Optional(
		Type.Boolean({
			description:
				"孤儿显式接管(缺省 false):仅对 进行中＋当前尝试无回执＋登记表无活进程 的卡生效——推进认领代数并把卡落失败重开新尝试(旧 worker 状态不再覆盖)。当前尝试已有回执(同号去重,按回执处理)或仍有活进程(先 pao_terminate_card)时一律拒;非进行中卡此参数无效。",
		}),
	),
});

type DispatchParamsShape = Static<typeof DispatchParams>;

/** 非阻塞派单的后台执行口(registerWorkerTools 闭包提供:写通知缓冲/在途登记/发 toast)。
 *  ownerSession:调用方会话 id（工具上下文 sessionManager.getSessionId;直调无上下文时缺省不传),
 *  随派发注入 workflowCheck 做实例 owner 重核——T03 收口:单卡/扇出/自动链三入口准入一致。 */
type DispatchInBackground = (
	input: DispatchClaimInput & { dispatch_reason?: string },
	dispatchOptions: { 公共参数?: Partial<Omit<WorkerRunOptions, "卡号" | "提示词">> },
	key: string,
	cardNo: string,
	ownerSession?: string,
	worktreeTarget?: WorktreeTarget,
	supervisionRoute?: WorkerSupervisionRoute,
	/** 受理入口接续核查、验收与交付；旧单卡派发保留原有回执语义。 */
	completeTask?: boolean,
) => void;

function buildDispatchTool(
	host: MinisterHost,
	deps: {
		dispatchInBackground: DispatchInBackground;
		resolveCardsDir: () => string;
		resolveSupervisionRoute?: RegisterWorkerToolsOptions["resolveSupervisionRoute"];
	},
): ToolDefinition<typeof DispatchParams> {
	const error = toolError;
	return {
		name: "pao_dispatch_card",
		label: "派单",
		description:
			"单卡派发(非阻塞,B 档):把一张卡派给一次性 worker,受理即返回——本工具不等 worker 跑完。" +
			"认领/基线/预算/名额/写锁/运行/回执落卡全部在后台按 fail-closed 链执行(与 pao_fanout 同链路,进程进同一登记册,pao_stop_background 可全停);" +
			"结果(终态/摘要/失败路由)以后以 pao 派卡通知 注入送达(伴 toast),被护栏拒派/失败同样通知——派出后不要傻等轮询,期间可继续干别的。" +
			"派前自省:真的需要额外多派一个吗;理由必填且留痕供上级审查(理由必填,trim 后不得为空)。" +
			"权限 fail-closed:部长角色只能派本部门卡——须 PAO_DEPT 环境变量已设且与卡的「部门」frontmatter 一致,否则拒派;主控不限。" +
			`部门并发上限护栏:登记表中同部门且仍活着的进程数达上限即拒派(上限读 $PAO_HOME/${DEPT_CONCURRENCY_CONFIG_RELATIVE_PATH} 的「部门并发上限」,文件或键缺失时缺省 ${DEFAULT_DEPT_CONCURRENCY} 照样生效——护栏安全默认开,与「缺保温文件=不保温」的功能语义相反)。` +
			"共享上游额度(M2-03):保温.json 可选键「上游并发上限」＝账号级硬顶(全部活进程跨部门合并计;键缺失＝不启用,派单缺省 2 照旧)。" +
			"任务黑板(M2-03):认领成功即在工作区首建 黑板.md(幂等)并给 worker 注入指针——同伴中间结论与便条页,便签先挂链接再散写,归档即冻结。" +
			"认领纪律与扇出同源:unclaimed→in_progress(尝试 +1,无主则 owner=派单者:主控写「主控」,部长写 PAO_DEPT 值),认领即落基线快照;in_progress/已终态卡不拉起(派单即时回执直接给拒派原因,不等派卡通知)。" +
			`监督与裁决(B 档):worker 静默(保温.json「worker 静默分钟」,缺省 ${DEFAULT_WORKER_SILENCE_MINUTES},0=关)会收到静默提醒,提醒带 live 输出路径与输出尾——` +
			"继续等＝不用做任何事(有输出后计时自动重置);确认卡死须终止＝调 pao_terminate_card(只终止本会话派出的运行中 worker)。" +
			"机械超时缺省 24 小时,只兜「静默叫了人但无人应答」的底,不是主判决。" +
			// S5 包4 四写法③④:只许/禁止清单＋派完即停写进派单提示词(主控/部长共面)
			OWNER_DISPATCH_DISCIPLINES,
		parameters: DispatchParams,
		execute: async (_toolCallId, params: DispatchParamsShape, _signal, _onUpdate, ctx) => {
			const reason = params.reason?.trim() ?? "";
			if (!reason) {
				return error(
					"派单未执行:reason 必填(trim 后不得为空;派前自省:真的需要额外多派一个吗;reason 会留痕供上级审查)。",
				);
			}
			const cardsDir = params.cards_dir ?? deps.resolveCardsDir();
			if (params.worktree_id !== undefined && !params.worktree_id.trim()) {
				return error("派单未执行:worktree_id 不得为空，须使用宿主已登记的工作树 ID。");
			}
			try {
				// 派前同步校验只做快的两道(定位/权限 fail-closed,即时反馈);认领/基线/预算/名额/
				// 写锁/停止确认仍在 executeDispatch 内 fail-closed 执行——只是从阻塞改为后台,链不松。
				const located = locateDispatchCard(cardsDir, params.card_ref);
				const permission: DispatchPermission = checkDispatchPermission({
					卡部门: located.frontmatter.dept,
					env: process.env,
				});
				if (!permission.允许) return error(`派单未执行:${permission.原因}`);

				// 已终态/进行中卡同步拒派(2026-10-05 修):即时回执直接给拒派原因——原先即时
				// 回执说「已派出」,拒派原因要等下一轮派卡通知才可见;后台链路 claimCard 仍
				// fail-closed 把关(同一拒因文案),这里只是把判定提前到同步面。
				// S5 包3:拒因带同号去重信息(既有回执结果/结果未知先查现场);带 接管 时
				// 放行进后台链做接管三查(回执去重/活进程/状态机),不在同步面重复判。
				if (!params.接管) {
					const refusal = claimRefusalDetail(located);
					if (refusal) return error(`派单未执行:${refusal}。`);
				}

				// M2-01 宿主接线(定案10/定案9):派到同部门＋同项目且登记表有热部长会话时,
				// 把交接页路径作为指针附进派卡信封(背景核对,不是续跑指令);同时机械比对
				// 配方指纹,不一致仅在工具输出提示「建议重开」,宿主不自动杀。
				let handoffPointer: string | undefined;
				let fingerprintHint: string | undefined;
				if (located.frontmatter.dept) {
					const projectRoot = projectRootForCards(cardsDir);
					handoffPointer = host.dispatchHandoffPointer(located.frontmatter.dept, projectRoot);
					fingerprintHint = host.verifyRecipeFingerprint(located.frontmatter.dept, projectRoot).提示;
				}
				const notes: string[] = [];
				if (handoffPointer) notes.push("已把交接页指针附进派卡信封(背景核对,不是续跑指令)。");
				if (fingerprintHint) notes.push(fingerprintHint);

				const cardNo = String(parseCardRef(params.card_ref)).padStart(4, "0");
				const key = `${resolve(cardsDir)}#卡${cardNo}`;
				// 非阻塞派出(B 档):受理即返回;执行体 fire-and-forget。不接工具 signal——工具调用
				// 此刻就返回,取消语义由 runner 树杀承担(session_shutdown/pao_stop_background),与 fanout 后台模式同款。
				deps.dispatchInBackground(
					{
						cardsDir,
						card_no: params.card_ref,
						operator: permission.操作者,
						time: nowString(new Date()),
						dispatch_reason: reason,
						...(params.接管 ? { 接管: true } : {}),
					},
					handoffPointer ? { 公共参数: { 附加系统提示词: [handoffPointer] } } : {},
					key,
					cardNo,
					// 调用方会话身份随派发注入 workflowCheck（owner 重核,与自动链/扇出同源;无会话上下文时缺省）。
					ctx?.sessionManager?.getSessionId?.(),
					params.worktree_id !== undefined ? { kind: "managed", worktreeId: params.worktree_id } : undefined,
					deps.resolveSupervisionRoute?.({
						cardNo,
						cardsDir,
						operator: permission.操作者,
						ownerSession: ctx?.sessionManager?.getSessionId?.(),
						goal: located.frontmatter.goal ?? "",
					}),
				);
				return {
					content: [
						{
							type: "text",
							text: [
								`已派出:卡${cardNo}(派单理由:${reason};owner 走认领状态机:${permission.操作者})。本工具调用到此返回,不等 worker。`,
								"结果(终态/摘要/认领基线/回执落卡)后台跑完后,下一轮以 pao 派卡通知 注入送达(伴 toast);被拒派/失败同样通知。期间可继续干别的。",
								"查询:pao_inventory 看在跑进程;/pao queue 看卡状态。",
								`监督:worker 静默(缺省 ${DEFAULT_WORKER_SILENCE_MINUTES} 分钟无输出)会提醒你,提醒带 live 输出路径——继续等＝不用做任何事;终止＝调 pao_terminate_card。`,
								...notes,
							].join("\n"),
						},
					],
					details: { dispatched: true, card_no: cardNo },
				};
			} catch (e) {
				return error(`派单未执行:${e instanceof Error ? e.message : String(e)}`);
			}
		},
	};
}

// ── pao_terminate_card:上级裁决·终止运行中 worker(B 档,2026-10-03 定案) ────────────

const TerminateParams = Type.Object({
	card_ref: Type.String({ description: "card_ref(卡0017/卡#17/17 均可)" }),
	cards_dir: Type.Optional(
		Type.String({
			description:
				"cards_dir:任务工作区卡目录(终止匹配范围与回执落卡定位用;同号卡在其他项目运行时不误伤);已配置默认卡目录时可省略",
		}),
	),
});

type TerminateParamsShape = Static<typeof TerminateParams>;

function buildTerminateTool(
	runner: WorkerRunner,
	deps: { resolveCardsDir: () => string; inFlight: Map<string, InFlightDispatch> },
): ToolDefinition<typeof TerminateParams> {
	const error = toolError;
	return {
		name: "pao_terminate_card",
		label: "终止卡",
		description:
			"上级裁决·终止 worker(B 档):按卡号终止本卡目录下本会话派出的运行中 worker(登记表按卡路径匹配,他项目同号不误伤),复用 runner 停止链" +
			"(树杀→等真退出→StopProof),派发链凭停止确认放项目写锁(先停后放锁)、摘除登记,并落「canceled(被上级终止)」回执到卡。" +
			"只终止本会话派出的运行中 worker,跨会话不越权;找不到运行中条目即报错不误伤。" +
			"用法:静默提醒叫人后,读了 live 输出确认卡死才调本工具;继续等＝不用调。",
		parameters: TerminateParams,
		execute: async (_toolCallId, params: TerminateParamsShape) => {
			const cardsDir = params.cards_dir ?? deps.resolveCardsDir();
			const cardNo = String(parseCardRef(params.card_ref)).padStart(4, "0");
			// K3:匹配收窄到本卡目录的卡路径（同号去重/租约同款 sameCardPath 口径）——裸卡号会把同会话
			// 其他项目的同号 worker 一并终止;卡不在本目录＝本目录无此卡,如实报错不误伤他项目。
			let located: ReturnType<typeof locateDispatchCard> | undefined;
			try {
				located = locateDispatchCard(cardsDir, cardNo);
			} catch {
				/* 本目录无此卡文件:无路径可锚定,按无目标处理(报错不误伤) */
			}
			const targets =
				located === undefined
					? []
					: runner.registry
							.list()
							.filter(
								(entry) =>
									entry.running &&
									entry.card_no === cardNo &&
									entry.card_path !== undefined &&
									sameCardPath(entry.card_path, located.path),
							);
			if (located === undefined || targets.length === 0) {
				return error(
					`终止未执行:无运行中的卡${cardNo}(本工具只终止本卡目录下本会话派出的运行中 worker,跨会话/跨项目同号不越权;可用 pao_inventory 确认在跑进程)。`,
				);
			}
			const notes: string[] = [];
			try {
				// 停止链:terminate 打「被上级终止」标记后走与 cancel 完全同一条 树杀→确认→StopProof,
				// 不裸 killTree、不绕过停止确认(放锁凭据只能由 runner 签发)。
				const stopMethods: string[] = [];
				for (const target of targets) {
					const proof: StopProof = await runner.terminate(target.card_path ?? cardNo);
					stopMethods.push(
						proof.stoppedProcesses.map((p) => p.方式).join(";") || "无在跑进程可杀(可能刚自然退出)",
					);
				}
				// 放锁:在途派卡链的 executeDispatch finally 凭 confirmStopped/StopProof 放写锁并回收
				// 名额——等它收敛再回话,保证「终止返回时锁已放」;不在册的链(扇出/自动链)自己收敛。
				const key = `${resolve(cardsDir)}#卡${cardNo}`;
				const tracked = deps.inFlight.get(key);
				if (tracked) await tracked.done;
				// 摘除登记:真实链路 run() close 已 markExited,此处幂等兜底(直连运行器等场景靠它)
				for (const target of targets) runner.registry.markExited(target.pid, target.run_id);
				// 回执核对:该尝试的回执已由派发链落卡则不重复(双落会污染用量聚合);
				// 直连 runner.run 等无回执链的场景,补 owner 侧「被上级终止」回执。
				let attempt = targets[0].attempt;
				const cardPath = located.path;
				attempt ??= located.frontmatter.attempt;
				let landed = false;
				const deadline = Date.now() + 2_000;
				while (!landed && Date.now() < deadline) {
					try {
						// 卡面回执段的存储形状是 Receipt(attempt),非 WorkerReceipt(attempt)——核对按卡面形状来
						if (readCard(cardPath).receipts.some((receipt) => receipt.attempt === attempt)) landed = true;
					} catch {
						// Windows 原子写并发 rename 可瞬时 EPERM:单次读卡失败≠无回执,继续轮询到 deadline,
						// 提前退场会走下方补写兜底造成回执双落
					}
					if (!landed) await new Promise((resolveTick) => setTimeout(resolveTick, 50));
				}
				if (!landed && attempt !== undefined) {
					try {
						// 补写前同尝试再核（P3-6 残余窗口）：轮询期读卡连续失败、走到这里时读恢复
						// 且卡面已有该尝试回执（派发链恰在窗口内落卡）→ 不补写，防双落污染用量聚合。
						// 守卫须挂在读成功之后才可信；再核与落卡之间新落的回执属微秒级竞态，
						// 与单写者纪律下既有窗口同级，不在此扩大防线。
						landed = readCard(cardPath).receipts.some((receipt) => receipt.attempt === attempt);
						if (!landed) {
							await appendDispatchReceipt(located, {
								card_no: cardNo,
								attempt,
								status: "canceled",
								artifact_path: [],
								summary:
									"被上级终止(pao_terminate_card):进程已树杀并确认退出;用量未采集,以 live 证据与登记表为准",
								// 关联键回填纪律（P4-1 件3）:每条落卡回执都带 worker 会话标识（＝run_id，
								// runner 以 --session-id 传入子进程），终止兜底回执也不例外——否则这张卡
								// 的该次尝试查不到「哪个会话在跑它/跑过它」。run_id 非 WorkerUsage 协议字段
								// （落卡时由 appendDispatchReceipt 并入用量自由区），断言只为过结构校验。
								usage: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									cost: 0,
									turns: 0,
									run_id: targets[0].run_id,
								} as WorkerUsage,
								evidence_path: "",
								exitCode: -1,
								stopReason: "被上级终止",
								command: targets[0].command,
								pid: targets[0].pid,
								duration_ms: 0,
							});
							landed = true;
						}
					} catch (e) {
						notes.push(
							`终止回执落卡失败:${e instanceof Error ? e.message : String(e)}(进程已停,现场以登记表为准)。`,
						);
					}
				}
				return {
					content: [
						{
							type: "text",
							text: [
								`已终止:卡${cardNo}${attempt !== undefined ? `(尝试 ${attempt})` : ""}——${stopMethods.join(";")}。`,
								"停止确认通过(StopProof 链);写锁随派发链收敛放行(先停后放锁);登记已摘除。",
								landed ? "回执已落卡(结果:canceled,被上级终止)。" : "回执由派发链稍后落卡。",
								...notes,
							].join("\n"),
						},
					],
					details: { card_no: cardNo, attempt, terminated: true },
				};
			} catch (e) {
				// 停止确认失败兜底:与既有 stop_failed 处理同语义——锁不放(先停后放锁),如实上抛不遮蔽
				const reason =
					e instanceof PaoWorkerError ? `${e.code}:${e.message}` : e instanceof Error ? e.message : String(e);
				return error(
					`终止失败:${reason}(停止确认未过——写锁未放,先停后放锁;可重试或人工处理,登记表与 live 证据保留现场)`,
				);
			}
		},
	};
}

// ── 工具注册 ────────────────────────────────────────────────────────

const InventoryParams = Type.Object({
	workspace: Type.String({
		description:
			"workspace:任务工作区绝对路径，必须直接内含 卡/ 目录(支持 <项目根>/.pao/卡、<项目根>/.pao/<任务目录>/卡，以及显式 project_root 配合的自定义任务目录);不能传项目根",
	}),
	project_root: Type.Optional(
		Type.String({
			description:
				"project_root:可选的目标项目根。标准 .pao 布局省略时从层级推导，显式给出时须与所属项目一致；非 .pao 自定义布局须显式给出",
		}),
	),
});

/** 派单理由截到一行内合理长度(首行,超长加省略号)——盘点是监督面,不是全文朗读 */
function truncateReason(text: string, max = 60): string {
	const firstLine = text.split("\n")[0].trim();
	return firstLine.length > max ? `${firstLine.slice(0, max)}…` : firstLine;
}

/** 登记表 worker 行(部门/派单理由,M2 定案:供上级监督审查);部长会话条目(标签=部长,卡号为空)单列一行 */
function formatProcessLines(entries: readonly ProcessEntry[]): string[] {
	if (entries.length === 0) return ["- 后台进程:无(本轮登记表为空)"];
	const lines = [`- 后台进程 ${entries.length} 个(部门/派单理由供上级审查):`];
	for (const entry of entries) {
		if (entry.tags === "部长") {
			lines.push(
				`  · pid=${entry.pid} 部长会话〔${entry.dept ?? "无部门"}〕${entry.running ? "运行中" : "已退出"}(无卡会话,详见下方部长会话行)`,
			);
			continue;
		}
		const reason = entry.dispatch_reason ? truncateReason(entry.dispatch_reason) : "-";
		lines.push(
			`  · pid=${entry.pid} 卡${entry.card_no}〔${entry.dept ?? "无部门"}〕${entry.running ? "运行中" : "已退出"}:理由 ${reason}`,
		);
	}
	return lines;
}

function formatInventory(
	report: InventoryReport,
	processes: readonly ProcessEntry[],
	ministerLines: string[],
	hotSessionCount: number,
): string {
	const lines: string[] = [`只读盘点(截至 ${report.盘点时间.slice(0, 19).replace("T", " ")},不写文件不清锁不重跑):`];
	if (report.未完卡.length === 0) {
		lines.push("- 未完卡:无");
	} else {
		lines.push(`- 未完卡 ${report.未完卡.length} 张:`);
		for (const card of report.未完卡) {
			lines.push(
				`  · 卡${card.卡号}〔卡状态:${card.状态};当前尝试 ${card.尝试} 有效回执:${card.当前尝试回执结果};最近收到的回执:${card.最近收到回执结果}(可能来自历史尝试)〕:${card.目标}`,
			);
			lines.push("    正文最后回执摘要(可能来自历史尝试):");
			for (const line of card.最后回执摘要.split("\n")) lines.push(`    ${line}`);
		}
	}
	lines.push(...formatProcessLines(processes));
	if (report.问题.length > 0) {
		lines.push(`- 盘点不完整:${report.问题.length} 处卡目录或卡文件读取失败(不能当成无任务)`);
		for (const problem of report.问题) lines.push(`  · ${problem.路径}:${problem.原因}`);
	}
	// M2-01 定案11:部长会话行(pid/最近事件/轮次/调用/指纹/活性标记);全局热会话数是观测
	// 项不是硬闸——超 8 只提示不拒(结构性上界=部门×项目组合数)。
	if (ministerLines.length === 0) {
		lines.push("- 部长会话:无热会话");
	} else {
		lines.push(`- 部长会话 ${ministerLines.length} 个(pid/轮次/调用/指纹/活性,监督观测面):`);
		for (const line of ministerLines) lines.push(line);
		if (hotSessionCount > globalHotSessionLimit) {
			lines.push(
				`  注意:全局热部长会话 ${hotSessionCount} 个,超过观测口径 ${globalHotSessionLimit}(仅提示,不拒绝拉起)`,
			);
		}
	}
	if (report.git.可用) {
		lines.push(`- git(${report.git.分支 ?? "?"}@${report.git.head ?? "?"}):${report.git.汇总}`);
		if (report.git.原因) lines.push(`  原因:${report.git.原因}`);
	} else {
		lines.push("- 越界核查未执行:目标项目不是 git 仓库或 git 不可用;不把无 git 状态当成无改动。");
		if (report.git.原因) lines.push(`  原因:${report.git.原因}`);
	}
	// 终态卡分区(E5 补「查回」闭环):没有终态卡就整段不输出——输出「终态卡:无」只让
	// 回执变长而信息为零。只报卡面事实,判不出「这条受理是被 dup 还是被停」(见 已知边界.md)。
	if (report.已终结卡.length > 0) {
		lines.push(`- 已终结卡 ${report.已终结卡.length} 张(最近在前;卡面事实,不查受理账):`);
		for (const card of report.已终结卡) {
			const when = card.终结时间 ? ` ${card.终结时间}` : "";
			lines.push(`  · 卡${card.卡号}〔${card.状态}〕${when}:${card.目标}`);
			if (card.原因摘要) lines.push(`    原因:${card.原因摘要}`);
		}
		if (report.已终结卡截断 > 0) {
			// 不假装全量:给真实可行的下一步(卡文件就在报告里的卡目录下,直接用文件工具翻)
			// 目录名由卡协议固定为「卡」,若协议变更此处需同步(inventory.ts 的 path.join(workspace, "卡") 同源)
			lines.push(
				`  另有 ${report.已终结卡截断} 张已终结卡未列出(本轮只报最近 ${report.已终结卡.length} 张)。要看全量请直接列 ${"卡"} 目录下的 .md 卡文件,按 frontmatter 的 status 过滤 canceled/failed/delivered。`,
			);
		}
	}
	return lines.join("\n");
}

function buildInventoryTool(runner: WorkerRunner, host: MinisterHost): ToolDefinition<typeof InventoryParams> {
	return {
		name: "pao_inventory",
		label: "只读盘点",
		description:
			"重启只读盘点:扫任务工作区 卡/ 目录列未完卡(状态+当前尝试有效回执+最近收到回执(可能历史)+最后回执摘要),列本轮登记表后台进程(部门+派单理由,供上级监督审查)与热部长会话行(pid/轮次/调用/指纹/活性标记,定案11),并对开工基线做 git status 差异摘要。绝不写文件、不清锁、不重跑——盘点结果供人决定重派或作废。" +
			// §5.4:停止/重派后旧受理结果不能当成功——查询面负责说清「谁是当前真相」
			"读法(计划 §5.4):本工具列出的卡状态与尝试号是**当前**真相;" +
			"若先前 pao_accept_task 的受理结果与这里对不上(卡已 canceled/已终结,或尝试号已变),那份旧受理结果就不能再当成功——以本工具为准。",
		parameters: InventoryParams,
		execute: async (_toolCallId, params) => {
			let report: InventoryReport;
			try {
				report = await inventory({ 工作区: params.workspace, 项目根: params.project_root });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `盘点未执行：${message}` }],
					details: error instanceof InventoryPathError ? { ...error.details, code: error.code } : {},
					isError: true,
				};
			}
			const ministerLines = host.inventoryView().map(renderMinisterInventoryLine);
			const text = formatInventory(report, runner.registry.list(), ministerLines, ministerLines.length);
			const todos = host.todoView();
			const todoLines = todos.flatMap((item) =>
				item.标记.map((mark) => `- 待办标记〔${item.部门}@${item.项目名}〕:${mark}`),
			);
			return {
				content: [{ type: "text", text: todoLines.length > 0 ? `${text}\n${todoLines.join("\n")}` : text }],
				details: {},
			};
		},
	};
}

const StopParams = Type.Object({});

function buildStopTool(runner: WorkerRunner, host: MinisterHost): ToolDefinition<typeof StopParams> {
	return {
		name: "pao_stop_background",
		label: "停后台",
		description:
			"停止本轮登记在案的全部后台 worker 进程和宿主部长会话(树杀并等真退出),并停止宿主监督跟踪;之后本轮不再派发。只处理当前进程登记在案的对象,不按进程名全局清理;返回 worker 停止清单、部长停止情况与所有失败原因。",
		parameters: StopParams,
		execute: async () => {
			const [workerResult, hostResult, trackingResult] = await Promise.allSettled([
				runner.stopAll(),
				host.stopAll("pao_stop_background 显式全停"),
				Promise.resolve().then(() => host.stopTracking()),
			]);
			const failures: string[] = [];
			let workerText: string;
			if (workerResult.status === "fulfilled") {
				const proof = workerResult.value;
				workerText =
					proof.stoppedProcesses.length === 0
						? "无运行中的后台 worker,未停任何 worker 进程;本轮已封锁再派发。"
						: `已停 ${proof.stoppedProcesses.length} 个进程(后台 worker):${proof.stoppedProcesses
								.map((p) => `pid=${p.pid}${p.卡号 ? `(卡${p.卡号})` : ""} ${p.方式}`)
								.join(";")}`;
			} else {
				workerText = "后台 worker 全停失败";
				failures.push(
					`后台 worker 全停失败:${workerResult.reason instanceof Error ? workerResult.reason.message : String(workerResult.reason)}`,
				);
			}
			let ministerText: string;
			if (hostResult.status === "fulfilled") {
				ministerText =
					hostResult.value.length === 0
						? "宿主没有登记中的部长会话,未停部长进程。"
						: `已停 ${hostResult.value.length} 个部长会话。`;
			} else {
				ministerText = "部长会话全停失败";
				failures.push(
					`部长会话全停失败:${hostResult.reason instanceof Error ? hostResult.reason.message : String(hostResult.reason)}`,
				);
			}
			let trackingText: string;
			if (trackingResult.status === "fulfilled") {
				trackingText = "宿主监督跟踪已停止;同一会话内不会自动重启。";
			} else {
				trackingText = "宿主监督跟踪停止失败";
				failures.push(
					`宿主监督跟踪停止失败:${trackingResult.reason instanceof Error ? trackingResult.reason.message : String(trackingResult.reason)}`,
				);
			}
			const lines = [workerText, ministerText, trackingText, ...failures];
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					workerStopped:
						workerResult.status === "fulfilled" ? workerResult.value.stoppedProcesses.length : undefined,
					ministerStopped: hostResult.status === "fulfilled" ? hostResult.value.length : undefined,
					trackingStopped: trackingResult.status === "fulfilled",
					failures,
				},
				isError: failures.length > 0 ? true : undefined,
			};
		},
	};
}

export interface RegisterWorkerToolsOptions {
	verificationCommandRunner?: import("../cards/verifier.ts").VerificationCommandRunner;
	/**
	 * 宿主权威工作树服务。正式扩展装配必须显式提供；旧 SDK 直调
	 * registerWorkerTools 且未提供时，只为 primary 目标装配单根适配器。
	 */
	worktreeHost?: PaoWorktreeHost;
	/** 未安装宿主时给工具调用方的真实原因。 */
	worktreeHostReason?: string;
	/** 默认派发目标；缺省 primary，单次 pao_dispatch_card 可用 worktree_id 覆盖。 */
	worktreeTarget?: WorktreeTarget;
	/** 运行器;缺省用模块级 defaultWorkerRunner(lifecycle.ts) */
	runner?: WorkerRunner;
	/**
	 * 是否接管 SIGINT/SIGTERM(先停子进程树再恢复默认终止)。默认 true;
	 * 测试或宿主已自管信号时传 false(session_shutdown 钩子始终注册)。
	 */
	signals?: boolean;
	/** 默认卡目录解析;pao_dispatch_card 的 cards_dir 参数缺省时用(再回落 cwd 的 .pao/卡) */
	resolveCardsDir?: () => string;
	/** PAO_HOME 解析(部门并发上限的保温配置寻址用);缺省读环境变量 PAO_HOME */
	resolvePaoHome?: () => string;
	/**
	 * 部长会话宿主(M2-01 定案10/11 接线):pao_dispatch_card 的交接页指针与指纹核对、
	 * pao_inventory 的部长会话行、主会话关闭全停都走它;缺省用模块级 defaultMinisterHost。
	 */
	host?: MinisterHost;
	/** T04 共用通知缓冲(S6-K3):宿主接线传入与 workflow 自动链通知共用的同一实例;缺省自建独立面 */
	notifySurface?: DispatchNotifySurface;
	/** 工具入口派发给本次 runner 的公共参数；正式宿主可用来固定受控可执行文件，测试用来使用假 worker。 */
	dispatchParameters?: Partial<Omit<WorkerRunOptions, "卡号" | "提示词">>;
	/** 在途后台登记和 finally 清理后调用;供 print 宿主的变化订阅串进 agent 等待条件。 */
	onBackgroundChange?: () => void;
	/** 派发端可覆盖的直接部长路由；缺省使用生产 resolver 读取卡与工作流冻结控制。 */
	resolveSupervisionRoute?: (input: {
		cardNo: string;
		cardsDir: string;
		operator: string;
		ownerSession?: string;
		goal: string;
	}) => WorkerSupervisionRoute | undefined;
}

/**
 * 注册 worker 模块:pao_inventory(只读盘点,含登记表 worker 行:部门/派单理由)、
 * pao_stop_background(stopAll)、pao_dispatch_card(单卡派发:理由必填＋部长权限 fail-closed＋部门并发上限护栏,
 * 认领/基线/登记与 pao_fanout 走同一 dispatch-core 链路),并挂 session_shutdown 钩子——
 * 主会话退出(quit/reload/new/resume/fork)时停掉本轮全部登记进程(架构 §1:主会话关闭全停)。
 * 注册面:主控/部长共用;worker 角色整模块跳过(role.ts WORKER_SKIPPED_MODULES)。
 * 生命周期/静默扫描/通知面分别在 lifecycle/silence/notify 模块,这里只装配:
 * 返回后台观测面(§21 fanout 后台区同款):backgroundCount()＝{inFlight,unread}(inFlight＝后台派卡链条数,
 * unread＝通知缓冲里还没被 before_agent_start 消费的条数);waitForBackground()＝等全部在途链收敛(测试与收尾用)。
 */
export function registerWorkerTools(
	pi: ExtensionAPI,
	options: RegisterWorkerToolsOptions = {},
): { backgroundCount: () => { inFlight: number; unread: number }; waitForBackground: () => Promise<void> } {
	const runner = options.runner ?? defaultWorkerRunner;
	const host = options.host ?? defaultMinisterHost;
	// 活动 getter 在注册时可能为空，宿主不会启动监督时钟。这里只负责在进程登记表
	// 真实变化时叫宿主重读一次；计时、到期判断与通知仍全部归 MinisterHost。
	const unsubscribeHostActivity = runner.registry.subscribe(() => host.refreshActivity());
	const resolveRole = (): "main" | "minister" => (resolvePaoRole() === "部长" ? "minister" : "main");
	const defaultWorktreeTarget: WorktreeTarget = options.worktreeTarget ?? { kind: "primary" };
	const resolveCardsDir = (): string =>
		options.resolveCardsDir?.() ??
		// 回落与 src/pao/index.ts defaultCardsDir 同口径(worker 不反赖 index,免循环 import)
		join(process.cwd(), ".pao", "卡");
	const resolveHome = (): string | undefined => {
		try {
			return options.resolvePaoHome?.() ?? process.env.PAO_HOME?.trim();
		} catch {
			// resolvePaoHome 缺现场环境时抛错(桌面宿主主进程常无 PAO_HOME)。监督链路按
			// 「无 home」回落(readWorkerSilenceMinutes 缺省静默阈值),不把周期扫描炸成宿主崩溃。
			return undefined;
		}
	};

	// ── B 档后台派卡的通知面(notify.ts;会话级内存态,R25 重启归零;卡文件状态与回执是真相) ──
	// S6-K3:宿主可传共享实例与 workflow 自动链通知同缓冲;缺省自建(单独注册仍可用)。
	const notifySurface =
		options.notifySurface ??
		createDispatchNotifySurface({ resolvePaoHome: resolveHome, wakeUp: () => sendDispatchNotifyWakeup(pi) });
	const inFlight = new Map<string, InFlightDispatch>();
	const notifyBackgroundChange = (): void => {
		try {
			options.onBackgroundChange?.();
		} catch (error) {
			logWarn(`[pao] 后台变化回调失败:${error instanceof Error ? error.message : String(error)}`);
		}
	};
	const supervisionRoute = (input: {
		cardNo: string;
		cardsDir: string;
		operator: string;
		ownerSession?: string;
		goal: string;
	}): WorkerSupervisionRoute | undefined => {
		try {
			if (options.resolveSupervisionRoute) return options.resolveSupervisionRoute(input);
			return createWorkerSupervisionRouteResolver({
				role: resolveRole(),
				department: process.env.PAO_DEPT,
			})(input);
		} catch (error) {
			logWarn(
				`[pao] 监督路由解析失败，工人不进入周期监督:${error instanceof Error ? error.message : String(error)}`,
			);
			return undefined;
		}
	};

	const dispatchInBackground: DispatchInBackground = (
		input,
		dispatchOptions,
		key,
		cardNo,
		ownerSession,
		target,
		routeAtDispatch,
		completeTask = false,
	) => {
		// 每次派发独立捕获目标，不能改写会话默认值而让并发卡串线。
		const worktreeTarget = target ?? defaultWorktreeTarget;
		const startedAt = Date.now();
		let activeRoute: WorkerSupervisionRoute | undefined;
		let supervisionTracked = false;
		let supervisionFinished = false;
		let resultText = "";
		let finalState: string | undefined;
		let taskState: WorkerReceipt["任务态"];
		const finishTrackedSupervision = async (
			outcome: "completed" | "failed" | "needs_ruling" | "canceled",
			detail: string,
		): Promise<boolean> => {
			if (!activeRoute || !supervisionTracked || supervisionFinished) return false;
			// stopTracking 已经清空本轮监督；全停后的任何晚到结果都只保留在卡、回执与证据中，
			// 不再调用宿主收尾，避免 canceled 分支重新触碰已清空的监督对象或触发通知。
			if (runner.isStopped()) {
				supervisionFinished = true;
				return false;
			}
			supervisionFinished = true;
			try {
				const result = await host.finishSupervision({
					key: activeRoute.key,
					outcome,
					detail,
					noticeKey: activeRoute.key,
				});
				if (!result.ok) {
					logWarn(`[pao] 工人回执投递失败（卡${cardNo}）:${result.原因 ?? "宿主未受理"}`);
					supervisionFinished = false;
					return false;
				}
				return true;
			} catch (error) {
				logWarn(`[pao] 工人回执投递失败（卡${cardNo}）:${error instanceof Error ? error.message : String(error)}`);
				supervisionFinished = false;
				return false;
			}
		};
		// 必须先登记，再启动异步链：拒派可能在首个 await 前完成，先启动会让 finally 删掉
		// 尚未 set 的旧项，随后 set 一个已结算 promise，waitForBackground 永远看不到本次派发。
		let done: Promise<void>;
		let registered = false;
		const chain = Promise.resolve().then(async (): Promise<void> => {
			try {
				const projectRoot = projectRootForCards(input.cardsDir);
				activeRoute =
					routeAtDispatch ??
					supervisionRoute({
						cardNo,
						cardsDir: input.cardsDir,
						operator: input.operator,
						ownerSession,
						goal: locateDispatchCard(input.cardsDir, cardNo).frontmatter.goal ?? "",
					});
				// 旧 SDK/旧工具直调没有宿主参数时保持 primary 单根能力。managed 目标仍要求
				// 显式宿主；正式扩展在 pao/index.ts 已 fail-closed，不会走到这里降级。
				const worktreeHost =
					options.worktreeHost ??
					(worktreeTarget.kind === "primary"
						? createSingleRootWorktreeHost(projectRoot)
						: (() => {
								throw new PaoWorkerError(
									"无效参数",
									options.worktreeHostReason ??
										"managed 派发必须由宿主安装工作树服务；不能把普通项目根伪装成独立工作树",
								);
							})());
				let completionReceipt: { receipt: WorkerReceipt; receiptWriteError?: string } | undefined;
				const dispatched = await executeDispatch(
					input,
					{
						运行器: runner,
						paoHome: resolveHome(),
						worktreeHost,
						worktreeTarget,
						// 工作流派发校验（T02 装配注入,T03 owner 收口）:准备期解析+锁后重核同源,
						// owner=调用方会话 id——单卡派工作流卡与自动链/扇出同判（实例/轮次/owner/暂停/冻结版本）。
						workflowCheck: (card) =>
							resolveWorkflowDispatch(card, {
								cardsDir: input.cardsDir,
								paoHome: resolveHome(),
								owner: ownerSession,
							}),
						解析监督路由: (card) => {
							try {
								return (
									supervisionRoute({
										cardNo: String(card.card_no).padStart(4, "0"),
										cardsDir: input.cardsDir,
										operator: input.operator,
										ownerSession,
										goal: card.frontmatter.goal ?? "",
									}) ?? null
								);
							} catch (error) {
								logWarn(
									`[pao] 监督路由解析失败（卡${cardNo}）:${error instanceof Error ? error.message : String(error)}`,
								);
								throw error;
							}
						},
						// 调用方透传参数放前面，固定参数与门禁放最后：固定命令用于正式宿主或测试
						// 选择明确的 worker 可执行文件，门禁是安全项，均不能被同名字段静默覆盖。
						// 今天 dispatchOptions 的类型只有 { 公共参数? }，结构上放不进 预算门禁；但类型一旦被放宽
						// （比如有人改成 Partial<ExecuteDispatchOptions>），顺序写反就会让调用方一个同名字段静默
						// 把门禁关掉——那种失败不报错、只悄悄不限额，所以顺序在这里是刻意的（见 usage-gate-coverage 的防回归断言）。
						...dispatchOptions,
						公共参数: {
							...dispatchOptions.公共参数,
							...options.dispatchParameters,
							...(activeRoute ? { supervisionRoute: activeRoute } : {}),
						},
						// 总预算门禁（G4）:没授权总预算时这里是 undefined（dispatch-core 整段跳过,
						// 行为与接线前一致）;授权了才注入,拒绝即认领前拦下,不留已派发痕迹。
						预算门禁: buildDispatchBudgetGate({ paoHome: resolveHome() }),
						认领: (claimed) => {
							const department = claimed.card.frontmatter.dept?.trim();
							if (!department) return;
							const resolved =
								activeRoute ??
								supervisionRoute({
									cardNo: String(claimed.card.card_no).padStart(4, "0"),
									cardsDir: input.cardsDir,
									operator: input.operator,
									ownerSession,
									goal: claimed.card.frontmatter.goal ?? "",
								});
							const routed = resolved ?? activeRoute;
							if (!routed && resolvePaoRole() === "主控") return;
							activeRoute = routed ?? {
								department,
								projectRoot: projectRootForCards(input.cardsDir),
								...(ownerSession ? { context: ownerSession } : {}),
								key: `${resolve(input.cardsDir)}#卡${String(claimed.card.card_no).padStart(4, "0")}`,
								...(claimed.card.frontmatter.goal ? { goal: claimed.card.frontmatter.goal } : {}),
							};
							host.trackSupervision({
								key: activeRoute.key,
								kind: "worker",
								department: activeRoute.department,
								projectRoot: activeRoute.projectRoot,
								...(activeRoute.context ? { context: activeRoute.context } : {}),
								...(activeRoute.sessionId ? { sessionId: activeRoute.sessionId } : {}),
								...(activeRoute.ownerSessionId ? { ownerSessionId: activeRoute.ownerSessionId } : {}),
								progress: { ...(activeRoute.goal ? { goal: activeRoute.goal } : {}) },
							});
							supervisionTracked = true;
							host.flushSupervision();
						},
					},
					async (claimed, receipt) => {
						let receiptLanding: string = "未落卡";
						let receiptNote: string | undefined;
						try {
							receiptLanding = (await appendDispatchReceipt(claimed.card, receipt)).kind;
						} catch (e) {
							receiptNote = `回执落卡失败:${e instanceof Error ? e.message : String(e)}(证据仍在 ${receipt.evidence_path})`;
						}
						const reportedReceipt: WorkerReceipt = receiptNote
							? { ...receipt, status: "failed", failure_type: "unknown_outcome" }
							: receipt;
						completionReceipt = { receipt, receiptWriteError: receiptNote };
						taskState = reportedReceipt.任务态;
						const outcome: DispatchOutcome = {
							cardNo: String(claimed.card.card_no).padStart(4, "0"),
							finalState: reportedReceipt.status,
							taskState: reportedReceipt.任务态,
							dept: claimed.card.frontmatter.dept ?? null,
							reason: input.dispatch_reason ?? "",
							operator: input.operator,
							attempt: claimed.尝试号,
							summary: receipt.summary,
							evidencePath: receipt.evidence_path,
							claimBaseline: claimed.claimBaseline,
							receiptLanding,
							receiptNote,
							durationMs: Date.now() - startedAt,
						};
						return {
							content: [{ type: "text" as const, text: formatDispatchResult(outcome, reportedReceipt) }],
							details: outcome,
							isError: receiptNote ? true : undefined,
						};
					},
				);
				if (!dispatched.可派) {
					await finishTrackedSupervision("failed", `[工人回执] 派发未执行：${dispatched.原因}`);
					if (!runner.isStopped()) {
						notifySurface.notify(
							`[派卡被拒] 卡${cardNo}:${dispatched.原因}(派单理由:${input.dispatch_reason ?? ""})`,
							"PAO 派卡被拒",
							`卡${cardNo}:${dispatched.原因}`,
						);
					}
					return;
				}
				finalState = (dispatched.result.details as { finalState?: string } | undefined)?.finalState;
				taskState = (dispatched.result.details as { taskState?: WorkerReceipt["任务态"] } | undefined)?.taskState;
				resultText = dispatched.result.content[0]?.text ?? "";
				if (completeTask) {
					if (!completionReceipt) throw new Error(`卡${cardNo}未取得本次回执，不能继续验收`);
					const stopReason = await completeDispatchedTask({
						cardsDir: input.cardsDir,
						cardRef: cardNo,
						operator: input.operator,
						runner,
						worktreeTarget,
						...completionReceipt,
						verificationCommandRunner: options?.verificationCommandRunner,
					});
					if (stopReason) {
						const fresh = locateDispatchCard(input.cardsDir, cardNo);
						finalState = fresh.frontmatter.status === "failed" ? "failed" : "needs_ruling";
						resultText += `\n任务未完成：${stopReason}`;
					} else {
						resultText += "\n任务核查、验收与必要交付已完成。";
					}
				}
				const outcome =
					taskState === "blocked" || taskState === "checkpoint"
						? "needs_ruling"
						: finalState === "success"
							? "completed"
							: finalState === "needs_ruling"
								? "needs_ruling"
								: finalState === "canceled"
									? "canceled"
									: "failed";
				const delivered = await finishTrackedSupervision(
					outcome,
					`[工人回执] ${resultText}${activeRoute?.goal ? `\n目标:${activeRoute.goal}` : ""}`,
				);
				// 全停是会话生命周期动作：卡回执、证据和审计照常落盘，但不再用完成通知/主动唤醒
				// 拉起模型。个人 terminate 不置 isStopped，仍走原有取消回执与通知语义。
				if (!delivered && outcome !== "canceled" && !runner.isStopped()) {
					notifySurface.notify(
						`[派卡完成] 卡${cardNo}${finalState ? `(${finalState})` : ""}\n${resultText}`,
						"PAO 派卡完成",
						`卡${cardNo}${finalState ? `(${finalState})` : ""}——详情见派卡通知`,
						{ key: `dispatch:${key}:${finalState ?? "done"}` },
					);
				}
			} catch (e) {
				const reason = e instanceof Error ? e.message : String(e);
				// 护栏拒绝(PaoWorkerError「无效参数」:部门/共享名额、双跑等)与真失败分开口径——
				// 被拒＝改参数/换卡可再试,失败＝执行过程出错须人工看;通知前缀与 toast 标题随之。
				const refused = e instanceof PaoWorkerError && e.code === "无效参数";
				await finishTrackedSupervision("failed", `[工人回执] 派发失败：${reason}`);
				if (!runner.isStopped()) {
					notifySurface.notify(
						`${refused ? "[派卡被拒]" : "[派卡失败]"} 卡${cardNo}:${reason}(派单理由:${input.dispatch_reason ?? ""})`,
						refused ? "PAO 派卡被拒" : "PAO 派卡失败",
						`卡${cardNo}:${reason}`,
					);
				}
			}
		});
		done = chain.finally(() => {
			// 同一 key 被后续派发替换时，旧链只清理自己，不误删新链。
			if (registered && inFlight.get(key)?.done === done) {
				inFlight.delete(key);
				// 必须在真实删除计数后通知，等待方才能观察到最终 0；放在删除前会让
				// print/RPC 仍看到 1，错过最后的收敛事件。
				notifyBackgroundChange();
			}
		});
		inFlight.set(key, { cardNo, done });
		registered = true;
		notifyBackgroundChange();
	};

	pi.registerTool(buildInventoryTool(runner, host));
	pi.registerTool(buildStopTool(runner, host));
	pi.registerTool(
		buildDispatchTool(host, {
			dispatchInBackground,
			resolveCardsDir,
			resolveSupervisionRoute: options.resolveSupervisionRoute,
		}),
	);
	pi.registerTool(buildTerminateTool(runner, { resolveCardsDir, inFlight }));
	pi.registerTool(
		buildAcceptTaskTool({
			resolveCardsDir,
			resolveHome,
			dispatchInBackground: (input, dispatchOptions, key, cardNo, ownerSession) =>
				dispatchInBackground(input, dispatchOptions, key, cardNo, ownerSession, undefined, undefined, true),
			// 主控/部长身份由派发链自己按角色判定（checkDispatchPermission 同源），这里不重复推导
		}),
	);

	// 通知主动唤醒与补投共用同一缓冲:唤醒只叫一轮,完整正文由 before_agent_start 消费。
	pi.on("before_agent_start", (event: DispatchNotifyEvent) => {
		notifySurface.inject(event);
	});
	// 正在运行的会话收到 followUp 时由 agent loop 继续，不会再次触发
	// before_agent_start。请求前补投同一消费式缓冲，避免只收到唤醒语而丢正文。
	pi.on("context_with_system", (event) => {
		const sections: Record<string, string> = {};
		notifySurface.inject({ systemPromptOptions: { sections } });
		if (Object.keys(sections).length === 0) return;
		return {
			messages: [...event.messages, { role: "system" as const, content: "", sections, timestamp: Date.now() }],
		};
	});

	// 静默提醒器(silence.ts):周期扫本会话运行中 worker,静默即叫人(缓冲＋toast;每静默期一次)
	const silenceReminder = createSilenceReminder({
		runner,
		readSilenceMinutes: () => readWorkerSilenceMinutes(resolveHome()),
		notify: (body, toastBody) => notifySurface.notify(body, "PAO worker 静默", toastBody),
	});

	// 部长会话与 worker 同生命周期:主会话退出(含信号)时随树全停(定案7 退出钩子复用)
	const disposeExitHooks = installExitHooks(runner, {
		signals: options.signals ?? true,
		extraStop: () => host.stopAll("主会话关闭全停"),
	});
	pi.on("session_shutdown", async (event) => {
		unsubscribeHostActivity();
		notifySurface.shutdown();
		silenceReminder.stop();
		const outcomes = await Promise.allSettled([runner.stopAll(), host.stopAll("主会话关闭全停")]);
		const failures = outcomes.flatMap((outcome) =>
			outcome.status === "rejected" ? [outcome.reason] : [],
		);
		if (failures.length) {
			throw new AggregateError(failures, "worker 或部长会话停止失败");
		}
		event.onConfirmedShutdown?.(() => {
			host.stopTracking();
			disposeExitHooks();
		});
	});

	return {
		backgroundCount: () => ({ inFlight: inFlight.size, unread: notifySurface.unreadCount() }),
		waitForBackground: async () => {
			await Promise.all([...inFlight.values()].map((item) => item.done));
		},
	};
}

// ── pao_accept_task：完整任务受理窄工具（计划 §5.2） ────────────────────────────────
//
// ## 这个工具做什么
// 一次调用把「集中预检 → 建卡 → 可选派发 → 返回真实身份」做完，逐条给出受理身份或真实拒绝原因。
// 业务逻辑一行都不在这里：全部交给 `intake/` 的唯一入口 `acceptIntake`。本函数只做三件事——
// 参数映射、模板解析（复用 cards 模板库）、把 IntakeOutcome 渲染成模型一眼能看懂的文本。
//
// ## 旧入口与新入口的关系（**名字与行为都是兼容契约，一律不改**）
// | 旧入口 | 在新入口里是哪一步 | 什么时候还该用它 |
// |---|---|---|
// | `pao_create_card`（建卡） | 第 2 步「建卡」：同一 `createCard`、同一发号器、同一原子写 | 只想建卡不想受理/不需要集中预检与幂等时；手工补建 |
// | `pao_dispatch_card`（派发） | 第 3 步「派发」：`dispatch=true` 时经同一个 `dispatchInBackground` 走同一条后台链 | 卡已存在、只想派它；指定 `接管`/`cards_dir` 等派发专属参数时 |
// | `pao_inventory`（查询） | 不在受理链内：受理是写动作，查询仍是查询 | 想看「卡现在什么状态、还有谁在跑」时 |
// | `pao_terminate_card`（停止） | 不在受理链内 | 停掉运行中的 worker（停完旧受理结果即失效，见下方 §5.4） |
//
// 新入口不是旧入口的替代品：它把「建卡＋派发」合成一次调用，并补上幂等判据与集中预检；
// 旧入口继续可用、语义不变（兼容契约，见计划 §12.2）。
//
// ## 停止后旧回执（计划 §5.4）
// 受理返回的是**当时**的身份快照。之后卡被停掉（canceled）、或重开进入了新尝试（attempt 变化），
// 这份旧 outcome 就不能再当「成功受理/正在跑」。判断交给 `intake/` 导出的 `isIntakeOutcomeStale`，
// 本工具的重复提交分支与 `pao_inventory` 的说明文字都会带上这条纪律。
//
// ## 幂等判据（不静默变更）
// 模型没给 `request_key` 时，按「目标＋部门＋验收＋依赖」算稳定摘要（sha256 前 16 位，带 `auto:` 前缀）。
// 返回文本里一定写明「本次用的判据是什么、是模型给的还是自动生成的」——判据一旦给出就不改写，
// 同一请求重试会自动落到同一条判据上（幂等＝先到者为准）。

/** 自动判据前缀：一眼区分「模型给的」与「工具按目标摘要生成的」。 */
const AUTO_INTAKE_KEY_PREFIX = "auto:";

/**
 * 按「目标＋部门＋验收＋依赖」算稳定判据。
 *
 * 为什么只取这四个字段：它们是「这是不是同一个任务」的最小充分集。预算/档位/优先级是执行参数，
 * 改这些不该变成新任务；inputs/constraints 是正文细节，进来会让判据过度敏感（措辞一变就重复建卡）。
 * 依赖排序后参与，避免同一依赖集换个顺序被当成新任务。
 */
export function buildAutoIntakeKey(parts: {
	goal: string;
	dept: string;
	acceptance: string;
	dependsOn?: readonly string[];
}): string {
	const normalized = [
		parts.goal.trim(),
		parts.dept.trim(),
		parts.acceptance.trim(),
		[...(parts.dependsOn ?? [])]
			.map((item) => item.trim())
			.sort()
			.join(","),
	].join("\u0000");
	return `${AUTO_INTAKE_KEY_PREFIX}${createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 16)}`;
}

const AcceptTaskParams = Type.Object({
	task: Type.Optional(TaskBookSchema),
	target: Type.Optional(Type.String({ description: "旧调用目标(必填):新调用优先用 task.goal" })),
	dept: Type.String({ description: "部门(必填):须为已登记部门;不自动建部,部门不存在会如实拒绝" }),
	acceptance: Type.Optional(Type.String({ description: "旧调用验收标准(必填):新调用优先用 task.acceptance" })),
	inputs: Type.Optional(Type.Array(Type.String(), { description: "输入指针列表(可空):文件路径、链接、上游产物" })),
	constraints: Type.Optional(Type.String({ description: "约束正文(可空):边界、不许做的事" })),
	depends_on: Type.Optional(
		Type.Array(Type.String(), { description: "依赖卡号列表(可空):未放行时不派发(如实报推迟)" }),
	),
	tier: Type.Optional(
		Type.String({
			description: `档位(可空,可选值:${CARD_TIERS.join("/")}):给了就由集中预检核对配置里是否真有这一档`,
		}),
	),
	budget: Type.Optional(
		Type.Object(
			{
				turns: Type.Optional(Type.Number({ description: "模型轮次上限" })),
				toolCalls: Type.Optional(Type.Number({ description: "工具调用次数上限" })),
				cost: Type.Optional(Type.Number({ description: "费用上限" })),
				collab_quota: Type.Optional(Type.Number({ description: "协作次数上限" })),
			},
			{ description: "预算(可空):0 值视为阻止启动,由预检把关" },
		),
	),
	priority: Type.Optional(
		Type.String({ description: `优先级(可空,可选值:${CARD_PRIORITIES.join("/")};缺省 medium,与建卡同口径)` }),
	),
	template: Type.Optional(
		Type.String({ description: "模板(可空):已批准模板名或绝对路径;正文骨架取自模板库,frontmatter 仍由受理生成" }),
	),
	dispatch: Type.Optional(
		Type.Boolean({
			description:
				"是否立即派发(缺省 false)。受理默认不替你花钱:false＝只建卡待认领;true＝建卡后经既有后台派发链派出,此时 reason 必填",
		}),
	),
	reason: Type.Optional(
		Type.String({
			description: "派单理由(dispatch=true 时必填):会留痕供上级审查;派前自省——真的需要现在派吗",
		}),
	),
	request_key: Type.Optional(
		Type.String({
			description:
				"请求判据/幂等键(可空):同一判据重复提交＝同一次受理,返回第一次的身份,不重复建卡。不给则按『目标+部门+验收+依赖』自动生成并在返回里写明",
		}),
	),
	cards_dir: Type.Optional(Type.String({ description: "cards_dir(可空):任务工作区卡目录;已配置默认卡目录时可省略" })),
});

type AcceptTaskParamsShape = Static<typeof AcceptTaskParams>;

export interface AcceptTaskToolDeps {
	resolveCardsDir: () => string;
	resolveHome: () => string | undefined;
	/** 唯一派发通道（registerWorkerTools 闭包里的 dispatchInBackground），只在 dispatch=true 时用 */
	dispatchInBackground: DispatchInBackground;
	/** 模板正文解析（缺省用 cards 模板库；测试可注入） */
	resolveTemplate?: (
		request: IntakeRequest,
	) => Promise<IntakeTemplateBody | undefined> | IntakeTemplateBody | undefined;
}

/** 模板名/绝对路径 → 正文骨架。解析实现只在 cards 模板库里，这里只做「有就给」的搬运。 */
function templateResolver(paoHome: string | undefined) {
	return (request: IntakeRequest): IntakeTemplateBody | undefined => {
		const name = request.template?.trim();
		if (!name) return undefined;
		// 解析失败（模板找不到/PAO_HOME 缺失）如实抛出，由 acceptIntake 收敛成带真实原因的拒绝
		const path = resolveCardTemplatePath(name, paoHome);
		return { name, body: loadCardBodyTemplate(path) };
	};
}

/**
 * 身份一行：卡号 / 尝试号 / 实例节点轮次——**给不出就不写**，不编。
 *
 * 注意「卡」字是**本层拼的显示前缀**，不是 E3 契约的一部分：`IntakeOutcome.cardNo` 是
 * 纯四位编号 `"0001"`（不含前缀，受理侧已对 `formatCardNumber` 的前缀做过归一）。
 * 别以为 cardNo 自带「卡」字，也别在别处把 `卡${cardNo}` 的结果当 id 再用一次——
 * 那是展示串，拿去比对/落库会得到 `卡卡0001`。
 */
function identityLine(outcome: IntakeOutcome): string {
	const parts: string[] = [];
	if (outcome.cardNo !== undefined) parts.push(`卡${outcome.cardNo}`);
	else parts.push("无卡号");
	parts.push(outcome.attempt !== undefined ? `尝试 ${outcome.attempt}` : "尝试号未产生（未启动就没有尝试）");
	const flow: string[] = [];
	if (outcome.instance !== undefined) flow.push(`实例 ${outcome.instance}`);
	if (outcome.node !== undefined) flow.push(`节点 ${outcome.node}`);
	if (outcome.round !== undefined) flow.push(`轮次 ${outcome.round}`);
	if (flow.length > 0) parts.push(flow.join("/"));
	return parts.join("，");
}

/** 问题项逐条一行（不吞问题、不概括成「有风险」）。 */
function problemLines(outcome: IntakeOutcome): string[] {
	return outcome.problems.map(
		(item) =>
			`  · [${item.level}] ${item.subject}：${item.reason}${item.suggestion ? `（建议：${item.suggestion}）` : ""}`,
	);
}

/**
 * Outcome → 模型可读文本。四种状态各说各的真话，尤其是 duplicate 不许只说「重复了」。
 *
 * `stale` 由调用方算（要对磁盘再查一次卡），undefined 表示「没查/不适用」。
 */
export function formatIntakeOutcome(
	outcome: IntakeOutcome,
	options: { cardsDir: string; autoKey: boolean; stale?: boolean; requestKey: string },
): string {
	const keyLine = `请求判据：
${options.requestKey}（${options.autoKey ? "工具按『目标＋部门＋验收＋依赖』自动生成，未给则沿用此判据" : "调用方提供，原样保留"}）`;
	const lines: string[] = [];
	switch (outcome.status) {
		case "accepted": {
			lines.push(`已受理：${identityLine(outcome)}`);
			lines.push(`受理时间：${outcome.acceptedAt}`);
			if (options.stale === true) {
				// 受理后到渲染这段文本之间，卡已被停/被重开——不能再说「在等你查」
				lines.push("注意：这张卡已被停止或重开（旧受理结果不再有效，别把它当成功；以 pao_inventory 的现场为准）。");
			} else if (outcome.dispatched === true) {
				lines.push("已提交后台派发：等待结果通知；无立即事项时本回合可以结束。");
			} else if (outcome.dispatched === false) {
				lines.push("只建了卡，尚未提交后台派发：准备好后调用 pao_dispatch_card 派出。");
			} else {
				lines.push("受理账未记录是否已提交后台派发；必要时用 pao_inventory 核对现场，不能据此认定仅建卡。");
			}
			break;
		}
		case "duplicate": {
			const first = outcome.duplicateOf;
			lines.push("这是同一请求的重复提交，已返回第一次受理的身份，未重复建卡。");
			if (outcome.cardNo !== undefined) {
				lines.push(`首次受理身份：${identityLine(first ?? outcome)}`);
			} else {
				lines.push(
					"首次身份不可得：受理账里这条判据没有记下卡号（账可能被改坏或卡已被删），请用 pao_inventory 核对现场。",
				);
			}
			lines.push(`首次受理时间：${first?.acceptedAt ?? outcome.acceptedAt}`);
			if (options.stale === true) {
				// §5.4 的同一条纪律也管重复提交：首次那张卡已被停/被重开，
				// 「已返回第一次的身份」就不再等于「它还在跑」——必须当场说清，否则等于用旧身份报成功。
				lines.push(
					"注意：首次那张卡已被停止或重开（旧受理结果不再有效，别把它当成功；以 pao_inventory 的现场为准）。",
				);
			} else if (outcome.dispatched === true) {
				lines.push("首次已提交后台派发；本次没有重复派发，等待首次结果通知。");
			} else if (outcome.dispatched === false) {
				lines.push("首次只建了卡，没有提交后台派发；本次也没有重复派发。");
			} else {
				lines.push(
					"首次派发状态未记录（旧账或受理账补写失败）；本次没有重复派发，必要时查现场，不能据此认定只建了卡。",
				);
			}
			lines.push("本次没有新建卡；如果你要的是新任务，请换一条判据（request_key）。");
			break;
		}
		case "deferred": {
			lines.push(`已受理并建卡，但没有派发：${identityLine(outcome)}`);
			lines.push(`推迟原因：${outcome.reason ?? "原因未记（宿主没给）"}`);
			lines.push("卡已建好但没有派发；按上面的原因解除阻塞后，再用 pao_dispatch_card 派出。");
			break;
		}
		case "rejected": {
			lines.push(
				outcome.cardNo !== undefined || outcome.cardPath !== undefined
					? `受理未完成：已建卡，${identityLine(outcome)}；请核对现场后再处理。`
					: "未受理：没有建卡，卡目录没有新增文件。",
			);
			lines.push(`原因：${outcome.reason ?? "原因未记（受理未给出）"}`);
			break;
		}
	}
	const problems = problemLines(outcome);
	if (problems.length > 0) lines.push(`问题项 ${problems.length} 条：`, ...problems);
	lines.push(keyLine);
	return lines.join("\n");
}

function buildAcceptTaskTool(deps: AcceptTaskToolDeps): ToolDefinition<typeof AcceptTaskParams> {
	return {
		name: "pao_accept_task",
		label: "受理任务",
		description:
			"推荐用 task 提交目标、输入、边界、验收、交付物和实施提示；旧 target/acceptance 写法继续兼容，新旧字段冲突时拒绝。" +
			"一次完成预检、建卡和可选派发。dispatch 缺省 false；dispatch=true 须给 reason。" +
			"已提交后台派发只表示任务已交给派发链，不表示 worker 已启动；等待结果通知。" +
			"同一 request_key 幂等，重复提交不重复建卡。",
		parameters: AcceptTaskParams,
		execute: async (_toolCallId, params: AcceptTaskParamsShape, signal, _onUpdate, ctx) => {
			const cardsDir = params.cards_dir ?? deps.resolveCardsDir();
			const paoHome = deps.resolveHome();
			if (!paoHome) {
				return toolError(
					"受理未执行：缺 PAO_HOME（集中预检要读部门注册表/档位/预算配置，空 home 不跑；请在装配时给 resolvePaoHome 或设 PAO_HOME 环境变量）",
				);
			}
			let task: TaskBook | undefined;
			let fields: { goal: string; acceptance: string; inputs?: string[]; boundaries?: string };
			try {
				if (!params.task && (params.target === undefined || params.target.trim() === "")) {
					// 保持旧入口的受理拒绝口径：形状问题交给 acceptIntake 返回真实 outcome。
					fields = { goal: params.target ?? "", acceptance: params.acceptance ?? "" };
				} else if (!params.task && params.acceptance === undefined) {
					fields = { goal: params.target!, acceptance: "" };
				} else if (params.task) {
					task = normalizeTaskBook(params.task, {
						...(params.target !== undefined ? { goal: params.target } : {}),
						...(params.acceptance !== undefined ? { acceptance: params.acceptance } : {}),
						...(params.inputs !== undefined ? { inputs: params.inputs } : {}),
						...(params.constraints !== undefined ? { boundaries: params.constraints } : {}),
					});
					fields = taskBookFields(task);
				} else {
					fields = legacyTaskFields({
						...(params.target !== undefined ? { goal: params.target } : {}),
						...(params.acceptance !== undefined ? { acceptance: params.acceptance } : {}),
						...(params.inputs !== undefined ? { inputs: params.inputs } : {}),
						...(params.constraints !== undefined ? { boundaries: params.constraints } : {}),
					});
				}
			} catch (error) {
				return toolError(`受理未执行：${(error as Error).message}`);
			}
			const explicitKey = params.request_key?.trim() ?? "";
			const requestKey =
				explicitKey.length > 0
					? explicitKey
					: buildAutoIntakeKey({
							goal: fields.goal,
							dept: params.dept,
							acceptance: fields.acceptance,
							dependsOn: params.depends_on,
						});
			const autoKey = explicitKey.length === 0;
			const dispatch = params.dispatch === true;
			const request: IntakeRequest = {
				// IntakeRequest 的字段是 ASCII 英文契约名；卡片协议的中文 frontmatter 键在 intake 内映射，本层不碰
				idempotencyKey: requestKey,
				goal: fields.goal,
				dept: params.dept,
				acceptance: fields.acceptance,
				...(fields.inputs !== undefined ? { inputs: fields.inputs } : {}),
				...(fields.boundaries !== undefined ? { constraints: fields.boundaries } : {}),
				...(task ? { task } : {}),
				...(params.depends_on !== undefined ? { depends_on: params.depends_on } : {}),
				...(params.tier !== undefined ? { tier: params.tier as CardTier } : {}),
				...(params.budget !== undefined ? { budget: params.budget as CardBudget } : {}),
				...(params.priority !== undefined ? { priority: params.priority as CardPriority } : {}),
				...(params.template !== undefined ? { template: params.template } : {}),
				dispatch,
				...(params.reason !== undefined ? { reason: params.reason } : {}),
			};
			try {
				const report = await acceptIntake(cardsDir, [request], {
					paoHome,
					signal,
					dispatchInBackground: deps.dispatchInBackground,
					resolveTemplate: deps.resolveTemplate ?? templateResolver(paoHome),
					// 会话 id 随派发注入 workflowCheck 做实例 owner 重核（与 pao_dispatch_card 同源）
					...(ctx?.sessionManager?.getSessionId?.()
						? { ownerSession: ctx.sessionManager.getSessionId() as string }
						: {}),
				});
				const outcome = report.outcomes[0];
				if (!outcome) {
					// acceptIntake 一条请求必得一个 outcome；到这里说明契约被破坏，如实报不编造
					return toolError("受理结果缺失：受理入口没有返回任何结果（一条请求应有且仅有一条结果，请查受理模块）");
				}
				// §5.4：停止/重派后旧受理结果不能当成功——只在真的给出身份时才查（没卡就无所谓失效）
				let stale: boolean | undefined;
				if (outcome.cardNo !== undefined || outcome.cardPath !== undefined) {
					try {
						stale = isIntakeOutcomeStale(outcome, cardsDir);
					} catch {
						stale = undefined;
					}
				}
				const text = formatIntakeOutcome(outcome, { cardsDir, autoKey, stale, requestKey });
				return {
					content: [{ type: "text", text }],
					details: {
						status: outcome.status,
						card_no: outcome.cardNo,
						attempt: outcome.attempt,
						request_key: requestKey,
						auto_key: autoKey,
						partial: report.partial,
					},
					// 只有「没受理」才是错误；deferred 是受理成功但没派，不算错误
					isError: outcome.status === "rejected" ? true : undefined,
				};
			} catch (e) {
				return toolError(`受理过程出错：${e instanceof Error ? e.message : String(e)}`);
			}
		},
	};
}
