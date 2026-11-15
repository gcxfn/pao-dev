/** 真实 AgentSession 到最终模型上下文；模型为离线 fauxProvider，不证明供应商格式或模型决策。 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Context,
	fauxAssistantMessage,
	fauxProvider,
	getCurrentSystemPrompt,
	getCurrentTools,
	InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { registerDeptTools } from "../../src/pao/dept/index.ts";
import { createDept } from "../../src/pao/dept/scaffold.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";

it("下一次真实请求刷新部门简介，最终工具声明可度量且不携带完整干法", async () => {
	const root = mkdtempSync(join(tmpdir(), "pao-dept-final-context-"));
	const home = join(root, "home");
	mkdirSync(home, { recursive: true });
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		await createDept({ paoHome: home, 名字: "文档", 标签: ["说明"] });
		const recipe = join(home, "部门", "文档", "配方.md");
		const original = readFileSync(recipe, "utf8");
		writeFileSync(
			recipe,
			`${original.replace(/- 人设:.*$/m, "- 人设:负责初稿说明")}\n## 干法\n秘密干法标记不得常驻\n`,
		);
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const faux = fauxProvider({ tokensPerSecond: 1_000_000 });
		runtime.registerNativeProvider(faux.provider);
		await runtime.refresh({ allowNetwork: false });
		const requests: Context[] = [];
		const respond = (context: Context) => {
			requests.push(structuredClone(context));
			return fauxAssistantMessage("离线固定回应");
		};
		faux.setResponses([respond, respond]);
		const extensionsResult = await createTestExtensionsResult(
			[(pi) => registerDeptTools(pi, { paoHome: home })],
			root,
		);
		({ session } = await createAgentSession({
			cwd: root,
			agentDir: join(root, "agent"),
			modelRuntime: runtime,
			model: faux.getModel(),
			sessionManager: SessionManager.inMemory(root),
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			tools: ["pao_create_dept"],
		}));
		await session.bindExtensions({});
		await session.prompt("列出部门");
		writeFileSync(recipe, readFileSync(recipe, "utf8").replace("负责初稿说明", "负责最终校对"));
		await session.prompt("重新列出部门");
		expect(requests).toHaveLength(2);
		expect(getCurrentSystemPrompt(requests[0].messages)).toContain("文档｜职责简介：负责初稿说明");
		expect(getCurrentSystemPrompt(requests[1].messages)).toContain("文档｜职责简介：负责最终校对");
		expect(getCurrentSystemPrompt(requests[1].messages)).not.toContain("负责初稿说明");
		for (const request of requests) {
			expect(getCurrentSystemPrompt(request.messages)).not.toContain("秘密干法标记不得常驻");
			const tools = getCurrentTools(request.messages);
			expect(tools.map((tool) => tool.name)).toContain("pao_create_dept");
			const declarations = JSON.stringify(tools);
			expect(Buffer.byteLength(declarations, "utf8")).toBeGreaterThan(0);
			// 字符和字节可直接核对；未向供应商发送，不声称 token 或费用变化。
			expect(Array.from(declarations).length).toBeGreaterThan(0);
		}
	} finally {
		if (session) {
			session.dispose();
		}
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);
