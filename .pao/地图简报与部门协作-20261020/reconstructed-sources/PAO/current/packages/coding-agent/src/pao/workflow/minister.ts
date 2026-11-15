/** 宿主注入的工作流身份。模型只填写工作内容，实例/轮次/会话由真实会话和清单取得。 */
import { readFileSync } from "node:fs";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import {
	addNodeCards,
	buildDecisionPackage,
	controlPath,
	decideNode,
	endDecomposition,
	type NodeCardInput,
	readControl,
	requestRuling,
} from "./control.ts";
import type { DriverOptions } from "./driver.ts";
import type { WorkflowRecipe } from "./recipe.ts";

export const WORKFLOW_MINISTER_ENV = "PAO_WORKFLOW_MINISTER";
export interface WorkflowMinisterContext {
	名字: string;
	实例: string;
	节点: string;
	轮次: number;
	owner: string;
	cardsDir: string;
	workspaceDir?: string;
}
export function readMinisterContext(): WorkflowMinisterContext | undefined {
	const text = process.env[WORKFLOW_MINISTER_ENV];
	if (!text) return undefined;
	const value = JSON.parse(text) as WorkflowMinisterContext;
	for (const key of ["名字", "实例", "节点", "owner", "cardsDir"] as const)
		if (typeof value[key] !== "string" || !value[key].trim()) throw new Error(`部长工作流环境缺少 ${key}`);
	if (!Number.isSafeInteger(value.轮次) || value.轮次 < 1) throw new Error("部长工作流轮次非法");
	return value;
}
export function loadFrozenRecipe(name: string, options: DriverOptions): WorkflowRecipe {
	const file = controlPath({ 名字: name }, options);
	const { frontmatter } = parseFrontmatter<{ 冻结配方?: WorkflowRecipe }>(readFileSync(file, "utf8"));
	if (!frontmatter.冻结配方 || frontmatter.冻结配方.名字 !== name) throw new Error("冻结配方丢失或归属失配");
	return readControl(frontmatter.冻结配方, options).冻结配方;
}
export function registerWorkflowMinisterTools(pi: ExtensionAPI, assigned: WorkflowMinisterContext): void {
	const options: DriverOptions = {
		cardsDir: assigned.cardsDir,
		workspaceDir: assigned.workspaceDir,
		ownerSessionId: assigned.owner,
	};
	const identity = (ctx: ExtensionContext) => {
		const recipe = loadFrozenRecipe(assigned.名字, options);
		const flow = readControl(recipe, options);
		const session = ctx.sessionManager.getSessionId();
		const node = flow.节点.find((n) => n.名字 === assigned.节点);
		if (flow.实例 !== assigned.实例 || !node || node.部长会话 !== session || node.轮次 !== assigned.轮次)
			throw new Error("真实部长会话与工作流绑定不符");
		return { recipe, id: { 实例: assigned.实例, 节点: node.名字, 轮次: node.轮次, 部长会话: session } };
	};
	pi.registerTool({
		name: "pao_minister_submit_cards",
		label: "交本节点卡片",
		description: "分批提交本节点工作卡；只入队，由主控保护链派发。最后必须显式结束拆解。身份来自当前真实部长会话。",
		parameters: Type.Object({
			cards: Type.Array(
				Type.Object({
					goal: Type.String(),
					acceptance: Type.String(),
					inputs: Type.Optional(Type.Array(Type.String())),
					constraints: Type.Optional(Type.String()),
				}),
			),
		}),
		execute: async (_call, params: { cards: NodeCardInput[] }, signal, _update, ctx) => {
			const { recipe, id } = identity(ctx);
			const refs = await addNodeCards(recipe, { ...options, signal }, id, params.cards);
			return { content: [{ type: "text", text: `已排队:${refs.join("、")}` }], details: undefined };
		},
	});
	pi.registerTool({
		name: "pao_breakdown_done",
		label: "结束本轮拆解",
		description: "明确声明本轮不再新增卡；零卡须说明理由。没有此信号节点不能完成。",
		parameters: Type.Object({ zero_cards_reason: Type.Optional(Type.String()) }),
		execute: async (_call, params: { zero_cards_reason?: string }, signal, _update, ctx) => {
			const { recipe, id } = identity(ctx);
			await endDecomposition(recipe, { ...options, signal }, id, params.zero_cards_reason);
			return { content: [{ type: "text", text: "本轮拆解已结束" }], details: undefined };
		},
	});
	pi.registerTool({
		name: "pao_submit_decision",
		label: "提交本节点判定",
		description: "审核部长根据判定包提交 pass/change/reject 与双轴证据；不代替单卡机械验收。",
		parameters: Type.Object({
			result: Type.Union([Type.Literal("pass"), Type.Literal("change"), Type.Literal("reject")]),
			reason: Type.String(),
			failure_axis: Type.Optional(
				Type.Union([Type.Literal("card"), Type.Literal("dept_standard"), Type.Literal("both")]),
			),
			references: Type.Array(Type.String()),
			target: Type.Optional(Type.String()),
		}),
		execute: async (
			_call,
			params: {
				result: "pass" | "change" | "reject";
				reason: string;
				failure_axis?: "card" | "dept_standard" | "both";
				references: string[];
				target?: string;
			},
			signal,
			_update,
			ctx,
		) => {
			const { recipe, id } = identity(ctx);
			// 工具参数英文名 → Decision 持久键（D5 保留）的写入映射收口在此一处。
			await decideNode(recipe, { ...options, signal }, id, {
				结果: params.result,
				理由: params.reason,
				失败轴: params.failure_axis,
				引用: params.references,
				目标: params.target,
			});
			return { content: [{ type: "text", text: "本轮判定已记录" }], details: undefined };
		},
	});
	pi.registerTool({
		name: "pao_minister_decision_pack",
		label: "读取本节点判定包",
		description: "生成并读取本节点及上游的卡面、diff、双轴标准和运行证据。缺证据如实标明。",
		parameters: Type.Object({}),
		execute: async (_call, _params, signal, _update, ctx) => {
			const { recipe, id } = identity(ctx);
			const path = await buildDecisionPackage(recipe, { ...options, signal }, id);
			return { content: [{ type: "text", text: `${path}\n${readFileSync(path, "utf8")}` }], details: undefined };
		},
	});
	pi.registerTool({
		name: "pao_request_ruling",
		label: "请求主控裁定",
		description: "判不了时说明原因；开关允许才交主控，否则停给人，不自动等待重试。",
		parameters: Type.Object({ reason: Type.String() }),
		execute: async (_call, params: { reason: string }, signal, _update, ctx) => {
			const { recipe, id } = identity(ctx);
			await requestRuling(recipe, { ...options, signal }, id, params.reason, true);
			return { content: [{ type: "text", text: "已暂停并记录裁定请求" }], details: undefined };
		},
	});
}
