// O04 独立复核：构造反面/边界场景亲自复验（对应任务书验证口径）。
// 运行：node .pao/memory-evolution-audit-20261112/evidence/o04-independent-review.mjs
// 直接调用当前实现；确定性夹具，无模型请求。
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMemoryStore, upsertMemoryFts } from '../../../PAO/packages/coding-agent/src/pao/memory/store.ts';
import { searchMemories } from '../../../PAO/packages/coding-agent/src/pao/memory/search.ts';
import { registerSource } from '../../../PAO/packages/coding-agent/src/pao/memory/sources.ts';
import { encodeVector, readMemoryVectors } from '../../../PAO/packages/coding-agent/src/pao/memory/embeddings.ts';
import { currentScopeFilter } from '../../../PAO/packages/coding-agent/src/pao/memory/scope.ts';

const outputDir = dirname(fileURLToPath(import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'o04-review-'));
const store = openMemoryStore(home, 'readwrite');
const db = store.db;
const at = '2026-11-14T00:00:00.000Z';
const results = [];
const check = (name, passed, detail) => { results.push({ case: name, passed, detail }); };

function seedMemory(id, scope, revisions, opts = {}) {
  db.prepare("INSERT INTO memories (id,kind,scope_json,current_revision,usage_state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, opts.kind ?? 'decision', JSON.stringify(scope), revisions.length, opts.usageState ?? 'active', at, at);
  revisions.forEach((content, i) => {
    db.prepare('INSERT INTO memory_revisions VALUES (?,?,?,?,?)').run(id, i + 1, JSON.stringify(content), 'user', at);
    upsertMemoryFts(db, id, i + 1, content);
    for (const sid of (opts.sourceIds ?? [])) {
      db.prepare('INSERT INTO memory_source_links (memory_id, revision, source_id) VALUES (?,?,?)').run(id, i + 1, sid);
    }
  });
}
const content = (conclusion, extra = {}) => ({ conclusion, evidenceKind: 'user_statement', confirmation: 'confirmed', ...extra });
const putVec = (id, rev, vec, model = 'fixture') =>
  db.prepare('INSERT INTO memory_vectors (memory_id,revision,model,dimension,vector) VALUES (?,?,?,?,?)')
    .run(id, rev, model, vec.length, encodeVector(vec));
const q = (scope, query, extra = {}) => searchMemories(store, scope, { mode: 'current', limit: 3, query, ...extra }, { embed: null });
const qv = (scope, query, vector, extra = {}) =>
  searchMemories(store, scope, { mode: 'current', limit: 3, query, ...extra }, { embed: null, queryVector: vector });

try {
  // ── 场景1：多轮纠正 + limit=1 → 必须返最新修订（Q1，审核 current-revision-before-limit 扩展）
  {
    const scope = { projectId: 'rev-proj' };
    seedMemory('mem-aaaaaaa1-0000-0000-0000-000000000001', scope, [
      content('部署选型甲'), content('部署选型乙'), content('部署选型丙'), content('部署选型丁'),
    ]);
    const r = await q(scope, '部署选型', { limit: 1 });
    check('multi-correct-limit1', r.hits.length === 1 && r.hits[0].revision === 4,
      `hits=${JSON.stringify(r.hits.map(h => [h.memoryId, h.revision]))}`);
  }

  // ── 场景2：被排除来源条目占满 perLane，有效条目 limit=1 仍返回（Q1 lane 下推）
  {
    const scope = { projectId: 'lane-proj' };
    // 25 条同词但来源已排除（perLane=20），有效条目最后插入。
    for (let i = 0; i < 25; i++) {
      const sid = registerSource(db, { sessionId: 's-x', entryId: `e-exc-${i}`, eventType: 'user', capturedAt: at });
      seedMemory(`mem-bbbbbbb${(i % 10)}-0000-0000-0000-${String(i).padStart(12, '0')}`, scope,
        [content(`lane排除占位${i}`)], { sourceIds: [sid] });
      db.prepare('INSERT INTO source_exclusions (exclusion_id,source_id,created_at) VALUES (?,?,?)').run(`exc-${i}`, sid, at);
    }
    seedMemory('mem-bbbbkeep-0000-0000-0000-000000000000', scope, [content('lane排除有效条目')]);
    const r = await q(scope, 'lane排除', { limit: 1 });
    check('source-exclusion-lane-cutoff', r.hits.length === 1 && r.hits[0].content.conclusion === 'lane排除有效条目',
      `hits=${JSON.stringify(r.hits.map(h => h.content.conclusion))}`);
  }

  // ── 场景3：准确 ID 边界（Q2）
  {
    const scope = { projectId: 'exact-proj' };
    const otherScope = { projectId: 'other-proj' };
    seedMemory('mem-ccccccc1-0000-0000-0000-000000000001', scope, [content('纯ID正文不含自身')]);
    // 纯 ID 召回（正文不含 ID）
    const pure = await q(scope, 'mem-ccccccc1-0000-0000-0000-000000000001');
    check('exact-id-pure', pure.hits.length === 1 && pure.hits[0].memoryId === 'mem-ccccccc1-0000-0000-0000-000000000001' && pure.hits[0].relevance === 1,
      `hits=${JSON.stringify(pure.hits.map(h => [h.memoryId, h.relevance]))}`);
    // 混合查询置顶
    seedMemory('mem-ccccccc2-0000-0000-0000-000000000002', scope, [content('混合其他结论含 混合词')]);
    const mixed = await q(scope, 'mem-ccccccc1-0000-0000-0000-000000000001 混合词', { limit: 5 });
    check('exact-id-mixed-top', mixed.hits[0]?.memoryId === 'mem-ccccccc1-0000-0000-0000-000000000001',
      `first=${mixed.hits[0]?.memoryId}`);
    // 停用条目 ID 不绕过状态
    seedMemory('mem-ccccccc3-0000-0000-0000-000000000003', scope, [content('停用定点')], { usageState: 'stopped' });
    const stopped = await q(scope, 'mem-ccccccc3-0000-0000-0000-000000000003');
    check('exact-id-stopped-empty', stopped.hits.length === 0, `hits=${stopped.hits.length}`);
    // 跨项目 ID 不命中
    seedMemory('mem-ccccccc4-0000-0000-0000-000000000004', otherScope, [content('别项目定点')]);
    const cross = await q(scope, 'mem-ccccccc4-0000-0000-0000-000000000004');
    check('exact-id-cross-project-empty', cross.hits.length === 0, `hits=${cross.hits.length}`);
  }

  // ── 场景4：分支语义（Q5）
  {
    const proj = 'branch-proj';
    // 无受限标记的 branch=feature-a 记忆：feature-b 查询仍命中（项目共享）
    seedMemory('mem-ddddddd1-0000-0000-0000-000000000001',
      { projectId: proj, branch: 'feature-a', executionRoot: 'd:/w/a' }, [content('共享项目决定无标记')]);
    const shared = await q({ projectId: proj, branch: 'feature-b', executionRoot: 'd:/w/b' }, '共享项目决定');
    check('branch-unrestricted-shared', shared.hits.length === 1, `hits=${shared.hits.length}`);
    // conditions 明示 feature-a → feature-b 剔除、feature-a 命中、无 branch 命中
    seedMemory('mem-ddddddd2-0000-0000-0000-000000000002',
      { projectId: proj, branch: 'feature-a', executionRoot: 'd:/w/a' },
      [content('受限条目结论', { conditions: '仅适用 feature-a 分支' })]);
    const diff = await q({ projectId: proj, branch: 'feature-b', executionRoot: 'd:/w/b' }, '受限条目');
    const same = await q({ projectId: proj, branch: 'feature-a', executionRoot: 'd:/w/a' }, '受限条目');
    const generic = await q({ projectId: proj }, '受限条目');
    check('branch-scoped-diff-excluded', diff.hits.length === 0, `hits=${diff.hits.length}`);
    check('branch-scoped-same-hit', same.hits.length === 1, `hits=${same.hits.length}`);
    check('branch-scoped-generic-hit', generic.hits.length === 1, `hits=${generic.hits.length}`);
    // 边界：conditions 提「分支」但无分支名 → 不算受限，feature-b 仍命中
    seedMemory('mem-ddddddd3-0000-0000-0000-000000000003',
      { projectId: proj, branch: 'feature-a', executionRoot: 'd:/w/a' },
      [content('注意分支差异提醒', { conditions: '注意分支差异' })]);
    const noName = await q({ projectId: proj, branch: 'feature-b', executionRoot: 'd:/w/b' }, '分支差异');
    check('branch-keyword-no-name-not-scoped', noName.hits.length === 1, `hits=${noName.hits.length}`);
  }

  // ── 场景5：向量范围下推 + history 下推（Q7 + revisionColumn）
  {
    const scope = { projectId: 'vec-proj' };
    const otherScope = { projectId: 'vec-other' };
    seedMemory('mem-eeeeeee1-0000-0000-0000-000000000001', scope, [content('范围内向量')]);
    seedMemory('mem-eeeeeee2-0000-0000-0000-000000000002', otherScope, [content('范围外向量')]);
    seedMemory('mem-eeeeeee3-0000-0000-0000-000000000003', scope, [content('范围内旧rev', {}), content('范围内当前rev')]);
    seedMemory('mem-eeeeeee4-0000-0000-0000-000000000004', scope, [content('停用向量')], { usageState: 'stopped' });
    putVec('mem-eeeeeee1-0000-0000-0000-000000000001', 1, [1, 0]);
    putVec('mem-eeeeeee2-0000-0000-0000-000000000002', 1, [1, 0]);
    putVec('mem-eeeeeee3-0000-0000-0000-000000000003', 1, [0.9, 0.44]);
    putVec('mem-eeeeeee3-0000-0000-0000-000000000003', 2, [0.9, 0.44]);
    putVec('mem-eeeeeee4-0000-0000-0000-000000000004', 1, [1, 0]);
    // 下推后只读范围内 active 当前修订：ee1 rev1 + ee3 rev2（当前）；ee2 他项目、ee4 stopped、ee3 rev1 旧修订不进。
    const unfiltered = readMemoryVectors(db, 'fixture', 2);
    const scoped = readMemoryVectors(db, 'fixture', 2,
      { where: currentScopeFilter(scope).where + ' AND v.revision = m.current_revision', params: currentScopeFilter(scope).params });
    check('vector-pushdown-rows',
      unfiltered.length === 5 && scoped.length === 2 &&
        scoped.every(v => v.memoryId !== 'mem-eeeeeee2-0000-0000-0000-000000000002') &&
        scoped.every(v => v.memoryId !== 'mem-eeeeeee4-0000-0000-0000-000000000004') &&
        !scoped.some(v => v.memoryId === 'mem-eeeeeee3-0000-0000-0000-000000000003' && v.revision === 1),
      `unfiltered=${unfiltered.length} scoped=${JSON.stringify(scoped.map(v => [v.memoryId, v.revision]))}`);
    // 端到端：语义路只命中范围内当前修订（ee1、ee3-rev2），范围外不进结果。
    const r = await qv(scope, '无语面交集', [1, 0]);
    check('vector-pushdown-search',
      r.hits.length === 2 && r.hits.every(h => h.memoryId !== 'mem-eeeeeee2-0000-0000-0000-000000000002' && h.memoryId !== 'mem-eeeeeee4-0000-0000-0000-000000000004'),
      `hits=${JSON.stringify(r.hits.map(h => [h.memoryId, h.revision]))}`);
    // history superseded 下推：向量路 rev1（旧）可读，rev2（当前）被排除
    const { historyScopeFilter } = await import('../../../PAO/packages/coding-agent/src/pao/memory/scope.ts');
    const sup = readMemoryVectors(db, 'fixture', 2, historyScopeFilter(scope, undefined, 'superseded', 'v.revision'));
    check('vector-history-superseded-pushdown', sup.length === 1 && sup[0].memoryId === 'mem-eeeeeee3-0000-0000-0000-000000000003' && sup[0].revision === 1,
      `sup=${JSON.stringify(sup.map(v => [v.memoryId, v.revision]))}`);
  }
} finally {
  store.close();
}
const report = { kind: 'O04 独立复核·反面场景', home, total: results.length, passed: results.filter(r => r.passed).length, results };
writeFileSync(join(outputDir, 'o04-independent-review.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
