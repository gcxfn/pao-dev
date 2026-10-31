import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rm, rmdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { withFileLock } from "../../shared/lock.ts";
import {
	acquireExecutionRootGuard,
	detectExecutionOccupancy,
	type ExecutionRootGuard,
	listReleasedExecutionArtifacts,
	prepareExecutionRootForRemoval,
} from "../../worker/lock.ts";
import type {
	CreateWorktreeRequest,
	InspectWorktreesRequest,
	ManagedWorktreeBinding,
	PaoWorktreeHost,
	RequestWorktreeCleanupRequest,
	ResolveWorktreeForDispatchRequest,
	WorktreeBaselineProof,
	WorktreeBinding,
	WorktreeCapability,
	WorktreeCleanupResult,
	WorktreeInspection,
} from "../types.ts";
import type {
	PaoLocalCheckpointCapture,
	PaoLocalWorktreeCatalogEntry,
	PaoLocalWorktreeHostOptions,
	PaoLocalWorktreeRuntimeAdapter,
} from "./adapter.ts";

const execFileAsync = promisify(execFile);
const BASELINE_TIMEOUT_MS = 60_000;
const BASELINE_VERIFY_TIMEOUT_MS = 60_000;

interface RequestRecord {
	readonly status: "pending" | "completed";
	readonly fingerprint: string;
	readonly taskRoot: string;
	readonly displayName: string;
	readonly target: {
		readonly path: string;
		readonly branchName: string;
		readonly sourceHead: string;
		readonly treeId: string;
		readonly snapshotRepositoryPath: string;
	};
	readonly baseline: WorktreeBaselineProof;
	readonly binding?: WorktreeBinding;
}

interface CleanupRecord {
	readonly fingerprint: string;
	readonly result: WorktreeCleanupResult;
}

interface HostState {
	readonly version: 2;
	readonly creates: Readonly<Record<string, RequestRecord>>;
	readonly cleanups: Readonly<Record<string, CleanupRecord>>;
}

interface WorktreeSourceProof {
	readonly repositoryRoot: string;
	readonly commonGitDir: string;
	readonly sourceHead: string;
}

interface LinkedWorktreeProof {
	readonly repositoryRoot: string;
	readonly commonGitDir: string;
	readonly branchName: string;
	readonly head: string;
	readonly isPrimary: boolean;
}

interface GitObjectState {
	readonly indexDigest: string;
	readonly worktreeDigest: string;
}

export class PaoLocalWorktreeHost implements PaoWorktreeHost {
	readonly worktreeRoot: string;
	private readonly isManagedWorktreePath: (path: string) => boolean | Promise<boolean>;
	private readonly runtime: PaoLocalWorktreeRuntimeAdapter;
	private readonly options: PaoLocalWorktreeHostOptions;
	private readonly createInFlight = new Map<
		string,
		{ readonly fingerprint: string; readonly promise: Promise<WorktreeBinding> }
	>();
	private readonly creationQueue: Array<() => void> = [];
	private creationActive = false;

	constructor(options: PaoLocalWorktreeHostOptions) {
		this.options = options;
		this.worktreeRoot = join(options.userDataDir, "worktrees");
		this.isManagedWorktreePath =
			options.isManagedWorktreePath ?? ((path) => isStrictlyWithin(this.worktreeRoot, resolve(path)));
		this.runtime = options.runtime ?? {
			acquireExecutionRootGuard,
			detectExecutionOccupancy,
			listReleasedExecutionArtifacts,
			prepareExecutionRootForRemoval,
		};
	}

	async capability(projectRoot: string): Promise<WorktreeCapability> {
		try {
			const taskRoot = await canonicalDirectory(projectRoot, "项目根");
			await this.assertProjectRoot(taskRoot);
			await inspectSource(taskRoot);
			const capture = await this.options.checkpoints.capture(taskRoot, undefined, BASELINE_VERIFY_TIMEOUT_MS);
			if (capture.state === "available" && capture.coverage.state === "complete") {
				return { ok: true, create: true, cleanup: true, baseline: "recoverable-complete" };
			}
			return {
				ok: false,
				reason:
					capture.state === "available"
						? `无法建立完整基线：${capture.coverage.notes.join("；") || "存在未纳入内容"}`
						: `无法建立可恢复基线：${capture.message}`,
			};
		} catch (error) {
			return { ok: false, reason: errorMessage(error) };
		}
	}

	async create(input: CreateWorktreeRequest): Promise<WorktreeBinding> {
		const requestId = requestIdPart(input.requestId);
		const projectRoot = await canonicalDirectory(input.projectRoot, "项目根");
		await this.assertProjectRoot(projectRoot);
		const displayName = normalizedDisplayName(input.displayName);
		const fingerprint = requestFingerprint([requestId, projectRoot, displayName ?? ""]);
		const pending = this.createInFlight.get(requestId);
		if (pending) {
			if (pending.fingerprint !== fingerprint) throw new Error("同一 request_id 已用于不同的创建工作目录请求。");
			return pending.promise;
		}

		const task = this.withRequestLock(requestId, () =>
			this.withCreationSlot(async () => {
				const state = await this.readState();
				const previous = state.creates[requestId];
				if (previous) {
					verifyCreateFingerprint(previous, fingerprint);
					return this.resolveCreateRecord(requestId, previous);
				}
				const prepared = await this.prepareCreate(projectRoot, displayName, fingerprint);
				await this.transactState((current) => {
					const repeated = current.creates[requestId];
					if (repeated) return { state: current, result: repeated };
					return {
						state: {
							...current,
							creates: { ...current.creates, [requestId]: prepared },
						},
						result: prepared,
					};
				}, "pending");
				const binding = await this.createNow(prepared);
				await this.transactState(
					(current) => ({
						state: {
							...current,
							creates: {
								...current.creates,
								[requestId]: { ...prepared, status: "completed", binding },
							},
						},
						result: binding,
					}),
					"completed",
				);
				return binding;
			}),
		);
		this.createInFlight.set(requestId, { fingerprint, promise: task });
		try {
			return await task;
		} finally {
			if (this.createInFlight.get(requestId)?.promise === task) {
				this.createInFlight.delete(requestId);
			}
		}
	}

