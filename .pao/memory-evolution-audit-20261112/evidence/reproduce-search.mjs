// 运行：node .pao/memory-evolution-audit-20261112/evidence/reproduce-search.mjs
// 直接调用当前搜索实现；确定性数据夹具，无模型请求。
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMemoryStore, upsertMemoryFts } from '../../../PAO/packages/coding-agent/src/pao/memory/store.ts';
import { searchMemories } from '../../../PAO/packages/coding-agent/src/pao/memory/search.ts';

const outputDir = dirname(fileURLToPath(import.meta.url));
const home = mkdtempSync(join(outputDir, 'search-home-'));
const store = openMemoryStore(home, 'readwrite');
const at = '2026-11-12T00:00:00.000Z';
const results = [];
function seed(id, scope, conclusions) {
  store.db.prepare('INSERT INTO memories (id,kind,scope_json,current_revision,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, 'decision', JSON.stringify(scope), conclusions.length, at, at);
  conclusions.forEach((conclusion, index) => {
    const content = { conclusion, evidenceKind: 'user_statement', confirmation: 'confirmed' };
    store.db.prepare('INSERT INTO memory_revisions VALUES (?,?,?,?,?)')
      .run(id, index + 1, JSON.stringify(content), 'user', at);
    upsertMemoryFts(store.db, id, index + 1, content);
  });
}
async function query(scope, text, limit = 1) {
  return searchMemories(store, scope, { query: text, mode: 'current', limit }, { embed: null });
}
try {
  const scope = { projectId: 'audit-revisions' };
  const id = 'mem-11111111-1111-1111-1111-111111111111';
  seed(id, scope, ['选型使用 A', '选型使用 B']);
  const narrow = await query(scope, '选型');
  const broad = await query(scope, '选型', 3);
  assert.equal(broad.hits[0]?.revision, 2);
  results.push({ case: 'current-revision-before-limit', expected: [2], actual: narrow.hits.map(h => h.revision), control: broad.hits.map(h => h.revision), passed: narrow.hits[0]?.revision === 2 });

  const exact = await query(scope, id);
  results.push({ case: 'exact-memory-id', expected: [id], actual: exact.hits.map(h => h.memoryId), passed: exact.hits.some(h => h.memoryId === id) });

  const branchScope = { projectId: 'audit-branch', branch: 'feature-a', executionRoot: 'D:/audit/worktree-a' };
  seed('mem-22222222-2222-2222-2222-222222222222', branchScope, ['此分支使用旧接口']);
  const branch = await query({ ...branchScope, branch: 'feature-b', executionRoot: 'D:/audit/worktree-b' }, '旧接口');
  results.push({ case: 'branch-constraint', expected: [], actual: branch.hits.map(h => ({ id: h.memoryId, scope: h.scope })), passed: branch.hits.length === 0 });
} finally {
  store.close();
}
const report = { kind: '确定性离线行为复现', home, results };
writeFileSync(join(outputDir, 'search-results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
