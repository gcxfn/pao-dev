import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import { listPaoSubcommands } from "../command-router.ts";
import { redactContext } from "../context/index.ts";
import type { MinisterHandle } from "../host/handle.ts";
import { sessionMemory } from "../memory/session.ts";
import { loadTierConfig, resolvePaoHome, THINKING_LEVELS, TIER_CONFIG_RELATIVE_PATH } from "../routing/config.ts";
import { collectInstanceResults } from "../status/results.ts";
import { deleteRecipe, parseRecipe, recipePath, type WorkflowRecipe } from "../workflow/recipe.ts";
import { inspectTemplateInstall, installStarterTemplate } from "../workflow/templates.ts";
import {
	checkDesktopRecipeDelete,
	checkDesktopRecipeEdit,
	previewDesktopWorkflow,
	readDesktopRecipeCatalog,
	recipeRevision,
	renderDesktopRecipe,
} from "./editor.ts";
import { desktopOwnerEntry, desktopOwner as owner } from "./owners.ts";
import { readDesktopSessionIncrement, readDesktopWorkflowMinister } from "./read-model.ts";
import { readDesktopFlowsFresh } from "./workflow.ts";

export { resolvePaoHome } from "../routing/config.ts";
export { collectPending, collectPendingFresh } from "../status/pending.ts";
export { scanWorkflowInstances, scanWorkflowInstancesFresh } from "../status/workflow-instances.ts";
export * from "./canvas.ts";
export * from "./dept.ts";
export * from "./editor.ts";
export * from "./maintenance.ts";
export type { DesktopWorkerActivityRow } from "./owners.ts";
export { readDesktopWorkerActivity, registerDesktopOwner } from "./owners.ts";
export * from "./plans.ts";
export * from "./read-model.ts";
export * from "./view-envelope.ts";
export * from "./workflow.ts";

/**
 * D8c 结果页聚合（设计包 2026-10-04 §6.4 拍板：不进 ./pao 包 exports，桌面扩展后端直调本桥）。
 * 只读零落盘：跨项目按实例聚合四样（要求/实际 diff/验收/遗留）＋恢复摘要四态＋异常行，
 * 输出过 redactContext（与桌面快照同口径脱敏）。不做任何续跑动作——「拟续跑」只是建议文案。
 */
export async function readDesktopResults(paoHome: string): Promise<unknown> {
	return redactContext(await collectInstanceResults(paoHome));
}

export function readDesktopMinisters(sessionId: string, project: string): MinisterHandle[] {
	return redactContext(owner(sessionId, project).getMinisters()) as MinisterHandle[];
}

export async function readDesktopMinister(sessionId: string, project: string, ministerId: string, offset: number) {
	const current = owner(sessionId, project);
	const minister = current.getMinisters().find((entry) => entry.会话标识 === ministerId);
	const flow = (await readDesktopFlowsFresh(project)).工作流.find((entry) =>
		entry.控制.节点.some((node) => node.部长会话 === ministerId),
	);
	if (flow && flow.控制.owner !== sessionId) throw new Error("部长属于另一 owner，请跳转原会话读取");
	if (!flow && (!minister || realpathSync(minister.项目根) !== realpathSync(project)))
		throw new Error("该部长不属于当前项目/owner，不能读取任意会话");
	if (flow) {
		const node = flow.控制.节点.find((entry) => entry.部长会话 === ministerId)!;
		return readDesktopWorkflowMinister(project, flow.控制.实例, node.名字, node.轮次, offset);
	}
	const directory = current.ctx.sessionManager.getSessionDir();
	const matches = readdirSync(directory).filter((name) => name.endsWith(`_${ministerId}.jsonl`));
	if (matches.length !== 1) throw new Error("部长会话未在当前会话目录唯一定位，保留未知；请在原 owner 查看会话");
	const path = realpathSync(join(directory, matches[0]));
	if (dirname(path) !== realpathSync(directory)) throw new Error("部长会话路径越出所属目录");
	return readDesktopSessionIncrement(path, offset);
}

