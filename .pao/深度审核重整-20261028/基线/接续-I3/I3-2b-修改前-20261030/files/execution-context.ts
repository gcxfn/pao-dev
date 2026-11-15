import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { writeFileAtomic } from "../shared/atomic.ts";
import { withFileLock } from "../shared/lock.ts";
import { pathKey } from "../shared/path-key.ts";
import type { WorktreeBinding } from "../worktrees/types.ts";
import { loadCard } from "./cardfile.ts";
import { runCardProcess } from "./process.ts";

/**
 * 一次真实执行的宿主证明。
 *
 * 这张记录把共享卡状态与 worker 实际执行的 worktree 分开：cardsDir 继续承担任务身份，
 * executionRoot 才是基线、验收、交卷和整合读取代码的根。记录一经写入不可改写；
 * 新尝试使用新的 attempt，历史尝试仍可按 key 回读，便于追溯旧输入和旧证据。
 */

export interface ExecutionKey {
	cardsDir: string;
	cardNo: number;
	attempt: number;
}

export interface ExecutionBinding {
	schemaVersion: 1;
	key: ExecutionKey;
	projectRoot: string;
	repositoryRoot: string;
	executionRoot: string;
	worktree: WorktreeBinding;
	/** 冻结输入快照的持久路径或受控 URI；完整输入内容只在该快照中。 */
	snapshotRef: string;
	/** 冻结输入快照的规范 sha256 摘要。 */
	snapshotDigest: string;
	/** 只指向 snapshot 内已经冻结的简报 URI，不在这里复制第二份简报正文。 */
	briefRef?: string;
	bindingDigest: string;
	boundAt: string;
}

export interface ResolvedExecutionContext extends ExecutionBinding {
	/** 实时解析后的规范执行根；历史回读且未要求实时校验时只做路径规范化。 */
	canonicalExecutionRoot: string;
}

export type ExecutionContextErrorCode =
	| "INVALID_EXECUTION_CONTEXT"
	| "EXECUTION_CONTEXT_NOT_FOUND"
	| "BINDING_CONFLICT"
	| "ATTEMPT_NOT_CURRENT"
	| "EXECUTION_ROOT_UNAVAILABLE";

export class ExecutionContextError extends Error {
	readonly code: ExecutionContextErrorCode;
	readonly details: Record<string, unknown>;

	constructor(code: ExecutionContextErrorCode, message: string, details: Record<string, unknown> = {}) {
		super(message);
		this.name = "ExecutionContextError";
		this.code = code;
		this.details = details;
	}
}

type BindExecutionInput = Omit<ExecutionBinding, "schemaVersion" | "bindingDigest" | "boundAt">;

export interface ResolveExecutionOptions {
	/**
	 * 只给执行或验收动作使用。省略时允许按显式历史 attempt 回读；
	 * 传入时必须等于卡面当前 attempt。
	 */
	expectedCurrentAttempt?: number;
	/**
	 * 动作前实时核对真实路径、Git 顶层、共同 Git 目录、分支和 HEAD。
	 * 历史回读保持关闭，避免已清理 worktree 的旧记录不可追溯。
	 */
	requireLiveExecutionRoot?: boolean;
}

/** stable JSON：对象键递归排序，数组顺序保留，供摘要与幂等比较共用。 */
function stableJson(value: unknown): string {
	const sort = (item: unknown): unknown => {
		if (Array.isArray(item)) return item.map(sort);
		if (item !== null && typeof item === "object") {
			return Object.fromEntries(
				Object.entries(item as Record<string, unknown>)
					.sort(([left], [right]) => left.localeCompare(right))
					.map(([key, child]) => [key, sort(child)]),
			);
		}
		return item;
	};
	return JSON.stringify(sort(value));
}

