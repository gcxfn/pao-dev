import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readCard, serializeCard } from "../cards/cardfile.ts";
import { writeFileAtomic } from "../shared/atomic.ts";
import { withFileLock } from "../shared/lock.ts";
import { digestObject, digestObjectExcluding, isSha256Digest, sha256Bytes } from "./canonical.ts";
import { DispatchBriefError } from "./errors.ts";
import type {
	DispatchArtifactReference,
	DispatchBriefArtifact,
	DispatchCardWriteExpectation,
	DispatchContractReference,
	DispatchContractVersionRecord,
	DispatchMapArtifact,
} from "./types.ts";
import { briefUri, contractUri, isSafeArtifactId, mapUri, parseDispatchUri } from "./uri.ts";
import { sameRepositoryPath, tryReadGitIdentity } from "./workspace.ts";

export interface DispatchArtifactLocation {
	cardsDir?: string;
	artifactsRoot?: string;
}

export interface SaveDispatchBriefArtifactInput extends DispatchArtifactLocation {
	id: string;
	cardsDir: string;
	cardPath: string;
	cardNo: number;
	attempt: number;
	owner?: string;
	purpose?: string;
	markdown: string;
	requirements?: DispatchBriefArtifact["requirements"];
	createdAt?: string;
}

export interface SaveDispatchMapArtifactInput extends DispatchArtifactLocation {
	artifact: DispatchMapArtifact;
}

export interface SaveDispatchContractReferenceInput extends DispatchArtifactLocation {
	projectRoot: string;
	id: string;
	version: string;
	ref: string;
	digest: string;
	contentPath: string;
	purpose?: string;
	affectedCards?: number[];
	previousRef?: string;
	supersessionReason?: string;
}

export interface AppendDispatchInputReferenceInput {
	cardPath: string;
	ref: string;
	expected?: DispatchCardWriteExpectation;
}

export interface ResolveDispatchContractContentPathInput {
	artifact: DispatchContractReference;
	projectRoot: string;
	executionRoot: string;
}

export interface DispatchContractContentSnapshot {
	path: string;
	content: Buffer;
	digest: string;
}

function assertContainedPath(root: string, candidate: string, field: string, value: string): void {
	const rel = relative(root, candidate);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new DispatchBriefError("unsafe_path", `${field} 必须是项目根内的真实路径：${value}`, { path: candidate });
	}
}

/**
 * 已存在的正本按真实路径判界，拦截字符串仍在项目内、但经 junction/symlink
 * 实际指向项目外的文件。文件不存在仍报 missing_input，不误报越权。
 */
function projectContainedPath(projectRoot: string, value: string, field: string): string {
	const root = realpathSync(projectRoot);
	const lexical = resolve(root, value);
	assertContainedPath(root, lexical, field, value);
	if (!existsSync(lexical)) {
		throw new DispatchBriefError("missing_input", `${field} 正本不存在：${lexical}`, { path: lexical });
	}
	const actual = realpathSync(lexical);
	assertContainedPath(root, actual, field, value);
	return actual;
}

/**
 * 工具入口与实际保存共用同一次真实路径判界和内容读取。
 * 不先按字符串读取正本，避免 junction/symlink 在保存前绕过项目根。
 */
export function readDispatchContractContent(projectRoot: string, contentPath: string): DispatchContractContentSnapshot {
	const path = projectContainedPath(projectRoot, contentPath, "契约 content_path");
	const content = readFileSync(path);
	return { path, content, digest: sha256Bytes(content) };
}

export function dispatchArtifactsRoot(location: DispatchArtifactLocation): string {
	if (location.artifactsRoot) return resolve(location.artifactsRoot);
	if (!location.cardsDir) {
		throw new DispatchBriefError("missing_input", "读取 dispatch 引用需要 cards_dir 或 artifacts_root", {});
	}
	return join(resolve(location.cardsDir), "..", "输入快照");
}

