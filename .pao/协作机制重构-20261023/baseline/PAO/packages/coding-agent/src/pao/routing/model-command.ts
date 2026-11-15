/**
 * §22 档位制(pao 侧命令体,原 /model 接管):列表/切换/编辑都以档位为单位。
 *
 * 命令统一(2026-10-03):本文件经 command-router 挂成 /pao model 子命令;
 * TUI 薄改道已回退——原生 /model 回归物理模型直选(专家后门随之取消,直选就是原生行为)。
 *
 * 边界:编辑器只写 pao配置/档位.json(封装层);models.json(端点/密钥引用/单价,物理层)
 * 保持文件编辑不进交互。写回=写前自校验＋时间戳备份＋原子写(saveTierConfig),
 * 写回后对变更档重注册虚拟模型——当前会话立即可用,无须 reload。
 * ctx 能力依据:ExtensionCommandContext 继承 ExtensionContext(modelRegistry/model/ui);
 * 切模型走 pi.setModel(完整 Model 对象,本会话生效不改新会话默认)。
 */
import { join } from "node:path";

import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { addPaoSubcommand } from "../command-router.ts";
import { DEPT_DIR_NAME, REGISTRY_FILE_NAME, readRegistry } from "../dept/registry.ts";
import {
	loadTierConfig,
	resolvePaoHome,
	resolveTierConfigPath,
	saveTierConfig,
	THINKING_LEVELS,
	type TierConfig,
	type TierDefinition,
} from "./config.ts";
import { tierToVirtualModel } from "./tiers.ts";

/** 命令注册注入面(测试/宿主覆盖路径;缺省 $PAO_HOME/pao配置/档位.json) */
export interface ModelCommandOptions {
	resolvePaoHome?: () => string;
	configPath?: string;
}

/** 命令 handler 的 ctx 最小面(测试注入用;真实=ExtensionCommandContext) */
interface CommandCtx {
	ui: {
		select: (title: string, options: string[], opts?: unknown) => Promise<string | undefined>;
		confirm: (title: string, message: string) => Promise<boolean>;
		input: (title: string, placeholder?: string) => Promise<string | undefined>;
		notify: (message: string, type?: "info" | "warning" | "error") => void;
	};
	modelRegistry?: {
		find: (provider: string, id: string) => unknown;
		getAll: () => { provider: string; id: string; name?: string }[];
	};
	model?: { id: string } | undefined;
}

/** 档位在 select 列表里的行:档名 ＝ 物理模型·思考档（当前/部门默认标记） */
function tierRow(tier: TierDefinition, config: TierConfig, currentId: string | undefined): string {
	const marks: string[] = [];
	if (currentId === tier.名) marks.push("●当前");
	const depts = Object.entries(config.部门默认 ?? {})
		.filter(([, tierLabel]) => tierLabel === tier.名)
		.map(([dept]) => dept);
	if (depts.length > 0) marks.push(`部门默认:${depts.join("、")}`);
	const markText = marks.length > 0 ? `（${marks.join("｜")}）` : "";
	return `${tier.名} ＝ ${tier.provider}/${tier.model}·${tier.thinkingLevel}${markText}`;
}

/** 切档:虚拟模型从 registry 查出完整 Model 再 setModel(本会话生效,不改新会话默认) */
async function switchTier(
	ctx: CommandCtx,
	pi: { setModel: (model: never) => Promise<boolean> },
	config: TierConfig,
	tierName: string,
): Promise<void> {
	const model = ctx.modelRegistry?.find(config.provider, tierName);
	if (!model) {
		ctx.ui.notify(
			`虚拟模型「${tierName}」未注册(档位.json 改后未重载?):/reload 后再试,或选「编辑档位…」写回时自动重注册`,
			"warning",
		);
		return;
	}
	const ok = await pi.setModel(model as never);
	ctx.ui.notify(
		ok ? `已切到档位「${tierName}」(本会话生效,不改新会话默认)` : `切换失败:${config.provider} 未配置鉴权`,
		ok ? "info" : "error",
	);
}

