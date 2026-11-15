/**
 * git 进程启动边界的错误文案（唯一实现）。
 * git 未安装/不在 PATH 时 spawn/execFile 报 ENOENT，原文「spawn git ENOENT」无信息量，
 * 还常被上层误读成「非 git 项目」；这里把话术说清（查安装与 PATH），原始错误文本
 * 始终附在结果尾部不吞。非 ENOENT（真 git 报错）原样透传不添乱。
 */
export function gitSpawnErrorText(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
		? `git 未找到：请检查 git 是否已安装并在 PATH 中（${message}）`
		: message;
}
