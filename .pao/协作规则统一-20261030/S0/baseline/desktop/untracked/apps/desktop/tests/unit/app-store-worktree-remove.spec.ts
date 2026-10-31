import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { JsonCatalogStore } from "@pi-gui/catalogs/node";
import type { WorkspaceRef } from "@pi-gui/session-driver";
import type { DesktopAppState } from "../../contracts/desktop-state";
import {
  createWorkspaceOwner,
  type WorkspaceOwnerHost,
} from "../../electron/workspace/app-store-workspace";
import { appWorktreeRootMatcher } from "../../electron/platform/worktrees/app-worktree-roots";
import { PaoDesktopWorktreeHost } from "../../electron/platform/worktrees/pao-worktree-host";
import { GitWorktreeManager } from "../../electron/platform/worktrees/worktree-manager";
import { TurnCheckpointStore } from "../../electron/workbench/checkpoint-store";

const execFileAsync = promisify(execFile);
const configuredPaoHome = process.env.PAO_HOME?.trim();
if (!configuredPaoHome) {
  throw new Error("缺少显式 PAO_HOME；桌面工作树删除测试拒绝使用系统临时目录。");
}

interface ExecutionLocks {
  readonly acquireExecutionLock: typeof import("../../../../../PAO/packages/coding-agent/dist/pao/worker/lock.js").acquireExecutionLock;
  readonly acquireExecutionRootGuard: typeof import("../../../../../PAO/packages/coding-agent/dist/pao/worker/lock.js").acquireExecutionRootGuard;
  readonly detectExecutionOccupancy: typeof import("../../../../../PAO/packages/coding-agent/dist/pao/worker/lock.js").detectExecutionOccupancy;
  readonly listReleasedExecutionArtifacts: typeof import("../../../../../PAO/packages/coding-agent/dist/pao/worker/lock.js").listReleasedExecutionArtifacts;
  readonly prepareExecutionRootForRemoval: typeof import("../../../../../PAO/packages/coding-agent/dist/pao/worker/lock.js").prepareExecutionRootForRemoval;
  readonly releaseDispatchLock: typeof import("../../../../../PAO/packages/coding-agent/dist/pao/worker/lock.js").releaseDispatchLock;
  readonly WorkerRunner: typeof import("../../../../../PAO/packages/coding-agent/dist/pao/worker/runner.js").WorkerRunner;
}

