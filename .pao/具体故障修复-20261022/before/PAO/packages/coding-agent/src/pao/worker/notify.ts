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

export type DispatchNotifyChange =
	| { type: "added"; key: string; pending: number }
	| { type: "injected"; keys: readonly string[]; pending: number }
	| { type: "handled"; key: string; pending: number }
	| { type: "shutdown"; pending: number };

export interface DispatchNotifyOptions {
	/** 可选稳定去重键:同 key 尚未被注入时不重复排队。 */
	key?: string;
	/** 正文注入后是否继续保留到 markHandled;仅确认型通知显式开启。 */
	retainAfterInjected?: boolean;
	/** 可选处理回调:正文真被放进系统提示时调用;不代表模型已处理。 */
	onInjected?: () => void;
	/** 可选处理回调:仅调用 surface.markHandled(key) 时触发。 */
	onHandled?: () => void;
}

interface NoticeEntry {
	key: string;
	body: string;
	options: DispatchNotifyOptions;
	injected: boolean;
	/** 由稳定 key/处理回调产生的确认型通知。正文注入后仍须等待业务显式处理。 */
	retain: boolean;
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
	notify(body: string, toastTitle?: string, toastBody?: string, options?: DispatchNotifyOptions): void;
	/** before_agent_start 注入:缓冲空时零行为,非空即消费式清空并写段。 */
	inject(event: DispatchNotifyEvent): void;
	/**
	 * 显式确认通知已被业务处理或实质检查。注入不等于处理,agent_settled 也不等于处理;
	 * 只有调用方掌握真实结果后才能确认。
	 */
	markHandled(key: string, detail?: string): boolean;
	/** 订阅新增/注入/显式处理/关闭;返回幂等取消函数。print 宿主用它驱动事件等待。 */
	subscribe(listener: (change: DispatchNotifyChange) => void): () => void;
	/** 当前扩展实例关闭后禁止新回合;生命周期替换时会由新实例获得新通知面。 */
	shutdown(): void;
	/** 未读通知条数(后台观测面用)。 */
	unreadCount(): number;
	/** 诊断用:已注入但等待显式处理而保留的条数。 */
	retainedCount(): number;
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
	let buffer: NoticeEntry[] = [];
	const listeners = new Set<(change: DispatchNotifyChange) => void>();
	let closed = false;
	let wakePending = false;
	let duplicateSeq = 0;
	const retained = new Map<string, NoticeEntry>();

	const emit = (change: DispatchNotifyChange): void => {
		for (const listener of [...listeners]) {
			try {
				listener(change);
			} catch (error) {
				logWarn(`[pao] 后台通知订阅回调失败:${error instanceof Error ? error.message : String(error)}`);
			}
		}
	};

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
		notify(body, toastTitle, toastBody, options = {}): void {
			if (closed) return;
			const needsHandling = options.retainAfterInjected === true || options.onHandled !== undefined;
			const hasStableKey = options.key !== undefined;
			const key = options.key ?? `notice:${++duplicateSeq}`;
			const existing = hasStableKey
				? (retained.get(key) ?? buffer.find((entry) => entry.key === key))
				: needsHandling
					? retained.get(key)
					: undefined;
			if (existing) {
				existing.body = body;
				existing.options = options;
				if (!existing.injected && !buffer.includes(existing)) buffer.push(existing);
				if (!existing.injected) emit({ type: "added", key, pending: buffer.length });
				return;
			}
			const entry: NoticeEntry = {
				key,
				body,
				options,
				injected: false,
				retain: needsHandling,
			};
			if (entry.retain) retained.set(key, entry);
			buffer.push(entry);
			emit({ type: "added", key, pending: buffer.length });
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
			const injected = buffer;
			buffer = [];
			for (const entry of injected) entry.injected = true;
			const body = injected.map((entry) => entry.body).join("\n\n");
			wakePending = false;
			event.systemPromptOptions.sections[DISPATCH_NOTIFY_SECTION] = formatNotifyBody(body);
			for (const entry of injected) {
				try {
					entry.options.onInjected?.();
				} catch (error) {
					logWarn(
						`[pao] 后台通知注入回调失败(${entry.key}):${error instanceof Error ? error.message : String(error)}`,
					);
				}
				if (!entry.retain) {
					// 普通消费式通知注入后即完成;不保留正文,避免长会话无限积累。
					entry.body = "";
					entry.options = {};
				}
			}
			emit({ type: "injected", keys: injected.map((entry) => entry.key), pending: buffer.length });
		},
		markHandled(key, detail): boolean {
			if (closed || !key) return false;
			const entry = retained.get(key);
			if (!entry) return false;
			const wasPending = buffer.includes(entry);
			if (wasPending) buffer = buffer.filter((candidate) => candidate !== entry);
			retained.delete(key);
			emit({ type: "handled", key, pending: buffer.length });
			try {
				entry.options.onHandled?.();
			} catch (error) {
				logWarn(
					`[pao] 后台通知处理回调失败(${key}${detail ? `:${detail}` : ""}):${error instanceof Error ? error.message : String(error)}`,
				);
			}
			return true;
		},
		subscribe: (listener) => {
			if (closed) return () => {};
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		shutdown: () => {
			if (closed) return;
			closed = true;
			wakePending = false;
			buffer = [];
			retained.clear();
			// 先广播再解绑,订阅者才能在同一扩展实例里清掉等待状态。
			emit({ type: "shutdown", pending: 0 });
			listeners.clear();
		},
		unreadCount: () => buffer.length,
		retainedCount: () => retained.size,
	};
}

function formatNotifyBody(body: string): string {
	return `[pao 后台通知] 以下为后台派卡/自动链的完成/被拒/失败/静默提醒(运行态,重启归零;卡文件状态与回执是真相,R25):\n${body}`;
}
