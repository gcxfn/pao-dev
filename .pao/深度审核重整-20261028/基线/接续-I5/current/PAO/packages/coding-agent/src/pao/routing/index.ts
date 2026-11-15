/**
 * PAO 档位路由:两档起步(快/主力),定义全走 JSON 配置($PAO_HOME/pao配置/档位.json)。
 *
 * 每档封装物理模型(provider+model+thinkingLevel),注册成 pi 虚拟模型(registerVirtualModel),
 * 协议层只见档位名;配置缺失/字段不合法/物理模型不在目录时明确报错,不做静默回退(架构 §4.1)。
 */

import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { loadTierConfig, resolvePaoHome, resolveTierConfigPath, type TierConfig } from "./config.ts";
import { registerTierLossGuard } from "./session-guard.ts";
import { tiersToVirtualModels } from "./tiers.ts";

export * from "./config.ts";
export * from "./model-command.ts";
export * from "./session-guard.ts";
export * from "./tiers.ts";

export interface RegisterTiersOptions {
	/** 档位配置文件路径;缺省用 $PAO_HOME/pao配置/档位.json */
	configPath?: string;
	/** 跳过失注册守卫(测试极简注册口无 on() 时自动跳过,无须手设) */
	跳过失注册守卫?: boolean;
}

/** 供测试注入的极简注册口(只用到这两个方法;on 可选,缺省时守卫不注册) */
export interface TierRegistrar {
	registerVirtualModel(model: Parameters<ExtensionAPI["registerVirtualModel"]>[0]): void;
	on?(event: string, handler: (event: unknown, ctx: unknown) => void): void;
}

/**
 * 读档位配置并把每档注册成虚拟模型。配置缺失或字段不合法时抛结构化中文错误(指明缺哪个字段),
 * 不注册哑模型装没事。返回解析后的配置,方便调用方确认生效内容。
 * 注册成功后挂档位失注册守卫(恢复会话时虚拟模型丢失→警告不静默,见 session-guard.ts)。
 */
export function registerTiers<T extends TierRegistrar = ExtensionAPI>(
	pi: T,
	options: RegisterTiersOptions = {},
): TierConfig {
	const configPath = options.configPath ?? resolveTierConfigPath(resolvePaoHome());
	const config = loadTierConfig(configPath);
	for (const model of tiersToVirtualModels(config)) {
		pi.registerVirtualModel(model);
	}
	if (!options.跳过失注册守卫 && typeof pi.on === "function") {
		registerTierLossGuard(pi as never, config);
	}
	return config;
}
