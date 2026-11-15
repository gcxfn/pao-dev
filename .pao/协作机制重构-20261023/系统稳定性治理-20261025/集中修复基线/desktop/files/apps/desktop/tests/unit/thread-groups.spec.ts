import { expect, test } from "@playwright/test";
import { zhTranslations } from "../../contracts/i18n-zh";
import {
  createEmptyDesktopAppState,
  type DesktopAppState,
  type SessionRecord,
  type WorkspaceRecord,
  type WorktreeRecord,
} from "../../contracts/desktop-state";
import {
  CONVERSATIONS_GROUP_LABEL,
  buildThreadSidebarModel,
  recencyHistoryExpansionKey,
  sessionThreadKey,
  threadHistoryPreview,
  visibleThreadShortcutOrder,
  workspaceHistoryExpansionKey,
} from "../../src/features/threads/thread-groups";

const now = new Date(2026, 8, 21, 15, 0, 0);
const nowMs = now.getTime();

function isoDaysAgo(days: number, hour = 12): string {
  return new Date(2026, 8, 21 - days, hour, 0, 0).toISOString();
}

function session(
  id: string,
  title: string,
  extra: Partial<SessionRecord> & { readonly updatedAt: string },
): SessionRecord {
  return {
    id,
    title,
    preview: "",
    status: "idle",
    hasUnseenUpdate: false,
    ...extra,
  };
}

function workspace(
  id: string,
  name: string,
  sessions: readonly SessionRecord[],
  extra: Partial<WorkspaceRecord> = {},
): WorkspaceRecord {
  return {
    id,
    name,
    path: `/tmp/${name}`,
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
    kind: "primary",
    sessions,
    ...extra,
  };
}

function state(
  workspaces: readonly WorkspaceRecord[],
  extra: Partial<DesktopAppState> = {},
): DesktopAppState {
  return {
    ...createEmptyDesktopAppState(),
    workspaces,
    workspaceOrder: workspaces.filter((entry) => entry.kind === "primary").map((entry) => entry.id),
    ...extra,
  };
}

test("omits empty date buckets and mixed-folder threads share one recency list", () => {
  const model = buildThreadSidebarModel(
    state([
      workspace("alpha", "Alpha", [
        session("today", "Today thread", { updatedAt: isoDaysAgo(0) }),
        session("older", "Older thread", { updatedAt: isoDaysAgo(40) }),
      ]),
      workspace("beta", "Beta", [session("week", "Week thread", { updatedAt: isoDaysAgo(2) })]),
    ]),
    nowMs,
  );

  expect(model.folders.map((folder) => folder.name)).toEqual(["Alpha", "Beta"]);
  expect(model.recencySections.map((section) => section.bucket)).toEqual([
    "today",
    "last-7-days",
    "older",
  ]);
  expect(
    model.recencySections.find((section) => section.bucket === "last-30-days"),
  ).toBeUndefined();
  expect(model.recencySections[0]?.threads.map((thread) => thread.session.title)).toEqual([
    "Today thread",
  ]);
  expect(model.recencySections[1]?.threads[0]?.contextLabel).toBe("Beta");
  expect(model.recencyOrder.map((thread) => thread.session.title)).toEqual([
    "Today thread",
    "Week thread",
    "Older thread",
  ]);
});

test("keeps pins out of date buckets even when the pin is the latest send", () => {
  const pinned = session("pin", "Pinned recent", {
    updatedAt: isoDaysAgo(8),
    lastInteractedAt: isoDaysAgo(0, 16),
    pinnedAt: isoDaysAgo(1),
  });
  const today = session("today", "Unpinned today", {
    updatedAt: isoDaysAgo(0, 10),
    lastInteractedAt: isoDaysAgo(0, 10),
  });
  const model = buildThreadSidebarModel(
    state([workspace("alpha", "Alpha", [pinned, today])]),
    nowMs,
  );

  expect(model.pinnedThreads.map((thread) => thread.session.title)).toEqual(["Pinned recent"]);
  expect(model.recencySections.map((section) => section.bucket)).toEqual(["today"]);
  expect(model.recencySections[0]?.threads.map((thread) => thread.session.title)).toEqual([
    "Unpinned today",
  ]);
  expect(model.recencyOrder.map((thread) => thread.session.title)).toEqual([
    "Pinned recent",
    "Unpinned today",
  ]);
  expect(sessionThreadKey(model.recencyOrder[0]!)).toBe("alpha:pin");
});