function digest(value: string): string {
	return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function stableBindingFields(binding: BindExecutionInput | ExecutionBinding): BindExecutionInput {
	return {
		key: binding.key,
		projectRoot: binding.projectRoot,
		repositoryRoot: binding.repositoryRoot,
		executionRoot: binding.executionRoot,
		worktree: binding.worktree,
		snapshotRef: binding.snapshotRef,
		snapshotDigest: binding.snapshotDigest,
		...(binding.briefRef !== undefined ? { briefRef: binding.briefRef } : {}),
	};
}

function stableBindingDigest(binding: BindExecutionInput | ExecutionBinding): string {
	return digest(stableJson(stableBindingFields(binding)));
}

function normalizedPath(value: string, field: string): string {
	if (!value.trim() || !isAbsolute(value)) {
		throw new ExecutionContextError("INVALID_EXECUTION_CONTEXT", `${field} 必须是绝对路径`, { field, value });
	}
	return normalize(resolve(value));
}

function samePath(left: string, right: string): boolean {
	return (
		pathKey(left.replace(/\\/g, "/")).replace(/\/+$/, "") === pathKey(right.replace(/\\/g, "/")).replace(/\/+$/, "")
	);
}

function normalizedString(value: string, field: string): string {
	if (!value.trim()) {
		throw new ExecutionContextError("INVALID_EXECUTION_CONTEXT", `${field} 不能为空`, { field, value });
	}
	return value.trim();
}

function normalizeBinding(input: BindExecutionInput): BindExecutionInput {
	if (!Number.isInteger(input.key.cardNo) || input.key.cardNo <= 0) {
		throw new ExecutionContextError("INVALID_EXECUTION_CONTEXT", "cardNo 必须是正整数", {
			cardNo: input.key.cardNo,
		});
	}
	if (!Number.isInteger(input.key.attempt) || input.key.attempt <= 0) {
		throw new ExecutionContextError("INVALID_EXECUTION_CONTEXT", "attempt 必须是正整数", {
			attempt: input.key.attempt,
		});
	}
	const snapshotRef = normalizedString(input.snapshotRef, "snapshotRef");
	const snapshotDigest = digestString(input.snapshotDigest, "snapshotDigest");
	const briefRef = input.briefRef === undefined ? undefined : briefUriString(input.briefRef, "briefRef");
	const cardsDir = normalizedPath(input.key.cardsDir, "key.cardsDir");
	const projectRoot = normalizedPath(input.projectRoot, "projectRoot");
	const repositoryRoot = normalizedPath(input.repositoryRoot, "repositoryRoot");
	const executionRoot = normalizedPath(input.executionRoot, "executionRoot");
	const taskRoot = normalizedPath(input.worktree.taskRoot, "worktree.taskRoot");
	const worktreePath = normalizedPath(input.worktree.executionRoot, "worktree.executionRoot");
	const commonGitDir = normalizeCommonGitDir(input.worktree.commonGitDir);
	const inputVersion = normalizedString(input.worktree.inputVersion, "worktree.inputVersion");
	const hostBindingDigest = normalizedString(input.worktree.bindingDigest, "worktree.bindingDigest");
	if (!samePath(projectRoot, taskRoot)) {
		throw new ExecutionContextError(
			"INVALID_EXECUTION_CONTEXT",
			"projectRoot 必须与宿主 WorktreeBinding.taskRoot 指向同一任务根",
			{ projectRoot, taskRoot },
		);
	}
	if (!samePath(executionRoot, worktreePath)) {
		throw new ExecutionContextError(
			"INVALID_EXECUTION_CONTEXT",
			"executionRoot 必须等于宿主 WorktreeBinding.executionRoot",
			{
				executionRoot,
				worktreePath,
			},
		);
	}
	if (!samePath(repositoryRoot, worktreePath)) {
		throw new ExecutionContextError(
			"INVALID_EXECUTION_CONTEXT",
			"当前执行根本身必须是 repositoryRoot；子目录 cwd 不是受管理 worktree 根",
			{ repositoryRoot, executionRoot },
		);
	}
	const worktree: WorktreeBinding =
		input.worktree.kind === "primary"
			? {
					kind: "primary",
					taskRoot,
					executionRoot: worktreePath,
					commonGitDir,
					inputVersion,
					bindingDigest: hostBindingDigest,
				}
			: {
					kind: "managed",
					worktreeId: normalizedString(input.worktree.worktreeId, "worktree.worktreeId"),
					taskRoot,
					executionRoot: worktreePath,
					commonGitDir,
					branchName: normalizedString(input.worktree.branchName, "worktree.branchName"),
					inputVersion,
					bindingDigest: hostBindingDigest,
					baseline: {
						sourceRoot: normalizedPath(input.worktree.baseline.sourceRoot, "worktree.baseline.sourceRoot"),
						sourceHead: normalizedString(input.worktree.baseline.sourceHead, "worktree.baseline.sourceHead"),
						treeId: normalizedString(input.worktree.baseline.treeId, "worktree.baseline.treeId"),
						snapshotRepositoryPath: normalizedPath(
							input.worktree.baseline.snapshotRepositoryPath,
							"worktree.baseline.snapshotRepositoryPath",
						),
						inputVersion: normalizedString(
							input.worktree.baseline.inputVersion,
							"worktree.baseline.inputVersion",
						),
						capturedAt: normalizedString(input.worktree.baseline.capturedAt, "worktree.baseline.capturedAt"),
						fileCount: input.worktree.baseline.fileCount,
						byteCount: input.worktree.baseline.byteCount,
						coverage: "complete",
						includedPaths: [...input.worktree.baseline.includedPaths],
						excludedPaths: [...input.worktree.baseline.excludedPaths],
						notes: [...input.worktree.baseline.notes],
					},
				};
	return {
		key: { cardsDir, cardNo: input.key.cardNo, attempt: input.key.attempt },
		projectRoot,
		repositoryRoot,
		executionRoot,
		worktree,
		snapshotRef,
		snapshotDigest,
		...(briefRef !== undefined ? { briefRef } : {}),
	};
}

function digestString(value: string, field: string): string {
	const normalized = normalizedString(value, field);
	if (!/^sha256:[0-9a-f]{64}$/.test(normalized)) {
		throw new ExecutionContextError("INVALID_EXECUTION_CONTEXT", `${field} 必须是 sha256 摘要`, {
			field,
			value,
		});
	}
	return normalized;
}

function briefUriString(value: string, field: string): string {
	const normalized = normalizedString(value, field);
	let url: URL;
	try {
		url = new URL(normalized);
	} catch {
		throw new ExecutionContextError("INVALID_EXECUTION_CONTEXT", `${field} 必须是合法 pao-brief URI`, {
			field,
			value,
		});
	}
	const uriDigest = url.searchParams.get("digest");
	if (
		url.protocol !== "pao-brief:" ||
		!url.hostname ||
		url.username ||
		url.password ||
		url.port ||
		(url.pathname && url.pathname !== "/") ||
		uriDigest === null ||
		!/^sha256:[0-9a-f]{64}$/.test(uriDigest)
	) {
		throw new ExecutionContextError("INVALID_EXECUTION_CONTEXT", `${field} 不是合法 pao-brief URI`, {
			field,
			value,
		});
	}
	return normalized;
}

function normalizeCommonGitDir(value: string): string {
	return value.trim() ? normalize(resolve(value)) : "";
}

function validatePersistedBinding(value: unknown): ExecutionBinding {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new ExecutionContextError("INVALID_EXECUTION_CONTEXT", "execution-context 文件不是对象", {});
	}
	const raw = value as Record<string, unknown>;
	if (raw.schemaVersion !== 1) {
		throw new ExecutionContextError("INVALID_EXECUTION_CONTEXT", "不支持的 execution-context schemaVersion", {
			schemaVersion: raw.schemaVersion,
		});
	}
	const rawKey = raw.key as Record<string, unknown> | undefined;
	const rawWorktree = raw.worktree as Record<string, unknown> | undefined;
	if (!rawKey || !rawWorktree) {
		throw new ExecutionContextError("INVALID_EXECUTION_CONTEXT", "execution-context 缺 key 或 worktree", {});
	}
	const input = normalizeBinding({
		key: rawKey as unknown as ExecutionKey,
		projectRoot: raw.projectRoot as string,
		repositoryRoot: raw.repositoryRoot as string,
		executionRoot: raw.executionRoot as string,
		worktree: rawWorktree as unknown as WorktreeBinding,
		snapshotRef: raw.snapshotRef as string,
		snapshotDigest: raw.snapshotDigest as string,
		...(typeof raw.briefRef === "string" ? { briefRef: raw.briefRef } : {}),
	});
	const bindingDigest = raw.bindingDigest;
	if (typeof bindingDigest !== "string" || bindingDigest !== stableBindingDigest(input)) {
		throw new ExecutionContextError("INVALID_EXECUTION_CONTEXT", "execution-context bindingDigest 校验失败", {
			path: raw.path,
		});
	}
	if (typeof raw.boundAt !== "string" || !raw.boundAt.trim()) {
		throw new ExecutionContextError("INVALID_EXECUTION_CONTEXT", "execution-context boundAt 缺失", {});
	}
	return {
		schemaVersion: 1,
		...input,
		bindingDigest,
		boundAt: raw.boundAt,
	};
}

