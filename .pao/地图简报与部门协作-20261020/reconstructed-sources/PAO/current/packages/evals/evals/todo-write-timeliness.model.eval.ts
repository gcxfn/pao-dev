/**
 * 模型评估类：S12 授权后运行。默认跳过；显式 PAO_TODO_MODEL_EVALS=1 且 PI_PROVIDER/PI_MODEL
 * 齐备才运行（S8 定案：模型及时性 eval 在 S12 有授权后验证，不以脚本手动更新替代模型行为）。
 *
 * 评估对象：多步任务中的清单维护及时性（S8 计划 §6）——
 *   - 每步完成及时更新（不攒批）
 *   - 计划变化时重构清单
 *   - 交付前对账
 *
 * 评分口径（确定性计算，无 LLM 评委，各 0..1，随 run 产物记录）：
 *   - 更新及时性：每个步骤的完成动作与其后下一步实质动作之间，todo_write 快照的 completed
 *     计数必须增长（攒批即扣分）；多阶段用例按阶段平均；
 *   - 列表准确性：合规 todo_write 占比（≤20 条、内容非空去重、≤1 个 in_progress），
 *     且全程快照覆盖全部在册步骤；
 *   - 重构正确性（计划变化用例）：变化指令后的首个 todo_write 即取消/移除作废步骤并纳入新步骤；
 *   - 交付对账完整：submit_checklist 恰一次，finalTodos 与地面真值一致（应完成步骤全
 *     completed、作废步骤 cancelled 或缺席、无 pending/in_progress 残留）。
 *
 * todo_write 用契约替身（与 S8 内核 todo_write 同契约：整表替换、四态、上限 20、
 * 空数组清空、非法输入拒绝不覆写），替身的 promptGuidelines 即 S8 定案纪律段。
 * 用替身而非注册内核工具：评分口径稳定，不随内核实现重构漂移；S12 需要端到端口径时
 * 把 customTools 换成真实 todo_write 再跑即可（替身契约即 S8 验收契约）。
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describeEval } from "vitest-evals";
import { createPiCodingAgentHarness, DOCUMENTATION_EVAL_TOOLS } from "../src/harness.ts";

const TODO_LIMIT = 20;
const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
type TodoStatus = (typeof TODO_STATUSES)[number];
// type 别名而非 interface：harness output 须满足 JsonValue（interface 无隐式索引签名）
type TodoItem = {
	content: string;
	status: TodoStatus;
	activeForm?: string;
};

/** S8 定案的清单纪律段（与内核 todo_write 的 promptGuidelines 同源口径） */
const TODO_GUIDELINES = [
	"任务至少三步或用户要求时，先用 todo_write 列出完整清单（整表提交）。",
	"每完成一步立即用 todo_write 更新清单，不攒批；完成必须真实可验证，不凭意图。",
	"计划变化时立即用 todo_write 重构清单（作废条目取消或移除，新条目纳入）。",
	"交付前先用 todo_write 对账，再用 submit_checklist 提交最终清单。",
];

function isValidTodoList(value: unknown): value is TodoItem[] {
	if (!Array.isArray(value) || value.length > TODO_LIMIT) return false;
	const seen = new Set<string>();
	for (const item of value) {
		if (typeof item !== "object" || item === null) return false;
		const { content, status } = item as Record<string, unknown>;
		if (typeof content !== "string" || content.trim().length === 0) return false;
		if (typeof status !== "string" || !TODO_STATUSES.includes(status as TodoStatus)) return false;
		const key = content.trim();
		if (seen.has(key)) return false;
		seen.add(key);
	}
	return true;
}

