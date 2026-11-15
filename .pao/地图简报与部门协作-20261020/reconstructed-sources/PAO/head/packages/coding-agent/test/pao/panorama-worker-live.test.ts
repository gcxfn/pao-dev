/**
 * worker 实时页组件单测(全景三批·任务 3):WorkerLiveView 的 render 输出
 * (pid/卡号/命令截断/stdout 尾巴/页脚)、interval 自动刷新触发重绘、
 * q/Esc 退出清表、快照消失(settle)显示末态后自动 done、dispose 幂等清 interval。
 * fake tui/theme/keybindings,不做真键盘仿真。
 */

import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { KeybindingsManager } from "../../src/core/keybindings.ts";
import type { Theme } from "../../src/modes/interactive/theme/theme.ts";
import { type WorkerLiveSnapshot, WorkerLiveView } from "../../src/pao/panorama/worker-live.ts";

const tempCleanup: (() => void)[] = [];
afterEach(() => {
	for (const clean of tempCleanup.splice(0)) clean();
	vi.useRealTimers();
});

function fakeTui() {
	return { requestRender: vi.fn() } as unknown as TUI & { requestRender: ReturnType<typeof vi.fn> };
}

function fakeTheme() {
	return { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
}

function fakeKeybindings() {
	return {
		matches: (data: string, id: string) => id === "tui.select.cancel" && data === "\x1b",
	} as unknown as KeybindingsManager;
}

function snapshot(overrides: Partial<WorkerLiveSnapshot> = {}): WorkerLiveSnapshot {
	return {
		pid: 1234,
		卡号: "0007",
		命令: `node --mode json -p --no-session ${"x".repeat(200)}`,
		stdoutTail: () => ["第一行", "第二行"].join("\n"),
		...overrides,
	};
}

function makeView(
	options: {
		快照?: () => WorkerLiveSnapshot | undefined;
		done?: () => void;
		刷新毫秒?: number;
		末态停留毫秒?: number;
	} = {},
) {
	const tui = fakeTui();
	const done = options.done ?? vi.fn();
	const view = new WorkerLiveView(tui, fakeTheme(), fakeKeybindings(), {
		快照: options.快照 ?? (() => snapshot()),
		done,
		刷新毫秒: options.刷新毫秒 ?? 2000,
		末态停留毫秒: options.末态停留毫秒 ?? 1200,
	});
	return { view, tui, done };
}

describe("WorkerLiveView 渲染", () => {
	it("标题/命令行(截 120)/尾巴 15 行/页脚齐全", () => {
		const lines20 = Array.from({ length: 20 }, (_, i) => `行${i + 1}`);
		const tailFn = vi.fn((lineCount?: number) => lines20.slice(-(lineCount ?? 50)).join("\n"));
		const { view } = makeView({
			快照: () => snapshot({ 命令: `node --mode json ${"参数".repeat(80)}`, stdoutTail: tailFn }),
		});
		const lines = view.render(200);
		expect(lines[0]).toContain("worker pid 1234 · 卡0007");
		const commandLine = lines.find((line) => line.startsWith("命令:"))!;
		expect(commandLine).toContain("命令:");
		expect(commandLine.length).toBeLessThanOrEqual("命令:".length + 120);
		// 组件按末 15 行请求尾巴
		expect(tailFn).toHaveBeenCalledWith(15);
		const tailStart = lines.findIndex((line) => line.includes("stdout 末 15 行"));
		expect(tailStart).toBeGreaterThan(0);
		const shown = lines.slice(tailStart + 1).filter((line) => line.startsWith("行"));
		expect(shown).toHaveLength(15);
		expect(shown[0]).toBe("行6");
		expect(shown[14]).toBe("行20");
		expect(lines.at(-1)).toContain("q/Esc 退出 · 2s 自动刷新");
	});

	it("尾巴为空＝(尚无输出)空态;快照消失后末态提示与回执提示", () => {
		const { view } = makeView({ 快照: () => snapshot({ stdoutTail: () => "" }) });
		expect(view.render(200).join("\n")).toContain("（尚无输出）");
	});
});

describe("WorkerLiveView 刷新容错", () => {
	it("快照在 tick 抛错不炸:记警告后下个 tick 仍刷新,渲染继续", async () => {
		vi.useFakeTimers();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		let throwNext = true;
		const snapshotFn = vi.fn(() => {
			if (throwNext && snapshotFn.mock.calls.length > 1) throw new Error("快照炸了"); // 构造期首次取快照不炸
			return snapshot();
		});
		const { view, done } = makeView({ 快照: snapshotFn });
		await vi.advanceTimersByTimeAsync(2000);
		expect(snapshotFn.mock.calls.length).toBeGreaterThan(1);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("worker 实时页刷新失败"));
		// 下个 tick 仍工作:快照恢复后正常刷新,不 settle 不 done
		throwNext = false;
		await vi.advanceTimersByTimeAsync(2000);
		expect(view.render(200).join("\n")).toContain("worker pid 1234");
		expect(done).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it("stdoutTail 在 tick 抛错同样容错:警告一次且下个 tick 继续", async () => {
		vi.useFakeTimers();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		let throwNext = true;
		const snapshotFn = vi.fn(() =>
			snapshot({
				stdoutTail: () => {
					if (throwNext && snapshotFn.mock.calls.length > 1) throw new Error("尾巴炸了"); // 构造期首次不炸
					return "正常行";
				},
			}),
		);
		const { view, done } = makeView({ 快照: snapshotFn });
		await vi.advanceTimersByTimeAsync(2000);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("尾巴炸了"));
		throwNext = false;
		await vi.advanceTimersByTimeAsync(2000);
		expect(view.render(200).join("\n")).toContain("正常行");
		expect(done).not.toHaveBeenCalled();
		warn.mockRestore();
	});
});

describe("WorkerLiveView 生命周期", () => {
	it("interval 触发:重读快照并请求重绘;快照消失(settle)→末态提示后自动 done 且停表", async () => {
		vi.useFakeTimers();
		let snap: WorkerLiveSnapshot | undefined = snapshot();
		const snapshotFn = vi.fn(() => snap);
		const { view, tui, done } = makeView({ 快照: snapshotFn, 末态停留毫秒: 1200 });
		view.focused = true; // overlay 置焦(fake 不消费)
		const rendersBefore = tui.requestRender.mock.calls.length;
		await vi.advanceTimersByTimeAsync(2000);
		expect(snapshotFn.mock.calls.length).toBeGreaterThanOrEqual(2);
		expect(tui.requestRender.mock.calls.length).toBeGreaterThan(rendersBefore);
		// settle:快照消失 → 出末态帧 → 1.2s 后自动 done
		snap = undefined;
		await vi.advanceTimersByTimeAsync(2000);
		expect(view.render(200).join("\n")).toContain("worker 已 settle——回执按派单链路交卡");
		expect(done).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1200);
		expect(done).toHaveBeenCalledTimes(1);
		// 收口后不再刷新
		const rendersAtDone = tui.requestRender.mock.calls.length;
		await vi.advanceTimersByTimeAsync(10_000);
		expect(tui.requestRender.mock.calls.length).toBe(rendersAtDone);
	});

	it("q/Esc 退出:done 一次且 interval 清(不再触发快照)", async () => {
		vi.useFakeTimers();
		const snapshotFn = vi.fn(() => snapshot());
		const { view, done } = makeView({ 快照: snapshotFn });
		view.handleInput("q");
		expect(done).toHaveBeenCalledTimes(1);
		const calls = snapshotFn.mock.calls.length;
		await vi.advanceTimersByTimeAsync(10_000);
		expect(snapshotFn.mock.calls.length).toBe(calls);
		// Esc 同路;退出后按键忽略,不二次 done
		const { view: view2, done: done2 } = makeView({ 快照: snapshotFn });
		view2.handleInput("\x1b");
		expect(done2).toHaveBeenCalledTimes(1);
		view2.handleInput("q");
		expect(done2).toHaveBeenCalledTimes(1);
	});

	it("dispose 兜底:未走 done 直接卸载也清 interval(幂等,不二次 done)", async () => {
		vi.useFakeTimers();
		const snapshotFn = vi.fn(() => snapshot());
		const { view, done } = makeView({ 快照: snapshotFn });
		view.dispose();
		const calls = snapshotFn.mock.calls.length;
		await vi.advanceTimersByTimeAsync(10_000);
		expect(snapshotFn.mock.calls.length).toBe(calls);
		expect(done).not.toHaveBeenCalled();
		view.dispose(); // 幂等
		expect(done).not.toHaveBeenCalled();
	});

	it("普通键不退出", () => {
		const { view, done } = makeView();
		view.handleInput("a");
		view.handleInput("\r");
		expect(done).not.toHaveBeenCalled();
	});
});
