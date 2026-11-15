/**
 * pao 扇出(卡0007):主控一次把多张卡并行派给一次性 worker。
 *
 * 本文件只导出注册入口与纯库(executor/plan);`src/pao/index.ts` 总入口与
 * `src/extensions/index.ts` 接线行由主控统一写(黑板公共决定 #1)。
 * 停止契约不在此另建:扇出进程全部进 runner 登记册,由 pao_stop_background / session_shutdown
 * 钩子(worker 模块已注册)全停;工具调用被取消时经 runner.cancel 走 R05 顺序。
 *
 * §20 后台模式(2026-10-03):「后台:true」＝派完就走——受理后立即返回受理摘要,
 * 不阻塞等 worker;完成摘要进会话级缓冲,下一轮 before_agent_start 注入
 * `pao-fanout-done` section(消费式;R25 运行态语义:重启归零,真相以卡文件为准)。
 * §21 后台区:注册返回 后台计数() 快照(在途/完成未读),接线层交给 /状态 渲染。
 * waiting 可查复用两件既有面:pao_inventory(在跑进程)/队列(卡终态)。缺省 false
 * 同步扇出行为逐字节不变。R05 不动:后台扇出仍归主会话,session_shutdown 树杀全停。
 */
import { type Static, Type } from "typebox";

import type { ExtensionAPI, ToolDefinition } from "../../core/extensions/types.ts";
import { toastEnabled } from "../host/config.ts";
import { sendToast } from "../notify/toast.ts";
import { executeFanout, type FanoutDispatchInput, type FanoutDispatchOptions, formatFanoutSummary } from "./execute.ts";
import { DEFAULT_FANOUT_CONCURRENCY, planFanout } from "./plan.ts";

export * from "./execute.ts";
export * from "./plan.ts";

/**
 * 后台完成摘要的系统提示段名(before_agent_start 注入面)。
 * 段名只认 ASCII 小写(core SYSTEM_PROMPT_SECTION_NAME 正则,中文段名会让整回合失败);
 * 中文标题「后台完成」写在段内容里。
 */
export const FANOUT_BACKGROUND_SECTION = "pao-fanout-done";

/** §21 后台区运行态快照:在途=已受理未 settle 的后台扇出批次,完成未读=缓冲里待注入的摘要数(R25 重启归零) */
export interface FanoutBackgroundState {
	in_flight: number;
	completed_unread: number;
}

/** pao_fanout 工具的注册配置;风格对齐 CollabToolsOptions,全部路径/依赖注入,不硬编码。 */
export interface FanoutToolsOptions {
	/** 默认卡目录解析;缺省时工具要求调用方显式传 卡目录 参数 */
	resolveCardsDir?: () => string;
	/** 运行器;缺省 = worker 模块 defaultWorkerRunner(与 pao_stop_background 同一登记册) */
	runner?: FanoutDispatchOptions["运行器"];
	/** 回执落卡回调;缺省 = cards 的 appendReceipt(尝试号 = 卡面当前尝试) */
	交回执?: FanoutDispatchOptions["交回执"];
	/** 透传给每次 WorkerRunner.run 的公共参数 */
	公共参数?: FanoutDispatchOptions["公共参数"];
	/** 按卡追加运行参数(按卡注入环境变量/超时等) */
	每卡参数?: FanoutDispatchOptions["每卡参数"];
	resolvePaoHome?: () => string;
}

const fanoutParams = Type.Object({
	card_refs: Type.Array(Type.String(), {
		description: "要扇出的卡引用列表(卡0017/卡#17/17 均可);去重保序,全部入队不丢弃",
	}),
	max_concurrency: Type.Optional(
		Type.Number({ description: `同时运行的 worker 进程上限,默认 ${DEFAULT_FANOUT_CONCURRENCY};超限的卡排队补位` }),
	),
	cards_dir: Type.Optional(
		Type.String({ description: "任务工作区卡目录(内含 卡NNNN-*.md);已配置默认卡目录时可省略" }),
	),
	reason: Type.String({
		description:
			"批量派单理由(必填,trim 后不得为空;派前自省:真的需要额外多派这几个吗)。理由会留痕:每条进程登记表记录与聚合摘要都带此理由,供上级审查。",
	}),
	background: Type.Optional(
		Type.Boolean({
			description:
				"§20 background:true＝派完就走——受理后立即返回受理摘要,不等 worker;完成摘要下一轮自动注入(pao-fanout-done section)。查询:pao_inventory 看在跑进程、/pao queue 看卡状态。缺省 false＝同步等完全部 worker 返回聚合摘要(行为不变)。R05:后台扇出仍归主会话,主会话关闭全停。",
		}),
	),
});

