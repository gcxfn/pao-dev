/**
 * 宿主模式共用的会话级后台工作生命周期。
 *
 * 核心层只认识计数和变化通知。PAO 等业务模块为扩展处理器收到的
 * SessionManager 实例登记端口；print 模式再通过
 * AgentSession.sessionManager 找回同一端口，无需反向导入业务模块。
 */

export interface BackgroundWorkSnapshot {
	/** 仍可能产生新结果的在途任务数。 */
	running: number;
	/** 已到达但尚未由 agent 处理的结果数。 */
	unread: number;
}

export interface BackgroundWorkPort {
	snapshot(): BackgroundWorkSnapshot;
	/** 等到下一次状态变化或关闭；不轮询。 */
	waitForChange(signal?: AbortSignal): Promise<void>;
	/** 绑定会话被替换或销毁时释放端口。 */
	shutdown(): void;
}

/** RPC 等宿主协议层输出的机械后台状态事件。 */
export interface BackgroundWorkEvent extends BackgroundWorkSnapshot {
	type: "background_work";
}

/** 会话生命周期关闭时，通知尚未返回的等待方。 */
export class BackgroundWorkClosedError extends Error {
	constructor() {
		super("Background work stopped because its session shut down");
		this.name = "BackgroundWorkClosedError";
	}
}

const ports = new WeakMap<object, BackgroundWorkPort>();

/** 把端口绑定到扩展上下文公开的真实 SessionManager 对象。 */
export function bindBackgroundWorkPort(sessionManager: object, port: BackgroundWorkPort): void {
	const previous = ports.get(sessionManager);
	if (previous !== undefined && previous !== port) previous.shutdown();
	ports.set(sessionManager, port);
}

export function getBackgroundWorkPort(sessionManager: object): BackgroundWorkPort | undefined {
	return ports.get(sessionManager);
}

export function releaseBackgroundWorkPort(sessionManager: object, expectedPort?: BackgroundWorkPort): void {
	const port = ports.get(sessionManager);
	if (port === undefined) return;
	if (expectedPort !== undefined && port !== expectedPort) return;
	ports.delete(sessionManager);
	port.shutdown();
}

export function hasBackgroundWork(snapshot: BackgroundWorkSnapshot): boolean {
	return snapshot.running > 0 || snapshot.unread > 0;
}

/**
 * 供宿主用变化回调驱动的轻量信号。
 *
 * 版本号会保留等待开始前发生的变化，避免“检查快照”和“开始等待”之间
 * 漏掉最后一次后台完成通知。
 */
export class BackgroundWorkSignal {
	private version = 0;
	private closed = false;
	private readonly listeners = new Set<() => void>();

	/** 通知状态发生变化。 */
	changed(): void {
		if (this.closed) return;
		this.version++;
		for (const listener of this.listeners) listener();
	}

	/** 当前变化版本，供等待方跨过快照与订阅之间的竞态。 */
	get currentVersion(): number {
		return this.version;
	}

	/** 直接订阅状态变化；返回取消函数。 */
	subscribe(listener: () => void): () => void {
		if (this.closed) return () => {};
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** 等到下一次变化、取消或关闭。 */
	async waitForChange(signal?: AbortSignal, observedVersion = this.version): Promise<void> {
		signal?.throwIfAborted();
		if (this.closed) throw new BackgroundWorkClosedError();
		if (this.version !== observedVersion) return;

		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = (): void => {
				if (settled) return;
				settled = true;
				unsubscribe();
				signal?.removeEventListener("abort", onAbort);
				if (this.closed) reject(new BackgroundWorkClosedError());
				else resolve();
			};
			const onAbort = (): void => {
				if (settled) return;
				settled = true;
				unsubscribe();
				reject(signal?.reason);
			};
			const unsubscribe = this.subscribe(finish);
			signal?.addEventListener("abort", onAbort, { once: true });
			if (this.closed || this.version !== observedVersion) finish();
		});
	}

	/** 关闭全部等待；可重复调用。 */
	shutdown(): void {
		if (this.closed) return;
		this.closed = true;
		this.version++;
		const listeners = [...this.listeners];
		this.listeners.clear();
		for (const listener of listeners) listener();
	}
}
