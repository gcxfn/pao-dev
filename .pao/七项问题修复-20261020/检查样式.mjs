// 用途：只检查本轮改动的 TypeScript 文件；输入本轮修改清单，输出 Biome 诊断（不自动修改）。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const work = dirname(fileURLToPath(import.meta.url));
const repo = join(work, '..', '..', 'PAO');
const files = JSON.parse(readFileSync(join(work, '本轮修改清单.json'), 'utf8'))
  .filter(row => row.kind !== '删除' && row.path.endsWith('.ts')).map(row => row.path);
const result = spawnSync(process.execPath, [join(repo, 'node_modules/@biomejs/biome/bin/biome'), 'check', '--max-diagnostics=60', ...files], { cwd: repo, encoding: 'utf8', windowsHide: true });
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
process.exitCode = result.status ?? 1;