/** todo_write 契约替身：整表替换（空数组=清空），非法输入报错且不覆写旧清单 */
function createTodoWriteStub() {
	let current: TodoItem[] = [];
	const clone = () => current.map((t) => ({ ...t }));
	const tool = defineTool({
		name: "todo_write",
		label: "维护任务清单",
		description:
			"维护当前会话的任务清单。每次调用全量替换整张清单（todos 即最新完整清单，空数组即清空）。条目四态：pending/in_progress/completed/cancelled；同一时刻至多一个 in_progress。超过 20 条、内容为空或重复、未知状态均拒绝且不改动旧清单。",
		promptSnippet: "维护会话任务清单：整表替换、四态、上限 20",
		promptGuidelines: TODO_GUIDELINES,
		parameters: Type.Object({
			todos: Type.Array(
				Type.Object({
					content: Type.String({ minLength: 1 }),
					status: Type.Union(TODO_STATUSES.map((s) => Type.Literal(s))),
					activeForm: Type.Optional(Type.String()),
				}),
			),
		}),
		async execute(_toolCallId, params) {
			if (!isValidTodoList(params.todos)) {
				return {
					content: [{ type: "text", text: "清单非法（超 20 条 / 内容为空或重复 / 未知状态），已拒绝，旧清单保持不变。" }],
					details: { todos: clone() },
					isError: true,
				};
			}
			current = params.todos.map((t) => ({
				content: t.content,
				status: t.status,
				...(t.activeForm ? { activeForm: t.activeForm } : {}),
			}));
			return {
				content: [{ type: "text", text: current.length === 0 ? "清单已清空" : current.map((t) => `[${t.status}] ${t.content}`).join("\n") }],
				details: { todos: clone() },
			};
		},
	});
	return { tool, snapshot: clone };
}

/** 交付对账探针：结构化提交最终清单，作为最后一步动作 */
function createSubmitChecklistStub() {
	const submissions: { finalTodos: TodoItem[]; summary: string }[] = [];
	const tool = defineTool({
		name: "submit_checklist",
		label: "提交最终清单",
		description: "交付前提交最终任务清单与一句交付摘要。必须以 todo_write 对账后调用，作为最后一步动作。",
		promptSnippet: "交付前提交最终清单与摘要",
		parameters: Type.Object(
			{
				finalTodos: Type.Array(
					Type.Object({
						content: Type.String({ minLength: 1 }),
						status: Type.Union(TODO_STATUSES.map((s) => Type.Literal(s))),
					}),
				),
				summary: Type.String({ minLength: 1, maxLength: 500 }),
			},
			{ additionalProperties: false },
		),
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(_toolCallId, params) {
			submissions.push({ finalTodos: params.finalTodos, summary: params.summary });
			return { content: [{ type: "text", text: "最终清单已提交。" }], details: params, terminate: true };
		},
	});
	return { tool, submissions };
}

// ———— 时间线还原与评分（纯函数，口径见文件头） ————

type TimelineCall = {
	name: string;
	ok: boolean;
	argsText: string;
	todos?: TodoItem[];
};
type Timeline = {
	prompts: string[];
	calls: TimelineCall[];
	/** prompts[i] 之后的首个 call 序号（calls.length 表示其后无调用） */
	promptStarts: number[];
};

function argsText(args: Record<string, unknown>): string {
	return Object.values(args ?? {})
		.filter((v): v is string => typeof v === "string")
		.join(" ");
}

function buildTimeline(session: AgentSession): Timeline {
	const errors = new Map<string, boolean>();
	for (const message of session.messages) {
		if (message.role === "toolResult") errors.set(message.toolCallId, message.isError === true);
	}
	const prompts: string[] = [];
	const calls: TimelineCall[] = [];
	const promptStarts: number[] = [];
	for (const message of session.messages) {
		if (message.role === "user") {
			prompts.push(
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((p): p is { type: "text"; text: string } => p.type === "text")
							.map((p) => p.text)
							.join(" "),
			);
			promptStarts.push(calls.length);
			continue;
		}
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			calls.push({
				name: part.name,
				ok: !errors.get(part.id),
				argsText: argsText((part.arguments ?? {}) as Record<string, unknown>),
				todos: (part.arguments as { todos?: TodoItem[] } | undefined)?.todos,
			});
		}
	}
	return { prompts, calls, promptStarts };
}

