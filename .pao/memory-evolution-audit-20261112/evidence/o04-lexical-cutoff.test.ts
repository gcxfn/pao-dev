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
  writeFileSync(join(dir, "o04-lexical-cutoff-results.json"), JSON.stringify(results, null, 2));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("A7：词法候选受限条目超过固定余量时仍须补取有效条目", async () => {
  const f = fixture();
  for (let n = 0; n < 41; n++) {
    await f.memory("lexical-saturation", { conditions: "仅适用 feature-a 分支" });
  }
  const shared = await f.memory("lexical-saturation " + "filler ".repeat(150));
  const scope = { ...f.scope, branch: "feature-b" };
  const search = (limit: number) => searchMemories(f.store, scope,
    { query: "lexical-saturation", mode: "current", limit }, { embed: null });
  const narrow = await search(1); const wide = await search(30);
  results.push({ id: "A7", restrictedCount: 41, sharedId: shared.id, narrow, wide });
  expect(wide.hits.map(h => h.memoryId)).toContain(shared.id);
  expect(narrow.hits.map(h => h.memoryId)).toEqual([shared.id]);
});