	async inspect(input: InspectWorktreesRequest): Promise<readonly WorktreeInspection[]> {
		const taskRoot = await canonicalDirectory(input.projectRoot, "项目根");
		await this.assertProjectRoot(taskRoot);
		const source = await inspectSource(taskRoot);
		const workspace = { workspaceId: source.repositoryRoot, path: taskRoot };
		const snapshot = await this.options.catalog.refreshWorktrees(workspace);
		const entries = snapshot.worktrees.filter(
			(entry) =>
				(input.worktreeId
					? entry.kind === "linked" && entry.worktreeId === input.worktreeId
					: entry.kind === "primary") ||
				(entry.workspaceId === source.repositoryRoot && Boolean(entry.worktreeId) && !input.worktreeId),
		);
		return Promise.all(entries.map((entry) => this.inspectEntry(taskRoot, entry)));
	}

	async resolveForDispatch(input: ResolveWorktreeForDispatchRequest): Promise<WorktreeBinding> {
		requestIdPart(input.requestId);
		const taskRoot = await canonicalDirectory(input.projectRoot, "项目根");
		await this.assertProjectRoot(taskRoot);
		const source = await inspectSource(taskRoot);
		if (input.target.kind === "primary") {
			const binding = primaryBinding(taskRoot, source);
			verifyExpectedVersion(binding, input.expectedInputVersion);
			return binding;
		}
		const binding = await this.resolveManaged(taskRoot, input.target.worktreeId);
		verifyExpectedVersion(binding, input.expectedInputVersion);
		return binding;
	}

	async requestCleanup(input: RequestWorktreeCleanupRequest): Promise<WorktreeCleanupResult> {
		const requestId = requestIdPart(input.requestId);
		return this.withRequestLock(`cleanup:${requestId}`, () => this.requestCleanupNow(input));
	}

	private async requestCleanupNow(input: RequestWorktreeCleanupRequest): Promise<WorktreeCleanupResult> {
		const fingerprint = requestFingerprint([
			input.requestId,
			await canonicalDirectory(input.projectRoot, "项目根"),
			input.worktreeId,
			input.reason.trim(),
			String(input.executionActive),
		]);
		const previous = (await this.readState()).cleanups[input.requestId];
		if (previous) {
			if (previous.fingerprint !== fingerprint) throw new Error("同一 request_id 已用于不同的工作目录清理请求。");
			return previous.result;
		}
		const remember = async (result: WorktreeCleanupResult): Promise<WorktreeCleanupResult> => {
			await this.transactState((current) => ({
				state: {
					...current,
					cleanups: {
						...current.cleanups,
						[input.requestId]: { fingerprint, result },
					},
				},
				result: undefined,
			}));
			return result;
		};
		try {
			const taskRoot = await canonicalDirectory(input.projectRoot, "项目根");
			await this.assertProjectRoot(taskRoot);
			if (input.executionActive !== false) {
				return await remember(retained("任务执行状态不是已停止，已保留现场。"));
			}
			const existing = await this.options.catalog.getWorktree(input.worktreeId);
			if (!existing || existing.kind !== "linked") return await remember(retained("不是应用登记的独立工作目录。"));
			if (existing.workspaceId !== (await catalogRepositoryId(taskRoot, this.options.catalog))) {
				return await remember(retained("工作目录登记不属于当前项目。"));
			}
			const targetPath = await canonicalDirectory(existing.path, "工作目录");
			if (!(await this.isManagedWorktreePath(targetPath)))
				return await remember(retained("路径不在应用工作目录根内。"));
			if (resolve(existing.path) !== targetPath)
				return await remember(retained("登记路径与真实路径不一致，已保留现场。"));

			const proof = await inspectLinkedWorktree(targetPath);
			if (proof.isPrimary) return await remember(retained("主目录不能按独立工作目录清理。"));
			if ((await canonicalDirectory(proof.repositoryRoot, "源仓库")) !== taskRoot)
				return await remember(retained("工作目录属于其他仓库。"));
			if (
				(await canonicalDirectory(proof.commonGitDir, "公共 Git 目录")) !==
				(await canonicalDirectory((await inspectSource(taskRoot)).commonGitDir, "公共 Git 目录"))
			)
				return await remember(retained("工作目录的仓库身份与当前项目不一致。"));
			if (proof.branchName !== existing.branchName || !proof.branchName.startsWith("pi/"))
				return await remember(retained("工作目录分支与登记不一致，或不是应用创建的 pi/ 分支。"));

			const changes = await gitStatus(targetPath, this.runtime.listReleasedExecutionArtifacts(targetPath));
			if (changes.dirty) return await remember(retained("工作目录仍有未保存改动，已保留现场。"));
			if (changes.untracked)
				return await remember(retained("工作目录仍有应用运行元数据以外的未跟踪文件，已保留现场。"));
			if (!(await isMerged(taskRoot, proof.branchName)))
				return await remember(retained("工作目录分支尚未合入当前项目，已保留分支和目录。"));
			const guard = await this.acquireCleanupGuard({
				taskRoot,
				executionRoot: targetPath,
				holder: `desktop-worktree-cleanup:${input.requestId}`,
				signal: input.signal,
			});
			let guardReleased = false;
			try {
				if (guard.occupancy !== "idle")
					return await remember(
						retained(
							guard.occupancy === "unknown"
								? "执行占用状态未知，已保留工作目录和清理守卫。"
								: "另一会话或进程正在使用这个工作目录，已保留现场。",
						),
					);
				await this.assertExecutionIdle(targetPath);
				if (this.options.activeExecution) {
					const live = await this.options.activeExecution(taskRoot, targetPath);
					if (live !== false) return await remember(retained("当前仍有任务使用这个工作目录，已保留现场。"));
				}
				await this.assertExecutionIdle(targetPath);
				await this.runtime.prepareExecutionRootForRemoval({
					guard,
					archiveRoot: join(taskRoot, "worker-evidence", "工作树运行证据", executionIdentity(targetPath)),
				});
				await this.assertExecutionIdle(targetPath);
				const remainingChanges = await gitStatus(targetPath);
				if (remainingChanges.dirty || remainingChanges.untracked)
					return await remember(
						retained(
							remainingChanges.dirty
								? "工作目录仍有未保存改动，已保留现场。"
								: "工作目录仍有未跟踪文件，已保留现场。",
						),
					);

				await git(taskRoot, ["worktree", "remove", targetPath]);
				await this.options.catalog.refreshWorktrees({
					workspaceId: proof.repositoryRoot,
					path: taskRoot,
				});
				if (await pathExists(targetPath))
					return await remember(retained("Git 已完成移除命令，但工作目录仍存在；未报告释放成功。"));
				await guard.release();
				guardReleased = true;
				const result: WorktreeCleanupResult = { ok: true, released: true, branchDeleted: false };
				return await remember(result);
			} finally {
				if (!guardReleased) retainCleanupGuard(guard);
			}
		} catch (error) {
			const result = retained(errorMessage(error));
			try {
				await remember(result);
			} catch (persistError) {
				throw new Error(`工作目录清理被保留，且幂等记录写入失败：${errorMessage(persistError)}`, {
					cause: error,
				});
			}
			return result;
		}
	}

