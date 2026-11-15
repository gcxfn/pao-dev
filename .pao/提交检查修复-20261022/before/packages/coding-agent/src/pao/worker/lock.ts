import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import * as path from "node:path";

import lockfile from "proper-lockfile";

import { isLockHeldError } from "../shared/lock.ts";
import { logWarn } from "../shared/log.ts";
import { pathKey } from "../shared/path-key.ts";
import { utcNow } from "../shared/time.ts";
import { PaoWorkerError } from "./errors.ts";
import { StopProof } from "./runner.ts";

/**
 * 派发锁只约束受 PAO 调度的写入，不冒充拦截外部编辑器。
 *
 * 两把锁分工固定：
 * - `execution`：从认领前一直持有到 runner 确认停止；键是规范化 executionRoot，
 *   不同 worktree 可并行，同一 worktree 跨进程互斥；
 * - `shared`：只覆盖任务根上的卡、工作流、认领、冻结、绑定、验证和回执短事务；
 *   它不随 worker 生命周期长期占用，因此不同 executionRoot 可以并行。
 *
 * 锁序永远是 execution -> shared，禁止反向获取。执行锁不设置按时间自动过期的 stale；
 * proper-lockfile 自身心跳会刷新 mtime，但等待者不能因为持有时间较长就抢锁。
 * 这是“崩溃/取消停止未确认时不自动恢复派发”的硬边界。
 *
 * proper-lockfile 的租约仍可能在进程崩溃且 24 小时无人操作后失效。因此执行锁另有一份
 * 原子持久占位：它只在带合法 StopProof 的释放中移除，不因为心跳停止或时间经过而自动回收。
 * 占位建立失败时 fail-closed；持有者崩溃后须由后续显式人工恢复流程清理，普通 acquire 永不清。
 */

export type DispatchLockKind = "execution" | "shared";

export interface DispatchWriteLock {
	kind: DispatchLockKind;
	/** realpath 规范化后的锁根。 */
	root: string;
	lockPath: string;
	holder: string;
	acquiredAt: string;
}

/**
 * taskRoot 侧的 executionRoot 占用状态。
 *
 * unknown 必须按“可能仍有任务”处理；只有明确读到 idle 才能进入清理。
 */
export type ExecutionOccupancy = "active" | "idle" | "unknown";

export interface ExecutionRootGuardOptions {
	taskRoot: string;
	executionRoot: string;
	holder: string;
	signal?: AbortSignal;
	logPath?: string;
}

export interface ExecutionRootGuard {
	readonly taskRoot: string;
	readonly executionRoot: string;
	readonly holder: string;
	readonly acquiredAt: string;
	readonly occupancy: ExecutionOccupancy;
	release(): Promise<void>;
}

export interface ReleasedExecutionArtifact {
	readonly kind: "lock-marker" | "lock-directory" | "dispatch-log";
	readonly path: string;
	readonly action: "retained" | "archived" | "removed";
	readonly archivedPath?: string;
}

export interface PrepareExecutionRootForRemovalOptions {
	guard: ExecutionRootGuard;
	/** 任务根侧持久证据目录；必须位于任务根内、执行根外。 */
	archiveRoot: string;
	signal?: AbortSignal;
}

/** 旧公共名保留；新调用应显式使用 acquireExecutionLock/acquireSharedLock。 */
export type ProjectWriteLock = DispatchWriteLock;

export interface AcquireLockOptions {
	root?: string;
	/** 旧调用兼容；等同 root。 */
	项目根?: string;
	holder?: string;
	/** 旧调用兼容；等同 holder。 */
	持有者?: string;
	retries?: number;
	/** 旧调用兼容。 */
	重试?: number;
	/** 执行长锁排队：true 使用有限次数退避等待；共享短锁已有调用方自己的短事务语义。 */
	wait?: boolean;
	signal?: AbortSignal;
	/** 锁操作日志；缺省写 <root>/.pao/派发日志.jsonl。 */
	logPath?: string;
}