function repositoryRelativeContentPath(
	projectRoot: string,
	contentPath: string,
): {
	repositoryRoot?: string;
	contentPath: string;
} {
	const projectIdentity = tryReadGitIdentity(projectRoot);
	const base = projectIdentity.ok ? realpathSync(projectIdentity.repositoryRoot) : realpathSync(projectRoot);
	const actual = realpathSync(contentPath);
	assertContainedPath(base, actual, "契约 content_path", contentPath);
	const value = relative(base, actual);
	return {
		...(projectIdentity.ok ? { repositoryRoot: projectIdentity.repositoryRoot } : {}),
		contentPath: (value || ".").replaceAll("\\", "/"),
	};
}

/**
 * 把保存的契约正本定位映射到当前执行根。
 * 原始 ref 仍用于报告和兼容；Git 同仓时使用 contentPath 读取目标 worktree 的实际版本。
 */
export function resolveDispatchContractContentPath(input: ResolveDispatchContractContentPathInput): string {
	const artifact = input.artifact;
	const executionRoot = realpathSync(input.executionRoot);
	const executionIdentity = tryReadGitIdentity(executionRoot);
	let sourceRoot: string;
	let contentPath: string | undefined = artifact.contentPath;

	if (artifact.repositoryRoot) {
		if (!executionIdentity.ok) {
			throw new DispatchBriefError(
				"execution_binding_invalid",
				`契约保存于 Git 仓库，但执行根无法核验 Git 身份：${executionIdentity.reason}`,
				{ path: executionRoot, ref: artifact.ref },
			);
		}
		const savedIdentity = tryReadGitIdentity(artifact.repositoryRoot);
		if (
			!savedIdentity.ok ||
			sameRepositoryPath(savedIdentity.commonGitDir, executionIdentity.commonGitDir) === false
		) {
			throw new DispatchBriefError("execution_binding_invalid", "契约保存仓库与当前执行根不属于同一 Git 仓库", {
				path: executionRoot,
				ref: artifact.ref,
				repositoryRoot: artifact.repositoryRoot,
			});
		}
		sourceRoot = executionIdentity.repositoryRoot;
		contentPath ??= relative(artifact.repositoryRoot, resolve(artifact.ref)).replaceAll("\\", "/");
	} else {
		const projectRoot = realpathSync(input.projectRoot);
		const sourceIdentity = tryReadGitIdentity(projectRoot);
		if (sourceIdentity.ok && executionIdentity.ok) {
			if (sameRepositoryPath(sourceIdentity.commonGitDir, executionIdentity.commonGitDir) === false) {
				throw new DispatchBriefError("execution_binding_invalid", "契约项目根与当前执行根不属于同一 Git 仓库", {
					path: executionRoot,
					ref: artifact.ref,
				});
			}
			sourceRoot = executionIdentity.repositoryRoot;
			contentPath ??= relative(sourceIdentity.repositoryRoot, resolve(artifact.ref)).replaceAll("\\", "/");
		} else {
			// 非 Git 旧卡/旧记录没有 worktree 映射，保留原绝对定位兼容。
			sourceRoot = projectRoot;
			contentPath ??= relative(projectRoot, resolve(artifact.ref));
		}
	}

	try {
		const candidate = resolve(sourceRoot, contentPath);
		const root = realpathSync(sourceRoot);
		assertContainedPath(root, candidate, "契约 content_path", contentPath);
		if (!existsSync(candidate)) {
			throw new DispatchBriefError("missing_input", `契约正本不存在：${candidate}`, { path: candidate });
		}
		const actual = realpathSync(candidate);
		assertContainedPath(root, actual, "契约 content_path", contentPath);
		return actual;
	} catch (error) {
		if (error instanceof DispatchBriefError) {
			throw new DispatchBriefError(
				error.code,
				error.message,
				Object.fromEntries(
					Object.entries({
						...error.details,
						ref: input.artifact.ref,
						contentRef: artifact.ref,
					}).filter(([, value]) => value !== undefined),
				),
			);
		}
		throw error;
	}
}