type FanoutParams = Static<typeof fanoutParams>;

/** PAO_HOME 解析(与 worker/index.ts resolveHome 同契约):缺现场环境时 resolvePaoHome 可抛错
 *  (桌面宿主主进程常无 PAO_HOME)——回落「无 home」(缺省值),不把工具/后台链炸成宿主崩溃。 */
function resolveHome(options: FanoutToolsOptions): string | undefined {
	try {
		return options.resolvePaoHome?.() ?? process.env.PAO_HOME?.trim();
	} catch {
		return undefined;
	}
}

function buildFanoutTool(
	options: FanoutToolsOptions,
	recordBackgroundRun: (input: FanoutDispatchInput, toolOptions: FanoutToolsOptions) => void,
): ToolDefinition<typeof fanoutParams> {
	return {
		name: "pao_fanout",
		label: "扇出",
		description:
			"主控扇出:一次把多张卡并行派给一次性 worker(每卡一个子进程,全部进程进登记册,pao_stop_background可全停)。" +
			`并发上限默认 ${DEFAULT_FANOUT_CONCURRENCY},超限的卡排队、前一个完成立刻补位,不拒绝不丢弃。` +
			"逐卡处理:待认领卡先认领进行中(尝试 +1)再拉起;失败卡先转待认领再拉起(点名即重派决定);" +
			"进行中与已终态的卡不重复拉起,在摘要注明原因。" +
			"理由必填(派前自省:真的需要额外多派这几个吗;理由会留痕供上级审查——登记表逐条记录与聚合摘要都带此理由)。" +
			"worker 结构化回执逐卡落卡(卡号+尝试号,不混批);完成后返回聚合摘要:每卡终态(成功/失败/结果未知/取消/未拉起)," +
			"失败按四型给路由建议(与卡片失败分型一致)。" +
			"取消本次工具调用 = 先阻新卡再树杀在跑进程并确认退出(R05);证据与已落回执保留。",
		parameters: fanoutParams,
		execute: async (_toolCallId, params: FanoutParams, signal, _onUpdate, ctx) => {
			// 先卡目录后理由:与既有参数校验顺序一致(缺卡目录的报错优先)
			const cardsDir = params.cards_dir ?? options.resolveCardsDir?.();
			if (!cardsDir) {
				return {
					content: [
						{
							type: "text",
							text: "扇出未执行:缺少 cards_dir 参数,且未配置默认卡目录(FanoutToolsOptions.resolveCardsDir)。",
						},
					],
					details: {},
					isError: true,
				};
			}
			const rationale = params.reason?.trim() ?? "";
			if (!rationale) {
				return {
					content: [
						{
							type: "text",
							text: "扇出未执行:reason 必填(trim 后不得为空;派前自省:真的需要额外多派这几个吗;理由会留痕供上级审查)。",
						},
					],
					details: {},
					isError: true,
				};
			}
			const input: FanoutDispatchInput = {
				卡号列表: params.card_refs,
				并发上限: params.max_concurrency,
				cardsDir,
				理由: rationale,
				// 调用方会话身份随批注入 workflowCheck（owner 重核,与单卡/自动链同源;无会话上下文时缺省）。
				owner: ctx?.sessionManager?.getSessionId?.(),
			};
			// §20 后台模式:派完就走。受理摘要同步算(纯函数 planFanout,不碰盘不拉进程),
			// 执行体 fire-and-forget;完成/异常都进摘要缓冲,下一轮注入。不接工具 signal——
			// 工具调用此刻就返回,取消语义由 runner 树杀承担(session_shutdown/pao_stop_background)。
			if (params.background === true) {
				const plan = planFanout(params.card_refs, params.max_concurrency);
				recordBackgroundRun(input, options);
				return {
					content: [
						{
							type: "text",
							text:
								`后台扇出已受理:${plan.拉起顺序.length} 张卡(并发上限 ${plan.并发上限}，排队补位;保温.json「上游并发上限」若更紧会进一步取小——派发时以生效值为准)` +
								(plan.重复剔除.length > 0 ? `;重复剔除 ${plan.重复剔除.length} 条` : "") +
								`;派单理由:${rationale}。本工具调用到此返回,不等 worker——` +
								"查询:pao_inventory 看在跑进程、/pao queue 看卡状态;完成摘要下一轮自动注入(pao-fanout-done section,运行态通知重启归零,真相以卡文件为准 R25)。" +
								"R05:后台扇出仍归主会话,主会话关闭全停。",
						},
					],
					details: { accepted_cards: plan.拉起顺序.length, max_concurrency: plan.并发上限 },
				};
			}
			try {
				const summary = await executeFanout(input, {
					运行器: options.runner,
					交回执: options.交回执,
					公共参数: options.公共参数,
					每卡参数: options.每卡参数,
					信号: signal,
					paoHome: resolveHome(options),
				});
				return {
					content: [{ type: "text", text: formatFanoutSummary(summary) }],
					details: summary,
					isError: summary.结果.some((result) => result.回执落卡 === "未落卡") ? true : undefined,
				};
			} catch (error) {
				return {
					content: [
						{ type: "text", text: `扇出未执行:${error instanceof Error ? error.message : String(error)}` },
					],
					details: {},
					isError: true,
				};
			}
		},
	};
}

