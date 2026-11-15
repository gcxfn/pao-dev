/**
 * 供应商请求路径的中性注册口（替代 core→pao 静态依赖）：sdk.ts 在请求路径上查询，
 * 扩展侧（pao）经 setter 登记。闭包保持最小（仅会话类型），内核公开导出经 pao 引入
 * 本模块不拖 CLI 入口。未登记时全部零行为。
 */
import type { ReadonlySessionManager } from "./session-manager.ts";

/** 观察最终供应商请求装配与响应状态（所有 onPayload 变换完成后调用；返回请求捕获标识）。 */
export interface ProviderRequestObserver {
	onFinalPayload?(sessionId: string, payload: unknown): string | undefined;
	onResponse?(sessionId: string, requestId: string | undefined, status: number): void;
}
let providerRequestObserver: ProviderRequestObserver | undefined;
export function observeProviderRequests(observer: ProviderRequestObserver): void {
	providerRequestObserver = observer;
}
export function getProviderRequestObserver(): ProviderRequestObserver | undefined {
	return providerRequestObserver;
}

/** 辅助摘要请求的预算门（经会话登记；未登记即放行）。 */
const auxiliaryRequestGuards = new WeakMap<object, () => void>();
export function setAuxiliaryRequestGuard(manager: ReadonlySessionManager, guard: () => void): void {
	auxiliaryRequestGuards.set(manager, guard);
}
export function assertAuxiliaryRequestBudget(manager: ReadonlySessionManager): void {
	auxiliaryRequestGuards.get(manager)?.();
}
