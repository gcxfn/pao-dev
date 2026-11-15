import type {
  SelectedTranscriptRecord,
  SelectedTranscriptTailUpdate,
} from "../../contracts/desktop-state";

/**
 * 全量 transcript 发布的增量判定：流式期间 50ms 一刷的 flush 只会改变末条
 * （appendAssistantDelta 只追加/续写活跃 assistant 消息），把这种情况降级为
 * 「尾部更新」，长会话不再每刷一次就整份 transcript 走一遍 IPC 结构化克隆
 * （总流量 O(N²)）。判定不成立时返回 full，调用方照发全量记录。
 *
 * 前缀比较用元素身份（timeline 每次写都换新数组但不动的条目保留原引用），
 * O(N) 次指针比较、零序列化，远低于一次全量克隆的成本。
 */
export type TranscriptTailDecision =
  | { readonly type: "unchanged" }
  | { readonly type: "tail"; readonly update: SelectedTranscriptTailUpdate }
  | { readonly type: "full" };

export function transcriptTailDecision(
  previous: SelectedTranscriptRecord,
  next: SelectedTranscriptRecord,
): TranscriptTailDecision {
  if (
    previous.workspaceId !== next.workspaceId ||
    previous.sessionId !== next.sessionId ||
    previous.schemaInfo !== next.schemaInfo
  ) {
    return { type: "full" };
  }
  const before = previous.transcript;
  const after = next.transcript;
  if (after.length === before.length) {
    for (let index = 0; index < before.length - 1; index += 1) {
      if (before[index] !== after[index]) return { type: "full" };
    }
    const previousLast = before[before.length - 1];
    const nextLast = after[after.length - 1];
    if (previousLast === nextLast) return { type: "unchanged" };
    if (previousLast !== undefined && nextLast !== undefined && previousLast.id === nextLast.id) {
      return {
        type: "tail",
        update: {
          kind: "transcript-tail-update",
          workspaceId: next.workspaceId,
          sessionId: next.sessionId,
          mode: "replace-last",
          item: nextLast,
        },
      };
    }
    return { type: "full" };
  }
  if (after.length === before.length + 1) {
    for (let index = 0; index < before.length; index += 1) {
      if (before[index] !== after[index]) return { type: "full" };
    }
    return {
      type: "tail",
      update: {
        kind: "transcript-tail-update",
        workspaceId: next.workspaceId,
        sessionId: next.sessionId,
        mode: "append",
        item: after[after.length - 1]!,
      },
    };
  }
  return { type: "full" };
}