function sameBinding(left: ExecutionBinding, right: BindExecutionInput): boolean {
	return stableBindingDigest(left) === stableBindingDigest(right);
}

function validateKey(key: ExecutionKey): ExecutionKey {
	const cardsDir = normalizedPath(key.cardsDir, "key.cardsDir");
	if (!Number.isInteger(key.cardNo) || key.cardNo <= 0 || !Number.isInteger(key.attempt) || key.attempt <= 0) {
		throw new ExecutionContextError("INVALID_EXECUTION_CONTEXT", "ExecutionKey 的 cardNo 与 attempt 必须是正整数", {
			key,
		});
	}
	return { cardsDir, cardNo: key.cardNo, attempt: key.attempt };
}

/** cardsDir/../execution-contexts/card-NNNN-attempt-N.json。 */
export function executionContextPath(key: ExecutionKey): string {
	const normalized = validateKey(key);
	return join(
		dirname(normalized.cardsDir),
		"execution-contexts",
		`card-${String(normalized.cardNo).padStart(4, "0")}-attempt-${normalized.attempt}.json`,
	);
}

/**
 * 一次性绑定。同 key 同稳定内容幂等返回原记录；任何稳定字段不同都抛 BINDING_CONFLICT。
 * boundAt 只在首次写入时产生，不参与稳定摘要。
 */