	private async acquireCleanupGuard(input: {
		readonly taskRoot: string;
		readonly executionRoot: string;
		readonly holder: string;
		readonly signal?: AbortSignal;
	}): Promise<ExecutionRootGuard> {
		return this.runtime.acquireExecutionRootGuard(input);
	}

	private async assertExecutionIdle(executionRoot: string): Promise<void> {
		const occupancy = await this.runtime.detectExecutionOccupancy(executionRoot);
		if (occupancy !== "idle")
			throw new Error(
				occupancy === "unknown" ? "执行占用状态未知，拒绝删除工作目录。" : "执行根仍有活动任务，拒绝删除工作目录。",
			);
	}

	private async prepareCreate(
		taskRoot: string,
		displayName: string | undefined,
		fingerprint: string,
	): Promise<RequestRecord> {
		const source = await inspectSource(taskRoot);
		const captured = await this.options.checkpoints.capture(taskRoot, undefined, BASELINE_TIMEOUT_MS);
		const baseline = await requireCompleteCapture(
			taskRoot,
			source,
			captured,
			this.options.checkpoints.repositoryPath,
			captured.coverage.notes,
		);
		const folder = `pao-${fingerprint.slice(0, 24)}`;
		return {
			status: "pending",
			fingerprint,
			taskRoot,
			displayName: displayName ?? "",
			target: {
				path: join(this.worktreeRoot, safeSegment(basename(source.repositoryRoot) || "repo"), folder),
				branchName: `pi/${folder}`,
				sourceHead: source.sourceHead,
				treeId: baseline.treeId,
				snapshotRepositoryPath: baseline.snapshotRepositoryPath,
			},
			baseline,
		};
	}

	private async resolveCreateRecord(requestId: string, record: RequestRecord): Promise<WorktreeBinding> {
		if (record.status === "completed" && record.binding) {
			await this.verifyPersistedBinding(record.binding);
			return record.binding;
		}
		const binding = await this.recoverPending(record);
		await this.transactState((current) => {
			const pending = current.creates[requestId];
			if (!pending || pending.fingerprint !== record.fingerprint)
				throw new Error("待完成工作目录的受理记录在恢复期间发生变化。");
			return {
				state: {
					...current,
					creates: {
						...current.creates,
						[requestId]: { ...pending, status: "completed", binding },
					},
				},
				result: undefined,
			};
		}, "completed");
		return binding;
	}

	private async recoverPending(record: RequestRecord): Promise<ManagedWorktreeBinding> {
		if (record.status !== "pending" || record.binding) throw new Error("工作目录创建受理记录状态不一致，拒绝覆盖。");
		if (!(await pathExists(record.target.path)))
			throw new Error(
				`工作目录创建处于待完成状态，但目标目录不存在；请保留受理记录并人工盘点：${record.target.path}`,
			);
		const proof = await inspectLinkedWorktree(record.target.path);
		if (proof.isPrimary || proof.repositoryRoot !== record.taskRoot || proof.branchName !== record.target.branchName)
			throw new Error("待完成工作目录的 Git 身份与受理记录不一致，已保留现场待盘点。");
		const entry = await this.options.catalog.getWorktree(record.target.path);
		if (!entry || entry.kind !== "linked") throw new Error("待完成工作目录尚未登记到应用目录，已保留现场待盘点。");
		const recovered = await this.options.checkpoints.capture(
			record.target.path,
			undefined,
			BASELINE_VERIFY_TIMEOUT_MS,
		);
		try {
			await requireUnchangedCapture(record.target.path, record.baseline, recovered);
		} catch (error) {
			throw new Error(`待完成工作目录的内容尚未完整落地；已保留现场待盘点。${errorMessage(error)}`);
		}
		await requireBaselineRecoverable(record.baseline);
		const binding: ManagedWorktreeBinding = {
			kind: "managed",
			worktreeId: entry.worktreeId,
			taskRoot: record.taskRoot,
			executionRoot: entry.path,
			commonGitDir: proof.commonGitDir,
			branchName: record.target.branchName,
			inputVersion: record.baseline.treeId,
			bindingDigest: "",
			baseline: record.baseline,
		};
		return { ...binding, bindingDigest: bindingDigest(binding) };
	}

