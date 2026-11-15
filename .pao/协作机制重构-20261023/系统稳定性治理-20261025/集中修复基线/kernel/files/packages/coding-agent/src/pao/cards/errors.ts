/** 卡片模块结构化错误：code 稳定可判，details 带机器可读上下文。 */

export type PaoCardErrorCode =
	| "INVALID_CARD" // frontmatter 缺字段 / 字段非法 / 引用无法解析
	| "CARD_NOT_FOUND"
	| "INVALID_TRANSITION" // 状态机不允许的迁移
	| "FORBIDDEN_WRITER" // 单写者校验失败：调用者不是 owner
	| "ATTEMPT_EXCEEDED" // 重试超上限
	| "DEPS_NOT_MET" // 依赖未全部已交付
	| "INVALID_RECEIPT" // 回执缺卡号/尝试号，或尝试号超前
	| "LOCK_TIMEOUT"; // 文件锁拿不到

export class PaoCardError extends Error {
	readonly code: PaoCardErrorCode;
	readonly details: Record<string, unknown>;

	constructor(code: PaoCardErrorCode, message: string, details: Record<string, unknown> = {}) {
		super(message);
		this.name = "PaoCardError";
		this.code = code;
		this.details = details;
	}
}

export function isPaoCardError(error: unknown): error is PaoCardError {
	return error instanceof PaoCardError;
}
