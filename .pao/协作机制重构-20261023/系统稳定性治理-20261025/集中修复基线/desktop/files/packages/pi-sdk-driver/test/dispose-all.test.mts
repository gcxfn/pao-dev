import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOwnLease,
  writeLeaseFile,
} from "../dist/session-lease.js";
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
      upsertSession: async (entry: { title: string; sessionFile?: string }) => {
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
    prompt?: () => Promise<void>;
    leasePath?: string;
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
    session: {
      abort,
      prompt: overrides.prompt ?? (async () => void calls.push(`prompt:${id}`)),
      sessionManager: {
        getSessionFile: () => undefined,
        buildSessionProjection: () => ({ messages: [] }),
        getBranch: () => [],
      },
      settingsManager: {
        getBlockImages: () => false,
      },
      isStreaming: false,
      isCompacting: false,
    } as unknown as FakeSession,
    sessionFile: undefined,
    status: "running",
    updatedAt: new Date().toISOString(),
    archivedAt: undefined,
    preview: undefined,
    config: undefined,
    runningRunId: `run-${id}`,
    queuedMessages: [],
    closed: false,
    closeRequested: false,
    closePromise: undefined,
    closeError: undefined,
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
    leasePath: overrides.leasePath,
    transcriptDiskMtimeMs: undefined,
  };
  return { record, calls, emitted };
}

function supervisorWith(
  records: ReturnType<typeof makeFakeRecord>[],
  catalog = makeCountingCatalog(),
) {
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
  const { supervisor, catalog, records } = supervisorWith([a, b]);

  await supervisor.disposeAll();

  assert.deepEqual(
    [...a.calls],
    ["abort:a", "dispose:a", "unsubscribe:a"],
    "session a must be aborted, disposed, then unsubscribed",
  );
  assert.deepEqual(
    [...b.calls],
    ["abort:b", "dispose:b", "unsubscribe:b"],
    "session b must be aborted, disposed, then unsubscribed",
  );
  for (const { record, emitted } of records) {
    assert.equal(record.closed, true, "the record must be marked closed");
    assert.equal(record.closeRequested, false);
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

await test("concurrent closes share one real runtime dispose", async () => {
  let releaseDispose!: () => void;
  const disposeGate = new Promise<void>((resolve) => {
    releaseDispose = resolve;
  });
  let disposeCalls = 0;
  const one = makeFakeRecord("one", {
    dispose: async () => {
      disposeCalls += 1;
      await disposeGate;
    },
  });
  const { supervisor } = supervisorWith([one]);

  const first = supervisor.closeSession(one.record.ref);
  const second = supervisor.closeSession(one.record.ref);
  releaseDispose();
  await Promise.all([first, second]);

  assert.equal(disposeCalls, 1);
  assert.equal(one.record.closed, true);
});

await test("a failed close stays live for retry and does not stop other sessions", async () => {
  const leaseDirectory = await mkdtemp(join(tmpdir(), "pi-close-failure-"));
  const leasePath = join(leaseDirectory, "failing.jsonl.lease");
  let disposeAttempts = 0;
  const failing = makeFakeRecord("failing", {
    leasePath,
    dispose: async () => {
      disposeAttempts += 1;
      if (disposeAttempts === 1) throw new Error("dispose exploded");
      failing.calls.push("dispose:failing");
    },
  });
  const healthy = makeFakeRecord("healthy");
  const { supervisor, records } = supervisorWith([failing, healthy]);
  const leaseIdentity = (
    supervisor as unknown as {
      leaseIdentity: Parameters<typeof buildOwnLease>[0];
    }
  ).leaseIdentity;
  await writeLeaseFile(leasePath, buildOwnLease(leaseIdentity, Date.now()));

  try {
    await assert.rejects(supervisor.disposeAll(), AggregateError);

    assert.deepEqual(
      [...healthy.calls],
      ["abort:healthy", "dispose:healthy", "unsubscribe:healthy"],
      "the healthy session must still be fully torn down",
    );
    assert.equal(healthy.record.closed, true);
    assert.equal(failing.record.closed, false);
    assert.equal(failing.record.status, "stopping");
    assert.equal(failing.record.closeRequested, true);
    assert.ok(failing.record.runtime, "the unconfirmed runtime must remain attached");
    assert.ok(failing.record.session, "the unconfirmed session must remain attached");
    assert.equal(
      failing.record.leasePath,
      leasePath,
      "the unconfirmed session must keep its lease",
    );
    await readFile(leasePath, "utf8");
    assert.ok(failing.record.closeError instanceof Error);
    assert.equal(
      failing.emitted.some((event) => event.type === "sessionClosed"),
      false,
      "a failed close must not publish success",
    );
    await assert.rejects(
      supervisor.sendUserMessage(failing.record.ref, { text: "must not run" }),
      /closing and cannot accept new work/,
    );

    await supervisor.closeSession(failing.record.ref);
    assert.equal(disposeAttempts, 2, "retry must attempt the real runtime dispose again");
    assert.equal(failing.record.closed, true);
    assert.equal(failing.record.status, "idle");
    assert.equal(failing.record.runtime, undefined);
    assert.equal(failing.record.session, undefined);
    assert.equal(failing.record.leasePath, undefined, "retry success must release the lease");
    await assert.rejects(readFile(leasePath, "utf8"), { code: "ENOENT" });
    assert.equal(failing.record.closeRequested, false);
    assert.ok(failing.emitted.some((event) => event.type === "sessionClosed"));
    assert.equal(records.length, 2);
  } finally {
    await rm(leaseDirectory, { recursive: true, force: true });
  }
});
