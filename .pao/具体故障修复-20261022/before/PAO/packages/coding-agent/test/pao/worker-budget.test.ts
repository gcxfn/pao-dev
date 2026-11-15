import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import type { CardBudget } from "../../src/pao/cards/types.ts";
import { assertAuxiliaryRequestBudget, registerSessionBudget } from "../../src/pao/worker/budget.ts";
import { absorbEvent, createEventState } from "../../src/pao/worker/receipt.ts";
import { WorkerRunner } from "../../src/pao/worker/runner.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";

// 实际 AgentSession + 本地 faux provider；零线上 API / 零真实凭证。
const dirs: string[] = [];
const sessions: AgentSession[] = [];
afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup(budget: CardBudget, responses: FauxResponseStep[], env: Record<string, string> = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "pao-worker-budget-"));
	dirs.push(cwd);
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({ tokensPerSecond: 1_000_000 });
	faux.setResponses(responses);
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false });
	let toolsRun = 0;
	let receiptsRun = 0;
	const extensionsResult = await createTestExtensionsResult(
		[
			(pi) => {
				registerSessionBudget(pi, { PAO_WORKER_BUDGET: JSON.stringify(budget), ...env });
				pi.registerTool({
					name: "probe",
					label: "离线计数工具",
					description: "只增加本地测试计数",
					parameters: Type.Object({}),
					execute: async () => {
						toolsRun++;
						return { content: [{ type: "text", text: "done" }], details: {} };
					},
				});
				pi.registerTool({
					name: "pao_submit_receipt",
					label: "回执通道(测试桩)",
					description: "预算提醒轮里唯一放行的工具(测试桩)",
					parameters: Type.Object({}),
					execute: async () => {
						receiptsRun++;
						return { content: [{ type: "text", text: "回执已落" }], details: {} };
					},
				});
			},
		],
		cwd,
	);
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		modelRuntime: runtime,
		model: faux.getModel(),
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
		resourceLoader: createTestResourceLoader({ extensionsResult }),
	});
	sessions.push(session);
	await session.bindExtensions({});
	return { session, faux, toolsRun: () => toolsRun, receiptsRun: () => receiptsRun };
}

describe("父运行器与真实离线 AgentSession 接起来(审查第 2 项)", () => {
	/**
	 * 反例来自审查报告:轮次预算 1,首轮用工具、下一轮交最终回执。
	 * 子会话门禁明确放行这一轮,父运行器却按「开始轮次 > turns」在同一刻杀掉子进程,
	 * 任务已做完却结算成预算耗尽。这里不分别测两个模拟件,而是让真实 WorkerRunner
	 * 拉起真实 AgentSession(子进程内是生产 budget 门禁 + 生产事件流,只把供应商换成 faux)。
	 */
	it("turns=1:首轮用工具、下一轮交最终回执,父层不再把回执轮当超限杀掉", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pao-worker-parent-budget-"));
		dirs.push(cwd);
		const receipt = await new WorkerRunner().run({
			卡号: "0001",
			提示词: "用一次工具后交 JSON 回执",
			命令: process.execPath,
			参数: [fileURLToPath(new URL("./worker-budget-child.ts", import.meta.url)), "tool-then-receipt"],
			cwd,
			证据目录: cwd,
			要求回执: true,
			预算: { turns: 1 },
		});
		expect(receipt.status).toBe("success");
		expect(receipt.summary).toBe("预算内收尾");
		expect(receipt.usage.turns).toBe(2); // 第 2 轮=子会话获准的最终回执轮
	}, 60_000);

	it("提醒轮里再调普通工具仍被拦:子会话自己硬拒并停,父层如实报预算耗尽", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pao-worker-parent-budget-"));
		dirs.push(cwd);
		const receipt = await new WorkerRunner().run({
			卡号: "0002",
			提示词: "到线后仍调工具",
			命令: process.execPath,
			参数: [fileURLToPath(new URL("./worker-budget-child.ts", import.meta.url)), "tool-in-reminder"],
			cwd,
			证据目录: cwd,
			要求回执: true,
			预算: { turns: 1 },
		});
		expect(receipt.status).toBe("failed");
		expect(receipt.summary).toContain("预算已耗尽");
		expect(receipt.usage.turns).toBe(2); // 提醒轮只放行一轮,没有第三轮
	}, 60_000);

	it("回执通道在提醒轮里放行且不计工具次数,父层不把它当额外普通工具杀掉", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pao-worker-parent-budget-"));
		dirs.push(cwd);
		// 工具次数预算 1:普通工具用掉 1 次,回执通道不计次——父层若把回执也算进去就会误杀
		const receipt = await new WorkerRunner().run({
			卡号: "0003",
			提示词: "用过一次工具后交回执",
			命令: process.execPath,
			参数: [fileURLToPath(new URL("./worker-budget-child.ts", import.meta.url)), "receipt-in-reminder"],
			cwd,
			证据目录: cwd,
			要求回执: true,
			预算: { toolCalls: 1 },
		});
		expect(receipt.status).toBe("success");
		expect(receipt.summary).toBe("预算内收尾");
	}, 60_000);
});

