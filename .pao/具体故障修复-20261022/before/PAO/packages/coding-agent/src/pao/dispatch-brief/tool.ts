import { join, resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { findCardFile, loadCard, readCard } from "../cards/cardfile.ts";
import {
	appendCardInputReference,
	readDispatchContractContent,
	saveDispatchBriefArtifact,
	saveDispatchContractReference,
	saveDispatchMapArtifact,
} from "./artifacts.ts";
import { DispatchBriefError, errorMessage } from "./errors.ts";
import { findDispatchReferenceImpact, formatDispatchReferenceImpact } from "./impact.ts";
import { commitDispatchReconResult } from "./recon.ts";
import { DISPATCH_RECON_CATEGORIES } from "./recon-artifact.ts";
import type { DispatchBriefRequirements, DispatchCardWriteExpectation, DispatchReferenceImpact } from "./types.ts";
import { captureDispatchMap } from "./workspace.ts";

export interface DispatchBriefToolOptions {
	resolveCardsDir?: () => string | undefined;
	/** 保存替代版本后，由宿主接到现有共享 notifySurface 或 checkpoint 回流。 */
	onReferenceImpact?: (impact: DispatchReferenceImpact) => void | Promise<void>;
}

interface CardWriteParameters {
	card_no?: number;
	attempt?: number;
	owner?: string;
}

function expectedCardWrite(params: CardWriteParameters): DispatchCardWriteExpectation {
	if (!Number.isInteger(params.card_no) || !Number.isInteger(params.attempt) || !params.owner?.trim()) {
		throw new DispatchBriefError("card_changed", "写卡 inputs 时必须同时提供 card_no、attempt 与 owner", {});
	}
	return {
		attempt: params.attempt!,
		owner: params.owner,
		status: "in_progress",
	};
}

async function appendSavedReference(
	ref: string,
	params: CardWriteParameters & { card_path: string },
): Promise<boolean> {
	try {
		return (
			await appendCardInputReference({
				cardPath: params.card_path,
				ref,
				expected: expectedCardWrite(params),
			})
		).changed;
	} catch (error) {
		throw new DispatchBriefError(
			"card_changed",
			`产物已保存为 ${ref}，但写入卡 inputs 失败：${errorMessage(error)}`,
			{ ref, path: params.card_path },
		);
	}
}

async function mapResult(
	params: {
		id: string;
		cards_dir?: string;
		project_root: string;
		execution_root?: string;
		coverage: string[];
		excludes?: string[];
		facts?: string[];
		unknowns?: string[];
		risks?: string[];
		integration_owner?: string;
		scope_basis?: string[];
		scope_confirmed?: boolean;
		scope_review_required?: boolean;
		previous_ref?: string;
		supersession_reason?: string;
		affected_cards?: number[];
	},
	options?: DispatchBriefToolOptions,
): Promise<{ ref: string; changed: boolean; impact?: DispatchReferenceImpact }> {
	const cardsDir = params.cards_dir ?? options?.resolveCardsDir?.();
	if (!cardsDir) throw new Error("缺少 cards_dir，且当前环境没有默认卡目录");
	const artifact = captureDispatchMap({
		id: params.id,
		projectRoot: params.project_root,
		executionRoot: params.execution_root,
		coverage: params.coverage,
		excludes: params.excludes,
		facts: params.facts,
		unknowns: params.unknowns,
		risks: params.risks,
		integrationOwner: params.integration_owner,
		previousRef: params.previous_ref,
		supersessionReason: params.supersession_reason,
		scopeBasis: params.scope_basis,
		scopeConfirmed: params.scope_confirmed,
		scopeReviewRequired: params.scope_review_required,
	});
	const saved = await saveDispatchMapArtifact({ cardsDir, artifact });
	const impact = artifact.previousRef
		? findDispatchReferenceImpact({
				cardsDir,
				ref: saved.ref,
				previousRef: artifact.previousRef,
				reason: artifact.supersessionReason,
			})
		: undefined;
	return { ref: saved.ref, changed: false, ...(impact ? { impact } : {}) };
}

async function routeReferenceImpact(
	result: { impact?: DispatchReferenceImpact },
	options?: DispatchBriefToolOptions,
): Promise<void> {
	if (!result.impact || result.impact.affected.length === 0) return;
	await options?.onReferenceImpact?.(result.impact);
}

export function registerDispatchBriefTools(pi: ExtensionAPI, options?: DispatchBriefToolOptions): void {
	pi.registerTool({
		name: "pao_dispatch_brief",
		label: "保存 dispatch 输入",
		description:
			"保存准备派遣所需的结构化输入，不改变卡状态。action=map 生成并保存带覆盖范围、真实文件内容、暂存/未暂存/未跟踪状态的 Git 地图；action=contract 保存精确接口契约引用；action=brief 保存可注入的简报正文；action=append 把受控 URI 写入卡现有 inputs。地图不会默认全库扫描，目录覆盖用于检出新增调用方，覆盖边界不明时会标为需复核。",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("map"),
				Type.Literal("contract"),
				Type.Literal("brief"),
				Type.Literal("append"),
			]),
			cards_dir: Type.Optional(Type.String()),
			card_path: Type.Optional(Type.String()),
			ref: Type.Optional(Type.String()),
			id: Type.Optional(Type.String()),
			project_root: Type.Optional(Type.String()),
			execution_root: Type.Optional(Type.String()),
			coverage: Type.Optional(Type.Array(Type.String())),
			excludes: Type.Optional(Type.Array(Type.String())),
			card_no: Type.Optional(Type.Number()),
			attempt: Type.Optional(Type.Number()),
			version: Type.Optional(Type.String()),
			digest: Type.Optional(Type.String()),
			content_path: Type.Optional(Type.String()),
			purpose: Type.Optional(Type.String()),
			affected_cards: Type.Optional(Type.Array(Type.Number())),
			markdown: Type.Optional(Type.String()),
			owner: Type.Optional(Type.String()),
			facts: Type.Optional(Type.Array(Type.String())),
			unknowns: Type.Optional(Type.Array(Type.String())),
			risks: Type.Optional(Type.Array(Type.String())),
			integration_owner: Type.Optional(Type.String()),
			scope_basis: Type.Optional(Type.Array(Type.String())),
			scope_confirmed: Type.Optional(Type.Boolean()),
			scope_review_required: Type.Optional(Type.Boolean()),
			previous_ref: Type.Optional(Type.String()),
			supersession_reason: Type.Optional(Type.String()),
		}),
		execute: async (_toolCallId, params) => {
			try {
				let result: {
					ref: string;
					changed?: boolean;
					impact?: DispatchReferenceImpact;
				};
				if (params.action === "map") {
					if (!params.id || !params.project_root || !params.coverage) {
						throw new Error("action=map 需要 id、project_root、coverage");
					}
					result = await mapResult(
						{
							id: params.id,
							cards_dir: params.cards_dir,
							project_root: params.project_root,
							execution_root: params.execution_root,
							coverage: params.coverage,
							excludes: params.excludes,
							facts: params.facts,
							unknowns: params.unknowns,
							risks: params.risks,
							integration_owner: params.integration_owner,
							scope_basis: params.scope_basis,
							scope_confirmed: params.scope_confirmed,
							scope_review_required: params.scope_review_required,
							previous_ref: params.previous_ref,
							supersession_reason: params.supersession_reason,
							affected_cards: params.affected_cards,
						},
						options,
					);
					if (params.card_path) {
						result.changed = await appendSavedReference(result.ref, {
							...params,
							card_path: params.card_path,
						});
					}
					await routeReferenceImpact(result, options);
				} else if (params.action === "contract") {
					const cardsDir = params.cards_dir ?? options?.resolveCardsDir?.();
					if (
						!cardsDir ||
						!params.id ||
						!params.project_root ||
						!params.version ||
						!params.ref ||
						!params.content_path
					) {
						throw new Error("action=contract 需要 cards_dir、id、project_root、version、ref、content_path");
					}
					const content = readDispatchContractContent(params.project_root, params.content_path);
					const digest = params.digest ?? content.digest;
					const saved = await saveDispatchContractReference({
						cardsDir,
						projectRoot: params.project_root,
						id: params.id,
						version: params.version,
						ref: params.ref,
						digest,
						contentPath: params.content_path,
						purpose: params.purpose,
						affectedCards: params.affected_cards,
						previousRef: params.previous_ref,
						supersessionReason: params.supersession_reason,
					});
					result = { ref: saved.ref };
					if (params.card_path) {
						result.changed = await appendSavedReference(saved.ref, {
							...params,
							card_path: params.card_path,
						});
					}
					if (params.previous_ref) {
						result.impact = findDispatchReferenceImpact({
							cardsDir,
							ref: saved.ref,
							previousRef: params.previous_ref,
							reason: params.supersession_reason,
						});
					}
					await routeReferenceImpact(result, options);
				} else if (params.action === "brief") {
					const cardsDir = params.cards_dir ?? options?.resolveCardsDir?.();
					if (!cardsDir || !params.id || !params.card_no || !params.attempt || !params.owner || !params.markdown) {
						throw new Error("action=brief 需要 cards_dir、id、card_no、attempt、owner、markdown");
					}
					const found = params.card_path ? undefined : findCardFile(cardsDir, params.card_no);
					if (!params.card_path && !found) {
						throw new Error(`卡目录中找不到卡${String(params.card_no).padStart(4, "0")}`);
					}
					const cardPath = params.card_path ?? join(cardsDir, "卡", found!);
					const saved = await saveDispatchBriefArtifact({
						cardsDir,
						id: params.id,
						cardPath,
						cardNo: params.card_no,
						attempt: params.attempt,
						owner: params.owner,
						purpose: params.purpose,
						markdown: params.markdown,
					});
					result = { ref: saved.ref };
					result.changed = await appendSavedReference(saved.ref, {
						...params,
						card_path: cardPath,
					});
				} else {
					if (!params.card_path || !params.ref) throw new Error("action=append 需要 card_path、ref");
					result = {
						ref: params.ref,
						changed: await appendSavedReference(params.ref, {
							...params,
							card_path: params.card_path,
						}),
					};
				}
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								ref: result.ref,
								changed: result.changed,
								...(result.impact && formatDispatchReferenceImpact(result.impact)
									? { impact: result.impact }
									: {}),
							}),
						},
					],
					details: undefined,
				};
			} catch (error) {
				const code = error instanceof Error && "code" in error ? `[${String(error.code)}] ` : "";
				return {
					content: [
						{ type: "text" as const, text: `${code}${error instanceof Error ? error.message : String(error)}` },
					],
					details: undefined,
					isError: true,
				};
			}
		},
	});
}

