/**
 * S8-TUI1 常驻摘要：footer 折叠行（当前任务＋完成 n/m）＋ /todo 展开挂件（四态、上限 8＋剩余计数）。
 * 口径：取数走 currentTodos 权威源（查询＋订阅，不重放时间线）；仅 TUI 模式渲染（rpc/json 零输出，
 * 桌面壳归 S8-桌面1）；空清单隐藏；切会话/分支自动收起（桌面 TodoDock 同款交互）。
 * 渲染复用 renderTodoList（四态符号与分母扣 cancelled 的唯一家在 todo/index.ts，这里不另立）。
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import type { ReadonlyFooterDataProvider } from "../../src/core/footer-data-provider.ts";
import { FooterComponent } from "../../src/modes/interactive/components/footer.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { renderTodoList, type TodoItem } from "../../src/pao/todo/index.ts";
import {
	formatTodoStatusLine,
	formatTodoWidgetLines,
	registerTodoSummary,
	TODO_STATUS_KEY,
} from "../../src/pao/ui/todo-summary.ts";

const LIST: TodoItem[] = [
	{ content: "搭骨架", status: "completed" },
	{ content: "写实现", status: "in_progress", activeForm: "正在写实现" },
	{ content: "跑测试", status: "pending" },
	{ content: "废弃路线", status: "cancelled" },
];

/** 记录型 mock（与 wiring-smoke 同款口径）：捕获命令与事件，可手动派发 */
function capturePi() {
	const commands = new Map<
		string,
		{ description?: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }
	>();
	const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
	const pi = {
		registerCommand: (
			name: string,
			def: { description?: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> },
		) => void commands.set(name, def),
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => undefined;
		},
	};
	return { pi: pi as never, commands, handlers };
}

/** TUI 上下文 mock：记录 setStatus/setWidget/notify 调用 */
function tuiCtx(mode: "tui" | "rpc" | "json" = "tui") {
	const setStatus = vi.fn();
	const setWidget = vi.fn();
	const notify = vi.fn();
	return {
		ctx: { mode, ui: { setStatus, setWidget, notify } } as unknown as ExtensionContext,
		setStatus,
		setWidget,
		notify,
	};
}

describe("折叠行 formatTodoStatusLine", () => {
	it("空清单隐藏（返回 undefined）", () => {
		expect(formatTodoStatusLine([])).toBeUndefined();
	});

	it("「待办 n/m」分母与 renderTodoList 同源（扣 cancelled）＋当前任务优先 activeForm", () => {
		// 复用钉子：n/m 必须等于 renderTodoList 表头里的数（分母规则不搬家）。
		// LIST＝1 completed＋1 in_progress＋1 pending＋1 cancelled → 完成 1/3。
		const header = renderTodoList(LIST).split("\n")[0];
		expect(header).toBe("待办 完成 1/3：");
		expect(formatTodoStatusLine(LIST)).toBe(`待办 1/3 · 正在写实现`);
	});

	it("无进行中项只显示完成度；全完成也不加尾巴", () => {
		expect(formatTodoStatusLine([{ content: "甲", status: "pending" }])).toBe("待办 0/1");
		const done: TodoItem[] = [
			{ content: "甲", status: "completed" },
			{ content: "乙", status: "cancelled" },
		];
		expect(formatTodoStatusLine(done)).toBe("待办 1/1");
	});

	it("长中文与含换行的 content 折成单行（页脚截断由原生 truncateToWidth 负责，这里保证不破行结构）", () => {
		const long: TodoItem[] = [{ content: `很长的中文任务描述${"很".repeat(120)}\n第二行`, status: "in_progress" }];
		const line = formatTodoStatusLine(long)!;
		expect(line).not.toContain("\n");
		expect(line).toContain("待办 0/1");
	});
});

describe("展开列表 formatTodoWidgetLines", () => {
	it("空清单隐藏；条目行与 renderTodoList 完全同源（四态符号 ○◐✓⊘ 一致）", () => {
		expect(formatTodoWidgetLines([])).toBeUndefined();
		expect(formatTodoWidgetLines(LIST)).toEqual(renderTodoList(LIST).split("\n").slice(1));
		expect(formatTodoWidgetLines(LIST)![1]).toContain("◐");
		expect(formatTodoWidgetLines(LIST)![3]).toContain("⊘");
	});

	it("超过 8 项只显示 8 行＋剩余计数行（挂件总量低于原生 MAX_WIDGET_LINES=10）", () => {
		const many: TodoItem[] = Array.from({ length: 10 }, (_, i) => ({ content: `任务${i + 1}`, status: "pending" }));
		const lines = formatTodoWidgetLines(many)!;
		expect(lines).toHaveLength(9);
		expect(lines[7]).toBe("○ 任务8");
		expect(lines[8]).toBe("… 还有 2 项");
	});

	it("含换行的条目折成单行不破列表结构", () => {
		const lines = formatTodoWidgetLines([{ content: "甲\n乙", status: "pending" }])!;
		expect(lines).toEqual(["○ 甲 乙"]);
	});
});

