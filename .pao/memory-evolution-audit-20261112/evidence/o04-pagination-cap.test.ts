/** O04 独立复核：真实存储、服务和搜索，语义查询使用固定向量。 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openMemoryStore } from "../../../PAO/packages/coding-agent/src/pao/memory/store.ts";
import { openMemoryService } from "../../../PAO/packages/coding-agent/src/pao/memory/service.ts";
import { registerSource } from "../../../PAO/packages/coding-agent/src/pao/memory/sources.ts";
import { searchMemories } from "../../../PAO/packages/coding-agent/src/pao/memory/search.ts";
import { encodeVector } from "../../../PAO/packages/coding-agent/src/pao/memory/embeddings.ts";
const dir = dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
const closers: (() => Promise<void>)[] = [];
const results: unknown[] = [];
const at = "2026-11-14T00:00:00.000Z";
function ok(value: any) { if (!value.ok) throw new Error(JSON.stringify(value)); return value; }
function fixture() {
  const home = mkdtempSync(join(dir, "o04-home-")); roots.push(home);
  const store = openMemoryStore(home, "readwrite");
  const service = openMemoryService({ paoHome: home, mode: "readwrite" });
  closers.push(async () => { await service.close(); store.close(); });
  const scope = { projectId: "o04-independent", branch: "feature-a" };
  let entry = 0;
  async function memory(conclusion: string, fields: object = {}) {
    const sourceId = registerSource(store.db, { sessionId: "o04-session", entryId: `entry-${++entry}`,
      eventType: "user", capturedAt: at });
    const created = ok(await service.createMemory({ kind: "decision", scope, conclusion,
      evidenceKind: "user_statement", confirmation: "confirmed", sourceIds: [sourceId],
      createdBy: "user", createdAt: at, ...fields }));
    return { id: created.id, sourceId };
  }
  function vector(id: string, data: number[]) {
    store.db.prepare("INSERT INTO memory_vectors(memory_id,revision,model,dimension,vector) VALUES (?,1,'fixture',?,?)")
      .run(id, data.length, encodeVector(data));
  }
  return { home, store, service, scope, memory, vector };
}
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  writeFileSync(join(dir, "o04-pagination-cap-results.json"), JSON.stringify(results, null, 2));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("A8：分页不能在查询未耗尽且有效候选不足时按固定批数停止", async () => {
  const f = fixture(); const entries: { id: string; sourceId: string }[] = [];
  for (let n = 0; n < 401; n++) {
    entries.push(await f.memory("lexical-page-cap", { conditions: "仅适用 feature-a 分支" }));
  }
  // 共享条目的 ID 排最后，正文更长，保证 LIKE/FTS 两路均需读到第 401 项。
  const shared = entries.sort((a, b) => a.id.localeCompare(b.id)).at(-1)!;
  ok(await f.service.correctMemory({ id: shared.id, expectedRevision: 1,
    replacement: { conclusion: "lexical-page-cap " + "filler ".repeat(150),
      evidenceKind: "user_statement", confirmation: "confirmed" }, source: { sessionId: "o04-session" } }));
  const scope = { ...f.scope, branch: "feature-b" };
  const search = (limit: number) => searchMemories(f.store, scope,
    { query: "lexical-page-cap", mode: "current", limit }, { embed: null });
  const narrow = await search(1); const wide = await search(30);
  results.push({ id: "A8", total: entries.length, restrictedCount: entries.length - 1,
    sharedId: shared.id, narrow, wide });
  expect(wide.hits.map(h => h.memoryId)).toContain(shared.id);
  expect(narrow.hits.map(h => h.memoryId)).toEqual([shared.id]);
});