test("puts a newer unpinned send ahead of an older pin in recencyOrder", () => {
  const pinned = session("pin", "Older pin", {
    updatedAt: isoDaysAgo(8),
    lastInteractedAt: isoDaysAgo(2),
    pinnedAt: isoDaysAgo(1),
  });
  const sent = session("send", "Newer send", {
    updatedAt: isoDaysAgo(0, 16),
    lastInteractedAt: isoDaysAgo(0, 16),
  });
  const model = buildThreadSidebarModel(
    state([workspace("alpha", "Alpha", [pinned, sent])]),
    nowMs,
  );

  expect(model.pinnedThreads.map((thread) => thread.session.title)).toEqual(["Older pin"]);
  expect(model.recencySections[0]?.threads.map((thread) => thread.session.title)).toEqual([
    "Newer send",
  ]);
  expect(model.recencyOrder.map((thread) => thread.session.title)).toEqual([
    "Newer send",
    "Older pin",
  ]);
});

test("excludes archived threads from recencyOrder and date buckets", () => {
  const model = buildThreadSidebarModel(
    state([
      workspace("alpha", "Alpha", [
        session("live", "Live", { updatedAt: isoDaysAgo(0) }),
        session("archived", "Archived", {
          updatedAt: isoDaysAgo(0, 18),
          archivedAt: isoDaysAgo(0, 18),
        }),
      ]),
    ]),
    nowMs,
  );

  expect(model.archivedThreads.map((thread) => thread.session.title)).toEqual(["Archived"]);
  expect(model.recencyOrder.map((thread) => thread.session.title)).toEqual(["Live"]);
  expect(model.recencySections[0]?.threads.map((thread) => thread.session.title)).toEqual(["Live"]);
});

test("does not let a newer lastViewedAt steal recency from lastInteractedAt", () => {
  const staleOpen = session("stale", "Stale open", {
    updatedAt: isoDaysAgo(3),
    lastInteractedAt: isoDaysAgo(3),
    lastViewedAt: isoDaysAgo(0, 18),
  });
  const recentSend = session("send", "Recent send", {
    updatedAt: isoDaysAgo(0, 8),
    lastInteractedAt: isoDaysAgo(0, 8),
    lastViewedAt: isoDaysAgo(10),
  });
  const model = buildThreadSidebarModel(
    state([workspace("alpha", "Alpha", [staleOpen, recentSend])]),
    nowMs,
  );

  expect(model.recencyOrder.map((thread) => thread.session.title)).toEqual([
    "Recent send",
    "Stale open",
  ]);
  expect(model.recencySections.map((section) => section.bucket)).toEqual(["today", "last-7-days"]);
});

test("labels worktree sessions with folder context", () => {
  const root = workspace("root", "Repo", [
    session("local", "Local thread", { updatedAt: isoDaysAgo(0) }),
  ]);
  const worktreeWorkspace = workspace(
    "wt",
    "feature",
    [session("wt-thread", "Worktree thread", { updatedAt: isoDaysAgo(0, 11) })],
    { kind: "worktree", rootWorkspaceId: "root", branchName: "feature" },
  );
  const worktree: WorktreeRecord = {
    id: "wt-record",
    rootWorkspaceId: "root",
    linkedWorkspaceId: "wt",
    name: "feature",
    path: "/tmp/feature",
    status: "ready",
    branchName: "feature",
    updatedAt: isoDaysAgo(0),
  };
  const model = buildThreadSidebarModel(
    state([root, worktreeWorkspace], { worktreesByWorkspace: { root: [worktree] } }),
    nowMs,
  );

  const worktreeEntry = model.recencyOrder.find((thread) => thread.session.id === "wt-thread");
  expect(worktreeEntry?.contextLabel).toBe("Repo / feature");
  expect(worktreeEntry?.environment.kind).toBe("worktree");
  expect(worktreeEntry?.folderId).toBe("root");
  expect(
    model.workspaceGroups
      .find((group) => group.workspace.id === "root")
      ?.threads.map((thread) => thread.session.title),
  ).toEqual(["Local thread", "Worktree thread"]);
});

test("sorts a workspace folder by last user message, not catalog updatedAt", () => {
  const opened = session("opened", "Opened recently", {
    updatedAt: isoDaysAgo(0, 18),
    lastInteractedAt: isoDaysAgo(3),
  });
  const sent = session("sent", "Sent earlier today", {
    updatedAt: isoDaysAgo(4),
    lastInteractedAt: isoDaysAgo(0, 9),
  });
  const model = buildThreadSidebarModel(
    state([workspace("alpha", "Alpha", [opened, sent])]),
    nowMs,
  );

  expect(model.workspaceGroups[0]?.threads.map((thread) => thread.session.title)).toEqual([
    "Sent earlier today",
    "Opened recently",
  ]);
});