async function loadLocks(): Promise<ExecutionLocks> {
  const [lock, runner] = await Promise.all([
    import("../../../../../PAO/packages/coding-agent/dist/pao/worker/lock.js"),
    import("../../../../../PAO/packages/coding-agent/dist/pao/worker/runner.js"),
  ]);
  return {
    acquireExecutionLock: lock.acquireExecutionLock,
    acquireExecutionRootGuard: lock.acquireExecutionRootGuard,
    detectExecutionOccupancy: lock.detectExecutionOccupancy,
    listReleasedExecutionArtifacts: lock.listReleasedExecutionArtifacts,
    prepareExecutionRootForRemoval: lock.prepareExecutionRootForRemoval,
    releaseDispatchLock: lock.releaseDispatchLock,
    WorkerRunner: runner.WorkerRunner,
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout.trim();
}

async function makeRepo(root: string): Promise<string> {
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  await git(repo, "init", "-q");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "core.autocrlf", "false");
  await writeFile(join(repo, ".gitignore"), ".pao/\n");
  await writeFile(join(repo, "tracked.txt"), "head\n");
  await writeFile(join(repo, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  await git(repo, "add", ".gitignore", "tracked.txt", "binary.bin");
  await git(repo, "commit", "-qm", "seed");
  return realpath(repo);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function failedState(error: unknown): DesktopAppState {
  return {
    lastError: error instanceof Error ? error.message : String(error),
  } as DesktopAppState;
}

function successfulState(): DesktopAppState {
  return { lastError: "" } as DesktopAppState;
}

interface FixtureOptions {
  readonly activeExecution?: (
    taskRoot: string,
    executionRoot: string,
  ) => boolean | "unknown";
}

async function fixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(join(configuredPaoHome, "i2-3b-1-"));
  const repo = await makeRepo(root);
  const userDataDir = join(root, "user-data");
  const catalogStore = new JsonCatalogStore({
    catalogFilePath: join(userDataDir, "catalogs.json"),
  });
  const checkpoints = new TurnCheckpointStore(userDataDir, {
    timeoutMs: 20_000,
    maxFiles: 100,
    maxBytes: 8 * 1024 * 1024,
    maxFileBytes: 4 * 1024 * 1024,
  });
  const worktreeRoot = join(userDataDir, "worktrees");
  const isAppWorktreePath = appWorktreeRootMatcher(worktreeRoot);
  const worktreeManager = new GitWorktreeManager({
    catalogStorage: catalogStore,
    isAppWorktreePath,
  });
  const locks = await loadLocks();
  const worktreeHost = new PaoDesktopWorktreeHost({
    userDataDir,
    catalogStorage: catalogStore,
    checkpoints,
    worktreeManager,
    executionOccupancy: locks.detectExecutionOccupancy,
    acquireCleanupGuard: locks.acquireExecutionRootGuard,
    listReleasedExecutionArtifacts: locks.listReleasedExecutionArtifacts,
    prepareRunMetadataForRemoval: locks.prepareExecutionRootForRemoval,
    ...(options.activeExecution ? { activeExecution: options.activeExecution } : {}),
  });
  const removedDriverWorkspaces: string[] = [];
  let refreshStateCalls = 0;
  const store = {
    driver: {
      beginWorkspaceDeletion: () => () => undefined,
      removeWorkspace: async (path: string) => {
        removedDriverWorkspaces.push(path);
      },
    },
    catalogStore,
    worktreeManager,
    worktreeRoot,
    worktreeHost,
    isAppWorktreePath,
    initialize: async () => undefined,
    workspaceRefFromState: (workspaceId: string): WorkspaceRef | undefined =>
      workspaceId === repo ? { workspaceId: repo, path: repo, displayName: "repo" } : undefined,
    workspaceState: () => ({
      selectedWorkspaceId: repo,
      selectedSessionId: "",
      workspaces: [],
    }),
    withError: async (error: unknown) => failedState(error),
    withErrorHandling: async (run: () => Promise<DesktopAppState>) => {
      try {
        return await run();
      } catch (error) {
        return failedState(error);
      }
    },
    refreshState: async () => {
      refreshStateCalls += 1;
      return successfulState();
    },
  } as unknown as WorkspaceOwnerHost;
  const owner = createWorkspaceOwner(store);

  return {
    root,
    repo,
    catalogStore,
    worktreeRoot,
    worktreeHost,
    locks,
    owner,
    removedDriverWorkspaces,
    refreshStateCalls: () => refreshStateCalls,
  };
}

test("桌面侧栏删除复用共享执行租约并保留活动工作树", async () => {
  const context = await fixture();
  const { root, repo, worktreeHost, locks, owner } = context;
  const worker = new locks.WorkerRunner({ 证据目录: join(root, "evidence") });
  try {
    const created = await worktreeHost.create({
      requestId: "desktop-remove-active-create",
      projectRoot: repo,
    });
    if (created.kind !== "managed" || !created.branchName) {
      throw new Error("预期创建受管工作树");
    }
    await git(repo, "merge", "--no-ff", created.branchName, "-m", "merge managed work");
    const lock = await locks.acquireExecutionLock({
      root: created.executionRoot,
      holder: "desktop-sidebar-active",
    });
    try {
      const state = await owner.removeWorktree({
        workspaceId: repo,
        worktreeId: created.worktreeId,
      });
      expect(state.lastError).toMatch(/正在使用|保留现场|活动任务/);
      expect(await pathExists(created.executionRoot)).toBe(true);
      expect(await git(repo, "branch", "--list", created.branchName)).not.toBe("");
      expect(await pathExists(join(created.executionRoot, ".pao", "执行占位.json"))).toBe(true);
    } finally {
      await locks.releaseDispatchLock(lock, worker.confirmStopped("desktop-sidebar-active"));
    }
  } finally {
    await worker.stopAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("桌面侧栏删除按普通 SDK 活跃状态回调保留现场且不伪造执行租约", async () => {
  let activeChecks = 0;
  const context = await fixture({
    activeExecution: () => {
      activeChecks += 1;
      return true;
    },
  });
  const {
    root,
    repo,
    worktreeHost,
    owner,
    removedDriverWorkspaces,
    refreshStateCalls,
  } = context;
  try {
    const created = await worktreeHost.create({
      requestId: "desktop-remove-sdk-active-create",
      projectRoot: repo,
    });
    if (created.kind !== "managed" || !created.branchName) {
      throw new Error("预期创建受管工作树");
    }
    await git(repo, "merge", "--no-ff", created.branchName, "-m", "merge managed work");
    const reservationPath = join(created.executionRoot, ".pao", "执行占位.json");
    expect(await pathExists(reservationPath)).toBe(false);

    const state = await owner.removeWorktree({
      workspaceId: repo,
      worktreeId: created.worktreeId,
    });

    expect(activeChecks).toBeGreaterThan(0);
    expect(state.lastError).toMatch(/当前仍有任务/);
    expect(await pathExists(created.executionRoot)).toBe(true);
    expect(await git(repo, "branch", "--list", created.branchName)).not.toBe("");
    expect(await pathExists(reservationPath)).toBe(false);
    expect(removedDriverWorkspaces).toEqual([]);
    expect(refreshStateCalls()).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("桌面侧栏删除清洁已合入工作树后刷新目录并保留分支", async () => {
  let activeChecks = 0;
  const context = await fixture({
    activeExecution: () => {
      activeChecks += 1;
      return false;
    },
  });
  const { root, repo, catalogStore, worktreeHost, owner, removedDriverWorkspaces } = context;
  try {
    const created = await worktreeHost.create({
      requestId: "desktop-remove-clean-create",
      projectRoot: repo,
    });
    if (created.kind !== "managed" || !created.branchName) {
      throw new Error("预期创建受管工作树");
    }
    await git(repo, "merge", "--no-ff", created.branchName, "-m", "merge managed work");

    const state = await owner.removeWorktree({
      workspaceId: repo,
      worktreeId: created.worktreeId,
    });
    expect(state.lastError).toBe("");
    expect(await pathExists(created.executionRoot)).toBe(false);
    expect(await git(repo, "branch", "--list", created.branchName)).not.toBe("");
    await expect(catalogStore.worktrees.getWorktree(created.worktreeId)).resolves.toBeUndefined();
    expect(activeChecks).toBeGreaterThan(0);
    expect(context.refreshStateCalls()).toBe(1);
    expect(removedDriverWorkspaces).toEqual([created.executionRoot]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("桌面侧栏删除遇到 unknown 执行占位时保留现场", async () => {
  const context = await fixture();
  const { root, repo, worktreeHost, owner } = context;
  try {
    const created = await worktreeHost.create({
      requestId: "desktop-remove-unknown-create",
      projectRoot: repo,
    });
    if (created.kind !== "managed" || !created.branchName) {
      throw new Error("预期创建受管工作树");
    }
    await git(repo, "merge", "--no-ff", created.branchName, "-m", "merge managed work");
    const reservationPath = join(created.executionRoot, ".pao", "执行占位.json");
    await mkdir(dirname(reservationPath), { recursive: true });
    await writeFile(reservationPath, "{broken", "utf8");

    const state = await owner.removeWorktree({
      workspaceId: repo,
      worktreeId: created.worktreeId,
    });
    expect(state.lastError).toMatch(/未知|unknown|保留/);
    expect(await pathExists(created.executionRoot)).toBe(true);
    expect(await git(repo, "branch", "--list", created.branchName)).not.toBe("");
    expect(await pathExists(reservationPath)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("桌面侧栏删除不接管用户自建工作树", async () => {
  const context = await fixture();
  const { root, repo, worktreeRoot, owner } = context;
  try {
    const manualPath = join(worktreeRoot, "repo", "manual");
    await mkdir(dirname(manualPath), { recursive: true });
    await git(repo, "worktree", "add", "-b", "feature/manual", manualPath, "HEAD");
    await context.catalogStore.worktrees.listWorktrees(repo);
    const refreshed = await new GitWorktreeManager({
      catalogStorage: context.catalogStore,
      isAppWorktreePath: appWorktreeRootMatcher(worktreeRoot),
    }).refreshWorktrees({ workspaceId: repo, path: repo, displayName: "repo" });
    expect(refreshed.worktrees.some((entry) => entry.path === resolve(manualPath))).toBe(true);

    const state = await owner.removeWorktree({
      workspaceId: repo,
      worktreeId: await realpath(manualPath),
    });
    expect(state.lastError).toMatch(/保留|应用登记|工作目录/);
    expect(await pathExists(manualPath)).toBe(true);
    expect(await git(repo, "branch", "--list", "feature/manual")).not.toBe("");
    const saved = JSON.parse(
      await readFile(join(root, "user-data", "pao-worktree-host.json"), "utf8"),
    ) as { creates?: Record<string, unknown> };
    expect(saved.creates ?? {}).toEqual({});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

