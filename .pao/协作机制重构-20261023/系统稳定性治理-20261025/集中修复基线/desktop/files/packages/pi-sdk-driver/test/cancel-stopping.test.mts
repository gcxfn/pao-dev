import assert from "node:assert/strict";
import test from "node:test";
import type {
  SessionDriverEvent,
  SessionQueuedMessage,
  SessionSnapshot,
} from "@pi-gui/session-driver";
import {
  createEmptyExtensionUiState,
  SessionSupervisor,
} from "../dist/index.js";

/**
 * 停止中链（设计包-控制入口五态-2026-10-04 §2.2 / 拍板 §6.3，hermetic）：
 * cancelCurrentRun 发出 abort 后先置 "stopping" 并 emit；abort settle 且确认
 * isIdle 后才落 idle（失败落 failed）。abort 抛错时，也只有 isIdle 已确认
 * 才结算；仍忙则保留 stopping 和锁，把原错误交给宿主。无超时自动降级。
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
const queuedMessage = (id: string): SessionQueuedMessage => ({
  id,
  text: `queued ${id}`,
  createdAt: new Date().toISOString(),
  mode: "followUp",
});

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
    get isIdle() {
      return !this.isStreaming && !this.isCompacting;
    },
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
    isIdle: false,
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

await test("cancelCurrentRun keeps stopping when abort returns during compaction", async () => {
  const session = {
    isStreaming: false,
    isCompacting: true,
    isIdle: false,
    clearQueue() {},
    abort: () => Promise.resolve(),
  };
  const record = syntheticRecord({ queuedMessages: [queuedMessage("queued-1")] });
  const { supervisor, snapshots } = setupSupervisor(record, session);

  await supervisor.cancelCurrentRun(REF);

  assert.equal(record.status, "stopping");
  assert.equal(record.runningRunId, "run");
  assert.equal(record.cancellationRequested, true);
  assert.deepEqual(record.queuedMessages.map((message) => message.id), ["queued-1"]);
  assert.equal(supervisor.isExecutionActive("/synthetic/workspace"), true);
  assert.deepEqual(
    snapshots().map((snapshot) => snapshot.status),
    ["running", "stopping"],
  );
});

await test("cancelCurrentRun rejects without settling while abort fails and the run is live", async () => {
  const abortError = new Error("abort boom");
  const session = {
    isStreaming: true,
    isCompacting: false,
    isIdle: false,
    clearQueue() {
      throw new Error("a live cancellation must not clear the queue");
    },
    abort: () => Promise.reject(abortError),
  };
  const record = syntheticRecord({ queuedMessages: [queuedMessage("queued-1")] });
  const { supervisor, snapshots } = setupSupervisor(record, session);

  await assert.rejects(supervisor.cancelCurrentRun(REF), (error: unknown) => error === abortError);

  assert.equal(record.status, "stopping");
  assert.equal(record.runningRunId, "run");
  assert.equal(record.cancellationRequested, true);
  assert.deepEqual(record.queuedMessages.map((message) => message.id), ["queued-1"]);
  assert.equal(supervisor.isExecutionActive("/synthetic/workspace"), true);
  assert.deepEqual(
    snapshots().map((snapshot) => snapshot.status),
    ["running", "stopping"],
  );
});

await test("cancelCurrentRun keeps stopping when abort fails during compaction", async () => {
  const abortError = new Error("abort boom");
  const session = {
    isStreaming: false,
    isCompacting: true,
    isIdle: false,
    clearQueue() {
      throw new Error("a live cancellation must not clear the queue");
    },
    abort: () => Promise.reject(abortError),
  };
  const record = syntheticRecord({ queuedMessages: [queuedMessage("queued-1")] });
  const { supervisor, snapshots } = setupSupervisor(record, session);

  await assert.rejects(supervisor.cancelCurrentRun(REF), (error: unknown) => error === abortError);

  assert.equal(record.status, "stopping");
  assert.equal(record.runningRunId, "run");
  assert.equal(record.cancellationRequested, true);
  assert.deepEqual(record.queuedMessages.map((message) => message.id), ["queued-1"]);
  assert.equal(supervisor.isExecutionActive("/synthetic/workspace"), true);
  assert.deepEqual(
    snapshots().map((snapshot) => snapshot.status),
    ["running", "stopping"],
  );
});

await test("cancelCurrentRun settles a failed abort only after Pi confirms idle", async () => {
  const abortError = new Error("settle hook failed after stop");
  const session = {
    isStreaming: false,
    isCompacting: false,
    isIdle: true,
    clearQueue() {},
    abort: () => Promise.reject(abortError),
  };
  const record = syntheticRecord({
    pendingRunOutcome: { status: "failed", error: { message: "boom", code: "ERROR" } },
  });
  const { supervisor, snapshots } = setupSupervisor(record, session);

  await assert.rejects(supervisor.cancelCurrentRun(REF), (error: unknown) => error === abortError);

  assert.equal(record.status, "failed");
  assert.equal(record.runningRunId, undefined);
  assert.equal(supervisor.isExecutionActive("/synthetic/workspace"), false);
  assert.deepEqual(
    snapshots().map((snapshot) => snapshot.status),
    ["running", "stopping", "failed"],
  );
});

await test("a late settled event finishes a cancel whose abort failed", async () => {
  const abortError = new Error("abort boom");
  const session = {
    isStreaming: true,
    isCompacting: false,
    model: undefined,
    promptTemplates: [],
    extensionRunner: { getRegisteredCommands: () => [] },
    resourceLoader: { getSkills: () => ({ skills: [] }) },
    get isIdle() {
      return !this.isStreaming && !this.isCompacting;
    },
    clearQueue() {},
    abort: () => Promise.reject(abortError),
  };
  const record = syntheticRecord();
  const { supervisor, snapshots } = setupSupervisor(record, session);

  await assert.rejects(supervisor.cancelCurrentRun(REF), (error: unknown) => error === abortError);
  assert.equal(record.status, "stopping");

  session.isStreaming = false;
  (
    supervisor as unknown as {
      handleAgentEvent: (
        record: typeof record,
        event: { type: "agent_settled" },
      ) => void;
    }
  ).handleAgentEvent(record, { type: "agent_settled" });
  await record.eventQueue;

  assert.equal(record.status, "idle");
  assert.equal(record.runningRunId, undefined);
  assert.equal(record.cancellationRequested, false);
  assert.equal(supervisor.isExecutionActive("/synthetic/workspace"), false);
  assert.deepEqual(
    snapshots().map((snapshot) => snapshot.status),
    ["running", "stopping", "idle"],
  );
});

await test("cancelCurrentRun settles to failed when the run was already failing", async () => {
  const session = {
    isStreaming: false,
    isCompacting: false,
    isIdle: true,
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
    isIdle: true,
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
