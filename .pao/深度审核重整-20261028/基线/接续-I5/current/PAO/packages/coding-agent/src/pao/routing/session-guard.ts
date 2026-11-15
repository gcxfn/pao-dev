/**
 * 档位失注册守卫(M1-04:恢复会话时虚拟模型丢失,不静默回退)。
 *
 * pi 的原生行为(virtual-models.md):会话分支记录的虚拟选择在恢复时若虚拟模型已不在
 * 注册表,该选择「不成立」,回退到最后一次作答的物理模型——不报错、不提示。对 pao 来说
 * 这正是「沿底层默认悄悄绕过 PAO 规则」要防的场景:档位配置被删/改名后,恢复的会话
 * 表面上还在干活,实际已经脱离档位路由(思考档推荐、换模型只改配置全部失效)。
 *
 * 本守卫在 session_start 扫会话分支的 model_change 条目:凡指向本配置 provider 下
 * 已不存在的档位名,发一条结构化警告(stderr),说明回退到了哪个物理模型、如何恢复。
 * 回退本身不动(那是 pi 的安全网,物理模型正是该档位此前路由到的模型,不算「变笨」),
 * 但必须可见,不许静默。
 */

import type { ExtensionContext } from "../../core/extensions/types.ts";
import type { ModelChangeEntry, SessionEntry } from "../../core/session-manager.ts";
import { logWarn } from "../shared/log.ts";
import type { TierConfig } from "./config.ts";

/** 从会话分支收集「指向已不存在档位」的 model_change 条目(按出现顺序,去重) */
export function findLostTierSelections(
	branch: readonly SessionEntry[],
	config: TierConfig,
): { provider: string; modelId: string }[] {
	const known = new Set(config.档位.map((tier) => tier.名));
	const lost: { provider: string; modelId: string }[] = [];
	const seen = new Set<string>();
	for (const entry of branch) {
		if (entry.type !== "model_change") continue;
		const change = entry as ModelChangeEntry;
		if (change.provider !== config.provider) continue;
		if (known.has(change.modelId) || seen.has(change.modelId)) continue;
		seen.add(change.modelId);
		lost.push({ provider: change.provider, modelId: change.modelId });
	}
	return lost;
}

/** 生成给用户看的警告文本(含档位名、现有档位、回退说明与恢复动作) */
export function formatLostTierWarning(lost: readonly { modelId: string }[], config: TierConfig): string {
	const inPlace = config.档位.map((tier) => tier.名).join("、");
	return (
		`[pao] 本会话此前选用的档位「${lost.map((entry) => entry.modelId).join("」「")}」` +
		`已不在当前档位配置(${inPlace})中,恢复时回退到了最后作答的物理模型——` +
		`该模型仍是此前档位路由的目标,但思考档推荐与换模型只改配置已失效。` +
		`请尽快用 /model 重新选档,或修正 $PAO_HOME/pao配置/档位.json 后 /reload。`
	);
}

/**
 * 注册失注册守卫:session_start 时扫分支,发现指向已失效档位的选择即发警告。
 * 走 logWarn(stderr):TUI 与 headless(--mode json -p)下都可见,不依赖 UI 上下文。
 */
export function registerTierLossGuard(
	pi: { on(event: "session_start", handler: (event: unknown, ctx: ExtensionContext) => void): void },
	config: TierConfig,
): void {
	pi.on("session_start", (_event, ctx) => {
		try {
			const branch = ctx.sessionManager.getBranch();
			const lost = findLostTierSelections(branch, config);
			if (lost.length > 0) logWarn(formatLostTierWarning(lost, config));
		} catch {
			// 守卫只增可见性,读不到分支时绝不影响会话启动
		}
	});
}