interface PendingLock {
	/** 租约释放状态只在本阶段成功后推进；失败时保留句柄，供调用方重试或人工处理。 */
	releaseState: "lease-held" | "lease-released";
	/** 租约已经确认释放后置空；占位删除可以继续幂等重试。 */
	release?: () => Promise<void>;
	logPath: string;
	/** 执行锁的原子持久占位；共享短锁没有。 */
	reservationPath?: string;
	/** 保留锁时由调用方提供的证据，在最终释放审计中一并记录。 */
	retainReason?: string;
	retainDetails?: Record<string, unknown>;
}

const pending = new WeakMap<DispatchWriteLock, PendingLock>();
const pendingGuards = new WeakMap<
	ExecutionRootGuard,
	{ release: () => Promise<void>; released: boolean; logPath: string; guardPath: string }
>();

/**
 * proper-lockfile 会把 `stale:0` 强制抬到 2 秒，并把过大的 update 也钳制成 1 毫秒，
 * 因此不能把 0 当“永不过期”。这里以派发超时上限（24 小时）为租约，心跳 1 小时；
 * 正常派发在到期前会得到明确的停止/超时回执，停止未确认则保留锁供人工裁决。
 */
const DISPATCH_LOCK_LEASE_MS = 24 * 60 * 60 * 1000;
const DISPATCH_LOCK_HEARTBEAT_MS = 60 * 60 * 1000;

const LOCK_META: Record<DispatchLockKind, { marker: string; directory: string }> = {
	execution: { marker: "执行锁", directory: "执行锁.lock" },
	shared: { marker: "共享锁", directory: "共享锁.lock" },
};

const EXECUTION_RESERVATION = "执行占位.json";

export function dispatchLockLogPath(root: string): string {
	return path.join(root, ".pao", "派发日志.jsonl");
}

/**
 * 列出 `prepareExecutionRootForRemoval` 可能处置的运行元数据，不读取内容、不递归。
 *
 * 宿主应先从 Git untracked 清单中剔除这些仅由 PAO 创建的路径，再判断是否还有
 * 用户或其他任务留下的内容。损坏的持久占位不在这里，也不能被清理流程猜作可删除项。
 */
export function listReleasedExecutionArtifacts(executionRoot: string): string[] {
	const paoDir = path.join(path.resolve(executionRoot), ".pao");
	return [
		path.join(paoDir, LOCK_META.execution.marker),
		`${path.join(paoDir, LOCK_META.execution.marker)}.lock`,
		path.join(paoDir, "派发日志.jsonl"),
	].filter((candidate) => existsSync(candidate));
}

function appendLog(file: string, event: Record<string, unknown>): void {
	try {
		mkdirSync(path.dirname(file), { recursive: true });
		appendFileSync(file, `${JSON.stringify({ type: "pao_dispatch_lock", time: utcNow(), ...event })}\n`, "utf8");
	} catch (error) {
		const errorCode =
			(error as NodeJS.ErrnoException | undefined)?.code !== undefined
				? ` code=${(error as NodeJS.ErrnoException).code}`
				: "";
		const nestedCause =
			error instanceof Error && error.cause !== undefined
				? ` cause=${error.cause instanceof Error ? error.cause.message : String(error.cause)}`
				: "";
		logWarn(
			`[pao] 派发锁日志写入失败（互斥仍按现场继续，审计记录缺失）:${file}:${
				error instanceof Error ? error.message : String(error)
			}${errorCode}${nestedCause}`,
		);
	}
}

async function createExecutionReservation(
	paoDir: string,
	details: Record<string, unknown> & { root: string; holder: string; acquiredAt: string },
): Promise<string> {
	const reservationPath = path.join(paoDir, EXECUTION_RESERVATION);
	try {
		await writeFile(
			reservationPath,
			`${JSON.stringify({
				type: "pao_execution_reservation",
				holder: details.holder,
				root: details.root,
				acquiredAt: details.acquiredAt,
				pid: process.pid,
			})}\n`,
			{ encoding: "utf8", flag: "wx" },
		);
		return reservationPath;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		let existing = "";
		try {
			existing = readFileSync(reservationPath, "utf8").trim();
		} catch {
			// 读取失败和存在占位一样 fail-closed；不猜是否应当回收。
		}
		throw new PaoWorkerError("锁被占用", `执行根存在持久占位，未确认停止前拒绝重新派发:${reservationPath}`, {
			占位路径: reservationPath,
			占位内容: existing,
		});
	}
}

