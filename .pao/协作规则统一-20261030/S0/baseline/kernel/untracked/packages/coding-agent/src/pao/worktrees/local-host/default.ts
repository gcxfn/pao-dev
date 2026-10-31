import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { captureContentTree } from "../../cards/baseline.ts";
import { withFileLock } from "../../shared/lock.ts";
import type {
	PaoLocalCreateGitWorktreeInput,
	PaoLocalWorktreeCatalogAdapter,
	PaoLocalWorktreeCatalogEntry,
	PaoLocalWorktreeCheckpointAdapter,
	PaoLocalWorktreeWorkspace,
} from "./adapter.ts";
import { PaoLocalWorktreeHost } from "./host.ts";
import { createLocalPaoWorktreeStateAdapter } from "./state.ts";

const execFileAsync = promisify(execFile);

export const PAO_WORKTREE_STATE_ROOT_ENV = "PAO_WORKTREE_STATE_ROOT" as const;

export interface CreateLocalPaoWorktreeHostOptions {
	/**
	 * 保存 `pao-worktree-host.json` 和 `worktrees/` 的状态根目录。
	 * 桌面传入 `DesktopAppStoreOptions.userDataDir`；隔离子进程通过
	 * `PAO_WORKTREE_STATE_ROOT` 接收它的绝对路径。
	 */
	readonly stateRoot: string;
	/** 可选的项目范围；CLI 或子进程宿主只处理这一 Git 仓库。 */
	readonly projectRoot?: string;
}

/**
 * 面向 CLI、基准和子进程的零适配器入口，统一管理真实 Git 工作树、
 * 可恢复内容树仓库和宿主状态。
 */
export function createLocalPaoWorktreeHost(options: CreateLocalPaoWorktreeHostOptions): PaoLocalWorktreeHost {
	if (!options.stateRoot.trim()) throw new Error("本地工作目录宿主的 stateRoot 不能为空。");
	const stateRoot = resolve(options.stateRoot);
	const worktreeRoot = join(stateRoot, "worktrees");
	const catalog = createLocalCatalogAdapter(worktreeRoot);
	return new PaoLocalWorktreeHost({
		userDataDir: stateRoot,
		...(options.projectRoot ? { projectRoot: resolve(options.projectRoot) } : {}),
		checkpoints: createLocalCheckpointAdapter(stateRoot),
		catalog,
		git: catalog,
		state: createLocalPaoWorktreeStateAdapter(stateRoot),
		isManagedWorktreePath: (path) => isStrictlyWithin(worktreeRoot, path),
	});
}

export function createLocalCheckpointAdapter(stateRoot: string): PaoLocalWorktreeCheckpointAdapter {
	const repositoryPath = join(resolve(stateRoot), "worktree-baselines.git");
	return {
		repositoryPath,
		async capture(path, signal, timeoutMs) {
			const startedAt = Date.now();
			const captureSignal = boundedSignal(signal, timeoutMs);
			try {
				const captured = await captureContentTree(path, captureSignal.signal, true, true);
				await ensureBareRepository(repositoryPath);
				await copyGitObjectGraph(captured.repositoryRoot, repositoryPath, captured.tree, captureSignal.signal);
				const includedPaths = await listTreePaths(repositoryPath, captured.tree, captureSignal.signal);
				const byteCount = await sumRegularFileBytes(captured.repositoryRoot, includedPaths, captureSignal.signal);
				return {
					state: "available",
					treeOid: captured.tree,
					capturedAt: new Date().toISOString(),
					coverage: {
						state: "complete",
						notes: ["基线使用 captureContentTree 的统一项目内容边界。"],
					},
					fileCount: includedPaths.length,
					byteCount,
					durationMs: Date.now() - startedAt,
				};
			} catch (error) {
				return {
					state: "unavailable",
					code: captureSignal.timedOut() ? "CAPTURE_TIMEOUT" : "CAPTURE_UNAVAILABLE",
					message: errorMessage(error),
					capturedAt: new Date().toISOString(),
					coverage: { state: "partial", notes: [errorMessage(error)] },
					fileCount: 0,
					byteCount: 0,
					durationMs: Date.now() - startedAt,
				};
			} finally {
				captureSignal.dispose();
			}
		},
	};
}

