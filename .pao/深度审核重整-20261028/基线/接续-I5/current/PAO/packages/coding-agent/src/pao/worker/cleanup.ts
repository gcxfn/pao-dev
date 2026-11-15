/**
 * 删除任务的两阶段预演与 owner 确认。
 *
 * 删除目标只认卡正文固定段「## 删除目标」中的反引号路径。相对路径以项目根解析，
 * 明确写出的绝对路径直接采用。目录递归展开到普通文件叶子，但不跟随任何 symlink/junction。
 * 预演只读文件元数据，不读取文件内容；确认由 owner 专用工具写入受控 sidecar。
 * 本模块只解除共享派发门禁，不提供删除执行器。
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { type BigIntStats, existsSync, lstatSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { type Static, Type } from "typebox";

import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { projectRootForCards, scanCards } from "../cards/cardfile.ts";
import { formatCardNumber, parseCardRef } from "../cards/counter.ts";
import { PaoCardError } from "../cards/errors.ts";
import { runCardProcess } from "../cards/process.ts";
import { checkWriterAuthority } from "../cards/statemachine.ts";
import type { ParsedCard } from "../cards/types.ts";
import { writeFileAtomic } from "../shared/atomic.ts";
import { readJsonRaw } from "../shared/json.ts";
import { pathKey } from "../shared/path-key.ts";
import { utcNow } from "../shared/time.ts";

export const CLEANUP_DECLARATION_HEADING = "## 删除目标";
export const CLEANUP_SIDECAR_VERSION = 1;
// 进程内封印只证明确认由本模块的 owner 工具写入；重启后旧确认会失效并要求重新确认。
const CONFIRMATION_SEAL_KEY = randomBytes(32);

export interface CleanupDeclarationTarget {
	/** 卡上原样写的目标。 */
	declaredPath: string;
	/** 相对路径使用 `/`；绝对路径已规范化。 */
	normalizedPath: string;
	absolute: boolean;
}

export interface CleanupDeclaration {
	/** 固定段原文；作为确认所绑定的声明身份。 */
	raw: string;
	/** 段身份摘要，不是目标文件内容摘要。 */
	hash: string;
	targets: CleanupDeclarationTarget[];
}

export type CleanupRiskCode =
	| "TARGET_MISSING"
	| "TARGET_PROTECTED"
	| "GIT_DIR_PROTECTED"
	| "SYMLINK_OR_JUNCTION"
	| "UNSUPPORTED_FILE_TYPE"
	| "TRACKED_FILE_MISSING";

export interface CleanupRisk {
	code: CleanupRiskCode;
	path: string;
	message: string;
}

export interface CleanupMetadata {
	type: "file" | "directory";
	size: string;
	mtimeNs: string;
	ctimeNs: string;
	birthtimeNs: string;
	ino: string;
	dev: string;
	mode: string;
}

export interface CleanupFileRecord extends CleanupMetadata {
	/** 真实绝对路径。 */
	path: string;
	realPath: string;
	gitTracked: boolean;
}

export interface CleanupDirectoryRecord extends CleanupMetadata {
	/** 真实绝对路径。 */
	path: string;
	realPath: string;
}

export interface CleanupTargetRecord {
	declaredPath: string;
	normalizedPath: string;
	/** 相对目标以项目根解析；绝对目标原样采用。这里记录真实绝对路径。 */
	absolutePath: string;
	realPath?: string;
	kind?: "file" | "directory";
	metadata?: CleanupMetadata;
	files: CleanupFileRecord[];
	directories: CleanupDirectoryRecord[];
	gitAvailable: boolean;
	gitRepositoryRoot?: string;
	gitUnverifiedReason?: string;
	/** 相对于所属仓库根的跟踪文件，完整保留，不只列与叶子文件交集。 */
	gitTrackedFiles: string[];
}

export interface CleanupGitRepository {
	repositoryRoot: string;
	/** 本仓覆盖到的声明目标，保留卡面原文。 */
	targets: string[];
	/** 与声明目标一一对应的规范绝对路径，用于可靠归组。 */
	targetAbsolutePaths: string[];
	/** 相对于仓库根的完整跟踪文件清单。 */
	trackedFiles: string[];
	/** 跟踪清单中在工作树里已不存在的文件。 */
	missingFiles: string[];
}

export interface CleanupGitInventory {
	available: boolean;
	repositories: CleanupGitRepository[];
	unverifiedTargets: { target: string; reason: string }[];
}

export interface CleanupSnapshot {
	projectRoot: string;
	cardPath: string;
	cardNo: string;
	cardOwner?: string;
	declaration: CleanupDeclaration;
	targets: CleanupTargetRecord[];
	git: CleanupGitInventory;
	protectedPaths: {
		cardDir: string;
		sidecarDir: string;
		evidenceDir: string;
	};
	risks: CleanupRisk[];
}

export interface CleanupPreviewFile {
	版本: 1;
	卡号: string;
	卡路径: string;
	预演人: string;
	预演时间: string;
	快照: CleanupSnapshot;
	快照摘要: string;
}

export interface CleanupConfirmationFile {
	版本: 1;
	卡号: string;
	卡路径: string;
	确认人: string;
	确认时间: string;
	预演路径: string;
	预演摘要: string;
	绑定摘要: string;
}

export type CleanupDispatchGate = { ok: true } | { ok: false; reason: string };

export interface PreviewCleanupOptions {
	operator?: string;
	signal?: AbortSignal;
}

export interface ConfirmCleanupOptions {
	operator: string;
	confirm: boolean;
	signal?: AbortSignal;
}

