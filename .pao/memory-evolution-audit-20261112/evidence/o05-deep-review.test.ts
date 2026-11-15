import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createCapture } from "../../../PAO/packages/coding-agent/src/pao/memory/capture.ts";
import { getSource, registerSource } from "../../../PAO/packages/coding-agent/src/pao/memory/sources.ts";
import { sourceCandidates, upsertSourceFts } from "../../../PAO/packages/coding-agent/src/pao/memory/source-fts.ts";
import { getSegment, sealSegment } from "../../../PAO/packages/coding-agent/src/pao/memory/archive.ts";
import { openMemoryStore } from "../../../PAO/packages/coding-agent/src/pao/memory/store.ts";
import { openMemoryService } from "../../../PAO/packages/coding-agent/src/pao/memory/service.ts";
import { resolveMemoryScope } from "../../../PAO/packages/coding-agent/src/pao/memory/project-identity.ts";
import { registerBuiltinMemory } from "../../../PAO/packages/coding-agent/src/pao/memory/tools.ts";
import { SessionMemory, AUTO_RECALL_RESULTS_BOUNDARY, builtinHitToMemoryHit, renderMemoryHit } from "../../../PAO/packages/coding-agent/src/pao/memory/session.ts";
import * as evidence from "../../../PAO/packages/coding-agent/src/pao/shared/evidence.ts";
import { SessionManager } from "../../../PAO/packages/coding-agent/src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../../../PAO/packages/coding-agent/test/utilities.ts";

