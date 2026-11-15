import { pathToFileURL } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const im = (p) => import(pathToFileURL(p).href);
const { openMemoryStore } = await im("D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/store.ts");
const { openMemoryService } = await im("D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/service.ts");
const { registerExtractionScheduler } = await im("D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/extraction-scheduler.ts");
const { resolveMemoryScope } = await im("D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/project-identity.ts");

const home = mkdtempSync(join(tmpdir(), "o10-ext2-"));
mkdirSync(join(home, "pao配置"), { recursive: true });
writeFileSync(join(home, "pao配置", "档位.json"), JSON.stringify({
  provider: "pao",
  档位: [{ 名: "fast", provider: "faux", model: "faux-1", thinkingLevel: "off" }],
}));
const project = mkdtempSync(join(tmpdir(), "o10-proj-"));
const store = openMemoryStore(home, "readwrite");
const service = openMemoryService({ paoHome: home, mode: "readwrite" });
const sessionId = "sess-probe2";

const segDir = join(home, "memory", "segments", sessionId);
mkdirSync(segDir, { recursive: true });
const segFile = join(segDir, "seg-1.jsonl");
const events = [
  { entryId: "e1", entryType: "user", eventType: "user", timestamp: "2026-01-01T00:00:00Z", capturedAt: "2026-01-01T00:00:00Z", text: "我的目标是完成 A 的自动验收" },
  { entryId: "e2", entryType: "assistant", eventType: "assistant", timestamp: "2026-01-01T00:00:01Z", capturedAt: "2026-01-01T00:00:01Z", text: "好的" },
];
writeFileSync(segFile, events.map(e => JSON.stringify(e)).join("\n") + "\n");
store.db.prepare(`INSERT INTO archive_segments (segment_id, session_id, original_path, compressed_path, status, created_at)
  VALUES ('seg-1', ?, ?, NULL, 'unsealed', '2026-01-01T00:00:00Z')`).run(sessionId, segFile);
store.db.prepare(`INSERT INTO sources (source_id, session_id, entry_id, event_type, segment_id, captured_at, project_id)
  VALUES ('src-q1', ?, 'e1', 'user', 'seg-1', '2026-01-01T00:00:00Z', 'proj-p')`).run(sessionId);
store.db.prepare(`INSERT INTO sources (source_id, session_id, entry_id, event_type, segment_id, captured_at, project_id)
  VALUES ('src-q2', ?, 'e2', 'assistant', 'seg-1', '2026-01-01T00:00:01Z', 'proj-p')`).run(sessionId);

const handlers = new Map();
const pi = { on(ev, h) { const l = handlers.get(ev) ?? []; l.push(h); handlers.set(ev, l); return () => {}; } };
registerExtractionScheduler(pi, {
  store, service, paoHome: home,
  resolveScope: (ctx) => resolveMemoryScope(ctx.cwd, { sessionId: ctx.sessionManager.getSessionId() }, home),
});
const reply = JSON.stringify([{ kind: "commitment", conclusion: "完成 A 的自动验收", evidenceKind: "user_statement", confirmation: "confirmed", sourceIds: ["src-q1"] }]);
const ctx = {
  cwd: project,
  sessionManager: { getSessionId: () => sessionId, getBranch: () => [{ type: "message" }] },
  modelRegistry: { find: () => ({}), streamSimple: () => ({ result: () => Promise.resolve({ provider:"faux", model:"m", responseModel:"m", stopReason:"stop", usage:{totalTokens:1,inputTokens:1,outputTokens:0}, content:[{type:"text",text:reply}] }) }) },
};
for (const h of handlers.get("agent_settled") ?? []) await h({ type: "agent_settled" }, ctx);
await new Promise(r => setTimeout(r, 1500));
const jobs = store.db.prepare("SELECT job_id, scope_key, status, cursor, last_error, consecutive_failures FROM extraction_jobs").all();
console.log(JSON.stringify(jobs, null, 2));
console.log("memories:", JSON.stringify(store.db.prepare("SELECT id, kind, current_revision FROM memories").all()));
store.close();
await service.close();
