/**
 * worker 进程生命周期(T04 自 worker/index.ts 拆出):
 * 会话级默认运行器、主会话退出钩子(正常退出/SIGINT/SIGTERM → 停整棵受管进程树)。
 * 登记与停止原语复用 runner/kill,本模块不另建第二套停止机制;
 * 部长会话宿主的散场语义不同(host/host.ts),只经 extraStop 停止面接入,不在此合并。
 */

import { WorkerRunner } from "./runner.ts";

/** 主会话级默认运行器:一个会话一个调度轮次,工具与退出钩子共用 */
export const defaultWorkerRunner = new WorkerRunner();

// ── 退出钩子:主会话退出 → 停本轮进程树 ────────────────────────────────

const exitHookDisposers = new WeakMap<WorkerRunner, () => void>();

/**
 * 主会话退出钩子:session_shutdown(正常退出/重载/换会话都会走)之外,
 * 再兜 beforeExit;可选接管 SIGINT/SIGTERM(先停子进程树,再恢复默认终止行为)。
 * 额外停止:宿主等与运行器同生命周期的停止面(M2-01 部长会话全停)在停完 worker 后执行。
 * 幂等:同一 runner 只挂一次。
 */
export function installExitHooks(
	runner: WorkerRunner,
	options: { signals?: boolean; extraStop?: () => Promise<unknown> } = {},
): () => void {
	const existing = exitHookDisposers.get(runner);
	if (existing) return existing;
	const reportFailure = (error: unknown): void => {
		process.stderr.write(`PAO 停止后台失败：${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	};
	const beforeExit = (): void => {
		const tasks: Promise<unknown>[] = [runner.stopAll()];
		if (options.extraStop) tasks.push(Promise.resolve(options.extraStop()));
		void Promise.all(tasks).catch(reportFailure);
	};
	process.on("beforeExit", beforeExit);
	const signals: [NodeJS.Signals, () => void][] = [];
	if (options.signals) {
		for (const sig of ["SIGINT", "SIGTERM"] as const) {
			const handler = (): void => {
				process.removeListener(sig, handler);
				const tasks: Promise<unknown>[] = [runner.stopAll()];
				if (options.extraStop) tasks.push(Promise.resolve(options.extraStop()));
				void Promise.all(tasks)
					.catch(reportFailure)
					.finally(() => {
						process.kill(process.pid, sig);
					});
			};
			process.on(sig, handler);
			signals.push([sig, handler]);
		}
	}
	const dispose = (): void => {
		process.removeListener("beforeExit", beforeExit);
		for (const [sig, handler] of signals) process.removeListener(sig, handler);
		exitHookDisposers.delete(runner);
	};
	exitHookDisposers.set(runner, dispose);
	return dispose;
}
