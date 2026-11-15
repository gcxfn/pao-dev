// 用途：真实启动子角色CLI/RPC并核对身份、宿主与父控制通道；只调用get_state，不调用模型。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const ownerRequired = ['pao_change_status', 'pao_deliver_card', 'pao_control_node', 'pao_push_flow'];
const ownerForbidden = [
  'bash', 'edit', 'read', 'write', 'pao_worktree_create', 'pao_worktree_list', 'pao_worktree_cleanup',
  'pao_spawn_minister',
  'pao_minister_rework_cards', 'pao_minister_review_worker', 'pao_verify_card',
];
const ministerForbidden = [
  'pao_change_status', 'pao_deliver_card', 'pao_start_flow', 'pao_push_flow',
  'pao_control_node', 'pao_spawn_minister', 'pao_verify_card',
];
const workerForbidden = [
  'pao_change_status', 'pao_deliver_card', 'pao_minister_rework_cards',
  'pao_minister_review_worker', 'pao_start_flow', 'pao_push_flow', 'pao_control_node',
  'pao_spawn_minister', 'pao_verify_card', 'pao_worktree_create', 'pao_worktree_list',
  'pao_worktree_cleanup',
];

export async function runActivationHooks(role, handlers, context) {
  const beforeAgentStart = handlers.filter(({ name }) => name === 'before_agent_start');
  if (role === 'worker') {
    assert.equal(beforeAgentStart.length, 0, 'worker 仍注册了主控/部长 before_agent_start 提示');
  } else {
    assert(beforeAgentStart.length > 0, role + ' 缺少 before_agent_start 职责提示');
  }
  const sessionStarts = handlers.filter(({ name }) => name === 'session_start');
  if (role === 'worker' && sessionStarts.length === 0) return 'not_registered';
  assert.equal(sessionStarts.length, 1, role + ' 激活器 session_start 注册数量异常');
  await sessionStarts[0].handler({}, context);
  return 'registered';
}

export function validateActivationProof(role, proof, sessionId) {
  assert(proof && typeof proof === 'object', role + ' 激活日志不是对象');
  assert.equal(proof.session_id, sessionId, '激活日志与真实RPC会话身份不一致');
  assert.equal(proof.role, role, '激活器角色与真实子进程角色不一致');
  assert(Array.isArray(proof.active), role + ' 激活日志缺少活动工具');
  if (role === 'main') {
    assert.equal(proof.worktree_host_installed, true, '真实子角色未安装工作树服务');
    for (const name of ownerRequired) assert(proof.active.includes(name), '主控缺少裁决与收口工具：' + name);
    assert(proof.required_registered?.includes('pao_change_status'), '主控没有注册 pao_change_status');
    assert(proof.required_registered?.includes('pao_deliver_card'), '主控没有注册 pao_deliver_card');
    assert(!ownerForbidden.some((name) => proof.active.includes(name)), '主控活动工具包含旁路能力');
  } else if (role === 'minister') {
    assert.equal(proof.worktree_host_installed, true, '真实部长未安装工作树服务');
    assert(proof.active.includes('pao_minister_rework_cards'), '部长缺少合法原卡返修入口');
    assert(!ministerForbidden.some((name) => proof.active.includes(name)), '部长活动工具包含 owner 或部长外能力');
  } else {
    assert(!workerForbidden.some((name) => proof.active.includes(name)), '工人活动工具包含 owner/部长能力');
  }
}

