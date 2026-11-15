// 用途：真实 SDK 离线装配主控/部长/worker，核对组织、地图、审核、监督工具；不启动模型或 RPC。
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [source, agentDir, output, role] = process.argv.slice(2);
const cwd = join(output, 'project');
const cardsDir = join(cwd, '.pao/benchmark/卡');
mkdirSync(cardsDir, { recursive: true });
process.env.PI_OFFLINE = '1';
process.env.PI_SKIP_VERSION_CHECK = '1';
process.env.PAO_ROLE = role;
process.env.PI_CODING_AGENT_DIR = process.env.PAO_CODING_AGENT_DIR = agentDir;
process.env.PAO_BENCH_ORG_ACTIVATION_LOG = join(output, 'activation.jsonl');
const paoHome = process.env.PAO_HOME;
if (role === 'minister' && !paoHome) throw new Error('部长预检缺少隔离 PAO_HOME');
const loadPao = (file) => import(pathToFileURL(join(source, 'packages/coding-agent/dist/pao', file)).href);
const { loadRecipe } = await loadPao('workflow/recipe.js');
const { startControl, readControl } = await loadPao('workflow/control.js');
const recipe = loadRecipe(paoHome, '基准开发流水线');
const owner = 'offline-owner';
if (role === 'minister') {
  await startControl(recipe, { 任务: '离线夹具，仅核对真实部长工具面，不执行任务' }, {
    cardsDir, workspaceDir: cwd, ownerSessionId: owner,
  });
  const flow = readControl(recipe, { cardsDir, workspaceDir: cwd });
  process.env.PAO_WORKFLOW_MINISTER = JSON.stringify({
    名字: recipe.名字, 实例: flow.实例, 节点: '侦察', 轮次: 1,
    owner, cardsDir, workspaceDir: cwd,
  });
}
globalThis.fetch = async () => { throw new Error('离线工具装载禁止网络请求'); };
const load = (file) => import(pathToFileURL(join(source, 'packages/coding-agent/dist', file)).href);
const { SettingsManager } = await load('core/settings-manager.js');
const { SessionManager } = await load('core/session-manager.js');
const { createAgentSessionServices, createAgentSessionFromServices } = await load('core/agent-session-services.js');
const { createAgentSessionRuntime } = await load('core/agent-session-runtime.js');
const { createOrganized } = await import('./benchmark-organized-entry.mjs');
const { runtime, host } = await createOrganized({source,cwd,agentDir,probe:true});

try {
  await runtime.session.bindExtensions({ mode: 'json', onError: (error) => { throw new Error(JSON.stringify(error)); } });
  const active = runtime.session.getActiveToolNames();
  const required = role === 'minister'
    ? [
        'pao_minister_submit_cards',
        'pao_minister_save_node_map',
        'pao_minister_review_worker',
        'pao_minister_rework_cards',
        'pao_breakdown_done',
        'pao_submit_decision',
        'pao_ack_supervision',
      ]
    : role === 'worker'
      ? ['read', 'bash', 'edit', 'write']
      : [
          'pao_start_flow',
          'pao_query_flow',
          'pao_push_flow',
          'pao_ack_supervision',
        ];
  assert(required.every((name) => active.includes(name)), JSON.stringify({ role, active, required }));
  if (role === 'worker') {
    const recursive = [
      'pao_start_flow',
      'pao_push_flow',
      'pao_dispatch_card',
      'pao_fanout',
      'pao_spawn_minister',
      'pao_collab_relay',
      'pao_minister_submit_cards',
      'pao_minister_save_node_map',
      'pao_minister_review_worker',
    ];
    assert(recursive.every((name) => !active.includes(name)), JSON.stringify({ role, active, recursive }));
  } else {
    const activation = JSON.parse(readFileSync(process.env.PAO_BENCH_ORG_ACTIVATION_LOG, 'utf8')
      .trim().split('\n').at(-1));
    assert.equal(activation.role, role);
    assert(required.every((name) => activation.activated.includes(name)), JSON.stringify(activation));
  }
  if (role === 'minister') {
    for (const name of ['read', 'grep', 'find', 'ls']) {
      assert(runtime.session.getToolDefinition(name), '部长缺少只读工具：' + name);
    }
    for (const name of ['bash', 'edit', 'write', 'powershell']) {
      if (!runtime.session.getToolDefinition(name)) continue;
      const verdict = await runtime.session._extensionRunner.emitToolCall({
        type: 'tool_call', toolName: name, toolCallId: 'offline-block-' + name, input: {},
      });
      assert.equal(verdict?.block, true, '部长工具未被真实 tool_call 门禁拦截：' + name);
    }
  }
  const result = { ok: true, role, active, required,
    kind: '真实 SDK 装载；部长使用模拟身份；无模型、无 RPC、无题目执行' };
  writeFileSync(join(output, 'probe-' + role + '.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await runtime.dispose();
}