	private async createNow(record: RequestRecord): Promise<ManagedWorktreeBinding> {
		const {
			taskRoot,
			displayName,
			baseline: sourceBaseline,
			target: { path: targetPath, branchName },
		} = record;
		const source = await inspectSource(taskRoot);
		if (source.sourceHead !== sourceBaseline.sourceHead) throw new Error("来源仓库在创建工作目录受理后发生了变化。");
		const sourceAgain = await this.options.checkpoints.capture(taskRoot, undefined, BASELINE_VERIFY_TIMEOUT_MS);
		await requireUnchangedCapture(taskRoot, sourceBaseline, sourceAgain);
		let createdPath: string | undefined;
		const workspace = { workspaceId: source.repositoryRoot, path: taskRoot };
		try {
			const entry = await this.options.git.createWorktree(workspace, {
				path: targetPath,
				branchName,
				startPoint: "HEAD",
				...(displayName ? { displayName } : {}),
			});
			createdPath = entry.path;
			await this.options.afterWorktreeCreated?.(createdPath);
			await resetCleanWorktree(
				createdPath,
				sourceBaseline.treeId,
				this.options.checkpoints.repositoryPath,
				join(this.options.userDataDir, "tmp"),
			);
			const rebuilt = await this.options.checkpoints.capture(createdPath, undefined, BASELINE_VERIFY_TIMEOUT_MS);
			await requireUnchangedCapture(createdPath, sourceBaseline, rebuilt);
			await requireBaselineRecoverable(sourceBaseline);
			const currentSource = await inspectSource(taskRoot);
			if (currentSource.sourceHead !== sourceBaseline.sourceHead)
				throw new Error("源项目 HEAD 在创建工作目录期间发生变化。");
			const sourceFinal = await this.options.checkpoints.capture(taskRoot, undefined, BASELINE_VERIFY_TIMEOUT_MS);
			await requireUnchangedCapture(taskRoot, sourceBaseline, sourceFinal);
			const createdProof = await inspectLinkedWorktree(createdPath);
			if (
				createdProof.repositoryRoot !== taskRoot ||
				createdProof.commonGitDir !== source.commonGitDir ||
				createdProof.branchName !== branchName
			)
				throw new Error("创建后的 Git 工作目录身份与预期不一致。");
			const binding: ManagedWorktreeBinding = {
				kind: "managed",
				worktreeId: entry.worktreeId,
				taskRoot,
				executionRoot: entry.path,
				commonGitDir: source.commonGitDir,
				branchName,
				inputVersion: sourceBaseline.treeId,
				bindingDigest: "",
				baseline: sourceBaseline,
			};
			return { ...binding, bindingDigest: bindingDigest(binding) };
		} catch (error) {
			const retainedPath = createdPath ?? targetPath;
			throw new Error(
				`创建独立工作目录未完成；请核对保留现场 ${retainedPath} 与分支 ${branchName}：${errorMessage(error)}`,
				{ cause: error },
			);
		}
	}

	private async inspectEntry(taskRoot: string, entry: PaoLocalWorktreeCatalogEntry): Promise<WorktreeInspection> {
		const proof = await inspectLinkedWorktree(entry.path).catch(() => undefined);
		const changes = proof ? await gitStatus(entry.path).catch(() => undefined) : undefined;
		const active = this.options.activeExecution
			? await Promise.resolve(this.options.activeExecution(taskRoot, entry.path)).catch(() => "unknown" as const)
			: "unknown";
		return {
			kind: entry.kind === "primary" ? "primary" : "managed",
			taskRoot,
			executionRoot: proof ? await canonicalPathBestEffort(entry.path) : entry.path,
			commonGitDir: proof?.commonGitDir ?? "",
			inputVersion: proof?.head ?? entry.headSha ?? "unknown",
			...(entry.kind === "linked" ? { worktreeId: entry.worktreeId } : {}),
			...(proof?.branchName ? { branchName: proof.branchName } : {}),
			dirty: changes?.dirty ?? "unknown",
			untracked: changes?.untracked ?? "unknown",
			...(proof?.branchName
				? await isMerged(taskRoot, proof.branchName).then(
						(merged) => ({ mergedIntoTaskHead: merged }),
						() => ({}),
					)
				: {}),
			active,
		};
	}

	private async resolveManaged(taskRoot: string, worktreeId: string): Promise<ManagedWorktreeBinding> {
		const entry = await this.options.catalog.getWorktree(worktreeId);
		if (!entry || entry.kind !== "linked") throw new Error("不是应用登记的独立工作目录。");
		if (entry.workspaceId !== (await catalogRepositoryId(taskRoot, this.options.catalog)))
			throw new Error("工作目录登记不属于当前项目。");
		if (!(await this.isManagedWorktreePath(entry.path))) throw new Error("工作目录不在应用目录根内。");
		const executionRoot = await canonicalDirectory(entry.path, "工作目录");
		const source = await inspectSource(taskRoot);
		const proof = await inspectLinkedWorktree(executionRoot);
		if (proof.isPrimary || proof.repositoryRoot !== taskRoot) throw new Error("工作目录属于其他仓库或是主目录。");
		if (proof.commonGitDir !== source.commonGitDir) throw new Error("公共 Git 目录与当前项目不一致。");
		if (!proof.branchName.startsWith("pi/") || proof.branchName !== entry.branchName)
			throw new Error("工作目录分支与登记不一致。");
		const baseline = await this.baselineForEntry(entry, source);
		const gitObjects = await inspectGitObjectState(executionRoot);
		const worktreeChanged = gitObjects.indexDigest !== baseline.treeId || gitObjects.worktreeDigest.trim() !== "";
		const binding: ManagedWorktreeBinding = {
			kind: "managed",
			worktreeId: entry.worktreeId,
			taskRoot,
			executionRoot,
			commonGitDir: source.commonGitDir,
			branchName: proof.branchName,
			inputVersion: baseline.inputVersion,
			bindingDigest: "",
			baseline,
			...(worktreeChanged ? {} : { currentTreeId: baseline.treeId }),
		};
		return { ...binding, bindingDigest: bindingDigest(binding) };
	}

