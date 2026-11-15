import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../../PAO/packages/coding-agent/src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../../../PAO/packages/coding-agent/test/utilities.ts";
import { createCapture } from "../../../PAO/packages/coding-agent/src/pao/memory/capture.ts";
import { openMemoryStore } from "../../../PAO/packages/coding-agent/src/pao/memory/store.ts";
import { openMemoryService } from "../../../PAO/packages/coding-agent/src/pao/memory/service.ts";
import { createMemoryBackup, restoreMemoryBackup } from "../../../PAO/packages/coding-agent/src/pao/memory/backup.ts";
import { readSourceEvents } from "../../../PAO/packages/coding-agent/src/pao/memory/archive.ts";

const here = dirname(fileURLToPath(import.meta.url));
const cleanup: Array<() => unknown> = [];
const results: Record<string, unknown> = {};
const scope = { projectId: "o07-review-project" };
const at = "2026-11-14T15:00:00.000Z";
function fixture() {
  const root = mkdtempSync(join(here, "o07-case-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"), backupDir = join(root, "backup"), targetHome = join(root, "restored");
  const store = openMemoryStore(home, "readwrite");
  const service = openMemoryService({ paoHome: home, mode: "readwrite" });
  let closed = false;
  const close = async () => { if (!closed) { await service.close(); store.close(); closed = true; } };
  cleanup.push(close);
  const capture = createCapture({ store, paoHome: home });
  const sessions = new Map<string, ReturnType<typeof SessionManager.create>>();
  function source(text: string, sessionId = "review-session") {
    let session = sessions.get(sessionId);
    if (!session) {
      session = SessionManager.create(process.cwd(), join(home, "agent", "sessions"), { id: sessionId });
      sessions.set(sessionId, session);
    }
    const entryId = session.appendMessage(userMsg(text));
    session.appendMessage(assistantMsg("已记录讨论"));
    capture.registerSession(sessionId, session.getSessionFile()!);
    const captured = capture.captureCommittedEntry(sessionId, session.getEntry(entryId)! as never, "user", at);
    if (!captured.sourceId) throw new Error("来源采集失败");
    return captured.sourceId;
  }
  async function memory(conclusion: string, sourceIds: string[]) {
    const created = await service.createMemory({ kind: "decision", scope, conclusion, sourceIds, evidenceKind: "user_statement", confirmation: "confirmed", createdAt: at });
    if (!created.ok) throw new Error(created.error.message);
    return created.id;
  }
  function target() {
    const targetStore = openMemoryStore(targetHome, "readonly");
    const targetService = openMemoryService({ paoHome: targetHome, mode: "readonly" });
    cleanup.push(() => targetStore.close()); cleanup.push(() => targetService.close());
    return { store: targetStore, service: targetService };
  }
  return { root, home, backupDir, targetHome, store, service, source, memory, target, close };
}
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
afterAll(() => writeFileSync(join(here, "o07-independent-results.json"), JSON.stringify(results, null, 2)));

describe("O07 独立完成审核", () => {
  it("I1 删除重放保留共享来源时，历史原文仍可发现", async () => {
    const f = fixture();
    const shared = f.source("SHAREDSOURCEKEEPKEY 原始讨论");
    const exclusive = f.source("独占来源正文");
    const alive = await f.memory("保留决定", [shared]);
    const deleted = await f.memory("删除决定", [shared, exclusive]);
    const before = await f.service.searchMemory({ scope, query: "SHAREDSOURCEKEEPKEY", mode: "history" });
    expect(before.sourceHits?.some(hit => hit.sourceId === shared)).toBe(true);
    expect(createMemoryBackup(f.store, { home: f.home, backupDir: f.backupDir }).ok).toBe(true);
    const deletion = await f.service.deleteMemory({ memoryIds: [deleted], revisions: { [deleted]: 1 }, source: { sessionId: "review-session" }, sharedSourcePolicy: "retain" });
    expect(deletion.ok).toBe(true);
    expect(restoreMemoryBackup({ backupDir: f.backupDir, targetHome: f.targetHome, liveHome: f.home }).ok).toBe(true);
    const target = f.target();
    const direct = await readSourceEvents(target.store.db, f.targetHome, shared);
    const history = await target.service.searchMemory({ scope, query: "SHAREDSOURCEKEEPKEY", mode: "history" });
    results.I1 = { alive: await target.service.getMemory({ id: alive }), direct, history };
    expect(direct.ok).toBe(true);
    expect(history.sourceHits?.some(hit => hit.sourceId === shared)).toBe(true);
  });

  it("I2 备份缺失的归档段恢复后不回旧 home 读取", async () => {
    const f = fixture(); const source = f.source("缺失段的旧现场正文");
    const row = f.store.db.prepare("SELECT original_path FROM archive_segments").get() as { original_path: string };
    renameSync(row.original_path, row.original_path + ".held");
    const backup = createMemoryBackup(f.store, { home: f.home, backupDir: f.backupDir });
    renameSync(row.original_path + ".held", row.original_path);
    expect(backup.ok).toBe(true);
    if (!backup.ok) return;
    expect(backup.missingSegments).toBe(1);
    const restored = restoreMemoryBackup({ backupDir: f.backupDir, targetHome: f.targetHome });
    expect(restored.ok).toBe(true);
    const target = f.target();
    const read = await readSourceEvents(target.store.db, f.targetHome, source);
    results.I2 = { backup, restored, read, paths: target.store.db.prepare("SELECT original_path,compressed_path FROM archive_segments").all() };
    expect(read.ok).toBe(false);
  });

  it("I3 备份缺失的受管成果恢复后不回旧 home 读取", async () => {
    const f = fixture(); const source = f.source("成果产生依据");
    const delivery = join(f.root, "delivery.txt"); writeFileSync(delivery, "成果原始字节");
    const registered = await f.service.registerArtifact({ name: "待恢复成果", scope, files: [{ name: "delivery.txt", path: delivery }], sourceIds: [source] });
    expect(registered.ok).toBe(true); if (!registered.ok) return;
    const version = registered.versions[0]!;
    if (version.location.kind !== "managed") throw new Error("未创建受管副本");
    const original = join(version.location.dir, version.location.file);
    renameSync(original, original + ".held");
    const backup = createMemoryBackup(f.store, { home: f.home, backupDir: f.backupDir });
    renameSync(original + ".held", original);
    expect(backup.ok).toBe(true); if (!backup.ok) return;
    expect(backup.missingArtifacts).toBe(1);
    const restored = restoreMemoryBackup({ backupDir: f.backupDir, targetHome: f.targetHome });
    expect(restored.ok).toBe(true);
    const target = f.target();
    const read = await target.service.resolveArtifactVersion({ versionId: version.versionId });
    results.I3 = { backup, restored, read: read.ok ? { available: read.available, location: read.version.location } : read };
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.available).toBe(false);
  });

  it("I4 快照前的新来源登记不会使数据库与备份段清单脱节", async () => {
    const f = fixture(); f.source("快照前已有来源", "session-before");
    const exec = f.store.db.exec.bind(f.store.db);
    let inserted = "";
    // 在读取段清单后、VACUUM 取快照前固定另一个写入者可发生的来源登记。
    f.store.db.exec = (sql: string) => {
      if (sql.startsWith("VACUUM INTO") && !inserted) {
        f.store.db.exec = exec;
        inserted = f.source("快照必须保留的新来源", "session-during");
      }
      return exec(sql);
    };
    const backup = createMemoryBackup(f.store, { home: f.home, backupDir: f.backupDir });
    f.store.db.exec = exec;
    expect(backup.ok).toBe(true); expect(inserted).not.toBe("");
    await f.close(); renameSync(f.home, join(f.root, "offline-home"));
    const restored = restoreMemoryBackup({ backupDir: f.backupDir, targetHome: f.targetHome });
    expect(restored.ok).toBe(true);
    const target = f.target();
    const read = await readSourceEvents(target.store.db, f.targetHome, inserted);
    results.I4 = { backup, restored, read, databaseSegments: target.store.db.prepare("SELECT segment_id,original_path,compressed_path FROM archive_segments").all(), manifest: JSON.parse(readFileSync(join(f.backupDir, "manifest.json"), "utf8")).segments };
    expect(read.ok).toBe(true);
  });
});
