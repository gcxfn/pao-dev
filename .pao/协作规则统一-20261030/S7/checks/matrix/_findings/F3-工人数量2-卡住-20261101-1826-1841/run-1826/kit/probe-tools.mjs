// 用途：用正式产品 CLI 的 RPC/IPC 启动主控、部长和 worker，只查询 get_state 与工具装载证据。
// 输入：冻结源码根、隔离 agentDir、隔离 PAO_HOME、证据目录、项目目录；输出：三角色预检 JSON。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [sourceArg, agentDirArg, paoHomeArg, evidenceArg, projectArg] = process.argv.slice(2);
if (![sourceArg, agentDirArg, paoHomeArg, evidenceArg, projectArg].every(Boolean)) {
  throw new Error('用法：node probe-tools.mjs <源码根> <agentDir> <PAO_HOME> <证据目录> <项目目录>');
}

const source = resolve(sourceArg);
const agentDir = resolve(agentDirArg);
const paoHome = resolve(paoHomeArg);
const evidence = resolve(evidenceArg);
const project = resolve(projectArg);
const cli = join(source, 'packages/coding-agent/dist/bundle/cli.js');
const extension = join(agentDir, 'extensions/benchmark-organization.js');
assert(existsSync(cli), '正式产品 CLI 不存在：' + cli);
assert(existsSync(extension), '组织角色扩展不存在：' + extension);
mkdirSync(project, { recursive: true });
mkdirSync(evidence, { recursive: true });

const worktreeStateRoot = join(paoHome, 'worktree-host');
const roles = ['main', 'minister', 'worker'];
const expectedRegistered = {
  main: [
    'pao_start_flow',
    'pao_query_flow',
    'pao_push_flow',
    'pao_worktree_list',
  ],
  minister: [
    'pao_minister_save_node_map',
    'pao_minister_submit_cards',
    'pao_breakdown_done',
    'pao_worktree_list',
  ],
  worker: ['pao_submit_receipt'],
};

function ministerContext() {
  return JSON.stringify({
    名字: '基准开发流水线',
    实例: 'offline-cli-preflight',
    节点: '侦察',
    轮次: 1,
    owner: 'offline-cli-parent',
    cardsDir: join(project, '.pao/benchmark/卡'),
    workspaceDir: project,
  });
}

function readActivation(path, role, sessionId, childPid) {
  assert(existsSync(path), role + ' 未写真实会话启动证明');
  const rows = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim());
  assert(rows.length > 0, role + ' 会话启动证明为空');
  const proof = JSON.parse(rows.at(-1));
  assert.equal(proof.role, role);
  assert.equal(proof.session_id, sessionId);
  assert.equal(proof.pid, childPid, role + ' 激活证明 PID 与真实子进程不一致');
  assert.equal(proof.parent_pid, process.pid, role + ' 激活证明父进程不一致');
  assert.equal(proof.run_mode, 'unattended');
  assert.equal(proof.worktree_state_root, worktreeStateRoot);
  assert.equal(proof.pao_home, paoHome);
  assert.equal(proof.agent_dir, agentDir);
  assert(Array.isArray(proof.registered));
  assert(Array.isArray(proof.active));
  for (const name of expectedRegistered[role]) {
    assert(proof.registered.includes(name), role + ' 缺少已注册工具：' + name);
  }
  if (role === 'worker') {
    assert(!proof.registered.includes('pao_worktree_list'), 'worker 不得注册工作树管理工具');
  } else {
    assert(proof.registered.includes('pao_worktree_list'), role + ' 缺少工作树管理工具');
  }
  return proof;
}

function settleChild(child, timeoutMs) {
  return new Promise((resolveExit) => {
    if (child.exitCode !== null) {
      resolveExit({ code: child.exitCode, timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolveExit({ code: null, timedOut: true });
    }, timeoutMs);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolveExit({ code, timedOut: false });
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolveExit({ code: null, timedOut: false });
    });
  });
}

