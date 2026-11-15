import assert from "node:assert/strict";
import test from "node:test";
import type { SessionDriverEvent, SessionSnapshot } from "@pi-gui/session-driver";
import {
  createEmptyExtensionUiState,
  SessionSupervisor,
} from "../dist/index.js";

/**
 * 停止中链（设计包-控制入口五态-2026-10-04 §2.2 / 拍板 §6.3，hermetic）：
 * cancelCurrentRun 发出 abort 后先置 "stopping" 并 emit；abort settle 且确认非
 * streaming 后才落 idle（失败落 failed）；abort 抛错也必须收敛不卡死（对齐旧
 * :1334 语义）。无超时自动降级——abort 挂起时保持 stopping。
 */

const REF = { workspaceId: "workspace", sessionId: "session" };

function fakeCatalogStorage() {
  return {
    workspaces: {
      listWorkspaces: async () => ({ workspaces: [] }),
      getWorkspace: async () => undefined,
      upsertWorkspace: async () => {},
      deleteWorkspace: async () => {},
    },
    sessions: {
      listSessions: async () => ({ sessions: [] }),
      getSession: async () => undefined,
      upsertSession: async () => {},
      deleteSession: async () => {},
    },
    worktrees: {
      listWorktrees: async () => ({ worktrees: [] }),
      getWorktree: async () => undefined,
      upsertWorktree: async () => {},
      deleteWorktree: async () => {},
      replaceWorkspaceWorktrees: async () => {},
    },
    getSessionFile: async () => undefined,
    setSessionFile: async () => {},
    deleteSessionFile: async () => {},
    replaceWorkspaceSessions: async () => {},
  } as never;
}

function syntheticRecord(overrides: Record<string, unknown> = {}) {
  return {
    ref: REF,
    workspace: { workspaceId: "workspace", path: "/synthetic/workspace" },
    title: "Stopping turn",
    runtime: undefined,
    session: undefined,
    sessionFile: undefined,
    status: "running",
    updatedAt: new Date().toISOString(),
    archivedAt: undefined,
    preview: undefined,
    config: undefined,
    runningRunId: "run",
    cancellationRequested: false,
    promptStarting: false,
    abortOnRunStart: false,
    pendingRunOutcome: undefined,
    queuedMessages: [],
    startingQueuedMessage: undefined,
    queuedStartScheduled: false,
    piQueueSync: Promise.resolve(),
    queuedStartRecheck: false,
    startedQueuedMessageIds: new Set(),
    queuedStartFailed: false,
    closed: false,
    listeners: new Set(),
    eventQueue: Promise.resolve(),
    unsubscribeAgent: undefined,
    pendingHostUiRequests: new Map(),
    extensionUiState: createEmptyExtensionUiState(),
    undeliveredLoadNotices: [],
    bindingExtensions: false,
    sessionCommands: [],
    usage: undefined,
    leasePath: undefined,
    transcriptDiskMtimeMs: undefined,
    appendedCustomEntryIds: new Set(),
    reloadPending: false,
    reloadInFlight: undefined,
    extensionCommandsRunning: 0,
    ...overrides,
  };
}