/** 只给侦察 worker 的最小保存面；绑定从环境提供的当前卡目录和 attempt 解析。 */
export function registerDispatchReconTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "pao_save_dispatch_recon",
		label: "保存侦察结论",
		description:
			"把当前侦察尝试的必要事实、未知项、范围、验收、风险、证据和整合责任按显式 category 保存为独立交接产物。保存前核对卡号、attempt、owner 与 in_progress；下游通过 depends_on 和当前 attempt 交接精确引用。",
		parameters: Type.Object({
			id: Type.String(),
			markdown: Type.String(),
			purpose: Type.Optional(Type.String()),
			sections: Type.Array(
				Type.Object({
					category: Type.Union(DISPATCH_RECON_CATEGORIES.map((category) => Type.Literal(category))),
					title: Type.String(),
					markdown: Type.String(),
				}),
			),
		}),
		execute: async (_toolCallId, params) => {
			try {
				const cardsDir = process.env.PAO_CARDS_DIR?.trim();
				const cardRef = process.env.PAO_WORKER_CARD;
				const attempt = Number.parseInt(process.env.PAO_WORKER_ATTEMPT ?? "", 10);
				const owner = process.env.PAO_WORKER_OWNER?.trim();
				if (!cardsDir || !cardRef || !Number.isInteger(attempt) || !owner) {
					throw new Error(
						"worker 的 PAO_CARDS_DIR、PAO_WORKER_CARD、PAO_WORKER_ATTEMPT 或 PAO_WORKER_OWNER 未注入",
					);
				}
				const cardNo = parseWorkerCard(cardRef);
				const result = await commitDispatchReconResult({
					key: { cardsDir: resolve(cardsDir), cardNo, attempt },
					owner,
					id: params.id,
					markdown: params.markdown,
					purpose: params.purpose,
					requirements: {
						kind: "scout",
						sections: params.sections,
					},
				});
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
					details: undefined,
				};
			} catch (error) {
				const code = error instanceof Error && "code" in error ? `[${String(error.code)}] ` : "";
				return {
					content: [
						{
							type: "text" as const,
							text: `${code}${error instanceof Error ? error.message : String(error)}`,
						},
					],
					details: undefined,
					isError: true,
				};
			}
		},
	});
}

/** 派发接线层把这个唯一来源注入 worker；工具不接受模型自报身份。 */
export function dispatchReconWorkerEnvironment(
	cardsDir: string,
	cardNo: number,
	attempt: number,
	owner: string,
): Record<string, string> {
	if (!cardsDir.trim() || !Number.isInteger(cardNo) || !Number.isInteger(attempt) || !owner.trim()) {
		throw new DispatchBriefError("execution_binding_invalid", "侦察保存工具的环境身份不完整", {
			cardsDir,
			cardNo,
			attempt,
			owner,
		});
	}
	return {
		PAO_CARDS_DIR: resolve(cardsDir),
		PAO_WORKER_CARD: `卡${String(cardNo).padStart(4, "0")}`,
		PAO_WORKER_ATTEMPT: String(attempt),
		PAO_WORKER_OWNER: owner,
	};
}

function parseWorkerCard(value: string): number {
	const match = /^(?:卡#?)?0*(\d+)$/.exec(value.trim());
	if (!match) throw new Error(`PAO_WORKER_CARD 不是合法卡号：${value}`);
	return Number.parseInt(match[1], 10);
}
