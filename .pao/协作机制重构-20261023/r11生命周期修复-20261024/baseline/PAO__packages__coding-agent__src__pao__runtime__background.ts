/**
 * 连接 PAO 后台生产者与核心层模式无关生命周期注册表的适配器。
 *
 * 生产者负责维护自己的在途状态；本模块只合并它们公开的计数，
 * 并转发变化通知。
 */

import {
	type BackgroundWorkPort,
	BackgroundWorkSignal,
	type BackgroundWorkSnapshot,
	bindBackgroundWorkPort,
	hasBackgroundWork,
	releaseBackgroundWorkPort,
} from "../../core/background-work.ts";
export interface BackgroundNotifySurface {
	notify(body: string, toastTitle?: string, toastBody?: string): void;
	unreadCount(): number;
	shutdown(): void;
	subscribe?(listener: () => void): () => void;
}

export interface WorkerBackgroundSource {
	backgroundCount(): { inFlight: number; unread: number };
	waitForBackground(): Promise<void>;
}

export interface WorkflowBackgroundSource {
	backgroundCount?(): { inFlight: number };
	waitForAutoChain(): Promise<void>;
}

export interface FanoutBackgroundState {
	in_flight: number;
	completed_unread: number;
}

export interface FanoutBackgroundSource {
	backgroundCount(): FanoutBackgroundState;
}

export interface HostBackgroundSource {
	backgroundCount(): { inFlight: number };
	subscribeBackground?(listener: () => void): () => void;
}

export interface BackgroundHost {
	/** 通知生产者侧状态发生变化；不轮询。 */
	changed(): void;
	trackWorker(source: WorkerBackgroundSource): void;
	trackWorkflow(source: WorkflowBackgroundSource): void;
	trackFanout(source: FanoutBackgroundSource): void;
	trackHost(source: HostBackgroundSource): void;
	/** 停止全部订阅并唤醒 print 模式；可重复调用。 */
	shutdown(): void;
	port: BackgroundWorkPort;
}

export function createBackgroundHost(
	pi: { on(event: "session_shutdown", handler: () => void): () => void },
	notifySurface: BackgroundNotifySurface,
): BackgroundHost {
	const signal = new BackgroundWorkSignal();
	let worker: WorkerBackgroundSource | undefined;
	let workflow: WorkflowBackgroundSource | undefined;
	let fanout: FanoutBackgroundSource | undefined;
	let host: HostBackgroundSource | undefined;
	let closed = false;
	let unsubscribeNotify: (() => void) | undefined;
	let unsubscribeLifecycle: (() => void) | undefined;
	let unsubscribeHost: (() => void) | undefined;

	const changed = (): void => {
		if (!closed) signal.changed();
	};
	unsubscribeNotify = notifySurface.subscribe?.(changed);
	unsubscribeLifecycle = pi.on("session_shutdown", shutdown);

	const snapshot = (): BackgroundWorkSnapshot => ({
		running:
			(worker?.backgroundCount().inFlight ?? 0) +
			(workflow?.backgroundCount?.().inFlight ?? 0) +
			(fanout?.backgroundCount().in_flight ?? 0) +
			(host?.backgroundCount().inFlight ?? 0),
		unread: notifySurface.unreadCount(),
	});
	const port: BackgroundWorkPort = {
		snapshot,
		waitForChange: async (abortSignal?: AbortSignal): Promise<void> => {
			const observed = signal.currentVersion;
			await signal.waitForChange(abortSignal, observed);
		},
		shutdown,
	};

	function shutdown(): void {
		if (closed) return;
		closed = true;
		unsubscribeNotify?.();
		unsubscribeNotify = undefined;
		unsubscribeLifecycle?.();
		unsubscribeLifecycle = undefined;
		unsubscribeHost?.();
		unsubscribeHost = undefined;
		signal.shutdown();
	}

	return {
		changed,
		shutdown,
		trackWorker(source): void {
			worker = source;
			changed();
		},
		trackWorkflow(source): void {
			workflow = source;
			changed();
		},
		trackFanout(source): void {
			fanout = source;
			changed();
		},
		trackHost(source): void {
			unsubscribeHost?.();
			host = source;
			unsubscribeHost = source.subscribeBackground?.(changed);
			changed();
		},
		port,
	};
}

/** 把宿主绑定到 session_start 上下文公开的真实 SessionManager。 */
export function attachBackgroundHost(host: BackgroundHost, sessionManager: object): void {
	bindBackgroundWorkPort(sessionManager, host.port);
}

export function releaseBackgroundHost(sessionManager: object, host: BackgroundHost): void {
	releaseBackgroundWorkPort(sessionManager, host.port);
}

export { hasBackgroundWork };
