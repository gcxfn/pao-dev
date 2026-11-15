// O14 独立复核探针（跑完即删）：复刻 F05 的 commit 层——直接调 commitExtractionCandidates，
// 看候选 sourceIds=[s1] 命中 stopped 记忆时返回什么 outcome，定位为何走 done 而非 stopped。
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SRC = "file:///D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src";
const { openMemoryStore } = await import(`${SRC}/pao/memory/store.ts`);
const { openMemoryService } = await import(`${SRC}/pao/memory/service.ts`);
const { createCapture } = await import(`${SRC}/pao/memory/capture.ts`);
const { commitExtractionCandidates } = await import(`${SRC}/pao/memory/extract-commit.ts`);
const { revisionsForSource } = await import(`${SRC}/pao/memory/sources.ts`);
const { SessionManager } = await import(`${SRC}/core/session-manager.ts`);

const AT = "2026-11-09T10:00:00.000Z";
const AT2 = "2026-11-09T10:01:00.000Z";
const home = mkdtempSync(join(tmpdir(), "o14-commit-"));
const store = openMemoryStore(home, "readwrite");
const service = openMemoryService({ paoHome: home, mode: "readwrite" });
const sessionId = "sess-f05";
const scope = { projectId: "proj-f05", sessionId };
const manager = SessionManager.create(home, join(home, "agent", "sessions"), { id: sessionId });
const capture = createCapture({ store, paoHome: home, now: () => AT });
capture.registerSession(sessionId, manager.getSessionFile());

const e1 = manager.appendMessage({ role: "user", content: "构建命令固定为 pnpm build。", timestamp: Date.parse(AT) });
const s1 = capture.captureCommittedEntry(sessionId, manager.getEntry(e1), undefined, AT).sourceId;
const created = await service.createMemory({
  kind: "decision", scope: { ...scope }, conclusion: "构建命令固定为 pnpm build。",
  evidenceKind: "user_statement", confirmation: "confirmed", sourceIds: [s1],
  createdBy: "user", createdAt: AT,
});
const stopped = await service.setMemoryUsage({
  id: created.id, expectedRevision: 1, target: "stopped",
  source: { sessionId }, createdAt: AT2,
});
console.log("stopped rev:", stopped.revision);
console.log("links for s1:", JSON.stringify(revisionsForSource(store.db, s1)));
console.log("mem row:", JSON.stringify(store.db.prepare("SELECT id,usage_state,current_revision FROM memories").all()));

const committed = await commitExtractionCandidates(store, service, {
  jobId: "job-x", scope,
  candidates: [{
    kind: "decision", conclusion: "构建命令固定为 pnpm build。",
    evidenceKind: "user_statement", confirmation: "confirmed", sourceIds: [s1],
    quotedSpans: [{ sourceId: s1, text: "pnpm build" }],
    spanLocations: [{ sourceId: s1, match: "exact", offset: 0 }],
  }],
  relatedMemories: [],
  sourceRefs: [{ sourceId: s1, sessionId, entryId: e1, eventType: "user" }],
  now: AT2,
});
console.log("outcomes:", JSON.stringify(committed.outcomes, null, 1));
await service.close();
store.close();
