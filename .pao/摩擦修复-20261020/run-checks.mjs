// 用途：运行本轮定向检查并留证；输入：检查名和命令参数；输出：checks/ 下日志与退出结果。
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [label, executable, ...args] = process.argv.slice(2);
if (!label || !executable || !/^[a-z0-9-]+$/.test(label)) throw new Error('需要检查名和可执行命令');
const root = 'D:/AI/workspace/pao-dev';
const output = join(root, '.pao/摩擦修复-20261020/checks');
const isolatedHome = join(root, '.pao/摩擦修复-20261020/test-home');
mkdirSync(output, { recursive: true });
mkdirSync(isolatedHome, { recursive: true });
const startedAt = new Date().toISOString();
const child = spawn(executable, args, {
  cwd: join(root, 'PAO/packages/coding-agent'),
  env: { ...process.env, PI_OFFLINE: '1', PI_NO_LOCAL_LLM: '1', PAO_HOME: isolatedHome },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '', stderr = '';
child.stdout.on('data', data => { stdout += data; process.stdout.write(data); });
child.stderr.on('data', data => { stderr += data; process.stderr.write(data); });
child.on('error', error => { stderr += String(error); process.stderr.write(String(error)); });
child.on('close', (code, signal) => {
  writeFileSync(join(output, `${label}.stdout.txt`), stdout);
  writeFileSync(join(output, `${label}.stderr.txt`), stderr);
  writeFileSync(join(output, `${label}.json`), JSON.stringify({ label, executable, args, startedAt, finishedAt: new Date().toISOString(), code, signal }, null, 2));
  process.exitCode = code ?? 1;
});