function completedCount(todos: unknown): number {
	return Array.isArray(todos) ? todos.filter((t) => (t as { status?: string })?.status === "completed").length : -1;
}

/** todos 中是否存在覆盖 token 的条目；notStatus 给定时只统计状态不在其中的条目 */
function hasStep(todos: unknown, token: string, notStatus?: TodoStatus[]): boolean {
	if (!Array.isArray(todos)) return false;
	return todos.some((t) => {
		const item = t as { content?: string; status?: string };
		if (typeof item.content !== "string" || !item.content.includes(token)) return false;
		return notStatus ? !notStatus.includes(item.status as TodoStatus) : true;
	});
}

function scoreTimeliness(timeline: Timeline, files: string[], phaseStart: number, phaseEnd: number): number {
	const stepWrites: { index: number; token: string }[] = [];
	for (let index = phaseStart; index <= phaseEnd && index < timeline.calls.length; index++) {
		const call = timeline.calls[index];
		if (!call.ok || !/^(write|edit|bash|powershell)$/.test(call.name)) continue;
		const token = files.find((f) => call.argsText.includes(f));
		if (token && !stepWrites.some((w) => w.token === token)) stepWrites.push({ index, token });
	}
	if (stepWrites.length === 0) return 0;
	let completedSoFar = 0;
	let credited = 0;
	for (let i = 0; i < stepWrites.length; i++) {
		const write = stepWrites[i];
		const nextBoundary = i + 1 < stepWrites.length ? stepWrites[i + 1].index : phaseEnd + 1;
		const reflect = timeline.calls.find(
			(call, index) => index > write.index && index < nextBoundary && call.name === "todo_write" && call.ok,
		);
		const after = reflect ? completedCount(reflect.todos) : -1;
		if (after > completedSoFar) {
			credited++;
			completedSoFar = after;
		}
	}
	return credited / stepWrites.length;
}

function scoreAccuracy(timeline: Timeline, files: string[]): number {
	const todoCalls = timeline.calls.filter((c) => c.name === "todo_write" && c.ok);
	if (todoCalls.length === 0) return 0;
	let compliant = 0;
	for (const call of todoCalls) {
		if (!isValidTodoList(call.todos)) continue;
		if ((call.todos as TodoItem[]).filter((t) => t.status === "in_progress").length <= 1) compliant++;
	}
	const covered = files.every((f) => todoCalls.some((c) => hasStep(c.todos, f)));
	return (compliant / todoCalls.length) * (covered ? 1 : 0.5);
}

function scoreRestructure(timeline: Timeline, changeAt: number, drop: string, add: string[]): number {
	const reflect = timeline.calls.find(
		(call, index) => index > changeAt && call.name === "todo_write" && call.ok,
	);
	if (!reflect) return 0;
	const droppedOk = !hasStep(reflect.todos, drop, ["cancelled"]);
	const addedOk = add.every((token) => hasStep(reflect.todos, token));
	return droppedOk && addedOk ? 1 : 0;
}

function scoreReconcile(
	submissions: { finalTodos: TodoItem[] }[],
	expected: { token: string; status: TodoStatus }[],
): number {
	if (submissions.length !== 1) return 0;
	const final = submissions[0].finalTodos;
	if (!Array.isArray(final)) return 0;
	const ok = expected.filter(
		(step) => final.find((t) => t.content.includes(step.token))?.status === step.status,
	).length;
	const residual = final.filter((t) => t.status === "pending" || t.status === "in_progress").length;
	return (ok / expected.length) * (residual === 0 ? 1 : 0.5);
}

// ———— 用例（每个场景独立 harness＋独立替身闭包，评分在 output 内确定性计算） ————

const runModelEval = process.env.PAO_TODO_MODEL_EVALS === "1";

const baselineTodo = createTodoWriteStub();
const baselineSubmit = createSubmitChecklistStub();
const baselineFiles = ["a.txt", "b.txt", "c.txt"];