/** 引导式档位编辑:选档→选物理模型→选思考档→确认写回(备份+原子写)→重注册该档 */
async function editTierFlow(ctx: CommandCtx, pi: ExtensionAPI, config: TierConfig, configPath: string): Promise<void> {
	const lineOptions = config.档位.map((t) => tierRow(t, config, ctx.model?.id));
	const newLabel = "新建档位…";
	const picked = await ctx.ui.select("编辑哪个档位", [...lineOptions, newLabel]);
	if (picked === undefined) return;
	let tier: TierDefinition;
	if (picked === newLabel) {
		const name = (await ctx.ui.input("新档位名(即虚拟模型 id,如「快」)"))?.trim();
		if (!name) return;
		if (config.档位.some((t) => t.名 === name)) {
			ctx.ui.notify(`档位「${name}」已存在,要改请直接选它编辑`, "error");
			return;
		}
		tier = { 名: name, provider: "", model: "", thinkingLevel: "low" };
	} else {
		// 结构化定位:行选项与 config.档位 同序同源,按选项在数组里的下标取档。
		// 旧口径 picked.startsWith(`${名} ＝`) 是文本格式匹配——档名含「＝」或互为前缀时
		// 静默错配到第一个前缀命中的档;行格式一改(分隔符/标记)匹配就断。
		const optionIndex = lineOptions.indexOf(picked);
		if (optionIndex === -1) {
			ctx.ui.notify(`未识别的档位选项:${picked}`, "error");
			return;
		}
		tier = config.档位[optionIndex];
	}

	// 物理模型:registry 全模型池(排除本档位 provider 的虚拟模型),含手输后门(自定义 models.json 条目)
	const manualLabel = "手输 provider/model…";
	const pool = (ctx.modelRegistry?.getAll() ?? []).filter((m) => m.provider !== config.provider);
	const poolRows = pool.map((m) => `${m.provider}/${m.id}${m.name ? `（${m.name}）` : ""}`);
	const modelPick = await ctx.ui.select(`「${tier.名}」封装哪个物理模型`, [...poolRows, manualLabel]);
	if (modelPick === undefined) return;
	// 供应商与模型名分开取,不走「拼成 provider/model 再按斜杠切」的往返(审查第 6 项):
	// 模型 id 本身可含斜杠(如 openrouter/anthropic/claude-sonnet-4),第二次切分会把
	// id 截成第一段,配置里留下一个不存在的模型名却提示成功。
	let provider: string;
	let model: string;
	if (modelPick === manualLabel) {
		const typed = (await ctx.ui.input("provider/model(如 zai-coding-cn/glm-5.3)"))?.trim();
		if (!typed) return;
		// 手输口径:按第一个斜杠切——斜杠前是供应商,其后整段是完整模型名
		const slash = typed.indexOf("/");
		provider = slash > 0 ? typed.slice(0, slash) : "";
		model = slash > 0 ? typed.slice(slash + 1) : "";
		if (!provider || !model) {
			ctx.ui.notify("须形如 provider/model(供应商与模型名都不能为空)", "error");
			return;
		}
	} else {
		// 同上:按下标回取模型,不靠「截掉（备注）」的文本口径(id 含全角括号时会错配)
		const poolIndex = poolRows.indexOf(modelPick);
		if (poolIndex === -1) {
			ctx.ui.notify(`未识别的模型选项:${modelPick}`, "error");
			return;
		}
		const picked = pool[poolIndex];
		provider = picked.provider;
		model = picked.id;
	}

	// 思考档:当前档现有档标 ●(行与 THINKING_LEVELS 同序,按下标回取)
	const levelRows = THINKING_LEVELS.map((level) => (level === tier.thinkingLevel ? `${level} ●` : String(level)));
	const levelPick = await ctx.ui.select(`「${tier.名}」推荐思考档`, levelRows);
	if (levelPick === undefined) return;
	const tierIndex = levelRows.indexOf(levelPick);
	if (tierIndex === -1) {
		ctx.ui.notify(`未识别的思考档选项:${levelPick}`, "error");
		return;
	}
	const thinkingLevel = THINKING_LEVELS[tierIndex];

	const next: TierDefinition = { ...tier, provider, model, thinkingLevel };
	const ok = await ctx.ui.confirm(
		"确认写回档位.json",
		`档位「${next.名}」＝ ${provider}/${model}·${thinkingLevel}\n写前自动时间戳备份,写后该档重注册(当前会话即可用)。`,
	);
	if (!ok) return;
	const newConfig: TierConfig = {
		...config,
		档位: config.档位.some((t) => t.名 === next.名)
			? config.档位.map((t) => (t.名 === next.名 ? next : t))
			: [...config.档位, next],
	};
	try {
		saveTierConfig(configPath, newConfig);
	} catch (error) {
		ctx.ui.notify(`写回失败:${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	pi.registerVirtualModel(tierToVirtualModel(next, newConfig.provider));
	ctx.ui.notify(`档位「${next.名}」已写回并重注册(${join("pao配置", "档位.json")},备份同目录 .bak-时间戳)`, "info");
}

/** 部门默认编辑:列注册表部门＋档位.json 现有键,选部门→选档(可清除)→写回 */
async function editDeptDefaultsFlow(
	ctx: CommandCtx,
	config: TierConfig,
	configPath: string,
	paoHome: string | undefined,
): Promise<void> {
	let depts: string[] = [];
	try {
		depts = readRegistry(join(paoHome ?? "", DEPT_DIR_NAME, REGISTRY_FILE_NAME)).map((r) => r.名字);
	} catch {
		// 注册表缺失:仅列档位.json 现有键
	}
	const known = [...new Set([...Object.keys(config.部门默认 ?? {}), ...depts])];
	const addedLabel = "新增部门…";
	const deptPick = await ctx.ui.select("改哪个部门的默认档", [...known, addedLabel]);
	if (deptPick === undefined) return;
	let dept = deptPick;
	if (deptPick === addedLabel) {
		const typed = (await ctx.ui.input("部门名(须与部门注册表一致)"))?.trim();
		if (!typed) return;
		dept = typed;
	}
	const clearLabel = "（清除该部门默认）";
	const tierPick = await ctx.ui.select(`「${dept}」默认用哪档`, [...config.档位.map((t) => t.名), clearLabel]);
	if (tierPick === undefined) return;
	const deptDefault = { ...(config.部门默认 ?? {}) };
	if (tierPick === clearLabel) delete deptDefault[dept];
	else deptDefault[dept] = tierPick;
	const ok = await ctx.ui.confirm(
		"确认写回档位.json",
		`部门默认.${dept} = ${tierPick === clearLabel ? "（清除）" : tierPick}`,
	);
	if (!ok) return;
	try {
		saveTierConfig(configPath, { ...config, 部门默认: deptDefault });
	} catch (error) {
		ctx.ui.notify(`写回失败:${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	ctx.ui.notify(`部门默认已写回:${dept}=${tierPick === clearLabel ? "（清除）" : tierPick}`, "info");
}

/** 注册 /pao model 子命令(§22 档位制;原 /model 接管,2026-10-03 命令统一迁入 pao 路由——原生 /model 回归物理模型直选,专家后门随之取消)。接线:registerTiers 同模块挂载。 */
export function registerModelCommand(pi: ExtensionAPI, options: ModelCommandOptions = {}): void {
	addPaoSubcommand(pi, {
		name: "model",
		label: "档位",
		description: "档位制(§22):列表/切换/编辑以档位为单位;直选物理模型走原生 /model",
		run: async (pi, args: string, ctxRaw: unknown) => {
			const ctx = ctxRaw as CommandCtx;
			const paoHome = options.resolvePaoHome?.() ?? resolvePaoHome();
			const configPath = options.configPath ?? resolveTierConfigPath(paoHome);
			let config: TierConfig;
			try {
				config = loadTierConfig(configPath);
			} catch (error) {
				ctx.ui.notify(`档位配置读失败:${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			const quick = args.trim();
			if (quick) {
				const tier = config.档位.find((t) => t.名 === quick);
				if (!tier) {
					ctx.ui.notify(
						`未找到档位「${quick}」,现有:${config.档位.map((t) => t.名).join("、")};直选物理模型请敲原生 /model`,
						"error",
					);
					return;
				}
				await switchTier(ctx, pi, config, quick);
				return;
			}
			const rows = config.档位.map((t) => tierRow(t, config, ctx.model?.id));
			const editLabel = "编辑档位…";
			const deptLabel = "编辑部门默认…";
			const picked = await ctx.ui.select("档位(§22 档位制)", [...rows, editLabel, deptLabel]);
			if (picked === undefined) return;
			if (picked === editLabel) {
				await editTierFlow(ctx, pi, config, configPath);
				return;
			}
			if (picked === deptLabel) {
				await editDeptDefaultsFlow(ctx, config, configPath, paoHome);
				return;
			}
			// 结构化定位:与 editTierFlow 同口径,按下标回取档,不靠行文本前缀匹配(显式 miss 不静默错配)
			const optionIndex = rows.indexOf(picked);
			if (optionIndex === -1) {
				ctx.ui.notify(`未识别的档位选项:${picked}`, "error");
				return;
			}
			await switchTier(ctx, pi, config, config.档位[optionIndex].名);
		},
	});
}
