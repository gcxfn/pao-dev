/**
 * 离线预算集成子进程（审查第 2 项）：把真实 AgentSession 接到父运行器上验证。
 *
 * 会话、预算门禁、事件流输出都是生产实现（registerSessionBudget + toJsonEvent，与 --mode json 同口径），
 * 只有模型供应商换成仓内 faux provider——零网络、零真实凭证、零正式 PAO_HOME 写入。
 *
 * argv[2] = 场景名，argv[3] = 提示词（父运行器把提示词放在命令末尾）。
 */

import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { toJsonEvent } from "../../src/modes/json-event.ts";
import { registerSessionBudget } from "../../src/pao/worker/budget.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";

const 场景 = process.argv[2] ?? "";
const 提示词 = process.argv[3] ?? "";
const 预算环境 = process.env.PAO_WORKER_BUDGET ?? "{}";

/** 合法回执行：父运行器只在最后一条助手文本里找它 */
const 最终回执 = JSON.stringify({ result: "success", artifact_path: [], summary: "预算内收尾" });

const 场景响应 = {
	// 首轮用工具，到线后提醒轮里交最终回执（审查第 2 项的反例场景）
	"tool-then-receipt": [
		fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage(最终回执),
	],
	// 提醒轮里仍想调普通工具：子会话自己硬拒并停
	"tool-in-reminder": [
		fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("probe", {}, { id: "second" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("不应到达"),
	],
	// 提醒轮里走回执通道：放行且执行
	"receipt-in-reminder": [
		fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("pao_submit_receipt", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage(最终回执),
	],
} as const;

async function main(): Promise<void> {
	const cwd = process.cwd();
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({ tokensPerSecond: 1_000_000 });
	const responses = 场景响应[场景 as keyof typeof 场景响应];
	faux.setResponses(responses ? [...responses] : []);
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false });

	const extensionsResult = await createTestExtensionsResult(
		[
			(pi) => {
				// 只认父运行器注入的预算变量：测试机上的 PAO_SESSION_BUDGET 不得干扰本场景
				registerSessionBudget(pi, { PAO_WORKER_BUDGET: 预算环境 });
				pi.registerTool({
					name: "probe",
					label: "离线计数工具",
					description: "只增加本地测试计数",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
				});
				pi.registerTool({
					name: "pao_submit_receipt",
					label: "回执通道(测试桩)",
					description: "预算提醒轮里唯一放行的工具(测试桩)",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "回执已落" }], details: {} }),
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
	await session.bindExtensions({});
	// 与 --mode json 同口径：事件逐行写 stdout，父运行器据此计轮次/工具次数/用量
	session.subscribe((event) => {
		process.stdout.write(`${JSON.stringify(toJsonEvent(event))}\n`);
	});
	await session.prompt(提示词);
	session.dispose();
}

try {
	await main();
	// 等 stdout 真正落盘再退出，避免管道未排空时截断最后一条回执行
	await new Promise<void>((resolve) => {
		process.stdout.write("", () => resolve());
	});
	process.exit(0);
} catch (error) {
	process.stderr.write(`子进程失败:${(error as Error).message}\n`);
	process.exit(2);
}
