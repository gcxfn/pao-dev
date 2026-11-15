/**
 * pao 内核侧警告/错误出口（单点收口）：桌面宿主看不见进程级 console，散落的
 * console.warn/error 在桌面里等于静默丢失。pao/ 内一律走这两个函数，不再直写 console。
 * ponytail: 先不做 setKernelLogger 注入框架——单点收口即止；升级路径＝把这两个函数
 * 的实现换成转发宿主通道（届时散点代码零改动）。
 */

/** 警告：不影响主流程、但应当可见的降级/失败事实 */
export function logWarn(message: string): void {
	console.warn(message);
}

/** 错误：主流程受阻的失败事实（当前仓内暂无调用方，收口时预留给 error 级散点） */
export function logError(message: string): void {
	console.error(message);
}
