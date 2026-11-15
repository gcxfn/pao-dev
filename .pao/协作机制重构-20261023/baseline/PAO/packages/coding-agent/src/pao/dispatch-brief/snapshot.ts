import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readCard } from "../cards/cardfile.ts";
import type { ParsedCard } from "../cards/types.ts";
import { writeFileAtomic } from "../shared/atomic.ts";
import { withFileLock } from "../shared/lock.ts";
import {
	assertDispatchReferenceNotSuperseded,
	loadDispatchBriefArtifact,
	loadDispatchContractReference,
	loadDispatchMapArtifact,
	resolveDispatchContractContentPath,
	saveDispatchBriefArtifact,
} from "./artifacts.ts";
import { digestObjectExcluding, isSha256Digest } from "./canonical.ts";
import { assertCardDefinitionDigest, captureCardDefinition } from "./card-definition.ts";
import { DispatchBriefError, errorMessage, issueFromError } from "./errors.ts";
import type {
	DispatchBriefClaim,
	DispatchBriefDraft,
	DispatchBriefInput,
	DispatchExecutionIdentity,
	DispatchInputSnapshot,
	DispatchPreflightIssue,
	DispatchPreflightResult,
} from "./types.ts";
import { readGitIdentity, recaptureDispatchMap, sameDispatchMapCoverage, sameRepositoryPath } from "./workspace.ts";

function makeSnapshot(
	draft: DispatchBriefDraft,
	claim: DispatchBriefClaim,
	execution: DispatchExecutionIdentity,
	brief: DispatchInputSnapshot["brief"],
	frozenAt: string,
): DispatchInputSnapshot {
	const base = {
		schemaVersion: 1 as const,
		kind: "dispatch-input-snapshot" as const,
		cardsDir: draft.card.cardsDir,
		card: {
			...draft.card,
			attempt: claim.attempt,
			...(claim.owner ? { owner: claim.owner } : {}),
		},
		execution: {
			...execution,
			cardsDir: draft.card.cardsDir,
			cardNo: draft.card.cardNo,
			attempt: claim.attempt,
		},
		cardDefinition: draft.cardDefinition,
		briefMarkdown: draft.briefMarkdown,
		brief,
		evidence: draft.evidence,
		...(draft.map ? { map: draft.map } : {}),
		contracts: draft.contracts,
		warnings: draft.warnings,
		frozenAt,
	};
	const snapshotDigest = digestObjectExcluding(base, []);
	return { ...base, snapshotDigest };
}

export function dispatchInputSnapshotPath(cardsDir: string, cardNo: number, attempt: number): string {
	if (!Number.isInteger(cardNo) || cardNo < 1 || !Number.isInteger(attempt) || attempt < 1) {
		throw new DispatchBriefError("bad_reference", "输入快照的卡号和尝试号必须为正整数", {
			cardNo,
			attempt,
		});
	}
	return join(
		resolve(cardsDir),
		"..",
		"输入快照",
		"attempts",
		`card-${String(cardNo).padStart(4, "0")}-attempt-${attempt}.json`,
	);
}

async function writeImmutableSnapshot(path: string, snapshot: DispatchInputSnapshot): Promise<void> {
	mkdirSync(dirname(path), { recursive: true });
	await withFileLock(path, () => {
		if (existsSync(path)) {
			const existing = loadDispatchInputSnapshot(path);
			if (existing.snapshotDigest !== snapshot.snapshotDigest) {
				throw new DispatchBriefError("artifact_conflict", "同一卡与尝试已有不同输入快照，拒绝覆盖", { path });
			}
			return;
		}
		writeFileAtomic(path, `${JSON.stringify(snapshot, null, "\t")}\n`);
	});
}

export function loadDispatchInputSnapshot(path: string): DispatchInputSnapshot {
	if (!existsSync(path)) {
		throw new DispatchBriefError("missing_input", `输入快照不存在：${path}`, { path });
	}
	let snapshot: DispatchInputSnapshot;
	try {
		snapshot = JSON.parse(readFileSync(path, "utf8")) as DispatchInputSnapshot;
	} catch (error) {
		throw new DispatchBriefError("bad_reference", `输入快照不是合法 JSON：${path}`, {
			path,
			cause: errorMessage(error),
		});
	}
	if (snapshot.kind !== "dispatch-input-snapshot" || snapshot.schemaVersion !== 1) {
		throw new DispatchBriefError("bad_reference", "输入快照类型或版本不符", { path });
	}
	const digestIssue = verifyDigest(snapshot);
	if (digestIssue) {
		throw new DispatchBriefError("bad_reference", digestIssue.message, { path });
	}
	return snapshot;
}

