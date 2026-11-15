/**
 * S8 会话 todo（todo_write 工具包）行为面：
 * 四态整表替换/清空/校验拒绝不覆写、toolResult details＋getBranch 重建（含压缩快照载体）、
 * tool_result 扩展事件陈旧提醒（阈值 5、只计成功实质调用、同陈旧期一次、更新即重置）、
 * 压缩二道防线（快照条目＋context 再注入）、关闭清理。
 * 卡（cards/）仍是跨会话任务唯一真相——本清单只管单会话执行步骤（M1-04 边界）。
 */
import { describe, expect, it } from "vitest";
import type { ExtensionContext, ToolDefinition, ToolResultEventResult } from "../../src/core/extensions/types.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import {
	normalizeTodoList,
	registerTodo,
	renderTodoList,
	scanTodoState,
	TODO_REMINDER_MARKER,
	TODO_STATUSES,
	type TodoItem,
	type TodoState,
} from "../../src/pao/todo/index.ts";

type Handler = (event: never, ctx: never) => unknown;

/** 记录型 mock：捕获工具注册、事件处理器与 appendEntry（与 healthcheck/wiring 冒烟同款口径） */
function capturePi() {
	const tools: ToolDefinition[] = [];
	const handlers = new Map<string, Handler[]>();
	const appended: { customType: string; data: unknown }[] = [];
	const pi = {
		registerTool: (tool: ToolDefinition) => void tools.push(tool),
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => undefined;
		},
		appendEntry: (customType: string, data?: unknown) => void appended.push({ customType, data }),
	};
	return { pi: pi as never, tools, handlers, appended };
}

/** 可变分支条目的假 sessionManager（重建测试里中途改条目再触发 session_start） */
function contextWith(entries: SessionEntry[]) {
	return {
		sessionManager: {
			getBranch: () => entries,
			getSessionId: () => "s-todo",
		},
	} as unknown as ExtensionContext;
}

function toolResultEntry(toolName: string, details: unknown, isError = false): SessionEntry {
	return {
		type: "message",
		id: `m-${toolName}-${Math.random().toString(36).slice(2, 8)}`,
		timestamp: new Date().toISOString(),
		parentId: undefined,
		message: {
			role: "toolResult",
			toolCallId: "t1",
			toolName,
			content: [{ type: "text", text: "ok" }],
			isError,
			details,
			timestamp: Date.now(),
		},
	} as unknown as SessionEntry;
}

function todoState(todos: TodoItem[]): TodoState {
	return { version: 1, todos };
}

const LIST_2: TodoItem[] = [
	{ content: "写实现", status: "in_progress" },
	{ content: "跑测试", status: "pending" },
];

/** 直接驱动注册工具的 execute（模拟模型调用成功路径） */
async function callExecute(tool: ToolDefinition, todos: unknown) {
	return tool.execute("t1", { todos } as never, undefined, undefined, {} as never);
}

