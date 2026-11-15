// O14 独立复核探针（跑完即删）：复刻 F05「同来源 stopped 拦截→job failed」最小场景，
// dump drain 后 job 真实状态，判断是 O14 回归还是调度时序既有问题。
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SRC = "file:///D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src";
const { openMemoryStore } = await import(`${SRC}/pao/memory/store.ts`);
const { openMemoryService } = await import(`${SRC}/pao/memory/service.ts`);
const { createCapture } = await import(`${SRC}/pao/memory/capture.ts`);
const { registerExtractionScheduler } = await import(`${SRC}/pao/memory/extraction-scheduler.ts`);
const { createJob } = await import(`${SRC}/pao/memory/extraction-jobs.ts`);
const { SessionManager } = await import(`${SRC}/core/session-manager.ts`);

const AT = "2026-11-09T10:00:00.000Z";
const AT2 = "2026-11-09T10:01:00.000Z";

const home = mkdtempSync(join(tmpdir(), "o14-f05-"));
const store = openMemoryStore(home, "readwrite");
const service = openMemoryService({ paoHome: home, mode: "readwrite" });
const sessionId = "sess-f05";
const scope = { projectId: "proj-f05", sessionId };
const manager = SessionManager.create(home, join(home, "agent", "sessions"), { id: sessionId });
const capture = createCapture({ store, paoHome: home, now: () => AT });
capture.registerSession(sessionId, manager.getSessionFile());

const e1 = manager.appendMessage({ role: "user", content: "构建命令固定为 pnpm build。", timestamp: Date.parse(AT) });
const s1 = capture.captureCommittedEntry(sessionId, manager.getEntry(e1), undefined, AT).sourceId;
console.log("sourceId:", s1);

const created = await service.createMemory({
  kind: "decision", scope: { ...scope }, conclusion: "构建命令固定为 pnpm build。",
  evidenceKind: "user_statement", confirmation: "confirmed", sourceIds: [s1],
  createdBy: "user", createdAt: AT,
});
console.log("created:", created.ok, created.id);
const stopped = await service.setMemoryUsage({
  id: created.id, expectedRevision: 1, target: "stopped",
  source: { sessionId }, createdAt: AT2,
});
console.log("stopped:", stopped.ok);

createJob(store, { sourceScope: JSON.stringify({ sessionId, projectId: scope.projectId }), scopeKey: `session:${sessionId}`, createdAt: AT });

let requestCalls = 0;
// 注入假 requestExtraction？不行——走真模块。先看 drain 是否到 requestExtraction。
const handlers = new Map();
const pi = { on(e, h) { handlers.set(e, h); return () => handlers.delete(e); } };
const unmount = registerExtractionScheduler(pi, {
  store, service, paoHome: home,
  ledger: { appendUsage: () => {}, appendCustomEntry: () => {} },
  resolveScope: () => scope,
  now: () => AT,
});
const ctx = { sessionManager: manager, cwd: home, modelRegistry: {} };

await handlers.get("turn_end")?.({}, ctx);
await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
await new Promise((r) => setTimeout(r, 1500));

const rows = store.db.prepare("SELECT scope_key,status,cursor,last_error,consecutive_failures FROM extraction_jobs").all();
console.log("jobs:", JSON.stringify(rows, null, 1));
unmount();
await service.close();
store.close();
