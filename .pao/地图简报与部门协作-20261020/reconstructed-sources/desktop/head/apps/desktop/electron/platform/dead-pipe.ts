/**
 * 主进程断管边界（W-bug7）。口径对齐内核 interactive-mode 的
 * DEAD_TERMINAL_ERROR_CODES：EPIPE/EIO/ENOTCONN 是预期断管（桌面 GUI 不依赖
 * 控制台，吸收后继续运行）。两条腿语义不同，如实分工：
 * - 流级腿：只吸收本边界挂接的 stdout/stderr 上的断管；非断管 rethrow。
 * - uncaughtException 腿：全局吸收一切来源的断管类错误（有意放宽，超出内核
 *   「该腿一律 crash」口径）——W-bug7 实录的 Electron 内部 console 转发路径
 *   无流级接线，只能在此层吸收；代价与对策见开发根
 *   .agents/notes/implemented/2026-10-07-桌面dead-pipe全局吸收腿决策.md。
 * 两条腿都不吞非断管错误：一律交给 onUnexpected 呈现。
 */

export const DEAD_PIPE_ERROR_CODES: ReadonlySet<string> = new Set(["EIO", "EPIPE", "ENOTCONN"]);

export function isDeadPipeError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code !== undefined && DEAD_PIPE_ERROR_CODES.has(code);
}

export interface DeadPipeBoundary {
  /** 解除本边界的全部监听（测试与热重载用）。 */
  dispose(): void;
  /**
   * process.on("uncaughtException") 注册的处理器。EPIPE 类（如 Electron 内部
   * console 转发遇死管道，W-bug7 实录路径）被吸收；其余交给 onUnexpected。
   */
  handleUncaughtException(error: Error): void;
}

export function installDeadPipeBoundary(options: {
  streams: Iterable<NodeJS.EventEmitter>;
  onUnexpected: (error: Error) => void;
}): DeadPipeBoundary {
  const streamHandler = (error: Error): void => {
    if (isDeadPipeError(error)) {
      return; // 控制台已死；GUI 继续运行，后续写失败的错误同样在此吸收。
    }
    throw error; // 仍可见：成为 uncaughtException，交给 onUnexpected。
  };
  const streams = [...options.streams];
  for (const stream of streams) {
    stream.on("error", streamHandler);
  }
  const handleUncaughtException = (error: Error): void => {
    if (isDeadPipeError(error)) {
      // 预期断管：尽力一行记录（code＋message＋来源帧；stack 不用于归因判定，
      // 只作诊断线索），不弹崩溃窗。console 写失败会回到流边界被吸收。
      try {
        const at = error.stack?.split("\n")[1]?.trim();
        const { code } = error as NodeJS.ErrnoException;
        console.error(
          `[main] ignored dead-pipe error: ${code} ${error.message}${at ? ` (${at})` : ""}`,
        );
      } catch {}
      return;
    }
    options.onUnexpected(error);
  };
  process.on("uncaughtException", handleUncaughtException);
  return {
    dispose() {
      for (const stream of streams) {
        stream.off("error", streamHandler);
      }
      process.off("uncaughtException", handleUncaughtException);
    },
    handleUncaughtException,
  };
}