test("numbers shortcut slots pinned first, then visible rows", () => {
  const olderPin = session("pin", "Older pin", {
    updatedAt: isoDaysAgo(8),
    lastInteractedAt: isoDaysAgo(2),
    pinnedAt: isoDaysAgo(1),
  });
  const newerSend = session("send", "Newer send", {
    updatedAt: isoDaysAgo(0, 16),
    lastInteractedAt: isoDaysAgo(0, 16),
  });
  const hidden = Array.from({ length: 5 }, (_, index) =>
    session(`extra-${index}`, `Extra ${index}`, {
      updatedAt: isoDaysAgo(0, 10 - index),
      lastInteractedAt: isoDaysAgo(0, 10 - index),
    }),
  );
  const week = session("week", "Week thread", {
    updatedAt: isoDaysAgo(3),
    lastInteractedAt: isoDaysAgo(3),
  });
  const archived = session("archived", "Archived", {
    updatedAt: isoDaysAgo(0, 18),
    lastInteractedAt: isoDaysAgo(0, 18),
    archivedAt: isoDaysAgo(0, 18),
  });
  const model = buildThreadSidebarModel(
    state([workspace("alpha", "Alpha", [olderPin, newerSend, ...hidden, week, archived])], {
      pinnedSessionOrder: ["alpha:pin"],
    }),
    nowMs,
  );

  expect(model.recencyOrder[0]?.session.title).toBe("Newer send");
  expect(
    visibleThreadShortcutOrder({ grouping: "time", model }).map((thread) => thread.session.title),
  ).toEqual(["Older pin", "Newer send", "Extra 0", "Extra 1", "Extra 2", "Extra 3", "Week thread"]);
  expect(
    visibleThreadShortcutOrder({
      grouping: "time",
      model,
      expandedHistory: new Set([recencyHistoryExpansionKey("today")]),
    }).map((thread) => thread.session.title),
  ).toEqual([
    "Older pin",
    "Newer send",
    "Extra 0",
    "Extra 1",
    "Extra 2",
    "Extra 3",
    "Extra 4",
    "Week thread",
  ]);
  expect(
    visibleThreadShortcutOrder({ grouping: "time", model, archivedOpen: true }).at(-1)?.session
      .title,
  ).toBe("Archived");
});

test("numbers workspace rows after pins, skipping collapsed overflow", () => {
  const pin = session("pin", "Pinned", {
    updatedAt: isoDaysAgo(1),
    lastInteractedAt: isoDaysAgo(1),
    pinnedAt: isoDaysAgo(0),
  });
  const alphaThreads = Array.from({ length: 6 }, (_, index) =>
    session(`a-${index}`, `Alpha ${index}`, {
      updatedAt: isoDaysAgo(0, 12 - index),
      lastInteractedAt: isoDaysAgo(0, 12 - index),
    }),
  );
  const beta = session("b", "Beta thread", {
    updatedAt: isoDaysAgo(0, 8),
    lastInteractedAt: isoDaysAgo(0, 8),
  });
  const model = buildThreadSidebarModel(
    state(
      [workspace("alpha", "Alpha", [pin, ...alphaThreads]), workspace("beta", "Beta", [beta])],
      { pinnedSessionOrder: ["alpha:pin"] },
    ),
    nowMs,
  );

  expect(
    visibleThreadShortcutOrder({ grouping: "workspace", model }).map(
      (thread) => thread.session.title,
    ),
  ).toEqual(["Pinned", "Alpha 0", "Alpha 1", "Alpha 2", "Alpha 3", "Alpha 4", "Beta thread"]);
  expect(
    visibleThreadShortcutOrder({
      grouping: "workspace",
      model,
      expandedHistory: new Set([workspaceHistoryExpansionKey("alpha")]),
    }).map((thread) => thread.session.title),
  ).toEqual([
    "Pinned",
    "Alpha 0",
    "Alpha 1",
    "Alpha 2",
    "Alpha 3",
    "Alpha 4",
    "Alpha 5",
    "Beta thread",
  ]);
});

test("numbers workspace rows only for folders that are open", () => {
  const alpha = session("a", "Alpha thread", {
    updatedAt: isoDaysAgo(0, 12),
    lastInteractedAt: isoDaysAgo(0, 12),
  });
  const beta = session("b", "Beta thread", {
    updatedAt: isoDaysAgo(0, 8),
    lastInteractedAt: isoDaysAgo(0, 8),
  });
  const model = buildThreadSidebarModel(
    state([workspace("alpha", "Alpha", [alpha]), workspace("beta", "Beta", [beta])]),
    nowMs,
  );

  expect(
    visibleThreadShortcutOrder({
      grouping: "workspace",
      model,
      collapsedWorkspaceIds: ["alpha"],
    }).map((thread) => thread.session.title),
  ).toEqual(["Beta thread"]);
  // Time buckets have no folders to fold, so every row stays numbered.
  expect(
    visibleThreadShortcutOrder({
      grouping: "time",
      model,
      collapsedWorkspaceIds: ["alpha"],
    }).map((thread) => thread.session.title),
  ).toEqual(["Alpha thread", "Beta thread"]);
});

