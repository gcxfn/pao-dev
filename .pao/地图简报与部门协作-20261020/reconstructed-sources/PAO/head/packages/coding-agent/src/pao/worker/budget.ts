import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "../../core/extensions/types.ts";
import { writeRawStdout } from "../../core/output-guard.ts";
import { setAuxiliaryRequestGuard } from "../../core/provider-request-hooks.ts";
import type { ReadonlySessionManager } from "../../core/session-manager.ts";
import { validateCardBudget } from "../cards/cardfile.ts";
import { parseJsonRaw } from "../shared/json.ts";
import { logWarn } from "../shared/log.ts";
import { nativeUsageTotals } from "./native-usage.ts";
import { absorbEvent, createEventState } from "./receipt.ts";

/** 摘要请求不经过普通 agent onPayload，SDK 在共用 stream 入口查同一预算口（门本体在 core/provider-request-hooks.ts 注册表）。 */
export { assertAuxiliaryRequestBudget } from "../../core/provider-request-hooks.ts";

export const WORKER_BUDGET_ENV = "PAO_WORKER_BUDGET";
/** R40 全角色通用预算 env 名:优先于 PAO_WORKER_BUDGET(兼容回落,既有注入不动) */
export const SESSION_BUDGET_ENV = "PAO_SESSION_BUDGET";

/** 交回执工具名:预算提醒轮里唯一放行的工具(回执通道不许被预算掐死) */
const RECEIPT_TOOL = "pao_submit_receipt";

/**
 * 会话预算门禁(R40):turns/toolCalls/cost 三口执行前检查,超限阻止后续请求/工具执行。
 * 全角色通用——主控/部长/worker 会话同一份门禁,env 未设时零行为。
 *
 * 催回执状态机(R40「进程活时最多预算内提醒一次」):
 * - turns/cost 首次到线(且已发生过至少一次真实请求)且本会话未交过回执 → 不立即停,
 *   放行恰好一轮后续请求作提醒轮:期间除 pao_submit_receipt 外的工具一律拒(拒因即预算内唯一提醒,
 *   模型可见);交回执工具放行并记账「已交回执」。
 * - 提醒轮后再到线(第二次)或已交过回执后到线 → 到线即停(与原语义一致)。
 * - toolCalls 到线同路径:第 N+1 次工具执行被拒(拒因=提醒),若因此进入提醒轮,
 *   模型仍可在放行的一轮里输出最终回执;再犯即停。
 * - 零请求会话(turns:0)不给提醒轮——没有可提醒的对象,首请求前即停。
 * - 成本口径不变:只能依据已返回费用决定是否继续,缺用量轮次按 cost 保守;提醒轮是
 *   回执完整性例外(交不出回执的代价大于一轮成本),如实计入请求与用量。
 */
