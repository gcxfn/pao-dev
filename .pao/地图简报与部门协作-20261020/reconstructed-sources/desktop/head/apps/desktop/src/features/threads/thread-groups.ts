import type {
  DesktopAppState,
  SessionRecord,
  ThreadGrouping,
  WorkspaceRecord,
} from "../../../contracts/desktop-state";
import {
  compareByRecency,
  RECENCY_BUCKET_LABELS,
  RECENCY_BUCKET_ORDER,
  recencyBucketId,
  sessionLastInteractedAt,
  type RecencyBucketId,
} from "../../../contracts/thread-recency";

export interface ThreadEnvironmentMeta {
  readonly kind: "local" | "worktree";
  readonly label: string;
  readonly branchName?: string;
  readonly detached?: boolean;
}

export interface ThreadListEntry {
  readonly folderId: string;
  readonly workspaceId: string;
  readonly session: SessionRecord;
  readonly environment: ThreadEnvironmentMeta;
  readonly contextLabel: string;
}

export interface WorkspaceThreadGroup {
  readonly workspace: WorkspaceRecord;
  readonly threads: readonly ThreadListEntry[];
}

export const THREAD_HISTORY_PREVIEW_LIMIT = 5;

/**
 * Fixed i18n key of the group that holds sessions belonging to no folder;
 * workspace grouping renders it pinned below every workspace group.
 */
export const CONVERSATIONS_GROUP_LABEL = "Conversations";

export function threadHistoryPreview<T>(
  threads: readonly T[],
  expanded: boolean,
): { readonly visible: readonly T[]; readonly overflow: boolean } {
  const overflow = threads.length > THREAD_HISTORY_PREVIEW_LIMIT;
  return {
    visible: overflow && !expanded ? threads.slice(0, THREAD_HISTORY_PREVIEW_LIMIT) : threads,
    overflow,
  };
}

export interface RecencyThreadSection {
  readonly bucket: RecencyBucketId;
  readonly label: string;
  readonly threads: readonly ThreadListEntry[];
}

export interface ThreadSidebarModel {
  readonly folders: readonly WorkspaceRecord[];
  readonly workspaceGroups: readonly WorkspaceThreadGroup[];
  /**
   * Sessions that belong to no folder group (for example a worktree workspace whose
   * root is known but that is not linked under any folder). Workspace grouping shows
   * them in the fixed "Conversations" group pinned below every workspace group.
   */
  readonly conversationsThreads: readonly ThreadListEntry[];
  readonly pinnedThreads: readonly ThreadListEntry[];
  readonly recencySections: readonly RecencyThreadSection[];
  readonly archivedThreads: readonly ThreadListEntry[];
  readonly recencyOrder: readonly ThreadListEntry[];
}

export function buildThreadSidebarModel(
  state: DesktopAppState,
  nowMs: number = Date.now(),
): ThreadSidebarModel {
  const entries = collectThreadEntries(state);
  const pinnedThreads = entries
    .filter((entry) => !entry.session.archivedAt && Boolean(entry.session.pinnedAt))
    .sort((left, right) => comparePinnedThreads(left, right, state.pinnedSessionOrder));
  const historyThreads = entries
    .filter((entry) => !entry.session.archivedAt && !entry.session.pinnedAt)
    .sort((left, right) => compareByRecency(left.session, right.session));
  const archivedThreads = entries
    .filter((entry) => Boolean(entry.session.archivedAt))
    .sort((left, right) => compareByRecency(left.session, right.session));
  const recencyOrder = entries
    .filter((entry) => !entry.session.archivedAt)
    .sort((left, right) => compareByRecency(left.session, right.session));

  const folders = listFolders(state);
  const conversationsThreads = collectUnfiledEntries(state, entries);
  return {
    folders,
    workspaceGroups: folders.map((workspace) => ({
      workspace,
      threads: historyThreads.filter((entry) => entry.folderId === workspace.id),
    })),
    conversationsThreads,
    pinnedThreads,
    recencySections: RECENCY_BUCKET_ORDER.flatMap((bucket) => {
      const threads = historyThreads.filter(
        (entry) => recencyBucketId(sessionLastInteractedAt(entry.session), nowMs) === bucket,
      );
      return threads.length > 0 ? [{ bucket, label: RECENCY_BUCKET_LABELS[bucket], threads }] : [];
    }),
    archivedThreads,
    recencyOrder,
  };
}

/**
 * Sessions that no folder group claims: any non-archived session in a workspace whose
 * entry was not collected under a folder (a worktree workspace with a known root that
 * is not linked under it). Sorted by recency; workspace grouping pins them at the
 * bottom of the list in the fixed "Conversations" group instead of dropping them.
 */
function collectUnfiledEntries(
  state: DesktopAppState,
  entries: readonly ThreadListEntry[],
): ThreadListEntry[] {
  const filed = new Set(entries.map((entry) => sessionThreadKey(entry)));
  const unfiled: ThreadListEntry[] = [];
  for (const workspace of state.workspaces) {
    for (const session of workspace.sessions) {
      if (session.archivedAt) continue;
      if (filed.has(`${workspace.id}:${session.id}`)) continue;
      unfiled.push({
        folderId: "",
        workspaceId: workspace.id,
        session,
        environment: {
          kind: "local" as const,
          label: "Local",
        },
        contextLabel: workspace.name,
      });
    }
  }
  return unfiled.sort((left, right) => compareByRecency(left.session, right.session));
}

