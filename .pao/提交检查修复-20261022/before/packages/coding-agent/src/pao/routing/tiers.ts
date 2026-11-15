import type { ExtensionContext, ExtensionVirtualModel } from "../../core/extensions/types.ts";
import type { ModelRoute, ModelRouteRequest } from "../../core/virtual-models.ts";
import { THINKING_LEVELS, type TierConfig, type TierDefinition } from "./config.ts";

/**
 * 把一个档位注册成虚拟模型:协议层只见档位名,route 时映射到配置声明的物理模型。
 *
 * 思考档透传:推荐档(thinkingLevel)排 thinkingLevels 首位,成为虚拟模型的默认选中档;
 * 用户显式选的档跟随 request.thinkingLevel 原样传给物理模型。
 */
export function tierToVirtualModel(tier: TierDefinition, provider: string): ExtensionVirtualModel {
	const levels = [tier.thinkingLevel, ...THINKING_LEVELS.filter((level) => level !== tier.thinkingLevel)];
	return {
		provider,
		id: tier.名,
		name: `档位:${tier.名}`,
		thinkingLevels: levels,
		...(tier.contextWindow !== undefined ? { contextWindow: tier.contextWindow } : {}),
		...(tier.maxTokens !== undefined ? { maxTokens: tier.maxTokens } : {}),
		route(request: ModelRouteRequest, ctx: ExtensionContext): ModelRoute {
			// 物理模型缺失:明确报错(含档位名与模型名),不回退默认模型,不做静默变笨
			const model = ctx.modelRegistry.find(tier.provider, tier.model);
			if (!model) {
				throw new Error(`档位「${tier.名}」指向的模型 ${tier.provider}/${tier.model} 不在模型目录中`);
			}
			return { model, thinkingLevel: request.thinkingLevel };
		},
	};
}

/** 全量注册清单:每个档位一个虚拟模型,挂在 config.provider 下 */
export function tiersToVirtualModels(config: TierConfig): ExtensionVirtualModel[] {
	return config.档位.map((tier) => tierToVirtualModel(tier, config.provider));
}
