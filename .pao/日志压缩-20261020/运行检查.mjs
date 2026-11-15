// 用途：执行日志优化定向验收；输入：标签、工作目录、命令；输出：checks/日志和退出状态。
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const [label, cwd, executable, ...args] = process.argv.slice(2);
if (!label || !cwd || !executable) throw new Error('缺少检查命令');
const output = join(dirname(fileURLToPath(import.meta.url)), 'checks');
const fixtureRoot = 'D:/AI/workspace/临时文件夹/日志压缩验收-20261020';
mkdirSync(output, { recursive: true });
mkdirSync(fixtureRoot, { recursive: true });
const child = spawn(executable, args, {
  cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, TEMP: fixtureRoot, TMP: fixtureRoot, PAO_HOME: join(fixtureRoot, 'home'),
    PI_OFFLINE: '1', PI_NO_LOCAL_LLM: '1', PI_APP_REAL_AUTH: '0', PI_APP_TEST_MODE: 'background' },
});
let stdout = '', stderr = '';
child.stdout.on('data', data => { stdout += data; process.stdout.write(data); });
child.stderr.on('data', data => { stderr += data; process.stderr.write(data); });
child.on('error', error => { stderr += String(error); });
child.on('close', (code, signal) => {
  writeFileSync(join(output, `${label}.stdout.txt`), stdout);
  writeFileSync(join(output, `${label}.stderr.txt`), stderr);
  writeFileSync(join(output, `${label}.json`), JSON.stringify({ cwd, executable, args, code, signal }, null, 2));
  process.exitCode = code ?? 1;
});
