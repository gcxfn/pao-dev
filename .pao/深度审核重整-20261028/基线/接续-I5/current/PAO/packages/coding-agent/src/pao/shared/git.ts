/** Git 读取调用点的等待上界；调用方传入实际预算，错误文案不能猜别的调用点配置。 */
export const GIT_READ_TIMEOUT_MS = 30_000;

/** 合并执行器错误与 stderr，部分 stderr 不得掩盖 ENOENT、超时或 maxBuffer。 */
export function gitProcessErrorText(error: unknown, stderr: string, timeoutMs?: number): string {
	const executor = gitSpawnErrorText(error, timeoutMs);
	const detail = stderr.trim();
	if (!detail) return executor;
	if (!executor || detail === executor) return detail;
	return `${executor}；git stderr：${detail}`;
}

/** git 进程启动/外部终止边界的错误文案；只有调用点明确给出预算才描述超时。 */
export function gitSpawnErrorText(error: unknown, timeoutMs?: number): string {
	const message = error instanceof Error ? error.message : String(error);
	const details = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | undefined;
	if (details?.killed && timeoutMs !== undefined) return `git 被执行器终止（等待上限 ${timeoutMs}ms；${message}）`;
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
		? `git 未找到：请检查 git 是否已安装并在 PATH 中（${message}）`
		: message;
}