async function canonicalDir(dir: string | undefined, label: string): Promise<string> {
	if (!dir?.trim()) throw new PaoWorkerError("无效参数", `${label}不能为空`);
	try {
		return await realpath(dir);
	} catch (error) {
		throw new PaoWorkerError("无效参数", `${label}不存在:${dir}`, {
			[label]: dir,
			cause: error instanceof Error ? error.message : String(error),
		});
	}
}

function normalizeOptions(
	options: AcquireLockOptions,
): Required<Pick<AcquireLockOptions, "retries">> &
	Pick<AcquireLockOptions, "signal" | "logPath" | "wait"> & { root: string | undefined; holder: string } {
	return {
		root: options.root ?? options.项目根,
		holder: options.holder ?? options.持有者 ?? "未命名",
		retries: options.retries ?? options.重试 ?? 0,
		wait: options.wait ?? false,
		...(options.signal ? { signal: options.signal } : {}),
		...(options.logPath ? { logPath: options.logPath } : {}),
	};
}

function executionRootGuardName(executionRoot: string): string {
	return createHash("sha256").update(pathKey(executionRoot), "utf8").digest("hex");
}

function executionOccupancyFromReservation(content: string): ExecutionOccupancy {
	try {
		const value = JSON.parse(content) as { type?: unknown; root?: unknown };
		if (value.type !== "pao_execution_reservation" || typeof value.root !== "string" || !value.root.trim())
			return "unknown";
		return "active";
	} catch {
		return "unknown";
	}
}

/**
 * 只读检测执行根的真实占用。
 *
 * 持久占位必须优先读取：即使 proper-lockfile 因崩溃或超时误判租约失活，
 * 只要占位还在、内容坏或 owner 已死，都不能返回 idle。
 */
export async function detectExecutionOccupancy(executionRoot: string): Promise<ExecutionOccupancy> {
	try {
		const root = await canonicalDir(executionRoot, "执行根");
		const paoDir = path.join(root, ".pao");
		const reservationPath = path.join(paoDir, EXECUTION_RESERVATION);
		if (existsSync(reservationPath)) {
			const content = await readFile(reservationPath, "utf8");
			return executionOccupancyFromReservation(content);
		}
		const lockPath = `${path.join(paoDir, LOCK_META.execution.marker)}.lock`;
		if (!existsSync(lockPath)) return "idle";
		return (await lockfile.check(path.join(paoDir, LOCK_META.execution.marker), {
			realpath: false,
			stale: DISPATCH_LOCK_LEASE_MS,
		}))
			? "active"
			: "idle";
	} catch {
		// 路径消失、权限错误和锁检查异常都不证明安全；清理侧必须保留现场。
		return "unknown";
	}
}

