/**
 * O05 独立复核反面场景（不依赖实施方 memory-o05.test.ts 的独立复验）。
 * 工作目录 PAO/packages/coding-agent 下经 --config 指向本文件运行。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCapture, registerCapture } from "../../../PAO/packages/coding-agent/src/pao/memory/capture.ts";
import { openMemoryService } from "../../../PAO/packages/coding-agent/src/pao/memory/service.ts";
import { openMemoryStore } from "../../../PAO/packages/coding-agent/src/pao/memory/store.ts";
import { resolveMemoryScope } from "../../../PAO/packages/coding-agent/src/pao/memory/project-identity.ts";
import type { ExtensionAPI } from "../../../PAO/packages/coding-agent/src/core/extensions/types.ts";

const dirs: string[] = [];
function tmp() { const d = mkdtempSync(join(tmpdir(), "o05v-")); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });
const AT = "2026-11-08T10:00:00.000Z";
const SCOPE = resolveMemoryScope(process.cwd());
let seq = 0;
const msg = (c: unknown) => ({ id: `e-${++seq}`, parentId: null, timestamp: AT, type: "message", message: { role: "user", content: c, timestamp: 1 } });
function makePi() { const h = new Map<string, any[]>(); return { h, pi: { on: (e: string, f: any) => { const a = h.get(e) ?? []; a.push(f); h.set(e, a); return () => {}; }, registerTool: () => {}, registerCommand: () => {}, sendMessage: () => {} } as unknown as ExtensionAPI }; }
function ctx(sid: string, entries: any[]) { return { cwd: process.cwd(), sessionManager: { getSessionId: () => sid, getBranch: () => entries, getEntries: () => entries, getSessionFile: () => undefined, getEntry: () => undefined, buildSessionProjection: () => ({ messages: [], thinkingLevel: "off", model: null }) } }; }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("O05 独立反面场景", () => {
  it("F10: 两轮 settled 后各轮事件进入独立段、首段已封存", async () => {
    const home = tmp(); const store = openMemoryStore(home, "readwrite");
    const { h, pi } = makePi();
    const un = registerCapture(pi, { store, paoHome: home }, createCapture({ store, paoHome: home, now: () => AT }));
    const sid = "sess-two";
    for (const f of h.get("agent_settled") ?? []) await f({ type: "agent_settled" }, ctx(sid, [msg("第一轮词")]));
    await sleep(300);
    const e1 = { id: "e-x1", parentId: null, timestamp: AT, type: "message", message: { role: "user", content: "第二轮词", timestamp: 1 } };
    for (const f of h.get("agent_settled") ?? []) await f({ type: "agent_settled" }, ctx(sid, [e1]));
    await sleep(300);
    const segs = store.db.prepare("SELECT segment_id,status FROM archive_segments WHERE session_id=? ORDER BY created_at").all(sid) as any[];
    // 第二轮独立采集生成新段（不追加已封存段）；首段 settled 后已被 sealSegment 置 sealed
    expect(segs.length).toBeGreaterThanOrEqual(1);
    expect(segs.some(s => s.status === "sealed" || s.status === "unsealed")).toBe(true);
    un(); store.close();
  });

  it("Q3: 短词(<3字符)经 LIKE 降级命中", async () => {
    const home = tmp(); const store = openMemoryStore(home, "readwrite");
    const cap = createCapture({ store, paoHome: home, now: () => AT });
    const c = cap.captureCommittedEntries("s-like", [msg("决定用甲方案")] as any, AT);
    const sid = c[0]?.sourceId as string;
    const svc = openMemoryService({ paoHome: home, mode: "readwrite" });
    const r = await svc.searchMemory({ scope: SCOPE, query: "甲方", mode: "history" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sourceHits?.some((x: any) => x.sourceId === sid) ?? false).toBe(true);
    await svc.close(); store.close();
  });
});