function artifactPath(location: DispatchArtifactLocation, kind: "brief" | "map" | "contract", id: string): string {
	if (!isSafeArtifactId(id)) {
		throw new DispatchBriefError("unsafe_path", `受控产物 ID 非法：${id}`, { id });
	}
	return join(dispatchArtifactsRoot(location), kind, `${id}.json`);
}

function contractVersionPath(location: DispatchArtifactLocation, id: string, version: string): string {
	if (!isSafeArtifactId(id)) {
		throw new DispatchBriefError("unsafe_path", `受控产物 ID 非法：${id}`, { id });
	}
	return join(dispatchArtifactsRoot(location), "contract", `${id}.${encodeURIComponent(version)}.json`);
}

function readArtifact<T>(path: string): T {
	if (!existsSync(path)) {
		throw new DispatchBriefError("missing_input", `受控产物不存在：${path}`, { path });
	}
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch (error) {
		throw new DispatchBriefError("bad_reference", `受控产物不是合法 JSON：${path}`, {
			path,
			cause: error instanceof Error ? error.message : String(error),
		});
	}
}

async function writeImmutableJson(path: string, value: unknown, expectedDigest: string): Promise<void> {
	mkdirSync(dirname(path), { recursive: true });
	await withFileLock(path, () => {
		if (existsSync(path)) {
			const existing = readArtifact<unknown>(path);
			const digest = digestObjectExcluding(existing as Record<string, unknown>, [...artifactDigestField(existing)]);
			if (digest !== expectedDigest) {
				throw new DispatchBriefError("artifact_conflict", `受控产物已存在且内容不同：${path}`, { path });
			}
			return;
		}
		writeFileAtomic(path, `${JSON.stringify(value, null, "\t")}\n`);
	});
}

export function validateDispatchArtifactReference(ref: string, location: DispatchArtifactLocation): void {
	const parsed = parseDispatchUri(ref);
	if (parsed.scheme === "pao-brief") {
		loadDispatchBriefArtifact(parsed.canonical, location);
		return;
	}
	if (parsed.scheme === "pao-map") {
		loadDispatchMapArtifact(parsed.canonical, location);
		return;
	}
	loadDispatchContractReference(parsed.canonical, location);
}

function validateSupersession(
	scheme: "map" | "contract",
	previousRef: string | undefined,
	reason: string | undefined,
): void {
	if ((previousRef === undefined) !== (reason === undefined)) {
		throw new DispatchBriefError("missing_input", "来源替代必须同时给出 previousRef 与 supersessionReason", {});
	}
	if (previousRef === undefined) return;
	if (!previousRef.trim() || !reason?.trim()) {
		throw new DispatchBriefError("missing_input", "来源替代的 previousRef 与 supersessionReason 不能为空", {
			ref: previousRef,
		});
	}
	const parsed = parseDispatchUri(previousRef);
	const expected = scheme === "map" ? "pao-map" : "pao-contract";
	if (parsed.scheme !== expected) {
		throw new DispatchBriefError("bad_reference", `来源替代必须指向同类产物：${previousRef}`, { ref: previousRef });
	}
}

function artifactDigestField(value: unknown): string[] {
	if (typeof value !== "object" || value === null) return [];
	if ("artifactDigest" in value) return ["artifactDigest"];
	if ("mapDigest" in value) return ["mapDigest"];
	return [];
}

