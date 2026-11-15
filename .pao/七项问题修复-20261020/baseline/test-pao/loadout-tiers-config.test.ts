/**
 * M1-04 两档菜单配置:接真实配置文件 $PAO_HOME(使用现场)/pao配置/档位.json,
 * 不在测试里硬编码另一份档位定义——测的就是将要跑的那份配置。
 * 语义依据:架构 §98(两档起步:快/主力,每档封装物理模型+思考档)、§105(主控钉贵档、worker 默认便宜档)。
 * 使用现场(2026-10-02 分仓定案)＝workspace/pao 独立仓库;测试缺省从本文件位置向上
 * 六级到 workspace 再进 pao,与开发仓(pao-dev)解耦。
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ExtensionVirtualModel } from "../../src/core/extensions/types.ts";
import type { ModelRouteRequest } from "../../src/core/virtual-models.ts";
import {
	loadTierConfig,
	registerTiers,
	resolveTier,
	resolveTierConfigPath,
	validateTierConfig,
} from "../../src/pao/routing/index.ts";

/** 测试文件在 workspace/pao-dev/PAO/packages/coding-agent/test/pao/ 下,向上六级 = workspace,再进使用现场 pao */
const siteTier = join(
	resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", ".."),
	"pao",
	"pao配置",
	"档位.json",
);
/** 与生产同源的配置路径:PAO_HOME 优先,缺省落使用现场 */
const configPath = process.env.PAO_HOME ? resolveTierConfigPath(process.env.PAO_HOME) : siteTier;

/** 极简注册口:截获注册的虚拟模型定义,供直接调用 route */
function captureRegistrar() {
	const registered: ExtensionVirtualModel[] = [];
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	return {
		registered,
		handlers,
		registerVirtualModel(model: ExtensionVirtualModel): void {
			registered.push(model);
		},
		on(event: string, handler: (event: unknown, ctx: unknown) => void): void {
			handlers.set(event, handler);
		},
	};
}

function routeOf(model: ExtensionVirtualModel, thinkingLevel: string, ids: Set<string>): unknown {
	const ctx = { modelRegistry: { find: (_p: string, id: string) => (ids.has(id) ? { id } : undefined) } };
	return model.route({ thinkingLevel, reason: "user", messages: [] } as unknown as ModelRouteRequest, ctx as never);
}

describe("真实两档配置(pao配置/档位.json,与生产同源)", () => {
	it("配置文件存在(交付物,缺失即失败)", () => {
		expect(existsSync(configPath)).toBe(true);
		if (process.env.PAO_HOME) {
			expect(resolveTierConfigPath(process.env.PAO_HOME)).toBe(configPath);
		}
	});

	it("两档:快/主力;GLM 映射正确;思考档有差异(快=low,主力=high)", () => {
		const config = loadTierConfig(configPath);
		expect(config.provider).toBe("pao");
		expect(config.档位.map((tier) => tier.名)).toEqual(["快", "主力"]);

		const [snap, primary] = config.档位;
		expect(snap.provider).toBe("zai-coding-cn");
		expect(snap.model).toBe("glm-5.3-flash");
		expect(snap.thinkingLevel).toBe("low");
		expect(primary.provider).toBe("zai-coding-cn");
		expect(primary.model).toBe("glm-5.3");
		expect(primary.thinkingLevel).toBe("high");
		expect(snap.thinkingLevel).not.toBe(primary.thinkingLevel);
	});

	it("真实配置经 registerTiers 注册成两个虚拟模型,推荐思考档排首位;守卫已挂", () => {
		const registrar = captureRegistrar();
		const config = registerTiers(registrar, { configPath: configPath });
		expect(registrar.registered.map((model) => model.id)).toEqual(["快", "主力"]);
		expect(registrar.registered[0].thinkingLevels?.[0]).toBe("low");
		expect(registrar.registered[1].thinkingLevels?.[0]).toBe("high");
		expect(config).toEqual(loadTierConfig(configPath));
		// 失注册守卫:恢复会话时虚拟模型丢失要警告(M1-04)
		expect(registrar.handlers.has("session_start")).toBe(true);
	});

	it("route 映射到配置声明的 GLM 物理模型;模型不在目录时报错不回退", () => {
		const registrar = captureRegistrar();
		registerTiers(registrar, { configPath: configPath, 跳过失注册守卫: true });
		const [snap, primary] = registrar.registered;
		const dir = new Set(["glm-5.3-flash", "glm-5.3"]);

		const routedSnap = routeOf(snap, "low", dir) as { model: { id: string }; thinkingLevel: string };
		expect(routedSnap.model.id).toBe("glm-5.3-flash");
		expect(routedSnap.thinkingLevel).toBe("low");

		const routedPrimary = routeOf(primary, "high", dir) as { model: { id: string }; thinkingLevel: string };
		expect(routedPrimary.model.id).toBe("glm-5.3");
		expect(routedPrimary.thinkingLevel).toBe("high");

		expect(() => routeOf(snap, "low", new Set())).toThrowError(/档位「快」.*glm-5.3-flash.*不在模型目录中/s);
	});

	it("resolveTier 按名取档;查无此档列出真实档位名", () => {
		const config = loadTierConfig(configPath);
		expect(resolveTier(config, "快").model).toBe("glm-5.3-flash");
		expect(() => resolveTier(config, "经济")).toThrowError(/未找到档位「经济」.*快、主力/s);
	});

	it("校验器对残缺配置仍逐字段报错(守住'配置失效不静默')", () => {
		expect(() => validateTierConfig({ 档位: [{ 名: "快", provider: "zai-coding-cn" }] }, "真实.json")).toThrowError(
			/缺少字段「model」/,
		);
	});

	it("重复档名报错并指明档名(档位名即虚拟模型 id,不静默覆盖丢档)", () => {
		expect(() =>
			validateTierConfig(
				{
					provider: "pao",
					档位: [
						{ 名: "快", provider: "zai-coding-cn", model: "glm-5.3-flash", thinkingLevel: "low" },
						{ 名: "主力", provider: "zai-coding-cn", model: "glm-5.3", thinkingLevel: "high" },
						{ 名: "快", provider: "zai-coding-cn", model: "glm-5.3", thinkingLevel: "high" },
					],
				},
				"重复档名.json",
			),
		).toThrowError(/重复档名「快」/);
	});
});
