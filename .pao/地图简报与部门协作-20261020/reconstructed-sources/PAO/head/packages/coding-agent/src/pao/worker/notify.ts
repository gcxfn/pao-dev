/**
 * 后台通知面(T04 自 worker/index.ts 拆出;S6-K3 起自动链终局通知并入同一缓冲):会话级内存缓冲＋
 * toast(可选)＋before_agent_start 注入段(消费式:注入即清空)。派卡完成/被拒/失败/静默提醒与
 * 自动链完成/停下/失败共用一个缓冲与段——上级一轮看完所有裁决材料。运行态重启归零(R25),
 * 卡文件状态与回执是真相。
 */

import { toastEnabled } from "../host/config.ts";
import { sendToast } from "../notify/toast.ts";

/**
 * 后台通知的系统提示段名(before_agent_start 注入面)。
 * 段名只认 ASCII 小写(core SYSTEM_PROMPT_SECTION_NAME 正则,中文段名会让整回合失败);
 * 中文标题「后台通知」写在段内容里。
 */
export const DISPATCH_NOTIFY_SECTION = "pao-dispatch-notify";

export interface DispatchNotifyEvent {
	systemPromptOptions: { sections: Record<string, string> };
}

export interface DispatchNotifySurface {
	/** 一条通知:进缓冲(下一轮注入);带 toast 标题时尽力发 toast(toast 失败不拖累缓冲) */
	notify(body: string, toastTitle?: string, toastBody?: string): void;
	/** before_agent_start 注入:缓冲空时零行为,非空即消费式清空并写段 */
	inject(event: DispatchNotifyEvent): void;
	/** 未读通知条数(后台观测面用) */
	unreadCount(): number;
}

/** 创建会话级通知面;resolvePaoHome 须是已软化口(可抛错的原始解析先在调用方兜住) */
export function createDispatchNotifySurface(input: {
	resolvePaoHome: () => string | undefined;
}): DispatchNotifySurface {
	const buffer: string[] = [];
	return {
		notify(body, toastTitle, toastBody): void {
			buffer.push(body);
			if (toastTitle === undefined) return;
			try {
				void sendToast(toastTitle, (toastBody ?? body).slice(0, 200), {
					enabled: toastEnabled(input.resolvePaoHome()),
				});
			} catch {
				/* toast 是旁路:失败不影响通知缓冲主路 */
			}
		},
		inject(event): void {
			if (buffer.length === 0) return;
			const body = buffer.splice(0).join("\n\n");
			event.systemPromptOptions.sections[DISPATCH_NOTIFY_SECTION] =
				`[pao 后台通知] 以下为后台派卡/自动链的完成/被拒/失败/静默提醒(运行态,重启归零;卡文件状态与回执是真相,R25):\n${body}`;
		},
		unreadCount: () => buffer.length,
	};
}
