import { useCallback, useEffect, useRef, useState } from "react";
import type { PiDesktopApi } from "../../../contracts/ipc";
import type { ReviewResult } from "../../../contracts/review";
import { useViewAutoRefresh } from "../../ui/view-auto-refresh";

export interface TaskStatusFilesSummary {
  readonly state: "loading" | "available" | "unavailable";
  readonly files?: number;
  readonly added?: number;
  readonly removed?: number;
  readonly unknownLines?: number;
  readonly coverageNotes?: readonly string[];
  readonly message?: string;
}

export interface TaskStatusFilesState {
  readonly summary: TaskStatusFilesSummary;
  readonly refresh: () => void;
}

/**
 * The overview asks the existing review query for one checkout-level snapshot.
 * This query already parses untracked files and returns per-file line totals, so
 * the renderer counts its result without running a second Git status parser.
 */
export function useTaskStatusFiles(
  api: PiDesktopApi,
  target: { readonly workspaceId: string; readonly sessionId: string } | null,
): TaskStatusFilesState {
  const [summary, setSummary] = useState<TaskStatusFilesSummary>({ state: "loading" });
  const requestId = useRef(0);

  const refresh = useCallback(() => {
    const id = ++requestId.current;
    if (!target) {
      setSummary({ state: "unavailable", message: "选择会话后统计当前工作目录" });
      return;
    }
    setSummary((current) =>
      current.state === "available" ? current : ({ state: "loading" } as const),
    );
    void api
      .getReview({ target, checkoutId: target.workspaceId, scope: { kind: "uncommitted" } })
      .then((result) => {
        if (requestId.current === id) setSummary(summarizeReview(result));
      })
      .catch((error: unknown) => {
        if (requestId.current === id) {
          setSummary({
            state: "unavailable",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
  }, [api, target?.sessionId, target?.workspaceId]);

  useEffect(() => {
    refresh();
    return () => {
      requestId.current++;
    };
  }, [refresh]);
  useViewAutoRefresh(refresh);
  return { summary, refresh };
}

export function summarizeReview(result: ReviewResult): TaskStatusFilesSummary {
  if (result.state !== "available") {
    return { state: "unavailable", message: result.message };
  }
  let added = 0;
  let removed = 0;
  let unknownLines = 0;
  for (const file of result.files) {
    if (file.lines) {
      added += file.lines.added;
      removed += file.lines.removed;
    } else {
      unknownLines++;
    }
  }
  return {
    state: "available",
    files: result.files.length,
    added,
    removed,
    ...(unknownLines > 0 ? { unknownLines } : {}),
    ...(result.coverage.state === "partial" ? { coverageNotes: result.coverage.notes } : {}),
  };
}