/** 触发 tool_result 处理器并合并返回（单 handler 场景） */
async function fireToolResult(
	handlers: Map<string, Handler[]>,
	toolName: string,
	opts: { isError?: boolean } = {},
): Promise<ToolResultEventResult | undefined> {
	const list = handlers.get("tool_result") ?? [];
	let merged: ToolResultEventResult | undefined;
	for (const handler of list) {
		const result = (await handler(
			{
				type: "tool_result",
				toolCallId: "t-1",
				toolName,
				input: {},
				content: [{ type: "text", text: `ok ${toolName}` }],
				isError: opts.isError ?? false,
			} as never,
			{} as never,
		)) as ToolResultEventResult | undefined;
		if (result) merged = { ...merged, ...result };
	}
	return merged;
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

describe("todo_write 注册与可发现性", () => {
	it("注册 todo_write；带 promptSnippet 与 promptGuidelines（否则模型发现不了）；四态枚举", () => {
		const { pi, tools } = capturePi();
		registerTodo(pi);
		const tool = tools.find((entry) => entry.name === "todo_write");
		expect(tool).toBeDefined();
		expect(tool!.promptSnippet).toBeTruthy();
		expect(tool!.promptGuidelines?.length).toBeGreaterThan(0);
		expect([...TODO_STATUSES]).toEqual(["pending", "in_progress", "completed", "cancelled"]);
		// 桌面时间线自动识别链是 /todo/i（desktop todo-table isTodoToolCall）——名字必须命中
		expect(/todo/i.test("todo_write")).toBe(true);
	});
});

describe("normalizeTodoList（校验与规范化）", () => {
	it("全量收下合法清单；content 去首尾空白；空白 activeForm 丢弃、有效 activeForm 保留", () => {
		const normalized = normalizeTodoList({
			todos: [
				{ content: "  写实现  ", status: "in_progress", activeForm: "  " },
				{ content: "跑测试", status: "pending", activeForm: "正在跑测试" },
			],
		});
		expect(normalized.error).toBeUndefined();
		expect(normalized.todos).toEqual([
			{ content: "写实现", status: "in_progress" },
			{ content: "跑测试", status: "pending", activeForm: "正在跑测试" },
		]);
	});

	it("空数组合法（清空）", () => {
		expect(normalizeTodoList({ todos: [] })).toEqual({ todos: [] });
	});

	it("拒绝：非数组、空白 content、非法 status、trim 后重复、超过 20 项", () => {
		expect(normalizeTodoList({ todos: "x" }).error).toBeTruthy();
		expect(normalizeTodoList({ todos: [{ content: "  ", status: "pending" }] }).error).toBeTruthy();
		expect(normalizeTodoList({ todos: [{ content: "a", status: "done" }] }).error).toBeTruthy();
		expect(
			normalizeTodoList({
				todos: [
					{ content: "a", status: "pending" },
					{ content: " a ", status: "pending" },
				],
			}).error,
		).toBeTruthy();
		const tooMany = Array.from({ length: 21 }, (_, i) => ({ content: `步骤${i}`, status: "pending" }));
		expect(normalizeTodoList({ todos: tooMany }).error).toContain("20");
		expect(normalizeTodoList({ todos: tooMany.slice(0, 20) }).error).toBeUndefined();
	});
});

describe("todo_write 执行（整表替换与不覆写）", () => {
	it("整表替换：第二次调用后 details 只含新表；返回文本渲染四态符号与条目", async () => {
		const { pi, tools } = capturePi();
		registerTodo(pi);
		const tool = tools.find((entry) => entry.name === "todo_write")!;
		await callExecute(tool, [{ content: "旧步骤", status: "completed" }]);
		const second = await callExecute(tool, LIST_2);
		expect((second.details as TodoState).todos).toEqual(LIST_2);
		expect(resultText(second)).toContain("◐ 写实现");
		expect(resultText(second)).toContain("○ 跑测试");
	});

	it("空数组清空；details 为空表", async () => {
		const { pi, tools } = capturePi();
		registerTodo(pi);
		const tool = tools.find((entry) => entry.name === "todo_write")!;
		await callExecute(tool, LIST_2);
		const cleared = await callExecute(tool, []);
		expect((cleared.details as TodoState).todos).toEqual([]);
		expect(resultText(cleared)).toContain("清空");
	});

	it("非法输入返回错误结果且不覆写旧清单（details 保持旧表）", async () => {
		const { pi, tools } = capturePi();
		registerTodo(pi);
		const tool = tools.find((entry) => entry.name === "todo_write")!;
		await callExecute(tool, LIST_2);
		for (const bad of [
			[{ content: "  ", status: "pending" }],
			[{ content: "a", status: "done" }],
			[
				{ content: "写实现", status: "pending" },
				{ content: " 写实现", status: "completed" },
			],
			Array.from({ length: 21 }, (_, i) => ({ content: `步骤${i}`, status: "pending" })),
		]) {
			const rejected = await callExecute(tool, bad);
			expect(rejected.isError).toBe(true);
			expect((rejected.details as TodoState).todos).toEqual(LIST_2);
			expect(resultText(rejected)).toContain("拒绝");
		}
	});
});

describe("getBranch 重建（会话切换/恢复/分支）", () => {
	it("扫 toolResult details 后者胜；错误结果的 details 不改状态；快照条目也是载体", () => {
		const entries = [
			toolResultEntry("todo_write", todoState([{ content: "旧", status: "pending" }])),
			toolResultEntry("todo_write", todoState(LIST_2), true),
			{
				type: "custom",
				customType: "pao-todo-snapshot",
				data: todoState([{ content: "压缩后", status: "in_progress" }]),
			} as unknown as SessionEntry,
			toolResultEntry("todo_write", todoState([{ content: "最新", status: "completed" }])),
		];
		const scan = scanTodoState(entries);
		expect(scan.todos).toEqual([{ content: "最新", status: "completed" }]);
		// 压缩前旧 toolResult 已出模型视野，文件级重建仍从快照条目续上
		const compactedOnly = scanTodoState([entries[0], entries[2]]);
		expect(compactedOnly.todos).toEqual([{ content: "压缩后", status: "in_progress" }]);
	});

	it("实质计数自快照/上次 todo_write 起累计；失败与读取类不计；提醒标记置已提醒", () => {
		const entries: SessionEntry[] = [
			toolResultEntry("todo_write", todoState(LIST_2)),
			toolResultEntry("bash", undefined),
			toolResultEntry("edit", undefined),
			toolResultEntry("bash", undefined, true),
			toolResultEntry("read", undefined),
			toolResultEntry("todo_write", todoState(LIST_2), true),
		];
		expect(scanTodoState(entries).staleCount).toBe(2);
		// 提醒已追加过（标记在 content 里）→ 同陈旧期视为已提醒，但计数照常累计
		const bashWithMarker = () =>
			({
				type: "message",
				id: "m-bash-marker",
				message: {
					role: "toolResult",
					toolCallId: "t1",
					toolName: "bash",
					content: [{ type: "text", text: `ok\n${TODO_REMINDER_MARKER} 已连续 5 次…` }],
					isError: false,
					timestamp: Date.now(),
				},
			}) as never as SessionEntry;
		const withMarker = [...entries, bashWithMarker()];
		const markerScan = scanTodoState(withMarker);
		expect(markerScan.staleCount).toBe(3);
		expect(markerScan.reminded).toBe(true);
		expect(scanTodoState([...entries, toolResultEntry("bash", undefined)]).reminded).toBe(false);
		expect(
			scanTodoState([...entries, ...Array.from({ length: 3 }, () => toolResultEntry("write", undefined))])
				.staleCount,
		).toBe(5);
	});

	it("session_start/session_tree 重建内存态（currentTodos 反映分支）", async () => {
		const { pi, handlers } = capturePi();
		const face = registerTodo(pi);
		const entries: SessionEntry[] = [toolResultEntry("todo_write", todoState(LIST_2))];
		await handlers.get("session_start")![0](undefined as never, contextWith(entries) as never);
		expect([...face.currentTodos()]).toEqual(LIST_2);
		entries.push(toolResultEntry("todo_write", todoState([{ content: "分支新表", status: "pending" }])));
		await handlers.get("session_tree")![0](undefined as never, contextWith(entries) as never);
		expect([...face.currentTodos()]).toEqual([{ content: "分支新表", status: "pending" }]);
	});
});

describe("陈旧提醒（tool_result 扩展事件，阈值 5）", () => {
	async function armed() {
		const captured = capturePi();
		registerTodo(captured.pi);
		const tool = captured.tools.find((entry) => entry.name === "todo_write")!;
		await callExecute(tool, LIST_2);
		return captured;
	}

	it("清单为空不提醒；失败/读取类/todo_write 自身不计数", async () => {
		const empty = capturePi();
		registerTodo(empty.pi);
		for (let i = 0; i < 8; i++) await fireToolResult(empty.handlers, "bash");
		expect(await fireToolResult(empty.handlers, "bash")).toBeUndefined();

		const { handlers } = await armed();
		for (const miss of [
			{ toolName: "bash", isError: true },
			{ toolName: "read", isError: false },
			{ toolName: "grep", isError: false },
			{ toolName: "todo_write", isError: false },
		]) {
			expect(await fireToolResult(handlers, miss.toolName, { isError: miss.isError })).toBeUndefined();
		}
	});

	it("第 5 次成功实质调用追加一行对账提醒（含当前清单）；第 6 次不再提醒", async () => {
		const { handlers } = await armed();
		for (let i = 0; i < 4; i++) expect(await fireToolResult(handlers, "bash")).toBeUndefined();
		const fifth = await fireToolResult(handlers, "edit");
		expect(fifth?.content).toHaveLength(2);
		expect(fifth?.content?.[1]).toMatchObject({ type: "text" });
		expect((fifth?.content?.[1] as { text: string }).text).toContain(TODO_REMINDER_MARKER);
		expect((fifth?.content?.[1] as { text: string }).text).toContain("写实现");
		// 原文本保留在首位
		expect((fifth?.content?.[0] as { text: string }).text).toBe("ok edit");
		expect(await fireToolResult(handlers, "bash")).toBeUndefined();
	});

	it("成功 todo_write 后重置（再需 5 次）；失败的 todo_write 不重置", async () => {
		const { tools, handlers } = await armed();
		const tool = tools.find((entry) => entry.name === "todo_write")!;
		for (let i = 0; i < 4; i++) await fireToolResult(handlers, "bash");
		await callExecute(tool, [{ content: "重构后的新表", status: "in_progress" }]);
		expect(await fireToolResult(handlers, "write")).toBeUndefined();
		// 重置后再满 5 次才提醒：已 1 次，再补 3 次（共 4）都静默
		for (let i = 0; i < 3; i++) expect(await fireToolResult(handlers, "write")).toBeUndefined();
		const fifth = await fireToolResult(handlers, "bash");
		expect((fifth?.content?.[1] as { text: string } | undefined)?.text).toContain(TODO_REMINDER_MARKER);
		// 失败的 todo_write 不重置计数
		await fireToolResult(handlers, "todo_write", { isError: true });
		expect(await fireToolResult(handlers, "bash")).toBeUndefined();
	});
});

describe("压缩二道防线（快照条目＋context 再注入）", () => {
	it("压缩成功：非空清单落 pao-todo-snapshot 条目；context 事件注入当前清单渲染", async () => {
		const { pi, tools, handlers, appended } = capturePi();
		registerTodo(pi);
		const tool = tools.find((entry) => entry.name === "todo_write")!;
		await callExecute(tool, LIST_2);
		await handlers.get("session_before_compact")![0](undefined as never, {} as never);
		await handlers.get("session_compact")![0](undefined as never, {} as never);
		expect(appended).toHaveLength(1);
		expect(appended[0].customType).toBe("pao-todo-snapshot");
		expect((appended[0].data as TodoState).todos).toEqual(LIST_2);
		const injected = (await handlers.get("context")![0]({ messages: [] } as never, {} as never)) as {
			messages: Array<{ role: string; customType: string; content: string; display: boolean }>;
		};
		const message = injected.messages.at(-1)!;
		expect(message.role).toBe("custom");
		expect(message.customType).toBe("pao-todo-snapshot");
		expect(message.display).toBe(false);
		expect(message.content).toContain("写实现");
	});

	it("压缩后清单再更新：注入的是最新清单，不是快照旧值", async () => {
		const { pi, tools, handlers } = capturePi();
		registerTodo(pi);
		const tool = tools.find((entry) => entry.name === "todo_write")!;
		await callExecute(tool, LIST_2);
		await handlers.get("session_before_compact")![0](undefined as never, {} as never);
		await handlers.get("session_compact")![0](undefined as never, {} as never);
		await callExecute(tool, [{ content: "压缩后新表", status: "in_progress" }]);
		const injected = (await handlers.get("context")![0]({ messages: [] } as never, {} as never)) as {
			messages: Array<{ content: string }>;
		};
		expect(injected.messages.at(-1)!.content).toContain("压缩后新表");
		expect(injected.messages.at(-1)!.content).not.toContain("跑测试");
	});

	it("压缩失败不落条目；空清单压缩不落条目、不注入", async () => {
		const { pi, tools, handlers, appended } = capturePi();
		registerTodo(pi);
		const tool = tools.find((entry) => entry.name === "todo_write")!;
		await callExecute(tool, LIST_2);
		await handlers.get("session_before_compact")![0](undefined as never, {} as never);
		await handlers.get("session_compact_failed")![0](undefined as never, {} as never);
		await handlers.get("session_compact")![0](undefined as never, {} as never);
		expect(appended).toHaveLength(0);
		const injected = await handlers.get("context")![0]({ messages: [] } as never, {} as never);
		expect(injected).toBeUndefined();

		const empty = capturePi();
		registerTodo(empty.pi);
		await handlersSession(empty.handlers, "session_before_compact");
		await handlersSession(empty.handlers, "session_compact");
		expect(empty.appended).toHaveLength(0);
	});
});

describe("关闭清理", () => {
	it("session_shutdown 后内存态清空、注入关闭", async () => {
		const { pi, tools, handlers } = capturePi();
		registerTodo(pi);
		const tool = tools.find((entry) => entry.name === "todo_write")!;
		await callExecute(tool, LIST_2);
		await handlers.get("session_before_compact")![0](undefined as never, {} as never);
		await handlers.get("session_compact")![0](undefined as never, {} as never);
		await handlers.get("session_shutdown")![0](undefined as never, {} as never);
		expect(await fireToolResult(handlers, "bash")).toBeUndefined();
		const injected = await handlers.get("context")![0]({ messages: [] } as never, {} as never);
		expect(injected).toBeUndefined();
	});
});

async function handlersSession(handlers: Map<string, Handler[]>, event: string) {
	for (const handler of handlers.get(event) ?? []) await handler(undefined as never, {} as never);
}

describe("renderTodoList（TUI 与提醒共用渲染）", () => {
	it("四态符号＋完成度（分母不含 cancelled）", () => {
		const text = renderTodoList([
			{ content: "a", status: "completed" },
			{ content: "b", status: "in_progress" },
			{ content: "c", status: "cancelled" },
			{ content: "d", status: "pending" },
		]);
		expect(text).toContain("✓ a");
		expect(text).toContain("◐ b");
		expect(text).toContain("⊘ c");
		expect(text).toContain("○ d");
		expect(text).toContain("1/3");
	});
});
