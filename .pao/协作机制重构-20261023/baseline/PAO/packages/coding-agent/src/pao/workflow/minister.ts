/** 宿主注入的工作流身份。模型只填写工作内容，实例/轮次/会话由真实会话和清单取得。 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { stringify } from "yaml";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { projectRootForCards } from "../cards/index.ts";
import { readLatestVerdict } from "../cards/verifier.ts";
import {
	captureDispatchMap,
	loadDispatchMapArtifact,
	mapRefFor,
	parseDispatchUri,
	saveDispatchMapArtifact,
} from "../dispatch-brief/index.ts";
import { writeFileAtomic } from "../shared/atomic.ts";
import { withFileLock } from "../shared/lock.ts";
import { locateDispatchCard } from "../worker/dispatch-core.ts";
import {
	addNodeCards,
	buildDecisionPackage,
	controlPath,
	decideNode,
	endDecomposition,
	type FlowControl,
	type NodeCardInput,
	type NodeIdentity,
	readControl,
	requestRuling,
} from "./control.ts";
import type { DriverOptions } from "./driver.ts";
import type { WorkflowRecipe } from "./recipe.ts";

export const WORKFLOW_MINISTER_ENV = "PAO_WORKFLOW_MINISTER";
export const WORKFLOW_WORKER_REVIEW_REQUEST_EVENT = "工人审核请求";
export const WORKFLOW_WORKER_REVIEW_RESULT_EVENT = "工人审核结论";
export interface WorkflowMinisterContext {
	名字: string;
	实例: string;
	节点: string;
	轮次: number;
	owner: string;
	cardsDir: string;
	workspaceDir?: string;
}
export const WORKFLOW_NODE_MAP_EVENT = "节点交接地图";

export interface WorkerReviewRequestInput {
	requestId: string;
	cardRef: string;
	attempt: number;
	executionRoot: string;
	bindingDigest?: string;
	evidencePath: string;
	artifactPaths: string[];
	requirements: string[];
	mechanicalResultCount: number;
	unmetReportCount: number;
}

export interface WorkerReviewRequestRecord extends WorkerReviewRequestInput {
	type: "worker-review-request";
	instance: string;
	node: string;
	round: number;
	ministerSession: string;
	verdictTime: string;
	requestedAt: string;
}

export interface WorkerReviewDecisionRecord extends Omit<WorkerReviewRequestRecord, "type"> {
	type: "worker-review-result";
	result: "pass" | "hold";
	basis: string;
	resolvedAt: string;
}

function parseReviewRecord<T extends WorkerReviewRequestRecord | WorkerReviewDecisionRecord>(reason: string): T {
	let parsed: unknown;
	try {
		parsed = JSON.parse(reason);
	} catch {
		throw new Error("工人审核记录不是合法 JSON，拒绝继续");
	}
	if (
		!parsed ||
		typeof parsed !== "object" ||
		(parsed as { type?: unknown }).type !==
			((parsed as { result?: unknown }).result === undefined ? "worker-review-request" : "worker-review-result") ||
		typeof (parsed as { requestId?: unknown }).requestId !== "string" ||
		typeof (parsed as { cardRef?: unknown }).cardRef !== "string" ||
		!Number.isSafeInteger((parsed as { attempt?: unknown }).attempt) ||
		typeof (parsed as { ministerSession?: unknown }).ministerSession !== "string"
	)
		throw new Error("工人审核记录字段损坏，拒绝继续");
	return parsed as T;
}

function findReviewRecordReason(flow: FlowControl, event: string, requestId: string): string | undefined {
	for (const record of [...flow.记录].reverse()) {
		if (record.事件 !== event) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(record.理由);
		} catch {
			continue;
		}
		if (parsed && typeof parsed === "object" && (parsed as { requestId?: unknown }).requestId === requestId)
			return record.理由;
	}
	return undefined;
}

function assertCurrentReviewMaterial(
	card: ReturnType<typeof locateDispatchCard>,
	request: WorkerReviewRequestRecord,
): void {
	if (card.frontmatter.status !== "in_progress")
		throw new Error(`工人卡当前状态为 ${card.frontmatter.status}，只有进行中且待人工审的卡可审`);
	if (card.frontmatter.attempt !== request.attempt)
		throw new Error(`工人卡当前尝试 ${card.frontmatter.attempt} 与审核请求 ${request.attempt} 不一致`);
	const receipt = [...card.receipts]
		.reverse()
		.find((candidate) => candidate.attempt === request.attempt && candidate.archive_flag === undefined);
	if (!receipt) throw new Error(`当前尝试 ${request.attempt} 缺少有效工人回执`);
	if (!receipt.evidence?.includes(request.evidencePath))
		throw new Error("当前工人回执未包含审核请求指定的原始证据，拒绝审核");
	const verdict = readLatestVerdict(card.body);
	if (!verdict || verdict.时间 !== request.verdictTime) throw new Error("卡面机械验收记录已变化或缺失，审核请求失效");
	const mechanicalEntries = [
		...verdict.原文.matchAll(/^-\s*\[([^\]]+)\]\s+(.+?)\s+→\s+(过|未过|无法判|安检拦截)（/gm),
	].filter((match) => match[1] !== "自报复核" && match[1] !== "人话句");
	const recordedRequirements = [...verdict.原文.matchAll(/^-\s*\[人话句\]\s+(.+)\s*$/gm)].map((match) => {
		try {
			const value = JSON.parse(match[1]);
			return typeof value === "string" ? value : "";
		} catch {
			throw new Error("最新机械验收的人话句摘要损坏，审核请求失效");
		}
	});
	const attempt = /^-\s*尝试:\s*(\d+)\s*$/m.exec(verdict.原文)?.[1];
	if (attempt !== String(request.attempt))
		throw new Error(`最新机械验收尝试 ${attempt ?? "(缺失)"} 与审核请求 ${request.attempt} 不一致`);
	if (JSON.stringify(recordedRequirements) !== JSON.stringify(request.requirements))
		throw new Error("最新机械验收待人工判断条件与审核请求不一致，拒绝跨条件审核");
	if (verdict.结论 !== "全过停人工审")
		throw new Error(`最新机械验收结论为「${verdict.结论 || "缺失"}」，只有「全过停人工审」可提交本审核`);
	const root = /^-\s*执行根:\s*(.+)\s*$/m.exec(verdict.原文)?.[1]?.trim();
	if (root && root !== request.executionRoot)
		throw new Error("最新机械验收执行根与审核请求不一致，拒绝跨执行现场审核");
	const binding = /^-\s*关联摘要:\s*(.+)\s*$/m.exec(verdict.原文)?.[1]?.trim();
	if (request.bindingDigest && binding !== request.bindingDigest)
		throw new Error("最新机械验收关联摘要与审核请求不一致，拒绝跨尝试审核");
	if (!request.bindingDigest && binding) throw new Error("最新机械验收带关联摘要但审核请求缺少绑定，拒绝不完整审核");
	if (mechanicalEntries.length !== request.mechanicalResultCount)
		throw new Error("最新机械验收条目数量与审核请求不一致，机械材料已变化");
	const knownTypes = new Set(["跑", "存在", "包含"]);
	for (const match of mechanicalEntries) {
		if (!knownTypes.has(match[1]) || match[3] !== "过")
			throw new Error("最新机械验收不是全机械通过，部长不能覆盖机械失败或未知结果");
	}
}

/** 在既有流程记录中登记一次待审请求；只写审计记录，不移动卡状态。 */
export async function requestWorkerReview(
	recipe: WorkflowRecipe,
	options: DriverOptions,
	identity: NodeIdentity,
	input: WorkerReviewRequestInput,
): Promise<WorkerReviewRequestRecord> {
	return withFileLock(controlPath(recipe, options), () => {
		const flow = readControl(recipe, options);
		const node = flow.节点.find((candidate) => candidate.名字 === identity.节点);
		if (
			flow.实例 !== identity.实例 ||
			!node ||
			node.轮次 !== identity.轮次 ||
			node.部长会话 !== identity.部长会话 ||
			flow.暂停
		)
			throw new Error("工人审核请求的真实部长会话或工作流轮次不符");
		if (!node.卡.includes(input.cardRef)) throw new Error(`卡 ${input.cardRef} 不属于当前节点`);
		if (!input.requestId.trim()) throw new Error("工人审核请求缺少 request_id");
		if (!Number.isSafeInteger(input.mechanicalResultCount) || input.mechanicalResultCount < 0)
			throw new Error("工人审核请求的机械验收条目数量非法");
		if (findReviewRecordReason(flow, WORKFLOW_WORKER_REVIEW_REQUEST_EVENT, input.requestId))
			throw new Error("工人审核 request_id 重复，拒绝复用");
		const card = locateDispatchCard(options.cardsDir, input.cardRef);
		if (card.frontmatter.attempt !== input.attempt) throw new Error("工人审核请求的尝试与卡面当前尝试不一致");
		const request: WorkerReviewRequestRecord = {
			type: "worker-review-request",
			...input,
			requestId: input.requestId.trim(),
			instance: flow.实例,
			node: node.名字,
			round: node.轮次,
			ministerSession: identity.部长会话,
			verdictTime: readLatestVerdict(card.body)?.时间 ?? "",
			requestedAt: new Date().toISOString(),
		};
		assertCurrentReviewMaterial(card, request);
		flow.记录.push({
			时间: request.requestedAt,
			事件: WORKFLOW_WORKER_REVIEW_REQUEST_EVENT,
			节点: node.名字,
			轮次: node.轮次,
			理由: JSON.stringify(request),
		});
		writeFileAtomic(
			controlPath(recipe, options),
			`---\n${stringify(flow)}---\n<!-- v2 流程控制正本，不得从卡重建或当缓存删除 -->\n`,
		);
		return request;
	});
}