export interface RegisterCleanupToolsOptions {
	resolveCardsDir: () => string;
}

function cleanupError(message: string, details: Record<string, unknown> = {}): PaoCardError {
	return new PaoCardError("INVALID_CARD", message, details);
}

function findCleanupCard(cardsDir: string, cardRef: string): ParsedCard {
	const cardNo = parseCardRef(cardRef);
	const { cards, problems } = scanCards(cardsDir);
	const card = cards.find((candidate) => candidate.card_no === cardNo);
	if (card) return card;
	const unreadable = problems.length
		? `；另有 ${problems.length} 张卡读不出来：${problems.map((item) => `${item.path}（${item.reason}）`).join("；")}`
		: "";
	throw new PaoCardError("CARD_NOT_FOUND", `卡目录 ${cardsDir} 中找不到卡${cardRef}${unreadable}`, {
		card_ref: cardRef,
		cardsDir,
	});
}

function isExplicitAbsolutePath(value: string): boolean {
	return isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
}

function normalizeDeclaredTarget(value: string): CleanupDeclarationTarget {
	const trimmed = value.trim();
	if (!trimmed) throw cleanupError("「删除目标」中的路径不能为空");
	if (/[*?[\]{}]/.test(trimmed)) throw cleanupError(`删除目标不支持通配符：${value}`);
	if (trimmed.startsWith("~")) throw cleanupError(`删除目标不要使用 ~；请写明真实绝对路径：${value}`);

	const absolute = isExplicitAbsolutePath(trimmed);
	const segments = trimmed.replaceAll("\\", "/").split("/");
	if (segments.some((segment) => segment === "." || segment === ".."))
		throw cleanupError(`删除目标不能包含 . 或 .. 路径段：${value}`);
	if (absolute) return { declaredPath: trimmed, normalizedPath: resolve(trimmed), absolute: true };
	const normalizedPath = segments.filter(Boolean).join("/");
	if (!normalizedPath) throw cleanupError("「删除目标」中的项目相对路径不能为空");
	return { declaredPath: trimmed, normalizedPath, absolute: false };
}

/**
 * 解析固定删除声明段。没有任何该段＝普通任务；该段出现即必须完整合法。
 * 同卡出现两个同名段拒绝，避免机器无法判断哪段才是许可来源。
 */
export function parseCleanupDeclaration(body: string): CleanupDeclaration | undefined {
	const lines = body.split(/\r?\n/);
	const headingLines: number[] = [];
	for (let index = 0; index < lines.length; index++)
		if (lines[index]?.trim() === CLEANUP_DECLARATION_HEADING) headingLines.push(index);
	if (headingLines.length === 0) return undefined;
	if (headingLines.length > 1)
		throw cleanupError(
			`卡正文出现 ${headingLines.length} 个「${CLEANUP_DECLARATION_HEADING}」段；删除声明只能有一段`,
		);

	const start = headingLines[0]!;
	let end = lines.length;
	for (let index = start + 1; index < lines.length; index++)
		if (/^#{1,6}\s+\S/.test(lines[index] ?? "")) {
			end = index;
			break;
		}
	const sectionLines = lines.slice(start, end);
	const targets: CleanupDeclarationTarget[] = [];
	const seen = new Set<string>();
	for (let index = start + 1; index < end; index++) {
		const line = lines[index] ?? "";
		if (!line.trim()) continue;
		const match = /^\s*-\s+`([^`]+)`\s*$/.exec(line);
		if (!match)
			throw cleanupError(
				`「${CLEANUP_DECLARATION_HEADING}」只接受逐行列表项 \`- \`项目相对路径或明确绝对路径\`\`；问题行：${line}`,
				{ line: index + 1 },
			);
		const target = normalizeDeclaredTarget(match[1]!);
		const key = pathKey(target.normalizedPath);
		if (seen.has(key)) throw cleanupError(`「删除目标」重复声明：${target.declaredPath}`);
		seen.add(key);
		targets.push(target);
	}
	if (targets.length === 0)
		throw cleanupError(
			`「${CLEANUP_DECLARATION_HEADING}」为空；请逐行写 \`- \`项目相对路径或明确绝对路径\`\`，零个目标不构成删除任务`,
		);
	const raw = sectionLines.join("\n").trimEnd();
	return {
		raw,
		hash: createHash("sha256").update(raw, "utf8").digest("hex"),
		targets,
	};
}

export function cleanupDirForCards(cardsDir: string, cardNo: number | string): string {
	return join(dirname(resolve(cardsDir)), "cleanup", formatCardNumber(Number(cardNo)));
}

export function cleanupPreviewPath(cardsDir: string, cardNo: number | string): string {
	return join(cleanupDirForCards(cardsDir, cardNo), "cleanup-preview.json");
}

export function cleanupConfirmationPath(cardsDir: string, cardNo: number | string): string {
	return join(cleanupDirForCards(cardsDir, cardNo), "cleanup-confirmation.json");
}

export function workerEvidenceDirForCards(cardsDir: string): string {
	return join(dirname(resolve(cardsDir)), "worker-evidence");
}

function metadataOf(stat: BigIntStats, type: "file" | "directory"): CleanupMetadata {
	return {
		type,
		size: stat.size.toString(),
		mtimeNs: stat.mtimeNs.toString(),
		ctimeNs: stat.ctimeNs.toString(),
		birthtimeNs: stat.birthtimeNs.toString(),
		ino: stat.ino.toString(),
		dev: stat.dev.toString(),
		mode: stat.mode.toString(),
	};
}