export async function runDesktopFlowCommand(
	sessionId: string,
	project: string,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<void> {
	const trusted = async () => {
		// 桌面侧请求键（S9-桌面包 57e1ec4 起）与 /pao flow control JSON 协议（nodeControlTool schema）均为英文键；
		// 读侧 flow.控制/节点 等中文键是 D5 保留的实例清单持久面，不随迁。
		const matches = (await readDesktopFlowsFresh(project)).工作流.filter(
			(entry) => entry.控制.实例 === params.instance,
		);
		if (matches.length !== 1) throw new Error("实例不在当前项目唯一发现，拒绝外部卡目录");
		const flow = matches[0].控制;
		const node = flow.节点.find((entry) => entry.名字 === params.node);
		if (params.name !== flow.工作流 || params.cards_dir !== flow.卡目录 || !node || params.round !== node.轮次)
			throw new Error("实例/卡目录/节点/轮次已变化，请刷新");
		if (params.action !== "resume" && flow.owner !== sessionId) throw new Error("请跳转原 owner 会话处理");
		if (params.action === "resume" && params.prev_owner !== flow.owner) throw new Error("原 owner 已变化，请刷新");
		return {
			name: flow.工作流,
			cards_dir: flow.卡目录,
			instance: flow.实例,
			node: node.名字,
			round: node.轮次,
			prev_owner: flow.owner,
			action: params.action,
			reason: params.reason,
			result: params.result,
			references: params.references,
			target: params.target,
			failure_axis: params.failure_axis,
		};
	};
	const current = await controlOwner(sessionId, project, signal, trusted);
	const flow = listPaoSubcommands(current.pi).find((entry) => entry.name === "flow");
	if (!flow) throw new Error("此 owner 无工作流入口");
	await flow.run(current.pi, `control ${JSON.stringify(await trusted())}`, current.ctx);
}

export function readDesktopEditor(sessionId: string, project: string) {
	const current = owner(sessionId, project);
	const messages = current.ctx.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "message")
		.slice(-30)
		.map((entry) => {
			const message = entry.message;
			if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult")
				return { role: message.role, content: "扩展消息请在原对话查看" };
			return {
				role: message.role,
				content:
					typeof message.content === "string"
						? message.content
						: message.content.filter((block) => block.type === "text"),
			};
		});
	return {
		catalog: readDesktopRecipeCatalog(resolvePaoHome()),
		session: sessionId,
		project: project,
		// 视图三键（§10 收口批随迁，定名 busy/dialog/currentModel；桌面 flow-desktop 消费点同批）
		busy: !current.ctx.isIdle(),
		dialog: redactContext(messages),
		currentModel: current.ctx.model ? `${current.ctx.model.provider}/${current.ctx.model.id}` : "未知",
	};
}

async function controlOwner(
	sessionId: string,
	project: string,
	signal?: AbortSignal,
	validate?: () => Promise<unknown> | unknown,
) {
	const current = owner(sessionId, project);
	const control = listPaoSubcommands(current.pi).find((entry) => entry.name === "runtime");
	if (!control) throw new Error("原 owner 控制入口未装载");
	const combined =
		signal && current.ctx.signal ? AbortSignal.any([signal, current.ctx.signal]) : (signal ?? current.ctx.signal);
	const recheck = async () => {
		combined?.throwIfAborted();
		if (owner(sessionId, project) !== current) throw new Error("原会话上下文已切换，请刷新");
		await control.run(current.pi, "", current.ctx);
		combined?.throwIfAborted();
		if (owner(sessionId, project) !== current) throw new Error("原会话上下文已切换，请刷新");
		await validate?.();
	};
	await recheck();
	const ctx: ExtensionContext = {
		...current.ctx,
		signal: combined,
		ui: {
			...current.ctx.ui,
			confirm: async (...args) => {
				await recheck();
				const result = await current.ctx.ui.confirm(...args);
				await recheck();
				return result;
			},
		},
	};
	return { ...current, ctx, recheck };
}