/** 读取某次审核请求的部长结论；host-bridge 只在工具结束与记录双重核对后消费。 */
export function readWorkerReviewDecision(flow: FlowControl, requestId: string): WorkerReviewDecisionRecord | undefined {
	const reason = findReviewRecordReason(flow, WORKFLOW_WORKER_REVIEW_RESULT_EVENT, requestId);
	return reason ? parseReviewRecord<WorkerReviewDecisionRecord>(reason) : undefined;
}

async function recordWorkerReviewDecision(
	recipe: WorkflowRecipe,
	options: DriverOptions,
	identity: NodeIdentity,
	params: {
		request_id: string;
		card_ref: string;
		attempt: number;
		result: "pass" | "hold";
		basis: string;
	},
): Promise<WorkerReviewDecisionRecord> {
	return withFileLock(controlPath(recipe, options), () => {
		const flow = readControl(recipe, options);
		const node = flow.节点.find((candidate) => candidate.名字 === identity.节点);
		if (
			flow.实例 !== identity.实例 ||
			!node ||
			node.轮次 !== identity.轮次 ||
			node.部长会话 !== identity.部长会话 ||
			flow.暂停
		)
			throw new Error("真实部长会话与当前审核请求绑定不符");
		const reason = findReviewRecordReason(flow, WORKFLOW_WORKER_REVIEW_REQUEST_EVENT, params.request_id);
		if (!reason) throw new Error("没有匹配的工人审核请求，拒绝自造审核");
		const request = parseReviewRecord<WorkerReviewRequestRecord>(reason);
		if (
			request.instance !== flow.实例 ||
			request.node !== node.名字 ||
			request.round !== node.轮次 ||
			request.ministerSession !== identity.部长会话 ||
			request.cardRef !== params.card_ref ||
			request.attempt !== params.attempt
		)
			throw new Error("审核请求的实例、节点、轮次、部长、卡或尝试与当前现场不符");
		if (!node.卡.includes(request.cardRef)) throw new Error("审核请求卡已不属于当前节点");
		if (findReviewRecordReason(flow, WORKFLOW_WORKER_REVIEW_RESULT_EVENT, request.requestId))
			throw new Error("本次工人审核已经记录，拒绝重复提交");
		const basis = params.basis.trim();
		if (!basis || basis.length > 1600) throw new Error("工人审核依据不能为空且最多 1600 字符");
		if (params.result === "pass" && request.unmetReportCount > 0)
			throw new Error("当前尝试有自报未达项，部长不能提交 pass；请逐项裁决或 hold");
		const card = locateDispatchCard(options.cardsDir, request.cardRef);
		assertCurrentReviewMaterial(card, request);
		const decision: WorkerReviewDecisionRecord = {
			...request,
			type: "worker-review-result",
			result: params.result,
			basis,
			resolvedAt: new Date().toISOString(),
		};
		flow.记录.push({
			时间: decision.resolvedAt,
			事件: WORKFLOW_WORKER_REVIEW_RESULT_EVENT,
			节点: node.名字,
			轮次: node.轮次,
			理由: JSON.stringify(decision),
		});
		writeFileAtomic(
			controlPath(recipe, options),
			`---\n${stringify(flow)}---\n<!-- v2 流程控制正本，不得从卡重建或当缓存删除 -->\n`,
		);
		return decision;
	});
}

