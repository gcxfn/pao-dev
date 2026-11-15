import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { registerResidentMemory, autoRecallBudgetChars, renderRecallSection } from "../../../PAO/packages/coding-agent/src/pao/memory/resident.ts";
import { AUTO_RECALL_FIRST_OVERHEAD, AUTO_RECALL_MESSAGE_OVERHEAD, bindBuiltinMemoryService, builtinHitToMemoryHit, builtinSearchHitToMemoryHit, renderedHitChars, sessionMemory } from "../../../PAO/packages/coding-agent/src/pao/memory/session.ts";
import { resolveMemoryScope } from "../../../PAO/packages/coding-agent/src/pao/memory/project-identity.ts";
import { createCapture } from "../../../PAO/packages/coding-agent/src/pao/memory/capture.ts";
import { openMemoryStore } from "../../../PAO/packages/coding-agent/src/pao/memory/store.ts";
import { openMemoryService } from "../../../PAO/packages/coding-agent/src/pao/memory/service.ts";

const here = dirname(fileURLToPath(import.meta.url));
const cleanups: Array<() => unknown> = [];
const results: Record<string, unknown> = {};
const scope = resolveMemoryScope(process.cwd());
function fixture() {
  const home = mkdtempSync(join(here, "o05-budget-case-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "pao配置"));
  writeFileSync(join(home, "pao配置", "记忆供应商.json"), JSON.stringify({ 供应商: "builtin", 自动召回: true }));
  const handlers = new Map<string, any[]>();
  const pi = { on: (name: string, fn: any) => { const a = handlers.get(name) ?? []; a.push(fn); handlers.set(name, a); return () => {}; }, registerTool: () => {}, registerCommand: () => {}, sendMessage: () => {} } as any;
  return { home, handlers, pi };
}
function context(messages: unknown[], contextWindow: number) {
  return { cwd: process.cwd(), model: { contextWindow }, sessionManager: { getSessionId: () => "budget-session", getBranch: () => [], getEntries: () => [], getSessionFile: () => undefined, buildSessionProjection: () => ({ messages, thinkingLevel: "off", model: null }) } } as any;
}
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
afterAll(() => writeFileSync(join(here, "o05-budget-rereview-results.json"), JSON.stringify(results, null, 2)));

describe("O05 修复后的完整请求预算", () => {
  it("C1 实际 context 钩子刷新记忆时沿用本轮收紧预算", async () => {
    const f = fixture();
    registerResidentMemory(f.pi, { resolvePaoHome: () => f.home, getManager: () => undefined });
    const state = sessionMemory(f.pi);
    const projection: unknown[] = [{ role: "user", content: "上下文".repeat(4667) }];
    const ctx = context(projection, 5000);
    const initialBudget = autoRecallBudgetChars(ctx);
    const hit = builtinHitToMemoryHit({ memoryId: "budget-refresh", revision: 1, kind: "decision", scope, content: { conclusion: "选择 SQLite", evidenceKind: "user_statement", confirmation: "confirmed" }, sourceIds: [], relevance: 1 } as any);
    const selected = state.selectForContext([hit], "builtin", [], "", "budget-session", initialBudget);
    expect(selected.hits).toHaveLength(1);
    state.record(selected.hits, "builtin");
    const old = { role: "custom", customType: "pao-auto-recall", content: renderRecallSection(selected.hits, "budget-session"), details: { vendor: "builtin", hits: selected.hits } };
    projection.push(old);
    state.refreshInjected(["budget-refresh"], () => ({ content: { conclusion: "选择 SQLite", conditions: "更新后的适用条件需要完整核对。".repeat(20), evidenceKind: "user_statement", confirmation: "confirmed" }, revision: 2, usageState: "active", sourceIds: [] }));
    const budget = autoRecallBudgetChars(ctx);
    let messages: any[] = [old];
    for (const handler of f.handlers.get("context") ?? []) {
      const out = await handler({ messages }, ctx);
      if (out?.messages) messages = out.messages;
    }
    const text = messages.map(m => m.content).join("\n");
    results.C1 = { initialBudget, currentBudget: budget, renderedChars: Array.from(text).length, text };
    expect(Array.from(text).length).toBeLessThanOrEqual(budget);
  });

  it("C2 before_agent_start 返回的首次召回完整消息符合预算", async () => {
    const f = fixture();
    const store = openMemoryStore(f.home, "readwrite");
    cleanups.push(() => store.close());
    const svc = openMemoryService({ paoHome: f.home, mode: "readwrite" });
    cleanups.push(() => svc.close());
    const cap = createCapture({ store, paoHome: f.home });
    const timestamp = "2026-11-14T08:00:00.000Z";
    const captured = cap.captureCommittedEntries("source-session", [{ id: "budget-source", type: "message", parentId: null, timestamp, message: { role: "user", content: "预算链路 SQLite", timestamp: 1 } }] as any);
    const created = await svc.createMemory({ kind: "decision", scope, conclusion: "预算链路 SQLite", evidenceKind: "user_statement", confirmation: "confirmed", sourceIds: [captured[0].sourceId!] });
    expect(created.ok).toBe(true);
    bindBuiltinMemoryService(f.pi, () => svc);
    registerResidentMemory(f.pi, { resolvePaoHome: () => f.home, getManager: () => undefined });
    const found = await svc.searchMemory({ scope, query: "预算链路 SQLite", mode: "current", limit: 8 });
    expect(found.ok && found.hits.length === 1).toBe(true);
    if (!found.ok) return;
    const hit = await builtinSearchHitToMemoryHit(svc, found.hits[0]);
    const degradeChars = found.degraded && found.degradeReason !== undefined ? Array.from(`[pao 自动召回] 语义召回降级:${found.degradeReason}`).length + 1 : 0;
    const cost = AUTO_RECALL_FIRST_OVERHEAD + renderedHitChars(hit, 0, "budget-session") + 1 + degradeChars;
    const ctx = context([], cost * 5);
    const budget = autoRecallBudgetChars(ctx);
    expect(budget).toBe(cost);
    let response: any;
    for (const handler of f.handlers.get("before_agent_start") ?? []) {
      const out = await handler({ prompt: "预算链路 SQLite", systemPrompt: "", systemPromptOptions: { sections: {} } }, ctx);
      if (out?.message) response = out.message;
    }
    expect(response?.details?.hits).toHaveLength(1);
    const text = response.content;
    results.C2 = { budget, renderedChars: Array.from(text).length, hitCost: renderedHitChars(hit, 0, "budget-session"), estimatedHeader: AUTO_RECALL_MESSAGE_OVERHEAD, actualHeaderAndHit: Array.from(renderRecallSection([hit], "budget-session")).length, text };
    expect(Array.from(text).length).toBeLessThanOrEqual(budget);
    // 原 331 码点边界装不下完整条目时，应整项省略。
    sessionMemory(f.pi).reset();
    const tightCtx = context([], 331 * 5);
    let tightResponse: any;
    for (const handler of f.handlers.get("before_agent_start") ?? []) {
      const out = await handler({ prompt: "预算链路 SQLite", systemPrompt: "", systemPromptOptions: { sections: {} } }, tightCtx);
      if (out?.message) tightResponse = out.message;
    }
    const tightText = tightResponse?.content ?? "";
    results.C2tight = { budget: autoRecallBudgetChars(tightCtx), renderedChars: Array.from(tightText).length, text: tightText };
    expect(Array.from(tightText).length).toBeLessThanOrEqual(autoRecallBudgetChars(tightCtx));
  });
});
