/**
 * 后台通知主动唤醒的离线行为钉。
 *
 * 这里的宿主事件和 sendMessage 都是内存替身:验证空闲主会话会被最小 followUp 唤醒、
 * 正文仅由 before_agent_start 消费、失败补投与 shutdown 封锁。没有启动真实模型。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createDispatchNotifySurface,
	DISPATCH_NOTIFY_SECTION,
	DISPATCH_NOTIFY_WAKEUP_TEXT,
	sendDispatchNotifyWakeup,
} from "../../src/pao/worker/notify.ts";

const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

afterEach(() => {
	warn.mockClear();
});

describe("dispatch notify:最小主动唤醒 + 缓冲消费", () => {
	it("空闲主会话替身收到一次最小 followUp,完整正文不含在唤醒消息里,下一轮才注入", () => {
		const sent: Array<{
			message: { customType: string; content: { type: "text"; text: string }[]; display: boolean };
			options?: { triggerTurn?: boolean; deliverAs?: string };
		}> = [];
		const pi = {
			sendMessage: (message: (typeof sent)[number]["message"], options?: (typeof sent)[number]["options"]): void => {
				sent.push({ message, options });
			},
		};
		const surface = createDispatchNotifySurface({
			resolvePaoHome: () => undefined,
			wakeUp: () => sendDispatchNotifyWakeup(pi),
		});

		surface.notify("[派卡完成] 卡0001\n真实正文只应缓冲");
		expect(sent).toHaveLength(1);
		expect(sent[0].options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
		expect(sent[0].message.content[0].text).toBe(DISPATCH_NOTIFY_WAKEUP_TEXT);
		expect(sent[0].message.content[0].text).not.toContain("[派卡完成]");
		expect(surface.unreadCount()).toBe(1);

		const sections: Record<string, string> = {};
		surface.inject({ systemPromptOptions: { sections } });
		expect(sections[DISPATCH_NOTIFY_SECTION]).toContain("[派卡完成] 卡0001");
		expect(sections[DISPATCH_NOTIFY_SECTION]).toContain("真实正文只应缓冲");
		expect(surface.unreadCount()).toBe(0);
	});

	it("同一批多条通知只唤醒一次;注入后下一批可再次唤醒", () => {
		let wakes = 0;
		const surface = createDispatchNotifySurface({
			resolvePaoHome: () => undefined,
			wakeUp: () => {
				wakes++;
			},
		});

		surface.notify("完成");
		surface.notify("拒派");
		expect(wakes).toBe(1);
		const sections: Record<string, string> = {};
		surface.inject({ systemPromptOptions: { sections } });
		expect(sections[DISPATCH_NOTIFY_SECTION]).toContain("完成");
		expect(sections[DISPATCH_NOTIFY_SECTION]).toContain("拒派");

		surface.notify("失败");
		expect(wakes).toBe(2);
	});

	it("唤醒同步抛错时记录实际原因、保留缓冲,后续通知可重试补投", () => {
		let attempts = 0;
		const surface = createDispatchNotifySurface({
			resolvePaoHome: () => undefined,
			wakeUp: () => {
				attempts++;
				if (attempts === 1) throw new Error("宿主 sendMessage 暂时拒绝");
			},
		});

		surface.notify("第一条待补投");
		expect(attempts).toBe(1);
		expect(surface.unreadCount()).toBe(1);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("宿主 sendMessage 暂时拒绝"));

		surface.notify("第二条同批");
		expect(attempts).toBe(2);
		const sections: Record<string, string> = {};
		surface.inject({ systemPromptOptions: { sections } });
		expect(sections[DISPATCH_NOTIFY_SECTION]).toContain("第一条待补投");
		expect(sections[DISPATCH_NOTIFY_SECTION]).toContain("第二条同批");
	});

	it("shutdown 后不再唤醒且不接收新通知;新扩展实例的新通知面独立可用", () => {
		let oldWakes = 0;
		const oldSurface = createDispatchNotifySurface({
			resolvePaoHome: () => undefined,
			wakeUp: () => {
				oldWakes++;
			},
		});
		oldSurface.notify("旧任务");
		oldSurface.shutdown();
		oldSurface.notify("旧任务晚到");
		expect(oldWakes).toBe(1);
		expect(oldSurface.unreadCount()).toBe(0);

		let newWakes = 0;
		const newSurface = createDispatchNotifySurface({
			resolvePaoHome: () => undefined,
			wakeUp: () => {
				newWakes++;
			},
		});
		newSurface.notify("新会话通知");
		expect(newWakes).toBe(1);
		expect(newSurface.unreadCount()).toBe(1);
	});

	it("大量普通通知消费后不保留正文和 key;监督确认项注入后仍等待显式处理", () => {
		const surface = createDispatchNotifySurface({ resolvePaoHome: () => undefined });
		let handled = 0;
		for (let index = 0; index < 200; index++) surface.notify(`普通通知 ${index}`);
		surface.notify("工人仍运行", undefined, undefined, {
			key: "supervision:worker:1",
			retainAfterInjected: true,
			onHandled: () => {
				handled++;
			},
		});
		const sections: Record<string, string> = {};
		surface.inject({ systemPromptOptions: { sections } });
		expect(sections[DISPATCH_NOTIFY_SECTION]).toContain("工人仍运行");
		expect(surface.unreadCount()).toBe(0);
		expect(surface.retainedCount()).toBe(1);
		expect(handled).toBe(0);
		expect(surface.markHandled("supervision:worker:1")).toBe(true);
		expect(handled).toBe(1);
		expect(surface.retainedCount()).toBe(0);
	});

	it("同 key 未处理时去重并更新正文;显式处理后才可再次排队", () => {
		const surface = createDispatchNotifySurface({ resolvePaoHome: () => undefined });
		const events: string[] = [];
		surface.subscribe((change) => {
			events.push(change.type);
		});
		surface.notify("旧摘要", undefined, undefined, { key: "k", retainAfterInjected: true });
		surface.notify("新摘要", undefined, undefined, { key: "k", retainAfterInjected: true });
		expect(surface.unreadCount()).toBe(1);
		const sections: Record<string, string> = {};
		surface.inject({ systemPromptOptions: { sections } });
		expect(sections[DISPATCH_NOTIFY_SECTION]).toContain("新摘要");
		expect(sections[DISPATCH_NOTIFY_SECTION]).not.toContain("旧摘要");
		expect(events).toContain("injected");
		expect(events).not.toContain("handled");
		surface.markHandled("k");
		expect(events).toContain("handled");
		surface.notify("下一周期", undefined, undefined, { key: "k", retainAfterInjected: true });
		expect(surface.unreadCount()).toBe(1);
	});

	it("shutdown 向已有订阅者广播一次,随后旧订阅和通知失效", () => {
		const surface = createDispatchNotifySurface({ resolvePaoHome: () => undefined });
		const changes: string[] = [];
		surface.subscribe((change) => changes.push(change.type));
		surface.shutdown();
		surface.shutdown();
		surface.notify("关闭后的通知");
		expect(changes).toEqual(["shutdown"]);
		expect(surface.unreadCount()).toBe(0);
	});
});

describe("dispatch notify:显式类别与现有 wakePending 重放", () => {
	it("普通 progress 只进缓冲,不启动模型回合", () => {
		let wakes = 0;
		const surface = createDispatchNotifySurface({
			resolvePaoHome: () => undefined,
			wakeUp: () => {
				wakes++;
			},
		});
		surface.notify("普通无变化轮询", undefined, undefined, { category: "progress" });
		expect(wakes).toBe(0);
		expect(surface.unreadCount()).toBe(0);

		const sections: Record<string, string> = {};
		surface.inject({ systemPromptOptions: { sections } });
		expect(sections[DISPATCH_NOTIFY_SECTION]).toContain("普通无变化轮询");
	});

	it("保留型 progress 注入后仍等待显式处理但不计入后台未读", () => {
		let wakes = 0;
		const surface = createDispatchNotifySurface({
			resolvePaoHome: () => undefined,
			wakeUp: () => {
				wakes++;
			},
		});
		surface.notify("等待事件", undefined, undefined, {
			category: "progress",
			key: "chain:progress",
			retainAfterInjected: true,
		});
		expect(wakes).toBe(0);
		expect(surface.unreadCount()).toBe(0);
		const sections: Record<string, string> = {};
		surface.inject({ systemPromptOptions: { sections } });
		expect(sections[DISPATCH_NOTIFY_SECTION]).toContain("等待事件");
		expect(surface.unreadCount()).toBe(0);
		expect(surface.retainedCount()).toBe(1);
		expect(surface.markHandled("chain:progress")).toBe(true);
		expect(surface.retainedCount()).toBe(0);
	});

	it("正文缓冲可同时留 progress 与终态,只有需要处理的通知计入后台未读", () => {
		const surface = createDispatchNotifySurface({ resolvePaoHome: () => undefined });
		surface.notify("普通进度", undefined, undefined, { category: "progress" });
		expect(surface.unreadCount()).toBe(0);
		surface.notify("待处理结果", undefined, undefined, { category: "result" });
		expect(surface.unreadCount()).toBe(1);

		const sections: Record<string, string> = {};
		surface.inject({ systemPromptOptions: { sections } });
		expect(sections[DISPATCH_NOTIFY_SECTION]).toContain("普通进度");
		expect(sections[DISPATCH_NOTIFY_SECTION]).toContain("待处理结果");
		expect(surface.unreadCount()).toBe(0);
	});

	it.each(["result", "failure", "ruling", "supervision"] as const)("%s 显式类别立即唤醒一次", (category) => {
		let wakes = 0;
		const surface = createDispatchNotifySurface({
			resolvePaoHome: () => undefined,
			wakeUp: () => {
				wakes++;
			},
		});
		surface.notify(`显式类别:${category}`, undefined, undefined, { category });
		expect(wakes).toBe(1);
	});

	it("注入前的连续终态由 wakePending 合并为一次,正文全部保留", () => {
		let wakes = 0;
		const surface = createDispatchNotifySurface({
			resolvePaoHome: () => undefined,
			wakeUp: () => {
				wakes++;
			},
		});
		surface.notify("第一份失败", undefined, undefined, { category: "failure" });
		surface.notify("普通进度", undefined, undefined, { category: "progress" });
		surface.notify("同批裁定", undefined, undefined, { category: "ruling" });
		expect(wakes).toBe(1);

		const sections: Record<string, string> = {};
		surface.inject({ systemPromptOptions: { sections } });
		expect(sections[DISPATCH_NOTIFY_SECTION]).toContain("第一份失败");
		expect(sections[DISPATCH_NOTIFY_SECTION]).toContain("普通进度");
		expect(sections[DISPATCH_NOTIFY_SECTION]).toContain("同批裁定");
	});

	it("分类来自调用方而不是正文关键词;未分类调用保留旧唤醒语义", () => {
		let wakes = 0;
		const surface = createDispatchNotifySurface({
			resolvePaoHome: () => undefined,
			wakeUp: () => {
				wakes++;
			},
		});
		surface.notify("[派卡失败] 仅作为进度正文", undefined, undefined, { category: "progress" });
		expect(wakes).toBe(0);

		surface.notify("普通文字但未分类的旧调用");
		expect(wakes).toBe(1);
	});

	it("注入前已合并为一次;注入后紧接的终态会开启下一轮,不靠计时器去重", () => {
		let wakes = 0;
		const surface = createDispatchNotifySurface({
			resolvePaoHome: () => undefined,
			wakeUp: () => {
				wakes++;
			},
		});
		surface.notify("先到失败", undefined, undefined, { category: "failure" });
		const sections: Record<string, string> = {};
		surface.inject({ systemPromptOptions: { sections } });
		expect(wakes).toBe(1);

		surface.notify("下一轮完成", undefined, undefined, { category: "result" });
		expect(wakes).toBe(2);
	});
});
