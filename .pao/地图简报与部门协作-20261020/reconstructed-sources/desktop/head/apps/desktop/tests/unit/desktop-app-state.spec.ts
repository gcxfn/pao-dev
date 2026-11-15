import { expect, test } from "@playwright/test";
import type { Dispatch, SetStateAction } from "react";
import {
  classifyHydrationFailure,
  deriveDesktopAppView,
  initialDesktopHydrationModel,
  reduceDesktopHydration,
  retryableHydrationTargets,
  updateSnapshot,
  type DesktopHydrationModel,
} from "../../src/app/desktop-app-state";
import {
  createEmptyDesktopAppState,
  type DesktopAppState,
  type SelectedTranscriptRecord,
} from "../../contracts/desktop-state";

const SENTINEL = "secret-token=/private/path";

function stateHarness(initial: DesktopAppState) {
  let state: DesktopAppState | null = initial;
  const setState: Dispatch<SetStateAction<DesktopAppState | null>> = (update) => {
    state = typeof update === "function" ? update(state) : update;
  };
  return { setState, read: () => state };
}

function snapshot(revision: number, extra: Partial<DesktopAppState> = {}): DesktopAppState {
  return { ...createEmptyDesktopAppState(), revision, ...extra };
}

function reduceAll(
  events: Parameters<typeof reduceDesktopHydration>[1][],
  start: DesktopHydrationModel = initialDesktopHydrationModel(),
): DesktopHydrationModel {
  return events.reduce((current, event) => reduceDesktopHydration(current, event), start);
}

test("failed snapshot actions preserve the draft and reject before success handlers run", async () => {
  const initial = { ...createEmptyDesktopAppState(), revision: 7, composerDraft: "unsent draft" };
  const state = stateHarness(initial);
  const failure = new Error("Session unavailable");
  let ranSuccessHandler = false;
  const action = updateSnapshot(state.setState, () => Promise.reject(failure)).then(() => {
    ranSuccessHandler = true;
  });

  await expect(action).rejects.toBe(failure);
  expect(ranSuccessHandler).toBe(false);
  expect(state.read()).toEqual({ ...initial, lastError: "Session unavailable" });
});

test("successful actions apply fresh snapshots without replacing newer pushed state", async () => {
  const initial = { ...createEmptyDesktopAppState(), revision: 7, composerDraft: "initial" };
  const state = stateHarness(initial);
  const fresh = { ...initial, revision: 8, composerDraft: "saved" };
  await expect(updateSnapshot(state.setState, () => Promise.resolve(fresh))).resolves.toBe(fresh);
  expect(state.read()).toBe(fresh);

  const pushed = { ...fresh, revision: 10, composerDraft: "newer pushed draft" };
  state.setState(pushed);
  const stale = { ...fresh, revision: 9, composerDraft: "stale response" };
  await updateSnapshot(state.setState, () => Promise.resolve(stale));
  expect(state.read()).toBe(pushed);
});

test("classifyHydrationFailure keeps only the capability code", () => {
  const stateFailure = classifyHydrationFailure("state", new Error(SENTINEL));
  const transcriptFailure = classifyHydrationFailure("selected-transcript", new Error(SENTINEL));

  expect(stateFailure).toEqual({ code: "state-request-failed" });
  expect(transcriptFailure).toEqual({ code: "selected-transcript-request-failed" });
  expect(JSON.stringify(stateFailure)).not.toContain("secret");
  expect(JSON.stringify(transcriptFailure)).not.toContain("secret");
  expect(JSON.stringify(stateFailure)).not.toContain("/private/path");
});

test("a successful state pull is ready even when the transcript pull fails", () => {
  const diagnostics = [{ scope: "workspace" as const, message: "workspace missing" }];
  const state = snapshot(4, { startupDiagnostics: diagnostics });
  const model = reduceAll([
    { type: "state-pull-started", attemptId: 1 },
    { type: "transcript-pull-started", attemptId: 2 },
    { type: "transcript-pull-failed", attemptId: 2 },
    { type: "state-pull-succeeded", attemptId: 1, state },
  ]);
  const view = deriveDesktopAppView(model);

  expect(view).toEqual({
    kind: "ready",
    snapshot: state,
    transcript: {
      kind: "failed",
      failure: { code: "selected-transcript-request-failed" },
      retrying: false,
    },
  });
  expect(view.kind === "ready" ? view.snapshot.startupDiagnostics : null).toBe(diagnostics);
});

