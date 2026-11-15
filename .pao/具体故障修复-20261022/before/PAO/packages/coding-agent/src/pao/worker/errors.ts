/** worker 模块错误:结构化 code + 中文消息,调用方可按 code 分流处理 */

export type PaoWorkerErrorCode =
	/** 卡已被取消或运行器已停,拒绝新调用(取消契约第一步:先阻止新调用) */
	| "已取消"
	/** 项目写锁被其他持有者占用 */
	| "锁被占用"
	/** 凭据无效:放锁未出示运行器签发的停止确认,或锁句柄已失效 */
	| "无效凭据"
	/** 参数不合法(如项目根不存在) */
	| "无效参数"
	/** 停止进程失败(已尽力,详情见 message/详情) */
	| "停止失败"
	/** 用量对账:汇总行再进汇总通道,父卡总额会双计(R07,结构上拒绝而非靠自觉) */
	| "用量双计";

export class PaoWorkerError extends Error {
	readonly code: PaoWorkerErrorCode;
	readonly detail: Record<string, unknown>;
	/** 由正式派发链在抛出前标注；普通手工抛错保持 undefined。 */
	dispatchFailurePhase?: "before_start" | "started";

	constructor(code: PaoWorkerErrorCode, message: string, detail: Record<string, unknown> = {}) {
		super(message);
		this.name = "PaoWorkerError";
		this.code = code;
		this.detail = detail;
	}
}
