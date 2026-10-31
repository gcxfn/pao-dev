// 仅测试激活器接线；假 ExtensionAPI 不代表真实模型或完整宿主装配。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import activate from '../organized-post/activate-tools.mjs';

const coordination = ['pao_start_flow', 'pao_query_flow', 'pao_push_flow', 'pao_control_node', 'pao_decision_pack', 'pao_ack_supervision'];
const minister = ['pao_minister_save_node_map', 'pao_minister_submit_cards', 'pao_minister_review_worker', 'pao_minister_rework_cards', 'pao_breakdown_done', 'pao_submit_decision', 'pao_request_ruling', 'pao_ack_supervision'];

for (const role of ['主控', 'minister', 'worker']) {
  test(`激活器记录 ${role} 实际进程身份并保留角色边界`, () => {
    const parent = process.env.PAO_HOME;
    if (!parent || !isAbsolute(parent)) throw new Error('测试须显式设置隔离 PAO_HOME');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'activation-'));
    const previousRole = process.env.PAO_ROLE;
    const previousLog = process.env.PAO_BENCH_ORG_ACTIVATION_LOG;
    process.env.PAO_ROLE = role;
    process.env.PAO_BENCH_ORG_ACTIVATION_LOG = join(root, 'activation.jsonl');
    try {
      const all = [...new Set(['bash', 'read', 'pao_submit_receipt', 'pao_save_dispatch_recon', 'pao_inventory', 'pao_worktree_list', ...coordination, ...minister])];
      const initial = role === 'worker' ? ['read', 'pao_submit_receipt', 'pao_save_dispatch_recon'] : all;
      let active = [...initial];
      const handlers = new Map();
      activate({
        on: (name, handler) => handlers.set(name, handler),
        getAllTools: () => all.map(name => ({ name })),
        getActiveTools: () => [...active],
        setActiveTools: names => { active = [...names]; },
      });
      handlers.get('session_start')({}, { sessionManager: { getSessionId: () => `fixture-${role}` } });
      const proof = JSON.parse(readFileSync(process.env.PAO_BENCH_ORG_ACTIVATION_LOG, 'utf8'));
      assert.equal(proof.pid, process.pid);
      assert.equal(proof.parent_pid, process.ppid);
      assert.equal(proof.session_id, `fixture-${role}`);
      assert.deepEqual(proof.active, active);
      assert.equal(proof.worktree_host_installed, true);
      if (role === 'worker') {
        assert.deepEqual(active, initial);
        assert.deepEqual(proof.required_registered, ['pao_submit_receipt']);
        assert.equal(handlers.has('before_agent_start'), false);
      } else if (role === '主控') {
        assert.equal(proof.role, 'main');
        assert.deepEqual(active, [...coordination, 'pao_inventory']);
        assert.equal(active.includes('bash'), false);
      } else {
        assert.ok(minister.every(name => active.includes(name)));
      }
    } finally {
      if (previousRole === undefined) delete process.env.PAO_ROLE; else process.env.PAO_ROLE = previousRole;
      if (previousLog === undefined) delete process.env.PAO_BENCH_ORG_ACTIVATION_LOG; else process.env.PAO_BENCH_ORG_ACTIVATION_LOG = previousLog;
      rmSync(root, { recursive: true, force: true });
    }
  });
}
