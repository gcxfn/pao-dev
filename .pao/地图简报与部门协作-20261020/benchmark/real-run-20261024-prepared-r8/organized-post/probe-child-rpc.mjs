// 用途：真实启动子角色CLI/RPC并核对身份、宿主与父控制通道；仅get_state，不调用模型。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const [output] = process.argv.slice(2);
mkdirSync(output, { recursive: true });
const proofs = [];
for (const role of ['main', 'minister', 'worker']) {
  const session = randomUUID();
  const activation = join(output, role + '-activation.jsonl');
  const child = spawn(process.execPath,
    [fileURLToPath(new URL('./benchmark-child-entry.mjs', import.meta.url)), '--mode', 'rpc',
      '--session-dir', join(output, role + '-sessions'), '--session-id', session], {
      cwd: '/app', stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, PAO_ROLE: role, PAO_DEPT: '侦察', PAO_MANAGED_PARENT: '1',
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
    const stopped = new Promise(resolve => child.once('close', resolve));
    child.kill('SIGTERM');
    await stopped;
  }
}
writeFileSync(join(output, 'child-rpc-probe.json'), JSON.stringify({ model_calls: 0,
  kind: '真实CLI子进程/RPC/IPC，无模型作答', proofs }, null, 2));
console.log('三角色真实子进程RPC预检通过，模型调用0');
