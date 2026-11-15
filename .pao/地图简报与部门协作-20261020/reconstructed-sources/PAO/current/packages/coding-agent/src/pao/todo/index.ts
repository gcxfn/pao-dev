/**
 * S8 会话 todo：`todo_write` 工具（四态、整表替换）＋ 陈旧提醒 ＋ 压缩留存。
 *
 * - 状态只存 toolResult details（无外部文件），getBranch() 逆扫重建——分支/切换/恢复天然正确
 *   （机制循上游示例 examples/extensions/todo.ts；形状按 S8 定案自建：四态/全量替换/校验）。
 * - 压缩后旧 toolResult 出模型视野（文件级仍安全），二道防线：pao-todo-snapshot 快照条目
 *   ＋ context 事件再注入当前清单（口径同 pao/memory/compaction-state.ts）。
 * - 陈旧提醒走扩展事件 tool_result（agent-session 已把 afterToolCall 分发为该事件，零内核改动）：
 *   清单非空时，成功实质调用（bash/powershell/write/edit/multiedit）每满 5 次提醒一次；
 *   失败/读取类/todo_write 自身不计；成功 todo_write 即重置。阈值为常量，不建配置系统。
 * - 卡（cards/）仍是跨会话任务唯一真相（M1-04 边界）：本清单只管单会话执行步骤。
 * - CompactionEntry.details 无法由扩展单独写入（只有提供整套 compaction result 才能带上，
 *   agent-session.ts compact() 的 details 只来自 result/默认生成器）——快照条目是等价的
 *   压缩边界持久化，且可被重建扫描直接续读。
 * - 纯原语（模型/校验/扫描/文本渲染）在 ./core.ts（零运行时外部依赖）；本模块只留接线
 *   （todo_write 注册，pi-tui Text/typebox 仅在此），桌面消费图经 summary 面不进本模块
 *   （S10-P1：vendor 物化树 pi-tui 不可达，桌面 dist 图不得触 TUI 专属依赖）。
 */
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import {
	isTodoState,
	normalizeTodoList,
	renderTodoList,
	SNAPSHOT_CUSTOM_TYPE,
	STALE_REMINDER_THRESHOLD,
	STATUS_GLYPH,
	SUBSTANTIVE_TOOLS,
	scanTodoState,
	TODO_REMINDER_MARKER,
	TODO_STATUSES,
	TODO_WRITE_TOOL_NAME,
	type TodoItem,
	type TodoState,
	type TodoStatus,
} from "./core.ts";

// 纯函数公开面（S9 抽取的窄导出，实现已迁 ./core.ts；此处原样再导出保住既有消费面）
export {
	isTodoState,
	normalizeTodoList,
	renderTodoList,
	scanTodoState,
	TODO_REMINDER_MARKER,
	TODO_STATUSES,
	TODO_WRITE_TOOL_NAME,
	type TodoItem,
	type TodoScanResult,
	type TodoState,
	type TodoStatus,
} from "./core.ts";

const TodoWriteParams = Type.Object({
	todos: Type.Array(
		Type.Object({
			content: Type.String({ description: "祈使句任务描述，非空且互不重复" }),
			status: Type.Union(
				TODO_STATUSES.map((status) => Type.Literal(status)),
				{ description: "pending 未开始 / in_progress 进行中 / completed 已完成并验证 / cancelled 已取消" },
			),
			activeForm: Type.Optional(Type.String({ description: "进行时表述（如「正在跑测试」），可选" })),
		}),
		{ description: "整张清单全量替换（不是增量修改）；空数组=清空；上限 20 项" },
	),
});

/**
 * 注册 todo_write 工具与全部接线（全角色；不进 role.ts 任何 SKIPPED 清单）。
 * 返回只读取数口供同进程消费方（S8-TUI1 常驻摘要 setStatus；S8-内核2 回执对账用 scanTodoState）。
 */