/** 当前轮依赖节点的结构化交接地图；只读控制记录与已保存产物。 */
export function currentDependencyMaps(flow: FlowControl, nodeName: string, cardsDir: string): string[] {
	const def = flow.冻结配方.节点.find((candidate) => candidate.名字 === nodeName);
	if (!def) throw new Error(`冻结配方缺少节点 ${nodeName}`);
	const seen = new Set<string>();
	const refs: string[] = [];
	for (const dependency of def.depends_on) {
		const node = flow.节点.find((candidate) => candidate.名字 === dependency);
		if (!node) throw new Error(`冻结配方依赖节点 ${dependency} 不存在于控制正本`);
		const record = flow.记录.findLast(
			(candidate) =>
				candidate.事件 === WORKFLOW_NODE_MAP_EVENT && candidate.节点 === dependency && candidate.轮次 === node.轮次,
		);
		if (!record) continue;
		const parsed = parseDispatchUri(record.理由);
		if (parsed.scheme !== "pao-map") throw new Error(`节点 ${dependency} 的交接记录不是地图引用`);
		const map = loadDispatchMapArtifact(parsed.canonical, { cardsDir });
		if (map.status !== "valid" || map.scopeReviewRequired)
			throw new Error(`节点 ${dependency} 的交接地图未确认有效，拒绝让下游冒充已消费`);
		if (!seen.has(parsed.canonical)) {
			seen.add(parsed.canonical);
			refs.push(parsed.canonical);
		}
	}
	return refs;
}