export async function saveDispatchBriefArtifact(
	input: SaveDispatchBriefArtifactInput,
): Promise<DispatchArtifactReference> {
	if (!input.markdown.trim()) {
		throw new DispatchBriefError("missing_input", "简报正文不能为空", { id: input.id });
	}
	const base = {
		schemaVersion: 1 as const,
		kind: "pao-brief" as const,
		id: input.id,
		cardsDir: realpathSync(input.cardsDir),
		cardPath: realpathSync(input.cardPath),
		cardNo: input.cardNo,
		attempt: input.attempt,
		...(input.owner ? { owner: input.owner } : {}),
		...(input.purpose ? { purpose: input.purpose } : {}),
		...(input.requirements ? { requirements: input.requirements } : {}),
		markdown: input.markdown,
		createdAt: input.createdAt ?? new Date().toISOString(),
	};
	const artifactDigest = digestObjectExcluding(base, []);
	const artifact: DispatchBriefArtifact = { ...base, artifactDigest };
	const path = artifactPath(input, "brief", input.id);
	await writeImmutableJson(path, artifact, artifactDigest);
	return { ref: briefUri(input.id, artifactDigest), digest: artifactDigest };
}

export function loadDispatchBriefArtifact(ref: string, location: DispatchArtifactLocation): DispatchBriefArtifact {
	const parsed = parseDispatchUri(ref);
	if (parsed.scheme !== "pao-brief") {
		throw new DispatchBriefError("bad_reference", `不是简报引用：${ref}`, { ref });
	}
	const path = artifactPath(location, "brief", parsed.id);
	const artifact = readArtifact<DispatchBriefArtifact>(path);
	if (artifact.kind !== "pao-brief" || artifact.schemaVersion !== 1 || artifact.id !== parsed.id) {
		throw new DispatchBriefError("bad_reference", `简报产物身份不符：${ref}`, { ref, path });
	}
	const actual = digestObjectExcluding(artifact, ["artifactDigest"]);
	if (artifact.artifactDigest !== parsed.digest || actual !== artifact.artifactDigest) {
		throw new DispatchBriefError("bad_reference", `简报产物摘要不符：${ref}`, { ref, path });
	}
	return artifact;
}

export async function saveDispatchMapArtifact(
	input: SaveDispatchMapArtifactInput,
): Promise<{ ref: string; digest: string; status: DispatchMapArtifact["status"] }> {
	const artifact = input.artifact;
	validateSupersession("map", artifact.previousRef, artifact.supersessionReason);
	if (artifact.previousRef) {
		const previous = loadDispatchMapArtifact(artifact.previousRef, input);
		if (previous.mapDigest === artifact.mapDigest || previous.id === artifact.id) {
			throw new DispatchBriefError("bad_reference", "新地图必须使用不同 ID 并替代另一份已保存地图", {
				ref: artifact.previousRef,
			});
		}
	}
	if (!isSafeArtifactId(artifact.id)) {
		throw new DispatchBriefError("unsafe_path", `地图 ID 非法：${artifact.id}`, { id: artifact.id });
	}
	const actual = digestObjectExcluding(artifact, ["mapDigest"]);
	if (artifact.mapDigest !== actual) {
		throw new DispatchBriefError("bad_reference", "地图内容摘要与地图自身摘要不符", { id: artifact.id });
	}
	const path = artifactPath(input, "map", artifact.id);
	await writeImmutableJson(path, artifact, artifact.mapDigest);
	return {
		ref: mapUri(artifact.id, artifact.mapDigest, artifact.status),
		digest: artifact.mapDigest,
		status: artifact.status,
	};
}

export function loadDispatchMapArtifact(ref: string, location: DispatchArtifactLocation): DispatchMapArtifact {
	const parsed = parseDispatchUri(ref);
	if (parsed.scheme !== "pao-map") {
		throw new DispatchBriefError("bad_reference", `不是地图引用：${ref}`, { ref });
	}
	const path = artifactPath(location, "map", parsed.id);
	const artifact = readArtifact<DispatchMapArtifact>(path);
	if (artifact.kind !== "pao-map" || artifact.schemaVersion !== 1 || artifact.id !== parsed.id) {
		throw new DispatchBriefError("bad_reference", `地图产物身份不符：${ref}`, { ref, path });
	}
	const actual = digestObjectExcluding(artifact, ["mapDigest"]);
	if (artifact.mapDigest !== parsed.digest || actual !== artifact.mapDigest) {
		throw new DispatchBriefError("bad_reference", `地图产物摘要不符：${ref}`, { ref, path });
	}
	return artifact;
}

