import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createCapture } from "../../../PAO/packages/coding-agent/src/pao/memory/capture.ts";
import { openMemoryStore } from "../../../PAO/packages/coding-agent/src/pao/memory/store.ts";
import { openMemoryService } from "../../../PAO/packages/coding-agent/src/pao/memory/service.ts";
import { resolveMemoryScope } from "../../../PAO/packages/coding-agent/src/pao/memory/project-identity.ts";
import { runOrganizeMaintenance } from "../../../PAO/packages/coding-agent/src/pao/memory/organize.ts";
import { registerMaintenanceScheduler } from "../../../PAO/packages/coding-agent/src/pao/memory/maintenance.ts";
import { registerMemoryCommand } from "../../../PAO/packages/coding-agent/src/pao/memory/session.ts";
import { listPaoSubcommands } from "../../../PAO/packages/coding-agent/src/pao/command-router.ts";

const here = dirname(fileURLToPath(import.meta.url));
const cleanup: Array<() => unknown> = [];
const results: Record<string, unknown> = {};
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
let seq = 0;
function fixture() {
  const home = mkdtempSync(join(here, "o06-case-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const store = openMemoryStore(home, "readwrite");
  cleanup.push(() => store.close());
  const service = openMemoryService({ paoHome: home, mode: "readwrite" });
  cleanup.push(() => service.close());
  const capture = createCapture({ store, paoHome: home });
  const scope = resolveMemoryScope(process.cwd());
  let clock = Date.parse("2026-11-14T12:00:00.000Z");
  const now = () => new Date(clock += 1000).toISOString();
  const handlers = new Map<string, any[]>();
  const notices: unknown[] = [];
  const pi = { on: (event: string, fn: any) => { const a = handlers.get(event) ?? []; a.push(fn); handlers.set(event, a); return () => {}; }, registerCommand: () => {}, sendMessage: () => {}, appendEntry: () => {} } as any;
  const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => "o06-session" }, ui: { notify: (...args: unknown[]) => notices.push(args), confirm: async () => true } } as any;
  async function seed(conclusion: string, confirmation: "confirmed" | "tentative" = "tentative", conditions?: string, targetScope = scope) {
    const id = `o06-event-${++seq}`;
    const timestamp = now();
    const source = capture.captureCommittedEntries("o06-session", [{ id, parentId: null, timestamp, type: "message", message: { role: "user", content: conclusion + (conditions ?? ""), timestamp: clock } }] as any)[0].sourceId!;
    const created = await service.createMemory({ kind: "decision", scope: targetScope, conclusion, ...(conditions === undefined ? {} : { conditions }), confirmation, evidenceKind: "user_statement", sourceIds: [source], createdAt: now(), createdBy: "user" });
    if (!created.ok) throw new Error(created.error.message);
    return created.id;
  }
  const canonical = () => store.db.prepare("SELECT m.id,r.content_json FROM memories m JOIN memory_revisions r ON r.memory_id=m.id AND r.revision=m.current_revision WHERE m.merged_into IS NULL AND m.usage_state='active' ORDER BY m.id").all().map((r: any) => ({ id: r.id, content: JSON.parse(r.content_json) }));
  const organize = () => runOrganizeMaintenance({ store, service, paoHome: home, sourceScope: JSON.stringify(scope), jobId: "o06-direct", now });
  function scheduler(afterOrganize?: (call: number) => Promise<void>) {
    let calls = 0;
    const handle = registerMaintenanceScheduler(pi, { store, service, paoHome: home, resolveScope: () => scope, now, handlers: { organize: async (_ctx, job) => { calls++; const result = await runOrganizeMaintenance({ store, service, paoHome: home, sourceScope: job.sourceScope, jobId: job.jobId, cursor: job.cursor, now }); await afterOrganize?.(calls); return result; } } });
    cleanup.push(() => handle.unmount());
    const key = `organize:${scope.projectId}`;
    const enqueue = () => handle.enqueue("organize", key, JSON.stringify({ kind: "organize", projectId: scope.projectId }));
    const row = () => store.db.prepare("SELECT status,cursor,attempt_count FROM extraction_jobs WHERE scope_key=?").get(key) as any;
    return { handle, enqueue, row, calls: () => calls };
  }
  async function settled() { for (const fn of handlers.get("agent_settled") ?? []) await fn({ type: "agent_settled" }, ctx); await tick(); }
  async function command(args: string) { const sub = listPaoSubcommands(pi).find(s => s.name === "memory")!; await sub.run(pi, args, ctx); }
  return { home, store, service, scope, now, pi, ctx, seed, canonical, organize, scheduler, settled, command, notices };
}
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
afterAll(() => writeFileSync(join(here, "o06-independent-results.json"), JSON.stringify(results, null, 2)));

