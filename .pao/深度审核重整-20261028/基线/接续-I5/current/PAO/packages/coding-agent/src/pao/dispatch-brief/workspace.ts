import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { GIT_READ_TIMEOUT_MS, gitProcessErrorText } from "../shared/git.ts";
import { pathKey } from "../shared/path-key.ts";
import { digestObjectExcluding, sha256Bytes, sha256Text } from "./canonical.ts";
import { DispatchBriefError } from "./errors.ts";
import type { DispatchBriefInput, DispatchMapArtifact, DispatchMapFileSnapshot, DispatchMapInput } from "./types.ts";
import { mapUri } from "./uri.ts";

interface GitPathState {
	path: string;
	working: Buffer | undefined;
	head: Buffer | undefined;
	index: Buffer | undefined;
}

const IMPLICIT_PROJECT_EXCLUDES = [".git", ".pao"] as const;

function git(cwd: string, args: string[], allowFailure = false): Buffer {
	const result = spawnSync("git", ["-c", "core.quotepath=off", ...args], {
		cwd,
		encoding: null,
		windowsHide: true,
		timeout: GIT_READ_TIMEOUT_MS,
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.error) {
		throw new DispatchBriefError(
			"missing_input",
			`Git 读取失败：${gitProcessErrorText(
				result.error,
				result.stderr?.toString("utf8") ?? "",
				GIT_READ_TIMEOUT_MS,
			)}`,
			{ path: cwd },
		);
	}
	if (!allowFailure && result.status !== 0) {
		const stderr = result.stderr?.toString("utf8").trim() ?? "";
		throw new DispatchBriefError("missing_input", `Git 读取失败（${args.join(" ")}）：${stderr}`, {
			path: cwd,
		});
	}
	return result.stdout;
}

function gitText(cwd: string, args: string[], allowFailure = false): string {
	return git(cwd, args, allowFailure).toString("utf8").trim();
}

function repo(executionRoot: string): {
	root: string;
	commonGitDir: string;
	head: string;
	tree: string;
} {
	const root = gitText(executionRoot, ["rev-parse", "--show-toplevel"]);
	const commonGitDir = gitText(executionRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	const head = gitText(executionRoot, ["rev-parse", "HEAD"]);
	const tree = gitText(executionRoot, ["rev-parse", "HEAD^{tree}"]);
	return {
		root: realpathSync(root),
		commonGitDir: realpathSync(commonGitDir),
		head,
		tree,
	};
}

export function tryReadGitIdentity(executionRoot: string):
	| {
			ok: true;
			repositoryRoot: string;
			commonGitDir: string;
			head: string;
			treeId: string;
	  }
	| {
			ok: false;
			reason: string;
	  } {
	try {
		const identity = repo(realpathSync(executionRoot));
		return {
			ok: true,
			repositoryRoot: identity.root,
			commonGitDir: identity.commonGitDir,
			head: identity.head,
			treeId: identity.tree,
		};
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

function splitNul(data: Buffer): string[] {
	return data
		.toString("utf8")
		.split("\0")
		.filter((item) => item.length > 0)
		.map((item) => item.replaceAll("\\", "/"));
}

function repositoryRelativePath(root: string, path: string): string {
	const absolute = resolve(root, path);
	const result = relative(root, absolute);
	if (
		result.startsWith(`..${sep}`) ||
		result === ".." ||
		result.includes(`..${sep}`) ||
		resolve(root, result) !== absolute
	) {
		throw new DispatchBriefError("unsafe_path", `覆盖路径越出项目根：${path}`, { path });
	}
	return result === "" ? "." : result.replaceAll("\\", "/");
}

function normalizeCoverage(root: string, values: string[]): string[] {
	if (values.length === 0) {
		throw new DispatchBriefError("missing_input", "地图必须声明至少一个覆盖路径", { path: root });
	}
	return [
		...new Set(
			values.map((value) => {
				const trimmed = value.trim();
				if (!trimmed || /[\\:][*?]|^\s*$/.test(trimmed)) {
					throw new DispatchBriefError("bad_reference", `地图覆盖路径非法：${value}`, { path: value });
				}
				return repositoryRelativePath(root, trimmed);
			}),
		),
	].sort();
}

function normalizeRelative(root: string, value: string): string {
	return relative(root, resolve(root, value)).replaceAll("\\", "/");
}

function normalizeExcludes(root: string, values: string[], projectRoot: string): string[] {
	const excluded = values.map((item) => normalizeRelative(root, item).replace(/\/+$/, ""));
	const projectState = relative(root, join(projectRoot, ".pao"));
	if (projectState !== ".." && !projectState.startsWith(`..${sep}`) && !isAbsolute(projectState))
		excluded.push(projectState.replaceAll("\\", "/"));
	return [...new Set([...excluded, ...IMPLICIT_PROJECT_EXCLUDES])].sort();
}

function fileState(root: string, path: string): GitPathState {
	const absolute = join(root, path);
	let working: Buffer | undefined;
	try {
		if (existsSync(absolute) && statSync(absolute).isFile()) working = readFileSync(absolute);
	} catch {
		throw new DispatchBriefError("missing_input", `地图文件读取失败：${path}`, { path });
	}
	const head = git(root, ["show", `HEAD:${path}`], true);
	const index = git(root, ["show", `:${path}`], true);
	return {
		path,
		working,
		head: gitSucceeded(root, ["cat-file", "-e", `HEAD:${path}`]) ? head : undefined,
		index: gitSucceeded(root, ["cat-file", "-e", `:${path}`]) ? index : undefined,
	};
}

function contentDigest(state: GitPathState): string | undefined {
	const content = state.working ?? state.index ?? state.head;
	return content ? sha256Bytes(content) : undefined;
}

function fileIdentity(file: DispatchMapFileSnapshot): string[] {
	return [file.path, file.headDigest ?? "", file.indexDigest ?? "", file.workingDigest ?? "", file.contentDigest];
}

function missingDigest(): string {
	return sha256Text("<pao:missing>");
}

function gitSucceeded(cwd: string, args: string[]): boolean {
	const result = spawnSync("git", ["-c", "core.quotepath=off", ...args], {
		cwd,
		encoding: null,
		windowsHide: true,
		timeout: GIT_READ_TIMEOUT_MS,
	});
	if (result.error) {
		throw new DispatchBriefError(
			"missing_input",
			`Git 读取失败：${gitProcessErrorText(
				result.error,
				result.stderr?.toString("utf8") ?? "",
				GIT_READ_TIMEOUT_MS,
			)}`,
			{ path: cwd },
		);
	}
	return !result.error && result.status === 0;
}

function listCoveredPaths(root: string, coverage: string[], excludes: string[]): string[] {
	const tracked = splitNul(git(root, ["ls-files", "-z", "--", ...coverage]));
	const untracked = splitNul(git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...coverage]));
	const paths = new Set([...tracked, ...untracked]);
	for (const item of coverage) {
		const noSlash = item.replace(/\/+$/, "");
		if (noSlash && existsSync(join(root, noSlash)) && statSync(join(root, noSlash)).isFile()) paths.add(noSlash);
	}
	const excluded = excludes.map((item) => item.replaceAll("\\", "/").replace(/\/+$/, ""));
	return [...paths].filter((path) => !excluded.some((item) => path === item || path.startsWith(`${item}/`))).sort();
}

function coveragePathExists(root: string, path: string): boolean {
	if (existsSync(join(root, path))) return true;
	// 已删除的受跟踪路径在文件系统中不存在，但仍属于明确声明的覆盖范围。
	return splitNul(git(root, ["ls-files", "-z", "--", path])).length > 0;
}

export function captureDispatchMap(input: DispatchMapInput): DispatchMapArtifact {
	const executionRoot = realpathSync(input.executionRoot ?? input.projectRoot);
	const repoIdentity = repo(executionRoot);
	const projectRoot = realpathSync(input.projectRoot);
	const coverage = normalizeCoverage(repoIdentity.root, input.coverage);
	const excludes = normalizeExcludes(repoIdentity.root, input.excludes ?? [], projectRoot);
	const missingCoverage = coverage.filter((path) => !coveragePathExists(repoIdentity.root, path));
	if (missingCoverage.length > 0) {
		throw new DispatchBriefError(
			"missing_input",
			`地图覆盖路径不存在或没有受跟踪内容：${missingCoverage.join("、")}`,
			{ coverage, missing: missingCoverage },
		);
	}
	// 覆盖范围固定为仓库相对路径；git pathspec、exists 和文件读取都直接相对 repositoryRoot。
	const files = listCoveredPaths(repoIdentity.root, coverage, excludes);
	const snapshots: DispatchMapFileSnapshot[] = [];
	for (const path of files) {
		const state = fileState(repoIdentity.root, path);
		snapshots.push({
			path: state.path,
			...(state.head ? { headDigest: sha256Bytes(state.head) } : {}),
			...(state.index ? { indexDigest: sha256Bytes(state.index) } : {}),
			...(state.working ? { workingDigest: sha256Bytes(state.working) } : {}),
			contentDigest: contentDigest(state) ?? missingDigest(),
			size: state.working?.length ?? 0,
		});
	}
	const scopeConfirmed = input.scopeConfirmed === true && input.scopeReviewRequired !== true;
	const scopeReviewRequired = !scopeConfirmed;
	const scopeBasis = [...new Set((input.scopeBasis ?? []).map((item) => item.trim()).filter(Boolean))].sort();
	if (scopeConfirmed && scopeBasis.length === 0) {
		throw new DispatchBriefError(
			"missing_input",
			"确认调用边界时必须声明 scopeBasis，说明哪些覆盖范围能检出新增调用方",
			{ coverage },
		);
	}
	const filesDigest = digestObjectExcluding(snapshots.map(fileIdentity), []);
	const index = git(repoIdentity.root, ["ls-files", "--stage", "-z"]);
	const artifactBase = {
		schemaVersion: 1 as const,
		kind: "pao-map" as const,
		id: input.id,
		projectRoot,
		repositoryRoot: repoIdentity.root,
		coverage: { paths: coverage, excludes },
		facts: input.facts ?? [],
		unknowns: input.unknowns ?? [],
		relations: input.relations ?? [],
		risks: input.risks ?? [],
		...(input.integrationOwner ? { integrationOwner: input.integrationOwner } : {}),
		...(input.previousRef ? { previousRef: input.previousRef } : {}),
		...(input.supersessionReason ? { supersessionReason: input.supersessionReason.trim() } : {}),
		scopeConfirmed,
		...(scopeBasis.length > 0 ? { scopeBasis } : {}),
		scopeReviewRequired,
		status: scopeReviewRequired ? ("unknown" as const) : ("valid" as const),
		reason: scopeReviewRequired ? "调用方未确认覆盖范围足以检出新增使用点，需要复核" : undefined,
		repo: {
			head: repoIdentity.head,
			treeId: repoIdentity.tree,
			indexDigest: sha256Bytes(index),
			untrackedDigest: filesDigest,
		},
		files: snapshots,
		capturedAt: input.capturedAt ?? new Date().toISOString(),
	};
	const mapDigest = digestObjectExcluding(artifactBase, []);
	return { ...artifactBase, mapDigest };
}

/**
 * 地图有效期只由声明的覆盖范围及其实际内容决定。
 * repo.head/treeId 保留为采集证据，范围外提交不能使地图失效。
 */
export function sameDispatchMapCoverage(saved: DispatchMapArtifact, current: DispatchMapArtifact): boolean {
	if (JSON.stringify(saved.coverage) !== JSON.stringify(current.coverage)) return false;
	if (saved.scopeReviewRequired !== current.scopeReviewRequired) return false;
	if (saved.scopeConfirmed !== current.scopeConfirmed) return false;
	if (JSON.stringify(saved.scopeBasis ?? []) !== JSON.stringify(current.scopeBasis ?? [])) return false;
	const currentFiles = new Map(current.files.map((file) => [file.path, file]));
	if (saved.files.length !== currentFiles.size) return false;
	for (const file of saved.files) {
		const next = currentFiles.get(file.path);
		if (
			!next ||
			file.headDigest !== next.headDigest ||
			file.indexDigest !== next.indexDigest ||
			file.workingDigest !== next.workingDigest ||
			file.contentDigest !== next.contentDigest
		) {
			return false;
		}
	}
	return true;
}

export interface DispatchMapHandoffCheck {
	/** 没有地图时是否必须拒绝；有地图时始终检查它能否被交接。 */
	required: boolean;
	ref?: string;
	/** 控制正本节点名；只用于定位原部长，不参与地图内容判断。 */
	node?: string;
	stage: "complete" | "dispatch";
}

/**
 * 检查已加载且摘要可信的地图是否可交接。
 * unknown 草稿允许保存，但缺范围确认或依据时不能进入完成、派发入口；覆盖变化返回 stale_map，
 * 让原部长基于 previousRef 保存替代版本。加载、路径与摘要损坏不在这里转成可补正错误。
 */
export function assertDispatchMapHandoff(
	artifact: DispatchMapArtifact | undefined,
	input: DispatchMapHandoffCheck,
): void {
	const label = input.stage === "complete" ? "完成交接" : "派发交接";
	const refDetails = input.ref ? { ref: input.ref } : {};
	const nodeDetails = input.node ? { node: input.node } : {};
	if (!artifact) {
		if (!input.required) return;
		throw new DispatchBriefError("missing_input", `${label}缺少节点地图`, {
			kind: "workflow-map-handoff",
			stage: input.stage,
			...refDetails,
			...nodeDetails,
			missing: ["map"],
		});
	}
	const basis = artifact.scopeBasis?.map((item) => item.trim()).filter(Boolean);
	const missing = [
		...(artifact.status !== "valid" ? ["valid_map"] : []),
		...(!artifact.scopeConfirmed ? ["scope_confirmed"] : []),
		...(artifact.scopeReviewRequired ? ["scope_review_not_required"] : []),
		...(basis?.length ? [] : ["scope_basis"]),
	];
	if (missing.length > 0) {
		throw new DispatchBriefError("missing_input", `${label}的地图缺少有效范围确认`, {
			kind: "workflow-map-handoff",
			stage: input.stage,
			...refDetails,
			...nodeDetails,
			missing,
			...(basis?.length ? { basis } : {}),
		});
	}
	const current = recaptureDispatchMap(artifact, {
		projectRoot: artifact.projectRoot,
		executionRoot: artifact.repositoryRoot,
	});
	if (!sameDispatchMapCoverage(artifact, current)) {
		throw new DispatchBriefError("stale_map", `${label}的地图覆盖内容已变化`, {
			kind: "workflow-map-handoff",
			stage: input.stage,
			...refDetails,
			...nodeDetails,
		});
	}
}

export function sameRepositoryPath(left: string, right: string): boolean {
	return (
		pathKey(left.replaceAll("\\", "/").replace(/\/+$/, "")) ===
		pathKey(right.replaceAll("\\", "/").replace(/\/+$/, ""))
	);
}

export function mapRefFor(artifact: DispatchMapArtifact): string {
	return mapUri(artifact.id, artifact.mapDigest, artifact.status);
}

export function captureFileDigest(path: string): string {
	return sha256Bytes(readFileSync(path));
}

export function readGitIdentity(executionRoot: string): {
	repositoryRoot: string;
	commonGitDir: string;
	head: string;
	treeId: string;
} {
	const identity = tryReadGitIdentity(executionRoot);
	if (!identity.ok) {
		throw new DispatchBriefError("missing_input", `Git 身份不可读取：${identity.reason}`, {
			path: executionRoot,
		});
	}
	return {
		repositoryRoot: identity.repositoryRoot,
		commonGitDir: identity.commonGitDir,
		head: identity.head,
		treeId: identity.treeId,
	};
}

export function recaptureDispatchMap(
	saved: DispatchMapArtifact,
	current: Pick<DispatchBriefInput, "projectRoot" | "executionRoot">,
): DispatchMapArtifact {
	return captureDispatchMap({
		id: saved.id,
		projectRoot: current.projectRoot,
		executionRoot: current.executionRoot,
		coverage: saved.coverage.paths,
		excludes: saved.coverage.excludes,
		facts: saved.facts,
		unknowns: saved.unknowns,
		relations: saved.relations,
		risks: saved.risks,
		...(saved.integrationOwner ? { integrationOwner: saved.integrationOwner } : {}),
		scopeConfirmed: saved.scopeConfirmed,
		scopeBasis: saved.scopeBasis,
		scopeReviewRequired: saved.scopeReviewRequired,
		capturedAt: saved.capturedAt,
	});
}