function setupSupervisor(record: ReturnType<typeof syntheticRecord>, session: unknown) {
  const supervisor = new SessionSupervisor({ catalogStorage: fakeCatalogStorage() });
  record.session = session;
  (supervisor as unknown as { records: Map<string, unknown> }).records.set(
    `${REF.workspaceId}:${REF.sessionId}`,
    record,
  );
  const events: SessionDriverEvent[] = [];
  supervisor.subscribe(REF, (event) => {
    events.push(event);
  });
  const snapshots = () =>
    events
      .filter((event): event is Extract<SessionDriverEvent, { type: "sessionUpdated" }> =>
        event.type === "sessionUpdated",
      )
      .map((event) => event.snapshot);
  return { supervisor, events, snapshots };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

await test("a stopping session still owns its execution root", () => {
  const session = {
    isStreaming: false,
    isCompacting: false,
  };
  const record = syntheticRecord({ status: "stopping" });
  const { supervisor } = setupSupervisor(record, session);
  assert.equal(supervisor.isExecutionActive("/synthetic/workspace"), true);
});

await test("cancelCurrentRun announces stopping while abort hangs, then settles idle", async () => {
  let settleAbort: () => void = () => {};
  const session = {
    isStreaming: true,
    isCompacting: false,
    clearQueue() {},
    abort: () =>
      new Promise<void>((resolve) => {
        // 真 abort settle 即停流：翻掉 streaming，证明「非 streaming」检查放行。
        settleAbort = () => {
          session.isStreaming = false;
          resolve();
        };
      }),
  };
  const record = syntheticRecord();
  const { supervisor, snapshots } = setupSupervisor(record, session);

  const cancelPromise = supervisor.cancelCurrentRun(REF);
  await tick();

  // abort 未 settle：快照停在 stopping，取消已受理未确认。
  assert.equal(record.status, "stopping");
  assert.equal(record.cancellationRequested, true);
  assert.deepEqual(
    snapshots().map((snapshot) => snapshot.status),
    ["running", "stopping"],
  );
  assert.equal(snapshots().at(-1)?.cancellationRequested, true);

  settleAbort();
  await cancelPromise;

  assert.equal(record.status, "idle");
  assert.equal(record.runningRunId, undefined);
  assert.deepEqual(
    snapshots().map((snapshot) => snapshot.status),
    ["running", "stopping", "idle"],
  );
});

await test("cancelCurrentRun keeps stopping when abort settles but the stream is still live", async () => {
  const session = {
    isStreaming: true,
    isCompacting: false,
    clearQueue() {},
    abort: () => Promise.resolve(),
  };
  const record = syntheticRecord();
  const { supervisor, snapshots } = setupSupervisor(record, session);

  await supervisor.cancelCurrentRun(REF);

  // 拍板 §6.3：只有 abort settle 且确认非 streaming 才离开 stopping，不自动降级。
  assert.equal(record.status, "stopping");
  assert.deepEqual(
    snapshots().map((snapshot) => snapshot.status),
    ["running", "stopping"],
  );
});

await test("cancelCurrentRun converges to idle when abort rejects (old best-effort semantics)", async () => {
  const session = {
    isStreaming: true,
    isCompacting: false,
    clearQueue() {},
    abort: () => Promise.reject(new Error("abort boom")),
  };
  const record = syntheticRecord();
  const { supervisor, snapshots } = setupSupervisor(record, session);

  await supervisor.cancelCurrentRun(REF);

  assert.equal(record.status, "idle");
  assert.deepEqual(
    snapshots().map((snapshot) => snapshot.status),
    ["running", "stopping", "idle"],
  );
});

await test("cancelCurrentRun settles to failed when the run was already failing", async () => {
  const session = {
    isStreaming: false,
    isCompacting: false,
    clearQueue() {},
    abort: () => Promise.resolve(),
  };
  const record = syntheticRecord({
    pendingRunOutcome: { status: "failed", error: { message: "boom", code: "ERROR" } },
  });
  const { supervisor, snapshots } = setupSupervisor(record, session);

  await supervisor.cancelCurrentRun(REF);

  assert.equal(record.status, "failed");
  assert.deepEqual(
    snapshots().map((snapshot) => snapshot.status),
    ["running", "stopping", "failed"],
  );
});

await test("cancelCurrentRun skips the stopping announcement when nothing is in flight", async () => {
  const session = {
    isStreaming: false,
    isCompacting: false,
    clearQueue() {},
    abort: () => Promise.resolve(),
  };
  const record = syntheticRecord({ status: "idle", runningRunId: undefined });
  const { supervisor, snapshots } = setupSupervisor(record, session);

  await supervisor.cancelCurrentRun(REF);

  // 空闲会话上的取消不闪「停止中」：只有 subscribe 初始快照与落定两条 idle。
  assert.equal(record.status, "idle");
  assert.deepEqual(
    snapshots().map((snapshot) => snapshot.status),
    ["idle", "idle"],
  );
  assert.equal(snapshots().at(-1)?.cancellationRequested, true);
});

await test("buildSnapshot omits the cancellation marker once it clears", async () => {
  const record = syntheticRecord({ cancellationRequested: false });
  const supervisor = new SessionSupervisor({ catalogStorage: fakeCatalogStorage() });
  (supervisor as unknown as { records: Map<string, unknown> }).records.set(
    `${REF.workspaceId}:${REF.sessionId}`,
    record,
  );
  const events: SessionDriverEvent[] = [];
  supervisor.subscribe(REF, (event) => events.push(event));
  const snapshot: SessionSnapshot = (
    events[0] as Extract<SessionDriverEvent, { type: "sessionUpdated" }>
  ).snapshot;
  assert.equal("cancellationRequested" in snapshot, false);
});