const here = dirname(fileURLToPath(import.meta.url));
const cleanups: Array<() => unknown> = [];
const observations: Record<string, unknown> = {};
const AT = "2026-11-14T08:00:00.000Z";
const SCOPE = resolveMemoryScope(process.cwd());
let seq = 0;
function fixture() {
  const home = mkdtempSync(join(here, "o05-case-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const store = openMemoryStore(home, "readwrite");
  cleanups.push(() => store.close());
  const capture = createCapture({ store, paoHome: home, now: () => AT });
  return { home, store, capture };
}
function msg(text: string) {
  return { id: `entry-${++seq}`, parentId: null, timestamp: AT, type: "message", message: { role: "user", content: text, timestamp: 1 } } as any;
}
function tools(home: string) {
  const registered = new Map<string, any>();
  const pi = { on: () => () => {}, registerTool: (t: any) => registered.set(t.name, t), registerCommand: () => {}, sendMessage: () => {} } as any;
  const reg = registerBuiltinMemory(pi, { paoHome: home });
  cleanups.push(() => reg.close());
  return registered;
}
function ctx() {
  return { cwd: process.cwd(), sessionManager: { getSessionId: () => "review-session", getBranch: () => [], getEntries: () => [], getSessionFile: () => undefined, getEntry: () => undefined, buildSessionProjection: () => ({ messages: [], thinkingLevel: "off", model: null }) } } as any;
}
function source(f: ReturnType<typeof fixture>, id: string, options: { taskId?: string; projectId?: string } = {}) {
  const row = { sessionId: "scope-session", entryId: id, eventType: "user", capturedAt: AT, ...options };
  const sourceId = registerSource(f.store.db, row);
  upsertSourceFts(f.store.db, sourceId, { ...row, content: "数据库 SQLite 讨论" });
  return sourceId;
}
function exclude(f: ReturnType<typeof fixture>, sourceId: string, n: number) {
  const s = getSource(f.store.db, sourceId)!;
  f.store.db.prepare("INSERT INTO source_exclusions (exclusion_id,memory_id,source_id,session_id,entry_id,reason,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(`exclude-${n}`, "deleted-memory", sourceId, s.sessionId, s.entryId, "memory 删除:deleted-memory", AT);
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
afterAll(() => writeFileSync(join(here, "o05-deep-review-results.json"), JSON.stringify(observations, null, 2)));

describe("O05 独立完成审核", () => {
  it("B1 history 仅有原文命中时，模型工具提供 sourceId 而非无命中", async () => {
    const f = fixture();
    const sid = f.capture.captureCommittedEntries("discussion", [msg("讨论 SQLite，但尚未形成决定")], AT)[0].sourceId!;
    const registered = tools(f.home);
    const svc = openMemoryService({ paoHome: f.home, mode: "readwrite" });
    cleanups.push(() => svc.close());
    const raw = await svc.searchMemory({ scope: SCOPE, query: "SQLite", mode: "history" });
    expect(raw.ok && raw.sourceHits?.some(x => x.sourceId === sid)).toBe(true);
    const response = await registered.get("pao_memory_recall").execute("recall-call", { query: "SQLite", mode: "history" }, undefined, undefined, ctx());
    observations.B1 = { service: raw, tool: response };
    expect(response.content.map((c: any) => c.text).join("\n")).toContain(sid);
  });

  it("B2 history 原文遵循 taskId 为 NULL 或当前任务的范围", () => {
    const f = fixture();
    const sid = source(f, "task-a-source", { projectId: SCOPE.projectId, taskId: "task-a" });
    const own = sourceCandidates(f.store.db, { ...SCOPE, taskId: "task-a" }, "SQLite", 1);
    const other = sourceCandidates(f.store.db, { ...SCOPE, taskId: "task-b" }, "SQLite", 1);
    observations.B2 = { sid, own, other };
    expect(own.some(x => x.sourceId === sid)).toBe(true);
    expect(other.some(x => x.sourceId === sid)).toBe(false);
  });

  it("B3 已排除来源不占满原文候选截取位置", () => {
    const f = fixture();
    for (let i = 0; i < 11; i++) {
      const id = source(f, `a-${String(i).padStart(2, "0")}`, { projectId: SCOPE.projectId });
      exclude(f, id, i);
    }
    const sid = source(f, "z-available", { projectId: SCOPE.projectId });
    const narrow = sourceCandidates(f.store.db, SCOPE, "数据", 1);
    const wide = sourceCandidates(f.store.db, SCOPE, "数据", 20);
    observations.B3 = { sid, narrow, wide };
    expect(wide.some(x => x.sourceId === sid)).toBe(true);
    expect(narrow.some(x => x.sourceId === sid)).toBe(true);
  });

  it("B4 封存发布期间的新采集另开段且最终可回读", async () => {
    const f = fixture();
    const first = f.capture.captureCommittedEntries("next-round", [msg("普通讨论 SQLite。\n".repeat(20_000))], AT)[0].sourceId!;
    const firstSegment = getSource(f.store.db, first)!.segmentId!;
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    // 固定压缩已读完、发布尚未完成的正常异步 I/O 边界。
    vi.spyOn(evidence, "archiveWorkerEvidence").mockImplementation(async path => {
      const snapshot = readFileSync(path);
      await gate;
      writeFileSync(`${path}.gz`, gzipSync(snapshot));
      unlinkSync(path);
      return { path: `${path}.gz` };
    });
    const sealing = sealSegment(f.store.db, f.home, firstSegment);
    const second = f.capture.captureCommittedEntries("next-round", [msg("下一轮 SQLite 原文必须保存")], AT)[0].sourceId!;
    const secondSegment = getSource(f.store.db, second)!.segmentId!;
    const pending = getSegment(f.store.db, firstSegment);
    release();
    await sealing;
    const svc = openMemoryService({ paoHome: f.home, mode: "readwrite" });
    cleanups.push(() => svc.close());
    const read = await svc.readMemorySource({ sourceId: second, limit: 1 });
    observations.B4 = { firstSegment, secondSegment, pending, read };
    expect.soft(secondSegment).not.toBe(firstSegment);
    expect(read.ok).toBe(true);
  });

  it("B5 已注入记忆来源增加后，刷新文本仍不超过完整渲染预算", () => {
    const state = new SessionMemory();
    const hit = builtinHitToMemoryHit({ memoryId: "budget-memory", revision: 1, kind: "decision", scope: SCOPE, content: { conclusion: "采用 SQLite", evidenceKind: "user_statement", confirmation: "confirmed" }, sourceIds: [], score: 1 } as any);
    const selected = state.selectForContext([hit], "builtin", []);
    expect(selected.hits).toHaveLength(1);
    state.record(selected.hits, "builtin");
    const message = { role: "custom", customType: "pao-auto-recall", content: `旧展示\n${renderMemoryHit(selected.hits[0], 0)}`, details: { vendor: "builtin", hits: selected.hits } };
    const summaries = Array.from({ length: 20 }, (_, i) => ({ sourceId: `src-real-session-event-${i}`, sessionId: "original-discussion-session", entryId: `e-${i}`, eventType: "user", capturedAt: AT, readable: true }));
    state.refreshInjected(["budget-memory"], () => ({ content: { conclusion: "采用 SQLite", evidenceKind: "user_statement", confirmation: "confirmed" }, revision: 2, usageState: "active", sourceIds: summaries.map(x => x.sourceId), sourceSummaries: summaries }));
    const filtered = state.filterVisibleMessages([message]);
    const text = String((filtered[0] as any)?.content ?? "");
    observations.B5 = { renderedChars: Array.from(text).length, text };
    expect(Array.from(text).length).toBeLessThanOrEqual(2000);
  });

  it("B6 可截断条目的截断提示本身计入完整渲染预算", () => {
    const state = new SessionMemory();
    const selection = state.selectForContext(Array.from({ length: 3 }, (_, i) => ({ 内容: String(i).repeat(1000), 记忆ID: `vendor-id-${i}`, 来源: "provider" })), "vendor", []);
    const text = selection.hits.length === 0 ? "" : [`[pao 自动召回] 当前可见 ${selection.hits.length} 条。${AUTO_RECALL_RESULTS_BOUNDARY}`, ...selection.hits.map((h, i) => renderMemoryHit(h, i))].join("\n");
    observations.B6 = { budget: 2000, renderedChars: Array.from(text).length, text };
    expect(Array.from(text).length).toBeLessThanOrEqual(2000);
  });

  it("B7 无项目绑定来源不默认成为任意项目的历史原文", () => {
    const f = fixture();
    const sid = f.capture.captureCommittedEntries("unbound-session", [msg("SQLite 未绑定项目的讨论")], AT)[0].sourceId!;
    const other = sourceCandidates(f.store.db, { projectId: "entirely-another-project" }, "SQLite", 1);
    observations.B7 = { source: getSource(f.store.db, sid), other };
    expect(other.some(x => x.sourceId === sid)).toBe(false);
  });

  it("B8 删除共享来源的一条记忆后，保留的原文仍可历史发现与展开", async () => {
    const f = fixture();
    const manager = SessionManager.create(f.home, join(f.home, "sessions"), { id: "shared-session" });
    const entryId = manager.appendMessage(userMsg("SQLite 仍有另一条记忆引用的原文"));
    manager.appendMessage(assistantMsg("保留共享来源"));
    f.capture.registerSession(manager.getSessionId(), manager.getSessionFile());
    const sid = f.capture.captureCommittedEntries(manager.getSessionId(), [manager.getEntry(entryId)!], AT)[0].sourceId!;
    const svc = openMemoryService({ paoHome: f.home, mode: "readwrite" });
    cleanups.push(() => svc.close());
    const first = await svc.createMemory({ kind: "decision", scope: SCOPE, conclusion: "第一个共享来源决定", evidenceKind: "user_statement", confirmation: "confirmed", sourceIds: [sid] });
    const second = await svc.createMemory({ kind: "decision", scope: SCOPE, conclusion: "第二个共享来源决定", evidenceKind: "user_statement", confirmation: "confirmed", sourceIds: [sid] });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const deletion = await svc.deleteMemory({ memoryIds: [first.id], revisions: { [first.id]: 1 }, source: { sessionId: manager.getSessionId() }, sharedSourcePolicy: "retain" });
    expect(deletion).toMatchObject({ ok: true, status: "complete" });
    expect(getSource(f.store.db, sid)).toBeDefined();
    expect((f.store.db.prepare("SELECT COUNT(*) AS n FROM source_exclusions WHERE source_id=?").get(sid) as any).n).toBeGreaterThan(0);
    const registered = tools(f.home);
    const result = await registered.get("pao_memory_read").execute("read-call", { source_id: sid }, undefined, undefined, ctx());
    const history = await svc.searchMemory({ scope: SCOPE, query: "SQLite", mode: "history" });
    observations.B8 = { deletion, result, history };
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain("SQLite");
    expect(history.ok && history.sourceHits?.some(x => x.sourceId === sid)).toBe(true);
  });
});
