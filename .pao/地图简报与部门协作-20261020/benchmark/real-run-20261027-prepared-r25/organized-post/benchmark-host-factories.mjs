// 用途：基准所有角色共用可信宿主装配；不复制工作流、RPC、会话或工具权限规则。
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBenchmarkWorktreeHost } from './benchmark-worktree-host.mjs';

export async function createBenchmarkFactories(source, agentDir) {
  const load = file => import(pathToFileURL(join(source, 'packages/coding-agent/dist', file)));
  const [{ builtInExtensions }, { default: paoExtension }, locks, { MinisterHost }] = await Promise.all([
    load('extensions/index.js'), load('pao/index.js'), load('pao/worker/lock.js'),
    load('pao/host/host.js'),
  ]);
  const host = createBenchmarkWorktreeHost(join(agentDir, 'benchmark-worktrees'), locks);
  const processInvocation = args => ({ command: process.execPath,
    args: [fileURLToPath(new URL('./benchmark-child-entry.mjs', import.meta.url)), ...args] });
  const extensionFactories = builtInExtensions.map(extension => extension.name === 'pao'
    ? { ...extension, factory: pi => paoExtension(pi, {
      worktreeHost: host,
      processInvocation,
      host: new MinisterHost({ processInvocation, taskTimeoutMs: 30 * 60 * 1000 }),
    }) } : extension);
  return { extensionFactories, host, load };
}
