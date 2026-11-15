/** O03 调度复核：真实会话、来源、队列和提交；模型请求与嵌入为离线替身。 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "../../../PAO/packages/coding-agent/src/core/session-manager.ts";
import { createCapture } from "../../../PAO/packages/coding-agent/src/pao/memory/capture.ts";
import { createJob } from "../../../PAO/packages/coding-agent/src/pao/memory/extraction-jobs.ts";
import { registerExtractionScheduler } from "../../../PAO/packages/coding-agent/src/pao/memory/extraction-scheduler.ts";
import { registerMaintenanceScheduler } from "../../../PAO/packages/coding-agent/src/pao/memory/maintenance.ts";
import { openMemoryService } from "../../../PAO/packages/coding-agent/src/pao/memory/service.ts";
import { openMemoryStore } from "../../../PAO/packages/coding-agent/src/pao/memory/store.ts";

const request = vi.hoisted(() => ({ handle: undefined as undefined | ((input: any) => Promise<any>) }));
vi.mock("../../../PAO/packages/coding-agent/src/pao/memory/extract-model.ts", async (original) => ({
  ...await original<typeof import("../../../PAO/packages/coding-agent/src/pao/memory/extract-model.ts")>(),
  requestExtraction: (_deps: unknown, input: unknown) => request.handle!(input),
}));
vi.mock("../../../PAO/packages/coding-agent/src/pao/memory/runtime-embedding.ts", async (original) => ({
  ...await original<typeof import("../../../PAO/packages/coding-agent/src/pao/memory/runtime-embedding.ts")>(),
  embedCurrentMemories: async () => undefined,
}));
const dir = dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
const cleanups: (() => unknown | Promise<unknown>)[] = [];
const results: unknown[] = [];
const now = "2026-11-13T13:00:00.000Z";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(predicate: () => boolean) {
  for (let n = 0; n < 200; n++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("等待调度阶段完成超时");
}
function ok(value: any) { if (!value.ok) throw new Error(JSON.stringify(value)); return value; }
function fixture() {
  const home = mkdtempSync(join(dir, "o03-home-")); roots.push(home);
  const store = openMemoryStore(home, "readwrite");
  const service = openMemoryService({ paoHome: home, mode: "readwrite" });
  cleanups.push(async () => { await service.close(); store.close(); });
  return { home, store, service };
}
function session(f: ReturnType<typeof fixture>, id: string) {
  const manager = SessionManager.create(f.home, join(f.home, "agent", "sessions"), { id });
  const capture = createCapture({ store: f.store, paoHome: f.home, now: () => now });
  capture.registerSession(id, manager.getSessionFile());
  const scope = { projectId: "o03-independent", sessionId: id };
  const handlers = new Map<string, any>();
  const pi = { on: (event: string, handler: any) => {
    handlers.set(event, handler); return () => handlers.delete(event);
  } } as never;
  const ctx = { cwd: f.home, sessionManager: manager, modelRegistry: {} } as never;
  const unmount = registerExtractionScheduler(pi, {
    ...f, paoHome: f.home, resolveScope: () => scope, now: () => now,
    ledger: { appendUsage: vi.fn(), appendCustomEntry: vi.fn() } as never,
  });
  cleanups.push(unmount);
  function source(text: string, at = now) {
    const entryId = manager.appendMessage({ role: "user", content: text, timestamp: Date.parse(at) });
    manager.flush();
    return capture.captureCommittedEntry(id, manager.getEntry(entryId)!, undefined, at).sourceId!;
  }
  const emit = (event: string) => handlers.get(event)?.({ type: event }, ctx);
  return { ...f, manager, scope, pi, ctx, emit, source };
}
function row(f: ReturnType<typeof fixture>, id: string) {
  return f.store.db.prepare("SELECT * FROM extraction_jobs WHERE scope_key=?").get(`session:${id}`) as any;
}
function candidate(sourceId: string, conclusion: string) {
  return { kind: "decision", conclusion, evidenceKind: "user_statement", confirmation: "confirmed",
    sourceIds: [sourceId], quotedSpans: [{ sourceId, text: conclusion }],
    spanLocations: [{ sourceId, match: "exact", offset: 0 }] };
}
function output(candidates: any[] = []) { return { candidates, rejected: [], requestId: "offline-o03" }; }
afterEach(async () => {
  request.handle = undefined;
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  writeFileSync(join(dir, "o03-batch-boundary-results.json"), JSON.stringify(results, null, 2));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("C5：失败批后已有其他任务批次，无新增来源时不能反复重评", async () => {
  const f = fixture(); const s = session(f, "o03-multiple-batches");
  const first = s.source("构建使用 pnpm build。");
  const later = s.source("测试使用 pnpm test。");
  // 与现有 F13 夹具相同，预置会话任务切换后已采集的来源身份及顺序。
  f.store.db.prepare("UPDATE sources SET project_id=?, task_id='task-a', captured_at=? WHERE source_id=?")
    .run(s.scope.projectId, "2026-11-13T13:00:00.000Z", first);
  f.store.db.prepare("UPDATE sources SET project_id=?, task_id='task-b', captured_at=? WHERE source_id=?")
    .run(s.scope.projectId, "2026-11-13T13:00:01.000Z", later);
  const created = ok(await f.service.createMemory({ kind: "decision", scope: s.scope,
    conclusion: "构建使用 pnpm build。", evidenceKind: "user_statement", confirmation: "confirmed",
    sourceIds: [first], createdBy: "user", createdAt: now }));
  ok(await f.service.setMemoryUsage({ id: created.id, expectedRevision: 1, target: "stopped",
    source: { sessionId: s.scope.sessionId }, createdAt: now }));
  let calls = 0;
  const batches: string[][] = [];
  request.handle = async (input) => {
    calls++; batches.push(input.entries.map((entry: any) => entry.sourceId));
    return output([candidate(first, "构建使用 pnpm build。")]);
  };
  s.emit("turn_end"); s.emit("agent_settled");
  await until(() => row(f, s.scope.sessionId)?.status === "failed"); await tick();
  const before = { ...row(f, s.scope.sessionId) };
  const countBefore = (f.store.db.prepare("SELECT COUNT(*) AS n FROM sources").get() as any).n;
  s.emit("agent_settled");
  // 事件处理只有本地读盘；观察第二轮收尾，不添加任何来源或改变输入。
  await new Promise((resolve) => setTimeout(resolve, 150));
  const after = row(f, s.scope.sessionId);
  const countAfter = (f.store.db.prepare("SELECT COUNT(*) AS n FROM sources").get() as any).n;
  results.push({ id: "C5", calls, batches, before, after, countBefore, countAfter, first, later });
  expect(countAfter).toBe(countBefore);
  expect(calls).toBe(1);
  expect(after.attempt_count).toBe(before.attempt_count);
});
