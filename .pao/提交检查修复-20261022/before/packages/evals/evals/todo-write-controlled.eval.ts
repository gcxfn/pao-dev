/**
 * 可控序列类：不依赖模型行为。直接驱动 S8 内核 todo_write 工具与 tool_result 事件序列，
 * 断言 S8 §6 定案契约：整表替换、四态流转、上限 20、非法输入拒绝不覆写、空数组清空、
 * 陈旧提醒（阈值 5：成功实质调用计数，失败/读取/todo_write 自身不误计，同陈旧期只提醒一次，
 * 新 todo_write 重置）。运行入口与普通 host eval 相同，无需 PI_PROVIDER/PI_MODEL：
 *
 *   PI_OFFLINE=1 PI_NO_LOCAL_LLM=1 PAO_HOME=<临时目录> \
 *     npx vitest run --config vitest.evals.config.ts --project host evals/todo-write-controlled.eval.ts
 *
 * 观测口径刻意与实现措辞解耦：清单状态经工具结果 details 的整表快照断言（按条目内容
 * 子串判定，不依赖字段命名）；陈旧提醒按「该次工具结果 content 相对原文被追加」判定，
 * 不依赖提醒文案。被测对象是内核真实模块（pao/todo/），非本文件自带替身——
 * 模型行为及时性评估见 todo-write-timeliness.model.eval.ts（模型评估类：S12 授权后运行）。
 */
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../coding-agent/src/core/extensions/types.ts";
import { registerTodo } from "../../coding-agent/src/pao/todo/index.ts";

interface CapturedTool {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: undefined,
		onUpdate: undefined,
		ctx: never,
	) => Promise<{ content: { type: string; text?: string }[]; details: unknown; isError?: boolean }>;
}
type ToolResultHandler = (
	event: {
		toolCallId: string;
		toolName: string;
		input: Record<string, unknown>;
		content: { type: string; text: string }[];
		isError: boolean;
		details?: unknown;
	},
	ctx: never,
) => { content?: { type: string; text: string }[] } | undefined | Promise<{ content?: { type: string; text: string }[] } | undefined>;

interface Captured {
	tools: CapturedTool[];
	toolResultHandlers: ToolResultHandler[];
}

function capturePi(): { pi: ExtensionAPI; captured: Captured } {
	const captured: Captured = { tools: [], toolResultHandlers: [] };
	const pi = {
		registerTool: (tool: unknown) => captured.tools.push(tool as CapturedTool),
		on: (event: string, handler?: (...args: never[]) => unknown) => {
			if (event === "tool_result" && handler) captured.toolResultHandlers.push(handler as ToolResultHandler);
			return () => {};
		},
		registerCommand: () => {},
	} as unknown as ExtensionAPI;
	return { pi, captured };
}

function registerAndGetTool(): CapturedTool {
	const { pi, captured } = capturePi();
	registerTodo(pi);
	const tool = captured.tools.find((t) => t.name === "todo_write");
	if (!tool) throw new Error(`pao/todo 注册面缺少 todo_write 工具（注册到:${captured.tools.map((t) => t.name).join(",") || "无"}）`);
	return tool;
}

function item(content: string, status: string, activeForm?: string) {
	return activeForm ? { content, status, activeForm } : { content, status };
}
function items(count: number, status = "pending") {
	return Array.from({ length: count }, (_, i) => item(`步骤${i + 1}`, status));
}
const detailsJson = (details: unknown) => JSON.stringify(details ?? null);
const resultText = (result: { content: { type: string; text?: string }[] }) =>
	result.content
		.filter((p) => p.type === "text")
		.map((p) => p.text ?? "")
		.join("\n");

let callSeq = 0;
/** 构造可控 tool_result 事件（陈旧提醒的输入面） */
function toolResultEvent(toolName: string, isError = false) {
	callSeq += 1;
	return {
		toolCallId: `call-${callSeq}`,
		toolName,
		input: {},
		content: [{ type: "text", text: "ok" }],
		isError,
		details: undefined,
	};
}

