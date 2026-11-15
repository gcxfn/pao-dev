import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { readCard } from "../cards/cardfile.ts";
import type { ParsedCard } from "../cards/types.ts";
import {
	assertDispatchReferenceNotSuperseded,
	loadDispatchBriefArtifact,
	loadDispatchContractReference,
	loadDispatchMapArtifact,
	resolveDispatchContractContentPath,
} from "./artifacts.ts";
import { sha256Bytes } from "./canonical.ts";
import { DispatchBriefError, errorMessage, issueFromError } from "./errors.ts";
import type { DispatchBriefPrecheckInput, DispatchPreflightIssue, DispatchPreflightResult } from "./types.ts";
import { captureDispatchMap, sameDispatchMapCoverage, sameRepositoryPath, tryReadGitIdentity } from "./workspace.ts";

async function contractDigest(path: string): Promise<string> {
	try {
		return sha256Bytes(await readFile(path));
	} catch (error) {
		throw new DispatchBriefError("missing_input", `契约正本不可读：${path}`, {
			path,
			cause: errorMessage(error),
		});
	}
}

/**
 * 只读预检：从卡现有 inputs 读取保存的简报/地图/契约 URI。
 * 地图会按已声明 coverage 重采真实 Git 内容，范围外变化不影响结果。
 * 认领前应调用此函数；认领后仍必须调用 verifyDispatchSnapshot。
 */
export async function precheckDispatchReferences(input: DispatchBriefPrecheckInput): Promise<DispatchPreflightResult> {
	const issues: DispatchPreflightIssue[] = [];
	let card: ParsedCard | undefined;
	try {
		card = readCard(input.cardPath);
	} catch (error) {
		issues.push(issueFromError(error));
	}
	if (card && input.cardNo !== undefined && card.card_no !== input.cardNo) {
		issues.push({
			code: "card_changed",
			message: `目标卡号已经变化：期望 ${input.cardNo}，实际 ${card.card_no}`,
			path: card.path,
		});
	}
	if (card && input.attempt !== undefined && card.frontmatter.attempt !== input.attempt) {
		issues.push({
			code: "card_changed",
			message: `卡面当前尝试 ${card.frontmatter.attempt} 与预检身份 ${input.attempt} 不一致`,
			path: card.path,
		});
	}
	if (card) {
		const refs = [...new Set([...(card.frontmatter.inputs ?? []), ...input.refs])];
		for (const ref of refs) {
			try {
				if (ref.startsWith("pao-brief://")) {
					loadDispatchBriefArtifact(ref, { cardsDir: input.cardsDir });
				} else if (ref.startsWith("pao-map://")) {
					assertDispatchReferenceNotSuperseded(ref, { cardsDir: input.cardsDir });
					const saved = loadDispatchMapArtifact(ref, { cardsDir: input.cardsDir });
					if (saved.status !== "valid" || saved.scopeReviewRequired) {
						issues.push({
							code: "stale_map",
							message: "地图状态不是 valid 或覆盖边界仍需复核",
							ref,
						});
						continue;
					}
					const current = captureDispatchMap({
						id: saved.id,
						projectRoot: input.projectRoot,
						executionRoot: input.executionRoot,
						coverage: saved.coverage.paths,
						excludes: saved.coverage.excludes,
						facts: saved.facts,
						unknowns: saved.unknowns,
						relations: saved.relations,
						risks: saved.risks,
						integrationOwner: saved.integrationOwner,
						scopeConfirmed: saved.scopeConfirmed,
						scopeBasis: saved.scopeBasis,
						capturedAt: saved.capturedAt,
					});
					if (!sameDispatchMapCoverage(saved, current)) {
						issues.push({
							code: "stale_map",
							message: "覆盖范围内的提交、暂存、未暂存或未跟踪内容已变化",
							ref,
						});
					}
				} else if (ref.startsWith("pao-contract://")) {
					assertDispatchReferenceNotSuperseded(ref, { cardsDir: input.cardsDir });
					const contract = loadDispatchContractReference(ref, { cardsDir: input.cardsDir });
					const contentPath = resolveDispatchContractContentPath({
						artifact: contract,
						projectRoot: input.projectRoot,
						executionRoot: input.executionRoot,
					});
					const actual = await contractDigest(contentPath);
					if (actual !== contract.contentDigest) {
						issues.push({
							code: "contract_changed",
							message: `契约内容已变化：${contract.id}@${contract.version}`,
							ref,
							path: contentPath,
						});
					}
				}
			} catch (error) {
				const issue = issueFromError(error);
				issues.push(
					// prepare 前只做引用身份检查；真实内容在认领前的冻结复核中重读。
					issue,
				);
			}
		}
	}
	if (card) {
		try {
			const identity = tryReadGitIdentity(realpathSync(input.executionRoot));
			const workspace = input.workspace;
			if (!identity.ok && workspace?.worktreeKind === "managed") {
				throw new DispatchBriefError(
					"execution_binding_invalid",
					`managed worktree 必须有可核验的 Git 身份：${identity.reason}`,
					{ path: input.executionRoot },
				);
			}
			if (
				identity.ok &&
				workspace?.commonGitDir?.trim() &&
				!sameRepositoryPath(workspace.commonGitDir, identity.commonGitDir)
			) {
				issues.push({
					code: "execution_binding_invalid",
					message: "宿主执行绑定与执行根所在共同 Git 仓库不一致",
					path: input.executionRoot,
				});
			}
			if (
				identity.ok &&
				workspace?.repositoryRoot?.trim() &&
				!sameRepositoryPath(workspace.repositoryRoot, identity.repositoryRoot)
			) {
				issues.push({
					code: "execution_binding_invalid",
					message: "宿主执行绑定的仓库根与执行根真实 Git 顶层不一致",
					path: input.executionRoot,
				});
			}
			if (!identity.ok && workspace?.commonGitDir?.trim()) {
				issues.push({
					code: "execution_binding_invalid",
					message: "宿主声明了 Git 共同目录，但执行根无法核验 Git 身份",
					path: input.executionRoot,
				});
			}
		} catch (error) {
			issues.push({
				code: "execution_binding_invalid",
				message: `执行身份不可核验：${errorMessage(error)}`,
				path: input.executionRoot,
			});
		}
	}
	if (issues.length === 0) {
		return { ok: true, code: "ok", message: "卡、引用、地图、契约和执行身份均可进入认领", issues: [] };
	}
	return {
		ok: false,
		code: issues[0].code,
		message: issues.map((issue) => issue.message).join("；"),
		issues,
	};
}
