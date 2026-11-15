import { execFile } from "node:child_process";
import { killTree } from "../../utils/kill-tree.ts";
import { logWarn } from "../shared/log.ts";

export interface CardProcessResult {
	code: number;
	stdout: string;
	stderr: string;
	/** 执行器原因；退出码 124/127 也可能由程序主动返回，不能据此猜测。 */
	failureKind?: "start" | "timeout";
	/** 子进程输出超过采集上限；stdout/stderr 不完整，不能作为完整日志证据。 */
	outputTruncated?: boolean;
	outputLimitBytes?: number;
}

export class CardProcessStopUnconfirmedError extends Error {
	readonly stopError: unknown;
	readonly abortReason?: unknown;

	constructor(message: string, stopError: unknown, abortReason?: unknown) {
		super(message, { cause: stopError });
		this.name = "CardProcessStopUnconfirmedError";
		this.stopError = stopError;
		this.abortReason = abortReason;
	}
}

export function runCardProcess(
	cmd: string,
	args: string[],
	cwd: string,
	timeoutMs: number,
	env?: NodeJS.ProcessEnv,
	signal?: AbortSignal,
): Promise<CardProcessResult> {
	signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		let timedOut = false;
		let timer: NodeJS.Timeout | undefined;
		let stopping: Promise<unknown> | undefined;
		let stopError: unknown;
		let maxBufferReached = false;
		const outputLimitBytes = 16 * 1024 * 1024;
		let capturedOutputBytes = 0;
		let settled = false;
		const stop = (graceMs = 2000) => {
			if (stopping || !child.pid) return stopping;
			stopping = Promise.resolve(killTree(child.pid, graceMs, createdBefore)).then(
				() => {},
				(error) => {
					stopError = error;
					child.kill("SIGKILL");
				},
			);
			return stopping;
		};
		const onAbort = () => {
			void stop();
		};
		const rejectStopUnconfirmed = (incomplete: boolean, detail?: string, cause: unknown = stopError) => {
			if (settled) return;
			settled = true;
			const stopUnconfirmed = new CardProcessStopUnconfirmedError(
				`${incomplete ? "输出超过采集上限，日志不完整；" : ""}子进程停止未确认：${
					detail ?? (cause instanceof Error ? cause.message : String(cause))
				}`,
				cause ?? new Error(detail ?? "子进程停止未确认"),
			);
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			child.stdout?.off("data", onCapturedOutput);
			child.stderr?.off("data", onCapturedOutput);
			reject(stopUnconfirmed);
		};
		const onCapturedOutput = (chunk: Buffer | string) => {
			capturedOutputBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
			if (capturedOutputBytes < outputLimitBytes || maxBufferReached) return;
			// 达到采集上限时直接父进程可能仍存活；此刻树杀才能按父子关系找到长活后代。
			// 不等待 Node 的 maxBuffer 回调，否则回调发生时根进程通常已被 Node 单独终止。
			maxBufferReached = true;
			stop(0)?.then(
				() => {
					// 直接父进程被杀后，其孙进程仍可能持有输出管道，execFile 回调迟迟不触发。
					// 树级停止已失败时立即拒绝，让整合保留写锁，不能伪装普通 code=1 后释放。
					if (stopError && !signal?.aborted) rejectStopUnconfirmed(true);
				},
				() => {},
			);
		};
		const child = execFile(
			cmd,
			args,
			// 流式监听先在上限处触发树杀；maxBuffer 留一倍余量，只防异常洪峰绕过主动停止。
			{ cwd, windowsHide: true, maxBuffer: outputLimitBytes * 2, ...(env ? { env } : {}) },
			async (error, stdout, stderr) => {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				child.stdout?.off("data", onCapturedOutput);
				child.stderr?.off("data", onCapturedOutput);
				const exceededOutput =
					(error as NodeJS.ErrnoException | null)?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
				// 原生 maxBuffer 仍可能先于流监听触发；其回调代表直接父进程已被单独终止。
				if (exceededOutput) {
					maxBufferReached = true;
					// 先等已启动的主动停止；若根本没有启动，则下方的无法证明分支直接拒绝。
				}
				await stopping;
				// execFile 超限时通常已经单独终止直接父进程。若根已不存在，killTree 的空选成功
				// 不能证明曾找到或停止后代；按停止未确认处理，绝不退回普通 code=1 释放整合锁。
				if (exceededOutput && !settled) {
					rejectStopUnconfirmed(true, "原生命令输出上限先触发，直接父进程已被单独终止，无法证明后代已停止", error);
					return;
				}
				// 取消语义优先于树杀失败：中止时即便树杀也报错，仍按 AbortError 归类，
				// 不让 stopError 掩盖「这是取消」的事实
				if (signal?.aborted) {
					if (stopError) {
						// 双失败（取消＋树杀失败）：取消语义不变，stopError 挂 cause＋记录性日志，
						// 「树杀曾失败、失败原因」可追溯（可能漏进程），不再彻底丢失
						logWarn(
							`[pao] 取消时树杀失败(原因挂 cause):${stopError instanceof Error ? stopError.message : String(stopError)}`,
						);
						const failure = new CardProcessStopUnconfirmedError(
							`取消时子进程停止未确认：${stopError instanceof Error ? stopError.message : String(stopError)}`,
							stopError,
							signal.reason,
						);
						// 保留取消分类，同时让调用者通过类型明确识别停止未确认；不修改 reason，
						// AbortSignal.reason 可以是原始值或冻结对象。
						failure.name = "AbortError";
						reject(failure);
						return;
					}
					reject(signal.reason);
					return;
				}
				if (stopError) {
					if (settled) return;
					rejectStopUnconfirmed(exceededOutput || maxBufferReached);
					return;
				}
				if (!error && !maxBufferReached && !timedOut) {
					resolve({ code: 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
					return;
				}
				if (!error && maxBufferReached) {
					rejectStopUnconfirmed(true, "输出达到采集上限后命令自行退出，无法证明曾发现的后代已停止");
					return;
				}
				const err = (error ?? {}) as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
				const outputTruncated = err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || maxBufferReached;
				// 启动 ENOENT → 127（命令或 cwd 均可能缺失）；超时树杀 → 124。
				let code = 1;
				if (timedOut) code = 124;
				else if (err.code === "ENOENT") code = 127;
				else if (typeof err.code === "number") code = err.code;
				const footerNote = timedOut
					? `（超时 ${timeoutMs}ms 被终止）`
					: err.code === "ENOENT"
						? `（进程启动 ENOENT：${cmd}；工作目录：${cwd}。请核查可执行文件、解释器及工作目录）`
						: outputTruncated
							? `（输出超过采集上限 ${outputLimitBytes} 字节，日志不完整）`
							: "";
				resolve({
					code,
					...(timedOut
						? { failureKind: "timeout" as const }
						: typeof err.code === "string"
							? { failureKind: "start" as const }
							: {}),
					stdout: String(stdout ?? ""),
					stderr: `${String(stderr ?? "")}${footerNote}`.trim(),
					...(outputTruncated ? { outputTruncated: true, outputLimitBytes } : {}),
				});
			},
		);
		child.stdout?.on("data", onCapturedOutput);
		child.stderr?.on("data", onCapturedOutput);
		const createdBefore = Date.now();
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
		// 超时树杀整棵进程树（Node 自带 timeout 只杀直接子进程，Windows 孙进程如 dev server 会泄漏）；
		// 树杀失败再兜底杀直接子进程，保证验收不悬挂
		if (Number.isFinite(timeoutMs))
			timer = setTimeout(() => {
				timedOut = true;
				stop();
			}, timeoutMs);
	});
}