describe("常驻摘要接线 registerTodoSummary", () => {
	it("挂 tool_result/session_start/session_tree 三处刷新＋/todo 命令；折叠态下每轮取数只写 footer 行", async () => {
		const mock = capturePi();
		let todos: TodoItem[] = LIST;
		registerTodoSummary(mock.pi, { currentTodos: () => todos });
		expect([...mock.commands.keys()]).toEqual(["todo"]);
		for (const event of ["tool_result", "session_start", "session_tree"])
			expect(mock.handlers.get(event)).toHaveLength(1);

		const view = tuiCtx();
		for (const handler of mock.handlers.get("tool_result") ?? []) await handler({ toolName: "todo_write" }, view.ctx);
		expect(view.setStatus).toHaveBeenCalledWith(TODO_STATUS_KEY, "待办 1/3 · 正在写实现");
		expect(view.setWidget).toHaveBeenCalledWith("todo-summary", undefined);

		// 查询口径：下一轮 currentTodos 变了，同一条 tool_result 钩子拿到新数据（不重放时间线）
		todos = [{ content: "新任务", status: "completed" }];
		for (const handler of mock.handlers.get("tool_result") ?? []) await handler({ toolName: "bash" }, view.ctx);
		expect(view.setStatus).toHaveBeenLastCalledWith(TODO_STATUS_KEY, "待办 1/1");
	});

	it("/todo 展开挂件再收起；空清单 /todo 只提示不切换", async () => {
		const mock = capturePi();
		let todos: TodoItem[] = LIST;
		registerTodoSummary(mock.pi, { currentTodos: () => todos });
		const handler = mock.commands.get("todo")!.handler;
		const view = tuiCtx();

		await handler("", view.ctx);
		expect(view.setWidget).toHaveBeenLastCalledWith("todo-summary", formatTodoWidgetLines(LIST));
		await handler("", view.ctx);
		expect(view.setWidget).toHaveBeenLastCalledWith("todo-summary", undefined);

		const emptyView = tuiCtx();
		todos = [];
		await handler("", emptyView.ctx);
		expect(emptyView.notify).toHaveBeenCalledOnce();
		expect(emptyView.setWidget).not.toHaveBeenCalled();
	});

	it("切会话/分支（session_start/session_tree）自动收起并按新清单刷新", async () => {
		const mock = capturePi();
		let todos: TodoItem[] = LIST;
		registerTodoSummary(mock.pi, { currentTodos: () => todos });
		const view = tuiCtx();
		await mock.commands.get("todo")!.handler("", view.ctx);
		expect(view.setWidget).toHaveBeenLastCalledWith("todo-summary", expect.any(Array));

		todos = [{ content: "恢复后的任务", status: "in_progress" }];
		for (const handler of mock.handlers.get("session_start") ?? []) await handler(undefined, view.ctx);
		expect(view.setWidget).toHaveBeenLastCalledWith("todo-summary", undefined);
		expect(view.setStatus).toHaveBeenLastCalledWith(TODO_STATUS_KEY, "待办 0/1 · 恢复后的任务");

		todos = LIST;
		for (const handler of mock.handlers.get("session_tree") ?? []) await handler(undefined, view.ctx);
		expect(view.setWidget).toHaveBeenLastCalledWith("todo-summary", undefined);
		expect(view.setStatus).toHaveBeenLastCalledWith(TODO_STATUS_KEY, "待办 1/3 · 正在写实现");
	});

	it("空清单 footer 行隐藏（setStatus(key, undefined)）；非 TUI 模式零输出（rpc/json 不发桌面壳）", async () => {
		const mock = capturePi();
		let todos: TodoItem[] = [];
		registerTodoSummary(mock.pi, { currentTodos: () => todos });
		const tui = tuiCtx();
		for (const handler of mock.handlers.get("tool_result") ?? []) await handler({}, tui.ctx);
		expect(tui.setStatus).toHaveBeenCalledWith(TODO_STATUS_KEY, undefined);
		expect(tui.setWidget).toHaveBeenCalledWith("todo-summary", undefined);

		const rpc = tuiCtx("rpc");
		todos = LIST;
		for (const handler of mock.handlers.get("tool_result") ?? []) await handler({}, rpc.ctx);
		for (const handler of mock.handlers.get("session_start") ?? []) await handler(undefined, rpc.ctx);
		await mock.commands.get("todo")!.handler("", rpc.ctx);
		expect(rpc.setStatus).not.toHaveBeenCalled();
		expect(rpc.setWidget).not.toHaveBeenCalled();
	});
});

describe("窄窗验证（footer 既有口径：任意行 visibleWidth ≤ 终端宽）", () => {
	it("长中文待办行在 30 列终端不超宽", () => {
		initTheme(undefined, false);
		const longLine = formatTodoStatusLine([
			{ content: `中文任务描述很长很长${"长".repeat(60)}`, status: "in_progress" },
			{ content: "另一项", status: "completed" },
		])!;
		expect(longLine.length).toBeGreaterThan(30);
		const footerData = {
			getGitBranch: () => "main",
			getExtensionStatuses: () => new Map([[TODO_STATUS_KEY, longLine]]),
			getAvailableProviderCount: () => 1,
			onBranchChange: () => () => {},
		} as unknown as ReadonlyFooterDataProvider;
		const session = {
			state: { model: { id: "m", provider: "p", contextWindow: 1, reasoning: false }, thinkingLevel: "off" },
			sessionManager: {
				getEntries: () => [],
				getEntryCount: () => 0,
				getSessionId: () => "s",
				getLeafId: () => null,
				getSessionName: () => "",
				getCwd: () => "/tmp",
			},
		};
		for (const width of [30, 40, 80])
			for (const line of new FooterComponent(session as never, footerData).render(width))
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});
});