describe("todo_write 可控序列（S8 §6 契约）", () => {
	it("工具真实注册可发现：名称 todo_write，promptSnippet/promptGuidelines 齐备", () => {
		const tool = registerAndGetTool();
		expect(tool.name).toBe("todo_write");
		expect(tool.promptSnippet && tool.promptSnippet.length > 0).toBe(true);
		expect(Array.isArray(tool.promptGuidelines) && tool.promptGuidelines.length > 0).toBe(true);
	});

	it("新建清单：整表快照入 details，activeForm 可携带", async () => {
		const tool = registerAndGetTool();
		const result = await tool.execute("t1", { todos: [item("步骤一", "pending", "正在做步骤一"), item("步骤二", "in_progress"), item("步骤三", "completed")] }, undefined, undefined, {} as never);
		expect(result.isError).toBeFalsy();
		expect(detailsJson(result.details)).toContain("步骤一");
		expect(detailsJson(result.details)).toContain("步骤三");
		expect(detailsJson(result.details)).toContain("activeForm");
	});

	it("整表替换＋四态流转：新表完整生效，旧条目不残留，四态均可落", async () => {
		const tool = registerAndGetTool();
		await tool.execute("t1", { todos: items(3) }, undefined, undefined, {} as never);
		const replaced = await tool.execute("t2", { todos: [item("旧步骤1", "cancelled"), item("旧步骤2", "completed"), item("新步骤", "pending"), item("流转步骤", "in_progress")] }, undefined, undefined, {} as never);
		expect(replaced.isError).toBeFalsy();
		const snapshot = detailsJson(replaced.details);
		for (const status of ["pending", "in_progress", "completed", "cancelled"]) expect(snapshot).toContain(status);
		expect(snapshot).not.toContain("步骤3"); // 旧表条目已被整表替换
		const flowed = await tool.execute("t3", { todos: [item("流转步骤", "completed")] }, undefined, undefined, {} as never);
		expect(flowed.isError).toBeFalsy();
		expect(resultText(flowed)).not.toContain("in_progress");
	});

	it("上限 20：21 条拒绝，工具仍可用（后续合法写入正常）", async () => {
		const tool = registerAndGetTool();
		await tool.execute("t1", { todos: items(2) }, undefined, undefined, {} as never);
		const rejected = await tool.execute("t2", { todos: items(21) }, undefined, undefined, {} as never);
		expect(rejected.isError).toBe(true);
		const usable = await tool.execute("t3", { todos: [item("恢复步骤", "completed")] }, undefined, undefined, {} as never);
		expect(usable.isError).toBeFalsy();
	});

	it("非法输入拒绝不覆写：未知状态/空内容/重复内容——旧清单存活（由陈旧提醒非空口径证明）", async () => {
		const { pi, captured } = capturePi();
		registerTodo(pi);
		const tool = captured.tools.find((t) => t.name === "todo_write");
		const remind = captured.toolResultHandlers;
		if (!tool || remind.length === 0) throw new Error("todo_write 或 tool_result 陈旧提醒未注册");
		const fire = async (toolName: string, isError = false) =>
			(await remind[0](toolResultEvent(toolName, isError), undefined as never))?.content?.map((p) => p.text).join("\n") ?? "ok";
		await tool.execute("t1", { todos: [item("保留步骤", "pending")] }, undefined, undefined, {} as never);
		expect((await tool.execute("t2", { todos: [item("坏状态", "done")] }, undefined, undefined, {} as never)).isError).toBe(true);
		expect((await tool.execute("t3", { todos: [item("  ", "pending")] }, undefined, undefined, {} as never)).isError).toBe(true);
		expect((await tool.execute("t4", { todos: [item("重复", "pending"), item(" 重复 ", "completed")] }, undefined, undefined, {} as never)).isError).toBe(true);
		// 三次拒绝后旧清单仍非空：第 5 次实质调用仍触发追加提醒（若拒绝覆写/清空则不触发）
		for (let i = 0; i < 4; i++) expect(await fire("write")).toBe("ok");
		expect((await fire("edit")).length).toBeGreaterThan("ok".length);
	});

	it("空数组清空：合法操作，清单归零", async () => {
		const tool = registerAndGetTool();
		await tool.execute("t1", { todos: items(2) }, undefined, undefined, {} as never);
		const cleared = await tool.execute("t2", { todos: [] }, undefined, undefined, {} as never);
		expect(cleared.isError).toBeFalsy();
		expect(resultText(cleared)).not.toContain("步骤1");
	});

	it("陈旧提醒（阈值 5，可控模拟）：满 5 追加提醒、同陈旧期只提醒一次、新 todo_write 重置", async () => {
		const { pi, captured } = capturePi();
		registerTodo(pi);
		const tool = captured.tools.find((t) => t.name === "todo_write");
		const remind = captured.toolResultHandlers;
		if (!tool || remind.length === 0) throw new Error("todo_write 或 tool_result 陈旧提醒未注册");
		const fire = async (toolName: string, isError = false) =>
			(await remind[0](toolResultEvent(toolName, isError), undefined as never))?.content?.map((p) => p.text).join("\n") ?? "ok";
		// 清单为空（从未 todo_write）：不提醒
		for (let i = 0; i < 5; i++) expect(await fire("write")).toBe("ok");
		// 建清单后：前 4 次实质调用不提醒
		await tool.execute("t1", { todos: items(3) }, undefined, undefined, {} as never);
		for (let i = 0; i < 4; i++) expect(await fire(i % 2 ? "write" : "edit")).toBe("ok");
		// 第 5 次追加提醒（content 相对原文被追加）
		expect((await fire("bash")).length).toBeGreaterThan("ok".length);
		// 同一陈旧期只提醒一次：第 6、7 次不提醒
		expect(await fire("write")).toBe("ok");
		expect(await fire("powershell")).toBe("ok");
		// 失败/读取类/todo_write 自身不计数：各 5 次均不提醒
		for (let i = 0; i < 5; i++) expect(await fire("bash", true)).toBe("ok");
		for (let i = 0; i < 5; i++) expect(await fire("read")).toBe("ok");
		for (let i = 0; i < 5; i++) expect(await fire("grep")).toBe("ok");
		for (let i = 0; i < 5; i++) expect(await fire("todo_write")).toBe("ok");
		// 新 todo_write 重置：再 4 次不提醒，第 5 次再提醒
		await tool.execute("t2", { todos: [item("更新后步骤", "in_progress")] }, undefined, undefined, {} as never);
		for (let i = 0; i < 4; i++) expect(await fire("edit")).toBe("ok");
		expect((await fire("write")).length).toBeGreaterThan("ok".length);
		// 清空后清单为空：不再提醒
		await tool.execute("t3", { todos: [] }, undefined, undefined, {} as never);
		for (let i = 0; i < 5; i++) expect(await fire("bash")).toBe("ok");
	});
});
