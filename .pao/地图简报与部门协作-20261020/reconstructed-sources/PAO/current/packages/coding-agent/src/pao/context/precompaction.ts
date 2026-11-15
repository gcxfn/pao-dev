/** S4：单一路径的后台预压缩。默认关闭，只有兼容的已完成摘要可替代原生压缩。 */
import { createHash } from "node:crypto";
import { type CompactionResult, prepareCompaction } from "../../core/compaction/index.ts";
import type { PrecompactionAdapter } from "../../core/compaction/precompaction.ts";
import { getPrecompactionAdapter } from "../../core/compaction/precompaction.ts";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import type { ReadonlySessionManager, SessionEntry } from "../../core/session-manager.ts";

export interface PrecompactionIdentity {
	sessionId: string;
	model: string;
	entries: readonly SessionEntry[];
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

interface Candidate {
	identity: { sessionId: string; model: string; prefix: string; length: number };
	controller: AbortController;
	result?: CompactionResult;
}

export class PrecompactionCoordinator {
	private candidate?: Candidate;
	private lastStarted?: string;
	version = 0;
	lastOutcome: "未开始" | "生成中" | "就绪" | "已应用" | "已丢弃" | "失败回原路径" = "未开始";
	lastError?: string;

	start(identity: PrecompactionIdentity, generate: (signal: AbortSignal) => Promise<CompactionResult>): Promise<void> {
		const prefix = digest(identity.entries);
		const key = `${identity.sessionId}:${identity.model}:${prefix}`;
		if (this.candidate || this.lastStarted === key) return Promise.resolve();
		this.lastStarted = key;
		this.version++;
		const candidate: Candidate = {
			identity: { sessionId: identity.sessionId, model: identity.model, prefix, length: identity.entries.length },
			controller: new AbortController(),
		};
		this.candidate = candidate;
		this.lastOutcome = "生成中";
		this.lastError = undefined;
		return Promise.resolve()
			.then(() => generate(candidate.controller.signal))
			.then((result) => {
				if (this.candidate !== candidate || candidate.controller.signal.aborted) return;
				candidate.result = result;
				this.lastOutcome = "就绪";
			})
			.catch((error: unknown) => {
				if (this.candidate !== candidate) return;
				this.candidate = undefined;
				this.lastOutcome = candidate.controller.signal.aborted ? "已丢弃" : "失败回原路径";
				this.lastError = error instanceof Error ? error.message : String(error);
			});
	}

	consume(identity: PrecompactionIdentity, tokensBefore: number): CompactionResult | undefined {
		const candidate = this.candidate;
		if (!candidate) return;
		const start = candidate.identity;
		const tail = identity.entries.slice(start.length);
		const compatible =
			identity.sessionId === start.sessionId &&
			identity.model === start.model &&
			identity.entries.length >= start.length &&
			digest(identity.entries.slice(0, start.length)) === start.prefix &&
			!tail.some(
				(entry) =>
					["compaction", "context_edit", "model_change", "thinking_level_change", "branch_summary"].includes(
						entry.type,
					) ||
					(entry.type === "message" && entry.message.role === "system"),
			);
		const result = candidate.result;
		if (!compatible || !result || !identity.entries.some((entry) => entry.id === result.firstKeptEntryId)) {
			this.cancel();
			return;
		}
		this.candidate = undefined;
		this.lastOutcome = "已应用";
		// 生成调用已单独记 usage；应用摘要不得再计一次。旧 firstKept 边界保留新增尾部。
		const { usage: _usage, ...rest } = result;
		return { ...rest, tokensBefore };
	}

