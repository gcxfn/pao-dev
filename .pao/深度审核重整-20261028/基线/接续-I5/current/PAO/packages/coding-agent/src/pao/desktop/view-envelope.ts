/**
 * 视图信封（S6-K4）：查询面输出侧统一的传输/视图层信息——version/sessionGeneration/
 * revision/publishedAt 四字段＋指纹去重＋拒旧事件判定。桌面 D2 消费经 pi-sdk-driver
 * re-export 的本模块函数，不自实现指纹（跨仓契约冻结点，字段语义见实施记录契约表）。
 *
 * 红线（正本 §S6 第 4 条）：版本是传输/视图信息，不替代卡状态——真相仍在卡与控制正本，
 * 本模块纯函数零状态零落盘；打开查询回放由拉模式天然满足（每次查询全量投影权威数据）。
 */
import { createHash } from "node:crypto";

/** 视图信封：挂在查询输出顶层（DesktopProjectSnapshot.envelope / CanvasView.envelope）。 */
export interface ViewEnvelope {
	/** 信封契约版本：字段结构变更才递增，消费方按此分派 */
	version: 1;
	/**
	 * 作用域代际（sha256 十六进制）：切会话/工作流即换值。消费方切换后以新查询的代际为基准，
	 * 事件代际≠当前代际＝旧作用域事件拒收（isStaleEvent）。
	 */
	sessionGeneration: string;
	/** 内容指纹（sha256 十六进制）：同代际下内容未变＝同值，消费方据此去重不重渲染 */
	revision: string;
	/** 本投影发布时间（ISO）；每次投影都变，不参与指纹 */
	publishedAt: string;
}

/** 作用域代际指纹：同作用域身份稳定；身份含会话/项目根/工作流实例，任一变化即换值。 */
export function sessionGenerationOf(scope: unknown): string {
	return createHash("sha256").update(JSON.stringify(scope)).digest("hex");
}

/** 内容指纹：对投影内容（不含时间字段）求 sha256，同内容稳定。 */
export function contentRevisionOf(payload: unknown): string {
	return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** 拒旧事件判定：事件代际≠当前代际＝旧作用域事件，拒收（不串标签/会话）。 */
export function isStaleEvent(eventSessionGeneration: string, currentSessionGeneration: string): boolean {
	return eventSessionGeneration !== currentSessionGeneration;
}

/** 组装信封：scope 定代际、payload（已剔除时间字段）定内容指纹。 */
export function buildEnvelope(scope: unknown, payload: unknown, publishedAt: string): ViewEnvelope {
	return {
		version: 1,
		sessionGeneration: sessionGenerationOf(scope),
		revision: contentRevisionOf(payload),
		publishedAt,
	};
}