test("numbers visible rows in order when nothing is pinned", () => {
  const model = buildThreadSidebarModel(
    state([
      workspace("alpha", "Alpha", [
        session("today", "Today thread", { updatedAt: isoDaysAgo(0) }),
        session("older", "Older thread", { updatedAt: isoDaysAgo(40) }),
      ]),
    ]),
    nowMs,
  );

  expect(
    visibleThreadShortcutOrder({ grouping: "time", model }).map((thread) => thread.session.title),
  ).toEqual(["Today thread", "Older thread"]);
});

test("pins sessions with no folder group at the bottom of workspace grouping", () => {
  const root = workspace("root", "Repo", [
    session("local", "Local thread", { updatedAt: isoDaysAgo(0) }),
  ]);
  // A worktree workspace whose root exists but that is not linked under any folder:
  // its sessions belong to no group, so they land in the fixed Conversations group.
  const unfiled = workspace(
    "wt",
    "feature",
    [
      session("wt-old", "Unfiled old", { updatedAt: isoDaysAgo(2) }),
      session("wt-new", "Unfiled new", { updatedAt: isoDaysAgo(0, 11) }),
      session("wt-archived", "Archived unfiled", {
        updatedAt: isoDaysAgo(0, 10),
        archivedAt: isoDaysAgo(0, 10),
      }),
    ],
    { kind: "worktree", rootWorkspaceId: "root", branchName: "feature" },
  );
  const model = buildThreadSidebarModel(state([root, unfiled]), nowMs);
  // Recency order inside the group; archived sessions stay out.
  expect(model.conversationsThreads.map((thread) => thread.session.title)).toEqual([
    "Unfiled new",
    "Unfiled old",
  ]);
  expect(
    visibleThreadShortcutOrder({ grouping: "workspace", model }).map(
      (thread) => thread.session.title,
    ),
  ).toEqual(["Local thread", "Unfiled new", "Unfiled old"]);
  // Time grouping keeps its bucket behavior; conversations stay out of it.
  expect(
    visibleThreadShortcutOrder({ grouping: "time", model }).map((thread) => thread.session.title),
  ).toEqual(["Local thread"]);
});

test("pins the conversations group last even when threads are pinned", () => {
  const pin = session("pin", "Pinned folder thread", {
    updatedAt: isoDaysAgo(1),
    pinnedAt: isoDaysAgo(0),
  });
  const folderThread = session("f", "Folder thread", { updatedAt: isoDaysAgo(0) });
  const root = workspace("root", "Repo", [pin, folderThread]);
  const unfiled = workspace(
    "wt",
    "feature",
    [session("wt", "Unfiled thread", { updatedAt: isoDaysAgo(0, 11) })],
    { kind: "worktree", rootWorkspaceId: "root", branchName: "feature" },
  );
  const model = buildThreadSidebarModel(state([root, unfiled]), nowMs);

  expect(model.conversationsThreads.map((thread) => thread.session.title)).toEqual([
    "Unfiled thread",
  ]);
  expect(
    visibleThreadShortcutOrder({ grouping: "workspace", model }).map(
      (thread) => thread.session.title,
    ),
  ).toEqual(["Pinned folder thread", "Folder thread", "Unfiled thread"]);
});

test("keeps the conversations group empty when nothing is unfiled", () => {
  // No workspaces at all: no groups and no visible rows in either grouping.
  const empty = buildThreadSidebarModel(state([]), nowMs);
  expect(empty.conversationsThreads).toEqual([]);
  expect(empty.workspaceGroups).toEqual([]);
  expect(visibleThreadShortcutOrder({ grouping: "workspace", model: empty })).toEqual([]);
  expect(visibleThreadShortcutOrder({ grouping: "time", model: empty })).toEqual([]);

  // Every session lives under a folder, so the fixed group stays empty.
  const filed = buildThreadSidebarModel(
    state([
      workspace("alpha", "Alpha", [
        session("a", "Alpha thread", { updatedAt: isoDaysAgo(0) }),
      ]),
    ]),
    nowMs,
  );
  expect(filed.conversationsThreads).toEqual([]);
});

test("names the no-folder group with a translated zh key", () => {
  expect(CONVERSATIONS_GROUP_LABEL).toBe("Conversations");
  expect(zhTranslations[CONVERSATIONS_GROUP_LABEL]).toBe("对话");
});

test("caps a history list at five until it is expanded", () => {
  const threads = ["1", "2", "3", "4", "5", "6"];
  expect(threadHistoryPreview(threads, false)).toEqual({
    visible: ["1", "2", "3", "4", "5"],
    overflow: true,
  });
  expect(threadHistoryPreview(threads, true).visible).toEqual(threads);
  expect(threadHistoryPreview(threads.slice(0, 5), false).overflow).toBe(false);
});
