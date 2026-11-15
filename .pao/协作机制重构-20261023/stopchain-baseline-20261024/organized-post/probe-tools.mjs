// 用途：真实 SDK 离线装配主控/部长/worker，核对组织工具；模拟部长身份，不启动模型或 RPC。
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [source, agentDir, output, role] = process.argv.slice(2);
const cwd = join(output, 'project');
mkdirSync(cwd, { recursive: true });
process.env.PI_OFFLINE = '1';
process.env.PI_SKIP_VERSION_CHECK = '1';
process.env.PAO_ROLE = role;
process.env.PI_CODING_AGENT_DIR = process.env.PAO_CODING_AGENT_DIR = agentDir;
process.env.PAO_BENCH_ORG_ACTIVATION_LOG = join(output, 'activation.jsonl');
if (role === 'minister') process.env.PAO_WORKFLOW_MINISTER = JSON.stringify({
  名字: '基准开发流水线', 实例: 'offline-fixture', 节点: '侦察', 轮次: 1,
  owner: 'offline-owner', cardsDir: join(cwd, '.pao/卡') });
globalThis.fetch = async () => { throw new Error('离线工具装载禁止网络请求'); };
const load = (file) => import(pathToFileURL(join(source, 'packages/coding-agent/dist', file)).href);
const { SettingsManager } = await load('core/settings-manager.js');
const { SessionManager } = await load('core/session-manager.js');
const { createAgentSessionServices, createAgentSessionFromServices } = await load('core/agent-session-services.js');
const { createAgentSessionRuntime } = await load('core/agent-session-runtime.js');
const { builtInExtensions } = await load('extensions/index.js');
const runtime = await createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd, agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir),
    resourceLoaderOptions: { extensionFactories: builtInExtensions } });
  const errors = services.diagnostics.filter((d) => d.type === 'error');
  assert.equal(errors.length, 0, JSON.stringify(errors));
  const session = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, thinkingLevel: 'high' });
  return { ...session, services, diagnostics: services.diagnostics };
}, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
try {
  await runtime.session.bindExtensions({ mode: 'json', onError: (error) => { throw new Error(JSON.stringify(error)); } });
  const active = runtime.session.getActiveToolNames();
  const required = role === 'minister' ? ['pao_minister_submit_cards', 'pao_breakdown_done', 'pao_submit_decision']
    : role === 'worker' ? ['read', 'bash', 'edit', 'write'] : ['pao_start_flow', 'pao_query_flow', 'pao_push_flow'];
  assert(required.every((name) => active.includes(name)), JSON.stringify({ role, active, required }));
  if (role === 'worker') assert(!active.includes('pao_start_flow') && !active.includes('pao_minister_submit_cards'));
  const result = { ok: true, role, active, kind: '真实 SDK 装载；部长使用模拟身份；无模型、无 RPC 执行' };
  writeFileSync(join(output, 'probe-' + role + '.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await runtime.dispose(); }
