import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionVirtualModel } from "../../src/core/extensions/types.ts";
import type { ModelRouteRequest } from "../../src/core/virtual-models.ts";
import { loadTierConfig, registerTiers, resolveTier, validateTierConfig } from "../../src/pao/routing/index.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-routing-"));
	tempDirs.push(dir);
	return dir;
}

/** 档位配置样例:快→物理小模型(low),主力→物理大模型(high) */
const CONFIG_V1 = {
	provider: "pao",
	档位: [
		{ 名: "快", provider: "faux", model: "m-fast", thinkingLevel: "low" },
		{ 名: "主力", provider: "faux", model: "m-main", thinkingLevel: "high", contextWindow: 200_000, maxTokens: 8000 },
	],
};

/** 改配置后:快 改指 m-main —— 换模型只改配置 */
const CONFIG_V2 = {
	provider: "pao",
	档位: [{ 名: "快", provider: "faux", model: "m-main", thinkingLevel: "medium" }],
};

function writeConfig(config: unknown): string {
	const path = join(tempDir(), "档位.json");
	writeFileSync(path, JSON.stringify(config, null, "\t"), "utf8");
	return path;
}

/** 极简注册口:截获注册的虚拟模型定义,供直接调用 route(不接真实端点) */
function captureRegistrar() {
	const registered: ExtensionVirtualModel[] = [];
	return {
		registered,
		registerVirtualModel(model: ExtensionVirtualModel): void {
			registered.push(model);
		},
	};
}

function routeOf(
	model: ExtensionVirtualModel,
	thinkingLevel: string,
	registry: Map<string, unknown> | undefined,
): { model: unknown; thinkingLevel: string } {
	const ctx = {
		modelRegistry: {
			find: (_provider: string, id: string) => registry?.get(id),
		},
	};
	const route = model.route(
		{ thinkingLevel, reason: "user", messages: [] } as unknown as ModelRouteRequest,
		ctx as never,
	);
	return route as { model: unknown; thinkingLevel: string };
}

describe("档位配置加载与校验(缺字段明确报错,不静默)", () => {
	it("配置文件缺失时报结构化错误", () => {
		expect(() => loadTierConfig(join(tmpdir(), "不存在的档位配置.json"))).toThrow(/无法读取档位配置文件/);
	});

	it("非 JSON 内容报错", () => {
		const path = join(tempDir(), "档位.json");
		writeFileSync(path, "{不是json", "utf8");
		expect(() => loadTierConfig(path)).toThrow(/不是合法 JSON/);
	});

	it("缺「档位」字段时报错并指明字段名", () => {
		expect(() => validateTierConfig({ provider: "pao" }, "样例.json")).toThrow(/缺少字段「档位」/);
		expect(() => validateTierConfig({ 档位: [] }, "样例.json")).toThrow(/缺少字段「档位」/);
	});

	it("档位缺 名/provider/model/thinkingLevel 时逐个报错并指明字段名", () => {
		const base = { provider: "faux", model: "m", thinkingLevel: "low" };
		expect(() => validateTierConfig({ 档位: [{ ...base, 名: " " }] }, "样例.json")).toThrow(/缺少字段「名」/);
		expect(() => validateTierConfig({ 档位: [{ 名: "快", model: "m", thinkingLevel: "low" }] }, "样例.json")).toThrow(
			/缺少字段「provider」/,
		);
		expect(() =>
			validateTierConfig({ 档位: [{ 名: "快", provider: "faux", thinkingLevel: "low" }] }, "样例.json"),
		).toThrow(/缺少字段「model」/);
		expect(() => validateTierConfig({ 档位: [{ 名: "快", provider: "faux", model: "m" }] }, "样例.json")).toThrow(
			/缺少合法的「thinkingLevel」/,
		);
		expect(() =>
			validateTierConfig({ 档位: [{ 名: "快", provider: "faux", model: "m", thinkingLevel: "超高" }] }, "样例.json"),
		).toThrow(/「thinkingLevel」/);
	});

	it("档名含斜杠时报错（避免与 provider/model 模型名混淆——显式模型先按档名试解析,撞名会静默换模型）", () => {
		expect(() =>
			validateTierConfig(
				{ 档位: [{ 名: "faux/m-fast", provider: "faux", model: "m", thinkingLevel: "low" }] },
				"样例.json",
			),
		).toThrow(/不可含斜杠/);
	});

	it("provider 缺省时用 pao;resolveTier 查无此档时列出现有档位", () => {
		const config = validateTierConfig(
			{ 档位: [{ 名: "快", provider: "faux", model: "m", thinkingLevel: "low" }] },
			"样例.json",
		);
		expect(config.provider).toBe("pao");
		expect(() => resolveTier(config, "主力")).toThrow(/未找到档位「主力」.*快/s);
	});
});