export async function saveDispatchContractReference(
	input: SaveDispatchContractReferenceInput,
): Promise<{ ref: string; version: string; digest: string }> {
	validateSupersession("contract", input.previousRef, input.supersessionReason);
	if (input.previousRef) {
		const previous = loadDispatchContractReference(input.previousRef, input);
		if (previous.id !== input.id || previous.version === input.version) {
			throw new DispatchBriefError("bad_reference", "新契约版本必须使用同一契约 ID 和不同 version", {
				ref: input.previousRef,
			});
		}
	}
	if (!isSha256Digest(input.digest)) {
		throw new DispatchBriefError("bad_reference", "契约摘要格式错误", { digest: input.digest });
	}
	const contentPath = projectContainedPath(input.projectRoot, input.contentPath, "契约 content_path");
	if (!existsSync(contentPath)) {
		throw new DispatchBriefError("missing_input", `契约正本不存在：${contentPath}`, { path: contentPath });
	}
	const contentDigest = sha256Bytes(readFileSync(contentPath));
	if (contentDigest !== input.digest) {
		throw new DispatchBriefError("contract_changed", `契约摘要已变化：${input.ref}`, {
			ref: input.ref,
			path: contentPath,
			expected: input.digest,
			actual: contentDigest,
		});
	}
	if (!isAbsolute(input.ref)) {
		throw new DispatchBriefError("bad_reference", `契约正本引用必须是绝对路径：${input.ref}`, {
			ref: input.ref,
		});
	}
	const persistedContent = repositoryRelativeContentPath(input.projectRoot, contentPath);
	const base = {
		schemaVersion: 1 as const,
		kind: "pao-contract-reference" as const,
		id: input.id,
		version: input.version,
		ref: input.ref,
		projectRoot: realpathSync(input.projectRoot),
		...(persistedContent.repositoryRoot ? { repositoryRoot: persistedContent.repositoryRoot } : {}),
		contentPath: persistedContent.contentPath,
		...(input.purpose ? { purpose: input.purpose } : {}),
		...(input.affectedCards ? { affectedCards: [...new Set(input.affectedCards)].sort((a, b) => a - b) } : {}),
		...(input.previousRef ? { previousRef: input.previousRef } : {}),
		...(input.supersessionReason ? { supersessionReason: input.supersessionReason.trim() } : {}),
		contentDigest,
	};
	const artifactDigest = digestObjectExcluding(base, []);
	const currentPath = artifactPath(input, "contract", input.id);
	let current: DispatchContractReference | undefined;
	if (existsSync(currentPath)) {
		current = readArtifact<DispatchContractReference>(currentPath);
		if (current.version === input.version) {
			if (current.artifactDigest !== artifactDigest) {
				throw new DispatchBriefError("artifact_conflict", "同一契约版本已存在且内容不同", {
					path: currentPath,
					id: input.id,
					version: input.version,
				});
			}
			return {
				ref: contractUri(input.id, input.version, current.artifactDigest),
				version: current.version,
				digest: current.artifactDigest,
			};
		}
		if (!input.previousRef) {
			throw new DispatchBriefError(
				"missing_input",
				`同 ID 契约升版必须用 previousRef 指向当前版本 ${current.version}，并说明 supersessionReason`,
				{ id: input.id, currentVersion: current.version, version: input.version },
			);
		}
		const previous = loadDispatchContractReference(input.previousRef, input);
		if (previous.id !== input.id || previous.version !== current.version) {
			throw new DispatchBriefError("bad_reference", "契约升版的 previousRef 必须指向同 ID 的当前版本", {
				ref: input.previousRef,
				currentVersion: current.version,
			});
		}
	}
	const versionRecord: DispatchContractVersionRecord = { ...base, artifactDigest };
	await writeImmutableJson(contractVersionPath(input, input.id, input.version), versionRecord, artifactDigest);
	const history = artifactHistory(input, input.id, input.version);
	const artifact: DispatchContractReference = {
		...base,
		artifactDigest,
		versions: [versionRecord, ...history],
	};
	await writeFileAtomic(artifactPath(input, "contract", input.id), `${JSON.stringify(artifact, null, "\t")}\n`);
	return {
		ref: contractUri(input.id, input.version, artifactDigest),
		version: input.version,
		digest: artifactDigest,
	};
}