async function main(outputArg) {
  const output = outputArg;
  mkdirSync(output, { recursive: true });

  // 兼容两种合法 worker：完全不注册回调，或只注册审计日志而保持工具白名单。
  const previousRole = process.env.PAO_ROLE;
  const previousLog = process.env.PAO_BENCH_ORG_ACTIVATION_LOG;
  process.env.PAO_ROLE = 'worker';
  process.env.PAO_BENCH_ORG_ACTIVATION_LOG = join(output, 'worker-handler-activation.jsonl');
  try {
    const activationModule = pathToFileURL(
      fileURLToPath(new URL('./activate-tools.mjs', import.meta.url)),
    );
    activationModule.searchParams.set('worker-handler-check', String(Date.now()));
    const { default: activateTools } = await import(activationModule.href);
    const handlers = [];
    const fakePi = {
      getAllTools: () => [],
      getActiveTools: () => ['read', 'bash', 'edit', 'write'],
      setActiveTools: () => { throw new Error('worker 不应改写活动工具'); },
      on: (name, handler) => handlers.push({ name, handler }),
    };
    activateTools(fakePi);
    await runActivationHooks('worker', handlers, {
      sessionManager: { getSessionId: () => 'worker-handler-check' },
    });
  } finally {
    if (previousRole === undefined) delete process.env.PAO_ROLE;
    else process.env.PAO_ROLE = previousRole;
    if (previousLog === undefined) delete process.env.PAO_BENCH_ORG_ACTIVATION_LOG;
    else process.env.PAO_BENCH_ORG_ACTIVATION_LOG = previousLog;
  }

  // 交付入口必须真实存在且只做状态裁决；交卷继续复用独立的 pao_deliver_card。
  const source = process.env.PAO_BENCH_SOURCE;
  const deliveryPath = join(source, 'packages/coding-agent/dist/pao/cards/delivery.js');
  const cardToolsPath = join(source, 'packages/coding-agent/dist/pao/cards/tools.js');
  const { registerDeliveryTools } = await import(pathToFileURL(deliveryPath));
  const { registerCardTools } = await import(pathToFileURL(cardToolsPath));
  const cardHandlers = new Map();
  const deliveryHandlers = new Map();
  registerCardTools({
    registerTool: tool => cardHandlers.set(tool.name, tool),
  });
  registerDeliveryTools({
    registerTool: tool => deliveryHandlers.set(tool.name, tool),
  });
  assert(deliveryHandlers.has('pao_deliver_card'), '真实交卷模块未注册 pao_deliver_card');
  assert(!deliveryHandlers.has('pao_change_status'), '交卷模块不应注册状态裁决工具');
  assert(cardHandlers.has('pao_change_status'), '真实卡工具未注册 pao_change_status');
  assert(!cardHandlers.has('pao_deliver_card'), '状态裁决模块不应暗中承担交卷');

  const load = file => import(pathToFileURL(join(source, 'packages/coding-agent/dist/pao', file)));
  const { loadRecipe } = await load('workflow/recipe.js');
  const { startControl, readControl } = await load('workflow/control.js');
  const recipe = loadRecipe(process.env.PAO_HOME, '基准开发流水线');
  const fixture = join(output, 'minister-fixture');
  const cardsDir = join(fixture, '.pao/benchmark/卡');
  mkdirSync(cardsDir, { recursive: true });
  await startControl(recipe, { 任务: '离线子进程装配夹具，不执行公开任务' }, {
    cardsDir, workspaceDir: fixture, ownerSessionId: 'offline-child-probe',
  });
  const flow = readControl(recipe, { cardsDir, workspaceDir: fixture });
  const ministerContext = JSON.stringify({ 名字: recipe.名字, 实例: flow.实例,
    节点: '侦察', 轮次: 1, owner: flow.owner, cardsDir, workspaceDir: fixture });
  const proofs = [];
  for (const role of ['main', 'minister', 'worker']) {
    const session = randomUUID();
    const activation = join(output, role + '-activation.jsonl');
    const cwd = existsSync('/app') ? '/app' : fixture;
    const child = spawn(process.execPath,
      [fileURLToPath(new URL('./benchmark-child-entry.mjs', import.meta.url)), '--mode', 'rpc',
        '--session-dir', join(output, role + '-sessions'), '--session-id', session], {
        cwd, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, PAO_ROLE: role, PAO_DEPT: '侦察', PAO_MANAGED_PARENT: '1',
          ...(role === 'minister' ? { PAO_WORKFLOW_MINISTER: ministerContext } : {}),
          PI_OFFLINE: '1', PAO_BENCH_ORG_ACTIVATION_LOG: activation },
      });
    let stderr = '', buffer = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    try {
      const state = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('子角色RPC握手超时：' + role)), 30000);
        child.once('error', reject);
        child.once('exit', code => { clearTimeout(timer); reject(Error('子角色提前退出：' + role + '/' + code + '/' + stderr)); });
        child.stdout.on('data', chunk => {
          buffer += chunk.toString();
          let end;
          while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
            if (!line.trim()) continue;
            let row;
            try { row = JSON.parse(line); } catch (error) { clearTimeout(timer); reject(error); return; }
            if (row.type === 'extension_error') {
              clearTimeout(timer); reject(Error(JSON.stringify(row))); return;
            }
            if (row.type === 'response' && row.id === 'offline-state') {
              clearTimeout(timer);
              if (!row.success) reject(Error(JSON.stringify(row)));
              else resolve(row.data);
            }
          }
        });
        child.stdin.write(JSON.stringify({ type: 'get_state', id: 'offline-state' }) + '\n');
      });
      assert.equal(state.sessionId, session, '真实会话身份不一致');
      assert(child.connected, '缺少真实父控制IPC通道');
      assert(!stderr.includes('worktrees模块未启用'), stderr);
      const proofText = existsSync(activation) ? readFileSync(activation, 'utf8').trim() : '';
      let proof = null;
      let activationLog = 'registered';
      if (proofText) {
        proof = JSON.parse(proofText.split('\n').at(-1));
        validateActivationProof(role, proof, state.sessionId);
      } else if (role === 'worker') {
        activationLog = 'not_registered';
      } else {
        throw new Error(role + ' 激活器未写会话证明');
      }
      proofs.push({ role, session_id: session, rpc_get_state: 'passed', parent_ipc: true,
        activation_log: activationLog,
        active_tools: proof?.active ?? null,
        worktree_host: role === 'worker' ? 'worker角色不注册管理工具' : 'installed' });
    } finally {
      writeFileSync(join(output, role + '-stderr.log'), stderr);
      const stopped = new Promise(resolve => child.once('close', resolve));
      child.kill('SIGTERM');
      await stopped;
    }
  }
  writeFileSync(join(output, 'child-rpc-probe.json'), JSON.stringify({ model_calls: 0,
    kind: '真实CLI子进程/RPC/IPC，无模型作答', proofs }, null, 2));
  console.log('三角色真实子进程RPC预检通过：身份、活动工具权限与交卷收口能力均符合，模型调用0');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main(process.argv[2]);
}
