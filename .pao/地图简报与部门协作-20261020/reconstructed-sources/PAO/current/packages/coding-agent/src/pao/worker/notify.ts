/**
 * 后台通知面(T04 自 worker/index.ts 拆出;S6-K3 起自动链终局通知并入同一缓冲):会话级内存缓冲＋
 * 可选的主动唤醒＋toast(可选)＋before_agent_start 注入段(消费式:注入即清空)。派卡完成/被拒/
 * 失败/静默提醒与自动链完成/停下/失败共用一个缓冲与段——上级一轮看完所有裁决材料。运行态重启
 * 归零(R25),卡文件状态与回执是真相。
 */

import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { toastEnabled } from "../host/config.ts";
import { sendToast } from "../notify/toast.ts";
import { logWarn } from "../shared/log.ts";

/**
 * 后台通知的系统提示段名(before_agent_start 注入面)。
 * 段名只认 ASCII 小写(core SYSTEM_PROMPT_SECTION_NAME 正则,中文段名会让整回合失败);
 * 中文标题「后台通知」写在段内容里。
 */
export const DISPATCH_NOTIFY_SECTION = "pao-dispatch-notify";

/** 主动唤醒只发这个稳定提示;完整内容仅由下一次 before_agent_start 注入,避免正文双投。 */
export const DISPATCH_NOTIFY_WAKEUP_TEXT = "有新的后台结果，请读取本轮注入的通知摘要。";

export interface DispatchNotifyEvent {
	systemPromptOptions: { sections: Record<string, string> };
}

/**
 * 独立导出最小唤醒消息,供共享通知面在主扩展实例内调用公开 sendMessage。
 * triggerTurn + followUp 让空闲主会话启动一轮;完整通知正文留给通知缓冲注入。
 */
export function sendDispatchNotifyWakeup(pi: Pick<ExtensionAPI, "sendMessage">): void {
	pi.sendMessage(
		{
			customType: "pao-dispatch-notify",
			content: [{ type: "text", text: DISPATCH_NOTIFY_WAKEUP_TEXT }],
			display: true,
		},
		{ triggerTurn: true, deliverAs: "followUp" },
	);
}

export interface DispatchNotifySurface {
	/** 一条通知进缓冲,并尽力发出一次合并后的最小主动唤醒;正文留到下一轮注入。 */
	notify(body: string, toastTitle?: string, toastBody?: string): void;
	/** before_agent_start 注入:缓冲空时零行为,非空即消费式清空并写段。 */
	inject(event: DispatchNotifyEvent): void;
	/** 当前扩展实例关闭后禁止新回合;生命周期替换时会由新实例获得新通知面。 */
	shutdown(): void;
	/** 未读通知条数(后台观测面用)。 */
	unreadCount(): number;
}

/**
 * 创建会话级通知面;resolvePaoHome 须是已软化口(可抛错的原始解析先在调用方兜住)。
 * wakeUp 绑定当前扩展实例,shutdown 后旧异步任务不会再投向新会话;真实 new/resume/fork/reload
 * 会创建新的扩展实例,因此新会话仍能正常收到新通知。
 */
export function createDispatchNotifySurface(input: {
	resolvePaoHome: () => string | undefined;
	wakeUp?: () => void;
}): DispatchNotifySurface {
	const buffer: string[] = [];
	let closed = false;
	let wakePending = false;

	const wake = (): void => {
		if (closed || wakePending || buffer.length === 0 || input.wakeUp === undefined) return;
		wakePending = true;
		try {
			input.wakeUp();
		} catch (error) {
			wakePending = false;
			logWarn(
				`[pao] 后台通知主动唤醒失败,通知已保留待下一轮补投:${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	return {
		notify(body, toastTitle, toastBody): void {
			if (closed) return;
			buffer.push(body);
			wake();
			if (toastTitle === undefined) return;
			try {
				void sendToast(toastTitle, (toastBody ?? body).slice(0, 200), {
					enabled: toastEnabled(input.resolvePaoHome()),
				});
			} catch {
				/* toast 是旁路:失败不影响通知缓冲与主动唤醒 */
			}
		},
		inject(event): void {
			if (closed || buffer.length === 0) return;
			const body = buffer.splice(0).join("\n\n");
			wakePending = false;
			event.systemPromptOptions.sections[DISPATCH_NOTIFY_SECTION] = formatNotifyBody(body);
		},
		shutdown: () => {
			closed = true;
			wakePending = false;
			buffer.length = 0;
		},
		unreadCount: () => buffer.length,
	};
}

function formatNotifyBody(body: string): string {
	return `[pao 后台通知] 以下为后台派卡/自动链的完成/被拒/失败/静默提醒(运行态,重启归零;卡文件状态与回执是真相,R25):\n${body}`;
}
