// 用途：只检查本轮变动的 TypeScript 文件；输入：本轮文件清单；输出：checks/format.*。
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = 'D:/AI/workspace/pao-dev';
const evidence = join(root, '.pao/摩擦修复-20261020');
const label = process.argv[2] ?? 'format';
const fix = process.argv.includes('--write');
const changes = JSON.parse(readFileSync(join(evidence, '本轮文件清单.json'), 'utf8'));
const files = changes.filter(item => item.status !== 'deleted' && item.file.endsWith('.ts'))
  .filter(item => !fix || !item.file.replaceAll('\\', '/').endsWith('/src/pao/worker/index.ts'))
  .map(item => join(root, item.file));
const args = [join(root, 'PAO/node_modules/@biomejs/biome/bin/biome'), 'check', ...(fix ? ['--write'] : []), '--max-diagnostics=40', ...files];
const child = spawn(process.execPath, args, { cwd: join(root, 'PAO'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '';
child.stdout.on('data', data => { stdout += data; process.stdout.write(data); });
child.stderr.on('data', data => { stderr += data; process.stderr.write(data); });
child.on('close', code => {
  writeFileSync(join(evidence, `checks/${label}.stdout.txt`), stdout);
  writeFileSync(join(evidence, `checks/${label}.stderr.txt`), stderr);
  writeFileSync(join(evidence, `checks/${label}.json`), JSON.stringify({ executable: process.execPath, args, code }, null, 2));
  process.exitCode = code ?? 1;
});
