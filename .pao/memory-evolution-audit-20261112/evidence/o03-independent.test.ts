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
  writeFileSync(join(dir, "o03-independent-results.json"), JSON.stringify(results, null, 2));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("C1：停用旧来源被拦截后，新用户明确重申应可正常提炼", async () => {
  const f = fixture(); const s = session(f, "o03-stopped");
  const first = s.source("构建使用 pnpm build。");
  const created = ok(await f.service.createMemory({ kind: "decision", scope: s.scope,
    conclusion: "构建使用 pnpm build。", evidenceKind: "user_statement", confirmation: "confirmed",
    sourceIds: [first], createdBy: "user", createdAt: now }));
  ok(await f.service.setMemoryUsage({ id: created.id, expectedRevision: 1, target: "stopped",
    source: { sessionId: s.scope.sessionId }, createdAt: now }));
  let calls = 0;
  request.handle = async () => { calls++; return output([candidate(first, "构建使用 pnpm build。")]); };
  s.emit("turn_end"); s.emit("agent_settled");
  await until(() => row(f, s.scope.sessionId)?.status === "failed"); await tick();
  // 新来源给更晚的 captured_at：来源表按 (captured_at, source_id) 排序，
  // 同刻 uuid sourceId 顺序不定，无法稳定区分「边界后真新增」。
  const next = s.source("现在重新明确确认：构建使用 pnpm build。", "2026-11-13T13:01:00.000Z");
  request.handle = async () => { calls++; return output([candidate(next, "构建使用 pnpm build。")]); };
  s.emit("turn_end"); s.emit("agent_settled"); await tick();
  const active = f.store.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE usage_state='active'").get() as any;
  results.push({ id: "C1", calls, job: row(f, s.scope.sessionId), active: active.n });
  expect(calls).toBe(2);
  expect(active.n).toBe(1);
  expect(row(f, s.scope.sessionId).status).toBe("done");
});

it("C2：同 home 同进程 A 前台忙时，B 的空闲事件不能领取提炼作业", async () => {
  const f = fixture(); const a = session(f, "o03-busy-a"); const b = session(f, "o03-busy-b");
  const sourceId = a.source("构建使用 pnpm build。");
  createJob(f.store, { sourceScope: JSON.stringify(a.scope), scopeKey: `session:${a.scope.sessionId}`, createdAt: now });
  // 此场景只核对领取；来源读取使用确定的已采集正文，避免文件 I/O 影响观察时点。
  vi.spyOn(f.service, "readMemorySource").mockResolvedValue({ ok: true, content: "构建使用 pnpm build。" } as never);
  let calls = 0;
  request.handle = async () => { calls++; return output([candidate(sourceId, "构建使用 pnpm build。")]); };
  a.emit("agent_start"); b.emit("agent_settled"); await tick();
  results.push({ id: "C2", calls, job: row(f, a.scope.sessionId) });
  expect(calls).toBe(0);
  expect(row(f, a.scope.sessionId).status).toBe("pending");
});

it("C3：前台连续抢占三次后，空闲仍可续作未提交来源", async () => {
  const f = fixture(); const s = session(f, "o03-preempt");
  s.source("构建使用 pnpm build。");
  let calls = 0;
  request.handle = async (input) => {
    calls++;
    return new Promise((resolve) => input.signal.addEventListener("abort", () => resolve({
      ...output(), failure: { stage: "request", message: "请求被取消:前台任务优先" },
    }), { once: true }));
  };
  for (let n = 1; n <= 3; n++) {
    s.emit("agent_settled"); await until(() => calls === n);
    // 本侧取消不是故障：signal.aborted 走 releaseJob 交回 pending 保游标，
    // 不占 consecutive_failures（O03/I03）——断言 pending 而非 failed。
    s.emit("agent_start"); await until(() => row(f, s.scope.sessionId)?.status === "pending"); await tick();
  }
  request.handle = async () => { calls++; return output(); };
  s.emit("agent_settled"); await tick();
  results.push({ id: "C3", calls, job: row(f, s.scope.sessionId) });
  expect(calls).toBe(4);
  expect(row(f, s.scope.sessionId).status).toBe("done");
});

it("C4：同 home 同进程 A 前台忙时，B 不能领取维护作业", async () => {
  const f = fixture(); const a = session(f, "o03-maint-a"); const b = session(f, "o03-maint-b");
  let handled = 0;
  const maintenance = registerMaintenanceScheduler(b.pi, {
    store: f.store, paoHome: f.home, resolveScope: () => b.scope, now: () => now,
    handlers: { embed: async () => { handled++; return { done: true }; } },
  });
  cleanups.push(() => maintenance.unmount());
  maintenance.enqueue("embed", "embed:o03-busy", JSON.stringify(b.scope));
  a.emit("agent_start"); b.emit("agent_settled"); await tick();
  results.push({ id: "C4", handled,
    job: f.store.db.prepare("SELECT * FROM extraction_jobs WHERE scope_key='embed:o03-busy'").get() });
  expect(handled).toBe(0);
});
