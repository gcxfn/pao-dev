import { expect, test } from "@playwright/test";
import type { SelectedTranscriptRecord, TranscriptMessage } from "../../contracts/desktop-state";
import { appendAssistantDelta } from "../../electron/conversation/app-store-timeline";
import { transcriptTailDecision } from "../../electron/conversation/transcript-tail-update";

const sessionRef = { workspaceId: "ws", sessionId: "sess" };

function message(id: string, text: string): Extract<TranscriptMessage, { kind: "message" }> {
  return { kind: "message", id, role: "assistant", text, createdAt: "2026-10-10T00:00:00.000Z" };
}

function record(transcript: readonly TranscriptMessage[]): SelectedTranscriptRecord {
  return { workspaceId: sessionRef.workspaceId, sessionId: sessionRef.sessionId, transcript };
}

test("streaming text growth on the last message becomes a replace-last tail update", () => {
  const items = [message("m1", "old turn"), message("m2", "grow")];
  const previous = record(items);
  const grown = record([items[0]!, { ...items[1]!, text: "growing text" }]);
  expect(transcriptTailDecision(previous, grown)).toEqual({
    type: "tail",
    update: {
      kind: "transcript-tail-update",
      workspaceId: "ws",
      sessionId: "sess",
      mode: "replace-last",
      item: grown.transcript[1],
    },
  });
});

test("a newly appended streaming message becomes an append tail update", () => {
  const previous = record([message("m1", "old turn")]);
  const next = record([...previous.transcript, message("m2", "new reply")]);
  expect(transcriptTailDecision(previous, next)).toEqual({
    type: "tail",
    update: {
      kind: "transcript-tail-update",
      workspaceId: "ws",
      sessionId: "sess",
      mode: "append",
      item: next.transcript[1],
    },
  });
});

test("identical content under a new array identity is unchanged, not a resend", () => {
  const previous = record([message("m1", "same"), message("m2", "same")]);
  const sameContent = record([...previous.transcript]);
  expect(transcriptTailDecision(previous, sameContent)).toEqual({ type: "unchanged" });
});

test("structural changes fall back to full publishes", () => {
  const previous = record([message("m1", "a"), message("m2", "b")]);
  // Prefix item changed.
  expect(
    transcriptTailDecision(previous, record([{ ...message("m1", "A") }, message("m2", "b")])),
  ).toEqual({
    type: "full",
  });
  // Last item replaced by a different id.
  expect(
    transcriptTailDecision(previous, record([message("m1", "a"), message("m3", "c")])),
  ).toEqual({
    type: "full",
  });
  // More than one item appended.
  expect(
    transcriptTailDecision(
      previous,
      record([...previous.transcript, message("m3", "c"), message("m4", "d")]),
    ),
  ).toEqual({ type: "full" });
  // Session or schema info change.
  expect(transcriptTailDecision(previous, { ...previous, sessionId: "other" })).toEqual({
    type: "full",
  });
  expect(
    transcriptTailDecision(previous, {
      ...record([...previous.transcript, message("m3", "c")]),
      schemaInfo: { fileSchemaVersion: 2, runtimeSchemaVersion: 3 },
    }),
  ).toEqual({ type: "full" });
});

test("quantified: streaming updates are O(reply) regardless of transcript length", () => {
  // 修复前基线：每次 flush 全量记录走 IPC，总流量 O(flush 数 × 全部历史)——历史越长越是平方级。
  // 修复后：每次 flush 只发末条，总流量与历史长度无关（下面对比 50 条 vs 500 条历史）。
  const flushes = 120;
  const tokensPerFlush = 4;

  function stream(historyLen: number): {
    fullBytes: number;
    deltaBytes: number;
    tailFlushes: number;
  } {
    const history: TranscriptMessage[] = [];
    for (let index = 0; index < historyLen; index += 1) {
      history.push(message(`history-${index}`, `历史轮次 ${index} 的正文`.repeat(6)));
    }
    const transcriptCache = new Map<string, readonly TranscriptMessage[]>();
    const active = new Map<string, string>();
    transcriptCache.set("ws:sess", history);
    appendAssistantDelta(transcriptCache, active, sessionRef, "seed");
    let previous: SelectedTranscriptRecord = record(transcriptCache.get("ws:sess")!);

    let deltaBytes = 0;
    let fullBytes = 0;
    let tailFlushes = 0;
    for (let flush = 0; flush < flushes; flush += 1) {
      for (let token = 0; token < tokensPerFlush; token += 1) {
        appendAssistantDelta(transcriptCache, active, sessionRef, "流式 token 正文内容 ");
      }
      const next = record(transcriptCache.get("ws:sess")!);
      const decision = transcriptTailDecision(previous, next);
      if (decision.type === "tail") {
        tailFlushes += 1;
        deltaBytes += JSON.stringify(decision.update).length;
      }
      fullBytes += JSON.stringify(next).length;
      previous = next;
    }
    return { fullBytes, deltaBytes, tailFlushes };
  }

  const small = stream(50);
  const large = stream(500);
  console.log(
    `[transcript-tail-update] 量化：小历史全量=${small.fullBytes}B 增量=${small.deltaBytes}B；大历史全量=${large.fullBytes}B 增量=${large.deltaBytes}B`,
  );

  // 每个 flush 都能走增量（真实 appendAssistantDelta 保持前缀条目身份不变）。
  expect(small.tailFlushes).toBe(flushes);
  expect(large.tailFlushes).toBe(flushes);
  // 增量流量与历史长度无关（同一流式序列，逐字节相同）；全量流量随历史线性膨胀。
  expect(large.deltaBytes).toBe(small.deltaBytes);
  expect(large.fullBytes / small.fullBytes).toBeGreaterThan(7);
  expect(large.fullBytes / large.deltaBytes).toBeGreaterThan(10);
});

test("appendAssistantDelta preserves untouched item identities for prefix comparison", () => {
  const transcriptCache = new Map<string, readonly TranscriptMessage[]>();
  const active = new Map<string, string>();
  const history = [message("m1", "a"), message("m2", "b")];
  transcriptCache.set("ws:sess", history);
  appendAssistantDelta(transcriptCache, active, sessionRef, "hello ");
  const before = transcriptCache.get("ws:sess")!;
  appendAssistantDelta(transcriptCache, active, sessionRef, "world");
  const after = transcriptCache.get("ws:sess")!;
  expect(after[0]).toBe(before[0]);
  const decision = transcriptTailDecision(record(before), record(after));
  expect(decision.type).toBe("tail");
  expect(decision.type === "tail" && decision.update.mode).toBe("replace-last");
});