test("a failed state pull does not block a later ready shell after the transcript already settled", () => {
  const record: SelectedTranscriptRecord = {
    workspaceId: "ws",
    sessionId: "s",
    transcript: [],
  };
  const recovered = snapshot(2);
  let model = reduceAll([
    { type: "state-pull-started", attemptId: 1 },
    { type: "transcript-pull-started", attemptId: 2 },
    { type: "state-pull-failed", attemptId: 1 },
    { type: "transcript-pull-succeeded", attemptId: 2, record },
  ]);

  expect(deriveDesktopAppView(model)).toEqual({
    kind: "failed",
    failure: { code: "state-request-failed" },
    retrying: false,
  });
  expect(model.transcriptRecord).toBe(record);

  model = reduceAll(
    [
      { type: "state-pull-started", attemptId: 3 },
      { type: "state-pull-succeeded", attemptId: 3, state: recovered },
    ],
    model,
  );
  const view = deriveDesktopAppView(model);
  expect(view.kind).toBe("ready");
  if (view.kind === "ready") {
    expect(view.snapshot).toBe(recovered);
    expect(view.transcript).toEqual({ kind: "ready", record });
  }
});

test("retryableHydrationTargets skip in-flight lanes and a missing bridge", () => {
  const inFlight = reduceAll([
    { type: "state-pull-started", attemptId: 1 },
    { type: "transcript-pull-started", attemptId: 2 },
  ]);
  expect(retryableHydrationTargets(inFlight)).toEqual([]);

  const failedState = reduceDesktopHydration(inFlight, {
    type: "state-pull-failed",
    attemptId: 1,
  });
  expect(retryableHydrationTargets(failedState)).toEqual(["state"]);

  const bothFailed = reduceDesktopHydration(failedState, {
    type: "transcript-pull-failed",
    attemptId: 2,
  });
  expect(retryableHydrationTargets(bothFailed).slice().sort()).toEqual([
    "selected-transcript",
    "state",
  ]);

  const bridgeless = reduceDesktopHydration(bothFailed, { type: "bridge-missing" });
  expect(retryableHydrationTargets(bridgeless)).toEqual([]);
  expect(deriveDesktopAppView(bridgeless)).toEqual({
    kind: "failed",
    failure: { code: "bridge-unavailable" },
    retrying: false,
  });
});

test("stale pull attempts and older revisions do not replace live state", () => {
  const first = snapshot(3);
  const pushed = snapshot(5, { composerDraft: "from push" });
  const stale = snapshot(4, { composerDraft: "stale pull" });
  const model = reduceAll([
    { type: "state-pull-started", attemptId: 1 },
    { type: "state-pull-started", attemptId: 2 },
    { type: "state-pull-succeeded", attemptId: 1, state: first },
    { type: "state-pushed", state: pushed },
    { type: "state-pull-succeeded", attemptId: 2, state: stale },
  ]);

  expect(model.stateInFlightId).toBeNull();
  expect(model.liveSnapshot).toBe(pushed);
  expect(deriveDesktopAppView(model).kind).toBe("ready");
});

test("a transcript push after pull start wins over the later pull result", () => {
  const pushed: SelectedTranscriptRecord = {
    workspaceId: "ws",
    sessionId: "live",
    transcript: [],
  };
  const pulled: SelectedTranscriptRecord = {
    workspaceId: "ws",
    sessionId: "stale",
    transcript: [],
  };
  const model = reduceAll([
    { type: "transcript-pull-started", attemptId: 1 },
    { type: "transcript-pushed", record: pushed },
    { type: "transcript-pull-succeeded", attemptId: 1, record: pulled },
  ]);

  expect(model.transcriptRecord).toBe(pushed);
  expect(deriveDesktopAppView(model)).toMatchObject({
    kind: "loading",
  });
  const ready = reduceDesktopHydration(model, {
    type: "state-pushed",
    state: snapshot(1),
  });
  expect(deriveDesktopAppView(ready)).toEqual({
    kind: "ready",
    snapshot: snapshot(1),
    transcript: { kind: "ready", record: pushed },
  });
});

