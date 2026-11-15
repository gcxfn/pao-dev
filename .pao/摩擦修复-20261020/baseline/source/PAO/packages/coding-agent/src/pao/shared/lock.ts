import lockfile from "proper-lockfile";

/**
 * 锁获取失败的结构化错误：code 稳定可判（自 cards/errors.ts 的 PaoCardError("LOCK_TIMEOUT")
 * 迁平——原类型随卡域词汇留在 cards，锁原语不反向依赖卡域；消息与结构化字段不变）。
 */
export class FileLockError extends Error {
	readonly code: "LOCK_TIMEOUT";
	readonly details: Record<string, unknown>;

	constructor(message: string, details: Record<string, unknown> = {}) {
		super(message);
		this.name = "FileLockError";
		this.code = "LOCK_TIMEOUT";
		this.details = details;
	}
}

/**
 * proper-lockfile「锁已被占用」错误判别（唯一正本）：mkdir 语义下 ELOCKED/EEXIST 同义。
 * 各域错误类型（FileLockError/PaoWorkerError）自持消息与结构化字段，判别式不另抄。
 */
export function isLockHeldError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ELOCKED" || code === "EEXIST";
}

/**
 * 跨进程文件锁，包装 proper-lockfile（本 fork 运行时依赖，settings-manager/trust-manager 已在用）。
 *
 * 选型依据：
 * - proper-lockfile 用 mkdir 原子性建 `<目标>.lock` 目录，mkdir 在 Windows 上也是原子操作，跨进程安全；
 * - 自带 stale（基于锁目录 mtime）恢复，持锁进程崩溃不会永久死锁；
 * - fork 内已有成熟使用先例，不重复造轮子。
 *
 * 用法：`await withFileLock(path, fn)` —— fn 内完成读改写全流程；锁自动释放。
 */
export interface FileLockOptions {
	/** 获取锁重试次数。默认 9 次（叠加指数退避约数秒），发号与结卡足够。 */
	retries?: number;
	/** 首次重试等待毫秒。默认 50。 */
	retryDelay?: number;
	/** 锁过期毫秒：持锁者超过该时长未动即视为死亡。默认 10_000。 */
	stale?: number;
}

export async function withFileLock<T>(
	targetPath: string,
	fn: () => T | Promise<T>,
	options?: FileLockOptions,
): Promise<T> {
	let release: () => Promise<void>;
	try {
		release = await lockfile.lock(targetPath, {
			retries: {
				retries: options?.retries ?? 9,
				factor: 2,
				minTimeout: options?.retryDelay ?? 50,
				maxTimeout: 1000,
				randomize: false,
			},
			stale: options?.stale ?? 10_000,
			// 目标可能尚不存在（如首次发号）；不做 realpath 解析
			realpath: false,
		});
	} catch (error) {
		if (isLockHeldError(error)) {
			throw new FileLockError(`文件锁获取失败：${targetPath}`, { targetPath, cause: String(error) });
		}
		throw error;
	}
	try {
		return await fn();
	} finally {
		await release();
	}
}