describe("O06 独立完成审核", () => {
  it("D1 同项目整理完成后，新变化仍能再次整理", async () => {
    const f = fixture(); const q = f.scheduler();
    await f.seed("采用 SQLite");
    expect(q.enqueue()).toBe(true); await f.settled();
    expect(q.row().status).toBe("done");
    expect(q.calls()).toBe(1);
    const first = q.row();
    await f.seed("采用 SQLite");
    expect(q.enqueue()).toBe(true); await f.settled();
    results.D1 = { first, after: q.row(), calls: q.calls(), canonical: f.canonical() };
    expect.soft(q.calls()).toBe(2);
    expect(f.canonical()).toHaveLength(1);
  });

  it("D2 两个正式决定条件互斥时，不自动合并并丢弃条件", async () => {
    const f = fixture();
    await f.seed("采用 SQLite", "confirmed", "仅限单机部署");
    await f.seed("采用 SQLite", "confirmed", "仅限多机部署");
    const organized = await f.organize();
    results.D2 = { organized, canonical: f.canonical() };
    expect(f.canonical()).toHaveLength(2);
  });

  it("D3 合并待定与已确认决定时，不把已确认决定降成待定", async () => {
    const f = fixture();
    const ids = [await f.seed("采用 SQLite"), await f.seed("采用 SQLite")].sort((a, b) => a.localeCompare(b));
    const confirmed = await f.service.correctMemory({ id: ids[1], expectedRevision: 1, replacement: { conclusion: "采用 SQLite", evidenceKind: "user_statement", confirmation: "confirmed" }, source: { sessionId: "o06-session", entryId: "explicit-confirmation", userId: "user" }, createdAt: f.now() });
    expect(confirmed.ok).toBe(true);
    const organized = await f.organize();
    const canonical = f.canonical();
    results.D3 = { organized, confirmedId: ids[1], canonical };
    expect(canonical.some(m => m.content.confirmation === "confirmed")).toBe(true);
  });

  it("D4 settled 后异步登记的整理任务，无需另一次用户回合即可消费", async () => {
    const f = fixture(); const q = f.scheduler();
    await f.seed("采用 SQLite"); await f.seed("采用 SQLite");
    await f.settled();
    // 提炼器在本轮 settled 启动，异步完成后才调用生产 enqueue。
    expect(q.enqueue()).toBe(true);
    await tick(); await tick();
    results.D4 = { job: q.row(), calls: q.calls(), canonical: f.canonical() };
    await expect.poll(() => q.row()?.status, { timeout: 1000, interval: 20 }).toBe("done");
  });

  it("D5 rebuild 接受带空格的项目路径，不静默重建错误范围", async () => {
    const f = fixture();
    const projectDir = join(f.home, "project with spaces"); mkdirSync(projectDir);
    execFileSync("git", ["init", "--quiet", "--initial-branch=main", projectDir]);
    const targetScope = resolveMemoryScope(projectDir);
    const id = await f.seed("范围重建 SQLite", "tentative", undefined, targetScope);
    f.store.db.prepare("DELETE FROM memory_fts WHERE memory_id=?").run(id);
    registerMemoryCommand(f.pi, () => undefined, () => f.home);
    await f.command(`rebuild --project "${targetScope.projectId}"`);
    const rows = f.store.db.prepare("SELECT memory_id FROM memory_fts WHERE memory_id=?").all(id);
    results.D5 = { projectId: targetScope.projectId, rows, notices: f.notices };
    expect(rows).toHaveLength(1);
  });

  it("D6 backup 接受带空格的目录参数，并登记真实维护队列", async () => {
    const f = fixture(); const q = f.scheduler();
    registerMemoryCommand(f.pi, () => undefined, () => f.home, { enqueue: (kind, key, sourceScope) => q.handle.enqueue(kind, key, sourceScope) });
    const plain = join(f.home, "backup-basic");
    await f.command(`backup ${plain}`);
    expect(f.store.db.prepare("SELECT 1 FROM extraction_jobs WHERE scope_key=?").get(`archive:${plain}`)).toBeDefined();
    const directory = join(f.home, "backup with spaces");
    await f.command(`backup "${directory}"`);
    const row = f.store.db.prepare("SELECT source_scope,status FROM extraction_jobs WHERE scope_key=?").get(`archive:${directory}`);
    results.D6 = { directory, row: row ?? null, notices: f.notices };
    expect(row).toBeDefined();
  });

  it("D7 同项目作业运行期间登记新变化，当前批次结束后仍继续整理", async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const q = f.scheduler(async call => { if (call === 1) await gate; });
    await f.seed("采用 SQLite");
    expect(q.enqueue()).toBe(true);
    await f.settled();
    try {
      expect(q.row().status).toBe("running");
      await f.seed("采用 SQLite");
      expect(q.enqueue()).toBe(true);
    } finally {
      release();
    }
    try {
      await expect.poll(() => f.canonical().length, { timeout: 1000, interval: 20 }).toBe(1);
    } finally {
      results.D7 = { job: q.row(), calls: q.calls(), canonical: f.canonical() };
    }
  });

  it("D8 同 PAO_HOME 的另一调度实例在运行期间登记新变化，工作仍被消费", async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const owner = f.scheduler(async call => { if (call === 1) await gate; });
    const producer = f.scheduler();
    await f.seed("采用 SQLite");
    expect(owner.enqueue()).toBe(true);
    await f.settled();
    try {
      expect(owner.row().status).toBe("running");
      await f.seed("采用 SQLite");
      expect(producer.enqueue()).toBe(true);
      await tick();
      expect(owner.row().status).toBe("running");
      expect(producer.calls()).toBe(0);
    } finally {
      release();
    }
    try {
      await expect.poll(() => f.canonical().length, { timeout: 1000, interval: 20 }).toBe(1);
    } finally {
      results.D8 = { job: owner.row(), ownerCalls: owner.calls(), producerCalls: producer.calls(), canonical: f.canonical() };
    }
  });

  it("D9 批末事务边界登记的新工作仍被消费", async () => {
    const observations: unknown[] = [];
    results.D9 = observations;
    for (const boundary of [1, 2, 3]) {
      const f = fixture();
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const owner = f.scheduler(async call => { if (call === 1) await gate; });
      const producer = f.scheduler();
      await f.seed("采用 SQLite");
      expect(owner.enqueue()).toBe(true);
      await f.settled();
      expect(owner.row().status).toBe("running");
      await f.seed("采用 SQLite");
      const transaction = f.store.transaction.bind(f.store);
      let commits = 0;
      let injected = false;
      // 保留真实事务与返回值，逐个固定批末事务提交后另一进程可发生的登记交错。
      f.store.transaction = (<T>(fn: () => T): T => {
        const value = transaction(fn);
        if (++commits === boundary && !injected) {
          f.store.transaction = transaction;
          injected = true;
          expect(producer.enqueue()).toBe(true);
        }
        return value;
      }) as typeof f.store.transaction;
      release();
      await tick(); await tick();
      // 批末若已合并为更少事务，剩余位置对应本批结束后登记。
      if (!injected) {
        f.store.transaction = transaction;
        expect(producer.enqueue()).toBe(true);
      }
      try {
        await expect.poll(() => f.canonical().length, { timeout: 1000, interval: 20 }).toBe(1);
      } finally {
        f.store.transaction = transaction;
        observations.push({
          boundary, injected, job: owner.row(), ownerCalls: owner.calls(), producerCalls: producer.calls(),
          canonical: f.canonical(), rerunMarkers: f.store.db.prepare("SELECT scope_key FROM maintenance_pending_rerun").all(),
        });
      }
    }
  });
});
