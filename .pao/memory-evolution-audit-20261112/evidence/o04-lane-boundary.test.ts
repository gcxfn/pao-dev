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
  writeFileSync(join(dir, "o04-lane-boundary-results.json"), JSON.stringify(results, null, 2));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("A5：受限分支占满 perLane 时，词法及语义路仍应返有效条目", async () => {
  const f = fixture();
  for (let n = 0; n < 21; n++) {
    const restricted = await f.memory("branch-cutoff", { conditions: "仅适用 feature-a 分支" });
    f.vector(restricted.id, [1, 0]);
  }
  const shared = await f.memory("branch-cutoff " + "filler ".repeat(150));
  f.vector(shared.id, [0.8, 0.6]);
  const scope = { ...f.scope, branch: "feature-b" };
  const semantic = (limit: number) => searchMemories(f.store, scope,
    { query: "unmatched-query", mode: "current", limit }, { embed: null, queryVector: [1, 0] });
  const lexical = (limit: number) => searchMemories(f.store, scope,
    { query: "branch-cutoff", mode: "current", limit }, { embed: null });
  const semanticNarrow = await semantic(1); const semanticWide = await semantic(30);
  const lexicalNarrow = await lexical(1); const lexicalWide = await lexical(30);
  results.push({ id: "A5", sharedId: shared.id, semanticNarrow, semanticWide, lexicalNarrow, lexicalWide });
  expect(semanticWide.hits.map(h => h.memoryId)).toContain(shared.id);
  expect(lexicalWide.hits.map(h => h.memoryId)).toContain(shared.id);
  expect(semanticNarrow.hits.map(h => h.memoryId)).toEqual([shared.id]);
  expect(lexicalNarrow.hits.map(h => h.memoryId)).toEqual([shared.id]);
});
it("A6：当前适用分支限制不能阻断同项目的历史查询", async () => {
  const f = fixture();
  const m = await f.memory("历史分支部署约定", { conditions: "仅适用 feature-a 分支" });
  const scope = { ...f.scope, branch: "feature-b" };
  const current = await searchMemories(f.store, scope,
    { query: m.id, mode: "current", limit: 1 }, { embed: null });
  const history = await searchMemories(f.store, scope,
    { query: m.id, mode: "history", limit: 1 }, { embed: null });
  results.push({ id: "A6", memoryId: m.id, current, history });
  expect(current.hits).toHaveLength(0);
  expect(history.hits.map(h => h.memoryId)).toContain(m.id);
});