	private async baselineForEntry(
		entry: PaoLocalWorktreeCatalogEntry,
		source: WorktreeSourceProof,
	): Promise<WorktreeBaselineProof> {
		const state = await this.readState();
		const record = Object.values(state.creates).find(
			(request) =>
				request.status === "completed" &&
				request.binding?.kind === "managed" &&
				request.binding.worktreeId === entry.worktreeId,
		);
		if (!record || record.binding?.kind !== "managed")
			throw new Error("找不到这个工作目录的可恢复基线证明，不能用于派发。");
		if (record.binding.taskRoot !== source.repositoryRoot) throw new Error("工作目录基线证明不属于当前项目。");
		return record.binding.baseline;
	}

	private async readState(): Promise<HostState> {
		const saved = await this.options.state.load();
		return saved === undefined ? emptyState() : decodeHostState(saved);
	}

	private async transactState<T>(
		update: (current: HostState) => { readonly state: HostState; readonly result: T },
		phase?: "pending" | "completed",
	): Promise<T> {
		await mkdir(dirname(this.options.state.lockTarget), { recursive: true });
		const result = await withFileLock(this.options.state.lockTarget, async () => {
			const current = await this.readState();
			const updateResult = update(current);
			const validated = decodeHostState(updateResult.state);
			await this.options.state.save(validated);
			return updateResult.result;
		});
		if (phase) await this.options.persistStateHook?.(phase);
		return result;
	}

	private async withRequestLock<T>(requestId: string, task: () => Promise<T>): Promise<T> {
		const directory = join(this.options.userDataDir, "pao-worktree-host-requests");
		await mkdir(directory, { recursive: true });
		const target = join(directory, createHash("sha256").update(requestId).digest("hex"));
		return withFileLock(target, task);
	}

	private async assertProjectRoot(taskRoot: string): Promise<void> {
		if (this.options.projectRoot === undefined) return;
		const allowed = await canonicalDirectory(this.options.projectRoot, "宿主项目根");
		if (taskRoot !== allowed) throw new Error("请求的项目根不属于当前本地工作目录宿主。");
	}

	private async withCreationSlot<T>(task: () => Promise<T>): Promise<T> {
		if (this.creationActive) {
			await new Promise<void>((resolveQueue) => this.creationQueue.push(resolveQueue));
		}
		this.creationActive = true;
		try {
			return await task();
		} finally {
			this.creationActive = false;
			this.creationQueue.shift()?.();
		}
	}

	private async verifyPersistedBinding(binding: WorktreeBinding): Promise<void> {
		if (binding.kind === "primary") throw new Error("工作目录创建记录不能指向主目录。");
		const entry = await this.options.catalog.getWorktree(binding.worktreeId);
		if (!entry || entry.kind !== "linked") throw new Error("已登记的工作目录记录不存在。");
		if (entry.path !== binding.executionRoot) throw new Error("已登记工作目录路径与幂等记录不一致。");
		const proof = await inspectLinkedWorktree(entry.path);
		if (
			proof.isPrimary ||
			proof.repositoryRoot !== binding.taskRoot ||
			proof.commonGitDir !== binding.commonGitDir ||
			proof.branchName !== binding.branchName
		)
			throw new Error("已登记工作目录的真实 Git 身份与幂等记录不一致。");
	}
}

function primaryBinding(taskRoot: string, source: WorktreeSourceProof): WorktreeBinding {
	const binding = {
		kind: "primary" as const,
		taskRoot,
		executionRoot: taskRoot,
		commonGitDir: source.commonGitDir,
		inputVersion: source.sourceHead,
		bindingDigest: "",
	};
	return { ...binding, bindingDigest: bindingDigest(binding) };
}

function bindingDigest(binding: Omit<WorktreeBinding, "bindingDigest"> | WorktreeBinding): string {
	const record = { ...binding, bindingDigest: undefined };
	return `sha256:${createHash("sha256").update(JSON.stringify(record)).digest("hex")}`;
}

function requestIdPart(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error("request_id 不能为空。");
	return trimmed;
}

function normalizedDisplayName(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed || undefined;
}

