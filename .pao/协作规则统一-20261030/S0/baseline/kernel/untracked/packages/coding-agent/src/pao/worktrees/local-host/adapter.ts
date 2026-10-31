import type {
	ExecutionOccupancy,
	ExecutionRootGuard,
	ExecutionRootGuardOptions,
	PrepareExecutionRootForRemovalOptions,
} from "../../worker/lock.ts";

/** 检查点覆盖范围；不导入桌面契约，只保留共享宿主需要的字段。 */
export interface PaoLocalCheckpointCoverage {
	readonly state: "complete" | "partial";
	readonly notes: readonly string[];
}

interface PaoLocalCheckpointCaptureBase {
	readonly capturedAt: string;
	readonly coverage: PaoLocalCheckpointCoverage;
	readonly fileCount: number;
	readonly byteCount: number;
	readonly durationMs: number;
}

export type PaoLocalCheckpointCapture =
	| (PaoLocalCheckpointCaptureBase & {
			readonly state: "available";
			readonly treeOid: string;
	  })
	| (PaoLocalCheckpointCaptureBase & {
			readonly state: "unavailable";
			readonly code: string;
			readonly message: string;
	  });

/** 来源项目和新建工作树共用的内容树捕获能力。 */
export interface PaoLocalWorktreeCheckpointAdapter {
	readonly repositoryPath: string;
	capture(path: string, signal?: AbortSignal, timeoutMs?: number): Promise<PaoLocalCheckpointCapture>;
}

export interface PaoLocalWorktreeWorkspace {
	readonly workspaceId: string;
	readonly path: string;
	readonly displayName?: string;
}

/**
 * 这里只保留共享宿主实际使用的字段。桌面目录记录可以在结构上直接赋值，
 * 因而内核不依赖桌面的完整目录格式。
 */
export interface PaoLocalWorktreeCatalogEntry {
	readonly worktreeId: string;
	readonly workspaceId: string;
	readonly path: string;
	readonly kind: "primary" | "linked";
	readonly branchName?: string;
	readonly headSha?: string;
}

export interface PaoLocalWorktreeCatalogAdapter {
	getWorktree(worktreeId: string): Promise<PaoLocalWorktreeCatalogEntry | undefined>;
	listWorktrees(workspaceId?: string): Promise<{
		readonly worktrees: readonly PaoLocalWorktreeCatalogEntry[];
	}>;
	refreshWorktrees(
		workspace: PaoLocalWorktreeWorkspace,
		options?: { readonly claimPath?: string },
	): Promise<{
		readonly worktrees: readonly PaoLocalWorktreeCatalogEntry[];
	}>;
}

export interface PaoLocalCreateGitWorktreeInput {
	readonly path: string;
	readonly branchName: string;
	readonly startPoint: string;
	readonly displayName?: string;
}

/**
 * 适配器只负责创建 Git 工作树和登记目录。身份、基线、占用与清理判断
 * 全部由共享宿主负责。
 */
export interface PaoLocalWorktreeGitAdapter {
	createWorktree(
		workspace: PaoLocalWorktreeWorkspace,
		input: PaoLocalCreateGitWorktreeInput,
	): Promise<PaoLocalWorktreeCatalogEntry>;
}

/**
 * 共享宿主会先取得 `lockTarget`，再调用 load / save。适配器只读写具体状态文件，
 * 不能在事务内部再取第二把锁。
 */
export interface PaoLocalWorktreeStateAdapter {
	readonly lockTarget: string;
	load(): Promise<unknown | undefined>;
	save(state: PaoLocalWorktreeHostStoredState): Promise<void>;
}

/** 持久化记录在这里保持不透明，由 state.ts 负责唯一解码和校验。 */
export interface PaoLocalWorktreeHostStoredState {
	readonly version: 2;
	readonly creates: Readonly<Record<string, unknown>>;
	readonly cleanups: Readonly<Record<string, unknown>>;
}

export interface PaoLocalWorktreeRuntimeAdapter {
	detectExecutionOccupancy(executionRoot: string): Promise<ExecutionOccupancy>;
	acquireExecutionRootGuard(input: ExecutionRootGuardOptions): Promise<ExecutionRootGuard>;
	listReleasedExecutionArtifacts(executionRoot: string): readonly string[];
	prepareExecutionRootForRemoval(input: PrepareExecutionRootForRemovalOptions): Promise<unknown>;
}

export interface PaoLocalWorktreeHostOptions {
	readonly userDataDir: string;
	/** 可选项目范围；专门服务单个仓库的 CLI 或子进程宿主使用。 */
	readonly projectRoot?: string;
	readonly checkpoints: PaoLocalWorktreeCheckpointAdapter;
	readonly catalog: PaoLocalWorktreeCatalogAdapter;
	readonly git: PaoLocalWorktreeGitAdapter;
	readonly state: PaoLocalWorktreeStateAdapter;
	readonly runtime?: PaoLocalWorktreeRuntimeAdapter;
	readonly isManagedWorktreePath?: (path: string) => boolean | Promise<boolean>;
	readonly activeExecution?: (
		taskRoot: string,
		executionRoot: string,
	) => boolean | "unknown" | Promise<boolean | "unknown">;
	/** 测试用故障注入点：创建记录持久化后调用。 */
	readonly persistStateHook?: (phase: "pending" | "completed") => Promise<void>;
	/** 测试用故障注入点：Git 工作树已存在、完成记录尚未写入时调用。 */
	readonly afterWorktreeCreated?: (executionRoot: string) => Promise<void>;
}