export async function freezeDispatchBrief(
	draft: DispatchBriefDraft,
	claim: DispatchBriefClaim,
	execution: DispatchExecutionIdentity,
): Promise<DispatchInputSnapshot> {
	if (!Number.isInteger(claim.attempt) || claim.attempt < 1 || !claim.owner.trim()) {
		throw new DispatchBriefError("card_changed", "冻结快照需要有效 attempt 与非空 owner", {
			claim,
		});
	}
	if (draft.preparationDigest !== digestObjectExcluding(draft, ["preparationDigest"])) {
		throw new DispatchBriefError("bad_reference", "prepare 草案内容已变化，拒绝冻结", {
			digest: draft.preparationDigest,
		});
	}
	if (!execution.executionRoot || !execution.repositoryRoot || !execution.projectRoot) {
		throw new DispatchBriefError("execution_binding_invalid", "冻结快照缺执行身份", {});
	}
	if (
		draft.map &&
		(execution.versionControl !== "git" ||
			draft.execution.versionControl !== "git" ||
			!execution.commonGitDir ||
			!draft.execution.commonGitDir)
	) {
		throw new DispatchBriefError("execution_binding_invalid", "结构化地图只能冻结在可核验 Git 身份的执行根", {
			executionRoot: execution.executionRoot,
		});
	}
	if (
		execution.versionControl === "git" &&
		(!execution.commonGitDir || !sameRepositoryPath(execution.commonGitDir, draft.execution.commonGitDir ?? ""))
	) {
		throw new DispatchBriefError("execution_binding_invalid", "冻结执行身份与 prepare 阶段核验的 Git 仓库不一致", {
			executionRoot: execution.executionRoot,
		});
	}
	if (
		execution.versionControl !== draft.execution.versionControl &&
		(execution.versionControl === "git" || draft.execution.versionControl === "git")
	) {
		throw new DispatchBriefError("execution_binding_invalid", "冻结执行身份与 prepare 阶段的版本控制身份不一致", {
			prepared: draft.execution.versionControl,
			frozen: execution.versionControl,
		});
	}
	const currentCard = readCard(draft.card.cardPath);
	const currentCardDefinition = captureCardDefinition(currentCard);
	assertCardDefinitionDigest(draft.cardDefinition, currentCard.path);
	if (currentCardDefinition.definitionDigest !== draft.cardDefinition.definitionDigest) {
		throw new DispatchBriefError("card_changed", "准备与冻结之间卡任务定义或 inputs 已变化", {
			path: currentCard.path,
			field: "cardDefinition",
			expectedDigest: draft.cardDefinition.definitionDigest,
			actualDigest: currentCardDefinition.definitionDigest,
		});
	}
	if (currentCard.frontmatter.attempt !== claim.attempt) {
		throw new DispatchBriefError("card_changed", "认领尝试与冻结时卡面不一致", {
			expected: claim.attempt,
			actual: currentCard.frontmatter.attempt,
			path: currentCard.path,
		});
	}
	if (draft.card.attempt !== claim.attempt) {
		throw new DispatchBriefError("card_changed", "prepare 草案的尝试身份与认领结果不一致", {
			expected: claim.attempt,
			actual: draft.card.attempt,
			path: draft.card.cardPath,
		});
	}
	if (currentCard.frontmatter.owner !== claim.owner || draft.card.owner !== claim.owner) {
		throw new DispatchBriefError("card_changed", "冻结时卡面 owner、认领 owner 与草案 owner 不一致", {
			expected: claim.owner,
			cardOwner: currentCard.frontmatter.owner,
			draftOwner: draft.card.owner,
			path: currentCard.path,
		});
	}
	if (currentCard.frontmatter.status !== "in_progress") {
		throw new DispatchBriefError("card_changed", "冻结时卡状态不是 in_progress", {
			status: currentCard.frontmatter.status,
			path: currentCard.path,
		});
	}
	if (execution.bindingDigest !== undefined && !isSha256Digest(execution.bindingDigest)) {
		throw new DispatchBriefError("execution_binding_invalid", "执行绑定摘要格式错误", {
			digest: execution.bindingDigest,
		});
	}
	for (const entry of draft.evidence.filter(
		(entry) => entry.kind === "upstream" && entry.ref.startsWith("pao-map://"),
	)) {
		assertDispatchReferenceNotSuperseded(entry.ref, { cardsDir: draft.card.cardsDir });
		const artifact = loadDispatchMapArtifact(entry.ref, { cardsDir: draft.card.cardsDir });
		if (entry.digest && artifact.mapDigest !== entry.digest) {
			throw new DispatchBriefError("stale_map", "上游地图在准备与冻结之间被替换", { ref: entry.ref });
		}
		if (artifact.status !== "valid" || artifact.scopeReviewRequired) {
			throw new DispatchBriefError("stale_map", "上游地图状态不是 valid 或覆盖范围需复核", { ref: entry.ref });
		}
		const current = await recaptureDispatchMap(artifact, {
			cardsDir: draft.card.cardsDir,
			cardPath: draft.card.cardPath,
			projectRoot: draft.execution.projectRoot,
			executionRoot: draft.execution.executionRoot,
			upstreamRefs: draft.evidence
				.filter((entry) => entry.kind === "upstream")
				.map((entry) => ({ ref: entry.ref, purpose: entry.purpose })),
			workspace: {
				worktreeKind: draft.execution.worktreeId ? "managed" : "primary",
				repositoryRoot: draft.execution.repositoryRoot,
				commonGitDir: draft.execution.commonGitDir,
				worktreeId: draft.execution.worktreeId,
				baseHead: draft.execution.baseHead,
				baseTreeId: draft.execution.baseTreeId,
				inputVersion: draft.execution.inputVersion,
			},
		});
		if (!sameDispatchMapCoverage(artifact, current)) {
			throw new DispatchBriefError("stale_map", "上游地图覆盖内容在准备与冻结之间已变化", { ref: entry.ref });
		}
	}
	if (draft.map) {
		assertDispatchReferenceNotSuperseded(draft.map.ref, { cardsDir: draft.card.cardsDir });
		const artifact = loadDispatchMapArtifact(draft.map.ref, { cardsDir: draft.card.cardsDir });
		if (artifact.mapDigest !== draft.map.digest) {
			throw new DispatchBriefError("stale_map", "地图在准备与冻结之间被替换", { ref: draft.map.ref });
		}
		if (artifact.status !== "valid" || artifact.scopeReviewRequired) {
			throw new DispatchBriefError("stale_map", "地图状态不是 valid 或覆盖范围需复核", {
				ref: draft.map.ref,
			});
		}
	}
	for (const contract of draft.contracts) {
		assertDispatchReferenceNotSuperseded(contract.ref, { cardsDir: draft.card.cardsDir });
		const artifact = loadDispatchContractReference(contract.ref, { cardsDir: draft.card.cardsDir });
		if (artifact.artifactDigest !== contract.digest) {
			throw new DispatchBriefError("contract_changed", "契约在准备与冻结之间被替换", {
				ref: contract.ref,
			});
		}
		const contentPath = resolveDispatchContractContentPath({
			artifact,
			projectRoot: draft.execution.projectRoot,
			executionRoot: draft.execution.executionRoot,
		});
		const actual = await currentContractDigest(contentPath);
		if (actual !== artifact.contentDigest) {
			throw new DispatchBriefError(
				"contract_changed",
				`执行根中的契约内容已变化：${artifact.id}@${artifact.version}`,
				{ ref: contract.ref, path: contentPath, expected: artifact.contentDigest, actual },
			);
		}
	}
	const id = `brief-card-${String(draft.card.cardNo).padStart(4, "0")}-attempt-${claim.attempt}`;
	const brief = await saveDispatchBriefArtifact({
		id,
		cardsDir: draft.card.cardsDir,
		cardPath: draft.card.cardPath,
		cardNo: draft.card.cardNo,
		attempt: claim.attempt,
		...(claim.owner ? { owner: claim.owner } : {}),
		purpose: "worker 直接注入的冻结执行简报",
		markdown: draft.briefMarkdown,
	});
	const snapshot = makeSnapshot(draft, claim, execution, brief, new Date().toISOString());
	const snapshotPath = dispatchInputSnapshotPath(draft.card.cardsDir, draft.card.cardNo, claim.attempt);
	try {
		await writeImmutableSnapshot(snapshotPath, snapshot);
	} catch (error) {
		throw new DispatchBriefError(
			"bad_reference",
			`简报产物已保存为 ${brief.ref}，但 attempt ${claim.attempt} 的输入快照冻结失败：${errorMessage(error)}`,
			{ ref: brief.ref, path: snapshotPath, cause: errorMessage(error) },
		);
	}
	return snapshot;
}