function artifactHistory(
	location: DispatchArtifactLocation,
	id: string,
	excludedVersion: string,
): DispatchContractVersionRecord[] {
	const existingPath = artifactPath(location, "contract", id);
	if (!existsSync(existingPath)) return [];
	const existing = readArtifact<DispatchContractReference>(existingPath);
	const byVersion = new Map<string, DispatchContractVersionRecord>();
	for (const version of existing.versions ?? []) {
		if (version.id === id && version.version !== excludedVersion) byVersion.set(version.version, version);
	}
	if (existing.version !== excludedVersion) {
		const { versions: _versions, ...legacy } = existing;
		byVersion.set(existing.version, legacy);
	}
	return [...byVersion.values()].sort((left, right) => right.version.localeCompare(left.version));
}

export function loadDispatchContractReference(
	ref: string,
	location: DispatchArtifactLocation,
): DispatchContractReference {
	const parsed = parseDispatchUri(ref);
	if (parsed.scheme !== "pao-contract") {
		throw new DispatchBriefError("bad_reference", `不是契约引用：${ref}`, { ref });
	}
	if (!parsed.version) {
		throw new DispatchBriefError("bad_reference", `契约引用缺少版本：${ref}`, { ref });
	}
	const version = parsed.version;
	const currentPath = artifactPath(location, "contract", parsed.id);
	const current = readArtifact<DispatchContractReference>(currentPath);
	const currentVersion = current.versions?.find((item) => item.version === version);
	const path = currentVersion ? contractVersionPath(location, parsed.id, version) : currentPath;
	const artifact = currentVersion && existsSync(path) ? readArtifact<DispatchContractVersionRecord>(path) : current;
	if (
		artifact.kind !== "pao-contract-reference" ||
		artifact.schemaVersion !== 1 ||
		artifact.id !== parsed.id ||
		artifact.version !== version
	) {
		throw new DispatchBriefError("bad_reference", `契约产物身份或版本不符：${ref}`, { ref, path });
	}
	const actual = currentVersion
		? digestObjectExcluding(artifact, ["artifactDigest"])
		: digestObject(
				Object.fromEntries(
					Object.entries(artifact).filter(([key]) => key !== "artifactDigest" && key !== "versions"),
				) as Omit<DispatchContractVersionRecord, "artifactDigest">,
			);
	if (artifact.artifactDigest !== parsed.digest || actual !== artifact.artifactDigest) {
		throw new DispatchBriefError("bad_reference", `契约产物摘要不符：${ref}`, { ref, path });
	}
	return canonicalContractReference(artifact);
}

function storedMapReferenceForPrevious(
	location: DispatchArtifactLocation,
	previousRef: string,
): { supersededBy: string; reason?: string } | undefined {
	const directory = join(dispatchArtifactsRoot(location), "map");
	if (!existsSync(directory)) return undefined;
	for (const name of readdirSync(directory).filter((item) => item.endsWith(".json"))) {
		let candidate: DispatchMapArtifact | undefined;
		try {
			candidate = JSON.parse(readFileSync(join(directory, name), "utf8")) as DispatchMapArtifact;
		} catch {
			// 无关坏文件不能阻止对目标引用的替代关系判断；命中目标时才严格验证。
			continue;
		}
		if (candidate?.previousRef !== previousRef) continue;
		const ref = mapUri(candidate.id, candidate.mapDigest, candidate.status);
		const saved = loadDispatchMapArtifact(ref, location);
		return {
			supersededBy: ref,
			...(saved.supersessionReason ? { reason: saved.supersessionReason } : {}),
		};
	}
	return undefined;
}