async function recordNodeMap(recipe: WorkflowRecipe, options: DriverOptions, identity: NodeIdentity, ref: string) {
	await withFileLock(controlPath(recipe, options), () => {
		const flow = readControl(recipe, options);
		const node = flow.节点.find((candidate) => candidate.名字 === identity.节点);
		if (
			flow.实例 !== identity.实例 ||
			!node ||
			node.轮次 !== identity.轮次 ||
			node.部长会话 !== identity.部长会话 ||
			flow.暂停
		)
			throw new Error("真实部长会话与工作流绑定不符");
		const def = flow.冻结配方.节点.find((candidate) => candidate.名字 === identity.节点);
		if (!def?.只读 || node.卡.length > 0)
			throw new Error("节点地图只允许当前轮零卡的只读节点保存；需要工人调查时交侦察卡");
		const parsed = parseDispatchUri(ref);
		if (parsed.scheme !== "pao-map") throw new Error("节点交接引用必须是 pao-map");
		const current = flow.记录.findLast(
			(record) =>
				record.事件 === WORKFLOW_NODE_MAP_EVENT && record.节点 === identity.节点 && record.轮次 === identity.轮次,
		);
		const map = loadDispatchMapArtifact(parsed.canonical, { cardsDir: options.cardsDir });
		if (current) {
			if (map.previousRef !== current.理由)
				throw new Error("节点地图替代只能指向当前轮最新一版；不能用更早分支覆盖当前地图");
		} else if (map.previousRef !== undefined) {
			throw new Error("当前轮还没有可替代的节点地图");
		}
		flow.记录.push({
			时间: new Date().toISOString(),
			事件: WORKFLOW_NODE_MAP_EVENT,
			节点: identity.节点,
			轮次: identity.轮次,
			理由: parseDispatchUri(ref).canonical,
		});
		writeFileAtomic(
			controlPath(recipe, options),
			`---\n${stringify(flow)}---\n<!-- v2 流程控制正本，不得从卡重建或当缓存删除 -->\n`,
		);
	});
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
		name: "pao_minister_save_node_map",
		label: "保存本节点地图",
		description:
			"只读零卡节点需要向后继提供结构化调查结果时使用。只读取当前项目根已声明的 coverage，并保存到当前工作流受控输入目录；引用绑定当前实例、节点、轮次和真实部长会话，不冒充 worker 卡或 attempt。保存后才能调用 pao_breakdown_done 说明零卡理由。",
		parameters: Type.Object({
			coverage: Type.Array(Type.String()),
			excludes: Type.Optional(Type.Array(Type.String())),
			facts: Type.Optional(Type.Array(Type.String())),
			unknowns: Type.Optional(Type.Array(Type.String())),
			risks: Type.Optional(Type.Array(Type.String())),
			integration_owner: Type.Optional(Type.String()),
			scope_basis: Type.Optional(Type.Array(Type.String())),
			scope_confirmed: Type.Optional(Type.Boolean()),
			previous_ref: Type.Optional(Type.String()),
			supersession_reason: Type.Optional(Type.String()),
		}),
		execute: async (
			_call,
			params: {
				coverage: string[];
				excludes?: string[];
				facts?: string[];
				unknowns?: string[];
				risks?: string[];
				integration_owner?: string;
				scope_basis?: string[];
				scope_confirmed?: boolean;
				previous_ref?: string;
				supersession_reason?: string;
			},
			signal,
			_update,
			ctx,
		) => {
			const { recipe, id } = identity(ctx);
			signal?.throwIfAborted();
			if ((params.previous_ref === undefined) !== (params.supersession_reason === undefined))
				throw new Error("替代节点地图必须同时提供 previous_ref 与 supersession_reason");
			const current = readControl(recipe, options);
			const currentRecord = current.记录.findLast(
				(record) => record.事件 === WORKFLOW_NODE_MAP_EVENT && record.节点 === id.节点 && record.轮次 === id.轮次,
			);
			const node = current.节点.find((candidate) => candidate.名字 === id.节点)!;
			const def = current.冻结配方.节点.find((candidate) => candidate.名字 === id.节点)!;
			if (!def.只读 || node.卡.length > 0)
				throw new Error("节点地图只允许当前轮零卡的只读节点保存；需要工人调查时交侦察卡");
			if (params.previous_ref) {
				const parsed = parseDispatchUri(params.previous_ref);
				if (parsed.scheme !== "pao-map" || parsed.canonical !== currentRecord?.理由)
					throw new Error("previous_ref 必须指向当前节点、当前轮次最新保存的节点地图");
			}
			const previousRef = params.previous_ref ?? currentRecord?.理由;
			if (previousRef && !params.supersession_reason)
				throw new Error("替代当前节点地图时必须提供 supersession_reason");
			const projectRoot = projectRootForCards(options.cardsDir);
			const safeId = `wf-${id.实例}-${id.节点}-${id.轮次}-${randomUUID()}`.replace(/[^A-Za-z0-9._-]/g, "-");
			const map = captureDispatchMap({
				id: safeId,
				projectRoot,
				coverage: params.coverage,
				excludes: params.excludes,
				facts: params.facts,
				unknowns: params.unknowns,
				risks: params.risks,
				integrationOwner: params.integration_owner,
				scopeBasis: params.scope_basis,
				scopeConfirmed: params.scope_confirmed,
				previousRef,
				supersessionReason: params.supersession_reason,
			});
			const saved = await saveDispatchMapArtifact({ cardsDir: options.cardsDir, artifact: map });
			const ref = mapRefFor(map);
			await recordNodeMap(recipe, { ...options, signal }, id, ref);
			return {
				content: [{ type: "text", text: `${ref}\n${saved.status}` }],
				details: undefined,
			};
		},
	});
	pi.registerTool({
		name: "pao_minister_submit_cards",
		label: "交本节点卡片",
		description:
			"按真实工作边界提交本节点卡；只入队，由保护链派发。小任务交一张，只有独立风险、接口边界或可分别验收的成果才拆多张。独立审核节点的验证卡会派到受管副本，检查业务只读，临时生成物只可写副本；普通只读规划节点不能交卡。已有测试或证据能覆盖的检查不重复交卡，也不得借机增加需求外的功能。acceptance 的机械条件逐行使用「跑: 命令」「存在: 文件」「包含: 文件::文本」；质量、风格和需判断的条件写清人工审核责任，不能伪装成自动通过。最后必须显式结束拆解。身份来自当前真实部长会话。",
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
			// 入队前仍核对交接产物完整性；引用只从控制正本读取，不复制到卡面。
			currentDependencyMaps(readControl(recipe, options), id.节点, options.cardsDir);
			// 工作流依赖地图在派发时由控制正本注入，不在卡上复制第二份可过期指针。
			const refs = await addNodeCards(recipe, { ...options, signal }, id, params.cards);
			return { content: [{ type: "text", text: `已排队:${refs.join("、")}` }], details: undefined };
		},
	});
	pi.registerTool({
		name: "pao_minister_review_worker",
		label: "审核本节点工人结果",
		description:
			"仅处理宿主当前投递的工人审核请求。机械验收与越界门已由自动链先行完成；本工具只记录部长对该卡的 pass/hold、依据和请求绑定，不改卡状态、不交卷，也不能放行自报未达项。参数必须原样使用审核请求中的 request_id、card_ref 与 attempt。",
		parameters: Type.Object({
			request_id: Type.String(),
			card_ref: Type.String(),
			attempt: Type.Number(),
			result: Type.Union([Type.Literal("pass"), Type.Literal("hold")]),
			basis: Type.String(),
		}),
		execute: async (
			_call,
			params: {
				request_id: string;
				card_ref: string;
				attempt: number;
				result: "pass" | "hold";
				basis: string;
			},
			signal,
			_update,
			ctx,
		) => {
			const { recipe, id } = identity(ctx);
			signal?.throwIfAborted();
			const decision = await recordWorkerReviewDecision(recipe, { ...options, signal }, id, params);
			return {
				content: [{ type: "text", text: `工人审核已记录：${decision.result}` }],
				details: {
					type: "pao_worker_review",
					requestId: decision.requestId,
					cardRef: decision.cardRef,
					attempt: decision.attempt,
					instance: decision.instance,
					node: decision.node,
					round: decision.round,
					ministerSession: decision.ministerSession,
					result: decision.result,
					basis: decision.basis,
				},
			};
		},
	});
	pi.registerTool({
		name: "pao_breakdown_done",
		label: "结束本轮拆解",
		description:
			"明确声明本轮不再新增卡；没有此信号节点不能完成。zero_cards_reason 只说明本节点为何无需交卡，不能充当结构化地图。只读零卡但后继需要地图时，必须先调用 pao_minister_save_node_map 保存本节点交接；需要工人实地调查时再提交侦察卡，由 worker 调用 pao_save_dispatch_recon。没有可消费交接时请求裁定或停止，不得虚构地图。",
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