export async function sendDesktopChat(
	sessionId: string,
	project: string,
	text: string,
	signal?: AbortSignal,
): Promise<void> {
	if (!text.trim() || text.length > 100_000) throw new Error("对话内容为空或过长");
	if (text.trim().startsWith("/")) throw new Error("斜杠命令请在原主控对话输入；画布聊天只提交普通对话。");
	const current = await controlOwner(sessionId, project, signal);
	if (!current.ctx.isIdle()) throw new Error("原会话仍在执行，请等结束或在原对话停止后发送。");
	current.pi.sendUserMessage(text);
}

export async function installDesktopTemplate(
	sessionId: string,
	project: string,
	templateId: string,
	name?: string,
	signal?: AbortSignal,
): Promise<void> {
	const current = await controlOwner(sessionId, project, signal);
	const home = resolvePaoHome();
	const preview = inspectTemplateInstall(home, templateId, { name });
	if (
		!current.ctx.hasUI ||
		!(await current.ctx.ui.confirm(
			"安装工作流模板",
			`${preview.name}\n${preview.description}\n${preview.status}\n${preview.diff}\n同名修改默认保留，不自动覆盖。`,
		))
	)
		throw new Error("未确认安装模板");
	owner(sessionId, project);
	await installStarterTemplate(home, templateId, { name });
}

export async function saveDesktopRecipe(
	sessionId: string,
	project: string,
	recipe: WorkflowRecipe,
	revision: string | null,
	signal?: AbortSignal,
): Promise<void> {
	const current = await controlOwner(sessionId, project, signal);
	const home = resolvePaoHome();
	const text = await checkDesktopRecipeEdit(home, project, recipe, revision);
	if (
		!current.ctx.hasUI ||
		!(await current.ctx.ui.confirm("保存工作流配方", `${text}\n覆盖现有配方会先留备份；运行实例不热更新。`))
	)
		throw new Error("未确认保存，未修改配方");
	owner(sessionId, project);
	await checkDesktopRecipeEdit(home, project, recipe, revision);
	const flow = listPaoSubcommands(current.pi).find((entry) => entry.name === "flow");
	if (!flow) throw new Error("原 owner 没有工作流入口");
	await flow.run(
		current.pi,
		`save ${JSON.stringify({ name: recipe.名字, content: text, overwrite: revision !== null })}`,
		current.ctx,
	);
}

/** 桌面删除配方入口：守卫（版本漂移/清单不可读/运行中实例，与编辑同拒绝模式）＋ ui.confirm
 *  显式确认后复用内核 deleteRecipe（只删 <名字>.md 本体；同名 .bak 备份与实例冻结图不受影响）。 */
export async function deleteDesktopRecipe(
	sessionId: string,
	project: string,
	name: string,
	revision: string | null,
	signal?: AbortSignal,
): Promise<void> {
	const current = await controlOwner(sessionId, project, signal);
	const home = resolvePaoHome();
	const check = () => checkDesktopRecipeDelete(home, project, name, revision);
	await check();
	if (
		!current.ctx.hasUI ||
		!(await current.ctx.ui.confirm(
			"删除工作流配方",
			`删除 ${recipePath(home, name)}\n同名 .bak 备份与冻结运行记录不受影响。`,
		))
	)
		throw new Error("未确认删除，未修改配方");
	owner(sessionId, project);
	await check();
	deleteRecipe(home, name);
}