describe("预算环境变量容错(R40 门禁不因坏配置崩扩展加载)", () => {
	it("PAO_WORKER_BUDGET 非合法 JSON → 保留加载但阻止请求", () => {
		const warnings: string[] = [];
		const spy = vi.spyOn(console, "warn").mockImplementation((message) => warnings.push(String(message)));
		const handlers = new Map<string, unknown>();
		try {
			expect(() =>
				registerSessionBudget({ on: (event: string, handler: unknown) => handlers.set(event, handler) } as never, {
					PAO_WORKER_BUDGET: "{oops",
				}),
			).not.toThrow();
		} finally {
			spy.mockRestore();
		}
		expect([...handlers.keys()].sort()).toEqual(["before_provider_request", "session_start"]);
		const abort = vi.fn();
		expect(() =>
			(handlers.get("before_provider_request") as (event: object, ctx: object) => void)({}, { abort }),
		).toThrow("拒绝模型请求");
		expect(abort).toHaveBeenCalledOnce();
		expect(warnings.join("\n")).toContain("PAO_WORKER_BUDGET 不是合法 JSON");
	});
});

describe("worker 预算在真实 AgentSession 中生效（离线假供应商）", () => {
	it("辅助原生费用到成本线后阻止普通请求与摘要请求，不调用供应商", async () => {
		const { session, faux } = await setup({ cost: 0.5 }, [fauxAssistantMessage("不应调用")]);
		session.sessionManager.appendUsage("precompaction", "fake", "offline", {
			input: 10,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 12,
			cost: { input: 0.5, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
		});
		expect(() => assertAuxiliaryRequestBudget(session.sessionManager)).toThrow("cost");
		await session.prompt("辅助费用已经耗尽");
		expect(faux.state.callCount).toBe(0);
	});
	it("辅助费用未知也关闭成本门，不能用零费用放行", async () => {
		const { session, faux } = await setup({ cost: 10 }, [fauxAssistantMessage("不应调用")]);
		session.sessionManager.appendCustomEntry("pao-precompaction-usage-status", { status: "请求未返回用量" });
		expect(() => assertAuxiliaryRequestBudget(session.sessionManager)).toThrow("cost");
		await session.prompt("未知费用");
		expect(faux.state.callCount).toBe(0);
	});
	it("1 轮允许本轮工具；到线先催回执——放行恰好一轮输出最终回执，自然收尾不 abort", async () => {
		const final = JSON.stringify({ result: "success", artifact_path: [], summary: "预算内收尾" });
		const { session, faux, toolsRun } = await setup({ turns: 1 }, [
			fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(final),
		]);
		await session.prompt("执行工具后交 JSON 回执");
		expect(faux.state.callCount).toBe(2); // 第 2 次=预算内提醒轮,放行恰好一次
		expect(toolsRun()).toBe(1);
		expect(faux.getPendingResponseCount()).toBe(0);
		expect(session.messages.at(-1)).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: final }] });
	});
	it("第 N+1 次工具执行被拒（拒因即预算内唯一提醒），放行一轮输出回执后自然收尾", async () => {
		const { session, faux, toolsRun } = await setup({ toolCalls: 1 }, [
			fauxAssistantMessage([fauxToolCall("probe", {}, { id: "one" }), fauxToolCall("probe", {}, { id: "two" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("预算内最终结论"),
		]);
		await session.prompt("调用两个工具");
		expect(toolsRun()).toBeLessThanOrEqual(1);
		expect(faux.state.callCount).toBe(2); // 提醒轮
		expect(faux.getPendingResponseCount()).toBe(0);
	});
	it("恰好 N 次工具后允许预算内的最终纯文本 JSON 回执", async () => {
		const final = JSON.stringify({ result: "success", artifact_path: [], summary: "已完成" });
		const { session, faux, toolsRun } = await setup({ turns: 2, toolCalls: 1 }, [
			fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(final),
		]);
		await session.prompt("调用工具后交 JSON 回执");
		expect(faux.state.callCount).toBe(2);
		expect(toolsRun()).toBe(1);
		expect(faux.getPendingResponseCount()).toBe(0);
		expect(session.messages.at(-1)).toMatchObject({
			stopReason: "stop",
			content: [{ type: "text", text: final }],
		});
	});
	it("0 轮在首次 provider 前停止，不把零调用 abort 算一次模型轮次", async () => {
		const { session, faux } = await setup({ turns: 0 }, [fauxAssistantMessage("不应调用")]);
		await session.prompt("不应派到模型");
		expect(faux.state.callCount).toBe(0);
		const state = createEventState();
		for (const message of session.messages) absorbEvent(state, JSON.stringify({ type: "message_end", message }));
		expect(state.用量.turns).toBe(0);
	});
	it("provider 的 onPayload 重试触顶会收到真实取消信号", async () => {
		const signals: boolean[] = [];
		let simulatedTransportRequests = 0;
		const { session, faux } = await setup({ turns: 1 }, [
			async (_context, options, _state, model) => {
				for (const attempt of [1, 2]) {
					await options?.onPayload?.({ attempt }, model);
					signals.push(options?.signal?.aborted ?? false);
					if (!options?.signal?.aborted) simulatedTransportRequests++;
				}
				return fauxAssistantMessage("本地假请求");
			},
		]);
		await session.prompt("验证本地模拟重试");
		expect(faux.state.callCount).toBe(1);
		expect(signals).toEqual([false, true]);
		expect(simulatedTransportRequests).toBe(1);
	});
});

describe("R40 催回执状态机（最多一次；交回执通道不掐死）", () => {
	it("提醒轮内再调非回执工具：硬拒并停（提醒只用一次），不再放行后续请求", async () => {
		const { session, faux, toolsRun } = await setup({ turns: 1 }, [
			fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }), // 提醒轮里仍想调工具
			fauxAssistantMessage("不应到达"),
		]);
		await session.prompt("到线后仍调工具");
		expect(toolsRun()).toBe(1);
		expect(faux.state.callCount).toBe(2); // 第 2 次=提醒轮；第 3 次被拒
		expect(faux.getPendingResponseCount()).toBe(1);
		expect(session.messages.at(-1)).toMatchObject({ stopReason: "aborted" });
	});

	it("提醒轮里 pao_submit_receipt 放行且真正执行；交回执后再到线即停（不二次提醒）", async () => {
		const { session, faux, toolsRun, receiptsRun } = await setup({ turns: 1 }, [
			fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("pao_submit_receipt", {}), { stopReason: "toolUse" }), // 提醒轮交回执
			fauxAssistantMessage("不应到达"),
		]);
		await session.prompt("到线后交回执");
		expect(toolsRun()).toBe(1);
		expect(receiptsRun()).toBe(1); // 回执通道放行且执行
		expect(faux.state.callCount).toBe(2); // 第 3 次请求:已交回执→到线即停
		expect(faux.getPendingResponseCount()).toBe(1);
		expect(session.messages.at(-1)).toMatchObject({ stopReason: "aborted" });
	});

	it("预算内先交回执再耗尽轮次：到线即停（无提醒轮——回执已在）", async () => {
		const { session, faux, receiptsRun } = await setup({ turns: 2 }, [
			fauxAssistantMessage(fauxToolCall("pao_submit_receipt", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("不应到达"),
		]);
		await session.prompt("先交回执再干活");
		expect(receiptsRun()).toBe(1);
		expect(faux.state.callCount).toBe(2);
		expect(faux.getPendingResponseCount()).toBe(1);
	});

	it("PAO_SESSION_BUDGET 优先于 PAO_WORKER_BUDGET（全角色通用名）", async () => {
		const { session, faux } = await setup({ turns: 99 }, [fauxAssistantMessage("不应被 99 轮放行")], {
			PAO_SESSION_BUDGET: JSON.stringify({ turns: 0 }),
		});
		await session.prompt("零预算");
		expect(faux.state.callCount).toBe(0); // 通用名生效(turns:0 首请求前即停)
		const state = createEventState();
		for (const message of session.messages) absorbEvent(state, JSON.stringify({ type: "message_end", message }));
		expect(state.用量.turns).toBe(0);
	});
});