describe("档位路由映射(假 provider/假模型注册,不接真实端点)", () => {
	it("快/主力各自映射到配置声明的物理模型,thinkingLevel 透传", () => {
		const registrar = captureRegistrar();
		registerTiers(registrar, { configPath: writeConfig(CONFIG_V1) });
		expect(registrar.registered.map((model) => model.id)).toEqual(["快", "主力"]);

		const [fast, main] = registrar.registered;
		// 推荐档排 thinkingLevels 首位(成为默认选中档)
		expect(fast.thinkingLevels?.[0]).toBe("low");
		expect(main.thinkingLevels?.[0]).toBe("high");
		expect(main.contextWindow).toBe(200_000);
		expect(main.maxTokens).toBe(8000);

		const physical = new Map<string, unknown>([
			["m-fast", { id: "m-fast" }],
			["m-main", { id: "m-main" }],
		]);
		const routed = routeOf(fast, "low", physical);
		expect(routed.model).toEqual({ id: "m-fast" });
		expect(routed.thinkingLevel).toBe("low");

		// 用户显式选的思考档跟随请求
		const routedHigh = routeOf(fast, "high", physical);
		expect(routedHigh.model).toEqual({ id: "m-fast" });
		expect(routedHigh.thinkingLevel).toBe("high");

		const routedMain = routeOf(main, "high", physical);
		expect(routedMain.model).toEqual({ id: "m-main" });
	});

	it("配置指向的物理模型不在目录时,请求(route)时报错且信息含档位名与模型名,不回退", () => {
		const registrar = captureRegistrar();
		registerTiers(registrar, {
			configPath: writeConfig({
				档位: [{ 名: "快", provider: "faux", model: "不存在的模型", thinkingLevel: "low" }],
			}),
		});
		expect(() => routeOf(registrar.registered[0], "low", undefined)).toThrow(
			/档位「快」.*不存在的模型.*不在模型目录中/s,
		);
	});

	it("改配置→路由变:同一档位名重新注册后指向新物理模型", () => {
		const configPath = writeConfig(CONFIG_V1);
		const registrar = captureRegistrar();
		registerTiers(registrar, { configPath });
		writeFileSync(configPath, JSON.stringify(CONFIG_V2, null, "\t"), "utf8");
		registerTiers(registrar, { configPath });
		const fastV2 = registrar.registered.filter((model) => model.id === "快").at(-1)!;
		const physical = new Map<string, unknown>([["m-main", { id: "m-main" }]]);
		const routed = routeOf(fastV2, "medium", physical);
		expect(routed.model).toEqual({ id: "m-main" });
	});
});

describe("档位路由端到端(经 pi 扩展注册,faux provider 派发验证)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function setup(config: unknown) {
		const configPath = writeConfig(config);
		const harness = await createHarness({
			models: [
				{ id: "m-fast", reasoning: true },
				{ id: "m-main", reasoning: true },
			],
			extensionFactories: [
				(pi) => {
					registerTiers(pi, { configPath });
				},
			],
		});
		harnesses.push(harness);
		const runtime = harness.session.modelRuntime;
		harness.session.agent.streamFunction = (model, context, options) => runtime.streamSimple(model, context, options);
		await runtime.refresh({ allowNetwork: false });
		return harness;
	}

	interface Dispatched {
		model: string;
		thinkingLevel?: string;
	}

	function dispatched(harness: Harness): Dispatched[] {
		return harness.session.messages
			.filter((message) => message.role === "assistant")
			.map((message) => ({ model: message.model, thinkingLevel: message.thinkingLevel }));
	}

	it("选 pao/快 → 派发 m-fast;思考档透传;显式选档跟随请求", async () => {
		const harness = await setup(CONFIG_V1);
		const fast = harness.session.modelRuntime.getModel("pao", "快");
		expect(fast).toBeDefined();
		await harness.session.setModel(fast!);

		harness.session.setThinkingLevel("low");
		harness.faux.appendResponses([fauxAssistantMessage("好的")]);
		await harness.session.prompt("随便聊一句");

		const sent = dispatched(harness);
		expect(sent.length).toBeGreaterThan(0);
		expect(sent.every((message) => message.model === "m-fast")).toBe(true);
		expect(sent.at(-1)!.thinkingLevel).toBe("low");

		// 用户显式升档:跟随请求,物理模型不变
		harness.session.setThinkingLevel("high");
		harness.faux.appendResponses([fauxAssistantMessage("再聊一句")]);
		await harness.session.prompt("再来一句");
		const last = dispatched(harness).at(-1)!;
		expect(last.model).toBe("m-fast");
		expect(last.thinkingLevel).toBe("high");
	});

	it("选 pao/主力 → 派发 m-main;改配置后同一档位名派发到新物理模型", async () => {
		const harness = await setup(CONFIG_V1);
		const main = harness.session.modelRuntime.getModel("pao", "主力");
		expect(main).toBeDefined();
		await harness.session.setModel(main!);
		harness.session.setThinkingLevel("high");

		harness.faux.appendResponses([fauxAssistantMessage("完成")]);
		await harness.session.prompt("干点正事");
		expect(dispatched(harness).at(-1)!.model).toBe("m-main");

		const harness2 = await setup(CONFIG_V2);
		const fast2 = harness2.session.modelRuntime.getModel("pao", "快");
		await harness2.session.setModel(fast2!);
		harness2.session.setThinkingLevel("medium");
		harness2.faux.appendResponses([fauxAssistantMessage("完成")]);
		await harness2.session.prompt("干点正事");
		expect(dispatched(harness2).at(-1)!.model).toBe("m-main");
	});
});
