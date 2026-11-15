// 用途：核实 worker/index.ts 的既有样式问题；输入：开工快照；输出：checks/style-baseline.*。
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = 'D:/AI/workspace/pao-dev';
const evidence = join(root, '.pao/摩擦修复-20261020');
const file = 'PAO/packages/coding-agent/src/pao/worker/index.ts';
const args = [join(root, 'PAO/node_modules/@biomejs/biome/bin/biome'), 'check', '--max-diagnostics=30', '--stdin-file-path=packages/coding-agent/src/pao/worker/index.ts'];
const result = spawnSync(process.execPath, args, { cwd: join(root, 'PAO'), input: readFileSync(join(evidence, 'baseline/source', file)), encoding: 'utf8', windowsHide: true });
writeFileSync(join(evidence, 'checks/style-baseline.stdout.txt'), result.stdout ?? '');
writeFileSync(join(evidence, 'checks/style-baseline.stderr.txt'), result.stderr ?? '');
writeFileSync(join(evidence, 'checks/style-baseline.json'), JSON.stringify({ executable: process.execPath, args, code: result.status, error: result.error?.message }, null, 2));
process.stdout.write(`baseline exit=${result.status}\n${(result.stdout ?? '').slice(-350)}\n`);
process.exitCode = result.status ?? 1;
