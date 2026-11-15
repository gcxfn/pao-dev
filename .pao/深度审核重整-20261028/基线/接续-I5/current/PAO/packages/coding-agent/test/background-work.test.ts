import { describe, expect, it, vi } from "vitest";
import {
	BackgroundWorkClosedError,
	type BackgroundWorkPort,
	BackgroundWorkSignal,
	bindBackgroundWorkPort,
	getBackgroundWorkPort,
	hasBackgroundWork,
	releaseBackgroundWorkPort,
} from "../src/core/background-work.ts";

function createPort(snapshot = { running: 0, unread: 0 }): BackgroundWorkPort {
	return {
		snapshot: () => snapshot,
		waitForChange: vi.fn(async () => {}),
		shutdown: vi.fn(),
	};
}

describe("后台工作生命周期", () => {
	it("按 SessionManager 对象身份绑定，且只释放预期端口", () => {
		const managerA = {};
		const managerB = {};
		const first = createPort();
		const replacement = createPort();

		bindBackgroundWorkPort(managerA, first);
		expect(getBackgroundWorkPort(managerA)).toBe(first);
		expect(getBackgroundWorkPort(managerB)).toBeUndefined();

		releaseBackgroundWorkPort(managerA, replacement);
		expect(getBackgroundWorkPort(managerA)).toBe(first);
		releaseBackgroundWorkPort(managerA, first);
		expect(getBackgroundWorkPort(managerA)).toBeUndefined();
		expect(first.shutdown).toHaveBeenCalledOnce();
	});

	it("在途工作或未读结果都视为尚未收敛", () => {
		expect(hasBackgroundWork({ running: 0, unread: 0 })).toBe(false);
		expect(hasBackgroundWork({ running: 1, unread: 0 })).toBe(true);
		expect(hasBackgroundWork({ running: 0, unread: 1 })).toBe(true);
	});

	it("检查快照与开始等待之间不丢变化", async () => {
		const signal = new BackgroundWorkSignal();
		const observed = signal.currentVersion;
		signal.changed();

		await expect(signal.waitForChange(undefined, observed)).resolves.toBeUndefined();
	});

	it("不轮询即可唤醒等待方，并在关闭时结束等待", async () => {
		const signal = new BackgroundWorkSignal();
		const observed = signal.currentVersion;
		const waiting = signal.waitForChange(undefined, observed);
		signal.shutdown();
		await expect(waiting).rejects.toBeInstanceOf(BackgroundWorkClosedError);
		await expect(signal.waitForChange()).rejects.toBeInstanceOf(BackgroundWorkClosedError);
	});

	it("等待变化期间支持取消", async () => {
		const signal = new BackgroundWorkSignal();
		const controller = new AbortController();
		const observed = signal.currentVersion;
		const waiting = signal.waitForChange(controller.signal, observed);
		controller.abort(new Error("stopped"));

		await expect(waiting).rejects.toThrow("stopped");
	});
});