function verifyDigest(snapshot: DispatchInputSnapshot): DispatchPreflightIssue | undefined {
	if (!isSha256Digest(snapshot.snapshotDigest)) {
		return { code: "snapshot_digest_mismatch", message: "快照摘要格式错误" };
	}
	const actual = digestObjectExcluding(snapshot, ["snapshotDigest"]);
	if (actual !== snapshot.snapshotDigest) {
		return {
			code: "snapshot_digest_mismatch",
			message: `快照内容与摘要不符：期望 ${snapshot.snapshotDigest}，实际 ${actual}`,
		};
	}
	return undefined;
}

function verifyExecution(
	snapshot: DispatchInputSnapshot,
	current: DispatchBriefInput,
): DispatchPreflightIssue | undefined {
	let currentExecutionRoot: string;
	let currentProjectRoot: string;
	try {
		currentExecutionRoot = realpathSync(current.executionRoot);
		currentProjectRoot = realpathSync(current.projectRoot);
	} catch (error) {
		return {
			code: "execution_binding_invalid",
			message: `执行或项目根不可访问：${errorMessage(error)}`,
			path: current.executionRoot,
		};
	}
	let frozenExecutionRoot: string;
	let frozenProjectRoot: string;
	try {
		frozenExecutionRoot = realpathSync(snapshot.execution.executionRoot);
		frozenProjectRoot = realpathSync(snapshot.execution.projectRoot);
	} catch (error) {
		return {
			code: "execution_binding_invalid",
			message: `冻结快照的执行或项目根已不可访问：${errorMessage(error)}`,
			path: snapshot.execution.executionRoot,
		};
	}
	if (frozenExecutionRoot !== currentExecutionRoot) {
		return {
			code: "execution_binding_invalid",
			message: "执行根已变化，冻结快照不能用于当前目录",
			path: current.executionRoot,
		};
	}
	if (frozenProjectRoot !== currentProjectRoot) {
		return {
			code: "execution_binding_invalid",
			message: "共享项目根已变化，冻结快照不能用于当前任务",
			path: current.projectRoot,
		};
	}
	const expected = snapshot.execution.bindingDigest;
	const actual = current.workspace?.bindingDigest;
	if (expected && actual !== expected) {
		return {
			code: "execution_binding_invalid",
			message: actual ? "执行绑定摘要与冻结快照不符" : "缺少当前执行绑定摘要",
		};
	}
	if (current.claim && current.claim.attempt !== snapshot.card.attempt) {
		return {
			code: "card_changed",
			message: `当前认领尝试 ${current.claim.attempt} 与冻结尝试 ${snapshot.card.attempt} 不一致`,
		};
	}
	if (!current.claim?.owner || current.claim.owner !== snapshot.card.owner) {
		return {
			code: "card_changed",
			message: "当前认领缺少 owner 或与冻结快照 owner 不一致",
		};
	}
	if (
		snapshot.execution.worktreeId &&
		current.workspace?.worktreeId &&
		snapshot.execution.worktreeId !== current.workspace.worktreeId
	) {
		return {
			code: "execution_binding_invalid",
			message: "工作树身份与冻结快照不一致",
		};
	}
	let identity: ReturnType<typeof readGitIdentity>;
	try {
		identity = readGitIdentity(current.executionRoot);
	} catch (error) {
		const nonGit =
			snapshot.execution.commonGitDir === undefined &&
			snapshot.map === undefined &&
			current.workspace?.worktreeKind !== "managed";
		if (nonGit) return undefined;
		return {
			code: "execution_binding_invalid",
			message: `当前执行根的 Git 共同目录不可核验：${errorMessage(error)}`,
			path: current.executionRoot,
		};
	}
	try {
		if (!sameRepositoryPath(snapshot.execution.repositoryRoot, identity.repositoryRoot)) {
			return {
				code: "execution_binding_invalid",
				message: "当前执行根的 Git 顶层与冻结仓库身份不一致",
				path: current.executionRoot,
			};
		}
		if (
			snapshot.execution.commonGitDir &&
			!sameRepositoryPath(snapshot.execution.commonGitDir, identity.commonGitDir)
		) {
			return {
				code: "execution_binding_invalid",
				message: "当前执行根与冻结快照不属于同一 Git 仓库",
				path: current.executionRoot,
			};
		}
		if (
			current.workspace?.commonGitDir &&
			!sameRepositoryPath(current.workspace.commonGitDir, identity.commonGitDir)
		) {
			return {
				code: "execution_binding_invalid",
				message: "宿主执行绑定与当前执行根不属于同一 Git 仓库",
				path: current.executionRoot,
			};
		}
	} catch {
		return {
			code: "execution_binding_invalid",
			message: "当前执行根的 Git 共同目录不可核验",
			path: current.executionRoot,
		};
	}
	return undefined;
}