export async function bindExecutionContext(
	input: BindExecutionInput,
	options: { expectedCurrentAttempt: number },
): Promise<ExecutionBinding> {
	const normalized = normalizeBinding(input);
	if (options.expectedCurrentAttempt !== normalized.key.attempt) {
		throw new ExecutionContextError("ATTEMPT_NOT_CURRENT", "绑定 attempt 与调用方当前 attempt 不一致", {
			expectedCurrentAttempt: options.expectedCurrentAttempt,
			attempt: normalized.key.attempt,
		});
	}
	const card = loadCard(normalized.key.cardsDir, normalized.key.cardNo);
	if (card.frontmatter.attempt !== normalized.key.attempt) {
		throw new ExecutionContextError(
			"ATTEMPT_NOT_CURRENT",
			`绑定 attempt ${normalized.key.attempt} 不是卡面当前 attempt ${card.frontmatter.attempt}`,
			{ attempt: normalized.key.attempt, currentAttempt: card.frontmatter.attempt },
		);
	}
	const filePath = executionContextPath(normalized.key);
	mkdirSync(dirname(filePath), { recursive: true });
	return withFileLock(filePath, () => {
		if (existsSync(filePath)) {
			let existing: ExecutionBinding;
			try {
				existing = validatePersistedBinding(JSON.parse(readFileSync(filePath, "utf8")));
			} catch (error) {
				if (error instanceof ExecutionContextError) throw error;
				throw new ExecutionContextError("INVALID_EXECUTION_CONTEXT", "execution-context 不是合法 JSON", {
					path: filePath,
					cause: error instanceof Error ? error.message : String(error),
				});
			}
			if (!sameBinding(existing, normalized)) {
				throw new ExecutionContextError("BINDING_CONFLICT", "同一 attempt 已绑定不同的执行上下文", {
					path: filePath,
					existingDigest: existing.bindingDigest,
					incomingDigest: stableBindingDigest(normalized),
				});
			}
			return existing;
		}
		const binding: ExecutionBinding = {
			schemaVersion: 1,
			...normalized,
			bindingDigest: stableBindingDigest(normalized),
			boundAt: new Date().toISOString(),
		};
		writeFileAtomic(filePath, `${JSON.stringify(binding, null, 2)}\n`);
		return binding;
	});
}

async function gitOutput(args: string[], cwd: string): Promise<string> {
	const result = await runCardProcess("git", args, cwd, 15000);
	if (result.code !== 0) {
		throw new ExecutionContextError(
			"EXECUTION_ROOT_UNAVAILABLE",
			`Git 证明核对失败：${result.stderr.slice(0, 240)}`,
			{
				cwd,
				args,
				exitCode: result.code,
			},
		);
	}
	return result.stdout.trim();
}

