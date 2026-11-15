import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { registerResidentMemory, autoRecallBudgetChars, renderRecallSection } from "../../../PAO/packages/coding-agent/src/pao/memory/resident.ts";
import { builtinHitToMemoryHit, sessionMemory } from "../../../PAO/packages/coding-agent/src/pao/memory/session.ts";
import { resolveMemoryScope } from "../../../PAO/packages/coding-agent/src/pao/memory/project-identity.ts";

const here = dirname(fileURLToPath(import.meta.url));
const homes: string[] = [];
const results: Record<string, unknown> = {};
function fixture() {
  const home = mkdtempSync(join(here, "o05-context-case-"));
  homes.push(home);
  const handlers = new Map<string, any[]>();
  const pi = { on: (name: string, fn: any) => { const a = handlers.get(name) ?? []; a.push(fn); handlers.set(name, a); return () => {}; }, registerTool: () => {}, registerCommand: () => {}, sendMessage: () => {} } as any;
  registerResidentMemory(pi, { resolvePaoHome: () => home, getManager: () => undefined });
  const projection: any[] = [];
  const ctx = { cwd: process.cwd(), model: { contextWindow: 5000 }, sessionManager: { getSessionId: () => "context-session", getBranch: () => [], getEntries: () => [], getSessionFile: () => undefined, buildSessionProjection: () => ({ messages: projection, thinkingLevel: "off", model: null }) } } as any;
  const state = sessionMemory(pi);
  function remember(id: string, conditions?: string) {
    const hit = builtinHitToMemoryHit({ memoryId: id, revision: 1, kind: "decision", scope: resolveMemoryScope(process.cwd()), content: { conclusion: `采用 ${id}`, ...(conditions === undefined ? {} : { conditions }), evidenceKind: "user_statement", confirmation: "confirmed" }, sourceIds: [], relevance: 1 } as any);
    const selection = state.selectForContext([hit], "builtin", projection, "", "context-session", autoRecallBudgetChars(ctx));
    expect(selection.hits).toHaveLength(1);
    state.rememberContextHits(selection.availableHits, "builtin");
    const hits = state.record(selection.hits, "builtin");
    projection.push({ role: "custom", customType: "pao-auto-recall", content: renderRecallSection(hits, "context-session"), details: { vendor: "builtin", hits } });
  }
  async function visible() {
    let messages = [...projection];
    for (const fn of handlers.get("context") ?? []) { const out = await fn({ messages }, ctx); if (out?.messages) messages = out.messages; }
    return messages.filter(m => m.customType === "pao-auto-recall");
  }
  return { projection, ctx, state, remember, visible };
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
afterAll(() => writeFileSync(join(here, "o05-context-budget-results.json"), JSON.stringify(results, null, 2)));

describe("O05 最终上下文累计预算", () => {
  it("C3 上下文增长但记忆不变时，已有自动召回仍按本轮预算收紧", async () => {
    const f = fixture();
    f.remember("SQLite", "仅限单机部署，必须完整保留适用条件。".repeat(18));
    const before = await f.visible();
    expect(before).toHaveLength(1);
    f.projection.unshift({ role: "user", content: "上下文".repeat(4667) });
    const budget = autoRecallBudgetChars(f.ctx);
    const messages = await f.visible();
    const chars = messages.reduce((n, m) => n + Array.from(m.content).length, 0);
    results.C3 = { budget, renderedChars: chars, messages };
    expect(chars).toBeLessThanOrEqual(budget);
  });

  it("C4 多轮召回均刷新时，共享最终上下文预算", async () => {
    const f = fixture();
    f.remember("SQLite");
    f.remember("PostgreSQL");
    expect(f.projection.filter(m => m.customType === "pao-auto-recall")).toHaveLength(2);
    f.projection.unshift({ role: "user", content: "上下文".repeat(4667) });
    f.state.refreshInjected(["SQLite", "PostgreSQL"], id => ({ content: { conclusion: `采用 ${id}`, conditions: "更新后的部署条件需要完整保留。".repeat(20), evidenceKind: "user_statement", confirmation: "confirmed" }, revision: 2, usageState: "active", sourceIds: [] }));
    const budget = autoRecallBudgetChars(f.ctx);
    const messages = await f.visible();
    const chars = messages.reduce((n, m) => n + Array.from(m.content).length, 0);
    results.C4 = { budget, renderedChars: chars, eachChars: messages.map(m => Array.from(m.content).length), messages };
    expect(chars).toBeLessThanOrEqual(budget);
  });

  it("C5 复用首次注入的长消息时，按实际原文计算预算", async () => {
    const f = fixture();
    f.remember("SQLite");
    const original = f.projection.find(m => m.customType === "pao-auto-recall");
    const originalChars = Array.from(original.content).length;
    const filler = { role: "user", content: "" };
    f.projection.unshift(filler);
    const targetBudget = originalChars - 10;
    const available = autoRecallBudgetChars(f.ctx);
    filler.content = "占".repeat(Math.max(0, (available - targetBudget) * 20));
    const budget = autoRecallBudgetChars(f.ctx);
    expect(budget).toBeLessThan(originalChars);
    const messages = await f.visible();
    const chars = messages.reduce((n, m) => n + Array.from(m.content).length, 0);
    results.C5 = { budget, originalChars, renderedChars: chars, returnedOriginal: messages[0] === original, messages };
    expect(chars).toBeLessThanOrEqual(budget);
  });

  it("C6 同一块只容纳前一条时，不复用仍包含全部条目的原消息", async () => {
    const f = fixture();
    f.remember("SQLite");
    f.remember("PostgreSQL");
    const hits = f.projection.flatMap(m => m.details?.hits ?? []);
    expect(hits).toHaveLength(2);
    const original = { role: "custom", customType: "pao-auto-recall", content: renderRecallSection(hits, "context-session"), details: { vendor: "builtin", hits } };
    f.projection.splice(0, f.projection.length, original);
    const filler = { role: "user", content: "" };
    f.projection.unshift(filler);
    const targetBudget = Array.from(renderRecallSection([hits[0]], "context-session")).length + 5;
    filler.content = "占".repeat(Math.max(0, (autoRecallBudgetChars(f.ctx) - targetBudget) * 20));
    const budget = autoRecallBudgetChars(f.ctx);
    expect(budget).toBeLessThan(Array.from(original.content).length);
    const messages = await f.visible();
    const chars = messages.reduce((n, m) => n + Array.from(m.content).length, 0);
    results.C6 = { budget, renderedChars: chars, returnedOriginal: messages[0] === original, visibleHitCount: messages.reduce((n, m) => n + m.details.hits.length, 0), messages };
    expect(chars).toBeLessThanOrEqual(budget);
  });

  it("C7 整块省略不消耗预算，后续能放入的召回继续保留", async () => {
    const f = fixture();
    f.remember("SQLite");
    f.remember("PostgreSQL");
    f.projection.unshift({ role: "user", content: "上下文".repeat(4667) });
    const summaries = Array.from({ length: 20 }, (_, i) => ({ sourceId: `source-${i}`, sessionId: "source-session", entryId: `event-${i}`, eventType: "user", capturedAt: "2026-11-14T08:00:00.000Z", readable: true }));
    f.state.refreshInjected(["SQLite"], () => ({ content: { conclusion: "采用 SQLite", evidenceKind: "user_statement", confirmation: "confirmed" }, revision: 2, usageState: "active", sourceIds: summaries.map(s => s.sourceId), sourceSummaries: summaries }));
    const budget = autoRecallBudgetChars(f.ctx);
    const originalSecond = f.projection.find(m => m.details?.hits?.[0]?.记忆ID === "PostgreSQL");
    expect(Array.from(originalSecond.content).length).toBeLessThanOrEqual(budget);
    const messages = await f.visible();
    const text = messages.map(m => m.content).join("\n");
    results.C7 = { budget, renderedChars: Array.from(text).length, secondOriginalChars: Array.from(originalSecond.content).length, messages };
    expect(text).toContain("PostgreSQL");
  });
});