function listFolders(state: DesktopAppState): readonly WorkspaceRecord[] {
  const workspacesById = new Map(
    state.workspaces.map((workspace) => [workspace.id, workspace] as const),
  );
  const rootWorkspaces = state.workspaces.filter((workspace) => workspace.kind === "primary");
  const orphanWorktrees = state.workspaces.filter(
    (workspace) =>
      workspace.kind === "worktree" && !workspacesById.has(workspace.rootWorkspaceId ?? ""),
  );
  const order = state.workspaceOrder;
  const sortedRoots = [...rootWorkspaces].sort((a, b) => {
    const ai = order.indexOf(a.id);
    const bi = order.indexOf(b.id);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return -1;
    if (bi === -1) return 1;
    return ai - bi;
  });
  return [...sortedRoots, ...orphanWorktrees];
}

function collectThreadEntries(state: DesktopAppState): ThreadListEntry[] {
  const workspacesById = new Map(
    state.workspaces.map((workspace) => [workspace.id, workspace] as const),
  );
  const folders = listFolders(state);
  return folders.flatMap((folder) => {
    if (folder.kind !== "primary") {
      return folder.sessions.map((session) => ({
        folderId: folder.id,
        workspaceId: folder.id,
        session,
        environment: {
          kind: "worktree" as const,
          label: folder.name,
          branchName: folder.branchName,
          detached: !folder.branchName,
        },
        contextLabel: folder.name,
      }));
    }

    const linkedWorkspaces = (state.worktreesByWorkspace[folder.id] ?? [])
      .map((worktree) => ({
        worktree,
        workspace: worktree.linkedWorkspaceId
          ? workspacesById.get(worktree.linkedWorkspaceId)
          : undefined,
      }))
      .filter(
        (
          entry,
        ): entry is {
          worktree: NonNullable<(typeof state.worktreesByWorkspace)[string][number]>;
          workspace: WorkspaceRecord;
        } => Boolean(entry.workspace),
      );

    return [
      ...folder.sessions.map((session) => ({
        folderId: folder.id,
        workspaceId: folder.id,
        session,
        environment: {
          kind: "local" as const,
          label: "Local",
        },
        contextLabel: folder.name,
      })),
      ...linkedWorkspaces.flatMap(({ workspace, worktree }) =>
        workspace.sessions.map((session) => ({
          folderId: folder.id,
          workspaceId: workspace.id,
          session,
          environment: {
            kind: "worktree" as const,
            label: worktree.name,
            branchName: worktree.branchName,
            detached: !worktree.branchName,
          },
          contextLabel: `${folder.name} / ${worktree.name}`,
        })),
      ),
    ];
  });
}

export function sessionThreadKey(thread: ThreadListEntry): string {
  return `${thread.workspaceId}:${thread.session.id}`;
}

const EMPTY_EXPANDED_HISTORY: ReadonlySet<string> = new Set();

export function workspaceHistoryExpansionKey(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}

export function recencyHistoryExpansionKey(bucket: RecencyBucketId): string {
  return `bucket:${bucket}`;
}

export interface VisibleThreadShortcutOptions {
  readonly grouping: ThreadGrouping;
  readonly model: ThreadSidebarModel;
  readonly expandedHistory?: ReadonlySet<string>;
  readonly archivedOpen?: boolean;
  /** Folder groups folded shut in the sidebar; their rows are not on screen. */
  readonly collapsedWorkspaceIds?: readonly string[];
}

export function visibleThreadShortcutOrder(
  options: VisibleThreadShortcutOptions,
): readonly ThreadListEntry[] {
  const expandedHistory = options.expandedHistory ?? EMPTY_EXPANDED_HISTORY;
  const collapsedWorkspaceIds = new Set(options.collapsedWorkspaceIds ?? []);
  const conversations =
    options.grouping === "workspace" ? options.model.conversationsThreads : [];
  const unpinned =
    options.grouping === "workspace"
      ? options.model.workspaceGroups
          .filter((group) => !collapsedWorkspaceIds.has(group.workspace.id))
          .flatMap(
            (group) =>
              threadHistoryPreview(
                group.threads,
                expandedHistory.has(workspaceHistoryExpansionKey(group.workspace.id)),
              ).visible,
          )
      : options.model.recencySections.flatMap(
          (section) =>
            threadHistoryPreview(
              section.threads,
              expandedHistory.has(recencyHistoryExpansionKey(section.bucket)),
            ).visible,
        );
  return [
    ...options.model.pinnedThreads,
    ...unpinned,
    ...conversations,
    ...(options.archivedOpen ? options.model.archivedThreads : []),
  ];
}

export function comparePinnedThreads(
  left: ThreadListEntry,
  right: ThreadListEntry,
  pinnedSessionOrder: readonly string[] = [],
): number {
  const order = new Map(pinnedSessionOrder.map((key, index) => [key, index] as const));
  const leftIndex = order.get(sessionThreadKey(left));
  const rightIndex = order.get(sessionThreadKey(right));
  if (leftIndex !== undefined || rightIndex !== undefined) {
    if (leftIndex === undefined) return 1;
    if (rightIndex === undefined) return -1;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  }
  const leftPinnedAt = left.session.pinnedAt ?? "";
  const rightPinnedAt = right.session.pinnedAt ?? "";
  if (leftPinnedAt !== rightPinnedAt) {
    return rightPinnedAt.localeCompare(leftPinnedAt);
  }
  return compareByRecency(left.session, right.session);
}
