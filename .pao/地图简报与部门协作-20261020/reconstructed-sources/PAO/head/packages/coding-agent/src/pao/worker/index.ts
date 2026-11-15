/**
 * PAO worker 注册入口(headless worker 工具面;架构 §1 后台运行契约 / R05)。
 *
 * T04 拆分后本文件只保留:四个工具(pao_inventory/pao_stop_background/pao_dispatch_card/pao_terminate_card)的构建
 * 与 registerWorkerTools 装配;进程生命周期在 lifecycle.ts,静默扫描在 silence.ts,
 * 后台派卡通知面在 notify.ts,停止原语在 runner.ts/kill.ts——本文件不另建停止机制。
 * 注册面:主控/部长共用(worker 角色在 role.ts WORKER_SKIPPED_MODULES 整模块跳过)——
 * pao_dispatch_card 与 pao_fanout(主控专属)不同,部长也须能派本部门卡(单卡派发,配额与权限见 dispatch-core)。
 */

import { join, resolve } from "node:path";

import { type Static, Type } from "typebox";

import type { ExtensionAPI, ToolDefinition } from "../../core/extensions/types.ts";
import { parseCardRef, readCard, routeFailure } from "../cards/index.ts";
import { DEFAULT_WORKER_SILENCE_MINUTES, readWorkerSilenceMinutes } from "../host/config.ts";
import {
	defaultMinisterHost,
	globalHotSessionLimit,
	type MinisterHost,
	renderMinisterInventoryLine,
} from "../host/index.ts";
import { nowString } from "../shared/time.ts";
import { resolveWorkflowDispatch } from "../workflow/dispatch-context.ts";
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
export * from "./usage.ts";
export * from "./usage-display.ts";

import { PaoWorkerError } from "./errors.ts";
import { type InventoryReport, inventory } from "./inventory.ts";
import { defaultWorkerRunner, installExitHooks } from "./lifecycle.ts";
import { createDispatchNotifySurface, type DispatchNotifyEvent, type DispatchNotifySurface } from "./notify.ts";
import type { WorkerReceipt, WorkerUsage } from "./receipt.ts";
import type { ProcessEntry } from "./registry.ts";
import type { StopProof, WorkerRunner, WorkerRunOptions } from "./runner.ts";
import { createSilenceReminder } from "./silence.ts";

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
function formatDispatchResult(outcome: DispatchOutcome, receipt: WorkerReceipt): string {
	const lines = [
		`派单完成:卡${outcome.cardNo}〔${outcome.finalState}〕${outcome.attempt !== undefined ? `尝试 ${outcome.attempt}` : ""}(部门 ${outcome.dept ?? "无"})`,
		`派单理由:${outcome.reason}`,
		`owner:${outcome.operator}(认领走状态机:无主卡由派单者认领,有主卡须 owner 本人)`,
	];
	const failureType = classifyWorkerFailure(receipt);
	if (failureType) {
		const route = routeFailure(failureType);
		lines.push(`失败类型:${failureType} → ${route.建议动作}(${route.说明})`);
	}
	// S5 包4 四写法②：任务态标签路由——标签→处理动作对照,办完即停不忙等
	if (receipt.任务态) lines.push(taskStateRoutingLine(receipt.任务态));
	// S5 包2 派发告警:工具表外名截严/仓内技能未确认被忽略等——忽略不等于静默,须点名
	if (receipt.派发告警?.length) lines.push(`派发告警:${receipt.派发告警.join(";")}`);
	if (outcome.summary) lines.push(`摘要:${outcome.summary.split("\n")[0]}`);
	if (outcome.evidencePath) lines.push(`证据:${outcome.evidencePath}`);
	if (outcome.claimBaseline) {
		lines.push(
			outcome.claimBaseline.可用
				? `认领基线:快照已落 ${outcome.claimBaseline.快照路径}(既有 ${outcome.claimBaseline.既有条目数} 条不计 worker 的账)`
				: `认领基线:不可用——${outcome.claimBaseline.原因 ?? "原因未记"}(越界比对无基线,边界如实标注)`,
		);
	}
	if (outcome.receiptNote) lines.push(outcome.receiptNote);
	return lines.join("\n");
}

const DispatchParams = Type.Object({
	card_ref: Type.String({ description: "card_ref(卡0017/卡#17/17 均可)" }),
	reason: Type.String({
		description:
			"派单理由(必填,trim 后不得为空;派前自省:真的需要额外多派一个吗)。理由会留痕:进程登记表记录与工具回执都带此理由,供上级审查。",
	}),
	cards_dir: Type.Optional(
		Type.String({ description: "cards_dir:任务工作区卡目录(内含 卡NNNN-*.md);已配置默认卡目录时可省略" }),
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
) => void;

function buildDispatchTool(
	host: MinisterHost,
	deps: { dispatchInBackground: DispatchInBackground; resolveCardsDir: () => string },
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
	workspace: Type.String({ description: "workspace:任务工作区路径(内含 卡/ 目录);project_root 缺省取工作区上两级" }),
	project_root: Type.Optional(Type.String({ description: "project_root:目标项目根,缺省 = 工作区/../.." })),
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
			lines.push(`  · 卡${card.卡号}〔${card.状态}〕尝试 ${card.尝试} 次:${card.目标}`);
			for (const line of card.最后回执摘要.split("\n")) lines.push(`    ${line}`);
		}
	}
	lines.push(...formatProcessLines(processes));
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
	lines.push(
		report.git.可用
			? `- git(${report.git.分支 ?? "?"}@${report.git.head ?? "?"}):${report.git.汇总}`
			: `- git:${report.git.汇总}`,
	);
	if (report.git.原因) lines.push(`  原因:${report.git.原因}`);
	return lines.join("\n");
}