export function registerSessionBudget(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
	const raw = env[SESSION_BUDGET_ENV] ?? env[WORKER_BUDGET_ENV];
	if (!raw) return;
	const envName = env[SESSION_BUDGET_ENV] ? SESSION_BUDGET_ENV : WORKER_BUDGET_ENV;
	let parsed: unknown;
	try {
		parsed = parseJsonRaw(raw);
	} catch (error) {
		const reason = `${envName} 不是合法 JSON，拒绝模型请求：${(error as Error).message}`;
		logWarn(`[pao] ${reason}`);
		pi.on("session_start", (_event, ctx) => {
			setAuxiliaryRequestGuard(ctx.sessionManager, () => {
				throw new Error(reason);
			});
		});
		pi.on("before_provider_request", (_event, ctx) => {
			ctx.abort();
			throw new Error(reason);
		});
		return;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("会话预算须为 JSON 对象");
	const budget = validateCardBudget(parsed);
	if (!budget) return;
	const state = createEventState();
	let requests = 0;
	let toolCalls = 0;
	let exhausted = "";
	let reminded = false; // 预算内提醒全局最多一次
	let reminderRoundApproved = false; // 提醒轮的额外 provider 请求恰好放行一次
	let deliveredReceipt = false; // 见过 pao_submit_receipt 被放行的调用(近似口径:调用即记账,回执有效性由 runner 侧核对)
	let baseline = new Set<string>();
	const reason = (manager: ReadonlySessionManager): string | undefined => {
		const native = nativeUsageTotals(manager.getEntries().filter((entry) => !baseline.has(entry.id)));
		if (exhausted) return exhausted;
		if (budget.turns !== undefined && Math.max(requests, state.用量.turns) >= budget.turns) return "turns";
		if (budget.cost !== undefined && (native.unknown > 0 || native.usage.cost >= budget.cost)) return "cost";
		return undefined;
	};
	pi.on("session_start", (_event, ctx) => {
		baseline = new Set(ctx.sessionManager.getEntries().map((entry) => entry.id));
		requests = 0;
		toolCalls = 0;
		exhausted = "";
		reminded = false;
		reminderRoundApproved = false;
		deliveredReceipt = false;
		Object.assign(state, createEventState());
		const manager = ctx.sessionManager;
		setAuxiliaryRequestGuard(manager, () => {
			const field = reason(manager);
			if (field) throw new Error(`会话预算耗尽：${field}（辅助摘要不使用回执提醒例外）`);
		});
	});
	const abort = (ctx: ExtensionContext, field: string): void => {
		if (!exhausted) {
			exhausted = field;
			writeRawStdout(`${JSON.stringify({ type: "pao_worker_budget_exhausted", field, requests, toolCalls })}\n`);
		}
		// ctx.abort() 只发取消信号，不等待当前回调，避免等待自己结束。
		ctx.abort();
	};
	pi.on("message_end", (event) => {
		absorbEvent(state, JSON.stringify(event));
	});
	pi.on("turn_start", (_event, ctx) => {
		const field = reason(ctx.sessionManager);
		if (field) {
			// 首次到线且未交回执且已有进度(至少一次请求/轮次)→进提醒轮(本轮放行);
			// 零进度会话(turns:0)无可提醒对象,到线即停,不替预算外的首轮放行。
			const hadProgress = requests > 0 || state.用量.turns > 0;
			if (!reminded && !deliveredReceipt && hadProgress) reminded = true;
			else abort(ctx, field);
		}
	});
	pi.on("before_provider_request", (_event, ctx) => {
		const field = reason(ctx.sessionManager);
		if (field) {
			// 提醒轮:放行恰好一次额外请求(turns:0 的零请求会话无可提醒,不给)
			if (reminded && !reminderRoundApproved && !deliveredReceipt && requests > 0) {
				reminderRoundApproved = true;
				requests++;
				return;
			}
			abort(ctx, field);
			throw new Error(`会话预算耗尽：${field}`);
		}
		requests++;
	});
	pi.on("tool_call", (event: ToolCallEvent, ctx) => {
		if (event.toolName === RECEIPT_TOOL) {
			deliveredReceipt = true;
			return undefined;
		}
		let field =
			exhausted || (budget.toolCalls !== undefined && toolCalls >= budget.toolCalls ? "toolCalls" : undefined);
		if (!field && reminded && !deliveredReceipt) field = "提醒轮"; // 提醒轮内非回执工具一律拒(turns-only 预算也拦)
		if (field) {
			if (!reminded && !deliveredReceipt) {
				// 预算内唯一提醒:拒因即提醒文本(模型可见),本轮起只许交回执/输出结论
				reminded = true;
				return {
					block: true,
					reason: `预算已到线:${field}——禁止再调用工具,立即输出最终回执/结论(预算内唯一提醒;pao_submit_receipt 仍可用)`,
				};
			}
			abort(ctx, field);
			return { block: true, reason: `会话预算耗尽:${field}(提醒已用过,停止)` };
		}
		toolCalls++;
		return undefined;
	});
}
