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
  writeFileSync(join(dir, "o04-independent-results.json"), JSON.stringify(results, null, 2));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("A1：适用分支与来源分支不同，应按明确的适用条件筛选", async () => {
  const f = fixture();
  const m = await f.memory("分支部署约定", { conditions: "仅适用 feature-b 分支" });
  const search = (branch: string) => searchMemories(f.store, { ...f.scope, branch },
    { query: m.id, mode: "current", limit: 1 }, { embed: null });
  const origin = await search("feature-a"); const target = await search("feature-b");
  results.push({ id: "A1", memoryId: m.id, origin, target });
  expect(target.hits.map(h => h.memoryId)).toContain(m.id);
  expect(origin.hits).toHaveLength(0);
});
it("A2：分支受限的高分候选不能挤掉有效的项目共享结果", async () => {
  const f = fixture();
  const restricted = await f.memory("甲方案", { conditions: "仅适用 feature-a 分支" });
  const shared = await f.memory("乙方案");
  f.vector(restricted.id, [1, 0]); f.vector(shared.id, [0.8, 0.6]);
  const search = (limit: number) => searchMemories(f.store, { ...f.scope, branch: "feature-b" },
    { query: "unmatched-query", mode: "current", limit }, { embed: null, queryVector: [1, 0] });
  const narrow = await search(1); const wide = await search(3);
  results.push({ id: "A2", sharedId: shared.id, narrow, wide });
  expect(wide.hits.map(h => h.memoryId)).toContain(shared.id);
  expect(narrow.hits.map(h => h.memoryId)).toEqual([shared.id]);
});
it("A3：来源已排除的语义候选不能占满 lane 丢掉有效命中", async () => {
  const f = fixture();
  for (let n = 0; n < 21; n++) {
    const m = await f.memory(`已排除方案 ${n}`); f.vector(m.id, [1, 0]);
    f.store.db.prepare("INSERT INTO source_exclusions(exclusion_id,source_id,memory_id,created_at) VALUES (?,?,?,?)")
      .run(`excluded-${n}`, m.sourceId, m.id, at);
  }
  const valid = await f.memory("有效方案"); f.vector(valid.id, [0.8, 0.6]);
  const search = (limit: number) => searchMemories(f.store, f.scope,
    { query: "unmatched-query", mode: "current", limit }, { embed: null, queryVector: [1, 0] });
  const narrow = await search(1); const wide = await search(30);
  results.push({ id: "A3", validId: valid.id, narrow, wide });
  expect(wide.hits.map(h => h.memoryId)).toContain(valid.id);
  expect(narrow.hits.map(h => h.memoryId)).toEqual([valid.id]);
});
it("A4：准确 ID 在 superseded 模式也应返回该记忆的历史修订", async () => {
  const f = fixture(); const m = await f.memory("旧部署约定");
  ok(await f.service.correctMemory({ id: m.id, expectedRevision: 1,
    replacement: { conclusion: "新部署约定", evidenceKind: "user_statement", confirmation: "confirmed" },
    source: { sessionId: "o04-session" } }));
  const found = await searchMemories(f.store, f.scope,
    { query: m.id, mode: "history", historyRevisions: "superseded", limit: 1 }, { embed: null });
  results.push({ id: "A4", memoryId: m.id, found });
  expect(found.hits.map(h => [h.memoryId, h.revision])).toEqual([[m.id, 1]]);
});