export async function startDesktopWorkflow(
	sessionId: string,
	project: string,
	recipe: WorkflowRecipe,
	revision: string,
	parameters: Record<string, string>,
	masterTier: string,
	thinking: string,
	signal?: AbortSignal,
): Promise<void> {
	const current = await controlOwner(sessionId, project, signal);
	if (!current.ctx.isIdle()) throw new Error("原会话仍在执行，不能同时启流");
	const home = resolvePaoHome();
	const check = () => {
		if (parameters.项目 && realpathSync(parameters.项目) !== realpathSync(project))
			throw new Error("项目参数必须是当前主控项目；请切换到目标项目的专属主控后启动。");
		const actual = readFileSync(recipePath(home, recipe.名字), "utf8");
		if (recipeRevision(actual) !== revision) throw new Error("配方版本已变化，请刷新并重新预检");
		if (
			renderDesktopRecipe(home, parseRecipe(actual, recipePath(home, recipe.名字))) !==
			renderDesktopRecipe(home, recipe)
		)
			throw new Error("画布存在未保存改动；先保存，再启动，不能预览一份却执行另一份");
		const preview = previewDesktopWorkflow(home, project, recipe, parameters);
		if (!preview.report.canStart) throw new Error(`启动前检查未过：${JSON.stringify(preview.report.items)}`);
		return preview;
	};
	const preview = check();
	const tiers = loadTierConfig(join(home, TIER_CONFIG_RELATIVE_PATH));
	const tier = tiers.档位.find((entry) => entry.名 === masterTier);
	if (!tier || !THINKING_LEVELS.includes(thinking as (typeof THINKING_LEVELS)[number]))
		throw new Error("主控档位或思考强度无效");
	const model = current.ctx.modelRegistry.find(tiers.provider, masterTier);
	if (!model) throw new Error("主控虚拟档位未注册，不能猜测其他模型");
	if (
		!current.ctx.hasUI ||
		!(await current.ctx.ui.confirm(
			"显式启动新工作流",
			`${JSON.stringify(preview, null, 2)}\n主控：${masterTier} / ${thinking}\n启动会产生真实模型请求。`,
		))
	)
		throw new Error("未确认启动，未派发");
	owner(sessionId, project);
	check();
	const flow = listPaoSubcommands(current.pi).find((entry) => entry.name === "flow");
	if (!flow) throw new Error("原 owner 没有工作流入口");
	const previousModel = current.ctx.model;
	const previousThinking = current.pi.getThinkingLevel();
	const originalOwner = owner(sessionId, project);
	try {
		if (!(await current.pi.setModel(model))) throw new Error("主控模型切换失败，未启动");
		await current.recheck();
		current.pi.setThinkingLevel(thinking as (typeof THINKING_LEVELS)[number]);
		const cardsDir = join(project, ".pao", `工作流-${recipe.名字}-${randomUUID()}`, "卡");
		await flow.run(
			current.pi,
			`start ${JSON.stringify({ name: recipe.名字, params: parameters, cards_dir: cardsDir })}`,
			current.ctx,
		);
	} catch (error) {
		if (
			desktopOwnerEntry(sessionId) !== originalOwner ||
			originalOwner.ctx.sessionManager.getSessionId() !== sessionId
		)
			throw error;
		if (previousModel && !(await current.pi.setModel(previousModel)))
			throw new Error(`启流失败且旧模型恢复失败：${String(error)}`);
		current.pi.setThinkingLevel(previousThinking);
		throw error;
	}
}

/** 仅已有记忆命令；确认、供应商身份和写前重核继续由 owner 实现负责。 */
export async function runDesktopMemoryCommand(
	sessionId: string,
	project: string,
	args: string,
	revision: string,
	signal?: AbortSignal,
): Promise<void> {
	if (!/^(?:exclude|forget) \d+$|^correct \d+ [\s\S]+$/.test(args)) throw new Error("记忆动作参数不合法");
	const current = await controlOwner(sessionId, project, signal);
	if (
		createHash("sha256")
			.update(JSON.stringify(sessionMemory(current.pi).snapshot()))
			.digest("hex") !== revision
	)
		throw new Error("记忆来源已变化，旧编号操作失效；请刷新后重新选择。");
	if (!current.ctx.isIdle()) throw new Error("会话正在执行，请结束或停止后操作记忆。");
	const commands = listPaoSubcommands(current.pi);
	const control = commands.find((entry) => entry.name === "runtime");
	const memory = commands.find((entry) => entry.name === "memory");
	if (!control || !memory) throw new Error("此 owner 没有可用的控制权/记忆入口");
	await control.run(current.pi, "", current.ctx);
	owner(sessionId, project);
	await memory.run(current.pi, args, current.ctx);
}
