/**
 * /pao 总入口与子命令路由（用户拍板 2026-10-03：命令统一，中文命令名全删）。
 *
 * 形态：唯一扩展命令 `pao`——裸 `/pao` 开可视化面板；`/pao queue`、`/pao status`
 * 这类英文子命令直达各功能。各功能模块经 `addPaoSubcommand` 把自己的 run 函数
 * 挂进会话级注册表，路由器在命令调用时查表分发：
 *
 * - 角色门控天然继承——worker/部长跳过的模块不会执行 addPaoSubcommand，
 *   其子命令在表里缺席，敲了如实报「未知子命令」（与旧「模块不注册命令」同语义）；
 * - 按 ExtensionAPI 实例隔离；桌面同进程多会话互不覆盖命令和闭包。
 *   所有读写显式指定实例，不回退到进程全局注册表。
 * - 解析层事实（验证过再定案）：pi 命令名＝斜杠后第一个空格前的 token、精确匹配，
 *   无冒号/空格等特殊语义——所以 `pao` 单命令＋空格子命令参数是最小改道。
 */

import type { ExtensionAPI } from "../core/extensions/types.ts";

/** 一个 pao 子命令：name 用于 /pao <name> 路由与面板执行；label/description 面板展示。 */
export interface PaoSubcommand {
	name: string;
	/** 面板/帮助里的中文短标签（如「队列」「工作流」） */
	label: string;
	description: string;
	run: (pi: ExtensionAPI, args: string, ctx: unknown) => Promise<void> | void;
}

let registries = new WeakMap<ExtensionAPI, PaoSubcommand[]>();

/** 模块注册期调用：挂一个子命令；同名覆盖（测试重复装配幂等）。 */
export function addPaoSubcommand(pi: ExtensionAPI, sub: PaoSubcommand): void {
	let subcommands = registries.get(pi);
	if (!subcommands) {
		subcommands = [];
		registries.set(pi, subcommands);
	}
	const hit = subcommands.findIndex((entry) => entry.name === sub.name);
	if (hit === -1) subcommands.push(sub);
	else subcommands[hit] = sub;
}

/** 当前会话可用的子命令（只读视图；面板与未知子命令提示共用）。 */
export function listPaoSubcommands(pi: ExtensionAPI): readonly PaoSubcommand[] {
	return [...(registries.get(pi) ?? [])];
}

/** 测试清表（同进程多次装配扩展时避免跨用例泄漏）。 */
export function resetPaoSubcommandsForTest(): void {
	registries = new WeakMap();
}

/** 未知子命令时的帮助文本（子命令缺席即如实列出在场面）。 */
export function paoHelpText(pi: ExtensionAPI, trigger: string): string {
	const rows = listPaoSubcommands(pi).map((sub) => `- ${sub.name}：${sub.label}——${sub.description}`);
	return [
		`未知的 pao 子命令：「${trigger}」。可用子命令（本会话装载面内）：`,
		...(rows.length > 0 ? rows : ["（无——本会话未注册任何 pao 子命令）"]),
		"裸敲 /pao 打开可视化面板。",
	].join("\n");
}

interface RouterCtx {
	ui?: {
		notify?: (message: string, type?: "info" | "warning" | "error") => void;
	};
}

/**
 * 注册唯一的 `pao` 扩展命令。openPanel＝裸 `/pao` 时的面板入口
 * （接线层注入，TUI/非 TUI 各自降级；面板实现见 panel/index.ts）。
 */
export function registerPaoCommand(
	pi: ExtensionAPI,
	openPanel: (pi: ExtensionAPI, ctx: unknown) => Promise<void> | void,
): void {
	pi.registerCommand("pao", {
		description:
			"pao 总入口：裸敲打开可视化面板（设置＋命令启动）；子命令直达——queue 队列 / status 状态 / budget 预算 / pano 全景 / flow 工作流 / collab 协作建卡 / model 档位",
		getArgumentCompletions: (argumentPrefix: string) => {
			const prefix = argumentPrefix.trim().toLowerCase();
			const hits = listPaoSubcommands(pi).filter(
				(sub) =>
					prefix === "" ||
					sub.name.startsWith(prefix) ||
					sub.label.includes(prefix) ||
					sub.description.includes(prefix),
			);
			if (hits.length === 0) return null;
			return hits.map((sub) => ({
				value: sub.name,
				label: `${sub.name}  ${sub.label}`,
				description: sub.description,
			}));
		},
		handler: async (args: string, ctxRaw: unknown) => {
			const trimmed = args.trim();
			if (trimmed === "") {
				await openPanel(pi, ctxRaw);
				return;
			}
			const spaceIndex = trimmed.indexOf(" ");
			const name = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
			const rest = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();
			const sub = listPaoSubcommands(pi).find((entry) => entry.name === name);
			if (sub) {
				await sub.run(pi, rest, ctxRaw);
				return;
			}
			const ctx = ctxRaw as RouterCtx;
			if (ctx.ui?.notify) ctx.ui.notify(paoHelpText(pi, name), "warning");
			else
				pi.sendMessage({
					customType: "pao-dispatch",
					content: [{ type: "text", text: paoHelpText(pi, name) }],
					display: true,
				});
		},
	});
}
