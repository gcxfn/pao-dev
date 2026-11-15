import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { addPaoSubcommand } from "../command-router.ts";
import { resolvePaoRole } from "../role.ts";
import { parseRequestBudget, REQUEST_BUDGET_ENV } from "./request-config.ts";
import { acquireSessionControl, type SessionControl } from "./session-lock.ts";

export { parseRequestBudget, REQUEST_BUDGET_ENV } from "./request-config.ts";

interface RuntimeControl {
	acquire(ctx: ExtensionContext, takeoverToken?: string): Promise<void>;
	check(ctx: ExtensionContext): void;
	release(): Promise<void>;
}
const controls = new WeakMap<ExtensionAPI, RuntimeControl>();

/** 同一扩展实例一份 owner；桌面多 tab 不共享控制权或关闭动作。 */
export function registerRuntimeControls(
	pi: ExtensionAPI,
	options: {
		resolvePaoHome: () => string;
		env?: NodeJS.ProcessEnv;
	},
): void {
	const env = options.env ?? process.env;
	const raw = env[REQUEST_BUDGET_ENV];
	if (raw !== undefined) {
		// 这里只校验；真实计次在 ModelRuntime 的 HTTP fetch，避免轮次与 HTTP 重复计费。
		try {
			parseRequestBudget(raw);
		} catch (error) {
			pi.on("before_provider_request", (_event, ctx) => {
				ctx.abort();
				throw error;
			});
			pi.on("tool_call", () => ({ block: true, reason: `请求额度配置无效：${String(error)}` }));
		}
	}
	if (resolvePaoRole(env) !== "主控") return;
	let owner: SessionControl | undefined;
	let problem = "尚未取得会话控制权";
	const state: RuntimeControl = {
		async acquire(ctx, takeoverToken) {
			const sessionId = ctx.sessionManager.getSessionId();
			if (owner?.owner.sessionId === sessionId) {
				owner.assertOwned();
				return;
			}
			await state.release();
			try {
				owner = await acquireSessionControl({
					paoHome: options.resolvePaoHome(),
					sessionId,
					surface: env.PAO_RUNTIME_SURFACE ?? "terminal",
					takeoverToken,
				});
				problem = "";
			} catch (error) {
				problem = String(error);
				throw error;
			}
		},
		check(ctx) {
			if (!owner || owner.owner.sessionId !== ctx.sessionManager.getSessionId())
				throw new Error(problem || "会话控制权不匹配");
			owner.assertOwned();
		},
		async release() {
			if (owner) {
				await owner.release();
				owner = undefined;
			}
		},
	};
	controls.set(pi, state);
	pi.on("session_start", async (_event, ctx) => {
		try {
			await state.acquire(ctx);
		} catch (error) {
			ctx.ui.notify(`会话只读：${String(error)}；残锁可用 /pao runtime takeover <原控制标识> 显式接管。`, "error");
		}
	});
	pi.on("before_provider_request", (_event, ctx) => {
		try {
			state.check(ctx);
		} catch (error) {
			ctx.abort();
			throw error;
		}
	});
	pi.on("tool_call", (_event, ctx) => {
		try {
			state.check(ctx);
		} catch (error) {
			return { block: true, reason: String(error) };
		}
	});
	pi.on("session_shutdown", () => state.release());
	addPaoSubcommand(pi, {
		name: "runtime",
		label: "会话控制",
		description: "查看控制权或显式接管残留会话锁",
		async run(api, args, rawContext) {
			const ctx = rawContext as ExtensionContext;
			const control = controls.get(api);
			if (!control) throw new Error("此会话没有交互控制入口");
			const parts = args.trim().split(/\s+/);
			if (parts[0] === "takeover" && parts.length === 2) await control.acquire(ctx, parts[1]);
			else if (args.trim()) throw new Error("用法：/pao runtime 或 /pao runtime takeover <原控制标识>");
			control.check(ctx);
			ctx.ui.notify("本会话控制权有效", "info");
		},
	});
}
