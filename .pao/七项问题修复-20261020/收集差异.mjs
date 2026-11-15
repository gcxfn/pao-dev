// 用途：比对本轮开工快照与当前源码；输入 baseline 和 PAO 工作树，输出本轮修改清单及逐文件差异。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const work = dirname(fileURLToPath(import.meta.url));
const repo = join(work, '..', '..', 'PAO');
const base = join(work, 'baseline');
const changes = [];
const patchDir = join(work, 'diffs');
mkdirSync(patchDir, { recursive: true });
function walk(root, prefix = '') {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap(row => {
    const name = join(prefix, row.name);
    return row.isDirectory() ? walk(join(root, row.name), name) : [name];
  });
}
function compare(beforeRoot, currentRoot) {
  const files = new Set([...walk(beforeRoot), ...walk(currentRoot)]);
  for (const file of files) {
    const before = join(beforeRoot, file), after = join(currentRoot, file);
    if (existsSync(before) && existsSync(after) && readFileSync(before).equals(readFileSync(after))) continue;
    const path = relative(repo, after).replaceAll('\\', '/');
    const patchFile = path.replaceAll('/', '__') + '.patch';
    const diff = spawnSync('git', ['diff', '--no-index', '--no-ext-diff', '--', existsSync(before) ? before : 'NUL', existsSync(after) ? after : 'NUL'], { encoding: 'utf8', windowsHide: true });
    if (diff.status !== 0 && diff.status !== 1) throw new Error(diff.stderr || `比较失败：${path}`);
    writeFileSync(join(patchDir, patchFile), diff.stdout);
    changes.push({ path, kind: !existsSync(before) ? '新增' : !existsSync(after) ? '删除' : '修改', patch: patchFile });
  }
}
for (const area of ['worker','usage','fanout','knowledge','memory','desktop','workflow']) {
  compare(join(base, 'src', 'pao', area), join(repo, 'packages', 'coding-agent', 'src', 'pao', area));
}
compare(join(base, 'test-pao'), join(repo, 'packages', 'coding-agent', 'test', 'pao'));
writeFileSync(join(work, '本轮修改清单.json'), JSON.stringify(changes, null, 2));
for (const row of changes) console.log(`${row.kind} ${row.path}`);