export function createLocalCatalogAdapter(worktreeRoot: string): PaoLocalWorktreeCatalogAdapter & {
	createWorktree(
		workspace: PaoLocalWorktreeWorkspace,
		input: PaoLocalCreateGitWorktreeInput,
	): Promise<PaoLocalWorktreeCatalogEntry>;
} {
	const root = resolve(worktreeRoot);
	const knownWorkspaces = new Map<string, PaoLocalWorktreeWorkspace>();
	const knownEntries = new Map<string, PaoLocalWorktreeCatalogEntry>();

	const refresh = async (workspace: PaoLocalWorktreeWorkspace): Promise<readonly PaoLocalWorktreeCatalogEntry[]> => {
		knownWorkspaces.set(workspace.workspaceId, workspace);
		const discovered = await listRepositoryWorktrees(workspace.path);
		const entries = discovered.filter(
			(entry) =>
				entry.kind === "primary" || (isStrictlyWithin(root, entry.path) && entry.branchName?.startsWith("pi/")),
		);
		for (const entry of entries) knownEntries.set(entry.worktreeId, entry);
		return entries;
	};

	return {
		async getWorktree(worktreeId) {
			const cached = knownEntries.get(worktreeId);
			if (cached) return cached;
			try {
				const entry = await inspectWorktree(worktreeId);
				knownEntries.set(entry.worktreeId, entry);
				knownWorkspaces.set(entry.workspaceId, {
					workspaceId: entry.workspaceId,
					path: entry.kind === "primary" ? entry.path : entry.workspaceId,
				});
				return entry;
			} catch {
				return undefined;
			}
		},
		async listWorktrees(workspaceId) {
			if (workspaceId) {
				const workspace = knownWorkspaces.get(workspaceId);
				if (workspace) await refresh(workspace);
			}
			return {
				worktrees: [...knownEntries.values()].filter(
					(entry) => workspaceId === undefined || entry.workspaceId === workspaceId,
				),
			};
		},
		async refreshWorktrees(workspace) {
			return { worktrees: await refresh(workspace) };
		},
		async createWorktree(workspace, input) {
			const repoRoot = await canonicalDirectory(workspace.path);
			const target = resolve(input.path);
			await mkdir(dirname(target), { recursive: true });
			await git(repoRoot, ["worktree", "add", "-b", input.branchName, target, input.startPoint]);
			const path = await canonicalDirectory(target);
			const entry = await inspectWorktree(path);
			if (entry.kind !== "linked" || entry.workspaceId !== repoRoot || entry.branchName !== input.branchName)
				throw new Error("新建工作目录的 Git 身份与请求不一致。");
			knownEntries.set(entry.worktreeId, entry);
			await refresh(workspace);
			return entry;
		},
	};
}

async function ensureBareRepository(repositoryPath: string): Promise<void> {
	await mkdir(dirname(repositoryPath), { recursive: true });
	await withFileLock(join(dirname(repositoryPath), "worktree-baselines-init"), async () => {
		try {
			if ((await stat(repositoryPath)).isDirectory()) {
				const bare = (await git(repositoryPath, ["rev-parse", "--is-bare-repository"])).trim();
				if (bare !== "true") throw new Error(`基线仓不是裸仓库：${repositoryPath}`);
				return;
			}
		} catch (error) {
			if (!isMissingFileError(error)) throw error;
		}
		await gitWithoutCwd(["init", "--bare", repositoryPath]);
	});
}

