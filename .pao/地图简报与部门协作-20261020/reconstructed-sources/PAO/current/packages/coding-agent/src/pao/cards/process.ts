import { execFile } from "node:child_process";
import { killTree } from "../../utils/kill-tree.ts";
import { logWarn } from "../shared/log.ts";

export function runCardProcess(
	cmd: string,
	args: string[],
	cwd: string,
	timeoutMs: number,
	env?: NodeJS.ProcessEnv,
	signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
	signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		let timedOut = false;
		let timer: NodeJS.Timeout | undefined;
		let stopping: Promise<void> | undefined;
		let stopError: unknown;
		const stop = () => {
			if (stopping || !child.pid) return;
			stopping = killTree(child.pid, 2000, createdBefore).then(
				() => {},
				(error) => {
					stopError = error;
					child.kill("SIGKILL");
				},
			);
		};
		const child = execFile(
			cmd,
			args,
			{ cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...(env ? { env } : {}) },
			async (error, stdout, stderr) => {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", stop);
				await stopping;
				// 取消语义优先于树杀失败：中止时即便树杀也报错，仍按 AbortError 归类，
				// 不让 stopError 掩盖「这是取消」的事实
				if (signal?.aborted) {
					if (stopError) {
						// 双失败（取消＋树杀失败）：取消语义不变，stopError 挂 cause＋记录性日志，
						// 「树杀曾失败、失败原因」可追溯（可能漏进程），不再彻底丢失
						logWarn(
							`[pao] 取消时树杀失败(原因挂 cause):${stopError instanceof Error ? stopError.message : String(stopError)}`,
						);
						reject(Object.assign(signal.reason, { cause: stopError }));
						return;
					}
					reject(signal.reason);
					return;
				}
				if (stopError) {
					reject(stopError);
					return;
				}
				if (!error) {
					resolve({ code: 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
					return;
				}
				const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
				// 命令不存在 → 127；超时树杀 → 124；其余非零退出原样归一为数字（无法取回按 1）
				let code = 1;
				if (timedOut) code = 124;
				else if (err.code === "ENOENT") code = 127;
				else if (typeof err.code === "number") code = err.code;
				const footerNote = timedOut
					? `（超时 ${timeoutMs}ms 被终止）`
					: err.code === "ENOENT"
						? `（命令不存在：${cmd}）`
						: "";
				resolve({ code, stdout: String(stdout ?? ""), stderr: `${String(stderr ?? "")}${footerNote}`.trim() });
			},
		);
		const createdBefore = Date.now();
		signal?.addEventListener("abort", stop, { once: true });
		if (signal?.aborted) stop();
		// 超时树杀整棵进程树（Node 自带 timeout 只杀直接子进程，Windows 孙进程如 dev server 会泄漏）；
		// 树杀失败再兜底杀直接子进程，保证验收不悬挂
		if (Number.isFinite(timeoutMs))
			timer = setTimeout(() => {
				timedOut = true;
				stop();
			}, timeoutMs);
	});
}