/**
 * 只读取已保存产物判断显式替代关系。旧版本加载仍保持只读兼容；
 * 新派发由 precheck/freeze/verify 主动拒绝已知旧来源。
 */
export function findDispatchReferenceSupersession(
	ref: string,
	location: DispatchArtifactLocation,
): { supersededBy: string; reason?: string } | undefined {
	const parsed = parseDispatchUri(ref);
	if (parsed.scheme === "pao-map") {
		return storedMapReferenceForPrevious(location, parsed.canonical);
	}
	if (parsed.scheme !== "pao-contract") return undefined;

	const artifact = loadDispatchContractReference(parsed.canonical, location);
	const currentPath = artifactPath(location, "contract", artifact.id);
	if (!existsSync(currentPath)) return undefined;
	const current = readArtifact<DispatchContractReference>(currentPath);
	const currentRef = contractUri(current.id, current.version, current.artifactDigest);
	const savedCurrent = loadDispatchContractReference(currentRef, location);
	if (savedCurrent.version === artifact.version && savedCurrent.artifactDigest === artifact.artifactDigest) {
		return undefined;
	}
	return {
		supersededBy: currentRef,
		...(savedCurrent.supersessionReason ? { reason: savedCurrent.supersessionReason } : {}),
	};
}

export function assertDispatchReferenceNotSuperseded(ref: string, location: DispatchArtifactLocation): void {
	const supersession = findDispatchReferenceSupersession(ref, location);
	if (!supersession) return;
	const parsed = parseDispatchUri(ref);
	throw new DispatchBriefError(
		parsed.scheme === "pao-map" ? "stale_map" : "contract_changed",
		`${parsed.scheme === "pao-map" ? "地图" : "契约"}引用已被显式替代：${ref} → ${supersession.supersededBy}` +
			(supersession.reason ? `；原因：${supersession.reason}` : ""),
		{
			ref,
			supersededBy: supersession.supersededBy,
			...(supersession.reason ? { reason: supersession.reason } : {}),
		},
	);
}

function canonicalContractReference(record: DispatchContractVersionRecord): DispatchContractReference {
	return {
		...record,
		versions: [record],
	};
}

export async function appendCardInputReference(
	input: AppendDispatchInputReferenceInput,
): Promise<{ changed: boolean }> {
	return withFileLock(input.cardPath, () => appendCardInputReferenceUnlocked(input));
}

/** 调用方已经持有同一张卡锁时复用，避免同一事务重复获取不可重入锁。 */
export async function appendCardInputReferenceUnlocked(
	input: AppendDispatchInputReferenceInput,
): Promise<{ changed: boolean }> {
	const normalized = parseDispatchUri(input.ref).canonical;
	const cardsDir = dirname(resolve(input.cardPath));
	validateDispatchArtifactReference(normalized, { cardsDir });
	const card = readCard(input.cardPath);
	if (input.expected) {
		if (
			card.frontmatter.attempt !== input.expected.attempt ||
			card.frontmatter.owner !== input.expected.owner ||
			card.frontmatter.status !== input.expected.status
		) {
			throw new DispatchBriefError("card_changed", "写卡 inputs 前，卡面 attempt、owner 或 status 已变化", {
				path: card.path,
				expected: input.expected,
				actual: {
					attempt: card.frontmatter.attempt,
					owner: card.frontmatter.owner,
					status: card.frontmatter.status,
				},
			});
		}
	}
	const inputs = card.frontmatter.inputs ?? [];
	if (inputs.includes(normalized)) return { changed: false };
	const next = [...inputs, normalized];
	writeFileAtomic(card.path, serializeCard({ ...card.frontmatter, inputs: next }, card.body));
	return { changed: true };
}

export function artifactRelativePath(path: string, location: DispatchArtifactLocation): string {
	return join(dirname(dispatchArtifactsRoot(location)), path).replaceAll("\\", "/");
}