test("a failed state pull does not clear a snapshot that a push already provided", () => {
  const live = snapshot(8, { composerDraft: "keep me" });
  const model = reduceAll([
    { type: "state-pushed", state: live },
    { type: "state-pull-started", attemptId: 1 },
    { type: "state-pull-failed", attemptId: 1 },
  ]);

  expect(model.stateFailed).toBe(false);
  expect(deriveDesktopAppView(model)).toEqual({
    kind: "ready",
    snapshot: live,
    transcript: { kind: "loading" },
  });
  expect(retryableHydrationTargets(model)).toEqual(["selected-transcript"]);
});

test("a late transcript pull failure does not hide a pushed transcript", () => {
  const pushed: SelectedTranscriptRecord = {
    workspaceId: "ws",
    sessionId: "live",
    transcript: [],
  };
  const live = snapshot(1, { selectedWorkspaceId: "ws", selectedSessionId: "live" });
  const model = reduceAll([
    { type: "state-pushed", state: live },
    { type: "transcript-pull-started", attemptId: 1 },
    { type: "transcript-pushed", record: pushed },
    { type: "transcript-pull-failed", attemptId: 1 },
  ]);

  expect(model.transcriptRecord).toBe(pushed);
  expect(model.transcriptFailed).toBe(false);
  expect(deriveDesktopAppView(model)).toEqual({
    kind: "ready",
    snapshot: live,
    transcript: { kind: "ready", record: pushed },
  });
  expect(retryableHydrationTargets(model)).toEqual([]);
});

test("switching sessions clears a transcript failure for the previous thread", () => {
  const first = snapshot(1, { selectedWorkspaceId: "ws", selectedSessionId: "a" });
  const next = snapshot(2, { selectedWorkspaceId: "ws", selectedSessionId: "b" });
  let model = reduceAll([
    { type: "state-pushed", state: first },
    { type: "transcript-pull-started", attemptId: 1 },
    { type: "transcript-pull-failed", attemptId: 1 },
  ]);

  expect(deriveDesktopAppView(model)).toEqual({
    kind: "ready",
    snapshot: first,
    transcript: {
      kind: "failed",
      failure: { code: "selected-transcript-request-failed" },
      retrying: false,
    },
  });

  model = reduceDesktopHydration(model, { type: "state-patched", snapshot: next });
  expect(model.transcriptFailed).toBe(false);
  expect(model.transcriptRecord).toBeNull();
  expect(model.transcriptInFlightId).toBeNull();
  expect(deriveDesktopAppView(model)).toEqual({
    kind: "ready",
    snapshot: next,
    transcript: { kind: "loading" },
  });

  model = reduceDesktopHydration(model, { type: "transcript-pull-failed", attemptId: 1 });
  expect(deriveDesktopAppView(model)).toEqual({
    kind: "ready",
    snapshot: next,
    transcript: { kind: "loading" },
  });

  const pushed: SelectedTranscriptRecord = {
    workspaceId: "ws",
    sessionId: "b",
    transcript: [],
  };
  model = reduceDesktopHydration(model, { type: "transcript-pushed", record: pushed });
  expect(deriveDesktopAppView(model)).toEqual({
    kind: "ready",
    snapshot: next,
    transcript: { kind: "ready", record: pushed },
  });
});

test("a session switch keeps a transcript that already matches the new selection", () => {
  const first = snapshot(1, { selectedWorkspaceId: "ws", selectedSessionId: "a" });
  const next = snapshot(2, { selectedWorkspaceId: "ws", selectedSessionId: "b" });
  const record: SelectedTranscriptRecord = {
    workspaceId: "ws",
    sessionId: "b",
    transcript: [],
  };
  const model = reduceAll([
    { type: "state-pushed", state: first },
    { type: "transcript-pushed", record },
    { type: "state-pushed", state: next },
  ]);

  expect(model.transcriptInFlightId).toBeNull();
  expect(deriveDesktopAppView(model)).toEqual({
    kind: "ready",
    snapshot: next,
    transcript: { kind: "ready", record },
  });
});

