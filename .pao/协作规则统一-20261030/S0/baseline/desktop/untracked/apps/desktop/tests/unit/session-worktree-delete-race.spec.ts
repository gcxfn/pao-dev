import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { JsonCatalogStore } from "@pi-gui/catalogs/node";
import type { SessionRef } from "@pi-gui/session-driver";
import type { DesktopAppState } from "../../contracts/desktop-state";
import type { WorkspaceOwnerHost } from "../../electron/workspace/app-store-workspace";
import { createWorkspaceOwner } from "../../electron/workspace/app-store-workspace";
import type {
  PiSdkDriverOptions,
  SessionSupervisor,
} from "../../../../packages/pi-sdk-driver/src/session-supervisor";

const configuredPaoHome = process.env.PAO_HOME?.trim();
if (!configuredPaoHome) {
  throw new Error("缺少显式 PAO_HOME；工作树删除竞态测试拒绝使用系统临时目录。");
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

function worktreeCatalog(path: string): JsonCatalogStore {
  return {
    worktrees: {
      getWorktree: async (worktreeId: string) => ({
        workspaceId: "root-workspace",
        path,
        worktreeId,
      }),
    },
  } as unknown as JsonCatalogStore;
}

function makeWorkspaceOwner(input: {
  readonly supervisor: SessionSupervisor;
  readonly worktreePath: string;
  readonly removeManagedWorktree: WorkspaceOwnerHost["worktreeHost"]["removeManagedWorktree"];
}) {
  const rootPath = join(input.worktreePath, "..", "source-repository");
  const store = {
    driver: input.supervisor,
    catalogStore: worktreeCatalog(input.worktreePath),
    worktreeManager: {},
    worktreeRoot: join(rootPath, "worktrees"),
    worktreeHost: {
      removeManagedWorktree: input.removeManagedWorktree,
    },
    isAppWorktreePath: async () => true,
    initialize: async () => undefined,
    workspaceRefFromState: () => ({
      workspaceId: rootPath,
      path: rootPath,
      displayName: "source-repository",
    }),
    workspaceState: () => ({
      selectedWorkspaceId: rootPath,
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
    refreshState: async () => successfulState(),
  } as unknown as WorkspaceOwnerHost;
  return createWorkspaceOwner(store);
}

async function makeSupervisor(
  getSession: NonNullable<PiSdkDriverOptions["catalogStorage"]>["sessions"]["getSession"],
) {
  const { SessionSupervisor: Supervisor } =
    await import("../../../../packages/pi-sdk-driver/src/session-supervisor");
  let runtimeCreations = 0;
  const supervisor = new Supervisor({
    catalogStorage: {
      sessions: {
        getSession,
      },
      workspaces: {
        getWorkspace: async () => undefined,
      },
    } as unknown as NonNullable<PiSdkDriverOptions["catalogStorage"]>,
    createAgentSessionRuntimeImpl: async () => {
      runtimeCreations += 1;
      throw new Error("测试不得创建真实模型运行时");
    },
  });
  return {
    supervisor,
    runtimeCreations: () => runtimeCreations,
  };
}

async function fixture() {
  const root = await mkdtemp(join(configuredPaoHome, "i2-3b-2-"));
  const worktreePath = join(root, "managed-worktree");
  await mkdir(worktreePath);
  return { root, worktreePath };
}

test("清理已取得删除门后，新 SDK 首发在进入目录读取和模型前被拒绝", async () => {
  const { root, worktreePath } = await fixture();
  let sessionLookups = 0;
  const app = await makeSupervisor(async () => {
    sessionLookups += 1;
    return undefined;
  });
  const enteredCleanup = deferred<void>();
  const releaseCleanup = deferred<void>();
  const owner = makeWorkspaceOwner({
    supervisor: app.supervisor,
    worktreePath,
    removeManagedWorktree: async () => {
      enteredCleanup.resolve();
      await releaseCleanup.promise;
      return { ok: false, reason: "受控测试暂停结束" };
    },
  });

  try {
    expect(typeof app.supervisor.beginWorkspaceDeletion).toBe("function");
    const removal = owner.removeWorktree({
      workspaceId: "root-workspace",
      worktreeId: worktreePath,
    });
    await enteredCleanup.promise;

    const send = app.supervisor.sendUserMessage(
      { workspaceId: worktreePath, sessionId: "first-send" },
      { text: "must not start" },
    );
    await expect(send).rejects.toThrow(/正在删除/);
    expect(sessionLookups).toBe(0);
    expect(app.runtimeCreations()).toBe(0);
    expect(await pathExists(worktreePath)).toBe(true);

    releaseCleanup.resolve();
    const state = await removal;
    expect(state.lastError).toMatch(/受控测试暂停结束/);
  } finally {
    releaseCleanup.resolve();
    await rm(root, { recursive: true, force: true });
  }
});

test("首发仍在 ensureRecord 且记录尚不存在时，删除拒绝并保留目录", async () => {
  const { root, worktreePath } = await fixture();
  const lookupStarted = deferred<void>();
  const lookupResult =
    deferred<
      Awaited<
        ReturnType<NonNullable<PiSdkDriverOptions["catalogStorage"]>["sessions"]["getSession"]>
      >
    >();
  const app = await makeSupervisor(async () => {
    lookupStarted.resolve();
    return lookupResult.promise;
  });
  let cleanupCalls = 0;
  const owner = makeWorkspaceOwner({
    supervisor: app.supervisor,
    worktreePath,
    removeManagedWorktree: async () => {
      cleanupCalls += 1;
      return { ok: true };
    },
  });
  const ref: SessionRef = { workspaceId: worktreePath, sessionId: "starting-send" };

  try {
    expect(typeof app.supervisor.beginWorkspaceDeletion).toBe("function");
    const send = app.supervisor.sendUserMessage(ref, { text: "first" });
    await lookupStarted.promise;

    const state = await owner.removeWorktree({
      workspaceId: "root-workspace",
      worktreeId: worktreePath,
    });
    expect(state.lastError).toMatch(/仍有任务/);
    expect(cleanupCalls).toBe(0);
    expect(app.runtimeCreations()).toBe(0);
    expect(await pathExists(worktreePath)).toBe(true);

    lookupResult.resolve(undefined);
    await expect(send).rejects.toThrow(/not in the catalog/);
  } finally {
    lookupResult.resolve(undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("清理失败在 finally 释放删除门，后续首发不再被误拒绝", async () => {
  const { root, worktreePath } = await fixture();
  let sessionLookups = 0;
  const app = await makeSupervisor(async () => {
    sessionLookups += 1;
    return undefined;
  });
  const owner = makeWorkspaceOwner({
    supervisor: app.supervisor,
    worktreePath,
    removeManagedWorktree: async () => ({
      ok: false,
      reason: "受控清理失败",
    }),
  });

  try {
    expect(typeof app.supervisor.beginWorkspaceDeletion).toBe("function");
    const removal = await owner.removeWorktree({
      workspaceId: "root-workspace",
      worktreeId: worktreePath,
    });
    expect(removal.lastError).toMatch(/受控清理失败/);

    const send = app.supervisor.sendUserMessage(
      { workspaceId: worktreePath, sessionId: "after-failure" },
      { text: "may start" },
    );
    await expect(send).rejects.toThrow(/not in the catalog/);
    expect(sessionLookups).toBe(1);
    expect(app.runtimeCreations()).toBe(0);
    expect(await pathExists(worktreePath)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("已有活跃会话时删除同步拒绝，且不释放或改写活动状态", async () => {
  const { root, worktreePath } = await fixture();
  const app = await makeSupervisor(async () => undefined);
  const records = (
    app.supervisor as unknown as {
      records: Map<
        string,
        {
          closed: boolean;
          workspace: { path: string };
          status: "running";
          sendInFlight: boolean;
          promptStarting: boolean;
          session: { isCompacting: boolean };
        }
      >;
    }
  ).records;
  records.set("active", {
    closed: false,
    workspace: { path: worktreePath },
    status: "running",
    sendInFlight: false,
    promptStarting: false,
    session: { isCompacting: false },
  });
  let cleanupCalls = 0;
  const owner = makeWorkspaceOwner({
    supervisor: app.supervisor,
    worktreePath,
    removeManagedWorktree: async () => {
      cleanupCalls += 1;
      return { ok: true };
    },
  });

  try {
    expect(typeof app.supervisor.beginWorkspaceDeletion).toBe("function");
    const state = await owner.removeWorktree({
      workspaceId: "root-workspace",
      worktreeId: worktreePath,
    });
    expect(state.lastError).toMatch(/仍有任务/);
    expect(cleanupCalls).toBe(0);
    expect(records.get("active")?.status).toBe("running");
    expect(app.supervisor.isExecutionActive(worktreePath)).toBe(true);
    expect(await pathExists(worktreePath)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("第二个发送排队结束时，仍由首个发送的入口登记阻止删除", async () => {
  const { root, worktreePath } = await fixture();
  const app = await makeSupervisor(async () => undefined);
  const firstSettling = deferred<void>();
  const secondQueued = deferred<void>();
  const releaseFirst = deferred<void>();
  const record = {
    session: {},
    closed: false,
    closeRequested: false,
    workspace: { path: worktreePath },
    sendInFlight: false,
  };
  let starts = 0;
  let queued = 0;
  let settleCalls = 0;
  const internals = app.supervisor as unknown as {
    records: Map<string, typeof record>;
    pendingSendStartsByWorkspace: Map<string, number>;
    ensureRecord: () => Promise<typeof record>;
    settleReloadsBeforeSend: () => Promise<void>;
    sendReadyMessage: () => Promise<void>;
    queueSendWhileBusy: () => Promise<void>;
  };
  internals.records.set(`${worktreePath}:double-send`, record);
  internals.ensureRecord = async () => record;
  internals.settleReloadsBeforeSend = async () => {
    settleCalls += 1;
    if (settleCalls === 1) {
      firstSettling.resolve();
      await releaseFirst.promise;
    }
  };
  internals.sendReadyMessage = async () => {
    starts += 1;
  };
  internals.queueSendWhileBusy = async () => {
    queued += 1;
    secondQueued.resolve();
  };
  const ref = { workspaceId: worktreePath, sessionId: "double-send" };

  try {
    const first = app.supervisor.sendUserMessage(ref, { text: "first" });
    const second = app.supervisor.sendUserMessage(ref, { text: "second" });
    await firstSettling.promise;

    await secondQueued.promise;
    await second;
    expect(starts).toBe(0);
    expect(queued).toBe(1);
    expect(record.sendInFlight).toBe(false);
    expect(internals.pendingSendStartsByWorkspace.size).toBe(1);
    expect(app.supervisor.isExecutionActive(worktreePath)).toBe(true);
    expect(() => app.supervisor.beginWorkspaceDeletion(worktreePath)).toThrow(/仍有任务/);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(starts).toBe(1);
    const releaseDeletion = app.supervisor.beginWorkspaceDeletion(worktreePath);
    releaseDeletion();
    expect(app.runtimeCreations()).toBe(0);
  } finally {
    releaseFirst.resolve();
    await rm(root, { recursive: true, force: true });
  }
});

test("压缩期间发送仍进入队列，删除保持拒绝", async () => {
  const { root, worktreePath } = await fixture();
  const app = await makeSupervisor(async () => undefined);
  const record = {
    session: { isStreaming: false, isCompacting: true },
    closed: false,
    closeRequested: false,
    workspace: { path: worktreePath },
    status: "idle" as const,
    runningRunId: undefined,
    sendInFlight: false,
    promptStarting: false,
    extensionCommandsRunning: 0,
  };
  let queued = 0;
  const internals = app.supervisor as unknown as {
    records: Map<string, typeof record>;
    ensureRecord: () => Promise<typeof record>;
    settleReloadsBeforeSend: () => Promise<void>;
    queueSendWhileBusy: () => Promise<void>;
  };
  internals.records.set(`${worktreePath}:compacting`, record);
  internals.ensureRecord = async () => record;
  internals.settleReloadsBeforeSend = async () => undefined;
  internals.queueSendWhileBusy = async () => {
    queued += 1;
  };

  try {
    await app.supervisor.sendUserMessage(
      { workspaceId: worktreePath, sessionId: "compacting" },
      { text: "during compaction" },
    );
    expect(queued).toBe(1);
    expect(record.sendInFlight).toBe(false);
    expect(app.supervisor.isExecutionActive(worktreePath)).toBe(true);
    expect(() => app.supervisor.beginWorkspaceDeletion(worktreePath)).toThrow(/仍有任务/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