function requestFingerprint(parts: readonly string[]): string {
	return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function verifyCreateFingerprint(previous: RequestRecord, fingerprint: string): void {
	if (previous.fingerprint !== fingerprint) throw new Error("同一 request_id 已用于不同的工作目录创建请求。");
}

function verifyExpectedVersion(binding: WorktreeBinding, expected: string | undefined): void {
	if (expected !== undefined && binding.inputVersion !== expected)
		throw new Error("工作目录输入版本已变化，不能继续派发。");
}

async function requireCompleteCapture(
	root: string,
	source: WorktreeSourceProof,
	capture: PaoLocalCheckpointCapture,
	snapshotRepositoryPath: string,
	notes: readonly string[],
): Promise<WorktreeBaselineProof> {
	if (capture.state !== "available") throw new Error(`无法建立可恢复基线：${capture.message}`);
	if (capture.coverage.state !== "complete")
		throw new Error(`基线覆盖不完整：${capture.coverage.notes.join("；") || "存在未包含内容"}`);
	const includedPaths = await listTreePaths(snapshotRepositoryPath, capture.treeOid);
	return {
		sourceRoot: root,
		sourceHead: source.sourceHead,
		treeId: capture.treeOid,
		snapshotRepositoryPath,
		inputVersion: capture.treeOid,
		capturedAt: capture.capturedAt,
		fileCount: capture.fileCount,
		byteCount: capture.byteCount,
		coverage: "complete",
		includedPaths,
		excludedPaths: [],
		notes: [...notes],
	};
}

async function requireUnchangedCapture(
	root: string,
	baseline: WorktreeBaselineProof,
	capture: PaoLocalCheckpointCapture,
): Promise<void> {
	await requireTree(root, baseline.treeId, capture);
}

async function requireBaselineRecoverable(baseline: WorktreeBaselineProof): Promise<void> {
	if ((await git(baseline.snapshotRepositoryPath, ["cat-file", "-t", baseline.treeId])).trim() !== "tree")
		throw new Error("独立快照仓中的基线 tree 不可恢复。");
	const paths = await listTreePaths(baseline.snapshotRepositoryPath, baseline.treeId);
	if (JSON.stringify(paths) !== JSON.stringify(baseline.includedPaths))
		throw new Error("独立快照仓中的基线文件清单与受理记录不一致。");
}

async function requireTree(root: string, expectedTree: string, capture: PaoLocalCheckpointCapture): Promise<void> {
	if (capture.state !== "available" || capture.coverage.state !== "complete")
		throw new Error("无法核对工作目录的完整基线。");
	if (capture.treeOid !== expectedTree) throw new Error("工作目录内容与来源基线不一致。");
	void root;
}

async function inspectSource(projectRoot: string): Promise<WorktreeSourceProof> {
	const repositoryRoot = await canonicalDirectory(
		(await git(projectRoot, ["rev-parse", "--show-toplevel"])).trim(),
		"源仓库",
	);
	if (repositoryRoot !== (await canonicalDirectory(projectRoot, "项目根")))
		throw new Error("项目根必须是 Git 仓库根，不能是子目录。");
	const commonGitDir = await canonicalDirectory(
		(await git(projectRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim(),
		"公共 Git 目录",
	);
	const sourceHead = (await git(projectRoot, ["rev-parse", "HEAD"])).trim();
	if (!/^[a-f0-9]{40,64}$/i.test(sourceHead)) throw new Error("当前仓库没有可用的提交。");
	return { repositoryRoot, commonGitDir, sourceHead };
}

async function inspectLinkedWorktree(path: string): Promise<LinkedWorktreeProof> {
	const output = await git(path, ["worktree", "list", "--porcelain"]);
	const blocks = output.split(/\r?\n\s*\r?\n/).filter(Boolean);
	const primaryLine = blocks[0]?.split(/\r?\n/).find((line) => line.startsWith("worktree "));
	if (!primaryLine) throw new Error("Git 没有返回主工作目录。");
	const repositoryRoot = await canonicalDirectory(primaryLine.slice("worktree ".length), "主仓库");
	const commonGitDir = await canonicalDirectory(
		(await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim(),
		"公共 Git 目录",
	);
	for (const [index, block] of blocks.entries()) {
		const lines = block.split(/\r?\n/);
		const pathLine = lines.find((line) => line.startsWith("worktree "));
		if (!pathLine) continue;
		const entryPath = await canonicalDirectory(pathLine.slice("worktree ".length), "工作目录");
		if (entryPath !== (await canonicalDirectory(path, "工作目录"))) continue;
		const head = lines.find((line) => line.startsWith("HEAD "))?.slice(5) ?? "";
		const branch = lines.find((line) => line.startsWith("branch "))?.slice(7);
		return {
			repositoryRoot,
			commonGitDir,
			branchName: branch?.replace(/^refs\/heads\//, "") ?? "",
			head,
			isPrimary: index === 0,
		};
	}
	throw new Error("路径不是这个仓库的已登记工作目录。");
}

async function resetCleanWorktree(
	path: string,
	treeId: string,
	repository: string,
	scratchRoot: string,
): Promise<void> {
	const type = (await git(repository, ["cat-file", "-t", treeId])).trim();
	if (type !== "tree") throw new Error("基线快照对象不可恢复。");
	await mkdir(scratchRoot, { recursive: true });
	// 仅用于把基线 checkout 到新工作树，属于一次性索引中间目录，放在共享状态根内。
	const scratch = await mkdtemp(join(scratchRoot, "worktree-index-"));
	try {
		const environment = {
			GIT_INDEX_FILE: join(scratch, "index"),
			GIT_ALTERNATE_OBJECT_DIRECTORIES: join(repository, "objects"),
		};
		const current = await git(path, ["ls-files", "-z"]);
		const tracked = current.split("\0").filter(Boolean);
		await git(path, ["read-tree", treeId], environment);
		await git(path, ["-c", "core.autocrlf=false", "checkout-index", "--all", "--force"], environment);
		const baselineOutput = await git(repository, ["ls-tree", "-r", "-z", "--name-only", treeId]);
		const baseline = new Set(baselineOutput.split("\0").filter(Boolean));
		for (const relativePath of tracked) {
			if (baseline.has(relativePath)) continue;
			const absolutePath = resolve(path, relativePath);
			if (relativePath.split(/[\\/]/).includes("..")) throw new Error("基线快照包含不安全路径。");
			await unlink(absolutePath).catch((error: unknown) => {
				if (!isMissingFileError(error)) throw error;
			});
		}
		await removeEmptyParentDirectories(path, tracked);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

async function removeEmptyParentDirectories(root: string, trackedPaths: readonly string[]): Promise<void> {
	const directories = new Set(trackedPaths.map((path) => dirname(join(root, path))));
	for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
		let current = directory;
		while (current !== root && current !== dirname(current)) {
			try {
				if ((await readdir(current)).length > 0) break;
				await rmdir(current);
			} catch (error) {
				if (isMissingFileError(error)) break;
				throw error;
			}
			current = dirname(current);
		}
	}
}

async function listTreePaths(repository: string, treeId: string): Promise<readonly string[]> {
	const text = await git(repository, ["ls-tree", "-r", "-z", "--name-only", treeId]);
	return text.split("\0").filter(Boolean);
}

async function gitStatus(
	path: string,
	allowedUntracked: readonly string[] = [],
): Promise<{ dirty: boolean; untracked: boolean }> {
	const output = await git(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
	const entries = output.split("\0").filter(Boolean);
	const allowed = new Set(allowedUntracked.map((value) => resolve(value)));
	return {
		dirty: entries.some((entry) => entry.slice(0, 2) !== "??"),
		untracked: entries.some((entry) => entry.slice(0, 2) === "??" && !allowed.has(resolve(path, entry.slice(3)))),
	};
}

async function isMerged(repository: string, branch: string): Promise<boolean> {
	try {
		await git(repository, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, "HEAD"]);
		return true;
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === 1 &&
			!("signal" in error && error.signal)
		) {
			return false;
		}
		throw error;
	}
}

async function inspectGitObjectState(root: string): Promise<GitObjectState> {
	const [indexDigest, worktreeDigest] = await Promise.all([
		git(root, ["write-tree"]).then(stripLine),
		git(root, ["diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", "--"]).then((output) =>
			createHash("sha256").update(output).digest("hex"),
		),
	]);
	return { indexDigest, worktreeDigest };
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (isMissingFileError(error)) return false;
		throw error;
	}
}

async function catalogRepositoryId(taskRoot: string, storage: PaoLocalWorktreeHostOptions["catalog"]): Promise<string> {
	const snapshot = await storage.listWorktrees();
	const aliases = new Set(
		snapshot.worktrees
			.filter((entry) => entry.kind === "primary" && entry.path === taskRoot)
			.map((entry) => entry.workspaceId),
	);
	return aliases.values().next().value ?? (await inspectSource(taskRoot)).repositoryRoot;
}

function retained(reason: string): WorktreeCleanupResult {
	return { ok: false, retained: true, reason };
}

function retainCleanupGuard(guard: ExecutionRootGuard): void {
	void guard;
}

function isStrictlyWithin(root: string, candidate: string): boolean {
	const relativePath = relative(resolve(root), resolve(candidate));
	return (
		relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
	);
}

function executionIdentity(executionRoot: string): string {
	return createHash("sha256").update(resolve(executionRoot)).digest("hex");
}

async function canonicalDirectory(path: string, field: string): Promise<string> {
	if (!isAbsolute(path)) throw new Error(`${field}必须是绝对路径。`);
	const canonical = await realpath(path);
	if (!(await stat(canonical)).isDirectory()) throw new Error(`${field}不是目录。`);
	return resolve(canonical);
}

async function canonicalPathBestEffort(path: string): Promise<string> {
	return canonicalDirectory(path, "路径").catch(() => path);
}

function safeSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
}

async function git(
	cwd: string,
	args: readonly string[],
	extraEnvironment: Readonly<Record<string, string>> = {},
): Promise<string> {
	const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
		windowsHide: true,
		env: isolatedGitEnvironment(extraEnvironment),
	});
	return stdout;
}

function isolatedGitEnvironment(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
	const environment = { ...process.env };
	for (const key of Object.keys(environment)) {
		if (key.startsWith("GIT_")) delete environment[key];
	}
	return {
		...environment,
		GIT_OPTIONAL_LOCKS: "0",
		GIT_TERMINAL_PROMPT: "0",
		...extra,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function stripLine(value: string): string {
	return value.replace(/\r?\n$/, "");
}

function isMissingFileError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function decodeHostState(value: unknown): HostState {
	if (!isRecord(value) || value.version !== 2) throw new Error("工作目录宿主记录版本无效。");
	if (!isRecord(value.creates) || !isRecord(value.cleanups))
		throw new Error("工作目录宿主记录缺少 creates 或 cleanups。");
	const creates: Record<string, RequestRecord> = {};
	for (const [requestId, raw] of Object.entries(value.creates)) {
		requestIdPart(requestId);
		if (!isRecord(raw) || typeof raw.fingerprint !== "string") throw new Error("工作目录创建幂等记录格式无效。");
		if (raw.status !== "pending" && raw.status !== "completed") throw new Error("工作目录创建受理状态无效。");
		if (typeof raw.taskRoot !== "string" || !raw.taskRoot.trim())
			throw new Error("工作目录创建受理记录缺少 taskRoot。");
		if (raw.displayName !== undefined && typeof raw.displayName !== "string")
			throw new Error("工作目录创建 displayName 格式无效。");
		const displayName = typeof raw.displayName === "string" ? raw.displayName : "";
		if (!isRecord(raw.target)) throw new Error("工作目录创建受理记录缺少目标。");
		const targetFields = ["path", "branchName", "sourceHead", "treeId", "snapshotRepositoryPath"] as const;
		for (const field of targetFields) {
			if (typeof raw.target[field] !== "string" || !(raw.target[field] as string).trim())
				throw new Error(`工作目录创建目标 ${field} 格式无效。`);
		}
		const baseline = decodeBaseline(raw.baseline);
		if (
			baseline.sourceHead !== raw.target.sourceHead ||
			baseline.treeId !== raw.target.treeId ||
			baseline.snapshotRepositoryPath !== raw.target.snapshotRepositoryPath
		)
			throw new Error("工作目录创建目标与来源基线不一致。");
		if (raw.fingerprint !== requestFingerprint([requestId, raw.taskRoot, displayName]))
			throw new Error("工作目录创建 request fingerprint 校验失败。");
		const binding =
			raw.status === "completed"
				? decodeBinding(raw.binding)
				: raw.binding === undefined
					? undefined
					: (() => {
							throw new Error("待完成工作目录受理记录不能包含 binding。");
						})();
		if (
			binding &&
			(binding.kind !== "managed" ||
				binding.taskRoot !== raw.taskRoot ||
				binding.executionRoot !== raw.target.path ||
				binding.branchName !== raw.target.branchName)
		)
			throw new Error("工作目录完成记录与受理目标不一致。");
		creates[requestId] = {
			status: raw.status,
			fingerprint: raw.fingerprint,
			taskRoot: raw.taskRoot,
			displayName,
			target: {
				path: raw.target.path as string,
				branchName: raw.target.branchName as string,
				sourceHead: raw.target.sourceHead as string,
				treeId: raw.target.treeId as string,
				snapshotRepositoryPath: raw.target.snapshotRepositoryPath as string,
			},
			baseline,
			...(binding ? { binding } : {}),
		};
	}
	const cleanups: Record<string, CleanupRecord> = {};
	for (const [requestId, raw] of Object.entries(value.cleanups)) {
		requestIdPart(requestId);
		if (!isRecord(raw) || typeof raw.fingerprint !== "string" || !isRecord(raw.result))
			throw new Error("工作目录清理幂等记录格式无效。");
		const result = raw.result;
		if (result.ok === true) {
			if (typeof result.released !== "boolean") throw new Error("工作目录清理成功记录缺少 released。");
			if (result.branchDeleted !== undefined && typeof result.branchDeleted !== "boolean")
				throw new Error("工作目录清理 branchDeleted 格式无效。");
			cleanups[requestId] = {
				fingerprint: raw.fingerprint,
				result: {
					ok: true,
					released: result.released,
					...(result.branchDeleted !== undefined ? { branchDeleted: result.branchDeleted } : {}),
				},
			};
		} else if (result.ok === false) {
			if (result.retained !== true || typeof result.reason !== "string" || !result.reason.trim())
				throw new Error("工作目录清理保留记录格式无效。");
			cleanups[requestId] = {
				fingerprint: raw.fingerprint,
				result: { ok: false, retained: true, reason: result.reason },
			};
		} else {
			throw new Error("工作目录清理结果缺少 ok。");
		}
	}
	return { version: 2, creates, cleanups };
}

function emptyState(): HostState {
	return { version: 2, creates: {}, cleanups: {} };
}

function decodeBinding(value: unknown): WorktreeBinding {
	if (!isRecord(value)) throw new Error("工作目录绑定不是对象。");
	const required = requiredBindingStrings(value);
	if (value.kind === "primary") {
		const binding = primaryBinding(required.taskRoot, {
			repositoryRoot: required.taskRoot,
			commonGitDir: required.commonGitDir,
			sourceHead: required.inputVersion,
		});
		if (required.bindingDigest !== binding.bindingDigest) throw new Error("主目录绑定摘要校验失败。");
		return binding;
	}
	if (value.kind !== "managed") throw new Error("工作目录绑定 kind 无效。");
	if (typeof value.worktreeId !== "string" || !value.worktreeId.trim())
		throw new Error("受管工作目录绑定缺少 worktreeId。");
	if (typeof value.branchName !== "string" || !value.branchName.startsWith("pi/"))
		throw new Error("受管工作目录绑定 branchName 无效。");
	const baseline = decodeBaseline(value.baseline);
	if (baseline.inputVersion !== required.inputVersion) throw new Error("工作目录绑定与基线 inputVersion 不一致。");
	if (value.currentTreeId !== undefined && typeof value.currentTreeId !== "string")
		throw new Error("currentTreeId 格式无效。");
	const binding: ManagedWorktreeBinding = {
		kind: "managed",
		worktreeId: value.worktreeId,
		taskRoot: required.taskRoot,
		executionRoot: required.executionRoot,
		commonGitDir: required.commonGitDir,
		branchName: value.branchName,
		inputVersion: required.inputVersion,
		bindingDigest: "",
		baseline,
		...(typeof value.currentTreeId === "string" ? { currentTreeId: value.currentTreeId } : {}),
	};
	const expected = bindingDigest(binding);
	if (required.bindingDigest !== expected) throw new Error("受管工作目录绑定摘要校验失败。");
	return { ...binding, bindingDigest: expected };
}

function requiredBindingStrings(value: Record<string, unknown>): {
	taskRoot: string;
	executionRoot: string;
	commonGitDir: string;
	inputVersion: string;
	bindingDigest: string;
} {
	const fields = ["taskRoot", "executionRoot", "commonGitDir", "inputVersion", "bindingDigest"] as const;
	const result = Object.fromEntries(
		fields.map((field) => {
			const item = value[field];
			if (typeof item !== "string") throw new Error(`工作目录绑定 ${field} 格式无效。`);
			return [field, item];
		}),
	) as Record<(typeof fields)[number], string>;
	if (!result.taskRoot.trim() || !result.executionRoot.trim() || !result.inputVersion.trim())
		throw new Error("工作目录绑定缺少必要路径或输入版本。");
	if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(result.bindingDigest)) throw new Error("工作目录 bindingDigest 格式无效。");
	// 旧宿主记录使用裸十六进制摘要；只在内存中补齐内核约定的算法前缀，
	// 随后仍重新计算并核对内容，不因读取而改写原有记录。
	if (!result.bindingDigest.startsWith("sha256:")) result.bindingDigest = `sha256:${result.bindingDigest}`;
	return result;
}

function decodeBaseline(value: unknown): WorktreeBaselineProof {
	if (!isRecord(value)) throw new Error("工作目录基线不是对象。");
	const stringFields = [
		"sourceRoot",
		"sourceHead",
		"treeId",
		"snapshotRepositoryPath",
		"inputVersion",
		"capturedAt",
	] as const;
	for (const field of stringFields) {
		if (typeof value[field] !== "string" || !value[field].trim()) throw new Error(`工作目录基线 ${field} 格式无效。`);
	}
	if (
		!Number.isSafeInteger(value.fileCount) ||
		(value.fileCount as number) < 0 ||
		!Number.isSafeInteger(value.byteCount) ||
		(value.byteCount as number) < 0
	)
		throw new Error("工作目录基线文件或字节计数无效。");
	if (value.coverage !== "complete") throw new Error("工作目录基线覆盖不是 complete。");
	const lists = ["includedPaths", "excludedPaths", "notes"] as const;
	for (const field of lists) {
		if (!Array.isArray(value[field]) || !value[field].every((item) => typeof item === "string"))
			throw new Error(`工作目录基线 ${field} 格式无效。`);
	}
	return {
		sourceRoot: value.sourceRoot as string,
		sourceHead: value.sourceHead as string,
		treeId: value.treeId as string,
		snapshotRepositoryPath: value.snapshotRepositoryPath as string,
		inputVersion: value.inputVersion as string,
		capturedAt: value.capturedAt as string,
		fileCount: value.fileCount as number,
		byteCount: value.byteCount as number,
		coverage: "complete",
		includedPaths: [...(value.includedPaths as string[])],
		excludedPaths: [...(value.excludedPaths as string[])],
		notes: [...(value.notes as string[])],
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