async function copyGitObjectGraph(
	sourceRepository: string,
	targetRepository: string,
	rootTree: string,
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted();
	const reader = spawn("git", ["-C", sourceRepository, "pack-objects", "--stdout", "--revs"], {
		env: isolatedGitEnvironment(),
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	const writer = spawn("git", ["-C", targetRepository, "unpack-objects", "-q"], {
		env: isolatedGitEnvironment(),
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	const unbindAbort = bindGitPipeAbort(reader, writer, signal);
	const readerOutcome = observeGitPipeChild(reader);
	const writerOutcome = observeGitPipeChild(writer);
	let readerInputError: Error | undefined;
	reader.stdin.once("error", (error: Error) => {
		readerInputError = error;
	});
	reader.stdin.end(`${rootTree}\n`);

	let pipeError: unknown;
	try {
		await pipeline(reader.stdout, writer.stdin, { signal });
	} catch (error) {
		pipeError = error;
		terminateGitPipeChild(reader);
		terminateGitPipeChild(writer);
	}
	const [readerResult, writerResult] = await Promise.all([readerOutcome, writerOutcome]);
	unbindAbort();
	const failures: unknown[] = [];
	if (pipeError !== undefined) failures.push(pipeError);
	if (readerInputError !== undefined) failures.push(readerInputError);
	appendGitPipeFailure(failures, "打包源仓库对象", readerResult);
	appendGitPipeFailure(failures, "解包到独立基线仓", writerResult);
	if (signal?.aborted) failures.push(signal.reason ?? new Error("Git 对象搬运已取消。"));
	if (failures.length > 0) {
		throw new AggregateError(failures, "完整基线对象图未能安全搬运到独立裸仓库。");
	}

	const type = (await git(targetRepository, ["cat-file", "-t", rootTree])).trim();
	if (type !== "tree") throw new Error("独立快照仓未能恢复基线 tree。");
	const [sourceObjects, targetObjects] = await Promise.all([
		reachableObjectIds(sourceRepository, rootTree, signal),
		reachableObjectIds(targetRepository, rootTree, signal),
	]);
	const missingObjects = [...sourceObjects].filter((objectId) => !targetObjects.has(objectId));
	if (missingObjects.length > 0)
		throw new Error(`独立快照仓缺少 ${missingObjects.length} 个基线可达对象，首个为 ${missingObjects[0]}。`);
}

interface GitPipeChildResult {
	readonly error?: Error;
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stderr: string;
}

function observeGitPipeChild(child: ChildProcessWithoutNullStreams): Promise<GitPipeChildResult> {
	let childError: Error | undefined;
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	return new Promise((resolveResult) => {
		child.once("error", (error) => {
			childError = error;
		});
		child.once("close", (code, signal) => {
			resolveResult({ error: childError, code, signal, stderr });
		});
	});
}

function appendGitPipeFailure(failures: unknown[], action: string, result: GitPipeChildResult): void {
	if (result.error) failures.push(result.error);
	if (result.code === 0 && result.error === undefined) return;
	if (result.error !== undefined && result.code === null && result.signal === null) return;
	failures.push(
		new Error(
			`${action}失败：${result.stderr.trim() || `code=${String(result.code)} signal=${String(result.signal)}`}`,
		),
	);
}

function terminateGitPipeChild(child: ChildProcessWithoutNullStreams): void {
	if (child.exitCode === null && child.signalCode === null) child.kill();
}

function bindGitPipeAbort(
	reader: ChildProcessWithoutNullStreams,
	writer: ChildProcessWithoutNullStreams,
	signal: AbortSignal | undefined,
): () => void {
	if (!signal) return () => undefined;
	const abort = () => {
		reader.stdin.destroy();
		terminateGitPipeChild(reader);
		terminateGitPipeChild(writer);
	};
	signal.addEventListener("abort", abort, { once: true });
	if (signal.aborted) abort();
	return () => signal.removeEventListener("abort", abort);
}

async function reachableObjectIds(
	repository: string,
	rootTree: string,
	signal?: AbortSignal,
): Promise<ReadonlySet<string>> {
	const output = await git(repository, ["rev-list", "--objects", "--no-object-names", rootTree], signal);
	return new Set(output.split(/\r?\n/).filter(Boolean));
}

async function listRepositoryWorktrees(path: string): Promise<PaoLocalWorktreeCatalogEntry[]> {
	const output = await git(path, ["worktree", "list", "--porcelain"]);
	const blocks = output.split(/\r?\n\s*\r?\n/).filter(Boolean);
	const primaryPath = blockPath(blocks[0]);
	if (!primaryPath) throw new Error("Git 没有返回主工作目录。");
	const workspaceId = await canonicalDirectory(primaryPath);
	return Promise.all(
		blocks.map(async (block, index) => {
			const rawPath = blockPath(block);
			if (!rawPath) throw new Error("Git 工作目录记录缺少路径。");
			const entryPath = await canonicalDirectoryBestEffort(rawPath);
			const branch =
				block
					.split(/\r?\n/)
					.find((line) => line.startsWith("branch "))
					?.slice("branch ".length)
					.replace(/^refs\/heads\//, "") || undefined;
			const head =
				block
					.split(/\r?\n/)
					.find((line) => line.startsWith("HEAD "))
					?.slice("HEAD ".length) || undefined;
			return {
				worktreeId: entryPath,
				workspaceId,
				path: entryPath,
				kind: index === 0 ? "primary" : "linked",
				...(branch ? { branchName: branch } : {}),
				...(head ? { headSha: head } : {}),
			} satisfies PaoLocalWorktreeCatalogEntry;
		}),
	);
}

async function inspectWorktree(path: string): Promise<PaoLocalWorktreeCatalogEntry> {
	const entries = await listRepositoryWorktrees(path);
	const canonical = await canonicalDirectory(path);
	const entry = entries.find((candidate) => candidate.worktreeId === canonical);
	if (!entry) throw new Error("路径不是这个仓库的已登记工作目录。");
	return entry;
}

function blockPath(block: string | undefined): string | undefined {
	return block
		?.split(/\r?\n/)
		.find((line) => line.startsWith("worktree "))
		?.slice("worktree ".length);
}

async function listTreePaths(repository: string, treeId: string, signal?: AbortSignal): Promise<readonly string[]> {
	const text = await git(repository, ["ls-tree", "-r", "-z", "--name-only", treeId], signal);
	return text.split("\0").filter(Boolean);
}

async function sumRegularFileBytes(root: string, paths: readonly string[], signal?: AbortSignal): Promise<number> {
	let bytes = 0;
	for (const path of paths) {
		signal?.throwIfAborted();
		const stats = await lstat(join(root, path));
		bytes += stats.size;
	}
	return bytes;
}

function boundedSignal(signal: AbortSignal | undefined, timeoutMs: number | undefined) {
	if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		return { signal, timedOut: () => false, dispose: () => undefined };
	}
	const controller = new AbortController();
	let timedOut = false;
	const abort = () => controller.abort(signal?.reason);
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort(new Error(`工作目录基线捕获超过 ${timeoutMs}ms。`));
	}, timeoutMs);
	timer.unref();
	return {
		signal: controller.signal,
		timedOut: () => timedOut,
		dispose: () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		},
	};
}

async function canonicalDirectory(path: string): Promise<string> {
	if (!isAbsolute(path)) throw new Error("Git 工作目录路径必须是绝对路径。");
	const canonical = await realpath(path);
	if (!(await stat(canonical)).isDirectory()) throw new Error("Git 工作目录路径不是目录。");
	return resolve(canonical);
}

async function canonicalDirectoryBestEffort(path: string): Promise<string> {
	return canonicalDirectory(path).catch(() => resolve(path));
}

function isStrictlyWithin(root: string, candidate: string): boolean {
	const relativePath = relative(resolve(root), resolve(candidate));
	return (
		relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
	);
}

async function git(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
	const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		env: isolatedGitEnvironment(),
		signal,
		windowsHide: true,
	});
	return stdout;
}

async function gitWithoutCwd(args: readonly string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", [...args], {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		env: isolatedGitEnvironment(),
		windowsHide: true,
	});
	return stdout;
}

function isolatedGitEnvironment(): NodeJS.ProcessEnv {
	const environment = { ...process.env };
	for (const key of Object.keys(environment)) {
		if (key.startsWith("GIT_")) delete environment[key];
	}
	return {
		...environment,
		GIT_OPTIONAL_LOCKS: "0",
		GIT_TERMINAL_PROMPT: "0",
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isMissingFileError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