describeEval("多步清单维护及时性：基线三步", {
	harness: createPiCodingAgentHarness({
		name: "todo-write-timeliness-baseline",
		tools: [...DOCUMENTATION_EVAL_TOOLS],
		customTools: [baselineTodo.tool, baselineSubmit.tool],
		workspaceFiles: {
			"任务说明.md": [
				"# 三步任务",
				"按顺序完成以下三步，每步一个文件：",
				"1. 创建 a.txt，内容为 alpha",
				"2. 创建 b.txt，内容为 beta",
				"3. 创建 c.txt，内容为 gamma",
			].join("\n"),
		},
		output: ({ session }) => {
			const timeline = buildTimeline(session);
			return {
				timeline,
				scores: {
					更新及时性: scoreTimeliness(timeline, baselineFiles, 0, timeline.calls.length - 1),
					列表准确性: scoreAccuracy(timeline, baselineFiles),
					交付对账完整: scoreReconcile(
						baselineSubmit.submissions,
						baselineFiles.map((token) => ({ token, status: "completed" as const })),
					),
				},
			};
		},
	}),
	judgeThreshold: null,
	skipIf: () => !runModelEval,
}, (it) => {
	it("每步完成及时更新并交付对账", async ({ run }) => {
		await run(
			"先读 任务说明.md，然后按说明执行。要求：先用 todo_write 列出完整清单；每完成一步立即用 todo_write 更新（不攒批）；全部完成后先用 todo_write 对账，再用 submit_checklist 提交最终清单（finalTodos 覆盖全部步骤的最终状态）。",
		);
	});
});

const changeTodo = createTodoWriteStub();
const changeSubmit = createSubmitChecklistStub();
const changePhase1 = ["x1.txt", "x2.txt"];
const changePhase2 = ["y.txt", "z.txt"];

describeEval("多步清单维护及时性：计划变化重构", {
	harness: createPiCodingAgentHarness({
		name: "todo-write-timeliness-plan-change",
		tools: [...DOCUMENTATION_EVAL_TOOLS],
		customTools: [changeTodo.tool, changeSubmit.tool],
		output: ({ session }) => {
			const timeline = buildTimeline(session);
			const changeAt = (timeline.promptStarts[1] ?? timeline.calls.length) - 1;
			return {
				timeline,
				scores: {
					更新及时性:
						(scoreTimeliness(timeline, changePhase1, 0, changeAt) +
							scoreTimeliness(timeline, changePhase2, changeAt + 1, timeline.calls.length - 1)) /
						2,
					列表准确性: scoreAccuracy(timeline, [...changePhase1, ...changePhase2]),
					重构正确性: scoreRestructure(timeline, changeAt, "x3.txt", changePhase2),
					交付对账完整: scoreReconcile(changeSubmit.submissions, [
						...changePhase1.map((token) => ({ token, status: "completed" as const })),
						{ token: "y.txt", status: "completed" as const },
						{ token: "z.txt", status: "completed" as const },
					]),
				},
			};
		},
	}),
	judgeThreshold: null,
	skipIf: () => !runModelEval,
}, (it) => {
	it("计划变化时重构清单并完成对账", async ({ run }) => {
		await run([
			{
				type: "prompt",
				content:
					"依次完成三步：创建 x1.txt（内容 1）、x2.txt（内容 2）、x3.txt（内容 3）。先用 todo_write 列出完整清单，每完成一步立即更新。完成 x1 与 x2 两步后停下简述进度，本条指令内不要创建 x3.txt，也不要提交。",
			},
			{
				type: "prompt",
				content:
					"计划变化：第 3 步（x3.txt）作废。新增两步：创建 y.txt（内容 Y）与 z.txt（内容 Z）。立即用 todo_write 重构清单（作废条目取消或移除，新条目纳入），然后按新清单执行，每完成一步立即更新，最后用 todo_write 对账后以 submit_checklist 提交最终清单。",
			},
		]);
	});
});
