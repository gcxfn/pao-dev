// 用途：真实启动子角色CLI/RPC并核对身份、宿主与父控制通道；仅get_state，不调用模型。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const [output] = process.argv.slice(2);
mkdirSync(output, { recursive: true });
const source = process.env.PAO_BENCH_SOURCE;
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
  const child = spawn(process.execPath,
    [fileURLToPath(new URL('./benchmark-child-entry.mjs', import.meta.url)), '--mode', 'rpc',
      '--session-dir', join(output, role + '-sessions'), '--session-id', session], {
      cwd: role === 'minister' ? fixture : '/app', stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
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
    if (role !== 'worker') {
      const proof = JSON.parse(readFileSync(activation, 'utf8').trim().split('\n').at(-1));
      assert.equal(proof.worktree_host_installed, true, '真实子角色未安装工作树服务');
      if (role === 'main') assert(!proof.active.includes('pao_spawn_minister') && !proof.active.includes('bash'));
    }
    proofs.push({ role, session_id: session, rpc_get_state: 'passed', parent_ipc: true,
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
console.log('三角色真实子进程RPC预检通过，模型调用0');