async function probeRole(role) {
  const output = join(evidence, 'role-cli', role);
  mkdirSync(output, { recursive: true });
  const sessionDir = join(output, 'sessions');
  const activationPath = join(output, 'activation.jsonl');
  const sessionId = 'benchmark-preflight-' + role + '-' + randomUUID();
  const env = {
    ...process.env,
    PAO_ROLE: role,
    ...(role === 'minister' || role === 'worker' ? { PAO_DEPT: '侦察' } : {}),
    PAO_HOME: paoHome,
    PI_CODING_AGENT_DIR: agentDir,
    PAO_CODING_AGENT_DIR: agentDir,
    PAO_RUN_MODE: 'unattended',
    PAO_WORKTREE_STATE_ROOT: worktreeStateRoot,
    PAO_MANAGED_PARENT: '1',
    PAO_BENCH_ORG_ACTIVATION_LOG: activationPath,
    ...(role === 'minister' ? { PAO_WORKFLOW_MINISTER: ministerContext() } : {}),
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
  };
  const child = spawn(process.execPath, [
    cli,
    '--offline',
    '--mode',
    'rpc',
    '--session-dir',
    sessionDir,
    '--session-id',
    sessionId,
    '--name',
    'benchmark-preflight-' + role,
  ], {
    cwd: project,
    env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const state = await new Promise((resolveState, rejectState) => {
    let buffer = '';
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(rejectState, new Error(role + ' 产品 CLI RPC 握手超时'));
    }, 30000);
    child.once('error', (error) => finish(rejectState, error));
    child.once('exit', (code) => {
      if (!settled) {
        finish(
          rejectState,
          new Error(role + ' 产品 CLI 提前退出：' + code + '\n' + stderr),
        );
      }
    });
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      stdout += chunk.toString();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, '');
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch (error) {
          finish(rejectState, new Error(role + ' RPC 输出不是严格 JSONL：' + error.message));
          return;
        }
        if (record.type === 'extension_error') {
          finish(rejectState, new Error(role + ' 扩展装载失败：' + JSON.stringify(record)));
          return;
        }
        if (record.type === 'response' && record.id === 'offline-state') {
          if (!record.success) {
            finish(rejectState, new Error(role + ' get_state 失败：' + JSON.stringify(record)));
          } else {
            finish(resolveState, record.data);
          }
        }
      }
    });
    child.stdin.write(JSON.stringify({ type: 'get_state', id: 'offline-state' }) + '\n');
  });

  try {
    assert.equal(state.sessionId, sessionId, role + ' get_state 会话身份不一致');
    assert.equal(state.isStreaming, false, role + ' 预检意外进入模型流式状态');
    assert.equal(child.connected, true, role + ' 缺少真实父控制 IPC');
    const proof = readActivation(
      activationPath,
      role,
      state.sessionId,
      child.pid,
    );
    const result = {
      ok: true,
      role,
      pid: child.pid,
      session_id: state.sessionId,
      rpc_get_state: 'passed',
      parent_ipc: child.connected,
      model_calls: 0,
      message_count: state.messageCount,
      pao_run_mode: proof.run_mode,
      pao_home: proof.pao_home,
      agent_dir: proof.agent_dir,
      worktree_state_root: proof.worktree_state_root,
      pao_worktree_list: proof.registered.includes('pao_worktree_list'),
      active_tools: proof.active,
      registered_tools: proof.registered,
      required_registered: proof.required_registered,
      cli,
    };
    writeFileSync(
      join(output, 'probe-' + role + '.json'),
      JSON.stringify(result, null, 2) + '\n',
    );
    return result;
  } finally {
    writeFileSync(join(output, 'stdout.log'), stdout);
    writeFileSync(join(output, 'stderr.log'), stderr);
    child.stdin.end();
    const settled = await settleChild(child, 5000);
    if (settled.timedOut) {
      throw new Error(role + ' 产品 CLI 未在 5 秒内正常关闭\n' + stderr);
    }
    if (settled.code !== 0) {
      throw new Error(role + ' 产品 CLI 正常关闭失败：' + settled.code + '\n' + stderr);
    }
  }
}

const proofs = [];
let firstError;
for (const role of roles) {
  try {
    proofs.push(await probeRole(role));
  } catch (error) {
    firstError = error;
    break;
  }
}

if (firstError) {
  writeFileSync(
    join(evidence, 'role-cli-preflight.json'),
    JSON.stringify({
      ok: false,
      model_calls: 0,
      error: String(firstError?.stack || firstError),
      completed_roles: proofs.map((proof) => proof.role),
    }, null, 2) + '\n',
  );
  throw firstError;
}

const result = {
  ok: true,
  kind: '正式产品 CLI 子进程/RPC/IPC；仅 get_state，无 prompt，无模型调用',
  model_calls: 0,
  cli,
  roles: proofs,
};
writeFileSync(
  join(evidence, 'role-cli-preflight.json'),
  JSON.stringify(result, null, 2) + '\n',
);
console.log(JSON.stringify(result));
