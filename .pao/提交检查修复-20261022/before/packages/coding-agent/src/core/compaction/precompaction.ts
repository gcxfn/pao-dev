/** 会话级后台预压缩的中性注册表：core 只持安装/查询/取消口，装配与摘要业务由扩展侧（pao）注入。 */
import type { Agent } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "../model-runtime.ts";
import type { ReadonlySessionManager, SessionManager } from "../session-manager.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { CompactionPreparation, CompactionResult } from "./index.ts";

export interface PrecompactionAdapter {
	enabled: boolean;
	stopAndDrain?: () => Promise<void>;
	settings(model: Model<string>): { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
	physicalModel(provider: string, id: string): Model<string> | undefined;
	generate(preparation: CompactionPreparation, model: Model<string>, signal: AbortSignal): Promise<CompactionResult>;
	recordStatus(sessionId: string, status: string, error?: string): void;
}

const adapters = new WeakMap<object, PrecompactionAdapter>();
export function installPrecompactionAdapter(manager: ReadonlySessionManager, adapter: PrecompactionAdapter): void {
	adapters.set(manager, adapter);
}
export function getPrecompactionAdapter(manager: ReadonlySessionManager): PrecompactionAdapter | undefined {
	return adapters.get(manager);
}

/** 前台已结束时仍取消本会话的后台摘要，复用扩展的有界结算。 */
export async function abortPrecompaction(manager: ReadonlySessionManager): Promise<void> {
	await adapters.get(manager)?.stopAndDrain?.();
}

/** 会话装配期的后台预压缩安装口（SDK 建会话时回调；装配实现在扩展侧）。
 *  enabled 为 SDK 显式选项，未传时 undefined——启用缺省值由扩展侧（pao）自定。 */
export type SessionPrecompactionInstaller = (options: {
	enabled: boolean | undefined;
	agent: Agent;
	modelRuntime: ModelRuntime;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
}) => void;
let precompactionInstaller: SessionPrecompactionInstaller | undefined;
export function setPrecompactionInstaller(installer: SessionPrecompactionInstaller): void {
	precompactionInstaller = installer;
}
export function getPrecompactionInstaller(): SessionPrecompactionInstaller | undefined {
	return precompactionInstaller;
}