export function registerTodo(pi: ExtensionAPI): { currentTodos: () => readonly TodoItem[] } {
	let todos: TodoItem[] = [];
	let staleCount = 0;
	let reminded = false;
	/** 压缩已发生标志（=分支上存在快照条目）；context 注入据此只在压缩后开闸 */
	let snapshot: TodoState | undefined;
	let pending: TodoState | undefined;

	const stateEnvelope = (): TodoState => ({ version: 1, todos: todos.map((t) => ({ ...t })) });

	const reconstruct = (ctx: ExtensionContext) => {
		const scan = scanTodoState(ctx.sessionManager.getBranch());
		todos = scan.todos;
		staleCount = scan.staleCount;
		reminded = scan.reminded;
		snapshot = scan.snapshot;
	};

	pi.on("session_start", (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", (_event, ctx) => reconstruct(ctx));
	pi.on("session_shutdown", () => {
		todos = [];
		staleCount = 0;
		reminded = false;
		snapshot = undefined;
		pending = undefined;
	});

	pi.registerTool({
		name: TODO_WRITE_TOOL_NAME,
		label: "待办清单",
		description: [
			"维护当前会话的任务待办清单（会话级，四态 pending/in_progress/completed/cancelled）。",
			"每次调用全量替换整张清单，不是增量修改；空数组清空。适用：任务至少三步、并行多任务、",
			"用户要求列计划或新指令改变计划。条目为祈使句且互不重复，上限 20 项；activeForm 可选。",
			"每完成一步（并已验证）立即更新状态，不攒批；同一时间只保留一项 in_progress。",
		].join(""),
		promptSnippet: "todo_write：维护会话待办清单（四态、整表替换、上限 20 项）。",
		promptGuidelines: [
			"任务预计至少三步、并行多任务或用户要求列计划时，先用 todo_write 建立待办清单；一步能完成的小任务与纯问答不建。",
			"清单整表替换：每次调用提交完整清单。每完成一步（并验证过）立即更新状态，不攒批；completed 必须真实完成并验证，不凭意图。",
			"计划变化时立即重构整张清单（去掉已完成项、补上新增步骤）；交付前对账，全部条目应为 completed 或明确 cancelled。",
		],
		parameters: TodoWriteParams,
		async execute(_toolCallId, params) {
			const normalized = normalizeTodoList(params);
			if (normalized.error) {
				// 非法输入不覆写旧清单；details 携带未变旧表，重建扫描对其按错误结果忽略
				return {
					content: [{ type: "text", text: `todo_write 拒绝：${normalized.error}。清单未改动。` }],
					details: stateEnvelope(),
					isError: true,
				};
			}
			todos = normalized.todos;
			staleCount = 0;
			reminded = false;
			return {
				content: [{ type: "text", text: todos.length > 0 ? renderTodoList(todos) : "清单已清空。" }],
				details: stateEnvelope(),
			};
		},
		renderCall(args, theme) {
			const count = Array.isArray((args as { todos?: unknown } | undefined)?.todos)
				? (args as { todos: unknown[] }).todos.length
				: 0;
			return new Text(theme.fg("toolTitle", theme.bold("todo_write ")) + theme.fg("muted", `${count} 项`), 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const state = result.details;
			if (result.isError || !isTodoState(state)) {
				const text = result.content[0];
				return new Text(theme.fg(result.isError ? "error" : "dim", text?.type === "text" ? text.text : ""), 0, 0);
			}
			const list = state.todos;
			if (list.length === 0) return new Text(theme.fg("dim", "清单为空"), 0, 0);
			let text = theme.fg("muted", renderTodoList(list).split("\n")[0]);
			const display = expanded ? list : list.slice(0, 5);
			const colors: Record<TodoStatus, Parameters<typeof theme.fg>[0]> = {
				pending: "muted",
				in_progress: "accent",
				completed: "success",
				cancelled: "dim",
			};
			for (const item of display) {
				text += `\n${theme.fg(colors[item.status], `${STATUS_GLYPH[item.status]} ${item.content}`)}`;
			}
			if (!expanded && list.length > 5) text += `\n${theme.fg("dim", `… 还有 ${list.length - 5} 项`)}`;
			return new Text(text, 0, 0);
		},
	});

	// 陈旧提醒：agent-session 把 afterToolCall 分发为扩展事件 tool_result（零内核改动）。
	// 只在「当前清单非空」时计数；替换 content 须回传 structuredContent（否则被丢弃）。
	pi.on("tool_result", (event) => {
		if (todos.length === 0 || event.isError) return undefined;
		if (event.toolName === TODO_WRITE_TOOL_NAME || !SUBSTANTIVE_TOOLS.has(event.toolName)) return undefined;
		staleCount++;
		if (staleCount < STALE_REMINDER_THRESHOLD || reminded) return undefined;
		reminded = true;
		const reminder = [
			`${TODO_REMINDER_MARKER} 自上次 todo_write 起已连续 ${staleCount} 次写/执行类调用未更新清单。当前清单：`,
			renderTodoList(todos),
			"已完成请立即更新状态（不攒批）；计划有变就重构整张清单。",
		].join("\n");
		return {
			content: [...event.content, { type: "text" as const, text: reminder }],
			structuredContent: event.structuredContent,
		};
	});

	// 压缩二道防线：压缩前留快照，成功后落条目；context 事件把「当前清单」再注入模型视野
	// （注入活清单而非快照旧值——压缩后的 todo_write 已在最新 toolResult 里，注入不得与之矛盾）。
	pi.on("session_before_compact", () => {
		pending = todos.length > 0 ? stateEnvelope() : undefined;
	});
	pi.on("session_compact_failed", () => {
		pending = undefined;
	});
	pi.on("session_compact", () => {
		if (pending) {
			snapshot = pending;
			pi.appendEntry(SNAPSHOT_CUSTOM_TYPE, snapshot);
		}
		pending = undefined;
	});
	pi.on("context", (event) => {
		if (!snapshot || todos.length === 0) return undefined;
		return {
			messages: [
				...event.messages,
				{
					role: "custom" as const,
					customType: SNAPSHOT_CUSTOM_TYPE,
					content: `[会话待办快照；压缩后留存，非新指令。]\n${renderTodoList(todos)}`,
					display: false,
					timestamp: 0,
				},
			],
		};
	});

	return { currentTodos: () => todos };
}