function buildInventoryTool(runner: WorkerRunner, host: MinisterHost): ToolDefinition<typeof InventoryParams> {
	return {
		name: "pao_inventory",
		label: "只读盘点",
		description:
			"重启只读盘点:扫任务工作区 卡/ 目录列未完卡(状态+尝试数+最后回执摘要),列本轮登记表后台进程(部门+派单理由,供上级监督审查)与热部长会话行(pid/轮次/调用/指纹/活性标记,定案11),并对开工基线做 git status 差异摘要。绝不写文件、不清锁、不重跑——盘点结果供人决定重派或作废。",
		parameters: InventoryParams,
		execute: async (_toolCallId, params) => {
			const report = await inventory({ 工作区: params.workspace, 项目根: params.project_root });
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

function buildStopTool(runner: WorkerRunner): ToolDefinition<typeof StopParams> {
	return {
		name: "pao_stop_background",
		label: "停后台",
		description:
			"停止本轮登记在案的全部后台 worker 进程(树杀并等真退出),之后不再派发。只处理登记在案的进程,不按进程名全局清理;返回已停进程清单。",
		parameters: StopParams,
		execute: async () => {
			const proof = await runner.stopAll();
			const text =
				proof.stoppedProcesses.length === 0
					? "无运行中的后台 worker,未停任何进程;本轮已封锁再派发。"
					: `已停 ${proof.stoppedProcesses.length} 个进程:${proof.stoppedProcesses
							.map((p) => `pid=${p.pid}${p.卡号 ? `(卡${p.卡号})` : ""} ${p.方式}`)
							.join(";")}`;
			return { content: [{ type: "text", text }], details: {} };
		},
	};
}

export interface RegisterWorkerToolsOptions {
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
	const notifySurface = options.notifySurface ?? createDispatchNotifySurface({ resolvePaoHome: resolveHome });
	const inFlight = new Map<string, InFlightDispatch>();

	const dispatchInBackground: DispatchInBackground = (input, dispatchOptions, key, cardNo, ownerSession) => {
		const startedAt = Date.now();
		const done = (async (): Promise<void> => {
			try {
				const dispatched = await executeDispatch(
					input,
					{
						运行器: runner,
						paoHome: resolveHome(),
						// 工作流派发校验（T02 装配注入,T03 owner 收口）:准备期解析+锁后重核同源,
						// owner=调用方会话 id——单卡派工作流卡与自动链/扇出同判（实例/轮次/owner/暂停/冻结版本）。
						workflowCheck: (card) =>
							resolveWorkflowDispatch(card, {
								cardsDir: input.cardsDir,
								paoHome: resolveHome(),
								owner: ownerSession,
							}),
						...dispatchOptions,
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
						const outcome: DispatchOutcome = {
							cardNo: String(claimed.card.card_no).padStart(4, "0"),
							finalState: reportedReceipt.status,
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
					notifySurface.notify(
						`[派卡被拒] 卡${cardNo}:${dispatched.原因}(派单理由:${input.dispatch_reason ?? ""})`,
						"PAO 派卡被拒",
						`卡${cardNo}:${dispatched.原因}`,
					);
					return;
				}
				const finalState = (dispatched.result.details as { finalState?: string } | undefined)?.finalState;
				notifySurface.notify(
					`[派卡完成] 卡${cardNo}${finalState ? `(${finalState})` : ""}\n${dispatched.result.content[0]?.text ?? ""}`,
					"PAO 派卡完成",
					`卡${cardNo}${finalState ? `(${finalState})` : ""}——详情见派卡通知`,
				);
			} catch (e) {
				const reason = e instanceof Error ? e.message : String(e);
				// 护栏拒绝(PaoWorkerError「无效参数」:部门/共享名额、双跑等)与真失败分开口径——
				// 被拒＝改参数/换卡可再试,失败＝执行过程出错须人工看;通知前缀与 toast 标题随之。
				const refused = e instanceof PaoWorkerError && e.code === "无效参数";
				notifySurface.notify(
					`${refused ? "[派卡被拒]" : "[派卡失败]"} 卡${cardNo}:${reason}(派单理由:${input.dispatch_reason ?? ""})`,
					refused ? "PAO 派卡被拒" : "PAO 派卡失败",
					`卡${cardNo}:${reason}`,
				);
			} finally {
				inFlight.delete(key);
			}
		})();
		inFlight.set(key, { cardNo, done });
	};

	pi.registerTool(buildInventoryTool(runner, host));
	pi.registerTool(buildStopTool(runner));
	pi.registerTool(buildDispatchTool(host, { dispatchInBackground, resolveCardsDir }));
	pi.registerTool(buildTerminateTool(runner, { resolveCardsDir, inFlight }));

	// 完成通知注入面(notify.ts;消费式:注入即清空;fanout 后台摘要同款)
	pi.on("before_agent_start", (event: DispatchNotifyEvent) => {
		notifySurface.inject(event);
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
	pi.on("session_shutdown", async () => {
		silenceReminder.stop();
		await Promise.allSettled([runner.stopAll(), host.stopAll("主会话关闭全停")]);
		disposeExitHooks();
	});

	return {
		backgroundCount: () => ({ inFlight: inFlight.size, unread: notifySurface.unreadCount() }),
		waitForBackground: async () => {
			await Promise.all([...inFlight.values()].map((item) => item.done));
		},
	};
}
