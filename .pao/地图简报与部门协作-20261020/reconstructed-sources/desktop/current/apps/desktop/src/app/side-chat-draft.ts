import { useCallback, type RefObject } from "react";
import type { SessionRef } from "@pi-gui/session-driver/types";
import type { DesktopAppState } from "../../contracts/desktop-state";
import type { PiDesktopApi } from "../../contracts/ipc";
import { restoreTopmostDialogFocus } from "../ui/dialog-focus";

export type SideChatDraftResult = { readonly ok: boolean; readonly message: string };

export function useComposerAssist(params: {
  readonly api: PiDesktopApi | undefined;
  readonly currentTarget: RefObject<SessionRef | null>;
  readonly composerRef: RefObject<HTMLTextAreaElement | null>;
  readonly readDraft: () => string;
  readonly writeDraft: (text: string) => void;
}) {
  const { api, currentTarget, composerRef, readDraft, writeDraft } = params;
  const focusComposer = useCallback(() => {
    window.requestAnimationFrame(() => {
      if (restoreTopmostDialogFocus()) return;
      composerRef.current?.focus();
    });
  }, [composerRef]);

  /** 辅助问答只回填仍存在的同一来源任务，且不覆盖用户已有草稿。 */
  const prepareSideChatDraft = useCallback(
    async (source: SessionRef, text: string): Promise<SideChatDraftResult> => {
      if (!api) return { ok: false, message: "桌面接口不可用，草稿未写入。" };
      const fresh = await api.getState();
      const error = sideChatSourceError(fresh, currentTarget.current, source, readDraft());
      if (error) return { ok: false, message: error };
      writeDraft(text);
      focusComposer();
      return sideChatDraftPlaced();
    },
    [api, currentTarget, focusComposer, readDraft, writeDraft],
  );

  return { focusComposer, prepareSideChatDraft };
}

/**
 * 辅助问答回填来源主对话前，同时复核当前目标和宿主快照。
 * 这里只做判断；写入空草稿与聚焦仍由 App 的现有草稿机制完成。
 */
export function sideChatSourceError(
  state: DesktopAppState,
  current: SessionRef | null,
  source: SessionRef,
  draft: string,
): string | undefined {
  if (
    !current ||
    current.workspaceId !== source.workspaceId ||
    current.sessionId !== source.sessionId
  )
    return "来源主对话已切换，草稿未写入。";
  const exists = state.workspaces.some(
    (workspace) =>
      workspace.id === source.workspaceId &&
      workspace.sessions.some((session) => session.id === source.sessionId),
  );
  if (!exists) return "来源主对话已不存在，草稿未写入。";
  return draft.trim() ? "来源主对话已有草稿，未覆盖；请先手动处理现有内容。" : undefined;
}

export function sideChatDraftPlaced(): SideChatDraftResult {
  return { ok: true, message: "已填入来源主对话草稿，尚未发送。" };
}
