/** 复用原生摘要与会话账本。实验开关默认关闭，不另建摘要引擎。 */
import { randomUUID } from "node:crypto";
import type { Agent, StreamFn } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import { compact } from "../../core/compaction/index.ts";
import { installPrecompactionAdapter } from "../../core/compaction/precompaction.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { SessionManager } from "../../core/session-manager.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { notifySessionUsageChanged } from "../worker/usage-display.ts";
import { redactContext } from "./index.ts";

export function setupPrecompaction(options: {
	enabled: boolean | undefined;
	agent: Agent;
	modelRuntime: ModelRuntime;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
}): void {
	const { agent, modelRuntime, sessionManager, settingsManager } = options;
	// PAO 专属实验开关缺省值在 pao 侧落 env（原名 PAO_PRECOMPACTION＝"1" 启用，缺省关闭），
	// 不散进 core/sdk；SDK 显式选项优先。
	const enabled = options.enabled ?? process.env.PAO_PRECOMPACTION === "1";
	installPrecompactionAdapter(sessionManager, {
		// 无落盘会话没有可在切换后归属的账本；保持原压缩路径，避免漏计迟到费用。
		get enabled() {
			return enabled && Boolean(sessionManager.getSessionFile());
		},
		settings: (model) => settingsManager.getCompactionSettings(model),
		physicalModel: (provider, id) => modelRuntime.getPhysicalModel(provider, id),
		async generate(preparation, model, signal) {
			if (signal.aborted) throw new Error("预压缩已取消");
			const sessionId = sessionManager.getSessionId();
			const sessionFile = sessionManager.getSessionFile();
			const cwd = sessionManager.getCwd();
			const requestId = `${sessionId}:precompaction:${randomUUID()}`;
			const thinkingLevel = clampThinkingLevel(model, agent.state.thinkingLevel);
			// 切会话后仍归原账本，绝不能把迟到的费用记到新会话。
			const ledger = () => {
				if (sessionManager.getSessionId() === sessionId) return sessionManager;
				if (sessionFile) return SessionManager.open(sessionFile, undefined, cwd);
				throw new Error("预压缩原内存会话已切换，费用账本不可写入新会话");
			};
			const stream: StreamFn = async (requestModel, context, requestOptions) => {
				let result: Awaited<ReturnType<StreamFn>>;
				let message: Awaited<ReturnType<Awaited<ReturnType<StreamFn>>["result"]>>;
				try {
					result = await agent.streamFunction(requestModel, context, requestOptions);
					message = await result.result();
				} catch (error) {
					const owner = ledger();
					owner.appendCustomEntry("pao-precompaction-usage-status", {
						requestId,
						status: "请求未返回用量",
						说明: "供应商费用未知，不能按零费用通过收益验收",
					});
					notifySessionUsageChanged(owner);
					throw error;
				}
				// 摘要函数也会读取 result()；此处先读取同一结果，不再次发请求。
				const owner = ledger();
				owner.appendUsage("precompaction", message.provider, message.model, message.usage, requestId);
				if (message.stopReason === "error" || message.stopReason === "aborted") {
					owner.appendCustomEntry("pao-precompaction-usage-status", {
						requestId,
						status: message.stopReason,
						usageReported: message.usage.totalTokens > 0,
						说明: "失败或取消调用的已报告用量照常计入；零用量不能证明供应商未计费",
					});
				}
				notifySessionUsageChanged(owner);
				return result;
			};
			const auth = await modelRuntime.getAuth(model, { signal });
			if (signal.aborted) throw new Error("预压缩已取消");
			if (!auth || (!auth.auth.apiKey && !auth.auth.headers)) throw new Error("预压缩供应商认证不可用");
			const headers = auth.auth.headers
				? Object.fromEntries(
						Object.entries(auth.auth.headers).filter((entry): entry is [string, string] => entry[1] !== null),
					)
				: undefined;
			return compact(
				preparation,
				auth.auth.baseUrl ? { ...model, baseUrl: auth.auth.baseUrl } : model,
				auth.auth.apiKey,
				headers,
				undefined,
				signal,
				thinkingLevel,
				stream,
				auth.env,
				settingsManager.getRetrySettings(),
				undefined,
				requestId,
			);
		},
		recordStatus(sessionId, status, error) {
			// 状态不是费用；切换后丢弃的任务不向新会话写入状态。
			if (sessionManager.getSessionId() !== sessionId) return;
			if (status.includes("费用未知")) {
				sessionManager.appendCustomEntry("pao-precompaction-usage-status", {
					status: "请求未返回用量",
					说明: status,
				});
				notifySessionUsageChanged(sessionManager);
			}
			sessionManager.appendCustomEntry("pao-precompaction-status", {
				status,
				...(error ? { error: String(redactContext(error)).slice(0, 500) } : {}),
			});
		},
	});
}