export async function acquireExecutionRootGuard(options: ExecutionRootGuardOptions): Promise<ExecutionRootGuard> {
	const taskRoot = await canonicalDir(options.taskRoot, "任务根");
	const requestedExecutionRoot = path.resolve(options.executionRoot);
	const executionRoot = await canonicalDir(requestedExecutionRoot, "执行根");
	if (pathKey(taskRoot) === pathKey(executionRoot))
		throw new PaoWorkerError("无效参数", "执行根与任务根相同，没有可独立清理的任务根侧守卫");
	const guardDir = path.join(taskRoot, ".pao", "执行根守卫");
	await mkdir(guardDir, { recursive: true });
	const guardPath = path.join(guardDir, `${executionRootGuardName(executionRoot)}.json`);
	await writeFile(guardPath, "", { flag: "a" });
	const logPath = options.logPath ? path.resolve(options.logPath) : dispatchLockLogPath(taskRoot);
	const holder = options.holder.trim();
	if (!holder) throw new PaoWorkerError("无效参数", "执行根守卫持有者不能为空");
	appendLog(logPath, {
		action: "guard_wait",
		kind: "cleanup",
		taskRoot,
		executionRoot,
		guardPath,
		holder,
	});
	let releaseLease: (() => Promise<void>) | undefined;
	try {
		releaseLease = await lockfile.lock(guardPath, {
			realpath: false,
			stale: DISPATCH_LOCK_LEASE_MS,
			update: DISPATCH_LOCK_HEARTBEAT_MS,
			retries: { retries: 0 },
			onCompromised: (error) => {
				appendLog(logPath, {
					action: "guard_lease_compromised",
					kind: "cleanup",
					taskRoot,
					executionRoot,
					guardPath,
					holder,
					error: error.message,
				});
			},
		});
		options.signal?.throwIfAborted();
		const canonicalAgain = await realpath(requestedExecutionRoot);
		if (pathKey(canonicalAgain) !== pathKey(executionRoot))
			throw new PaoWorkerError("锁被占用", "执行根在守卫获取期间被替换，拒绝继续", {
				expected: executionRoot,
				actual: canonicalAgain,
			});
		const occupancy = await detectExecutionOccupancy(executionRoot);
		let released = false;
		const guard: ExecutionRootGuard = {
			taskRoot,
			executionRoot,
			holder,
			acquiredAt: utcNow(),
			occupancy,
			async release() {
				const record = pendingGuards.get(guard);
				if (!record) throw new PaoWorkerError("无效凭据", "执行根守卫句柄无效或已释放");
				if (record.released) return;
				try {
					await record.release();
					record.released = true;
					released = true;
					pendingGuards.delete(guard);
					appendLog(record.logPath, {
						action: "guard_released",
						kind: "cleanup",
						taskRoot,
						executionRoot,
						guardPath,
						holder,
					});
				} finally {
					// 释放失败时 pendingGuards 保留句柄，下一次 release 会重试。
				}
			},
		};
		pendingGuards.set(guard, {
			release: releaseLease!,
			released,
			logPath,
			guardPath,
		});
		releaseLease = undefined;
		appendLog(logPath, {
			action: "guard_acquired",
			kind: "cleanup",
			taskRoot,
			executionRoot,
			guardPath,
			holder,
			occupancy,
		});
		return guard;
	} catch (error) {
		if (releaseLease) {
			try {
				await releaseLease();
			} catch (releaseError) {
				appendLog(logPath, {
					action: "guard_acquire_rollback_failed",
					kind: "cleanup",
					taskRoot,
					executionRoot,
					guardPath,
					holder,
					error: releaseError instanceof Error ? releaseError.message : String(releaseError),
				});
				throw new PaoWorkerError("锁被占用", "执行根守卫获取后回滚失败，保留失败现场", {
					guardPath,
					cause: releaseError instanceof Error ? releaseError.message : String(releaseError),
					originalError: error instanceof Error ? error.message : String(error),
				});
			}
		}
		appendLog(logPath, {
			action: "guard_acquire_failed",
			kind: "cleanup",
			taskRoot,
			executionRoot,
			guardPath,
			holder,
			error: error instanceof Error ? error.message : String(error),
		});
		if (isLockHeldError(error))
			throw new PaoWorkerError("锁被占用", `执行根已有清理或占用守卫:${guardPath}`, {
				guardPath,
				cause: String(error),
			});
		throw error;
	}
}

/**
 * 正常停止后的受管运行元数据处置。
 *
 * 调用方必须先持 executionRoot guard，并在调用前再次确认 occupancy 为 idle。
 * 只归档本实现创建的锁标记和派发日志，不递归删除 .pao，不碰其他文件；
 * 任一复制、目标校验或原始文件删除失败都保留 guard 和现有文件，调用方不得继续删执行根。
 */