	cancel(): void {
		this.version++;
		if (this.candidate) this.lastOutcome = "已丢弃";
		this.candidate?.controller.abort();
		this.candidate = undefined;
	}
}

/** SDK 提供既有摘要生成与账本适配器；扩展只安排时机，不建第二摘要方法。 */
export function registerPrecompaction(pi: ExtensionAPI): void {
	const coordinator = new PrecompactionCoordinator();
	const inFlight = new Set<Promise<void>>();
	let modelIdentity = "";
	let boundAdapter: PrecompactionAdapter | undefined;
	let boundStop: (() => Promise<void>) | undefined;
	const cancel = () => coordinator.cancel();
	const stopAndDrain = async (manager: ReadonlySessionManager) => {
		// Capture ownership before yielding; extension contexts become stale during reload.
		const adapter = getPrecompactionAdapter(manager);
		const sessionId = manager.getSessionId();
		cancel();
		if (inFlight.size === 0) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const drained = await Promise.race([
			Promise.allSettled([...inFlight]).then(() => true),
			new Promise<false>((resolve) => {
				timer = setTimeout(() => resolve(false), 5000);
			}),
		]);
		if (timer) clearTimeout(timer);
		if (!drained) adapter?.recordStatus(sessionId, "取消等待超时，费用未知");
	};
	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			await stopAndDrain(ctx.sessionManager);
		} finally {
			if (boundAdapter && boundAdapter.stopAndDrain === boundStop) delete boundAdapter.stopAndDrain;
			boundAdapter = undefined;
			boundStop = undefined;
		}
	});
	pi.on("session_before_switch", (_event, ctx) => stopAndDrain(ctx.sessionManager));
	pi.on("session_before_tree", cancel);
	pi.on("session_tree", cancel);
	pi.on("model_select", cancel);
	pi.on("thinking_level_select", cancel);
	pi.on("agent_end", (_event, ctx) => {
		if (ctx.signal?.aborted) cancel();
	});
	pi.on("turn_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		if (event.message.stopReason === "aborted" || ctx.signal?.aborted) {
			cancel();
			return;
		}
		const adapter = getPrecompactionAdapter(ctx.sessionManager);
		if (!adapter?.enabled) return;
		const manager = ctx.sessionManager;
		boundAdapter = adapter;
		boundStop = () => stopAndDrain(manager);
		adapter.stopAndDrain = boundStop;
		const model = adapter.physicalModel(event.message.provider, event.message.model);
		if (!model) return;
		const settings = adapter.settings(model);
		const threshold = model.contextWindow - settings.reserveTokens;
		const usage = event.message.usage;
		const tokens =
			usage?.totalTokens ||
			(usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
		if (!settings.enabled || threshold <= 0 || tokens < threshold * 0.85 || tokens >= threshold) return;
		const entries = structuredClone(ctx.sessionManager.getBranch());
		const preparation = prepareCompaction(entries, settings);
		if (!preparation) return;
		// 首跑清单是用户面板，预压缩同样不得外发；不运行普通压缩hook以免提早改变其任务快照。
		preparation.messagesToSummarize = preparation.messagesToSummarize.filter(
			(message) => message.role !== "custom" || message.customType !== "pao-firstrun",
		);
		preparation.turnPrefixMessages = preparation.turnPrefixMessages.filter(
			(message) => message.role !== "custom" || message.customType !== "pao-firstrun",
		);
		modelIdentity = `${ctx.model?.provider}/${ctx.model?.id}:${ctx.thinkingLevel}:${model.provider}/${model.id}`;
		const identity = { sessionId: ctx.sessionManager.getSessionId(), model: modelIdentity, entries };
		const pending = coordinator.start(identity, (signal) => adapter.generate(preparation, model, signal));
		inFlight.add(pending);
		const version = coordinator.version;
		const onAbort = () => {
			if (coordinator.version === version) cancel();
		};
		const signal = ctx.signal;
		signal?.addEventListener("abort", onAbort, { once: true });
		void pending
			.then(() => {
				if (coordinator.version === version)
					adapter.recordStatus(identity.sessionId, coordinator.lastOutcome, coordinator.lastError);
			})
			.finally(() => {
				signal?.removeEventListener("abort", onAbort);
				inFlight.delete(pending);
			});
	});
	pi.on("session_before_compact", (event, ctx) => {
		const adapter = getPrecompactionAdapter(ctx.sessionManager);
		if (!adapter?.enabled || event.reason === "manual" || event.customInstructions || event.signal.aborted) {
			cancel();
			return;
		}
		const prefix = `${ctx.model?.provider}/${ctx.model?.id}:${ctx.thinkingLevel}:`;
		if (!modelIdentity.startsWith(prefix)) {
			cancel();
			return;
		}
		const previousOutcome = coordinator.lastOutcome;
		const result = coordinator.consume(
			{ sessionId: ctx.sessionManager.getSessionId(), model: modelIdentity, entries: event.branchEntries },
			event.preparation.tokensBefore,
		);
		// lastOutcome 是历史状态；无候选的原生压缩不能重复登记上次应用。
		if (result || coordinator.lastOutcome !== previousOutcome)
			adapter.recordStatus(ctx.sessionManager.getSessionId(), coordinator.lastOutcome, coordinator.lastError);
		return result ? { compaction: result } : undefined;
	});
}