function lstatIfPresent(filePath: string): BigIntStats | undefined {
	return lstatSync(filePath, { bigint: true, throwIfNoEntry: false });
}

function normalizedAbsoluteKey(filePath: string): string {
	return pathKey(resolve(filePath)).replace(/[\\/]+$/, "");
}

function sameOrAncestor(left: string, right: string): boolean {
	const a = normalizedAbsoluteKey(left);
	const b = normalizedAbsoluteKey(right);
	return a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
}

function isWithin(root: string, candidate: string): boolean {
	const rel = relative(resolve(root), resolve(candidate));
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function targetAbsolutePath(projectRoot: string, target: CleanupDeclarationTarget): string {
	return target.absolute ? resolve(target.normalizedPath) : resolve(projectRoot, ...target.normalizedPath.split("/"));
}

/**
 * 检查目标路径的每个现存段；任何一段是 symlink/junction 都拒绝。
 * 相对目标还必须留在项目根内；显式绝对目标不套项目根限制。
 */
function inspectPathSegments(
	projectRoot: string,
	target: CleanupDeclarationTarget,
): {
	absolutePath: string;
	realPath?: string;
	stat?: BigIntStats;
	risk?: CleanupRisk;
} {
	const absolutePath = targetAbsolutePath(projectRoot, target);
	if (!target.absolute && !isWithin(projectRoot, absolutePath))
		throw cleanupError(`项目相对删除目标越出项目根：${target.declaredPath}`, { projectRoot, absolutePath });
	if (hasGitPathSegment(absolutePath))
		return {
			absolutePath,
			risk: {
				code: "GIT_DIR_PROTECTED",
				path: absolutePath,
				message: `目标位于 Git 元数据目录内，拒绝删除：${absolutePath}`,
			},
		};

	const parsed = parse(absolutePath);
	let current = parsed.root;
	for (const segment of absolutePath
		.slice(parsed.root.length)
		.split(/[\\/]+/)
		.filter(Boolean)) {
		current = join(current, segment);
		const stat = lstatIfPresent(current);
		if (!stat) break;
		if (stat.isSymbolicLink())
			return {
				absolutePath,
				risk: {
					code: "SYMLINK_OR_JUNCTION",
					path: current,
					message: `检测到 symlink/junction，拒绝跟随：${current}`,
				},
			};
	}

	const stat = lstatIfPresent(absolutePath);
	if (!stat)
		return {
			absolutePath,
			risk: {
				code: "TARGET_MISSING",
				path: absolutePath,
				message: `目标不存在：${absolutePath}`,
			},
		};
	return { absolutePath, realPath: realpathSync.native(absolutePath), stat };
}

function protectedOverlap(absolutePath: string, protectedPaths: CleanupSnapshot["protectedPaths"]): string | undefined {
	for (const [name, protectedPath] of Object.entries(protectedPaths))
		if (sameOrAncestor(absolutePath, protectedPath)) return name;
	return undefined;
}

function hasGitPathSegment(filePath: string): boolean {
	return filePath
		.split(/[\\/]+/)
		.filter(Boolean)
		.some((segment) => segment.toLowerCase() === ".git");
}

function walkTarget(
	absolutePath: string,
	type: "file" | "directory",
	files: CleanupFileRecord[],
	directories: CleanupDirectoryRecord[],
	risks: CleanupRisk[],
): void {
	const stat = lstatIfPresent(absolutePath);
	if (!stat) {
		risks.push({
			code: "TARGET_MISSING",
			path: absolutePath,
			message: `目标在扫描时不存在：${absolutePath}`,
		});
		return;
	}
	if (stat.isSymbolicLink()) {
		risks.push({
			code: "SYMLINK_OR_JUNCTION",
			path: absolutePath,
			message: `检测到 symlink/junction，拒绝跟随：${absolutePath}`,
		});
		return;
	}
	if (type === "file") {
		if (!stat.isFile()) {
			risks.push({
				code: "UNSUPPORTED_FILE_TYPE",
				path: absolutePath,
				message: `目标不是普通文件或目录：${absolutePath}`,
			});
			return;
		}
		files.push({
			path: absolutePath,
			realPath: realpathSync.native(absolutePath),
			...metadataOf(stat, "file"),
			gitTracked: false,
		});
		return;
	}
	if (!stat.isDirectory()) {
		risks.push({
			code: "UNSUPPORTED_FILE_TYPE",
			path: absolutePath,
			message: `目标不是普通文件或目录：${absolutePath}`,
		});
		return;
	}
	directories.push({
		path: absolutePath,
		realPath: realpathSync.native(absolutePath),
		...metadataOf(stat, "directory"),
	});
	const children = readdirSync(absolutePath, { withFileTypes: true }).sort((a, b) =>
		a.name.localeCompare(b.name, "zh-CN"),
	);
	for (const child of children) {
		const childPath = join(absolutePath, child.name);
		if (child.name.toLowerCase() === ".git") {
			risks.push({
				code: "GIT_DIR_PROTECTED",
				path: childPath,
				message: `目标包含 Git 元数据，拒绝整目录删除：${childPath}`,
			});
			continue;
		}
		const childStat = lstatIfPresent(childPath);
		if (!childStat) continue;
		if (childStat.isSymbolicLink()) {
			risks.push({
				code: "SYMLINK_OR_JUNCTION",
				path: childPath,
				message: `检测到 symlink/junction，拒绝跟随：${childPath}`,
			});
			continue;
		}
		if (childStat.isDirectory()) walkTarget(childPath, "directory", files, directories, risks);
		else if (childStat.isFile()) walkTarget(childPath, "file", files, directories, risks);
		else
			risks.push({
				code: "UNSUPPORTED_FILE_TYPE",
				path: childPath,
				message: `遇到不是普通文件或目录的条目，拒绝处理：${childPath}`,
			});
	}
}

function nearestExistingDirectory(filePath: string): string | undefined {
	let current = filePath;
	for (;;) {
		const stat = lstatIfPresent(current);
		if (stat?.isDirectory()) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function repositoryRelative(repositoryRoot: string, absolutePath: string): string {
	const rel = relative(repositoryRoot, absolutePath);
	return rel ? rel.replaceAll("\\", "/") : ".";
}

interface GitCandidate {
	target: CleanupDeclarationTarget;
	absolutePath: string;
	kind?: "file" | "directory";
}

interface DiscoveredGitCandidate extends GitCandidate {
	repositoryRoot?: string;
	reason?: string;
}

/**
 * 从每个目标自身位置向上找 Git 仓库；同一实际仓库只执行一次 ls-files。
 * 找不到 Git 的目标明确记为未核查，不拿项目根的 Git 结果冒充。
 */
async function gitInventoryForTargets(
	projectRoot: string,
	targets: GitCandidate[],
	signal?: AbortSignal,
): Promise<CleanupGitInventory> {
	const discovered: DiscoveredGitCandidate[] = await Promise.all(
		targets.map(async (entry) => {
			signal?.throwIfAborted();
			const workDir =
				entry.kind === "directory" ? entry.absolutePath : nearestExistingDirectory(dirname(entry.absolutePath));
			if (!workDir)
				return {
					...entry,
					repositoryRoot: undefined,
					reason: `未核查：目标没有可用的现存父目录（${entry.absolutePath}）`,
				};
			const top = await runCardProcess(
				"git",
				["-C", workDir, "-c", "core.quotepath=off", "rev-parse", "--show-toplevel"],
				projectRoot,
				30_000,
				undefined,
				signal,
			);
			if (top.code !== 0)
				return {
					...entry,
					repositoryRoot: undefined,
					reason: `未核查：目标不属于可用 Git 仓库（${(top.stderr || top.stdout).trim() || `exit ${top.code}`}）`,
				};
			return { ...entry, repositoryRoot: realpathSync.native(top.stdout.trim()), reason: undefined };
		}),
	);

	const groups = new Map<string, { repositoryRoot: string; entries: DiscoveredGitCandidate[] }>();
	const unverifiedTargets: CleanupGitInventory["unverifiedTargets"] = [];
	for (const entry of discovered) {
		if (!entry.repositoryRoot) {
			unverifiedTargets.push({
				target: entry.target.declaredPath,
				reason: entry.reason ?? "未核查：目标不属于可用 Git 仓库",
			});
			continue;
		}
		const key = normalizedAbsoluteKey(entry.repositoryRoot);
		const group = groups.get(key) ?? { repositoryRoot: entry.repositoryRoot, entries: [] };
		group.entries.push(entry);
		groups.set(key, group);
	}

	const repositories: CleanupGitRepository[] = [];
	for (const group of groups.values()) {
		signal?.throwIfAborted();
		const pathspecs = group.entries.map((entry) => repositoryRelative(group.repositoryRoot, entry.absolutePath));
		const listed = await runCardProcess(
			"git",
			[
				"-C",
				group.repositoryRoot,
				"-c",
				"core.quotepath=off",
				"--literal-pathspecs",
				"ls-files",
				"-z",
				"--",
				...pathspecs,
			],
			projectRoot,
			30_000,
			undefined,
			signal,
		);
		if (listed.code !== 0) {
			for (const entry of group.entries)
				unverifiedTargets.push({
					target: entry.target.declaredPath,
					reason: `未核查：git ls-files 失败（${(listed.stderr || listed.stdout).trim() || `exit ${listed.code}`}）`,
				});
			continue;
		}
		const trackedFiles = listed.stdout
			.split("\0")
			.filter(Boolean)
			.sort((a, b) => a.localeCompare(b, "zh-CN"));
		const missingFiles = trackedFiles.filter(
			(file) => !existsSync(resolve(group.repositoryRoot, ...file.split("/"))),
		);
		repositories.push({
			repositoryRoot: group.repositoryRoot,
			targets: group.entries.map((entry) => entry.target.declaredPath),
			targetAbsolutePaths: group.entries.map((entry) => entry.absolutePath),
			trackedFiles,
			missingFiles,
		});
	}
	repositories.sort((a, b) => a.repositoryRoot.localeCompare(b.repositoryRoot, "zh-CN"));
	return {
		available: repositories.length > 0,
		repositories,
		unverifiedTargets,
	};
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (typeof value !== "object" || value === null) return value;
	const source = value as Record<string, unknown>;
	return Object.fromEntries(
		Object.keys(source)
			.sort()
			.map((key) => [key, stableValue(source[key])]),
	);
}

export function cleanupSnapshotDigest(snapshot: CleanupSnapshot): string {
	return createHash("sha256")
		.update(JSON.stringify(stableValue(snapshot)), "utf8")
		.digest("hex");
}

async function buildCleanupSnapshot(
	card: ParsedCard,
	cardsDir: string,
	declaration: CleanupDeclaration,
	signal?: AbortSignal,
): Promise<CleanupSnapshot> {
	const projectRoot = projectRootForCards(cardsDir);
	const protectedPaths = {
		cardDir: realpathSync.native(cardsDir),
		sidecarDir: join(dirname(resolve(cardsDir)), "cleanup"),
		evidenceDir: workerEvidenceDirForCards(cardsDir),
	};
	const risks: CleanupRisk[] = [];
	const targets: CleanupTargetRecord[] = [];
	const gitCandidates: GitCandidate[] = [];

	for (const target of declaration.targets) {
		signal?.throwIfAborted();
		const inspected = inspectPathSegments(projectRoot, target);
		const record: CleanupTargetRecord = {
			declaredPath: target.declaredPath,
			normalizedPath: target.normalizedPath,
			absolutePath: inspected.absolutePath,
			...(inspected.realPath ? { realPath: inspected.realPath } : {}),
			files: [],
			directories: [],
			gitAvailable: false,
			gitTrackedFiles: [],
		};
		const protectedName = protectedOverlap(inspected.absolutePath, protectedPaths);
		if (protectedName) {
			const message =
				`目标 ${target.declaredPath} 与受保护路径「${protectedName}」重叠；` +
				"目标不能是卡目录、cleanup sidecar、worker-evidence 的本体、祖先或后代";
			risks.push({ code: "TARGET_PROTECTED", path: inspected.absolutePath, message });
			targets.push(record);
			continue;
		}
		if (hasGitPathSegment(inspected.absolutePath)) {
			risks.push({
				code: "GIT_DIR_PROTECTED",
				path: inspected.absolutePath,
				message: `目标位于 Git 元数据目录内，拒绝删除：${inspected.absolutePath}`,
			});
			targets.push(record);
			continue;
		}
		if (inspected.risk) {
			risks.push(inspected.risk);
			if (inspected.stat?.isFile()) record.kind = "file";
			if (inspected.stat?.isDirectory()) record.kind = "directory";
			if (record.kind) record.metadata = metadataOf(inspected.stat!, record.kind);
			gitCandidates.push({
				target,
				absolutePath: inspected.absolutePath,
				...(record.kind ? { kind: record.kind } : {}),
			});
			targets.push(record);
			continue;
		}
		if (inspected.stat!.isFile()) record.kind = "file";
		else if (inspected.stat!.isDirectory()) record.kind = "directory";
		if (!record.kind) {
			risks.push({
				code: "UNSUPPORTED_FILE_TYPE",
				path: inspected.absolutePath,
				message: `目标不是普通文件或目录：${inspected.absolutePath}`,
			});
			targets.push(record);
			continue;
		}
		record.metadata = metadataOf(inspected.stat!, record.kind);
		walkTarget(inspected.absolutePath, record.kind, record.files, record.directories, risks);
		gitCandidates.push({ target, absolutePath: inspected.absolutePath, kind: record.kind });
		targets.push(record);
	}

	const git = await gitInventoryForTargets(projectRoot, gitCandidates, signal);
	const repositoryByTarget = new Map<string, CleanupGitRepository>();
	for (const repository of git.repositories)
		for (const targetAbsolute of repository.targetAbsolutePaths)
			repositoryByTarget.set(normalizedAbsoluteKey(targetAbsolute), repository);
	for (const target of targets) {
		const repository = repositoryByTarget.get(normalizedAbsoluteKey(target.absolutePath));
		target.gitAvailable = repository !== undefined;
		if (repository) {
			target.gitRepositoryRoot = repository.repositoryRoot;
			const repoRelative = repositoryRelative(repository.repositoryRoot, target.absolutePath);
			target.gitTrackedFiles = repository.trackedFiles.filter(
				(file) => repoRelative === "." || file === repoRelative || file.startsWith(`${repoRelative}/`),
			);
		} else {
			target.gitUnverifiedReason =
				git.unverifiedTargets.find((item) => pathKey(item.target) === pathKey(target.declaredPath))?.reason ??
				"未核查：目标不属于可用 Git 仓库";
		}
		const tracked = new Set(target.gitTrackedFiles);
		for (const file of target.files) {
			const rel = repository ? repositoryRelative(repository.repositoryRoot, file.path) : undefined;
			file.gitTracked = rel !== undefined && tracked.has(rel);
		}
	}
	for (const repository of git.repositories)
		for (const file of repository.missingFiles) {
			const absolute = join(repository.repositoryRoot, ...file.split("/"));
			risks.push({
				code: "TRACKED_FILE_MISSING",
				path: absolute,
				message: `Git 跟踪文件在工作树中缺失：${absolute}`,
			});
		}

	return {
		projectRoot,
		cardPath: resolve(card.path),
		cardNo: String(card.card_no).padStart(4, "0"),
		...(card.frontmatter.owner !== undefined ? { cardOwner: card.frontmatter.owner } : {}),
		declaration,
		targets,
		git,
		protectedPaths,
		risks,
	};
}

function previewFileFor(snapshot: CleanupSnapshot, operator: string | undefined): CleanupPreviewFile {
	return {
		版本: CLEANUP_SIDECAR_VERSION,
		卡号: snapshot.cardNo,
		卡路径: snapshot.cardPath,
		预演人: operator?.trim() || "未署身份",
		预演时间: utcNow(),
		快照: snapshot,
		快照摘要: cleanupSnapshotDigest(snapshot),
	};
}

function renderPreview(preview: CleanupPreviewFile, previewPath: string): string {
	const snapshot = preview.快照;
	const lines = [
		`删除预演：卡${preview.卡号}，${snapshot.targets.length} 个显式目标`,
		`项目根：${snapshot.projectRoot}`,
		`预演摘要：${preview.快照摘要}`,
		`预演文件：${previewPath}`,
	];
	for (const target of snapshot.targets) {
		lines.push(
			`目标：${target.declaredPath} -> ${target.absolutePath}` +
				`（${target.kind ?? "未知"}，叶子文件 ${target.files.length} 个，目录 ${target.directories.length} 个）`,
		);
		for (const file of target.files)
			lines.push(
				`  文件：${file.path}（size=${file.size}，mtimeNs=${file.mtimeNs}，ctimeNs=${file.ctimeNs}，ino=${file.ino}，Git ${
					!target.gitAvailable ? "未核查" : file.gitTracked ? "已跟踪" : "未跟踪"
				}）`,
			);
	}
	for (const repository of snapshot.git.repositories) {
		lines.push(
			`Git 仓库：${repository.repositoryRoot}（目标：${repository.targets.join("、")}；跟踪文件 ${repository.trackedFiles.length} 个）`,
		);
		for (const file of repository.trackedFiles) lines.push(`  ${file}`);
	}
	for (const item of snapshot.git.unverifiedTargets) lines.push(`目标 ${item.target}：${item.reason}`);
	if (snapshot.risks.length > 0) {
		lines.push(`风险 ${snapshot.risks.length} 条（有风险时不能确认）：`);
		for (const risk of snapshot.risks) lines.push(`  [${risk.code}] ${risk.message}`);
	} else {
		lines.push("风险：无。请 owner 核对后调用 pao_confirm_cleanup（confirm=true）。");
	}
	return lines.join("\n");
}

export async function previewCleanup(
	cardsDir: string,
	cardRef: string,
	options: PreviewCleanupOptions = {},
): Promise<{ card: ParsedCard; preview: CleanupPreviewFile; path: string; text: string }> {
	options.signal?.throwIfAborted();
	const card = findCleanupCard(cardsDir, cardRef);
	const declaration = parseCleanupDeclaration(card.body);
	if (!declaration)
		throw cleanupError(
			`卡${formatCardNumber(card.card_no)} 没有「${CLEANUP_DECLARATION_HEADING}」段；只有该固定段会触发删除预演，普通任务不需要预演`,
		);
	const snapshot = await buildCleanupSnapshot(card, cardsDir, declaration, options.signal);
	const preview = previewFileFor(snapshot, options.operator);
	const path = cleanupPreviewPath(cardsDir, card.card_no);
	writeFileAtomic(path, `${JSON.stringify(preview, null, "\t")}\n`);
	const confirmation = cleanupConfirmationPath(cardsDir, card.card_no);
	if (existsSync(confirmation)) unlinkSync(confirmation);
	return { card, preview, path, text: renderPreview(preview, path) };
}

function readPreview(filePath: string): CleanupPreviewFile {
	if (!existsSync(filePath)) throw cleanupError(`没有有效预演：${filePath}；请先调用 pao_preview_cleanup`);
	let raw: unknown;
	try {
		raw = readJsonRaw(filePath);
	} catch (error) {
		throw cleanupError(
			`清理预演文件损坏，不能作为确认依据：${filePath}（${error instanceof Error ? error.message : String(error)}）`,
		);
	}
	if (typeof raw !== "object" || raw === null || (raw as { 版本?: unknown }).版本 !== CLEANUP_SIDECAR_VERSION)
		throw cleanupError(`清理预演文件版本或结构无效，不能作为确认依据：${filePath}`);
	const preview = raw as CleanupPreviewFile;
	if (
		!preview.快照 ||
		typeof preview.快照摘要 !== "string" ||
		!Array.isArray(preview.快照.targets) ||
		!Array.isArray(preview.快照.risks)
	)
		throw cleanupError(`清理预演文件结构无效，不能作为确认依据：${filePath}`);
	return preview;
}

function validateConfirmationOwner(card: ParsedCard, operator: string): string {
	const owner = card.frontmatter.owner?.trim();
	if (!owner)
		throw new PaoCardError(
			"FORBIDDEN_WRITER",
			"删除确认被拒：卡上没有明确 owner。请 owner 先在建卡/指派时写入卡 owner；不会由确认工具自动认领",
			{ 卡号: card.card_no },
		);
	if (card.frontmatter.status !== "unclaimed" && card.frontmatter.status !== "failed")
		throw new PaoCardError(
			"INVALID_TRANSITION",
			`删除确认被拒：当前状态 ${card.frontmatter.status}；确认只允许在 unclaimed 或 failed（待派发）阶段进行`,
			{ 卡号: card.card_no, 状态: card.frontmatter.status },
		);
	const normalizedOperator = operator.trim();
	if (!normalizedOperator) throw new PaoCardError("FORBIDDEN_WRITER", "删除确认被拒：operator 不能为空");
	// 待认领卡已有 owner 时，这会要求调用者与 owner 相同；不会写 owner，也不会替人认领。
	checkWriterAuthority(card.frontmatter, normalizedOperator, "in_progress");
	return owner;
}

function confirmationBindingDigest(confirmation: Omit<CleanupConfirmationFile, "绑定摘要">): string {
	return createHmac("sha256", CONFIRMATION_SEAL_KEY)
		.update(JSON.stringify(stableValue(confirmation)), "utf8")
		.digest("hex");
}

function confirmationSealMatches(expected: string, actual: unknown): boolean {
	if (typeof actual !== "string") return false;
	const expectedBytes = Buffer.from(expected, "hex");
	const actualBytes = Buffer.from(actual, "hex");
	return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

export async function confirmCleanup(
	cardsDir: string,
	cardRef: string,
	options: ConfirmCleanupOptions,
): Promise<{ card: ParsedCard; confirmation: CleanupConfirmationFile; path: string; text: string }> {
	options.signal?.throwIfAborted();
	const card = findCleanupCard(cardsDir, cardRef);
	const declaration = parseCleanupDeclaration(card.body);
	if (!declaration) throw cleanupError(`卡${card.card_no} 没有「${CLEANUP_DECLARATION_HEADING}」段，不能确认删除`);
	if (options.confirm !== true) throw cleanupError("删除确认被拒：必须显式传 confirm=true；预演本身不是删除授权");
	const owner = validateConfirmationOwner(card, options.operator);
	const previewPath = cleanupPreviewPath(cardsDir, card.card_no);
	const preview = readPreview(previewPath);
	const expectedCardPath = resolve(card.path);
	const expectedCardNo = String(card.card_no).padStart(4, "0");
	if (
		preview.卡号 !== expectedCardNo ||
		preview.卡路径 !== expectedCardPath ||
		preview.快照.cardNo !== expectedCardNo ||
		preview.快照.cardPath !== expectedCardPath
	)
		throw cleanupError(
			`预演绑定的卡身份与当前卡不一致：预演为 ${preview.卡号} ${preview.卡路径}，当前为 ${expectedCardNo} ${expectedCardPath}`,
		);
	if (preview.快照.cardOwner !== owner)
		throw cleanupError(
			`owner 已变化：预演时 ${preview.快照.cardOwner ?? "无 owner"}，当前 ${owner}；请 owner 重新预演`,
		);
	if (preview.快照.risks.length > 0)
		throw cleanupError(`预演仍有 ${preview.快照.risks.length} 条风险，不能确认；先修复目标并重新预演`);
	if (preview.快照摘要 !== cleanupSnapshotDigest(preview.快照))
		throw cleanupError("预演文件摘要与内容不一致（文件已被改动），请重新预演");
	const current = await buildCleanupSnapshot(card, cardsDir, declaration, options.signal);
	if (preview.快照摘要 !== cleanupSnapshotDigest(current))
		throw cleanupError("删除目标或文件元数据在预演后发生变化，旧预演已失效；请重新预演再确认");

	const unsigned: Omit<CleanupConfirmationFile, "绑定摘要"> = {
		版本: CLEANUP_SIDECAR_VERSION,
		卡号: expectedCardNo,
		卡路径: expectedCardPath,
		确认人: owner,
		确认时间: utcNow(),
		预演路径: previewPath,
		预演摘要: preview.快照摘要,
	};
	const confirmation: CleanupConfirmationFile = {
		...unsigned,
		绑定摘要: confirmationBindingDigest(unsigned),
	};
	const path = cleanupConfirmationPath(cardsDir, card.card_no);
	writeFileAtomic(path, `${JSON.stringify(confirmation, null, "\t")}\n`);
	return {
		card,
		confirmation,
		path,
		text: [
			`删除目标已由 owner「${owner}」确认：卡${confirmation.卡号}`,
			`绑定预演摘要：${confirmation.预演摘要}`,
			`确认文件：${path}`,
			"确认只解除派发门禁；本模块不执行删除。派发后目标再有变化会在共享门禁重新扫描时失效。",
		].join("\n"),
	};
}

function readConfirmation(filePath: string): CleanupConfirmationFile {
	if (!existsSync(filePath))
		throw cleanupError(`没有 owner 删除确认：${filePath}；请 owner 核对预演后调用 pao_confirm_cleanup`);
	let raw: unknown;
	try {
		raw = readJsonRaw(filePath);
	} catch (error) {
		throw cleanupError(
			`删除确认文件损坏，不能放行：${filePath}（${error instanceof Error ? error.message : String(error)}）`,
		);
	}
	if (typeof raw !== "object" || raw === null || (raw as { 版本?: unknown }).版本 !== CLEANUP_SIDECAR_VERSION)
		throw cleanupError(`删除确认文件版本或结构无效：${filePath}`);
	const confirmation = raw as CleanupConfirmationFile;
	const { 绑定摘要: binding, ...unsigned } = confirmation;
	if (!confirmationSealMatches(confirmationBindingDigest(unsigned), binding))
		throw cleanupError(`删除确认文件封印无效或内容被改动，不能放行：${filePath}`);
	return confirmation;
}

/**
 * 共享派发门禁。只有正文声明段存在时才执行；普通卡零影响。校验在认领与 worker 拉起前完成，
 * 失败原因给出下一条可执行操作。
 */
export async function checkCleanupReadyForDispatch(
	cardsDir: string,
	card: ParsedCard,
	signal?: AbortSignal,
): Promise<CleanupDispatchGate> {
	let declaration: CleanupDeclaration | undefined;
	try {
		declaration = parseCleanupDeclaration(card.body);
	} catch (error) {
		return {
			ok: false,
			reason: `删除任务声明无效：${error instanceof Error ? error.message : String(error)}。请修正「${CLEANUP_DECLARATION_HEADING}」后重新预演`,
		};
	}
	if (!declaration) return { ok: true };
	const owner = card.frontmatter.owner?.trim();
	if (!owner)
		return {
			ok: false,
			reason: `删除任务未派发：卡上没有明确 owner。先为卡指定 owner，再由该 owner 调用 pao_preview_cleanup 和 pao_confirm_cleanup；不会自动认领`,
		};
	const previewPath = cleanupPreviewPath(cardsDir, card.card_no);
	let preview: CleanupPreviewFile;
	try {
		preview = readPreview(previewPath);
	} catch (error) {
		return {
			ok: false,
			reason: `删除任务首次派发只做只读预演，不会启动 worker。${error instanceof Error ? error.message : String(error)}（参数：card_ref=${formatCardNumber(card.card_no)}，operator=${owner}）`,
		};
	}
	if (
		preview.卡号 !== String(card.card_no).padStart(4, "0") ||
		preview.卡路径 !== resolve(card.path) ||
		preview.快照.cardNo !== String(card.card_no).padStart(4, "0") ||
		preview.快照.cardPath !== resolve(card.path) ||
		preview.快照.cardOwner !== owner
	)
		return {
			ok: false,
			reason: "删除任务未派发：预演绑定的卡或 owner 与当前卡不一致；请 owner 重新预演并确认",
		};
	if (preview.快照.risks.length > 0)
		return {
			ok: false,
			reason: `删除任务未派发：预演仍有 ${preview.快照.risks.length} 条风险；修复后重新调用 pao_preview_cleanup`,
		};
	const confirmationPath = cleanupConfirmationPath(cardsDir, card.card_no);
	let confirmation: CleanupConfirmationFile;
	try {
		confirmation = readConfirmation(confirmationPath);
	} catch (error) {
		return {
			ok: false,
			reason: `删除任务未派发：${error instanceof Error ? error.message : String(error)}（参数：card_ref=${formatCardNumber(card.card_no)}，operator=${owner}，confirm=true）`,
		};
	}
	if (
		confirmation.卡号 !== preview.卡号 ||
		confirmation.卡路径 !== resolve(card.path) ||
		confirmation.确认人 !== owner ||
		confirmation.预演路径 !== previewPath
	)
		return {
			ok: false,
			reason: "删除任务未派发：确认身份、卡或预演路径与当前现场不一致；请 owner 重新预演并确认",
		};
	if (confirmation.预演摘要 !== preview.快照摘要)
		return {
			ok: false,
			reason: "删除任务未派发：确认绑定的预演摘要已变化；请重新预演，再由 owner 确认",
		};
	let current: CleanupSnapshot;
	try {
		current = await buildCleanupSnapshot(card, cardsDir, declaration, signal);
	} catch (error) {
		return {
			ok: false,
			reason: `删除任务安全检查失败，拒绝派发：${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (preview.快照摘要 !== cleanupSnapshotDigest(current))
		return {
			ok: false,
			reason: "删除任务未派发：删除目标或文件元数据在预演后已变化，旧确认失效；请 owner 重新预演并确认",
		};
	return { ok: true };
}

const PreviewParams = Type.Object({
	card_ref: Type.String({ description: "卡引用（卡0017、卡#17 或 17）" }),
	operator: Type.Optional(Type.String({ description: "预演人；不改变卡状态，不构成删除授权" })),
	cards_dir: Type.Optional(Type.String({ description: "卡目录；已配置默认卡目录时可省略" })),
});

const ConfirmParams = Type.Object({
	card_ref: Type.String({ description: "卡引用（卡0017、卡#17 或 17）" }),
	operator: Type.String({ description: "当前 owner 身份；须与卡 frontmatter 的 owner 一致" }),
	confirm: Type.Boolean({ description: "显式确认，必须为 true；预演本身不是删除授权" }),
	cards_dir: Type.Optional(Type.String({ description: "卡目录；已配置默认卡目录时可省略" })),
});

function toolError(text: string): {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
	isError: true;
} {
	return { content: [{ type: "text", text }], details: {}, isError: true };
}

/**
 * 注册 owner 侧删除预演/确认工具。调用方必须在非 worker 角色装配；worker 角色应整模块跳过。
 * 本模块不提供删除执行工具。
 */
export function registerCleanupTools(pi: ExtensionAPI, options: RegisterCleanupToolsOptions): void {
	pi.registerTool({
		name: "pao_preview_cleanup",
		label: "删除预演",
		description:
			"只读展开卡正文「## 删除目标」中的显式相对或绝对路径，列出真实绝对叶子文件、元数据和各目标所属 Git 仓库的跟踪清单；遇到 symlink/junction、受保护路径或任意 .git 即报风险。预演写入卡目录上一级 cleanup/卡NNNN，不改卡、不执行删除。",
		parameters: PreviewParams,
		execute: async (_toolCallId, params: Static<typeof PreviewParams>, signal) => {
			try {
				const cardsDir = params.cards_dir ?? options.resolveCardsDir();
				const result = await previewCleanup(cardsDir, params.card_ref, { operator: params.operator, signal });
				return { content: [{ type: "text", text: result.text }], details: { preview_path: result.path } };
			} catch (error) {
				return toolError(`删除预演未完成：${error instanceof Error ? error.message : String(error)}`);
			}
		},
	});
	pi.registerTool({
		name: "pao_confirm_cleanup",
		label: "确认删除目标",
		description:
			"owner 专用删除确认：要求卡已有明确 owner 且可待认领，沿 checkWriterAuthority 核对身份；重扫目标并与预演摘要比对，任何文件、目标或 Git 清单变化都拒绝。只写受控确认文件，不执行删除。",
		parameters: ConfirmParams,
		execute: async (_toolCallId, params: Static<typeof ConfirmParams>, signal) => {
			try {
				const cardsDir = params.cards_dir ?? options.resolveCardsDir();
				const result = await confirmCleanup(cardsDir, params.card_ref, {
					operator: params.operator,
					confirm: params.confirm,
					signal,
				});
				return { content: [{ type: "text", text: result.text }], details: { confirmation_path: result.path } };
			} catch (error) {
				return toolError(`删除确认未完成：${error instanceof Error ? error.message : String(error)}`);
			}
		},
	});
}