test("streaming tail updates merge into the pushed record", () => {
  const record: SelectedTranscriptRecord = {
    workspaceId: "ws",
    sessionId: "a",
    transcript: [
      {
        kind: "message",
        id: "m1",
        role: "user",
        text: "问",
        createdAt: "2026-10-10T00:00:00.000Z",
      },
      {
        kind: "message",
        id: "m2",
        role: "assistant",
        text: "答前半",
        createdAt: "2026-10-10T00:00:01.000Z",
      },
    ],
  };
  const base = reduceAll([{ type: "transcript-pushed", record }]);

  // replace-last：末条同 id 整条替换。
  const replaced = reduceDesktopHydration(base, {
    type: "transcript-tail-updated",
    update: {
      kind: "transcript-tail-update",
      workspaceId: "ws",
      sessionId: "a",
      mode: "replace-last",
      item: {
        kind: "message",
        id: "m2",
        role: "assistant",
        text: "答前半＋答后半",
        createdAt: "2026-10-10T00:00:01.000Z",
      },
    },
  });
  expect(replaced.transcriptRecord?.transcript).toHaveLength(2);
  expect(replaced.transcriptRecord?.transcript[1]).toMatchObject({ text: "答前半＋答后半" });

  // append：在末尾追加新流式消息。
  const appended = reduceDesktopHydration(replaced, {
    type: "transcript-tail-updated",
    update: {
      kind: "transcript-tail-update",
      workspaceId: "ws",
      sessionId: "a",
      mode: "append",
      item: {
        kind: "message",
        id: "m3",
        role: "assistant",
        text: "新一轮",
        createdAt: "2026-10-10T00:00:02.000Z",
      },
    },
  });
  expect(appended.transcriptRecord?.transcript).toHaveLength(3);
  expect(appended.transcriptRecord?.transcript[2]).toMatchObject({ text: "新一轮" });
});

// 审查修复轮 R2：append 增量携带的 id 若已在 transcript 中段（非末尾）出现，
// 必须整条丢弃，绝不能重复追加。
test("an append whose id already exists mid-transcript is dropped", () => {
  const record: SelectedTranscriptRecord = {
    workspaceId: "ws",
    sessionId: "a",
    transcript: [
      {
        kind: "message",
        id: "m1",
        role: "user",
        text: "问",
        createdAt: "2026-10-10T00:00:00.000Z",
      },
      {
        kind: "message",
        id: "m2",
        role: "assistant",
        text: "答",
        createdAt: "2026-10-10T00:00:01.000Z",
      },
    ],
  };
  const base = reduceAll([{ type: "transcript-pushed", record }]);

  const duplicated = reduceDesktopHydration(base, {
    type: "transcript-tail-updated",
    update: {
      kind: "transcript-tail-update",
      workspaceId: "ws",
      sessionId: "a",
      mode: "append",
      item: {
        kind: "message",
        id: "m1",
        role: "user",
        text: "重复的中段消息",
        createdAt: "2026-10-10T00:00:02.000Z",
      },
    },
  });

  expect(duplicated).toBe(base);
  expect(duplicated.transcriptRecord?.transcript).toHaveLength(2);
});

test("inapplicable tail updates are dropped without corrupting the record", () => {
  const record: SelectedTranscriptRecord = {
    workspaceId: "ws",
    sessionId: "a",
    transcript: [
      {
        kind: "message",
        id: "m1",
        role: "user",
        text: "问",
        createdAt: "2026-10-10T00:00:00.000Z",
      },
    ],
  };
  const base = reduceAll([{ type: "transcript-pushed", record }]);
  const replaceForeignId = {
    type: "transcript-tail-updated",
    update: {
      kind: "transcript-tail-update",
      workspaceId: "ws",
      sessionId: "a",
      mode: "replace-last",
      item: {
        kind: "message",
        id: "other",
        role: "assistant",
        text: "不匹配",
        createdAt: "2026-10-10T00:00:02.000Z",
      },
    },
  } as const;
  expect(reduceDesktopHydration(base, replaceForeignId)).toBe(base);

  const foreignSession = reduceDesktopHydration(base, {
    type: "transcript-tail-updated",
    update: {
      kind: "transcript-tail-update",
      workspaceId: "ws",
      sessionId: "b",
      mode: "append",
      item: {
        kind: "message",
        id: "m2",
        role: "assistant",
        text: "他会话",
        createdAt: "2026-10-10T00:00:02.000Z",
      },
    },
  });
  expect(foreignSession).toBe(base);

  // 无基线记录时（尚未收到任何全量推送）也只丢弃。
  const empty = initialDesktopHydrationModel();
  expect(
    reduceDesktopHydration(empty, {
      type: "transcript-tail-updated",
      update: replaceForeignId.update,
    }),
  ).toBe(empty);
});