export async function verifyDispatchSnapshot(
	snapshot: DispatchInputSnapshot,
	current: DispatchBriefInput,
): Promise<DispatchPreflightResult> {
	const issues: DispatchPreflightIssue[] = [];
	let currentCard: ParsedCard;
	try {
		currentCard = readCard(current.cardPath);
		if (!snapshot.cardDefinition) {
			issues.push({
				code: "card_changed",
				message: "冻结快照缺少卡定义摘要，不能确认当前任务定义未被改写",
				path: current.cardPath,
				field: "cardDefinition",
			});
		} else {
			assertCardDefinitionDigest(snapshot.cardDefinition, current.cardPath);
			const currentCardDefinition = captureCardDefinition(currentCard);
			if (currentCardDefinition.definitionDigest !== snapshot.cardDefinition.definitionDigest) {
				issues.push({
					code: "card_changed",
					message: "卡任务定义或 inputs 已偏离冻结快照",
					path: current.cardPath,
					field: "cardDefinition",
					expectedDigest: snapshot.cardDefinition.definitionDigest,
					actualDigest: currentCardDefinition.definitionDigest,
				});
			}
		}
		if (currentCard.card_no !== snapshot.card.cardNo) {
			issues.push({
				code: "card_changed",
				message: "当前卡号与冻结快照不一致",
				path: current.cardPath,
			});
		}
		if (currentCard.frontmatter.attempt !== snapshot.card.attempt) {
			issues.push({
				code: "card_changed",
				message: `卡面当前尝试 ${currentCard.frontmatter.attempt} 与冻结尝试 ${snapshot.card.attempt} 不一致`,
				path: current.cardPath,
			});
		}
		if (current.claim && current.claim.attempt !== snapshot.card.attempt) {
			issues.push({
				code: "card_changed",
				message: "当前认领尝试与冻结快照不一致",
				path: current.cardPath,
			});
		}
		if (
			currentCard.frontmatter.owner !== undefined &&
			current.claim?.owner !== undefined &&
			currentCard.frontmatter.owner !== current.claim.owner
		) {
			issues.push({
				code: "card_changed",
				message: "卡面 owner 与当前认领身份不一致",
				path: current.cardPath,
			});
		}
		if (
			!current.claim?.owner ||
			currentCard.frontmatter.owner !== current.claim.owner ||
			currentCard.frontmatter.owner !== snapshot.card.owner
		) {
			issues.push({
				code: "card_changed",
				message: "当前卡面 owner、认领 owner 与冻结 owner 不一致或缺失",
				path: current.cardPath,
			});
		}
	} catch (error) {
		issues.push(issueFromError(error));
	}
	const digestIssue = verifyDigest(snapshot);
	if (digestIssue) issues.push(digestIssue);
	const executionIssue = verifyExecution(snapshot, current);
	if (executionIssue) issues.push(executionIssue);
	// 卡身份问题不跳过内容门：一次返回快照内所有已过期来源，便于真实入口完整停发。
	if (issues.some((issue) => issue.code === "snapshot_digest_mismatch")) {
		return {
			ok: false,
			code: issues[0].code,
			message: issues.map((issue) => issue.message).join("；"),
			issues,
		};
	}

	try {
		const loadedBrief = loadDispatchBriefArtifact(snapshot.brief.ref, {
			cardsDir: snapshot.card.cardsDir,
		});
		if (loadedBrief.artifactDigest !== snapshot.brief.digest) {
			issues.push({
				code: "bad_reference",
				message: "冻结简报产物摘要已变化",
				ref: snapshot.brief.ref,
			});
		}
	} catch (error) {
		issues.push(issueFromError(error));
	}

	for (const entry of snapshot.evidence.filter(
		(entry) => entry.kind === "upstream" && entry.ref.startsWith("pao-map://"),
	)) {
		try {
			assertDispatchReferenceNotSuperseded(entry.ref, { cardsDir: snapshot.card.cardsDir });
			const saved = loadDispatchMapArtifact(entry.ref, { cardsDir: snapshot.card.cardsDir });
			if (entry.digest && saved.mapDigest !== entry.digest) {
				issues.push({ code: "stale_map", message: "上游地图摘要已变化", ref: entry.ref });
				continue;
			}
			const recaptured = await recaptureDispatchMap(saved, current);
			if (
				saved.status !== "valid" ||
				saved.scopeReviewRequired ||
				!saved.scopeConfirmed ||
				!sameDispatchMapCoverage(saved, recaptured)
			) {
				issues.push({
					code: "stale_map",
					message: "上游地图覆盖内容或有效期已变化，需要复核",
					ref: entry.ref,
				});
			}
		} catch (error) {
			issues.push(issueFromError(error));
		}
	}

	if (snapshot.map) {
		try {
			assertDispatchReferenceNotSuperseded(snapshot.map.ref, { cardsDir: snapshot.card.cardsDir });
			const saved = loadDispatchMapArtifact(snapshot.map.ref, { cardsDir: snapshot.card.cardsDir });
			const currentMapInputs = snapshot.evidence
				.filter((entry) => entry.kind === "input" && entry.ref.startsWith("pao-map://"))
				.map((entry) => entry.ref);
			if (currentMapInputs.length !== 1 || currentMapInputs[0] !== snapshot.map.ref) {
				throw new DispatchBriefError("bad_reference", "快照必须只有一张卡片自身启动地图", {
					ref: snapshot.map.ref,
				});
			}
			const currentMap = await recaptureDispatchMap(saved, current);
			if (
				saved.status !== "valid" ||
				saved.scopeReviewRequired ||
				!saved.scopeConfirmed ||
				!sameDispatchMapCoverage(saved, currentMap)
			) {
				issues.push({
					code: "stale_map",
					message: "地图覆盖内容或有效期已变化，需要复核",
					ref: snapshot.map.ref,
				});
			}
		} catch (error) {
			issues.push(issueFromError(error));
		}
	}

	for (const contract of snapshot.contracts) {
		try {
			assertDispatchReferenceNotSuperseded(contract.ref, { cardsDir: snapshot.card.cardsDir });
			const artifact = loadDispatchContractReference(contract.ref, {
				cardsDir: snapshot.card.cardsDir,
			});
			const contentPath = resolveDispatchContractContentPath({
				artifact,
				projectRoot: current.projectRoot,
				executionRoot: current.executionRoot,
			});
			const actual = await currentContractDigest(contentPath);
			if (actual !== artifact.contentDigest) {
				issues.push({
					code: "contract_changed",
					message: `契约内容已变化：${artifact.id}@${artifact.version}`,
					ref: contract.ref,
					path: contentPath,
				});
			}
		} catch (error) {
			issues.push(issueFromError(error));
		}
	}
	if (issues.length === 0) {
		return { ok: true, code: "ok", message: "快照、简报、地图、契约和执行身份仍然有效", issues: [] };
	}
	return {
		ok: false,
		code: issues[0].code,
		message: issues.map((issue) => issue.message).join("；"),
		issues,
	};
}

async function currentContractDigest(path: string): Promise<string> {
	const { readFile } = await import("node:fs/promises");
	const { sha256Bytes } = await import("./canonical.ts");
	try {
		return sha256Bytes(await readFile(path));
	} catch {
		throw new DispatchBriefError("missing_input", `契约正本不可读：${path}`, { path });
	}
}