export async function prepareExecutionRootForRemoval(
	options: PrepareExecutionRootForRemovalOptions,
): Promise<readonly ReleasedExecutionArtifact[]> {
	options.signal?.throwIfAborted();
	const record = pendingGuards.get(options.guard);
	if (!record || record.released) throw new PaoWorkerError("无效凭据", "执行根 guard 无效或已释放");
	const occupancy = await detectExecutionOccupancy(options.guard.executionRoot);
	if (occupancy !== "idle")
		throw new PaoWorkerError("锁被占用", `执行根占用状态不是 idle，拒绝处置运行元数据:${occupancy}`);
	const taskRoot = await canonicalDir(options.guard.taskRoot, "任务根");
	const requestedArchiveRoot = path.resolve(options.archiveRoot);
	await mkdir(path.dirname(requestedArchiveRoot), { recursive: true });
	const archiveParent = await canonicalDir(path.dirname(requestedArchiveRoot), "运行证据归档父目录");
	const archiveRoot = path.join(archiveParent, path.basename(requestedArchiveRoot));
	if (!isPathInside(taskRoot, archiveRoot) || isPathInside(options.guard.executionRoot, archiveRoot))
		throw new PaoWorkerError("无效参数", "运行证据归档目录必须位于任务根内、执行根外", {
			taskRoot,
			executionRoot: options.guard.executionRoot,
			archiveRoot,
		});
	await mkdir(archiveRoot, { recursive: true });
	const paoDir = path.join(options.guard.executionRoot, ".pao");
	const candidates: { kind: ReleasedExecutionArtifact["kind"]; path: string }[] = [
		{ kind: "lock-marker", path: path.join(paoDir, LOCK_META.execution.marker) },
		{ kind: "lock-directory", path: `${path.join(paoDir, LOCK_META.execution.marker)}.lock` },
		{ kind: "dispatch-log", path: path.join(paoDir, "派发日志.jsonl") },
	];
	const result: ReleasedExecutionArtifact[] = [];
	for (const candidate of candidates) {
		options.signal?.throwIfAborted();
		if (!existsSync(candidate.path)) continue;
		if (candidate.kind === "lock-directory") {
			// 只在占用状态已明确 idle 且目录为空时删除；未知内容保留，交给人工盘点。
			try {
				await rmdir(candidate.path);
				appendLog(record.logPath, {
					action: "execution_runtime_artifact_removed",
					kind: "cleanup",
					executionRoot: options.guard.executionRoot,
					guardPath: record.guardPath,
					artifact: candidate,
				});
				result.push({ ...candidate, action: "removed" });
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENOENT") continue;
				result.push({ ...candidate, action: "retained" });
				throw new PaoWorkerError("停止失败", `锁目录非空或无法安全移除，保留现场:${candidate.path}`, {
					artifacts: result,
					cause: error instanceof Error ? error.message : String(error),
				});
			}
			continue;
		}
		const archivedPath = path.join(
			archiveRoot,
			`${candidate.kind}-${executionRootGuardName(options.guard.executionRoot)}`,
		);
		try {
			const existing = existsSync(archivedPath) ? await readFile(archivedPath, "utf8") : "";
			const content = await readFile(candidate.path, "utf8");
			if (existing && existing !== content)
				throw new PaoWorkerError("无效参数", "运行元数据归档目标已有不同内容，拒绝覆盖", {
					source: candidate.path,
					archive: archivedPath,
				});
			if (!existing) await writeFile(archivedPath, content, { encoding: "utf8", flag: "wx" });
			const archived = await readFile(archivedPath, "utf8");
			if (archived !== content)
				throw new PaoWorkerError("无效参数", "运行元数据归档后内容不一致，保留原文件", {
					source: candidate.path,
					archive: archivedPath,
				});
			await rm(candidate.path);
			result.push({ ...candidate, action: "archived", archivedPath });
		} catch (error) {
			result.push({ ...candidate, action: "retained" });
			throw new PaoWorkerError("停止失败", `运行元数据处置失败，保留全部现场:${candidate.path}`, {
				artifacts: result,
				cause: error instanceof Error ? error.message : String(error),
			});
		}
	}
	// 锁文件用于 proper-lockfile 的兄弟锁目录，正常释放后可能仍留一个空 marker；
	// 上面的非递归删除已处理。其它 .pao 内容不在此处猜测所有权。
	appendLog(record.logPath, {
		action: "execution_runtime_artifacts_prepared",
		kind: "cleanup",
		taskRoot,
		executionRoot: options.guard.executionRoot,
		guardPath: record.guardPath,
		artifacts: result,
	});
	return result;
}