async function verifyLiveBinding(binding: ExecutionBinding): Promise<string> {
	if (!existsSync(binding.executionRoot)) {
		throw new ExecutionContextError("EXECUTION_ROOT_UNAVAILABLE", "实际执行根不存在", {
			executionRoot: binding.executionRoot,
		});
	}
	if (!existsSync(binding.projectRoot) || !existsSync(binding.worktree.commonGitDir)) {
		throw new ExecutionContextError("EXECUTION_ROOT_UNAVAILABLE", "任务根或共同 Git 目录不存在", {
			projectRoot: binding.projectRoot,
			commonGitDir: binding.worktree.commonGitDir,
		});
	}
	const [topLevel, commonGitDir, branch] = await Promise.all([
		gitOutput(["rev-parse", "--show-toplevel"], binding.executionRoot),
		gitOutput(["rev-parse", "--path-format=absolute", "--git-common-dir"], binding.executionRoot),
		gitOutput(["branch", "--show-current"], binding.executionRoot),
	]);
	if (!samePath(topLevel, binding.repositoryRoot)) {
		throw new ExecutionContextError("EXECUTION_ROOT_UNAVAILABLE", "Git 顶层与绑定的 repositoryRoot 不一致", {
			expected: binding.repositoryRoot,
			actual: topLevel,
		});
	}
	if (!samePath(commonGitDir, binding.worktree.commonGitDir)) {
		throw new ExecutionContextError("EXECUTION_ROOT_UNAVAILABLE", "共同 Git 目录与宿主证明不一致", {
			expected: binding.worktree.commonGitDir,
			actual: commonGitDir,
		});
	}
	if (binding.worktree.kind === "managed" && branch !== binding.worktree.branchName) {
		throw new ExecutionContextError("EXECUTION_ROOT_UNAVAILABLE", "执行根分支与宿主证明不一致", {
			expected: binding.worktree.branchName,
			actual: branch,
		});
	}
	return topLevel;
}

/**
 * 同步读取并校验指定尝试的持久 execution-context，允许历史执行根已经清理。
 * 当前执行或验收动作还须经 resolveExecutionContext 核对实时 Git 身份。
 */
export function readExecutionBinding(key: ExecutionKey): ExecutionBinding {
	const normalizedKey = validateKey(key);
	const filePath = executionContextPath(normalizedKey);
	if (!existsSync(filePath)) {
		throw new ExecutionContextError("EXECUTION_CONTEXT_NOT_FOUND", "找不到 execution-context", {
			path: filePath,
			key: normalizedKey,
		});
	}
	let binding: ExecutionBinding;
	try {
		binding = validatePersistedBinding(JSON.parse(readFileSync(filePath, "utf8")));
	} catch (error) {
		if (error instanceof ExecutionContextError) throw error;
		throw new ExecutionContextError("INVALID_EXECUTION_CONTEXT", "execution-context 不是合法 JSON", {
			path: filePath,
			cause: error instanceof Error ? error.message : String(error),
		});
	}
	if (
		binding.key.cardNo !== normalizedKey.cardNo ||
		binding.key.attempt !== normalizedKey.attempt ||
		!samePath(binding.key.cardsDir, normalizedKey.cardsDir)
	) {
		throw new ExecutionContextError("INVALID_EXECUTION_CONTEXT", "execution-context 的 key 与请求不一致", {
			path: filePath,
		});
	}
	return binding;
}

/** 执行或验收动作在读取并校验持久绑定后，按需进一步核对当前尝试与真实 Git 现场。 */
export async function resolveExecutionContext(
	key: ExecutionKey,
	options: ResolveExecutionOptions = {},
): Promise<ResolvedExecutionContext> {
	const normalizedKey = validateKey(key);
	const binding = readExecutionBinding(normalizedKey);
	if (options.expectedCurrentAttempt !== undefined) {
		const card = loadCard(normalizedKey.cardsDir, normalizedKey.cardNo);
		if (card.frontmatter.attempt !== options.expectedCurrentAttempt) {
			throw new ExecutionContextError(
				"ATTEMPT_NOT_CURRENT",
				`卡面当前 attempt ${card.frontmatter.attempt} 与动作要求 ${options.expectedCurrentAttempt} 不一致`,
				{ currentAttempt: card.frontmatter.attempt, expectedCurrentAttempt: options.expectedCurrentAttempt },
			);
		}
		if (normalizedKey.attempt !== options.expectedCurrentAttempt) {
			throw new ExecutionContextError(
				"ATTEMPT_NOT_CURRENT",
				`请求读取的是历史 attempt ${normalizedKey.attempt}，执行动作要求当前 ${options.expectedCurrentAttempt}`,
				{ attempt: normalizedKey.attempt, expectedCurrentAttempt: options.expectedCurrentAttempt },
			);
		}
	}
	const canonicalExecutionRoot = options.requireLiveExecutionRoot
		? await verifyLiveBinding(binding)
		: normalize(resolve(binding.executionRoot));
	return { ...binding, canonicalExecutionRoot };
}
