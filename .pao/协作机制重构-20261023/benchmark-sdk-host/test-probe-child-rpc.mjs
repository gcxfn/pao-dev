// 用途：定向验证 worker 无回调与仅审计回调两种合法激活方式，并核对角色证明边界；无模型。
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  runActivationHooks,
  validateActivationProof,
} from './probe-child-rpc.mjs';

const root = mkdtempSync(join(tmpdir(), 'pao-child-rpc-contract-'));
const frozenActivation = process.env.PAO_FROZEN_R17_ACTIVATE;

async function loadHandlers(modulePath, role) {
  const previousRole = process.env.PAO_ROLE;
  const previousLog = process.env.PAO_BENCH_ORG_ACTIVATION_LOG;
  const log = join(root, role + '-' + Math.random() + '.jsonl');
  process.env.PAO_ROLE = role;
  process.env.PAO_BENCH_ORG_ACTIVATION_LOG = log;
  const url = pathToFileURL(modulePath);
  url.searchParams.set('test', role + '-' + Math.random());
  const { default: activateTools } = await import(url.href);
  const handlers = [];
  activateTools({
    getAllTools: () => [
      ...tenantOwner,
      ...minister,
    ].map(name => ({ name })),
    getActiveTools: () => ['read', 'bash', 'edit', 'write'],
    setActiveTools: () => {},
    on: (name, handler) => handlers.push({ name, handler }),
  });
  const restore = () => {
    if (previousRole === undefined) delete process.env.PAO_ROLE;
    else process.env.PAO_ROLE = previousRole;
    if (previousLog === undefined) delete process.env.PAO_BENCH_ORG_ACTIVATION_LOG;
    else process.env.PAO_BENCH_ORG_ACTIVATION_LOG = previousLog;
  };
  return { handlers, log, restore };
}

const tenantOwner = [
  'pao_start_flow', 'pao_query_flow', 'pao_push_flow', 'pao_control_node',
  'pao_decision_pack', 'pao_change_status', 'pao_deliver_card', 'pao_ack_supervision',
];
const minister = [
  'pao_minister_save_node_map', 'pao_minister_submit_cards', 'pao_minister_review_worker',
  'pao_minister_rework_cards', 'pao_breakdown_done', 'pao_submit_decision',
  'pao_request_ruling', 'pao_ack_supervision',
];

try {
  assert.ok(frozenActivation, '缺少 PAO_FROZEN_R17_ACTIVATE，无法验证真实历史激活器');
  const context = {
    sessionManager: { getSessionId: () => 'offline-session' },
  };

  const currentWorker = await loadHandlers(
    fileURLToPath(new URL('./activate-tools.mjs', import.meta.url)),
    'worker',
  );
  assert.equal(
    await runActivationHooks('worker', currentWorker.handlers, context),
    'registered',
    '当前 worker 审计回调应允许执行',
  );
  assert.match(readFileSync(currentWorker.log, 'utf8'), /"role":"worker"/);
  currentWorker.restore();

  const frozenWorker = await loadHandlers(frozenActivation, 'worker');
  assert.equal(
    await runActivationHooks('worker', frozenWorker.handlers, context),
    'not_registered',
    'r17 冻结 worker 无回调应合法通过',
  );
  frozenWorker.restore();

  await assert.rejects(
    runActivationHooks('worker', [{ name: 'before_agent_start', handler() {} }], context),
    /worker 仍注册了主控\/部长 before_agent_start 提示/,
  );
  await assert.rejects(
    runActivationHooks('main', [], context),
    /main 缺少 before_agent_start 职责提示/,
  );

  validateActivationProof('main', {
    role: 'main',
    session_id: 'offline-session',
    active: tenantOwner,
    required_registered: tenantOwner,
    worktree_host_installed: true,
  }, 'offline-session');
  validateActivationProof('worker', {
    role: 'worker',
    session_id: 'offline-session',
    active: ['read', 'bash', 'edit', 'write'],
  }, 'offline-session');
  assert.throws(
    () => validateActivationProof('worker', {
      role: 'worker',
      session_id: 'offline-session',
      active: ['pao_change_status'],
    }, 'offline-session'),
    /工人活动工具包含 owner\/部长能力/,
  );
  assert.throws(
    () => validateActivationProof('minister', {
      role: 'minister',
      session_id: 'different-session',
      active: minister,
      worktree_host_installed: true,
    }, 'offline-session'),
    /激活日志与真实RPC会话身份不一致/,
  );

  writeFileSync(join(root, 'result.json'), JSON.stringify({
    ok: true,
    current_worker: 'registered',
    frozen_r17_worker: 'not_registered',
    cases: 7,
  }, null, 2));
  console.log('child RPC 探针定向契约测试通过：7 项，模型调用 0');
} finally {
  rmSync(root, { recursive: true, force: true });
}