function isPathInside(parent: string, child: string): boolean {
	const normalizedParent = path.resolve(parent).replace(/[\\/]+$/, "");
	const normalizedChild = path.resolve(child);
	const relative = path.relative(normalizedParent, normalizedChild);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function acquire(
	kind: DispatchLockKind,
	options: AcquireLockOptions,
	details: Record<string, unknown> = {},
): Promise<DispatchWriteLock> {
	const normalized = normalizeOptions(options);
	const root = await canonicalDir(normalized.root, kind === "execution" ? "执行根" : "任务根");
	const paoDir = path.join(root, ".pao");
	const logPath = normalized.logPath ? path.resolve(normalized.logPath) : dispatchLockLogPath(root);
	const meta = LOCK_META[kind];
	const lockPath = path.join(paoDir, meta.marker);
	await mkdir(paoDir, { recursive: true });
	await writeFile(lockPath, "", { flag: "a" });
	const requestedAt = utcNow();
	let reservationPath: string | undefined;
	appendLog(logPath, {
		action: "wait",
		kind,
		root,
		lockPath,
		holder: normalized.holder,
		retries: normalized.retries,
		requestedAt,
		...details,
	});

	let release: (() => Promise<void>) | undefined;
	let acquired = false;
	let reservationCreationDeferred = false;
	try {
		if (kind === "execution") {
			// 同根排队时先等租约，避免把前序持有者的持久占位误判为崩溃残留。
			// 仍保持 execution -> reservation 的创建顺序，前序未正常释放时占位继续阻止抢入。
			if (normalized.wait) {
				release = await lockfile.lock(lockPath, {
					realpath: false,
					stale: DISPATCH_LOCK_LEASE_MS,
					update: DISPATCH_LOCK_HEARTBEAT_MS,
					retries: {
						retries: normalized.retries === 0 ? 60 : normalized.retries,
						minTimeout: 100,
						maxTimeout: 1000,
						factor: 2,
						randomize: false,
					},
				});
				acquired = true;
				normalized.signal?.throwIfAborted();
				reservationCreationDeferred = true;
			}
			if (!reservationCreationDeferred)
				reservationPath = await createExecutionReservation(paoDir, {
					root,
					holder: normalized.holder,
					acquiredAt: utcNow(),
				});
		}
		if (!release) {
			release = await lockfile.lock(lockPath, {
				realpath: false,
				stale: DISPATCH_LOCK_LEASE_MS,
				update: DISPATCH_LOCK_HEARTBEAT_MS,
				retries: {
					retries: normalized.retries,
					minTimeout: 100,
					maxTimeout: 1000,
					factor: 2,
					randomize: false,
				},
			});
			acquired = true;
			normalized.signal?.throwIfAborted();
		}
		if (reservationCreationDeferred) {
			reservationPath = await createExecutionReservation(paoDir, {
				root,
				holder: normalized.holder,
				acquiredAt: utcNow(),
			});
		}
	} catch (error) {
		if (acquired && release) {
			try {
				await release();
				release = undefined;
				acquired = false;
			} catch (releaseError) {
				appendLog(logPath, {
					action: "acquire_rollback_failed",
					kind,
					root,
					lockPath,
					holder: normalized.holder,
					error: releaseError instanceof Error ? releaseError.message : String(releaseError),
					...details,
				});
				throw new PaoWorkerError("锁被占用", `锁获取后取消，但租约回滚失败；拒绝留下谎称已释放的锁:${lockPath}`, {
					kind,
					锁路径: lockPath,
					cause: releaseError instanceof Error ? releaseError.message : String(releaseError),
				});
			}
		}
		if (reservationPath) {
			try {
				await rm(reservationPath, { force: true });
			} catch (cleanupError) {
				appendLog(logPath, {
					action: "acquire_reservation_cleanup_failed",
					kind,
					root,
					lockPath,
					reservationPath,
					error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
					...details,
				});
				throw new PaoWorkerError(
					"锁被占用",
					`锁获取失败且持久占位未清理，按 fail-closed 保留现场:${reservationPath}`,
					{
						kind,
						锁路径: lockPath,
						占位路径: reservationPath,
						cause: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
						原始错误: error instanceof Error ? error.message : String(error),
					},
				);
			}
		}
		appendLog(logPath, {
			action: "acquire_failed",
			kind,
			root,
			lockPath,
			holder: normalized.holder,
			error: error instanceof Error ? error.message : String(error),
			...details,
		});
		if (isLockHeldError(error)) {
			throw new PaoWorkerError(
				"锁被占用",
				`${kind === "execution" ? "执行根" : "任务根"}${kind === "execution" ? "执行" : "共享"}锁被占用:${lockPath}`,
				{ kind, 锁路径: lockPath, cause: String(error) },
			);
		}
		throw error;
	}
	const lock: DispatchWriteLock = {
		kind,
		root,
		lockPath,
		holder: normalized.holder,
		acquiredAt: utcNow(),
	};
	pending.set(lock, {
		releaseState: "lease-held",
		release,
		logPath,
		...(reservationPath ? { reservationPath } : {}),
	});
	appendLog(logPath, {
		action: "acquired",
		kind,
		root,
		lockPath,
		holder: normalized.holder,
		acquiredAt: lock.acquiredAt,
		waitedMs: Date.parse(lock.acquiredAt) - Date.parse(requestedAt),
		...details,
	});
	return lock;
}

/** 按 executionRoot 取长锁；租约心跳之外另受不会自动过期的持久占位保护。 */
export function acquireExecutionLock(options: AcquireLockOptions): Promise<DispatchWriteLock> {
	return acquire("execution", options);
}

/** 按 taskRoot 取短事务锁；调用方必须把持锁区间收窄到状态读写，不得覆盖 runner 全程。 */
export function acquireSharedLock(options: AcquireLockOptions): Promise<DispatchWriteLock> {
	return acquire("shared", options);
}

/**
 * 旧接口兼容：过去“项目锁”按项目根创建共享锁，并覆盖整个执行期。
 * 新派发核心不再用它持有执行全程；裸调用仍保持旧名称与 StopProof 先停后放约束。
 */
export function acquireProjectLock(options: AcquireLockOptions): Promise<ProjectWriteLock> {
	return acquireSharedLock(options);
}

export async function releaseDispatchLock(
	lock: DispatchWriteLock,
	proof: StopProof,
	details: Record<string, unknown> = {},
): Promise<void> {
	if (!(proof instanceof StopProof)) {
		throw new PaoWorkerError("无效凭据", "释放派发锁必须出示运行器签发的停止确认凭据(先停后放锁)");
	}
	if (lock.kind !== "execution") {
		throw new PaoWorkerError("无效凭据", "共享锁是短事务锁，应使用 releaseSharedLock 释放");
	}
	const record = pending.get(lock);
	if (!record) {
		throw new PaoWorkerError("无效凭据", "锁句柄无效或已释放", { 锁路径: lock.lockPath });
	}
	try {
		if (record.releaseState === "lease-held") {
			if (!record.release) {
				throw new PaoWorkerError("无效凭据", "执行锁缺少租约释放句柄，保留占位等待人工处理", {
					锁路径: lock.lockPath,
				});
			}
			const release = record.release;
			await release();
			record.release = undefined;
			record.releaseState = "lease-released";
		}
		if (record.reservationPath) await rm(record.reservationPath, { force: true });
		record.reservationPath = undefined;
		pending.delete(lock);
		appendLog(record.logPath, {
			action: "released",
			kind: lock.kind,
			root: lock.root,
			lockPath: lock.lockPath,
			holder: lock.holder,
			acquiredAt: lock.acquiredAt,
			releasedAt: utcNow(),
			stoppedProcesses: proof.stoppedProcesses.map((item) => item.pid),
			...(record.retainReason ? { retainReason: record.retainReason } : {}),
			...(record.retainDetails ? { retainDetails: record.retainDetails } : {}),
			...details,
		});
	} catch (error) {
		// 分阶段状态保存在句柄里：租约成功释放后不会再释放一次；重试只做尚未完成的占位删除。
		pending.set(lock, record);
		appendLog(record.logPath, {
			action: "release_failed",
			kind: lock.kind,
			root: lock.root,
			lockPath: lock.lockPath,
			holder: lock.holder,
			error: error instanceof Error ? error.message : String(error),
			...details,
		});
		throw error;
	}
}

/** 共享锁只覆盖短事务，不需要进程停止凭据。 */
export async function releaseSharedLock(lock: DispatchWriteLock): Promise<void> {
	if (lock.kind !== "shared") {
		throw new PaoWorkerError("无效凭据", "执行长锁必须凭 StopProof 释放");
	}
	const record = pending.get(lock);
	if (!record) throw new PaoWorkerError("无效凭据", "锁句柄无效或已释放", { 锁路径: lock.lockPath });
	try {
		if (record.releaseState === "lease-released") {
			pending.delete(lock);
			return;
		}
		if (!record.release) {
			throw new PaoWorkerError("无效凭据", "共享锁缺少租约释放句柄，句柄保持占用", {
				锁路径: lock.lockPath,
			});
		}
		const release = record.release;
		await release();
		record.release = undefined;
		record.releaseState = "lease-released";
		pending.delete(lock);
		appendLog(record.logPath, {
			action: "released",
			kind: lock.kind,
			root: lock.root,
			lockPath: lock.lockPath,
			holder: lock.holder,
			acquiredAt: lock.acquiredAt,
			releasedAt: utcNow(),
			...(record.retainReason ? { retainReason: record.retainReason } : {}),
			...(record.retainDetails ? { retainDetails: record.retainDetails } : {}),
		});
	} catch (error) {
		pending.set(lock, record);
		appendLog(record.logPath, {
			action: "release_failed",
			kind: lock.kind,
			root: lock.root,
			lockPath: lock.lockPath,
			holder: lock.holder,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}

/** 旧公共名保留：旧项目锁已映射为共享短锁，但仍遵守原调用方的 StopProof 参数形状。 */
export async function releaseProjectLock(lock: ProjectWriteLock, proof: StopProof): Promise<void> {
	if (!(proof instanceof StopProof)) {
		throw new PaoWorkerError("无效凭据", "释放旧项目写锁必须出示运行器签发的停止确认凭据");
	}
	return releaseSharedLock(lock);
}

/** 停止未确认时明确保锁：记录证据，但故意不释放。 */
export function retainDispatchLock(
	lock: DispatchWriteLock,
	reason: string,
	details: Record<string, unknown> = {},
): void {
	const record = pending.get(lock);
	const logPath = record?.logPath ?? dispatchLockLogPath(lock.root);
	if (record) {
		record.retainReason = reason;
		record.retainDetails = details;
	}
	appendLog(logPath, {
		action: "retained",
		kind: lock.kind,
		root: lock.root,
		lockPath: lock.lockPath,
		holder: lock.holder,
		reason,
		...details,
	});
}

async function isLocked(rootValue: string, kind: DispatchLockKind, label?: string): Promise<boolean> {
	const root = await canonicalDir(rootValue, label ?? (kind === "execution" ? "执行根" : "任务根"));
	const paoDir = path.join(root, ".pao");
	if (kind === "execution" && existsSync(path.join(paoDir, EXECUTION_RESERVATION))) return true;
	const lockPath = path.join(paoDir, LOCK_META[kind].marker);
	return lockfile.check(lockPath, { realpath: false, stale: DISPATCH_LOCK_LEASE_MS });
}

export function isExecutionLocked(executionRoot: string): Promise<boolean> {
	return isLocked(executionRoot, "execution");
}

export function isSharedLocked(taskRoot: string): Promise<boolean> {
	return isLocked(taskRoot, "shared");
}

/** 旧查询兼容：查任务根共享锁。 */
export function isProjectLocked(projectRoot: string): Promise<boolean> {
	return isLocked(projectRoot, "shared", "项目根");
}

/** 测试和初始化工具用：显式写入标记文件，不获取锁。 */
export function ensureDispatchLockMarker(root: string, kind: DispatchLockKind): string {
	const paoDir = path.join(root, ".pao");
	mkdirSync(paoDir, { recursive: true });
	const marker = path.join(paoDir, LOCK_META[kind].marker);
	writeFileSync(marker, "", { flag: "a" });
	return marker;
}

/**
 * 仅供显式人工恢复的底层测试/维护口：验证 root 属于调用方后删除执行持久占位。
 * 普通派发代码不得调用；它不签发停止确认，也不试图证明进程已经退出。
 */
export async function clearExecutionReservationForRecovery(rootValue: string): Promise<string> {
	const root = await canonicalDir(rootValue, "执行根");
	const reservationPath = path.join(root, ".pao", EXECUTION_RESERVATION);
	await rm(reservationPath, { force: true });
	appendLog(dispatchLockLogPath(root), {
		action: "reservation_cleared_for_recovery",
		kind: "execution",
		root,
		lockPath: path.join(root, ".pao", LOCK_META.execution.marker),
		reservationPath,
	});
	return reservationPath;
}
