import test from "node:test";
import assert from "node:assert/strict";
import { SessionSupervisor } from "../dist/session-supervisor.js";

/**
 * Pins the host-quit stop chain: disposeAll() must run every managed session
 * through the same teardown as closeSession — abort the run, dispose the
 * runtime (whose `session_shutdown` event triggers the coding-agent stop chain
 * that kills worker/tool process trees), release the lease, persist the
 * snapshot, and emit sessionClosed. The desktop host calls this from
 * `before-quit`; a regression here leaves descendant processes running after
 * the app window closes.
 *
 * These tests drive the real disposeAll -> closeSession path with fake
 * records, so deleting the disposeAll wiring or its per-session teardown
 * steps fails them.
 */

function makeCountingCatalog() {
  const upserts: string[] = [];
  return {
    upserts,
    sessions: {
      upsertSession: async (entry: { title: string }) => {
        upserts.push(entry.title);
      },
    },
    setSessionFile: async () => undefined,
  };
}

interface FakeSession {
  abort: () => Promise<void>;
}

interface FakeRuntime {
  dispose: () => Promise<void>;
}

function makeFakeRecord(
  id: string,
  overrides: {
    abort?: () => Promise<void>;
    dispose?: () => Promise<void>;
  } = {},
) {
  const calls: string[] = [];
  const abort = overrides.abort ?? (async () => void calls.push(`abort:${id}`));
  const dispose = overrides.dispose ?? (async () => void calls.push(`dispose:${id}`));
  const emitted: Array<{ type: string; sessionRef?: unknown }> = [];
  const record = {
    ref: { workspaceId: "ws-1", sessionId: id },
    workspace: { workspaceId: "ws-1", path: "/tmp/ws-1", displayName: "ws-1" },
    title: `probe ${id}`,
    runtime: { dispose } as unknown as FakeRuntime,
    session: { abort } as unknown as FakeSession,
    sessionFile: undefined,
    status: "running",
    updatedAt: new Date().toISOString(),
    archivedAt: undefined,
    preview: undefined,
    config: undefined,
    runningRunId: `run-${id}`,
    queuedMessages: [],
    closed: false,
    listeners: new Set([
      (event: { type: string; sessionRef?: unknown }) => {
        emitted.push(event);
      },
    ]),
    eventQueue: Promise.resolve(),
    unsubscribeAgent: () => void calls.push(`unsubscribe:${id}`),
    pendingHostUiRequests: new Map(),
    extensionUiState: {
      statuses: new Map(),
      widgets: new Map(),
      title: undefined,
      editorText: undefined,
    },
    bindingExtensions: false,
    sessionCommands: [],
    leasePath: undefined,
    transcriptDiskMtimeMs: undefined,
  };
  return { record, calls, emitted };
}

function supervisorWith(...records: ReturnType<typeof makeFakeRecord>[]) {
  const catalog = makeCountingCatalog();
  const supervisor = new SessionSupervisor({
    catalogStorage: catalog as never,
  }) as unknown as {
    records: Map<string, (typeof records)[number]["record"]>;
    disposeAll: () => Promise<void>;
  };
  for (const { record } of records) {
    supervisor.records.set(`${record.ref.workspaceId}:${record.ref.sessionId}`, record);
  }
  return { supervisor, catalog, records };
}

await test("disposeAll aborts and disposes every managed session", async () => {
  const a = makeFakeRecord("a");
  const b = makeFakeRecord("b");
  const { supervisor, catalog, records } = supervisorWith(a, b);

  await supervisor.disposeAll();

  assert.deepEqual(
    [...a.calls],
    ["abort:a", "unsubscribe:a", "dispose:a"],
    "session a must be aborted, unsubscribed, and its runtime disposed",
  );
  assert.deepEqual(
    [...b.calls],
    ["abort:b", "unsubscribe:b", "dispose:b"],
    "session b must be aborted, unsubscribed, and its runtime disposed",
  );
  for (const { record, emitted } of records) {
    assert.equal(record.closed, true, "the record must be marked closed");
    assert.equal(record.runningRunId, undefined, "no run may still be marked in flight");
    assert.equal(record.runtime, undefined, "the runtime must be detached");
    assert.equal(record.session, undefined, "the session must be detached");
    assert.ok(
      emitted.some((event) => event.type === "sessionClosed"),
      `expected a sessionClosed event, got ${JSON.stringify(emitted.map((e) => e.type))}`,
    );
  }
  assert.deepEqual(
    [...catalog.upserts].sort(),
    ["probe a", "probe b"],
    "every session snapshot must be persisted so the catalog no longer reports it running",
  );
});

await test("a runtime that fails to dispose does not stop the other sessions", async () => {
  const failing = makeFakeRecord("failing", {
    abort: async () => {
      throw new Error("abort exploded");
    },
    dispose: async () => {
      throw new Error("dispose exploded");
    },
  });
  const healthy = makeFakeRecord("healthy");
  const { supervisor, records } = supervisorWith(failing, healthy);

  await supervisor.disposeAll();

  assert.deepEqual(
    [...healthy.calls],
    ["abort:healthy", "unsubscribe:healthy", "dispose:healthy"],
    "the healthy session must still be fully torn down",
  );
  assert.equal(healthy.record.closed, true);
  for (const { record } of records) {
    assert.equal(record.closed, true, "every record must be marked closed even when one fails");
  }
});
