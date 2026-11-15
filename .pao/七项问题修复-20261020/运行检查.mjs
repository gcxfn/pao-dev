// 用途：执行本轮定向验收并留证；输入：标签、工作目录、可执行文件及参数；输出：checks/日志与退出状态。
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const [label, cwd, executable, ...args] = process.argv.slice(2);
if (!label || !cwd || !executable || !/^[a-z0-9-]+$/.test(label)) throw new Error('需要标签、工作目录和可执行命令');
const output = join(dirname(fileURLToPath(import.meta.url)), 'checks');
const isolatedHome = 'D:/AI/workspace/临时文件夹/七项修复验收-20261020/PAO_HOME';
mkdirSync(output, { recursive: true });
mkdirSync(isolatedHome, { recursive: true });
const startedAt = new Date().toISOString();
const child = spawn(executable, args, {
  cwd,
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
  writeFileSync(join(output, `${label}.json`), JSON.stringify({ label, cwd, executable, args, startedAt, finishedAt: new Date().toISOString(), code, signal }, null, 2));
  process.exitCode = code ?? 1;
});