/**
 * 注册扇出工具:pao_fanout(批次规划 → 补位式并发拉起 → 逐卡落回执 → 聚合摘要)。
 * 不自带退出钩子:扇出进程进 runner 登记册,全停由 worker 模块的 pao_stop_background与
 * session_shutdown 钩子承担(同一 runner)。
 * §20 后台模式:完成摘要缓冲在注册闭包(会话级内存态,R25 重启归零),
 * before_agent_start 注入 pao-fanout-done section(消费式:注入即清空)。
 */
export function registerFanout(
	pi: ExtensionAPI,
	options: FanoutToolsOptions = {},
): { backgroundCount: () => FanoutBackgroundState } {
	const backgroundSummary: string[] = [];
	let backgroundInFlight = 0;
	const recordBackgroundRun = (input: FanoutDispatchInput, toolOptions: FanoutToolsOptions): void => {
		backgroundInFlight++;
		void executeFanout(input, {
			运行器: toolOptions.runner,
			交回执: toolOptions.交回执,
			公共参数: toolOptions.公共参数,
			每卡参数: toolOptions.每卡参数,
			paoHome: resolveHome(toolOptions),
		})
			.then((summary) => {
				backgroundSummary.push(formatFanoutSummary(summary));
				// §23 toast①:后台批全部完成/有失败叫人(开关=保温.json「toast 通知」,缺省开;尽力而为)
				void sendToast(
					"PAO 后台扇出完成",
					`成功 ${summary.count.成功},失败 ${summary.count.失败},结果未知 ${summary.count.结果未知},取消 ${summary.count.取消}`,
					{ enabled: toastEnabled(resolveHome(toolOptions)) },
				);
			})
			.catch((error) => {
				const reason = error instanceof Error ? error.message : String(error);
				backgroundSummary.push(`后台扇出失败:${reason}`);
				void sendToast("PAO 后台扇出失败", reason.slice(0, 200), {
					enabled: toastEnabled(resolveHome(toolOptions)),
				});
			})
			.finally(() => {
				backgroundInFlight--;
			});
	};
	pi.registerTool(buildFanoutTool(options, recordBackgroundRun));
	pi.on("before_agent_start", (event) => {
		if (backgroundSummary.length === 0) return;
		const body = backgroundSummary.splice(0).join("\n\n");
		event.systemPromptOptions.sections[FANOUT_BACKGROUND_SECTION] =
			`[pao 后台扇出完成摘要] 以下为后台扇出批的完成通知(运行态,重启归零;卡文件状态与回执是真相,R25):\n${body}`;
	});
	// §21 后台区:/状态 经接线层读此快照(在途/完成未读;会话级内存态,与摘要缓冲同生命周期)
	return { backgroundCount: () => ({ in_flight: backgroundInFlight, completed_unread: backgroundSummary.length }) };
}
